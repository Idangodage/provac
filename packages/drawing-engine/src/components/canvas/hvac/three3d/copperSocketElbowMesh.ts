import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { markObjectMaterialsOwned } from '../../threeResourceLifecycle';
import type { CopperSocketElbowPlacement } from '../copperSocketElbowRoute';

const EPSILON = 1e-6;
const RADIAL_SEGMENTS = 32;

export interface CopperSocketElbowMeshOptions {
  color?: string;
  insulationThicknessMm?: number;
  showInsulation?: boolean;
  lineKind?: 'gas' | 'liquid';
}

interface ProfileRing {
  center: THREE.Vector3;
  tangent: THREE.Vector3;
  outsideRadius: number;
  insideRadius: number;
}

const vector = (point: { x: number; y: number; z: number }): THREE.Vector3 =>
  new THREE.Vector3(point.x, point.y, point.z);

/** One indexed hollow shell: outer wall, continuous bore, insertion shoulders,
 * and annular mouths. There are no solid end disks or overlapping tube parts. */
function buildAnnularShell(rings: ProfileRing[], normal: THREE.Vector3): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) {
    const side = new THREE.Vector3().crossVectors(normal, ring.tangent).normalize();
    for (const radius of [ring.outsideRadius, ring.insideRadius]) {
      for (let index = 0; index < RADIAL_SEGMENTS; index += 1) {
        const angle = index * Math.PI * 2 / RADIAL_SEGMENTS;
        const point = ring.center.clone()
          .addScaledVector(side, Math.cos(angle) * radius)
          .addScaledVector(normal, Math.sin(angle) * radius);
        positions.push(point.x, point.y, point.z);
      }
    }
  }
  const at = (ring: number, inner: boolean, side: number): number =>
    ring * RADIAL_SEGMENTS * 2 + (inner ? RADIAL_SEGMENTS : 0) + side % RADIAL_SEGMENTS;
  const triangle = (a: number, b: number, c: number): void => {
    const pa = new THREE.Vector3().fromArray(positions, a * 3);
    const pb = new THREE.Vector3().fromArray(positions, b * 3);
    const pc = new THREE.Vector3().fromArray(positions, c * 3);
    // Repeated axial stations intentionally form the bore's annular shoulder.
    // Their identical outer rings have no surface between them.
    if (pb.sub(pa).cross(pc.sub(pa)).lengthSq() > 1e-14) indices.push(a, b, c);
  };
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let side = 0; side < RADIAL_SEGMENTS; side += 1) {
      for (const inner of [false, true]) {
        const a = at(ring, inner, side); const b = at(ring, inner, side + 1);
        const c = at(ring + 1, inner, side); const d = at(ring + 1, inner, side + 1);
        if (inner) { triangle(a, c, b); triangle(b, c, d); }
        else { triangle(a, b, c); triangle(b, d, c); }
      }
    }
  }
  for (const ring of [0, rings.length - 1]) {
    for (let side = 0; side < RADIAL_SEGMENTS; side += 1) {
      const outer = at(ring, false, side); const nextOuter = at(ring, false, side + 1);
      const inner = at(ring, true, side); const nextInner = at(ring, true, side + 1);
      if (ring === 0) { triangle(outer, inner, nextOuter); triangle(nextOuter, inner, nextInner); }
      else { triangle(outer, nextOuter, inner); triangle(nextOuter, nextInner, inner); }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const welded = mergeVertices(geometry, 1e-5);
  if (welded !== geometry) geometry.dispose();
  welded.computeVertexNormals();
  welded.computeBoundingBox();
  welded.computeBoundingSphere();
  return welded;
}

/** Render a resolved C x C elbow without choosing a catalogue or moving its
 * faces/stops. Published socket depths can overlap the nominal bend tangent;
 * that small unpublished transition is represented as a schematic swage. */
export function buildCopperSocketElbowMesh(
  placement: CopperSocketElbowPlacement,
  options: CopperSocketElbowMeshOptions = {},
): THREE.Group {
  const group = new THREE.Group();
  const spec = placement.spec;
  group.name = `copper-socket-elbow-${placement.id}`;
  group.userData = {
    fittingType: 'copper-socket-elbow', elbowAngleDeg: spec.angleDeg,
    sourceUrl: spec.sourceUrl, catalogueId: spec.id,
    dimensionBasis: spec.dimensionBasis ?? 'planning',
    bodyDimensionBasis: spec.bodyDimensionBasis ?? 'parametric-tube-envelope',
    qualificationStatus: 'unverified',
    catalogueModel: spec.catalogueModel, sizeMatch: spec.sizeMatch,
    pipeLineKind: options.lineKind,
    socketFaces: { start: { ...placement.startFace }, end: { ...placement.endFace } },
    insertionStops: { start: { ...placement.startStop }, end: { ...placement.endStop } },
    centerlineRadiusMm: spec.centerlineRadiusMm,
    insertionDepthMm: spec.insertionDepthMm,
    transitionRepresentation: 'schematic-swage',
  };
  const center = vector(placement.center);
  const entry = vector(placement.entry);
  const exit = vector(placement.exit);
  const normal = vector(placement.normal).normalize();
  const incoming = vector(placement.startDirection).normalize();
  const outgoing = vector(placement.endDirection).normalize();
  const startFace = vector(placement.startFace); const endFace = vector(placement.endFace);
  const startStop = vector(placement.startStop); const endStop = vector(placement.endStop);
  const bodyOuter = spec.bodyOutsideDiameterMm / 2; const bodyInner = spec.bodyInsideDiameterMm / 2;
  const socketOuter = spec.socketOutsideDiameterMm / 2; const socketInner = spec.socketInsideDiameterMm / 2;
  const radius = spec.centerlineRadiusMm;
  const frame = [center, entry, exit, normal, incoming, outgoing, startFace, endFace, startStop, endStop];
  if (![radius, bodyOuter, bodyInner, socketOuter, socketInner].every(value => Number.isFinite(value) && value > EPSILON)
    || frame.some(value => !value.toArray().every(Number.isFinite))
    || bodyInner >= bodyOuter || socketInner >= socketOuter || socketInner < bodyInner
    || radius <= bodyOuter || normal.lengthSq() < 0.5
    || Math.abs(entry.distanceTo(center) - radius) > 0.01
    || Math.abs(startFace.distanceTo(startStop) - spec.insertionDepthMm) > 0.01
    || Math.abs(endFace.distanceTo(endStop) - spec.insertionDepthMm) > 0.01) {
    group.userData.geometryIssue = 'The supplied elbow dimensions do not define a valid hollow circular body.';
    return group;
  }
  const sweep = spec.angleDeg * Math.PI / 180;
  const radial = entry.clone().sub(center);
  const pointAt = (angle: number): THREE.Vector3 => radial.clone().applyAxisAngle(normal, angle).add(center);
  const tangentAt = (angle: number): THREE.Vector3 => new THREE.Vector3()
    .crossVectors(normal, pointAt(angle).sub(center)).normalize();
  // Leave the full socket bore straight to its declared insertion stop. When
  // it extends beyond the nominal circle tangent, trim only the unpublished
  // swage region; the remaining body keeps the catalogue's exact radius.
  const transitionLength = Math.max(0.5, spec.wallThicknessMm);
  const startOverlap = startStop.clone().sub(entry).dot(incoming);
  const endOverlap = exit.clone().sub(endStop).dot(outgoing);
  const trimAngle = (overlap: number): number => overlap < -EPSILON ? 0
    : Math.asin(Math.min(1, (Math.max(0, overlap) + transitionLength) / radius));
  const startAngle = trimAngle(startOverlap);
  const endAngle = sweep - trimAngle(endOverlap);
  if (endAngle - startAngle <= EPSILON
    || pointAt(sweep).distanceTo(exit) > 0.01
    || tangentAt(0).dot(incoming) < 1 - 1e-6
    || tangentAt(sweep).dot(outgoing) < 1 - 1e-6) {
    group.userData.geometryIssue = 'The supplied socket arrangement leaves no consistent circular elbow body.';
    return group;
  }
  const rings: ProfileRing[] = [];
  const push = (point: THREE.Vector3, tangent: THREE.Vector3, outsideRadius: number, insideRadius: number): void => {
    rings.push({ center: point.clone(), tangent: tangent.clone(), outsideRadius, insideRadius });
  };
  push(startFace, incoming, socketOuter, socketInner);
  push(startStop, incoming, socketOuter, socketInner);
  push(startStop, incoming, socketOuter, bodyInner);
  const blend = (from: THREE.Vector3, to: THREE.Vector3, startTangent: THREE.Vector3,
    endTangent: THREE.Vector3, fromRadius: number, toRadius: number, includeEnd: boolean): void => {
    const length = from.distanceTo(to);
    if (length <= EPSILON) return;
    const curve = new THREE.CubicBezierCurve3(from,
      from.clone().addScaledVector(startTangent, length / 3),
      to.clone().addScaledVector(endTangent, -length / 3), to);
    const divisions = 4;
    for (let index = 1; index <= divisions; index += 1) {
      if (!includeEnd && index === divisions) break;
      const t = index / divisions;
      push(curve.getPoint(t), curve.getTangent(t), THREE.MathUtils.lerp(fromRadius, toRadius, t), bodyInner);
    }
  };
  blend(startStop, pointAt(startAngle), incoming, tangentAt(startAngle), socketOuter, bodyOuter, false);
  const arcSegments = Math.max(4, Math.ceil((endAngle - startAngle) / (Math.PI / 48)));
  for (let index = 0; index <= arcSegments; index += 1) {
    const angle = THREE.MathUtils.lerp(startAngle, endAngle, index / arcSegments);
    push(pointAt(angle), tangentAt(angle), bodyOuter, bodyInner);
  }
  blend(pointAt(endAngle), endStop, tangentAt(endAngle), outgoing, bodyOuter, socketOuter, true);
  push(endStop, outgoing, socketOuter, socketInner);
  push(endFace, outgoing, socketOuter, socketInner);
  const material = new THREE.MeshStandardMaterial({ color: options.color ?? '#c78363', metalness: 0.72, roughness: 0.3 });
  const copper = new THREE.Mesh(buildAnnularShell(rings, normal), material);
  copper.name = `refrigerant-${options.lineKind ?? 'gas'}-copper-socket-elbow`;
  copper.userData = { ...group.userData, pipeSurfaceRole: 'fitting' };
  copper.castShadow = true; copper.receiveShadow = true; copper.renderOrder = 20;
  group.add(copper);

  const thickness = options.insulationThicknessMm ?? 0;
  if (options.showInsulation && Number.isFinite(thickness) && thickness > 0) {
    // A tube sweep self-intersects whenever jacket radius exceeds bend radius.
    // The convex cover is an explicit conservative envelope, not a claimed
    // manufactured insulation product or a change to the copper centerline.
    const envelopePoints: THREE.Vector3[] = [];
    const arcSagitta = radius * (1 - Math.cos(Math.PI / 96));
    for (const ring of rings) {
      const side = new THREE.Vector3().crossVectors(normal, ring.tangent).normalize();
      // Circumscribe the sampled jacket circle and include the circular
      // body's between-station sagitta so faceting never understates it.
      const coverRadius = (ring.outsideRadius + thickness + arcSagitta) / Math.cos(Math.PI / RADIAL_SEGMENTS);
      for (let index = 0; index < RADIAL_SEGMENTS; index += 1) {
        const angle = index * Math.PI * 2 / RADIAL_SEGMENTS;
        envelopePoints.push(ring.center.clone()
          .addScaledVector(side, Math.cos(angle) * coverRadius)
          .addScaledVector(normal, Math.sin(angle) * coverRadius));
      }
    }
    const hull = new ConvexGeometry(envelopePoints);
    hull.deleteAttribute('normal');
    const geometry = mergeVertices(hull, 1e-5);
    if (geometry !== hull) hull.dispose();
    geometry.computeVertexNormals();
    const cover = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: options.lineKind === 'liquid' ? '#bc863f' : '#4088b3', roughness: 0.9, metalness: 0.06,
    }));
    cover.name = `refrigerant-${options.lineKind ?? 'gas'}-socket-elbow-insulation`;
    cover.userData = { ...group.userData, pipeSurfaceRole: 'fitting-insulation',
      representation: 'conservative-cover-envelope', insulationThicknessMm: thickness };
    cover.castShadow = true; cover.receiveShadow = true; cover.renderOrder = 18;
    group.add(cover);
  }
  markObjectMaterialsOwned(group);
  return group;
}
