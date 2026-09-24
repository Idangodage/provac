"use client";

import * as THREE from "three";

import type { HvacElement, Point2D } from "../../../../types";
import { markMaterialOwned } from "../../threeResourceLifecycle";
import { buildCeilingCassetteModel } from "../ceilingCassetteModel";
import { compileCopperSocketElbowRoute } from "../copperSocketElbowRoute";
import { resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from "../copperSocketElbows";
import {
  buildDuctedIndoorUnitModel,
  DUCTED_INDOOR_UNIT_COLOR_PALETTE,
} from "../ductedIndoorUnitModel";
import { resolveFieldPipeBendRadiusMm } from "../fieldPipeBends";
import { buildGiDuctVisual } from "../giDuctModel";
import type { PipeBypass } from "../pipeBypass";
import { liftPipePlanRouteTo3d, readPipeRouteNodes3d } from "../pipeRoute3d";
import { computeFittingRunMm } from "../pipeRoutingRules";
import { getActivePipeRoutingSettings } from "../pipeRoutingSettings";
import {
  buildRefrigerantBranchKitViewModel,
  isRefrigerantBranchKitElement,
  resolveRefrigerantBranchKitInlineAnchorLocal,
  resolveRefrigerantBranchKitLineSelection,
  REFRIGERANT_BRANCH_KIT_COLOR_PALETTE,
} from "../refrigerantBranchKitModel";
import {
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipeVisual,
  findNearestRefrigerantPipeBundleSegmentTarget,
  resolveInlineBranchKitCenter,
} from "../refrigerantPipePairModel";
import type {
  RefrigerantPipeEndpointRenderState,
  RefrigerantPipeRenderChainState,
  VisibleRefrigerantPipeSegmentTarget,
} from "../refrigerantPipeRenderState";
import { getUnitPipePortSpec } from "../unitPipePortModel";

import { addCondensateGullyMeshes, addCondensatePipeMeshes } from "./condensateMeshes";
import { buildCopperSocketElbowMesh } from "./copperSocketElbowMesh";
import { instantiateGlbModel } from "./glbModelCache";
import {
  buildCylinderGeometry,
  buildReducerGeometry,
  buildSweptTubeGeometry,
  unionGeometries,
} from "./pipeJointGeometry";

const EPSILON = 0.001;

/** Default cross-section facets for swept pipe / fitting geometry. */
const PIPE_RADIAL_SEGMENTS = 24;

/** Service colours match the plan convention in every projection. */
export const REFRIGERANT_PIPE_3D_COLORS = {
  gas: "#4088b3",
  liquid: "#bc863f",
  gasCopper: "#c5894d",
  liquidCopper: "#dca25d",
} as const;

const MEP_PROJECTION_PALETTE = {
  ductTop: "#8d99a6",
  ductSide: "#687482",
  ductEdge: "#2635a4",
  ductAccent: "#b026d1",
  ductCollar: "#2e3a9d",
  ductSupport: "#334155",
  pipeSupport: "#16a34a",
  pipeClamp: "#0f172a",
  pipeBase: "#475569",
} as const;

export type HvacProjectionLabelAnchor = {
  key: string;
  position: THREE.Vector3;
  text: string;
  color: string;
};

export type HvacBuildSceneContext = {
  allElements: HvacElement[];
  pipeEndpointStateMap?: Map<string, RefrigerantPipeEndpointRenderState>;
  pipeRenderChainStateMap?: Map<string, RefrigerantPipeRenderChainState>;
  pipeTargets?: VisibleRefrigerantPipeSegmentTarget[];
};

type Hvac3DPalette = {
  body: string;
  trim: string;
  grille: string;
  metal: string;
  accent: string;
  label: string;
};

type BoxMaterialKey = `${string}|${number}|${0 | 1}`;

const MATERIAL_CACHE = new Map<BoxMaterialKey, THREE.MeshStandardMaterial>();
const EXPOSED_CORE_MATERIAL_CACHE = new Map<string, THREE.MeshStandardMaterial>();
const COPPER_FITTING_MATERIAL_CACHE = new Map<string, THREE.MeshStandardMaterial>();

export function isProjectionCoreHvacType(type: HvacElement["type"]): boolean {
  return (
    type === "duct" ||
    type === "refrigerant-pipe" ||
    type === "refrigerant-pipe-pair" ||
    type === "refrigerant-branch-kit" ||
    type === "ducted-ac" ||
    type === "ceiling-cassette-ac" ||
    type === "ceiling-suspended-ac" ||
    type === "wall-mounted-ac" ||
    type === "split-ac" ||
    type === "outdoor-unit" ||
    type === "filter" ||
    type === "remote-controller" ||
    type === "control-panel" ||
    type === "accessory" ||
    type === "diffuser" ||
    type === "return-grille" ||
    type === "condensate-pipe" ||
    type === "condensate-gully"
  );
}

function getSharedBoxMaterial(
  color: string,
  opacity: number,
  isTransparent: boolean,
): THREE.MeshStandardMaterial {
  const key = `${color}|${opacity}|${isTransparent ? 1 : 0}` as BoxMaterialKey;
  let material = MATERIAL_CACHE.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color,
      transparent: isTransparent,
      opacity,
      roughness: 0.9,
      metalness: 0.06,
    });
    MATERIAL_CACHE.set(key, material);
  }
  return material;
}

function getExposedCoreMaterial(color: string): THREE.MeshStandardMaterial {
  let material = EXPOSED_CORE_MATERIAL_CACHE.get(color);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.72,
      metalness: 0.2,
      // The copper cross-section is intentionally coplanar with the insulation
      // end cap. Pull it forward in depth without changing model-space bounds.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    EXPOSED_CORE_MATERIAL_CACHE.set(color, material);
  }
  return material;
}

function getCopperFittingMaterial(color: string): THREE.MeshStandardMaterial {
  let material = COPPER_FITTING_MATERIAL_CACHE.get(color);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, roughness: 0.36, metalness: 0.65 });
    COPPER_FITTING_MATERIAL_CACHE.set(color, material);
  }
  return material;
}

