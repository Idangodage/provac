/**
 * WallManager
 *
 * Business logic for wall operations.
 * Manages wall CRUD, connections, and spatial queries.
 */

import type { Point2D, Wall } from '../../../types';

import { wallBounds } from './WallGeometry';

// =============================================================================
// Types
// =============================================================================

export interface WallQueryResult {
  wall: Wall;
  distance: number;
}

export interface EndpointQuery {
  wall: Wall;
  endpoint: 'start' | 'end';
  point: Point2D;
  distance: number;
}

// =============================================================================
// WallManager Class
// =============================================================================

export class WallManager {
  private walls: Map<string, Wall> = new Map();

  /**
   * Set walls from external state
   */
  setWalls(walls: Wall[]): void {
    this.walls.clear();
    for (const wall of walls) {
      this.walls.set(wall.id, wall);
    }
  }

  /**
   * Get all walls
   */
  getAllWalls(): Wall[] {
    return Array.from(this.walls.values());
  }

  /**
   * Get wall by ID
   */
  getWall(id: string): Wall | undefined {
    return this.walls.get(id);
  }

  /**
   * Find walls at a point (within tolerance)
   */
  findWallsAtPoint(point: Point2D, tolerance: number): WallQueryResult[] {
    const results: WallQueryResult[] = [];

    for (const wall of this.walls.values()) {
      const dist = this.distanceToWall(point, wall);
      if (dist <= tolerance) {
        results.push({ wall, distance: dist });
      }
    }

    // Sort by distance
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  /**
   * Find nearest wall endpoint
   */
  findNearestEndpoint(
    point: Point2D,
    tolerance: number,
    excludeWallId?: string
  ): EndpointQuery | null {
    let nearest: EndpointQuery | null = null;
    let minDist = tolerance;

    for (const wall of this.walls.values()) {
      if (wall.id === excludeWallId) continue;

      const distToStart = this.distance(point, wall.startPoint);
      const distToEnd = this.distance(point, wall.endPoint);

      if (distToStart < minDist) {
        minDist = distToStart;
        nearest = {
          wall,
          endpoint: 'start',
          point: wall.startPoint,
          distance: distToStart,
        };
      }

      if (distToEnd < minDist) {
        minDist = distToEnd;
        nearest = {
          wall,
          endpoint: 'end',
          point: wall.endPoint,
          distance: distToEnd,
        };
      }
    }

    return nearest;
  }

  /**
   * Find walls within a bounding box
   */
  queryBounds(bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }): Wall[] {
    const results: Wall[] = [];

    for (const wall of this.walls.values()) {
      const wallBox = wallBounds(wall);

      // Check for overlap
      if (
        wallBox.maxX >= bounds.minX &&
        wallBox.minX <= bounds.maxX &&
        wallBox.maxY >= bounds.minY &&
        wallBox.minY <= bounds.maxY
      ) {
        results.push(wall);
      }
    }

    return results;
  }

  /**
   * Get walls connected to a specific wall
   */
  getConnectedWalls(wallId: string): Wall[] {
    const wall = this.walls.get(wallId);
    if (!wall) return [];

    return wall.connectedWalls
      .map((id) => this.walls.get(id))
      .filter((w): w is Wall => w !== undefined);
  }

  /**
   * Find walls that share an endpoint
   */
  findWallsSharingEndpoint(point: Point2D, tolerance: number = 0.1): Wall[] {
    const results: Wall[] = [];

    for (const wall of this.walls.values()) {
      const distToStart = this.distance(point, wall.startPoint);
      const distToEnd = this.distance(point, wall.endPoint);

      if (distToStart <= tolerance || distToEnd <= tolerance) {
        results.push(wall);
      }
    }

    return results;
  }

  /**
   * Get total wall count
   */
  getWallCount(): number {
    return this.walls.size;
  }

  /**
   * Check if wall exists
   */
  hasWall(id: string): boolean {
    return this.walls.has(id);
  }

  /**
   * Clear all walls
   */
  clear(): void {
    this.walls.clear();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Distance from point to wall center-line
   */
  private distanceToWall(point: Point2D, wall: Wall): number {
    return this.distancePointToSegment(point, wall.startPoint, wall.endPoint);
  }

  /**
   * Distance between two points
   */
  private distance(a: Point2D, b: Point2D): number {
    return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  }

  /**
   * Distance from point to line segment
   */
  private distancePointToSegment(
    point: Point2D,
    start: Point2D,
    end: Point2D
  ): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
      return this.distance(point, start);
    }

    let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    const closestX = start.x + t * dx;
    const closestY = start.y + t * dy;

    return Math.sqrt((point.x - closestX) ** 2 + (point.y - closestY) ** 2);
  }
}
