/**
 * The one builder behind the duct tool's live preview, its commit and the
 * scripted debug handle: a run from a unit collar, a take-off on another run,
 * or one outlet of a split, through the clicked points. Because preview and
 * commit share it, what is drawn is what is stored.
 *
 * A clicked point may carry a level (clear bottom): where it differs from the
 * level before it, a riser or drop is inserted at the previous point, then the
 * leg runs level.
 */
import type { HvacElement, Point2D } from '../../../../types';

import type { DuctAirPort } from './ductAirPorts';
import { add, dot, scale, unit } from './ductGeometry';
import {
  buildDuctRunElement,
  readDuctRunSpec,
  roundLeg,
  type DuctConstruction,
  type DuctPoint3,
  type DuctEnd,
  type DuctLeg,
  type DuctPlenumEnd,
  type DuctRunSpec,
  type DuctService,
  type DuctSide,
  type DuctSpigotFace,
  type DuctSplitStyle,
  type DuctTapStyle,
  type DuctTerminalEnd,
} from './ductTypes';

export type DuctAngleMode = '90' | '45';

/** Where a new run starts. */
export type DuctDraftOrigin =
  | { kind: 'port'; port: DuctAirPort }
  | {
    kind: 'tap'; parentRunId: string; legIndex: number; stationMm: number; side: DuctSide; style: DuctTapStyle; vcd: boolean;
    point: Point2D; direction: Point2D; bottomZ: number; service: DuctService; parentHeightMm: number;
  }
  | {
    kind: 'split'; parentRunId: string; side: DuctSide; style: DuctSplitStyle; vcd: boolean;
    point: Point2D; direction: Point2D; bottomZ: number; service: DuctService; parentHeightMm: number;
  }
  /** A round branch off a spigot on the parent's plenum. */
  | {
    kind: 'spigot'; parentRunId: string; face: DuctSpigotFace; alongMm: number; acrossMm: number; style: Extract<DuctTapStyle, 'spin-in' | 'conical'>; vcd: boolean;
    point: Point2D; direction: Point2D; bottomZ: number; service: DuctService;
  }
  /** A run started in free space (open start); its first leg may go any way. */
  | { kind: 'free'; point: Point2D; bottomZ: number; service: DuctService };

/** A clicked leg end; `z` (clear bottom) when the leg runs at another level than the one before it. */
export type DuctDraftPoint = Point2D & { z?: number };

export interface DuctDraftInput {
  /** Start of the run; `port` alone is accepted for a run from a unit collar. */
  origin?: DuctDraftOrigin;
  port?: DuctAirPort;
  /** Leg end points after the start point, in order. */
  points: DuctDraftPoint[];
  /** Clear section per leg; otherwise every leg takes `widthMm × heightMm` (or the collar). */
  legSizes?: DuctLeg[];
  /** An insulated run's thickness (mm); 0 or absent takes the project default by service. */
  insulationThicknessMm?: number;
  widthMm?: number;
  heightMm?: number;
  construction?: DuctConstruction;
  end?: DuctDraftEnd;
}

/** How a drafted run ends: an end cap, open, a plenum box, or on an air terminal's spigot. */
export type DuctDraftEnd = 'end-cap' | 'open' | DuctPlenumEnd | DuctTerminalEnd;

function draftEnd(end: DuctDraftEnd | undefined): DuctEnd {
  if (end === 'open') return { kind: 'open' };
  if (end && typeof end === 'object') return { ...end };
  return { kind: 'end-cap' };
}

export function resolveDraftOrigin(input: Pick<DuctDraftInput, 'origin' | 'port'>): DuctDraftOrigin {
  if (input.origin) return input.origin;
  if (input.port) return { kind: 'port', port: input.port };
  throw new Error('A duct draft needs an origin');
}

export function originPoint(origin: DuctDraftOrigin): Point2D {
  return origin.kind === 'port' ? { x: origin.port.lip.x, y: origin.port.lip.y } : origin.point;
}

/** The direction a run must leave its start in; null for a free start. */
export function originDirection(origin: DuctDraftOrigin): Point2D | null {
  if (origin.kind === 'free') return null;
  return origin.kind === 'port' ? origin.port.normal : origin.direction;
}

/**
 * The path after `start` through the clicked points, one section per click. A
 * click at another level first rises (or drops) at the previous point, keeping
 * the section arriving there; a click on the previous point itself is a
 * vertical leg of its own section.
 */
