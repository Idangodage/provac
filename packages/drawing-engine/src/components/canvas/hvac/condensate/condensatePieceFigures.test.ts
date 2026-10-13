import { beforeAll, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { generateCondensateNetwork } from './condensateGenerator';
import { condensateNetworkBaseline, condensatePieceFigures, fallStatus, headMarginStatus, type CondensateBaseline } from './condensatePieceFigures';
import { condensatePieceOf, condensateRunOf } from './condensatePieces';
import { resolveCondensateSettings } from './condensateSettings';
import { getCondensateOwnership, readCondensatePipeSpec } from './condensateTypes';

function cassette(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y }, rotation: 0, width: 950, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { capacityKw: 2.8 },
  };
}

const settings = resolveCondensateSettings({ soffitMm: 3400 });
let scene: HvacElement[];
let baseline: CondensateBaseline | null;
const pipeWhere = (match: (element: HvacElement) => boolean) => scene.find((element) => element.type === 'condensate-pipe' && match(element))!;
const branch = (unitId: string) => pipeWhere((element) => readCondensatePipeSpec(element).drainStart?.unitId === unitId);
const figures = (element: HvacElement, key: string) => {
  const run = condensateRunOf(element)!;
  return condensatePieceFigures(scene, element, run, condensatePieceOf(run, key)!, settings, baseline);
};

beforeAll(() => {
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  const units: HvacElement[] = [cassette('c-1', 0, 0), cassette('c-2', 3000, 0), cassette('c-3', 0, 3000), {
    id: 'fg', type: 'condensate-gully', position: { x: 6400, y: 3300 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: 'FG', supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  }];
  let ids = 0;
  scene = [...units, ...generateCondensateNetwork(units, { settings, idFactory: (prefix) => `${prefix}-${ids++}` }).elementsToAdd];
  const networkId = getCondensateOwnership(scene.find((element) => element.type === 'condensate-pipe')!)!.networkId;
  baseline = condensateNetworkBaseline(scene, networkId, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
});

describe('a condensate piece\'s figures', () => {
  it('solves the network once for its head margins, per drawing', () => {
    expect(baseline?.nodes.length).toBeGreaterThan(5);
    const networkId = getCondensateOwnership(branch('c-1'))!.networkId;
    expect(condensateNetworkBaseline(scene, networkId, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS })).toBe(baseline);
  });

  it('gives a leg its fall against the minimum, its capacity at that fall, its inverts, margin and supports', () => {
    const leg = figures(branch('c-1'), 'leg:1');
    expect(leg.system.label).toMatch(/BS EN 1329/);
    expect(leg.nominalSize).toBe('32');
    expect(leg.fall!.slopePercent).toBeGreaterThan(settings.minSlopePercent);
    expect(leg.fall!.ratio).toMatch(/^1:\d+$/);
    expect(leg.fall!.status).toBe('ok');
    expect(leg.capacity!.capacityLitresPerHour).toBeGreaterThan(leg.capacity!.designLitresPerHour);
    expect(leg.capacity!.status).toBe('ok');
    expect(leg.invert!.fromMm).toBeGreaterThan(leg.invert!.toMm);
    expect(leg.headMarginMm).not.toBeNull();
    expect(leg.headMarginMm!).toBeGreaterThanOrEqual(0);
    expect(leg.supports).toBeGreaterThan(0);
    expect(leg.unitsServed).toBe(1);
  });

  it('tells a leg\'s 45° level change apart from its fall', () => {
    const leg = figures(branch('c-1'), 'leg:2');
    expect(leg.fall!.offsets.count).toBeGreaterThanOrEqual(1);
    expect(leg.fall!.offsets.dropMm).toBeGreaterThan(30);
    expect(leg.fall!.slopePercent).toBeLessThan(10);
  });

  it('gives a riser its lift against the unit\'s pump head, and the hose at the unit', () => {
    const riser = figures(branch('c-1'), 'riser');
    expect(riser.lift!.liftMm).toBeGreaterThan(400);
    expect(riser.lift!.pumpHeadMm).toBeGreaterThanOrEqual(riser.lift!.liftMm - 1);
    expect(riser.lift!.unitLabel).toBe('C-1');
    const hose = figures(branch('c-1'), 'start');
    expect(hose.connection).toMatchObject({ unitLabel: 'C-1', pumped: true });
    expect(hose.connection!.hoseMm).toBeGreaterThan(100);
    expect(hose.fall).toBeNull();
  });

  it('says how a run ends: into a main by a wye, or into the drop', () => {
    expect(figures(branch('c-2'), 'end').end).toEqual({ kind: 'wye', into: 'CD 32 main' });
    const feedsDrop = pipeWhere((element) => {
      const spec = readCondensatePipeSpec(element);
      const next = scene.find((candidate) => candidate.type === 'condensate-pipe' && readCondensatePipeSpec(candidate).drainStart?.nodeId === spec.drainEnd?.nodeId);
      return spec.segmentRole === 'main' && Boolean(next) && readCondensatePipeSpec(next!).segmentRole === 'drop';
    });
    expect(figures(feedsDrop, 'end').end).toEqual({ kind: 'drop', into: 'FG' });
  });

  it('gives the drop its termination: the gully, its trap, its air break and the drop', () => {
    const drop = figures(pipeWhere((element) => readCondensatePipeSpec(element).segmentRole === 'drop'), 'termination');
    expect(drop.termination).toMatchObject({ kind: 'floor-gully', gullyLabel: 'FG', trap: 'tundish', airBreakMm: 25 });
    expect(drop.termination!.dropMm).toBeGreaterThan(2000);
  });

  it('judges falls against the minimum and margins against 100 / 40 mm', () => {
    expect(fallStatus(0.5, 1)).toBe('over');
    expect(fallStatus(1.05, 1)).toBe('near');
    expect(fallStatus(2, 1)).toBe('ok');
    expect(fallStatus(-0.2, 1)).toBe('over');
    expect(headMarginStatus(150)).toBe('ok');
    expect(headMarginStatus(60)).toBe('near');
    expect(headMarginStatus(10)).toBe('over');
  });
});
