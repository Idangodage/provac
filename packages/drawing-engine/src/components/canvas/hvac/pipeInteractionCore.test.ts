import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import {
  applyPipeCommand,
  classifyHardDirection,
  deleteVertex,
  insertVertex,
  lockToHardAngle,
  moveHardSegment,
  moveVertex,
  reducePipeTool,
  resolveSnap,
  type PipeSegmentMaterial,
  type PipeToolState,
  type SceneQuery,
  type SnapCandidate,
} from './pipeInteractionCore';

const p = (x: number, y: number): Point2D => ({ x, y });

describe('classifyHardDirection', () => {
  it('classifies axes and diagonals, rejects off-angle/short', () => {
    expect(classifyHardDirection(p(0, 0), p(100, 0))).toBe('E');
    expect(classifyHardDirection(p(0, 0), p(0, 100))).toBe('S');
    expect(classifyHardDirection(p(0, 0), p(0, -100))).toBe('N');
    expect(classifyHardDirection(p(0, 0), p(100, 100))).toBe('SE');
    expect(classifyHardDirection(p(0, 0), p(100, -100))).toBe('NE');
    expect(classifyHardDirection(p(0, 0), p(100, 40))).toBeNull(); // off-angle
    expect(classifyHardDirection(p(0, 0), p(0.2, 0.2))).toBeNull(); // too short
  });
});

describe('lockToHardAngle', () => {
  it('locks to the nearest 45-degree ray and projects along it', () => {
    const diag = lockToHardAngle(p(0, 0), p(100, -100));
    expect(diag.direction).toBe('NE');
    expect(diag.point.x).toBeCloseTo(100, 6);
    expect(diag.point.y).toBeCloseTo(-100, 6);

    const axis = lockToHardAngle(p(0, 0), p(100, -8));
    expect(axis.direction).toBe('E');
    expect(axis.point.x).toBeCloseTo(100, 6);
    expect(axis.point.y).toBeCloseTo(0, 6); // projected onto the E axis
  });
});

describe('resolveSnap', () => {
  const sceneWith = (candidates: SnapCandidate[]): SceneQuery => ({
    snapCandidates: () => candidates,
  });

  it('prefers a higher-priority candidate over a closer one', () => {
    const scene = sceneWith([
      { point: p(0.5, 0), kind: 'endpoint' },
      { point: p(1, 1), kind: 'port' },
    ]);
    const snap = resolveSnap(p(0, 0), scene, { toleranceMm: 5, gridSizeMm: 10, snapToGrid: true });
    expect(snap.kind).toBe('port'); // port priority beats the nearer endpoint
  });

  it('falls back to grid then to none', () => {
    const grid = resolveSnap(p(12, 7), null, { toleranceMm: 5, gridSizeMm: 10, snapToGrid: true });
    expect(grid.kind).toBe('grid');
    expect(grid.point).toEqual(p(10, 10));

    const none = resolveSnap(p(12, 7), null, { toleranceMm: 5, gridSizeMm: 10, snapToGrid: false });
    expect(none.kind).toBe('none');
    expect(none.point).toEqual(p(12, 7));
  });

  it('ignores candidates outside tolerance', () => {
    const scene = sceneWith([{ point: p(100, 100), kind: 'port' }]);
    const snap = resolveSnap(p(0, 0), scene, { toleranceMm: 5, gridSizeMm: 10, snapToGrid: false });
    expect(snap.kind).toBe('none');
  });
});

describe('vertex edit ops preserve material identity', () => {
  const route = [p(0, 0), p(100, 0), p(100, 100), p(200, 100)];
  const materials: PipeSegmentMaterial[] = ['hard', 'flexible', 'hard'];

  it('moveVertex moves only the target', () => {
    const next = moveVertex(route, 1, p(120, 10));
    expect(next[1]).toEqual(p(120, 10));
    expect(next[0]).toEqual(p(0, 0));
    expect(next[2]).toEqual(p(100, 100));
  });

  it('insert then delete is identity (route + materials)', () => {
    const inserted = insertVertex(route, materials, 1, p(100, 50));
    expect(inserted.route).toHaveLength(5);
    expect(inserted.materials).toEqual(['hard', 'flexible', 'flexible', 'hard']);

    const restored = deleteVertex(inserted.route, inserted.materials, 2);
    expect(restored.route).toEqual(route);
    expect(restored.materials).toEqual(materials);
  });

  it('deleteVertex refuses to drop below 2 points', () => {
    const twoPt = [p(0, 0), p(10, 0)];
    const res = deleteVertex(twoPt, ['hard'], 0);
    expect(res.route).toEqual(twoPt);
  });
});

