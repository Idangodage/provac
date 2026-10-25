/**
 * A ducted unit's air side as one system: its supply and return ducts (each a
 * constant-friction system off a collar), the fan pressure the two need
 * together against what the fan gives, the basis each system continues from,
 * how far the drawing has drifted from that basis (hand edits, new branches),
 * terminal necks that grow with their airflow, and the resize the unit panel
 * commits. Pure: a scene in, figures and changed elements out.
 */
import type { HvacElement } from '../../../../types';

import { ductBranchesOf } from './ductNetwork';
import { terminalNeckChange } from './ductSegmentEdits';
import type { DuctDesignSettings } from './ductSettings';
import { neckForAirflow, neckVelocityMs } from './ductSizing';
import {
  defaultSizingBasis,
  ductSystemRootOf,
  sizeDuctSystem,
  systemTerminalAirflows,
  type DuctSystemSizingReport,
} from './ductSystemSizing';
import { DUCT_TERMINAL_NECKS_MM } from './ductTerminalCatalog';
import { readDuctTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, type DuctRunSpec, type DuctService, type DuctSystemSizing } from './ductTypes';
import { withReplaced } from './optimizer/designTree';
import { sameLeg } from './optimizer/sizingModel';

export const DUCT_SERVICES: readonly DuctService[] = ['supply', 'return'];

export function otherDuctService(service: DuctService): DuctService {
  return service === 'supply' ? 'return' : 'supply';
}

