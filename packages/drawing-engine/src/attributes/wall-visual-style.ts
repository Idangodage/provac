/**
 * Canonical wall graphics shared by plan, hybrid 2D/3D and isometric views.
 *
 * Professional BIM applications keep one material identity while exposing
 * view-appropriate graphics: a drafting cut fill in plan and a restrained
 * shaded surface in 3D. Renderers must consume this resolver rather than
 * inventing their own wall palettes.
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
  /** View-space tile size keeps the cut fill legible and avoids visual noise. */
  patternTilePx: number;
}

export interface WallSurfaceVisual {
  /** Canonical material color used by every shaded 3D wall renderer. */
  color: string;
  /** Slight lift for upward faces; lighting still provides the main shading. */
  topColor: string;
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
  modelColor: '#46515f',
  planWidthPx: 1.7,
  centerLineColor: '#718096',
  centerLineWidthPx: 0.85,
  modelOpacity: 0.72,
});

type FamilyVisual = Pick<
  WallSurfaceVisual,
  'pattern' | 'repeatMm' | 'roughness' | 'metalness' | 'patternOpacity'
> & {
  patternTilePx: number;
};

const FAMILY_VISUALS: Record<MaterialFamily, FamilyVisual> = {
  masonry: {
    pattern: 'running-bond',
    patternTilePx: 18,
    repeatMm: 400,
    roughness: 0.9,
    metalness: 0,
    patternOpacity: 0.16,
  },
  concrete: {
    pattern: 'aggregate',
    patternTilePx: 16,
    repeatMm: 520,
    roughness: 0.97,
    metalness: 0,
    patternOpacity: 0.11,
  },
  wood: {
    pattern: 'wood-grain',
    patternTilePx: 20,
    repeatMm: 260,
    roughness: 0.8,
    metalness: 0,
    patternOpacity: 0.13,
  },
  metal: {
    pattern: 'crosshatch',
    patternTilePx: 14,
    repeatMm: 180,
    roughness: 0.42,
    metalness: 0.68,
    patternOpacity: 0.1,
  },
  insulation: {
    pattern: 'insulation',
    patternTilePx: 20,
    repeatMm: 360,
    roughness: 0.99,
    metalness: 0,
    patternOpacity: 0.1,
  },
  finish: {
    pattern: 'diagonal',
    patternTilePx: 16,
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

  return {
    key: `${resolved.materialId}|${baseColor}|${family.pattern}`,
    materialId: resolved.materialId,
    materialName: resolved.name,
    family: resolved.family,
    baseColor,
    plan: {
      // Plan is a cut graphic, not a photographic texture. Retain the hue but
      // lift the value so annotations and openings stay highly legible.
      fillColor: mixHexColor(baseColor, '#ffffff', 0.58),
      patternColor: mixHexColor(baseColor, '#172033', 0.48),
      pattern: family.pattern,
      patternTilePx: family.patternTilePx,
    },
    surface: {
      color: mixHexColor(baseColor, '#ffffff', 0.05),
      topColor: mixHexColor(baseColor, '#ffffff', 0.2),
      pattern: family.pattern,
      repeatMm: family.repeatMm,
      roughness: family.roughness,
      metalness: family.metalness,
      patternOpacity: family.patternOpacity,
    },
    edges: PROFESSIONAL_WALL_EDGES,
  };
}

export function wallVisualStyleKey(
  wall: Pick<Wall, 'material' | 'properties3D'>
): string {
  return resolveWallVisualStyle(wall).key;
}
