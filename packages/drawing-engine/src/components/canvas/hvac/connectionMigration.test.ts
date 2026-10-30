import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import { useDrawingStore } from '../../../store';
import type { HvacElement, Point2D, Room, Wall } from '../../../types';

import boxedCassette from './__fixtures__/boxed-cassette-scene.json';
import { generateCondensateNetwork } from './condensate/condensateGenerator';
import { resolveCondensateSettings } from './condensate/condensateSettings';
import { planConnectionMigration, unitsWithStaleConnections } from './connectionMigration';
import { migrateUnitConnectionsAfterOpen } from './connectionMigrationController';
import { readPipeRouteNodes3d } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS, getActivePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { evaluateRefrigerantOption, type RefrigerantSegmentOption } from './refrigerant/refrigerantSegmentOptions';
import { insulatedLineFromUnit, insulationGapNearUnit } from './refrigerantInsulationClearance';
import { buildRefrigerantPipeElements, getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';

const routing = { ...DEFAULT_PIPE_ROUTING_SETTINGS, ceilingLimitMm: 3300 };
const original = getActivePipeRoutingSettings();
beforeEach(() => setActivePipeRoutingSettings(routing));
afterEach(() => setActivePipeRoutingSettings(original));

const settings = resolveCondensateSettings({ soffitMm: 3300 });
const context = { settings, routingSettings: routing };

/** The FDUM140 as the catalogue has it, and as a drawing made before its maker data drew it (no model code). */
function fdum140(maker: boolean): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === 'vrf-fdum140kxe6f')!;
  const properties = { ...(definition.defaultProperties ?? {}) } as Record<string, unknown>;
  if (!maker) { delete properties.modelCode; delete properties.model; }
  return {
    id: 'indoor', type: definition.type, category: 'indoor-unit', rotation: 0,
    position: { x: 3000 - definition.widthMm / 2, y: 3000 - definition.depthMm / 2 },
    width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm, elevation: 2400,
    mountType: 'ceiling', label: 'FDUM140', supplyZoneRatio: 0.5, properties,
  } as HvacElement;
}

const gully: HvacElement = {
  id: 'gully', type: 'condensate-gully', position: { x: 5900, y: 2900 }, rotation: 0, width: 200, depth: 200, height: 60,
  elevation: 0, mountType: 'floor', label: 'Floor gully', supplyZoneRatio: 0,
  properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
};

/** A drawing made on the old drawn ports: its pair run out of them, its drain generated from them. */
function oldDrawing(): HvacElement[] {
  const drawn = fdum140(false);
  const port = getRefrigerantPipeBundleSnapTargets([drawn]).find((target) => target.connectionKind === 'unit-port')!;
  const pipes = buildRefrigerantPipeElements([port.point, { x: port.point.x + 1500, y: port.point.y }],
    { startBundleConnection: port, gasPipeDiameterMm: 15.88, liquidPipeDiameterMm: 9.52 })
    .map((element, index) => ({ ...element, id: `pipe-${index}`, rotation: 0 }) as HvacElement);
  const drains = generateCondensateNetwork([drawn, gully], { settings }).elementsToAdd;
  // Opened today, the unit is the catalogue's again: its ports are the maker's.
  return [fdum140(true), gully, ...pipes, ...drains];
}

