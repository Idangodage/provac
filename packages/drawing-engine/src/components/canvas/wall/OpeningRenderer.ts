/**
 * OpeningRenderer
 *
 * Professional architectural 2D plan-view rendering for wall openings
 * (doors, windows, etc.). Renders symbols that auto-adapt to wall
 * thickness and orientation — following ISO/BS standards for
 * architectural drawing symbols.
 *
 * Symbols are drawn in WALL-LOCAL space then transformed to canvas:
 *   - Origin at opening center on the wall center-line
 *   - X axis along wall direction
 *   - Y axis perpendicular to wall (positive = interior side)
 *
 * All dimensions in millimeters, converted to canvas pixels via MM_TO_PX.
 */

import * as fabric from 'fabric';

import type { Point2D, Wall, Opening } from '../../../types';
import { readDoorOpenSide } from '../../../utils/doorSwing';
import { MM_TO_PX } from '../scale';

// =============================================================================
// Types
// =============================================================================

export interface OpeningRenderResult {
  /** Fabric objects to add (already positioned in canvas space) */
  objects: fabric.FabricObject[];
  /** The wall-body mask polygon vertices (to cut from wall fill) in canvas px */
  cutoutVertices: Point2D[];
}

interface WallLocalFrame {
  /** Wall center-line start in mm */
  start: Point2D;
  /** Wall direction unit vector */
  dir: Point2D;
  /** Perpendicular unit vector (interior side) */
  perp: Point2D;
  /** Wall angle in radians */
  angle: number;
  /** Wall thickness in mm */
  thickness: number;
}

// =============================================================================
// Constants
// =============================================================================

const DOOR_STROKE = '#0b0b0b';
const DOOR_ARC_STROKE = '#2b160b';
const DOOR_ARC_STROKE_WIDTH = 1.2;
const WINDOW_FRAME_STROKE = '#1f2937';
const WINDOW_GLASS_FILL = 'rgba(243,244,246,0.75)';
const WINDOW_GLASS_STROKE = '#4b5563';
const OPENING_GAP_FILL = '#FFFFFF';
const BIFOLD_STROKE = '#555555';
const SLIDING_TRACK_STROKE = '#888888';
const ARC_SAMPLES = 48;

type OpeningDecoratedObject = fabric.FabricObject & { openingId?: string; isDoorArc?: boolean };

// =============================================================================
// Geometry helpers
// =============================================================================

function wallLocalFrame(wall: Wall): WallLocalFrame {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const len = Math.hypot(dx, dy) || 1;
  const dir = { x: dx / len, y: dy / len };
  const perp = { x: -dir.y, y: dir.x };
  const angle = Math.atan2(dy, dx);
  return { start: wall.startPoint, dir, perp, angle, thickness: wall.thickness };
}

function openingCenter(wall: Wall, opening: Opening): Point2D {
  const frame = wallLocalFrame(wall);
  return {
    x: frame.start.x + frame.dir.x * opening.position,
    y: frame.start.y + frame.dir.y * opening.position,
  };
}

function openingCutoutVertices(wall: Wall, opening: Opening): Point2D[] {
  const frame = wallLocalFrame(wall);
  const center = openingCenter(wall, opening);
  const halfW = opening.width / 2;
  const halfT = frame.thickness / 2 + 2; // slight overcut for clean render

  // Four corners of the cutout rectangle
  return [
    {
      x: (center.x - frame.dir.x * halfW - frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * halfW - frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * halfW - frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * halfW - frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * halfW + frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * halfW + frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x - frame.dir.x * halfW + frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * halfW + frame.perp.y * halfT) * MM_TO_PX,
    },
  ];
}

function doorGapMask(wall: Wall, opening: Opening): fabric.Polygon {
  return new fabric.Polygon(openingCutoutVertices(wall, opening), {
    fill: OPENING_GAP_FILL,
    stroke: '#d4d4d8',
    strokeWidth: 1.2,
    selectable: false,
    evented: false,
  });
}

// =============================================================================
// Door Renderers (professional architectural plan symbols)
// =============================================================================

