/**
 * A turned unit's ducts re-designed to the optimum: which duct systems a turn
 * hands to the Auto duct optimiser, the request for each, and its design as
 * one command.
 *
 * - Every run on a turned unit's collars, and its whole branch tree, is
 *   re-designed (the route, the sizes, the fittings), except where a run is
 *   locked (that system keeps the turn's own re-route), where the unit and
 *   every terminal the system serves turned together (it turned whole: its
 *   layout still holds), or where the system serves no terminal yet (there is
 *   nothing to design for). A run left ending open with nothing taken off it
 *   serves nothing: the new design leaves it out, and says so.
 * - The request keeps what the designer chose for the system: the terminals
 *   it serves and their airflows, its services, its constant-friction basis
 *   (when it was sized so), its fan speed and its trunk's shape; the existing
 *   runs are replaced.
 * - The request keeps the trunk's shape where a clean layout of that shape
 *   fits the turned collar; where none does, the optimiser also chooses the
 *   shapes freely, and the better of its designs is taken (and said).
 * - The design's command, as Auto duct's Apply makes it: the old runs out, the
 *   new ones in with their sizing records, the spigots it turns, the
 *   terminals it serves in the unit's air system; the accessories the
 *   designer had set (attenuators, access doors, dampers) are set again where
 *   a straight takes them, else listed: one on a branch to a terminal at the
 *   same distance before that terminal's run ends, any other at the same
 *   distance from the collar along the air's path; and what changed, in a
 *   sentence.
 * - The design is taken only where it is the better of the two: the turn's
 *   own re-route and the optimiser's design are both appraised as the canvas
 *   checks them (the plans' and the supports' rules, the clashes) and priced
 *   alike (first cost and the fan's energy over the system's life). Fewer
 *   errors win; as many, the lower life-cycle cost. A collar turned into a
 *   tight corner, or off the room's axes, can leave the optimiser no buildable
 *   design where the re-route has one: the re-route is kept, and the status
 *   says why.
 *
 * Pure: the optimiser itself runs where the caller chooses (a worker).
 */
import type { HvacElement } from '../../../../types';

import { withSystemAssignments } from './ductAirSystems';
import { autoDuctTerminalUpdates, terminalSpigotUpdates, type AutoDuctRequest, type AutoDuctResult, type AutoDuctSizingBases } from './ductAutoLayout';
import { formatCost, priceDuctPlans } from './ductEconomics';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { ductLegs } from './ductGeometry';
import { ductBranchesOf } from './ductNetwork';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import type { DuctDesignSettings } from './ductSettings';
import { stampDesignedAt, withInitialSizingRecords } from './ductSizingRecord';
import { getDuctSupportPlan } from './ductSupports';
import { defaultSizingBasis, sizeDuctSystem } from './ductSystemSizing';
import { ductParentRunId, isDuctElement, isRoundLeg, readDuctRunSpec, type DuctInlineAccessory, type DuctRunSpec, type DuctService } from './ductTypes';
import { validateDuctRuns } from './ductValidation';

/** An accessory the designer set, to be set again on the new design. */
export interface CarriedAccessory {
  accessory: DuctInlineAccessory;
  service: DuctService;
  /**
   * Where it sat: on the run off the collar (all the service's air passes it:
   * an attenuator, a door to the coil), on a branch to one terminal (a
   * balancing damper), or on a run between.
   */
  on: 'collar-run' | 'branch' | 'between';
  /** The branch's terminal (on a branch). */
  terminalId: string | null;
  /** Its centre's distance (mm): on a branch, back from its end (before the runout); else from the collar along the air's path. */
  alongMm: number;
}

/** A system's size, to say what the re-design changed. */
export interface DuctSystemFigures {
  /** Rigid duct, centreline (mm), and the elbows in it. */
  lengthMm: number;
  elbows: number;
}

