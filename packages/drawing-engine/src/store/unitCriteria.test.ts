/**
 * Design criteria per unit: "Apply to DU-1" gives one unit its own criteria
 * and re-sizes its ducts by them, the unit and its ducts as one undo; another
 * unit and the project keep theirs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
import { applyDesignCriteriaToUnit, resizeDuctSystemOnDrawing } from '../components/canvas/hvac/duct/ductAutoController';
import { RECOMMENDED_DESIGN_CRITERIA, designCriteriaLimits, designCriteriaSettings, readUnitCriteria } from '../components/canvas/hvac/duct/ductDesignCriteria';
import { buildDuctRunDraftElement } from '../components/canvas/hvac/duct/ductDraft';
import { resolveDuctSettings } from '../components/canvas/hvac/duct/ductSettings';
import { defaultSizingBasis } from '../components/canvas/hvac/duct/ductSystemSizing';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from '../components/canvas/hvac/duct/ductTerminals';
import { readDuctRunSpec } from '../components/canvas/hvac/duct/ductTypes';
import type { HvacElement } from '../types';

import { useDrawingStore } from './index';

const project = resolveDuctSettings(designCriteriaSettings(RECOMMENDED_DESIGN_CRITERIA));
const state = () => useDrawingStore.getState();

/** A unit at `x` with one supply run of 3 m to a Ø200 diffuser. */
function system(id: string, x: number): HvacElement[] {
  const unit: HvacElement = {
    id, type: 'ducted-ac', position: { x, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2600,
    mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
  };
  const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  const centre = { x: port.lip.x, y: port.lip.y - 3600 };
  const terminal: HvacElement = {
    id: `${id}-d`, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2600, mountType: 'ceiling',
    label: `${id}-d`, supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
  const spigot = terminalSpigotPort(terminal)!;
  const run = buildDuctRunDraftElement({
    port, points: [{ x: port.lip.x, y: port.lip.y - 2400 }, { x: spigot.lip.x, y: spigot.lip.y, z: spigot.lip.z - spigot.heightMm / 2 }],
    end: { kind: 'terminal', terminalId: terminal.id, portId: spigot.portId, flex: true },
  }, `${id}-run`);
  return [unit, terminal, run];
}

const rootOf = (id: string) => readDuctRunSpec(state().hvacElements.find((element) => element.id === `${id}-run`)!)!;
const unitOf = (id: string) => state().hvacElements.find((element) => element.id === id)!;

describe('design criteria per unit', () => {
  beforeEach(() => {
    useDrawingStore.setState({ hvacElements: [...system('a', 0), ...system('b', 8000)], selectedElementIds: ['a'], selectedIds: ['a'], hoveredElementId: null });
    state().setDuctSettings(project);
    state().clearHistory();
    // Both systems sized once at the project's basis.
    for (const id of ['a', 'b']) resizeDuctSystemOnDrawing(id, 'supply', defaultSizingBasis(state().ductSettings, 'supply', null));
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
  });

  it('gives one unit its own criteria and sizes its ducts by them, in one undo', () => {
    const before = state().hvacElements;
    const office = { room: 'private-office', location: 'suspended' } as const;
    const limits = designCriteriaLimits(office);
    applyDesignCriteriaToUnit('a', office, 'Design criteria: Private office RC 30 → A');
    expect(unitOf('a').properties.designCriteria).toEqual(office);
    expect(rootOf('a').sizing?.maxVelocity).toEqual({ trunk: limits.mainMs, branch: limits.branchMs, runout: limits.runoutMs });
    // The other unit and the project keep theirs.
    expect(unitOf('b').properties.designCriteria).toBeUndefined();
    expect(rootOf('b').sizing?.maxVelocity.trunk).toBe(10.8);
    expect(state().ductSettings.designCriteria).toEqual(RECOMMENDED_DESIGN_CRITERIA);
    expect(state().ductSettings.autoMaxVelocityTrunkMs).toBe(10.8);
    // Its ducts are checked by them from now on: a re-size keeps its own limits.
    resizeDuctSystemOnDrawing('a', 'supply', defaultSizingBasis(project, 'supply', null));
    state().undo();
    state().undo();
    expect(state().hvacElements).toEqual(before);
    expect(state().selectedElementIds).toEqual(['a']);
  });

  it('goes back to the project’s criteria, the unit and its ducts in one undo', () => {
    applyDesignCriteriaToUnit('a', { room: 'ward', location: 'suspended' }, 'Design criteria: Ward → A');
    const withOwn = state().hvacElements;
    applyDesignCriteriaToUnit('a', null, 'Design criteria: A → the project’s');
    expect(readUnitCriteria(unitOf('a'))).toBeNull();
    expect(rootOf('a').sizing?.maxVelocity.trunk).toBe(10.8);
    state().undo();
    expect(state().hvacElements).toEqual(withOwn);
  });
});
