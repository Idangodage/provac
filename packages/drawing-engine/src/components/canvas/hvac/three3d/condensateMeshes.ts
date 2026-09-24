/**
 * 3D meshes for condensate drainage as it is installed on site: sloped uPVC
 * runs in black closed-cell insulation with swept bends, the unit's flexible
 * drain hose into the riser, hanger clips on threaded rods from the slab, the
 * exposed PVC fittings, and the gully / stack / wall terminations.
 *
 * Condensate never goes through the copper pipeline (`liftPipePlanRouteTo3d`,
 * socket elbows, arc recovery): a drain falls continuously, so its corners are
 * slightly off-square; bends are swept along the exact authored
 * `routeNodes3d` centreline.
 */
import * as THREE from 'three';

import type { HvacElement } from '../../../../types';
import { layoutCondensateSupports } from '../condensate/condensateSupports';
import {
  CONDENSATE_TUNDISH_HEIGHT_MM,
  readCondensateGullySpec,
  readCondensatePipeSpec,
  type CondensateFitting,
  type CondensatePipeSpec,
  type Point3,
} from '../condensate/condensateTypes';

export const CONDENSATE_3D_COLORS = {
  /** Black closed-cell elastomeric insulation. */
  insulation: '#1f2226',
  pvc: '#e6eaee',
  hose: '#c3cad1',
  clamp: '#8b939b',
  rod: '#b4bac0',
  clip: '#70777e',
  pvcDark: '#9aa7b2',
  cap: '#f8fafc',
  vent: '#e2e8f0',
  gullyBody: '#6b7280',
  gullyGrate: '#374151',
  stack: '#c7ced6',
  tundish: '#e5e7eb',
  hepvo: '#1f2937',
} as const;


const MATERIALS = new Map<string, THREE.MeshStandardMaterial>();

