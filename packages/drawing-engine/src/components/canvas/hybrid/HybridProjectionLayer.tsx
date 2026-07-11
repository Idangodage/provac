"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";

import type { ArchitecturalObjectDefinition } from "../../../data";
import type { HvacElement, Point2D, Room, SymbolInstance2D, Wall } from "../../../types";
import { computeBoardGridSteps } from "../board/boardGridMath";
import {
  buildRefrigerantPipeEndpointRenderStateMap,
  buildRefrigerantPipeRenderChainStateMap,
  getVisibleRefrigerantPipeStraightSegmentTargets,
} from "../hvac/refrigerantPipeRenderState";
import { buildHvacElementMesh } from "../hvac/three3d";
import { createWallOpenings3D } from "../isometric/Opening3DRenderer";
import { buildIsometricWallBandsInBackground } from "../isometric/isometricWallBandsWorkerClient";
import {
  buildIsometricWallBandsSignature,
  type IsometricWallBand,
} from "../isometric/wallBands";
import {
  MODEL_SPACE_DEV_ASSERTIONS,
  applyModelToWorldBasis,
  assertCanonicalModelRoot,
  assertModelToWorldBasis,
  modelPointToWorld,
} from "../modelSpace";
import { MM_TO_PX } from "../scale";

import {
  HybridViewportController,
  type DerivedBoardView,
} from "./hybridViewportController";
import {
  computePlanSheetCssMatrix,
  planSheetCssMatrixToString,
  planSheetOpacityForPolar,
} from "./planSheetTransform";

export type Hybrid3DViewState = {
  blend: number;
  yawDeg: number;
  pitchDeg: number;
  targetMm: Point2D;
  distanceMm: number;
  perspectiveStrength: number;
  isInteracting: boolean;
};

export interface HybridProjectionLayerProps {
  width: number;
  height: number;
  pageWidthMm: number;
  pageHeightMm: number;
  /** Real-world zoom (== DrawingCanvas viewportZoom) — drives ground-grid density + ortho scale. */
  viewportZoom: number;
  /** Scene-pixel pan (== DrawingCanvas panOffset) — drives the ortho camera centre. */
  panOffset: Point2D;
  view: Hybrid3DViewState;
  /** DOM element camera-controls attaches to for the RMB tilt (the interactive host). */
  interactionElement: HTMLElement | null;
  /**
   * The 2D plan stack (Fabric canvas + overlays) as ONE sheet of paper. Each
   * frame the pump tilts it with the exact affine CSS matrix of the camera's
   * view of the model plane and fades it through the tuned polar band — the
   * drawing stays glued to the paper through the whole 2D↔3D transition.
   * Must have `transform-origin: 0 0`.
   */
  planSheetRef?: RefObject<HTMLElement | null>;
  /** Hands the live tilt controller to the host (for the 2D/3D toggle); null on teardown. */
  onControllerReady?: (controller: HybridViewportController | null) => void;
  /**
   * CAMERA → BOARD (reference-app practice): the camera owns navigation; each
   * frame the pump derives the flat-equivalent Fabric viewport of the camera
   * pose and hands it here — the host applies it to Fabric, refs, and store.
   */
  applyDerivedView?: (view: DerivedBoardView) => void;
  /** Live polar (tilt) angle in radians from camera-controls, for the host to derive blend. */
  onPolarChange?: (polar: number) => void;
  /**
   * Returns the fabric canvas's live viewport matrix `[z,0,0,z,panPx.x,panPx.y]` (the
   * IMPERATIVE source of truth that pan/zoom updates first). The grid camera derives
   * from this each frame so it stays pixel-locked to the DOM objects — the store lags
   * pan by a frame or two. Falls back to viewportZoom/panOffset props when null.
   */
  getViewportMatrix?: () => readonly number[] | null;
  /** TEMP diagnostic: live camera/scale values for the on-screen debug readout. */
  onDebug?: (info: {
    vz: number;
    pxPerMm: number;
    camZoom: number;
    polarDeg: number;
    cx: number;
    cy: number;
  }) => void;
  walls: Wall[];
  rooms: Room[];
  symbols: SymbolInstance2D[];
  objectDefinitions: ArchitecturalObjectDefinition[];
  hvacElements: HvacElement[];
  onWebglUnavailable?: () => void;
}

