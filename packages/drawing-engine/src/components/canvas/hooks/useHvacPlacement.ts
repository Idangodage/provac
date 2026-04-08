/**
 * useHvacPlacement
 *
 * AC equipment placement and validation on top of existing room/wall geometry.
 */

import { useCallback, useMemo } from 'react';

import type { AcEquipmentDefinition } from '../../../data';
import type { HvacElement, Point2D, Room } from '../../../types';
import { GeometryEngine } from '../../../utils/geometry-engine';

import type { WallPlacementSnap } from './useGeometryHelpers';

export interface HvacPlacementResult {
    point: Point2D;
    center: Point2D;
    rotationDeg: number;
    valid: boolean;
    roomId: string | null;
    wallId: string | null;
    snappedWall: WallPlacementSnap | null;
    invalidReason: string | null;
}

export interface UseHvacPlacementOptions {
    rooms: Room[];
    equipmentDefinitions: AcEquipmentDefinition[];
    pendingPlacementEquipmentDefinition: AcEquipmentDefinition | null;
    placementRotationDeg: number;
    findWallPlacementSnap: (point: Point2D) => WallPlacementSnap | null;
    addHvacElement: (
        element: Omit<Partial<HvacElement>, 'id'> &
            Pick<HvacElement, 'type' | 'position' | 'width' | 'depth' | 'height' | 'elevation' | 'mountType' | 'label'>
    ) => string;
    setSelectedIds: (ids: string[]) => void;
    setProcessingStatus: (message: string, loading: boolean) => void;
    onEquipmentPlaced?: (definitionId: string) => void;
}

type PlacementSource =
    | AcEquipmentDefinition
    | Pick<HvacElement, 'type' | 'category' | 'subtype' | 'modelLabel' | 'mountType' | 'width' | 'depth' | 'height' | 'elevation' | 'rotation' | 'properties'>;

interface PlacementSpec {
    type: HvacElement['type'];
    category: HvacElement['category'];
    subtype: string;
    modelLabel: string;
    mountType: HvacElement['mountType'];
    widthMm: number;
    depthMm: number;
    heightMm: number;
    elevationMm: number;
    placementMode: 'room' | 'wall' | 'outdoor';
    rotationDeg: number;
    defaultProperties: Record<string, unknown>;
}

function inferPlacementMode(source: PlacementSource): 'room' | 'wall' | 'outdoor' {
    if ('placementMode' in source) {
        return source.placementMode;
    }
    if (source.type === 'outdoor-unit') {
        return 'outdoor';
    }
    if (source.mountType === 'wall') {
        return 'wall';
    }
    return 'room';
}

function resolvePlacementSpec(source: PlacementSource, placementRotationDeg: number): PlacementSpec {
    if ('placementMode' in source) {
        return {
            type: source.type,
            category: source.equipmentCategory,
            subtype: source.subtype,
            modelLabel: source.modelLabel,
            mountType: source.mountType,
            widthMm: source.widthMm,
            depthMm: source.depthMm,
            heightMm: source.heightMm,
            elevationMm: source.elevationMm,
            placementMode: source.placementMode,
            rotationDeg: placementRotationDeg,
            defaultProperties: source.defaultProperties ?? {},
        };
    }

    return {
        type: source.type,
        category: source.category,
        subtype: source.subtype ?? 'standard',
        modelLabel: source.modelLabel ?? source.type,
        mountType: source.mountType,
        widthMm: source.width,
        depthMm: source.depth,
        heightMm: source.height,
        elevationMm: source.elevation,
        placementMode: inferPlacementMode(source),
        rotationDeg: source.rotation ?? 0,
        defaultProperties: source.properties ?? {},
    };
}

function centerToTopLeft(center: Point2D, widthMm: number, depthMm: number): Point2D {
    return {
        x: center.x - widthMm / 2,
        y: center.y - depthMm / 2,
    };
}

