/**
 * Where a field refrigerant line meets a unit's maker stub, as fitted on
 * site: the flare nut (or the brazed socket) on bare copper, and the field
 * insulation stopping short of it behind a tape band — or, with fittings
 * shown insulated, the joint's own insulation sleeve over it.
 */
import * as THREE from 'three';

import type { HvacElement } from '../../../../types';
import { unitConnectionOf, unitConnectionsFor } from '../unitConnections';

export interface UnitJoint {
  kind: 'flare' | 'brazed';
  /** The maker's model already shows the nut (or socket): only the field side is drawn. */
  inModel: boolean;
}

interface JointConnection {
  connectionKind?: string;
  sourceElementId?: string;
}

/** The maker joint a line meets at a unit port, or null (a field joint, or a unit without maker data). */
export function unitJointAt(connection: JointConnection | null | undefined, lineKind: 'gas' | 'liquid',
  elements: readonly HvacElement[]): UnitJoint | null {
  if (connection?.connectionKind !== 'unit-port' || !connection.sourceElementId) return null;
  const unit = elements.find((element) => element.id === connection.sourceElementId);
  const set = unit ? unitConnectionsFor(unit) : null;
  const stub = set ? unitConnectionOf(set, lineKind) : null;
  if (!stub || (stub.joint !== 'flare' && stub.joint !== 'brazed')) return null;
  return { kind: stub.joint, inModel: stub.inModel };
}

/** Flare nut across flats (mm) for a tube's outside diameter (R410A flare nuts, 1/4″ to 3/4″). */
export function flareNutAcrossFlatsMm(tubeOuterDiameterMm: number): number {
  const sizes: Array<[number, number]> = [[6.35, 17], [9.52, 22], [12.7, 26], [15.88, 29], [19.05, 36]];
  return sizes.reduce((best, size) => (Math.abs(size[0] - tubeOuterDiameterMm) < Math.abs(best[0] - tubeOuterDiameterMm) ? size : best))[1];
}

/** Bare copper the joint leaves before the field insulation starts (mm). */
export function unitJointBareLengthMm(joint: UnitJoint, coreRadiusMm: number): number {
  const fitting = joint.kind === 'flare' ? flareNutAcrossFlatsMm(coreRadiusMm * 2) * 0.75 : Math.max(16, coreRadiusMm * 2);
  return fitting + 35;
}

/** The polyline with its first `lengthMm` of run removed (empty when it is shorter). */
export function trimPolylineStart(points: readonly THREE.Vector3[], lengthMm: number): THREE.Vector3[] {
  if (lengthMm <= 0) return points.map((point) => point.clone());
  let remaining = lengthMm;
  for (let index = 1; index < points.length; index += 1) {
    const step = points[index]!.distanceTo(points[index - 1]!);
    if (step > remaining) {
      const cut = points[index - 1]!.clone().lerp(points[index]!, remaining / step);
      return [cut, ...points.slice(index).map((point) => point.clone())];
    }
    remaining -= step;
  }
  return [];
}

/** The first `lengthMm` of a polyline's run. */
export function leadingPolyline(points: readonly THREE.Vector3[], lengthMm: number): THREE.Vector3[] {
  const result = points.length ? [points[0]!.clone()] : [];
  let remaining = lengthMm;
  for (let index = 1; index < points.length && remaining > 1e-6; index += 1) {
    const step = points[index]!.distanceTo(points[index - 1]!);
    if (step >= remaining) {
      result.push(points[index - 1]!.clone().lerp(points[index]!, remaining / step));
      return result;
    }
    result.push(points[index]!.clone());
    remaining -= step;
  }
  return result;
}

const BRASS = new THREE.MeshStandardMaterial({ color: '#b48a4c', metalness: 0.65, roughness: 0.35 });
const COPPER = new THREE.MeshStandardMaterial({ color: '#c47f5a', metalness: 0.75, roughness: 0.3 });
const BRAZE = new THREE.MeshStandardMaterial({ color: '#d9d9d6', metalness: 0.8, roughness: 0.25 });
const TAPE = new THREE.MeshStandardMaterial({ color: '#1f2328', metalness: 0, roughness: 0.6 });
const JOINT_SLEEVE = new THREE.MeshStandardMaterial({ color: '#d8dde3', metalness: 0, roughness: 0.85 });

function cylinderAlong(radius: number, length: number, centre: THREE.Vector3, axis: THREE.Vector3,
  material: THREE.Material, name: string, segments = 24): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  mesh.position.copy(centre);
  mesh.name = name;
  mesh.renderOrder = 19;
  return mesh;
}

/**
 * The joint at a stub tip `at`, the field line leaving along `outward`: a hex
 * flare nut (unless the maker's model shows it) or a brazed socket, then a tape
 * band where the field insulation starts `bareMm` out — or the joint sleeve.
 */
export function addRefrigerantUnitJoint(parent: THREE.Object3D, at: THREE.Vector3, outward: THREE.Vector3, joint: UnitJoint,
  options: { coreRadiusMm: number; outerRadiusMm: number; insulatedFittings: boolean; bareMm: number }): void {
  const axis = outward.clone().normalize();
  if (axis.lengthSq() < 1e-9) return;
  const { coreRadiusMm, outerRadiusMm } = options;
  const group = new THREE.Group();
  group.name = 'refrigerant-unit-joint';
  if (joint.kind === 'flare' && !joint.inModel) {
    const acrossFlats = flareNutAcrossFlatsMm(coreRadiusMm * 2);
    const length = acrossFlats * 0.75;
    // A hex: the circumscribed radius of the flats.
    const nut = cylinderAlong(acrossFlats / Math.sqrt(3), length, at.clone().addScaledVector(axis, length * 0.3), axis, BRASS,
      'refrigerant-flare-nut', 6);
    group.add(nut);
  } else if (joint.kind === 'brazed') {
    // The field tube enters the stub's swaged socket; the brazing fillet rings its mouth.
    const length = Math.max(12, coreRadiusMm * 2);
    group.add(cylinderAlong(coreRadiusMm + 1.6, length, at.clone().addScaledVector(axis, -length / 2), axis, COPPER,
      'refrigerant-brazed-socket'));
    group.add(cylinderAlong(coreRadiusMm + 2.2, 2.4, at.clone().addScaledVector(axis, 0.6), axis, BRAZE, 'refrigerant-braze-fillet'));
  }
  if (options.insulatedFittings) {
    // The joint insulated after the leak test: a sleeve over the joint, taped at both ends.
    const sleeveLength = 110;
    const centre = at.clone().addScaledVector(axis, sleeveLength / 2 - 15);
    group.add(cylinderAlong(outerRadiusMm * 1.12, sleeveLength, centre, axis, JOINT_SLEEVE, 'refrigerant-joint-sleeve'));
    for (const end of [-1, 1]) {
      group.add(cylinderAlong(outerRadiusMm * 1.12 + 0.8, 14, centre.clone().addScaledVector(axis, end * (sleeveLength / 2 - 7)), axis,
        TAPE, 'refrigerant-joint-tape'));
    }
  } else {
    group.add(cylinderAlong(outerRadiusMm + 0.8, 18, at.clone().addScaledVector(axis, options.bareMm + 9), axis, TAPE,
      'refrigerant-insulation-tape'));
  }
  parent.add(group);
}
