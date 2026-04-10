"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  difference,
  featureCollection,
  polygon as turfPolygon,
} from "@turf/turf";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { ArchitecturalObjectDefinition } from "../../../data";
import type {
  HvacElement,
  Point2D,
  Room,
  SymbolInstance2D,
  Wall,
} from "../../../types";
import { buildIsometricWallBandsSignature } from "./wallBands";
import { buildIsometricWallBandsInBackground } from "./isometricWallBandsWorkerClient";
import {
  createWallOpenings3D,
  type OpeningRenderOptions,
} from "./Opening3DRenderer";
import { buildCeilingCassetteModel } from "../hvac/ceilingCassetteModel";
import {
  buildDuctedIndoorUnitModel,
  DUCTED_INDOOR_UNIT_COLOR_PALETTE,
  getDuctedIndoorUnitOpeningPlanProjection,
} from "../hvac/ductedIndoorUnitModel";
import { buildGiDuctVisual } from "../hvac/giDuctModel";
import {
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipeVisual,
} from "../hvac/refrigerantPipePairModel";
import {
  buildRefrigerantPipeEndpointRenderStateMap,
  buildRefrigerantPipeRenderChainStateMap,
  type RefrigerantPipeEndpointRenderState,
  type RefrigerantPipeRenderChainState,
} from "../hvac/refrigerantPipeRenderState";
import {
  buildRefrigerantBranchKitViewModel,
  DEFAULT_REFRIGERANT_BRANCH_KIT_INSULATION_THICKNESS_MM,
  isRefrigerantBranchKitElement,
  resolveRefrigerantBranchKitLineSelection,
  REFRIGERANT_BRANCH_KIT_COLOR_PALETTE,
} from "../hvac/refrigerantBranchKitModel";
import { hasRenderer } from "../object/FurnitureSymbolRenderer";
import { createOptimizedFurnitureModel3D } from "../object/three3d/Furniture3DRenderer";

const VIEW_MARGIN = 1.14;
const EPSILON = 0.001;
const DEFAULT_EMPTY_SIZE = { width: 800, height: 600 };
const ISO_CAMERA_DIRECTION = new THREE.Vector3(1, 1, 1).normalize();
const CAMERA_FOV_DEGREES = 40;
const MIN_POLAR_ANGLE = THREE.MathUtils.degToRad(20);
const MAX_POLAR_ANGLE = THREE.MathUtils.degToRad(88);
const MIN_CAMERA_DISTANCE = 250;
const MAX_CAMERA_DISTANCE = 160000;
const OPENING_SURFACE_INSET_MM = 2;

type WallPalette = {
  top: string;
  side: string;
  outline: string;
};

type SolidPalette = {
  color: string;
  opacity?: number;
};

type Hvac3DPalette = {
  body: string;
  trim: string;
  grille: string;
  metal: string;
  accent: string;
  label: string;
};

type WallBand = {
  polygon: Point2D[][];
  baseElevation: number;
  height: number;
  palette: WallPalette;
  name: string;
  showOutline?: boolean;
  showTopCap?: boolean;
  topCapInsetMm?: number;
};

type LabelAnchor = {
  key: string;
  position: THREE.Vector3;
  text: string;
  color: string;
};

type ScreenLabel = {
  key: string;
  x: number;
  y: number;
  text: string;
  color: string;
};

type SceneState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  contentRoot: THREE.Group;
  geometryRoot: THREE.Group;
};

export interface IsometricViewCanvasProps {
  className?: string;
  walls: Wall[];
  rooms: Room[];
  symbols: SymbolInstance2D[];
  hvacElements: HvacElement[];
  objectDefinitions: ArchitecturalObjectDefinition[];
  viewLabel?: string;
}

function polygonSignedArea(points: Point2D[]): number {
  if (points.length < 3) {
    return 0;
  }

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

  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }

    const previous = cleaned[cleaned.length - 1];
    if (
      !previous ||
      Math.hypot(point.x - previous.x, point.y - previous.y) > EPSILON
    ) {
      cleaned.push({ x: point.x, y: point.y });
    }
  }

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
  if (ring.length < 3) {
    return ring;
  }

  const isClockwise = polygonSignedArea(ring) < 0;
  if (isClockwise === clockwise) {
    return ring;
  }

  return [...ring].reverse();
}

function closeRing(points: Point2D[]): number[][] {
  const ring = sanitizeRing(points);
  if (ring.length === 0) {
    return [];
  }

  const closed = ring.map((point) => [point.x, point.y]);
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (!first || !last) {
    return closed;
  }

  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > EPSILON) {
    closed.push([first[0], first[1]]);
  }

  return closed;
}

function openRing(ring: number[][]): Point2D[] {
  if (ring.length === 0) {
    return [];
  }

  const opened = ring.map(([x, y]) => ({ x, y }));
  if (opened.length < 2) {
    return opened;
  }

  const first = opened[0];
  const last = opened[opened.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) <= EPSILON) {
    opened.pop();
  }

  return sanitizeRing(opened);
}

function extractPolygonRings(geometry: any): Point2D[][][] {
  if (!geometry) {
    return [];
  }
  if (geometry.type === "Polygon") {
    return [geometry.coordinates.map(openRing)];
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((polygon: number[][][]) =>
      polygon.map(openRing),
    );
  }
  return [];
}

function decomposePolygonForThree(rings: Point2D[][]): Point2D[][][] {
  const [outerRing, ...holeRings] = rings;
  const outer = sanitizeRing(outerRing ?? []);
  if (outer.length < 3) {
    return [];
  }

  const holes = holeRings
    .map((ring) => sanitizeRing(ring))
    .filter((ring) => ring.length >= 3);

  if (holes.length === 0) {
    return [[outer]];
  }

  try {
    const outerFeature = turfPolygon([closeRing(outer)]);
    const holeFeatures = holes
      .map((hole) => closeRing(hole))
      .filter((hole) => hole.length >= 4)
      .map((hole) => turfPolygon([hole]));

    if (holeFeatures.length === 0) {
      return [[outer]];
    }

    const differenceResult = difference(
      featureCollection([outerFeature, ...holeFeatures] as any) as any,
    ) as any;
    const polygons = extractPolygonRings(differenceResult?.geometry);
    if (polygons.length > 0) {
      return polygons;
    }
  } catch {
    // Fall through to the direct ring-based shape build.
  }

  return [[outer, ...holes]];
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
    if (hole.length < 3 || Math.abs(polygonSignedArea(hole)) <= EPSILON) {
      return;
    }

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

function readNumberProperty(
  properties: Record<string, unknown>,
  key: string,
): number | null {
  const value = properties[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readFlexibleNumberProperty(
  properties: Record<string, unknown>,
  key: string,
): number | null {
  const value = properties[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  // Build a quick lookup set from all shared material caches.
  // This prevents disposing cached materials during scene rebuilds.
  const sharedSet = new Set<THREE.Material>();
  for (const cache of [
    _wallMaterialCache,
    _wallTopMaterialCache,
    _boxMaterialCache,
    _floorMaterialCache,
  ] as Map<string, THREE.Material>[]) {
    for (const [, mat] of cache) sharedSet.add(mat);
  }
  for (const [, mat] of _outlineMaterialCache) sharedSet.add(mat);
  sharedSet.add(_wallCapMaskMaterial);

  if (Array.isArray(material)) {
    material.forEach((entry) => {
      if (!sharedSet.has(entry)) entry.dispose();
    });
    return;
  }
  if (!sharedSet.has(material)) material.dispose();
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      disposeMaterial(child.material);
      return;
    }

    if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      disposeMaterial(child.material);
    }
  });
}

function clearGroup(group: THREE.Group): void {
  const children = [...group.children];
  children.forEach((child) => {
    group.remove(child);
    disposeObject(child);
  });
}

function niceStep(target: number): number {
  if (!Number.isFinite(target) || target <= 0) {
    return 1000;
  }

  const exponent = Math.floor(Math.log10(target));
  const base = 10 ** exponent;
  const fraction = target / base;
  if (fraction <= 1) return base;
  if (fraction <= 2) return 2 * base;
  if (fraction <= 5) return 5 * base;
  return 10 * base;
}

function ensurePlanBounds(points: Point2D[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  if (points.length === 0) {
    return { minX: -2000, maxX: 2000, minY: -2000, maxY: 2000 };
  }

  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
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

function averagePoints(points: Point2D[]): Point2D {
  if (points.length === 0) {
    return { x: 0, y: 0 };
  }
  const sum = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 },
  );
  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
  };
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

function resolveInlineBranchKitRenderCenter(
  element: Pick<HvacElement, "type" | "subtype" | "modelLabel" | "properties" | "rotation">,
): Point2D | null {
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
  const model = buildRefrigerantBranchKitViewModel(element);
  const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
  const lines =
    lineSelection === "gas"
      ? [model.gas]
      : lineSelection === "liquid"
        ? [model.liquid]
        : [model.gas, model.liquid];
  const anchorLocal = averagePoints(
    lines.flatMap((line) => [line.inletTerminal.point, line.runOutletTerminal.point]),
  );
  const rotatedAnchor = rotatePoint2D(anchorLocal, element.rotation);
  return {
    x: anchorPoint.x - rotatedAnchor.x,
    y: anchorPoint.y - rotatedAnchor.y,
  };
}

function fitCameraToBox(
  camera: THREE.PerspectiveCamera,
  box: THREE.Box3,
  width: number,
  height: number,
  viewDirection: THREE.Vector3 = ISO_CAMERA_DIRECTION,
): THREE.Vector3 {
  const aspect = Math.max(width / Math.max(height, 1), 0.1);
  camera.aspect = aspect;

  if (box.isEmpty()) {
    camera.fov = CAMERA_FOV_DEGREES;
    camera.near = 1;
    camera.far = 50000;
    camera.position.set(6000, 6000, 6000);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return new THREE.Vector3(0, 0, 0);
  }

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const center = sphere.center.clone();
  const radius = Math.max(sphere.radius, 1000);
  const safeDirection = viewDirection.clone().normalize();
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect);
  const limitingHalfFov = Math.max(
    Math.min(verticalHalfFov, horizontalHalfFov),
    THREE.MathUtils.degToRad(5),
  );
  const distance = Math.max(
    (radius / Math.sin(limitingHalfFov)) * VIEW_MARGIN,
    radius * 2.25,
  );

  camera.up.set(0, 0, 1);
  camera.position.copy(center).addScaledVector(safeDirection, distance);
  camera.near = Math.max(1, distance - radius * 3);
  camera.far = distance + radius * 6;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return center;
}

function resizeCameraFrustum(
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
): void {
  camera.aspect = Math.max(width / Math.max(height, 1), 0.1);
  camera.updateProjectionMatrix();
}

function updateCameraClipping(
  camera: THREE.PerspectiveCamera,
  box: THREE.Box3,
): void {
  if (box.isEmpty()) {
    return;
  }

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1000);
  const distance = Math.max(
    camera.position.distanceTo(sphere.center),
    radius * 0.5,
  );
  const near = Math.max(1, distance - radius * 3);
  const far = distance + radius * 6;

  if (Math.abs(camera.near - near) > 0.5 || Math.abs(camera.far - far) > 1) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

function updateControlDistanceLimits(
  controls: OrbitControls,
  box: THREE.Box3,
): void {
  if (box.isEmpty()) {
    controls.minDistance = MIN_CAMERA_DISTANCE;
    controls.maxDistance = MAX_CAMERA_DISTANCE;
    return;
  }

  const radius = Math.max(
    box.getBoundingSphere(new THREE.Sphere()).radius,
    1000,
  );
  controls.minDistance = Math.max(MIN_CAMERA_DISTANCE, radius * 0.3);
  controls.maxDistance = Math.max(MAX_CAMERA_DISTANCE / 16, radius * 18);
}

function projectLabels(
  anchors: LabelAnchor[],
  camera: THREE.Camera,
  width: number,
  height: number,
): ScreenLabel[] {
  return anchors.flatMap((anchor) => {
    const projected = anchor.position.clone().project(camera);
    if (
      !Number.isFinite(projected.x) ||
      !Number.isFinite(projected.y) ||
      !Number.isFinite(projected.z) ||
      projected.z < -1 ||
      projected.z > 1
    ) {
      return [];
    }

    return [
      {
        key: anchor.key,
        x: ((projected.x + 1) / 2) * width,
        y: ((1 - projected.y) / 2) * height,
        text: anchor.text,
        color: anchor.color,
      },
    ];
  });
}

function solidPalette(
  category: ArchitecturalObjectDefinition["category"] | "hvac" | "unknown",
): SolidPalette {
  switch (category) {
    case "doors":
      return { color: "#c79d74" };
    case "windows":
      return { color: "#9ecdf5", opacity: 0.55 };
    case "fixtures":
      return { color: "#96b8a8" };
    case "symbols":
      return { color: "#c3b4db", opacity: 0.9 };
    case "furniture":
      return { color: "#8db5c6" };
    case "my-library":
      return { color: "#aab8c8" };
    case "hvac":
      return { color: "#7fa5ef" };
    case "unknown":
    default:
      return { color: "#aab8c8" };
  }
}