function renderSingleSwingDoor(
  wall: Wall,
  opening: Opening,
  swingDirection: 'left' | 'right' = 'left',
  openSide: 'positive' | 'negative' = 'positive'
): OpeningRenderResult {
  const frame = wallLocalFrame(wall);
  const center = openingCenter(wall, opening);
  const halfW = opening.width / 2;
  const halfT = frame.thickness / 2;
  const objects: fabric.FabricObject[] = [doorGapMask(wall, opening)];

  // Wall break lines (two short lines at opening edges through wall thickness)
  const breakLineConfigs = [-halfW, halfW];
  for (const offset of breakLineConfigs) {
    const bx = (center.x + frame.dir.x * offset) * MM_TO_PX;
    const by = (center.y + frame.dir.y * offset) * MM_TO_PX;
    const dx = frame.perp.x * halfT * MM_TO_PX;
    const dy = frame.perp.y * halfT * MM_TO_PX;
    objects.push(new fabric.Line([bx - dx, by - dy, bx + dx, by + dy], {
      stroke: DOOR_STROKE,
      strokeWidth: 2.6,
      selectable: false,
      evented: false,
    }));
  }

  // Door leaf and swing arc start from the wall centerline (mid-thickness).
  const leafPerpOffset = 0;
  const openSideSign = openSide === 'negative' ? -1 : 1;

  // Door leaf in closed position from hinge pivot to opposite jamb.
  const pivotSide = swingDirection === 'left' ? -1 : 1;
  const pivotX = pivotSide * halfW;
  const leafStartPx = {
    x: (center.x + frame.dir.x * pivotX + frame.perp.x * leafPerpOffset) * MM_TO_PX,
    y: (center.y + frame.dir.y * pivotX + frame.perp.y * leafPerpOffset) * MM_TO_PX,
  };
  const openEndLocal = {
    x: pivotX,
    y: leafPerpOffset + openSideSign * opening.width,
  };
  const leafEndPx = {
    x: (center.x + frame.dir.x * openEndLocal.x + frame.perp.x * openEndLocal.y) * MM_TO_PX,
    y: (center.y + frame.dir.y * openEndLocal.x + frame.perp.y * openEndLocal.y) * MM_TO_PX,
  };
  const leafLine = new fabric.Line([leafStartPx.x, leafStartPx.y, leafEndPx.x, leafEndPx.y], {
    stroke: DOOR_ARC_STROKE,
    strokeWidth: DOOR_ARC_STROKE_WIDTH,
    strokeUniform: true,
    strokeLineCap: 'round',
    selectable: false,
    evented: false,
  });
  (leafLine as OpeningDecoratedObject).isDoorArc = true;
  objects.push(leafLine);

  // Quarter swing arc from closed endpoint to open endpoint.
  const arcPoints: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const theta = (i / ARC_SAMPLES) * (Math.PI / 2);
    const xLocal = pivotSide === -1
      ? pivotX + Math.cos(theta) * opening.width
      : pivotX - Math.cos(theta) * opening.width;
    const yLocal = leafPerpOffset + openSideSign * Math.sin(theta) * opening.width;
    arcPoints.push({
      x: (center.x + frame.dir.x * xLocal + frame.perp.x * yLocal) * MM_TO_PX,
      y: (center.y + frame.dir.y * xLocal + frame.perp.y * yLocal) * MM_TO_PX,
    });
  }

  const swingArc = new fabric.Polyline(arcPoints, {
    fill: 'transparent',
    stroke: DOOR_ARC_STROKE,
    strokeWidth: DOOR_ARC_STROKE_WIDTH,
    strokeUniform: true,
    opacity: 1,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    selectable: false,
    evented: false,
  });
  (swingArc as OpeningDecoratedObject).isDoorArc = true;
  objects.push(swingArc);

  return {
    objects,
    cutoutVertices: openingCutoutVertices(wall, opening),
  };
}

