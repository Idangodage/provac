/**
 * HvacPlanRenderer
 *
 * Renders AC/HVAC equipment on the Fabric.js plan canvas.
 */

import * as fabric from "fabric";

import type { AcEquipmentDefinition } from "../../../data";
import type { HvacElement, Point2D } from "../../../types";
import {
  buildCeilingCassetteModel,
  getCeilingCassettePipePortEndpointLocal,
} from "./ceilingCassetteModel";
import {
  buildDuctedIndoorUnitModel,
  DUCTED_INDOOR_UNIT_COLOR_PALETTE,
  getDuctedIndoorUnitOpeningPlanProjection,
  getDuctedIndoorUnitPlanBounds,
} from "./ductedIndoorUnitModel";
import { buildGiDuctVisual, isGiDuctElementType } from "./giDuctModel";
import {
  buildRefrigerantPipeVisual,
  buildRefrigerantPipePairVisual,
  findNearestRefrigerantPipeBundleSegmentTarget,
  findNearestRefrigerantPipeBundleTarget as findNearestRefrigerantPipeBundleTargetFromModel,
  isRefrigerantPipeElementType,
  isRefrigerantPipePairType,
  type RefrigerantPipeBundleConnection,
} from "./refrigerantPipePairModel";
import {
  buildRefrigerantPipeEndpointRenderStateMap,
  buildRefrigerantPipeRenderChainStateMap,
  getVisibleRefrigerantPipeStraightSegmentTargets,
  type RefrigerantPipeEndpointRenderState,
  type RefrigerantPipeRenderChainState,
  type VisibleRefrigerantPipeSegmentTarget,
} from "./refrigerantPipeRenderState";
import {
  buildRefrigerantBranchKitViewModel,
  DEFAULT_REFRIGERANT_BRANCH_KIT_INSULATION_THICKNESS_MM,
  getRefrigerantBranchKitPlanBounds,
  getRefrigerantBranchKitTerminalSpecs,
  isRefrigerantBranchKitElement,
  isRefrigerantBranchKitType,
  resolveRefrigerantBranchKitConnectionIdentity,
  resolveRefrigerantBranchKitInlineAnchorLocal,
  resolveRefrigerantBranchKitLineSelection,
  REFRIGERANT_BRANCH_KIT_COLOR_PALETTE,
  type RefrigerantBranchTerminalRole,
} from "./refrigerantBranchKitModel";
import { DEFAULT_REFRIGERANT_PIPE_GAP_MM } from "./refrigerantPipeDimensions";
import {
  getUnitPipePortEndpointLocal,
  getUnitPipePortRenderMetrics,
  getUnitPipePortSpec,
  GENERIC_PIPE_PORT_TYPES,
  ALL_PIPE_PORT_TYPES,
} from "./unitPipePortModel";
import { MM_TO_PX } from "../scale";
import {
  getCanvasViewportBounds,
  hasMeaningfulViewportZoomChange,
  isViewportBoundsContained,
  type ViewportBounds,
} from "../viewportVisibility";

type NamedObject = fabric.Object & {
  id?: string;
  name?: string;
  hvacElementId?: string;
};

type HvacGroup = fabric.Group & {
  id?: string;
  name?: string;
  hvacElementId?: string;
};

interface SyncHvacElementsOptions {
  force?: boolean;
}

interface VisualPalette {
  stroke: string;
  fill: string;
  detail: string;
  halo: string;
  hover: string;
}

function toCanvas(point: Point2D): Point2D {
  return { x: point.x * MM_TO_PX, y: point.y * MM_TO_PX };
}

function elementCenter(
  element: Pick<HvacElement, "position" | "width" | "depth">,
): Point2D {
  return {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
  };
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

function normalizeDirection(point: Point2D): Point2D {
  const length = Math.hypot(point.x, point.y);
  if (length < 0.0001) {
    return { x: 1, y: 0 };
  }
  return { x: point.x / length, y: point.y / length };
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

function dotProduct(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function normalizeAngleDeg(value: number): number {
  let normalized = value % 360;
  if (normalized < 0) {
    normalized += 360;
  }
  return normalized;
}

function smallestAngleDifferenceDeg(a: number, b: number): number {
  const diff = Math.abs(normalizeAngleDeg(a) - normalizeAngleDeg(b));
  return Math.min(diff, 360 - diff);
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

function normalizePoint(value: unknown): Point2D | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("x" in value) ||
    !("y" in value)
  ) {
    return null;
  }
  const candidate = value as { x?: unknown; y?: unknown };
  if (
    typeof candidate.x !== "number" ||
    !Number.isFinite(candidate.x) ||
    typeof candidate.y !== "number" ||
    !Number.isFinite(candidate.y)
  ) {
    return null;
  }
  return { x: candidate.x, y: candidate.y };
}

function resolveInlineBranchKitRenderCenter(
  element: Pick<HvacElement, "type" | "subtype" | "modelLabel" | "properties" | "rotation">,
  pipeTargets: VisibleRefrigerantPipeSegmentTarget[],
  allElements: HvacElement[],
): { anchorPoint: Point2D; anchorLocal: Point2D; rotationDeg: number } | null {
  if (
    !isRefrigerantBranchKitElement(element) ||
    element.properties.branchKitPlacementMode !== "inline-pipe-run"
  ) {
    return null;
  }
  const initialAnchorPoint = normalizePoint(element.properties.branchKitSnapPoint);
  if (!initialAnchorPoint) {
    return null;
  }
  let anchorPoint: Point2D = initialAnchorPoint;

  const snapSegmentStart = normalizePoint(element.properties.branchKitSnapSegmentStart);
  const snapSegmentEnd = normalizePoint(element.properties.branchKitSnapSegmentEnd);
  const snapProjectedDistanceMm =
    typeof element.properties.branchKitSnapProjectedDistanceMm === "number" &&
    Number.isFinite(element.properties.branchKitSnapProjectedDistanceMm)
      ? element.properties.branchKitSnapProjectedDistanceMm
      : null;
  if (snapSegmentStart && snapSegmentEnd) {
    const segmentDelta = subtractPoints(snapSegmentEnd, snapSegmentStart);
    const segmentLengthMm = Math.hypot(segmentDelta.x, segmentDelta.y);
    if (segmentLengthMm > 0.2) {
      const segmentDirection = {
        x: segmentDelta.x / segmentLengthMm,
        y: segmentDelta.y / segmentLengthMm,
      };
      const projectedMm =
        snapProjectedDistanceMm !== null
          ? Math.min(segmentLengthMm, Math.max(0, snapProjectedDistanceMm))
          : Math.min(
              segmentLengthMm,
              Math.max(
                0,
                dotProduct(
                  subtractPoints(initialAnchorPoint, snapSegmentStart),
                  segmentDirection,
                ),
              ),
            );
      anchorPoint = addPoints(
        snapSegmentStart,
        scalePoint(segmentDirection, projectedMm),
      );
    }
  }

  const model = buildRefrigerantBranchKitViewModel(element);
  const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
  const desiredLineKind = lineSelection === "liquid" ? "liquid" : "gas";
  const sourceElementId =
    typeof element.properties.branchKitSnapSourceElementId === "string"
      ? element.properties.branchKitSnapSourceElementId
      : null;
  const snapDirection = normalizeDirection(
    normalizePoint(element.properties.branchKitSnapDirection) ?? { x: 1, y: 0 },
  );
  let resolvedAxisDirection = snapDirection;

  const modelProjectionElements = (() => {
    if (!sourceElementId) {
      return allElements;
    }
    const byElementId = allElements.filter(
      (candidate) => candidate.id === sourceElementId,
    );
    return byElementId.length > 0 ? byElementId : allElements;
  })();
  const modelProjection =
    modelProjectionElements.length > 0
      ? findNearestRefrigerantPipeBundleSegmentTarget(
          modelProjectionElements,
          anchorPoint,
          sourceElementId ? 120 : 64,
          { minSegmentLengthMm: 30 },
        )
      : null;
  if (modelProjection) {
    anchorPoint = desiredLineKind === "liquid"
      ? modelProjection.liquidPoint
      : modelProjection.gasPoint;
    resolvedAxisDirection =
      dotProduct(modelProjection.direction, snapDirection) >= 0
        ? modelProjection.direction
        : scalePoint(modelProjection.direction, -1);
  }
  const matchingTargets = pipeTargets.filter(
    (target) =>
      target.lineKind === desiredLineKind &&
      (!sourceElementId ||
        target.elementId === sourceElementId ||
        target.bundleId === sourceElementId),
  );
  const fallbackTargets = sourceElementId
    ? pipeTargets.filter((target) => target.lineKind === desiredLineKind)
    : matchingTargets;
  const targets = matchingTargets.length > 0 ? matchingTargets : fallbackTargets;
  if (!modelProjection && targets.length > 0) {
    let bestPoint: Point2D | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestDirection: Point2D | null = null;
    for (const target of targets) {
      const segmentDx = target.end.x - target.start.x;
      const segmentDy = target.end.y - target.start.y;
      const segmentLength = Math.hypot(segmentDx, segmentDy);
      if (segmentLength <= 0.2) {
        continue;
      }
      const direction = { x: segmentDx / segmentLength, y: segmentDy / segmentLength };
      const projectedMm = Math.min(
        segmentLength,
        Math.max(0, dotProduct(subtractPoints(anchorPoint, target.start), direction)),
      );
      const projectedPoint = addPoints(target.start, scalePoint(direction, projectedMm));
      const distanceMm = Math.hypot(
        projectedPoint.x - anchorPoint.x,
        projectedPoint.y - anchorPoint.y,
      );
      const directionPenalty = (1 - Math.abs(dotProduct(direction, snapDirection))) * 36;
      const score = distanceMm + directionPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestPoint = projectedPoint;
        bestDirection =
          dotProduct(direction, snapDirection) >= 0
            ? direction
            : scalePoint(direction, -1);
      }
    }
    const maxReprojectScoreMm = sourceElementId ? 60 : 24;
    if (bestPoint && bestScore <= maxReprojectScoreMm) {
      anchorPoint = bestPoint;
      if (bestDirection) {
        resolvedAxisDirection = bestDirection;
      }
    }
  }

  const anchorLocal = resolveStableInlineBranchKitAnchorLocal(
    element,
    model,
    lineSelection,
  );
  const fallbackRotationDeg = element.rotation ?? 0;
  const axisAngleDeg = normalizeAngleDeg(
    (Math.atan2(resolvedAxisDirection.y, resolvedAxisDirection.x) * 180) / Math.PI,
  );
  const candidateRotationA = axisAngleDeg;
  const candidateRotationB = normalizeAngleDeg(axisAngleDeg + 180);
  const rotationDeg =
    smallestAngleDifferenceDeg(candidateRotationA, fallbackRotationDeg)
      <= smallestAngleDifferenceDeg(candidateRotationB, fallbackRotationDeg)
      ? candidateRotationA
      : candidateRotationB;

  return { anchorPoint, anchorLocal, rotationDeg };
}

function resolveBranchKitAnchorLocal(
  model: ReturnType<typeof buildRefrigerantBranchKitViewModel>,
  lineSelection: ReturnType<typeof resolveRefrigerantBranchKitLineSelection>,
): Point2D {
  return resolveRefrigerantBranchKitInlineAnchorLocal(model, lineSelection);
}

function resolveStableInlineBranchKitAnchorLocal(
  element: Pick<HvacElement, "properties">,
  model: ReturnType<typeof buildRefrigerantBranchKitViewModel>,
  lineSelection: ReturnType<typeof resolveRefrigerantBranchKitLineSelection>,
): Point2D {
  const canonicalAnchorLocal = resolveBranchKitAnchorLocal(model, lineSelection);
  const storedAnchorLocal = normalizePoint(element.properties.branchKitSnapAnchorLocal);
  if (!storedAnchorLocal) {
    return canonicalAnchorLocal;
  }
  const MAX_INLINE_ANCHOR_LOCAL_DRIFT_MM = 1;
  const driftMm = Math.hypot(
    storedAnchorLocal.x - canonicalAnchorLocal.x,
    storedAnchorLocal.y - canonicalAnchorLocal.y,
  );
  return driftMm <= MAX_INLINE_ANCHOR_LOCAL_DRIFT_MM
    ? storedAnchorLocal
    : canonicalAnchorLocal;
}

type PipeTrimWindow = {
  anchorPoint: Point2D;
  direction: Point2D;
  backwardMm: number;
  forwardMm: number;
};

function appendUniquePolylinePoint(points: Point2D[], point: Point2D): void {
  const previous = points[points.length - 1];
  if (
    previous &&
    Math.hypot(previous.x - point.x, previous.y - point.y) <= 0.2
  ) {
    return;
  }
  points.push(point);
}

function trimPolylineWithWindow(
  points: Point2D[],
  window: PipeTrimWindow,
): Point2D[][] {
  if (
    points.length < 2 ||
    (window.backwardMm <= 0.1 && window.forwardMm <= 0.1)
  ) {
    return [points];
  }

  let bestSegmentIndex = -1;
  let bestProjectionMm = 0;
  let bestDistanceMm = 10;

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const delta = subtractPoints(end, start);
    const lengthMm = Math.hypot(delta.x, delta.y);
    if (lengthMm <= 0.2) {
      continue;
    }
    const segmentDirection = normalizeDirection(delta);
    if (Math.abs(dotProduct(segmentDirection, window.direction)) < 0.985) {
      continue;
    }
    const projectedMm = Math.min(
      lengthMm,
      Math.max(0, dotProduct(subtractPoints(window.anchorPoint, start), segmentDirection)),
    );
    const projectedPoint = addPoints(
      start,
      scalePoint(segmentDirection, projectedMm),
    );
    const distanceMm = Math.hypot(
      projectedPoint.x - window.anchorPoint.x,
      projectedPoint.y - window.anchorPoint.y,
    );
    if (distanceMm >= bestDistanceMm) {
      continue;
    }
    bestDistanceMm = distanceMm;
    bestSegmentIndex = index;
    bestProjectionMm = projectedMm;
  }

  if (bestSegmentIndex < 0) {
    return [points];
  }

  const segmentStart = points[bestSegmentIndex]!;
  const segmentEnd = points[bestSegmentIndex + 1]!;
  const segmentDirection = normalizeDirection(
    subtractPoints(segmentEnd, segmentStart),
  );
  const segmentLengthMm = Math.hypot(
    segmentEnd.x - segmentStart.x,
    segmentEnd.y - segmentStart.y,
  );
  const cutStartMm = Math.max(0, bestProjectionMm - window.backwardMm);
  const cutEndMm = Math.min(segmentLengthMm, bestProjectionMm + window.forwardMm);
  if (cutEndMm - cutStartMm <= 0.2) {
    return [points];
  }

  const beforePoints: Point2D[] = [];
  for (let index = 0; index <= bestSegmentIndex; index += 1) {
    appendUniquePolylinePoint(beforePoints, points[index]!);
  }
  if (cutStartMm > 0.2) {
    appendUniquePolylinePoint(
      beforePoints,
      addPoints(segmentStart, scalePoint(segmentDirection, cutStartMm)),
    );
  }

  const afterPoints: Point2D[] = [];
  if (cutEndMm < segmentLengthMm - 0.2) {
    appendUniquePolylinePoint(
      afterPoints,
      addPoints(segmentStart, scalePoint(segmentDirection, cutEndMm)),
    );
  }
  for (let index = bestSegmentIndex + 1; index < points.length; index += 1) {
    appendUniquePolylinePoint(afterPoints, points[index]!);
  }

  return [beforePoints, afterPoints].filter((polyline) => polyline.length >= 2);
}

