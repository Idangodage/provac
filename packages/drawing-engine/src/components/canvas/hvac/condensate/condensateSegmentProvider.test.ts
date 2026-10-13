import { beforeAll, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import type { VrfValidationReport } from '../../../../vrf/rules/validation-engine';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';
import type { SegmentFocus } from '../segments/segmentUiStore';

import { condensatePieceIssues, createCondensateSegmentProvider } from './CondensateSegmentCard';
import { generateCondensateNetwork } from './condensateGenerator';
import { condensateNetworkBaseline, condensatePieceFigures } from './condensatePieceFigures';
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
const EMPTY: VrfValidationReport = { issues: [], commitBlocked: false, counts: { error: 0, warning: 0, advisory: 0, information: 0 } };
const issue = (code: string, entityId: string, message = code, level: 'error' | 'warning' = 'error') => ({ id: `${code}:${entityId}`, code, level, message, entityId });
let scene: HvacElement[];
const branch = (unitId: string) => scene.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).drainStart?.unitId === unitId)!;
const focusOn = (runId: string, key: string): SegmentFocus => ({ domain: 'condensate', runId, key, anchorMark: null, view: '2d' });

beforeAll(() => {
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  const units: HvacElement[] = [cassette('c-1', 0, 0), cassette('c-2', 3000, 0), cassette('c-3', 0, 3000), {
    id: 'fg', type: 'condensate-gully', position: { x: 6400, y: 3300 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: 'FG', supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  }];
  let ids = 0;
  scene = [...units, ...generateCondensateNetwork(units, { settings, idFactory: (prefix) => `${prefix}-${ids++}` }).elementsToAdd];
});

describe('the condensate segment card', () => {
  const provider = () => createCondensateSegmentProvider({ settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS, report: EMPTY });

  it('heads each piece with what it is, its size and what matters about it', () => {
    const run = branch('c-1');
    const card = provider();
    const leg = card.model(scene, focusOn(run.id, 'leg:1'))!;
    expect(leg.head.title).toBe('Branch · leg 1');
    expect(leg.head.size).toBe('CD 32 · branch');
    expect(leg.head.detail).toMatch(/^fall 1:\d+ · \d+\.\d\d m$/);
    expect(leg.head.tag).toBe('CD-L1');
    expect(card.model(scene, focusOn(run.id, 'riser'))!.head.detail).toMatch(/of \d+ mm pump head/);
    expect(card.model(scene, focusOn(run.id, 'start'))!.head.title).toBe('Pumped hose · C-1');
    expect(card.model(scene, focusOn(run.id, 'bend:1'))!.head.title).toBe('Elbow 90°');
    expect(card.model(scene, focusOn(branch('c-2').id, 'end'))!.head.title).toBe('Wye into CD 32 main');
    const drop = scene.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).segmentRole === 'drop')!;
    expect(card.model(scene, focusOn(drop.id, 'termination'))!.head.title).toBe('Floor gully · FG');
  });

  it('steps along the run, and finds its piece again by kind and order after an edit', () => {
    const run = branch('c-1');
    const card = provider();
    const model = card.model(scene, focusOn(run.id, 'riser'))!;
    expect(model.neighbour(1)).toEqual({ key: 'leg:1', anchorMark: null });
    // A riser's height is its Edit tab's own; nothing of it is a row.
    expect(model.options.filter((option) => option.group === 'lift').every((option) => model.tabOf(option) === null)).toBe(true);
    const leg = card.model(scene, focusOn(run.id, 'leg:1'))!;
    const tabs = (group: string) => [...new Set(leg.options.filter((option) => option.group === group).map((option) => leg.tabOf(option)))];
    expect(tabs('size')).toEqual(['swap']);
    expect(tabs('eye')).toEqual(['add']);
    expect(tabs('add-bend')).toEqual(['add']);
    for (const group of ['fall', 'level-cap', 'offset']) expect(tabs(group)).toEqual([null]);
    const host = { evaluate: leg.evaluate, evaluations: new Map(), onPreview: () => undefined, onHover: () => undefined, onApply: () => undefined, result: () => null };
    expect(leg.edit(host)).not.toBeNull();
    expect(typeof card.commit).toBe('function');
    expect(card.rekey(scene, focusOn(run.id, 'leg:9'), { kind: 'leg', ordinal: 2 })?.key).toBe('leg:2');
    expect(card.rekey(scene, focusOn(run.id, 'leg:9'), { kind: 'leg', ordinal: 9 })).toBeNull();
    expect(card.rekey(scene.filter((element) => element.id !== run.id), focusOn(run.id, 'leg:1'), null)).toBeNull();
  });

  it('keeps each check to the piece it is about', () => {
    const element = branch('c-1');
    const run = condensateRunOf(element)!;
    const networkId = getCondensateOwnership(element)!.networkId;
    const baseline = condensateNetworkBaseline(scene, networkId, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS });
    const report: VrfValidationReport = {
      ...EMPTY,
      issues: [issue('CD_PUMP_LIFT', element.id), issue('CD_TRAP', 'c-1', 'trap', 'warning'), issue('CD_JOIN_FROM_TOP', element.id), issue('CD_SIZE_CAPACITY', element.id, 'size', 'warning'),
        issue('CD_PUMP_LIFT', 'other-pipe')],
    };
    const codesOn = (key: string) => {
      const piece = condensatePieceOf(run, key)!;
      return condensatePieceIssues(report, element, run, piece, condensatePieceFigures(scene, element, run, piece, settings, baseline)).map((line) => line.code);
    };
    expect(codesOn('riser')).toEqual(['CD_PUMP_LIFT']);
    expect(codesOn('start')).toEqual(['CD_TRAP']);
    expect(codesOn('end')).toEqual(['CD_JOIN_FROM_TOP']);
    expect(codesOn('leg:1')).toEqual(['CD_SIZE_CAPACITY']);
    expect(codesOn('bend:1')).toEqual([]);
  });
});
