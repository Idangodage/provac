/**
 * Attribute schema binding + validation for wall and room 3D data.
 */

import type { Point2D, Room, Room3D, Wall, Wall3D, WallAssemblyLayer } from '../types';
import {
  DEFAULT_ROOM_3D,
  DEFAULT_WALL_3D,
  MAX_U_VALUE,
  MAX_WALL_HEIGHT,
  MAX_WALL_THICKNESS,
  MIN_U_VALUE,
  MIN_WALL_HEIGHT,
  MIN_WALL_THICKNESS,
} from '../types/wall';

import {
  calculateRecommendedOccupancy,
  calculateVentilationLps,
  compassFromAngle,
  getRoomTemplateById,
  inferTemplateIdFromRoomType,
  orientationAngleFromNorth,
} from './hvac';
import {
  calculateMaterialResistance,
  DEFAULT_ARCHITECTURAL_MATERIALS,
  getArchitecturalMaterial,
  getDefaultMaterialIdForWallMaterial,
} from './material-library';

export interface AttributeValidationIssue {
  field: string;
  message: string;
}

export interface AttributeValidationResult<T> {
  value: T;
  issues: AttributeValidationIssue[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wallLength(startPoint: Point2D, endPoint: Point2D): number {
  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function polygonArea(vertices: Point2D[]): number {
  if (vertices.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const next = (i + 1) % vertices.length;
    const currentPoint = vertices[i];
    const nextPoint = vertices[next];
    area += currentPoint.x * nextPoint.y - nextPoint.x * currentPoint.y;
  }
  return Math.abs(area) * 0.5;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function normalizeThermalAssembly(
  thermalAssembly: WallAssemblyLayer[] | undefined,
  fallbackMaterialId: string,
  fallbackThickness: number
): WallAssemblyLayer[] {
  const safeLayers = Array.isArray(thermalAssembly)
    ? thermalAssembly
      .map((layer, index) => ({
        id: layer.id || `layer-${index}`,
        materialId: layer.materialId || fallbackMaterialId,
        thicknessMm: Math.max(1, Number.isFinite(layer.thicknessMm) ? layer.thicknessMm : fallbackThickness),
        order: Number.isFinite(layer.order) ? layer.order : index,
      }))
      .sort((a, b) => a.order - b.order)
    : [];

  if (safeLayers.length >= 2) return safeLayers;
  return [
    {
      id: 'layer-exterior',
      materialId: fallbackMaterialId,
      thicknessMm: Math.max(1, fallbackThickness),
      order: 0,
    },
    {
      id: 'layer-interior',
      materialId: 'interior-drywall-12-5',
      thicknessMm: 12.5,
      order: 1,
    },
  ];
}

function buildThermalBreakdown(layers: WallAssemblyLayer[]): {
  layers: WallAssemblyLayer[];
  breakdown: Wall3D['thermalBreakdown'];
  resistance: number;
  uValue: number;
} {
  const withResistance = layers.map((layer) => {
    const resistance = calculateMaterialResistance(layer.materialId, layer.thicknessMm);
    return {
      ...layer,
      resistance,
      uValue: resistance > 0.000001 ? 1 / resistance : MAX_U_VALUE,
    };
  });
  const totalResistance = withResistance.reduce((sum, layer) => sum + layer.resistance, 0);
  const totalUValue = totalResistance > 0.000001 ? 1 / totalResistance : MAX_U_VALUE;
  const breakdown = withResistance.map((layer) => ({
    layerId: layer.id,
    materialId: layer.materialId,
    resistance: layer.resistance,
    uValue: layer.uValue,
    percentage: totalResistance > 0.000001 ? (layer.resistance / totalResistance) * 100 : 0,
  }));
  return {
    layers: withResistance.map(({ resistance: _resistance, uValue: _uValue, ...layer }) => layer),
    breakdown,
    resistance: totalResistance,
    uValue: totalUValue,
  };
}

export function bindWallGeometryTo3D(
  wall: Pick<Wall, 'startPoint' | 'endPoint' | 'thickness' | 'material' | 'properties3D'>,
  defaults: Partial<Wall3D> = {}
): AttributeValidationResult<Wall3D> {
  const materialId =
    wall.properties3D?.materialId ??
    defaults.materialId ??
    getDefaultMaterialIdForWallMaterial(wall.material);
  const libraryMaterial = getArchitecturalMaterial(materialId);
  const safeHeight = clamp(
    wall.properties3D?.height ?? defaults.height ?? DEFAULT_WALL_3D.height,
    MIN_WALL_HEIGHT,
    MAX_WALL_HEIGHT
  );
  const safeThickness = clamp(wall.thickness, MIN_WALL_THICKNESS, MAX_WALL_THICKNESS);
  const lengthMm = wallLength(wall.startPoint, wall.endPoint);
  const volumeM3 = (lengthMm * safeThickness * safeHeight) / 1_000_000_000;
  const thermalAssembly = normalizeThermalAssembly(
    wall.properties3D?.thermalAssembly ?? defaults.thermalAssembly,
    materialId,
    safeThickness
  );
  const thermalData = buildThermalBreakdown(thermalAssembly);
  const orientationAngle = orientationAngleFromNorth(wall.startPoint, wall.endPoint);
  const inferredDirection = compassFromAngle(orientationAngle);
  const exposureOverride = wall.properties3D?.exposureOverride ?? defaults.exposureOverride ?? null;
  const shadingFactor = clamp01(
    wall.properties3D?.shadingFactor ?? defaults.shadingFactor ?? DEFAULT_WALL_3D.shadingFactor
  );

  const value: Wall3D = {
    height: safeHeight,
    baseElevation: wall.properties3D?.baseElevation ?? defaults.baseElevation ?? DEFAULT_WALL_3D.baseElevation,
    layerCount: Math.max(
      1,
      Math.round(wall.properties3D?.layerCount ?? defaults.layerCount ?? DEFAULT_WALL_3D.layerCount)
    ),
    materialId,
    thermalResistance: thermalData.resistance > 0 ? thermalData.resistance : (
      wall.properties3D?.thermalResistance ??
      defaults.thermalResistance ??
      libraryMaterial?.thermalResistance ??
      DEFAULT_WALL_3D.thermalResistance
    ),
    overallUValue: clamp(
      thermalData.uValue,
      MIN_U_VALUE,
      MAX_U_VALUE
    ),
    thermalAssembly: thermalData.layers,
    thermalBreakdown: thermalData.breakdown,
    exposureAngleFromNorth: orientationAngle,
    exposureDirection: exposureOverride ?? inferredDirection,
    exposureOverride,
    shadingFactor,
    shadingContext: wall.properties3D?.shadingContext ?? defaults.shadingContext ?? '',
    computedLength: lengthMm,
    computedVolumeM3: volumeM3,
  };

  return validateWall3DAttributes(value);
}

export function bindRoomGeometryTo3D(
  room: Pick<Room, 'vertices' | 'properties3D' | 'area' | 'roomType'>,
  defaults: Partial<Room3D> = {}
): AttributeValidationResult<Room3D> {
  const areaMm2 = room.area > 0 ? room.area : polygonArea(room.vertices);
  const areaM2 = areaMm2 / 1_000_000;
  const ceilingHeight = Math.max(
    MIN_WALL_HEIGHT,
    room.properties3D?.ceilingHeight ?? defaults.ceilingHeight ?? DEFAULT_ROOM_3D.ceilingHeight
  );
  const volumeM3 = (areaMm2 * ceilingHeight) / 1_000_000_000;
  const templateId =
    room.properties3D?.hvacTemplateId ??
    defaults.hvacTemplateId ??
    inferTemplateIdFromRoomType(room.roomType);
  const template = getRoomTemplateById(templateId);
  const resolvedTemplateId = template?.id ?? DEFAULT_ROOM_3D.hvacTemplateId;
  const recommendedOccupancy = calculateRecommendedOccupancy(
    areaM2,
    template ?? getRoomTemplateById(DEFAULT_ROOM_3D.hvacTemplateId)!
  );
  const occupantCount = Math.max(
    0.1,
    room.properties3D?.occupantCount ??
    defaults.occupantCount ??
    recommendedOccupancy
  );
  const outdoorAirPerPersonLps = Math.max(
    0,
    room.properties3D?.outdoorAirPerPersonLps ??
    defaults.outdoorAirPerPersonLps ??
    DEFAULT_ROOM_3D.outdoorAirPerPersonLps
  );
  const outdoorAirPerAreaLpsm2 = Math.max(
    0,
    room.properties3D?.outdoorAirPerAreaLpsm2 ??
    defaults.outdoorAirPerAreaLpsm2 ??
    DEFAULT_ROOM_3D.outdoorAirPerAreaLpsm2
  );
  const lightingLoadWm2 = clamp(
    room.properties3D?.lightingLoadWm2 ??
    defaults.lightingLoadWm2 ??
    template?.lightingWm2 ??
    DEFAULT_ROOM_3D.lightingLoadWm2,
    0,
    100
  );
  const equipmentLoadWm2 = clamp(
    room.properties3D?.equipmentLoadWm2 ??
    defaults.equipmentLoadWm2 ??
    template?.equipmentWm2 ??
    DEFAULT_ROOM_3D.equipmentLoadWm2,
    0,
    100
  );
  const loadBreakdown = {
    occupancyW: occupantCount * 75,
    lightingW: areaM2 * lightingLoadWm2,
    equipmentW: areaM2 * equipmentLoadWm2,
  };
  const sensibleTotalW = loadBreakdown.occupancyW + loadBreakdown.lightingW + loadBreakdown.equipmentW;
  const internalGainDiversityFactor = clamp01(
    room.properties3D?.internalGainDiversityFactor ??
    defaults.internalGainDiversityFactor ??
    DEFAULT_ROOM_3D.internalGainDiversityFactor
  );
  const calculatedCoolingLoadW = sensibleTotalW * (internalGainDiversityFactor > 0 ? internalGainDiversityFactor : 1);
  const calculatedHeatingLoadW = Math.max(0, areaM2 * 35 - sensibleTotalW * 0.3);

  const value: Room3D = {
    ceilingHeight,
    floorElevation: room.properties3D?.floorElevation ?? defaults.floorElevation ?? DEFAULT_ROOM_3D.floorElevation,
    slabThickness: Math.max(
      1,
      room.properties3D?.slabThickness ?? defaults.slabThickness ?? DEFAULT_ROOM_3D.slabThickness
    ),
    materialId: room.properties3D?.materialId ?? defaults.materialId ?? DEFAULT_ROOM_3D.materialId,
    hvacTemplateId: resolvedTemplateId,
    occupantCount,
    occupancySchedule:
      room.properties3D?.occupancySchedule ??
      defaults.occupancySchedule ??
      template?.schedule ??
      DEFAULT_ROOM_3D.occupancySchedule,
    lightingLoadWm2,
    equipmentLoadWm2,
    requiresExhaust:
      room.properties3D?.requiresExhaust ??
      defaults.requiresExhaust ??
      template?.requiresExhaust ??
      DEFAULT_ROOM_3D.requiresExhaust,
    outdoorAirPerPersonLps,
    outdoorAirPerAreaLpsm2,
    ventilationOutdoorAirLps: calculateVentilationLps(
      occupantCount,
      areaM2,
      outdoorAirPerPersonLps,
      outdoorAirPerAreaLpsm2
    ),
    heatingSetpointC:
      room.properties3D?.heatingSetpointC ??
      defaults.heatingSetpointC ??
      DEFAULT_ROOM_3D.heatingSetpointC,
    coolingSetpointC:
      room.properties3D?.coolingSetpointC ??
      defaults.coolingSetpointC ??
      DEFAULT_ROOM_3D.coolingSetpointC,
    internalGainDiversityFactor,
    windowShgc:
      room.properties3D?.windowShgc ??
      defaults.windowShgc ??
      DEFAULT_ROOM_3D.windowShgc,
    calculatedCoolingLoadW,
    calculatedHeatingLoadW,
    loadBreakdown,
    computedAreaM2: areaM2,
    computedVolumeM3: volumeM3,
  };

  return validateRoom3DAttributes(value);
}

export function validateWall3DAttributes(value: Wall3D): AttributeValidationResult<Wall3D> {
  const issues: AttributeValidationIssue[] = [];

  if (!(value.height > 0)) {
    issues.push({ field: 'height', message: 'Wall height must be greater than zero.' });
  }
  if (!(value.layerCount > 0)) {
    issues.push({ field: 'layerCount', message: 'Layer count must be greater than zero.' });
  }
  if (!(value.computedLength >= 0)) {
    issues.push({ field: 'computedLength', message: 'Computed wall length cannot be negative.' });
  }
  if (!(value.computedVolumeM3 >= 0)) {
    issues.push({ field: 'computedVolumeM3', message: 'Computed wall volume cannot be negative.' });
  }
  if (!(value.overallUValue >= MIN_U_VALUE && value.overallUValue <= MAX_U_VALUE)) {
    issues.push({ field: 'overallUValue', message: `Wall U-value must be between ${MIN_U_VALUE} and ${MAX_U_VALUE} W/(m2.K).` });
  }
  if (!Array.isArray(value.thermalAssembly) || value.thermalAssembly.length < 2) {
    issues.push({ field: 'thermalAssembly', message: 'Wall assembly must include at least 2 layers.' });
  }
  if (!getArchitecturalMaterial(value.materialId)) {
    issues.push({ field: 'materialId', message: 'Wall material id is not found in library.' });
  }

  const clamped: Wall3D = {
    ...value,
    height: clamp(value.height, MIN_WALL_HEIGHT, MAX_WALL_HEIGHT),
    layerCount: Math.max(1, Math.round(value.layerCount)),
    overallUValue: clamp(value.overallUValue, MIN_U_VALUE, MAX_U_VALUE),
    shadingFactor: clamp01(value.shadingFactor),
    computedLength: Math.max(0, value.computedLength),
    computedVolumeM3: Math.max(0, value.computedVolumeM3),
  };

  return { value: clamped, issues };
}

export function validateRoom3DAttributes(value: Room3D): AttributeValidationResult<Room3D> {
  const issues: AttributeValidationIssue[] = [];

  if (!(value.ceilingHeight > 0)) {
    issues.push({ field: 'ceilingHeight', message: 'Room height must be greater than zero.' });
  }
  if (!(value.slabThickness > 0)) {
    issues.push({ field: 'slabThickness', message: 'Slab thickness must be greater than zero.' });
  }
  if (!(value.computedAreaM2 >= 0)) {
    issues.push({ field: 'computedAreaM2', message: 'Computed room area cannot be negative.' });
  }
  if (!(value.computedVolumeM3 >= 0)) {
    issues.push({ field: 'computedVolumeM3', message: 'Computed room volume cannot be negative.' });
  }
  if (!(value.occupantCount > 0)) {
    issues.push({ field: 'occupantCount', message: 'Room occupancy must be greater than zero.' });
  }
  if (!(value.heatingSetpointC < value.coolingSetpointC)) {
    issues.push({ field: 'setpoints', message: 'Heating setpoint must be below cooling setpoint.' });
  }
  if (value.lightingLoadWm2 < 0 || value.lightingLoadWm2 > 100) {
    issues.push({ field: 'lightingLoadWm2', message: 'Lighting load must be between 0 and 100 W/m2.' });
  }
  if (value.equipmentLoadWm2 < 0 || value.equipmentLoadWm2 > 100) {
    issues.push({ field: 'equipmentLoadWm2', message: 'Equipment load must be between 0 and 100 W/m2.' });
  }
  if (!getArchitecturalMaterial(value.materialId)) {
    issues.push({ field: 'materialId', message: 'Room material id is not found in library.' });
  }

  const clamped: Room3D = {
    ...value,
    ceilingHeight: Math.max(MIN_WALL_HEIGHT, value.ceilingHeight),
    slabThickness: Math.max(1, value.slabThickness),
    occupantCount: Math.max(0.1, value.occupantCount),
    lightingLoadWm2: clamp(value.lightingLoadWm2, 0, 100),
    equipmentLoadWm2: clamp(value.equipmentLoadWm2, 0, 100),
    internalGainDiversityFactor: clamp01(value.internalGainDiversityFactor),
    windowShgc: clamp01(value.windowShgc),
    heatingSetpointC: Math.min(value.heatingSetpointC, value.coolingSetpointC - 0.5),
    coolingSetpointC: Math.max(value.coolingSetpointC, value.heatingSetpointC + 0.5),
    computedAreaM2: Math.max(0, value.computedAreaM2),
    computedVolumeM3: Math.max(0, value.computedVolumeM3),
  };

  return { value: clamped, issues };
}

export function getMaterialLibraryIds(): string[] {
  return DEFAULT_ARCHITECTURAL_MATERIALS.map((material) => material.id);
}
