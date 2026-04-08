/**
 * Section line renderer for plan view.
 */

import * as fabric from 'fabric';

import type { Point2D, SectionLine } from '../../../types';
import { DEFAULT_SECTION_LINE_COLOR } from '../../../types/wall';
import { MM_TO_PX } from '../scale';
import {
  getCanvasViewportBounds,
  hasMeaningfulViewportZoomChange,
  isViewportBoundsContained,
  type ViewportBounds,
} from '../viewportVisibility';

type NamedObject = fabric.Object & {
  id?: string;
  name?: string;
  sectionLineId?: string;
};

type SectionGroup = fabric.Group & {
  id?: string;
  name?: string;
  sectionLineId?: string;
};

interface SyncSectionLinesOptions {
  force?: boolean;
}

function toCanvasPoint(point: Point2D): Point2D {
  return {
    x: point.x * MM_TO_PX,
    y: point.y * MM_TO_PX,
  };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function normalize(v: Point2D): Point2D {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

function perpendicular(v: Point2D): Point2D {
  return { x: -v.y, y: v.x };
}

function arrowPoints(point: Point2D, direction: Point2D): Point2D[] {
  const unit = normalize(direction);
  const normal = perpendicular(unit);
  const tip = point;
  const size = 16;
  const width = 10;
  const base = {
    x: tip.x - unit.x * size,
    y: tip.y - unit.y * size,
  };
  return [
    tip,
    {
      x: base.x + normal.x * width * 0.5,
      y: base.y + normal.y * width * 0.5,
    },
    {
      x: base.x - normal.x * width * 0.5,
      y: base.y - normal.y * width * 0.5,
    },
  ];
}

export class SectionLineRenderer {
  private canvas: fabric.Canvas;
  private groups = new Map<string, SectionGroup>();
  private sectionLineData = new Map<string, SectionLine>();
  private selectedSectionLineIds = new Set<string>();
  private hoveredSectionLineId: string | null = null;
  private previewObjects: fabric.FabricObject[] = [];
  private showReferenceIndicators = true;
  private draggable = true;
  private onSectionLineMoved: ((id: string, deltaX: number, deltaY: number) => void) | null = null;
  private lastVisibilityBounds: ViewportBounds | null = null;
  private lastVisibilityZoom: number | null = null;

  constructor(canvas: fabric.Canvas) {
    this.canvas = canvas;
  }

  setDraggable(draggable: boolean): void {
    this.draggable = draggable;
  }

  onMoved(callback: (id: string, deltaX: number, deltaY: number) => void): void {
    this.onSectionLineMoved = callback;
  }

  setShowReferenceIndicators(show: boolean): void {
    if (this.showReferenceIndicators === show) {
      return;
    }
    this.showReferenceIndicators = show;
    this.syncSectionLines(Array.from(this.sectionLineData.values()), { force: true });
  }

  private annotate(target: fabric.FabricObject, sectionLineId: string, name?: string): void {
    const typed = target as NamedObject;
    typed.sectionLineId = sectionLineId;
    typed.id = sectionLineId;
    if (name) {
      typed.name = name;
    }
  }

  private createArrow(point: Point2D, direction: Point2D, color: string): fabric.Polygon {
    return new fabric.Polygon(arrowPoints(point, direction), {
      fill: color,
      stroke: color,
      strokeWidth: 1,
      selectable: false,
      evented: false,
    });
  }

  private removeSectionLine(sectionLineId: string): void {
    const group = this.groups.get(sectionLineId);
    if (group) {
      this.canvas.remove(group);
      this.groups.delete(sectionLineId);
    }
    this.sectionLineData.delete(sectionLineId);
    this.selectedSectionLineIds.delete(sectionLineId);
    if (this.hoveredSectionLineId === sectionLineId) {
      this.hoveredSectionLineId = null;
    }
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
    const visibleBounds = getCanvasViewportBounds(this.canvas, 96);
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
    this.groups.forEach((group) => {
      const visible = this.isObjectVisibleInViewport(group, visibleBounds);
      if (group.visible !== visible) {
        group.set('visible', visible);
        group.set('dirty', true);
      }
    });
  }

  private sectionLineNeedsRerender(previousSectionLine: SectionLine | undefined, nextSectionLine: SectionLine): boolean {
    return previousSectionLine !== nextSectionLine;
  }

  private syncSectionLineVisualState(): void {
    this.groups.forEach((group, sectionLineId) => {
      const selection = group
        .getObjects()
        .find((object) => (object as NamedObject).name === 'section-line-selection');
      const hover = group
        .getObjects()
        .find((object) => (object as NamedObject).name === 'section-line-hover');
      if (selection) {
        selection.set('visible', this.selectedSectionLineIds.has(sectionLineId));
      }
      if (hover) {
        hover.set('visible', this.hoveredSectionLineId === sectionLineId && !this.selectedSectionLineIds.has(sectionLineId));
      }
      group.set('dirty', true);
    });
  }

  renderSectionLine(sectionLine: SectionLine): void {
    this.removeSectionLine(sectionLine.id);
    this.sectionLineData.set(sectionLine.id, sectionLine);

    const start = toCanvasPoint(sectionLine.startPoint);
    const end = toCanvasPoint(sectionLine.endPoint);
    const directionVector = normalize(subtract(end, start));
    const normal = {
      x: perpendicular(directionVector).x * sectionLine.direction,
      y: perpendicular(directionVector).y * sectionLine.direction,
    };
    const midpoint = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };
    const color = sectionLine.color || DEFAULT_SECTION_LINE_COLOR;

    const line = new fabric.Line([start.x, start.y, end.x, end.y], {
      stroke: color,
      strokeWidth: 2.5,
      strokeDashArray: [10, 6, 2, 6],
      selectable: false,
      evented: true,
    });
    this.annotate(line, sectionLine.id, 'section-line');

    const startArrow = this.createArrow(start, {
      x: start.x - end.x,
      y: start.y - end.y,
    }, color);
    this.annotate(startArrow, sectionLine.id, 'section-line-arrow-start');

    const endArrow = this.createArrow(end, {
      x: end.x - start.x,
      y: end.y - start.y,
    }, color);
    this.annotate(endArrow, sectionLine.id, 'section-line-arrow-end');

    const viewArrowTip = {
      x: midpoint.x + normal.x * 26,
      y: midpoint.y + normal.y * 26,
    };
    const viewArrow = this.createArrow(viewArrowTip, normal, color);
    this.annotate(viewArrow, sectionLine.id, 'section-line-view-arrow');

    const label = new fabric.Text(sectionLine.label, {
      left: midpoint.x + normal.x * 38,
      top: midpoint.y + normal.y * 38,
      fontSize: 12,
      fill: color,
      fontFamily: 'Arial',
      fontWeight: 'bold',
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    this.annotate(label, sectionLine.id, 'section-line-label');

    const selectionHalo = new fabric.Line([start.x, start.y, end.x, end.y], {
      stroke: '#1D4ED8',
      strokeWidth: 5,
      selectable: false,
      evented: false,
      visible: this.selectedSectionLineIds.has(sectionLine.id),
    });
    this.annotate(selectionHalo, sectionLine.id, 'section-line-selection');

    const hoverHalo = new fabric.Line([start.x, start.y, end.x, end.y], {
      stroke: '#059669',
      strokeWidth: 4,
      selectable: false,
      evented: false,
      visible: this.hoveredSectionLineId === sectionLine.id && !this.selectedSectionLineIds.has(sectionLine.id),
    });
    this.annotate(hoverHalo, sectionLine.id, 'section-line-hover');

    const objects: fabric.FabricObject[] = [
      selectionHalo,
      hoverHalo,
      line,
      startArrow,
      endArrow,
      viewArrow,
      label,
    ];

    if (this.showReferenceIndicators && sectionLine.showReferenceIndicators) {
      const refStart = {
        x: midpoint.x - normal.x * 1000,
        y: midpoint.y - normal.y * 1000,
      };
      const refEnd = {
        x: midpoint.x + normal.x * 1000,
        y: midpoint.y + normal.y * 1000,
      };
      const reference = new fabric.Line([refStart.x, refStart.y, refEnd.x, refEnd.y], {
        stroke: color,
        strokeWidth: 1.2,
        strokeDashArray: [4, 5],
        opacity: 0.7,
        selectable: false,
        evented: false,
      });
      this.annotate(reference, sectionLine.id, 'section-line-reference');
      objects.push(reference);
    }

    const isDraggable = this.draggable && !sectionLine.locked;
    const group = new fabric.Group(objects, {
      selectable: true,
      evented: true,
      subTargetCheck: true,
      hasControls: false,
      hasBorders: false,
      lockMovementX: !isDraggable,
      lockMovementY: !isDraggable,
      objectCaching: true,
    }) as SectionGroup;
    group.id = sectionLine.id;
    group.sectionLineId = sectionLine.id;
    group.name = `section-line-${sectionLine.id}`;

    // Track drag for position updates
    if (isDraggable) {
      let dragStartLeft = 0;
      let dragStartTop = 0;
      group.on('mousedown', () => {
        dragStartLeft = group.left ?? 0;
        dragStartTop = group.top ?? 0;
      });
      group.on('mouseup', () => {
        const deltaX = (group.left ?? 0) - dragStartLeft;
        const deltaY = (group.top ?? 0) - dragStartTop;
        if ((Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) && this.onSectionLineMoved) {
          this.onSectionLineMoved(sectionLine.id, deltaX, deltaY);
        }
      });
    }

    this.canvas.add(group);
    this.groups.set(sectionLine.id, group);
  }

  renderAll(sectionLines: SectionLine[]): void {
    this.syncSectionLines(sectionLines, { force: true });
  }

  syncSectionLines(sectionLines: SectionLine[], options: SyncSectionLinesOptions = {}): void {
    const { force = false } = options;
    const nextSectionLineIds = new Set(sectionLines.map((sectionLine) => sectionLine.id));
    let changed = force;

    this.sectionLineData.forEach((_, sectionLineId) => {
      if (!nextSectionLineIds.has(sectionLineId)) {
        this.removeSectionLine(sectionLineId);
        changed = true;
      }
    });

    sectionLines.forEach((sectionLine) => {
      const previousSectionLine = this.sectionLineData.get(sectionLine.id);
      const hasGroup = this.groups.has(sectionLine.id);
      if (!force && hasGroup && !this.sectionLineNeedsRerender(previousSectionLine, sectionLine)) {
        return;
      }
      this.renderSectionLine(sectionLine);
      changed = true;
    });

    if (!changed) {
      return;
    }

    this.refreshViewportVisibility(true);
    this.syncSectionLineVisualState();
    this.canvas.requestRenderAll();
  }

  setSelectedSectionLines(ids: string[]): void {
    this.selectedSectionLineIds = new Set(ids);
    this.syncSectionLineVisualState();
    this.canvas.requestRenderAll();
  }

  setHoveredSectionLine(id: string | null): void {
    this.hoveredSectionLineId = id;
    this.syncSectionLineVisualState();
    this.canvas.requestRenderAll();
  }

  renderPreview(startPoint: Point2D, currentPoint: Point2D, direction: 1 | -1, label: string): void {
    const start = toCanvasPoint(startPoint);
    const end = toCanvasPoint(currentPoint);
    const color = DEFAULT_SECTION_LINE_COLOR;
    const directionVector = normalize(subtract(end, start));
    const normal = {
      x: perpendicular(directionVector).x * direction,
      y: perpendicular(directionVector).y * direction,
    };
    const midpoint = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };

    const arrowTip = {
      x: midpoint.x + normal.x * 24,
      y: midpoint.y + normal.y * 24,
    };
    const labelPoint = {
      x: midpoint.x + normal.x * 36,
      y: midpoint.y + normal.y * 36,
    };

    let previewLine = this.previewObjects[0] as fabric.Line | undefined;
    let previewArrow = this.previewObjects[1] as fabric.Polygon | undefined;
    let previewLabel = this.previewObjects[2] as fabric.Text | undefined;

    if (!previewLine || !previewArrow || !previewLabel) {
      previewLine = new fabric.Line([start.x, start.y, end.x, end.y], {
        stroke: color,
        strokeWidth: 2,
        strokeDashArray: [8, 6],
        selectable: false,
        evented: false,
        opacity: 0.9,
      });
      previewArrow = this.createArrow(arrowTip, normal, color);
      previewLabel = new fabric.Text(label, {
        left: labelPoint.x,
        top: labelPoint.y,
        fontSize: 11,
        fill: color,
        fontFamily: 'Arial',
        fontWeight: 'bold',
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      this.previewObjects = [previewLine, previewArrow, previewLabel];
      this.previewObjects.forEach((object) => this.canvas.add(object));
    }

    previewLine.set({
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      visible: true,
    });
    previewArrow.set({
      points: arrowPoints(arrowTip, normal),
      visible: true,
    });
    previewLabel.set({
      left: labelPoint.x,
      top: labelPoint.y,
      text: label,
      visible: true,
    });
    previewLine.setCoords();
    previewArrow.setCoords();
    previewLabel.setCoords();
    this.previewObjects.forEach((object) => {
      object.set('visible', true);
      this.canvas.bringObjectToFront(object);
    });
    this.canvas.requestRenderAll();
  }

  clearPreview(): void {
    if (this.previewObjects.length === 0) return;
    this.previewObjects.forEach((object) => object.set('visible', false));
    this.canvas.requestRenderAll();
  }

  dispose(): void {
    this.previewObjects.forEach((object) => this.canvas.remove(object));
    this.previewObjects = [];
    this.groups.forEach((group) => this.canvas.remove(group));
    this.groups.clear();
    this.sectionLineData.clear();
  }
}
