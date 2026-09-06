import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import { disposeObject3DResources } from '../threeResourceLifecycle';

import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { applyNetworkPipeLevels, planNetworkPipeLevels } from './networkPipeLevels';
import { liftPipePlanRouteTo3d, normalizePipeRouteNodes3d } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import {
  buildRefrigerantPipeElements,
  buildRefrigerantPipeVisual,
  getRefrigerantPipeBundleSnapTargets,
} from './refrigerantPipePairModel';
import { buildHvacElementMesh } from './three3d/buildHvacElementMesh';

describe('corner risers with real cassette sockets and paired service lanes', () => {
  const cases = [0, 90, 180, 270].flatMap(rotation => [false, true].flatMap(reverse =>
    [-600, 600].map(levelChange => ({ rotation, reverse, levelChange }))));

  it.each(cases)('combines the field turn and rise beyond a retained socket gather ($rotation°, reverse $reverse, level $levelChange)',
    ({ rotation, reverse, levelChange }) => {
      const unit: HvacElement = {
        id: 'cassette', type: 'ceiling-cassette-ac', position: { x: 500, y: 600 },
        width: 600, depth: 600, height: 250, elevation: 2200, rotation,
        mountType: 'ceiling', label: 'Cassette', supplyZoneRatio: 0, properties: {},
      };
      const socket = getRefrigerantPipeBundleSnapTargets([unit])[0]!;
      const advance = (along: number, across = 0) => ({
        x: socket.point.x + socket.direction.x * along - socket.direction.y * across,
        y: socket.point.y + socket.direction.y * along + socket.direction.x * across,
      });
      const route = [socket.point, advance(900), advance(900, 1500)];
      if (reverse) route.reverse();
      const pipes = buildRefrigerantPipeElements(route, {
        ...(reverse ? { endBundleConnection: socket } : { startBundleConnection: socket }),
        bendRadiusFactor: 1,
      }).map((element, index) => ({ ...element, id: index ? 'liquid' : 'gas' } as HvacElement));
      const scene = [unit, ...pipes];
      const plan = planNetworkPipeLevels(scene, {
        gasHostId: 'gas', liquidHostId: 'liquid', startBundle: socket,
        gasHostElevationMm: socket.gasElevationMm + levelChange,
        liquidHostElevationMm: socket.liquidElevationMm,
        settings: DEFAULT_PIPE_ROUTING_SETTINGS,
      });
      // Exercise a selected gas corridor while the liquid remains at its port
      // level. Socket-spacing gathers preceding the field corner must survive.
      plan.gasElevationMm = socket.gasElevationMm + levelChange;
      plan.liquidElevationMm = socket.liquidElevationMm;
      const applied = applyNetworkPipeLevels(scene, plan);
      expect(applied.issues).toEqual([]);
      const gas = applied.elements.find(element => element.id === 'gas')!;
      const appliedScene = [unit, ...applied.elements];
      const visual = buildRefrigerantPipeVisual(gas, appliedScene);
      const guide = normalizePipeRouteNodes3d(gas.properties.routeNodes3d);
      const nodes = liftPipePlanRouteTo3d(visual.continuousOuterPoints, guide, {
        startConnection: visual.startConnection, endConnection: visual.endConnection,
        outerDiameterMm: visual.outerDiameterMm, pipeDiameterMm: visual.pipeDiameterMm,
      });
      const built = compileCopperSocketElbowRoute(nodes, visual.pipeDiameterMm, {
        ...(reverse ? { endStraightMm: 200 } : { startStraightMm: 200 }),
      });
      expect(built.issues).toEqual([]);
      expect(built.fittings.filter(fitting => fitting.spec.angleDeg === 90)).toHaveLength(2);
      const endpoint = reverse ? nodes.at(-1)! : nodes[0]!;
      expect(endpoint.x).toBeCloseTo(socket.gasPoint.x, 6);
      expect(endpoint.y).toBeCloseTo(socket.gasPoint.y, 6);
      expect(endpoint.z).toBeCloseTo(socket.gasElevationMm, 6);
      expect((reverse ? nodes[0]! : nodes.at(-1)!).z).toBeCloseTo(plan.gasElevationMm, 6);

      const mesh = buildHvacElementMesh(gas, { allElements: appliedScene })!;
      try {
        const elbows: THREE.Mesh[] = [];
        mesh.traverse(object => {
          if (object instanceof THREE.Mesh && object.userData.pipeSurfaceRole === 'fitting'
            && object.userData.elbowAngleDeg === 90) elbows.push(object);
        });
        expect(elbows).toHaveLength(2);
        expect(mesh.userData.copperElbowIssues).toEqual([]);
      } finally {
        disposeObject3DResources(mesh);
      }
    });
});
