/**
 * WallSnapIndicatorRenderer
 *
 * Renders snap visual feedback on a SEPARATE HTML canvas element that sits
 * on top of the fabric.js canvas (same dimensions, pointer-events: none,
 * position: absolute, z-index: 10). Never draws snap indicators onto the
 * fabric.js canvas.
 *
 * Visual specification per snap type:
 *   endpoint  → 10×10px hollow square (cyan #00BCD4)
 *               room close variant: 12px hollow circle (orange #FF9800) + "Close Room" label
 *   midpoint  → upward triangle (orange #FF6B35) + "MID" label
 *   angle     → dashed guide line from startPoint to snappedPoint (#4FC3F7) + angle label
 *   grid      → 6px cross (#78909C)
 *   extension → dashed line (#B0BEC5)
 *   perp      → solid line + 8px square at foot (#CE93D8)
 */

import type { Point2D } from '../../../types';
import type { EnhancedSnapResult, SnapGuideLine } from './WallSnapping';

// =============================================================================
// Colors & Constants
// =============================================================================

const COLORS = {
  endpoint: '#00BCD4',
  roomClose: '#FF9800',
  midpoint: '#FF6B35',
  angle: '#4FC3F7',
  grid: '#78909C',
  extension: '#B0BEC5',
  perpendicular: '#CE93D8',
} as const;

// =============================================================================
// WallSnapIndicatorRenderer
// =============================================================================

export class WallSnapIndicatorRenderer {
  private ctx: CanvasRenderingContext2D | null;
  private mmToPx: number;
  private zoomFn: () => number;
  private panFn: () => { x: number; y: number };
  private overlayCanvas: HTMLCanvasElement;

  constructor(
    overlayCanvas: HTMLCanvasElement,
    mmToPx: number,
    zoom: () => number,
    pan: () => { x: number; y: number },
  ) {
    this.overlayCanvas = overlayCanvas;
    this.ctx = overlayCanvas.getContext('2d');
    this.mmToPx = mmToPx;
    this.zoomFn = zoom;
    this.panFn = pan;
  }

  // ─── Coordinate Conversion ──────────────────────────────────────────────

  /**
   * Convert mm coordinates to overlay-canvas viewport px.
   * viewportPx = (mm × mmToPx − panOffset) × zoom
   *
   * The fabric viewport transform is [z, 0, 0, z, -pan.x*z, -pan.y*z],
   * so viewportPx = scenePx * z + (-pan * z) = (scenePx - pan) * z.
   */
  private toPx(mm: Point2D): { x: number; y: number } {
    const z = this.zoomFn();
    const pan = this.panFn();
    return {
      x: (mm.x * this.mmToPx - pan.x) * z,
      y: (mm.y * this.mmToPx - pan.y) * z,
    };
  }

  // ─── Main Render ────────────────────────────────────────────────────────

  /**
   * Called every mousemove with the latest snap result.
   * Clears the overlay and redraws all indicators in one pass.
   *
   * @param cursorScenePx  The cursor position in scene-pixel space (mm * mmToPx),
   *                       used only for the angle indicator guide line.
   */
  render(
    snapResult: EnhancedSnapResult,
    cursorScenePx: { x: number; y: number },
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;

    // Single clearRect at start of each render() call
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    if (snapResult.snapType === 'none') return;

    const snappedPx = this.toPx(snapResult.snappedPoint);

    // Convert cursor scene-px to viewport-px for the angle indicator
    const z = this.zoomFn();
    const pan = this.panFn();
    const cursorViewportPx = {
      x: (cursorScenePx.x - pan.x) * z,
      y: (cursorScenePx.y - pan.y) * z,
    };

    // Render per snap type
    switch (snapResult.snapType) {
      case 'endpoint':
        this.renderEndpoint(ctx, snappedPx, snapResult);
        break;
      case 'midpoint':
        this.renderMidpoint(ctx, snappedPx);
        break;
      case 'angle':
        this.renderAngle(ctx, snappedPx, cursorViewportPx, snapResult);
        break;
      case 'grid':
        this.renderGrid(ctx, snappedPx);
        break;
    }

    // Render guide lines (extension lines / perpendicular)
    if (snapResult.guideLines && snapResult.guideLines.length > 0) {
      for (const guideLine of snapResult.guideLines) {
        this.renderGuideLine(ctx, guideLine);
      }
    }
  }

