import type { DetectedRoom, RoomDetectionConfig, WallSegment } from '../types/room';
import { DEFAULT_ROOM_DETECTION_CONFIG } from '../types/room';
import { generateId } from '../utils/geometry';
import { prepareWallSegmentForInsertion } from '../utils/roomDetection';

type Point = { x: number; y: number };

export type RoomToolMode = 'rectangle' | 'polygon';

export interface RoomToolOptions {
  addWall: (wall: WallSegment) => void;
  runDetection: () => void;
  getWalls?: () => WallSegment[];
  getRooms?: () => DetectedRoom[];
  config?: Partial<RoomDetectionConfig>;
  snapToGrid?: boolean;
  gridSize?: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function snapToGrid(point: Point, enabled: boolean, gridSize: number): Point {
  if (!enabled) return { ...point };
  const safeGrid = Math.max(1, gridSize);
  return {
    x: Math.round(point.x / safeGrid) * safeGrid,
    y: Math.round(point.y / safeGrid) * safeGrid,
  };
}

export class RoomTool {
  private readonly options: RoomToolOptions;
  private readonly config: RoomDetectionConfig;
  private mode: RoomToolMode = 'rectangle';
  private rectangleStart: Point | null = null;
  private rectangleCurrent: Point | null = null;
  private polygonPoints: Point[] = [];

  constructor(options: RoomToolOptions) {
    this.options = options;
    this.config = { ...DEFAULT_ROOM_DETECTION_CONFIG, ...(options.config ?? {}) };
  }

  setMode(mode: RoomToolMode): void {
    this.mode = mode;
    this.reset();
  }

  getMode(): RoomToolMode {
    return this.mode;
  }

  reset(): void {
    this.rectangleStart = null;
    this.rectangleCurrent = null;
    this.polygonPoints = [];
  }

  handlePointerDown(point: Point): void {
    const snapped = snapToGrid(
      point,
      this.options.snapToGrid ?? true,
      this.options.gridSize ?? this.config.snapTolerance
    );

    if (this.mode === 'rectangle') {
      this.rectangleStart = snapped;
      this.rectangleCurrent = snapped;
      return;
    }

    this.polygonPoints = [...this.polygonPoints, snapped];
  }

  handlePointerMove(point: Point): void {
    if (this.mode !== 'rectangle') return;
    if (!this.rectangleStart) return;
    this.rectangleCurrent = snapToGrid(
      point,
      this.options.snapToGrid ?? true,
      this.options.gridSize ?? this.config.snapTolerance
    );
  }

  handlePointerUp(point: Point): void {
    if (this.mode !== 'rectangle') return;
    if (!this.rectangleStart) return;
    const snapped = snapToGrid(
      point,
      this.options.snapToGrid ?? true,
      this.options.gridSize ?? this.config.snapTolerance
    );
    this.rectangleCurrent = snapped;
    if (distance(this.rectangleStart, snapped) < this.config.snapTolerance) {
      this.reset();
      return;
    }
    this.commitRectangle(this.rectangleStart, snapped);
    this.reset();
  }

  handleDoubleClick(): void {
    if (this.mode !== 'polygon') return;
    if (this.polygonPoints.length < 3) {
      this.reset();
      return;
    }
    this.commitPolygon(this.polygonPoints);
    this.reset();
  }

  getRectanglePreview(): { start: Point; end: Point } | null {
    if (!this.rectangleStart || !this.rectangleCurrent) return null;
    return {
      start: { ...this.rectangleStart },
      end: { ...this.rectangleCurrent },
    };
  }

  getPolygonPreview(): Point[] {
    return this.polygonPoints.map((point) => ({ ...point }));
  }

  private commitRectangle(start: Point, end: Point): void {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    const corners: Point[] = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
    this.createWallsFromLoop(corners);
  }

  private commitPolygon(points: Point[]): void {
    if (points.length < 3) return;
    this.createWallsFromLoop(points);
  }

  private createWallsFromLoop(points: Point[]): void {
    if (points.length < 3) return;
    for (let i = 0; i < points.length; i++) {
      const startPoint = points[i];
      const endPoint = points[(i + 1) % points.length];
      if (!startPoint || !endPoint) continue;
      if (distance(startPoint, endPoint) < this.config.snapTolerance / 2) continue;

      const baseWall: WallSegment = {
        id: generateId(),
        startPoint: { ...startPoint },
        endPoint: { ...endPoint },
        thickness: 8,
        snapToGrid: true,
        startBevel: {
          outerOffset: 0,
          innerOffset: 0,
        },
        endBevel: {
          outerOffset: 0,
          innerOffset: 0,
        },
      };
      const existingWalls = this.options.getWalls?.() ?? [];
      const existingRooms = this.options.getRooms?.() ?? [];
      const prepared = prepareWallSegmentForInsertion(
        baseWall,
        existingWalls,
        existingRooms,
        this.config
      );
      this.options.addWall(prepared.wall);
    }
    this.options.runDetection();
  }
}
