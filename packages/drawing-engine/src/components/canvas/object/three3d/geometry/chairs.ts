/**
 * 3D geometry builders for chair furniture types.
 * roundedBoxGeometry: bottom face at y=0, top face at y=h.
 * Set mesh.position.y to the desired bottom elevation.
 */

import * as THREE from 'three';
import { woodMaterial, fabricMaterial, chromeMaterial, leatherMaterial } from '../materials';

function roundedBoxGeometry(w: number, h: number, d: number, r: number, segments = 2): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = w / 2 - r;
  const hd = d / 2 - r;
  shape.moveTo(-hw, -hd - r);
  shape.lineTo(hw, -hd - r);
  shape.quadraticCurveTo(hw + r, -hd - r, hw + r, -hd);
  shape.lineTo(hw + r, hd);
  shape.quadraticCurveTo(hw + r, hd + r, hw, hd + r);
  shape.lineTo(-hw, hd + r);
  shape.quadraticCurveTo(-hw - r, hd + r, -hw - r, hd);
  shape.lineTo(-hw - r, -hd);
  shape.quadraticCurveTo(-hw - r, -hd - r, -hw, -hd - r);

  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    depth: h,
    bevelEnabled: true,
    bevelThickness: Math.min(r * 0.5, 0.02),
    bevelSize: Math.min(r * 0.5, 0.02),
    bevelSegments: segments,
  };
  const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  geo.rotateX(-Math.PI / 2);
  // After rotation: bottom at y=0, top at y=h.
  return geo;
}

export function buildDiningChair(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x7A5C30);
  const fabric = fabricMaterial(0x8B4513);
  const woodDark = woodMaterial(0x5f4522);
  const metal = chromeMaterial();

  // Seat
  const seatGeo = roundedBoxGeometry(0.42, 0.035, 0.42, 0.02);
  const seat = new THREE.Mesh(seatGeo, fabric);
  seat.position.y = 0.44;
  group.add(seat);

  const seatSeamGeo = new THREE.TorusGeometry(0.17, 0.004, 6, 22);
  seatSeamGeo.rotateX(Math.PI / 2);
  seatSeamGeo.scale(1.15, 1, 1.12);
  const seatSeam = new THREE.Mesh(seatSeamGeo, metal);
  seatSeam.position.y = 0.452;
  group.add(seatSeam);

  // Slim tapered legs and stretchers.
  const legGeo = new THREE.CylinderGeometry(0.012, 0.018, 0.46, 8);
  const offsets = [
    [-0.17, -0.17],
    [0.17, -0.17],
    [-0.17, 0.17],
    [0.17, 0.17],
  ];
  for (const [x, z] of offsets) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(x, 0.22, z);
    group.add(leg);
  }

  const stretcherSideGeo = new THREE.BoxGeometry(0.015, 0.025, 0.30);
  for (const x of [-0.15, 0.15]) {
    const stretcher = new THREE.Mesh(stretcherSideGeo, woodDark);
    stretcher.position.set(x, 0.17, 0);
    group.add(stretcher);
  }

  const stretcherFrontGeo = new THREE.BoxGeometry(0.26, 0.025, 0.015);
  for (const z of [-0.15, 0.15]) {
    const stretcher = new THREE.Mesh(stretcherFrontGeo, woodDark);
    stretcher.position.set(0, 0.17, z);
    group.add(stretcher);
  }

  // Backrest and top rail.
  const backGeo = roundedBoxGeometry(0.40, 0.30, 0.025, 0.01);
  const back = new THREE.Mesh(backGeo, wood);
  back.position.set(0, 0.62, -0.19);
  group.add(back);

  const topRailGeo = new THREE.BoxGeometry(0.42, 0.04, 0.04);
  const topRail = new THREE.Mesh(topRailGeo, woodDark);
  topRail.position.set(0, 0.83, -0.19);
  group.add(topRail);

  const backCutoutGeo = new THREE.BoxGeometry(0.12, 0.07, 0.02);
  const backCutout = new THREE.Mesh(backCutoutGeo, woodDark);
  backCutout.position.set(0, 0.75, -0.18);
  group.add(backCutout);

  const spindleGeo = new THREE.CylinderGeometry(0.008, 0.01, 0.30, 6);
  for (const x of [-0.12, 0, 0.12]) {
    const spindle = new THREE.Mesh(spindleGeo, wood);
    spindle.position.set(x, 0.60, -0.19);
    group.add(spindle);
  }

  return group;
}

