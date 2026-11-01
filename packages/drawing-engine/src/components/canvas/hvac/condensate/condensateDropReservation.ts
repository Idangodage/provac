/**
 * The vertical drop into each drain termination, reserved before the drains are
 * laid. A termination fixes the drop's plan point, so a drain cannot move out of a
 * main's way; a main laid first can move, if it knows.
 *
 * A body in the scene the refrigerant planner reads, never in what it proposes.
 */
import type { HvacElement, Wall } from '../../../../types';

import { buildCondensateSink } from './condensateEnvironment';
import { selectCondensatePipeSize } from './condensatePipeCatalog';
import { getIndoorUnitDrainPort } from './condensatePorts';
import type { CondensateDesignSettings } from './condensateSettings';
import { isCondensateGully } from './condensateTypes';

export function reservedDrainDrops(scene: readonly HvacElement[], options: {
  settings: CondensateDesignSettings;
  walls?: readonly Wall[];
  gullyIds?: readonly string[];
  /** The highest a drain could join its drop. */
  topZ: number;
}): HvacElement[] {
  const { settings } = options;
  const gullies = scene.filter((element) => isCondensateGully(element) && (!options.gullyIds || options.gullyIds.includes(element.id)));
  if (!gullies.length) return [];
  // The size if every unit drained through it.
  const ports = scene.flatMap((element) => getIndoorUnitDrainPort(element, settings) ?? []);
  const { size } = selectCondensatePipeSize({
    upstreamCapacityKw: ports.reduce((sum, port) => sum + port.capacityKw, 0),
    largestOutletOuterDiameterMm: Math.max(0, ...ports.map((port) => port.outletOuterDiameterMm)),
    upstreamUnitCount: ports.length,
    slopePercent: settings.minSlopePercent,
  }, settings);
  return gullies.flatMap((gully) => {
    const sink = buildCondensateSink(gully, settings, options.walls ?? []);
    if (options.topZ <= sink.terminalZ) return [];
    const { x, y } = sink.point;
    return [{
      id: `reserved-drain-drop-${gully.id}`, type: 'condensate-pipe', position: { x, y }, rotation: 0, width: 0, depth: 0, height: 0,
      elevation: sink.terminalZ, mountType: 'ceiling', label: 'Reserved drain drop', supplyZoneRatio: 0.5,
      properties: {
        routeNodes3d: [{ x, y, z: options.topZ }, { x, y, z: sink.terminalZ }],
        outerDiameterMm: size.outerDiameterMm, insulationThicknessMm: settings.insulationThicknessMm,
      },
    } as unknown as HvacElement];
  });
}
