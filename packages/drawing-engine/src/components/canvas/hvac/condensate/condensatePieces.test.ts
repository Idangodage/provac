import { beforeAll, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { createCondensateEditSession } from './condensateEditing';
import { generateCondensateNetwork } from './condensateGenerator';
import {
  condensatePieceAtModelPoint,
  condensatePieceAtPlanPoint,
  condensatePieceEnds,
  condensatePieceMidpoint,
  condensatePieceOf,
  condensatePieceOutline,
  condensateRunOf,
  neighbourCondensatePiece,
  type CondensateRun,
} from './condensatePieces';
import { resolveCondensateSettings } from './condensateSettings';
import { getCondensateOwnership, readCondensatePipeSpec } from './condensateTypes';

function cassette(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y }, rotation: 0, width: 950, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { capacityKw: 2.8 },
  };
}

const settings = resolveCondensateSettings({ soffitMm: 3400 });

/** Three pumped cassettes draining to a floor gully: two branches into one main, a third main, the drop. */
function network(): HvacElement[] {
  const units: HvacElement[] = [cassette('c-1', 0, 0), cassette('c-2', 3000, 0), cassette('c-3', 0, 3000), {
    id: 'fg', type: 'condensate-gully', position: { x: 6400, y: 3300 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: 'FG', supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  }];
  let ids = 0;
  const generated = generateCondensateNetwork(units, { settings, idFactory: (prefix) => `${prefix}-${ids++}` });
  return [...units, ...generated.elementsToAdd];
}

let scene: HvacElement[];
const pipes = () => scene.filter((element) => element.type === 'condensate-pipe');
const runOf = (match: (element: HvacElement) => boolean): CondensateRun => condensateRunOf(pipes().find(match)!)!;
const branchOf = (unitId: string) => runOf((element) => readCondensatePipeSpec(element).drainStart?.unitId === unitId);
const kinds = (run: CondensateRun) => run.pieces.map((piece) => piece.key);

beforeAll(() => {
  setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  scene = network();
});

describe('a condensate run\'s pieces', () => {
  it('reads a pumped branch as its hose, its riser, its legs and bends, and how it ends', () => {
    const run = branchOf('c-1');
    expect(kinds(run)).toEqual(['start', 'riser', 'leg:1', 'bend:1', 'leg:2', 'end']);
    const hose = condensatePieceOf(run, 'start')!;
    expect(hose.kind).toBe('connection');
    expect(hose.planLengthMm).toBeGreaterThan(100);
    const riser = condensatePieceOf(run, 'riser')!;
    expect(riser.lengthMm).toBeGreaterThan(400);
    expect(riser.planLengthMm).toBeLessThan(1);
    // Its elbows: up into the riser and over at its top.
    expect(riser.fittings.filter((fitting) => fitting.kind === 'elbow-90')).toHaveLength(2);
    const bend = condensatePieceOf(run, 'bend:1')!;
    expect(bend.angleDeg).toBeCloseTo(90, 0);
    expect(bend.fittings.map((fitting) => fitting.kind)).toEqual(['elbow-90']);
    // The last leg carries the 45° step down into its joint.
    const last = condensatePieceOf(run, 'leg:2')!;
    expect(last.fallMm).toBeGreaterThan(30);
    expect(last.fittings.some((fitting) => fitting.kind === 'elbow-45')).toBe(true);
    expect(condensatePieceOf(run, 'end')!.point).not.toBeNull();
  });

  it('ends a branch that joins a main from the top at its wye', () => {
    const run = branchOf('c-2');
    expect(kinds(run)).toEqual(['start', 'riser', 'leg:1', 'bend:1', 'leg:2', 'bend:2', 'leg:3', 'end']);
    expect(condensatePieceOf(run, 'bend:2')!.angleDeg).toBeCloseTo(45, 0);
    const end = condensatePieceOf(run, 'end')!;
    expect(end.fittings.map((fitting) => fitting.kind)).toEqual(['wye']);
    // The wye sits on the main's centreline, below the branch's last point (it drops into the crown).
    expect(end.point!.z).toBeLessThan(run.nodes[run.nodes.length - 1]!.z);
  });

  it('puts a main\'s rodding eye and air vent at its head, before its first leg', () => {
    const run = runOf((element) => {
      const spec = readCondensatePipeSpec(element);
      return spec.segmentRole === 'main' && spec.fittings.some((fitting) => fitting.kind === 'air-vent');
    });
    const keys = kinds(run);
    const eye = keys.find((key) => key.startsWith('eye:'))!;
    const vent = keys.find((key) => key.startsWith('vent:'))!;
    expect(keys.indexOf(eye)).toBeLessThan(keys.indexOf('leg:1'));
    expect(keys.indexOf(vent)).toBeLessThan(keys.indexOf('leg:1'));
    expect(keys.at(-1)).toBe('end');
  });

  it('reads a drop as one termination, its tundish with it', () => {
    const run = runOf((element) => readCondensatePipeSpec(element).segmentRole === 'drop');
    expect(kinds(run)).toEqual(['termination']);
    const drop = run.pieces[0]!;
    expect(drop.fallMm).toBeGreaterThan(2000);
    expect(drop.fittings.map((fitting) => fitting.kind)).toContain('tundish');
  });

  it('steps along the run in flow order', () => {
    const run = branchOf('c-1');
    expect(neighbourCondensatePiece(run, 'riser', 1)?.key).toBe('leg:1');
    expect(neighbourCondensatePiece(run, 'riser', -1)?.key).toBe('start');
    expect(neighbourCondensatePiece(run, 'end', 1)).toBeNull();
  });

  it('picks the piece under a plan point, a fitting over its leg, a riser over the hose at its foot', () => {
    const run = branchOf('c-1');
    const leg = condensatePieceOf(run, 'leg:1')!;
    const middle = condensatePieceMidpoint(leg);
    expect(condensatePieceAtPlanPoint(run, middle)?.key).toBe('leg:1');
    expect(condensatePieceAtPlanPoint(run, condensatePieceOf(run, 'bend:1')!.point!)?.key).toBe('bend:1');
    expect(condensatePieceAtPlanPoint(run, condensatePieceOf(run, 'riser')!.point!)?.key).toBe('riser');
    expect(condensatePieceAtPlanPoint(run, { x: middle.x, y: middle.y + 400 })).toBeNull();
    // In 3D, by the centreline.
    expect(condensatePieceAtModelPoint(run, { ...middle, z: middle.z + 5 })?.key).toBe('leg:1');
    const main = runOf((element) => readCondensatePipeSpec(element).fittings.some((fitting) => fitting.kind === 'cleanout' && /head of main/.test(fitting.note ?? '')));
    const eye = main.pieces.find((piece) => piece.kind === 'eye')!;
    expect(condensatePieceAtPlanPoint(main, eye.point!)?.kind).toMatch(/eye|vent/);
  });

  it('outlines a leg as a band along it, with brackets at its ends; a riser as a ring', () => {
    const run = branchOf('c-1');
    const leg = condensatePieceOf(run, 'leg:1')!;
    const outline = condensatePieceOutline(run, leg);
    expect(outline.length).toBeGreaterThanOrEqual(4);
    expect(condensatePieceEnds(run, leg)).toHaveLength(2);
    const riser = condensatePieceOf(run, 'riser')!;
    expect(condensatePieceOutline(run, riser)).toHaveLength(28);
    expect(condensatePieceEnds(run, riser)).toEqual([]);
  });

  it('keeps its keys when the network is solved again', () => {
    const networkId = getCondensateOwnership(pipes()[0]!)!.networkId;
    const session = createCondensateEditSession(scene, networkId, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS })!;
    const result = session.solve({}, { markEdited: false });
    expect(result.ok).toBe(true);
    for (const pipe of pipes()) {
      const again = result.elements.find((element) => element.id === pipe.id)!;
      expect(kinds(condensateRunOf(again)!)).toEqual(kinds(condensateRunOf(pipe)!));
    }
  });
});

describe('picking a drain piece when zoomed out', () => {
  it('keeps the hose pickable along its length while the riser owns its foot', () => {
    const run = condensateRunOf(scene.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).drainStart?.unitId === 'c-1')!)!;
    const hose = condensatePieceOf(run, 'start')!;
    const foot = condensatePieceOf(run, 'riser')!.point!;
    const middle = condensatePieceMidpoint(hose);
    // A generous screen tolerance (a far zoom): the riser's reach covers the hose, yet the hose still wins along it.
    expect(condensatePieceAtPlanPoint(run, middle, 120)?.key).toBe('start');
    expect(condensatePieceAtPlanPoint(run, foot, 120)?.key).toBe('riser');
  });
});
