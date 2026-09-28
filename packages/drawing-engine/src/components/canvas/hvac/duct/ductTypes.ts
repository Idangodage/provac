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

import { DUCT_VANES, type DuctVaneType } from './ductFittingRules';
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
  /** Round leg: its diameter (width = height = diameter for plan geometry and levels). */
  diameterMm?: number;
}

/**
 * Take-offs: rectangular (shoe, straight) and round collars (spin-in, conical)
 * off a rectangular wall (SMACNA Fig. 2-6); round branches off a round main:
 * a 90° tap, a conical tap (Fig. 3-4 / 3-5) or a 45° lateral (Fig. 3-4).
 */
export type DuctTapStyle = 'shoe-45' | 'straight' | 'spin-in' | 'conical' | 'round-tee' | 'round-conical' | 'round-lateral';

export const ROUND_MAIN_TAP_STYLES = ['round-conical', 'round-tee', 'round-lateral'] as const;
export type DuctRoundMainTapStyle = (typeof ROUND_MAIN_TAP_STYLES)[number];

export function isRoundLeg(leg: DuctLeg | undefined): boolean {
  return leg?.diameterMm !== undefined;
}

/** The style takes a round branch. */
export function isRoundTapStyle(style: DuctTapStyle): boolean {
  return style === 'spin-in' || style === 'conical' || isRoundMainTapStyle(style);
}

/** The style belongs on a round main. */
export function isRoundMainTapStyle(style: DuctTapStyle): style is DuctRoundMainTapStyle {
  return style === 'round-tee' || style === 'round-conical' || style === 'round-lateral';
}

const TAP_STYLES: readonly DuctTapStyle[] = ['shoe-45', 'straight', 'spin-in', 'conical', 'round-tee', 'round-conical', 'round-lateral'];

/** A round section of diameter `d`. */
export function roundLeg(diameterMm: number): DuctLeg {
  return { widthMm: diameterMm, heightMm: diameterMm, diameterMm };
}
/** Rectangular runs split by a Y or a bullhead tee (Fig. 2-5); a round main by a wye (Fig. 3-5). */
export type DuctSplitStyle = 'bullhead' | 'y' | 'wye';
export type DuctSide = 1 | -1;

/** A branch taken off the side of a parent run's straight leg. */
export interface DuctTapStart {
  kind: 'tap';
  parentRunId: string;
  legIndex: number;
  /** Branch centre along the parent leg, from the leg start (mm). */
  stationMm: number;
  /** Parent side the branch leaves from: +1 = left normal of the leg direction. */
  side: DuctSide;
  style: DuctTapStyle;
  vcd: boolean;
}

/** A branch leaving one outlet of a split at the end of a parent run. */
export interface DuctSplitBranchStart {
  kind: 'split-branch';
  parentRunId: string;
  side: DuctSide;
  vcd: boolean;
}

/** Plenum faces a spigot can leave from (left = the +normal side of the run direction). */
export type DuctSpigotFace = 'left' | 'right' | 'end';

/**
 * A round branch leaving a spigot (spin-in or conical collar) on the plenum at
 * the end of a parent run. Side faces place it `alongMm` from the plenum's back
 * face; the end face places it `acrossMm` from the centre (+ toward the left).
 * It sits half way up the plenum.
 */
export interface DuctSpigotStart {
  kind: 'spigot';
  parentRunId: string;
  face: DuctSpigotFace;
  alongMm: number;
  acrossMm: number;
  style: Extract<DuctTapStyle, 'spin-in' | 'conical'>;
  vcd: boolean;
}

/** A plenum box ending the run: its path end is the centre of the box's far face. */
export interface DuctPlenumEnd {
  kind: 'plenum';
  widthMm: number;
  heightMm: number;
  lengthMm: number;
}

/** The run ends on an air terminal's spigot; with `flex`, its last leg is a flexible runout. */
export interface DuctTerminalEnd {
  kind: 'terminal';
  terminalId: string;
  portId: string;
  flex: boolean;
}

