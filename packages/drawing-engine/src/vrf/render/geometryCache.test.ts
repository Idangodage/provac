import { describe, it, expect } from 'vitest';
import { produce } from 'immer';

import { makeRunGeometryCache, makeKitBodyCache } from './geometryCache';
import { moveKit, connectRunEnd } from '../model/ops';
import { createRefnetKit } from '../geometry/kit';
import { emptyDoc, PIPE_SIZES, type BoardDoc } from '../model/types';

const size = PIPE_SIZES[1]!;
const GAP = 30;

function bigDoc(nRuns: number): BoardDoc {
  return produce(emptyDoc(), (d) => {
    d.kits['k'] = createRefnetKit('k', { pos: { x: 0, y: 0 }, rotation: 0, mirror: false }, GAP);
    for (let i = 0; i < nRuns; i += 1) {
      const y = 200 + i * 40;
      d.runs[`r${i}`] = { id: `r${i}`, spine: [{ x: -600, y }, { x: -200, y }, { x: -200, y: y + 300 }], lineType: 'paired', size, bendRadiusMm: 200 };
    }
    // connect three runs' ends into the kit so a kit move perturbs only those
    d.runs['main'] = { id: 'main', spine: [{ x: -500, y: 0 }, { x: -100, y: 0 }], lineType: 'paired', size, bendRadiusMm: 200 };
    d.runs['down'] = { id: 'down', spine: [{ x: 20, y: 400 }, { x: 20, y: 95 }], lineType: 'paired', size, bendRadiusMm: 200 };
    connectRunEnd(d, 'main', 'end', 'k', 'in');
    connectRunEnd(d, 'down', 'end', 'k', 'out_branch');
  });
}

describe('run geometry cache', () => {
  it('returns the SAME geometry object for an unchanged run + gap', () => {
    const cache = makeRunGeometryCache();
    const doc = bigDoc(5);
    const run = doc.runs['r0']!;
    const a = cache.get(run, GAP);
    const b = cache.get(run, GAP);
    expect(a).toBe(b);
  });

  it('recomputes when the run reference or the gap changes', () => {
    const cache = makeRunGeometryCache();
    const doc = bigDoc(5);
    const a = cache.get(doc.runs['r0']!, GAP);
    const moved = produce(doc, (d) => { d.runs['r0']!.spine[0]!.x -= 10; });
    expect(cache.get(moved.runs['r0']!, GAP)).not.toBe(a); // new reference -> recompute
    expect(cache.get(doc.runs['r1']!, GAP)).not.toBe(cache.get(doc.runs['r1']!, GAP + 1)); // gap change -> recompute
  });

  it('after a kit move, only the connected runs get fresh geometry; the rest are cached', () => {
    const cache = makeRunGeometryCache();
    const doc = bigDoc(20);
    for (const r of Object.values(doc.runs)) cache.get(r, GAP); // warm
    const moved = produce(doc, (d) => moveKit(d, 'k', { pos: { x: 120, y: -60 }, rotation: 0.4, mirror: false }));

    // Untouched runs keep identity (Immer structural sharing) -> cache hit (same object).
    expect(cache.get(moved.runs['r7']!, GAP)).toBe(cache.get(doc.runs['r7']!, GAP));
    // Connected runs changed reference -> recompute (new geometry object).
    const before = cache.get(doc.runs['main']!, GAP);
    expect(cache.get(moved.runs['main']!, GAP)).not.toBe(before);
  });

  it('prune drops stale ids', () => {
    const cache = makeRunGeometryCache();
    const doc = bigDoc(3);
    for (const r of Object.values(doc.runs)) cache.get(r, GAP);
    const run = doc.runs['r0']!;
    const g0 = cache.get(run, GAP);
    cache.prune(new Set(['r1'])); // r0 removed from cache
    // a fresh get recomputes (new object) because the entry was pruned
    expect(cache.get(run, GAP)).not.toBe(g0);
  });
});

describe('kit body cache', () => {
  it('memoizes local body geometry by gap', () => {
    const cache = makeKitBodyCache();
    const a = cache.get(GAP);
    expect(cache.get(GAP)).toBe(a);
    expect(cache.get(GAP + 5)).not.toBe(a);
  });
});

describe('drag-frame compute budget (≤ 8 ms)', () => {
  it('a kit-drag frame over a 40-run board rebuilds only changed geometry, well under budget', () => {
    const doc0 = bigDoc(40);
    const runCache = makeRunGeometryCache();
    const kitCache = makeKitBodyCache();
    // warm caches (mimics steady state before the drag begins)
    kitCache.get(GAP);
    for (const r of Object.values(doc0.runs)) runCache.get(r, GAP);

    const frame = (doc: BoardDoc, dx: number): BoardDoc => {
      const next = produce(doc, (d) => moveKit(d, 'k', { pos: { x: dx, y: 0 }, rotation: 0, mirror: false }));
      kitCache.get(GAP); // cached
      for (const r of Object.values(next.runs)) runCache.get(r, GAP); // only changed ones rebuild
      return next;
    };

    let doc = doc0;
    for (let i = 0; i < 10; i += 1) doc = frame(doc, i); // warmup

    const times: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const s = performance.now();
      doc = frame(doc, 10 + i);
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    expect(median).toBeLessThan(8);
  });
});
