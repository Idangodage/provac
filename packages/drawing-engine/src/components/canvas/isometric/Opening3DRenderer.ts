/**
 * Opening3DRenderer
 *
 * Creates Three.js 3D geometry for door and window openings in walls.
 * Realistic construction-style rendering with detailed door panels,
 * wooden textures, glass panes, and proper framing.
 *
 * All dimensions in millimeters (matching the internal coordinate system).
 */

import * as THREE from 'three';

import type { Opening, Wall } from '../../../types';

// =============================================================================
// Constants
// =============================================================================

const DOOR_FRAME_COLOR = '#4a2e18';
const DOOR_LEAF_COLOR_OUTER = '#9b7550';
const DOOR_LEAF_COLOR_INNER = '#b08860';
const DOOR_PANEL_GROOVE_COLOR = '#7a5a38';
const DOOR_HANDLE_COLOR = '#c0c0c0';
const DOOR_HANDLE_BASE_COLOR = '#a0a0a0';
const DOOR_THRESHOLD_COLOR = '#6b6b6b';
const WINDOW_FRAME_COLOR = '#e8e8e8';
const WINDOW_FRAME_ACCENT = '#d0d0d0';
const WINDOW_GLASS_COLOR = '#d6f1ff';
const WINDOW_GLASS_OPACITY = 0.46;
const WINDOW_SILL_COLOR = '#d8d8d8';

// =============================================================================
// Procedural Textures
// =============================================================================

