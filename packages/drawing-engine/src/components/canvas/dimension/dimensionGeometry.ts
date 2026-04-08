/**
 * Dimension geometry and formatting helpers.
 *
 * All coordinates are in mm (world space).
 */

import type {
  Dimension2D,
  DimensionAnchor,
  DimensionDisplayFormat,
  DimensionLinearMode,
  DimensionSettings,
  Point2D,
  Room,
  Wall,
} from '../../../types';

export interface DimensionStyleProfile {
  extensionStrokeWidth: number;
  dimensionStrokeWidth: number;
  textSizePx: number;
  terminator: 'arrow' | 'tick';
}

export interface ResolvedLinearDimensionGeometry {
  kind: 'linear';
  start: Point2D;
  end: Point2D;
  dimensionStart: Point2D;
  dimensionEnd: Point2D;
  extensionAStart: Point2D;
  extensionAEnd: Point2D;
  extensionBStart: Point2D;
  extensionBEnd: Point2D;
  direction: Point2D;
  normal: Point2D;
  midpoint: Point2D;
  length: number;
  textPosition: Point2D;
  textPositionRatio: number;
  valueMm: number;
  label: string;
}

export interface ResolvedAngularDimensionGeometry {
  kind: 'angular';
  vertex: Point2D;
  legA: Point2D;
  legB: Point2D;
  arcStart: Point2D;
  arcEnd: Point2D;
  radius: number;
  startAngle: number;
  endAngle: number;
  deltaAngle: number;
  textPosition: Point2D;
  valueDeg: number;
  label: string;
  isCommonAngle: boolean;
}

export interface ResolvedAreaDimensionGeometry {
  kind: 'area';
  textPosition: Point2D;
  valueMm2: number;
  perimeterMm: number;
  label: string;
}

