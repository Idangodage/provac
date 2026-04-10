import type { HvacElement, Point2D } from "../../../types";
import { buildRefrigerantPipeVisual } from "./refrigerantPipePairModel";
import { DEFAULT_REFRIGERANT_PIPE_GAP_MM } from "./refrigerantPipeDimensions";

export type RefrigerantPipeEndpointRenderState = {
  openStart: boolean;
  openEnd: boolean;
};

export type RefrigerantPipeRenderChainState = {
  renderAsHead: boolean;
  headId: string;
  tailId: string;
  outerPoints: Point2D[];
  outerRadiusMm: number;
  corePoints: Point2D[];
  coreRadiusMm: number;
  absoluteStub: { start: Point2D; end: Point2D } | null;
  elevationMm: number;
  lineKind: "gas" | "liquid";
  openStart: boolean;
  openEnd: boolean;
};

export type VisibleRefrigerantPipeSegmentTarget = {
  key: string;
  elementId: string;
  bundleId?: string;
  lineKind: "gas" | "liquid";
  start: Point2D;
  end: Point2D;
  direction: Point2D;
  lengthMm: number;
  elevationMm: number;
  outerDiameterMm: number;
};

export type VisibleRefrigerantPipeSegmentConnection = {
  point: Point2D;
  direction: Point2D;
  segmentStart: Point2D;
  segmentEnd: Point2D;
  segmentLengthMm: number;
  projectedDistanceMm: number;
  lineKind: "gas" | "liquid";
  elevationMm: number;
  outerDiameterMm: number;
  sourceElementId: string;
};

