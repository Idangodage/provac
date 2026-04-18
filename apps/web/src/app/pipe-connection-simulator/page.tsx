"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type PipeMaterial = "hard" | "flexible";
type PipeLineKind = "gas" | "liquid";
type ConnectionEnd = "start" | "end";
type EditMode = "select" | "add" | "delete";
type FittingType =
  | "coupler"
  | "elbow45"
  | "elbow90"
  | "adapter"
  | "invalid"
  | "none"
  | "endpoint";
type SpanScope =
  | "start-sleeve"
  | "start-transition"
  | "interior"
  | "end-transition"
  | "end-sleeve";

type WarningCode =
  | "INSULATION_CLASH"
  | "INADEQUATE_GAP"
  | "CONDENSATION_RISK"
  | "INVALID_HARD_CONNECTION"
  | "BEND_IN_SLEEVE"
  | "ZERO_LENGTH_SEGMENT"
  | "FLEX_KINK";

interface Point2D {
  x: number;
  y: number;
}

interface PipeVertex {
  id: string;
  x: number;
  y: number;
  incomingMaterial: PipeMaterial;
}

interface PipeRoute {
  id: string;
  lineKind: PipeLineKind;
  vertices: PipeVertex[];
}

interface EndpointRule {
  gas: PipeMaterial;
  liquid: PipeMaterial;
}

interface WarningItem {
  code: WarningCode;
  title: string;
  detail: string;
  severity: "error" | "warning";
  spanIds: string[];
}

interface ConnectionAnalysis {
  requiredCenterSpacingMm: number;
  actualMinimumSpacingMm: number;
  actualMinimumAirGapMm: number;
  lowGapLengthMm: number;
  bendCount: number;
  materialBreakdownMm: Record<PipeMaterial, number>;
  hardGasMm: number;
  flexGasMm: number;
  hardLiquidMm: number;
  flexLiquidMm: number;
  elbow45Count: number;
  elbow90Count: number;
  adapterCount: number;
  kinkWarningCount: number;
  hardBendInTightZoneCount: number;
  invalidHardAngleCount: number;
  zeroLengthCount: number;
  condensationRisk: boolean;
  sleeveClash: boolean;
  inadequateGap: boolean;
  startSleeveGapMm: number;
  endSleeveGapMm: number;
  warningItems: WarningItem[];
  problemSpanIds: string[];
}

interface ScenarioPreset {
  id: string;
  name: string;
  description: string;
  unitX: number;
  unitY: number;
  pipes: PipeRoute[];
  endpointRules: Record<ConnectionEnd, EndpointRule>;
  gasDiameterMm: number;
  liquidDiameterMm: number;
  sleeveLengthMm: number;
  insulationThicknessMm: number;
  extraGapMm: number;
  tightZoneMm: number;
  minBendRadiusMm: number;
  fieldPitchMm: number;
  fieldShiftY: number;
  offsetOwner: "auto" | PipeLineKind;
}

interface SimulatorState {
  unitX: number;
  unitY: number;
  gasDiameterMm: number;
  liquidDiameterMm: number;
  sleeveLengthMm: number;
  insulationThicknessMm: number;
  extraGapMm: number;
  tightZoneMm: number;
  minBendRadiusMm: number;
  fieldPitchMm: number;
  fieldShiftY: number;
  offsetOwner: "auto" | PipeLineKind;
  endpointRules: Record<ConnectionEnd, EndpointRule>;
  pipes: PipeRoute[];
  lastPresetId: string;
}

