/**
 * A condensate piece's figures for its segment card, each read from the run
 * as generated and its network's design:
 *  - the run's pipe (system, nominal size, OD and ID), insulation and what it
 *    carries (the units upstream, their kW and the design flow from them);
 *  - a stretch's length and fall: the governing fall against the minimum and
 *    preferred falls (its 45° offsets told apart), its capacity half full at
 *    that fall (Manning) against the design flow, the invert levels at its
 *    ends, and its head margin above the minimum-fall profile (from one
 *    baseline solve of its network, cached per drawing);
 *  - a riser's lift against its unit's pump head; the hose or stub at a unit,
 *    with its trap; a bend's angle and elbow; how the run ends; a fitting's
 *    note; a termination's kind, trap, air break and drop;
 *  - the refrigerant crossings on it and the supports that carry it.
 *
 * PURE: elements and settings in, figures out.
 */
import type { HvacElement } from '../../../../types';
import type { FigureStatus } from '../segments/SegmentCardKit';

import { createCondensateEditSession, type CondensateEditContext, type CondensateEditSession } from './condensateEditing';
import type { CondensateCrossing } from './condensateNetworkPlanner';
import { condensatePieceSpan, type CondensatePiece, type CondensateRun } from './condensatePieces';
import { getCondensatePipeSystem, manningCapacityLitresPerHour } from './condensatePipeCatalog';
import { getIndoorUnitDrainPort } from './condensatePorts';
import { formatFallRatio, type CondensateDesignSettings } from './condensateSettings';
import { layoutCondensateSupports } from './condensateSupports';
import {
  getCondensateOwnership,
  isCondensatePipe,
  readCondensateGullySpec,
  readCondensatePipeSpec,
  type CondensateSegmentRole,
  type CondensateTerminalTrap,
  type CondensateTerminationKind,
  type Point3,
} from './condensateTypes';

export interface CondensateFallFigure {
  /** The governing fall: the gentlest of its sloped stretches, 45° offsets aside (%). */
  slopePercent: number;
  ratio: string;
  status: FigureStatus;
  minimumPercent: number;
  preferredPercent: number;
  /** Its 45° level changes: how many and how far they drop it (mm). */
  offsets: { count: number; dropMm: number };
}

export interface CondensateCapacityFigure {
  designLitresPerHour: number;
  /** At its fall, filled to the design depth (Manning). */
  capacityLitresPerHour: number;
  fillRatio: number;
  status: FigureStatus;
}

export interface CondensatePieceFigures {
  system: { label: string; verified: boolean };
  nominalSize: string;
  outerDiameterMm: number;
  innerDiameterMm: number;
  insulationMm: number;
  role: CondensateSegmentRole;
  unitsServed: number;
  capacityKw: number;
  lengthMm: number;
  planLengthMm: number;
  fall: CondensateFallFigure | null;
  capacity: CondensateCapacityFigure | null;
  /** Invert levels (pipe bottom inside) at its ends (mm above floor). */
  invert: { fromMm: number; toMm: number } | null;
  /** How far it sits above the lowest profile that still meets the minimum fall (mm); null when not solved. */
  headMarginMm: number | null;
  headStatus: FigureStatus | null;
  lift: { liftMm: number; pumpHeadMm: number; unitLabel: string; status: FigureStatus } | null;
  connection: { unitLabel: string; pumped: boolean; hoseMm: number; trapDepthMm: number | null } | null;
  bend: { angleDeg: number; elbow: string | null } | null;
  end: { kind: 'wye' | 'through' | 'drop'; into: string } | null;
  fitting: { label: string; note: string | null } | null;
  termination: { kind: CondensateTerminationKind; gullyLabel: string; trap: CondensateTerminalTrap; airBreakMm: number; inletLevelMm: number; dropMm: number } | null;
  crossings: Array<{ relation: CondensateCrossing['relation']; serviceIds: string[]; gapMm: number }>;
  supports: number;
}

// ---------------------------------------------------------------------------------------------------- the network's design

export interface CondensateBaseline {
  /** The solved network's nodes: where each sits and its head margin. */
  nodes: Array<{ x: number; y: number; z: number; slackMm: number }>;
  crossings: CondensateCrossing[];
}