export interface TurnRedesignTarget {
  unitId: string;
  /** "DU-1" (its air-system tag), else its label. */
  unitName: string;
  request: Omit<AutoDuctRequest, 'walls' | 'rooms'>;
  /** The runs it replaces: the collar runs and their branch trees. */
  runIds: string[];
  carried: CarriedAccessory[];
  before: DuctSystemFigures;
  /** Runs ending open with nothing taken off them (they serve nothing: the new design leaves them out). */
  openRuns: number;
}

export interface TurnRedesignCommand {
  add: HvacElement[];
  removeIds: string[];
  updates: Array<{ id: string; updates: Partial<HvacElement> }>;
  /** What changed, and what could not be carried over. */
  notes: string[];
  after: DuctSystemFigures;
}

export interface TurnRedesignSkip {
  unitId: string;
  /** Why its ducts keep the turn's own re-route. */
  reason: string;
}

function nameOf(unit: HvacElement): string {
  const tag = unit.properties.airSystemTag;
  if (typeof tag === 'string' && tag.trim()) return tag.trim();
  return unit.label?.replace(/\s*\(3D\)$/i, '').trim() || 'the unit';
}

/** Every run on a unit's collars and their branch trees, collar runs first. */
export function unitDuctSystems(scene: readonly HvacElement[], unitId: string): Array<{ element: HvacElement; spec: DuctRunSpec }> {
  const out: Array<{ element: HvacElement; spec: DuctRunSpec }> = [];
  const seen = new Set<string>();
  const queue = scene.flatMap((element) => {
    if (!isDuctElement(element)) return [];
    const spec = readDuctRunSpec(element);
    return spec && !spec.legacy && spec.start.kind === 'unit-port' && spec.start.unitId === unitId ? [{ element, spec }] : [];
  });
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next.element.id)) continue;
    seen.add(next.element.id);
    out.push(next);
    for (const branch of ductBranchesOf(next.element.id, scene)) queue.push({ element: branch.element, spec: branch.spec });
  }
  return out;
}

/** The rigid duct and its elbows in some runs (as planned in `scene`). */
export function ductSystemFigures(scene: readonly HvacElement[], runs: readonly HvacElement[], settings: DuctDesignSettings): DuctSystemFigures {
  let lengthMm = 0;
  let elbows = 0;
  for (const run of runs) {
    const spec = readDuctRunSpec(run);
    if (!spec) continue;
    const runout = spec.end.kind === 'terminal' && spec.end.flex;
    ductLegs(spec).forEach((leg, index) => { if (!(runout && index === spec.legs.length - 1)) lengthMm += leg.lengthMm; });
    elbows += getDuctRunPlan(run, scene, settings)?.pieces.filter((piece) => piece.kind === 'elbow').length ?? 0;
  }
  return { lengthMm, elbows };
}

/** A centre on a run's leg, as a distance along its air path from the run's start (mm). */
function alongPath(spec: DuctRunSpec, legIndex: number, stationMm: number): number {
  return ductLegs(spec).slice(0, legIndex).reduce((sum, leg) => sum + leg.lengthMm, 0) + stationMm;
}

/** A run's rigid duct, start to end (mm): its legs without a flexible runout. */
function rigidLength(spec: DuctRunSpec): number {
  const legs = ductLegs(spec);
  const runout = spec.end.kind === 'terminal' && spec.end.flex;
  return legs.reduce((sum, leg, index) => sum + (runout && index === legs.length - 1 ? 0 : leg.lengthMm), 0);
}

/** How far the air has come from the collar where a run starts (mm): through its parents' take-offs. */
function startFromCollar(spec: DuctRunSpec, specs: ReadonlyMap<string, DuctRunSpec>, depth = 0): number {
  const parentId = ductParentRunId(spec);
  const parent = parentId ? specs.get(parentId) : undefined;
  if (!parent || depth > 32) return 0;
  const offset = spec.start.kind === 'tap' ? alongPath(parent, spec.start.legIndex, spec.start.stationMm) : rigidLength(parent);
  return startFromCollar(parent, specs, depth + 1) + offset;
}

