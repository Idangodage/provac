/**
 * 3D geometry builders for meeting-table + chair configurations.
 *
 * - buildCircularTableWithChairs(chairCount): round table with chairs evenly spaced around it
 * - buildSquareTableWithChairs(chairCount): rectangular table with chairs distributed on all sides
 *
 * Geometry is in meters (Three.js convention), centered at origin, bottom face at y=0.
 */

import * as THREE from 'three';
import { woodMaterial, fabricMaterial, chromeMaterial } from '../materials';

// ─── Sizing helpers (meters) ──────────────────────────────────────────────────

const CHAIR_WIDTH = 0.42;   // seat width
const CHAIR_DEPTH = 0.42;   // seat depth
const CHAIR_SPACING = 0.08; // gap between chairs
const CHAIR_GAP   = 0.06;   // gap between chair and table edge
const TABLE_HEIGHT = 0.75;
const SEAT_HEIGHT  = 0.46;

/**
 * Compute the table radius (meters) that comfortably fits `n` chairs
 * around a circular table. Each chair occupies an arc of (CHAIR_WIDTH + CHAIR_SPACING).
 */
export function circularTableRadius(n: number): number {
  const arcPerChair = CHAIR_WIDTH + CHAIR_SPACING;
  const circumference = n * arcPerChair;
  return Math.max(0.40, circumference / (2 * Math.PI));
}

/**
 * Compute the rectangular table dimensions for `n` chairs.
 * Distributes chairs evenly: long sides get more chairs.
 */
export function squareTableDimensions(n: number): { tableW: number; tableD: number } {
  const perSideShort = Math.max(1, Math.floor(n / 4));
  const perSideLong  = Math.max(1, Math.ceil(n / 4));
  const tableW = Math.max(0.80, perSideLong * (CHAIR_WIDTH + CHAIR_SPACING) + 0.20);
  const tableD = Math.max(0.60, perSideShort * (CHAIR_WIDTH + CHAIR_SPACING) + 0.20);
  return { tableW, tableD };
}

/**
 * Auto-compute footprint size in **millimeters** from chair count.
 * Used by the library and property-resize logic to keep 2D/3D in sync.
 */
export function circularMeetingFootprintMm(chairCount: number): { widthMm: number; depthMm: number } {
  const r = circularTableRadius(chairCount);
  const total = 2 * (r + CHAIR_GAP + CHAIR_DEPTH + 0.05); // extra margin
  const mm = Math.round(total * 1000);
  return { widthMm: mm, depthMm: mm };
}

export function squareMeetingFootprintMm(chairCount: number): { widthMm: number; depthMm: number } {
  const { tableW, tableD } = squareTableDimensions(chairCount);
  const wMm = Math.round((tableW + 2 * (CHAIR_GAP + CHAIR_DEPTH) + 0.10) * 1000);
  const dMm = Math.round((tableD + 2 * (CHAIR_GAP + CHAIR_DEPTH) + 0.10) * 1000);
  return { widthMm: wMm, depthMm: dMm };
}

// ─── Shared sub-builders ──────────────────────────────────────────────────────

function addChair(group: THREE.Group, x: number, z: number, rotationY: number): void {
  const wood = woodMaterial(0x7A5C30);
  const fabric = fabricMaterial(0x8B4513);
  const metal = chromeMaterial();

  const chair = new THREE.Group();

  // Seat
  const seatGeo = new THREE.BoxGeometry(CHAIR_WIDTH, 0.035, CHAIR_DEPTH);
  const seat = new THREE.Mesh(seatGeo, fabric);
  seat.position.y = SEAT_HEIGHT + 0.0175;
  chair.add(seat);

  // Backrest
  const backGeo = new THREE.BoxGeometry(CHAIR_WIDTH - 0.04, 0.35, 0.025);
  const back = new THREE.Mesh(backGeo, fabric);
  back.position.set(0, SEAT_HEIGHT + 0.035 + 0.175, -CHAIR_DEPTH / 2 + 0.0125);
  chair.add(back);

  // Legs (4 tapered cylinders)
  const legGeo = new THREE.CylinderGeometry(0.012, 0.018, SEAT_HEIGHT, 8);
  const offsets: [number, number][] = [
    [-0.17, -0.17],
    [0.17, -0.17],
    [-0.17, 0.17],
    [0.17, 0.17],
  ];
  for (const [lx, lz] of offsets) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(lx, SEAT_HEIGHT / 2, lz);
    chair.add(leg);
  }

  // Stretchers
  const stretcherGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.30, 6);
  stretcherGeo.rotateZ(Math.PI / 2);
  for (const sz of [-0.17, 0.17]) {
    const s = new THREE.Mesh(stretcherGeo, metal);
    s.position.set(0, 0.12, sz);
    chair.add(s);
  }

  chair.position.set(x, 0, z);
  chair.rotation.y = rotationY;
  group.add(chair);
}