const SESSION_CACHE = new WeakMap<readonly HvacElement[], Map<string, CondensateEditSession | null>>();
const BASELINE_CACHE = new WeakMap<readonly HvacElement[], Map<string, CondensateBaseline | null>>();

/** One edit session per drawing and network: its figures and its options' evaluations share it. */
export function condensateSessionFor(scene: readonly HvacElement[], networkId: string, context: CondensateEditContext): CondensateEditSession | null {
  let byNetwork = SESSION_CACHE.get(scene);
  if (!byNetwork) {
    byNetwork = new Map();
    SESSION_CACHE.set(scene, byNetwork);
  }
  if (!byNetwork.has(networkId)) {
    let session: CondensateEditSession | null = null;
    try {
      session = createCondensateEditSession([...scene], networkId, context);
    } catch {
      session = null;
    }
    byNetwork.set(networkId, session);
  }
  return byNetwork.get(networkId)!;
}

/** The network's design as solved again along its own routes (cached per drawing and network). */
export function condensateNetworkBaseline(scene: readonly HvacElement[], networkId: string, context: CondensateEditContext): CondensateBaseline | null {
  let byNetwork = BASELINE_CACHE.get(scene);
  if (!byNetwork) {
    byNetwork = new Map();
    BASELINE_CACHE.set(scene, byNetwork);
  }
  if (byNetwork.has(networkId)) return byNetwork.get(networkId)!;
  let baseline: CondensateBaseline | null = null;
  try {
    const session = condensateSessionFor(scene, networkId, context);
    const generation = session?.solve({}, { markEdited: false }).generation ?? null;
    if (generation) {
      baseline = {
        nodes: generation.networks.flatMap((network) => network.nodes.map(({ x, y, z, slackMm }) => ({ x, y, z, slackMm }))),
        crossings: generation.crossings,
      };
    }
  } catch {
    baseline = null;
  }
  byNetwork.set(networkId, baseline);
  return baseline;
}

// ---------------------------------------------------------------------------------------------------- figures

const planDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function planDistanceToPath(point: { x: number; y: number }, path: readonly Point3[]): number {
  if (path.length === 1) return planDistance(point, path[0]!);
  let best = Infinity;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1]!;
    const b = path[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const t = squared > 1e-9 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0;
    best = Math.min(best, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  }
  return best;
}

/** The governing fall of a stretch and its 45° offsets. */
function fallOf(span: readonly Point3[]): { slopePercent: number; offsets: { count: number; dropMm: number } } | null {
  let governing = Infinity;
  const offsets = { count: 0, dropMm: 0 };
  for (let index = 1; index < span.length; index += 1) {
    const a = span[index - 1]!;
    const b = span[index]!;
    const run = planDistance(a, b);
    if (run < 1) continue;
    const slope = ((a.z - b.z) / run) * 100;
    if (Math.abs(slope) >= 50) {
      offsets.count += 1;
      offsets.dropMm += a.z - b.z;
      continue;
    }
    if (run >= 50) governing = Math.min(governing, slope);
  }
  if (!Number.isFinite(governing)) {
    // Only offsets (a short crown step): its fall over its plan length.
    const run = span.reduce((sum, point, index) => sum + (index ? planDistance(span[index - 1]!, point) : 0), 0);
    if (run < 1) return null;
    governing = ((span[0]!.z - span[span.length - 1]!.z) / run) * 100;
  }
  return { slopePercent: governing, offsets };
}

export function fallStatus(slopePercent: number, minimumPercent: number): FigureStatus {
  if (slopePercent < minimumPercent - 1e-3) return 'over';
  return slopePercent < minimumPercent * 1.1 ? 'near' : 'ok';
}

export function headMarginStatus(marginMm: number): FigureStatus {
  return marginMm >= 100 ? 'ok' : marginMm >= 40 ? 'near' : 'over';
}

const unitLabel = (scene: readonly HvacElement[], unitId: string | undefined) => {
  const unit = unitId ? scene.find((element) => element.id === unitId) : undefined;
  return unit ? unit.label || unit.modelLabel || unit.id : 'the unit';
};