function renderDoubleSwingDoor(
  wall: Wall,
  opening: Opening,
  openSide: 'positive' | 'negative' = 'positive'
): OpeningRenderResult {
  const frame = wallLocalFrame(wall);
  const center = openingCenter(wall, opening);
  const halfW = opening.width / 2;
  const halfT = frame.thickness / 2;
  const halfLeaf = opening.width / 2;
  const objects: fabric.FabricObject[] = [doorGapMask(wall, opening)];

  // Wall break lines at edges
  for (const offset of [-halfW, halfW]) {
    const bx = (center.x + frame.dir.x * offset) * MM_TO_PX;
    const by = (center.y + frame.dir.y * offset) * MM_TO_PX;
    const dx = frame.perp.x * halfT * MM_TO_PX;
    const dy = frame.perp.y * halfT * MM_TO_PX;
    objects.push(new fabric.Line([bx - dx, by - dy, bx + dx, by + dy], {
      stroke: DOOR_STROKE,
      strokeWidth: 2.6,
      selectable: false,
      evented: false,
    }));
  }

  // Door leaves and arcs start from the wall centerline (mid-thickness).
  const leafPerpOffset = 0;
  const openSideSign = openSide === 'negative' ? -1 : 1;

  // Two leaves, each half-width, both swing to interior
  for (const side of [-1, 1] as const) {
    const pivotOffset = side * halfW;
    const leafStart = {
      x: (center.x + frame.dir.x * pivotOffset + frame.perp.x * leafPerpOffset) * MM_TO_PX,
      y: (center.y + frame.dir.y * pivotOffset + frame.perp.y * leafPerpOffset) * MM_TO_PX,
    };
    const leafEnd = {
      x: (center.x + frame.dir.x * pivotOffset + frame.perp.x * (leafPerpOffset + openSideSign * halfLeaf)) * MM_TO_PX,
      y: (center.y + frame.dir.y * pivotOffset + frame.perp.y * (leafPerpOffset + openSideSign * halfLeaf)) * MM_TO_PX,
    };
    const leafLine = new fabric.Line([leafStart.x, leafStart.y, leafEnd.x, leafEnd.y], {
      stroke: DOOR_ARC_STROKE,
      strokeWidth: DOOR_ARC_STROKE_WIDTH,
      strokeUniform: true,
      strokeLineCap: 'round',
      selectable: false,
      evented: false,
    });
    (leafLine as OpeningDecoratedObject).isDoorArc = true;
    objects.push(leafLine);

    // Swing arc
    const arcPoints: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= ARC_SAMPLES; i++) {
      const theta = (i / ARC_SAMPLES) * (Math.PI / 2);
      const xLocal = side === -1
        ? pivotOffset + Math.cos(theta) * halfLeaf
        : pivotOffset - Math.cos(theta) * halfLeaf;
      const yLocal = leafPerpOffset + openSideSign * Math.sin(theta) * halfLeaf;
      arcPoints.push({
        x: (center.x + frame.dir.x * xLocal + frame.perp.x * yLocal) * MM_TO_PX,
        y: (center.y + frame.dir.y * xLocal + frame.perp.y * yLocal) * MM_TO_PX,
      });
    }
    const swingArc = new fabric.Polyline(arcPoints, {
      fill: 'transparent',
      stroke: DOOR_ARC_STROKE,
      strokeWidth: DOOR_ARC_STROKE_WIDTH,
      strokeUniform: true,
      opacity: 1,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      selectable: false,
      evented: false,
    });
    (swingArc as OpeningDecoratedObject).isDoorArc = true;
    objects.push(swingArc);
  }

  return {
    objects,
    cutoutVertices: openingCutoutVertices(wall, opening),
  };
}

