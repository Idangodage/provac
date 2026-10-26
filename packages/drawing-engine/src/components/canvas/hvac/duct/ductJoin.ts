/**
 * Joining duct runs back into one across a gap (a reconnection, or a stretch
 * drawn by hand between two open ends). The run before the gap keeps its id;
 * the bridge's legs take the sections given (by default that run's last); the
 * run after the gap follows, its branches, accessories, elbow and fire-damper
 * choices re-pointed onto the joined run, and is removed. Where the joints
 * leave two legs in line at one level and one section, they are made one leg
 * again, so a piece put back where it was is planned as it was. Pure.
 */
import type { HvacElement } from '../../../../types';

import { getActiveDuctBuilding, type DuctBuilding } from './ductBuilding';
import { ductRunElementWithSpec } from './ductFollow';
import { ductBranchesOf } from './ductNetwork';
import { ductWallCrossings } from './ductPenetrations';
import type { DuctInlineAccessory, DuctLeg, DuctNodeOverride, DuctPenetrationOverride, DuctPoint3, DuctRunSpec } from './ductTypes';

export interface DuctRunRef {
  element: HvacElement;
  spec: DuctRunSpec;
}

/** Where a place on an old run (a leg and the distance along it) is on the joined one. */
export type DuctRelocate = (legIndex: number, stationMm: number) => { legIndex: number; stationMm: number };

const LEVEL_MM = 0.5;

function sameSection(a: DuctLeg, b: DuctLeg): boolean {
  return Math.abs(a.widthMm - b.widthMm) < 0.5 && Math.abs(a.heightMm - b.heightMm) < 0.5
    && (a.diameterMm === undefined) === (b.diameterMm === undefined)
    && (a.diameterMm === undefined || Math.abs(a.diameterMm - b.diameterMm!) < 0.5);
}

/**
 * The run with the vertices in `at` taken out where the legs either side are
 * level at one level, run on in one plan direction and have one section: what
 * is on the second leg is re-measured from the first's start.
 */
export function mergeInlineLegs(spec: DuctRunSpec, at: ReadonlySet<number>): { spec: DuctRunSpec; relocate: DuctRelocate; node: (index: number) => number | null } {
  const path = spec.path;
  const mergeable = (k: number) => {
    if (!at.has(k) || k <= 0 || k >= path.length - 1) return false;
    const a = path[k - 1]!;
    const b = path[k]!;
    const c = path[k + 1]!;
    if (Math.abs(a.z - b.z) > LEVEL_MM || Math.abs(b.z - c.z) > LEVEL_MM) return false;
    const ab = { x: b.x - a.x, y: b.y - a.y };
    const bc = { x: c.x - b.x, y: c.y - b.y };
    const lab = Math.hypot(ab.x, ab.y);
    const lbc = Math.hypot(bc.x, bc.y);
    if (lab < LEVEL_MM || lbc < LEVEL_MM) return false;
    if ((ab.x * bc.x + ab.y * bc.y) / (lab * lbc) < 1 - 1e-6) return false;
    return sameSection(spec.legs[k - 1]!, spec.legs[k]!);
  };
  const newPath: DuctPoint3[] = [{ ...path[0]! }];
  const newLegs: DuctLeg[] = [];
  const legMap: Array<{ leg: number; offset: number }> = [];
  const nodeMap: Array<number | null> = [0];
  for (let k = 0; k < spec.legs.length; k += 1) {
    if (k > 0 && mergeable(k)) {
      // Vertex k goes: the current leg runs on to k + 1.
      const start = newPath[newPath.length - 2]!;
      const offset = Math.hypot(path[k]!.x - start.x, path[k]!.y - start.y);
      newPath[newPath.length - 1] = { ...path[k + 1]! };
      nodeMap[k] = null;
      legMap.push({ leg: newLegs.length - 1, offset });
    } else {
      newLegs.push(spec.legs[k]!);
      newPath.push({ ...path[k + 1]! });
      legMap.push({ leg: newLegs.length - 1, offset: 0 });
    }
    nodeMap[k + 1] = newPath.length - 1;
  }
  const relocate: DuctRelocate = (legIndex, stationMm) => {
    const entry = legMap[legIndex] ?? legMap[legMap.length - 1]!;
    return { legIndex: entry.leg, stationMm: stationMm + entry.offset };
  };
  const node = (index: number) => nodeMap[index] ?? null;
  if (newLegs.length === spec.legs.length) return { spec, relocate, node };
  const nodeOverrides: Record<string, DuctNodeOverride> = {};
  for (const [key, override] of Object.entries(spec.nodeOverrides)) {
    const moved = node(Number(key));
    if (moved !== null) nodeOverrides[String(moved)] = override;
  }
  const inline = (spec.inline ?? []).map((item): DuctInlineAccessory => ({ ...item, ...relocate(item.legIndex, item.stationMm) }));
  const { inline: _inline, ...rest } = spec;
  return { spec: { ...rest, path: newPath, legs: newLegs, nodeOverrides, ...(inline.length ? { inline } : {}) }, relocate, node };
}

