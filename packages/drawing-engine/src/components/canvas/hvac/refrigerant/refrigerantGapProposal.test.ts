import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import type { PipeRouteNode3D } from '../pipeRoute3d';

import { cutRefrigerantPieces, readPipeGaps, refrigerantOpenEnds } from './refrigerantCut';
import { closeDrawnRefrigerantGaps, proposeRefrigerantGap } from './refrigerantGapProposal';
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

const Z = 2650;
/** 2 m along x, a bend, 4 m along y, a bend, 3 m along x. */
const ROUTE: PipeRouteNode3D[] = [{ x: 0, y: 0, z: Z }, { x: 2000, y: 0, z: Z }, { x: 2000, y: 4000, z: Z }, { x: 5000, y: 4000, z: Z }];
const LIQUID: PipeRouteNode3D[] = [{ x: 0, y: 120, z: Z }, { x: 1880, y: 120, z: Z }, { x: 1880, y: 4120, z: Z }, { x: 5000, y: 4120, z: Z }];

/** A command applied as the store applies one: an update's properties merged over the element's own. */
function applied(scene: readonly HvacElement[], command: { updates?: readonly HvacElement[]; add?: readonly HvacElement[]; removeIds?: readonly string[] }): HvacElement[] {
  const replaced = new Map((command.updates ?? []).map((element) => [element.id, element]));
  const removed = new Set(command.removeIds ?? []);
  const merged = (element: HvacElement) => {
    const update = replaced.get(element.id);
    return update ? { ...element, ...update, properties: { ...element.properties, ...update.properties } } : element;
  };
  return [...scene.filter((element) => !removed.has(element.id)).map(merged), ...(command.add ?? [])];
}

function cutMiddle(scene: HvacElement[], runId = 'gas') {
  const element = scene.find((candidate) => candidate.id === runId)!;
  const straight = refrigerantLineOf(element, scene)!.pieces.filter((piece) => piece.kind === 'straight')[1]!;
  let n = 0;
  const result = cutRefrigerantPieces(scene, [{ runId, key: straight.key }], { newId: (kind) => `${kind}-${(n += 1)}` });
  const after = applied(scene, result);
  return { after, gapId: refrigerantOpenEnds(after)[0]!.gap.id };
}

const nodesOf = (element: HvacElement) => element.properties.routeNodes3d as PipeRouteNode3D[];