function addRoundTableTop(group: THREE.Group, radius: number): void {
  const wood = woodMaterial(0x8B6914);
  const woodDark = woodMaterial(0x6d4f17);
  const metal = chromeMaterial();

  // Top
  const topGeo = new THREE.CylinderGeometry(radius, radius - 0.01, 0.035, 40);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = TABLE_HEIGHT + 0.0175;
  group.add(top);

  // Decorative edge ring
  const ringGeo = new THREE.TorusGeometry(radius * 0.92, 0.005, 8, 32);
  ringGeo.rotateX(Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, metal);
  ring.position.y = TABLE_HEIGHT + 0.038;
  group.add(ring);

  // Apron disk
  const apronGeo = new THREE.CylinderGeometry(radius * 0.55, radius * 0.60, 0.05, 24);
  const apron = new THREE.Mesh(apronGeo, woodDark);
  apron.position.y = TABLE_HEIGHT - 0.025;
  group.add(apron);

  // Central column
  const colGeo = new THREE.CylinderGeometry(0.06, 0.09, TABLE_HEIGHT - 0.10, 16);
  const col = new THREE.Mesh(colGeo, wood);
  col.position.y = (TABLE_HEIGHT - 0.10) / 2;
  group.add(col);

  // Base
  const baseGeo = new THREE.CylinderGeometry(radius * 0.50, radius * 0.55, 0.04, 24);
  const base = new THREE.Mesh(baseGeo, wood);
  base.position.y = 0.02;
  group.add(base);

  // Feet
  const footCount = Math.min(6, Math.max(3, Math.floor(radius / 0.10)));
  const footGeo = new THREE.BoxGeometry(0.045, 0.025, 0.18);
  for (let i = 0; i < footCount; i++) {
    const angle = (i / footCount) * Math.PI * 2;
    const foot = new THREE.Mesh(footGeo, woodDark);
    foot.position.set(
      Math.cos(angle) * radius * 0.48,
      0.0125,
      Math.sin(angle) * radius * 0.48
    );
    foot.rotation.y = -angle;
    group.add(foot);
  }
}

function addRectTableTop(group: THREE.Group, tableW: number, tableD: number): void {
  const wood = woodMaterial(0x8B6914);
  const woodDark = woodMaterial(0x6d4f17);
  const metal = chromeMaterial();

  // Top
  const topGeo = new THREE.BoxGeometry(tableW, 0.035, tableD);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = TABLE_HEIGHT + 0.0175;
  group.add(top);

  // Darker inset
  const insetGeo = new THREE.BoxGeometry(tableW - 0.14, 0.008, tableD - 0.14);
  const inset = new THREE.Mesh(insetGeo, woodDark);
  inset.position.y = TABLE_HEIGHT + 0.038;
  group.add(inset);

  // Apron rails
  const apronLong = new THREE.BoxGeometry(tableW - 0.10, 0.07, 0.025);
  for (const z of [-tableD / 2 + 0.05, tableD / 2 - 0.05]) {
    const a = new THREE.Mesh(apronLong, woodDark);
    a.position.set(0, TABLE_HEIGHT - 0.035, z);
    group.add(a);
  }
  const apronShort = new THREE.BoxGeometry(0.025, 0.07, tableD - 0.10);
  for (const x of [-tableW / 2 + 0.05, tableW / 2 - 0.05]) {
    const a = new THREE.Mesh(apronShort, woodDark);
    a.position.set(x, TABLE_HEIGHT - 0.035, 0);
    group.add(a);
  }

  // Legs
  const legGeo = new THREE.CylinderGeometry(0.028, 0.038, TABLE_HEIGHT - 0.04, 10);
  const positions: [number, number][] = [
    [-tableW / 2 + 0.08, -tableD / 2 + 0.08],
    [tableW / 2 - 0.08, -tableD / 2 + 0.08],
    [-tableW / 2 + 0.08, tableD / 2 - 0.08],
    [tableW / 2 - 0.08, tableD / 2 - 0.08],
  ];
  for (const [lx, lz] of positions) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(lx, (TABLE_HEIGHT - 0.04) / 2, lz);
    group.add(leg);
  }

  // Foot pads
  const padGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.008, 10);
  for (const [lx, lz] of positions) {
    const pad = new THREE.Mesh(padGeo, metal);
    pad.position.set(lx, 0.004, lz);
    group.add(pad);
  }
}

// ─── Public builders ──────────────────────────────────────────────────────────

/**
 * Circular meeting table with `chairCount` chairs evenly distributed around it.
 */
