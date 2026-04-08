/**
 * ObjectRenderer
 *
 * Renders architectural library objects placed on plan.
 */

import * as fabric from 'fabric';

import type { ArchitecturalObjectDefinition } from '../../../data';
import type { SymbolInstance2D, Wall, Opening } from '../../../types';
import { endDragPerfTimer, startDragPerfTimer } from '../perf/dragPerf';
import { MM_TO_PX } from '../scale';
import { renderOpeningPreview } from '../wall/OpeningRenderer';

import { hasRenderer, renderFurniturePlan } from './FurnitureSymbolRenderer';

type NamedObject = fabric.Object & {
  id?: string;
  name?: string;
  objectId?: string;
  objectCategory?: ArchitecturalObjectDefinition['category'];
  allowRotationControl?: boolean;
};

type ObjectGroup = fabric.Group & {
  id?: string;
  objectId?: string;
  name?: string;
  isOpeningSymbol?: boolean;
  objectCategory?: ArchitecturalObjectDefinition['category'];
  allowRotationControl?: boolean;
};

function definitionFallback(definitionId: string): ArchitecturalObjectDefinition {
  return {
    id: definitionId,
    name: 'Object',
    category: 'my-library',
    type: 'custom',
    widthMm: 900,
    depthMm: 600,
    heightMm: 900,
    tags: ['custom'],
    view: 'plan-2d',
  };
}

function toPx(mm: number, scale: number): number {
  return mm * MM_TO_PX * scale;
}

const DOOR_ARC_ACCENT = '#2b160b';
const DOOR_ARC_STROKE_WIDTH = 1.2;
const DOOR_LEAF_ACCENT = '#2b160b';
const WALL_SEGMENT_FILL = '#000007';
const WALL_SEGMENT_STROKE = '#111827';
const MAX_BITMAP_SYMBOL_SIDE_PX = 384;
const BITMAP_SYMBOL_DPR = 2;

function makeLine(
  coords: [number, number, number, number],
  stroke: string,
  strokeWidth: number,
  dash?: number[],
  strokeUniform = false,
): fabric.Line {
  return new fabric.Line(coords, {
    stroke,
    strokeWidth,
    strokeDashArray: dash,
    strokeUniform,
    selectable: false,
    evented: false,
  });
}

function openingWallStubs(
  widthPx: number,
  wallThicknessPx: number,
  stroke: string,
  isError: boolean
): fabric.FabricObject[] {
  const openingWidth = Math.max(24, widthPx);
  const halfW = openingWidth / 2;
  const jambHalf = Math.max(5, Math.min(14, Math.max(wallThicknessPx * 0.55, openingWidth * 0.16)));
  const stubLen = Math.max(10, openingWidth * 0.26);
  const segmentHeight = Math.max(7, Math.min(16, wallThicknessPx * 0.8));
  const wallFill = isError ? 'rgba(220,38,38,0.45)' : WALL_SEGMENT_FILL;
  const wallStroke = isError ? '#dc2626' : WALL_SEGMENT_STROKE;
  const hatchStroke = isError ? '#dc2626' : '#7c7c80';
  const leftCenter = -halfW - stubLen / 2;
  const rightCenter = halfW + stubLen / 2;
  const hatchInset = 1.2;
  const leftRectLeft = leftCenter - stubLen / 2;
  const rightRectLeft = rightCenter - stubLen / 2;
  const rectTop = -segmentHeight / 2;
  return [
    new fabric.Rect({
      left: leftCenter,
      top: 0,
      width: stubLen,
      height: segmentHeight,
      fill: wallFill,
      stroke: wallStroke,
      strokeWidth: 1.3,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    }),
    new fabric.Rect({
      left: rightCenter,
      top: 0,
      width: stubLen,
      height: segmentHeight,
      fill: wallFill,
      stroke: wallStroke,
      strokeWidth: 1.3,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    }),
    makeLine(
      [
        leftRectLeft + hatchInset,
        rectTop + hatchInset,
        leftRectLeft + stubLen * 0.45,
        rectTop + segmentHeight - hatchInset,
      ],
      hatchStroke,
      1.1
    ),
    makeLine(
      [
        leftRectLeft + stubLen * 0.42,
        rectTop + hatchInset,
        leftRectLeft + stubLen - hatchInset,
        rectTop + segmentHeight - hatchInset,
      ],
      hatchStroke,
      1.1
    ),
    makeLine(
      [
        rightRectLeft + hatchInset,
        rectTop + hatchInset,
        rightRectLeft + stubLen * 0.45,
        rectTop + segmentHeight - hatchInset,
      ],
      hatchStroke,
      1.1
    ),
    makeLine(
      [
        rightRectLeft + stubLen * 0.42,
        rectTop + hatchInset,
        rightRectLeft + stubLen - hatchInset,
        rectTop + segmentHeight - hatchInset,
      ],
      hatchStroke,
      1.1
    ),
    makeLine([-halfW, -jambHalf, -halfW, jambHalf], wallStroke, 2.8),
    makeLine([halfW, -jambHalf, halfW, jambHalf], wallStroke, 2.8),
  ];
}

