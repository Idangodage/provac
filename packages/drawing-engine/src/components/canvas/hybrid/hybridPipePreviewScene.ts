import * as THREE from 'three';

import type { HvacElement } from '../../../types';
import { isDuctTerminalElement } from '../hvac/duct/ductTerminals';
import { isDuctElement } from '../hvac/duct/ductTypes';
import { disposeOwnedMaterial, markMaterialOwned } from '../threeResourceLifecycle';

/** Keep duct previews physically occluded so opposite collars and flanges cannot show through sheet metal. */
export function applyHybridPreviewMaterials(object: THREE.Object3D, element: Pick<HvacElement, 'type'>): void {
  const solid = isDuctElement(element) || isDuctTerminalElement(element);
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const previews = materials.map((material) => {
      const clone = markMaterialOwned(material.clone());
      disposeOwnedMaterial(material);
      clone.transparent = !solid;
      clone.opacity = solid ? 1 : Math.min(clone.opacity, 0.72);
      clone.depthWrite = solid;
      return clone;
    });
    child.material = Array.isArray(child.material) ? previews : previews[0]!;
    child.renderOrder = Math.max(child.renderOrder, 880);
  });
}

/** A transient route replaces its committed ID without changing the scene's model array. */
export function composeHybridPipePreviewScene<T extends { id: string }>(
  committed: readonly T[],
  drafts: readonly T[] | null,
  edits: readonly T[] | null,
): { previews: T[]; allElements: T[]; hiddenIds: Set<string> } {
  const replacements = new Map<string, T>();
  for (const element of edits ?? []) replacements.set(element.id, element);
  for (const element of drafts ?? []) replacements.set(element.id, element);
  const committedIds = new Set(committed.map(element => element.id));
  return {
    previews: [...replacements.values()],
    allElements: [
      ...committed.map(element => replacements.get(element.id) ?? element),
      ...[...replacements.values()].filter(element => !committedIds.has(element.id)),
    ],
    hiddenIds: new Set(replacements.keys()),
  };
}
