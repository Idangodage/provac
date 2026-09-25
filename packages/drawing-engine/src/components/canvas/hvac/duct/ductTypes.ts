/**
 * Persisted duct run: the design intent only. Everything fabricated (sections,
 * elbows, joints, hardware, BOM) is derived by the planner from this record and
 * the project duct settings, so an edit re-derives it consistently.
 *
 * One `duct` element holds one run under `properties.ductRun`. Its ends are
 * deliberately NOT named `startConnection` / `endConnection`: refrigerant
 * readers and scene scanners look for those names and must never treat a duct
 * as one of their connections.
 *
 * The old straight GI stubs (giDuctModel shape) are read as single-leg runs
 * without a migration step.
 */
import type { HvacElement, Point2D } from '../../../../types';

import type { DuctJointSystem } from './ductSettings';

export interface DuctPoint3 {
  x: number;
  y: number;
  z: number;
}

export type DuctService = 'supply' | 'return';
export type DuctConstruction = 'gi-bare' | 'gi-nbr' | 'pid';

/** Clear inside section of one leg (mm). */
export interface DuctLeg {
  widthMm: number;
  heightMm: number;
}

export type DuctEnd =
  | { kind: 'unit-port'; unitId: string; portId: string; connector: boolean }
  | { kind: 'end-cap' }
  | { kind: 'open' };

export interface DuctNodeOverride {
  elbowStyle?: 'radius' | 'square-vaned';
  centrelineRatio?: number;
}

export interface DuctRunSpec {
  version: 1;
  service: DuctService;
  construction: DuctConstruction;
  /** Plan XY of the centreline, z = level of the duct's CLEAR (inside) bottom (mm). */
  path: DuctPoint3[];
  /** One clear section per leg (path.length − 1). */
  legs: DuctLeg[];
  insulationThicknessMm: number;
  /** Static pressure class (Pa); null = the project setting for the service. */
  pressureClassPa: number | null;
  /** Joint system override; null = the project setting. */
  jointSystem: DuctJointSystem | null;
  start: DuctEnd;
  end: DuctEnd;
  /** Keyed by path node index. */
  nodeOverrides: Record<string, DuctNodeOverride>;
  locked: boolean;
  /** Read from the old straight-stub format (no connector, no end cap). */
  legacy?: boolean;
}

export const DUCT_RUN_SUBTYPE = 'duct-run';
/** Plan/3D allowance around the sheet for flanges when sizing the element envelope (mm). */
const ENVELOPE_FLANGE_MARGIN_MM = 45;

