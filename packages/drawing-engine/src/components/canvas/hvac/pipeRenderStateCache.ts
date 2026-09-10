import type { HvacElement } from '../../../types';

import { createPipePresentationCache } from './pipePresentationCache';
import { buildRefrigerantPipeVisual } from './refrigerantPipePairModel';
import { buildRefrigerantPipeEndpointRenderStateMap, buildRefrigerantPipeRenderChainStateMap } from './refrigerantPipeRenderState';

/** Graph state remains current while immutable members reuse their physical geometry. */
export function createPipeRenderStateCache(
  build: (element: HvacElement, context: HvacElement[]) => ReturnType<typeof buildRefrigerantPipeVisual> = buildRefrigerantPipeVisual,
) {
  const visuals = createPipePresentationCache(build);
  return (allElements: HvacElement[]) => {
    const byId = new Map(allElements.map(element => [element.id, element]));
    const resolveVisual = (element: HvacElement) => visuals.read(element, allElements, byId);
    const pipeEndpointStateMap = buildRefrigerantPipeEndpointRenderStateMap(allElements, resolveVisual);
    return {
      allElements,
      pipeEndpointStateMap,
      pipeRenderChainStateMap: buildRefrigerantPipeRenderChainStateMap(allElements, pipeEndpointStateMap, resolveVisual),
    };
  };
}
