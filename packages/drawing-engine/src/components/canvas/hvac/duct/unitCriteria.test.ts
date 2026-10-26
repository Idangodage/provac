import { describe, expect, it } from 'vitest';

import type { HvacElement, Room } from '../../../../types';

import { RECOMMENDED_DESIGN_CRITERIA, criteriaDuctSettings, designCriteriaLimits, designCriteriaSettings } from './ductDesignCriteria';
import { resolveDuctSettings } from './ductSettings';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { designSettingsForUnit, roomCriteriaKey, unitCriteria } from './unitCriteria';

const project = resolveDuctSettings(designCriteriaSettings(RECOMMENDED_DESIGN_CRITERIA));
const office = { room: 'private-office', location: 'suspended' } as const;
const conference = { room: 'conference', location: 'suspended' } as const;
const corridor = { room: 'corridor', location: 'suspended' } as const;

const square = (id: string, x0: number, criteria?: Room['designCriteria']): Room => ({
  id, name: id, roomType: 'Custom', vertices: [{ x: x0, y: 0 }, { x: x0 + 5000, y: 0 }, { x: x0 + 5000, y: 5000 }, { x: x0, y: 5000 }],
  wallIds: [], area: 25e6, perimeter: 20000, centroid: { x: x0 + 2500, y: 2500 }, finishes: '', notes: '', fillColor: '', showLabel: true,
  adjacentRoomIds: [], hasWindows: false, validationWarnings: [], isExterior: false, properties3D: {} as Room['properties3D'],
  ...(criteria !== undefined ? { designCriteria: criteria } : {}),
});

const unit = (id: string, x: number, criteria?: unknown): HvacElement => ({
  id, type: 'ducted-ac', position: { x, y: 2000 }, rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2600,
  mountType: 'ceiling', label: id, supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W', ...(criteria ? { designCriteria: criteria } : {}) },
});

/** A diffuser at `x`, dedicated to `unitId`'s air system. */
const diffuser = (id: string, x: number, unitId: string): HvacElement => {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x, y: 3500 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: 2600, mountType: 'ceiling', label: id, supplyZoneRatio: 0.5, properties: { terminal: spec, airSystem: { unitId } },
  };
};

describe('whose design criteria a unit\'s ducts follow', () => {
  it('a room\'s, for every unit in it; another room\'s unit keeps the project\'s', () => {
    const rooms = [square('meeting', 0, conference), square('open', 6000)];
    const scene = [unit('a', 1000), unit('b', 3000), unit('c', 7000)];
    for (const id of ['a', 'b']) {
      const resolved = unitCriteria(project, scene.find((element) => element.id === id), { scene, rooms });
      expect(resolved.whose).toEqual({ kind: 'room', roomId: 'meeting' });
      expect(resolved.criteria).toEqual(conference);
      expect(resolved.settings.autoMaxVelocityTrunkMs).toBe(designCriteriaLimits(conference).mainMs);
    }
    const c = unitCriteria(project, scene[2], { scene, rooms });
    expect(c.whose).toEqual({ kind: 'project' });
    // The project's settings themselves (caches keyed by them stay warm); a room's, the same object each time.
    expect(c.settings).toBe(project);
    expect(designSettingsForUnit(project, scene[0], { scene, rooms })).toBe(designSettingsForUnit(project, scene[1], { scene, rooms }));
  });

  it('the unit\'s own over its room\'s', () => {
    const rooms = [square('meeting', 0, conference)];
    const scene = [unit('a', 1000, corridor)];
    const resolved = unitCriteria(project, scene[0], { scene, rooms });
    expect(resolved.whose).toEqual({ kind: 'unit' });
    expect(resolved.criteria).toEqual(corridor);
    expect(resolved.roomIds).toEqual(['meeting']);
  });

  it('a unit in a corridor serving an office is designed by the office (the stricter)', () => {
    const rooms = [square('corridor', 0, corridor), square('office', 6000, office)];
    const scene = [unit('a', 1000), diffuser('d1', 7000, 'a'), diffuser('d2', 2000, 'a')];
    const resolved = unitCriteria(project, scene[0], { scene, rooms });
    expect(resolved.whose).toEqual({ kind: 'room', roomId: 'office' });
    expect(resolved.roomIds).toEqual(['office', 'corridor']);
    expect(resolved.settings).toBe(criteriaDuctSettings(project, office));
  });

  it('a served room without criteria counts as the project\'s', () => {
    const strict = resolveDuctSettings(designCriteriaSettings(office));
    const rooms = [square('open', 0, RECOMMENDED_DESIGN_CRITERIA), square('plain', 6000)];
    const scene = [unit('a', 1000), diffuser('d1', 1500, 'a'), diffuser('d2', 7000, 'a')];
    // The project (RC 30) is stricter than the open office (RC 40) the other room has.
    expect(unitCriteria(strict, scene[0], { scene, rooms }).whose).toEqual({ kind: 'project' });
    // Where every served room has its own, the project's is not among them.
    const both = [square('open', 0, RECOMMENDED_DESIGN_CRITERIA), square('lab', 6000, { room: 'laboratory', location: 'shaft' })];
    expect(unitCriteria(strict, scene[0], { scene, rooms: both }).whose).toEqual({ kind: 'room', roomId: 'open' });
  });

  it('a design in hand counts its terminals\' rooms; without rooms only the unit\'s own are read', () => {
    const rooms = [square('open', 0), square('meeting', 6000, conference)];
    const scene = [unit('a', 1000), { ...diffuser('d1', 7000, 'x'), properties: { terminal: typicalTerminalSpec('square-4way', 200) } }];
    expect(unitCriteria(project, scene[0], { scene, rooms }).whose).toEqual({ kind: 'project' });
    expect(unitCriteria(project, scene[0], { scene, rooms, terminalIds: ['d1'] }).whose).toEqual({ kind: 'room', roomId: 'meeting' });
    expect(designSettingsForUnit(project, scene[0])).toBe(project);
  });

  it('keys the rooms\' criteria for a preview', () => {
    const rooms = [square('open', 0), square('meeting', 6000, conference)];
    expect(roomCriteriaKey(rooms)).toBe('meeting:conference|suspended');
    expect(roomCriteriaKey([square('open', 0)])).toBe('');
  });
});
