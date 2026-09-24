import { beforeEach, describe, expect, it } from 'vitest';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { condensateSourceSignature, prepareCondensateCommand, type CondensateCommandSource } from './condensateCommand';
import { generateCondensateNetwork } from './condensateGenerator';
import { resolveCondensateSettings } from './condensateSettings';
import { isCondensatePipe } from './condensateTypes';
import { buildRefrigerantHop } from './refrigerantHopProposal';

const settings = resolveCondensateSettings({});

function unit(id: string, type: HvacElement['type'], x: number, y: number): HvacElement {
  return {
    id, type, position: { x, y }, rotation: 0, width: type === 'ducted-ac' ? 1084 : 950, depth: type === 'ducted-ac' ? 697 : 950,
    height: type === 'ducted-ac' ? 300 : 272, elevation: 2400, mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5,
    properties: { capacityKw: 4 },
  };
}

function gully(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'condensate-gully', position: { x: x - 100, y: y - 100 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully' },
  };
}

function source(scene: HvacElement[]): CondensateCommandSource {
  return { scene, settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS, walls: [], rooms: [] };
}

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('prepareCondensateCommand', () => {
  const scene = [unit('c-1', 'ceiling-cassette-ac', 0, 0), unit('c-2', 'ceiling-cassette-ac', 3000, 0), gully('fg', 7000, 1500)];

  it('refuses a result computed against a drawing that has changed', () => {
    const signature = condensateSourceSignature(source(scene));
    const result = generateCondensateNetwork(scene, { settings });
    const moved = scene.map((element) => (element.id === 'c-2' ? { ...element, position: { x: 3200, y: 0 } } : element));
    expect(prepareCondensateCommand(signature, source(moved), result).issue).toMatch(/changed/);
  });

  it('commits the whole network as one undo step', () => {
    const store = useSmartDrawingStore.getState();
    store.loadData?.({ hvacElements: scene } as never);
    useSmartDrawingStore.setState({ hvacElements: scene });
    const signature = condensateSourceSignature(source(scene));
    const result = generateCondensateNetwork(scene, { settings });
    const prepared = prepareCondensateCommand(signature, source(scene), result);
    expect(prepared.command?.add?.length).toBeGreaterThan(0);
    const before = useSmartDrawingStore.getState().hvacElements;
    useSmartDrawingStore.getState().saveToHistory('baseline');
    useSmartDrawingStore.getState().commitHvacElementCommand('Generate condensate network', prepared.command!);
    expect(useSmartDrawingStore.getState().hvacElements.filter(isCondensatePipe)).toHaveLength(result.elementsToAdd.length);
    useSmartDrawingStore.getState().undo();
    expect(useSmartDrawingStore.getState().hvacElements.map((element) => element.id)).toEqual(before.map((element) => element.id));
  });
});

describe('buildRefrigerantHop', () => {
  it('raises a refrigerant run over the drain with plumb risers inside the soffit', () => {
    const refrigerant: HvacElement = {
      id: 'liq-1', type: 'refrigerant-pipe', position: { x: 4000, y: -3000 }, rotation: 0, width: 10, depth: 7000, height: 40,
      elevation: 2455, mountType: 'ceiling', label: 'liquid', supplyZoneRatio: 0.5,
      properties: {
        routePoints: [{ x: 4000, y: -3000 }, { x: 4000, y: 4000 }],
        routeNodes3d: [{ x: 4000, y: -3000, z: 2475 }, { x: 4000, y: 4000, z: 2475 }],
        pipeDiameterMm: 9.52, insulationThicknessMm: 25.4, lineKind: 'liquid', fieldBendConstruction: 'formed-tube',
      },
    };
    const scene = [unit('d-1', 'ducted-ac', 0, 0), gully('fg-1', 8000, 400), refrigerant];
    const result = generateCondensateNetwork(scene, { settings });
    expect(result.hopProposals).toHaveLength(1);
    const hop = buildRefrigerantHop(scene, result.hopProposals[0]!, DEFAULT_PIPE_ROUTING_SETTINGS);
    expect(hop.reason).toBeUndefined();
    const nodes = hop.element!.properties.routeNodes3d as Array<{ x: number; y: number; z: number }>;
    expect(nodes).toHaveLength(6);
    const top = Math.max(...nodes.map((node) => node.z));
    expect(top).toBeGreaterThanOrEqual(result.hopProposals[0]!.requiredCentrelineZ - 0.5);
    expect(top).toBeLessThanOrEqual(DEFAULT_PIPE_ROUTING_SETTINGS.ceilingLimitMm);
    // Plumb risers: the raised nodes sit exactly above their cut points.
    expect(nodes[1]!.x).toBeCloseTo(nodes[2]!.x, 6);
    expect(nodes[1]!.y).toBeCloseTo(nodes[2]!.y, 6);
    expect(hop.element!.properties.condensateHops).toHaveLength(1);
  });
});
