/**
 * RoomRenderer
 *
 * Fabric.js renderer for detected rooms:
 * - light room fill
 * - centroid label
 * - center marker handle for room move
 */

import * as fabric from 'fabric';

import type { HvacElement, Point2D, Room, Wall } from '../../../types';
import { distancePointToSegment } from '../../../utils/geometry';
import { GeometryEngine } from '../../../utils/geometry-engine';
import { MM_TO_PX } from '../scale';
import {
  getCanvasViewportBounds,
  hasMeaningfulViewportZoomChange,
  isViewportBoundsContained,
  type ViewportBounds,
} from '../viewportVisibility';

import { isRoomIsolatedFromAttachments } from './roomIsolation';

type NamedObject = fabric.Object & {
  id?: string;
  name?: string;
  roomId?: string;
  controlType?: string;
  cornerIndex?: number;
  scaleDirection?: 'NW' | 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W';
  isRoomControl?: boolean;
  isRoomControlDecoration?: boolean;
};

type RoomGroup = fabric.Group & { roomId?: string; id?: string; name?: string };
type RoomLabelGroup = fabric.Group & { roomId?: string; id?: string; name?: string };
type RoomControlGroup = fabric.Group & { roomId?: string; id?: string; name?: string };

interface AreaTag {
  id: string;
  roomId: string;
  area: number;
  centroid: Point2D;
  vertices: Point2D[];
  holes: Point2D[][];
  accentColor: string;
  obstacles: AreaTagObstacle[];
}

interface AreaTagObstacle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const AREA_TAG_FONT_SIZE = 56;
const LABEL_TARGET_SCREEN_SCALE = 1.2;
const LABEL_MIN_SCENE_SCALE = 0.1;
const LABEL_MIN_FIT_RATIO = 0.72;
const LABEL_FIT_STEPS = 12;
const AREA_TAG_PADDING_X = 14;
const AREA_TAG_PADDING_Y = 10;
const AREA_TAG_CANDIDATE_GRID = 7;
const AREA_TAG_HVAC_CLEARANCE_PX = 18;

interface SyncRoomsOptions {
  force?: boolean;
}

