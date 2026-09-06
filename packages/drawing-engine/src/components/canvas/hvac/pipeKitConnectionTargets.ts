import type { HvacElement, Point2D } from '../../../types';

import type { SnapTargetEnd } from './branchKitPlacementSnap';
import { readPipeRouteNodes3d } from './pipeRoute3d';
import { resolveRefrigerantPipePairSpec, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

export interface KitPipeEnd {
  elementId: string;
  end: 'start' | 'end';
  lineKind: 'gas' | 'liquid' | 'both';
  elevationMm: number;
}

export interface PipeKitConnectionTarget extends SnapTargetEnd {
  pipes: KitPipeEnd[];
  bundleId?: string;
}

/** Pair sockets come from explicit bundle identity. Two nearby unrelated lines
 * must never become a gas/liquid connection just because they look parallel. */
export function buildPipeKitConnectionTargets(scene: HvacElement[]): PipeKitConnectionTarget[] {
  const targets: PipeKitConnectionTarget[] = [];
  for (const element of scene) {
    const isPair = element.type === 'refrigerant-pipe-pair';
    if (!isPair && element.type !== 'refrigerant-pipe') continue;
    const spec = isPair ? resolveRefrigerantPipePairSpec(element.properties) : resolveRefrigerantPipeSpec(element.properties);
    const route = spec.routePoints;
    if (route.length < 2) continue;
    const nodes = readPipeRouteNodes3d(element);
    for (const end of ['start', 'end'] as const) {
      const connected = isPair
        ? element.properties[end === 'start' ? 'startBundleConnection' : 'endBundleConnection']
        : element.properties[end === 'start' ? 'startConnection' : 'endConnection'];
      if (connected) continue;
      const point = end === 'start' ? route[0]! : route.at(-1)!;
      const candidates = end === 'start' ? route.slice(1) : route.slice(0, -1).reverse();
      const neighbor = candidates.find((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) > 1e-6);
      if (!neighbor) continue;
      const dx = point.x - neighbor.x;
      const dy = point.y - neighbor.y;
      const length = Math.hypot(dx, dy);
      const lineKind = isPair ? 'both' : element.properties.lineKind === 'liquid' ? 'liquid' : 'gas';
      const endpointNode = end === 'start' ? nodes[0] : nodes.at(-1);
      const outer = typeof element.properties.outerDiameterMm === 'number' ? element.properties.outerDiameterMm : element.height;
      targets.push({
        id: `${element.id}:${end}`,
        point: { ...point },
        direction: { x: dx / length, y: dy / length },
        lineKind,
        bundleId: typeof element.properties.bundleId === 'string' ? element.properties.bundleId : undefined,
        pipes: [{ elementId: element.id, end, lineKind, elevationMm: endpointNode?.z ?? element.elevation + outer / 2 }],
      });
    }
  }
  const singles = [...targets];
  const used = new Set<string>();
  for (const gas of singles.filter((target) => target.lineKind === 'gas' && target.bundleId)) {
    const liquid = singles.filter((target) => target.lineKind === 'liquid' && target.bundleId === gas.bundleId && !used.has(target.id))
      .filter((target) => target.direction.x * gas.direction.x + target.direction.y * gas.direction.y > 0.98)
      .sort((a, b) => distance(a.point, gas.point) - distance(b.point, gas.point))[0];
    if (!liquid) continue;
    // Matching cut faces must lie on the same transverse station. This excludes
    // opposite ends of an interrupted or partially connected bundle.
    const along = (liquid.point.x - gas.point.x) * gas.direction.x + (liquid.point.y - gas.point.y) * gas.direction.y;
    if (Math.abs(along) > 1) continue;
    used.add(liquid.id);
    targets.push({
      id: `pair:${gas.id}:${liquid.id}`,
      point: { x: (gas.point.x + liquid.point.x) / 2, y: (gas.point.y + liquid.point.y) / 2 },
      direction: gas.direction,
      lineKind: 'both',
      pipes: [...gas.pipes, ...liquid.pipes],
      bundleId: gas.bundleId,
    });
  }
  return targets;
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