interface SafeZoneRect {
  id: string;
  label: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface EndpointLayout {
  gasPort: Point2D;
  liquidPort: Point2D;
  gasSleeveEnd: Point2D;
  liquidSleeveEnd: Point2D;
  safeZone: SafeZoneRect;
}

interface SemanticSpan {
  id: string;
  routeId: string;
  lineKind: PipeLineKind;
  scope: SpanScope;
  material: PipeMaterial;
  start: Point2D;
  end: Point2D;
  vertexIndex: number | null;
  selectable: boolean;
}

interface RenderSpan extends SemanticSpan {
  d: string;
  renderPoints: Point2D[];
  samplePoints: Point2D[];
  lengthMm: number;
  invalidHard: boolean;
}

interface PathNode {
  id: string;
  p: Point2D;
  kind: "port" | "sleeveEnd" | "auto" | "vertex" | "fieldSleeveEnd" | "fieldPort";
  lineKind: PipeLineKind;
  vertexIndex: number | null;
  incomingMaterial: PipeMaterial | null;
  incomingSpanId: string | null;
  fitting: FittingType;
  cumFromStartMm: number;
  cumFromEndMm: number;
  inTightZone: boolean;
  inStartTightZone: boolean;
  inEndTightZone: boolean;
}

interface RouteGeometry {
  routeId: string;
  lineKind: PipeLineKind;
  spans: RenderSpan[];
  nodes: PathNode[];
  polyline: Point2D[];
  actualLengthMm: number;
  kinkVertexIndices: number[];
  hardBendNodeIds: string[];
  invalidNodeIds: string[];
  invalidSpanIds: string[];
  zeroLengthSpanIds: string[];
  flexBendCount: number;
}

interface SimulationData {
  requiredCenterSpacingMm: number;
  resolvedOffsetOwner: PipeLineKind;
  startLayout: EndpointLayout;
  endLayout: EndpointLayout;
  safeZones: SafeZoneRect[];
  routes: Record<PipeLineKind, RouteGeometry>;
  analysis: ConnectionAnalysis;
}

interface SelectedSpan {
  lineKind: PipeLineKind;
  scope: "start-transition" | "interior" | "end-transition";
  vertexIndex: number | null;
}

interface SelectedVertex {
  lineKind: PipeLineKind;
  vertexIndex: number;
}

interface HoverInsert {
  lineKind: PipeLineKind;
  spanId: string;
  scope: "start-transition" | "interior" | "end-transition";
  vertexIndex: number | null;
  point: Point2D;
}

type DragState =
  | {
      kind: "unit";
      offset: Point2D;
    }
  | {
      kind: "vertex";
      lineKind: PipeLineKind;
      vertexIndex: number;
      offset: Point2D;
    };

interface SampleSegment {
  start: Point2D;
  end: Point2D;
  spanId: string;
}

const SCENE_WIDTH = 1280;
const SCENE_HEIGHT = 760;
const DEFAULT_UNIT_X = 92;
const DEFAULT_UNIT_Y = 208;
const UNIT_WIDTH = 252;
const UNIT_HEIGHT = 188;
const FIELD_X = 1090;
const FIELD_MANIFOLD_WIDTH = 84;
const FIELD_MANIFOLD_HEIGHT = 156;
const UNIT_PORT_PITCH_MM = 56;
const SLEEVE_ZONE_PADDING_MM = 28;
const ZERO_LENGTH_TOLERANCE_MM = 0.5;
const SAMPLE_STEP_MM = 8;
const MIN_SEGMENT_MM = 28;
const HIT_TOLERANCE_MM = 22;
const CURVE_SAMPLES = 16;
const HARD_ANGLE_TOLERANCE_DEG = 4;
const GAS_COLOR = "#bf6b37";
const LIQUID_COLOR = "#2d7cc0";
const FLEX_DASH = "12 10";
const INSULATION_COLOR = "#3f4247";
const GAS_FILL = "#e7b18d";
const LIQUID_FILL = "#a8c7e2";
const UNIT_FILL = "#fffaf2";
const SAFE_ZONE_FILL = "rgba(245,158,11,0.08)";
const SAFE_ZONE_STROKE = "rgba(217,119,6,0.28)";
const KINK_HALO = "rgba(239,68,68,0.28)";
const TIGHT_HALO = "rgba(245,158,11,0.20)";

let localIdCounter = 0;

function nextId(prefix: string): string {
  localIdCounter += 1;
  return `${prefix}-${localIdCounter}`;
}

function clonePoint(point: Point2D): Point2D {
  return { x: point.x, y: point.y };
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(point: Point2D, amount: number): Point2D {
  return { x: point.x * amount, y: point.y * amount };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function length(point: Point2D): number {
  return Math.hypot(point.x, point.y);
}

function distance(a: Point2D, b: Point2D): number {
  return length(subtract(a, b));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalize(point: Point2D): Point2D {
  const pointLength = length(point);
  if (pointLength <= 0.00001) {
    return { x: 0, y: 0 };
  }
  return scale(point, 1 / pointLength);
}

function lineIntersection(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): Point2D | null {
  const denominator =
    (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
  if (Math.abs(denominator) <= 0.00001) {
    return null;
  }

  const determinantA = a1.x * a2.y - a1.y * a2.x;
  const determinantB = b1.x * b2.y - b1.y * b2.x;

  return {
    x:
      (determinantA * (b1.x - b2.x) - (a1.x - a2.x) * determinantB) /
      denominator,
    y:
      (determinantA * (b1.y - b2.y) - (a1.y - a2.y) * determinantB) /
      denominator,
  };
}

function projectPointOnSegment(point: Point2D, start: Point2D, end: Point2D): {
  point: Point2D;
  t: number;
  distance: number;
} {
  const delta = subtract(end, start);
  const deltaLengthSquared = dot(delta, delta);
  if (deltaLengthSquared <= 0.00001) {
    return { point: clonePoint(start), t: 0, distance: distance(point, start) };
  }

  const t = clamp(dot(subtract(point, start), delta) / deltaLengthSquared, 0, 1);
  const projected = add(start, scale(delta, t));
  return { point: projected, t, distance: distance(point, projected) };
}

function pointInRect(point: Point2D, rect: SafeZoneRect): boolean {
  return (
    point.x >= rect.minX &&
    point.x <= rect.maxX &&
    point.y >= rect.minY &&
    point.y <= rect.maxY
  );
}

function pointsEqual(a: Point2D, b: Point2D): boolean {
  return distance(a, b) <= 0.01;
}

function dedupePolyline(points: Point2D[]): Point2D[] {
  const deduped: Point2D[] = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (!previous || !pointsEqual(previous, point)) {
      deduped.push(clonePoint(point));
    }
  }
  return deduped;
}

function polylineLength(points: Point2D[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1]!, points[index]!);
  }
  return total;
}

function segmentLength(segment: { start: Point2D; end: Point2D }): number {
  return distance(segment.start, segment.end);
}

function formatMm(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} mm`;
}

function resolveOffsetOwner(
  offsetOwner: "auto" | PipeLineKind,
  gasDiameterMm: number,
  liquidDiameterMm: number
): PipeLineKind {
  if (offsetOwner !== "auto") {
    return offsetOwner;
  }
  return liquidDiameterMm <= gasDiameterMm ? "liquid" : "gas";
}

type Dir8 = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

const DIR_DEGREES: Record<Dir8, number> = {
  E: 0,
  NE: 45,
  N: 90,
  NW: 135,
  W: 180,
  SW: 225,
  S: 270,
  SE: 315,
};

function hardDirection(from: Point2D, to: Point2D): Dir8 | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) <= ZERO_LENGTH_TOLERANCE_MM && Math.abs(dy) <= ZERO_LENGTH_TOLERANCE_MM) {
    return null;
  }
  if (Math.abs(dx) <= 0.5) {
    return dy > 0 ? "S" : "N";
  }
  if (Math.abs(dy) <= 0.5) {
    return dx > 0 ? "E" : "W";
  }
  if (Math.abs(Math.abs(dx) - Math.abs(dy)) <= 1.5) {
    if (dx > 0 && dy < 0) {
      return "NE";
    }
    if (dx > 0 && dy > 0) {
      return "SE";
    }
    if (dx < 0 && dy < 0) {
      return "NW";
    }
    return "SW";
  }
  return null;
}

function angleChange(a: Dir8, b: Dir8): number {
  let delta = DIR_DEGREES[b] - DIR_DEGREES[a];
  while (delta > 180) {
    delta -= 360;
  }
  while (delta <= -180) {
    delta += 360;
  }
  return Math.abs(delta);
}

function isHardAngleLegal(start: Point2D, end: Point2D): boolean {
  return hardDirection(start, end) !== null;
}

function chooseHardCorner(start: Point2D, end: Point2D): Point2D {
  const primary = { x: end.x, y: start.y };
  const secondary = { x: start.x, y: end.y };
  const primaryShort =
    distance(start, primary) < MIN_SEGMENT_MM || distance(primary, end) < MIN_SEGMENT_MM;
  const secondaryShort =
    distance(start, secondary) < MIN_SEGMENT_MM || distance(secondary, end) < MIN_SEGMENT_MM;

  if (!primaryShort) {
    return primary;
  }
  if (!secondaryShort) {
    return secondary;
  }
  return primary;
}

function autoRoutePoints(start: Point2D, end: Point2D): Point2D[] {
  if (distance(start, end) <= ZERO_LENGTH_TOLERANCE_MM) {
    return [clonePoint(start), clonePoint(end)];
  }
  if (isHardAngleLegal(start, end)) {
    return [clonePoint(start), clonePoint(end)];
  }
  const corner = chooseHardCorner(start, end);
  return [clonePoint(start), clonePoint(corner), clonePoint(end)];
}

function catmullRomToBezier(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  tension = 0.5
): [Point2D, Point2D] {
  return [
    {
      x: p1.x + ((p2.x - p0.x) * tension) / 3,
      y: p1.y + ((p2.y - p0.y) * tension) / 3,
    },
    {
      x: p2.x - ((p3.x - p1.x) * tension) / 3,
      y: p2.y - ((p3.y - p1.y) * tension) / 3,
    },
  ];
}

function cubicBezierPoint(p0: Point2D, c1: Point2D, c2: Point2D, p3: Point2D, t: number): Point2D {
  const inv = 1 - t;
  return {
    x:
      inv * inv * inv * p0.x +
      3 * inv * inv * t * c1.x +
      3 * inv * t * t * c2.x +
      t * t * t * p3.x,
    y:
      inv * inv * inv * p0.y +
      3 * inv * inv * t * c1.y +
      3 * inv * t * t * c2.y +
      t * t * t * p3.y,
  };
}

function flexSpanPathAndSamples(
  start: Point2D,
  end: Point2D,
  prev: Point2D,
  next: Point2D
): { d: string; samplePoints: Point2D[] } {
  const [c1, c2] = catmullRomToBezier(prev, start, end, next);
  const d = `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
  const samplePoints: Point2D[] = [];
  for (let index = 0; index <= CURVE_SAMPLES; index += 1) {
    samplePoints.push(cubicBezierPoint(start, c1, c2, end, index / CURVE_SAMPLES));
  }
  return { d, samplePoints: dedupePolyline(samplePoints) };
}

function linearPathD(points: Point2D[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function nearestPointOnPolyline(pointer: Point2D, points: Point2D[]): { point: Point2D; distance: number } {
  let bestPoint = clonePoint(points[0]!);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index += 1) {
    const projected = projectPointOnSegment(pointer, points[index]!, points[index + 1]!);
    if (projected.distance < bestDistance) {
      bestDistance = projected.distance;
      bestPoint = projected.point;
    }
  }
  return { point: bestPoint, distance: bestDistance };
}

function buildEndpointLayout(options: {
  end: ConnectionEnd;
  gasPort: Point2D;
  liquidPort: Point2D;
  direction: Point2D;
  sleeveLengthMm: number;
  tightZoneMm: number;
  outerRadiusSumMm: number;
}): EndpointLayout {
  const { end, gasPort, liquidPort, direction, sleeveLengthMm, tightZoneMm, outerRadiusSumMm } = options;
  const gasSleeveEnd = add(gasPort, scale(direction, sleeveLengthMm));
  const liquidSleeveEnd = add(liquidPort, scale(direction, sleeveLengthMm));
  const protectedLength = Math.max(sleeveLengthMm, tightZoneMm);
  const gasTightEnd = add(gasPort, scale(direction, protectedLength));
  const liquidTightEnd = add(liquidPort, scale(direction, protectedLength));

  const safeZone: SafeZoneRect = {
    id: `${end}-safe-zone`,
    label: end === "start" ? "Indoor unit protected zone" : "Field pipe protected zone",
    minX:
      Math.min(gasPort.x, liquidPort.x, gasSleeveEnd.x, liquidSleeveEnd.x, gasTightEnd.x, liquidTightEnd.x) -
      SLEEVE_ZONE_PADDING_MM,
    maxX:
      Math.max(gasPort.x, liquidPort.x, gasSleeveEnd.x, liquidSleeveEnd.x, gasTightEnd.x, liquidTightEnd.x) +
      SLEEVE_ZONE_PADDING_MM,
    minY:
      Math.min(gasPort.y, liquidPort.y, gasSleeveEnd.y, liquidSleeveEnd.y) - outerRadiusSumMm - SLEEVE_ZONE_PADDING_MM,
    maxY:
      Math.max(gasPort.y, liquidPort.y, gasSleeveEnd.y, liquidSleeveEnd.y) + outerRadiusSumMm + SLEEVE_ZONE_PADDING_MM,
  };

  return {
    gasPort,
    liquidPort,
    gasSleeveEnd,
    liquidSleeveEnd,
    safeZone,
  };
}

function bendRadius(a: Point2D, b: Point2D, c: Point2D): number {
  const ab = distance(a, b);
  const bc = distance(b, c);
  const ac = distance(a, c);
  const area = 0.5 * Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
  if (area <= 0.00001) {
    return Number.POSITIVE_INFINITY;
  }
  return (ab * bc * ac) / (4 * area);
}

function sampleSegmentsFromPoints(points: Point2D[], spanId: string): SampleSegment[] {
  const segments: SampleSegment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    segments.push({
      start: clonePoint(points[index - 1]!),
      end: clonePoint(points[index]!),
      spanId,
    });
  }
  return segments;
}

function getRouteByKind(state: SimulatorState, lineKind: PipeLineKind): PipeRoute {
  const route = state.pipes.find((candidate) => candidate.lineKind === lineKind);
  if (!route) {
    throw new Error(`Missing route for ${lineKind}`);
  }
  return route;
}

function clonePresetToState(preset: ScenarioPreset): SimulatorState {
  return {
    unitX: preset.unitX,
    unitY: preset.unitY,
    gasDiameterMm: preset.gasDiameterMm,
    liquidDiameterMm: preset.liquidDiameterMm,
    sleeveLengthMm: preset.sleeveLengthMm,
    insulationThicknessMm: preset.insulationThicknessMm,
    extraGapMm: preset.extraGapMm,
    tightZoneMm: preset.tightZoneMm,
    minBendRadiusMm: preset.minBendRadiusMm,
    fieldPitchMm: preset.fieldPitchMm,
    fieldShiftY: preset.fieldShiftY,
    offsetOwner: preset.offsetOwner,
    endpointRules: {
      start: { ...preset.endpointRules.start },
      end: { ...preset.endpointRules.end },
    },
    pipes: preset.pipes.map((route) => ({
      id: route.id,
      lineKind: route.lineKind,
      vertices: route.vertices.map((vertex, index) => ({
        id: nextId(`${route.lineKind}-vertex`),
        x: vertex.x,
        y: vertex.y,
        incomingMaterial:
          index === 0 ? preset.endpointRules.start[route.lineKind] : vertex.incomingMaterial,
      })),
    })),
    lastPresetId: preset.id,
  };
}

function syncRouteStartMaterial(route: PipeRoute, startMaterial: PipeMaterial): PipeRoute {
  if (route.vertices.length === 0) {
    return route;
  }
  return {
    ...route,
    vertices: route.vertices.map((vertex, index) =>
      index === 0 ? { ...vertex, incomingMaterial: startMaterial } : vertex
    ),
  };
}

function buildRouteGeometry(options: {
  route: PipeRoute;
  startLayout: EndpointLayout;
  endLayout: EndpointLayout;
  startMaterial: PipeMaterial;
  endMaterial: PipeMaterial;
  tightZoneMm: number;
  minBendRadiusMm: number;
  resolvedOffsetOwner: PipeLineKind;
}): RouteGeometry {
  const {
    route,
    startLayout,
    endLayout,
    startMaterial,
    endMaterial,
    tightZoneMm,
    minBendRadiusMm,
    resolvedOffsetOwner,
  } = options;
  const lineKind = route.lineKind;
  const firstVertex = route.vertices[0];
  const lastVertex = route.vertices[route.vertices.length - 1];
  const startPort = lineKind === "gas" ? startLayout.gasPort : startLayout.liquidPort;
  const startSleeveEnd = lineKind === "gas" ? startLayout.gasSleeveEnd : startLayout.liquidSleeveEnd;
  const endSleeveEnd = lineKind === "gas" ? endLayout.gasSleeveEnd : endLayout.liquidSleeveEnd;
  const endPort = lineKind === "gas" ? endLayout.gasPort : endLayout.liquidPort;

  const semanticSpans: SemanticSpan[] = [
    {
      id: `${route.id}-start-sleeve`,
      routeId: route.id,
      lineKind,
      scope: "start-sleeve",
      material: startMaterial,
      start: clonePoint(startPort),
      end: clonePoint(startSleeveEnd),
      vertexIndex: null,
      selectable: false,
    },
    {
      id: `${route.id}-start-transition`,
      routeId: route.id,
      lineKind,
      scope: "start-transition",
      material: startMaterial,
      start: clonePoint(startSleeveEnd),
      end: { x: firstVertex.x, y: firstVertex.y },
      vertexIndex: 0,
      selectable: true,
    },
  ];

  for (let index = 1; index < route.vertices.length; index += 1) {
    semanticSpans.push({
      id: `${route.id}-interior-${index}`,
      routeId: route.id,
      lineKind,
      scope: "interior",
      material: route.vertices[index]!.incomingMaterial,
      start: { x: route.vertices[index - 1]!.x, y: route.vertices[index - 1]!.y },
      end: { x: route.vertices[index]!.x, y: route.vertices[index]!.y },
      vertexIndex: index,
      selectable: true,
    });
  }

  semanticSpans.push(
    {
      id: `${route.id}-end-transition`,
      routeId: route.id,
      lineKind,
      scope: "end-transition",
      material: endMaterial,
      start: { x: lastVertex.x, y: lastVertex.y },
      end: clonePoint(endSleeveEnd),
      vertexIndex: route.vertices.length - 1,
      selectable: true,
    },
    {
      id: `${route.id}-end-sleeve`,
      routeId: route.id,
      lineKind,
      scope: "end-sleeve",
      material: endMaterial,
      start: clonePoint(endSleeveEnd),
      end: clonePoint(endPort),
      vertexIndex: null,
      selectable: false,
    }
  );

  const keyAnchors: Point2D[] = [
    clonePoint(startPort),
    clonePoint(startSleeveEnd),
    ...route.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })),
    clonePoint(endSleeveEnd),
    clonePoint(endPort),
  ];

  const isValidEndpointHardTransition = (
    span: SemanticSpan,
    start: Point2D,
    end: Point2D
  ): boolean => {
    if (span.material !== "hard") {
      return true;
    }
    if (span.scope !== "start-transition" && span.scope !== "end-transition") {
      return true;
    }

    const dx = Math.abs(end.x - start.x);
    const dy = end.y - start.y;
    const straight = Math.abs(dy) <= 1.5;
    if (span.lineKind !== resolvedOffsetOwner) {
      return straight;
    }

    const expectedSign = span.lineKind === "gas" ? -1 : 1;
    const diagonal =
      Math.abs(dx - Math.abs(dy)) <= 1.5 &&
      (Math.abs(dy) <= 1.5 || dy * expectedSign >= -1.5);
    return straight || diagonal;
  };

  const renderSpans: RenderSpan[] = semanticSpans.map((span) => {
    const invalidHard = !isValidEndpointHardTransition(span, span.start, span.end);
    if (span.material === "hard") {
      const renderPoints =
        span.scope === "start-transition" || span.scope === "end-transition"
          ? [clonePoint(span.start), clonePoint(span.end)]
          : autoRoutePoints(span.start, span.end);
      return {
        ...span,
        d: linearPathD(renderPoints),
        renderPoints,
        samplePoints: dedupePolyline(renderPoints),
        lengthMm: polylineLength(renderPoints),
        invalidHard,
      };
    }

    const anchorIndex = keyAnchors.findIndex((point) => pointsEqual(point, span.start));
    const prevAnchor = keyAnchors[Math.max(0, anchorIndex - 1)]!;
    const nextAnchor = keyAnchors[Math.min(keyAnchors.length - 1, anchorIndex + 2)]!;
    const curve = flexSpanPathAndSamples(span.start, span.end, prevAnchor, nextAnchor);
    return {
      ...span,
      d: curve.d,
      renderPoints: [clonePoint(span.start), clonePoint(span.end)],
      samplePoints: curve.samplePoints,
      lengthMm: polylineLength(curve.samplePoints),
      invalidHard,
    };
  });

  const nodes: PathNode[] = [
    {
      id: `${route.id}-node-port`,
      p: clonePoint(startPort),
      kind: "port",
      lineKind,
      vertexIndex: null,
      incomingMaterial: null,
      incomingSpanId: null,
      fitting: "endpoint",
      cumFromStartMm: 0,
      cumFromEndMm: 0,
      inTightZone: false,
      inStartTightZone: false,
      inEndTightZone: false,
    },
  ];

  renderSpans.forEach((span) => {
    const points = span.material === "hard" ? autoRoutePoints(span.start, span.end) : [span.start, span.end];
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index]!;
      const isLastPoint = index === points.length - 1;
      let kind: PathNode["kind"] = "auto";
      let vertexIndex: number | null = null;

      if (isLastPoint) {
        if (span.scope === "start-sleeve") {
          kind = "sleeveEnd";
        } else if (span.scope === "start-transition" || span.scope === "interior") {
          kind = "vertex";
          vertexIndex = span.vertexIndex;
        } else if (span.scope === "end-transition") {
          kind = "fieldSleeveEnd";
        } else {
          kind = "fieldPort";
        }
      }

      nodes.push({
        id: `${span.id}-node-${index}`,
        p: clonePoint(point),
        kind,
        lineKind,
        vertexIndex,
        incomingMaterial: span.material,
        incomingSpanId: span.id,
        fitting: "none",
        cumFromStartMm: 0,
        cumFromEndMm: 0,
        inTightZone: false,
        inStartTightZone: false,
        inEndTightZone: false,
      });
    }
  });

  nodes[0]!.cumFromStartMm = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    nodes[index]!.cumFromStartMm =
      nodes[index - 1]!.cumFromStartMm + distance(nodes[index - 1]!.p, nodes[index]!.p);
  }
  const totalLength = nodes[nodes.length - 1]!.cumFromStartMm;
  for (let index = 0; index < nodes.length; index += 1) {
    nodes[index]!.cumFromEndMm = totalLength - nodes[index]!.cumFromStartMm;
    nodes[index]!.inStartTightZone = nodes[index]!.cumFromStartMm <= tightZoneMm + 0.25;
    nodes[index]!.inEndTightZone = nodes[index]!.cumFromEndMm <= tightZoneMm + 0.25;
    nodes[index]!.inTightZone = nodes[index]!.inStartTightZone || nodes[index]!.inEndTightZone;
  }

  const invalidNodeIds: string[] = [];
  const hardBendNodeIds: string[] = [];

  nodes.forEach((node, index) => {
    const previousNode = index > 0 ? nodes[index - 1]! : null;
    const nextNode = index < nodes.length - 1 ? nodes[index + 1]! : null;
    if (!previousNode || !nextNode) {
      node.fitting = "endpoint";
      return;
    }

    const previousMaterial = node.incomingMaterial;
    const nextMaterial = nextNode.incomingMaterial;
    if (!previousMaterial || !nextMaterial) {
      node.fitting = "endpoint";
      return;
    }

    if (previousMaterial === "flexible" && nextMaterial === "flexible") {
      node.fitting = "none";
      return;
    }

    if (previousMaterial !== nextMaterial) {
      node.fitting = "adapter";
      return;
    }

    const incomingDirection = hardDirection(previousNode.p, node.p);
    const outgoingDirection = hardDirection(node.p, nextNode.p);
    if (!incomingDirection || !outgoingDirection) {
      node.fitting = "invalid";
      invalidNodeIds.push(node.id);
      return;
    }

    const turn = angleChange(incomingDirection, outgoingDirection);
    if (turn <= HARD_ANGLE_TOLERANCE_DEG) {
      node.fitting = "coupler";
    } else if (Math.abs(turn - 45) <= HARD_ANGLE_TOLERANCE_DEG) {
      node.fitting = "elbow45";
      if (node.inTightZone) {
        hardBendNodeIds.push(node.id);
      }
    } else if (Math.abs(turn - 90) <= HARD_ANGLE_TOLERANCE_DEG) {
      node.fitting = "elbow90";
      if (node.inTightZone) {
        hardBendNodeIds.push(node.id);
      }
    } else {
      node.fitting = "invalid";
      invalidNodeIds.push(node.id);
    }
  });

  const kinkVertexIndices: number[] = [];
  let flexBendCount = 0;
  for (let index = 0; index < route.vertices.length; index += 1) {
    const vertex = route.vertices[index]!;
    const incomingMaterial = index === 0 ? startMaterial : vertex.incomingMaterial;
    const outgoingMaterial =
      index === route.vertices.length - 1 ? endMaterial : route.vertices[index + 1]!.incomingMaterial;
    if (incomingMaterial !== "flexible" || outgoingMaterial !== "flexible") {
      continue;
    }
    const previousPoint =
      index === 0
        ? startSleeveEnd
        : { x: route.vertices[index - 1]!.x, y: route.vertices[index - 1]!.y };
    const nextPoint =
      index === route.vertices.length - 1
        ? endSleeveEnd
        : { x: route.vertices[index + 1]!.x, y: route.vertices[index + 1]!.y };
    flexBendCount += 1;
    const radius = bendRadius(previousPoint, { x: vertex.x, y: vertex.y }, nextPoint);
    if (radius + 0.25 < minBendRadiusMm) {
      kinkVertexIndices.push(index);
    }
  }

  const invalidSpanIds = renderSpans.filter((span) => span.invalidHard).map((span) => span.id);

  const zeroLengthSpanIds = renderSpans
    .filter((span) => span.lengthMm <= ZERO_LENGTH_TOLERANCE_MM)
    .map((span) => span.id);

  const polyline = dedupePolyline(
    renderSpans.flatMap((span) => span.samplePoints.map((point) => clonePoint(point)))
  );

  return {
    routeId: route.id,
    lineKind,
    spans: renderSpans,
    nodes,
    polyline,
    actualLengthMm: renderSpans.reduce((total, span) => total + span.lengthMm, 0),
    kinkVertexIndices,
    hardBendNodeIds,
    invalidNodeIds,
    invalidSpanIds,
    zeroLengthSpanIds,
    flexBendCount,
  };
}

