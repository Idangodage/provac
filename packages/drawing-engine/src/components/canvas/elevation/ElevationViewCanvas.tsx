/**
 * ElevationViewCanvas
 *
 * A React + Fabric.js canvas component that renders architectural elevation views.
 * Displays projected walls, openings (doors/windows), HVAC elements,
 * ground line, grid, dimension annotations, and section reference markers.
 */

'use client';

import * as fabric from 'fabric';
import { useEffect, useRef, useCallback, useState } from 'react';

import type {
  ElevationFurnitureProjection,
  ElevationHvacProjection,
  ElevationSettings,
  ElevationView,
  ElevationViewKind,
  ElevationWallProjection,
  SectionLine,
} from '../../../types';
import { MM_TO_PX } from '../scale';
import { renderFurnitureFront, renderFurnitureEnd, hasRenderer } from '../object/FurnitureSymbolRenderer';

// =============================================================================
// Types
// =============================================================================

export interface ElevationViewCanvasProps {
  className?: string;
  elevationView: ElevationView | null;
  elevationSettings: ElevationSettings;
  /** The other section line (for cross-reference markers) */
  crossReferenceSectionLine?: SectionLine | null;
  /** Room ceiling height in mm (for reference) */
  roomHeightMm?: number;
  /** Label to display, e.g. "FRONT ELEVATION (X-X)" */
  viewLabel?: string;
  onCanvasReady?: (canvas: fabric.Canvas) => void;
}

// =============================================================================
// Constants
// =============================================================================

const MARGIN = 80;
const GROUND_LINE_Y_OFFSET = 30;
const WALL_FILL_COLOR = '#E8E8E8';
const WALL_STROKE_COLOR = '#333333';
const WALL_CUT_FILL = '#D0D0D0';
const OPENING_DOOR_FILL = '#FFFFFF';
const OPENING_WINDOW_FILL = '#D4EAFF';
const OPENING_WINDOW_STROKE = '#6AABDF';
const HVAC_FILL = 'rgba(42,127,255,0.15)';
const HVAC_STROKE = 'rgba(42,127,255,0.7)';
const HVAC_GHOST_FILL = 'rgba(42,127,255,0.05)';
const HVAC_GHOST_STROKE = 'rgba(42,127,255,0.25)';
const HVAC_CUT_FILL = 'rgba(232,144,10,0.2)';
const HVAC_CUT_STROKE = '#e8900a';
const GRID_COLOR = '#E8E8E8';
const GROUND_LINE_COLOR = '#666666';
const DIMENSION_COLOR = '#555555';
const LABEL_COLOR = '#444444';

// =============================================================================
// Component
// =============================================================================

