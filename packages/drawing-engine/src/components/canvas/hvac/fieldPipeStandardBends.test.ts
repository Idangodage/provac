import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { buildCircularFieldPipeSegments, resolveFieldPipeBends } from './fieldPipeBends';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipeVisual } from './refrigerantPipePairModel';
import { buildHvacElementMesh } from './three3d/buildHvacElementMesh';

const OUTER_DIAMETER_MM = 75;
const BEND_FACTOR = 2;
const RADIUS_MM = OUTER_DIAMETER_MM * BEND_FACTOR;
const TOLERANCE = 1e-5;

function singlePipe(routePoints: Point2D[]): HvacElement {
  return { id: 'standalone-field-pipe', type: 'refrigerant-pipe', position: { x: 0, y: -100 },
    width: 2400, depth: 1800, height: OUTER_DIAMETER_MM, elevation: 2400, mountType: 'ceiling',
    rotation: 0, label: 'Gas pipe', supplyZoneRatio: 0,
    properties: { routePoints, lineKind: 'gas', pipeDiameterMm: 15.875, outerDiameterMm: OUTER_DIAMETER_MM,
      insulationThicknessMm: 25.4, bendRadiusFactor: BEND_FACTOR,
      fieldBendConstruction: 'formed-tube',
      segmentMaterials: routePoints.slice(1).map(() => 'flexible') } };
}
function distance(a: Point2D, b: Point2D): number { return Math.hypot(a.x - b.x, a.y - b.y); }

/** The expected geometry is calculated analytically from the authored legs,
 * independently of the production fitting/sampling helper. */
function expectCircularTurn(points: Point2D[], route: Point2D[], turnDegrees: number, radius = RADIUS_MM, tolerance = TOLERANCE): void {
  const [start, corner, end] = route as [Point2D, Point2D, Point2D];
  const sign = Math.sign(turnDegrees);
  const radians = Math.abs(turnDegrees) * Math.PI / 180;
  const tangentSetback = radius * Math.tan(radians / 2);
  const tangentStart = { x: corner.x - tangentSetback, y: corner.y };
  const direction = { x: Math.cos(radians), y: sign * Math.sin(radians) };
  const tangentEnd = { x: corner.x + direction.x * tangentSetback, y: corner.y + direction.y * tangentSetback };
  const center = { x: tangentStart.x, y: corner.y + sign * radius };
  expect(distance(points[0]!, start)).toBeLessThanOrEqual(tolerance);
  expect(distance(points.at(-1)!, end)).toBeLessThanOrEqual(tolerance);
  let arcSamples = 0;
  for (const point of points) {
    const onIncoming = Math.abs(point.y - start.y) <= tolerance && point.x <= tangentStart.x + tolerance;
    const fromEnd = { x: point.x - tangentEnd.x, y: point.y - tangentEnd.y };
    const onOutgoing = Math.abs(fromEnd.x * direction.y - fromEnd.y * direction.x) <= tolerance
      && fromEnd.x * direction.x + fromEnd.y * direction.y >= -tolerance;
    const onArc = Math.abs(distance(point, center) - radius) <= tolerance
      && point.x >= tangentStart.x - tolerance && point.x <= tangentEnd.x + tolerance
      && sign * (point.y - corner.y) >= -tolerance && sign * (point.y - tangentEnd.y) <= tolerance;
    expect(onIncoming || onOutgoing || onArc, `Point ${JSON.stringify(point)} leaves the straight legs or the ${turnDegrees}° circle`).toBe(true);
    if (onArc && !onIncoming && !onOutgoing) arcSamples += 1;
  }
  expect(arcSamples, 'The fitted elbow must contain a resolved circular arc, not a sharp miter').toBeGreaterThanOrEqual(8);
  expect(points.some(point => distance(point, tangentStart) <= tolerance)).toBe(true);
  expect(points.some(point => distance(point, tangentEnd) <= tolerance)).toBe(true);
}