function createWoodGrainTexture(
  width: number,
  height: number,
  baseColor: string,
  grainColor: string
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = grainColor;
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < height; i += 3) {
    ctx.beginPath();
    ctx.lineWidth = 0.5 + Math.random() * 1.5;
    const offset = Math.sin(i * 0.02) * 8;
    ctx.moveTo(offset, i);
    for (let x = 0; x < width; x += 10) {
      const y = i + Math.sin((x + i) * 0.015) * 2 + Math.random() * 0.8;
      ctx.lineTo(x + offset, y);
    }
    ctx.stroke();
  }

  // Knot details
  ctx.globalAlpha = 0.08;
  for (let k = 0; k < 3; k++) {
    const kx = Math.random() * width;
    const ky = Math.random() * height;
    const kr = 4 + Math.random() * 8;
    for (let r = kr; r > 0; r -= 1.5) {
      ctx.beginPath();
      ctx.arc(kx, ky, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function createDoorPanelTexture(width: number, height: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Base wood color
  ctx.fillStyle = DOOR_LEAF_COLOR_OUTER;
  ctx.fillRect(0, 0, width, height);

  // Wood grain
  ctx.strokeStyle = DOOR_PANEL_GROOVE_COLOR;
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < height; i += 2) {
    ctx.beginPath();
    ctx.lineWidth = 0.3 + Math.random() * 1;
    ctx.moveTo(0, i);
    for (let x = 0; x < width; x += 8) {
      ctx.lineTo(x, i + Math.sin(x * 0.01 + i * 0.005) * 1.5);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Panel insets (two panels vertically)
  const margin = width * 0.12;
  const panelGap = height * 0.04;
  const panelH = (height - margin * 2 - panelGap) / 2;

  ctx.strokeStyle = DOOR_PANEL_GROOVE_COLOR;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.35;

  // Top panel
  roundedRect(ctx, margin, margin, width - margin * 2, panelH, 3);
  ctx.stroke();
  // Inner shadow
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#000';
  roundedRect(ctx, margin + 2, margin + 2, width - margin * 2 - 4, panelH - 4, 2);
  ctx.fill();

  // Bottom panel
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = DOOR_PANEL_GROOVE_COLOR;
  roundedRect(ctx, margin, margin + panelH + panelGap, width - margin * 2, panelH, 3);
  ctx.stroke();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#000';
  roundedRect(ctx, margin + 2, margin + panelH + panelGap + 2, width - margin * 2 - 4, panelH - 4, 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  return texture;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// =============================================================================
// Helpers
// =============================================================================

interface WallFrame {
  dir: THREE.Vector3;
  perp: THREE.Vector3;
  center: THREE.Vector3;
  angle: number;
  thickness: number;
}

export type OpeningRenderOptions = {
  swingDirection?: 'left' | 'right';
  openSide?: 'positive' | 'negative';
};

function getWallFrame(wall: Wall): WallFrame {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const len = Math.hypot(dx, dy) || 1;
  const dir = new THREE.Vector3(dx / len, dy / len, 0);
  const perp = new THREE.Vector3(-dir.y, dir.x, 0);
  const angle = Math.atan2(dy, dx);
  return { dir, perp, angle, center: new THREE.Vector3(0, 0, 0), thickness: wall.thickness };
}

function openingWorldCenter(wall: Wall, opening: Opening): THREE.Vector3 {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const len = Math.hypot(dx, dy) || 1;
  const t = opening.position / len;
  return new THREE.Vector3(
    wall.startPoint.x + dx * t,
    wall.startPoint.y + dy * t,
    0
  );
}

// =============================================================================
// Door 3D Geometry - Realistic Construction Style
// =============================================================================

function createDoor3D(
  wall: Wall,
  opening: Opening,
  options?: OpeningRenderOptions,
): THREE.Group {
  const group = new THREE.Group();
  const wf = getWallFrame(wall);
  const center = openingWorldCenter(wall, opening);
  const halfW = opening.width / 2;
  const baseZ = wall.properties3D.baseElevation ?? 0;
  const doorHeight = opening.height || 2100;
  const frameDepth = wall.thickness;
  // Frame must be thick enough to be visible from isometric distance
  const frameThick = Math.max(60, wall.thickness * 0.25);
  const hingeSign = options?.swingDirection === 'right' ? 1 : -1;
  const openSideSign = options?.openSide === 'negative' ? -1 : 1;

  const frameTexture = createWoodGrainTexture(128, 256, DOOR_FRAME_COLOR, '#2a1808');
  const frameMaterial = new THREE.MeshStandardMaterial({
    map: frameTexture,
    color: DOOR_FRAME_COLOR,
    roughness: 0.75,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });

  // Left jamb
  const jambGeo = new THREE.BoxGeometry(frameThick, frameDepth, doorHeight);
  const leftJamb = new THREE.Mesh(jambGeo, frameMaterial);
  leftJamb.position.set(-halfW + frameThick / 2, 0, baseZ + doorHeight / 2);
  leftJamb.castShadow = true;
  leftJamb.receiveShadow = true;
  group.add(leftJamb);

  // Right jamb
  const rightJamb = new THREE.Mesh(jambGeo.clone(), frameMaterial.clone());
  rightJamb.position.set(halfW - frameThick / 2, 0, baseZ + doorHeight / 2);
  rightJamb.castShadow = true;
  rightJamb.receiveShadow = true;
  group.add(rightJamb);

  // Header (lintel)
  const headerH = Math.max(frameThick, 80);
  const headerGeo = new THREE.BoxGeometry(opening.width + 20, frameDepth, headerH);
  const header = new THREE.Mesh(headerGeo, frameMaterial.clone());
  header.position.set(0, 0, baseZ + doorHeight - headerH / 2);
  header.castShadow = true;
  group.add(header);

  // Door leaf — prominent panel with wood texture
  const leafWidth = opening.width - frameThick * 2;
  const leafHeight = doorHeight - headerH - 10;
  const leafThickness = Math.max(44, wall.thickness * 0.22);

  const panelTexture = createDoorPanelTexture(256, 512);
  // 6-face materials: +x, -x, +y, -y, +z (front), -z (back)
  const leafMaterials = [
    new THREE.MeshStandardMaterial({ color: DOOR_LEAF_COLOR_OUTER, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: DOOR_LEAF_COLOR_OUTER, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: '#6b4a2a', roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ color: '#6b4a2a', roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ map: panelTexture, roughness: 0.55 }),
    new THREE.MeshStandardMaterial({ map: panelTexture.clone(), color: DOOR_LEAF_COLOR_INNER, roughness: 0.55 }),
  ];

  const leafGeo = new THREE.BoxGeometry(leafWidth, leafThickness, leafHeight);
  const leaf = new THREE.Mesh(leafGeo, leafMaterials);
  leaf.castShadow = true;
  leaf.receiveShadow = true;

  // Pivot around hinge edge, ~15 degrees open
  const pivotGroup = new THREE.Group();
  pivotGroup.position.set(hingeSign * (halfW - frameThick), 0, 0);
  leaf.position.set(-hingeSign * (leafWidth / 2), 0, baseZ + leafHeight / 2 + 5);
  pivotGroup.add(leaf);
  pivotGroup.rotation.z = openSideSign * hingeSign * -0.26;
  group.add(pivotGroup);

  // Handle — oversized for visibility
  const handleZ = baseZ + doorHeight * 0.45;
  const handleX = -hingeSign * leafWidth * 0.7;
  const handleMat = new THREE.MeshStandardMaterial({
    color: DOOR_HANDLE_COLOR,
    roughness: 0.2,
    metalness: 0.9,
  });

  // Escutcheon plate
  const plateMesh = new THREE.Mesh(
    new THREE.BoxGeometry(40, leafThickness + 8, 100),
    new THREE.MeshStandardMaterial({ color: DOOR_HANDLE_BASE_COLOR, roughness: 0.25, metalness: 0.85 })
  );
  plateMesh.position.set(handleX, 0, handleZ);
  pivotGroup.add(plateMesh);

  // Front lever
  const leverMesh = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 90, 8), handleMat);
  leverMesh.rotation.x = Math.PI / 2;
  leverMesh.position.set(handleX, leafThickness / 2 + 45, handleZ);
  pivotGroup.add(leverMesh);

  // Back lever
  const leverBack = leverMesh.clone();
  leverBack.position.set(handleX, -(leafThickness / 2 + 45), handleZ);
  pivotGroup.add(leverBack);

  // Threshold
  const thresholdGeo = new THREE.BoxGeometry(opening.width, frameDepth + 20, 12);
  const thresholdMat = new THREE.MeshStandardMaterial({
    color: DOOR_THRESHOLD_COLOR,
    roughness: 0.6,
    metalness: 0.15,
  });
  const threshold = new THREE.Mesh(thresholdGeo, thresholdMat);
  threshold.position.set(0, 0, baseZ + 6);
  group.add(threshold);

  // Dark inner reveal (back of opening - gives depth)
  const revealDepth = wall.thickness * 0.8;
  const revealMat = new THREE.MeshStandardMaterial({ color: '#3a2a1a', roughness: 1, side: THREE.DoubleSide });
  // Left reveal
  const lReveal = new THREE.Mesh(
    new THREE.PlaneGeometry(doorHeight - headerH, revealDepth),
    revealMat
  );
  lReveal.position.set(-halfW + frameThick + 1, 0, baseZ + (doorHeight - headerH) / 2);
  lReveal.rotation.y = Math.PI / 2;
  group.add(lReveal);
  // Right reveal
  const rReveal = new THREE.Mesh(
    new THREE.PlaneGeometry(doorHeight - headerH, revealDepth),
    revealMat.clone()
  );
  rReveal.position.set(halfW - frameThick - 1, 0, baseZ + (doorHeight - headerH) / 2);
  rReveal.rotation.y = Math.PI / 2;
  group.add(rReveal);
  // Top reveal
  const tReveal = new THREE.Mesh(new THREE.PlaneGeometry(opening.width - frameThick * 2, revealDepth), revealMat.clone());
  tReveal.position.set(0, 0, baseZ + doorHeight - headerH - 1);
  group.add(tReveal);

  // Transform to wall orientation
  group.rotation.z = wf.angle;
  group.position.copy(center);

  return group;
}

// =============================================================================
// Window 3D Geometry - Modern Construction Style
// =============================================================================

function createWindow3D(
  wall: Wall,
  opening: Opening,
): THREE.Group {
  const group = new THREE.Group();
  const wf = getWallFrame(wall);
  const center = openingWorldCenter(wall, opening);
  const halfW = opening.width / 2;
  const baseZ = wall.properties3D.baseElevation ?? 0;
  const sillHeight = opening.sillHeight ?? 900;
  const windowHeight = opening.height || 1200;
  const frameDepth = wall.thickness;
  const frameThick = Math.max(50, wall.thickness * 0.2);
  const winBottom = baseZ + sillHeight;
  const winTop = winBottom + windowHeight;

  const frameMaterial = new THREE.MeshStandardMaterial({
    color: WINDOW_FRAME_COLOR,
    roughness: 0.35,
    metalness: 0.2,
    side: THREE.DoubleSide,
  });

  // Four-sided outer frame — thick enough to see
  // Left
  const jambGeo = new THREE.BoxGeometry(frameThick, frameDepth, windowHeight);
  const leftJamb = new THREE.Mesh(jambGeo, frameMaterial);
  leftJamb.position.set(-halfW + frameThick / 2, 0, winBottom + windowHeight / 2);
  leftJamb.castShadow = true;
  group.add(leftJamb);

  // Right
  const rightJamb = new THREE.Mesh(jambGeo.clone(), frameMaterial.clone());
  rightJamb.position.set(halfW - frameThick / 2, 0, winBottom + windowHeight / 2);
  rightJamb.castShadow = true;
  group.add(rightJamb);

  // Top
  const headerGeo = new THREE.BoxGeometry(opening.width + 10, frameDepth, frameThick);
  const header = new THREE.Mesh(headerGeo, frameMaterial.clone());
  header.position.set(0, 0, winTop - frameThick / 2);
  header.castShadow = true;
  group.add(header);

  // Bottom
  const bottomGeo = new THREE.BoxGeometry(opening.width + 10, frameDepth, frameThick);
  const bottom = new THREE.Mesh(bottomGeo, frameMaterial.clone());
  bottom.position.set(0, 0, winBottom + frameThick / 2);
  group.add(bottom);

  // Projecting sill
  const sillGeo = new THREE.BoxGeometry(opening.width + 80, frameDepth + 60, Math.max(30, frameThick * 0.7));
  const sillMat = new THREE.MeshStandardMaterial({ color: WINDOW_SILL_COLOR, roughness: 0.5, metalness: 0.1 });
  const sill = new THREE.Mesh(sillGeo, sillMat);
  sill.position.set(0, 20, winBottom - 5);
  sill.castShadow = true;
  group.add(sill);

  // Center mullion (vertical divider)
  const innerW = opening.width - frameThick * 2;
  const innerH = windowHeight - frameThick * 2;
  const mullionW = Math.max(25, frameThick * 0.4);
  const mullionGeo = new THREE.BoxGeometry(mullionW, frameDepth * 0.6, innerH);
  const mullionMat = new THREE.MeshStandardMaterial({ color: WINDOW_FRAME_ACCENT, roughness: 0.35, metalness: 0.2 });
  const mullion = new THREE.Mesh(mullionGeo, mullionMat);
  mullion.position.set(0, 0, winBottom + windowHeight / 2);
  group.add(mullion);

  // Horizontal transom
  if (windowHeight > 800) {
    const transomGeo = new THREE.BoxGeometry(innerW, frameDepth * 0.5, mullionW);
    const transom = new THREE.Mesh(transomGeo, mullionMat.clone());
    transom.position.set(0, 0, winBottom + windowHeight / 2);
    group.add(transom);
  }

  // Glass — single large pane with blue tint (very visible)
  const glassGeo = new THREE.BoxGeometry(innerW, 10, innerH);
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: WINDOW_GLASS_COLOR,
    transparent: true,
    opacity: WINDOW_GLASS_OPACITY,
    roughness: 0.02,
    metalness: 0.05,
    side: THREE.DoubleSide,
    depthWrite: false,
    transmission: 0.78,
    clearcoat: 0.35,
    clearcoatRoughness: 0.08,
  });
  const glass = new THREE.Mesh(glassGeo, glassMaterial);
  glass.position.set(0, 0, winBottom + windowHeight / 2);
  glass.renderOrder = 1;
  group.add(glass);

  // Dark inner reveal for depth
  const revealMat = new THREE.MeshStandardMaterial({ color: '#555555', roughness: 1, side: THREE.DoubleSide });
  const revealD = wall.thickness * 0.75;
  const lReveal = new THREE.Mesh(
    new THREE.PlaneGeometry(innerH, revealD),
    revealMat
  );
  lReveal.position.set(-halfW + frameThick + 1, 0, winBottom + windowHeight / 2);
  lReveal.rotation.y = Math.PI / 2;
  group.add(lReveal);
  const rReveal = new THREE.Mesh(
    new THREE.PlaneGeometry(innerH, revealD),
    revealMat.clone()
  );
  rReveal.position.set(halfW - frameThick - 1, 0, winBottom + windowHeight / 2);
  rReveal.rotation.y = Math.PI / 2;
  group.add(rReveal);

  // Transform to wall orientation
  group.rotation.z = wf.angle;
  group.position.copy(center);

  return group;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Create 3D geometry for a single opening in a wall.
 */
export function createOpening3D(wall: Wall, opening: Opening): THREE.Group {
  if (opening.type === 'door') {
    return createDoor3D(wall, opening);
  }
  return createWindow3D(wall, opening);
}

/**
 * Create 3D geometry for all openings in a wall.
 */
export function createWallOpenings3D(
  wall: Wall,
  optionsByOpeningId?: Record<string, OpeningRenderOptions>,
  openingsOverride?: Opening[]
): THREE.Group {
  const group = new THREE.Group();
  const openings = openingsOverride ?? wall.openings;
  for (const opening of openings) {
    const openingMesh = opening.type === 'door'
      ? createDoor3D(wall, opening, optionsByOpeningId?.[opening.id])
      : createWindow3D(wall, opening);
    group.add(openingMesh);
  }
  return group;
}

/**
 * Create a THREE.Shape hole for an opening (to subtract from wall extrusion).
 */
export function createOpeningHolePath(
  wall: Wall,
  opening: Opening,
): { position: number; width: number; bottomZ: number; topZ: number } {
  const baseZ = wall.properties3D.baseElevation ?? 0;
  const sillHeight = opening.type === 'window' ? (opening.sillHeight ?? 900) : 0;
  const bottomZ = baseZ + sillHeight;
  const topZ = bottomZ + (opening.height || (opening.type === 'door' ? 2100 : 1200));
  return {
    position: opening.position,
    width: opening.width,
    bottomZ,
    topZ,
  };
}