describe('re-attaching an old drawing to the maker stubs', () => {
  it('finds the unit whose pipes and drain start on its old ports', () => {
    const scene = oldDrawing();
    expect(scene.some((element) => element.type === 'condensate-pipe')).toBe(true);
    expect(unitsWithStaleConnections(scene, context)).toEqual(['indoor']);
  });

  it('moves its pipes and drain onto the maker stubs in one change, after which nothing is stale', () => {
    const scene = oldDrawing();
    const plan = planConnectionMigration(scene, context)!;
    expect(plan.unitIds).toEqual(['indoor']);
    expect(plan.keptUnitIds).toEqual([]);
    expect(plan.updates.map((entry) => entry.id)).toEqual(expect.arrayContaining(['pipe-0', 'pipe-1']));
    const byId = new Map(plan.updates.map((entry) => [entry.id, entry.updates]));
    const removed = new Set(plan.removeIds);
    const after = [
      ...scene.filter((element) => !removed.has(element.id)).map((element) => {
        const update = byId.get(element.id);
        return update ? { ...element, ...update, properties: { ...element.properties, ...(update.properties ?? {}) } } as HvacElement : element;
      }),
      ...plan.add,
    ];
    expect(unitsWithStaleConnections(after, context)).toEqual([]);
  });

  it("re-attaches a cassette whose stubs moved to the other side without its insulation running into itself", () => {
    // The project's FDT28: drawn on its old +x ports, its pair run down past the unit and east to the outdoor unit.
    const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === 'vrf-fdt28kxze1')!;
    const cassette = (maker: boolean): HvacElement => ({
      id: 'cassette', type: definition.type, category: 'indoor-unit', rotation: 0,
      position: { x: 5000 - definition.widthMm / 2, y: 3000 - definition.depthMm / 2 },
      width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm, elevation: 2400,
      mountType: 'ceiling', label: 'FDT28', supplyZoneRatio: 0.5,
      properties: maker ? { ...(definition.defaultProperties ?? {}) } : { capacityKw: 2.8 },
    } as HvacElement);
    const port = getRefrigerantPipeBundleSnapTargets([cassette(false)]).find((target) => target.connectionKind === 'unit-port')!;
    expect(port.direction.x).toBe(1);
    const pipes = buildRefrigerantPipeElements([port.point, { x: 5914, y: 7387 }, { x: 11448, y: 7568 }], { startBundleConnection: port, bundleId: 'pair-1' })
      .map((element, index) => ({ ...element, id: `pipe-${index}`, rotation: 0 }) as HvacElement);
    const scene = [cassette(true), ...pipes];
    expect(unitsWithStaleConnections(scene, context)).toEqual(['cassette']);
    const plan = planConnectionMigration(scene, context)!;
    expect(plan.unitIds).toEqual(['cassette']);
    const byId = new Map(plan.updates.map((entry) => [entry.id, entry.updates]));
    const after = scene.map((element) => {
      const update = byId.get(element.id);
      return update ? { ...element, ...update, properties: { ...element.properties, ...(update.properties ?? {}) } } as HvacElement : element;
    });
    expect(unitsWithStaleConnections(after, context)).toEqual([]);
    const lines = after.flatMap((element) => {
      const line = insulatedLineFromUnit(element, 'cassette', after);
      return line ? [{ kind: element.properties.lineKind, line }] : [];
    });
    const gas = lines.find((entry) => entry.kind === 'gas')!.line;
    const liquid = lines.find((entry) => entry.kind === 'liquid')!.line;
    expect(insulationGapNearUnit(gas, liquid).gapMm).toBeGreaterThanOrEqual(2);
    // The new head keeps clear of the cassette's drain outlet: its drain can still be laid.
    const sink = { ...gully, id: 'sink', position: { x: 2900, y: 7400 } };
    const drains = generateCondensateNetwork([...after, sink], { settings });
    const drain = drains.perUnit.find((entry) => entry.unitId === 'cassette')!;
    expect(drain.status, drain.reason).not.toBe('infeasible');
  });

  it("re-attaches the project's own cassette, drawn before its route was stored, and keeps its drawn run", () => {
    // Its pair left the old +x ports, ran down past the unit and east along y 8038/8127, and came up into the
    // outdoor unit's east-facing ports, crossing over just before them.
    const project = boxedCassette as unknown as { hvacElements: HvacElement[]; walls: Wall[]; rooms: Room[] };
    const scene = project.hvacElements;
    const cassette = scene.find((element) => element.type === 'ceiling-cassette-ac')!;
    expect(unitsWithStaleConnections(scene, context)).toEqual([cassette.id]);
    const plan = planConnectionMigration(scene, { ...context, walls: project.walls, rooms: project.rooms })!;
    expect(plan.keptUnitIds).toEqual([]);
    expect(plan.unitIds).toEqual([cassette.id]);
    const byId = new Map(plan.updates.map((entry) => [entry.id, entry.updates]));
    const after = scene.map((element) => {
      const update = byId.get(element.id);
      return update ? { ...element, ...update, properties: { ...element.properties, ...(update.properties ?? {}) } } as HvacElement : element;
    });
    expect(unitsWithStaleConnections(after, context)).toEqual([]);
    const lines = after.flatMap((element) => {
      const line = insulatedLineFromUnit(element, cassette.id, after);
      return line ? [{ kind: element.properties.lineKind, line }] : [];
    });
    expect(insulationGapNearUnit(lines.find((entry) => entry.kind === 'gas')!.line, lines.find((entry) => entry.kind === 'liquid')!.line)
      .gapMm).toBeGreaterThanOrEqual(2);
    // Its drawn run along the south is kept (half way between where its gas and liquid ran), not swapped for a new way.
    const route = after.find((element) => element.properties.lineKind === 'gas')!.properties.authoredCenterlineRoute as Point2D[];
    expect(route.slice(1).some((point, index) => Math.abs(point.y - 8082.3) < 1 && Math.abs(route[index]!.y - 8082.3) < 1
      && Math.abs(point.x - route[index]!.x) > 5000)).toBe(true);
    // It still drains.
    const drains = generateCondensateNetwork(after, { settings, walls: project.walls, rooms: project.rooms });
    expect(drains.perUnit.map((entry) => entry.status)).toEqual(['pumped']);
    // Its lines, rebuilt in plan only, can be edited: a thicker insulation keeps the gas line's riser down to the
    // outdoor unit's ports 1.2 m lower (it used to be stored flat, meeting them straight down: "end port straight
    // stub 0 mm").
    const gas = after.find((element) => element.properties.lineKind === 'gas')!;
    const thicker = evaluateRefrigerantOption(after, { id: 'insulation:38', group: 'insulation', glyph: 'insulation', title: '38 mm',
      edit: { kind: 'insulation', elementId: gas.id, thicknessMm: 38 } } as unknown as RefrigerantSegmentOption);
    expect(thicker.newIssues).toEqual([]);
    expect(readPipeRouteNodes3d(thicker.updates[0]!)).toEqual([]);
  });

  it('leaves a drawing already on the maker stubs alone', () => {
    const unit = fdum140(true);
    const port = getRefrigerantPipeBundleSnapTargets([unit]).find((target) => target.connectionKind === 'unit-port')!;
    const pipes = buildRefrigerantPipeElements([port.point, { x: port.point.x + 1500, y: port.point.y }], { startBundleConnection: port })
      .map((element, index) => ({ ...element, id: `pipe-${index}`, rotation: 0 }) as HvacElement);
    const drains = generateCondensateNetwork([unit, gully], { settings }).elementsToAdd;
    const scene = [unit, gully, ...pipes, ...drains];
    expect(unitsWithStaleConnections(scene, context)).toEqual([]);
    expect(planConnectionMigration(scene, context)).toBeNull();
  });
});

describe('when an old drawing opens', () => {
  it('moves its connections in one undoable change and says so in the status bar', () => {
    useDrawingStore.setState({
      hvacElements: oldDrawing(), walls: [], rooms: [], condensateSettings: settings, pipeRoutingSettings: routing,
      selectedElementIds: [], selectedIds: [], hoveredElementId: null, processingStatus: '',
    });
    useDrawingStore.getState().clearHistory();
    migrateUnitConnectionsAfterOpen();
    const state = useDrawingStore.getState();
    expect(unitsWithStaleConnections(state.hvacElements, context)).toEqual([]);
    expect(state.processingStatus).toMatch(/^Connections moved to the maker's stubs on 1 unit: Undo puts them back\./);
    state.undo();
    expect(unitsWithStaleConnections(useDrawingStore.getState().hvacElements, context)).toEqual(['indoor']);
    // Opened again, nothing more to do once it has moved.
    useDrawingStore.getState().redo();
    migrateUnitConnectionsAfterOpen();
    expect(unitsWithStaleConnections(useDrawingStore.getState().hvacElements, context)).toEqual([]);
  });
});
