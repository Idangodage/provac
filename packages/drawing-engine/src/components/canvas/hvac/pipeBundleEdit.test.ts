import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import {
  describeBundleSeparation, measureBundleSeparationMm, resolvePipeBundle, solvePipeBundleEdit,
} from './pipeBundleEdit';
import type { PipeRouteNode3D } from './pipeRoute3d';

const line = (id: string, lineKind: 'gas' | 'liquid', nodes: PipeRouteNode3D[],
  extra: Record<string, unknown> = {}): HvacElement => ({
  id, type: 'refrigerant-pipe', label: `${lineKind} line`,
  position: { x: 0, y: 0 }, width: 10, depth: 10, height: 10,
  elevation: 2000, rotation: 0, mountType: 'ceiling', supplyZoneRatio: 0,
  properties: {
    lineKind, pipeDiameterMm: 9.52, outerDiameterMm: 60,
    routePoints: nodes.map(({ x, y }) => ({ x, y })),
    routeNodes3d: nodes,
    segmentMaterials: nodes.slice(1).map(() => 'flexible'),
    ...extra,
  },
} as unknown as HvacElement);

const GAS: PipeRouteNode3D[] = [
  { x: 0, y: 0, z: 2600 }, { x: 3000, y: 0, z: 2600 }, { x: 3000, y: 4000, z: 2600 },
];
/** The liquid lane, 100 mm away in plan. */
const LIQUID: PipeRouteNode3D[] = GAS.map(node => ({ ...node, y: node.y + 100 }));

const bundled = (extra: Record<string, unknown> = {}) => [
  line('gas-1', 'gas', GAS, { bundleId: 'b1', pairCenterSpacingMm: 100, ...extra }),
  line('liq-1', 'liquid', LIQUID, { bundleId: 'b1', pairCenterSpacingMm: 100, ...extra }),
];

/** Applies the same world-space offset to a line, the way a bundle move must. */
const translator = (offset: { x: number; y: number; z: number }) =>
  (elementId: string, elements: readonly HvacElement[]) => {
    const element = elements.find(candidate => candidate.id === elementId);
    if (!element) return { ok: false as const, message: 'missing' };
    const nodes = (element.properties.routeNodes3d as PipeRouteNode3D[])
      .map(node => ({ x: node.x + offset.x, y: node.y + offset.y, z: node.z + offset.z }));
    return {
      ok: true as const,
      element: {
        ...element,
        properties: {
          ...element.properties,
          routeNodes3d: nodes,
          routePoints: nodes.map(({ x, y }) => ({ x, y })),
        },
      },
      adaptations: [],
    };
  };

describe('resolvePipeBundle — explicit identity only', () => {
  it('finds both lines of a bundle', () => {
    const bundle = resolvePipeBundle(bundled()[0]!, bundled());
    expect(bundle?.members.map(member => member.lineKind).sort()).toEqual(['gas', 'liquid']);
    expect(bundle?.members[0]!.requiredSeparationMm).toBe(100);
  });

  it('never pairs two lines that merely run alongside each other', () => {
    // Same geometry, same spacing — but no shared bundleId, so not a bundle.
    const loose = [line('a', 'gas', GAS), line('b', 'liquid', LIQUID)];
    expect(resolvePipeBundle(loose[0]!, loose)).toBeNull();
  });

  it('treats a lone line carrying a bundleId as not a bundle', () => {
    const lonely = [line('gas-1', 'gas', GAS, { bundleId: 'b1' })];
    expect(resolvePipeBundle(lonely[0]!, lonely)).toBeNull();
  });
});

describe('measureBundleSeparationMm', () => {
  it('measures the real centre-to-centre distance', () => {
    const [gas, liquid] = bundled();
    expect(measureBundleSeparationMm(gas!, liquid!)).toBeCloseTo(100, 6);
  });

  it('measures in 3D — a vertically stacked pair is separated, not coincident', () => {
    const stacked = line('liq-2', 'liquid', GAS.map(node => ({ ...node, z: node.z - 120 })),
      { bundleId: 'b1' });
    const [gas] = bundled();
    expect(measureBundleSeparationMm(gas!, stacked)).toBeCloseTo(120, 6);
  });
});

describe('solvePipeBundleEdit — both lines or neither', () => {
  it('moves both lines and preserves the separation exactly', () => {
    const elements = bundled();
    const result = solvePipeBundleEdit({
      elementId: 'gas-1', elements, solveLine: translator({ x: 0, y: 0, z: -600 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elements.map(entry => entry.id).sort()).toEqual(['gas-1', 'liq-1']);
    expect(result.separation.beforeMm).toBeCloseTo(100, 6);
    expect(result.separation.afterMm).toBeCloseTo(100, 6);
    expect(result.separation.requiredMm).toBe(100);
    expect(result.separation.withinRequirement).toBe(true);
  });

  it('commits nothing when one line cannot follow', () => {
    const elements = bundled();
    const result = solvePipeBundleEdit({
      elementId: 'gas-1',
      elements,
      solveLine: (elementId, scene) => elementId === 'liq-1'
        ? { ok: false, message: 'The end connection must remain fixed.' }
        : translator({ x: 0, y: 0, z: -600 })(elementId, scene),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedElementId).toBe('liq-1');
    expect(result.message).toContain('liquid line cannot follow');
    expect(result.message).toContain('left unchanged');
  });

  it('reports a separation change rather than hiding it', () => {
    const elements = bundled();
    const result = solvePipeBundleEdit({
      elementId: 'gas-1',
      elements,
      // Only the gas line moves — exactly the case that silently splits a pair.
      solveLine: (elementId, scene) => elementId === 'gas-1'
        ? translator({ x: 0, y: 400, z: 0 })(elementId, scene)
        : translator({ x: 0, y: 0, z: 0 })(elementId, scene),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.separation.afterMm).toBeCloseTo(300, 6);
    expect(result.separation.withinRequirement).toBe(false);
    expect(describeBundleSeparation(result.separation)).toContain('differs from the required');
  });

  it('marks an unrecorded requirement unverified instead of passing it', () => {
    const elements = [
      line('gas-1', 'gas', GAS, { bundleId: 'b1' }),
      line('liq-1', 'liquid', LIQUID, { bundleId: 'b1' }),
    ];
    const result = solvePipeBundleEdit({
      elementId: 'gas-1', elements, solveLine: translator({ x: 0, y: 0, z: -600 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // outerDiameterMm + pipeGapMm are absent, so nothing establishes a requirement.
    expect(result.separation.requiredMm).toBeNull();
    expect(result.separation.withinRequirement).toBe(false);
    expect(describeBundleSeparation(result.separation)).toContain('unverified');
  });

  it('refuses a legacy composite pair rather than half-editing it', () => {
    const composite = {
      ...line('pair-1', 'gas', GAS, { bundleId: 'b1' }),
      type: 'refrigerant-pipe-pair',
    } as unknown as HvacElement;
    const elements = [composite, line('liq-1', 'liquid', LIQUID, { bundleId: 'b1' })];
    const result = solvePipeBundleEdit({
      elementId: 'pair-1', elements, solveLine: translator({ x: 0, y: 0, z: -600 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('legacy composite');
  });

  it('says plainly when a pipe is not bundled at all', () => {
    const single = [line('gas-1', 'gas', GAS)];
    const result = solvePipeBundleEdit({
      elementId: 'gas-1', elements: single, solveLine: translator({ x: 0, y: 0, z: 0 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('not part of a gas/liquid bundle');
  });
});
