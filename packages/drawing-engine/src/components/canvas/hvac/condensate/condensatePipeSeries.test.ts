/**
 * Drains re-sized to another pipe series (PVC Schedule 40 after a switch to
 * IP): every network of another pipe re-solved along its own routes with the
 * drainage settings' series, as one command (one undo); routes kept.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { condensateBomRowIn, condensateBomToCsv, type CondensateBomRow } from './condensateBom';
import { drainNetworksOffSeries, resizeDrainNetworksToSeries } from './condensateEditController';
import { generateCondensateNetwork } from './condensateGenerator';
import { CONDENSATE_PIPE_SYSTEMS } from './condensatePipeCatalog';
import { resolveCondensateSettings } from './condensateSettings';
import { isCondensatePipe, readCondensatePipeSpec } from './condensateTypes';

const metric = resolveCondensateSettings({ pipeSystem: 'bs-en-1329' });

function cassette(id: string, x: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y: 0 }, rotation: 0, width: 950, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { capacityKw: 4 },
  };
}

const gully: HvacElement = {
  id: 'fg', type: 'condensate-gully', position: { x: 6900, y: 1400 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
  mountType: 'floor', label: 'FG', supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully' },
};

const state = () => useSmartDrawingStore.getState();
const pipes = () => state().hvacElements.filter(isCondensatePipe).map((element) => ({ id: element.id, spec: readCondensatePipeSpec(element) }));

describe('the drain bill of materials in IP', () => {
  it('gives lengths in ft and an insulation by its inch thickness; counts as they are; SI as written', () => {
    const rows: CondensateBomRow[] = [
      { category: 'Pipe', description: 'Metric uPVC waste (BS EN 1329) pipe (installed length)', size: '32', quantity: 6.46, unit: 'm' },
      { category: 'Pipe', description: 'Metric uPVC waste (BS EN 1329) stock lengths (3 m, +10 % waste)', size: '32', quantity: 3, unit: 'lengths' },
      { category: 'Insulation', description: '9 mm closed-cell insulation', size: '32', quantity: 6.46, unit: 'm' },
      { category: 'Fitting', description: 'Rodding eye / cleanout', size: '32', quantity: 2, unit: 'no.' },
    ];
    expect(rows.map((row) => condensateBomRowIn(row, 'si'))).toEqual(rows);
    const ip = rows.map((row) => condensateBomRowIn(row, 'ip'));
    expect(ip.map((row) => [row.description, row.quantity, row.unit])).toEqual([
      ['Metric uPVC waste (BS EN 1329) pipe (installed length)', 21.19, 'ft'],
      ['Metric uPVC waste (BS EN 1329) stock lengths (3 m (9.8 ft), +10 % waste)', 3, 'lengths'],
      ['3/8 in closed-cell insulation', 21.19, 'ft'],
      ['Rodding eye / cleanout', 2, 'no.'],
    ]);
    expect(condensateBomToCsv(rows, 'ip').split('\n')[3]).toBe('Insulation,3/8 in closed-cell insulation,32,21.19,ft');
  });
});

describe('drains re-sized to another pipe series', () => {
  beforeEach(() => {
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
    const scene = [cassette('c-1', 0), cassette('c-2', 3000), gully];
    const result = generateCondensateNetwork(scene, { settings: metric });
    useSmartDrawingStore.setState({ hvacElements: [...scene, ...result.elementsToAdd], selectedElementIds: [], selectedIds: [] });
    state().setCondensateSettings(metric);
    state().clearHistory();
  });

  afterEach(() => {
    useSmartDrawingStore.setState({ hvacElements: [] });
    state().setCondensateSettings(resolveCondensateSettings({}));
    state().clearHistory();
  });

  it('re-sizes every network of another pipe in Schedule 40, routes kept, in one undo', () => {
    const before = pipes();
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((pipe) => pipe.spec.pipeSystem === 'bs-en-1329')).toBe(true);
    expect(drainNetworksOffSeries(state().hvacElements, 'bs-en-1329')).toEqual([]);
    state().setCondensateSettings({ pipeSystem: 'astm-sch40' });
    expect(drainNetworksOffSeries(state().hvacElements, 'astm-sch40')).toHaveLength(1);
    expect(resizeDrainNetworksToSeries('Drains re-sized to PVC Schedule 40')).toEqual({ resized: 1, refused: [] });
    const after = pipes();
    const inch = new Set(CONDENSATE_PIPE_SYSTEMS['astm-sch40'].sizes.map((size) => size.nominalSize));
    expect(after.every((pipe) => pipe.spec.pipeSystem === 'astm-sch40' && inch.has(pipe.spec.nominalSize))).toBe(true);
    // The routes are kept (a 45° offset's points move with the new pipe's bend by a fraction of a millimetre).
    after.forEach((pipe, index) => {
      const was = before[index]!.spec.routePoints;
      expect(pipe.spec.routePoints).toHaveLength(was.length);
      pipe.spec.routePoints.forEach((point, k) => expect(Math.hypot(point.x - was[k]!.x, point.y - was[k]!.y)).toBeLessThan(2));
    });
    expect(drainNetworksOffSeries(state().hvacElements, 'astm-sch40')).toEqual([]);
    state().undo();
    expect(pipes().map((pipe) => [pipe.id, pipe.spec.pipeSystem, pipe.spec.nominalSize])).toEqual(before.map((pipe) => [pipe.id, pipe.spec.pipeSystem, pipe.spec.nominalSize]));
  });
});
