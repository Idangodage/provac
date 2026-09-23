import { describe, expect, it } from 'vitest';

import { selectPipeHandleCandidates } from './pipeHandleLayout';

describe('projected pipe control spacing', () => {
  it('keeps one endpoint marker where a vertical riser collapses in plan', () => {
    const controls = [
      { key: 'start', x: 100, y: 100, priority: 2 },
      { key: 'riser-top', x: 100, y: 100, priority: 1 },
      { key: 'bend', x: 106, y: 104, priority: 1 },
      { key: 'end', x: 400, y: 100, priority: 2 },
    ];
    expect(selectPipeHandleCandidates(controls).map(point => point.key)).toEqual(['start', 'end']);
    expect(selectPipeHandleCandidates(controls, 'riser-top').map(point => point.key)).toEqual(['riser-top', 'end']);
  });

  it('retains a selected point in a cluster and reveals separate controls when zooming in', () => {
    const controls = Array.from({ length: 40 }, (_, index) => ({ key: String(index), x: index, y: 0, priority: 1 }));
    const before = structuredClone(controls);
    const visible = selectPipeHandleCandidates(controls, '12');
    expect(visible.map(point => point.key)).toContain('12');
    for (const point of visible) for (const other of visible) {
      if (point !== other) expect(Math.hypot(point.x - other.x, point.y - other.y)).toBeGreaterThanOrEqual(20);
    }
    expect(selectPipeHandleCandidates(controls.map(point => ({ ...point, x: point.x * 24 })))).toHaveLength(40);
    expect(controls).toEqual(before);
  });

  it('uses screen coordinates and catches nearby handles across negative grid boundaries', () => {
    const controls = [
      { key: 'joint', x: -1, y: -1, priority: 1 },
      { key: 'segment', x: 1, y: 1, priority: 0 },
      { key: 'invalid', x: NaN, y: 0, priority: 3 },
    ];
    expect(selectPipeHandleCandidates(controls).map(point => point.key)).toEqual(['joint']);
    expect(selectPipeHandleCandidates(controls, 'segment').map(point => point.key)).toEqual(['segment']);
  });
});
