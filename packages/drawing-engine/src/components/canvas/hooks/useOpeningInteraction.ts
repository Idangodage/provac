/**
 * useOpeningInteraction
 *
 * Encapsulates all opening-related pointer interaction logic previously
 * inlined in DrawingCanvas.tsx: move, resize-start, resize-end of hosted
 * openings (doors / windows / bare wall openings) and object nudge.
 */

import { useCallback } from 'react';
import * as fabric from 'fabric';

import type { Point2D, Wall, SymbolInstance2D } from '../../../types';
import type { ArchitecturalObjectDefinition } from '../../../data';
import {
    type OpeningPointerInteraction,
    MIN_OPENING_EDGE_MARGIN_MM,
    MIN_OPENING_GEOMETRY_WIDTH_MM,
    clampValue,
} from '../../DrawingCanvas.types';
import type { WallPlacementSnap, PointProjection } from './useGeometryHelpers';

// ---------------------------------------------------------------------------
// Options interface
// ---------------------------------------------------------------------------

export interface UseOpeningInteractionOptions {
    fabricRef: React.RefObject<fabric.Canvas | null>;
    walls: Wall[];
    symbols: SymbolInstance2D[];
    selectedIds: string[];
    objectDefinitionsById: Map<string, ArchitecturalObjectDefinition>;
    openingResizeHandlesRef: React.MutableRefObject<fabric.Object[]>;
    openingPointerInteractionRef: React.MutableRefObject<OpeningPointerInteraction | null>;

    // Callbacks from useOpeningPlacement (generic signatures to avoid circular imports)
    computePlacement: (
        point: Point2D,
        definition: ArchitecturalObjectDefinition,
        options?: {
            ignoreSymbolId?: string;
            ignoreOpeningId?: string;
            openingWidthMm?: number;
        },
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
        snap: { wall: Wall; positionAlongWall: number },
        sizes: {
            openingWidthMm: number;
            openingHeightMm: number;
            sillHeightMm: number;
        },
    ) => void;
    buildHostedOpeningSymbolProperties: (
        definition: ArchitecturalObjectDefinition,
        wall: Wall,
        positionAlongWallMm: number,
        existingProperties: Record<string, unknown> | undefined,
        openingWidthMm: number,
        openingHeightMm: number,
        openingSillHeightMm: number,
    ) => Record<string, unknown>;
    resolveOpeningWidthMm: (
        definition: ArchitecturalObjectDefinition,
        properties?: Record<string, unknown>,
    ) => number;
    resolveOpeningHeightMm: (
        definition: ArchitecturalObjectDefinition,
        properties?: Record<string, unknown>,
    ) => number;
    resolveOpeningSillHeightMm: (
        definition: ArchitecturalObjectDefinition,
        properties?: Record<string, unknown>,
    ) => number;
    hasFurnitureCollision: (
        position: Point2D,
        definition: ArchitecturalObjectDefinition,
        options?: { ignoreSymbolId?: string },
    ) => boolean;

    // Callbacks from useGeometryHelpers
    findWallPlacementSnap: (point: Point2D) => WallPlacementSnap | null;
    projectPointToSegment: (point: Point2D, segStart: Point2D, segEnd: Point2D) => PointProjection;

    // Store actions
    updateWall: (
        wallId: string,
        changes: Partial<Wall>,
        options?: { skipHistory?: boolean; source?: 'ui' | 'drag'; skipRoomDetection?: boolean },
    ) => void;
    updateSymbol: (
        symbolId: string,
        changes: Partial<SymbolInstance2D>,
        options?: { skipHistory?: boolean },
    ) => void;
    saveToHistory: (label: string) => void;
    setProcessingStatus: (message: string, active: boolean) => void;

    // State setters
    setOpeningInteractionActive: (active: boolean) => void;
}

// ---------------------------------------------------------------------------
// Result interface
// ---------------------------------------------------------------------------

