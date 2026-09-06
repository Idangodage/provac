import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { buildPipeKitConnectionTargets } from './pipeKitConnectionTargets';
import { buildRefrigerantPipeElements } from './refrigerantPipePairModel';

function pair(): HvacElement[] {
  return buildRefrigerantPipeElements([{ x: 0, y: 0 }, { x: 1800, y: 0 }], { bundleId: 'bundle' })
    .map((element, index) => ({ ...element, id: `pipe-${index}`, rotation: 0 } as HvacElement));
}

describe('manual kit connection targets', () => {
  it('offers one pair socket at each open end, carrying both physical pipe identities', () => {
    const targets = buildPipeKitConnectionTargets(pair()).filter((target) => target.lineKind === 'both');
    expect(targets).toHaveLength(2);
    expect(targets[0]!.pipes.map((pipe) => pipe.elementId).sort()).toEqual(['pipe-0', 'pipe-1']);
  });

  it('never groups neighboring pipes from unrelated circuits', () => {
    const scene = pair();
    scene[1]!.properties.bundleId = 'different-system';
    expect(buildPipeKitConnectionTargets(scene).some((target) => target.lineKind === 'both')).toBe(false);
  });

  it('excludes occupied cut faces and reads the actual endpoint elevation', () => {
    const scene = pair();
    scene[0]!.properties.startConnection = { sourceElementId: 'unit' };
    scene[0]!.properties.routeNodes3d = [{ x: 0, y: 0, z: 2400 }, { x: 1800, y: 0, z: 2700 }];
    const targets = buildPipeKitConnectionTargets(scene);
    expect(targets.find((target) => target.id === 'pipe-0:start')).toBeUndefined();
    expect(targets.find((target) => target.id === 'pipe-0:end')!.pipes[0]!.elevationMm).toBe(2700);
    expect(targets.filter((target) => target.lineKind === 'both')).toHaveLength(1);
  });
});
