import { describe, it, expect } from 'vitest';
import { produce } from 'immer';

import { connectRunEnd, moveKit } from './ops';
import { emptyDoc, PIPE_SIZES, type BoardDoc } from './types';
import { canConnect, createRefnetKit, portPairCenterWorld } from '../geometry/kit';

const size = PIPE_SIZES[1]!;
const GAP = 30;

function seed(): BoardDoc {
  return produce(emptyDoc(), (d) => {
    d.kits['k'] = createRefnetKit('k', { pos: { x: 0, y: 0 }, rotation: 0, mirror: false }, GAP);
    d.runs['main'] = { id: 'main', spine: [{ x: -500, y: 0 }, { x: -100, y: 0 }], lineType: 'paired', size, bendRadiusMm: 120 };
    d.runs['down'] = { id: 'down', spine: [{ x: 20, y: 400 }, { x: 20, y: 95 }], lineType: 'paired', size, bendRadiusMm: 120 };
    connectRunEnd(d, 'main', 'end', 'k', 'in');
    connectRunEnd(d, 'down', 'end', 'k', 'out_branch');
  });
}

describe('invariant F — kit move drags every connected endpoint, drops none', () => {
  it('connect creates gas+liquid links and pins endpoints to the port pair centres', () => {
    const doc = seed();
    expect(doc.connections.length).toBe(4); // 2 runs × (gas + liquid)
    const mainEnd = doc.runs['main']!.spine[doc.runs['main']!.spine.length - 1]!;
    expect(mainEnd).toEqual(portPairCenterWorld(doc.kits['k']!, 'in'));
    const downEnd = doc.runs['down']!.spine[doc.runs['down']!.spine.length - 1]!;
    expect(downEnd).toEqual(portPairCenterWorld(doc.kits['k']!, 'out_branch'));
  });

  it('translate + rotate the kit: all endpoints follow exactly; zero dropped', () => {
    const doc = seed();
    const before = doc.connections.length;
    const moved = produce(doc, (d) => {
      moveKit(d, 'k', { pos: { x: 350, y: -220 }, rotation: 0.7, mirror: false });
    });
    // no connection removed
    expect(moved.connections.length).toBe(before);
    // every connected endpoint sits exactly on its port-pair centre
    const mainEnd = moved.runs['main']!.spine[moved.runs['main']!.spine.length - 1]!;
    const inCenter = portPairCenterWorld(moved.kits['k']!, 'in')!;
    expect(Math.hypot(mainEnd.x - inCenter.x, mainEnd.y - inCenter.y)).toBeLessThan(1e-9);
    const downEnd = moved.runs['down']!.spine[moved.runs['down']!.spine.length - 1]!;
    const brCenter = portPairCenterWorld(moved.kits['k']!, 'out_branch')!;
    expect(Math.hypot(downEnd.x - brCenter.x, downEnd.y - brCenter.y)).toBeLessThan(1e-9);
  });

  it('a chain of moves keeps every endpoint pinned', () => {
    let doc = seed();
    for (const tf of [
      { pos: { x: 100, y: 100 }, rotation: 0.3, mirror: false },
      { pos: { x: -80, y: 250 }, rotation: -1.1, mirror: true },
      { pos: { x: 500, y: -50 }, rotation: 2.4, mirror: false },
    ]) {
      doc = produce(doc, (d) => moveKit(d, 'k', tf));
      for (const [runId, role] of [['main', 'in'], ['down', 'out_branch']] as const) {
        const run = doc.runs[runId]!;
        const end = run.spine[run.spine.length - 1]!;
        const c = portPairCenterWorld(doc.kits['k']!, role)!;
        expect(Math.hypot(end.x - c.x, end.y - c.y)).toBeLessThan(1e-9);
      }
      expect(doc.connections.length).toBe(4);
    }
  });

  it('only gas↔gas and liquid↔liquid connect', () => {
    expect(canConnect('gas', 'gas')).toBe(true);
    expect(canConnect('liquid', 'liquid')).toBe(true);
    expect(canConnect('gas', 'liquid')).toBe(false);
    expect(canConnect('liquid', 'gas')).toBe(false);
  });
});
