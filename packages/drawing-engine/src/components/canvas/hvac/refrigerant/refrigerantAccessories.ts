/**
 * Inline refrigerant accessories on a line's straights: ball (service) valves,
 * strainers, sight glasses and flare unions.
 *
 * They are kept on the line itself (`properties.inlineAccessories`): the design
 * leg each sits on and its centre's distance from that leg's start, and the
 * centre as placed, so that an edit renaming the legs re-attaches each to the
 * straight nearest where it was. Bodies are practice sizes from the tube,
 * unverified until a catalogue is loaded. A body must fit on its straight,
 * clear of the fittings either side and of the other accessories; one that no
 * longer fits after an edit says so, where it is.
 *
 * PURE.
 */
import type { HvacElement } from '../../../../types';
import type { Vec3 } from '../pipePortFrame';

export type RefrigerantAccessoryKind = 'ball-valve' | 'strainer' | 'sight-glass' | 'flare-union';

export const REFRIGERANT_ACCESSORY_KINDS: readonly RefrigerantAccessoryKind[] = ['ball-valve', 'strainer', 'sight-glass', 'flare-union'];

export interface RefrigerantInlineAccessory {
  /** Unique on the line ("a1", "a2", …): the accessory's piece key is `acc:<id>`. */
  id: string;
  kind: RefrigerantAccessoryKind;
  /** The design leg it sits on. */
  legId: string;
  /** Its centre's distance from the leg's start (mm). */
  stationMm: number;
  /** Its centre as placed (model mm): where it re-attaches when its leg is renamed. */
  at: Vec3;
}

export const ACCESSORY_NAMES: Record<RefrigerantAccessoryKind, string> = {
  'ball-valve': 'Ball valve', strainer: 'Strainer', 'sight-glass': 'Sight glass', 'flare-union': 'Flare union',
};

/** What each does on the line (the card's words). */
export const ACCESSORY_ROLES: Record<RefrigerantAccessoryKind, string> = {
  'ball-valve': 'isolates the line for service',
  strainer: 'catches debris ahead of the expansion valve',
  'sight-glass': 'shows the liquid line full and dry',
  'flare-union': 'a joint that can be broken for service',
};

/** The lines a kind goes on: the strainer and the sight glass belong on the liquid line. */
export const ACCESSORY_LINES: Record<RefrigerantAccessoryKind, ReadonlyArray<'gas' | 'liquid'>> = {
  'ball-valve': ['gas', 'liquid'], strainer: ['liquid'], 'sight-glass': ['liquid'], 'flare-union': ['gas', 'liquid'],
};

/** Clear straight kept between a body and a fitting, and between two bodies (mm). */
export const ACCESSORY_CLEARANCE_MM = 30;

/** A body's length along the line and its outside diameter (mm): practice sizes from the tube, unverified. */
export function accessoryBody(kind: RefrigerantAccessoryKind, tubeOdMm: number): { lengthMm: number; diameterMm: number } {
  const od = Math.max(6, tubeOdMm);
  switch (kind) {
    case 'ball-valve': return { lengthMm: Math.round(2.6 * od + 50), diameterMm: Math.round(2 * od + 10) };
    case 'strainer': return { lengthMm: Math.round(3 * od + 90), diameterMm: Math.round(2.2 * od + 12) };
    case 'sight-glass': return { lengthMm: Math.round(2 * od + 60), diameterMm: Math.round(2.6 * od + 8) };
    default: return { lengthMm: Math.round(1.6 * od + 25), diameterMm: Math.round(1.6 * od + 6) };
  }
}

