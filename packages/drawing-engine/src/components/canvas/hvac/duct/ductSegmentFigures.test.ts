import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { ductRunElementWithSpec } from './ductFollow';
import { buildDuctFlowTree, ductRunPieceLosses, systemPressure } from './ductPressure';
import { ductSegmentFigures } from './ductSegmentFigures';
import { ductSegments } from './ductSegments';
import { resolveDuctSettings } from './ductSettings';
import { velocityMs } from './ductSizing';
import { defaultSizingBasis, linkSizingBasis, sizeDuctSystem } from './ductSystemSizing';
import { terminalDropLookup, terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { buildDuctRunElement, readDuctRunSpec, type DuctLeg, type DuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });

function diffuser(id: string, centre: Point2D): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: null };
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 270,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}

/** A 250×250 main 9 m long with four spin-in take-offs to four diffusers; the system is sized for 1500 m³/h. */
function fourTapSystem(): { scene: HvacElement[]; rootId: string } {
  const terminals = [0, 1, 2, 3].map((k) => diffuser(`d${k}`, S(2500 + k * 1800, 2000)));
  const rootId = 'main';
  let root = buildDuctRunDraftElement({ port, points: [S(9000)], legSizes: [{ widthMm: 250, heightMm: 250 }] }, rootId);
  root = ductRunElementWithSpec(root, { ...readDuctRunSpec(root)!, sizing: linkSizingBasis({ ...defaultSizingBasis(settings, 'supply', null), airflowM3h: 1500 }, 1500) });
  const section: DuctLeg = { widthMm: 200, heightMm: 200, diameterMm: 200 };
  const branches = terminals.map((terminal, index) => {
    const origin = tapOrigin(root, settings, { legIndex: 0, stationMm: 2500 + index * 1800, side: 1, style: 'spin-in', vcd: true }, section)!;
    if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
    const lip = terminalSpigotPort(terminal)!;
    return buildDuctRunDraftElement({
      origin,
      points: [{ x: origin.point.x + origin.direction.x * 400, y: origin.point.y + origin.direction.y * 400 }, { x: lip.lip.x, y: lip.lip.y, z: lip.lip.z - lip.heightMm / 2 }],
      legSizes: [section, section],
      end: { kind: 'terminal', terminalId: terminal.id, portId: lip.portId, flex: true },
    }, `branch-${terminal.id}`);
  });
  return { scene: [unit, ...terminals, root, ...branches], rootId };
}