function trimPolylineWithWindows(
  points: Point2D[],
  windows: PipeTrimWindow[],
): Point2D[][] {
  return windows.reduce<Point2D[][]>(
    (polylines, window) =>
      polylines.flatMap((polyline) => trimPolylineWithWindow(polyline, window)),
    [points],
  );
}

function trimPolylineEndLocal(
  points: Point2D[],
  trimLengthMm: number,
): Point2D[] {
  if (points.length < 2 || trimLengthMm <= 0.01) {
    return points;
  }

  const segmentLengths: number[] = [];
  let totalLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    segmentLengths.push(length);
    totalLength += length;
  }

  const targetLength = Math.max(totalLength - trimLengthMm, 0);
  if (targetLength <= 0.01) {
    return [points[0]!];
  }
  if (targetLength >= totalLength - 0.01) {
    return points;
  }

  const trimmed: Point2D[] = [points[0]!];
  let traversed = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const length = segmentLengths[index - 1]!;
    if (traversed + length < targetLength - 0.01) {
      trimmed.push(end);
      traversed += length;
      continue;
    }

    const remaining = targetLength - traversed;
    const t = length > 0.01 ? remaining / length : 0;
    trimmed.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    });
    break;
  }

  return trimmed;
}

function clampFontSize(widthPx: number): number {
  return Math.max(8, Math.min(11, widthPx * 0.08));
}

export class HvacPlanRenderer {
  private canvas: fabric.Canvas;
  private groups = new Map<string, HvacGroup>();
  private hvacData = new Map<string, HvacElement>();
  private pipeEndpointStateMap = new Map<
    string,
    RefrigerantPipeEndpointRenderState
  >();
  private pipeRenderChainStateMap = new Map<
    string,
    RefrigerantPipeRenderChainState
  >();
  private selectedIds = new Set<string>();
  private hoveredId: string | null = null;
  private placementPreview: HvacGroup[] = [];
  private lastVisibilityBounds: ViewportBounds | null = null;
  private lastVisibilityZoom: number | null = null;

  constructor(canvas: fabric.Canvas) {
    this.canvas = canvas;
  }

  private annotate(
    target: fabric.FabricObject,
    hvacElementId: string,
    name?: string,
  ): void {
    const typed = target as NamedObject;
    typed.hvacElementId = hvacElementId;
    typed.id = hvacElementId;
    target.set("objectCaching", false);
    if (name) {
      typed.name = name;
    }
  }

  private getPalette(
    element: Pick<HvacElement, "type" | "category">,
    valid: boolean,
  ): VisualPalette {
    if (!valid) {
      return {
        stroke: "#B91C1C",
        fill: "rgba(185,28,28,0.08)",
        detail: "rgba(185,28,28,0.75)",
        halo: "#DC2626",
        hover: "#F97316",
      };
    }

    switch (element.type) {
      case "outdoor-unit":
        return {
          stroke: "#0F766E",
          fill: "rgba(15,118,110,0.10)",
          detail: "rgba(15,118,110,0.85)",
          halo: "#0F766E",
          hover: "#14B8A6",
        };
      case "remote-controller":
      case "control-panel":
        return {
          stroke: "#B45309",
          fill: "rgba(180,83,9,0.10)",
          detail: "rgba(146,64,14,0.85)",
          halo: "#D97706",
          hover: "#F59E0B",
        };
      case "filter":
      case "accessory":
      case "duct":
      case "refrigerant-pipe":
      case "refrigerant-pipe-pair":
      case "refrigerant-branch-kit":
        return {
          stroke: "#475569",
          fill: "rgba(71,85,105,0.08)",
          detail: "rgba(71,85,105,0.78)",
          halo: "#475569",
          hover: "#0EA5E9",
        };
      default:
        return {
          stroke: "#1D4ED8",
          fill: "rgba(37,99,235,0.08)",
          detail: "rgba(37,99,235,0.80)",
          halo: "#1D4ED8",
          hover: "#059669",
        };
    }
  }

  private removeElement(id: string): void {
    const group = this.groups.get(id);
    if (group) {
      this.canvas.remove(group);
      this.groups.delete(id);
    }
    this.hvacData.delete(id);
    this.selectedIds.delete(id);
    if (this.hoveredId === id) {
      this.hoveredId = null;
    }
  }

  private hvacElementNeedsRerender(
    previousElement: HvacElement | undefined,
    nextElement: HvacElement,
  ): boolean {
    return previousElement !== nextElement;
  }

  private rebuildRefrigerantPipeRenderStateMaps(elements: HvacElement[]): void {
    this.pipeEndpointStateMap =
      buildRefrigerantPipeEndpointRenderStateMap(elements);
    this.pipeRenderChainStateMap = buildRefrigerantPipeRenderChainStateMap(
      elements,
      this.pipeEndpointStateMap,
    );
  }

  private getInlineBranchKitTrimWindows(
    sourceIds: Set<string>,
    lineKind: "gas" | "liquid",
  ): PipeTrimWindow[] {
    const windows: PipeTrimWindow[] = [];
    const allElements = Array.from(this.hvacData.values());
    const pipeTargets = getVisibleRefrigerantPipeStraightSegmentTargets(allElements);

    this.hvacData.forEach((element) => {
      if (
        !isRefrigerantBranchKitElement(element) ||
        element.properties.branchKitPlacementMode !== "inline-pipe-run"
      ) {
        return;
      }
      const sourceElementId =
        typeof element.properties.branchKitSnapSourceElementId === "string"
          ? element.properties.branchKitSnapSourceElementId
          : null;
      if (!sourceElementId || !sourceIds.has(sourceElementId)) {
        return;
      }

      const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
      if (lineSelection !== "both" && lineSelection !== lineKind) {
        return;
      }

      const inlineResult = resolveInlineBranchKitRenderCenter(
        element,
        pipeTargets,
        allElements,
      );
      if (!inlineResult) {
        return;
      }
      const branchKit = buildRefrigerantBranchKitViewModel(element);
      const inlineCenter = subtractPoints(
        inlineResult.anchorPoint,
        rotatePoint(inlineResult.anchorLocal, inlineResult.rotationDeg),
      );
      const lineAnchorLocal = resolveBranchKitAnchorLocal(
        branchKit,
        lineKind === "liquid" ? "liquid" : "gas",
      );
      const anchorPoint = addPoints(
        inlineCenter,
        rotatePoint(lineAnchorLocal, inlineResult.rotationDeg),
      );
      const selectedLine =
        lineSelection === "gas"
          ? branchKit.gas
          : lineSelection === "liquid"
            ? branchKit.liquid
            : lineKind === "gas"
              ? branchKit.gas
              : branchKit.liquid;

      const localAxis = normalizeDirection(
        subtractPoints(
          selectedLine.runOutletTerminal.point,
          selectedLine.inletTerminal.point,
        ),
      );
      const direction = normalizeDirection(
        rotatePoint(localAxis, inlineResult.rotationDeg),
      );
      const insulatedMainPoints = trimPolylineEndLocal(
        selectedLine.mainTube.points,
        selectedLine.runOutletTerminal.socketLengthMm,
      );
      const insulatedPoints = [
        ...selectedLine.inletRunTube.points,
        ...insulatedMainPoints,
      ];
      const projectedScalars = insulatedPoints.map((localPoint) =>
        dotProduct(
          subtractPoints(localPoint, {
            x:
              (selectedLine.inletTerminal.point.x +
                selectedLine.runOutletTerminal.point.x) /
              2,
            y:
              (selectedLine.inletTerminal.point.y +
                selectedLine.runOutletTerminal.point.y) /
              2,
          }),
          localAxis,
        ),
      );
      if (projectedScalars.length === 0) {
        return;
      }
      const minScalar = Math.min(...projectedScalars);
      const maxScalar = Math.max(...projectedScalars);
      const backwardMm = Math.max(0, -minScalar);
      const forwardMm = Math.max(0, maxScalar);
      if (backwardMm <= 0.2 && forwardMm <= 0.2) {
        return;
      }

      windows.push({
        anchorPoint,
        direction,
        backwardMm,
        forwardMm,
      });
    });

    return windows;
  }

  private isObjectVisibleInViewport(
    object: fabric.FabricObject,
    bounds: ViewportBounds,
  ): boolean {
    const rect = object.getBoundingRect();
    return !(
      rect.left + rect.width < bounds.left ||
      rect.left > bounds.right ||
      rect.top + rect.height < bounds.top ||
      rect.top > bounds.bottom
    );
  }

  refreshViewportVisibility(force: boolean = false): void {
    const visibleBounds = getCanvasViewportBounds(this.canvas, 96);
    const actualBounds = getCanvasViewportBounds(this.canvas, 0);
    if (!visibleBounds || !actualBounds) {
      return;
    }
    const zoom = Math.max(this.canvas.getZoom(), 0.01);
    if (
      !force &&
      this.lastVisibilityBounds &&
      !hasMeaningfulViewportZoomChange(this.lastVisibilityZoom, zoom) &&
      isViewportBoundsContained(actualBounds, this.lastVisibilityBounds)
    ) {
      return;
    }

    this.lastVisibilityBounds = visibleBounds;
    this.lastVisibilityZoom = zoom;
    this.groups.forEach((group) => {
      const visible = this.isObjectVisibleInViewport(group, visibleBounds);
      if (group.visible !== visible) {
        group.set("visible", visible);
        group.set("dirty", true);
      }
    });
  }

  private syncHvacVisualState(): void {
    this.groups.forEach((group, id) => {
      const selectionHalos = group
        .getObjects()
        .filter((obj) => (obj as NamedObject).name === "hvac-selection");
      const hoverHalos = group
        .getObjects()
        .filter((obj) => (obj as NamedObject).name === "hvac-hover");
      selectionHalos.forEach((selectionHalo) => {
        selectionHalo.set("visible", this.selectedIds.has(id));
      });
      hoverHalos.forEach((hoverHalo) => {
        hoverHalo.set(
          "visible",
          this.hoveredId === id && !this.selectedIds.has(id),
        );
      });
      group.set("dirty", true);
    });
    this.bringPipeElementsToFront();
  }

  private bringPipeElementsToFront(): void {
    this.groups.forEach((group, id) => {
      const element = this.hvacData.get(id);
      if (
        element &&
        (isRefrigerantPipeElementType(element.type) ||
          isGiDuctElementType(element.type) ||
          isRefrigerantBranchKitElement(element))
      ) {
        this.canvas.bringObjectToFront(group);
      }
    });
    this.placementPreview.forEach((group) =>
      this.canvas.bringObjectToFront(group),
    );
  }

  private getRenderedPortEndpointMm(
    group: HvacGroup,
    objectName: string,
  ): Point2D | null {
    const portObject = group
      .getObjects()
      .find((obj) => (obj as NamedObject).name === objectName) as
      | fabric.Rect
      | undefined;
    if (
      !portObject ||
      typeof portObject.getPointByOrigin !== "function"
    ) {
      return null;
    }
    const centerInParentPlane = portObject.getRelativeCenterPoint();
    const halfLengthPx =
      (typeof portObject.width === "number" ? portObject.width : 0) *
      (typeof portObject.scaleX === "number" ? portObject.scaleX : 1) *
      0.5;
    const portAngleDeg =
      typeof portObject.angle === "number" ? portObject.angle : 0;
    const endpointInParentPlane = {
      x:
        centerInParentPlane.x +
        Math.cos((portAngleDeg * Math.PI) / 180) * halfLengthPx,
      y:
        centerInParentPlane.y +
        Math.sin((portAngleDeg * Math.PI) / 180) * halfLengthPx,
    };
    const endpointPx = portObject.group
      ? (() => {
          const matrix = portObject.group.calcTransformMatrix();
          return {
            x:
              matrix[0] * endpointInParentPlane.x +
              matrix[2] * endpointInParentPlane.y +
              matrix[4],
            y:
              matrix[1] * endpointInParentPlane.x +
              matrix[3] * endpointInParentPlane.y +
              matrix[5],
          };
        })()
      : endpointInParentPlane;
    if (
      !endpointPx ||
      !Number.isFinite(endpointPx.x) ||
      !Number.isFinite(endpointPx.y)
    ) {
      return null;
    }
    return {
      x: endpointPx.x / MM_TO_PX,
      y: endpointPx.y / MM_TO_PX,
    };
  }

  private getRenderedObjectCenterMm(
    group: HvacGroup,
    objectName: string,
  ): Point2D | null {
    const object = group
      .getObjects()
      .find((obj) => (obj as NamedObject).name === objectName);
    if (!object || typeof object.getRelativeCenterPoint !== "function") {
      return null;
    }

    const centerInParentPlane = object.getRelativeCenterPoint();
    const centerPx = object.group
      ? (() => {
          const matrix = object.group.calcTransformMatrix();
          return {
            x:
              matrix[0] * centerInParentPlane.x +
              matrix[2] * centerInParentPlane.y +
              matrix[4],
            y:
              matrix[1] * centerInParentPlane.x +
              matrix[3] * centerInParentPlane.y +
              matrix[5],
          };
        })()
      : centerInParentPlane;

    if (!Number.isFinite(centerPx.x) || !Number.isFinite(centerPx.y)) {
      return null;
    }

    return {
      x: centerPx.x / MM_TO_PX,
      y: centerPx.y / MM_TO_PX,
    };
  }

