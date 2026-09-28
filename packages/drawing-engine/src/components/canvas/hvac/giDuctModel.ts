import type { HvacElement, Point2D } from "../../../types";

/**
 * The old straight GI duct stub format, kept only so existing documents keep
 * loading: `readDuctRunSpec` (duct/ductTypes.ts) reads these properties as a
 * one-leg run, and every duct is drawn from its fabrication plan. New runs are
 * never written in this shape.
 */
export type GiDuctKind = "return" | "supply";

export interface GiDuctStartConnection {
  point: Point2D;
  direction: Point2D;
  sourceElementId?: string;
  sourceOpeningKind?: GiDuctKind;
}

export const DEFAULT_GI_DUCT_WALL_THICKNESS_MM = 1;

export function isGiDuctElementType(type: string): boolean {
  return type === "duct";
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

/** An element in the old stub format (tests and document fixtures). */
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
  const points = dedupeConsecutivePoints(routePoints);
  const properties = {
    routePoints: points,
    ductKind: options.ductKind,
    outerWidthMm: options.outerWidthMm,
    outerHeightMm: options.outerHeightMm,
    wallThicknessMm:
      options.wallThicknessMm ?? DEFAULT_GI_DUCT_WALL_THICKNESS_MM,
    startConnection: options.startConnection ?? null,
    sourceElementId: options.startConnection?.sourceElementId,
    sourceOpeningKind: options.startConnection?.sourceOpeningKind,
  };
  const padding = options.outerWidthMm / 2 + 2;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  return {
    type: "duct",
    category: "accessory",
    subtype: options.ductKind === "supply" ? "gi-supply-duct" : "gi-return-duct",
    modelLabel: "GI Duct",
    position: { x: minX, y: minY },
    rotation: 0,
    width: Math.max(1, Math.max(...xs) + padding - minX),
    depth: Math.max(1, Math.max(...ys) + padding - minY),
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
