import { afterEach, describe, expect, it } from 'vitest';

import type { Point2D } from '../../../types';

import { setActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipeElements,
  findNearestRefrigerantPipeExtensionTarget,
  isPlausibleBundleSpacingMm,
} from './refrigerantPipePairModel';

const p = (x: number, y: number): Point2D => ({ x, y });
const route = [p(0, 0), p(1000, 0), p(1000, 800)];
const openEnd = p(1000, 800);

/** Give the built (id-less) pipe elements stable ids so they read as scene
 *  elements the detector can consume. */
function withIds<T>(
  elements: T[],
  prefix: string,
): Parameters<typeof findNearestRefrigerantPipeExtensionTarget>[0] {
  return elements.map((element, index) => ({
    ...element,
    id: `${prefix}-${index}`,
  })) as unknown as Parameters<typeof findNearestRefrigerantPipeExtensionTarget>[0];
}

const pairRun = withIds(
  buildRefrigerantPipeElements(route, { bundleId: 'bundle-1' }),
  'pair',
);
const gasRun = withIds(
  buildRefrigerantPipeElements(route, { lineMode: 'gas' }),
  'gas',
);
const liquidRun = withIds(
  buildRefrigerantPipeElements(route, { lineMode: 'liquid' }),
  'liquid',
);

describe('findNearestRefrigerantPipeExtensionTarget', () => {
  it('resolves a coordinated pair run end to a pair continuation', () => {
    const target = findNearestRefrigerantPipeExtensionTarget(pairRun, openEnd, 300);
    expect(target?.lineMode).toBe('pair');
  });

  it('resolves a lone gas line end to a gas continuation', () => {
    const target = findNearestRefrigerantPipeExtensionTarget(gasRun, openEnd, 100);
    expect(target?.lineMode).toBe('gas');
    // The synthesized bundle welds at the open end, carrying its line identity.
    expect(target?.bundle.point).toEqual(openEnd);
    expect(target?.bundle.guideReference).toBe('gas');
  });

  it('resolves a lone liquid line end to a liquid continuation', () => {
    const target = findNearestRefrigerantPipeExtensionTarget(liquidRun, openEnd, 100);
    expect(target?.lineMode).toBe('liquid');
    expect(target?.bundle.guideReference).toBe('liquid');
  });

  it('returns null when no end is within the threshold', () => {
    expect(
      findNearestRefrigerantPipeExtensionTarget(gasRun, p(5000, 5000), 100),
    ).toBeNull();
  });

  it('honors the lineKind filter (a gas end is invisible when asking for liquid)', () => {
    expect(
      findNearestRefrigerantPipeExtensionTarget(gasRun, openEnd, 100, {
        lineKind: 'liquid',
      }),
    ).toBeNull();
    expect(
      findNearestRefrigerantPipeExtensionTarget(gasRun, openEnd, 100, {
        lineKind: 'gas',
      })?.lineMode,
    ).toBe('gas');
  });

  it('excludes ends owned by excludeElementId so a run cannot weld onto itself', () => {
    expect(
      findNearestRefrigerantPipeExtensionTarget(gasRun, openEnd, 100, {
        lineKind: 'gas',
        excludeElementId: gasRun[0]!.id,
      }),
    ).toBeNull();
  });
});

describe('bundle detection is gap-agnostic', () => {
  afterEach(() => {
    setActivePipeRoutingSettings(null); // restore default gap for other suites
  });

  it('isPlausibleBundleSpacingMm accepts touching..max and rejects far apart', () => {
    // touching = 40/2 + 20/2 = 30 mm
    expect(isPlausibleBundleSpacingMm(30, 40, 20)).toBe(true);
    expect(isPlausibleBundleSpacingMm(200, 40, 20)).toBe(true);
    expect(isPlausibleBundleSpacingMm(1000, 40, 20)).toBe(false);
  });

  it('keeps a non-bundleId pair detected after the active gap is changed', () => {
    setActivePipeRoutingSettings(null); // baked at the default gap
    // Two lines at pair spacing but with DISTINCT bundleIds, so pairing falls to
    // the spacing gate rather than the shared-bundleId bypass.
    const split = buildRefrigerantPipeElements(route).map((element, index) => ({
      ...element,
      id: `s-${index}`,
      properties: { ...(element.properties ?? {}), bundleId: `s-${index}` },
    })) as Parameters<typeof findNearestRefrigerantPipeExtensionTarget>[0];

    expect(
      findNearestRefrigerantPipeExtensionTarget(split, openEnd, 400)?.lineMode,
    ).toBe('pair');

    // User widens the gap far from what the pair was drawn at — it must stay a pair.
    setActivePipeRoutingSettings({ defaultPipeGapMm: 200 });
    expect(
      findNearestRefrigerantPipeExtensionTarget(split, openEnd, 400)?.lineMode,
    ).toBe('pair');
  });
});
