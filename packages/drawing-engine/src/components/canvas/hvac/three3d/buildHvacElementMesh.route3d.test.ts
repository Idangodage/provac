import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { attachPipeRoute3dToElements } from '../pipeRoute3d';
import {
  buildRefrigerantPipeElements,
  buildRefrigerantPipePairElement,
} from '../refrigerantPipePairModel';

import { buildHvacElementMesh } from './buildHvacElementMesh';

function buildPipe(route: Array<{ x: number; y: number; z: number }>): HvacElement {
  const base = buildRefrigerantPipeElements(route, {
    lineMode: 'gas',
    elevationMm: Math.min(...route.map((point) => point.z)),
  });
  const [stamped] = attachPipeRoute3dToElements(base, route);
  if (!stamped) throw new Error('Expected a pipe element');
  return {
    ...stamped,
    id: 'route-3d-test',
    rotation: stamped.rotation ?? 0,
    category: stamped.category ?? 'accessory',
    subtype: stamped.subtype ?? 'gas',
    modelLabel: stamped.modelLabel ?? 'Gas Pipe',
    supplyZoneRatio: stamped.supplyZoneRatio ?? 0,
    properties: stamped.properties ?? {},
  };
}

describe('buildHvacElementMesh routeNodes3d', () => {
  it('renders a true vertical riser at its absolute model coordinates', () => {
    const element = buildPipe([
      { x: 120, y: 80, z: 100 },
      { x: 120, y: 80, z: 900 },
    ]);
    const mesh = buildHvacElementMesh(element, { allElements: [element] });
    expect(mesh).not.toBeNull();
    mesh?.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(mesh!);
    expect(bounds.min.z).toBeCloseTo(100, 3);
    expect(bounds.max.z).toBeCloseTo(900, 3);
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(800, 3);
    expect((bounds.min.x + bounds.max.x) / 2).toBeCloseTo(120, 3);
    expect((bounds.min.y + bounds.max.y) / 2).toBeCloseTo(80, 3);
  });

  it('renders an inclined route without flattening its authored Z nodes', () => {
    const element = buildPipe([
      { x: 0, y: 0, z: 150 },
      { x: 500, y: 250, z: 650 },
    ]);
    const mesh = buildHvacElementMesh(element, { allElements: [element] });
    const bounds = new THREE.Box3().setFromObject(mesh!);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(500);
    expect(bounds.max.y - bounds.min.y).toBeGreaterThan(250);
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(500);
  });

  it('renders a composite pair from its editable 3D guide', () => {
    const base = buildRefrigerantPipePairElement([
      { x: 100, y: 200 },
      { x: 100, y: 200 },
    ], { elevationMm: 100 });
    const element = {
      ...base,
      id: 'pair-route-3d-test',
      rotation: base.rotation ?? 0,
      properties: {
        ...(base.properties ?? {}),
        routeNodes3d: [
          { x: 100, y: 200, z: 120 },
          { x: 100, y: 200, z: 920 },
        ],
      },
    } as HvacElement;
    const mesh = buildHvacElementMesh(element, { allElements: [element] });
    const bounds = new THREE.Box3().setFromObject(mesh!);
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(800);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(20);
  });
});
