/**
 * HvacPlanRenderer
 *
 * Renders AC/HVAC equipment on the Fabric.js plan canvas.
 */

import * as fabric from 'fabric';

import type { AcEquipmentDefinition } from '../../../data';
import type { HvacElement, Point2D } from '../../../types';
import { buildCeilingCassetteModel } from './ceilingCassetteModel';
import {
  buildRefrigerantPipeVisual,
  buildRefrigerantPipePairVisual,
  findNearestRefrigerantPipeBundleTarget as findNearestRefrigerantPipeBundleTargetFromModel,
  isRefrigerantPipeElementType,
  isRefrigerantPipePairType,
  type RefrigerantPipeBundleConnection,
} from './refrigerantPipePairModel';
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
  hvacElementId?: string;
};

type HvacGroup = fabric.Group & {
  id?: string;
  name?: string;
  hvacElementId?: string;
};

interface SyncHvacElementsOptions {
  force?: boolean;
}

interface VisualPalette {
  stroke: string;
  fill: string;
  detail: string;
  halo: string;
  hover: string;
}

function toCanvas(point: Point2D): Point2D {
  return { x: point.x * MM_TO_PX, y: point.y * MM_TO_PX };
}

function elementCenter(element: Pick<HvacElement, 'position' | 'width' | 'depth'>): Point2D {
  return {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
  };
}