// ─── Shared material caches (module-scoped, persist across re-renders) ────────
// These caches prevent creating identical GPU material objects for every wall
// band/outline, reducing shader compilations and GPU memory by ~80%.

const _wallMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
const _wallTopMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
const _outlineMaterialCache = new Map<string, THREE.LineBasicMaterial>();
const _boxMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
const _wallCapMaskMaterial = new THREE.MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthWrite: false,
  depthTest: false,
  colorWrite: false,
  toneMapped: false,
});

function getSharedWallMaterial(
  color: string,
  roughness: number,
  metalness: number,
): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let mat = _wallMaterialCache.get(key);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    _wallMaterialCache.set(key, mat);
  }
  return mat;
}

function getSharedWallTopMaterial(color: string): THREE.MeshStandardMaterial {
  let mat = _wallTopMaterialCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.96,
      metalness: 0.01,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    _wallTopMaterialCache.set(color, mat);
  }
  return mat;
}

function getSharedOutlineMaterial(
  color: string,
  opacity: number,
): THREE.LineBasicMaterial {
  const key = `${color}|${opacity}`;
  let mat = _outlineMaterialCache.get(key);
  if (!mat) {
    mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    _outlineMaterialCache.set(key, mat);
  }
  return mat;
}

function getSharedBoxMaterial(
  color: string,
  opacity: number,
  isTransparent: boolean,
): THREE.MeshStandardMaterial {
  const key = `${color}|${opacity}|${isTransparent ? 1 : 0}`;
  let mat = _boxMaterialCache.get(key);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color,
      transparent: isTransparent,
      opacity,
      roughness: 0.92,
      metalness: 0.03,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: isTransparent ? -2 : -1,
      polygonOffsetUnits: isTransparent ? -2 : -1,
      alphaToCoverage: isTransparent,
    });
    _boxMaterialCache.set(key, mat);
  }
  return mat;
}

function createWallMesh(
  polygon: Point2D[][],
  baseElevation: number,
  height: number,
  palette: WallPalette,
  showOutline = true,
  showTopCap = true,
  topCapInsetMm = 0,
): THREE.Group | null {
  const polygons = decomposePolygonForThree(polygon);
  if (polygons.length === 0 || height <= EPSILON) {
    return null;
  }

  const group = new THREE.Group();
  const sideMaterial = getSharedWallMaterial(palette.side, 0.98, 0);
  const topMaterial = getSharedWallTopMaterial(palette.top);

  polygons.forEach((simplePolygon) => {
    const shape = buildShapeFromPolygon(simplePolygon);
    if (!shape) {
      return;
    }

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: height,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geometry.translate(0, 0, baseElevation);
    geometry.computeVertexNormals();

    // Hide the extrusion cap faces so any visible horizontal surface comes
    // only from the explicit top-cap mesh, which uses the safer polygon path.
    group.add(new THREE.Mesh(geometry, [_wallCapMaskMaterial, sideMaterial]));

    if (showTopCap) {
      const topGeometry = new THREE.ShapeGeometry(shape);
      const topCap = new THREE.Mesh(topGeometry, topMaterial);
      topCap.position.z = baseElevation + height + 0.4 - topCapInsetMm;
      group.add(topCap);
    }

    if (!showOutline) {
      return;
    }

    simplePolygon.forEach((ring, ringIndex) => {
      const points = sanitizeRing(ring);
      if (points.length < 3) {
        return;
      }

      const outlinePoints = points.map(
        (point) =>
          new THREE.Vector3(point.x, point.y, baseElevation + height + 4),
      );
      outlinePoints.push(outlinePoints[0].clone());

      const outlineGeometry = new THREE.BufferGeometry().setFromPoints(
        outlinePoints,
      );
      const outlineMaterial = getSharedOutlineMaterial(
        palette.outline,
        ringIndex === 0 ? 0.6 : 0.42,
      );
      group.add(new THREE.Line(outlineGeometry, outlineMaterial));
    });
  });

  return group;
}

const _floorMaterialCache = new Map<string, THREE.MeshStandardMaterial>();

function getSharedFloorMaterial(color: string): THREE.MeshStandardMaterial {
  let mat = _floorMaterialCache.get(color);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.88,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    _floorMaterialCache.set(color, mat);
  }
  return mat;
}

function createRoomFloor(room: Room): THREE.Object3D | null {
  const polygons = decomposePolygonForThree([
    room.vertices,
    ...(room.holes ?? []),
  ]);
  if (polygons.length === 0) {
    return null;
  }

  const material = getSharedFloorMaterial(room.fillColor || "#dbe6d9");
  const floorElevation = (room.properties3D.floorElevation ?? 0) + 2;

  if (polygons.length === 1) {
    const shape = buildShapeFromPolygon(polygons[0]);
    if (!shape) {
      return null;
    }

    const geometry = new THREE.ShapeGeometry(shape);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = floorElevation;
    return mesh;
  }

  const group = new THREE.Group();
  polygons.forEach((polygon, index) => {
    const shape = buildShapeFromPolygon(polygon);
    if (!shape) {
      return;
    }

    const geometry = new THREE.ShapeGeometry(shape);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = floorElevation;
    mesh.name = `room-floor-part-${room.id}-${index}`;
    group.add(mesh);
  });

  return group.children.length > 0 ? group : null;
}

