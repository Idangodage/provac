'use client';

import React from 'react';

import type { Point2D } from '../../../types';
import { PX_TO_MM } from '../scale';

export interface BoardCursorHudProps {
  /** Cursor position in fabric scene pixels (already grid-snapped upstream). */
  cursorScenePx: Point2D;
  /** Anchor of the active draw operation in real millimetres, if any. */
  anchorMm: Point2D | null;
  /** Format a real-mm length in the assigned display unit. */
  formatLength: (mm: number) => string;
  viewportZoom: number;
  /** Pan offset in scene pixels. */
  panOffset: Point2D;
  viewportWidth: number;
  viewportHeight: number;
  visible: boolean;
  /** True when the shown position is grid-snapped (adds the ⌖ marker). */
  snapped: boolean;
}

/**
 * Dynamic-input HUD (AutoCAD-style): a small readout that follows the cursor
 * showing X/Y in the assigned unit, plus Δlength/angle while a run is being
 * drawn from an anchor point. Purely presentational — derives everything from
 * the shared board measurement so it always matches rulers and snapping.
 */
export const BoardCursorHud: React.FC<BoardCursorHudProps> = ({
  cursorScenePx,
  anchorMm,
  formatLength,
  viewportZoom,
  panOffset,
  viewportWidth,
  viewportHeight,
  visible,
  snapped,
}) => {
  if (!visible || viewportWidth <= 0 || viewportHeight <= 0) return null;

  const screenX = (cursorScenePx.x - panOffset.x) * viewportZoom;
  const screenY = (cursorScenePx.y - panOffset.y) * viewportZoom;
  if (
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY) ||
    screenX < 0 ||
    screenY < 0 ||
    screenX > viewportWidth ||
    screenY > viewportHeight
  ) {
    return null;
  }

  const cursorMm = {
    x: cursorScenePx.x * PX_TO_MM,
    y: cursorScenePx.y * PX_TO_MM,
  };

  let deltaLine: string | null = null;
  if (anchorMm) {
    const dx = cursorMm.x - anchorMm.x;
    const dy = cursorMm.y - anchorMm.y;
    const length = Math.hypot(dx, dy);
    // Screen y grows downward; report the CAD-conventional CCW angle.
    const angleDeg = (Math.atan2(-dy, dx) * (180 / Math.PI) + 360) % 360;
    deltaLine = `L ${formatLength(length)}  ∠ ${angleDeg.toFixed(1)}°`;
  }

  // Keep the card inside the viewport (flip to the left/top near edges).
  const flipX = screenX > viewportWidth - 190;
  const flipY = screenY > viewportHeight - 64;

  return (
    <div
      style={{
        position: 'absolute',
        left: screenX + (flipX ? -14 : 14),
        top: screenY + (flipY ? -46 : 18),
        transform: `translate(${flipX ? '-100%' : '0'}, 0)`,
        pointerEvents: 'none',
        zIndex: 30,
        padding: '3px 8px',
        borderRadius: 6,
        background: 'rgba(30, 41, 59, 0.82)',
        color: '#f8fafc',
        fontSize: 10,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        boxShadow: '0 2px 8px rgba(15, 23, 42, 0.25)',
      }}
    >
      <div>
        {snapped && <span style={{ color: '#4ade80', marginRight: 4 }}>⌖</span>}
        X {formatLength(cursorMm.x)}  Y {formatLength(cursorMm.y)}
      </div>
      {deltaLine && <div style={{ color: '#93c5fd' }}>{deltaLine}</div>}
    </div>
  );
};

export default BoardCursorHud;
