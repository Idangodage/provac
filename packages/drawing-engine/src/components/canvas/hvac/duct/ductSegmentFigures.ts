/**
 * The figures a designer reads off one segment of a duct run: the airflow it
 * carries, its velocity and friction rate against the system's limits, its
 * pressure loss and whether it lies on the index path, and how it is built.
 *
 * The system's flow model is the sizing's own: each terminal's design airflow,
 * else an equal share of the system airflow (systemTerminalAirflows), the flow
 * at every station (buildDuctFlowTree) and each piece's loss — the same code
 * systemPressure sums for the fan duty, so the card and the duty agree. It is
 * built once per drawing revision and shared by every segment of the system.
 */
import type { HvacElement } from '../../../../types';

import { getActiveDuctBuilding } from './ductBuilding';
import { gaugeLabelForSheet } from './ductCatalog';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { describeJoint } from './ductGauge';
import { ductBranchesOf } from './ductNetwork';
import {
  buildDuctFlowTree,
  ductRunPieceLosses,
  systemPressure,
  type DuctFlowTree,
  type DuctPieceLoss,
  type ServicePressure,
} from './ductPressure';
import { ductSegmentOf } from './ductSegments';
import type { DuctDesignSettings } from './ductSettings';
import { frictionPaPerM, readUnitAirData, velocityMs, velocityPressurePa } from './ductSizing';
import {
  basisLimits,
  defaultSizingBasis,
  ductSystemRootOfRun,
  linkSizingBasis,
  systemTerminalAirflows,
  type DuctSizingPart,
} from './ductSystemSizing';
import { readDuctTerminalSpec, terminalDropLookup } from './ductTerminals';
import { readDuctRunSpec, type DuctLeg, type DuctService, type DuctSystemSizing } from './ductTypes';

export type DuctFigureStatus = 'ok' | 'near' | 'over';

export interface DuctSegmentFlowFigures {
  /** Airflow along the segment (it falls past each take-off on a supply main). */
  airflowM3h: { max: number; min: number };
  velocityMs: { max: number; min: number };
  /** Friction rate at its largest airflow. */
  frictionPaPerM: number;
  frictionPa: number;
  fittingsPa: number;
  /** The main's straight-through loss at the take-offs leaving along it. */
  passagePa: number;
  totalPa: number;
  /** A fitting's loss coefficient on its own velocity pressure. */
  coefficient: number | null;
  part: DuctSizingPart;
  /** Terminals it serves (at its upstream end). */
  terminals: number;
  limits: { velocityMs: number; frictionPaPerM: number };
  velocityStatus: DuctFigureStatus;
  frictionStatus: DuctFigureStatus;
  /** On the path the fan has to overcome. */
  onIndexPath: boolean;
}

export interface DuctSegmentFigures {
  runId: string;
  key: string;
  system: {
    rootRunId: string;
    service: DuctService;
    unitLabel: string | null;
    airflowM3h: number | null;
    /** Terminals the system's ducts reach. */
    terminals: number;
    indexPa: number | null;
    maxEspPa: number | null;
  } | null;
  /** Null when the run is on no unit's system, or the system has no airflow. */
  flow: DuctSegmentFlowFigures | null;
  construction: {
    sheetMm: number | null;
    gauge: string;
    joint: string;
    seam: string;
    insulationMm: number;
    pressureClassPa: number;
  } | null;
  fabrication: { pieces: number; lengthMm: number; areaM2: number; massKg: number };
}

interface SystemFlowModel {
  rootRunId: string;
  service: DuctService;
  unit: HvacElement | null;
  basis: DuctSystemSizing;
  systemAirflowM3h: number | null;
  plans: Map<string, DuctFabricationPlan>;
  tree: DuctFlowTree | null;
  losses: Map<string, DuctPieceLoss[]>;
  pressure: ServicePressure | null;
  /** Runs on the index path, and how far along each the path runs (mm). */
  indexReach: Map<string, number>;
}

const MODEL_CACHE = new WeakMap<readonly HvacElement[], Map<string, { settings: DuctDesignSettings; building: unknown; model: SystemFlowModel | null }>>();

