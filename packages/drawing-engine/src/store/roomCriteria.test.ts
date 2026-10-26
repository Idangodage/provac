/**
 * Design criteria per room: "Apply to Meeting Room" gives the room its
 * criteria and re-sizes every unit serving it, the room and the ducts as one
 * undo; a unit in another room, and the project, keep theirs. The room keeps
 * them through re-detection (a room the walls make anew inherits them from
 * the room it was part of) and through save and load.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUnitAirPorts } from '../components/canvas/hvac/duct/ductAirPorts';
import { applyDesignCriteriaToRoom, applyDesignCriteriaToUnit, resizeDuctSystemOnDrawing } from '../components/canvas/hvac/duct/ductAutoController';
import { RECOMMENDED_DESIGN_CRITERIA, designCriteriaLimits, designCriteriaSettings } from '../components/canvas/hvac/duct/ductDesignCriteria';
import { buildDuctRunDraftElement } from '../components/canvas/hvac/duct/ductDraft';
import { resolveDuctSettings } from '../components/canvas/hvac/duct/ductSettings';
import { defaultSizingBasis } from '../components/canvas/hvac/duct/ductSystemSizing';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from '../components/canvas/hvac/duct/ductTerminals';
import { readDuctRunSpec } from '../components/canvas/hvac/duct/ductTypes';
import { designSettingsForUnit } from '../components/canvas/hvac/duct/unitCriteria';
import type { HvacElement, Room } from '../types';

import { buildAutoDetectedRooms } from './autoDetectedRooms';

import { useDrawingStore } from './index';

const project = resolveDuctSettings(designCriteriaSettings(RECOMMENDED_DESIGN_CRITERIA));
const conference = { room: 'conference', location: 'suspended' } as const;
const state = () => useDrawingStore.getState();

/** A unit at `x` with one supply run of 3 m to a Ø200 diffuser (all at y 0 … −4000). */
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

const room = (id: string, name: string, x0: number, x1: number): Room => ({
  id, name, roomType: 'Custom', vertices: [{ x: x0, y: -5000 }, { x: x1, y: -5000 }, { x: x1, y: 1500 }, { x: x0, y: 1500 }],
  wallIds: [], area: (x1 - x0) * 6500, perimeter: 2 * (x1 - x0 + 6500), centroid: { x: (x0 + x1) / 2, y: -1750 }, finishes: '', notes: '',
  fillColor: '#fff', showLabel: true, adjacentRoomIds: [], hasWindows: false, validationWarnings: [], isExterior: false,
  properties3D: {} as Room['properties3D'],
});

const rootOf = (id: string) => readDuctRunSpec(state().hvacElements.find((element) => element.id === `${id}-run`)!)!;
const roomOf = (id: string) => state().rooms.find((entry) => entry.id === id)!;