function createBoxMesh(
  center: THREE.Vector3,
  width: number,
  depth: number,
  height: number,
  palette: SolidPalette,
  rotationDeg: number,
): THREE.Mesh {
  const isTransparent = palette.opacity !== undefined && palette.opacity < 1;
  const geometry = new THREE.BoxGeometry(width, depth, height);
  const material = getSharedBoxMaterial(
    palette.color,
    palette.opacity ?? 1,
    isTransparent || palette.opacity !== undefined,
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(center);
  mesh.rotation.z = THREE.MathUtils.degToRad(rotationDeg);
  mesh.renderOrder = isTransparent ? 24 : 12;
  return mesh;
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
  const isTransparent = opacity < 1;
  const geometry = new THREE.BoxGeometry(width, depth, height);
  const material = getSharedBoxMaterial(color, opacity, isTransparent);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.renderOrder = options?.renderOrder ?? (isTransparent ? 24 : 16);
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
  const isTransparent = opacity < 1;
  const geometry = new THREE.CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    options?.radialSegments ?? 24,
    1,
    options?.openEnded ?? false,
  );
  const material = getSharedBoxMaterial(color, opacity, isTransparent);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  if (options?.rotation) {
    mesh.rotation.copy(options.rotation);
  }
  mesh.renderOrder = options?.renderOrder ?? (isTransparent ? 24 : 16);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Creates a THREE.Sprite with canvas-rendered text.
 * The sprite lives in 3D space, always faces the camera, and scales with
 * distance — the standard approach for professional CAD/BIM labels.
 */
function createTextSprite(
  text: string,
  color: string,
  options?: {
    fontSize?: number;
    backgroundColor?: string;
    borderColor?: string;
    scaleFactor?: number;
  },
): THREE.Sprite {
  const fontSize = options?.fontSize ?? 48;
  const padding = fontSize * 0.4;
  const borderWidth = 2;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  // Measure text first to size canvas
  ctx.font = `600 ${fontSize}px "SF Mono", "Cascadia Code", "Fira Code", monospace`;
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;
  const textHeight = fontSize * 1.2;

  canvas.width = Math.ceil(textWidth + padding * 2 + borderWidth * 2);
  canvas.height = Math.ceil(textHeight + padding * 2 + borderWidth * 2);

  // Background
  ctx.fillStyle = options?.backgroundColor ?? "rgba(255,255,255,0.92)";
  ctx.strokeStyle = options?.borderColor ?? "rgba(148,163,184,0.6)";
  ctx.lineWidth = borderWidth;
  const r = 6;
  const w = canvas.width;
  const h = canvas.height;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r);
  ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h);
  ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Text
  ctx.font = `600 ${fontSize}px "SF Mono", "Cascadia Code", "Fira Code", monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(material);

  // Scale sprite so it has a sensible world-space size.
  // scaleFactor controls the mm-per-pixel ratio.
  const scale = options?.scaleFactor ?? 0.5;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  sprite.renderOrder = 30;

  return sprite;
}

/**
 * Computes the midpoint along a polyline at 50% of its total arc length.
 * Returns { point, tangent } where tangent is the normalised direction at that point.
 */
function polylineMidpoint(points: Point2D[]): {
  point: Point2D;
  tangent: Point2D;
} | null {
  if (points.length < 2) {
    return null;
  }
  // Total length
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    totalLength += Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y,
    );
  }
  if (totalLength < 0.1) {
    return null;
  }
  const halfLength = totalLength / 2;
  let accum = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    const segLen = Math.hypot(dx, dy);
    if (accum + segLen >= halfLength) {
      const t = (halfLength - accum) / segLen;
      return {
        point: {
          x: points[i - 1]!.x + dx * t,
          y: points[i - 1]!.y + dy * t,
        },
        tangent: {
          x: dx / segLen,
          y: dy / segLen,
        },
      };
    }
    accum += segLen;
  }
  // Fallback
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  const len = Math.hypot(dx, dy);
  return {
    point: last,
    tangent: len > 0 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 },
  };
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
  if (length < 0.001) {
    return null;
  }
  const axis = delta.normalize();
  const center = start.clone().add(end).multiplyScalar(0.5);
  const opacity = options?.opacity ?? 1;
  const isTransparent = opacity < 1;
  const renderOrder = options?.renderOrder ?? (isTransparent ? 24 : 16);
  const radialSegments = options?.radialSegments ?? 18;
  const group = new THREE.Group();

  const cylinder = createLocalCylinderMesh(radius, radius, length, color, center, {
    opacity,
    renderOrder,
    radialSegments,
    openEnded: true,
  });
  cylinder.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    axis,
  );
  group.add(cylinder);

  const createCap = (position: THREE.Vector3, normal: THREE.Vector3): void => {
    const geometry = new THREE.CircleGeometry(radius, radialSegments);
    const material = getSharedBoxMaterial(color, opacity, isTransparent);
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
  if (length < 0.001) {
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

function createSmoothTubeAlongPoints(
  points: THREE.Vector3[],
  radius: number,
  color: string,
  options?: {
    opacity?: number;
    renderOrder?: number;
    radialSegments?: number;
    tubularSegments?: number;
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
  if (cleaned.length === 2) {
    return createCylinderBetweenPoints(
      cleaned[0]!,
      cleaned[1]!,
      radius,
      color,
      {
        opacity: options?.opacity,
        renderOrder: options?.renderOrder,
        radialSegments: options?.radialSegments ?? 18,
        capStart: false,
        capEnd: false,
      },
    );
  }

  const curve = new THREE.CatmullRomCurve3(cleaned, false, "centripetal", 0.5);
  const geometry = new THREE.TubeGeometry(
    curve,
    options?.tubularSegments ?? Math.max(48, cleaned.length * 10),
    radius,
    options?.radialSegments ?? 18,
    false,
  );
  const opacity = options?.opacity ?? 1;
  const isTransparent = opacity < 1;
  const material = getSharedBoxMaterial(color, opacity, isTransparent);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = options?.renderOrder ?? (isTransparent ? 24 : 16);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
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
    const projectedScale = current.clone().sub(previous).dot(direct) / (directLength * directLength);
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
    if (startDirection.length() > 0.001) {
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
    if (endDirection.length() > 0.001) {
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
        createLocalSphereMesh(
          radius,
          color,
          finalPoints[index]!,
          {
            opacity: options?.opacity,
            renderOrder: options?.renderOrder,
            widthSegments: Math.max(18, options?.radialSegments ?? 18),
            heightSegments: 14,
          },
        ),
      );
    }
  }

  return group.children.length > 0 ? group : null;
}

function createLocalSphereMesh(
  radius: number,
  color: string,
  position: THREE.Vector3,
  options?: {
    opacity?: number;
    renderOrder?: number;
    widthSegments?: number;
    heightSegments?: number;
  },
): THREE.Mesh {
  const opacity = options?.opacity ?? 1;
  const isTransparent = opacity < 1;
  const geometry = new THREE.SphereGeometry(
    radius,
    options?.widthSegments ?? 18,
    options?.heightSegments ?? 14,
  );
  const material = getSharedBoxMaterial(color, opacity, isTransparent);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.renderOrder = options?.renderOrder ?? (isTransparent ? 24 : 16);
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

function createExtrudedPolygonMesh(
  points: Point2D[],
  height: number,
  color: string,
  zCenter: number,
  options?: {
    opacity?: number;
    renderOrder?: number;
    bevelEnabled?: boolean;
    bevelSize?: number;
    bevelThickness?: number;
    bevelSegments?: number;
    curveSegments?: number;
  },
): THREE.Mesh | null {
  if (points.length < 3 || height <= 0.2) {
    return null;
  }
  const shape = new THREE.Shape();
  shape.moveTo(points[0]!.x, points[0]!.y);
  for (let index = 1; index < points.length; index += 1) {
    shape.lineTo(points[index]!.x, points[index]!.y);
  }
  shape.closePath();

  const opacity = options?.opacity ?? 1;
  const isTransparent = opacity < 1;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: options?.bevelEnabled ?? true,
    bevelSize: options?.bevelSize ?? Math.min(1.2, height * 0.08),
    bevelThickness: options?.bevelThickness ?? Math.min(1.2, height * 0.08),
    bevelSegments: options?.bevelSegments ?? 2,
    curveSegments: options?.curveSegments ?? 8,
    steps: 1,
  });
  geometry.translate(0, 0, zCenter - height / 2);
  geometry.computeVertexNormals();

  const material = getSharedBoxMaterial(color, opacity, isTransparent);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = options?.renderOrder ?? (isTransparent ? 24 : 16);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
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
  const bevelSize = Math.min(
    options?.bevelSize ?? safeRadius * 0.34,
    safeRadius * 0.75,
  );
  const bevelThickness = Math.min(
    options?.bevelThickness ?? Math.min(height * 0.18, safeRadius * 0.42),
    Math.max(0.8, height / 2 - 0.4),
  );
  const geometry = new THREE.ExtrudeGeometry(
    createRoundedRectShape(width, depth, safeRadius),
    {
      depth: height,
      bevelEnabled,
      bevelSize,
      bevelThickness,
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
  mesh.renderOrder = options?.renderOrder ?? (isTransparent ? 24 : 16);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
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
        options.anchor.x +
          direction * (collarLength / 2 + flangeThickness * 0.35),
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
          direction *
            (collarLength + options.length / 2 - flangeThickness * 0.15),
        options.anchor.y,
        options.anchor.z,
      ),
      { rotation, radialSegments },
    ),
  );
}

function hvacPaletteForElement(element: HvacElement): Hvac3DPalette {
  switch (element.type) {
    case "outdoor-unit":
      return {
        body: "#7d8b99",
        trim: "#c8d1d9",
        grille: "#3f4b57",
        metal: "#5d6874",
        accent: "#0f766e",
        label: "#134e4a",
      };
    case "remote-controller":
    case "control-panel":
      return {
        body: "#f2f5f7",
        trim: "#d7dee4",
        grille: "#475569",
        metal: "#94a3b8",
        accent: "#b45309",
        label: "#92400e",
      };
    case "filter":
    case "accessory":
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
    default:
      return {
        body: "#f6f7f8",
        trim: "#dbe4ec",
        grille: "#7a8795",
        metal: "#aab6c2",
        accent: "#2f67c8",
        label: "#1e3a8a",
      };
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
      { renderOrder: 18 },
    );
    if (rotation) {
      slat.rotation.copy(rotation);
    }
    group.add(slat);
  }
}

function createHvacEquipmentMesh(
  element: HvacElement,
  pipeEndpointStateMap?: Map<string, RefrigerantPipeEndpointRenderState>,
  pipeRenderChainStateMap?: Map<string, RefrigerantPipeRenderChainState>,
): THREE.Group {
  if (element.type === "accessory" && isRefrigerantBranchKitElement(element)) {
    return createHvacEquipmentMesh(
      {
        ...element,
        type: "refrigerant-branch-kit",
      },
      pipeEndpointStateMap,
      pipeRenderChainStateMap,
    );
  }

  const width = Math.max(60, element.width);
  const depth = Math.max(60, element.depth);
  const height = Math.max(80, element.height);
  const palette = hvacPaletteForElement(element);
  const group = new THREE.Group();
  const renderCenter =
    resolveInlineBranchKitRenderCenter(element) ?? {
      x: element.position.x + width / 2,
      y: element.position.y + depth / 2,
    };
  group.position.set(
    renderCenter.x,
    renderCenter.y,
    element.elevation,
  );
  group.rotation.z = THREE.MathUtils.degToRad(element.rotation);
  group.name = `hvac-${element.id}`;

  const bodyHeight = Math.max(height * 0.68, Math.min(height, 120));

  switch (element.type) {
    case "wall-mounted-ac":
    case "split-ac": {
      const mainHeight = Math.max(bodyHeight, height * 0.82);
      group.add(
        createLocalBoxMesh(
          width * 0.98,
          depth * 0.74,
          mainHeight,
          palette.body,
          new THREE.Vector3(0, 0, mainHeight / 2),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.92,
          depth * 0.24,
          mainHeight * 0.52,
          palette.trim,
          new THREE.Vector3(0, depth * 0.22, mainHeight * 0.56),
        ),
      );
      addVentSlats(group, {
        count: 5,
        width: width * 0.74,
        depth: 4,
        height: 5,
        startX: 0,
        startY: depth * 0.27,
        startZ: mainHeight * 0.14,
        stepZ: mainHeight * 0.065,
        color: palette.grille,
      });
      group.add(
        createLocalBoxMesh(
          width * 0.78,
          6,
          10,
          palette.accent,
          new THREE.Vector3(0, -depth * 0.1, mainHeight * 0.78),
          { renderOrder: 18 },
        ),
      );
      break;
    }
    case "ceiling-cassette-ac": {
      const cassette = buildCeilingCassetteModel(element);

      // --- Main concealed body (inside ceiling void) ---
      group.add(
        createRoundedLocalExtrudedMesh(
          cassette.hiddenBody.width,
          cassette.hiddenBody.depth,
          cassette.hiddenBody.height,
          cassette.hiddenBody.cornerRadius,
          "#bcc5ce",
          new THREE.Vector3(
            cassette.hiddenBody.x,
            cassette.hiddenBody.y,
            cassette.hiddenBody.z,
          ),
        ),
      );
      // Top cap (sheet metal cover on top of body)
      group.add(
        createRoundedLocalExtrudedMesh(
          cassette.topCap.width,
          cassette.topCap.depth,
          cassette.topCap.height,
          cassette.topCap.cornerRadius,
          "#a8b3bd",
          new THREE.Vector3(
            cassette.topCap.x,
            cassette.topCap.y,
            cassette.topCap.z,
          ),
        ),
      );
      // Drain pump housing (small box on one side of body)
      group.add(
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
          { bevelEnabled: false, curveSegments: 8, renderOrder: 18 },
        ),
      );

      // --- Decorative face panel (visible from below, flush with ceiling) ---
      group.add(
        createRoundedLocalExtrudedMesh(
          cassette.facePanel.width,
          cassette.facePanel.depth,
          cassette.facePanel.height,
          cassette.facePanel.cornerRadius,
          "#fbfcfd",
          new THREE.Vector3(
            cassette.facePanel.x,
            cassette.facePanel.y,
            cassette.facePanel.z,
          ),
          {
            bevelThickness: cassette.facePanel.bevelThickness,
            bevelSize: cassette.facePanel.bevelSize,
            bevelSegments: 4,
          },
        ),
      );
      // Recessed inner panel
      group.add(
        createRoundedLocalExtrudedMesh(
          cassette.innerPanel.width,
          cassette.innerPanel.depth,
          cassette.innerPanel.height,
          cassette.innerPanel.cornerRadius,
          "#eef3f7",
          new THREE.Vector3(
            cassette.innerPanel.x,
            cassette.innerPanel.y,
            cassette.innerPanel.z,
          ),
          {
            bevelThickness: cassette.innerPanel.bevelThickness,
            bevelSize: cassette.innerPanel.bevelSize,
            bevelSegments: 4,
          },
        ),
      );

      // --- 4-way air discharge slots (dark openings on all 4 sides) ---
      cassette.slots.forEach((slot) => {
        group.add(
          createRoundedLocalExtrudedMesh(
            slot.width,
            slot.depth,
            slot.height,
            slot.cornerRadius,
            "#1a2030",
            new THREE.Vector3(slot.x, slot.y, slot.z),
            { renderOrder: 18, bevelEnabled: false, curveSegments: 8 },
          ),
        );
      });

      // Discharge vane blades inside each slot (3 per slot for realism)
      cassette.vanes.forEach((vane) => {
        group.add(
          createLocalBoxMesh(
            vane.width,
            vane.depth,
            vane.height,
            "#d0d8e0",
            new THREE.Vector3(vane.x, vane.y, vane.z),
            { renderOrder: 19 },
          ),
        );
      });

      // --- Central return air grille ---
      // Grille frame
      group.add(
        createRoundedLocalExtrudedMesh(
          cassette.grille.size,
          cassette.grille.size,
          cassette.grille.frameHeight,
          cassette.grille.cornerRadius,
          "#cdd5dc",
          new THREE.Vector3(
            cassette.grille.x,
            cassette.grille.y,
            cassette.grille.z,
          ),
          { bevelEnabled: false },
        ),
      );
      // Horizontal grille slats (return air intake)
      addVentSlats(group, {
        count: cassette.grille.slatCount,
        width: cassette.grille.slatSpan,
        depth: 1.5,
        height: 1.5,
        startX: 0,
        startY: -cassette.grille.slatInset,
        startZ: cassette.grille.horizontalSlatZ,
        stepY: cassette.grille.slatStep,
        color: "#8a97a4",
      });
      // Vertical grille slats (cross pattern)
      addVentSlats(group, {
        count: cassette.grille.slatCount,
        width: 1.5,
        depth: cassette.grille.slatSpan,
        height: 1.5,
        startX: -cassette.grille.slatInset,
        startY: 0,
        startZ: cassette.grille.verticalSlatZ,
        stepX: cassette.grille.slatStep,
        color: "#96a3af",
      });

      // Brand accent bar (small indicator strip)
      group.add(
        createLocalBoxMesh(
          cassette.accentBar.width,
          cassette.accentBar.depth,
          cassette.accentBar.height,
          palette.accent,
          new THREE.Vector3(
            cassette.accentBar.x,
            cassette.accentBar.y,
            cassette.accentBar.z,
          ),
          { renderOrder: 18 },
        ),
      );
      // Service label tab (bottom edge)
      group.add(
        createLocalBoxMesh(
          cassette.serviceTab.width,
          cassette.serviceTab.depth,
          cassette.serviceTab.height,
          "#eef3f7",
          new THREE.Vector3(
            cassette.serviceTab.x,
            cassette.serviceTab.y,
            cassette.serviceTab.z,
          ),
          { renderOrder: 18 },
        ),
      );

      // --- Pipe connection junction box (where pipes exit the body) ---
      group.add(
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
          { bevelEnabled: false, curveSegments: 8, renderOrder: 18 },
        ),
      );

      // --- Pipe ports (gas, liquid, drain) with realistic sizing ---
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
        group.add(
          createLocalCylinderMesh(
            port.bandRadius,
            port.bandRadius,
            3,
            port.bandColor,
            new THREE.Vector3(port.x + port.bandOffsetX, port.y, port.z),
            {
              rotation: new THREE.Euler(0, 0, Math.PI / 2),
              radialSegments: 16,
            },
          ),
        );
      });
      break;
    }
    case "refrigerant-branch-kit": {
      const branchKit = buildRefrigerantBranchKitViewModel(element);
      const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
      const renderGasLine = lineSelection !== "liquid";
      const renderLiquidLine = lineSelection !== "gas";
      const insulationColor = REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.insulationBody;
      const gasCopper = REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.gasCopper;
      const liquidCopper = REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.liquidCopper;
      const bandColor = REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.fittingBand;
      const insulationThicknessMm =
        DEFAULT_REFRIGERANT_BRANCH_KIT_INSULATION_THICKNESS_MM;

      const pointToVector = (point: Point2D, z: number): THREE.Vector3 =>
        new THREE.Vector3(point.x, point.y, z);

      const trimPolylineEnd = (
        points: Point2D[],
        trimLengthMm: number,
      ): Point2D[] => {
        if (points.length < 2 || trimLengthMm <= 0.01) {
          return points;
        }

        const segmentLengths: number[] = [];
        let totalLength = 0;
        for (let index = 1; index < points.length; index += 1) {
          const start = points[index - 1]!;
          const end = points[index]!;
          const length = Math.hypot(end.x - start.x, end.y - start.y);
          segmentLengths.push(length);
          totalLength += length;
        }

        const targetLength = Math.max(totalLength - trimLengthMm, 0);
        if (targetLength <= 0.01) {
          return [points[0]!];
        }
        if (targetLength >= totalLength - 0.01) {
          return points;
        }

        const trimmed: Point2D[] = [points[0]!];
        let traversed = 0;
        for (let index = 1; index < points.length; index += 1) {
          const start = points[index - 1]!;
          const end = points[index]!;
          const length = segmentLengths[index - 1]!;
          if (traversed + length < targetLength - 0.01) {
            trimmed.push(end);
            traversed += length;
            continue;
          }

          const remaining = targetLength - traversed;
          const t = length > 0.01 ? remaining / length : 0;
          trimmed.push({
            x: start.x + (end.x - start.x) * t,
            y: start.y + (end.y - start.y) * t,
          });
          break;
        }

        return trimmed;
      };

      const addSegment = (
        points: Point2D[],
        z: number,
        radius: number,
        color: string,
        renderOrder: number,
        options?: {
          capStart?: boolean;
          capEnd?: boolean;
        },
      ): void => {
        if (points.length < 2) {
          return;
        }
        const segment = createCylinderBetweenPoints(
          pointToVector(points[0]!, z),
          pointToVector(points[points.length - 1]!, z),
          radius,
          color,
          {
            renderOrder,
            capStart: options?.capStart,
            capEnd: options?.capEnd,
            radialSegments: 18,
          },
        );
        if (segment) {
          group.add(segment);
        }
      };

      const addReducer = (
        reducer: {
          start: Point2D;
          end: Point2D;
          startDiameterMm: number;
          endDiameterMm: number;
        } | null,
        z: number,
        color: string,
        renderOrder: number,
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
          { renderOrder, radialSegments: 18 },
        );
        if (mesh) {
          group.add(mesh);
        }
      };

      const addBranchTube = (
        points: Point2D[],
        z: number,
        radius: number,
        color: string,
        renderOrder: number,
        openEnd = true,
      ): void => {
        const tube = createTubeAlongPoints(
          points.map((point) => pointToVector(point, z)),
          radius,
          color,
          {
            renderOrder,
            openStart: true,
            openEnd,
            cornerStyle: "round",
            radialSegments: 18,
          },
        );
        if (tube) {
          group.add(tube);
        }
        if (openEnd && points.length >= 2) {
          const last = points[points.length - 1]!;
          const previous = points[points.length - 2]!;
          const dx = last.x - previous.x;
          const dy = last.y - previous.y;
          const length = Math.hypot(dx, dy);
          if (length > 0.01) {
            const rim = createCylinderBetweenPoints(
              pointToVector(
                {
                  x: last.x - (dx / length) * Math.max(radius * 0.12, 0.6),
                  y: last.y - (dy / length) * Math.max(radius * 0.12, 0.6),
                },
                z,
              ),
              pointToVector(last, z),
              radius,
              color,
              {
                renderOrder,
                radialSegments: 18,
                capStart: false,
                capEnd: false,
              },
            );
            if (rim) {
              group.add(rim);
            }
          }
        }
      };

      const addBand = (
        band: (typeof branchKit.gas.bands)[number],
        z: number,
        renderOrder: number,
      ): void => {
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
          { renderOrder, radialSegments: 16 },
        );
        if (mesh) {
          group.add(mesh);
        }
      };

      const addRouteTube = (
        points: Point2D[],
        z: number,
        radius: number,
        color: string,
        renderOrder: number,
      ): void => {
        if (points.length < 2) {
          return;
        }
        const tube = createTubeAlongPoints(
          points.map((point) => pointToVector(point, z)),
          radius,
          color,
          {
            renderOrder,
            openStart: false,
            openEnd: false,
            cornerStyle: "round",
            radialSegments: 18,
          },
        );
        if (tube) {
          group.add(tube);
        }
      };

      const createRoundedManifoldMesh = (
        line: typeof branchKit.gas,
        color: string,
        renderOrder: number,
      ): THREE.Mesh | null => {
        const manifoldBounds = line.manifold.outline.reduce(
          (bounds, point) => ({
            minX: Math.min(bounds.minX, point.x),
            maxX: Math.max(bounds.maxX, point.x),
            minY: Math.min(bounds.minY, point.y),
            maxY: Math.max(bounds.maxY, point.y),
          }),
          {
            minX: Number.POSITIVE_INFINITY,
            maxX: Number.NEGATIVE_INFINITY,
            minY: Number.POSITIVE_INFINITY,
            maxY: Number.NEGATIVE_INFINITY,
          },
        );
        const envelopeHeight = Math.max(
          1,
          manifoldBounds.maxY - manifoldBounds.minY,
        );
        const manifoldMinSpanMm = Math.min(
          Math.max(1, manifoldBounds.maxX - manifoldBounds.minX),
          Math.max(1, manifoldBounds.maxY - manifoldBounds.minY),
          line.manifold.depthMm,
        );
        const bevelRadiusMm = Math.min(
          Math.max(3, manifoldMinSpanMm * 0.24),
          Math.max(3.6, envelopeHeight * 0.22),
          line.manifold.depthMm * 0.38,
        );
        return createExtrudedPolygonMesh(
          line.manifold.outline,
          line.manifold.depthMm,
          color,
          line.centerlineZMm,
          {
            renderOrder,
            bevelEnabled: true,
            bevelSize: bevelRadiusMm,
            bevelThickness: bevelRadiusMm,
            bevelSegments: 16,
            curveSegments: 64,
          },
        );
      };

      const renderLine = (
        line: typeof branchKit.gas,
        copperColor: string,
      ): void => {
        const insulatedMainPoints = trimPolylineEnd(
          line.mainTube.points,
          line.runOutletTerminal.socketLengthMm,
        );
        const insulatedBranchPoints = trimPolylineEnd(
          line.branchTube.points,
          line.branchOutletTerminal.socketLengthMm,
        );

        addRouteTube(
          line.inletRunTube.points,
          line.centerlineZMm,
          line.inletRunTube.outerDiameterMm / 2 + insulationThicknessMm,
          insulationColor,
          18,
        );
        const manifoldMesh = createRoundedManifoldMesh(line, insulationColor, 18);
        if (manifoldMesh) {
          group.add(manifoldMesh);
        }
        addRouteTube(
          insulatedMainPoints,
          line.centerlineZMm,
          line.mainTube.outerDiameterMm / 2 + insulationThicknessMm,
          insulationColor,
          18,
        );
        addRouteTube(
          insulatedBranchPoints,
          line.centerlineZMm,
          line.branchTube.outerDiameterMm / 2 + insulationThicknessMm,
          insulationColor,
          18,
        );
        addSegment(
          line.inletTube.points,
          line.centerlineZMm,
          line.inletTube.outerDiameterMm / 2,
          copperColor,
          19,
          { capStart: false, capEnd: false },
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
          19,
        );
        addSegment(
          line.inletRunTube.points,
          line.centerlineZMm,
          line.inletRunTube.outerDiameterMm / 2,
          copperColor,
          19,
          { capStart: false, capEnd: false },
        );
        addSegment(
          line.mainTube.points,
          line.centerlineZMm,
          line.mainTube.outerDiameterMm / 2,
          copperColor,
          19,
          { capStart: false, capEnd: false },
        );
        addBranchTube(
          line.branchTube.points,
          line.centerlineZMm,
          line.branchTube.outerDiameterMm / 2,
          copperColor,
          19,
        );
        line.bands.forEach((band) => addBand(band, line.centerlineZMm, 20));
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
      const visual = buildRefrigerantPipePairVisual(element);
      const insulationColor = "#1f2021";
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
        if (
          Math.hypot(firstPoint.x - stub.end.x, firstPoint.y - stub.end.y) <=
          0.2
        ) {
          return points;
        }
        return [stub.end, ...points];
      };
      const gasCorePoints = buildContinuousCorePoints(
        visual.gasLocalStub,
        visual.gasLocalOuterPoints,
      );
      const liquidCorePoints = buildContinuousCorePoints(
        visual.liquidLocalStub,
        visual.liquidLocalOuterPoints,
      );

      const addRouteTube = (
        points: Point2D[],
        z: number,
        radius: number,
        color: string,
        opacity: number,
        renderOrder: number,
        openStart = false,
        openEnd = false,
        cornerStyle: "round" | "elbow" = "round",
      ) => {
        const tube = createTubeAlongPoints(
          points.map((point) => new THREE.Vector3(point.x, point.y, z)),
          radius,
          color,
          { opacity, renderOrder, openStart, openEnd, cornerStyle },
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
        opacity: number,
        renderOrder: number,
      ) => {
        if (!stub) {
          return;
        }
        const segment = createCylinderBetweenPoints(
          new THREE.Vector3(stub.start.x, stub.start.y, z),
          new THREE.Vector3(stub.end.x, stub.end.y, z),
          radius,
          color,
          { opacity, renderOrder },
        );
        if (segment) {
          group.add(segment);
        }
      };

      addRouteTube(
        visual.gasLocalOuterPoints,
        visual.gasLocalZMm,
        visual.gasOuterRadiusMm,
        insulationColor,
        1,
        18,
        isFieldPipeStart,
        false,
      );
      addRouteTube(
        visual.liquidLocalOuterPoints,
        visual.liquidLocalZMm,
        visual.liquidOuterRadiusMm,
        insulationColor,
        1,
        18,
        isFieldPipeStart,
        false,
      );

      addStub(
        visual.gasLocalStub,
        visual.gasLocalZMm,
        visual.gasCoreRadiusMm,
        gasColor,
        1,
        19,
      );
      addStub(
        visual.liquidLocalStub,
        visual.liquidLocalZMm,
        visual.liquidCoreRadiusMm,
        liquidColor,
        1,
        19,
      );
      addRouteTube(
        gasCorePoints,
        visual.gasLocalZMm,
        visual.gasCoreRadiusMm,
        gasColor,
        1,
        19,
        isFieldPipeStart,
        false,
        "elbow",
      );
      addRouteTube(
        liquidCorePoints,
        visual.liquidLocalZMm,
        visual.liquidCoreRadiusMm,
        liquidColor,
        1,
        19,
        isFieldPipeStart,
        false,
        "elbow",
      );

      break;
    }
    case "refrigerant-pipe": {
      const visual = buildRefrigerantPipeVisual(element);
      const insulationColor = "#e6edf2";
      const coreColor = visual.lineKind === "gas" ? "#c5894d" : "#dca25d";
      const chainState = pipeRenderChainStateMap?.get(element.id) ?? null;
      if (chainState && !chainState.renderAsHead) {
        group.clear();
        break;
      }
      const endpointState = pipeEndpointStateMap?.get(element.id) ?? {
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
        if (
          Math.hypot(firstPoint.x - stub.end.x, firstPoint.y - stub.end.y) <=
          0.2
        ) {
          return points;
        }
        return [stub.end, ...points];
      };
      const corePoints = buildContinuousCorePoints(
        visual.localStub,
        visual.localOuterPoints,
      );

      const addRouteTube = (
        points: Point2D[],
        z: number,
        radius: number,
        color: string,
        opacity: number,
        renderOrder: number,
        openStart = false,
        openEnd = false,
        cornerStyle: "round" | "elbow" = "round",
      ) => {
        const tube = createTubeAlongPoints(
          points.map((point) => new THREE.Vector3(point.x, point.y, z)),
          radius,
          color,
          { opacity, renderOrder, openStart, openEnd, cornerStyle },
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
        opacity: number,
        renderOrder: number,
      ) => {
        if (!stub) {
          return;
        }
        const segment = createCylinderBetweenPoints(
          new THREE.Vector3(stub.start.x, stub.start.y, z),
          new THREE.Vector3(stub.end.x, stub.end.y, z),
          radius,
          color,
          { opacity, renderOrder },
        );
        if (segment) {
          group.add(segment);
        }
      };

      if (chainState) {
        group.position.set(0, 0, 0);
        group.rotation.z = 0;

        addRouteTube(
          chainState.outerPoints,
          chainState.elevationMm,
          chainState.outerRadiusMm,
          insulationColor,
          1,
          18,
          chainState.openStart,
          chainState.openEnd,
        );
        addStub(
          chainState.absoluteStub,
          chainState.elevationMm,
          chainState.coreRadiusMm,
          coreColor,
          1,
          19,
        );
        addRouteTube(
          chainState.corePoints,
          chainState.elevationMm,
          chainState.coreRadiusMm,
          coreColor,
          1,
          19,
          chainState.openStart,
          chainState.openEnd,
          "elbow",
        );
      } else {
        addRouteTube(
          visual.localOuterPoints,
          visual.localZMm,
          visual.outerRadiusMm,
          insulationColor,
          1,
          18,
          endpointState.openStart,
          endpointState.openEnd,
        );
        addStub(
          visual.localStub,
          visual.localZMm,
          visual.coreRadiusMm,
          coreColor,
          1,
          19,
        );
        addRouteTube(
          corePoints,
          visual.localZMm,
          visual.coreRadiusMm,
          coreColor,
          1,
          19,
          endpointState.openStart,
          endpointState.openEnd,
          "elbow",
        );
      }

      break;
    }
    case "duct": {
      const ductVisual = buildGiDuctVisual(element);
      const halfHeight = ductVisual.outerHeightMm / 2;
      const halfWidth = ductVisual.outerWidthMm / 2;
      const wallThickness = ductVisual.wallThicknessMm;
      const innerWidth = Math.max(12, ductVisual.innerWidthMm);
      const innerHeight = Math.max(12, ductVisual.innerHeightMm);

      ductVisual.segments.forEach((segment, index) => {
        const segmentGroup = new THREE.Group();
        segmentGroup.position.set(segment.localCenter.x, segment.localCenter.y, 0);
        segmentGroup.rotation.z = THREE.MathUtils.degToRad(segment.angleDeg);

        segmentGroup.add(
          createLocalBoxMesh(
            segment.lengthMm,
            ductVisual.outerWidthMm,
            wallThickness,
            DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctBody,
            new THREE.Vector3(0, 0, halfHeight - wallThickness / 2),
            { renderOrder: 18 },
          ),
        );
        segmentGroup.add(
          createLocalBoxMesh(
            segment.lengthMm,
            ductVisual.outerWidthMm,
            wallThickness,
            DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctBody,
            new THREE.Vector3(0, 0, wallThickness / 2),
            { renderOrder: 18 },
          ),
        );
        segmentGroup.add(
          createLocalBoxMesh(
            segment.lengthMm,
            wallThickness,
            ductVisual.outerHeightMm,
            DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctBody,
            new THREE.Vector3(0, -halfWidth + wallThickness / 2, halfHeight),
            { renderOrder: 18 },
          ),
        );
        segmentGroup.add(
          createLocalBoxMesh(
            segment.lengthMm,
            wallThickness,
            ductVisual.outerHeightMm,
            DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctBody,
            new THREE.Vector3(0, halfWidth - wallThickness / 2, halfHeight),
            { renderOrder: 18 },
          ),
        );

        segment.seamOffsetsMm.forEach((offsetMm) => {
          segmentGroup.add(
            createLocalBoxMesh(
              Math.max(2.4, wallThickness * 2.8),
              ductVisual.outerWidthMm + wallThickness * 0.8,
              Math.max(1.4, wallThickness * 1.7),
              DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctSeam,
              new THREE.Vector3(
                offsetMm - segment.lengthMm / 2,
                0,
                halfHeight + wallThickness * 0.2,
              ),
              { renderOrder: 19 },
            ),
          );
        });

        if (index === ductVisual.segments.length - 1) {
          const endFaceX = segment.lengthMm / 2 - wallThickness / 2;
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
          segmentGroup.add(
            createLocalBoxMesh(
              wallThickness,
              ductVisual.outerWidthMm,
              wallThickness,
              DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctEdge,
              new THREE.Vector3(endFaceX, 0, wallThickness / 2),
              { renderOrder: 19 },
            ),
          );
          segmentGroup.add(
            createLocalBoxMesh(
              wallThickness,
              wallThickness,
              innerHeight,
              DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctEdge,
              new THREE.Vector3(
                endFaceX,
                -halfWidth + wallThickness / 2,
                halfHeight,
              ),
              { renderOrder: 19 },
            ),
          );
          segmentGroup.add(
            createLocalBoxMesh(
              wallThickness,
              wallThickness,
              innerHeight,
              DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctEdge,
              new THREE.Vector3(
                endFaceX,
                halfWidth - wallThickness / 2,
                halfHeight,
              ),
              { renderOrder: 19 },
            ),
          );
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
        }

        group.add(segmentGroup);
      });
      break;
    }
    case "ceiling-suspended-ac": {
      const mainHeight = Math.max(bodyHeight, height * 0.8);
      group.add(
        createLocalBoxMesh(
          width,
          depth * 0.9,
          mainHeight,
          palette.body,
          new THREE.Vector3(0, 0, mainHeight / 2),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.94,
          depth * 0.18,
          mainHeight * 0.28,
          palette.trim,
          new THREE.Vector3(0, depth * 0.28, mainHeight * 0.28),
        ),
      );
      addVentSlats(group, {
        count: 6,
        width: width * 0.12,
        depth: 5,
        height: 10,
        startX: -width * 0.3,
        startY: depth * 0.31,
        startZ: mainHeight * 0.27,
        stepX: width * 0.12,
        color: palette.grille,
      });
      group.add(
        createLocalBoxMesh(
          width * 0.16,
          depth * 0.12,
          mainHeight * 0.18,
          palette.metal,
          new THREE.Vector3(-width * 0.34, -depth * 0.18, mainHeight * 0.88),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.16,
          depth * 0.12,
          mainHeight * 0.18,
          palette.metal,
          new THREE.Vector3(width * 0.34, -depth * 0.18, mainHeight * 0.88),
        ),
      );
      break;
    }
    case "ducted-ac": {
      const ducted = buildDuctedIndoorUnitModel(element);
      const shellCornerRadius =
        Math.min(ducted.baseWidth, ducted.baseDepth) * 0.03;
      const panelHeight = Math.max(8, ducted.unitHeight * 0.045);
      const plateHeight = Math.max(5, ducted.unitHeight * 0.028);
      const lineThickness = Math.max(4, Math.min(10, ducted.baseDepth * 0.015));
      const lineHeight = Math.max(2, ducted.unitHeight * 0.012);
      const topSurfaceZ = ducted.unitHeight - panelHeight * 0.55;
      const lineSurfaceZ = ducted.unitHeight - lineHeight * 0.5 - 4;

      const addRaisedPlate = (
        spec: {
          x: number;
          y: number;
          width: number;
          depth: number;
          cornerRadius: number;
        },
        color: string,
        heightMm: number = panelHeight,
        zMm: number = topSurfaceZ,
        renderOrder: number = 18,
      ): void => {
        group.add(
          createRoundedLocalExtrudedMesh(
            spec.width,
            spec.depth,
            heightMm,
            spec.cornerRadius,
            color,
            new THREE.Vector3(spec.x, spec.y, zMm),
            {
              bevelEnabled: false,
              curveSegments: 8,
              renderOrder,
            },
          ),
        );
      };

      const addTopLine = (
        line: { x1: number; y1: number; x2: number; y2: number },
        color: string,
        thicknessMm: number = lineThickness,
      ): void => {
        const dx = line.x2 - line.x1;
        const dy = line.y2 - line.y1;
        const lengthMm = Math.hypot(dx, dy);
        if (lengthMm <= EPSILON) {
          return;
        }
        const mesh = createLocalBoxMesh(
          lengthMm,
          thicknessMm,
          lineHeight,
          color,
          new THREE.Vector3(
            (line.x1 + line.x2) / 2,
            (line.y1 + line.y2) / 2,
            lineSurfaceZ,
          ),
          { renderOrder: 18 },
        );
        mesh.rotation.z = Math.atan2(dy, dx);
        group.add(mesh);
      };

      const addInlineAirOpening = (
        opening: (typeof ducted.airOpenings)[number],
      ): void => {
        const collarProjection = opening.collarProjection;
        const collarOuterWidth =
          opening.openingWidth + opening.collarThickness * 2;
        const collarOuterHeight =
          opening.openingHeight + opening.collarThickness * 2;
        const projection = getDuctedIndoorUnitOpeningPlanProjection(
          ducted,
          opening,
        );
        const shellFaceY = projection.shellFaceY;
        const collarCenterY = projection.collarCenterY;
        const visibleCavityDepth = Math.max(
          12,
          Math.min(
            opening.cavityDepth * 0.42,
            Math.max(18, opening.frameDepth * 1.9),
          ),
        );
        const cavityCenterY =
          shellFaceY + opening.cavityDirection * visibleCavityDepth * 0.26;
        const cavityWallThickness = Math.max(6, opening.frameThickness * 0.42);
        const cavityBackDepth = Math.max(
          5,
          Math.min(visibleCavityDepth * 0.5, opening.frameDepth * 0.95),
        );
        const shellDepth = Math.max(
          visibleCavityDepth,
          opening.frameDepth * 0.92,
        );
        const shellWidth = opening.openingWidth * 0.88;
        const shellHeight = opening.openingHeight * 0.76;
        const coilDepth = Math.min(
          opening.coilDepth,
          visibleCavityDepth * 0.48,
        );
        const coilCenterY =
          shellFaceY +
          opening.cavityDirection *
            Math.min(opening.coilOffset, visibleCavityDepth * 0.56);
        const backY =
          shellFaceY +
          opening.cavityDirection *
            (visibleCavityDepth * 0.54 - cavityBackDepth * 0.5);
        const collarColor = DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCollar;
        const shellColor =
          opening.kind === "return"
            ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCavityReturn
            : DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCavitySupply;
        const backColor = DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingBack;
        const mouthColor =
          opening.kind === "return"
            ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingMouthReturn
            : DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingMouthSupply;
        const coilCoreColor = DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCoilCore;
        const coilFinColor = DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCoilFin;
        const mouthDepth = Math.max(18, opening.frameDepth * 1.3);
        const mouthCenterY =
          shellFaceY - opening.cavityDirection * mouthDepth * 0.34;
        const mouthLipThickness = Math.max(4, opening.frameThickness * 0.28);
        const mouthLipHeight = Math.max(
          12,
          opening.openingHeight - mouthLipThickness * 2.2,
        );
        const mouthLipWidth = Math.max(
          12,
          opening.openingWidth - mouthLipThickness * 2.2,
        );

        group.add(
          createLocalBoxMesh(
            collarOuterWidth,
            collarProjection,
            opening.collarThickness,
            collarColor,
            new THREE.Vector3(
              opening.x,
              collarCenterY,
              opening.z +
                opening.openingHeight / 2 +
                opening.collarThickness / 2,
            ),
            { renderOrder: 19 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            collarOuterWidth,
            collarProjection,
            opening.collarThickness,
            collarColor,
            new THREE.Vector3(
              opening.x,
              collarCenterY,
              opening.z -
                opening.openingHeight / 2 -
                opening.collarThickness / 2,
            ),
            { renderOrder: 19 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            opening.collarThickness,
            collarProjection,
            collarOuterHeight,
            collarColor,
            new THREE.Vector3(
              opening.x -
                opening.openingWidth / 2 -
                opening.collarThickness / 2,
              collarCenterY,
              opening.z,
            ),
            { renderOrder: 19 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            opening.collarThickness,
            collarProjection,
            collarOuterHeight,
            collarColor,
            new THREE.Vector3(
              opening.x +
                opening.openingWidth / 2 +
                opening.collarThickness / 2,
              collarCenterY,
              opening.z,
            ),
            { renderOrder: 19 },
          ),
        );

        group.add(
          createLocalBoxMesh(
            opening.openingWidth * 0.96,
            mouthDepth,
            mouthLipThickness,
            mouthColor,
            new THREE.Vector3(
              opening.x,
              mouthCenterY,
              opening.z + opening.openingHeight / 2 - mouthLipThickness / 2,
            ),
            { renderOrder: 21 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            opening.openingWidth * 0.96,
            mouthDepth,
            mouthLipThickness,
            mouthColor,
            new THREE.Vector3(
              opening.x,
              mouthCenterY,
              opening.z - opening.openingHeight / 2 + mouthLipThickness / 2,
            ),
            { renderOrder: 21 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            mouthLipThickness,
            mouthDepth,
            mouthLipHeight,
            mouthColor,
            new THREE.Vector3(
              opening.x - opening.openingWidth / 2 + mouthLipThickness / 2,
              mouthCenterY,
              opening.z,
            ),
            { renderOrder: 21 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            mouthLipThickness,
            mouthDepth,
            mouthLipHeight,
            mouthColor,
            new THREE.Vector3(
              opening.x + opening.openingWidth / 2 - mouthLipThickness / 2,
              mouthCenterY,
              opening.z,
            ),
            { renderOrder: 21 },
          ),
        );

        group.add(
          createLocalBoxMesh(
            shellWidth,
            shellDepth,
            cavityWallThickness,
            shellColor,
            new THREE.Vector3(
              opening.x,
              cavityCenterY,
              opening.z + shellHeight / 2,
            ),
            { renderOrder: 18 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            shellWidth,
            shellDepth,
            cavityWallThickness,
            shellColor,
            new THREE.Vector3(
              opening.x,
              cavityCenterY,
              opening.z - shellHeight / 2,
            ),
            { renderOrder: 18 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            cavityWallThickness,
            shellDepth,
            shellHeight,
            shellColor,
            new THREE.Vector3(
              opening.x - shellWidth / 2,
              cavityCenterY,
              opening.z,
            ),
            { renderOrder: 18 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            cavityWallThickness,
            shellDepth,
            shellHeight,
            shellColor,
            new THREE.Vector3(
              opening.x + shellWidth / 2,
              cavityCenterY,
              opening.z,
            ),
            { renderOrder: 18 },
          ),
        );
        group.add(
          createLocalBoxMesh(
            opening.coilWidth,
            coilDepth,
            opening.coilHeight,
            coilCoreColor,
            new THREE.Vector3(opening.x, coilCenterY, opening.z),
            { renderOrder: 20 },
          ),
        );
        for (let finIndex = 0; finIndex < opening.coilFinCount; finIndex += 1) {
          group.add(
            createLocalBoxMesh(
              opening.coilWidth * 0.98,
              Math.max(2.2, coilDepth * 0.22),
              Math.max(1.2, opening.coilHeight * 0.028),
              coilFinColor,
              new THREE.Vector3(
                opening.x,
                coilCenterY -
                  opening.cavityDirection * Math.max(0.6, coilDepth * 0.06),
                opening.z -
                  opening.coilHeight * 0.42 +
                  finIndex *
                    ((opening.coilHeight * 0.84) /
                      Math.max(1, opening.coilFinCount - 1)),
              ),
              { renderOrder: 21 },
            ),
          );
        }
        group.add(
          createLocalBoxMesh(
            opening.openingWidth * 0.74,
            cavityBackDepth,
            opening.openingHeight * 0.56,
            backColor,
            new THREE.Vector3(opening.x, backY, opening.z),
            { renderOrder: 18 },
          ),
        );
      };

      group.add(
        createRoundedLocalExtrudedMesh(
          ducted.baseWidth,
          ducted.baseDepth,
          ducted.unitHeight,
          shellCornerRadius,
          DUCTED_INDOOR_UNIT_COLOR_PALETTE.shell,
          new THREE.Vector3(0, 0, ducted.unitHeight / 2),
          {
            bevelThickness: Math.min(ducted.unitHeight * 0.08, 8),
            bevelSize: Math.min(ducted.baseWidth, ducted.baseDepth) * 0.012,
          },
        ),
      );
      addRaisedPlate(
        ducted.casingInset,
        DUCTED_INDOOR_UNIT_COLOR_PALETTE.casingInset,
        Math.max(10, ducted.unitHeight * 0.06),
        ducted.unitHeight - Math.max(10, ducted.unitHeight * 0.06) / 2 - 6,
      );
      addRaisedPlate(
        ducted.returnSection,
        DUCTED_INDOOR_UNIT_COLOR_PALETTE.returnSection,
      );
      addRaisedPlate(
        ducted.fanSection,
        DUCTED_INDOOR_UNIT_COLOR_PALETTE.fanSection,
      );
      addRaisedPlate(
        ducted.dischargeSection,
        DUCTED_INDOOR_UNIT_COLOR_PALETTE.dischargeSection,
      );
      addRaisedPlate(
        ducted.dischargeOpening,
        DUCTED_INDOOR_UNIT_COLOR_PALETTE.dischargeFace,
        plateHeight,
        ducted.unitHeight - plateHeight / 2 - 3,
        19,
      );
      addRaisedPlate(
        ducted.serviceBox,
        DUCTED_INDOOR_UNIT_COLOR_PALETTE.serviceBox,
        Math.max(panelHeight, ducted.unitHeight * 0.06),
        ducted.unitHeight -
          Math.max(panelHeight, ducted.unitHeight * 0.06) / 2 -
          4,
      );
      addRaisedPlate(
        ducted.electricalCover,
        DUCTED_INDOOR_UNIT_COLOR_PALETTE.electricalCover,
        Math.max(4, plateHeight * 0.9),
        ducted.unitHeight - Math.max(4, plateHeight * 0.9) / 2 - 2,
        19,
      );

      ducted.hangerBrackets.forEach((bracket) => {
        group.add(
          createLocalBoxMesh(
            bracket.width,
            bracket.depth,
            Math.max(10, bracket.height),
            DUCTED_INDOOR_UNIT_COLOR_PALETTE.bracket,
            new THREE.Vector3(
              bracket.x,
              bracket.y,
              Math.max(10, bracket.height) / 2,
            ),
            { renderOrder: 17 },
          ),
        );
      });

      ducted.sectionDividers.forEach((divider) => {
        addTopLine(
          divider,
          DUCTED_INDOOR_UNIT_COLOR_PALETTE.sectionLine,
          lineThickness,
        );
      });
      ducted.filterRails.forEach((rail) => {
        addTopLine(
          rail,
          DUCTED_INDOOR_UNIT_COLOR_PALETTE.sectionLine,
          Math.max(3, lineThickness * 0.82),
        );
      });
      ducted.fanRibs.forEach((rib, index) => {
        addTopLine(
          rib,
          index === 0 || index === ducted.fanRibs.length - 1
            ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.sectionLineSecondary
            : DUCTED_INDOOR_UNIT_COLOR_PALETTE.sectionLine,
          Math.max(3, lineThickness * 0.72),
        );
      });

      ducted.airOpenings.forEach((opening) => {
        addInlineAirOpening(opening);
      });

      group.add(
        createLocalBoxMesh(
          ducted.serviceBox.width * 0.68,
          Math.max(4, ducted.serviceBox.depth * 0.08),
          Math.max(2, plateHeight * 0.8),
          DUCTED_INDOOR_UNIT_COLOR_PALETTE.serviceHighlight,
          new THREE.Vector3(
            ducted.serviceBox.x,
            ducted.serviceBox.y - ducted.serviceBox.depth * 0.18,
            ducted.unitHeight - Math.max(2, plateHeight * 0.8) / 2 - 1,
          ),
          { renderOrder: 19 },
        ),
      );

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
        if (port.kind === "liquid") {
          group.add(
            createLocalCylinderMesh(
              port.bandRadius,
              port.bandRadius,
              3,
              port.bandColor,
              new THREE.Vector3(port.x + port.bandOffsetX, port.y, port.z),
              {
                rotation: new THREE.Euler(0, 0, Math.PI / 2),
                radialSegments: 16,
              },
            ),
          );
        }
      });
      break;
    }
    case "outdoor-unit": {
      const footHeight = Math.max(35, height * 0.12);
      const cabinetHeight = Math.max(120, height - footHeight);
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
        createLocalBoxMesh(
          width,
          depth,
          cabinetHeight,
          palette.body,
          new THREE.Vector3(0, 0, footHeight + cabinetHeight / 2),
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
      const fanRadius = Math.min(width, cabinetHeight) * 0.23;
      group.add(
        createLocalCylinderMesh(
          fanRadius,
          fanRadius,
          Math.max(10, depth * 0.08),
          palette.grille,
          new THREE.Vector3(0, depth * 0.5, footHeight + cabinetHeight * 0.55),
          {
            radialSegments: 28,
          },
        ),
      );
      group.add(
        createLocalCylinderMesh(
          fanRadius * 0.78,
          fanRadius * 0.78,
          Math.max(14, depth * 0.1),
          palette.trim,
          new THREE.Vector3(0, depth * 0.49, footHeight + cabinetHeight * 0.55),
          {
            radialSegments: 28,
            openEnded: false,
          },
        ),
      );
      for (let bladeIndex = 0; bladeIndex < 3; bladeIndex += 1) {
        const blade = createLocalBoxMesh(
          fanRadius * 1.2,
          Math.max(5, depth * 0.04),
          Math.max(16, fanRadius * 0.16),
          palette.grille,
          new THREE.Vector3(0, depth * 0.5, footHeight + cabinetHeight * 0.55),
          { renderOrder: 18 },
        );
        blade.rotation.y = Math.PI / 2;
        blade.rotation.z = (Math.PI / 3) * bladeIndex;
        group.add(blade);
      }
      group.add(
        createLocalCylinderMesh(
          fanRadius * 0.16,
          fanRadius * 0.16,
          Math.max(18, depth * 0.12),
          palette.accent,
          new THREE.Vector3(0, depth * 0.51, footHeight + cabinetHeight * 0.55),
          { radialSegments: 18 },
        ),
      );
      break;
    }
    case "remote-controller":
    case "control-panel": {
      const panelHeight = Math.max(80, height);
      group.add(
        createLocalBoxMesh(
          width,
          depth * 0.78,
          panelHeight,
          palette.body,
          new THREE.Vector3(0, 0, panelHeight / 2),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.74,
          depth * 0.12,
          panelHeight * 0.44,
          "#202733",
          new THREE.Vector3(0, depth * 0.24, panelHeight * 0.62),
        ),
      );
      group.add(
        createLocalBoxMesh(
          width * 0.36,
          depth * 0.08,
          panelHeight * 0.1,
          palette.accent,
          new THREE.Vector3(0, depth * 0.29, panelHeight * 0.22),
        ),
      );
      break;
    }
    case "filter":
    case "accessory":
    default: {
      group.add(
        createLocalBoxMesh(
          width,
          depth,
          bodyHeight,
          palette.body,
          new THREE.Vector3(0, 0, bodyHeight / 2),
        ),
      );
      addVentSlats(group, {
        count: 5,
        width: width * 0.82,
        depth: 4,
        height: 6,
        startX: 0,
        startY: 0,
        startZ: bodyHeight * 0.28,
        stepZ: bodyHeight * 0.11,
        color: palette.grille,
      });
      break;
    }
  }

  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  return group;
}

function createDetailedFurnitureMesh(
  instance: SymbolInstance2D,
  definition: ArchitecturalObjectDefinition,
  widthMm: number,
  depthMm: number,
  heightMm: number,
  baseElevationMm: number,
): THREE.Group | null {
  if (!definition.renderType || !hasRenderer(definition.renderType)) {
    return null;
  }

  const model = createOptimizedFurnitureModel3D(
    definition.renderType,
    instance.properties,
  );
  model.rotation.x = Math.PI / 2;

  const rawBox = new THREE.Box3().setFromObject(model);
  if (rawBox.isEmpty()) {
    return null;
  }

  const rawSize = rawBox.getSize(new THREE.Vector3());
  const rawCenter = rawBox.getCenter(new THREE.Vector3());
  const minSourceSize = 0.001;

  // Furniture source geometry is authored in meters, while plan/world units are
  // millimeters. Scale directly against raw meter-sized bounds so each instance
  // lands at the intended mm dimensions.
  const scaleX = Math.max(0.001, widthMm / Math.max(rawSize.x, minSourceSize));
  const scaleY = Math.max(0.001, depthMm / Math.max(rawSize.y, minSourceSize));
  const scaleZ = Math.max(0.001, heightMm / Math.max(rawSize.z, minSourceSize));

  model.scale.set(scaleX, scaleY, scaleZ);
  model.position.set(
    -rawCenter.x * scaleX,
    -rawCenter.y * scaleY,
    -rawBox.min.z * scaleZ,
  );
  model.updateMatrixWorld(true);

  const finalBox = new THREE.Box3().setFromObject(model);
  const finalSize = finalBox.getSize(new THREE.Vector3());
  if (
    finalBox.isEmpty() ||
    !Number.isFinite(finalSize.x) ||
    !Number.isFinite(finalSize.y) ||
    !Number.isFinite(finalSize.z) ||
    finalSize.x < 1 ||
    finalSize.y < 1 ||
    finalSize.z < 1
  ) {
    return null;
  }

  model.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      child.renderOrder = 15;
    }
  });

  const group = new THREE.Group();
  group.add(model);
  group.position.set(instance.position.x, instance.position.y, baseElevationMm);
  group.rotation.z = THREE.MathUtils.degToRad(instance.rotation);
  group.name = `furniture-${instance.id}`;
  return group;
}

function createPlanGrid(
  points: Point2D[],
  elevation: number,
): THREE.GridHelper {
  const bounds = ensurePlanBounds(points);
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const span = Math.max(spanX, spanY, 1000);
  const step = niceStep(span / 10);
  const size = Math.ceil(span / step) * step + step * 2;
  const divisions = Math.max(2, Math.round(size / step));
  const grid = new THREE.GridHelper(size, divisions, 0xd8cec0, 0xd8cec0);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    elevation,
  );

  const material = grid.material;
  if (Array.isArray(material)) {
    material.forEach((entry) => {
      entry.transparent = true;
      entry.opacity = 0.18;
      entry.depthWrite = false;
      entry.depthTest = true;
      entry.toneMapped = false;
    });
  } else {
    material.transparent = true;
    material.opacity = 0.18;
    material.depthWrite = false;
    material.depthTest = true;
    material.toneMapped = false;
  }
  // Keep grid behind scene geometry; do not overlay it through walls/objects.
  grid.renderOrder = -10;

  return grid;
}

function mirrorXValue(x: number, pivotX: number): number {
  return pivotX * 2 - x;
}

function mirrorLabelAnchors(
  anchors: LabelAnchor[],
  pivotX: number,
): LabelAnchor[] {
  return anchors.map((anchor) => ({
    ...anchor,
    position: new THREE.Vector3(
      mirrorXValue(anchor.position.x, pivotX),
      anchor.position.y,
      anchor.position.z,
    ),
  }));
}

function applyMirroredPlanTransform(root: THREE.Group, pivotX: number): void {
  root.position.set(pivotX * 2, 0, 0);
  root.scale.set(-1, 1, 1);
  root.updateMatrixWorld(true);
}

function ensureDoubleSidedMaterials(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }

    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    materials.forEach((material) => {
      if (
        !material ||
        !("side" in material) ||
        material.side === THREE.DoubleSide
      ) {
        return;
      }

      material.side = THREE.DoubleSide;
      material.needsUpdate = true;
    });
  });
}

function definitionFallback(
  definitionId: string,
): ArchitecturalObjectDefinition {
  return {
    id: definitionId,
    name: "Object",
    category: "my-library",
    type: "custom",
    widthMm: 900,
    depthMm: 600,
    heightMm: 900,
    tags: ["custom"],
    view: "plan-2d",
  };
}

export function IsometricViewCanvas({
  className = "",
  walls,
  rooms,
  symbols,
  hvacElements,
  objectDefinitions,
  viewLabel = "ISOMETRIC VIEW",
}: IsometricViewCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const labelAnchorsRef = useRef<LabelAnchor[]>([]);
  const boundsRef = useRef<THREE.Box3 | null>(null);
  const sizeRef = useRef(DEFAULT_EMPTY_SIZE);
  const renderRequestedRef = useRef(true);
  const hasAutoFitRef = useRef(false);
  const isInteractingRef = useRef(false);
  const wallBandRequestIdRef = useRef(0);
  const lastResolvedWallBandSignatureRef = useRef("");
  const pendingWallBandSignatureRef = useRef("");
  const [containerSize, setContainerSize] = useState(DEFAULT_EMPTY_SIZE);
  const [screenLabels, setScreenLabels] = useState<ScreenLabel[]>([]);
  const [isEmpty, setIsEmpty] = useState(false);
  const [webglInitError, setWebglInitError] = useState<string | null>(null);
  const [wallBands, setWallBands] = useState<WallBand[]>([]);
  const [resolvedWallBandSignature, setResolvedWallBandSignature] =
    useState("");
  const [isWallBandsPending, setIsWallBandsPending] = useState(false);

  const definitionsById = useMemo(
    () =>
      new Map(
        objectDefinitions.map((definition) => [definition.id, definition]),
      ),
    [objectDefinitions],
  );
  const openingRenderOptionsById = useMemo<
    Record<string, OpeningRenderOptions>
  >(() => {
    const options: Record<string, OpeningRenderOptions> = {};
    symbols.forEach((instance) => {
      const definition =
        definitionsById.get(instance.symbolId) ??
        definitionFallback(instance.symbolId);
      if (definition.category !== "doors") {
        return;
      }

      options[instance.id] = {
        swingDirection:
          instance.properties?.swingDirection === "right" ? "right" : "left",
        openSide:
          instance.properties?.doorOpenSide === "negative"
            ? "negative"
            : "positive",
      };
    });
    return options;
  }, [definitionsById, symbols]);
  const wallsById = useMemo(
    () => new Map(walls.map((wall) => [wall.id, wall])),
    [walls],
  );
  const wallBandSignature = useMemo(
    () => buildIsometricWallBandsSignature(walls),
    [walls],
  );
  const activeWallBands =
    resolvedWallBandSignature === wallBandSignature ? wallBands : [];
  const showPendingWallBands =
    isWallBandsPending && walls.length > 0 && activeWallBands.length === 0;

  useEffect(() => {
    if (walls.length === 0) {
      wallBandRequestIdRef.current += 1;
      lastResolvedWallBandSignatureRef.current = "";
      pendingWallBandSignatureRef.current = "";
      setWallBands([]);
      setResolvedWallBandSignature("");
      setIsWallBandsPending(false);
      return;
    }

    if (
      wallBandSignature === lastResolvedWallBandSignatureRef.current ||
      wallBandSignature === pendingWallBandSignatureRef.current
    ) {
      return;
    }

    const requestId = ++wallBandRequestIdRef.current;
    pendingWallBandSignatureRef.current = wallBandSignature;
    setIsWallBandsPending(true);

    void buildIsometricWallBandsInBackground({
      signature: wallBandSignature,
      walls,
    })
      .then((nextWallBands) => {
        if (requestId !== wallBandRequestIdRef.current) {
          return;
        }

        pendingWallBandSignatureRef.current = "";
        lastResolvedWallBandSignatureRef.current = wallBandSignature;
        setWallBands(nextWallBands);
        setResolvedWallBandSignature(wallBandSignature);
        setIsWallBandsPending(false);
        renderRequestedRef.current = true;
      })
      .catch(() => {
        if (requestId !== wallBandRequestIdRef.current) {
          return;
        }

        pendingWallBandSignatureRef.current = "";
        setIsWallBandsPending(false);
      });
  }, [wallBandSignature, walls]);

  const renderViewport = useCallback(() => {
    const sceneState = sceneRef.current;
    if (!sceneState) {
      return;
    }

    const { renderer, scene, camera } = sceneState;
    const { width, height } = sizeRef.current;
    const box = boundsRef.current;
    if (box) {
      updateCameraClipping(camera, box);
    }
    renderer.render(scene, camera);
    if (!isInteractingRef.current) {
      setScreenLabels(
        projectLabels(labelAnchorsRef.current, camera, width, height),
      );
    }
  }, []);

  const resetView = useCallback(() => {
    const sceneState = sceneRef.current;
    const box = boundsRef.current;
    if (!sceneState || !box) {
      return;
    }

    const { camera, controls } = sceneState;
    const { width, height } = sizeRef.current;
    const target = fitCameraToBox(camera, box, width, height);
    controls.target.copy(target);
    controls.update();
    renderRequestedRef.current = true;
    renderViewport();
  }, [renderViewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas) {
      return;
    }

    setWebglInitError(null);

    const rendererConfigs: Array<
      Pick<
        THREE.WebGLRendererParameters,
        "antialias" | "alpha" | "powerPreference" | "logarithmicDepthBuffer"
      >
    > = [
      {
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
        logarithmicDepthBuffer: false,
      },
      {
        antialias: false,
        alpha: false,
        powerPreference: "high-performance",
        logarithmicDepthBuffer: false,
      },
      {
        antialias: false,
        alpha: false,
        powerPreference: "default",
        logarithmicDepthBuffer: false,
      },
      {
        antialias: false,
        alpha: true,
        powerPreference: "default",
        logarithmicDepthBuffer: false,
      },
    ];

    let renderer: THREE.WebGLRenderer | null = null;
    let rendererInitError: unknown = null;
    for (const config of rendererConfigs) {
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          ...config,
        });
        break;
      } catch (error) {
        rendererInitError = error;
      }
    }

    if (!renderer) {
      console.error(
        "Isometric renderer initialization failed:",
        rendererInitError,
      );
      sceneRef.current = null;
      boundsRef.current = null;
      labelAnchorsRef.current = [];
      setScreenLabels([]);
      setIsEmpty(true);
      setWebglInitError(
        "Unable to create WebGL context. Close other 3D tabs or check browser hardware acceleration settings.",
      );
      return;
    }

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      console.warn(
        "[IsometricView] WebGL context lost — will attempt recovery",
      );
      setWebglInitError("WebGL context was lost. Attempting to recover…");
      setScreenLabels([]);
    };

    const handleContextRestored = () => {
      console.info("[IsometricView] WebGL context restored");
      setWebglInitError(null);
      // Force full scene rebuild on next data change
      renderRequestedRef.current = true;
      hasAutoFitRef.current = false;
    };

    canvas.addEventListener("webglcontextlost", handleContextLost, false);
    canvas.addEventListener(
      "webglcontextrestored",
      handleContextRestored,
      false,
    );

    // Cap pixel ratio at 1.5 to reduce GPU fill-rate pressure.
    // Full retina (2x) causes 4x pixel count which is the top contributor to
    // GPU stalls and context-loss on integrated graphics.
    const effectivePixelRatio =
      typeof window !== "undefined"
        ? Math.min(window.devicePixelRatio || 1, 1.5)
        : 1;
    renderer.setPixelRatio(effectivePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor("#f5efe1", 1);
    // Disable automatic info.reset() so we can monitor cumulative stats
    renderer.info.autoReset = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#f5efe1");

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEGREES, 1, 1, 50000);
    camera.up.set(0, 0, 1);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.zoomSpeed = 1.1;
    controls.rotateSpeed = 0.72;
    controls.panSpeed = 1.1;
    controls.minPolarAngle = MIN_POLAR_ANGLE;
    controls.maxPolarAngle = MAX_POLAR_ANGLE;
    controls.minDistance = MIN_CAMERA_DISTANCE;
    controls.maxDistance = MAX_CAMERA_DISTANCE;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    controls.cursorStyle = "grab";
    if (container) {
      controls.listenToKeyEvents(container);
    }
    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none";

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
    const keyLight = new THREE.DirectionalLight(0xfff6ee, 1.15);
    keyLight.position.set(7000, 5000, 9000);
    const fillLight = new THREE.DirectionalLight(0xd9e5f2, 0.55);
    fillLight.position.set(-5000, 4000, 3500);

    scene.add(ambientLight, keyLight, fillLight);

    const contentRoot = new THREE.Group();
    const geometryRoot = new THREE.Group();
    contentRoot.add(geometryRoot);
    scene.add(contentRoot);

    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener("contextmenu", preventContextMenu);

    controls.addEventListener("start", () => {
      isInteractingRef.current = true;
      canvas.style.cursor = "grabbing";
      setScreenLabels([]);
      renderRequestedRef.current = true;
    });
    controls.addEventListener("change", () => {
      renderRequestedRef.current = true;
    });
    controls.addEventListener("end", () => {
      isInteractingRef.current = false;
      canvas.style.cursor = "grab";
      renderRequestedRef.current = true;
    });

    sceneRef.current = {
      renderer,
      scene,
      camera,
      controls,
      contentRoot,
      geometryRoot,
    };

    let frameId = 0;
    let idleFrames = 0;
    const MAX_IDLE_FRAMES = 180; // Stop rendering after ~3 seconds of no change

    const animate = () => {
      frameId = window.requestAnimationFrame(animate);

      // With damping enabled, controls.update() returns true while damping is active
      const controlsChanged = controls.update();

      const needsRender =
        controlsChanged ||
        renderRequestedRef.current ||
        isInteractingRef.current;

      if (needsRender) {
        renderRequestedRef.current = false;
        idleFrames = 0;
        renderer.info.reset();
        renderViewport();
      } else {
        idleFrames++;
        // After settling, re-project labels once if interaction just ended
        if (idleFrames === 2) {
          const { width, height } = sizeRef.current;
          setScreenLabels(
            projectLabels(labelAnchorsRef.current, camera, width, height),
          );
        }
      }
    };
    frameId = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(frameId);
      controls.stopListenToKeyEvents();
      controls.dispose();
      canvas.removeEventListener("contextmenu", preventContextMenu);
      canvas.removeEventListener("webglcontextlost", handleContextLost, false);
      canvas.removeEventListener(
        "webglcontextrestored",
        handleContextRestored,
        false,
      );
      clearGroup(contentRoot);
      renderer.dispose();
      sceneRef.current = null;
    };
  }, [renderViewport]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerSize({
          width: Math.max(1, Math.floor(width)),
          height: Math.max(1, Math.floor(height)),
        });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    sizeRef.current = containerSize;

    const sceneState = sceneRef.current;
    if (!sceneState) {
      return;
    }

    const { renderer, camera, controls } = sceneState;
    const width = Math.max(1, containerSize.width);
    const height = Math.max(1, containerSize.height);
    renderer.setPixelRatio(
      typeof window !== "undefined"
        ? Math.min(window.devicePixelRatio || 1, 1.5)
        : 1,
    );
    renderer.setSize(width, height, false);
    resizeCameraFrustum(camera, width, height);
    controls.update();
    renderRequestedRef.current = true;
  }, [containerSize]);

  useEffect(() => {
    const sceneState = sceneRef.current;
    if (!sceneState) {
      return;
    }

    const { camera, controls, contentRoot, geometryRoot } = sceneState;
    contentRoot.position.set(0, 0, 0);
    contentRoot.scale.set(1, 1, 1);
    contentRoot.rotation.set(0, 0, 0);
    contentRoot.updateMatrixWorld(true);
    clearGroup(geometryRoot);
    [...contentRoot.children].forEach((child) => {
      if (child === geometryRoot) {
        return;
      }

      contentRoot.remove(child);
      disposeObject(child);
    });

    const width = Math.max(1, sizeRef.current.width);
    const height = Math.max(1, sizeRef.current.height);

    const labelAnchors: LabelAnchor[] = [];
    const planPoints: Point2D[] = [];
    let lowestElevation = 0;

    rooms.forEach((room) => {
      const floor = createRoomFloor(room);
      if (floor) {
        geometryRoot.add(floor);
        planPoints.push(...sanitizeRing(room.vertices));
      }

      const floorElevation = room.properties3D.floorElevation ?? 0;
      lowestElevation = Math.min(lowestElevation, floorElevation);
      labelAnchors.push({
        key: `room-${room.id}`,
        position: new THREE.Vector3(
          room.centroid.x,
          room.centroid.y,
          floorElevation + 12,
        ),
        text: `${room.name} ${(room.area / 1_000_000).toFixed(1)}m2`,
        color: "#334155",
      });
    });

    // Render all wall geometry as unified bands. The union system merges
    // all walls (including those with openings) into continuous corner
    // geometry. Openings are punched as holes in the appropriate height bands.
    activeWallBands.forEach((band) => {
      const wallMesh = createWallMesh(
        band.polygon,
        band.baseElevation,
        band.height,
        band.palette,
        band.showOutline ?? true,
        band.showTopCap ?? true,
        band.topCapInsetMm ?? 0,
      );
      if (wallMesh) {
        wallMesh.name = band.name;
        geometryRoot.add(wallMesh);
        band.polygon.forEach((ring) => {
          planPoints.push(...sanitizeRing(ring));
        });
      }
      lowestElevation = Math.min(lowestElevation, band.baseElevation);
    });

    const renderedOpeningIds = new Set<string>();
    walls.forEach((wall) => {
      if (!wall.openings || wall.openings.length === 0) {
        return;
      }

      const openingsGroup = createWallOpenings3D(
        wall,
        openingRenderOptionsById,
      );
      if (openingsGroup.children.length === 0) {
        return;
      }

      openingsGroup.name = `wall-openings-${wall.id}`;
      openingsGroup.renderOrder = 14;
      geometryRoot.add(openingsGroup);
      wall.openings.forEach((opening) => renderedOpeningIds.add(opening.id));
    });

    const pipeEndpointStateMap =
      buildRefrigerantPipeEndpointRenderStateMap(hvacElements);
    const pipeRenderChainStateMap = buildRefrigerantPipeRenderChainStateMap(
      hvacElements,
      pipeEndpointStateMap,
    );

    hvacElements.forEach((element) => {
      const mesh = createHvacEquipmentMesh(
        element,
        pipeEndpointStateMap,
        pipeRenderChainStateMap,
      );
      mesh.updateMatrixWorld(true);
      const meshBounds = new THREE.Box3().setFromObject(mesh);
      const labelColor = hvacPaletteForElement(element).label;
      geometryRoot.add(mesh);

      // Pipe elements intentionally render without floating labels.
      const isPipeElement =
        element.type === "refrigerant-pipe" ||
        element.type === "refrigerant-pipe-pair";

      if (!meshBounds.isEmpty()) {
        lowestElevation = Math.min(lowestElevation, meshBounds.min.z);
        planPoints.push(
          { x: meshBounds.min.x, y: meshBounds.min.y },
          { x: meshBounds.max.x, y: meshBounds.min.y },
          { x: meshBounds.max.x, y: meshBounds.max.y },
          { x: meshBounds.min.x, y: meshBounds.max.y },
        );
        if (!isPipeElement) {
          labelAnchors.push({
            key: `hvac-${element.id}`,
            position: new THREE.Vector3(
              (meshBounds.min.x + meshBounds.max.x) / 2,
              (meshBounds.min.y + meshBounds.max.y) / 2,
              meshBounds.max.z + 30,
            ),
            text: element.label || element.type,
            color: labelColor,
          });
        }
        return;
      }

      lowestElevation = Math.min(lowestElevation, element.elevation);
      planPoints.push(
        { x: element.position.x, y: element.position.y },
        { x: element.position.x + element.width, y: element.position.y },
        {
          x: element.position.x + element.width,
          y: element.position.y + element.depth,
        },
        { x: element.position.x, y: element.position.y + element.depth },
      );
      if (!isPipeElement) {
        labelAnchors.push({
          key: `hvac-${element.id}`,
          position: new THREE.Vector3(
            element.position.x + element.width / 2,
            element.position.y + element.depth / 2,
            element.elevation + Math.max(80, element.height) + 30,
          ),
          text: element.label || element.type,
          color: labelColor,
        });
      }
    });

    symbols.forEach((instance) => {
      const definition =
        definitionsById.get(instance.symbolId) ??
        definitionFallback(instance.symbolId);
      const scaleFactor =
        Number.isFinite(instance.scale) && instance.scale > 0
          ? instance.scale
          : 1;
      const baseWidth =
        readNumberProperty(instance.properties, "widthMm") ??
        definition.widthMm;
      const baseDepth =
        readNumberProperty(instance.properties, "depthMm") ??
        definition.depthMm;
      const baseHeight =
        readNumberProperty(instance.properties, "heightMm") ??
        definition.heightMm;
      const widthMm = Math.max(60, baseWidth * scaleFactor);
      let depthMm = Math.max(40, baseDepth * scaleFactor);
      const heightMm = Math.max(
        definition.category === "symbols" ? 140 : 240,
        baseHeight * scaleFactor,
      );
      const isOpeningCategory =
        definition.category === "doors" || definition.category === "windows";
      const isDetailedFurnitureCategory =
        (definition.category === "furniture" ||
          definition.category === "fixtures" ||
          definition.category === "my-library") &&
        !!definition.renderType &&
        hasRenderer(definition.renderType);
      const baseElevationFromProps = readNumberProperty(
        instance.properties,
        "baseElevationMm",
      );
      const baseElevation =
        baseElevationFromProps ??
        (definition.category === "windows"
          ? (definition.sillHeightMm ?? 900)
          : 0);

      // If this door/window is already rendered via wall opening geometry,
      // skip the simplified symbol box to avoid losing detail.
      if (isOpeningCategory && renderedOpeningIds.has(instance.id)) {
        lowestElevation = Math.min(lowestElevation, baseElevation);
        if (definition.category !== "symbols") {
          labelAnchors.push({
            key: `object-${instance.id}`,
            position: new THREE.Vector3(
              instance.position.x,
              instance.position.y,
              baseElevation + heightMm + 30,
            ),
            text: definition.name,
            color: "#334155",
          });
        }
        return;
      }

      if (isDetailedFurnitureCategory) {
        const detailedFurniture = createDetailedFurnitureMesh(
          instance,
          definition,
          widthMm,
          depthMm,
          heightMm,
          baseElevation,
        );
        if (detailedFurniture) {
          geometryRoot.add(detailedFurniture);
          lowestElevation = Math.min(lowestElevation, baseElevation);
          const halfWidth = widthMm / 2;
          const halfDepth = depthMm / 2;
          planPoints.push(
            {
              x: instance.position.x - halfWidth,
              y: instance.position.y - halfDepth,
            },
            {
              x: instance.position.x + halfWidth,
              y: instance.position.y - halfDepth,
            },
            {
              x: instance.position.x + halfWidth,
              y: instance.position.y + halfDepth,
            },
            {
              x: instance.position.x - halfWidth,
              y: instance.position.y + halfDepth,
            },
          );
          labelAnchors.push({
            key: `object-${instance.id}`,
            position: new THREE.Vector3(
              instance.position.x,
              instance.position.y,
              baseElevation + heightMm + 30,
            ),
            text: definition.name,
            color: "#334155",
          });
          return;
        }
      }

      if (isOpeningCategory) {
        const hostWallId =
          typeof instance.properties.hostWallId === "string"
            ? instance.properties.hostWallId
            : null;
        const hostWallThickness =
          readNumberProperty(instance.properties, "hostWallThicknessMm") ??
          (hostWallId ? wallsById.get(hostWallId)?.thickness : null);
        const targetThickness = hostWallThickness ?? depthMm;
        const inset = Math.min(
          OPENING_SURFACE_INSET_MM,
          Math.max(0.8, targetThickness * 0.05),
        );
        depthMm = Math.max(10, targetThickness - inset * 2);
      }
      const mesh = createBoxMesh(
        new THREE.Vector3(
          instance.position.x,
          instance.position.y,
          baseElevation + heightMm / 2,
        ),
        widthMm,
        depthMm,
        heightMm,
        solidPalette(definition.category),
        instance.rotation,
      );
      geometryRoot.add(mesh);

      lowestElevation = Math.min(lowestElevation, baseElevation);
      const halfWidth = widthMm / 2;
      const halfDepth = depthMm / 2;
      planPoints.push(
        {
          x: instance.position.x - halfWidth,
          y: instance.position.y - halfDepth,
        },
        {
          x: instance.position.x + halfWidth,
          y: instance.position.y - halfDepth,
        },
        {
          x: instance.position.x + halfWidth,
          y: instance.position.y + halfDepth,
        },
        {
          x: instance.position.x - halfWidth,
          y: instance.position.y + halfDepth,
        },
      );

      if (definition.category !== "symbols") {
        labelAnchors.push({
          key: `object-${instance.id}`,
          position: new THREE.Vector3(
            instance.position.x,
            instance.position.y,
            baseElevation + heightMm + 30,
          ),
          text: definition.name,
          color: "#334155",
        });
      }
    });

    const hasGeometry = geometryRoot.children.length > 0;
    setIsEmpty(!hasGeometry);

    if (!hasGeometry) {
      labelAnchorsRef.current = [];
      boundsRef.current = null;
      hasAutoFitRef.current = false;
      controls.enabled = false;
      setScreenLabels([]);
      fitCameraToBox(camera, new THREE.Box3(), width, height);
      controls.target.set(0, 0, 0);
      controls.update();
      renderRequestedRef.current = true;
      return;
    }

    const grid = createPlanGrid(planPoints, lowestElevation - 1);
    contentRoot.add(grid);

    const unmirroredBox = new THREE.Box3().setFromObject(geometryRoot);
    const mirrorPivotX = (unmirroredBox.min.x + unmirroredBox.max.x) / 2;

    applyMirroredPlanTransform(contentRoot, mirrorPivotX);
    ensureDoubleSidedMaterials(geometryRoot);
    labelAnchorsRef.current = mirrorLabelAnchors(labelAnchors, mirrorPivotX);

    const box = new THREE.Box3().setFromObject(geometryRoot);
    boundsRef.current = box.clone();
    controls.enabled = true;
    updateControlDistanceLimits(controls, box);
    if (!hasAutoFitRef.current || !box.containsPoint(controls.target)) {
      const target = fitCameraToBox(camera, box, width, height);
      controls.target.copy(target);
      hasAutoFitRef.current = true;
    } else {
      updateCameraClipping(camera, box);
    }
    controls.update();
    renderRequestedRef.current = true;
  }, [
    activeWallBands,
    definitionsById,
    hvacElements,
    openingRenderOptionsById,
    rooms,
    symbols,
    walls,
    wallsById,
  ]);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden ${className}`}
      tabIndex={0}
      onPointerDown={() => containerRef.current?.focus()}
      style={{
        minHeight: 220,
        background: "linear-gradient(180deg, #faf5ea 0%, #f1eadf 100%)",
        outline: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        onDoubleClick={resetView}
      />
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute left-1/2 top-1 -translate-x-1/2 text-[12px] tracking-[0.18em] text-slate-600"
          style={{ fontFamily: "monospace" }}
        >
          {viewLabel}
        </div>
        {webglInitError && (
          <div
            className="absolute left-1/2 top-1/2 w-[min(92%,680px)] -translate-x-1/2 -translate-y-1/2 rounded border border-rose-300/70 bg-white/90 px-4 py-3 text-center text-sm text-rose-700 shadow"
            style={{ fontFamily: "monospace" }}
          >
            {webglInitError}
          </div>
        )}
        {showPendingWallBands && !webglInitError && (
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm text-slate-500"
            style={{ fontFamily: "monospace" }}
          >
            Preparing isometric wall geometry...
          </div>
        )}
        {isEmpty && !webglInitError && !showPendingWallBands && (
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm text-slate-500"
            style={{ fontFamily: "monospace" }}
          >
            No plan geometry available for isometric view
          </div>
        )}
        {screenLabels.map((label) => (
          <div
            key={label.key}
            className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap border border-slate-300/60 bg-white/82 px-2 py-0.5 text-[11px] shadow-sm"
            style={{
              left: `${label.x}px`,
              top: `${label.y}px`,
              color: label.color,
              fontFamily: "monospace",
            }}
          >
            {label.text}
          </div>
        ))}
        {!isEmpty && !webglInitError && (
          <div
            className="absolute bottom-3 left-3 rounded border border-slate-300/55 bg-white/76 px-3 py-1.5 text-[11px] text-slate-600 shadow-sm"
            style={{ fontFamily: "monospace" }}
          >
            Drag rotate | Right-drag pan | Wheel zoom | Double-click reset
          </div>
        )}
      </div>
      <div className="absolute right-3 top-3 flex gap-2">
        <button
          type="button"
          onClick={resetView}
          disabled={isEmpty || Boolean(webglInitError)}
          className="rounded border border-amber-300/80 bg-white/88 px-3 py-1.5 text-xs text-slate-700 shadow-sm transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          style={{ fontFamily: "monospace" }}
        >
          Reset View
        </button>
      </div>
    </div>
  );
}
