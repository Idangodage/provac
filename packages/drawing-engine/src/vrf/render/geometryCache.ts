/**
 * Identity-keyed geometry caches. Immer preserves object references for anything a
 * command did NOT touch, so during a kit drag only the moved kit + the runs whose
 * endpoints followed get NEW references — everything else is reference-equal. Keying
 * the cache on the object (and the gap) means a drag frame rebuilds geometry for just
 * the few changed objects, which is what keeps a large-board drag under the frame
 * budget. Pure + framework-free (a React ref holds one instance across renders).
 */

import { buildPairedGeometry, type PairedGeometry } from '../geometry/offset';
import { buildKitBodyGeometry, type KitBodyGeometry } from '../geometry/kit';
import type { PipeRun } from '../model/types';

export interface RunGeometryCache {
  get: (run: PipeRun, gapMm: number) => PairedGeometry;
  prune: (liveIds: Set<string>) => void;
}

export function makeRunGeometryCache(): RunGeometryCache {
  const cache = new Map<string, { run: PipeRun; gap: number; geom: PairedGeometry }>();
  return {
    get(run, gapMm) {
      const prev = cache.get(run.id);
      if (prev && prev.run === run && prev.gap === gapMm) return prev.geom;
      const geom = buildPairedGeometry(run.spine, gapMm, run.bendRadiusMm);
      cache.set(run.id, { run, gap: gapMm, geom });
      return geom;
    },
    prune(liveIds) {
      for (const id of cache.keys()) if (!liveIds.has(id)) cache.delete(id);
    },
  };
}

export interface KitBodyCache {
  /** Kit body geometry is LOCAL (depends only on gap), so it is keyed by gap. */
  get: (gapMm: number) => KitBodyGeometry;
}

export function makeKitBodyCache(): KitBodyCache {
  const cache = new Map<number, KitBodyGeometry>();
  return {
    get(gapMm) {
      let g = cache.get(gapMm);
      if (!g) {
        g = buildKitBodyGeometry(gapMm);
        cache.set(gapMm, g);
      }
      return g;
    },
  };
}
