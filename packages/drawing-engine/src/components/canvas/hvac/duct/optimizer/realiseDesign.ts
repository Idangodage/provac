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
  simplifyCollinear,
  toLocal,
  toWorld,
  type AutoDuctIssue,
  type ServiceCtx,
} from '../ductAutoContext';
import { spigotOrigin, splitOrigin, tapOrigin } from '../ductBranchTargets';
import { shoeLeadInMm } from '../ductBranches';
import { buildDuctRunDraft, buildDuctRunDraftElement, type DuctDraftOrigin, type DuctDraftPoint } from '../ductDraft';
import { ductRunElementWithSpec } from '../ductFollow';
import { roundMainTapGeometry } from '../ductRoundFittings';
import { SMACNA_TABLE_3_1 } from '../ductRoundRules';
import { isRoundLeg, isRoundMainTapStyle, readDuctRunSpec, roundLeg, type DuctLeg, type DuctTapStyle } from '../ductTypes';

import { pointAlong, type RunDesign } from './designTree';
import type { RunSizing, SizedDesign } from './sizingDp';
import { sameLeg, type SizingModel } from './sizingModel';

export interface RealisedDesign {
  runs: HvacElement[];
  terminalRuns: Map<string, string>;
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

/** The 45° leg of a lateral or a wye leg before its elbow squares the branch: collar or leg, damper, elbow setback, neck (mm). */
function diagonalLegMm(model: SizingModel, first: DuctLeg, collarMm: number, damper: boolean): number {
  const ratio = SMACNA_TABLE_3_1[model.settings.roundVelocityBand].ratio;
  const setback = ratio * (first.diameterMm ?? first.widthMm) * Math.tan(Math.PI / 8);
  return collarMm + (damper ? model.settings.vcdLengthMm : 0) + setback + model.settings.elbowNeckMm + 50;
}

/** Half the parent length a take-off occupies (its opening as the planner cuts it) plus the joint margin. */
function tapWindowHalfMm(style: DuctTapStyle, branch: DuctLeg, main: DuctLeg, model: SizingModel): number {
  const s = model.settings;
  let half: number;
  if (isRoundLeg(main) && isRoundMainTapStyle(style)) half = roundMainTapGeometry(style, branch.diameterMm ?? branch.widthMm, s).windowHalfMm;
  else if (style === 'conical') half = (branch.widthMm + s.conicalFlareMm) / 2;
  else if (style === 'shoe-45') half = branch.widthMm / 2 + shoeLeadInMm(branch.widthMm);
  else half = branch.widthMm / 2;
  return half + s.tapWindowMarginMm;
}

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

export function realiseDesign(ctx: ServiceCtx, model: SizingModel, sized: SizedDesign): RealisedDesign | null {
  const { settings } = ctx;
  const runs: HvacElement[] = [];
  const terminalRuns = new Map<string, string>();
  const notes: AutoDuctIssue[] = [];
  let scene: HvacElement[] = [...ctx.baseScene];
  let trunkSections: RealisedDesign['trunkSections'] = [];

  const realise = (run: RunDesign, origin: PlacedOrigin | null, style: DuctTapStyle | 'wye' | null): boolean => {
    const sizing: RunSizing | undefined = sized.sizing.get(run.key);
    if (!sizing) return false;
    const sections = [...sizing.sections];
    const first = sections[0]!;
    // ---- The polyline, local frame ----
    let polyline: Point2D[];
    let startClear: number;
    /** Where take-offs may begin at the earliest (the root's connector and collar transition). */
    let hardStart = 0;
    if (!origin) {
      polyline = [...run.vertices];
      startClear = sized.design.fanOutletMm;
      const collar: DuctLeg = { widthMm: ctx.port.widthMm, heightMm: ctx.port.heightMm };
      const connector = settings.flexibleConnectorAtUnit ? settings.connectorFabricMm + 2 * settings.connectorMetalMm : 0;
      hardStart = connector + (sameLeg(collar, first) ? 0 : model.transitionLengthMm(collar, first).lengthMm) + 50;
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
          const diagonal = diagonalLegMm(model, first, collar, style !== 'wye');
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
        if (along < 150) return false;
        polyline.push({ x: lineStart.x + lineDirection.x * along, y: lineStart.y + lineDirection.y * along });
        polyline.push(...run.vertices.slice(2));
        polyline = simplifyCollinear(polyline);
      }
    }
    const stations = stationsOf(polyline);
    const total = stations[stations.length - 1]!;
    // Elbow zones: each bend takes its setback and neck either side (on the biggest section, conservatively).
    const biggest = sections.reduce((best, section) => (section.widthMm * section.heightMm > best.widthMm * best.heightMm ? section : best), first);
    const bendZones: Array<[number, number]> = [];
    for (let index = 1; index < polyline.length - 1; index += 1) {
      const a = polyline[index - 1]!;
      const b = polyline[index]!;
      const c = polyline[index + 1]!;
      const u = { x: b.x - a.x, y: b.y - a.y };
      const v = { x: c.x - b.x, y: c.y - b.y };
      const cos = (u.x * v.x + u.y * v.y) / ((Math.hypot(u.x, u.y) || 1) * (Math.hypot(v.x, v.y) || 1));
      const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      if (angle < 0.02) continue;
      const reach = model.elbowRadiusMm(biggest) * Math.tan(angle / 2) + settings.elbowNeckMm + 25;
      bendZones.push([stations[index]! - reach, stations[index]! + reach]);
    }
    const end = run.end;
    const endClear = end.kind === 'terminal' ? 450 : end.kind === 'split' ? settings.elbowNeckMm + Math.max(biggest.widthMm, 250) + 50
      : end.kind === 'plenum' ? end.lengthMm + 100 : 100;
    // ---- Take-offs: their windows for the fittings chosen, spread along their legs ----
    const tapPositions: number[] = [];
    const tapHalves: number[] = [];
    const legOf = (station: number) => {
      let leg = 0;
      while (leg < polyline.length - 2 && station > stations[leg + 1]! - 1e-6) leg += 1;
      return leg;
    };
    const byLeg = new Map<number, Array<{ j: number; desired: number; half: number }>>();
    for (let j = 0; j < run.taps.length; j += 1) {
      const tap = run.taps[j]!;
      const childSizing = sized.sizing.get(tap.child.key);
      if (!childSizing) return false;
      const desired = projectOnto(polyline, pointAlong(run, tap.station).point).station;
      const segment = Math.min(j, sections.length - 1);
      const half = tapWindowHalfMm(sizing.tapStyles[j] ?? 'spin-in', childSizing.sections[0]!, sections[segment]!, model);
      tapHalves[j] = half;
      const leg = legOf(desired);
      const list = byLeg.get(leg) ?? [];
      list.push({ j, desired, half });
      byLeg.set(leg, list);
    }
    for (const [leg, items] of byLeg) {
      let from = stations[leg]!;
      let to = stations[leg + 1]!;
      if (leg === 0) from = Math.max(from, hardStart, Math.min(startClear, ...items.map((item) => item.desired - item.half)));
      if (leg === polyline.length - 2) to = Math.min(to, total - endClear);
      for (const [a, b] of bendZones) {
        if (a < from + 1e-6 && b > from) from = b;
        if (b > to - 1e-6 && a < to) to = a;
      }
      const positions = spreadWindows(items, from, to);
      if (!positions) return false;
      items.forEach((item, k) => { tapPositions[item.j] = positions[k]!; });
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
      if (at < lastTapEnd || bendZones.some(([a, b]) => b > at && a < total)) return false;
      changes.push({ at, section: neck });
    }
    changes.sort((a, b) => a.at - b.at);
    for (const change of changes) insertAt(polyline, change.at);
    // Section of each leg: the last change at or before its start.
    const legSizes: DuctLeg[] = [];
    let station = 0;
    for (let index = 1; index < polyline.length; index += 1) {
      let section = first;
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
    runs.push(element);
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
      if (!childOrigin || !realise(tap.child, childOrigin, tapStyle)) return false;
    }
    if (end.kind === 'split') {
      for (const child of end.children) {
        const childSizing = sized.sizing.get(child.key);
        if (!childSizing || child.start.kind !== 'split') return false;
        const splitStyle = sizing.splitStyle ?? 'y';
        const childOrigin = placed(splitOrigin(element, settings, { side: child.start.side, style: splitStyle, vcd: false }, childSizing.sections[0]!));
        if (!childOrigin || !realise(child, childOrigin, splitStyle === 'wye' ? 'wye' : null)) return false;
      }
    }
    if (end.kind === 'plenum') {
      for (let c = 0; c < end.spigots.length; c += 1) {
        const spigot = end.spigots[c]!;
        const childSizing = sized.sizing.get(spigot.child.key);
        if (!childSizing) return false;
        const spigotStyle = sizing.spigotStyles?.[c] ?? 'spin-in';
        const childOrigin = placed(spigotOrigin(element, settings, { face: spigot.face, alongMm: spigot.alongMm, acrossMm: spigot.acrossMm, style: spigotStyle, vcd: true }, childSizing.sections[0]!));
        if (!childOrigin || !realise(spigot.child, childOrigin, spigotStyle)) return false;
      }
    }
    return true;
  };

  if (!realise(sized.design.root, null, null)) return null;
  return { runs, terminalRuns, notes, trunkSections };
}
