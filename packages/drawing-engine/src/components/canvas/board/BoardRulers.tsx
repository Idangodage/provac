'use client';

import React, { useEffect, useRef } from 'react';

import type { Point2D } from '../../../types';
import { MM_TO_PX } from '../scale';

import {
  computeBoardGridSteps,
  formatBoardLabel,
  type BoardUnit,
} from './boardGridMath';

export interface BoardRulersProps {
  /** Outer-container width in CSS px. */
  width: number;
  /** Outer-container height in CSS px. */
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  /** Where the host drawing area begins within the outer container (== originOffset). */
  offset: Point2D;
  unit: BoardUnit;
  onCycleUnit: () => void;
  /** Cursor position in outer-container screen px (for the tracking hairline). */
  cursorScreen?: Point2D | null;
  topSize?: number;
  leftSize?: number;
  show?: boolean;
}

const STRIP_BG = 'rgba(248, 250, 252, 0.97)';
const STRIP_BORDER = 'rgba(148, 163, 184, 0.6)';
const TICK_MAJOR = 'rgba(51, 65, 85, 0.85)';
const TICK_MINOR = 'rgba(100, 116, 139, 0.7)';
const TICK_SUB = 'rgba(148, 163, 184, 0.5)';
const LABEL_COLOR = 'rgba(30, 41, 59, 0.92)';
const CURSOR_COLOR = 'rgba(37, 99, 235, 0.9)';

/**
 * Top + left ruler strips with major/minor/sub ticks and k-formatted labels,
 * driven by the same adaptive 1-2-5 ladder as {@link BoardGrid}. The corner box
 * cycles the display unit; a hairline tracks the cursor. Positioned over the
 * outer container's reserved ruler margin (see `originOffset`).
 */
export const BoardRulers: React.FC<BoardRulersProps> = ({
  width,
  height,
  viewportZoom,
  panOffset,
  offset,
  unit,
  onCycleUnit,
  cursorScreen = null,
  topSize = 24,
  leftSize = 29,
  show = true,
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

    if (!show || viewportZoom <= 0) return;

    const z = viewportZoom;
    const worldToScreenX = (wx: number) => (wx * MM_TO_PX - panOffset.x) * z + offset.x;
    const worldToScreenY = (wy: number) => (wy * MM_TO_PX - panOffset.y) * z + offset.y;
    const screenToWorldX = (sx: number) => ((sx - offset.x) / z + panOffset.x) / MM_TO_PX;
    const screenToWorldY = (sy: number) => ((sy - offset.y) / z + panOffset.y) / MM_TO_PX;

    const steps = computeBoardGridSteps(z);
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Strip backgrounds + separators.
    ctx.fillStyle = STRIP_BG;
    ctx.fillRect(0, 0, w, topSize);
    ctx.fillRect(0, 0, leftSize, h);
    ctx.strokeStyle = STRIP_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, topSize + 0.5);
    ctx.lineTo(w, topSize + 0.5);
    ctx.moveTo(leftSize + 0.5, 0);
    ctx.lineTo(leftSize + 0.5, h);
    ctx.stroke();

    const levels: Array<{ stepMm: number; color: string; frac: number; label: boolean }> = [];
    if (steps.showSub) levels.push({ stepMm: steps.subMm, color: TICK_SUB, frac: 0.3, label: false });
    if (steps.showMinor) levels.push({ stepMm: steps.minorMm, color: TICK_MINOR, frac: 0.55, label: false });
    levels.push({ stepMm: steps.majorMm, color: TICK_MAJOR, frac: 1, label: true });

    // Top ruler (world X).
    {
      const worldStart = screenToWorldX(leftSize);
      const worldEnd = screenToWorldX(w);
      for (const level of levels) {
        ctx.strokeStyle = level.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const first = Math.ceil(worldStart / level.stepMm) * level.stepMm;
        for (let g = first; g <= worldEnd; g += level.stepMm) {
          const sx = Math.round(worldToScreenX(g)) + 0.5;
          if (sx < leftSize) continue;
          ctx.moveTo(sx, topSize);
          ctx.lineTo(sx, topSize * (1 - level.frac));
        }
        ctx.stroke();
        if (level.label) {
          ctx.fillStyle = LABEL_COLOR;
          ctx.textAlign = 'center';
          for (let g = first; g <= worldEnd; g += level.stepMm) {
            const sx = worldToScreenX(g);
            if (sx < leftSize + 6) continue;
            ctx.fillText(formatBoardLabel(g, unit), sx, topSize * 0.42);
          }
        }
      }
    }

    // Left ruler (world Y).
    {
      const worldStart = screenToWorldY(topSize);
      const worldEnd = screenToWorldY(h);
      for (const level of levels) {
        ctx.strokeStyle = level.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const first = Math.ceil(worldStart / level.stepMm) * level.stepMm;
        for (let g = first; g <= worldEnd; g += level.stepMm) {
          const sy = Math.round(worldToScreenY(g)) + 0.5;
          if (sy < topSize) continue;
          ctx.moveTo(leftSize, sy);
          ctx.lineTo(leftSize * (1 - level.frac), sy);
        }
        ctx.stroke();
        if (level.label) {
          ctx.fillStyle = LABEL_COLOR;
          ctx.textAlign = 'center';
          for (let g = first; g <= worldEnd; g += level.stepMm) {
            const sy = worldToScreenY(g);
            if (sy < topSize + 8) continue;
            ctx.save();
            ctx.translate(leftSize * 0.5, sy);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(formatBoardLabel(g, unit), 0, 0);
            ctx.restore();
          }
        }
      }
    }

    // Cursor hairlines.
    if (cursorScreen) {
      ctx.strokeStyle = CURSOR_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (cursorScreen.x >= leftSize) {
        const sx = Math.round(cursorScreen.x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, topSize);
      }
      if (cursorScreen.y >= topSize) {
        const sy = Math.round(cursorScreen.y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(leftSize, sy);
      }
      ctx.stroke();
    }

    // Corner cover (over the strip overlaps).
    ctx.fillStyle = STRIP_BG;
    ctx.fillRect(0, 0, leftSize, topSize);
    ctx.strokeStyle = STRIP_BORDER;
    ctx.strokeRect(0.5, 0.5, leftSize, topSize);
  }, [width, height, viewportZoom, panOffset.x, panOffset.y, offset.x, offset.y, unit, cursorScreen, topSize, leftSize, show]);

  if (!show) return null;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block"
        style={{ width: '100%', height: '100%', pointerEvents: 'none', zIndex: 20 }}
      />
      <button
        type="button"
        onClick={onCycleUnit}
        title="Cycle units (mm / cm / m)"
        className="absolute z-[21] flex items-center justify-center text-[10px] font-semibold uppercase text-slate-600 hover:bg-slate-200/70"
        style={{ left: 0, top: 0, width: leftSize, height: topSize }}
      >
        {unit}
      </button>
    </>
  );
};

export default BoardRulers;