type SceneState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  /** Permanent model→world basis (scale(1,−1,1)) — see modelSpace.ts. */
  viewBasis: THREE.Group;
  root: THREE.Group;
  keyLight: THREE.DirectionalLight;
  fillLight: THREE.DirectionalLight;
  groundGridMaterial: THREE.ShaderMaterial;
};

const EPSILON = 0.001;
const MAX_CAMERA_DISTANCE_MM = 220000;
/** Below this polar the view is "flat": untransformed crisp sheet, no 3D content. */
const FLAT_SHEET_POLAR = THREE.MathUtils.degToRad(0.03);
const FLOOR_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#eef4ec",
  transparent: true,
  opacity: 0.88,
  roughness: 0.98,
  metalness: 0,
  side: THREE.DoubleSide,
});
const PAGE_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#ffffff",
  transparent: true,
  opacity: 0.96,
  roughness: 1,
  metalness: 0,
  side: THREE.DoubleSide,
});
const WALL_SIDE_MATERIAL_CACHE = new Map<string, THREE.MeshStandardMaterial>();
const WALL_TOP_MATERIAL_CACHE = new Map<string, THREE.MeshStandardMaterial>();
const SYMBOL_MATERIAL_CACHE = new Map<string, THREE.MeshStandardMaterial>();

function polygonSignedArea(points: Point2D[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function sanitizeRing(points: Point2D[]): Point2D[] {
  const cleaned: Point2D[] = [];
  points.forEach((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const previous = cleaned[cleaned.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > EPSILON) {
      cleaned.push({ x: point.x, y: point.y });
    }
  });
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= EPSILON) {
      cleaned.pop();
    }
  }
  return cleaned;
}

function orientRing(points: Point2D[], clockwise: boolean): Point2D[] {
  const ring = sanitizeRing(points);
  if (ring.length < 3) return ring;
  const isClockwise = polygonSignedArea(ring) < 0;
  return isClockwise === clockwise ? ring : [...ring].reverse();
}

function buildShapeFromPolygon(polygon: Point2D[][]): THREE.Shape | null {
  const [outerRing, ...holeRings] = polygon;
  const outer = orientRing(outerRing ?? [], false);
  if (outer.length < 3 || Math.abs(polygonSignedArea(outer)) <= EPSILON) {
    return null;
  }

  const shape = new THREE.Shape();
  shape.moveTo(outer[0].x, outer[0].y);
  for (let index = 1; index < outer.length; index += 1) {
    shape.lineTo(outer[index].x, outer[index].y);
  }
  shape.closePath();

  holeRings.forEach((ring) => {
    const hole = orientRing(ring, true);
    if (hole.length < 3 || Math.abs(polygonSignedArea(hole)) <= EPSILON) return;
    const path = new THREE.Path();
    path.moveTo(hole[0].x, hole[0].y);
    for (let index = 1; index < hole.length; index += 1) {
      path.lineTo(hole[index].x, hole[index].y);
    }
    path.closePath();
    shape.holes.push(path);
  });

  return shape;
}

function getWallSideMaterial(color: string): THREE.MeshStandardMaterial {
  let material = WALL_SIDE_MATERIAL_CACHE.get(color);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.9,
      metalness: 0.03,
    });
    WALL_SIDE_MATERIAL_CACHE.set(color, material);
  }
  return material;
}

function getWallTopMaterial(color: string): THREE.MeshStandardMaterial {
  let material = WALL_TOP_MATERIAL_CACHE.get(color);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.96,
      metalness: 0.01,
      side: THREE.DoubleSide,
    });
    WALL_TOP_MATERIAL_CACHE.set(color, material);
  }
  return material;
}