function createLocalBoxMesh(
  width: number,
  depth: number,
  height: number,
  color: string,
  position: THREE.Vector3,
  options?: { opacity?: number; renderOrder?: number },
): THREE.Mesh {
  const opacity = options?.opacity ?? 1;
  const geometry = new THREE.BoxGeometry(width, depth, height);
  const material = getSharedBoxMaterial(color, opacity, opacity < 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.renderOrder = options?.renderOrder ?? 18;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createLocalCylinderMesh(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  color: string,
  position: THREE.Vector3,
  options?: {
    radialSegments?: number;
    rotation?: THREE.Euler;
    opacity?: number;
    renderOrder?: number;
    openEnded?: boolean;
  },
): THREE.Mesh {
  const opacity = options?.opacity ?? 1;
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    options?.radialSegments ?? 24,
    1,
    options?.openEnded ?? false,
  );
  const material = getSharedBoxMaterial(color, opacity, opacity < 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  if (options?.rotation) {
    mesh.rotation.copy(options.rotation);
  }
  mesh.renderOrder = options?.renderOrder ?? 18;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createLocalTorusMesh(
  radius: number,
  tube: number,
  color: string,
  position: THREE.Vector3,
  options?: {
    radialSegments?: number;
    tubularSegments?: number;
    rotation?: THREE.Euler;
    opacity?: number;
    renderOrder?: number;
  },
): THREE.Mesh {
  const opacity = options?.opacity ?? 1;
  const geometry = new THREE.TorusGeometry(
    radius,
    tube,
    options?.radialSegments ?? 10,
    options?.tubularSegments ?? 36,
  );
  const material = getSharedBoxMaterial(color, opacity, opacity < 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  if (options?.rotation) {
    mesh.rotation.copy(options.rotation);
  }
  mesh.renderOrder = options?.renderOrder ?? 20;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createRoundedRectShape(
  width: number,
  depth: number,
  radius: number,
): THREE.Shape {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const safeRadius = Math.max(
    0,
    Math.min(radius, halfWidth - 1, halfDepth - 1),
  );
  const shape = new THREE.Shape();

  if (safeRadius <= 0.5) {
    shape.moveTo(-halfWidth, -halfDepth);
    shape.lineTo(halfWidth, -halfDepth);
    shape.lineTo(halfWidth, halfDepth);
    shape.lineTo(-halfWidth, halfDepth);
    shape.closePath();
    return shape;
  }

  shape.moveTo(-halfWidth + safeRadius, -halfDepth);
  shape.lineTo(halfWidth - safeRadius, -halfDepth);
  shape.absarc(
    halfWidth - safeRadius,
    -halfDepth + safeRadius,
    safeRadius,
    -Math.PI / 2,
    0,
    false,
  );
  shape.lineTo(halfWidth, halfDepth - safeRadius);
  shape.absarc(
    halfWidth - safeRadius,
    halfDepth - safeRadius,
    safeRadius,
    0,
    Math.PI / 2,
    false,
  );
  shape.lineTo(-halfWidth + safeRadius, halfDepth);
  shape.absarc(
    -halfWidth + safeRadius,
    halfDepth - safeRadius,
    safeRadius,
    Math.PI / 2,
    Math.PI,
    false,
  );
  shape.lineTo(-halfWidth, -halfDepth + safeRadius);
  shape.absarc(
    -halfWidth + safeRadius,
    -halfDepth + safeRadius,
    safeRadius,
    Math.PI,
    Math.PI * 1.5,
    false,
  );
  shape.closePath();
  return shape;
}

function createRoundedLocalExtrudedMesh(
  width: number,
  depth: number,
  height: number,
  radius: number,
  color: string,
  position: THREE.Vector3,
  options?: {
    opacity?: number;
    renderOrder?: number;
    rotation?: THREE.Euler;
    bevelEnabled?: boolean;
    bevelSize?: number;
    bevelThickness?: number;
    bevelSegments?: number;
    curveSegments?: number;
  },
): THREE.Mesh {
  const opacity = options?.opacity ?? 1;
  const isTransparent = opacity < 1;
  const safeRadius = Math.max(
    0,
    Math.min(radius, width / 2 - 1, depth / 2 - 1),
  );
  const bevelEnabled =
    (options?.bevelEnabled ?? true) && safeRadius > 0.5 && height > 4;
  const geometry = new THREE.ExtrudeGeometry(
    createRoundedRectShape(width, depth, safeRadius),
    {
      depth: height,
      bevelEnabled,
      bevelSize: Math.min(options?.bevelSize ?? safeRadius * 0.34, safeRadius * 0.75),
      bevelThickness: Math.min(
        options?.bevelThickness ?? Math.min(height * 0.18, safeRadius * 0.42),
        Math.max(0.8, height / 2 - 0.4),
      ),
      bevelSegments: options?.bevelSegments ?? 3,
      curveSegments: options?.curveSegments ?? 10,
      steps: 1,
    },
  );
  geometry.translate(0, 0, -height / 2);
  geometry.computeVertexNormals();

  const material = getSharedBoxMaterial(color, opacity, isTransparent);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  if (options?.rotation) {
    mesh.rotation.copy(options.rotation);
  }
  mesh.renderOrder = options?.renderOrder ?? 18;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createCylinderBetweenPoints(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  color: string,
  options?: {
    opacity?: number;
    renderOrder?: number;
    radialSegments?: number;
    capStart?: boolean;
    capEnd?: boolean;
  },
): THREE.Object3D | null {
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length < EPSILON) {
    return null;
  }

  const axis = delta.normalize();
  const center = start.clone().add(end).multiplyScalar(0.5);
  const opacity = options?.opacity ?? 1;
  const renderOrder = options?.renderOrder ?? 18;
  const radialSegments = options?.radialSegments ?? 18;
  const group = new THREE.Group();

  const cylinder = createLocalCylinderMesh(radius, radius, length, color, center, {
    opacity,
    renderOrder,
    radialSegments,
    openEnded: true,
  });
  cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  group.add(cylinder);

  const createCap = (position: THREE.Vector3, normal: THREE.Vector3): void => {
    const geometry = new THREE.CircleGeometry(radius, radialSegments);
    const material = getSharedBoxMaterial(color, opacity, opacity < 1);
    const cap = new THREE.Mesh(geometry, material);
    cap.position.copy(position);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    cap.renderOrder = renderOrder;
    cap.castShadow = true;
    cap.receiveShadow = true;
    group.add(cap);
  };

  if (options?.capStart !== false) {
    createCap(start, axis.clone().multiplyScalar(-1));
  }
  if (options?.capEnd !== false) {
    createCap(end, axis);
  }

  return group;
}

function createTubeAlongPoints(
  points: THREE.Vector3[],
  radius: number,
  color: string,
  options: {
    opacity?: number;
    renderOrder?: number;
    radialSegments?: number;
    openStart?: boolean;
    openEnd?: boolean;
    /** Resolved document-policy centreline bend radius. */
    bendRadiusMm: number;
    surfaceRole?: "insulation" | "core";
    lineKind?: "gas" | "liquid";
    preservePlanGeometry?: boolean;
  },
): THREE.Object3D | null {
  if (points.length < 2) {
    return null;
  }

  const cleaned: THREE.Vector3[] = [];
  points.forEach((point) => {
    const previous = cleaned[cleaned.length - 1];
    if (!previous || previous.distanceTo(point) > 0.5) {
      cleaned.push(point.clone());
    }
  });
  if (cleaned.length < 2) {
    return null;
  }

  // Extend open ends slightly so chained pipe elements overlap without a seam.
  const finalPoints = cleaned.map((point) => point.clone());
  const continuationOverlapMm = Math.max(1.5, radius * 0.75);

  if (options.openStart && finalPoints.length >= 2) {
    const startDirection = finalPoints[1]!.clone().sub(finalPoints[0]!);
    if (startDirection.length() > EPSILON) {
      startDirection.normalize();
      finalPoints[0] = finalPoints[0]!
        .clone()
        .add(startDirection.multiplyScalar(-continuationOverlapMm));
    }
  }

  if (options.openEnd && finalPoints.length >= 2) {
    const lastIndex = finalPoints.length - 1;
    const endDirection = finalPoints[lastIndex]!
      .clone()
      .sub(finalPoints[lastIndex - 1]!);
    if (endDirection.length() > EPSILON) {
      endDirection.normalize();
      finalPoints[lastIndex] = finalPoints[lastIndex]!
        .clone()
        .add(endDirection.multiplyScalar(continuationOverlapMm));
    }
  }

  // One continuous swept tube with rounded-elbow corners — no per-segment end
  // caps and no full-radius ball-joint spheres, so bends stay smooth and the
  // coincident-face z-fighting of the old cylinder chain disappears.
  const geometry = buildSweptTubeGeometry(finalPoints, radius, {
    radialSegments: options.radialSegments ?? PIPE_RADIAL_SEGMENTS,
    bendRadiusMm: options.bendRadiusMm,
    preservePlanGeometry: options.preservePlanGeometry,
    capStart: !options.openStart,
    capEnd: !options.openEnd,
  });
  if (!geometry) {
    return null;
  }

  const opacity = options.opacity ?? 1;
  const material = getSharedBoxMaterial(color, opacity, opacity < 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = options.renderOrder ?? 18;
  if (options.surfaceRole) {
    mesh.userData.pipeSurfaceRole = options.surfaceRole;
  }
  if (options.lineKind) {
    mesh.userData.pipeLineKind = options.lineKind;
    mesh.name = `refrigerant-${options.lineKind}-${options.surfaceRole ?? "tube"}`;
  }
  // Exact connection coordinates remain available to picking and diagnostics;
  // the optional join overlap is a surface treatment, never a new endpoint.
  mesh.userData.pipeRouteEndpoints = {
    start: cleaned[0]!.toArray(),
    end: cleaned[cleaned.length - 1]!.toArray(),
  };
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** CxC assembly geometry is resolved once, then shared by the copper and cover
 * surfaces. Internal tube ends reach the insertion stops and have no end disks. */
function addSocketElbowPipeAssembly(group: THREE.Group, points: THREE.Vector3[], outerRadius: number,
  coreRadius: number, options: { lineKind: 'gas' | 'liquid'; bendRadiusMm: number;
    openStart?: boolean; openEnd?: boolean; startStraightMm?: number; endStraightMm?: number; minimumBendRadiusMm?: number }): boolean {
  const route = compileCopperSocketElbowRoute(points.map(point => ({ x: point.x, y: point.y, z: point.z })),
    coreRadius * 2, { startStraightMm: options.startStraightMm, endStraightMm: options.endStraightMm,
      minimumBendRadiusMm: options.minimumBendRadiusMm });
  if (!route.fittings.length) return false;
  const vectors = (nodes: { x: number; y: number; z: number }[]) => nodes.map(node => new THREE.Vector3(node.x, node.y, node.z));
  const serviceColor = REFRIGERANT_PIPE_3D_COLORS[options.lineKind];
  const copperColor = '#c78363';
  route.insulationRuns.forEach((run, index) => {
    const insulation = createTubeAlongPoints(vectors(run), outerRadius, serviceColor, {
      renderOrder: 18, lineKind: options.lineKind, surfaceRole: 'insulation',
      bendRadiusMm: options.bendRadiusMm, preservePlanGeometry: true,
      openStart: index === 0 && options.openStart,
      openEnd: index === route.insulationRuns.length - 1 && options.openEnd,
    });
    if (insulation) group.add(insulation);
  });
  // Copper tube wall is a presentation assumption until a tube schedule supplies
  // it. The fitting's independently published wall/bore never inherits this value.
  const pipeWall = Math.min(coreRadius * 0.35, Math.max(0.6, coreRadius * 0.08));
  for (const run of route.pipeRuns) {
    for (const inside of [false, true]) {
      const geometry = buildSweptTubeGeometry(vectors(run), inside ? coreRadius - pipeWall : coreRadius, {
        radialSegments: PIPE_RADIAL_SEGMENTS, bendRadiusMm: options.bendRadiusMm,
        preservePlanGeometry: true, capStart: false, capEnd: false,
      });
      if (!geometry) continue;
      const material = new THREE.MeshStandardMaterial({ color: copperColor, roughness: 0.3, metalness: 0.75,
        side: inside ? THREE.BackSide : THREE.FrontSide });
      markMaterialOwned(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.pipeSurfaceRole = inside ? 'copper-bore' : 'copper-tube';
      mesh.userData.pipeLineKind = options.lineKind;
      mesh.userData.pipeRouteEndpoints = { start: [run[0]!.x, run[0]!.y, run[0]!.z],
        end: [run.at(-1)!.x, run.at(-1)!.y, run.at(-1)!.z] };
      group.add(mesh);
    }
  }
  for (const fitting of route.fittings) group.add(buildCopperSocketElbowMesh(fitting, {
    lineKind: options.lineKind, color: copperColor, insulationThicknessMm: Math.max(0, outerRadius - coreRadius),
    showInsulation: getActivePipeRoutingSettings().fittingDisplay === 'insulated',
  }));
  group.userData.copperElbowIssues = [...(group.userData.copperElbowIssues ?? []), ...route.issues];
  group.userData.pipeRouteEndpoints = { start: points[0]!.toArray(), end: points.at(-1)!.toArray() };
  group.userData.pipeRouteEndpointsByService = { ...group.userData.pipeRouteEndpointsByService,
    [options.lineKind]: group.userData.pipeRouteEndpoints };
  const prior = group.userData.copperElbowCounts ?? { ninety: 0, fortyFive: 0 };
  group.userData.copperElbowCounts = { ninety: prior.ninety + route.fittings.filter(fitting => fitting.spec.angleDeg === 90).length,
    fortyFive: prior.fortyFive + route.fittings.filter(fitting => fitting.spec.angleDeg === 45).length };
  return true;
}

/**
 * Shows only the copper cross-section at genuinely unconnected route ends.
 * The opaque insulation owns the full run; drawing a second coaxial tube below
 * it wastes fill-rate and can leak through when depth precision degrades.
 */
function addExposedCoreEndCaps(
  parent: THREE.Group,
  points: readonly THREE.Vector3[],
  radius: number,
  color: string,
  options: { start: boolean; end: boolean },
): void {
  if (points.length < 2 || radius <= EPSILON) return;

  const addCap = (atStart: boolean): void => {
    const endpointIndex = atStart ? 0 : points.length - 1;
    const endpoint = points[endpointIndex]!;
    let neighbor: THREE.Vector3 | null = null;
    for (
      let index = atStart ? 1 : points.length - 2;
      atStart ? index < points.length : index >= 0;
      index += atStart ? 1 : -1
    ) {
      const candidate = points[index]!;
      if (candidate.distanceTo(endpoint) > EPSILON) {
        neighbor = candidate;
        break;
      }
    }
    if (!neighbor) return;

    const outward = endpoint.clone().sub(neighbor).normalize();
    const cap = new THREE.Mesh(
      new THREE.CircleGeometry(radius, PIPE_RADIAL_SEGMENTS),
      getExposedCoreMaterial(color),
    );
    cap.name = `hvac-pipe-exposed-core-${atStart ? "start" : "end"}`;
    cap.position.copy(endpoint);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward);
    cap.renderOrder = 20;
    cap.userData.pipeSurfaceRole = "exposed-core";
    cap.userData.pipeEndpoint = atStart ? "start" : "end";
    parent.add(cap);
  };

  if (options.start) addCap(true);
  if (options.end) addCap(false);
}

interface ElevationProfileSpan {
  /** Arc-length where the rise fitting starts (base level). */
  riseStartMm: number;
  /** Arc-length where the raised level is reached. */
  riseEndMm: number;
  /** Arc-length where the return fitting starts (raised level). */
  fallStartMm: number;
  /** Arc-length where the route is back at base level. */
  fallEndMm: number;
  /** Signed vertical offset (+ above, - below). */
  riseSignedMm: number;
}

function cumulativeArcLengths(points: Point2D[]): number[] {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    lengths.push(
      lengths[index - 1]! + Math.hypot(current.x - previous.x, current.y - previous.y),
    );
  }
  return lengths;
}

/** Arc-length of the closest point on the polyline to `target`. */
function projectArcLength(
  points: Point2D[],
  lengths: number[],
  target: Point2D,
): number {
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestArcLength = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const segmentLengthSq = dx * dx + dy * dy;
    let t = 0;
    if (segmentLengthSq > 1e-9) {
      t = ((target.x - start.x) * dx + (target.y - start.y) * dy) / segmentLengthSq;
      t = Math.min(1, Math.max(0, t));
    }
    const projX = start.x + dx * t;
    const projY = start.y + dy * t;
    const distance = Math.hypot(target.x - projX, target.y - projY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestArcLength = lengths[index]! + Math.hypot(projX - start.x, projY - start.y);
    }
  }
  return bestArcLength;
}

/** Plan point at a given arc-length along the polyline. */
function pointAtArcLength(
  points: Point2D[],
  lengths: number[],
  arcLength: number,
): Point2D {
  const total = lengths[lengths.length - 1] ?? 0;
  const clamped = Math.min(total, Math.max(0, arcLength));
  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentLength = lengths[index + 1]! - lengths[index]!;
    if (clamped <= lengths[index + 1]! || index === points.length - 2) {
      const localT = segmentLength > 1e-9 ? (clamped - lengths[index]!) / segmentLength : 0;
      const start = points[index]!;
      const end = points[index + 1]!;
      return {
        x: start.x + (end.x - start.x) * localT,
        y: start.y + (end.y - start.y) * localT,
      };
    }
  }
  return points[points.length - 1]!;
}

/**
 * Builds a 3D polyline that follows the plan route but ramps up/down across each
 * bypass span, producing a real Z-type offset (rise → cross → return) using the
 * stored fitting geometry. Falls back to a flat tube when there are no bypasses.
 */
function buildElevationProfiledPoints(
  points: Point2D[],
  baseZ: number,
  centerOffset: Point2D,
  bypasses: PipeBypass[],
): THREE.Vector3[] {
  if (points.length < 2 || bypasses.length === 0) {
    return points.map((point) => new THREE.Vector3(point.x, point.y, baseZ));
  }

  const lengths = cumulativeArcLengths(points);
  const total = lengths[lengths.length - 1] ?? 0;

  const spans: ElevationProfileSpan[] = [];
  bypasses.forEach((bypass) => {
    const riseSignedMm = bypass.bypassElevationMm - bypass.baseElevationMm;
    if (Math.abs(riseSignedMm) < 0.5) {
      return;
    }
    const enterLocal = {
      x: bypass.enterPoint.x - centerOffset.x,
      y: bypass.enterPoint.y - centerOffset.y,
    };
    const exitLocal = {
      x: bypass.exitPoint.x - centerOffset.x,
      y: bypass.exitPoint.y - centerOffset.y,
    };
    let sEnter = projectArcLength(points, lengths, enterLocal);
    let sExit = projectArcLength(points, lengths, exitLocal);
    if (sEnter > sExit) {
      [sEnter, sExit] = [sExit, sEnter];
    }
    const spanLength = sExit - sEnter;
    if (spanLength < 4) {
      return;
    }
    // Keep both ramps inside the span; never let them overlap.
    const desiredRun = Math.max(
      8,
      computeFittingRunMm(Math.abs(riseSignedMm), bypass.fittingAngleDeg),
    );
    const run = Math.min(desiredRun, spanLength * 0.45);
    spans.push({
      riseStartMm: sEnter,
      riseEndMm: sEnter + run,
      fallStartMm: sExit - run,
      fallEndMm: sExit,
      riseSignedMm,
    });
  });

  if (spans.length === 0) {
    return points.map((point) => new THREE.Vector3(point.x, point.y, baseZ));
  }

  const zOffsetAt = (arcLength: number): number => {
    let offset = 0;
    spans.forEach((span) => {
      if (arcLength <= span.riseStartMm || arcLength >= span.fallEndMm) {
        return;
      }
      let factor: number;
      if (arcLength < span.riseEndMm) {
        factor = (arcLength - span.riseStartMm) / Math.max(1e-6, span.riseEndMm - span.riseStartMm);
      } else if (arcLength <= span.fallStartMm) {
        factor = 1;
      } else {
        factor = (span.fallEndMm - arcLength) / Math.max(1e-6, span.fallEndMm - span.fallStartMm);
      }
      const value = factor * span.riseSignedMm;
      if (Math.abs(value) > Math.abs(offset)) {
        offset = value;
      }
    });
    return offset;
  };

  // Sample at every original vertex plus each span breakpoint, so the ramp
  // corners (fittings) are represented exactly.
  const sampleSet = new Set<number>(lengths);
  spans.forEach((span) => {
    [span.riseStartMm, span.riseEndMm, span.fallStartMm, span.fallEndMm].forEach((value) => {
      sampleSet.add(Math.min(total, Math.max(0, value)));
    });
  });
  const samples = Array.from(sampleSet).sort((a, b) => a - b);

  const result: THREE.Vector3[] = [];
  let previousArcLength = Number.NEGATIVE_INFINITY;
  samples.forEach((arcLength) => {
    if (arcLength - previousArcLength < 0.25) {
      return;
    }
    previousArcLength = arcLength;
    const planPoint = pointAtArcLength(points, lengths, arcLength);
    result.push(new THREE.Vector3(planPoint.x, planPoint.y, baseZ + zOffsetAt(arcLength)));
  });
  return result;
}

function hvacPaletteForElement(element: HvacElement): Hvac3DPalette {
  switch (element.type) {
    case "outdoor-unit":
      return {
        body: "#8ea0ad",
        trim: "#d7e0e7",
        grille: "#1f2937",
        metal: "#64748b",
        accent: "#0f766e",
        label: "#134e4a",
      };
    case "duct":
    case "refrigerant-branch-kit":
      return {
        body: "#eef2f4",
        trim: "#dbe3e8",
        grille: "#64748b",
        metal: "#94a3b8",
        accent: "#475569",
        label: "#334155",
      };
    case "filter":
    case "diffuser":
    case "return-grille":
      return {
        body: "#f8fafc",
        trim: "#cbd5e1",
        grille: "#64748b",
        metal: "#94a3b8",
        accent: "#0ea5e9",
        label: "#0369a1",
      };
    case "remote-controller":
    case "control-panel":
      return {
        body: "#f8fafc",
        trim: "#d1d5db",
        grille: "#111827",
        metal: "#9ca3af",
        accent: "#2563eb",
        label: "#1d4ed8",
      };
    case "accessory":
      return {
        body: "#f5f3ff",
        trim: "#ddd6fe",
        grille: "#7c3aed",
        metal: "#a78bfa",
        accent: "#6d28d9",
        label: "#5b21b6",
      };
    default:
      return {
        body: "#dbe5ee",
        trim: "#f8fafc",
        grille: "#1f2937",
        metal: "#94a3b8",
        accent: "#2563eb",
        label: "#1d4ed8",
      };
  }
}

function resolveMinimumProjectionHeight(type: HvacElement["type"]): number {
  switch (type) {
    case "refrigerant-pipe":
    case "refrigerant-pipe-pair":
    case "condensate-pipe":
    case "condensate-gully":
      return 10;
    case "diffuser":
    case "return-grille":
      return 24;
    case "filter":
    case "refrigerant-branch-kit":
      return 35;
    case "remote-controller":
    case "control-panel":
    case "accessory":
    case "duct":
      return 40;
    case "outdoor-unit":
    case "ducted-ac":
      return 120;
    default:
      return 80;
  }
}

function addVentSlats(
  group: THREE.Group,
  options: {
    count: number;
    width: number;
    depth: number;
    height: number;
    startX?: number;
    startY?: number;
    startZ?: number;
    stepX?: number;
    stepY?: number;
    stepZ?: number;
    color: string;
    rotation?: THREE.Euler;
  },
): void {
  const {
    count,
    width,
    depth,
    height,
    startX = 0,
    startY = 0,
    startZ = 0,
    stepX = 0,
    stepY = 0,
    stepZ = 0,
    color,
    rotation,
  } = options;

  for (let index = 0; index < count; index += 1) {
    const slat = createLocalBoxMesh(
      width,
      depth,
      height,
      color,
      new THREE.Vector3(
        startX + stepX * index,
        startY + stepY * index,
        startZ + stepZ * index,
      ),
      { renderOrder: 19 },
    );
    if (rotation) {
      slat.rotation.copy(rotation);
    }
    group.add(slat);
  }
}

function addHvacPipePort(
  group: THREE.Group,
  options: {
    anchor: THREE.Vector3;
    radius: number;
    length: number;
    color: string;
    direction?: 1 | -1;
    collarColor?: string;
    collarRadius?: number;
    collarLength?: number;
    flangeColor?: string;
    flangeThickness?: number;
    radialSegments?: number;
  },
): void {
  const direction = options.direction ?? 1;
  const collarRadius = options.collarRadius ?? options.radius * 1.24;
  const collarLength =
    options.collarLength ?? Math.max(10, options.length * 0.28);
  const flangeThickness =
    options.flangeThickness ?? Math.max(4, collarLength * 0.24);
  const radialSegments = options.radialSegments ?? 18;
  const rotation = new THREE.Euler(0, 0, Math.PI / 2);

  group.add(
    createLocalCylinderMesh(
      collarRadius * 1.12,
      collarRadius * 1.12,
      flangeThickness,
      options.flangeColor ?? "#d7dde2",
      new THREE.Vector3(
        options.anchor.x + direction * (flangeThickness / 2),
        options.anchor.y,
        options.anchor.z,
      ),
      { rotation, radialSegments },
    ),
  );
  group.add(
    createLocalCylinderMesh(
      collarRadius,
      collarRadius,
      collarLength,
      options.collarColor ?? "#1f2937",
      new THREE.Vector3(
        options.anchor.x + direction * (collarLength / 2 + flangeThickness * 0.35),
        options.anchor.y,
        options.anchor.z,
      ),
      { rotation, radialSegments },
    ),
  );
  group.add(
    createLocalCylinderMesh(
      options.radius,
      options.radius,
      options.length,
      options.color,
      new THREE.Vector3(
        options.anchor.x +
          direction * (collarLength + options.length / 2 - flangeThickness * 0.15),
        options.anchor.y,
        options.anchor.z,
      ),
      { rotation, radialSegments },
    ),
  );
}

function addLocalMeshOutline(
  group: THREE.Group,
  mesh: THREE.Mesh,
  name: string,
  options?: {
    color?: string;
    opacity?: number;
    renderOrder?: number;
    thresholdAngleDeg?: number;
  },
): void {
  const material = markMaterialOwned(
    new THREE.LineBasicMaterial({
      color: options?.color ?? "#52606d",
      transparent: true,
      opacity: options?.opacity ?? 0.72,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  ) as THREE.LineBasicMaterial;
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry, options?.thresholdAngleDeg ?? 28),
    material,
  );
  outline.name = `${name}-outline`;
  outline.position.copy(mesh.position);
  outline.rotation.copy(mesh.rotation);
  outline.quaternion.copy(mesh.quaternion);
  outline.scale.copy(mesh.scale);
  outline.renderOrder = options?.renderOrder ?? 42;
  outline.frustumCulled = false;
  outline.userData.hvacEquipmentVisibilityOverlay = true;
  group.add(outline);
}

function addNamedCassettePart(
  group: THREE.Group,
  name: string,
  mesh: THREE.Mesh,
  options?: {
    outline?: boolean;
    outlineColor?: string;
    outlineOpacity?: number;
    outlineRenderOrder?: number;
  },
): THREE.Mesh {
  mesh.name = name;
  mesh.userData.hvacEquipmentVisibilityOverlay = true;
  group.add(mesh);
  if (options?.outline) {
    addLocalMeshOutline(group, mesh, name, {
      color: options.outlineColor,
      opacity: options.outlineOpacity,
      renderOrder: options.outlineRenderOrder,
    });
  }
  return mesh;
}

function addCeilingCassetteVisibleModel(
  group: THREE.Group,
  element: HvacElement,
  options?: { catalogModelLoaded?: boolean },
): void {
  const cassette = buildCeilingCassetteModel(element);
  const hasCatalogModel = options?.catalogModelLoaded === true;
  const bodyOpacity = hasCatalogModel ? 0.5 : 1;
  const topOpacity = hasCatalogModel ? 0.62 : 1;
  const panelLift = hasCatalogModel ? 1.6 : 0;
  const detailLift = hasCatalogModel ? 2.4 : 0;

  addNamedCassettePart(
    group,
    "ceiling-cassette-hidden-body",
    createRoundedLocalExtrudedMesh(
      cassette.hiddenBody.width,
      cassette.hiddenBody.depth,
      cassette.hiddenBody.height,
      cassette.hiddenBody.cornerRadius,
      hasCatalogModel ? "#aab6c2" : "#94a3b8",
      new THREE.Vector3(
        cassette.hiddenBody.x,
        cassette.hiddenBody.y,
        cassette.hiddenBody.z,
      ),
      { opacity: bodyOpacity, renderOrder: hasCatalogModel ? 24 : 18 },
    ),
    {
      outline: true,
      outlineColor: "#40505f",
      outlineOpacity: hasCatalogModel ? 0.62 : 0.48,
    },
  );

  addNamedCassettePart(
    group,
    "ceiling-cassette-top-cap",
    createRoundedLocalExtrudedMesh(
      cassette.topCap.width,
      cassette.topCap.depth,
      cassette.topCap.height,
      cassette.topCap.cornerRadius,
      "#a8b3bd",
      new THREE.Vector3(cassette.topCap.x, cassette.topCap.y, cassette.topCap.z),
      { opacity: topOpacity, renderOrder: hasCatalogModel ? 24 : 18 },
    ),
  );

  addNamedCassettePart(
    group,
    "ceiling-cassette-drain-pump-housing",
    createRoundedLocalExtrudedMesh(
      cassette.drainPumpHousing.width,
      cassette.drainPumpHousing.depth,
      cassette.drainPumpHousing.height,
      cassette.drainPumpHousing.cornerRadius,
      "#8a949d",
      new THREE.Vector3(
        cassette.drainPumpHousing.x,
        cassette.drainPumpHousing.y,
        cassette.drainPumpHousing.z,
      ),
      {
        bevelEnabled: false,
        curveSegments: 8,
        opacity: topOpacity,
        renderOrder: hasCatalogModel ? 25 : 18,
      },
    ),
  );

  addNamedCassettePart(
    group,
    "ceiling-cassette-face-panel",
    createRoundedLocalExtrudedMesh(
      cassette.facePanel.width,
      cassette.facePanel.depth,
      cassette.facePanel.height,
      cassette.facePanel.cornerRadius,
      "#fbfcfd",
      new THREE.Vector3(
        cassette.facePanel.x,
        cassette.facePanel.y,
        cassette.facePanel.z + panelLift,
      ),
      {
        bevelThickness: cassette.facePanel.bevelThickness,
        bevelSize: cassette.facePanel.bevelSize,
        bevelSegments: 4,
        renderOrder: 28,
      },
    ),
    {
      outline: true,
      outlineColor: "#52606d",
      outlineOpacity: 0.76,
      outlineRenderOrder: 44,
    },
  );

  addNamedCassettePart(
    group,
    "ceiling-cassette-inner-panel",
    createRoundedLocalExtrudedMesh(
      cassette.innerPanel.width,
      cassette.innerPanel.depth,
      cassette.innerPanel.height,
      cassette.innerPanel.cornerRadius,
      "#eef3f7",
      new THREE.Vector3(
        cassette.innerPanel.x,
        cassette.innerPanel.y,
        cassette.innerPanel.z + detailLift,
      ),
      {
        bevelThickness: cassette.innerPanel.bevelThickness,
        bevelSize: cassette.innerPanel.bevelSize,
        bevelSegments: 4,
        renderOrder: 29,
      },
    ),
  );

  cassette.slots.forEach((slot, index) => {
    addNamedCassettePart(
      group,
      `ceiling-cassette-discharge-slot-${index + 1}`,
      createRoundedLocalExtrudedMesh(
        slot.width,
        slot.depth,
        slot.height,
        slot.cornerRadius,
        "#1a2030",
        new THREE.Vector3(slot.x, slot.y, slot.z + detailLift),
        { renderOrder: 30, bevelEnabled: false, curveSegments: 8 },
      ),
    );
  });

  cassette.vanes.forEach((vane, index) => {
    addNamedCassettePart(
      group,
      `ceiling-cassette-discharge-vane-${index + 1}`,
      createLocalBoxMesh(
        vane.width,
        vane.depth,
        vane.height,
        "#d0d8e0",
        new THREE.Vector3(vane.x, vane.y, vane.z + detailLift),
        { renderOrder: 31 },
      ),
    );
  });

  addNamedCassettePart(
    group,
    "ceiling-cassette-return-grille-frame",
    createRoundedLocalExtrudedMesh(
      cassette.grille.size,
      cassette.grille.size,
      cassette.grille.frameHeight,
      cassette.grille.cornerRadius,
      "#cdd5dc",
      new THREE.Vector3(
        cassette.grille.x,
        cassette.grille.y,
        cassette.grille.z + detailLift,
      ),
      { bevelEnabled: false, renderOrder: 30 },
    ),
  );

  addVentSlats(group, {
    count: cassette.grille.slatCount,
    width: cassette.grille.slatSpan,
    depth: 1.5,
    height: 1.5,
    startX: 0,
    startY: -cassette.grille.slatInset,
    startZ: cassette.grille.horizontalSlatZ + detailLift,
    stepY: cassette.grille.slatStep,
    color: "#8a97a4",
  });
  addVentSlats(group, {
    count: cassette.grille.slatCount,
    width: 1.5,
    depth: cassette.grille.slatSpan,
    height: 1.5,
    startX: -cassette.grille.slatInset,
    startY: 0,
    startZ: cassette.grille.verticalSlatZ + detailLift,
    stepX: cassette.grille.slatStep,
    color: "#96a3af",
  });

  addNamedCassettePart(
    group,
    "ceiling-cassette-accent-bar",
    createLocalBoxMesh(
      cassette.accentBar.width,
      cassette.accentBar.depth,
      cassette.accentBar.height,
      hvacPaletteForElement(element).accent,
      new THREE.Vector3(
        cassette.accentBar.x,
        cassette.accentBar.y,
        cassette.accentBar.z + detailLift,
      ),
      { renderOrder: 31 },
    ),
  );

  addNamedCassettePart(
    group,
    "ceiling-cassette-service-tab",
    createLocalBoxMesh(
      cassette.serviceTab.width,
      cassette.serviceTab.depth,
      cassette.serviceTab.height,
      "#eef3f7",
      new THREE.Vector3(
        cassette.serviceTab.x,
        cassette.serviceTab.y,
        cassette.serviceTab.z + detailLift,
      ),
      { renderOrder: 31 },
    ),
  );

  addNamedCassettePart(
    group,
    "ceiling-cassette-connection-pod",
    createRoundedLocalExtrudedMesh(
      cassette.connectionPod.width,
      cassette.connectionPod.depth,
      cassette.connectionPod.height,
      cassette.connectionPod.cornerRadius,
      "#2d353d",
      new THREE.Vector3(
        cassette.connectionPod.x,
        cassette.connectionPod.y,
        cassette.connectionPod.z,
      ),
      {
        bevelEnabled: false,
        curveSegments: 8,
        opacity: hasCatalogModel ? 0.86 : 1,
        renderOrder: 31,
      },
    ),
  );

  cassette.pipePorts.forEach((port) => {
    const portGroup = new THREE.Group();
    portGroup.name = `ceiling-cassette-${port.kind}-port`;
    portGroup.userData.hvacEquipmentVisibilityOverlay = true;
    addHvacPipePort(portGroup, {
      anchor: new THREE.Vector3(port.x, port.y, port.z),
      radius: port.radius,
      length: port.length,
      color: port.color,
      collarColor: port.collarColor,
      collarRadius: port.collarRadius,
      collarLength: port.collarLength,
      flangeColor: port.flangeColor,
      flangeThickness: port.flangeThickness,
    });
    addNamedCassettePart(
      portGroup,
      `ceiling-cassette-${port.kind}-port-band`,
      createLocalCylinderMesh(
        port.bandRadius,
        port.bandRadius,
        3,
        port.bandColor,
        new THREE.Vector3(port.x + port.bandOffsetX, port.y, port.z),
        {
          rotation: new THREE.Euler(0, 0, Math.PI / 2),
          radialSegments: 16,
          renderOrder: 33,
        },
      ),
    );
    group.add(portGroup);
  });
}

function addGenericUnitPipePorts(
  group: THREE.Group,
  element: HvacElement,
): void {
  const portSpec = getUnitPipePortSpec(element);
  if (!portSpec) {
    return;
  }

  portSpec.ports.forEach((port) => {
    addHvacPipePort(group, {
      anchor: new THREE.Vector3(port.localX, port.localY, port.localZ),
      radius: port.radius,
      length: port.length,
      color: port.color,
      collarColor: "#1f2937",
      collarRadius: port.collarRadius,
      collarLength: port.collarLength,
      flangeColor: "#d7dde2",
      flangeThickness: port.flangeThickness,
    });
  });
}

function addFrontFaceFan(
  group: THREE.Group,
  options: {
    center: THREE.Vector3;
    radius: number;
    ringColor: string;
    grilleColor: string;
    bladeColor: string;
  },
): void {
  const faceRotation = new THREE.Euler(Math.PI / 2, 0, 0);
  group.add(
    createLocalCylinderMesh(
      options.radius * 0.86,
      options.radius * 0.86,
      Math.max(8, options.radius * 0.12),
      options.grilleColor,
      options.center,
      { radialSegments: 42, opacity: 0.9, renderOrder: 20 },
    ),
  );
  group.add(
    createLocalTorusMesh(
      options.radius,
      Math.max(4, options.radius * 0.055),
      options.ringColor,
      new THREE.Vector3(
        options.center.x,
        options.center.y + Math.max(5, options.radius * 0.08),
        options.center.z,
      ),
      { rotation: faceRotation, renderOrder: 21 },
    ),
  );

  for (let index = 0; index < 4; index += 1) {
    const blade = createLocalBoxMesh(
      options.radius * 0.72,
      Math.max(4, options.radius * 0.055),
      Math.max(6, options.radius * 0.16),
      options.bladeColor,
      new THREE.Vector3(
        options.center.x,
        options.center.y + Math.max(8, options.radius * 0.1),
        options.center.z,
      ),
      { renderOrder: 22 },
    );
    blade.rotation.y = (index * Math.PI) / 2 + Math.PI / 10;
    group.add(blade);
  }
}

function addFrontLouverBank(
  group: THREE.Group,
  options: {
    count: number;
    width: number;
    y: number;
    z: number;
    stepZ: number;
    color: string;
  },
): void {
  for (let index = 0; index < options.count; index += 1) {
    const louver = createLocalBoxMesh(
      options.width,
      5,
      4,
      options.color,
      new THREE.Vector3(0, options.y, options.z + options.stepZ * index),
      { renderOrder: 21 },
    );
    louver.rotation.x = THREE.MathUtils.degToRad(-12);
    group.add(louver);
  }
}

function addDuctCollar(
  group: THREE.Group,
  options: {
    x: number;
    outerWidthMm: number;
    outerHeightMm: number;
    color: string;
    bandLengthMm: number;
    bandThicknessMm: number;
  },
): void {
  const halfWidth = options.outerWidthMm / 2;
  const halfHeight = options.outerHeightMm / 2;
  const thickness = Math.max(5, options.bandThicknessMm);
  const bandLength = Math.max(6, options.bandLengthMm);
  group.add(
    createLocalBoxMesh(
      bandLength,
      options.outerWidthMm + thickness * 1.2,
      thickness,
      options.color,
      new THREE.Vector3(options.x, 0, options.outerHeightMm + thickness / 2),
      { renderOrder: 21 },
    ),
  );
  group.add(
    createLocalBoxMesh(
      bandLength,
      thickness,
      options.outerHeightMm + thickness * 1.2,
      options.color,
      new THREE.Vector3(options.x, -halfWidth - thickness / 2, halfHeight),
      { renderOrder: 21 },
    ),
  );
  group.add(
    createLocalBoxMesh(
      bandLength,
      thickness,
      options.outerHeightMm + thickness * 1.2,
      options.color,
      new THREE.Vector3(options.x, halfWidth + thickness / 2, halfHeight),
      { renderOrder: 21 },
    ),
  );
}

function addDuctEdgeBands(
  group: THREE.Group,
  options: {
    lengthMm: number;
    outerWidthMm: number;
    outerHeightMm: number;
    edgeColor: string;
    accentColor: string;
  },
): void {
  const halfWidth = options.outerWidthMm / 2;
  const edgeThickness = Math.max(7, Math.min(18, options.outerWidthMm * 0.04));
  const edgeHeight = Math.max(4, edgeThickness * 0.45);
  [-1, 1].forEach((side) => {
    group.add(
      createLocalBoxMesh(
        options.lengthMm,
        edgeThickness,
        edgeHeight,
        options.edgeColor,
        new THREE.Vector3(
          0,
          side * (halfWidth - edgeThickness / 2),
          options.outerHeightMm + edgeHeight / 2,
        ),
        { renderOrder: 22 },
      ),
    );
  });
  group.add(
    createLocalBoxMesh(
      options.lengthMm,
      edgeThickness * 0.72,
      Math.max(7, edgeThickness * 0.7),
      options.accentColor,
      new THREE.Vector3(
        0,
        halfWidth + edgeThickness * 0.12,
        options.outerHeightMm * 0.42,
      ),
      { renderOrder: 22 },
    ),
  );
}

function normalizePoint(value: unknown): Point2D | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("x" in value) ||
    !("y" in value)
  ) {
    return null;
  }
  const candidate = value as { x?: unknown; y?: unknown };
  if (
    typeof candidate.x !== "number" ||
    !Number.isFinite(candidate.x) ||
    typeof candidate.y !== "number" ||
    !Number.isFinite(candidate.y)
  ) {
    return null;
  }
  return { x: candidate.x, y: candidate.y };
}

function rotatePoint2D(point: Point2D, angleDeg: number): Point2D {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function normalizeDirection(point: Point2D): Point2D {
  const length = Math.hypot(point.x, point.y);
  if (length < 0.0001) {
    return { x: 1, y: 0 };
  }
  return { x: point.x / length, y: point.y / length };
}

function addPoints(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtractPoints(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scalePoint(point: Point2D, factor: number): Point2D {
  return { x: point.x * factor, y: point.y * factor };
}

function dotProduct(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function normalizeAngleDeg(value: number): number {
  let normalized = value % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return normalized;
}

function smallestAngleDifferenceDeg(a: number, b: number): number {
  const diff = Math.abs(normalizeAngleDeg(a) - normalizeAngleDeg(b));
  return Math.min(diff, 360 - diff);
}

function resolveInlineBranchKitRenderCenter(
  element: Pick<HvacElement, "type" | "subtype" | "modelLabel" | "properties" | "rotation">,
  elevationMm: number,
  pipeTargets: VisibleRefrigerantPipeSegmentTarget[],
  allElements: HvacElement[],
): { center: Point2D; elevationMm: number; rotationDeg: number } | null {
  if (
    !isRefrigerantBranchKitElement(element) ||
    element.properties.branchKitPlacementMode !== "inline-pipe-run"
  ) {
    return null;
  }

  const anchorPoint = normalizePoint(element.properties.branchKitSnapPoint);
  if (!anchorPoint) {
    return null;
  }

  let resolvedAnchorPoint: Point2D = anchorPoint;
  const model = buildRefrigerantBranchKitViewModel(element);
  const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
  const anchorLine = lineSelection === "liquid" ? model.liquid : model.gas;
  let resolvedAnchorElevationMm = elevationMm + anchorLine.centerlineZMm;

  const snapSegmentStart = normalizePoint(element.properties.branchKitSnapSegmentStart);
  const snapSegmentEnd = normalizePoint(element.properties.branchKitSnapSegmentEnd);
  const snapProjectedDistanceMm =
    typeof element.properties.branchKitSnapProjectedDistanceMm === "number" &&
    Number.isFinite(element.properties.branchKitSnapProjectedDistanceMm)
      ? element.properties.branchKitSnapProjectedDistanceMm
      : null;

  if (snapSegmentStart && snapSegmentEnd) {
    const segmentDelta = subtractPoints(snapSegmentEnd, snapSegmentStart);
    const segmentLengthMm = Math.hypot(segmentDelta.x, segmentDelta.y);
    if (segmentLengthMm > 0.2) {
      const segmentDirection = {
        x: segmentDelta.x / segmentLengthMm,
        y: segmentDelta.y / segmentLengthMm,
      };
      const projectedMm =
        snapProjectedDistanceMm !== null
          ? Math.min(segmentLengthMm, Math.max(0, snapProjectedDistanceMm))
          : Math.min(
              segmentLengthMm,
              Math.max(
                0,
                dotProduct(subtractPoints(anchorPoint, snapSegmentStart), segmentDirection),
              ),
            );
      resolvedAnchorPoint = addPoints(
        snapSegmentStart,
        scalePoint(segmentDirection, projectedMm),
      );
    }
  }

  const desiredLineKind = lineSelection === "liquid" ? "liquid" : "gas";
  const sourceElementId =
    typeof element.properties.branchKitSnapSourceElementId === "string"
      ? element.properties.branchKitSnapSourceElementId
      : null;
  const snapDirection = normalizeDirection(
    normalizePoint(element.properties.branchKitSnapDirection) ?? { x: 1, y: 0 },
  );
  let resolvedAxisDirection = snapDirection;

  const modelProjectionElements = (() => {
    if (!sourceElementId) {
      return allElements;
    }
    const matches = allElements.filter((candidate) => candidate.id === sourceElementId);
    return matches.length > 0 ? matches : allElements;
  })();
  const modelProjection =
    modelProjectionElements.length > 0
      ? findNearestRefrigerantPipeBundleSegmentTarget(
          modelProjectionElements,
          resolvedAnchorPoint,
          sourceElementId ? 120 : 64,
          { minSegmentLengthMm: 30 },
        )
      : null;

  if (modelProjection) {
    resolvedAnchorPoint =
      desiredLineKind === "liquid" ? modelProjection.liquidPoint : modelProjection.gasPoint;
    resolvedAnchorElevationMm =
      desiredLineKind === "liquid"
        ? modelProjection.liquidElevationMm
        : modelProjection.gasElevationMm;
    resolvedAxisDirection =
      dotProduct(modelProjection.direction, snapDirection) >= 0
        ? modelProjection.direction
        : scalePoint(modelProjection.direction, -1);
  }

  const matchingTargets = pipeTargets.filter(
    (target) =>
      target.lineKind === desiredLineKind &&
      (!sourceElementId ||
        target.elementId === sourceElementId ||
        target.bundleId === sourceElementId),
  );
  const fallbackTargets = sourceElementId
    ? pipeTargets.filter((target) => target.lineKind === desiredLineKind)
    : matchingTargets;
  const targets = matchingTargets.length > 0 ? matchingTargets : fallbackTargets;

  if (!modelProjection && targets.length > 0) {
    let bestPoint: Point2D | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestElevationMm: number | null = null;
    let bestDirection: Point2D | null = null;
    for (const target of targets) {
      const segmentDx = target.end.x - target.start.x;
      const segmentDy = target.end.y - target.start.y;
      const segmentLength = Math.hypot(segmentDx, segmentDy);
      if (segmentLength <= 0.2) {
        continue;
      }
      const direction = { x: segmentDx / segmentLength, y: segmentDy / segmentLength };
      const projectedMm = Math.min(
        segmentLength,
        Math.max(0, dotProduct(subtractPoints(resolvedAnchorPoint, target.start), direction)),
      );
      const projectedPoint = addPoints(target.start, scalePoint(direction, projectedMm));
      const distanceMm = Math.hypot(
        projectedPoint.x - resolvedAnchorPoint.x,
        projectedPoint.y - resolvedAnchorPoint.y,
      );
      const directionPenalty = (1 - Math.abs(dotProduct(direction, snapDirection))) * 36;
      const score = distanceMm + directionPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestPoint = projectedPoint;
        bestElevationMm = target.elevationMm;
        bestDirection =
          dotProduct(direction, snapDirection) >= 0
            ? direction
            : scalePoint(direction, -1);
      }
    }
    const maxReprojectScoreMm = sourceElementId ? 60 : 24;
    if (bestPoint && bestScore <= maxReprojectScoreMm) {
      resolvedAnchorPoint = bestPoint;
      if (bestElevationMm !== null) {
        resolvedAnchorElevationMm = bestElevationMm;
      }
      if (bestDirection) {
        resolvedAxisDirection = bestDirection;
      }
    }
  }

  const canonicalAnchorLocal = resolveRefrigerantBranchKitInlineAnchorLocal(model, lineSelection);
  const storedAnchorLocal = normalizePoint(element.properties.branchKitSnapAnchorLocal);
  const anchorLocal = (() => {
    if (!storedAnchorLocal) {
      return canonicalAnchorLocal;
    }
    const driftMm = Math.hypot(
      storedAnchorLocal.x - canonicalAnchorLocal.x,
      storedAnchorLocal.y - canonicalAnchorLocal.y,
    );
    return driftMm <= 1 ? storedAnchorLocal : canonicalAnchorLocal;
  })();

  const fallbackRotationDeg = element.rotation ?? 0;
  const axisAngleDeg = normalizeAngleDeg(
    (Math.atan2(resolvedAxisDirection.y, resolvedAxisDirection.x) * 180) / Math.PI,
  );
  const candidateRotationA = axisAngleDeg;
  const candidateRotationB = normalizeAngleDeg(axisAngleDeg + 180);
  const rotationDeg =
    smallestAngleDifferenceDeg(candidateRotationA, fallbackRotationDeg) <=
    smallestAngleDifferenceDeg(candidateRotationB, fallbackRotationDeg)
      ? candidateRotationA
      : candidateRotationB;
  const rotatedAnchor = rotatePoint2D(anchorLocal, rotationDeg);

  // Override the XY center + rotation with the single inline-center source of
  // truth (no live re-snap) so the kit body lands exactly on its connection
  // center, matching 2D + the snap targets. The local logic above is kept only
  // to align the kit's elevation to the run it sits on (`resolvedAnchorElevationMm`).
  const inline = resolveInlineBranchKitCenter(element, lineSelection, model);
  return {
    center: inline
      ? inline.center
      : {
          x: resolvedAnchorPoint.x - rotatedAnchor.x,
          y: resolvedAnchorPoint.y - rotatedAnchor.y,
        },
    elevationMm: resolvedAnchorElevationMm - anchorLine.centerlineZMm,
    rotationDeg: inline ? inline.rotationDeg : rotationDeg,
  };
}

function buildLabelAnchor(
  element: HvacElement,
  mesh: THREE.Object3D,
): HvacProjectionLabelAnchor | null {
  const isPipe =
    element.type === "refrigerant-pipe" ||
    element.type === "refrigerant-pipe-pair" ||
    element.type === "duct";
  if (isPipe) {
    return null;
  }

  const bounds = new THREE.Box3().setFromObject(mesh);
  if (bounds.isEmpty()) {
    return null;
  }

  return {
    key: `hvac-${element.id}`,
    position: new THREE.Vector3(
      (bounds.min.x + bounds.max.x) / 2,
      (bounds.min.y + bounds.max.y) / 2,
      bounds.max.z + 40,
    ),
    text: element.label || element.type,
    color: hvacPaletteForElement(element).label,
  };
}

export function buildHvacElementMesh(
  element: HvacElement,
  context: HvacBuildSceneContext,
): THREE.Group | null {
  const normalizedType =
    element.type === "accessory" && isRefrigerantBranchKitElement(element)
      ? "refrigerant-branch-kit"
      : element.type;

  // Real catalog model (GLB, converted from the manufacturer IFC) takes
  // precedence over the procedural geometry when its model has finished loading.
  // Until then we fall through to the procedural placeholder; the projection
  // layer rebuilds the scene once the load settles.
  const modelUrl =
    typeof element.properties?.modelUrl === "string" && element.properties.modelUrl
      ? element.properties.modelUrl
      : null;
  if (modelUrl) {
    const model = instantiateGlbModel(modelUrl);
    if (model) {
      const group = new THREE.Group();
      group.name = `hvac-${element.id}`;
      group.userData.hvacElementId = element.id;
      group.userData.hvacElementType = element.type;
      // Anchor at the UNCLAMPED element centre — the exact point every 2D
      // consumer (plan renderer, hit testing, overlays) uses. Size clamps are
      // for geometry only; putting them in the anchor shifts sub-60 mm
      // elements the moment the 3D view fades in.
      group.position.set(
        element.position.x + element.width / 2,
        element.position.y + element.depth / 2,
        element.elevation,
      );
      group.rotation.z = THREE.MathUtils.degToRad(element.rotation);
      group.add(model);
      if (element.type === "ceiling-cassette-ac") {
        addCeilingCassetteVisibleModel(group, element, {
          catalogModelLoaded: true,
        });
      }
      return group;
    }
  }

  if (!isProjectionCoreHvacType(normalizedType)) {
    return null;
  }

  const effectiveElement =
    normalizedType === element.type ? element : { ...element, type: normalizedType };
  const width = Math.max(60, effectiveElement.width);
  const depth = Math.max(60, effectiveElement.depth);
  const height = Math.max(
    resolveMinimumProjectionHeight(normalizedType),
    effectiveElement.height,
  );
  const palette = hvacPaletteForElement(effectiveElement);
  const group = new THREE.Group();
  const inlinePlacement = resolveInlineBranchKitRenderCenter(
    effectiveElement,
    effectiveElement.elevation,
    context.pipeTargets ?? [],
    context.allElements,
  );
  const renderCenter =
    inlinePlacement?.center ?? {
      // Unclamped centre — must match the 2D consumers exactly, or elements
      // narrower/shallower than the 60 mm geometry clamp render offset in 3D.
      x: effectiveElement.position.x + effectiveElement.width / 2,
      y: effectiveElement.position.y + effectiveElement.depth / 2,
    };
  const renderBaseElevationMm = inlinePlacement?.elevationMm ?? effectiveElement.elevation;

  group.position.set(
    renderCenter.x,
    renderCenter.y,
    renderBaseElevationMm,
  );
  group.rotation.z = THREE.MathUtils.degToRad(
    inlinePlacement?.rotationDeg ?? effectiveElement.rotation,
  );
  group.name = `hvac-${effectiveElement.id}`;
  group.userData.hvacElementId = effectiveElement.id;
  group.userData.hvacElementType = effectiveElement.type;

  switch (normalizedType) {
    case "wall-mounted-ac":
    case "split-ac": {
      const mainHeight = Math.max(160, height);
      const shellDepth = Math.max(90, depth * 0.78);
      const shellRadius = Math.min(width, shellDepth) * 0.08;
      group.add(
        createRoundedLocalExtrudedMesh(
          width * 0.98,
          shellDepth,
          mainHeight,
          shellRadius,
          palette.body,
          new THREE.Vector3(0, 0, mainHeight / 2),
          {
            bevelSize: Math.min(10, shellRadius * 0.28),
            bevelThickness: Math.min(8, mainHeight * 0.05),
            bevelSegments: 4,
          },
        ),
      );
      group.add(
        createRoundedLocalExtrudedMesh(
          width * 0.86,
          Math.max(8, shellDepth * 0.06),
          mainHeight * 0.34,
          Math.min(10, shellRadius * 0.55),
          palette.trim,
          new THREE.Vector3(0, shellDepth * 0.43, mainHeight * 0.6),
          { bevelEnabled: false, renderOrder: 19 },
        ),
      );
      group.add(
        createRoundedLocalExtrudedMesh(
          width * 0.82,
          Math.max(8, shellDepth * 0.08),
          Math.max(18, mainHeight * 0.08),
          Math.min(8, shellRadius * 0.45),
          "#cbd5e1",
          new THREE.Vector3(0, shellDepth * 0.42, mainHeight * 0.18),
          { bevelEnabled: false, renderOrder: 20 },
        ),
      );
      addFrontLouverBank(group, {
        count: 5,
        width: width * 0.72,
        y: shellDepth * 0.47,
        z: mainHeight * 0.18,
        stepZ: mainHeight * 0.055,
        color: palette.grille,
      });
      group.add(
        createLocalBoxMesh(
          width * 0.72,
          Math.max(5, shellDepth * 0.035),
          Math.max(6, mainHeight * 0.035),
          palette.accent,
          new THREE.Vector3(0, shellDepth * 0.46, mainHeight * 0.86),
          { renderOrder: 20 },
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.08,
          shellDepth * 0.72,
          Math.max(18, mainHeight * 0.28),
          "#cbd5e1",
          new THREE.Vector3(width * 0.43, -shellDepth * 0.02, mainHeight * 0.58),
          { renderOrder: 19 },
        ),
      );
      addGenericUnitPipePorts(group, effectiveElement);
      break;
    }
    case "ceiling-suspended-ac": {
      const mainHeight = Math.max(180, height);
      const shellDepth = Math.max(180, depth * 0.92);
      const shellRadius = Math.min(width, shellDepth) * 0.045;
      group.add(
        createRoundedLocalExtrudedMesh(
          width,
          shellDepth,
          mainHeight,
          shellRadius,
          palette.body,
          new THREE.Vector3(0, 0, mainHeight / 2),
          {
            bevelSize: Math.min(12, shellRadius * 0.3),
            bevelThickness: Math.min(9, mainHeight * 0.05),
          },
        ),
      );
      group.add(
        createRoundedLocalExtrudedMesh(
          width * 0.9,
          Math.max(18, shellDepth * 0.1),
          Math.max(34, mainHeight * 0.2),
          Math.min(8, shellRadius * 0.45),
          palette.trim,
          new THREE.Vector3(0, shellDepth * 0.43, mainHeight * 0.28),
          { bevelEnabled: false, renderOrder: 19 },
        ),
      );
      addVentSlats(group, {
        count: 6,
        width: width * 0.1,
        depth: 5,
        height: 10,
        startX: -width * 0.3,
        startY: shellDepth * 0.49,
        startZ: mainHeight * 0.27,
        stepX: width * 0.12,
        color: palette.grille,
      });
      addVentSlats(group, {
        count: 7,
        width: width * 0.72,
        depth: Math.max(5, shellDepth * 0.018),
        height: Math.max(5, mainHeight * 0.035),
        startY: -shellDepth * 0.26,
        startZ: mainHeight * 0.68,
        stepY: shellDepth * 0.065,
        color: "#475569",
      });
      const bracketZ = mainHeight + Math.max(8, mainHeight * 0.03);
      [
        [-width * 0.42, -shellDepth * 0.38],
        [width * 0.42, -shellDepth * 0.38],
        [-width * 0.42, shellDepth * 0.38],
        [width * 0.42, shellDepth * 0.38],
      ].forEach(([x, y]) => {
        group.add(
          createLocalBoxMesh(
            Math.max(28, width * 0.035),
            Math.max(18, shellDepth * 0.03),
            Math.max(8, mainHeight * 0.035),
            "#334155",
            new THREE.Vector3(x, y, bracketZ),
            { renderOrder: 20 },
          ),
        );
      });
      addGenericUnitPipePorts(group, effectiveElement);
      break;
    }
    case "ceiling-cassette-ac": {
      addCeilingCassetteVisibleModel(group, effectiveElement);
      break;
    }
    case "refrigerant-branch-kit": {
      const branchKit = buildRefrigerantBranchKitViewModel(effectiveElement);
      const lineSelection = resolveRefrigerantBranchKitLineSelection(effectiveElement);
      const renderGasLine = lineSelection !== "liquid";
      const renderLiquidLine = lineSelection !== "gas";
      const gasCopper = REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.gasCopper;
      const liquidCopper = REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.liquidCopper;
      const bandColor = REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.fittingBand;

      const pointToVector = (point: Point2D, z: number): THREE.Vector3 =>
        new THREE.Vector3(point.x, point.y, z);

      const addRouteTube = (
        points: Point2D[],
        z: number,
        radius: number,
        color: string,
        renderOrder: number,
        lineKind: "gas" | "liquid",
        openStart = false,
        openEnd = false,
      ): void => {
        const tube = createTubeAlongPoints(
          points.map((point) => pointToVector(point, z)),
          radius,
          color,
          {
            renderOrder,
            openStart,
            openEnd,
            // The kit is a manufactured component. Its shared tube dimensions
            // define the display fillet; field-pipe bend defaults cannot reshape it.
            bendRadiusMm: radius * 2,
            radialSegments: 18,
            surfaceRole: "insulation",
            lineKind,
          },
        );
        if (tube) {
          group.add(tube);
        }
      };

      const addBands = (
        bands: Array<{
          center: Point2D;
          direction: Point2D;
          lengthMm: number;
          outerDiameterMm: number;
        }>,
        z: number,
      ): void => {
        bands.forEach((band) => {
          const halfLength = band.lengthMm / 2;
          const start = {
            x: band.center.x - band.direction.x * halfLength,
            y: band.center.y - band.direction.y * halfLength,
          };
          const end = {
            x: band.center.x + band.direction.x * halfLength,
            y: band.center.y + band.direction.y * halfLength,
          };
          const mesh = createCylinderBetweenPoints(
            pointToVector(start, z),
            pointToVector(end, z),
            band.outerDiameterMm / 2,
            bandColor,
            { renderOrder: 21, radialSegments: 16 },
          );
          if (mesh) {
            group.add(mesh);
          }
        });
      };

      const renderLine = (line: typeof branchKit.gas, copperColor: string, lineKind: "gas" | "liquid"): void => {
        const z = line.centerlineZMm;
        const toVec = (point: Point2D): THREE.Vector3 => pointToVector(point, z);

        // Insulation sleeve over the inlet (opaque).
        addRouteTube(
          line.inletTube.points,
          z,
          line.inletTube.outerDiameterMm / 2 + 9,
          REFRIGERANT_PIPE_3D_COLORS[lineKind],
          18,
          lineKind,
        );

        // Copper body: union inlet + reducer + the bridged run + the branch
        // takeoff into ONE watertight solid, so the tee/saddle is a clean
        // boolean intersection instead of interpenetrating cylinders, and the
        // copper never extends past where it physically meets.
        const copperParts: Array<THREE.BufferGeometry | null> = [];

        const inletPoints = line.inletTube.points;
        copperParts.push(
          buildCylinderGeometry(
            toVec(inletPoints[0]!),
            toVec(inletPoints[inletPoints.length - 1]!),
            line.inletTube.outerDiameterMm / 2,
            PIPE_RADIAL_SEGMENTS,
            true,
          ),
        );

        if (line.inletReducer) {
          copperParts.push(
            buildReducerGeometry(
              toVec(line.inletReducer.start),
              toVec(line.inletReducer.end),
              line.inletReducer.startOuterDiameterMm / 2,
              line.inletReducer.endOuterDiameterMm / 2,
              PIPE_RADIAL_SEGMENTS,
              true,
            ),
          );
        }

        // Bridge the inlet-run, the junction gap and the main run into a single
        // straight copper cylinder along the trunk centreline.
        const runStart = line.inletRunTube.points[0]!;
        const mainPoints = line.mainTube.points;
        const runEnd = mainPoints[mainPoints.length - 1]!;
        copperParts.push(
          buildCylinderGeometry(
            toVec(runStart),
            toVec(runEnd),
            line.mainTube.outerDiameterMm / 2,
            PIPE_RADIAL_SEGMENTS,
            true,
          ),
        );

        // Branch takeoff: prepend a point on the run centreline so the branch
        // physically intersects the run and the union carves a real saddle.
        const branchPoints = line.branchTube.points;
        if (branchPoints.length >= 1) {
          const branchHead = branchPoints[0]!;
          const connection: Point2D = { x: branchHead.x, y: runStart.y };
          copperParts.push(
            buildSweptTubeGeometry(
              [connection, ...branchPoints].map(toVec),
              line.branchTube.outerDiameterMm / 2,
              {
                radialSegments: PIPE_RADIAL_SEGMENTS,
                bendRadiusMm: line.branchTube.outerDiameterMm,
                capStart: true,
                capEnd: true,
                weld: true,
              },
            ),
          );
        }

        const copperGeometry = unionGeometries(copperParts);
        if (copperGeometry) {
          const copperMesh = new THREE.Mesh(
            copperGeometry,
            getCopperFittingMaterial(copperColor),
          );
          copperMesh.renderOrder = 20;
          copperMesh.castShadow = true;
          copperMesh.receiveShadow = true;
          copperMesh.name = `refrigerant-${lineKind}-branch-fitting`;
          copperMesh.userData.pipeLineKind = lineKind;
          copperMesh.userData.pipeSurfaceRole = "fitting";
          group.add(copperMesh);
        }

        addBands(line.bands, z);
      };

      if (renderGasLine) {
        renderLine(branchKit.gas, gasCopper, "gas");
      }
      if (renderLiquidLine) {
        renderLine(branchKit.liquid, liquidCopper, "liquid");
      }
      break;
    }
    case "refrigerant-pipe-pair": {
      const visual = buildRefrigerantPipePairVisual(effectiveElement, context.allElements);
      // Use the same physical lanes and takeoffs as plan view. The editable 3D
      // guide contributes elevation only; it must not invent a second offset.
      group.position.set(0, 0, 0);
      group.rotation.set(0, 0, 0);
      const authoredGuide = readPipeRouteNodes3d(effectiveElement);
      const baselineZ = effectiveElement.elevation
        + (visual.gasLocalZMm + visual.liquidLocalZMm) / 2;
      const guide = authoredGuide.length >= 2
        ? authoredGuide
        : visual.routePoints.map((point) => ({ ...point, z: baselineZ }));
      const pureVertical = guide.length >= 2 && guide.every((node) =>
        Math.hypot(node.x - guide[0]!.x, node.y - guide[0]!.y) <= EPSILON,
      ) && !visual.startBundleConnection && !visual.endBundleConnection;

      for (const lineKind of ["gas", "liquid"] as const) {
        const gas = lineKind === "gas";
        const outerRadius = gas ? visual.gasOuterRadiusMm : visual.liquidOuterRadiusMm;
        const coreRadius = gas ? visual.gasCoreRadiusMm : visual.liquidCoreRadiusMm;
        const localZ = gas ? visual.gasLocalZMm : visual.liquidLocalZMm;
        const planPoints = gas ? visual.gasContinuousOuterPoints : visual.liquidContinuousOuterPoints;
        const lineOffsetZ = effectiveElement.elevation + localZ - baselineZ;
        const lineConnection = (bundle: typeof visual.startBundleConnection) => bundle ? {
          connectionKind: bundle.connectionKind,
          elevationMm: gas ? bundle.gasElevationMm : bundle.liquidElevationMm,
        } : null;
        const startConnection = lineConnection(visual.startBundleConnection);
        const endConnection = lineConnection(visual.endBundleConnection);
        const elevatedGuide = guide.map((node) => ({ ...node, z: node.z + lineOffsetZ }));
        const bendRadiusMm = resolveFieldPipeBendRadiusMm(outerRadius * 2, effectiveElement.properties.bendRadiusFactor);
        const nodes = pureVertical
          ? elevatedGuide.map((node) => ({
              ...node,
              x: node.x + (gas ? -1 : 1) * visual.centerSpacingMm / 2,
            }))
          : liftPipePlanRouteTo3d(planPoints, elevatedGuide, { startConnection, endConnection, outerDiameterMm: outerRadius * 2, bendRadiusMm,
              pipeDiameterMm: usesCopperSocketElbows(effectiveElement.properties) ? coreRadius * 2 : undefined,
              minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(effectiveElement.properties) });
        const points = nodes.map((node) => new THREE.Vector3(node.x, node.y, node.z));
        if (usesCopperSocketElbows(effectiveElement.properties) && addSocketElbowPipeAssembly(group, points, outerRadius, coreRadius, {
          lineKind, bendRadiusMm,
          minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(effectiveElement.properties),
          openStart: visual.startBundleConnection?.connectionKind === 'field-pipe' && !visual.startBundleConnection.terminalRole,
          openEnd: visual.endBundleConnection?.connectionKind === 'field-pipe' && !visual.endBundleConnection.terminalRole,
          startStraightMm: startConnection?.connectionKind === 'unit-port' ? getActivePipeRoutingSettings().minimumPortStubMm : 0,
          endStraightMm: endConnection?.connectionKind === 'unit-port' ? getActivePipeRoutingSettings().minimumPortStubMm : 0,
        })) {
          addExposedCoreEndCaps(group, points, coreRadius,
            gas ? REFRIGERANT_PIPE_3D_COLORS.gasCopper : REFRIGERANT_PIPE_3D_COLORS.liquidCopper, {
              start: visual.startBundleConnection === null, end: visual.endBundleConnection === null,
            });
          continue;
        }
        const tube = createTubeAlongPoints(points, outerRadius, REFRIGERANT_PIPE_3D_COLORS[lineKind], {
          renderOrder: 18,
          // Unit and fitting sockets finish flush at their true endpoints. Only
          // an actual pipe continuation needs the tiny seam overlap.
          openStart: visual.startBundleConnection?.connectionKind === "field-pipe"
            && !visual.startBundleConnection.terminalRole,
          openEnd: visual.endBundleConnection?.connectionKind === "field-pipe"
            && !visual.endBundleConnection.terminalRole,
          bendRadiusMm,
          surfaceRole: "insulation",
          lineKind,
          preservePlanGeometry: true,
        });
        if (tube) group.add(tube);
        addExposedCoreEndCaps(group, points, coreRadius,
          gas ? REFRIGERANT_PIPE_3D_COLORS.gasCopper : REFRIGERANT_PIPE_3D_COLORS.liquidCopper, {
            start: visual.startBundleConnection === null,
            end: visual.endBundleConnection === null,
          });
      }
      break;
    }
    case "condensate-pipe":
    case "condensate-gully": {
      // World-space geometry: sloped drains and terminations carry absolute Z.
      group.position.set(0, 0, 0);
      group.rotation.set(0, 0, 0);
      if (normalizedType === "condensate-pipe") addCondensatePipeMeshes(group, effectiveElement);
      else addCondensateGullyMeshes(group, effectiveElement);
      break;
    }
    case "refrigerant-pipe": {
      const visual = buildRefrigerantPipeVisual(effectiveElement, context.allElements);
      const authoredGuide = readPipeRouteNodes3d(effectiveElement);
      const chainState = authoredGuide.length >= 2 ? null
        : context.pipeRenderChainStateMap?.get(effectiveElement.id) ?? null;
      if (chainState && !chainState.renderAsHead) return group;

      group.position.set(0, 0, 0);
      group.rotation.set(0, 0, 0);
      const lineKind = chainState?.lineKind ?? visual.lineKind;
      const outerRadius = chainState?.outerRadiusMm ?? visual.outerRadiusMm;
      const coreRadius = chainState?.coreRadiusMm ?? visual.coreRadiusMm;
      const planPoints = chainState?.continuousOuterPoints ?? visual.continuousOuterPoints;
      const baselineZ = chainState?.elevationMm ?? effectiveElement.elevation + visual.localZMm;
      const tail = chainState
        ? context.allElements.find((candidate) => candidate.id === chainState.tailId)
        : null;
      const startConnection = visual.startConnection;
      const endConnection = tail
        ? buildRefrigerantPipeVisual(tail, context.allElements).endConnection
        : visual.endConnection;
      const guide = authoredGuide.length >= 2 ? authoredGuide
        : buildElevationProfiledPoints(planPoints, baselineZ, { x: 0, y: 0 }, visual.bypasses)
          .map((point) => ({ x: point.x, y: point.y, z: point.z }));
      const bendRadiusMm = resolveFieldPipeBendRadiusMm(outerRadius * 2, effectiveElement.properties.bendRadiusFactor);
      const nodes = liftPipePlanRouteTo3d(planPoints, guide, { startConnection, endConnection, outerDiameterMm: outerRadius * 2, bendRadiusMm,
        pipeDiameterMm: usesCopperSocketElbows(effectiveElement.properties) ? coreRadius * 2 : undefined,
        minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(effectiveElement.properties) });
      const points = nodes.map((node) => new THREE.Vector3(node.x, node.y, node.z));
      const endpointState = chainState ?? context.pipeEndpointStateMap?.get(effectiveElement.id);
      const openStart = !startConnection?.terminalRole && (endpointState?.openStart
        ?? startConnection?.connectionKind === "field-pipe");
      const openEnd = !endConnection?.terminalRole && (endpointState?.openEnd
        ?? endConnection?.connectionKind === "field-pipe");
      if (usesCopperSocketElbows(effectiveElement.properties) && addSocketElbowPipeAssembly(group, points, outerRadius, coreRadius, {
        lineKind, bendRadiusMm, openStart, openEnd,
        minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(effectiveElement.properties),
        startStraightMm: startConnection?.connectionKind === 'unit-port' ? getActivePipeRoutingSettings().minimumPortStubMm : 0,
        endStraightMm: endConnection?.connectionKind === 'unit-port' ? getActivePipeRoutingSettings().minimumPortStubMm : 0,
      })) {
        addExposedCoreEndCaps(group, points, coreRadius,
          lineKind === 'gas' ? REFRIGERANT_PIPE_3D_COLORS.gasCopper : REFRIGERANT_PIPE_3D_COLORS.liquidCopper, {
            start: !startConnection && !openStart, end: !endConnection && !openEnd,
          });
        break;
      }
      const insulation = createTubeAlongPoints(points, outerRadius, REFRIGERANT_PIPE_3D_COLORS[lineKind], {
        renderOrder: 18,
        openStart,
        openEnd,
        bendRadiusMm,
        surfaceRole: "insulation",
        lineKind,
        preservePlanGeometry: true,
      });
      if (insulation) group.add(insulation);
      // A closed insulation shell hides the copper along the run. Only loose
      // ends need a copper cross-section, including legacy plan-only pipes.
      addExposedCoreEndCaps(group, points, coreRadius,
        lineKind === "gas" ? REFRIGERANT_PIPE_3D_COLORS.gasCopper : REFRIGERANT_PIPE_3D_COLORS.liquidCopper, {
          start: !startConnection && !openStart,
          end: !endConnection && !openEnd,
        });
      break;
    }
    case "duct": {
      const ductVisual = buildGiDuctVisual(effectiveElement);
      const halfHeight = ductVisual.outerHeightMm / 2;
      const halfWidth = ductVisual.outerWidthMm / 2;
      const wallThickness = ductVisual.wallThicknessMm;
      const innerWidth = Math.max(12, ductVisual.innerWidthMm);
      const innerHeight = Math.max(12, ductVisual.innerHeightMm);
      const ductCollarLength = Math.max(
        10,
        Math.min(26, ductVisual.outerWidthMm * 0.08),
      );
      const ductBandThickness = Math.max(
        7,
        Math.min(18, ductVisual.outerWidthMm * 0.04),
      );

      ductVisual.segments.forEach((segment, index) => {
        const segmentGroup = new THREE.Group();
        segmentGroup.position.set(segment.localCenter.x, segment.localCenter.y, 0);
        segmentGroup.rotation.z = THREE.MathUtils.degToRad(segment.angleDeg);

        segmentGroup.add(
          createLocalBoxMesh(
            segment.lengthMm,
            ductVisual.outerWidthMm,
            wallThickness,
            MEP_PROJECTION_PALETTE.ductTop,
            new THREE.Vector3(0, 0, ductVisual.outerHeightMm - wallThickness / 2),
          ),
        );
        segmentGroup.add(
          createLocalBoxMesh(
            segment.lengthMm,
            ductVisual.outerWidthMm,
            wallThickness,
            MEP_PROJECTION_PALETTE.ductSide,
            new THREE.Vector3(0, 0, wallThickness / 2),
          ),
        );
        segmentGroup.add(
          createLocalBoxMesh(
            segment.lengthMm,
            wallThickness,
            ductVisual.outerHeightMm,
            MEP_PROJECTION_PALETTE.ductSide,
            new THREE.Vector3(0, -halfWidth + wallThickness / 2, halfHeight),
          ),
        );
        segmentGroup.add(
          createLocalBoxMesh(
            segment.lengthMm,
            wallThickness,
            ductVisual.outerHeightMm,
            MEP_PROJECTION_PALETTE.ductSide,
            new THREE.Vector3(0, halfWidth - wallThickness / 2, halfHeight),
          ),
        );
        addDuctEdgeBands(segmentGroup, {
          lengthMm: segment.lengthMm,
          outerWidthMm: ductVisual.outerWidthMm,
          outerHeightMm: ductVisual.outerHeightMm,
          edgeColor: MEP_PROJECTION_PALETTE.ductEdge,
          accentColor: MEP_PROJECTION_PALETTE.ductAccent,
        });

        segment.seamOffsetsMm.forEach((offsetMm) => {
          const localX = offsetMm - segment.lengthMm / 2;
          segmentGroup.add(
            createLocalBoxMesh(
              Math.max(2.4, wallThickness * 2.8),
              ductVisual.outerWidthMm + wallThickness * 0.8,
              Math.max(1.4, wallThickness * 1.7),
              MEP_PROJECTION_PALETTE.ductCollar,
              new THREE.Vector3(localX, 0, ductVisual.outerHeightMm + 1.5),
              { renderOrder: 19 },
            ),
          );
          addDuctCollar(segmentGroup, {
            x: localX,
            outerWidthMm: ductVisual.outerWidthMm,
            outerHeightMm: ductVisual.outerHeightMm,
            color: MEP_PROJECTION_PALETTE.ductCollar,
            bandLengthMm: ductCollarLength * 0.72,
            bandThicknessMm: ductBandThickness * 0.72,
          });
        });

        if (index === 0) {
          addDuctCollar(segmentGroup, {
            x: -segment.lengthMm / 2 + ductCollarLength / 2,
            outerWidthMm: ductVisual.outerWidthMm,
            outerHeightMm: ductVisual.outerHeightMm,
            color: MEP_PROJECTION_PALETTE.ductCollar,
            bandLengthMm: ductCollarLength,
            bandThicknessMm: ductBandThickness,
          });
        }

        addDuctCollar(segmentGroup, {
          x: segment.lengthMm / 2 - ductCollarLength / 2,
          outerWidthMm: ductVisual.outerWidthMm,
          outerHeightMm: ductVisual.outerHeightMm,
          color: MEP_PROJECTION_PALETTE.ductCollar,
          bandLengthMm: ductCollarLength,
          bandThicknessMm: ductBandThickness,
        });

        if (index === ductVisual.segments.length - 1) {
          const endFaceX = segment.lengthMm / 2 - wallThickness / 2;
          segmentGroup.add(
            createLocalBoxMesh(
              Math.max(1.2, wallThickness * 0.85),
              innerWidth,
              innerHeight,
              DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctInterior,
              new THREE.Vector3(
                segment.lengthMm / 2 - wallThickness * 0.7,
                0,
                halfHeight,
              ),
              { renderOrder: 17 },
            ),
          );
          segmentGroup.add(
            createLocalBoxMesh(
              wallThickness,
              ductVisual.outerWidthMm,
              wallThickness,
              DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctEdge,
              new THREE.Vector3(endFaceX, 0, halfHeight - wallThickness / 2),
              { renderOrder: 19 },
            ),
          );
        }

        group.add(segmentGroup);
      });
      break;
    }
    case "ducted-ac": {
      const ducted = buildDuctedIndoorUnitModel(effectiveElement);
      const shellCornerRadius = Math.min(ducted.baseWidth, ducted.baseDepth) * 0.03;
      group.add(
        createRoundedLocalExtrudedMesh(
          ducted.baseWidth,
          ducted.baseDepth,
          ducted.unitHeight,
          shellCornerRadius,
          DUCTED_INDOOR_UNIT_COLOR_PALETTE.shell,
          new THREE.Vector3(0, 0, ducted.unitHeight / 2),
        ),
      );
      group.add(
        createRoundedLocalExtrudedMesh(
          ducted.casingInset.width,
          ducted.casingInset.depth,
          Math.max(10, ducted.unitHeight * 0.06),
          ducted.casingInset.cornerRadius,
          DUCTED_INDOOR_UNIT_COLOR_PALETTE.casingInset,
          new THREE.Vector3(
            ducted.casingInset.x,
            ducted.casingInset.y,
            ducted.unitHeight - Math.max(10, ducted.unitHeight * 0.06) / 2 - 6,
          ),
          { bevelEnabled: false, renderOrder: 19 },
        ),
      );
      ducted.airOpenings.forEach((opening) => {
        group.add(
          createLocalBoxMesh(
            opening.openingWidth,
            Math.max(20, opening.frameDepth * 1.4),
            Math.max(16, opening.openingHeight * 0.22),
            opening.kind === "return"
              ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingMouthReturn
              : DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingMouthSupply,
            new THREE.Vector3(
              opening.x,
              opening.kind === "return" ? -ducted.baseDepth * 0.42 : ducted.baseDepth * 0.42,
              opening.z,
            ),
            { renderOrder: 20 },
          ),
        );
      });
      ducted.pipePorts.forEach((port) => {
        addHvacPipePort(group, {
          anchor: new THREE.Vector3(port.x, port.y, port.z),
          radius: port.radius,
          length: port.length,
          color: port.color,
          collarColor: port.collarColor,
          collarRadius: port.collarRadius,
          collarLength: port.collarLength,
          flangeColor: port.flangeColor,
          flangeThickness: port.flangeThickness,
        });
      });
      break;
    }
    case "outdoor-unit": {
      const footHeight = Math.max(35, height * 0.12);
      const cabinetHeight = Math.max(120, height - footHeight);
      const cabinetRadius = Math.min(width, depth) * 0.035;
      group.add(
        createLocalBoxMesh(
          width * 0.14,
          depth * 0.7,
          footHeight,
          palette.metal,
          new THREE.Vector3(-width * 0.26, 0, footHeight / 2),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.14,
          depth * 0.7,
          footHeight,
          palette.metal,
          new THREE.Vector3(width * 0.26, 0, footHeight / 2),
        ),
      );
      group.add(
        createRoundedLocalExtrudedMesh(
          width,
          depth,
          cabinetHeight,
          cabinetRadius,
          palette.body,
          new THREE.Vector3(0, 0, footHeight + cabinetHeight / 2),
          {
            bevelSize: Math.min(10, cabinetRadius * 0.35),
            bevelThickness: Math.min(12, cabinetHeight * 0.015),
            bevelSegments: 3,
          },
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.9,
          depth * 0.08,
          cabinetHeight * 0.82,
          palette.trim,
          new THREE.Vector3(0, depth * 0.47, footHeight + cabinetHeight * 0.52),
        ),
      );
      addFrontFaceFan(group, {
        center: new THREE.Vector3(
          -width * 0.23,
          depth * 0.51,
          footHeight + cabinetHeight * 0.58,
        ),
        radius: Math.min(width * 0.22, cabinetHeight * 0.22),
        ringColor: "#111827",
        grilleColor: "#334155",
        bladeColor: "#94a3b8",
      });
      addFrontFaceFan(group, {
        center: new THREE.Vector3(
          width * 0.23,
          depth * 0.51,
          footHeight + cabinetHeight * 0.58,
        ),
        radius: Math.min(width * 0.22, cabinetHeight * 0.22),
        ringColor: "#111827",
        grilleColor: "#334155",
        bladeColor: "#94a3b8",
      });
      addVentSlats(group, {
        count: 7,
        width: Math.max(4, width * 0.012),
        depth: Math.max(8, depth * 0.08),
        height: cabinetHeight * 0.66,
        startX: -width * 0.39,
        startY: depth * 0.52,
        startZ: footHeight + cabinetHeight * 0.55,
        stepX: width * 0.13,
        color: "#1f2937",
      });
      group.add(
        createLocalBoxMesh(
          width * 0.86,
          Math.max(8, depth * 0.045),
          Math.max(16, cabinetHeight * 0.035),
          palette.accent,
          new THREE.Vector3(0, depth * 0.54, footHeight + cabinetHeight * 0.88),
          { renderOrder: 21 },
        ),
      );
      addGenericUnitPipePorts(group, effectiveElement);
      break;
    }
    case "filter": {
      const frameHeight = Math.max(35, height);
      group.add(
        createLocalBoxMesh(
          width,
          depth,
          frameHeight,
          palette.body,
          new THREE.Vector3(0, 0, frameHeight / 2),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.84,
          depth * 0.84,
          Math.max(8, frameHeight * 0.18),
          palette.trim,
          new THREE.Vector3(0, 0, frameHeight + Math.max(4, frameHeight * 0.09)),
          { renderOrder: 19 },
        ),
      );
      addVentSlats(group, {
        count: 6,
        width: width * 0.72,
        depth: Math.max(4, depth * 0.025),
        height: Math.max(5, frameHeight * 0.12),
        startY: -depth * 0.28,
        startZ: frameHeight + Math.max(8, frameHeight * 0.18),
        stepY: depth * 0.11,
        color: palette.grille,
      });
      break;
    }
    case "diffuser":
    case "return-grille": {
      const terminalHeight = Math.max(24, Math.min(height, 90));
      const frameHeight = Math.max(8, terminalHeight * 0.28);
      group.add(
        createLocalBoxMesh(
          width,
          depth,
          frameHeight,
          palette.trim,
          new THREE.Vector3(0, 0, frameHeight / 2),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.78,
          depth * 0.78,
          Math.max(4, frameHeight * 0.36),
          palette.body,
          new THREE.Vector3(0, 0, frameHeight + 2),
          { renderOrder: 19 },
        ),
      );
      if (normalizedType === "diffuser") {
        group.add(
          createLocalBoxMesh(
            width * 0.14,
            depth * 0.76,
            Math.max(5, frameHeight * 0.42),
            palette.accent,
            new THREE.Vector3(0, 0, frameHeight + 6),
            { renderOrder: 20 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            width * 0.76,
            depth * 0.14,
            Math.max(5, frameHeight * 0.42),
            palette.accent,
            new THREE.Vector3(0, 0, frameHeight + 6),
            { renderOrder: 20 },
          ),
        );
      } else {
        addVentSlats(group, {
          count: 7,
          width: width * 0.68,
          depth: Math.max(4, depth * 0.022),
          height: Math.max(5, frameHeight * 0.4),
          startY: -depth * 0.27,
          startZ: frameHeight + 5,
          stepY: depth * 0.09,
          color: palette.grille,
        });
      }
      break;
    }
    case "remote-controller":
    case "control-panel": {
      const panelHeight = Math.max(height, 40);
      const faceDepth = Math.max(depth, 18);
      group.add(
        createLocalBoxMesh(
          width,
          faceDepth,
          panelHeight,
          palette.body,
          new THREE.Vector3(0, 0, panelHeight / 2),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.78,
          Math.max(4, faceDepth * 0.16),
          panelHeight * 0.56,
          palette.grille,
          new THREE.Vector3(0, faceDepth * 0.46, panelHeight * 0.6),
          { renderOrder: 20 },
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.28,
          Math.max(5, faceDepth * 0.18),
          Math.max(8, panelHeight * 0.08),
          palette.accent,
          new THREE.Vector3(0, faceDepth * 0.5, panelHeight * 0.18),
          { renderOrder: 21 },
        ),
      );
      break;
    }
    case "accessory": {
      const accessoryHeight = Math.max(40, height);
      group.add(
        createLocalBoxMesh(
          width,
          depth,
          accessoryHeight,
          palette.body,
          new THREE.Vector3(0, 0, accessoryHeight / 2),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.82,
          depth * 0.12,
          accessoryHeight * 0.5,
          palette.trim,
          new THREE.Vector3(0, depth * 0.45, accessoryHeight * 0.54),
          { renderOrder: 19 },
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.28,
          depth * 0.18,
          accessoryHeight * 0.18,
          palette.accent,
          new THREE.Vector3(0, -depth * 0.44, accessoryHeight * 0.72),
          { renderOrder: 20 },
        ),
      );
      break;
    }
    default:
      return null;
  }

  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  return group;
}

export function buildHvacSceneMetadata(
  elements: HvacElement[],
  context: HvacBuildSceneContext,
): {
  bounds: THREE.Box3;
  labelAnchors: HvacProjectionLabelAnchor[];
  lowestElevation: number;
} {
  const bounds = new THREE.Box3();
  const labelAnchors: HvacProjectionLabelAnchor[] = [];
  let lowestElevation = 0;

  elements.forEach((element) => {
    const mesh = buildHvacElementMesh(element, context);
    if (!mesh) {
      return;
    }
    mesh.updateMatrixWorld(true);
    const meshBounds = new THREE.Box3().setFromObject(mesh);
    if (!meshBounds.isEmpty()) {
      bounds.union(meshBounds);
      lowestElevation = Math.min(lowestElevation, meshBounds.min.z);
      const labelAnchor = buildLabelAnchor(element, mesh);
      if (labelAnchor) {
        labelAnchors.push(labelAnchor);
      }
      return;
    }

    lowestElevation = Math.min(lowestElevation, element.elevation);
  });

  return {
    bounds,
    labelAnchors,
    lowestElevation,
  };
}
