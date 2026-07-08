'use client';

import React, { useEffect, useRef } from 'react';

import type { Point2D } from '../../../types';
import { MM_TO_PX } from '../scale';

import { computeBoardGridSteps } from './boardGridMath';

export interface BoardGridProps {
  width: number;
  height: number;
  /** Real-world zoom (== DrawingCanvas viewportZoom); shared with the pipe overlay. */
  viewportZoom: number;
  /** Scene-pixel pan (== DrawingCanvas panOffset); shared with the pipe overlay. */
  panOffset: Point2D;
  show?: boolean;
  subColor?: string;
  minorColor?: string;
  majorColor?: string;
  xAxisColor?: string;
  yAxisColor?: string;
}

const DEFAULT_SUB = 'rgba(100, 116, 139, 0.10)';
const DEFAULT_MINOR = 'rgba(100, 116, 139, 0.22)';
const DEFAULT_MAJOR = 'rgba(51, 65, 85, 0.42)';
const DEFAULT_X_AXIS = 'rgba(220, 68, 68, 0.55)';
const DEFAULT_Y_AXIS = 'rgba(34, 160, 90, 0.55)';

const MAX_LINES_PER_AXIS = 4000;

/**
 * Viewport-filling adaptive grid (sub / minor / major + tinted world axes),
 * drawn on a DPR-crisp Canvas2D using the same world-mm↔screen transform as the
 * pipe overlay so the two never drift. Replaces the legacy page-clipped Grid.
 */
export const BoardGrid: React.FC<BoardGridProps> = ({
  width,
  height,
  viewportZoom,
  panOffset,
  show = true,
  subColor = DEFAULT_SUB,
  minorColor = DEFAULT_MINOR,
  majorColor = DEFAULT_MAJOR,
  xAxisColor = DEFAULT_X_AXIS,
  yAxisColor = DEFAULT_Y_AXIS,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!show || w <= 0 || h <= 0 || viewportZoom <= 0) return;

    const z = viewportZoom;
    const worldToScreenX = (wx: number) => (wx * MM_TO_PX - panOffset.x) * z;
    const worldToScreenY = (wy: number) => (wy * MM_TO_PX - panOffset.y) * z;
    const screenToWorldX = (sx: number) => (sx / z + panOffset.x) / MM_TO_PX;
    const screenToWorldY = (sy: number) => (sy / z + panOffset.y) / MM_TO_PX;

    const worldLeft = screenToWorldX(0);
    const worldRight = screenToWorldX(w);
    const worldTop = screenToWorldY(0);
    const worldBottom = screenToWorldY(h);

    const steps = computeBoardGridSteps(z);

    const drawLevel = (stepMm: number, color: string, lineWidth: number) => {
      if (stepMm <= 0) return;
      const stepPx = stepMm * steps.pxPerMm;
      if (stepPx < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      // Vertical lines (constant world X).
      const firstX = Math.ceil(worldLeft / stepMm) * stepMm;
      let count = 0;
      for (let gx = firstX; gx <= worldRight && count < MAX_LINES_PER_AXIS; gx += stepMm, count += 1) {
        const sx = Math.round(worldToScreenX(gx)) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, h);
      }
      // Horizontal lines (constant world Y).
      const firstY = Math.ceil(worldTop / stepMm) * stepMm;
      count = 0;
      for (let gy = firstY; gy <= worldBottom && count < MAX_LINES_PER_AXIS; gy += stepMm, count += 1) {
        const sy = Math.round(worldToScreenY(gy)) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
      }
      ctx.stroke();
    };

    if (steps.showSub) drawLevel(steps.subMm, subColor, 1);
    if (steps.showMinor) drawLevel(steps.minorMm, minorColor, 1);
    drawLevel(steps.majorMm, majorColor, 1);

    // World axes (X = horizontal line at worldY 0, Y = vertical line at worldX 0).
    const axisY = Math.round(worldToScreenY(0)) + 0.5;
    if (axisY >= 0 && axisY <= h) {
      ctx.beginPath();
      ctx.strokeStyle = xAxisColor;
      ctx.lineWidth = 1.25;
      ctx.moveTo(0, axisY);
      ctx.lineTo(w, axisY);
      ctx.stroke();
    }
    const axisX = Math.round(worldToScreenX(0)) + 0.5;
    if (axisX >= 0 && axisX <= w) {
      ctx.beginPath();
      ctx.strokeStyle = yAxisColor;
      ctx.lineWidth = 1.25;
      ctx.moveTo(axisX, 0);
      ctx.lineTo(axisX, h);
      ctx.stroke();
    }
  }, [
    width,
    height,
    viewportZoom,
    panOffset.x,
    panOffset.y,
    show,
    subColor,
    minorColor,
    majorColor,
    xAxisColor,
    yAxisColor,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 block"
      style={{ width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1 }}
    />
  );
};

export default BoardGrid;
