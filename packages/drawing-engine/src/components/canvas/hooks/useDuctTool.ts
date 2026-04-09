import * as fabric from "fabric";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { HvacElement, Point2D } from "../../../types";
import {
  buildDuctedIndoorUnitModel,
  getDuctedIndoorUnitOpeningPlanProjection,
} from "../hvac/ductedIndoorUnitModel";
import {
  buildGiDuctVisual,
  buildStraightGiDuctElement,
  DEFAULT_GI_DUCT_WALL_THICKNESS_MM,
  isGiDuctElementType,
  type GiDuctKind,
} from "../hvac/giDuctModel";
import type { DuctedIndoorUnitInlineOpeningSpec } from "../hvac/ductedIndoorUnitModel";
import type { HvacPlanRenderer } from "../hvac/HvacPlanRenderer";
import { MM_TO_PX } from "../scale";

interface DuctTarget {
  element: HvacElement;
  kind: GiDuctKind;
  hitStart: Point2D;
  hitEnd: Point2D;
  hitCenter: Point2D;
  origin: Point2D;
  outwardDirection: Point2D;
  openingWidthMm: number;
  outerWidthMm: number;
  outerHeightMm: number;
  wallThicknessMm: number;
  elevationMm: number;
  existingDuct: HvacElement | null;
  currentLengthMm: number;
}

export interface UseDuctToolOptions {
  fabricRef: React.RefObject<fabric.Canvas | null>;
  hvacRendererRef: React.RefObject<HvacPlanRenderer | null>;
  activeTool: string;
  hvacElements: HvacElement[];
  zoom: number;
  addHvacElement: (
    element: Omit<Partial<HvacElement>, "id"> &
      Pick<
        HvacElement,
        "type" | "position" | "width" | "depth" | "height" | "elevation" | "mountType" | "label"
      >,
  ) => string;
  updateHvacElement: (
    id: string,
    updates: Partial<HvacElement>,
    options?: { skipHistory?: boolean },
  ) => void;
  setSelectedIds: (ids: string[]) => void;
  setProcessingStatus: (status: string, isProcessing: boolean) => void;
}

export interface UseDuctToolResult {
  isDrawing: boolean;
  handleMouseDown: (point: Point2D) => void;
  handleMouseMove: (point: Point2D) => void;
  handleDoubleClick: () => void;
  handleKeyDown: (event: KeyboardEvent) => boolean;
  handleKeyUp: (event: KeyboardEvent) => void;
  cancelDrawing: () => void;
}

function rotateVector(point: Point2D, angleDeg: number): Point2D {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function normalize(point: Point2D): Point2D {
  const length = Math.hypot(point.x, point.y);
  if (length < 0.0001) {
    return { x: 0, y: 1 };
  }
  return { x: point.x / length, y: point.y / length };
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point: Point2D, start: Point2D, end: Point2D): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.0001) {
    return distance(point, start);
  }
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(
    point.x - (start.x + dx * t),
    point.y - (start.y + dy * t),
  );
}

function projectLength(anchor: Point2D, direction: Point2D, point: Point2D): number {
  return Math.max(
    0,
    (point.x - anchor.x) * direction.x + (point.y - anchor.y) * direction.y,
  );
}

function findExistingDuctElement(
  hvacElements: HvacElement[],
  sourceElementId: string,
  kind: GiDuctKind,
): HvacElement | null {
  return (
    hvacElements.find((element) => {
      if (!isGiDuctElementType(element.type)) {
        return false;
      }
      const sourceId =
        typeof element.properties.sourceElementId === "string"
          ? element.properties.sourceElementId
          : (element.properties.startConnection as { sourceElementId?: unknown } | undefined)
              ?.sourceElementId;
      const sourceKind =
        element.properties.sourceOpeningKind === "return"
          ? "return"
          : element.properties.sourceOpeningKind === "supply"
            ? "supply"
            : ((element.properties.startConnection as { sourceOpeningKind?: unknown } | undefined)
                ?.sourceOpeningKind === "return"
                ? "return"
                : "supply");
      return sourceId === sourceElementId && sourceKind === kind;
    }) ?? null
  );
}

