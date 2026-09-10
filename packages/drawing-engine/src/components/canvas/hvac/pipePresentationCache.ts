import type { HvacElement } from '../../../types';

import { getActivePipeRoutingSettings } from './pipeRoutingSettings';

/** Cache immutable element presentation, invalidating its live connector sources
 * and routing settings. Unrelated pipe previews do not invalidate the drawing. */
export function createPipePresentationCache<T>(build: (element: HvacElement, context: HvacElement[]) => T) {
  const entries = new WeakMap<HvacElement, {
    settings: ReturnType<typeof getActivePipeRoutingSettings>;
    sources: Array<HvacElement | undefined>;
    value: T;
  }>();
  return {
    read(element: HvacElement, context: HvacElement[], byId: ReadonlyMap<string, HvacElement>): T {
      const sources: Array<HvacElement | undefined> = [];
      for (const key of ['startConnection', 'endConnection', 'startBundleConnection', 'endBundleConnection']) {
        const connection = element.properties[key];
        if (!connection || typeof connection !== 'object') continue;
        for (const sourceKey of ['sourceElementId', 'gasSourceElementId', 'liquidSourceElementId']) {
          const id = (connection as Record<string, unknown>)[sourceKey];
          if (typeof id === 'string') sources.push(byId.get(id));
        }
      }
      const settings = getActivePipeRoutingSettings();
      const cached = entries.get(element);
      if (cached && cached.settings === settings && cached.sources.length === sources.length
        && sources.every((source, index) => source === cached.sources[index])) return cached.value;
      const value = build(element, context);
      entries.set(element, { settings, sources, value });
      return value;
    },
  };
}
