import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import type { PipeRouteNode3D } from '../pipeRoute3d';
import { resolveRefrigerantPipeSpec } from '../refrigerantPipePairModel';

import { cutRefrigerantPieces, readPipeGaps, refrigerantOpenEnds } from './refrigerantCut';
import { refrigerantLineOf } from './refrigerantPieces';

const line = (id: string, nodes: PipeRouteNode3D[], properties: Record<string, unknown> = {}): HvacElement => ({
  id, type: 'refrigerant-pipe', label: 'Gas Pipe', position: { x: 0, y: 0 }, width: 100, depth: 100, height: 50,
  elevation: 2600, rotation: 0, mountType: 'ceiling', supplyZoneRatio: 0,
  properties: {
    lineKind: 'gas', pipeDiameterMm: 15.88, outerDiameterMm: 65.88, insulationThicknessMm: 25,
    routePoints: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes, segmentMaterials: nodes.slice(1).map(() => 'hard'),
    ...properties,
  },
} as unknown as HvacElement);

/** 2 m along x, a bend, 3 m along y, a bend, 3 m along x. */
const Z = 2650;
const ROUTE: PipeRouteNode3D[] = [{ x: 0, y: 0, z: Z }, { x: 2000, y: 0, z: Z }, { x: 2000, y: 3000, z: Z }, { x: 5000, y: 3000, z: Z }];
/** The liquid line 100 mm beside it (a coordinated pair). */
const LIQUID: PipeRouteNode3D[] = [{ x: 0, y: 100, z: Z }, { x: 1900, y: 100, z: Z }, { x: 1900, y: 3100, z: Z }, { x: 5000, y: 3100, z: Z }];

function ids() {
  let n = 0;
  return (kind: 'run' | 'gap') => `${kind}-${(n += 1)}`;
}

const keysOf = (element: HvacElement, scene: readonly HvacElement[]) => refrigerantLineOf(element, scene)!.pieces.map((piece) => `${piece.kind}:${piece.key}`);

