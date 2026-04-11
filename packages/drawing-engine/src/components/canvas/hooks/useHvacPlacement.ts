/**
 * useHvacPlacement
 *
 * AC equipment placement and validation on top of existing room/wall geometry.
 */

import { useCallback, useMemo } from 'react';

import type { AcEquipmentDefinition } from '../../../data';
import type { HvacElement, Point2D, Room } from '../../../types';
import { GeometryEngine } from '../../../utils/geometry-engine';
import {
    buildRefrigerantBranchKitViewModel,
    isRefrigerantBranchKitType,
    resolveRefrigerantBranchKitLineSelection,
    type RefrigerantBranchKitLineSelection,
} from '../hvac/refrigerantBranchKitModel';
import {
    findNearestVisibleRefrigerantPipeBundleSegmentTarget,
    findNearestVisibleRefrigerantPipeSegmentTarget,
} from '../hvac/refrigerantPipeRenderState';

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
    widthMm: number;
    depthMm: number;
    heightMm: number;
    placementProperties?: Record<string, unknown>;
}

export interface UseHvacPlacementOptions {
    rooms: Room[];
    hvacElements: HvacElement[];
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

interface BranchKitPlacementGeometry {
    lineSelection: RefrigerantBranchKitLineSelection;
    widthMm: number;
    depthMm: number;
    heightMm: number;
    anchorLocal: Point2D;
    anchorDirectionLocal: Point2D;
    inletLocal: Point2D;
    outletLocal: Point2D;
    requiredBackwardMm: number;
    requiredForwardMm: number;
    requiredSpanMm: number;
}

function readSourceProperties(source: PlacementSource): Record<string, unknown> {
    return 'placementMode' in source
        ? source.defaultProperties ?? {}
        : source.properties ?? {};
}

function rotatePoint(point: Point2D, angleDeg: number): Point2D {
    const radians = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: point.x * cos - point.y * sin,
        y: point.x * sin + point.y * cos,
    };
}

function addPoints(a: Point2D, b: Point2D): Point2D {
    return { x: a.x + b.x, y: a.y + b.y };
}

function subtractPoints(a: Point2D, b: Point2D): Point2D {
    return { x: a.x - b.x, y: a.y - b.y };
}

