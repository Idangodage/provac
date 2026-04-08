/**
 * Opening Placement Hook
 *
 * Encapsulates all opening (door/window) placement logic previously
 * inlined in DrawingCanvas: width/height resolution, wall fitting,
 * collision detection, placement computation, opening sync, and the
 * final place-pending-object action.
 */

import { useCallback, useMemo } from 'react';

import type { ArchitecturalObjectDefinition } from '../../../data';
import type { Point2D, Room, SymbolInstance2D, Wall, WallSettings } from '../../../types';
import { resolveHostedDoorSwingProperties } from '../../../utils/doorSwing';
import { MIN_OPENING_EDGE_MARGIN_MM } from '../../DrawingCanvas.types';
import { SpatialHash } from '../spatial-hash';
import type { PointProjection, WallPlacementSnap } from './useGeometryHelpers';

// ---------------------------------------------------------------------------
// Options / Return types
// ---------------------------------------------------------------------------

export interface UseOpeningPlacementOptions {
    // Geometry helpers (from useGeometryHelpers)
    findWallPlacementSnap: (point: Point2D) => (WallPlacementSnap & { positionAlongWall?: number }) | null;
    projectPointToSegment: (point: Point2D, start: Point2D, end: Point2D) => PointProjection;

    // State slices
    walls: Wall[];
    rooms: Room[];
    symbols: SymbolInstance2D[];
    objectDefinitionsById: Map<string, ArchitecturalObjectDefinition>;
    resolvedSnapToGrid: boolean;
    wallSettings: WallSettings;
    placementRotationDeg: number;
    pendingPlacementDefinition: ArchitecturalObjectDefinition | null;

    // Store actions
    addSymbol: (payload: Omit<SymbolInstance2D, 'id'>) => string;
    updateWall: (
        id: string,
        changes: Partial<Wall>,
        options?: { skipHistory?: boolean; source?: 'ui' | 'drag'; skipRoomDetection?: boolean }
    ) => void;
    updateSymbol: (id: string, changes: Partial<SymbolInstance2D>, options?: { skipHistory?: boolean }) => void;
    setSelectedIds: (ids: string[]) => void;
    setProcessingStatus: (message: string, isProcessing: boolean) => void;

    // Props / callbacks
    onObjectPlaced?: (definitionId: string, instance: SymbolInstance2D) => void;
    setPlacementValid: (valid: boolean) => void;
}

export interface UseOpeningPlacementResult {
    resolveOpeningWidthMm: (
        definition: ArchitecturalObjectDefinition,
        properties?: Record<string, unknown>
    ) => number;
    resolveOpeningHeightMm: (
        definition: ArchitecturalObjectDefinition,
        properties?: Record<string, unknown>
    ) => number;
    resolveOpeningSillHeightMm: (
        definition: ArchitecturalObjectDefinition,
        properties?: Record<string, unknown>
    ) => number;
    fitOpeningToWall: (
        wall: Wall,
        opening: { position: number; width: number }
    ) => { position: number; width: number };
    collisionBounds: (
        center: Point2D,
        widthMm: number,
        depthMm: number
    ) => { minX: number; maxX: number; minY: number; maxY: number };
    objectsOverlap: (
        a: { minX: number; maxX: number; minY: number; maxY: number },
        b: { minX: number; maxX: number; minY: number; maxY: number }
    ) => boolean;
    hasFurnitureCollision: (
        targetPoint: Point2D,
        definition: ArchitecturalObjectDefinition,
        options?: { ignoreSymbolId?: string }
    ) => boolean;
    computePlacement: (
        point: Point2D,
        definition: ArchitecturalObjectDefinition,
        options?: { ignoreSymbolId?: string; ignoreOpeningId?: string; openingWidthMm?: number }
    ) => {
        point: Point2D;
        rotationDeg: number;
        snappedWall: (WallPlacementSnap & { positionAlongWall: number }) | null;
        alignmentPoint: Point2D | null;
        valid: boolean;
    };
    syncOpeningForSymbol: (
        symbolId: string,
        definition: ArchitecturalObjectDefinition,
        snappedWall: { wall: Wall; positionAlongWall: number },
        overrides?: { openingWidthMm?: number; openingHeightMm?: number; sillHeightMm?: number }
    ) => void;
    buildHostedOpeningSymbolProperties: (
        definition: ArchitecturalObjectDefinition,
        wall: Wall,
        positionAlongWallMm: number,
        sourceProperties: Record<string, unknown> | undefined,
        openingWidthMm: number,
        openingHeightMm: number,
        openingSillHeightMm: number
    ) => Record<string, unknown>;
    buildOpeningPreviewProperties: (
        definition: ArchitecturalObjectDefinition,
        snappedWall?: { wall: Wall; positionAlongWall: number } | null
    ) => Record<string, unknown> | undefined;
    placePendingObject: (point: Point2D) => boolean;
}

