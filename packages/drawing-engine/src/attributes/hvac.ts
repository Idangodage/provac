/**
 * HVAC templates and helper calculations for future load engines.
 */

import type {
  CompassDirection,
  HvacDesignConditions,
  Point2D,
  RoomOccupancySchedule,
  RoomType,
} from '../types';

export interface RoomHvacTemplate {
  id: string;
  roomType: RoomType;
  occupantsBase: number;
  occupantsPer10m2: number;
  lightingWm2: number;
  equipmentWm2: number;
  requiresExhaust: boolean;
  schedule: RoomOccupancySchedule;
}

export const DEFAULT_HVAC_DESIGN_CONDITIONS: HvacDesignConditions = {
  location: 'New York',
  country: 'USA',
  summerDryBulbC: 35,
  summerWetBulbC: 24,
  winterDryBulbC: -5,
  groundTemperatureC: 13,
  altitudeM: 10,
  peakCoolingMonth: 'July',
  peakCoolingHour: 15,
  peakHeatingCondition: '99% Winter Design',
  internalGainDiversityFactor: 0.9,
  defaultWindowShgc: 0.35,
  seasonalVariation: {
    summerAdjustment: 1,
    winterAdjustment: 1,
  },
};

export const DEFAULT_ROOM_HVAC_TEMPLATES: RoomHvacTemplate[] = [
  {
    id: 'template-bedroom',
    roomType: 'Bedroom',
    occupantsBase: 2,
    occupantsPer10m2: 0,
    lightingWm2: 10,
    equipmentWm2: 5,
    requiresExhaust: false,
    schedule: 'evening',
  },
  {
    id: 'template-living-room',
    roomType: 'Living Room',
    occupantsBase: 4,
    occupantsPer10m2: 0,
    lightingWm2: 15,
    equipmentWm2: 10,
    requiresExhaust: false,
    schedule: 'evening',
  },
  {
    id: 'template-kitchen',
    roomType: 'Custom',
    occupantsBase: 2,
    occupantsPer10m2: 0,
    lightingWm2: 20,
    equipmentWm2: 30,
    requiresExhaust: true,
    schedule: 'daytime',
  },
  {
    id: 'template-bathroom',
    roomType: 'Bathroom/Closet',
    occupantsBase: 1,
    occupantsPer10m2: 0,
    lightingWm2: 15,
    equipmentWm2: 3,
    requiresExhaust: true,
    schedule: 'daytime',
  },
  {
    id: 'template-office',
    roomType: 'Custom',
    occupantsBase: 1,
    occupantsPer10m2: 1.5,
    lightingWm2: 12,
    equipmentWm2: 15,
    requiresExhaust: false,
    schedule: 'daytime',
  },
];

const TEMPLATE_BY_ID = new Map(DEFAULT_ROOM_HVAC_TEMPLATES.map((template) => [template.id, template]));

export function getRoomTemplateById(templateId: string): RoomHvacTemplate | undefined {
  return TEMPLATE_BY_ID.get(templateId);
}

export function inferTemplateIdFromRoomType(roomType: RoomType): string {
  if (roomType === 'Bedroom') return 'template-bedroom';
  if (roomType === 'Living Room') return 'template-living-room';
  if (roomType === 'Bathroom/Closet') return 'template-bathroom';
  return 'template-office';
}

export function calculateRecommendedOccupancy(
  areaM2: number,
  template: RoomHvacTemplate
): number {
  const base = Math.max(0, template.occupantsBase);
  const density = Math.max(0, template.occupantsPer10m2);
  const fromDensity = density > 0 ? (areaM2 / 10) * density : 0;
  const calculated = Math.max(base, fromDensity);
  return Math.max(1, Math.round(calculated * 10) / 10);
}

export function calculateVentilationLps(
  occupants: number,
  areaM2: number,
  occupantRateLps: number = 7.5,
  areaRateLpsm2: number = 0.3
): number {
  const occupantComponent = Math.max(0, occupants) * Math.max(0, occupantRateLps);
  const areaComponent = Math.max(0, areaM2) * Math.max(0, areaRateLpsm2);
  return occupantComponent + areaComponent;
}

export function orientationAngleFromNorth(start: Point2D, end: Point2D): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const angleFromEast = (Math.atan2(dy, dx) * 180) / Math.PI;
  const angleFromNorth = (90 - angleFromEast + 360) % 360;
  return angleFromNorth;
}

export function compassFromAngle(angleFromNorth: number): CompassDirection {
  const normalized = ((angleFromNorth % 360) + 360) % 360;
  if (normalized >= 337.5 || normalized < 22.5) return 'N';
  if (normalized < 67.5) return 'NE';
  if (normalized < 112.5) return 'E';
  if (normalized < 157.5) return 'SE';
  if (normalized < 202.5) return 'S';
  if (normalized < 247.5) return 'SW';
  if (normalized < 292.5) return 'W';
  return 'NW';
}

function channelToHex(value: number): string {
  const safe = Math.max(0, Math.min(255, Math.round(value)));
  return safe.toString(16).padStart(2, '0');
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function heatColorFromUValue(uValue: number): string {
  const clamped = Math.max(0.1, Math.min(10, uValue));
  const normalized = (clamped - 0.1) / (10 - 0.1);
  const cool = { r: 49, g: 130, b: 206 }; // blue
  const warm = { r: 220, g: 38, b: 38 }; // red
  return `#${channelToHex(lerp(cool.r, warm.r, normalized))}${channelToHex(
    lerp(cool.g, warm.g, normalized)
  )}${channelToHex(lerp(cool.b, warm.b, normalized))}`;
}

export function colorFromExposure(direction: CompassDirection): string {
  switch (direction) {
    case 'N':
      return '#60A5FA';
    case 'NE':
      return '#38BDF8';
    case 'E':
      return '#22D3EE';
    case 'SE':
      return '#FACC15';
    case 'S':
      return '#F97316';
    case 'SW':
      return '#FB7185';
    case 'W':
      return '#A78BFA';
    case 'NW':
    default:
      return '#818CF8';
  }
}
