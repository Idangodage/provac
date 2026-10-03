/**
 * Pressure along each terminal's path through a duct system: friction in
 * every piece at the airflow it carries (the terminals downstream of it),
 * plus each fitting's loss coefficient × velocity pressure, plus the
 * terminal's own drop. The largest path is the index path; supply + return
 * index paths are the external static pressure the unit's fan must deliver.
 * The gap between a path and the index path is what its damper throttles to
 * balance.
 *
 * Friction is the Darcy–Weisbach model in ductSizing.ts. The fitting losses
 * respond to size and flow, so an optimiser can trade them:
 *  - a take-off's branch passage by the Idelchik form ζ = A′·[1 + r² − 2r·cos α]
 *    on the main's (combined) velocity pressure, r = v_branch / v_main, α the
 *    angle the branch leaves at, A′ by fitting type;
 *  - the main's straight-through passage at each take-off, ζ = 0.4·(1 − v_s/v_c)²;
 *  - elbows by R/W (R/D) and angle; transitions by their included angle.
 * The coefficients are practice values (Idelchik's forms, calibrated to the
 * usual ASHRAE Duct Fitting Database order), not transcribed from either; the
 * result is an estimate for checking and optimising the fan duty, not a
 * certified calculation.
 */
import type { DuctElbow, DuctFabricationPlan, DuctPiece } from './ductFabricationPlanner';
import { ductLegs } from './ductGeometry';
import type { DuctDesignSettings } from './ductSettings';
import { frictionPaPerM, velocityMs, velocityPressurePa } from './ductSizing';
import type { DuctLeg, DuctPoint3, DuctService, DuctSplitStyle, DuctTapStyle } from './ductTypes';

/** Loss coefficients (on the velocity pressure of the section named). Practice. */
export const FITTING_LOSS_COEFFICIENTS = {
  /** Flexible connector at the unit. */
  connector: 0.1,
  /** Radius elbow R/W 1.5 (rectangular) or gored R/D 1.5 (round). */
  elbowRadius: 0.2,
  /** Square elbow with turning vanes. */
  elbowVaned: 0.3,
  /** Offset (two bends). */
  offset: 0.3,
  /** Reducer / transition within the taper limits. */
  transition: 0.1,
  /** Spin-in take-off off a trunk side wall, on the branch velocity. */
  takeoffTrunk: 1.0,
  /** Spigot out of a plenum box (entry from still air), on the branch velocity. */
  takeoffPlenum: 0.7,
  /** Volume damper, wide open. */
  damper: 0.2,
  /** Duct into a plenum box: the velocity pressure is lost. */
  plenumEntry: 1.0,
  /** Y split, on each outlet's velocity. */
  split: 0.3,
  /** Bullhead tee with turning vanes, on each outlet's velocity. */
  bullhead: 0.5,
  /** Square-to-round, over the transition's own loss. */
  shapeChange: 0.05,
} as const;

/** Idelchik's A′ by take-off type (practice): C_branch ≈ 2A′ at equal velocities for a 90° branch. */
export const TAKEOFF_A_PRIME: Record<DuctTapStyle, number> = {
  straight: 0.55,
  'round-tee': 0.55,
  'spin-in': 0.5,
  conical: 0.4,
  'round-conical': 0.4,
  'shoe-45': 0.35,
  'round-lateral': 0.6,
};

/** The angle a take-off's branch leaves the main at (deg). */
export function takeoffAngleDeg(style: DuctTapStyle): number {
  return style === 'round-lateral' ? 45 : 90;
}

/**
 * Loss (Pa) from the main into a branch: ζ = A′·[1 + r² − 2r·cos α] on the
 * main's velocity pressure (Idelchik form, practice).
 */
export function takeoffBranchLossPa(style: DuctTapStyle | 'wye', branchVelocityMs: number, mainVelocityMs: number): number {
  if (mainVelocityMs <= 1e-9) return FITTING_LOSS_COEFFICIENTS.takeoffTrunk * velocityPressurePa(branchVelocityMs);
  const r = branchVelocityMs / mainVelocityMs;
  const aPrime = style === 'wye' ? 0.6 : TAKEOFF_A_PRIME[style];
  const alpha = ((style === 'wye' ? 45 : takeoffAngleDeg(style)) * Math.PI) / 180;
  const zeta = aPrime * Math.max(0, 1 + r * r - 2 * r * Math.cos(alpha));
  return zeta * velocityPressurePa(mainVelocityMs);
}