function scalePoint(point: Point2D, factor: number): Point2D {
    return { x: point.x * factor, y: point.y * factor };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function normalizeAngleDeg(angleDeg: number): number {
    return ((angleDeg % 360) + 360) % 360;
}

function angularDistanceDeg(a: number, b: number): number {
    const delta = Math.abs(normalizeAngleDeg(a) - normalizeAngleDeg(b));
    return Math.min(delta, 360 - delta);
}

function averagePoints(points: Point2D[]): Point2D {
    if (points.length === 0) {
        return { x: 0, y: 0 };
    }
    const sum = points.reduce(
        (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
        { x: 0, y: 0 },
    );
    return {
        x: sum.x / points.length,
        y: sum.y / points.length,
    };
}

function mmDistance(a: Point2D, b: Point2D): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function isOutdoorUnitElement(element: HvacElement): boolean {
    return element.type === 'outdoor-unit' || element.category === 'outdoor-unit';
}

function isIndoorUnitElement(element: HvacElement): boolean {
    return element.category === 'indoor-unit'
        || element.type === 'ducted-ac'
        || element.type === 'ceiling-cassette-ac'
        || element.type === 'ceiling-suspended-ac'
        || element.type === 'wall-mounted-ac'
        || element.type === 'split-ac';
}

function resolveBranchKitRotationWithFlowBias(
    segmentDirection: Point2D,
    anchorDirectionLocal: Point2D,
    source: PlacementSource,
    anchorPoint: Point2D,
    anchorLocal: Point2D,
    branchKitGeometry: BranchKitPlacementGeometry,
    hvacElements: HvacElement[],
): number {
    const segmentAngleDeg = normalizeAngleDeg(
        (Math.atan2(segmentDirection.y, segmentDirection.x) * 180) / Math.PI,
    );
    const anchorAngleDeg = normalizeAngleDeg(
        (Math.atan2(anchorDirectionLocal.y, anchorDirectionLocal.x) * 180) / Math.PI,
    );
    const baseRotationDeg = normalizeAngleDeg(segmentAngleDeg - anchorAngleDeg);
    const candidateRotations = [baseRotationDeg, normalizeAngleDeg(baseRotationDeg + 180)];
    const outdoorCenters = hvacElements
        .filter((element) => isOutdoorUnitElement(element))
        .map((element) => ({
            x: element.position.x + element.width / 2,
            y: element.position.y + element.depth / 2,
        }));
    const indoorCenters = hvacElements
        .filter((element) => isIndoorUnitElement(element))
        .map((element) => ({
            x: element.position.x + element.width / 2,
            y: element.position.y + element.depth / 2,
        }));

    const scoreRotation = (rotationDeg: number): number => {
        const rotatedAnchor = rotatePoint(anchorLocal, rotationDeg);
        const center = subtractPoints(anchorPoint, rotatedAnchor);
        const inletWorld = addPoints(center, rotatePoint(branchKitGeometry.inletLocal, rotationDeg));
        const outletWorld = addPoints(center, rotatePoint(branchKitGeometry.outletLocal, rotationDeg));
        let score = 0;
        if (outdoorCenters.length > 0) {
            const nearestOutdoor = outdoorCenters.reduce((best, point) =>
                mmDistance(point, inletWorld) < mmDistance(best, inletWorld) ? point : best,
            );
            score += mmDistance(nearestOutdoor, outletWorld) - mmDistance(nearestOutdoor, inletWorld);
        }
        if (indoorCenters.length > 0) {
            const nearestIndoor = indoorCenters.reduce((best, point) =>
                mmDistance(point, outletWorld) < mmDistance(best, outletWorld) ? point : best,
            );
            score += mmDistance(nearestIndoor, inletWorld) - mmDistance(nearestIndoor, outletWorld);
        }
        return score;
    };

    const scoreA = scoreRotation(candidateRotations[0]!);
    const scoreB = scoreRotation(candidateRotations[1]!);
    if (Math.abs(scoreA - scoreB) > 0.01) {
        return scoreA >= scoreB ? candidateRotations[0]! : candidateRotations[1]!;
    }

    if ('placementMode' in source) {
        return candidateRotations[0]!;
    }
    const currentRotation = source.rotation ?? candidateRotations[0]!;
    return angularDistanceDeg(candidateRotations[0]!, currentRotation)
        <= angularDistanceDeg(candidateRotations[1]!, currentRotation)
        ? candidateRotations[0]!
        : candidateRotations[1]!;
}

function resolveBranchKitPlacementGeometry(source: PlacementSource): BranchKitPlacementGeometry {
    const model = buildRefrigerantBranchKitViewModel({
        type: 'refrigerant-branch-kit',
        subtype: source.subtype,
        modelLabel: source.modelLabel,
        properties: readSourceProperties(source),
    });
    const lineSelection = resolveRefrigerantBranchKitLineSelection({
        type: 'refrigerant-branch-kit',
        subtype: source.subtype,
        modelLabel: source.modelLabel,
        properties: readSourceProperties(source),
    });
    const lines = lineSelection === 'gas'
        ? [model.gas]
        : lineSelection === 'liquid'
            ? [model.liquid]
            : [model.gas, model.liquid];
    const throughPoints = lines.flatMap((line) => [
        line.inletTerminal.point,
        line.runOutletTerminal.point,
    ]);
    const anchorLocal = averagePoints(throughPoints);
    const anchorDirectionLocal = averagePoints(lines.map((line) => line.runOutletTerminal.direction));
    const inletLocal = averagePoints(lines.map((line) => line.inletTerminal.point));
    const outletLocal = averagePoints(lines.flatMap((line) => [
        line.runOutletTerminal.point,
        line.branchOutletTerminal.point,
    ]));
    const minX = Math.min(...throughPoints.map((terminal) => terminal.x));
    const maxX = Math.max(...throughPoints.map((terminal) => terminal.x));

    return {
        lineSelection,
        widthMm: model.widthMm,
        depthMm: model.depthMm,
        heightMm: model.heightMm,
        anchorLocal,
        anchorDirectionLocal,
        inletLocal,
        outletLocal,
        requiredBackwardMm: anchorLocal.x - minX,
        requiredForwardMm: maxX - anchorLocal.x,
        requiredSpanMm: maxX - minX,
    };
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
    const branchKitGeometry = isRefrigerantBranchKitType(source.type)
        ? resolveBranchKitPlacementGeometry(source)
        : null;
    if ('placementMode' in source) {
        return {
            type: source.type,
            category: source.equipmentCategory,
            subtype: source.subtype,
            modelLabel: source.modelLabel,
            mountType: source.mountType,
            widthMm: branchKitGeometry?.widthMm ?? source.widthMm,
            depthMm: branchKitGeometry?.depthMm ?? source.depthMm,
            heightMm: branchKitGeometry?.heightMm ?? source.heightMm,
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
        widthMm: branchKitGeometry?.widthMm ?? source.width,
        depthMm: branchKitGeometry?.depthMm ?? source.depth,
        heightMm: branchKitGeometry?.heightMm ?? source.height,
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
        hvacElements,
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
        const branchKitGeometry = isRefrigerantBranchKitType(spec.type)
            ? resolveBranchKitPlacementGeometry(source)
            : null;
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
            widthMm: spec.widthMm,
            depthMm: spec.depthMm,
            heightMm: spec.heightMm,
            ...overrides,
        });

        if (branchKitGeometry) {
            const snapThresholdMm = Math.max(160, branchKitGeometry.requiredSpanMm * 0.35);
            const findSnappedSegment = (thresholdMm: number) =>
                branchKitGeometry.lineSelection === 'both'
                ? findNearestVisibleRefrigerantPipeBundleSegmentTarget(
                    hvacElements,
                    point,
                    thresholdMm,
                    { minSegmentLengthMm: branchKitGeometry.requiredSpanMm + 1 },
                )
                : findNearestVisibleRefrigerantPipeSegmentTarget(
                    hvacElements,
                    point,
                    thresholdMm,
                    {
                        lineKind: branchKitGeometry.lineSelection,
                        minSegmentLengthMm: branchKitGeometry.requiredSpanMm + 1,
                    },
                );
            // Cursor-driven branch-kit placement should lock to the nearest valid
            // refrigerant centerline so the preview glides along the run.
            const snappedSegment =
                findSnappedSegment(snapThresholdMm)
                ?? findSnappedSegment(Number.POSITIVE_INFINITY);
            if (!snappedSegment) {
                return defaultResult(point, {
                    invalidReason: 'Branch kit must snap to an existing straight refrigerant pipe run.',
                });
            }
            const snapConnectionKind = 'connectionKind' in snappedSegment
                ? snappedSegment.connectionKind
                : 'field-pipe';

            const projectedDistanceMm = clamp(
                snappedSegment.projectedDistanceMm,
                branchKitGeometry.requiredBackwardMm,
                snappedSegment.segmentLengthMm - branchKitGeometry.requiredForwardMm,
            );
            const anchorPoint = addPoints(
                snappedSegment.segmentStart,
                scalePoint(snappedSegment.direction, projectedDistanceMm),
            );
            const rotationDeg = resolveBranchKitRotationWithFlowBias(
                snappedSegment.direction,
                branchKitGeometry.anchorDirectionLocal,
                source,
                anchorPoint,
                branchKitGeometry.anchorLocal,
                branchKitGeometry,
                hvacElements,
            );
            const center = subtractPoints(
                anchorPoint,
                rotatePoint(branchKitGeometry.anchorLocal, rotationDeg),
            );
            const room = findRoomAtPoint(anchorPoint);

            return defaultResult(center, {
                valid: true,
                center,
                rotationDeg,
                roomId: room?.id ?? null,
                invalidReason: null,
                placementProperties: {
                    branchKitPlacementMode: 'inline-pipe-run',
                    branchKitSnapLineKind: branchKitGeometry.lineSelection,
                    branchKitSnapAnchorLocal: branchKitGeometry.anchorLocal,
                    branchKitSnapSourceElementId: snappedSegment.sourceElementId ?? null,
                    branchKitSnapConnectionKind: snapConnectionKind,
                    branchKitSnapPoint: anchorPoint,
                    branchKitSnapDirection: snappedSegment.direction,
                    branchKitSnapSegmentStart: snappedSegment.segmentStart,
                    branchKitSnapSegmentEnd: snappedSegment.segmentEnd,
                    branchKitSnapProjectedDistanceMm: projectedDistanceMm,
                },
            });
        }

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
    }, [findRoomAtPoint, findWallPlacementSnap, hvacElements, placementRotationDeg]);

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
            width: placement.widthMm,
            depth: placement.depthMm,
            height: placement.heightMm,
            elevation: resolvePlacementSpec(
                pendingPlacementEquipmentDefinition,
                placementRotationDeg,
            ).elevationMm,
            mountType: pendingPlacementEquipmentDefinition.mountType,
            label: pendingPlacementEquipmentDefinition.name,
            roomId: placement.roomId ?? undefined,
            wallId: placement.wallId ?? undefined,
            supplyZoneRatio: pendingPlacementEquipmentDefinition.supplyZoneRatio ?? 0.5,
            properties: {
                definitionId: pendingPlacementEquipmentDefinition.id,
                ...pendingPlacementEquipmentDefinition.defaultProperties,
                ...(placement.placementProperties ?? {}),
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
        placementRotationDeg,
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