export type VisibleRefrigerantPipeBundleSegmentConnection = {
  point: Point2D;
  gasPoint: Point2D;
  liquidPoint: Point2D;
  gasFieldPoint: Point2D;
  liquidFieldPoint: Point2D;
  gasOuterDiameterMm: number;
  liquidOuterDiameterMm: number;
  gasDirection: Point2D;
  liquidDirection: Point2D;
  direction: Point2D;
  elevationMm: number;
  gasElevationMm: number;
  liquidElevationMm: number;
  connectionKind: "field-pipe";
  sourceElementId: string;
  segmentStart: Point2D;
  segmentEnd: Point2D;
  segmentLengthMm: number;
  projectedDistanceMm: number;
};

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(point: Point2D, factor: number): Point2D {
  return { x: point.x * factor, y: point.y * factor };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeDirection(point: Point2D): Point2D {
  const length = Math.hypot(point.x, point.y);
  if (length < 0.0001) {
    return { x: 1, y: 0 };
  }
  return { x: point.x / length, y: point.y / length };
}

function interpolatePointOnAxis(
  axisPoint: Point2D,
  axisDirection: Point2D,
  axisScalar: number,
  targetScalar: number,
): Point2D {
  return add(axisPoint, scale(axisDirection, targetScalar - axisScalar));
}

function appendUniquePipeChainPoint(
  points: Point2D[],
  point: Point2D,
  toleranceMm = 0.2,
): void {
  const previous = points[points.length - 1];
  if (
    previous &&
    Math.hypot(previous.x - point.x, previous.y - point.y) <= toleranceMm
  ) {
    return;
  }
  points.push(point);
}

function appendPipeChainMemberPoints(
  chainPoints: Point2D[],
  memberPoints: Point2D[],
): void {
  if (memberPoints.length === 0) {
    return;
  }

  const PIPE_CHAIN_JOIN_TOLERANCE_MM = 6;
  if (chainPoints.length === 0) {
    memberPoints.forEach((point) =>
      appendUniquePipeChainPoint(chainPoints, point),
    );
    return;
  }

  const previousTail = chainPoints[chainPoints.length - 1]!;
  const firstPoint = memberPoints[0]!;
  const adjustedPoints =
    Math.hypot(previousTail.x - firstPoint.x, previousTail.y - firstPoint.y) <=
    PIPE_CHAIN_JOIN_TOLERANCE_MM
      ? [previousTail, ...memberPoints.slice(1)]
      : memberPoints;

  adjustedPoints.forEach((point) =>
    appendUniquePipeChainPoint(chainPoints, point),
  );
}

function absoluteStubFromPipeVisual(
  visual: ReturnType<typeof buildRefrigerantPipeVisual>,
): { start: Point2D; end: Point2D } | null {
  if (!visual.localStub) {
    return null;
  }
  return {
    start: {
      x: visual.localStub.start.x + visual.bounds.center.x,
      y: visual.localStub.start.y + visual.bounds.center.y,
    },
    end: {
      x: visual.localStub.end.x + visual.bounds.center.x,
      y: visual.localStub.end.y + visual.bounds.center.y,
    },
  };
}

function canJoinPipeRenderChain(
  upstream: ReturnType<typeof buildRefrigerantPipeVisual>,
  downstream: ReturnType<typeof buildRefrigerantPipeVisual>,
): boolean {
  return (
    upstream.lineKind === downstream.lineKind &&
    Math.abs(upstream.outerRadiusMm - downstream.outerRadiusMm) <= 0.2 &&
    Math.abs(upstream.coreRadiusMm - downstream.coreRadiusMm) <= 0.2 &&
    Math.abs(upstream.localZMm - downstream.localZMm) <= 0.2
  );
}

export function buildRefrigerantPipeEndpointRenderStateMap(
  elements: HvacElement[],
): Map<string, RefrigerantPipeEndpointRenderState> {
  const states = new Map<string, RefrigerantPipeEndpointRenderState>();
  const ownership = new Map<string, string>();
  const visuals = new Map<string, ReturnType<typeof buildRefrigerantPipeVisual>>();

  elements.forEach((element) => {
    if (element.type !== "refrigerant-pipe") {
      return;
    }
    const visual = buildRefrigerantPipeVisual(element);
    visuals.set(element.id, visual);
    states.set(element.id, {
      openStart: visual.startConnection?.connectionKind === "field-pipe",
      openEnd: visual.endConnection?.connectionKind === "field-pipe",
    });
    ownership.set(`${visual.bundleId ?? element.id}|${visual.lineKind}`, element.id);
  });

  elements.forEach((element) => {
    if (element.type !== "refrigerant-pipe") {
      return;
    }
    const visual = visuals.get(element.id);
    const sourceKey = visual?.startConnection?.sourceElementId;
    if (
      !visual ||
      visual.startConnection?.connectionKind !== "field-pipe" ||
      !sourceKey
    ) {
      return;
    }
    const upstreamId = ownership.get(`${sourceKey}|${visual.lineKind}`);
    if (!upstreamId) {
      return;
    }
    const state = states.get(upstreamId);
    if (state) {
      state.openEnd = true;
    }
  });

  return states;
}

export function buildRefrigerantPipeRenderChainStateMap(
  elements: HvacElement[],
  endpointStates: Map<string, RefrigerantPipeEndpointRenderState>,
): Map<string, RefrigerantPipeRenderChainState> {
  const visuals = new Map<string, ReturnType<typeof buildRefrigerantPipeVisual>>();
  const elementsById = new Map<string, HvacElement>();
  const ownership = new Map<string, string>();
  const upstreamById = new Map<string, string>();
  const downstreamById = new Map<string, string | null>();

  elements.forEach((element) => {
    elementsById.set(element.id, element);
    if (element.type !== "refrigerant-pipe") {
      return;
    }
    const visual = buildRefrigerantPipeVisual(element);
    visuals.set(element.id, visual);
    ownership.set(`${visual.bundleId ?? element.id}|${visual.lineKind}`, element.id);
  });

  elements.forEach((element) => {
    if (element.type !== "refrigerant-pipe") {
      return;
    }
    const visual = visuals.get(element.id);
    const sourceKey = visual?.startConnection?.sourceElementId;
    if (
      !visual ||
      visual.startConnection?.connectionKind !== "field-pipe" ||
      !sourceKey
    ) {
      return;
    }
    const upstreamId = ownership.get(`${sourceKey}|${visual.lineKind}`);
    if (!upstreamId) {
      return;
    }
    const upstreamVisual = visuals.get(upstreamId);
    if (!upstreamVisual || !canJoinPipeRenderChain(upstreamVisual, visual)) {
      return;
    }
    const existingDownstream = downstreamById.get(upstreamId);
    if (existingDownstream && existingDownstream !== element.id) {
      downstreamById.set(upstreamId, null);
      return;
    }
    upstreamById.set(element.id, upstreamId);
    downstreamById.set(upstreamId, element.id);
  });

  const chainStates = new Map<string, RefrigerantPipeRenderChainState>();
  const visited = new Set<string>();

  visuals.forEach((visual, elementId) => {
    if (visited.has(elementId)) {
      return;
    }

    let headId = elementId;
    while (upstreamById.has(headId)) {
      headId = upstreamById.get(headId)!;
    }

    const memberIds: string[] = [];
    let currentId: string | null = headId;
    while (currentId && !visited.has(currentId)) {
      memberIds.push(currentId);
      visited.add(currentId);
      const nextId = downstreamById.get(currentId);
      if (!nextId) {
        break;
      }
      currentId = nextId;
    }

    const headVisual = visuals.get(headId)!;
    const tailId = memberIds[memberIds.length - 1]!;
    const headElement = elementsById.get(headId)!;
    const outerPoints: Point2D[] = [];
    memberIds.forEach((memberId) => {
      const memberVisual = visuals.get(memberId)!;
      appendPipeChainMemberPoints(outerPoints, memberVisual.outerPoints);
    });

    const absoluteStub = absoluteStubFromPipeVisual(headVisual);
    const headEndpointState = endpointStates.get(headId) ?? {
      openStart: false,
      openEnd: false,
    };
    const tailEndpointState = endpointStates.get(tailId) ?? {
      openStart: false,
      openEnd: false,
    };

    memberIds.forEach((memberId, index) => {
      chainStates.set(memberId, {
        renderAsHead: index === 0,
        headId,
        tailId,
        outerPoints,
        outerRadiusMm: headVisual.outerRadiusMm,
        corePoints: [...outerPoints],
        coreRadiusMm: headVisual.coreRadiusMm,
        absoluteStub: index === 0 ? absoluteStub : null,
        elevationMm: headElement.elevation + headVisual.localZMm,
        lineKind: headVisual.lineKind,
        openStart: headEndpointState.openStart,
        openEnd: tailEndpointState.openEnd,
      });
    });
  });

  return chainStates;
}

export function getVisibleRefrigerantPipeStraightSegmentTargets(
  elements: HvacElement[],
): VisibleRefrigerantPipeSegmentTarget[] {
  const endpointStates = buildRefrigerantPipeEndpointRenderStateMap(elements);
  const chainStates = buildRefrigerantPipeRenderChainStateMap(
    elements,
    endpointStates,
  );
  const targets: VisibleRefrigerantPipeSegmentTarget[] = [];

  elements.forEach((element) => {
    if (element.type !== "refrigerant-pipe") {
      return;
    }

    const chainState = chainStates.get(element.id) ?? null;
    if (chainState && !chainState.renderAsHead) {
      return;
    }

    const visual = buildRefrigerantPipeVisual(element);
    const headElement =
      chainState ? elements.find((candidate) => candidate.id === chainState.headId) ?? element : element;
    const headVisual =
      chainState && headElement.type === "refrigerant-pipe"
        ? buildRefrigerantPipeVisual(headElement)
        : visual;
    const points = chainState?.outerPoints ?? visual.outerPoints;
    const sourceElementId = chainState?.headId ?? (headElement.id ?? element.id);
    const elevationMm = chainState?.elevationMm ?? (element.elevation + visual.localZMm);
    const outerDiameterMm = chainState
      ? chainState.outerRadiusMm * 2
      : visual.outerDiameterMm;
    const bundleId = headVisual.bundleId;
    const lineKind = chainState?.lineKind ?? visual.lineKind;

    if (points.length < 2) {
      return;
    }

    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]!;
      const end = points[index + 1]!;
      const delta = subtract(end, start);
      const lengthMm = Math.hypot(delta.x, delta.y);
      if (lengthMm < 0.01) {
        continue;
      }
      targets.push({
        key: `${sourceElementId}:visible-segment:${index}`,
        elementId: sourceElementId,
        bundleId,
        lineKind,
        start,
        end,
        direction: normalizeDirection(delta),
        lengthMm,
        elevationMm,
        outerDiameterMm,
      });
    }
  });

  return targets;
}