/** Loss (Pa) in the main's straight-through passage at a take-off: ζ = 0.4·(1 − v_s/v_c)² on v_c (practice). */
export function mainPassageLossPa(downstreamVelocityMs: number, upstreamVelocityMs: number): number {
  if (upstreamVelocityMs <= 1e-9) return 0;
  const ratio = Math.min(1, downstreamVelocityMs / upstreamVelocityMs);
  return 0.4 * (1 - ratio) ** 2 * velocityPressurePa(upstreamVelocityMs);
}

/** Elbow coefficient by R/W (R/D) and angle (practice; square vaned 0.3). */
export function elbowCoefficient(style: DuctElbow['style'], radiusRatio: number, angleDeg: number): number {
  if (style === 'square-vaned') return FITTING_LOSS_COEFFICIENTS.elbowVaned * Math.min(1, angleDeg / 90);
  const points: Array<[number, number]> = [[0.5, 0.9], [0.75, 0.45], [1, 0.3], [1.5, 0.2], [2, 0.18]];
  const ratio = Math.max(points[0]![0], Math.min(points[points.length - 1]![0], radiusRatio));
  let k = points[points.length - 1]![1];
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1]!;
    const [x2, y2] = points[index]!;
    if (ratio <= x2) {
      k = y1 + ((ratio - x1) / (x2 - x1)) * (y2 - y1);
      break;
    }
  }
  // Gored (mitred-segment) elbows carry a little more than a smooth one; the angle scales the loss.
  return k * (style === 'gored' ? 1.15 : 1) * Math.pow(angleDeg / 90, 0.7);
}

/** Transition coefficient on the downstream velocity, by its included angle and sense (practice). */
export function transitionCoefficient(includedDeg: number, expanding: boolean): number {
  if (!expanding) return 0.05;
  return Math.min(1, 0.1 + 0.6 * Math.pow(Math.max(0, includedDeg) / 60, 1.5));
}

/** Split outlet loss on the outlet velocity (practice). */
export function splitOutletLossPa(style: DuctSplitStyle, outletVelocityMs: number, mainVelocityMs: number): number {
  if (style === 'wye') return takeoffBranchLossPa('wye', outletVelocityMs, mainVelocityMs);
  return (style === 'bullhead' ? FITTING_LOSS_COEFFICIENTS.bullhead : FITTING_LOSS_COEFFICIENTS.split) * velocityPressurePa(outletVelocityMs);
}

/**
 * Additional loss of the bends in a flexible runout, above the straight-flex
 * friction already charged against its full developed length.
 *
 * Reference: Thermaflex, Air Flow and Air Friction, p. 4, measured 90-degree
 * bend coefficients for 12-inch M-KC / S-LP-10 / S-TL: R/D 1, 2.5, 4 give
 * K 0.84, 0.85, 0.87. The published bend loss includes the bent section's
 * friction, so subtract that component rather than charging it twice.
 * https://www.thermaflex.net/wp-content/uploads/2016/03/Thermaflex-Air-Flow-and-Air-Friction-Brochure.pdf
 *
 * Using this reference for other products/diameters and scaling by angle are
 * engineering estimates, not manufacturer ratings for the project's flex.
 * Interpolate only within the measured R/D range; clamp outside it. Sum local
 * absolute turns, since opposite bends in an S-runout do not cancel losses.
 */
export function flexBendLossPa(points: readonly DuctPoint3[], diameterMm: number, airflowM3h: number): number {
  if (diameterMm <= 0 || airflowM3h <= 0) return 0;
  const section = { widthMm: diameterMm, heightMm: diameterMm, diameterMm };
  const velocityPressure = velocityPressurePa(velocityMs(section, airflowM3h));
  const frictionPerMm = frictionPaPerM(section, airflowM3h, 'flex') / 1000;
  const samples = points.filter((point, index) => index === 0
    || Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y, point.z - points[index - 1]!.z) > 1e-6);
  let loss = 0;
  for (let index = 1; index + 1 < samples.length; index += 1) {
    const a = samples[index - 1]!;
    const b = samples[index]!;
    const c = samples[index + 1]!;
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const cross = Math.hypot(u.y * v.z - u.z * v.y, u.z * v.x - u.x * v.z, u.x * v.y - u.y * v.x);
    const dot = u.x * v.x + u.y * v.y + u.z * v.z;
    const angle = Math.atan2(cross, dot);
    if (angle < 1e-9) continue;
    const radius = cross > 1e-9
      ? Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z) * Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z) / (2 * cross)
      : 0;
    const ratio = Math.max(1, Math.min(4, radius / diameterMm));
    const coefficient90 = ratio <= 2.5 ? 0.84 + (ratio - 1) * (0.01 / 1.5) : 0.85 + (ratio - 2.5) * (0.02 / 1.5);
    const bendLoss = coefficient90 * (angle / (Math.PI / 2)) * velocityPressure;
    loss += Math.max(0, bendLoss - frictionPerMm * radius * angle);
  }
  return loss;
}

