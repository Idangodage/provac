import type { HvacElement } from '../../../types';

import { resolveCopperSocketElbow, usesCopperSocketElbows } from './copperSocketElbows';
import { resolveFieldPipeBendRadiusMm } from './fieldPipeBends';
import { resolvePipeEditFrame, type PipeEditFrame, type PipeEditSelection } from './pipeEditGeometry';
import { editablePipeNodes } from './pipeEditModel';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

export interface PipeBendEdit {
  selection: PipeEditSelection;
  frame: PipeEditFrame;
  pivotPoint: PipeRouteNode3D;
  movingPort: PipeRouteNode3D;
  angleDegrees: number;
  radiusMm: number;
}

/** Roll a bend about an actual socket face (or formed-tube tangent), carrying
 * the route on its moving side. The existing connection validator decides
 * whether the far terminal allows this adjustment. No fitting is resized. */
export function resolvePipeBendEdit(element: HvacElement, cornerIndex: number, fixed: 'start' | 'end'): PipeBendEdit | null {
  const nodes = editablePipeNodes(element);
  if (!Number.isInteger(cornerIndex) || cornerIndex < 1 || cornerIndex >= nodes.length - 1) return null;
  const a = nodes[cornerIndex - 1]!; const b = nodes[cornerIndex]!; const c = nodes[cornerIndex + 1]!;
  const before = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const after = Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z);
  if (before < 0.001 || after < 0.001) return null;
  const incoming = { x: (b.x - a.x) / before, y: (b.y - a.y) / before, z: (b.z - a.z) / before };
  const outgoing = { x: (c.x - b.x) / after, y: (c.y - b.y) / after, z: (c.z - b.z) / after };
  const angle = Math.acos(Math.max(-1, Math.min(1, incoming.x * outgoing.x + incoming.y * outgoing.y + incoming.z * outgoing.z)));
  if (angle < 1e-5 || angle > Math.PI - 1e-5) return null;
  const degrees = angle * 180 / Math.PI;
  const standard = Math.abs(degrees - 90) < 0.01 ? 90 : Math.abs(degrees - 45) < 0.01 ? 45 : null;
  const spec = resolveRefrigerantPipeSpec(element.properties);
  const elbow = standard && usesCopperSocketElbows(element.properties) ? resolveCopperSocketElbow(spec.pipeDiameterMm, standard) : null;
  const radiusMm = elbow?.centerlineRadiusMm ?? resolveFieldPipeBendRadiusMm(spec.outerDiameterMm, element.properties.bendRadiusFactor);
  const takeoff = elbow?.centerToFaceMm ?? radiusMm * Math.tan(angle / 2);
  if (takeoff > before + 0.001 || takeoff > after + 0.001) return null;
  const inlet = { x: b.x - incoming.x * takeoff, y: b.y - incoming.y * takeoff, z: b.z - incoming.z * takeoff };
  const outlet = { x: b.x + outgoing.x * takeoff, y: b.y + outgoing.y * takeoff, z: b.z + outgoing.z * takeoff };
  const pivotPoint = fixed === 'start' ? inlet : outlet;
  const axis = fixed === 'start' ? incoming : outgoing;
  const frame = resolvePipeEditFrame({ mode: 'local', selection: { kind: 'run' }, nodes: [pivotPoint,
    { x: pivotPoint.x + axis.x * 100, y: pivotPoint.y + axis.y * 100, z: pivotPoint.z + axis.z * 100 }] });
  if (!frame) return null;
  frame.labels = ['Port axis', 'Local Y', 'Local Z'];
  return { selection: { kind: 'section', startIndex: fixed === 'start' ? cornerIndex : 0, endIndex: fixed === 'start' ? nodes.length - 1 : cornerIndex },
    frame, pivotPoint, movingPort: fixed === 'start' ? outlet : inlet, radiusMm, angleDegrees: degrees };
}
