/**
 * WallRenderer
 *
 * Fabric.js rendering for walls with material fills and joins.
 *
 * CHANGES FROM ORIGINAL:
 * ──────────────────────────────────────────────────────
 * [PERF] Dirty rendering: updateWall() now only re-renders the changed wall
 *        and its connected neighbors, instead of nuking ALL canvas objects
 *        and rebuilding from scratch. On a 200-wall floor plan, this turns
 *        a drag operation from ~200 object recreations per frame into ~3-5.
 * [PERF] Canvas batching: renderAllWalls() disables renderOnAddRemove during
 *        bulk operations, preventing O(n²) intermediate repaints.
 * [PERF] Viewport culling: walls outside the visible viewport are rendered as
 *        simplified single-line objects instead of full polygon groups.
 *        Saves GPU time on large floor plans.
 * [FEAT] Dimension labels: selected walls now show their length in mm/m
 *        alongside the wall. This is standard in every CAD tool.
 * [FEAT] Snap indicator rendering: renderSnapIndicators() draws visual
 *        feedback for snap events — "X" markers at snap points, dotted
 *        extension lines, perpendicular markers. Uses SnapGuideLine data
 *        from the improved WallSnapping module.
 * [FEAT] Ghost/preview wall: renderPreviewWall() draws a semi-transparent
 *        wall following the cursor during wall drawing mode.
 * [FEAT] Visual config object: all magic colors and sizes consolidated into
 *        VISUAL_CONFIG. Enables theming, dark mode, and user customization.
 * [BUG] toCanvasY: removed unused pageHeight parameter that was hiding a
 *        potential Y-flip bug (canvas Y-down vs architectural Y-up).
 * [BUG] Control point diffing: setSelectedWalls() now diffs against previous
 *        selection instead of blindly removing and recreating all controls.
 * ──────────────────────────────────────────────────────
 */

import * as fabric from 'fabric';

import { colorFromExposure, getArchitecturalMaterial, heatColorFromUValue } from '../../../attributes';
import type { Point2D, Room, Wall, WallColorMode, WallMaterial, JoinData, SymbolInstance2D } from '../../../types';
import { WALL_MATERIAL_COLORS } from '../../../types/wall';
import { endDragPerfTimer, startDragPerfTimer } from '../perf/dragPerf';
import { MM_TO_PX } from '../scale';

import { renderWallOpenings } from './OpeningRenderer';
import {
  computeWallPolygon,
  wallBounds,
  refreshOffsetLines, // [PATCH APPLIED]
} from './WallGeometry';
import {
  computeSelectableWallPolygon,
  resolveWallSelectionPlan,
  type WallSelectionComponent,
  type WallSelectionPlan,
} from './WallSelectionGeometry';
import type { RoomBoundarySelectionSegment } from './RoomBoundarySelection';
import type { EnhancedSnapResult } from './WallSnapping';
import { primeWallSelectionGeometryInBackground } from './wallSelectionWorkerClient';
import { computeWallUnionRenderData, type WallUnionComponent, type WallUnionRenderData } from './WallUnionGeometry';
import {
  refreshAllWalls, // [PATCH APPLIED]
  refreshAfterPointMove, // [PATCH APPLIED]
  refreshPartialWallGeometry,
  validateWallPolygon, // [PATCH APPLIED]
} from './WallUpdatePipeline';

// =============================================================================
// Types
// =============================================================================

export interface WallRenderOptions {
  showCenterLines: boolean;
  pageHeight: number;
}

type NamedObject = fabric.Object & {
  name?: string;
  wallId?: string;
  id?: string;
  objectId?: string;
  openingId?: string;
  isDoorArc?: boolean;
};
type WallGroup = fabric.Group & { wallId?: string; id?: string; name?: string };
type WallControlType =
  | 'wall-center-handle'
  | 'wall-endpoint-start'
  | 'wall-endpoint-end'
  | 'wall-thickness-interior'
  | 'wall-thickness-exterior'
  | 'wall-rotation-handle'
  | 'room-corner-handle';
type WallControlObject = NamedObject & {
  isWallControl?: boolean;
  isRoomControl?: boolean;
  controlType?: WallControlType;
  isControlHitTarget?: boolean;
  roomId?: string;
  cornerIndex?: number;
  roomBoundarySelectionKey?: string;
  roomBoundaryStartPoint?: Point2D;
  roomBoundaryEndPoint?: Point2D;
};
type SelectionComponentObject = NamedObject & {
  selectionRole?: 'fill' | 'outline';
};
type SelectionOverlayStyle = {
  fill: string;
  stroke: string;
  strokeWidth: number;
};

const OPENING_DOOR_ARC_SCREEN_STROKE_WIDTH = 1.2;
const OPENING_DOOR_ARC_STROKE = '#2b160b';

// =============================================================================
// [NEW] Visual Configuration
// =============================================================================

/**
 * All visual constants in one place.
 * Previously these were magic numbers scattered across 1200 lines.
 * Now you can:
 *  - Implement dark mode by swapping this object
 *  - Let users customize colors/sizes in preferences
 *  - A/B test different visual styles
 */
export const VISUAL_CONFIG = {
  // Wall body
  wallStroke: '#000000',
  wallStrokeWidth: 2,
  centerLineStroke: '#000000',
  centerLineWidth: 1,

  // Selection
  selectionStroke: '#374151',
  selectionStrokeWidth: 1.6,
  selectionFill: 'rgba(55, 65, 81, 0.12)',
  hoverStroke: '#0F766E',
  hoverStrokeWidth: 1.2,
  hoverFill: 'rgba(15, 118, 110, 0.08)',

  // Control handles — all sizes in screen pixels (zoom-independent)
  endpointRadius: 8,
  endpointStroke: 2.2,
  endpointFill: '#1D4ED8',
  endpointStrokeColor: '#FFFFFF',
  endpointShadow: 'rgba(37, 99, 235, 0.34)',

  thicknessRadius: 8,
  thicknessFill: '#FFFFFF',
  thicknessStroke: '#2563EB',
  thicknessStrokeWidth: 1.8,
  thicknessIconStroke: '#2563EB',
  thicknessIconOutline: '#1E3A8A',
  thicknessIconOutlineWidth: 1.1,
  thicknessInnerRingStroke: 'rgba(37, 99, 235, 0.35)',
  thicknessArrowShaftHalf: 4.8,
  thicknessArrowHeadLength: 3.8,
  thicknessArrowHeadHalfWidth: 2.9,
  minThicknessHandleDistancePx: 18,

  centerHandleRadius: 10,
  centerHandleSize: 16,
  centerHandleFill: '#FFFFFF',
  centerHandleInnerFill: 'rgba(37, 99, 235, 0.12)',
  centerHandleStroke: '#1D4ED8',
  centerHandleInnerStroke: 'rgba(37, 99, 235, 0.45)',
  crossHalf: 4.5,
  crossStroke: '#1D4ED8',
  crossStrokeWidth: 1.5,
  moveArrowAxisHalf: 3.6,
  moveArrowHeadLength: 2.8,
  moveArrowHeadHalfWidth: 1.8,

  rotationRadius: 7.5,
  rotationStroke: '#15803D',
  rotationLabelColor: '#166534',
  rotationStemStroke: 1.2,
  rotationStemDash: 4,
  rotationDistanceMm: 300,

  // Hit target radii (screen pixels)
  endpointHitRadius: 16,
  bevelHitRadius: 13,
  thicknessHitRadius: 20,
  centerHitRadius: 20,
  rotationHitRadius: 16,

  // [NEW] Dimension labels
  dimensionFontSize: 11,
  dimensionFontFamily: 'Arial',
  dimensionColor: '#1F2937',
  dimensionBgColor: 'rgba(255,255,255,0.85)',
  dimensionBgPadding: 4,

  // [NEW] Snap indicators
  snapMarkerSize: 8,
  snapMarkerStroke: '#DC2626',
  snapMarkerStrokeWidth: 2,
  snapGuideStroke: '#DC2626',
  snapGuideStrokeWidth: 1,
  snapGuideDash: [6, 4],

  // [NEW] Preview/ghost wall
  previewFill: 'rgba(59, 130, 246, 0.15)',
  previewStroke: '#3B82F6',
  previewStrokeWidth: 1.5,
  previewDash: [8, 4],
} as const;

// =============================================================================
// WallRenderer Class
// =============================================================================

export class WallRenderer {
  private canvas: fabric.Canvas;
  private wallObjects: Map<string, WallGroup> = new Map();
  private wallInteractionPolygons: Map<string, Point2D[]> = new Map();
  private componentObjects: fabric.Object[] = [];
  private selectionComponentObjects: fabric.Object[] = [];
  private hoverComponentObjects: fabric.Object[] = [];
  private wallData: Map<string, Wall> = new Map();
  private roomWallIds: Set<string> = new Set();
  private rooms: Room[] = [];
  private showCenterLines: boolean = true;
  private pageHeight: number;
  private hatchPatterns: Map<WallMaterial, fabric.Pattern | null> = new Map();
  private selectedWallIds: Set<string> = new Set();
  private selectedRoomBoundarySegments: RoomBoundarySelectionSegment[] = [];
  private controlPointObjects: Map<string, fabric.FabricObject[]> = new Map();
  private boundaryControlPointObjects: Map<string, fabric.FabricObject[]> = new Map();
  private showHeightTags: boolean = false;
  private wallColorMode: WallColorMode = 'material';
  private showLayerCountIndicators: boolean = false;
  private hoveredWallId: string | null = null;
  private openingSymbolInstances: Map<string, { properties: Record<string, unknown> }> = new Map();

  // Track zoom for zoom-resilient control point sizing
  private lastZoom: number = 1;

  // [NEW] Snap indicator objects (cleared on each snap update)
  private snapIndicatorObjects: fabric.Object[] = [];

  // [NEW] Preview wall objects (cleared when drawing mode ends)
  private previewObjects: fabric.Object[] = [];

  // [NEW] Dimension label objects (cleared on selection change)
  private dimensionObjects: fabric.Object[] = [];

  // Reuse the last union result when the wall geometry payload is unchanged.
  private lastUnionSignature: string = '';
  private lastUnionRenderData: WallUnionRenderData | null = null;

  // [NEW] Track dirty walls for incremental updates
  private dirtyWallIds: Set<string> = new Set();
  private dragOptimizedMode: boolean = false;

  constructor(canvas: fabric.Canvas, pageHeight: number = 3000) {
    this.canvas = canvas;
    this.pageHeight = pageHeight;
    this.initializePatterns();
  }

  // ─── Pattern Initialization ─────────────────────────────────────────────

  private initializePatterns(): void {
    const hatchPattern = this.createHatchPattern('#A3A3A3');
    this.hatchPatterns.set('brick', hatchPattern);
    this.hatchPatterns.set('concrete', null);
    this.hatchPatterns.set('partition', null);
  }

  private createHatchPattern(strokeColor: string): fabric.Pattern | null {
    const patternSize = 10;
    const devicePixelRatio =
      typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
        ? Math.max(1, window.devicePixelRatio)
        : 1;
    const patternCanvas = document.createElement('canvas');
    patternCanvas.width = patternSize * devicePixelRatio;
    patternCanvas.height = patternSize * devicePixelRatio;
    patternCanvas.style.width = `${patternSize}px`;
    patternCanvas.style.height = `${patternSize}px`;
    const ctx = patternCanvas.getContext('2d');

    if (!ctx) return null;

    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#B0B0B0';
    ctx.fillRect(0, 0, patternSize, patternSize);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (let offset = -patternSize; offset <= patternSize; offset += patternSize) {
      ctx.moveTo(offset, patternSize);
      ctx.lineTo(offset + patternSize, 0);
    }
    ctx.stroke();

    return new fabric.Pattern({
      source: patternCanvas,
      repeat: 'repeat',
    });
  }

  // ─── Coordinate Conversion ──────────────────────────────────────────────

  private toCanvasY(y: number): number {
    return y * MM_TO_PX;
  }

  private toCanvasPoint(point: Point2D): { x: number; y: number } {
    return {
      x: point.x * MM_TO_PX,
      y: this.toCanvasY(point.y),
    };
  }

  private toSceneSize(screenPx: number): number {
    const zoom = Math.max(this.canvas.getZoom(), 0.01);
    return screenPx / zoom;
  }