/** Shared (unowned) materials: the resource lifecycle never disposes them. */
function material(color: string, roughness = 0.82, metalness = 0.04, doubleSided = false): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}|${doubleSided ? 2 : 1}`;
  let cached = MATERIALS.get(key);
  if (!cached) {
    cached = new THREE.MeshStandardMaterial({
      color, roughness, metalness, ...(doubleSided ? { side: THREE.DoubleSide } : {}),
    });
    MATERIALS.set(key, cached);
  }
  return cached;
}

function vec(point: Point3): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z);
}

function cylinderBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  color: string,
  name: string,
  options: { radialSegments?: number; roughness?: number; metalness?: number } = {},
): THREE.Mesh | null {
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length < 1e-3) return null;
  const geometry = new THREE.CylinderGeometry(radius, radius, length, options.radialSegments ?? 20, 1, false);
  const mesh = new THREE.Mesh(geometry, material(color, options.roughness, options.metalness));
  mesh.position.copy(start.clone().add(end).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  mesh.name = name;
  mesh.renderOrder = 18;
  return mesh;
}

function sphereAt(point: THREE.Vector3, radius: number, color: string, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 18, 12), material(color));
  mesh.position.copy(point);
  mesh.name = name;
  mesh.renderOrder = 18;
  return mesh;
}

function unit(point: Point3 | undefined, fallback: THREE.Vector3): THREE.Vector3 {
  if (!point) return fallback.clone();
  const vector = vec(point);
  return vector.lengthSq() > 1e-9 ? vector.normalize() : fallback.clone();
}

function addFittingMesh(group: THREE.Group, fitting: CondensateFitting, runRadius: number): void {
  const at = vec(fitting.point);
  const axis = unit(fitting.axis, new THREE.Vector3(1, 0, 0));
  const pipeRadius = fitting.outerDiameterMm / 2;
  const socketRadius = Math.max(runRadius, pipeRadius * 1.18);
  const name = `condensate-fitting-${fitting.kind}`;
  switch (fitting.kind) {
    case 'wye': {
      const body = cylinderBetween(at.clone().addScaledVector(axis, -socketRadius * 1.6), at.clone().addScaledVector(axis, socketRadius * 1.6), socketRadius, CONDENSATE_3D_COLORS.pvc, name);
      if (body) group.add(body);
      const branch = unit(fitting.branchAxis, new THREE.Vector3(0, 0, 1));
      const stub = cylinderBetween(at, at.clone().addScaledVector(branch, socketRadius * 2.4), socketRadius * 0.92, CONDENSATE_3D_COLORS.pvc, `${name}-branch`);
      if (stub) group.add(stub);
      break;
    }
    case 'cleanout': {
      const cap = cylinderBetween(at.clone().addScaledVector(axis, -socketRadius * 0.4), at.clone().addScaledVector(axis, socketRadius * 0.9), socketRadius * 1.05, CONDENSATE_3D_COLORS.cap, name);
      if (cap) group.add(cap);
      break;
    }
    case 'air-vent': {
      const top = at.clone().add(new THREE.Vector3(0, 0, 160));
      const riser = cylinderBetween(at, top, pipeRadius * 0.8, CONDENSATE_3D_COLORS.vent, name);
      if (riser) group.add(riser);
      group.add(sphereAt(top, pipeRadius * 0.95, CONDENSATE_3D_COLORS.cap, `${name}-cap`));
      break;
    }
    case 'p-trap': {
      const depth = Math.max(60, Number.parseFloat(fitting.note ?? '') || 90);
      const across = axis.clone().setZ(0);
      if (across.lengthSq() < 1e-9) across.set(1, 0, 0);
      across.normalize();
      const radius = Math.max(pipeRadius * 1.4, 22);
      const down = new THREE.Vector3(0, 0, -1);
      const inlet = at.clone();
      const outlet = at.clone().addScaledVector(across, radius * 2);
      const inletBottom = inlet.clone().addScaledVector(down, depth);
      const outletBottom = outlet.clone().addScaledVector(down, depth);
      [cylinderBetween(inlet, inletBottom, pipeRadius, CONDENSATE_3D_COLORS.pvc, `${name}-in`),
        cylinderBetween(outlet, outletBottom, pipeRadius, CONDENSATE_3D_COLORS.pvc, `${name}-out`),
        cylinderBetween(inletBottom, outletBottom, pipeRadius, CONDENSATE_3D_COLORS.pvc, `${name}-u`)]
        .forEach((mesh) => { if (mesh) group.add(mesh); });
      group.add(sphereAt(inletBottom, pipeRadius, CONDENSATE_3D_COLORS.pvc, `${name}-bend-a`));
      group.add(sphereAt(outletBottom, pipeRadius, CONDENSATE_3D_COLORS.pvc, `${name}-bend-b`));
      break;
    }
    case 'hepvo': {
      const body = cylinderBetween(at.clone().add(new THREE.Vector3(0, 0, -120)), at.clone().add(new THREE.Vector3(0, 0, 40)), Math.max(21, pipeRadius * 1.2), CONDENSATE_3D_COLORS.hepvo, name);
      if (body) group.add(body);
      break;
    }
    case 'wall-sleeve': {
      const flat = axis.clone().setZ(0);
      if (flat.lengthSq() < 1e-9) flat.set(1, 0, 0);
      flat.normalize();
      const sleeve = cylinderBetween(at.clone().addScaledVector(flat, -90), at.clone().addScaledVector(flat, 90), socketRadius * 1.35, CONDENSATE_3D_COLORS.pvcDark, name);
      if (sleeve) group.add(sleeve);
      break;
    }
    case 'terminal-outlet': {
      const down = at.clone().add(new THREE.Vector3(0, 0, -150));
      const elbow = sphereAt(at, pipeRadius * 1.1, CONDENSATE_3D_COLORS.pvc, `${name}-elbow`);
      group.add(elbow);
      const stub = cylinderBetween(at, down, pipeRadius, CONDENSATE_3D_COLORS.pvc, name);
      if (stub) group.add(stub);
      break;
    }
    case 'stack-wye':
    case 'tundish':
    case 'reducer':
    case 'elbow-45':
    case 'elbow-90':
    default: {
      // Bends are swept into the insulated run itself (addInsulatedRun).
      break;
    }
  }
}

/** Long-radius sweep of the insulated run, as a multiple of its outer diameter. */
const BEND_RADIUS_FACTOR = 1.6;
const HOSE_BEND_RADIUS_MM = 45;
const HOSE_RIB_PITCH_MM = 9;
const ROD_RADIUS_MM = 4; // M8
const RISER_ARM_MM = 45;

function ringAt(point: THREE.Vector3, axis: THREE.Vector3, radius: number, tube: number, color: string, name: string, metalness = 0.5): THREE.Mesh {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 28), material(color, 0.45, metalness));
  ring.position.copy(point);
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize());
  ring.name = name;
  ring.renderOrder = 18;
  return ring;
}

/** How far each corner is cut back so a bend of `bendRadius` fits (never more than 45 % of a leg). */
function cornerTrims(points: THREE.Vector3[], bendRadius: number): number[] {
  const trims = points.map(() => 0);
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index]!.clone().sub(points[index - 1]!);
    const after = points[index + 1]!.clone().sub(points[index]!);
    const lengthBefore = before.length();
    const lengthAfter = after.length();
    if (lengthBefore < 1e-6 || lengthAfter < 1e-6) continue;
    const angle = before.angleTo(after);
    if (angle < THREE.MathUtils.degToRad(2)) continue;
    trims[index] = Math.min(bendRadius * Math.tan(angle / 2), lengthBefore * 0.45, lengthAfter * 0.45);
  }
  return trims;
}

/** Smooth centreline: straight legs joined by a swept curve through every corner. */
function sweptPath(points: THREE.Vector3[], bendRadius: number): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const trims = cornerTrims(points, bendRadius);
  let cursor = points[0]!.clone();
  for (let index = 1; index < points.length; index += 1) {
    const direction = points[index]!.clone().sub(points[index - 1]!).normalize();
    const legEnd = points[index]!.clone().addScaledVector(direction, -trims[index]!);
    if (cursor.distanceTo(legEnd) > 1e-3) path.add(new THREE.LineCurve3(cursor.clone(), legEnd));
    cursor = legEnd;
    if (index < points.length - 1 && trims[index]! > 0) {
      const after = points[index + 1]!.clone().sub(points[index]!).normalize();
      const exit = points[index]!.clone().addScaledVector(after, trims[index]!);
      path.add(new THREE.QuadraticBezierCurve3(legEnd, points[index]!.clone(), exit));
      cursor = exit;
    }
  }
  return path;
}

/** Insulated run: straight tubes between trimmed corners and a swept tube through each bend. */
function addInsulatedRun(group: THREE.Group, points: THREE.Vector3[], radius: number, color: string, roughness: number): void {
  const trims = cornerTrims(points, radius * 2 * BEND_RADIUS_FACTOR);
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const direction = b.clone().sub(a);
    if (direction.length() < 1e-3) continue;
    direction.normalize();
    const leg = cylinderBetween(
      a.clone().addScaledVector(direction, trims[index - 1]!),
      b.clone().addScaledVector(direction, -trims[index]!),
      radius, color, 'condensate-pipe-run', { roughness },
    );
    if (leg) group.add(leg);
  }
  for (let index = 1; index < points.length - 1; index += 1) {
    const trim = trims[index]!;
    if (trim <= 0) continue;
    const corner = points[index]!;
    const before = corner.clone().sub(points[index - 1]!).normalize();
    const after = points[index + 1]!.clone().sub(corner).normalize();
    const curve = new THREE.QuadraticBezierCurve3(corner.clone().addScaledVector(before, -trim), corner.clone(), corner.clone().addScaledVector(after, trim));
    const bend = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, radius, 20, false), material(color, roughness));
    bend.name = 'condensate-pipe-bend';
    bend.renderOrder = 18;
    group.add(bend);
  }
}

/** Splits a polyline at a distance along it. */
function splitAtLength(points: THREE.Vector3[], length: number): [THREE.Vector3[], THREE.Vector3[]] {
  if (length <= 0) return [[], points];
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const span = points[index]!.distanceTo(points[index - 1]!);
    if (travelled + span >= length) {
      const cut = points[index - 1]!.clone().lerp(points[index]!, span > 1e-9 ? (length - travelled) / span : 0);
      return [[...points.slice(0, index), cut], [cut, ...points.slice(index)]];
    }
    travelled += span;
  }
  return [points, []];
}

/** The unit's ribbed flexible drain hose, clamped at the socket and on the riser spigot. */
function addDrainHose(group: THREE.Group, points: THREE.Vector3[], radius: number): void {
  const path = sweptPath(points, HOSE_BEND_RADIUS_MM);
  if (!path.curves.length) return;
  const length = path.getLength();
  if (length < 1) return;
  const hose = new THREE.Mesh(
    new THREE.TubeGeometry(path, Math.max(8, Math.ceil(length / 6)), radius, 16, false),
    material(CONDENSATE_3D_COLORS.hose, 0.55),
  );
  hose.name = 'condensate-drain-hose';
  hose.renderOrder = 18;
  group.add(hose);
  const ribGeometry = new THREE.TorusGeometry(radius, Math.max(1, radius * 0.1), 6, 20);
  for (let station = HOSE_RIB_PITCH_MM; station < length - HOSE_RIB_PITCH_MM; station += HOSE_RIB_PITCH_MM) {
    const u = station / length;
    const rib = new THREE.Mesh(ribGeometry, material(CONDENSATE_3D_COLORS.hose, 0.55));
    rib.position.copy(path.getPointAt(u));
    rib.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), path.getTangentAt(u).normalize());
    rib.name = 'condensate-drain-hose-rib';
    rib.renderOrder = 18;
    group.add(rib);
  }
  for (const u of [Math.min(0.04, 6 / length), Math.max(0.96, 1 - 6 / length)]) {
    group.add(ringAt(path.getPointAt(u), path.getTangentAt(u), radius + 1.5, 2.4, CONDENSATE_3D_COLORS.clamp, 'condensate-drain-hose-clamp', 0.7));
  }
}

/** Plan direction of the first run leaving the vertical segment that contains `point`. */
function runDirectionAfter(nodes: Point3[], point: Point3): THREE.Vector3 | null {
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    if (Math.hypot(point.x - a.x, point.y - a.y) > 0.5 || point.z < Math.min(a.z, b.z) - 0.5 || point.z > Math.max(a.z, b.z) + 0.5) continue;
    for (let next = index; next < nodes.length; next += 1) {
      const from = nodes[next - 1]!;
      const to = nodes[next]!;
      const plan = new THREE.Vector3(to.x - from.x, to.y - from.y, 0);
      if (plan.length() > 1) return plan.normalize();
    }
  }
  return null;
}

/** Hanger clips on threaded rods from the slab (risers: clip on a side arm; low verticals: bracket). */
function addHangers(group: THREE.Group, element: HvacElement, spec: CondensatePipeSpec, radius: number): void {
  if (!spec.hangers) return;
  const top = spec.hangers.topZ;
  const nodes = spec.routeNodes3d;
  const outward = spec.drainStart && nodes.length >= 2
    ? new THREE.Vector3(nodes[1]!.x - spec.drainStart.point.x, nodes[1]!.y - spec.drainStart.point.y, 0)
    : new THREE.Vector3();
  const rodOptions = { radialSegments: 8, roughness: 0.4, metalness: 0.6 };
  for (const support of layoutCondensateSupports(element, spec.hangers)) {
    const at = vec(support.point);
    group.add(ringAt(at, vec(support.axis), radius + 2.5, 2.2, CONDENSATE_3D_COLORS.clip, 'condensate-hanger-clip'));
    if (support.rodLengthMm <= 0) continue;
    if (support.orientation === 'horizontal') {
      const rod = cylinderBetween(at.clone().add(new THREE.Vector3(0, 0, radius + 4)), new THREE.Vector3(at.x, at.y, top), ROD_RADIUS_MM, CONDENSATE_3D_COLORS.rod, 'condensate-hanger-rod', rodOptions);
      if (rod) group.add(rod);
      continue;
    }
    // Riser: the rod drops beside it, clear of the run leaving its top and away from the unit.
    const run = runDirectionAfter(nodes, support.point) ?? new THREE.Vector3(1, 0, 0);
    const side = new THREE.Vector3(-run.y, run.x, 0);
    if (side.dot(outward) < 0) side.negate();
    const rodFoot = at.clone().addScaledVector(side, radius + RISER_ARM_MM);
    const arm = cylinderBetween(at.clone().addScaledVector(side, radius + 2.5), rodFoot, 3, CONDENSATE_3D_COLORS.clip, 'condensate-hanger-arm', { radialSegments: 8, roughness: 0.45, metalness: 0.5 });
    if (arm) group.add(arm);
    const rod = cylinderBetween(rodFoot, new THREE.Vector3(rodFoot.x, rodFoot.y, top), ROD_RADIUS_MM, CONDENSATE_3D_COLORS.rod, 'condensate-hanger-rod', rodOptions);
    if (rod) group.add(rod);
  }
}

/** Builds a condensate run in WORLD coordinates (the caller's group sits at the origin). */
export function addCondensatePipeMeshes(group: THREE.Group, element: HvacElement): void {
  const spec = readCondensatePipeSpec(element);
  const nodes = spec.routeNodes3d.length >= 2
    ? spec.routeNodes3d
    : spec.routePoints.map((point) => ({ ...point, z: element.elevation + spec.outerDiameterMm / 2 }));
  if (nodes.length < 2) return;
  const pipeRadius = spec.outerDiameterMm / 2;
  const insulated = spec.insulationThicknessMm > 0;
  const radius = insulated ? pipeRadius + spec.insulationThicknessMm : pipeRadius;
  const color = insulated ? CONDENSATE_3D_COLORS.insulation : CONDENSATE_3D_COLORS.pvc;
  const [hose, rigid] = splitAtLength(nodes.map(vec), spec.drainHoseLengthMm);
  if (hose.length >= 2) addDrainHose(group, hose, pipeRadius * 0.95);
  if (rigid.length >= 2) {
    addInsulatedRun(group, rigid, radius, color, insulated ? 0.92 : 0.6);
    // PVC socket where the rigid pipe starts (on the riser spigot after a hose).
    const first = rigid[0]!;
    const direction = rigid[1]!.clone().sub(first).normalize();
    const collar = cylinderBetween(first.clone().addScaledVector(direction, -2), first.clone().addScaledVector(direction, 22), radius * 1.05, CONDENSATE_3D_COLORS.pvc, 'condensate-pipe-socket');
    if (collar) group.add(collar);
  }
  addHangers(group, element, spec, radius);
  for (const fitting of spec.fittings) addFittingMesh(group, fitting, radius);
}

/** Builds a termination in WORLD coordinates (the caller's group sits at the origin). */
export function addCondensateGullyMeshes(group: THREE.Group, element: HvacElement): void {
  const spec = readCondensateGullySpec(element);
  const center = spec.connectionPoint;
  const rotation = THREE.MathUtils.degToRad(element.rotation ?? 0);
  const local = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(
    center.x + x * Math.cos(rotation) - y * Math.sin(rotation),
    center.y + x * Math.sin(rotation) + y * Math.cos(rotation),
    z,
  );
  if (spec.terminationKind === 'floor-gully') {
    const size = Math.max(120, Math.min(element.width, element.depth));
    const body = new THREE.Mesh(new THREE.BoxGeometry(size, size, 40), material(CONDENSATE_3D_COLORS.gullyBody));
    body.position.copy(local(0, 0, 20));
    body.rotation.z = rotation;
    body.name = 'condensate-gully-body';
    group.add(body);
    const grate = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.36, size * 0.36, 6, 28), material(CONDENSATE_3D_COLORS.gullyGrate, 0.5, 0.4));
    grate.rotation.x = Math.PI / 2;
    grate.position.copy(local(0, 0, 43));
    grate.name = 'condensate-gully-grate';
    group.add(grate);
    if (spec.terminalTrap === 'tundish') {
      const rim = spec.inletElevationMm;
      const tundish = new THREE.Mesh(
        new THREE.CylinderGeometry(55, 18, CONDENSATE_TUNDISH_HEIGHT_MM, 24, 1, true),
        material(CONDENSATE_3D_COLORS.tundish, 0.4, 0.04, true),
      );
      tundish.rotation.x = Math.PI / 2;
      tundish.position.copy(local(0, 0, rim + CONDENSATE_TUNDISH_HEIGHT_MM / 2));
      tundish.name = 'condensate-gully-tundish';
      group.add(tundish);
    }
    return;
  }
  if (spec.terminationKind === 'stack-connection') {
    const inlet = spec.inletElevationMm;
    const stack = cylinderBetween(local(0, 0, Math.max(0, inlet - 900)), local(0, 0, inlet + 900), 55, CONDENSATE_3D_COLORS.stack, 'condensate-stack');
    if (stack) group.add(stack);
    const boss = new THREE.Mesh(new THREE.TorusGeometry(58, 8, 10, 28), material(CONDENSATE_3D_COLORS.pvcDark));
    boss.position.copy(local(0, 0, inlet));
    boss.name = 'condensate-stack-boss';
    group.add(boss);
    return;
  }
  // External discharge: sleeve through the wall along the element's depth axis.
  const penetration = spec.inletElevationMm;
  const sleeve = cylinderBetween(local(0, -Math.max(element.depth, 80) / 2 - 220, penetration), local(0, Math.max(element.depth, 80) / 2 + 220, penetration), 28, CONDENSATE_3D_COLORS.pvcDark, 'condensate-wall-sleeve');
  if (sleeve) group.add(sleeve);
}
