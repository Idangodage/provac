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

import { tapAttachment } from './ductBranches';
import { getDuctRunPlan, type DuctFabricationPlan, type DuctIssue, type DuctPiece } from './ductFabricationPlanner';
import { FLEX_RULES, flexPointAt, flexSupportStations } from './ductFlex';
import { add, ductLegs, scale, sub } from './ductGeometry';
import { ductBranchesOf } from './ductNetwork';
import type { DuctDesignSettings } from './ductSettings';
import {
  SUPPORT_RULES,
  TABLE_4_3M_MEMBERS,
  metricRodFor,
  table41Minimum,
  table42For,
  trapezeMemberFor,
  type MetricRod,
  type TrapezeMember,
} from './ductSupportTables';
import type { DuctPoint3 } from './ductTypes';

export type DuctSupportReason = 'spacing' | 'elbow' | 'branch' | 'unit' | 'end';

export interface DuctHangerRod {
  point: Point2D;
  /** Bottom of the rod (below the bar's nut) and its length up to the soffit. */
  bottomZ: number;
  lengthMm: number;
}

export interface DuctHanger {
  id: string;
  /**
   * A trapeze (two rods and a bar under the duct), on a small round duct one
   * rod and a band, or on a flexible runout a broad strap on a hanger wire.
   */
  kind: 'trapeze' | 'band' | 'strap';
  stationMm: number;
  legIndex: number;
  /** Plan point on the centreline, and the duct axis there. */
  point: Point2D;
  direction: Point2D;
  /** Flexible straps are square to the local 3D centreline, including drops. */
  strapFrame?: { centre: DuctPoint3; axis: DuctPoint3 };
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
  /** Hanger wires of the terminal this run serves, when terminals hang on their own (S3.40). */
  terminalWires: Array<{ terminalId: string; count: number; lengthMm: number }>;
  issues: DuctIssue[];
}

const EPSILON = 0.5;
/** Rod thread left below the bar's nut (mm). Practice. */
const ROD_TAIL_MM = 30;
/** Riser angles bear this far on the structure each side (mm). Practice. */
const RISER_BEARING_MM = 150;
/** Surface of the rendered thin band outside the duct/jacket (mm). */
export const DUCT_BAND_RADIAL_OFFSET_MM = 1.5;
/** Reserve the widest table angle's half length along the duct at take-offs. */
const HANGER_HALF_LENGTH_MM = Math.max(...TABLE_4_3M_MEMBERS.map((member) => member.legMm)) / 2;

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
  return Boolean(piece.vertical || piece.frame || piece.kind === 'flex');
}

/** A directly attached collar/damper can be carried with its supported parent. */
function attachedRunoutStub(plan: DuctFabricationPlan): DuctPiece[] | null {
  const flex = plan.pieces.find((piece) => piece.kind === 'flex');
  if (plan.spec.start.kind !== 'tap' || !flex || flex.stationStartMm > SUPPORT_RULES.branchMaxMm
    || plan.pieces.some((piece) => piece.vertical || piece.frame || !['takeoff', 'damper', 'flex'].includes(piece.kind))) return null;
  return plan.pieces.filter((piece) => piece.kind !== 'flex');
}

