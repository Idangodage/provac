/**
 * A sized design tree built into ordinary duct runs, exactly as the duct tool
 * would: the run off the collar, each take-off through `tapOrigin` (so the
 * collar sits on the actual wall of the section chosen), split outlets through
 * `splitOrigin`, plenum spigots through `spigotOrigin`, a reducer vertex where
 * the section changes, the fitting down to the terminal's neck before its
 * flexible runout. The fabrication planner then judges the result; nothing
 * here is taken on trust.
 *
 * Legalisation. The fittings chosen fix each take-off's window on its parent
 * (SMACNA Fig. 2-6, 3-4, 3-5 plus the margin kept from joints): take-offs are
 * spread along their leg so no windows overlap and none meets an elbow, the
 * start pieces or the end (as the v1 layout spreads them); a reducer goes in a
 * straight gap between windows, and where none holds it the larger section
 * carries on (dearer, never unbuildable).
 *
 * A branch's first leg leaves its origin (square, or at 45° for a lateral or a
 * wye); the design's next vertex is moved onto that line, which only changes
 * the length of the leg after it.
 */
import type { HvacElement, Point2D } from '../../../../../types';
import {
  branchStubMm,
  dirToLocal,
  flexClear,
  flexOk,
  simplifyCollinear,
  stretchBlocked,
  toLocal,
  toWorld,
  type AutoDuctIssue,
  type ServiceCtx,
  type TerminalCtx,
} from '../ductAutoContext';
import { spigotOrigin, splitOrigin, tapOrigin } from '../ductBranchTargets';
import { buildDuctRunDraft, buildDuctRunDraftElement, type DuctDraftOrigin, type DuctDraftPoint } from '../ductDraft';
import { ductRunElementWithSpec } from '../ductFollow';
import { isRoundLeg, readDuctRunSpec, roundLeg, type DuctLeg, type DuctTapStyle } from '../ductTypes';

import { pointAlong, turnedTerminals, withReplaced, type RunDesign } from './designTree';
import type { RunSizing, SizedDesign } from './sizingDp';
import { sameLeg, type SizingModel } from './sizingModel';

export interface RealisedDesign {
  runs: HvacElement[];
  /** Terminals whose plenum spigot the design turns: the elements as they will be. */
  terminalUpdates: HvacElement[];
  terminalRuns: Map<string, string>;
  /** Which design run each built run is (element id → run key). */
  runKeys: Map<string, string>;
  notes: AutoDuctIssue[];
  /** Sections of the run off the collar, first to last, with their airflow. */
  trunkSections: Array<{ widthMm: number; heightMm: number; diameterMm?: number; airflowM3h: number }>;
}

type PlacedOrigin = Extract<DuctDraftOrigin, { point: Point2D; direction: Point2D; bottomZ: number }>;

function placed(origin: DuctDraftOrigin | null): PlacedOrigin | null {
  return origin && origin.kind !== 'port' && origin.kind !== 'free' ? origin : null;
}

