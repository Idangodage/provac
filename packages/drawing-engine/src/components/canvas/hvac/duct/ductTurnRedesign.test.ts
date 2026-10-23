import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { planHvacMove, hvacMoveCommand } from '../move/hvacMoveModel';

import { resolveUnitAirPorts } from './ductAirPorts';
import { withSystemAssignments } from './ductAirSystems';
import { autoDuctTerminalUpdates, generateAutoDuct, terminalSpigotUpdates, type AutoDuctRequest, type AutoDuctResult } from './ductAutoLayout';
import { tapOrigin } from './ductBranchTargets';
import { legNormal } from './ductBranches';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from './ductDraft';
import { getDuctRunPlan, planDuctRun, planDuctRunSpec } from './ductFabricationPlanner';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { resolveDuctSettings } from './ductSettings';
import { stampDesignedAt, withInitialSizingRecords } from './ductSizingRecord';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec, type DuctTerminalKind } from './ductTerminals';
import {
  appraiseDuctSystem, betterAppraisal, chooseTurnRedesign, describeDuctErrors, turnRedesignAttempts, turnRedesignCommand, turnRedesignTargets,
  unitDuctSystems, type DuctSystemAppraisal, type TurnRedesignTarget,
} from './ductTurnRedesign';
import { isDuctElement, readDuctRunSpec, roundLeg } from './ductTypes';
import { findDuctClashes } from './ductVolumes';

const settings = resolveDuctSettings({ soffitMm: 3000 });
const STAMP = '2026-10-19T00:00:00.000Z';

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', airSystemTag: 'DU-1' },
};
const supplyPort = (element: HvacElement) => resolveUnitAirPorts(element).find((port) => port.kind === 'supply')!;
const supply = supplyPort(unit);
const n = supply.normal;
const t = legNormal(supply.normal);
/** A point `along` the supply collar's outward normal and `across` it, from its lip. */
const at = (along: number, across: number): Point2D => ({ x: supply.lip.x + n.x * along + t.x * across, y: supply.lip.y + n.y * along + t.y * across });

/** A terminal centred at `centre`, its spigot facing `facing`. */
function terminal(id: string, centre: Point2D, facing: Point2D, kind: DuctTerminalKind = 'square-4way'): HvacElement {
  const spec = typicalTerminalSpec(kind, 200);
  const envelope = terminalEnvelope(spec);
  const rotation = (((Math.atan2(facing.x, -facing.y) * 180) / Math.PI) + 360) % 360;
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
}

type Command = { add?: HvacElement[]; removeIds?: string[]; updates?: Array<{ id: string; updates: Partial<HvacElement> }> };
/** The drawing with a command applied (as the store applies it). */
function applied(scene: readonly HvacElement[], command: Command): HvacElement[] {
  const removed = new Set(command.removeIds ?? []);
  const added = new Set((command.add ?? []).map((element) => element.id));
  const updates = new Map((command.updates ?? []).map((entry) => [entry.id, entry.updates]));
  return [
    ...scene.filter((element) => !removed.has(element.id) && !added.has(element.id)).map((element) => {
      const update = updates.get(element.id);
      return update ? { ...element, ...update, properties: { ...element.properties, ...(update.properties ?? {}) } } : element;
    }),
    ...(command.add ?? []),
  ];
}

/** Auto duct's Apply, as the store makes it. */
function applyDesign(scene: readonly HvacElement[], result: AutoDuctResult): HvacElement[] {
  const runs = stampDesignedAt(withInitialSizingRecords({
    fanSpeed: result.fanSpeed, airflowM3h: result.airflowM3h, airflowSource: result.airflowSource,
    runs: result.runs, removeIds: result.removeIds, terminalUpdates: result.terminalUpdates, terminalAirflowUpdates: result.terminalAirflowUpdates,
    services: result.services,
  }, scene, settings, 'auto-duct'), STAMP);
  const assigned = withSystemAssignments(autoDuctTerminalUpdates(result), result.runs, scene, result.unitId);
  return applied(scene, { add: runs, removeIds: result.removeIds, updates: terminalSpigotUpdates(assigned) });
}

const runsOf = (scene: readonly HvacElement[]) => scene.filter(isDuctElement);
const errors = (scene: readonly HvacElement[]) => runsOf(scene).flatMap((run) => planDuctRun(run, { settings, scene: [...scene] })!.issues
  .filter((issue) => issue.severity === 'error').map((issue) => `${run.id}: ${issue.code}`));
