/**
 * 3D geometry builders for table furniture types.
 */

import * as THREE from 'three';
import { woodMaterial, chromeMaterial } from '../materials';

export function buildDiningTable(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x8B6914);
  const woodDark = woodMaterial(0x6d4f17);
  const metal = chromeMaterial();

  // Beveled top plus a darker subframe to read at isometric distance.
  const topGeo = new THREE.BoxGeometry(1.42, 0.035, 0.80);
  topGeo.translate(0, 0.0175, 0);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = 0.72;
  group.add(top);

  const topInsetGeo = new THREE.BoxGeometry(1.24, 0.01, 0.62);
  const topInset = new THREE.Mesh(topInsetGeo, woodDark);
  topInset.position.y = 0.735;
  group.add(topInset);

  const shadowRailGeo = new THREE.BoxGeometry(1.28, 0.018, 0.66);
  shadowRailGeo.translate(0, 0.009, 0);
  const shadowRail = new THREE.Mesh(shadowRailGeo, woodDark);
  shadowRail.position.y = 0.685;
  group.add(shadowRail);

  // Tapered legs create a more modern silhouette than box posts.
  const legGeo = new THREE.CylinderGeometry(0.028, 0.038, 0.71, 10);
  legGeo.translate(0, 0.355, 0);
  const offsets = [
    [-0.62, -0.32],
    [0.62, -0.32],
    [-0.62, 0.32],
    [0.62, 0.32],
  ];
  for (const [x, z] of offsets) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(x, 0, z);
    group.add(leg);
  }

  // Apron and lower stretcher rails.
  const apronLongGeo = new THREE.BoxGeometry(1.18, 0.075, 0.03);
  for (const z of [-0.32, 0.32]) {
    const apron = new THREE.Mesh(apronLongGeo, woodDark);
    apron.position.set(0, 0.68, z);
    group.add(apron);
  }
  const apronShortGeo = new THREE.BoxGeometry(0.03, 0.075, 0.60);
  for (const x of [-0.62, 0.62]) {
    const apron = new THREE.Mesh(apronShortGeo, woodDark);
    apron.position.set(x, 0.68, 0);
    group.add(apron);
  }

  const stretcherGeo = new THREE.BoxGeometry(0.05, 0.05, 0.56);
  for (const x of [-0.34, 0.34]) {
    const stretcher = new THREE.Mesh(stretcherGeo, woodDark);
    stretcher.position.set(x, 0.22, 0);
    group.add(stretcher);
  }

  const footPadGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.008, 10);
  for (const [x, z] of offsets) {
    const pad = new THREE.Mesh(footPadGeo, metal);
    pad.position.set(x, 0.004, z);
    group.add(pad);
  }

  return group;
}

export function buildRoundTable(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x8B6914);
  const woodDark = woodMaterial(0x6d4f17);
  const metal = chromeMaterial();

  // Slightly chamfered top and a darker apron disk.
  const topGeo = new THREE.CylinderGeometry(0.45, 0.43, 0.04, 40);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = 0.735;
  group.add(top);

  const topRingGeo = new THREE.TorusGeometry(0.36, 0.006, 8, 32);
  topRingGeo.rotateX(Math.PI / 2);
  const topRing = new THREE.Mesh(topRingGeo, metal);
  topRing.position.y = 0.755;
  group.add(topRing);

  const apronGeo = new THREE.CylinderGeometry(0.20, 0.24, 0.06, 20);
  const apron = new THREE.Mesh(apronGeo, woodDark);
  apron.position.y = 0.68;
  group.add(apron);

  const columnGeo = new THREE.CylinderGeometry(0.055, 0.09, 0.55, 16);
  const column = new THREE.Mesh(columnGeo, wood);
  column.position.y = 0.40;
  group.add(column);

  const columnRingGeo = new THREE.TorusGeometry(0.075, 0.005, 8, 24);
  columnRingGeo.rotateX(Math.PI / 2);
  for (const y of [0.20, 0.59]) {
    const ring = new THREE.Mesh(columnRingGeo, metal);
    ring.position.y = y;
    group.add(ring);
  }

  const baseGeo = new THREE.CylinderGeometry(0.24, 0.30, 0.05, 24);
  const base = new THREE.Mesh(baseGeo, wood);
  base.position.y = 0.03;
  group.add(base);

  const footGeo = new THREE.BoxGeometry(0.045, 0.03, 0.24);
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const foot = new THREE.Mesh(footGeo, woodDark);
    foot.position.set(
      Math.cos(angle) * 0.24,
      0.02,
      Math.sin(angle) * 0.24
    );
    foot.rotation.y = -angle;
    group.add(foot);
  }

  return group;
}

export function buildCoffeeTable(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x6B4226);
  const chrome = chromeMaterial();
  const woodDark = woodMaterial(0x53321e);

  // Slim top with a darker reveal below.
  const topGeo = new THREE.BoxGeometry(1.02, 0.028, 0.52);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = 0.40;
  group.add(top);

  const topBandGeo = new THREE.BoxGeometry(0.94, 0.012, 0.44);
  const topBand = new THREE.Mesh(topBandGeo, woodDark);
  topBand.position.y = 0.413;
  group.add(topBand);

  const revealGeo = new THREE.BoxGeometry(0.90, 0.015, 0.42);
  const reveal = new THREE.Mesh(revealGeo, woodDark);
  reveal.position.y = 0.37;
  group.add(reveal);

  const legGeo = new THREE.CylinderGeometry(0.01, 0.016, 0.38, 10);
  legGeo.translate(0, 0.19, 0);
  const offsets = [
    [-0.44, -0.20],
    [0.44, -0.20],
    [-0.44, 0.20],
    [0.44, 0.20],
  ];
  for (const [x, z] of offsets) {
    const leg = new THREE.Mesh(legGeo, chrome);
    leg.position.set(x, 0, z);
    group.add(leg);
  }

  const shelfGeo = new THREE.BoxGeometry(0.84, 0.02, 0.40);
  const shelf = new THREE.Mesh(shelfGeo, woodDark);
  shelf.position.y = 0.12;
  group.add(shelf);

  const railLongGeo = new THREE.BoxGeometry(0.84, 0.025, 0.02);
  for (const z of [-0.19, 0.19]) {
    const rail = new THREE.Mesh(railLongGeo, chrome);
    rail.position.set(0, 0.24, z);
    group.add(rail);
  }

  const railShortGeo = new THREE.BoxGeometry(0.02, 0.025, 0.36);
  for (const x of [-0.42, 0.42]) {
    const rail = new THREE.Mesh(railShortGeo, chrome);
    rail.position.set(x, 0.24, 0);
    group.add(rail);
  }

  const braceGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.30, 8);
  braceGeo.rotateX(Math.PI / 2);
  for (const z of [-0.16, 0.16]) {
    const brace = new THREE.Mesh(braceGeo, chrome);
    brace.position.set(0, 0.23, z);
    group.add(brace);
  }

  return group;
}
