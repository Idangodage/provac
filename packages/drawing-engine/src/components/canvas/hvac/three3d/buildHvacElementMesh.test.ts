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
});