function meshRings(pipe: HvacElement): { center: THREE.Vector3; normal: THREE.Vector3; radii: number[] }[] {
  const group = buildHvacElementMesh(pipe, { allElements: [pipe] })!;
  let insulation: THREE.Mesh | undefined;
  group.traverse(object => { if (object instanceof THREE.Mesh && object.userData.pipeSurfaceRole === 'insulation') insulation = object; });
  expect(insulation).toBeDefined();
  const positions = insulation!.geometry.getAttribute('position');
  const radialSegments = 24;
  // TubeGeometry has one duplicate seam vertex per ring, then two CircleGeometry
  // caps with a center and a duplicate seam vertex each. Both sockets are closed.
  const tubeVertexCount = positions.count - 2 * (radialSegments + 2);
  expect(tubeVertexCount % (radialSegments + 1)).toBe(0);
  const rings: { center: THREE.Vector3; normal: THREE.Vector3; radii: number[] }[] = [];
  for (let start = 0; start < tubeVertexCount; start += radialSegments + 1) {
    const points = Array.from({ length: radialSegments }, (_, index) => new THREE.Vector3().fromBufferAttribute(positions, start + index));
    const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / radialSegments);
    const normal = points[0]!.clone().sub(center).cross(points[radialSegments / 4]!.clone().sub(center)).normalize();
    rings.push({ center, normal, radii: points.map(point => point.distanceTo(center)) });
  }
  group.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  return rings;
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('standalone field pipe bend geometry', () => {
  it.each([90, 45, -45])('uses a constant-radius %s° turn with truly straight adjoining runs', turnDegrees => {
    const radians = turnDegrees * Math.PI / 180;
    const route = [{ x: 0, y: 0 }, { x: 1200, y: 0 },
      { x: 1200 + Math.cos(radians) * 1400, y: Math.sin(radians) * 1400 }];
    const pipe = singlePipe(route);
    const snapshot = structuredClone(pipe);
    const visual = buildRefrigerantPipeVisual(pipe);
    expect(pipe.properties.bundleId).toBeUndefined();
    expect(pipe.properties.authoredCenterlineRoute).toBeUndefined();
    expectCircularTurn(visual.continuousOuterPoints, route, turnDegrees);
    expect(pipe).toEqual(snapshot);
  });

  it('keeps actual unit socket straights before and after the circular field elbow', () => {
    const route = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 1400 }];
    const pipe = singlePipe(route);
    pipe.properties.startConnection = { portPoint: route[0], direction: { x: 1, y: 0 }, elevationMm: 2400,
      connectionKind: 'unit-port', sourceElementId: 'indoor-start' };
    pipe.properties.endConnection = { portPoint: route.at(-1), direction: { x: 0, y: -1 }, elevationMm: 2400,
      connectionKind: 'unit-port', sourceElementId: 'indoor-end' };
    const visual = buildRefrigerantPipeVisual(pipe);
    expectCircularTurn(visual.continuousOuterPoints, route, 90);
    const points = visual.continuousOuterPoints;
    const firstTurn = points.find(point => Math.abs(point.y) > TOLERANCE)!;
    const finalTurn = [...points].reverse().find(point => Math.abs(point.x - 500) > TOLERANCE)!;
    expect(firstTurn.x).toBeGreaterThanOrEqual(DEFAULT_PIPE_ROUTING_SETTINGS.minimumPortStubMm);
    expect(1400 - finalTurn.y).toBeGreaterThanOrEqual(DEFAULT_PIPE_ROUTING_SETTINGS.minimumPortStubMm);
    const expected = structuredClone(points);
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 6 });
    expect(buildRefrigerantPipeVisual(pipe).continuousOuterPoints).toEqual(expected);
  });

  it.each([{ turn: 90, authored: false }, { turn: 45, authored: false },
    { turn: 90, authored: true }, { turn: 45, authored: true }])('sweeps a circular $turn° field bend without extra curvature (authored levels: $authored)', ({ turn, authored }) => {
    const radians = turn * Math.PI / 180;
    const route = [{ x: 0, y: 0 }, { x: 1200, y: 0 },
      { x: 1200 + Math.cos(radians) * 1400, y: Math.sin(radians) * 1400 }];
    const pipe = singlePipe(route);
    const z = pipe.elevation + OUTER_DIAMETER_MM / 2;
    if (authored) pipe.properties.routeNodes3d = route.map(point => ({ ...point, z }));
    const snapshot = structuredClone(pipe);
    const rings = meshRings(pipe);
    expectCircularTurn(rings.map(ring => ring.center), route, turn, RADIUS_MM, 0.005);
    const setback = RADIUS_MM * Math.tan(radians / 2);
    const circleCenter = new THREE.Vector3(1200 - setback, RADIUS_MM, z);
    const tangentStart = new THREE.Vector3(1200 - setback, 0, z);
    const tangentEnd = new THREE.Vector3(1200 + Math.cos(radians) * setback, Math.sin(radians) * setback, z);
    for (const ring of rings) {
      expect(ring.center.z).toBeCloseTo(z, 3);
      for (const radius of ring.radii) expect(radius).toBeCloseTo(OUTER_DIAMETER_MM / 2, 2);
      const onCircle = Math.abs(ring.center.distanceTo(circleCenter) - RADIUS_MM) < 0.005;
      const tangent = onCircle ? new THREE.Vector3(-(ring.center.y - circleCenter.y), ring.center.x - circleCenter.x, 0).normalize()
        : ring.center.x < tangentStart.x ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(Math.cos(radians), Math.sin(radians), 0);
      expect(Math.abs(ring.normal.dot(tangent)), `Tube ring normal at ${ring.center.toArray().join(', ')} must match the actual tangent`).toBeGreaterThan(1 - 1e-6);
    }
    expect(rings.some(ring => ring.center.distanceTo(tangentStart) < 0.005)).toBe(true);
    expect(rings.some(ring => ring.center.distanceTo(tangentEnd) < 0.005)).toBe(true);
    expect(pipe).toEqual(snapshot);
  });

  it('reports insufficient fitting space instead of shrinking the specified radius', () => {
    const route = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 200 }, { x: 1200, y: 200 }];
    const bends = resolveFieldPipeBends(route, RADIUS_MM);
    expect(bends).toHaveLength(2);
    for (const bend of bends) {
      expect(bend.radiusMm).toBe(RADIUS_MM);
      expect(bend.fits).toBe(false);
    }
    const segments = buildCircularFieldPipeSegments(route, RADIUS_MM);
    expect(segments.every(segment => segment.invalidBend)).toBe(true);
    const visual = buildRefrigerantPipeVisual(singlePipe(route));
    expect(visual.invalidHardSegmentCount).toBeGreaterThan(0);
    expect(visual.continuousOuterPoints).toEqual(route);
    // With precisely 2R between the two quarter circles, both full-size bends
    // fit. This boundary used to be distorted by independently halving each leg.
    const fittingRoute = route.map(point => ({ ...point, y: point.y ? RADIUS_MM * 2 : 0 }));
    expect(resolveFieldPipeBends(fittingRoute, RADIUS_MM).every(bend => bend.fits && bend.radiusMm === RADIUS_MM)).toBe(true);
    expect(buildCircularFieldPipeSegments(fittingRoute, RADIUS_MM).every(segment => !segment.invalidBend)).toBe(true);
  });

  it('reports a short near-unit leg instead of bending inside the protected socket straight', () => {
    const route = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 1400 }];
    const pipe = singlePipe(route);
    pipe.properties.startConnection = { portPoint: route[0], direction: { x: 1, y: 0 }, elevationMm: 2400,
      connectionKind: 'unit-port', sourceElementId: 'indoor-start' };
    const visual = buildRefrigerantPipeVisual(pipe);
    expect(visual.invalidHardSegmentCount).toBeGreaterThan(0);
    expect(visual.continuousOuterPoints).toEqual(route);
    const fittingRoute = route.map(point => ({ ...point, x: point.x ? 350 : 0 }));
    const fittingPipe = singlePipe(fittingRoute);
    fittingPipe.properties.startConnection = pipe.properties.startConnection;
    const fittingVisual = buildRefrigerantPipeVisual(fittingPipe);
    expect(fittingVisual.invalidHardSegmentCount).toBe(0);
    expectCircularTurn(fittingVisual.continuousOuterPoints, fittingRoute, 90);
  });

  it('keeps a manual direction reversal unresolved instead of treating it as a valid straight pipe', () => {
    const route = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 100, y: 0 }];
    const bends = resolveFieldPipeBends(route, RADIUS_MM);
    expect(bends).toHaveLength(1);
    expect(bends[0]!.fits).toBe(false);
    expect(buildCircularFieldPipeSegments(route, RADIUS_MM).every(segment => segment.invalidBend)).toBe(true);
    const visual = buildRefrigerantPipeVisual(singlePipe(route));
    expect(visual.invalidHardSegmentCount).toBeGreaterThan(0);
    expect(visual.continuousOuterPoints).toEqual(route);
  });
});