export type ResolvedDimensionGeometry =
  | ResolvedLinearDimensionGeometry
  | ResolvedAngularDimensionGeometry
  | ResolvedAreaDimensionGeometry;

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(vector: Point2D, amount: number): Point2D {
  return { x: vector.x * amount, y: vector.y * amount };
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function magnitude(vector: Point2D): number {
  return Math.hypot(vector.x, vector.y);
}

function normalize(vector: Point2D): Point2D {
  const len = magnitude(vector);
  if (len < 0.000001) return { x: 1, y: 0 };
  return { x: vector.x / len, y: vector.y / len };
}

function perpendicular(vector: Point2D): Point2D {
  return { x: -vector.y, y: vector.x };
}

function toShortAngleDelta(start: number, end: number): number {
  let delta = end - start;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function toPoint(angle: number, radius: number): Point2D {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function near(value: number, target: number, tolerance: number): boolean {
  return Math.abs(value - target) <= tolerance;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function valueToFtIn(mm: number, precision: number): string {
  const totalInches = mm / 25.4;
  let feet = Math.floor(totalInches / 12);
  let inches = totalInches - feet * 12;
  const step = Math.pow(10, precision);
  inches = Math.round(inches * step) / step;
  if (inches >= 12) {
    feet += 1;
    inches -= 12;
  }
  return `${feet}'-${inches.toFixed(precision)}"`;
}

function valueToInches(mm: number, precision: number): string {
  return `${(mm / 25.4).toFixed(precision)}"`;
}

function resolveDisplayFormat(
  mm: number,
  settings: DimensionSettings,
  override?: DimensionDisplayFormat
): DimensionDisplayFormat {
  if (override && override !== 'auto') return override;
  if (settings.displayFormat !== 'auto') return settings.displayFormat;
  if (settings.unitSystem === 'imperial') return 'ft-in';
  return mm >= 1000 ? 'm' : 'mm';
}

export function formatDimensionLength(
  mm: number,
  settings: DimensionSettings,
  override?: DimensionDisplayFormat
): string {
  const precision = override ? settings.precision : settings.precision;
  const format = resolveDisplayFormat(mm, settings, override);
  if (format === 'ft-in') return valueToFtIn(mm, precision);
  if (format === 'in') return valueToInches(mm, precision);
  if (format === 'm') return `${(mm / 1000).toFixed(precision)}m`;
  if (format === 'mm') {
    if (mm >= 8000) {
      const major = Math.floor(mm / 1000) * 1000;
      const rest = mm - major;
      return `${major.toFixed(0)} + ${rest.toFixed(0)} mm`;
    }
    return `${mm.toFixed(precision)}mm`;
  }
  return `${mm.toFixed(precision)}mm`;
}

export function formatDimensionArea(mm2: number, settings: DimensionSettings): string {
  if (settings.unitSystem === 'imperial') {
    const squareFeet = mm2 / (25.4 * 25.4 * 144);
    return `${squareFeet.toFixed(settings.precision)} ft2`;
  }
  return `${(mm2 / 1_000_000).toFixed(settings.precision)} m2`;
}

export function formatDimensionPerimeter(mm: number, settings: DimensionSettings): string {
  return formatDimensionLength(mm, settings);
}

export function getDimensionStyleProfile(
  settings: DimensionSettings,
  styleOverride?: Dimension2D['style']
): DimensionStyleProfile {
  const style = styleOverride ?? settings.style;
  if (style === 'engineering') {
    return {
      extensionStrokeWidth: 1,
      dimensionStrokeWidth: 1.7,
      textSizePx: 12,
      terminator: settings.terminator === 'tick' ? 'arrow' : settings.terminator,
    };
  }
  if (style === 'minimal') {
    return {
      extensionStrokeWidth: 0.9,
      dimensionStrokeWidth: 1.2,
      textSizePx: 10,
      terminator: 'tick',
    };
  }
  return {
    extensionStrokeWidth: 1,
    dimensionStrokeWidth: 1.4,
    textSizePx: 11,
    terminator: settings.terminator,
  };
}

function resolveAnchorPoint(anchor: DimensionAnchor | undefined, wallsById: Map<string, Wall>): Point2D | null {
  if (!anchor) return null;
  if (anchor.kind === 'point') {
    return anchor.point ? { ...anchor.point } : null;
  }
  const wall = anchor.wallId ? wallsById.get(anchor.wallId) : null;
  if (!wall) return null;
  if (anchor.kind === 'wall-midpoint') {
    return midpoint(wall.startPoint, wall.endPoint);
  }
  if (anchor.kind === 'wall-endpoint') {
    if (anchor.endpoint === 'end') return { ...wall.endPoint };
    return { ...wall.startPoint };
  }
  return null;
}

function resolveDimensionPoints(
  dimension: Dimension2D,
  wallsById: Map<string, Wall>
): Point2D[] {
  if (Array.isArray(dimension.anchors) && dimension.anchors.length > 0) {
    const resolved = dimension.anchors
      .map((anchor) => resolveAnchorPoint(anchor, wallsById))
      .filter((point): point is Point2D => Boolean(point));
    if (resolved.length >= 2) return resolved;
  }
  return dimension.points.map((point) => ({ ...point }));
}

function buildLinearGeometry(
  dimension: Dimension2D,
  points: Point2D[],
  settings: DimensionSettings,
  wallsById: Map<string, Wall>
): ResolvedLinearDimensionGeometry | null {
  if (points.length < 2) return null;
  const p1 = points[0];
  const p2 = points[1];
  const mode: DimensionLinearMode =
    dimension.type === 'aligned'
      ? 'aligned'
      : dimension.linearMode ?? (dimension.type === 'linear' ? 'horizontal' : 'aligned');
  const offsetSigned = dimension.offset ?? settings.defaultOffset;
  const offsetDirection = offsetSigned >= 0 ? 1 : -1;
  const offsetAbs = Math.abs(offsetSigned);
  const linkedWallThickness = Array.isArray(dimension.linkedWallIds)
    ? dimension.linkedWallIds.reduce((maxThickness, wallId) => {
      const thickness = wallsById.get(wallId)?.thickness ?? 0;
      return Math.max(maxThickness, Number.isFinite(thickness) ? thickness : 0);
    }, 0)
    : 0;
  const isAutoExteriorDimension =
    dimension.baselineGroupId === 'auto-exterior' ||
    dimension.baselineGroupId === 'auto-exterior-overall';
  const wallClearanceGap = isAutoExteriorDimension && linkedWallThickness > 0
    ? linkedWallThickness + 100
    : 0;
  const extensionGap = Math.max(0, settings.extensionGap, wallClearanceGap);
  const extensionBeyond = Math.max(0, settings.extensionBeyond);

  let dimensionStart: Point2D;
  let dimensionEnd: Point2D;
  let normal: Point2D;
  let direction: Point2D;
  let valueMm: number;

  if (mode === 'horizontal') {
    const y = (p1.y + p2.y) / 2 + offsetSigned;
    dimensionStart = { x: p1.x, y };
    dimensionEnd = { x: p2.x, y };
    direction = normalize(subtract(dimensionEnd, dimensionStart));
    normal = { x: 0, y: offsetDirection };
    valueMm = Math.abs(p2.x - p1.x);
  } else if (mode === 'vertical') {
    const x = (p1.x + p2.x) / 2 + offsetSigned;
    dimensionStart = { x, y: p1.y };
    dimensionEnd = { x, y: p2.y };
    direction = normalize(subtract(dimensionEnd, dimensionStart));
    normal = { x: offsetDirection, y: 0 };
    valueMm = Math.abs(p2.y - p1.y);
  } else {
    const rawDirection = normalize(subtract(p2, p1));
    const rawNormal = perpendicular(rawDirection);
    const signedNormal = scale(rawNormal, offsetDirection);
    dimensionStart = add(p1, scale(signedNormal, offsetAbs));
    dimensionEnd = add(p2, scale(signedNormal, offsetAbs));
    direction = normalize(subtract(dimensionEnd, dimensionStart));
    normal = signedNormal;
    valueMm = magnitude(subtract(p2, p1));
  }

  const extensionAStart = add(p1, scale(normal, extensionGap));
  const extensionAEnd = add(dimensionStart, scale(normal, extensionBeyond));
  const extensionBStart = add(p2, scale(normal, extensionGap));
  const extensionBEnd = add(dimensionEnd, scale(normal, extensionBeyond));
  const mid = midpoint(dimensionStart, dimensionEnd);
  const lineLength = magnitude(subtract(dimensionEnd, dimensionStart));
  const projectedTextRatio =
    lineLength > 0.000001
      ? clamp(
        dot(subtract(dimension.textPosition, dimensionStart), direction) / lineLength,
        0.08,
        0.92
      )
      : 0.5;
  const textPositionRatio = dimension.textPositionLocked
    ? (
      Number.isFinite(dimension.textPositionRatio)
        ? clamp(dimension.textPositionRatio as number, 0.08, 0.92)
        : projectedTextRatio
    )
    : 0.5;
  const textPosition = add(dimensionStart, scale(direction, lineLength * textPositionRatio));
  const designValueLabel = dimension.isDesignValue
    ? (
      dimension.text && dimension.text.trim().length > 0
        ? dimension.text
        : formatDimensionLength(
          Number.isFinite(dimension.value) ? Math.max(0, dimension.value) : valueMm,
          settings,
          dimension.displayFormat
        )
    )
    : null;
  const label = designValueLabel ?? formatDimensionLength(valueMm, settings, dimension.displayFormat);

  return {
    kind: 'linear',
    start: p1,
    end: p2,
    dimensionStart,
    dimensionEnd,
    extensionAStart,
    extensionAEnd,
    extensionBStart,
    extensionBEnd,
    direction,
    normal,
    midpoint: mid,
    length: lineLength,
    textPosition,
    textPositionRatio,
    valueMm,
    label,
  };
}

function buildAngularGeometry(
  dimension: Dimension2D,
  points: Point2D[],
  settings: DimensionSettings
): ResolvedAngularDimensionGeometry | null {
  if (points.length < 3) return null;
  const vertex = points[0];
  const legA = points[1];
  const legB = points[2];
  const vecA = subtract(legA, vertex);
  const vecB = subtract(legB, vertex);
  if (magnitude(vecA) < 0.0001 || magnitude(vecB) < 0.0001) return null;

  const startAngle = Math.atan2(vecA.y, vecA.x);
  const endAngleRaw = Math.atan2(vecB.y, vecB.x);
  const delta = toShortAngleDelta(startAngle, endAngleRaw);
  const endAngle = startAngle + delta;
  const radius = Math.max(150, Math.abs(dimension.offset ?? settings.defaultOffset * 0.6));
  const arcStart = add(vertex, toPoint(startAngle, radius));
  const arcEnd = add(vertex, toPoint(endAngle, radius));
  const midAngle = startAngle + delta / 2;
  const textDefault = add(vertex, toPoint(midAngle, radius + 120));
  const valueDeg = Math.abs((delta * 180) / Math.PI);
  const isCommonAngle = near(valueDeg, 90, 0.75) || near(valueDeg, 45, 0.75) || near(valueDeg, 30, 0.75);
  const textPosition = dimension.textPositionLocked
    ? { ...dimension.textPosition }
    : dimension.textPosition ?? textDefault;
  const label = dimension.isDesignValue
    ? (
      dimension.text && dimension.text.trim().length > 0
        ? dimension.text
        : `${(Number.isFinite(dimension.value) ? Math.max(0, dimension.value) : valueDeg).toFixed(settings.precision)}deg`
    )
    : `${valueDeg.toFixed(settings.precision)}deg`;

  return {
    kind: 'angular',
    vertex,
    legA,
    legB,
    arcStart,
    arcEnd,
    radius,
    startAngle,
    endAngle,
    deltaAngle: delta,
    textPosition,
    valueDeg,
    label,
    isCommonAngle,
  };
}

function buildAreaGeometry(
  dimension: Dimension2D,
  roomsById: Map<string, Room>,
  settings: DimensionSettings
): ResolvedAreaDimensionGeometry | null {
  const linkedRoom = dimension.linkedRoomId ? roomsById.get(dimension.linkedRoomId) : null;
  const valueMm2 = linkedRoom ? linkedRoom.area : Math.max(0, dimension.value);
  const perimeterMm = linkedRoom ? linkedRoom.perimeter : 0;
  const textPosition = dimension.textPositionLocked
    ? { ...dimension.textPosition }
    : linkedRoom
      ? { ...linkedRoom.centroid }
      : { ...dimension.textPosition };

  const areaLabel = formatDimensionArea(valueMm2, settings);
  const withPerimeter = (dimension.showPerimeter ?? settings.showAreaPerimeter)
    ? `${areaLabel} | P: ${formatDimensionPerimeter(perimeterMm, settings)}`
    : areaLabel;
  const label = dimension.isDesignValue && dimension.text ? dimension.text : withPerimeter;

  return {
    kind: 'area',
    textPosition,
    valueMm2,
    perimeterMm,
    label,
  };
}

export function resolveDimensionGeometry(
  dimension: Dimension2D,
  walls: Wall[],
  rooms: Room[],
  settings: DimensionSettings
): ResolvedDimensionGeometry | null {
  if (dimension.type === 'area') {
    const roomsById = new Map(rooms.map((room) => [room.id, room]));
    return buildAreaGeometry(dimension, roomsById, settings);
  }

  const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
  const points = resolveDimensionPoints(dimension, wallsById);

  if (dimension.type === 'angular') {
    return buildAngularGeometry(dimension, points, settings);
  }

  if (dimension.type === 'linear' || dimension.type === 'aligned') {
    return buildLinearGeometry(dimension, points, settings, wallsById);
  }

  return null;
}