export type DuctEnd =
  | { kind: 'unit-port'; unitId: string; portId: string; connector: boolean }
  | DuctTapStart
  | DuctSplitBranchStart
  | DuctSpigotStart
  | { kind: 'split'; style: DuctSplitStyle }
  | DuctPlenumEnd
  | DuctTerminalEnd
  | { kind: 'end-cap' }
  | { kind: 'open'; orphaned?: boolean };

export interface DuctNodeOverride {
  elbowStyle?: 'radius' | 'square-vaned';
  centrelineRatio?: number;
  vaneType?: DuctVaneType;
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
  /** Sheet thickness chosen for the run (must be stocked and ≥ the SMACNA minimum); null = automatic. */
  gaugeOverrideMm?: number | null;
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
  const side: DuctSide = candidate.side === -1 ? -1 : 1;
  if (candidate.kind === 'tap' && typeof candidate.parentRunId === 'string' && finite(candidate.stationMm)) {
    return {
      kind: 'tap', parentRunId: candidate.parentRunId,
      legIndex: finite(candidate.legIndex) ? Math.max(0, Math.round(candidate.legIndex)) : 0,
      stationMm: candidate.stationMm, side,
      style: TAP_STYLES.includes(candidate.style as DuctTapStyle) ? candidate.style as DuctTapStyle : 'shoe-45',
      vcd: candidate.vcd !== false,
    };
  }
  if (candidate.kind === 'split-branch' && typeof candidate.parentRunId === 'string') {
    return { kind: 'split-branch', parentRunId: candidate.parentRunId, side, vcd: candidate.vcd !== false };
  }
  if (candidate.kind === 'spigot' && typeof candidate.parentRunId === 'string') {
    return {
      kind: 'spigot', parentRunId: candidate.parentRunId,
      face: candidate.face === 'right' || candidate.face === 'end' ? candidate.face : 'left',
      alongMm: readNumber(candidate.alongMm, 0), acrossMm: readNumber(candidate.acrossMm, 0),
      style: candidate.style === 'conical' ? 'conical' : 'spin-in', vcd: candidate.vcd !== false,
    };
  }
  if (candidate.kind === 'split') return { kind: 'split', style: candidate.style === 'bullhead' || candidate.style === 'wye' ? candidate.style : 'y' };
  if (candidate.kind === 'plenum') {
    return {
      kind: 'plenum',
      widthMm: Math.max(100, readNumber(candidate.widthMm, 800)),
      heightMm: Math.max(100, readNumber(candidate.heightMm, 350)),
      lengthMm: Math.max(100, readNumber(candidate.lengthMm, 500)),
    };
  }
  if (candidate.kind === 'terminal' && typeof candidate.terminalId === 'string') {
    return { kind: 'terminal', terminalId: candidate.terminalId, portId: typeof candidate.portId === 'string' ? candidate.portId : 'spigot', flex: candidate.flex !== false };
  }
  if (candidate.kind === 'end-cap') return { kind: 'end-cap' };
  return candidate.orphaned === true ? { kind: 'open', orphaned: true } : { kind: 'open' };
}

/** The parent run a branch hangs from, if any. */
export function ductParentRunId(spec: Pick<DuctRunSpec, 'start'>): string | null {
  return spec.start.kind === 'tap' || spec.start.kind === 'split-branch' || spec.start.kind === 'spigot' ? spec.start.parentRunId : null;
}

function readLeg(value: unknown, fallback: DuctLeg): DuctLeg {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as { widthMm?: unknown; heightMm?: unknown; diameterMm?: unknown };
  if (finite(candidate.diameterMm) && candidate.diameterMm > 0) return roundLeg(Math.max(50, candidate.diameterMm));
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
      if (typeof candidate.vaneType === 'string' && candidate.vaneType in DUCT_VANES) override.vaneType = candidate.vaneType as DuctVaneType;
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
    ...(finite(record.gaugeOverrideMm) && record.gaugeOverrideMm > 0 ? { gaugeOverrideMm: record.gaugeOverrideMm } : {}),
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