describe('design criteria per room', () => {
  beforeEach(() => {
    useDrawingStore.setState({
      hvacElements: [...system('a', 0), ...system('b', 2500), ...system('c', 9000)],
      rooms: [room('meeting', 'Meeting Room', -1000, 5000), room('open', 'Open Space', 7000, 13000)],
      selectedElementIds: ['a'], selectedIds: ['a'], hoveredElementId: null,
    });
    state().setDuctSettings(project);
    state().clearHistory();
    for (const id of ['a', 'b', 'c']) resizeDuctSystemOnDrawing(id, 'supply', defaultSizingBasis(state().ductSettings, 'supply', null));
  });

  afterEach(() => {
    useDrawingStore.setState({ hvacElements: [], rooms: [], selectedElementIds: [], selectedIds: [], hoveredElementId: null });
    state().clearHistory();
  });

  it('gives a room its criteria and re-sizes both units in it, the room and the ducts in one undo', () => {
    const before = { hvac: state().hvacElements, rooms: state().rooms };
    const limits = designCriteriaLimits(conference);
    expect(applyDesignCriteriaToRoom('meeting', conference, 'Design criteria: Conference room RC 30 → Meeting Room').sort()).toEqual(['a', 'b']);
    expect(roomOf('meeting').designCriteria).toEqual(conference);
    for (const id of ['a', 'b']) expect(rootOf(id).sizing?.maxVelocity).toEqual({ trunk: limits.mainMs, branch: limits.branchMs, runout: limits.runoutMs });
    // The unit in the other room, and the project, keep theirs.
    expect(rootOf('c').sizing?.maxVelocity.trunk).toBe(10.8);
    expect(state().ductSettings.designCriteria).toEqual(RECOMMENDED_DESIGN_CRITERIA);
    state().undo();
    expect(state().hvacElements).toEqual(before.hvac);
    expect(state().rooms).toEqual(before.rooms);
    expect(state().selectedElementIds).toEqual(['a']);
  });

  it('a new unit in the room designs by its criteria; a unit\'s own still win; clearing goes back to the project\'s', () => {
    applyDesignCriteriaToRoom('meeting', conference, 'Design criteria: Conference room RC 30 → Meeting Room');
    const fresh = system('n', 1200)[0]!;
    const where = { scene: [...state().hvacElements, fresh], rooms: state().rooms };
    expect(designSettingsForUnit(state().ductSettings, fresh, where).autoMaxVelocityTrunkMs).toBe(designCriteriaLimits(conference).mainMs);
    applyDesignCriteriaToUnit('a', { room: 'laboratory', location: 'shaft' }, 'Design criteria: Laboratory → A');
    const labTrunk = rootOf('a').sizing?.maxVelocity.trunk;
    applyDesignCriteriaToRoom('meeting', null, 'Design criteria: Meeting Room → the project\'s');
    expect(roomOf('meeting').designCriteria).toBeNull();
    expect(rootOf('a').sizing?.maxVelocity.trunk).toBe(labTrunk);
    expect(rootOf('b').sizing?.maxVelocity.trunk).toBe(10.8);
  });

  it('records a room change with nothing to re-size as its own undo step', () => {
    const steps = state().history.length;
    applyDesignCriteriaToRoom('open', { room: 'gymnasium', location: 'shaft' }, 'Design criteria: Gymnasium → Open Space');
    expect(state().history.length).toBe(steps + 1);
    state().undo();
    expect(roomOf('open').designCriteria).toBeUndefined();
  });

  it('keeps a room\'s criteria through save and load', () => {
    state().setRoomDesignCriteria('meeting', conference);
    const json = state().exportToJSON();
    state().importFromJSON(json);
    expect(state().rooms.find((entry) => entry.id === 'meeting')?.designCriteria).toEqual(conference);
    expect(state().rooms.find((entry) => entry.id === 'open')?.designCriteria).toBeUndefined();
  });
});

describe('room criteria through re-detection', () => {
  beforeEach(() => {
    useDrawingStore.getState().importFromJSON('{"version":"1.0"}');
  });

  it('keeps them on the room detected again, and gives them to a room made anew inside it', () => {
    state().createRoomWalls({ width: 4000, height: 3000, wallThickness: 150, material: 'partition' }, { x: 500, y: 500 });
    const walls = state().walls;
    const [detected] = buildAutoDetectedRooms(walls, []);
    expect(detected).toBeDefined();
    const withCriteria: Room = { ...detected!, designCriteria: conference };
    expect(buildAutoDetectedRooms(walls, [withCriteria])[0]!.designCriteria).toEqual(conference);
    // A room the walls make anew (it matches no room before) inside one with criteria takes them.
    const elsewhere: Room = { ...withCriteria, id: 'old', wallIds: ['gone'], vertices: withCriteria.vertices.map((point) => ({ x: point.x - 100, y: point.y - 100 })) };
    const anew = buildAutoDetectedRooms(walls, [elsewhere])[0]!;
    expect(anew.id).not.toBe('old');
    expect(anew.designCriteria).toEqual(conference);
  });
});