function measureSpacing(
  gasSpans: RenderSpan[],
  liquidSpans: RenderSpan[],
  requiredCenterSpacingMm: number
): { minimumDistanceMm: number; lowGapLengthMm: number; problemSpanIds: string[] } {
  const gasSegments = gasSpans.flatMap((span) => sampleSegmentsFromPoints(span.samplePoints, span.id));
  const liquidSegments = liquidSpans.flatMap((span) => sampleSegmentsFromPoints(span.samplePoints, span.id));
  let minimumDistanceMm = Number.POSITIVE_INFINITY;
  let lowGapLengthMm = 0;
  const problemSpanIds = new Set<string>();

  gasSegments.forEach((gasSegment) => {
    const lengthMm = segmentLength(gasSegment);
    if (lengthMm <= ZERO_LENGTH_TOLERANCE_MM) {
      return;
    }
    const samples = Math.max(1, Math.ceil(lengthMm / SAMPLE_STEP_MM));
    for (let index = 0; index <= samples; index += 1) {
      const t = index / samples;
      const gasPoint = add(gasSegment.start, scale(subtract(gasSegment.end, gasSegment.start), t));
      let nearestDistance = Number.POSITIVE_INFINITY;
      let nearestSpanId = "";
      liquidSegments.forEach((liquidSegment) => {
        const projected = projectPointOnSegment(gasPoint, liquidSegment.start, liquidSegment.end);
        if (projected.distance < nearestDistance) {
          nearestDistance = projected.distance;
          nearestSpanId = liquidSegment.spanId;
        }
      });
      minimumDistanceMm = Math.min(minimumDistanceMm, nearestDistance);
      if (nearestDistance + 0.25 < requiredCenterSpacingMm) {
        lowGapLengthMm += lengthMm / samples;
        problemSpanIds.add(gasSegment.spanId);
        if (nearestSpanId) {
          problemSpanIds.add(nearestSpanId);
        }
      }
    }
  });

  return {
    minimumDistanceMm: Number.isFinite(minimumDistanceMm) ? minimumDistanceMm : requiredCenterSpacingMm,
    lowGapLengthMm,
    problemSpanIds: Array.from(problemSpanIds),
  };
}

function spansAroundVertex(route: RouteGeometry, vertexIndex: number): string[] {
  return route.spans
    .filter((span) => {
      if (span.scope === "start-transition") {
        return vertexIndex === 0;
      }
      if (span.scope === "interior") {
        return span.vertexIndex === vertexIndex || span.vertexIndex === vertexIndex + 1;
      }
      if (span.scope === "end-transition") {
        return span.vertexIndex === vertexIndex;
      }
      return false;
    })
    .map((span) => span.id);
}