function getSymbolMaterial(category: ArchitecturalObjectDefinition["category"]): THREE.MeshStandardMaterial {
  const colors: Record<ArchitecturalObjectDefinition["category"], string> = {
    doors: "#c79d74",
    windows: "#9ecdf5",
    furniture: "#8db5c6",
    fixtures: "#96b8a8",
    symbols: "#c3b4db",
    "my-library": "#aab8c8",
  };
  const color = colors[category] ?? "#aab8c8";
  let material = SYMBOL_MATERIAL_CACHE.get(color);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: category === "windows" ? 0.58 : 0.9,
      roughness: 0.86,
      metalness: 0.02,
    });
    SYMBOL_MATERIAL_CACHE.set(color, material);
  }
  return material;
}

function createRoomFloor(room: Room): THREE.Object3D | null {
  const shape = buildShapeFromPolygon([room.vertices, ...(room.holes ?? [])]);
  if (!shape) return null;
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), FLOOR_MATERIAL);
  mesh.name = `hybrid-room-floor-${room.id}`;
  mesh.position.z = (room.properties3D.floorElevation ?? 0) + 2;
  mesh.receiveShadow = true;
  return mesh;
}

function createWallMesh(band: IsometricWallBand): THREE.Object3D | null {
  const shape = buildShapeFromPolygon(band.polygon);
  if (!shape || band.height <= EPSILON) return null;

  const group = new THREE.Group();
  group.name = `hybrid-${band.name}`;
  const sideMaterial = getWallSideMaterial(band.palette.side);
  const topMaterial = getWallTopMaterial(band.palette.top);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: band.height,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1,
  });
  geometry.translate(0, 0, band.baseElevation);
  geometry.computeVertexNormals();
  const wall = new THREE.Mesh(geometry, [topMaterial, sideMaterial]);
  wall.castShadow = true;
  wall.receiveShadow = true;
  group.add(wall);

  if (band.showTopCap ?? true) {
    const cap = new THREE.Mesh(new THREE.ShapeGeometry(shape), topMaterial);
    cap.position.z = band.baseElevation + band.height + 0.6 - (band.topCapInsetMm ?? 0);
    cap.receiveShadow = true;
    group.add(cap);
  }

  return group;
}

function createSymbolMesh(
  instance: SymbolInstance2D,
  definition: ArchitecturalObjectDefinition,
): THREE.Object3D | null {
  if (definition.category === "doors" || definition.category === "windows") {
    return null;
  }
  const width = Math.max(40, definition.widthMm * Math.max(instance.scale, 0.05));
  const depth = Math.max(40, definition.depthMm * Math.max(instance.scale, 0.05));
  const height = Math.max(40, Math.min(definition.heightMm || 450, 1200));
  const geometry = new THREE.BoxGeometry(width, depth, height);
  const mesh = new THREE.Mesh(geometry, getSymbolMaterial(definition.category));
  mesh.name = `hybrid-symbol-${instance.id}`;
  mesh.position.set(instance.position.x, instance.position.y, height / 2);
  mesh.rotation.z = THREE.MathUtils.degToRad(instance.rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function tuneHvacMesh(mesh: THREE.Object3D): void {
  mesh.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
    }
  });
}

function clearGroup(group: THREE.Group): void {
  [...group.children].forEach((child) => {
    group.remove(child);
    disposeObject(child);
  });
}

/**
 * Adaptive GPU grid shader for the ground plane (z=0, world mm). Draws minor +
 * major lines and red-X / green-Y world axes with fwidth anti-aliasing at the
 * step handed in each frame (same 1-2-5 ladder as the 2D board), so the floor
 * grid stays crisp and correctly dense at *any* zoom — the reference-app floor.
 * The plane is huge; the shader only lights fragments that land on a line.
 */