function toCanvasPoint(point: Point2D): Point2D {
  return {
    x: point.x * MM_TO_PX,
    y: point.y * MM_TO_PX,
  };
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function roomBounds(vertices: Point2D[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = vertices.map((vertex) => vertex.x);
  const ys = vertices.map((vertex) => vertex.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatRoomArea(areaMm2: number): string {
  const areaM2 = areaMm2 / 1_000_000;
  const precision = areaM2 >= 100 ? 0 : areaM2 >= 10 ? 1 : 2;
  return `${areaM2.toFixed(precision)} m²`;
}

function ringPathData(vertices: Point2D[]): string {
  if (vertices.length < 3) return '';
  const [first, ...rest] = vertices.map(toCanvasPoint);
  const commands = [`M ${first.x} ${first.y}`];
  rest.forEach((point) => {
    commands.push(`L ${point.x} ${point.y}`);
  });
  commands.push('Z');
  return commands.join(' ');
}

function distanceToRingEdges(point: Point2D, ring: Point2D[]): number {
  if (ring.length < 2) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    best = Math.min(best, distancePointToSegment(point, start, end).distance);
  }
  return Number.isFinite(best) ? best : 0;
}

export class RoomRenderer {
  private canvas: fabric.Canvas;
  private roomGroups = new Map<string, RoomGroup>();
  private roomControlGroups = new Map<string, RoomControlGroup>();
  private areaTagGroups = new Map<string, RoomLabelGroup>();
  private areaTagData = new Map<string, AreaTag>();
  private roomData = new Map<string, Room>();
  private wallData = new Map<string, Wall>();
  private hvacData = new Map<string, HvacElement>();
  private selectedRoomIds = new Set<string>();
  private activeDragRoomId: string | null = null;
  private persistentControlRoomId: string | null = null;
  private hoveredRoomId: string | null = null;
  private showTemperatureIcons: boolean = true;
  private showVentilationBadges: boolean = true;
  private viewportZoom = 1;
  private lastVisibilityBounds: ViewportBounds | null = null;
  private lastVisibilityZoom: number | null = null;

  constructor(canvas: fabric.Canvas) {
    this.canvas = canvas;
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

  private pointInArea(point: Point2D, outer: Point2D[], holes: Point2D[][] = []): boolean {
    if (!this.pointInPolygon(point, outer)) {
      return false;
    }
    return holes.every((hole) => !this.pointInPolygon(point, hole));
  }

  setShowTemperatureIcons(show: boolean): void {
    this.showTemperatureIcons = show;
    this.syncRooms(Array.from(this.roomData.values()), { force: true });
  }

  setShowVentilationBadges(show: boolean): void {
    this.showVentilationBadges = show;
    this.syncRooms(Array.from(this.roomData.values()), { force: true });
  }

  setViewportZoom(
    zoom: number,
    options: { requestRender?: boolean; refreshVisibility?: boolean; applyLabelScaling?: boolean } = {}
  ): void {
    const {
      requestRender = true,
      refreshVisibility = true,
      applyLabelScaling = true,
    } = options;
    const nextZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const prevZoom = this.viewportZoom;
    this.viewportZoom = nextZoom;

    if (
      applyLabelScaling &&
      Math.abs(nextZoom - prevZoom) / Math.max(prevZoom, 0.01) >= 0.005
    ) {
      this.applyLabelZoomScaling();
    }
    if (refreshVisibility) {
      this.refreshViewportVisibility();
    }
    if (requestRender) {
      this.canvas.requestRenderAll();
    }
  }

  private annotate(target: fabric.FabricObject, roomId: string, name?: string): void {
    const typed = target as NamedObject;
    typed.roomId = roomId;
    typed.id = roomId;
    if (name) {
      typed.name = name;
    }
  }

  private annotateDecoration(target: fabric.FabricObject, roomId: string, name?: string): void {
    const typed = target as NamedObject;
    typed.roomId = roomId;
    typed.id = roomId;
    if (name) {
      typed.name = name;
    }
    typed.isRoomControlDecoration = true;
    typed.selectable = false;
    typed.evented = false;
  }

  private sp(screenPx: number): number {
    return screenPx / this.viewportZoom;
  }

  private getBaseLabelScale(): number {
    const safeZoom = Math.max(this.viewportZoom, 0.05);
    return clamp(LABEL_TARGET_SCREEN_SCALE / safeZoom, LABEL_MIN_SCENE_SCALE, 10);
  }

  private isRoomControlVisible(roomId: string): boolean {
    return (
      this.selectedRoomIds.has(roomId) ||
      this.activeDragRoomId === roomId ||
      this.persistentControlRoomId === roomId
    );
  }

  private canShowRoomRotationControl(roomId: string): boolean {
    return isRoomIsolatedFromAttachments(this.roomData.get(roomId), this.wallData);
  }

  private isRotationControlObject(object: fabric.FabricObject): boolean {
    const named = object as NamedObject;
    return named.name?.startsWith('room-rotation-handle') ?? false;
  }

  private updateRoomControlGroupVisibility(group: RoomControlGroup, roomId: string): void {
    const visible = this.isRoomControlVisible(roomId);
    const rotationVisible = visible && this.canShowRoomRotationControl(roomId);
    group.getObjects().forEach((object) => {
      object.set('visible', this.isRotationControlObject(object) ? rotationVisible : visible);
      object.setCoords();
    });
    group.set('dirty', true);
    group.setCoords();
    if (visible) {
      this.canvas.bringObjectToFront(group);
    }
  }

  setWallContext(walls: Wall[]): void {
    this.wallData = new Map(walls.map((wall) => [wall.id, wall]));
    this.syncRoomVisualState();
    this.canvas.requestRenderAll();
  }

  setHvacContext(hvacElements: HvacElement[]): void {
    this.hvacData = new Map(hvacElements.map((element) => [element.id, element]));
    if (this.roomData.size === 0) {
      return;
    }
    this.syncAreaTagsFromRooms(Array.from(this.roomData.values()));
    this.canvas.requestRenderAll();
  }

  private roomNeedsRerender(previousRoom: Room | undefined, nextRoom: Room): boolean {
    return previousRoom !== nextRoom;
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

    this.roomData.forEach((_, roomId) => {
      const roomGroup = this.roomGroups.get(roomId);
      if (!roomGroup) {
        return;
      }
      const visible = this.isObjectVisibleInViewport(roomGroup, visibleBounds);
      const controlGroup = this.roomControlGroups.get(roomId);

      if (roomGroup.visible !== visible) {
        roomGroup.set('visible', visible);
        roomGroup.set('dirty', true);
      }
      if (controlGroup && controlGroup.visible !== visible) {
        controlGroup.set('visible', visible);
        controlGroup.set('dirty', true);
      }
    });

    this.areaTagGroups.forEach((group) => {
      const visible = this.isObjectVisibleInViewport(group, visibleBounds);
      if (group.visible !== visible) {
        group.set('visible', visible);
        group.set('dirty', true);
      }
    });
  }

  private syncRoomVisualState(): void {
    this.roomGroups.forEach((group, roomId) => {
      const selected = this.selectedRoomIds.has(roomId);
      const selection = group
        .getObjects()
        .find((object) => (object as NamedObject).name === 'selectionOutline');
      if (selection) {
        selection.set('visible', selected);
      }

      const hover = group
        .getObjects()
        .find((object) => (object as NamedObject).name === 'hoverOutline');
      if (hover) {
        hover.set('visible', !selected && this.hoveredRoomId === roomId);
      }

      group.set('dirty', true);
    });

    this.roomControlGroups.forEach((group, roomId) => {
      this.updateRoomControlGroupVisibility(group, roomId);
    });

    this.areaTagGroups.forEach((group) => {
      this.applyZoomScaleToLabelGroup(group);
      group.set('dirty', true);
      this.canvas.bringObjectToFront(group);
    });

    if (this.persistentControlRoomId) {
      const controlGroup = this.roomControlGroups.get(this.persistentControlRoomId);
      if (controlGroup) {
        this.canvas.bringObjectToFront(controlGroup);
      }
    }
  }

  private doesLabelRectFitArea(
    center: Point2D,
    halfWidth: number,
    halfHeight: number,
    vertices: Point2D[],
    holes: Point2D[][] = [],
    obstacles: AreaTagObstacle[] = []
  ): boolean {
    const outer = vertices.map(toCanvasPoint);
    const canvasHoles = holes.map((hole) => hole.map(toCanvasPoint));
    const testPoints: Point2D[] = [
      center,
      { x: center.x - halfWidth, y: center.y - halfHeight },
      { x: center.x + halfWidth, y: center.y - halfHeight },
      { x: center.x + halfWidth, y: center.y + halfHeight },
      { x: center.x - halfWidth, y: center.y + halfHeight },
    ];
    const insideArea = testPoints.every((point) => this.pointInArea(point, outer, canvasHoles));
    if (!insideArea) {
      return false;
    }

    const labelLeft = center.x - halfWidth;
    const labelTop = center.y - halfHeight;
    const labelRight = center.x + halfWidth;
    const labelBottom = center.y + halfHeight;
    return obstacles.every((obstacle) => (
      labelRight <= obstacle.left ||
      labelLeft >= obstacle.right ||
      labelBottom <= obstacle.top ||
      labelTop >= obstacle.bottom
    ));
  }

  private getAreaTagCandidatePoints(areaTag: Pick<AreaTag, 'centroid' | 'vertices' | 'holes'>): Point2D[] {
    const candidates: Point2D[] = [{ ...areaTag.centroid }];
    const bounds = roomBounds(areaTag.vertices);
    const width = Math.max(bounds.maxX - bounds.minX, 1);
    const height = Math.max(bounds.maxY - bounds.minY, 1);
    const steps = AREA_TAG_CANDIDATE_GRID;

    for (let row = 0; row <= steps; row += 1) {
      for (let column = 0; column <= steps; column += 1) {
        const point = {
          x: bounds.minX + (width * column) / steps,
          y: bounds.minY + (height * row) / steps,
        };
        if (GeometryEngine.pointInRoom(point, areaTag)) {
          candidates.push(point);
        }
      }
    }

    areaTag.vertices.forEach((vertex, index) => {
      const next = areaTag.vertices[(index + 1) % areaTag.vertices.length];
      candidates.push(midpoint(vertex, next));
    });

    const deduped: Point2D[] = [];
    candidates.forEach((candidate) => {
      if (!GeometryEngine.pointInRoom(candidate, areaTag)) {
        return;
      }
      const exists = deduped.some((point) => (
        Math.abs(point.x - candidate.x) < 1 &&
        Math.abs(point.y - candidate.y) < 1
      ));
      if (!exists) {
        deduped.push(candidate);
      }
    });
    return deduped;
  }

  private getAreaTagClearance(
    point: Point2D,
    areaTag: Pick<AreaTag, 'vertices' | 'holes'>
  ): number {
    const outerClearance = distanceToRingEdges(point, areaTag.vertices);
    const holeClearance = areaTag.holes.reduce((best, hole) => (
      Math.min(best, distanceToRingEdges(point, hole))
    ), Number.POSITIVE_INFINITY);
    return Math.min(outerClearance, holeClearance);
  }

  private getHvacBoundsInCanvas(element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'rotation'>): AreaTagObstacle {
    const center = toCanvasPoint({
      x: element.position.x + element.width / 2,
      y: element.position.y + element.depth / 2,
    });
    const halfWidth = (element.width * MM_TO_PX) / 2;
    const halfDepth = (element.depth * MM_TO_PX) / 2;
    const angleRad = ((element.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const corners = [
      { x: -halfWidth, y: -halfDepth },
      { x: halfWidth, y: -halfDepth },
      { x: halfWidth, y: halfDepth },
      { x: -halfWidth, y: halfDepth },
    ].map((corner) => ({
      x: center.x + corner.x * cos - corner.y * sin,
      y: center.y + corner.x * sin + corner.y * cos,
    }));
    const padding = AREA_TAG_HVAC_CLEARANCE_PX;
    return {
      left: Math.min(...corners.map((corner) => corner.x)) - padding,
      top: Math.min(...corners.map((corner) => corner.y)) - padding,
      right: Math.max(...corners.map((corner) => corner.x)) + padding,
      bottom: Math.max(...corners.map((corner) => corner.y)) + padding,
    };
  }

  private getRoomHvacObstacles(room: Room): AreaTagObstacle[] {
    const obstacles: AreaTagObstacle[] = [];
    this.hvacData.forEach((element) => {
      const centerPoint = {
        x: element.position.x + element.width / 2,
        y: element.position.y + element.depth / 2,
      };
      const belongsToRoom = element.roomId === room.id || GeometryEngine.pointInRoom(centerPoint, room);
      if (!belongsToRoom) {
        return;
      }
      obstacles.push(this.getHvacBoundsInCanvas(element));
    });
    return obstacles;
  }

  private getAreaTagPlacement(
    areaTag: Pick<AreaTag, 'centroid' | 'vertices' | 'holes' | 'obstacles'>,
    baseWidth: number,
    baseHeight: number
  ): { center: Point2D; scale: number } {
    const preferredScale = this.getBaseLabelScale();
    const minimumScale = Math.max(preferredScale * LABEL_MIN_FIT_RATIO, LABEL_MIN_SCENE_SCALE);
    const candidates = this.getAreaTagCandidatePoints(areaTag)
      .map((candidate) => ({
        center: candidate,
        clearance: this.getAreaTagClearance(candidate, areaTag),
      }))
      .sort((left, right) => right.clearance - left.clearance);

    let best = {
      center: areaTag.centroid,
      scale: minimumScale,
      score: Number.NEGATIVE_INFINITY,
    };

    candidates.forEach(({ center, clearance }) => {
      const labelCenter = toCanvasPoint(center);
      let bestScaleForCandidate = minimumScale;
      let fits = false;

      for (let step = 0; step <= LABEL_FIT_STEPS; step += 1) {
        const t = step / LABEL_FIT_STEPS;
        const scale = preferredScale - (preferredScale - minimumScale) * t;
        const halfWidth = (baseWidth * scale) / 2;
        const halfHeight = (baseHeight * scale) / 2;
        if (this.doesLabelRectFitArea(
          labelCenter,
          halfWidth,
          halfHeight,
          areaTag.vertices,
          areaTag.holes,
          areaTag.obstacles,
        )) {
          bestScaleForCandidate = scale;
          fits = true;
          break;
        }
      }

      const score = (fits ? 1_000_000 : 0) + bestScaleForCandidate * 10_000 + clearance;
      if (score > best.score) {
        best = {
          center,
          scale: bestScaleForCandidate,
          score,
        };
      }
    });

    return {
      center: best.center,
      scale: best.scale,
    };
  }

  private createAreaTagGroup(areaTag: AreaTag): RoomLabelGroup {
    const areaText = formatRoomArea(areaTag.area);
    const areaFontSize = AREA_TAG_FONT_SIZE;

    const areaLabel = new fabric.Text(areaText, {
      left: 0,
      top: 0,
      fontSize: areaFontSize,
      fontWeight: 'bold',
      fill: '#0F172A',
      fontFamily: 'Arial',
      textAlign: 'center',
      originX: 'center',
      originY: 'top',
      selectable: false,
      evented: false,
    });
    this.annotate(areaLabel, areaTag.id, 'roomLabelArea');

    const paddingX = AREA_TAG_PADDING_X;
    const paddingY = AREA_TAG_PADDING_Y;
    const areaWidth = areaLabel.width ?? areaText.length * areaFontSize * 0.52;
    const areaHeight = areaLabel.height ?? areaFontSize * 1.2;
    const labelWidth = areaWidth + paddingX * 2;
    const labelHeight = areaHeight + paddingY * 2;

    const background = new fabric.Rect({
      left: 0,
      top: 0,
      width: labelWidth,
      height: labelHeight,
      rx: 10,
      ry: 10,
      fill: 'rgba(255,255,255,0.94)',
      stroke: areaTag.accentColor,
      strokeWidth: 1,
      originX: 'left',
      originY: 'top',
      selectable: false,
      evented: false,
      shadow: new fabric.Shadow({
        color: 'rgba(15,23,42,0.2)',
        blur: 7,
        offsetX: 0,
        offsetY: 2,
      }),
    });
    this.annotate(background, areaTag.id, 'roomLabelBackground');

    areaLabel.set({
      left: labelWidth / 2,
      top: paddingY,
    });

    const labelCenter = toCanvasPoint(areaTag.centroid);

    const labelGroup = new fabric.Group([background, areaLabel], {
      left: labelCenter.x,
      top: labelCenter.y,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      objectCaching: false,
      excludeFromExport: true,
    }) as RoomLabelGroup;
    labelGroup.id = areaTag.id;
    labelGroup.roomId = areaTag.id;
    labelGroup.name = `room-area-tag-${areaTag.id}`;
    this.applyZoomScaleToLabelGroup(labelGroup);
    return labelGroup;
  }

  private applyZoomScaleToLabelGroup(group: RoomLabelGroup): void {
    const areaTag = group.roomId ? this.areaTagData.get(group.roomId) : null;
    const placement = areaTag
      ? this.getAreaTagPlacement(areaTag, group.width ?? 0, group.height ?? 0)
      : { center: { x: 0, y: 0 }, scale: this.getBaseLabelScale() };
    if (areaTag) {
      const center = toCanvasPoint(placement.center);
      group.set({
        left: center.x,
        top: center.y,
      });
    }
    group.set({
      scaleX: placement.scale,
      scaleY: placement.scale,
    });
    group.setCoords();
  }

  private applyLabelZoomScaling(): void {
    this.areaTagGroups.forEach((group) => {
      this.applyZoomScaleToLabelGroup(group);
    });
  }

  private buildAreaTagsFromRooms(rooms: Room[]): AreaTag[] {
    return rooms
      .filter((room) => room.showLabel)
      .map((room) => ({
        id: room.id,
        roomId: room.id,
        area: room.area,
        centroid: { ...room.centroid },
        vertices: room.vertices.map((vertex) => ({ ...vertex })),
        holes: (room.holes ?? []).map((hole) => hole.map((vertex) => ({ ...vertex }))),
        accentColor: '#94A3B8',
        obstacles: this.getRoomHvacObstacles(room),
      }));
  }

  private roomPathData(room: Pick<Room, 'vertices' | 'holes'>): string {
    return [room.vertices, ...(room.holes ?? [])]
      .map((ring) => ringPathData(ring))
      .filter((path) => path.length > 0)
      .join(' ');
  }

  private syncAreaTagsFromRooms(rooms: Room[]): void {
    this.areaTagGroups.forEach((group) => this.canvas.remove(group));
    this.areaTagGroups.clear();
    this.areaTagData.clear();

    this.buildAreaTagsFromRooms(rooms).forEach((areaTag) => {
      this.areaTagData.set(areaTag.id, areaTag);
      const group = this.createAreaTagGroup(areaTag);
      this.areaTagGroups.set(areaTag.id, group);
      this.canvas.add(group);
      this.canvas.bringObjectToFront(group);
    });

    this.applyLabelZoomScaling();
    this.refreshViewportVisibility(true);
  }

  private createRoomGroup(room: Room): RoomGroup {
    const pathData = this.roomPathData(room);

    const fill = new fabric.Path(pathData, {
      // Keep the room hit area interactive without visibly tinting the room interior.
      fill: 'rgba(0,0,0,0.001)',
      fillRule: 'evenodd',
      stroke: 'transparent',
      strokeWidth: 0,
      selectable: false,
      evented: true,
    });
    this.annotate(fill, room.id, 'roomFill');

    const selectionOutline = new fabric.Path(pathData, {
      fill: 'transparent',
      fillRule: 'evenodd',
      stroke: '#1D4ED8',
      strokeWidth: 3,
      strokeDashArray: [6, 4],
      selectable: false,
      evented: false,
      visible: this.selectedRoomIds.has(room.id),
    });
    this.annotate(selectionOutline, room.id, 'selectionOutline');

    const hoverOutline = new fabric.Path(pathData, {
      fill: 'transparent',
      fillRule: 'evenodd',
      stroke: '#059669',
      strokeWidth: 2.5,
      strokeDashArray: [5, 5],
      selectable: false,
      evented: false,
      visible: this.hoveredRoomId === room.id && !this.selectedRoomIds.has(room.id),
    });
    this.annotate(hoverOutline, room.id, 'hoverOutline');

    const centroidCanvas = toCanvasPoint(room.centroid);

    const hvacIndicators: fabric.FabricObject[] = [];
    if (this.showTemperatureIcons) {
      const avgSetpoint = (room.properties3D.heatingSetpointC + room.properties3D.coolingSetpointC) / 2;
      const temperatureColor = avgSetpoint <= 20
        ? '#60A5FA'
        : avgSetpoint >= 26
          ? '#F97316'
          : '#34D399';
      const temperatureIcon = new fabric.Circle({
        left: centroidCanvas.x + 44,
        top: centroidCanvas.y - 26,
        radius: 8,
        fill: '#FFFFFF',
        stroke: temperatureColor,
        strokeWidth: 2,
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      this.annotate(temperatureIcon, room.id, 'room-temp-icon');
      const temperatureText = new fabric.Text(`${room.properties3D.heatingSetpointC.toFixed(0)}-${room.properties3D.coolingSetpointC.toFixed(0)}C`, {
        left: centroidCanvas.x + 44,
        top: centroidCanvas.y - 26,
        fontSize: 8,
        fill: '#1F2937',
        fontFamily: 'Arial',
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      this.annotate(temperatureText, room.id, 'room-temp-text');
      hvacIndicators.push(temperatureIcon, temperatureText);
    }

    if (this.showVentilationBadges) {
      const ventilationLabel = room.properties3D.requiresExhaust
        ? `OA ${room.properties3D.ventilationOutdoorAirLps.toFixed(0)} + EXH`
        : `OA ${room.properties3D.ventilationOutdoorAirLps.toFixed(0)}`;
      const badgeWidth = Math.max(44, ventilationLabel.length * 4.7);
      const ventilationBadge = new fabric.Rect({
        left: centroidCanvas.x + 44,
        top: centroidCanvas.y - 10,
        width: badgeWidth,
        height: 12,
        rx: 6,
        ry: 6,
        fill: '#FFFFFF',
        stroke: room.properties3D.requiresExhaust ? '#0EA5E9' : '#64748B',
        strokeWidth: 1,
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      this.annotate(ventilationBadge, room.id, 'room-oa-badge');
      const ventilationText = new fabric.Text(ventilationLabel, {
        left: centroidCanvas.x + 44,
        top: centroidCanvas.y - 10,
        fontSize: 8,
        fill: '#0F172A',
        fontFamily: 'Arial',
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
      });
      this.annotate(ventilationText, room.id, 'room-oa-text');
      hvacIndicators.push(ventilationBadge, ventilationText);
    }

    const group = new fabric.Group(
      [
        fill,
        selectionOutline,
        hoverOutline,
        ...hvacIndicators,
      ],
      {
        selectable: true,
        evented: true,
        subTargetCheck: true,
        hasControls: false,
        hasBorders: false,
        lockMovementX: true,
        lockMovementY: true,
        objectCaching: true,
      }
    ) as RoomGroup;

    group.id = room.id;
    group.roomId = room.id;
    group.name = `room-${room.id}`;
    return group;
  }

  private createRoomControlGroup(room: Room): RoomControlGroup {
    const centroidCanvas = toCanvasPoint(room.centroid);
    const controlsVisible = this.isRoomControlVisible(room.id);
    const rotationControlsVisible = controlsVisible && this.canShowRoomRotationControl(room.id);
    const bounds = roomBounds(room.vertices);
    const boundsCenter = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    const boundsTopCanvas = bounds.minY * MM_TO_PX;
    const centerHandleSize = this.sp(controlsVisible ? 24 : 22);
    const centerHandleInnerSize = Math.max(centerHandleSize - this.sp(4), this.sp(10));
    const centerHandleHit = new fabric.Circle({
      left: centroidCanvas.x,
      top: centroidCanvas.y,
      radius: this.sp(18),
      fill: 'rgba(37,99,235,0.001)',
      stroke: 'rgba(37,99,235,0.001)',
      strokeWidth: 1,
      originX: 'center',
      originY: 'center',
      selectable: true,
      evented: true,
      hoverCursor: 'move',
      hasControls: false,
      hasBorders: false,
      visible: controlsVisible,
    });
    this.annotate(centerHandleHit, room.id, 'room-center-handle-hit');
    (centerHandleHit as NamedObject).controlType = 'room-center-handle';
    (centerHandleHit as NamedObject).isRoomControl = true;
    const centerHandle = new fabric.Rect({
      left: centroidCanvas.x,
      top: centroidCanvas.y,
      width: centerHandleSize,
      height: centerHandleSize,
      rx: this.sp(4),
      ry: this.sp(4),
      fill: '#FFFFFF',
      stroke: '#2563EB',
      strokeWidth: this.sp(2.2),
      originX: 'center',
      originY: 'center',
      selectable: true,
      evented: true,
      hoverCursor: 'move',
      hasControls: false,
      hasBorders: false,
      visible: controlsVisible,
      shadow: new fabric.Shadow({
        color: 'rgba(37, 99, 235, 0.2)',
        blur: this.sp(8),
        offsetX: 0,
        offsetY: this.sp(1),
      }),
    });
    this.annotate(centerHandle, room.id, 'room-center-handle');
    (centerHandle as NamedObject).controlType = 'room-center-handle';
    (centerHandle as NamedObject).isRoomControl = true;

    const centerHandleInner = new fabric.Rect({
      left: centroidCanvas.x,
      top: centroidCanvas.y,
      width: centerHandleInnerSize,
      height: centerHandleInnerSize,
      rx: this.sp(2.8),
      ry: this.sp(2.8),
      fill: '#EFF6FF',
      stroke: '#BFDBFE',
      strokeWidth: this.sp(1),
      originX: 'center',
      originY: 'center',
      visible: controlsVisible,
    });
    this.annotateDecoration(centerHandleInner, room.id, 'room-center-handle-inner');

    const moveAxisHalf = this.sp(4.8);
    const moveHeadLength = this.sp(3.6);
    const moveHeadHalfWidth = this.sp(2.5);
    const moveGlyphH = new fabric.Line(
      [
        centroidCanvas.x - moveAxisHalf,
        centroidCanvas.y,
        centroidCanvas.x + moveAxisHalf,
        centroidCanvas.y,
      ],
      {
        stroke: '#2563EB',
        strokeWidth: this.sp(1.5),
        visible: controlsVisible,
      }
    );
    this.annotateDecoration(moveGlyphH, room.id, 'room-center-glyph-h');
    const moveGlyphV = new fabric.Line(
      [
        centroidCanvas.x,
        centroidCanvas.y - moveAxisHalf,
        centroidCanvas.x,
        centroidCanvas.y + moveAxisHalf,
      ],
      {
        stroke: '#2563EB',
        strokeWidth: this.sp(1.5),
        visible: controlsVisible,
      }
    );
    this.annotateDecoration(moveGlyphV, room.id, 'room-center-glyph-v');
    const createMoveHead = (dx: number, dy: number) =>
      new fabric.Polygon(
        [
          {
            x: centroidCanvas.x + dx * (moveAxisHalf + moveHeadLength),
            y: centroidCanvas.y + dy * (moveAxisHalf + moveHeadLength),
          },
          {
            x: centroidCanvas.x + dx * moveAxisHalf - dy * moveHeadHalfWidth,
            y: centroidCanvas.y + dy * moveAxisHalf + dx * moveHeadHalfWidth,
          },
          {
            x: centroidCanvas.x + dx * moveAxisHalf + dy * moveHeadHalfWidth,
            y: centroidCanvas.y + dy * moveAxisHalf - dx * moveHeadHalfWidth,
          },
        ],
        {
          fill: '#2563EB',
          stroke: '#2563EB',
          strokeWidth: this.sp(0.8),
          visible: controlsVisible,
        }
      );
    const moveHeadRight = createMoveHead(1, 0);
    const moveHeadLeft = createMoveHead(-1, 0);
    const moveHeadDown = createMoveHead(0, 1);
    const moveHeadUp = createMoveHead(0, -1);
    this.annotateDecoration(moveHeadRight, room.id, 'room-center-glyph-right');
    this.annotateDecoration(moveHeadLeft, room.id, 'room-center-glyph-left');
    this.annotateDecoration(moveHeadDown, room.id, 'room-center-glyph-down');
    this.annotateDecoration(moveHeadUp, room.id, 'room-center-glyph-up');

    // Keep room rotation axis visually vertical: handle is always above centroid X.
    const rotationPoint = {
      x: centroidCanvas.x,
      y: boundsTopCanvas - this.sp(40),
    };
    const rotationHandleHit = new fabric.Circle({
      left: rotationPoint.x,
      top: rotationPoint.y,
      radius: this.sp(18),
      fill: 'rgba(21,128,61,0.001)',
      stroke: 'rgba(21,128,61,0.001)',
      strokeWidth: 1,
      originX: 'center',
      originY: 'center',
      selectable: true,
      evented: true,
      hoverCursor: 'alias',
      hasControls: false,
      hasBorders: false,
      visible: rotationControlsVisible,
    });
    this.annotate(rotationHandleHit, room.id, 'room-rotation-handle-hit');
    (rotationHandleHit as NamedObject).controlType = 'room-rotation-handle';
    (rotationHandleHit as NamedObject).isRoomControl = true;
    const rotationStem = new fabric.Line(
      [
        centroidCanvas.x,
        centroidCanvas.y,
        rotationPoint.x,
        rotationPoint.y,
      ],
      {
        stroke: '#15803D',
        strokeWidth: this.sp(1.3),
        strokeDashArray: [this.sp(4), this.sp(3)],
        visible: rotationControlsVisible,
      }
    );
    this.annotateDecoration(rotationStem, room.id, 'room-rotation-handle-stem');
    const rotationHandle = new fabric.Circle({
      left: rotationPoint.x,
      top: rotationPoint.y,
      radius: this.sp(8),
      fill: '#FFFFFF',
      stroke: '#15803D',
      strokeWidth: this.sp(2.2),
      originX: 'center',
      originY: 'center',
      selectable: true,
      evented: true,
      hoverCursor: 'alias',
      hasControls: false,
      hasBorders: false,
      visible: rotationControlsVisible,
    });
    this.annotate(rotationHandle, room.id, 'room-rotation-handle');
    (rotationHandle as NamedObject).controlType = 'room-rotation-handle';
    (rotationHandle as NamedObject).isRoomControl = true;
    const rotationLabel = new fabric.Text('R', {
      left: rotationPoint.x,
      top: rotationPoint.y,
      fontSize: this.sp(10),
      fontWeight: 'bold',
      fill: '#166534',
      fontFamily: 'Arial',
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false,
      visible: rotationControlsVisible,
    });
    this.annotateDecoration(rotationLabel, room.id, 'room-rotation-handle-label');

    const cornerHandles = room.vertices.map((vertex, index) => {
      const cornerPoint = toCanvasPoint(vertex);
      const corner = new fabric.Rect({
        left: cornerPoint.x,
        top: cornerPoint.y,
        width: 12,
        height: 12,
        fill: '#EFF6FF',
        stroke: '#1D4ED8',
        strokeWidth: 2.5,
        originX: 'center',
        originY: 'center',
        selectable: true,
        evented: true,
        hoverCursor: 'move',
        visible: controlsVisible,
        hasControls: false,
        hasBorders: false,
      });
      this.annotate(corner, room.id, 'room-corner-handle');
      (corner as NamedObject).controlType = 'room-corner-handle';
      (corner as NamedObject).isRoomControl = true;
      (corner as NamedObject).cornerIndex = index;
      return corner;
    });

    const edgeMidHandles = room.vertices.map((vertex, index) => {
      const next = room.vertices[(index + 1) % room.vertices.length];
      const edgePoint = toCanvasPoint(midpoint(vertex, next));
      const edgeHandle = new fabric.Circle({
        left: edgePoint.x,
        top: edgePoint.y,
        radius: 6,
        fill: '#EFF6FF',
        stroke: '#1D4ED8',
        strokeWidth: 2,
        originX: 'center',
        originY: 'center',
        selectable: false,
        evented: false,
        visible: controlsVisible,
      });
      this.annotateDecoration(edgeHandle, room.id, 'room-edge-mid-handle');
      return edgeHandle;
    });

    const scaleHandleSpecs: Array<{
      direction: 'NW' | 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W';
      point: Point2D;
      cursor: string;
    }> = [
      { direction: 'NW', point: { x: bounds.minX, y: bounds.minY }, cursor: 'nwse-resize' },
      { direction: 'N', point: { x: boundsCenter.x, y: bounds.minY }, cursor: 'ns-resize' },
      { direction: 'NE', point: { x: bounds.maxX, y: bounds.minY }, cursor: 'nesw-resize' },
      { direction: 'E', point: { x: bounds.maxX, y: boundsCenter.y }, cursor: 'ew-resize' },
      { direction: 'SE', point: { x: bounds.maxX, y: bounds.maxY }, cursor: 'nwse-resize' },
      { direction: 'S', point: { x: boundsCenter.x, y: bounds.maxY }, cursor: 'ns-resize' },
      { direction: 'SW', point: { x: bounds.minX, y: bounds.maxY }, cursor: 'nesw-resize' },
      { direction: 'W', point: { x: bounds.minX, y: boundsCenter.y }, cursor: 'ew-resize' },
    ];

    const scaleHandles = scaleHandleSpecs.map((spec) => {
      const scalePoint = toCanvasPoint(spec.point);
      const scaleHandle = new fabric.Rect({
        left: scalePoint.x,
        top: scalePoint.y,
        width: 11,
        height: 11,
        fill: '#ECFDF5',
        stroke: '#15803D',
        strokeWidth: 2.4,
        originX: 'center',
        originY: 'center',
        selectable: true,
        evented: true,
        hoverCursor: spec.cursor,
        visible: controlsVisible,
        hasControls: false,
        hasBorders: false,
      });
      this.annotate(scaleHandle, room.id, 'room-scale-handle');
      (scaleHandle as NamedObject).controlType = 'room-scale-handle';
      (scaleHandle as NamedObject).isRoomControl = true;
      (scaleHandle as NamedObject).scaleDirection = spec.direction;
      return scaleHandle;
    });

    const group = new fabric.Group(
      [
        ...edgeMidHandles,
        ...cornerHandles,
        ...scaleHandles,
        rotationHandleHit,
        rotationStem,
        rotationHandle,
        rotationLabel,
        centerHandleHit,
        centerHandle,
        centerHandleInner,
        moveGlyphH,
        moveGlyphV,
        moveHeadRight,
        moveHeadLeft,
        moveHeadDown,
        moveHeadUp,
      ],
      {
        selectable: true,
        evented: true,
        subTargetCheck: true,
        hasControls: false,
        hasBorders: false,
        lockMovementX: true,
        lockMovementY: true,
        objectCaching: true,
      }
    ) as RoomControlGroup;

    group.id = room.id;
    group.roomId = room.id;
    group.name = `room-controls-${room.id}`;
    return group;
  }

  renderRoom(room: Room): void {
    this.removeRoom(room.id);
    this.roomData.set(room.id, room);

    const group = this.createRoomGroup(room);
    this.roomGroups.set(room.id, group);
    this.canvas.add(group);
    this.canvas.sendObjectToBack(group);

    const controlGroup = this.createRoomControlGroup(room);
    this.roomControlGroups.set(room.id, controlGroup);
    this.canvas.add(controlGroup);
    this.canvas.bringObjectToFront(controlGroup);
  }

  renderAllRooms(rooms: Room[]): void {
    this.syncRooms(rooms, { force: true });
  }

  syncRooms(rooms: Room[], options: SyncRoomsOptions = {}): void {
    const { force = false } = options;
    const nextRoomIds = new Set(rooms.map((room) => room.id));
    let changed = force;

    this.roomData.forEach((_, roomId) => {
      if (!nextRoomIds.has(roomId)) {
        this.removeRoom(roomId);
        changed = true;
      }
    });

    rooms.forEach((room) => {
      const previousRoom = this.roomData.get(room.id);
      const hasRequiredGroups =
        this.roomGroups.has(room.id) &&
        this.roomControlGroups.has(room.id);
      if (!force && hasRequiredGroups && !this.roomNeedsRerender(previousRoom, room)) {
        return;
      }
      this.renderRoom(room);
      changed = true;
    });

    if (!changed) {
      return;
    }

    this.syncAreaTagsFromRooms(Array.from(this.roomData.values()));
    this.applyLabelZoomScaling();
    this.refreshViewportVisibility(true);
    this.syncRoomVisualState();
    this.canvas.requestRenderAll();
  }

  setSelectedRooms(roomIds: string[]): void {
    this.selectedRoomIds = new Set(roomIds);
    this.syncRoomVisualState();
    this.canvas.requestRenderAll();
  }

  setActiveDragRoom(roomId: string | null): void {
    this.activeDragRoomId = roomId;
    this.syncRoomVisualState();
    this.canvas.requestRenderAll();
  }

  setPersistentControlRoom(roomId: string | null): void {
    this.persistentControlRoomId = roomId;
    this.syncRoomVisualState();
    this.canvas.requestRenderAll();
  }

  setHoveredRoom(roomId: string | null): void {
    this.hoveredRoomId = roomId;
    this.syncRoomVisualState();
    this.canvas.requestRenderAll();
  }

  getRoomIdAtPoint(point: Point2D): string | null {
    let bestRoomId: string | null = null;
    let bestArea = Number.POSITIVE_INFINITY;

    this.roomData.forEach((room, roomId) => {
      if (!GeometryEngine.pointInRoom(point, room)) {
        return;
      }

      const area = Number.isFinite(room.area) && room.area > 0
        ? room.area
        : GeometryEngine.calculateRoomAreaMm2(room);
      if (area < bestArea) {
        bestArea = area;
        bestRoomId = roomId;
      }
    });

    return bestRoomId;
  }

  removeRoom(roomId: string): void {
    const group = this.roomGroups.get(roomId);
    if (group) {
      this.canvas.remove(group);
      this.roomGroups.delete(roomId);
    }
    const controlGroup = this.roomControlGroups.get(roomId);
    if (controlGroup) {
      this.canvas.remove(controlGroup);
      this.roomControlGroups.delete(roomId);
    }
    this.roomData.delete(roomId);
    this.selectedRoomIds.delete(roomId);
    if (this.activeDragRoomId === roomId) {
      this.activeDragRoomId = null;
    }
    if (this.persistentControlRoomId === roomId) {
      this.persistentControlRoomId = null;
    }
    if (this.hoveredRoomId === roomId) {
      this.hoveredRoomId = null;
    }
  }

  clearAllRooms(): void {
    this.roomGroups.forEach((group) => this.canvas.remove(group));
    this.roomControlGroups.forEach((group) => this.canvas.remove(group));
    this.areaTagGroups.forEach((group) => this.canvas.remove(group));
    this.roomGroups.clear();
    this.roomControlGroups.clear();
    this.areaTagGroups.clear();
    this.areaTagData.clear();
    this.roomData.clear();
    this.hvacData.clear();
    this.selectedRoomIds.clear();
    this.activeDragRoomId = null;
    this.persistentControlRoomId = null;
    this.hoveredRoomId = null;
    this.canvas.requestRenderAll();
  }

  dispose(): void {
    this.clearAllRooms();
  }
}