export function useHvacPlacement(options: UseHvacPlacementOptions) {
    const {
        rooms,
        equipmentDefinitions,
        pendingPlacementEquipmentDefinition,
        placementRotationDeg,
        findWallPlacementSnap,
        addHvacElement,
        setSelectedIds,
        setProcessingStatus,
        onEquipmentPlaced,
    } = options;

    const definitionsById = useMemo(
        () => new Map(equipmentDefinitions.map((definition) => [definition.id, definition])),
        [equipmentDefinitions],
    );
    const definitionsByType = useMemo(
        () => new Map(equipmentDefinitions.map((definition) => [definition.type, definition])),
        [equipmentDefinitions],
    );

    const findRoomAtPoint = useCallback((point: Point2D): Room | null => {
        for (const room of rooms) {
            if (GeometryEngine.pointInRoom(point, room)) {
                return room;
            }
        }
        return null;
    }, [rooms]);

    const resolveEquipmentDefinitionForElement = useCallback((element: Pick<HvacElement, 'type' | 'properties'>) => {
        const definitionId = typeof element.properties?.definitionId === 'string'
            ? element.properties.definitionId
            : null;
        if (definitionId && definitionsById.has(definitionId)) {
            return definitionsById.get(definitionId) ?? null;
        }
        return definitionsByType.get(element.type) ?? null;
    }, [definitionsById, definitionsByType]);

    const computeHvacPlacement = useCallback((point: Point2D, source: PlacementSource): HvacPlacementResult => {
        const spec = resolvePlacementSpec(source, placementRotationDeg);
        const defaultResult = (
            center: Point2D,
            overrides?: Partial<HvacPlacementResult>,
        ): HvacPlacementResult => ({
            point: centerToTopLeft(center, spec.widthMm, spec.depthMm),
            center,
            rotationDeg: spec.rotationDeg,
            valid: false,
            roomId: null,
            wallId: null,
            snappedWall: null,
            invalidReason: null,
            ...overrides,
        });

        if (spec.placementMode === 'outdoor') {
            const room = findRoomAtPoint(point);
            return defaultResult(point, {
                valid: !room,
                roomId: null,
                invalidReason: room ? 'Outdoor units must be placed outside enclosed rooms.' : null,
            });
        }

        if (spec.placementMode === 'room') {
            const room = findRoomAtPoint(point);
            return defaultResult(point, {
                valid: Boolean(room),
                roomId: room?.id ?? null,
                invalidReason: room ? null : 'Equipment must be placed inside a valid room.',
            });
        }

        const snappedWall = findWallPlacementSnap(point);
        if (!snappedWall) {
            return defaultResult(point, {
                invalidReason: 'Equipment must snap to a nearby room wall.',
            });
        }

        const roomOffset = Math.max(40, snappedWall.wall.thickness / 2 + 20);
        const positiveRoom = findRoomAtPoint({
            x: snappedWall.point.x + snappedWall.normal.x * roomOffset,
            y: snappedWall.point.y + snappedWall.normal.y * roomOffset,
        });
        const negativeRoom = findRoomAtPoint({
            x: snappedWall.point.x - snappedWall.normal.x * roomOffset,
            y: snappedWall.point.y - snappedWall.normal.y * roomOffset,
        });
        const pointerRoom = findRoomAtPoint(point);

        const selectedRoom =
            (pointerRoom && pointerRoom.id === positiveRoom?.id) ? positiveRoom
                : (pointerRoom && pointerRoom.id === negativeRoom?.id) ? negativeRoom
                    : pointerRoom
                        ?? positiveRoom
                        ?? negativeRoom
                        ?? null;

        if (!selectedRoom) {
            return defaultResult(point, {
                wallId: snappedWall.wall.id,
                snappedWall,
                rotationDeg: snappedWall.angleDeg,
                invalidReason: 'Selected wall is not associated with an interior room.',
            });
        }

        const selectedOnPositiveNormal = positiveRoom?.id === selectedRoom.id;
        const normalDirection = selectedOnPositiveNormal ? snappedWall.normal : {
            x: -snappedWall.normal.x,
            y: -snappedWall.normal.y,
        };
        const center = {
            x: snappedWall.point.x + normalDirection.x * (spec.depthMm / 2),
            y: snappedWall.point.y + normalDirection.y * (spec.depthMm / 2),
        };

        return defaultResult(center, {
            valid: true,
            roomId: selectedRoom.id,
            wallId: snappedWall.wall.id,
            snappedWall,
            rotationDeg: snappedWall.angleDeg,
            invalidReason: null,
        });
    }, [findRoomAtPoint, findWallPlacementSnap, placementRotationDeg]);

    const placePendingHvacElement = useCallback((point: Point2D): boolean => {
        if (!pendingPlacementEquipmentDefinition) {
            return false;
        }

        const placement = computeHvacPlacement(point, pendingPlacementEquipmentDefinition);
        if (!placement.valid) {
            setProcessingStatus(
                placement.invalidReason ?? 'Unable to place AC equipment at the selected location.',
                false,
            );
            return false;
        }

        const elementId = addHvacElement({
            type: pendingPlacementEquipmentDefinition.type,
            category: pendingPlacementEquipmentDefinition.equipmentCategory,
            subtype: pendingPlacementEquipmentDefinition.subtype,
            modelLabel: pendingPlacementEquipmentDefinition.modelLabel,
            position: placement.point,
            rotation: placement.rotationDeg,
            width: pendingPlacementEquipmentDefinition.widthMm,
            depth: pendingPlacementEquipmentDefinition.depthMm,
            height: pendingPlacementEquipmentDefinition.heightMm,
            elevation: pendingPlacementEquipmentDefinition.elevationMm,
            mountType: pendingPlacementEquipmentDefinition.mountType,
            label: pendingPlacementEquipmentDefinition.name,
            roomId: placement.roomId ?? undefined,
            wallId: placement.wallId ?? undefined,
            supplyZoneRatio: pendingPlacementEquipmentDefinition.supplyZoneRatio ?? 0.5,
            properties: {
                definitionId: pendingPlacementEquipmentDefinition.id,
                ...pendingPlacementEquipmentDefinition.defaultProperties,
            },
        });
        setSelectedIds([elementId]);
        onEquipmentPlaced?.(pendingPlacementEquipmentDefinition.id);
        return true;
    }, [
        addHvacElement,
        computeHvacPlacement,
        onEquipmentPlaced,
        pendingPlacementEquipmentDefinition,
        setProcessingStatus,
        setSelectedIds,
    ]);

    return {
        resolveEquipmentDefinitionForElement,
        computeHvacPlacement,
        placePendingHvacElement,
    };
}

export type UseHvacPlacementResult = ReturnType<typeof useHvacPlacement>;