  public findNearestRenderedRefrigerantPipeBundleTarget(
    point: Point2D,
    thresholdMm: number,
  ): RefrigerantPipeBundleConnection | null {
    let bestTarget: RefrigerantPipeBundleConnection | null = null;
    let bestDistance = thresholdMm;
    const renderedPipeEndpoints: Array<{
      key: string;
      elementId: string;
      bundleId?: string;
      lineKind: "gas" | "liquid";
      point: Point2D;
      direction: Point2D;
      elevationMm: number;
      outerDiameterMm: number;
    }> = [];
    const pipeTargets = getVisibleRefrigerantPipeStraightSegmentTargets(
      Array.from(this.hvacData.values()),
    );
    const CENTERLINE_IDENTITY_TOLERANCE_MM = 1;

    this.groups.forEach((group, id) => {
      const element = this.hvacData.get(id);
      if (!element) {
        return;
      }

      if (element.type === "refrigerant-pipe") {
        const visual = buildRefrigerantPipeVisual(element);
        const chainState = this.pipeRenderChainStateMap.get(element.id) ?? null;
        if (chainState && !chainState.renderAsHead) {
          return;
        }
        const startPoint = this.getRenderedObjectCenterMm(group, "hvac-snap-start");
        const endPoint = this.getRenderedObjectCenterMm(group, "hvac-snap-end");
        const outerPoints = chainState?.outerPoints ?? visual.outerPoints;
        const headElement =
          chainState ? this.hvacData.get(chainState.headId) ?? element : element;
        const tailElement =
          chainState ? this.hvacData.get(chainState.tailId) ?? element : element;
        const headVisual = chainState
          ? buildRefrigerantPipeVisual(headElement)
          : visual;
        const tailVisual = chainState
          ? buildRefrigerantPipeVisual(tailElement)
          : visual;
        const lineKind = chainState?.lineKind ?? visual.lineKind;
        const outerDiameterMm = chainState
          ? chainState.outerRadiusMm * 2
          : visual.outerDiameterMm;
        const elevationMm = chainState
          ? chainState.elevationMm
          : element.elevation + visual.localZMm;

        if (!headVisual.startConnection && startPoint && outerPoints.length >= 2) {
          const nextPoint = outerPoints[1]!;
          const firstPoint = outerPoints[0]!;
          renderedPipeEndpoints.push({
            key: `${element.id}:start`,
            elementId: element.id,
            bundleId: visual.bundleId,
            lineKind,
            point: startPoint,
            direction: {
              x: (firstPoint.x - nextPoint.x) / Math.max(Math.hypot(firstPoint.x - nextPoint.x, firstPoint.y - nextPoint.y), 0.0001),
              y: (firstPoint.y - nextPoint.y) / Math.max(Math.hypot(firstPoint.x - nextPoint.x, firstPoint.y - nextPoint.y), 0.0001),
            },
            elevationMm,
            outerDiameterMm,
          });
        }

        if (!tailVisual.endConnection && endPoint && outerPoints.length >= 2) {
          const lastPoint = outerPoints[outerPoints.length - 1]!;
          const previousPoint = outerPoints[outerPoints.length - 2]!;
          renderedPipeEndpoints.push({
            key: `${element.id}:end`,
            elementId: element.id,
            bundleId: visual.bundleId,
            lineKind,
            point: endPoint,
            direction: {
              x: (lastPoint.x - previousPoint.x) / Math.max(Math.hypot(lastPoint.x - previousPoint.x, lastPoint.y - previousPoint.y), 0.0001),
              y: (lastPoint.y - previousPoint.y) / Math.max(Math.hypot(lastPoint.x - previousPoint.x, lastPoint.y - previousPoint.y), 0.0001),
            },
            elevationMm,
            outerDiameterMm,
          });
        }
        return;
      }

      if (isRefrigerantBranchKitElement(element)) {
        const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
        const branchKit = buildRefrigerantBranchKitViewModel(element);
        const inlineResult = resolveInlineBranchKitRenderCenter(
          element,
          pipeTargets,
          Array.from(this.hvacData.values()),
        );
        const identityCenter = inlineResult
          ? subtractPoints(
              inlineResult.anchorPoint,
              rotatePoint(inlineResult.anchorLocal, inlineResult.rotationDeg),
            )
          : null;
        const renderedBranchCenter = identityCenter ??
          this.getRenderedObjectCenterMm(group, "hvac-branch-center-snap") ??
          this.getRenderedObjectCenterMm(group, "hvac-branch-center-snap-visible") ??
          {
            x: element.position.x + element.width / 2,
            y: element.position.y + element.depth / 2,
          };
        const roles: RefrigerantBranchTerminalRole[] = [
          "inlet",
          "run-outlet",
          "branch-outlet",
        ];

        roles.forEach((role) => {
          const identity = resolveRefrigerantBranchKitConnectionIdentity({
            model: branchKit,
            role,
            lineSelection,
            worldCenter: renderedBranchCenter,
            rotationDeg: element.rotation ?? 0,
          });
          if (!identity) {
            return;
          }

          const renderedGasSnap = this.getRenderedObjectCenterMm(
            group,
            `hvac-branch-snap-gas-${role}`,
          );
          const renderedLiquidSnap = this.getRenderedObjectCenterMm(
            group,
            `hvac-branch-snap-liquid-${role}`,
          );
          const gasSnapDeltaMm = renderedGasSnap
            ? Math.hypot(
                renderedGasSnap.x - identity.gasPoint.x,
                renderedGasSnap.y - identity.gasPoint.y,
              )
            : 0;
          const liquidSnapDeltaMm = renderedLiquidSnap
            ? Math.hypot(
                renderedLiquidSnap.x - identity.liquidPoint.x,
                renderedLiquidSnap.y - identity.liquidPoint.y,
              )
            : 0;
          let shouldLogCenterlineMismatch = false;
          if (typeof window !== "undefined") {
            try {
              shouldLogCenterlineMismatch =
                window.localStorage.getItem("hvac.pipe.debug") === "1" ||
                (window as unknown as { __HVAC_PIPE_ROUTING_DEBUG__?: boolean })
                  .__HVAC_PIPE_ROUTING_DEBUG__ === true;
            } catch {
              shouldLogCenterlineMismatch = false;
            }
          }
          if (
            shouldLogCenterlineMismatch &&
            (
              gasSnapDeltaMm > CENTERLINE_IDENTITY_TOLERANCE_MM ||
              liquidSnapDeltaMm > CENTERLINE_IDENTITY_TOLERANCE_MM
            )
          ) {
            // eslint-disable-next-line no-console
            console.warn("[hvac-centerline] branch snap mismatch", {
              elementId: element.id,
              role,
              lineSelection,
              gasSnapDeltaMm,
              liquidSnapDeltaMm,
            });
          }

          const gasTerminal = identity.gasTerminal;
          const liquidTerminal = identity.liquidTerminal;
          const gasPoint = identity.gasPoint;
          const liquidPoint = identity.liquidPoint;
          const gasDirection = identity.gasDirection;
          const liquidDirection = identity.liquidDirection;
          const averageDirection = identity.direction;
          const guideReference = identity.guideReference;

          const gasDistance = Math.hypot(
            gasPoint.x - point.x,
            gasPoint.y - point.y,
          );
          const liquidDistance = Math.hypot(
            liquidPoint.x - point.x,
            liquidPoint.y - point.y,
          );
          const nearestDistance = Math.min(gasDistance, liquidDistance);
          if (nearestDistance > bestDistance) {
            return;
          }

          bestDistance = nearestDistance;
          bestTarget = {
            point: {
              x: (gasPoint.x + liquidPoint.x) / 2,
              y: (gasPoint.y + liquidPoint.y) / 2,
            },
            gasPoint,
            liquidPoint,
            gasFieldPoint: gasPoint,
            liquidFieldPoint: liquidPoint,
            gasOuterDiameterMm: gasTerminal.outerDiameterMm,
            liquidOuterDiameterMm: liquidTerminal.outerDiameterMm,
            gasDirection,
            liquidDirection,
            direction: averageDirection,
            elevationMm:
              element.elevation +
              (branchKit.gas.centerlineZMm + branchKit.liquid.centerlineZMm) / 2,
            gasElevationMm: element.elevation + branchKit.gas.centerlineZMm,
            liquidElevationMm: element.elevation + branchKit.liquid.centerlineZMm,
            connectionKind: "field-pipe",
            guideReference,
            sourceElementId: element.id,
            terminalRole: role,
          };
        });
        return;
      }

      if (!ALL_PIPE_PORT_TYPES.has(element.type)) {
        return;
      }

      const gasPoint =
        this.getRenderedObjectCenterMm(group, "hvac-snap-gas") ??
        this.getRenderedPortEndpointMm(group, "hvac-port-gas-pipe");
      const liquidPoint =
        this.getRenderedObjectCenterMm(group, "hvac-snap-liquid") ??
        this.getRenderedPortEndpointMm(group, "hvac-port-liquid-pipe");
      if (!gasPoint || !liquidPoint) {
        return;
      }

      let gasOuterDiameterMm: number;
      let liquidOuterDiameterMm: number;
      let gasElevationMm: number;
      let liquidElevationMm: number;
      let localDirection: Point2D = { x: 1, y: 0 };

      if (element.type === "ceiling-cassette-ac") {
        const cassette = buildCeilingCassetteModel(element);
        const gasPort = cassette.pipePorts.find((port) => port.kind === "gas");
        const liquidPort = cassette.pipePorts.find(
          (port) => port.kind === "liquid",
        );
        if (!gasPort || !liquidPort) {
          return;
        }
        gasOuterDiameterMm = gasPort.radius * 2;
        liquidOuterDiameterMm = liquidPort.radius * 2;
        gasElevationMm = element.elevation + gasPort.z;
        liquidElevationMm = element.elevation + liquidPort.z;
      } else {
        const portSpec = getUnitPipePortSpec(element);
        if (!portSpec) {
          return;
        }
        const gasPort = portSpec.ports.find((p) => p.kind === "gas");
        const liquidPort = portSpec.ports.find((p) => p.kind === "liquid");
        if (!gasPort || !liquidPort) {
          return;
        }
        gasOuterDiameterMm = gasPort.radius * 2;
        liquidOuterDiameterMm = liquidPort.radius * 2;
        gasElevationMm = element.elevation + gasPort.localZ;
        liquidElevationMm = element.elevation + liquidPort.localZ;
        localDirection = portSpec.localDirection;
      }

      const direction = normalizeDirection(
        rotatePoint(localDirection, element.rotation ?? 0),
      );
      const gasDistance = Math.hypot(
        gasPoint.x - point.x,
        gasPoint.y - point.y,
      );
      const liquidDistance = Math.hypot(
        liquidPoint.x - point.x,
        liquidPoint.y - point.y,
      );
      const bundleCenter = {
        x: (gasPoint.x + liquidPoint.x) / 2,
        y: (gasPoint.y + liquidPoint.y) / 2,
      };
      const nearestDistance = Math.min(gasDistance, liquidDistance);

      if (nearestDistance <= bestDistance) {
        bestDistance = nearestDistance;
        bestTarget = {
          point: bundleCenter,
          gasPoint,
          liquidPoint,
          gasFieldPoint: gasPoint,
          liquidFieldPoint: liquidPoint,
          gasOuterDiameterMm,
          liquidOuterDiameterMm,
          gasDirection: direction,
          liquidDirection: direction,
          direction,
          elevationMm: (gasElevationMm + liquidElevationMm) / 2,
          gasElevationMm,
          liquidElevationMm,
          connectionKind: "unit-port",
          sourceElementId: element.id,
        };
      }
    });

    const gasEndpoints = renderedPipeEndpoints.filter(
      (endpoint) => endpoint.lineKind === "gas",
    );
    const liquidEndpoints = renderedPipeEndpoints.filter(
      (endpoint) => endpoint.lineKind === "liquid",
    );
    const fieldCandidates: Array<{
      gas: (typeof renderedPipeEndpoints)[number];
      liquid: (typeof renderedPipeEndpoints)[number];
      score: number;
    }> = [];

    gasEndpoints.forEach((gasEndpoint) => {
      liquidEndpoints.forEach((liquidEndpoint) => {
        const directionDot =
          gasEndpoint.direction.x * liquidEndpoint.direction.x +
          gasEndpoint.direction.y * liquidEndpoint.direction.y;
        if (directionDot < 0.92) {
          return;
        }

        const delta = {
          x: liquidEndpoint.point.x - gasEndpoint.point.x,
          y: liquidEndpoint.point.y - gasEndpoint.point.y,
        };
        const distanceMm = Math.hypot(delta.x, delta.y);
        if (distanceMm < 0.01) {
          return;
        }

        const averageDirectionLength = Math.max(
          Math.hypot(
            gasEndpoint.direction.x + liquidEndpoint.direction.x,
            gasEndpoint.direction.y + liquidEndpoint.direction.y,
          ),
          0.0001,
        );
        const averageDirection = {
          x: (gasEndpoint.direction.x + liquidEndpoint.direction.x) / averageDirectionLength,
          y: (gasEndpoint.direction.y + liquidEndpoint.direction.y) / averageDirectionLength,
        };
        const lateralAlignment = Math.abs(
          (delta.x / distanceMm) * averageDirection.x +
          (delta.y / distanceMm) * averageDirection.y,
        );
        if (lateralAlignment > 0.35) {
          return;
        }

        const expectedSpacingMm =
          gasEndpoint.outerDiameterMm / 2 +
          liquidEndpoint.outerDiameterMm / 2 +
          DEFAULT_REFRIGERANT_PIPE_GAP_MM;
        const spacingToleranceMm = Math.max(18, expectedSpacingMm * 0.4);
        const spacingErrorMm = Math.abs(distanceMm - expectedSpacingMm);
        const sharesBundleId = Boolean(
          gasEndpoint.bundleId &&
            liquidEndpoint.bundleId &&
            gasEndpoint.bundleId === liquidEndpoint.bundleId,
        );
        if (!sharesBundleId && spacingErrorMm > spacingToleranceMm) {
          return;
        }

        fieldCandidates.push({
          gas: gasEndpoint,
          liquid: liquidEndpoint,
          score: spacingErrorMm + (sharesBundleId ? 0 : 200),
        });
      });
    });

    fieldCandidates.sort((a, b) => a.score - b.score);
    const usedEndpointKeys = new Set<string>();
    fieldCandidates.forEach(({ gas, liquid }) => {
      if (usedEndpointKeys.has(gas.key) || usedEndpointKeys.has(liquid.key)) {
        return;
      }
      usedEndpointKeys.add(gas.key);
      usedEndpointKeys.add(liquid.key);

      const gasDistance = Math.hypot(gas.point.x - point.x, gas.point.y - point.y);
      const liquidDistance = Math.hypot(liquid.point.x - point.x, liquid.point.y - point.y);
      const nearestDistance = Math.min(gasDistance, liquidDistance);
      if (nearestDistance > bestDistance) {
        return;
      }

      bestDistance = nearestDistance;
      const directionLength = Math.max(
        Math.hypot(
          gas.direction.x + liquid.direction.x,
          gas.direction.y + liquid.direction.y,
        ),
        0.0001,
      );
      bestTarget = {
        point: {
          x: (gas.point.x + liquid.point.x) / 2,
          y: (gas.point.y + liquid.point.y) / 2,
        },
        gasPoint: gas.point,
        liquidPoint: liquid.point,
        gasFieldPoint: gas.point,
        liquidFieldPoint: liquid.point,
        gasOuterDiameterMm: gas.outerDiameterMm,
        liquidOuterDiameterMm: liquid.outerDiameterMm,
        gasDirection: gas.direction,
        liquidDirection: liquid.direction,
        direction: {
          x: (gas.direction.x + liquid.direction.x) / directionLength,
          y: (gas.direction.y + liquid.direction.y) / directionLength,
        },
        elevationMm: (gas.elevationMm + liquid.elevationMm) / 2,
        gasElevationMm: gas.elevationMm,
        liquidElevationMm: liquid.elevationMm,
        connectionKind: "field-pipe",
        sourceElementId: gas.bundleId ?? gas.elementId,
      };
    });

    return bestTarget;
  }