/** A body's drawn radius (plan symbol, 3D body): its own, or proud of the line's insulation where that is thicker, so it stays in sight (mm). */
export function accessoryDrawnRadiusMm(body: { diameterMm: number }, outsideDiameterMm: number): number {
  return Math.max(body.diameterMm / 2, outsideDiameterMm / 2 + 4);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const KINDS = new Set<string>(REFRIGERANT_ACCESSORY_KINDS);

/** Tolerant reader of a line's accessories (none when absent or unreadable). */
export function readRefrigerantAccessories(element: Pick<HvacElement, 'properties'>): RefrigerantInlineAccessory[] {
  const value = element.properties.inlineAccessories;
  if (!Array.isArray(value)) return [];
  const out: RefrigerantInlineAccessory[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const at = record.at as Record<string, unknown> | undefined;
    if (typeof record.id !== 'string' || typeof record.kind !== 'string' || !KINDS.has(record.kind) || typeof record.legId !== 'string'
      || !finite(record.stationMm) || !at || !finite(at.x) || !finite(at.y) || !finite(at.z)) continue;
    out.push({ id: record.id, kind: record.kind as RefrigerantAccessoryKind, legId: record.legId, stationMm: record.stationMm, at: { x: at.x, y: at.y, z: at.z } });
  }
  return out;
}

/** The next free id on a line ("a3" after "a1", "a2"). */
export function nextAccessoryId(accessories: readonly RefrigerantInlineAccessory[]): string {
  const highest = accessories.reduce((max, item) => Math.max(max, Number(/^a(\d+)$/.exec(item.id)?.[1] ?? 0)), 0);
  return `a${highest + 1}`;
}

/** A straight an accessory may sit on: its leg, where the leg starts and runs, and the stretch the fittings leave free. */
export interface AccessoryStraight {
  legId: string;
  legIndex: number;
  start: Vec3;
  direction: Vec3;
  /** The free stretch, as distances from the leg's start (mm). */
  freeFromMm: number;
  freeToMm: number;
}

export interface PlacedRefrigerantAccessory {
  accessory: RefrigerantInlineAccessory;
  legId: string;
  legIndex: number;
  /** Its centre's distance from its leg's start (re-attached when its leg is gone). */
  stationMm: number;
  centre: Vec3;
  direction: Vec3;
  lengthMm: number;
  diameterMm: number;
  /** Why it cannot be where it is (the wrong line, no room), or null. */
  problem: string | null;
}

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The stations a body of `lengthMm` may have its centre at on a straight (or null when it cannot fit). */
export function accessoryStationRange(straight: Pick<AccessoryStraight, 'freeFromMm' | 'freeToMm'>, lengthMm: number): { from: number; to: number } | null {
  const from = straight.freeFromMm + ACCESSORY_CLEARANCE_MM + lengthMm / 2;
  const to = straight.freeToMm - ACCESSORY_CLEARANCE_MM - lengthMm / 2;
  return to >= from ? { from, to } : null;
}

/** The straight nearest a point, and where along it the point falls. */
function nearestStraight(straights: readonly AccessoryStraight[], point: Vec3): { straight: AccessoryStraight; stationMm: number } | null {
  let best: { straight: AccessoryStraight; stationMm: number; gap: number } | null = null;
  for (const straight of straights) {
    const along = Math.max(straight.freeFromMm, Math.min(straight.freeToMm, dot(sub(point, straight.start), straight.direction)));
    const gap = distance(point, add(straight.start, scale(straight.direction, along)));
    if (!best || gap < best.gap) best = { straight, stationMm: along, gap };
  }
  return best ? { straight: best.straight, stationMm: best.stationMm } : null;
}

/** Where a line's accessories are: on their straights (or the nearest, when their leg is gone), each fitted or not. */
export function placeAccessories(straights: readonly AccessoryStraight[], accessories: readonly RefrigerantInlineAccessory[], tubeOdMm: number,
  lineKind: 'gas' | 'liquid' | 'pair'): PlacedRefrigerantAccessory[] {
  const placed: PlacedRefrigerantAccessory[] = [];
  for (const accessory of accessories) {
    // Its own leg while its centre is still on that leg's straight; else (its leg renamed, or split by a new corner)
    // the straight nearest where it was placed.
    const own = straights.find((candidate) => candidate.legId === accessory.legId);
    const onOwn = own && accessory.stationMm >= own.freeFromMm - 0.5 && accessory.stationMm <= own.freeToMm + 0.5;
    const found = own && onOwn ? { straight: own, stationMm: accessory.stationMm }
      : nearestStraight(straights, accessory.at) ?? (own ? { straight: own, stationMm: accessory.stationMm } : null);
    if (!found) continue;
    const { lengthMm, diameterMm } = accessoryBody(accessory.kind, tubeOdMm);
    const { straight, stationMm } = found;
    const range = accessoryStationRange(straight, lengthMm);
    let problem: string | null = null;
    if (lineKind !== 'pair' && !ACCESSORY_LINES[accessory.kind].includes(lineKind)) problem = `A ${ACCESSORY_NAMES[accessory.kind].toLowerCase()} belongs on the liquid line.`;
    else if (!range) problem = `The straight is too short for a ${lengthMm} mm ${ACCESSORY_NAMES[accessory.kind].toLowerCase()} clear of its fittings.`;
    else if (stationMm < range.from - 0.5 || stationMm > range.to + 0.5) problem = `It runs into a fitting: keep its centre ${Math.round(range.from)}–${Math.round(range.to)} mm from the start point.`;
    placed.push({
      accessory, legId: straight.legId, legIndex: straight.legIndex, stationMm, centre: add(straight.start, scale(straight.direction, stationMm)),
      direction: straight.direction, lengthMm, diameterMm, problem,
    });
  }
  // Two bodies on one straight keep their clearance.
  const byLeg = new Map<string, PlacedRefrigerantAccessory[]>();
  for (const item of placed) byLeg.set(item.legId, [...(byLeg.get(item.legId) ?? []), item]);
  for (const items of byLeg.values()) {
    items.sort((a, b) => a.stationMm - b.stationMm);
    for (let index = 1; index < items.length; index += 1) {
      const before = items[index - 1]!;
      const item = items[index]!;
      const gap = item.stationMm - item.lengthMm / 2 - (before.stationMm + before.lengthMm / 2);
      if (gap < ACCESSORY_CLEARANCE_MM - 0.5 && !item.problem) item.problem = `It runs into the ${ACCESSORY_NAMES[before.accessory.kind].toLowerCase()} beside it.`;
    }
  }
  return placed;
}

/**
 * Where a new body of `kind` goes on a straight: at `preferredMm` (the straight's middle when not given), or the
 * nearest station it fits at clear of the fittings and of the bodies already there; or why it cannot go there.
 */
export function freeStationFor(straight: AccessoryStraight, kind: RefrigerantAccessoryKind, tubeOdMm: number,
  others: readonly PlacedRefrigerantAccessory[], preferredMm?: number): { stationMm: number } | { problem: string } {
  const { lengthMm } = accessoryBody(kind, tubeOdMm);
  const range = accessoryStationRange(straight, lengthMm);
  if (!range) return { problem: `The straight is too short for a ${lengthMm} mm ${ACCESSORY_NAMES[kind].toLowerCase()} clear of its fittings.` };
  // The stretches the bodies already there leave open, each as a range of centres for the new one.
  const blocked = others.filter((other) => other.legId === straight.legId)
    .map((other) => ({ from: other.stationMm - other.lengthMm / 2 - ACCESSORY_CLEARANCE_MM - lengthMm / 2, to: other.stationMm + other.lengthMm / 2 + ACCESSORY_CLEARANCE_MM + lengthMm / 2 }))
    .sort((a, b) => a.from - b.from);
  const open: Array<{ from: number; to: number }> = [];
  let cursor = range.from;
  for (const block of blocked) {
    if (block.from > cursor) open.push({ from: cursor, to: Math.min(block.from, range.to) });
    cursor = Math.max(cursor, block.to);
    if (cursor >= range.to) break;
  }
  if (cursor < range.to) open.push({ from: cursor, to: range.to });
  const usable = open.filter((stretch) => stretch.to >= stretch.from);
  if (!usable.length) return { problem: `No room left on the straight for a ${lengthMm} mm ${ACCESSORY_NAMES[kind].toLowerCase()}.` };
  const wanted = preferredMm ?? (range.from + range.to) / 2;
  let best = usable[0]!.from;
  let bestGap = Infinity;
  for (const stretch of usable) {
    const at = Math.max(stretch.from, Math.min(stretch.to, wanted));
    if (Math.abs(at - wanted) < bestGap) {
      best = at;
      bestGap = Math.abs(at - wanted);
    }
  }
  return { stationMm: Math.round(best) };
}