describe('reconnecting a gap left by deleted refrigerant pieces', () => {
  it('"As it was": one line again, along its old route, no gap left', () => {
    const { after, gapId } = cutMiddle([line('gas', ROUTE)]);
    const proposals = proposeRefrigerantGap(after, gapId);
    expect(proposals.reason).toBeNull();
    const best = proposals.candidates[0]!;
    expect(best.key).toBe('as-before');
    const restored = applied(after, best);
    expect(restored).toHaveLength(1);
    const joined = restored[0]!;
    expect(joined.id).toBe('gas');
    // The old corners are all back (with the cut points on the old line between them).
    for (const corner of ROUTE) expect(nodesOf(joined).some((node) => Math.hypot(node.x - corner.x, node.y - corner.y) < 1)).toBe(true);
    expect(readPipeGaps(joined)).toEqual({ start: null, end: null });
    expect(refrigerantOpenEnds(restored)).toHaveLength(0);
    // …and nothing more: the straight put back is one straight again (no points left where it was cut).
    expect(nodesOf(joined)).toHaveLength(ROUTE.length);
    const kinds = (element: HvacElement, scene: readonly HvacElement[]) => refrigerantLineOf(element, scene)!.pieces.map((piece) => piece.kind);
    expect(kinds(joined, restored)).toEqual(kinds(line('gas', ROUTE), [line('gas', ROUTE)]));
  });

  it('a coordinated pair: both lines put back together, in one way', () => {
    const scene = [line('gas', ROUTE, { bundleId: 'b1' }), line('liquid', LIQUID, { bundleId: 'b1', lineKind: 'liquid' })];
    const { after, gapId } = cutMiddle(scene);
    expect(after).toHaveLength(4);
    const best = proposeRefrigerantGap(after, gapId).candidates[0]!;
    expect(best.updates.map((element) => element.id).sort()).toEqual(['gas', 'liquid']);
    expect(best.removeIds).toHaveLength(2);
    const restored = applied(after, best);
    expect(restored.map((element) => element.id).sort()).toEqual(['gas', 'liquid']);
    expect(restored.every((element) => element.properties.bundleId === 'b1')).toBe(true);
  });

  it('the second part moved aside: routed to it (two bends), the other line of the pair laid beside it', () => {
    const scene = [line('gas', ROUTE, { bundleId: 'b1' }), line('liquid', LIQUID, { bundleId: 'b1', lineKind: 'liquid' })];
    const { after, gapId } = cutMiddle(scene);
    // Both second parts shifted 800 mm along x: the stretch as it was no longer meets them.
    const shifted = after.map((element) => {
      if (element.id === 'gas' || element.id === 'liquid') return element;
      const nodes = nodesOf(element).map((node) => ({ ...node, x: node.x + 800 }));
      return { ...element, properties: { ...element.properties, routeNodes3d: nodes, routePoints: nodes.map(({ x, y }) => ({ x, y })) } };
    });
    const proposals = proposeRefrigerantGap(shifted, gapId);
    expect(proposals.candidates.map((candidate) => candidate.key)).not.toContain('as-before');
    const best = proposals.candidates[0]!;
    expect(best.elbows).toBe(2);
    expect(best.updates.map((element) => element.id).sort()).toEqual(['gas', 'liquid']);
    const restored = applied(shifted, best);
    expect(restored).toHaveLength(2);
    expect(refrigerantOpenEnds(restored)).toHaveLength(0);
    // The liquid line keeps its 120 mm beside the gas line all along, the new stretch too.
    const gas = nodesOf(restored.find((element) => element.id === 'gas')!);
    const liquid = nodesOf(restored.find((element) => element.id === 'liquid')!);
    expect(liquid.length).toBe(gas.length);
    expect(gas.length).toBe(6);
    // Each liquid straight runs with the gas straight of its place, 120 mm off its line.
    for (let index = 1; index < gas.length; index += 1) {
      const a = gas[index - 1]!;
      const b = gas[index]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
      const p = liquid[index - 1]!;
      const q = liquid[index]!;
      const lengthPq = Math.hypot(q.x - p.x, q.y - p.y);
      expect((u.x * (q.x - p.x) + u.y * (q.y - p.y)) / lengthPq).toBeCloseTo(1, 6);
      for (const point of [p, q]) expect(Math.abs((point.x - a.x) * -u.y + (point.y - a.y) * u.x)).toBeCloseTo(120, 3);
    }
  });

  it('a line with no 3D route of its own is put back as it was: its route, its ports, its 3D derived again', () => {
    const port = (x: number, y: number, elevationMm: number) => ({ connectionKind: 'unit-port', portPoint: { x, y }, direction: { x: 1, y: 0 }, elevationMm });
    const original = line('gas', ROUTE, { startConnection: port(0, 0, Z), endConnection: port(5000, 4000, 1400) });
    delete (original.properties as Record<string, unknown>).routeNodes3d;
    const { after, gapId } = cutMiddle([original]);
    // (The part after the cut stores the line's level while it is apart.)
    expect(after.find((element) => element.id !== 'gas')!.properties.routeNodes3d).toBeDefined();
    const best = proposeRefrigerantGap(after, gapId).candidates[0]!;
    expect(best.key).toBe('as-before');
    const joined = applied(after, best)[0]!;
    expect(joined.properties.routeNodes3d).toBeUndefined();
    expect(joined.properties.routePoints).toEqual(original.properties.routePoints);
    expect(joined.properties.startConnection).toEqual(original.properties.startConnection);
    expect(joined.properties.endConnection).toEqual(original.properties.endConnection);
    expect(joined.properties.bypasses).toBeUndefined();
  });

  describe('a gap drawn by hand with the pipe tool', () => {
    /** What the pipe tool's merge leaves: the line drawn on, `points` added at its `end`, that end's connection set. */
    const drawnOn = (element: HvacElement, points: Array<{ x: number; y: number }>, end: 'start' | 'end', connection: Record<string, unknown> | null): HvacElement => {
      const route = element.properties.routePoints as Array<{ x: number; y: number }>;
      const routePoints = end === 'end' ? [...route, ...points] : [...[...points].reverse(), ...route];
      const nodes = element.properties.routeNodes3d as PipeRouteNode3D[] | undefined;
      const z = nodes?.length ? (end === 'end' ? nodes.at(-1)!.z : nodes[0]!.z) : undefined;
      const routeNodes3d = nodes?.length ? (end === 'end' ? [...nodes, ...points.map((p) => ({ ...p, z: z! }))] : [...[...points].reverse().map((p) => ({ ...p, z: z! })), ...nodes]) : undefined;
      return { ...element, properties: { ...element.properties, routePoints, ...(routeNodes3d ? { routeNodes3d } : {}),
        segmentMaterials: routePoints.slice(1).map(() => 'hard'), [end === 'end' ? 'endConnection' : 'startConnection']: connection } };
    };
    const field = (point: { x: number; y: number }) => ({ connectionKind: 'field-pipe', portPoint: point, direction: { x: 0, y: 1 }, elevationMm: Z });

    it('finished on the other part\'s open start: one line again, under the first part\'s id', () => {
      const { after } = cutMiddle([line('gas', ROUTE)]);
      const first = after.find((element) => element.id === 'gas')!;
      const second = after.find((element) => element.id !== 'gas')!;
      const meet = (second.properties.routePoints as Array<{ x: number; y: number }>)[0]!;
      const closure = closeDrawnRefrigerantGaps(after, [drawnOn(first, [meet], 'end', field(meet))])!;
      expect(closure.joined).toBe(1);
      expect(closure.removeIds).toEqual([second.id]);
      const joined = closure.updates[0]!;
      expect(joined.id).toBe('gas');
      expect(nodesOf(joined)).toHaveLength(ROUTE.length);
      expect(readPipeGaps(joined)).toEqual({ start: null, end: null });
    });

    it('drawn back from the other part\'s open start onto the first part\'s open end: the same one line', () => {
      const { after } = cutMiddle([line('gas', ROUTE)]);
      const first = after.find((element) => element.id === 'gas')!;
      const second = after.find((element) => element.id !== 'gas')!;
      const meet = (first.properties.routePoints as Array<{ x: number; y: number }>).at(-1)!;
      const closure = closeDrawnRefrigerantGaps(after, [drawnOn(second, [meet], 'start', field(meet))])!;
      expect(closure.joined).toBe(1);
      expect(closure.removeIds).toEqual([second.id]);
      expect(closure.updates.map((element) => element.id)).toEqual(['gas']);
      expect(nodesOf(closure.updates[0]!)).toHaveLength(ROUTE.length);
    });

    it('stopped short: still a gap, without the stretch it remembered; drawn on to a port: that gap closed', () => {
      const { after, gapId } = cutMiddle([line('gas', ROUTE)]);
      const first = after.find((element) => element.id === 'gas')!;
      const second = after.find((element) => element.id !== 'gas')!;
      const end = (first.properties.routePoints as Array<{ x: number; y: number }>).at(-1)!;
      const short = closeDrawnRefrigerantGaps(after, [drawnOn(first, [{ x: end.x, y: end.y + 500 }], 'end', null)])!;
      expect(short.joined).toBe(0);
      expect(readPipeGaps(short.updates.find((element) => element.id === 'gas')!).end).toMatchObject({ id: gapId, removed: null });
      const port = { connectionKind: 'unit-port', portPoint: { x: end.x + 900, y: end.y }, direction: { x: -1, y: 0 }, elevationMm: Z };
      const toPort = closeDrawnRefrigerantGaps(after, [drawnOn(first, [port.portPoint], 'end', port)])!;
      expect(readPipeGaps(toPort.updates.find((element) => element.id === 'gas')!).end).toBeNull();
      // The other part's open start is left an open end, no longer a gap to reconnect.
      expect(readPipeGaps(toPort.updates.find((element) => element.id === second.id)!).start).toMatchObject({ partner: null, was: null });
    });

    it('drawing on a line that has no gap touches nothing', () => {
      const gas = line('gas', ROUTE);
      expect(closeDrawnRefrigerantGaps([gas], [drawnOn(gas, [{ x: 6000, y: 4000 }], 'end', null)])).toBeNull();
    });
  });

  it('a clash the line already had elsewhere does not stop it being put back; a clash in the gap does', () => {
    // A duct-free stand-in: another pipe crossing the first part (a clash that stays whatever is done to the gap).
    const crossing = line('crossing', [{ x: 1000, y: -500, z: Z }, { x: 1000, y: 500, z: Z }], { lineKind: 'liquid' });
    const { after, gapId } = cutMiddle([line('gas', ROUTE), crossing]);
    expect(proposeRefrigerantGap(after, gapId).candidates[0]?.key).toBe('as-before');
    // A pipe laid across the gap after the delete: the stretch as it was would clash with it.
    const inGap = line('in-gap', [{ x: 1500, y: 2000, z: Z }, { x: 2500, y: 2000, z: Z }], { lineKind: 'liquid' });
    expect(proposeRefrigerantGap([...after, inGap], gapId).candidates.map((candidate) => candidate.key)).not.toContain('as-before');
  });

  it('a gap no longer open says so', () => {
    expect(proposeRefrigerantGap([line('gas', ROUTE)], 'gap-x').reason).toMatch(/no longer open/);
  });
});
