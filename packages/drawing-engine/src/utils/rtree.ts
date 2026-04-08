/**
 * Packed R-tree implementation for wall collision and hit testing queries.
 *
 * This implementation favors fast search and simple rebuilds. It packs the tree
 * on rebuild (STR-style chunking) which is well-suited to editor workloads where
 * many edits happen in batches and then queries dominate.
 */

// =============================================================================
// Types
// =============================================================================

export interface RTreeBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface RTreeEntry<T> extends RTreeBounds {
    id: string;
    value: T;
}

interface RTreeNode<T> {
    leaf: boolean;
    height: number;
    bounds: RTreeBounds;
    children: Array<RTreeNode<T> | RTreeEntry<T>>;
}

// =============================================================================
// Bounds Utilities
// =============================================================================

export function boundsIntersect(a: RTreeBounds, b: RTreeBounds): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function inflateBounds(bounds: RTreeBounds, padding: number): RTreeBounds {
    if (!Number.isFinite(padding) || padding <= 0) return { ...bounds };
    return {
        minX: bounds.minX - padding,
        minY: bounds.minY - padding,
        maxX: bounds.maxX + padding,
        maxY: bounds.maxY + padding,
    };
}

function emptyBounds(): RTreeBounds {
    return {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
    };
}

function mergeBounds(a: RTreeBounds, b: RTreeBounds): RTreeBounds {
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
    };
}

function centerX(bounds: RTreeBounds): number {
    return (bounds.minX + bounds.maxX) / 2;
}

function centerY(bounds: RTreeBounds): number {
    return (bounds.minY + bounds.maxY) / 2;
}

function spreadX(bounds: RTreeBounds): number {
    return bounds.maxX - bounds.minX;
}

function spreadY(bounds: RTreeBounds): number {
    return bounds.maxY - bounds.minY;
}

function isFiniteBounds(bounds: RTreeBounds): boolean {
    return (
        Number.isFinite(bounds.minX) &&
        Number.isFinite(bounds.minY) &&
        Number.isFinite(bounds.maxX) &&
        Number.isFinite(bounds.maxY)
    );
}

function calculateNodeBounds<T>(children: Array<RTreeNode<T> | RTreeEntry<T>>): RTreeBounds {
    if (children.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    let bounds = emptyBounds();
    children.forEach((child) => {
        const source = isNode(child) ? child.bounds : child;
        bounds = mergeBounds(bounds, source);
    });
    return isFiniteBounds(bounds) ? bounds : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

function isNode<T>(value: RTreeNode<T> | RTreeEntry<T>): value is RTreeNode<T> {
    return 'children' in value;
}

// =============================================================================
// Packed R-tree
// =============================================================================

export class PackedRTree<T extends { id: string }> {
    private root: RTreeNode<T> | null = null;

    constructor(
        private readonly getBounds: (item: T) => RTreeBounds,
        private readonly maxEntries = 16
    ) {}

    clear(): void {
        this.root = null;
    }

    isEmpty(): boolean {
        return this.root === null;
    }

    rebuild(items: T[]): void {
        if (items.length === 0) {
            this.root = null;
            return;
        }

        const entries = items.map((item) => {
            const bounds = this.getBounds(item);
            return {
                id: item.id,
                value: item,
                minX: bounds.minX,
                minY: bounds.minY,
                maxX: bounds.maxX,
                maxY: bounds.maxY,
            } satisfies RTreeEntry<T>;
        });

        const cappedMaxEntries = Math.max(4, this.maxEntries);
        let level: RTreeNode<T>[] = entries.map((entry) => ({
            leaf: true,
            height: 1,
            bounds: {
                minX: entry.minX,
                minY: entry.minY,
                maxX: entry.maxX,
                maxY: entry.maxY,
            },
            children: [entry],
        }));

        while (level.length > 1) {
            level = this.packLevel(level, cappedMaxEntries);
        }

        this.root = level[0] ?? null;
    }

    search(bounds: RTreeBounds): T[] {
        const root = this.root;
        if (!root || !boundsIntersect(root.bounds, bounds)) return [];

        const results: T[] = [];
        const stack: RTreeNode<T>[] = [root];

        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;
            if (!boundsIntersect(node.bounds, bounds)) continue;

            if (node.leaf) {
                node.children.forEach((child) => {
                    const entry = child as RTreeEntry<T>;
                    if (boundsIntersect(entry, bounds)) {
                        results.push(entry.value);
                    }
                });
                continue;
            }

            node.children.forEach((child) => {
                const childNode = child as RTreeNode<T>;
                if (boundsIntersect(childNode.bounds, bounds)) {
                    stack.push(childNode);
                }
            });
        }

        return results;
    }

    all(): T[] {
        const root = this.root;
        if (!root) return [];
        const values: T[] = [];
        const stack: RTreeNode<T>[] = [root];

        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;
            if (node.leaf) {
                node.children.forEach((child) => {
                    values.push((child as RTreeEntry<T>).value);
                });
                continue;
            }
            node.children.forEach((child) => {
                stack.push(child as RTreeNode<T>);
            });
        }

        return values;
    }

    private packLevel(nodes: RTreeNode<T>[], maxEntries: number): RTreeNode<T>[] {
        if (nodes.length <= maxEntries) {
            return [
                {
                    leaf: false,
                    height: (nodes[0]?.height ?? 0) + 1,
                    bounds: calculateNodeBounds(nodes),
                    children: nodes,
                },
            ];
        }

        const levelBounds = calculateNodeBounds(nodes);
        const useX = spreadX(levelBounds) >= spreadY(levelBounds);
        const sorted = [...nodes].sort((a, b) =>
            useX ? centerX(a.bounds) - centerX(b.bounds) : centerY(a.bounds) - centerY(b.bounds)
        );

        const parents: RTreeNode<T>[] = [];
        for (let index = 0; index < sorted.length; index += maxEntries) {
            const children = sorted.slice(index, index + maxEntries);
            parents.push({
                leaf: false,
                height: (children[0]?.height ?? 0) + 1,
                bounds: calculateNodeBounds(children),
                children,
            });
        }

        return parents;
    }
}
