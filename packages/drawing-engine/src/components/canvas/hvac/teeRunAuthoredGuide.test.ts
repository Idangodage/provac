import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { buildTeeRunHalves } from './branchKitProposal';
import { normalizePipeRouteNodes3d, splitPipeRoute3dAtPlanInterval } from './pipeRoute3d';
import { splitPolylineAtStation } from './pipeTopology';
import { buildRefrigerantPipeElements, buildRefrigerantPipePhysicalPath, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

const point = (x: number, y: number): Point2D => ({ x, y });
const originalGuide = [point(0, 0), point(600, 0), point(600, -800), point(5000, -800), point(5000, -2000)];
function fixture(reverse = false) {
  const guide = reverse ? [...originalGuide].reverse() : originalGuide;
  return buildRefrigerantPipeElements(guide, { bendRadiusFactor: 1 }).map((built, index) => {
    const route = resolveRefrigerantPipeSpec(built.properties!).routePoints;
    return { ...built, id: `guide-${index}`, properties: { ...built.properties,
      routeNodes3d: route.map(node => ({ ...node, z: 2200 })) } } as HvacElement;
  });
}
function faces(run: HvacElement, flip = false) {
  const route = resolveRefrigerantPipeSpec(run.properties).routePoints;
  const middle = route.find((p, index) => {
    const next = route[index + 1];
    return next && Math.abs(p.y - next.y) < 1e-6 && Math.min(p.x, next.x) < 2800 && Math.max(p.x, next.x) > 3200;
  })!;
  expect(middle).toBeDefined();
  const left = point(2800, middle.y); const right = point(3200, middle.y);
  return { station: point(3000, middle.y), inletPoint: flip ? right : left, runOutletPoint: flip ? left : right };
}
function bendCount(route: Point2D[]) {
  const directions = route.slice(1).map((p, i) => ({ x: p.x - route[i]!.x, y: p.y - route[i]!.y }));
  return directions.slice(1).filter((d, i) => Math.abs(d.x * directions[i]!.y - d.y * directions[i]!.x) > 1e-5).length;
}

describe('split pipe logical guide ownership', () => {
  it.each([false, true].flatMap(reverse => [false, true].map(flip => ({ reverse, flip }))))(
    'clips both fitting faces on paired lanes without changing physical geometry (reverse $reverse, flow flip $flip)', ({ reverse, flip }) => {
      for (const run of fixture(reverse)) {
        const source = structuredClone(run);
        const cut = faces(run, flip);
        const halves = buildTeeRunHalves(run, cut.station, 'guide-tee', cut)!;
        expect(halves).not.toBeNull();
        const unitHalf = halves.find(half => (half.properties.authoredCenterlineRoute as Point2D[])
          .some(p => p.x === 0 && p.y === 0))!;
        const distributionHalf = halves.find(half => half !== unitHalf)!;
        const unitGuide = unitHalf.properties.authoredCenterlineRoute as Point2D[];
        const distributionGuide = distributionHalf.properties.authoredCenterlineRoute as Point2D[];
        const expectedUnit = [point(0, 0), point(600, 0), point(600, -800), point(2800, -800)];
        const expectedDistribution = [point(3200, -800), point(5000, -800), point(5000, -2000)];
        expect(unitGuide).toEqual(reverse ? expectedUnit.reverse() : expectedUnit);
        expect(distributionGuide).toEqual(reverse ? expectedDistribution.reverse() : expectedDistribution);
        expect(bendCount(unitGuide)).toBe(2);
        expect(bendCount(distributionGuide)).toBe(1);

        const physical = resolveRefrigerantPipeSpec(run.properties).routePoints;
        const split3d = splitPipeRoute3dAtPlanInterval(physical, normalizePipeRouteNodes3d(run.properties.routeNodes3d), cut.inletPoint, cut.runOutletPoint)!;
        for (const half of halves) {
          const route = resolveRefrigerantPipeSpec(half.properties).routePoints;
          const beginsAtSourceStart = Math.hypot(route[0]!.x - physical[0]!.x, route[0]!.y - physical[0]!.y) < 1e-6;
          const endpoint = beginsAtSourceStart ? route.at(-1)! : route[0]!;
          const expected = splitPolylineAtStation(physical, endpoint)!;
          expect(route).toEqual(beginsAtSourceStart ? expected.before : expected.after);
          expect(normalizePipeRouteNodes3d(half.properties.routeNodes3d)).toEqual(beginsAtSourceStart ? split3d.before : split3d.after);
          // Marker presence controls paired-lane rendering; clipping its data
          // must not respline or change any already authored physical point.
          const previousMetadata = { ...half, properties: { ...half.properties, authoredCenterlineRoute: source.properties.authoredCenterlineRoute } };
          expect(buildRefrigerantPipePhysicalPath(half)).toEqual(buildRefrigerantPipePhysicalPath(previousMetadata));
        }
        expect(run).toEqual(source);
      }
    });

  it.each([[], [{}], [point(0, 0), { x: NaN, y: 0 }], [point(99999, 99999), point(100000, 99999)]].map(raw => ({ raw })))(
    'retains the paired-lane marker with a clipped physical fallback for an unusable guide %#', ({ raw }) => {
      const original = fixture()[0]!;
      const run = { ...original, properties: { ...original.properties, authoredCenterlineRoute: raw } };
      const snapshot = structuredClone(run);
      const cut = faces(run);
      const halves = buildTeeRunHalves(run, cut.station, 'fallback-guide', cut)!;
      expect(halves).not.toBeNull();
      for (const half of halves) {
        expect(half.properties.authoredCenterlineRoute).toEqual(resolveRefrigerantPipeSpec(half.properties).routePoints);
        expect(Array.isArray(half.properties.authoredCenterlineRoute)).toBe(true);
      }
      expect(run).toEqual(snapshot);
    });

  it('keeps standalone pipes without a derived-lane marker', () => {
    const run = fixture()[0]!;
    delete run.properties.authoredCenterlineRoute;
    const cut = faces(run);
    const halves = buildTeeRunHalves(run, cut.station, 'plain-guide', cut)!;
    expect(halves).not.toBeNull();
    expect(halves.every(half => half.properties.authoredCenterlineRoute === undefined)).toBe(true);
  });
});
