import type { Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { HvacElement } from '../../../../types';

vi.mock('./glbModelCache', async () => {
  const three = await import('three');
  return {
    instantiateGlbModel: vi.fn(() => {
      const group = new three.Group();
      group.name = 'loaded-catalog-cassette';
      group.add(
        new three.Mesh(
          new three.BoxGeometry(1043, 950, 272),
          new three.MeshBasicMaterial(),
        ),
      );
      return group;
    }),
  };
});

function makeCassette(): HvacElement {
  return {
    id: 'cassette-glb-test',
    type: 'ceiling-cassette-ac',
    position: { x: 1200, y: 1700 },
    rotation: 0,
    width: 1043,
    depth: 950,
    height: 272,
    elevation: 2600,
    mountType: 'ceiling',
    label: 'Cassette',
    supplyZoneRatio: 0.5,
    properties: {
      modelUrl: '/models/vrf/maco-vrf-fdt28kxze1.glb',
    },
  };
}

describe('buildHvacElementMesh loaded ceiling cassette', () => {
  it('keeps the catalog model and adds the visible app-side cassette overlay', async () => {
    const { buildHvacElementMesh } = await import('./buildHvacElementMesh');
    const element = makeCassette();
    const group = buildHvacElementMesh(element, { allElements: [element] });

    expect(group).not.toBeNull();
    expect(group!.position.x).toBeCloseTo(1200 + 1043 / 2, 9);
    expect(group!.position.y).toBeCloseTo(1700 + 950 / 2, 9);
    expect(group!.position.z).toBeCloseTo(2600, 9);

    const names = new Set<string>();
    group!.traverse((object) => {
      if (object.name) names.add(object.name);
    });

    expect(names.has('loaded-catalog-cassette')).toBe(true);
    expect(names.has('ceiling-cassette-face-panel')).toBe(true);
    expect(names.has('ceiling-cassette-face-panel-outline')).toBe(true);
    expect(names.has('ceiling-cassette-hidden-body-outline')).toBe(true);
    expect(names.has('ceiling-cassette-connection-pod')).toBe(true);
    expect(names.has('ceiling-cassette-gas-port')).toBe(true);

    const outlines: Object3D[] = [];
    group!.traverse((object) => {
      if (object.name.endsWith('-outline')) outlines.push(object);
    });
    expect(outlines.length).toBeGreaterThanOrEqual(2);
    outlines.forEach((outline) => {
      expect(outline.renderOrder).toBeGreaterThanOrEqual(42);
      expect(outline.frustumCulled).toBe(false);
    });
  });
});
