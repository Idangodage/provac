import type { HvacElement } from "../../../types";
import {
  DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
  DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_PIPE_GAP_MM,
} from "./refrigerantPipeDimensions";

export interface DuctedIndoorUnitBoxSpec {
  x: number;
  y: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  cornerRadius: number;
}

export interface DuctedIndoorUnitLineSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DuctedIndoorUnitInlineOpeningSpec {
  kind: "return" | "supply";
  x: number;
  faceY: number;
  z: number;
  openingWidth: number;
  openingHeight: number;
  collarProjection: number;
  collarThickness: number;
  collarFastenerRadius: number;
  frameDepth: number;
  frameThickness: number;
  cavityDepth: number;
  coilWidth: number;
  coilHeight: number;
  coilDepth: number;
  coilOffset: number;
  coilFinCount: number;
  cornerRadius: number;
  cavityDirection: 1 | -1;
  slatCount: number;
  slatTiltDeg: number;
  slatThickness: number;
}

export interface DuctedIndoorUnitPipePortSpec {
  kind: "gas" | "liquid" | "drain";
  x: number;
  y: number;
  z: number;
  radius: number;
  length: number;
  bootLength: number;
  collarRadius: number;
  collarLength: number;
  flangeThickness: number;
  bandRadius: number;
  color: string;
  collarColor?: string;
  flangeColor?: string;
  bandColor: string;
  bandOffsetX: number;
}

export interface DuctedIndoorUnitModelSpec {
  baseWidth: number;
  baseDepth: number;
  unitHeight: number;
  gasPipeDiameterMm: number;
  liquidPipeDiameterMm: number;
  drainPipeDiameterMm: number;
  staticPressureFactor: number;
  casingInset: DuctedIndoorUnitBoxSpec;
  returnSection: DuctedIndoorUnitBoxSpec;
  fanSection: DuctedIndoorUnitBoxSpec;
  dischargeSection: DuctedIndoorUnitBoxSpec;
  dischargeOpening: DuctedIndoorUnitBoxSpec;
  serviceBox: DuctedIndoorUnitBoxSpec;
  electricalCover: DuctedIndoorUnitBoxSpec;
  hangerBrackets: DuctedIndoorUnitBoxSpec[];
  filterRails: DuctedIndoorUnitLineSpec[];
  fanRibs: DuctedIndoorUnitLineSpec[];
  sectionDividers: DuctedIndoorUnitLineSpec[];
  airOpenings: DuctedIndoorUnitInlineOpeningSpec[];
  pipePorts: DuctedIndoorUnitPipePortSpec[];
}