export function ElevationViewCanvas({
  className = '',
  elevationView,
  elevationSettings,
  crossReferenceSectionLine,
  roomHeightMm = 2700,
  viewLabel,
  onCanvasReady,
}: ElevationViewCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });

  // Initialize Fabric canvas
  useEffect(() => {
    if (!canvasRef.current || fabricRef.current) return;

    const canvas = new fabric.Canvas(canvasRef.current, {
      backgroundColor: '#FAFAFA',
      selection: false,
      renderOnAddRemove: false,
    });
    fabricRef.current = canvas;
    onCanvasReady?.(canvas);

    return () => {
      canvas.dispose();
      fabricRef.current = null;
    };
  }, [onCanvasReady]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerSize({ width: Math.floor(width), height: Math.floor(height) });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Resize canvas
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.setDimensions(
      { width: containerSize.width, height: containerSize.height },
      { cssOnly: false }
    );
  }, [containerSize]);

  // Main render function
  const renderElevation = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;

    // Clear all objects
    canvas.clear();
    canvas.backgroundColor = '#FAFAFA';

    if (!elevationView) {
      // Draw "no data" placeholder
      const placeholder = new fabric.Text('No elevation data', {
        left: containerSize.width / 2,
        top: containerSize.height / 2,
        fontSize: 14,
        fill: '#999',
        fontFamily: 'monospace',
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      canvas.add(placeholder);
      canvas.requestRenderAll();
      return;
    }

    const { walls, hvacElements: hvacProjections, furnitureElements: furnitureProjections, minX, maxX, maxHeightMm } = elevationView;

    // Compute scale to fit the elevation in the available area
    const availW = containerSize.width - MARGIN * 2;
    const availH = containerSize.height - MARGIN * 2 - GROUND_LINE_Y_OFFSET;
    const elevWidth = Math.max(1, maxX - minX);
    const elevHeight = Math.max(1, maxHeightMm);
    const scale = Math.min(availW / (elevWidth * MM_TO_PX), availH / (elevHeight * MM_TO_PX));

    // Origin: bottom-left of the elevation = ground line at floor level
    const originX = MARGIN + (availW - elevWidth * MM_TO_PX * scale) / 2;
    const originY = containerSize.height - MARGIN - GROUND_LINE_Y_OFFSET;

    // World-to-screen helpers
    const wx = (worldX: number) => originX + (worldX - minX) * MM_TO_PX * scale;
    const wy = (worldY: number) => originY - worldY * MM_TO_PX * scale;

    // ── Grid
    if (elevationSettings.showGroundLine) {
      const gridStep = elevationView.gridIncrementMm;
      // Vertical grid lines
      for (let x = Math.ceil(minX / gridStep) * gridStep; x <= maxX; x += gridStep) {
        const sx = wx(x);
        const gridLine = new fabric.Line([sx, wy(0), sx, wy(maxHeightMm)], {
          stroke: GRID_COLOR,
          strokeWidth: 0.5,
          selectable: false,
          evented: false,
        });
        canvas.add(gridLine);
      }
      // Horizontal grid lines
      for (let y = 0; y <= maxHeightMm; y += gridStep) {
        const sy = wy(y);
        const gridLine = new fabric.Line([wx(minX), sy, wx(maxX), sy], {
          stroke: GRID_COLOR,
          strokeWidth: 0.5,
          selectable: false,
          evented: false,
        });
        canvas.add(gridLine);
      }
    }

    // ── Ground line
    const groundY = wy(0);
    const groundLine = new fabric.Line(
      [originX - 20, groundY, wx(maxX) + 20, groundY],
      {
        stroke: GROUND_LINE_COLOR,
        strokeWidth: 2,
        selectable: false,
        evented: false,
      }
    );
    canvas.add(groundLine);

    // Ground level label
    const groundLabel = new fabric.Text('GL ±0.00', {
      left: originX - 25,
      top: groundY + 4,
      fontSize: 9,
      fill: GROUND_LINE_COLOR,
      fontFamily: 'monospace',
      originX: 'right',
      originY: 'top',
      selectable: false,
      evented: false,
    });
    canvas.add(groundLabel);

    // ── Walls (back to front, painter's algorithm — sorted by depth descending)
    const sortedWalls = [...walls].sort((a, b) => b.depth - a.depth);
    for (const wallProj of sortedWalls) {
      renderWallProjection(canvas, wallProj, wx, wy, scale, elevationSettings);
    }

    // ── HVAC elements
    if (hvacProjections) {
      for (const hvacProj of hvacProjections) {
        renderHvacProjection(canvas, hvacProj, wx, wy);
      }
    }

    // ── Furniture elements
    if (furnitureProjections) {
      // Sort by depth (back to front) for painter's algorithm
      const sortedFurniture = [...furnitureProjections].sort((a, b) => b.depth - a.depth);
      for (const furnProj of sortedFurniture) {
        renderFurnitureProjection(canvas, furnProj, wx, wy, elevationView.kind);
      }
    }

    // ── Ceiling height reference line
    const ceilingY = wy(roomHeightMm);
    const ceilingLine = new fabric.Line(
      [originX - 10, ceilingY, wx(maxX) + 10, ceilingY],
      {
        stroke: '#AAAAAA',
        strokeWidth: 0.8,
        strokeDashArray: [6, 4],
        selectable: false,
        evented: false,
      }
    );
    canvas.add(ceilingLine);
    const ceilingLabel = new fabric.Text(`CLG ${(roomHeightMm / 1000).toFixed(1)}m`, {
      left: originX - 15,
      top: ceilingY - 2,
      fontSize: 8,
      fill: '#999',
      fontFamily: 'monospace',
      originX: 'right',
      originY: 'bottom',
      selectable: false,
      evented: false,
    });
    canvas.add(ceilingLabel);

    // ── Height dimension (right side)
    renderHeightDimension(canvas, wx(maxX) + 30, groundY, ceilingY, roomHeightMm);

    // ── Width dimension (bottom)
    if (walls.length > 0) {
      renderWidthDimension(canvas, wx(minX), wx(maxX), groundY + 25, elevWidth);
    }

    // ── View label
    if (viewLabel) {
      const label = new fabric.Text(viewLabel, {
        left: containerSize.width / 2,
        top: 16,
        fontSize: 12,
        fill: LABEL_COLOR,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        originX: 'center',
        originY: 'top',
        selectable: false,
        evented: false,
      });
      canvas.add(label);
    }

    // ── Scale indicator
    const scaleText = new fabric.Text(
      `Scale 1:${elevationView.scale}`,
      {
        left: containerSize.width - 16,
        top: containerSize.height - 16,
        fontSize: 9,
        fill: '#AAA',
        fontFamily: 'monospace',
        originX: 'right',
        originY: 'bottom',
        selectable: false,
        evented: false,
      }
    );
    canvas.add(scaleText);

    canvas.requestRenderAll();
  }, [elevationView, elevationSettings, containerSize, roomHeightMm, viewLabel, crossReferenceSectionLine]);

  // Re-render when inputs change
  useEffect(() => {
    renderElevation();
  }, [renderElevation]);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden ${className}`}
      style={{ minHeight: 200 }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}

// =============================================================================
// Render Helpers
// =============================================================================

function renderWallProjection(
  canvas: fabric.Canvas,
  wall: ElevationWallProjection,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
  settings: ElevationSettings
): void {
  const x1 = wx(wall.xStart);
  const x2 = wx(wall.xEnd);
  const y1 = wy(wall.yTop);
  const y2 = wy(wall.yBottom);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  if (width < 1 && height < 1) return;

  const alpha = settings.showDepthCueing ? wall.depthAlpha : 1;

  // Wall fill rectangle
  const wallRect = new fabric.Rect({
    left,
    top,
    width,
    height,
    fill: WALL_FILL_COLOR,
    stroke: WALL_STROKE_COLOR,
    strokeWidth: 1.5,
    opacity: alpha,
    selectable: false,
    evented: false,
  });
  canvas.add(wallRect);

  // Hatch pattern overlay for cut walls (depth near 0)
  if (wall.depth < 200) {
    const hatchSpacing = 8;
    for (let i = 0; i < (width + height) / hatchSpacing; i++) {
      const offset = i * hatchSpacing;
      const hatchLine = new fabric.Line(
        [
          left + Math.min(offset, width),
          top + Math.max(0, offset - width),
          left + Math.max(0, offset - height),
          top + Math.min(offset, height),
        ],
        {
          stroke: '#BBBBBB',
          strokeWidth: 0.5,
          opacity: alpha * 0.6,
          selectable: false,
          evented: false,
        }
      );
      canvas.add(hatchLine);
    }
  }

  // Render openings
  for (const opening of wall.openings) {
    const ox1 = wx(opening.xStart);
    const ox2 = wx(opening.xEnd);
    const oy1 = wy(opening.yTop);
    const oy2 = wy(opening.yBottom);
    const oLeft = Math.min(ox1, ox2);
    const oTop = Math.min(oy1, oy2);
    const oWidth = Math.abs(ox2 - ox1);
    const oHeight = Math.abs(oy2 - oy1);

    if (opening.type === 'door') {
      // Door opening — white rectangle with arc swing indicator
      const doorRect = new fabric.Rect({
        left: oLeft,
        top: oTop,
        width: oWidth,
        height: oHeight,
        fill: OPENING_DOOR_FILL,
        stroke: WALL_STROKE_COLOR,
        strokeWidth: 1,
        opacity: alpha,
        selectable: false,
        evented: false,
      });
      canvas.add(doorRect);

      // Door swing arc
      const arcPath = `M ${oLeft} ${oy2} A ${oWidth} ${oWidth} 0 0 1 ${oLeft + oWidth} ${oy2}`;
      const arc = new fabric.Path(arcPath, {
        fill: 'transparent',
        stroke: '#888',
        strokeWidth: 0.8,
        strokeDashArray: [3, 2],
        opacity: alpha,
        selectable: false,
        evented: false,
      });
      canvas.add(arc);
    } else {
      // Window opening — blue-tinted rectangle with sill line
      const windowRect = new fabric.Rect({
        left: oLeft,
        top: oTop,
        width: oWidth,
        height: oHeight,
        fill: OPENING_WINDOW_FILL,
        stroke: OPENING_WINDOW_STROKE,
        strokeWidth: 1,
        opacity: alpha,
        selectable: false,
        evented: false,
      });
      canvas.add(windowRect);

      // Glass lines (X pattern)
      const glass1 = new fabric.Line([oLeft, oTop, oLeft + oWidth, oTop + oHeight], {
        stroke: OPENING_WINDOW_STROKE,
        strokeWidth: 0.5,
        opacity: alpha * 0.5,
        selectable: false,
        evented: false,
      });
      canvas.add(glass1);
      const glass2 = new fabric.Line([oLeft + oWidth, oTop, oLeft, oTop + oHeight], {
        stroke: OPENING_WINDOW_STROKE,
        strokeWidth: 0.5,
        opacity: alpha * 0.5,
        selectable: false,
        evented: false,
      });
      canvas.add(glass2);
    }
  }
}

function renderHvacProjection(
  canvas: fabric.Canvas,
  hvac: ElevationHvacProjection,
  wx: (x: number) => number,
  wy: (y: number) => number
): void {
  const x1 = wx(hvac.xStart);
  const x2 = wx(hvac.xEnd);
  const y1 = wy(hvac.yTop);
  const y2 = wy(hvac.yBottom);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  let fill: string;
  let stroke: string;
  let dashArray: number[] | undefined;

  switch (hvac.visibility) {
    case 'visible':
      fill = HVAC_FILL;
      stroke = HVAC_STROKE;
      break;
    case 'cut':
      fill = HVAC_CUT_FILL;
      stroke = HVAC_CUT_STROKE;
      break;
    case 'ghost':
      fill = HVAC_GHOST_FILL;
      stroke = HVAC_GHOST_STROKE;
      dashArray = [4, 3];
      break;
  }

  const rect = new fabric.Rect({
    left,
    top,
    width,
    height,
    fill,
    stroke,
    strokeWidth: 1.5,
    strokeDashArray: dashArray,
    selectable: false,
    evented: false,
  });
  canvas.add(rect);

  // Label
  if (width > 30) {
    const label = new fabric.Text(hvac.label, {
      left: left + width / 2,
      top: top + height / 2,
      fontSize: Math.min(9, width * 0.08),
      fill: hvac.visibility === 'cut' ? HVAC_CUT_STROKE : HVAC_STROKE,
      fontFamily: 'monospace',
      fontWeight: '500',
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    canvas.add(label);
  }

  // Visibility state badge
  if (hvac.visibility !== 'visible') {
    const badge = new fabric.Text(
      hvac.visibility === 'cut' ? 'CUT' : 'BEHIND',
      {
        left: left + width / 2,
        top: top - 3,
        fontSize: 7,
        fill: hvac.visibility === 'cut' ? HVAC_CUT_STROKE : HVAC_GHOST_STROKE,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        originX: 'center',
        originY: 'bottom',
        selectable: false,
        evented: false,
      }
    );
    canvas.add(badge);
  }
}

function renderHeightDimension(
  canvas: fabric.Canvas,
  x: number,
  groundY: number,
  ceilingY: number,
  heightMm: number
): void {
  // Vertical dimension line
  const dimLine = new fabric.Line([x, groundY, x, ceilingY], {
    stroke: DIMENSION_COLOR,
    strokeWidth: 0.8,
    selectable: false,
    evented: false,
  });
  canvas.add(dimLine);

  // Extension lines
  const extLen = 6;
  const extBottom = new fabric.Line([x - extLen, groundY, x + extLen, groundY], {
    stroke: DIMENSION_COLOR,
    strokeWidth: 0.8,
    selectable: false,
    evented: false,
  });
  canvas.add(extBottom);
  const extTop = new fabric.Line([x - extLen, ceilingY, x + extLen, ceilingY], {
    stroke: DIMENSION_COLOR,
    strokeWidth: 0.8,
    selectable: false,
    evented: false,
  });
  canvas.add(extTop);

  // Text
  const midY = (groundY + ceilingY) / 2;
  const dimText = new fabric.Text(`${heightMm} mm`, {
    left: x + 8,
    top: midY,
    fontSize: 9,
    fill: DIMENSION_COLOR,
    fontFamily: 'monospace',
    originX: 'left',
    originY: 'center',
    angle: -90,
    selectable: false,
    evented: false,
  });
  canvas.add(dimText);
}

function renderWidthDimension(
  canvas: fabric.Canvas,
  x1: number,
  x2: number,
  y: number,
  widthMm: number
): void {
  const dimLine = new fabric.Line([x1, y, x2, y], {
    stroke: DIMENSION_COLOR,
    strokeWidth: 0.8,
    selectable: false,
    evented: false,
  });
  canvas.add(dimLine);

  const extLen = 6;
  const extLeft = new fabric.Line([x1, y - extLen, x1, y + extLen], {
    stroke: DIMENSION_COLOR,
    strokeWidth: 0.8,
    selectable: false,
    evented: false,
  });
  canvas.add(extLeft);
  const extRight = new fabric.Line([x2, y - extLen, x2, y + extLen], {
    stroke: DIMENSION_COLOR,
    strokeWidth: 0.8,
    selectable: false,
    evented: false,
  });
  canvas.add(extRight);

  const midX = (x1 + x2) / 2;
  const dimText = new fabric.Text(`${Math.round(widthMm)} mm`, {
    left: midX,
    top: y + 10,
    fontSize: 9,
    fill: DIMENSION_COLOR,
    fontFamily: 'monospace',
    originX: 'center',
    originY: 'top',
    selectable: false,
    evented: false,
  });
  canvas.add(dimText);
}

// Furniture colors by visibility
const FURN_FILL = 'rgba(90,56,32,0.12)';
const FURN_STROKE = 'rgba(90,56,32,0.6)';
const FURN_GHOST_FILL = 'rgba(90,56,32,0.04)';
const FURN_GHOST_STROKE = 'rgba(90,56,32,0.2)';
const FURN_CUT_FILL = 'rgba(232,144,10,0.15)';
const FURN_CUT_STROKE = '#e8900a';

function renderFurnitureProjection(
  canvas: fabric.Canvas,
  furn: ElevationFurnitureProjection,
  wx: (x: number) => number,
  wy: (y: number) => number,
  viewKind: ElevationViewKind
): void {
  const x1 = wx(furn.xStart);
  const x2 = wx(furn.xEnd);
  const y1 = wy(furn.yTop);
  const y2 = wy(furn.yBottom);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  if (width < 2 || height < 2) return;

  // Try Canvas 2D rich rendering if a renderer exists
  if (hasRenderer(furn.renderType) && width > 10 && height > 10) {
    const canvasEl = document.createElement('canvas');
    const dpr = 2;
    canvasEl.width = Math.ceil(width) * dpr;
    canvasEl.height = Math.ceil(height) * dpr;
    const ctx2d = canvasEl.getContext('2d');
    if (ctx2d) {
      ctx2d.scale(dpr, dpr);
      const cxLocal = width / 2;
      const cyLocal = height / 2;

      // Apply ghost/cut opacity
      if (furn.visibility === 'ghost') {
        ctx2d.globalAlpha = 0.3;
      } else if (furn.visibility === 'cut') {
        ctx2d.globalAlpha = 0.8;
      }

      // Use front or end renderer based on view kind
      const isEndView = viewKind === 'east' || viewKind === 'west';
      if (isEndView) {
        renderFurnitureEnd(ctx2d, furn.renderType, cxLocal, cyLocal, width, height);
      } else {
        renderFurnitureFront(ctx2d, furn.renderType, cxLocal, cyLocal, width, height);
      }

      const img = new fabric.FabricImage(canvasEl, {
        left,
        top,
        width: canvasEl.width,
        height: canvasEl.height,
        scaleX: 1 / dpr,
        scaleY: 1 / dpr,
        selectable: false,
        evented: false,
      });
      canvas.add(img);

      // Add visibility badge if not fully visible
      if (furn.visibility !== 'visible') {
        const badge = new fabric.Text(
          furn.visibility === 'cut' ? 'CUT' : 'BEHIND',
          {
            left: left + width / 2,
            top: top - 3,
            fontSize: 7,
            fill: furn.visibility === 'cut' ? FURN_CUT_STROKE : FURN_GHOST_STROKE,
            fontFamily: 'monospace',
            fontWeight: 'bold',
            originX: 'center',
            originY: 'bottom',
            selectable: false,
            evented: false,
          }
        );
        canvas.add(badge);
      }
      return;
    }
  }

  // Fallback: simple rectangle with visibility styling
  let fill: string;
  let stroke: string;
  let dashArray: number[] | undefined;

  switch (furn.visibility) {
    case 'visible':
      fill = FURN_FILL;
      stroke = FURN_STROKE;
      break;
    case 'cut':
      fill = FURN_CUT_FILL;
      stroke = FURN_CUT_STROKE;
      break;
    case 'ghost':
      fill = FURN_GHOST_FILL;
      stroke = FURN_GHOST_STROKE;
      dashArray = [4, 3];
      break;
  }

  const rect = new fabric.Rect({
    left,
    top,
    width,
    height,
    fill,
    stroke,
    strokeWidth: 1.2,
    strokeDashArray: dashArray,
    selectable: false,
    evented: false,
  });
  canvas.add(rect);

  // Label
  if (width > 25) {
    const label = new fabric.Text(furn.name, {
      left: left + width / 2,
      top: top + height / 2,
      fontSize: Math.min(8, width * 0.07),
      fill: furn.visibility === 'cut' ? FURN_CUT_STROKE : FURN_STROKE,
      fontFamily: 'monospace',
      fontWeight: '500',
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    canvas.add(label);
  }

  if (furn.visibility !== 'visible') {
    const badge = new fabric.Text(
      furn.visibility === 'cut' ? 'CUT' : 'BEHIND',
      {
        left: left + width / 2,
        top: top - 3,
        fontSize: 7,
        fill: furn.visibility === 'cut' ? FURN_CUT_STROKE : FURN_GHOST_STROKE,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        originX: 'center',
        originY: 'bottom',
        selectable: false,
        evented: false,
      }
    );
    canvas.add(badge);
  }
}

export default ElevationViewCanvas;
