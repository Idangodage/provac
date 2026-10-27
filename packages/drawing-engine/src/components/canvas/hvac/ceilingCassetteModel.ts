import type { HvacElement } from '../../../types';

import {
  computeIndoorDrainPortStubLengthMm,
  computeIndoorRefrigerantPortStubLengthMm,
  DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM,
  DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM,
} from './refrigerantPipeDimensions';
import { drainConnectionOf, makerPortGeometry, unitConnectionOf, unitConnectionsFor, type UnitConnection } from './unitConnections';
import { drainPumpChoice } from './unitDrainPump';

export interface CeilingCassetteBoxSpec {
  x: number;
  y: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  cornerRadius: number;
}

export interface CeilingCassetteSlotSpec extends CeilingCassetteBoxSpec {
  orientation: 'horizontal' | 'vertical';
}

export interface CeilingCassettePipePortSpec {
  kind: 'gas' | 'liquid' | 'drain';
  x: number;
  y: number;
  z: number;
  radius: number;
  length: number;
  collarRadius: number;
  collarLength: number;
  flangeThickness: number;
  bandRadius: number;
  color: string;
  collarColor?: string;
  flangeColor?: string;
  bandColor: string;
  /** Along the port's axis from x. */
  bandOffsetX: number;
  /** Outward along local x: +1 (default) or −1 (a maker's stub on the −x side). */
  axis?: 1 | -1;
  /** The maker's 3D model already shows this stub or hose: the 3D draws nothing over it. */
  inModel?: boolean;
  /** How the field pipe joins it, where the maker says. */
  joint?: UnitConnection['joint'];
}

export interface CeilingCassetteGrilleSpec {
  x: number;
  y: number;
  z: number;
  size: number;
  frameHeight: number;
  cornerRadius: number;
  slatCount: number;
  slatSpan: number;
  slatInset: number;
  slatStep: number;
  horizontalSlatZ: number;
  verticalSlatZ: number;
}

export interface CeilingCassetteModelSpec {
  baseWidth: number;
  baseDepth: number;
  panelSize: number;
  panelHeight: number;
  cassetteBodyHeight: number;
  bodyBaseZ: number;
  grilleDensityFactor: number;
  slotInsetFactor: number;
  hiddenBody: CeilingCassetteBoxSpec;
  topCap: CeilingCassetteBoxSpec;
  drainPumpHousing: CeilingCassetteBoxSpec;
  facePanel: CeilingCassetteBoxSpec & {
    bevelThickness: number;
    bevelSize: number;
  };
  innerPanel: CeilingCassetteBoxSpec & {
    bevelThickness: number;
    bevelSize: number;
  };
  slots: CeilingCassetteSlotSpec[];
  vanes: CeilingCassetteBoxSpec[];
  grille: CeilingCassetteGrilleSpec;
  accentBar: CeilingCassetteBoxSpec;
  serviceTab: CeilingCassetteBoxSpec;
  connectionPod: CeilingCassetteBoxSpec;
  pipePorts: CeilingCassettePipePortSpec[];
  /** The panel's centre in the unit frame: off 0,0 when a maker cassette's footprint also spans its connections. */
  panelCentre: { x: number; y: number };
}

export function getCeilingCassettePipePortEndpointLocal(
  port: CeilingCassettePipePortSpec,
): { x: number; y: number } {
  return {
    x: port.x + (port.axis ?? 1) * (port.collarLength + port.length - port.flangeThickness * 0.15),
    y: port.y,
  };
}

