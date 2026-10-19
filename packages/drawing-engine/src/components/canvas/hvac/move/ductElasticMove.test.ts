import { describe, expect, it } from 'vitest';

import { pinVertex, solveElasticRun, type Vec3 } from './ductElasticMove';

const p = (x: number, y: number, z = 2700) => ({ x, y, z });
const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });
const xy = (points: ReadonlyArray<{ x: number; y: number }>) => points.map((point) => [point.x, point.y]);

describe('solveElasticRun', () => {
  // Collar at the origin, a straight along +x to an elbow, then along +y to a split.
  const lShape = [p(0, 0), p(2000, 0), p(2000, 3000)];

  it('takes a start moved across the first leg up in the leg that runs that way', () => {
    const result = solveElasticRun({ path: lShape, constraints: pinVertex(0, v(0, 300)) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The first straight slides across with the collar; the leg after it shortens; the split stays.
    expect(xy(result.path)).toEqual([[0, 300], [2000, 300], [2000, 3000]]);
  });

  it('shortens the first leg when the start moves along it', () => {
    const result = solveElasticRun({ path: lShape, constraints: pinVertex(0, v(300, 0)) });
    expect(result.ok && xy(result.path)).toEqual([[300, 0], [2000, 0], [2000, 3000]]);
  });

  it('keeps a pinned end exactly where it is', () => {
    const result = solveElasticRun({ path: lShape, constraints: [...pinVertex(0, v(0, 300)), ...pinVertex(2, v(0, 0))] });
    expect(result.ok && xy(result.path)).toEqual([[0, 300], [2000, 300], [2000, 3000]]);
  });

  it('pushes the rest of the run when a leg reaches its shortest, and refuses when its end is pinned', () => {
    // The start moves 3500 up the second leg: that leg (3000 long) stops at 50 mm, the split is pushed 550.
    const pushed = solveElasticRun({ path: lShape, constraints: pinVertex(0, v(0, 3500)) });
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(xy(pushed.path)).toEqual([[0, 3500], [2000, 3500], [2000, 3550]]);
    expect(pushed.shortest).toEqual([1]);
    const pinned = solveElasticRun({ path: lShape, constraints: [...pinVertex(0, v(0, 3500)), ...pinVertex(2, v(0, 0))] });
    expect(pinned.ok).toBe(false);
  });

  it('lets a flexible runout bend to its terminal', () => {
    const run = [p(0, 0), p(2000, 0), p(2600, 900)];
    const result = solveElasticRun({
      path: run, legs: [undefined, { flex: true }],
      constraints: [...pinVertex(0, v(100, 200)), ...pinVertex(2, v(0, 0))],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The rigid straight shortens by the along-component and slides across; the flex takes the rest.
    expect(xy(result.path)).toEqual([[100, 200], [2000, 200], [2600, 900]]);
  });

  it('moves a dragged trunk toward the drag while the straight to its fixed collar stretches', () => {
    // Collar → 500 along +y → trunk 4000 along +x, end free; the run is dragged.
    const run = [p(0, 0), p(0, 500), p(4000, 500)];
    const across = solveElasticRun({ path: run, constraints: pinVertex(0, v(0, 0)), desire: v(0, 200) });
    expect(across.ok && xy(across.path)).toEqual([[0, 0], [0, 700], [4000, 700]]);
    // Along the trunk it cannot slide (the collar's straight is square to it): its far end extends.
    const along = solveElasticRun({ path: run, constraints: pinVertex(0, v(0, 0)), desire: v(300, 0) });
    expect(along.ok && xy(along.path)).toEqual([[0, 0], [0, 500], [4300, 500]]);
  });

  it('translates exactly when everything it is fixed to moves with it', () => {
    const run = [p(0, 0), p(1000, 0), p(1000, 800), p(2500, 800)];
    const d = v(150, -320, 40);
    const result = solveElasticRun({
      path: run, legs: [undefined, undefined, { flex: true }],
      constraints: [...pinVertex(0, d), ...pinVertex(3, d)], desire: d,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.shifts.forEach((shift) => {
      expect(shift.x).toBeCloseTo(150, 6);
      expect(shift.y).toBeCloseTo(-320, 6);
      expect(shift.z).toBeCloseTo(40, 6);
    });
  });

  it('holds a slide at its limit', () => {
    // A take-off may slide along +x only within ±100 of where it is; the run would like 300.
    const run = [p(0, 0), p(0, 1500)];
    const result = solveElasticRun({
      path: run,
      constraints: [{ vertex: 0, axis: v(0, 1), value: 0 }, { vertex: 0, axis: v(0, 0, 1), value: 0 }],
      bounds: [{ vertex: 0, axis: v(1, 0), min: -100, max: 100 }],
      desire: v(300, 0),
    });
    expect(result.ok && xy(result.path)).toEqual([[100, 0], [100, 1500]]);
  });

  it('grows a riser made at zero length in its own direction only', () => {
    // A straight (vertex 2 → 3) lifted 200 between a riser made before it and a drop made after it.
    const run = [p(0, 0), p(1000, 0), p(1000, 0), p(1000, 2000), p(1000, 2000), p(3000, 2000)];
    const lifted = solveElasticRun({
      path: run,
      legs: [undefined, { direction: v(0, 0, 1) }, undefined, { direction: v(0, 0, -1) }, undefined],
      constraints: [
        ...pinVertex(0, v(0, 0)), ...pinVertex(5, v(0, 0)),
        { vertex: 2, axis: v(0, 0, 1), value: 200 }, { vertex: 3, axis: v(0, 0, 1), value: 200 },
      ],
    });
    expect(lifted.ok).toBe(true);
    if (!lifted.ok) return;
    expect(lifted.path.map((point) => point.z)).toEqual([2700, 2700, 2900, 2900, 2700, 2700]);
    // Lowered instead: a riser made upward cannot grow downward.
    const lowered = solveElasticRun({
      path: run,
      legs: [undefined, { direction: v(0, 0, 1) }, undefined, { direction: v(0, 0, -1) }, undefined],
      constraints: [
        ...pinVertex(0, v(0, 0)), ...pinVertex(5, v(0, 0)),
        { vertex: 2, axis: v(0, 0, 1), value: -200 }, { vertex: 3, axis: v(0, 0, 1), value: -200 },
      ],
    });
    expect(lowered.ok).toBe(false);
  });

  it('reports a run whose fixed points its legs cannot all meet', () => {
    // One straight, both ends fixed, its start moved square to it.
    const result = solveElasticRun({ path: [p(0, 0), p(2000, 0)], constraints: [...pinVertex(0, v(0, 100)), ...pinVertex(1, v(0, 0))] });
    expect(result).toEqual({ ok: false, reason: 'fixed' });
  });

  it('keeps level legs level and vertical legs vertical', () => {
    const run = [p(0, 0), p(1500, 0), p(1500, 0, 3100), p(1500, 1200, 3100)];
    const result = solveElasticRun({ path: run, constraints: pinVertex(0, v(0, 0, -60)), desire: v(0, 0, 0) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [a, b, c, d] = result.path;
    expect(a!.z).toBe(b!.z);
    expect([b!.x, b!.y]).toEqual([c!.x, c!.y]);
    expect(c!.z).toBe(d!.z);
    // The riser takes the drop: the level above stays.
    expect(c!.z).toBe(3100);
  });
});