  private createBaseObjects(
    element: Pick<
      HvacElement,
      | "id"
      | "type"
      | "label"
      | "position"
      | "width"
      | "depth"
      | "height"
      | "category"
      | "properties"
    >,
    options: { valid: boolean; includeInteractionHalos: boolean },
  ): fabric.FabricObject[] {
    if (element.type === "accessory" && isRefrigerantBranchKitElement(element)) {
      return this.createBaseObjects(
        {
          ...element,
          type: "refrigerant-branch-kit",
        },
        options,
      );
    }

    const palette = this.getPalette(element, options.valid);
    const isPipeElement = isRefrigerantPipeElementType(element.type);
    const isDuctElement = isGiDuctElementType(element.type);
    const isBranchKitElement = isRefrigerantBranchKitElement(element);
    const baseWidthPx = Math.max(20, element.width * MM_TO_PX);
    const baseDepthPx = Math.max(12, element.depth * MM_TO_PX);
    const widthPx = baseWidthPx;
    const depthPx = baseDepthPx;
    const halfW = widthPx / 2;
    const halfD = depthPx / 2;
    const objects: fabric.FabricObject[] = [];
    const interactionUnderlays: fabric.FabricObject[] = [];
    const interactionOverlays: fabric.FabricObject[] = [];
    let ductedModel: ReturnType<typeof buildDuctedIndoorUnitModel> | null =
      null;
    let customPlanBounds:
      | ReturnType<typeof getDuctedIndoorUnitPlanBounds>
      | ReturnType<typeof getRefrigerantBranchKitPlanBounds>
      | null = null;

    const background = new fabric.Rect({
      left: 0,
      top: 0,
      width: widthPx,
      height: depthPx,
      rx: Math.min(8, depthPx * 0.18),
      ry: Math.min(8, depthPx * 0.18),
      originX: "center",
      originY: "center",
      fill: palette.fill,
      stroke: palette.stroke,
      strokeWidth: 1.4,
      selectable: false,
      evented: false,
    });

    if (element.type === "filter") {
      background.set("strokeDashArray", [6, 4]);
    }

    if (!isPipeElement && !isDuctElement && !isBranchKitElement) {
      this.annotate(background, element.id, "hvac-body");
      objects.push(background);
    }

    const toPx = (valueMm: number): number => valueMm * MM_TO_PX;
    const renderPipePolyline = (
      points: Point2D[],
      stroke: string,
      strokeWidthMm: number,
      name: string,
      lineJoin: "round" | "miter" = "round",
    ): void => {
      if (points.length < 2) {
        return;
      }
      const polyline = new fabric.Polyline(
        points.map((point) => ({ x: toPx(point.x), y: toPx(point.y) })),
        {
          fill: undefined,
          stroke,
          strokeWidth: Math.max(toPx(strokeWidthMm), 1),
          strokeLineCap: "butt",
          strokeLineJoin: lineJoin,
          strokeMiterLimit: lineJoin === "miter" ? 8 : 4,
          selectable: false,
          evented: false,
        },
      );
      this.annotate(polyline, element.id, name);
      objects.push(polyline);
    };

    const renderPipeRectSegment = (
      stub: { start: Point2D; end: Point2D } | null,
      fill: string,
      widthMm: number,
      name: string,
    ): void => {
      if (!stub) {
        return;
      }
      const dx = stub.end.x - stub.start.x;
      const dy = stub.end.y - stub.start.y;
      const lengthMm = Math.hypot(dx, dy);
      if (lengthMm <= 0.2) {
        return;
      }

      const segment = new fabric.Rect({
        left: toPx((stub.start.x + stub.end.x) / 2),
        top: toPx((stub.start.y + stub.end.y) / 2),
        width: Math.max(toPx(lengthMm), 1),
        height: Math.max(toPx(widthMm), 1),
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        originX: "center",
        originY: "center",
        fill,
        selectable: false,
        evented: false,
      });
      this.annotate(segment, element.id, name);
      objects.push(segment);
    };

    const createHiddenSnapPoint = (localPoint: Point2D, name: string): void => {
      const snapPoint = new fabric.Circle({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        radius: 1,
        originX: "center",
        originY: "center",
        fill: "rgba(0,0,0,0)",
        strokeWidth: 0,
        selectable: false,
        evented: false,
        excludeFromExport: true,
      });
      this.annotate(snapPoint, element.id, name);
      objects.push(snapPoint);
    };

    const createVisibleSnapPoint = (
      localPoint: Point2D,
      name: string,
      color: string,
    ): void => {
      const radiusPx = 4.2;
      const ring = new fabric.Circle({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        radius: radiusPx,
        originX: "center",
        originY: "center",
        fill: "rgba(255,255,255,0.2)",
        stroke: color,
        strokeWidth: 1.4,
        selectable: false,
        evented: false,
        excludeFromExport: true,
      });
      this.annotate(ring, element.id, `${name}-ring`);
      objects.push(ring);

      const crossH = new fabric.Rect({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        width: radiusPx * 2.8,
        height: 1.2,
        originX: "center",
        originY: "center",
        fill: color,
        selectable: false,
        evented: false,
        excludeFromExport: true,
      });
      const crossV = new fabric.Rect({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        width: 1.2,
        height: radiusPx * 2.8,
        originX: "center",
        originY: "center",
        fill: color,
        selectable: false,
        evented: false,
        excludeFromExport: true,
      });
      this.annotate(crossH, element.id, `${name}-cross-h`);
      this.annotate(crossV, element.id, `${name}-cross-v`);
      objects.push(crossH, crossV);
    };

    const buildContinuousCorePoints = (
      stub: { start: Point2D; end: Point2D } | null,
      points: Point2D[],
    ): Point2D[] => {
      if (!stub) {
        return points;
      }
      if (points.length === 0) {
        return [stub.end];
      }
      const firstPoint = points[0]!;
      if (
        Math.hypot(firstPoint.x - stub.end.x, firstPoint.y - stub.end.y) <= 0.2
      ) {
        return points;
      }
      return [stub.end, ...points];
    };

    const createRectOutlineHalo = (
      config: {
        leftMm: number;
        topMm: number;
        widthMm: number;
        heightMm: number;
        rxPx?: number;
        ryPx?: number;
      },
      color: string,
      strokeWidthPx: number,
      opacity: number,
      name: "hvac-selection" | "hvac-hover",
    ): void => {
      const halo = new fabric.Rect({
        left: toPx(config.leftMm),
        top: toPx(config.topMm),
        width: Math.max(toPx(config.widthMm), 1),
        height: Math.max(toPx(config.heightMm), 1),
        rx: config.rxPx,
        ry: config.ryPx,
        originX: "center",
        originY: "center",
        fill: "transparent",
        stroke: color,
        strokeWidth: strokeWidthPx,
        selectable: false,
        evented: false,
        opacity,
        visible: false,
      });
      this.annotate(halo, element.id, name);
      interactionOverlays.push(halo);
    };

    const haloPaddingMm = 6 / MM_TO_PX;
    const createPipeHaloPolyline = (
      points: Point2D[],
      widthMm: number,
      color: string,
      opacity: number,
      name: "hvac-selection" | "hvac-hover",
    ): void => {
      if (points.length < 2) {
        return;
      }
      const polyline = new fabric.Polyline(
        points.map((point) => ({ x: toPx(point.x), y: toPx(point.y) })),
        {
          fill: undefined,
          stroke: color,
          strokeWidth: Math.max(toPx(widthMm + haloPaddingMm), 1),
          strokeLineCap: "butt",
          strokeLineJoin: "round",
          selectable: false,
          evented: false,
          opacity,
          visible: false,
        },
      );
      this.annotate(polyline, element.id, name);
      interactionUnderlays.push(polyline);
    };

    const createPipeHaloRectSegment = (
      stub: { start: Point2D; end: Point2D } | null,
      widthMm: number,
      color: string,
      opacity: number,
      name: "hvac-selection" | "hvac-hover",
    ): void => {
      if (!stub) {
        return;
      }
      const dx = stub.end.x - stub.start.x;
      const dy = stub.end.y - stub.start.y;
      const lengthMm = Math.hypot(dx, dy);
      if (lengthMm <= 0.2) {
        return;
      }

      const segment = new fabric.Rect({
        left: toPx((stub.start.x + stub.end.x) / 2),
        top: toPx((stub.start.y + stub.end.y) / 2),
        width: Math.max(toPx(lengthMm), 1),
        height: Math.max(toPx(widthMm + haloPaddingMm), 1),
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
        originX: "center",
        originY: "center",
        fill: color,
        selectable: false,
        evented: false,
        opacity,
        visible: false,
      });
      this.annotate(segment, element.id, name);
      interactionUnderlays.push(segment);
    };

    switch (element.type) {
      case "refrigerant-pipe": {
        const visual = buildRefrigerantPipeVisual(element);
        const chainState = this.pipeRenderChainStateMap.get(element.id) ?? null;
        const headElement =
          chainState && chainState.renderAsHead
            ? this.hvacData.get(chainState.headId) ?? element
            : element;
        const tailElement =
          chainState && chainState.renderAsHead
            ? this.hvacData.get(chainState.tailId) ?? element
            : element;
        const headVisual =
          chainState && chainState.renderAsHead
            ? buildRefrigerantPipeVisual(headElement)
            : visual;
        const tailVisual =
          chainState && chainState.renderAsHead
            ? buildRefrigerantPipeVisual(tailElement)
            : visual;
        const renderCenter = elementCenter(headElement);
        const localizePoint = (point: Point2D): Point2D => ({
          x: point.x - renderCenter.x,
          y: point.y - renderCenter.y,
        });
        const localOuterPoints =
          chainState && chainState.renderAsHead
            ? chainState.outerPoints.map(localizePoint)
            : visual.localOuterPoints;
        const localStub =
          chainState && chainState.renderAsHead && chainState.absoluteStub
            ? {
                start: localizePoint(chainState.absoluteStub.start),
                end: localizePoint(chainState.absoluteStub.end),
              }
            : visual.localStub;
        const outerDiameterMm =
          chainState && chainState.renderAsHead
            ? chainState.outerRadiusMm * 2
            : visual.outerDiameterMm;
        const coreDiameterMm =
          chainState && chainState.renderAsHead
            ? chainState.coreRadiusMm * 2
            : visual.coreRadiusMm * 2;
        const startConnection =
          chainState && chainState.renderAsHead
            ? headVisual.startConnection
            : visual.startConnection;
        const endConnection =
          chainState && chainState.renderAsHead
            ? tailVisual.endConnection
            : visual.endConnection;
        const isChainHiddenMember = Boolean(chainState && !chainState.renderAsHead);
        const trimSourceIds = new Set<string>([
          headElement.id,
          element.id,
          ...(headVisual.bundleId ? [headVisual.bundleId] : []),
        ]);
        // Keep plan-view pipe centerlines identical to modeled geometry.
        // Branch-kit trim-window splitting is 2D-only and can introduce
        // segment drift artifacts that are not present in 3D.
        const trimmedAbsolutePolylineSets = [
          chainState?.outerPoints ?? visual.outerPoints,
        ];
        const localOuterPointSets = trimmedAbsolutePolylineSets.map((polyline) =>
          polyline.map(localizePoint),
        );
        const insulationEdgeStroke = options.valid
          ? "rgba(171,184,196,0.98)"
          : "rgba(220,38,38,0.28)";
        const insulationStroke = options.valid
          ? "#e8eef3"
          : "rgba(254,226,226,0.9)";
        const coreStroke = options.valid
          ? visual.lineKind === "gas"
            ? "#c5894d"
            : "#dca25d"
          : visual.lineKind === "gas"
            ? "#dc2626"
            : "#f97316";
        const corePointSets = localOuterPointSets.map((polyline, index) =>
          index === 0 ? buildContinuousCorePoints(localStub, polyline) : polyline,
        );

        if (options.includeInteractionHalos) {
          createPipeHaloRectSegment(
            localStub,
            outerDiameterMm,
            palette.halo,
            0.16,
            "hvac-selection",
          );
          localOuterPointSets.forEach((polyline) =>
            createPipeHaloPolyline(
              polyline,
              outerDiameterMm,
              palette.halo,
              0.16,
              "hvac-selection",
            ),
          );
          createPipeHaloRectSegment(
            localStub,
            outerDiameterMm,
            palette.hover,
            0.12,
            "hvac-hover",
          );
          localOuterPointSets.forEach((polyline) =>
            createPipeHaloPolyline(
              polyline,
              outerDiameterMm,
              palette.hover,
              0.12,
              "hvac-hover",
            ),
          );
        }

        if (isChainHiddenMember) {
          renderPipeRectSegment(
            visual.localStub,
            "rgba(0,0,0,0.001)",
            visual.outerDiameterMm + 8 / MM_TO_PX,
            "hvac-detail",
          );
          renderPipePolyline(
            visual.localOuterPoints,
            "rgba(0,0,0,0.001)",
            visual.outerDiameterMm + 8 / MM_TO_PX,
            "hvac-detail",
          );
          break;
        }

        localOuterPointSets.forEach((polyline) => {
          renderPipePolyline(
            polyline,
            insulationEdgeStroke,
            outerDiameterMm + 3,
            "hvac-detail",
          );
          renderPipePolyline(
            polyline,
            insulationStroke,
            outerDiameterMm,
            "hvac-detail",
          );
        });
        renderPipeRectSegment(
          localStub,
          coreStroke,
          coreDiameterMm,
          "hvac-detail",
        );
        corePointSets.forEach((polyline) =>
          renderPipePolyline(
            polyline,
            coreStroke,
            coreDiameterMm,
            "hvac-detail",
            "round",
          ),
        );
        const firstOuterPoints = localOuterPointSets[0] ?? [];
        const lastOuterPoints =
          localOuterPointSets[localOuterPointSets.length - 1] ?? [];
        if (!startConnection && firstOuterPoints.length >= 1) {
          createHiddenSnapPoint(firstOuterPoints[0]!, "hvac-snap-start");
        }
        if (!endConnection && lastOuterPoints.length >= 1) {
          createHiddenSnapPoint(
            lastOuterPoints[lastOuterPoints.length - 1]!,
            "hvac-snap-end",
          );
        }
        break;
      }
      case "refrigerant-pipe-pair": {
        const hvacContext = Array.from(this.hvacData.values());
        const baseVisual = buildRefrigerantPipePairVisual(element, hvacContext);
        const inferredStartBundle =
          !baseVisual.startBundleConnection && baseVisual.routePoints.length > 0
            ? findNearestRefrigerantPipeBundleTargetFromModel(
                hvacContext.filter(
                  (candidate) => candidate.id !== element.id,
                ),
                baseVisual.routePoints[0]!,
                180,
              )
            : null;
        const visual = inferredStartBundle
          ? buildRefrigerantPipePairVisual({
              ...element,
              properties: {
                ...element.properties,
                startBundleConnection: inferredStartBundle,
              },
            }, hvacContext)
          : baseVisual;

        const toPx = (valueMm: number): number => valueMm * MM_TO_PX;
        const insulationEdgeStroke = options.valid
          ? "rgba(171,184,196,0.98)"
          : "rgba(220,38,38,0.28)";
        const insulationStroke = options.valid
          ? "#e8eef3"
          : "rgba(254,226,226,0.9)";
        const gasCoreStroke = options.valid ? "#c5894d" : "#dc2626";
        const liquidCoreStroke = options.valid ? "#dca25d" : "#f97316";
        const renderPolyline = (
          points: Point2D[],
          stroke: string,
          strokeWidthMm: number,
          name: string,
          lineJoin: "round" | "miter" = "round",
        ): void => {
          if (points.length < 2) {
            return;
          }
          const polyline = new fabric.Polyline(
            points.map((point) => ({ x: toPx(point.x), y: toPx(point.y) })),
            {
              fill: undefined,
              stroke,
              strokeWidth: Math.max(toPx(strokeWidthMm), 1),
              strokeLineCap: "butt",
              strokeLineJoin: lineJoin,
              strokeMiterLimit: lineJoin === "miter" ? 8 : 4,
              selectable: false,
              evented: false,
            },
          );
          this.annotate(polyline, element.id, name);
          objects.push(polyline);
        };

        const renderRectSegment = (
          stub: { start: Point2D; end: Point2D } | null,
          fill: string,
          widthMm: number,
          name: string,
        ): void => {
          if (!stub) {
            return;
          }
          const dx = stub.end.x - stub.start.x;
          const dy = stub.end.y - stub.start.y;
          const lengthMm = Math.hypot(dx, dy);
          if (lengthMm <= 0.2) {
            return;
          }

          const segment = new fabric.Rect({
            left: toPx((stub.start.x + stub.end.x) / 2),
            top: toPx((stub.start.y + stub.end.y) / 2),
            width: Math.max(toPx(lengthMm), 1),
            height: Math.max(toPx(widthMm), 1),
            angle: (Math.atan2(dy, dx) * 180) / Math.PI,
            originX: "center",
            originY: "center",
            fill,
            selectable: false,
            evented: false,
          });
          this.annotate(segment, element.id, name);
          objects.push(segment);
        };

        const buildContinuousCorePoints = (
          stub: { start: Point2D; end: Point2D } | null,
          points: Point2D[],
        ): Point2D[] => {
          if (!stub) {
            return points;
          }
          if (points.length === 0) {
            return [stub.end];
          }
          const firstPoint = points[0]!;
          if (
            Math.hypot(firstPoint.x - stub.end.x, firstPoint.y - stub.end.y) <=
            0.2
          ) {
            return points;
          }
          return [stub.end, ...points];
        };

        const gasCorePoints = buildContinuousCorePoints(
          visual.gasLocalStub,
          visual.gasLocalOuterPoints,
        );
        const liquidCorePoints = buildContinuousCorePoints(
          visual.liquidLocalStub,
          visual.liquidLocalOuterPoints,
        );

        if (options.includeInteractionHalos) {
          createPipeHaloRectSegment(
            visual.gasLocalStub,
            visual.gasOuterDiameterMm,
            palette.halo,
            0.16,
            "hvac-selection",
          );
          createPipeHaloPolyline(
            visual.gasLocalOuterPoints,
            visual.gasOuterDiameterMm,
            palette.halo,
            0.16,
            "hvac-selection",
          );
          createPipeHaloRectSegment(
            visual.liquidLocalStub,
            visual.liquidOuterDiameterMm,
            palette.halo,
            0.16,
            "hvac-selection",
          );
          createPipeHaloPolyline(
            visual.liquidLocalOuterPoints,
            visual.liquidOuterDiameterMm,
            palette.halo,
            0.16,
            "hvac-selection",
          );
          createPipeHaloRectSegment(
            visual.gasLocalStub,
            visual.gasOuterDiameterMm,
            palette.hover,
            0.12,
            "hvac-hover",
          );
          createPipeHaloPolyline(
            visual.gasLocalOuterPoints,
            visual.gasOuterDiameterMm,
            palette.hover,
            0.12,
            "hvac-hover",
          );
          createPipeHaloRectSegment(
            visual.liquidLocalStub,
            visual.liquidOuterDiameterMm,
            palette.hover,
            0.12,
            "hvac-hover",
          );
          createPipeHaloPolyline(
            visual.liquidLocalOuterPoints,
            visual.liquidOuterDiameterMm,
            palette.hover,
            0.12,
            "hvac-hover",
          );
        }

        renderPolyline(
          visual.gasLocalOuterPoints,
          insulationEdgeStroke,
          visual.gasOuterDiameterMm + 3,
          "hvac-detail",
        );
        renderPolyline(
          visual.liquidLocalOuterPoints,
          insulationEdgeStroke,
          visual.liquidOuterDiameterMm + 3,
          "hvac-detail",
        );
        renderPolyline(
          visual.gasLocalOuterPoints,
          insulationStroke,
          visual.gasOuterDiameterMm,
          "hvac-detail",
        );
        renderPolyline(
          visual.liquidLocalOuterPoints,
          insulationStroke,
          visual.liquidOuterDiameterMm,
          "hvac-detail",
        );

        renderRectSegment(
          visual.gasLocalStub,
          gasCoreStroke,
          visual.gasCoreRadiusMm * 2,
          "hvac-detail",
        );
        renderRectSegment(
          visual.liquidLocalStub,
          liquidCoreStroke,
          visual.liquidCoreRadiusMm * 2,
          "hvac-detail",
        );
        renderPolyline(
          gasCorePoints,
          gasCoreStroke,
          visual.gasCoreRadiusMm * 2,
          "hvac-detail",
          "round",
        );
        renderPolyline(
          liquidCorePoints,
          liquidCoreStroke,
          visual.liquidCoreRadiusMm * 2,
          "hvac-detail",
          "round",
        );
        break;
      }
      case "refrigerant-branch-kit": {
        const branchKit = buildRefrigerantBranchKitViewModel(element);
        const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
        const branchAnchorLocal = resolveStableInlineBranchKitAnchorLocal(
          element,
          branchKit,
          lineSelection,
        );

        const renderGasLine = lineSelection !== "liquid";
        const renderLiquidLine = lineSelection !== "gas";
        customPlanBounds = getRefrigerantBranchKitPlanBounds(branchKit);
        const edgeStroke = options.valid
          ? REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.insulationEdge
          : "rgba(185,28,28,0.72)";
        const highlightStroke = options.valid
          ? REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.insulationShadow
          : "rgba(255,255,255,0.35)";
        const insulationFill = options.valid
          ? REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.insulationBody
          : "rgba(248,113,113,0.46)";
        const bandFill = options.valid
          ? REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.fittingBand
          : "rgba(248,113,113,0.78)";
        const bandEdge = options.valid
          ? REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.fittingBandEdge
          : "rgba(254,226,226,0.92)";
        const insulationThicknessMm =
          DEFAULT_REFRIGERANT_BRANCH_KIT_INSULATION_THICKNESS_MM;

        const renderTaperedSegment = (
          reducer: {
            start: Point2D;
            end: Point2D;
            startDiameterMm: number;
            endDiameterMm: number;
          },
          fill: string,
          name: string,
          strokeColor = edgeStroke,
        ): void => {
          const dx = reducer.end.x - reducer.start.x;
          const dy = reducer.end.y - reducer.start.y;
          const lengthMm = Math.hypot(dx, dy);
          if (lengthMm <= 0.2) {
            return;
          }
          const direction = { x: dx / lengthMm, y: dy / lengthMm };
          const normal = { x: -direction.y, y: direction.x };
          const startHalf = reducer.startDiameterMm / 2;
          const endHalf = reducer.endDiameterMm / 2;
          const polygon = new fabric.Polygon(
            [
              {
                x: toPx(reducer.start.x + normal.x * startHalf),
                y: toPx(reducer.start.y + normal.y * startHalf),
              },
              {
                x: toPx(reducer.end.x + normal.x * endHalf),
                y: toPx(reducer.end.y + normal.y * endHalf),
              },
              {
                x: toPx(reducer.end.x - normal.x * endHalf),
                y: toPx(reducer.end.y - normal.y * endHalf),
              },
              {
                x: toPx(reducer.start.x - normal.x * startHalf),
                y: toPx(reducer.start.y - normal.y * startHalf),
              },
            ],
            {
              fill,
              stroke: strokeColor,
              strokeWidth: 0.8,
              selectable: false,
              evented: false,
            },
          );
          this.annotate(polygon, element.id, name);
          objects.push(polygon);
        };

        const renderJunctionSection = (
          reducer: {
            start: Point2D;
            end: Point2D;
            startDiameterMm: number;
            endDiameterMm: number;
          },
          fill: string,
          name: string,
        ): void => {
          renderTaperedSegment(reducer, fill, `${name}-outer`);
          renderPipePolyline(
            [reducer.start, reducer.end],
            highlightStroke,
            Math.max(
              1.1,
              Math.min(reducer.startDiameterMm, reducer.endDiameterMm) * 0.2,
            ),
            `${name}-highlight`,
          );
        };

        const renderManifoldBody = (
          manifold: { outline: Point2D[]; highlightPath: Point2D[] },
          fill: string,
          name: string,
        ): void => {
          const outline = manifold.outline;
          if (outline.length < 3) {
            return;
          }
          const polygon = new fabric.Polygon(
            outline.map((point) => ({ x: toPx(point.x), y: toPx(point.y) })),
            {
              fill,
              stroke: edgeStroke,
              strokeWidth: 0.8,
              selectable: false,
              evented: false,
            },
          );
          this.annotate(polygon, element.id, `${name}-body`);
          objects.push(polygon);

          renderPipePolyline(
            manifold.highlightPath,
            highlightStroke,
            Math.max(1.1, lineWidthFromOutline(outline) * 0.12),
            `${name}-highlight`,
          );
        };

        const lineWidthFromOutline = (outline: Point2D[]): number => {
          const ys = outline.map((point) => point.y);
          return Math.max(...ys) - Math.min(...ys);
        };

        const trimPolylineEnd = (
          points: Point2D[],
          trimLengthMm: number,
        ): Point2D[] => {
          if (points.length < 2 || trimLengthMm <= 0.01) {
            return points;
          }

          const segmentLengths: number[] = [];
          let totalLength = 0;
          for (let index = 1; index < points.length; index += 1) {
            const start = points[index - 1]!;
            const end = points[index]!;
            const length = Math.hypot(end.x - start.x, end.y - start.y);
            segmentLengths.push(length);
            totalLength += length;
          }

          const targetLength = Math.max(totalLength - trimLengthMm, 0);
          if (targetLength <= 0.01) {
            return [points[0]!];
          }
          if (targetLength >= totalLength - 0.01) {
            return points;
          }

          const trimmed: Point2D[] = [points[0]!];
          let traversed = 0;
          for (let index = 1; index < points.length; index += 1) {
            const start = points[index - 1]!;
            const end = points[index]!;
            const length = segmentLengths[index - 1]!;
            if (traversed + length < targetLength - 0.01) {
              trimmed.push(end);
              traversed += length;
              continue;
            }

            const remaining = targetLength - traversed;
            const t = length > 0.01 ? remaining / length : 0;
            trimmed.push({
              x: start.x + (end.x - start.x) * t,
              y: start.y + (end.y - start.y) * t,
            });
            break;
          }

          return trimmed;
        };

        const renderBand = (
          band: (typeof branchKit.gas.bands)[number],
          name: string,
        ): void => {
          const rect = new fabric.Rect({
            left: toPx(band.center.x),
            top: toPx(band.center.y),
            width: Math.max(toPx(band.lengthMm), 1),
            height: Math.max(toPx(band.outerDiameterMm), 1),
            angle: (Math.atan2(band.direction.y, band.direction.x) * 180) / Math.PI,
            rx: Math.max(toPx(band.outerDiameterMm * 0.18), 0.8),
            ry: Math.max(toPx(band.outerDiameterMm * 0.18), 0.8),
            originX: "center",
            originY: "center",
            fill: bandFill,
            stroke: bandEdge,
            strokeWidth: 0.55,
            selectable: false,
            evented: false,
          });
          this.annotate(rect, element.id, name);
          objects.push(rect);
        };

        const renderLine = (
          line: typeof branchKit.gas,
          bodyStroke: string,
        ): void => {
          const manifoldRunConnectorPoints =
            line.inletRunTube.points.length >= 1 && line.mainTube.points.length >= 1
              ? [
                  line.inletRunTube.points[line.inletRunTube.points.length - 1]!,
                  line.mainTube.points[0]!,
                ]
              : [];

          const renderCopperPolyline = (
            points: Point2D[],
            diameterMm: number,
            name: string,
          ): void => {
            renderPipePolyline(
              points,
              edgeStroke,
              diameterMm + 1.2,
              `${name}-edge`,
            );
            renderPipePolyline(points, bodyStroke, diameterMm, `${name}-body`);
            renderPipePolyline(
              points,
              highlightStroke,
              Math.max(1.1, diameterMm * 0.22),
              `${name}-highlight`,
            );
          };

          const renderInsulationPolyline = (
            points: Point2D[],
            copperDiameterMm: number,
            name: string,
          ): void => {
            if (points.length < 2) {
              return;
            }
            const insulatedDiameterMm =
              copperDiameterMm + insulationThicknessMm * 2;
            renderPipePolyline(
              points,
              edgeStroke,
              insulatedDiameterMm + 1.2,
              `${name}-edge`,
            );
            renderPipePolyline(
              points,
              insulationFill,
              insulatedDiameterMm,
              `${name}-body`,
            );
          };

          const insulatedMainPoints = trimPolylineEnd(
            line.mainTube.points,
            line.runOutletTerminal.socketLengthMm,
          );
          const insulatedBranchPoints = trimPolylineEnd(
            line.branchTube.points,
            line.branchOutletTerminal.socketLengthMm,
          );

          renderInsulationPolyline(
            line.inletRunTube.points,
            line.inletRunTube.outerDiameterMm,
            `hvac-branch-${line.kind}-inlet-run-insulation`,
          );
          renderInsulationPolyline(
            manifoldRunConnectorPoints,
            line.mainTube.outerDiameterMm,
            `hvac-branch-${line.kind}-manifold-run-insulation`,
          );
          renderManifoldBody(
            line.manifold,
            insulationFill,
            `hvac-branch-${line.kind}-manifold`,
          );
          renderInsulationPolyline(
            insulatedMainPoints,
            line.mainTube.outerDiameterMm,
            `hvac-branch-${line.kind}-main-insulation`,
          );
          renderInsulationPolyline(
            insulatedBranchPoints,
            line.branchTube.outerDiameterMm,
            `hvac-branch-${line.kind}-branch-insulation`,
          );
          renderCopperPolyline(
            line.inletTube.points,
            line.inletTube.outerDiameterMm,
            `hvac-branch-${line.kind}-inlet`,
          );
          renderCopperPolyline(
            line.inletRunTube.points,
            line.inletRunTube.outerDiameterMm,
            `hvac-branch-${line.kind}-inlet-run`,
          );
          renderCopperPolyline(
            manifoldRunConnectorPoints,
            line.mainTube.outerDiameterMm,
            `hvac-branch-${line.kind}-manifold-run`,
          );
          renderCopperPolyline(
            line.mainTube.points,
            line.mainTube.outerDiameterMm,
            `hvac-branch-${line.kind}-main`,
          );
          renderCopperPolyline(
            line.branchTube.points,
            line.branchTube.outerDiameterMm,
            `hvac-branch-${line.kind}-branch`,
          );
          if (line.inletReducer) {
            renderJunctionSection(
              {
                start: line.inletReducer.start,
                end: line.inletReducer.end,
                startDiameterMm: line.inletReducer.startOuterDiameterMm,
                endDiameterMm: line.inletReducer.endOuterDiameterMm,
              },
              bodyStroke,
              `hvac-branch-${line.kind}-reducer-outer`,
            );
          }
          line.bands.forEach((band, index) => {
            renderBand(band, `hvac-branch-${line.kind}-band-${index}`);
          });
        };

        if (renderGasLine) {
          renderLine(
            branchKit.gas,
            options.valid
              ? REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.gasCopper
              : "#dc2626",
          );
        }
        if (renderLiquidLine) {
          renderLine(
            branchKit.liquid,
            options.valid
              ? REFRIGERANT_BRANCH_KIT_COLOR_PALETTE.liquidCopper
              : "#f97316",
          );
        }
        getRefrigerantBranchKitTerminalSpecs(branchKit)
          .filter((terminal) =>
            lineSelection === "both" ? true : terminal.kind === lineSelection,
          )
          .forEach((terminal) => {
          createHiddenSnapPoint(
            terminal.point,
            `hvac-branch-snap-${terminal.kind}-${terminal.role}`,
          );
        });
        createHiddenSnapPoint(branchAnchorLocal, "hvac-branch-center-snap");
        if (element.properties.branchKitPlacementMode === "inline-pipe-run") {
          createVisibleSnapPoint(
            branchAnchorLocal,
            "hvac-branch-center-snap-visible",
            options.valid ? "#0ea5e9" : "#dc2626",
          );
        }
        break;
      }
      case "ceiling-cassette-ac": {
        const cassette = buildCeilingCassetteModel(element);
        const toPx = (valueMm: number): number => valueMm * MM_TO_PX;
        const panelSizePx = toPx(cassette.panelSize);
        const minDimension = panelSizePx;
        const panelFill = options.valid
          ? "rgba(251,252,253,0.98)"
          : "rgba(254,242,242,0.92)";
        const panelOutlineStroke = options.valid
          ? "rgba(154,166,177,0.72)"
          : "rgba(185,28,28,0.72)";
        const topCapFill = options.valid ? "#aeb7c0" : "rgba(253,226,226,0.92)";
        const topCapStroke = options.valid
          ? "rgba(138,149,160,0.92)"
          : "rgba(185,28,28,0.56)";
        const hiddenBodyInsetStroke = options.valid
          ? "rgba(124,136,148,0.46)"
          : "rgba(185,28,28,0.34)";
        const topCapHighlightStroke = options.valid
          ? "rgba(244,247,250,0.72)"
          : "rgba(255,255,255,0.38)";

        background.set({
          width: panelSizePx,
          height: panelSizePx,
          fill: panelFill,
          stroke: panelOutlineStroke,
          strokeWidth: 1.3,
          rx: Math.max(8, minDimension * 0.085),
          ry: Math.max(8, minDimension * 0.085),
        });
        background.set("strokeDashArray", null);

        if (options.includeInteractionHalos) {
          const haloPaddingMm = 4 / MM_TO_PX;
          const panelRxPx = Math.max(8, minDimension * 0.085);
          createRectOutlineHalo(
            {
              leftMm: 0,
              topMm: 0,
              widthMm: cassette.panelSize + haloPaddingMm,
              heightMm: cassette.panelSize + haloPaddingMm,
              rxPx: panelRxPx + 2,
              ryPx: panelRxPx + 2,
            },
            palette.halo,
            1.8,
            1,
            "hvac-selection",
          );
          createRectOutlineHalo(
            {
              leftMm: 0,
              topMm: 0,
              widthMm: cassette.panelSize + haloPaddingMm,
              heightMm: cassette.panelSize + haloPaddingMm,
              rxPx: panelRxPx + 1,
              ryPx: panelRxPx + 1,
            },
            palette.hover,
            1.4,
            1,
            "hvac-hover",
          );
        }

        const topCap = new fabric.Rect({
          left: toPx(cassette.topCap.x),
          top: toPx(cassette.topCap.y),
          width: toPx(cassette.topCap.width),
          height: toPx(cassette.topCap.depth),
          rx: Math.max(6, toPx(cassette.topCap.cornerRadius)),
          ry: Math.max(6, toPx(cassette.topCap.cornerRadius)),
          originX: "center",
          originY: "center",
          fill: topCapFill,
          stroke: topCapStroke,
          strokeWidth: 1.4,
          selectable: false,
          evented: false,
        });
        this.annotate(topCap, element.id, "hvac-detail");
        objects.push(topCap);

        const hiddenBodyInset = new fabric.Rect({
          left: toPx(cassette.hiddenBody.x),
          top: toPx(cassette.hiddenBody.y),
          width: toPx(cassette.hiddenBody.width),
          height: toPx(cassette.hiddenBody.depth),
          rx: Math.max(6, toPx(cassette.hiddenBody.cornerRadius)),
          ry: Math.max(6, toPx(cassette.hiddenBody.cornerRadius)),
          originX: "center",
          originY: "center",
          fill: "transparent",
          stroke: hiddenBodyInsetStroke,
          strokeWidth: 0.9,
          selectable: false,
          evented: false,
        });
        this.annotate(hiddenBodyInset, element.id, "hvac-detail");
        objects.push(hiddenBodyInset);

        const topCapHighlight = new fabric.Rect({
          left: toPx(cassette.topCap.x),
          top: toPx(cassette.topCap.y),
          width: Math.max(
            toPx(cassette.topCap.width - cassette.topCap.width * 0.018),
            1,
          ),
          height: Math.max(
            toPx(cassette.topCap.depth - cassette.topCap.depth * 0.018),
            1,
          ),
          rx: Math.max(5, toPx(cassette.topCap.cornerRadius * 0.92)),
          ry: Math.max(5, toPx(cassette.topCap.cornerRadius * 0.92)),
          originX: "center",
          originY: "center",
          fill: "transparent",
          stroke: topCapHighlightStroke,
          strokeWidth: 0.8,
          selectable: false,
          evented: false,
        });
        this.annotate(topCapHighlight, element.id, "hvac-detail");
        objects.push(topCapHighlight);

        const visiblePortStartX = cassette.topCap.x + cassette.topCap.width / 2;
        const renderProjectedPortSegment = (
          startMm: number,
          endMm: number,
          centerYMm: number,
          radiusMm: number,
          fill: string,
          name: string,
        ): void => {
          const visibleStartMm = Math.max(startMm, visiblePortStartX);
          const visibleLengthMm = endMm - visibleStartMm;
          if (visibleLengthMm <= 0.2) {
            return;
          }
          const projectionRect = new fabric.Rect({
            left: toPx((visibleStartMm + endMm) / 2),
            top: toPx(centerYMm),
            width: Math.max(toPx(visibleLengthMm), 1),
            height: Math.max(toPx(radiusMm * 2), 2),
            originX: "center",
            originY: "center",
            fill,
            selectable: false,
            evented: false,
          });
          this.annotate(projectionRect, element.id, name);
          objects.push(projectionRect);
        };

        cassette.pipePorts.forEach((port) => {
          const flangeStartMm = port.x;
          const flangeEndMm = port.x + port.flangeThickness;
          const collarStartMm = port.x + port.flangeThickness * 0.35;
          const collarEndMm = collarStartMm + port.collarLength;
          const pipeStartMm =
            port.x + port.collarLength - port.flangeThickness * 0.15;
          const pipeEndMm = pipeStartMm + port.length;

          renderProjectedPortSegment(
            flangeStartMm,
            flangeEndMm,
            port.y,
            port.collarRadius * 1.12,
            port.flangeColor ?? "#d7dde2",
            `hvac-port-${port.kind}-flange`,
          );
          renderProjectedPortSegment(
            collarStartMm,
            collarEndMm,
            port.y,
            port.collarRadius,
            port.collarColor ?? "#1f2937",
            `hvac-port-${port.kind}-collar`,
          );
          renderProjectedPortSegment(
            pipeStartMm,
            pipeEndMm,
            port.y,
            port.radius,
            port.color,
            `hvac-port-${port.kind}-pipe`,
          );
          if (port.kind === "gas" || port.kind === "liquid") {
            createHiddenSnapPoint(
              getCeilingCassettePipePortEndpointLocal(port),
              `hvac-snap-${port.kind}`,
            );
          }

          const bandX = port.x + port.bandOffsetX;
          if (bandX >= visiblePortStartX) {
            const bandMarker = new fabric.Line(
              [
                toPx(bandX),
                toPx(port.y - port.bandRadius),
                toPx(bandX),
                toPx(port.y + port.bandRadius),
              ],
              {
                stroke: port.bandColor,
                strokeWidth: Math.max(toPx(port.bandRadius * 0.18), 1.2),
                selectable: false,
                evented: false,
              },
            );
            this.annotate(bandMarker, element.id, "hvac-detail");
            objects.push(bandMarker);
          }
        });
        break;
      }
      case "wall-mounted-ac":
      case "remote-controller":
      case "control-panel": {
        const topLine = new fabric.Line(
          [-halfW * 0.78, -halfD * 0.18, halfW * 0.78, -halfD * 0.18],
          {
            stroke: palette.detail,
            strokeWidth: 1.1,
            selectable: false,
            evented: false,
          },
        );
        const bottomLine = new fabric.Line(
          [-halfW * 0.74, halfD * 0.18, halfW * 0.74, halfD * 0.18],
          {
            stroke: palette.detail,
            strokeWidth: 0.9,
            selectable: false,
            evented: false,
          },
        );
        this.annotate(topLine, element.id, "hvac-detail");
        this.annotate(bottomLine, element.id, "hvac-detail");
        objects.push(topLine, bottomLine);
        break;
      }
      case "ceiling-suspended-ac": {
        const centerLine = new fabric.Line([-halfW * 0.8, 0, halfW * 0.8, 0], {
          stroke: palette.detail,
          strokeWidth: 1.1,
          selectable: false,
          evented: false,
        });
        this.annotate(centerLine, element.id, "hvac-detail");
        objects.push(centerLine);
        for (let index = -1; index <= 1; index += 1) {
          const grille = new fabric.Line(
            [
              index * halfW * 0.45,
              -halfD * 0.55,
              index * halfW * 0.45,
              halfD * 0.55,
            ],
            {
              stroke: palette.detail,
              strokeWidth: 0.8,
              selectable: false,
              evented: false,
            },
          );
          this.annotate(grille, element.id, "hvac-detail");
          objects.push(grille);
        }
        break;
      }
      case "ducted-ac": {
        ductedModel = buildDuctedIndoorUnitModel(element);
        customPlanBounds = getDuctedIndoorUnitPlanBounds(ductedModel);
        const ducted = ductedModel;
        const shellFill = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.shell
          : "rgba(254,242,242,0.92)";
        const shellStroke = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.shellOutline
          : "rgba(185,28,28,0.66)";
        const insetStroke = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.insetOutline
          : "rgba(185,28,28,0.42)";
        const sectionStroke = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.sectionLine
          : "rgba(185,28,28,0.72)";
        const returnFill = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.returnSection
          : "rgba(254,226,226,0.72)";
        const fanFill = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.fanSection
          : "rgba(254,205,211,0.56)";
        const plenumFill = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.dischargeSection
          : "rgba(252,165,165,0.42)";
        const dischargeFill = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.dischargeFace
          : "rgba(220,38,38,0.46)";
        const serviceFill = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.serviceBox
          : "rgba(254,226,226,0.82)";
        const bracketFill = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.bracket
          : "rgba(252,165,165,0.5)";
        const highlightStroke = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.highlight
          : "rgba(255,255,255,0.42)";

        background.set({
          fill: shellFill,
          stroke: shellStroke,
          strokeWidth: 1.3,
          rx: Math.max(6, toPx(ducted.casingInset.cornerRadius * 1.4)),
          ry: Math.max(6, toPx(ducted.casingInset.cornerRadius * 1.4)),
        });
        background.set("strokeDashArray", null);

        const renderRect = (
          spec: {
            x: number;
            y: number;
            width: number;
            depth: number;
            cornerRadius: number;
          },
          config: {
            fill: string;
            stroke?: string;
            strokeWidth?: number;
          },
          name: string = "hvac-detail",
        ): fabric.Rect => {
          const rect = new fabric.Rect({
            left: toPx(spec.x),
            top: toPx(spec.y),
            width: Math.max(toPx(spec.width), 1),
            height: Math.max(toPx(spec.depth), 1),
            rx: Math.max(toPx(spec.cornerRadius), 1),
            ry: Math.max(toPx(spec.cornerRadius), 1),
            originX: "center",
            originY: "center",
            fill: config.fill,
            stroke: config.stroke,
            strokeWidth: config.strokeWidth,
            selectable: false,
            evented: false,
          });
          this.annotate(rect, element.id, name);
          objects.push(rect);
          return rect;
        };

        const renderLine = (
          line: { x1: number; y1: number; x2: number; y2: number },
          stroke: string,
          strokeWidth: number,
          name: string = "hvac-detail",
        ): void => {
          const shape = new fabric.Line(
            [toPx(line.x1), toPx(line.y1), toPx(line.x2), toPx(line.y2)],
            {
              stroke,
              strokeWidth,
              selectable: false,
              evented: false,
            },
          );
          this.annotate(shape, element.id, name);
          objects.push(shape);
        };

        renderRect(ducted.casingInset, {
          fill: options.valid
            ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.casingInset
            : "rgba(255,255,255,0.04)",
          stroke: insetStroke,
          strokeWidth: 1,
        });
        renderRect(ducted.returnSection, {
          fill: returnFill,
          stroke: insetStroke,
          strokeWidth: 0.9,
        });
        renderRect(ducted.fanSection, {
          fill: fanFill,
          stroke: insetStroke,
          strokeWidth: 0.9,
        });
        renderRect(ducted.dischargeSection, {
          fill: plenumFill,
          stroke: insetStroke,
          strokeWidth: 0.9,
        });
        renderRect(ducted.dischargeOpening, {
          fill: dischargeFill,
          stroke: shellStroke,
          strokeWidth: 0.9,
        });
        renderRect(ducted.serviceBox, {
          fill: serviceFill,
          stroke: sectionStroke,
          strokeWidth: 0.9,
        });
        renderRect(ducted.electricalCover, {
          fill: options.valid
            ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.electricalCover
            : "rgba(255,255,255,0.48)",
          stroke: insetStroke,
          strokeWidth: 0.8,
        });

        ducted.hangerBrackets.forEach((bracket) => {
          renderRect(bracket, {
            fill: bracketFill,
            stroke: insetStroke,
            strokeWidth: 0.7,
          });
        });

        ducted.sectionDividers.forEach((divider) => {
          renderLine(divider, sectionStroke, 1);
        });
        ducted.filterRails.forEach((rail) => {
          renderLine(rail, sectionStroke, 0.9);
        });
        ducted.fanRibs.forEach((rib, index) => {
          renderLine(
            rib,
            index === 0 || index === ducted.fanRibs.length - 1
              ? insetStroke
              : sectionStroke,
            0.9,
          );
        });
        ducted.airOpenings.forEach((opening) => {
          const projection = getDuctedIndoorUnitOpeningPlanProjection(
            ducted,
            opening,
          );
          const collarDepthMm = opening.collarProjection;
          const collarWidthMm =
            opening.openingWidth + opening.collarThickness * 2;
          const mouthLipDepthMm = Math.max(4, opening.frameThickness * 0.34);
          const mouthLipCenterYm =
            projection.shellFaceY +
            opening.cavityDirection * mouthLipDepthMm * 0.5;
          renderRect(
            {
              x: opening.x,
              y: projection.cavityCenterY,
              width: opening.openingWidth * 0.94,
              depth: projection.cavityDepth,
              cornerRadius: Math.max(2, opening.cornerRadius * 0.7),
            },
            {
              fill: options.valid
                ? opening.kind === "return"
                  ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCavityReturn
                  : DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCavitySupply
                : opening.kind === "return"
                  ? "#253038"
                  : "#1f2a31",
              stroke: undefined,
              strokeWidth: 0,
            },
          );
          renderRect(
            {
              x: opening.x,
              y: projection.coilCenterY,
              width: opening.coilWidth,
              depth: projection.coilDepth,
              cornerRadius: Math.max(1, opening.cornerRadius * 0.34),
            },
            {
              fill: options.valid
                ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCoilCore
                : "rgba(148,163,184,0.46)",
              stroke: options.valid
                ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCoilFin
                : "rgba(255,255,255,0.28)",
              strokeWidth: 0.4,
            },
          );
          for (
            let finIndex = 0;
            finIndex < opening.coilFinCount;
            finIndex += 1
          ) {
            const finY =
              projection.coilCenterY -
              projection.coilDepth * 0.34 +
              finIndex *
                ((projection.coilDepth * 0.68) /
                  Math.max(1, opening.coilFinCount - 1));
            renderLine(
              {
                x1: opening.x - opening.coilWidth * 0.46,
                y1: finY,
                x2: opening.x + opening.coilWidth * 0.46,
                y2: finY,
              },
              options.valid
                ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCoilFin
                : "rgba(255,255,255,0.4)",
              0.45,
            );
          }
          renderRect(
            {
              x: opening.x,
              y: projection.mouthCenterY,
              width: opening.openingWidth * 0.96,
              depth: projection.mouthDepth,
              cornerRadius: Math.max(2, opening.cornerRadius * 0.72),
            },
            {
              fill: options.valid
                ? opening.kind === "return"
                  ? "rgba(108,115,123,0.22)"
                  : "rgba(188,194,200,0.28)"
                : "rgba(255,255,255,0.08)",
              stroke: options.valid
                ? opening.kind === "return"
                  ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingMouthReturn
                  : DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingMouthSupply
                : "rgba(255,255,255,0.42)",
              strokeWidth: 0.8,
            },
          );
          renderRect(
            {
              x: opening.x,
              y: mouthLipCenterYm,
              width: opening.openingWidth * 0.98,
              depth: mouthLipDepthMm,
              cornerRadius: Math.max(1.5, opening.cornerRadius * 0.52),
            },
            {
              fill: options.valid
                ? opening.kind === "return"
                  ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingMouthReturn
                  : DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingMouthSupply
                : "rgba(255,255,255,0.28)",
              stroke: options.valid
                ? highlightStroke
                : "rgba(255,255,255,0.32)",
              strokeWidth: 0.45,
            },
          );
          if (opening.collarProjection > 0) {
            renderRect(
              {
                x: opening.x,
                y: projection.collarCenterY,
                width: collarWidthMm,
                depth: collarDepthMm,
                cornerRadius: Math.max(
                  opening.cornerRadius * 0.5,
                  opening.collarThickness * 0.5,
                ),
              },
              {
                fill: "rgba(255,255,255,0)",
                stroke: options.valid
                  ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.openingCollar
                  : "rgba(185,28,28,0.52)",
                strokeWidth: Math.max(toPx(opening.collarThickness), 1),
              },
            );
          }
        });

        renderLine(
          {
            x1: ducted.serviceBox.x - ducted.serviceBox.width * 0.34,
            y1: ducted.serviceBox.y - ducted.serviceBox.depth * 0.18,
            x2: ducted.serviceBox.x + ducted.serviceBox.width * 0.34,
            y2: ducted.serviceBox.y - ducted.serviceBox.depth * 0.18,
          },
          highlightStroke,
          0.8,
        );
        renderLine(
          {
            x1:
              ducted.dischargeOpening.x - ducted.dischargeOpening.width * 0.26,
            y1: ducted.dischargeOpening.y,
            x2:
              ducted.dischargeOpening.x + ducted.dischargeOpening.width * 0.26,
            y2: ducted.dischargeOpening.y,
          },
          highlightStroke,
          0.9,
        );

        const casingFaceX = ducted.casingInset.x + ducted.casingInset.width / 2;
        ducted.pipePorts.forEach((port) => {
          const pipeEndMm =
            port.x + port.collarLength + port.length - port.flangeThickness * 0.15;
          const minVisiblePipeMm = port.kind === "drain" ? 18 : 14;
          const bootStartMm = casingFaceX;
          const bootEndMm = Math.min(
            port.x + port.collarLength,
            pipeEndMm - minVisiblePipeMm,
          );
          const pipeStartMm = Math.max(
            port.x + port.collarLength - port.flangeThickness * 0.15,
            casingFaceX,
          );

          const renderPortSegment = (
            startMm: number,
            endMm: number,
            centerYMm: number,
            radiusMm: number,
            fill: string,
            name: string,
            options?: {
              stroke?: string;
              strokeWidth?: number;
              square?: boolean;
            },
          ): void => {
            const segment = new fabric.Rect({
              left: toPx((startMm + endMm) / 2),
              top: toPx(centerYMm),
              width: Math.max(toPx(endMm - startMm), 1),
              height: Math.max(toPx(radiusMm * 2), 1.5),
              rx: options?.square ? 0 : Math.max(toPx(radiusMm), 1),
              ry: options?.square ? 0 : Math.max(toPx(radiusMm), 1),
              originX: "center",
              originY: "center",
              fill,
              stroke: options?.stroke,
              strokeWidth: options?.strokeWidth,
              selectable: false,
              evented: false,
            });
            this.annotate(segment, element.id, name);
            objects.push(segment);
          };

          renderPortSegment(
            bootStartMm,
            bootEndMm,
            port.y,
            port.collarRadius * 1.1,
            port.flangeColor ?? "#252b33",
            `hvac-port-${port.kind}-collar`,
            {
              square: true,
            },
          );
          renderPortSegment(
            pipeStartMm,
            pipeEndMm,
            port.y,
            port.radius,
            port.color,
            `hvac-port-${port.kind}-pipe`,
            {
              square: true,
              stroke:
                port.kind === "drain"
                  ? "rgba(92,139,165,0.38)"
                  : "rgba(143,94,44,0.18)",
              strokeWidth: 0.6,
            },
          );
          if (port.kind === "gas" || port.kind === "liquid") {
            createHiddenSnapPoint(
              { x: pipeEndMm, y: port.y },
              `hvac-snap-${port.kind}`,
            );
          }

          const bandX = Math.min(
            pipeEndMm - 4,
            Math.max(
              pipeStartMm + 4,
              pipeStartMm + (pipeEndMm - pipeStartMm) * 0.36,
            ),
          );
          if (port.kind === "liquid") {
            renderLine(
              {
                x1: bandX,
                y1: port.y - port.bandRadius,
                x2: bandX,
                y2: port.y + port.bandRadius,
              },
              port.bandColor,
              Math.max(toPx(port.bandRadius * 0.16), 0.8),
            );
          }
        });
        break;
      }
      case "duct": {
        const ductVisual = buildGiDuctVisual(element);
        const ductBodyFill = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctBody
          : "rgba(255,255,255,0.5)";
        const ductEdgeStroke = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctEdge
          : "rgba(185,28,28,0.48)";
        const ductSeamStroke = options.valid
          ? DUCTED_INDOOR_UNIT_COLOR_PALETTE.giDuctSeam
          : "rgba(255,255,255,0.4)";

        ductVisual.segments.forEach((segment, index) => {
          const body = new fabric.Rect({
            left: toPx(segment.localCenter.x),
            top: toPx(segment.localCenter.y),
            width: Math.max(toPx(segment.lengthMm), 1),
            height: Math.max(toPx(ductVisual.outerWidthMm), 1),
            angle: segment.angleDeg,
            originX: "center",
            originY: "center",
            fill: ductBodyFill,
            stroke: ductEdgeStroke,
            strokeWidth: 0.8,
            selectable: false,
            evented: false,
          });
          this.annotate(body, element.id, "hvac-detail");
          objects.push(body);

          const direction = {
            x: (segment.localEnd.x - segment.localStart.x) / segment.lengthMm,
            y: (segment.localEnd.y - segment.localStart.y) / segment.lengthMm,
          };
          const normal = {
            x: -direction.y,
            y: direction.x,
          };

          segment.seamOffsetsMm.forEach((offsetMm) => {
            const seamCenter = {
              x: segment.localStart.x + direction.x * offsetMm,
              y: segment.localStart.y + direction.y * offsetMm,
            };
            const seam = new fabric.Line(
              [
                toPx(seamCenter.x - normal.x * ductVisual.outerWidthMm * 0.48),
                toPx(seamCenter.y - normal.y * ductVisual.outerWidthMm * 0.48),
                toPx(seamCenter.x + normal.x * ductVisual.outerWidthMm * 0.48),
                toPx(seamCenter.y + normal.y * ductVisual.outerWidthMm * 0.48),
              ],
              {
                stroke: ductSeamStroke,
                strokeWidth: 0.55,
                selectable: false,
                evented: false,
              },
            );
            this.annotate(seam, element.id, "hvac-detail");
            objects.push(seam);
          });

          if (index === ductVisual.segments.length - 1) {
            const endFrame = new fabric.Line(
              [
                toPx(segment.localEnd.x - normal.x * ductVisual.outerWidthMm * 0.5),
                toPx(segment.localEnd.y - normal.y * ductVisual.outerWidthMm * 0.5),
                toPx(segment.localEnd.x + normal.x * ductVisual.outerWidthMm * 0.5),
                toPx(segment.localEnd.y + normal.y * ductVisual.outerWidthMm * 0.5),
              ],
              {
                stroke: ductEdgeStroke,
                strokeWidth: 0.9,
                selectable: false,
                evented: false,
              },
            );
            this.annotate(endFrame, element.id, "hvac-detail");
            objects.push(endFrame);
          }
        });
        break;
      }
      case "outdoor-unit": {
        const fanRing = new fabric.Circle({
          left: 0,
          top: 0,
          radius: Math.min(halfW, halfD) * 0.42,
          originX: "center",
          originY: "center",
          stroke: palette.detail,
          strokeWidth: 1.1,
          fill: "transparent",
          selectable: false,
          evented: false,
        });
        const horizontal = new fabric.Line(
          [-halfW * 0.28, 0, halfW * 0.28, 0],
          {
            stroke: palette.detail,
            strokeWidth: 1,
            selectable: false,
            evented: false,
          },
        );
        const vertical = new fabric.Line([0, -halfD * 0.28, 0, halfD * 0.28], {
          stroke: palette.detail,
          strokeWidth: 1,
          selectable: false,
          evented: false,
        });
        this.annotate(fanRing, element.id, "hvac-detail");
        this.annotate(horizontal, element.id, "hvac-detail");
        this.annotate(vertical, element.id, "hvac-detail");
        objects.push(fanRing, horizontal, vertical);
        break;
      }
      case "filter":
      case "accessory":
      default: {
        for (let index = -1; index <= 1; index += 1) {
          const grille = new fabric.Line(
            [
              -halfW * 0.7,
              index * halfD * 0.35,
              halfW * 0.7,
              index * halfD * 0.35,
            ],
            {
              stroke: palette.detail,
              strokeWidth: 0.8,
              selectable: false,
              evented: false,
            },
          );
          this.annotate(grille, element.id, "hvac-detail");
          objects.push(grille);
        }
        break;
      }
    }

    if (
      GENERIC_PIPE_PORT_TYPES.has(element.type) &&
      element.type !== "ducted-ac"
    ) {
      const portSpec = getUnitPipePortSpec(element);
      if (portSpec) {
        const toPx = (valueMm: number): number => valueMm * MM_TO_PX;
        portSpec.ports.forEach((port) => {
          const metrics = getUnitPipePortRenderMetrics(port);

          const collar = new fabric.Rect({
            left: toPx((metrics.collarStartX + metrics.collarEndX) / 2),
            top: toPx(port.localY),
            width: Math.max(toPx(metrics.collarLength), 2),
            height: Math.max(toPx(metrics.collarRadius * 2), 2),
            rx: Math.max(toPx(metrics.collarRadius), 1),
            ry: Math.max(toPx(metrics.collarRadius), 1),
            originX: "center",
            originY: "center",
            fill: "#1f2937",
            selectable: false,
            evented: false,
          });
          this.annotate(collar, element.id, "hvac-detail");
          objects.push(collar);

          const pipeRun = new fabric.Rect({
            left: toPx((metrics.pipeStartX + metrics.pipeEndX) / 2),
            top: toPx(port.localY),
            width: Math.max(toPx(metrics.pipeEndX - metrics.pipeStartX), 2),
            height: Math.max(toPx(port.radius * 2), 1.5),
            rx: Math.max(toPx(port.radius), 1),
            ry: Math.max(toPx(port.radius), 1),
            originX: "center",
            originY: "center",
            fill: port.color,
            selectable: false,
            evented: false,
          });
          this.annotate(pipeRun, element.id, `hvac-port-${port.kind}-pipe`);
          objects.push(pipeRun);
          createHiddenSnapPoint(
            getUnitPipePortEndpointLocal(port),
            `hvac-snap-${port.kind}`,
          );
        });
      }
    }

    if (interactionUnderlays.length > 0) {
      objects.unshift(...interactionUnderlays);
    }
    if (interactionOverlays.length > 0) {
      objects.push(...interactionOverlays);
    }

    if (!isPipeElement && !isDuctElement) {
      const labelTopPx =
        customPlanBounds !== null
          ? toPx(customPlanBounds.minY) - 8
          : -halfD - 8;
      const fontSize = clampFontSize(widthPx);
      const label = new fabric.Text(element.label.toUpperCase(), {
        left: 0,
        top: labelTopPx,
        originX: "center",
        originY: "bottom",
        fontSize,
        fontFamily: "monospace",
        fontWeight: "500",
        fill: palette.stroke,
        selectable: false,
        evented: false,
      });
      this.annotate(label, element.id, "hvac-label");
      objects.push(label);
    }

    if (
      options.includeInteractionHalos &&
      !isPipeElement &&
      element.type !== "ceiling-cassette-ac"
    ) {
      if (customPlanBounds) {
        createRectOutlineHalo(
          {
            leftMm: (customPlanBounds.minX + customPlanBounds.maxX) / 2,
            topMm: (customPlanBounds.minY + customPlanBounds.maxY) / 2,
            widthMm:
              customPlanBounds.maxX - customPlanBounds.minX + 8 / MM_TO_PX,
            heightMm:
              customPlanBounds.maxY - customPlanBounds.minY + 8 / MM_TO_PX,
          },
          palette.halo,
          2,
          1,
          "hvac-selection",
        );
        createRectOutlineHalo(
          {
            leftMm: (customPlanBounds.minX + customPlanBounds.maxX) / 2,
            topMm: (customPlanBounds.minY + customPlanBounds.maxY) / 2,
            widthMm:
              customPlanBounds.maxX - customPlanBounds.minX + 6 / MM_TO_PX,
            heightMm:
              customPlanBounds.maxY - customPlanBounds.minY + 6 / MM_TO_PX,
          },
          palette.hover,
          1.5,
          1,
          "hvac-hover",
        );
      } else {
        const selectionHalo = new fabric.Rect({
          left: 0,
          top: 0,
          width: widthPx + 8,
          height: depthPx + 8,
          originX: "center",
          originY: "center",
          fill: "transparent",
          stroke: palette.halo,
          strokeWidth: 2,
          selectable: false,
          evented: false,
          visible: this.selectedIds.has(element.id),
        });
        const hoverHalo = new fabric.Rect({
          left: 0,
          top: 0,
          width: widthPx + 6,
          height: depthPx + 6,
          originX: "center",
          originY: "center",
          fill: "transparent",
          stroke: palette.hover,
          strokeWidth: 1.5,
          selectable: false,
          evented: false,
          visible:
            this.hoveredId === element.id && !this.selectedIds.has(element.id),
        });
        this.annotate(selectionHalo, element.id, "hvac-selection");
        this.annotate(hoverHalo, element.id, "hvac-hover");
        objects.push(selectionHalo, hoverHalo);
      }
    }

    return objects;
  }

