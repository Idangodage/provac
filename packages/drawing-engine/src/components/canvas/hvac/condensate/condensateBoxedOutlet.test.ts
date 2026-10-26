/**
 * The test project's own cassette (FDT28, with a drain pump): its refrigerant
 * pair leaves 93 mm beside its drain socket and turns south 175 mm out, so
 * every riser foot beside the socket lay within the general 50 mm drain ↔
 * refrigerant gap of its OWN stubs and the unit had "no unobstructed
 * connection from the drain outlet". Within the manufacturer's connection zone
 * those stubs need only their physical radii (as the departure hose and the
 * final validator take them): the riser climbs beside them and the drain runs
 * over the pair to the floor gully, nowhere touching a refrigerant pipe.
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement, Room, Wall } from '../../../../types';
import scene from '../__fixtures__/boxed-cassette-scene.json';
import { listNetworkPipeLanes } from '../networkPipeClearance';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from '../pipeRoutingSettings';

import { generateCondensateNetwork } from './condensateGenerator';
import { condensateSegmentDistance } from './condensateRiserClearance';
import { DEFAULT_CONDENSATE_SETTINGS } from './condensateSettings';
import { condensateInsulatedRadiusMm, readCondensatePipeSpec } from './condensateTypes';
import { findCondensateRefrigerantClashes, validateCondensateNetwork } from './condensateValidation';

const project = scene as unknown as { hvacElements: HvacElement[]; walls: Wall[]; rooms: Room[] };

describe('a cassette whose own refrigerant pair leaves beside its drain socket', () => {
  it('is drained: its riser climbs beside the pair, the drain clears every refrigerant pipe', () => {
    const result = generateCondensateNetwork([...project.hvacElements], {
      settings: DEFAULT_CONDENSATE_SETTINGS, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS, walls: project.walls, rooms: project.rooms,
    });
    expect(result.perUnit.map((unit) => [unit.status, unit.reason ?? null])).toEqual([['pumped', null]]);
    expect(result.issues).toEqual([]);
    const after = [...project.hvacElements, ...result.elementsToAdd];
    const errors = validateCondensateNetwork(after, { settings: DEFAULT_CONDENSATE_SETTINGS, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS })
      .issues.filter((issue) => issue.level === 'error').map((issue) => `${issue.code}: ${issue.message}`);
    expect(errors).toEqual([]);
    expect(findCondensateRefrigerantClashes(after)).toEqual([]);
    // Inside the connection zone too (where the validator does not look): never closer than the insulated surfaces.
    const lanes = listNetworkPipeLanes(after).filter((lane) => lane.service !== 'drain');
    let closest = Number.POSITIVE_INFINITY;
    for (const pipe of result.elementsToAdd) {
      const spec = readCondensatePipeSpec(pipe);
      const radius = condensateInsulatedRadiusMm(spec);
      for (let index = 1; index < spec.routeNodes3d.length; index += 1) {
        for (const lane of lanes) {
          for (const segment of lane.segments) {
            const gap = condensateSegmentDistance(spec.routeNodes3d[index - 1]!, spec.routeNodes3d[index]!, segment.a, segment.b) - radius - lane.radiusMm;
            closest = Math.min(closest, gap);
          }
        }
      }
    }
    expect(closest).toBeGreaterThanOrEqual(-0.5);
  });
});