function insulationAllowanceKg(piece: DuctPiece): number {
  const sheet = piece.sheetThicknessMm ?? 1;
  const girth = piece.diameterMm !== undefined
    ? Math.PI * (piece.diameterMm + 2 * sheet)
    : 2 * (piece.widthMm + piece.heightMm + 4 * sheet);
  return SUPPORT_RULES.insulationAllowanceKgPerM2 * (girth / 1000)
    * Math.max(0, piece.stationEndMm - piece.stationStartMm) / 1000;
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
  // A runout is carried by its own straps; the rigid run ends where it starts.
  const runEnd = pieces.find((piece) => piece.kind === 'flex')?.stationStartMm ?? plan.polylineLengthMm;
  let legStart = 0;
  const legStartStation = ductLegs(spec).map((leg) => {
    const start = legStart;
    legStart += leg.lengthMm;
    return start;
  });
  const branches = ductBranchesOf(plan.elementId, scene);
  const takeoffWindows: Array<{ from: number; to: number }> = [];
  const attachedStubLoads: Array<{ station: number; kg: number; insulationKg: number }> = [];
  for (const branch of branches) {
    if (branch.start.kind !== 'tap' || !branch.spec.legs[0]) continue;
    const attachment = tapAttachment(spec, branch.start, branch.spec.legs[0],
      plan.constructionByLeg[branch.start.legIndex]?.sheetThicknessMm ?? 1, settings);
    if (!attachment) continue;
    const start = legStartStation[branch.start.legIndex]!;
    // The parent rod passes beside the duct wall. Keep its whole support clear
    // of the collar, including a shoe's upstream lead-in or a conical mouth.
    // This is a geometry/project-clearance rule, not a new SMACNA spacing rule.
    const clearance = Math.max(settings.hangerJointClearanceMm, settings.tapWindowMarginMm, HANGER_HALF_LENGTH_MM + insulation);
    takeoffWindows.push({ from: start + attachment.openingFromMm - clearance, to: start + attachment.openingToMm + clearance });
    const branchPlan = getDuctRunPlan(branch.element, scene, settings);
    const stub = branchPlan && attachedRunoutStub(branchPlan);
    if (stub) attachedStubLoads.push({
      station: start + branch.start.stationMm,
      kg: stub.reduce((sum, piece) => sum + piece.massKg, 0),
      insulationKg: stub.reduce((sum, piece) => sum + insulationAllowanceKg(piece), 0),
    });
  }

  // Where a hanger may go: level straights and transitions, clear of joints and take-offs.
  const allowed: Interval[] = [];
  for (const piece of pieces) {
    if (isBreak(piece) || (piece.kind !== 'straight' && piece.kind !== 'transition' && piece.kind !== 'plenum')) continue;
    const length = piece.stationEndMm - piece.stationStartMm;
    const clear = settings.hangerJointClearanceMm;
    let spans: Interval[] = [];
    if (length >= 2 * clear + EPSILON) spans.push({ from: piece.stationStartMm + clear, to: piece.stationEndMm - clear, piece });
    else if (length >= 100) {
      const mid = (piece.stationStartMm + piece.stationEndMm) / 2;
      spans.push({ from: mid, to: mid, piece });
    }
    for (const window of takeoffWindows) {
      spans = spans.flatMap((span) => {
        if (window.to < span.from || window.from > span.to) return [span];
        const remaining: Interval[] = [];
        if (span.from < window.from) remaining.push({ ...span, to: window.from });
        if (span.to > window.to) remaining.push({ ...span, from: window.to });
        return remaining;
      });
    }
    allowed.push(...spans);
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

  let carriedByParent = false;
  if (spec.start.kind === 'tap' && attachedRunoutStub(plan)) {
    const parentId = spec.start.parentRunId;
    const parent = scene.find((element) => element.id === parentId);
    const parentPlan = parent && getDuctRunPlan(parent, scene, settings);
    // A supporting parent must have a rigid hanger seat. This also prevents
    // recursive delegation through malformed cycles of collar-only branches.
    if (parentPlan?.status === 'ok' && parentPlan.pieces.some((piece) => !isBreak(piece)
      && ['straight', 'transition', 'plenum'].includes(piece.kind))) {
      const parentSupports = cachedSupports(parentPlan, scene, settings, soffitZ);
      const station = ductLegs(parentPlan.spec).slice(0, spec.start.legIndex)
        .reduce((sum, leg) => sum + leg.lengthMm, spec.start.stationMm);
      carriedByParent = !parentSupports.issues.some((issue) => issue.severity === 'error')
        && parentSupports.hangers.some((hanger) => hanger.kind !== 'strap'
          && Math.abs(hanger.stationMm - station) <= SUPPORT_RULES.branchMaxMm
          && hanger.rods.every((rod) => rod.lengthMm > 0));
    }
  }

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
  const branchReach = SUPPORT_RULES.branchMaxMm;
  for (const branch of branches) {
    if (branch.start.kind !== 'tap') continue;
    const station = (legStartStation[branch.start.legIndex] ?? 0) + branch.start.stationMm;
    requirements.push({ reason: 'branch', label: 'branch take-off', windows: [within(station - branchReach, station + branchReach, station)] });
  }
  if (spec.end.kind === 'split') {
    requirements.push({ reason: 'branch', label: 'split', windows: [within(runEnd - branchReach, runEnd, runEnd - 300)] });
  } else if (!carriedByParent) {
    requirements.push({ reason: 'end', label: 'run end', windows: [within(runEnd - elbowReach, runEnd, runEnd - 300)] });
  }
  const startPiecesEnd = pieces.filter((piece) => piece.kind === 'connector' || piece.kind === 'takeoff' || piece.kind === 'damper')
    .reduce((end, piece) => Math.max(end, piece.stationEndMm), 0);
  if (spec.start.kind === 'unit-port') {
    requirements.push({ reason: 'unit', label: 'unit connection',
      windows: [within(startPiecesEnd, startPiecesEnd + elbowReach, startPiecesEnd + settings.hangerFromUnitMm)] });
  } else if ((spec.start.kind === 'tap' || spec.start.kind === 'split-branch') && !carriedByParent) {
    requirements.push({ reason: 'branch', label: 'branch start', windows: [within(0, branchReach, startPiecesEnd + 300)] });
  } else if (!carriedByParent) {
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
        message: `No clear support position within ${reach} mm of the ${requirement.label}; check straight length, joints and take-offs (${requirement.reason === 'unit' || requirement.reason === 'end' ? 'project practice' : 'SMACNA S4.1'}).` });
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
      insulationKg += insulationAllowanceKg(piece) * overlap;
    }
    for (const stub of attachedStubLoads) {
      if (stub.station < from || stub.station >= to) continue;
      kg += stub.kg;
      insulationKg += stub.insulationKg;
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
      rods = [{ point, bottomZ: top, lengthMm: Math.max(0, soffitZ - top) }];
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
        lengthMm: Math.max(0, soffitZ - (barBottom - ROD_TAIL_MM)),
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

  // ---- Runouts: broad straps at the shared flex support spacing, connections counting. ----
  for (const piece of pieces) {
    if (piece.kind !== 'flex' || !piece.flex) continue;
    const flex = piece.flex;
    const radius = piece.widthMm / 2 + flex.jacketMm;
    for (const station of flexSupportStations(piece.lengthMm)) {
      const at = flexPointAt(flex, station);
      const behind = flexPointAt(flex, Math.max(0, station - 10));
      const ahead = flexPointAt(flex, Math.min(piece.lengthMm, station + 10));
      const delta = { x: ahead.x - behind.x, y: ahead.y - behind.y, z: ahead.z - behind.z };
      const length = Math.hypot(delta.x, delta.y, delta.z);
      const axis = length > 1e-6
        ? { x: delta.x / length, y: delta.y / length, z: delta.z / length } : { x: 1, y: 0, z: 0 };
      const planLength = Math.hypot(axis.x, axis.y);
      const direction = planLength > 1e-6 ? { x: axis.x / planLength, y: axis.y / planLength } : { x: 1, y: 0 };
      // Highest point in the strap plane. A vertical drop has no unique top;
      // attach at its side so the vertical wire stays outside the flex core.
      const up = planLength > 1e-6
        ? { x: -axis.z * direction.x, y: -axis.z * direction.y, z: planLength }
        : { x: 1, y: 0, z: 0 };
      const bandRadius = radius + DUCT_BAND_RADIAL_OFFSET_MM;
      const wirePoint = { x: at.x + up.x * bandRadius, y: at.y + up.y * bandRadius };
      const top = at.z + up.z * bandRadius;
      hangers.push({
        id: `${plan.elementId}:H${hangers.length + 1}`, kind: 'strap', stationMm: piece.stationStartMm + station, legIndex: piece.legIndex,
        point: { x: at.x, y: at.y }, direction, strapFrame: { centre: at, axis }, reasons: ['spacing'],
        outerWidthMm: 2 * radius, outerHeightMm: 2 * radius, supportZ: at.z - radius * planLength, soffitZ,
        rods: [{ point: wirePoint, bottomZ: top, lengthMm: Math.max(0, soffitZ - top) }],
        rod: null, bar: null, loadKg: 0,
        smacnaMinimum: `ADC: strap ≥ ${FLEX_RULES.minStrapWidthMm} mm at ≤ ${FLEX_RULES.maxSupportSpacingMm / 1000} m`, insert: false,
      });
    }
  }

  // ---- Terminal hanger wires, when terminals hang on their own rather than on the ceiling grid (S3.40). ----
  const terminalWires: DuctSupportPlan['terminalWires'] = [];
  if (settings.terminalHangerWires && spec.end.kind === 'terminal') {
    const terminal = scene.find((element) => element.id === (spec.end as { terminalId: string }).terminalId);
    if (terminal) terminalWires.push({ terminalId: terminal.id, count: 2, lengthMm: Math.max(0, soffitZ - (terminal.elevation + terminal.height)) });
  }

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

  return { elementId: plan.elementId, spacingMm: spacing, soffitZ, hangers, risers, terminalWires, issues };
}

const SUPPORT_CACHE = new WeakMap<DuctFabricationPlan, { scene: readonly HvacElement[]; settings: DuctDesignSettings; soffitZ: number; supports: DuctSupportPlan }>();

/** Include the scene: a runout's supporting parent can change without changing its own plan. */
export function getDuctSupportPlan(plan: DuctFabricationPlan, scene: readonly HvacElement[], settings: DuctDesignSettings): DuctSupportPlan {
  return cachedSupports(plan, scene, settings, resolveSoffitZ(settings));
}

function cachedSupports(plan: DuctFabricationPlan, scene: readonly HvacElement[], settings: DuctDesignSettings, soffitZ: number): DuctSupportPlan {
  const cached = SUPPORT_CACHE.get(plan);
  if (cached && cached.scene === scene && cached.settings === settings && cached.soffitZ === soffitZ) return cached.supports;
  const supports = planDuctSupports(plan, scene, settings, soffitZ);
  SUPPORT_CACHE.set(plan, { scene, settings, soffitZ, supports });
  return supports;
}
