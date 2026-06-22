"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import type { HvacElement, Point2D } from "../../../../types";
import { MM_TO_PX } from "../../scale";
import { buildGiDuctVisual } from "../giDuctModel";
import {
  buildRefrigerantBranchKitViewModel,
  isRefrigerantBranchKitElement,
} from "../refrigerantBranchKitModel";
import {
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipeVisual,
} from "../refrigerantPipePairModel";
import {
  buildRefrigerantPipeEndpointRenderStateMap,
  buildRefrigerantPipeRenderChainStateMap,
  getVisibleRefrigerantPipeStraightSegmentTargets,
} from "../refrigerantPipeRenderState";

import {
  buildHvacElementMesh,
} from "./buildHvacElementMesh";
import {
  deriveHvacProjectionElements,
  type Hvac3DProjectionAttributes,
} from "./hvac3dAttributes";
import { getPlanProjectionVisualState } from "./projectionState";

export interface HvacProjectionLayerProps {
  className?: string;
  width: number;
  height: number;
  zoom: number;
  drawingScale: number;
  panOffset: Point2D;
  blend: number;
  hvacElements: HvacElement[];
}

type ProjectionSceneState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  pivot: THREE.Group;
  hvacRoot: THREE.Group;
  shadowPlane: THREE.Mesh;
  keyLight: THREE.DirectionalLight;
  fillLight: THREE.DirectionalLight;
};

const HVAC_OBLIQUE_X = 0.82;
const HVAC_OBLIQUE_Y = -1.05;
const CAMERA_DISTANCE_PX = 120000;
const CAMERA_DEPTH_PX = 260000;

type HvacProjectionSceneContext = Parameters<typeof buildHvacElementMesh>[1];
type ScreenPoint = {
  x: number;
  y: number;
};

type InstallationDatumAnnotation = {
  key: string;
  elementId: string;
  anchor: Point2D;
  datumElevationMm: number;
  label: string;
  detailLabel?: string;
  color: string;
  warning: boolean;
};

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) {
    material.forEach((entry) => entry.dispose());
    return;
  }
  material.dispose();
}

function disposeObjectGeometry(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (
      child instanceof THREE.Mesh ||
      child instanceof THREE.Line ||
      child instanceof THREE.LineSegments
    ) {
      child.geometry.dispose();
      if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
        disposeMaterial(child.material);
      }
    }
  });
}

function clearGroup(group: THREE.Group): void {
  group.children.forEach(disposeObjectGeometry);
  group.clear();
}

function rotateLocalPoint(
  x: number,
  y: number,
  rotationDeg: number,
): Point2D {
  const radians = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  };
}

function resolveInstallationGuideAnchor(
  attributes: Hvac3DProjectionAttributes,
): Point2D {
  const halfWidth = attributes.widthMm / 2;
  const halfDepth = attributes.depthMm / 2;
  const anchor =
    attributes.category === "equipment"
      ? { x: halfWidth * 0.42, y: halfDepth * 0.42 }
      : { x: halfWidth, y: halfDepth };
  const rotated = rotateLocalPoint(
    anchor.x,
    anchor.y,
    attributes.rotationDeg,
  );

  return {
    x: attributes.footprintCenterMm.x + rotated.x,
    y: attributes.footprintCenterMm.y + rotated.y,
  };
}

function projectPointToScreen(options: {
  point: Point2D;
  elevationMm: number;
  worldScale: number;
  viewportScale: number;
  panOffset: Point2D;
  sceneBlend: number;
}): ScreenPoint {
  const projectedElevation =
    Math.max(0, options.elevationMm) * options.worldScale * options.sceneBlend;
  return {
    x:
      options.point.x * options.worldScale -
      options.panOffset.x * options.viewportScale +
      projectedElevation * HVAC_OBLIQUE_X,
    y:
      options.point.y * options.worldScale -
      options.panOffset.y * options.viewportScale +
      projectedElevation * HVAC_OBLIQUE_Y,
  };
}

