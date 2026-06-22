/**
 * Generic pipe port definitions for all HVAC unit types that have refrigerant connections.
 *
 * Ceiling cassettes use their dedicated model (ceilingCassetteModel.ts) for ports.
 * This module provides port definitions for:
 *   - outdoor-unit
 *   - wall-mounted-ac
 *   - ceiling-suspended-ac
 *   - ducted-ac
 */

import type { HvacElement, Point2D } from "../../../types";

import { buildDuctedIndoorUnitModel } from "./ductedIndoorUnitModel";
import {
  computeIndoorRefrigerantPortStubLengthMm,
  DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
  DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
} from "./refrigerantPipeDimensions";

export interface UnitPipePort {
  kind: "gas" | "liquid";
  /** Local X offset from element center (positive = right / towards port side) */
  localX: number;
  /** Local Y offset from element center */
  localY: number;
  /** Z elevation relative to element base */
  localZ: number;
  /** Visual radius of the port stub (mm) */
  radius: number;
  /** Visual length of the port stub (mm) */
  length: number;
  /** Optional shared collar radius for exact 2D/3D alignment */
  collarRadius?: number;
  /** Optional shared collar length for exact 2D/3D alignment */
  collarLength?: number;
  /** Optional shared flange thickness for exact 2D/3D alignment */
  flangeThickness?: number;
  /** Core pipe color */
  color: string;
}

export interface UnitPipePortSpec {
  /** Direction of port outflow in LOCAL coordinates (pre-rotation) */
  localDirection: Point2D;
  gasPipeDiameterMm: number;
  liquidPipeDiameterMm: number;
  ports: UnitPipePort[];
}

export interface UnitPipePortRenderMetrics {
  collarRadius: number;
  collarLength: number;
  flangeThickness: number;
  flangeStartX: number;
  flangeEndX: number;
  collarStartX: number;
  collarEndX: number;
  pipeStartX: number;
  pipeEndX: number;
}

export function getUnitPipePortRenderMetrics(
  port: UnitPipePort,
): UnitPipePortRenderMetrics {
  const collarLength = port.collarLength ?? Math.max(10, port.length * 0.28);
  const flangeThickness =
    port.flangeThickness ?? Math.max(4, collarLength * 0.24);
  const collarRadius = port.collarRadius ?? port.radius * 1.24;
  const flangeStartX = port.localX;
  const flangeEndX = port.localX + flangeThickness;
  const collarStartX = port.localX + flangeThickness * 0.35;
  const collarEndX = collarStartX + collarLength;
  const pipeStartX = port.localX + collarLength - flangeThickness * 0.15;
  const pipeEndX = pipeStartX + port.length;

  return {
    collarRadius,
    collarLength,
    flangeThickness,
    flangeStartX,
    flangeEndX,
    collarStartX,
    collarEndX,
    pipeStartX,
    pipeEndX,
  };
}

export function getUnitPipePortEndpointLocal(port: UnitPipePort): Point2D {
  const metrics = getUnitPipePortRenderMetrics(port);
  return {
    x: metrics.pipeEndX,
    y: port.localY,
  };
}

export function getUnitPipePortConnectionLocal(port: UnitPipePort): Point2D {
  const metrics = getUnitPipePortRenderMetrics(port);
  return {
    x: metrics.pipeStartX,
    y: port.localY,
  };
}

type UnitElement = Pick<
  HvacElement,
  "type" | "width" | "depth" | "height" | "properties"
