import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuct } from './ductAutoLayout';
import { resolveDuctSettings } from './ductSettings';
import { readDuctTerminalSpec, terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec } from './ductTypes';

describe('automatic routing independent of rectangular seed layouts', () => {
  it('chooses a direct spigot side even when the placed side already has a valid route', () => {
    const unit: HvacElement = {
      id: 'unit', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0,
      width: 1084, depth: 697, height: 300, elevation: 2400, mountType: 'ceiling',
      label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
    };
    const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
    const spec = typicalTerminalSpec('square-4way', 200);
    const envelope = terminalEnvelope(spec);
    const terminals: HvacElement[] = [-1800, 1800].map((across, index) => ({
      id: `row-${index}`, type: 'diffuser', rotation: 180,
      position: { x: supply.lip.x + supply.normal.x * 1000 - supply.normal.y * across - envelope.widthMm / 2,
        y: supply.lip.y + supply.normal.y * 1000 + supply.normal.x * across - envelope.depthMm / 2 },
      width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
      elevation: 2400, mountType: 'ceiling', label: `Diffuser ${index + 1}`, supplyZoneRatio: 0.5,
      properties: { terminal: spec },
    }));
    const settings = resolveDuctSettings({ soffitMm: 3000 });
    const request = {
      unitId: unit.id, terminalIds: terminals.map((terminal) => terminal.id), fanSpeed: 'hi', shape: 'rect', layout: 'plenum',
      services: { supply: true, return: false }, rebuildExisting: false,
    } as const;
    const scene = [unit, ...terminals];
    const result = generateAutoDuct(scene, request, settings);
    const reference = result.designs.find((design) => design.label.includes('(equal friction)'))!;
    expect(reference.errors).toBe(0);
    const service = reference.services[0]!;
    expect(service.terminalUpdates.map((terminal) => readDuctTerminalSpec(terminal)?.spigotSide).sort()).toEqual(['left', 'right']);
    const directBranches = service.plans.filter((plan) => plan.spec.end.kind === 'terminal');
    expect(directBranches).toHaveLength(2);
    for (const branch of directBranches) {
      expect(branch.pieces.map((piece) => piece.kind)).toEqual(['takeoff', 'damper', 'flex']);
      expect(branch.pieces.reduce((total, piece) => total + piece.lengthMm, 0)).toBeLessThan(1200);
      expect(branch.pieces.at(-1)!.flex!.minBendRadiusMm).toBeGreaterThanOrEqual(200);
    }

    // Disabling automatic side changes preserves the placed ports and their
    // valid, longer rigid detours. The previous first-valid selection chose
    // these same 3.49 m branches even when side changes were enabled.
    const fixed = generateAutoDuct(scene, request, { ...settings, autoChooseSpigotSide: false });
    const fixedReference = fixed.designs.find((design) => design.label.includes('(equal friction)'))!;
    expect(fixedReference.errors).toBe(0);
    expect(fixedReference.services[0]!.terminalUpdates).toEqual([]);
    const fixedBranches = fixedReference.services[0]!.plans.filter((plan) => plan.spec.end.kind === 'terminal');
    expect(fixedBranches).toHaveLength(2);
    for (const branch of fixedBranches) {
      expect(branch.pieces.some((piece) => piece.kind === 'elbow')).toBe(true);
      expect(branch.pieces.reduce((total, piece) => total + piece.lengthMm, 0)).toBeGreaterThan(3000);
    }
  });

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
