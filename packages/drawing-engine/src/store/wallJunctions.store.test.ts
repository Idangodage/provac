/**
 * Walls through the real store: every route in, every view of the result. These
 * are the failures the junction work set out to end, written as the user meets them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { computeWallUnionRenderData } from '../components/canvas/wall/WallUnionGeometry';

import { useDrawingStore } from './index';

const store = () => useDrawingStore.getState();
const pt = (x: number, y: number) => ({ x, y });

beforeEach(() => {
  useDrawingStore.setState({ walls: [], rooms: [] });
});

const settle = (expected: number) =>
  vi.waitFor(() => expect(store().rooms).toHaveLength(expected), { timeout: 3000, interval: 10 });

const boxOf = (minX: number, minY: number, maxX: number, maxY: number): [number, number][] => [
  [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
];

describe('rooms read the walls as they are drawn', () => {
  it('a wall teeing across a room makes two rooms, and they stay', async () => {
    store().wallGraphAddChain(boxOf(0, 0, 6000, 4000).map(([x, y]) => pt(x, y)), { thickness: 200 });
    await settle(1);
    store().wallGraphAddChain([pt(3000, 0), pt(3000, 4000)], { thickness: 200 });
    await settle(2);
    const areas = store().rooms.map((room) => room.area).sort((a, b) => a - b);
    // Between faces: 2800 wide (3000 less 100 + 100) and 3800 high, each side of the 200 mm wall.
    expect(areas[0]).toBeCloseTo(2800 * 3800, -2);
    expect(areas[1]).toBeCloseTo(2800 * 3800, -2);
  });

  it('a room keeps its identity when another wall tees onto its outside', async () => {
    store().wallGraphAddChain(boxOf(0, 0, 6000, 4000).map(([x, y]) => pt(x, y)), { thickness: 200 });
    await settle(1);
    const id = store().rooms[0]!.id;
    const area = store().rooms[0]!.area;
    store().wallGraphAddChain([pt(6000, 2000), pt(9000, 2000)], { thickness: 200 });
    await vi.waitFor(() => expect(store().rooms[0]!.wallIds.length).toBeGreaterThanOrEqual(4));
    expect(store().rooms).toHaveLength(1);
    expect(store().rooms[0]!.id).toBe(id);
    expect(store().rooms[0]!.area).toBeCloseTo(area, -2);
  });

  it('angled walls still claim the rooms they bound', async () => {
    store().wallGraphAddChain([pt(0, 0), pt(5000, 700), pt(5300, 4100), pt(-200, 3700), pt(0, 0)], { thickness: 200 });
    await settle(1);
    expect(store().rooms[0]!.wallIds).toHaveLength(4);
  });
});

describe('the stored walls never carry solved corners', () => {
  it('face lines stay square after a tee, so nothing downstream sees them flip', () => {
    store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    store().wallGraphAddChain([pt(3000, 0), pt(3000, 3000)], { thickness: 200 });
    for (const wall of store().walls) {
      const dx = wall.endPoint.x - wall.startPoint.x;
      const dy = wall.endPoint.y - wall.startPoint.y;
      const length = Math.hypot(dx, dy);
      const nx = -dy / length;
      const ny = dx / length;
      expect(wall.interiorLine.start.x).toBeCloseTo(wall.startPoint.x + nx * 100, 6);
      expect(wall.interiorLine.start.y).toBeCloseTo(wall.startPoint.y + ny * 100, 6);
      expect(wall.exteriorLine.end.x).toBeCloseTo(wall.endPoint.x - nx * 100, 6);
      expect(wall.exteriorLine.end.y).toBeCloseTo(wall.endPoint.y - ny * 100, 6);
    }
    expect(computeWallUnionRenderData(store().walls).components).toHaveLength(1);
  });
});
