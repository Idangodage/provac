import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { generateAutoDuct } from './ductAutoLayout';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec } from './ductTypes';
import { findDuctClashes } from './ductVolumes';

describe('dense FDUM terminal layout', () => {
  it('constructs all eleven 595/200 terminals without shortening an elbow into its flexible runout', () => {
    const unit: HvacElement = {
      id: 'fdum', type: 'ducted-ac', position: { x: 5458, y: 3351.5 }, rotation: 0,
      width: 1084, depth: 697, height: 300, elevation: 2400, mountType: 'ceiling',
      label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
    };
    const spec = typicalTerminalSpec('square-4way', 200);
    const envelope = terminalEnvelope(spec);
    const coordinates = [
      [1000, 1000], [3300, 1000], [5300, 1000], [7100, 1000], [9300, 1000], [10500, 1000],
      [1500, 3100], [2800, 3100], [4500, 3300], [8300, 2800], [10800, 2600],
    ] as const;
    const terminals: HvacElement[] = coordinates.map(([x, y], index) => ({
      id: `t${index}`, type: 'diffuser', rotation: 0,
      position: { x: x - envelope.widthMm / 2, y: y - envelope.depthMm / 2 },
      width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
      elevation: 2400, mountType: 'ceiling', label: `SD${index}`, supplyZoneRatio: 0.5,
      properties: { terminal: spec },
    }));
    const scene = [unit, ...terminals];
    const settings = resolveDuctSettings({ soffitMm: 3000, autoTimeBudgetMs: 1000 });
    const result = generateAutoDuct(scene, {
      unitId: unit.id, terminalIds: terminals.map(terminal => terminal.id),
      services: { supply: true, return: false }, fanSpeed: 'hi', shape: 'optimal',
      layout: 'auto', rebuildExisting: false,
    }, settings);
    const selected = result.designs[result.selected]!;
    expect(selected?.errors, JSON.stringify(result.issues)).toBe(0);
    const served = selected.runs.flatMap(run => {
      const end = readDuctRunSpec(run)?.end;
      return end?.kind === 'terminal' ? [end.terminalId] : [];
    });
    expect(served.sort()).toEqual(terminals.map(terminal => terminal.id).sort());

    const updates = new Map(selected.terminalUpdates.map(terminal => [terminal.id, terminal]));
    const builtScene = [...scene.map(element => updates.get(element.id) ?? element), ...selected.runs];
    expect(findDuctClashes(builtScene, settings, [])).toEqual([]);
    for (const plan of selected.services.flatMap(service => service.plans)) {
      expect(plan.issues.filter(issue => issue.severity === 'error')).toEqual([]);
      for (const piece of plan.pieces.filter(piece => piece.kind === 'flex')) {
        expect(piece.flex!.minBendRadiusMm).toBeGreaterThanOrEqual(200);
        expect(piece.lengthMm).toBeLessThanOrEqual(settings.flexMaxLengthMm);
      }
    }
    expect(Number.isFinite(selected.requiredEspPa)).toBe(true);
    expect(selected.requiredEspPa).toBeGreaterThan(0);
  }, 120000);
});