function resolveExistingDuctLengthMm(
  existingDuct: HvacElement | null,
  origin: Point2D,
  outwardDirection: Point2D,
): number {
  if (!existingDuct) {
    return 0;
  }
  const visual = buildGiDuctVisual(existingDuct);
  const endPoint = visual.routePoints[visual.routePoints.length - 1];
  if (!endPoint) {
    return 0;
  }
  return projectLength(origin, outwardDirection, endPoint);
}

function buildWorldTarget(
  element: HvacElement,
  hvacElements: HvacElement[],
  opening: DuctedIndoorUnitInlineOpeningSpec,
): DuctTarget {
  const model = buildDuctedIndoorUnitModel(element);
  const projection = getDuctedIndoorUnitOpeningPlanProjection(model, opening);
  const center = {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
  };
  const rotation = element.rotation ?? 0;
  const rotateLocalPoint = (point: Point2D): Point2D => {
    const rotated = rotateVector(point, rotation);
    return {
      x: center.x + rotated.x,
      y: center.y + rotated.y,
    };
  };
  const wallThicknessMm = DEFAULT_GI_DUCT_WALL_THICKNESS_MM;
  const outerWidthMm = opening.openingWidth + wallThicknessMm * 2;
  const outerHeightMm = opening.openingHeight + wallThicknessMm * 2;
  const origin = rotateLocalPoint({
    x: opening.x,
    y: projection.collarOuterEdgeY,
  });
  const outwardDirection = normalize(
    rotateVector({ x: 0, y: projection.outwardDirectionY }, rotation),
  );
  const existingDuct = findExistingDuctElement(hvacElements, element.id, opening.kind);

  return {
    element,
    kind: opening.kind,
    hitStart: rotateLocalPoint({
      x: opening.x - opening.openingWidth / 2,
      y: projection.shellFaceY,
    }),
    hitEnd: rotateLocalPoint({
      x: opening.x + opening.openingWidth / 2,
      y: projection.shellFaceY,
    }),
    hitCenter: rotateLocalPoint({
      x: opening.x,
      y: projection.shellFaceY,
    }),
    origin,
    outwardDirection,
    openingWidthMm: opening.openingWidth,
    outerWidthMm,
    outerHeightMm,
    wallThicknessMm,
    elevationMm: element.elevation + opening.z - outerHeightMm / 2,
    existingDuct,
    currentLengthMm: resolveExistingDuctLengthMm(
      existingDuct,
      origin,
      outwardDirection,
    ),
  };
}

