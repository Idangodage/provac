import type { Point2D, Wall } from '../types';

import { GeometryEngine } from './geometry-engine';

export enum SnapType {
  GRID = 'grid',
  ENDPOINT = 'endpoint',
  MIDPOINT = 'midpoint',
  INTERSECTION = 'intersection',
  PERPENDICULAR = 'perpendicular',
}

export interface SnapTarget {
  type: SnapType;
  point: Point2D;
  distance: number;
  wallId?: string;
  visual: {
    indicator: 'circle' | 'square' | 'triangle' | 'cross';
    color: string;
    label?: string;
  };
}

export interface SnapContext {
  point: Point2D;
  walls: Wall[];
  zoom: number;
  gridSizeMm: number;
  enableGridSnap?: boolean;
  includeEndpointSnap?: boolean;
  includeMidpointSnap?: boolean;
  includeIntersectionSnap?: boolean;
  includePerpendicularSnap?: boolean;
  snapDistancePx: number;
  excludeWallId?: string;
  referencePoint?: Point2D;
}

export class SnapManager {
  findBestSnap(context: SnapContext): SnapTarget | null {
    const candidates = this.collectCandidates(context);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0] ?? null;
  }

  collectCandidates(context: SnapContext): SnapTarget[] {
    const candidates: SnapTarget[] = [];
    if (context.enableGridSnap !== false) {
      candidates.push(...this.getGridSnap(context));
    }
    if (context.includeEndpointSnap !== false) {
      candidates.push(...this.getEndpointSnaps(context));
    }
    if (context.includeMidpointSnap !== false) {
      candidates.push(...this.getMidpointSnaps(context));
    }
    if (context.includeIntersectionSnap !== false) {
      candidates.push(...this.getIntersectionSnaps(context));
    }
    if (context.includePerpendicularSnap !== false) {
      candidates.push(...this.getPerpendicularSnaps(context));
    }
    return candidates.filter((candidate) => candidate.distance <= this.snapDistanceMm(context));
  }

  private snapDistanceMm(context: SnapContext): number {
    // px -> mm in scene space; fallback keeps snapping predictable if zoom becomes invalid.
    return Math.max(1, context.snapDistancePx / Math.max(context.zoom, 0.01) / 3.7795);
  }

  private getGridSnap(context: SnapContext): SnapTarget[] {
    const step = Math.max(1, context.gridSizeMm);
    const snapped = {
      x: Math.round(context.point.x / step) * step,
      y: Math.round(context.point.y / step) * step,
    };
    return [
      {
        type: SnapType.GRID,
        point: snapped,
        distance: GeometryEngine.distance(context.point, snapped),
        visual: {
          indicator: 'circle',
          color: '#10B981',
          label: 'Grid',
        },
      },
    ];
  }

  private getEndpointSnaps(context: SnapContext): SnapTarget[] {
    const snaps: SnapTarget[] = [];
    context.walls.forEach((wall) => {
      if (wall.id === context.excludeWallId) return;
      snaps.push(
        {
          type: SnapType.ENDPOINT,
          point: { ...wall.startPoint },
          distance: GeometryEngine.distance(context.point, wall.startPoint),
          wallId: wall.id,
          visual: {
            indicator: 'square',
            color: '#EC4899',
            label: 'End',
          },
        },
        {
          type: SnapType.ENDPOINT,
          point: { ...wall.endPoint },
          distance: GeometryEngine.distance(context.point, wall.endPoint),
          wallId: wall.id,
          visual: {
            indicator: 'square',
            color: '#EC4899',
            label: 'End',
          },
        }
      );
    });
    return snaps;
  }

  private getMidpointSnaps(context: SnapContext): SnapTarget[] {
    const snaps: SnapTarget[] = [];
    context.walls.forEach((wall) => {
      if (wall.id === context.excludeWallId) return;
      const midpoint = {
        x: (wall.startPoint.x + wall.endPoint.x) / 2,
        y: (wall.startPoint.y + wall.endPoint.y) / 2,
      };
      snaps.push({
        type: SnapType.MIDPOINT,
        point: midpoint,
        distance: GeometryEngine.distance(context.point, midpoint),
        wallId: wall.id,
        visual: {
          indicator: 'triangle',
          color: '#F59E0B',
          label: 'Mid',
        },
      });
    });
    return snaps;
  }

  private getIntersectionSnaps(context: SnapContext): SnapTarget[] {
    const snaps: SnapTarget[] = [];
    for (let i = 0; i < context.walls.length; i += 1) {
      const wallA = context.walls[i];
      if (wallA.id === context.excludeWallId) continue;
      for (let j = i + 1; j < context.walls.length; j += 1) {
        const wallB = context.walls[j];
        if (wallB.id === context.excludeWallId) continue;
        const intersections = GeometryEngine.findIntersections(wallA, wallB);
        intersections.forEach((intersection) => {
          snaps.push({
            type: SnapType.INTERSECTION,
            point: intersection,
            distance: GeometryEngine.distance(context.point, intersection),
            visual: {
              indicator: 'cross',
              color: '#0EA5E9',
              label: 'Int',
            },
          });
        });
      }
    }
    return snaps;
  }

  private getPerpendicularSnaps(context: SnapContext): SnapTarget[] {
    if (!context.referencePoint) return [];
    const snaps: SnapTarget[] = [];
    context.walls.forEach((wall) => {
      if (wall.id === context.excludeWallId) return;
      const snapped = GeometryEngine.snapToWall(context.point, wall);
      const along = {
        x: snapped.x - context.referencePoint!.x,
        y: snapped.y - context.referencePoint!.y,
      };
      const wallVec = {
        x: wall.endPoint.x - wall.startPoint.x,
        y: wall.endPoint.y - wall.startPoint.y,
      };
      const dot = along.x * wallVec.x + along.y * wallVec.y;
      const lengthProduct = Math.hypot(along.x, along.y) * Math.hypot(wallVec.x, wallVec.y);
      if (lengthProduct < 0.0001) return;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot / lengthProduct))) * (180 / Math.PI);
      const perpendicularError = Math.min(Math.abs(angle - 90), Math.abs(angle - 270));
      if (perpendicularError > 12) return;
      snaps.push({
        type: SnapType.PERPENDICULAR,
        point: snapped,
        distance: GeometryEngine.distance(context.point, snapped),
        wallId: wall.id,
        visual: {
          indicator: 'cross',
          color: '#2563EB',
          label: 'Perp',
        },
      });
    });
    return snaps;
  }
}
