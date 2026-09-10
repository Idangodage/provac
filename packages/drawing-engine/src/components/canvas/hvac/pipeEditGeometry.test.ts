import { describe, expect, it } from 'vitest';

import {
  applyPipeRouteEdit,
  getPipeEditSelectionIndices,
  pipeEditPointFromWorld,
  pipeEditPointToWorld,
  resolvePipeEditFrame,
  type PipeEditSelection,
  type PipeRouteEditResult,
} from './pipeEditGeometry';
import type { PipeRouteNode3D } from './pipeRoute3d';

const run = { kind: 'run' } as const;
const node = (index: number): PipeEditSelection => ({ kind: 'node', index });
const segment = (index: number): PipeEditSelection => ({ kind: 'segment', index });
const point = (x: number, y: number, z: number): PipeRouteNode3D => ({ x, y, z });
const route = [point(10, 20, 300), point(110, 20, 300), point(110, 220, 300), point(110, 220, 600)];

function successful(result: PipeRouteEditResult): PipeRouteNode3D[] {
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.nodes;
}

function near(actual: PipeRouteNode3D, expected: PipeRouteNode3D): void {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
  expect(actual.z).toBeCloseTo(expected.z, 8);
}

function distance(a: PipeRouteNode3D, b: PipeRouteNode3D): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('pipe coordinate frames', () => {
  it('uses global XYZ for world point coordinates regardless of selection elevation', () => {
    const frame = resolvePipeEditFrame({ mode: 'world', nodes: route, selection: node(2) })!;
    expect(frame.origin).toEqual(point(0, 0, 0));
    expect(frame.labels).toEqual(['X', 'Y', 'Z']);
    expect(pipeEditPointToWorld(point(5, 9, 60), frame)).toEqual(point(5, 9, 60));
  });

  it('round trips points on an arbitrarily translated and inclined workplane', () => {
    const frame = resolvePipeEditFrame({
      mode: 'workplane', nodes: route, selection: run,
      workplane: { origin: point(1910, -235, 761), normal: point(1, 2, 3), xAxis: point(2, 1, 0.5) },
    })!;
    expect(frame.labels).toEqual(['U', 'V', 'N']);
    for (const local of [point(0, 0, 0), point(31, -827, 245), point(-5, 10, 0)]) {
      near(pipeEditPointFromWorld(pipeEditPointToWorld(local, frame), frame), local);
    }
    near(pipeEditPointToWorld(point(0, 0, 0), frame), point(1910, -235, 761));
  });

  it('builds a stable right-handed local frame for a vertical segment and its last node', () => {
    for (const selection of [segment(2), node(3)]) {
      const frame = resolvePipeEditFrame({ mode: 'local', nodes: route, selection })!;
      expect(frame.xAxis).toEqual(point(0, 0, 1));
      expect(frame.yAxis).toEqual(point(1, 0, 0));
      expect(frame.zAxis).toEqual(point(0, 1, 0));
      const local = point(100, 30, -90);
      near(pipeEditPointFromWorld(pipeEditPointToWorld(local, frame), frame), local);
    }
  });

  it('handles a workplane X hint parallel to its normal without unstable axes', () => {
    const frame = resolvePipeEditFrame({ mode: 'workplane', nodes: route, selection: run,
      workplane: { origin: point(0, 0, 70), normal: point(10, 0, 0), xAxis: point(3, 0, 0) } })!;
    expect(frame.xAxis).toEqual(point(0, 1, 0));
    expect(frame.yAxis).toEqual(point(0, 0, 1));
  });

  it('makes missing and non-finite workplanes unavailable', () => {
    expect(resolvePipeEditFrame({ mode: 'workplane', nodes: route, selection: run })).toBeNull();
    expect(resolvePipeEditFrame({ mode: 'workplane', nodes: route, selection: run,
      workplane: { origin: point(0, 0, 0), normal: point(0, 0, 0), xAxis: point(1, 0, 0) } })).toBeNull();
    expect(resolvePipeEditFrame({ mode: 'local', nodes: [point(0, 0, 0), point(NaN, 0, 0)], selection: run })).toBeNull();
  });
});

