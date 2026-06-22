"use client";

import type { HvacElement, HvacElementCategory, Point2D } from "../../../../types";
import { isRefrigerantBranchKitElement } from "../refrigerantBranchKitModel";

import { isProjectionCoreHvacType } from "./buildHvacElementMesh";

export type Hvac3DProjectionCategory =
  | "equipment"
  | "accessory"
  | "control"
  | "air-terminal"
  | "route";

export interface Hvac3DProjectionAttributes {
  elementId: string;
  sourceType: HvacElement["type"];
  renderType: HvacElement["type"];
  category: Hvac3DProjectionCategory;
  positionMm: Point2D;
  footprintCenterMm: Point2D;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  baseElevationMm: number;
  topElevationMm: number;
  rotationDeg: number;
  mountType: HvacElement["mountType"];
  sceneBlend: number;
  renderOpacity: number;
  isGenerated: true;
  source: "hvac-axis-projection";
}

export type HvacElementWithProjection3D = HvacElement & {
  projection3D: Hvac3DProjectionAttributes;
};

export interface HvacProjectionElement3D {
  sourceElement: HvacElement;
  element: HvacElementWithProjection3D;
  attributes: Hvac3DProjectionAttributes;
}

type DimensionFallback = {
  width: number;
  depth: number;
  height: number;
  minWidth: number;
  minDepth: number;
  minHeight: number;
};

const DEFAULT_FALLBACK: DimensionFallback = {
  width: 260,
  depth: 220,
  height: 120,
  minWidth: 60,
  minDepth: 60,
  minHeight: 40,
};

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveDimension(
  value: number,
  fallback: number,
  minimum: number,
): number {
  const resolved = finiteOr(value, fallback);
  return Math.max(minimum, resolved > 0 ? resolved : fallback);
}

function positiveVisualHeight(
  value: number,
  fallback: number,
  minimum: number,
): number {
  const resolved = finiteOr(value, fallback);
  if (resolved <= minimum) {
    return Math.max(minimum, fallback);
  }
  return Math.max(minimum, resolved);
}

function resolveRenderType(element: HvacElement): HvacElement["type"] {
  if (element.type === "accessory" && isRefrigerantBranchKitElement(element)) {
    return "refrigerant-branch-kit";
  }
  return element.type;
}

function resolveProjectionCategory(
  element: HvacElement,
  renderType: HvacElement["type"],
): Hvac3DProjectionCategory {
  const category = element.category;

  if (
    category === "indoor-unit" ||
    category === "outdoor-unit" ||
    renderType === "ducted-ac" ||
    renderType === "ceiling-cassette-ac" ||
    renderType === "ceiling-suspended-ac" ||
    renderType === "wall-mounted-ac" ||
    renderType === "split-ac" ||
    renderType === "outdoor-unit"
  ) {
    return "equipment";
  }

  if (
    category === "control" ||
    renderType === "remote-controller" ||
    renderType === "control-panel"
  ) {
    return "control";
  }

  if (
    category === "air-terminal" ||
    renderType === "diffuser" ||
    renderType === "return-grille"
  ) {
    return "air-terminal";
  }

  if (
    category === "accessory" ||
    renderType === "filter" ||
    renderType === "accessory" ||
    renderType === "refrigerant-branch-kit"
  ) {
    return "accessory";
  }

  return "route";
}