const GROUND_GRID_VERTEX = `
  varying vec2 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const GROUND_GRID_FRAGMENT = `
  precision highp float;
  varying vec2 vWorld;
  uniform float uMinor;
  uniform float uMajor;
  uniform float uOpacity;
  uniform vec3 uMinorColor;
  uniform vec3 uMajorColor;
  uniform vec3 uAxisX;
  uniform vec3 uAxisY;

  float lineMask(float coord, float step) {
    float d = coord / step;
    float w = fwidth(d);
    float dist = abs(fract(d - 0.5) - 0.5);
    return 1.0 - smoothstep(0.0, max(w, 1e-5), dist);
  }
  float axisMask(float coord) {
    float w = fwidth(coord);
    return 1.0 - smoothstep(0.0, max(w * 1.5, 1e-5), abs(coord));
  }

  void main() {
    float minor = max(lineMask(vWorld.x, uMinor), lineMask(vWorld.y, uMinor));
    float major = max(lineMask(vWorld.x, uMajor), lineMask(vWorld.y, uMajor));
    float ax = axisMask(vWorld.y); // line along +X (y = 0)
    float ay = axisMask(vWorld.x); // line along +Y (x = 0)

    vec3 color = uMinorColor;
    float alpha = minor * 0.3;
    color = mix(color, uMajorColor, major);
    alpha = max(alpha, major * 0.5);
    color = mix(color, uAxisX, ax);
    alpha = max(alpha, ax);
    color = mix(color, uAxisY, ay);
    alpha = max(alpha, ay);

    alpha *= uOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

function createGroundGridMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMinor: { value: 1000 },
      uMajor: { value: 5000 },
      uOpacity: { value: 1 },
      uMinorColor: { value: new THREE.Color(0x64748b) },
      uMajorColor: { value: new THREE.Color(0x334155) },
      uAxisX: { value: new THREE.Color(0xdc4444) },
      uAxisY: { value: new THREE.Color(0x22a05a) },
    },
    vertexShader: GROUND_GRID_VERTEX,
    fragmentShader: GROUND_GRID_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function createGroundGridPlane(material: THREE.ShaderMaterial): THREE.Mesh {
  const size = 4_000_000; // 4 km — the shader only draws lines that hit the screen
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.name = "hybrid-ground-grid";
  mesh.position.z = -0.5;
  mesh.renderOrder = -1;
  return mesh;
}

function createPagePlane(pageWidthMm: number, pageHeightMm: number): THREE.Object3D {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(pageWidthMm, 0);
  shape.lineTo(pageWidthMm, pageHeightMm);
  shape.lineTo(0, pageHeightMm);
  shape.closePath();
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), PAGE_MATERIAL);
  mesh.name = "hybrid-page-plane";
  mesh.position.z = -2;
  mesh.receiveShadow = true;
  return mesh;
}

function createSceneState(canvas: HTMLCanvasElement): SceneState {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0xf8fafc, 0);

  const scene = new THREE.Scene();
  // Orthographic / parallel projection: top-down == the 2D plan at scale, tilt ==
  // isometric (reference-app behaviour). Frustum is set per frame from the zoom.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, MAX_CAMERA_DISTANCE_MM * 4);
  camera.up.set(0, 0, 1);

  // ALL model content (objects, page plane, ground grid) renders through ONE
  // permanent model→world view basis: the board plane is y-down (left-handed),
  // the render world is right-handed, so the chirality conversion happens here —
  // once, at the shared parent — never per object and never in camera logic.
  // Without it the plan fades into 3D vertically mirrored (see modelSpace.ts).
  const viewBasis = new THREE.Group();
  viewBasis.name = "hybrid-model-to-world-basis";
  applyModelToWorldBasis(viewBasis);
  scene.add(viewBasis);

  const root = new THREE.Group();
  root.name = "hybrid-model-root";
  viewBasis.add(root);

  // Persistent adaptive ground grid (survives content clears — never in `root`).
  const groundGridMaterial = createGroundGridMaterial();
  viewBasis.add(createGroundGridPlane(groundGridMaterial));

  scene.add(new THREE.AmbientLight(0xffffff, 1.3));

  const keyLight = new THREE.DirectionalLight(0xfff7ed, 2.0);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.72);
  scene.add(fillLight);

  return { renderer, scene, camera, viewBasis, root, keyLight, fillLight, groundGridMaterial };
}