const turned = (scene: readonly HvacElement[], ids: string[], angleDeg: number) => {
  const plan = planHvacMove(scene, { ids, delta: { x: 0, y: 0, z: 0 }, rotation: { angleDeg } }, { ductSettings: settings });
  return applied(scene, hvacMoveCommand(plan));
};
/**
 * The optimiser's design for a target, as the turn's re-design makes it: its trunk's shape, and where that is not clean
 * the optimiser's own choice too, the better taken; and the choice between it and the turn's re-route.
 */
const redesign = (scene: readonly HvacElement[], target: TurnRedesignTarget) => {
  let best: { result: AutoDuctResult; command: ReturnType<typeof turnRedesignCommand>; scene: HvacElement[]; appraisal: DuctSystemAppraisal } | null = null;
  for (const attempt of turnRedesignAttempts(target)) {
    const result = generateAutoDuct(scene, { ...attempt.request, walls: [], rooms: [] }, settings);
    if (!result.runs.length) continue;
    const command = turnRedesignCommand(scene, result, target, settings, STAMP, attempt.note);
    const next = applied(scene, command);
    const appraisal = appraiseDuctSystem(next, command.add.map((element) => element.id), settings, result.pricePerPa);
    if (!best || betterAppraisal(appraisal, best.appraisal)) best = { result, command, scene: next, appraisal };
    if (!appraisal.errors.length) break;
  }
  if (!best) throw new Error('no design');
  const reroute = appraiseDuctSystem(scene, target.runIds, settings, best.result.pricePerPa);
  return { ...best, reroute, choice: chooseTurnRedesign(reroute, best.appraisal, best.result.currency) };
};

// ---- An Auto-ducted FDUM22: three diffusers ahead of its supply collar. ----
const terminals = [terminal('sd1', at(2400, 1500), { x: -t.x, y: -t.y }), terminal('sd2', at(2400, -1500), t), terminal('sd3', at(4300, 0), { x: -n.x, y: -n.y })];
const request: AutoDuctRequest = {
  unitId: 'fdum', terminalIds: ['sd1', 'sd2', 'sd3'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false,
};
const designed = applyDesign([unit, ...terminals], generateAutoDuct([unit, ...terminals], request, settings));

// ---- A drawn system: a collar main up 4000 mm, a take-off at 2000 mm, its straight and a flexible runout to SAD-1. ----
const main = buildDuctRunDraftElement({ port: supply, points: [at(4000, 0)] }, 'main');
const tap = tapOrigin(main, settings, { legIndex: 0, stationMm: 2000, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 }) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
const straightEnd = { x: tap.point.x + 1500 * tap.direction.x, y: tap.point.y + 1500 * tap.direction.y };
const d1 = (() => {
  const draft = terminal('d1', { x: straightEnd.x + 400, y: straightEnd.y + 600 }, { x: 0, y: 1 });
  return { ...draft, label: 'SAD-1' };
})();
const lip = terminalSpigotPort(d1)!.lip;
const branch = buildDuctRunDraftElement({
  origin: tap, points: [straightEnd, { x: lip.x, y: lip.y, z: lip.z - 100 }], legSizes: [{ widthMm: 300, heightMm: 150 }, roundLeg(200)],
  end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
}, 'branch');
const drawn = [unit, main, branch, d1];

describe('turnRedesignTargets: which systems a turn hands to the optimiser', () => {
  it('a turned unit: its whole system (collar runs and their branch trees), with the request keeping what was chosen for it', () => {
    const after = turned(designed, ['fdum'], 90);
    const { targets, skipped } = turnRedesignTargets(designed, after, new Set(['fdum']), new Set(), settings);
    expect(skipped).toEqual([]);
    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(target!.unitName).toBe('DU-1');
    expect(target!.runIds.sort()).toEqual(runsOf(designed).map((run) => run.id).sort());
    expect([...target!.request.terminalIds].sort()).toEqual(['sd1', 'sd2', 'sd3']);
    expect(target!.request).toMatchObject({
      unitId: 'fdum', fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: true,
    });
    expect(target!.before.lengthMm).toBeGreaterThan(0);
    expect(target!.openRuns).toBe(0);
  });

  it('nothing to do: a unit turned with every terminal its system serves (it turned whole), a unit with no ducts, a terminal alone', () => {
    const after = turned(designed, ['fdum', 'sd1', 'sd2', 'sd3'], 90);
    expect(turnRedesignTargets(designed, after, new Set(['fdum', 'sd1', 'sd2', 'sd3']), new Set(['sd1', 'sd2', 'sd3']), settings).targets).toEqual([]);
    const bare = [unit, ...terminals];
    expect(turnRedesignTargets(bare, turned(bare, ['fdum'], 90), new Set(['fdum']), new Set(), settings)).toEqual({ targets: [], skipped: [] });
    expect(turnRedesignTargets(designed, turned(designed, ['sd1'], 90), new Set(['sd1']), new Set(), settings).targets).toEqual([]);
  });

  it('a system with a locked run keeps the turn\'s own re-route, and says why', () => {
    const [first] = runsOf(designed);
    const locked = designed.map((element) => (element.id === first!.id
      ? { ...element, properties: { ...element.properties, ductRun: { ...(element.properties.ductRun as object), locked: true } } }
      : element));
    expect(readDuctRunSpec(locked.find((element) => element.id === first!.id)!)!.locked).toBe(true);
    const { targets, skipped } = turnRedesignTargets(locked, locked, new Set(['fdum']), new Set(), settings);
    expect(targets).toEqual([]);
    expect(skipped).toEqual([{ unitId: 'fdum', reason: 'DU-1\'s ducts include a locked run: they keep the turn\'s re-route' }]);
  });

  it('a drawn system: the main and its take-off branch, the trunk\'s shape kept, no sizing basis to keep', () => {
    const after = turned(drawn, ['fdum'], 90);
    const { targets } = turnRedesignTargets(drawn, after, new Set(['fdum']), new Set(), settings);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.runIds.sort()).toEqual(['branch', 'main']);
    expect(targets[0]!.request).toMatchObject({ terminalIds: ['d1'], shape: 'rect', sizing: null, fanSpeed: 'hi' });
    expect(unitDuctSystems(after, 'fdum').map(({ element }) => element.id)).toEqual(['main', 'branch']);
  });
});