describe('the figures of a duct segment', () => {
  it('carry the sizing\'s own airflow: the main steps down at each take-off, each branch carries its terminal\'s share', () => {
    const { scene, rootId } = fourTapSystem();
    const main = ductSegmentFigures(scene, settings, rootId, 'leg:0')!;
    expect(main.system).toMatchObject({ rootRunId: rootId, service: 'supply', airflowM3h: 1500, unitLabel: 'FDUM22' });
    expect(main.flow!.airflowM3h).toEqual({ max: 1500, min: 0 });
    expect(main.flow!.terminals).toBe(4);
    expect(main.flow!.part).toBe('trunk');
    // 1500 m³/h in 250 × 250: 6.67 m/s, over the trunk limit.
    expect(main.flow!.velocityMs.max).toBeCloseTo(velocityMs({ widthMm: 250, heightMm: 250 }, 1500), 6);
    expect(main.flow!.velocityStatus).toBe(main.flow!.velocityMs.max > settings.autoMaxVelocityTrunkMs * 1.001 ? 'over' : main.flow!.velocityMs.max > settings.autoMaxVelocityTrunkMs * 0.9 ? 'near' : 'ok');
    // The main loses at each of its four take-offs (straight-through passage) as well as by friction.
    expect(main.flow!.passagePa).toBeGreaterThan(0);
    expect(main.flow!.frictionPa).toBeGreaterThan(0);
    expect(main.flow!.onIndexPath).toBe(true);
    // The same airflow the sizing reports for the drawn system.
    const measured = sizeDuctSystem(scene, rootId, { basis: readDuctRunSpec(scene.find((element) => element.id === rootId)!)!.sizing!, measure: true }, settings).report;
    expect(measured.terminals.map((terminal) => terminal.airflowM3h)).toEqual([375, 375, 375, 375]);

    const takeoff = ductSegmentFigures(scene, settings, 'branch-d1', 'start:takeoff')!;
    expect(takeoff.flow).toMatchObject({ airflowM3h: { max: 375, min: 375 }, terminals: 1, part: 'branch' });
    expect(takeoff.flow!.coefficient).toBeGreaterThan(0);
    const runout = ductSegmentFigures(scene, settings, 'branch-d1', 'end:flex')!;
    expect(runout.flow!.part).toBe('runout');
    expect(runout.flow!.limits.velocityMs).toBe(settings.autoMaxVelocityRunoutMs);
  });

  it('sum, piece by piece, to the pressure systemPressure finds along a single run', () => {
    const terminal = diffuser('dx', S(3000, 1500));
    const lip = terminalSpigotPort(terminal)!;
    let run = buildDuctRunDraftElement({
      port, points: [S(3000), { x: lip.lip.x, y: lip.lip.y, z: lip.lip.z - lip.heightMm / 2 }],
      legSizes: [{ widthMm: 300, heightMm: 250 }, { widthMm: 200, heightMm: 200, diameterMm: 200 }],
      end: { kind: 'terminal', terminalId: terminal.id, portId: lip.portId, flex: true },
    }, 'single');
    run = ductRunElementWithSpec(run, { ...readDuctRunSpec(run)!, sizing: linkSizingBasis({ ...defaultSizingBasis(settings, 'supply', null), airflowM3h: 500 }, 500) });
    const scene = [unit, terminal, run];
    const plan = getDuctRunPlan(run, scene, settings)!;
    const airflow = new Map([['dx', 500]]);
    const pressure = systemPressure([plan], airflow, settings, 'supply', terminalDropLookup(scene, settings));
    const losses = ductRunPieceLosses(buildDuctFlowTree([plan], airflow), 'single', 'supply')!;
    const sum = losses.reduce((total, loss) => total + loss.frictionPa + loss.fittingsPa + loss.passagePa, 0);
    expect(sum + pressure.terminals[0]!.terminalPa).toBeCloseTo(pressure.indexPa, 9);
    // And the segments partition it.
    const bySegment = ductSegments(plan).reduce((total, segment) => total + (ductSegmentFigures(scene, settings, 'single', segment.key)!.flow?.totalPa ?? 0), 0);
    expect(bySegment).toBeCloseTo(sum, 9);
  });

  it('show no flow for a run on no unit, but still how it is built', () => {
    const spec: DuctRunSpec = {
      version: 1, service: 'supply', construction: 'gi-bare', path: [{ x: 0, y: 0, z: 2600 }, { x: 3000, y: 0, z: 2600 }],
      legs: [{ widthMm: 400, heightMm: 200 }], insulationThicknessMm: 0, pressureClassPa: null, jointSystem: null,
      start: { kind: 'open' }, end: { kind: 'end-cap' }, nodeOverrides: {}, locked: false,
    };
    const loose = { ...buildDuctRunElement(spec, { id: 'loose' }), id: 'loose', rotation: 0, supplyZoneRatio: 0, category: 'accessory', properties: buildDuctRunElement(spec).properties ?? {} } as HvacElement;
    const figures = ductSegmentFigures([loose], settings, 'loose', 'leg:0');
    expect(figures).not.toBeNull();
    expect(figures!.system).toBeNull();
    expect(figures!.flow).toBeNull();
    expect(figures!.construction!.sheetMm).toBeGreaterThan(0);
    expect(figures!.fabrication.massKg).toBeGreaterThan(0);
    expect(ductSegmentFigures([loose], settings, 'loose', 'nope')).toBeNull();
  });

  it('are built once per drawing and reused for every segment of the system', () => {
    const { scene, rootId } = fourTapSystem();
    const first = ductSegmentFigures(scene, settings, rootId, 'leg:0');
    const again = ductSegmentFigures(scene, settings, rootId, 'leg:0');
    expect(again).toEqual(first);
    // A new drawing revision (a new scene array) is measured afresh.
    const next = [...scene];
    expect(ductSegmentFigures(next, settings, rootId, 'leg:0')).toEqual(first);
  });
});
