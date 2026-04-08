/**
 * Spatial hash index for fast proximity and region queries in interaction code.
 *
 * This is optimized for editor interaction loops where query cost matters more
 * than incremental update complexity. Rebuilding per interaction frame is cheap
 * for typical floor plan sizes.
 */

import type { Point2D } from '../../types';

export interface HashBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface SpatialHashItem<T> extends HashBounds {
    id: string;
    value: T;
}

export class SpatialHash<T> {
    private cells = new Map<string, SpatialHashItem<T>[]>();
    private items = new Map<string, SpatialHashItem<T>>();

    constructor(private readonly cellSize = 64) {}

    clear(): void {
        this.cells.clear();
        this.items.clear();
    }

    rebuild(items: SpatialHashItem<T>[]): void {
        this.clear();
        items.forEach((item) => this.insert(item));
    }

    insert(item: SpatialHashItem<T>): void {
        this.items.set(item.id, item);
        const coveredCells = getCoveredCells(item, this.cellSize);
        coveredCells.forEach((cellKey) => {
            const bucket = this.cells.get(cellKey);
            if (bucket) {
                bucket.push(item);
            } else {
                this.cells.set(cellKey, [item]);
            }
        });
    }

    queryBounds(bounds: HashBounds): SpatialHashItem<T>[] {
        const result = new Map<string, SpatialHashItem<T>>();
        const coveredCells = getCoveredCells(bounds, this.cellSize);
        coveredCells.forEach((cellKey) => {
            const bucket = this.cells.get(cellKey);
            if (!bucket) return;
            bucket.forEach((item) => {
                if (!boundsIntersect(item, bounds)) return;
                result.set(item.id, item);
            });
        });
        return Array.from(result.values());
    }

    queryRadius(point: Point2D, radius: number): SpatialHashItem<T>[] {
        return this.queryBounds({
            minX: point.x - radius,
            minY: point.y - radius,
            maxX: point.x + radius,
            maxY: point.y + radius,
        });
    }

    all(): SpatialHashItem<T>[] {
        return Array.from(this.items.values());
    }
}

export function boundsIntersect(a: HashBounds, b: HashBounds): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function pointBounds(point: Point2D, radius = 0): HashBounds {
    return {
        minX: point.x - radius,
        minY: point.y - radius,
        maxX: point.x + radius,
        maxY: point.y + radius,
    };
}

export function getCoveredCells(bounds: HashBounds, cellSize: number): string[] {
    const minCellX = Math.floor(bounds.minX / cellSize);
    const maxCellX = Math.floor(bounds.maxX / cellSize);
    const minCellY = Math.floor(bounds.minY / cellSize);
    const maxCellY = Math.floor(bounds.maxY / cellSize);

    const cells: string[] = [];
    for (let x = minCellX; x <= maxCellX; x++) {
        for (let y = minCellY; y <= maxCellY; y++) {
            cells.push(`${x}:${y}`);
        }
    }
    return cells;
}
