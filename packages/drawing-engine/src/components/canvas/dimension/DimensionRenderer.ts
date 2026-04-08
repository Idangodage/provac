/**
 * DimensionRenderer
 *
 * Fabric.js renderer for architectural dimensions.
 */

import * as fabric from 'fabric';

import type { Dimension2D, DimensionSettings, Room, Wall } from '../../../types';
import { DEFAULT_DIMENSION_SETTINGS } from '../../../types';
import { MM_TO_PX } from '../scale';
import {
  getCanvasViewportBounds,
  hasMeaningfulViewportZoomChange,
  isViewportBoundsContained,
  type ViewportBounds,
} from '../viewportVisibility';

import {
  getDimensionStyleProfile,
  resolveDimensionGeometry,
  type ResolvedAngularDimensionGeometry,
  type ResolvedAreaDimensionGeometry,
  type ResolvedLinearDimensionGeometry,
} from './dimensionGeometry';

type NamedObject = fabric.Object & {
  id?: string;
  name?: string;
  dimensionId?: string;
  controlType?: 'dimension-text-handle' | 'dimension-offset-handle';
  isDimensionControl?: boolean;
  isDimensionControlDecoration?: boolean;
};

type DimensionGroup = fabric.Group & { id?: string; name?: string; dimensionId?: string };

interface SyncDimensionsOptions {
  force?: boolean;
}

function toCanvas(value: number): number {
  return value * MM_TO_PX;
}

function toCanvasPoint(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: toCanvas(point.x),
    y: toCanvas(point.y),
  };
}

function lineCoords(start: { x: number; y: number }, end: { x: number; y: number }): [number, number, number, number] {
  return [toCanvas(start.x), toCanvas(start.y), toCanvas(end.x), toCanvas(end.y)];
}

