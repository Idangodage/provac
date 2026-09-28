/**
 * Pressure along each terminal's path through a duct system: friction in
 * every piece at the airflow it carries (the terminals downstream of it),
 * plus each fitting's loss coefficient × velocity pressure, plus the
 * terminal's own drop. The largest path is the index path; supply + return
 * index paths are the external static pressure the unit's fan must deliver.
 * The gap between a path and the index path is what its damper throttles to
 * balance.
 *
 * Friction is the Darcy–Weisbach model in ductSizing.ts. The loss
 * coefficients are practice values of the usual order (ASHRAE Duct Fitting
 * Database fittings), not transcribed from it; the result is an estimate for
 * checking the fan, not a certified calculation.
 */
import type { DuctFabricationPlan, DuctPiece } from './ductFabricationPlanner';
import { ductLegs } from './ductGeometry';
import type { DuctDesignSettings } from './ductSettings';
import { frictionPaPerM, velocityMs, velocityPressurePa } from './ductSizing';
import type { DuctLeg, DuctService } from './ductTypes';

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
} as const;

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
  if (piece.diameterMm !== undefined) {
    const d = atEnd ? piece.endDiameterMm ?? piece.diameterMm : piece.diameterMm;
    return { widthMm: d, heightMm: d, diameterMm: d };
  }
  return atEnd ? { widthMm: piece.endWidthMm, heightMm: piece.endHeightMm } : { widthMm: piece.widthMm, heightMm: piece.heightMm };
}

function coefficientOf(piece: DuctPiece, fromPlenum: boolean): number {
  const c = FITTING_LOSS_COEFFICIENTS;
  switch (piece.kind) {
    case 'connector': return c.connector;
    case 'elbow': return piece.elbow?.style === 'square-vaned' ? c.elbowVaned : c.elbowRadius;
    case 'offset': return c.offset;
    case 'transition': return c.transition;
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
  const total = (node: RunNode): number => {
    node.airflowM3h = (node.terminalId ? airflow.get(node.terminalId) ?? 0 : 0) + node.children.reduce((sum, child) => sum + total(child), 0);
    return node.airflowM3h;
  };
  for (const node of nodes.values()) if (!node.parentId || !nodes.has(node.parentId)) total(node);
  /** Airflow in a run at a station: its own terminal and the children leaving further on. */
  const flowAt = (node: RunNode, station: number) => (node.terminalId ? airflow.get(node.terminalId) ?? 0 : 0)
    + node.children.filter((child) => child.attachMm > station + 1e-6).reduce((sum, child) => sum + child.airflowM3h, 0);

  /** Friction and fittings in `node` from its start up to `limitMm`; `child` = the run the path leaves by. */
  const along = (node: RunNode, limitMm: number, child: RunNode | null): { friction: number; fittings: number } => {
    let friction = 0;
    let fittings = 0;
    const fromPlenum = node.plan.spec.start.kind === 'spigot';
    for (const piece of node.plan.pieces) {
      if (piece.stationStartMm >= limitMm - 1e-6 && piece.kind !== 'split') continue;
      const station = (piece.stationStartMm + Math.min(piece.stationEndMm, limitMm)) / 2;
      const flow = flowAt(node, station);
      if (flow <= 0) continue;
      const length = Math.max(0, Math.min(piece.stationEndMm, limitMm) - piece.stationStartMm);
      const section = sectionOf(piece);
      friction += frictionPaPerM(section, flow, piece.kind === 'flex' ? 'flex' : 'galvanised') * (length / 1000);
      if (piece.kind === 'split' && child) {
        const first = child.plan.pieces[0];
        if (first) fittings += FITTING_LOSS_COEFFICIENTS.split * velocityPressurePa(velocityMs(sectionOf(first), child.airflowM3h));
        continue;
      }
      const coefficient = coefficientOf(piece, fromPlenum);
      if (coefficient > 0) {
        // Take-offs and transitions on the downstream section, the rest on their own.
        const reference = piece.kind === 'transition' ? sectionOf(piece, true) : section;
        fittings += coefficient * velocityPressurePa(velocityMs(reference, flow));
      }
    }
    return { friction, fittings };
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
