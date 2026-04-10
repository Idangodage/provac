import type { HvacElement, Point2D } from "../../../types";
import {
  DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
  DEFAULT_REFRIGERANT_PIPE_GAP_MM,
  INCH_MM,
} from "./refrigerantPipeDimensions";

export type RefrigerantBranchKitSubtype = "dis-22-1g";
export type RefrigerantBranchLineKind = "gas" | "liquid";
export type RefrigerantBranchTerminalRole =
  | "inlet"
  | "run-outlet"
  | "branch-outlet";

export interface RefrigerantBranchKitBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  center: Point2D;
}

export interface RefrigerantBranchKitTerminalSpec {
  key: string;
  kind: RefrigerantBranchLineKind;
  role: RefrigerantBranchTerminalRole;
  point: Point2D;
  direction: Point2D;
  coreDiameterMm: number;
  outerDiameterMm: number;
  socketLengthMm: number;
}

export interface RefrigerantBranchKitTubeSpec {
  points: Point2D[];
  coreDiameterMm: number;
  outerDiameterMm: number;
}

export interface RefrigerantBranchKitReducerSpec {
  start: Point2D;
  end: Point2D;
  startCoreDiameterMm: number;
  endCoreDiameterMm: number;
  startOuterDiameterMm: number;
  endOuterDiameterMm: number;
}

export interface RefrigerantBranchKitBandSpec {
  center: Point2D;
  direction: Point2D;
  lengthMm: number;
  outerDiameterMm: number;
  coreDiameterMm: number;
}

export interface RefrigerantBranchKitManifoldSpec {
  outline: Point2D[];
  highlightPath: Point2D[];
  depthMm: number;
}

export interface RefrigerantBranchKitJunctionSpec {
  mainSections: RefrigerantBranchKitReducerSpec[];
  branchSection: RefrigerantBranchKitReducerSpec;
}

export interface RefrigerantBranchKitNodeSpec {
  center: Point2D;
  lengthMm: number;
  outerDiameterMm: number;
  coreDiameterMm: number;
}

export interface RefrigerantBranchKitLineSpec {
  kind: RefrigerantBranchLineKind;
  overallLengthMm: number;
  outletSeparationMm: number;
  centerlineZMm: number;
  inletTube: RefrigerantBranchKitTubeSpec;
  inletRunTube: RefrigerantBranchKitTubeSpec;
  mainTube: RefrigerantBranchKitTubeSpec;
  branchTube: RefrigerantBranchKitTubeSpec;
  inletReducer: RefrigerantBranchKitReducerSpec | null;
  manifold: RefrigerantBranchKitManifoldSpec;
  junction: RefrigerantBranchKitJunctionSpec;
  splitNode: RefrigerantBranchKitNodeSpec;
  inletTerminal: RefrigerantBranchKitTerminalSpec;
  runOutletTerminal: RefrigerantBranchKitTerminalSpec;
  branchOutletTerminal: RefrigerantBranchKitTerminalSpec;
  bands: RefrigerantBranchKitBandSpec[];
}

export interface RefrigerantBranchKitModelSpec {
  subtype: RefrigerantBranchKitSubtype;
  bounds: RefrigerantBranchKitBounds;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  gas: RefrigerantBranchKitLineSpec;
  liquid: RefrigerantBranchKitLineSpec;
  stackGapMm: number;
  labelAnchor: Point2D;
}

export const REFRIGERANT_BRANCH_KIT_COLOR_PALETTE = {
  insulationBody: "#bb7645",
  insulationEdge: "#865230",
  insulationShadow: "#e4b487",
  fittingBand: "#996038",
  fittingBandEdge: "#deb28a",
  gasCopper: "#c9854e",
  liquidCopper: "#d79a67",
  nodeOuter: "#b87343",
  nodeInner: "#e0b082",
} as const;

const DEFAULT_BRANCH_KIT_SUBTYPE: RefrigerantBranchKitSubtype = "dis-22-1g";
const DEFAULT_BRANCH_KIT_WALL_ALLOWANCE_MM = 0.9;

interface BranchLineBuildConfig {
  kind: RefrigerantBranchLineKind;
  leftX: number;
  centerY: number;
  overallLengthMm: number;
  outletSeparationMm: number;
  inletCoreDiameterMm: number;
  runCoreDiameterMm: number;
  branchCoreDiameterMm: number;
  wallAllowanceMm: number;
}