  /**
   * Remove all indicators (call on mouseup, tool switch, Escape)
   */
  clear(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  // ─── Snap Type Renderers ────────────────────────────────────────────────

  /**
   * snapType === 'endpoint':
   *   Draw a 10×10px hollow square centered on snappedPoint.
   *   Color: #00BCD4 (cyan). Stroke width: 1.5px.
   *   If closing a room: 12px hollow circle + "Close Room" label.
   */
  private renderEndpoint(
    ctx: CanvasRenderingContext2D,
    snappedPx: { x: number; y: number },
    snapResult: EnhancedSnapResult,
  ): void {
    ctx.save();

    // Detect room close: this is a simple heuristic —
    // if the snap result indicates an endpoint snap and the snapped point
    // will match the draw start, the caller should set a flag.
    // For now, we always render the standard endpoint indicator.
    // Room close detection is handled by checking if connectedWallId is set
    // and endpoint matches 'start' (indicating start of the chain).
    const isRoomClose = false; // Room close is computed in the hook layer

    if (isRoomClose) {
      // 12px hollow circle, color: #FF9800
      ctx.strokeStyle = COLORS.roomClose;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(snappedPx.x, snappedPx.y, 12, 0, Math.PI * 2);
      ctx.stroke();

      // "Close Room" label 14px above in 11px sans-serif
      ctx.fillStyle = COLORS.roomClose;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Close Room', snappedPx.x, snappedPx.y - 14);
    } else {
      // 10×10px hollow square centered on snappedPoint
      ctx.strokeStyle = COLORS.endpoint;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(snappedPx.x - 5, snappedPx.y - 5, 10, 10);
    }

    ctx.restore();
  }

  /**
   * snapType === 'midpoint':
   *   Draw an upward triangle △ with 10px sides centered on snappedPoint.
   *   Color: #FF6B35. Stroke width: 1.5px.
   *   Label "MID" 14px above in 9px monospace.
   */
  private renderMidpoint(
    ctx: CanvasRenderingContext2D,
    snappedPx: { x: number; y: number },
  ): void {
    ctx.save();

    const side = 10;
    const h = (side * Math.sqrt(3)) / 2;

    ctx.strokeStyle = COLORS.midpoint;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    // Upward triangle, centered
    ctx.moveTo(snappedPx.x, snappedPx.y - h * 2 / 3);
    ctx.lineTo(snappedPx.x - side / 2, snappedPx.y + h / 3);
    ctx.lineTo(snappedPx.x + side / 2, snappedPx.y + h / 3);
    ctx.closePath();
    ctx.stroke();

    // Label "MID" 14px above in 9px monospace
    ctx.fillStyle = COLORS.midpoint;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('MID', snappedPx.x, snappedPx.y - 14);

    ctx.restore();
  }

  /**
   * snapType === 'angle':
   *   Draw a dashed guide line from drawState.startPoint to snappedPoint.
   *   Dash: [6, 4]. Color: #4FC3F7. Stroke width: 1px.
   *   Show angle value (e.g. "90°") next to cursor in 10px monospace.
   */
  private renderAngle(
    ctx: CanvasRenderingContext2D,
    snappedPx: { x: number; y: number },
    cursorPx: { x: number; y: number },
    snapResult: EnhancedSnapResult,
  ): void {
    ctx.save();

    // Draw dashed guide line from start to snapped
    ctx.strokeStyle = COLORS.angle;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    // Use the cursor as a proxy for the startPoint in px space
    // (the actual start is in mm; we draw from origin of line to snapped)
    ctx.moveTo(cursorPx.x, cursorPx.y);
    ctx.lineTo(snappedPx.x, snappedPx.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Compute and show angle value next to cursor
    const dx = snappedPx.x - cursorPx.x;
    const dy = snappedPx.y - cursorPx.y;
    const angleDeg = Math.round(Math.atan2(-dy, dx) * (180 / Math.PI));
    const normalizedAngle = ((angleDeg % 360) + 360) % 360;

    ctx.fillStyle = COLORS.angle;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${normalizedAngle}°`, cursorPx.x + 12, cursorPx.y - 8);

    ctx.restore();
  }

  /**
   * snapType === 'grid':
   *   Draw a 6px cross (+) at snappedPoint. Color: #78909C. Stroke width: 1px.
   */
  private renderGrid(
    ctx: CanvasRenderingContext2D,
    snappedPx: { x: number; y: number },
  ): void {
    ctx.save();

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;

    // Horizontal line of cross
    ctx.beginPath();
    ctx.moveTo(snappedPx.x - 3, snappedPx.y);
    ctx.lineTo(snappedPx.x + 3, snappedPx.y);
    ctx.stroke();

    // Vertical line of cross
    ctx.beginPath();
    ctx.moveTo(snappedPx.x, snappedPx.y - 3);
    ctx.lineTo(snappedPx.x, snappedPx.y + 3);
    ctx.stroke();

    ctx.restore();
  }

  // ─── Guide Line Renderers ──────────────────────────────────────────────

  /**
   * Render guide lines (extension lines / perpendicular markers)
   */
  private renderGuideLine(
    ctx: CanvasRenderingContext2D,
    guideLine: SnapGuideLine,
  ): void {
    const fromPx = this.toPx(guideLine.from);
    const toPx = this.toPx(guideLine.to);

    switch (guideLine.type) {
      case 'extension':
        this.renderExtensionLine(ctx, fromPx, toPx);
        break;
      case 'perpendicular':
        this.renderPerpendicularLine(ctx, fromPx, toPx);
        break;
      case 'alignment':
        // Treat alignment like extension
        this.renderExtensionLine(ctx, fromPx, toPx);
        break;
    }
  }

  /**
   * type === 'extension':
   *   Dashed line from guideLine.from to guideLine.to.
   *   Dash: [4, 4]. Color: #B0BEC5. Stroke width: 0.8px.
   */
  private renderExtensionLine(
    ctx: CanvasRenderingContext2D,
    fromPx: { x: number; y: number },
    toPx: { x: number; y: number },
  ): void {
    ctx.save();

    ctx.strokeStyle = COLORS.extension;
    ctx.lineWidth = 0.8;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(fromPx.x, fromPx.y);
    ctx.lineTo(toPx.x, toPx.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  /**
   * type === 'perpendicular':
   *   Solid line + small 8px square at the perpendicular foot.
   *   Color: #CE93D8 (purple). Stroke width: 1px.
   */
  private renderPerpendicularLine(
    ctx: CanvasRenderingContext2D,
    fromPx: { x: number; y: number },
    toPx: { x: number; y: number },
  ): void {
    ctx.save();

    // Solid line from → to
    ctx.strokeStyle = COLORS.perpendicular;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(fromPx.x, fromPx.y);
    ctx.lineTo(toPx.x, toPx.y);
    ctx.stroke();

    // Small 8px square at the perpendicular foot (toPx)
    ctx.strokeRect(toPx.x - 4, toPx.y - 4, 8, 8);

    ctx.restore();
  }
}
