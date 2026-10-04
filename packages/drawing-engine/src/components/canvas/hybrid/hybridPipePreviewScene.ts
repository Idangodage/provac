import * as THREE from 'three';

import type { HvacElement } from '../../../types';
import type { DuctDesignSettings } from '../hvac/duct/ductSettings';
import { getActivePipeRoutingSettings } from '../hvac/pipeRoutingSettings';
import { getVisibleRefrigerantPipeStraightSegmentTargets } from '../hvac/refrigerantPipeRenderState';
import type { HvacBuildSceneContext } from '../hvac/three3d';
import { disposeObject3DResources, disposeOwnedMaterial, markMaterialOwned } from '../threeResourceLifecycle';

import { createHybridHvacScene } from './hybridHvacScene';

/** Route previews have the same solid occlusion as committed HVAC bodies. */
export function applyHybridPreviewMaterials(object: THREE.Object3D, _element: Pick<HvacElement, 'type'>): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const previews = materials.map((material) => {
      const clone = markMaterialOwned(material.clone());
      disposeOwnedMaterial(material);
      clone.transparent = false;
      clone.opacity = 1;
      clone.depthWrite = true;
      clone.depthTest = true;
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

type CommittedScene = Pick<ReturnType<typeof createHybridHvacScene>, 'changedElements' | 'modelRevision'>;
interface PreviewInput {
  committedScene: CommittedScene;
  committed: readonly HvacElement[];
  drafts: readonly HvacElement[] | null;
  edits: readonly HvacElement[] | null;
  ductSettings?: DuctDesignSettings;
  buildRenderContext: (elements: HvacElement[]) => HvacBuildSceneContext;
}
interface PreviewSnapshot extends PreviewInput {
  modelRevision: number;
  routingSettings: ReturnType<typeof getActivePipeRoutingSettings>;
}
interface PreviewCache {
  scene: ReturnType<typeof createHybridHvacScene<THREE.Group>>;
  previous?: PreviewSnapshot;
  hiddenIds: Set<string>;
}
const previewScenes = new WeakMap<THREE.Group, PreviewCache>();

function sameElements(a: readonly HvacElement[] | null, b: readonly HvacElement[] | null): boolean {
  return a === b || ((a?.length ?? 0) === (b?.length ?? 0)
    && (a ?? []).every((element, index) => element === b?.[index]));
}

/** Reuse unchanged preview meshes and their GPU resources across drag frames.
 * Camera-only renders also skip network compilation, even if React supplies a
 * new array containing the same immutable members. */
export function updateHybridPipePreviewScene(
  group: THREE.Group,
  input: PreviewInput,
  build: (element: HvacElement, context: HvacBuildSceneContext) => THREE.Group | null,
): { hiddenIds: ReadonlySet<string>; changed: boolean } {
  let cache = previewScenes.get(group);
  if (!cache) {
    cache = {
      hiddenIds: new Set(),
      scene: createHybridHvacScene({
        build: (element, context) => {
          const mesh = build(element, context);
          if (!mesh) return null;
          if (mesh.children.length === 0) {
            disposeObject3DResources(mesh);
            return null;
          }
          applyHybridPreviewMaterials(mesh, element);
          return mesh;
        },
        attach: mesh => { group.add(mesh); },
        dispose: mesh => {
          group.remove(mesh);
          disposeObject3DResources(mesh);
        },
      }),
    };
    previewScenes.set(group, cache);
  }
  const routingSettings = getActivePipeRoutingSettings();
  const modelRevision = input.committedScene.modelRevision;
  const previous = cache.previous;
  if (previous && previous.committedScene === input.committedScene
    && previous.buildRenderContext === input.buildRenderContext
    && previous.ductSettings === input.ductSettings
    && previous.routingSettings === routingSettings && previous.modelRevision === modelRevision
    && sameElements(previous.committed, input.committed)
    && sameElements(previous.drafts, input.drafts) && sameElements(previous.edits, input.edits)) {
    return { hiddenIds: cache.hiddenIds, changed: false };
  }
  const { previews, allElements, hiddenIds } = composeHybridPipePreviewScene(input.committed, input.drafts, input.edits);
  let changed: boolean;
  if (previews.length === 0) {
    changed = cache.scene.update({ allElements: [] }, modelRevision);
  } else {
    const context = { ...input.buildRenderContext(allElements), ductSettings: input.ductSettings };
    const previewIds = new Set(previews.map(element => element.id));
    for (const element of input.committedScene.changedElements(context)) {
      if (previewIds.has(element.id) || (element.type !== 'refrigerant-pipe'
        && element.type !== 'refrigerant-pipe-pair' && element.type !== 'refrigerant-branch-kit'
        && element.type !== 'duct')) continue;
      previews.push(element);
      previewIds.add(element.id);
      hiddenIds.add(element.id);
    }
    // Fixed kits use their own stored pose. Only inline kits resolve a host run.
    if (previews.some(element => element.type === 'refrigerant-branch-kit'
      && element.properties.branchKitPlacementMode === 'inline-pipe-run')) {
      context.pipeTargets = getVisibleRefrigerantPipeStraightSegmentTargets(allElements);
    }
    changed = cache.scene.update(context, modelRevision, previews);
  }
  cache.hiddenIds = hiddenIds;
  cache.previous = { ...input, committed: [...input.committed], drafts: input.drafts && [...input.drafts],
    edits: input.edits && [...input.edits], routingSettings, modelRevision };
  return { hiddenIds, changed };
}

/** The layer and its cache have one owner, including cancellation and teardown. */
export function clearHybridPipePreviewScene(group: THREE.Group): void {
  previewScenes.get(group)?.scene.clear();
  previewScenes.delete(group);
}
