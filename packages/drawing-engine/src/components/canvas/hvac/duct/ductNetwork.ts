/**
 * Duct network: which runs hang off which. Branch runs name their parent; this
 * module answers the reverse question and applies the delete cascade.
 */
import type { HvacElement } from '../../../../types';

import {
  buildDuctRunElement,
  ductParentRunId,
  isDuctElement,
  readDuctRunSpec,
  type DuctRunSpec,
  type DuctSplitBranchStart,
  type DuctTapStart,
} from './ductTypes';

export interface DuctBranchRef {
  element: HvacElement;
  spec: DuctRunSpec;
  start: DuctTapStart | DuctSplitBranchStart;
}

const INDEX_CACHE = new WeakMap<readonly HvacElement[], Map<string, DuctBranchRef[]>>();

function indexOf(scene: readonly HvacElement[]): Map<string, DuctBranchRef[]> {
  let index = INDEX_CACHE.get(scene);
  if (index) return index;
  index = new Map();
  for (const element of scene) {
    if (!isDuctElement(element)) continue;
    const spec = readDuctRunSpec(element);
    if (!spec || (spec.start.kind !== 'tap' && spec.start.kind !== 'split-branch')) continue;
    const list = index.get(spec.start.parentRunId) ?? [];
    list.push({ element, spec, start: spec.start });
    index.set(spec.start.parentRunId, list);
  }
  INDEX_CACHE.set(scene, index);
  return index;
}

/** Branch runs taken off `parentId` (taps and split branches). */
export function ductBranchesOf(parentId: string, scene: readonly HvacElement[]): DuctBranchRef[] {
  return indexOf(scene).get(parentId) ?? [];
}

export function ductParentOf(spec: DuctRunSpec, scene: readonly HvacElement[]): HvacElement | null {
  const parentId = ductParentRunId(spec);
  if (!parentId) return null;
  return scene.find((element) => element.id === parentId && isDuctElement(element)) ?? null;
}

/**
 * Remove `removedIds` from the scene, keeping the network consistent in the
 * same step: branches of a removed run keep their geometry but start open
 * (orphaned), and a split whose branches are all removed becomes an end cap.
 */
export function expandDuctDeletion(elements: readonly HvacElement[], removedIds: ReadonlySet<string>): HvacElement[] {
  const kept = elements.filter((element) => !removedIds.has(element.id));
  const removedDucts = elements.filter((element) => removedIds.has(element.id) && isDuctElement(element));
  if (removedDucts.length === 0) return kept;
  const survivingParents = new Set<string>();
  for (const element of kept) {
    if (!isDuctElement(element)) continue;
    const spec = readDuctRunSpec(element);
    const parentId = spec ? ductParentRunId(spec) : null;
    if (parentId) survivingParents.add(parentId);
  }
  return kept.map((element) => {
    if (!isDuctElement(element)) return element;
    const spec = readDuctRunSpec(element);
    if (!spec || spec.legacy) return element;
    let next: DuctRunSpec | null = null;
    const parentId = ductParentRunId(spec);
    if (parentId && removedIds.has(parentId)) next = { ...spec, start: { kind: 'open', orphaned: true } };
    if (spec.end.kind === 'split' && !survivingParents.has(element.id)) next = { ...(next ?? spec), end: { kind: 'end-cap' } };
    if (!next) return element;
    return { ...element, properties: { ...element.properties, ...buildDuctRunElement(next).properties } };
  });
}
