import { beforeEach, describe, expect, it } from 'vitest';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement, Point2D } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { withSystemAssignments } from '../duct/ductAirSystems';
import { autoDuctTerminalUpdates, generateAutoDuct, terminalSpigotUpdates } from '../duct/ductAutoLayout';
import { legNormal } from '../duct/ductBranches';
import { resolveDuctSettings } from '../duct/ductSettings';
import { stampDesignedAt, withInitialSizingRecords } from '../duct/ductSizingRecord';
import { terminalEnvelope, typicalTerminalSpec } from '../duct/ductTerminals';
import { isDuctElement, readDuctRunSpec } from '../duct/ductTypes';

import { hvacMoveCommand, planHvacMove } from './hvacMoveModel';
import { cancelTurnRedesign, redesignAfterTurn, turnedBy, turnRedesignNote, useTurnRedesignStore } from './turnRedesignController';

const settings = resolveDuctSettings({ soffitMm: 3000 });
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', airSystemTag: 'DU-1' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const n = supply.normal;
const t = legNormal(n);
const at = (along: number, across: number): Point2D => ({ x: supply.lip.x + n.x * along + t.x * across, y: supply.lip.y + n.y * along + t.y * across });
function terminal(id: string, centre: Point2D, facing: Point2D): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  const rotation = (((Math.atan2(facing.x, -facing.y) * 180) / Math.PI) + 360) % 360;
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
}

// ---- An Auto-ducted FDUM22 (DU-1): three diffusers ahead of its supply collar. ----
const bare = [unit, terminal('sd1', at(2400, 1500), { x: -t.x, y: -t.y }), terminal('sd2', at(2400, -1500), t), terminal('sd3', at(4300, 0), { x: -n.x, y: -n.y })];
const first = generateAutoDuct(bare, {
  unitId: 'fdum', terminalIds: ['sd1', 'sd2', 'sd3'], fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false,
}, settings);
const designedRuns = stampDesignedAt(withInitialSizingRecords({
  fanSpeed: first.fanSpeed, airflowM3h: first.airflowM3h, airflowSource: first.airflowSource,
  runs: first.runs, removeIds: first.removeIds, terminalUpdates: first.terminalUpdates, terminalAirflowUpdates: first.terminalAirflowUpdates,
  services: first.services,
}, bare, settings, 'auto-duct'), '2026-10-19T00:00:00.000Z');
const spigots = new Map(terminalSpigotUpdates(withSystemAssignments(autoDuctTerminalUpdates(first), first.runs, bare, 'fdum')).map((entry) => [entry.id, entry.updates]));
const designed = [
  ...bare.map((element) => (spigots.has(element.id) ? { ...element, properties: { ...element.properties, ...spigots.get(element.id)!.properties } } : element)),
  ...designedRuns,
];
const designedIds = designedRuns.map((run) => run.id);

const store = () => useSmartDrawingStore.getState();
const runIds = () => store().hvacElements.filter(isDuctElement).map((run) => run.id);
/** The drawing set up as one step, then turned as the canvas turns it (the turn stored, its re-design started). */
function turnInStore(ids: string[], angleDeg: number) {
  const before = store().hvacElements;
  const plan = planHvacMove(before, { ids, delta: { x: 0, y: 0, z: 0 }, rotation: { angleDeg } }, { ductSettings: store().ductSettings });
  store().commitHvacElementCommand(plan.label, hvacMoveCommand(plan));
  return { plan, before, redesign: redesignAfterTurn({ before, ...turnedBy(plan, before), label: plan.label }) };
}

beforeEach(() => {
  store().importFromJSON('{"version":"1.0"}');
  useSmartDrawingStore.setState({ ductSettings: settings });
  store().commitHvacElementCommand('Set up', { add: designed });
  useTurnRedesignStore.setState({ busy: null });
});

