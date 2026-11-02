import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuct, selectAutoDuctDesign, terminalSpigotUpdates } from './ductAutoLayout';
import { resolveDuctSettings } from './ductSettings';
import { readDuctTerminalSpec, terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec } from './ductTypes';
import { findDuctClashes } from './ductVolumes';

const settings = resolveDuctSettings({ soffitMm: 3000 });

function fixture(rotation: number, locked = false) {
  const unit: HvacElement = {
    id: 'unit', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation,
    width: 1084, depth: 697, height: 300, elevation: 2400, mountType: 'ceiling',
    label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
  };
  const port = resolveUnitAirPorts(unit).find(value => value.kind === 'supply')!;
  const terminal = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(terminal);
  // All placed spigots face the unit. A shared cross-trunk between the rows
  // needs the near row to turn away from the unit, the previously omitted side.
  const terminals: HvacElement[] = [3000, 6500].flatMap((along, row) => [-3500, 3500].map((across, col) => ({
    id: `${row}-${col}`, type: 'diffuser', rotation: (180 + rotation) % 360,
    position: { x: port.lip.x + port.normal.x * along - port.normal.y * across - envelope.widthMm / 2,
      y: port.lip.y + port.normal.y * along + port.normal.x * across - envelope.depthMm / 2 },
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: 2400, mountType: 'ceiling', label: `${row}-${col}`, supplyZoneRatio: 0.5,
    properties: { terminal, ...(locked ? { spigotSideSetBy: 'user' } : {}) },
  })));
  const scene = [unit, ...terminals];
  const request = { unitId: unit.id, terminalIds: terminals.map(value => value.id),
    fanSpeed: 'hi', shape: 'rect', layout: 'trunk', services: { supply: true, return: false }, rebuildExisting: false } as const;
  return { scene, request, terminals, port };
}

describe('automatic diffuser connections to cross trunks', () => {
  it.each([0, 90])('offers direct connections on both sides of a shared cross-trunk at %s degrees', rotation => {
    const { scene, request, terminals, port } = fixture(rotation);
    const before = structuredClone(scene);
    const result = generateAutoDuct(scene, request, settings);
    console.log('alternatives', rotation, JSON.stringify(result.designs.map(design => ({ label: design.label, errors: design.errors, updates: design.terminalUpdates.map(t => ({ id: t.id, side: readDuctTerminalSpec(t)?.spigotSide })) }))));
    expect(result.designs[result.selected]?.errors).toBe(0);
    expect(result.runs.map(readDuctRunSpec).filter(spec => spec?.end.kind === 'terminal')).toHaveLength(terminals.length);
    // Check a selectable cross-trunk design. A different topology may win the
    // overall cost/pressure comparison; the usable side must still be offered.
    const index = result.designs.findIndex(design => design.errors === 0
      && design.services[0]?.layout === 'trunk-split'
      && ['0-0', '0-1'].every(id => design.terminalUpdates.some(element => element.id === id
        && readDuctTerminalSpec(element)?.spigotSide === 'front')));
    expect(index, 'cross-trunk with the near row facing the downstream duct').toBeGreaterThanOrEqual(0);
    const selected = selectAutoDuctDesign(result, index);
    const updates = new Map(terminalSpigotUpdates(selected.terminalUpdates).map(update => [update.id, update.updates]));
    const applied = scene.map(element => ({ ...element, ...updates.get(element.id) }));
    expect(scene).toEqual(before);
    expect(findDuctClashes([...applied, ...selected.runs], settings, [])).toEqual([]);
    const plans = selected.services.flatMap(service => service.plans);

    for (const original of terminals) {
      const final = applied.find(element => element.id === original.id)!;
      expect(final.position).toEqual(original.position);
      expect(final.rotation).toBe(original.rotation);
      const spigot = terminalSpigotPort(final)!;
      const branches = plans.filter(plan => plan.spec.end.kind === 'terminal' && plan.spec.end.terminalId === original.id);
      expect(branches).toHaveLength(1);
      const branch = branches[0]!;
      expect(branch.issues.filter(issue => issue.severity === 'error')).toEqual([]);
      expect(branch.pieces.some(piece => piece.kind === 'elbow')).toBe(false);
      const flex = branch.pieces.find(piece => piece.kind === 'flex')!;
      expect(flex.lengthMm).toBeLessThanOrEqual(settings.flexMaxLengthMm);
      expect(flex.flex!.minBendRadiusMm).toBeGreaterThanOrEqual(200);
      expect(flex.flex!.points.at(-1)!.x).toBeCloseTo(spigot.lip.x, 5);
      expect(flex.flex!.points.at(-1)!.y).toBeCloseTo(spigot.lip.y, 5);
      expect(flex.flex!.points.at(-1)!.z).toBeCloseTo(spigot.lip.z, 5);
      if (original.id.startsWith('0-')) {
        expect(spigot.normal.x * port.normal.x + spigot.normal.y * port.normal.y).toBeCloseTo(1, 5);
        expect(branch.pieces.reduce((sum, piece) => sum + piece.lengthMm, 0)).toBeLessThan(1300);
      }
    }
    expect(selected.runs.map(readDuctRunSpec).filter(spec => spec?.end.kind === 'terminal')).toHaveLength(terminals.length);
  }, 120000);

  it('preserves manually chosen spigots through generation and design selection', () => {
    const { scene, request } = fixture(0, true);
    const result = generateAutoDuct(scene, request, settings);
    expect(result.designs[result.selected]?.errors).toBe(0);
    expect(result.terminalUpdates).toEqual([]);
    expect(result.designs.every(design => design.terminalUpdates.length === 0)).toBe(true);
    expect(result.runs.map(readDuctRunSpec).filter(spec => spec?.end.kind === 'terminal')).toHaveLength(4);
  }, 120000);
});
