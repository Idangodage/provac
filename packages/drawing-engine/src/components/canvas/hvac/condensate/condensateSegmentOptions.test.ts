import { beforeAll, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import type { CondensateEditContext } from './condensateEditing';
import { generateCondensateNetwork } from './condensateGenerator';
import { condensatePieceOf, condensateRunOf } from './condensatePieces';
import {
  condensatePieceOptions,
  condensateValueOption,
  evaluateCondensateOption,
  type CondensateSegmentOption,
} from './condensateSegmentOptions';
import { resolveCondensateSettings } from './condensateSettings';
import { readCondensateGullySpec, readCondensatePipeSpec } from './condensateTypes';

function cassette(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y }, rotation: 0, width: 950, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { capacityKw: 2.8 },
  };
}

const settings = resolveCondensateSettings({ soffitMm: 3400 });
const context: CondensateEditContext = { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS };
let scene: HvacElement[];
const pipeWhere = (match: (element: HvacElement) => boolean) => scene.find((element) => element.type === 'condensate-pipe' && match(element))!;
const branch = (unitId: string) => pipeWhere((element) => readCondensatePipeSpec(element).drainStart?.unitId === unitId);
const optionsOn = (element: HvacElement, key: string) => {
  const run = condensateRunOf(element)!;
  return condensatePieceOptions(scene, element, run, condensatePieceOf(run, key)!, context);
};
const byId = (options: CondensateSegmentOption[], id: string) => options.find((option) => option.id === id);
const applied = (evaluation: ReturnType<typeof evaluateCondensateOption>) => {
  const removed = new Set(evaluation.removeIds ?? []);
  const replaced = new Map(evaluation.updates.map((element) => [element.id, element]));
  return [...scene.filter((element) => !removed.has(element.id)).map((element) => replaced.get(element.id) ?? element), ...(evaluation.add ?? [])];
};
/** Applied, or refused with a reason. */
const built = (evaluation: ReturnType<typeof evaluateCondensateOption>) => (evaluation.refused ? evaluation.refused.length > 5 : evaluation.updates.length > 0);

