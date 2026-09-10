import { beforeAll, bench, describe, expect } from 'vitest';

import type { HvacElement } from '../../../types';

import { planAutoRouteNetwork } from './autoRouteNetwork';
import { resolvePipeEditFrame } from './pipeEditGeometry';
import { buildPipeModelEdit, editablePipeNodes } from './pipeEditModel';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';

let source: HvacElement;
let scene: HvacElement[];
let populatedScene: HvacElement[];
let segmentIndex: number;
const frame = resolvePipeEditFrame({ mode: 'world', nodes: [], selection: { kind: 'run' } })!;

beforeAll(async () => {
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  const indoor: HvacElement = { id: 'indoor', type: 'ceiling-cassette-ac', category: 'indoor-unit', label: 'Indoor',
    position: { x: 500, y: 300 }, rotation: 0, width: 600, depth: 600, height: 250, elevation: 2200,
    mountType: 'ceiling', supplyZoneRatio: 0, properties: {} };
  indoor.elevation += 2607 - getRefrigerantPipeBundleSnapTargets([indoor])[0]!.liquidElevationMm;
  const outdoor: HvacElement = { ...indoor, id: 'outdoor', type: 'outdoor-unit', category: 'outdoor-unit',
    position: { x: 6900, y: 2600 }, rotation: 180, width: 900, depth: 450, height: 1200, elevation: 0, mountType: 'floor' };
  outdoor.elevation += 1437 - getRefrigerantPipeBundleSnapTargets([outdoor])[0]!.gasElevationMm;
  scene = [indoor, outdoor];
  const generated = await planAutoRouteNetwork(scene, { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' });
  expect(generated.complete).toBe(true);
  scene.push(...generated.elementsToAdd);
  source = generated.elementsToAdd.find(element => element.type === 'refrigerant-pipe')!;
  const nodes = editablePipeNodes(source);
  segmentIndex = nodes.findIndex((node, index) => index > 0 && index + 2 < nodes.length
    && Math.abs(node.x - nodes[index + 1]!.x) < 0.001 && Math.abs(node.y - nodes[index + 1]!.y) > 1000
    && Math.abs(node.z - nodes[index + 1]!.z) < 0.001);
  expect(segmentIndex).toBeGreaterThan(0);
  populatedScene = [...scene, ...Array.from({ length: 500 }, (_, index): HvacElement => ({
    ...source, id: `unrelated-${index}`, properties: { lineKind: 'gas', pipeDiameterMm: 15.88,
      insulationThicknessMm: 12, segmentMaterials: ['hard', 'hard', 'hard'],
      routePoints: [{ x: 10000 + index * 2000, y: 0 }, { x: 11000 + index * 2000, y: 0 },
        { x: 11000 + index * 2000, y: 1000 }, { x: 12000 + index * 2000, y: 1000 }] },
  }))];
});

// Opt-in: the same generated route and exact edit, with and without unrelated
// legacy pipes. Keep correctness assertions beside timings to prevent a fast
// preview from silently skipping fitting or connection validation.
describe('Canonical generated-pipe editing', () => {
  for (const populated of [false, true]) bench(populated ? 'with 500 unrelated legacy pipes' : 'small equipment scene', () => {
    const result = buildPipeModelEdit({ elementId: source.id, elements: populated ? populatedScene : scene,
      selection: { kind: 'segment', index: segmentIndex }, frame,
      operation: { kind: 'translate', offset: { x: 200, y: 17, z: 0 } } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const nodes = editablePipeNodes(result.elements[0]!);
    expect(nodes[segmentIndex]!.x).toBeCloseTo(editablePipeNodes(source)[segmentIndex]!.x + 200, 8);
    expect(result.elements[0]!.properties.startConnection).toEqual(source.properties.startConnection);
    expect(result.elements[0]!.properties.endConnection).toEqual(source.properties.endConnection);
  }, { iterations: 20, time: 0, warmupIterations: 3, warmupTime: 0 });
});
