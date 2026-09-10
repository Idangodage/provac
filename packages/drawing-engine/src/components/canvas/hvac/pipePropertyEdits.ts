import type { HvacElement } from '../../../types';

import { resolvePipeEditFrame, type PipeEditSelection, type PipeRouteEditOperation } from './pipeEditGeometry';
import { buildPipeModelEdit, editablePipeMaterials, editablePipeNodes, type PipeModelEditResult } from './pipeEditModel';
import { resolveRefrigerantPipeSpec, type RefrigerantPipeMaterial } from './refrigerantPipePairModel';

export type PipePropertyEdit =
  | { kind: 'coordinate'; index: number; axis: 'x' | 'y' | 'z'; valueMm: number }
  | { kind: 'insert'; index: number }
  | { kind: 'remove'; index: number }
  | { kind: 'material'; index: number; material: RefrigerantPipeMaterial };

/** Properties and canvas editing share the same world-coordinate validation path. */
export function buildPipePropertyEdit(
  elements: readonly HvacElement[], elementId: string, edit: PipePropertyEdit,
): PipeModelEditResult {
  const element = elements.find(candidate => candidate.id === elementId);
  if (!element) return { ok: false, message: 'The selected pipe is no longer available.' };
  const nodes = editablePipeNodes(element);
  const selection: PipeEditSelection = edit.kind === 'insert' || edit.kind === 'material'
    ? { kind: 'segment', index: edit.index } : { kind: 'node', index: edit.index };
  const frame = resolvePipeEditFrame({ mode: 'world', nodes, selection });
  if (!frame) return { ok: false, message: 'World coordinates are unavailable for this pipe.' };
  if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= nodes.length
    || (selection.kind === 'segment' && edit.index >= nodes.length - 1)) {
    return { ok: false, message: 'The selected route point or segment is no longer available.' };
  }
  let operation: PipeRouteEditOperation;
  if (edit.kind === 'coordinate') operation = { kind: 'set-node', position: { ...nodes[edit.index]!, [edit.axis]: edit.valueMm } };
  else if (edit.kind === 'material') {
    if (edit.material !== 'hard' && edit.material !== 'flexible') return { ok: false, message: 'Choose hard or flexible copper.' };
    const spec = resolveRefrigerantPipeSpec(element.properties);
    if (edit.material !== 'hard' && (edit.index === 0 && spec.startConnection?.connectionKind === 'unit-port'
      || edit.index === nodes.length - 2 && spec.endConnection?.connectionKind === 'unit-port')) {
      return { ok: false, message: 'The straight connection to an equipment port must remain hard copper.' };
    }
    const materials = editablePipeMaterials(element, nodes);
    materials[edit.index] = edit.material;
    const prospective = { ...element, properties: { ...element.properties,
      routePoints: nodes.map(({ x, y }) => ({ x, y })), segmentMaterials: materials } };
    const result = buildPipeModelEdit({ elementId, elements: elements.map(candidate => candidate.id === elementId ? prospective : candidate),
      selection, operation: { kind: 'translate', offset: { x: 0, y: 0, z: 0 } }, frame });
    // A material edit validates the route but must not rewrite its geometry or levels.
    return result.ok ? { ok: true, elements: [{ ...element, properties: { ...element.properties, segmentMaterials: materials } }] } : result;
  } else operation = { kind: edit.kind };
  return buildPipeModelEdit({ elementId, elements, selection, operation, frame });
}
