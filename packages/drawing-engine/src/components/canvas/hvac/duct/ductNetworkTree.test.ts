/**
 * The network rows: every stretch of the report once, in the order the air
 * meets them, take-offs nested after the stretch they leave the end of, a
 * split's outlets after the run's last stretch, the terminal on its run's
 * last row.
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { splitOrigin, tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { ductRunElementWithSpec } from './ductFollow';
import { ductNetworkRows, networkRowKey } from './ductNetworkTree';
import { resolveDuctSettings } from './ductSettings';
import { defaultSizingBasis, sizeDuctSystem } from './ductSystemSizing';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { buildDuctRunElement, readDuctRunSpec, type DuctLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });

function diffuser(id: string, centre: Point2D, airflowM3h: number | null = null): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: airflowM3h };
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}

const basis = (airflow: number) => ({ ...defaultSizingBasis(settings, 'supply', null), frictionPaPerM: 0.8, airflowM3h: airflow });

describe('the network rows', () => {
  it('nests each take-off after the stretch of the main it leaves, the terminal on the branch', () => {
    const terminals = [0, 1, 2, 3].map((k) => ({ ...diffuser(`d${k}`, S(2500 + k * 1800, 2000)), rotation: 270 }));
    const root = buildDuctRunDraftElement({ port, points: [S(9000)], legSizes: [{ widthMm: 250, heightMm: 250 }] }, 'main');
    const branchSection: DuctLeg = { widthMm: 200, heightMm: 200, diameterMm: 200 };
    const branches = terminals.map((terminal, index) => {
      const origin = tapOrigin(root, settings, { legIndex: 0, stationMm: 2500 + index * 1800, side: 1, style: 'spin-in', vcd: true }, branchSection)!;
      if (origin.kind !== 'tap') throw new Error('Expected a take-off origin');
      const terminalPort = terminalSpigotPort(terminal)!;
      return buildDuctRunDraftElement({
        origin,
        points: [
          { x: origin.point.x + origin.direction.x * 400, y: origin.point.y + origin.direction.y * 400 },
          { x: terminalPort.lip.x, y: terminalPort.lip.y, z: terminalPort.lip.z - terminalPort.heightMm / 2 },
        ],
        legSizes: [branchSection, branchSection],
        end: { kind: 'terminal', terminalId: terminal.id, portId: terminalPort.portId, flex: true },
      }, `branch-${terminal.id}`);
    });
    // Built in reverse, so the order comes from the stations, not the scene.
    const scene = [unit, ...terminals, root, ...branches.reverse()];
    const { report } = sizeDuctSystem(scene, 'main', { basis: basis(1500), verify: false }, settings);
    const rows = ductNetworkRows(report, scene);

    expect(rows).toHaveLength(report.sections.length);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(rows[0]!.main).toBe(true);
    expect(rows.filter((row) => row.main)).toHaveLength(1);
    // Main, branch to d0, main, branch to d1, …: the airflow steps down after each take-off.
    const runs = rows.map((row) => row.section.runId).filter((id, index, all) => index === 0 || all[index - 1] !== id);
    expect(runs).toEqual(['main', 'branch-d0', 'main', 'branch-d1', 'main', 'branch-d2', 'main', 'branch-d3', 'main']);
    const mainRows = rows.filter((row) => row.section.runId === 'main');
    expect(mainRows.map((row) => row.section.airflowM3h)).toEqual([1500, 1125, 750, 375, 0]);
    expect(mainRows.every((row) => row.depth === 0)).toBe(true);
    for (const id of ['d0', 'd1', 'd2', 'd3']) {
      const branch = rows.filter((row) => row.section.runId === `branch-${id}`);
      expect(branch.every((row) => row.depth === 1)).toBe(true);
      expect(branch.at(-1)!.terminalLabel).toBe(id.toUpperCase());
      expect(branch.slice(0, -1).every((row) => row.terminalLabel === null)).toBe(true);
    }
    expect(networkRowKey(rows[0]!.section)).toBe(rows[0]!.key);
  });

  it('puts a split\'s outlets after the run\'s last stretch, left before right', () => {
    const trunkSpec = readDuctRunSpec(buildDuctRunDraftElement({ port, points: [S(4000)], legSizes: [{ widthMm: 400, heightMm: 250 }] }, 'trunk'))!;
    const trunk = ductRunElementWithSpec(buildDuctRunDraftElement({ port, points: [S(4000)] }, 'trunk'), { ...trunkSpec, end: { kind: 'split', style: 'y' } });
    const a = diffuser('a', S(4600, 2600), 450);
    const b = diffuser('b', S(4600, -2600), 450);
    const outlet = (id: string, side: 1 | -1, terminal: HvacElement): HvacElement => {
      const origin = splitOrigin(trunk, settings, { side, style: 'y', vcd: false }, { widthMm: 350, heightMm: 250 })!;
      const point = (origin as { point: Point2D }).point;
      const direction = (origin as { direction: Point2D }).direction;
      const element = buildDuctRunDraftElement({ origin, points: [{ x: point.x + direction.x * 1500, y: point.y + direction.y * 1500 }], legSizes: [{ widthMm: 350, heightMm: 250 }] }, id);
      const spec = readDuctRunSpec(element)!;
      const lip = { x: terminal.position.x + terminal.width / 2, y: terminal.position.y + terminal.depth / 2, z: 2400 };
      return { ...element, properties: buildDuctRunElement({
        ...spec, path: [...spec.path, lip], legs: [...spec.legs, { widthMm: 200, heightMm: 200, diameterMm: 200 }],
        end: { kind: 'terminal', terminalId: terminal.id, portId: 'spigot', flex: true },
      }).properties! };
    };
    const scene = [unit, a, b, trunk, outlet('right', -1, b), outlet('left', 1, a)];
    const { report } = sizeDuctSystem(scene, 'trunk', { basis: basis(900), verify: false }, settings);
    const rows = ductNetworkRows(report, scene);
    const order = rows.map((row) => row.section.runId).filter((id, index, all) => index === 0 || all[index - 1] !== id);
    expect(order).toEqual(['trunk', 'left', 'right']);
    expect(rows.filter((row) => row.section.runId === 'trunk').every((row) => row.depth === 0)).toBe(true);
    expect(rows.filter((row) => row.section.runId !== 'trunk').every((row) => row.depth === 1)).toBe(true);
    expect(rows.filter((row) => row.terminalLabel).map((row) => row.terminalLabel)).toEqual(['A', 'B']);
  });
});
