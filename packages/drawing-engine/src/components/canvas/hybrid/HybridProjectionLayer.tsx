"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import type { ArchitecturalObjectDefinition } from "../../../data";
import type { HvacElement, Point2D, Room, SymbolInstance2D, Wall } from "../../../types";
import { computeBoardGridSteps } from "../board/boardGridMath";
import { MM_TO_PX } from "../scale";
import { HybridViewportController } from "./hybridViewportController";
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
  pageWidth: number;
  pageHeight: number;
  /** Real-world zoom (== DrawingCanvas viewportZoom) — drives ground-grid density + ortho scale. */
  viewportZoom: number;
  /** Scene-pixel pan (== DrawingCanvas panOffset) — drives the ortho camera centre. */
  panOffset: Point2D;
  view: Hybrid3DViewState;
  /** DOM element camera-controls attaches to for the RMB tilt (the interactive host). */
  interactionElement: HTMLElement | null;
  /** Live polar (tilt) angle in radians from camera-controls, for the host to derive blend. */
  onPolarChange?: (polar: number) => void;
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
  root: THREE.Group;
  keyLight: THREE.DirectionalLight;
  fillLight: THREE.DirectionalLight;
  groundGridMaterial: THREE.ShaderMaterial;
};

const EPSILON = 0.001;
const MIN_CAMERA_DISTANCE_MM = 800;
const MAX_CAMERA_DISTANCE_MM = 220000;
const MIN_PITCH_DEG = 18;
const MAX_PITCH_DEG = 82;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Eased reveal so the solid model fades in *after* the plan has begun tilting,
 * keeping the crossover from showing a flat plan and a tilted model at once.
 */
function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) {
    return value >= edge1 ? 1 : 0;
  }
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

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

function createPagePlane(pageWidth: number, pageHeight: number): THREE.Object3D {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(pageWidth, 0);
  shape.lineTo(pageWidth, pageHeight);
  shape.lineTo(0, pageHeight);
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

  const root = new THREE.Group();
  scene.add(root);

  // Persistent adaptive ground grid (survives content clears — never in `root`).
  const groundGridMaterial = createGroundGridMaterial();
  scene.add(createGroundGridPlane(groundGridMaterial));

  scene.add(new THREE.AmbientLight(0xffffff, 1.3));

  const keyLight = new THREE.DirectionalLight(0xfff7ed, 2.0);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.72);
  scene.add(fillLight);

  return { renderer, scene, camera, root, keyLight, fillLight, groundGridMaterial };
}

function updateCamera(
  sceneState: SceneState,
  view: Hybrid3DViewState,
  width: number,
  height: number,
  viewportZoom: number,
): void {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const pxPerMm = MM_TO_PX * Math.max(viewportZoom, 1e-6);
  // Ortho frustum = exactly the world area the 2D board shows at this zoom, so
  // top-down reads 1:1 with the plan and scale is preserved as it tilts.
  const halfWidth = safeWidth / pxPerMm / 2;
  const halfHeight = safeHeight / pxPerMm / 2;
  const yaw = THREE.MathUtils.degToRad(view.yawDeg);
  const pitch = THREE.MathUtils.degToRad(clamp(view.pitchDeg, MIN_PITCH_DEG, MAX_PITCH_DEG));
  const horizontal = Math.cos(pitch);
  const direction = new THREE.Vector3(
    Math.cos(yaw) * horizontal,
    Math.sin(yaw) * horizontal,
    Math.sin(pitch),
  ).normalize();
  const target = new THREE.Vector3(view.targetMm.x, view.targetMm.y, 0);
  const camera = sceneState.camera;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  // Parallel projection: distance affects only clipping, never apparent size.
  const distance = MAX_CAMERA_DISTANCE_MM;
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.near = 1;
  camera.far = distance * 2 + MAX_CAMERA_DISTANCE_MM;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const lightDistance = Math.max(halfHeight * 2, 4000);
  sceneState.keyLight.position.copy(target).add(new THREE.Vector3(-lightDistance, -lightDistance, lightDistance * 1.4));
  sceneState.fillLight.position.copy(target).add(new THREE.Vector3(lightDistance, lightDistance * 0.7, lightDistance * 0.5));
}

export function HybridProjectionLayer({
  width,
  height,
  pageWidth,
  pageHeight,
  viewportZoom,
  panOffset,
  view,
  interactionElement,
  onPolarChange,
  onDebug,
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

    // One frame: board zoom/centre → ortho camera, camera-controls adds the tilt,
    // grid density follows the zoom, render. Returns true while still animating.
    const renderScene = (delta: number): boolean => {
      const s = sceneStateRef.current;
      if (!s) return false;
      const { width: w0, height: h0, viewportZoom: z0, panOffset: pan } = boardRef.current;
      const w = Math.max(1, Math.floor(w0));
      const h = Math.max(1, Math.floor(h0));
      const z = Math.max(z0, 1e-6);
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
      const pxPerMm = MM_TO_PX * z;
      const centerX = (w / 2 / z + pan.x) / MM_TO_PX;
      const centerY = (h / 2 / z + pan.y) / MM_TO_PX;
      controller.syncBoard(pxPerMm, centerX, centerY, 0);
      const animating = controller.update(delta);
      // Only the grid shows while flat; the 3D content (root) appears as it tilts,
      // occluded by the crisp DOM plane above until that plane fades.
      s.root.visible = boardRef.current.blend > 0.005;
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
    request();

    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost, false);
      if (raf != null && typeof window !== "undefined") window.cancelAnimationFrame(raf);
      requestFrameRef.current = null;
      controller.dispose();
      controllerRef.current = null;
      clearGroup(sceneState.root);
      sceneState.renderer.dispose();
      sceneStateRef.current = null;
    };
  }, [interactionElement, onWebglUnavailable]);

  useEffect(() => {
    const sceneState = sceneStateRef.current;
    if (!sceneState) return;

    clearGroup(sceneState.root);
    sceneState.root.add(createPagePlane(pageWidth, pageHeight));

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
    pageHeight,
    pageWidth,
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