export function levelledPath(
  start: DuctPoint3,
  points: readonly DuctDraftPoint[],
  sectionFor: (clickIndex: number) => DuctLeg,
  arriving?: DuctLeg,
): { path: DuctPoint3[]; legs: DuctLeg[] } {
  const path: DuctPoint3[] = [];
  const legs: DuctLeg[] = [];
  let previous = start;
  points.forEach((point, index) => {
    const section = sectionFor(index);
    const z = point.z ?? previous.z;
    const rises = Math.abs(z - previous.z) > 0.5;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.5) {
      if (!rises) return;
      previous = { x: previous.x, y: previous.y, z };
      path.push(previous);
      legs.push({ ...section });
      return;
    }
    if (rises) {
      previous = { x: previous.x, y: previous.y, z };
      path.push(previous);
      legs.push({ ...(legs[legs.length - 1] ?? arriving ?? section) });
    }
    previous = { x: point.x, y: point.y, z };
    path.push(previous);
    legs.push({ ...section });
  });
  return { path, legs };
}

/** Whether the run ends in a flexible runout to a terminal. */
function endsInRunout(end: DuctDraftEnd | undefined): boolean {
  return typeof end === 'object' && end.kind === 'terminal' && end.flex;
}

/**
 * The levelled path through the clicked points; a runout's last point (the
 * terminal spigot) is kept exactly as given, since the flex changes level itself.
 */
function withRunout(
  start: DuctPoint3,
  points: readonly DuctDraftPoint[],
  sectionFor: (clickIndex: number) => DuctLeg,
  end: DuctDraftEnd | undefined,
  arriving?: DuctLeg,
): { path: DuctPoint3[]; legs: DuctLeg[] } {
  if (!endsInRunout(end) || points.length === 0) return levelledPath(start, points, sectionFor, arriving);
  const levelled = levelledPath(start, points.slice(0, -1), sectionFor, arriving);
  const last = points[points.length - 1]!;
  const previous = levelled.path[levelled.path.length - 1] ?? start;
  return {
    path: [...levelled.path, { x: last.x, y: last.y, z: last.z ?? previous.z }],
    legs: [...levelled.legs, { ...sectionFor(points.length - 1) }],
  };
}

/** Path z is the clear bottom: level with the collar bottom, or with the parent's bottom for a branch. */
export function buildDuctRunSpecFromOrigin(input: DuctDraftInput): DuctRunSpec {
  const origin = resolveDraftOrigin(input);
  const fallback: DuctLeg = origin.kind === 'port'
    ? { widthMm: input.widthMm ?? origin.port.widthMm, heightMm: input.heightMm ?? origin.port.heightMm }
    : origin.kind === 'free'
      ? { widthMm: input.widthMm ?? 300, heightMm: input.heightMm ?? 200 }
      : origin.kind === 'spigot'
        ? roundLeg(input.widthMm ?? 200)
        : { widthMm: input.widthMm ?? 300, heightMm: Math.min(input.heightMm ?? 200, origin.parentHeightMm) };
  const z = origin.kind === 'port' ? origin.port.lip.z - origin.port.heightMm / 2 : origin.bottomZ;
  const start = originPoint(origin);
  const first = { x: start.x, y: start.y, z };
  const sectionFor = (index: number) => input.legSizes?.[index] ?? input.legSizes?.[input.legSizes.length - 1] ?? fallback;
  const { path: rest, legs } = withRunout(first, input.points, sectionFor, input.end);
  const path = [first, ...rest];
  let startEnd: DuctEnd;
  let service: DuctService;
  if (origin.kind === 'port') {
    startEnd = { kind: 'unit-port', unitId: origin.port.unitId, portId: origin.port.portId, connector: true };
    service = origin.port.kind;
  } else if (origin.kind === 'tap') {
    startEnd = { kind: 'tap', parentRunId: origin.parentRunId, legIndex: origin.legIndex, stationMm: origin.stationMm, side: origin.side, style: origin.style, vcd: origin.vcd };
    service = origin.service;
  } else if (origin.kind === 'free') {
    startEnd = { kind: 'open' };
    service = origin.service;
  } else if (origin.kind === 'spigot') {
    startEnd = { kind: 'spigot', parentRunId: origin.parentRunId, face: origin.face, alongMm: origin.alongMm, acrossMm: origin.acrossMm, style: origin.style, vcd: origin.vcd };
    service = origin.service;
  } else {
    startEnd = { kind: 'split-branch', parentRunId: origin.parentRunId, side: origin.side, vcd: origin.vcd };
    service = origin.service;
  }
  return {
    version: 1,
    service,
    construction: input.construction ?? 'gi-bare',
    path,
    legs,
    insulationThicknessMm: input.construction === 'gi-nbr' ? Math.max(0, input.insulationThicknessMm ?? 0) : 0,
    pressureClassPa: null,
    jointSystem: null,
    start: startEnd,
    end: draftEnd(input.end),
    nodeOverrides: {},
    locked: false,
  };
}

/** Kept for phase-1 callers: a run from a unit collar. */
export function buildDuctRunSpecFromPort(input: DuctDraftInput): DuctRunSpec {
  return buildDuctRunSpecFromOrigin(input);
}

export function buildDuctRunDraftElement(input: DuctDraftInput, id: string): HvacElement {
  const element = buildDuctRunElement(buildDuctRunSpecFromOrigin(input), { id });
  return { ...element, id, rotation: 0, supplyZoneRatio: 0, category: element.category ?? 'accessory', properties: element.properties ?? {} };
}