export function findNearestVisibleRefrigerantPipeSegmentTarget(
  elements: HvacElement[],
  point: Point2D,
  thresholdMm: number,
  options?: {
    lineKind?: "gas" | "liquid";
    minSegmentLengthMm?: number;
  },
): VisibleRefrigerantPipeSegmentConnection | null {
  const minimumSegmentLengthMm = Math.max(1, options?.minSegmentLengthMm ?? 1);
  const targets = getVisibleRefrigerantPipeStraightSegmentTargets(elements).filter(
    (target) =>
      (!options?.lineKind || target.lineKind === options.lineKind) &&
      target.lengthMm >= minimumSegmentLengthMm,
  );
  let bestTarget: VisibleRefrigerantPipeSegmentConnection | null = null;
  let bestDistance = thresholdMm;

  targets.forEach((target) => {
    const projectedScalar = clamp(
      dot(subtract(point, target.start), target.direction),
      0,
      target.lengthMm,
    );
    const projectedPoint = add(
      target.start,
      scale(target.direction, projectedScalar),
    );
    const distanceMm = Math.hypot(
      point.x - projectedPoint.x,
      point.y - projectedPoint.y,
    );
    if (distanceMm > bestDistance) {
      return;
    }
    bestDistance = distanceMm;
    bestTarget = {
      point: projectedPoint,
      direction: target.direction,
      segmentStart: target.start,
      segmentEnd: target.end,
      segmentLengthMm: target.lengthMm,
      projectedDistanceMm: projectedScalar,
      lineKind: target.lineKind,
      elevationMm: target.elevationMm,
      outerDiameterMm: target.outerDiameterMm,
      sourceElementId: target.bundleId ?? target.elementId,
    };
  });

  return bestTarget;
}