function formatAffMm(value: number): string {
  const rounded = Math.round(Math.max(0, value));
  return `+${rounded} mm AFF`;
}

function formatDatumLabel(
  prefix: string,
  elevationMm: number,
  warning: boolean,
): string {
  if (warning) {
    return `${prefix} HEIGHT NOT SET`;
  }
  return `${prefix} ${formatAffMm(elevationMm)}`;
}

function isUnsetInstallationHeight(
  elevationMm: number,
  attributes: Hvac3DProjectionAttributes,
): boolean {
  if (!Number.isFinite(elevationMm)) {
    return true;
  }
  if (attributes.mountType === "floor") {
    return false;
  }
  return elevationMm <= 1;
}

function resolvePolylineMidpoint(points: Point2D[]): Point2D | null {
  if (points.length === 0) {
    return null;
  }
  if (points.length === 1) {
    return points[0] ?? null;
  }

  let totalLength = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) {
      continue;
    }
    totalLength += Math.hypot(end.x - start.x, end.y - start.y);
  }

  if (totalLength <= 0.01) {
    return points[0] ?? null;
  }

  const targetLength = totalLength / 2;
  let walkedLength = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) {
      continue;
    }
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    if (segmentLength <= 0.01) {
      continue;
    }
    if (walkedLength + segmentLength >= targetLength) {
      const ratio = (targetLength - walkedLength) / segmentLength;
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      };
    }
    walkedLength += segmentLength;
  }

  return points[points.length - 1] ?? null;
}

function averagePoints(first: Point2D | null, second: Point2D | null): Point2D | null {
  if (first && second) {
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    };
  }
  return first ?? second;
}

function createInstallationDatum(options: {
  elementId: string;
  anchor: Point2D;
  prefix: string;
  elevationMm: number;
  detailLabel?: string;
  color: string;
  attributes: Hvac3DProjectionAttributes;
}): InstallationDatumAnnotation {
  const warning = isUnsetInstallationHeight(
    options.elevationMm,
    options.attributes,
  );
  return {
    key: `installation-datum-${options.elementId}`,
    elementId: options.elementId,
    anchor: options.anchor,
    datumElevationMm: Math.max(0, Number.isFinite(options.elevationMm) ? options.elevationMm : 0),
    label: formatDatumLabel(options.prefix, options.elevationMm, warning),
    detailLabel: options.detailLabel,
    color: warning ? "#b45309" : options.color,
    warning,
  };
}

