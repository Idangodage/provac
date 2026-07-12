"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import * as THREE from "three";

import {
  colorFromExposure,
  heatColorFromUValue,
  PROFESSIONAL_WALL_EDGES,
  resolveWallVisualStyle,
  type WallVisualStyle,
} from "../../../attributes";
import type { ArchitecturalObjectDefinition } from "../../../data";
import type {
  HvacElement,
  Point2D,
  Room,
  SymbolInstance2D,
  Wall,
  WallColorMode,
} from "../../../types";
import { generateId } from "../../../utils/geometry";
import {
  beginDrag,
  createWorkplane,
  updateDrag,
  type FrozenDragContext,
  type TransformConstraint,
} from "../../../vrf/interaction/interaction-coordinate-service";
import type { InteractionViewMode } from "../../../vrf/interaction/view-manipulation-policy";
import { wallGraphFromLegacyWalls } from "../../../wallcore/legacyBridge";
import { solveWallGraphDoc } from "../../../wallcore/wallSolver";
import { computeBoardGridSteps } from "../board/boardGridMath";
import {
  applyPipeAxisConstraint,
  createPointerRay,
  getPointerNDC,
  intersectPointerRayWithAxis,
  projectPointerToDrawingPlane,
  resolveActiveDrawingPlane,
  resolveSnappedPipePoint,
  worldPointScreenDistance,
  type DrawingSurfaceHit,
  type PipeDrawingPlane,
  type PipeSnapCandidate,
} from "../hvac/pipePointerProjection";
import {
  readPipeRouteNodes3d,
  withCanonicalPipeRoute,
  type PipePlacementPoint,
  type PipeRouteNode3D,
} from "../hvac/pipeRoute3d";
import {
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipeVisual,
  getRefrigerantPipeBundleSnapTargets,
  isRefrigerantPipeElementType,
  resolveRefrigerantPipePairSpec,
  resolveRefrigerantPipeSpec,
  type RefrigerantPipeBundleConnection,
} from "../hvac/refrigerantPipePairModel";
import {
  buildRefrigerantPipeEndpointRenderStateMap,
  buildRefrigerantPipeRenderChainStateMap,
  getVisibleRefrigerantPipeStraightSegmentTargets,
} from "../hvac/refrigerantPipeRenderState";
import { buildHvacElementMesh } from "../hvac/three3d";
import { createWallOpenings3D } from "../isometric/Opening3DRenderer";
import {
  MODEL_SPACE_DEV_ASSERTIONS,
  applyModelToWorldBasis,
  assertCanonicalModelRoot,
  assertModelToWorldBasis,
  modelPointToWorld,
  worldPointToModel,
} from "../modelSpace";
import { MM_TO_PX } from "../scale";
import { getWallSurfaceTexture } from "../wall/wallSurfaceTexture";
import { buildWallChunkGeometry } from "../wallview/wallMeshBuilder";

import { HandleLayer3D, type HandleDef3D } from "./handleLayer3D";
import {
  getProtectedPipeNodeIndexes,
  moveEditablePipeNode,
  resolveHybridPipeConstraintKey,
  type HybridPipeConstraintKey,
} from "./hybridPipeEditing";
import {
  HybridViewportController,
  type DerivedBoardView,
  type HybridCameraView,
} from "./hybridViewportController";
import { worldToScreen as projectWorldToScreen } from "./hybridViewportMath";
import {
  computePlanSheetCssMatrix,
  planSheetCssMatrixToString,
  planSheetOpacityForPolar,
  wallRiseForPolar,
} from "./planSheetTransform";
import { HybridPostFX, OUTLINE_PROXY_MATERIAL } from "./postfx";
import { extractEntityTriangles, resolveWallHitId } from "./wallPicking";

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
  /** Active view policy shared by 3D pipe drawing and vertex manipulation. */
  interactionViewMode?: InteractionViewMode;
  /** Classifies toolbar poses and arbitrary RMB orbit for host button state. */
  onCameraViewChange?: (view: HybridCameraView) => void;
  /**
   * Fires when the flat plan becomes azimuth-ROTATED (reference SPEC §10:
   * "plan may be rotated deliberately") or squares up again. The host locks
   * editing and hides the axis-aligned rulers while rotated — the sheet
   * matrix keeps content/grid glued at any orientation.
   */
  onViewRotatedChange?: (rotated: boolean) => void;
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
  wallColorMode?: WallColorMode;
  rooms: Room[];
  symbols: SymbolInstance2D[];
  objectDefinitions: ArchitecturalObjectDefinition[];
  hvacElements: HvacElement[];
  onWebglUnavailable?: () => void;
  /** Wall selection (edge ids) + hover for 3D outlines/handles. */
  selectedIds?: string[];
  hoveredElementId?: string | null;
  /** Solid → X-ray → Wire view style (reference cycle). */
  viewStyle?: HybridViewStyle;
  onHoverWall?: (id: string | null) => void;
  onSelectWall?: (ids: string[]) => void;
  /** Diamond midpoint handle click → split the wall at t=0.5. */
  onSplitWall?: (edgeId: string) => void;
  /** Endpoint-handle drop → move the shared corner (weld-on-drop). */
  onMoveWallNode?: (nodeId: string, to: Point2D, weld: boolean) => void;
  /** Body-drag drop → translate the whole wall(s) by a delta. */
  onMoveWallEdges?: (edgeIds: string[], delta: Point2D) => void;
  /** Hybrid vertex-drag drop -> commit one canonical, undoable pipe update. */
  onCommitPipeRouteEdit?: (elementId: string, routeNodes3d: PipeRouteNode3D[]) => void;
  /** Active CAD tool. Pipe LMB is resolved here while the 3D sheet is engaged. */
  pipeToolActive?: boolean;
  onPipePointerDown?: (point: PipePlacementPoint) => void;
  onPipePointerMove?: (point: PipePlacementPoint) => void;
  onPipePointerCancel?: () => void;
  /** Imperative preview/session bridge; avoids React updates per pointer frame. */
  pipeInteractionRef?: MutableRefObject<HybridPipeInteractionHandle | null>;
}

export interface HybridPipeInteractionHandle {
  setDraftPipes: (elements: HvacElement[] | null) => void;
  setRouteActive: (active: boolean) => void;
}

type SceneState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  /** Permanent model→world basis (scale(1,−1,1)) — see modelSpace.ts. */
  viewBasis: THREE.Group;
  root: THREE.Group;
  groundGridMaterial: THREE.ShaderMaterial;
  /** Outline proxy meshes (survives content clears; rise-synced in the pump). */
  proxyLayer: THREE.Group;
  /** Micro-edit handles (screen-space sized, topmost). */
  handleLayer: HandleLayer3D;
  /** Current wall chunk (solid+edges+pick); set by the content effect. */
  wallChunk: WallChunkGroupData | null;
  /** Transient pipe preview, rebuilt at most once per animation frame. */
  pipePreviewLayer: THREE.Group;
  /** Outline composer; created once the controller/camera exist. */
  postfx: HybridPostFX | null;
};

const EPSILON = 0.001;
const MAX_CAMERA_DISTANCE_MM = 220000;
/** Below this polar the view is "flat": untransformed crisp sheet, no 3D content. */
const FLAT_SHEET_POLAR = THREE.MathUtils.degToRad(0.03);
/** Coarser threshold for the rotated-plan STATE (avoids flicker in damping tails). */
const ROTATED_PLAN_EPSILON = THREE.MathUtils.degToRad(0.5);

function resolvePipeEditRouteNodes(
  element: HvacElement,
  contextElements: readonly HvacElement[],
): PipeRouteNode3D[] {
  const authored = readPipeRouteNodes3d(element);
  if (authored.length >= 2) return authored;
  if (element.type === "refrigerant-pipe-pair") {
    const context = [...contextElements];
    const spec = resolveRefrigerantPipePairSpec(element.properties, context);
    const visual = buildRefrigerantPipePairVisual(element, context);
    const z = element.elevation + (visual.gasLocalZMm + visual.liquidLocalZMm) / 2;
    return spec.routePoints.map((point) => ({ ...point, z }));
  }
  if (element.type === "refrigerant-pipe") {
    const context = [...contextElements];
    const spec = resolveRefrigerantPipeSpec(element.properties, context);
    const visual = buildRefrigerantPipeVisual(element, context);
    const z = element.elevation + visual.localZMm;
    return spec.routePoints.map((point) => ({ ...point, z }));
  }
  return [];
}

function resolvePipeEndpointProtection(
  element: HvacElement,
  contextElements: readonly HvacElement[],
): {
  start: { connected: boolean; unitPort: boolean };
  end: { connected: boolean; unitPort: boolean };
} {
  const context = [...contextElements];
  if (element.type === "refrigerant-pipe-pair") {
    const spec = resolveRefrigerantPipePairSpec(element.properties, context);
    return {
      start: {
        connected: Boolean(spec.startBundleConnection),
        unitPort: spec.startBundleConnection?.connectionKind === "unit-port",
      },
      end: {
        connected: Boolean(spec.endBundleConnection),
        unitPort: spec.endBundleConnection?.connectionKind === "unit-port",
      },
    };
  }
  const spec = resolveRefrigerantPipeSpec(element.properties, context);
  return {
    start: {
      connected: Boolean(spec.startConnection),
      unitPort: spec.startConnection?.connectionKind === "unit-port",
    },
    end: {
      connected: Boolean(spec.endConnection),
      unitPort: spec.endConnection?.connectionKind === "unit-port",
    },
  };
}

