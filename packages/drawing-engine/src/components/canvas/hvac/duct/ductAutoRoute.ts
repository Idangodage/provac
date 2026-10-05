/**
 * The duct step of the unified Auto route: every ducted unit in scope gets
 * the optimiser's best life-cycle design for its terminals, one unit after the
 * other on a working scene, so each unit's ducts avoid the ones designed
 * before it. The refrigerant and condensate steps then run on that scene.
 *
 * Which terminals a unit serves:
 *  - the selected ones (Selected scope; they bring their own units), else the
 *    ones no duct serves yet;
 *  - a terminal in a unit's air system goes to that unit (its assignment, or
 *    the unit whose duct it was on before a rebuild), never to another;
 *  - the rest are shared out among the units in scope with a free collar of
 *    their service (a collar with a duct counts as free only with Rebuild
 *    ticked), balanced by airflow and kept short (airSystemAssignment.ts), and
 *    join that unit's air system when the proposal is applied;
 *  - units are designed largest airflow first.
 *
 * Only a design with no errors is proposed. A unit whose best design still has
 * errors is left as it is and reported, so it can be studied in the Auto duct
 * card, where every design and its issues are shown.
 *
 * Walls are routing obstacles and are checked again on the finished geometry.
 */
import type { HvacElement, Point2D, Wall } from '../../../../types';

import { assignmentOptions, assignmentProblemFromScene, solveAirSystemAssignment } from './airSystemAssignment';
import { listAirPorts } from './ductAirPorts';
import { airSystemTags, analyseAirSystems, readAirSystemAssignment, servingUnits, withSystemAssignments } from './ductAirSystems';
import type { AutoDuctIssue } from './ductAutoContext';
import { AUTO_DUCT_LAYOUT_LABELS, generateAutoDuct, removalTree, type AutoDuctShape } from './ductAutoLayout';
import { ductDesignSettingsKey, type DuctDesignSettings } from './ductSettings';
import type { FanSpeed } from './ductSizing';
import { basisAirflowM3h, defaultSizingBasis } from './ductSystemSizing';
import { isDuctTerminalElement, listTerminalPorts } from './ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctService } from './ductTypes';
import { withReplaced } from './optimizer/designTree';


export interface AutoRouteDuctServices {
  supply: boolean;
  return: boolean;
}

export interface AutoRouteDuctOptions {
  settings: DuctDesignSettings;
  shape: AutoDuctShape;
  fanSpeed: FanSpeed;
  /** Replace the duct already on a collar (the run and its branches). */
  rebuildExisting: boolean;
  scope: 'drawing' | 'selection';
  /** Selected scope: the ducted units and the terminals picked (either may be empty). */
  unitIds?: readonly string[];
  terminalIds?: readonly string[];
  /** Walls to avoid during routing and check against the finished geometry. */
  walls?: ReadonlyArray<Pick<Wall, 'id' | 'startPoint' | 'endPoint'> & { thickness?: number }>;
  /** Room outlines: which room each unit and terminal is in. */
  rooms?: ReadonlyArray<{ id: string; vertices: Point2D[] }>;
}

export interface AutoRouteDuctServiceSummary {
  service: DuctService;
  layout: string;
  /** The first trunk (or plenum) section, as it reads on the drawing. */
  trunk: string;
  terminals: number;
  indexPa: number | null;
}

export interface AutoRouteDuctUnit {
  unitId: string;
  unitLabel: string;
  /** designed: proposed; kept: left as it is (the note says why). */
  status: 'designed' | 'kept';
  services: AutoRouteDuctServiceSummary[];
  requiredEspPa: number | null;
  maxEspPa: number | null;
  firstCost: number | null;
  lifeCycleCost: number | null;
  currency: string;
  runIds: string[];
  /** Every tree was searched exactly. */
  exact: boolean | null;
  notes: string[];
  /** Selected candidate checks retain severity and references for actionable review. */
  diagnostics?: AutoDuctIssue[];
  terminalIds?: string[];
  /** The unit's air-system tag, and the supply and return terminals designed for it. */
  tag?: string;
  supplyTerminals?: number;
  returnTerminals?: number;
}