function resolveDimensionFallback(
  renderType: HvacElement["type"],
  category?: HvacElementCategory,
): DimensionFallback {
  switch (renderType) {
    case "outdoor-unit":
      return {
        width: 900,
        depth: 360,
        height: 720,
        minWidth: 220,
        minDepth: 140,
        minHeight: 120,
      };
    case "ducted-ac":
      return {
        width: 900,
        depth: 520,
        height: 260,
        minWidth: 240,
        minDepth: 160,
        minHeight: 120,
      };
    case "ceiling-cassette-ac":
      return {
        width: 600,
        depth: 600,
        height: 220,
        minWidth: 220,
        minDepth: 220,
        minHeight: 80,
      };
    case "ceiling-suspended-ac":
    case "wall-mounted-ac":
    case "split-ac":
      return {
        width: 780,
        depth: 240,
        height: 220,
        minWidth: 220,
        minDepth: 90,
        minHeight: 80,
      };
    case "duct":
      return {
        width: 420,
        depth: 220,
        height: 180,
        minWidth: 80,
        minDepth: 40,
        minHeight: 40,
      };
    case "refrigerant-pipe":
    case "refrigerant-pipe-pair":
      return {
        width: 200,
        depth: 40,
        height: 30,
        minWidth: 10,
        minDepth: 10,
        minHeight: 10,
      };
    case "refrigerant-branch-kit":
      return {
        width: 180,
        depth: 100,
        height: 80,
        minWidth: 60,
        minDepth: 40,
        minHeight: 35,
      };
    case "filter":
      return {
        width: 420,
        depth: 220,
        height: 60,
        minWidth: 140,
        minDepth: 80,
        minHeight: 35,
      };
    case "diffuser":
    case "return-grille":
      return {
        width: 300,
        depth: 300,
        height: 45,
        minWidth: 120,
        minDepth: 120,
        minHeight: 24,
      };
    case "remote-controller":
    case "control-panel":
      return {
        width: 90,
        depth: 24,
        height: 140,
        minWidth: 60,
        minDepth: 14,
        minHeight: 40,
      };
    case "accessory":
      return {
        width: 220,
        depth: 160,
        height: 90,
        minWidth: 70,
        minDepth: 50,
        minHeight: 40,
      };
    default:
      return category === "air-terminal"
        ? {
            width: 300,
            depth: 300,
            height: 45,
            minWidth: 120,
            minDepth: 120,
            minHeight: 24,
          }
        : DEFAULT_FALLBACK;
  }
}

function resolveBaseElevationMm(
  element: HvacElement,
  renderType: HvacElement["type"],
): number {
  const rawElevation = finiteOr(element.elevation, 0);
  if (renderType === "outdoor-unit" && rawElevation <= 0) {
    return 0;
  }
  return Math.max(0, rawElevation);
}

export function deriveHvac3DProjectionAttributes(
  element: HvacElement,
  blend: number,
): Hvac3DProjectionAttributes | null {
  const renderType = resolveRenderType(element);
  if (!isProjectionCoreHvacType(renderType)) {
    return null;
  }

  const fallback = resolveDimensionFallback(renderType, element.category);
  const widthMm = positiveDimension(element.width, fallback.width, fallback.minWidth);
  const depthMm = positiveDimension(element.depth, fallback.depth, fallback.minDepth);
  const heightMm = positiveVisualHeight(
    element.height,
    fallback.height,
    fallback.minHeight,
  );
  const positionMm = {
    x: finiteOr(element.position.x, 0),
    y: finiteOr(element.position.y, 0),
  };
  const baseElevationMm = resolveBaseElevationMm(element, renderType);
  const sceneBlend = clampUnit(blend);

  return {
    elementId: element.id,
    sourceType: element.type,
    renderType,
    category: resolveProjectionCategory(element, renderType),
    positionMm,
    footprintCenterMm: {
      x: positionMm.x + widthMm / 2,
      y: positionMm.y + depthMm / 2,
    },
    widthMm,
    depthMm,
    heightMm,
    baseElevationMm,
    topElevationMm: baseElevationMm + heightMm,
    rotationDeg: finiteOr(element.rotation, 0),
    mountType: element.mountType,
    sceneBlend,
    renderOpacity: sceneBlend <= 0 ? 0 : Math.min(1, 0.3 + sceneBlend * 0.7),
    isGenerated: true,
    source: "hvac-axis-projection",
  };
}

export function deriveHvacProjectionElements(
  elements: HvacElement[],
  blend: number,
): HvacProjectionElement3D[] {
  return elements.flatMap((sourceElement) => {
    const attributes = deriveHvac3DProjectionAttributes(sourceElement, blend);
    if (!attributes) {
      return [];
    }

    const element: HvacElementWithProjection3D = {
      ...sourceElement,
      type: attributes.renderType,
      position: attributes.positionMm,
      rotation: attributes.rotationDeg,
      width: attributes.widthMm,
      depth: attributes.depthMm,
      height: attributes.heightMm,
      elevation: attributes.baseElevationMm,
      projection3D: attributes,
    };

    return [
      {
        sourceElement,
        element,
        attributes,
      },
    ];
  });
}

export function hasProjectableHvac3D(elements: HvacElement[]): boolean {
  return elements.some((element) =>
    Boolean(deriveHvac3DProjectionAttributes(element, 1)),
  );
}
