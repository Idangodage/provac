/**
 * 3D geometry builders for storage furniture types.
 */

import * as THREE from 'three';
import { woodMaterial, chromeMaterial, metalMaterial } from '../materials';

export function buildNightstand(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x6B4226);
  const knob = chromeMaterial();
  const woodDark = woodMaterial(0x54331d);

  // Main body
  const bodyGeo = new THREE.BoxGeometry(0.48, 0.48, 0.42);
  bodyGeo.translate(0, 0.26, 0);
  const body = new THREE.Mesh(bodyGeo, wood);
  group.add(body);

  const topGeo = new THREE.BoxGeometry(0.52, 0.025, 0.44);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = 0.505;
  group.add(top);

  const drawerGeo = new THREE.BoxGeometry(0.40, 0.17, 0.025);
  for (const y of [0.35, 0.16]) {
    const drawer = new THREE.Mesh(drawerGeo, woodDark);
    drawer.position.set(0, y, 0.222);
    group.add(drawer);
  }

  const railGeo = new THREE.BoxGeometry(0.42, 0.008, 0.008);
  const rail = new THREE.Mesh(railGeo, metalMaterial(0x333333));
  rail.position.set(0, 0.255, 0.214);
  group.add(rail);

  const knobGeo = new THREE.SphereGeometry(0.012, 8, 6);
  for (const y of [0.16, 0.35]) {
    const k = new THREE.Mesh(knobGeo, knob);
    k.position.set(0, y, 0.215);
    group.add(k);
  }

  const legGeo = new THREE.BoxGeometry(0.04, 0.08, 0.04);
  legGeo.translate(0, 0.04, 0);
  const offsets = [[-0.20, -0.17], [0.20, -0.17], [-0.20, 0.17], [0.20, 0.17]];
  for (const [x, z] of offsets) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(x, -0.04, z);
    group.add(leg);
  }

  return group;
}

export function buildDresser(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x7A5C30);
  const knob = chromeMaterial();
  const woodDark = woodMaterial(0x63481f);

  // Main body
  const bodyGeo = new THREE.BoxGeometry(0.88, 0.82, 0.45);
  bodyGeo.translate(0, 0.41, 0);
  const body = new THREE.Mesh(bodyGeo, wood);
  group.add(body);

  // Top
  const topGeo = new THREE.BoxGeometry(0.90, 0.025, 0.47);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = 0.835;
  group.add(top);

  const plinthGeo = new THREE.BoxGeometry(0.82, 0.05, 0.39);
  const plinth = new THREE.Mesh(plinthGeo, woodDark);
  plinth.position.y = 0.03;
  group.add(plinth);

  const drawerGeo = new THREE.BoxGeometry(0.78, 0.16, 0.025);
  const knobGeo = new THREE.SphereGeometry(0.012, 8, 6);
  const drawerYs = [0.13, 0.31, 0.49, 0.67];
  for (const y of drawerYs) {
    const drawer = new THREE.Mesh(drawerGeo, woodDark);
    drawer.position.set(0, y, 0.238);
    group.add(drawer);

    for (const kx of [-0.18, 0.18]) {
      const k = new THREE.Mesh(knobGeo, knob);
      k.position.set(kx, y, 0.252);
      group.add(k);
    }
  }

  return group;
}

export function buildWardrobe(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x6B4226);
  const knob = chromeMaterial();
  const woodDark = woodMaterial(0x58351f);

  // Main body
  const bodyGeo = new THREE.BoxGeometry(0.96, 2.0, 0.56);
  bodyGeo.translate(0, 1.0, 0);
  const body = new THREE.Mesh(bodyGeo, wood);
  group.add(body);

  const topGeo = new THREE.BoxGeometry(1.00, 0.03, 0.60);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = 2.015;
  group.add(top);

  const plinthGeo = new THREE.BoxGeometry(0.90, 0.08, 0.48);
  const plinth = new THREE.Mesh(plinthGeo, woodDark);
  plinth.position.y = 0.04;
  group.add(plinth);

  const doorGeo = new THREE.BoxGeometry(0.44, 1.82, 0.025);
  for (const x of [-0.23, 0.23]) {
    const door = new THREE.Mesh(doorGeo, woodDark);
    door.position.set(x, 1.02, 0.292);
    group.add(door);
  }

  const topPanelGeo = new THREE.BoxGeometry(0.90, 0.16, 0.025);
  const topPanel = new THREE.Mesh(topPanelGeo, woodDark);
  topPanel.position.set(0, 1.82, 0.292);
  group.add(topPanel);

  // Door handles
  const handleGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.10, 6);
  for (const side of [-1, 1]) {
    const handle = new THREE.Mesh(handleGeo, knob);
    handle.position.set(side * 0.09, 1.0, 0.305);
    group.add(handle);
  }

  return group;
}

