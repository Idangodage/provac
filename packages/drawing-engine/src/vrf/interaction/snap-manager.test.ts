import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SNAP_SETTINGS,
  SnapManager,
  rankSnapCandidates,
  type SnapCandidate,
} from './snap-manager';

function candidate(
  id: string,
  type: SnapCandidate['type'],
  distancePx: number,
  x: number,
  overrides: Partial<SnapCandidate> = {},
): SnapCandidate {
  return {
    id,
    type,
    worldPoint: new THREE.Vector3(x, 0, 0),
    screenDistancePx: distancePx,
    message: id,
    isValid: true,
    ...overrides,
  };
}

describe('SnapManager', () => {
  it('prefers semantic drafting intent before raw screen distance', () => {
    const manager = new SnapManager();
    const resolved = manager.resolve(new THREE.Vector3(), [
      candidate('grid', 'grid', 1, 10),
      candidate('endpoint', 'pipe-endpoint', 8, 20),
      candidate('port', 'equipment-port', 12, 30),
    ]);

    expect(resolved.candidate?.id).toBe('port');
    expect(resolved.point.toArray()).toEqual([30, 0, 0]);
  });

  it('retains an acquired target through the wider break-away band', () => {
    const manager = new SnapManager();
    manager.resolve(new THREE.Vector3(), [
      candidate('port-a', 'equipment-port', 4, 10),
    ]);

    const retained = manager.resolve(new THREE.Vector3(), [
      candidate('port-a', 'equipment-port', DEFAULT_SNAP_SETTINGS.tolerancePx + 3, 10),
      candidate('port-b', 'equipment-port', 10, 20),
    ]);

    expect(retained.candidate?.id).toBe('port-a');
    expect(retained.retainedByHysteresis).toBe(true);
  });

  it('allows a materially better target to replace the retained target', () => {
    const manager = new SnapManager();
    manager.resolve(new THREE.Vector3(), [
      candidate('grid', 'grid', 3, 10),
    ]);

    const switched = manager.resolve(new THREE.Vector3(), [
      candidate('grid', 'grid', 16, 10),
      candidate('port', 'equipment-port', 10, 20),
    ]);

    expect(switched.candidate?.id).toBe('port');
    expect(switched.retainedByHysteresis).toBe(false);
  });

  it('releases a target outside break-away and respects temporary type suppression', () => {
    const manager = new SnapManager();
    manager.resolve(new THREE.Vector3(), [
      candidate('port', 'equipment-port', 2, 10),
    ]);

    const raw = new THREE.Vector3(7, 8, 9);
    const released = manager.resolve(raw, [
      candidate('port', 'equipment-port', DEFAULT_SNAP_SETTINGS.breakAwayPx + 1, 10),
      candidate('grid', 'grid', 2, 20),
    ], {
      disabledTypes: new Set(['grid']),
    });

    expect(released.candidate).toBeNull();
    expect(released.point.toArray()).toEqual(raw.toArray());
  });

  it('uses a stable id tie-break for overlapping candidates', () => {
    const ranked = rankSnapCandidates([
      candidate('port-b', 'equipment-port', 5, 20),
      candidate('port-a', 'equipment-port', 5, 10),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(['port-a', 'port-b']);
  });
});