export const DUCTED_INDOOR_UNIT_COLOR_PALETTE = {
  shell: "#42464b",
  shellOutline: "#676d74",
  casingInset: "#595e64",
  insetOutline: "#7d838a",
  returnSection: "#4a4f54",
  fanSection: "#5a6066",
  dischargeSection: "#6b7178",
  dischargeFace: "#9ca2a8",
  serviceBox: "#8f959b",
  electricalCover: "#d6dbe0",
  bracket: "#252a2f",
  sectionLine: "#8a9097",
  sectionLineSecondary: "#a0a6ad",
  openingCollar: "#b2b7bd",
  openingCollarShadow: "#7f8790",
  openingFastener: "#20252b",
  openingFrame: "#90969d",
  openingMouthReturn: "#6c737b",
  openingMouthSupply: "#bcc2c8",
  openingCavityReturn: "#171b20",
  openingCavitySupply: "#1d2228",
  openingBack: "#0f1215",
  openingCoilCore: "#6f7b86",
  openingCoilFin: "#bcc5cd",
  openingSlatReturn: "#7e858d",
  openingSlatSupply: "#b3b8bd",
  highlight: "#d9dee2",
  serviceHighlight: "#f3f6f8",
} as const;

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readFlexibleNumberProperty(
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

function buildPipePortSpec(
  port: Omit<
    DuctedIndoorUnitPipePortSpec,
    "bootLength" | "collarRadius" | "collarLength" | "flangeThickness"
  >,
): DuctedIndoorUnitPipePortSpec {
  const bootLength = Math.max(10, port.length * 0.2);
  const collarRadius = port.radius * 1.22;
  const collarLength = bootLength;
  const flangeThickness = Math.max(4, collarLength * 0.26);
  return {
    ...port,
    bootLength,
    collarRadius,
    collarLength,
    flangeThickness,
  };
}

export function buildDuctedIndoorUnitModel(
  element: Pick<HvacElement, "width" | "depth" | "height" | "properties">,
): DuctedIndoorUnitModelSpec {
  const gasPipeDiameterMm =
    readFlexibleNumberProperty(
      element.properties,
      "refrigerantGasPipeDiameterMm",
    ) ??
    readFlexibleNumberProperty(
      element.properties,
      "Refrigerant Gas Pipe Diameter (mm)",
    ) ??
    DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM;
  const liquidPipeDiameterMm =
    readFlexibleNumberProperty(
      element.properties,
      "refrigerantLiquidPipeDiameterMm",
    ) ??
    readFlexibleNumberProperty(
      element.properties,
      "Refrigerant Liquid Pipe Diameter (mm)",
    ) ??
    DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM;
  const drainPipeDiameterMm =
    readFlexibleNumberProperty(element.properties, "drainPipeDiameter1Mm") ??
    readFlexibleNumberProperty(
      element.properties,
      "Drain Pipe Diameter 1 (mm)",
    ) ??
    32;
  const staticPressurePa =
    readFlexibleNumberProperty(element.properties, "staticPressurePa") ??
    readFlexibleNumberProperty(element.properties, "espPa") ??
    readFlexibleNumberProperty(
      element.properties,
      "External Static Pressure (Pa)",
    ) ??
    50;

  const baseWidth = element.width;
  const baseDepth = element.depth;
  const unitHeight = Math.max(160, element.height);
  const minBaseDimension = Math.min(baseWidth, baseDepth);
  const staticPressureFactor = clampValue(staticPressurePa / 50, 0.8, 1.8);

  const casingInset: DuctedIndoorUnitBoxSpec = {
    x: 0,
    y: 0,
    z: unitHeight * 0.48,
    width: baseWidth * 0.9,
    depth: baseDepth * 0.8,
    height: unitHeight * 0.86,
    cornerRadius: minBaseDimension * 0.028,
  };

  const returnSection: DuctedIndoorUnitBoxSpec = {
    x: -baseWidth * 0.235,
    y: 0,
    z: unitHeight * 0.4,
    width: baseWidth * 0.22,
    depth: casingInset.depth * 0.78,
    height: unitHeight * 0.7,
    cornerRadius: minBaseDimension * 0.018,
  };

  const fanSection: DuctedIndoorUnitBoxSpec = {
    x: -baseWidth * 0.01,
    y: 0,
    z: unitHeight * 0.42,
    width: baseWidth * 0.29,
    depth: casingInset.depth * 0.78,
    height: unitHeight * 0.72,
    cornerRadius: minBaseDimension * 0.018,
  };

  const dischargeSection: DuctedIndoorUnitBoxSpec = {
    x: baseWidth * 0.235,
    y: 0,
    z: unitHeight * 0.42,
    width: baseWidth * (0.18 + (staticPressureFactor - 1) * 0.018),
    depth: casingInset.depth * 0.72,
    height: unitHeight * 0.68,
    cornerRadius: minBaseDimension * 0.02,
  };

  const dischargeOpening: DuctedIndoorUnitBoxSpec = {
    x: dischargeSection.x + dischargeSection.width * 0.12,
    y: 0,
    z: unitHeight * 0.44,
    width: dischargeSection.width * 0.74,
    depth: dischargeSection.depth * 0.24,
    height: unitHeight * 0.26,
    cornerRadius: minBaseDimension * 0.012,
  };

  const serviceBox: DuctedIndoorUnitBoxSpec = {
    x: baseWidth * 0.2,
    y: -casingInset.depth * 0.28,
    z: unitHeight * 0.56,
    width: baseWidth * 0.18,
    depth: baseDepth * 0.14,
    height: unitHeight * 0.32,
    cornerRadius: minBaseDimension * 0.016,
  };

  const electricalCover: DuctedIndoorUnitBoxSpec = {
    x: serviceBox.x - serviceBox.width * 0.18,
    y: serviceBox.y + serviceBox.depth * 0.82,
    z: unitHeight * 0.54,
    width: serviceBox.width * 0.56,
    depth: serviceBox.depth * 0.38,
    height: unitHeight * 0.18,
    cornerRadius: minBaseDimension * 0.012,
  };

  const bracketWidth = Math.max(18, baseWidth * 0.05);
  const bracketDepth = Math.max(18, baseDepth * 0.05);
  const bracketOffsetX = casingInset.width * 0.42;
  const bracketOffsetY = casingInset.depth * 0.42;
  const hangerBrackets: DuctedIndoorUnitBoxSpec[] = [
    {
      x: -bracketOffsetX,
      y: -bracketOffsetY,
      z: unitHeight * 0.52,
      width: bracketWidth,
      depth: bracketDepth,
      height: 18,
      cornerRadius: 2,
    },
    {
      x: bracketOffsetX,
      y: -bracketOffsetY,
      z: unitHeight * 0.52,
      width: bracketWidth,
      depth: bracketDepth,
      height: 18,
      cornerRadius: 2,
    },
    {
      x: -bracketOffsetX,
      y: bracketOffsetY,
      z: unitHeight * 0.52,
      width: bracketWidth,
      depth: bracketDepth,
      height: 18,
      cornerRadius: 2,
    },
    {
      x: bracketOffsetX,
      y: bracketOffsetY,
      z: unitHeight * 0.52,
      width: bracketWidth,
      depth: bracketDepth,
      height: 18,
      cornerRadius: 2,
    },
  ];

  const filterRails: DuctedIndoorUnitLineSpec[] = [];
  const filterRailCount = 4;
  const filterRailLeft = returnSection.x - returnSection.width * 0.25;
  const filterRailStep =
    (returnSection.width * 0.5) / Math.max(1, filterRailCount - 1);
  for (let index = 0; index < filterRailCount; index += 1) {
    const x = filterRailLeft + filterRailStep * index;
    filterRails.push({
      x1: x,
      y1: -returnSection.depth * 0.34,
      x2: x,
      y2: returnSection.depth * 0.34,
    });
  }

  const fanRibs: DuctedIndoorUnitLineSpec[] = [];
  const fanRibCount = clampValue(
    Math.round(3 + (staticPressureFactor - 0.8) * 2),
    3,
    5,
  );
  const fanRibTop = -fanSection.depth * 0.28;
  const fanRibStep = (fanSection.depth * 0.56) / Math.max(1, fanRibCount - 1);
  for (let index = 0; index < fanRibCount; index += 1) {
    const y = fanRibTop + fanRibStep * index;
    fanRibs.push({
      x1: fanSection.x - fanSection.width * 0.34,
      y1: y,
      x2: fanSection.x + fanSection.width * 0.34,
      y2: y,
    });
  }

  const sectionDividers: DuctedIndoorUnitLineSpec[] = [
    {
      x1: returnSection.x + returnSection.width / 2 + baseWidth * 0.04,
      y1: -casingInset.depth * 0.36,
      x2: returnSection.x + returnSection.width / 2 + baseWidth * 0.04,
      y2: casingInset.depth * 0.36,
    },
    {
      x1: fanSection.x + fanSection.width / 2 + baseWidth * 0.035,
      y1: -casingInset.depth * 0.34,
      x2: fanSection.x + fanSection.width / 2 + baseWidth * 0.035,
      y2: casingInset.depth * 0.34,
    },
  ];

  const inlineOpeningWidth = Math.min(
    casingInset.width * 0.84,
    baseWidth * 0.76,
  );
  const inlineOpeningHeight = Math.min(unitHeight * 0.46, unitHeight - 40);
  const inlineOpeningX = casingInset.x - serviceBox.width * 0.08;
  const inlineOpeningFrameDepth = Math.max(10, baseDepth * 0.022);
  const inlineOpeningFrameThickness = Math.max(14, unitHeight * 0.055);
  const inlineOpeningCavityDepth = Math.max(36, baseDepth * 0.065);
  const inlineOpeningCornerRadius = Math.max(4, inlineOpeningHeight * 0.08);
  const inlineOpeningZ = unitHeight * 0.5;
  const inlineOpeningCollarProjection = 20;
  const inlineOpeningCollarThickness = 1;
  const inlineOpeningCollarFastenerRadius = 0;
  const inlineOpeningCoilWidth = inlineOpeningWidth * 0.82;
  const inlineOpeningCoilHeight = inlineOpeningHeight * 0.62;
  const inlineOpeningCoilDepth = Math.max(8, inlineOpeningCavityDepth * 0.24);
  const inlineOpeningCoilOffset = Math.max(
    inlineOpeningFrameDepth * 0.9,
    inlineOpeningCavityDepth * 0.28,
  );
  const inlineOpeningSlatThickness = Math.max(
    6,
    inlineOpeningFrameThickness * 0.48,
  );

  const airOpenings: DuctedIndoorUnitInlineOpeningSpec[] = [
    {
      kind: "return",
      x: inlineOpeningX,
      faceY: -casingInset.depth / 2,
      z: inlineOpeningZ,
      openingWidth: inlineOpeningWidth,
      openingHeight: inlineOpeningHeight,
      collarProjection: inlineOpeningCollarProjection,
      collarThickness: inlineOpeningCollarThickness,
      collarFastenerRadius: inlineOpeningCollarFastenerRadius,
      frameDepth: inlineOpeningFrameDepth,
      frameThickness: inlineOpeningFrameThickness,
      cavityDepth: inlineOpeningCavityDepth,
      coilWidth: inlineOpeningCoilWidth,
      coilHeight: inlineOpeningCoilHeight,
      coilDepth: inlineOpeningCoilDepth,
      coilOffset: inlineOpeningCoilOffset,
      coilFinCount: 9,
      cornerRadius: inlineOpeningCornerRadius,
      cavityDirection: 1,
      slatCount: 6,
      slatTiltDeg: -20,
      slatThickness: inlineOpeningSlatThickness,
    },
    {
      kind: "supply",
      x: inlineOpeningX,
      faceY: casingInset.depth / 2,
      z: inlineOpeningZ,
      openingWidth: inlineOpeningWidth,
      openingHeight: inlineOpeningHeight,
      collarProjection: inlineOpeningCollarProjection,
      collarThickness: inlineOpeningCollarThickness,
      collarFastenerRadius: inlineOpeningCollarFastenerRadius,
      frameDepth: inlineOpeningFrameDepth,
      frameThickness: inlineOpeningFrameThickness,
      cavityDepth: inlineOpeningCavityDepth,
      coilWidth: inlineOpeningCoilWidth,
      coilHeight: inlineOpeningCoilHeight,
      coilDepth: inlineOpeningCoilDepth,
      coilOffset: inlineOpeningCoilOffset,
      coilFinCount: 8,
      cornerRadius: inlineOpeningCornerRadius,
      cavityDirection: -1,
      slatCount: 4,
      slatTiltDeg: 14,
      slatThickness: inlineOpeningSlatThickness,
    },
  ];

  const refrigerantPortRadius = Math.max(
    DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM / 2,
    gasPipeDiameterMm / 2,
    liquidPipeDiameterMm / 2,
  );
  const refrigerantPortCenterSpacing =
    refrigerantPortRadius * 2 + DEFAULT_REFRIGERANT_PIPE_GAP_MM;
  const refrigerantBundleCenterY = -baseDepth * 0.18;
  const gasPortY = refrigerantBundleCenterY - refrigerantPortCenterSpacing / 2;
  const liquidPortY =
    refrigerantBundleCenterY + refrigerantPortCenterSpacing / 2;
  const gasPortRadius = Math.max(4.5, gasPipeDiameterMm / 2);
  const liquidPortRadius = Math.max(3, liquidPipeDiameterMm / 2);
  const drainPortRadius = Math.max(7, drainPipeDiameterMm / 2);
  const casingFaceX = casingInset.x + casingInset.width / 2;
  const gasPortLength = Math.max(78, baseWidth * 0.165);
  const liquidPortLength = Math.max(64, baseWidth * 0.14);
  const drainPortLength = Math.max(92, baseWidth * 0.19);

  const pipePorts: DuctedIndoorUnitPipePortSpec[] = [
    buildPipePortSpec({
      kind: "gas",
      x: casingFaceX,
      y: gasPortY,
      z: unitHeight * 0.78,
      radius: gasPortRadius,
      length: gasPortLength,
      bandRadius: Math.max(4, gasPortRadius + 1.4),
      color: "#c88f53",
      collarColor: "#252b33",
      flangeColor: "#252b33",
      bandColor: "#c88f53",
      bandOffsetX: gasPortLength * 0.54,
    }),
    buildPipePortSpec({
      kind: "liquid",
      x: casingFaceX,
      y: liquidPortY,
      z: unitHeight * 0.7,
      radius: liquidPortRadius,
      length: liquidPortLength,
      bandRadius: Math.max(3.5, liquidPortRadius + 1.2),
      color: "#d9a25c",
      collarColor: "#252b33",
      flangeColor: "#252b33",
      bandColor: "#e4b36b",
      bandOffsetX: liquidPortLength * 0.48,
    }),
    buildPipePortSpec({
      kind: "drain",
      x: casingFaceX,
      y: baseDepth * 0.23,
      z: unitHeight * 0.54,
      radius: drainPortRadius,
      length: drainPortLength,
      bandRadius: Math.max(6, drainPortRadius + 1.8),
      color: "#79bddf",
      collarColor: "#58636f",
      flangeColor: "#58636f",
      bandColor: "#79bddf",
      bandOffsetX: drainPortLength * 0.52,
    }),
  ];

  return {
    baseWidth,
    baseDepth,
    unitHeight,
    gasPipeDiameterMm,
    liquidPipeDiameterMm,
    drainPipeDiameterMm,
    staticPressureFactor,
    casingInset,
    returnSection,
    fanSection,
    dischargeSection,
    dischargeOpening,
    serviceBox,
    electricalCover,
    hangerBrackets,
    filterRails,
    fanRibs,
    sectionDividers,
    airOpenings,
    pipePorts,
  };
}
