/**
 * The record of how a duct system was first sized (DuctSizingRecord), made
 * when a design is applied — Auto duct's Apply, Auto route's units — and kept
 * on the run off the unit's collar. The main is measured on the runs as they
 * will be stored, so a life-cycle design keeps the airflow it was designed for
 * and the main's own friction rate: what continuing it by constant friction
 * starts from. Later resizes never change it; "Reset to initial" reads it.
 */
import type { HvacElement } from '../../../../types';

import { ductRunElementWithSpec } from './ductFollow';
import type { DuctDesignSettings } from './ductSettings';
import type { FanSpeed } from './ductSizing';
import { defaultSizingBasis, sizeDuctSystem } from './ductSystemSizing';
import { readDuctTerminalSpec } from './ductTerminals';
import { isDuctElement, readDuctRunSpec, type DuctService, type DuctSizingRecord } from './ductTypes';
import { withReplaced } from './optimizer/designTree';

/** What a design brings to its record: how it was asked for, and its runs per service. */
export interface DesignForRecord {
  fanSpeed: FanSpeed;
  airflowM3h: number | null;
  airflowSource: DuctSizingRecord['airflowSource'];
  runs: readonly HvacElement[];
  removeIds?: readonly string[];
  /** Terminals the design turns or gives an airflow to, as they will be. */
  terminalUpdates?: readonly HvacElement[];
  terminalAirflowUpdates?: readonly HvacElement[];
  services: ReadonlyArray<{ service: DuctService; label: string; runs: readonly HvacElement[] }>;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The terminals as the design leaves them: turned spigots, with the airflows the card set on them. */
function terminalsAfter(scene: readonly HvacElement[], design: DesignForRecord): HvacElement[] {
  const turned = new Map((design.terminalUpdates ?? []).map((element) => [element.id, element]));
  for (const set of design.terminalAirflowUpdates ?? []) {
    const base = turned.get(set.id) ?? scene.find((element) => element.id === set.id);
    const spec = base ? readDuctTerminalSpec(base) : null;
    const airflow = readDuctTerminalSpec(set)?.designAirflowM3h ?? null;
    if (base && spec) turned.set(set.id, { ...base, properties: { ...base.properties, terminal: { ...spec, designAirflowM3h: airflow } } });
  }
  return [...turned.values()];
}

/**
 * The design's runs with the record on each system's run off the collar.
 * Pure; `designedAt` is filled in when the runs are committed (stampDesignedAt).
 */
export function withInitialSizingRecords(
  design: DesignForRecord,
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
  origin: DuctSizingRecord['origin'],
): HvacElement[] {
  const removed = new Set(design.removeIds ?? []);
  const after = [...withReplaced(scene.filter((element) => !removed.has(element.id)), terminalsAfter(scene, design)), ...design.runs];
  const stamped = new Map<string, HvacElement>();
  for (const service of design.services) {
    const root = service.runs.find((run) => readDuctRunSpec(run)?.start.kind === 'unit-port');
    const spec = root ? readDuctRunSpec(root) : null;
    if (!root || !spec) continue;
    const basis = spec.sizing ?? defaultSizingBasis(settings, service.service, null, design.fanSpeed);
    // Measured at the airflow the design was made for (whatever its source), as it will be drawn.
    const report = sizeDuctSystem(after, root.id, {
      basis: { ...basis, fanSpeed: design.fanSpeed, airflowM3h: design.airflowM3h ?? basis.airflowM3h },
      measure: true, verify: false,
    }, settings).report;
    const record: DuctSizingRecord = {
      method: spec.sizing ? 'constant-friction' : 'life-cycle',
      origin,
      label: service.label || null,
      fanSpeed: design.fanSpeed,
      airflowM3h: design.airflowM3h,
      airflowSource: design.airflowSource,
      mainVelocityMs: report.main ? round(report.main.velocityMs, 2) : null,
      mainFrictionPaPerM: report.main ? round(report.main.frictionPaPerM, 3) : null,
      maxVelocity: spec.sizing
        ? { ...spec.sizing.maxVelocity }
        : { trunk: settings.autoMaxVelocityTrunkMs, branch: settings.autoMaxVelocityBranchMs, runout: settings.autoMaxVelocityRunoutMs },
      basis: spec.sizing ?? null,
      terminals: report.terminals.map((terminal) => ({ terminalId: terminal.terminalId, airflowM3h: round(terminal.airflowM3h, 1), fixed: terminal.fixed })),
    };
    stamped.set(root.id, ductRunElementWithSpec(root, { ...spec, initialSizing: record }));
  }
  return design.runs.map((run) => stamped.get(run.id) ?? run);
}

/** The runs about to be committed with the moment their records were applied (records already dated keep theirs). */
export function stampDesignedAt(elements: readonly HvacElement[], designedAt: string): HvacElement[] {
  return elements.map((element) => {
    if (!isDuctElement(element)) return element;
    const spec = readDuctRunSpec(element);
    if (!spec?.initialSizing || spec.initialSizing.designedAt) return element;
    return ductRunElementWithSpec(element, { ...spec, initialSizing: { ...spec.initialSizing, designedAt } });
  });
}