const FITTING_LABELS: Record<string, string> = { cleanout: 'Rodding eye', 'air-vent': 'Air vent', 'wall-sleeve': 'Wall sleeve' };

/** A piece's figures. */
export function condensatePieceFigures(
  scene: readonly HvacElement[],
  element: HvacElement,
  run: CondensateRun,
  piece: CondensatePiece,
  settings: CondensateDesignSettings,
  baseline: CondensateBaseline | null,
): CondensatePieceFigures {
  const spec = run.spec;
  const system = getCondensatePipeSystem(spec.pipeSystem);
  const span = condensatePieceSpan(run, piece);
  const stretch = piece.kind === 'leg' || piece.kind === 'connection' || piece.kind === 'termination';
  const designLitresPerHour = spec.upstreamCapacityKw * settings.condensateLitresPerHourPerKw;

  // ---- Fall and capacity (falling stretches).
  let fall: CondensateFallFigure | null = null;
  let capacity: CondensateCapacityFigure | null = null;
  if (piece.kind === 'leg' || (piece.kind === 'connection' && !spec.pumped)) {
    const reading = fallOf(span);
    if (reading) {
      fall = {
        slopePercent: reading.slopePercent, ratio: formatFallRatio(Math.max(0, reading.slopePercent)),
        status: fallStatus(reading.slopePercent, settings.minSlopePercent),
        minimumPercent: settings.minSlopePercent, preferredPercent: settings.preferredSlopePercent, offsets: reading.offsets,
      };
      const capacityLitresPerHour = manningCapacityLitresPerHour(spec.innerDiameterMm, Math.max(0, reading.slopePercent), settings.maxFillRatio, settings.manningN);
      const ratio = capacityLitresPerHour > 0 ? designLitresPerHour / capacityLitresPerHour : Infinity;
      capacity = { designLitresPerHour, capacityLitresPerHour, fillRatio: settings.maxFillRatio, status: ratio <= 0.8 ? 'ok' : ratio <= 1 ? 'near' : 'over' };
    }
  }

  // ---- Head margin: the least over the solved nodes along it (at its own levels).
  let headMarginMm: number | null = null;
  if (baseline && piece.kind !== 'connection' && piece.kind !== 'termination') {
    const zs = span.map((point) => point.z);
    const low = Math.min(...zs) - 60;
    const high = Math.max(...zs) + 60;
    for (const node of baseline.nodes) {
      if (node.z < low || node.z > high || planDistanceToPath(node, span) > 2) continue;
      headMarginMm = headMarginMm === null ? node.slackMm : Math.min(headMarginMm, node.slackMm);
    }
    // A riser's margin is its top's: where the gravity run starts.
    if (piece.kind === 'riser') {
      const top = span[span.length - 1]!;
      const atTop = baseline.nodes.filter((node) => planDistance(node, top) <= 2 && Math.abs(node.z - top.z) <= 30);
      if (atTop.length) headMarginMm = Math.min(...atTop.map((node) => node.slackMm));
    }
  }

  // ---- The unit's own: its hose or stub, and its lift.
  const unitId = spec.drainStart?.kind === 'unit-drain' ? spec.drainStart.unitId : undefined;
  const unit = unitId ? scene.find((candidate) => candidate.id === unitId) : undefined;
  const port = unit ? getIndoorUnitDrainPort(unit, settings) : null;
  const trap = piece.fittings.find((fitting) => fitting.kind === 'p-trap');
  const connection = piece.kind === 'connection'
    ? { unitLabel: unitLabel(scene, unitId), pumped: spec.pumped, hoseMm: spec.drainHoseLengthMm, trapDepthMm: trap?.note ? Number.parseFloat(trap.note) || null : null }
    : null;
  const lift = piece.kind === 'riser' && port
    ? { liftMm: piece.lengthMm, pumpHeadMm: port.pumpMaxLiftMm, unitLabel: unitLabel(scene, unitId),
      status: (piece.lengthMm > port.pumpMaxLiftMm + 0.5 ? 'over' : piece.lengthMm > 0.9 * port.pumpMaxLiftMm ? 'near' : 'ok') as FigureStatus }
    : null;

  // ---- A bend, how the run ends, a fitting.
  const bend = piece.kind === 'bend' && piece.angleDeg !== null
    ? { angleDeg: piece.angleDeg, elbow: piece.fittings.find((fitting) => fitting.kind === 'elbow-90' || fitting.kind === 'elbow-45')?.kind ?? null }
    : null;
  let end: CondensatePieceFigures['end'] = null;
  if (piece.kind === 'end') {
    const nodeId = spec.drainEnd?.nodeId;
    const downstream = nodeId ? scene.find((candidate) => candidate.id !== element.id && isCondensatePipe(candidate)
      && readCondensatePipeSpec(candidate).drainStart?.nodeId === nodeId
      && getCondensateOwnership(candidate)?.networkId === getCondensateOwnership(element)?.networkId) : undefined;
    const next = downstream ? readCondensatePipeSpec(downstream) : null;
    if (next?.segmentRole === 'drop' || next?.segmentRole === 'terminal') {
      const gully = next.drainEnd?.gullyId ? scene.find((candidate) => candidate.id === next.drainEnd!.gullyId) : undefined;
      end = { kind: 'drop', into: gully ? gully.label || gully.id : 'the termination' };
    } else {
      end = { kind: piece.fittings.some((fitting) => fitting.kind === 'wye') ? 'wye' : 'through', into: next ? `CD ${next.nominalSize} ${next.segmentRole === 'unit-branch' ? 'branch' : 'main'}` : 'the main' };
    }
  }
  const fitting = piece.kind === 'eye' || piece.kind === 'vent' || piece.kind === 'sleeve'
    ? { label: FITTING_LABELS[piece.fittings[0]?.kind ?? ''] ?? 'Fitting', note: piece.fittings[0]?.note ?? null }
    : null;

  // ---- A termination.
  let termination: CondensatePieceFigures['termination'] = null;
  if (piece.kind === 'termination') {
    const gully = spec.drainEnd?.gullyId ? scene.find((candidate) => candidate.id === spec.drainEnd!.gullyId) : undefined;
    const gullySpec = gully ? readCondensateGullySpec(gully) : null;
    if (gullySpec) {
      termination = {
        kind: gullySpec.terminationKind, gullyLabel: gully!.label || gully!.id, trap: gullySpec.terminalTrap,
        airBreakMm: gullySpec.airBreakMm, inletLevelMm: gullySpec.inletElevationMm, dropMm: piece.fallMm,
      };
    }
  }

  // ---- Crossings on it, and the supports that carry it.
  const reach = run.radiusMm + 10;
  const crossings = (baseline?.crossings ?? [])
    .filter((crossing) => planDistanceToPath(crossing.point, span) <= reach)
    .map((crossing) => ({
      relation: crossing.relation, serviceIds: crossing.serviceElementIds,
      gapMm: crossing.relation === 'above' ? crossing.condensateZ - crossing.serviceZMax : crossing.serviceZMin - crossing.condensateZ,
    }));
  const supports = spec.hangers && (stretch || piece.kind === 'riser')
    ? layoutCondensateSupports(element, spec.hangers).filter((support) => planDistanceToPath(support.point, span) <= 2
      && support.point.z >= Math.min(...span.map((point) => point.z)) - 2 && support.point.z <= Math.max(...span.map((point) => point.z)) + 2).length
    : 0;

  return {
    system: { label: system.label, verified: system.verified },
    nominalSize: spec.nominalSize,
    outerDiameterMm: spec.outerDiameterMm,
    innerDiameterMm: spec.innerDiameterMm,
    insulationMm: spec.insulationThicknessMm,
    role: spec.segmentRole,
    unitsServed: spec.upstreamUnitIds.length,
    capacityKw: spec.upstreamCapacityKw,
    lengthMm: piece.lengthMm,
    planLengthMm: piece.planLengthMm,
    fall,
    capacity,
    invert: stretch || piece.kind === 'riser' ? { fromMm: piece.from.z - spec.innerDiameterMm / 2, toMm: piece.to.z - spec.innerDiameterMm / 2 } : null,
    headMarginMm,
    headStatus: headMarginMm === null ? null : headMarginStatus(headMarginMm),
    lift,
    connection,
    bend,
    end,
    fitting,
    termination,
    crossings,
    supports,
  };
}
