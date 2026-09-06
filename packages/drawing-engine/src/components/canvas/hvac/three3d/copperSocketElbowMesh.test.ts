import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { disposeObject3DResources } from '../../threeResourceLifecycle';
import type { CopperSocketElbowPlacement } from '../copperSocketElbowRoute';
import { compileCopperSocketElbowRoute } from '../copperSocketElbowRoute';

import { buildCopperSocketElbowMesh } from './copperSocketElbowMesh';

const point = (x: number, y: number, z = 0) => ({ x, y, z });
const vector = (p: { x: number; y: number; z: number }): THREE.Vector3 => new THREE.Vector3(p.x, p.y, p.z);

function fixture(angleDeg: 45 | 90, overlappingSocket = false): CopperSocketElbowPlacement {
  const angle = angleDeg * Math.PI / 180;
  const radius = overlappingSocket ? 27 : 24;
  const centerToFace = overlappingSocket ? 38 : 40;
  const insertionDepth = 12;
  const setback = radius * Math.tan(angle / 2);
  const corner = point(0, 0, 2450);
  const entry = point(-setback, 0, 2450);
  const center = point(-setback, radius, 2450);
  const exit = point(Math.cos(angle) * setback, Math.sin(angle) * setback, 2450);
  const startDirection = point(1, 0); const endDirection = point(Math.cos(angle), Math.sin(angle));
  const startFace = point(-centerToFace, 0, 2450);
  const endFace = point(Math.cos(angle) * centerToFace, Math.sin(angle) * centerToFace, 2450);
  return { id: 'elbow-mesh-test', corner, entry, center, exit, startDirection, endDirection,
    normal: point(0, 0, 1), startFace, endFace,
    startStop: point(-centerToFace + insertionDepth, 0, 2450),
    endStop: point(Math.cos(angle) * (centerToFace - insertionDepth), Math.sin(angle) * (centerToFace - insertionDepth), 2450),
    path: [startFace, entry, exit, endFace],
    spec: { id: 'dimension-fixture', angleDeg, tubeOutsideDiameterMm: 15.88,
      socketInsideDiameterMm: 15.95, socketOutsideDiameterMm: 17.55,
      bodyOutsideDiameterMm: 15.88, bodyInsideDiameterMm: 14.28,
      centerlineRadiusMm: radius, centerToFaceMm: centerToFace, insertionDepthMm: insertionDepth,
      wallThicknessMm: 0.8, sourceUrl: 'https://example.com/dimension-fixture' } };
}

function mesh(group: THREE.Group, role = 'fitting'): THREE.Mesh {
  return group.children.find(child => child instanceof THREE.Mesh && child.userData.pipeSurfaceRole === role) as THREE.Mesh;
}

