/**
 * WallPreview
 *
 * Live preview during wall drawing.
 * Shows interior, dashed center, and exterior lines.
 */

import * as fabric from 'fabric';

import type { Point2D, Wall, WallMaterial } from '../../../types';
import { WALL_MATERIAL_COLORS } from '../../../types/wall';
import { MM_TO_PX } from '../scale';

import { buildTemporaryWall } from './WallJoinNetwork';
import { computeWallBodyPolygon } from './WallGeometry';

// =============================================================================
// WallPreview Class
// =============================================================================

export class WallPreview {
  private canvas: fabric.Canvas;
  private previewGroup: fabric.Group | null = null;
  private pageHeight: number;
  private startPoint: Point2D | null = null;
  private thickness: number = 150;
  private material: WallMaterial = 'brick';
  private queuedEndPoint: Point2D | null = null;
  private lastEndPoint: Point2D | null = null;
  private walls: Wall[] = [];
  private preferredStartWall: Wall | null = null;

  constructor(canvas: fabric.Canvas, pageHeight: number = 3000) {
    this.canvas = canvas;
    this.pageHeight = pageHeight;
  }

  /**
   * Convert Y coordinate to canvas coordinates (top-left origin).
   */
  private toCanvasY(y: number): number {
    return y * MM_TO_PX;
  }

  private toCanvasPoint(point: Point2D): { x: number; y: number } {
    return {
      x: point.x * MM_TO_PX,
      y: this.toCanvasY(point.y),
    };
  }

  /**
   * Set page height for compatibility with existing hook contracts.
   */
  setPageHeight(height: number): void {
    this.pageHeight = height;
  }

  setWalls(walls: Wall[]): void {
    this.walls = walls;
    this.preferredStartWall = null;
    if (this.startPoint && this.lastEndPoint) {
      this.queuedEndPoint = { ...this.lastEndPoint };
      this.flushPreviewRender();
    }
  }

  /**
   * Start preview from a point.
   */
  startPreview(
    startPoint: Point2D,
    thickness: number,
    material: WallMaterial,
    preferredStartWall?: Wall | null
  ): void {
    this.clearPreview();
    this.startPoint = { ...startPoint };
    this.thickness = thickness;
    this.material = material;
    this.preferredStartWall = preferredStartWall ? { ...preferredStartWall } : null;
  }

  /**
   * Queue preview update to the next animation frame.
   */
  updatePreview(endPoint: Point2D): void {
    if (!this.startPoint) return;
    this.queuedEndPoint = { ...endPoint };
    this.flushPreviewRender();
  }

  private flushPreviewRender(): void {
    if (!this.startPoint || !this.queuedEndPoint) return;
    const endPoint = this.queuedEndPoint;
    this.queuedEndPoint = null;

    if (this.previewGroup) {
      this.canvas.remove(this.previewGroup);
      this.previewGroup = null;
    }

    this.lastEndPoint = { ...endPoint };

    const dx = endPoint.x - this.startPoint.x;
    const dy = endPoint.y - this.startPoint.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1) return;

    const previewWall = buildTemporaryWall(
      '__preview__',
      this.startPoint,
      endPoint,
      this.thickness,
      this.material
    );
    const materialColors = WALL_MATERIAL_COLORS[this.material];
    // Live preview should preserve the wall's nominal thickness even when the
    // eventual committed join may be mitered or beveled against nearby walls.
    // Showing the raw body here keeps the preview stable and predictable.
    const previewPolygon = computeWallBodyPolygon(previewWall);
    const previewVertices = previewPolygon.map((point) => this.toCanvasPoint(point));
    const mergedPreviewPath = new fabric.Polygon(previewVertices, {
      fill: materialColors.fill,
      opacity: 0.55,
      stroke: '#000000',
      strokeWidth: 2,
      strokeLineJoin: 'miter',
      selectable: false,
      evented: false,
      objectCaching: false,
    });

    const centerPreviewLine = new fabric.Line(
      [
        this.startPoint.x * MM_TO_PX,
        this.toCanvasY(this.startPoint.y),
        endPoint.x * MM_TO_PX,
        this.toCanvasY(endPoint.y),
      ],
      {
        stroke: '#000000',
        strokeWidth: 1,
        strokeDashArray: [8, 6],
        selectable: false,
        evented: false,
      }
    );

    this.previewGroup = new fabric.Group(
      [
        mergedPreviewPath,
        centerPreviewLine,
      ],
      {
        selectable: false,
        evented: false,
      }
    );

    this.canvas.add(this.previewGroup);
    this.canvas.requestRenderAll();
  }

  /**
   * Show preview with specific start and end points.
   */
  showPreview(
    startPoint: Point2D,
    endPoint: Point2D,
    thickness: number,
    material: WallMaterial
  ): void {
    this.startPoint = { ...startPoint };
    this.thickness = thickness;
    this.material = material;
    this.updatePreview(endPoint);
  }

  /**
   * Clear preview from canvas.
   */
  clearPreview(): void {
    this.queuedEndPoint = null;

    if (this.previewGroup) {
      this.canvas.remove(this.previewGroup);
      this.previewGroup = null;
    }

    this.startPoint = null;
    this.lastEndPoint = null;
    this.preferredStartWall = null;
    this.canvas.requestRenderAll();
  }

  /**
   * Check if preview is active.
   */
  isActive(): boolean {
    return this.startPoint !== null;
  }

  /**
   * Dispose preview.
   */
  dispose(): void {
    this.clearPreview();
  }
}