export function buildCircularTableWithChairs(chairCount: number): THREE.Group {
  const n = Math.max(2, Math.min(20, chairCount));
  const group = new THREE.Group();
  const tableR = circularTableRadius(n);

  addRoundTableTop(group, tableR);

  const chairCenterR = tableR + CHAIR_GAP + CHAIR_DEPTH / 2;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2; // start from top
    const cx = Math.cos(angle) * chairCenterR;
    const cz = Math.sin(angle) * chairCenterR;
    // Chair faces inward, with backrest on the outer side.
    // Derive yaw from chair position to avoid angular offset drift.
    const rotationY = Math.atan2(-cx, -cz);
    addChair(group, cx, cz, rotationY);
  }

  return group;
}

/**
 * Rectangular (square) meeting table with chairs distributed around all four sides.
 */
export function buildSquareTableWithChairs(chairCount: number): THREE.Group {
  const n = Math.max(2, Math.min(20, chairCount));
  const group = new THREE.Group();
  const { tableW, tableD } = squareTableDimensions(n);

  addRectTableTop(group, tableW, tableD);

  // Distribute chairs: 2 short sides + 2 long sides
  // Long sides share the majority of chairs.
  const chairPositions: { x: number; z: number; rot: number }[] = [];

  // For 2 chairs, put one on each long side
  // For 4, put 1 on each side
  // Otherwise distribute proportionally
  if (n <= 4) {
    // Simple distribution: top, bottom, left, right
    const sides: { x: number; z: number; rot: number }[] = [
      { x: 0, z: -(tableD / 2 + CHAIR_GAP + CHAIR_DEPTH / 2), rot: 0 },          // front
      { x: 0, z: (tableD / 2 + CHAIR_GAP + CHAIR_DEPTH / 2), rot: Math.PI },       // back
      { x: -(tableW / 2 + CHAIR_GAP + CHAIR_DEPTH / 2), z: 0, rot: Math.PI / 2 },  // left
      { x: (tableW / 2 + CHAIR_GAP + CHAIR_DEPTH / 2), z: 0, rot: -Math.PI / 2 },  // right
    ];
    for (let i = 0; i < n; i++) {
      chairPositions.push(sides[i % 4]);
    }
  } else {
    // Compute capacity per side proportional to side length
    const longCapacity = Math.floor(tableW / (CHAIR_WIDTH + CHAIR_SPACING));
    const shortCapacity = Math.floor(tableD / (CHAIR_WIDTH + CHAIR_SPACING));

    // Distribute chairs proportionally
    let remaining = n;
    const perLong = Math.min(longCapacity, Math.ceil(remaining * longCapacity / (2 * longCapacity + 2 * shortCapacity)));
    const perShort = Math.min(shortCapacity, Math.ceil((remaining - 2 * perLong) / 2));
    const frontCount = perLong;
    const backCount = Math.min(perLong, remaining - frontCount);
    remaining -= frontCount + backCount;
    const leftCount = Math.min(perShort, Math.ceil(remaining / 2));
    const rightCount = remaining - leftCount;

    const counts = [
      { count: frontCount, side: 'front' as const },
      { count: backCount, side: 'back' as const },
      { count: leftCount, side: 'left' as const },
      { count: rightCount, side: 'right' as const },
    ];

    for (const { count, side } of counts) {
      if (count <= 0) continue;
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1; // -1 to 1
        switch (side) {
          case 'front': {
            const maxSpan = tableW - 0.10;
            chairPositions.push({
              x: t * maxSpan / 2,
              z: -(tableD / 2 + CHAIR_GAP + CHAIR_DEPTH / 2),
              rot: 0,
            });
            break;
          }
          case 'back': {
            const maxSpan = tableW - 0.10;
            chairPositions.push({
              x: t * maxSpan / 2,
              z: (tableD / 2 + CHAIR_GAP + CHAIR_DEPTH / 2),
              rot: Math.PI,
            });
            break;
          }
          case 'left': {
            const maxSpan = tableD - 0.10;
            chairPositions.push({
              x: -(tableW / 2 + CHAIR_GAP + CHAIR_DEPTH / 2),
              z: t * maxSpan / 2,
              rot: Math.PI / 2,
            });
            break;
          }
          case 'right': {
            const maxSpan = tableD - 0.10;
            chairPositions.push({
              x: (tableW / 2 + CHAIR_GAP + CHAIR_DEPTH / 2),
              z: t * maxSpan / 2,
              rot: -Math.PI / 2,
            });
            break;
          }
        }
      }
    }
  }

  for (const pos of chairPositions) {
    addChair(group, pos.x, pos.z, pos.rot);
  }

  return group;
}