function quarterArc(
  pivotX: number,
  pivotY: number,
  radius: number,
  hinge: 'left' | 'right'
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const samples = 24;
  for (let i = 0; i <= samples; i += 1) {
    const theta = (i / samples) * (Math.PI / 2);
    const x = hinge === 'left'
      ? pivotX + Math.cos(theta) * radius
      : pivotX - Math.cos(theta) * radius;
    const y = pivotY + Math.sin(theta) * radius;
    points.push({ x, y });
  }
  return points;
}

function doorGraphics(
  definition: ArchitecturalObjectDefinition,
  swingDirectionRaw: unknown,
  doorOpenSideRaw: unknown,
  widthPx: number,
  depthPx: number,
  stroke: string
): fabric.FabricObject[] {
  const openingWidth = Math.max(24, widthPx);
  const halfW = openingWidth / 2;
  const isError = stroke === '#dc2626';
  const leafStroke = isError ? stroke : DOOR_LEAF_ACCENT;
  const arcStroke = isError ? stroke : DOOR_ARC_ACCENT;
  const jambHalf = Math.max(5, Math.min(14, Math.max(depthPx * 0.55, openingWidth * 0.16)));
  const leafY = -jambHalf;
  const objects: fabric.FabricObject[] = [...openingWallStubs(openingWidth, depthPx, stroke, isError)];
  const swingDirection = swingDirectionRaw === 'right' ? 'right' : 'left';
  const openSideSign = doorOpenSideRaw === 'negative' ? -1 : 1;

  if (definition.type === 'sliding') {
    const trackOffset = Math.max(2, jambHalf * 0.45);
    const railInset = Math.max(2, openingWidth * 0.06);
    objects.push(makeLine([-halfW + railInset, -trackOffset, halfW - railInset, -trackOffset], leafStroke, 2.6));
    objects.push(makeLine([-halfW + railInset, trackOffset, halfW - railInset, trackOffset], leafStroke, 2.6));
    return objects;
  }

  if (definition.type === 'bi-fold') {
    const foldDepth = Math.max(6, openingWidth * 0.22);
    objects.push(new fabric.Polyline(
      [
        { x: -halfW, y: leafY },
        { x: -halfW / 2, y: leafY + foldDepth },
        { x: 0, y: leafY },
        { x: halfW / 2, y: leafY + foldDepth },
        { x: halfW, y: leafY },
      ],
      {
        fill: 'transparent',
        stroke: leafStroke,
        strokeWidth: 2.4,
        selectable: false,
        evented: false,
      }
    ));
    return objects;
  }

  if (definition.type === 'overhead') {
    const segmentCount = 4;
    for (let i = 0; i < segmentCount; i += 1) {
      const t0 = i / segmentCount;
      const t1 = (i + 1) / segmentCount;
      const x0 = -halfW + openingWidth * t0;
      const x1 = -halfW + openingWidth * t1;
      objects.push(makeLine([x0, leafY, x1, leafY], leafStroke, 2.2));
    }
    return objects;
  }

  if (definition.type === 'double-swing') {
    const halfLeaf = openingWidth / 2;
    const leftPivotX = -halfW;
    const rightPivotX = halfW;
    objects.push(makeLine([leftPivotX, leafY, leftPivotX, leafY + openSideSign * halfLeaf], arcStroke, DOOR_ARC_STROKE_WIDTH, undefined, true));
    objects.push(makeLine([rightPivotX, leafY, rightPivotX, leafY + openSideSign * halfLeaf], arcStroke, DOOR_ARC_STROKE_WIDTH, undefined, true));
    const leftArc = quarterArc(leftPivotX, leafY, halfLeaf, 'left').map((point) => ({
      x: point.x,
      y: leafY + openSideSign * (point.y - leafY),
    }));
    const rightArc = quarterArc(rightPivotX, leafY, halfLeaf, 'right').map((point) => ({
      x: point.x,
      y: leafY + openSideSign * (point.y - leafY),
    }));
    objects.push(new fabric.Polyline(leftArc, {
      fill: 'transparent',
      stroke: arcStroke,
      strokeWidth: DOOR_ARC_STROKE_WIDTH,
      strokeUniform: true,
      opacity: 1,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      selectable: false,
      evented: false,
    }));
    objects.push(new fabric.Polyline(rightArc, {
      fill: 'transparent',
      stroke: arcStroke,
      strokeWidth: DOOR_ARC_STROKE_WIDTH,
      strokeUniform: true,
      opacity: 1,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      selectable: false,
      evented: false,
    }));
    return objects;
  }

  const pivotX = swingDirection === 'left' ? -halfW : halfW;
  objects.push(makeLine([pivotX, leafY, pivotX, leafY + openSideSign * openingWidth], arcStroke, DOOR_ARC_STROKE_WIDTH, undefined, true));
  const arcPoints = quarterArc(pivotX, leafY, openingWidth, swingDirection).map((point) => ({
    x: point.x,
    y: leafY + openSideSign * (point.y - leafY),
  }));
  objects.push(new fabric.Polyline(
    arcPoints,
    {
      fill: 'transparent',
      stroke: arcStroke,
      strokeWidth: DOOR_ARC_STROKE_WIDTH,
      strokeUniform: true,
      opacity: 1,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      selectable: false,
      evented: false,
    }
  ));

  return objects;
}