export function getCeilingCassettePipePortConnectionLocal(
  port: CeilingCassettePipePortSpec,
): { x: number; y: number } {
  return {
    x: port.x + (port.axis ?? 1) * (port.collarLength - port.flangeThickness * 0.15),
    y: port.y,
  };
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readFlexibleNumberProperty(properties: Record<string, unknown>, key: string): number | null {
  const value = properties[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildPipePortSpec(
  port: Omit<CeilingCassettePipePortSpec, 'collarRadius' | 'collarLength' | 'flangeThickness'>,
): CeilingCassettePipePortSpec {
  const collarRadius = port.radius * 1.24;
  const collarLength = Math.max(10, port.length * 0.28);
  const flangeThickness = Math.max(4, collarLength * 0.24);
  return {
    ...port,
    collarRadius,
    collarLength,
    flangeThickness,
  };
}

type CassetteElement = Pick<HvacElement, 'width' | 'depth' | 'height' | 'properties'>;

/**
 * The cassette as drawn: from its maker's data where the catalogue has it
 * (the panel at its true centre, the stubs where the maker's model has them),
 * else proportioned from its size.
 */
export function buildCeilingCassetteModel(element: CassetteElement): CeilingCassetteModelSpec {
  const maker = unitConnectionsFor(element);
  if (!maker) return buildProportionedCassetteModel(element);
  const model = maker.panel
    ? shiftCassetteModel(buildProportionedCassetteModel({ ...element, width: maker.panel.sizeMm, depth: maker.panel.sizeMm }), maker.panel.centre)
    : buildProportionedCassetteModel(element);
  const styleOf = (kind: CeilingCassettePipePortSpec['kind']) => model.pipePorts.find((port) => port.kind === kind)!;
  const ports: CeilingCassettePipePortSpec[] = [];
  const add = (kind: CeilingCassettePipePortSpec['kind'], connection: UnitConnection | null) => {
    if (!connection) return;
    const geometry = makerPortGeometry(connection);
    const style = styleOf(kind);
    ports.push({
      ...style,
      ...geometry,
      kind,
      x: connection.rootX,
      y: connection.y,
      z: connection.z,
      axis: connection.axis,
      inModel: connection.inModel,
      joint: connection.joint,
      bandRadius: geometry.radius + 1.5,
      bandOffsetX: (geometry.collarLength + geometry.length) * 0.7,
    });
  };
  add('gas', unitConnectionOf(maker, 'gas'));
  add('liquid', unitConnectionOf(maker, 'liquid'));
  // A cassette drains through its pump unless set to gravity.
  add('drain', drainConnectionOf(maker, drainPumpChoice(element) ?? true));
  return { ...model, baseWidth: element.width, baseDepth: element.depth, pipePorts: ports };
}

function shiftBox<T extends { x: number; y: number }>(box: T, by: { x: number; y: number }): T {
  return { ...box, x: box.x + by.x, y: box.y + by.y };
}

/** The whole cassette moved in its own plane (its pipe ports are the caller's). */
function shiftCassetteModel(model: CeilingCassetteModelSpec, by: { x: number; y: number }): CeilingCassetteModelSpec {
  return {
    ...model,
    hiddenBody: shiftBox(model.hiddenBody, by),
    topCap: shiftBox(model.topCap, by),
    drainPumpHousing: shiftBox(model.drainPumpHousing, by),
    facePanel: shiftBox(model.facePanel, by),
    innerPanel: shiftBox(model.innerPanel, by),
    slots: model.slots.map((slot) => shiftBox(slot, by)),
    vanes: model.vanes.map((vane) => shiftBox(vane, by)),
    grille: shiftBox(model.grille, by),
    accentBar: shiftBox(model.accentBar, by),
    serviceTab: shiftBox(model.serviceTab, by),
    connectionPod: shiftBox(model.connectionPod, by),
    pipePorts: model.pipePorts.map((port) => shiftBox(port, by)),
    panelCentre: { x: model.panelCentre.x + by.x, y: model.panelCentre.y + by.y },
  };
}

function buildProportionedCassetteModel(element: CassetteElement): CeilingCassetteModelSpec {
  const gasPipeDiameterMm = readFlexibleNumberProperty(element.properties, 'refrigerantGasPipeDiameterMm')
    ?? readFlexibleNumberProperty(element.properties, 'Refrigerant Gas Pipe Diameter (mm)')
    ?? DEFAULT_REFRIGERANT_GAS_PIPE_DIAMETER_MM;
  const liquidPipeDiameterMm = readFlexibleNumberProperty(element.properties, 'refrigerantLiquidPipeDiameterMm')
    ?? readFlexibleNumberProperty(element.properties, 'Refrigerant Liquid Pipe Diameter (mm)')
    ?? DEFAULT_REFRIGERANT_LIQUID_PIPE_DIAMETER_MM;
  const drainPipeDiameterMm = readFlexibleNumberProperty(element.properties, 'drainPipeDiameter1Mm')
    ?? readFlexibleNumberProperty(element.properties, 'Drain Pipe Diameter 1 (mm)')
    ?? 32;
  const staticPressurePa = readFlexibleNumberProperty(element.properties, 'staticPressurePa')
    ?? readFlexibleNumberProperty(element.properties, 'espPa')
    ?? readFlexibleNumberProperty(element.properties, 'External Static Pressure (Pa)')
    ?? 200;

  const baseWidth = element.width;
  const baseDepth = element.depth;
  const panelSize = Math.max(baseWidth, baseDepth);
  const minBaseDimension = Math.min(baseWidth, baseDepth);
  const panelHeight = Math.max(28, Math.min(44, element.height * 0.16));
  const cassetteBodyHeight = Math.max(70, element.height - panelHeight * 0.4);
  const bodyBaseZ = panelHeight * 0.55;
  const grilleDensityFactor = clampValue(staticPressurePa / 200, 0.7, 1.35);
  const slotInsetFactor = clampValue(0.32 - (grilleDensityFactor - 1) * 0.03, 0.26, 0.36);
  const slotHeight = Math.max(5, panelHeight * 0.12);
  const slotZ = panelHeight * 0.62;
  const slotRadius = panelSize * 0.016;
  const vaneThickness = 1.5;
  const vaneHeight = Math.max(3, slotHeight * 0.7);
  const vaneZ = panelHeight * 0.64;

  const hiddenBody: CeilingCassetteBoxSpec = {
    x: 0,
    y: 0,
    z: bodyBaseZ + cassetteBodyHeight / 2,
    width: baseWidth * 0.82,
    depth: baseDepth * 0.82,
    height: cassetteBodyHeight,
    cornerRadius: minBaseDimension * 0.04,
  };

  const topCap: CeilingCassetteBoxSpec = {
    x: 0,
    y: 0,
    z: bodyBaseZ + cassetteBodyHeight * 0.97,
    width: baseWidth * 0.84,
    depth: baseDepth * 0.84,
    height: Math.max(8, cassetteBodyHeight * 0.05),
    cornerRadius: minBaseDimension * 0.035,
  };

  const drainPumpHousing: CeilingCassetteBoxSpec = {
    x: baseWidth * 0.36,
    y: -baseDepth * 0.22,
    z: bodyBaseZ + cassetteBodyHeight * 0.35,
    width: baseWidth * 0.14,
    depth: baseDepth * 0.2,
    height: Math.max(22, cassetteBodyHeight * 0.18),
    cornerRadius: baseDepth * 0.018,
  };

  const facePanel: CeilingCassetteModelSpec['facePanel'] = {
    x: 0,
    y: 0,
    z: panelHeight / 2,
    width: panelSize,
    depth: panelSize,
    height: panelHeight,
    cornerRadius: panelSize * 0.085,
    bevelThickness: Math.min(panelHeight * 0.22, 6),
    bevelSize: panelSize * 0.025,
  };

  const innerPanel: CeilingCassetteModelSpec['innerPanel'] = {
    x: 0,
    y: 0,
    z: panelHeight * 0.48,
    width: panelSize * 0.92,
    depth: panelSize * 0.92,
    height: Math.max(10, panelHeight * 0.38),
    cornerRadius: panelSize * 0.072,
    bevelThickness: Math.max(1.2, panelHeight * 0.12),
    bevelSize: panelSize * 0.018,
  };

  const slots: CeilingCassetteSlotSpec[] = [
    {
      x: 0,
      y: -panelSize * slotInsetFactor,
      z: slotZ,
      width: panelSize * 0.6,
      depth: panelSize * 0.07,
      height: slotHeight,
      cornerRadius: slotRadius,
      orientation: 'horizontal',
    },
    {
      x: 0,
      y: panelSize * slotInsetFactor,
      z: slotZ,
      width: panelSize * 0.6,
      depth: panelSize * 0.07,
      height: slotHeight,
      cornerRadius: slotRadius,
      orientation: 'horizontal',
    },
    {
      x: -panelSize * slotInsetFactor,
      y: 0,
      z: slotZ,
      width: panelSize * 0.07,
      depth: panelSize * 0.6,
      height: slotHeight,
      cornerRadius: slotRadius,
      orientation: 'vertical',
    },
    {
      x: panelSize * slotInsetFactor,
      y: 0,
      z: slotZ,
      width: panelSize * 0.07,
      depth: panelSize * 0.6,
      height: slotHeight,
      cornerRadius: slotRadius,
      orientation: 'vertical',
    },
  ];

  const vanes: CeilingCassetteBoxSpec[] = [];
  for (let vaneIndex = -1; vaneIndex <= 1; vaneIndex += 1) {
    const majorOffset = vaneIndex * panelSize * 0.17;
    vanes.push(
      {
        x: majorOffset,
        y: -panelSize * slotInsetFactor,
        z: vaneZ,
        width: panelSize * 0.16,
        depth: vaneThickness,
        height: vaneHeight,
        cornerRadius: 0,
      },
      {
        x: majorOffset,
        y: panelSize * slotInsetFactor,
        z: vaneZ,
        width: panelSize * 0.16,
        depth: vaneThickness,
        height: vaneHeight,
        cornerRadius: 0,
      },
      {
        x: -panelSize * slotInsetFactor,
        y: majorOffset,
        z: vaneZ,
        width: vaneThickness,
        depth: panelSize * 0.16,
        height: vaneHeight,
        cornerRadius: 0,
      },
      {
        x: panelSize * slotInsetFactor,
        y: majorOffset,
        z: vaneZ,
        width: vaneThickness,
        depth: panelSize * 0.16,
        height: vaneHeight,
        cornerRadius: 0,
      },
    );
  }

  const grilleSize = panelSize * 0.36;
  const slatCount = Math.max(4, Math.min(8, Math.round(5 * grilleDensityFactor)));
  const slatStep = (grilleSize * 0.68) / Math.max(1, slatCount - 1);
  const grille: CeilingCassetteGrilleSpec = {
    x: 0,
    y: 0,
    z: panelHeight * 0.56,
    size: grilleSize,
    frameHeight: Math.max(5, panelHeight * 0.16),
    cornerRadius: panelSize * 0.022,
    slatCount,
    slatSpan: grilleSize * 0.82,
    slatInset: grilleSize * 0.34,
    slatStep,
    horizontalSlatZ: panelHeight * 0.6,
    verticalSlatZ: panelHeight * 0.62,
  };

  const accentBar: CeilingCassetteBoxSpec = {
    x: 0,
    y: panelSize * 0.41,
    z: panelHeight * 0.68,
    width: panelSize * 0.1,
    depth: panelSize * 0.018,
    height: Math.max(4, panelHeight * 0.08),
    cornerRadius: 0,
  };

  const serviceTab: CeilingCassetteBoxSpec = {
    x: 0,
    y: -panelSize * 0.43,
    z: panelHeight * 0.58,
    width: panelSize * 0.14,
    depth: panelSize * 0.035,
    height: Math.max(4, panelHeight * 0.08),
    cornerRadius: 0,
  };

  const connectionPod: CeilingCassetteBoxSpec = {
    x: baseWidth * 0.37,
    y: baseDepth * 0.12,
    z: bodyBaseZ + cassetteBodyHeight * 0.76,
    width: baseWidth * 0.1,
    depth: baseDepth * 0.24,
    height: Math.max(14, cassetteBodyHeight * 0.1),
    cornerRadius: baseDepth * 0.02,
  };

  // Fixed center-to-center spacing: 42mm vertical between gas and liquid ports
  const refrigerantPortCenterSpacing = 42;
  const refrigerantBundleCenterY = Math.max(
    refrigerantPortCenterSpacing / 2 + 6,
    baseDepth * 0.08,
  );
  const gasPortY = refrigerantBundleCenterY - refrigerantPortCenterSpacing / 2;
  const liquidPortY = refrigerantBundleCenterY + refrigerantPortCenterSpacing / 2;

  const gasPortRadius = Math.max(4.5, gasPipeDiameterMm / 2);
  const liquidPortRadius = Math.max(3, liquidPipeDiameterMm / 2);
  const gasPortLength = computeIndoorRefrigerantPortStubLengthMm(
    gasPipeDiameterMm,
  );
  const liquidPortLength = computeIndoorRefrigerantPortStubLengthMm(
    liquidPipeDiameterMm,
  );
  const drainPortRadius = Math.max(5, drainPipeDiameterMm / 2);
  const drainPortLength = computeIndoorDrainPortStubLengthMm(
    drainPipeDiameterMm,
  );

  const pipePorts: CeilingCassettePipePortSpec[] = [
    buildPipePortSpec({
      kind: 'gas',
      x: baseWidth * 0.4,
      y: gasPortY,
      z: bodyBaseZ + cassetteBodyHeight * 0.82,
      radius: gasPortRadius,
      length: gasPortLength,
      bandRadius: Math.max(4, gasPortRadius + 1.5),
      color: '#c5894d',
      collarColor: '#1f2937',
      flangeColor: '#e0c9a8',
      bandColor: '#d4723c',
      bandOffsetX: gasPortLength * 0.7,
    }),
    buildPipePortSpec({
      kind: 'liquid',
      x: baseWidth * 0.4,
      y: liquidPortY,
      z: bodyBaseZ + cassetteBodyHeight * 0.72,
      radius: liquidPortRadius,
      length: liquidPortLength,
      bandRadius: Math.max(4, liquidPortRadius + 1.5),
      color: '#dca25d',
      collarColor: '#1f2937',
      flangeColor: '#e8d4ac',
      bandColor: '#c8962e',
      bandOffsetX: liquidPortLength * 0.7,
    }),
    buildPipePortSpec({
      kind: 'drain',
      x: baseWidth * 0.4,
      y: baseDepth * 0.2,
      z: bodyBaseZ + cassetteBodyHeight * 0.58,
      radius: drainPortRadius,
      length: drainPortLength,
      bandRadius: Math.max(6, drainPortRadius + 2),
      color: '#7eb8d8',
      collarColor: '#4b5563',
      flangeColor: '#b0c4d4',
      bandColor: '#3a8fc2',
      bandOffsetX: drainPortLength * 0.7,
    }),
  ];

  return {
    baseWidth,
    baseDepth,
    panelSize,
    panelHeight,
    cassetteBodyHeight,
    bodyBaseZ,
    grilleDensityFactor,
    slotInsetFactor,
    hiddenBody,
    topCap,
    drainPumpHousing,
    facePanel,
    innerPanel,
    slots,
    vanes,
    grille,
    accentBar,
    serviceTab,
    connectionPod,
    pipePorts,
    panelCentre: { x: 0, y: 0 },
  };
}