function withHybridPipeEditPreview(
  element: HvacElement,
  routeNodes3d: readonly PipeRouteNode3D[],
): HvacElement {
  const routePoints = routeNodes3d.map(({ x, y }) => ({ x, y }));
  const routed = withCanonicalPipeRoute(element, routePoints);
  const properties: Record<string, unknown> = {
    ...routed.properties,
    routeNodes3d: routeNodes3d.map((node) => ({ ...node })),
  };
  if (element.type === "refrigerant-pipe") {
    properties.centerline_start = routePoints[0] ?? element.properties.centerline_start;
    properties.centerline_end = routePoints.at(-1) ?? element.properties.centerline_end;
  }
  return { ...routed, properties };
}

function pipeTransformConstraint(
  key: HybridPipeConstraintKey,
  anchor: THREE.Vector3,
): TransformConstraint {
  if (key === "x" || key === "y" || key === "z") {
    return {
      kind: "axis",
      origin: anchor,
      direction: key === "x"
        ? new THREE.Vector3(1, 0, 0)
        : key === "y"
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1),
    };
  }
  if (key === "xy" || key === "xz" || key === "yz") {
    const normal = key === "xy"
      ? new THREE.Vector3(0, 0, 1)
      : key === "xz"
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    return {
      kind: "plane",
      workplane: createWorkplane(`pipe-${key}`, anchor, normal),
    };
  }
  return { kind: "free" };
}

function pipeProjectionDebugEnabled(): boolean {
  if ((globalThis as Record<string, unknown>).__HVAC_PIPE_ROUTING_DEBUG__ === true) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("hvac.pipe.debug") === "1";
  } catch {
    return false;
  }
}
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

// Wall materials (light-adapted reference tokens): Lambert solid so the
// hemisphere/directional rig shades faces distinctly, always-on boundary edge
// lines so the wall outline reads in every view style, and a ghost variant
// for X-ray.
const WALL_SOLID_MATERIAL_CACHE = new Map<string, THREE.MeshStandardMaterial>();
const WALL_GHOST_MATERIAL_CACHE = new Map<string, THREE.MeshStandardMaterial>();

function getHybridWallMaterial(
  style: WallVisualStyle,
  ghost: boolean,
): THREE.MeshStandardMaterial {
  const cache = ghost ? WALL_GHOST_MATERIAL_CACHE : WALL_SOLID_MATERIAL_CACHE;
  const key = `${style.key}|${ghost ? "ghost" : "solid"}`;
  let material = cache.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color: style.surface.color,
      map: getWallSurfaceTexture(style),
      roughness: style.surface.roughness,
      metalness: style.surface.metalness,
      transparent: ghost,
      opacity: ghost ? 0.14 : 1,
      depthWrite: !ghost,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    cache.set(key, material);
  }
  return material;
}

const WALL_EDGE_MATERIAL = new THREE.LineBasicMaterial({
  color: PROFESSIONAL_WALL_EDGES.modelColor,
  transparent: true,
  opacity: PROFESSIONAL_WALL_EDGES.modelOpacity,
  depthWrite: false,
});

export type HybridViewStyle = "solid" | "xray" | "wire";

interface WallChunkGroupData {
  group: THREE.Group;
  solid: THREE.Mesh;
  edges: THREE.LineSegments;
  /** Always-invisible full-geometry raycast target (works in every style). */
  pick: THREE.Mesh;
  entityIds: string[];
  solidMaterials: THREE.Material | THREE.Material[];
  ghostMaterials: THREE.Material | THREE.Material[];
}

/**
 * Walls render from the shared-node wall graph through the reference solver:
 * ONE merged prism chunk (footprints + junction wedges) per rebuild, so miters,
 * T/X junction cores and flipped bodies are topology-true in 3D — identical
 * source of truth as the 2D plan (see src/wallcore).
 */
function resolveHybridWallStyle(wall: Wall, colorMode: WallColorMode): WallVisualStyle {
  const style = resolveWallVisualStyle(wall);
  if (colorMode === "material") return style;

  const exposureDirection = wall.properties3D.exposureOverride ?? wall.properties3D.exposureDirection;
  const displayColor = colorMode === "u-value"
    ? heatColorFromUValue(wall.properties3D.overallUValue)
    : colorFromExposure(exposureDirection);
  return {
    ...style,
    key: `${style.key}|${colorMode}|${displayColor}`,
    baseColor: displayColor,
    plan: {
      ...style.plan,
      fillColor: displayColor,
    },
    surface: {
      ...style.surface,
      color: displayColor,
      topColor: displayColor,
      patternOpacity: 0,
    },
  };
}

function createWallChunkGroup(
  walls: Wall[],
  wallColorMode: WallColorMode,
): WallChunkGroupData | null {
  if (walls.length === 0) return null;
  const graph = wallGraphFromLegacyWalls(walls, { newId: generateId });
  const solve = solveWallGraphDoc(graph);
  if (solve.footprints.length === 0) return null;

  // Material slots are stable regardless of wall iteration order. Edge
  // footprints retain their own detailed materialId; junction wedges inherit
  // the dominant adjacent wall (structural first, then thicker, then id).
  const styleByWallId = new Map(
    walls.map((wall) => [wall.id, resolveHybridWallStyle(wall, wallColorMode)] as const),
  );
  const styles = [...new Map(
    [...styleByWallId.values()].map((style) => [style.key, style] as const),
  ).values()].sort((left, right) => left.key.localeCompare(right.key));
  const materialIndexByStyleKey = new Map(
    styles.map((style, index) => [style.key, index] as const),
  );
  const materialIndexByEntityId = new Map<string, number>();
  walls.forEach((wall) => {
    const style = styleByWallId.get(wall.id);
    if (style) materialIndexByEntityId.set(wall.id, materialIndexByStyleKey.get(style.key) ?? 0);
  });
  Object.keys(graph.nodes).forEach((nodeId) => {
    const dominantWall = walls
      .filter((wall) => {
        const edge = graph.edges[wall.id];
        return edge?.a === nodeId || edge?.b === nodeId;
      })
      .sort((left, right) => {
        const layerPriority = Number(right.layer === "structural") - Number(left.layer === "structural");
        if (layerPriority !== 0) return layerPriority;
        if (right.thickness !== left.thickness) return right.thickness - left.thickness;
        return left.id.localeCompare(right.id);
      })[0];
    const style = dominantWall ? styleByWallId.get(dominantWall.id) : undefined;
    materialIndexByEntityId.set(nodeId, style ? materialIndexByStyleKey.get(style.key) ?? 0 : 0);
  });

  const chunk = buildWallChunkGeometry(solve, 0, { materialIndexByEntityId });

  const group = new THREE.Group();
  group.name = "hybrid-wall-chunk";

  const solidMaterialList = styles.map((style) => getHybridWallMaterial(style, false));
  const ghostMaterialList = styles.map((style) => getHybridWallMaterial(style, true));
  const solidMaterials: THREE.Material | THREE.Material[] =
    solidMaterialList.length === 1 ? solidMaterialList[0]! : solidMaterialList;
  const ghostMaterials: THREE.Material | THREE.Material[] =
    ghostMaterialList.length === 1 ? ghostMaterialList[0]! : ghostMaterialList;
  const solid = new THREE.Mesh(chunk.geometry, solidMaterials);
  solid.name = "hybrid-wall-solid";
  solid.castShadow = true;
  solid.receiveShadow = true;

  const edges = new THREE.LineSegments(chunk.edgesGeometry, WALL_EDGE_MATERIAL);
  edges.name = "hybrid-wall-edges";

  // Reference practice: picking uses an ALWAYS-INVISIBLE full mesh so hover/
  // selection raycasts keep working when the render mesh is ghosted or hidden.
  const pick = new THREE.Mesh(chunk.geometry, OUTLINE_PROXY_MATERIAL);
  pick.name = "hybrid-wall-pick";
  pick.visible = false;
  pick.userData.entityIds = chunk.entityIds;

  group.add(solid, edges, pick);
  return {
    group,
    solid,
    edges,
    pick,
    entityIds: chunk.entityIds,
    solidMaterials,
    ghostMaterials,
  };
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

  // Outline proxies + micro-edit handles live under the view basis so they
  // survive content rebuilds; the pump keeps proxies rise-synced with walls.
  const proxyLayer = new THREE.Group();
  proxyLayer.name = "hybrid-outline-proxies";
  viewBasis.add(proxyLayer);
  const handleLayer = new HandleLayer3D();
  viewBasis.add(handleLayer.group);
  const pipePreviewLayer = new THREE.Group();
  pipePreviewLayer.name = "hybrid-pipe-preview";
  pipePreviewLayer.renderOrder = 880;
  viewBasis.add(pipePreviewLayer);

  // Reference lighting rig (light-adapted): hemisphere + one angled key so
  // wall faces shade distinctly (top vs side) without shadow maps.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8f939b, 1.15));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(0.6, -0.8, 1.4).multiplyScalar(100_000);
  scene.add(dirLight);

  return {
    renderer,
    scene,
    camera,
    viewBasis,
    root,
    groundGridMaterial,
    proxyLayer,
    handleLayer,
    pipePreviewLayer,
    wallChunk: null,
    postfx: null,
  };
}