describe('deleting pieces of a refrigerant line', () => {
  it('the straight between two bends: two lines, each bend kept, the gap remembered at both ends', () => {
    const gas = line('gas', ROUTE);
    const scene = [gas];
    const straight = refrigerantLineOf(gas, scene)!.pieces.filter((piece) => piece.kind === 'straight')[1]!;
    const result = cutRefrigerantPieces(scene, [{ runId: 'gas', key: straight.key }], { newId: ids() });
    expect(result.pieces).toBe(1);
    expect(result.gaps).toBe(1);
    expect(result.add.map((element) => element.id)).toEqual(['run-2']);
    const first = result.updates.find((element) => element.id === 'gas')!;
    const second = result.add[0]!;
    // Each part keeps its bend (now at an open end): the first a straight and a bend, the second a bend and a straight.
    expect(keysOf(first, [first, second]).map((key) => key.split(':')[0])).toEqual(['straight', 'bend']);
    expect(keysOf(second, [first, second]).map((key) => key.split(':')[0])).toEqual(['bend', 'straight']);
    expect(readPipeGaps(first).end).toMatchObject({ id: 'gap-1', partner: { runId: 'run-2', end: 'start' } });
    expect(readPipeGaps(second).start).toMatchObject({ id: 'gap-1', partner: { runId: 'gas', end: 'end' } });
    // The open ends carry no connection; the stretch deleted runs along the old line.
    expect(resolveRefrigerantPipeSpec(first.properties).endConnection).toBeNull();
    const removed = readPipeGaps(first).end!.removed!;
    expect(removed[0]!.x).toBeCloseTo(2000, 0);
    expect(removed[removed.length - 1]!.x).toBeCloseTo(2000, 0);
    expect(refrigerantOpenEnds([first, second])).toHaveLength(2);
  });

  it('a coordinated pair loses the same stretch on both lines, the parts paired again', () => {
    const gas = line('gas', ROUTE, { bundleId: 'b1' });
    const liquid = line('liquid', LIQUID, { bundleId: 'b1', lineKind: 'liquid', pipeDiameterMm: 9.52, outerDiameterMm: 59.52 });
    const scene = [gas, liquid];
    const straight = refrigerantLineOf(gas, scene)!.pieces.filter((piece) => piece.kind === 'straight')[1]!;
    const result = cutRefrigerantPieces(scene, [{ runId: 'gas', key: straight.key }], { newId: ids() });
    expect(result.updates.map((element) => element.id).sort()).toEqual(['gas', 'liquid']);
    expect(result.add).toHaveLength(2);
    // Part 0 of each keeps the bundle; part 1 of each shares a new one.
    expect(result.updates.every((element) => element.properties.bundleId === 'b1')).toBe(true);
    expect(new Set(result.add.map((element) => element.properties.bundleId))).toEqual(new Set(['b1-p1']));
    // The liquid line is cut alongside: its part 0 ends near x 1900 too.
    const liquidFirst = result.updates.find((element) => element.id === 'liquid')!;
    const end = (liquidFirst.properties.routeNodes3d as PipeRouteNode3D[]).at(-1)!;
    expect(end.x).toBeCloseTo(1900, 0);
  });

  it('Alt (pairs off): only the line picked', () => {
    const gas = line('gas', ROUTE, { bundleId: 'b1' });
    const liquid = line('liquid', LIQUID, { bundleId: 'b1', lineKind: 'liquid' });
    const straight = refrigerantLineOf(gas, [gas, liquid])!.pieces.filter((piece) => piece.kind === 'straight')[1]!;
    const result = cutRefrigerantPieces([gas, liquid], [{ runId: 'gas', key: straight.key }], { pairs: false, newId: ids() });
    expect(result.updates.map((element) => element.id)).toEqual(['gas']);
    expect(result.add).toHaveLength(1);
    expect(result.add[0]!.properties.bundleId).toBeUndefined();
  });

  it('a bend: the straights either side stay where they were', () => {
    const gas = line('gas', ROUTE);
    const bend = refrigerantLineOf(gas, [gas])!.pieces.find((piece) => piece.kind === 'bend')!;
    const result = cutRefrigerantPieces([gas], [{ runId: 'gas', key: bend.key }], { newId: ids() });
    const first = result.updates[0]!;
    const second = result.add[0]!;
    expect((first.properties.routeNodes3d as PipeRouteNode3D[]).at(-1)!.x).toBeCloseTo(bend.path[0]!.x, 1);
    expect((second.properties.routeNodes3d as PipeRouteNode3D[])[0]!.y).toBeCloseTo(bend.path.at(-1)!.y, 1);
  });

  it('an accessory: the line stays whole without it; on a cut, the accessories go with their part', () => {
    const at = { x: 3500, y: 3000, z: Z };
    const gas = line('gas', ROUTE, { inlineAccessories: [{ id: 'a1', kind: 'ball-valve', legId: 'unknown', stationMm: 1500, at }] });
    const accessory = refrigerantLineOf(gas, [gas])!.pieces.find((piece) => piece.kind === 'accessory')!;
    expect(accessory.key).toBe('acc:a1');
    const removed = cutRefrigerantPieces([gas], [{ runId: 'gas', key: accessory.key }], { newId: ids() });
    expect(removed.add).toHaveLength(0);
    expect(removed.updates[0]!.properties.inlineAccessories).toBeUndefined();
    const straight = refrigerantLineOf(gas, [gas])!.pieces.filter((piece) => piece.kind === 'straight')[0]!;
    const result = cutRefrigerantPieces([gas], [{ runId: 'gas', key: straight.key }], { newId: ids() });
    // The first straight went (a lone open start); the valve on the last straight stays on the line.
    expect(result.updates[0]!.properties.inlineAccessories).toEqual([expect.objectContaining({ id: 'a1' })]);
  });

  it('a riser: the line is cut at its plan point, the two parts at its bottom and its top', () => {
    const nodes: PipeRouteNode3D[] = [{ x: 0, y: 0, z: 2600 }, { x: 2000, y: 0, z: 2600 }, { x: 2000, y: 0, z: 3200 }, { x: 2000, y: 3000, z: 3200 }, { x: 4000, y: 3000, z: 3200 }];
    const gas = line('gas', nodes);
    const riser = refrigerantLineOf(gas, [gas])!.pieces.find((piece) => piece.kind === 'riser')!;
    const result = cutRefrigerantPieces([gas], [{ runId: 'gas', key: riser.key }], { newId: ids() });
    const first = result.updates[0]!.properties.routeNodes3d as PipeRouteNode3D[];
    const second = result.add[0]!.properties.routeNodes3d as PipeRouteNode3D[];
    expect(first.at(-1)).toMatchObject({ x: 2000, y: 0 });
    expect(second[0]).toMatchObject({ x: 2000, y: 0 });
    expect(second[0]!.z).toBeGreaterThan(first.at(-1)!.z);
  });

  it('a line with no 3D route of its own: the part after the cut keeps its level, the part at its start port needs none', () => {
    // Its level comes from its start port (2650), a riser to its end port (1400) is derived: no stored route.
    const port = (x: number, y: number, elevationMm: number) => ({ connectionKind: 'unit-port', portPoint: { x, y }, direction: { x: 1, y: 0 }, elevationMm });
    const gas = line('gas', ROUTE, { startConnection: port(0, 0, 2650), endConnection: port(5000, 3000, 1400) });
    delete (gas.properties as Record<string, unknown>).routeNodes3d;
    const straight = refrigerantLineOf(gas, [gas])!.pieces.filter((piece) => piece.kind === 'straight')[1]!;
    const result = cutRefrigerantPieces([gas], [{ runId: 'gas', key: straight.key }], { newId: ids() });
    const first = result.updates[0]!;
    const second = result.add[0]!;
    expect(first.properties.routeNodes3d).toBeUndefined();
    const nodes = second.properties.routeNodes3d as PipeRouteNode3D[];
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    expect(nodes.every((node) => node.z === 2650)).toBe(true);
    expect(readPipeGaps(second).start?.levelKept).toBe(true);
    // The stretch deleted is remembered at that level too.
    expect(readPipeGaps(first).end?.removed?.every((node) => node.z === 2650)).toBe(true);
  });

  it('a pair whose lines differ in shape: the other line loses the straight alongside, the two cut level with each other', () => {
    // The gas line jogs 40 mm before its long straight; the liquid line turns once, 120 mm beside it.
    const gasRoute: PipeRouteNode3D[] = [{ x: 0, y: 0, z: Z }, { x: 1000, y: 0, z: Z }, { x: 1000, y: 40, z: Z }, { x: 2000, y: 40, z: Z },
      { x: 2000, y: 4000, z: Z }, { x: 5000, y: 4000, z: Z }];
    const liquidRoute: PipeRouteNode3D[] = [{ x: 0, y: 160, z: Z }, { x: 1880, y: 160, z: Z }, { x: 1880, y: 4120, z: Z }, { x: 5000, y: 4120, z: Z }];
    const gas = line('gas', gasRoute, { bundleId: 'b1' });
    const liquid = line('liquid', liquidRoute, { bundleId: 'b1', lineKind: 'liquid' });
    const scene = [gas, liquid];
    const long = refrigerantLineOf(gas, scene)!.pieces.filter((piece) => piece.kind === 'straight').sort((a, b) => b.lengthMm - a.lengthMm)[0]!;
    const result = cutRefrigerantPieces(scene, [{ runId: 'gas', key: long.key }], { newId: ids() });
    const ends = refrigerantOpenEnds([...result.updates, ...result.add]);
    const at = (kind: string, end: 'start' | 'end') => ends.find((candidate) => candidate.lineKind === kind && candidate.end === end)!.point;
    // Each line still keeps its own bends (the liquid's corner is not cut), and the open ends face each other abreast.
    expect(at('liquid', 'end').x).toBeCloseTo(1880, 3);
    expect(at('gas', 'end').y).toBeCloseTo(at('liquid', 'end').y, 3);
    expect(at('gas', 'start').y).toBeCloseTo(at('liquid', 'start').y, 3);
    expect(at('liquid', 'start').x).toBeCloseTo(1880, 3);
  });

  it('a line drawn with its bends as arc chords: cut where it is drawn straight, its arcs left whole, the pair still level', () => {
    // The liquid line as an older pipe tool drew it: each bend a 90° arc of radius 80 in 12 chords.
    const arc = (corner: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }, r: number) => {
      const start = { x: corner.x - from.x * r, y: corner.y - from.y * r };
      const centre = { x: start.x + to.x * r, y: start.y + to.y * r };
      return Array.from({ length: 13 }, (_, index) => {
        const t = (index / 12) * (Math.PI / 2);
        // From the start round to the end, about the centre.
        const ux = start.x - centre.x; const uy = start.y - centre.y;
        const vx = corner.x + to.x * r - centre.x; const vy = corner.y + to.y * r - centre.y;
        return { x: centre.x + ux * Math.cos(t) + vx * Math.sin(t), y: centre.y + uy * Math.cos(t) + vy * Math.sin(t), z: Z };
      });
    };
    const liquidRoute: PipeRouteNode3D[] = [{ x: 0, y: 120, z: Z },
      ...arc({ x: 1880, y: 120 }, { x: 1, y: 0 }, { x: 0, y: 1 }, 80), ...arc({ x: 1880, y: 4120 }, { x: 0, y: 1 }, { x: 1, y: 0 }, 80), { x: 5000, y: 4120, z: Z }];
    const gas = line('gas', ROUTE.map((node) => ({ ...node, y: node.y === 3000 ? 4000 : node.y })), { bundleId: 'b1' });
    const liquid = line('liquid', liquidRoute, { bundleId: 'b1', lineKind: 'liquid' });
    const scene = [gas, liquid];
    const long = refrigerantLineOf(gas, scene)!.pieces.filter((piece) => piece.kind === 'straight')[1]!;
    const result = cutRefrigerantPieces(scene, [{ runId: 'gas', key: long.key }], { newId: ids() });
    const ends = refrigerantOpenEnds([...result.updates, ...result.add]);
    const at = (kind: string, end: 'start' | 'end') => ends.find((candidate) => candidate.lineKind === kind && candidate.end === end)!;
    // The liquid's open ends sit on its drawn straight (x 1880), each arc kept whole on its part; the two lines level.
    for (const end of ['end', 'start'] as const) {
      expect(at('liquid', end).point.x).toBeCloseTo(1880, 3);
      expect(at('gas', end).point.y).toBeCloseTo(at('liquid', end).point.y, 3);
      expect(Math.abs(at('liquid', end).outward.y)).toBeCloseTo(1, 6);
    }
    // The first part of the liquid line keeps all 13 points of its arc.
    const first = result.updates.find((element) => element.id === 'liquid')!;
    expect((first.properties.routePoints as unknown[]).length).toBeGreaterThanOrEqual(14);
  });

  it('a locked line is refused', () => {
    const gas = line('gas', ROUTE, { routeLocked: true });
    const straight = refrigerantLineOf(gas, [gas])!.pieces.find((piece) => piece.kind === 'straight')!;
    expect(cutRefrigerantPieces([gas], [{ runId: 'gas', key: straight.key }]).refused[0]!.reason).toMatch(/locked/);
  });
});
