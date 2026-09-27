/**
 * Duct supports, derived from the fabrication plan (never stored): trapeze
 * hangers along level ducts, a band and rod on small round ducts, and riser
 * supports, per SMACNA 1995 chapter 4 (see ductSupportTables.ts).
 *
 * Positions: every required support first (S4.1: within 610 mm of each elbow
 * and 1220 mm of each branch intersection; practice: just past the unit's
 * flexible connector and near a free end), then as many more as keep every
 * gap within the spacing. A hanger sits on a straight or transition, clear of
 * its joints (hangers go between flanges); risers are carried by their own
 * angles and by the level hangers next to their elbows.
 *
 * Each hanger is sized from its share of the run: sheet mass plus SMACNA's
 * 4.89 kg/m² insulation allowance plus the bar. Rods are metric, by load
 * (SMACNA's stress applied to the ISO stress area); the bar is the lightest
 * Table 4-3M member for its length and load. Rods run up to the soffit.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { getActivePipeRoutingSettings } from '../pipeRoutingSettings';

import type { DuctFabricationPlan, DuctIssue, DuctPiece } from './ductFabricationPlanner';
import { add, ductLegs, scale, sub } from './ductGeometry';
import { ductBranchesOf } from './ductNetwork';
import type { DuctDesignSettings } from './ductSettings';
import {
  SUPPORT_RULES,
  metricRodFor,
  table41Minimum,
  table42For,
  trapezeMemberFor,
  type MetricRod,
  type TrapezeMember,
} from './ductSupportTables';

export type DuctSupportReason = 'spacing' | 'elbow' | 'branch' | 'unit' | 'end';

export interface DuctHangerRod {
  point: Point2D;
  /** Bottom of the rod (below the bar's nut) and its length up to the soffit. */
  bottomZ: number;
  lengthMm: number;
}

export interface DuctHanger {
  id: string;
  /** A trapeze (two rods and a bar under the duct) or, on a small round duct, one rod and a band. */
  kind: 'trapeze' | 'band';
  stationMm: number;
  legIndex: number;
  /** Plan point on the centreline, and the duct axis there. */
  point: Point2D;
  direction: Point2D;
  reasons: DuctSupportReason[];
  /** Outside size carried (sheet and insulation). */
  outerWidthMm: number;
  outerHeightMm: number;
  /** Underside of the duct (or its insulation): where the bar bears. */
  supportZ: number;
  soffitZ: number;
  rods: DuctHangerRod[];
  rod: MetricRod | null;
  bar: { member: TrapezeMember; lengthMm: number; spanMm: number; allowableKg: number } | null;
  /** Load carried (kg): duct share, insulation allowance and the bar. */
  loadKg: number;
  /** The SMACNA table minimum for this duct and spacing, for reference. */
  smacnaMinimum: string;
  /** Insulated duct: a load-bearing insert between the bar and the insulation. */
  insert: boolean;
}

export interface DuctRiserSupport {
  id: string;
  legIndex: number;
  point: Point2D;
  heading: Point2D;
  z: number;
  member: string;
  /** Each of the pair of angles, fastened to the duct sides. */
  lengthMm: number;
  outerWidthMm: number;
  outerHeightMm: number;
}

export interface DuctSupportPlan {
  elementId: string;
  spacingMm: number;
  soffitZ: number;
  hangers: DuctHanger[];
  risers: DuctRiserSupport[];
  issues: DuctIssue[];
}

const EPSILON = 0.5;
/** Rod thread left below the bar's nut (mm). Practice. */
const ROD_TAIL_MM = 30;
/** Riser angles bear this far on the structure each side (mm). Practice. */
const RISER_BEARING_MM = 150;

interface Interval {
  from: number;
  to: number;
  piece: DuctPiece;
}

interface Requirement {
  windows: Array<{ from: number; to: number; target: number }>;
  reason: DuctSupportReason;
  label: string;
}

function isBreak(piece: DuctPiece): boolean {
  return Boolean(piece.vertical || piece.frame);
}

export function resolveSoffitZ(settings: Pick<DuctDesignSettings, 'soffitMm'>): number {
  return settings.soffitMm ?? getActivePipeRoutingSettings().ceilingLimitMm;
}

