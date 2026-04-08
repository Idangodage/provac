import type { Point2D, Wall } from '../types';
import { GeometryEngine } from '../utils/geometry-engine';

export interface RotationModifiers {
  shift: boolean;
  ctrl: boolean;
}

export interface RotationPreview {
  wallId: string;
  startPoint: Point2D;
  endPoint: Point2D;
  absoluteAngleDeg: number;
  deltaAngleDeg: number;
}

export interface WallRotationDependencies {
  updateWall: (id: string, updates: Partial<Wall>) => void;
}

function rotateAround(point: Point2D, center: Point2D, angleRad: number): Point2D {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return {
    x: center.x + dx * c - dy * s,
    y: center.y + dx * s + dy * c,
  };
}

export class WallRotationOperation {
  private wall: Wall;
  private deps: WallRotationDependencies;
  private center: Point2D;
  private initialAngleDeg: number;
  private preview: RotationPreview | null = null;

  constructor(wall: Wall, deps: WallRotationDependencies) {
    this.wall = wall;
    this.deps = deps;
    this.center = {
      x: (wall.startPoint.x + wall.endPoint.x) / 2,
      y: (wall.startPoint.y + wall.endPoint.y) / 2,
    };
    this.initialAngleDeg =
      (Math.atan2(
        wall.endPoint.y - wall.startPoint.y,
        wall.endPoint.x - wall.startPoint.x
      ) * 180) / Math.PI;
  }

  onDrag(mousePoint: Point2D, modifiers: RotationModifiers): RotationPreview {
    const rawAngle =
      (Math.atan2(mousePoint.y - this.center.y, mousePoint.x - this.center.x) * 180) / Math.PI;
    let targetAngle = rawAngle;

    if (modifiers.shift || modifiers.ctrl) {
      const increment = modifiers.ctrl ? 45 : 15;
      targetAngle = Math.round(rawAngle / increment) * increment;
    }

    const delta = targetAngle - this.initialAngleDeg;
    const angleRad = (delta * Math.PI) / 180;
    const startPoint = rotateAround(this.wall.startPoint, this.center, angleRad);
    const endPoint = rotateAround(this.wall.endPoint, this.center, angleRad);

    this.preview = {
      wallId: this.wall.id,
      startPoint,
      endPoint,
      absoluteAngleDeg: targetAngle,
      deltaAngleDeg: delta,
    };
    return this.preview;
  }

  commit(): RotationPreview | null {
    if (!this.preview) return null;
    const length = GeometryEngine.distance(this.preview.startPoint, this.preview.endPoint);
    if (length < 1) return null;
    this.deps.updateWall(this.wall.id, {
      startPoint: this.preview.startPoint,
      endPoint: this.preview.endPoint,
    });
    return this.preview;
  }
}