function normalize(v: { x: number; y: number }): { x: number; y: number } {
  const len = Math.hypot(v.x, v.y);
  if (len < 0.000001) return { x: 1, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

function perpendicular(v: { x: number; y: number }): { x: number; y: number } {
  return { x: -v.y, y: v.x };
}

function dimensionSettingsEqual(left: DimensionSettings, right: DimensionSettings): boolean {
  return (
    left.style === right.style &&
    left.unitSystem === right.unitSystem &&
    left.displayFormat === right.displayFormat &&
    left.precision === right.precision &&
    left.defaultOffset === right.defaultOffset &&
    left.extensionGap === right.extensionGap &&
    left.extensionBeyond === right.extensionBeyond &&
    left.textHeightPaperMm === right.textHeightPaperMm &&
    left.terminator === right.terminator &&
    left.placementType === right.placementType &&
    left.showAreaPerimeter === right.showAreaPerimeter &&
    left.autoAvoidOverlap === right.autoAvoidOverlap &&
    left.showLayer === right.showLayer
  );
}

export class DimensionRenderer {
  private canvas: fabric.Canvas;
  private dimensionGroups = new Map<string, DimensionGroup>();
  private dimensionData = new Map<string, Dimension2D>();
  private selectedDimensionIds = new Set<string>();
  private hoveredDimensionId: string | null = null;
  private walls: Wall[] = [];
  private rooms: Room[] = [];
  private settings: DimensionSettings = { ...DEFAULT_DIMENSION_SETTINGS };
  private viewportZoom: number = 1;
  private liveDimensionObjects: fabric.FabricObject[] = [];
  private lastVisibilityBounds: ViewportBounds | null = null;
  private lastVisibilityZoom: number | null = null;

  constructor(canvas: fabric.Canvas) {
    this.canvas = canvas;
  }

  setViewportZoom(zoom: number): void {
    this.viewportZoom = Math.max(zoom, 0.0001);
  }

  /**
   * Lightweight in-place update of zoom-dependent visual properties on every
   * existing dimension group.  Unlike renderAllDimensions() this does NOT
   * destroy / recreate fabric objects — it only patches strokeWidth, fontSize,
   * radius, and similar screen-pixel-sized properties so they stay visually
   * consistent at the new zoom level.
   *
   * Call this after setViewportZoom() when only the zoom changed and the
   * underlying dimension data hasn't been modified.
   */
  updateZoomVisuals(): void {
    const prevZoom = (this as any)._lastZoomVisuals as number | undefined;
    const zoom = this.viewportZoom;
    if (prevZoom !== undefined && Math.abs(zoom - prevZoom) / Math.max(prevZoom, 0.01) < 0.005) {
      return; // zoom didn't meaningfully change
    }
    (this as any)._lastZoomVisuals = zoom;

    this.dimensionGroups.forEach((group, dimId) => {
      const dimension = this.dimensionData.get(dimId);
      if (!dimension) return;

      const profile = getDimensionStyleProfile(this.settings, dimension.style);

      group.getObjects().forEach((obj) => {
        const typed = obj as NamedObject;
        const name = typed.name ?? '';

        // Extension lines
        if (name === 'extensionA' || name === 'extensionB') {
          obj.set('strokeWidth', this.sp(profile.extensionStrokeWidth));
        }
        // Dimension line
        else if (name === 'dimensionLine' || name === 'angularArc') {
          obj.set('strokeWidth', this.sp(profile.dimensionStrokeWidth));
        }
        // Selection / hover halos
        else if (name === 'selectionHalo') {
          obj.set('strokeWidth', this.sp(5));
          if (obj instanceof fabric.Rect) {
            obj.set({ strokeDashArray: [this.sp(6), this.sp(4)] });
          }
        }
        else if (name === 'hoverHalo') {
          obj.set('strokeWidth', this.sp(3.5));
          if (obj instanceof fabric.Rect) {
            obj.set({ strokeDashArray: [this.sp(5), this.sp(5)] });
          }
        }
        // Angular legs
        else if (name === 'angularLegA' || name === 'angularLegB') {
          obj.set('strokeWidth', this.sp(profile.extensionStrokeWidth));
        }
        // Terminators (arrows / ticks)
        else if (name === 'terminator') {
          obj.set('strokeWidth', this.sp(0.7));
        }
        // Text label
        else if (name === 'dimensionText') {
          obj.set('fontSize', this.sp(profile.textSizePx));
        }
        // Text background
        else if (name === 'dimensionTextBg') {
          obj.set({
            strokeWidth: this.sp(1.2),
            rx: this.sp(2),
            ry: this.sp(2),
          });
        }
        // Text handle guide (dashed line to handle)
        else if (name === 'dimension-text-handle-guide') {
          obj.set({
            strokeWidth: this.sp(1.4),
            strokeDashArray: [this.sp(4), this.sp(3)],
          });
        }
        // Text handle axis
        else if (name === 'dimension-text-handle-axis') {
          obj.set('strokeWidth', this.sp(1.2));
        }
        // Control handles (text-handle / offset-handle)
        else if (typed.isDimensionControl) {
          if (typed.controlType === 'dimension-text-handle') {
            const size = this.sp(9);
            obj.set({ width: size, height: size, strokeWidth: this.sp(2.2) });
          } else if (typed.controlType === 'dimension-offset-handle') {
            const size = this.sp(12);
            obj.set({ width: size, height: size, strokeWidth: this.sp(2.2) });
          } else if (obj instanceof fabric.Circle) {
            obj.set({ radius: this.sp(6), strokeWidth: this.sp(2.2) });
          }
          obj.setCoords();
        }

        obj.set('dirty', true);
      });

      group.set('dirty', true);
    });

    this.canvas.requestRenderAll();
  }

  setContext(walls: Wall[], rooms: Room[], settings: DimensionSettings): boolean {
    const settingsChanged = !dimensionSettingsEqual(this.settings, settings);
    const contextChanged = this.walls !== walls || this.rooms !== rooms || settingsChanged;
    this.walls = walls;
    this.rooms = rooms;
    if (settingsChanged) {
      this.settings = { ...settings };
    }
    return contextChanged;
  }

  private isObjectVisibleInViewport(object: fabric.FabricObject, bounds: ViewportBounds): boolean {
    const rect = object.getBoundingRect();
    return !(
      rect.left + rect.width < bounds.left ||
      rect.left > bounds.right ||
      rect.top + rect.height < bounds.top ||
      rect.top > bounds.bottom
    );
  }

  refreshViewportVisibility(force: boolean = false): void {
    const visibleBounds = getCanvasViewportBounds(this.canvas, 120);
    const actualBounds = getCanvasViewportBounds(this.canvas, 0);
    if (!visibleBounds || !actualBounds) {
      return;
    }
    const zoom = Math.max(this.canvas.getZoom(), 0.01);
    if (
      !force &&
      this.lastVisibilityBounds &&
      !hasMeaningfulViewportZoomChange(this.lastVisibilityZoom, zoom) &&
      isViewportBoundsContained(actualBounds, this.lastVisibilityBounds)
    ) {
      return;
    }

    this.lastVisibilityBounds = visibleBounds;
    this.lastVisibilityZoom = zoom;
    this.dimensionGroups.forEach((group) => {
      const visible = this.isObjectVisibleInViewport(group, visibleBounds);
      if (group.visible !== visible) {
        group.set('visible', visible);
        group.set('dirty', true);
      }
    });
  }

  private dimensionNeedsRerender(previousDimension: Dimension2D | undefined, nextDimension: Dimension2D): boolean {
    return previousDimension !== nextDimension;
  }

  private syncDimensionVisualState(): void {
    this.dimensionGroups.forEach((group, dimensionId) => {
      const selected = this.selectedDimensionIds.has(dimensionId);
      group.getObjects().forEach((obj) => {
        const typed = obj as NamedObject;
        if (typed.name === 'selectionHalo') {
          obj.set('visible', selected);
        } else if (typed.name === 'hoverHalo') {
          obj.set('visible', !selected && this.hoveredDimensionId === dimensionId);
        } else if (typed.isDimensionControlDecoration) {
          obj.set('visible', selected);
        } else if (typed.isDimensionControl) {
          obj.set('visible', selected);
        }
      });
      group.set('dirty', true);
    });
  }

  private annotate(
    object: fabric.FabricObject,
    dimensionId: string,
    name?: string
  ): void {
    const typed = object as NamedObject;
    typed.dimensionId = dimensionId;
    typed.id = dimensionId;
    if (name) typed.name = name;
  }

  private annotateControl(
    object: fabric.FabricObject,
    dimensionId: string,
    controlType: 'dimension-text-handle' | 'dimension-offset-handle'
  ): void {
    const typed = object as NamedObject;
    typed.dimensionId = dimensionId;
    typed.id = dimensionId;
    typed.name = controlType;
    typed.controlType = controlType;
    typed.isDimensionControl = true;
    typed.selectable = true;
    typed.evented = true;
    typed.hasControls = false;
    typed.hasBorders = false;
  }

  private annotateControlDecoration(
    object: fabric.FabricObject,
    dimensionId: string,
    name: string
  ): void {
    const typed = object as NamedObject;
    typed.dimensionId = dimensionId;
    typed.id = dimensionId;
    typed.name = name;
    typed.isDimensionControlDecoration = true;
    typed.selectable = false;
    typed.evented = false;
  }

  /** Scale a screen-pixel size to canvas units, compensating for viewport zoom. */
  private sp(screenPx: number): number {
    return screenPx / this.viewportZoom;
  }

  private createTerminator(
    point: { x: number; y: number },
    direction: { x: number; y: number },
    kind: 'arrow' | 'tick',
    dimensionId: string
  ): fabric.FabricObject {
    const canvasPoint = toCanvasPoint(point);
    const unit = normalize(direction);
    const normal = perpendicular(unit);

    if (kind === 'tick') {
      const size = this.sp(12);
      const a = {
        x: canvasPoint.x - unit.x * size * 0.5 + normal.x * size * 0.5,
        y: canvasPoint.y - unit.y * size * 0.5 + normal.y * size * 0.5,
      };
      const b = {
        x: canvasPoint.x + unit.x * size * 0.5 - normal.x * size * 0.5,
        y: canvasPoint.y + unit.y * size * 0.5 - normal.y * size * 0.5,
      };
      const tick = new fabric.Line([a.x, a.y, b.x, b.y], {
        stroke: '#111827',
        strokeWidth: this.sp(1.5),
        selectable: false,
        evented: false,
      });
      this.annotate(tick, dimensionId, 'terminator');
      return tick;
    }

    // Classic CAD filled arrowhead.
    const length = this.sp(12);
    const width = this.sp(7);
    const tip = canvasPoint;
    const baseCenter = {
      x: tip.x + unit.x * length,
      y: tip.y + unit.y * length,
    };
    const left = {
      x: baseCenter.x + normal.x * width * 0.5,
      y: baseCenter.y + normal.y * width * 0.5,
    };
    const right = {
      x: baseCenter.x - normal.x * width * 0.5,
      y: baseCenter.y - normal.y * width * 0.5,
    };

    const arrowIcon = new fabric.Polygon(
      [tip, left, right],
      {
        fill: '#111827',
        stroke: '#111827',
        strokeWidth: this.sp(0.7),
        strokeLineJoin: 'miter',
        selectable: false,
        evented: false,
        objectCaching: true,
      }
    );
    this.annotate(arrowIcon, dimensionId, 'terminator');
    return arrowIcon;
  }

  private createTextWithBackground(
    label: string,
    x: number,
    y: number,
    fontSize: number,
    dimensionId: string,
    includeTextHandle = true
  ): { bg: fabric.Rect; text: fabric.Text; textHandle: fabric.Circle | null } {
    const effectiveFontSize = this.sp(fontSize);
    const text = new fabric.Text(label, {
      left: toCanvas(x),
      top: toCanvas(y),
      fill: '#0F172A',
      fontSize: effectiveFontSize,
      fontFamily: 'Arial',
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: true,
      hoverCursor: 'default',
    });
    this.annotate(text, dimensionId, 'dimensionText');

    const width = (text.width ?? 0) + this.sp(10);
    const height = (text.height ?? effectiveFontSize) + this.sp(4);
    const bg = new fabric.Rect({
      left: toCanvas(x),
      top: toCanvas(y),
      width,
      height,
      fill: '#FFFFFF',
      stroke: '#94A3B8',
      strokeWidth: this.sp(1.2),
      rx: this.sp(2),
      ry: this.sp(2),
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    this.annotate(bg, dimensionId, 'dimensionTextBg');

    let textHandle: fabric.Circle | null = null;
    if (includeTextHandle) {
      textHandle = new fabric.Circle({
        left: toCanvas(x),
        top: toCanvas(y),
        radius: this.sp(6),
        fill: '#EFF6FF',
        stroke: '#1D4ED8',
        strokeWidth: this.sp(2.2),
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: true,
        visible: this.selectedDimensionIds.has(dimensionId),
        hoverCursor: 'move',
      });
      this.annotateControl(textHandle, dimensionId, 'dimension-text-handle');
    }

    return { bg, text, textHandle };
  }

  private createLinearGroup(
    dimension: Dimension2D,
    geometry: ResolvedLinearDimensionGeometry
  ): DimensionGroup {
    const profile = getDimensionStyleProfile(this.settings, dimension.style);

    const extensionA = new fabric.Line(
      lineCoords(geometry.extensionAStart, geometry.extensionAEnd),
      {
        stroke: '#111827',
        strokeWidth: this.sp(profile.extensionStrokeWidth),
        selectable: false,
        evented: false,
      }
    );
    this.annotate(extensionA, dimension.id, 'extensionA');

    const extensionB = new fabric.Line(
      lineCoords(geometry.extensionBStart, geometry.extensionBEnd),
      {
        stroke: '#111827',
        strokeWidth: this.sp(profile.extensionStrokeWidth),
        selectable: false,
        evented: false,
      }
    );
    this.annotate(extensionB, dimension.id, 'extensionB');

    const dimensionLine = new fabric.Line(
      lineCoords(geometry.dimensionStart, geometry.dimensionEnd),
      {
        stroke: '#111827',
        strokeWidth: this.sp(profile.dimensionStrokeWidth),
        selectable: false,
        evented: true,
        hoverCursor: 'default',
      }
    );
    this.annotate(dimensionLine, dimension.id, 'dimensionLine');

    const selectionHalo = new fabric.Line(
      lineCoords(geometry.dimensionStart, geometry.dimensionEnd),
      {
        stroke: '#1D4ED8',
        strokeWidth: this.sp(5),
        selectable: false,
        evented: false,
        visible: this.selectedDimensionIds.has(dimension.id),
      }
    );
    this.annotate(selectionHalo, dimension.id, 'selectionHalo');

    const hoverHalo = new fabric.Line(
      lineCoords(geometry.dimensionStart, geometry.dimensionEnd),
      {
        stroke: '#059669',
        strokeWidth: this.sp(3.5),
        selectable: false,
        evented: false,
        visible: this.hoveredDimensionId === dimension.id && !this.selectedDimensionIds.has(dimension.id),
      }
    );
    this.annotate(hoverHalo, dimension.id, 'hoverHalo');

    const terminatorA = this.createTerminator(
      geometry.dimensionStart,
      {
        x: geometry.direction.x,
        y: geometry.direction.y,
      },
      'arrow',
      dimension.id
    );
    const terminatorB = this.createTerminator(
      geometry.dimensionEnd,
      {
        x: -geometry.direction.x,
        y: -geometry.direction.y,
      },
      'arrow',
      dimension.id
    );

    const { bg: textBg, text } = this.createTextWithBackground(
      geometry.label,
      geometry.textPosition.x,
      geometry.textPosition.y,
      profile.textSizePx,
      dimension.id,
      false
    );

    const textHandleOffset = ((textBg.width ?? 0) * 0.5) + this.sp(14);
    const textHandleCenter = {
      x: toCanvas(geometry.textPosition.x) + geometry.direction.x * textHandleOffset,
      y: toCanvas(geometry.textPosition.y) + geometry.direction.y * textHandleOffset,
    };
    const textHandleGuideStart = {
      x: toCanvas(geometry.textPosition.x) + geometry.direction.x * ((textBg.width ?? 0) * 0.5),
      y: toCanvas(geometry.textPosition.y) + geometry.direction.y * ((textBg.width ?? 0) * 0.5),
    };
    const textHandleGuide = new fabric.Line(
      [
        textHandleGuideStart.x,
        textHandleGuideStart.y,
        textHandleCenter.x,
        textHandleCenter.y,
      ],
      {
        stroke: '#1D4ED8',
        strokeWidth: this.sp(1.4),
        strokeDashArray: [this.sp(4), this.sp(3)],
        selectable: false,
        evented: false,
        visible: this.selectedDimensionIds.has(dimension.id),
      }
    );
    this.annotateControlDecoration(textHandleGuide, dimension.id, 'dimension-text-handle-guide');

    const textHandleSize = this.sp(9);
    const textHandle = new fabric.Rect({
      left: textHandleCenter.x,
      top: textHandleCenter.y,
      width: textHandleSize,
      height: textHandleSize,
      fill: '#FFFFFF',
      stroke: '#1D4ED8',
      strokeWidth: this.sp(2.2),
      angle: 45,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: true,
      hoverCursor: 'move',
      visible: this.selectedDimensionIds.has(dimension.id),
    });
    this.annotateControl(textHandle, dimension.id, 'dimension-text-handle');

    const textHandleAxis = new fabric.Line(
      [
        textHandleCenter.x - geometry.direction.x * this.sp(4),
        textHandleCenter.y - geometry.direction.y * this.sp(4),
        textHandleCenter.x + geometry.direction.x * this.sp(4),
        textHandleCenter.y + geometry.direction.y * this.sp(4),
      ],
      {
        stroke: '#1D4ED8',
        strokeWidth: this.sp(1.2),
        selectable: false,
        evented: false,
        visible: this.selectedDimensionIds.has(dimension.id),
      }
    );
    this.annotateControlDecoration(textHandleAxis, dimension.id, 'dimension-text-handle-axis');

    const offsetHandlePosition = {
      x: geometry.dimensionStart.x + (geometry.dimensionEnd.x - geometry.dimensionStart.x) * 0.75,
      y: geometry.dimensionStart.y + (geometry.dimensionEnd.y - geometry.dimensionStart.y) * 0.75,
    };
    const offsetHandleSize = this.sp(12);
    const offsetHandle = new fabric.Rect({
      left: toCanvas(offsetHandlePosition.x),
      top: toCanvas(offsetHandlePosition.y),
      width: offsetHandleSize,
      height: offsetHandleSize,
      fill: '#FFFFFF',
      stroke: '#1D4ED8',
      strokeWidth: this.sp(2.2),
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: true,
      hoverCursor: 'move',
      visible: this.selectedDimensionIds.has(dimension.id),
    });
    this.annotateControl(offsetHandle, dimension.id, 'dimension-offset-handle');

    const group = new fabric.Group(
      [
        extensionA,
        extensionB,
        selectionHalo,
        hoverHalo,
        dimensionLine,
        terminatorA,
        terminatorB,
        textBg,
        text,
        textHandleGuide,
        textHandleAxis,
        textHandle,
        offsetHandle,
      ],
      {
        selectable: true,
        evented: true,
        subTargetCheck: true,
        hasControls: false,
        hasBorders: false,
        lockMovementX: true,
        lockMovementY: true,
        hoverCursor: 'default',
        objectCaching: true,
      }
    ) as DimensionGroup;

    group.id = dimension.id;
    group.dimensionId = dimension.id;
    group.name = `dimension-${dimension.id}`;
    return group;
  }

  private createAngularArcPath(geometry: ResolvedAngularDimensionGeometry): string {
    const start = toCanvasPoint(geometry.arcStart);
    const end = toCanvasPoint(geometry.arcEnd);
    const radius = toCanvas(geometry.radius);
    const sweep = geometry.deltaAngle >= 0 ? 1 : 0;
    const largeArc = Math.abs(geometry.deltaAngle) > Math.PI ? 1 : 0;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`;
  }

  private createAngularGroup(
    dimension: Dimension2D,
    geometry: ResolvedAngularDimensionGeometry
  ): DimensionGroup {
    const profile = getDimensionStyleProfile(this.settings, dimension.style);
    const accent = geometry.isCommonAngle ? '#2563EB' : '#111827';

    const legA = new fabric.Line(lineCoords(geometry.vertex, geometry.arcStart), {
      stroke: '#111827',
      strokeWidth: this.sp(profile.extensionStrokeWidth),
      selectable: false,
      evented: false,
    });
    this.annotate(legA, dimension.id, 'angularLegA');

    const legB = new fabric.Line(lineCoords(geometry.vertex, geometry.arcEnd), {
      stroke: '#111827',
      strokeWidth: this.sp(profile.extensionStrokeWidth),
      selectable: false,
      evented: false,
    });
    this.annotate(legB, dimension.id, 'angularLegB');

    const arc = new fabric.Path(this.createAngularArcPath(geometry), {
      fill: 'transparent',
      stroke: accent,
      strokeWidth: this.sp(profile.dimensionStrokeWidth),
      selectable: false,
      evented: true,
      hoverCursor: 'default',
    });
    this.annotate(arc, dimension.id, 'angularArc');

    const selectionHalo = new fabric.Path(this.createAngularArcPath(geometry), {
      fill: 'transparent',
      stroke: '#1D4ED8',
      strokeWidth: this.sp(5),
      selectable: false,
      evented: false,
      visible: this.selectedDimensionIds.has(dimension.id),
    });
    this.annotate(selectionHalo, dimension.id, 'selectionHalo');

    const hoverHalo = new fabric.Path(this.createAngularArcPath(geometry), {
      fill: 'transparent',
      stroke: '#059669',
      strokeWidth: this.sp(3.5),
      selectable: false,
      evented: false,
      visible: this.hoveredDimensionId === dimension.id && !this.selectedDimensionIds.has(dimension.id),
    });
    this.annotate(hoverHalo, dimension.id, 'hoverHalo');

    const { bg: textBg, text, textHandle } = this.createTextWithBackground(
      geometry.label,
      geometry.textPosition.x,
      geometry.textPosition.y,
      profile.textSizePx,
      dimension.id
    );

    const group = new fabric.Group(
      [selectionHalo, hoverHalo, legA, legB, arc, textBg, text, ...(textHandle ? [textHandle] : [])],
      {
        selectable: true,
        evented: true,
        subTargetCheck: true,
        hasControls: false,
        hasBorders: false,
        lockMovementX: true,
        lockMovementY: true,
        hoverCursor: 'default',
        objectCaching: true,
      }
    ) as DimensionGroup;

    group.id = dimension.id;
    group.dimensionId = dimension.id;
    group.name = `dimension-${dimension.id}`;
    return group;
  }

  private createAreaGroup(
    dimension: Dimension2D,
    geometry: ResolvedAreaDimensionGeometry
  ): DimensionGroup {
    const profile = getDimensionStyleProfile(this.settings, dimension.style);
    const { bg: textBg, text, textHandle } = this.createTextWithBackground(
      geometry.label,
      geometry.textPosition.x,
      geometry.textPosition.y,
      profile.textSizePx + 1,
      dimension.id
    );

    const selectionHalo = new fabric.Rect({
      left: toCanvas(geometry.textPosition.x),
      top: toCanvas(geometry.textPosition.y),
      width: (text.width ?? 0) + this.sp(16),
      height: (text.height ?? 0) + this.sp(10),
      stroke: '#1D4ED8',
      strokeWidth: this.sp(3),
      fill: 'rgba(37,99,235,0.08)',
      strokeDashArray: [this.sp(6), this.sp(4)],
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      visible: this.selectedDimensionIds.has(dimension.id),
    });
    this.annotate(selectionHalo, dimension.id, 'selectionHalo');

    const hoverHalo = new fabric.Rect({
      left: toCanvas(geometry.textPosition.x),
      top: toCanvas(geometry.textPosition.y),
      width: (text.width ?? 0) + this.sp(14),
      height: (text.height ?? 0) + this.sp(8),
      stroke: '#059669',
      strokeWidth: this.sp(2.5),
      fill: 'rgba(16,185,129,0.08)',
      strokeDashArray: [this.sp(5), this.sp(5)],
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      visible: this.hoveredDimensionId === dimension.id && !this.selectedDimensionIds.has(dimension.id),
    });
    this.annotate(hoverHalo, dimension.id, 'hoverHalo');

    const group = new fabric.Group([selectionHalo, hoverHalo, textBg, text, ...(textHandle ? [textHandle] : [])], {
      selectable: true,
      evented: true,
      subTargetCheck: true,
      hasControls: false,
      hasBorders: false,
      lockMovementX: true,
      lockMovementY: true,
      hoverCursor: 'default',
      objectCaching: true,
    }) as DimensionGroup;

    group.id = dimension.id;
    group.dimensionId = dimension.id;
    group.name = `dimension-${dimension.id}`;
    return group;
  }

  private createDimensionGroup(dimension: Dimension2D): DimensionGroup | null {
    const geometry = resolveDimensionGeometry(dimension, this.walls, this.rooms, this.settings);
    if (!geometry) return null;

    if (geometry.kind === 'linear') {
      return this.createLinearGroup(dimension, geometry);
    }
    if (geometry.kind === 'angular') {
      return this.createAngularGroup(dimension, geometry);
    }
    return this.createAreaGroup(dimension, geometry);
  }

  renderDimension(dimension: Dimension2D): void {
    this.removeDimension(dimension.id);
    this.dimensionData.set(dimension.id, dimension);
    if (!dimension.visible || !this.settings.showLayer) return;

    const group = this.createDimensionGroup(dimension);
    if (!group) return;

    this.dimensionGroups.set(dimension.id, group);
    this.canvas.add(group);
    this.canvas.bringObjectToFront(group);
  }

  renderAllDimensions(dimensions: Dimension2D[]): void {
    this.syncDimensions(dimensions, { force: true });
  }

  syncDimensions(dimensions: Dimension2D[], options: SyncDimensionsOptions = {}): void {
    const { force = false } = options;
    const nextDimensionIds = new Set(dimensions.map((dimension) => dimension.id));
    let changed = force;

    this.dimensionData.forEach((_, dimensionId) => {
      if (!nextDimensionIds.has(dimensionId)) {
        this.removeDimension(dimensionId);
        changed = true;
      }
    });

    dimensions.forEach((dimension) => {
      const previousDimension = this.dimensionData.get(dimension.id);
      const hasGroup = this.dimensionGroups.has(dimension.id);
      if (!force && hasGroup && !this.dimensionNeedsRerender(previousDimension, dimension)) {
        return;
      }
      this.renderDimension(dimension);
      changed = true;
    });

    if (!changed) {
      return;
    }

    this.refreshViewportVisibility(true);
    this.syncDimensionVisualState();
    this.canvas.requestRenderAll();
  }

  setSelectedDimensions(dimensionIds: string[]): void {
    this.selectedDimensionIds = new Set(dimensionIds);
    this.syncDimensionVisualState();
    this.canvas.requestRenderAll();
  }

  setHoveredDimension(dimensionId: string | null): void {
    this.hoveredDimensionId = dimensionId;
    this.syncDimensionVisualState();
    this.canvas.requestRenderAll();
  }

  removeDimension(dimensionId: string): void {
    const group = this.dimensionGroups.get(dimensionId);
    if (group) {
      this.canvas.remove(group);
      this.dimensionGroups.delete(dimensionId);
    }
    this.dimensionData.delete(dimensionId);
    this.selectedDimensionIds.delete(dimensionId);
    if (this.hoveredDimensionId === dimensionId) {
      this.hoveredDimensionId = null;
    }
  }

  getDimensionObject(dimensionId: string): DimensionGroup | undefined {
    return this.dimensionGroups.get(dimensionId);
  }

  clearAllDimensions(): void {
    this.dimensionGroups.forEach((group) => this.canvas.remove(group));
    this.dimensionGroups.clear();
    this.dimensionData.clear();
    this.selectedDimensionIds.clear();
    this.hoveredDimensionId = null;
    this.canvas.requestRenderAll();
  }

  /**
   * Render a live/elastic dimension preview while drawing a wall.
   * startMm and endMm are in world mm coordinates.
   * label is the pre-formatted measurement string.
   */
  renderLiveDimension(
    startMm: { x: number; y: number },
    endMm: { x: number; y: number },
    label: string
  ): void {
    const startC = toCanvasPoint(startMm);
    const endC = toCanvasPoint(endMm);
    const dx = endC.x - startC.x;
    const dy = endC.y - startC.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;

    // Canonical direction: normalise so we always travel in the
    // positive-X direction (or positive-Y for vertical walls).
    // This ensures the perpendicular normal always points to the same
    // side regardless of which endpoint the user started from.
    const rawDirX = dx / len;
    const rawDirY = dy / len;
    const flip = rawDirX < 0 || (rawDirX === 0 && rawDirY < 0);
    const dir = flip ? { x: -rawDirX, y: -rawDirY } : { x: rawDirX, y: rawDirY };

    // Always use the true perpendicular to the wall direction.
    // This guarantees extension lines are perpendicular to the wall regardless of its angle.
    const normal: { x: number; y: number } = { x: -dir.y, y: dir.x };

    const offsetDist = this.sp(70);
    const gapDist = this.sp(4);
    const beyondDist = this.sp(6);
    const tickSize = this.sp(10);

    const dimStart = { x: startC.x + normal.x * offsetDist, y: startC.y + normal.y * offsetDist };
    const dimEnd   = { x: endC.x   + normal.x * offsetDist, y: endC.y   + normal.y * offsetDist };

    const dimLineCoords: [number, number, number, number] = [dimStart.x, dimStart.y, dimEnd.x, dimEnd.y];
    const extACoords: [number, number, number, number] = [
      startC.x + normal.x * gapDist,
      startC.y + normal.y * gapDist,
      dimStart.x + normal.x * beyondDist,
      dimStart.y + normal.y * beyondDist,
    ];
    const extBCoords: [number, number, number, number] = [
      endC.x + normal.x * gapDist,
      endC.y + normal.y * gapDist,
      dimEnd.x + normal.x * beyondDist,
      dimEnd.y + normal.y * beyondDist,
    ];

    const tickCoords = (pt: { x: number; y: number }): [number, number, number, number] => {
      const a = { x: pt.x - dir.x * tickSize * 0.5 + normal.x * tickSize * 0.5, y: pt.y - dir.y * tickSize * 0.5 + normal.y * tickSize * 0.5 };
      const b = { x: pt.x + dir.x * tickSize * 0.5 - normal.x * tickSize * 0.5, y: pt.y + dir.y * tickSize * 0.5 - normal.y * tickSize * 0.5 };
      return [a.x, a.y, b.x, b.y];
    };
    const tickACoords = tickCoords(dimStart);
    const tickBCoords = tickCoords(dimEnd);

    // Text label at midpoint, pushed slightly further along normal
    const textOffsetDist = offsetDist + this.sp(18);
    const midC = { x: (startC.x + endC.x) / 2 + normal.x * textOffsetDist, y: (startC.y + endC.y) / 2 + normal.y * textOffsetDist };

    let liveObjects = this.liveDimensionObjects as [
      fabric.Line,
      fabric.Line,
      fabric.Line,
      fabric.Line,
      fabric.Line,
      fabric.Rect,
      fabric.FabricText,
    ] | [];

    if (liveObjects.length !== 7) {
      const dimLine = new fabric.Line(dimLineCoords, {
        stroke: '#2563EB',
        strokeWidth: this.sp(1.5),
        selectable: false, evented: false,
      });
      const extA = new fabric.Line(extACoords, {
        stroke: '#2563EB',
        strokeWidth: this.sp(1),
        selectable: false,
        evented: false,
      });
      const extB = new fabric.Line(extBCoords, {
        stroke: '#2563EB',
        strokeWidth: this.sp(1),
        selectable: false,
        evented: false,
      });
      const tickA = new fabric.Line(tickACoords, {
        stroke: '#2563EB',
        strokeWidth: this.sp(1.5),
        selectable: false,
        evented: false,
      });
      const tickB = new fabric.Line(tickBCoords, {
        stroke: '#2563EB',
        strokeWidth: this.sp(1.5),
        selectable: false,
        evented: false,
      });
      const textObj = new fabric.FabricText(label, {
        left: midC.x, top: midC.y,
        fill: '#1E40AF',
        fontSize: this.sp(13),
        fontFamily: 'Arial',
        fontWeight: '600',
        originX: 'center', originY: 'center',
        selectable: false, evented: false,
      });
      const bg = new fabric.Rect({
        left: midC.x, top: midC.y,
        width: (textObj.width ?? 0) + this.sp(10),
        height: (textObj.height ?? this.sp(13)) + this.sp(6),
        fill: '#EFF6FF',
        stroke: '#2563EB',
        strokeWidth: this.sp(1),
        rx: this.sp(3), ry: this.sp(3),
        originX: 'center', originY: 'center',
        selectable: false, evented: false,
      });
      liveObjects = [extA, extB, dimLine, tickA, tickB, bg, textObj];
      this.liveDimensionObjects = liveObjects;
      liveObjects.forEach((obj) => this.canvas.add(obj));
    } else {
      const [liveExtA, liveExtB, liveDimLine, liveTickA, liveTickB, liveBg, liveText] = liveObjects;
      liveExtA.set({ x1: extACoords[0], y1: extACoords[1], x2: extACoords[2], y2: extACoords[3], visible: true });
      liveExtB.set({ x1: extBCoords[0], y1: extBCoords[1], x2: extBCoords[2], y2: extBCoords[3], visible: true });
      liveDimLine.set({ x1: dimLineCoords[0], y1: dimLineCoords[1], x2: dimLineCoords[2], y2: dimLineCoords[3], visible: true });
      liveTickA.set({ x1: tickACoords[0], y1: tickACoords[1], x2: tickACoords[2], y2: tickACoords[3], visible: true });
      liveTickB.set({ x1: tickBCoords[0], y1: tickBCoords[1], x2: tickBCoords[2], y2: tickBCoords[3], visible: true });
      liveText.set({
        left: midC.x,
        top: midC.y,
        text: label,
        fontSize: this.sp(13),
        visible: true,
      });
      liveText.setCoords();
      liveBg.set({
        left: midC.x,
        top: midC.y,
        width: (liveText.width ?? 0) + this.sp(10),
        height: (liveText.height ?? this.sp(13)) + this.sp(6),
        visible: true,
      });
      liveBg.setCoords();
      [liveExtA, liveExtB, liveDimLine, liveTickA, liveTickB].forEach((obj) => obj.setCoords());
    }

    this.liveDimensionObjects.forEach((obj) => {
      obj.set('visible', true);
      this.canvas.bringObjectToFront(obj);
    });
    this.canvas.requestRenderAll();
  }

  clearLiveDimension(): void {
    if (this.liveDimensionObjects.length > 0) {
      this.liveDimensionObjects.forEach((obj) => obj.set('visible', false));
      this.canvas.requestRenderAll();
    }
  }

  dispose(): void {
    this.clearAllDimensions();
    this.liveDimensionObjects.forEach((obj) => this.canvas.remove(obj));
    this.liveDimensionObjects = [];
  }
}