export function buildOfficeChair(): THREE.Group {
  const group = new THREE.Group();
  const chrome = chromeMaterial();
  const leather = leatherMaterial(0x1A1A2E);
  const darkMetal = chromeMaterial();

  // 5-star base
  const baseRadius = 0.28;
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const armGeo = new THREE.CylinderGeometry(0.015, 0.015, baseRadius, 6);
    armGeo.rotateZ(Math.PI / 2);
    const arm = new THREE.Mesh(armGeo, chrome);
    arm.position.set(
      Math.cos(angle) * baseRadius / 2,
      0.03,
      Math.sin(angle) * baseRadius / 2
    );
    arm.rotation.y = -angle;
    group.add(arm);

    const casterY = 0.02;
    const casterX = Math.cos(angle) * baseRadius;
    const casterZ = Math.sin(angle) * baseRadius;
    const casterCoreGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.04, 8);
    casterCoreGeo.rotateX(Math.PI / 2);
    const casterCore = new THREE.Mesh(casterCoreGeo, darkMetal);
    casterCore.position.set(casterX, casterY, casterZ);
    casterCore.rotation.y = -angle;
    group.add(casterCore);

    const wheelGeo = new THREE.CylinderGeometry(0.013, 0.013, 0.01, 10);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const side of [-1, 1]) {
      const wheel = new THREE.Mesh(wheelGeo, chrome);
      wheel.position.set(casterX + Math.cos(angle) * side * 0.012, casterY, casterZ + Math.sin(angle) * side * 0.012);
      wheel.rotation.y = -angle;
      group.add(wheel);
    }
  }

  // Gas lift column
  const columnGeo = new THREE.CylinderGeometry(0.025, 0.03, 0.32, 8);
  const column = new THREE.Mesh(columnGeo, chrome);
  column.position.y = 0.22;
  group.add(column);

  const seatSupportGeo = new THREE.CylinderGeometry(0.07, 0.05, 0.04, 12);
  const seatSupport = new THREE.Mesh(seatSupportGeo, darkMetal);
  seatSupport.position.y = 0.39;
  group.add(seatSupport);

  // Seat
  const seatGeo = roundedBoxGeometry(0.48, 0.06, 0.46, 0.04);
  const seat = new THREE.Mesh(seatGeo, leather);
  seat.position.y = 0.42;
  group.add(seat);

  const frontLipGeo = new THREE.BoxGeometry(0.40, 0.02, 0.04);
  const frontLip = new THREE.Mesh(frontLipGeo, leather);
  frontLip.position.set(0, 0.39, 0.18);
  group.add(frontLip);

  const seatStitchGeo = new THREE.BoxGeometry(0.36, 0.004, 0.002);
  for (const z of [-0.15, 0.15]) {
    const stitch = new THREE.Mesh(seatStitchGeo, darkMetal);
    stitch.position.set(0, 0.45, z);
    group.add(stitch);
  }

  // Backrest (curved)
  const backGeo = roundedBoxGeometry(0.46, 0.42, 0.04, 0.03);
  const back = new THREE.Mesh(backGeo, leather);
  back.position.set(0, 0.68, -0.2);
  back.rotation.x = 0.1;
  group.add(back);

  const lumbarGeo = roundedBoxGeometry(0.34, 0.08, 0.03, 0.02);
  const lumbar = new THREE.Mesh(lumbarGeo, leather);
  lumbar.position.set(0, 0.60, -0.18);
  lumbar.rotation.x = 0.06;
  group.add(lumbar);

  // Armrests
  for (const side of [-1, 1]) {
    const armVertGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.2, 6);
    const armVert = new THREE.Mesh(armVertGeo, chrome);
    armVert.position.set(side * 0.24, 0.52, -0.05);
    group.add(armVert);

    const armPadGeo = roundedBoxGeometry(0.06, 0.025, 0.22, 0.01);
    const armPad = new THREE.Mesh(armPadGeo, leather);
    armPad.position.set(side * 0.24, 0.63, -0.05);
    group.add(armPad);
  }

  return group;
}

export function buildArmchair(): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x6B4226);
  const fabric = fabricMaterial(0x5B7553);
  const cushionFabric = fabricMaterial(0x6c8764);

  // 4 short legs
  const legGeo = new THREE.CylinderGeometry(0.025, 0.028, 0.15, 8);
  const offsets = [
    [-0.32, -0.32],
    [0.32, -0.32],
    [-0.32, 0.32],
    [0.32, 0.32],
  ];
  for (const [x, z] of offsets) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(x, 0.075, z);
    group.add(leg);
  }

  // Base frame
  const baseGeo = roundedBoxGeometry(0.78, 0.08, 0.78, 0.03);
  const base = new THREE.Mesh(baseGeo, fabric);
  base.position.y = 0.15;                                  // bottom at leg top
  group.add(base);

  // Seat cushion
  const seatGeo = roundedBoxGeometry(0.60, 0.12, 0.58, 0.04);
  const seat = new THREE.Mesh(seatGeo, cushionFabric);
  seat.position.set(0, 0.23, 0.03);                        // bottom on base top
  group.add(seat);

  // Back cushion
  const backGeo = roundedBoxGeometry(0.58, 0.38, 0.10, 0.04);
  const back = new THREE.Mesh(backGeo, cushionFabric);
  back.position.set(0, 0.35, -0.30);                       // bottom just above seat
  back.rotation.x = 0.08;
  group.add(back);

  // Armrests
  for (const side of [-1, 1]) {
    const armGeo = roundedBoxGeometry(0.10, 0.25, 0.65, 0.03);
    const arm = new THREE.Mesh(armGeo, fabric);
    arm.position.set(side * 0.36, 0.15, -0.02);            // bottom at base level
    group.add(arm);
  }

  const sideCushionGeo = roundedBoxGeometry(0.06, 0.16, 0.44, 0.02);
  for (const side of [-1, 1]) {
    const sideCushion = new THREE.Mesh(sideCushionGeo, cushionFabric);
    sideCushion.position.set(side * 0.26, 0.23, 0.04);     // aligns with seat
    group.add(sideCushion);
  }

  const backSplitGeo = new THREE.BoxGeometry(0.01, 0.30, 0.03);
  const backSplit = new THREE.Mesh(backSplitGeo, fabric);
  backSplit.position.set(0, 0.50, -0.25);                   // inside back cushion
  group.add(backSplit);

  const throwPillowGeo = roundedBoxGeometry(0.18, 0.08, 0.18, 0.02);
  const throwPillow = new THREE.Mesh(throwPillowGeo, fabricMaterial(0x7a8f73));
  throwPillow.position.set(0.12, 0.35, 0.06);               // sits on seat cushion
  throwPillow.rotation.y = -0.22;
  group.add(throwPillow);

  return group;
}