const FURNITURE_COLLISION_INDEX_CELL_MM = 1600;

interface CollisionIndexedSymbol {
    instance: SymbolInstance2D;
    definition: ArchitecturalObjectDefinition;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOpeningPlacement(options: UseOpeningPlacementOptions): UseOpeningPlacementResult {
    const {
        findWallPlacementSnap,
        walls,
        rooms,
        symbols,
        objectDefinitionsById,
        resolvedSnapToGrid,
        wallSettings,
        placementRotationDeg,
        pendingPlacementDefinition,
        addSymbol,
        updateWall,
        setSelectedIds,
        setProcessingStatus,
        onObjectPlaced,
        setPlacementValid,
    } = options;

    const furnitureCollisionIndex = useMemo(() => {
        const index = new SpatialHash<CollisionIndexedSymbol>(FURNITURE_COLLISION_INDEX_CELL_MM);
        index.rebuild(
            symbols.flatMap((instance) => {
                const definition = objectDefinitionsById.get(instance.symbolId);
                if (!definition) {
                    return [];
                }
                if (definition.category !== 'furniture' && definition.category !== 'fixtures') {
                    return [];
                }
                const halfWidth = definition.widthMm / 2;
                const halfDepth = definition.depthMm / 2;
                return [{
                    id: instance.id,
                    value: { instance, definition },
                    minX: instance.position.x - halfWidth,
                    maxX: instance.position.x + halfWidth,
                    minY: instance.position.y - halfDepth,
                    maxY: instance.position.y + halfDepth,
                }];
            })
        );
        return index;
    }, [symbols, objectDefinitionsById]);

    const openingHostWallById = useMemo(() => {
        const next = new Map<string, Wall>();
        walls.forEach((wall) => {
            wall.openings.forEach((opening) => {
                next.set(opening.id, wall);
            });
        });
        return next;
    }, [walls]);

    const canHostOpeningOnWall = useCallback((wall: Wall): boolean => {
        return wall.partitionMode !== 'half';
    }, []);

    // -----------------------------------------------------------------------
    // resolveOpeningWidthMm
    // -----------------------------------------------------------------------

    const resolveOpeningWidthMm = useCallback(
        (
            definition: ArchitecturalObjectDefinition,
            properties?: Record<string, unknown>
        ): number => {
            const fromProperties =
                typeof properties?.widthMm === 'number' && Number.isFinite(properties.widthMm)
                    ? properties.widthMm
                    : null;
            return Math.max(1, fromProperties ?? definition.openingWidthMm ?? definition.widthMm);
        },
        []
    );

    // -----------------------------------------------------------------------
    // resolveOpeningHeightMm
    // -----------------------------------------------------------------------

    const resolveOpeningHeightMm = useCallback(
        (
            definition: ArchitecturalObjectDefinition,
            properties?: Record<string, unknown>
        ): number => {
            const fromProperties =
                typeof properties?.heightMm === 'number' && Number.isFinite(properties.heightMm)
                    ? properties.heightMm
                    : null;
            return Math.max(1, fromProperties ?? definition.heightMm);
        },
        []
    );

    // -----------------------------------------------------------------------
    // resolveOpeningSillHeightMm
    // -----------------------------------------------------------------------

    const resolveOpeningSillHeightMm = useCallback(
        (
            definition: ArchitecturalObjectDefinition,
            properties?: Record<string, unknown>
        ): number => {
            if (definition.category !== 'windows') return 0;
            const fromProperties =
                typeof properties?.sillHeightMm === 'number' && Number.isFinite(properties.sillHeightMm)
                    ? properties.sillHeightMm
                    : null;
            return Math.max(0, fromProperties ?? definition.sillHeightMm ?? 900);
        },
        []
    );

    // -----------------------------------------------------------------------
    // fitOpeningToWall
    // -----------------------------------------------------------------------

    const fitOpeningToWall = useCallback(
        (wall: Wall, opening: { position: number; width: number }): { position: number; width: number } => {
            const wallLength = Math.hypot(
                wall.endPoint.x - wall.startPoint.x,
                wall.endPoint.y - wall.startPoint.y
            );
            if (!Number.isFinite(wallLength) || wallLength <= 0.001) {
                return { position: 0, width: Math.max(120, opening.width) };
            }

            const maxWidth = Math.max(120, wallLength - MIN_OPENING_EDGE_MARGIN_MM * 2);
            const fittedWidth = Math.max(120, Math.min(opening.width, maxWidth));
            const halfWidth = fittedWidth / 2;
            const minPosition = MIN_OPENING_EDGE_MARGIN_MM + halfWidth;
            const maxPosition = wallLength - MIN_OPENING_EDGE_MARGIN_MM - halfWidth;
            const fittedPosition =
                minPosition <= maxPosition
                    ? Math.min(Math.max(opening.position, minPosition), maxPosition)
                    : wallLength / 2;

            return {
                position: fittedPosition,
                width: fittedWidth,
            };
        },
        []
    );

    // -----------------------------------------------------------------------
    // collisionBounds
    // -----------------------------------------------------------------------

    const collisionBounds = useCallback((
        center: Point2D,
        widthMm: number,
        depthMm: number
    ) => ({
        minX: center.x - widthMm / 2,
        maxX: center.x + widthMm / 2,
        minY: center.y - depthMm / 2,
        maxY: center.y + depthMm / 2,
    }), []);

    // -----------------------------------------------------------------------
    // objectsOverlap
    // -----------------------------------------------------------------------

    const objectsOverlap = useCallback(
        (
            a: ReturnType<typeof collisionBounds>,
            b: ReturnType<typeof collisionBounds>
        ) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY,
        []
    );

    // -----------------------------------------------------------------------
    // hasFurnitureCollision
    // -----------------------------------------------------------------------

    const hasFurnitureCollision = useCallback(
        (
            targetPoint: Point2D,
            definition: ArchitecturalObjectDefinition,
            collisionOptions?: { ignoreSymbolId?: string }
        ): boolean => {
            if (definition.category !== 'furniture' && definition.category !== 'fixtures') {
                return false;
            }
            const targetBounds = collisionBounds(targetPoint, definition.widthMm, definition.depthMm);
            const candidates = furnitureCollisionIndex.queryBounds(targetBounds);
            for (const candidate of candidates) {
                const { instance, definition: instanceDefinition } = candidate.value;
                if (collisionOptions?.ignoreSymbolId && instance.id === collisionOptions.ignoreSymbolId) {
                    continue;
                }
                const existingBounds = collisionBounds(
                    instance.position,
                    instanceDefinition.widthMm,
                    instanceDefinition.depthMm
                );
                if (objectsOverlap(targetBounds, existingBounds)) {
                    return true;
                }
            }
            return false;
        },
        [collisionBounds, furnitureCollisionIndex, objectsOverlap]
    );

    // -----------------------------------------------------------------------
    // computePlacement
    // -----------------------------------------------------------------------

    const computePlacement = useCallback(
        (
            point: Point2D,
            definition: ArchitecturalObjectDefinition,
            computeOptions?: { ignoreSymbolId?: string; ignoreOpeningId?: string; openingWidthMm?: number }
        ) => {
            let placementPoint = { ...point };
            let rotationDeg = placementRotationDeg;
            let snappedWall: (WallPlacementSnap & { positionAlongWall: number }) | null = null;
            const alignmentPoint: Point2D | null = null;
            let openingPlacementValid = true;

            if (definition.category === 'doors' || definition.category === 'windows') {
                const wallSnap = findWallPlacementSnap(point);
                if (wallSnap) {
                    const openingWidth =
                        typeof computeOptions?.openingWidthMm === 'number' && Number.isFinite(computeOptions.openingWidthMm)
                            ? Math.max(1, computeOptions.openingWidthMm)
                            : definition.openingWidthMm ?? definition.widthMm;
                    const edgeClearance = openingWidth / 2 + MIN_OPENING_EDGE_MARGIN_MM;
                    const unclampedPositionAlongWall = wallSnap.t * wallSnap.wallLength;
                    const clampedPositionAlongWall = Math.min(
                        Math.max(unclampedPositionAlongWall, edgeClearance),
                        wallSnap.wallLength - edgeClearance
                    );
                    const clampedT = wallSnap.wallLength > 0
                        ? clampedPositionAlongWall / wallSnap.wallLength
                        : 0.5;
                    placementPoint = {
                        x: wallSnap.wall.startPoint.x + (wallSnap.wall.endPoint.x - wallSnap.wall.startPoint.x) * clampedT,
                        y: wallSnap.wall.startPoint.y + (wallSnap.wall.endPoint.y - wallSnap.wall.startPoint.y) * clampedT,
                    };
                    rotationDeg = wallSnap.angleDeg;

                    const overlapsExistingOpening = wallSnap.wall.openings.some((existing) => {
                        if (computeOptions?.ignoreOpeningId && existing.id === computeOptions.ignoreOpeningId) {
                            return false;
                        }
                        const requiredGap =
                            existing.width / 2 + openingWidth / 2 + MIN_OPENING_EDGE_MARGIN_MM;
                        return Math.abs(existing.position - clampedPositionAlongWall) < requiredGap;
                    });
                    const fitsSegment =
                        wallSnap.wallLength >= openingWidth + MIN_OPENING_EDGE_MARGIN_MM * 2;
                    const supportsOpening = canHostOpeningOnWall(wallSnap.wall);
                    openingPlacementValid = fitsSegment && !overlapsExistingOpening && supportsOpening;

                    snappedWall = {
                        ...wallSnap,
                        t: clampedT,
                        positionAlongWall: clampedPositionAlongWall,
                    };
                } else {
                    openingPlacementValid = false;
                }
            } else if (definition.category === 'furniture' || definition.category === 'fixtures') {
                // Keep furniture/fixture placement free-form to avoid sticky cursor behavior.
                placementPoint = { ...point };
            }

            const isFurnitureLike =
                definition.category === 'furniture' || definition.category === 'fixtures';
            if (resolvedSnapToGrid && !snappedWall && !isFurnitureLike) {
                const gridStep = Math.max(1, wallSettings.gridSize);
                placementPoint = {
                    x: Math.round(placementPoint.x / gridStep) * gridStep,
                    y: Math.round(placementPoint.y / gridStep) * gridStep,
                };
            }

            const collision = hasFurnitureCollision(
                placementPoint,
                definition,
                computeOptions?.ignoreSymbolId ? { ignoreSymbolId: computeOptions.ignoreSymbolId } : undefined
            );
            const valid = !collision && openingPlacementValid;

            return {
                point: placementPoint,
                rotationDeg,
                snappedWall,
                alignmentPoint,
                valid,
            };
        },
        [
            placementRotationDeg,
            findWallPlacementSnap,
            canHostOpeningOnWall,
            rooms,
            symbols,
            objectDefinitionsById,
            hasFurnitureCollision,
            resolvedSnapToGrid,
            wallSettings.gridSize,
        ]
    );

    // -----------------------------------------------------------------------
    // syncOpeningForSymbol
    // -----------------------------------------------------------------------

    const syncOpeningForSymbol = useCallback(
        (
            symbolId: string,
            definition: ArchitecturalObjectDefinition,
            snappedWall: { wall: Wall; positionAlongWall: number },
            overrides?: { openingWidthMm?: number; openingHeightMm?: number; sillHeightMm?: number }
        ) => {
            if (definition.category !== 'doors' && definition.category !== 'windows') {
                return;
            }

            const openingWidth =
                typeof overrides?.openingWidthMm === 'number' && Number.isFinite(overrides.openingWidthMm)
                    ? Math.max(1, overrides.openingWidthMm)
                    : definition.openingWidthMm ?? definition.widthMm;
            const openingHeight =
                typeof overrides?.openingHeightMm === 'number' && Number.isFinite(overrides.openingHeightMm)
                    ? Math.max(1, overrides.openingHeightMm)
                    : definition.heightMm;
            const sillHeight =
                definition.category === 'windows'
                    ? (typeof overrides?.sillHeightMm === 'number' && Number.isFinite(overrides.sillHeightMm)
                        ? Math.max(0, overrides.sillHeightMm)
                        : definition.sillHeightMm ?? 900)
                    : 0;
            const targetWallId = snappedWall.wall.id;
            const wallsToUpdate = new Map<string, Wall>();
            const previousHostWall = openingHostWallById.get(symbolId);
            if (previousHostWall) {
                wallsToUpdate.set(previousHostWall.id, previousHostWall);
            }
            wallsToUpdate.set(snappedWall.wall.id, snappedWall.wall);
            const nextOpening = {
                id: symbolId,
                type: (definition.category === 'doors' ? 'door' : 'window') as 'door' | 'window',
                position: snappedWall.positionAlongWall,
                width: openingWidth + 50,
                height: openingHeight,
                sillHeight,
            };

            for (const wall of wallsToUpdate.values()) {
                const hasSymbolOpening = wall.openings.some((opening) => opening.id === symbolId);
                const isTargetWall = wall.id === targetWallId;
                if (!hasSymbolOpening && !isTargetWall) continue;

                const filtered = wall.openings.filter((opening) => opening.id !== symbolId);
                const nextOpenings = isTargetWall
                    ? [...filtered, nextOpening].sort((a, b) => a.position - b.position)
                    : filtered;

                const unchanged =
                    nextOpenings.length === wall.openings.length &&
                    nextOpenings.every((opening, index) => {
                        const existing = wall.openings[index];
                        return (
                            !!existing &&
                            opening.id === existing.id &&
                            opening.type === existing.type &&
                            Math.abs(opening.position - existing.position) < 0.001 &&
                            Math.abs(opening.width - existing.width) < 0.001 &&
                            Math.abs(opening.height - existing.height) < 0.001 &&
                            (opening.sillHeight ?? 0) === (existing.sillHeight ?? 0)
                        );
                    });

                if (unchanged) continue;
                updateWall(
                    wall.id,
                    { openings: nextOpenings } as Partial<Wall>,
                    { skipHistory: true, source: 'ui' }
                );
            }
        },
        [openingHostWallById, updateWall]
    );

    // -----------------------------------------------------------------------
    // buildHostedOpeningSymbolProperties
    // -----------------------------------------------------------------------

    const buildHostedOpeningSymbolProperties = useCallback(
        (
            definition: ArchitecturalObjectDefinition,
            wall: Wall,
            positionAlongWallMm: number,
            sourceProperties: Record<string, unknown> | undefined,
            openingWidthMm: number,
            openingHeightMm: number,
            openingSillHeightMm: number,
        ): Record<string, unknown> => {
            const nextBaseElevationMm =
                definition.category === 'windows'
                    ? (wall.properties3D.baseElevation ?? 0) + openingSillHeightMm
                    : (wall.properties3D.baseElevation ?? 0);
            const nextProperties: Record<string, unknown> = {
                ...sourceProperties,
                widthMm: openingWidthMm,
                depthMm: wall.thickness,
                heightMm: openingHeightMm,
                hostWallId: wall.id,
                hostWallThicknessMm: wall.thickness,
                positionAlongWallMm: positionAlongWallMm,
                baseElevationMm: nextBaseElevationMm,
            };

            if (definition.category === 'windows') {
                nextProperties.sillHeightMm = openingSillHeightMm;
            }

            if (definition.category === 'doors') {
                Object.assign(
                    nextProperties,
                    resolveHostedDoorSwingProperties(
                        wall,
                        positionAlongWallMm,
                        openingWidthMm,
                        rooms,
                        nextProperties
                    )
                );
            }

            return nextProperties;
        },
        [rooms]
    );

    // -----------------------------------------------------------------------
    // buildOpeningPreviewProperties
    // -----------------------------------------------------------------------

    const buildOpeningPreviewProperties = useCallback(
        (
            definition: ArchitecturalObjectDefinition,
            snappedWall?: { wall: Wall; positionAlongWall: number } | null
        ): Record<string, unknown> | undefined => {
            if (definition.category !== 'doors' || !snappedWall) {
                return undefined;
            }

            return {
                type: definition.type,
                swingDirection: 'left',
                doorSwingBehavior: 'inward',
                doorHingeMode: 'auto-corner',
                ...resolveHostedDoorSwingProperties(
                    snappedWall.wall,
                    snappedWall.positionAlongWall,
                    definition.openingWidthMm ?? definition.widthMm,
                    rooms,
                    { swingDirection: 'left', doorSwingBehavior: 'inward', doorHingeMode: 'auto-corner' }
                ),
            };
        },
        [rooms]
    );

    // -----------------------------------------------------------------------
    // placePendingObject
    // -----------------------------------------------------------------------

    const placePendingObject = useCallback((point: Point2D): boolean => {
        if (!pendingPlacementDefinition) return false;
        const placement = computePlacement(point, pendingPlacementDefinition);
        setPlacementValid(placement.valid);
        if (!placement.valid) {
            const isOpening =
                pendingPlacementDefinition.category === 'doors' ||
                pendingPlacementDefinition.category === 'windows';
            setProcessingStatus(
                isOpening
                    ? 'Placement blocked: opening does not fit, overlaps another opening, or is on a half partition wall.'
                    : 'Placement blocked: furniture overlap detected.',
                false
            );
            return true;
        }

        const baseProperties: Record<string, unknown> = {
            definitionId: pendingPlacementDefinition.id,
            category: pendingPlacementDefinition.category,
            type: pendingPlacementDefinition.type,
            widthMm:
                (pendingPlacementDefinition.category === 'doors' || pendingPlacementDefinition.category === 'windows') &&
                    placement.snappedWall
                    ? (pendingPlacementDefinition.openingWidthMm ?? pendingPlacementDefinition.widthMm)
                    : pendingPlacementDefinition.widthMm,
            depthMm:
                (pendingPlacementDefinition.category === 'doors' || pendingPlacementDefinition.category === 'windows') &&
                    placement.snappedWall
                    ? placement.snappedWall.wall.thickness
                    : pendingPlacementDefinition.depthMm,
            heightMm: pendingPlacementDefinition.heightMm,
            baseElevationMm:
                pendingPlacementDefinition.category === 'windows'
                    ? ((placement.snappedWall?.wall.properties3D.baseElevation ?? 0) +
                        (pendingPlacementDefinition.sillHeightMm ?? 900))
                    : (placement.snappedWall?.wall.properties3D.baseElevation ?? 0),
            material: pendingPlacementDefinition.material,
            swingDirection: 'left',
            doorSwingBehavior: pendingPlacementDefinition.category === 'doors' ? 'inward' : undefined,
            doorHingeMode: pendingPlacementDefinition.category === 'doors' ? 'auto-corner' : undefined,
            ...(pendingPlacementDefinition.renderType === 'circular-table-chairs' ||
                pendingPlacementDefinition.renderType === 'square-table-chairs'
                ? { chairCount: 4 }
                : {}),
            hostWallId: placement.snappedWall?.wall.id,
            hostWallThicknessMm: placement.snappedWall?.wall.thickness,
            positionAlongWallMm: placement.snappedWall?.positionAlongWall,
            placedAt: new Date().toISOString(),
        };
        const resolvedProperties =
            (pendingPlacementDefinition.category === 'doors' || pendingPlacementDefinition.category === 'windows') &&
                placement.snappedWall
                ? buildHostedOpeningSymbolProperties(
                    pendingPlacementDefinition,
                    placement.snappedWall.wall,
                    placement.snappedWall.positionAlongWall,
                    baseProperties,
                    pendingPlacementDefinition.openingWidthMm ?? pendingPlacementDefinition.widthMm,
                    pendingPlacementDefinition.heightMm,
                    pendingPlacementDefinition.sillHeightMm ?? 900
                )
                : baseProperties;

        const symbolPayload: Omit<SymbolInstance2D, 'id'> = {
            symbolId: pendingPlacementDefinition.id,
            position: placement.point,
            rotation: placement.rotationDeg,
            scale: 1,
            flipped: false,
            properties: resolvedProperties,
        };
        const symbolId = addSymbol(symbolPayload);
        const placedInstance: SymbolInstance2D = { ...symbolPayload, id: symbolId };
        const placedIsOpening =
            pendingPlacementDefinition.category === 'doors' ||
            pendingPlacementDefinition.category === 'windows';
        setSelectedIds(placedIsOpening ? [] : [symbolId]);

        if (
            placement.snappedWall &&
            (pendingPlacementDefinition.category === 'doors' || pendingPlacementDefinition.category === 'windows')
        ) {
            syncOpeningForSymbol(symbolId, pendingPlacementDefinition, {
                wall: placement.snappedWall.wall,
                positionAlongWall: placement.snappedWall.positionAlongWall,
            });
        }

        onObjectPlaced?.(pendingPlacementDefinition.id, placedInstance);
        setProcessingStatus(`Placed ${pendingPlacementDefinition.name}.`, false);
        return true;
    }, [
        pendingPlacementDefinition,
        buildHostedOpeningSymbolProperties,
        computePlacement,
        addSymbol,
        setSelectedIds,
        syncOpeningForSymbol,
        onObjectPlaced,
        setProcessingStatus,
        setPlacementValid,
    ]);

    return {
        resolveOpeningWidthMm,
        resolveOpeningHeightMm,
        resolveOpeningSillHeightMm,
        fitOpeningToWall,
        collisionBounds,
        objectsOverlap,
        hasFurnitureCollision,
        computePlacement,
        syncOpeningForSymbol,
        buildHostedOpeningSymbolProperties,
        buildOpeningPreviewProperties,
        placePendingObject,
    };
}