function resolveInstallationDatumAnnotation(
  element: HvacElement,
  attributes: Hvac3DProjectionAttributes,
  context: HvacProjectionSceneContext,
): InstallationDatumAnnotation | null {
  if (element.type === "refrigerant-pipe") {
    const chainState = context.pipeRenderChainStateMap?.get(element.id) ?? null;
    if (chainState && !chainState.renderAsHead) {
      return null;
    }

    const visual = buildRefrigerantPipeVisual(element, context.allElements);
    const points = chainState?.continuousOuterPoints ?? visual.continuousOuterPoints;
    const anchor =
      resolvePolylineMidpoint(points) ?? attributes.footprintCenterMm;
    const elevationMm =
      chainState?.elevationMm ?? element.elevation + visual.localZMm;
    const prefix = `${(chainState?.lineKind ?? visual.lineKind).toUpperCase()} CL`;

    return createInstallationDatum({
      elementId: attributes.elementId,
      anchor,
      prefix,
      elevationMm,
      detailLabel: `OD ${Math.round((chainState?.outerRadiusMm ?? visual.outerRadiusMm) * 2)} mm`,
      color: (chainState?.lineKind ?? visual.lineKind) === "gas" ? "#1d4ed8" : "#0f766e",
      attributes,
    });
  }

  if (element.type === "refrigerant-pipe-pair") {
    const visual = buildRefrigerantPipePairVisual(element, context.allElements);
    const gasElevationMm = element.elevation + visual.gasLocalZMm;
    const liquidElevationMm = element.elevation + visual.liquidLocalZMm;
    const elevationMm = (gasElevationMm + liquidElevationMm) / 2;
    const anchor =
      averagePoints(
        resolvePolylineMidpoint(visual.gasContinuousOuterPoints),
        resolvePolylineMidpoint(visual.liquidContinuousOuterPoints),
      ) ?? attributes.footprintCenterMm;

    return createInstallationDatum({
      elementId: attributes.elementId,
      anchor,
      prefix: "PAIR CL",
      elevationMm,
      detailLabel: `G ${formatAffMm(gasElevationMm)} / L ${formatAffMm(liquidElevationMm)}`,
      color: "#0f766e",
      attributes,
    });
  }

  if (element.type === "duct") {
    const visual = buildGiDuctVisual(element);
    const baseElevationMm = Math.max(0, element.elevation);
    const topElevationMm = baseElevationMm + visual.outerHeightMm;
    const elevationMm = baseElevationMm + visual.outerHeightMm / 2;
    const anchor =
      resolvePolylineMidpoint(visual.routePoints) ?? attributes.footprintCenterMm;

    return createInstallationDatum({
      elementId: attributes.elementId,
      anchor,
      prefix: "DUCT CL",
      elevationMm,
      detailLabel: `BOP ${formatAffMm(baseElevationMm)} / TOP ${formatAffMm(topElevationMm)}`,
      color: "#7c3aed",
      attributes,
    });
  }

  if (isRefrigerantBranchKitElement(element)) {
    const model = buildRefrigerantBranchKitViewModel(element);
    const gasElevationMm = element.elevation + model.gas.centerlineZMm;
    const liquidElevationMm = element.elevation + model.liquid.centerlineZMm;
    const elevationMm = (gasElevationMm + liquidElevationMm) / 2;

    return createInstallationDatum({
      elementId: attributes.elementId,
      anchor: attributes.footprintCenterMm,
      prefix: "KIT CL",
      elevationMm,
      detailLabel: `G ${formatAffMm(gasElevationMm)} / L ${formatAffMm(liquidElevationMm)}`,
      color: "#0f766e",
      attributes,
    });
  }

  if (
    attributes.category === "equipment" ||
    attributes.category === "accessory" ||
    attributes.category === "air-terminal" ||
    attributes.category === "control"
  ) {
    if (attributes.mountType === "floor" && attributes.baseElevationMm <= 1) {
      return null;
    }

    const prefix =
      attributes.category === "air-terminal" ? "FACE BASE" : "BASE";
    return createInstallationDatum({
      elementId: attributes.elementId,
      anchor: resolveInstallationGuideAnchor(attributes),
      prefix,
      elevationMm: attributes.baseElevationMm,
      detailLabel: `TOP ${formatAffMm(attributes.topElevationMm)}`,
      color: attributes.category === "control" ? "#64748b" : "#334155",
      attributes,
    });
  }

  return null;
}