/** Distance along a polyline to the point nearest `point`, and the leg it falls on. */
export function projectOnto(polyline: readonly Point2D[], point: Point2D): { station: number; legIndex: number; legStation: number; distance: number } {
  let best = { station: 0, legIndex: 0, legStation: 0, distance: Number.POSITIVE_INFINITY };
  let start = 0;
  for (let index = 1; index < polyline.length; index += 1) {
    const a = polyline[index - 1]!;
    const b = polyline[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const t = Math.max(0, Math.min(length, (point.x - a.x) * u.x + (point.y - a.y) * u.y));
    const distance = Math.hypot(a.x + u.x * t - point.x, a.y + u.y * t - point.y);
    if (distance < best.distance - 1e-6) best = { station: start + t, legIndex: index - 1, legStation: t, distance };
    start += length;
  }
  return best;
}

/** Inserts a vertex at `station` along the polyline (no-op on an existing vertex). */
function insertAt(polyline: Point2D[], station: number): void {
  let start = 0;
  for (let index = 1; index < polyline.length; index += 1) {
    const a = polyline[index - 1]!;
    const b = polyline[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (station > start + 1 && station < start + length - 1) {
      const t = (station - start) / length;
      polyline.splice(index, 0, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      return;
    }
    start += length;
  }
}

function stationsOf(polyline: readonly Point2D[]): number[] {
  const out = [0];
  for (let index = 1; index < polyline.length; index += 1) {
    out.push(out[index - 1]! + Math.hypot(polyline[index]!.x - polyline[index - 1]!.x, polyline[index]!.y - polyline[index - 1]!.y));
  }
  return out;
}

/**
 * Slack added to each side of a take-off window when windows are spread: the
 * planner receives whole-millimetre stations, and two windows spread exactly
 * edge to edge would overlap by the rounding.
 */
const WINDOW_SLACK_MM = 1;

/**
 * Positions for windows wanting `desired` (sorted by it), each `half` long
 * either side, kept in [from, to]: overlapping groups are spread evenly about
 * where they want to be. Null when they cannot all fit.
 */
export function spreadWindows(items: ReadonlyArray<{ desired: number; half: number }>, from: number, to: number): number[] | null {
  if (!items.length) return [];
  const order = items.map((item, index) => ({ ...item, index })).sort((a, b) => a.desired - b.desired);
  const clusters: Array<{ members: typeof order }> = [];
  const place = (members: typeof order): number[] => {
    const offsets = [0];
    for (let k = 1; k < members.length; k += 1) offsets.push(offsets[k - 1]! + members[k - 1]!.half + members[k]!.half);
    const shift = members.reduce((total, member) => total + member.desired, 0) / members.length - offsets.reduce((total, value) => total + value, 0) / offsets.length;
    let positions = offsets.map((offset) => offset + shift);
    const low = from + members[0]!.half - positions[0]!;
    if (low > 0) positions = positions.map((position) => position + low);
    const high = positions[positions.length - 1]! + members[members.length - 1]!.half - to;
    if (high > 0) positions = positions.map((position) => position - high);
    return positions;
  };
  for (const item of order) {
    clusters.push({ members: [item] });
    while (clusters.length >= 2) {
      const last = clusters[clusters.length - 1]!;
      const previous = clusters[clusters.length - 2]!;
      const a = place(previous.members);
      const b = place(last.members);
      if (b[0]! - last.members[0]!.half >= a[a.length - 1]! + previous.members[previous.members.length - 1]!.half - 1e-6) break;
      clusters.splice(clusters.length - 2, 2, { members: [...previous.members, ...last.members] });
    }
  }
  const out = new Array<number>(items.length);
  for (const cluster of clusters) {
    const positions = place(cluster.members);
    if (positions[0]! - cluster.members[0]!.half < from - 1 || positions[positions.length - 1]! + cluster.members[cluster.members.length - 1]!.half > to + 1) return null;
    cluster.members.forEach((member, k) => { out[member.index] = positions[k]!; });
  }
  return out;
}

/**
 * A routing-grid endpoint can fall inside the last elbow's fabricated neck.
 * Spend some of the flexible runout on straight rigid duct when it safely
 * provides that setback. The terminal, elbow, and upstream route stay put.
 */
export function extendTerminalApproach(
  ctx: ServiceCtx,
  model: SizingModel,
  points: Point2D[],
  terminal: TerminalCtx,
  section: DuctLeg,
  bottomZ: number,
): void {
  if (points.length < 3 || !sameLeg(section, roundLeg(terminal.neck))) return;
  const a = points[points.length - 3]!;
  const corner = points[points.length - 2]!;
  const end = points[points.length - 1]!;
  const length = Math.hypot(end.x - corner.x, end.y - corner.y);
  const before = Math.hypot(corner.x - a.x, corner.y - a.y);
  if (length < 1 || before < 1) return;
  const out = { x: (end.x - corner.x) / length, y: (end.y - corner.y) / length };
  const cos = ((corner.x - a.x) * out.x + (corner.y - a.y) * out.y) / before;
  const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  if (angle < 1 || angle > 135) return;
  const need = model.elbowSetbackMm(section, angle) + ctx.settings.elbowNeckMm + 25;
  if (length >= need) return;
  const next = { x: corner.x + out.x * need, y: corner.y + out.y * need };
  if ((next.x - terminal.lip.x) * terminal.normal.x + (next.y - terminal.lip.y) * terminal.normal.y <= terminal.neck) return;
  if (stretchBlocked(ctx, end, next, terminal.neck, bottomZ, new Set([terminal.element.id]))) return;
  if (!flexOk(model.flexRunoutCurve(next, out, terminal, bottomZ), terminal, ctx.settings)
    || !flexClear(ctx, next, out, bottomZ, terminal)) return;
  points[points.length - 1] = next;
}

/** Why a sized design could not be built: the run, what did not fit, and the take-off concerned. */
export interface RealiseFailure {
  runKey: string;
  reason: 'sizing' | 'branch-start' | 'take-off-windows' | 'runout' | 'neck-transition' | 'origin';
  tap?: number;
  detail: string;
}

export function realiseDesign(ctx: ServiceCtx, model: SizingModel, sized: SizedDesign, onFailure?: (failure: RealiseFailure) => void): RealisedDesign | null {
  const { settings } = ctx;
  const runs: HvacElement[] = [];
  const terminalRuns = new Map<string, string>();
  const runKeys = new Map<string, string>();
  const notes: AutoDuctIssue[] = [];
  // Terminals whose spigot the design turns are built against as they will be.
  const turned = turnedTerminals(sized.design.root);
  let scene: HvacElement[] = withReplaced(ctx.baseScene, turned);
  let trunkSections: RealisedDesign['trunkSections'] = [];

  /** The first (deepest) failure; parents only pass it up. */
  let failure: RealiseFailure | null = null;
  const fail = (runKey: string, reason: RealiseFailure['reason'], detail: string, tap?: number): false => {
    failure ??= { runKey, reason, detail, ...(tap !== undefined ? { tap } : {}) };
    return false;
  };
  const realise = (run: RunDesign, origin: PlacedOrigin | null, style: DuctTapStyle | 'wye' | null): boolean => {
    const sizing: RunSizing | undefined = sized.sizing.get(run.key);
    if (!sizing) return fail(run.key, 'sizing', 'no sizes for this run');
    const sections = [...sizing.sections];
    const first = sections[0]!;
    // ---- The polyline, local frame ----
    let polyline: Point2D[];
    let startClear: number;
    /** Where take-offs may begin at the earliest (the root's connector and collar transition). */
    let hardStart = 0;
    /** Turning first (the sizing's choice): the collar's section up to its square vaned elbow, then the transition. */
    let collarTurn: { collar: DuctLeg; at: number } | null = null;
    if (!origin) {
      polyline = [...run.vertices];
      startClear = sized.design.fanOutletMm;
      const collar: DuctLeg = { widthMm: ctx.port.widthMm, heightMm: ctx.port.heightMm };
      const connector = settings.flexibleConnectorAtUnit ? settings.connectorFabricMm + 2 * settings.connectorMetalMm : 0;
      const transitionMm = sameLeg(collar, first) ? 0 : model.transitionLengthMm(collar, first).lengthMm;
      hardStart = connector + transitionMm + 50;
      if (sizing.collarTurn && polyline.length > 2) {
        const bendAt = Math.hypot(polyline[1]!.x - polyline[0]!.x, polyline[1]!.y - polyline[0]!.y);
        const at = bendAt + model.elbowSetbackMm(collar) + settings.elbowNeckMm;
        collarTurn = { collar, at };
        hardStart = at + transitionMm + 50;
      }
    } else {
      const start = toLocal(ctx.frame, origin.point);
      const out = dirToLocal(ctx.frame, origin.direction);
      startClear = model.collarLengthMm((style === 'wye' || !style ? 'spin-in' : style), first) + (origin.kind === 'split' ? 0 : settings.vcdLengthMm) + 100;
      if (run.allFlex) {
        const stub = branchStubMm(settings) + Math.max(0, model.collarLengthMm((style ?? 'spin-in') as DuctTapStyle, first) - settings.tapCollarMm);
        polyline = [start, { x: start.x + out.x * stub, y: start.y + out.y * stub }];
      } else {
        polyline = [start];
        let lineStart = start;
        let lineDirection = out;
        if (style === 'round-lateral' || style === 'wye') {
          // 45° away, then an elbow squares the branch onto the design's line.
          const collar = style === 'wye' ? 51 : model.collarLengthMm('round-lateral', first);
          const diagonal = model.diagonalLegMm(first, collar, style !== 'wye');
          const corner = { x: start.x + out.x * diagonal, y: start.y + out.y * diagonal };
          polyline.push(corner);
          lineStart = corner;
          const designFirst = { x: run.vertices[1]!.x - run.vertices[0]!.x, y: run.vertices[1]!.y - run.vertices[0]!.y };
          const length = Math.hypot(designFirst.x, designFirst.y) || 1;
          lineDirection = { x: designFirst.x / length, y: designFirst.y / length };
          startClear = diagonal + model.elbowRadiusMm(first) + settings.elbowNeckMm + 100;
        }
        // The design's next vertex, moved onto the line the branch actually leaves on.
        const next = run.vertices[1]!;
        const along = (next.x - lineStart.x) * lineDirection.x + (next.y - lineStart.y) * lineDirection.y;
        if (along < 150) return fail(run.key, 'branch-start', `its first leg is ${Math.round(along)} mm long after its ${style} leaves the main`);
        polyline.push({ x: lineStart.x + lineDirection.x * along, y: lineStart.y + lineDirection.y * along });
        polyline.push(...run.vertices.slice(2));
        polyline = simplifyCollinear(polyline);
      }
    }
    const biggest = sections.reduce((best, section) => (section.widthMm * section.heightMm > best.widthMm * best.heightMm ? section : best), first);
    const end = run.end;
    if (end.kind === 'terminal' && !run.allFlex) {
      extendTerminalApproach(ctx, model, polyline, end.terminal, sections[sections.length - 1]!, origin ? origin.bottomZ : ctx.bottomZ);
    }
    const endClear = end.kind === 'terminal' ? 450 : end.kind === 'split' ? settings.elbowNeckMm + Math.max(biggest.widthMm, 250) + 50
      : end.kind === 'plenum' ? end.lengthMm + 100 : 100;
    // A split's outlets leave its fitting past the run's end (splitLeadMm), but the design joins them at its
    // node: the run ends that much short, as far as its last leg still holds what comes before (the elbow
    // that starts it, square vaned if that makes the room, or the start's reserve, and its take-offs), so
    // the outlets run on the lines the design priced.
    let squareLastBend = false;
    if (end.kind === 'split' && polyline.length >= 2) {
      const style = sizing.splitStyle ?? 'y';
      const main = sections[sections.length - 1]!;
      const lead = Math.max(0, ...end.children.map((child) => {
        const outlet = sized.sizing.get(child.key)?.sections[0];
        return outlet ? model.splitLeadMm(style, main, outlet) : 0;
      }));
      const n = polyline.length;
      const a = polyline[n - 2]!;
      const b = polyline[n - 1]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const along = { x: (b.x - a.x) / (length || 1), y: (b.y - a.y) / (length || 1) };
      // Take-off windows on the last leg keep the split's reserve behind them.
      let tapsKeep = 0;
      for (let j = 0; j < run.taps.length; j += 1) {
        const point = pointAlong(run, run.taps[j]!.station).point;
        const offset = (point.x - a.x) * along.x + (point.y - a.y) * along.y;
        const across = Math.abs((point.x - a.x) * along.y - (point.y - a.y) * along.x);
        const outlet = sized.sizing.get(run.taps[j]!.child.key)?.sections[0];
        if (offset < 0 || across > 1 || !outlet) continue;
        tapsKeep = Math.max(tapsKeep, offset + model.tapWindowHalfMm(sizing.tapStyles[j] ?? 'spin-in', outlet, sections[Math.min(j, sections.length - 1)]!) + endClear);
      }
      let keep: number;
      let squareKeep = Infinity;
      if (n > 2) {
        const before = polyline[n - 3]!;
        const u = { x: a.x - before.x, y: a.y - before.y };
        const cos = (u.x * along.x + u.y * along.y) / (Math.hypot(u.x, u.y) || 1);
        const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
        keep = model.elbowRadiusMm(biggest) * Math.tan(angle / 2) + settings.elbowNeckMm + 25;
        if (!isRoundLeg(biggest) && Math.abs((angle * 180) / Math.PI - 90) < 1) squareKeep = biggest.widthMm / 2 + settings.elbowNeckMm + 25;
      } else {
        keep = origin ? startClear : Math.max(hardStart, Math.min(startClear, 900));
      }
      let pull = Math.max(0, Math.min(lead, length - Math.max(keep, tapsKeep)));
      if (pull < lead && squareKeep < keep) {
        const squared = Math.max(0, Math.min(lead, length - Math.max(squareKeep, tapsKeep)));
        if (squared > pull) { pull = squared; squareLastBend = true; }
      }
      if (pull > 0) polyline[n - 1] = { x: b.x - along.x * pull, y: b.y - along.y * pull };
    }
    const stations = stationsOf(polyline);
    const total = stations[stations.length - 1]!;
    // Elbow zones: each bend takes its setback and neck either side (on the biggest section, conservatively).
    // A radius elbow where its legs hold it; where a leg needs the room for its take-offs, a 90° turn on a
    // rectangular section is specified as a square vaned elbow (setback W/2), and the planner is told so.
    const bends: Array<{ index: number; point: Point2D; station: number; angle: number; square: boolean }> = [];
    for (let index = 1; index < polyline.length - 1; index += 1) {
      const a = polyline[index - 1]!;
      const b = polyline[index]!;
      const c = polyline[index + 1]!;
      const u = { x: b.x - a.x, y: b.y - a.y };
      const v = { x: c.x - b.x, y: c.y - b.y };
      const cos = (u.x * v.x + u.y * v.y) / ((Math.hypot(u.x, u.y) || 1) * (Math.hypot(v.x, v.y) || 1));
      const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      if (angle < 0.02) continue;
      bends.push({ index, point: b, station: stations[index]!, angle, square: (squareLastBend && index === polyline.length - 2) || (collarTurn !== null && index === 1) });
    }
    const canSquare = (bend: (typeof bends)[number]) => !isRoundLeg(biggest) && Math.abs((bend.angle * 180) / Math.PI - 90) < 1;
    const zoneOf = (bend: (typeof bends)[number]): [number, number] => {
      // The collar's own elbow when the root turns first; else on the run's biggest section.
      const width = collarTurn && bend.index === 1 ? collarTurn.collar.widthMm : biggest.widthMm;
      const reach = (bend.square ? width / 2 : model.elbowRadiusMm(biggest) * Math.tan(bend.angle / 2)) + settings.elbowNeckMm + 25;
      return [bend.station - reach, bend.station + reach];
    };
    let bendZones: Array<[number, number]> = bends.map(zoneOf);
    // ---- Take-offs: their windows for the fittings chosen, spread along their legs ----
    const tapPositions: number[] = [];
    const tapHalves: number[] = [];
    /** Whether take-off j's all-flex branch, off the main at `station`, has a runout that fits and runs clear. */
    const stubFits = (j: number, station: number): boolean => {
      const tap = run.taps[j]!;
      const child = tap.child;
      if (!child.allFlex || child.end.kind !== 'terminal' || child.vertices.length < 2) return true;
      const terminal = child.end.terminal;
      const first = child.vertices[0]!;
      const second = child.vertices[1]!;
      const reach = Math.hypot(second.x - first.x, second.y - first.y) || 1;
      const out = { x: (second.x - first.x) / reach, y: (second.y - first.y) / reach };
      const main = sections[Math.min(j, sections.length - 1)]!;
      const centre = pointAlong({ vertices: polyline }, station).point;
      return model.stubRunoutFits(centre, out, main, sizing.tapStyles[j] ?? 'spin-in', terminal, origin ? origin.bottomZ : ctx.bottomZ);
    };
    const legOf = (station: number) => {
      let leg = 0;
      while (leg < polyline.length - 2 && station > stations[leg + 1]! - 1e-6) leg += 1;
      return leg;
    };
    const byLeg = new Map<number, Array<{ j: number; desired: number; half: number }>>();
    for (let j = 0; j < run.taps.length; j += 1) {
      const tap = run.taps[j]!;
      const childSizing = sized.sizing.get(tap.child.key);
      if (!childSizing) return fail(tap.child.key, 'sizing', 'no sizes for this branch');
      const desired = projectOnto(polyline, pointAlong(run, tap.station).point).station;
      const segment = Math.min(j, sections.length - 1);
      const half = model.tapWindowHalfMm(sizing.tapStyles[j] ?? 'spin-in', childSizing.sections[0]!, sections[segment]!);
      tapHalves[j] = half;
      const leg = legOf(desired);
      const list = byLeg.get(leg) ?? [];
      // A little slack each side: stations are rounded to whole millimetres when the take-off is built.
      list.push({ j, desired, half: half + WINDOW_SLACK_MM });
      byLeg.set(leg, list);
    }
    for (const [leg, items] of byLeg) {
      const limits = (): [number, number] => {
        let from = stations[leg]!;
        let to = stations[leg + 1]!;
        if (leg === 0) from = Math.max(from, hardStart, Math.min(startClear, ...items.map((item) => item.desired - item.half)));
        if (leg === polyline.length - 2) to = Math.min(to, total - endClear);
        for (const [a, b] of bendZones) {
          if (a < from + 1e-6 && b > from) from = b;
          if (b > to - 1e-6 && a < to) to = a;
        }
        return [from, to];
      };
      let [from, to] = limits();
      let positions = spreadWindows(items, from, to);
      if (!positions) {
        // The leg's take-offs need the room a radius elbow takes: square vaned elbows at its ends instead.
        const ends = bends.filter((bend) => (bend.index === leg || bend.index === leg + 1) && !bend.square && canSquare(bend));
        if (ends.length) {
          for (const bend of ends) bend.square = true;
          bendZones = bends.map(zoneOf);
          [from, to] = limits();
          positions = spreadWindows(items, from, to);
        }
      }
      if (!positions) {
        const need = items.reduce((sum, item) => sum + 2 * item.half, 0);
        return fail(run.key, 'take-off-windows', `leg ${leg}: ${items.length} take-off window(s) need ${Math.round(need)} mm, ${Math.round(Math.max(0, to - from))} mm is clear of elbows`, items[0]!.j);
      }
      const placedAt = positions;
      items.forEach((item, k) => { tapPositions[item.j] = placedAt[k]!; });
      // A take-off moved to clear its neighbours: an all-flex branch's runout must still fit and run clear
      // from there. If not, the nearest station on the leg (in order, windows apart) where it does.
      const ordered = [...items].sort((a, b) => a.j - b.j);
      for (let k = 0; k < ordered.length; k += 1) {
        const item = ordered[k]!;
        if (stubFits(item.j, tapPositions[item.j]!)) continue;
        const low = Math.max(from + item.half, k > 0 ? tapPositions[ordered[k - 1]!.j]! + ordered[k - 1]!.half + item.half : -Infinity);
        const high = Math.min(to - item.half, k + 1 < ordered.length ? tapPositions[ordered[k + 1]!.j]! - ordered[k + 1]!.half - item.half : Infinity);
        let found: number | null = null;
        const reach = Math.max(Math.abs(item.desired - low), Math.abs(item.desired - high));
        for (let offset = 0; offset <= reach && found === null; offset += 25) {
          for (const candidate of offset ? [item.desired - offset, item.desired + offset] : [item.desired]) {
            if (candidate < low - 1e-6 || candidate > high + 1e-6 || !stubFits(item.j, candidate)) continue;
            found = candidate;
            break;
          }
        }
        if (found === null) return fail(run.key, 'runout', `take-off ${item.j}: its runout bends too tight, is too long or runs into equipment from anywhere on leg ${leg}`, item.j);
        tapPositions[item.j] = found;
      }
    }
    // ---- Reducers: in a straight gap between windows, else the larger section carries on ----
    const changes: Array<{ at: number; section: DuctLeg }> = [];
    let current = first;
    for (let k = 1; k < sections.length; k += 1) {
      const target = sections[k]!;
      if (sameLeg(current, target)) { sections[k] = current; continue; }
      const length = model.transitionLengthMm(current, target).lengthMm;
      const gapFrom = k - 1 < run.taps.length ? tapPositions[k - 1]! + tapHalves[k - 1]! : startClear;
      const gapTo = k < run.taps.length ? tapPositions[k]! - tapHalves[k]! : total - endClear;
      let best: [number, number] | null = null;
      let cursor = gapFrom;
      for (const [a, b] of [...bendZones.filter(([a, b]) => b > gapFrom && a < gapTo).sort((m, n) => m[0] - n[0]), [gapTo, gapTo] as [number, number]]) {
        const until = Math.min(a, gapTo);
        if (until - cursor >= length + 20 && (!best || until - cursor > best[1] - best[0])) best = [cursor, until];
        cursor = Math.max(cursor, b);
      }
      if (!best) { sections[k] = current; continue; }
      changes.push({ at: (best[0] + best[1]) / 2 - length / 2, section: target });
      current = target;
    }
    const terminal = end.kind === 'terminal' ? end.terminal : null;
    const neck: DuctLeg | null = terminal ? roundLeg(terminal.neck) : null;
    if (neck && !run.allFlex && !sameLeg(current, neck)) {
      const length = model.transitionLengthMm(current, neck).lengthMm;
      const at = total - Math.max(400, length + 100);
      const lastTapEnd = run.taps.length ? tapPositions[run.taps.length - 1]! + tapHalves[run.taps.length - 1]! : startClear;
      if (at < lastTapEnd || bendZones.some(([a, b]) => b > at && a < total)) {
        return fail(run.key, 'neck-transition', `the fitting down to the Ø${terminal!.neck} neck (${Math.round(length)} mm) has no straight before the runout`);
      }
      changes.push({ at, section: neck });
    }
    // Turning first: the run starts at the collar's section and steps to its own after that elbow.
    if (collarTurn) changes.push({ at: collarTurn.at, section: first });
    changes.sort((a, b) => a.at - b.at);
    for (const change of changes) insertAt(polyline, change.at);
    // Section of each leg: the last change at or before its start.
    const legSizes: DuctLeg[] = [];
    let station = 0;
    for (let index = 1; index < polyline.length; index += 1) {
      let section = collarTurn ? collarTurn.collar : first;
      for (const change of changes) if (change.at <= station + 1) section = change.section;
      legSizes.push(section);
      station += Math.hypot(polyline[index]!.x - polyline[index - 1]!.x, polyline[index]!.y - polyline[index - 1]!.y);
    }
    const bottomZ = origin ? origin.bottomZ : ctx.bottomZ;
    const points: DuctDraftPoint[] = polyline.slice(1).map((point) => ({ ...toWorld(ctx.frame, point), z: bottomZ }));
    // ---- The run ----
    let element: HvacElement;
    const input = {
      points: [...points, ...(terminal ? [{ x: terminal.port.lip.x, y: terminal.port.lip.y, z: terminal.port.lip.z - terminal.neck / 2 }] : [])],
      legSizes: [...(run.allFlex && neck ? [neck] : legSizes), ...(neck ? [neck] : [])],
      construction: ctx.construction,
      end: terminal
        ? { kind: 'terminal' as const, terminalId: terminal.element.id, portId: terminal.port.portId, flex: true }
        : end.kind === 'plenum' ? { kind: 'plenum' as const, widthMm: end.widthMm, heightMm: end.heightMm, lengthMm: end.lengthMm } : 'end-cap' as const,
    };
    if (!origin) {
      element = buildDuctRunDraftElement({ port: ctx.port, ...input }, ctx.ids());
      let flow = run.airflowM3h;
      trunkSections = [{ ...first, airflowM3h: flow }];
      run.taps.forEach((tap, j) => {
        flow -= tap.child.airflowM3h;
        const section = sections[Math.min(j + 1, sections.length - 1)]!;
        if (!sameLeg(section, trunkSections[trunkSections.length - 1]!)) trunkSections.push({ ...section, airflowM3h: flow + tap.child.airflowM3h });
      });
    } else {
      element = buildDuctRunDraft({ origin, ...input }, ctx.ids(), scene).element;
    }
    if (end.kind === 'split') {
      element = ductRunElementWithSpec(element, { ...readDuctRunSpec(element)!, end: { kind: 'split', style: sizing.splitStyle ?? 'y' } });
    }
    // Square vaned elbows where the take-offs needed the room, told to the planner by node.
    const squares = bends.filter((bend) => bend.square);
    if (squares.length) {
      const spec = readDuctRunSpec(element)!;
      const nodeOverrides = { ...spec.nodeOverrides };
      for (const bend of squares) {
        const world = toWorld(ctx.frame, bend.point);
        const node = spec.path.findIndex((point, index) => index > 0 && index < spec.path.length - 1 && Math.hypot(point.x - world.x, point.y - world.y) < 1);
        if (node > 0) nodeOverrides[String(node)] = { ...nodeOverrides[String(node)], elbowStyle: 'square-vaned' };
      }
      element = ductRunElementWithSpec(element, { ...spec, nodeOverrides });
    }
    runs.push(element);
    runKeys.set(element.id, run.key);
    scene = [...scene, element];
    if (terminal) terminalRuns.set(terminal.element.id, element.id);
    // ---- Its branches ----
    const realisedLocal = readDuctRunSpec(element)!.path.map((point) => toLocal(ctx.frame, point));
    for (let j = 0; j < run.taps.length; j += 1) {
      const tap = run.taps[j]!;
      const childSizing = sized.sizing.get(tap.child.key)!;
      const tapStyle = sizing.tapStyles[j] ?? 'spin-in';
      const at = projectOnto(realisedLocal, pointAlong({ vertices: polyline }, tapPositions[j]!).point);
      const childOrigin = placed(tapOrigin(element, settings, { legIndex: at.legIndex, stationMm: Math.round(at.legStation), side: tap.side, style: tapStyle, vcd: true }, childSizing.sections[0]!));
      if (!childOrigin) return fail(run.key, 'origin', `take-off ${j} cannot be cut at station ${Math.round(at.legStation)} on leg ${at.legIndex}`, j);
      if (!realise(tap.child, childOrigin, tapStyle)) return false;
    }
    if (end.kind === 'split') {
      for (const child of end.children) {
        const childSizing = sized.sizing.get(child.key);
        if (!childSizing || child.start.kind !== 'split') return fail(child.key, 'sizing', 'no sizes for this split outlet');
        const splitStyle = sizing.splitStyle ?? 'y';
        const childOrigin = placed(splitOrigin(element, settings, { side: child.start.side, style: splitStyle, vcd: false }, childSizing.sections[0]!));
        if (!childOrigin) return fail(run.key, 'origin', `the ${splitStyle} outlet cannot be made`);
        if (!realise(child, childOrigin, splitStyle === 'wye' ? 'wye' : null)) return false;
      }
    }
    if (end.kind === 'plenum') {
      for (let c = 0; c < end.spigots.length; c += 1) {
        const spigot = end.spigots[c]!;
        const childSizing = sized.sizing.get(spigot.child.key);
        if (!childSizing) return fail(spigot.child.key, 'sizing', 'no sizes for this spigot branch');
        const spigotStyle = sizing.spigotStyles?.[c] ?? 'spin-in';
        const childOrigin = placed(spigotOrigin(element, settings, { face: spigot.face, alongMm: spigot.alongMm, acrossMm: spigot.acrossMm, style: spigotStyle, vcd: true }, childSizing.sections[0]!));
        if (!childOrigin) return fail(run.key, 'origin', 'a plenum spigot cannot be made');
        if (!realise(spigot.child, childOrigin, spigotStyle)) return false;
      }
    }
    return true;
  };

  if (!realise(sized.design.root, null, null)) {
    onFailure?.(failure ?? { runKey: sized.design.root.key, reason: 'sizing', detail: 'not built' });
    return null;
  }
  return { runs, terminalUpdates: turned, terminalRuns, runKeys, notes, trunkSections };
}
