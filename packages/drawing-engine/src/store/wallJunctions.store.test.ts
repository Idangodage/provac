/**
 * Walls through the real store: every route in, every view of the result. These
 * are the failures the junction work set out to end, written as the user meets them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { snapWallPoint } from '../components/canvas/wall/WallSnapping';
import { computeWallUnionRenderData } from '../components/canvas/wall/WallUnionGeometry';
import { DEFAULT_DIMENSION_SETTINGS } from '../types';

import { buildMergedAutoManagedDimensions } from './autoManagedDimensions';

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

describe('auto dimensions on plain rooms did not move', () => {
  // The values are what the code before the junction work gave for these plans once a
  // render and a fresh room detection had happened. A tee no longer has to wait for those.
  const autoDimensions = () =>
    buildMergedAutoManagedDimensions({
      walls: store().walls,
      rooms: store().rooms,
      dimensionSettings: { ...DEFAULT_DIMENSION_SETTINGS },
      dimensions: [],
    });
  const box = (minX: number, minY: number, maxX: number, maxY: number) =>
    boxOf(minX, minY, maxX, maxY).map(([x, y]) => pt(x, y));

  const plans: [string, { points: { x: number; y: number }[]; thickness: number }[], number, number[]][] = [
    ['one room', [{ points: box(0, 0, 6000, 4000), thickness: 200 }], 1, [3800, 3800, 5800, 5800]],
    [
      'two rooms',
      [
        { points: box(0, 0, 6000, 4000), thickness: 200 },
        { points: [pt(3000, 0), pt(3000, 4000)], thickness: 200 },
      ],
      2,
      [2900, 2900, 2900, 2900, 3800, 3800],
    ],
    [
      'a thin partition in thick walls',
      [
        { points: box(0, 0, 8000, 5000), thickness: 300 },
        { points: [pt(5000, 0), pt(5000, 5000)], thickness: 100 },
      ],
      2,
      [2850, 2850, 4700, 4700, 4850, 4850],
    ],
    [
      'an L plan',
      [{ points: [pt(0, 0), pt(8000, 0), pt(8000, 3000), pt(4000, 3000), pt(4000, 6000), pt(0, 6000), pt(0, 0)], thickness: 200 }],
      1,
      [2800, 3000, 3800, 4000, 5800, 7800],
    ],
    [
      'three rooms',
      [
        { points: box(0, 0, 9000, 6000), thickness: 200 },
        { points: [pt(4500, 0), pt(4500, 6000)], thickness: 200 },
        { points: [pt(4500, 3000), pt(9000, 3000)], thickness: 150 },
      ],
      3,
      [2900, 2900, 4400, 4400, 4400, 4400, 5800],
    ],
    [
      'an angled room',
      [{ points: [pt(0, 0), pt(5000, 700), pt(5300, 4100), pt(-200, 3700), pt(0, 0)], thickness: 200 }],
      1,
      [3216.18, 3498.35, 4860.34, 5298.87],
    ],
  ];

  it.each(plans)('%s', async (_name, chains, rooms, expected) => {
    chains.forEach((chain) => store().wallGraphAddChain(chain.points, { thickness: chain.thickness }));
    await settle(rooms);
    const values = autoDimensions().map((dimension) => dimension.value).sort((a, b) => a - b);
    expect(values).toHaveLength(expected.length);
    expected.forEach((value, index) => expect(values[index]).toBeCloseTo(value, 1));
  });

  it('a partition splits the run at its centreline and is not dimensioned itself', async () => {
    store().wallGraphAddChain(box(0, 0, 6000, 4000), { thickness: 200 });
    store().wallGraphAddChain([pt(3000, 0), pt(3000, 4000)], { thickness: 200 });
    await settle(2);
    const spans = autoDimensions()
      .map((dimension) => dimension.points.flatMap((point) => [point.x, point.y]).join(' '))
      .sort();
    expect(spans).toEqual(
      [
        '100 100 3000 100',
        '3000 100 5900 100',
        '3000 3900 100 3900',
        '5900 3900 3000 3900',
        '100 3900 100 100',
        '5900 100 5900 3900',
      ].sort()
    );
  });
});

describe('every route in ends in the graph', () => {
  const allInGraph = () => store().walls.every((wall) => wall.graph);

  it('the room tool: four joined walls, one body', () => {
    store().createRoomWalls({ width: 4000, height: 3000, wallThickness: 200, material: 'brick' }, pt(0, 0));
    expect(store().walls).toHaveLength(4);
    expect(allInGraph()).toBe(true);
    expect(computeWallUnionRenderData(store().walls).components).toHaveLength(1);
    const nodes = Object.values(store().getWallGraph().nodes);
    expect(nodes).toHaveLength(4);
  });

  it('addWall: a wall ending on another makes a real T, and returns the new wall', () => {
    const host = store().addWall({ startPoint: pt(0, 0), endPoint: pt(6000, 0), thickness: 200 });
    const stem = store().addWall({ startPoint: pt(3000, 0), endPoint: pt(3000, 3000), thickness: 200 });
    expect(allInGraph()).toBe(true);
    expect(store().walls).toHaveLength(3);
    expect(store().walls.map((wall) => wall.id)).toContain(host); // the longer piece stays the same wall
    expect(store().walls.find((wall) => wall.id === stem)!.endPoint).toEqual(pt(3000, 3000));
  });

  it('addWall keeps what it was asked for: layer, partition mode, height, material', () => {
    const id = store().addWall({
      startPoint: pt(0, 0),
      endPoint: pt(4000, 0),
      thickness: 100,
      material: 'partition',
      layer: 'partition',
      partitionMode: 'half',
      properties3D: { height: 1200, materialId: 'exterior-wood-siding-25', shadingFactor: 0.4 },
    });
    const wall = store().walls.find((candidate) => candidate.id === id)!;
    expect(wall.layer).toBe('partition');
    expect(wall.partitionMode).toBe('half');
    expect(wall.properties3D.height).toBe(1200);
    expect(wall.properties3D.materialId).toBe('exterior-wood-siding-25');
    expect(wall.properties3D.shadingFactor).toBe(0.4);
  });

  it('addWall respects the skip options, as batch tools need', () => {
    const before = store().history.length;
    store().addWall({ startPoint: pt(0, 0), endPoint: pt(1000, 0) }, { skipHistory: true });
    expect(store().walls).toHaveLength(1);
    expect(store().history).toHaveLength(before);
    store().addWall({ startPoint: pt(0, 2000), endPoint: pt(1000, 2000) });
    expect(store().history.length).toBeGreaterThan(before);
  });

  it('drawn over a wall already there, addWall hands back that wall', () => {
    const first = store().addWall({ startPoint: pt(0, 0), endPoint: pt(4000, 0), thickness: 200 });
    const again = store().addWall({ startPoint: pt(0, 0), endPoint: pt(4000, 0), thickness: 200 });
    expect(store().walls).toHaveLength(1);
    expect(again).toBe(first);
  });

  it('opening a saved drawing makes real junctions of walls that only touch, keeping doors', () => {
    store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    const host = store().walls[0]!;
    const bare = (wall: typeof host, id: string, start: ReturnType<typeof pt>, end: ReturnType<typeof pt>) => ({
      ...wall,
      id,
      startPoint: start,
      endPoint: end,
      graph: undefined,
      openings: [],
    });
    const doc = JSON.parse(store().exportToJSON());
    doc.walls = [
      { ...bare(host, 'old-host', pt(0, 0), pt(6000, 0)), openings: [{ id: 'door', type: 'door', position: 5000, width: 900, height: 2100 }] },
      bare(host, 'old-stem', pt(3000, 50), pt(3000, 3000)),
    ];
    store().importFromJSON(JSON.stringify(doc));
    const walls = store().walls;
    expect(walls).toHaveLength(3);
    expect(walls.every((wall) => wall.graph)).toBe(true);
    expect(computeWallUnionRenderData(walls).components).toHaveLength(1);
    expect(walls.map((wall) => wall.id)).toEqual(expect.arrayContaining(['old-stem']));
    const withDoor = walls.filter((wall) => wall.openings.length > 0);
    expect(withDoor).toHaveLength(1);
    const door = withDoor[0]!.openings[0]!;
    expect(withDoor[0]!.startPoint.x + door.position).toBeCloseTo(5000, 6);
  });
});

describe('editing a wall keeps it truly joined', () => {
  it('moving a wall’s end moves the shared corner: its neighbour follows', () => {
    const [first, second] = store().wallGraphAddChain([pt(0, 0), pt(4000, 0), pt(4000, 3000)], { thickness: 200 });
    store().updateWall(first!, { endPoint: pt(4500, 0) }, { skipHistory: true });
    const moved = store().walls.find((wall) => wall.id === first)!;
    const neighbour = store().walls.find((wall) => wall.id === second)!;
    expect(moved.endPoint).toEqual(pt(4500, 0));
    expect(neighbour.startPoint).toEqual(pt(4500, 0));
    expect(store().getWallGraph().nodes[moved.graph!.b]!.p).toEqual([4500, 0]);
  });

  it('during a drag frame too, and with no history or room work', () => {
    const [first, second] = store().wallGraphAddChain([pt(0, 0), pt(4000, 0), pt(4000, 3000)], { thickness: 200 });
    store().updateWall(first!, { endPoint: pt(4500, 100) }, { skipHistory: true, source: 'drag' });
    expect(store().walls.find((wall) => wall.id === second)!.startPoint).toEqual(pt(4500, 100));
    store().updateWalls([{ id: second!, updates: { endPoint: pt(4500, 3500) } }], { skipHistory: true, source: 'drag' });
    expect(store().walls.find((wall) => wall.id === second)!.endPoint).toEqual(pt(4500, 3500));
  });

  it('changing thickness keeps the wall and its neighbours in the graph', () => {
    const [first] = store().wallGraphAddChain([pt(0, 0), pt(4000, 0), pt(4000, 3000)], { thickness: 200 });
    store().updateWall(first!, { thickness: 300 }, { skipHistory: true });
    expect(store().walls.find((wall) => wall.id === first)!.thickness).toBe(300);
    expect(store().walls.every((wall) => wall.graph)).toBe(true);
    expect(computeWallUnionRenderData(store().walls).components).toHaveLength(1);
  });

  it('attributes edited alongside a move are kept', () => {
    const [first] = store().wallGraphAddChain([pt(0, 0), pt(4000, 0)], { thickness: 200 });
    store().updateWall(first!, { endPoint: pt(5000, 0), layer: 'structural' }, { skipHistory: true });
    const wall = store().walls.find((candidate) => candidate.id === first)!;
    expect(wall.endPoint).toEqual(pt(5000, 0));
    expect(wall.layer).toBe('structural');
  });

  it('placing a door does not reshape or merge anything', () => {
    const [first, second] = store().wallGraphAddChain([pt(0, 0), pt(3000, 0), pt(6000, 0)], { thickness: 200 });
    store().updateWall(first!, { openings: [{ id: 'd', type: 'door', position: 1000, width: 900, height: 2100 }] }, { skipHistory: true });
    expect(store().walls.map((wall) => wall.id).sort()).toEqual([first, second].sort());
    expect(store().walls.find((wall) => wall.id === first)!.openings).toHaveLength(1);
  });

  it('trim and extend move only that wall’s end, and it joins what it reaches', () => {
    const [first, second] = store().wallGraphAddChain([pt(0, 0), pt(4000, 0), pt(4000, 3000)], { thickness: 200 });
    store().wallGraphAddChain([pt(1000, -2000), pt(1000, 2000)], { thickness: 200 });
    store().wallGraphMoveEnd(second!, 'end', pt(4000, 1500), { skipHistory: true });
    const trimmed = store().walls.find((wall) => wall.id === second)!;
    expect(trimmed.endPoint).toEqual(pt(4000, 1500));
    expect(trimmed.startPoint).toEqual(pt(4000, 0));
    expect(store().walls.find((wall) => wall.id === first)).toBeDefined();
  });

  it('a wall dragged across another becomes an X when dropped', () => {
    store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    const [stem] = store().wallGraphAddChain([pt(3000, 1000), pt(3000, 3000)], { thickness: 200 });
    store().updateWall(stem!, { startPoint: pt(3000, -1000), endPoint: pt(3000, 1000) }, { skipHistory: true, source: 'drag' });
    expect(computeWallUnionRenderData(store().walls).components).toHaveLength(2); // mid-drag: nothing settled yet
    store().wallGraphCommitDrag();
    expect(store().walls).toHaveLength(4);
    expect(computeWallUnionRenderData(store().walls).components).toHaveLength(1);
  });

  it('deleting the stem of a T leaves the through wall one wall again, door intact', () => {
    const [host] = store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    store().updateWall(host!, { openings: [{ id: 'far-door', type: 'door', position: 5000, width: 900, height: 2100 }] }, { skipHistory: true });
    const [stem] = store().wallGraphAddChain([pt(2000, 0), pt(2000, 3000)], { thickness: 200 });
    expect(store().walls).toHaveLength(3);
    store().deleteWall(stem!);
    expect(store().walls).toHaveLength(1);
    const wall = store().walls[0]!;
    expect(wall.id).toBe(host);
    expect(wall.startPoint).toEqual(pt(0, 0));
    expect(wall.endPoint).toEqual(pt(6000, 0));
    expect(wall.openings[0]!.position).toBeCloseTo(5000, 6);
  });

  it('a deliberate split stays split when a wall elsewhere is deleted', () => {
    const [host] = store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    store().wallGraphSplit(host!, 0.5);
    const [other] = store().wallGraphAddChain([pt(0, 2000), pt(6000, 2000)], { thickness: 200 });
    store().deleteWall(other!);
    expect(store().walls).toHaveLength(2);
  });

  it('selection follows: a wall absorbed by another hands its selection over, a deleted one lets go', () => {
    const [first] = store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    useDrawingStore.setState({ selectedIds: [first!, 'some-unit'] });
    store().deleteWall(first!);
    expect(store().selectedIds).toEqual(['some-unit']);
  });
});

describe('what a wall carries survives a tee', () => {
  it('a door stays exactly where it was in the room', () => {
    const [host] = store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    store().updateWall(host!, { openings: [{ id: 'door', type: 'door', position: 1000, width: 900, height: 2100 }] }, { skipHistory: true });
    store().wallGraphAddChain([pt(4000, 0), pt(4000, 3000)], { thickness: 200 });
    const doors = store().walls.flatMap((wall) => wall.openings.map((opening) => ({ wall, opening })));
    expect(doors).toHaveLength(1);
    expect(doors[0]!.wall.startPoint.x + doors[0]!.opening.position).toBeCloseTo(1000, 6);
  });

  it('a door the tee lands on stays whole, moves the minimum, and tells the user', () => {
    const [host] = store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    store().updateWall(host!, { openings: [{ id: 'door', type: 'door', position: 3000, width: 900, height: 2100 }] }, { skipHistory: true });
    store().wallGraphAddChain([pt(3100, 0), pt(3100, 3000)], { thickness: 200 });
    const doors = store().walls.flatMap((wall) => wall.openings.map((opening) => ({ wall, opening })));
    expect(doors).toHaveLength(1);
    const { wall, opening } = doors[0]!;
    const centre = wall.startPoint.x + opening.position;
    expect(centre).toBeCloseTo(2600, 6); // 450 half-width + 50 margin clear of x = 3100
    expect(store().processingStatus).toContain('400 mm');
  });

  it('a raised wall keeps its height on both pieces', () => {
    const [host] = store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    store().wallGraphSetParams([host!], { height: 3600 });
    store().wallGraphAddChain([pt(2000, 0), pt(2000, 3000)], { thickness: 200 });
    const pieces = store().walls.filter((wall) => wall.startPoint.y === 0 && wall.endPoint.y === 0);
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) expect(piece.properties3D.height).toBe(3600);
  });

  it('its length-derived values are its own, not its parent’s', () => {
    store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    store().wallGraphAddChain([pt(2000, 0), pt(2000, 3000)], { thickness: 200 });
    for (const wall of store().walls) {
      expect(wall.properties3D.computedLength).toBeCloseTo(Math.hypot(wall.endPoint.x - wall.startPoint.x, wall.endPoint.y - wall.startPoint.y), 6);
    }
  });

  it('one undo takes the tee away and restores the wall exactly', () => {
    const [host] = store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    store().updateWall(host!, { openings: [{ id: 'door', type: 'door', position: 1000, width: 900, height: 2100 }] });
    const before = JSON.stringify(store().walls);
    store().wallGraphAddChain([pt(4000, 0), pt(4000, 3000)], { thickness: 200 });
    expect(store().walls).toHaveLength(3);
    store().undo();
    expect(JSON.stringify(store().walls)).toBe(before);
    store().redo();
    expect(store().walls).toHaveLength(3);
  });
});

describe('new walls take what was asked for', () => {
  it('the height asked for, and Default height when none is', () => {
    const [tall] = store().wallGraphAddChain([pt(0, 0), pt(4000, 0)], { thickness: 200, height: 3000 });
    expect(store().walls.find((wall) => wall.id === tall)!.properties3D.height).toBe(3000);
    const settings = store().wallSettings;
    useDrawingStore.setState({ wallSettings: { ...settings, defaultHeight: 3300 } });
    const [plain] = store().wallGraphAddChain([pt(0, 3000), pt(4000, 3000)], { thickness: 200 });
    expect(store().walls.find((wall) => wall.id === plain)!.properties3D.height).toBe(3300);
    useDrawingStore.setState({ wallSettings: settings });
  });

  it('the material asked for, with its own thermal build-up', () => {
    const [wood] = store().wallGraphAddChain([pt(0, 0), pt(4000, 0)], { thickness: 200, materialId: 'exterior-wood-siding-25' });
    const wall = store().walls.find((candidate) => candidate.id === wood)!;
    expect(wall.properties3D.materialId).toBe('exterior-wood-siding-25');
    expect(wall.properties3D.thermalAssembly?.some((layer) => layer.materialId === 'exterior-brick-200')).toBe(false);
  });

  it('the partition tool’s height mode, which used to be lost', () => {
    const settings = store().wallSettings;
    useDrawingStore.setState({ activeTool: 'partition-wall', wallSettings: { ...settings, partitionMode: 'half' } });
    const [partition] = store().wallGraphAddChain([pt(0, 0), pt(4000, 0)], { thickness: 100 });
    const wall = store().walls.find((candidate) => candidate.id === partition)!;
    expect(wall.partitionMode).toBe('half');
    expect(wall.properties3D.height).toBeLessThan(settings.defaultHeight);
    useDrawingStore.setState({ activeTool: 'select', wallSettings: settings });
  });
});

describe('clicking on a wall joins it, at any zoom', () => {
  const host = () => {
    store().wallGraphAddChain([pt(0, 0), pt(6000, 0)], { thickness: 200 });
    return store().walls;
  };

  it('anywhere across its body lands on the centreline', () => {
    const walls = host();
    for (const across of [0, 20, 60, 90, 100, -60, -100]) {
      for (const zoom of [0.25, 0.5, 1, 2, 4, 8]) {
        const snap = snapWallPoint(pt(3333, across), null, store().wallSettings, walls, false, zoom, undefined);
        expect(snap.snappedPoint, `across ${across}, zoom ${zoom}`).toEqual(pt(3333, 0));
        expect(snap.connectedWallId).toBe(walls[0]!.id);
      }
    }
  });

  it('near the wall’s end it lands on the end, not on a stub beside it', () => {
    const walls = host();
    const snap = snapWallPoint(pt(5950, 40), null, { ...store().wallSettings, endpointSnapTolerance: 1 }, walls, false, 1, undefined);
    expect(snap.snappedPoint).toEqual(pt(6000, 0));
  });

  it('just outside the wall nothing changes', () => {
    const walls = host();
    const settings = { ...store().wallSettings, snapToGrid: false, endpointSnapTolerance: 1, midpointSnapTolerance: 1 };
    const snap = snapWallPoint(pt(3333, 150), null, settings, walls, false, 1, undefined);
    expect(snap.snappedPoint).toEqual(pt(3333, 150));
  });

  it('with snapping off, or Alt held, the point stays free', () => {
    const walls = host();
    const off = { ...store().wallSettings, snapToGrid: false, endpointSnapTolerance: 0, midpointSnapTolerance: 0 };
    expect(snapWallPoint(pt(3333, 60), null, off, walls, false, 1, undefined).snappedPoint).toEqual(pt(3333, 60));
    const on = { ...store().wallSettings, snapToGrid: false };
    expect(snapWallPoint(pt(3333, 60), null, on, [], false, 1, undefined).snappedPoint).toEqual(pt(3333, 60)); // Alt passes no walls
  });

  it('a wall drawn to that point really joins: one body', () => {
    const walls = host();
    const snap = snapWallPoint(pt(3333, 90), null, store().wallSettings, walls, false, 1, undefined);
    store().wallGraphAddChain([snap.snappedPoint, pt(3333, 3000)], { thickness: 200 });
    expect(store().walls).toHaveLength(3);
    expect(computeWallUnionRenderData(store().walls).components).toHaveLength(1);
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