describe('turnRedesignCommand: the optimiser\'s design for the turned collar', () => {
  for (const angle of [90, 180, -90, 45]) {
    it(`turned ${angle}°: new runs from the turned collar serve every terminal, the old ones go; the better of it and the re-route is chosen`, () => {
      const after = turned(designed, ['fdum'], angle);
      const [target] = turnRedesignTargets(designed, after, new Set(['fdum']), new Set(), settings).targets;
      const { command, scene, appraisal, reroute, choice } = redesign(after, target!);
      // The choice: never more errors than the other, and as many only where it costs no more over its life.
      const [kept, other] = choice.take === 'design' ? [appraisal, reroute] : [reroute, appraisal];
      expect(kept.errors.length).toBeLessThanOrEqual(other.errors.length);
      if (kept.errors.length === other.errors.length && choice.take === 'reroute') expect(kept.lifeCycleCost).toBeLessThan(other.lifeCycleCost);
      expect(command.add.length).toBeGreaterThan(0);
      for (const id of target!.runIds) expect(command.removeIds).toContain(id);
      const runs = runsOf(scene);
      expect(runs.every((run) => !target!.runIds.includes(run.id))).toBe(true);
      for (const id of ['sd1', 'sd2', 'sd3']) {
        expect(runs.some((run) => { const spec = readDuctRunSpec(run)!; return spec.end.kind === 'terminal' && spec.end.terminalId === id; }), id).toBe(true);
      }
      // The new collar run leaves the turned collar along its outward normal.
      const port = supplyPort(scene.find((element) => element.id === 'fdum')!);
      const collar = runs.map((run) => readDuctRunSpec(run)!).find((spec) => spec.start.kind === 'unit-port' && spec.start.unitId === 'fdum')!;
      expect(collar.path[0]!.x).toBeCloseTo(port.lip.x, 3);
      expect(collar.path[0]!.y).toBeCloseTo(port.lip.y, 3);
      // Designed as Auto duct designs: the system's sizing record on its collar run, dated.
      expect(collar.initialSizing).toMatchObject({ origin: 'auto-duct', fanSpeed: 'hi', designedAt: STAMP });
      expect(command.after.lengthMm).toBeGreaterThan(0);
    }, 60_000);
  }

  it('in open space: at 45° the design replaces the re-route (which clashes); at 90° the re-route, clean and cheaper, is kept', () => {
    const at45 = turned(designed, ['fdum'], 45);
    const target45 = turnRedesignTargets(designed, at45, new Set(['fdum']), new Set(), settings).targets[0]!;
    const r45 = redesign(at45, target45);
    expect(r45.reroute.errors).toContain('DU_CLASH');
    // Turned 45°, the re-route also runs back over itself: a clash of its own.
    expect(findDuctClashes(at45, settings, []).filter((clash) => target45.runIds.includes(clash.ductId)).map((clash) => clash.kind)).toContain('self');
    expect(r45.appraisal.errors).toEqual([]);
    expect(r45.choice).toEqual({ take: 'design', why: 'the turn\'s re-route would break 2 clashes' });
    const at90 = turned(designed, ['fdum'], 90);
    const r90 = redesign(at90, turnRedesignTargets(designed, at90, new Set(['fdum']), new Set(), settings).targets[0]!);
    expect(r90.reroute.errors).toEqual([]);
    expect(r90.choice.take).toBe('reroute');
    expect(r90.choice.why).toMatch(/^the turn's re-route costs USD [\d,]+ less over its life than the optimiser's best design$/);
  }, 60_000);

  it('a drawn system: one design from the turned collar to SAD-1, the drawn main and branch replaced', () => {
    const after = turned(drawn, ['fdum'], 90);
    const [target] = turnRedesignTargets(drawn, after, new Set(['fdum']), new Set(), settings).targets;
    const { command, scene } = redesign(after, target!);
    expect(command.removeIds).toEqual(expect.arrayContaining(['main', 'branch']));
    const ends = runsOf(scene).map((run) => readDuctRunSpec(run)!.end).filter((end) => end.kind === 'terminal');
    expect(ends).toEqual([expect.objectContaining({ terminalId: 'd1' })]);
    expect(errors(scene)).toEqual([]);
  }, 60_000);

  it('a door on the collar run goes back on the new collar run, at the same distance from the collar', () => {
    const root = runsOf(designed).find((run) => readDuctRunSpec(run)!.start.kind === 'unit-port')!;
    const withDoor = applyDuctSegmentEdit(designed, settings, { kind: 'inline-add', runId: root.id, accessory: { kind: 'access-door', legIndex: 0, stationMm: 700 } });
    expect(withDoor.refused).toBeFalsy();
    const before = designed.map((element) => withDoor.updates.find((update) => update.id === element.id) ?? element);
    const door = readDuctRunSpec(before.find((element) => element.id === root.id)!)!.inline![0]!;
    const after = turned(before, ['fdum'], 90);
    const [target] = turnRedesignTargets(before, after, new Set(['fdum']), new Set(), settings).targets;
    expect(target!.carried).toEqual([{ accessory: door, service: 'supply', on: 'collar-run', terminalId: null, alongMm: door.stationMm }]);
    const { command, scene } = redesign(after, target!);
    expect(command.notes.join(' ')).not.toMatch(/access door/);
    const placed = runsOf(scene).flatMap((run) => (readDuctRunSpec(run)!.inline ?? []).filter((accessory) => accessory.kind === 'access-door').map((accessory) => ({ run, accessory })));
    expect(placed).toHaveLength(1);
    expect(readDuctRunSpec(placed[0]!.run)!.start.kind).toBe('unit-port');
  }, 60_000);

  it('a damper on a branch goes back on the new run to its terminal, at the same distance before that run ends', () => {
    // The drawn branch to SAD-1: its 1500 mm straight, the damper 400 mm before the runout.
    const withDamper = applyDuctSegmentEdit(drawn, settings, { kind: 'inline-add', runId: 'branch', accessory: { kind: 'damper', legIndex: 0, stationMm: 1100 } });
    expect(withDamper.refused).toBeFalsy();
    const before = drawn.map((element) => withDamper.updates.find((update) => update.id === element.id) ?? element);
    const damper = readDuctRunSpec(before.find((element) => element.id === 'branch')!)!.inline![0]!;
    const after = turned(before, ['fdum'], 90);
    const [target] = turnRedesignTargets(before, after, new Set(['fdum']), new Set(), settings).targets;
    expect(target!.carried).toEqual([{ accessory: damper, service: 'supply', on: 'branch', terminalId: 'd1', alongMm: expect.closeTo(1500 - damper.stationMm, 0) }]);
    const { command, scene } = redesign(after, target!);
    expect(command.notes.join(' ')).not.toMatch(/damper/);
    const holders = runsOf(scene).filter((run) => (readDuctRunSpec(run)!.inline ?? []).some((accessory) => accessory.kind === 'damper'));
    expect(holders).toHaveLength(1);
    expect(readDuctRunSpec(holders[0]!)!.end).toMatchObject({ kind: 'terminal', terminalId: 'd1' });
  }, 60_000);

  it('the trunk\'s shape first; where no layout of it fits the turned collar, the optimiser chooses the shapes (and says so)', () => {
    const after = turned(designed, ['fdum'], 90);
    const [target] = turnRedesignTargets(designed, after, new Set(['fdum']), new Set(), settings).targets;
    const round = { ...target!, request: { ...target!.request, shape: 'round' as const } };
    expect(turnRedesignAttempts(round)).toEqual([
      { request: round.request, note: null },
      { request: { ...round.request, shape: 'optimal' }, note: 'the optimiser chose the shapes (no clean round layout fits the turned collar)' },
    ]);
    const free = { ...target!, request: { ...target!.request, shape: 'optimal' as const } };
    expect(turnRedesignAttempts(free)).toEqual([{ request: free.request, note: null }]);
  });
});