describe('numeric pipe route editing', () => {
  it('translates a whole run without mutating the input or changing its shape', () => {
    const baseline = structuredClone(route);
    const moved = successful(applyPipeRouteEdit({ nodes: route, selection: run, operation: { kind: 'translate', offset: point(12, -43, 67) } }));
    for (let index = 0; index < route.length; index += 1) {
      near(moved[index]!, point(route[index]!.x + 12, route[index]!.y - 43, route[index]!.z + 67));
      expect(moved[index]).not.toBe(route[index]);
    }
    expect(route).toEqual(baseline);
  });

  it('translates only the two endpoints of a selected segment', () => {
    const moved = successful(applyPipeRouteEdit({ nodes: route, selection: segment(1), operation: { kind: 'translate', offset: point(20, 0, 0) } }));
    expect(moved[0]).toEqual(route[0]);
    expect(moved[3]).toEqual(route[3]);
    expect(moved[1]).toEqual(point(130, 20, 300));
    expect(moved[2]).toEqual(point(130, 220, 300));
  });

  it('extends a terminal straight segment along local X using numerical input', () => {
    const selection = node(3);
    const frame = resolvePipeEditFrame({ mode: 'local', nodes: route, selection })!;
    const moved = successful(applyPipeRouteEdit({ nodes: route, selection, frame, operation: { kind: 'translate', offset: point(50, 0, 0) } }));
    expect(moved.slice(0, 3)).toEqual(route.slice(0, 3));
    expect(moved[3]).toEqual(point(110, 220, 650));
  });

  it('slides a segment between 45-degree legs without changing their directions', () => {
    const nodes = [point(0, 0, 0), point(1000, 1000, 0), point(1000, 2000, 0), point(2000, 3000, 0)];
    const edited = successful(applyPipeRouteEdit({ nodes, selection: segment(1),
      operation: { kind: 'translate', offset: point(200, 19, 0) },
      constraints: { preserveAdjacentDirections: true, protectStart: true, protectEnd: true } }));
    expect(edited).toEqual([nodes[0], point(1200, 1200, 0), point(1200, 2200, 0), nodes[3]]);
  });

  it('carries risers with a selected segment in a route rotated relative to world XY', () => {
    const base = [point(0, 0, 0), point(1000, 0, 0), point(1000, 0, 1000), point(1000, 1000, 1000), point(1000, 1000, 0), point(2000, 1000, 0)];
    const c = Math.SQRT1_2;
    const rotated = base.map(node => point((node.x - node.y) * c, (node.x + node.y) * c, node.z));
    const edited = successful(applyPipeRouteEdit({ nodes: rotated, selection: segment(2),
      operation: { kind: 'translate', offset: point(200 * c, 200 * c, 0) },
      constraints: { preserveAdjacentDirections: true, protectStart: true, protectEnd: true } }));
    near(edited[0]!, rotated[0]!); near(edited.at(-1)!, rotated.at(-1)!);
    for (const index of [1, 2, 3, 4]) near(edited[index]!, point(rotated[index]!.x + 200 * c, rotated[index]!.y + 200 * c, rotated[index]!.z));
  });

  it('does not report a successful segment edit when the requested direction cannot move it', () => {
    const nodes = [point(0, 0, 0), point(1000, 0, 0)];
    const request = { nodes, selection: segment(0), constraints: { preserveAdjacentDirections: true, protectStart: true } };
    expect(applyPipeRouteEdit({ ...request, operation: { kind: 'translate', offset: point(0, 100, 0) } }))
      .toMatchObject({ ok: false, error: { code: 'connection-position' } });
    expect(applyPipeRouteEdit({ ...request, operation: { kind: 'translate', offset: point(100, 0, 0) } }))
      .toMatchObject({ ok: false, error: { code: 'invalid-selection' } });
    expect(applyPipeRouteEdit({ ...request, operation: { kind: 'translate', offset: point(0, 0, 0) } }).ok).toBe(true);
  });

  it('keeps workplane translation offsets independent of its translated origin', () => {
    const frame = resolvePipeEditFrame({ mode: 'workplane', nodes: route, selection: run,
      workplane: { origin: point(4000, 5000, 6000), normal: point(1, 0, 0), xAxis: point(0, 1, 0) } })!;
    const moved = successful(applyPipeRouteEdit({ nodes: route, selection: run, frame, operation: { kind: 'translate', offset: point(10, 20, 30) } }));
    near(moved[0]!, point(40, 30, 320));
  });

  it('sets one point by absolute workplane coordinates', () => {
    const frame = resolvePipeEditFrame({ mode: 'workplane', nodes: route, selection: node(1),
      workplane: { origin: point(40, 80, 700), normal: point(1, 0, 0), xAxis: point(0, 1, 0) } })!;
    const edited = successful(applyPipeRouteEdit({ nodes: route, selection: node(1), frame,
      operation: { kind: 'set-node', position: point(10, 20, 30) } }));
    near(edited[1]!, point(70, 90, 720));
    expect(edited[0]).toEqual(route[0]);
    expect(edited[2]).toEqual(route[2]);
  });

  it('inserts a true 3D midpoint without collapsing a vertical riser in plan', () => {
    const edited = successful(applyPipeRouteEdit({ nodes: route, selection: segment(2), operation: { kind: 'insert' } }));
    expect(edited).toEqual([...route.slice(0, 3), point(110, 220, 450), route[3]]);
    const restored = successful(applyPipeRouteEdit({ nodes: edited, selection: node(3), operation: { kind: 'remove' } }));
    expect(restored).toEqual(route);
  });

  it('rejects removal of terminal points, zero-length segments and doubling back', () => {
    for (const index of [0, route.length - 1]) {
      expect(applyPipeRouteEdit({ nodes: route, selection: node(index), operation: { kind: 'remove' } })).toMatchObject({ ok: false, error: { code: 'invalid-selection' } });
    }
    expect(applyPipeRouteEdit({ nodes: route, selection: node(1), operation: { kind: 'set-node', position: route[0]! } })).toMatchObject({ ok: false, error: { code: 'degenerate-segment' } });
    expect(applyPipeRouteEdit({ nodes: [point(0, 0, 0), point(10, 0, 0), point(20, 0, 0)], selection: node(1), operation: { kind: 'set-node', position: point(30, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'degenerate-segment' } });
  });

  it('rejects stale selections instead of editing a different point', () => {
    for (const selection of [node(-1), node(4), segment(3), node(0.5), { kind: 'section', startIndex: 3, endIndex: 1 } as const]) {
      expect(getPipeEditSelectionIndices(route, selection)).toEqual([]);
      expect(applyPipeRouteEdit({ nodes: route, selection, operation: { kind: 'translate', offset: point(1, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'invalid-selection' } });
    }
  });

  it('rejects non-finite numeric input, sparse routes and invalid explicit frames', () => {
    expect(applyPipeRouteEdit({ nodes: route, selection: run, operation: { kind: 'translate', offset: point(Infinity, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    const sparse = new Array<PipeRouteNode3D>(3);
    sparse[0] = route[0]!;
    sparse[2] = route[2]!;
    expect(applyPipeRouteEdit({ nodes: sparse, selection: run, operation: { kind: 'translate', offset: point(0, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    const frame = resolvePipeEditFrame({ mode: 'world', nodes: route, selection: run })!;
    frame.yAxis = point(1, 0, 0);
    expect(applyPipeRouteEdit({ nodes: route, selection: run, frame, operation: { kind: 'translate', offset: point(1, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    expect(applyPipeRouteEdit({ nodes: route, selection: run, frame: null, operation: { kind: 'translate', offset: point(1, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
  });
});

describe('rigid endpoint-pivot rotation', () => {
  it('keeps the selected endpoint exactly fixed and preserves every pairwise distance', () => {
    const workplane = { origin: point(800, -200, 1000), normal: point(1, 2, 4), xAxis: point(2, -1, 1) };
    for (const mode of ['world', 'local', 'workplane'] as const) {
      const frame = resolvePipeEditFrame({ mode, nodes: route, selection: run, workplane })!;
      for (const axis of ['x', 'y', 'z'] as const) {
        for (const angleDegrees of [-177, -90, 0, 12.75, 45, 90, 360, 720]) {
          for (const pivot of ['start', 'end'] as const) {
            const rotated = successful(applyPipeRouteEdit({ nodes: route, selection: run, frame, operation: { kind: 'rotate', axis, angleDegrees, pivot } }));
            const pivotIndex = pivot === 'start' ? 0 : route.length - 1;
            expect(rotated[pivotIndex]).toEqual(route[pivotIndex]);
            for (let a = 0; a < route.length; a += 1) {
              for (let b = a + 1; b < route.length; b += 1) {
                expect(distance(rotated[a]!, rotated[b]!)).toBeCloseTo(distance(route[a]!, route[b]!), 8);
              }
            }
          }
        }
      }
    }
  });

  it('rotates around the opposite endpoint without moving that endpoint', () => {
    const nodes = [point(0, 0, 100), point(100, 0, 100), point(100, 100, 100)];
    const rotated = successful(applyPipeRouteEdit({ nodes, selection: run, operation: { kind: 'rotate', axis: 'z', angleDegrees: 90, pivot: 'end' } }));
    near(rotated[0]!, point(200, 0, 100));
    near(rotated[1]!, point(200, 100, 100));
    expect(rotated[2]).toEqual(nodes[2]);
  });

  it('uses one explicit world pivot consistently across connected runs', () => {
    const first = [point(0, 0, 100), point(100, 0, 100)];
    const second = [point(100, 0, 100), point(100, 200, 100)];
    const operation = { kind: 'rotate', axis: 'y', angleDegrees: 35, pivot: point(0, 0, 100) } as const;
    const movedFirst = successful(applyPipeRouteEdit({ nodes: first, selection: run, operation }));
    const movedSecond = successful(applyPipeRouteEdit({ nodes: second, selection: run, operation }));
    expect(movedFirst[1]).toEqual(movedSecond[0]);
    expect(distance(movedFirst[0]!, movedSecond[1]!)).toBeCloseTo(distance(first[0]!, second[1]!), 9);
  });

  it('rejects a pivot-fixed rotation that invalidates the connected port tangent', () => {
    const result = applyPipeRouteEdit({ nodes: route, selection: run, constraints: { protectStart: true },
      operation: { kind: 'rotate', axis: 'z', angleDegrees: 90, pivot: 'start' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'connection-orientation' } });
  });

  it('allows a connected pivot to rotate about its existing approach axis', () => {
    const moved = successful(applyPipeRouteEdit({ nodes: route, selection: run, constraints: { protectStart: true },
      operation: { kind: 'rotate', axis: 'x', angleDegrees: 90, pivot: 'start' } }));
    expect(moved[0]).toEqual(route[0]);
    near(moved[1]!, route[1]!);
    near(moved[2]!, point(110, 20, 500));
  });

  it('preserves a fixed exterior approach when rotating the free bend section around it', () => {
    const nodes = [point(-100, 0, 300), point(0, 0, 300), point(100, 0, 300), point(100, 100, 300)];
    const moved = successful(applyPipeRouteEdit({ nodes, selection: { kind: 'section', startIndex: 1, endIndex: 3 },
      operation: { kind: 'rotate', axis: 'x', angleDegrees: 90, pivot: 'start' } }));
    expect(moved[0]).toEqual(nodes[0]);
    expect(moved[1]).toEqual(nodes[1]);
    near(moved[3]!, point(100, 0, 400));
  });

  it('rejects a section rotation that cannot preserve its fixed neighboring approach', () => {
    const nodes = [point(-100, 0, 300), point(0, 0, 300), point(100, 0, 300), point(100, 100, 300), point(100, 200, 300)];
    expect(applyPipeRouteEdit({ nodes, selection: { kind: 'section', startIndex: 1, endIndex: 3 },
      operation: { kind: 'rotate', axis: 'x', angleDegrees: 90, pivot: 'start' } })).toMatchObject({ ok: false, error: { code: 'connection-orientation' } });
  });
});

describe('locked geometry and connections', () => {
  it('preserves exact baseline geometry on failure and blocks locked-point removal', () => {
    const baseline = structuredClone(route);
    expect(applyPipeRouteEdit({ nodes: route, selection: node(1), constraints: { lockedNodeIndices: [1] }, operation: { kind: 'remove' } })).toMatchObject({ ok: false, error: { code: 'locked' } });
    expect(applyPipeRouteEdit({ nodes: route, selection: run, constraints: { locked: true }, operation: { kind: 'translate', offset: point(10, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'locked' } });
    expect(route).toEqual(baseline);
  });

  it('keeps locks attached to the same original node across insertion', () => {
    const edited = successful(applyPipeRouteEdit({ nodes: route, selection: segment(0), constraints: { lockedNodeIndices: [1, 3] }, operation: { kind: 'insert' } }));
    expect(edited[2]).toEqual(route[1]);
    expect(edited[4]).toEqual(route[3]);
  });

  it('rejects endpoint movement and adjacent-point changes that turn the port approach', () => {
    expect(applyPipeRouteEdit({ nodes: route, selection: node(3), constraints: { protectEnd: true }, operation: { kind: 'translate', offset: point(0, 0, 10) } })).toMatchObject({ ok: false, error: { code: 'connection-position' } });
    expect(applyPipeRouteEdit({ nodes: route, selection: node(2), constraints: { protectEnd: true }, operation: { kind: 'translate', offset: point(10, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'connection-orientation' } });
  });

  it('validates component port position and orientation including end-port direction', () => {
    const ports = [
      { endpoint: 'start' as const, position: route[0]!, direction: point(7, 0, 0) },
      { endpoint: 'end' as const, position: route[3]!, direction: point(0, 0, -2) },
    ];
    expect(applyPipeRouteEdit({ nodes: route, selection: run, constraints: { ports }, operation: { kind: 'translate', offset: point(0, 0, 0) } }).ok).toBe(true);
    ports[1]!.direction = point(0, 0, 2);
    expect(applyPipeRouteEdit({ nodes: route, selection: run, constraints: { ports }, operation: { kind: 'translate', offset: point(0, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'connection-orientation' } });
  });

  it('allows shortening an approach while its protected connection stays aligned', () => {
    const moved = successful(applyPipeRouteEdit({ nodes: route, selection: node(1), constraints: { protectStart: true }, operation: { kind: 'translate', offset: point(-20, 0, 0) } }));
    expect(moved[0]).toEqual(route[0]);
    expect(moved[1]).toEqual(point(90, 20, 300));
  });

  it('rejects invalid constraint values instead of disabling validation', () => {
    for (const constraints of [{ minimumSegmentLengthMm: NaN }, { lockedNodeIndices: [99] }, { ports: [{ endpoint: 'start' as const, position: route[0]!, direction: point(1, 0, 0), angularToleranceDegrees: NaN }] }]) {
      expect(applyPipeRouteEdit({ nodes: route, selection: run, constraints, operation: { kind: 'translate', offset: point(0, 0, 0) } })).toMatchObject({ ok: false, error: { code: 'invalid-input' } });
    }
  });
});