export interface TerminalPressure {
  terminalId: string;
  runId: string;
  frictionPa: number;
  fittingsPa: number;
  terminalPa: number;
  totalPa: number;
}

export interface ServicePressure {
  service: DuctService;
  terminals: TerminalPressure[];
  /** The path the fan has to overcome. */
  indexTerminalId: string | null;
  indexPa: number;
  /** Pressure each terminal's damper throttles to match the index path (Pa). */
  throttlePa: Record<string, number>;
}

function sectionOf(piece: DuctPiece, atEnd = false): DuctLeg {
  // On shape transitions an absent end diameter means a rectangular outlet.
  const d = atEnd ? piece.endDiameterMm : piece.diameterMm;
  if (d !== undefined) {
    return { widthMm: d, heightMm: d, diameterMm: d };
  }
  return atEnd ? { widthMm: piece.endWidthMm, heightMm: piece.endHeightMm } : { widthMm: piece.widthMm, heightMm: piece.heightMm };
}

function coefficientOf(piece: DuctPiece, fromPlenum: boolean): number {
  const c = FITTING_LOSS_COEFFICIENTS;
  switch (piece.kind) {
    case 'connector': return c.connector;
    case 'elbow': {
      const elbow = piece.elbow;
      if (!elbow) return c.elbowRadius;
      const inPlane = elbow.inPlaneMm ?? piece.widthMm;
      return elbowCoefficient(elbow.style, inPlane > 0 ? elbow.centrelineRadiusMm / inPlane : 1, elbow.angleDeg);
    }
    case 'offset': return c.offset;
    case 'transition': {
      const info = piece.transition;
      const shapeChange = (piece.diameterMm === undefined) !== (piece.endDiameterMm === undefined) ? c.shapeChange : 0;
      if (!info) return c.transition + shapeChange;
      const expanding = info.widthSense === 'expanding' || info.heightSense === 'expanding';
      // Level pieces have a flat bottom, so the top angle is already the
      // entire height divergence. Riser transitions taper on both sides.
      const includedHeight = info.angleHeightDeg * (piece.vertical ? 2 : 1);
      return transitionCoefficient(Math.max(2 * info.angleWidthDeg, includedHeight), expanding) + shapeChange;
    }
    case 'takeoff': return fromPlenum ? c.takeoffPlenum : c.takeoffTrunk;
    case 'damper': return c.damper;
    case 'plenum': return c.plenumEntry;
    default: return 0;
  }
}

interface RunNode {
  plan: DuctFabricationPlan;
  parentId: string | null;
  /** Where on the parent this run leaves it (mm along the parent's path). */
  attachMm: number;
  /** The terminal at this run's end, if any. */
  terminalId: string | null;
  children: RunNode[];
  airflowM3h: number;
}

/**
 * Every terminal path of one service's system. `plans` are the system's runs
 * (a run from the unit collar and everything taken off it); `airflow` maps a
 * terminal id to its design airflow (m³/h).
 */
