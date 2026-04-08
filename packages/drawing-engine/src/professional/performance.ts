/**
 * Performance optimization architecture.
 *
 * Covers:
 * - spatial indexing (R-tree + spatial hash)
 * - viewport culling and LOD helpers
 * - dirty-region invalidation
 * - lazy/memoized derived property evaluation
 */

import { SpatialHash } from '../components/canvas/spatial-hash';
import type { Point2D } from '../types';
import { distance } from '../utils/geometry';
import { PackedRTree, type RTreeBounds } from '../utils/rtree';

import type { Room2D, Wall2D } from './internal-types';

// =============================================================================
// Spatial Indexing
// =============================================================================

export interface ViewportBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface VertexRef {
    id: string;
    point: Point2D;
}

export class FloorPlanSpatialIndex {
    private wallTree = new PackedRTree<Wall2D>((wall) => wallBounds(wall), 16);
    private vertexHash = new SpatialHash<VertexRef>(64);
    private wallsById = new Map<string, Wall2D>();

    rebuild(walls: Wall2D[], vertexTolerance = 0.5): void {
        this.wallsById = new Map(walls.map((wall) => [wall.id, wall]));
        this.wallTree.rebuild(walls);

        const vertices = collectVertices(walls, vertexTolerance);
        this.vertexHash.rebuild(
            vertices.map((vertex) => ({
                id: vertex.id,
                value: vertex,
                minX: vertex.point.x,
                minY: vertex.point.y,
                maxX: vertex.point.x,
                maxY: vertex.point.y,
            }))
        );
    }

    queryWalls(bounds: ViewportBounds): Wall2D[] {
        return this.wallTree.search(bounds);
    }

    queryVerticesNear(point: Point2D, radius: number): VertexRef[] {
        return this.vertexHash
            .queryRadius(point, radius)
            .map((item) => item.value)
            .sort((a, b) => distance(a.point, point) - distance(b.point, point));
    }

    queryNearbyWalls(point: Point2D, radius: number): Wall2D[] {
        const bounds = {
            minX: point.x - radius,
            minY: point.y - radius,
            maxX: point.x + radius,
            maxY: point.y + radius,
        };
        return this.wallTree.search(bounds);
    }
}

// =============================================================================
// Viewport Culling + LOD
// =============================================================================

export type LodLevel = 'coarse' | 'medium' | 'fine';

export interface LodDecision {
    level: LodLevel;
    showWallFill: boolean;
    showWallLayers: boolean;
    showDimensions: boolean;
}

export function computeLodDecision(zoom: number): LodDecision {
    if (zoom < 0.4) {
        return {
            level: 'coarse',
            showWallFill: false,
            showWallLayers: false,
            showDimensions: false,
        };
    }
    if (zoom < 1.2) {
        return {
            level: 'medium',
            showWallFill: true,
            showWallLayers: false,
            showDimensions: true,
        };
    }
    return {
        level: 'fine',
        showWallFill: true,
        showWallLayers: true,
        showDimensions: true,
    };
}

export function cullWallsForViewport(
    walls: Wall2D[],
    viewport: ViewportBounds,
    margin = 0
): Wall2D[] {
    const expanded = expandBounds(viewport, margin);
    return walls.filter((wall) => intersects(wallBounds(wall), expanded));
}

export function cullRoomsForViewport(
    rooms: Room2D[],
    viewport: ViewportBounds,
    margin = 0
): Room2D[] {
    const expanded = expandBounds(viewport, margin);
    return rooms.filter((room) => {
        const bounds = polygonBounds(room.vertices);
        return intersects(bounds, expanded);
    });
}

// =============================================================================
// Dirty Regions + Batch Rendering
// =============================================================================

export class DirtyRegionTracker {
    private regions: RTreeBounds[] = [];

    markDirty(bounds: RTreeBounds): void {
        this.regions.push(bounds);
    }

    markDirtyWall(wall: Wall2D): void {
        this.markDirty(wallBounds(wall));
    }

    consumeMergedRegion(): RTreeBounds | null {
        if (this.regions.length === 0) return null;
        const merged = this.regions.reduce((acc, region) => ({
            minX: Math.min(acc.minX, region.minX),
            minY: Math.min(acc.minY, region.minY),
            maxX: Math.max(acc.maxX, region.maxX),
            maxY: Math.max(acc.maxY, region.maxY),
        }));
        this.regions = [];
        return merged;
    }

    hasDirty(): boolean {
        return this.regions.length > 0;
    }
}

export interface RenderBatch<T> {
    key: string;
    items: T[];
}

export function batchWallsByStyle(walls: Wall2D[]): RenderBatch<Wall2D>[] {
    const byKey = new Map<string, Wall2D[]>();
    walls.forEach((wall) => {
        const key = `${wall.wallType}|${wall.thickness}|${wall.color ?? ''}|${wall.material ?? ''}`;
        const bucket = byKey.get(key) ?? [];
        bucket.push(wall);
        byKey.set(key, bucket);
    });
    return Array.from(byKey.entries()).map(([key, items]) => ({ key, items }));
}

// =============================================================================
// Lazy Evaluation + Memoization
// =============================================================================

export class DerivedValueCache<T> {
    private store = new Map<string, { version: number; value: T }>();

    get(key: string, version: number): T | null {
        const cached = this.store.get(key);
        if (!cached) return null;
        return cached.version === version ? cached.value : null;
    }

    set(key: string, version: number, value: T): void {
        this.store.set(key, { version, value });
    }

    clear(): void {
        this.store.clear();
    }
}

export class LazyFloorPlanMetrics {
    private version = 0;
    private cache = new DerivedValueCache<number>();

    invalidate(): void {
        this.version += 1;
    }

    totalWallLength(walls: Wall2D[]): number {
        const cacheKey = 'total-wall-length';
        const cached = this.cache.get(cacheKey, this.version);
        if (cached != null) return cached;
        const value = walls.reduce((sum, wall) => sum + distance(wall.start, wall.end), 0);
        this.cache.set(cacheKey, this.version, value);
        return value;
    }
}

// =============================================================================
// Utilities
// =============================================================================

function collectVertices(walls: Wall2D[], tolerance: number): VertexRef[] {
    const vertices: VertexRef[] = [];
    const findOrAdd = (point: Point2D): string => {
        for (const vertex of vertices) {
            if (distance(vertex.point, point) <= tolerance) {
                return vertex.id;
            }
        }
        const id = `vertex_${vertices.length + 1}`;
        vertices.push({ id, point: { ...point } });
        return id;
    };

    walls.forEach((wall) => {
        findOrAdd(wall.start);
        findOrAdd(wall.end);
    });
    return vertices;
}

function wallBounds(wall: Wall2D): RTreeBounds {
    const half = Math.max(1, wall.thickness / 2);
    return {
        minX: Math.min(wall.start.x, wall.end.x) - half,
        minY: Math.min(wall.start.y, wall.end.y) - half,
        maxX: Math.max(wall.start.x, wall.end.x) + half,
        maxY: Math.max(wall.start.y, wall.end.y) + half,
    };
}

function polygonBounds(vertices: Point2D[]): RTreeBounds {
    if (vertices.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    vertices.forEach((point) => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    });
    return { minX, minY, maxX, maxY };
}

function expandBounds(bounds: ViewportBounds, margin: number): ViewportBounds {
    return {
        minX: bounds.minX - margin,
        minY: bounds.minY - margin,
        maxX: bounds.maxX + margin,
        maxY: bounds.maxY + margin,
    };
}

function intersects(a: RTreeBounds, b: RTreeBounds): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
