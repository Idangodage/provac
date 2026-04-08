/**
 * 3D geometry builders for sofa furniture types.
 */

import * as THREE from 'three';
import { woodMaterial, fabricMaterial } from '../materials';

/**
 * Creates a rounded box geometry with the given dimensions.
 * Centered on the X and Z axes.
 * Bottom face at y = 0, top face at y = h.
 * Set mesh.position.y to the desired bottom elevation to stack parts.
 */
function roundedBoxGeometry(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
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
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: h,
    bevelEnabled: true,
    bevelThickness: Math.min(r * 0.4, 0.015),
    bevelSize: Math.min(r * 0.4, 0.015),
    bevelSegments: 2,
  });
  geo.rotateX(-Math.PI / 2);
  // After rotation the geometry spans y ∈ [0, h].
  // No extra translate — position.y on the mesh sets the bottom elevation.
  return geo;
}

export function buildSofa(seats: 2 | 3 = 3): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x5C4033);
  const fabric = fabricMaterial(0x4A5568);
  const cushionFabric = fabricMaterial(0x5A6578);
  const accentFabric = fabricMaterial(0x647189);

  const totalWidth = seats === 3 ? 2.1 : 1.4;
  const depth = 0.85;
  const seatH = 0.42;       // seat-surface height from ground
  const legH = 0.08;        // leg height
  const cushionH = 0.10;    // seat-cushion thickness
  const backTopH = 0.88;    // total sofa height (top of back frame)

  // ── Feet (4 short tapered cylinders) ──
  const footGeo = new THREE.CylinderGeometry(0.025, 0.03, legH, 8);
  const footOffsets: [number, number][] = [
    [-totalWidth / 2 + 0.08, -depth / 2 + 0.08],
    [totalWidth / 2 - 0.08, -depth / 2 + 0.08],
    [-totalWidth / 2 + 0.08, depth / 2 - 0.08],
    [totalWidth / 2 - 0.08, depth / 2 - 0.08],
  ];
  for (const [x, z] of footOffsets) {
    const foot = new THREE.Mesh(footGeo, wood);
    foot.position.set(x, legH / 2, z);                // cylinder centre → [0, legH]
    group.add(foot);

    const capGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.01, 8);
    const cap = new THREE.Mesh(capGeo, fabricMaterial(0x3f4a5f));
    cap.position.set(x, legH + 0.005, z);             // just above foot
    group.add(cap);
  }

  // ── Base frame (structural seat platform) ──
  // Fills the space from the top of the legs to the bottom of the seat cushions.
  const baseFrameH = seatH - cushionH - legH;           // 0.42 − 0.10 − 0.08 = 0.24
  const baseGeo = roundedBoxGeometry(totalWidth, baseFrameH, depth, 0.03);
  const base = new THREE.Mesh(baseGeo, fabric);
  base.position.y = legH;                               // bottom 0.08 → top 0.32
  group.add(base);

  // Decorative plinth strip at the base front
  const plinthGeo = roundedBoxGeometry(totalWidth - 0.06, 0.04, depth - 0.10, 0.02);
  const plinth = new THREE.Mesh(plinthGeo, accentFabric);
  plinth.position.y = legH;                             // bottom 0.08 → top 0.12
  group.add(plinth);

  // ── Seat cushions (individual per seat) ──
  const cushionWidth = (totalWidth - 0.18) / seats;
  for (let i = 0; i < seats; i++) {
    const cx = -totalWidth / 2 + 0.09 + cushionWidth / 2 + i * cushionWidth;

    const cushionGeo = roundedBoxGeometry(cushionWidth - 0.02, cushionH, depth * 0.55, 0.03);
    const cushion = new THREE.Mesh(cushionGeo, cushionFabric);
    cushion.position.set(cx, seatH - cushionH, 0.06);   // bottom 0.32 → top 0.42
    group.add(cushion);

    // Front accent band
    const frontBandGeo = new THREE.BoxGeometry(cushionWidth - 0.08, 0.035, 0.025);
    const frontBand = new THREE.Mesh(frontBandGeo, accentFabric);
    frontBand.position.set(cx, seatH - cushionH + 0.02, depth * 0.28);
    group.add(frontBand);

    // Stitch seam lines on cushion top
    const seamGeo = new THREE.BoxGeometry(cushionWidth - 0.08, 0.003, 0.003);
    for (const z of [-depth * 0.08, depth * 0.14]) {
      const seam = new THREE.Mesh(seamGeo, fabricMaterial(0x3f4f68));
      seam.position.set(cx, seatH - 0.005, z);          // flush with cushion top
      group.add(seam);
    }
  }

  // ── Back cushions (one per seat, lean against back frame) ──
  const backCushionH = 0.34;
  for (let i = 0; i < seats; i++) {
    const cx = -totalWidth / 2 + 0.09 + cushionWidth / 2 + i * cushionWidth;

    const backGeo = roundedBoxGeometry(cushionWidth - 0.02, backCushionH, 0.12, 0.04);
    const back = new THREE.Mesh(backGeo, cushionFabric);
    back.position.set(cx, seatH, -depth / 2 + 0.10);    // bottom at seatH → top 0.76
    back.rotation.x = 0.06;                              // slight recline lean
    group.add(back);

    // Decorative tuck line near the top of the back cushion
    const tuckGeo = new THREE.BoxGeometry(cushionWidth - 0.10, 0.02, 0.02);
    const tuck = new THREE.Mesh(tuckGeo, accentFabric);
    tuck.position.set(cx, seatH + backCushionH - 0.06, -depth / 2 + 0.16);
    group.add(tuck);
  }

  // ── Back frame (structural panel behind cushions) ──
  const backFrameH = backTopH - legH;                    // 0.88 − 0.08 = 0.80
  const backFrameGeo = roundedBoxGeometry(totalWidth, backFrameH, 0.06, 0.02);
  const backFrame = new THREE.Mesh(backFrameGeo, fabric);
  backFrame.position.set(0, legH, -depth / 2 + 0.03);   // bottom 0.08 → top 0.88
  group.add(backFrame);

  // ── Armrests (one on each side, full height from base to arm top) ──
  const armTopH = seatH + 0.16;                          // armrest top at 0.58
  const armH = armTopH - legH;                           // 0.58 − 0.08 = 0.50
  for (const side of [-1, 1]) {
    const armGeo = roundedBoxGeometry(0.10, armH, depth * 0.8, 0.03);
    const arm = new THREE.Mesh(armGeo, fabric);
    arm.position.set(
      side * (totalWidth / 2 - 0.04),
      legH,                                              // bottom 0.08 → top 0.58
      0.0,
    );
    group.add(arm);

    // Soft inner arm pad
    const armPadGeo = roundedBoxGeometry(0.06, 0.22, depth * 0.55, 0.02);
    const armPad = new THREE.Mesh(armPadGeo, cushionFabric);
    armPad.position.set(
      side * (totalWidth / 2 - 0.08),
      armTopH - 0.24,                                    // from 0.34 → 0.56 (recessed inner panel)
      0.02,
    );
    group.add(armPad);
  }

  // ── Lower decorative rail at the back ──
  const lowerRailGeo = new THREE.BoxGeometry(totalWidth - 0.18, 0.05, 0.05);
  const lowerRail = new THREE.Mesh(lowerRailGeo, accentFabric);
  lowerRail.position.set(0, legH + 0.06, -depth / 2 + 0.08);
  group.add(lowerRail);

  // ── Throw pillows ──
  const pillowCount = seats === 3 ? 2 : 1;
  for (let i = 0; i < pillowCount; i++) {
    const px = pillowCount === 1 ? 0 : (i === 0 ? -0.22 : 0.22);
    const pillowGeo = roundedBoxGeometry(0.22, 0.08, 0.20, 0.025);
    const pillow = new THREE.Mesh(pillowGeo, fabricMaterial(0x70839f));
    pillow.position.set(px, seatH, -0.05);              // sitting on seat cushion
    pillow.rotation.y = i % 2 === 0 ? -0.25 : 0.22;
    group.add(pillow);
  }

  return group;
}
