import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuct } from './ductAutoLayout';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec } from './ductTypes';

describe('automatic routing independent of rectangular seed layouts', () => {
  it('routes a round main in a void that cannot hold a rectangular take-off', () => {
    const unit: HvacElement = {
      id: 'unit', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0,
      width: 1084, depth: 697, height: 300, elevation: 2400, mountType: 'ceiling',
      label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
    };
    const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
    const spec = typicalTerminalSpec('square-4way', 200);
    const envelope = terminalEnvelope(spec);
    const terminal: HvacElement = {
      id: 'terminal', type: 'diffuser', rotation: 180, position: {
        x: supply.lip.x - envelope.widthMm / 2,
        y: supply.lip.y - 4000 - envelope.depthMm / 2,
      },
      width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
      elevation: 2400, mountType: 'ceiling', label: 'Diffuser', supplyZoneRatio: 0.5,
      properties: { terminal: spec },
    };
    const settings = resolveDuctSettings({ soffitMm: supply.lip.z - supply.heightMm / 2 + 275 });
    const result = generateAutoDuct([unit, terminal], {
      unitId: unit.id, terminalIds: [terminal.id], fanSpeed: 'hi', shape: 'round', layout: 'auto',
      services: { supply: true, return: false }, rebuildExisting: false,
    }, settings);
    expect(result.designs[result.selected]?.errors, JSON.stringify(result.issues)).toBe(0);
    expect(result.runs.some((run) => {
      const end = readDuctRunSpec(run)?.end;
      return end?.kind === 'terminal' && end.terminalId === terminal.id;
    })).toBe(true);
  });
});
