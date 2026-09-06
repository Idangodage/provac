import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import { liftPipePlanRouteTo3d, normalizePipeRouteNodes3d, projectPipeRouteNodes3dForPlanEdit, splitPipeRoute3dAtPlanInterval, type PipeRouteNode3D as Node } from './pipeRoute3d';

// Frozen linear-search reference for the station calculations optimized in
// September 2026. Keep the original arithmetic and tie predicates here: a
// tolerance-only assertion would miss a change to the selected route station.
function metrics(path: readonly Point2D[]) {
  const cumulative = [0]; let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
    cumulative.push(total);
  }
  return { cumulative, total };
}
function closest(point: Point2D, path: readonly Point2D[], m: ReturnType<typeof metrics>, fallback: number) {
  if (path.length <= 1 || m.total <= 1e-9) return Math.max(0, Math.min(1, fallback));
  let bestDistance = Infinity; let bestStation = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!; const b = path[i]!;
    const dx = b.x - a.x; const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const t = squared <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared));
    const x = a.x + dx * t; const y = a.y + dy * t;
    const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
    const station = (m.cumulative[i - 1]! + Math.sqrt(squared) * t) / m.total;
    if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && station < bestStation)) {
      bestDistance = distance; bestStation = station;
    }
  }
  return bestStation;
}
function at(path: readonly Point2D[], m: ReturnType<typeof metrics>, station: number): Point2D {
  if (!path.length) return { x: 0, y: 0 };
  if (path.length === 1 || m.total <= 1e-9) return { ...path[0]! };
  const target = Math.max(0, Math.min(1, station)) * m.total;
  for (let i = 1; i < path.length; i += 1) {
    const start = m.cumulative[i - 1]!; const end = m.cumulative[i]!;
    if (target > end && i < path.length - 1) continue;
    const a = path[i - 1]!; const b = path[i]!; const length = end - start;
    const t = length <= 1e-9 ? 0 : Math.max(0, Math.min(1, (target - start) / length));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return { ...path.at(-1)! };
}
type Stationed = Array<{ station: number; node: Node; order: number }>;
function zAt(nodes: Stationed, station: number) {
  if (!nodes.length) return 0;
  const first = nodes[0]!; const last = nodes.at(-1)!;
  if (station <= first.station) return first.node.z;
  if (station >= last.station) return last.node.z;
  let left = first;
  for (let i = 1; i < nodes.length; i += 1) {
    const right = nodes[i]!;
    if (right.station <= station) { left = right; continue; }
    const span = right.station - left.station;
    if (span <= 1e-9) return right.node.z;
    const t = (station - left.station) / span;
    return left.node.z + (right.node.z - left.node.z) * t;
  }
  return last.node.z;
}
function stationed(path: readonly Point2D[], guide: readonly Node[], pinEnds: boolean): Stationed {
  const m = metrics(path); let previous = 0;
  return guide.map((node, i) => {
    const station = pinEnds && i === 0 ? 0 : pinEnds && i === guide.length - 1 ? 1
      : Math.max(previous, closest(node, path, m, guide.length <= 1 ? 0 : i / (guide.length - 1)));
    previous = station;
    return { station, node: { ...node }, order: i };
  });
}
function legacyLift(path: readonly Point2D[], guide: readonly Node[]): Node[] {
  if (!guide.length) return [];
  if (!path.length) return guide.map(node => ({ ...node }));
  const m = metrics(path);
  if (m.total <= 1e-9) return guide.map(node => ({ ...path[0]!, z: node.z }));
  const stations = stationed(path, guide, true);
  const entries = stations.map(({ station, node, order }) => ({ station, order, node: { ...at(path, m, station), z: node.z } }));
  path.forEach((point, i) => {
    const station = m.cumulative[i]! / m.total;
    if (stations.some(entry => Math.abs(entry.station - station) <= 1e-8)) return;
    entries.push({ station, order: guide.length + i, node: { ...point, z: zAt(stations, station) } });
  });
  entries.sort((a, b) => a.station - b.station || a.order - b.order);
  const nodes = entries.map(entry => entry.node);
  return nodes.filter((node, i) => !i || Math.hypot(node.x - nodes[i - 1]!.x, node.y - nodes[i - 1]!.y, node.z - nodes[i - 1]!.z) > 1e-8);
}
function coordinateDedupe(nodes: Node[]): Node[] {
  return nodes.reduce<Node[]>((result, node) => {
    const previous = result.at(-1);
    if (!previous || !(Math.abs(previous.x - node.x) <= 1e-8 && Math.abs(previous.y - node.y) <= 1e-8 && Math.abs(previous.z - node.z) <= 1e-8)) result.push(node);
    return result;
  }, []);
}
function legacyEdit(previous: readonly Point2D[], next: readonly Point2D[], guide: readonly Node[]): Node[] {
  if (!guide.length || !next.length) return [];
  if (guide.length === previous.length && previous.length === next.length) return guide.map((node, i) => ({ ...next[i]!, z: node.z }));
  const m = metrics(next); const stations = stationed(previous, guide, false);
  const entries = stations.map(({ station, node, order }) => ({ station, order, source: 0, node: { ...at(next, m, station), z: node.z } }));
  next.forEach((point, i) => {
    const station = m.total <= 1e-9 ? 0 : m.cumulative[i]! / m.total;
    if (stations.some(entry => Math.abs(entry.station - station) <= 1e-8)) return;
    entries.push({ station, order: i, source: 1, node: { ...point, z: zAt(stations, station) } });
  });
  entries.sort((a, b) => a.station - b.station || a.source - b.source || a.order - b.order);
  return coordinateDedupe(entries.map(entry => entry.node));
}
function legacySplit(path: readonly Point2D[], guide: readonly Node[], first: Point2D, second: Point2D) {
  if (path.length < 2 || guide.length < 2) return null;
  const m = metrics(path); if (m.total <= 1e-9) return null;
  const stations = stationed(path, guide, false);
  const firstCutStation = closest(first, path, m, 0); const secondCutStation = closest(second, path, m, 1);
  const lower = Math.min(firstCutStation, secondCutStation); const upper = Math.max(firstCutStation, secondCutStation);
  const firstCutNode = { ...at(path, m, firstCutStation), z: zAt(stations, firstCutStation) };
  const secondCutNode = { ...at(path, m, secondCutStation), z: zAt(stations, secondCutStation) };
  return {
    before: coordinateDedupe([...stations.filter(entry => entry.station < lower - 1e-8).sort((a, b) => a.station - b.station || a.order - b.order).map(entry => entry.node), firstCutStation <= secondCutStation ? firstCutNode : secondCutNode]),
    after: coordinateDedupe([firstCutStation <= secondCutStation ? secondCutNode : firstCutNode, ...stations.filter(entry => entry.station > upper + 1e-8).sort((a, b) => a.station - b.station || a.order - b.order).map(entry => entry.node)]),
    firstCutStation, secondCutStation, firstCutNode, secondCutNode,
  };
}

const p = (x: number, y = 0, z = 0): Node => ({ x, y, z });
const longRoute = Array.from({ length: 160 }, (_, index) => p(index * 100, Math.floor(index / 16) % 2 * 500));
const fixtures = [
  { name: 'separated contiguous projection blocks', path: longRoute, guide: longRoute.filter((_, index) => index % 7 === 0 || index === longRoute.length - 1).map((node, index) => ({ ...node, z: index * 100 })) },
  { name: 'rounded computed span endpoint across a block boundary',
    path: [...Array.from({ length: 16 }, (_, index) => p(0.25 + index * 0.001)), p(1e16), ...Array.from({ length: 17 }, (_, index) => p(index + 1))],
    guide: [p(0.25), p(0, 0, 1000), p(17, 0, 2000)] },
  { name: 'nonfinite guide query on a blocked route', path: longRoute, guide: [longRoute[0]!, p(NaN, 0, 1200), longRoute.at(-1)!] },
  { name: 'overflowing spans across several projection blocks', path: [...longRoute.slice(0, 32), p(-1e308), p(1e308), ...longRoute.slice(32)], guide: [longRoute[0]!, p(100, 0, 700), longRoute.at(-1)!] },
  { name: 'equal-station vertical risers', path: [p(0), p(500), p(500), p(1500)], guide: [p(0, 0, 800), p(500, 0, 800), p(500, 0, 2200), p(1500, 0, 2200)] },
  { name: 'self-crossing route and reversed guide queries', path: [p(0), p(1000), p(1000, 1000), p(0, 1000), p(0), p(1000)], guide: [p(0), p(750, 750, 500), p(500, 0, 1000), p(0, 500, 1500), p(1000, 0, 2000)] },
  { name: 'very short and zero-length spans', path: [p(0), p(0), p(1e-10), p(1e-8), p(500), p(500)], guide: [p(0), p(1e-10, 0, 10), p(500, 0, 20)] },
  { name: 'empty plan', path: [], guide: [p(0), p(200, 0, 500)] },
  { name: 'vertical-only guide', path: [p(0), p(0)], guide: [p(0), p(0, 0, 500), p(0, 0, 900)] },
  { name: 'overflow falls back to legacy scans', path: [p(-1e308), p(1e308), p(1e308, 1e308)], guide: [p(-1e308), p(0, 0, 500), p(1e308, 1e308, 1000)] },
  ...[-1e-15, 0, 1e-15].map(delta => ({ name: `station tolerance boundary ${delta}`, path: [p(0), p(500), p(1000)], guide: [p(0), p(500 + (1e-8 + delta) * 1000, 0, 800), p(1000, 0, 2000)] })),
];

describe('pipe route station optimization exact parity', () => {
  it('normalizes sparse and invalid route data without changing values or retaining input point objects', () => {
    const input: unknown[] = new Array(4);
    input[1] = p(-0, 1, 2);
    input.push(null, false, 17, '3', {}, { x: '0', y: 0, z: 0 }, p(NaN), p(1, 2, Infinity), p(3, 4, 5));
    const legacy = input.flatMap(candidate => {
      if (!candidate || typeof candidate !== 'object') return [];
      const node = candidate as Node;
      return [node.x, node.y, node.z].every(value => typeof value === 'number' && Number.isFinite(value))
        ? [{ x: node.x, y: node.y, z: node.z }] : [];
    });
    const result = normalizePipeRouteNodes3d(input);
    expect(result).toStrictEqual(legacy);
    expect(result).toStrictEqual([p(-0, 1, 2), p(3, 4, 5)]);
    expect(result[0]).not.toBe(input[1]);
    expect(normalizePipeRouteNodes3d({ 0: p(0), length: 1 })).toEqual([]);
  });

  it.each(fixtures)('preserves $name', ({ path, guide }) => {
    expect(liftPipePlanRouteTo3d(path, guide)).toStrictEqual(legacyLift(path, guide));
    const next = [...path, p(2400, 1800)];
    expect(projectPipeRouteNodes3dForPlanEdit(path, next, guide)).toStrictEqual(legacyEdit(path, next, guide));
    expect(splitPipeRoute3dAtPlanInterval(path, guide, p(300, 80), p(800, 80))).toStrictEqual(legacySplit(path, guide, p(300, 80), p(800, 80)));
  });

  it('matches the linear reference across deterministic translated and rotated route samples', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ x: fc.integer({ min: -3000, max: 3000 }), y: fc.integer({ min: -3000, max: 3000 }), z: fc.integer({ min: -500, max: 3500 }) }), { minLength: 2, maxLength: 96 }),
      fc.constantFrom(0, 90, 180, 270), fc.constantFrom(0, 1e9, -1e9),
      (source, rotation, offset) => {
        const angle = rotation * Math.PI / 180;
        const path = source.map(node => p(node.x * Math.cos(angle) - node.y * Math.sin(angle) + offset, node.x * Math.sin(angle) + node.y * Math.cos(angle) - offset, node.z));
        const guide = path.filter((_, i) => i % 2 === 0 || i === path.length - 1);
        const next = [...path, p(offset + 3800, -offset + 1700)];
        expect(liftPipePlanRouteTo3d(path, guide)).toStrictEqual(legacyLift(path, guide));
        expect(projectPipeRouteNodes3dForPlanEdit(path, next, guide)).toStrictEqual(legacyEdit(path, next, guide));
        expect(splitPipeRoute3dAtPlanInterval(path, guide, path[0]!, path.at(-1)!)).toStrictEqual(legacySplit(path, guide, path[0]!, path.at(-1)!));
      },
    ), { seed: 260908, numRuns: 128 });
  });
});