function renderSlidingDoor(
  wall: Wall,
  opening: Opening,
): OpeningRenderResult {
  const frame = wallLocalFrame(wall);
  const center = openingCenter(wall, opening);
  const halfW = opening.width / 2;
  const halfT = frame.thickness / 2;
  const objects: fabric.FabricObject[] = [doorGapMask(wall, opening)];
  const trackOffset = frame.thickness * 0.15; // offset between tracks

  // Wall break lines
  for (const offset of [-halfW, halfW]) {
    const bx = (center.x + frame.dir.x * offset) * MM_TO_PX;
    const by = (center.y + frame.dir.y * offset) * MM_TO_PX;
    const dx = frame.perp.x * halfT * MM_TO_PX;
    const dy = frame.perp.y * halfT * MM_TO_PX;
    objects.push(new fabric.Line([bx - dx, by - dy, bx + dx, by + dy], {
      stroke: DOOR_STROKE,
      strokeWidth: 2.6,
      selectable: false,
      evented: false,
    }));
  }

  // Two sliding panels (parallel lines with slight perpendicular offset)
  for (const perpOffset of [-trackOffset, trackOffset]) {
    const p1x = (center.x - frame.dir.x * halfW * 0.9 + frame.perp.x * perpOffset) * MM_TO_PX;
    const p1y = (center.y - frame.dir.y * halfW * 0.9 + frame.perp.y * perpOffset) * MM_TO_PX;
    const p2x = (center.x + frame.dir.x * halfW * 0.9 + frame.perp.x * perpOffset) * MM_TO_PX;
    const p2y = (center.y + frame.dir.y * halfW * 0.9 + frame.perp.y * perpOffset) * MM_TO_PX;
    objects.push(new fabric.Line([p1x, p1y, p2x, p2y], {
      stroke: SLIDING_TRACK_STROKE,
      strokeWidth: 2.6,
      selectable: false,
      evented: false,
    }));
  }

  // Direction arrows (small triangles at panel ends)
  const arrowSize = Math.min(opening.width * 0.06, 30) * MM_TO_PX;
  for (const [side, perpOff] of [[-1, -trackOffset], [1, trackOffset]] as const) {
    const tipX = (center.x + frame.dir.x * halfW * 0.85 * side + frame.perp.x * perpOff) * MM_TO_PX;
    const tipY = (center.y + frame.dir.y * halfW * 0.85 * side + frame.perp.y * perpOff) * MM_TO_PX;
    const baseX = tipX - frame.dir.x * arrowSize * side;
    const baseY = tipY - frame.dir.y * arrowSize * side;
    objects.push(new fabric.Polygon([
      { x: tipX, y: tipY },
      { x: baseX + frame.perp.x * arrowSize * 0.4, y: baseY + frame.perp.y * arrowSize * 0.4 },
      { x: baseX - frame.perp.x * arrowSize * 0.4, y: baseY - frame.perp.y * arrowSize * 0.4 },
    ], {
      fill: SLIDING_TRACK_STROKE,
      stroke: 'transparent',
      selectable: false,
      evented: false,
    }));
  }

  return {
    objects,
    cutoutVertices: openingCutoutVertices(wall, opening),
  };
}

function renderBifoldDoor(
  wall: Wall,
  opening: Opening,
): OpeningRenderResult {
  const frame = wallLocalFrame(wall);
  const center = openingCenter(wall, opening);
  const halfW = opening.width / 2;
  const halfT = frame.thickness / 2;
  const objects: fabric.FabricObject[] = [doorGapMask(wall, opening)];
  const panelCount = opening.width > 1000 ? 4 : 2;
  const panelWidth = opening.width / panelCount;

  // Wall break lines
  for (const offset of [-halfW, halfW]) {
    const bx = (center.x + frame.dir.x * offset) * MM_TO_PX;
    const by = (center.y + frame.dir.y * offset) * MM_TO_PX;
    const dx = frame.perp.x * halfT * MM_TO_PX;
    const dy = frame.perp.y * halfT * MM_TO_PX;
    objects.push(new fabric.Line([bx - dx, by - dy, bx + dx, by + dy], {
      stroke: DOOR_STROKE,
      strokeWidth: 2.6,
      selectable: false,
      evented: false,
    }));
  }

  // Bi-fold panels shown as zigzag lines (partially folded)
  const foldDepth = frame.thickness * 0.6;
  for (let i = 0; i < panelCount; i++) {
    const panelStart = -halfW + i * panelWidth;
    const panelEnd = panelStart + panelWidth;
    const panelMid = (panelStart + panelEnd) / 2;
    const perpSign = i % 2 === 0 ? 1 : -1;

    const p1 = {
      x: (center.x + frame.dir.x * panelStart) * MM_TO_PX,
      y: (center.y + frame.dir.y * panelStart) * MM_TO_PX,
    };
    const pMid = {
      x: (center.x + frame.dir.x * panelMid + frame.perp.x * foldDepth * perpSign) * MM_TO_PX,
      y: (center.y + frame.dir.y * panelMid + frame.perp.y * foldDepth * perpSign) * MM_TO_PX,
    };
    const p2 = {
      x: (center.x + frame.dir.x * panelEnd) * MM_TO_PX,
      y: (center.y + frame.dir.y * panelEnd) * MM_TO_PX,
    };

    objects.push(new fabric.Polyline([p1, pMid, p2], {
      fill: 'transparent',
      stroke: BIFOLD_STROKE,
      strokeWidth: 2,
      selectable: false,
      evented: false,
    }));
  }

  return {
    objects,
    cutoutVertices: openingCutoutVertices(wall, opening),
  };
}

// =============================================================================
// Window Renderers (professional architectural plan symbols)
// =============================================================================

