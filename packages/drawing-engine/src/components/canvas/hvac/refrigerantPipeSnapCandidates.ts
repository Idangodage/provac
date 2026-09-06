import * as THREE from 'three';

import type { HvacElement, Point2D } from '../../../types';
import type {
  SnapCandidate,
  SnapType,
} from '../../../vrf/interaction/snap-manager';

import type {
  RefrigerantPipeBundleConnection,
  RefrigerantPipeLineMode,
} from './refrigerantPipePairModel';

export interface RefrigerantBundleSnapCandidate {
  candidate: SnapCandidate;
  bundle: RefrigerantPipeBundleConnection;
}

function candidateIdentity(
  target: RefrigerantPipeBundleConnection,
  fallbackIndex: number,
): string {
  const semanticIdentity = [
    target.sourceElementId,
    target.portId,
    target.nodeId,
    target.gasPortId,
    target.liquidPortId,
    target.gasNodeId,
    target.liquidNodeId,
    target.terminalRole,
    target.guideReference,
  ].filter((part): part is string => Boolean(part)).join(':');
  const geometryIdentity = [
    target.gasPoint.x.toFixed(3),
    target.gasPoint.y.toFixed(3),
    target.liquidPoint.x.toFixed(3),
    target.liquidPoint.y.toFixed(3),
  ].join(':');
  return [
    'model',
    semanticIdentity || fallbackIndex,
    geometryIdentity,
  ].join(':');
}

export function resolveRefrigerantBundleSnapType(
  target: RefrigerantPipeBundleConnection,
  sourceType?: HvacElement['type'],
): SnapType {
  if (target.connectionKind === 'unit-port') return 'equipment-port';
  if (target.terminalRole === 'inlet') return 'branch-inlet';
  if (target.terminalRole || sourceType === 'refrigerant-branch-kit') {
    return 'branch-outlet';
  }
  return 'pipe-endpoint';
}

export function buildRefrigerantBundleSnapCandidates(options: {
  targets: readonly RefrigerantPipeBundleConnection[];
  pointer: Point2D;
  lineMode: RefrigerantPipeLineMode;
  screenPxPerMm: number;
  sourceTypeById?: ReadonlyMap<string, HvacElement['type']>;
  isTargetValid?: (target: RefrigerantPipeBundleConnection) => boolean;
  messageForTarget?: (target: RefrigerantPipeBundleConnection) => string;
}): RefrigerantBundleSnapCandidate[] {
  const screenPxPerMm = Number.isFinite(options.screenPxPerMm)
    ? Math.max(0, options.screenPxPerMm)
    : 0;
  return options.targets.map((target, index) => {
    const gasDistanceMm = Math.hypot(
      target.gasPoint.x - options.pointer.x,
      target.gasPoint.y - options.pointer.y,
    );
    const liquidDistanceMm = Math.hypot(
      target.liquidPoint.x - options.pointer.x,
      target.liquidPoint.y - options.pointer.y,
    );
    const distanceMm = options.lineMode === 'gas'
      ? gasDistanceMm
      : options.lineMode === 'liquid'
        ? liquidDistanceMm
        : Math.min(gasDistanceMm, liquidDistanceMm);
    const sourceType = target.sourceElementId
      ? options.sourceTypeById?.get(target.sourceElementId)
      : undefined;
    return {
      bundle: target,
      candidate: {
        id: candidateIdentity(target, index),
        type: resolveRefrigerantBundleSnapType(target, sourceType),
        worldPoint: new THREE.Vector3(
          target.point.x,
          target.point.y,
          target.elevationMm,
        ),
        screenDistancePx: distanceMm * screenPxPerMm,
        targetEntityId: target.sourceElementId,
        message: options.messageForTarget?.(target) ?? 'Pipe connection',
        isValid: options.isTargetValid?.(target) ?? true,
      },
    };
  });
}
