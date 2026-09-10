import type { HvacElement } from '../../../types';

import { resolvePipeEditFrame } from './pipeEditGeometry';
import { buildPipeModelEdit, editablePipeNodes, isEditablePipe, type PipeModelEditResult } from './pipeEditModel';
import type { PipeRouteNode3D } from './pipeRoute3d';

const distance = (a: PipeRouteNode3D, b: PipeRouteNode3D) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Change one measured length while holding its chosen endpoint in place. */
export function buildPipeSegmentLengthEdit(input: {
  elements: readonly HvacElement[];
  elementId: string;
  segmentIndex: number;
  lengthMm: number;
  pivot: 'start' | 'end';
}): PipeModelEditResult {
  const source = input.elements.find(element => element.id === input.elementId);
  if (!source || !isEditablePipe(source)) return { ok: false, message: 'Select an editable refrigerant pipe.' };
  const nodes = editablePipeNodes(source);
  const index = input.segmentIndex;
  if (!Number.isInteger(index) || index < 0 || index >= nodes.length - 1) return { ok: false, message: 'Select a valid pipe segment.' };
  if (!Number.isFinite(input.lengthMm) || input.lengthMm <= 0) return { ok: false, message: 'Enter a positive segment length.' };
  if (input.pivot !== 'start' && input.pivot !== 'end') return { ok: false, message: 'Choose which endpoint to keep fixed.' };
  const start = nodes[index]!; const end = nodes[index + 1]!;
  const length = distance(start, end);
  if (length < 0.001) return { ok: false, message: 'This segment has no valid direction.' };
  const direction = { x: (end.x - start.x) / length, y: (end.y - start.y) / length, z: (end.z - start.z) / length };
  const movingIndex = input.pivot === 'start' ? index + 1 : index;
  const fixedIndex = input.pivot === 'start' ? index : index + 1;
  const delta = (input.lengthMm - length) * (input.pivot === 'start' ? 1 : -1);
  const offset = { x: direction.x * delta, y: direction.y * delta, z: direction.z * delta };
  const adjacentIndex = input.pivot === 'start' ? index + 1 : index - 1;
  const freeEndpoint = movingIndex === 0 || movingIndex === nodes.length - 1;
  const adjacent = freeEndpoint ? null : { start: nodes[adjacentIndex]!, end: nodes[adjacentIndex + 1]! };
  const adjacentLength = adjacent ? distance(adjacent.start, adjacent.end) : 0;
  const collinear = adjacent && adjacentLength > 0 && Math.abs(
    ((adjacent.end.x - adjacent.start.x) * direction.x + (adjacent.end.y - adjacent.start.y) * direction.y
      + (adjacent.end.z - adjacent.start.z) * direction.z) / adjacentLength) > 1 - 1e-9;
  const frame = resolvePipeEditFrame({ mode: 'world', nodes, selection: { kind: 'run' } })!;
  const result = buildPipeModelEdit({ elementId: source.id, elements: input.elements, frame,
    selection: freeEndpoint || collinear ? { kind: 'node', index: movingIndex } : { kind: 'segment', index: adjacentIndex },
    operation: freeEndpoint || collinear
      ? { kind: 'set-node', position: { x: nodes[movingIndex]!.x + offset.x,
        y: nodes[movingIndex]!.y + offset.y, z: nodes[movingIndex]!.z + offset.z } }
      : { kind: 'translate', offset } });
  if (!result.ok) return result;
  if (Math.abs(delta) < 1e-9) return { ok: true, elements: [source] };
  const next = result.elements.find(element => element.id === source.id)!;
  const edited = editablePipeNodes(next);
  if (distance(edited[fixedIndex]!, nodes[fixedIndex]!) > 0.001
    || Math.abs(distance(edited[index]!, edited[index + 1]!) - input.lengthMm) > 0.001) {
    return { ok: false, message: 'The adjoining connections constrain this length. Adjust the next segment first.' };
  }
  return result;
}
