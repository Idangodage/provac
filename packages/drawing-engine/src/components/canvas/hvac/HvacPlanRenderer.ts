/**
 * HvacPlanRenderer
 *
 * Renders AC/HVAC equipment on the Fabric.js plan canvas.
 */

import * as fabric from "fabric";

import type { AcEquipmentDefinition } from "../../../data";
import type { HvacElement, Point2D } from "../../../types";
import { MM_TO_PX } from "../scale";
import {
  getCanvasViewportBounds,
  hasMeaningfulViewportZoomChange,
  isViewportBoundsContained,
  type ViewportBounds,
} from "../viewportVisibility";

import {
  buildCeilingCassetteModel,
} from "./ceilingCassetteModel";
import {
  buildDuctedIndoorUnitModel,
  DUCTED_INDOOR_UNIT_COLOR_PALETTE,
  getDuctedIndoorUnitOpeningPlanProjection,
  getDuctedIndoorUnitPlanBounds,
} from "./ductedIndoorUnitModel";
import { buildGiDuctVisual, isGiDuctElementType } from "./giDuctModel";
import { buildPipeCenterline, toPolyline } from "./pipeCenterline";
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
  buildRefrigerantPipeVisual,
  buildRefrigerantPipePairVisual,
  findNearestRefrigerantPipeBundleTarget as findNearestRefrigerantPipeBundleTargetFromModel,
  isRefrigerantPipeElementType,
  resolveInlineBranchKitCenter,
  resolveRefrigerantPipeSpec,
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
  getUnitPipePortRenderMetrics,
  getUnitPipePortSpec,
  GENERIC_PIPE_PORT_TYPES,
} from "./unitPipePortModel";

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

// Opacity used for Fabric refrigerant-pipe bodies when the SVG overlay draws the
// visible pipe. Non-zero so perPixelTargetFind still gets pipe-shaped pixels to
// hit (opacity 0 makes the pipe unclickable), yet low enough to stay invisible
// under the opaque overlay. Deterministic pipe selection no longer depends on
// this (see pickRefrigerantPipeAtPoint), so the value only needs to keep the
// non-overlay/fallback path working.
const HIDDEN_PIPE_HIT_OPACITY = 0.04;

// Extra forgiveness (screen px) added to each pipe's insulation half-width when
// geometrically hit-testing a click/hover against its centerline segments.
const PIPE_PICK_PADDING_PX = 6;

/** Shortest distance (mm) from point p to segment a-b, all in mm space. */
function pointToSegmentDistanceMm(p: Point2D, a: Point2D, b: Point2D): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / lenSq)) : 0;
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  return Math.hypot(p.x - cx, p.y - cy);
}

function elementCenter(
  element: Pick<HvacElement, "position" | "width" | "depth">,
): Point2D {
  return {
    x: element.position.x + element.width / 2,
    y: element.position.y + element.depth / 2,
  };
}