/**
 * Fire-damper choices of the runs joined, on the joined run: each by its
 * crossing (keys count the crossings along a run, so they are counted again).
 */
export function joinedPenetrations(
  sources: ReadonlyArray<DuctRunSpec>,
  joined: DuctRunSpec,
  building: Pick<DuctBuilding, 'walls' | 'rooms'>,
): Record<string, DuctPenetrationOverride> | undefined {
  if (!sources.some((spec) => spec.penetrations && Object.keys(spec.penetrations).length) || !building.walls.length) return undefined;
  const after = ductWallCrossings(joined, building.walls, building.rooms);
  const out: Record<string, DuctPenetrationOverride> = {};
  for (const spec of sources) {
    if (!spec.penetrations) continue;
    const before = ductWallCrossings(spec, building.walls, building.rooms);
    for (const [key, override] of Object.entries(spec.penetrations)) {
      const was = before.find((crossing) => crossing.key === key);
      const now = was ? after.find((crossing) => crossing.wallId === was.wallId && Math.hypot(crossing.point.x - was.point.x, crossing.point.y - was.point.y) < 1) : null;
      if (now) out[now.key] = override;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export interface DuctJoin {
  /** The joined run (A's id). */
  spec: DuctRunSpec;
  /** A as joined, and the branches re-pointed onto it. */
  updates: HvacElement[];
  /** B, now part of A. */
  removeIds: string[];
}

/**
 * A and B joined through `via` (the bridge's corners between A's end and B's
 * start, with their levels), each bridge leg in `sections[i]` (default: A's
 * last section). A's end and B's start are expected open (the gap's two ends).
 */
export function joinDuctRuns(
  scene: readonly HvacElement[],
  a: DuctRunRef,
  b: DuctRunRef,
  via: readonly DuctPoint3[],
  options: { sections?: readonly DuctLeg[]; building?: Pick<DuctBuilding, 'walls' | 'rooms'> } = {},
): DuctJoin {
  const building = options.building ?? getActiveDuctBuilding();
  const nA = a.spec.path.length;
  const bridgeLegs = via.length + 1;
  const last = a.spec.legs[a.spec.legs.length - 1]!;
  const sections = Array.from({ length: bridgeLegs }, (_, index) => options.sections?.[index] ?? options.sections?.[options.sections.length - 1] ?? last);
  // B's leg j is the joined leg j + offset; its vertex j the joined vertex j + offset.
  const offset = nA + via.length;
  const nodeOverrides: Record<string, DuctNodeOverride> = { ...a.spec.nodeOverrides };
  for (const [key, override] of Object.entries(b.spec.nodeOverrides)) nodeOverrides[String(Number(key) + offset)] = override;
  const inline: DuctInlineAccessory[] = [
    ...(a.spec.inline ?? []),
    ...(b.spec.inline ?? []).map((item) => ({ ...item, legIndex: item.legIndex + offset })),
  ];
  const { inline: _inline, penetrations: _penetrations, ...rest } = a.spec;
  const raw: DuctRunSpec = {
    ...rest,
    path: [...a.spec.path.map((point) => ({ ...point })), ...via.map((point) => ({ ...point })), ...b.spec.path.map((point) => ({ ...point }))],
    legs: [...a.spec.legs, ...sections, ...b.spec.legs],
    end: b.spec.end,
    nodeOverrides,
    ...(inline.length ? { inline } : {}),
  };
  // The joints at A's end, the bridge's corners and B's start: legs left in line become one again.
  const joints = new Set<number>(Array.from({ length: via.length + 2 }, (_, index) => nA - 1 + index));
  const merged = mergeInlineLegs(raw, joints);
  const penetrations = joinedPenetrations([a.spec, b.spec], merged.spec, building);
  const spec: DuctRunSpec = { ...merged.spec, ...(penetrations ? { penetrations } : {}) };
  const updates: HvacElement[] = [ductRunElementWithSpec(a.element, spec)];
  // Branches: A's stay (re-measured where legs merged), B's move onto A (their legs offset first).
  for (const [run, shift] of [[a, 0], [b, offset]] as const) {
    for (const branch of ductBranchesOf(run.element.id, scene)) {
      const start = branch.start;
      let next: DuctRunSpec | null = null;
      if (start.kind === 'tap') {
        const moved = merged.relocate(start.legIndex + shift, start.stationMm);
        if (run === a && moved.legIndex === start.legIndex && Math.abs(moved.stationMm - start.stationMm) < 1e-6) continue;
        next = { ...branch.spec, start: { ...start, parentRunId: a.element.id, legIndex: moved.legIndex, stationMm: moved.stationMm } };
      } else if (run === b) {
        // A split's or a plenum's branches stay with the end, which is now A's.
        next = { ...branch.spec, start: { ...start, parentRunId: a.element.id } };
      }
      if (next) updates.push(ductRunElementWithSpec(branch.element, next));
    }
  }
  return { spec, updates, removeIds: [b.element.id] };
}
