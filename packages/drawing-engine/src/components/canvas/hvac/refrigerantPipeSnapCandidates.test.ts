import { describe, expect, it, vi } from 'vitest';

import type { RefrigerantPipeBundleConnection } from './refrigerantPipePairModel';
import {
  buildRefrigerantBundleSnapCandidates,
  resolveRefrigerantBundleSnapType,
} from './refrigerantPipeSnapCandidates';

function connection(
  overrides: Partial<RefrigerantPipeBundleConnection> = {},
): RefrigerantPipeBundleConnection {
  return {
    point: { x: 15, y: 0 },
    gasPoint: { x: 10, y: 0 },
    liquidPoint: { x: 20, y: 0 },
    gasFieldPoint: { x: 10, y: 0 },
    liquidFieldPoint: { x: 20, y: 0 },
    direction: { x: 1, y: 0 },
    elevationMm: 2500,
    gasElevationMm: 2500,
    liquidElevationMm: 2500,
    connectionKind: 'field-pipe',
    sourceElementId: 'source',
    ...overrides,
  };
}

describe('buildRefrigerantBundleSnapCandidates', () => {
  it('measures the active line in pixels and pair mode uses the nearer line', () => {
    const target = connection();
    const gas = buildRefrigerantBundleSnapCandidates({
      targets: [target],
      pointer: { x: 12, y: 0 },
      lineMode: 'gas',
      screenPxPerMm: 2,
    })[0]!;
    const liquid = buildRefrigerantBundleSnapCandidates({
      targets: [target],
      pointer: { x: 12, y: 0 },
      lineMode: 'liquid',
      screenPxPerMm: 2,
    })[0]!;
    const pair = buildRefrigerantBundleSnapCandidates({
      targets: [target],
      pointer: { x: 12, y: 0 },
      lineMode: 'pair',
      screenPxPerMm: 2,
    })[0]!;

    expect(gas.candidate.screenDistancePx).toBe(4);
    expect(liquid.candidate.screenDistancePx).toBe(16);
    expect(pair.candidate.screenDistancePx).toBe(4);
  });

  it('keeps two endpoints from one source distinct and carries validity/message', () => {
    const entries = buildRefrigerantBundleSnapCandidates({
      targets: [
        connection(),
        connection({
          point: { x: 115, y: 0 },
          gasPoint: { x: 110, y: 0 },
          liquidPoint: { x: 120, y: 0 },
        }),
      ],
      pointer: { x: 0, y: 0 },
      lineMode: 'pair',
      screenPxPerMm: 1,
      isTargetValid: (target) => target.point.x < 100,
      messageForTarget: (target) => `Endpoint ${target.point.x}`,
    });

    expect(entries[0]!.candidate.id).not.toBe(entries[1]!.candidate.id);
    expect(entries.map((entry) => entry.candidate.isValid)).toEqual([true, false]);
    expect(entries[0]!.candidate.message).toBe('Endpoint 15');
  });

  it('assigns semantic priority types', () => {
    expect(resolveRefrigerantBundleSnapType(
      connection({ connectionKind: 'unit-port' }),
    )).toBe('equipment-port');
    expect(resolveRefrigerantBundleSnapType(
      connection({ terminalRole: 'inlet' }),
    )).toBe('branch-inlet');
    expect(resolveRefrigerantBundleSnapType(
      connection({ terminalRole: 'branch-outlet' }),
    )).toBe('branch-outlet');
    expect(resolveRefrigerantBundleSnapType(connection())).toBe('pipe-endpoint');
  });

  it('keeps the break-away boundary while skipping allocation and labels for distant targets', () => {
    const targets = [connection(), connection({ sourceElementId: 'far', gasPoint: { x: 10000, y: 0 }, liquidPoint: { x: 10010, y: 0 } })];
    const messageForTarget = vi.fn(() => 'Visible target');
    const options = { targets, pointer: { x: 0, y: 0 }, lineMode: 'gas' as const, screenPxPerMm: 2, messageForTarget };
    const filtered = buildRefrigerantBundleSnapCandidates({ ...options, captureRadiusPx: 20 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.candidate.screenDistancePx).toBe(20);
    expect(messageForTarget).toHaveBeenCalledOnce();
    const unfiltered = buildRefrigerantBundleSnapCandidates(options);
    expect(filtered[0]!.candidate.id).toBe(unfiltered[0]!.candidate.id);
    expect(buildRefrigerantBundleSnapCandidates({ ...options, captureRadiusPx: 19.9 })).toEqual([]);
  });
});