function buildSimulation(state: SimulatorState): SimulationData {
  const gasOuterDiameterMm = state.gasDiameterMm + state.insulationThicknessMm * 2;
  const liquidOuterDiameterMm = state.liquidDiameterMm + state.insulationThicknessMm * 2;
  const outerRadiusSumMm = gasOuterDiameterMm / 2 + liquidOuterDiameterMm / 2;
  const requiredCenterSpacingMm = outerRadiusSumMm + state.extraGapMm;
  const resolvedOffsetOwner = resolveOffsetOwner(state.offsetOwner, state.gasDiameterMm, state.liquidDiameterMm);

  const unitCenterY = state.unitY + UNIT_HEIGHT / 2;
  const gasPort: Point2D = { x: state.unitX + UNIT_WIDTH, y: unitCenterY - UNIT_PORT_PITCH_MM / 2 };
  const liquidPort: Point2D = { x: state.unitX + UNIT_WIDTH, y: unitCenterY + UNIT_PORT_PITCH_MM / 2 };
  const fieldCenterY = state.unitY + UNIT_HEIGHT / 2 + state.fieldShiftY;
  const gasFieldPort: Point2D = { x: FIELD_X, y: fieldCenterY - state.fieldPitchMm / 2 };
  const liquidFieldPort: Point2D = { x: FIELD_X, y: fieldCenterY + state.fieldPitchMm / 2 };

  const startLayout = buildEndpointLayout({
    end: "start",
    gasPort,
    liquidPort,
    direction: { x: 1, y: 0 },
    sleeveLengthMm: state.sleeveLengthMm,
    tightZoneMm: state.tightZoneMm,
    outerRadiusSumMm,
  });
  const endLayout = buildEndpointLayout({
    end: "end",
    gasPort: gasFieldPort,
    liquidPort: liquidFieldPort,
    direction: { x: -1, y: 0 },
    sleeveLengthMm: state.sleeveLengthMm,
    tightZoneMm: state.tightZoneMm,
    outerRadiusSumMm,
  });

  const gasRoute = buildRouteGeometry({
    route: getRouteByKind(state, "gas"),
    startLayout,
    endLayout,
    startMaterial: state.endpointRules.start.gas,
    endMaterial: state.endpointRules.end.gas,
    tightZoneMm: state.tightZoneMm,
    minBendRadiusMm: state.minBendRadiusMm,
    resolvedOffsetOwner,
  });
  const liquidRoute = buildRouteGeometry({
    route: getRouteByKind(state, "liquid"),
    startLayout,
    endLayout,
    startMaterial: state.endpointRules.start.liquid,
    endMaterial: state.endpointRules.end.liquid,
    tightZoneMm: state.tightZoneMm,
    minBendRadiusMm: state.minBendRadiusMm,
    resolvedOffsetOwner,
  });

  const spacingProbe = measureSpacing(gasRoute.spans, liquidRoute.spans, requiredCenterSpacingMm);
  const startSleeveGapMm = Math.abs(startLayout.liquidPort.y - startLayout.gasPort.y) - outerRadiusSumMm;
  const endSleeveGapMm = Math.abs(endLayout.liquidPort.y - endLayout.gasPort.y) - outerRadiusSumMm;
  const actualMinimumAirGapMm = spacingProbe.minimumDistanceMm - outerRadiusSumMm;
  const sleeveClash = startSleeveGapMm < -0.25 || endSleeveGapMm < -0.25;
  const inadequateGap = spacingProbe.minimumDistanceMm + 0.25 < requiredCenterSpacingMm;
  const condensationRisk = sleeveClash || (inadequateGap && spacingProbe.lowGapLengthMm > 40);

  const hardGasMm = gasRoute.spans
    .filter((span) => span.material === "hard")
    .reduce((total, span) => total + span.lengthMm, 0);
  const flexGasMm = gasRoute.spans
    .filter((span) => span.material === "flexible")
    .reduce((total, span) => total + span.lengthMm, 0);
  const hardLiquidMm = liquidRoute.spans
    .filter((span) => span.material === "hard")
    .reduce((total, span) => total + span.lengthMm, 0);
  const flexLiquidMm = liquidRoute.spans
    .filter((span) => span.material === "flexible")
    .reduce((total, span) => total + span.lengthMm, 0);

  const allNodes = [...gasRoute.nodes, ...liquidRoute.nodes];
  const elbow45Count = allNodes.filter((node) => node.fitting === "elbow45").length;
  const elbow90Count = allNodes.filter((node) => node.fitting === "elbow90").length;
  const adapterCount = allNodes.filter((node) => node.fitting === "adapter").length;
  const invalidHardAngleCount =
    gasRoute.invalidNodeIds.length +
    liquidRoute.invalidNodeIds.length +
    gasRoute.invalidSpanIds.length +
    liquidRoute.invalidSpanIds.length;
  const hardBendInTightZoneCount = gasRoute.hardBendNodeIds.length + liquidRoute.hardBendNodeIds.length;
  const zeroLengthCount = gasRoute.zeroLengthSpanIds.length + liquidRoute.zeroLengthSpanIds.length;
  const kinkWarningCount = gasRoute.kinkVertexIndices.length + liquidRoute.kinkVertexIndices.length;

  const bendCount =
    elbow45Count +
    elbow90Count +
    gasRoute.flexBendCount +
    liquidRoute.flexBendCount +
    invalidHardAngleCount;

  const warningItems: WarningItem[] = [];
  const problemSpanIds = new Set<string>();

  if (sleeveClash) {
    const sleeveSpanIds = [
      `${gasRoute.routeId}-start-sleeve`,
      `${liquidRoute.routeId}-start-sleeve`,
      `${gasRoute.routeId}-end-sleeve`,
      `${liquidRoute.routeId}-end-sleeve`,
    ];
    sleeveSpanIds.forEach((spanId) => problemSpanIds.add(spanId));
    warningItems.push({
      code: "INSULATION_CLASH",
      title: "Insulated sleeves clash in the connection zone",
      detail: `Indoor unit sleeve air gap is ${formatMm(startSleeveGapMm)} and field sleeve air gap is ${formatMm(endSleeveGapMm)}. Increase pitch, reduce insulation, or offset the pair more aggressively.`,
      severity: "error",
      spanIds: sleeveSpanIds,
    });
  }

  if (inadequateGap) {
    spacingProbe.problemSpanIds.forEach((spanId) => problemSpanIds.add(spanId));
    warningItems.push({
      code: "INADEQUATE_GAP",
      title: "Required separation gap is violated",
      detail: `Minimum center spacing is ${formatMm(spacingProbe.minimumDistanceMm)} against a required ${formatMm(requiredCenterSpacingMm)}. Air gap drops to ${formatMm(actualMinimumAirGapMm)}.`,
      severity: "error",
      spanIds: spacingProbe.problemSpanIds,
    });
  }

  if (condensationRisk) {
    spacingProbe.problemSpanIds.forEach((spanId) => problemSpanIds.add(spanId));
    warningItems.push({
      code: "CONDENSATION_RISK",
      title: "Bundled routing raises condensation risk",
      detail: `Low-gap routing persists for ${formatMm(spacingProbe.lowGapLengthMm)}. Separate the pair or change the bend path so insulation is not bundled together.`,
      severity: "warning",
      spanIds: spacingProbe.problemSpanIds,
    });
  }

  if (invalidHardAngleCount > 0) {
    const invalidSpanIds = [
      ...gasRoute.invalidSpanIds,
      ...liquidRoute.invalidSpanIds,
      ...gasRoute.nodes
        .filter((node) => gasRoute.invalidNodeIds.includes(node.id))
        .flatMap((node) => [node.incomingSpanId])
        .filter((value): value is string => Boolean(value)),
      ...liquidRoute.nodes
        .filter((node) => liquidRoute.invalidNodeIds.includes(node.id))
        .flatMap((node) => [node.incomingSpanId])
        .filter((value): value is string => Boolean(value)),
    ];
    invalidSpanIds.forEach((spanId) => problemSpanIds.add(spanId));
    warningItems.push({
      code: "INVALID_HARD_CONNECTION",
      title: "Hard copper geometry is not buildable",
      detail: `${invalidHardAngleCount} hard-copper corner${invalidHardAngleCount === 1 ? "" : "s"} exceeds the 0/45/90 degree rule. Move the waypoint or switch the offending span to flexible.`,
      severity: "error",
      spanIds: invalidSpanIds,
    });
  }

  if (hardBendInTightZoneCount > 0) {
    const tightSpanIds = [
      ...gasRoute.nodes
        .filter((node) => gasRoute.hardBendNodeIds.includes(node.id))
        .flatMap((node) => [node.incomingSpanId])
        .filter((value): value is string => Boolean(value)),
      ...liquidRoute.nodes
        .filter((node) => liquidRoute.hardBendNodeIds.includes(node.id))
        .flatMap((node) => [node.incomingSpanId])
        .filter((value): value is string => Boolean(value)),
    ];
    tightSpanIds.forEach((spanId) => problemSpanIds.add(spanId));
    warningItems.push({
      code: "BEND_IN_SLEEVE",
      title: "Hard bend enters the protected connection zone",
      detail: `${hardBendInTightZoneCount} hard bend${hardBendInTightZoneCount === 1 ? "" : "s"} sits inside the first ${formatMm(state.tightZoneMm)} from a port. Keep this area straight for flare-nut access and insulation clearance.`,
      severity: "warning",
      spanIds: tightSpanIds,
    });
  }

  if (zeroLengthCount > 0) {
    const zeroLengthSpanIds = [...gasRoute.zeroLengthSpanIds, ...liquidRoute.zeroLengthSpanIds];
    zeroLengthSpanIds.forEach((spanId) => problemSpanIds.add(spanId));
    warningItems.push({
      code: "ZERO_LENGTH_SEGMENT",
      title: "Collapsed span detected",
      detail: `${zeroLengthCount} route span${zeroLengthCount === 1 ? "" : "s"} collapsed to zero length after drag or material changes. Separate the control points before continuing.`,
      severity: "error",
      spanIds: zeroLengthSpanIds,
    });
  }

  if (kinkWarningCount > 0) {
    const kinkSpanIds = [
      ...gasRoute.kinkVertexIndices.flatMap((vertexIndex) => spansAroundVertex(gasRoute, vertexIndex)),
      ...liquidRoute.kinkVertexIndices.flatMap((vertexIndex) => spansAroundVertex(liquidRoute, vertexIndex)),
    ];
    kinkSpanIds.forEach((spanId) => problemSpanIds.add(spanId));
    warningItems.push({
      code: "FLEX_KINK",
      title: "Flexible copper bend radius is too tight",
      detail: `${kinkWarningCount} flexible bend${kinkWarningCount === 1 ? "" : "s"} drops below the configured ${formatMm(state.minBendRadiusMm)} minimum radius. Move the waypoint farther out.`,
      severity: "warning",
      spanIds: kinkSpanIds,
    });
  }

  return {
    requiredCenterSpacingMm,
    resolvedOffsetOwner,
    startLayout,
    endLayout,
    safeZones: [startLayout.safeZone, endLayout.safeZone],
    routes: {
      gas: gasRoute,
      liquid: liquidRoute,
    },
    analysis: {
      requiredCenterSpacingMm,
      actualMinimumSpacingMm: spacingProbe.minimumDistanceMm,
      actualMinimumAirGapMm,
      lowGapLengthMm: spacingProbe.lowGapLengthMm,
      bendCount,
      materialBreakdownMm: {
        hard: hardGasMm + hardLiquidMm,
        flexible: flexGasMm + flexLiquidMm,
      },
      hardGasMm,
      flexGasMm,
      hardLiquidMm,
      flexLiquidMm,
      elbow45Count,
      elbow90Count,
      adapterCount,
      kinkWarningCount,
      hardBendInTightZoneCount,
      invalidHardAngleCount,
      zeroLengthCount,
      condensationRisk,
      sleeveClash,
      inadequateGap,
      startSleeveGapMm,
      endSleeveGapMm,
      warningItems,
      problemSpanIds: Array.from(problemSpanIds),
    },
  };
}

function snapPointToLegalRay(origin: Point2D, pointer: Point2D): Point2D {
  const legalDirections: Point2D[] = [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
  ].map((direction) => normalize(direction));

  let bestPoint = clonePoint(pointer);
  let bestDistance = Number.POSITIVE_INFINITY;
  legalDirections.forEach((direction) => {
    const projectedLength = Math.max(MIN_SEGMENT_MM, dot(subtract(pointer, origin), direction));
    const candidate = add(origin, scale(direction, projectedLength));
    const candidateDistance = distance(candidate, pointer);
    if (candidateDistance < bestDistance) {
      bestDistance = candidateDistance;
      bestPoint = candidate;
    }
  });
  return bestPoint;
}

function snapBetweenTwoHardSegments(previous: Point2D, next: Point2D, pointer: Point2D): Point2D {
  const legalDirections: Point2D[] = [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
  ].map((direction) => normalize(direction));

  let bestPoint: Point2D | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  legalDirections.forEach((leftDirection) => {
    legalDirections.forEach((rightDirection) => {
      const intersection = lineIntersection(
        previous,
        add(previous, leftDirection),
        next,
        add(next, rightDirection)
      );
      if (!intersection) {
        return;
      }
      const leftTravel = dot(subtract(intersection, previous), leftDirection);
      const rightTravel = dot(subtract(intersection, next), rightDirection);
      if (leftTravel < MIN_SEGMENT_MM || rightTravel < MIN_SEGMENT_MM) {
        return;
      }
      const candidateDistance = distance(intersection, pointer);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        bestPoint = intersection;
      }
    });
  });

  if (bestPoint) {
    return bestPoint;
  }

  const fromPrevious = snapPointToLegalRay(previous, pointer);
  const fromNext = snapPointToLegalRay(next, pointer);
  return distance(pointer, fromPrevious) <= distance(pointer, fromNext) ? fromPrevious : fromNext;
}

function clampVertexCandidate(options: {
  pointer: Point2D;
  previous: Point2D;
  next: Point2D;
  leftHard: boolean;
  rightHard: boolean;
  safeZones: SafeZoneRect[];
}): Point2D {
  const { pointer, previous, next, leftHard, rightHard, safeZones } = options;
  let candidate = clonePoint(pointer);
  if (leftHard && rightHard) {
    candidate = snapBetweenTwoHardSegments(previous, next, candidate);
  } else if (leftHard) {
    candidate = snapPointToLegalRay(previous, candidate);
  } else if (rightHard) {
    candidate = snapPointToLegalRay(next, candidate);
  }

  const minX = Math.min(previous.x, next.x) + MIN_SEGMENT_MM;
  const maxX = Math.max(previous.x, next.x) - MIN_SEGMENT_MM;
  candidate = {
    x: clamp(candidate.x, minX, maxX),
    y: clamp(candidate.y, 76, SCENE_HEIGHT - 76),
  };

  safeZones.forEach((safeZone) => {
    if (pointInRect(candidate, safeZone)) {
      if (candidate.x < midpoint(previous, next).x) {
        candidate.x = safeZone.maxX + 12;
      } else {
        candidate.x = safeZone.minX - 12;
      }
    }
  });

  return candidate;
}