function renderInstallationDatumAnnotation(options: {
  datum: InstallationDatumAnnotation;
  worldScale: number;
  viewportScale: number;
  panOffset: Point2D;
  sceneBlend: number;
  opacity: number;
}) {
  const { datum, worldScale, viewportScale, panOffset, sceneBlend, opacity } =
    options;
  if (sceneBlend <= 0.08) {
    return null;
  }

  const floorPoint = projectPointToScreen({
    point: datum.anchor,
    elevationMm: 0,
    worldScale,
    viewportScale,
    panOffset,
    sceneBlend,
  });
  const datumPoint = projectPointToScreen({
    point: datum.anchor,
    elevationMm: datum.datumElevationMm,
    worldScale,
    viewportScale,
    panOffset,
    sceneBlend,
  });
  const vector = {
    x: datumPoint.x - floorPoint.x,
    y: datumPoint.y - floorPoint.y,
  };
  const vectorLength = Math.hypot(vector.x, vector.y);
  const normal = vectorLength > 0.01
    ? {
        x: -vector.y / vectorLength,
        y: vector.x / vectorLength,
      }
    : { x: 0.72, y: 0.7 };
  const datumOffset = {
    x: normal.x * 9 + 8,
    y: normal.y * 9 - 4,
  };
  const floorDatum = {
    x: floorPoint.x + datumOffset.x,
    y: floorPoint.y + datumOffset.y,
  };
  const installedDatum = {
    x: datumPoint.x + datumOffset.x,
    y: datumPoint.y + datumOffset.y,
  };
  const tick = 5;
  const leaderEnd = {
    x: installedDatum.x + 26,
    y: installedDatum.y - 14,
  };
  const labelX = leaderEnd.x + 5;
  const labelY = leaderEnd.y - (datum.detailLabel ? 7 : 2);
  const renderedOpacity = Math.min(0.88, Math.max(0, opacity));
  const stroke = datum.color;

  return (
    <g
      key={datum.key}
      opacity={renderedOpacity}
    >
      <path
        d={`M ${floorDatum.x} ${floorDatum.y} L ${installedDatum.x} ${installedDatum.y}`}
        fill="none"
        stroke={stroke}
        strokeWidth={1.15}
        strokeDasharray={datum.warning ? "4 3" : "3 4"}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={`M ${floorDatum.x - normal.x * tick} ${floorDatum.y - normal.y * tick} L ${floorDatum.x + normal.x * tick} ${floorDatum.y + normal.y * tick}`}
        fill="none"
        stroke={stroke}
        strokeWidth={1.1}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={`M ${installedDatum.x - normal.x * tick} ${installedDatum.y - normal.y * tick} L ${installedDatum.x + normal.x * tick} ${installedDatum.y + normal.y * tick}`}
        fill="none"
        stroke={stroke}
        strokeWidth={1.1}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={installedDatum.x}
        cy={installedDatum.y}
        r={2.8}
        fill="#ffffff"
        stroke={stroke}
        strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={`M ${installedDatum.x} ${installedDatum.y} L ${leaderEnd.x} ${leaderEnd.y}`}
        fill="none"
        stroke={stroke}
        strokeWidth={1.2}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={labelX}
        y={labelY}
        fill={stroke}
        fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
        fontSize={11}
        fontWeight={700}
        paintOrder="stroke"
        stroke="#ffffff"
        strokeWidth={3}
        vectorEffect="non-scaling-stroke"
      >
        {datum.label}
      </text>
      {datum.detailLabel ? (
        <text
          x={labelX}
          y={labelY + 13}
          fill={stroke}
          fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
          fontSize={9.5}
          fontWeight={600}
          paintOrder="stroke"
          stroke="#ffffff"
          strokeWidth={3}
          vectorEffect="non-scaling-stroke"
        >
          {datum.detailLabel}
        </text>
      ) : null}
    </g>
  );
}

function tuneMaterialForEmbeddedProjection(object: THREE.Object3D): void {
  const meshes: THREE.Mesh[] = [];
  const brightMaterialTint = new THREE.Color(0x94a3b8);

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    meshes.push(child);
    child.castShadow = true;
    child.receiveShadow = true;
    child.renderOrder += 10;
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    materials.forEach((material) => {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.roughness = Math.max(material.roughness, 0.78);
        material.metalness = Math.min(material.metalness, 0.16);
        if (
          material.color.r > 0.86 &&
          material.color.g > 0.86 &&
          material.color.b > 0.86
        ) {
          material.color.lerp(brightMaterialTint, 0.22);
        }
      }
    });
  });

  meshes.forEach((mesh) => {
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 28),
      new THREE.LineBasicMaterial({
        color: 0x0f172a,
        transparent: true,
        opacity: 0.82,
        depthTest: true,
      }),
    );
    outline.name = `${mesh.name || "hvac"}-projection-outline`;
    outline.renderOrder = mesh.renderOrder + 1;
    mesh.add(outline);
  });
}