export function planDuctSupports(
  plan: DuctFabricationPlan,
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
  soffitZ: number = resolveSoffitZ(settings),
): DuctSupportPlan {
  const issues: DuctIssue[] = [];
  const spec = plan.spec;
  const round = spec.legs.some((leg) => leg.diameterMm !== undefined);
  const spacing = round ? Math.min(settings.hangerSpacingMm, SUPPORT_RULES.roundMaxSpacingMm) : settings.hangerSpacingMm;
  const insulation = plan.insulationMm;
  const pieces = plan.pieces;
  const runEnd = plan.polylineLengthMm;

  // Where a hanger may go: level straights and transitions, clear of their joints.
  const allowed: Interval[] = [];
  for (const piece of pieces) {
    if (isBreak(piece) || (piece.kind !== 'straight' && piece.kind !== 'transition')) continue;
    const length = piece.stationEndMm - piece.stationStartMm;
    const clear = settings.hangerJointClearanceMm;
    if (length >= 2 * clear + EPSILON) allowed.push({ from: piece.stationStartMm + clear, to: piece.stationEndMm - clear, piece });
    else if (length >= 100) {
      const mid = (piece.stationStartMm + piece.stationEndMm) / 2;
      allowed.push({ from: mid, to: mid, piece });
    }
  }
  const nearestAllowed = (target: number, from: number, to: number): number | null => {
    let best: number | null = null;
    for (const interval of allowed) {
      const lo = Math.max(interval.from, from);
      const hi = Math.min(interval.to, to);
      if (lo > hi + 1e-9) continue;
      const candidate = Math.min(hi, Math.max(lo, target));
      if (best === null || Math.abs(candidate - target) < Math.abs(best - target)) best = candidate;
    }
    return best;
  };

  // ---- Required supports. ----
  const requirements: Requirement[] = [];
  const within = (from: number, to: number, target: number) => ({ from, to, target });
  const elbowReach = SUPPORT_RULES.elbowMaxMm;
  for (const piece of pieces) {
    const a = piece.stationStartMm;
    const b = piece.stationEndMm;
    if (piece.kind === 'elbow' && !piece.frame) {
      // S4.1 asks for one support within 610 mm of each elbow; practice supports both sides.
      requirements.push({ reason: 'elbow', label: `elbow ${piece.mark}`, windows: [within(a - elbowReach, a, a - 300)] });
      requirements.push({ reason: 'elbow', label: `elbow ${piece.mark}`, windows: [within(b, b + elbowReach, b + 300)] });
    } else if (piece.kind === 'elbow' && piece.frame && piece.elbow) {
      // At a riser only the level side can take a hanger.
      const levelStart = Math.abs(piece.elbow.inDirection.x) > 0.5;
      requirements.push({ reason: 'elbow', label: `elbow ${piece.mark}`,
        windows: [levelStart ? within(a - elbowReach, a, a - 300) : within(b, b + elbowReach, b + 300)] });
    } else if (piece.kind === 'offset') {
      // An offset is two bends: one support near each end.
      requirements.push({ reason: 'elbow', label: `offset ${piece.mark}`, windows: [within(a - elbowReach, a, a - 300)] });
      requirements.push({ reason: 'elbow', label: `offset ${piece.mark}`, windows: [within(b, b + elbowReach, b + 300)] });
    }
  }
  let legStart = 0;
  const legStartStation = ductLegs(spec).map((leg) => {
    const start = legStart;
    legStart += leg.lengthMm;
    return start;
  });
  const branchReach = SUPPORT_RULES.branchMaxMm;
  for (const branch of ductBranchesOf(plan.elementId, scene)) {
    if (branch.start.kind !== 'tap') continue;
    const station = (legStartStation[branch.start.legIndex] ?? 0) + branch.start.stationMm;
    requirements.push({ reason: 'branch', label: 'branch take-off', windows: [within(station - branchReach, station + branchReach, station)] });
  }
  if (spec.end.kind === 'split') {
    requirements.push({ reason: 'branch', label: 'split', windows: [within(runEnd - branchReach, runEnd, runEnd - 300)] });
  } else {
    requirements.push({ reason: 'end', label: 'run end', windows: [within(runEnd - elbowReach, runEnd, runEnd - 300)] });
  }
  const startPiecesEnd = pieces.filter((piece) => piece.kind === 'connector' || piece.kind === 'takeoff' || piece.kind === 'damper')
    .reduce((end, piece) => Math.max(end, piece.stationEndMm), 0);
  if (spec.start.kind === 'unit-port') {
    requirements.push({ reason: 'unit', label: 'unit connection',
      windows: [within(startPiecesEnd, startPiecesEnd + elbowReach, startPiecesEnd + settings.hangerFromUnitMm)] });
  } else if (spec.start.kind === 'tap' || spec.start.kind === 'split-branch') {
    requirements.push({ reason: 'branch', label: 'branch start', windows: [within(0, branchReach, startPiecesEnd + 300)] });
  } else {
    requirements.push({ reason: 'end', label: 'run start', windows: [within(0, elbowReach, 300)] });
  }

  const chosen: Array<{ station: number; reasons: Set<DuctSupportReason> }> = [];
  for (const requirement of requirements) {
    const existing = chosen.find((support) => requirement.windows.some((window) => support.station >= window.from - EPSILON && support.station <= window.to + EPSILON));
    if (existing) {
      existing.reasons.add(requirement.reason);
      continue;
    }
    let best: number | null = null;
    let bestMiss = Infinity;
    for (const window of requirement.windows) {
      const candidate = nearestAllowed(window.target, window.from, window.to);
      if (candidate !== null && Math.abs(candidate - window.target) < bestMiss) {
        best = candidate;
        bestMiss = Math.abs(candidate - window.target);
      }
    }
    if (best === null) {
      const reach = requirement.reason === 'branch' ? branchReach : elbowReach;
      issues.push({ code: 'DU_SUPPORT_RULE', severity: 'warning',
        message: `No straight within ${reach} mm of the ${requirement.label} to hang it from (${requirement.reason === 'unit' || requirement.reason === 'end' ? 'project practice' : 'SMACNA S4.1'}).` });
      continue;
    }
    chosen.push({ station: best, reasons: new Set([requirement.reason]) });
  }

  // ---- Spacing: fill every gap along each level stretch (risers break the stretches). ----
  const stretches: Array<{ from: number; to: number }> = [];
  let current: { from: number; to: number } | null = null;
  for (const piece of pieces) {
    if (isBreak(piece)) {
      current = null;
      continue;
    }
    if (!current) {
      current = { from: piece.stationStartMm, to: piece.stationEndMm };
      stretches.push(current);
    } else {
      current.to = Math.max(current.to, piece.stationEndMm);
    }
  }
  // Spacing is measured along the duct that can carry a hanger: an elbow or offset is held by
  // the supports within 610 mm of its ends (S4.1), so its own length does not count.
  const fittingSpans = pieces.filter((piece) => !isBreak(piece) && (piece.kind === 'elbow' || piece.kind === 'offset'))
    .map((piece) => ({ from: piece.stationStartMm, to: piece.stationEndMm }))
    .sort((a, b) => a.from - b.from);
  const straightLength = (station: number) => station - fittingSpans.reduce((total, span) => total + Math.min(Math.max(station - span.from, 0), span.to - span.from), 0);
  const stationAt = (length: number) => {
    let station = length;
    for (const span of fittingSpans) {
      if (span.from <= station + EPSILON) station += span.to - span.from;
      else break;
    }
    return station;
  };
  const spanOf = (a: number, b: number) => straightLength(b) - straightLength(a);
  for (const stretch of stretches) {
    const inside = () => chosen.filter((support) => support.station >= stretch.from - EPSILON && support.station <= stretch.to + EPSILON)
      .sort((a, b) => a.station - b.station);
    if (inside().length === 0) {
      const middle = nearestAllowed((stretch.from + stretch.to) / 2, stretch.from, stretch.to);
      if (middle !== null) chosen.push({ station: middle, reasons: new Set(['spacing']) });
    }
    const supports = inside();
    for (let index = 1; index < supports.length; index += 1) {
      const a = supports[index - 1]!.station;
      const b = supports[index]!.station;
      if (spanOf(a, b) <= spacing + EPSILON) continue;
      // Even spacing first, then a greedy pass for anything the joints pushed apart.
      const count = Math.ceil(spanOf(a, b) / spacing) - 1;
      const added: number[] = [];
      for (let k = 1; k <= count; k += 1) {
        const target = stationAt(straightLength(a) + (spanOf(a, b) * k) / (count + 1));
        const point = nearestAllowed(target, a + EPSILON, b - EPSILON);
        if (point !== null && !added.some((value) => Math.abs(value - point) < EPSILON)) added.push(point);
      }
      const all = [a, ...added.sort((x, y) => x - y), b];
      const repaired: number[] = [];
      for (let k = 1; k < all.length; k += 1) {
        let cursor = all[k - 1]!;
        while (spanOf(cursor, all[k]!) > spacing + EPSILON) {
          const reach = stationAt(straightLength(cursor) + spacing);
          const next = nearestAllowed(reach, cursor + EPSILON, reach);
          if (next === null || next <= cursor + EPSILON) {
            issues.push({ code: 'DU_SUPPORT_RULE', severity: 'warning',
              message: `A ${Math.round(spanOf(cursor, all[k]!))} mm stretch has no straight to hang from within the ${spacing} mm spacing (SMACNA Table 4-1M).` });
            break;
          }
          repaired.push(next);
          cursor = next;
        }
        if (k < all.length - 1) repaired.push(all[k]!);
      }
      for (const station of repaired) {
        if (!chosen.some((support) => Math.abs(support.station - station) < EPSILON)) chosen.push({ station, reasons: new Set(['spacing']) });
      }
    }
  }
  chosen.sort((a, b) => a.station - b.station);

  // ---- Size each hanger from its share of the run. ----
  const pieceMass = (from: number, to: number): { kg: number; insulationKg: number } => {
    let kg = 0;
    let insulationKg = 0;
    for (const piece of pieces) {
      const length = piece.stationEndMm - piece.stationStartMm;
      const overlap = length > EPSILON
        ? Math.max(0, Math.min(to, piece.stationEndMm) - Math.max(from, piece.stationStartMm)) / length
        : piece.stationStartMm >= from && piece.stationStartMm <= to ? 1 : 0;
      if (overlap <= 0) continue;
      kg += piece.massKg * overlap;
      const sheet = piece.sheetThicknessMm ?? 1;
      const girth = piece.diameterMm !== undefined
        ? Math.PI * (piece.diameterMm + 2 * sheet)
        : 2 * (piece.widthMm + piece.heightMm + 4 * sheet);
      insulationKg += SUPPORT_RULES.insulationAllowanceKgPerM2 * (girth / 1000) * ((length > EPSILON ? length : 0) * overlap / 1000);
    }
    return { kg, insulationKg };
  };
  let rodIssue = false;
  let soffitIssue = false;
  const hangers: DuctHanger[] = chosen.map((support, index) => {
    const station = support.station;
    const interval = allowed.find((candidate) => station >= candidate.piece.stationStartMm - EPSILON && station <= candidate.piece.stationEndMm + EPSILON)!;
    const piece = interval.piece;
    const length = Math.max(EPSILON, piece.stationEndMm - piece.stationStartMm);
    const f = Math.min(1, Math.max(0, (station - piece.stationStartMm) / length));
    const sheet = piece.sheetThicknessMm ?? 1;
    const isRound = piece.diameterMm !== undefined;
    const width = isRound ? piece.diameterMm! + ((piece.endDiameterMm ?? piece.diameterMm!) - piece.diameterMm!) * f : Math.max(piece.widthMm, piece.endWidthMm);
    const height = isRound ? width : Math.max(piece.heightMm, piece.endHeightMm);
    const outerWidth = width + 2 * sheet + 2 * insulation;
    const outerHeight = height + 2 * sheet + 2 * insulation;
    const point = add(piece.start, scale(sub(piece.end, piece.start), f));
    const direction = piece.direction;
    const n = { x: -direction.y, y: direction.x };
    const supportZ = piece.bottomZ - sheet - insulation;
    const previous = chosen[index - 1]?.station ?? 0;
    const next = chosen[index + 1]?.station ?? runEnd;
    const share = pieceMass(index === 0 ? 0 : (previous + station) / 2, index === chosen.length - 1 ? runEnd : (station + next) / 2);
    const roundRow = isRound ? table42For(width) : null;
    const band = isRound && (roundRow?.rods ?? 1) === 1;
    let bar: DuctHanger['bar'] = null;
    let loadKg = share.kg + share.insulationKg;
    let rods: DuctHangerRod[];
    if (band) {
      const top = supportZ + outerHeight;
      rods = [{ point, bottomZ: top, lengthMm: soffitZ - top }];
    } else {
      const span = outerWidth + 2 * settings.hangerRodOffsetMm;
      const lengthMm = span + 2 * settings.trapezeOverhangMm;
      let member = trapezeMemberFor(span, loadKg);
      if (member) {
        loadKg += (member.member.massKgPerM * lengthMm) / 1000;
        member = trapezeMemberFor(span, loadKg) ?? member;
        bar = { member: member.member, lengthMm, spanMm: span, allowableKg: member.allowableKg };
      } else {
        issues.push({ code: 'DU_SUPPORT_LOAD', severity: 'error', point,
          message: `Trapeze ${Math.round(span)} mm carrying ${Math.round(loadKg)} kg is beyond SMACNA Table 4-3M: special analysis.` });
      }
      const barBottom = supportZ - (bar?.member.legMm ?? 40);
      rods = [1, -1].map((side) => ({
        point: add(point, scale(n, side * span / 2)),
        bottomZ: barBottom - ROD_TAIL_MM,
        lengthMm: soffitZ - (barBottom - ROD_TAIL_MM),
      }));
    }
    const perRod = loadKg / rods.length;
    const rod = metricRodFor(perRod, settings.minimumRod);
    if (!rod && !rodIssue) {
      rodIssue = true;
      issues.push({ code: 'DU_SUPPORT_LOAD', severity: 'error', point, message: `${Math.round(perRod)} kg per rod is beyond an M16 rod: special analysis.` });
    }
    if (supportZ + outerHeight >= soffitZ - EPSILON && !soffitIssue) {
      soffitIssue = true;
      issues.push({ code: 'DU_SOFFIT', severity: 'error', point,
        message: `The duct top (${Math.round(supportZ + outerHeight)}) is at or above the soffit (${Math.round(soffitZ)}): no room to hang it.` });
    }
    let smacnaMinimum: string;
    if (isRound) {
      smacnaMinimum = roundRow ? `Table 4-2: ${roundRow.rods === 2 ? 'two' : 'one'} ⌀${roundRow.rodMm} rod${roundRow.rods === 2 ? 's' : ''} or strap ${roundRow.strap}` : 'Table 4-2: special analysis';
    } else {
      const widest = Math.max(width, height);
      const halfPerimeter = widest > SUPPORT_RULES.wideSideMm ? Math.max(width + height, 1.25 * widest) : width + height;
      const minimum = table41Minimum(halfPerimeter, spacing);
      smacnaMinimum = minimum ? `Table 4-1M per pair: ⌀${minimum.rodMm} rod${minimum.strap ? ` or strap ${minimum.strap}` : ''}` : 'Table 4-1M: special analysis';
    }
    return {
      id: `${plan.elementId}:H${index + 1}`, kind: band ? 'band' : 'trapeze', stationMm: station, legIndex: piece.legIndex,
      point, direction, reasons: [...support.reasons], outerWidthMm: outerWidth, outerHeightMm: outerHeight,
      supportZ, soffitZ, rods, rod, bar, loadKg, smacnaMinimum, insert: insulation > 0 && !band,
    };
  });

  // ---- Risers: angle pairs at the riser interval (§4.2.10). ----
  const risers: DuctRiserSupport[] = [];
  for (const leg of ductLegs(spec)) {
    if (!leg.vertical || leg.lengthMm < settings.riserSupportIntervalMm) continue;
    const section = spec.legs[leg.index]!;
    const sheet = plan.constructionByLeg[leg.index]?.sheetThicknessMm ?? 1;
    const outerWidth = section.widthMm + 2 * sheet + 2 * insulation;
    const bottom = Math.min(leg.startCentreZ, leg.endCentreZ);
    const top = Math.max(leg.startCentreZ, leg.endCentreZ);
    for (let z = bottom + settings.riserSupportIntervalMm; z <= top - 300; z += settings.riserSupportIntervalMm) {
      risers.push({
        id: `${plan.elementId}:R${risers.length + 1}`, legIndex: leg.index, point: { x: leg.start.x, y: leg.start.y }, heading: leg.direction, z,
        // Practice sizes: SMACNA asks for care fastening to the sheet over 762 mm wide.
        member: outerWidth <= 762 ? 'L40×4' : 'L50×5',
        lengthMm: outerWidth + 2 * RISER_BEARING_MM,
        outerWidthMm: outerWidth, outerHeightMm: section.heightMm + 2 * sheet + 2 * insulation,
      });
    }
  }

  return { elementId: plan.elementId, spacingMm: spacing, soffitZ, hangers, risers, issues };
}

const SUPPORT_CACHE = new WeakMap<DuctFabricationPlan, { settings: DuctDesignSettings; soffitZ: number; supports: DuctSupportPlan }>();

/** Memoised per plan (a plan already changes with its branches), settings and soffit. */
export function getDuctSupportPlan(plan: DuctFabricationPlan, scene: readonly HvacElement[], settings: DuctDesignSettings): DuctSupportPlan {
  const soffitZ = resolveSoffitZ(settings);
  const cached = SUPPORT_CACHE.get(plan);
  if (cached && cached.settings === settings && cached.soffitZ === soffitZ) return cached.supports;
  const supports = planDuctSupports(plan, scene, settings, soffitZ);
  SUPPORT_CACHE.set(plan, { settings, soffitZ, supports });
  return supports;
}