function windowGraphics(
  definition: ArchitecturalObjectDefinition,
  widthPx: number,
  depthPx: number,
  stroke: string
): fabric.FabricObject[] {
  const openingWidth = Math.max(24, widthPx);
  const isError = stroke === '#dc2626';
  const frameStroke = isError ? stroke : '#111827';
  const accentStroke = isError ? stroke : '#4b5563';
  const halfW = openingWidth / 2;
  const frameOffset = Math.max(4, Math.min(8, openingWidth * 0.12));
  const objects: fabric.FabricObject[] = [...openingWallStubs(openingWidth, depthPx, stroke, isError)];

  objects.push(makeLine([-halfW, -frameOffset, halfW, -frameOffset], frameStroke, 2.4));
  objects.push(makeLine([-halfW, frameOffset, halfW, frameOffset], frameStroke, 2.4));

  if (definition.type === 'sliding') {
    objects.push(makeLine([-halfW * 0.15, -frameOffset, -halfW * 0.15, frameOffset], frameStroke, 1.6));
    objects.push(makeLine([halfW * 0.15, -frameOffset, halfW * 0.15, frameOffset], frameStroke, 1.6));
    return objects;
  }

  if (definition.type === 'fixed') {
    objects.push(makeLine([-halfW, -frameOffset, halfW, frameOffset], accentStroke, 1.4, [3, 2]));
    objects.push(makeLine([halfW, -frameOffset, -halfW, frameOffset], accentStroke, 1.4, [3, 2]));
    return objects;
  }

  if (definition.type === 'awning') {
    const awningArc = new fabric.Polyline(
      [
        { x: -halfW * 0.7, y: frameOffset },
        { x: -halfW * 0.35, y: frameOffset + 4 },
        { x: 0, y: frameOffset + 6 },
        { x: halfW * 0.35, y: frameOffset + 4 },
        { x: halfW * 0.7, y: frameOffset },
      ],
      {
        fill: 'transparent',
        stroke: accentStroke,
        strokeWidth: 1.6,
        selectable: false,
        evented: false,
      }
    );
    objects.push(awningArc);
    return objects;
  }

  objects.push(makeLine([0, -frameOffset, 0, frameOffset], frameStroke, 1.5));
  objects.push(makeLine([-halfW * 0.3, -frameOffset, 0, frameOffset], accentStroke, 1.2, [3, 2]));
  objects.push(makeLine([halfW * 0.3, -frameOffset, 0, frameOffset], accentStroke, 1.2, [3, 2]));
  return objects;
}