export function systemPressure(
  plans: readonly DuctFabricationPlan[],
  airflow: ReadonlyMap<string, number>,
  settings: Pick<DuctDesignSettings, 'autoDiffuserDropPa' | 'autoGrilleDropPa'>,
  service: DuctService,
): ServicePressure {
  const nodes = new Map<string, RunNode>();
  for (const plan of plans) {
    const start = plan.spec.start;
    const parentId = start.kind === 'tap' || start.kind === 'split-branch' || start.kind === 'spigot' ? start.parentRunId : null;
    const end = plan.spec.end;
    nodes.set(plan.elementId, { plan, parentId, attachMm: 0, terminalId: end.kind === 'terminal' ? end.terminalId : null, children: [], airflowM3h: 0 });
  }
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (!parent) continue;
    parent.children.push(node);
    const start = node.plan.spec.start;
    const parentLegs = ductLegs(parent.plan.spec);
    const parentLength = parentLegs.reduce((total, leg) => total + leg.lengthMm, 0);
    if (start.kind === 'tap') {
      node.attachMm = parentLegs.slice(0, start.legIndex).reduce((total, leg) => total + leg.lengthMm, 0) + start.stationMm;
    } else {
      node.attachMm = parentLength;
    }
  }
  // Resolve leaves first: avoids recursion depth limits and detects corrupt
  // parent cycles, which otherwise make both walks run indefinitely.
  const remaining = new Map<RunNode, number>();
  const pending: RunNode[] = [];
  for (const node of nodes.values()) {
    node.airflowM3h = node.terminalId ? airflow.get(node.terminalId) ?? 0 : 0;
    remaining.set(node, node.children.length);
    if (node.children.length === 0) pending.push(node);
  }
  for (let index = 0; index < pending.length; index += 1) {
    const node = pending[index]!;
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (!parent) continue;
    parent.airflowM3h += node.airflowM3h;
    const left = remaining.get(parent)! - 1;
    remaining.set(parent, left);
    if (left === 0) pending.push(parent);
  }
  if (pending.length !== nodes.size) throw new Error('Cannot calculate duct pressure: cyclic run connections.');
  const flowStations = new Map<RunNode, { stations: number[]; suffixFlows: number[] }>();
  for (const node of nodes.values()) {
    const children = [...node.children].sort((a, b) => a.attachMm - b.attachMm);
    const suffixFlows = new Array<number>(children.length + 1).fill(0);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      suffixFlows[index] = suffixFlows[index + 1]! + children[index]!.airflowM3h;
    }
    flowStations.set(node, { stations: children.map((child) => child.attachMm), suffixFlows });
  }
  /** Airflow in a run at a station: its own terminal and the children leaving further on. */
  const flowAt = (node: RunNode, station: number): number => {
    const { stations, suffixFlows } = flowStations.get(node)!;
    let low = 0;
    let high = stations.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (stations[mid]! <= station + 1e-6) low = mid + 1;
      else high = mid;
    }
    return (node.terminalId ? airflow.get(node.terminalId) ?? 0 : 0) + suffixFlows[low]!;
  };

  /** The section of `node` at a station along its path (the piece covering it). */
  const sectionAt = (node: RunNode, station: number): DuctLeg | null => {
    const piece = node.plan.pieces.find((candidate) => candidate.kind !== 'flex' && candidate.kind !== 'split'
      && candidate.stationStartMm <= station + 1e-6 && candidate.stationEndMm >= station - 1e-6);
    return piece ? sectionOf(piece) : null;
  };
  /** Velocity in the parent main just upstream of where `node` leaves it (the combined flow). */
  const mainVelocityAt = (node: RunNode): number => {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (!parent) return 0;
    const flow = flowAt(parent, node.attachMm - 1);
    const section = node.plan.spec.start.kind === 'split-branch'
      ? (() => { const last = parent.plan.spec.legs[parent.plan.spec.legs.length - 1]; return last ?? null; })()
      : sectionAt(parent, node.attachMm);
    return section ? velocityMs(section, flow) : 0;
  };

  const pressureCache = new Map<RunNode, Map<RunNode | null, { friction: number; fittings: number }>>();
  /** Friction and fittings in `node` from its start up to `limitMm`; `child` = the run the path leaves by. */
  const along = (node: RunNode, limitMm: number, child: RunNode | null): { friction: number; fittings: number } => {
    const cached = pressureCache.get(node)?.get(child);
    if (cached) return cached;
    let friction = 0;
    let fittings = 0;
    const fromPlenum = node.plan.spec.start.kind === 'spigot';
    // The main's straight-through passage at every take-off this path passes.
    for (const passed of node.children) {
      if (passed === child || passed.plan.spec.start.kind !== 'tap' || passed.attachMm >= limitMm - 1e-6) continue;
      const section = sectionAt(node, passed.attachMm);
      if (!section) continue;
      fittings += mainPassageLossPa(velocityMs(section, flowAt(node, passed.attachMm + 1)), velocityMs(section, flowAt(node, passed.attachMm - 1)));
    }
    for (const piece of node.plan.pieces) {
      // Splits have zero station length and all flow leaves at that station.
      // Account for them before sampling flow downstream of the outlets.
      if (piece.kind === 'split') {
        if (!child || child.plan.spec.start.kind !== 'split-branch' || piece.stationStartMm > limitMm + 1e-6) continue;
        const first = child.plan.pieces[0];
        const style = piece.split?.style ?? (node.plan.spec.end.kind === 'split' ? node.plan.spec.end.style : 'y');
        const last = node.plan.spec.legs[node.plan.spec.legs.length - 1];
        const combinedFlow = flowAt(node, piece.stationStartMm - 1e-3);
        if (first && child.airflowM3h > 0) fittings += splitOutletLossPa(style, velocityMs(sectionOf(first), child.airflowM3h), last ? velocityMs(last, combinedFlow) : 0);
        continue;
      }
      if (piece.stationStartMm >= limitMm - 1e-6) continue;
      const end = Math.min(piece.stationEndMm, limitMm);
      const span = piece.stationEndMm - piece.stationStartMm;
      const section = sectionOf(piece);
      // A fabricated straight can span several take-offs. Integrate each
      // constant-flow interval instead of assigning its midpoint flow to all
      // of it, and use developed length for elbows and offsets.
      const stations = [piece.stationStartMm, ...flowStations.get(node)!.stations
        .filter((station) => station > piece.stationStartMm && station < end), end];
      for (let index = 1; index < stations.length; index += 1) {
        const from = stations[index - 1]!;
        const to = stations[index]!;
        if (to <= from || span <= 0) continue;
        const segmentFlow = flowAt(node, (from + to) / 2);
        if (segmentFlow <= 0) continue;
        const developedLength = piece.lengthMm * (to - from) / span;
        friction += frictionPaPerM(section, segmentFlow, piece.kind === 'flex' ? 'flex' : 'galvanised') * (developedLength / 1000);
      }
      const flow = flowAt(node, (piece.stationStartMm + end) / 2);
      if (flow <= 0) continue;
      if (piece.kind === 'flex' && piece.flex) {
        fittings += flexBendLossPa(piece.flex.points, piece.diameterMm ?? piece.widthMm, flow);
        continue;
      }
      if (piece.kind === 'takeoff' && !fromPlenum && node.plan.spec.start.kind === 'tap') {
        fittings += takeoffBranchLossPa(node.plan.spec.start.style, velocityMs(section, flow), mainVelocityAt(node));
        continue;
      }
      const coefficient = coefficientOf(piece, fromPlenum);
      if (coefficient > 0) {
        // The return path is stored from unit to terminal but air flows back
        // to the unit. Plenum entry loses the inlet duct's velocity pressure.
        const reference = piece.kind === 'transition' ? sectionOf(piece, service === 'supply')
          : piece.kind === 'plenum' ? node.plan.spec.legs[piece.legIndex] ?? section : section;
        fittings += coefficient * velocityPressurePa(velocityMs(reference, flow));
      }
    }
    const result = { friction, fittings };
    let cache = pressureCache.get(node);
    if (!cache) {
      cache = new Map();
      pressureCache.set(node, cache);
    }
    cache.set(child, result);
    return result;
  };

  const terminals: TerminalPressure[] = [];
  const terminalDrop = service === 'return' ? settings.autoGrilleDropPa : settings.autoDiffuserDropPa;
  for (const node of nodes.values()) {
    if (!node.terminalId) continue;
    let friction = 0;
    let fittings = 0;
    let current: RunNode | undefined = node;
    let child: RunNode | null = null;
    let limit = Number.POSITIVE_INFINITY;
    while (current) {
      const part = along(current, limit, child);
      friction += part.friction;
      fittings += part.fittings;
      child = current;
      limit = current.attachMm;
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    terminals.push({
      terminalId: node.terminalId, runId: node.plan.elementId,
      frictionPa: friction, fittingsPa: fittings, terminalPa: terminalDrop, totalPa: friction + fittings + terminalDrop,
    });
  }
  const index = terminals.reduce<TerminalPressure | null>((best, entry) => (!best || entry.totalPa > best.totalPa ? entry : best), null);
  const throttlePa: Record<string, number> = {};
  for (const entry of terminals) throttlePa[entry.terminalId] = index ? index.totalPa - entry.totalPa : 0;
  return { service, terminals, indexTerminalId: index?.terminalId ?? null, indexPa: index?.totalPa ?? 0, throttlePa };
}