  private buildGroup(
    element: Pick<
      HvacElement,
      | "id"
      | "type"
      | "label"
      | "position"
      | "rotation"
      | "width"
      | "depth"
      | "height"
      | "category"
      | "properties"
    >,
    options: {
      valid?: boolean;
      selectable?: boolean;
      evented?: boolean;
      includeInteractionHalos?: boolean;
    },
  ): HvacGroup {
    const allElements = Array.from(this.hvacData.values());
    const pipeTargets = getVisibleRefrigerantPipeStraightSegmentTargets(
      allElements,
    );
    const inlineResultWithModel = resolveInlineBranchKitRenderCenter(
      element,
      pipeTargets,
      allElements,
    );
    
    const isPipeElement = isRefrigerantPipeElementType(element.type);
    const isDuctElement = isGiDuctElementType(element.type);
    const isDuctedUnit = element.type === "ducted-ac";
    const usesPreciseHitTesting =
      isPipeElement || element.type === "ceiling-cassette-ac";
    const objects = this.createBaseObjects(element, {
      valid: options.valid ?? true,
      includeInteractionHalos: options.includeInteractionHalos ?? true,
    });

    const group = new fabric.Group(objects, {
      originX: "center",
      originY: "center",
      selectable: options.selectable ?? true,
      evented: options.evented ?? true,
      subTargetCheck: !isDuctedUnit || isDuctElement,
      perPixelTargetFind: usesPreciseHitTesting,
      hasControls: false,
      hasBorders: false,
      lockRotation: true,
      objectCaching: false,
    }) as HvacGroup;

    if (inlineResultWithModel) {
      const centerMm = subtractPoints(
        inlineResultWithModel.anchorPoint,
        rotatePoint(inlineResultWithModel.anchorLocal, inlineResultWithModel.rotationDeg),
      );
      const centerPx = toCanvas(centerMm);
      group.set({
        left: centerPx.x,
        top: centerPx.y,
        angle: inlineResultWithModel.rotationDeg,
      });
      group.setCoords();

      // Final exact lock: use the rendered branch-center snap marker itself and
      // translate the group so that marker lands exactly on the target anchor.
      const renderedAnchor = this.getRenderedObjectCenterMm(
        group,
        "hvac-branch-center-snap",
      );
      if (renderedAnchor) {
        const renderedAnchorPx = toCanvas(renderedAnchor);
        const targetAnchorPx = toCanvas(inlineResultWithModel.anchorPoint);
        group.set({
          left: (group.left ?? centerPx.x) + (targetAnchorPx.x - renderedAnchorPx.x),
          top: (group.top ?? centerPx.y) + (targetAnchorPx.y - renderedAnchorPx.y),
        });
      }
    } else {
      const center = toCanvas(elementCenter(element));
      group.set({
        left: center.x,
        top: center.y,
        angle: element.rotation ?? 0,
      });
    }

    group.id = element.id;
    group.hvacElementId = element.id;
    group.name = `hvac-${element.id}`;
    return group;
  }