/**
 * The requests to try for a target, in order: its trunk's shape, then (where
 * that gives no clean layout at the turned collar) the optimiser's own choice
 * of shapes, with what to say when that one is taken.
 */
export function turnRedesignAttempts(target: TurnRedesignTarget): Array<{ request: TurnRedesignTarget['request']; note: string | null }> {
  const shape = target.request.shape ?? 'optimal';
  if (shape === 'optimal') return [{ request: target.request, note: null }];
  return [
    { request: target.request, note: null },
    { request: { ...target.request, shape: 'optimal' }, note: `the optimiser chose the shapes (no clean ${shape === 'round' ? 'round' : 'rectangular'} layout fits the turned collar)` },
  ];
}

/** `a` is better than `b`: fewer errors, or as many and a lower life-cycle cost. */
export function betterAppraisal(a: DuctSystemAppraisal, b: DuctSystemAppraisal): boolean {
  return a.errors.length !== b.errors.length ? a.errors.length < b.errors.length : a.lifeCycleCost < b.lifeCycleCost;
}

/**
 * The systems a turn of `turnedIds` hands to the optimiser, with their
 * requests (`after`: the drawing as the turn left it; `before`: as it was,
 * for the accessories' places and the figures); and those it does not, with
 * the reason.
 */
export function turnRedesignTargets(
  before: readonly HvacElement[],
  after: readonly HvacElement[],
  turnedIds: ReadonlySet<string>,
  /** Terminals whose whole system turned with them (their layout still holds). */
  turnedWhole: ReadonlySet<string>,
  settings: DuctDesignSettings,
): { targets: TurnRedesignTarget[]; skipped: TurnRedesignSkip[] } {
  const targets: TurnRedesignTarget[] = [];
  const skipped: TurnRedesignSkip[] = [];
  for (const unit of after) {
    if (!turnedIds.has(unit.id) || unit.type !== 'ducted-ac') continue;
    const systems = unitDuctSystems(after, unit.id);
    if (!systems.length) continue;
    const served = systems.flatMap(({ spec }) => (spec.end.kind === 'terminal' ? [spec.end.terminalId] : []));
    if (!served.length || served.every((id) => turnedWhole.has(id))) continue;
    if (systems.some(({ spec }) => spec.locked)) {
      skipped.push({ unitId: unit.id, reason: `${nameOf(unit)}'s ducts include a locked run: they keep the turn's re-route` });
      continue;
    }
    const roots = systems.filter(({ spec }) => spec.start.kind === 'unit-port');
    const services = new Set(roots.map(({ spec }) => spec.service));
    const record = roots.find(({ spec }) => spec.initialSizing)?.spec.initialSizing ?? null;
    // The system's own constant-friction basis, per service, where it was sized so (else the life-cycle optimum).
    const sizing: AutoDuctSizingBases = {};
    for (const { spec } of roots) if (spec.sizing) sizing[spec.service] = spec.sizing;
    const trunk = roots.find(({ spec }) => spec.service === 'supply') ?? roots[0]!;
    const runIds = systems.map(({ element }) => element.id);
    // The accessories set on the runs, by where they were along the air's path (the drawing before the turn).
    const beforeSpecs = new Map(runIds.flatMap((id) => {
      const element = before.find((candidate) => candidate.id === id);
      const spec = element ? readDuctRunSpec(element) : null;
      return spec ? [[id, spec] as const] : [];
    }));
    const carried: CarriedAccessory[] = [];
    for (const spec of beforeSpecs.values()) {
      for (const accessory of spec.inline ?? []) {
        const along = alongPath(spec, accessory.legIndex, accessory.stationMm);
        const on = spec.start.kind === 'unit-port' ? 'collar-run' : spec.end.kind === 'terminal' ? 'branch' : 'between';
        carried.push({
          accessory, service: spec.service, on, terminalId: on === 'branch' && spec.end.kind === 'terminal' ? spec.end.terminalId : null,
          alongMm: on === 'branch' ? Math.max(0, rigidLength(spec) - along) : startFromCollar(spec, beforeSpecs) + along,
        });
      }
    }
    const beforeRuns = runIds.flatMap((id) => before.filter((candidate) => candidate.id === id));
    targets.push({
      unitId: unit.id,
      unitName: nameOf(unit),
      request: {
        unitId: unit.id,
        terminalIds: [...new Set(served)],
        fanSpeed: record?.fanSpeed ?? 'hi',
        ...(record?.airflowSource === 'entered' && record.airflowM3h ? { airflowM3h: record.airflowM3h } : {}),
        layout: 'auto',
        services: { supply: services.has('supply'), return: services.has('return') },
        rebuildExisting: true,
        shape: isRoundLeg(trunk.spec.legs[0]) ? 'round' : 'rect',
        sizing: Object.keys(sizing).length ? sizing : null,
      },
      runIds,
      carried,
      before: ductSystemFigures(before, beforeRuns, settings),
      openRuns: systems.filter(({ element, spec }) => spec.end.kind === 'open' && !ductBranchesOf(element.id, after).length).length,
    });
  }
  return { targets, skipped };
}