export function useDuctTool(options: UseDuctToolOptions): UseDuctToolResult {
  const {
    fabricRef,
    hvacRendererRef,
    activeTool,
    hvacElements,
    zoom,
    addHvacElement,
    updateHvacElement,
    setSelectedIds,
    setProcessingStatus,
  } = options;

  const activeTargetRef = useRef<DuctTarget | null>(null);
  const previewLengthRef = useRef<number>(0);
  const snapMarkerRef = useRef<fabric.Rect | null>(null);

  const ductTargets = useMemo(
    () =>
      hvacElements.flatMap((element) => {
        if (element.type !== "ducted-ac") {
          return [];
        }
        const model = buildDuctedIndoorUnitModel(element);
        return model.airOpenings.map((opening) =>
          buildWorldTarget(element, hvacElements, opening),
        );
      }),
    [hvacElements],
  );

  const clearPreview = useCallback(() => {
    hvacRendererRef.current?.clearPlacementPreview();
  }, [hvacRendererRef]);

  const clearSnapMarker = useCallback(() => {
    const canvas = fabricRef.current;
    const marker = snapMarkerRef.current;
    if (!canvas || !marker) {
      snapMarkerRef.current = null;
      return;
    }
    canvas.remove(marker);
    snapMarkerRef.current = null;
    canvas.requestRenderAll();
  }, [fabricRef]);

  const renderSnapMarker = useCallback(
    (target: DuctTarget | null) => {
      const canvas = fabricRef.current;
      if (!canvas) {
        return;
      }
      if (!target) {
        clearSnapMarker();
        return;
      }

      const thicknessPx = 10;
      const fill =
        target.kind === "supply"
          ? "rgba(96,165,250,0.22)"
          : "rgba(148,163,184,0.22)";
      const stroke =
        target.kind === "supply"
          ? "rgba(37,99,235,0.95)"
          : "rgba(71,85,105,0.95)";
      const angleDeg =
        (Math.atan2(
          target.hitEnd.y - target.hitStart.y,
          target.hitEnd.x - target.hitStart.x,
        ) *
          180) /
        Math.PI;
      let marker = snapMarkerRef.current;

      if (!marker) {
        marker = new fabric.Rect({
          left: target.hitCenter.x * MM_TO_PX,
          top: target.hitCenter.y * MM_TO_PX,
          width: Math.max(target.openingWidthMm * MM_TO_PX, thicknessPx * 2),
          height: thicknessPx,
          originX: "center",
          originY: "center",
          fill,
          stroke,
          strokeWidth: 2,
          angle: angleDeg,
          selectable: false,
          evented: false,
          excludeFromExport: true,
          rx: thicknessPx * 0.45,
          ry: thicknessPx * 0.45,
        });
        snapMarkerRef.current = marker;
        canvas.add(marker);
      } else {
        marker.set({
          left: target.hitCenter.x * MM_TO_PX,
          top: target.hitCenter.y * MM_TO_PX,
          width: Math.max(target.openingWidthMm * MM_TO_PX, thicknessPx * 2),
          height: thicknessPx,
          fill,
          stroke,
          angle: angleDeg,
        });
      }

      canvas.bringObjectToFront(marker);
      canvas.requestRenderAll();
    },
    [clearSnapMarker, fabricRef],
  );

  const findNearestTarget = useCallback(
    (point: Point2D, thresholdMm: number): DuctTarget | null => {
      let bestTarget: DuctTarget | null = null;
      let bestDistance = thresholdMm;

      ductTargets.forEach((target) => {
        const nextDistance = distanceToSegment(point, target.hitStart, target.hitEnd);
        if (nextDistance <= bestDistance) {
          bestDistance = nextDistance;
          bestTarget = target;
        }
      });

      return bestTarget;
    },
    [ductTargets],
  );

  const buildPreviewElement = useCallback(
    (target: DuctTarget, lengthMm: number): HvacElement => {
      const endPoint = {
        x: target.origin.x + target.outwardDirection.x * lengthMm,
        y: target.origin.y + target.outwardDirection.y * lengthMm,
      };
      const previewBase = buildStraightGiDuctElement(
        [target.origin, endPoint],
        {
          ductKind: target.kind,
          outerWidthMm: target.outerWidthMm,
          outerHeightMm: target.outerHeightMm,
          wallThicknessMm: target.wallThicknessMm,
          elevationMm: target.elevationMm,
          startConnection: {
            point: target.origin,
            direction: target.outwardDirection,
            sourceElementId: target.element.id,
            sourceOpeningKind: target.kind,
          },
        },
      );
      return {
        id: target.existingDuct?.id ?? `__duct-preview__-${target.element.id}-${target.kind}`,
        type: previewBase.type,
        category: previewBase.category ?? "accessory",
        subtype: previewBase.subtype,
        modelLabel: previewBase.modelLabel,
        position: previewBase.position,
        rotation: previewBase.rotation ?? 0,
        width: previewBase.width,
        depth: previewBase.depth,
        height: previewBase.height,
        elevation: previewBase.elevation,
        mountType: previewBase.mountType,
        label: previewBase.label,
        supplyZoneRatio: previewBase.supplyZoneRatio ?? 0,
        properties: previewBase.properties ?? {},
      };
    },
    [],
  );

  const renderPreviewForTarget = useCallback(
    (target: DuctTarget, lengthMm: number) => {
      hvacRendererRef.current?.renderElementPreview(
        buildPreviewElement(target, lengthMm),
        true,
      );
    },
    [buildPreviewElement, hvacRendererRef],
  );

  const commitTargetLength = useCallback(
    (target: DuctTarget, lengthMm: number) => {
      const roundedLengthMm = Math.max(60, Math.min(2400, Math.round(lengthMm)));
      const committed = buildPreviewElement(target, roundedLengthMm);
      if (target.existingDuct) {
        updateHvacElement(target.existingDuct.id, {
          position: committed.position,
          rotation: committed.rotation,
          width: committed.width,
          depth: committed.depth,
          height: committed.height,
          elevation: committed.elevation,
          mountType: committed.mountType,
          label: committed.label,
          category: committed.category,
          subtype: committed.subtype,
          modelLabel: committed.modelLabel,
          supplyZoneRatio: committed.supplyZoneRatio,
          properties: committed.properties,
        });
        setSelectedIds([target.existingDuct.id]);
      } else {
        const nextId = addHvacElement(committed);
        setSelectedIds([nextId]);
      }
      setProcessingStatus(
        `${target.kind === "supply" ? "Supply" : "Return"} duct committed at ${roundedLengthMm} mm.`,
        false,
      );
    },
    [
      addHvacElement,
      buildPreviewElement,
      setProcessingStatus,
      setSelectedIds,
      updateHvacElement,
    ],
  );

  const resetDrawing = useCallback(() => {
    activeTargetRef.current = null;
    previewLengthRef.current = 0;
    clearPreview();
    clearSnapMarker();
  }, [clearPreview, clearSnapMarker]);

  const updatePreviewLength = useCallback(
    (point: Point2D) => {
      const target = activeTargetRef.current;
      if (!target) {
        return;
      }
      const nextLengthMm = Math.max(
        0,
        Math.min(2400, projectLength(target.origin, target.outwardDirection, point)),
      );
      previewLengthRef.current = nextLengthMm;
      renderPreviewForTarget(target, nextLengthMm);
      renderSnapMarker(target);
    },
    [renderPreviewForTarget, renderSnapMarker],
  );

  const handleMouseDown = useCallback(
    (point: Point2D) => {
      const thresholdMm = Math.max(36, 120 / Math.max(zoom * MM_TO_PX, 0.01));
      if (!activeTargetRef.current) {
        const nearestTarget = findNearestTarget(point, thresholdMm);
        if (!nearestTarget) {
          setProcessingStatus(
            "Click a ducted AC return or supply mouth to start the GI duct.",
            false,
          );
          return;
        }
        activeTargetRef.current = nearestTarget;
        previewLengthRef.current = nearestTarget.currentLengthMm;
        renderSnapMarker(nearestTarget);
        renderPreviewForTarget(nearestTarget, nearestTarget.currentLengthMm);
        return;
      }

      updatePreviewLength(point);
      commitTargetLength(activeTargetRef.current, previewLengthRef.current);
      resetDrawing();
    },
    [
      commitTargetLength,
      findNearestTarget,
      renderPreviewForTarget,
      renderSnapMarker,
      resetDrawing,
      setProcessingStatus,
      updatePreviewLength,
      zoom,
    ],
  );

  const handleMouseMove = useCallback(
    (point: Point2D) => {
      if (activeTargetRef.current) {
        updatePreviewLength(point);
        return;
      }
      const thresholdMm = Math.max(36, 120 / Math.max(zoom * MM_TO_PX, 0.01));
      renderSnapMarker(findNearestTarget(point, thresholdMm));
    },
    [findNearestTarget, renderSnapMarker, updatePreviewLength, zoom],
  );

  const handleDoubleClick = useCallback(() => {
    const target = activeTargetRef.current;
    if (!target) {
      return;
    }
    commitTargetLength(target, previewLengthRef.current);
    resetDrawing();
  }, [commitTargetLength, resetDrawing]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Enter") {
        return false;
      }
      const target = activeTargetRef.current;
      if (!target) {
        return false;
      }
      commitTargetLength(target, previewLengthRef.current);
      resetDrawing();
      return true;
    },
    [commitTargetLength, resetDrawing],
  );

  const handleKeyUp = useCallback((_event: KeyboardEvent) => {
    // No-op for parity with other tool hooks.
  }, []);

  const cancelDrawing = useCallback(() => {
    resetDrawing();
  }, [resetDrawing]);

  useEffect(() => {
    if (activeTool === "duct") {
      return;
    }
    resetDrawing();
  }, [activeTool, resetDrawing]);

  useEffect(
    () => () => {
      resetDrawing();
    },
    [resetDrawing],
  );

  return {
    isDrawing: activeTargetRef.current !== null,
    handleMouseDown,
    handleMouseMove,
    handleDoubleClick,
    handleKeyDown,
    handleKeyUp,
    cancelDrawing,
  };
}
