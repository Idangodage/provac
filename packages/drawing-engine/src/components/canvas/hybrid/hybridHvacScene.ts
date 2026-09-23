import type { HvacElement } from '../../../types';
import { getActivePipeRoutingSettings } from '../hvac/pipeRoutingSettings';
import type { HvacBuildSceneContext } from '../hvac/three3d';

function connectorSources(element: HvacElement, byId: ReadonlyMap<string, HvacElement>): unknown[] {
  const sources: unknown[] = [];
  for (const key of ['startConnection', 'endConnection', 'startBundleConnection', 'endBundleConnection']) {
    const connection = element.properties[key];
    if (!connection || typeof connection !== 'object') continue;
    for (const sourceKey of ['sourceElementId', 'gasSourceElementId', 'liquidSourceElementId']) {
      const id = (connection as Record<string, unknown>)[sourceKey];
      if (typeof id === 'string') sources.push(byId.get(id));
    }
  }
  return sources;
}

function dependencyReader(context: HvacBuildSceneContext, modelRevision: number) {
  const byId = new Map(context.allElements.map(element => [element.id, element]));
  const settings = getActivePipeRoutingSettings();
  const chainSignatures = new Map<string, string>();
  return (element: HvacElement): unknown[] => {
    const dependencies: unknown[] = [element, modelRevision];
    if (element.type === 'refrigerant-pipe' || element.type === 'refrigerant-pipe-pair') {
      const endpoints = context.pipeEndpointStateMap?.get(element.id);
      dependencies.push(settings, endpoints?.openStart, endpoints?.openEnd, ...connectorSources(element, byId));
      const chain = context.pipeRenderChainStateMap?.get(element.id);
      if (chain) {
        let signature = chainSignatures.get(chain.headId);
        if (signature === undefined) {
          signature = JSON.stringify(context.pipeRenderChainStateMap?.get(chain.headId) ?? chain);
          chainSignatures.set(chain.headId, signature);
        }
        const tail = byId.get(chain.tailId);
        dependencies.push(chain.renderAsHead, signature, tail);
        if (tail) dependencies.push(...connectorSources(tail, byId));
      }
    } else if (element.type === 'refrigerant-branch-kit') {
      dependencies.push(settings);
      // Only an INLINE kit resolves its render centre against the scene:
      // `resolveInlineBranchKitRenderCenter` early-returns for every other
      // placement mode, after which the kit is positioned entirely by its own
      // record. A kit created by the branch proposal engine or the place-kit
      // tool is `fixed`; only a manual drop onto a run is `inline-pipe-run`.
      //
      // Depending on the whole scene here meant that changing ANY element
      // invalidated EVERY kit, and one kit rebuild is a three-bvh-csg union
      // measured at 70.8 ms — about 570 ms of frozen main thread on pointer-up
      // with eight kits, paid even while the board is flat 2D.
      if (element.properties.branchKitPlacementMode === 'inline-pipe-run') {
        dependencies.push(...context.allElements);
      }
    }
    return dependencies;
  };
}

function unchanged(previous: unknown[] | undefined, next: unknown[]): boolean {
  return previous !== undefined && previous.length === next.length
    && next.every((value, index) => value === previous[index]);
}

/** Keep current meshes alive across immutable model updates. A pipe also depends
 * on its live connectors, cap ownership and any joined render chain. Inline kits
 * can fall back to nearby runs, so their placement tracks the complete context. */
export function createHybridHvacScene<Mesh>(lifecycle: {
  build: (element: HvacElement, context: HvacBuildSceneContext) => Mesh | null;
  attach: (mesh: Mesh) => void;
  dispose: (mesh: Mesh) => void;
}) {
  const entries = new Map<string, { dependencies: unknown[]; mesh: Mesh | null }>();
  let currentModelRevision = 0;
  return {
    update(context: HvacBuildSceneContext, modelRevision: number): void {
      const currentIds = new Set(context.allElements.map(element => element.id));
      const dependenciesFor = dependencyReader(context, modelRevision);
      for (const [id, entry] of entries) {
        if (currentIds.has(id)) continue;
        if (entry.mesh !== null) lifecycle.dispose(entry.mesh);
        entries.delete(id);
      }
      for (const element of context.allElements) {
        const dependencies = dependenciesFor(element);
        const previous = entries.get(element.id);
        if (unchanged(previous?.dependencies, dependencies)) continue;
        // Build before releasing the old mesh, preserving it if a builder throws.
        const mesh = lifecycle.build(element, context);
        if (previous?.mesh != null) lifecycle.dispose(previous.mesh);
        if (mesh !== null) lifecycle.attach(mesh);
        entries.set(element.id, { dependencies, mesh });
      }
      currentModelRevision = modelRevision;
    },
    /** Resolve every affected preview, including an unchanged joined-chain head,
     * without changing committed mesh ownership or creating an undo boundary. */
    changedElements(context: HvacBuildSceneContext): HvacElement[] {
      const dependenciesFor = dependencyReader(context, currentModelRevision);
      return context.allElements.filter(element =>
        !unchanged(entries.get(element.id)?.dependencies, dependenciesFor(element)));
    },
    clear(): void {
      for (const entry of entries.values()) {
        if (entry.mesh !== null) lifecycle.dispose(entry.mesh);
      }
      entries.clear();
    },
  };
}
