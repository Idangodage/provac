import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { windingIssues, WINDING_EXTRA_MM, WINDING_RATIO } from './ductAutoWinding';
import { buildDuctRunDraftElement } from './ductDraft';
import { terminalEnvelope, typicalTerminalSpec, listTerminalPorts } from './ductTerminals';
import { roundLeg } from './ductTypes';

const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
const bottom = port.lip.z - port.heightMm / 2;
const at = (along: number, across: number) => ({ x: port.lip.x + across, y: port.lip.y - along, z: bottom });

/** A diffuser `along` ahead of the collar, `across` it, its spigot on `side`. */
function diffuser(id: string, along: number, across: number): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: port.lip.x + across - envelope.widthMm / 2, y: port.lip.y - along - envelope.depthMm / 2 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}
/** A run off the supply collar through `points` ([along, across]) to the diffuser's spigot. */
function runTo(id: string, terminal: HvacElement, points: Array<[number, number]>): HvacElement {
  const spigot = listTerminalPorts([terminal])[0]!;
  return buildDuctRunDraftElement({
    port, points: [...points.map(([a, c]) => at(a, c)), { x: spigot.lip.x, y: spigot.lip.y, z: spigot.lip.z - 100 }],
    legSizes: [{ widthMm: 250, heightMm: 250 }, roundLeg(200)],
    end: { kind: 'terminal', terminalId: terminal.id, portId: spigot.portId, flex: true } as never,
  }, id);
}

describe('a design that winds round to reach a terminal', () => {
  const labels = new Map([['d1', 'D1']]);
  it('a run more than three times the straight distance, and 1.5 m longer, is named with its figures', () => {
    const d1 = diffuser('d1', 1600, -800);
    // Out past it, round and back: about 7 m for a diffuser about 1.7 m away.
    const winding = runTo('w', d1, [[2600, 0], [2600, -1800], [600, -1800], [600, -800]]);
    const [issue] = windingIssues([winding], labels);
    expect(issue).toMatchObject({ code: 'DU_AUTO_WINDING', severity: 'warning', runId: 'w' });
    expect(issue!.message).toMatch(/^D1: its duct runs \d+\.\d m to reach it, \d\.\d times the \d\.\d m straight from the collar \(it winds round to come at its collar straight\)\. Moving it a little, or a top collar \(its runout then comes down from above\), may give a shorter design\.$/);
    expect(WINDING_RATIO).toBe(3);
    expect(WINDING_EXTRA_MM).toBe(1500);
  });

  it('a direct run, and a terminal right by the unit on its runout, are not', () => {
    const d1 = diffuser('d1', 2600, -1500);
    expect(windingIssues([runTo('direct', d1, [[1800, 0], [1800, -1500]])], labels)).toEqual([]);
    // Close by: three times a short distance, but not 1.5 m longer.
    const near = diffuser('d1', 700, -400);
    expect(windingIssues([runTo('near', near, [[350, 0], [350, -400]])], labels)).toEqual([]);
  });
});
