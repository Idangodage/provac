import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from './ductDraft';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { applyDuctSegmentEdit } from './ductSegmentEdits';
import { resolveDuctSettings } from './ductSettings';
import { readDuctTerminalSpec, terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
/** A plan point `along` up from the supply collar (−y) and `across` to its right (+x). */
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });

/** A square Ø200 diffuser whose spigot (on its `side`) has its lip at `lip`, the lip's bottom at `lipBottomZ`. */
function diffuser(id: string, lip: Point2D, side: 'back' | 'front' | 'left' | 'right', lipBottomZ = 2385): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), spigotSide: side };
  const envelope = terminalEnvelope(spec);
  const draft: HvacElement = {
    id, type: 'diffuser', position: { x: 0, y: 0 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: 0, mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
  const at = terminalSpigotPort(draft)!.lip;
  return { ...draft, position: { x: lip.x - at.x, y: lip.y - at.y }, elevation: lipBottomZ + 100 - at.z };
}
const byId = (list: readonly HvacElement[], id: string) => list.find((element) => element.id === id)!;
const withUpdates = (before: readonly HvacElement[], updates: readonly HvacElement[]) => {
  const replaced = new Map(updates.map((element) => [element.id, element]));
  return before.map((element) => replaced.get(element.id) ?? element);
};
const errors = (list: readonly HvacElement[], id: string) => getDuctRunPlan(byId(list, id), list, settings)!.issues
  .filter((issue) => issue.severity === 'error').map((issue) => issue.code);

// ---- A straight main up 6000 from the collar; a branch off it at 3000 to a diffuser 1.8 m to its right (its spigot facing the main). ----
const main = buildDuctRunDraftElement({ port, points: [S(6000)], legSizes: [{ widthMm: 400, heightMm: 250 }] }, 'main');
const tap = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'spin-in', vcd: true }, roundLeg(200)) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
const d1 = diffuser('d1', S(3000, 1800), 'left');
const lip = terminalSpigotPort(d1)!.lip;
const branch = buildDuctRunDraftElement({
  origin: tap, points: [{ x: tap.point.x + tap.direction.x * 900, y: tap.point.y + tap.direction.y * 900 }, { x: lip.x, y: lip.y, z: lip.z - 100 }],
  legSizes: [roundLeg(200), roundLeg(200)], end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
}, 'branch');
const scene = [unit, main, d1, branch];

describe('tap-station: a take-off slid along its main, its runout branch following', () => {
  it('the drawing starts clean', () => {
    expect(errors(scene, 'main')).toEqual([]);
    expect(errors(scene, 'branch')).toEqual([]);
  });

  it('a short slide: the stub slides, its runout re-curves', () => {
    const result = applyDuctSegmentEdit(scene, settings, { kind: 'tap-station', runId: 'branch', stationMm: 3100 });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(scene, result.updates);
    expect((readDuctRunSpec(byId(after, 'branch'))!.start as { stationMm: number }).stationMm).toBe(3100);
    expect(errors(after, 'branch')).toEqual([]);
  });

  it('slid far from its terminal, the runout branch follows without breaking a rule: its spigot turns or a new elbow takes it back', () => {
    const result = applyDuctSegmentEdit(scene, settings, { kind: 'tap-station', runId: 'branch', stationMm: 4200 });
    expect(result.refused).toBeUndefined();
    const after = withUpdates(scene, result.updates);
    const spec: DuctRunSpec = readDuctRunSpec(byId(after, 'branch'))!;
    expect((spec.start as { stationMm: number }).stationMm).toBe(4200);
    expect(errors(after, 'branch')).toEqual([]);
    expect(errors(after, 'main')).toEqual([]);
    const turned = readDuctTerminalSpec(byId(after, 'd1'))!.spigotSide !== 'left';
    expect(turned || spec.path.length > 3).toBe(true);
    expect(result.notes[0]).toMatch(/spigot turns|laid again/);
    // It still ends on its terminal's spigot.
    const port = terminalSpigotPort(byId(after, 'd1'))!;
    const end = spec.path[spec.path.length - 1]!;
    expect(Math.hypot(end.x - port.lip.x, end.y - port.lip.y)).toBeLessThan(1);
  });
});