function buildSystemModel(scene: readonly HvacElement[], settings: DuctDesignSettings, root: HvacElement): SystemFlowModel | null {
  const rootSpec = readDuctRunSpec(root);
  if (!rootSpec || rootSpec.legacy) return null;
  const plans = new Map<string, DuctFabricationPlan>();
  const visit = (element: HvacElement) => {
    if (plans.has(element.id)) return;
    const plan = getDuctRunPlan(element, scene, settings);
    if (!plan) return;
    plans.set(element.id, plan);
    for (const branch of ductBranchesOf(element.id, scene)) if (!branch.spec.legacy) visit(branch.element);
  };
  visit(root);
  const byId = new Map(scene.map((element) => [element.id, element]));
  const unitId = rootSpec.start.kind === 'unit-port' ? rootSpec.start.unitId : null;
  const unit = unitId ? byId.get(unitId) ?? null : null;
  const terminals = [...plans.values()].flatMap((plan) => {
    const end = plan.spec.end;
    if (end.kind !== 'terminal') return [];
    const element = byId.get(end.terminalId);
    const spec = element ? readDuctTerminalSpec(element) : null;
    return spec ? [{ id: end.terminalId, spec: { designAirflowM3h: spec.designAirflowM3h ?? null } }] : [];
  });
  const requested = rootSpec.sizing ?? defaultSizingBasis(settings, rootSpec.service, null);
  const { systemAirflowM3h, shares } = systemTerminalAirflows(unit ?? undefined, requested, terminals);
  const basis = linkSizingBasis(requested, systemAirflowM3h);
  const airflow = new Map(shares.map((share) => [share.terminalId, share.airflowM3h]));
  const list = [...plans.values()];
  let tree: DuctFlowTree | null = null;
  let pressure: ServicePressure | null = null;
  try {
    tree = buildDuctFlowTree(list, airflow);
    pressure = systemPressure(list, airflow, settings, rootSpec.service, terminalDropLookup(scene, settings));
  } catch {
    // Cyclic run connections: no flow figures (the planner reports the network).
    tree = null;
    pressure = null;
  }
  const losses = new Map<string, DuctPieceLoss[]>();
  if (tree) for (const id of plans.keys()) losses.set(id, ductRunPieceLosses(tree, id, rootSpec.service) ?? []);
  const indexReach = new Map<string, number>();
  const indexRun = pressure?.indexTerminalId ? pressure.terminals.find((entry) => entry.terminalId === pressure!.indexTerminalId)?.runId : undefined;
  if (tree && indexRun) {
    let current = tree.runs.get(indexRun);
    let reach = Number.POSITIVE_INFINITY;
    while (current && !indexReach.has(current.plan.elementId)) {
      indexReach.set(current.plan.elementId, reach);
      reach = current.attachMm;
      current = current.parentId ? tree.runs.get(current.parentId) : undefined;
    }
  }
  return { rootRunId: root.id, service: rootSpec.service, unit, basis, systemAirflowM3h, plans, tree, losses, pressure, indexReach };
}

/** The flow model of the system a run belongs to (cached per drawing, settings and building), or null off any system. */
function systemModelOf(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string): SystemFlowModel | null {
  const root = ductSystemRootOfRun(scene, runId);
  if (!root) return null;
  let byRoot = MODEL_CACHE.get(scene);
  if (!byRoot) MODEL_CACHE.set(scene, (byRoot = new Map()));
  const building = getActiveDuctBuilding();
  const hit = byRoot.get(root.id);
  if (hit && hit.settings === settings && hit.building === building) return hit.model;
  const model = buildSystemModel(scene, settings, root);
  byRoot.set(root.id, { settings, building, model });
  return model;
}

function statusOf(value: number, limit: number): DuctFigureStatus {
  if (!(limit > 0)) return 'ok';
  if (value > limit * 1.001) return 'over';
  return value > limit * 0.9 ? 'near' : 'ok';
}

function sectionAtStart(plan: DuctFabricationPlan, index: number): DuctLeg {
  const piece = plan.pieces[index]!;
  return piece.diameterMm !== undefined
    ? { widthMm: piece.diameterMm, heightMm: piece.diameterMm, diameterMm: piece.diameterMm }
    : { widthMm: piece.widthMm, heightMm: piece.heightMm };
}