function isIndoorUnitElementType(type: HvacElement["type"]): boolean {
  return (
    type === "wall-mounted-ac" ||
    type === "ceiling-cassette-ac" ||
    type === "ceiling-suspended-ac" ||
    type === "ducted-ac"
  );
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

function dotProduct(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
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
  _pipeTargets: VisibleRefrigerantPipeSegmentTarget[],
  _allElements: HvacElement[],
): { anchorPoint: Point2D; anchorLocal: Point2D; rotationDeg: number } | null {
  // Delegate to the single inline-center source of truth (no live re-snap) so
  // the drawn kit lands exactly where its terminals/snap-targets are — see
  // resolveInlineBranchKitCenter in refrigerantPipePairModel. (`_pipeTargets`
  // / `_allElements` are retained for call-site compatibility; the previous
  // live re-snap they fed caused the kit to render off its connection center.)
  if (!isRefrigerantBranchKitElement(element)) {
    return null;
  }
  const lineSelection = resolveRefrigerantBranchKitLineSelection(element);
  const model = buildRefrigerantBranchKitViewModel(element);
  const inline = resolveInlineBranchKitCenter(element, lineSelection, model);
  if (!inline) {
    return null;
  }
  return {
    anchorPoint: inline.anchorPoint,
    anchorLocal: inline.anchorLocal,
    rotationDeg: inline.rotationDeg,
  };
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
  private sceneElementOverrides = new Map<string, HvacElement>();
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
  // Cached straight-segment geometry for deterministic pipe hit-testing; rebuilt
  // lazily on the next pick after any element render/override change.
  private pipeSegmentTargetsCache: VisibleRefrigerantPipeSegmentTarget[] | null = null;
  // When the SVG pipe-studio overlay owns the visible pipes, the Fabric pipe
  // bodies are kept (selectable / snappable) but rendered invisible to avoid a
  // double image that ignores the overlay's bend/gap controls.
  private hideRefrigerantBodies = false;
  private lastVisibilityBounds: ViewportBounds | null = null;
  private lastVisibilityZoom: number | null = null;
  private projectionPlanOpacity = 1;

  constructor(canvas: fabric.Canvas) {
    this.canvas = canvas;
  }

  private getRenderSceneElements(
    sourceElements: Iterable<HvacElement> = this.hvacData.values(),
  ): HvacElement[] {
    const elements = Array.from(sourceElements);
    if (this.sceneElementOverrides.size === 0) {
      return elements;
    }
    return elements.map(
      (element) => this.sceneElementOverrides.get(element.id) ?? element,
    );
  }

  private getRenderSceneElement(id: string): HvacElement | undefined {
    return this.sceneElementOverrides.get(id) ?? this.hvacData.get(id);
  }

  setSceneElementOverrides(elements: HvacElement[] | null): void {
    this.sceneElementOverrides = new Map(
      (elements ?? []).map((element) => [element.id, element]),
    );
    this.invalidatePipeSegmentTargets();
  }

  clearSceneElementOverrides(): void {
    this.sceneElementOverrides.clear();
    this.invalidatePipeSegmentTargets();
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
    this.invalidatePipeSegmentTargets();
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
    const renderScene = this.getRenderSceneElements(elements);
    this.pipeEndpointStateMap =
      buildRefrigerantPipeEndpointRenderStateMap(renderScene);
    this.pipeRenderChainStateMap = buildRefrigerantPipeRenderChainStateMap(
      renderScene,
      this.pipeEndpointStateMap,
    );
  }

  private getInlineBranchKitTrimWindows(
    sourceIds: Set<string>,
    lineKind: "gas" | "liquid",
  ): PipeTrimWindow[] {
    const windows: PipeTrimWindow[] = [];
    const allElements = this.getRenderSceneElements();
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
      const visible =
        this.projectionPlanOpacity > 0.001 &&
        this.isObjectVisibleInViewport(group, visibleBounds);
      if (group.visible !== visible) {
        group.set("visible", visible);
        group.set("dirty", true);
      }
    });
  }

  private syncHvacVisualState(): void {
    this.groups.forEach((group, id) => {
      const projectionVisible = this.projectionPlanOpacity > 0.001;
      const isSelected = this.selectedIds.has(id);
      const selectionHalos = group
        .getObjects()
        .filter((obj) => (obj as NamedObject).name === "hvac-selection");
      const hoverHalos = group
        .getObjects()
        .filter((obj) => (obj as NamedObject).name === "hvac-hover");
      const pipeControlHandles = group
        .getObjects()
        .filter(
          (obj) =>
            Boolean(
              (
                obj as fabric.FabricObject & {
                  isPipeHandle?: boolean;
                  isPipeVertexHandle?: boolean;
                }
              ).isPipeHandle ??
                (
                  obj as fabric.FabricObject & {
                    isPipeVertexHandle?: boolean;
                  }
                ).isPipeVertexHandle,
            ),
        );
      selectionHalos.forEach((selectionHalo) => {
        selectionHalo.set("visible", isSelected);
      });
      hoverHalos.forEach((hoverHalo) => {
        hoverHalo.set(
          "visible",
          this.hoveredId === id && !isSelected,
        );
      });
      pipeControlHandles.forEach((handle) => {
        const typedHandle = handle as fabric.FabricObject & {
          controlType?: string;
          pipeControlDraggable?: boolean;
          pipeVertexDraggable?: boolean;
        };
        handle.set("visible", isSelected);
        const isPipeControl =
          typedHandle.controlType === "pipe-vertex-handle" ||
          typedHandle.controlType === "pipe-segment-handle";
        const isDraggableControl = Boolean(
          typedHandle.pipeControlDraggable ?? typedHandle.pipeVertexDraggable,
        );
        if (isPipeControl) {
          handle.set(
            "evented",
            isSelected && isDraggableControl,
          );
        } else {
          handle.set("evented", false);
        }
      });
      group.set({
        opacity: this.projectionPlanOpacity,
        visible: projectionVisible && group.visible,
        evented: projectionVisible,
        selectable: projectionVisible,
      });
      group.set("dirty", true);
    });
    this.bringPipeElementsToFront();
  }

  setProjectionPlanOpacity(opacity: number): void {
    const nextOpacity = Math.min(
      1,
      Math.max(0, Number.isFinite(opacity) ? opacity : 1),
    );
    if (Math.abs(this.projectionPlanOpacity - nextOpacity) <= 0.001) {
      return;
    }

    this.projectionPlanOpacity = nextOpacity;
    this.lastVisibilityBounds = null;
    this.refreshViewportVisibility(true);
    this.syncHvacVisualState();
    this.canvas.requestRenderAll();
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
    const hvacContext = this.getRenderSceneElements();
    const pipeTargets = getVisibleRefrigerantPipeStraightSegmentTargets(
      hvacContext,
    );
    const CENTERLINE_IDENTITY_TOLERANCE_MM = 1;

    this.groups.forEach((group, id) => {
      const element = this.getRenderSceneElement(id);
      if (!element) {
        return;
      }

      if (element.type === "refrigerant-pipe") {
        const visual = buildRefrigerantPipeVisual(
          element,
          hvacContext,
        );
        const chainState = this.pipeRenderChainStateMap.get(element.id) ?? null;
        if (chainState && !chainState.renderAsHead) {
          return;
        }
        const startPoint = this.getRenderedObjectCenterMm(group, "hvac-snap-start");
        const endPoint = this.getRenderedObjectCenterMm(group, "hvac-snap-end");
        const outerPoints = chainState?.outerPoints ?? visual.outerPoints;
        const headElement =
          chainState ? this.getRenderSceneElement(chainState.headId) ?? element : element;
        const tailElement =
          chainState ? this.getRenderSceneElement(chainState.tailId) ?? element : element;
        const headVisual = chainState
          ? buildRefrigerantPipeVisual(
              headElement,
              hvacContext,
            )
          : visual;
        const tailVisual = chainState
          ? buildRefrigerantPipeVisual(
              tailElement,
              hvacContext,
            )
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
        if (lineSelection !== "both") {
          return;
        }
        const branchKit = buildRefrigerantBranchKitViewModel(element);
        const inlineResult = resolveInlineBranchKitRenderCenter(
          element,
          pipeTargets,
          hvacContext,
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
    const isIndoorUnitElement = isIndoorUnitElementType(element.type);
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
      strokeDashMm?: number[],
      lineCap: "butt" | "round" = "butt",
    ): void => {
      if (points.length < 2) {
        return;
      }
      // Smooth the drawn corners into true constant-radius arc bends (the
      // canonical pipe centerline). This only reshapes the stroked line — the
      // upstream offset / connection / branch-kit logic that produced `points`
      // is untouched, and the object stays a fabric.Polyline. The radius adapts
      // to the shortest leg so it never overruns a segment.
      let renderPoints = points;
      if (points.length >= 3) {
        let shortest = Infinity;
        for (let i = 1; i < points.length; i += 1) {
          shortest = Math.min(
            shortest,
            Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y),
          );
        }
        if (Number.isFinite(shortest) && shortest >= 1) {
          const radiusMm = Math.max(8, Math.min(shortest * 0.45, 120));
          renderPoints = toPolyline(buildPipeCenterline(points, radiusMm), 0.75);
        }
      }
      const polyline = new fabric.Polyline(
        renderPoints.map((point) => ({ x: toPx(point.x), y: toPx(point.y) })),
        {
          fill: undefined,
          stroke,
          strokeWidth: Math.max(toPx(strokeWidthMm), 1),
          strokeLineCap: lineCap,
          strokeLineJoin: lineJoin,
          strokeMiterLimit: lineJoin === "miter" ? 8 : 4,
          strokeDashArray: strokeDashMm?.map((segmentMm) =>
            Math.max(1, toPx(segmentMm)),
          ),
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

    const createPipeVertexHandle = (
      localPoint: Point2D,
      vertexIndex: number,
      options: {
        draggable: boolean;
        endpoint: boolean;
        visible: boolean;
      },
    ): void => {
      const viewportZoom = Math.max(this.canvas.getZoom(), 0.01);
      const baseOuterRadius = options.endpoint ? 4.8 : 6.2;
      const targetScreenOuterRadius = options.endpoint ? 7.5 : 9.5;
      const outerRadius = Math.max(
        baseOuterRadius,
        targetScreenOuterRadius / viewportZoom,
      );
      const innerRadius = Math.max(
        options.endpoint ? 1.9 : 2.4,
        (options.endpoint ? 3.2 : 4.1) / viewportZoom,
      );
      const strokeColor = options.endpoint ? "#0f766e" : "#2563eb";
      const fillColor = options.endpoint
        ? "rgba(255,255,255,0.92)"
        : "rgba(255,255,255,0.96)";
      const outer = new fabric.Circle({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        radius: outerRadius,
        originX: "center",
        originY: "center",
        fill: fillColor,
        stroke: strokeColor,
        strokeWidth: 2.2,
        selectable: false,
        evented: false,
        visible: options.visible,
        excludeFromExport: true,
      }) as fabric.Circle & {
        isPipeControl?: boolean;
        isPipeHandle?: boolean;
        isPipeVertexHandle?: boolean;
        controlType?: string;
        pipeId?: string;
        pipeVertexIndex?: number;
        pipeControlDraggable?: boolean;
        pipeVertexDraggable?: boolean;
      };
      outer.isPipeHandle = true;
      outer.isPipeVertexHandle = true;
      outer.pipeControlDraggable = options.draggable;
      outer.pipeVertexDraggable = options.draggable;
      if (options.draggable) {
        outer.isPipeControl = true;
        outer.controlType = "pipe-vertex-handle";
        outer.pipeId = element.id;
        outer.pipeVertexIndex = vertexIndex;
      }

      const inner = new fabric.Circle({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        radius: innerRadius,
        originX: "center",
        originY: "center",
        fill: strokeColor,
        strokeWidth: 0,
        selectable: false,
        evented: false,
        visible: options.visible,
        excludeFromExport: true,
      }) as fabric.Circle & {
        isPipeHandle?: boolean;
        isPipeVertexHandle?: boolean;
      };
      inner.isPipeHandle = true;
      inner.isPipeVertexHandle = true;

      const hitRadius = options.draggable
        ? Math.max(outerRadius + 7, 20 / viewportZoom)
        : outerRadius;
      const hit = new fabric.Circle({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        radius: hitRadius,
        originX: "center",
        originY: "center",
        fill: options.draggable ? "rgba(0,0,0,0.001)" : "transparent",
        strokeWidth: 0,
        selectable: false,
        evented: options.visible && options.draggable,
        visible: options.visible,
        excludeFromExport: true,
      }) as fabric.Circle & {
        isPipeControl?: boolean;
        isPipeHandle?: boolean;
        isPipeVertexHandle?: boolean;
        controlType?: string;
        pipeId?: string;
        pipeVertexIndex?: number;
        pipeControlDraggable?: boolean;
        pipeVertexDraggable?: boolean;
      };
      hit.isPipeHandle = true;
      hit.isPipeVertexHandle = true;
      if (options.draggable) {
        hit.isPipeControl = true;
        hit.controlType = "pipe-vertex-handle";
        hit.pipeId = element.id;
        hit.pipeVertexIndex = vertexIndex;
        hit.pipeControlDraggable = true;
        hit.pipeVertexDraggable = true;
      }

      this.annotate(
        outer,
        element.id,
        `hvac-pipe-vertex-${vertexIndex}${options.draggable ? "-control" : "-marker"}`,
      );
      this.annotate(inner, element.id, `hvac-pipe-vertex-core-${vertexIndex}`);
      this.annotate(hit, element.id, `hvac-pipe-vertex-hit-${vertexIndex}`);
      objects.push(outer, inner, hit);
    };

    const createPipeSegmentHandle = (
      localPoint: Point2D,
      startIndex: number,
      endIndex: number,
      options: {
        visible: boolean;
      },
    ): void => {
      const viewportZoom = Math.max(this.canvas.getZoom(), 0.01);
      const outerRadius = Math.max(7, 12 / viewportZoom);
      const innerRadius = Math.max(2.4, 4.5 / viewportZoom);
      const strokeColor = "#b45309";
      const outer = new fabric.Circle({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        radius: outerRadius,
        originX: "center",
        originY: "center",
        fill: "rgba(255,255,255,0.95)",
        stroke: strokeColor,
        strokeWidth: 2.2,
        selectable: false,
        evented: false,
        visible: options.visible,
        excludeFromExport: true,
      }) as fabric.Circle & {
        isPipeControl?: boolean;
        isPipeHandle?: boolean;
        isPipeVertexHandle?: boolean;
        controlType?: string;
        pipeId?: string;
        pipeSegmentStartIndex?: number;
        pipeSegmentEndIndex?: number;
        pipeControlDraggable?: boolean;
      };
      outer.isPipeHandle = true;
      outer.isPipeVertexHandle = true;
      outer.isPipeControl = true;
      outer.controlType = "pipe-segment-handle";
      outer.pipeId = element.id;
      outer.pipeSegmentStartIndex = startIndex;
      outer.pipeSegmentEndIndex = endIndex;
      outer.pipeControlDraggable = true;

      const inner = new fabric.Circle({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        radius: innerRadius,
        originX: "center",
        originY: "center",
        fill: strokeColor,
        strokeWidth: 0,
        selectable: false,
        evented: false,
        visible: options.visible,
        excludeFromExport: true,
      }) as fabric.Circle & {
        isPipeHandle?: boolean;
        isPipeVertexHandle?: boolean;
      };
      inner.isPipeHandle = true;
      inner.isPipeVertexHandle = true;

      const hitRadius = Math.max(outerRadius + 7, 20 / viewportZoom);
      const hit = new fabric.Circle({
        left: toPx(localPoint.x),
        top: toPx(localPoint.y),
        radius: hitRadius,
        originX: "center",
        originY: "center",
        fill: "rgba(0,0,0,0.001)",
        strokeWidth: 0,
        selectable: false,
        evented: options.visible,
        visible: options.visible,
        excludeFromExport: true,
      }) as fabric.Circle & {
        isPipeControl?: boolean;
        isPipeHandle?: boolean;
        isPipeVertexHandle?: boolean;
        controlType?: string;
        pipeId?: string;
        pipeSegmentStartIndex?: number;
        pipeSegmentEndIndex?: number;
        pipeControlDraggable?: boolean;
      };
      hit.isPipeHandle = true;
      hit.isPipeVertexHandle = true;
      hit.isPipeControl = true;
      hit.controlType = "pipe-segment-handle";
      hit.pipeId = element.id;
      hit.pipeSegmentStartIndex = startIndex;
      hit.pipeSegmentEndIndex = endIndex;
      hit.pipeControlDraggable = true;

      this.annotate(
        outer,
        element.id,
        `hvac-pipe-segment-${startIndex}-${endIndex}`,
      );
      this.annotate(
        inner,
        element.id,
        `hvac-pipe-segment-core-${startIndex}-${endIndex}`,
      );
      this.annotate(
        hit,
        element.id,
        `hvac-pipe-segment-hit-${startIndex}-${endIndex}`,
      );
      objects.push(outer, inner, hit);
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

    const distancePointToSegmentMm = (
      point: Point2D,
      start: Point2D,
      end: Point2D,
    ): number => {
      const segment = subtractPoints(end, start);
      const lengthSq = segment.x * segment.x + segment.y * segment.y;
      if (lengthSq <= 1e-8) {
        return Math.hypot(point.x - start.x, point.y - start.y);
      }
      const projected = Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * segment.x + (point.y - start.y) * segment.y) /
            lengthSq,
        ),
      );
      const closest = {
        x: start.x + segment.x * projected,
        y: start.y + segment.y * projected,
      };
      return Math.hypot(point.x - closest.x, point.y - closest.y);
    };

    const simplifyHandleVertexIndices = (
      points: Point2D[],
      toleranceMm: number,
    ): number[] => {
      const count = points.length;
      if (count <= 2) {
        return count === 2 ? [0, 1] : [0];
      }

      const keep = new Set<number>([0, count - 1]);
      const visit = (startIndex: number, endIndex: number): void => {
        if (endIndex - startIndex <= 1) {
          return;
        }
        const startPoint = points[startIndex]!;
        const endPoint = points[endIndex]!;
        let farthestIndex = -1;
        let farthestDistance = -1;
        for (let index = startIndex + 1; index < endIndex; index += 1) {
          const distance = distancePointToSegmentMm(
            points[index]!,
            startPoint,
            endPoint,
          );
          if (distance > farthestDistance) {
            farthestDistance = distance;
            farthestIndex = index;
          }
        }
        if (farthestIndex >= 0 && farthestDistance > toleranceMm) {
          keep.add(farthestIndex);
          visit(startIndex, farthestIndex);
          visit(farthestIndex, endIndex);
        }
      };
      visit(0, count - 1);
      return Array.from(keep).sort((left, right) => left - right);
    };

    const buildPipeHandleVertexIndices = (points: Point2D[]): number[] => {
      if (points.length <= 2) {
        return points.length === 2 ? [0, 1] : [0];
      }
      // Route points can include dense arc samples. Simplify to logical bend controls.
      const HANDLE_SIMPLIFY_TOLERANCE_MM = 8;
      const simplified = simplifyHandleVertexIndices(
        points,
        HANDLE_SIMPLIFY_TOLERANCE_MM,
      );
      if (simplified.length > 2) {
        return simplified;
      }
      // Keep one interior control when the path has curvature, so bends remain editable.
      const start = points[0]!;
      const end = points[points.length - 1]!;
      let candidateIndex = -1;
      let candidateDistance = 0;
      for (let index = 1; index < points.length - 1; index += 1) {
        const distance = distancePointToSegmentMm(points[index]!, start, end);
        if (distance > candidateDistance) {
          candidateDistance = distance;
          candidateIndex = index;
        }
      }
      if (candidateIndex > 0 && candidateDistance > 1) {
        return [0, candidateIndex, points.length - 1];
      }
      return simplified;
    };

    const classifyHardDirection = (
      start: Point2D,
      end: Point2D,
    ): "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW" | null => {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) {
        return null;
      }
      if (Math.abs(dx) <= 0.75) {
        return dy > 0 ? "S" : "N";
      }
      if (Math.abs(dy) <= 0.75) {
        return dx > 0 ? "E" : "W";
      }
      if (Math.abs(Math.abs(dx) - Math.abs(dy)) <= 1.5) {
        if (dx > 0 && dy < 0) return "NE";
        if (dx > 0 && dy > 0) return "SE";
        if (dx < 0 && dy < 0) return "NW";
        return "SW";
      }
      return null;
    };

    const buildHardSegmentHandleSpecs = (
      points: Point2D[],
      segmentMaterials: Array<"hard" | "flexible">,
      options: {
        lockStart: boolean;
        lockEnd: boolean;
      },
    ): Array<{
      startIndex: number;
      endIndex: number;
      midPoint: Point2D;
    }> => {
      if (points.length < 2) {
        return [];
      }
      const specs: Array<{
        startIndex: number;
        endIndex: number;
        midPoint: Point2D;
      }> = [];
      const segmentCount = points.length - 1;
      const lastIndex = points.length - 1;
      const MIN_MOVABLE_HARD_SEGMENT_MM = 24;

      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        if ((segmentMaterials[segmentIndex] ?? "flexible") !== "hard") {
          continue;
        }
        const startIndex = segmentIndex;
        const endIndex = segmentIndex + 1;
        if (
          (startIndex === 0 && options.lockStart) ||
          (endIndex === lastIndex && options.lockEnd)
        ) {
          continue;
        }
        const startPoint = points[startIndex]!;
        const endPoint = points[endIndex]!;
        const direction = classifyHardDirection(startPoint, endPoint);
        if (!direction) {
          continue;
        }
        const segmentLengthMm = Math.hypot(
          endPoint.x - startPoint.x,
          endPoint.y - startPoint.y,
        );
        if (segmentLengthMm < MIN_MOVABLE_HARD_SEGMENT_MM) {
          continue;
        }
        specs.push({
          startIndex,
          endIndex,
          midPoint: {
            x: (startPoint.x + endPoint.x) / 2,
            y: (startPoint.y + endPoint.y) / 2,
          },
        });
      }

      return specs;
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
    const hvacContext = this.getRenderSceneElements();

    switch (element.type) {
      case "refrigerant-pipe": {
        const visual = buildRefrigerantPipeVisual(
          element,
          hvacContext,
        );
        const chainState = this.pipeRenderChainStateMap.get(element.id) ?? null;
        const headElement =
          chainState && chainState.renderAsHead
            ? this.getRenderSceneElement(chainState.headId) ?? element
            : element;
        const tailElement =
          chainState && chainState.renderAsHead
            ? this.getRenderSceneElement(chainState.tailId) ?? element
            : element;
        const headVisual =
          chainState && chainState.renderAsHead
            ? buildRefrigerantPipeVisual(
                headElement,
                hvacContext,
              )
            : visual;
        const tailVisual =
          chainState && chainState.renderAsHead
            ? buildRefrigerantPipeVisual(
                tailElement,
                hvacContext,
              )
            : visual;
        const renderCenter = elementCenter(headElement);
        const localizePoint = (point: Point2D): Point2D => ({
          x: point.x - renderCenter.x,
          y: point.y - renderCenter.y,
        });
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
        const materialAwareSegments =
          !chainState?.renderAsHead && visual.segmentVisuals.length > 0
            ? visual.segmentVisuals
            : [];
        const FLEXIBLE_PIPE_DASH_PATTERN_MM = [12, 10];
        const localContinuousOuterPointSets = materialAwareSegments.length > 0
          ? materialAwareSegments.map((segment, index) =>
              index === 0
                ? buildContinuousCorePoints(localStub, segment.localPoints)
                : segment.localPoints,
            )
          : [
              chainState?.renderAsHead
                ? chainState.continuousOuterPoints.map(localizePoint)
                : visual.localContinuousOuterPoints,
            ];
        const insulationPointSets = localContinuousOuterPointSets;
        const corePointSets = materialAwareSegments.length > 0
          ? localContinuousOuterPointSets
          : [
              chainState?.renderAsHead
                ? chainState.corePoints.map(localizePoint)
                : visual.localContinuousOuterPoints,
            ];

        if (options.includeInteractionHalos) {
          createPipeHaloRectSegment(
            localStub,
            outerDiameterMm,
            palette.halo,
            0.16,
            "hvac-selection",
          );
          localContinuousOuterPointSets.forEach((polyline) =>
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
          localContinuousOuterPointSets.forEach((polyline) =>
            createPipeHaloPolyline(
              polyline,
              outerDiameterMm,
              palette.hover,
              0.12,
              "hvac-hover",
            ),
          );
        }

        const bundleControlContext = (() => {
          if (!visual.bundleId) {
            return {
              owner: true,
              selected: this.selectedIds.has(element.id),
            };
          }
          const bundleMembers = this.getRenderSceneElements()
            .filter((candidate) => candidate.type === "refrigerant-pipe")
            .map((candidate) => ({
              element: candidate,
              spec: resolveRefrigerantPipeSpec(candidate.properties),
            }))
            .filter((entry) => entry.spec.bundleId === visual.bundleId);
          if (bundleMembers.length === 0) {
            return {
              owner: true,
              selected: this.selectedIds.has(element.id),
            };
          }
          const gasOwner = bundleMembers.find(
            (entry) => entry.spec.lineKind === "gas",
          )?.element.id;
          const ownerId = gasOwner
            ?? bundleMembers
              .map((entry) => entry.element.id)
              .sort((left, right) => left.localeCompare(right))[0]!;
          return {
            owner: ownerId === element.id,
            selected: bundleMembers.some((entry) =>
              this.selectedIds.has(entry.element.id),
            ),
          };
        })();
        const showVertexHandles =
          options.includeInteractionHalos && bundleControlContext.owner;
        const vertexHandlesVisible =
          showVertexHandles && bundleControlContext.selected;
        const handleVertexIndices = buildPipeHandleVertexIndices(
          visual.routePoints,
        );
        const vertexHandleSpecs =
          showVertexHandles && handleVertexIndices.length >= 2
            ? handleVertexIndices.map((vertexIndex, handleOrderIndex) => {
                const routePoint = visual.routePoints[vertexIndex]!;
                const isEndpoint =
                  handleOrderIndex === 0 ||
                  handleOrderIndex === handleVertexIndices.length - 1;
                const leftMaterial =
                  vertexIndex > 0
                    ? visual.segmentMaterials[vertexIndex - 1] ?? "flexible"
                    : visual.segmentMaterials[0] ?? "flexible";
                const rightMaterial =
                  vertexIndex < visual.segmentMaterials.length
                    ? visual.segmentMaterials[vertexIndex] ?? leftMaterial
                    : leftMaterial;
                const isFlexibleVertex =
                  leftMaterial === "flexible" || rightMaterial === "flexible";
                if (!isFlexibleVertex) {
                  return null;
                }
                const canDragEndpoint = isEndpoint
                  ? (handleOrderIndex === 0
                    ? !startConnection
                    : !endConnection)
                  : true;
                return {
                  localPoint: localizePoint(routePoint),
                  vertexIndex,
                  draggable: canDragEndpoint,
                  endpoint: isEndpoint,
                  visible: vertexHandlesVisible,
                };
              })
                .filter(
                  (
                    spec,
                  ): spec is {
                    localPoint: Point2D;
                    vertexIndex: number;
                    draggable: boolean;
                    endpoint: boolean;
                    visible: boolean;
                  } => Boolean(spec),
                )
            : [];
        const segmentHandleSpecs =
          showVertexHandles
            ? buildHardSegmentHandleSpecs(
                visual.routePoints,
                visual.segmentMaterials,
                {
                  lockStart: Boolean(visual.startConnection),
                  lockEnd: Boolean(visual.endConnection),
                },
              ).map((segmentSpec) => ({
                startIndex: segmentSpec.startIndex,
                endIndex: segmentSpec.endIndex,
                localPoint: localizePoint(segmentSpec.midPoint),
                visible: vertexHandlesVisible,
              }))
            : [];

        if (isChainHiddenMember) {
          renderPipeRectSegment(
            visual.localStub,
            "rgba(0,0,0,0.001)",
            visual.outerDiameterMm + 8 / MM_TO_PX,
            "hvac-detail",
          );
          renderPipePolyline(
            visual.localContinuousOuterPoints,
            "rgba(0,0,0,0.001)",
            visual.outerDiameterMm + 8 / MM_TO_PX,
            "hvac-detail",
          );
          vertexHandleSpecs.forEach((handle) =>
            createPipeVertexHandle(handle.localPoint, handle.vertexIndex, {
              draggable: handle.draggable,
              endpoint: handle.endpoint,
              visible: handle.visible,
            }),
          );
          segmentHandleSpecs.forEach((handle) =>
            createPipeSegmentHandle(
              handle.localPoint,
              handle.startIndex,
              handle.endIndex,
              { visible: handle.visible },
            ),
          );
          break;
        }

        renderPipeRectSegment(
          localStub,
          insulationEdgeStroke,
          outerDiameterMm + 3,
          "hvac-detail",
        );
        renderPipeRectSegment(
          localStub,
          insulationStroke,
          outerDiameterMm,
          "hvac-detail",
        );
        if (materialAwareSegments.length > 0) {
          insulationPointSets.forEach((polyline, index) => {
            const segment = materialAwareSegments[index];
            if (!segment) {
              return;
            }
            const cap = segment.material === "flexible" ? "round" : "butt";
            renderPipePolyline(
              polyline,
              insulationEdgeStroke,
              outerDiameterMm + 3,
              "hvac-detail",
              "round",
              undefined,
              cap,
            );
            renderPipePolyline(
              polyline,
              insulationStroke,
              outerDiameterMm,
              "hvac-detail",
              "round",
              undefined,
              cap,
            );
          });
        } else {
          insulationPointSets.forEach((polyline) => {
            renderPipePolyline(
              polyline,
              insulationEdgeStroke,
              outerDiameterMm + 3,
              "hvac-detail",
              "round",
              undefined,
              "butt",
            );
            renderPipePolyline(
              polyline,
              insulationStroke,
              outerDiameterMm,
              "hvac-detail",
              "round",
              undefined,
              "butt",
            );
          });
        }
        renderPipeRectSegment(
          localStub,
          coreStroke,
          coreDiameterMm,
          "hvac-detail",
        );
        if (materialAwareSegments.length > 0) {
          corePointSets.forEach((polyline, index) => {
            const segment = materialAwareSegments[index];
            if (!segment) {
              return;
            }
            const cap = segment.material === "flexible" ? "round" : "butt";
            renderPipePolyline(
              polyline,
              coreStroke,
              coreDiameterMm,
              "hvac-detail",
              "round",
              segment.material === "flexible"
                ? FLEXIBLE_PIPE_DASH_PATTERN_MM
                : undefined,
              cap,
            );
            if (segment.invalidHardGeometry) {
              renderPipePolyline(
                segment.localPoints,
                "rgba(220,38,38,0.9)",
                coreDiameterMm + 4,
                "hvac-detail",
                "round",
                undefined,
                "round",
              );
            }
          });
        } else {
          corePointSets.forEach((polyline) =>
            renderPipePolyline(
              polyline,
              coreStroke,
              coreDiameterMm,
              "hvac-detail",
              "round",
              undefined,
              "butt",
            ),
          );
        }
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
        const stabilizerRadiusPx = Math.max(
          toPx(visual.bounds.width / 2),
          toPx(visual.bounds.height / 2),
        ) + toPx(outerDiameterMm + 10);
        objects.push(new fabric.Rect({
          left: 0,
          top: 0,
          width: stabilizerRadiusPx * 2,
          height: stabilizerRadiusPx * 2,
          originX: "center",
          originY: "center",
          fill: "transparent",
          strokeWidth: 0,
          selectable: false,
          evented: false,
        }));
        vertexHandleSpecs.forEach((handle) =>
          createPipeVertexHandle(handle.localPoint, handle.vertexIndex, {
            draggable: handle.draggable,
            endpoint: handle.endpoint,
            visible: handle.visible,
          }),
        );
        segmentHandleSpecs.forEach((handle) =>
          createPipeSegmentHandle(
            handle.localPoint,
            handle.startIndex,
            handle.endIndex,
            { visible: handle.visible },
          ),
        );
        
        break;
      }
      case "refrigerant-pipe-pair": {
        const hvacContext = this.getRenderSceneElements();
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
          lineCap: "butt" | "round" = "butt",
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
              strokeLineCap: lineCap,
              strokeLineJoin: lineJoin,
              strokeMiterLimit: lineJoin === "miter" ? 8 : 4,
              selectable: false,
              evented: false,
            },
          );
          this.annotate(polyline, element.id, name);
          objects.push(polyline);
        };
        const gasLocalContinuousOuterPoints =
          visual.gasLocalContinuousOuterPoints;
        const liquidLocalContinuousOuterPoints =
          visual.liquidLocalContinuousOuterPoints;
        const isUnitPortStartConnection =
          visual.startBundleConnection?.connectionKind === "unit-port";
        const trimPolylineStart = (
          points: Point2D[],
          trimMm: number,
        ): Point2D[] => {
          if (!isUnitPortStartConnection || trimMm <= 0.01 || points.length < 2) {
            return points;
          }
          const start = points[0]!;
          const next = points[1]!;
          const dx = next.x - start.x;
          const dy = next.y - start.y;
          const lengthMm = Math.hypot(dx, dy);
          if (lengthMm <= trimMm + 0.05) {
            return points;
          }
          const t = trimMm / lengthMm;
          return [
            {
              x: start.x + dx * t,
              y: start.y + dy * t,
            },
            ...points.slice(1),
          ];
        };
        const edgeStartTrimMm = 1.2;
        const gasLocalOuterEdgePoints = trimPolylineStart(
          gasLocalContinuousOuterPoints,
          edgeStartTrimMm,
        );
        const liquidLocalOuterEdgePoints = trimPolylineStart(
          liquidLocalContinuousOuterPoints,
          edgeStartTrimMm,
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
            gasLocalContinuousOuterPoints,
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
            liquidLocalContinuousOuterPoints,
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
            gasLocalContinuousOuterPoints,
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
            liquidLocalContinuousOuterPoints,
            visual.liquidOuterDiameterMm,
            palette.hover,
            0.12,
            "hvac-hover",
          );
        }

        renderPolyline(
          gasLocalOuterEdgePoints,
          insulationEdgeStroke,
          visual.gasOuterDiameterMm + 3,
          "hvac-detail",
          "round",
          "butt",
        );
        renderPolyline(
          liquidLocalOuterEdgePoints,
          insulationEdgeStroke,
          visual.liquidOuterDiameterMm + 3,
          "hvac-detail",
          "round",
          "butt",
        );
        renderPolyline(
          gasLocalContinuousOuterPoints,
          insulationStroke,
          visual.gasOuterDiameterMm,
          "hvac-detail",
          "round",
          "round",
        );
        renderPolyline(
          liquidLocalContinuousOuterPoints,
          insulationStroke,
          visual.liquidOuterDiameterMm,
          "hvac-detail",
          "round",
          "round",
        );

        // Keep the exposed indoor-unit stub and routed copper core in one path
        // so the 2D plan view does not show a seam at the connection.
        renderPolyline(
          visual.gasLocalContinuousCorePoints,
          gasCoreStroke,
          visual.gasCoreRadiusMm * 2,
          "hvac-detail",
          "round",
          "butt",
        );
        renderPolyline(
          visual.liquidLocalContinuousCorePoints,
          liquidCoreStroke,
          visual.liquidCoreRadiusMm * 2,
          "hvac-detail",
          "round",
          "butt",
        );
        const stabilizerRadiusPx = Math.max(
          toPx(visual.bounds.width / 2),
          toPx(visual.bounds.height / 2),
        ) + toPx(Math.max(visual.gasOuterDiameterMm, visual.liquidOuterDiameterMm) + 10);
        objects.push(new fabric.Rect({
          left: 0,
          top: 0,
          width: stabilizerRadiusPx * 2,
          height: stabilizerRadiusPx * 2,
          originX: "center",
          originY: "center",
          fill: "transparent",
          strokeWidth: 0,
          selectable: false,
          evented: false,
        }));
        
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
        });
      }
    }

    if (isIndoorUnitElement) {
      const hitAreaPaddingMm = 8 / MM_TO_PX;
      const hitBounds = customPlanBounds
        ? {
            centerX: (customPlanBounds.minX + customPlanBounds.maxX) / 2,
            centerY: (customPlanBounds.minY + customPlanBounds.maxY) / 2,
            width: customPlanBounds.maxX - customPlanBounds.minX + hitAreaPaddingMm,
            height:
              customPlanBounds.maxY - customPlanBounds.minY + hitAreaPaddingMm,
          }
        : {
            centerX: 0,
            centerY: 0,
            width: element.width + hitAreaPaddingMm,
            height: element.depth + hitAreaPaddingMm,
          };
      // Keep indoor-unit hit testing solid even when the rendered model has
      // transparent cavities or extends beyond the base casing.
      const hitArea = new fabric.Rect({
        left: toPx(hitBounds.centerX),
        top: toPx(hitBounds.centerY),
        width: Math.max(toPx(hitBounds.width), 1),
        height: Math.max(toPx(hitBounds.height), 1),
        originX: "center",
        originY: "center",
        fill: "rgba(255,255,255,0.003)",
        strokeWidth: 0,
        selectable: false,
        evented: false,
        excludeFromExport: true,
        objectCaching: false,
      });
      this.annotate(hitArea, element.id, "hvac-hit-area");
      interactionUnderlays.unshift(hitArea);
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
    const allElements = this.getRenderSceneElements();
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
    const usesPreciseHitTesting = isPipeElement;
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
    group.setCoords();

    group.id = element.id;
    group.hvacElementId = element.id;
    group.name = `hvac-${element.id}`;
    return group;
  }

  renderElement(element: HvacElement): void {
    this.removeElement(element.id);
    this.invalidatePipeSegmentTargets();
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
    this.applyRefrigerantBodyVisibility();
    this.canvas.requestRenderAll();
  }

  /**
   * Hides/shows the Fabric refrigerant-pipe bodies (the SVG studio overlay draws
   * the visible pipes when hidden). Objects stay evented so selection and
   * draw-tool snapping keep working.
   */
  setHideRefrigerantBodies(hide: boolean): void {
    if (this.hideRefrigerantBodies === hide) {
      return;
    }
    this.hideRefrigerantBodies = hide;
    this.applyRefrigerantBodyVisibility();
    this.canvas.requestRenderAll();
  }

  private applyRefrigerantBodyVisibility(): void {
    // When the SVG pipe overlay draws the visible bodies we hide the Fabric
    // bodies — but NOT to opacity 0. Pipe groups use perPixelTargetFind, which
    // hit-tests against rendered pixels; at opacity 0 there are no pixels to hit
    // and the pipe becomes almost impossible to click. A tiny non-zero opacity
    // keeps precise, pipe-shaped hit-testing alive while staying invisible under
    // the opaque overlay drawn on top.
    const targetOpacity = this.hideRefrigerantBodies ? HIDDEN_PIPE_HIT_OPACITY : 1;
    this.groups.forEach((group, id) => {
      const element = this.hvacData.get(id);
      if (!element) {
        return;
      }
      if (
        element.type === "refrigerant-pipe" ||
        element.type === "refrigerant-pipe-pair"
      ) {
        if (group.opacity !== targetOpacity) {
          group.set("opacity", targetOpacity);
        }
      }
    });
  }

  setSelectedElements(ids: string[]): void {
    this.selectedIds = new Set(ids);
    this.syncHvacVisualState();
    this.canvas.requestRenderAll();
  }

  private getPipeSegmentTargets(): VisibleRefrigerantPipeSegmentTarget[] {
    if (!this.pipeSegmentTargetsCache) {
      this.pipeSegmentTargetsCache = getVisibleRefrigerantPipeStraightSegmentTargets(
        this.getRenderSceneElements(),
      );
    }
    return this.pipeSegmentTargetsCache;
  }

  private invalidatePipeSegmentTargets(): void {
    this.pipeSegmentTargetsCache = null;
  }

  /**
   * Deterministic geometric pick for refrigerant pipes: the pipe whose centerline
   * segment is nearest the point AND within (insulation half-width + padding).
   * Pure vector math — no rendered pixels — so it is precise, matches the visible
   * pipe, and is independent of the hidden-body opacity. Overlapping bundle lines
   * tie-break by nearest, then topmost (elevation).
   */
  private pickRefrigerantPipeAtPoint(canvasPointPx: Point2D): string | null {
    const pMm = { x: canvasPointPx.x / MM_TO_PX, y: canvasPointPx.y / MM_TO_PX };
    const paddingMm = PIPE_PICK_PADDING_PX / MM_TO_PX;
    let bestId: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    let bestElevation = Number.NEGATIVE_INFINITY;
    for (const seg of this.getPipeSegmentTargets()) {
      const group = this.groups.get(seg.elementId);
      if (!group || !group.visible || !group.evented) {
        continue;
      }
      const tol = seg.outerDiameterMm / 2 + paddingMm;
      const dist = pointToSegmentDistanceMm(pMm, seg.start, seg.end);
      if (dist > tol) {
        continue;
      }
      if (
        dist < bestDist - 0.01 ||
        (Math.abs(dist - bestDist) <= 0.01 && seg.elevationMm > bestElevation)
      ) {
        bestDist = dist;
        bestElevation = seg.elevationMm;
        bestId = seg.elementId;
      }
    }
    return bestId;
  }

  findElementAtCanvasPoint(canvasPointPx: Point2D): string | null {
    // Pipes: precise geometric pick (deterministic, matches the visible pipe).
    const pipeId = this.pickRefrigerantPipeAtPoint(canvasPointPx);
    if (pipeId) {
      return pipeId;
    }
    // Everything else: bounding-box containsPoint in reverse Z-order. Pipes are
    // skipped here so their loose bbox can never over-select over empty space.
    const point = new fabric.Point(canvasPointPx.x, canvasPointPx.y);
    const objects = this.canvas.getObjects();
    for (let index = objects.length - 1; index >= 0; index -= 1) {
      const object = objects[index] as HvacGroup;
      const hvacElementId = object.hvacElementId;
      if (!hvacElementId || !object.visible || !object.evented) {
        continue;
      }
      if (this.groups.get(hvacElementId) !== object) {
        continue;
      }
      const element = this.hvacData.get(hvacElementId);
      if (
        element &&
        (element.type === "refrigerant-pipe" ||
          element.type === "refrigerant-pipe-pair")
      ) {
        continue;
      }
      if (object.containsPoint(point)) {
        return hvacElementId;
      }
    }
    return null;
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
    this.sceneElementOverrides.clear();
    this.pipeEndpointStateMap.clear();
    this.pipeRenderChainStateMap.clear();
  }
}