function genericGraphics(
  definition: ArchitecturalObjectDefinition,
  widthPx: number,
  depthPx: number,
  stroke: string
): fabric.FabricObject[] {
  const rect = new fabric.Rect({
    left: 0,
    top: 0,
    width: Math.max(6, widthPx),
    height: Math.max(6, depthPx),
    fill: 'rgba(226,232,240,0.45)',
    stroke,
    strokeWidth: 1.4,
    originX: 'center',
    originY: 'center',
    selectable: false,
    evented: false,
  });
  const label = new fabric.Text(definition.name, {
    left: 0,
    top: 0,
    fontSize: 10,
    fill: '#334155',
    fontFamily: 'Arial',
    fontWeight: '600',
    originX: 'center',
    originY: 'center',
    selectable: false,
    evented: false,
  });
  return [rect, label];
}

function graphicsForDefinition(
  definition: ArchitecturalObjectDefinition,
  instance: SymbolInstance2D,
  widthPx: number,
  depthPx: number,
  stroke: string
): fabric.FabricObject[] {
  if (definition.category === 'doors') {
    const swingDirection = instance.properties?.swingDirection;
    const doorOpenSide = instance.properties?.doorOpenSide;
    return doorGraphics(definition, swingDirection, doorOpenSide, widthPx, depthPx, stroke);
  }
  if (definition.category === 'windows') {
    return windowGraphics(definition, widthPx, depthPx, stroke);
  }
  if (hasRenderer(definition.renderType)) {
    const renderType = definition.renderType!;
    const canvasEl = document.createElement('canvas');
    const targetW = Math.max(8, Math.ceil(widthPx));
    const targetH = Math.max(8, Math.ceil(depthPx));
    const targetMax = Math.max(targetW, targetH);
    const downscale = targetMax > MAX_BITMAP_SYMBOL_SIDE_PX
      ? MAX_BITMAP_SYMBOL_SIDE_PX / targetMax
      : 1;
    const renderW = Math.max(16, Math.round(targetW * downscale));
    const renderH = Math.max(16, Math.round(targetH * downscale));
    canvasEl.width = renderW * BITMAP_SYMBOL_DPR;
    canvasEl.height = renderH * BITMAP_SYMBOL_DPR;
    const ctx2d = canvasEl.getContext('2d');
    if (ctx2d) {
      ctx2d.scale(BITMAP_SYMBOL_DPR, BITMAP_SYMBOL_DPR);
      renderFurniturePlan(ctx2d, renderType, renderW / 2, renderH / 2, renderW, renderH, instance.properties);
    }
    const img = new fabric.FabricImage(canvasEl, {
      left: 0,
      top: 0,
      width: renderW * BITMAP_SYMBOL_DPR,
      height: renderH * BITMAP_SYMBOL_DPR,
      scaleX: targetW / (renderW * BITMAP_SYMBOL_DPR),
      scaleY: targetH / (renderH * BITMAP_SYMBOL_DPR),
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      objectCaching: false,
    });
    return [img];
  }
  if (definition.symbolPath) {
    const path = new fabric.Path(definition.symbolPath, {
      fill: 'rgba(226,232,240,0.28)',
      stroke,
      strokeWidth: 1.4,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
    });
    const bounds = path.getBoundingRect();
    const scaleX = bounds.width > 0 ? widthPx / bounds.width : 1;
    const scaleY = bounds.height > 0 ? depthPx / bounds.height : 1;
    path.set({
      scaleX,
      scaleY,
      left: 0,
      top: 0,
    });
    return [path];
  }
  return genericGraphics(definition, widthPx, depthPx, stroke);
}