function renderCasementWindow(
  wall: Wall,
  opening: Opening,
): OpeningRenderResult {
  const frame = wallLocalFrame(wall);
  const center = openingCenter(wall, opening);
  const halfW = opening.width / 2;
  const halfT = frame.thickness / 2;
  const objects: fabric.FabricObject[] = [];

  // Outer frame rectangle (fills wall thickness)
  const frameVerts = [
    {
      x: (center.x - frame.dir.x * halfW - frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * halfW - frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * halfW - frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * halfW - frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * halfW + frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * halfW + frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x - frame.dir.x * halfW + frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * halfW + frame.perp.y * halfT) * MM_TO_PX,
    },
  ];

  objects.push(new fabric.Polygon(frameVerts, {
    fill: OPENING_GAP_FILL,
    stroke: WINDOW_FRAME_STROKE,
    strokeWidth: 2.2,
    selectable: false,
    evented: false,
  }));

  // Glass pane (inner rectangle, slightly inset)
  const inset = Math.min(frame.thickness * 0.15, 20);
  const glassHalfW = halfW - inset * 0.3;
  const glassHalfT = halfT - inset;
  const glassVerts = [
    {
      x: (center.x - frame.dir.x * glassHalfW - frame.perp.x * glassHalfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * glassHalfW - frame.perp.y * glassHalfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * glassHalfW - frame.perp.x * glassHalfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * glassHalfW - frame.perp.y * glassHalfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * glassHalfW + frame.perp.x * glassHalfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * glassHalfW + frame.perp.y * glassHalfT) * MM_TO_PX,
    },
    {
      x: (center.x - frame.dir.x * glassHalfW + frame.perp.x * glassHalfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * glassHalfW + frame.perp.y * glassHalfT) * MM_TO_PX,
    },
  ];
  objects.push(new fabric.Polygon(glassVerts, {
    fill: WINDOW_GLASS_FILL,
    stroke: WINDOW_GLASS_STROKE,
    strokeWidth: 1.5,
    selectable: false,
    evented: false,
  }));

  // Center mullion line (perpendicular through center of glass)
  objects.push(new fabric.Line([
    (center.x - frame.perp.x * glassHalfT) * MM_TO_PX,
    (center.y - frame.perp.y * glassHalfT) * MM_TO_PX,
    (center.x + frame.perp.x * glassHalfT) * MM_TO_PX,
    (center.y + frame.perp.y * glassHalfT) * MM_TO_PX,
  ], {
    stroke: WINDOW_FRAME_STROKE,
    strokeWidth: 1.5,
    selectable: false,
    evented: false,
  }));

  // Opening indicator lines (diagonal from corners to center, showing casement swing)
  const diagCorners = [
    { x: -glassHalfW, y: -glassHalfT },
    { x: -glassHalfW, y: glassHalfT },
  ];
  for (const corner of diagCorners) {
    const cx2 = (center.x + frame.dir.x * corner.x + frame.perp.x * corner.y) * MM_TO_PX;
    const cy2 = (center.y + frame.dir.y * corner.x + frame.perp.y * corner.y) * MM_TO_PX;
    const midX = center.x * MM_TO_PX;
    const midY = center.y * MM_TO_PX;
    objects.push(new fabric.Line([cx2, cy2, midX, midY], {
      stroke: WINDOW_GLASS_STROKE,
      strokeWidth: 1.2,
      strokeDashArray: [3, 3],
      selectable: false,
      evented: false,
    }));
  }

  return {
    objects,
    cutoutVertices: openingCutoutVertices(wall, opening),
  };
}