function resolvePlanAnchorElevationMm(
  element: HvacElement,
  context: HvacProjectionSceneContext,
  mesh: THREE.Object3D,
  attributes?: Hvac3DProjectionAttributes,
): number {
  if (element.type === "refrigerant-pipe") {
    const chainState = context.pipeRenderChainStateMap?.get(element.id) ?? null;
    if (chainState) {
      return chainState.elevationMm;
    }
    const visual = buildRefrigerantPipeVisual(element, context.allElements);
    return element.elevation + visual.localZMm;
  }

  if (element.type === "refrigerant-pipe-pair") {
    const visual = buildRefrigerantPipePairVisual(element, context.allElements);
    return (
      element.elevation +
      (visual.gasLocalZMm + visual.liquidLocalZMm) / 2
    );
  }

  if (
    element.type === "duct" ||
    element.type === "ducted-ac" ||
    element.type === "ceiling-cassette-ac" ||
    element.type === "ceiling-suspended-ac" ||
    element.type === "wall-mounted-ac" ||
    element.type === "split-ac" ||
    element.type === "outdoor-unit" ||
    isRefrigerantBranchKitElement(element)
  ) {
    return attributes?.baseElevationMm ?? element.elevation;
  }

  const bounds = new THREE.Box3().setFromObject(mesh);
  return bounds.isEmpty()
    ? (attributes?.baseElevationMm ?? 0)
    : Math.max(0, attributes?.baseElevationMm ?? bounds.min.z);
}

function createSceneState(canvas: HTMLCanvasElement): ProjectionSceneState {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0xffffff, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(
    0,
    1,
    0,
    1,
    0.1,
    CAMERA_DEPTH_PX,
  );
  camera.position.set(0, 0, CAMERA_DISTANCE_PX);
  camera.lookAt(0, 0, 0);

  const pivot = new THREE.Group();
  pivot.name = "plan-born-hvac-projection";
  pivot.matrixAutoUpdate = false;
  const hvacRoot = new THREE.Group();
  hvacRoot.name = "plan-born-hvac-meshes";
  pivot.add(hvacRoot);

  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({
      color: 0x0f172a,
      opacity: 0.16,
      transparent: true,
    }),
  );
  shadowPlane.name = "hvac-contact-shadow-plane";
  shadowPlane.position.set(0, 0, -2);
  shadowPlane.receiveShadow = true;
  pivot.add(shadowPlane);

  const ambient = new THREE.AmbientLight(0xffffff, 1.45);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xfff7ed, 2.1);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = CAMERA_DEPTH_PX;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.9);
  scene.add(fillLight);

  scene.add(pivot);

  return {
    renderer,
    scene,
    camera,
    pivot,
    hvacRoot,
    shadowPlane,
    keyLight,
    fillLight,
  };
}