describe("appraising and choosing: the turn's re-route or the optimiser's design", () => {
  const at = (errors: string[], lifeCycleCost: number): DuctSystemAppraisal => ({ errors, firstCost: lifeCycleCost - 50, espPa: 25, lifeCycleCost });

  it('a system appraised as the canvas checks it: no errors on the Auto design, its cost and its fan pressure', () => {
    const appraisal = appraiseDuctSystem(designed, runsOf(designed).map((run) => run.id), settings, 2);
    expect(appraisal.errors).toEqual([]);
    expect(appraisal.firstCost).toBeGreaterThan(100);
    expect(appraisal.espPa).toBeGreaterThan(5);
    expect(appraisal.lifeCycleCost).toBeCloseTo(appraisal.firstCost + 2 * appraisal.espPa, 6);
  });

  it('errors in a designer\'s words', () => {
    expect(describeDuctErrors(['DU_FLEX_BEND', 'DU_CLASH', 'DU_FLEX_BEND', 'DU_SOMETHING'])).toBe('2 runouts bent too tight, a clash, another error');
    expect(describeDuctErrors(['DU_LEG_TOO_SHORT'])).toBe('a straight too short for its fittings');
    expect(describeDuctErrors([])).toBe('');
  });

  it('fewer errors win; as many, the lower life-cycle cost; a tie goes to the design (the optimum it found)', () => {
    expect(chooseTurnRedesign(at(['DU_CLASH'], 500), at([], 900), 'USD')).toEqual({ take: 'design', why: 'the turn\'s re-route would break a clash' });
    expect(chooseTurnRedesign(at([], 500), at(['DU_FLEX_BEND', 'DU_FLEX_BEND'], 300), 'USD'))
      .toEqual({ take: 'reroute', why: 'the optimiser\'s best design breaks 2 runouts bent too tight; the turn\'s re-route keeps every rule' });
    expect(chooseTurnRedesign(at(['DU_CLASH'], 500), at(['DU_CLASH', 'DU_FLEX_BEND'], 300), 'USD'))
      .toEqual({ take: 'reroute', why: 'the optimiser\'s best design breaks a clash, a runout bent too tight; the turn\'s re-route breaks fewer (a clash)' });
    expect(chooseTurnRedesign(at(['DU_CLASH', 'DU_CLASH'], 500), at(['DU_FLEX_BEND'], 900), 'USD'))
      .toEqual({ take: 'design', why: 'the turn\'s re-route would break 2 clashes; this design still breaks a runout bent too tight' });
    expect(chooseTurnRedesign(at([], 640), at([], 600), 'USD')).toEqual({ take: 'design', why: 'USD 40 less over its life than the turn\'s re-route' });
    expect(chooseTurnRedesign(at([], 600), at([], 640), 'USD')).toEqual({ take: 'reroute', why: 'the turn\'s re-route costs USD 40 less over its life than the optimiser\'s best design' });
    expect(chooseTurnRedesign(at([], 600), at([], 600), 'USD')).toEqual({ take: 'design', why: null });
    // Between two designs: strictly better only (a tie keeps the first tried, the trunk's own shape).
    expect(betterAppraisal(at([], 700), at(['DU_CLASH'], 400))).toBe(true);
    expect(betterAppraisal(at([], 600), at([], 600))).toBe(false);
  });
});

describe('a run\'s plan follows the terminal it ends on', () => {
  it('turning SAD-1\'s spigot (the run unchanged) plans the runout anew, as a fresh plan does', () => {
    const run = drawn.find((element) => element.id === 'branch')!;
    const first = getDuctRunPlan(run, drawn, settings)!;
    const spec = d1.properties.terminal as Record<string, unknown>;
    const sides = ['back', 'left', 'front', 'right'].filter((side) => side !== (spec.spigotSide ?? 'back'));
    for (const side of sides) {
      const scene = drawn.map((element) => (element.id === 'd1' ? { ...element, properties: { ...element.properties, terminal: { ...spec, spigotSide: side } } } : element));
      const cached = getDuctRunPlan(run, scene, settings)!;
      const fresh = planDuctRunSpec(run.id, readDuctRunSpec(run)!, { settings, scene });
      expect(cached).not.toBe(first);
      expect(cached.issues.map((issue) => issue.code)).toEqual(fresh.issues.map((issue) => issue.code));
    }
  });
});