function renderSlidingWindow(
  wall: Wall,
  opening: Opening,
): OpeningRenderResult {
  const frame = wallLocalFrame(wall);
  const center = openingCenter(wall, opening);
  const halfW = opening.width / 2;
  const halfT = frame.thickness / 2;
  const objects: fabric.FabricObject[] = [];

  // Outer frame
  const frameVerts = [
    {
      x: (center.x - frame.dir.x * halfW - frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * halfW - frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * halfW - frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * halfW - frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * halfW + frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * halfW + frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x - frame.dir.x * halfW + frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * halfW + frame.perp.y * halfT) * MM_TO_PX,
    },
  ];
  objects.push(new fabric.Polygon(frameVerts, {
    fill: OPENING_GAP_FILL,
    stroke: WINDOW_FRAME_STROKE,
    strokeWidth: 2.2,
    selectable: false,
    evented: false,
  }));

  // Two glass panes (side by side) with slight overlap showing sliding action
  const paneGap = frame.thickness * 0.08;
  for (const [side, perpOff] of [[-1, -paneGap], [1, paneGap]] as const) {
    const paneHalfW = halfW * 0.52;
    const paneCenter = center.x + frame.dir.x * halfW * 0.25 * side;
    const paneCenterY = center.y + frame.dir.y * halfW * 0.25 * side;
    const inset = Math.min(frame.thickness * 0.12, 15);
    const paneHalfT = halfT - inset;

    const paneVerts = [
      {
        x: (paneCenter + frame.dir.x * (-paneHalfW) + frame.perp.x * (-paneHalfT + perpOff)) * MM_TO_PX,
        y: (paneCenterY + frame.dir.y * (-paneHalfW) + frame.perp.y * (-paneHalfT + perpOff)) * MM_TO_PX,
      },
      {
        x: (paneCenter + frame.dir.x * paneHalfW + frame.perp.x * (-paneHalfT + perpOff)) * MM_TO_PX,
        y: (paneCenterY + frame.dir.y * paneHalfW + frame.perp.y * (-paneHalfT + perpOff)) * MM_TO_PX,
      },
      {
        x: (paneCenter + frame.dir.x * paneHalfW + frame.perp.x * (paneHalfT + perpOff)) * MM_TO_PX,
        y: (paneCenterY + frame.dir.y * paneHalfW + frame.perp.y * (paneHalfT + perpOff)) * MM_TO_PX,
      },
      {
        x: (paneCenter + frame.dir.x * (-paneHalfW) + frame.perp.x * (paneHalfT + perpOff)) * MM_TO_PX,
        y: (paneCenterY + frame.dir.y * (-paneHalfW) + frame.perp.y * (paneHalfT + perpOff)) * MM_TO_PX,
      },
    ];
    objects.push(new fabric.Polygon(paneVerts, {
      fill: WINDOW_GLASS_FILL,
      stroke: WINDOW_GLASS_STROKE,
      strokeWidth: 1.5,
      selectable: false,
      evented: false,
    }));
  }

  return {
    objects,
    cutoutVertices: openingCutoutVertices(wall, opening),
  };
}

function renderFixedWindow(
  wall: Wall,
  opening: Opening,
): OpeningRenderResult {
  const frame = wallLocalFrame(wall);
  const center = openingCenter(wall, opening);
  const halfW = opening.width / 2;
  const halfT = frame.thickness / 2;
  const objects: fabric.FabricObject[] = [];

  // Outer frame
  const frameVerts = [
    {
      x: (center.x - frame.dir.x * halfW - frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * halfW - frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * halfW - frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * halfW - frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * halfW + frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * halfW + frame.perp.y * halfT) * MM_TO_PX,
    },
    {
      x: (center.x - frame.dir.x * halfW + frame.perp.x * halfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * halfW + frame.perp.y * halfT) * MM_TO_PX,
    },
  ];

  objects.push(new fabric.Polygon(frameVerts, {
    fill: OPENING_GAP_FILL,
    stroke: WINDOW_FRAME_STROKE,
    strokeWidth: 2.2,
    selectable: false,
    evented: false,
  }));

  // Single glass pane (fills most of the frame)
  const inset = Math.min(frame.thickness * 0.15, 18);
  const glassHalfW = halfW - inset * 0.3;
  const glassHalfT = halfT - inset;

  const glassVerts = [
    {
      x: (center.x - frame.dir.x * glassHalfW - frame.perp.x * glassHalfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * glassHalfW - frame.perp.y * glassHalfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * glassHalfW - frame.perp.x * glassHalfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * glassHalfW - frame.perp.y * glassHalfT) * MM_TO_PX,
    },
    {
      x: (center.x + frame.dir.x * glassHalfW + frame.perp.x * glassHalfT) * MM_TO_PX,
      y: (center.y + frame.dir.y * glassHalfW + frame.perp.y * glassHalfT) * MM_TO_PX,
    },
    {
      x: (center.x - frame.dir.x * glassHalfW + frame.perp.x * glassHalfT) * MM_TO_PX,
      y: (center.y - frame.dir.y * glassHalfW + frame.perp.y * glassHalfT) * MM_TO_PX,
    },
  ];
  objects.push(new fabric.Polygon(glassVerts, {
    fill: WINDOW_GLASS_FILL,
    stroke: WINDOW_GLASS_STROKE,
    strokeWidth: 1.5,
    selectable: false,
    evented: false,
  }));

  // Cross pattern (X) indicating fixed glass
  objects.push(new fabric.Line([glassVerts[0].x, glassVerts[0].y, glassVerts[2].x, glassVerts[2].y], {
    stroke: WINDOW_GLASS_STROKE,
    strokeWidth: 1,
    strokeDashArray: [3, 4],
    selectable: false,
    evented: false,
  }));
  objects.push(new fabric.Line([glassVerts[1].x, glassVerts[1].y, glassVerts[3].x, glassVerts[3].y], {
    stroke: WINDOW_GLASS_STROKE,
    strokeWidth: 1,
    strokeDashArray: [3, 4],
    selectable: false,
    evented: false,
  }));

  return {
    objects,
    cutoutVertices: openingCutoutVertices(wall, opening),
  };
}

