"use client";

import * as THREE from "three";

import type { HvacElement, Point2D } from "../../../../types";
import { buildCeilingCassetteModel } from "../ceilingCassetteModel";
import {
  buildDuctedIndoorUnitModel,
  DUCTED_INDOOR_UNIT_COLOR_PALETTE,
} from "../ductedIndoorUnitModel";
import { buildGiDuctVisual } from "../giDuctModel";
import type { PipeBypass } from "../pipeBypass";
import { computeFittingRunMm } from "../pipeRoutingRules";
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

const EPSILON = 0.001;

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
    type === "return-grille"
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

function createLocalSphereMesh(
  radius: number,
  color: string,
  position: THREE.Vector3,
  options?: { opacity?: number; renderOrder?: number },
): THREE.Mesh {
  const opacity = options?.opacity ?? 1;
  const geometry = new THREE.SphereGeometry(radius, 18, 14);
  const material = getSharedBoxMaterial(color, opacity, opacity < 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.renderOrder = options?.renderOrder ?? 19;
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

function createTaperedCylinderBetweenPoints(
  start: THREE.Vector3,
  end: THREE.Vector3,
  startRadius: number,
  endRadius: number,
  color: string,
  options?: {
    opacity?: number;
    renderOrder?: number;
    radialSegments?: number;
  },
): THREE.Mesh | null {
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length < EPSILON) {
    return null;
  }

  const axis = delta.normalize();
  const center = start.clone().add(end).multiplyScalar(0.5);
  const mesh = createLocalCylinderMesh(
    endRadius,
    startRadius,
    length,
    color,
    center,
    {
      opacity: options?.opacity,
      renderOrder: options?.renderOrder,
      radialSegments: options?.radialSegments ?? 18,
    },
  );
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  return mesh;
}

function createTubeAlongPoints(
  points: THREE.Vector3[],
  radius: number,
  color: string,
  options?: {
    opacity?: number;
    renderOrder?: number;
    radialSegments?: number;
    openStart?: boolean;
    openEnd?: boolean;
    cornerStyle?: "round" | "elbow";
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

  const simplified: THREE.Vector3[] = [cleaned[0]!];
  const angleToleranceCos = Math.cos((2 * Math.PI) / 180);
  for (let index = 1; index < cleaned.length - 1; index += 1) {
    const previous = simplified[simplified.length - 1]!;
    const current = cleaned[index]!;
    const next = cleaned[index + 1]!;
    const incoming = current.clone().sub(previous);
    const outgoing = next.clone().sub(current);
    const incomingLength = incoming.length();
    const outgoingLength = outgoing.length();
    if (incomingLength < 0.01 || outgoingLength < 0.01) {
      continue;
    }
    const directionDot = incoming.normalize().dot(outgoing.normalize());
    const direct = next.clone().sub(previous);
    const directLength = direct.length();
    if (directLength < 0.01) {
      continue;
    }
    const projectedScale =
      current.clone().sub(previous).dot(direct) / (directLength * directLength);
    const projectedPoint = previous.clone().add(direct.multiplyScalar(projectedScale));
    const lateralOffset = projectedPoint.distanceTo(current);
    if (directionDot >= angleToleranceCos && lateralOffset <= 0.2) {
      continue;
    }
    simplified.push(current);
  }
  simplified.push(cleaned[cleaned.length - 1]!);

  const finalPoints = simplified.map((point) => point.clone());
  const continuationOverlapMm = Math.max(1.5, radius * 0.75);

  if (options?.openStart && finalPoints.length >= 2) {
    const startDirection = finalPoints[1]!.clone().sub(finalPoints[0]!);
    if (startDirection.length() > EPSILON) {
      startDirection.normalize();
      finalPoints[0] = finalPoints[0]!
        .clone()
        .add(startDirection.multiplyScalar(-continuationOverlapMm));
    }
  }

  if (options?.openEnd && finalPoints.length >= 2) {
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

  if (finalPoints.length === 2) {
    return createCylinderBetweenPoints(finalPoints[0]!, finalPoints[1]!, radius, color, {
      opacity: options?.opacity,
      renderOrder: options?.renderOrder,
      radialSegments: options?.radialSegments ?? 18,
      capStart: !options?.openStart,
      capEnd: !options?.openEnd,
    });
  }

  const group = new THREE.Group();
  for (let index = 0; index < finalPoints.length - 1; index += 1) {
    const segment = createCylinderBetweenPoints(
      finalPoints[index]!,
      finalPoints[index + 1]!,
      radius,
      color,
      {
        opacity: options?.opacity,
        renderOrder: options?.renderOrder,
        radialSegments: options?.radialSegments ?? 18,
        capStart: index === 0 ? !options?.openStart : false,
        capEnd: index === finalPoints.length - 2 ? !options?.openEnd : false,
      },
    );
    if (segment) {
      group.add(segment);
    }
  }

  if ((options?.cornerStyle ?? "round") === "round") {
    for (let index = 1; index < finalPoints.length - 1; index += 1) {
      group.add(
        createLocalSphereMesh(radius, color, finalPoints[index]!, {
          opacity: options?.opacity,
          renderOrder: options?.renderOrder,
        }),
      );
    }
  }

  return group.children.length > 0 ? group : null;
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
      x: effectiveElement.position.x + width / 2,
      y: effectiveElement.position.y + depth / 2,
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
      const cassette = buildCeilingCassetteModel(effectiveElement);
      group.add(
        createRoundedLocalExtrudedMesh(
          cassette.hiddenBody.width,
          cassette.hiddenBody.depth,
          cassette.hiddenBody.height,
          cassette.hiddenBody.cornerRadius,
          "#94a3b8",
          new THREE.Vector3(
            cassette.hiddenBody.x,
            cassette.hiddenBody.y,
            cassette.hiddenBody.z,
          ),
        ),
      );
      group.add(
        createRoundedLocalExtrudedMesh(
          cassette.facePanel.width,
          cassette.facePanel.depth,
          cassette.facePanel.height,
          cassette.facePanel.cornerRadius,
          "#dbe5ee",
          new THREE.Vector3(
            cassette.facePanel.x,
            cassette.facePanel.y,
            cassette.facePanel.z,
          ),
          {
            bevelThickness: cassette.facePanel.bevelThickness,
            bevelSize: cassette.facePanel.bevelSize,
          },
        ),
      );
      group.add(
        createRoundedLocalExtrudedMesh(
          cassette.innerPanel.width,
          cassette.innerPanel.depth,
          cassette.innerPanel.height,
          cassette.innerPanel.cornerRadius,
          "#f8fafc",
          new THREE.Vector3(
            cassette.innerPanel.x,
            cassette.innerPanel.y,
            cassette.innerPanel.z,
          ),
          {
            bevelThickness: cassette.innerPanel.bevelThickness,
            bevelSize: cassette.innerPanel.bevelSize,
          },
        ),
      );
      cassette.slots.forEach((slot) => {
        group.add(
          createRoundedLocalExtrudedMesh(
            slot.width,
            slot.depth,
            slot.height,
            slot.cornerRadius,
            "#1f2937",
            new THREE.Vector3(slot.x, slot.y, slot.z),
            { renderOrder: 19, bevelEnabled: false },
          ),
        );
      });
      addVentSlats(group, {
        count: cassette.grille.slatCount,
        width: cassette.grille.slatSpan,
        depth: 1.5,
        height: 1.5,
        startY: -cassette.grille.slatInset,
        startZ: cassette.grille.horizontalSlatZ,
        stepY: cassette.grille.slatStep,
        color: "#8a97a4",
      });
      cassette.pipePorts.forEach((port) => {
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
    case "refrigerant-branch-kit": {
      const branchKit = buildRefrigerantBranchKitViewModel(effectiveElement);
      const lineSelection = resolveRefrigerantBranchKitLineSelection(effectiveElement);
      const renderGasLine = lineSelection !== "liquid";
      const renderLiquidLine = lineSelection !== "gas";
      const insulationColor = REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.insulationBody;
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
            cornerStyle: "round",
            radialSegments: 18,
          },
        );
        if (tube) {
          group.add(tube);
        }
      };

      const addReducer = (
        reducer:
          | {
              start: Point2D;
              end: Point2D;
              startDiameterMm: number;
              endDiameterMm: number;
            }
          | null,
        z: number,
        color: string,
      ): void => {
        if (!reducer) {
          return;
        }
        const mesh = createTaperedCylinderBetweenPoints(
          pointToVector(reducer.start, z),
          pointToVector(reducer.end, z),
          reducer.startDiameterMm / 2,
          reducer.endDiameterMm / 2,
          color,
          { renderOrder: 20, radialSegments: 18 },
        );
        if (mesh) {
          group.add(mesh);
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

      const renderLine = (line: typeof branchKit.gas, copperColor: string): void => {
        addRouteTube(
          line.inletTube.points,
          line.centerlineZMm,
          line.inletTube.outerDiameterMm / 2 + 9,
          insulationColor,
          18,
        );
        addReducer(
          line.inletReducer
            ? {
                start: line.inletReducer.start,
                end: line.inletReducer.end,
                startDiameterMm: line.inletReducer.startOuterDiameterMm,
                endDiameterMm: line.inletReducer.endOuterDiameterMm,
              }
            : null,
          line.centerlineZMm,
          copperColor,
        );
        addRouteTube(
          line.inletTube.points,
          line.centerlineZMm,
          line.inletTube.outerDiameterMm / 2,
          copperColor,
          20,
        );
        addRouteTube(
          line.inletRunTube.points,
          line.centerlineZMm,
          line.inletRunTube.outerDiameterMm / 2,
          copperColor,
          20,
        );
        addRouteTube(
          line.mainTube.points,
          line.centerlineZMm,
          line.mainTube.outerDiameterMm / 2,
          copperColor,
          20,
        );
        addRouteTube(
          line.branchTube.points,
          line.centerlineZMm,
          line.branchTube.outerDiameterMm / 2,
          copperColor,
          20,
          true,
          true,
        );
        addBands(line.bands, line.centerlineZMm);
      };

      if (renderGasLine) {
        renderLine(branchKit.gas, gasCopper);
      }
      if (renderLiquidLine) {
        renderLine(branchKit.liquid, liquidCopper);
      }
      break;
    }
    case "refrigerant-pipe-pair": {
      const visual = buildRefrigerantPipePairVisual(effectiveElement, context.allElements);
      const insulationColor = "#dce6ed";
      const gasColor = "#c5894d";
      const liquidColor = "#dca25d";
      const isFieldPipeStart =
        visual.startBundleConnection?.connectionKind === "field-pipe";

      const buildContinuousCorePoints = (
        stub: { start: Point2D; end: Point2D } | null,
        points: Point2D[],
      ): Point2D[] => {
        if (!stub) {
          return points;
        }
        if (points.length === 0) {
          return [stub.end];
        }
        const firstPoint = points[0]!;
        if (Math.hypot(firstPoint.x - stub.end.x, firstPoint.y - stub.end.y) <= 0.2) {
          return points;
        }
        return [stub.end, ...points];
      };

      const addRouteTube = (
        points: Point2D[],
        z: number,
        radius: number,
        color: string,
        renderOrder: number,
        openStart = false,
        openEnd = false,
      ): void => {
        const tube = createTubeAlongPoints(
          points.map((point) => new THREE.Vector3(point.x, point.y, z)),
          radius,
          color,
          {
            renderOrder,
            openStart,
            openEnd,
            cornerStyle: "round",
          },
        );
        if (tube) {
          group.add(tube);
        }
      };

      const addStub = (
        stub: { start: Point2D; end: Point2D } | null,
        z: number,
        radius: number,
        color: string,
        renderOrder: number,
      ): void => {
        if (!stub) {
          return;
        }
        const segment = createCylinderBetweenPoints(
          new THREE.Vector3(stub.start.x, stub.start.y, z),
          new THREE.Vector3(stub.end.x, stub.end.y, z),
          radius,
          color,
          {
            renderOrder,
            capStart: false,
            capEnd: false,
          },
        );
        if (segment) {
          group.add(segment);
        }
      };

      addRouteTube(
        visual.gasLocalContinuousOuterPoints,
        visual.gasLocalZMm,
        visual.gasOuterRadiusMm,
        insulationColor,
        18,
        isFieldPipeStart,
        false,
      );
      addRouteTube(
        visual.liquidLocalContinuousOuterPoints,
        visual.liquidLocalZMm,
        visual.liquidOuterRadiusMm,
        insulationColor,
        18,
        isFieldPipeStart,
        false,
      );
      addStub(visual.gasLocalStub, visual.gasLocalZMm, visual.gasCoreRadiusMm, gasColor, 19);
      addStub(
        visual.liquidLocalStub,
        visual.liquidLocalZMm,
        visual.liquidCoreRadiusMm,
        liquidColor,
        19,
      );
      addRouteTube(
        buildContinuousCorePoints(visual.gasLocalStub, visual.gasLocalOuterPoints),
        visual.gasLocalZMm,
        visual.gasCoreRadiusMm,
        gasColor,
        19,
        isFieldPipeStart || Boolean(visual.gasLocalStub),
        false,
      );
      addRouteTube(
        buildContinuousCorePoints(visual.liquidLocalStub, visual.liquidLocalOuterPoints),
        visual.liquidLocalZMm,
        visual.liquidCoreRadiusMm,
        liquidColor,
        19,
        isFieldPipeStart || Boolean(visual.liquidLocalStub),
        false,
      );
      break;
    }
    case "refrigerant-pipe": {
      const visual = buildRefrigerantPipeVisual(effectiveElement, context.allElements);
      const insulationColor = "#e6edf2";
      const coreColor = visual.lineKind === "gas" ? "#c5894d" : "#dca25d";
      const bypasses = visual.bypasses;
      const chainState = context.pipeRenderChainStateMap?.get(effectiveElement.id) ?? null;
      if (chainState && !chainState.renderAsHead) {
        return group;
      }
      const endpointState = context.pipeEndpointStateMap?.get(effectiveElement.id) ?? {
        openStart: false,
        openEnd: false,
      };
      const buildContinuousCorePoints = (
        stub: { start: Point2D; end: Point2D } | null,
        points: Point2D[],
      ): Point2D[] => {
        if (!stub) {
          return points;
        }
        if (points.length === 0) {
          return [stub.end];
        }
        const firstPoint = points[0]!;
        if (Math.hypot(firstPoint.x - stub.end.x, firstPoint.y - stub.end.y) <= 0.2) {
          return points;
        }
        return [stub.end, ...points];
      };

      // Raise/lower the tube across each Z-offset bypass span. `centerOffset`
      // maps the world-space bypass points into the tube's coordinate space
      // (local bounds-centred for the standalone branch, absolute for chains).
      const addRouteTube = (
        points: Point2D[],
        z: number,
        radius: number,
        color: string,
        renderOrder: number,
        centerOffset: Point2D,
        openStart = false,
        openEnd = false,
      ): void => {
        const tube = createTubeAlongPoints(
          buildElevationProfiledPoints(points, z, centerOffset, bypasses),
          radius,
          color,
          {
            renderOrder,
            openStart,
            openEnd,
            cornerStyle: "round",
          },
        );
        if (tube) {
          group.add(tube);
        }
      };

      const addStub = (
        stub: { start: Point2D; end: Point2D } | null,
        z: number,
        radius: number,
        color: string,
        renderOrder: number,
      ): void => {
        if (!stub) {
          return;
        }
        const segment = createCylinderBetweenPoints(
          new THREE.Vector3(stub.start.x, stub.start.y, z),
          new THREE.Vector3(stub.end.x, stub.end.y, z),
          radius,
          color,
          {
            renderOrder,
            capStart: false,
            capEnd: false,
          },
        );
        if (segment) {
          group.add(segment);
        }
      };

      if (chainState) {
        group.position.set(0, 0, 0);
        group.rotation.z = 0;
        const absoluteOffset: Point2D = { x: 0, y: 0 };
        addRouteTube(
          chainState.continuousOuterPoints,
          chainState.elevationMm,
          chainState.outerRadiusMm,
          insulationColor,
          18,
          absoluteOffset,
          chainState.openStart,
          chainState.openEnd,
        );
        addStub(
          chainState.absoluteStub,
          chainState.elevationMm,
          chainState.coreRadiusMm,
          coreColor,
          19,
        );
        addRouteTube(
          chainState.corePoints,
          chainState.elevationMm,
          chainState.coreRadiusMm,
          coreColor,
          19,
          absoluteOffset,
          chainState.openStart || Boolean(chainState.absoluteStub),
          chainState.openEnd,
        );
      } else {
        const localOffset = visual.bounds.center;
        addRouteTube(
          visual.localContinuousOuterPoints,
          visual.localZMm,
          visual.outerRadiusMm,
          insulationColor,
          18,
          localOffset,
          endpointState.openStart,
          endpointState.openEnd,
        );
        addStub(visual.localStub, visual.localZMm, visual.coreRadiusMm, coreColor, 19);
        addRouteTube(
          buildContinuousCorePoints(visual.localStub, visual.localOuterPoints),
          visual.localZMm,
          visual.coreRadiusMm,
          coreColor,
          19,
          localOffset,
          endpointState.openStart || Boolean(visual.localStub),
          endpointState.openEnd,
        );
      }
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