export interface AutoRouteDuctResult {
  elementsToAdd: HvacElement[];
  removeElementIds: string[];
  /** Terminals whose plenum-box spigot a design turns, as they will be. */
  terminalUpdates: HvacElement[];
  units: AutoRouteDuctUnit[];
  issues: string[];
  /** Explicitly selected, unserved terminals with no assignable unit/collar. */
  unservedTerminalIds?: string[];
}

export interface AutoRouteDuctProgress {
  stage: string;
  completed: number;
  total: number;
}

function servedTerminals(scene: readonly HvacElement[], except: ReadonlySet<string>): Set<string> {
  const served = new Set<string>();
  for (const element of scene) {
    if (!isDuctElement(element) || except.has(element.id)) continue;
    const end = readDuctRunSpec(element)?.end;
    if (end?.kind === 'terminal') served.add(end.terminalId);
  }
  return served;
}

function collarRuns(scene: readonly HvacElement[], unitId: string, portId: string): HvacElement[] {
  return scene.filter((element) => {
    if (!isDuctElement(element)) return false;
    const start = readDuctRunSpec(element)?.start;
    return start?.kind === 'unit-port' && start.unitId === unitId && start.portId === portId;
  });
}

function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Proper crossing of two plan segments (touching ends do not count). */
function segmentsCross(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) && ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
}

/** How many times each service's runs cross a wall's centreline. */
export function ductWallCrossings(runs: readonly HvacElement[], walls: AutoRouteDuctOptions['walls'] = []): Map<DuctService, number> {
  const out = new Map<DuctService, number>();
  for (const run of runs) {
    const spec = readDuctRunSpec(run);
    if (!spec) continue;
    for (let index = 1; index < spec.path.length; index += 1) {
      const a = spec.path[index - 1]!;
      const b = spec.path[index]!;
      for (const wall of walls) {
        if (segmentsCross(a, b, wall.startPoint, wall.endPoint)) out.set(spec.service, (out.get(spec.service) ?? 0) + 1);
      }
    }
  }
  return out;
}

function sectionText(section: { widthMm: number; heightMm: number; diameterMm?: number } | undefined): string {
  if (!section) return '—';
  return section.diameterMm ? `Ø${section.diameterMm}` : `${section.widthMm}×${section.heightMm}`;
}

