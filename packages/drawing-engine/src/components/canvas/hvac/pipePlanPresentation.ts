import type { HvacElement, Point2D } from '../../../types';

import { compileCopperSocketElbowRoute, type CopperSocketElbowPlacement } from './copperSocketElbowRoute';
import { resolveCopperSocketElbowMinimumRadius, usesCopperSocketElbows } from './copperSocketElbows';
import { resolveFieldPipeBendRadiusMm } from './fieldPipeBends';
import { liftPipePlanRouteTo3d, readPipeRouteNodes3d, type PipeRouteNode3D } from './pipeRoute3d';
import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipeVisual,
} from './refrigerantPipePairModel';

export interface PlanPipeTube {
  lineKind: 'gas' | 'liquid';
  points: Point2D[];
  outerDiameterMm: number;
  copperDiameterMm: number;
  /** Local unresolved spans, shown quietly on the drawing without a modal. */
  unresolvedSegments?: Point2D[][];
  fittings?: CopperSocketElbowPlacement[];
  insulationSegments?: Point2D[][];
  copperSegments?: Point2D[][];
}

type PipeLevelConnection = { connectionKind: 'unit-port' | 'field-pipe'; elevationMm: number } | null;

function withSocketElbows(tube: PlanPipeTube, element: Pick<HvacElement, 'properties'>,
  levels: { guide: PipeRouteNode3D[]; baselineZ: number;
    startConnection: PipeLevelConnection; endConnection: PipeLevelConnection }): PlanPipeTube {
  if (!usesCopperSocketElbows(element.properties)) return tube;
  const { guide, baselineZ, startConnection, endConnection } = levels;
  const guideStartZ = guide.length >= 2 ? guide[0]!.z : baselineZ;
  const guideEndZ = guide.length >= 2 ? guide.at(-1)!.z : baselineZ;
  const needsElevation = guide.some(node => Math.abs(node.z - guideStartZ) > 1e-5)
    || Boolean(startConnection && Math.abs(startConnection.elevationMm - guideStartZ) > 1e-5)
    || Boolean(endConnection && Math.abs(endConnection.elevationMm - guideEndZ) > 1e-5);
  // Project the actual fitting assembly after its elevations are resolved. A
  // level change at a plan corner is two elbows in different vertical planes,
  // not an additional horizontal elbow through the projected riser stack.
  // Flat routes keep their existing inexpensive presentation/cache path.
  const nodes = needsElevation
    ? liftPipePlanRouteTo3d(tube.points, guide.length >= 2 ? guide
      : tube.points.map(point => ({ ...point, z: baselineZ })), {
      startConnection, endConnection, outerDiameterMm: tube.outerDiameterMm,
      bendRadiusMm: resolveFieldPipeBendRadiusMm(tube.outerDiameterMm, element.properties.bendRadiusFactor),
      pipeDiameterMm: tube.copperDiameterMm,
      minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(element.properties),
    })
    : tube.points.map(point => ({ ...point, z: 0 }));
  const route = compileCopperSocketElbowRoute(nodes, tube.copperDiameterMm,
    { minimumBendRadiusMm: resolveCopperSocketElbowMinimumRadius(element.properties),
      startStraightMm: startConnection?.connectionKind === 'unit-port' ? getActivePipeRoutingSettings().minimumPortStubMm : 0,
      endStraightMm: endConnection?.connectionKind === 'unit-port' ? getActivePipeRoutingSettings().minimumPortStubMm : 0 });
  if (!route.fittings.length) return needsElevation ? { ...tube, points: nodes } : tube;
  return { ...tube, points: route.centerline, fittings: route.fittings,
    insulationSegments: route.insulationRuns, copperSegments: route.pipeRuns };
}

/** Plan presentation consumes the connection-aware model, without re-offsetting
 * lanes or fitting a second, display-only bend over an already rounded path. */
export function buildPipePlanTubes(
  element: Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'properties' | 'elevation'>,
  context: HvacElement[] = [],
): PlanPipeTube[] {
  if (element.type === 'refrigerant-pipe-pair') {
    const visual = buildRefrigerantPipePairVisual(element, context);
    const authoredGuide = readPipeRouteNodes3d(element);
    const baselineZ = element.elevation + (visual.gasLocalZMm + visual.liquidLocalZMm) / 2;
    return [
      {
        lineKind: 'gas',
        points: visual.gasContinuousOuterPoints,
        outerDiameterMm: visual.gasOuterDiameterMm,
        copperDiameterMm: visual.gasPipeDiameterMm,
      },
      {
        lineKind: 'liquid',
        points: visual.liquidContinuousOuterPoints,
        outerDiameterMm: visual.liquidOuterDiameterMm,
        copperDiameterMm: visual.liquidPipeDiameterMm,
      },
    ].map(tube => {
      const gas = tube.lineKind === 'gas';
      const lineZ = element.elevation + (gas ? visual.gasLocalZMm : visual.liquidLocalZMm);
      const lineConnection = (bundle: typeof visual.startBundleConnection): PipeLevelConnection => bundle ? {
        connectionKind: bundle.connectionKind,
        elevationMm: gas ? bundle.gasElevationMm : bundle.liquidElevationMm,
      } : null;
      return withSocketElbows(tube as PlanPipeTube, element, {
        guide: authoredGuide.map(node => ({ ...node, z: node.z + lineZ - baselineZ })),
        baselineZ: lineZ,
        startConnection: lineConnection(visual.startBundleConnection),
        endConnection: lineConnection(visual.endBundleConnection),
      });
    });
  }
  if (element.type !== 'refrigerant-pipe') return [];
  const visual = buildRefrigerantPipeVisual(element, context);
  return [withSocketElbows({
    lineKind: visual.lineKind,
    points: visual.continuousOuterPoints,
    outerDiameterMm: visual.outerDiameterMm,
    copperDiameterMm: visual.pipeDiameterMm,
    ...(visual.invalidHardSegmentCount > 0 ? {
      unresolvedSegments: visual.segmentVisuals.filter(segment => segment.invalidHardGeometry).map(segment => segment.points),
    } : {}),
  }, element, {
    guide: readPipeRouteNodes3d(element), baselineZ: element.elevation + visual.localZMm,
    startConnection: visual.startConnection,
    endConnection: visual.endConnection,
  })];
}

export function pipePolylinePath(points: readonly Point2D[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}