export function isDuctElement(element: Pick<HvacElement, 'type'>): boolean {
  return element.type === 'duct';
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readNumber(value: unknown, fallback: number): number {
  if (finite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function readPoint2(value: unknown): Point2D | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { x?: unknown; y?: unknown };
  const x = readNumber(candidate.x, Number.NaN);
  const y = readNumber(candidate.y, Number.NaN);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function readPoint3(value: unknown, fallbackZ: number): DuctPoint3 | null {
  const point = readPoint2(value);
  if (!point) return null;
  const z = readNumber((value as { z?: unknown }).z, fallbackZ);
  return { ...point, z };
}

function dedupe(points: DuctPoint3[]): DuctPoint3[] {
  const out: DuctPoint3[] = [];
  for (const point of points) {
    const previous = out[out.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) > 0.01) out.push(point);
  }
  return out;
}

function readEnd(value: unknown): DuctEnd {
  if (!value || typeof value !== 'object') return { kind: 'open' };
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'unit-port' && typeof candidate.unitId === 'string' && typeof candidate.portId === 'string') {
    return { kind: 'unit-port', unitId: candidate.unitId, portId: candidate.portId, connector: candidate.connector !== false };
  }
  if (candidate.kind === 'end-cap') return { kind: 'end-cap' };
  return { kind: 'open' };
}

function readLeg(value: unknown, fallback: DuctLeg): DuctLeg {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as { widthMm?: unknown; heightMm?: unknown };
  return {
    widthMm: Math.max(40, readNumber(candidate.widthMm, fallback.widthMm)),
    heightMm: Math.max(40, readNumber(candidate.heightMm, fallback.heightMm)),
  };
}

function readJointSystem(value: unknown): DuctJointSystem | null {
  return value === 'auto' || value === 'tdc' || value === 'ductmate' || value === 'angle-flange' ? value : null;
}

/** The old straight GI stub (giDuctModel): outer size, BOD elevation, one leg. */
function readLegacyStub(element: Pick<HvacElement, 'elevation' | 'position' | 'width' | 'depth' | 'properties'>): DuctRunSpec | null {
  const properties = element.properties;
  const raw = Array.isArray(properties.routePoints) ? properties.routePoints : [];
  const wall = Math.min(2, Math.max(0.8, readNumber(properties.wallThicknessMm, 1)));
  const outerWidth = Math.max(40, readNumber(properties.outerWidthMm, readNumber(properties.ductWidthMm, 220)));
  const outerHeight = Math.max(40, readNumber(properties.outerHeightMm, readNumber(properties.ductHeightMm, 140)));
  // The old tool stored the outside bottom of the sheet as the element elevation.
  const clearBottom = element.elevation + wall;
  let path = dedupe(raw.map((point) => readPoint3(point, clearBottom)).filter((point): point is DuctPoint3 => point !== null)
    .map((point) => ({ ...point, z: clearBottom })));
  if (path.length < 2) {
    const centreY = element.position.y + element.depth / 2;
    path = [
      { x: element.position.x, y: centreY, z: clearBottom },
      { x: element.position.x + element.width, y: centreY, z: clearBottom },
    ];
  }
  const leg = { widthMm: Math.max(20, outerWidth - 2 * wall), heightMm: Math.max(20, outerHeight - 2 * wall) };
  const start = properties.startConnection as { sourceElementId?: unknown; sourceOpeningKind?: unknown } | undefined;
  const service: DuctService = properties.ductKind === 'return' ? 'return' : 'supply';
  return {
    version: 1,
    service,
    construction: 'gi-bare',
    path,
    legs: path.slice(1).map(() => ({ ...leg })),
    insulationThicknessMm: 0,
    pressureClassPa: null,
    jointSystem: null,
    start: typeof start?.sourceElementId === 'string'
      ? { kind: 'unit-port', unitId: start.sourceElementId, portId: start.sourceOpeningKind === 'return' ? 'return' : 'supply', connector: false }
      : { kind: 'open' },
    end: { kind: 'open' },
    nodeOverrides: {},
    locked: false,
    legacy: true,
  };
}

/** Tolerant reader: a corrupt record never throws; null only for non-duct elements. */
export function readDuctRunSpec(
  element: Pick<HvacElement, 'type' | 'elevation' | 'position' | 'width' | 'depth' | 'properties'>,
): DuctRunSpec | null {
  if (!isDuctElement(element)) return null;
  const record = element.properties.ductRun as Record<string, unknown> | undefined;
  if (!record || typeof record !== 'object' || record.version !== 1) return readLegacyStub(element);
  const path = dedupe((Array.isArray(record.path) ? record.path : [])
    .map((point) => readPoint3(point, element.elevation))
    .filter((point): point is DuctPoint3 => point !== null));
  if (path.length < 2) return readLegacyStub(element);
  const rawLegs = Array.isArray(record.legs) ? record.legs : [];
  const firstLeg = readLeg(rawLegs[0], { widthMm: 300, heightMm: 200 });
  const legs = path.slice(1).map((_, index) => readLeg(rawLegs[index], index > 0 ? readLeg(rawLegs[index - 1], firstLeg) : firstLeg));
  const overrides: Record<string, DuctNodeOverride> = {};
  if (record.nodeOverrides && typeof record.nodeOverrides === 'object') {
    for (const [key, value] of Object.entries(record.nodeOverrides as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as Record<string, unknown>;
      const override: DuctNodeOverride = {};
      if (candidate.elbowStyle === 'radius' || candidate.elbowStyle === 'square-vaned') override.elbowStyle = candidate.elbowStyle;
      if (finite(candidate.centrelineRatio)) override.centrelineRatio = candidate.centrelineRatio;
      overrides[key] = override;
    }
  }
  return {
    version: 1,
    service: record.service === 'return' ? 'return' : 'supply',
    construction: record.construction === 'gi-nbr' || record.construction === 'pid' ? record.construction : 'gi-bare',
    path,
    legs,
    insulationThicknessMm: Math.max(0, readNumber(record.insulationThicknessMm, 0)),
    pressureClassPa: finite(record.pressureClassPa) ? record.pressureClassPa : null,
    jointSystem: readJointSystem(record.jointSystem),
    start: readEnd(record.start),
    end: readEnd(record.end),
    nodeOverrides: overrides,
    locked: record.locked === true,
  };
}

/** Flange projection beyond the sheet used for plan footprints (mm). */
const FOOTPRINT_FLANGE_MM = 30;

/**
 * Plan footprint of a run, one axis-aligned box per leg (each box reaches half a
 * width past its nodes, which covers the elbow at the corner). Null for the old
 * straight stubs, whose consumers keep using the element bounding box exactly
 * as before.
 */
export function ductRunLegFootprintsMm(
  element: Pick<HvacElement, 'type' | 'elevation' | 'position' | 'width' | 'depth' | 'properties'>,
): Array<{ minX: number; minY: number; maxX: number; maxY: number }> | null {
  const spec = readDuctRunSpec(element);
  if (!spec || spec.legacy) return null;
  return spec.legs.map((leg, index) => {
    const a = spec.path[index]!;
    const b = spec.path[index + 1]!;
    const half = leg.widthMm / 2 + FOOTPRINT_FLANGE_MM + spec.insulationThicknessMm;
    return {
      minX: Math.min(a.x, b.x) - half,
      minY: Math.min(a.y, b.y) - half,
      maxX: Math.max(a.x, b.x) + half,
      maxY: Math.max(a.y, b.y) + half,
    };
  });
}

export type DuctRunElementInput =Omit<Partial<HvacElement>, 'id'> & Pick<
  HvacElement,
  'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'
> & { id?: string };

/**
 * Element for a run. position/width/depth/elevation/height are the envelope
 * (sheet + flanges + insulation) so bounding-box consumers stay honest.
 */
export function buildDuctRunElement(spec: DuctRunSpec, options: { id?: string; label?: string } = {}): DuctRunElementInput {
  const maxHalf = Math.max(...spec.legs.map((leg) => Math.max(leg.widthMm, leg.heightMm))) / 2;
  const margin = maxHalf + ENVELOPE_FLANGE_MARGIN_MM + spec.insulationThicknessMm;
  const xs = spec.path.map((point) => point.x);
  const ys = spec.path.map((point) => point.y);
  const minZ = Math.min(...spec.path.map((point) => point.z));
  const maxTop = Math.max(...spec.path.map((point, index) => point.z + (spec.legs[Math.min(index, spec.legs.length - 1)]?.heightMm ?? 0)));
  const outside = ENVELOPE_FLANGE_MARGIN_MM + spec.insulationThicknessMm;
  const { legacy: _legacy, ...persisted } = spec;
  return {
    ...(options.id ? { id: options.id } : {}),
    type: 'duct',
    category: 'accessory',
    subtype: DUCT_RUN_SUBTYPE,
    modelLabel: 'Duct run',
    position: { x: Math.min(...xs) - margin, y: Math.min(...ys) - margin },
    rotation: 0,
    width: Math.max(1, Math.max(...xs) - Math.min(...xs) + 2 * margin),
    depth: Math.max(1, Math.max(...ys) - Math.min(...ys) + 2 * margin),
    height: Math.max(1, maxTop - minZ + 2 * outside),
    elevation: minZ - outside,
    mountType: 'ceiling',
    label: options.label ?? (spec.service === 'supply' ? 'Supply duct' : 'Return duct'),
    supplyZoneRatio: 0,
    properties: { ductRun: persisted, ductKind: spec.service },
  };
}
