/**
 * Inline refrigerant accessories in 3D, on the line as fitted: a brass ball
 * valve with its stem and lever, a steel Y-strainer with its screen leg and
 * cap, a brass sight glass with its window dome, a flare union's two nuts and
 * body. Each is built in its own frame (x along the straight, z the side away
 * from the floor) from its body's practice size, standing proud of the
 * line's insulation (drawn whole through it) so it stays in sight. One with no
 * room where it is glows red.
 */
import * as THREE from 'three';

import type { HvacElement } from '../../../../types';
import { accessoryDrawnRadiusMm, readRefrigerantAccessories, type PlacedRefrigerantAccessory } from '../refrigerant/refrigerantAccessories';
import { refrigerantLineOf } from '../refrigerant/refrigerantPieces';

export const REFRIGERANT_ACCESSORY_3D_COLORS = {
  brass: '#c9a23a',
  brassDark: '#9a7a24',
  steel: '#9aa3ad',
  steelDark: '#6b7280',
  gasLever: '#c0392b',
  liquidLever: '#2563eb',
  glass: '#34d399',
} as const;

const MATERIALS = new Map<string, THREE.MeshStandardMaterial>();

/** Shared (unowned) materials: the resource lifecycle never disposes them. */
function material(color: string, metalness: number, roughness: number, options: { opacity?: number; problem?: boolean } = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${metalness}|${roughness}|${options.opacity ?? 1}|${options.problem ? 1 : 0}`;
  let cached = MATERIALS.get(key);
  if (!cached) {
    cached = new THREE.MeshStandardMaterial({
      color, metalness, roughness,
      ...(options.opacity !== undefined && options.opacity < 1 ? { transparent: true, opacity: options.opacity } : {}),
      ...(options.problem ? { emissive: new THREE.Color('#b91c1c'), emissiveIntensity: 0.55 } : {}),
    });
    MATERIALS.set(key, cached);
  }
  return cached;
}

/** A cylinder along the frame's x axis, centred at `u` (radial segments 6 draws a hex nut). */
function alongX(radius: number, length: number, u: number, mat: THREE.Material, name: string, segments = 24): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radius, radius, Math.max(length, 0.5), segments, 1, false);
  geometry.rotateZ(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(u, 0, 0);
  mesh.name = name;
  return mesh;
}

/** A cylinder from `from` to `to` in the frame. */
function between(from: THREE.Vector3, to: THREE.Vector3, radius: number, mat: THREE.Material, name: string, segments = 20): THREE.Mesh | null {
  const delta = to.clone().sub(from);
  const length = delta.length();
  if (length < 0.5) return null;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments, 1, false), mat);
  mesh.position.copy(from.clone().add(to).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  mesh.name = name;
  return mesh;
}

/** The accessory's frame: x along its straight, z towards the ceiling (y on across). */
function frameOf(placed: PlacedRefrigerantAccessory): THREE.Matrix4 {
  const x = new THREE.Vector3(placed.direction.x, placed.direction.y, placed.direction.z).normalize();
  let up = new THREE.Vector3(0, 0, 1);
  if (Math.abs(x.dot(up)) > 0.95) up = new THREE.Vector3(1, 0, 0);
  const y = up.clone().cross(x).normalize();
  const z = x.clone().cross(y).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(placed.centre.x, placed.centre.y, placed.centre.z);
}

function accessoryGroup(placed: PlacedRefrigerantAccessory, outsideDiameterMm: number, lineKind: 'gas' | 'liquid' | 'pair'): THREE.Group {
  const group = new THREE.Group();
  group.name = `refrigerant-accessory-${placed.accessory.kind}-${placed.accessory.id}`;
  group.userData.refrigerantAccessoryId = placed.accessory.id;
  const L = placed.lengthMm;
  const R = accessoryDrawnRadiusMm(placed, outsideDiameterMm);
  const problem = !!placed.problem;
  const brass = material(REFRIGERANT_ACCESSORY_3D_COLORS.brass, 0.78, 0.32, { problem });
  const brassDark = material(REFRIGERANT_ACCESSORY_3D_COLORS.brassDark, 0.72, 0.4, { problem });
  const steel = material(REFRIGERANT_ACCESSORY_3D_COLORS.steel, 0.7, 0.38, { problem });
  const steelDark = material(REFRIGERANT_ACCESSORY_3D_COLORS.steelDark, 0.65, 0.45, { problem });
  const add = (mesh: THREE.Object3D | null) => {
    if (mesh) group.add(mesh);
  };
  switch (placed.accessory.kind) {
    case 'ball-valve': {
      // A round body between two hex ends; the stem up to a lever along the line.
      add(alongX(R * 1.1, L * 0.5, 0, brass, 'valve-body'));
      add(alongX(R, L * 0.25, -L * 0.375, brassDark, 'valve-end', 6));
      add(alongX(R, L * 0.25, L * 0.375, brassDark, 'valve-end', 6));
      const stemTop = new THREE.Vector3(0, 0, R * 1.1 + R * 0.6);
      add(between(new THREE.Vector3(0, 0, R * 0.6), stemTop, R * 0.18, brassDark, 'valve-stem'));
      const lever = new THREE.Mesh(new THREE.BoxGeometry(L * 0.85, R * 0.32, R * 0.16),
        material(lineKind === 'liquid' ? REFRIGERANT_ACCESSORY_3D_COLORS.liquidLever : REFRIGERANT_ACCESSORY_3D_COLORS.gasLever, 0.1, 0.55, { problem }));
      lever.position.set(L * 0.32, 0, stemTop.z + R * 0.08);
      lever.name = 'valve-lever';
      add(lever);
      break;
    }
    case 'strainer': {
      // The body and its flare ends; the screen leg slanting down off it, capped.
      add(alongX(R * 1.04, L * 0.7, 0, steel, 'strainer-body'));
      add(alongX(R, L * 0.15, -L * 0.425, steelDark, 'strainer-end', 6));
      add(alongX(R, L * 0.15, L * 0.425, steelDark, 'strainer-end', 6));
      const legFrom = new THREE.Vector3(-L * 0.12, 0, 0);
      const legTo = new THREE.Vector3(L * 0.2, 0, -R * 1.9);
      add(between(legFrom, legTo, R * 0.6, steel, 'strainer-leg'));
      const capDir = legTo.clone().sub(legFrom).normalize();
      add(between(legTo, legTo.clone().addScaledVector(capDir, R * 0.35), R * 0.68, steelDark, 'strainer-cap', 6));
      break;
    }
    case 'sight-glass': {
      // The body and its flare ends; the window boss on top with its glass dome.
      add(alongX(R * 1.04, L * 0.62, 0, brass, 'sight-body'));
      add(alongX(R, L * 0.19, -L * 0.405, brassDark, 'sight-end', 6));
      add(alongX(R, L * 0.19, L * 0.405, brassDark, 'sight-end', 6));
      add(between(new THREE.Vector3(0, 0, R * 0.5), new THREE.Vector3(0, 0, R * 1.3), R * 0.78, brassDark, 'sight-boss', 24));
      const dome = new THREE.Mesh(new THREE.SphereGeometry(R * 0.6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        material(REFRIGERANT_ACCESSORY_3D_COLORS.glass, 0.05, 0.08, { opacity: 0.78, problem }));
      dome.rotateX(Math.PI / 2);
      dome.position.set(0, 0, R * 1.3);
      dome.name = 'sight-glass-dome';
      add(dome);
      break;
    }
    default: {
      // Two flare nuts and the union body between them.
      add(alongX(R * 0.98, L * 0.28, 0, brassDark, 'union-body', 6));
      add(alongX(R * 1.1, L * 0.36, -L * 0.32, brass, 'union-nut', 6));
      add(alongX(R * 1.1, L * 0.36, L * 0.32, brass, 'union-nut', 6));
      break;
    }
  }
  group.applyMatrix4(frameOf(placed));
  group.traverse((object) => {
    object.renderOrder = 19;
  });
  return group;
}

/** A refrigerant line's accessories, added to its group (in model space, like the line). */
export function addRefrigerantAccessoryMeshes(group: THREE.Group, element: HvacElement, scene: readonly HvacElement[]): number {
  if (!readRefrigerantAccessories(element).length) return 0;
  const line = refrigerantLineOf(element, scene);
  if (!line) return 0;
  for (const placed of line.accessories) group.add(accessoryGroup(placed, line.outsideDiameterMm, line.lineKind));
  return line.accessories.length;
}
