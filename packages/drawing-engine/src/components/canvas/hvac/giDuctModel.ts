import type { HvacElement, Point2D } from "../../../types";

export type GiDuctKind = "return" | "supply";

export interface GiDuctStartConnection {
  point: Point2D;
  direction: Point2D;
  sourceElementId?: string;
  sourceOpeningKind?: GiDuctKind;
}

export interface GiDuctSpec {
  routePoints: Point2D[];
  ductKind: GiDuctKind;
  outerWidthMm: number;
  outerHeightMm: number;
  wallThicknessMm: number;
  startConnection: GiDuctStartConnection | null;
}

export interface GiDuctSegmentVisual {
  start: Point2D;
  end: Point2D;
  center: Point2D;
  localStart: Point2D;
  localEnd: Point2D;
  localCenter: Point2D;
  lengthMm: number;
  angleDeg: number;
  seamOffsetsMm: number[];
}

export interface GiDuctVisualSpec extends GiDuctSpec {
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    center: Point2D;
  };
  innerWidthMm: number;
  innerHeightMm: number;
  localRoutePoints: Point2D[];
  segments: GiDuctSegmentVisual[];
}

export const DEFAULT_GI_DUCT_WALL_THICKNESS_MM = 1;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readNumber(value: unknown, fallback: number): number {
  if (isFiniteNumber(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeDirection(point: Point2D): Point2D {
  const length = Math.hypot(point.x, point.y);
  if (length < 0.0001) {
    return { x: 0, y: 1 };
  }
  return { x: point.x / length, y: point.y / length };
}

function normalizePoint(value: unknown): Point2D | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { x?: unknown; y?: unknown };
  const x = readNumber(candidate.x, Number.NaN);
  const y = readNumber(candidate.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

function normalizePointArray(value: unknown): Point2D[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const points = value
    .map((entry) => normalizePoint(entry))
    .filter((entry): entry is Point2D => Boolean(entry));
  return dedupeConsecutivePoints(points);
}

function normalizeStartConnection(value: unknown): GiDuctStartConnection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    point?: unknown;
    direction?: unknown;
    sourceElementId?: unknown;
    sourceOpeningKind?: unknown;
  };
  const point = normalizePoint(candidate.point);
  const direction = normalizePoint(candidate.direction);
  if (!point || !direction) {
    return null;
  }
  return {
    point,
    direction: normalizeDirection(direction),
    sourceElementId:
      typeof candidate.sourceElementId === "string"
        ? candidate.sourceElementId
        : undefined,
    sourceOpeningKind:
      candidate.sourceOpeningKind === "return" ? "return" : "supply",
  };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dedupeConsecutivePoints(points: Point2D[]): Point2D[] {
  const deduped: Point2D[] = [];
  points.forEach((point) => {
    const previous = deduped[deduped.length - 1];
    if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.01) {
      deduped.push(point);
    }
  });
  return deduped;
}

function computeBounds(points: Point2D[], paddingMm: number) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - paddingMm;
  const maxX = Math.max(...xs) + paddingMm;
  const minY = Math.min(...ys) - paddingMm;
  const maxY = Math.max(...ys) + paddingMm;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
    },
  };
}

function buildFallbackRoutePoints(element: Pick<HvacElement, "position" | "width" | "depth">): Point2D[] {
  const centerY = element.position.y + element.depth / 2;
  return [
    { x: element.position.x, y: centerY },
    { x: element.position.x + element.width, y: centerY },
  ];
}

function computeSeamOffsets(lengthMm: number): number[] {
  const seamCount = clampValue(Math.floor(lengthMm / 240), 0, 4);
  return Array.from({ length: seamCount }, (_, index) => {
    return (lengthMm * (index + 1)) / (seamCount + 1);
  });
}

export function isGiDuctElementType(type: string): boolean {
  return type === "duct";
}