export function planAutoRouteDucts(
  scene: readonly HvacElement[],
  services: AutoRouteDuctServices,
  options: AutoRouteDuctOptions,
  onProgress: (progress: AutoRouteDuctProgress) => void = () => undefined,
): AutoRouteDuctResult {
  const result: AutoRouteDuctResult = { elementsToAdd: [], removeElementIds: [], terminalUpdates: [], units: [], issues: [] };
  const wanted = (['supply', 'return'] as const).filter((service) => services[service]);
  if (!wanted.length) return result;
  const allUnits = scene.filter((element) => element.type === 'ducted-ac');
  const pickedTerminals = options.scope === 'selection' && options.terminalIds?.length ? new Set(options.terminalIds) : null;
  // Selected terminals bring the units whose air systems hold them.
  const systemsBefore = analyseAirSystems(scene, options.rooms);
  const ownersOfPicked = pickedTerminals ? [...pickedTerminals].map((id) => systemsBefore.byTerminal.get(id)?.unitId).filter((id): id is string => Boolean(id)) : [];
  const pickedUnits = options.scope === 'selection' && (options.unitIds?.length || ownersOfPicked.length)
    ? new Set([...(options.unitIds ?? []), ...ownersOfPicked]) : null;
  if (options.scope === 'selection' && !pickedUnits && !pickedTerminals) return result;
  // The units with the most air are designed first: their ducts are the largest and the least free to move.
  const units = (pickedUnits ? allUnits.filter((unit) => pickedUnits.has(unit.id)) : allUnits);
  const terminalPorts = new Map(listTerminalPorts(scene).map((port) => [port.unitId, port]));
  if (!units.length) {
    if (pickedTerminals) {
      const alreadyServed = servedTerminals(scene, new Set());
      result.unservedTerminalIds = scene.filter(element => isDuctTerminalElement(element)
        && pickedTerminals.has(element.id) && !alreadyServed.has(element.id)
        && wanted.includes(terminalPorts.get(element.id)?.kind as DuctService)).map(element => element.id);
      if (result.unservedTerminalIds.length) result.issues.push('Ducts: no ducted unit to serve the selected terminals — select the unit as well.');
    }
    return result;
  }

  // The collars each unit can take ducts on, and what replacing them removes.
  const ports = listAirPorts(scene);
  const collars = new Map<string, { unit: HvacElement; lip: { x: number; y: number }; removeIds: string[] }>();
  const replaced = new Set<string>();
  const occupied: string[] = [];
  for (const unit of units) {
    for (const service of wanted) {
      const port = ports.find((candidate) => candidate.unitId === unit.id && candidate.kind === service);
      if (!port) continue;
      const existing = collarRuns(scene, unit.id, port.portId);
      if (existing.length && !options.rebuildExisting) {
        occupied.push(`${unit.label || 'Unit'} ${service}`);
        continue;
      }
      const removeIds = existing.flatMap((run) => removalTree(run.id, scene));
      for (const id of removeIds) replaced.add(id);
      collars.set(`${unit.id}|${service}`, { unit, lip: port.lip, removeIds });
    }
  }

  // Kept duct connections already satisfy the selection. Rebuild removes
  // their served status through `replaced`; never connect one terminal twice.
  const served = servedTerminals(scene, replaced);
  const terminals = scene.filter((element) => isDuctTerminalElement(element)
    && !served.has(element.id) && (!pickedTerminals || pickedTerminals.has(element.id))
    && wanted.includes(terminalPorts.get(element.id)?.kind as DuctService));
  // Which unit serves each terminal: the one its air system names (its assignment, else the unit whose duct
  // it was on before a rebuild); the rest are shared out among the units in scope, balanced by airflow.
  const assigned = new Map<string, HvacElement[]>();
  const tags = airSystemTags(scene);
  const inScope = new Set(units.map((unit) => unit.id));
  const unitIds = new Set(allUnits.map((unit) => unit.id));
  const formerly = servingUnits(scene);
  const collarBusy: string[] = [];
  const pending: HvacElement[] = [];
  for (const terminal of terminals) {
    const service = terminalPorts.get(terminal.id)!.kind;
    const assignedTo = readAirSystemAssignment(terminal);
    const owner = assignedTo && unitIds.has(assignedTo) ? assignedTo : formerly.get(terminal.id)?.unitId ?? null;
    if (!owner) { pending.push(terminal); continue; }
    // Another unit's terminal, and that unit is not being designed: left for it.
    if (!inScope.has(owner)) continue;
    if (!collars.has(`${owner}|${service}`)) {
      collarBusy.push(`${terminal.label} (${tags.get(owner) ?? 'its unit'} ${service})`);
      continue;
    }
    assigned.set(owner, [...(assigned.get(owner) ?? []), terminal]);
  }
  let orphans = 0;
  if (pending.length) {
    const problem = assignmentProblemFromScene(scene, options.rooms ?? [], options.walls ?? [], { unitIds: [...inScope], terminalIds: pending.map((terminal) => terminal.id) });
    // Only collars this run may take ducts on.
    for (const candidate of problem.units) {
      for (const service of ['supply', 'return'] as const) if (!collars.has(`${candidate.id}|${service}`)) delete candidate.collars[service];
    }
    // Automatic: never another room's terminals unasked (cross-room service is the designer's assignment).
    const solved = solveAirSystemAssignment(problem.units, problem.terminals, problem.walls, { ...assignmentOptions(options.settings), adoptRoomsWithoutUnit: false });
    const byId = new Map(pending.map((terminal) => [terminal.id, terminal]));
    for (const entry of solved.assignments) assigned.set(entry.unitId, [...(assigned.get(entry.unitId) ?? []), byId.get(entry.terminalId)!]);
    orphans = solved.unassignable.length;
    if (pickedTerminals) for (const entry of solved.unassignable) (result.unservedTerminalIds ??= []).push(entry.terminalId);
  }
  if (occupied.length && (pickedUnits || collarBusy.length || orphans)) {
    result.issues.push(`Ducts: ${occupied.join(', ')} already ${occupied.length === 1 ? 'has' : 'have'} a duct — tick Rebuild existing ducts to replace ${occupied.length === 1 ? 'it' : 'them'}.`);
  }
  if (orphans && pickedTerminals) {
    result.issues.push(`Ducts: ${orphans} selected terminal${orphans === 1 ? ' has' : 's have'} no ducted unit with a free collar of its service to serve it.`);
  }

  const airflowOf = (unit: HvacElement) => basisAirflowM3h(unit, { airflowM3h: null, fanSpeed: options.fanSpeed }).airflowM3h ?? 0;
  const queue = units.filter((unit) => assigned.has(unit.id))
    .sort((a, b) => airflowOf(b) - airflowOf(a) || assigned.get(b.id)!.length - assigned.get(a.id)!.length || a.id.localeCompare(b.id));
  let working: HvacElement[] = [...scene];
  queue.forEach((unit, index) => {
    const label = unit.label || unit.modelLabel || 'Unit';
    onProgress({ stage: `${label} (${index + 1} of ${queue.length})`, completed: index, total: queue.length });
    const group = assigned.get(unit.id)!;
    const kinds = new Set(group.map((terminal) => terminalPorts.get(terminal.id)!.kind));
    // The project's sizing method: constant friction at its friction rates and velocity limits, or the life-cycle optimum.
    const constantFriction = options.settings.autoSizingMethod === 'constant-friction';
    const auto = generateAutoDuct(working, {
      unitId: unit.id, terminalIds: group.map((terminal) => terminal.id), fanSpeed: options.fanSpeed, layout: 'auto',
      services: { supply: kinds.has('supply'), return: kinds.has('return') }, rebuildExisting: options.rebuildExisting, shape: options.shape,
      ...(options.walls ? { walls: options.walls } : {}),
      ...(options.rooms ? { rooms: options.rooms } : {}),
      ...(constantFriction ? {
        sizing: {
          supply: defaultSizingBasis(options.settings, 'supply', null, options.fanSpeed),
          return: defaultSizingBasis(options.settings, 'return', null, options.fanSpeed),
        },
      } : {}),
    }, options.settings);
    const design = auto.designs[auto.selected] ?? null;
    const canPropose = Boolean(design && auto.runs.length && design.errors === 0);
    const diagnostics = [...new Map([...auto.issues, ...auto.services.flatMap((service) => service.issues)]
      // A rejected candidate has not turned any terminal. Do not report its
      // speculative spigot adjustments as completed changes.
      .filter((issue) => canPropose || issue.code !== 'DU_AUTO_SPIGOT')
      .map((issue) => [`${issue.code}|${issue.severity}|${issue.message}`, issue])).values()];
    const messages = [...new Set(diagnostics
      .filter((issue) => issue.severity !== 'info' || issue.code === 'DU_AUTO_SPIGOT').map((issue) => issue.message))];
    const unitResult: AutoRouteDuctUnit = {
      unitId: unit.id, unitLabel: label, status: 'kept', services: [], requiredEspPa: auto.requiredEspPa, maxEspPa: auto.maxEspPa,
      firstCost: design?.firstCost ?? null, lifeCycleCost: design?.lifeCycleCost ?? null, currency: auto.currency, runIds: [],
      exact: auto.certificate?.exact ?? null, notes: messages, diagnostics, terminalIds: group.map(terminal => terminal.id),
      tag: tags.get(unit.id) ?? label,
      supplyTerminals: group.filter((terminal) => terminalPorts.get(terminal.id)!.kind === 'supply').length,
      returnTerminals: group.filter((terminal) => terminalPorts.get(terminal.id)!.kind === 'return').length,
    };
    unitResult.services = auto.services.filter((service) => service.runs.length).map((service) => ({
      service: service.service,
      layout: `${service.layout ? AUTO_DUCT_LAYOUT_LABELS[service.layout] : '—'}${auto.sizing?.[service.service] ? ` · constant friction ${auto.sizing[service.service]!.frictionPaPerM.toFixed(2)} Pa/m` : ''}`,
      trunk: sectionText(service.trunkSections[0]),
      terminals: service.terminals.length,
      indexPa: service.pressure?.indexPa ?? null,
    }));
    if (!design || !auto.runs.length) {
      unitResult.notes = messages.length ? messages : ['No duct layout could be built for its terminals.'];
    } else if (design.errors > 0) {
      unitResult.notes = [`Its best design still has ${design.errors} issue${design.errors === 1 ? '' : 's'}; left as it is — study it in the Auto duct card.`, ...messages];
    } else {
      unitResult.status = 'designed';
      unitResult.runIds = auto.runs.map((run) => run.id);
      for (const [service, count] of ductWallCrossings(auto.runs, options.walls)) {
        unitResult.notes.unshift(`The ${service} duct crosses a wall ${count === 1 ? 'once' : `${count} times`}: it needs a sleeve there, or move the unit or its terminals so it stays in the room.`);
      }
      // The terminals its ducts serve that no system held join its air system, with the runs (one undo).
      const terminalUpdates = withSystemAssignments(auto.terminalUpdates, auto.runs, working, unit.id);
      result.elementsToAdd.push(...auto.runs);
      result.removeElementIds.push(...auto.removeIds);
      result.terminalUpdates.push(...terminalUpdates);
      const removed = new Set(auto.removeIds);
      working = [...withReplaced(working.filter((element) => !removed.has(element.id)), terminalUpdates), ...auto.runs];
    }
    result.units.push(unitResult);
    for (const note of unitResult.notes) result.issues.push(`${label}: ${note}`);
  });
  return result;
}

/** The scene as it will be once the duct proposal is applied. */
export function applyDuctProposal(scene: readonly HvacElement[], result: AutoRouteDuctResult | null): HvacElement[] {
  const turned = result?.terminalUpdates ?? [];
  if (!result || (!result.elementsToAdd.length && !result.removeElementIds.length && !turned.length)) return [...scene];
  const removed = new Set(result.removeElementIds);
  return [...withReplaced(scene.filter((element) => !removed.has(element.id)), turned), ...result.elementsToAdd];
}

/**
 * What the duct proposal was designed against: the whole drawing (everything
 * in it is an obstacle), wall geometry and duct settings. Apply refuses changes.
 */
export function ductSourceSignature(scene: readonly HvacElement[], settings: DuctDesignSettings, walls: AutoRouteDuctOptions['walls'] = []): string {
  const geometry = walls.map(wall => [wall.id, wall.startPoint, wall.endPoint, wall.thickness]);
  // Display settings (and the air-system checks) do not change a design: toggling them keeps the proposal.
  const text = JSON.stringify([scene, ductDesignSettingsKey(settings), geometry]);
  // FNV-1a, 32-bit, plus the length: a cheap fingerprint, not a security hash.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}:${hash.toString(36)}`;
}