export function HybridProjectionLayer({
  width,
  height,
  pageWidthMm,
  pageHeightMm,
  viewportZoom,
  panOffset,
  view,
  interactionElement,
  planSheetRef,
  onControllerReady,
  applyDerivedView,
  onPolarChange,
  onDebug,
  getViewportMatrix,
  walls,
  rooms,
  symbols,
  objectDefinitions,
  hvacElements,
  onWebglUnavailable,
}: HybridProjectionLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneStateRef = useRef<SceneState | null>(null);
  const controllerRef = useRef<HybridViewportController | null>(null);
  const requestFrameRef = useRef<(() => void) | null>(null);
  // Live prop mirrors so the render pump reads current values without re-subscribing.
  const boardRef = useRef({ width, height, viewportZoom, panOffset, blend: view.blend });
  boardRef.current = { width, height, viewportZoom, panOffset, blend: view.blend };
  const onPolarChangeRef = useRef(onPolarChange);
  onPolarChangeRef.current = onPolarChange;
  const onDebugRef = useRef(onDebug);
  onDebugRef.current = onDebug;
  const getViewportMatrixRef = useRef(getViewportMatrix);
  getViewportMatrixRef.current = getViewportMatrix;
  const planSheetRefRef = useRef(planSheetRef);
  planSheetRefRef.current = planSheetRef;
  const onControllerReadyRef = useRef(onControllerReady);
  onControllerReadyRef.current = onControllerReady;
  const applyDerivedViewRef = useRef(applyDerivedView);
  applyDerivedViewRef.current = applyDerivedView;
  const [wallBands, setWallBands] = useState<IsometricWallBand[]>([]);
  const wallBandSignature = useMemo(() => buildIsometricWallBandsSignature(walls), [walls]);
  const objectDefinitionsById = useMemo(
    () => new Map(objectDefinitions.map((definition) => [definition.id, definition])),
    [objectDefinitions],
  );

  useEffect(() => {
    if (walls.length === 0) {
      setWallBands([]);
      return;
    }

    let cancelled = false;
    void buildIsometricWallBandsInBackground({
      signature: wallBandSignature,
      walls,
    }).then((nextWallBands) => {
      if (!cancelled) setWallBands(nextWallBands);
    });

    return () => {
      cancelled = true;
    };
  }, [wallBandSignature, walls]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !interactionElement) return;

    let sceneState: SceneState;
    try {
      sceneState = createSceneState(canvas);
    } catch {
      onWebglUnavailable?.();
      return undefined;
    }
    sceneStateRef.current = sceneState;

    const controller = new HybridViewportController();
    controllerRef.current = controller;
    controller.attach(
      interactionElement,
      Math.max(1, boardRef.current.width),
      Math.max(1, boardRef.current.height),
    );

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      onWebglUnavailable?.();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost, false);

    let raf: number | null = null;
    let lastTs = typeof performance !== "undefined" ? performance.now() : 0;
    let lastW = -1;
    let lastH = -1;
    // The camera adopts the board's CURRENT pan/zoom once on mount, then OWNS
    // the view (reference-app practice: camera is the one navigation owner).
    let cameraAdoptedBoard = false;

    // One frame: board zoom/centre → ortho camera, camera-controls adds the tilt,
    // grid density follows the zoom, render. Returns true while still animating.
    const renderScene = (delta: number): boolean => {
      const s = sceneStateRef.current;
      if (!s) return false;
      const { width: w0, height: h0, viewportZoom: z0, panOffset: pan } = boardRef.current;
      const w = Math.max(1, Math.floor(w0));
      const h = Math.max(1, Math.floor(h0));
      const pixelRatio =
        typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
      s.renderer.setPixelRatio(pixelRatio);
      s.renderer.setSize(w, h, false);
      // Frustum (in pixels) only on actual resize — matches the reference; resetting
      // it every frame can fight camera-controls' ortho zoom.
      if (w !== lastW || h !== lastH) {
        controller.setSize(w, h);
        lastW = w;
        lastH = h;
      }
      // One-time adoption: seed the camera from wherever the board currently
      // is (restored project pan/zoom); after this the flow is CAMERA → BOARD.
      if (!cameraAdoptedBoard) {
        const m = getViewportMatrixRef.current?.();
        const z0Live = Math.max(m && m.length >= 6 ? (m[0] as number) : z0, 1e-6);
        const panPxX0 = m && m.length >= 6 ? (m[4] as number) : -pan.x * z0Live;
        const panPxY0 = m && m.length >= 6 ? (m[5] as number) : -pan.y * z0Live;
        const pxPerMm0 = MM_TO_PX * z0Live;
        // The board centre is a MODEL point (y down); camera-controls works in
        // WORLD space, one mirror away (see the view basis in createSceneState).
        const centerWorld0 = modelPointToWorld({
          x: (w / 2 - panPxX0) / pxPerMm0,
          y: (h / 2 - panPxY0) / pxPerMm0,
        });
        controller.setBoardView(pxPerMm0, centerWorld0.x, centerWorld0.y, 0);
        cameraAdoptedBoard = true;
      }
      const animating = controller.update(delta);
      // CAMERA → BOARD: derive the flat-equivalent Fabric viewport from the
      // camera pose and hand it to the host (fabric + refs + store) so every
      // DOM layer shows exactly what the camera sees — one navigation owner.
      const derived = controller.deriveBoardView();
      applyDerivedViewRef.current?.(derived);
      const z = Math.max(derived.zoom, 1e-6);
      const panPxX = derived.panPxX;
      const panPxY = derived.panPxY;
      const pxPerMm = MM_TO_PX * z;
      const centerX = (w / 2 - panPxX) / pxPerMm;
      const centerY = (h / 2 - panPxY) / pxPerMm;
      if (MODEL_SPACE_DEV_ASSERTIONS) {
        // View/camera code must never touch the model graph: the basis stays
        // the permanent mirror, the content root stays identity.
        assertModelToWorldBasis(s.viewBasis, "Hybrid view basis");
        assertCanonicalModelRoot(s.root, "Hybrid content root");
      }
      const polar = controller.polar;
      // "Flat" means polar AND azimuth are home — an azimuth-only rotation
      // still needs the sheet matrix (the Fabric board cannot rotate).
      const isFlat = controller.isFlatView(FLAT_SHEET_POLAR);
      // The 3D content is live the moment any tilt begins; while flat only the
      // grid shows (the crisp DOM sheet carries the drawing).
      s.root.visible = !isFlat;
      // Paper bond through the transition: tilt the ENTIRE 2D sheet (Fabric +
      // overlays) with the exact affine projection of the model plane, so the
      // drawing stays glued to the paper while the sheet cross-fades into the
      // pixel-identical 3D view. Snap back to no transform when flat so text
      // renders crisp (no subpixel rasterising).
      const sheet = planSheetRefRef.current?.current ?? null;
      if (sheet) {
        if (isFlat) {
          if (sheet.style.transform !== "") sheet.style.transform = "";
          if (sheet.style.opacity !== "1") sheet.style.opacity = "1";
          if (sheet.style.pointerEvents !== "") sheet.style.pointerEvents = "";
        } else {
          controller.camera.updateMatrixWorld();
          const sheetMatrix = computePlanSheetCssMatrix(
            controller.camera,
            [z, 0, 0, z, panPxX, panPxY],
            w,
            h,
          );
          sheet.style.transform = planSheetCssMatrixToString(sheetMatrix);
          sheet.style.opacity = String(planSheetOpacityForPolar(polar));
          sheet.style.pointerEvents = "none";
        }
      }
      s.groundGridMaterial.uniforms.uMinor.value = computeBoardGridSteps(z).minorMm;
      s.groundGridMaterial.uniforms.uMajor.value = computeBoardGridSteps(z).majorMm;
      s.renderer.render(s.scene, controller.camera);
      onPolarChangeRef.current?.(controller.polar);
      onDebugRef.current?.({
        vz: z,
        pxPerMm,
        camZoom: controller.camera.zoom,
        polarDeg: (controller.polar * 180) / Math.PI,
        cx: centerX,
        cy: centerY,
      });
      return animating;
    };

    // Continuous loop: the 3D grid must track the DOM objects frame-for-frame during
    // 2D pan/zoom (and 3D orbit) so they move as ONE — an on-demand render lags a few
    // frames behind the immediate DOM update and reads as "independent movement".
    // Rendering a single grid plane (+ content when tilted) every frame is cheap.
    // (Idle-throttle / demand rendering → perf pass in M7.)
    const frame = (ts: number): void => {
      raf = null;
      const delta = Math.min(0.05, (ts - lastTs) / 1000);
      lastTs = ts;
      renderScene(delta);
      request();
    };
    const request = (): void => {
      if (raf == null && typeof window !== "undefined") raf = window.requestAnimationFrame(frame);
    };
    controller.onChange = request;
    requestFrameRef.current = request;
    onControllerReadyRef.current?.(controller);
    request();

    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost, false);
      if (raf != null && typeof window !== "undefined") window.cancelAnimationFrame(raf);
      requestFrameRef.current = null;
      onControllerReadyRef.current?.(null);
      controller.dispose();
      controllerRef.current = null;
      const sheet = planSheetRefRef.current?.current ?? null;
      if (sheet) {
        sheet.style.transform = "";
        sheet.style.opacity = "";
        sheet.style.pointerEvents = "";
      }
      clearGroup(sceneState.root);
      sceneState.renderer.dispose();
      sceneStateRef.current = null;
    };
  }, [interactionElement, onWebglUnavailable]);

  useEffect(() => {
    const sceneState = sceneStateRef.current;
    if (!sceneState) return;

    clearGroup(sceneState.root);
    sceneState.root.add(createPagePlane(pageWidthMm, pageHeightMm));

    rooms.forEach((room) => {
      const floor = createRoomFloor(room);
      if (floor) sceneState.root.add(floor);
    });

    wallBands.forEach((band) => {
      const wallMesh = createWallMesh(band);
      if (wallMesh) sceneState.root.add(wallMesh);
    });

    walls.forEach((wall) => {
      const openings = createWallOpenings3D(wall);
      if (openings.children.length > 0) {
        openings.name = `hybrid-openings-${wall.id}`;
        sceneState.root.add(openings);
      }
    });

    symbols.forEach((symbol) => {
      const definition = objectDefinitionsById.get(symbol.symbolId);
      if (!definition) return;
      const mesh = createSymbolMesh(symbol, definition);
      if (mesh) sceneState.root.add(mesh);
    });

    const pipeEndpointStateMap = buildRefrigerantPipeEndpointRenderStateMap(hvacElements);
    const pipeRenderChainStateMap = buildRefrigerantPipeRenderChainStateMap(
      hvacElements,
      pipeEndpointStateMap,
    );
    const sceneContext = {
      allElements: hvacElements,
      pipeEndpointStateMap,
      pipeRenderChainStateMap,
      pipeTargets: getVisibleRefrigerantPipeStraightSegmentTargets(hvacElements),
    };
    hvacElements.forEach((element) => {
      const mesh = buildHvacElementMesh(element, sceneContext);
      if (!mesh || mesh.children.length === 0) return;
      tuneHvacMesh(mesh);
      sceneState.root.add(mesh);
    });
    requestFrameRef.current?.();
  }, [
    hvacElements,
    objectDefinitionsById,
    pageHeightMm,
    pageWidthMm,
    rooms,
    symbols,
    wallBands,
    walls,
  ]);

  // Any prop change (size / zoom / pan / blend / content) requests a fresh frame
  // from the camera-controls render pump.
  useEffect(() => {
    requestFrameRef.current?.();
  }, [
    width,
    height,
    viewportZoom,
    panOffset.x,
    panOffset.y,
    view.blend,
    wallBands,
    rooms,
    walls,
    symbols,
    hvacElements,
  ]);

  // Always visible, at the BOTTOM (z-0): this canvas is the single grid — the 3D
  // shader ground grid that rotates with the plane. The DOM content plane sits
  // above it (z-1) and fades on tilt to reveal the 3D content (root.visible toggles
  // the content in the pump so only the grid shows while flat).
  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-0 block pointer-events-none"
      style={{
        width: "100%",
        height: "100%",
        opacity: width <= 0 || height <= 0 ? 0 : 1,
      }}
    />
  );
}
