import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement } from '../../../types';

import { buildPipePlanTubes } from './pipePlanPresentation';
import { createPipePresentationCache } from './pipePresentationCache';
import { createPipeRenderStateCache } from './pipeRenderStateCache';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipeVisual } from './refrigerantPipePairModel';
import { buildRefrigerantPipeEndpointRenderStateMap, buildRefrigerantPipeRenderChainStateMap } from './refrigerantPipeRenderState';

function pipe(id: string, x = 0): HvacElement {
  return { id, type: 'refrigerant-pipe', label: id, position: { x, y: 0 }, width: 1000, depth: 1000,
    height: 50, elevation: 2400, rotation: 0, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { routePoints: [{ x, y: 0 }, { x: x + 1000, y: 0 }, { x: x + 1000, y: 1000 }],
      lineKind: 'gas', pipeDiameterMm: 15.875, outerDiameterMm: 50, segmentMaterials: ['hard', 'hard'] } };
}
const index = (elements: HvacElement[]) => new Map(elements.map(element => [element.id, element]));
afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('pipe presentation reuse', () => {
  it('reuses unchanged physical visuals while recomputing exact endpoint and chain ownership', () => {
    const build = vi.fn(buildRefrigerantPipeVisual);
    const renderContext = createPipeRenderStateCache(build);
    const first = pipe('first'); const second = pipe('second', 1000);
    const baseline = [first, second];
    renderContext(baseline);
    expect(build).toHaveBeenCalledTimes(2);
    const joined = { ...second, properties: { ...second.properties,
      startConnection: { connectionKind: 'field-pipe', sourceElementId: first.id,
        portPoint: { x: 1000, y: 1000 }, direction: { x: 0, y: 1 }, elevationMm: 2425 } } };
    const preview = [first, joined];
    const result = renderContext(preview);
    expect(build).toHaveBeenCalledTimes(3);
    const endpoints = buildRefrigerantPipeEndpointRenderStateMap(preview);
    expect(result.pipeEndpointStateMap).toEqual(endpoints);
    expect(result.pipeRenderChainStateMap).toEqual(buildRefrigerantPipeRenderChainStateMap(preview, endpoints));
    renderContext(baseline);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('compiles only the edited pipe across 100 unchanged pipe presentations', () => {
    const build = vi.fn(buildPipePlanTubes);
    const cache = createPipePresentationCache(build);
    const elements = Array.from({ length: 100 }, (_, id) => pipe(`pipe-${id}`, id * 2000));
    const byId = index(elements);
    const original = elements.map(element => cache.read(element, elements, byId));
    expect(build).toHaveBeenCalledTimes(100);
    const changed = pipe('pipe-4', 8300);
    const preview = elements.map(element => element.id === changed.id ? changed : element);
    const previewById = index(preview);
    const presented = preview.map(element => cache.read(element, preview, previewById));
    expect(build).toHaveBeenCalledTimes(101);
    expect(presented[3]).toBe(original[3]);
    expect(presented[4]).toEqual(buildPipePlanTubes(changed, preview));
    // Cancellation reuses the exact committed fitting presentation.
    expect(cache.read(elements[4]!, elements, byId)).toBe(original[4]);
    expect(build).toHaveBeenCalledTimes(101);
  });

  it('invalidates changed or removed connector sources and routing settings', () => {
    const source = pipe('source'); const target = pipe('target', 1000);
    target.properties.startConnection = { connectionKind: 'unit-port', sourceElementId: source.id,
      portPoint: { x: 1000, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2425 };
    const build = vi.fn(buildPipePlanTubes);
    const cache = createPipePresentationCache(build);
    const elements = [source, target];
    cache.read(target, elements, index(elements));
    const changed = [{ ...source, elevation: 2700 }, target];
    cache.read(target, changed, index(changed));
    expect(build).toHaveBeenCalledTimes(2);
    cache.read(target, [target], index([target]));
    expect(build).toHaveBeenCalledTimes(3);
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, minimumPortStubMm: 350 });
    expect(cache.read(target, [target], index([target]))).toEqual(buildPipePlanTubes(target, [target]));
    expect(build).toHaveBeenCalledTimes(4);
  });
});
