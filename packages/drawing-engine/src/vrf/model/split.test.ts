import { describe, it, expect } from 'vitest';
import { produce, produceWithPatches, applyPatches, enablePatches } from 'immer';

import { insertBranchAt, connectRunEnd } from './ops';
import { emptyDoc, PIPE_SIZES, type BoardDoc } from './types';
import { createRefnetKit, portPairCenterWorld, portPairDirWorld, snapKitToRunEnd } from '../geometry/kit';
import { buildRunGeometry } from '../geometry/offset';
import { norm, sub } from '../geometry/path';

enablePatches();

const size = PIPE_SIZES[1]!;
const GAP = 30;

function seedRun(): BoardDoc {
  return produce(emptyDoc(), (d) => {
    d.runs['main'] = { id: 'main', spine: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }], lineType: 'paired', size, bendRadiusMm: 200 };
  });
}

describe('insertBranchAt — atomic split-insert-reroute', () => {
  it('splits mid-segment into upstream + downstream + kit + stub with deterministic ids', () => {
    let next = -1;
    const doc = produce(seedRun(), (d) => {
      next = insertBranchAt(d, 'main', { segIndex: 0, t: 0.5 }, 0, GAP);
    });
    expect(next).toBe(3);
    expect(Object.keys(doc.kits)).toEqual(['kit_0']);
    // upstream keeps 'main'; downstream run_1; stub run_2
    expect(doc.runs['main']!.spine[doc.runs['main']!.spine.length - 1]).toEqual({ x: 200, y: 0 });
    expect(doc.runs['run_1']).toBeTruthy();
    expect(doc.runs['run_2']).toBeTruthy();
    // downstream carries the rest of the original spine tail (starts at the kit main outlet)
    expect(doc.runs['run_1']!.spine[doc.runs['run_1']!.spine.length - 1]).toEqual({ x: 400, y: 400 });
    // stub has two distinct, renderable points
    const stub = doc.runs['run_2']!;
    expect(stub.spine.length).toBe(2);
    expect(stub.spine[0]).not.toEqual(stub.spine[1]);
  });

  it('orients the kit along the run: inlet at c, out_main downstream, inlet faces upstream', () => {
    const doc = produce(seedRun(), (d) => { insertBranchAt(d, 'main', { segIndex: 0, t: 0.5 }, 0, GAP); });
    const kit = doc.kits['kit_0']!;
    const tng = norm(sub({ x: 400, y: 0 }, { x: 0, y: 0 })); // (1,0)
    expect(kit.transform).toEqual(snapKitToRunEnd({ x: 200, y: 0 }, tng));
    const inCentre = portPairCenterWorld(kit, 'in')!;
    expect(Math.hypot(inCentre.x - 200, inCentre.y - 0)).toBeLessThan(1e-9);
    // out_main sits downstream of c along +tng; inlet outward points upstream (−tng)
    const outMain = portPairCenterWorld(kit, 'out_main')!;
    expect(outMain.x).toBeGreaterThan(200);
    const inDir = portPairDirWorld(kit, 'in')!;
    expect(inDir.x).toBeCloseTo(-1, 9);
  });

  it('creates 6 connections and partitions pre-existing ones by end', () => {
    // main.start bound to kitA.in, main.end bound to kitB.out_branch
    const base = produce(seedRun(), (d) => {
      d.kits['kA'] = createRefnetKit('kA', { pos: { x: -300, y: 0 }, rotation: 0, mirror: false }, GAP);
      d.kits['kB'] = createRefnetKit('kB', { pos: { x: 700, y: 500 }, rotation: 0, mirror: false }, GAP);
      connectRunEnd(d, 'main', 'start', 'kA', 'out_main');
      connectRunEnd(d, 'main', 'end', 'kB', 'in');
    });
    const before = base.connections.length; // 4 (2 kits × gas+liquid)
    const doc = produce(base, (d) => { insertBranchAt(d, 'main', { segIndex: 0, t: 0.5 }, 10, GAP); });
    // +6 new (in, out_main, out_branch each gas+liquid)
    expect(doc.connections.length).toBe(before + 6);
    // start-side stayed on 'main'
    expect(doc.connections.some((c) => c.pipeId === 'main' && c.pipeEnd === 'start' && c.kitId === 'kA')).toBe(true);
    // pre-existing end-side link moved to the downstream run 'run_11'
    expect(doc.connections.some((c) => c.pipeId === 'run_11' && c.pipeEnd === 'end' && c.kitId === 'kB')).toBe(true);
    expect(doc.connections.some((c) => c.pipeId === 'main' && c.pipeEnd === 'end' && c.kitId === 'kB')).toBe(false);
    // upstream 'main' end is now bound to the NEW kit inlet
    expect(doc.connections.some((c) => c.pipeId === 'main' && c.pipeEnd === 'end' && c.kitId === 'kit_10')).toBe(true);
  });

  it('the stub run is renderable (no NaN geometry)', () => {
    const doc = produce(seedRun(), (d) => { insertBranchAt(d, 'main', { segIndex: 1, t: 0.4 }, 0, GAP); });
    const geom = buildRunGeometry(doc.runs['run_2']!, GAP);
    const flat = [...geom.gas, ...geom.liquid].flatMap((s) =>
      s.kind === 'line' ? [s.a.x, s.a.y, s.b.x, s.b.y] : [s.center.x, s.center.y, s.radius],
    );
    expect(flat.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('INSERT then UNDO restores byte-identical state (one atomic commit)', () => {
    const before = seedRun();
    const [after, patches, inverse] = produceWithPatches(before, (d) => {
      insertBranchAt(d, 'main', { segIndex: 0, t: 0.5 }, 0, GAP);
    });
    expect(patches.length).toBeGreaterThan(0);
    expect(Object.keys(after.kits)).toEqual(['kit_0']);
    const undone = applyPatches(after, inverse);
    expect(undone).toEqual(before); // deep-equal: runs back to {main}, kits {}, connections []
    const redone = applyPatches(undone, patches);
    expect(redone).toEqual(after);
  });

  it('rejects a non-paired run and a bound-tip split without mutating', () => {
    // non-paired
    const gasRun = produce(emptyDoc(), (d) => {
      d.runs['g'] = { id: 'g', spine: [{ x: 0, y: 0 }, { x: 100, y: 0 }], lineType: 'gas', size, bendRadiusMm: 200 };
    });
    const r1 = produce(gasRun, (d) => {
      const n = insertBranchAt(d, 'g', { segIndex: 0, t: 0.5 }, 0, GAP);
      expect(n).toBe(0);
    });
    expect(r1).toEqual(gasRun);

    // bound tip: main.start connected, split at (0, t=0)
    const bound = produce(seedRun(), (d) => {
      d.kits['k'] = createRefnetKit('k', { pos: { x: -300, y: 0 }, rotation: 0, mirror: false }, GAP);
      connectRunEnd(d, 'main', 'start', 'k', 'out_main');
    });
    const r2 = produce(bound, (d) => {
      const n = insertBranchAt(d, 'main', { segIndex: 0, t: 0 }, 5, GAP);
      expect(n).toBe(5);
    });
    expect(r2).toEqual(bound);
  });

  it('allocates non-colliding ids across successive inserts', () => {
    let next = 0;
    let doc = seedRun();
    doc = produce(doc, (d) => { next = insertBranchAt(d, 'main', { segIndex: 0, t: 0.3 }, next, GAP); });
    expect(next).toBe(3);
    doc = produce(doc, (d) => { next = insertBranchAt(d, 'run_1', { segIndex: 0, t: 0.5 }, next, GAP); });
    expect(next).toBe(6);
    expect(doc.kits['kit_0']).toBeTruthy();
    expect(doc.kits['kit_3']).toBeTruthy();
    expect(Object.keys(doc.kits).length).toBe(2);
  });
});