function rotatePoint(point: Point2D, angleDeg: number): Point2D {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function normalizeDirection(point: Point2D): Point2D {
  const length = Math.hypot(point.x, point.y);
  if (length < 0.0001) {
    return { x: 1, y: 0 };
  }
  return { x: point.x / length, y: point.y / length };
}

function clampFontSize(widthPx: number): number {
  return Math.max(8, Math.min(11, widthPx * 0.08));
}

export class HvacPlanRenderer {
  private canvas: fabric.Canvas;
  private groups = new Map<string, HvacGroup>();
  private hvacData = new Map<string, HvacElement>();
  private selectedIds = new Set<string>();
  private hoveredId: string | null = null;
  private placementPreview: HvacGroup[] = [];
  private lastVisibilityBounds: ViewportBounds | null = null;
  private lastVisibilityZoom: number | null = null;

  constructor(canvas: fabric.Canvas) {
    this.canvas = canvas;
  }

  private annotate(target: fabric.FabricObject, hvacElementId: string, name?: string): void {
    const typed = target as NamedObject;
    typed.hvacElementId = hvacElementId;
    typed.id = hvacElementId;
    if (name) {
      typed.name = name;
    }
  }

  private getPalette(element: Pick<HvacElement, 'type' | 'category'>, valid: boolean): VisualPalette {
    if (!valid) {
      return {
        stroke: '#B91C1C',
        fill: 'rgba(185,28,28,0.08)',
        detail: 'rgba(185,28,28,0.75)',
        halo: '#DC2626',
        hover: '#F97316',
      };
    }

    switch (element.type) {
      case 'outdoor-unit':
        return {
          stroke: '#0F766E',
          fill: 'rgba(15,118,110,0.10)',
          detail: 'rgba(15,118,110,0.85)',
          halo: '#0F766E',
          hover: '#14B8A6',
        };
      case 'remote-controller':
      case 'control-panel':
        return {
          stroke: '#B45309',
          fill: 'rgba(180,83,9,0.10)',
          detail: 'rgba(146,64,14,0.85)',
          halo: '#D97706',
          hover: '#F59E0B',
        };
      case 'filter':
      case 'accessory':
      case 'refrigerant-pipe':
      case 'refrigerant-pipe-pair':
        return {
          stroke: '#475569',
          fill: 'rgba(71,85,105,0.08)',
          detail: 'rgba(71,85,105,0.78)',
          halo: '#475569',
          hover: '#0EA5E9',
        };
      default:
        return {
          stroke: '#1D4ED8',
          fill: 'rgba(37,99,235,0.08)',
          detail: 'rgba(37,99,235,0.80)',
          halo: '#1D4ED8',
          hover: '#059669',
        };
    }
  }

  private removeElement(id: string): void {
    const group = this.groups.get(id);
    if (group) {
      this.canvas.remove(group);
      this.groups.delete(id);
    }
    this.hvacData.delete(id);
    this.selectedIds.delete(id);
    if (this.hoveredId === id) {
      this.hoveredId = null;
    }
  }

  private hvacElementNeedsRerender(previousElement: HvacElement | undefined, nextElement: HvacElement): boolean {
    return previousElement !== nextElement;
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

  private syncHvacVisualState(): void {
    this.groups.forEach((group, id) => {
      const selectionHalos = group
        .getObjects()
        .filter((obj) => (obj as NamedObject).name === 'hvac-selection');
      const hoverHalos = group
        .getObjects()
        .filter((obj) => (obj as NamedObject).name === 'hvac-hover');
      selectionHalos.forEach((selectionHalo) => {
        selectionHalo.set('visible', this.selectedIds.has(id));
      });
      hoverHalos.forEach((hoverHalo) => {
        hoverHalo.set('visible', this.hoveredId === id && !this.selectedIds.has(id));
      });
      group.set('dirty', true);
    });
    this.bringPipeElementsToFront();
  }

  private bringPipeElementsToFront(): void {
    this.groups.forEach((group, id) => {
      const element = this.hvacData.get(id);
      if (element && isRefrigerantPipeElementType(element.type)) {
        this.canvas.bringObjectToFront(group);
      }
    });
    this.placementPreview.forEach((group) => this.canvas.bringObjectToFront(group));
  }

  private getRenderedCassettePortEndpointMm(
    group: HvacGroup,
    objectName: string,
  ): Point2D | null {
    const portObject = group
      .getObjects()
      .find((obj) => (obj as NamedObject).name === objectName) as fabric.Rect | undefined;
    if (!portObject || typeof portObject.left !== 'number' || typeof portObject.top !== 'number') {
      return null;
    }
    const widthPx = typeof portObject.width === 'number' ? portObject.width : 0;
    const localPointPx = {
      x: portObject.left + widthPx / 2,
      y: portObject.top,
    };
    const rotatedLocalPointPx = rotatePoint(localPointPx, group.angle ?? 0);
    return {
      x: ((group.left ?? 0) + rotatedLocalPointPx.x) / MM_TO_PX,
      y: ((group.top ?? 0) + rotatedLocalPointPx.y) / MM_TO_PX,
    };
  }

  public findNearestRenderedRefrigerantPipeBundleTarget(
    point: Point2D,
    thresholdMm: number,
  ): RefrigerantPipeBundleConnection | null {
    let bestTarget: RefrigerantPipeBundleConnection | null = null;
    let bestDistance = thresholdMm;

    this.groups.forEach((group, id) => {
      const element = this.hvacData.get(id);
      if (!element || element.type !== 'ceiling-cassette-ac') {
        return;
      }

      const gasPoint = this.getRenderedCassettePortEndpointMm(group, 'hvac-port-gas-pipe');
      const liquidPoint = this.getRenderedCassettePortEndpointMm(group, 'hvac-port-liquid-pipe');
      if (!gasPoint || !liquidPoint) {
        return;
      }

      const cassette = buildCeilingCassetteModel(element);
      const gasPort = cassette.pipePorts.find((port) => port.kind === 'gas');
      const liquidPort = cassette.pipePorts.find((port) => port.kind === 'liquid');
      if (!gasPort || !liquidPort) {
        return;
      }

      const direction = normalizeDirection(rotatePoint({ x: 1, y: 0 }, element.rotation ?? 0));
      const gasElevationMm = element.elevation + gasPort.z;
      const liquidElevationMm = element.elevation + liquidPort.z;
      const gasDistance = Math.hypot(gasPoint.x - point.x, gasPoint.y - point.y);
      const liquidDistance = Math.hypot(liquidPoint.x - point.x, liquidPoint.y - point.y);
      const nearestPoint = gasDistance <= liquidDistance ? gasPoint : liquidPoint;
      const nearestDistance = Math.min(gasDistance, liquidDistance);

      if (nearestDistance <= bestDistance) {
        bestDistance = nearestDistance;
        bestTarget = {
          point: nearestPoint,
          gasPoint,
          liquidPoint,
          gasFieldPoint: gasPoint,
          liquidFieldPoint: liquidPoint,
          direction,
          elevationMm: (gasElevationMm + liquidElevationMm) / 2,
          gasElevationMm,
          liquidElevationMm,
          sourceElementId: element.id,
        };
      }
    });

    return bestTarget;
  }

  private createBaseObjects(
    element: Pick<HvacElement, 'id' | 'type' | 'label' | 'position' | 'width' | 'depth' | 'height' | 'category' | 'properties'>,
    options: { valid: boolean; includeInteractionHalos: boolean },
  ): fabric.FabricObject[] {
    const palette = this.getPalette(element, options.valid);
    const isPipeElement = isRefrigerantPipeElementType(element.type);
    const baseWidthPx = Math.max(20, element.width * MM_TO_PX);
    const baseDepthPx = Math.max(12, element.depth * MM_TO_PX);
    const widthPx = baseWidthPx;
    const depthPx = baseDepthPx;
    const halfW = widthPx / 2;
    const halfD = depthPx / 2;
    const objects: fabric.FabricObject[] = [];
    const interactionUnderlays: fabric.FabricObject[] = [];
    const interactionOverlays: fabric.FabricObject[] = [];

    const background = new fabric.Rect({
      left: 0,
      top: 0,
      width: widthPx,
      height: depthPx,
      rx: Math.min(8, depthPx * 0.18),
      ry: Math.min(8, depthPx * 0.18),
      originX: 'center',
      originY: 'center',
      fill: palette.fill,
      stroke: palette.stroke,
      strokeWidth: 1.4,
      selectable: false,
      evented: false,
    });

    if (element.type === 'filter') {
      background.set('strokeDashArray', [6, 4]);
    }

    if (!isPipeElement) {
      this.annotate(background, element.id, 'hvac-body');
      objects.push(background);
    }

    const toPx = (valueMm: number): number => valueMm * MM_TO_PX;
    const renderPipePolyline = (
      points: Point2D[],
      stroke: string,
      strokeWidthMm: number,
      name: string,
    ): void => {
      if (points.length < 2) {
        return;
      }
      const polyline = new fabric.Polyline(
        points.map((point) => ({ x: toPx(point.x), y: toPx(point.y) })),
        {
          fill: undefined,
          stroke,
          strokeWidth: Math.max(toPx(strokeWidthMm), 1),
          strokeLineCap: 'butt',
          strokeLineJoin: 'round',
          selectable: false,
          evented: false,
        },
      );
      this.annotate(polyline, element.id, name);
      objects.push(polyline);
    };

    const renderPipeRectSegment = (
      stub: { start: Point2D; end: Point2D } | null,
      fill: string,
      widthMm: number,
      name: string,
    ): void => {
      if (!stub) {
        return;
      }
      const dx = stub.end.x - stub.start.x;
      const dy = stub.end.y - stub.start.y;
      const lengthMm = Math.hypot(dx, dy);
      if (lengthMm <= 0.2) {
        return;
      }

      const segment = new fabric.Rect({
        left: toPx((stub.start.x + stub.end.x) / 2),
        top: toPx((stub.start.y + stub.end.y) / 2),
        width: Math.max(toPx(lengthMm), 1),
        height: Math.max(toPx(widthMm), 1),
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        originX: 'center',
        originY: 'center',
        fill,
        selectable: false,
        evented: false,
      });
      this.annotate(segment, element.id, name);
      objects.push(segment);
    };

    const buildContinuousCorePoints = (
      stub: { start: Point2D; end: Point2D } | null,
      points: Point2D[],
    ): Point2D[] => {
      if (!stub) {
        return points;
      }
      if (points.length === 0) {
        return [stub.end];
      }
      const firstPoint = points[0]!;
      if (Math.hypot(firstPoint.x - stub.end.x, firstPoint.y - stub.end.y) <= 0.2) {
        return points;
      }
      return [stub.end, ...points];
    };

    const createRectOutlineHalo = (
      config: {
        leftMm: number;
        topMm: number;
        widthMm: number;
        heightMm: number;
        rxPx?: number;
        ryPx?: number;
      },
      color: string,
      strokeWidthPx: number,
      opacity: number,
      name: 'hvac-selection' | 'hvac-hover',
    ): void => {
      const halo = new fabric.Rect({
        left: toPx(config.leftMm),
        top: toPx(config.topMm),
        width: Math.max(toPx(config.widthMm), 1),
        height: Math.max(toPx(config.heightMm), 1),
        rx: config.rxPx,
        ry: config.ryPx,
        originX: 'center',
        originY: 'center',
        fill: 'transparent',
        stroke: color,
        strokeWidth: strokeWidthPx,
        selectable: false,
        evented: false,
        opacity,
        visible: false,
      });
      this.annotate(halo, element.id, name);
      interactionOverlays.push(halo);
    };

    const haloPaddingMm = 6 / MM_TO_PX;
    const createPipeHaloPolyline = (
      points: Point2D[],
      widthMm: number,
      color: string,
      opacity: number,
      name: 'hvac-selection' | 'hvac-hover',
    ): void => {
      if (points.length < 2) {
        return;
      }
      const polyline = new fabric.Polyline(
        points.map((point) => ({ x: toPx(point.x), y: toPx(point.y) })),
        {
          fill: undefined,
          stroke: color,
          strokeWidth: Math.max(toPx(widthMm + haloPaddingMm), 1),
          strokeLineCap: 'butt',
          strokeLineJoin: 'round',
          selectable: false,
          evented: false,
          opacity,
          visible: false,
        },
      );
      this.annotate(polyline, element.id, name);
      interactionUnderlays.push(polyline);
    };

    const createPipeHaloRectSegment = (
      stub: { start: Point2D; end: Point2D } | null,
      widthMm: number,
      color: string,
      opacity: number,
      name: 'hvac-selection' | 'hvac-hover',
    ): void => {
      if (!stub) {
        return;
      }
      const dx = stub.end.x - stub.start.x;
      const dy = stub.end.y - stub.start.y;
      const lengthMm = Math.hypot(dx, dy);
      if (lengthMm <= 0.2) {
        return;
      }

      const segment = new fabric.Rect({
        left: toPx((stub.start.x + stub.end.x) / 2),
        top: toPx((stub.start.y + stub.end.y) / 2),
        width: Math.max(toPx(lengthMm), 1),
        height: Math.max(toPx(widthMm + haloPaddingMm), 1),
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        originX: 'center',
        originY: 'center',
        fill: color,
        selectable: false,
        evented: false,
        opacity,
        visible: false,
      });
      this.annotate(segment, element.id, name);
      interactionUnderlays.push(segment);
    };

    switch (element.type) {
      case 'refrigerant-pipe': {
        const visual = buildRefrigerantPipeVisual(element);
        const insulationEdgeStroke = options.valid ? 'rgba(171,184,196,0.98)' : 'rgba(220,38,38,0.28)';
        const insulationStroke = options.valid ? '#e8eef3' : 'rgba(254,226,226,0.9)';
        const coreStroke = options.valid
          ? visual.lineKind === 'gas' ? '#c5894d' : '#dca25d'
          : visual.lineKind === 'gas' ? '#dc2626' : '#f97316';
        const corePoints = buildContinuousCorePoints(visual.localStub, visual.localOuterPoints);

        if (options.includeInteractionHalos) {
          createPipeHaloRectSegment(visual.localStub, visual.outerDiameterMm, palette.halo, 0.16, 'hvac-selection');
          createPipeHaloPolyline(visual.localOuterPoints, visual.outerDiameterMm, palette.halo, 0.16, 'hvac-selection');
          createPipeHaloRectSegment(visual.localStub, visual.outerDiameterMm, palette.hover, 0.12, 'hvac-hover');
          createPipeHaloPolyline(visual.localOuterPoints, visual.outerDiameterMm, palette.hover, 0.12, 'hvac-hover');
        }

        renderPipePolyline(visual.localOuterPoints, insulationEdgeStroke, visual.outerDiameterMm + 3, 'hvac-detail');
        renderPipePolyline(visual.localOuterPoints, insulationStroke, visual.outerDiameterMm, 'hvac-detail');
        renderPipeRectSegment(visual.localStub, coreStroke, visual.coreRadiusMm * 2, 'hvac-detail');
        renderPipePolyline(corePoints, coreStroke, visual.coreRadiusMm * 2, 'hvac-detail');
        break;
      }
      case 'refrigerant-pipe-pair': {
        const baseVisual = buildRefrigerantPipePairVisual(element);
        const inferredStartBundle = !baseVisual.startBundleConnection && baseVisual.routePoints.length > 0
          ? findNearestRefrigerantPipeBundleTargetFromModel(
              Array.from(this.hvacData.values()).filter((candidate) => candidate.id !== element.id),
              baseVisual.routePoints[0]!,
              180,
            )
          : null;
        const visual = inferredStartBundle
          ? buildRefrigerantPipePairVisual({
              ...element,
              properties: {
                ...element.properties,
                startBundleConnection: inferredStartBundle,
              },
            })
          : baseVisual;
        const toPx = (valueMm: number): number => valueMm * MM_TO_PX;
        const insulationEdgeStroke = options.valid ? 'rgba(171,184,196,0.98)' : 'rgba(220,38,38,0.28)';
        const insulationStroke = options.valid ? '#e8eef3' : 'rgba(254,226,226,0.9)';
        const gasCoreStroke = options.valid ? '#c5894d' : '#dc2626';
        const liquidCoreStroke = options.valid ? '#dca25d' : '#f97316';

        const renderPolyline = (
          points: Point2D[],
          stroke: string,
          strokeWidthMm: number,
          name: string,
        ): void => {
          if (points.length < 2) {
            return;
          }
          const polyline = new fabric.Polyline(
            points.map((point) => ({ x: toPx(point.x), y: toPx(point.y) })),
            {
              fill: undefined,
              stroke,
              strokeWidth: Math.max(toPx(strokeWidthMm), 1),
              strokeLineCap: 'butt',
              strokeLineJoin: 'round',
              selectable: false,
              evented: false,
            },
          );
          this.annotate(polyline, element.id, name);
          objects.push(polyline);
        };

        const renderRectSegment = (
          stub: { start: Point2D; end: Point2D } | null,
          fill: string,
          widthMm: number,
          name: string,
        ): void => {
          if (!stub) {
            return;
          }
          const dx = stub.end.x - stub.start.x;
          const dy = stub.end.y - stub.start.y;
          const lengthMm = Math.hypot(dx, dy);
          if (lengthMm <= 0.2) {
            return;
          }

          const segment = new fabric.Rect({
            left: toPx((stub.start.x + stub.end.x) / 2),
            top: toPx((stub.start.y + stub.end.y) / 2),
            width: Math.max(toPx(lengthMm), 1),
            height: Math.max(toPx(widthMm), 1),
            angle: (Math.atan2(dy, dx) * 180) / Math.PI,
            originX: 'center',
            originY: 'center',
            fill,
            selectable: false,
            evented: false,
          });
          this.annotate(segment, element.id, name);
          objects.push(segment);
        };

        const buildContinuousCorePoints = (
          stub: { start: Point2D; end: Point2D } | null,
          points: Point2D[],
        ): Point2D[] => {
          if (!stub) {
            return points;
          }
          if (points.length === 0) {
            return [stub.end];
          }
          const firstPoint = points[0]!;
          if (Math.hypot(firstPoint.x - stub.end.x, firstPoint.y - stub.end.y) <= 0.2) {
            return points;
          }
          return [stub.end, ...points];
        };

        const gasCorePoints = buildContinuousCorePoints(visual.gasLocalStub, visual.gasLocalOuterPoints);
        const liquidCorePoints = buildContinuousCorePoints(visual.liquidLocalStub, visual.liquidLocalOuterPoints);

        if (options.includeInteractionHalos) {
          createPipeHaloRectSegment(visual.gasLocalStub, visual.gasOuterDiameterMm, palette.halo, 0.16, 'hvac-selection');
          createPipeHaloPolyline(visual.gasLocalOuterPoints, visual.gasOuterDiameterMm, palette.halo, 0.16, 'hvac-selection');
          createPipeHaloRectSegment(visual.liquidLocalStub, visual.liquidOuterDiameterMm, palette.halo, 0.16, 'hvac-selection');
          createPipeHaloPolyline(visual.liquidLocalOuterPoints, visual.liquidOuterDiameterMm, palette.halo, 0.16, 'hvac-selection');
          createPipeHaloRectSegment(visual.gasLocalStub, visual.gasOuterDiameterMm, palette.hover, 0.12, 'hvac-hover');
          createPipeHaloPolyline(visual.gasLocalOuterPoints, visual.gasOuterDiameterMm, palette.hover, 0.12, 'hvac-hover');
          createPipeHaloRectSegment(visual.liquidLocalStub, visual.liquidOuterDiameterMm, palette.hover, 0.12, 'hvac-hover');
          createPipeHaloPolyline(visual.liquidLocalOuterPoints, visual.liquidOuterDiameterMm, palette.hover, 0.12, 'hvac-hover');
        }

        renderPolyline(visual.gasLocalOuterPoints, insulationEdgeStroke, visual.gasOuterDiameterMm + 3, 'hvac-detail');
        renderPolyline(visual.liquidLocalOuterPoints, insulationEdgeStroke, visual.liquidOuterDiameterMm + 3, 'hvac-detail');
        renderPolyline(visual.gasLocalOuterPoints, insulationStroke, visual.gasOuterDiameterMm, 'hvac-detail');
        renderPolyline(visual.liquidLocalOuterPoints, insulationStroke, visual.liquidOuterDiameterMm, 'hvac-detail');

        renderRectSegment(visual.gasLocalStub, gasCoreStroke, visual.gasCoreRadiusMm * 2, 'hvac-detail');
        renderRectSegment(visual.liquidLocalStub, liquidCoreStroke, visual.liquidCoreRadiusMm * 2, 'hvac-detail');
        renderPolyline(gasCorePoints, gasCoreStroke, visual.gasCoreRadiusMm * 2, 'hvac-detail');
        renderPolyline(liquidCorePoints, liquidCoreStroke, visual.liquidCoreRadiusMm * 2, 'hvac-detail');
        break;
      }
      case 'ceiling-cassette-ac': {
        const cassette = buildCeilingCassetteModel(element);
        const toPx = (valueMm: number): number => valueMm * MM_TO_PX;
        const panelSizePx = toPx(cassette.panelSize);
        const minDimension = panelSizePx;
        const panelFill = options.valid ? 'rgba(251,252,253,0.98)' : 'rgba(254,242,242,0.92)';
        const panelOutlineStroke = options.valid ? 'rgba(154,166,177,0.72)' : 'rgba(185,28,28,0.72)';
        const topCapFill = options.valid ? '#aeb7c0' : 'rgba(253,226,226,0.92)';
        const topCapStroke = options.valid ? 'rgba(138,149,160,0.92)' : 'rgba(185,28,28,0.56)';
        const hiddenBodyInsetStroke = options.valid ? 'rgba(124,136,148,0.46)' : 'rgba(185,28,28,0.34)';
        const topCapHighlightStroke = options.valid ? 'rgba(244,247,250,0.72)' : 'rgba(255,255,255,0.38)';

        background.set({
          width: panelSizePx,
          height: panelSizePx,
          fill: panelFill,
          stroke: panelOutlineStroke,
          strokeWidth: 1.3,
          rx: Math.max(8, minDimension * 0.085),
          ry: Math.max(8, minDimension * 0.085),
        });
        background.set('strokeDashArray', null);

        if (options.includeInteractionHalos) {
          const haloPaddingMm = 4 / MM_TO_PX;
          const panelRxPx = Math.max(8, minDimension * 0.085);
          createRectOutlineHalo(
            {
              leftMm: 0,
              topMm: 0,
              widthMm: cassette.panelSize + haloPaddingMm,
              heightMm: cassette.panelSize + haloPaddingMm,
              rxPx: panelRxPx + 2,
              ryPx: panelRxPx + 2,
            },
            palette.halo,
            1.8,
            1,
            'hvac-selection',
          );
          createRectOutlineHalo(
            {
              leftMm: 0,
              topMm: 0,
              widthMm: cassette.panelSize + haloPaddingMm,
              heightMm: cassette.panelSize + haloPaddingMm,
              rxPx: panelRxPx + 1,
              ryPx: panelRxPx + 1,
            },
            palette.hover,
            1.4,
            1,
            'hvac-hover',
          );
        }

        const topCap = new fabric.Rect({
          left: toPx(cassette.topCap.x),
          top: toPx(cassette.topCap.y),
          width: toPx(cassette.topCap.width),
          height: toPx(cassette.topCap.depth),
          rx: Math.max(6, toPx(cassette.topCap.cornerRadius)),
          ry: Math.max(6, toPx(cassette.topCap.cornerRadius)),
          originX: 'center',
          originY: 'center',
          fill: topCapFill,
          stroke: topCapStroke,
          strokeWidth: 1.4,
          selectable: false,
          evented: false,
        });
        this.annotate(topCap, element.id, 'hvac-detail');
        objects.push(topCap);

        const hiddenBodyInset = new fabric.Rect({
          left: toPx(cassette.hiddenBody.x),
          top: toPx(cassette.hiddenBody.y),
          width: toPx(cassette.hiddenBody.width),
          height: toPx(cassette.hiddenBody.depth),
          rx: Math.max(6, toPx(cassette.hiddenBody.cornerRadius)),
          ry: Math.max(6, toPx(cassette.hiddenBody.cornerRadius)),
          originX: 'center',
          originY: 'center',
          fill: 'transparent',
          stroke: hiddenBodyInsetStroke,
          strokeWidth: 0.9,
          selectable: false,
          evented: false,
        });
        this.annotate(hiddenBodyInset, element.id, 'hvac-detail');
        objects.push(hiddenBodyInset);

        const topCapHighlight = new fabric.Rect({
          left: toPx(cassette.topCap.x),
          top: toPx(cassette.topCap.y),
          width: Math.max(toPx(cassette.topCap.width - cassette.topCap.width * 0.018), 1),
          height: Math.max(toPx(cassette.topCap.depth - cassette.topCap.depth * 0.018), 1),
          rx: Math.max(5, toPx(cassette.topCap.cornerRadius * 0.92)),
          ry: Math.max(5, toPx(cassette.topCap.cornerRadius * 0.92)),
          originX: 'center',
          originY: 'center',
          fill: 'transparent',
          stroke: topCapHighlightStroke,
          strokeWidth: 0.8,
          selectable: false,
          evented: false,
        });
        this.annotate(topCapHighlight, element.id, 'hvac-detail');
        objects.push(topCapHighlight);

        const visiblePortStartX = cassette.topCap.x + cassette.topCap.width / 2;
        const renderProjectedPortSegment = (
          startMm: number,
          endMm: number,
          centerYMm: number,
          radiusMm: number,
          fill: string,
          name: string,
        ): void => {
          const visibleStartMm = Math.max(startMm, visiblePortStartX);
          const visibleLengthMm = endMm - visibleStartMm;
          if (visibleLengthMm <= 0.2) {
            return;
          }
          const projectionRect = new fabric.Rect({
            left: toPx((visibleStartMm + endMm) / 2),
            top: toPx(centerYMm),
            width: Math.max(toPx(visibleLengthMm), 1),
            height: Math.max(toPx(radiusMm * 2), 2),
            originX: 'center',
            originY: 'center',
            fill,
            selectable: false,
            evented: false,
          });
          this.annotate(projectionRect, element.id, name);
          objects.push(projectionRect);
        };

        cassette.pipePorts.forEach((port) => {
          const flangeStartMm = port.x;
          const flangeEndMm = port.x + port.flangeThickness;
          const collarStartMm = port.x + port.flangeThickness * 0.35;
          const collarEndMm = collarStartMm + port.collarLength;
          const pipeStartMm = port.x + port.collarLength - port.flangeThickness * 0.15;
          const pipeEndMm = pipeStartMm + port.length;

          renderProjectedPortSegment(
            flangeStartMm,
            flangeEndMm,
            port.y,
            port.collarRadius * 1.12,
            port.flangeColor ?? '#d7dde2',
            `hvac-port-${port.kind}-flange`,
          );
          renderProjectedPortSegment(
            collarStartMm,
            collarEndMm,
            port.y,
            port.collarRadius,
            port.collarColor ?? '#1f2937',
            `hvac-port-${port.kind}-collar`,
          );
          renderProjectedPortSegment(
            pipeStartMm,
            pipeEndMm,
            port.y,
            port.radius,
            port.color,
            `hvac-port-${port.kind}-pipe`,
          );

          const bandX = port.x + port.bandOffsetX;
          if (bandX >= visiblePortStartX) {
            const bandMarker = new fabric.Line(
              [
                toPx(bandX),
                toPx(port.y - port.bandRadius),
                toPx(bandX),
                toPx(port.y + port.bandRadius),
              ],
              {
                stroke: port.bandColor,
                strokeWidth: Math.max(toPx(port.bandRadius * 0.18), 1.2),
                selectable: false,
                evented: false,
              },
            );
            this.annotate(bandMarker, element.id, 'hvac-detail');
            objects.push(bandMarker);
          }
        });
        break;
      }
      case 'wall-mounted-ac':
      case 'remote-controller':
      case 'control-panel': {
        const topLine = new fabric.Line(
          [-halfW * 0.78, -halfD * 0.18, halfW * 0.78, -halfD * 0.18],
          {
            stroke: palette.detail,
            strokeWidth: 1.1,
            selectable: false,
            evented: false,
          },
        );
        const bottomLine = new fabric.Line(
          [-halfW * 0.74, halfD * 0.18, halfW * 0.74, halfD * 0.18],
          {
            stroke: palette.detail,
            strokeWidth: 0.9,
            selectable: false,
            evented: false,
          },
        );
        this.annotate(topLine, element.id, 'hvac-detail');
        this.annotate(bottomLine, element.id, 'hvac-detail');
        objects.push(topLine, bottomLine);
        break;
      }
      case 'ceiling-suspended-ac':
      case 'ducted-ac': {
        const centerLine = new fabric.Line(
          [-halfW * 0.8, 0, halfW * 0.8, 0],
          {
            stroke: palette.detail,
            strokeWidth: 1.1,
            selectable: false,
            evented: false,
          },
        );
        this.annotate(centerLine, element.id, 'hvac-detail');
        objects.push(centerLine);
        for (let index = -1; index <= 1; index += 1) {
          const grille = new fabric.Line(
            [index * halfW * 0.45, -halfD * 0.55, index * halfW * 0.45, halfD * 0.55],
            {
              stroke: palette.detail,
              strokeWidth: 0.8,
              selectable: false,
              evented: false,
            },
          );
          this.annotate(grille, element.id, 'hvac-detail');
          objects.push(grille);
        }
        break;
      }
      case 'outdoor-unit': {
        const fanRing = new fabric.Circle({
          left: 0,
          top: 0,
          radius: Math.min(halfW, halfD) * 0.42,
          originX: 'center',
          originY: 'center',
          stroke: palette.detail,
          strokeWidth: 1.1,
          fill: 'transparent',
          selectable: false,
          evented: false,
        });
        const horizontal = new fabric.Line(
          [-halfW * 0.28, 0, halfW * 0.28, 0],
          {
            stroke: palette.detail,
            strokeWidth: 1,
            selectable: false,
            evented: false,
          },
        );
        const vertical = new fabric.Line(
          [0, -halfD * 0.28, 0, halfD * 0.28],
          {
            stroke: palette.detail,
            strokeWidth: 1,
            selectable: false,
            evented: false,
          },
        );
        this.annotate(fanRing, element.id, 'hvac-detail');
        this.annotate(horizontal, element.id, 'hvac-detail');
        this.annotate(vertical, element.id, 'hvac-detail');
        objects.push(fanRing, horizontal, vertical);
        break;
      }
      case 'filter':
      case 'accessory':
      default: {
        for (let index = -1; index <= 1; index += 1) {
          const grille = new fabric.Line(
            [-halfW * 0.7, index * halfD * 0.35, halfW * 0.7, index * halfD * 0.35],
            {
              stroke: palette.detail,
              strokeWidth: 0.8,
              selectable: false,
              evented: false,
            },
          );
          this.annotate(grille, element.id, 'hvac-detail');
          objects.push(grille);
        }
        break;
      }
    }

    if (interactionUnderlays.length > 0) {
      objects.unshift(...interactionUnderlays);
    }
    if (interactionOverlays.length > 0) {
      objects.push(...interactionOverlays);
    }

    if (!isPipeElement) {
      const label = new fabric.Text(element.label.toUpperCase(), {
        left: 0,
        top: -halfD - 8,
        originX: 'center',
        originY: 'bottom',
        fontSize: clampFontSize(widthPx),
        fontFamily: 'monospace',
        fontWeight: '500',
        fill: palette.stroke,
        selectable: false,
        evented: false,
      });
      this.annotate(label, element.id, 'hvac-label');
      objects.push(label);
    }

    if (options.includeInteractionHalos && !isPipeElement && element.type !== 'ceiling-cassette-ac') {
      const selectionHalo = new fabric.Rect({
        left: 0,
        top: 0,
        width: widthPx + 8,
        height: depthPx + 8,
        originX: 'center',
        originY: 'center',
        fill: 'transparent',
        stroke: palette.halo,
        strokeWidth: 2,
        selectable: false,
        evented: false,
        visible: this.selectedIds.has(element.id),
      });
      const hoverHalo = new fabric.Rect({
        left: 0,
        top: 0,
        width: widthPx + 6,
        height: depthPx + 6,
        originX: 'center',
        originY: 'center',
        fill: 'transparent',
        stroke: palette.hover,
        strokeWidth: 1.5,
        selectable: false,
        evented: false,
        visible: this.hoveredId === element.id && !this.selectedIds.has(element.id),
      });
      this.annotate(selectionHalo, element.id, 'hvac-selection');
      this.annotate(hoverHalo, element.id, 'hvac-hover');
      objects.push(selectionHalo, hoverHalo);
    }

    return objects;
  }

  private buildGroup(
    element: Pick<HvacElement, 'id' | 'type' | 'label' | 'position' | 'rotation' | 'width' | 'depth' | 'height' | 'category' | 'properties'>,
    options: { valid?: boolean; selectable?: boolean; evented?: boolean; includeInteractionHalos?: boolean },
  ): HvacGroup {
    const center = toCanvas(elementCenter(element));
    const isPipeElement = isRefrigerantPipeElementType(element.type);
    const usesPreciseHitTesting = isPipeElement || element.type === 'ceiling-cassette-ac';
    const objects = this.createBaseObjects(element, {
      valid: options.valid ?? true,
      includeInteractionHalos: options.includeInteractionHalos ?? true,
    });

    const group = new fabric.Group(objects, {
      left: center.x,
      top: center.y,
      angle: element.rotation ?? 0,
      originX: 'center',
      originY: 'center',
      selectable: options.selectable ?? true,
      evented: options.evented ?? true,
      subTargetCheck: true,
      perPixelTargetFind: usesPreciseHitTesting,
      hasControls: false,
      hasBorders: false,
      lockRotation: true,
      objectCaching: false,
    }) as HvacGroup;
    group.id = element.id;
    group.hvacElementId = element.id;
    group.name = `hvac-${element.id}`;
    return group;
  }

  renderElement(element: HvacElement): void {
    this.removeElement(element.id);
    this.hvacData.set(element.id, element);

    const group = this.buildGroup(element, {
      valid: true,
      selectable: true,
      evented: true,
      includeInteractionHalos: true,
    });

    this.canvas.add(group);
    this.groups.set(element.id, group);
    this.bringPipeElementsToFront();
  }

  renderPlacementPreview(
    definition: AcEquipmentDefinition,
    position: Point2D,
    rotationDeg: number,
    valid: boolean,
  ): void {
    const previewElement: HvacElement = {
      id: '__hvac-placement-preview__',
      type: definition.type,
      category: definition.equipmentCategory,
      subtype: definition.subtype,
      modelLabel: definition.modelLabel,
      position,
      rotation: rotationDeg,
      width: definition.widthMm,
      depth: definition.depthMm,
      height: definition.heightMm,
      elevation: definition.elevationMm,
      mountType: definition.mountType,
      label: definition.name,
      supplyZoneRatio: definition.supplyZoneRatio ?? 0.5,
      properties: {},
    };

    this.renderElementPreview(previewElement, valid);
  }

  renderElementPreview(element: HvacElement, valid: boolean): void {
    this.renderElementPreviews([element], valid);
  }

  renderElementPreviews(elements: HvacElement[], valid: boolean): void {
    this.clearPlacementPreview();

    this.placementPreview = elements.map((element) => {
      const group = this.buildGroup(element, {
        valid,
        selectable: false,
        evented: false,
        includeInteractionHalos: false,
      });
      group.set({
        opacity: valid ? 0.86 : 0.92,
        excludeFromExport: true,
      });

      this.canvas.add(group);
      this.canvas.bringObjectToFront(group);
      return group;
    });
    this.canvas.requestRenderAll();
  }

  clearPlacementPreview(): void {
    if (this.placementPreview.length === 0) {
      return;
    }
    this.placementPreview.forEach((group) => this.canvas.remove(group));
    this.placementPreview = [];
    this.canvas.requestRenderAll();
  }

  renderAll(elements: HvacElement[]): void {
    this.syncElements(elements, { force: true });
  }

  syncElements(elements: HvacElement[], options: SyncHvacElementsOptions = {}): void {
    const { force = false } = options;
    const nextElementIds = new Set(elements.map((element) => element.id));
    let changed = force;

    this.hvacData.forEach((_, id) => {
      if (!nextElementIds.has(id)) {
        this.removeElement(id);
        changed = true;
      }
    });

    elements.forEach((element) => {
      const previousElement = this.hvacData.get(element.id);
      const hasGroup = this.groups.has(element.id);
      if (!force && hasGroup && !this.hvacElementNeedsRerender(previousElement, element)) {
        return;
      }
      this.renderElement(element);
      changed = true;
    });

    if (!changed) {
      return;
    }

    this.refreshViewportVisibility(true);
    this.syncHvacVisualState();
    this.bringPipeElementsToFront();
    this.canvas.requestRenderAll();
  }

  setSelectedElements(ids: string[]): void {
    this.selectedIds = new Set(ids);
    this.syncHvacVisualState();
    this.canvas.requestRenderAll();
  }

  setHoveredElement(id: string | null): void {
    this.hoveredId = id;
    this.syncHvacVisualState();
    this.canvas.requestRenderAll();
  }

  dispose(): void {
    this.clearPlacementPreview();
    this.groups.forEach((group) => this.canvas.remove(group));
    this.groups.clear();
    this.hvacData.clear();
  }
}