function expectClosedManifold(geometry: THREE.BufferGeometry): void {
  const index = geometry.getIndex()!;
  const counts = new Map<string, number>();
  for (let start = 0; start < index.count; start += 3) {
    const triangle = [index.getX(start), index.getX(start + 1), index.getX(start + 2)];
    for (let edge = 0; edge < 3; edge += 1) {
      const a = triangle[edge]!; const b = triangle[(edge + 1) % 3]!;
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  expect([...counts.values()].every(count => count === 2), 'Every shell edge must belong to exactly two triangles').toBe(true);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i += 1) {
    expect([position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite)).toBe(true);
  }
}

describe('copper C x C socket elbow mesh', () => {
  it.each([{ angle: 45, tube: 12.7 }, { angle: 90, tube: 12.7 },
    { angle: 90, tube: 15.875 }, { angle: 90, tube: 6.35 }])('renders actual resolved catalogue geometry for $tube mm / $angle degrees', ({ angle, tube }) => {
    const radians = angle * Math.PI / 180;
    const compiled = compileCopperSocketElbowRoute([point(-500, 0, 2400), point(0, 0, 2400),
      point(500 * Math.cos(radians), 500 * Math.sin(radians), 2400)], tube);
    expect(compiled.issues).toHaveLength(0);
    expect(compiled.fittings).toHaveLength(1);
    const group = buildCopperSocketElbowMesh(compiled.fittings[0]!);
    expect(group.userData.geometryIssue).toBeUndefined();
    expect(group.userData.dimensionBasis).toBe('published');
    expectClosedManifold(mesh(group).geometry);
    expect(group.userData.insertionDepthMm).toBe(compiled.fittings[0]!.spec.insertionDepthMm);
    disposeObject3DResources(group);
  });

  it.each([45, 90] as const)('builds a hollow %i-degree elbow with two real mouths and insertion shoulders', angle => {
    const placement = fixture(angle);
    const snapshot = structuredClone(placement);
    const group = buildCopperSocketElbowMesh(placement, { lineKind: 'gas' });
    expect(group.children).toHaveLength(1);
    const copper = mesh(group);
    expect(copper).toBeInstanceOf(THREE.Mesh);
    expect(copper.userData.fittingType).toBe('copper-socket-elbow');
    expect(copper.userData.elbowAngleDeg).toBe(angle);
    expect(copper.userData.sourceUrl).toBe(placement.spec.sourceUrl);
    expectClosedManifold(copper.geometry);
    const positions = copper.geometry.getAttribute('position');
    let circularBodyVertices = 0;
    for (let index = 0; index < positions.count; index += 1) {
      const radial = new THREE.Vector3().fromBufferAttribute(positions, index).sub(vector(placement.center));
      const stationAngle = Math.atan2(radial.y, radial.x) * 180 / Math.PI + 90;
      if (stationAngle <= 10 || stationAngle >= angle - 10) continue;
      const radiusFromCenterline = Math.hypot(Math.hypot(radial.x, radial.y) - placement.spec.centerlineRadiusMm, radial.z);
      expect(Math.min(Math.abs(radiusFromCenterline - placement.spec.bodyOutsideDiameterMm / 2),
        Math.abs(radiusFromCenterline - placement.spec.bodyInsideDiameterMm / 2))).toBeLessThan(0.001);
      circularBodyVertices += 1;
    }
    expect(circularBodyVertices).toBeGreaterThan(32);
    const normal = vector(placement.normal);
    const boreRadius = placement.spec.bodyInsideDiameterMm / 2;
    const socketRadius = placement.spec.socketInsideDiameterMm / 2;
    const outerRadius = placement.spec.socketOutsideDiameterMm / 2;
    for (const [face, direction] of [[placement.startFace, placement.startDirection],
      [placement.endFace, point(-placement.endDirection.x, -placement.endDirection.y, -placement.endDirection.z)]] as const) {
      const inward = vector(direction);
      const outside = vector(face).addScaledVector(inward, -1);
      // The mouth's center is empty, with an uninterrupted socket bore to the
      // exact insertion stop. A solid cap would intersect at distance 1 mm.
      const boreRay = new THREE.Raycaster(outside, inward);
      expect(boreRay.intersectObject(copper).every(hit => hit.distance >= placement.spec.insertionDepthMm + 1 - 0.001)).toBe(true);
      const lipRay = new THREE.Raycaster(outside.clone().addScaledVector(normal, (socketRadius + outerRadius) / 2), inward);
      expect(lipRay.intersectObject(copper)[0]!.distance).toBeCloseTo(1, 3);
      const shoulderRay = new THREE.Raycaster(outside.clone().addScaledVector(normal, (socketRadius + boreRadius) / 2), inward);
      expect(shoulderRay.intersectObject(copper)[0]!.distance).toBeCloseTo(placement.spec.insertionDepthMm + 1, 3);
    }
    expect(placement).toEqual(snapshot);
    disposeObject3DResources(group);
  });

  it('preserves catalogue faces and insertion stops when a socket overlaps the nominal circle tangent', () => {
    const placement = fixture(90, true);
    const group = buildCopperSocketElbowMesh(placement);
    expect(group.userData.geometryIssue).toBeUndefined();
    expect(group.userData.transitionRepresentation).toBe('schematic-swage');
    expect(group.userData.socketFaces).toEqual({ start: placement.startFace, end: placement.endFace });
    expect(group.userData.insertionStops).toEqual({ start: placement.startStop, end: placement.endStop });
    expect(group.userData.centerlineRadiusMm).toBe(27);
    expect(group.userData.insertionDepthMm).toBe(12);
    expectClosedManifold(mesh(group).geometry);
    disposeObject3DResources(group);
  });

  it('uses a closed conservative jacket envelope when insulation is thicker than the catalogue bend radius', () => {
    const placement = fixture(90);
    const group = buildCopperSocketElbowMesh(placement, { showInsulation: true, insulationThicknessMm: 35, lineKind: 'liquid' });
    expect(group.children).toHaveLength(2);
    const copper = mesh(group); const cover = mesh(group, 'fitting-insulation');
    expect(cover.userData.representation).toBe('conservative-cover-envelope');
    expectClosedManifold(cover.geometry);
    expectClosedManifold(copper.geometry);
    expect((cover.material as THREE.MeshStandardMaterial).color.getHexString()).toBe('bc863f');
    // A convex envelope has every surface point on/inside every outward face
    // plane. This rules out the inward-folded spindle torus of a thick sweep.
    const positions = cover.geometry.getAttribute('position'); const indices = cover.geometry.getIndex()!;
    let largestOutsideDistance = 0;
    for (let triangle = 0; triangle < indices.count; triangle += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(triangle));
      const b = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(triangle + 1));
      const c = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(triangle + 2));
      const faceNormal = b.sub(a).cross(c.sub(a)).normalize();
      for (let i = 0; i < positions.count; i += 1) {
        largestOutsideDistance = Math.max(largestOutsideDistance,
          new THREE.Vector3().fromBufferAttribute(positions, i).sub(a).dot(faceNormal));
      }
    }
    expect(largestOutsideDistance).toBeLessThan(0.003);
    expect(copper.userData.centerlineRadiusMm).toBe(24);
    disposeObject3DResources(group);
  });

  it('renders no insulation unless explicitly requested and follows arbitrary 3D placement', () => {
    const placement = fixture(45);
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, -0.3, 1.1));
    const offset = new THREE.Vector3(1300, -450, 600);
    const transformPoint = (p: { x: number; y: number; z: number }) => {
      const result = vector(p).applyQuaternion(rotation).add(offset);
      return point(result.x, result.y, result.z);
    };
    const transformDirection = (p: { x: number; y: number; z: number }) => {
      const result = vector(p).applyQuaternion(rotation);
      return point(result.x, result.y, result.z);
    };
    const rotated: CopperSocketElbowPlacement = { ...placement,
      corner: transformPoint(placement.corner), center: transformPoint(placement.center),
      entry: transformPoint(placement.entry), exit: transformPoint(placement.exit),
      startFace: transformPoint(placement.startFace), endFace: transformPoint(placement.endFace),
      startStop: transformPoint(placement.startStop), endStop: transformPoint(placement.endStop),
      startDirection: transformDirection(placement.startDirection), endDirection: transformDirection(placement.endDirection),
      normal: transformDirection(placement.normal), path: placement.path.map(transformPoint) };
    const originalGroup = buildCopperSocketElbowMesh(placement);
    const rotatedGroup = buildCopperSocketElbowMesh(rotated, { insulationThicknessMm: 35, showInsulation: false });
    expect(rotatedGroup.children).toHaveLength(1);
    const original = mesh(originalGroup).geometry.getAttribute('position');
    const transformed = mesh(rotatedGroup).geometry.getAttribute('position');
    expect(transformed.count).toBe(original.count);
    for (let index = 0; index < original.count; index += 1) {
      const expected = new THREE.Vector3().fromBufferAttribute(original, index).applyQuaternion(rotation).add(offset);
      expect(expected.distanceTo(new THREE.Vector3().fromBufferAttribute(transformed, index))).toBeLessThan(0.0003);
    }
    disposeObject3DResources(originalGroup); disposeObject3DResources(rotatedGroup);
  });

  it('does not manufacture geometry from inconsistent or non-finite dimensions', () => {
    const placement = fixture(90);
    placement.spec.centerlineRadiusMm = 40;
    const inconsistent = buildCopperSocketElbowMesh(placement);
    expect(inconsistent.children).toHaveLength(0);
    expect(inconsistent.userData.geometryIssue).toBeTruthy();
    const invalid = fixture(45);
    invalid.startFace.x = Number.NaN;
    expect(buildCopperSocketElbowMesh(invalid).children).toHaveLength(0);
  });
});