describe('moveHardSegment — parallel-offset solver', () => {
  // U shape: the top segment (index 1) is horizontal between two vertical legs.
  const route = [p(0, 0), p(0, 100), p(200, 100), p(200, 0)];
  const materials: PipeSegmentMaterial[] = ['hard', 'hard', 'hard'];

  it('offsets the segment and re-intersects the legs', () => {
    const res = moveHardSegment({
      routePoints: route,
      segmentMaterials: materials,
      startIndex: 1,
      endIndex: 2,
      offsetDistanceMm: 50,
      lockStart: false,
      lockEnd: false,
    });
    expect(res).not.toBeNull();
    expect(res!.mainDirection).toBe('E');
    expect(res!.routePoints[1]).toEqual(p(0, 150));
    expect(res!.routePoints[2]).toEqual(p(200, 150));
    expect(res!.routePoints[0]).toEqual(p(0, 0)); // leg foot fixed
    expect(res!.routePoints[3]).toEqual(p(200, 0));
  });

  it('returns null when a locked endpoint segment would move', () => {
    // collinear horizontal run; moving segment 1 drags parallel segment 0 (the
    // locked start segment) -> rejected.
    const line = [p(0, 0), p(100, 0), p(200, 0)];
    const res = moveHardSegment({
      routePoints: line,
      segmentMaterials: ['hard', 'hard'],
      startIndex: 1,
      endIndex: 2,
      offsetDistanceMm: 30,
      lockStart: true,
      lockEnd: false,
    });
    expect(res).toBeNull();
  });
});

describe('reducePipeTool — state machine is pure', () => {
  it('drives the draw lifecycle', () => {
    let s: PipeToolState = { kind: 'idle' };
    s = reducePipeTool(s, { type: 'startDraw' });
    expect(s).toEqual({ kind: 'drawing', points: [], cursor: null });
    s = reducePipeTool(s, { type: 'addPoint', point: p(0, 0) });
    s = reducePipeTool(s, { type: 'moveCursor', point: p(50, 0) });
    expect(s).toMatchObject({ kind: 'drawing', points: [p(0, 0)], cursor: p(50, 0) });
    s = reducePipeTool(s, { type: 'commitDraw' });
    expect(s).toEqual({ kind: 'idle' });
  });

  it('drives select -> grab -> release', () => {
    let s: PipeToolState = reducePipeTool({ kind: 'idle' }, { type: 'select', elementId: 'pipe-1' });
    expect(s).toEqual({ kind: 'selected', elementId: 'pipe-1' });
    s = reducePipeTool(s, { type: 'grabVertex', elementId: 'pipe-1', index: 2 });
    expect(s).toEqual({ kind: 'draggingVertex', elementId: 'pipe-1', index: 2 });
    s = reducePipeTool(s, { type: 'release' });
    expect(s).toEqual({ kind: 'selected', elementId: 'pipe-1' });
  });

  it('ignores irrelevant events', () => {
    const s: PipeToolState = { kind: 'idle' };
    expect(reducePipeTool(s, { type: 'addPoint', point: p(0, 0) })).toBe(s);
  });
});

describe('applyPipeCommand', () => {
  const geom = {
    route: [p(0, 0), p(100, 0), p(100, 100), p(200, 100)],
    materials: ['hard', 'flexible', 'hard'] as PipeSegmentMaterial[],
  };

  it('MoveVertex / InsertVertex+DeleteVertex round-trip', () => {
    const moved = applyPipeCommand(geom, { type: 'MoveVertex', elementId: 'x', index: 1, to: p(120, 0) });
    expect(moved!.route[1]).toEqual(p(120, 0));

    const inserted = applyPipeCommand(geom, { type: 'InsertVertex', elementId: 'x', afterIndex: 1, at: p(100, 50) });
    const restored = applyPipeCommand(inserted!, { type: 'DeleteVertex', elementId: 'x', index: 2 });
    expect(restored!.route).toEqual(geom.route);
    expect(restored!.materials).toEqual(geom.materials);
  });

  it('AddPipe / ReconnectEndpoint are not geometry-only (null)', () => {
    expect(applyPipeCommand(geom, { type: 'AddPipe', route: geom.route, materials: geom.materials })).toBeNull();
    expect(
      applyPipeCommand(geom, {
        type: 'ReconnectEndpoint',
        elementId: 'x',
        end: 'start',
        target: { point: p(0, 0), kind: 'port' },
      }),
    ).toBeNull();
  });
});