export function buildTvStand(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x3C3C3C);
  const metal = metalMaterial(0x666666);
  const woodDark = woodMaterial(0x282828);

  const topGeo = new THREE.BoxGeometry(1.42, 0.035, 0.44);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = 0.50;
  group.add(top);

  const carcassGeo = new THREE.BoxGeometry(1.34, 0.46, 0.40);
  carcassGeo.translate(0, 0.23, 0);
  const carcass = new THREE.Mesh(carcassGeo, woodDark);
  group.add(carcass);

  const centerShelfGeo = new THREE.BoxGeometry(0.42, 0.015, 0.34);
  const centerShelf = new THREE.Mesh(centerShelfGeo, wood);
  centerShelf.position.set(0, 0.26, 0);
  group.add(centerShelf);

  const dividerGeo = new THREE.BoxGeometry(0.015, 0.40, 0.34);
  for (const x of [-0.22, 0.22]) {
    const divider = new THREE.Mesh(dividerGeo, wood);
    divider.position.set(x, 0.22, 0);
    group.add(divider);
  }

  const doorGeo = new THREE.BoxGeometry(0.30, 0.34, 0.02);
  for (const x of [-0.47, 0.47]) {
    const door = new THREE.Mesh(doorGeo, wood);
    door.position.set(x, 0.22, 0.21);
    group.add(door);
  }

  const supportGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.08, 8);
  supportGeo.translate(0, 0.04, 0);
  const supports = [[-0.60, -0.16], [0.60, -0.16], [-0.60, 0.16], [0.60, 0.16]];
  for (const [x, z] of supports) {
    const s = new THREE.Mesh(supportGeo, metal);
    s.position.set(x, -0.02, z);
    group.add(s);
  }

  return group;
}

export function buildBookshelf(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x8B6914);
  const woodDark = woodMaterial(0x72520d);
  const bookColors = [0x8B0000, 0x00008B, 0x006400, 0x8B8000, 0x4B0082];

  const width = 0.76;
  const depth = 0.28;
  const height = 2.0;
  const shelves = 5;
  const shelfSpacing = height / (shelves + 1);

  // Side panels
  const sideGeo = new THREE.BoxGeometry(0.025, height, depth);
  sideGeo.translate(0, height / 2, 0);
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(sideGeo, wood);
    panel.position.set(side * (width / 2 - 0.012), 0, 0);
    group.add(panel);
  }

  // Back panel
  const backGeo = new THREE.BoxGeometry(width, height, 0.01);
  backGeo.translate(0, height / 2, 0);
  const back = new THREE.Mesh(backGeo, woodDark);
  back.position.z = -depth / 2 + 0.005;
  group.add(back);

  // Shelves + books
  const shelfGeo = new THREE.BoxGeometry(width - 0.05, 0.02, depth - 0.02);
  for (let i = 0; i <= shelves; i++) {
    const y = i * shelfSpacing;
    const shelf = new THREE.Mesh(shelfGeo, wood);
    shelf.position.y = y;
    group.add(shelf);

    // Deterministic book layout keeps the model stable across sessions.
    if (i < shelves) {
      const bookCount = 4 + (i % 3);
      let bx = -width / 2 + 0.06;
      for (let b = 0; b < bookCount && bx < width / 2 - 0.06; b++) {
        const bw = 0.022 + ((b + i) % 3) * 0.012;
        const bh = shelfSpacing * (0.62 + ((b + i) % 4) * 0.07);
        const bd = depth * (0.60 + ((b + i) % 2) * 0.08);
        const bookGeo = new THREE.BoxGeometry(bw, bh, bd);
        const bookMat = new THREE.MeshStandardMaterial({
          color: bookColors[b % bookColors.length],
          roughness: 0.8,
          metalness: 0.0,
        });
        const book = new THREE.Mesh(bookGeo, bookMat);
        book.position.set(bx + bw / 2, y + 0.01 + bh / 2, 0.02);
        group.add(book);
        bx += bw + 0.005;
      }
    }
  }

  return group;
}

export function buildBuffet(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x7A5C30);
  const knob = chromeMaterial();
  const woodDark = woodMaterial(0x63481f);

  // Main body
  const bodyGeo = new THREE.BoxGeometry(1.40, 0.78, 0.46);
  bodyGeo.translate(0, 0.39, 0);
  const body = new THREE.Mesh(bodyGeo, wood);
  group.add(body);

  const topGeo = new THREE.BoxGeometry(1.46, 0.035, 0.50);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = 0.80;
  group.add(top);

  const plinthGeo = new THREE.BoxGeometry(1.28, 0.06, 0.36);
  const plinth = new THREE.Mesh(plinthGeo, woodDark);
  plinth.position.y = 0.03;
  group.add(plinth);

  const doorGeo = new THREE.BoxGeometry(0.40, 0.58, 0.025);
  for (const x of [-0.46, 0, 0.46]) {
    const door = new THREE.Mesh(doorGeo, woodDark);
    door.position.set(x, 0.39, 0.244);
    group.add(door);
  }

  const knobGeo = new THREE.SphereGeometry(0.012, 8, 6);
  for (const x of [-0.35, 0, 0.35]) {
    const k = new THREE.Mesh(knobGeo, knob);
    k.position.set(x, 0.39, 0.258);
    group.add(k);
  }

  const legGeo = new THREE.BoxGeometry(0.04, 0.08, 0.04);
  legGeo.translate(0, 0.04, 0);
  for (const [x, z] of [[-0.64, -0.19], [0.64, -0.19], [-0.64, 0.19], [0.64, 0.19]]) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(x, -0.03, z);
    group.add(leg);
  }

  return group;
}