/** An existing run extended from its open end by `points` (one section per click; a level change adds a riser). */
export function continueDuctRunSpec(spec: DuctRunSpec, points: DuctDraftPoint[], legSizes: DuctLeg[], end: DuctDraftEnd): DuctRunSpec {
  const last = spec.legs[spec.legs.length - 1]!;
  const levelled = withRunout(spec.path[spec.path.length - 1]!, points,
    (index) => legSizes[index] ?? legSizes[legSizes.length - 1] ?? last, end, last);
  return {
    ...spec,
    path: [...spec.path, ...levelled.path],
    legs: [...spec.legs, ...levelled.legs],
    end: draftEnd(end),
  };
}

/** The same run drawn the other way round: its end becomes an open start. */
export function reverseDuctRunSpec(spec: DuctRunSpec, end: 'end-cap' | 'open'): DuctRunSpec {
  return {
    ...spec,
    path: [...spec.path].reverse(),
    legs: [...spec.legs].reverse(),
    start: { kind: 'open' },
    end: end === 'open' ? { kind: 'open' } : { kind: 'end-cap' },
    nodeOverrides: Object.fromEntries(Object.entries(spec.nodeOverrides).map(([node, override]) => [String(spec.path.length - 1 - Number(node)), override])),
  };
}

/** A drafted run plus the existing runs it changes, exactly as they will be stored. */
export interface DuctRunDraft {
  element: HvacElement;
  /** A parent whose end becomes the split this branch leaves from. */
  changed: HvacElement[];
}

export function buildDuctRunDraft(input: DuctDraftInput, id: string, scene: readonly HvacElement[]): DuctRunDraft {
  const element = buildDuctRunDraftElement(input, id);
  const origin = resolveDraftOrigin(input);
  const changed: HvacElement[] = [];
  if (origin.kind === 'split') {
    const parent = scene.find((candidate) => candidate.id === origin.parentRunId);
    const spec = parent ? readDuctRunSpec(parent) : null;
    if (parent && spec && !(spec.end.kind === 'split' && spec.end.style === origin.style)) {
      changed.push({ ...parent, properties: buildDuctRunElement({ ...spec, end: { kind: 'split', style: origin.style } }).properties ?? parent.properties });
    }
  }
  return { element, changed };
}

/** The draft as one document command (one undo), shaped like `HvacElementCommand`. */
export function ductRunDraftCommand(draft: DuctRunDraft): {
  add: HvacElement[];
  updates: Array<{ id: string; updates: Partial<HvacElement> }>;
  selectedIds: string[];
} {
  return {
    add: [draft.element],
    updates: draft.changed.map((element) => ({ id: element.id, updates: { properties: element.properties } })),
    selectedIds: [draft.element.id],
  };
}

function rotate(direction: Point2D, degrees: number): Point2D {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: direction.x * Math.cos(radians) - direction.y * Math.sin(radians),
    y: direction.x * Math.sin(radians) + direction.y * Math.cos(radians),
  };
}

export interface ConstrainedLeg {
  point: Point2D;
  direction: Point2D;
  lengthMm: number;
}

/**
 * Snap the next leg end to the allowed directions from the anchor.
 *  - first leg: along the start's outward direction only;
 *  - later legs: straight on or a 90° turn (plus ±45° in 45° mode), never back.
 * Lengths round to `stepMm`.
 */
export function constrainDuctLeg(
  anchor: Point2D,
  cursor: Point2D,
  previousDirection: Point2D,
  options: { first: boolean; mode: DuctAngleMode; stepMm?: number; free?: boolean },
): ConstrainedLeg {
  const step = options.stepMm ?? 10;
  const base = unit(previousDirection);
  const candidates = options.free
    // A free start: any grid direction (plus the diagonals in 45° mode).
    ? [0, 90, 180, 270, ...(options.mode === '45' ? [45, 135, 225, 315] : [])].map((angle) => rotate({ x: 1, y: 0 }, angle))
    : options.first
      ? [base]
      : [0, 90, -90, ...(options.mode === '45' ? [45, -45] : [])].map((angle) => rotate(base, angle));
  const offset = { x: cursor.x - anchor.x, y: cursor.y - anchor.y };
  let best = candidates[0]!;
  let bestProjection = -Infinity;
  for (const candidate of candidates) {
    const projection = dot(offset, candidate);
    if (projection > bestProjection) {
      bestProjection = projection;
      best = candidate;
    }
  }
  const lengthMm = Math.max(0, Math.round(Math.max(0, bestProjection) / step) * step);
  const direction = { x: Math.round(best.x * 1e9) / 1e9, y: Math.round(best.y * 1e9) / 1e9 };
  return { point: add(anchor, scale(direction, lengthMm)), direction, lengthMm };
}
