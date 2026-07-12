import { describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import {
  buildRefrigerantPipeElements,
  buildRefrigerantPipeExtensionMerge,
  findNearestRefrigerantPipeExtensionTarget,
  type RefrigerantPipeBundleConnection,
} from './refrigerantPipePairModel';

const p = (x: number, y: number): Point2D => ({ x, y });

type SnapSource = Parameters<typeof findNearestRefrigerantPipeExtensionTarget>[0];

/** Give built (id-less) pipe elements stable ids so they read as scene elements. */
function withIds<T>(elements: T[], prefix: string): SnapSource {
  return elements.map((element, index) => ({
    ...element,
    id: `${prefix}-${index}`,
  })) as unknown as SnapSource;
}

const routeOf = (element: { properties?: Record<string, unknown> }): Point2D[] =>
  (element.properties?.routePoints ?? []) as Point2D[];
const lineKindOf = (element: { properties?: Record<string, unknown> }): unknown =>
  element.properties?.lineKind;

describe('buildRefrigerantPipeExtensionMerge', () => {
  it('appends a single-line extension onto the host end (one continuous polyline)', () => {
    const host = withIds(
      buildRefrigerantPipeElements([p(0, 0), p(1000, 0)], { lineMode: 'gas' }),
      'g',
    );
    const target = findNearestRefrigerantPipeExtensionTarget(host, p(1000, 0), 50)!;
    expect(target.lineMode).toBe('gas');
    const extension = buildRefrigerantPipeElements([p(1000, 0), p(1000, 600)], {
      lineMode: 'gas',
      startBundleConnection: target.bundle,
    });

    const updates = buildRefrigerantPipeExtensionMerge(host, target.bundle, extension);
    expect(updates).toHaveLength(1);
    expect(updates![0]!.id).toBe('g-0');
    expect(routeOf(updates![0]!)).toEqual([p(0, 0), p(1000, 0), p(1000, 600)]);
    // The extended side is no longer an open end candidate of its own element.
    expect(updates![0]!.properties.endConnection ?? null).toBeNull();
  });

  it('prepends (reversed) when continuing the host START end', () => {
    const host = withIds(
      buildRefrigerantPipeElements([p(0, 0), p(1000, 0)], { lineMode: 'gas' }),
      'g',
    );
    const target = findNearestRefrigerantPipeExtensionTarget(host, p(0, 0), 50)!;
    const extension = buildRefrigerantPipeElements([p(0, 0), p(-500, 0), p(-500, 400)], {
      lineMode: 'gas',
      startBundleConnection: target.bundle,
    });

    const updates = buildRefrigerantPipeExtensionMerge(host, target.bundle, extension);
    expect(updates).toHaveLength(1);
    expect(routeOf(updates![0]!)).toEqual([
      p(-500, 400),
      p(-500, 0),
      p(0, 0),
      p(1000, 0),
    ]);
  });

  it('merges a pair extension into BOTH host lines', () => {
    const host = withIds(
      buildRefrigerantPipeElements([p(0, 0), p(1000, 0)], { bundleId: 'b1' }),
      'pr',
    );
    const target = findNearestRefrigerantPipeExtensionTarget(host, p(1000, 0), 300)!;
    expect(target.lineMode).toBe('pair');
    const extension = buildRefrigerantPipeElements([target.bundle.point, p(1000, 800)], {
      startBundleConnection: target.bundle,
    });

    const updates = buildRefrigerantPipeExtensionMerge(host, target.bundle, extension);
    expect(updates).toHaveLength(2);
    for (const extensionElement of extension) {
      const hostElement = (host as Array<{ id: string; properties?: Record<string, unknown> }>)
        .find((candidate) => lineKindOf(candidate) === lineKindOf(extensionElement))!;
      const update = updates!.find((candidate) => candidate.id === hostElement.id)!;
      const hostRoute = routeOf(hostElement);
      const extensionRoute = routeOf(extensionElement);
      const mergedRoute = routeOf(update);
      // One polyline: the host line's route followed by the extension tail.
      expect(mergedRoute.slice(0, hostRoute.length)).toEqual(hostRoute);
      expect(mergedRoute).toHaveLength(hostRoute.length + extensionRoute.length - 1);
    }
  });

  it('does not merge from a branch-kit terminal (keeps port connection semantics)', () => {
    const host = withIds(
      buildRefrigerantPipeElements([p(0, 0), p(1000, 0)], { lineMode: 'gas' }),
      'g',
    );
    const target = findNearestRefrigerantPipeExtensionTarget(host, p(1000, 0), 50)!;
    const kitBundle = {
      ...target.bundle,
      terminalRole:
        'run-outlet' as NonNullable<RefrigerantPipeBundleConnection['terminalRole']>,
    };
    const extension = buildRefrigerantPipeElements([p(1000, 0), p(1000, 600)], {
      lineMode: 'gas',
      startBundleConnection: kitBundle,
    });
    expect(buildRefrigerantPipeExtensionMerge(host, kitBundle, extension)).toBeNull();
  });

  it('returns null when no open matching host end exists (falls back to add-new)', () => {
    const host = withIds(
      buildRefrigerantPipeElements([p(0, 0), p(1000, 0)], { lineMode: 'liquid' }),
      'l',
    );
    const target = findNearestRefrigerantPipeExtensionTarget(host, p(1000, 0), 50)!;
    // Extension built as GAS cannot merge into a LIQUID host line.
    const extension = buildRefrigerantPipeElements([p(1000, 0), p(1000, 600)], {
      lineMode: 'gas',
      startBundleConnection: target.bundle,
    });
    expect(buildRefrigerantPipeExtensionMerge(host, target.bundle, extension)).toBeNull();
  });
});