/** The figures of one segment of a run, or null when the run or the segment is gone. */
export function ductSegmentFigures(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, key: string): DuctSegmentFigures | null {
  const element = scene.find((candidate) => candidate.id === runId);
  if (!element) return null;
  const model = systemModelOf(scene, settings, runId);
  const plan = model?.plans.get(runId) ?? getDuctRunPlan(element, scene, settings);
  if (!plan) return null;
  const segment = ductSegmentOf(plan, key);
  if (!segment) return null;
  const pieces = segment.pieceIndices.map((index) => plan.pieces[index]!);
  const fabrication = {
    pieces: pieces.length,
    lengthMm: segment.lengthMm,
    areaM2: pieces.reduce((total, piece) => total + piece.sheetAreaM2, 0),
    massKg: pieces.reduce((total, piece) => total + piece.massKg, 0),
  };
  const construction = plan.constructionByLeg[Math.min(segment.legIndex, plan.constructionByLeg.length - 1)];
  const round = segment.round;
  const figures: DuctSegmentFigures = {
    runId, key, flow: null, fabrication,
    system: model ? {
      rootRunId: model.rootRunId, service: model.service, unitLabel: model.unit?.label ?? null, airflowM3h: model.systemAirflowM3h,
      terminals: model.tree?.runs.get(model.rootRunId)?.terminals ?? 0,
      indexPa: model.pressure && model.pressure.terminals.length ? model.pressure.indexPa : null,
      maxEspPa: model.unit ? readUnitAirData(model.unit).maxEspPa : null,
    } : null,
    construction: construction ? {
      sheetMm: construction.sheetThicknessMm,
      gauge: construction.sheetThicknessMm !== null ? gaugeLabelForSheet(construction.sheetThicknessMm) : '—',
      joint: describeJoint(construction.joint).split(' (')[0]!,
      seam: round ? (plan.seamRound === 'spiral' ? 'spiral seam' : 'longitudinal seam') : plan.seamType === 'snaplock' ? 'snap-lock seam' : 'Pittsburgh seam',
      insulationMm: plan.insulationMm,
      pressureClassPa: construction.pressureClassPa,
    } : null,
  };
  const losses = model?.losses.get(runId);
  if (!model || !losses || !(model.systemAirflowM3h && model.systemAirflowM3h > 0) || !figures.system?.terminals) return figures;
  const entries = segment.pieceIndices.map((index) => ({ index, loss: losses[index]! })).filter((entry) => entry.loss);
  if (entries.length === 0) return figures;
  const flows = entries.flatMap(({ loss }) => [loss.flowStartM3h, loss.flowEndM3h]);
  const velocities = entries.flatMap(({ index, loss }) => [velocityMs(sectionAtStart(plan, index), loss.flowStartM3h), velocityMs(sectionAtStart(plan, index), loss.flowEndM3h)]);
  const maxFlow = Math.max(...flows);
  const first = entries[0]!;
  const section = sectionAtStart(plan, first.index);
  const frictionRate = frictionPaPerM(section, maxFlow, plan.pieces[first.index]!.kind === 'flex' ? 'flex' : 'galvanised');
  const frictionPa = entries.reduce((total, { loss }) => total + loss.frictionPa, 0);
  const fittingsPa = entries.reduce((total, { loss }) => total + loss.fittingsPa, 0);
  const passagePa = entries.reduce((total, { loss }) => total + loss.passagePa, 0);
  const fitting = segment.kind !== 'straight' && segment.kind !== 'riser';
  const velocityPressure = velocityPressurePa(velocityMs(section, first.loss.flowM3h));
  const part: DuctSizingPart = segment.kind === 'flex' ? 'runout' : first.loss.terminals >= 2 ? 'trunk' : 'branch';
  const limits = basisLimits(model.basis, part);
  const maxVelocity = Math.max(...velocities);
  const reach = model.indexReach.get(runId);
  figures.flow = {
    airflowM3h: { max: maxFlow, min: Math.min(...flows) },
    velocityMs: { max: maxVelocity, min: Math.min(...velocities) },
    frictionPaPerM: frictionRate,
    frictionPa, fittingsPa, passagePa, totalPa: frictionPa + fittingsPa + passagePa,
    coefficient: fitting && velocityPressure > 1e-9 ? fittingsPa / velocityPressure : null,
    part,
    terminals: first.loss.terminals,
    limits: { velocityMs: limits.maxVelocityMs, frictionPaPerM: limits.frictionPaPerM },
    velocityStatus: statusOf(maxVelocity, limits.maxVelocityMs),
    frictionStatus: statusOf(frictionRate, limits.frictionPaPerM),
    onIndexPath: reach !== undefined && entries.some(({ index }) => plan.pieces[index]!.stationStartMm < reach - 1e-6),
  };
  return figures;
}
