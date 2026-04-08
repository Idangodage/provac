/**
 * Target Resolvers Hook
 *
 * Provides callbacks to resolve entity IDs (wall, room, dimension, etc.)
 * from Fabric.js target objects. All callbacks have empty dependency arrays
 * so they are stable references.
 */

import type * as fabric from 'fabric';
import { useCallback } from 'react';

import type { OpeningResizeHandleHit } from '../../DrawingCanvas.types';

export interface UseTargetResolversResult {
    resolveWallIdFromTarget: (target: fabric.Object | undefined | null) => string | null;
    resolveRoomIdFromTarget: (target: fabric.Object | undefined | null) => string | null;
    resolveDimensionIdFromTarget: (target: fabric.Object | undefined | null) => string | null;
    resolveSectionLineIdFromTarget: (target: fabric.Object | undefined | null) => string | null;
    resolveObjectIdFromTarget: (target: fabric.Object | undefined | null) => string | null;
    resolveHvacIdFromTarget: (target: fabric.Object | undefined | null) => string | null;
    resolveOpeningIdFromTarget: (target: fabric.Object | undefined | null) => string | null;
    resolveOpeningResizeHandleFromTarget: (target: fabric.Object | undefined | null) => OpeningResizeHandleHit | null;
}

export function useTargetResolvers(): UseTargetResolversResult {
    const resolveWallIdFromTarget = useCallback(
        (target: fabric.Object | undefined | null): string | null => {
            if (!target) return null;

            const typedTarget = target as fabric.Object & {
                id?: string;
                wallId?: string;
                name?: string;
                group?: fabric.Group & { id?: string; wallId?: string; name?: string };
            };

            if (typedTarget.wallId) return typedTarget.wallId;
            if (typedTarget.id && typedTarget.name?.startsWith('wall-')) return typedTarget.id;

            const parent = typedTarget.group;
            if (parent?.wallId) return parent.wallId;
            if (parent?.id && parent?.name?.startsWith('wall-')) return parent.id;

            return null;
        },
        []
    );

    const resolveRoomIdFromTarget = useCallback(
        (target: fabric.Object | undefined | null): string | null => {
            if (!target) return null;

            const typedTarget = target as fabric.Object & {
                id?: string;
                roomId?: string;
                name?: string;
                group?: fabric.Group & { id?: string; roomId?: string; name?: string };
            };

            if (typedTarget.roomId) return typedTarget.roomId;
            if (typedTarget.id && typedTarget.name?.startsWith('room-')) return typedTarget.id;

            const parent = typedTarget.group;
            if (parent?.roomId) return parent.roomId;
            if (parent?.id && parent?.name?.startsWith('room-')) return parent.id;

            return null;
        },
        []
    );

    const resolveDimensionIdFromTarget = useCallback(
        (target: fabric.Object | undefined | null): string | null => {
            if (!target) return null;

            const typedTarget = target as fabric.Object & {
                id?: string;
                dimensionId?: string;
                name?: string;
                group?: fabric.Group & { id?: string; dimensionId?: string; name?: string };
            };

            if (typedTarget.dimensionId) return typedTarget.dimensionId;
            if (typedTarget.id && typedTarget.name?.startsWith('dimension-')) return typedTarget.id;

            const parent = typedTarget.group;
            if (parent?.dimensionId) return parent.dimensionId;
            if (parent?.id && parent?.name?.startsWith('dimension-')) return parent.id;

            return null;
        },
        []
    );

    const resolveSectionLineIdFromTarget = useCallback(
        (target: fabric.Object | undefined | null): string | null => {
            if (!target) return null;

            const typedTarget = target as fabric.Object & {
                id?: string;
                sectionLineId?: string;
                name?: string;
                group?: fabric.Group & { id?: string; sectionLineId?: string; name?: string };
            };

            if (typedTarget.sectionLineId) return typedTarget.sectionLineId;
            if (typedTarget.id && typedTarget.name?.startsWith('section-line-')) return typedTarget.id;

            const parent = typedTarget.group;
            if (parent?.sectionLineId) return parent.sectionLineId;
            if (parent?.id && parent?.name?.startsWith('section-line-')) return parent.id;

            return null;
        },
        []
    );

    const resolveObjectIdFromTarget = useCallback(
        (target: fabric.Object | undefined | null): string | null => {
            if (!target) return null;

            const typedTarget = target as fabric.Object & {
                id?: string;
                objectId?: string;
                openingId?: string;
                name?: string;
                group?: fabric.Group & { id?: string; objectId?: string; openingId?: string; name?: string };
            };

            if (typedTarget.objectId) return typedTarget.objectId;
            if (typedTarget.openingId) return typedTarget.openingId;
            if (typedTarget.id && typedTarget.name?.startsWith('object-')) return typedTarget.id;

            const parent = typedTarget.group;
            if (parent?.objectId) return parent.objectId;
            if (parent?.openingId) return parent.openingId;
            if (parent?.id && parent?.name?.startsWith('object-')) return parent.id;

            return null;
        },
        []
    );

    const resolveHvacIdFromTarget = useCallback(
        (target: fabric.Object | undefined | null): string | null => {
            if (!target) return null;

            const typedTarget = target as fabric.Object & {
                id?: string;
                hvacElementId?: string;
                name?: string;
                group?: fabric.Group & { id?: string; hvacElementId?: string; name?: string };
            };

            if (typedTarget.hvacElementId) return typedTarget.hvacElementId;
            if (typedTarget.id && typedTarget.name?.startsWith('hvac-')) return typedTarget.id;

            const parent = typedTarget.group;
            if (parent?.hvacElementId) return parent.hvacElementId;
            if (parent?.id && parent?.name?.startsWith('hvac-')) return parent.id;

            return null;
        },
        []
    );

    const resolveOpeningIdFromTarget = useCallback(
        (target: fabric.Object | undefined | null): string | null => {
            if (!target) return null;

            const typedTarget = target as fabric.Object & {
                openingId?: string;
                group?: fabric.Group & { openingId?: string };
            };

            if (typedTarget.openingId) return typedTarget.openingId;
            if (typedTarget.group?.openingId) return typedTarget.group.openingId;
            return null;
        },
        []
    );

    const resolveOpeningResizeHandleFromTarget = useCallback(
        (target: fabric.Object | undefined | null): OpeningResizeHandleHit | null => {
            if (!target) return null;

            const typedTarget = target as fabric.Object & {
                openingId?: string;
                wallId?: string;
                openingResizeSide?: 'start' | 'end';
                isOpeningResizeHandle?: boolean;
                group?: fabric.Group & {
                    openingId?: string;
                    wallId?: string;
                    openingResizeSide?: 'start' | 'end';
                    isOpeningResizeHandle?: boolean;
                };
            };

            const fromTarget = typedTarget.isOpeningResizeHandle
                ? {
                    openingId: typedTarget.openingId,
                    wallId: typedTarget.wallId,
                    side: typedTarget.openingResizeSide,
                }
                : null;
            const fromParent = typedTarget.group?.isOpeningResizeHandle
                ? {
                    openingId: typedTarget.group.openingId,
                    wallId: typedTarget.group.wallId,
                    side: typedTarget.group.openingResizeSide,
                }
                : null;
            const resolved = fromTarget ?? fromParent;
            if (!resolved?.openingId || !resolved.wallId || !resolved.side) return null;
            return {
                openingId: resolved.openingId,
                wallId: resolved.wallId,
                side: resolved.side,
            };
        },
        []
    );

    return {
        resolveWallIdFromTarget,
        resolveRoomIdFromTarget,
        resolveDimensionIdFromTarget,
        resolveSectionLineIdFromTarget,
        resolveObjectIdFromTarget,
        resolveHvacIdFromTarget,
        resolveOpeningIdFromTarget,
        resolveOpeningResizeHandleFromTarget,
    };
}
