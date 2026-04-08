import type { Point2D, Wall } from '../types';
import { MIN_WALL_LENGTH } from '../types/wall';
import { SnapManager, type SnapTarget } from '../utils/SnapManager';
import { GeometryEngine } from '../utils/geometry-engine';

export interface KeyModifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface WallEndpointEditDependencies {
  getWalls: () => Wall[];
  updateWall: (id: string, updates: Partial<Wall>) => void;
  connectWalls?: (wallId: string, otherWallId: string) => void;
}

export interface EndpointEditPreview {
  wallId: string;
  endpoint: 'start' | 'end';
  point: Point2D;
  snapped?: SnapTarget | null;
  lengthMm: number;
}

export class WallEndpointEditOperation {
  private wall: Wall;
  private endpoint: 'start' | 'end';
  private deps: WallEndpointEditDependencies;
  private snapManager = new SnapManager();
  private initialWall: Wall;
  private latestPreview: EndpointEditPreview | null = null;

  constructor(
    wall: Wall,
    endpoint: 'start' | 'end',
    deps: WallEndpointEditDependencies
  ) {
    this.wall = wall;
    this.endpoint = endpoint;
    this.deps = deps;
    this.initialWall = { ...wall };
  }

  onDrag(mousePoint: Point2D, modifiers: KeyModifiers): EndpointEditPreview | null {
    const staticPoint = this.endpoint === 'start' ? this.wall.endPoint : this.wall.startPoint;
    let nextPoint = { ...mousePoint };
    let snapped: SnapTarget | null = null;

    if (!modifiers.ctrl) {
      snapped = this.snapManager.findBestSnap({
        point: nextPoint,
        walls: this.deps.getWalls(),
        zoom: 1,
        gridSizeMm: 100,
        snapDistancePx: 10,
        excludeWallId: this.wall.id,
        referencePoint: staticPoint,
      });
      if (snapped) {
        nextPoint = snapped.point;
      }
    }

    if (modifiers.shift) {
      const dx = Math.abs(nextPoint.x - staticPoint.x);
      const dy = Math.abs(nextPoint.y - staticPoint.y);
      nextPoint = dx >= dy ? { x: nextPoint.x, y: staticPoint.y } : { x: staticPoint.x, y: nextPoint.y };
    }

    const lengthMm = GeometryEngine.distance(staticPoint, nextPoint);
    if (lengthMm < MIN_WALL_LENGTH) {
      const direction = GeometryEngine.distance(staticPoint, nextPoint) < 0.001
        ? { x: 1, y: 0 }
        : {
          x: (nextPoint.x - staticPoint.x) / lengthMm,
          y: (nextPoint.y - staticPoint.y) / lengthMm,
        };
      nextPoint = {
        x: staticPoint.x + direction.x * MIN_WALL_LENGTH,
        y: staticPoint.y + direction.y * MIN_WALL_LENGTH,
      };
    }

    this.latestPreview = {
      wallId: this.wall.id,
      endpoint: this.endpoint,
      point: nextPoint,
      snapped,
      lengthMm: GeometryEngine.distance(staticPoint, nextPoint),
    };
    return this.latestPreview;
  }

  commit(): EndpointEditPreview | null {
    if (!this.latestPreview) return null;
    if (this.endpoint === 'start') {
      this.deps.updateWall(this.wall.id, { startPoint: this.latestPreview.point });
    } else {
      this.deps.updateWall(this.wall.id, { endPoint: this.latestPreview.point });
    }
    return this.latestPreview;
  }

  revert(): void {
    this.deps.updateWall(this.wall.id, {
      startPoint: this.initialWall.startPoint,
      endPoint: this.initialWall.endPoint,
    });
  }
}