export function findNearestVisibleRefrigerantPipeBundleSegmentTarget(
  elements: HvacElement[],
  point: Point2D,
  thresholdMm: number,
  options?: {
    minSegmentLengthMm?: number;
  },
): VisibleRefrigerantPipeBundleSegmentConnection | null {
  const minimumSegmentLengthMm = Math.max(1, options?.minSegmentLengthMm ?? 1);
  const straightSegments = getVisibleRefrigerantPipeStraightSegmentTargets(elements);
  const gasSegments = straightSegments.filter((segment) => segment.lineKind === "gas");
  const liquidSegments = straightSegments.filter((segment) => segment.lineKind === "liquid");
  const candidates: Array<{
    gas: VisibleRefrigerantPipeSegmentTarget;
    liquid: VisibleRefrigerantPipeSegmentTarget;
    score: number;
  }> = [];

  gasSegments.forEach((gasSegment) => {
    liquidSegments.forEach((liquidSegment) => {
      const directionDot = dot(gasSegment.direction, liquidSegment.direction);
      if (Math.abs(directionDot) < 0.985) {
        return;
      }

      const averageDirection =
        directionDot >= 0
          ? normalizeDirection(add(gasSegment.direction, liquidSegment.direction))
          : gasSegment.direction;
      const gasStartScalar = dot(gasSegment.start, averageDirection);
      const gasEndScalar = dot(gasSegment.end, averageDirection);
      const liquidStartScalar = dot(liquidSegment.start, averageDirection);
      const liquidEndScalar = dot(liquidSegment.end, averageDirection);
      const overlapStartScalar = Math.max(
        Math.min(gasStartScalar, gasEndScalar),
        Math.min(liquidStartScalar, liquidEndScalar),
      );
      const overlapEndScalar = Math.min(
        Math.max(gasStartScalar, gasEndScalar),
        Math.max(liquidStartScalar, liquidEndScalar),
      );
      const overlapLengthMm = overlapEndScalar - overlapStartScalar;
      if (overlapLengthMm < minimumSegmentLengthMm) {
        return;
      }

      const bundleStartGasPoint = interpolatePointOnAxis(
        gasSegment.start,
        averageDirection,
        gasStartScalar,
        overlapStartScalar,
      );
      const bundleStartLiquidPoint = interpolatePointOnAxis(
        liquidSegment.start,
        averageDirection,
        liquidStartScalar,
        overlapStartScalar,
      );
      const bundleEndGasPoint = interpolatePointOnAxis(
        gasSegment.start,
        averageDirection,
        gasStartScalar,
        overlapEndScalar,
      );
      const bundleEndLiquidPoint = interpolatePointOnAxis(
        liquidSegment.start,
        averageDirection,
        liquidStartScalar,
        overlapEndScalar,
      );
      const spacingMm =
        (Math.hypot(
          bundleStartLiquidPoint.x - bundleStartGasPoint.x,
          bundleStartLiquidPoint.y - bundleStartGasPoint.y,
        ) +
          Math.hypot(
            bundleEndLiquidPoint.x - bundleEndGasPoint.x,
            bundleEndLiquidPoint.y - bundleEndGasPoint.y,
          )) /
        2;
      const expectedSpacingMm =
        gasSegment.outerDiameterMm / 2 +
        liquidSegment.outerDiameterMm / 2 +
        DEFAULT_REFRIGERANT_PIPE_GAP_MM;
      const spacingToleranceMm = Math.max(18, expectedSpacingMm * 0.4);
      const spacingErrorMm = Math.abs(spacingMm - expectedSpacingMm);
      const sharesBundleId = Boolean(
        gasSegment.bundleId &&
          liquidSegment.bundleId &&
          gasSegment.bundleId === liquidSegment.bundleId,
      );
      if (!sharesBundleId && spacingErrorMm > spacingToleranceMm) {
        return;
      }

      const segmentStart = {
        x: (bundleStartGasPoint.x + bundleStartLiquidPoint.x) / 2,
        y: (bundleStartGasPoint.y + bundleStartLiquidPoint.y) / 2,
      };
      const segmentEnd = {
        x: (bundleEndGasPoint.x + bundleEndLiquidPoint.x) / 2,
        y: (bundleEndGasPoint.y + bundleEndLiquidPoint.y) / 2,
      };
      const segmentLengthMm = Math.hypot(
        segmentEnd.x - segmentStart.x,
        segmentEnd.y - segmentStart.y,
      );
      if (segmentLengthMm < minimumSegmentLengthMm) {
        return;
      }

      candidates.push({
        gas: gasSegment,
        liquid: liquidSegment,
        score: spacingErrorMm + (sharesBundleId ? 0 : 200),
      });
    });
  });

  candidates.sort((a, b) => a.score - b.score);

  let bestTarget: VisibleRefrigerantPipeBundleSegmentConnection | null = null;
  let bestDistance = thresholdMm;

  candidates.forEach(({ gas, liquid }) => {
    const directionDot = dot(gas.direction, liquid.direction);
    const direction =
      directionDot >= 0
        ? normalizeDirection(add(gas.direction, liquid.direction))
        : gas.direction;
    const gasStartScalar = dot(gas.start, direction);
    const gasEndScalar = dot(gas.end, direction);
    const liquidStartScalar = dot(liquid.start, direction);
    const liquidEndScalar = dot(liquid.end, direction);
    const overlapStartScalar = Math.max(
      Math.min(gasStartScalar, gasEndScalar),
      Math.min(liquidStartScalar, liquidEndScalar),
    );
    const overlapEndScalar = Math.min(
      Math.max(gasStartScalar, gasEndScalar),
      Math.max(liquidStartScalar, liquidEndScalar),
    );
    const gasPointStart = interpolatePointOnAxis(
      gas.start,
      direction,
      gasStartScalar,
      overlapStartScalar,
    );
    const liquidPointStart = interpolatePointOnAxis(
      liquid.start,
      direction,
      liquidStartScalar,
      overlapStartScalar,
    );
    const gasPointEnd = interpolatePointOnAxis(
      gas.start,
      direction,
      gasStartScalar,
      overlapEndScalar,
    );
    const liquidPointEnd = interpolatePointOnAxis(
      liquid.start,
      direction,
      liquidStartScalar,
      overlapEndScalar,
    );
    const segmentStart = {
      x: (gasPointStart.x + liquidPointStart.x) / 2,
      y: (gasPointStart.y + liquidPointStart.y) / 2,
    };
    const segmentEnd = {
      x: (gasPointEnd.x + liquidPointEnd.x) / 2,
      y: (gasPointEnd.y + liquidPointEnd.y) / 2,
    };
    const segmentVector = subtract(segmentEnd, segmentStart);
    const segmentLengthMm = Math.max(
      Math.hypot(segmentVector.x, segmentVector.y),
      0.0001,
    );
    if (segmentLengthMm < minimumSegmentLengthMm) {
      return;
    }
    const projectedScalar = clamp(
      dot(subtract(point, segmentStart), direction),
      0,
      segmentLengthMm,
    );
    const bundlePoint = add(segmentStart, scale(direction, projectedScalar));
    const distanceMm = Math.hypot(point.x - bundlePoint.x, point.y - bundlePoint.y);
    if (distanceMm > bestDistance) {
      return;
    }

    const segmentStartScalar = dot(segmentStart, direction);
    const gasVisibleStartScalar = dot(gasPointStart, direction);
    const liquidVisibleStartScalar = dot(liquidPointStart, direction);
    const gasPoint = interpolatePointOnAxis(
      gasPointStart,
      direction,
      gasVisibleStartScalar,
      segmentStartScalar + projectedScalar,
    );
    const liquidPoint = interpolatePointOnAxis(
      liquidPointStart,
      direction,
      liquidVisibleStartScalar,
      segmentStartScalar + projectedScalar,
    );

    bestDistance = distanceMm;
    bestTarget = {
      point: bundlePoint,
      gasPoint,
      liquidPoint,
      gasFieldPoint: gasPoint,
      liquidFieldPoint: liquidPoint,
      gasOuterDiameterMm: gas.outerDiameterMm,
      liquidOuterDiameterMm: liquid.outerDiameterMm,
      gasDirection: gas.direction,
      liquidDirection: liquid.direction,
      direction,
      elevationMm: (gas.elevationMm + liquid.elevationMm) / 2,
      gasElevationMm: gas.elevationMm,
      liquidElevationMm: liquid.elevationMm,
      connectionKind: "field-pipe",
      sourceElementId: gas.bundleId ?? gas.elementId,
      segmentStart,
      segmentEnd,
      segmentLengthMm,
      projectedDistanceMm: projectedScalar,
    };
  });

  return bestTarget;
}
