"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import type { ArchitecturalObjectDefinition } from "../../../data";
import type { HvacElement, Point2D, Room, SymbolInstance2D, Wall } from "../../../types";
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
  view: Hybrid3DViewState;
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
  camera: THREE.PerspectiveCamera;
  root: THREE.Group;
  keyLight: THREE.DirectionalLight;
  fillLight: THREE.DirectionalLight;
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
  const camera = new THREE.PerspectiveCamera(38, 1, 1, MAX_CAMERA_DISTANCE_MM * 2);
  camera.up.set(0, 0, 1);

  const root = new THREE.Group();
  scene.add(root);
  scene.add(new THREE.AmbientLight(0xffffff, 1.3));

  const keyLight = new THREE.DirectionalLight(0xfff7ed, 2.0);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.72);
  scene.add(fillLight);

  return { renderer, scene, camera, root, keyLight, fillLight };
}

function updateCamera(
  sceneState: SceneState,
  view: Hybrid3DViewState,
  width: number,
  height: number,
): void {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const distance = clamp(view.distanceMm, MIN_CAMERA_DISTANCE_MM, MAX_CAMERA_DISTANCE_MM);
  const yaw = THREE.MathUtils.degToRad(view.yawDeg);
  const pitch = THREE.MathUtils.degToRad(clamp(view.pitchDeg, MIN_PITCH_DEG, MAX_PITCH_DEG));
  const horizontal = Math.cos(pitch);
  const direction = new THREE.Vector3(
    Math.cos(yaw) * horizontal,
    Math.sin(yaw) * horizontal,
    Math.sin(pitch),
  ).normalize();
  const target = new THREE.Vector3(view.targetMm.x, view.targetMm.y, 220);
  const camera = sceneState.camera;
  camera.aspect = safeWidth / safeHeight;
  camera.fov = THREE.MathUtils.lerp(30, 44, clamp(view.perspectiveStrength, 0, 1));
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.near = Math.max(1, distance * 0.02);
  camera.far = distance + MAX_CAMERA_DISTANCE_MM;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const lightDistance = Math.max(distance * 0.9, 2500);
  sceneState.keyLight.position.copy(target).add(new THREE.Vector3(-lightDistance, -lightDistance, lightDistance * 1.4));
  sceneState.fillLight.position.copy(target).add(new THREE.Vector3(lightDistance, lightDistance * 0.7, lightDistance * 0.5));
}

export function HybridProjectionLayer({
  width,
  height,
  pageWidth,
  pageHeight,
  view,
  walls,
  rooms,
  symbols,
  objectDefinitions,
  hvacElements,
  onWebglUnavailable,
}: HybridProjectionLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneStateRef = useRef<SceneState | null>(null);
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
    if (!canvas || sceneStateRef.current) return;

    try {
      const sceneState = createSceneState(canvas);
      sceneStateRef.current = sceneState;
      const handleContextLost = (event: Event) => {
        event.preventDefault();
        onWebglUnavailable?.();
      };
      canvas.addEventListener("webglcontextlost", handleContextLost, false);

      return () => {
        canvas.removeEventListener("webglcontextlost", handleContextLost, false);
        clearGroup(sceneState.root);
        sceneState.renderer.dispose();
        sceneStateRef.current = null;
      };
    } catch {
      onWebglUnavailable?.();
      return undefined;
    }
  }, [onWebglUnavailable]);

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

  useEffect(() => {
    const sceneState = sceneStateRef.current;
    if (!sceneState) return;

    const pixelRatio =
      typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    sceneState.renderer.setPixelRatio(pixelRatio);
    sceneState.renderer.setSize(safeWidth, safeHeight, false);
    updateCamera(sceneState, view, safeWidth, safeHeight);
    sceneState.renderer.render(sceneState.scene, sceneState.camera);
  }, [height, view, width, wallBands, rooms, walls, symbols, hvacElements]);

  if (view.blend <= 0.001 || width <= 0 || height <= 0) {
    return null;
  }

  // Reveal the solid model once the plan has tilted into a clear 3D angle, so the
  // crossover reads as "the plan lifting into a model" rather than a flat swap.
  const revealOpacity = smoothstep(0.15, 0.6, view.blend);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-[8] block pointer-events-none"
      style={{
        width: "100%",
        height: "100%",
        opacity: revealOpacity,
        transition: view.isInteracting ? "none" : "opacity 120ms ease-out",
      }}
    />
  );
}