export function resolveGiDuctSpec(properties: Record<string, unknown>): GiDuctSpec {
  const routePoints = normalizePointArray(properties.routePoints);
  const outerWidthMm = Math.max(
    40,
    readNumber(
      properties.outerWidthMm,
      readNumber(properties.ductWidthMm, 220),
    ),
  );
  const outerHeightMm = Math.max(
    40,
    readNumber(
      properties.outerHeightMm,
      readNumber(properties.ductHeightMm, 140),
    ),
  );
  const wallThicknessMm = clampValue(
    readNumber(properties.wallThicknessMm, DEFAULT_GI_DUCT_WALL_THICKNESS_MM),
    0.8,
    2,
  );
  return {
    routePoints,
    ductKind: properties.ductKind === "return" ? "return" : "supply",
    outerWidthMm,
    outerHeightMm,
    wallThicknessMm,
    startConnection: normalizeStartConnection(properties.startConnection),
  };
}

export function buildGiDuctVisual(
  element: Pick<HvacElement, "position" | "width" | "depth" | "properties">,
): GiDuctVisualSpec {
  const spec = resolveGiDuctSpec(element.properties);
  const routePoints =
    spec.routePoints.length >= 2
      ? spec.routePoints
      : buildFallbackRoutePoints(element);
  const paddingMm = spec.outerWidthMm / 2 + 2;
  const bounds = computeBounds(routePoints, paddingMm);
  const segments = routePoints
    .slice(0, -1)
    .map((start, index): GiDuctSegmentVisual | null => {
      const end = routePoints[index + 1];
      if (!end) {
        return null;
      }
      const lengthMm = Math.hypot(end.x - start.x, end.y - start.y);
      if (lengthMm <= 0.01) {
        return null;
      }
      const center = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
      };
      return {
        start,
        end,
        center,
        localStart: subtract(start, bounds.center),
        localEnd: subtract(end, bounds.center),
        localCenter: subtract(center, bounds.center),
        lengthMm,
        angleDeg: (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI,
        seamOffsetsMm: computeSeamOffsets(lengthMm),
      };
    })
    .filter((segment): segment is GiDuctSegmentVisual => Boolean(segment));

  return {
    ...spec,
    routePoints,
    bounds,
    innerWidthMm: Math.max(20, spec.outerWidthMm - spec.wallThicknessMm * 2),
    innerHeightMm: Math.max(20, spec.outerHeightMm - spec.wallThicknessMm * 2),
    localRoutePoints: routePoints.map((point) => subtract(point, bounds.center)),
    segments,
  };
}

export function buildStraightGiDuctElement(
  routePoints: Point2D[],
  options: {
    ductKind: GiDuctKind;
    outerWidthMm: number;
    outerHeightMm: number;
    wallThicknessMm?: number;
    elevationMm: number;
    label?: string;
    startConnection?: GiDuctStartConnection | null;
  },
): Omit<Partial<HvacElement>, "id"> &
  Pick<
    HvacElement,
    "type" | "position" | "width" | "depth" | "height" | "elevation" | "mountType" | "label"
  > {
  const properties = {
    routePoints: dedupeConsecutivePoints(routePoints),
    ductKind: options.ductKind,
    outerWidthMm: options.outerWidthMm,
    outerHeightMm: options.outerHeightMm,
    wallThicknessMm:
      options.wallThicknessMm ?? DEFAULT_GI_DUCT_WALL_THICKNESS_MM,
    startConnection: options.startConnection ?? null,
    sourceElementId: options.startConnection?.sourceElementId,
    sourceOpeningKind: options.startConnection?.sourceOpeningKind,
  };
  const visual = buildGiDuctVisual({
    position: { x: 0, y: 0 },
    width: 1,
    depth: 1,
    properties,
  });
  return {
    type: "duct",
    category: "accessory",
    subtype: options.ductKind === "supply" ? "gi-supply-duct" : "gi-return-duct",
    modelLabel: "GI Duct",
    position: {
      x: visual.bounds.minX,
      y: visual.bounds.minY,
    },
    rotation: 0,
    width: visual.bounds.width,
    depth: visual.bounds.height,
    height: options.outerHeightMm,
    elevation: options.elevationMm,
    mountType: "ceiling",
    label:
      options.label ??
      (options.ductKind === "supply" ? "Supply Duct" : "Return Duct"),
    supplyZoneRatio: 0,
    properties,
  };
}
