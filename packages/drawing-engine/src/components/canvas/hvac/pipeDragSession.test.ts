import { describe, expect, it, vi } from 'vitest';

import type { Point2D } from '../../../types';

import { beginPipeDrag, type PipeCommitActions, type PipeDragGhost } from './pipeDragSession';
import type { PipeSegmentMaterial } from './pipeInteractionCore';
import { withCanonicalPipeRoute } from './pipeRoute3d';

const p = (x: number, y: number): Point2D => ({ x, y });
const baseline: PipeDragGhost = {
  route: [p(0, 0), p(100, 0), p(100, 100)],
  materials: ['hard', 'hard'] as PipeSegmentMaterial[],
};

function spyActions(): {
  actions: PipeCommitActions;
  update: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn<(id: string, updates: Record<string, unknown>, options?: { skipHistory?: boolean }) => void>();
  const history = vi.fn<(label: string) => void>();
  return { actions: { updateHvacElement: update, saveToHistory: history }, update, history };
}

describe('pipeDragSession — commit-once boundary', () => {
  it('writes NOTHING to the store across a 20-tick drag, then commits exactly once', () => {
    const { actions, update, history } = spyActions();
    const session = beginPipeDrag('pipe-1', baseline);

    for (let tick = 0; tick < 20; tick += 1) {
      session.update({
        route: [p(0, 0), p(100, tick), p(100, 100)],
        materials: baseline.materials,
      });
    }
    // The whole point: zero store writes during the drag.
    expect(update).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();

    const committed = session.commit(
      actions,
      (ghost) => ({ properties: { routePoints: ghost.route } }),
      'Edit refrigerant pipe vertex',
    );

    expect(committed).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      'pipe-1',
      { properties: { routePoints: [p(0, 0), p(100, 19), p(100, 100)] } },
      { skipHistory: true },
    );
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith('Edit refrigerant pipe vertex');
  });

  it('is idempotent: a second commit does nothing', () => {
    const { actions, update, history } = spyActions();
    const session = beginPipeDrag('pipe-1', baseline);
    session.update({ route: [p(0, 0), p(50, 50), p(100, 100)], materials: baseline.materials });

    expect(session.commit(actions, (g) => ({ properties: { routePoints: g.route } }), 'a')).toBe(true);
    expect(session.commit(actions, (g) => ({ properties: { routePoints: g.route } }), 'b')).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(1);
  });

  it('commits a 3D-authored plan edit once with canonical XYZ nodes and materials', () => {
    const { actions, update, history } = spyActions();
    const element = {
      properties: {
        routePoints: baseline.route,
        routeNodes3d: [
          { x: 0, y: 0, z: 200 },
          { x: 100, y: 0, z: 350 },
          { x: 100, y: 100, z: 500 },
        ],
        segmentMaterials: baseline.materials,
      },
    };
    const session = beginPipeDrag('pipe-3d', baseline);
    const nextRoute = [p(0, 0), p(120, 40), p(100, 100)];
    session.update({ route: nextRoute, materials: ['flexible', 'hard'] });

    const committed = session.commit(
      actions,
      (ghost) => ({
        properties: withCanonicalPipeRoute(element, ghost.route, {
          segmentMaterials: ghost.materials,
        }).properties,
      }),
      'Edit refrigerant pipe vertex',
    );

    expect(committed).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      'pipe-3d',
      {
        properties: {
          routePoints: nextRoute,
          routeNodes3d: [
            { x: 0, y: 0, z: 200 },
            { x: 120, y: 40, z: 350 },
            { x: 100, y: 100, z: 500 },
          ],
          segmentMaterials: ['flexible', 'hard'],
        },
      },
      { skipHistory: true },
    );
    expect(history).toHaveBeenCalledTimes(1);
  });

  it('a no-op drag (no update) commits nothing', () => {
    const { actions, update, history } = spyActions();
    const session = beginPipeDrag('pipe-1', baseline);
    expect(session.commit(actions, (g) => ({ properties: { routePoints: g.route } }), 'x')).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it('when buildUpdates returns null, nothing is written', () => {
    const { actions, update, history } = spyActions();
    const session = beginPipeDrag('pipe-1', baseline);
    session.update({ route: [p(0, 0), p(10, 10), p(100, 100)], materials: baseline.materials });
    expect(session.commit(actions, () => null, 'x')).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it('abort closes the session without committing', () => {
    const { actions, update, history } = spyActions();
    const session = beginPipeDrag('pipe-1', baseline);
    session.update({ route: [p(0, 0), p(10, 10), p(100, 100)], materials: baseline.materials });
    session.abort();
    expect(session.closed).toBe(true);
    expect(session.commit(actions, (g) => ({ properties: { routePoints: g.route } }), 'x')).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it('exposes the live ghost and dirty flag', () => {
    const session = beginPipeDrag('pipe-1', baseline);
    expect(session.dirty).toBe(false);
    expect(session.ghost).toBe(baseline);
    const next = { route: [p(0, 0), p(1, 1), p(100, 100)], materials: baseline.materials };
    session.update(next);
    expect(session.dirty).toBe(true);
    expect(session.ghost).toBe(next);
  });
});
