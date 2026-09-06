/**
 * Canonical wall graphics shared by plan, hybrid 2D/3D and isometric views.
 *
 * Plan and the horizontal 3D wall caps share one material appearance and
 * physical pattern repeat. Vertical faces add lighting to that same color.
 */

import type { Wall } from '../types';

import {
  getDefaultMaterialIdForWallMaterial,
  getArchitecturalMaterial,
  type MaterialFamily,
} from './material-library';

export type WallPatternKind =
  | 'running-bond'
  | 'aggregate'
  | 'wood-grain'
  | 'diagonal'
  | 'crosshatch'
  | 'insulation';

export interface WallPlanVisual {
  /** Restrained background for the cut body. */
  fillColor: string;
  /** Drafting-pattern foreground, derived from the canonical material color. */
  patternColor: string;
  pattern: WallPatternKind;
  /** Raster resolution only; repeatMm controls the actual drawing scale. */
  patternTilePx: number;
  repeatMm: number;
  patternOpacity: number;
}

export interface WallSurfaceVisual {
  /** Canonical material color used by every shaded 3D wall renderer. */
  color: string;
  /** Same albedo as plan; upward faces do not receive a second color tint. */
  topColor: string;
  patternColor: string;
  pattern: WallPatternKind;
  /** Real-world texture repeat so orbiting/zooming never changes its scale. */
  repeatMm: number;
  roughness: number;
  metalness: number;
  patternOpacity: number;
}

export interface WallEdgeVisual {
  planColor: string;
  modelColor: string;
  planWidthPx: number;
  modelWidthPx: number;
  centerLineColor: string;
  centerLineWidthPx: number;
  modelOpacity: number;
}

export interface WallVisualStyle {
  key: string;
  materialId: string;
  materialName: string;
  family: MaterialFamily;
  baseColor: string;
  plan: WallPlanVisual;
  surface: WallSurfaceVisual;
  edges: WallEdgeVisual;
}

export const PROFESSIONAL_WALL_EDGES: WallEdgeVisual = Object.freeze({
  planColor: '#26323f',
  modelColor: '#26323f',
  planWidthPx: 1.7,
  modelWidthPx: 1.7,
  centerLineColor: '#718096',
  centerLineWidthPx: 0.85,
  modelOpacity: 1,
});

type FamilyVisual = Pick<
  WallSurfaceVisual,
  'pattern' | 'repeatMm' | 'roughness' | 'metalness' | 'patternOpacity'
>;

const FAMILY_VISUALS: Record<MaterialFamily, FamilyVisual> = {
  masonry: {
    pattern: 'running-bond',
    repeatMm: 400,
    roughness: 0.9,
    metalness: 0,
    patternOpacity: 0.16,
  },
  concrete: {
    pattern: 'aggregate',
    repeatMm: 520,
    roughness: 0.97,
    metalness: 0,
    patternOpacity: 0.11,
  },
  wood: {
    pattern: 'wood-grain',
    repeatMm: 260,
    roughness: 0.8,
    metalness: 0,
    patternOpacity: 0.13,
  },
  metal: {
    pattern: 'crosshatch',
    repeatMm: 180,
    roughness: 0.42,
    metalness: 0.68,
    patternOpacity: 0.1,
  },
  insulation: {
    pattern: 'insulation',
    repeatMm: 360,
    roughness: 0.99,
    metalness: 0,
    patternOpacity: 0.1,
  },
  finish: {
    pattern: 'diagonal',
    repeatMm: 240,
    roughness: 0.94,
    metalness: 0,
    patternOpacity: 0.075,
  },
};

const LEGACY_MATERIAL_FALLBACKS: Record<
  Wall['material'],
  { name: string; family: MaterialFamily; color: string }
> = {
  brick: { name: 'Brick', family: 'masonry', color: '#9e6a5e' },
  concrete: { name: 'Concrete', family: 'concrete', color: '#8b9096' },
  partition: { name: 'Partition', family: 'finish', color: '#c7c2b3' },
};

function normalizeHexColor(value: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

function mixHexColor(from: string, to: string, amount: number): string {
  const fromHex = normalizeHexColor(from) ?? '#94a3b8';
  const toHex = normalizeHexColor(to) ?? '#ffffff';
  const blend = Math.min(1, Math.max(0, amount));
  const channel = (hex: string, offset: number): number =>
    Number.parseInt(hex.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) =>
    Math.round(channel(fromHex, offset) + (channel(toHex, offset) - channel(fromHex, offset)) * blend)
      .toString(16)
      .padStart(2, '0')
  );
  return `#${mixed.join('')}`;
}

function resolveMaterial(materialId: string, legacyMaterial: Wall['material']): {
  materialId: string;
  name: string;
  family: MaterialFamily;
  color: string;
} {
  const material = getArchitecturalMaterial(materialId) ?? null;
  if (material) {
    return {
      materialId: material.id,
      name: material.name,
      family: material.family,
      color: normalizeHexColor(material.color) ?? '#94a3b8',
    };
  }

  const fallback = LEGACY_MATERIAL_FALLBACKS[legacyMaterial];
  return {
    materialId: `legacy-${legacyMaterial}`,
    name: fallback.name,
    family: fallback.family,
    color: fallback.color,
  };
}

export function resolveWallVisualStyle(
  wall: Pick<Wall, 'material' | 'properties3D'>
): WallVisualStyle {
  return resolveWallVisualStyleForMaterial(wall.material, wall.properties3D.materialId);
}

export function resolveWallVisualStyleForMaterial(
  legacyMaterial: Wall['material'],
  materialId = getDefaultMaterialIdForWallMaterial(legacyMaterial)
): WallVisualStyle {
  const resolved = resolveMaterial(materialId, legacyMaterial);
  const family = FAMILY_VISUALS[resolved.family];
  const baseColor = resolved.color;
  const displayColor = mixHexColor(baseColor, '#ffffff', 0.58);
  const patternColor = mixHexColor(baseColor, '#172033', 0.48);
  const patternOpacity = Math.min(0.55, family.patternOpacity * 3);

  return {
    key: `${resolved.materialId}|${displayColor}|${patternColor}|${family.pattern}|${family.repeatMm}|${patternOpacity}`,
    materialId: resolved.materialId,
    materialName: resolved.name,
    family: resolved.family,
    baseColor,
    plan: {
      fillColor: displayColor,
      patternColor,
      pattern: family.pattern,
      patternTilePx: 96,
      repeatMm: family.repeatMm,
      patternOpacity,
    },
    surface: {
      color: displayColor,
      topColor: displayColor,
      patternColor,
      pattern: family.pattern,
      repeatMm: family.repeatMm,
      roughness: family.roughness,
      metalness: family.metalness,
      patternOpacity,
    },
    edges: PROFESSIONAL_WALL_EDGES,
  };
}

export function wallVisualStyleKey(
  wall: Pick<Wall, 'material' | 'properties3D'>
): string {
  return resolveWallVisualStyle(wall).key;
}