/** Outline proxies for hover/selection: the wall's triangles PLUS its two
 * node wedges, so mitered junction corners outline as part of the wall. */
function refreshOutlineProxies(
  sceneState: SceneState,
  walls: Wall[],
  selectedIds: readonly string[],
  hoveredId: string | null,
): void {
  const layer = sceneState.proxyLayer;
  [...layer.children].forEach((child) => {
    layer.remove(child);
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  });
  const chunk = sceneState.wallChunk;
  const postfx = sceneState.postfx;
  if (!postfx) return;
  if (!chunk) {
    postfx.setHover([]);
    postfx.setSelection([]);
    return;
  }

  const wallById = new Map(walls.map((wall) => [wall.id, wall]));
  const buildProxy = (wallId: string): THREE.Mesh | null => {
    const wall = wallById.get(wallId);
    if (!wall) return null;
    const targets = new Set<string>([wallId]);
    if (wall.graph) {
      targets.add(wall.graph.a);
      targets.add(wall.graph.b);
    }
    const geometry = extractEntityTriangles(chunk.pick.geometry, chunk.entityIds, targets);
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, OUTLINE_PROXY_MATERIAL);
    layer.add(mesh);
    return mesh;
  };

  const selectionMeshes = selectedIds
    .map(buildProxy)
    .filter((mesh): mesh is THREE.Mesh => mesh !== null);
  // Hover suppressed when the hovered wall is already selected (reference).
  const hoverMeshes =
    hoveredId && !selectedIds.includes(hoveredId)
      ? [buildProxy(hoveredId)].filter((mesh): mesh is THREE.Mesh => mesh !== null)
      : [];
  postfx.setSelection(selectionMeshes);
  postfx.setHover(hoverMeshes);
}

/** Solid → X-ray → Wire (reference applyStyles): render styles only; the
 * invisible pick mesh keeps raycasting in every mode. */
function applyViewStyle(sceneState: SceneState, style: HybridViewStyle): void {
  const chunk = sceneState.wallChunk;
  if (chunk) {
    chunk.solid.visible = style !== "wire";
    chunk.solid.material = style === "xray" ? chunk.ghostMaterials : chunk.solidMaterials;
    chunk.edges.visible = true;
  }
  sceneState.root.traverse((object) => {
    if (object.name.startsWith("hybrid-room-floor-")) {
      object.visible = style !== "wire";
    } else if (object.name === "hybrid-page-plane") {
      object.visible = style === "solid";
    }
  });
}