> & { elevation?: number };

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readProperty(
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

/**
 * Returns pipe port specs for a given unit element, or null if the element type
 * does not have pipe ports (e.g. controls, filters, accessories).
 *
 * Note: ceiling-cassette-ac is handled separately via buildCeilingCassetteModel.
 */
export function getUnitPipePortSpec(
  element: UnitElement,
): UnitPipePortSpec | null {
  const props = (element.properties ?? {}) as Record<string, unknown>;
  const gasDiameter =
    readProperty(props, "refrigerantGasPipeDiameterMm") ??
    DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM;
  const liquidDiameter =
    readProperty(props, "refrigerantLiquidPipeDiameterMm") ??
    DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM;
  const portRadius = DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM / 2;
  // Fixed center-to-center spacing with compact service stub lengths sized from the pipe.
  const PIPE_PORT_CENTER_SPACING_MM = 42;
  const indoorGasPortLength = computeIndoorRefrigerantPortStubLengthMm(
    gasDiameter,
  );
  const indoorLiquidPortLength = computeIndoorRefrigerantPortStubLengthMm(
    liquidDiameter,
  );
  const outdoorPortLength = 68;
  const gasOffsetY = -PIPE_PORT_CENTER_SPACING_MM / 2;
  const liquidOffsetY = PIPE_PORT_CENTER_SPACING_MM / 2;

  switch (element.type) {
    case "outdoor-unit": {
      // Ports exit from the right side (+x local) near the top
      const portX = element.width * 0.4;
      const heightMm = readNumber(element.height, 1380);
      return {
        localDirection: { x: 1, y: 0 },
        gasPipeDiameterMm: gasDiameter,
        liquidPipeDiameterMm: liquidDiameter,
        ports: [
          {
            kind: "gas",
            localX: portX,
            localY: gasOffsetY,
            localZ: heightMm * 0.85,
            radius: portRadius,
            length: outdoorPortLength,
            color: "#c5894d",
          },
          {
            kind: "liquid",
            localX: portX,
            localY: liquidOffsetY,
            localZ: heightMm * 0.78,
            radius: Math.max(3, liquidDiameter / 2),
            length: outdoorPortLength,
            color: "#dca25d",
          },
        ],
      };
    }

    case "wall-mounted-ac":
    case "split-ac": {
      // Ports exit from the back/bottom of the unit (+x = away from wall)
      const portX = element.width * 0.38;
      const heightMm = readNumber(element.height, 320);
      return {
        localDirection: { x: 1, y: 0 },
        gasPipeDiameterMm: gasDiameter,
        liquidPipeDiameterMm: liquidDiameter,
        ports: [
          {
            kind: "gas",
            localX: portX,
            localY: gasOffsetY,
            localZ: heightMm * 0.3,
            radius: portRadius,
            length: indoorGasPortLength,
            color: "#c5894d",
          },
          {
            kind: "liquid",
            localX: portX,
            localY: liquidOffsetY,
            localZ: heightMm * 0.22,
            radius: Math.max(3, liquidDiameter / 2),
            length: indoorLiquidPortLength,
            color: "#dca25d",
          },
        ],
      };
    }

    case "ceiling-suspended-ac": {
      // Ports exit from the right side
      const portX = element.width * 0.4;
      const heightMm = readNumber(element.height, 235);
      return {
        localDirection: { x: 1, y: 0 },
        gasPipeDiameterMm: gasDiameter,
        liquidPipeDiameterMm: liquidDiameter,
        ports: [
          {
            kind: "gas",
            localX: portX,
            localY: gasOffsetY,
            localZ: heightMm * 0.75,
            radius: portRadius,
            length: indoorGasPortLength,
            color: "#c5894d",
          },
          {
            kind: "liquid",
            localX: portX,
            localY: liquidOffsetY,
            localZ: heightMm * 0.65,
            radius: Math.max(3, liquidDiameter / 2),
            length: indoorLiquidPortLength,
            color: "#dca25d",
          },
        ],
      };
    }

    case "ducted-ac": {
      const ducted = buildDuctedIndoorUnitModel(element);
      const gasPort = ducted.pipePorts.find((port) => port.kind === "gas");
      const liquidPort = ducted.pipePorts.find(
        (port) => port.kind === "liquid",
      );
      if (!gasPort || !liquidPort) {
        return null;
      }
      return {
        localDirection: { x: 1, y: 0 },
        gasPipeDiameterMm: ducted.gasPipeDiameterMm,
        liquidPipeDiameterMm: ducted.liquidPipeDiameterMm,
        ports: [
          {
            kind: "gas",
            localX: gasPort.x,
            localY: gasPort.y,
            localZ: gasPort.z,
            radius: gasPort.radius,
            length: gasPort.length,
            collarRadius: gasPort.collarRadius,
            collarLength: gasPort.collarLength,
            flangeThickness: gasPort.flangeThickness,
            color: gasPort.color,
          },
          {
            kind: "liquid",
            localX: liquidPort.x,
            localY: liquidPort.y,
            localZ: liquidPort.z,
            radius: liquidPort.radius,
            length: liquidPort.length,
            collarRadius: liquidPort.collarRadius,
            collarLength: liquidPort.collarLength,
            flangeThickness: liquidPort.flangeThickness,
            color: liquidPort.color,
          },
        ],
      };
    }

    default:
      return null;
  }
}

/** Types that have generic pipe ports (not ceiling-cassette-ac which uses its own model). */
export const GENERIC_PIPE_PORT_TYPES: ReadonlySet<string> = new Set([
  "outdoor-unit",
  "wall-mounted-ac",
  "split-ac",
  "ceiling-suspended-ac",
  "ducted-ac",
]);

/** All unit types that can have refrigerant pipe connections. */
export const ALL_PIPE_PORT_TYPES: ReadonlySet<string> = new Set([
  "ceiling-cassette-ac",
  "outdoor-unit",
  "wall-mounted-ac",
  "split-ac",
  "ceiling-suspended-ac",
  "ducted-ac",
]);
