import { describe, expect, it } from 'vitest';

import { DEFAULT_WALL_3D, type Wall } from '../types';

import { DEFAULT_ARCHITECTURAL_MATERIALS } from './material-library';
import {
  PROFESSIONAL_WALL_EDGES,
  resolveWallVisualStyle,
} from './wall-visual-style';

function wallSource(
  materialId: string,
  material: Wall['material'] = 'partition'
): Pick<Wall, 'material' | 'properties3D'> {
  return {
    material,
    properties3D: { ...DEFAULT_WALL_3D, materialId },
  };
}

describe('canonical wall visual style', () => {
  it('treats detailed materialId as authoritative over the legacy wall enum', () => {
    const style = resolveWallVisualStyle(
      wallSource('exterior-wood-siding-25', 'partition')
    );

    expect(style.materialId).toBe('exterior-wood-siding-25');
    expect(style.family).toBe('wood');
    expect(style.baseColor).toBe('#b68457');
    expect(style.plan.pattern).toBe('wood-grain');
    expect(style.surface.pattern).toBe('wood-grain');
  });

  it('keeps every library material visually addressable, including partition variants', () => {
    const styles = DEFAULT_ARCHITECTURAL_MATERIALS.map((material) =>
      resolveWallVisualStyle(wallSource(material.id, material.wallMaterial))
    );

    expect(new Set(styles.map((style) => style.key)).size).toBe(
      DEFAULT_ARCHITECTURAL_MATERIALS.length
    );
    styles.forEach((style, index) => {
      expect(style.materialId).toBe(DEFAULT_ARCHITECTURAL_MATERIALS[index]!.id);
      expect(style.baseColor).toBe(DEFAULT_ARCHITECTURAL_MATERIALS[index]!.color.toLowerCase());
    });
  });

  it('uses coordinated drafting and model motifs without the old gray brick override', () => {
    const style = resolveWallVisualStyle(wallSource('exterior-brick-200', 'brick'));

    expect(style.baseColor).toBe('#9e6a5e');
    expect(style.plan.fillColor).not.toBe('#b0b0b0');
    expect(style.plan.pattern).toBe('running-bond');
    expect(style.surface.pattern).toBe(style.plan.pattern);
    expect(style.surface.repeatMm).toBeGreaterThan(0);
  });

  it('shares one restrained edge hierarchy across every material', () => {
    DEFAULT_ARCHITECTURAL_MATERIALS.forEach((material) => {
      const style = resolveWallVisualStyle(wallSource(material.id, material.wallMaterial));
      expect(style.edges).toBe(PROFESSIONAL_WALL_EDGES);
    });
  });

  it('falls back deterministically for legacy documents with an unknown materialId', () => {
    const style = resolveWallVisualStyle(wallSource('missing-material', 'concrete'));

    expect(style.materialId).toBe('legacy-concrete');
    expect(style.family).toBe('concrete');
    expect(style.baseColor).toBe('#8b9096');
  });
});