const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: "balanced-demo",
    name: "Balanced Demo",
    description: "Stable baseline with hard copper leaving the unit and flexible routing in the middle.",
    unitX: DEFAULT_UNIT_X,
    unitY: DEFAULT_UNIT_Y,
    endpointRules: {
      start: { gas: "hard", liquid: "hard" },
      end: { gas: "flexible", liquid: "flexible" },
    },
    pipes: [
      {
        id: "gas-route",
        lineKind: "gas",
        vertices: [
          { id: "gas-v0", x: 612, y: 274, incomingMaterial: "hard" },
          { id: "gas-v1", x: 720, y: 274, incomingMaterial: "hard" },
          { id: "gas-v2", x: 812, y: 314, incomingMaterial: "flexible" },
        ],
      },
      {
        id: "liquid-route",
        lineKind: "liquid",
        vertices: [
          { id: "liquid-v0", x: 600, y: 386, incomingMaterial: "hard" },
          { id: "liquid-v1", x: 712, y: 418, incomingMaterial: "flexible" },
          { id: "liquid-v2", x: 820, y: 392, incomingMaterial: "flexible" },
        ],
      },
    ],
    gasDiameterMm: 12.7,
    liquidDiameterMm: 6.35,
    sleeveLengthMm: 200,
    insulationThicknessMm: 13,
    extraGapMm: 15,
    tightZoneMm: 200,
    minBendRadiusMm: 80,
    fieldPitchMm: 88,
    fieldShiftY: 8,
    offsetOwner: "auto",
  },
  {
    id: "tight-connection",
    name: "Tight Connection",
    description: "Dense field pitch and full hard copper on both ends push the connection zone into failure.",
    unitX: DEFAULT_UNIT_X,
    unitY: DEFAULT_UNIT_Y,
    endpointRules: {
      start: { gas: "hard", liquid: "hard" },
      end: { gas: "hard", liquid: "hard" },
    },
    pipes: [
      {
        id: "gas-route",
        lineKind: "gas",
        vertices: [
          { id: "gas-v0", x: 610, y: 274, incomingMaterial: "hard" },
          { id: "gas-v1", x: 700, y: 274, incomingMaterial: "hard" },
          { id: "gas-v2", x: 816, y: 284, incomingMaterial: "hard" },
        ],
      },
      {
        id: "liquid-route",
        lineKind: "liquid",
        vertices: [
          { id: "liquid-v0", x: 600, y: 386, incomingMaterial: "hard" },
          { id: "liquid-v1", x: 694, y: 356, incomingMaterial: "hard" },
          { id: "liquid-v2", x: 812, y: 320, incomingMaterial: "hard" },
        ],
      },
    ],
    gasDiameterMm: 12.7,
    liquidDiameterMm: 6.35,
    sleeveLengthMm: 200,
    insulationThicknessMm: 19,
    extraGapMm: 20,
    tightZoneMm: 200,
    minBendRadiusMm: 80,
    fieldPitchMm: 42,
    fieldShiftY: -20,
    offsetOwner: "auto",
  },
  {
    id: "mixed-material",
    name: "Mixed Material",
    description: "Gas starts hard then opens into flex; liquid starts flexible and returns to hard near the field pipe.",
    unitX: DEFAULT_UNIT_X,
    unitY: DEFAULT_UNIT_Y,
    endpointRules: {
      start: { gas: "hard", liquid: "flexible" },
      end: { gas: "flexible", liquid: "hard" },
    },
    pipes: [
      {
        id: "gas-route",
        lineKind: "gas",
        vertices: [
          { id: "gas-v0", x: 612, y: 274, incomingMaterial: "hard" },
          { id: "gas-v1", x: 694, y: 274, incomingMaterial: "hard" },
          { id: "gas-v2", x: 756, y: 238, incomingMaterial: "flexible" },
          { id: "gas-v3", x: 834, y: 278, incomingMaterial: "flexible" },
        ],
      },
      {
        id: "liquid-route",
        lineKind: "liquid",
        vertices: [
          { id: "liquid-v0", x: 590, y: 360, incomingMaterial: "flexible" },
          { id: "liquid-v1", x: 706, y: 430, incomingMaterial: "flexible" },
          { id: "liquid-v2", x: 792, y: 404, incomingMaterial: "hard" },
          { id: "liquid-v3", x: 838, y: 404, incomingMaterial: "hard" },
        ],
      },
    ],
    gasDiameterMm: 12.7,
    liquidDiameterMm: 6.35,
    sleeveLengthMm: 200,
    insulationThicknessMm: 13,
    extraGapMm: 15,
    tightZoneMm: 200,
    minBendRadiusMm: 80,
    fieldPitchMm: 82,
    fieldShiftY: 16,
    offsetOwner: "auto",
  },
  {
    id: "bundled-risk",
    name: "Bundled Risk",
    description: "The pair zig-zags too closely for too long, intentionally raising condensation and kink risk.",
    unitX: DEFAULT_UNIT_X,
    unitY: DEFAULT_UNIT_Y,
    endpointRules: {
      start: { gas: "hard", liquid: "hard" },
      end: { gas: "flexible", liquid: "flexible" },
    },
    pipes: [
      {
        id: "gas-route",
        lineKind: "gas",
        vertices: [
          { id: "gas-v0", x: 610, y: 274, incomingMaterial: "hard" },
          { id: "gas-v1", x: 676, y: 292, incomingMaterial: "flexible" },
          { id: "gas-v2", x: 734, y: 266, incomingMaterial: "flexible" },
          { id: "gas-v3", x: 794, y: 292, incomingMaterial: "flexible" },
          { id: "gas-v4", x: 842, y: 280, incomingMaterial: "flexible" },
        ],
      },
      {
        id: "liquid-route",
        lineKind: "liquid",
        vertices: [
          { id: "liquid-v0", x: 600, y: 386, incomingMaterial: "hard" },
          { id: "liquid-v1", x: 666, y: 372, incomingMaterial: "flexible" },
          { id: "liquid-v2", x: 724, y: 396, incomingMaterial: "flexible" },
          { id: "liquid-v3", x: 784, y: 370, incomingMaterial: "flexible" },
          { id: "liquid-v4", x: 842, y: 382, incomingMaterial: "flexible" },
        ],
      },
    ],
    gasDiameterMm: 12.7,
    liquidDiameterMm: 6.35,
    sleeveLengthMm: 200,
    insulationThicknessMm: 19,
    extraGapMm: 24,
    tightZoneMm: 200,
    minBendRadiusMm: 95,
    fieldPitchMm: 70,
    fieldShiftY: 0,
    offsetOwner: "auto",
  },
];

const DEFAULT_PRESET = SCENARIO_PRESETS[0]!;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white/90 p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-stone-500">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  const { label, value, min, max, step, suffix, onChange } = props;
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number.parseFloat(event.target.value))}
          className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-stone-200 accent-amber-700"
        />
        <div className="w-24 rounded-lg border border-stone-200 bg-stone-50 px-2 py-1 text-right text-xs font-semibold text-slate-700">
          {value.toFixed(step < 1 ? 2 : step < 5 ? 1 : 0)} {suffix}
        </div>
      </div>
    </label>
  );
}

function MaterialSelect(props: { label: string; value: PipeMaterial; onChange: (value: PipeMaterial) => void }) {
  const { label, value, onChange } = props;
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as PipeMaterial)}
        className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-amber-500"
      >
        <option value="hard">Hard copper</option>
        <option value="flexible">Flexible copper</option>
      </select>
    </label>
  );
}

function WarningBadge(props: { label: string; active: boolean; tone: "ok" | "warn" | "error" }) {
  const { label, active, tone } = props;
  const toneClass =
    tone === "ok"
      ? "border-emerald-300 bg-emerald-50 text-emerald-700"
      : tone === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-800"
        : active
          ? "border-rose-300 bg-rose-50 text-rose-700"
          : "border-stone-200 bg-stone-50 text-stone-500";
  return <div className={`rounded-full border px-3 py-1 text-xs font-semibold ${toneClass}`}>{label}</div>;
}