  renderElement(element: HvacElement): void {
    this.removeElement(element.id);
    this.hvacData.set(element.id, element);

    const group = this.buildGroup(element, {
      valid: true,
      selectable: true,
      evented: true,
      includeInteractionHalos: true,
    });

    this.canvas.add(group);
    this.groups.set(element.id, group);
    this.bringPipeElementsToFront();
  }

  renderPlacementPreview(
    definition: AcEquipmentDefinition,
    position: Point2D,
    rotationDeg: number,
    valid: boolean,
    placementProperties?: Record<string, unknown>,
  ): void {
    const branchKitModel = isRefrigerantBranchKitType(definition.type)
      ? buildRefrigerantBranchKitViewModel({
          type: definition.type,
          subtype: definition.subtype,
          modelLabel: definition.modelLabel,
          properties: definition.defaultProperties ?? {},
        })
      : null;
    const previewElement: HvacElement = {
      id: "__hvac-placement-preview__",
      type: definition.type,
      category: definition.equipmentCategory,
      subtype: definition.subtype,
      modelLabel: definition.modelLabel,
      position,
      rotation: rotationDeg,
      width: branchKitModel?.widthMm ?? definition.widthMm,
      depth: branchKitModel?.depthMm ?? definition.depthMm,
      height: branchKitModel?.heightMm ?? definition.heightMm,
      elevation: definition.elevationMm,
      mountType: definition.mountType,
      label: definition.name,
      supplyZoneRatio: definition.supplyZoneRatio ?? 0.5,
      properties: {
        definitionId: definition.id,
        ...(definition.defaultProperties ?? {}),
        ...(placementProperties ?? {}),
      },
    };

    this.renderElementPreview(previewElement, valid);
  }