function subtractPoint(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function readNumberProperty(
  properties: Record<string, unknown>,
  key: string,
): number | null {
  const value = properties[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveCopperBodyDiameterMm(
  coreDiameterMm: number,
  wallAllowanceMm: number,
): number {
  return Math.max(
    coreDiameterMm + wallAllowanceMm,
    Math.min(DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM, coreDiameterMm * 1.16),
  );
}

function sampleCubicBezierPoints(
  start: Point2D,
  control1: Point2D,
  control2: Point2D,
  end: Point2D,
  segments: number,
): Point2D[] {
  const points: Point2D[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const mt = 1 - t;
    points.push({
      x:
        mt * mt * mt * start.x +
        3 * mt * mt * t * control1.x +
        3 * mt * t * t * control2.x +
        t * t * t * end.x,
      y:
        mt * mt * mt * start.y +
        3 * mt * mt * t * control1.y +
        3 * mt * t * t * control2.y +
        t * t * t * end.y,
    });
  }
  return dedupeConsecutivePoints(points);
}

function resolveBranchKitSubtype(
  element: Pick<HvacElement, "subtype" | "modelLabel" | "properties">,
): RefrigerantBranchKitSubtype {
  const subtypeValue =
    (typeof element.properties.branchKitType === "string"
      ? element.properties.branchKitType
      : null) ??
    element.subtype ??
    element.modelLabel ??
    DEFAULT_BRANCH_KIT_SUBTYPE;
  return String(subtypeValue).toLowerCase() === "dis-22-1g"
    ? "dis-22-1g"
    : DEFAULT_BRANCH_KIT_SUBTYPE;
}

function dedupeConsecutivePoints(points: Point2D[]): Point2D[] {
  const deduped: Point2D[] = [];
  points.forEach((point) => {
    const previous = deduped[deduped.length - 1];
    if (
      !previous ||
      Math.hypot(previous.x - point.x, previous.y - point.y) > 0.01
    ) {
      deduped.push(point);
    }
  });
  return deduped;
}

function computeBounds(
  points: Point2D[],
  paddingMm: number,
): RefrigerantBranchKitBounds {
  let minX = points[0]?.x ?? 0;
  let minY = points[0]?.y ?? 0;
  let maxX = points[0]?.x ?? 0;
  let maxY = points[0]?.y ?? 0;

  points.forEach((point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  });

  minX -= paddingMm;
  minY -= paddingMm;
  maxX += paddingMm;
  maxY += paddingMm;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
    },
  };
}

function translatePoint(point: Point2D, offset: Point2D): Point2D {
  return subtractPoint(point, offset);
}

function translatePoints(points: Point2D[], offset: Point2D): Point2D[] {
  return points.map((point) => translatePoint(point, offset));
}

function translateReducer(
  reducer: RefrigerantBranchKitReducerSpec | null,
  offset: Point2D,
): RefrigerantBranchKitReducerSpec | null {
  if (!reducer) {
    return null;
  }
  return {
    ...reducer,
    start: translatePoint(reducer.start, offset),
    end: translatePoint(reducer.end, offset),
  };
}

function translateManifold(
  manifold: RefrigerantBranchKitManifoldSpec,
  offset: Point2D,
): RefrigerantBranchKitManifoldSpec {
  return {
    ...manifold,
    outline: translatePoints(manifold.outline, offset),
    highlightPath: translatePoints(manifold.highlightPath, offset),
  };
}

function translateJunction(
  junction: RefrigerantBranchKitJunctionSpec,
  offset: Point2D,
): RefrigerantBranchKitJunctionSpec {
  return {
    mainSections: junction.mainSections.map((section) => ({
      ...section,
      start: translatePoint(section.start, offset),
      end: translatePoint(section.end, offset),
    })),
    branchSection: {
      ...junction.branchSection,
      start: translatePoint(junction.branchSection.start, offset),
      end: translatePoint(junction.branchSection.end, offset),
    },
  };
}

function translateBand(
  band: RefrigerantBranchKitBandSpec,
  offset: Point2D,
): RefrigerantBranchKitBandSpec {
  return {
    ...band,
    center: translatePoint(band.center, offset),
  };
}

function buildBranchLineGeometry(
  config: BranchLineBuildConfig,
): RefrigerantBranchKitLineSpec {
  const runOuterDiameterMm = resolveCopperBodyDiameterMm(
    config.runCoreDiameterMm,
    config.wallAllowanceMm,
  );
  const branchOuterDiameterMm = resolveCopperBodyDiameterMm(
    config.branchCoreDiameterMm,
    config.wallAllowanceMm,
  );
  const inletOuterDiameterMm = resolveCopperBodyDiameterMm(
    config.inletCoreDiameterMm,
    config.wallAllowanceMm,
  );

  const rightX = config.leftX + config.overallLengthMm;
  const manifoldOutletBoundaryGapMm = 2;
  const outletFaceHalfHeightMm =
    runOuterDiameterMm / 2 + manifoldOutletBoundaryGapMm;
  const runCenterY = config.centerY;
  const branchY = runCenterY + config.outletSeparationMm;
  const runOutletTopY = runCenterY - outletFaceHalfHeightMm;
  const runOutletBottomY = runCenterY + outletFaceHalfHeightMm;
  const inletSocketLengthMm = clamp(config.overallLengthMm * 0.18, 54, 78);
  const reducerLengthMm = clamp(config.overallLengthMm * 0.085, 26, 40);
  const runOutletSocketLengthMm = clamp(config.overallLengthMm * 0.16, 46, 64);
  const branchOutletSocketLengthMm = clamp(
    config.overallLengthMm * 0.145,
    42,
    60,
  );
  const reducerStartX = config.leftX + inletSocketLengthMm;
  const reducerEndX = reducerStartX + reducerLengthMm;
  const collectorLengthMm = clamp(config.overallLengthMm * 0.12, 36, 52);
  const splitX = reducerEndX + clamp(config.overallLengthMm * 0.15, 46, 68);
  const collectorStartX = splitX - collectorLengthMm / 2;
  const collectorEndX = splitX + collectorLengthMm / 2;
  const junctionSleeve1LengthMm = clamp(collectorLengthMm * 0.16, 7, 10);
  const junctionSleeve2LengthMm = clamp(collectorLengthMm * 0.15, 6, 10);
  const junctionTransition1LengthMm = clamp(collectorLengthMm * 0.12, 5, 8);
  const junctionTransition2LengthMm = clamp(collectorLengthMm * 0.14, 6, 9);
  const junctionBodyLengthMm = clamp(collectorLengthMm * 0.72, 28, 38);
  const junctionBodyStartX =
    splitX - junctionBodyLengthMm * 0.44;
  const junctionBodyEndX = junctionBodyStartX + junctionBodyLengthMm;
  const junctionSleeve2StartX =
    junctionBodyStartX - junctionTransition2LengthMm - junctionSleeve2LengthMm;
  const junctionSleeve2EndX = junctionSleeve2StartX + junctionSleeve2LengthMm;
  const junctionSleeve1StartX =
    junctionSleeve2StartX -
    junctionTransition1LengthMm -
    junctionSleeve1LengthMm;
  const junctionSleeve1EndX = junctionSleeve1StartX + junctionSleeve1LengthMm;
  const runOutletStartX = junctionBodyEndX;
  const branchOutletSocketStartX = rightX - branchOutletSocketLengthMm;
  const junctionSleeve1OuterDiameterMm = Math.max(
    runOuterDiameterMm * 1.08,
    branchOuterDiameterMm * 1.02,
  );
  const junctionSleeve2OuterDiameterMm = Math.max(
    runOuterDiameterMm * 1.14,
    branchOuterDiameterMm * 1.08,
  );
  const junctionBodyOuterDiameterMm = Math.max(
    runOuterDiameterMm * 1.42,
    branchOuterDiameterMm * 1.54,
  );
  const junctionSleeve1CoreDiameterMm = Math.max(
    config.runCoreDiameterMm * 1.02,
    config.branchCoreDiameterMm,
  );
  const junctionSleeve2CoreDiameterMm = Math.max(
    config.runCoreDiameterMm * 1.06,
    config.branchCoreDiameterMm * 1.02,
  );
  const junctionBodyCoreDiameterMm = Math.max(
    config.runCoreDiameterMm * 1.18,
    config.branchCoreDiameterMm * 1.14,
  );
  const branchSectionStartOuterDiameterMm = Math.max(
    branchOuterDiameterMm * 1.42,
    runOuterDiameterMm * 1.18,
  );
  const branchSectionEndOuterDiameterMm = Math.max(
    branchOuterDiameterMm * 1.2,
    branchOuterDiameterMm + 1.2,
  );
  const branchSectionStartCoreDiameterMm = Math.max(
    config.branchCoreDiameterMm * 1.16,
    config.runCoreDiameterMm * 0.96,
  );
  const branchSectionEndCoreDiameterMm = Math.max(
    config.branchCoreDiameterMm * 1.08,
    config.branchCoreDiameterMm + 0.6,
  );
  const manifoldOutletGapMm = clamp(
    Math.min(runOuterDiameterMm, branchSectionEndOuterDiameterMm) * 0.18,
    2.2,
    4.2,
  );
  const outletMouthCenterSpacingMm =
    runOuterDiameterMm / 2 +
    branchSectionEndOuterDiameterMm / 2 +
    manifoldOutletGapMm;
  const branchSectionStartX = junctionBodyStartX + junctionBodyLengthMm * 0.3;
  const branchSectionEndX = junctionBodyEndX;
  const branchSectionEndY =
    runCenterY + outletMouthCenterSpacingMm;
  const branchOutletTopY =
    branchSectionEndY -
    branchSectionEndOuterDiameterMm / 2 -
    manifoldOutletBoundaryGapMm;
  const branchOutletBottomY =
    branchSectionEndY +
    branchSectionEndOuterDiameterMm / 2 +
    manifoldOutletBoundaryGapMm;
  // The inlet axis follows the center of the overall outlet face envelope.
  // This is the midpoint between the top of the straight outlet face and the
  // bottom of the offset outlet face, matching the branch-kit reference.
  const trunkCenterY = (runOutletTopY + branchOutletBottomY) / 2;
  const branchSectionStartY =
    trunkCenterY + junctionBodyOuterDiameterMm * 0.1;
  const branchSectionStart = {
    x: branchSectionStartX,
    y: branchSectionStartY,
  };
  const branchSectionEnd = {
    x: branchSectionEndX,
    y: branchSectionEndY,
  };
  const manifoldLeftX = junctionSleeve1StartX;
  const manifoldRightX = junctionBodyEndX;
  const manifoldSpanMm = manifoldRightX - manifoldLeftX;
  const manifoldNeckHalfHeight = outletFaceHalfHeightMm;
  const manifoldFlatStartX = manifoldLeftX + manifoldSpanMm * 0.34;
  const manifoldFlatEndX = manifoldRightX - manifoldSpanMm * 0.22;
  const manifoldLeftShoulderControlX = manifoldLeftX + manifoldSpanMm * 0.14;
  const manifoldRightShoulderControlX = manifoldRightX - manifoldSpanMm * 0.1;
  const manifoldBodyBulgeMm = clamp(
    Math.max(
      junctionBodyOuterDiameterMm,
      runOuterDiameterMm,
      branchSectionEndOuterDiameterMm,
    ) * 0.2,
    3,
    6,
  );
  const manifoldTopY = trunkCenterY - (manifoldNeckHalfHeight + manifoldBodyBulgeMm);
  const manifoldBottomY =
    trunkCenterY + manifoldNeckHalfHeight + manifoldBodyBulgeMm;
  const manifoldTopStart = {
    x: manifoldLeftX,
    y: trunkCenterY - manifoldNeckHalfHeight,
  };
  const manifoldBottomStart = {
    x: manifoldLeftX,
    y: trunkCenterY + manifoldNeckHalfHeight,
  };
  const manifoldTopProfile = dedupeConsecutivePoints([
    manifoldTopStart,
    ...sampleCubicBezierPoints(
      manifoldTopStart,
      {
        x: manifoldLeftShoulderControlX,
        y: manifoldTopStart.y,
      },
      {
        x: manifoldFlatStartX - manifoldSpanMm * 0.14,
        y: manifoldTopY,
      },
      {
        x: manifoldFlatStartX,
        y: manifoldTopY,
      },
      28,
    ).slice(1),
    { x: manifoldFlatEndX, y: manifoldTopY },
    ...sampleCubicBezierPoints(
      { x: manifoldFlatEndX, y: manifoldTopY },
      {
        x: manifoldFlatEndX + manifoldSpanMm * 0.1,
        y: manifoldTopY,
      },
      {
        x: manifoldRightShoulderControlX,
        y: runOutletTopY,
      },
      { x: manifoldRightX, y: runOutletTopY },
      28,
    ).slice(1),
  ]);
  const outletVerticalGapMm = branchOutletTopY - runOutletBottomY;
  const outletWaistInsetMm =
    outletVerticalGapMm > 0.4
      ? clamp(outletVerticalGapMm * 0.78, 4.5, 12)
      : 0;
  const outletRightContour =
    outletWaistInsetMm > 0
      ? dedupeConsecutivePoints([
          { x: manifoldRightX, y: runOutletTopY },
          { x: manifoldRightX, y: runOutletBottomY },
          ...sampleCubicBezierPoints(
            { x: manifoldRightX, y: runOutletBottomY },
            {
              x: manifoldRightX,
              y: runOutletBottomY + outletVerticalGapMm * 0.22,
            },
            {
              x: manifoldRightX - outletWaistInsetMm,
              y: runOutletBottomY + outletVerticalGapMm * 0.42,
            },
            {
              x: manifoldRightX - outletWaistInsetMm,
              y: runOutletBottomY + outletVerticalGapMm * 0.5,
            },
            4,
          ).slice(1),
          ...sampleCubicBezierPoints(
            {
              x: manifoldRightX - outletWaistInsetMm,
              y: runOutletBottomY + outletVerticalGapMm * 0.5,
            },
            {
              x: manifoldRightX - outletWaistInsetMm,
              y: runOutletBottomY + outletVerticalGapMm * 0.58,
            },
            {
              x: manifoldRightX,
              y: branchOutletTopY - outletVerticalGapMm * 0.22,
            },
            { x: manifoldRightX, y: branchOutletTopY },
            4,
          ).slice(1),
          { x: manifoldRightX, y: branchOutletBottomY },
        ])
      : dedupeConsecutivePoints([
          { x: manifoldRightX, y: runOutletTopY },
          { x: manifoldRightX, y: branchOutletBottomY },
        ]);
  const manifoldBottomProfile = dedupeConsecutivePoints([
    { x: manifoldRightX, y: branchOutletBottomY },
    ...sampleCubicBezierPoints(
      { x: manifoldRightX, y: branchOutletBottomY },
      {
        x: manifoldRightShoulderControlX,
        y: branchOutletBottomY,
      },
      {
        x: manifoldFlatEndX + manifoldSpanMm * 0.1,
        y: manifoldBottomY,
      },
      {
        x: manifoldFlatEndX,
        y: manifoldBottomY,
      },
      28,
    ).slice(1),
    { x: manifoldFlatStartX, y: manifoldBottomY },
    ...sampleCubicBezierPoints(
      { x: manifoldFlatStartX, y: manifoldBottomY },
      {
        x: manifoldFlatStartX - manifoldSpanMm * 0.14,
        y: manifoldBottomY,
      },
      {
        x: manifoldLeftShoulderControlX,
        y: manifoldBottomStart.y,
      },
      manifoldBottomStart,
      28,
    ).slice(1),
  ]);
  const manifoldLeftBulgeMm = clamp(
    Math.max(junctionBodyOuterDiameterMm, branchSectionEndOuterDiameterMm) * 0.24,
    3.2,
    6.6,
  );
  const manifoldLeftContour = dedupeConsecutivePoints(
    sampleCubicBezierPoints(
      manifoldBottomStart,
      {
        x: manifoldLeftX - manifoldLeftBulgeMm,
        y: manifoldBottomStart.y,
      },
      {
        x: manifoldLeftX - manifoldLeftBulgeMm,
        y: manifoldTopStart.y,
      },
      manifoldTopStart,
      28,
    ),
  );
  const manifold: RefrigerantBranchKitManifoldSpec = {
    outline: dedupeConsecutivePoints([
      ...manifoldTopProfile,
      ...outletRightContour.slice(1),
      ...manifoldBottomProfile.slice(1),
      ...manifoldLeftContour.slice(1, -1),
    ]),
    highlightPath: manifoldTopProfile,
    depthMm: junctionBodyOuterDiameterMm,
  };
  const branchStraightFromJunctionMm = clamp(
    config.overallLengthMm * 0.03,
    10,
    16,
  );
  const branchCurveStart = {
    x: branchSectionEnd.x,
    y: branchSectionEnd.y,
  };
  const branchStraightEnd = {
    x: branchCurveStart.x + branchStraightFromJunctionMm,
    y: branchCurveStart.y,
  };
  const branchDiagonalDropMm = Math.max(branchY - branchStraightEnd.y, 0);
  const minBranchTailMm = clamp(config.overallLengthMm * 0.14, 42, 58);
  const branchOffsetTravelMm = Math.min(
    branchDiagonalDropMm,
    Math.max(branchOutletSocketStartX - branchStraightEnd.x - minBranchTailMm, 0),
  );
  const branchFirstBendRadiusMm = clamp(branchOffsetTravelMm * 0.12, 4, 8);
  const branchSecondBendRadiusMm = clamp(branchOffsetTravelMm * 0.12, 4, 8);
  const branchFirstBendEnd = {
    x: branchStraightEnd.x + branchFirstBendRadiusMm,
    y: branchStraightEnd.y + branchFirstBendRadiusMm,
  };
  const branchSecondBendStart = {
    x:
      branchStraightEnd.x +
      branchOffsetTravelMm -
      branchSecondBendRadiusMm,
    y:
      branchStraightEnd.y +
      branchOffsetTravelMm -
      branchSecondBendRadiusMm,
  };
  const branchSecondBendEnd = {
    x: branchStraightEnd.x + branchOffsetTravelMm,
    y: branchY,
  };
  const firstBendCurvePoints =
    branchFirstBendEnd.x - branchStraightEnd.x > 0.5
      ? sampleCubicBezierPoints(
          branchStraightEnd,
          {
            x: branchStraightEnd.x + branchFirstBendRadiusMm * 0.72,
            y: branchStraightEnd.y,
          },
          {
            x: branchFirstBendEnd.x,
            y: branchFirstBendEnd.y - branchFirstBendRadiusMm * 0.72,
          },
          branchFirstBendEnd,
          4,
        )
      : [branchStraightEnd, branchFirstBendEnd];
  const secondBendCurvePoints =
    branchSecondBendEnd.x - branchSecondBendStart.x > 0.5
      ? sampleCubicBezierPoints(
          branchSecondBendStart,
          {
            x:
              branchSecondBendStart.x +
              branchSecondBendRadiusMm * 0.72,
            y:
              branchSecondBendStart.y +
              branchSecondBendRadiusMm * 0.72,
          },
          {
            x:
              branchSecondBendEnd.x -
              branchSecondBendRadiusMm * 0.72,
            y: branchSecondBendEnd.y,
          },
          branchSecondBendEnd,
          4,
        )
      : [branchSecondBendStart, branchSecondBendEnd];
  const branchGuidePoints = dedupeConsecutivePoints([
    branchCurveStart,
    branchStraightEnd,
    ...firstBendCurvePoints.slice(1),
    branchSecondBendStart,
    ...secondBendCurvePoints.slice(1, -1),
    branchSecondBendEnd,
    { x: rightX, y: branchY },
  ]);
  const bandLengthMm = clamp(config.overallLengthMm * 0.026, 8, 12);
  const bandOuterScale = 1.02;
  const bandCoreScale = 1.06;
  const maxOuterDiameterMm = Math.max(
    inletOuterDiameterMm,
    runOuterDiameterMm,
    branchOuterDiameterMm,
  );
  const maxCoreDiameterMm = Math.max(
    config.inletCoreDiameterMm,
    config.runCoreDiameterMm,
    config.branchCoreDiameterMm,
  );
  const splitNode = {
    center: {
      x: (junctionBodyStartX + junctionBodyEndX) / 2,
      y: trunkCenterY,
    },
    lengthMm: junctionBodyLengthMm,
    outerDiameterMm: junctionBodyOuterDiameterMm,
    coreDiameterMm: junctionBodyCoreDiameterMm,
  };
  const centerlineZMm = maxOuterDiameterMm / 2;
  const junction: RefrigerantBranchKitJunctionSpec = {
    mainSections: [
      {
        start: { x: junctionSleeve1StartX, y: trunkCenterY },
        end: { x: junctionSleeve1EndX, y: trunkCenterY },
        startCoreDiameterMm: junctionSleeve1CoreDiameterMm,
        endCoreDiameterMm: junctionSleeve1CoreDiameterMm,
        startOuterDiameterMm: junctionSleeve1OuterDiameterMm,
        endOuterDiameterMm: junctionSleeve1OuterDiameterMm,
      },
      {
        start: { x: junctionSleeve1EndX, y: trunkCenterY },
        end: { x: junctionSleeve2StartX, y: trunkCenterY },
        startCoreDiameterMm: junctionSleeve1CoreDiameterMm,
        endCoreDiameterMm: junctionSleeve2CoreDiameterMm,
        startOuterDiameterMm: junctionSleeve1OuterDiameterMm,
        endOuterDiameterMm: junctionSleeve2OuterDiameterMm,
      },
      {
        start: { x: junctionSleeve2StartX, y: trunkCenterY },
        end: { x: junctionSleeve2EndX, y: trunkCenterY },
        startCoreDiameterMm: junctionSleeve2CoreDiameterMm,
        endCoreDiameterMm: junctionSleeve2CoreDiameterMm,
        startOuterDiameterMm: junctionSleeve2OuterDiameterMm,
        endOuterDiameterMm: junctionSleeve2OuterDiameterMm,
      },
      {
        start: { x: junctionSleeve2EndX, y: trunkCenterY },
        end: { x: junctionBodyStartX, y: trunkCenterY },
        startCoreDiameterMm: junctionSleeve2CoreDiameterMm,
        endCoreDiameterMm: junctionBodyCoreDiameterMm,
        startOuterDiameterMm: junctionSleeve2OuterDiameterMm,
        endOuterDiameterMm: junctionBodyOuterDiameterMm,
      },
      {
        start: { x: junctionBodyStartX, y: trunkCenterY },
        end: { x: junctionBodyEndX, y: trunkCenterY },
        startCoreDiameterMm: junctionBodyCoreDiameterMm,
        endCoreDiameterMm: junctionBodyCoreDiameterMm,
        startOuterDiameterMm: junctionBodyOuterDiameterMm,
        endOuterDiameterMm: junctionBodyOuterDiameterMm,
      },
    ],
    branchSection: {
      start: branchSectionStart,
      end: branchSectionEnd,
      startCoreDiameterMm: branchSectionStartCoreDiameterMm,
      endCoreDiameterMm: branchSectionEndCoreDiameterMm,
      startOuterDiameterMm: branchSectionStartOuterDiameterMm,
      endOuterDiameterMm: branchSectionEndOuterDiameterMm,
    },
  };

  const bands: RefrigerantBranchKitBandSpec[] = [
    {
      center: {
        x: config.leftX + inletSocketLengthMm * 0.24,
        y: trunkCenterY,
      },
      direction: { x: 1, y: 0 },
      lengthMm: bandLengthMm,
      outerDiameterMm: inletOuterDiameterMm * bandOuterScale,
      coreDiameterMm: config.inletCoreDiameterMm * bandCoreScale,
    },
    {
      center: {
        x: config.leftX + inletSocketLengthMm * 0.52,
        y: trunkCenterY,
      },
      direction: { x: 1, y: 0 },
      lengthMm: bandLengthMm * 0.88,
      outerDiameterMm: inletOuterDiameterMm * bandOuterScale,
      coreDiameterMm: config.inletCoreDiameterMm * bandCoreScale,
    },
    {
      center: {
        x: rightX - runOutletSocketLengthMm * 0.55,
        y: runCenterY,
      },
      direction: { x: 1, y: 0 },
      lengthMm: bandLengthMm,
      outerDiameterMm: runOuterDiameterMm * bandOuterScale,
      coreDiameterMm: config.runCoreDiameterMm * bandCoreScale,
    },
    {
      center: {
        x: rightX - runOutletSocketLengthMm * 0.22,
        y: runCenterY,
      },
      direction: { x: 1, y: 0 },
      lengthMm: bandLengthMm * 0.88,
      outerDiameterMm: runOuterDiameterMm * bandOuterScale,
      coreDiameterMm: config.runCoreDiameterMm * bandCoreScale,
    },
    {
      center: {
        x: rightX - branchOutletSocketLengthMm * 0.55,
        y: branchY,
      },
      direction: { x: 1, y: 0 },
      lengthMm: bandLengthMm,
      outerDiameterMm: branchOuterDiameterMm * bandOuterScale,
      coreDiameterMm: config.branchCoreDiameterMm * bandCoreScale,
    },
    {
      center: {
        x: rightX - branchOutletSocketLengthMm * 0.22,
        y: branchY,
      },
      direction: { x: 1, y: 0 },
      lengthMm: bandLengthMm * 0.88,
      outerDiameterMm: branchOuterDiameterMm * bandOuterScale,
      coreDiameterMm: config.branchCoreDiameterMm * bandCoreScale,
    },
    {
      center: {
        x: junctionBodyEndX - junctionBodyLengthMm * 0.16,
        y: trunkCenterY,
      },
      direction: { x: 1, y: 0 },
      lengthMm: bandLengthMm * 1.18,
      outerDiameterMm: junctionBodyOuterDiameterMm * 1.02,
      coreDiameterMm: junctionBodyCoreDiameterMm,
    },
  ];

  return {
    kind: config.kind,
    overallLengthMm: config.overallLengthMm,
    outletSeparationMm: config.outletSeparationMm,
    centerlineZMm,
    inletTube: {
      points: [
        { x: config.leftX, y: trunkCenterY },
        { x: reducerStartX, y: trunkCenterY },
      ],
      coreDiameterMm: config.inletCoreDiameterMm,
      outerDiameterMm: inletOuterDiameterMm,
    },
    inletRunTube: {
      points: [
        { x: reducerEndX, y: trunkCenterY },
        { x: junctionSleeve1StartX, y: trunkCenterY },
      ],
      coreDiameterMm: config.runCoreDiameterMm,
      outerDiameterMm: runOuterDiameterMm,
    },
    mainTube: {
      points: [
        { x: runOutletStartX, y: runCenterY },
        { x: rightX, y: runCenterY },
      ],
      coreDiameterMm: config.runCoreDiameterMm,
      outerDiameterMm: runOuterDiameterMm,
    },
    branchTube: {
      points: branchGuidePoints,
      coreDiameterMm: config.branchCoreDiameterMm,
      outerDiameterMm: branchOuterDiameterMm,
    },
    inletReducer: {
      start: { x: reducerStartX, y: trunkCenterY },
      end: { x: reducerEndX, y: trunkCenterY },
      startCoreDiameterMm: config.inletCoreDiameterMm,
      endCoreDiameterMm: config.runCoreDiameterMm,
      startOuterDiameterMm: inletOuterDiameterMm,
      endOuterDiameterMm: runOuterDiameterMm,
    },
    manifold,
    junction,
    splitNode,
    inletTerminal: {
      key: `${config.kind}-inlet`,
      kind: config.kind,
      role: "inlet",
      point: { x: config.leftX, y: trunkCenterY },
      direction: { x: -1, y: 0 },
      coreDiameterMm: config.inletCoreDiameterMm,
      outerDiameterMm: inletOuterDiameterMm,
      socketLengthMm: inletSocketLengthMm,
    },
    runOutletTerminal: {
      key: `${config.kind}-run-outlet`,
      kind: config.kind,
      role: "run-outlet",
      point: { x: rightX, y: runCenterY },
      direction: { x: 1, y: 0 },
      coreDiameterMm: config.runCoreDiameterMm,
      outerDiameterMm: runOuterDiameterMm,
      socketLengthMm: runOutletSocketLengthMm,
    },
    branchOutletTerminal: {
      key: `${config.kind}-branch-outlet`,
      kind: config.kind,
      role: "branch-outlet",
      point: { x: rightX, y: branchY },
      direction: { x: 1, y: 0 },
      coreDiameterMm: config.branchCoreDiameterMm,
      outerDiameterMm: branchOuterDiameterMm,
      socketLengthMm: branchOutletSocketLengthMm,
    },
    bands,
  };
}

export function isRefrigerantBranchKitType(
  type: HvacElement["type"],
): boolean {
  return type === "refrigerant-branch-kit";
}

export function isRefrigerantBranchKitElement(
  element: Pick<HvacElement, "type" | "subtype" | "modelLabel" | "properties">,
): boolean {
  if (element.type === "refrigerant-branch-kit") {
    return true;
  }

  const definitionId =
    typeof element.properties.definitionId === "string"
      ? element.properties.definitionId.toLowerCase()
      : "";
  const branchKitType =
    typeof element.properties.branchKitType === "string"
      ? element.properties.branchKitType.toLowerCase()
      : "";
  const subtype = (element.subtype ?? "").toLowerCase();
  const modelLabel = (element.modelLabel ?? "").toLowerCase();

  return (
    definitionId === "ac-branch-kit-dis-22-1g" ||
    branchKitType === "dis-22-1g" ||
    subtype === "dis-22-1g" ||
    modelLabel === "dis-22-1g"
  );
}

export function buildRefrigerantBranchKitModel(
  element: Pick<
    HvacElement,
    "type" | "subtype" | "modelLabel" | "properties"
  >,
): RefrigerantBranchKitModelSpec {
  const subtype = resolveBranchKitSubtype(element);
  const wallAllowanceMm =
    readNumberProperty(element.properties, "branchKitWallAllowanceMm") ??
    DEFAULT_BRANCH_KIT_WALL_ALLOWANCE_MM;

  const gasInletDiameterMm =
    readNumberProperty(element.properties, "gasInletDiameterMm") ?? 19.05;
  const gasRunOutletDiameterMm =
    readNumberProperty(element.properties, "gasRunOutletDiameterMm") ?? 15.88;
  const gasBranchOutletDiameterMm =
    readNumberProperty(element.properties, "gasBranchOutletDiameterMm") ?? 12.7;
  const liquidInletDiameterMm =
    readNumberProperty(element.properties, "liquidInletDiameterMm") ?? 9.52;
  const liquidRunOutletDiameterMm =
    readNumberProperty(element.properties, "liquidRunOutletDiameterMm") ?? 9.52;
  const liquidBranchOutletDiameterMm =
    readNumberProperty(element.properties, "liquidBranchOutletDiameterMm") ??
    6.35;

  const gasMaxOuterDiameterMm = Math.max(
    resolveCopperBodyDiameterMm(gasInletDiameterMm, wallAllowanceMm),
    resolveCopperBodyDiameterMm(
      gasRunOutletDiameterMm,
      wallAllowanceMm,
    ),
    resolveCopperBodyDiameterMm(
      gasBranchOutletDiameterMm,
      wallAllowanceMm,
    ),
  );
  const liquidMaxOuterDiameterMm = Math.max(
    resolveCopperBodyDiameterMm(
      liquidInletDiameterMm,
      wallAllowanceMm,
    ),
    resolveCopperBodyDiameterMm(
      liquidRunOutletDiameterMm,
      wallAllowanceMm,
    ),
    resolveCopperBodyDiameterMm(
      liquidBranchOutletDiameterMm,
      wallAllowanceMm,
    ),
  );
  const stackGapMm = Math.max(
    170,
    gasMaxOuterDiameterMm + liquidMaxOuterDiameterMm + DEFAULT_REFRIGERANT_PIPE_GAP_MM + 10,
  );
  const leftX = -442 / 2;
  const gasCenterY = -stackGapMm / 2;
  const liquidCenterY = stackGapMm / 2;

  const gas = buildBranchLineGeometry({
    kind: "gas",
    leftX,
    centerY: gasCenterY,
    overallLengthMm: 442,
    outletSeparationMm: 94,
    inletCoreDiameterMm: gasInletDiameterMm,
    runCoreDiameterMm: gasRunOutletDiameterMm,
    branchCoreDiameterMm: gasBranchOutletDiameterMm,
    wallAllowanceMm,
  });
  const liquid = buildBranchLineGeometry({
    kind: "liquid",
    leftX,
    centerY: liquidCenterY,
    overallLengthMm: 370,
    outletSeparationMm: 87,
    inletCoreDiameterMm: liquidInletDiameterMm,
    runCoreDiameterMm: liquidRunOutletDiameterMm,
    branchCoreDiameterMm: liquidBranchOutletDiameterMm,
    wallAllowanceMm,
  });

  const boundsPoints: Point2D[] = [];
  const maxOuterRadiusMm =
    Math.max(gasMaxOuterDiameterMm, liquidMaxOuterDiameterMm) / 2;
  [gas, liquid].forEach((line) => {
    line.inletTube.points.forEach((point) => boundsPoints.push(point));
    line.inletRunTube.points.forEach((point) => boundsPoints.push(point));
    line.mainTube.points.forEach((point) => boundsPoints.push(point));
    line.branchTube.points.forEach((point) => boundsPoints.push(point));
    line.manifold.outline.forEach((point) => boundsPoints.push(point));
    boundsPoints.push(
      line.inletTerminal.point,
      line.runOutletTerminal.point,
      line.branchOutletTerminal.point,
      line.splitNode.center,
    );
    line.bands.forEach((band) => boundsPoints.push(band.center));
    if (line.inletReducer) {
      boundsPoints.push(line.inletReducer.start, line.inletReducer.end);
    }
    line.junction.mainSections.forEach((section) =>
      boundsPoints.push(section.start, section.end),
    );
    boundsPoints.push(
      line.junction.branchSection.start,
      line.junction.branchSection.end,
    );
  });

  const bounds = computeBounds(boundsPoints, maxOuterRadiusMm + 8);
  const offset = bounds.center;
  const translateLine = (
    line: RefrigerantBranchKitLineSpec,
  ): RefrigerantBranchKitLineSpec => ({
    ...line,
    inletTube: {
      ...line.inletTube,
      points: translatePoints(line.inletTube.points, offset),
    },
    inletRunTube: {
      ...line.inletRunTube,
      points: translatePoints(line.inletRunTube.points, offset),
    },
    mainTube: {
      ...line.mainTube,
      points: translatePoints(line.mainTube.points, offset),
    },
    branchTube: {
      ...line.branchTube,
      points: translatePoints(line.branchTube.points, offset),
    },
    inletReducer: translateReducer(line.inletReducer, offset),
    manifold: translateManifold(line.manifold, offset),
    junction: translateJunction(line.junction, offset),
    splitNode: {
      ...line.splitNode,
      center: translatePoint(line.splitNode.center, offset),
    },
    inletTerminal: {
      ...line.inletTerminal,
      point: translatePoint(line.inletTerminal.point, offset),
    },
    runOutletTerminal: {
      ...line.runOutletTerminal,
      point: translatePoint(line.runOutletTerminal.point, offset),
    },
    branchOutletTerminal: {
      ...line.branchOutletTerminal,
      point: translatePoint(line.branchOutletTerminal.point, offset),
    },
    bands: line.bands.map((band) => translateBand(band, offset)),
  });

  const translatedGas = translateLine(gas);
  const translatedLiquid = translateLine(liquid);
  const heightMm = Math.max(gasMaxOuterDiameterMm, liquidMaxOuterDiameterMm);

  return {
    subtype,
    bounds: {
      ...bounds,
      minX: bounds.minX - offset.x,
      minY: bounds.minY - offset.y,
      maxX: bounds.maxX - offset.x,
      maxY: bounds.maxY - offset.y,
      center: { x: 0, y: 0 },
    },
    widthMm: bounds.width,
    depthMm: bounds.height,
    heightMm,
    gas: translatedGas,
    liquid: translatedLiquid,
    stackGapMm,
    labelAnchor: {
      x: 0,
      y: bounds.minY - offset.y,
    },
  };
}

export function getRefrigerantBranchKitPlanBounds(
  model: RefrigerantBranchKitModelSpec,
): RefrigerantBranchKitBounds {
  return model.bounds;
}

export function getRefrigerantBranchKitTerminalSpecs(
  model: RefrigerantBranchKitModelSpec,
): RefrigerantBranchKitTerminalSpec[] {
  return [
    model.gas.inletTerminal,
    model.gas.runOutletTerminal,
    model.gas.branchOutletTerminal,
    model.liquid.inletTerminal,
    model.liquid.runOutletTerminal,
    model.liquid.branchOutletTerminal,
  ];
}