export class ObjectRenderer {
  private canvas: fabric.Canvas;
  private groups = new Map<string, ObjectGroup>();
  private definitions = new Map<string, ArchitecturalObjectDefinition>();
  private selectedObjectIds = new Set<string>();
  private hoveredObjectId: string | null = null;
  private previewGroup: ObjectGroup | null = null;
  private previewLooseObjects: fabric.FabricObject[] = [];
  private instancesCache: SymbolInstance2D[] = [];

  constructor(canvas: fabric.Canvas) {
    this.canvas = canvas;
  }

  private cloneInstance(instance: SymbolInstance2D): SymbolInstance2D {
    return {
      ...instance,
      position: { ...instance.position },
      properties: { ...instance.properties },
    };
  }

  private cloneInstances(instances: SymbolInstance2D[]): SymbolInstance2D[] {
    return instances.map((instance) => this.cloneInstance(instance));
  }

  private valuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (typeof left !== typeof right) return false;

    if (left === null || right === null) return left === right;

    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (!this.valuesEqual(left[index], right[index])) return false;
      }
      return true;
    }

    if (typeof left === 'object' && typeof right === 'object') {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      const leftKeys = Object.keys(leftRecord);
      const rightKeys = Object.keys(rightRecord);
      if (leftKeys.length !== rightKeys.length) return false;
      for (const key of leftKeys) {
        if (!(key in rightRecord)) return false;
        if (!this.valuesEqual(leftRecord[key], rightRecord[key])) return false;
      }
      return true;
    }

    return false;
  }

  private instanceVisualChanged(previous: SymbolInstance2D, next: SymbolInstance2D): boolean {
    return (
      previous.symbolId !== next.symbolId ||
      previous.scale !== next.scale ||
      previous.flipped !== next.flipped ||
      !this.valuesEqual(previous.properties ?? {}, next.properties ?? {})
    );
  }

  private instanceTransformChanged(previous: SymbolInstance2D, next: SymbolInstance2D): boolean {
    return (
      Math.abs(previous.position.x - next.position.x) > 0.0001 ||
      Math.abs(previous.position.y - next.position.y) > 0.0001 ||
      Math.abs(previous.rotation - next.rotation) > 0.0001
    );
  }

  setDefinitions(definitions: ArchitecturalObjectDefinition[]): void {
    this.definitions = new Map(definitions.map((definition) => [definition.id, definition]));
    if (this.instancesCache.length > 0) {
      this.renderAll(this.instancesCache);
    }
  }

  private annotate(object: fabric.FabricObject, objectId: string, name?: string): void {
    const typed = object as NamedObject;
    typed.id = objectId;
    typed.objectId = objectId;
    if (name) {
      typed.name = name;
    }
  }

  private clearAllObjects(): void {
    this.groups.forEach((group) => this.canvas.remove(group));
    this.groups.clear();
  }

  private buildGroup(
    instance: SymbolInstance2D,
    definition: ArchitecturalObjectDefinition,
    options?: { preview?: boolean; valid?: boolean }
  ): ObjectGroup {
    const scale = Number.isFinite(instance.scale) && instance.scale > 0 ? instance.scale : 1;
    const widthMmFromInstance = typeof instance.properties?.widthMm === 'number' && Number.isFinite(instance.properties.widthMm)
      ? instance.properties.widthMm
      : null;
    const depthMmFromInstance = typeof instance.properties?.depthMm === 'number' && Number.isFinite(instance.properties.depthMm)
      ? instance.properties.depthMm
      : null;
    const widthPx = toPx(Math.max(1, widthMmFromInstance ?? definition.widthMm), scale);
    const depthPx = toPx(Math.max(1, depthMmFromInstance ?? definition.depthMm), scale);
    const isPreview = !!options?.preview;
    const previewValid = options?.valid !== false;
    const instanceCategory = typeof instance.properties?.category === 'string'
      ? instance.properties.category
      : null;
    const hasOpeningHost = typeof instance.properties?.hostWallId === 'string' && instance.properties.hostWallId.length > 0;
    const isOpening = definition.category === 'doors' ||
      definition.category === 'windows' ||
      instanceCategory === 'doors' ||
      instanceCategory === 'windows' ||
      hasOpeningHost;
    const allowRotationControl = !isPreview && !isOpening && (
      definition.category === 'furniture' ||
      definition.category === 'fixtures' ||
      definition.category === 'symbols' ||
      definition.category === 'my-library'
    );
    const stroke = isPreview
      ? isOpening
        ? '#111827'
        : previewValid ? '#1d4ed8' : '#dc2626'
      : '#111827';

    const renderOpeningBody = isPreview || !isOpening;
    const body = renderOpeningBody
      ? graphicsForDefinition(definition, instance, widthPx, depthPx, stroke)
      : [];
    const invisibleHitArea: fabric.FabricObject[] = [];
    if (!isPreview && isOpening) {
      const hitRect = new fabric.Rect({
        left: 0,
        top: 0,
        width: Math.max(12, widthPx + 10),
        height: Math.max(12, depthPx + 12),
        fill: 'rgba(0,0,0,0.001)',
        stroke: 'transparent',
        strokeWidth: 0,
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      this.annotate(hitRect, instance.id, 'object-hit-area');
      invisibleHitArea.push(hitRect);
    }

    // Preview: add a subtle halo so the symbol clearly follows the cursor.
    const previewExtras: fabric.FabricObject[] = [];
    if (isPreview && !isOpening) {
      const previewBorder = new fabric.Rect({
        left: 0,
        top: 0,
        width: Math.max(20, widthPx + 8),
        height: Math.max(20, depthPx + 8),
        fill: previewValid ? 'rgba(37,99,235,0.08)' : 'rgba(220,38,38,0.08)',
        stroke: previewValid ? '#2563eb' : '#dc2626',
        strokeWidth: 1.5,
        rx: 3,
        ry: 3,
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      previewExtras.push(previewBorder);
    }

    const selectionOutline = new fabric.Rect({
      left: 0,
      top: 0,
      width: Math.max(6, widthPx + 12),
      height: Math.max(6, depthPx + 12),
      fill: 'transparent',
      stroke: '#2563EB',
      strokeWidth: 2.5,
      originX: 'center',
      originY: 'center',
      visible: !isPreview && !isOpening && this.selectedObjectIds.has(instance.id),
      selectable: false,
      evented: false,
    });
    this.annotate(selectionOutline, instance.id, 'object-selection');

    const hoverOutline = new fabric.Rect({
      left: 0,
      top: 0,
      width: Math.max(6, widthPx + 10),
      height: Math.max(6, depthPx + 10),
      fill: 'transparent',
      stroke: '#22c55e',
      strokeWidth: 1.8,
      originX: 'center',
      originY: 'center',
      visible: !isPreview && !isOpening && this.hoveredObjectId === instance.id && !this.selectedObjectIds.has(instance.id),
      selectable: false,
      evented: false,
    });
    this.annotate(hoverOutline, instance.id, 'object-hover');

    body.forEach((item, index) => this.annotate(item, instance.id, `object-body-${index}`));
    const previewOpacity = isPreview
      ? (isOpening ? 1 : (previewValid ? 0.75 : 0.35))
      : 1;
    const usesBitmapRenderer = hasRenderer(definition.renderType);
    const group = new fabric.Group([...previewExtras, ...body, ...invisibleHitArea, hoverOutline, selectionOutline], {
      left: instance.position.x * MM_TO_PX,
      top: instance.position.y * MM_TO_PX,
      angle: instance.rotation,
      opacity: previewOpacity,
      originX: 'center',
      originY: 'center',
      hasControls: !isPreview && !isOpening,
      hasBorders: !isPreview && !isOpening,
      lockScalingX: true,
      lockScalingY: true,
      transparentCorners: false,
      objectCaching: !usesBitmapRenderer,
      selectable: !isPreview,
      evented: !isPreview,
      subTargetCheck: false,
    }) as ObjectGroup;
    group.id = instance.id;
    group.objectId = instance.id;
    group.name = `object-${instance.id}`;
    group.isOpeningSymbol = isOpening;
    group.objectCategory = definition.category;
    group.allowRotationControl = allowRotationControl;
    return group;
  }

  renderAll(instances: SymbolInstance2D[]): void {
    this.instancesCache = this.cloneInstances(instances);
    this.clearAllObjects();
    instances.forEach((instance) => {
      const definition = this.definitions.get(instance.symbolId) ?? definitionFallback(instance.symbolId);
      const group = this.buildGroup(instance, definition);
      this.canvas.add(group);
      this.groups.set(instance.id, group);
    });
    this.canvas.requestRenderAll();
  }

  renderIncremental(instances: SymbolInstance2D[]): void {
    const perfStart = startDragPerfTimer();
    const previousRenderOnAdd = (this.canvas as unknown as { renderOnAddRemove?: boolean }).renderOnAddRemove;
    (this.canvas as unknown as { renderOnAddRemove?: boolean }).renderOnAddRemove = false;
    let addedCount = 0;
    let removedCount = 0;
    let rebuiltCount = 0;
    let movedCount = 0;
    let orderChangedCount = 0;

    try {
      const previousById = new Map(this.instancesCache.map((instance) => [instance.id, instance]));
      const nextById = new Map(instances.map((instance) => [instance.id, instance]));
      let needsRender = false;

      for (const [objectId, group] of this.groups.entries()) {
        if (nextById.has(objectId)) continue;
        this.canvas.remove(group);
        this.groups.delete(objectId);
        removedCount += 1;
        needsRender = true;
      }

      for (const instance of instances) {
        const previous = previousById.get(instance.id);
        const existingGroup = this.groups.get(instance.id);
        const definition = this.definitions.get(instance.symbolId) ?? definitionFallback(instance.symbolId);

        if (!previous || !existingGroup) {
          if (existingGroup) {
            this.canvas.remove(existingGroup);
            rebuiltCount += 1;
          } else {
            addedCount += 1;
          }
          const group = this.buildGroup(instance, definition);
          this.canvas.add(group);
          this.groups.set(instance.id, group);
          needsRender = true;
          continue;
        }

        if (this.instanceVisualChanged(previous, instance)) {
          this.canvas.remove(existingGroup);
          const group = this.buildGroup(instance, definition);
          this.canvas.add(group);
          this.groups.set(instance.id, group);
          rebuiltCount += 1;
          needsRender = true;
          continue;
        }

        if (this.instanceTransformChanged(previous, instance)) {
          existingGroup.set({
            left: instance.position.x * MM_TO_PX,
            top: instance.position.y * MM_TO_PX,
            angle: instance.rotation,
          });
          existingGroup.set('dirty', true);
          movedCount += 1;
          needsRender = true;
        }
      }

      const previousOrder = this.instancesCache.map((instance) => instance.id);
      const nextOrder = instances.map((instance) => instance.id);
      let orderChanged = previousOrder.length !== nextOrder.length;
      if (!orderChanged) {
        for (let index = 0; index < previousOrder.length; index += 1) {
          if (previousOrder[index] !== nextOrder[index]) {
            orderChanged = true;
            break;
          }
        }
      }

      if (orderChanged) {
        orderChangedCount = 1;
        for (const instance of instances) {
          const group = this.groups.get(instance.id);
          if (group) {
            this.canvas.bringObjectToFront(group);
          }
        }
        needsRender = true;
      }

      this.instancesCache = this.cloneInstances(instances);
      if (needsRender) {
        this.canvas.requestRenderAll();
      }
    } finally {
      endDragPerfTimer('object.renderIncremental', perfStart, {
        symbols: instances.length,
        added: addedCount,
        removed: removedCount,
        rebuilt: rebuiltCount,
        moved: movedCount,
        reorder: orderChangedCount,
      });
      (this.canvas as unknown as { renderOnAddRemove?: boolean }).renderOnAddRemove = previousRenderOnAdd ?? true;
    }
  }

  setSelectedObjects(ids: string[]): void {
    this.selectedObjectIds = new Set(ids);
    this.groups.forEach((group, objectId) => {
      const isOpeningSymbol = group.isOpeningSymbol === true;
      const selection = group.getObjects().find((item) => (item as NamedObject).name === 'object-selection');
      const hover = group.getObjects().find((item) => (item as NamedObject).name === 'object-hover');
      if (selection) selection.set('visible', !isOpeningSymbol && this.selectedObjectIds.has(objectId));
      if (hover) hover.set('visible', !isOpeningSymbol && this.hoveredObjectId === objectId && !this.selectedObjectIds.has(objectId));
      // Invalidate group cache so visibility change is rendered
      group.set('dirty', true);
    });
    this.canvas.requestRenderAll();
  }

  setHoveredObject(id: string | null): void {
    this.hoveredObjectId = id;
    this.groups.forEach((group, objectId) => {
      if (group.isOpeningSymbol) return;
      const hover = group.getObjects().find((item) => (item as NamedObject).name === 'object-hover');
      if (!hover) return;
      hover.set('visible', this.hoveredObjectId === objectId && !this.selectedObjectIds.has(objectId));
      // Invalidate group cache so visibility change is rendered
      group.set('dirty', true);
    });
    this.canvas.requestRenderAll();
  }

  activateObject(objectId: string): boolean {
    const group = this.groups.get(objectId);
    if (!group || group.isOpeningSymbol) {
      return false;
    }

    this.canvas.setActiveObject(group);
    this.canvas.requestRenderAll();
    return true;
  }

  renderPlacementPreview(
    definition: ArchitecturalObjectDefinition,
    position: { x: number; y: number },
    rotationDeg: number,
    valid: boolean,
    snappedWall?: { wall: Wall; positionAlongWall: number } | null,
    previewProperties?: Record<string, unknown>,
  ): void {
    this.clearPlacementPreview();

    // If placing a door/window snapped to a wall, render professional architectural symbol
    // Objects use absolute canvas coords so we add them directly (not inside a Group)
    if (snappedWall && (definition.category === 'doors' || definition.category === 'windows')) {
      const openingWidth = (definition.openingWidthMm ?? definition.widthMm) + 50;
      const previewOpening: Opening = {
        id: '__preview-opening__',
        type: definition.category === 'doors' ? 'door' : 'window',
        position: snappedWall.positionAlongWall,
        width: openingWidth,
        height: definition.heightMm,
        sillHeight: definition.category === 'windows'
          ? definition.sillHeightMm ?? 900
          : 0,
      };
      const previewObjects = renderOpeningPreview(
        snappedWall.wall,
        previewOpening,
        { type: definition.type, swingDirection: 'left', ...previewProperties },
      );

      if (previewObjects.length > 0) {
        const opacity = 1;
        for (const obj of previewObjects) {
          const typed = obj as unknown as { isDoorArc?: boolean };
          if (
            obj instanceof fabric.Line ||
            obj instanceof fabric.Polyline ||
            obj instanceof fabric.Path
          ) {
            obj.set({ strokeUniform: true });
          }
          if (typed.isDoorArc) {
            obj.set({
              stroke: DOOR_ARC_ACCENT,
              strokeWidth: DOOR_ARC_STROKE_WIDTH,
              strokeUniform: true,
            });
          }
          obj.set({ opacity, selectable: false, evented: false });
          this.canvas.add(obj);
          this.previewLooseObjects.push(obj);
        }
        this.canvas.requestRenderAll();
        return;
      }
    }

    // Generic symbol preview (floating with cursor) — used for all categories
    // and as fallback when door/window is NOT near a wall
    const previewInstance: SymbolInstance2D = {
      id: '__object-preview__',
      symbolId: definition.id,
      position,
      rotation: rotationDeg,
      scale: 1,
      flipped: false,
      properties: {},
    };
    this.previewGroup = this.buildGroup(previewInstance, definition, { preview: true, valid });
    this.canvas.add(this.previewGroup);
    this.canvas.requestRenderAll();
  }

  clearPlacementPreview(): void {
    let needsRender = false;
    if (this.previewGroup) {
      this.canvas.remove(this.previewGroup);
      this.previewGroup = null;
      needsRender = true;
    }
    if (this.previewLooseObjects.length > 0) {
      for (const obj of this.previewLooseObjects) {
        this.canvas.remove(obj);
      }
      this.previewLooseObjects = [];
      needsRender = true;
    }
    if (needsRender) {
      this.canvas.requestRenderAll();
    }
  }

  dispose(): void {
    this.clearPlacementPreview();
    this.clearAllObjects();
    this.definitions.clear();
    this.selectedObjectIds.clear();
    this.hoveredObjectId = null;
    this.instancesCache = [];
  }
}
