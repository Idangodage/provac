import { describe, expect, it } from 'vitest';

import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import type { PipeRouteNode3D as Node } from './pipeRoute3d';

const p = (x: number, y = 0, z = 0): Node => ({ x, y, z });
const close = (a: Node, b: Node) => { expect(a.x).toBeCloseTo(b.x, 5); expect(a.y).toBeCloseTo(b.y, 5); expect(a.z).toBeCloseTo(b.z, 5); };
function arcRoute(angle = Math.PI / 2, radius = 150): Node[] {
  const setback = radius * Math.tan(angle / 2); const cx = 500 - setback;
  const arc = Array.from({ length: 25 }, (_, i) => {
    const t = angle * i / 24;
    return p(cx + radius * Math.sin(t), radius - radius * Math.cos(t));
  });
  return [p(0), ...arc, p(500 + Math.cos(angle) * 500, Math.sin(angle) * 500)];
}

describe('physical copper socket elbow route compilation', () => {
  it('keeps exact hypot deduplication at component and diagonal tolerance boundaries', () => {
    const tolerance = 1e-5;
    for (const delta of [-1e-15, 0, 1e-15]) {
      for (const y of [0, tolerance / 2, tolerance / Math.SQRT2]) {
        const route = [p(0), p(tolerance + delta, y), p(0.001, 0.001), p(300)];
        const legacy: Node[] = [];
        for (const point of route) {
          const previous = legacy.at(-1);
          if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y, previous.z - point.z) > tolerance) legacy.push({ ...point });
        }
        // No standard corner is present: the compiler must retain precisely
        // the original tolerance decisions, including multi-axis distances.
        const result = compileCopperSocketElbowRoute(route, 15.875);
        expect(result.fittings).toEqual([]);
        expect(result.centerline).toStrictEqual(legacy);
      }
    }
  });

  it('cuts the copper tube at insertion stops and insulation at actual socket faces', () => {
    const result = compileCopperSocketElbowRoute([p(0), p(500), p(500, 500)], 15.875);
    expect(result.issues).toEqual([]); expect(result.fittings).toHaveLength(1);
    const fitting = result.fittings[0]!;
    expect(fitting.spec.catalogueModel).toBe('LD-15.88');
    close(fitting.corner, p(500)); close(fitting.center, p(473, 27));
    close(fitting.entry, p(473)); close(fitting.exit, p(500, 27));
    close(fitting.startFace, p(462)); close(fitting.endFace, p(500, 38));
    close(fitting.startStop, p(474)); close(fitting.endStop, p(500, 26));
    expect(result.pipeRuns).toHaveLength(2); expect(result.insulationRuns).toHaveLength(2);
    close(result.pipeRuns[0]!.at(-1)!, fitting.startStop); close(result.pipeRuns[1]![0]!, fitting.endStop);
    close(result.insulationRuns[0]!.at(-1)!, fitting.startFace); close(result.insulationRuns[1]![0]!, fitting.endFace);
    close(result.centerline[0]!, p(0)); close(result.centerline.at(-1)!, p(500, 500));
  });

  it('uses the 45-degree part takeoff rather than its radius as center-to-face length', () => {
    const result = compileCopperSocketElbowRoute([p(0), p(500), p(900, 400)], 9.525);
    expect(result.fittings).toHaveLength(1); expect(result.issues).toEqual([]);
    const fitting = result.fittings[0]!; expect(fitting.spec.angleDeg).toBe(45);
    close(fitting.startFace, p(487)); close(fitting.endFace, p(500 + 13 / Math.SQRT2, 13 / Math.SQRT2));
    close(fitting.entry, p(500 - 9.4 * Math.tan(Math.PI / 8)));
    close(fitting.startStop, p(495));
  });

  it.each(['xy', 'xz', 'oblique'])('recovers a sampled 90-degree bend once in the %s plane and remains idempotent', plane => {
    const rotate = (v: Node) => plane === 'xy' ? v : plane === 'xz' ? p(v.x, v.z, v.y)
      : p(v.x, (v.y - v.z) / Math.SQRT2, (v.y + v.z) / Math.SQRT2);
    const original = arcRoute().map(rotate);
    const first = compileCopperSocketElbowRoute(original, 15.875);
    expect(first.fittings).toHaveLength(1); expect(first.issues).toEqual([]);
    close(first.fittings[0]!.corner, rotate(p(500)));
    close(first.centerline[0]!, original[0]!); close(first.centerline.at(-1)!, original.at(-1)!);
    expect(first.fittings[0]!.spec.centerlineRadiusMm).toBe(27);
    const second = compileCopperSocketElbowRoute(first.centerline, 15.875);
    expect(second.fittings).toHaveLength(1); expect(second.issues).toEqual([]);
    expect(second.centerline).toHaveLength(first.centerline.length);
    second.centerline.forEach((point, index) => close(point, first.centerline[index]!));
  });

  it('places both vertical transition elbows with correct normals and unchanged terminals', () => {
    const route = [p(0), p(500), p(500, 0, 500), p(1000, 0, 500)];
    const result = compileCopperSocketElbowRoute(route, 9.525);
    expect(result.fittings).toHaveLength(2); expect(result.pipeRuns).toHaveLength(3);
    expect(result.issues).toEqual([]);
    close(result.fittings[0]!.normal, p(0, -1, 0)); close(result.fittings[1]!.normal, p(0, 1, 0));
    close(result.fittings[0]!.endStop, p(500, 0, 8)); close(result.fittings[1]!.startStop, p(500, 0, 492));
    close(result.centerline[0]!, route[0]!); close(result.centerline.at(-1)!, route.at(-1)!);
  });

  it('leaves arbitrary-angle sampled equipment gathers intact', () => {
    const route = arcRoute(Math.PI / 6);
    const result = compileCopperSocketElbowRoute(route, 15.875);
    expect(result.fittings).toEqual([]); expect(result.issues).toEqual([]);
    expect(result.centerline).toEqual(route); expect(result.pipeRuns).toEqual([route]);
  });

  it('does not convert a circle with a kinked approach into a claimed tangent fitting', () => {
    const route = arcRoute(); route[0] = p(0, 50);
    const result = compileCopperSocketElbowRoute(route, 15.875);
    expect(result.fittings).toEqual([]); expect(result.centerline).toEqual(route);
  });

  it('fits the field elbow after a tangent arbitrary-angle gather without changing the gather', () => {
    const angle = Math.PI / 6;
    const gather = Array.from({ length: 13 }, (_, index) => {
      const t = angle * index / 12;
      return p(100 * Math.sin(t), 100 * (1 - Math.cos(t)));
    });
    const entry = gather.at(-1)!;
    const center = p(entry.x - 150 * Math.sin(angle), entry.y + 150 * Math.cos(angle));
    const elbow = Array.from({ length: 25 }, (_, index) => {
      const t = angle + Math.PI / 2 * index / 24;
      return p(center.x + 150 * Math.sin(t), center.y - 150 * Math.cos(t));
    });
    const end = elbow.at(-1)!;
    const route = [p(-300), ...gather, ...elbow.slice(1), p(end.x - 250, end.y + 250 * Math.sqrt(3))];
    const result = compileCopperSocketElbowRoute(route, 15.875, { startStraightMm: 200 });
    expect(result.fittings).toHaveLength(1); expect(result.issues).toEqual([]);
    expect(result.centerline.slice(1, gather.length + 1)).toEqual(gather);
    close(result.fittings[0]!.corner, p(entry.x + 150 * Math.cos(angle), entry.y + 150 * Math.sin(angle)));
    expect(compileCopperSocketElbowRoute(result.centerline, 15.875).fittings).toHaveLength(1);
  });

  it('rejects both neighbouring elbows when their faces exceed the shared straight', () => {
    const route = [p(0), p(500), p(500, 70), p(1000, 70)];
    const result = compileCopperSocketElbowRoute(route, 15.875);
    expect(result.fittings).toEqual([]); expect(result.issues).toHaveLength(2);
    expect(result.centerline).toEqual(route); expect(result.pipeRuns).toEqual([route]);
  });

  it('retains a terminal approach that cannot fit its protected straight and the socket body', () => {
    const route = [p(0), p(100), p(100, 500)];
    const result = compileCopperSocketElbowRoute(route, 15.875, { startStraightMm: 80 });
    expect(result.fittings).toEqual([]); expect(result.issues).toHaveLength(1); expect(result.centerline).toEqual(route);
  });

  it('reports an unsupported tube size without inventing or scaling a fitting', () => {
    const route = [p(0), p(500), p(500, 500)];
    const result = compileCopperSocketElbowRoute(route, 200);
    expect(result.fittings).toEqual([]); expect(result.issues).toHaveLength(1); expect(result.centerline).toEqual(route);
  });

  it('retains the existing full-radius bend when a verified minimum excludes the available factory elbow', () => {
    const route = arcRoute();
    const result = compileCopperSocketElbowRoute(route, 15.875, { minimumBendRadiusMm: 150 });
    expect(result.fittings).toEqual([]); expect(result.issues).toHaveLength(1);
    expect(result.centerline).toEqual(route);
    expect(compileCopperSocketElbowRoute(route, 15.875, { minimumBendRadiusMm: 27 }).fittings).toHaveLength(1);
  });

  it('reports invalid coordinates without silently deleting an authored waypoint', () => {
    const route = [p(0), p(Number.NaN), p(500, 500)];
    const result = compileCopperSocketElbowRoute(route, 15.875);
    expect(result.issues).toHaveLength(1); expect(result.fittings).toEqual([]);
    expect(result.centerline).toEqual(route);
  });
});
