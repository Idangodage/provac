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
  type DuctSpigotStart,
  type DuctSplitBranchStart,
  type DuctTapStart,
} from './ductTypes';

export interface DuctBranchRef {
  element: HvacElement;
  spec: DuctRunSpec;
  start: DuctTapStart | DuctSplitBranchStart | DuctSpigotStart;
}

interface DuctNetworkIndex {
  elements: Map<string, HvacElement>;
  branches: Map<string, DuctBranchRef[]>;
}

// Scenes are immutable snapshots: both directions share one O(n) indexing pass.
const INDEX_CACHE = new WeakMap<readonly HvacElement[], DuctNetworkIndex>();

function indexOf(scene: readonly HvacElement[]): DuctNetworkIndex {
  let index = INDEX_CACHE.get(scene);
  if (index) return index;
  index = { elements: new Map(), branches: new Map() };
  for (const element of scene) {
    if (!isDuctElement(element)) continue;
    index.elements.set(element.id, element);
    const spec = readDuctRunSpec(element);
    if (!spec || (spec.start.kind !== 'tap' && spec.start.kind !== 'split-branch' && spec.start.kind !== 'spigot')) continue;
    const list = index.branches.get(spec.start.parentRunId) ?? [];
    list.push({ element, spec, start: spec.start });
    index.branches.set(spec.start.parentRunId, list);
  }
  INDEX_CACHE.set(scene, index);
  return index;
}

/** Branch runs taken off `parentId` (taps, split branches and plenum spigots). */
export function ductBranchesOf(parentId: string, scene: readonly HvacElement[]): DuctBranchRef[] {
  return indexOf(scene).branches.get(parentId) ?? [];
}

export function ductParentOf(spec: DuctRunSpec, scene: readonly HvacElement[]): HvacElement | null {
  const parentId = ductParentRunId(spec);
  if (!parentId) return null;
  return indexOf(scene).elements.get(parentId) ?? null;
}

/**
 * Remove `removedIds` from the scene, keeping the network consistent in the
 * same step: branches of a removed run keep their geometry but start open
 * (orphaned), a split whose branches are all removed becomes an end cap, and a
 * run whose air terminal is removed ends open.
 */
export function expandDuctDeletion(elements: readonly HvacElement[], removedIds: ReadonlySet<string>): HvacElement[] {
  const kept = elements.filter((element) => !removedIds.has(element.id));
  const removedDucts = elements.filter((element) => removedIds.has(element.id) && (isDuctElement(element) || element.type === 'diffuser' || element.type === 'return-grille'));
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
    if (spec.end.kind === 'terminal' && removedIds.has(spec.end.terminalId)) {
      // A flexible runout goes with its terminal: the rigid duct it left from ends open.
      const base = next ?? spec;
      const dropRunout = spec.end.flex && base.path.length > 2;
      const lastNode = base.path.length - 1;
      next = dropRunout
        ? {
          ...base,
          path: base.path.slice(0, -1),
          legs: base.legs.slice(0, -1),
          nodeOverrides: Object.fromEntries(Object.entries(base.nodeOverrides).filter(([node]) => Number(node) < lastNode)),
          end: { kind: 'open', orphaned: true },
        }
        : { ...base, end: { kind: 'open', orphaned: true } };
    }
    if (spec.end.kind === 'split' && !survivingParents.has(element.id)) next = { ...(next ?? spec), end: { kind: 'end-cap' } };
    if (!next) return element;
    return { ...element, properties: { ...element.properties, ...buildDuctRunElement(next).properties } };
  });
}