const ACCESSORY_NAMES: Record<DuctInlineAccessory['kind'], string> = { damper: 'damper', 'access-door': 'access door', attenuator: 'attenuator' };

/** The design as one command (as Auto duct's Apply makes it), with the carried accessories set again. */
export function turnRedesignCommand(
  scene: readonly HvacElement[],
  result: AutoDuctResult,
  target: TurnRedesignTarget,
  settings: DuctDesignSettings,
  designedAt: string,
  /** Said of the request the design answered (its attempt's note). */
  attemptNote: string | null = null,
): TurnRedesignCommand {
  const notes: string[] = [
    ...(attemptNote ? [attemptNote] : []),
    ...(target.openRuns ? [`${target.openRuns === 1 ? 'a run' : `${target.openRuns} runs`} left ending open served no terminal: the new design leaves ${target.openRuns === 1 ? 'it' : 'them'} out`] : []),
  ];
  // The spigots it turns and the airflows it sets, its terminals in the unit's air system (as Auto duct's Apply).
  const assigned = withSystemAssignments(autoDuctTerminalUpdates(result), result.runs, scene, result.unitId);
  let runs = stampDesignedAt(withInitialSizingRecords({
    fanSpeed: result.fanSpeed, airflowM3h: result.airflowM3h, airflowSource: result.airflowSource,
    runs: result.runs, removeIds: result.removeIds, terminalUpdates: result.terminalUpdates, terminalAirflowUpdates: result.terminalAirflowUpdates,
    services: result.services,
  }, scene, settings, 'auto-duct'), designedAt);
  const removeIds = [...new Set([...result.removeIds, ...target.runIds])];

  // ---- The accessories, set again where they were along the air's path. ----
  const sceneWith = () => [...scene.filter((element) => !removeIds.includes(element.id)), ...runs];
  const specs = () => new Map(runs.flatMap((run) => {
    const spec = readDuctRunSpec(run);
    return spec ? [[run.id, spec] as const] : [];
  }));
  for (const carried of target.carried) {
    const name = ACCESSORY_NAMES[carried.accessory.kind];
    const now = specs();
    const ofService = runs.filter((run) => now.get(run.id)?.service === carried.service);
    const toTerminal = ofService.find((run) => {
      const end = now.get(run.id)!.end;
      return end.kind === 'terminal' && end.terminalId === carried.terminalId;
    });
    // Where it goes again, in order: a branch's on the new run to its terminal (back from its end); the collar run's on
    // the new run off the collar (all the air passes it), else the nearest run there; a run between's, the nearest run.
    const pools: Array<{ runs: HvacElement[]; fromEnd: boolean }> = carried.on === 'branch'
      ? (toTerminal ? [{ runs: [toTerminal], fromEnd: true }] : [])
      : carried.on === 'collar-run'
        ? [{ runs: ofService.filter((run) => now.get(run.id)!.start.kind === 'unit-port'), fromEnd: false }, { runs: ofService, fromEnd: false }]
        : [{ runs: ofService, fromEnd: false }];
    // The pools in order; in each, the straights at that distance first, then the others nearest it.
    const candidates = pools.flatMap((pool) => pool.runs.flatMap((run) => {
      const spec = now.get(run.id)!;
      const legs = ductLegs(spec);
      const runout = spec.end.kind === 'terminal' && spec.end.flex;
      const wanted = pool.fromEnd ? rigidLength(spec) - carried.alongMm : carried.alongMm - startFromCollar(spec, now);
      return legs.flatMap((leg, index) => {
        if (leg.vertical || leg.sloped || (runout && index === legs.length - 1)) return [];
        const start = legs.slice(0, index).reduce((sum, previous) => sum + previous.lengthMm, 0);
        const station = Math.max(0, Math.min(leg.lengthMm, wanted - start));
        return [{ run, index, station, gap: Math.abs(wanted - (start + station)) }];
      });
    }).sort((a, b) => a.gap - b.gap));
    if (!candidates.length) {
      notes.push(`the ${name} could not be set again: add it on the new ducts`);
      continue;
    }
    let placed: HvacElement | null = null;
    for (const candidate of candidates) {
      const { id: _id, ...accessory } = carried.accessory;
      const edit = applyDuctSegmentEdit(sceneWith(), settings, {
        kind: 'inline-add', runId: candidate.run.id, accessory: { ...accessory, legIndex: candidate.index, stationMm: candidate.station },
      });
      const updated = edit.updates.find((element) => element.id === candidate.run.id);
      if (edit.refused || !updated) continue;
      runs = runs.map((element) => (element.id === candidate.run.id ? updated : element));
      placed = candidate.run;
      break;
    }
    if (!placed) {
      notes.push(`the ${name} found no clear straight on the new ducts: add it again`);
      continue;
    }
    // Off the run all the air passes: say where it went, for the designer to check.
    const spec = now.get(placed.id)!;
    if (carried.on === 'collar-run' && spec.start.kind !== 'unit-port') {
      const terminal = spec.end.kind === 'terminal' ? scene.find((element) => element.id === (spec.end as { terminalId: string }).terminalId) : undefined;
      notes.push(`the run off the collar has no clear straight for the ${name}: it is set on ${terminal ? `the duct to ${terminal.label || 'a terminal'}` : 'a branch of the new trunk'} instead`);
    }
  }

  const after = ductSystemFigures(sceneWith(), runs, settings);
  return { add: runs, removeIds, updates: terminalSpigotUpdates(assigned), notes, after };
}