export interface UseOpeningInteractionResult {
    clearOpeningResizeHandles: () => void;
    applyOpeningSymbolPlacement: (
        instance: SymbolInstance2D,
        definition: ArchitecturalObjectDefinition,
        wall: Wall,
        positionAlongWallMm: number,
        openingWidthMm: number,
        openingHeightMm: number,
        openingSillHeightMm: number,
        options?: { skipHistory?: boolean },
    ) => void;
    updateOpeningPointerInteraction: (pointerMm: Point2D) => boolean;
    beginOpeningPointerInteraction: (interaction: OpeningPointerInteraction) => void;
    finishOpeningPointerInteraction: () => boolean;
    nudgeSelectedObjects: (dxMm: number, dyMm: number) => boolean;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useOpeningInteraction(options: UseOpeningInteractionOptions): UseOpeningInteractionResult {
    const {
        fabricRef,
        walls,
        symbols,
        selectedIds,
        objectDefinitionsById,
        openingResizeHandlesRef,
        openingPointerInteractionRef,
        computePlacement,
        syncOpeningForSymbol,
        buildHostedOpeningSymbolProperties,
        resolveOpeningWidthMm,
        resolveOpeningHeightMm,
        resolveOpeningSillHeightMm,
        hasFurnitureCollision,
        findWallPlacementSnap,
        projectPointToSegment,
        updateWall,
        updateSymbol,
        saveToHistory,
        setProcessingStatus,
        setOpeningInteractionActive,
    } = options;

    // -----------------------------------------------------------------------
    // clearOpeningResizeHandles
    // -----------------------------------------------------------------------
    const clearOpeningResizeHandles = useCallback(() => {
        const canvas = fabricRef.current;
        if (!canvas) return;
        if (openingResizeHandlesRef.current.length === 0) return;
        openingResizeHandlesRef.current.forEach((handle) => canvas.remove(handle));
        openingResizeHandlesRef.current = [];
        canvas.requestRenderAll();
    }, [fabricRef, openingResizeHandlesRef]);

    // -----------------------------------------------------------------------
    // applyOpeningSymbolPlacement
    // -----------------------------------------------------------------------
    const applyOpeningSymbolPlacement = useCallback(
        (
            instance: SymbolInstance2D,
            definition: ArchitecturalObjectDefinition,
            wall: Wall,
            positionAlongWallMm: number,
            openingWidthMm: number,
            openingHeightMm: number,
            openingSillHeightMm: number,
            opts?: { skipHistory?: boolean },
        ) => {
            const dx = wall.endPoint.x - wall.startPoint.x;
            const dy = wall.endPoint.y - wall.startPoint.y;
            const wallLength = Math.hypot(dx, dy) || 1;
            const t = positionAlongWallMm / wallLength;
            const nextPosition = {
                x: wall.startPoint.x + dx * t,
                y: wall.startPoint.y + dy * t,
            };
            const nextRotation = (Math.atan2(dy, dx) * 180) / Math.PI;
            const nextProperties = buildHostedOpeningSymbolProperties(
                definition,
                wall,
                positionAlongWallMm,
                instance.properties,
                openingWidthMm,
                openingHeightMm,
                openingSillHeightMm,
            );
            updateSymbol(
                instance.id,
                {
                    position: nextPosition,
                    rotation: nextRotation,
                    properties: nextProperties,
                },
                opts,
            );
        },
        [buildHostedOpeningSymbolProperties, updateSymbol],
    );

    // -----------------------------------------------------------------------
    // updateOpeningPointerInteraction
    // -----------------------------------------------------------------------
    const updateOpeningPointerInteraction = useCallback(
        (pointerMm: Point2D): boolean => {
            const interaction = openingPointerInteractionRef.current;
            if (!interaction) return false;

            const hostWall = walls.find((wall) => wall.id === interaction.wallId)
                ?? walls.find((wall) => wall.openings.some((entry) => entry.id === interaction.openingId));
            const hostOpening = hostWall?.openings.find((entry) => entry.id === interaction.openingId);
            const instance = symbols.find((entry) => entry.id === interaction.openingId);
            const definition = instance
                ? objectDefinitionsById.get(instance.symbolId)
                : undefined;
            const hasLinkedSymbol = Boolean(
                instance &&
                definition &&
                (definition.category === 'doors' || definition.category === 'windows'),
            );
            const openingWidthMm = hasLinkedSymbol
                ? resolveOpeningWidthMm(definition as ArchitecturalObjectDefinition, instance?.properties)
                : Math.max(1, (hostOpening?.width ?? MIN_OPENING_GEOMETRY_WIDTH_MM) - 50);
            const openingHeightMm = hasLinkedSymbol
                ? resolveOpeningHeightMm(definition as ArchitecturalObjectDefinition, instance?.properties)
                : Math.max(1, hostOpening?.height ?? 2100);
            const openingSillHeightMm = hasLinkedSymbol
                ? resolveOpeningSillHeightMm(definition as ArchitecturalObjectDefinition, instance?.properties)
                : Math.max(0, hostOpening?.sillHeight ?? 0);

            if (interaction.mode === 'move') {
                const sourceWall = hostWall ?? null;
                const snappedAnchorWall = findWallPlacementSnap(pointerMm)?.wall ?? sourceWall;
                let placementSeedPoint = pointerMm;

                if (snappedAnchorWall) {
                    const wallDx = snappedAnchorWall.endPoint.x - snappedAnchorWall.startPoint.x;
                    const wallDy = snappedAnchorWall.endPoint.y - snappedAnchorWall.startPoint.y;
                    const wallLength = Math.hypot(wallDx, wallDy);
                    if (Number.isFinite(wallLength) && wallLength > 0.001) {
                        const pointerProjection = projectPointToSegment(
                            pointerMm,
                            snappedAnchorWall.startPoint,
                            snappedAnchorWall.endPoint,
                        );
                        const pointerAlongWall = pointerProjection.t * wallLength;
                        const grabOffset = interaction.grabOffsetAlongWallMm ?? 0;
                        const desiredCenterAlongWall = clampValue(
                            pointerAlongWall - grabOffset,
                            0,
                            wallLength,
                        );
                        const t = desiredCenterAlongWall / wallLength;
                        placementSeedPoint = {
                            x: snappedAnchorWall.startPoint.x + wallDx * t,
                            y: snappedAnchorWall.startPoint.y + wallDy * t,
                        };
                    }
                }

                if (!hasLinkedSymbol) {
                    if (!hostWall || !hostOpening) return true;
                    const wallDx = hostWall.endPoint.x - hostWall.startPoint.x;
                    const wallDy = hostWall.endPoint.y - hostWall.startPoint.y;
                    const wallLength = Math.hypot(wallDx, wallDy);
                    if (!Number.isFinite(wallLength) || wallLength <= 0.001) return true;

                    const projected = projectPointToSegment(
                        placementSeedPoint,
                        hostWall.startPoint,
                        hostWall.endPoint,
                    );
                    const projectedAlongWall = projected.t * wallLength;
                    const grabOffset = interaction.grabOffsetAlongWallMm ?? 0;
                    const desiredCenterAlongWall = projectedAlongWall - grabOffset;
                    const halfWidth = hostOpening.width / 2;

                    let minPosition = MIN_OPENING_EDGE_MARGIN_MM + halfWidth;
                    let maxPosition = wallLength - MIN_OPENING_EDGE_MARGIN_MM - halfWidth;
                    const neighbours = hostWall.openings.filter((entry) => entry.id !== interaction.openingId);
                    neighbours.forEach((entry) => {
                        const requiredGap = entry.width / 2 + halfWidth + MIN_OPENING_EDGE_MARGIN_MM;
                        if (entry.position < hostOpening.position) {
                            minPosition = Math.max(minPosition, entry.position + requiredGap);
                        } else {
                            maxPosition = Math.min(maxPosition, entry.position - requiredGap);
                        }
                    });
                    if (maxPosition < minPosition) return true;
                    const nextPosition = clampValue(desiredCenterAlongWall, minPosition, maxPosition);
                    if (Math.abs(nextPosition - hostOpening.position) > 0.01) {
                        updateWall(
                            hostWall.id,
                            {
                                openings: hostWall.openings.map((entry) =>
                                    entry.id === interaction.openingId
                                        ? { ...entry, position: nextPosition }
                                        : entry,
                                ),
                            },
                            { skipHistory: true, source: 'ui' },
                        );
                        interaction.changed = true;
                    }
                    return true;
                }

                const placement = computePlacement(
                    placementSeedPoint,
                    definition as ArchitecturalObjectDefinition,
                    {
                        ignoreOpeningId: interaction.openingId,
                        ignoreSymbolId: interaction.openingId,
                        openingWidthMm,
                    },
                );
                if (!placement.valid || !placement.snappedWall || !instance || !definition) {
                    return true;
                }

                const snappedWall = placement.snappedWall.wall;
                const positionAlongWall = placement.snappedWall.positionAlongWall;
                syncOpeningForSymbol(
                    interaction.openingId,
                    definition,
                    { wall: snappedWall, positionAlongWall },
                    {
                        openingWidthMm,
                        openingHeightMm,
                        sillHeightMm: openingSillHeightMm,
                    },
                );
                applyOpeningSymbolPlacement(
                    instance,
                    definition,
                    snappedWall,
                    positionAlongWall,
                    openingWidthMm,
                    openingHeightMm,
                    openingSillHeightMm,
                    { skipHistory: true },
                );
                interaction.changed = true;
                return true;
            }

            if (!hostWall) return true;
            if (!hostOpening) return true;

            const wallDx = hostWall.endPoint.x - hostWall.startPoint.x;
            const wallDy = hostWall.endPoint.y - hostWall.startPoint.y;
            const wallLength = Math.hypot(wallDx, wallDy);
            if (!Number.isFinite(wallLength) || wallLength <= 0.001) return true;

            const projected = projectPointToSegment(pointerMm, hostWall.startPoint, hostWall.endPoint);
            const projectedAlongWall = projected.t * wallLength;
            const defaultAnchor = interaction.mode === 'resize-start'
                ? hostOpening.position + hostOpening.width / 2
                : hostOpening.position - hostOpening.width / 2;
            const anchorEdge = interaction.anchorEdgeAlongWall ?? defaultAnchor;
            if (!Number.isFinite(interaction.anchorEdgeAlongWall ?? Number.NaN)) {
                interaction.anchorEdgeAlongWall = anchorEdge;
            }

            const neighbours = hostWall.openings.filter((entry) => entry.id !== interaction.openingId);
            let startEdge = hostOpening.position - hostOpening.width / 2;
            let endEdge = hostOpening.position + hostOpening.width / 2;

            if (interaction.mode === 'resize-start') {
                let minStartEdge = MIN_OPENING_EDGE_MARGIN_MM;
                neighbours
                    .filter((entry) => entry.position < hostOpening.position)
                    .forEach((entry) => {
                        const neighbourRightEdge =
                            entry.position + entry.width / 2 + MIN_OPENING_EDGE_MARGIN_MM;
                        minStartEdge = Math.max(minStartEdge, neighbourRightEdge);
                    });
                const maxStartEdge = Math.min(
                    wallLength - MIN_OPENING_EDGE_MARGIN_MM,
                    anchorEdge - MIN_OPENING_GEOMETRY_WIDTH_MM,
                );
                if (maxStartEdge < minStartEdge) return true;
                startEdge = clampValue(projectedAlongWall, minStartEdge, maxStartEdge);
                endEdge = anchorEdge;
            } else {
                let maxEndEdge = wallLength - MIN_OPENING_EDGE_MARGIN_MM;
                neighbours
                    .filter((entry) => entry.position > hostOpening.position)
                    .forEach((entry) => {
                        const neighbourLeftEdge =
                            entry.position - entry.width / 2 - MIN_OPENING_EDGE_MARGIN_MM;
                        maxEndEdge = Math.min(maxEndEdge, neighbourLeftEdge);
                    });
                const minEndEdge = Math.max(
                    MIN_OPENING_EDGE_MARGIN_MM,
                    anchorEdge + MIN_OPENING_GEOMETRY_WIDTH_MM,
                );
                if (maxEndEdge < minEndEdge) return true;
                startEdge = anchorEdge;
                endEdge = clampValue(projectedAlongWall, minEndEdge, maxEndEdge);
            }

            const openingWidthWithClearanceMm = Math.max(
                MIN_OPENING_GEOMETRY_WIDTH_MM,
                endEdge - startEdge,
            );
            const nextPositionAlongWall = (startEdge + endEdge) / 2;
            if (hasLinkedSymbol && instance && definition) {
                const nextOpeningWidthMm = Math.max(1, openingWidthWithClearanceMm - 50);
                syncOpeningForSymbol(
                    interaction.openingId,
                    definition,
                    { wall: hostWall, positionAlongWall: nextPositionAlongWall },
                    {
                        openingWidthMm: nextOpeningWidthMm,
                        openingHeightMm,
                        sillHeightMm: openingSillHeightMm,
                    },
                );
                applyOpeningSymbolPlacement(
                    instance,
                    definition,
                    hostWall,
                    nextPositionAlongWall,
                    nextOpeningWidthMm,
                    openingHeightMm,
                    openingSillHeightMm,
                    { skipHistory: true },
                );
            } else {
                updateWall(
                    hostWall.id,
                    {
                        openings: hostWall.openings.map((entry) =>
                            entry.id === interaction.openingId
                                ? {
                                    ...entry,
                                    position: nextPositionAlongWall,
                                    width: openingWidthWithClearanceMm,
                                    height: openingHeightMm,
                                    sillHeight: openingSillHeightMm,
                                }
                                : entry,
                        ),
                    },
                    { skipHistory: true, source: 'ui' },
                );
            }
            interaction.changed = true;
            return true;
        },
        [
            symbols,
            objectDefinitionsById,
            walls,
            openingPointerInteractionRef,
            resolveOpeningWidthMm,
            resolveOpeningHeightMm,
            resolveOpeningSillHeightMm,
            findWallPlacementSnap,
            computePlacement,
            syncOpeningForSymbol,
            applyOpeningSymbolPlacement,
            projectPointToSegment,
            updateWall,
        ],
    );

    // -----------------------------------------------------------------------
    // beginOpeningPointerInteraction
    // -----------------------------------------------------------------------
    const beginOpeningPointerInteraction = useCallback((interaction: OpeningPointerInteraction) => {
        openingPointerInteractionRef.current = interaction;
        setOpeningInteractionActive(true);
        const canvas = fabricRef.current;
        if (!canvas) return;
        canvas.selection = false;
        canvas.discardActiveObject();
        canvas.requestRenderAll();
    }, [fabricRef, openingPointerInteractionRef, setOpeningInteractionActive]);

    // -----------------------------------------------------------------------
    // finishOpeningPointerInteraction
    // -----------------------------------------------------------------------
    const finishOpeningPointerInteraction = useCallback((): boolean => {
        const interaction = openingPointerInteractionRef.current;
        if (!interaction) return false;
        openingPointerInteractionRef.current = null;
        setOpeningInteractionActive(false);
        if (interaction.changed) {
            saveToHistory(interaction.mode === 'move' ? 'Move opening' : 'Resize opening');
        }
        return true;
    }, [openingPointerInteractionRef, saveToHistory, setOpeningInteractionActive]);

    // -----------------------------------------------------------------------
    // nudgeSelectedObjects
    // -----------------------------------------------------------------------
    const nudgeSelectedObjects = useCallback((dxMm: number, dyMm: number) => {
        const selectedSet = new Set(selectedIds);
        const selectedObjects = symbols.filter((entry) => selectedSet.has(entry.id));
        if (selectedObjects.length === 0) return false;

        for (const instance of selectedObjects) {
            const definition = objectDefinitionsById.get(instance.symbolId);
            if (!definition) continue;
            const candidatePosition = {
                x: instance.position.x + dxMm,
                y: instance.position.y + dyMm,
            };
            if (definition.category === 'doors' || definition.category === 'windows') {
                const oWidthMm = resolveOpeningWidthMm(definition, instance.properties);
                const oHeightMm = resolveOpeningHeightMm(definition, instance.properties);
                const oSillHeightMm = resolveOpeningSillHeightMm(definition, instance.properties);
                const placement = computePlacement(candidatePosition, definition, {
                    ignoreSymbolId: instance.id,
                    ignoreOpeningId: instance.id,
                    openingWidthMm: oWidthMm,
                });
                if (!placement.valid || !placement.snappedWall) {
                    setProcessingStatus('Movement blocked: opening must remain on a valid wall segment.', false);
                    continue;
                }

                const snappedWall = placement.snappedWall.wall;
                const nextProperties = buildHostedOpeningSymbolProperties(
                    definition,
                    snappedWall,
                    placement.snappedWall.positionAlongWall,
                    instance.properties,
                    oWidthMm,
                    oHeightMm,
                    oSillHeightMm,
                );

                syncOpeningForSymbol(instance.id, definition, {
                    wall: snappedWall,
                    positionAlongWall: placement.snappedWall.positionAlongWall,
                }, {
                    openingWidthMm: oWidthMm,
                    openingHeightMm: oHeightMm,
                    sillHeightMm: oSillHeightMm,
                });
                updateSymbol(instance.id, {
                    position: placement.point,
                    rotation: placement.rotationDeg,
                    properties: nextProperties,
                });
                continue;
            }
            const collides = hasFurnitureCollision(candidatePosition, definition, {
                ignoreSymbolId: instance.id,
            });
            if (collides) {
                setProcessingStatus('Movement blocked: furniture overlap detected.', false);
                continue;
            }
            updateSymbol(instance.id, { position: candidatePosition });
        }
        return true;
    }, [
        selectedIds,
        symbols,
        objectDefinitionsById,
        buildHostedOpeningSymbolProperties,
        computePlacement,
        syncOpeningForSymbol,
        resolveOpeningWidthMm,
        resolveOpeningHeightMm,
        resolveOpeningSillHeightMm,
        hasFurnitureCollision,
        setProcessingStatus,
        updateSymbol,
    ]);

    return {
        clearOpeningResizeHandles,
        applyOpeningSymbolPlacement,
        updateOpeningPointerInteraction,
        beginOpeningPointerInteraction,
        finishOpeningPointerInteraction,
        nudgeSelectedObjects,
    };
}