  renderElementPreview(element: HvacElement, valid: boolean): void {
    this.renderElementPreviews([element], valid);
  }

  renderElementPreviews(elements: HvacElement[], valid: boolean): void {
    this.clearPlacementPreview();

    this.placementPreview = elements.map((element) => {
      const group = this.buildGroup(element, {
        valid,
        selectable: false,
        evented: false,
        includeInteractionHalos: false,
      });
      group.set({
        opacity: valid ? 0.86 : 0.92,
        excludeFromExport: true,
      });

      this.canvas.add(group);
      this.canvas.bringObjectToFront(group);
      return group;
    });
    this.canvas.requestRenderAll();
  }

  clearPlacementPreview(): void {
    if (this.placementPreview.length === 0) {
      return;
    }
    this.placementPreview.forEach((group) => this.canvas.remove(group));
    this.placementPreview = [];
    this.canvas.requestRenderAll();
  }

  renderAll(elements: HvacElement[]): void {
    this.syncElements(elements, { force: true });
  }

  syncElements(
    elements: HvacElement[],
    options: SyncHvacElementsOptions = {},
  ): void {
    const { force = false } = options;
    const previousData = new Map(this.hvacData);
    this.rebuildRefrigerantPipeRenderStateMaps(elements);
    const nextElementIds = new Set(elements.map((element) => element.id));
    let changed = force;

    this.hvacData.forEach((_, id) => {
      if (!nextElementIds.has(id)) {
        this.removeElement(id);
        changed = true;
      }
    });

    this.hvacData = new Map(elements.map((element) => [element.id, element]));

    elements.forEach((element) => {
      const previousElement = previousData.get(element.id);
      const hasGroup = this.groups.has(element.id);
      if (
        !force &&
        hasGroup &&
        !this.hvacElementNeedsRerender(previousElement, element)
      ) {
        return;
      }
      this.renderElement(element);
      changed = true;
    });

    if (!changed) {
      return;
    }

    this.refreshViewportVisibility(true);
    this.syncHvacVisualState();
    this.bringPipeElementsToFront();
    this.canvas.requestRenderAll();
  }

  setSelectedElements(ids: string[]): void {
    this.selectedIds = new Set(ids);
    this.syncHvacVisualState();
    this.canvas.requestRenderAll();
  }

  setHoveredElement(id: string | null): void {
    this.hoveredId = id;
    this.syncHvacVisualState();
    this.canvas.requestRenderAll();
  }

  dispose(): void {
    this.clearPlacementPreview();
    this.groups.forEach((group) => this.canvas.remove(group));
    this.groups.clear();
    this.hvacData.clear();
    this.pipeEndpointStateMap.clear();
    this.pipeRenderChainStateMap.clear();
  }
}