describe('redesignAfterTurn: a turned unit\'s ducts re-designed by the optimiser', () => {
  it('turned 45° (the re-route clashes, the design is clean): the turn and its design are one undo step; the status says what changed', async () => {
    const setUp = JSON.stringify(store().hvacElements);
    const steps = store().history.length;
    const { plan, redesign } = turnInStore(['fdum'], 45);
    expect(store().history.length).toBe(steps + 1);
    const turnedOnly = JSON.stringify(store().hvacElements);
    // While the optimiser works: the badge's state.
    expect(useTurnRedesignStore.getState().busy).toEqual({ unitIds: ['fdum'], subject: 'DU-1\'s ducts' });
    await redesign;
    expect(useTurnRedesignStore.getState().busy).toBeNull();
    // The design joined the turn's step: no step of its own.
    expect(store().history.length).toBe(steps + 1);
    expect(store().history[store().historyIndex]!.action).toBe(`${plan.label}, ducts re-designed`);
    expect(JSON.stringify(store().hvacElements)).not.toBe(turnedOnly);
    expect(runIds().some((id) => designedIds.includes(id))).toBe(false);
    for (const id of ['sd1', 'sd2', 'sd3']) {
      expect(store().hvacElements.some((element) => {
        const spec = isDuctElement(element) ? readDuctRunSpec(element) : null;
        return spec?.end.kind === 'terminal' && spec.end.terminalId === id;
      }), id).toBe(true);
    }
    expect(store().processingStatus).toMatch(/^DU-1's ducts re-designed for the turn by the optimiser: [\d.]+ m of duct \(was [\d.]+ m\), \d+ elbows? \(was \d+\), \d+ Pa for the fan, first cost USD [\d,]+; the turn's re-route would break a clash\.$/);
    // One undo: the drawing as it was before the turn; redo: the turn with its design.
    const designedNow = JSON.stringify(store().hvacElements);
    store().undo();
    expect(JSON.stringify(store().hvacElements)).toBe(setUp);
    store().redo();
    expect(JSON.stringify(store().hvacElements)).toBe(designedNow);
  }, 60_000);

  it('turned 90° (the re-route clean and cheaper over its life): the re-route is kept, the turn stays one step, and the status says why', async () => {
    const steps = store().history.length;
    const { plan, redesign } = turnInStore(['fdum'], 90);
    const turnedOnly = JSON.stringify(store().hvacElements);
    await redesign;
    expect(useTurnRedesignStore.getState().busy).toBeNull();
    expect(JSON.stringify(store().hvacElements)).toBe(turnedOnly);
    expect(store().history.length).toBe(steps + 1);
    expect(store().history[store().historyIndex]!.action).toBe(plan.label);
    expect(store().processingStatus).toMatch(/^DU-1's ducts keep the turn's re-route: the turn's re-route costs USD [\d,]+ less over its life than the optimiser's best design\.$/);
  }, 60_000);

  it('a change meanwhile to what the design replaces: the turn keeps its re-route, and says so', async () => {
    const { redesign } = turnInStore(['fdum'], 45);
    const turnedOnly = JSON.stringify(store().hvacElements);
    // The designer drags a diffuser while the optimiser works (its own step).
    store().commitHvacElementCommand('Move SD1', { updates: [{ id: 'sd1', updates: { position: { x: 1, y: 2 } } }] });
    await redesign;
    const sd1 = store().hvacElements.find((element) => element.id === 'sd1')!;
    expect(sd1.position).toEqual({ x: 1, y: 2 });
    expect(runIds().sort()).toEqual(designedIds.slice().sort());
    expect(store().processingStatus).toMatch(/The drawing changed while the ducts were being re-designed/);
    store().undo();
    expect(JSON.stringify(store().hvacElements)).toBe(turnedOnly);
  }, 60_000);

  it('Esc (or the badge) keeps the re-route: nothing more is stored', async () => {
    const { redesign } = turnInStore(['fdum'], 90);
    const turnedOnly = JSON.stringify(store().hvacElements);
    expect(cancelTurnRedesign()).toBe(true);
    expect(useTurnRedesignStore.getState().busy).toBeNull();
    await redesign;
    expect(JSON.stringify(store().hvacElements)).toBe(turnedOnly);
    expect(store().processingStatus).toBe('The turn keeps its re-routed ducts (Auto duct can re-design them).');
    expect(cancelTurnRedesign()).toBe(false);
  }, 60_000);

  it('the readout while turning says the optimiser looks for a better design on release', () => {
    const scene = store().hvacElements;
    const plan = planHvacMove(scene, { ids: ['fdum'], delta: { x: 0, y: 0, z: 0 }, rotation: { angleDeg: 30 } }, { ductSettings: settings });
    expect(turnRedesignNote(plan, scene, settings)).toBe('On release the optimiser looks for a better design of DU-1\'s ducts for the new collar.');
    const whole = planHvacMove(scene, { ids: ['fdum', 'sd1', 'sd2', 'sd3'], delta: { x: 0, y: 0, z: 0 }, rotation: { angleDeg: 30 } }, { ductSettings: settings });
    expect(turnRedesignNote(whole, scene, settings)).toBeNull();
  });
});