// ---- The better of the two: the turn's re-route or the optimiser's design ----

/** How a system's runs stand: the rules they break (as the canvas checks them) and what they cost. */
export interface DuctSystemAppraisal {
  /** The error codes on its runs: the plans', the supports' and the clashes. */
  errors: string[];
  firstCost: number;
  /** The index paths' pressure, the services together (Pa). */
  espPa: number;
  /** First cost and the fan's energy over the system's life (the optimiser's own measure). */
  lifeCycleCost: number;
}

/** Appraise the runs `runIds` as they stand in `scene` (their sizes as drawn), the fan's energy at `pricePerPa`. */
export function appraiseDuctSystem(
  scene: readonly HvacElement[], runIds: readonly string[], settings: DuctDesignSettings, pricePerPa: number,
): DuctSystemAppraisal {
  const ids = new Set(runIds);
  const plans: DuctFabricationPlan[] = [];
  let espPa = 0;
  for (const element of scene) {
    if (!ids.has(element.id) || !isDuctElement(element)) continue;
    const spec = readDuctRunSpec(element);
    if (!spec || spec.legacy || spec.start.kind !== 'unit-port') continue;
    const basis = spec.sizing ?? defaultSizingBasis(settings, spec.service, null, spec.initialSizing?.fanSpeed ?? 'hi');
    // Measured, not sized: the sections as they are, planned, and the index path's pressure.
    const { report } = sizeDuctSystem(scene, element.id, { basis, measure: true, espCheck: false }, settings);
    espPa += report.pressure?.indexPa ?? 0;
    plans.push(...report.plans);
  }
  let hangers = 0;
  let straps = 0;
  for (const plan of plans) {
    for (const hanger of getDuctSupportPlan(plan, scene, settings).hangers) {
      if (hanger.kind === 'strap') straps += 1;
      else hangers += 1;
    }
  }
  const firstCost = priceDuctPlans(plans, settings, hangers, straps).total;
  const errors = validateDuctRuns(scene, settings).issues
    .filter((issue) => issue.level === 'error' && issue.entityId !== undefined && ids.has(issue.entityId))
    .map((issue) => issue.code);
  return { errors, firstCost, espPa, lifeCycleCost: firstCost + pricePerPa * espPa };
}

