/**
 * 3D geometry builders for bed furniture types.
 * roundedBoxGeometry: bottom face at y=0, top face at y=h.
 * Set mesh.position.y to the desired bottom elevation.
 */

import * as THREE from 'three';
import { woodMaterial, mattressMaterial, fabricMaterial } from '../materials';

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
  // After rotation: bottom at y=0, top at y=h.
  return geo;
}

type BedSize = 'single' | 'double' | 'queen' | 'king';

const BED_WIDTHS: Record<BedSize, number> = {
  single: 0.90,
  double: 1.35,
  queen: 1.50,
  king: 1.80,
};

export function buildBed(size: BedSize = 'queen'): THREE.Group {
  const group = new THREE.Group();
  const wood = woodMaterial(0x6B4226);
  const mattress = mattressMaterial(0xF0EDE5);
  const pillow = mattressMaterial(0xFAF8F0);
  const blanket = fabricMaterial(0x6B8FB5);
  const blanketFold = fabricMaterial(0x567aa2);

  const width = BED_WIDTHS[size];
  const length = size === 'single' || size === 'double' ? 1.90 : 2.00;

  // ── Vertical dimensions (bottom-up stacking) ──
  const legH = 0.08;              // leg height
  const frameH = 0.22;            // frame panel thickness
  const frameTop = legH + frameH; // 0.30  — top of frame
  const mattressH = 0.18;         // mattress thickness
  const mattressTop = frameTop + mattressH; // 0.48

  // ── Legs (bottom at y=0) ──
  const legGeo = new THREE.BoxGeometry(0.05, legH, 0.05);
  legGeo.translate(0, legH / 2, 0);                       // bottom 0 → top legH
  const legPositions: [number, number][] = [
    [-width / 2 + 0.06, -length / 2 + 0.08],
    [width / 2 - 0.06, -length / 2 + 0.08],
    [-width / 2 + 0.06, length / 2 - 0.08],
    [width / 2 - 0.06, length / 2 - 0.08],
  ];
  for (const [x, z] of legPositions) {
    const leg = new THREE.Mesh(legGeo, woodMaterial(0x4d2d18));
    leg.position.set(x, 0, z);                            // bottom at 0
    group.add(leg);
  }

  // ── Frame base (sits on top of legs) ──
  const frameGeo = new THREE.BoxGeometry(width, frameH, length);
  frameGeo.translate(0, frameH / 2, 0);                   // bottom 0 → top frameH
  const frame = new THREE.Mesh(frameGeo, wood);
  frame.position.y = legH;                                 // bottom legH → top frameTop
  group.add(frame);

  // Inner support rail
  const railGeo = new THREE.BoxGeometry(width - 0.04, 0.08, length - 0.10);
  railGeo.translate(0, 0.04, 0);
  const rail = new THREE.Mesh(railGeo, woodMaterial(0x5c351d));
  rail.position.y = legH;                                  // inside frame
  group.add(rail);

  // ── Mattress (sits on frame top) ──
  const mGeo = roundedBoxGeometry(width - 0.04, mattressH, length - 0.06, 0.04);
  const mat = new THREE.Mesh(mGeo, mattress);
  mat.position.set(0, frameTop, 0.01);                     // bottom frameTop → top mattressTop
  group.add(mat);

  // ── Headboard (starts from floor, rises above mattress) ──
  const headboardH = 0.65;
  const headboardGeo = new THREE.BoxGeometry(width + 0.04, headboardH, 0.05);
  headboardGeo.translate(0, headboardH / 2, 0);            // bottom 0 → top headboardH
  const headboard = new THREE.Mesh(headboardGeo, wood);
  headboard.position.set(0, 0, -length / 2 + 0.02);       // bottom at floor
  group.add(headboard);

  // Decorative inset panel on headboard
  const panelH = headboardH - 0.12;
  const headPanelGeo = new THREE.BoxGeometry(width - 0.10, panelH, 0.025);
  headPanelGeo.translate(0, panelH / 2, 0);
  const headPanel = new THREE.Mesh(headPanelGeo, woodMaterial(0x7d5632));
  headPanel.position.set(0, 0.06, -length / 2 + 0.05);    // slightly above floor
  group.add(headPanel);

  // ── Pillows (rest on mattress top, near headboard) ──
  const pillowCount = size === 'single' ? 1 : 2;
  const pillowW = (width - 0.12) / pillowCount;
  for (let i = 0; i < pillowCount; i++) {
    const px = -width / 2 + 0.06 + pillowW / 2 + i * pillowW;
    const pillowGeo = roundedBoxGeometry(pillowW - 0.04, 0.08, 0.30, 0.03);
    const p = new THREE.Mesh(pillowGeo, pillow);
    p.position.set(px, mattressTop, -length / 2 + 0.22);   // bottom on mattress top
    group.add(p);
  }

  // ── Blanket/duvet (covers lower 2/3 of bed on top of mattress) ──
  const blanketLen = length * 0.6;
  const blanketGeo = roundedBoxGeometry(width - 0.06, 0.04, blanketLen, 0.02);
  const bk = new THREE.Mesh(blanketGeo, blanket);
  bk.position.set(0, mattressTop, length / 2 - blanketLen / 2 - 0.02);
  group.add(bk);

  // Blanket fold accent line
  const foldGeo = roundedBoxGeometry(width - 0.08, 0.05, 0.22, 0.02);
  const fold = new THREE.Mesh(foldGeo, blanketFold);
  fold.position.set(0, mattressTop + 0.005, -0.10);
  group.add(fold);

  // ── Footboard (starts from floor, lower than headboard) ──
  const footH = 0.34;
  const footGeo = new THREE.BoxGeometry(width + 0.04, footH, 0.04);
  footGeo.translate(0, footH / 2, 0);                      // bottom 0 → top footH
  const foot = new THREE.Mesh(footGeo, wood);
  foot.position.set(0, 0, length / 2 - 0.01);             // bottom at floor
  group.add(foot);

  return group;
}