beforeAll(() => {
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  const units: HvacElement[] = [cassette('c-1', 0, 0), cassette('c-2', 3000, 0), cassette('c-3', 0, 3000), {
    id: 'fg', type: 'condensate-gully', position: { x: 6400, y: 3300 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: 'FG', supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  }];
  let ids = 0;
  scene = [...units, ...generateCondensateNetwork(units, { settings, idFactory: (prefix) => `${prefix}-${ids++}` }).elementsToAdd];
});

describe("a condensate leg's options", () => {
  it('offers the run one and two sizes up, its own marked, each solved through the network', () => {
    const element = branch('c-1');
    const options = optionsOn(element, 'leg:1');
    expect(byId(options, 'size:32')?.current).toBe(true);
    const up = byId(options, 'size:40')!;
    const evaluation = evaluateCondensateOption(scene, up, context);
    expect(evaluation.refused).toBeUndefined();
    expect(evaluation.verdict).toMatch(/Fall 1:\d+ · margin \d+ mm/);
    const resized = evaluation.updates.find((updated) => updated.id === element.id)!;
    expect(readCondensatePipeSpec(resized).nominalSize).toBe('40');
    // Ids are kept: the card stays on its run.
    expect(evaluation.add ?? []).toEqual([]);
  });

  it("sets the network's fall, and says it is the whole network", () => {
    const fall = byId(optionsOn(branch('c-1'), 'leg:1'), 'fall:2.5')!;
    expect(fall.detail).toMatch(/the whole network/);
    const evaluation = evaluateCondensateOption(scene, fall, context);
    expect(built(evaluation)).toBe(true);
    if (!evaluation.refused) expect(evaluation.verdict).toMatch(/Fall 1:40/);
  });

  it('moves a leg sideways, adds a bend and a rodding eye at its middle', () => {
    const element = branch('c-1');
    const options = optionsOn(element, 'leg:1');
    const offsets = options.filter((option) => option.group === 'offset');
    expect(offsets).toHaveLength(4);
    for (const option of [...offsets, byId(options, 'add-bend')!, byId(options, 'eye:add')!]) {
      expect(built(evaluateCondensateOption(scene, option, context))).toBe(true);
    }
    const eye = evaluateCondensateOption(scene, byId(options, 'eye:add')!, context);
    const after = eye.updates.find((updated) => updated.id === element.id)!;
    expect(readCondensatePipeSpec(after).fittings.some((fitting) => fitting.kind === 'cleanout')).toBe(true);
  });

  it('keeps the run under a level', () => {
    const element = branch('c-1');
    const evaluation = evaluateCondensateOption(scene, byId(optionsOn(element, 'leg:1'), 'level-cap:100')!, context);
    expect(built(evaluation)).toBe(true);
    if (evaluation.refused) return;
    const top = (pipe: HvacElement) => Math.max(...readCondensatePipeSpec(pipe).routeNodes3d.map((node) => node.z));
    expect(top(evaluation.updates.find((updated) => updated.id === element.id)!)).toBeLessThan(top(element));
  });

  it("judges the same option on another run as that run's own edit", () => {
    const one = byId(optionsOn(branch('c-1'), 'leg:1'), 'size:40')!;
    const two = byId(optionsOn(branch('c-3'), 'leg:1'), 'size:40')!;
    expect(evaluateCondensateOption(scene, two, context)).not.toBe(evaluateCondensateOption(scene, one, context));
  });
});

describe("the other pieces' options", () => {
  it("sets a riser's height up to the pump's head", () => {
    const lifts = optionsOn(branch('c-1'), 'riser').filter((option) => option.group === 'lift');
    expect(lifts.length).toBeGreaterThan(0);
    expect(lifts.every((option) => Number.parseInt(option.title, 10) <= 600)).toBe(true);
    expect(built(evaluateCondensateOption(scene, lifts[0]!, context))).toBe(true);
  });

  it('takes a plan bend out', () => {
    const remove = byId(optionsOn(branch('c-1'), 'bend:1'), 'remove-bend')!;
    expect(remove.disabledReason).toBeUndefined();
    expect(built(evaluateCondensateOption(scene, remove, context))).toBe(true);
  });

  it("slides a branch's wye along its main, or says there is no room", () => {
    const slides = optionsOn(branch('c-2'), 'end').filter((option) => option.group === 'wye');
    expect(slides).toHaveLength(4);
    for (const option of slides) expect(built(evaluateCondensateOption(scene, option, context))).toBe(true);
  });

  it('changes the termination and solves the network again round it', () => {
    const drop = pipeWhere((element) => readCondensatePipeSpec(element).segmentRole === 'drop');
    const options = optionsOn(drop, 'termination');
    expect(byId(options, 'termination:floor-gully')?.current).toBe(true);
    expect(byId(options, 'trap:tundish')?.current).toBe(true);
    const hepvo = evaluateCondensateOption(scene, byId(options, 'trap:hepvo')!, context);
    expect(hepvo.refused).toBeUndefined();
    expect(readCondensateGullySpec(hepvo.updates.find((updated) => updated.id === 'fg')!).terminalTrap).toBe('hepvo');
    const run = condensateRunOf(drop)!;
    const higher = condensateValueOption(drop, run, condensatePieceOf(run, 'termination')!, { kind: 'inlet', levelMm: 400 })!;
    const raised = evaluateCondensateOption(scene, higher, context);
    expect(built(raised)).toBe(true);
    if (raised.refused) return;
    const bottom = (pipe: HvacElement) => Math.min(...readCondensatePipeSpec(pipe).routeNodes3d.map((node) => node.z));
    const newDrop = applied(raised).find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).segmentRole === 'drop')!;
    expect(bottom(newDrop)).toBeGreaterThan(bottom(drop));
  });

  it('takes a rodding eye out', () => {
    const main = pipeWhere((element) => readCondensatePipeSpec(element).fittings.some((fitting) => fitting.kind === 'cleanout' && /head of main/.test(fitting.note ?? '')));
    const eye = optionsOn(main, 'eye:1').find((option) => option.id === 'eye:remove')!;
    const evaluation = evaluateCondensateOption(scene, eye, context);
    expect(evaluation.refused).toBeUndefined();
    const eyes = (pipe: HvacElement) => readCondensatePipeSpec(pipe).fittings.filter((fitting) => fitting.kind === 'cleanout').length;
    expect(eyes(evaluation.updates.find((updated) => updated.id === main.id)!)).toBeLessThan(eyes(main));
  });
});
