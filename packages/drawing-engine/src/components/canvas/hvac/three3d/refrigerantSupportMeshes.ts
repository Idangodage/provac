/**
 * A refrigerant line's supports in 3D: a clip round the insulation and a
 * threaded rod up to the soffit at each station refrigerantSupports.ts lays out.
 */
import * as THREE from 'three';

import { layoutRefrigerantSupports } from '../refrigerantSupports';

const ROD_RADIUS_MM = 4;
const CLIP_COLOR = '#70777e';
const ROD_COLOR = '#b4bac0';
const Z = new THREE.Vector3(0, 0, 1);

export function addRefrigerantSupportMeshes(group: THREE.Group, element: Parameters<typeof layoutRefrigerantSupports>[0], soffitMm: number): void {
  const supports = layoutRefrigerantSupports(element, soffitMm);
  if (!supports.length) return;
  const clipMaterial = new THREE.MeshStandardMaterial({ color: CLIP_COLOR, roughness: 0.45, metalness: 0.5 });
  const rodMaterial = new THREE.MeshStandardMaterial({ color: ROD_COLOR, roughness: 0.4, metalness: 0.6 });
  for (const support of supports) {
    const radius = support.insulatedDiameterMm / 2;
    const clip = new THREE.Mesh(new THREE.TorusGeometry(radius + 2.5, 2.2, 8, 28), clipMaterial);
    clip.position.set(support.point.x, support.point.y, support.point.z);
    clip.quaternion.setFromUnitVectors(Z, new THREE.Vector3(support.axis.x, support.axis.y, 0));
    clip.name = 'refrigerant-support-clip';
    clip.renderOrder = 18;
    group.add(clip);
    if (support.rodLengthMm <= 1) continue;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(ROD_RADIUS_MM, ROD_RADIUS_MM, support.rodLengthMm, 8), rodMaterial);
    // A cylinder stands along y: turned to stand along z, from the top of the insulation up.
    rod.rotation.x = Math.PI / 2;
    rod.position.set(support.point.x, support.point.y, support.point.z + radius + support.rodLengthMm / 2);
    rod.name = 'refrigerant-support-rod';
    rod.renderOrder = 18;
    group.add(rod);
  }
}
