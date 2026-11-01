/**
 * A refrigerant line's wall sleeves in 3D: derived from the walls as they are
 * (never stored), at the height the line crosses each one, a collar proud of
 * either face. Above a wall's top there is none.
 */
import * as THREE from 'three';

import { PIPE_SLEEVE_PROUD_MM, pipeSleeveBoreMm, pipeWallCrossings } from '../buildingSection';
import { getActiveDuctBuilding } from '../duct/ductBuilding';

import { DUCT_3D_COLORS } from './ductMeshes';

const UP = new THREE.Vector3(0, 1, 0);

export function addPipeWallSleeves(group: THREE.Group, points: readonly THREE.Vector3[], outerRadiusMm: number): void {
  const { walls } = getActiveDuctBuilding();
  if (!walls.length || points.length < 2) return;
  const segments = points.slice(1).map((point, index) => ({ a: points[index]!, b: point }));
  const crossings = pipeWallCrossings(segments, outerRadiusMm, walls);
  if (!crossings.length) return;
  const material = new THREE.MeshStandardMaterial({ color: DUCT_3D_COLORS.sleeve, metalness: 0.15, roughness: 0.6 });
  const radius = pipeSleeveBoreMm(outerRadiusMm) / 2;
  for (const crossing of crossings) {
    const geometry = new THREE.CylinderGeometry(radius, radius, crossing.throughMm + 2 * PIPE_SLEEVE_PROUD_MM, 28);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'pipe-wall-sleeve';
    mesh.position.set(crossing.point.x, crossing.point.y, crossing.z);
    mesh.quaternion.setFromUnitVectors(UP, new THREE.Vector3(crossing.direction.x, crossing.direction.y, 0));
    mesh.renderOrder = 18;
    group.add(mesh);
  }
}