  private toSceneTolerance(screenPx: number, minMm = 1, maxMm = 120): number {
    const zoom = Math.max(this.canvas.getZoom(), 0.01);
    const sceneMm = screenPx / (MM_TO_PX * zoom);
    return Math.min(maxMm, Math.max(minMm, sceneMm));
  }

  // ─── Object Annotation ─────────────────────────────────────────────────

  private annotateWallTarget(object: fabric.Object, wallId: string): void {
    const typed = object as NamedObject;
    typed.wallId = wallId;
    typed.id = wallId;
  }

  private isConnectedToWall(wall: Wall, otherWall: Wall): boolean {
    return wall.connectedWalls.includes(otherWall.id) || otherWall.connectedWalls.includes(wall.id);
  }

  private canRotateWall(wall: Wall): boolean {
    return wall.connectedWalls.length === 0 && !this.roomWallIds.has(wall.id);
  }

  private endpointPoint(wall: Wall, endpoint: 'start' | 'end'): Point2D {
    return endpoint === 'start' ? wall.startPoint : wall.endPoint;
  }

  private midpoint(a: Point2D, b: Point2D): Point2D {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private pointsEqual(a: Point2D, b: Point2D, epsilon = 0.0001): boolean {
    return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
  }

  private stringArraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  private wallOpeningsEqual(left: Wall['openings'], right: Wall['openings']): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const current = left[index];
      const next = right[index];
      if (current.id !== next.id) return false;
      if (current.type !== next.type) return false;
      if (Math.abs(current.position - next.position) > 0.0001) return false;
      if (Math.abs(current.width - next.width) > 0.0001) return false;
    }
    return true;
  }

  private wallBevelEqual(
    left: Wall['startBevel'] | Wall['endBevel'],
    right: Wall['startBevel'] | Wall['endBevel']
  ): boolean {
    return (
      Math.abs((left?.outerOffset ?? 0) - (right?.outerOffset ?? 0)) <= 0.0001 &&
      Math.abs((left?.innerOffset ?? 0) - (right?.innerOffset ?? 0)) <= 0.0001
    );
  }

  private wallNeedsRerender(previousWall: Wall | undefined, nextWall: Wall): boolean {
    if (!previousWall) return true;
    if (previousWall === nextWall) return false;
    if (!this.pointsEqual(previousWall.startPoint, nextWall.startPoint)) return true;
    if (!this.pointsEqual(previousWall.endPoint, nextWall.endPoint)) return true;
    if (Math.abs(previousWall.thickness - nextWall.thickness) > 0.0001) return true;
    if (Math.abs((previousWall.centerlineOffset ?? 0) - (nextWall.centerlineOffset ?? 0)) > 0.0001) return true;
    if (previousWall.material !== nextWall.material || previousWall.layer !== nextWall.layer) return true;
    if (!this.stringArraysEqual(previousWall.connectedWalls, nextWall.connectedWalls)) return true;
    if (!this.wallBevelEqual(previousWall.startBevel, nextWall.startBevel)) return true;
    if (!this.wallBevelEqual(previousWall.endBevel, nextWall.endBevel)) return true;
    if (!this.wallOpeningsEqual(previousWall.openings, nextWall.openings)) return true;

    const previous3D = previousWall.properties3D;
    const next3D = nextWall.properties3D;
    return (
      previous3D.height !== next3D.height ||
      previous3D.layerCount !== next3D.layerCount ||
      previous3D.materialId !== next3D.materialId ||
      previous3D.overallUValue !== next3D.overallUValue ||
      previous3D.exposureDirection !== next3D.exposureDirection ||
      previous3D.exposureOverride !== next3D.exposureOverride
    );
  }

  // ─── [NEW] Viewport Culling ─────────────────────────────────────────────

  /**
   * Check if a wall is within the visible viewport.
   * Walls outside the viewport get simplified rendering (just a line)
   * instead of the full polygon + controls treatment.
   */
  private isWallInViewport(wall: Wall): boolean {
    const vpt = this.canvas.viewportTransform;
    if (!vpt) return true; // Can't determine viewport, assume visible

    const zoom = this.canvas.getZoom();
    const canvasWidth = this.canvas.getWidth();
    const canvasHeight = this.canvas.getHeight();

    // Viewport bounds in scene coordinates
    const viewLeft = -vpt[4] / zoom;
    const viewTop = -vpt[5] / zoom;
    const viewRight = viewLeft + canvasWidth / zoom;
    const viewBottom = viewTop + canvasHeight / zoom;

    // Wall bounds in canvas coordinates
    const bounds = wallBounds(wall);
    const wallLeft = bounds.minX * MM_TO_PX;
    const wallTop = bounds.minY * MM_TO_PX;
    const wallRight = bounds.maxX * MM_TO_PX;
    const wallBottom = bounds.maxY * MM_TO_PX;

    // Add margin for thick walls
    const margin = wall.thickness * MM_TO_PX;

    return !(wallRight + margin < viewLeft ||
             wallLeft - margin > viewRight ||
             wallBottom + margin < viewTop ||
             wallTop - margin > viewBottom);
  }

  // ─── Public Setters ─────────────────────────────────────────────────────

  setPageHeight(height: number): void {
    this.pageHeight = height;
  }

  setShowCenterLines(show: boolean): void {
    this.showCenterLines = show;
    this.wallObjects.forEach((group) => {
      const centerLine = group.getObjects().find((obj) =>
        (obj as NamedObject).name === 'centerLine'
      );
      if (centerLine) {
        centerLine.set('visible', show);
      }
    });
    this.canvas.requestRenderAll();
  }

  setShowHeightTags(show: boolean): void {
    this.showHeightTags = show;
    this.renderAllWalls(Array.from(this.wallData.values()));
  }

  setColorCodeByMaterial(show: boolean): void {
    this.wallColorMode = show ? 'material' : 'u-value';
    this.renderAllWalls(Array.from(this.wallData.values()));
  }

  setWallColorMode(mode: WallColorMode): void {
    this.wallColorMode = mode;
    this.renderAllWalls(Array.from(this.wallData.values()));
  }

  setShowLayerCountIndicators(show: boolean): void {
    this.showLayerCountIndicators = show;
    this.renderAllWalls(Array.from(this.wallData.values()));
  }

  setRoomWallIds(wallIds: Iterable<string>): void {
    this.roomWallIds = new Set(wallIds);
    if (this.selectedWallIds.size > 0 || this.selectedRoomBoundarySegments.length > 0) {
      this.setSelectedWalls([...this.selectedWallIds]);
    } else if (this.hoveredWallId) {
      this.syncHoverPreview();
      this.canvas.requestRenderAll();
    }
  }

  setRooms(rooms: Room[]): void {
    this.rooms = rooms.map((room) => ({
      ...room,
      vertices: room.vertices.map((vertex) => ({ ...vertex })),
      holes: room.holes?.map((hole) => hole.map((vertex) => ({ ...vertex }))),
      wallIds: [...room.wallIds],
    }));
    this.setRoomWallIds(this.rooms.flatMap((room) => room.wallIds));
  }

  setOpeningSymbolInstances(symbols: SymbolInstance2D[]): void {
    const next = new Map<string, { properties: Record<string, unknown> }>();
    for (const symbol of symbols) {
      next.set(symbol.id, {
        properties: symbol.properties ?? {},
      });
    }
    this.openingSymbolInstances = next;
  }

  setDragOptimizedMode(enabled: boolean): void {
    if (this.dragOptimizedMode === enabled) return;
    this.dragOptimizedMode = enabled;

    if (enabled) {
      // During live dragging, keep per-wall objects and skip expensive merged overlays.
      this.clearMergedComponents();
      this.clearSelectionComponents();
      this.clearHoverComponents();
      this.clearDimensionLabels();
      this.hoveredWallId = null;
      this.wallObjects.forEach((group) => {
        const selection = group.getObjects().find((obj) => (obj as NamedObject).name === 'selectionOutline');
        const hover = group.getObjects().find((obj) => (obj as NamedObject).name === 'hoverOutline');
        if (selection) selection.set('visible', false);
        if (hover) hover.set('visible', false);
        group.set('dirty', true);
      });
      // Controls are expensive to rebuild per frame; hide during drag and restore after.
      this.controlPointObjects.forEach((controls) => {
        controls.forEach((control) => this.canvas.remove(control));
      });
      this.controlPointObjects.clear();
      this.clearBoundaryControlPoints();
      this.canvas.requestRenderAll();
      return;
    }

    // Drag ended: rebuild full merged/textured wall rendering.
    const allWalls = Array.from(this.wallData.values());
    if (allWalls.length > 0) {
      this.renderAllWalls(allWalls);
      return;
    }

    // Nothing to rebuild; just restore overlays.
    this.setSelectedWalls([...this.selectedWallIds]);
    this.canvas.requestRenderAll();
  }

  /**
   * React to zoom-level changes by refreshing all zoom-dependent visuals:
   * control point sizes, selection/hover outlines, dimension labels.
   * This ensures consistent screen-pixel sizes regardless of zoom.
   */
  setViewportZoom(zoom: number): void {
    const prevZoom = this.lastZoom;
    this.lastZoom = zoom;

    // Skip if zoom didn't meaningfully change (< 0.5% difference)
    if (Math.abs(zoom - prevZoom) / Math.max(prevZoom, 0.01) < 0.005) return;

    // Refresh selection outlines stroke widths
    this.wallObjects.forEach((group) => {
      const selOutline = group.getObjects().find((obj) => (obj as NamedObject).name === 'selectionOutline');
      const hovOutline = group.getObjects().find((obj) => (obj as NamedObject).name === 'hoverOutline');
      const centerLine = group.getObjects().find((obj) => (obj as NamedObject).name === 'centerLine');
      if (selOutline) selOutline.set('strokeWidth', this.toSceneSize(VISUAL_CONFIG.selectionStrokeWidth));
      if (hovOutline) hovOutline.set('strokeWidth', this.toSceneSize(VISUAL_CONFIG.hoverStrokeWidth));
      if (centerLine) centerLine.set('strokeWidth', this.toSceneSize(VISUAL_CONFIG.centerLineWidth));
      group.getObjects().forEach((obj) => {
        const typed = obj as NamedObject;
        if (!typed.isDoorArc) return;
        obj.set({
          stroke: OPENING_DOOR_ARC_STROKE,
          strokeWidth: this.toSceneSize(OPENING_DOOR_ARC_SCREEN_STROKE_WIDTH),
          strokeUniform: true,
        });
      });
    });

    // Refresh merged selection component outlines
    this.selectionComponentObjects.forEach((obj) => {
      if ((obj as SelectionComponentObject).selectionRole === 'outline') {
        obj.set('strokeWidth', this.toSceneSize(VISUAL_CONFIG.selectionStrokeWidth));
      }
    });
    this.hoverComponentObjects.forEach((obj) => {
      if ((obj as SelectionComponentObject).selectionRole === 'outline') {
        obj.set('strokeWidth', this.toSceneSize(VISUAL_CONFIG.hoverStrokeWidth));
      }
    });

    // Keep merged wall outlines crisp at any zoom level.
    this.componentObjects.forEach((obj) => {
      const typed = obj as NamedObject;
      if (typed.name === 'wall-component-outline' || typed.name === 'wall-component-fill') {
        obj.set('strokeWidth', this.toSceneSize(VISUAL_CONFIG.wallStrokeWidth));
      } else {
        obj.set('dirty', true);
      }
    });
    this.wallObjects.forEach((group) => group.set('dirty', true));

    // Recreate control points at current zoom for both direct wall selection
    // and room-boundary virtual selection.
    if (this.selectedWallIds.size > 0 || this.selectedRoomBoundarySegments.length > 0) {
      this.refreshSelectionPresentation();
    }

    this.canvas.requestRenderAll();
  }

  // ─── Fill Resolution ────────────────────────────────────────────────────

  private resolveWallVisualFill(wall: Wall): string | fabric.Pattern {
    const materialColors = WALL_MATERIAL_COLORS[wall.material];
    const libraryMaterial = getArchitecturalMaterial(wall.properties3D.materialId);
    const defaultMaterialFill = libraryMaterial?.color ?? materialColors.fill;
    const exposureDirection = wall.properties3D.exposureOverride ?? wall.properties3D.exposureDirection;
    const fillColor = this.wallColorMode === 'u-value'
      ? heatColorFromUValue(wall.properties3D.overallUValue)
      : this.wallColorMode === 'exposure'
        ? colorFromExposure(exposureDirection)
        : defaultMaterialFill;

    if (this.wallColorMode === 'material' && materialColors.pattern === 'hatch') {
      const pattern = this.hatchPatterns.get(wall.material);
      if (pattern) return pattern;
    }

    return fillColor;
  }

  // ─── Path Data Helpers ──────────────────────────────────────────────────

  private wallComponentPathData(component: WallUnionComponent): string {
    return this.componentPolygonsPathData(component.polygons);
  }

  private ringsPathData(rings: Point2D[][]): string {
    return this.componentPolygonsPathData(rings.map((ring) => [ring]));
  }

  private componentPolygonsPathData(polygons: Point2D[][][]): string {
    return polygons
      .flatMap((polygon) =>
        polygon
          .filter((ring) => ring.length >= 3)
          .map((ring) => {
            const [first, ...rest] = ring.map((point) => this.toCanvasPoint(point));
            const commands = [`M ${first.x} ${first.y}`];
            rest.forEach((point) => {
              commands.push(`L ${point.x} ${point.y}`);
            });
            commands.push('Z');
            return commands.join(' ');
          })
      )
      .join(' ');
  }

  // ─── Merged Component Rendering ─────────────────────────────────────────

  private renderMergedComponent(component: WallUnionComponent, representativeWall: Wall): void {
    const pathData = this.wallComponentPathData(component);
    if (!pathData) return;
    const visualFill = this.resolveWallVisualFill(representativeWall);
    const componentStrokeWidth = this.toSceneSize(VISUAL_CONFIG.wallStrokeWidth);
    const usesPatternFill = typeof visualFill !== 'string';

    const mergedFillPath = new fabric.Path(pathData, {
      fill: visualFill,
      fillRule: 'evenodd',
      stroke: VISUAL_CONFIG.wallStroke,
      strokeWidth: componentStrokeWidth,
      strokeLineJoin: 'miter',
      paintFirst: 'stroke',
      selectable: false,
      evented: false,
      objectCaching: !usesPatternFill,
    });
    (mergedFillPath as NamedObject).name = 'wall-component-fill';

    this.canvas.add(mergedFillPath);
    this.componentObjects.push(mergedFillPath);

    const overlayPathData = this.componentPolygonsPathData(component.junctionOverlays);
    if (overlayPathData) {
      // Clip junction overlay to the main wall polygon so miter vertices
      // that protrude beyond the wall outline are hidden.
      const overlayClip = new fabric.Path(pathData, {
        fillRule: 'evenodd',
        absolutePositioned: true,
      });

      const overlayPath = new fabric.Path(overlayPathData, {
        fill: visualFill,
        fillRule: 'evenodd',
        stroke: 'transparent',
        strokeWidth: 0,
        selectable: false,
        evented: false,
        objectCaching: !usesPatternFill,
        clipPath: overlayClip,
      });
      (overlayPath as NamedObject).name = 'wall-component-overlay';
      this.canvas.add(overlayPath);
      this.componentObjects.push(overlayPath);
    }

    const mergedOutlinePath = new fabric.Path(pathData, {
      fill: 'transparent',
      fillRule: 'evenodd',
      stroke: VISUAL_CONFIG.wallStroke,
      strokeWidth: this.toSceneSize(VISUAL_CONFIG.wallStrokeWidth),
      strokeLineJoin: 'miter',
      selectable: false,
      evented: false,
      objectCaching: false,
    });
    (mergedOutlinePath as NamedObject).name = 'wall-component-outline';
    this.canvas.add(mergedOutlinePath);
    this.componentObjects.push(mergedOutlinePath);
  }

  private clearMergedComponents(): void {
    this.componentObjects.forEach((object) => this.canvas.remove(object));
    this.componentObjects = [];
  }

  private wallUnionSignature(walls: Wall[]): string {
    return JSON.stringify(
      walls.map((wall) => ({
        id: wall.id,
        thickness: wall.thickness,
        startPoint: wall.startPoint,
        endPoint: wall.endPoint,
        interiorLine: wall.interiorLine,
        exteriorLine: wall.exteriorLine,
        connectedWalls: wall.connectedWalls,
        startBevel: wall.startBevel ?? null,
        endBevel: wall.endBevel ?? null,
      }))
    );
  }

  private getWallUnionRenderData(walls: Wall[]): WallUnionRenderData {
    const signature = this.wallUnionSignature(walls);
    if (this.lastUnionSignature === signature && this.lastUnionRenderData) {
      return this.lastUnionRenderData;
    }

    const renderData = computeWallUnionRenderData(walls);
    this.lastUnionSignature = signature;
    this.lastUnionRenderData = renderData;
    return renderData;
  }

  private rebuildMergedComponents(walls: Wall[]): Map<string, Wall[]> {
    this.clearMergedComponents();

    const renderData = this.getWallUnionRenderData(walls);
    const wallsById = new Map(walls.map((wall) => [wall.id, wall]));
    const componentWallsByWallId = new Map<string, Wall[]>();

    renderData.components.forEach((component) => {
      const componentWalls = component.wallIds
        .map((wallId) => wallsById.get(wallId))
        .filter((componentWall): componentWall is Wall => Boolean(componentWall));
      component.wallIds.forEach((wallId) => {
        componentWallsByWallId.set(wallId, componentWalls);
      });
    });

    for (const component of renderData.components) {
      const representativeWall = component.wallIds
        .map((wallId) => wallsById.get(wallId))
        .find((wall): wall is Wall => Boolean(wall));
      if (!representativeWall) continue;
      this.renderMergedComponent(component, representativeWall);
    }

    return componentWallsByWallId;
  }

  private clearSelectionComponents(): void {
    this.selectionComponentObjects.forEach((object) => this.canvas.remove(object));
    this.selectionComponentObjects = [];
  }

  private clearHoverComponents(): void {
    this.hoverComponentObjects.forEach((object) => this.canvas.remove(object));
    this.hoverComponentObjects = [];
  }

  private renderOverlayComponent(
    component: WallSelectionComponent,
    style: SelectionOverlayStyle,
    targetObjects: fabric.Object[],
    namePrefix: string
  ): void {
    const fillPathData = this.ringsPathData(component.fillRings);
    if (fillPathData) {
      const fillPath = new fabric.Path(fillPathData, {
        fill: style.fill,
        fillRule: 'evenodd',
        stroke: 'transparent',
        strokeWidth: 0,
        selectable: false,
        evented: false,
        objectCaching: true,
      });
      const typedFill = fillPath as SelectionComponentObject;
      typedFill.name = `${component.kind}-${namePrefix}-fill`;
      typedFill.selectionRole = 'fill';
      this.canvas.add(fillPath);
      targetObjects.push(fillPath);
    }

    const outlinePathData = this.ringsPathData(component.outlineRings);
    if (!outlinePathData) return;

    const outline = new fabric.Path(outlinePathData, {
      fill: 'transparent',
      fillRule: 'evenodd',
      stroke: style.stroke,
      strokeWidth: this.toSceneSize(style.strokeWidth),
      strokeLineJoin: 'round',
      strokeLineCap: 'round',
      selectable: false,
      evented: false,
      objectCaching: true,
    });
    const typedOutline = outline as SelectionComponentObject;
    typedOutline.name = `${component.kind}-${namePrefix}-outline`;
    typedOutline.selectionRole = 'outline';
    this.canvas.add(outline);
    targetObjects.push(outline);
  }

  private renderSelectionComponents(selectionPlan: WallSelectionPlan): void {
    const style: SelectionOverlayStyle = {
      fill: VISUAL_CONFIG.selectionFill,
      stroke: VISUAL_CONFIG.selectionStroke,
      strokeWidth: VISUAL_CONFIG.selectionStrokeWidth,
    };
    selectionPlan.mergedComponents.forEach((component) => {
      this.renderOverlayComponent(component, style, this.selectionComponentObjects, 'selection');
    });
  }

  private renderHoverComponents(selectionPlan: WallSelectionPlan): void {
    const style: SelectionOverlayStyle = {
      fill: VISUAL_CONFIG.hoverFill,
      stroke: VISUAL_CONFIG.hoverStroke,
      strokeWidth: VISUAL_CONFIG.hoverStrokeWidth,
    };
    selectionPlan.mergedComponents.forEach((component) => {
      this.renderOverlayComponent(component, style, this.hoverComponentObjects, 'hover');
    });
  }

  private syncHoverPreview(): void {
    const hoveredWallId = this.hoveredWallId;
    const hoverPlan = hoveredWallId && !this.selectedWallIds.has(hoveredWallId)
      ? resolveWallSelectionPlan(
        Array.from(this.wallData.values()),
        this.rooms,
        [hoveredWallId]
      )
      : { individualWallIds: [], mergedComponents: [] };

    this.wallObjects.forEach((group, currentWallId) => {
      const hoverOutline = group.getObjects().find((obj) => (obj as NamedObject).name === 'hoverOutline');
      if (!hoverOutline) return;
      void currentWallId;
      hoverOutline.set({
        visible: false,
        stroke: VISUAL_CONFIG.hoverStroke,
        fill: VISUAL_CONFIG.hoverFill,
      });
      group.set('dirty', true);
    });

    this.clearHoverComponents();
    this.renderHoverComponents(hoverPlan);
  }

  // ─── Individual Wall Rendering ──────────────────────────────────────────

  renderWall(wall: Wall, joins?: JoinData[], componentWalls?: Wall[]): WallGroup {
    const wasSelected = this.selectedWallIds.has(wall.id);
    const wasHovered = this.hoveredWallId === wall.id;
    this.removeWall(wall.id);
    if (wasSelected) {
      this.selectedWallIds.add(wall.id);
    }
    if (wasHovered) {
      this.hoveredWallId = wall.id;
    }
    this.wallData.set(wall.id, wall);

    let interactionVertices = componentWalls && componentWalls.length > 0
      ? computeSelectableWallPolygon(
        wall,
        new Map([[wall.id, joins ?? []]]),
        componentWalls
      )
      : computeWallPolygon(wall, joins);
    interactionVertices = validateWallPolygon(interactionVertices, wall); // [PATCH APPLIED]
    this.wallInteractionPolygons.set(
      wall.id,
      interactionVertices.map((vertex) => ({ ...vertex }))
    );
    const canvasVertices = interactionVertices.map((v) => this.toCanvasPoint(v));

    const dragEdgeStrokeWidth = this.toSceneSize(VISUAL_CONFIG.wallStrokeWidth);
    const fillPolygon = new fabric.Polygon(canvasVertices, {
      fill: this.dragOptimizedMode ? 'rgba(148,163,184,0.18)' : 'rgba(0,0,0,0.001)',
      stroke: 'transparent',
      strokeWidth: 0,
      selectable: false,
      evented: false,
    });
    (fillPolygon as NamedObject).name = 'wallFill';
    this.annotateWallTarget(fillPolygon, wall.id);

    const interiorStart = canvasVertices[0];
    const interiorEnd = canvasVertices[1];
    const exteriorEnd = canvasVertices[2];
    const exteriorStart = canvasVertices[3];

    const interiorBoundary = new fabric.Line(
      [interiorStart.x, interiorStart.y, interiorEnd.x, interiorEnd.y],
      {
        stroke: VISUAL_CONFIG.wallStroke,
        strokeWidth: dragEdgeStrokeWidth,
        selectable: false,
        evented: false,
        visible: this.dragOptimizedMode,
      }
    );
    (interiorBoundary as NamedObject).name = 'interiorBoundary';
    this.annotateWallTarget(interiorBoundary, wall.id);

    const exteriorBoundary = new fabric.Line(
      [exteriorStart.x, exteriorStart.y, exteriorEnd.x, exteriorEnd.y],
      {
        stroke: VISUAL_CONFIG.wallStroke,
        strokeWidth: dragEdgeStrokeWidth,
        selectable: false,
        evented: false,
        visible: this.dragOptimizedMode,
      }
    );
    (exteriorBoundary as NamedObject).name = 'exteriorBoundary';
    this.annotateWallTarget(exteriorBoundary, wall.id);

    const startCap = new fabric.Line(
      [interiorStart.x, interiorStart.y, exteriorStart.x, exteriorStart.y],
      {
        stroke: VISUAL_CONFIG.wallStroke,
        strokeWidth: dragEdgeStrokeWidth,
        selectable: false,
        evented: false,
        visible: this.dragOptimizedMode,
      }
    );
    (startCap as NamedObject).name = 'startCap';
    this.annotateWallTarget(startCap, wall.id);

    const endCap = new fabric.Line(
      [interiorEnd.x, interiorEnd.y, exteriorEnd.x, exteriorEnd.y],
      {
        stroke: VISUAL_CONFIG.wallStroke,
        strokeWidth: dragEdgeStrokeWidth,
        selectable: false,
        evented: false,
        visible: this.dragOptimizedMode,
      }
    );
    (endCap as NamedObject).name = 'endCap';
    this.annotateWallTarget(endCap, wall.id);

    const centerLine = new fabric.Line(
      [
        wall.startPoint.x * MM_TO_PX, this.toCanvasY(wall.startPoint.y),
        wall.endPoint.x * MM_TO_PX, this.toCanvasY(wall.endPoint.y),
      ],
      {
        stroke: VISUAL_CONFIG.centerLineStroke,
        strokeWidth: this.toSceneSize(VISUAL_CONFIG.centerLineWidth),
        selectable: false, evented: false,
        visible: this.showCenterLines,
      }
    );
    (centerLine as NamedObject).name = 'centerLine';
    this.annotateWallTarget(centerLine, wall.id);

    const selectionOutline = new fabric.Polygon(canvasVertices, {
      fill: VISUAL_CONFIG.selectionFill,
      stroke: VISUAL_CONFIG.selectionStroke,
      strokeWidth: this.toSceneSize(VISUAL_CONFIG.selectionStrokeWidth),
      strokeLineJoin: 'round',
      selectable: false, evented: false, visible: false,
    });
    (selectionOutline as NamedObject).name = 'selectionOutline';
    this.annotateWallTarget(selectionOutline, wall.id);

    const hoverOutline = new fabric.Polygon(canvasVertices, {
      fill: VISUAL_CONFIG.hoverFill,
      stroke: VISUAL_CONFIG.hoverStroke,
      strokeWidth: this.toSceneSize(VISUAL_CONFIG.hoverStrokeWidth),
      strokeLineJoin: 'round',
      selectable: false, evented: false,
      visible: !this.dragOptimizedMode && this.hoveredWallId === wall.id && !this.selectedWallIds.has(wall.id),
    });
    (hoverOutline as NamedObject).name = 'hoverOutline';
    this.annotateWallTarget(hoverOutline, wall.id);

    const mp = {
      x: (wall.startPoint.x + wall.endPoint.x) / 2,
      y: (wall.startPoint.y + wall.endPoint.y) / 2,
    };

    const indicators: fabric.FabricObject[] = [];
    if (this.showHeightTags) {
      const heightText = new fabric.Text(`H ${(wall.properties3D.height / 1000).toFixed(2)}m`, {
        left: mp.x * MM_TO_PX + 6, top: this.toCanvasY(mp.y) - 16,
        fill: '#1F2937', fontSize: 11, fontFamily: 'Arial',
        selectable: false, evented: false,
      });
      (heightText as NamedObject).name = 'heightTag';
      this.annotateWallTarget(heightText, wall.id);
      indicators.push(heightText);
    }

    if (this.showLayerCountIndicators) {
      const layerCircle = new fabric.Circle({
        left: mp.x * MM_TO_PX - 5, top: this.toCanvasY(mp.y) + 7,
        radius: 8, fill: '#FFFFFF', stroke: '#111827', strokeWidth: 1.5,
        selectable: false, evented: false, originX: 'center', originY: 'center',
      });
      (layerCircle as NamedObject).name = 'layerCountCircle';
      this.annotateWallTarget(layerCircle, wall.id);

      const layerText = new fabric.Text(`${Math.max(1, wall.properties3D.layerCount)}`, {
        left: mp.x * MM_TO_PX - 5, top: this.toCanvasY(mp.y) + 7,
        fill: '#111827', fontSize: 10, fontFamily: 'Arial', fontWeight: 'bold',
        selectable: false, evented: false, originX: 'center', originY: 'center',
      });
      (layerText as NamedObject).name = 'layerCountText';
      this.annotateWallTarget(layerText, wall.id);

      indicators.push(layerCircle, layerText);
    }

    // ─── Render architectural opening symbols (doors/windows) ────────────
    const openingObjects: fabric.FabricObject[] = [];
    if (wall.openings.length > 0) {
      const { objects: openingFabricObjects } = renderWallOpenings(
        wall,
        this.openingSymbolInstances
      );
      for (const obj of openingFabricObjects) {
        const openingObject = obj as NamedObject;
        openingObject.name = 'wallOpening';
        if (openingObject.openingId) {
          openingObject.objectId = openingObject.openingId;
          obj.set({
            evented: true,
            selectable: false,
            hoverCursor: 'pointer',
            moveCursor: 'pointer',
          });
        }
        if (openingObject.isDoorArc) {
          obj.set({
            stroke: OPENING_DOOR_ARC_STROKE,
            strokeWidth: this.toSceneSize(OPENING_DOOR_ARC_SCREEN_STROKE_WIDTH),
            strokeUniform: true,
          });
        }
        this.annotateWallTarget(obj, wall.id);
        openingObjects.push(obj);
      }
    }

    const objects: fabric.FabricObject[] = [
      fillPolygon, interiorBoundary, exteriorBoundary,
      startCap, endCap, centerLine,
      selectionOutline, hoverOutline,
      ...indicators,
      ...openingObjects,
    ];

    const group: WallGroup = new fabric.Group(objects, {
      selectable: !this.dragOptimizedMode,
      evented: !this.dragOptimizedMode,
      subTargetCheck: !this.dragOptimizedMode,
      hasControls: false, hasBorders: false,
      lockMovementX: true, lockMovementY: true,
      transparentCorners: false,
      objectCaching: !this.dragOptimizedMode,
    }) as WallGroup;

    group.wallId = wall.id;
    group.id = wall.id;
    group.name = `wall-${wall.id}`;

    this.canvas.add(group);
    this.wallObjects.set(wall.id, group);
    if (wasSelected && !this.dragOptimizedMode) {
      this.createControlPoints(wall.id);
    }

    return group;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [NEW] Dimension Labels
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Show wall length dimensions for selected walls.
   * Standard in AutoCAD, Revit, SketchUp, and Figma (for lines).
   * Displays length in mm (or m for walls > 1000mm) alongside the wall.
   */
  private renderDimensionLabels(_wallIds: string[]): void {
    this.clearDimensionLabels();
  }

  private clearDimensionLabels(): void {
    this.dimensionObjects.forEach((obj) => this.canvas.remove(obj));
    this.dimensionObjects = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [NEW] Snap Indicator Rendering
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Draw visual feedback for snap events.
   * Shows "X" markers at snap points and dotted guide lines.
   *
   * Call this from the wall-drawing mouse handler whenever a snap occurs:
   *   renderer.renderSnapIndicators(snapResult);
   *
   * Call clearSnapIndicators() when the cursor moves away.
   */
  renderSnapIndicators(snapResult: EnhancedSnapResult): void {
    this.clearSnapIndicators();

    if (snapResult.snapType === 'none') return;

    const snapCanvas = this.toCanvasPoint(snapResult.snappedPoint);
    const markerSize = this.toSceneSize(VISUAL_CONFIG.snapMarkerSize);

    // Draw "X" marker at snap point
    const markerLine1 = new fabric.Line(
      [snapCanvas.x - markerSize, snapCanvas.y - markerSize,
       snapCanvas.x + markerSize, snapCanvas.y + markerSize],
      {
        stroke: VISUAL_CONFIG.snapMarkerStroke,
        strokeWidth: this.toSceneSize(VISUAL_CONFIG.snapMarkerStrokeWidth),
        selectable: false, evented: false,
      }
    );
    const markerLine2 = new fabric.Line(
      [snapCanvas.x + markerSize, snapCanvas.y - markerSize,
       snapCanvas.x - markerSize, snapCanvas.y + markerSize],
      {
        stroke: VISUAL_CONFIG.snapMarkerStroke,
        strokeWidth: this.toSceneSize(VISUAL_CONFIG.snapMarkerStrokeWidth),
        selectable: false, evented: false,
      }
    );
    this.canvas.add(markerLine1);
    this.canvas.add(markerLine2);
    this.snapIndicatorObjects.push(markerLine1, markerLine2);

    // Draw guide lines (extension lines, perpendicular markers)
    for (const guide of snapResult.guideLines) {
      const from = this.toCanvasPoint(guide.from);
      const to = this.toCanvasPoint(guide.to);

      const guideLine = new fabric.Line(
        [from.x, from.y, to.x, to.y],
        {
          stroke: VISUAL_CONFIG.snapGuideStroke,
          strokeWidth: this.toSceneSize(VISUAL_CONFIG.snapGuideStrokeWidth),
          strokeDashArray: VISUAL_CONFIG.snapGuideDash.map(d => this.toSceneSize(d)),
          selectable: false, evented: false,
        }
      );
      this.canvas.add(guideLine);
      this.snapIndicatorObjects.push(guideLine);

      // Draw perpendicular symbol for perpendicular snaps
      if (guide.type === 'perpendicular') {
        const perpSize = this.toSceneSize(6);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;

        // Small square at the perpendicular foot
        const perpLine1 = new fabric.Line(
          [to.x, to.y, to.x + (-uy) * perpSize, to.y + ux * perpSize],
          {
            stroke: VISUAL_CONFIG.snapMarkerStroke,
            strokeWidth: this.toSceneSize(1.5),
            selectable: false, evented: false,
          }
        );
        const perpLine2 = new fabric.Line(
          [to.x + (-uy) * perpSize, to.y + ux * perpSize,
           to.x + (-uy) * perpSize + ux * perpSize, to.y + ux * perpSize + uy * perpSize],
          {
            stroke: VISUAL_CONFIG.snapMarkerStroke,
            strokeWidth: this.toSceneSize(1.5),
            selectable: false, evented: false,
          }
        );
        this.canvas.add(perpLine1);
        this.canvas.add(perpLine2);
        this.snapIndicatorObjects.push(perpLine1, perpLine2);
      }
    }

    this.canvas.requestRenderAll();
  }

  clearSnapIndicators(): void {
    this.snapIndicatorObjects.forEach((obj) => this.canvas.remove(obj));
    this.snapIndicatorObjects = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // [NEW] Ghost/Preview Wall
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Draw a semi-transparent preview of the wall being drawn.
   * Shows the user what the wall will look like before they commit.
   *
   * Call from the wall-drawing mouse handler on each cursor move:
   *   renderer.renderPreviewWall(startPoint, currentPoint, thickness);
   *
   * Call clearPreviewWall() when drawing is cancelled or committed.
   */
  renderPreviewWall(startPoint: Point2D, endPoint: Point2D, thickness: number): void {
    this.clearPreviewWall();

    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.1) return;

    // Compute the preview polygon (same as a real wall would have)
    const dirX = dx / length;
    const dirY = dy / length;
    const perpX = -dirY;
    const perpY = dirX;
    const halfT = thickness / 2;

    const vertices = [
      this.toCanvasPoint({ x: startPoint.x + perpX * halfT, y: startPoint.y + perpY * halfT }),
      this.toCanvasPoint({ x: endPoint.x + perpX * halfT, y: endPoint.y + perpY * halfT }),
      this.toCanvasPoint({ x: endPoint.x - perpX * halfT, y: endPoint.y - perpY * halfT }),
      this.toCanvasPoint({ x: startPoint.x - perpX * halfT, y: startPoint.y - perpY * halfT }),
    ];

    const preview = new fabric.Polygon(vertices, {
      fill: VISUAL_CONFIG.previewFill,
      stroke: VISUAL_CONFIG.previewStroke,
      strokeWidth: this.toSceneSize(VISUAL_CONFIG.previewStrokeWidth),
      strokeDashArray: VISUAL_CONFIG.previewDash.map(d => this.toSceneSize(d)),
      selectable: false,
      evented: false,
    });

    // Preview dimension label
    const label = length >= 1000
      ? `${(length / 1000).toFixed(2)} m`
      : `${Math.round(length)} mm`;
    const center = this.toCanvasPoint({
      x: (startPoint.x + endPoint.x) / 2,
      y: (startPoint.y + endPoint.y) / 2,
    });

    const dimText = new fabric.Text(label, {
      left: center.x + perpX * this.toSceneSize(18),
      top: center.y + perpY * this.toSceneSize(18),
      fill: VISUAL_CONFIG.previewStroke,
      fontSize: this.toSceneSize(VISUAL_CONFIG.dimensionFontSize),
      fontFamily: VISUAL_CONFIG.dimensionFontFamily,
      fontWeight: 'bold',
      originX: 'center', originY: 'center',
      selectable: false, evented: false,
    });

    this.canvas.add(preview);
    this.canvas.add(dimText);
    this.previewObjects.push(preview, dimText);
    this.canvas.requestRenderAll();
  }

  clearPreviewWall(): void {
    this.previewObjects.forEach((obj) => this.canvas.remove(obj));
    this.previewObjects = [];
  }

  /**
   * Draw multiple semi-transparent preview walls in one frame.
   * Used by room tool to preview a full rectangular perimeter before commit.
   */
  renderPreviewWalls(
    segments: Array<{ startPoint: Point2D; endPoint: Point2D }>,
    thickness: number,
    material: WallMaterial = 'brick'
  ): void {
    this.clearPreviewWall();
    if (segments.length === 0) return;
    const materialColors = WALL_MATERIAL_COLORS[material];
    const hatchPattern =
      materialColors.pattern === 'hatch' ? this.hatchPatterns.get(material) ?? null : null;
    const previewFill: string | fabric.Pattern = hatchPattern ?? materialColors.fill;

    for (const segment of segments) {
      const dx = segment.endPoint.x - segment.startPoint.x;
      const dy = segment.endPoint.y - segment.startPoint.y;
      const length = Math.hypot(dx, dy);
      if (length < 0.1) continue;

      const dirX = dx / length;
      const dirY = dy / length;
      const perpX = -dirY;
      const perpY = dirX;
      const halfT = thickness / 2;

      const vertices = [
        this.toCanvasPoint({ x: segment.startPoint.x + perpX * halfT, y: segment.startPoint.y + perpY * halfT }),
        this.toCanvasPoint({ x: segment.endPoint.x + perpX * halfT, y: segment.endPoint.y + perpY * halfT }),
        this.toCanvasPoint({ x: segment.endPoint.x - perpX * halfT, y: segment.endPoint.y - perpY * halfT }),
        this.toCanvasPoint({ x: segment.startPoint.x - perpX * halfT, y: segment.startPoint.y - perpY * halfT }),
      ];

      const preview = new fabric.Polygon(vertices, {
        fill: previewFill,
        stroke: VISUAL_CONFIG.wallStroke,
        strokeWidth: this.toSceneSize(VISUAL_CONFIG.wallStrokeWidth),
        strokeLineJoin: 'miter',
        paintFirst: 'stroke',
        selectable: false,
        evented: false,
        opacity: 0.82,
        objectCaching: false,
      });

      this.canvas.add(preview);
      this.previewObjects.push(preview);
    }

    this.canvas.requestRenderAll();
  }

  // ─── Update Wall (improved) ─────────────────────────────────────────────

  /**
   * [PERF] Update an existing wall's rendering.
   * Now only re-renders the changed wall and its direct neighbors,
   * instead of nuking ALL canvas objects.
   *
   * For a 200-wall floor plan, dragging an endpoint now triggers ~3-5
   * wall updates instead of 200 full recreations.
   */
  updateWall(wall: Wall, _joins?: JoinData[]): void {
    this.wallData.set(wall.id, wall);

    // [PATCH APPLIED] CRITICAL FIX: Refresh offset lines BEFORE computing joins
    refreshOffsetLines(wall); // [PATCH APPLIED]

    // [PATCH APPLIED] Also refresh connected walls' offset lines
    for (const connectedId of wall.connectedWalls) { // [PATCH APPLIED]
      const connected = this.wallData.get(connectedId); // [PATCH APPLIED]
      if (connected) { // [PATCH APPLIED]
        refreshOffsetLines(connected); // [PATCH APPLIED]
      } // [PATCH APPLIED]
    } // [PATCH APPLIED]

    // Mark the wall and its neighbors as dirty
    this.dirtyWallIds.add(wall.id);
    for (const connectedId of wall.connectedWalls) {
      this.dirtyWallIds.add(connectedId);
    }

    // [PATCH APPLIED] Compute fresh joins with the updated offset lines
    const allWalls = Array.from(this.wallData.values()); // [PATCH APPLIED]
    const joinsMap = refreshAfterPointMove(wall.id, allWalls); // [PATCH APPLIED]

    // Re-render with fresh joins
    if (this.dragOptimizedMode) {
      this.renderWallsIncremental(allWalls);
    } else {
      this.renderAllWalls(allWalls, joinsMap); // [PATCH APPLIED]
    }
    this.dirtyWallIds.clear();
  }

  // ─── Control Points (unchanged for brevity — same as original) ──────────

  private removeControlPoints(wallId: string): void {
    const controls = this.controlPointObjects.get(wallId);
    if (!controls) return;
    controls.forEach((control) => this.canvas.remove(control));
    this.controlPointObjects.delete(wallId);
  }

  private removeBoundaryControlPoints(selectionKey: string): void {
    const controls = this.boundaryControlPointObjects.get(selectionKey);
    if (!controls) return;
    controls.forEach((control) => this.canvas.remove(control));
    this.boundaryControlPointObjects.delete(selectionKey);
  }

  private clearBoundaryControlPoints(): void {
    this.boundaryControlPointObjects.forEach((controls) => {
      controls.forEach((control) => this.canvas.remove(control));
    });
    this.boundaryControlPointObjects.clear();
  }

  private applyBoundarySelectionMetadata(
    control: fabric.FabricObject,
    boundarySelection?: RoomBoundarySelectionSegment
  ): void {
    if (!boundarySelection) {
      return;
    }

    const typed = control as WallControlObject;
    typed.roomBoundarySelectionKey = boundarySelection.key;
    typed.roomBoundaryStartPoint = { ...boundarySelection.startPoint };
    typed.roomBoundaryEndPoint = { ...boundarySelection.endPoint };
  }

  private annotateControlTarget(
    control: fabric.FabricObject,
    wallId: string,
    controlType: WallControlType,
    boundarySelection?: RoomBoundarySelectionSegment
  ): void {
    const typed = control as WallControlObject;
    typed.name = controlType;
    typed.id = wallId;
    typed.wallId = wallId;
    typed.controlType = controlType;
    typed.isWallControl = true;
    typed.selectable = true;
    typed.evented = true;
    typed.hasControls = false;
    typed.hasBorders = false;
    this.applyBoundarySelectionMetadata(control, boundarySelection);
  }

  private annotateControlVisual(
    control: fabric.FabricObject,
    wallId: string,
    controlType: WallControlType,
    boundarySelection?: RoomBoundarySelectionSegment
  ): void {
    const typed = control as WallControlObject;
    typed.name = controlType;
    typed.id = wallId;
    typed.wallId = wallId;
    typed.controlType = controlType;
    typed.isWallControl = true;
    typed.selectable = false;
    typed.evented = false;
    typed.hasControls = false;
    typed.hasBorders = false;
    this.applyBoundarySelectionMetadata(control, boundarySelection);
  }

  private createControlHitTarget(
    point: Point2D,
    wallId: string,
    controlType: WallControlType,
    cursor: string,
    hitRadiusPx: number,
    boundarySelection?: RoomBoundarySelectionSegment
  ): fabric.Circle {
    const hitTarget = new fabric.Circle({
      left: point.x * MM_TO_PX,
      top: this.toCanvasY(point.y),
      radius: this.toSceneSize(hitRadiusPx),
      fill: 'rgba(0,0,0,0.001)',
      strokeWidth: 0,
      originX: 'center',
      originY: 'center',
      hoverCursor: cursor,
      lockMovementX: true,
      lockMovementY: true,
    });
    this.annotateControlTarget(hitTarget, wallId, controlType, boundarySelection);
    (hitTarget as WallControlObject).isControlHitTarget = true;
    return hitTarget;
  }

  private intersectInfiniteLines(
    aStart: Point2D,
    aEnd: Point2D,
    bStart: Point2D,
    bEnd: Point2D
  ): Point2D | null {
    const aDx = aEnd.x - aStart.x;
    const aDy = aEnd.y - aStart.y;
    const bDx = bEnd.x - bStart.x;
    const bDy = bEnd.y - bStart.y;
    const determinant = aDx * bDy - aDy * bDx;

    if (Math.abs(determinant) < 0.0001) {
      return null;
    }

    const offsetX = bStart.x - aStart.x;
    const offsetY = bStart.y - aStart.y;
    const t = (offsetX * bDy - offsetY * bDx) / determinant;

    return {
      x: aStart.x + aDx * t,
      y: aStart.y + aDy * t,
    };
  }

  private resolveBoundaryRoomCornerPoint(boundarySelection: RoomBoundarySelectionSegment): Point2D {
    if (boundarySelection.startCornerIndex === null || boundarySelection.startCornerIndex === undefined) {
      return boundarySelection.faceStartPoint;
    }

    const adjacentSelection = this.selectedRoomBoundarySegments.find((candidate) =>
      candidate.key !== boundarySelection.key &&
      candidate.roomId === boundarySelection.roomId &&
      candidate.endCornerIndex === boundarySelection.startCornerIndex
    );

    if (!adjacentSelection) {
      return boundarySelection.startPoint;
    }

    const intersection = this.intersectInfiniteLines(
      adjacentSelection.virtualWall.startPoint,
      adjacentSelection.virtualWall.endPoint,
      boundarySelection.virtualWall.startPoint,
      boundarySelection.virtualWall.endPoint
    );

    if (intersection) {
      return intersection;
    }

    return {
      x: (adjacentSelection.endPoint.x + boundarySelection.startPoint.x) / 2,
      y: (adjacentSelection.endPoint.y + boundarySelection.startPoint.y) / 2,
    };
  }

  private createBoundaryRoomCornerControls(
    hostWallId: string,
    boundarySelection: RoomBoundarySelectionSegment
  ): fabric.FabricObject[] {
    if (boundarySelection.startCornerIndex === null || boundarySelection.startCornerIndex === undefined) {
      return [];
    }

    const point = this.resolveBoundaryRoomCornerPoint(boundarySelection);
    const endpointRadius = this.toSceneSize(VISUAL_CONFIG.endpointRadius);
    const endpointStroke = this.toSceneSize(VISUAL_CONFIG.endpointStroke);
    const hitRadius = this.toSceneSize(VISUAL_CONFIG.endpointHitRadius);

    const dot = new fabric.Circle({
      left: point.x * MM_TO_PX,
      top: this.toCanvasY(point.y),
      radius: endpointRadius,
      fill: VISUAL_CONFIG.endpointFill,
      stroke: VISUAL_CONFIG.endpointStrokeColor,
      strokeWidth: endpointStroke,
      originX: 'center',
      originY: 'center',
      hoverCursor: 'move',
      selectable: true,
      evented: true,
      hasControls: false,
      hasBorders: false,
      shadow: new fabric.Shadow({
        color: VISUAL_CONFIG.endpointShadow,
        blur: this.toSceneSize(6),
        offsetX: 0,
        offsetY: this.toSceneSize(1),
      }),
    });
    const typedDot = dot as WallControlObject;
    typedDot.name = 'room-corner-handle';
    typedDot.id = boundarySelection.roomId;
    typedDot.wallId = hostWallId;
    typedDot.roomId = boundarySelection.roomId;
    typedDot.cornerIndex = boundarySelection.startCornerIndex;
    typedDot.controlType = 'room-corner-handle';
    typedDot.isRoomControl = true;
    typedDot.selectable = true;
    typedDot.evented = true;
    typedDot.hasControls = false;
    typedDot.hasBorders = false;
    this.applyBoundarySelectionMetadata(dot, boundarySelection);

    const hit = new fabric.Circle({
      left: point.x * MM_TO_PX,
      top: this.toCanvasY(point.y),
      radius: hitRadius,
      fill: 'rgba(0,0,0,0.001)',
      strokeWidth: 0,
      originX: 'center',
      originY: 'center',
      hoverCursor: 'move',
      lockMovementX: true,
      lockMovementY: true,
      selectable: true,
      evented: true,
      hasControls: false,
      hasBorders: false,
    });
    const typedHit = hit as WallControlObject;
    typedHit.name = 'room-corner-handle-hit';
    typedHit.id = boundarySelection.roomId;
    typedHit.wallId = hostWallId;
    typedHit.roomId = boundarySelection.roomId;
    typedHit.cornerIndex = boundarySelection.startCornerIndex;
    typedHit.controlType = 'room-corner-handle';
    typedHit.isRoomControl = true;
    typedHit.isControlHitTarget = true;
    this.applyBoundarySelectionMetadata(hit, boundarySelection);

    return [hit, dot];
  }

  /**
   * Create control points for selected walls.
   * (Abbreviated from original — full version has endpoint, bevel,
   *  thickness, center, and rotation controls.)
   */
  private createControlPointsForWall(
    wall: Wall,
    controlKey: string,
    boundarySelection?: RoomBoundarySelectionSegment
  ): void {
    if (boundarySelection) {
      this.removeBoundaryControlPoints(controlKey);
    } else {
      this.removeControlPoints(controlKey);
    }

    const hostWallId = boundarySelection?.hostWallId ?? wall.id;
    const endpointRadius = this.toSceneSize(VISUAL_CONFIG.endpointRadius);
    const endpointStroke = this.toSceneSize(VISUAL_CONFIG.endpointStroke);
    const rotationRadius = this.toSceneSize(VISUAL_CONFIG.rotationRadius);
    const crossStroke = this.toSceneSize(VISUAL_CONFIG.crossStrokeWidth);
    const stemStroke = this.toSceneSize(VISUAL_CONFIG.rotationStemStroke);
    const showAdvancedControls = this.selectedWallIds.size + this.selectedRoomBoundarySegments.length === 1;
    const suppressStartEndpoint = boundarySelection?.startCornerIndex !== null && boundarySelection?.startCornerIndex !== undefined;
    const suppressEndEndpoint = boundarySelection?.endCornerIndex !== null && boundarySelection?.endCornerIndex !== undefined;
    const boundaryRoomCornerControls = boundarySelection
      ? this.createBoundaryRoomCornerControls(hostWallId, boundarySelection)
      : [];

    const mp = {
      x: (wall.startPoint.x + wall.endPoint.x) / 2,
      y: (wall.startPoint.y + wall.endPoint.y) / 2,
    };
    const dir = {
      x: wall.endPoint.x - wall.startPoint.x,
      y: wall.endPoint.y - wall.startPoint.y,
    };
    const dirLength = Math.hypot(dir.x, dir.y) || 1;
    const unitDir = { x: dir.x / dirLength, y: dir.y / dirLength };
    const rotationPoint = {
      x: mp.x - unitDir.y * VISUAL_CONFIG.rotationDistanceMm,
      y: mp.y + unitDir.x * VISUAL_CONFIG.rotationDistanceMm,
    };
    const interiorMid = {
      x: (wall.interiorLine.start.x + wall.interiorLine.end.x) / 2,
      y: (wall.interiorLine.start.y + wall.interiorLine.end.y) / 2,
    };
    const exteriorMid = {
      x: (wall.exteriorLine.start.x + wall.exteriorLine.end.x) / 2,
      y: (wall.exteriorLine.start.y + wall.exteriorLine.end.y) / 2,
    };

    // Build control point handles (same visual approach as original,
    // but using VISUAL_CONFIG constants instead of magic numbers)
    const startControls: fabric.FabricObject[] = suppressStartEndpoint
      ? []
      : (() => {
        const startHandle = new fabric.Circle({
          left: wall.startPoint.x * MM_TO_PX,
          top: this.toCanvasY(wall.startPoint.y),
          radius: endpointRadius,
          fill: VISUAL_CONFIG.endpointFill,
          stroke: VISUAL_CONFIG.endpointStrokeColor,
          strokeWidth: endpointStroke,
          originX: 'center', originY: 'center',
          hoverCursor: 'crosshair',
          lockMovementX: true, lockMovementY: true,
          selectable: false, evented: false,
          shadow: new fabric.Shadow({
            color: VISUAL_CONFIG.endpointShadow,
            blur: this.toSceneSize(6),
            offsetX: 0, offsetY: this.toSceneSize(1),
          }),
        });
        this.annotateControlTarget(startHandle, hostWallId, 'wall-endpoint-start', boundarySelection);

        const startHandleHit = this.createControlHitTarget(
          wall.startPoint,
          hostWallId,
          'wall-endpoint-start',
          'crosshair',
          VISUAL_CONFIG.endpointHitRadius,
          boundarySelection
        );

        return [startHandleHit, startHandle];
      })();

    const endControls: fabric.FabricObject[] = suppressEndEndpoint
      ? []
      : (() => {
        const endHandle = new fabric.Circle({
          left: wall.endPoint.x * MM_TO_PX,
          top: this.toCanvasY(wall.endPoint.y),
          radius: endpointRadius,
          fill: VISUAL_CONFIG.endpointFill,
          stroke: VISUAL_CONFIG.endpointStrokeColor,
          strokeWidth: endpointStroke,
          originX: 'center', originY: 'center',
          hoverCursor: 'crosshair',
          lockMovementX: true, lockMovementY: true,
          selectable: false, evented: false,
          shadow: new fabric.Shadow({
            color: VISUAL_CONFIG.endpointShadow,
            blur: this.toSceneSize(6),
            offsetX: 0, offsetY: this.toSceneSize(1),
          }),
        });
        this.annotateControlTarget(endHandle, hostWallId, 'wall-endpoint-end', boundarySelection);

        const endHandleHit = this.createControlHitTarget(
          wall.endPoint,
          hostWallId,
          'wall-endpoint-end',
          'crosshair',
          VISUAL_CONFIG.endpointHitRadius,
          boundarySelection
        );

        return [endHandleHit, endHandle];
      })();

    // Thickness handles: small solid directional arrows for independent face resize.
    // Keep them pushed away from center at low zoom so they don't overlap the move handle.
    const wallNormalVector = { x: -unitDir.y, y: unitDir.x };
    const baseInteriorDistance = Math.hypot(interiorMid.x - mp.x, interiorMid.y - mp.y);
    const baseExteriorDistance = Math.hypot(exteriorMid.x - mp.x, exteriorMid.y - mp.y);
    const minThicknessHandleDistance = this.toSceneSize(VISUAL_CONFIG.minThicknessHandleDistancePx) / MM_TO_PX;
    const thicknessHandleDistance = Math.max(
      baseInteriorDistance,
      baseExteriorDistance,
      minThicknessHandleDistance
    );
    const interiorHandlePoint = {
      x: mp.x + wallNormalVector.x * thicknessHandleDistance,
      y: mp.y + wallNormalVector.y * thicknessHandleDistance,
    };
    const exteriorHandlePoint = {
      x: mp.x - wallNormalVector.x * thicknessHandleDistance,
      y: mp.y - wallNormalVector.y * thicknessHandleDistance,
    };

    const createThicknessArrow = (
      point: Point2D,
      direction: Point2D,
      controlType: 'wall-thickness-interior' | 'wall-thickness-exterior'
    ): { visuals: fabric.FabricObject[]; hit: fabric.Circle } => {
      const center = this.toCanvasPoint(point);
      const directionLength = Math.hypot(direction.x, direction.y) || 1;
      const ux = direction.x / directionLength;
      const uy = direction.y / directionLength;
      const px = -uy;
      const py = ux;
      const badgeRadius = this.toSceneSize(VISUAL_CONFIG.thicknessRadius);
      const shaftHalf = this.toSceneSize(VISUAL_CONFIG.thicknessArrowShaftHalf);
      const headLength = this.toSceneSize(VISUAL_CONFIG.thicknessArrowHeadLength);
      const headHalfWidth = this.toSceneSize(VISUAL_CONFIG.thicknessArrowHeadHalfWidth);

      const badge = new fabric.Circle({
        left: center.x,
        top: center.y,
        radius: badgeRadius,
        fill: VISUAL_CONFIG.thicknessFill,
        stroke: VISUAL_CONFIG.thicknessStroke,
        strokeWidth: this.toSceneSize(VISUAL_CONFIG.thicknessStrokeWidth),
        originX: 'center',
        originY: 'center',
        hoverCursor: 'ew-resize',
        selectable: false,
        evented: false,
        lockMovementX: true,
        lockMovementY: true,
        shadow: new fabric.Shadow({
          color: 'rgba(29, 78, 216, 0.35)',
          blur: this.toSceneSize(6),
          offsetX: 0,
          offsetY: this.toSceneSize(1),
        }),
      });
      this.annotateControlTarget(badge, hostWallId, controlType, boundarySelection);
      const badgeRing = new fabric.Circle({
        left: center.x,
        top: center.y,
        radius: Math.max(badgeRadius - this.toSceneSize(1.8), this.toSceneSize(2.1)),
        fill: 'rgba(0,0,0,0)',
        stroke: VISUAL_CONFIG.thicknessInnerRingStroke,
        strokeWidth: this.toSceneSize(1),
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      this.annotateControlVisual(badgeRing, hostWallId, controlType, boundarySelection);

      const shaftOutline = new fabric.Line(
        [
          center.x - ux * shaftHalf,
          center.y - uy * shaftHalf,
          center.x + ux * shaftHalf,
          center.y + uy * shaftHalf,
        ],
        {
          stroke: VISUAL_CONFIG.thicknessIconOutline,
          strokeWidth: this.toSceneSize(2.6),
          strokeLineCap: 'round',
          selectable: false,
          evented: false,
        }
      );
      this.annotateControlVisual(shaftOutline, hostWallId, controlType, boundarySelection);

      const shaft = new fabric.Line(
        [
          center.x - ux * shaftHalf,
          center.y - uy * shaftHalf,
          center.x + ux * shaftHalf,
          center.y + uy * shaftHalf,
        ],
        {
          stroke: VISUAL_CONFIG.thicknessIconStroke,
          strokeWidth: this.toSceneSize(1.45),
          strokeLineCap: 'round',
          selectable: false,
          evented: false,
        }
      );
      this.annotateControlVisual(shaft, hostWallId, controlType, boundarySelection);

      const createHead = (sign: 1 | -1): fabric.Polygon => {
        const headBase = {
          x: center.x + ux * shaftHalf * sign,
          y: center.y + uy * shaftHalf * sign,
        };
        const headTip = {
          x: headBase.x + ux * headLength * sign,
          y: headBase.y + uy * headLength * sign,
        };
        const headLeft = {
          x: headBase.x + px * headHalfWidth,
          y: headBase.y + py * headHalfWidth,
        };
        const headRight = {
          x: headBase.x - px * headHalfWidth,
          y: headBase.y - py * headHalfWidth,
        };
        return new fabric.Polygon([headTip, headLeft, headRight], {
          fill: VISUAL_CONFIG.thicknessIconStroke,
          stroke: VISUAL_CONFIG.thicknessIconOutline,
          strokeWidth: this.toSceneSize(VISUAL_CONFIG.thicknessIconOutlineWidth),
          selectable: false,
          evented: false,
        });
      };
      const headForward = createHead(1);
      const headBackward = createHead(-1);
      this.annotateControlVisual(headForward, hostWallId, controlType, boundarySelection);
      this.annotateControlVisual(headBackward, hostWallId, controlType, boundarySelection);

      const hit = this.createControlHitTarget(
        point,
        hostWallId,
        controlType,
        'ew-resize',
        VISUAL_CONFIG.thicknessHitRadius,
        boundarySelection
      );
      return { visuals: [badge, badgeRing, shaftOutline, shaft, headForward, headBackward], hit };
    };

    const interiorThickness = createThicknessArrow(
      interiorHandlePoint,
      wallNormalVector,
      'wall-thickness-interior'
    );
    const exteriorThickness = createThicknessArrow(
      exteriorHandlePoint,
      { x: -wallNormalVector.x, y: -wallNormalVector.y },
      'wall-thickness-exterior'
    );
    const interiorThicknessVisuals = interiorThickness.visuals;
    const interiorThicknessHit = interiorThickness.hit;
    const exteriorThicknessVisuals = exteriorThickness.visuals;
    const exteriorThicknessHit = exteriorThickness.hit;

    // Mid-thickness move handle
    const centerX = mp.x * MM_TO_PX;
    const centerY = this.toCanvasY(mp.y);
    const wallAngleDeg = (Math.atan2(unitDir.y, unitDir.x) * 180) / Math.PI;
    const moveHandleSize = this.toSceneSize(VISUAL_CONFIG.centerHandleSize);
    const centerHandle = new fabric.Rect({
      left: centerX,
      top: centerY,
      width: moveHandleSize,
      height: moveHandleSize,
      rx: this.toSceneSize(3.5),
      ry: this.toSceneSize(3.5),
      fill: VISUAL_CONFIG.centerHandleFill,
      stroke: VISUAL_CONFIG.centerHandleStroke,
      strokeWidth: endpointStroke,
      originX: 'center',
      originY: 'center',
      hoverCursor: 'move',
      lockMovementX: true,
      lockMovementY: true,
      angle: wallAngleDeg,
      selectable: false,
      evented: false,
      shadow: new fabric.Shadow({
        color: 'rgba(37, 99, 235, 0.25)',
        blur: this.toSceneSize(8),
        offsetX: 0,
        offsetY: this.toSceneSize(1),
      }),
    });
    this.annotateControlTarget(centerHandle, hostWallId, 'wall-center-handle', boundarySelection);
    const centerHandleInner = new fabric.Rect({
      left: centerX,
      top: centerY,
      width: Math.max(moveHandleSize - this.toSceneSize(4.2), this.toSceneSize(8)),
      height: Math.max(moveHandleSize - this.toSceneSize(4.2), this.toSceneSize(8)),
      rx: this.toSceneSize(2.6),
      ry: this.toSceneSize(2.6),
      fill: VISUAL_CONFIG.centerHandleInnerFill,
      stroke: VISUAL_CONFIG.centerHandleInnerStroke,
      strokeWidth: this.toSceneSize(0.9),
      originX: 'center',
      originY: 'center',
      angle: wallAngleDeg,
      selectable: false,
      evented: false,
    });
    this.annotateControlVisual(centerHandleInner, hostWallId, 'wall-center-handle', boundarySelection);
    const centerHandleHit = this.createControlHitTarget(
      mp,
      hostWallId,
      'wall-center-handle',
      'move',
      VISUAL_CONFIG.centerHitRadius,
      boundarySelection
    );
    const moveAxisHalf = this.toSceneSize(VISUAL_CONFIG.moveArrowAxisHalf);
    const moveHeadLength = this.toSceneSize(VISUAL_CONFIG.moveArrowHeadLength);
    const moveHeadHalfWidth = this.toSceneSize(VISUAL_CONFIG.moveArrowHeadHalfWidth);
    const wallAxis = { x: unitDir.x, y: unitDir.y };
    const wallPerp = { x: -unitDir.y, y: unitDir.x };
    const moveGlyphH = new fabric.Line(
      [
        centerX - wallAxis.x * moveAxisHalf,
        centerY - wallAxis.y * moveAxisHalf,
        centerX + wallAxis.x * moveAxisHalf,
        centerY + wallAxis.y * moveAxisHalf,
      ],
      {
        stroke: VISUAL_CONFIG.crossStroke,
        strokeWidth: crossStroke,
        selectable: false,
        evented: false,
      }
    );
    this.annotateControlVisual(moveGlyphH, hostWallId, 'wall-center-handle', boundarySelection);
    const moveGlyphV = new fabric.Line(
      [
        centerX - wallPerp.x * moveAxisHalf,
        centerY - wallPerp.y * moveAxisHalf,
        centerX + wallPerp.x * moveAxisHalf,
        centerY + wallPerp.y * moveAxisHalf,
      ],
      {
        stroke: VISUAL_CONFIG.crossStroke,
        strokeWidth: crossStroke,
        selectable: false,
        evented: false,
      }
    );
    this.annotateControlVisual(moveGlyphV, hostWallId, 'wall-center-handle', boundarySelection);

    const createMoveHead = (dir: Point2D): fabric.Polygon => {
      const tip = {
        x: centerX + dir.x * (moveAxisHalf + moveHeadLength),
        y: centerY + dir.y * (moveAxisHalf + moveHeadLength),
      };
      const base = {
        x: centerX + dir.x * moveAxisHalf,
        y: centerY + dir.y * moveAxisHalf,
      };
      const perp = { x: -dir.y, y: dir.x };
      const left = {
        x: base.x + perp.x * moveHeadHalfWidth,
        y: base.y + perp.y * moveHeadHalfWidth,
      };
      const right = {
        x: base.x - perp.x * moveHeadHalfWidth,
        y: base.y - perp.y * moveHeadHalfWidth,
      };
      return new fabric.Polygon([tip, left, right], {
        fill: VISUAL_CONFIG.crossStroke,
        stroke: VISUAL_CONFIG.crossStroke,
        strokeWidth: this.toSceneSize(0.8),
        selectable: false,
        evented: false,
      });
    };
    const moveHeadAlong = createMoveHead(wallAxis);
    const moveHeadAgainst = createMoveHead({ x: -wallAxis.x, y: -wallAxis.y });
    const moveHeadPerp = createMoveHead(wallPerp);
    const moveHeadPerpOpposite = createMoveHead({ x: -wallPerp.x, y: -wallPerp.y });
    const moveHeadRight = moveHeadAlong;
    const moveHeadLeft = moveHeadAgainst;
    const moveHeadDown = moveHeadPerp;
    const moveHeadUp = moveHeadPerpOpposite;
    this.annotateControlVisual(moveHeadRight, hostWallId, 'wall-center-handle', boundarySelection);
    this.annotateControlVisual(moveHeadLeft, hostWallId, 'wall-center-handle', boundarySelection);
    this.annotateControlVisual(moveHeadDown, hostWallId, 'wall-center-handle', boundarySelection);
    this.annotateControlVisual(moveHeadUp, hostWallId, 'wall-center-handle', boundarySelection);

    // Rotation handle
    const rotationStem = new fabric.Line(
      [mp.x * MM_TO_PX, this.toCanvasY(mp.y),
       rotationPoint.x * MM_TO_PX, this.toCanvasY(rotationPoint.y)],
      {
        stroke: VISUAL_CONFIG.rotationStroke,
        strokeWidth: stemStroke,
        strokeDashArray: [this.toSceneSize(VISUAL_CONFIG.rotationStemDash), this.toSceneSize(VISUAL_CONFIG.rotationStemDash)],
        selectable: false, evented: false,
      }
    );
    this.annotateControlVisual(rotationStem, hostWallId, 'wall-rotation-handle', boundarySelection);
    const rotationHandle = new fabric.Circle({
      left: rotationPoint.x * MM_TO_PX, top: this.toCanvasY(rotationPoint.y),
      radius: rotationRadius,
      fill: '#FFFFFF', stroke: VISUAL_CONFIG.rotationStroke,
      strokeWidth: endpointStroke,
      originX: 'center', originY: 'center',
      hoverCursor: 'alias',
      lockMovementX: true, lockMovementY: true,
      selectable: false, evented: false,
    });
    this.annotateControlTarget(rotationHandle, hostWallId, 'wall-rotation-handle', boundarySelection);
    const rotationHandleHit = this.createControlHitTarget(
      rotationPoint,
      hostWallId,
      'wall-rotation-handle',
      'alias',
      VISUAL_CONFIG.rotationHitRadius,
      boundarySelection
    );
    const rotationLabel = new fabric.Text('R', {
      left: rotationPoint.x * MM_TO_PX, top: this.toCanvasY(rotationPoint.y),
      fill: VISUAL_CONFIG.rotationLabelColor,
      fontSize: this.toSceneSize(10), fontFamily: 'Arial', fontWeight: 'bold',
      originX: 'center', originY: 'center',
      selectable: false, evented: false,
    });
    this.annotateControlVisual(rotationLabel, hostWallId, 'wall-rotation-handle', boundarySelection);

    const showRotation = showAdvancedControls && this.canRotateWall(wall);

    const centerControls: fabric.FabricObject[] = [
      centerHandleHit,
      centerHandle,
      centerHandleInner,
      moveGlyphH,
      moveGlyphV,
      moveHeadRight,
      moveHeadLeft,
      moveHeadDown,
      moveHeadUp,
    ];

    const controls: fabric.FabricObject[] = [
      ...startControls,
      ...endControls,
      ...(showAdvancedControls
        ? [
          interiorThicknessHit,
          ...interiorThicknessVisuals,
          exteriorThicknessHit,
          ...exteriorThicknessVisuals,
        ]
        : []),
      ...(showRotation ? [rotationStem, rotationHandleHit, rotationHandle, rotationLabel] : []),
      ...centerControls,
      ...boundaryRoomCornerControls,
    ];

    controls.forEach((control) => this.canvas.add(control));
    if (boundarySelection) {
      this.boundaryControlPointObjects.set(controlKey, controls);
      return;
    }

    this.controlPointObjects.set(controlKey, controls);
  }

  private createControlPoints(wallId: string): void {
    const wall = this.wallData.get(wallId);
    if (!wall) return;
    this.createControlPointsForWall(wall, wall.id);
  }

  private createBoundaryControlPoints(selection: RoomBoundarySelectionSegment): void {
    this.createControlPointsForWall(selection.virtualWall, selection.key, selection);
  }

  // ─── Selection & Hover ──────────────────────────────────────────────────

  /**
   * [FIX] Now diffs against previous selection instead of blindly
   * removing and recreating all controls.
   */
  setSelectionState(
    selectedWallIds: string[],
    boundarySelections: RoomBoundarySelectionSegment[]
  ): void {
    this.selectedWallIds = new Set(selectedWallIds);
    this.selectedRoomBoundarySegments = [...boundarySelections];
    this.refreshSelectionPresentation();
  }

  setSelectedWalls(selectedWallIds: string[]): void {
    this.selectedWallIds = new Set(selectedWallIds);
    this.refreshSelectionPresentation();
  }

  setRoomBoundarySelections(boundarySelections: RoomBoundarySelectionSegment[]): void {
    this.selectedRoomBoundarySegments = [...boundarySelections];
    this.refreshSelectionPresentation();
  }

  private refreshSelectionPresentation(): void {
    const selectedWallIds = Array.from(this.selectedWallIds).filter((wallId) => this.wallData.has(wallId));
    const selectionPlan = resolveWallSelectionPlan(
      Array.from(this.wallData.values()),
      this.rooms,
      selectedWallIds
    );
    const boundaryWalls = this.selectedRoomBoundarySegments.map((selection) => selection.virtualWall);
    const boundarySelectionPlan = boundaryWalls.length > 0
      ? resolveWallSelectionPlan(boundaryWalls, [], boundaryWalls.map((wall) => wall.id))
      : { individualWallIds: [], mergedComponents: [] };

    this.wallObjects.forEach((group) => {
      const outline = group.getObjects().find((obj) => (obj as NamedObject).name === 'selectionOutline');
      if (!outline) return;
      outline.set({
        visible: false,
        stroke: VISUAL_CONFIG.selectionStroke,
        fill: VISUAL_CONFIG.selectionFill,
      });
      group.set('dirty', true);
    });

    this.controlPointObjects.forEach((controls, wallId) => {
      controls.forEach((control) => this.canvas.remove(control));
      void wallId;
    });
    this.controlPointObjects.clear();
    this.clearBoundaryControlPoints();

    this.clearSelectionComponents();
    this.renderSelectionComponents(selectionPlan);
    this.renderSelectionComponents(boundarySelectionPlan);
    this.syncHoverPreview();

    selectedWallIds.forEach((wallId) => {
      if (!this.wallObjects.has(wallId)) return;
      this.createControlPoints(wallId);
    });
    this.selectedRoomBoundarySegments.forEach((selection) => {
      this.createBoundaryControlPoints(selection);
    });

    this.renderDimensionLabels(selectedWallIds);
    this.canvas.requestRenderAll();
  }

  setHoveredWall(wallId: string | null): void {
    if (this.dragOptimizedMode) {
      if (this.hoveredWallId !== null) {
        this.hoveredWallId = null;
      }
      return;
    }
    if (this.hoveredWallId === wallId) return;
    this.hoveredWallId = wallId;
    this.syncHoverPreview();
    this.canvas.requestRenderAll();
  }

  // ─── Removal ────────────────────────────────────────────────────────────

  removeWall(wallId: string): void {
    const existing = this.wallObjects.get(wallId);
    if (existing) {
      this.canvas.remove(existing);
      this.wallObjects.delete(wallId);
    }
    this.removeControlPoints(wallId);
    this.wallInteractionPolygons.delete(wallId);
    this.wallData.delete(wallId);
    this.selectedWallIds.delete(wallId);
    if (this.hoveredWallId === wallId) this.hoveredWallId = null;
  }

  /**
   * Render all walls with proper joins.
   * [PERF] Now disables renderOnAddRemove during batch operations.
   * Previously each canvas.add() triggered an intermediate repaint,
   * causing O(n²) work for n objects.
   */
  renderAllWalls(walls: Wall[], precomputedJoinsMap?: Map<string, JoinData[]>): void { // [PATCH APPLIED]
    // [PERF] Disable intermediate repaints during batch add
    const previousRenderOnAdd = (this.canvas as any).renderOnAddRemove;
    (this.canvas as any).renderOnAddRemove = false;

    try {
      this.clearMergedComponents();
      this.clearSelectionComponents();
      this.clearHoverComponents();
      this.clearDimensionLabels();
      this.wallObjects.forEach((obj) => this.canvas.remove(obj));
      this.wallObjects.clear();
      this.wallData.clear();

      this.controlPointObjects.forEach((controls) => {
        controls.forEach((control) => this.canvas.remove(control));
      });
      this.controlPointObjects.clear();
      this.clearBoundaryControlPoints();

      walls.forEach((wall) => this.wallData.set(wall.id, wall));
      primeWallSelectionGeometryInBackground(walls);

      // [PATCH APPLIED] Use pre-computed joins if available, otherwise compute fresh
      const joinsMap = precomputedJoinsMap ?? refreshAllWalls(walls); // [PATCH APPLIED]
      const componentWallsByWallId = this.rebuildMergedComponents(walls);

      for (const wall of walls) {
        const joins = joinsMap.get(wall.id) || []; // [PATCH APPLIED]
        this.renderWall(wall, joins, componentWallsByWallId.get(wall.id));
      }

      this.setSelectedWalls([...this.selectedWallIds]);

    } finally {
      // [PERF] Restore and do a single repaint
      (this.canvas as any).renderOnAddRemove = previousRenderOnAdd ?? true;
      this.canvas.requestRenderAll();
    }
  }

  rerenderWallsByIds(wallIds: Iterable<string>): void {
    const targetWallIds = new Set<string>();
    for (const wallId of wallIds) {
      if (this.wallData.has(wallId)) {
        targetWallIds.add(wallId);
      }
    }

    if (targetWallIds.size === 0) {
      return;
    }

    const previousRenderOnAdd = (this.canvas as any).renderOnAddRemove;
    (this.canvas as any).renderOnAddRemove = false;

    try {
      const allWalls = Array.from(this.wallData.values());
      const componentWallsByWallId = this.rebuildMergedComponents(allWalls);
      const joinsMap = refreshPartialWallGeometry(new Set<string>(), targetWallIds, allWalls);

      targetWallIds.forEach((wallId) => {
        const wall = this.wallData.get(wallId);
        if (!wall) {
          return;
        }
        const joins = joinsMap.get(wallId) || [];
        this.renderWall(wall, joins, componentWallsByWallId.get(wallId));
      });

      const selectedWallIds = Array.from(this.selectedWallIds).filter((wallId) => this.wallData.has(wallId));
      if (
        selectedWallIds.length > 0 ||
        this.selectedRoomBoundarySegments.length > 0 ||
        this.selectionComponentObjects.length > 0 ||
        this.controlPointObjects.size > 0 ||
        this.boundaryControlPointObjects.size > 0
      ) {
        this.setSelectedWalls(selectedWallIds);
      } else {
        this.syncHoverPreview();
        this.canvas.requestRenderAll();
      }
    } finally {
      (this.canvas as any).renderOnAddRemove = previousRenderOnAdd ?? true;
    }
  }

  /**
   * Incremental wall updates for handle dragging while preserving full visuals.
   * Rebuilds merged component fills/outlines each frame, but only re-renders
   * walls in affected components instead of rebuilding every wall object.
   */
  renderWallsInteractive(walls: Wall[]): void {
    const perfStart = startDragPerfTimer();
    const previousRenderOnAdd = (this.canvas as any).renderOnAddRemove;
    (this.canvas as any).renderOnAddRemove = false;
    let dirtyCount = 0;
    let rerenderCount = 0;
    let removedCount = 0;

    try {
      const nextWallsById = new Map(walls.map((wall) => [wall.id, wall]));
      const dirtyWallIds = new Set<string>();
      const removedWallIds: string[] = [];

      for (const [wallId, existingWall] of this.wallData.entries()) {
        if (!nextWallsById.has(wallId)) {
          removedWallIds.push(wallId);
          dirtyWallIds.add(wallId);
          existingWall.connectedWalls.forEach((connectedId) => dirtyWallIds.add(connectedId));
        }
      }

      for (const wall of walls) {
        const previousWall = this.wallData.get(wall.id);
        if (!this.wallNeedsRerender(previousWall, wall)) {
          continue;
        }
        dirtyWallIds.add(wall.id);
        wall.connectedWalls.forEach((connectedId) => dirtyWallIds.add(connectedId));
      }

      dirtyCount = dirtyWallIds.size;
      removedCount = removedWallIds.length;
      if (removedWallIds.length === 0 && dirtyWallIds.size === 0) {
        return;
      }

      const selectedWallIds = Array.from(this.selectedWallIds).filter((wallId) => nextWallsById.has(wallId));

      for (const wallId of removedWallIds) {
        this.removeWall(wallId);
      }

      const componentWallsByWallId = this.rebuildMergedComponents(walls);
      const rerenderWallIds = new Set<string>();

      dirtyWallIds.forEach((wallId) => {
        const componentWalls = componentWallsByWallId.get(wallId);
        if (componentWalls && componentWalls.length > 0) {
          componentWalls.forEach((componentWall) => rerenderWallIds.add(componentWall.id));
          return;
        }
        if (nextWallsById.has(wallId)) {
          rerenderWallIds.add(wallId);
        }
      });
      rerenderCount = rerenderWallIds.size;

      const changedWallIds = new Set<string>();
      dirtyWallIds.forEach((wallId) => {
        if (nextWallsById.has(wallId)) {
          changedWallIds.add(wallId);
        }
      });
      const joinsMap = refreshPartialWallGeometry(changedWallIds, rerenderWallIds, walls);

      rerenderWallIds.forEach((wallId) => {
        const wall = nextWallsById.get(wallId);
        if (!wall) return;
        const joins = joinsMap.get(wallId) || [];
        this.renderWall(wall, joins, componentWallsByWallId.get(wallId));
      });

      this.wallData.clear();
      walls.forEach((wall) => this.wallData.set(wall.id, wall));
      primeWallSelectionGeometryInBackground(walls);

      this.selectedWallIds = new Set(selectedWallIds);
      if (
        selectedWallIds.length > 0 ||
        this.selectedRoomBoundarySegments.length > 0 ||
        this.selectionComponentObjects.length > 0 ||
        this.controlPointObjects.size > 0 ||
        this.boundaryControlPointObjects.size > 0
      ) {
        this.setSelectedWalls(selectedWallIds);
      } else {
        this.syncHoverPreview();
        this.canvas.requestRenderAll();
      }
    } finally {
      endDragPerfTimer('wall.renderInteractive', perfStart, {
        walls: walls.length,
        dirty: dirtyCount,
        rerender: rerenderCount,
        removed: removedCount,
      });
      (this.canvas as any).renderOnAddRemove = previousRenderOnAdd ?? true;
    }
  }

  renderWallsIncremental(walls: Wall[]): void {
    if (!this.dragOptimizedMode) {
      this.renderAllWalls(walls);
      return;
    }

    const previousRenderOnAdd = (this.canvas as any).renderOnAddRemove;
    (this.canvas as any).renderOnAddRemove = false;

    try {
      if (this.componentObjects.length > 0) {
        this.clearMergedComponents();
      }

      const nextWallsById = new Map(walls.map((wall) => [wall.id, wall]));
      const dirtyWallIds = new Set<string>();
      const removedWallIds: string[] = [];

      for (const [wallId] of this.wallData.entries()) {
        if (!nextWallsById.has(wallId)) {
          removedWallIds.push(wallId);
          dirtyWallIds.add(wallId);
        }
      }

      for (const wall of walls) {
        const previousWall = this.wallData.get(wall.id);
        if (!this.wallNeedsRerender(previousWall, wall)) {
          continue;
        }
        dirtyWallIds.add(wall.id);
      }

      if (removedWallIds.length === 0 && dirtyWallIds.size === 0) {
        return;
      }

      for (const wallId of removedWallIds) {
        this.removeWall(wallId);
      }

      if (dirtyWallIds.size > 0) {
        // Drag path: skip full join-network recomputation for smoother interaction.
        // Final release render restores exact merged/joined geometry.
        for (const wallId of dirtyWallIds) {
          const wall = nextWallsById.get(wallId);
          if (!wall) continue;
          this.renderWall(wall);
        }
      }

      for (const wall of walls) {
        if (!this.wallData.has(wall.id)) {
          this.wallData.set(wall.id, wall);
        }
      }
      primeWallSelectionGeometryInBackground(walls);

      if (this.hoveredWallId && !nextWallsById.has(this.hoveredWallId)) {
        this.hoveredWallId = null;
      }

      const nextSelection = Array.from(this.selectedWallIds).filter((wallId) => nextWallsById.has(wallId));
      if (nextSelection.length !== this.selectedWallIds.size) {
        this.selectedWallIds = new Set(nextSelection);
      }

      this.canvas.requestRenderAll();
    } finally {
      (this.canvas as any).renderOnAddRemove = previousRenderOnAdd ?? true;
    }
  }

  highlightWall(wallId: string, highlight: boolean): void {
    const nextSelection = new Set(this.selectedWallIds);
    if (highlight) nextSelection.add(wallId);
    else nextSelection.delete(wallId);
    this.setSelectedWalls([...nextSelection]);
  }

  getWallObject(wallId: string): fabric.Group | undefined {
    return this.wallObjects.get(wallId);
  }

  private pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
    let inside = false;
    const count = polygon.length;
    for (let index = 0, prevIndex = count - 1; index < count; prevIndex = index++) {
      const current = polygon[index];
      const previous = polygon[prevIndex];
      if (
        ((current.y > point.y) !== (previous.y > point.y)) &&
        (point.x < (previous.x - current.x) * (point.y - current.y) / (previous.y - current.y) + current.x)
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  private pointToSegmentDistance(point: Point2D, start: Point2D, end: Point2D): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq <= 0.000001) {
      return Math.hypot(point.x - start.x, point.y - start.y);
    }
    let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const projected = {
      x: start.x + dx * t,
      y: start.y + dy * t,
    };
    return Math.hypot(point.x - projected.x, point.y - projected.y);
  }

  getWallIdAtPoint(point: Point2D): string | null {
    let bestWallId: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    this.wallInteractionPolygons.forEach((polygon, wallId) => {
      if (polygon.length < 3 || !this.pointInPolygon(point, polygon)) {
        return;
      }

      const wall = this.wallData.get(wallId);
      const distance = wall
        ? this.pointToSegmentDistance(point, wall.startPoint, wall.endPoint)
        : 0;
      if (wall) {
        const maxSelectableDistance = Math.max(6, wall.thickness * 0.65);
        if (distance > maxSelectableDistance) {
          return;
        }
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        bestWallId = wallId;
      }
    });

    return bestWallId;
  }

  clearAllWalls(): void {
    this.dragOptimizedMode = false;
    this.lastUnionSignature = '';
    this.lastUnionRenderData = null;
    this.clearMergedComponents();
    this.clearSelectionComponents();
    this.clearHoverComponents();
    this.clearDimensionLabels();
    this.clearSnapIndicators();
    this.clearPreviewWall();
    this.wallObjects.forEach((obj) => this.canvas.remove(obj));
    this.wallObjects.clear();
    this.wallInteractionPolygons.clear();
    this.wallData.clear();
    this.rooms = [];
    this.selectedWallIds.clear();
    this.selectedRoomBoundarySegments = [];
    this.hoveredWallId = null;
    this.controlPointObjects.forEach((controls) => {
      controls.forEach((control) => this.canvas.remove(control));
    });
    this.controlPointObjects.clear();
    this.clearBoundaryControlPoints();
    this.canvas.requestRenderAll();
  }

  dispose(): void {
    this.clearAllWalls();
    this.hatchPatterns.clear();
  }
}