/** A unit's duct systems: the run off each collar that has one. */
export function unitDuctSystems(scene: readonly HvacElement[], unitId: string): Array<{ service: DuctService; root: HvacElement; spec: DuctRunSpec }> {
  return DUCT_SERVICES.flatMap((service) => {
    const root = ductSystemRootOf(scene, unitId, service);
    const spec = root ? readDuctRunSpec(root) : null;
    return root && spec ? [{ service, root, spec }] : [];
  });
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Where a basis to continue by constant friction came from. */
export type ContinueBasisSource = 'stored' | 'initial' | 'drawn' | 'defaults';

export interface ContinueBasis {
  basis: DuctSystemSizing;
  from: ContinueBasisSource;
}

/**
 * The basis a system continues from: the one it was last sized at; else its
 * first sizing (a life-cycle design continues at its main's own friction rate,
 * at the fan speed and airflow it was designed for); else the main as drawn
 * (at Hi: nothing says otherwise); else the project's defaults.
 */
export function continueBasis(scene: readonly HvacElement[], unitId: string, service: DuctService, settings: DuctDesignSettings): ContinueBasis {
  const root = ductSystemRootOf(scene, unitId, service);
  const spec = root ? readDuctRunSpec(root) : null;
  if (spec?.sizing) return { basis: spec.sizing, from: 'stored' };
  const record = spec?.initialSizing;
  if (record?.basis) return { basis: record.basis, from: 'initial' };
  if (record) {
    const base: DuctSystemSizing = {
      ...defaultSizingBasis(settings, service, null, record.fanSpeed),
      maxVelocity: { ...record.maxVelocity },
      airflowM3h: record.airflowSource === 'entered' ? record.airflowM3h : null,
    };
    return {
      basis: record.mainFrictionPaPerM ? { ...base, drive: 'friction', frictionPaPerM: clamp(round(record.mainFrictionPaPerM, 2), 0.2, 3) } : base,
      from: 'initial',
    };
  }
  const defaults = defaultSizingBasis(settings, service, null, 'hi');
  if (root) {
    const main = sizeDuctSystem(scene, root.id, { basis: defaults, measure: true, verify: false }, settings).report.main;
    if (main && main.frictionPaPerM > 0) {
      return { basis: { ...defaults, drive: 'friction', frictionPaPerM: clamp(round(main.frictionPaPerM, 2), 0.2, 3) }, from: 'drawn' };
    }
  }
  return { basis: defaults, from: 'defaults' };
}

/** A service's index pressure as drawn (Pa), at the basis it continues from; null without that system. */
export function serviceIndexPa(scene: readonly HvacElement[], unitId: string, service: DuctService, settings: DuctDesignSettings): number | null {
  const root = ductSystemRootOf(scene, unitId, service);
  if (!root) return null;
  const { basis } = continueBasis(scene, unitId, service, settings);
  return sizeDuctSystem(scene, root.id, { basis, measure: true, espCheck: false }, settings).report.pressure?.indexPa ?? null;
}

/**
 * A service's system as drawn — sections, pressure, issues — at `basis` (the
 * one it continues from by default). The fan check counts the other service's
 * pressure: measured here unless given; `espCheck: false` leaves the check to
 * a caller that shows it for the unit (both services) itself.
 */
export function measureUnitService(
  scene: readonly HvacElement[], unitId: string, service: DuctService, settings: DuctDesignSettings, basis?: DuctSystemSizing,
  options: { otherServicePa?: number | null; espCheck?: boolean } = {},
): DuctSystemSizingReport | null {
  const root = ductSystemRootOf(scene, unitId, service);
  if (!root) return null;
  const otherServicePa = options.otherServicePa !== undefined ? options.otherServicePa
    : options.espCheck === false ? null : serviceIndexPa(scene, unitId, otherDuctService(service), settings);
  const used = basis ?? continueBasis(scene, unitId, service, settings).basis;
  return sizeDuctSystem(scene, root.id, { basis: used, measure: true, otherServicePa, ...(options.espCheck === false ? { espCheck: false } : {}) }, settings).report;
}

// ---- The fan: both services together ----

/** A unit's selectable ESP settings, where its maker documents them. */
export interface UnitEspSettings {
  maxPa: number | null;
  /** Settings the remote offers (Pa), ascending. */
  settingsPa?: readonly number[];
  /** The range without the extended-range switch (Pa). */
  factoryRangePa?: readonly [number, number];
  /** How the range is extended (e.g. "SW8-4 ON"). */
  extendedBy?: string;
}

export interface UnitEspCheck {
  supplyPa: number | null;
  returnPa: number | null;
  /** Supply + return index paths (Pa). */
  requiredPa: number;
  maxEspPa: number | null;
  withinFan: boolean | null;
  /** The setting to make: the smallest at or above the requirement, where settings are known. */
  setting: { pa: number; inFactoryRange: boolean; note: string | null } | null;
}

export function unitEspCheck(supplyPa: number | null, returnPa: number | null, esp: UnitEspSettings | null): UnitEspCheck {
  const requiredPa = (supplyPa ?? 0) + (returnPa ?? 0);
  const maxEspPa = esp?.maxPa ?? null;
  const settingsPa = [...(esp?.settingsPa ?? [])].sort((a, b) => a - b);
  let setting: UnitEspCheck['setting'] = null;
  if (settingsPa.length && requiredPa > 0) {
    const pa = settingsPa.find((value) => value >= requiredPa - 1e-6) ?? settingsPa[settingsPa.length - 1]!;
    const range = esp?.factoryRangePa;
    const inFactoryRange = !range || (pa >= range[0] - 1e-6 && pa <= range[1] + 1e-6);
    setting = {
      pa, inFactoryRange,
      note: inFactoryRange ? null : `outside the factory range ${range![0]}–${range![1]} Pa${esp?.extendedBy ? ` (${esp.extendedBy})` : ''}`,
    };
  }
  return { supplyPa, returnPa, requiredPa, maxEspPa, withinFan: maxEspPa === null ? null : requiredPa <= maxEspPa + 1e-6, setting };
}

// ---- Terminal necks that follow their airflow ----

export interface NeckGrowth {
  terminalId: string;
  label: string;
  fromMm: number;
  toMm: number;
  airflowM3h: number;
  /** Velocity in the old neck, and the cap it breaks (m/s). */
  velocityMs: number;
  capMs: number;
  /** Even the largest catalogue neck is over the cap. */
  stillOver: boolean;
}

/** The terminals a system serves (every run's end, through all its branches). */
function systemTerminalElements(scene: readonly HvacElement[], rootId: string): HvacElement[] {
  const byId = new Map(scene.map((element) => [element.id, element]));
  const out: HvacElement[] = [];
  const seen = new Set<string>();
  const visit = (runId: string) => {
    if (seen.has(runId)) return;
    seen.add(runId);
    const run = byId.get(runId);
    const spec = run ? readDuctRunSpec(run) : null;
    if (spec?.end.kind === 'terminal') {
      const terminal = byId.get(spec.end.terminalId);
      if (terminal && readDuctTerminalSpec(terminal)) out.push(terminal);
    }
    for (const branch of ductBranchesOf(runId, scene)) visit(branch.element.id);
  };
  visit(rootId);
  return out;
}

/**
 * Terminals whose airflow (their own, the card's, or an equal share) needs
 * more than their neck's velocity cap — the service's neck cap or the basis's
 * runout limit, whichever is lower — and the catalogue neck each would take.
 * Necks only grow: a smaller one is the designer's choice.
 */
export function necksToGrow(
  scene: readonly HvacElement[], rootId: string, basis: DuctSystemSizing,
  terminalAirflows: Readonly<Record<string, number | null>> | undefined, settings: DuctDesignSettings,
): NeckGrowth[] {
  const root = scene.find((element) => element.id === rootId);
  const spec = root ? readDuctRunSpec(root) : null;
  if (!root || !spec) return [];
  const unit = spec.start.kind === 'unit-port' ? scene.find((element) => element.id === (spec.start as { unitId: string }).unitId) : undefined;
  const terminals = systemTerminalElements(scene, rootId);
  const effective = terminals.map((terminal) => {
    const terminalSpec = readDuctTerminalSpec(terminal)!;
    const own = terminalSpec.designAirflowM3h ?? null;
    const value = terminalAirflows && Object.prototype.hasOwnProperty.call(terminalAirflows, terminal.id) ? terminalAirflows[terminal.id] ?? null : own;
    return { id: terminal.id, spec: { designAirflowM3h: value !== null && value > 0 ? value : null, neckDiameterMm: terminalSpec.neckDiameterMm } };
  });
  const { shares } = systemTerminalAirflows(unit, basis, effective);
  const neckCap = spec.service === 'return' ? settings.autoMaxNeckVelocityReturnMs : settings.autoMaxNeckVelocitySupplyMs;
  const cap = Math.min(neckCap, basis.maxVelocity.runout);
  const largest = DUCT_TERMINAL_NECKS_MM[DUCT_TERMINAL_NECKS_MM.length - 1]!;
  return terminals.flatMap((terminal, index) => {
    const terminalSpec = readDuctTerminalSpec(terminal)!;
    const airflow = shares[index]?.airflowM3h ?? 0;
    const velocity = neckVelocityMs(terminalSpec, airflow);
    if (airflow <= 0 || velocity <= cap * 1.001) return [];
    const fitting = neckForAirflow(airflow, cap);
    const toMm = fitting ?? largest;
    if (toMm <= terminalSpec.neckDiameterMm) return [];
    return [{
      terminalId: terminal.id, label: terminal.label || terminalSpec.kind, fromMm: terminalSpec.neckDiameterMm, toMm,
      airflowM3h: airflow, velocityMs: round(velocity, 2), capMs: cap, stillOver: fitting === null,
    }];
  });
}

// ---- The resize the unit panel commits ----

export interface UnitServiceSizing {
  /** Every element that changes, as it will be stored (runs, terminals): one command. */
  updates: HvacElement[];
  report: DuctSystemSizingReport;
  /** Necks grown before sizing. */
  necks: NeckGrowth[];
  /** Necks that needed to grow but stayed: the larger one would not fit the run (a new planner error). */
  keptNecks: NeckGrowth[];
}

/** The error a report adds that `before` did not have (by code and run). */
function newErrors(report: DuctSystemSizingReport, before: ReadonlySet<string>): boolean {
  return report.issues.some((issue) => issue.severity === 'error' && !before.has(`${issue.code}|${issue.runId ?? ''}`));
}

/**
 * A unit's service system sized by constant friction at `basis`: with
 * `necks`, terminal necks grown to their airflow first — each only where the
 * system still plans without a new error (a bigger runout needs longer
 * fittings) — then every section at the friction rate; the other service's
 * pressure counts in the fan check. Null without a system on that collar.
 */
export function sizeUnitService(
  scene: readonly HvacElement[], unitId: string, service: DuctService, basis: DuctSystemSizing,
  terminalAirflows: Readonly<Record<string, number | null>> | undefined, settings: DuctDesignSettings,
  options: { necks?: boolean } = {},
): UnitServiceSizing | null {
  const root = ductSystemRootOf(scene, unitId, service);
  if (!root) return null;
  // Necks on this service never change the other's ducts: its pressure is read once.
  const otherServicePa = serviceIndexPa(scene, unitId, otherDuctService(service), settings);
  const sizeOn = (working: readonly HvacElement[]) => sizeDuctSystem(working, root.id, {
    basis, otherServicePa, ...(terminalAirflows ? { terminalAirflows } : {}),
  }, settings);
  const withNecks = (growths: readonly NeckGrowth[]) => {
    let working: HvacElement[] = [...scene];
    const applied: NeckGrowth[] = [];
    for (const growth of growths) {
      const change = terminalNeckChange(working, settings, growth.terminalId, growth.toMm);
      if (change.refused || !change.updates.length) continue;
      working = withReplaced(working, change.updates);
      applied.push(growth);
    }
    return { working, applied };
  };
  const growths = options.necks ? necksToGrow(scene, root.id, basis, terminalAirflows, settings) : [];
  let working: HvacElement[] = [...scene];
  let sized = sizeOn(working);
  let grown: NeckGrowth[] = [];
  const kept: NeckGrowth[] = [];
  if (growths.length) {
    const baseline = new Set(sized.report.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.code}|${issue.runId ?? ''}`));
    const all = withNecks(growths);
    const allSized = sizeOn(all.working);
    if (!newErrors(allSized.report, baseline)) {
      ({ working } = all);
      sized = allSized;
      grown = all.applied;
    } else {
      // One at a time: keep each that plans cleanly with those kept before it.
      for (const growth of growths) {
        const trial = withNecks([...grown, growth]);
        if (trial.applied.length <= grown.length) continue;
        const trialSized = sizeOn(trial.working);
        if (newErrors(trialSized.report, baseline)) { kept.push(growth); continue; }
        working = trial.working;
        sized = trialSized;
        grown = trial.applied;
      }
    }
  }
  for (const growth of grown) {
    sized.report.issues.push({
      code: 'DU_SIZE_NECK_GROWN', severity: 'info', service, runId: root.id,
      message: `${growth.label}: neck Ø${growth.fromMm} → Ø${growth.toMm} for ${Math.round(growth.airflowM3h)} m³/h (${growth.velocityMs.toFixed(1)} m/s in Ø${growth.fromMm}, cap ${growth.capMs} m/s)${growth.stillOver ? '; still over the cap at the largest neck' : ''}.`,
    });
  }
  for (const growth of kept) {
    // Said once, with the reason: the plain neck-velocity warning for it goes.
    sized.report.issues = sized.report.issues.filter((issue) => !(issue.code === 'DU_TERMINAL_VELOCITY' && issue.message.startsWith(`${growth.label}:`)));
    sized.report.issues.push({
      code: 'DU_SIZE_NECK_KEPT', severity: 'warning', service, runId: root.id,
      message: `${growth.label} needs a Ø${growth.toMm} neck for ${Math.round(growth.airflowM3h)} m³/h, but its run has no room for the larger runout: the neck stays Ø${growth.fromMm} (${growth.velocityMs.toFixed(1)} m/s). Lengthen its runout or lower its airflow.`,
    });
  }
  sized.report.warnings = sized.report.issues.filter((issue) => issue.severity === 'warning').length;
  const final = withReplaced(working, [...sized.runs, ...sized.terminals]);
  const before = new Map(scene.map((element) => [element.id, element]));
  return { updates: final.filter((element) => before.get(element.id) !== element), report: sized.report, necks: grown, keptNecks: kept };
}

// ---- Drift: what no longer matches the basis ----

function sameRunGeometry(a: DuctRunSpec | null, b: DuctRunSpec | null): boolean {
  if (!a || !b || a.path.length !== b.path.length || a.legs.length !== b.legs.length) return false;
  if (a.path.some((point, index) => Math.hypot(point.x - b.path[index]!.x, point.y - b.path[index]!.y, point.z - b.path[index]!.z) > 0.5)) return false;
  if (a.legs.some((leg, index) => !sameLeg(leg, b.legs[index]!))) return false;
  if (a.start.kind === 'tap' && b.start.kind === 'tap') {
    return a.start.legIndex === b.start.legIndex && Math.abs(a.start.stationMm - b.start.stationMm) < 0.5 && a.start.style === b.start.style;
  }
  return true;
}

/**
 * Constant friction at `basis` as a dry run (nothing changes, nothing is
 * planned): the sections it would give — each with what set it — and the
 * runs whose sections differ from the drawing (a hand edit, a new branch, a
 * changed unit airflow, or a design never sized by constant friction).
 */
export function dryRunSizing(scene: readonly HvacElement[], rootId: string, basis: DuctSystemSizing, settings: DuctDesignSettings): { report: DuctSystemSizingReport; driftRunIds: string[] } {
  const { runs, report } = sizeDuctSystem(scene, rootId, { basis, verify: false }, settings);
  const before = new Map(scene.map((element) => [element.id, element]));
  const driftRunIds = runs.filter((run) => {
    const old = before.get(run.id);
    return Boolean(old) && old !== run && !sameRunGeometry(readDuctRunSpec(old!), readDuctRunSpec(run));
  }).map((run) => run.id);
  return { report, driftRunIds };
}

/** Runs whose sections differ from constant friction at `basis` (see dryRunSizing). */
export function systemDrift(scene: readonly HvacElement[], rootId: string, basis: DuctSystemSizing, settings: DuctDesignSettings): string[] {
  return dryRunSizing(scene, rootId, basis, settings).driftRunIds;
}
