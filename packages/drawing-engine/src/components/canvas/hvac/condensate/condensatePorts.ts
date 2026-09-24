/**
 * Indoor-unit drain ports in model (world) space.
 *
 * Cassette and ducted units draw a real drain port; the world tip uses exactly
 * the endpoint formula the plan and 3D renderers use for that port
 * (x + collarLength + length − 0.15·flange), rotated about the unit centre, so
 * the generated pipe starts on the visible stub. Wall-mounted, split and
 * ceiling-suspended units have no drawn drain port — theirs is synthesised
 * from typical manufacturer positions and marked `synthesized`.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { buildCeilingCassetteModel, getCeilingCassettePipePortEndpointLocal } from '../ceilingCassetteModel';
import { buildDuctedIndoorUnitModel } from '../ductedIndoorUnitModel';

import type { CondensateDesignSettings } from './condensateSettings';

export const CONDENSATE_INDOOR_UNIT_TYPES: ReadonlySet<HvacElement['type']> = new Set<HvacElement['type']>([
  'ceiling-cassette-ac',
  'ducted-ac',
  'wall-mounted-ac',
  'split-ac',
  'ceiling-suspended-ac',
]);

export interface IndoorDrainPort {
  unitId: string;
  unitType: HvacElement['type'];
  label: string;
  /** Plan position of the drain stub tip (where the field pipe starts). */
  point: Point2D;
  /** Unit outflow direction in plan (unit vector). */
  direction: Point2D;
  /** Drain outlet centreline elevation (mm above FFL). */
  z: number;
  outletOuterDiameterMm: number;
  hasDrainPump: boolean;
  pumpMaxLiftMm: number;
  /** Draw-through fan: the drain pan is below atmospheric pressure. */
  negativePressure: boolean;
  externalStaticPressurePa: number | null;
  capacityKw: number;
  /** Plan AABB of the unit body. */
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number };
  bodyBottomZ: number;
  bodyTopZ: number;
  synthesized: boolean;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readFlexibleNumber(properties: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = properties[key];
    if (finite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readBoolean(properties: Record<string, unknown>, key: string): boolean | null {
  const value = properties[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'yes') return true;
  if (value === 'false' || value === 'no') return false;
  return null;
}

function rotate(point: Point2D, angleDeg: number): Point2D {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function unitCenter(element: Pick<HvacElement, 'position' | 'width' | 'depth'>): Point2D {
  return { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
}

export function unitFootprintBoundsMm(
  element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'rotation'>,
): IndoorDrainPort['boundsMm'] {
  const center = unitCenter(element);
  const hw = element.width / 2;
  const hd = element.depth / 2;
  const corners = [
    { x: -hw, y: -hd }, { x: hw, y: -hd }, { x: hw, y: hd }, { x: -hw, y: hd },
  ].map((corner) => {
    const rotated = rotate(corner, element.rotation ?? 0);
    return { x: center.x + rotated.x, y: center.y + rotated.y };
  });
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    maxY: Math.max(...corners.map((corner) => corner.y)),
  };
}

interface LocalDrainPort {
  tip: Point2D;
  localZ: number;
  outletOuterDiameterMm: number;
  synthesized: boolean;
}

function localDrainPort(element: HvacElement): LocalDrainPort | null {
  const properties = element.properties ?? {};
  const outletOverride = readFlexibleNumber(properties, ['drainOutletDiameterMm', 'drainPipeDiameter1Mm', 'Drain Pipe Diameter 1 (mm)']);
  switch (element.type) {
    case 'ceiling-cassette-ac': {
      const port = buildCeilingCassetteModel(element).pipePorts.find((candidate) => candidate.kind === 'drain');
      if (!port) return null;
      return {
        tip: getCeilingCassettePipePortEndpointLocal(port),
        localZ: port.z,
        outletOuterDiameterMm: outletOverride ?? port.radius * 2,
        synthesized: false,
      };
    }
    case 'ducted-ac': {
      const port = buildDuctedIndoorUnitModel(element).pipePorts.find((candidate) => candidate.kind === 'drain');
      if (!port) return null;
      return {
        tip: { x: port.x + port.collarLength + port.length - port.flangeThickness * 0.15, y: port.y },
        localZ: port.z,
        outletOuterDiameterMm: outletOverride ?? port.radius * 2,
        synthesized: false,
      };
    }
    case 'wall-mounted-ac':
    case 'split-ac': {
      // Drain hose leaves the rear-bottom on the piping side, below the service valves.
      const height = finite(element.height) ? element.height : 320;
      return {
        tip: { x: element.width * 0.38 + 60, y: 48 },
        localZ: height * 0.1,
        outletOuterDiameterMm: outletOverride ?? 21.5,
        synthesized: true,
      };
    }
    case 'ceiling-suspended-ac': {
      const height = finite(element.height) ? element.height : 235;
      return {
        tip: { x: element.width * 0.4 + 60, y: 60 },
        localZ: height * 0.35,
        outletOuterDiameterMm: outletOverride ?? 26,
        synthesized: true,
      };
    }
    default:
      return null;
  }
}

/** True when the unit type ships with an integral drain pump by default. */
function defaultHasDrainPump(type: HvacElement['type']): boolean {
  return type === 'ceiling-cassette-ac';
}

export function getIndoorUnitDrainPort(
  element: HvacElement,
  settings?: Pick<CondensateDesignSettings, 'defaultPumpMaxLiftMm'>,
): IndoorDrainPort | null {
  if (!CONDENSATE_INDOOR_UNIT_TYPES.has(element.type)) return null;
  const local = localDrainPort(element);
  if (!local) return null;
  const properties = element.properties ?? {};
  const rotation = element.rotation ?? 0;
  const center = unitCenter(element);
  const tipOffset = rotate(local.tip, rotation);
  const direction = rotate({ x: 1, y: 0 }, rotation);
  const hasDrainPump = readBoolean(properties, 'hasDrainPump') ?? defaultHasDrainPump(element.type);
  const esp = readFlexibleNumber(properties, ['externalStaticPressurePa', 'staticPressurePa', 'espPa', 'External Static Pressure (Pa)']);
  const negativePressure = readBoolean(properties, 'drainNegativePressure')
    ?? (element.type === 'ducted-ac' && !hasDrainPump);
  const elevation = finite(element.elevation) ? element.elevation : 0;
  return {
    unitId: element.id,
    unitType: element.type,
    label: element.label || element.modelLabel || element.id,
    point: { x: center.x + tipOffset.x, y: center.y + tipOffset.y },
    direction,
    z: elevation + local.localZ,
    outletOuterDiameterMm: Math.max(10, local.outletOuterDiameterMm),
    hasDrainPump,
    pumpMaxLiftMm: hasDrainPump
      ? Math.max(0, readFlexibleNumber(properties, ['drainPumpMaxLiftMm', 'Drain Pump Head (mm)']) ?? settings?.defaultPumpMaxLiftMm ?? 600)
      : 0,
    negativePressure,
    externalStaticPressurePa: esp,
    capacityKw: Math.max(0, readFlexibleNumber(properties, ['capacityKw', 'coolingCapacityKw', 'Cooling Capacity (kW)']) ?? 0),
    boundsMm: unitFootprintBoundsMm(element),
    bodyBottomZ: elevation,
    bodyTopZ: elevation + (finite(element.height) ? element.height : 0),
    synthesized: local.synthesized,
  };
}

export function getIndoorUnitDrainPorts(
  elements: readonly HvacElement[],
  settings?: Pick<CondensateDesignSettings, 'defaultPumpMaxLiftMm'>,
): IndoorDrainPort[] {
  const ports: IndoorDrainPort[] = [];
  for (const element of elements) {
    const port = getIndoorUnitDrainPort(element, settings);
    if (port) ports.push(port);
  }
  return ports;
}