export function HvacProjectionLayer({
  className = "",
  width,
  height,
  zoom,
  drawingScale,
  panOffset,
  blend,
  hvacElements,
}: HvacProjectionLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneStateRef = useRef<ProjectionSceneState | null>(null);
  const projectionState = useMemo(
    () => getPlanProjectionVisualState(blend),
    [blend],
  );
  const projectedElements = useMemo(
    () => deriveHvacProjectionElements(hvacElements, 1),
    [hvacElements],
  );
  const hasProjectedElements = projectedElements.length > 0;
  const dynamicAttributesById = useMemo(
    () =>
      new Map(
        deriveHvacProjectionElements(hvacElements, blend).map(
          ({ attributes }) => [attributes.elementId, attributes],
        ),
      ),
    [blend, hvacElements],
  );
  const projectedSceneElements = useMemo(
    () => projectedElements.map((entry) => entry.element),
    [projectedElements],
  );
  const safeDrawingScale =
    Number.isFinite(drawingScale) && drawingScale > 0 ? drawingScale : 1;
  const viewportScale = Math.max(0.0001, zoom * safeDrawingScale);
  const worldScale = MM_TO_PX * viewportScale;

  const sceneContext = useMemo(() => {
    const pipeEndpointStateMap =
      buildRefrigerantPipeEndpointRenderStateMap(projectedSceneElements);
    const pipeRenderChainStateMap = buildRefrigerantPipeRenderChainStateMap(
      projectedSceneElements,
      pipeEndpointStateMap,
    );

    return {
      allElements: projectedSceneElements,
      pipeEndpointStateMap,
      pipeRenderChainStateMap,
      pipeTargets: getVisibleRefrigerantPipeStraightSegmentTargets(
        projectedSceneElements,
      ),
    };
  }, [projectedSceneElements]);
  const installationDatumAnnotations = useMemo(() => {
    const datums: InstallationDatumAnnotation[] = [];
    const seenKeys = new Set<string>();

    projectedElements.forEach(({ element, attributes }) => {
      const dynamicAttributes =
        dynamicAttributesById.get(attributes.elementId) ?? attributes;
      const datum = resolveInstallationDatumAnnotation(
        element,
        dynamicAttributes,
        sceneContext,
      );
      if (!datum) {
        return;
      }

      const identity = [
        Math.round(datum.anchor.x / 10),
        Math.round(datum.anchor.y / 10),
        Math.round(datum.datumElevationMm),
        datum.label,
      ].join(":");
      if (seenKeys.has(identity)) {
        return;
      }
      seenKeys.add(identity);
      datums.push(datum);
    });

    return datums;
  }, [dynamicAttributesById, projectedElements, sceneContext]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!hasProjectedElements || !canvas || sceneStateRef.current) {
      return;
    }

    const sceneState = createSceneState(canvas);
    sceneStateRef.current = sceneState;

    return () => {
      clearGroup(sceneState.hvacRoot);
      sceneState.shadowPlane.geometry.dispose();
      sceneState.renderer.dispose();
      sceneStateRef.current = null;
    };
  }, [hasProjectedElements]);

  useEffect(() => {
    const sceneState = sceneStateRef.current;
    if (!sceneState) {
      return;
    }

    clearGroup(sceneState.hvacRoot);
    projectedElements.forEach(({ element, attributes }) => {
      const mesh = buildHvacElementMesh(element, sceneContext);
      if (!mesh || mesh.children.length === 0) {
        return;
      }
      tuneMaterialForEmbeddedProjection(mesh);
      const anchoredMesh = new THREE.Group();
      anchoredMesh.name = `anchored-${mesh.name || element.id}`;
      anchoredMesh.userData.hvacElementId = attributes.elementId;
      anchoredMesh.userData.anchorElevationMm = resolvePlanAnchorElevationMm(
        element,
        sceneContext,
        mesh,
        attributes,
      );
      anchoredMesh.userData.projection3D = attributes;
      anchoredMesh.add(mesh);
      sceneState.hvacRoot.add(anchoredMesh);
    });
  }, [projectedElements, sceneContext]);

  useEffect(() => {
    const sceneState = sceneStateRef.current;
    if (!sceneState) {
      return;
    }

    sceneState.hvacRoot.children.forEach((child) => {
      const hvacElementId =
        typeof child.userData.hvacElementId === "string"
          ? child.userData.hvacElementId
          : null;
      const attributes = hvacElementId
        ? dynamicAttributesById.get(hvacElementId)
        : null;
      if (attributes) {
        child.userData.projection3D = attributes;
      }
    });
  }, [dynamicAttributesById]);

  useEffect(() => {
    const sceneState = sceneStateRef.current;
    if (!sceneState) {
      return;
    }

    const viewWidth = Math.max(1, Math.floor(width));
    const viewHeight = Math.max(1, Math.floor(height));
    const pixelRatio =
      typeof window === "undefined"
        ? 1
        : Math.min(window.devicePixelRatio || 1, 2);

    sceneState.renderer.setPixelRatio(pixelRatio);
    sceneState.renderer.setSize(viewWidth, viewHeight, false);

    sceneState.camera.left = 0;
    sceneState.camera.right = viewWidth;
    sceneState.camera.top = 0;
    sceneState.camera.bottom = viewHeight;
    sceneState.camera.near = 0.1;
    sceneState.camera.far = CAMERA_DEPTH_PX;
    sceneState.camera.position.set(0, 0, CAMERA_DISTANCE_PX);
    sceneState.camera.lookAt(0, 0, 0);
    sceneState.camera.updateProjectionMatrix();

    sceneState.pivot.matrix.set(
      1,
      0,
      HVAC_OBLIQUE_X * projectionState.sceneBlend,
      0,
      0,
      1,
      HVAC_OBLIQUE_Y * projectionState.sceneBlend,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    );
    sceneState.pivot.matrixWorldNeedsUpdate = true;

    sceneState.hvacRoot.position.set(
      -panOffset.x * viewportScale,
      -panOffset.y * viewportScale,
      0,
    );
    sceneState.hvacRoot.scale.set(worldScale, worldScale, worldScale);
    sceneState.hvacRoot.children.forEach((child) => {
      child.position.set(0, 0, 0);
    });

    sceneState.shadowPlane.position.set(viewWidth / 2, viewHeight / 2, -2);
    sceneState.shadowPlane.scale.set(viewWidth, viewHeight, 1);
    const shadowMaterial = sceneState.shadowPlane.material;
    if (shadowMaterial instanceof THREE.ShadowMaterial) {
      shadowMaterial.opacity =
        projectionState.shadowOpacity * projectionState.sceneBlend;
      shadowMaterial.needsUpdate = true;
    }

    const lightDistance = Math.max(viewWidth, viewHeight, 1) * 1.6;
    sceneState.keyLight.position.set(
      viewWidth * 0.3,
      -lightDistance,
      lightDistance * 1.6,
    );
    sceneState.keyLight.target.position.set(viewWidth / 2, viewHeight / 2, 0);
    sceneState.scene.add(sceneState.keyLight.target);

    const shadowCamera = sceneState.keyLight.shadow.camera;
    if (shadowCamera instanceof THREE.OrthographicCamera) {
      const shadowExtent = Math.max(viewWidth, viewHeight) * 0.85;
      shadowCamera.left = -shadowExtent;
      shadowCamera.right = shadowExtent;
      shadowCamera.top = shadowExtent;
      shadowCamera.bottom = -shadowExtent;
      shadowCamera.updateProjectionMatrix();
    }

    sceneState.fillLight.position.set(-viewWidth, viewHeight, lightDistance);
    sceneState.renderer.render(sceneState.scene, sceneState.camera);
  }, [
    drawingScale,
    height,
    panOffset.x,
    panOffset.y,
    projectionState.sceneBlend,
    projectionState.shadowOpacity,
    projectedElements,
    sceneContext,
    viewportScale,
    width,
    worldScale,
    zoom,
  ]);

  if (!hasProjectedElements) {
    return null;
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 block pointer-events-none ${className}`}
        style={{
          opacity: projectionState.hvacOpacity,
          width: "100%",
          height: "100%",
          zIndex: 11,
        }}
      />
      <svg
        className={`absolute inset-0 block pointer-events-none ${className}`}
        viewBox={`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`}
        preserveAspectRatio="none"
        style={{
          opacity: projectionState.hvacOpacity,
          overflow: "visible",
          width: "100%",
          height: "100%",
          zIndex: 12,
        }}
      >
        {installationDatumAnnotations.map((datum) =>
          renderInstallationDatumAnnotation({
            datum,
            worldScale,
            viewportScale,
            panOffset,
            sceneBlend: projectionState.sceneBlend,
            opacity: projectionState.labelOpacity,
          }),
        )}
      </svg>
    </>
  );
}
