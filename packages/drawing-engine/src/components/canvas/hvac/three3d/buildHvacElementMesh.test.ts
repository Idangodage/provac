import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { buildHvacElementMesh, type HvacBuildSceneContext } from './buildHvacElementMesh';

function makeElement(overrides: Partial<HvacElement> = {}): HvacElement {
  return {
    id: 'hvac-test-1',
    type: 'wall-mounted-ac',
    position: { x: 1000, y: 2000 },
    rotation: 0,
    width: 20,
    depth: 30,
    height: 250,
    elevation: 2400,
    mountType: 'wall',
    label: 'AC',
    supplyZoneRatio: 0.5,
    properties: {},
    ...overrides,
  };
}

function makeContext(element: HvacElement): HvacBuildSceneContext {
  return { allElements: [element], pipeTargets: [] };
}

describe('buildHvacElementMesh placement', () => {
  it('anchors sub-60mm elements at the UNCLAMPED 2D centre', () => {
    // Every 2D consumer (plan renderer, hit testing, overlays) computes the
    // centre as position + size / 2 with no clamp. The 3D group must sit on
    // the exact same point or the element shifts when the 3D view fades in.
    const element = makeElement({ width: 20, depth: 30 });
    const group = buildHvacElementMesh(element, makeContext(element));

    expect(group).not.toBeNull();
    expect(group!.position.x).toBeCloseTo(1000 + 20 / 2, 9);
    expect(group!.position.y).toBeCloseTo(2000 + 30 / 2, 9);
    expect(group!.position.z).toBeCloseTo(2400, 9);
  });

  it('keeps regular-size elements on the shared 2D/3D centre', () => {
    const element = makeElement({ width: 600, depth: 400 });
    const group = buildHvacElementMesh(element, makeContext(element));

    expect(group).not.toBeNull();
    expect(group!.position.x).toBeCloseTo(1000 + 600 / 2, 9);
    expect(group!.position.y).toBeCloseTo(2000 + 400 / 2, 9);
  });

  it('renders ceiling cassette body, face, grille, and service ports as visible 3D equipment', () => {
    const element = makeElement({
      type: 'ceiling-cassette-ac',
      width: 1043,
      depth: 950,
      height: 272,
      elevation: 2600,
      mountType: 'ceiling',
      properties: {},
    });
    const group = buildHvacElementMesh(element, makeContext(element));

    expect(group).not.toBeNull();
    expect(group!.position.x).toBeCloseTo(1000 + 1043 / 2, 9);
    expect(group!.position.y).toBeCloseTo(2000 + 950 / 2, 9);
    expect(group!.position.z).toBeCloseTo(2600, 9);

    const names = new Set<string>();
    group!.traverse((object) => {
      if (object.name) names.add(object.name);
    });

    expect(names.has('ceiling-cassette-hidden-body')).toBe(true);
    expect(names.has('ceiling-cassette-face-panel')).toBe(true);
    expect(names.has('ceiling-cassette-face-panel-outline')).toBe(true);
    expect(names.has('ceiling-cassette-return-grille-frame')).toBe(true);
    expect(names.has('ceiling-cassette-connection-pod')).toBe(true);
    expect(names.has('ceiling-cassette-gas-port')).toBe(true);
    expect(names.has('ceiling-cassette-liquid-port')).toBe(true);
    expect(names.has('ceiling-cassette-drain-port')).toBe(true);

    const bounds = new THREE.Box3().setFromObject(group!);
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(240);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(1040);
    expect(bounds.max.y - bounds.min.y).toBeGreaterThan(940);
  });
});