function MaterialToggleButton(props: { active: boolean; label: string; onClick: () => void }) {
  const { active, label, onClick } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
        active
          ? "bg-stone-900 text-white"
          : "bg-white text-slate-700 ring-1 ring-stone-200 hover:bg-stone-100"
      }`}
    >
      {label}
    </button>
  );
}

function MetricCard(props: { label: string; value: string; compact?: boolean }) {
  const { label, value, compact = false } = props;
  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
      <div className="text-xs uppercase tracking-[0.14em] text-stone-500">{label}</div>
      <div className={`mt-2 font-semibold text-slate-900 ${compact ? "text-lg" : "text-2xl"}`}>{value}</div>
    </div>
  );
}

function BomRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-slate-700">
      <span>{props.label}</span>
      <span className="font-semibold text-slate-900">{props.value}</span>
    </div>
  );
}

export default function PipeConnectionSimulatorPage() {
  const [state, setState] = useState<SimulatorState>(() => clonePresetToState(DEFAULT_PRESET));
  const [editMode, setEditMode] = useState<EditMode>("select");
  const [interactionNote, setInteractionNote] = useState(
    "Select a pipe span to change its material. Add mode inserts a waypoint on the actual pipe path."
  );
  const [selectedSpan, setSelectedSpan] = useState<SelectedSpan | null>(null);
  const [selectedVertex, setSelectedVertex] = useState<SelectedVertex | null>(null);
  const [hoverInsert, setHoverInsert] = useState<HoverInsert | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [showFittings, setShowFittings] = useState(true);
  const [showLengths, setShowLengths] = useState(false);
  const [showProtectedZones, setShowProtectedZones] = useState(true);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const latestStateRef = useRef(state);
  const simulation = useMemo(() => buildSimulation(state), [state]);
  const latestSimulationRef = useRef(simulation);

  useEffect(() => {
    latestStateRef.current = state;
  }, [state]);

  useEffect(() => {
    latestSimulationRef.current = simulation;
  }, [simulation]);

  const toSvgPoint = useCallback((clientX: number, clientY: number): Point2D | null => {
    const svg = svgRef.current;
    if (!svg) {
      return null;
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: ((clientX - rect.left) / rect.width) * SCENE_WIDTH,
      y: ((clientY - rect.top) / rect.height) * SCENE_HEIGHT,
    };
  }, []);

  const updatePreset = useCallback((preset: ScenarioPreset) => {
    setState(clonePresetToState(preset));
    setSelectedSpan(null);
    setSelectedVertex(null);
    setHoverInsert(null);
    setEditMode("select");
    setInteractionNote(`${preset.name} loaded.`);
  }, []);

  const updateEndpointMaterial = useCallback(
    (end: ConnectionEnd, lineKind: PipeLineKind, material: PipeMaterial) => {
      setState((currentState) => ({
        ...currentState,
        endpointRules: {
          ...currentState.endpointRules,
          [end]: {
            ...currentState.endpointRules[end],
            [lineKind]: material,
          },
        },
        pipes: currentState.pipes.map((route) => {
          if (route.lineKind !== lineKind) {
            return route;
          }
          return end === "start" ? syncRouteStartMaterial(route, material) : route;
        }),
      }));
      setInteractionNote(`${lineKind} ${end} connection span switched to ${material} copper.`);
    },
    []
  );

  const updateInteriorMaterial = useCallback((lineKind: PipeLineKind, vertexIndex: number, material: PipeMaterial) => {
    setState((currentState) => ({
      ...currentState,
      pipes: currentState.pipes.map((route) => {
        if (route.lineKind !== lineKind) {
          return route;
        }
        return {
          ...route,
          vertices: route.vertices.map((vertex, index) =>
            index === vertexIndex ? { ...vertex, incomingMaterial: material } : vertex
          ),
        };
      }),
    }));
    setInteractionNote(`${lineKind} interior span switched to ${material} copper.`);
  }, []);

  const resetToDefault = useCallback(() => {
    setState(clonePresetToState(DEFAULT_PRESET));
    setEditMode("select");
    setSelectedSpan(null);
    setSelectedVertex(null);
    setHoverInsert(null);
    setInteractionNote("Simulator reset to the baseline demo.");
  }, []);

  const activeWarningSet = useMemo(
    () => new Set(simulation.analysis.problemSpanIds),
    [simulation.analysis.problemSpanIds]
  );

  const allSelectableSpans = useMemo(
    () => [...simulation.routes.gas.spans, ...simulation.routes.liquid.spans].filter((span) => span.selectable),
    [simulation]
  );

  const findClosestSelectableSpan = useCallback(
    (pointer: Point2D): HoverInsert | null => {
      let best: HoverInsert | null = null;
      let bestDistance = HIT_TOLERANCE_MM;
      allSelectableSpans.forEach((span) => {
        const nearest = nearestPointOnPolyline(pointer, span.samplePoints);
        if (nearest.distance < bestDistance) {
          bestDistance = nearest.distance;
          best = {
            lineKind: span.lineKind,
            spanId: span.id,
            scope: span.scope as "start-transition" | "interior" | "end-transition",
            vertexIndex: span.vertexIndex,
            point: nearest.point,
          };
        }
      });
      return best;
    },
    [allSelectableSpans]
  );

  const deleteVertex = useCallback((lineKind: PipeLineKind, vertexIndex: number) => {
    let blocked = false;
    setState((currentState) => ({
      ...currentState,
      pipes: currentState.pipes.map((route) => {
        if (route.lineKind !== lineKind) {
          return route;
        }
        if (route.vertices.length <= 1) {
          blocked = true;
          return route;
        }

        const nextVertices = route.vertices.filter((_, index) => index !== vertexIndex);
        if (vertexIndex === 0) {
          nextVertices[0] = {
            ...nextVertices[0]!,
            incomingMaterial: currentState.endpointRules.start[lineKind],
          };
        } else if (vertexIndex < route.vertices.length - 1) {
          const removed = route.vertices[vertexIndex]!;
          const successor = route.vertices[vertexIndex + 1]!;
          const mergedMaterial =
            removed.incomingMaterial === successor.incomingMaterial
              ? removed.incomingMaterial
              : "flexible";
          nextVertices[vertexIndex] = { ...nextVertices[vertexIndex]!, incomingMaterial: mergedMaterial };
        }

        return { ...route, vertices: nextVertices };
      }),
    }));

    if (blocked) {
      setInteractionNote("Each pipe needs at least one editable waypoint between the two connection areas.");
      return;
    }
    setSelectedVertex(null);
    setSelectedSpan(null);
    setInteractionNote(`${lineKind} waypoint removed.`);
  }, []);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const pointer = toSvgPoint(event.clientX, event.clientY);
      if (!pointer) {
        return;
      }

      if (dragState.kind === "unit") {
        setState((currentState) => ({
          ...currentState,
          unitX: clamp(pointer.x - dragState.offset.x, 40, 320),
          unitY: clamp(pointer.y - dragState.offset.y, 120, 360),
        }));
        return;
      }

      const currentState = latestStateRef.current;
      const currentSimulation = latestSimulationRef.current;
      const route = getRouteByKind(currentState, dragState.lineKind);
      const vertex = route.vertices[dragState.vertexIndex];
      if (!vertex) {
        return;
      }
      const previousPoint =
        dragState.vertexIndex === 0
          ? dragState.lineKind === "gas"
            ? currentSimulation.startLayout.gasSleeveEnd
            : currentSimulation.startLayout.liquidSleeveEnd
          : {
              x: route.vertices[dragState.vertexIndex - 1]!.x,
              y: route.vertices[dragState.vertexIndex - 1]!.y,
            };
      const nextPoint =
        dragState.vertexIndex === route.vertices.length - 1
          ? dragState.lineKind === "gas"
            ? currentSimulation.endLayout.gasSleeveEnd
            : currentSimulation.endLayout.liquidSleeveEnd
          : {
              x: route.vertices[dragState.vertexIndex + 1]!.x,
              y: route.vertices[dragState.vertexIndex + 1]!.y,
            };
      const leftHard =
        dragState.vertexIndex === 0
          ? currentState.endpointRules.start[dragState.lineKind] === "hard"
          : route.vertices[dragState.vertexIndex]!.incomingMaterial === "hard";
      const rightHard =
        dragState.vertexIndex === route.vertices.length - 1
          ? currentState.endpointRules.end[dragState.lineKind] === "hard"
          : route.vertices[dragState.vertexIndex + 1]!.incomingMaterial === "hard";
      const candidate = {
        x: pointer.x - dragState.offset.x,
        y: pointer.y - dragState.offset.y,
      };
      const clamped = clampVertexCandidate({
        pointer: candidate,
        previous: previousPoint,
        next: nextPoint,
        leftHard,
        rightHard,
        safeZones: currentSimulation.safeZones,
      });

      setState((previousState) => ({
        ...previousState,
        pipes: previousState.pipes.map((candidateRoute) => {
          if (candidateRoute.lineKind !== dragState.lineKind) {
            return candidateRoute;
          }
          return {
            ...candidateRoute,
            vertices: candidateRoute.vertices.map((candidateVertex, index) =>
              index === dragState.vertexIndex ? { ...candidateVertex, x: clamped.x, y: clamped.y } : candidateVertex
            ),
          };
        }),
      }));
    };

    const handlePointerUp = () => {
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, toSvgPoint]);

  const insertVertexFromHover = useCallback((hover: HoverInsert) => {
    const simulationNow = latestSimulationRef.current;
    const route = getRouteByKind(latestStateRef.current, hover.lineKind);
    const safeZoneBlocked = simulationNow.safeZones.some((safeZone) => pointInRect(hover.point, safeZone));
    if (safeZoneBlocked) {
      setInteractionNote("That point is inside a protected connection zone. Add the vertex farther from the sleeve area.");
      return;
    }

    let prevPoint: Point2D;
    let nextPoint: Point2D;
    let insertAt = 0;
    let inheritedMaterial: PipeMaterial;
    let selectionVertexIndex: number | null = null;

    if (hover.scope === "start-transition") {
      prevPoint = hover.lineKind === "gas" ? simulationNow.startLayout.gasSleeveEnd : simulationNow.startLayout.liquidSleeveEnd;
      nextPoint = { x: route.vertices[0]!.x, y: route.vertices[0]!.y };
      insertAt = 0;
      inheritedMaterial = latestStateRef.current.endpointRules.start[hover.lineKind];
      selectionVertexIndex = 0;
    } else if (hover.scope === "end-transition") {
      prevPoint = { x: route.vertices[route.vertices.length - 1]!.x, y: route.vertices[route.vertices.length - 1]!.y };
      nextPoint = hover.lineKind === "gas" ? simulationNow.endLayout.gasSleeveEnd : simulationNow.endLayout.liquidSleeveEnd;
      insertAt = route.vertices.length;
      inheritedMaterial = latestStateRef.current.endpointRules.end[hover.lineKind];
      selectionVertexIndex = route.vertices.length;
    } else {
      const targetIndex = hover.vertexIndex ?? 1;
      prevPoint = { x: route.vertices[targetIndex - 1]!.x, y: route.vertices[targetIndex - 1]!.y };
      nextPoint = { x: route.vertices[targetIndex]!.x, y: route.vertices[targetIndex]!.y };
      insertAt = targetIndex;
      inheritedMaterial = route.vertices[targetIndex]!.incomingMaterial;
      selectionVertexIndex = targetIndex;
    }

    if (distance(prevPoint, hover.point) < MIN_SEGMENT_MM || distance(nextPoint, hover.point) < MIN_SEGMENT_MM) {
      setInteractionNote("The span is too short to split there. Insert the new waypoint farther from the end points.");
      return;
    }

    setState((currentState) => ({
      ...currentState,
      pipes: currentState.pipes.map((candidateRoute) => {
        if (candidateRoute.lineKind !== hover.lineKind) {
          return candidateRoute;
        }
        const newVertex: PipeVertex = {
          id: nextId(`${hover.lineKind}-vertex`),
          x: hover.point.x,
          y: hover.point.y,
          incomingMaterial: inheritedMaterial,
        };
        const vertices = [...candidateRoute.vertices];
        vertices.splice(insertAt, 0, newVertex);
        if (hover.scope === "start-transition") {
          vertices[1] = {
            ...vertices[1]!,
            incomingMaterial: currentState.endpointRules.start[hover.lineKind],
          };
        }
        return { ...candidateRoute, vertices };
      }),
    }));

    setSelectedVertex(
      selectionVertexIndex === null
        ? null
        : { lineKind: hover.lineKind, vertexIndex: selectionVertexIndex }
    );
    setSelectedSpan(
      hover.scope === "interior"
        ? { lineKind: hover.lineKind, scope: "interior", vertexIndex: selectionVertexIndex }
        : { lineKind: hover.lineKind, scope: hover.scope, vertexIndex: selectionVertexIndex }
    );
    setEditMode("select");
    setHoverInsert(null);
    setInteractionNote(`${hover.lineKind} waypoint inserted.`);
  }, []);

  const handleSvgMouseDown = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const target = event.target as SVGElement;
      const role = target.getAttribute("data-role");
      const pointer = toSvgPoint(event.clientX, event.clientY);
      if (!pointer) {
        return;
      }

      if (editMode === "add") {
        const hover = findClosestSelectableSpan(pointer);
        if (hover) {
          insertVertexFromHover(hover);
        }
        return;
      }

      if (editMode === "delete") {
        if (role === "vertex") {
          const lineKind = target.getAttribute("data-line-kind") as PipeLineKind;
          const vertexIndex = Number.parseInt(target.getAttribute("data-vertex-index") ?? "-1", 10);
          if (vertexIndex >= 0) {
            deleteVertex(lineKind, vertexIndex);
            setEditMode("select");
          }
        }
        return;
      }

      if (role === "unit") {
        setDragState({
          kind: "unit",
          offset: { x: pointer.x - state.unitX, y: pointer.y - state.unitY },
        });
        setSelectedSpan(null);
        setSelectedVertex(null);
        setInteractionNote("Dragging indoor unit. Connection sleeves and local offsets reflow automatically.");
        return;
      }

      if (role === "vertex") {
        const lineKind = target.getAttribute("data-line-kind") as PipeLineKind;
        const vertexIndex = Number.parseInt(target.getAttribute("data-vertex-index") ?? "-1", 10);
        const route = getRouteByKind(state, lineKind);
        const vertex = route.vertices[vertexIndex];
        if (!vertex) {
          return;
        }
        setDragState({
          kind: "vertex",
          lineKind,
          vertexIndex,
          offset: { x: pointer.x - vertex.x, y: pointer.y - vertex.y },
        });
        setSelectedVertex({ lineKind, vertexIndex });
        setSelectedSpan(
          vertexIndex === 0
            ? { lineKind, scope: "start-transition", vertexIndex: 0 }
            : { lineKind, scope: "interior", vertexIndex }
        );
        setInteractionNote("Dragging waypoint. Hard-adjacent spans snap automatically.");
        return;
      }

      if (role === "span-hit") {
        const lineKind = target.getAttribute("data-line-kind") as PipeLineKind;
        const scope = target.getAttribute("data-scope") as "start-transition" | "interior" | "end-transition";
        const vertexIndexValue = target.getAttribute("data-vertex-index");
        const vertexIndex = vertexIndexValue ? Number.parseInt(vertexIndexValue, 10) : null;
        setSelectedSpan({ lineKind, scope, vertexIndex });
        setSelectedVertex(vertexIndex !== null ? { lineKind, vertexIndex } : null);
        setInteractionNote(`${lineKind} ${scope.replace("-", " ")} selected.`);
        return;
      }

      setSelectedSpan(null);
      setSelectedVertex(null);
    },
    [deleteVertex, editMode, findClosestSelectableSpan, insertVertexFromHover, state, toSvgPoint]
  );

  const handleSvgMouseMove = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (editMode !== "add") {
        setHoverInsert(null);
        return;
      }
      const pointer = toSvgPoint(event.clientX, event.clientY);
      if (!pointer) {
        setHoverInsert(null);
        return;
      }
      setHoverInsert(findClosestSelectableSpan(pointer));
    },
    [editMode, findClosestSelectableSpan, toSvgPoint]
  );

  const handleSvgContextMenu = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const target = event.target as SVGElement;
      if (target.getAttribute("data-role") !== "vertex") {
        return;
      }
      event.preventDefault();
      const lineKind = target.getAttribute("data-line-kind") as PipeLineKind;
      const vertexIndex = Number.parseInt(target.getAttribute("data-vertex-index") ?? "-1", 10);
      if (vertexIndex >= 0) {
        deleteVertex(lineKind, vertexIndex);
      }
    },
    [deleteVertex]
  );

  const selectedMaterial = useMemo(() => {
    if (!selectedSpan) {
      return null;
    }
    if (selectedSpan.scope === "start-transition") {
      return state.endpointRules.start[selectedSpan.lineKind];
    }
    if (selectedSpan.scope === "end-transition") {
      return state.endpointRules.end[selectedSpan.lineKind];
    }
    if (selectedSpan.vertexIndex === null) {
      return null;
    }
    return getRouteByKind(state, selectedSpan.lineKind).vertices[selectedSpan.vertexIndex]?.incomingMaterial ?? null;
  }, [selectedSpan, state]);

  const applySelectedMaterial = useCallback(
    (material: PipeMaterial) => {
      if (!selectedSpan) {
        return;
      }
      if (selectedSpan.scope === "start-transition") {
        updateEndpointMaterial("start", selectedSpan.lineKind, material);
        return;
      }
      if (selectedSpan.scope === "end-transition") {
        updateEndpointMaterial("end", selectedSpan.lineKind, material);
        return;
      }
      if (selectedSpan.vertexIndex === null) {
        return;
      }
      updateInteriorMaterial(selectedSpan.lineKind, selectedSpan.vertexIndex, material);
    },
    [selectedSpan, updateEndpointMaterial, updateInteriorMaterial]
  );

  const currentSelectedVertex = useMemo(() => {
    if (!selectedVertex) {
      return null;
    }
    const route = getRouteByKind(state, selectedVertex.lineKind);
    return route.vertices[selectedVertex.vertexIndex] ?? null;
  }, [selectedVertex, state]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_#f6efe1,_#ece2d1_45%,_#dfd3bf_100%)] text-slate-900">
      <div className="mx-auto flex max-w-[1720px] flex-col gap-5 px-4 py-5 lg:px-6 xl:px-8">
        <header className="rounded-[28px] border border-stone-200/80 bg-white/85 px-5 py-4 shadow-sm backdrop-blur">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
                <Link href="/" className="rounded-full border border-stone-200 px-3 py-1 text-stone-600 transition hover:border-stone-300 hover:bg-stone-50">
                  ProvacX
                </Link>
                <span>Standalone Simulator</span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
                Pipe Connection Material Simulator
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-slate-600">
                Two independent pipe routes with per-segment hard and flexible copper selection. The connection sleeves stay straight,
                tight zones stay protected, and the analysis updates live for spacing, bends, adapters, and condensation risk.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <WarningBadge
                label={simulation.analysis.warningItems.some((warning) => warning.severity === "error") ? "Failing checks" : "Engineering checks pass"}
                active
                tone={simulation.analysis.warningItems.some((warning) => warning.severity === "error") ? "error" : "ok"}
              />
              <WarningBadge
                label={simulation.analysis.condensationRisk ? "Condensation risk active" : "Condensation risk controlled"}
                active
                tone={simulation.analysis.condensationRisk ? "warn" : "ok"}
              />
              <WarningBadge
                label={`Min air gap ${formatMm(simulation.analysis.actualMinimumAirGapMm)}`}
                active
                tone={simulation.analysis.actualMinimumAirGapMm + 0.25 < state.extraGapMm ? "error" : "ok"}
              />
            </div>
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)_330px]">
          <div className="space-y-4">
            <Section title="Presets">
              <div className="grid gap-3">
                {SCENARIO_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => updatePreset(preset)}
                    className={`rounded-2xl border px-4 py-3 text-left transition ${
                      state.lastPresetId === preset.id
                        ? "border-amber-400 bg-amber-50 text-slate-900 shadow-sm"
                        : "border-stone-200 bg-stone-50 text-slate-700 hover:border-stone-300 hover:bg-white"
                    }`}
                  >
                    <div className="text-sm font-semibold">{preset.name}</div>
                    <div className="mt-1 text-xs leading-5 text-slate-600">{preset.description}</div>
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={resetToDefault}
                className="w-full rounded-2xl border border-stone-300 bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-black"
              >
                Reset To Baseline Demo
              </button>
            </Section>

            <Section title="Pipe Sizes">
              <NumberField
                label="Gas pipe diameter"
                value={state.gasDiameterMm}
                min={9.52}
                max={22.2}
                step={0.1}
                suffix="mm"
                onChange={(value) => setState((currentState) => ({ ...currentState, gasDiameterMm: value }))}
              />
              <NumberField
                label="Liquid pipe diameter"
                value={state.liquidDiameterMm}
                min={6.35}
                max={15.88}
                step={0.1}
                suffix="mm"
                onChange={(value) => setState((currentState) => ({ ...currentState, liquidDiameterMm: value }))}
              />
              <NumberField
                label="Connection sleeve length"
                value={state.sleeveLengthMm}
                min={120}
                max={320}
                step={5}
                suffix="mm"
                onChange={(value) => setState((currentState) => ({ ...currentState, sleeveLengthMm: value }))}
              />
              <NumberField
                label="Sleeve insulation thickness"
                value={state.insulationThicknessMm}
                min={9}
                max={25}
                step={1}
                suffix="mm"
                onChange={(value) => setState((currentState) => ({ ...currentState, insulationThicknessMm: value }))}
              />
              <NumberField
                label="Extra safety air gap"
                value={state.extraGapMm}
                min={5}
                max={40}
                step={1}
                suffix="mm"
                onChange={(value) => setState((currentState) => ({ ...currentState, extraGapMm: value }))}
              />
              <NumberField
                label="Protected connection zone"
                value={state.tightZoneMm}
                min={120}
                max={320}
                step={5}
                suffix="mm"
                onChange={(value) => setState((currentState) => ({ ...currentState, tightZoneMm: value }))}
              />
              <NumberField
                label="Minimum flex bend radius"
                value={state.minBendRadiusMm}
                min={40}
                max={160}
                step={5}
                suffix="mm"
                onChange={(value) => setState((currentState) => ({ ...currentState, minBendRadiusMm: value }))}
              />
            </Section>

            <Section title="Offset Rule">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">Hard-copper 45 degree offset owner</span>
                <select
                  value={state.offsetOwner}
                  onChange={(event) =>
                    setState((currentState) => ({
                      ...currentState,
                      offsetOwner: event.target.value as "auto" | PipeLineKind,
                    }))
                  }
                  className="w-full rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-amber-500"
                >
                  <option value="auto">Auto: smaller pipe</option>
                  <option value="gas">Gas pipe</option>
                  <option value="liquid">Liquid pipe</option>
                </select>
              </label>
              <div className="rounded-2xl border border-stone-200 bg-stone-50 px-3 py-3 text-xs leading-5 text-slate-600">
                Current resolved owner:{" "}
                <span className="font-semibold text-slate-900">
                  {simulation.resolvedOffsetOwner === "gas" ? "Gas pipe" : "Liquid pipe"}
                </span>
              </div>
            </Section>

            <Section title="Endpoint Materials">
              <div className="grid gap-3 sm:grid-cols-2">
                <MaterialSelect
                  label="Start gas"
                  value={state.endpointRules.start.gas}
                  onChange={(material) => updateEndpointMaterial("start", "gas", material)}
                />
                <MaterialSelect
                  label="Start liquid"
                  value={state.endpointRules.start.liquid}
                  onChange={(material) => updateEndpointMaterial("start", "liquid", material)}
                />
                <MaterialSelect
                  label="End gas"
                  value={state.endpointRules.end.gas}
                  onChange={(material) => updateEndpointMaterial("end", "gas", material)}
                />
                <MaterialSelect
                  label="End liquid"
                  value={state.endpointRules.end.liquid}
                  onChange={(material) => updateEndpointMaterial("end", "liquid", material)}
                />
              </div>
            </Section>

            <Section title="Selection">
              {selectedSpan ? (
                <div className="space-y-3">
                  <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-slate-700">
                    <div className="font-semibold text-slate-900">
                      {selectedSpan.lineKind === "gas" ? "Gas" : "Liquid"} {selectedSpan.scope.replace("-", " ")}
                    </div>
                    <div className="mt-1 text-xs leading-5 text-slate-600">
                      {selectedSpan.scope === "start-transition" && "Material change updates the local indoor-unit connection span."}
                      {selectedSpan.scope === "interior" && "Material change updates only the selected middle route span."}
                      {selectedSpan.scope === "end-transition" && "Material change updates the local field-pipe connection span."}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <MaterialToggleButton
                      active={selectedMaterial === "hard"}
                      label="Hard copper"
                      onClick={() => applySelectedMaterial("hard")}
                    />
                    <MaterialToggleButton
                      active={selectedMaterial === "flexible"}
                      label="Flexible copper"
                      onClick={() => applySelectedMaterial("flexible")}
                    />
                  </div>
                  {selectedVertex && currentSelectedVertex ? (
                    <button
                      type="button"
                      onClick={() => deleteVertex(selectedVertex.lineKind, selectedVertex.vertexIndex)}
                      className="w-full rounded-2xl border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-50"
                    >
                      Delete Selected Waypoint
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm leading-6 text-slate-600">
                  Select a visible span or waypoint in the scene to edit its material or remove a waypoint.
                </div>
              )}
            </Section>

            <Section title="Layout">
              <NumberField
                label="Field pipe pitch"
                value={state.fieldPitchMm}
                min={36}
                max={120}
                step={1}
                suffix="mm"
                onChange={(value) => setState((currentState) => ({ ...currentState, fieldPitchMm: value }))}
              />
              <NumberField
                label="Field pipe vertical shift"
                value={state.fieldShiftY}
                min={-90}
                max={90}
                step={1}
                suffix="mm"
                onChange={(value) => setState((currentState) => ({ ...currentState, fieldShiftY: value }))}
              />
            </Section>
          </div>

          <Section title="Connection Scene">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setEditMode("select")}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${editMode === "select" ? "bg-stone-900 text-white" : "bg-white text-slate-700 ring-1 ring-stone-200 hover:bg-stone-100"}`}
                >
                  Select / drag
                </button>
                <button
                  type="button"
                  onClick={() => setEditMode("add")}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${editMode === "add" ? "bg-stone-900 text-white" : "bg-white text-slate-700 ring-1 ring-stone-200 hover:bg-stone-100"}`}
                >
                  Add waypoint
                </button>
                <button
                  type="button"
                  onClick={() => setEditMode("delete")}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${editMode === "delete" ? "bg-stone-900 text-white" : "bg-white text-slate-700 ring-1 ring-stone-200 hover:bg-stone-100"}`}
                >
                  Delete waypoint
                </button>
                <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-slate-600">
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" checked={showProtectedZones} onChange={(event) => setShowProtectedZones(event.target.checked)} />
                    Protected zones
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" checked={showFittings} onChange={(event) => setShowFittings(event.target.checked)} />
                    Fittings
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <input type="checkbox" checked={showLengths} onChange={(event) => setShowLengths(event.target.checked)} />
                    Lengths
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-xs text-slate-600">
                <WarningBadge label="Gas" active tone="ok" />
                <div className="h-1.5 w-8 rounded-full" style={{ backgroundColor: GAS_COLOR }} />
                <WarningBadge label="Liquid" active tone="ok" />
                <div className="h-1.5 w-8 rounded-full" style={{ backgroundColor: LIQUID_COLOR }} />
                <WarningBadge label="Hard copper" active tone="warn" />
                <div className="h-1.5 w-8 rounded-full bg-stone-900" />
                <WarningBadge label="Flexible copper" active tone="warn" />
                <div className="h-1.5 w-8 rounded-full bg-stone-900" style={{ backgroundImage: "linear-gradient(90deg, #111827 50%, transparent 50%)", backgroundSize: "10px 2px" }} />
                <WarningBadge label="Protected zone" active tone="warn" />
              </div>

              <div className="rounded-[28px] border border-stone-200 bg-[#f8f4ec] p-3 shadow-inner">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-stone-200 bg-white/85 px-4 py-3 text-xs text-slate-600">
                  <div>{interactionNote}</div>
                  <div className="font-semibold text-slate-900">
                    Required center spacing {formatMm(simulation.requiredCenterSpacingMm)}
                  </div>
                </div>

                <svg
                  ref={svgRef}
                  viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
                  className={`h-auto min-h-[520px] w-full rounded-[24px] border border-stone-200 bg-[linear-gradient(180deg,_rgba(255,255,255,0.96),_rgba(246,241,233,0.95))] ${editMode === "add" ? "cursor-crosshair" : editMode === "delete" ? "cursor-not-allowed" : dragState ? "cursor-grabbing" : "cursor-default"}`}
                  onMouseDown={handleSvgMouseDown}
                  onMouseMove={handleSvgMouseMove}
                  onMouseLeave={() => setHoverInsert(null)}
                  onContextMenu={handleSvgContextMenu}
                >
                  <defs>
                    <pattern id="scene-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="1" />
                    </pattern>
                  </defs>
                  <rect width={SCENE_WIDTH} height={SCENE_HEIGHT} fill="url(#scene-grid)" />

                  {showProtectedZones &&
                    simulation.safeZones.map((safeZone) => (
                      <g key={safeZone.id}>
                        <rect
                          x={safeZone.minX}
                          y={safeZone.minY}
                          width={safeZone.maxX - safeZone.minX}
                          height={safeZone.maxY - safeZone.minY}
                          rx={20}
                          fill={SAFE_ZONE_FILL}
                          stroke={SAFE_ZONE_STROKE}
                          strokeDasharray="10 10"
                        />
                        <text x={safeZone.minX + 14} y={safeZone.minY - 8} className="fill-amber-800 text-[12px] font-semibold">
                          {safeZone.label}
                        </text>
                      </g>
                    ))}

                  <g>
                    <rect
                      x={state.unitX}
                      y={state.unitY}
                      width={UNIT_WIDTH}
                      height={UNIT_HEIGHT}
                      rx={28}
                      fill={UNIT_FILL}
                      stroke="#a16207"
                      strokeWidth="2.5"
                      data-role="unit"
                    />
                    <text x={state.unitX + 24} y={state.unitY + 36} className="fill-slate-900 text-[18px] font-semibold pointer-events-none">
                      Indoor Unit Ports
                    </text>
                    <text x={state.unitX + 24} y={state.unitY + 64} className="fill-slate-500 text-[13px] pointer-events-none">
                      Straight insulated connection sleeve: {state.sleeveLengthMm} mm
                    </text>
                  </g>

                  <g>
                    <rect
                      x={FIELD_X - FIELD_MANIFOLD_WIDTH}
                      y={state.unitY + UNIT_HEIGHT / 2 + state.fieldShiftY - FIELD_MANIFOLD_HEIGHT / 2}
                      width={FIELD_MANIFOLD_WIDTH}
                      height={FIELD_MANIFOLD_HEIGHT}
                      rx={24}
                      fill={UNIT_FILL}
                      stroke="#854d0e"
                      strokeWidth="2.5"
                    />
                    <text x={FIELD_X - FIELD_MANIFOLD_WIDTH + 16} y={state.unitY + UNIT_HEIGHT / 2 + state.fieldShiftY - 32} className="fill-slate-900 text-[16px] font-semibold pointer-events-none">
                      Field Pipes
                    </text>
                    <text x={FIELD_X - FIELD_MANIFOLD_WIDTH + 16} y={state.unitY + UNIT_HEIGHT / 2 + state.fieldShiftY - 10} className="fill-slate-500 text-[12px] pointer-events-none">
                      Pitch {formatMm(state.fieldPitchMm)}
                    </text>
                  </g>

                  {[...simulation.routes.gas.spans, ...simulation.routes.liquid.spans]
                    .filter((span) => span.scope === "start-sleeve" || span.scope === "end-sleeve")
                    .map((span) => {
                      const isGas = span.lineKind === "gas";
                      const outerDiameterMm =
                        (isGas ? state.gasDiameterMm : state.liquidDiameterMm) + state.insulationThicknessMm * 2;
                      return (
                        <path
                          key={`${span.id}-insulation`}
                          d={span.d}
                          stroke={INSULATION_COLOR}
                          strokeWidth={outerDiameterMm}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          opacity={0.92}
                          fill="none"
                        />
                      );
                    })}

                  {[simulation.routes.gas, simulation.routes.liquid].map((route) =>
                    route.spans.map((span) => {
                      const isGas = span.lineKind === "gas";
                      const color = isGas ? GAS_COLOR : LIQUID_COLOR;
                      const fillColor = isGas ? GAS_FILL : LIQUID_FILL;
                      const diameter = isGas ? state.gasDiameterMm : state.liquidDiameterMm;
                      const highlighted = activeWarningSet.has(span.id);
                      return (
                        <g key={span.id}>
                          {highlighted ? (
                            <path
                              d={span.d}
                              stroke="rgba(220,38,38,0.18)"
                              strokeWidth={diameter + 16}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              fill="none"
                            />
                          ) : null}
                          <path
                            d={span.d}
                            stroke={fillColor}
                            strokeWidth={diameter + 4}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            fill="none"
                            opacity={0.92}
                          />
                          <path
                            d={span.d}
                            stroke={highlighted ? "#dc2626" : color}
                            strokeWidth={diameter}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeDasharray={span.material === "hard" ? undefined : FLEX_DASH}
                            fill="none"
                          />
                          {showLengths ? (
                            <g>
                              <rect
                                x={midpoint(span.start, span.end).x - 26}
                                y={midpoint(span.start, span.end).y - 10}
                                width={52}
                                height={16}
                                rx={4}
                                fill="rgba(255,255,255,0.95)"
                                stroke="#cbd5e1"
                                strokeWidth="0.5"
                              />
                              <text
                                x={midpoint(span.start, span.end).x}
                                y={midpoint(span.start, span.end).y + 2}
                                textAnchor="middle"
                                className="fill-slate-700 text-[10px]"
                              >
                                {Math.round(span.lengthMm)} mm
                              </text>
                            </g>
                          ) : null}
                        </g>
                      );
                    })
                  )}

                  {[simulation.routes.gas, simulation.routes.liquid].map((route) =>
                    route.spans
                      .filter((span) => span.selectable)
                      .map((span) => (
                        <path
                          key={`${span.id}-hit`}
                          d={span.d}
                          stroke="transparent"
                          strokeWidth="24"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                          data-role="span-hit"
                          data-line-kind={span.lineKind}
                          data-scope={span.scope}
                          data-vertex-index={span.vertexIndex ?? undefined}
                        />
                      ))
                  )}

                  {showFittings
                    ? [simulation.routes.gas, simulation.routes.liquid].map((route) =>
                        route.nodes.map((node) => {
                          if (["endpoint", "coupler", "none"].includes(node.fitting)) {
                            return null;
                          }
                          if (node.fitting === "adapter") {
                            return (
                              <rect
                                key={node.id}
                                x={node.p.x - 7}
                                y={node.p.y - 5}
                                width={14}
                                height={10}
                                rx={2}
                                fill="#4b5563"
                                stroke="#1f2937"
                                strokeWidth="1"
                              />
                            );
                          }
                          const fill =
                            node.fitting === "elbow45"
                              ? "#f59e0b"
                              : node.fitting === "elbow90"
                                ? "#3b82f6"
                                : "#ef4444";
                          const halo = route.hardBendNodeIds.includes(node.id);
                          return (
                            <g key={node.id}>
                              {halo ? <circle cx={node.p.x} cy={node.p.y} r={16} fill={TIGHT_HALO} /> : null}
                              <circle cx={node.p.x} cy={node.p.y} r={7} fill={fill} stroke="white" strokeWidth="1.5" />
                            </g>
                          );
                        })
                      )
                    : null}

                  {[simulation.routes.gas, simulation.routes.liquid].map((route) =>
                    route.kinkVertexIndices.map((vertexIndex) => {
                      const vertex = getRouteByKind(state, route.lineKind).vertices[vertexIndex]!;
                      return (
                        <circle
                          key={`${route.lineKind}-kink-${vertexIndex}`}
                          cx={vertex.x}
                          cy={vertex.y}
                          r={16}
                          fill={KINK_HALO}
                        />
                      );
                    })
                  )}

                  {state.pipes.map((route) =>
                    route.vertices.map((vertex, index) => {
                      const selected = selectedVertex?.lineKind === route.lineKind && selectedVertex.vertexIndex === index;
                      const color = route.lineKind === "gas" ? GAS_COLOR : LIQUID_COLOR;
                      return (
                        <g key={vertex.id}>
                          <circle
                            cx={vertex.x}
                            cy={vertex.y}
                            r={10}
                            fill="#ffffff"
                            stroke={selected ? "#0f172a" : color}
                            strokeWidth={selected ? 3 : 2.5}
                            data-role="vertex"
                            data-line-kind={route.lineKind}
                            data-vertex-index={index}
                          />
                          <circle cx={vertex.x} cy={vertex.y} r={3.5} fill="#0f172a" pointerEvents="none" />
                        </g>
                      );
                    })
                  )}

                  {[simulation.startLayout.gasPort, simulation.startLayout.liquidPort, simulation.endLayout.gasPort, simulation.endLayout.liquidPort].map((point, index) => (
                    <circle
                      key={`port-${index}-${point.x}-${point.y}`}
                      cx={point.x}
                      cy={point.y}
                      r={8}
                      fill={index % 2 === 0 ? GAS_COLOR : LIQUID_COLOR}
                      stroke="white"
                      strokeWidth="3"
                    />
                  ))}

                  <g>
                    <line
                      x1={simulation.startLayout.gasPort.x + 26}
                      y1={simulation.startLayout.gasPort.y}
                      x2={simulation.startLayout.gasPort.x + 26}
                      y2={simulation.startLayout.liquidPort.y}
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                      strokeDasharray="4 6"
                    />
                    <text x={simulation.startLayout.gasPort.x + 38} y={midpoint(simulation.startLayout.gasPort, simulation.startLayout.liquidPort).y + 4} className="fill-slate-500 text-[12px] font-semibold">
                      Start pitch {formatMm(Math.abs(simulation.startLayout.liquidPort.y - simulation.startLayout.gasPort.y))}
                    </text>
                  </g>

                  <g>
                    <line
                      x1={simulation.endLayout.gasPort.x - 26}
                      y1={simulation.endLayout.gasPort.y}
                      x2={simulation.endLayout.gasPort.x - 26}
                      y2={simulation.endLayout.liquidPort.y}
                      stroke="#94a3b8"
                      strokeWidth="1.5"
                      strokeDasharray="4 6"
                    />
                    <text
                      x={simulation.endLayout.gasPort.x - 38}
                      y={midpoint(simulation.endLayout.gasPort, simulation.endLayout.liquidPort).y + 4}
                      textAnchor="end"
                      className="fill-slate-500 text-[12px] font-semibold"
                    >
                      End pitch {formatMm(Math.abs(simulation.endLayout.liquidPort.y - simulation.endLayout.gasPort.y))}
                    </text>
                  </g>

                  <text x={96} y={80} className="fill-slate-500 text-[12px] font-semibold uppercase tracking-[0.16em]">
                    Protected {Math.round(state.tightZoneMm)} mm connection zone
                  </text>
                  <text x={SCENE_WIDTH - 90} y={80} textAnchor="end" className="fill-slate-500 text-[12px] font-semibold uppercase tracking-[0.16em]">
                    Problem spans highlighted in red
                  </text>

                  {hoverInsert ? (
                    <g pointerEvents="none">
                      <circle cx={hoverInsert.point.x} cy={hoverInsert.point.y} r={15} fill="rgba(22,163,74,0.16)" />
                      <circle cx={hoverInsert.point.x} cy={hoverInsert.point.y} r={7} fill="#fff" stroke="#16a34a" strokeWidth="2" />
                    </g>
                  ) : null}
                </svg>
              </div>
            </div>
          </Section>

          <div className="space-y-4">
            <Section title="Analysis">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <MetricCard label="Required center spacing" value={formatMm(simulation.analysis.requiredCenterSpacingMm)} />
                <MetricCard label="Actual minimum center spacing" value={formatMm(simulation.analysis.actualMinimumSpacingMm)} />
                <MetricCard label="Actual minimum air gap" value={formatMm(simulation.analysis.actualMinimumAirGapMm)} />
                <MetricCard label="Bend count" value={`${simulation.analysis.bendCount}`} />
              </div>
              <div className="grid gap-2">
                <WarningBadge label={simulation.analysis.sleeveClash ? "Sleeve clash detected" : "Sleeve clearance available"} active tone={simulation.analysis.sleeveClash ? "error" : "ok"} />
                <WarningBadge label={simulation.analysis.inadequateGap ? "Separation gap violated" : "Required gap maintained"} active tone={simulation.analysis.inadequateGap ? "error" : "ok"} />
                <WarningBadge label={simulation.analysis.condensationRisk ? "Condensation risk active" : "Condensation risk controlled"} active tone={simulation.analysis.condensationRisk ? "warn" : "ok"} />
              </div>
            </Section>

            <Section title="Bill Of Materials">
              <BomRow label="Gas hard copper" value={formatMm(simulation.analysis.hardGasMm)} />
              <BomRow label="Gas flexible copper" value={formatMm(simulation.analysis.flexGasMm)} />
              <BomRow label="Liquid hard copper" value={formatMm(simulation.analysis.hardLiquidMm)} />
              <BomRow label="Liquid flexible copper" value={formatMm(simulation.analysis.flexLiquidMm)} />
              <BomRow label="45 degree elbows" value={`${simulation.analysis.elbow45Count}`} />
              <BomRow label="90 degree elbows" value={`${simulation.analysis.elbow90Count}`} />
              <BomRow label="Hard to flex adapters" value={`${simulation.analysis.adapterCount}`} />
              <BomRow label="Flex kink warnings" value={`${simulation.analysis.kinkWarningCount}`} />
              <BomRow label="Hard bends in tight zone" value={`${simulation.analysis.hardBendInTightZoneCount}`} />
              <BomRow label="Invalid hard angles" value={`${simulation.analysis.invalidHardAngleCount}`} />
            </Section>

            <Section title="Sleeve Checks">
              <MetricCard label="Indoor unit sleeve air gap" value={formatMm(simulation.analysis.startSleeveGapMm)} compact />
              <MetricCard label="Field sleeve air gap" value={formatMm(simulation.analysis.endSleeveGapMm)} compact />
              <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-xs leading-6 text-slate-600">
                Only the local connection sleeves are insulated in this demo. The route analysis still samples the actual gas and liquid centerlines along the full path to catch bundled condensation risk.
              </div>
            </Section>

            <Section title="Warnings">
              {simulation.analysis.warningItems.length === 0 ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm font-medium text-emerald-700">
                  No active warnings. The current geometry satisfies the configured gap and material rules.
                </div>
              ) : (
                <div className="space-y-3">
                  {simulation.analysis.warningItems.map((warning) => (
                    <div
                      key={warning.code}
                      className={`rounded-2xl border px-4 py-4 ${warning.severity === "error" ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-900">{warning.title}</div>
                          <div className="mt-1 text-xs leading-5 text-slate-600">{warning.detail}</div>
                        </div>
                        <div className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${warning.severity === "error" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800"}`}>
                          {warning.code}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