// =============================================================================
// Public API: render an opening based on its type and associated definition
// =============================================================================

/**
 * Determine the sub-type of a door/window from the symbol properties.
 * Falls back to 'single-swing' for doors and 'casement' for windows.
 */
function resolveOpeningKind(
  opening: Opening,
  symbolProps?: Record<string, unknown>,
): 'door' | 'window' {
  const category = typeof symbolProps?.category === 'string'
    ? symbolProps.category.toLowerCase()
    : '';
  if (category === 'doors') return 'door';
  if (category === 'windows') return 'window';
  return opening.type === 'window' ? 'window' : 'door';
}

function resolveOpeningSubType(
  openingKind: 'door' | 'window',
  symbolProps?: Record<string, unknown>
): string {
  const definitionType = symbolProps?.type as string | undefined;
  if (definitionType) return definitionType;
  return openingKind === 'door' ? 'single-swing' : 'casement';
}

export function renderOpening(
  wall: Wall,
  opening: Opening,
  symbolProps?: Record<string, unknown>,
): OpeningRenderResult {
  const openingKind = resolveOpeningKind(opening, symbolProps);
  const subType = resolveOpeningSubType(openingKind, symbolProps);
  const swingDirection = (symbolProps?.swingDirection as 'left' | 'right') ?? 'left';
  const doorOpenSide = readDoorOpenSide(symbolProps);

  if (openingKind === 'door') {
    switch (subType) {
      case 'double-swing':
        return renderDoubleSwingDoor(wall, opening, doorOpenSide);
      case 'sliding':
        return renderSlidingDoor(wall, opening);
      case 'bi-fold':
        return renderBifoldDoor(wall, opening);
      default:
        return renderSingleSwingDoor(wall, opening, swingDirection, doorOpenSide);
    }
  }

  // Window types
  switch (subType) {
    case 'sliding':
      return renderSlidingWindow(wall, opening);
    case 'fixed':
      return renderFixedWindow(wall, opening);
    case 'awning':
      return renderCasementWindow(wall, opening); // awning uses similar symbol
    default:
      return renderCasementWindow(wall, opening);
  }
}

/**
 * Render all openings on a wall.
 * Returns combined Fabric objects and cutout polygons.
 */
export function renderWallOpenings(
  wall: Wall,
  symbolInstances?: Map<string, { properties: Record<string, unknown> }>,
): { objects: fabric.FabricObject[]; cutouts: Point2D[][] } {
  const allObjects: fabric.FabricObject[] = [];
  const allCutouts: Point2D[][] = [];

  for (const opening of wall.openings) {
    const symbolProps = symbolInstances?.get(opening.id)?.properties;
    const result = renderOpening(wall, opening, symbolProps);
    for (const object of result.objects) {
      (object as OpeningDecoratedObject).openingId = opening.id;
    }
    allObjects.push(...result.objects);
    allCutouts.push(result.cutoutVertices);
  }

  return { objects: allObjects, cutouts: allCutouts };
}

/**
 * Render a preview opening (ghost/semi-transparent) for placement preview.
 */
export function renderOpeningPreview(
  wall: Wall,
  opening: Opening,
  symbolProps?: Record<string, unknown>,
): fabric.FabricObject[] {
  return renderOpening(wall, opening, symbolProps).objects;
}
