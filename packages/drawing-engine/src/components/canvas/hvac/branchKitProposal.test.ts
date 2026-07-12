import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { buildTeeRunHalves } from './branchKitProposal';

function makeGasRun(): HvacElement {
  return {
    id: 'gas-run-1',
    type: 'refrigerant-pipe',
    position: { x: 0, y: 0 },
    rotation: 0,
    width: 1,
    depth: 1,
    height: 1,
    elevation: 2600,
    mountType: 'ceiling',
    label: 'Gas Pipe',
    supplyZoneRatio: 0.5,
    properties: {
      lineKind: 'gas',
      bundleId: 'orig-bundle',
      routePoints: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ],
      startConnection: { kind: 'start' },
      endConnection: { kind: 'end' },
    },
  } as HvacElement;
}

const props = (el: HvacElement) => el.properties as Record<string, unknown>;

describe('buildTeeRunHalves', () => {
  it('splits a run at the station into run-in / run-out and clears the cut-end connection', () => {
    const halves = buildTeeRunHalves(makeGasRun(), { x: 400, y: 0 }, 'tee-1');
    expect(halves).not.toBeNull();
    const [runIn, runOut] = halves!;

    // run-in: original start … tee. Keeps the start connection, clears the (cut) end.
    expect(props(runIn).routePoints).toEqual([{ x: 0, y: 0 }, { x: 400, y: 0 }]);
    expect(props(runIn).startConnection).toEqual({ kind: 'start' });
    expect(props(runIn).endConnection).toBeNull();
    expect(props(runIn).teeRole).toBe('run-in');
    expect(props(runIn).teeId).toBe('tee-1');
    expect(props(runIn).bundleId).toBe('tee-1-in');

    // run-out: tee … original end. Clears the (cut) start, keeps the end connection.
    expect(props(runOut).routePoints).toEqual([{ x: 400, y: 0 }, { x: 1000, y: 0 }]);
    expect(props(runOut).startConnection).toBeNull();
    expect(props(runOut).endConnection).toEqual({ kind: 'end' });
    expect(props(runOut).teeRole).toBe('run-out');
    expect(props(runOut).bundleId).toBe('tee-1-out');
  });

  it('gives each half a fresh, distinct id (never reuses the original run id)', () => {
    const run = makeGasRun();
    const [runIn, runOut] = buildTeeRunHalves(run, { x: 400, y: 0 }, 'tee-1')!;
    expect(runIn.id).not.toBe(run.id);
    expect(runOut.id).not.toBe(run.id);
    expect(runIn.id).not.toBe(runOut.id);
  });

  it('returns null when the station resolves to an endpoint (nothing to split off)', () => {
    expect(buildTeeRunHalves(makeGasRun(), { x: 0, y: 0 }, 'tee-1')).toBeNull();
  });
});
