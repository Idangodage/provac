/**
 * Default architectural material library with thermal properties.
 */

import type { WallMaterial } from '../types';

export type MaterialFamily =
  | 'masonry'
  | 'concrete'
  | 'wood'
  | 'metal'
  | 'insulation'
  | 'finish';

export type MaterialApplication = 'exterior' | 'interior' | 'insulation' | 'generic';

export interface ArchitecturalMaterial {
  id: string;
  name: string;
  family: MaterialFamily;
  application: MaterialApplication;
  defaultThicknessMm: number;
  thermalConductivity: number; // W/(m.K)
  density: number; // kg/m3
  specificHeat: number; // J/(kg.K)
  costPerUnit: number; // default cost basis per m2
  costUnit: 'm2' | 'm3' | 'kg';
  thermalResistance: number;
  uValue: number;
  color: string;
  wallMaterial: WallMaterial;
}

export const DEFAULT_ARCHITECTURAL_MATERIALS: ArchitecturalMaterial[] = [
  {
    id: 'exterior-brick-200',
    name: 'Brick',
    family: 'masonry',
    application: 'exterior',
    defaultThicknessMm: 200,
    thermalConductivity: 0.25,
    density: 1800,
    specificHeat: 840,
    costPerUnit: 48,
    costUnit: 'm2',
    thermalResistance: 0.8,
    uValue: 1.25,
    color: '#9E6A5E',
    wallMaterial: 'brick',
  },
  {
    id: 'exterior-concrete-150',
    name: 'Concrete',
    family: 'concrete',
    application: 'exterior',
    defaultThicknessMm: 150,
    thermalConductivity: 1.0,
    density: 2350,
    specificHeat: 880,
    costPerUnit: 42,
    costUnit: 'm2',
    thermalResistance: 0.15,
    uValue: 6.67,
    color: '#8B9096',
    wallMaterial: 'concrete',
  },
  {
    id: 'exterior-wood-siding-25',
    name: 'Wood Siding',
    family: 'wood',
    application: 'exterior',
    defaultThicknessMm: 25,
    thermalConductivity: 0.028,
    density: 530,
    specificHeat: 1600,
    costPerUnit: 34,
    costUnit: 'm2',
    thermalResistance: 0.9,
    uValue: 1.11,
    color: '#B68457',
    wallMaterial: 'partition',
  },
  {
    id: 'interior-drywall-12-5',
    name: 'Drywall',
    family: 'finish',
    application: 'interior',
    defaultThicknessMm: 12.5,
    thermalConductivity: 0.0278,
    density: 800,
    specificHeat: 1090,
    costPerUnit: 12,
    costUnit: 'm2',
    thermalResistance: 0.45,
    uValue: 2.22,
    color: '#C7C2B3',
    wallMaterial: 'partition',
  },
  {
    id: 'interior-plaster-15',
    name: 'Plaster',
    family: 'finish',
    application: 'interior',
    defaultThicknessMm: 15,
    thermalConductivity: 0.05,
    density: 950,
    specificHeat: 1000,
    costPerUnit: 16,
    costUnit: 'm2',
    thermalResistance: 0.3,
    uValue: 3.33,
    color: '#D8D2C5',
    wallMaterial: 'partition',
  },
  {
    id: 'insulation-fiberglass-100',
    name: 'Fiberglass Batt',
    family: 'insulation',
    application: 'insulation',
    defaultThicknessMm: 100,
    thermalConductivity: 0.0286,
    density: 24,
    specificHeat: 840,
    costPerUnit: 9,
    costUnit: 'm2',
    thermalResistance: 3.5,
    uValue: 0.29,
    color: '#E3D56B',
    wallMaterial: 'partition',
  },
  {
    id: 'insulation-rigid-foam-50',
    name: 'Rigid Foam',
    family: 'insulation',
    application: 'insulation',
    defaultThicknessMm: 50,
    thermalConductivity: 0.0167,
    density: 32,
    specificHeat: 1400,
    costPerUnit: 13,
    costUnit: 'm2',
    thermalResistance: 3.0,
    uValue: 0.33,
    color: '#6CB5E7',
    wallMaterial: 'partition',
  },
  {
    id: 'insulation-spray-foam-75',
    name: 'Spray Foam',
    family: 'insulation',
    application: 'insulation',
    defaultThicknessMm: 75,
    thermalConductivity: 0.0167,
    density: 35,
    specificHeat: 1400,
    costPerUnit: 21,
    costUnit: 'm2',
    thermalResistance: 4.5,
    uValue: 0.22,
    color: '#8EC5F1',
    wallMaterial: 'partition',
  },
  {
    id: 'interior-steel-stud-90',
    name: 'Steel Stud',
    family: 'metal',
    application: 'interior',
    defaultThicknessMm: 90,
    thermalConductivity: 50,
    density: 7850,
    specificHeat: 490,
    costPerUnit: 22,
    costUnit: 'm2',
    thermalResistance: 0.05,
    uValue: 20,
    color: '#A3AAB5',
    wallMaterial: 'partition',
  },
  {
    id: 'interior-wood-stud-100',
    name: 'Wood Stud',
    family: 'wood',
    application: 'interior',
    defaultThicknessMm: 100,
    thermalConductivity: 0.0286,
    density: 560,
    specificHeat: 1600,
    costPerUnit: 18,
    costUnit: 'm2',
    thermalResistance: 3.5,
    uValue: 0.29,
    color: '#B78458',
    wallMaterial: 'partition',
  },
];

const MATERIAL_BY_ID = new Map(DEFAULT_ARCHITECTURAL_MATERIALS.map((material) => [material.id, material]));

export function getArchitecturalMaterial(materialId: string): ArchitecturalMaterial | undefined {
  return MATERIAL_BY_ID.get(materialId);
}

export function resolveWallMaterialFromLibrary(materialId: string): WallMaterial {
  return getArchitecturalMaterial(materialId)?.wallMaterial ?? 'partition';
}

export function getDefaultMaterialIdForWallMaterial(wallMaterial: WallMaterial): string {
  switch (wallMaterial) {
    case 'brick':
      return 'exterior-brick-200';
    case 'concrete':
      return 'exterior-concrete-150';
    case 'partition':
    default:
      return 'interior-wood-stud-100';
  }
}

export function calculateMaterialResistance(
  materialId: string,
  thicknessMm: number
): number {
  const material = getArchitecturalMaterial(materialId);
  if (!material) return 0;
  const thicknessM = Math.max(0, thicknessMm) / 1000;
  const k = Math.max(0.0001, material.thermalConductivity);
  return thicknessM / k;
}

export function calculateMaterialUValue(
  materialId: string,
  thicknessMm: number
): number {
  const resistance = calculateMaterialResistance(materialId, thicknessMm);
  if (resistance <= 0.000001) return 10;
  return 1 / resistance;
}
