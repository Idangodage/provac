import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import {
  applyCanvasTransform,
  clientPointToWorld,
  getCanvasTransform,
} from '../coordinateTransform';

import {
  containsPointInHvacElementBounds,
  hitTestModelBackedHvacElement,
} from './hvacElementHitTesting';

function branchKit(overrides: Partial<HvacElement> = {}): HvacElement {
  return {
    id: 'kit-1',
    type: 'refrigerant-branch-kit',
    category: 'accessory',
    subtype: 'dis-22-1g',
    modelLabel: 'DIS-22-1G',
    position: { x: 100, y: 200 },
    rotation: 0,
    width: 120,
    depth: 60,
    height: 50,
    elevation: 2600,
    mountType: 'ceiling',
    label: 'Branch kit',
    supplyZoneRatio: 0,
    properties: { branchKitType: 'dis-22-1g' },
    ...overrides,
  };
}

describe('HVAC model-backed hit-testing', () => {
  it('hits a branch kit from model bounds when no Fabric body exists', () => {
    const kit = branchKit();
    expect(containsPointInHvacElementBounds({ x: 140, y: 220 }, kit)).toBe(true);
    expect(hitTestModelBackedHvacElement({ x: 140, y: 220 }, [kit])).toBe('kit-1');
  });

  it('respects rotation around the element center', () => {
    const kit = branchKit({ rotation: 90 });
    expect(containsPointInHvacElementBounds({ x: 160, y: 260 }, kit)).toBe(true);
    expect(containsPointInHvacElementBounds({ x: 230, y: 260 }, kit)).toBe(false);
  });

  it('stays correct after zoom and pan via the canonical transform', () => {
    const kit = branchKit();
    const world = { x: 150, y: 220 };
    const view = getCanvasTransform(2.25, { x: 175, y: -90 });
    const localScreen = applyCanvasTransform(world, view);
    const rect = { left: 40, top: 70 };
    const resolvedWorld = clientPointToWorld(
      localScreen.x + rect.left,
      localScreen.y + rect.top,
      rect,
      view,
    );
    expect(hitTestModelBackedHvacElement(resolvedWorld, [kit])).toBe('kit-1');
  });

  it('does not use broad model bounds for pipe elements', () => {
    const pipe = branchKit({
      id: 'pipe-1',
      type: 'refrigerant-pipe',
      label: 'Pipe',
      properties: { routePoints: [{ x: 100, y: 100 }, { x: 300, y: 100 }] },
    });
    expect(hitTestModelBackedHvacElement({ x: 140, y: 220 }, [pipe])).toBeNull();
  });
});
