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
import {
  DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM,
  DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_PIPE_GAP_MM,
} from "./refrigerantPipeDimensions";
import { buildDuctedIndoorUnitModel } from "./ductedIndoorUnitModel";

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
  const outerDiameter = DEFAULT_REFRIGERANT_DRAWN_OUTER_DIAMETER_MM;
  const portRadius = outerDiameter / 2;
  const centerSpacing = portRadius * 2 + DEFAULT_REFRIGERANT_PIPE_GAP_MM;
  const gasOffsetY = -centerSpacing / 2;
  const liquidOffsetY = centerSpacing / 2;

  switch (element.type) {
    case "outdoor-unit": {
      // Ports exit from the right side (+x local) near the top
      const portX = element.width * 0.4;
      const portLength = Math.max(30, element.width * 0.1);
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
            length: portLength,
            color: "#c5894d",
          },
          {
            kind: "liquid",
            localX: portX,
            localY: liquidOffsetY,
            localZ: heightMm * 0.78,
            radius: Math.max(3, liquidDiameter / 2),
            length: portLength,
            color: "#dca25d",
          },
        ],
      };
    }

    case "wall-mounted-ac": {
      // Ports exit from the back/bottom of the unit (+x = away from wall)
      const portX = element.width * 0.38;
      const portLength = Math.max(24, element.width * 0.08);
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
            length: portLength,
            color: "#c5894d",
          },
          {
            kind: "liquid",
            localX: portX,
            localY: liquidOffsetY,
            localZ: heightMm * 0.22,
            radius: Math.max(3, liquidDiameter / 2),
            length: portLength,
            color: "#dca25d",
          },
        ],
      };
    }

    case "ceiling-suspended-ac": {
      // Ports exit from the right side
      const portX = element.width * 0.4;
      const portLength = Math.max(30, element.width * 0.08);
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
            length: portLength,
            color: "#c5894d",
          },
          {
            kind: "liquid",
            localX: portX,
            localY: liquidOffsetY,
            localZ: heightMm * 0.65,
            radius: Math.max(3, liquidDiameter / 2),
            length: portLength,
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
            color: gasPort.color,
          },
          {
            kind: "liquid",
            localX: liquidPort.x,
            localY: liquidPort.y,
            localZ: liquidPort.z,
            radius: liquidPort.radius,
            length: liquidPort.length,
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
  "ceiling-suspended-ac",
  "ducted-ac",
]);

/** All unit types that can have refrigerant pipe connections. */
export const ALL_PIPE_PORT_TYPES: ReadonlySet<string> = new Set([
  "ceiling-cassette-ac",
  "outdoor-unit",
  "wall-mounted-ac",
  "ceiling-suspended-ac",
  "ducted-ac",
]);