const RULES: Record<string, [string, string]> = {
  DU_FLEX_BEND: ['a runout bent too tight', 'runouts bent too tight'],
  DU_FLEX_LENGTH: ['a runout too long', 'runouts too long'],
  DU_LEG_TOO_SHORT: ['a straight too short for its fittings', 'straights too short for their fittings'],
  DU_CLASH: ['a clash', 'clashes'],
  DU_TAP_CLASH: ['a take-off on a fitting', 'take-offs on fittings'],
  DU_PENETRATION_FLEX: ['a flexible runout through a wall', 'flexible runouts through walls'],
  DU_PENETRATION_FITTING: ['a fitting in a wall', 'fittings in walls'],
  DU_INLINE_CLASH: ['an accessory on a fitting', 'accessories on fittings'],
};

/** Error codes in a designer's words ("2 runouts bent too tight, a clash"). */
export function describeDuctErrors(codes: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  let others = 0;
  const parts: string[] = [];
  for (const [code, count] of counts) {
    const words = RULES[code];
    if (!words) {
      others += count;
      continue;
    }
    parts.push(count === 1 ? words[0] : `${count} ${words[1]}`);
  }
  if (others) parts.push(others === 1 ? 'another error' : `${others} other errors`);
  return parts.join(', ');
}

export interface TurnRedesignChoice {
  take: 'design' | 'reroute';
  /** Why, against the other (null: nothing to add). */
  why: string | null;
}

/**
 * The better of the turn's re-route and the optimiser's design: fewer errors,
 * then the lower life-cycle cost (the design, on a tie: the optimum it found).
 */
export function chooseTurnRedesign(reroute: DuctSystemAppraisal, design: DuctSystemAppraisal, currency: string): TurnRedesignChoice {
  const ours = design.errors.length;
  const theirs = reroute.errors.length;
  const saving = reroute.lifeCycleCost - design.lifeCycleCost;
  if (ours < theirs) {
    return { take: 'design', why: `the turn's re-route would break ${describeDuctErrors(reroute.errors)}${ours ? `; this design still breaks ${describeDuctErrors(design.errors)}` : ''}` };
  }
  if (ours > theirs) {
    return { take: 'reroute', why: `the optimiser's best design breaks ${describeDuctErrors(design.errors)}; the turn's re-route ${theirs ? `breaks fewer (${describeDuctErrors(reroute.errors)})` : 'keeps every rule'}` };
  }
  if (saving >= 0) {
    return { take: 'design', why: saving >= 1 ? `${formatCost(saving, currency)} less over its life than the turn's re-route` : null };
  }
  return { take: 'reroute', why: `the turn's re-route costs ${formatCost(-saving, currency)} less over its life than the optimiser's best design` };
}