function rebuildPipePreviewLayer(
  sceneState: SceneState,
  draftPipes: readonly HvacElement[] | null,
  editPipe: HvacElement | null,
  committedElements: readonly HvacElement[],
): void {
  clearGroup(sceneState.pipePreviewLayer);
  sceneState.root.children.forEach((child) => {
    const elementId = child.userData.hvacElementId as string | undefined;
    const elementType = child.userData.hvacElementType as HvacElement["type"] | undefined;
    if (elementId && elementType && isRefrigerantPipeElementType(elementType)) {
      child.visible = elementId !== editPipe?.id;
    }
  });
  const previews = [...(draftPipes ?? []), ...(editPipe ? [editPipe] : [])];
  if (previews.length === 0) return;
  const committedContext = editPipe
    ? committedElements.map((element) => element.id === editPipe.id ? editPipe : element)
    : [...committedElements];
  const allElements = [...committedContext, ...(draftPipes ?? [])];
  const endpointState = buildRefrigerantPipeEndpointRenderStateMap(allElements);
  const context = {
    allElements,
    pipeEndpointStateMap: endpointState,
    pipeRenderChainStateMap: buildRefrigerantPipeRenderChainStateMap(allElements, endpointState),
    pipeTargets: getVisibleRefrigerantPipeStraightSegmentTargets(allElements),
  };
  for (const element of previews) {
    const mesh = buildHvacElementMesh(element, context);
    if (!mesh || mesh.children.length === 0) continue;
    tuneHvacMesh(mesh);
    mesh.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const previewMaterials = materials.map((material) => {
        const clone = material.clone();
        clone.transparent = true;
        clone.opacity = Math.min(clone.opacity, 0.72);
        clone.depthWrite = false;
        return clone;
      });
      child.material = Array.isArray(child.material) ? previewMaterials : previewMaterials[0]!;
      child.renderOrder = Math.max(child.renderOrder, 880);
    });
    sceneState.pipePreviewLayer.add(mesh);
  }
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
  interactionViewMode = "isometric",
  onCameraViewChange,
  onViewRotatedChange,
  onDebug,
  getViewportMatrix,
  walls,
  wallColorMode = "material",
  rooms,
  symbols,
  objectDefinitions,
  hvacElements,
  onWebglUnavailable,
  selectedIds,
  hoveredElementId,
  viewStyle,
  onHoverWall,
  onSelectWall,
  onSplitWall,
  onMoveWallNode,
  onMoveWallEdges,
  onCommitPipeRouteEdit,
  pipeToolActive = false,
  onPipePointerDown,
  onPipePointerMove,
  onPipePointerCancel,
  pipeInteractionRef,
}: HybridProjectionLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipeDiagnosticRef = useRef<HTMLPreElement | null>(null);
  const sceneStateRef = useRef<SceneState | null>(null);
  const controllerRef = useRef<HybridViewportController | null>(null);
  const requestFrameRef = useRef<(() => void) | null>(null);
  const draftPipesRef = useRef<HvacElement[] | null>(null);
  const editPipePreviewRef = useRef<HvacElement | null>(null);
  const routeActiveRef = useRef(false);
  const resetPipePlacementRef = useRef<(() => void) | null>(null);
  const previewRebuildFrameRef = useRef<number | null>(null);
  const hvacElementsRef = useRef(hvacElements);
  hvacElementsRef.current = hvacElements;
  const schedulePreviewRebuild = useCallback(() => {
    if (previewRebuildFrameRef.current !== null || typeof window === "undefined") return;
    previewRebuildFrameRef.current = window.requestAnimationFrame(() => {
      previewRebuildFrameRef.current = null;
      const sceneState = sceneStateRef.current;
      if (!sceneState) return;
      rebuildPipePreviewLayer(
        sceneState,
        draftPipesRef.current,
        editPipePreviewRef.current,
        hvacElementsRef.current,
      );
      requestFrameRef.current?.();
    });
  }, []);
  const interactionHandleRef = useRef<HybridPipeInteractionHandle | null>(null);
  if (!interactionHandleRef.current) {
    interactionHandleRef.current = {
      setDraftPipes: (elements) => {
        draftPipesRef.current = elements;
        schedulePreviewRebuild();
      },
      setRouteActive: (active) => {
        routeActiveRef.current = active;
        if (!active) resetPipePlacementRef.current?.();
      },
    };
  }
  useEffect(() => {
    if (!pipeInteractionRef) return undefined;
    pipeInteractionRef.current = interactionHandleRef.current;
    return () => {
      if (pipeInteractionRef.current === interactionHandleRef.current) {
        pipeInteractionRef.current = null;
      }
    };
  }, [pipeInteractionRef]);
  // Live prop mirrors so the render pump reads current values without re-subscribing.
  const boardRef = useRef({ width, height, viewportZoom, panOffset, blend: view.blend });
  boardRef.current = { width, height, viewportZoom, panOffset, blend: view.blend };
  const onPolarChangeRef = useRef(onPolarChange);
  onPolarChangeRef.current = onPolarChange;
  const interactionViewModeRef = useRef(interactionViewMode);
  interactionViewModeRef.current = interactionViewMode;
  const onCameraViewChangeRef = useRef(onCameraViewChange);
  onCameraViewChangeRef.current = onCameraViewChange;
  const lastCameraViewRef = useRef<HybridCameraView>("plan");
  const onViewRotatedChangeRef = useRef(onViewRotatedChange);
  onViewRotatedChangeRef.current = onViewRotatedChange;
  const lastViewRotatedRef = useRef(false);
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
  const wallsRef = useRef(walls);
  wallsRef.current = walls;
  const selectedIdsRef = useRef(selectedIds ?? []);
  selectedIdsRef.current = selectedIds ?? [];
  const hoveredRef = useRef(hoveredElementId ?? null);
  hoveredRef.current = hoveredElementId ?? null;
  const viewStyleRef = useRef<HybridViewStyle>(viewStyle ?? "solid");
  viewStyleRef.current = viewStyle ?? "solid";
  const onHoverWallRef = useRef(onHoverWall);
  onHoverWallRef.current = onHoverWall;
  const onSelectWallRef = useRef(onSelectWall);
  onSelectWallRef.current = onSelectWall;
  const onSplitWallRef = useRef(onSplitWall);
  onSplitWallRef.current = onSplitWall;
  const onMoveWallNodeRef = useRef(onMoveWallNode);
  onMoveWallNodeRef.current = onMoveWallNode;
  const onMoveWallEdgesRef = useRef(onMoveWallEdges);
  onMoveWallEdgesRef.current = onMoveWallEdges;
  const onCommitPipeRouteEditRef = useRef(onCommitPipeRouteEdit);
  onCommitPipeRouteEditRef.current = onCommitPipeRouteEdit;
  const pipeToolActiveRef = useRef(pipeToolActive);
  pipeToolActiveRef.current = pipeToolActive;
  const onPipePointerDownRef = useRef(onPipePointerDown);
  onPipePointerDownRef.current = onPipePointerDown;
  const onPipePointerMoveRef = useRef(onPipePointerMove);
  onPipePointerMoveRef.current = onPipePointerMove;
  const onPipePointerCancelRef = useRef(onPipePointerCancel);
  onPipePointerCancelRef.current = onPipePointerCancel;
  const objectDefinitionsById = useMemo(
    () => new Map(objectDefinitions.map((definition) => [definition.id, definition])),
    [objectDefinitions],
  );

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
    if (draftPipesRef.current) schedulePreviewRebuild();

    const controller = new HybridViewportController();
    controllerRef.current = controller;
    controller.attach(
      interactionElement,
      Math.max(1, boardRef.current.width),
      Math.max(1, boardRef.current.height),
    );
    // Outline composer (reference postfx): needs the live camera.
    try {
      sceneState.postfx = new HybridPostFX(
        sceneState.renderer,
        sceneState.scene,
        controller.camera,
      );
    } catch {
      sceneState.postfx = null; // plain render fallback
    }

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      onWebglUnavailable?.();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost, false);

    // ── 3D wall picking / selection / micro-edit handles ──────────────────
    // LMB is unclaimed while the 3D view is engaged (the plan sheet is
    // pointer-events:none and camera-controls binds only MMB/RMB), so the
    // reference practice applies: tools own LMB. Handles hit-test FIRST in
    // screen space, then the invisible pick mesh resolves wall ids from the
    // per-vertex entityIndex attribute.
    const raycaster = new THREE.Raycaster();
    const pickState: {
      downX: number;
      downY: number;
      downHandled: boolean;
      /** Corner-handle drag (endpoint node move, weld-on-drop). */
      drag: { nodeId: string; handleId: string; anchors: Array<[number, number]> } | null;
      /** Wall body drag (translate the whole selected wall(s)). */
      bodyDrag: {
        edgeIds: string[];
        downModel: { x: number; y: number };
        active: boolean;
        pressedId: string;
      } | null;
      pipeDrag: {
        elementId: string;
        nodeIndex: number;
        handleId: string;
        protectedIndexes: Set<number>;
        originalNodes: PipeRouteNode3D[];
        currentNodes: PipeRouteNode3D[];
        drag: FrozenDragContext;
        lastPointer: { clientX: number; clientY: number; pointerId: number };
      } | null;
      pipePressedId: string | null;
      lastModel: { x: number; y: number } | null;
      ghost: THREE.LineSegments | null;
      ghostBody: THREE.Object3D | null;
      /** Original footprint corners of the moved wall(s) (leader-line anchors). */
      leaderAnchors: Array<[number, number]>;
      ghostLeaders: THREE.LineSegments | null;
    } = {
      downX: 0,
      downY: 0,
      downHandled: false,
      drag: null,
      bodyDrag: null,
      pipeDrag: null,
      pipePressedId: null,
      lastModel: null,
      ghost: null,
      ghostBody: null,
      leaderAnchors: [],
      ghostLeaders: null,
    };
    const BODY_GHOST_MATERIAL = new THREE.MeshBasicMaterial({
      color: 0x4f8cff,
      transparent: true,
      opacity: 0.3,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // Dashed leader lines from each original corner to its moved preview corner
    // (dash sizes are refreshed per drag frame to stay ~screen-consistent).
    const LEADER_MATERIAL = new THREE.LineDashedMaterial({
      color: 0x2f6fe0,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      dashSize: 60,
      gapSize: 40,
    });

    const hostPoint = (e: PointerEvent): { x: number; y: number } | null => {
      const rect = interactionElement.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
      return { x, y };
    };
    const viewportSize = () => ({
      width: Math.max(1, boardRef.current.width),
      height: Math.max(1, boardRef.current.height),
    });
    const worldToHostScreen = (world: THREE.Vector3): { x: number; y: number } => {
      controller.camera.updateMatrixWorld();
      return projectWorldToScreen(world, controller.camera, viewportSize());
    };
    const modelToWorldPoint = (p: readonly [number, number, number]): THREE.Vector3 =>
      modelPointToWorld({ x: p[0], y: p[1] }, p[2]);

    const pipePlacementState: {
      lockedPlane: PipeDrawingPlane | null;
      lastCommittedWorld: THREE.Vector3 | null;
      pointerId: number | null;
    } = {
      lockedPlane: null,
      lastCommittedWorld: null,
      pointerId: null,
    };
    const resetPipePlacement = (): void => {
      pipePlacementState.lockedPlane = null;
      pipePlacementState.lastCommittedWorld = null;
      pipePlacementState.pointerId = null;
      const diagnostic = pipeDiagnosticRef.current;
      if (diagnostic) diagnostic.style.display = "none";
    };
    resetPipePlacementRef.current = resetPipePlacement;

    const objectAncestry = (object: THREE.Object3D): THREE.Object3D[] => {
      const result: THREE.Object3D[] = [];
      let current: THREE.Object3D | null = object;
      while (current && current !== sceneState.root) {
        result.push(current);
        current = current.parent;
      }
      return result;
    };

    const raycastDrawingSurface = (ray: THREE.Ray): DrawingSurfaceHit | null => {
      const s = sceneStateRef.current;
      if (!s) return null;
      raycaster.ray.copy(ray);
      raycaster.near = 0;
      raycaster.far = Number.POSITIVE_INFINITY;
      const hits = raycaster.intersectObject(s.root, true);
      for (const hit of hits) {
        if (!(hit.object instanceof THREE.Mesh) || !hit.face) continue;
        const ancestry = objectAncestry(hit.object);
        const names = ancestry.map((object) => object.name);
        if (names.some((name) => name === "hybrid-wall-pick")) continue;
        const hvacRoot = ancestry.find((object) => object.name.startsWith("hvac-"));
        const hvacType = hvacRoot?.userData.hvacElementType as string | undefined;
        if (hvacType === "refrigerant-pipe" || hvacType === "refrigerant-pipe-pair") {
          continue;
        }
        const kind: DrawingSurfaceHit["kind"] | null = names.some(
          (name) => name === "hybrid-page-plane" || name.startsWith("hybrid-room-floor-"),
        )
          ? "floor"
          : names.some((name) => name === "hybrid-wall-solid" || name.startsWith("hybrid-openings-"))
            ? "wall"
            : hvacRoot
              ? "equipment-face"
              : null;
        if (!kind) continue;
        const normal = hit.face.normal
          .clone()
          .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
          .normalize();
        const xAxisHint = new THREE.Vector3(1, 0, 0)
          .transformDirection(hit.object.matrixWorld)
          .normalize();
        return {
          id: `${kind}:${hvacRoot?.name ?? (hit.object.name || hit.object.uuid)}`,
          kind,
          point: hit.point.clone(),
          normal,
          xAxisHint,
        };
      }
      return null;
    };

    const pipeSnapBundleByCandidateId = new Map<string, RefrigerantPipeBundleConnection>();
    const pipeSnapCandidates = (
      canvasPoint: THREE.Vector2,
    ): PipeSnapCandidate[] => {
      const result: PipeSnapCandidate[] = [];
      const viewport = viewportSize();
      pipeSnapBundleByCandidateId.clear();
      const elements = hvacElementsRef.current;
      const typeById = new Map(elements.map((element) => [element.id, element.type]));
      getRefrigerantPipeBundleSnapTargets(elements).forEach((target, index) => {
        const world = modelPointToWorld(target.point, target.elevationMm);
        const cameraPoint = world.clone().applyMatrix4(controller.camera.matrixWorldInverse);
        const projected = world.clone().project(controller.camera);
        if (cameraPoint.z >= 0 || projected.z < -1 || projected.z > 1) return;
        const sourceType = target.sourceElementId
          ? typeById.get(target.sourceElementId)
          : undefined;
        const kind: PipeSnapCandidate["kind"] = target.connectionKind === "unit-port"
          ? "equipment-port"
          : sourceType === "refrigerant-branch-kit" || sourceType === "accessory"
            ? "fitting"
            : "pipe-endpoint";
        const id = `bundle:${target.sourceElementId ?? "anonymous"}:${target.terminalRole ?? index}`;
        const candidate: PipeSnapCandidate = {
          id,
          kind,
          point: world,
          screenDistancePx: worldPointScreenDistance(
            world,
            canvasPoint,
            controller.camera,
            viewport,
          ),
        };
        result.push(candidate);
        pipeSnapBundleByCandidateId.set(id, target);
      });
      const pipeSpecs = elements.flatMap((element) => (
        element.type === "refrigerant-pipe"
          ? [{ element, spec: resolveRefrigerantPipeSpec(element.properties, elements) }]
          : []
      ));
      const bundleCounts = new Map<string, number>();
      pipeSpecs.forEach(({ spec }) => {
        if (spec.bundleId) bundleCounts.set(spec.bundleId, (bundleCounts.get(spec.bundleId) ?? 0) + 1);
      });
      pipeSpecs.forEach(({ element, spec }) => {
        if (spec.bundleId && (bundleCounts.get(spec.bundleId) ?? 0) > 1) return;
        const route3d = readPipeRouteNodes3d(element);
        const nodes = route3d.length >= 2
          ? route3d
          : spec.routePoints.map((point) => ({
              ...point,
              z: element.elevation + spec.outerDiameterMm / 2,
            }));
        if (nodes.length < 2) return;
        [0, nodes.length - 1].forEach((nodeIndex, endpointIndex) => {
          const node = nodes[nodeIndex]!;
          const adjacent = nodes[nodeIndex === 0 ? 1 : nodeIndex - 1]!;
          const dx = node.x - adjacent.x;
          const dy = node.y - adjacent.y;
          const length = Math.hypot(dx, dy) || 1;
          const direction = { x: dx / length, y: dy / length };
          const target: RefrigerantPipeBundleConnection = {
            point: { x: node.x, y: node.y },
            gasPoint: { x: node.x, y: node.y },
            liquidPoint: { x: node.x, y: node.y },
            gasFieldPoint: { x: node.x, y: node.y },
            liquidFieldPoint: { x: node.x, y: node.y },
            gasOuterDiameterMm: spec.outerDiameterMm,
            liquidOuterDiameterMm: spec.outerDiameterMm,
            gasDirection: direction,
            liquidDirection: direction,
            direction,
            elevationMm: node.z,
            gasElevationMm: node.z,
            liquidElevationMm: node.z,
            connectionKind: "field-pipe",
            guideReference: spec.lineKind,
            sourceElementId: element.id,
          };
          const world = modelPointToWorld(target.point, target.elevationMm);
          const cameraPoint = world.clone().applyMatrix4(controller.camera.matrixWorldInverse);
          const projected = world.clone().project(controller.camera);
          if (cameraPoint.z >= 0 || projected.z < -1 || projected.z > 1) return;
          const id = `single:${element.id}:${endpointIndex === 0 ? "start" : "end"}`;
          result.push({
            id,
            kind: "pipe-endpoint",
            point: world,
            screenDistancePx: worldPointScreenDistance(
              world,
              canvasPoint,
              controller.camera,
              viewport,
            ),
          });
          pipeSnapBundleByCandidateId.set(id, target);
        });
      });
      return result;
    };

    const writePipeDiagnostic = (
      e: PointerEvent,
      plane: PipeDrawingPlane,
      rawWorld: THREE.Vector3,
      snappedWorld: THREE.Vector3,
      ray: THREE.Ray,
      constraint: string,
      snap: PipeSnapCandidate | null,
    ): void => {
      const diagnostic = pipeDiagnosticRef.current;
      if (!diagnostic || !pipeProjectionDebugEnabled()) return;
      const rect = canvas.getBoundingClientRect();
      const coordinates = getPointerNDC(e.clientX, e.clientY, rect);
      const fmt = (value: THREE.Vector3 | THREE.Vector2) => value
        .toArray()
        .map((component) => component.toFixed(3))
        .join(", ");
      diagnostic.style.display = "block";
      diagnostic.textContent = [
        `client: ${e.clientX.toFixed(1)}, ${e.clientY.toFixed(1)}`,
        `canvas: ${fmt(coordinates.canvas)}  ndc: ${fmt(coordinates.ndc)}`,
        `ray.o: ${fmt(ray.origin)}  ray.d: ${fmt(ray.direction)}`,
        `plane: ${plane.kind} / ${plane.id}  n: ${fmt(plane.normal)}`,
        `raw: ${fmt(rawWorld)}`,
        `snapped: ${fmt(snappedWorld)}${snap ? ` (${snap.kind}:${snap.id})` : ""}`,
        `constraint: ${constraint}`,
      ].join("\n");
    };

    const resolvePipePointer = (
      e: PointerEvent,
      lockPlane: boolean,
    ): { point: PipePlacementPoint; world: THREE.Vector3; plane: PipeDrawingPlane } | null => {
      const rect = canvas.getBoundingClientRect();
      const coordinates = getPointerNDC(e.clientX, e.clientY, rect);
      const ray = createPointerRay(coordinates.ndc, controller.camera);
      const surfaceHit = pipePlacementState.lockedPlane ? null : raycastDrawingSurface(ray);
      const fallbackZ = pipePlacementState.lastCommittedWorld?.z ?? 0;
      const plane = resolveActiveDrawingPlane({
        camera: controller.camera,
        lockedPlane: pipePlacementState.lockedPlane,
        surfaceHit,
        viewMode: interactionViewModeRef.current,
        anchor: pipePlacementState.lastCommittedWorld,
        fallbackOrigin: new THREE.Vector3(0, 0, fallbackZ),
      });
      const projection = projectPointerToDrawingPlane(
        e.clientX,
        e.clientY,
        rect,
        controller.camera,
        plane,
      );
      if (!projection) return null;
      let constrained = projection.rawWorldPoint;
      let constraint = "none";
      if (pipePlacementState.lastCommittedWorld && (e.ctrlKey || e.metaKey)) {
        const axisHit = intersectPointerRayWithAxis(
          projection.ray,
          pipePlacementState.lastCommittedWorld,
          new THREE.Vector3(0, 0, 1),
        );
        if (axisHit) {
          constrained = axisHit;
          constraint = "world-z";
        }
      } else if (pipePlacementState.lastCommittedWorld && e.shiftKey) {
        const delta = constrained.clone().sub(pipePlacementState.lastCommittedWorld);
        const axis = Math.abs(delta.dot(plane.xAxis)) >= Math.abs(delta.dot(plane.yAxis))
          ? "local-x"
          : "local-y";
        constrained = applyPipeAxisConstraint(
          pipePlacementState.lastCommittedWorld,
          constrained,
          axis,
          plane,
        );
        constraint = axis;
      }
      const snapped = (e.altKey || e.ctrlKey || e.metaKey)
        ? { point: constrained.clone(), candidate: null }
        : resolveSnappedPipePoint(
            constrained,
            pipeSnapCandidates(coordinates.canvas),
            14,
          );
      if (lockPlane && !pipePlacementState.lockedPlane) {
        pipePlacementState.lockedPlane = plane;
      }
      writePipeDiagnostic(
        e,
        plane,
        projection.rawWorldPoint,
        snapped.point,
        projection.ray,
        constraint,
        snapped.candidate,
      );
      const model = worldPointToModel(snapped.point);
      return {
        point: {
          x: model.x,
          y: model.y,
          z: model.z,
          snapTarget: snapped.candidate
            ? pipeSnapBundleByCandidateId.get(snapped.candidate.id)
            : undefined,
        },
        world: snapped.point,
        plane,
      };
    };

    const raycastWallId = (point: { x: number; y: number }): string | null => {
      const s = sceneStateRef.current;
      if (!s?.wallChunk) return null;
      const { width: w, height: h } = viewportSize();
      raycaster.setFromCamera(
        new THREE.Vector2((point.x / w) * 2 - 1, 1 - (point.y / h) * 2),
        controller.camera,
      );
      const hits = raycaster.intersectObject(s.wallChunk.pick, false);
      const wallIds = new Set(wallsRef.current.map((wall) => wall.id));
      return resolveWallHitId(hits, s.wallChunk.entityIds, wallIds);
    };

    const raycastPipeElementId = (point: { x: number; y: number }): string | null => {
      const s = sceneStateRef.current;
      if (!s) return null;
      const { width: w, height: h } = viewportSize();
      raycaster.setFromCamera(
        new THREE.Vector2((point.x / w) * 2 - 1, 1 - (point.y / h) * 2),
        controller.camera,
      );
      const hits = raycaster.intersectObject(s.root, true);
      for (const hit of hits) {
        const root = objectAncestry(hit.object).find((candidate) => {
          const type = candidate.userData.hvacElementType as HvacElement["type"] | undefined;
          return type ? isRefrigerantPipeElementType(type) : false;
        });
        const elementId = root?.userData.hvacElementId as string | undefined;
        if (elementId) return elementId;
      }
      return null;
    };

    const GHOST_MATERIAL_3D = new THREE.LineBasicMaterial({
      color: 0x4f8cff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    const removeGhost = (): void => {
      const s = sceneStateRef.current;
      if (pickState.ghost && s) {
        s.viewBasis.remove(pickState.ghost);
        pickState.ghost.geometry.dispose();
      }
      pickState.ghost = null;
    };
    const updateGhost = (model: { x: number; y: number }): void => {
      const s = sceneStateRef.current;
      if (!s || !pickState.drag) return;
      const anchors = pickState.drag.anchors;
      const positions = new Float32Array(anchors.length * 6);
      anchors.forEach(([ax, ay], i) => {
        positions.set([ax, ay, 5, model.x, model.y, 5], i * 6);
      });
      if (!pickState.ghost) {
        pickState.ghost = new THREE.LineSegments(new THREE.BufferGeometry(), GHOST_MATERIAL_3D);
        pickState.ghost.renderOrder = 890;
        pickState.ghost.frustumCulled = false;
        s.viewBasis.add(pickState.ghost);
      }
      pickState.ghost.geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
    };

    // Body-drag ghost: a translucent copy of the moved wall(s) (triangles +
    // node wedges) that follows the cursor delta, PLUS dashed leader lines from
    // every original footprint corner to its moved preview corner. The real
    // move commits on drop.
    const buildBodyGhost = (edgeIds: string[]): void => {
      const s = sceneStateRef.current;
      if (!s?.wallChunk) return;
      const targets = new Set<string>();
      const anchors: Array<[number, number]> = [];
      for (const id of edgeIds) {
        targets.add(id);
        const wall = wallsRef.current.find((candidate) => candidate.id === id);
        if (!wall) continue;
        if (wall.graph) {
          targets.add(wall.graph.a);
          targets.add(wall.graph.b);
        }
        // The four solved footprint corners (stamped into interior/exterior
        // lines by the mirror) are the natural leader anchors.
        anchors.push(
          [wall.interiorLine.start.x, wall.interiorLine.start.y],
          [wall.interiorLine.end.x, wall.interiorLine.end.y],
          [wall.exteriorLine.start.x, wall.exteriorLine.start.y],
          [wall.exteriorLine.end.x, wall.exteriorLine.end.y],
        );
      }
      const geometry = extractEntityTriangles(
        s.wallChunk.pick.geometry,
        s.wallChunk.entityIds,
        targets,
      );
      if (!geometry) return;
      const mesh = new THREE.Mesh(geometry, BODY_GHOST_MATERIAL);
      mesh.renderOrder = 895;
      mesh.frustumCulled = false;
      s.viewBasis.add(mesh);
      pickState.ghostBody = mesh;

      pickState.leaderAnchors = anchors;
      const leaders = new THREE.LineSegments(new THREE.BufferGeometry(), LEADER_MATERIAL);
      leaders.renderOrder = 896;
      leaders.frustumCulled = false;
      s.viewBasis.add(leaders);
      pickState.ghostLeaders = leaders;
    };
    const updateBodyGhost = (delta: { x: number; y: number }): void => {
      if (pickState.ghostBody) pickState.ghostBody.position.set(delta.x, delta.y, 0);
      const leaders = pickState.ghostLeaders;
      if (!leaders) return;
      const anchors = pickState.leaderAnchors;
      const positions = new Float32Array(anchors.length * 6);
      anchors.forEach(([ax, ay], i) => {
        // original corner → moved preview corner (both on the wall base plane)
        positions.set([ax, ay, 6, ax + delta.x, ay + delta.y, 6], i * 6);
      });
      leaders.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      leaders.computeLineDistances(); // required for LineDashedMaterial
      // Keep the dash cadence roughly screen-consistent across zoom.
      const mmPerPx = 1 / Math.max(controller.camera.zoom, 1e-9);
      LEADER_MATERIAL.dashSize = 8 * mmPerPx;
      LEADER_MATERIAL.gapSize = 5 * mmPerPx;
    };
    const removeBodyGhost = (): void => {
      const s = sceneStateRef.current;
      if (pickState.ghostBody && s) {
        s.viewBasis.remove(pickState.ghostBody);
        (pickState.ghostBody as THREE.Mesh).geometry?.dispose();
      }
      pickState.ghostBody = null;
      if (pickState.ghostLeaders && s) {
        s.viewBasis.remove(pickState.ghostLeaders);
        pickState.ghostLeaders.geometry.dispose();
      }
      pickState.ghostLeaders = null;
      pickState.leaderAnchors = [];
    };

    let activePipeConstraintKey: HybridPipeConstraintKey = "free";
    const beginPipeDragProjection = (
      pointer: { clientX: number; clientY: number; pointerId: number },
      anchorModel: PipeRouteNode3D,
      constraintKey: HybridPipeConstraintKey,
    ): FrozenDragContext | null => {
      const rect = interactionElement.getBoundingClientRect();
      const anchorWorld = modelToWorldPoint([anchorModel.x, anchorModel.y, anchorModel.z]);
      return beginDrag(
        pointer,
        {
          camera: controller.camera,
          viewport: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
          viewMode: interactionViewModeRef.current,
        },
        {
          anchorWorld,
          constraint: pipeTransformConstraint(constraintKey, anchorWorld),
        },
      );
    };

    const beginPipeVertexDrag = (handle: HandleDef3D, e: PointerEvent): boolean => {
      if (handle.editTarget?.kind !== "pipeVertex") return false;
      if (!onCommitPipeRouteEditRef.current) return false;
      const element = hvacElementsRef.current.find((candidate) => candidate.id === handle.entityId);
      if (!element || !isRefrigerantPipeElementType(element.type)) return false;
      const nodes = resolvePipeEditRouteNodes(element, hvacElementsRef.current);
      const nodeIndex = handle.editTarget.nodeIndex;
      const anchor = nodes[nodeIndex];
      if (!anchor) return false;
      const protection = resolvePipeEndpointProtection(element, hvacElementsRef.current);
      const protectedIndexes = getProtectedPipeNodeIndexes(
        nodes.length,
        protection.start,
        protection.end,
      );
      if (protectedIndexes.has(nodeIndex)) return false;
      const pointer = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId };
      const constraintKey = e.ctrlKey || e.metaKey
        ? resolveHybridPipeConstraintKey(e)
        : activePipeConstraintKey;
      const drag = beginPipeDragProjection(pointer, anchor, constraintKey);
      if (!drag) return false;
      pickState.pipeDrag = {
        elementId: element.id,
        nodeIndex,
        handleId: handle.id,
        protectedIndexes,
        originalNodes: nodes.map((node) => ({ ...node })),
        currentNodes: nodes.map((node) => ({ ...node })),
        drag,
        lastPointer: pointer,
      };
      editPipePreviewRef.current = withHybridPipeEditPreview(element, nodes);
      schedulePreviewRebuild();
      return true;
    };

    const rebasePipeVertexDrag = (constraintKey: HybridPipeConstraintKey): void => {
      const current = pickState.pipeDrag;
      if (!current) return;
      const anchor = current.currentNodes[current.nodeIndex];
      if (!anchor) return;
      const drag = beginPipeDragProjection(current.lastPointer, anchor, constraintKey);
      if (!drag) return;
      current.drag = drag;
      activePipeConstraintKey = constraintKey;
    };

    const updatePipeVertexDrag = (e: PointerEvent): boolean => {
      const current = pickState.pipeDrag;
      if (!current) return false;
      current.lastPointer = {
        clientX: e.clientX,
        clientY: e.clientY,
        pointerId: e.pointerId,
      };
      const update = updateDrag(current.drag, current.lastPointer);
      if (!update) return true;
      const modelPoint = worldPointToModel(update.worldPoint);
      current.currentNodes = moveEditablePipeNode(
        current.currentNodes,
        current.nodeIndex,
        { x: modelPoint.x, y: modelPoint.y, z: modelPoint.z },
        current.protectedIndexes,
      );
      const activeNode = current.currentNodes[current.nodeIndex];
      const sceneState = sceneStateRef.current;
      if (activeNode && sceneState) {
        sceneState.handleLayer.setDefs(
          sceneState.handleLayer.getDefs().map((definition) =>
            definition.id === current.handleId
              ? { ...definition, p: [activeNode.x, activeNode.y, activeNode.z] }
              : definition,
          ),
        );
      }
      const element = hvacElementsRef.current.find(
        (candidate) => candidate.id === current.elementId,
      );
      if (element) {
        editPipePreviewRef.current = withHybridPipeEditPreview(element, current.currentNodes);
        schedulePreviewRebuild();
      }
      return true;
    };

    const handlePointerMove3D = (ev: Event): void => {
      const e = ev as PointerEvent;
      const s = sceneStateRef.current;
      if (!s) return;
      if (controller.isFlatView(FLAT_SHEET_POLAR)) return;
      if (pickState.pipeDrag) {
        e.preventDefault();
        e.stopPropagation();
        updatePipeVertexDrag(e);
        request();
        return;
      }
      if (pipeToolActiveRef.current) {
        // MMB/RMB remain camera navigation; LMB/hover belong to the pipe tool.
        if ((e.buttons & 6) !== 0) return;
        const resolved = resolvePipePointer(e, false);
        if (resolved) onPipePointerMoveRef.current?.(resolved.point);
        return;
      }
      const point = hostPoint(e);
      if (!point) return;
      if (pickState.drag) {
        const hit = controller.screenToPlane(point.x, point.y);
        if (hit) {
          const model = worldPointToModel(hit);
          pickState.lastModel = { x: model.x, y: model.y };
          updateGhost(pickState.lastModel);
          request();
        }
        return;
      }
      if (pickState.bodyDrag) {
        const hit = controller.screenToPlane(point.x, point.y);
        if (!hit) return;
        const model = worldPointToModel(hit);
        pickState.lastModel = { x: model.x, y: model.y };
        const screenMoved = Math.hypot(e.clientX - pickState.downX, e.clientY - pickState.downY);
        if (!pickState.bodyDrag.active && screenMoved > 4) {
          pickState.bodyDrag.active = true;
          buildBodyGhost(pickState.bodyDrag.edgeIds);
        }
        if (pickState.bodyDrag.active) {
          // updateBodyGhost moves the translucent ghost AND rebuilds the
          // dashed leader lines from each original footprint corner to its
          // moved preview corner.
          updateBodyGhost({
            x: model.x - pickState.bodyDrag.downModel.x,
            y: model.y - pickState.bodyDrag.downModel.y,
          });
          request();
        }
        return;
      }
      if (e.buttons !== 0) return; // navigating (pan/orbit) — leave hover alone
      const handle = s.handleLayer.hitTest(point.x, point.y, worldToHostScreen, modelToWorldPoint);
      if (handle) {
        if (s.handleLayer.setState(handle.id, "hover")) request();
        onHoverWallRef.current?.(null);
        return;
      }
      if (s.handleLayer.setState("", "idle")) request();
      onHoverWallRef.current?.(raycastPipeElementId(point) ?? raycastWallId(point));
    };

    const handlePointerDown3D = (ev: Event): void => {
      const e = ev as PointerEvent;
      if (e.button !== 0) return;
      const s = sceneStateRef.current;
      if (!s || controller.isFlatView(FLAT_SHEET_POLAR)) return;
      if (pipeToolActiveRef.current) {
        const resolved = resolvePipePointer(e, true);
        if (!resolved) return;
        e.preventDefault();
        e.stopPropagation();
        pipePlacementState.lastCommittedWorld = resolved.world.clone();
        pipePlacementState.pointerId = e.pointerId;
        interactionElement.setPointerCapture?.(e.pointerId);
        onPipePointerDownRef.current?.(resolved.point);
        request();
        return;
      }
      const point = hostPoint(e);
      if (!point) return;
      pickState.downX = e.clientX;
      pickState.downY = e.clientY;
      pickState.downHandled = false;
      pickState.bodyDrag = null;
      pickState.pipePressedId = null;
      const handle = s.handleLayer.hitTest(point.x, point.y, worldToHostScreen, modelToWorldPoint);
      if (handle) {
        pickState.downHandled = true;
        e.preventDefault();
        e.stopPropagation();
        if (beginPipeVertexDrag(handle, e)) {
          s.handleLayer.setState(handle.id, "active");
          interactionElement.setPointerCapture?.(e.pointerId);
          request();
          return;
        }
        if (handle.kind === "pipeVertex") return;
        if (handle.kind === "midpointInsert") {
          onSplitWallRef.current?.(handle.entityId);
          return;
        }
        // Endpoint corner drag (weld-on-drop on release, reference wall.moveNode).
        const anchors: Array<[number, number]> = [];
        for (const wall of wallsRef.current) {
          if (wall.graph?.a === handle.entityId) anchors.push([wall.endPoint.x, wall.endPoint.y]);
          else if (wall.graph?.b === handle.entityId) anchors.push([wall.startPoint.x, wall.startPoint.y]);
        }
        pickState.drag = { nodeId: handle.entityId, handleId: handle.id, anchors };
        pickState.lastModel = null;
        s.handleLayer.setState(handle.id, "active");
        interactionElement.setPointerCapture?.(e.pointerId);
        request();
        return;
      }
      // No handle → press on a wall BODY arms a body-drag-to-move (activates
      // past a 4px threshold; a pure click falls through to select on up).
      const pipeId = raycastPipeElementId(point);
      if (pipeId) {
        pickState.downHandled = true;
        pickState.pipePressedId = pipeId;
        e.preventDefault();
        e.stopPropagation();
        interactionElement.setPointerCapture?.(e.pointerId);
        return;
      }
      const wallId = raycastWallId(point);
      if (!wallId) return; // empty space; up() clears selection
      pickState.downHandled = true;
      e.preventDefault();
      e.stopPropagation();
      const hit = controller.screenToPlane(point.x, point.y);
      if (!hit) return;
      const downModel = worldPointToModel(hit);
      const current = selectedIdsRef.current;
      // Drag the whole selection when pressing an already-selected wall,
      // otherwise just the pressed one (reference dragMove semantics).
      const edgeIds = current.includes(wallId) ? [...current] : [wallId];
      pickState.bodyDrag = {
        edgeIds,
        downModel: { x: downModel.x, y: downModel.y },
        active: false,
        pressedId: wallId,
      };
      pickState.lastModel = { x: downModel.x, y: downModel.y };
      interactionElement.setPointerCapture?.(e.pointerId);
    };

    const selectWall = (id: string | null, shiftKey: boolean): void => {
      const current = selectedIdsRef.current;
      if (id) {
        if (shiftKey) {
          onSelectWallRef.current?.(
            current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
          );
        } else {
          onSelectWallRef.current?.([id]);
        }
      } else if (!shiftKey && current.length > 0) {
        onSelectWallRef.current?.([]);
      }
    };

    const handlePointerUp3D = (ev: Event): void => {
      const e = ev as PointerEvent;
      const s = sceneStateRef.current;
      const releaseCapture = (): void => {
        try {
          interactionElement.releasePointerCapture?.(e.pointerId);
        } catch {
          /* pointer already released */
        }
      };
      if (pipeToolActiveRef.current && e.button === 0) {
        releaseCapture();
        pipePlacementState.pointerId = null;
        return;
      }
      if (pickState.pipeDrag) {
        const pipeDrag = pickState.pipeDrag;
        pickState.pipeDrag = null;
        editPipePreviewRef.current = null;
        s?.handleLayer.setState("", "idle");
        releaseCapture();
        const changed = pipeDrag.currentNodes.some((node, index) => {
          const original = pipeDrag.originalNodes[index];
          return !original || Math.hypot(
            node.x - original.x,
            node.y - original.y,
            node.z - original.z,
          ) > 1e-6;
        });
        if (changed) {
          onCommitPipeRouteEditRef.current?.(
            pipeDrag.elementId,
            pipeDrag.currentNodes.map((node) => ({ ...node })),
          );
        }
        schedulePreviewRebuild();
        request();
        return;
      }
      if (pickState.pipePressedId) {
        const pipeId = pickState.pipePressedId;
        pickState.pipePressedId = null;
        releaseCapture();
        selectWall(pipeId, e.shiftKey);
        request();
        return;
      }
      if (pickState.drag) {
        const drag = pickState.drag;
        pickState.drag = null;
        removeGhost();
        s?.handleLayer.setState("", "idle");
        releaseCapture();
        if (pickState.lastModel) {
          onMoveWallNodeRef.current?.(drag.nodeId, pickState.lastModel, true);
        }
        request();
        return;
      }
      if (pickState.bodyDrag) {
        const body = pickState.bodyDrag;
        pickState.bodyDrag = null;
        removeBodyGhost();
        releaseCapture();
        if (body.active && pickState.lastModel) {
          const delta = {
            x: pickState.lastModel.x - body.downModel.x,
            y: pickState.lastModel.y - body.downModel.y,
          };
          if (Math.hypot(delta.x, delta.y) > 1e-6) {
            onMoveWallEdgesRef.current?.(body.edgeIds, delta);
          }
        } else {
          // No drag → a click: select the pressed wall.
          selectWall(body.pressedId, e.shiftKey);
        }
        request();
        return;
      }
      if (e.button !== 0 || pickState.downHandled) return;
      if (!s || controller.isFlatView(FLAT_SHEET_POLAR)) return;
      const moved = Math.hypot(e.clientX - pickState.downX, e.clientY - pickState.downY);
      if (moved > 4) return; // it was a pan on empty space, not a click
      const point = hostPoint(e);
      if (!point) return;
      selectWall(raycastWallId(point), e.shiftKey);
    };

    interactionElement.addEventListener("pointermove", handlePointerMove3D);
    interactionElement.addEventListener("pointerdown", handlePointerDown3D);
    interactionElement.addEventListener("pointerup", handlePointerUp3D);
    const handlePipeConstraintKeyDown = (e: KeyboardEvent): void => {
      const target = e.target;
      if (
        !pickState.pipeDrag
        && target instanceof HTMLElement
        && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
      ) {
        return;
      }
      const constraintKey = resolveHybridPipeConstraintKey(e);
      if (constraintKey === "free") return;
      activePipeConstraintKey = constraintKey;
      if (pickState.pipeDrag) {
        e.preventDefault();
        rebasePipeVertexDrag(constraintKey);
      }
    };
    const handlePipeConstraintKeyUp = (e: KeyboardEvent): void => {
      if (["x", "y", "z", "control", "meta"].includes(e.key.toLowerCase())) {
        activePipeConstraintKey = "free";
      }
    };
    window.addEventListener("keydown", handlePipeConstraintKeyDown);
    window.addEventListener("keyup", handlePipeConstraintKeyUp);
    const handlePointerCancel3D = (ev: Event): void => {
      const e = ev as PointerEvent;
      if (pickState.pipeDrag || pickState.pipePressedId) {
        const cancelledDrag = pickState.pipeDrag;
        const originalNode = cancelledDrag?.originalNodes[cancelledDrag.nodeIndex];
        const sceneState = sceneStateRef.current;
        if (cancelledDrag && originalNode && sceneState) {
          sceneState.handleLayer.setDefs(
            sceneState.handleLayer.getDefs().map((definition) =>
              definition.id === cancelledDrag.handleId
                ? { ...definition, p: [originalNode.x, originalNode.y, originalNode.z] }
                : definition,
            ),
          );
        }
        pickState.pipeDrag = null;
        pickState.pipePressedId = null;
        editPipePreviewRef.current = null;
        sceneStateRef.current?.handleLayer.setState("", "idle");
        schedulePreviewRebuild();
        request();
      }
      try {
        interactionElement.releasePointerCapture?.(e.pointerId);
      } catch {
        /* pointer already released */
      }
      if (!pipeToolActiveRef.current) return;
      routeActiveRef.current = false;
      resetPipePlacement();
      onPipePointerCancelRef.current?.();
    };
    interactionElement.addEventListener("pointercancel", handlePointerCancel3D);

    // Continue a live multi-click route even if the pointer briefly leaves the
    // host. Avoid duplicating events that already bubbled from the host.
    const handleWindowPipeMove = (ev: Event): void => {
      const e = ev as PointerEvent;
      if (!pipeToolActiveRef.current || !routeActiveRef.current) return;
      if (e.target instanceof Node && interactionElement.contains(e.target)) return;
      if ((e.buttons & 6) !== 0 || controller.isFlatView(FLAT_SHEET_POLAR)) return;
      const resolved = resolvePipePointer(e, false);
      if (resolved) onPipePointerMoveRef.current?.(resolved.point);
    };
    window.addEventListener("pointermove", handleWindowPipeMove);

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
        s.postfx?.setSize(w, h);
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
      s.pipePreviewLayer.visible = !isFlat;
      // Walls RISE from the paper: flat during the sheet crossfade (top face
      // glued to the plan footprint — a full-height solid would parallax its
      // top by height·tanφ and read as a broken double wall), then grow to
      // full height once the sheet is gone. Derived-cache reveal only.
      const rise = Math.max(wallRiseForPolar(polar), 0.002);
      const wallChunk = s.root.getObjectByName("hybrid-wall-chunk");
      if (wallChunk) {
        // Keep a few mm of body so the flattened walls stay above floor fills.
        wallChunk.scale.z = rise;
      }
      // Outline proxies mirror the wall triangles — rise with them.
      s.proxyLayer.scale.z = rise;
      // Handles stay ~10px on screen at any zoom (reference practice).
      s.handleLayer.updateScale(1 / Math.max(controller.camera.zoom, 1e-9));
      s.handleLayer.group.visible = !isFlat;
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
      if (s.postfx) {
        s.postfx.render(delta);
      } else {
        s.renderer.render(s.scene, controller.camera);
      }
      onPolarChangeRef.current?.(controller.polar);
      const cameraView = controller.cameraView;
      if (cameraView !== lastCameraViewRef.current) {
        lastCameraViewRef.current = cameraView;
        onCameraViewChangeRef.current?.(cameraView);
      }
      // Rotated-plan state (transition-edge only, coarse threshold): the host
      // locks editing + hides the axis-aligned rulers while rotated.
      const viewRotated = Math.abs(controller.azimuthWrapped) > ROTATED_PLAN_EPSILON;
      if (viewRotated !== lastViewRotatedRef.current) {
        lastViewRotatedRef.current = viewRotated;
        onViewRotatedChangeRef.current?.(viewRotated);
      }
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
      interactionElement.removeEventListener("pointermove", handlePointerMove3D);
      interactionElement.removeEventListener("pointerdown", handlePointerDown3D);
      interactionElement.removeEventListener("pointerup", handlePointerUp3D);
      interactionElement.removeEventListener("pointercancel", handlePointerCancel3D);
      window.removeEventListener("pointermove", handleWindowPipeMove);
      window.removeEventListener("keydown", handlePipeConstraintKeyDown);
      window.removeEventListener("keyup", handlePipeConstraintKeyUp);
      editPipePreviewRef.current = null;
      resetPipePlacementRef.current = null;
      removeGhost();
      removeBodyGhost();
      if (raf != null && typeof window !== "undefined") window.cancelAnimationFrame(raf);
      if (previewRebuildFrameRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(previewRebuildFrameRef.current);
        previewRebuildFrameRef.current = null;
      }
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
      sceneState.postfx?.dispose();
      sceneState.postfx = null;
      sceneState.handleLayer.dispose();
      sceneState.wallChunk = null;
      clearGroup(sceneState.root);
      clearGroup(sceneState.pipePreviewLayer);
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

    const wallChunkData = createWallChunkGroup(walls, wallColorMode);
    sceneState.wallChunk = wallChunkData;
    if (wallChunkData) sceneState.root.add(wallChunkData.group);

    walls.forEach((wall) => {
      const openings = createWallOpenings3D(wall);
      if (openings.children.length > 0) {
        openings.name = `hybrid-openings-${wall.id}`;
        // Wall body, linework and hosted openings rise as one architectural
        // system during the 2D -> 3D handoff.
        (wallChunkData?.group ?? sceneState.root).add(openings);
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
    // Content changed → re-apply the view style and rebuild outline proxies
    // against the fresh chunk (selection may reference rebuilt geometry).
    applyViewStyle(sceneState, viewStyleRef.current);
    refreshOutlineProxies(sceneState, walls, selectedIdsRef.current, hoveredRef.current);
    requestFrameRef.current?.();
    schedulePreviewRebuild();
  }, [
    hvacElements,
    objectDefinitionsById,
    pageHeightMm,
    pageWidthMm,
    rooms,
    symbols,
    wallColorMode,
    walls,
    schedulePreviewRebuild,
  ]);

  // Hover / selection → outline proxies (reference refreshProxies wiring).
  useEffect(() => {
    const sceneState = sceneStateRef.current;
    if (!sceneState) return;
    refreshOutlineProxies(sceneState, walls, selectedIds ?? [], hoveredElementId ?? null);
    requestFrameRef.current?.();
  }, [selectedIds, hoveredElementId, walls]);

  // Selection → micro-edit handle definitions (square corners + diamond mid).
  useEffect(() => {
    const sceneState = sceneStateRef.current;
    if (!sceneState) return;
    const defs: HandleDef3D[] = [];
    const seenNodes = new Set<string>();
    for (const id of selectedIds ?? []) {
      const pipe = hvacElements.find(
        (candidate) => candidate.id === id && isRefrigerantPipeElementType(candidate.type),
      );
      if (pipe) {
        const routeNodes = resolvePipeEditRouteNodes(pipe, hvacElements);
        const protection = resolvePipeEndpointProtection(pipe, hvacElements);
        const protectedIndexes = getProtectedPipeNodeIndexes(
          routeNodes.length,
          protection.start,
          protection.end,
        );
        routeNodes.forEach((node, nodeIndex) => {
          if (protectedIndexes.has(nodeIndex)) return;
          defs.push({
            id: `pipe:${pipe.id}:${nodeIndex}`,
            kind: "pipeVertex",
            p: [node.x, node.y, node.z],
            entityId: pipe.id,
            editTarget: { kind: "pipeVertex", nodeIndex },
          });
        });
        continue;
      }
      const wall = walls.find((candidate) => candidate.id === id);
      if (!wall?.graph) continue;
      if (!seenNodes.has(wall.graph.a)) {
        seenNodes.add(wall.graph.a);
        defs.push({
          id: `ep:${wall.graph.a}`,
          kind: "endpoint",
          p: [wall.startPoint.x, wall.startPoint.y, 5],
          entityId: wall.graph.a,
          editTarget: { kind: "wallNode" },
        });
      }
      if (!seenNodes.has(wall.graph.b)) {
        seenNodes.add(wall.graph.b);
        defs.push({
          id: `ep:${wall.graph.b}`,
          kind: "endpoint",
          p: [wall.endPoint.x, wall.endPoint.y, 5],
          entityId: wall.graph.b,
          editTarget: { kind: "wallNode" },
        });
      }
      defs.push({
        id: `mi:${id}`,
        kind: "midpointInsert",
        p: [
          (wall.startPoint.x + wall.endPoint.x) / 2,
          (wall.startPoint.y + wall.endPoint.y) / 2,
          5,
        ],
        entityId: id,
        editTarget: { kind: "wallEdge" },
      });
    }
    sceneState.handleLayer.setDefs(defs);
    requestFrameRef.current?.();
  }, [hvacElements, selectedIds, walls]);

  // View style: Solid → X-ray → Wire (reference applyStyles).
  useEffect(() => {
    const sceneState = sceneStateRef.current;
    if (!sceneState) return;
    applyViewStyle(sceneState, viewStyle ?? "solid");
    requestFrameRef.current?.();
  }, [viewStyle]);

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
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-0 block pointer-events-none"
        style={{
          width: "100%",
          height: "100%",
          opacity: width <= 0 || height <= 0 ? 0 : 1,
        }}
      />
      <pre
        ref={pipeDiagnosticRef}
        aria-hidden="true"
        className="pointer-events-none absolute bottom-3 left-3 z-[25] hidden rounded bg-slate-950/90 p-2 text-[10px] leading-4 text-emerald-300 shadow-lg"
      />
    </>
  );
}
