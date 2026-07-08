import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import { buildRefrigerantPipeElements } from './refrigerantPipePairModel';

const p = (x: number, y: number): Point2D => ({ x, y });
const route = [p(0, 0), p(1000, 0), p(1000, 800)];

const lineKindOf = (element: { properties?: Record<string, unknown> }): unknown =>
  (element.properties ?? {}).lineKind;

describe('buildRefrigerantPipeElements — line mode', () => {
  it('defaults to a coordinated gas + liquid pair', () => {
    const elements = buildRefrigerantPipeElements(route);
    expect(elements).toHaveLength(2);
    expect(elements.map(lineKindOf).sort()).toEqual(['gas', 'liquid']);
  });

  it('draws a single gas line centered on the drawn route', () => {
    const elements = buildRefrigerantPipeElements(route, { lineMode: 'gas' });
    expect(elements).toHaveLength(1);
    const gas = elements[0]!;
    expect(gas.type).toBe('refrigerant-pipe');
    expect(lineKindOf(gas)).toBe('gas');
    // The lone line's centerline is the drawn route itself — no lateral offset.
    const routePoints = (gas.properties?.routePoints ?? []) as Point2D[];
    expect(routePoints).toEqual(route);
  });

  it('draws a single liquid line centered on the drawn route', () => {
    const elements = buildRefrigerantPipeElements(route, { lineMode: 'liquid' });
    expect(elements).toHaveLength(1);
    const liquid = elements[0]!;
    expect(lineKindOf(liquid)).toBe('liquid');
    const routePoints = (liquid.properties?.routePoints ?? []) as Point2D[];
    expect(routePoints).toEqual(route);
  });
});
