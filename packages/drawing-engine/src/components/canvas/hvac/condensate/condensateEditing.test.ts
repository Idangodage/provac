import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import {
  createCondensateEditSession,
  followCondensateDrains,
  isUnitBranchSpec,
  readCondensateNetworkModel,
  type CondensateEditContext,
  type CondensateEditResult,
} from './condensateEditing';
import { generateCondensateNetwork } from './condensateGenerator';
import { getIndoorUnitDrainPort } from './condensatePorts';
import {
  fixedPrefixLength,
  insertRouteVertex,
  moveRiserFoot,
  moveRouteVertex,
  offsetRouteLeg,
  removeRouteVertex,
  translateRouteInterior,
} from './condensateRouteOps';
import { resolveCondensateSettings } from './condensateSettings';
import { getCondensateOwnership, readCondensatePipeSpec, type Point3 } from './condensateTypes';
import { validateCondensateNetwork } from './condensateValidation';

function cassette(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y }, rotation: 0, width: 950, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { capacityKw: 2.8 },
  };
}

function gully(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'condensate-gully', position: { x: x - 100, y: y - 100 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: id.toUpperCase(), supplyZoneRatio: 0.5,
    properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  };
}

const settings = resolveCondensateSettings({ soffitMm: 3400 });
const context: CondensateEditContext = { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS };

function baseScene(): HvacElement[] {
  const units = [cassette('c-1', 0, 0), cassette('c-2', 3000, 0), cassette('c-3', 0, 3000), gully('fg', 6500, 3400)];
  let ids = 0;
  const generated = generateCondensateNetwork(units, { settings, idFactory: (prefix) => `${prefix}-${ids++}` });
  return [...units, ...generated.elementsToAdd];
}

function networkIdOf(scene: HvacElement[]): string {
  return getCondensateOwnership(scene.find((element) => element.type === 'condensate-pipe')!)!.networkId;
}

function applyResult(scene: HvacElement[], result: CondensateEditResult): HvacElement[] {
  const removed = new Set(result.removeIds);
  const updates = new Map(result.updates.map((element) => [element.id, element]));
  return [...scene.filter((element) => !removed.has(element.id)).map((element) => updates.get(element.id) ?? element), ...result.add];
}

function errors(scene: HvacElement[]): string[] {
  return validateCondensateNetwork(scene, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS }).issues
    .filter((issue) => issue.level === 'error').map((issue) => `${issue.code}: ${issue.message}`);
}

const planRun = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('condensate micro-editing engine', () => {
  it('re-solves an untouched network to the same runs and ids', () => {
    const scene = baseScene();
    const session = createCondensateEditSession(scene, networkIdOf(scene), context)!;
    const result = session.solve({}, { markEdited: false });
    expect(result.ok, result.message).toBe(true);
    expect(result.add).toEqual([]);
    expect(result.removeIds).toEqual([]);
    for (const updated of result.updates) {
      const before = readCondensatePipeSpec(scene.find((element) => element.id === updated.id)!).routeNodes3d;
      const after = readCondensatePipeSpec(updated).routeNodes3d;
      expect(after.length).toBe(before.length);
      after.forEach((node, index) => {
        expect(Math.hypot(node.x - before[index]!.x, node.y - before[index]!.y)).toBeLessThan(1);
        expect(Math.abs(node.z - before[index]!.z)).toBeLessThan(1);
      });
    }
    expect(errors(applyResult(scene, result))).toEqual([]);
  });

  it('moves, inserts and removes bends and legs; the fall follows and the run is kept on regeneration', () => {
    const scene = baseScene();
    const session = createCondensateEditSession(scene, networkIdOf(scene), context)!;
    const { model } = session;
    // The longest main-or-branch route with an editable bend.
    const [pipeId, route] = [...model.routes].filter(([id, candidate]) => candidate.length > fixedPrefixLength(isUnitBranchSpec(model.specs.get(id)!)) + 1)
      .sort((a, b) => b[1].length - a[1].length)[0]!;
    const prefix = fixedPrefixLength(isUnitBranchSpec(model.specs.get(pipeId)!));
    const bend = prefix;
    const moved = moveRouteVertex(route, bend, { x: route[bend]!.x + 250, y: route[bend]!.y + 250 }, prefix);
    const moveResult = session.solve({ routes: new Map([[pipeId, moved]]) });
    expect(moveResult.ok, moveResult.message).toBe(true);
    expect(moveResult.message).toMatch(/^Fall 1:\d+ · margin \d+ mm$/);
    const after = applyResult(scene, moveResult);
    expect(errors(after)).toEqual([]);
    const movedPipe = after.find((element) => element.id === pipeId)!;
    expect(readCondensatePipeSpec(movedPipe).routePoints.some((point) => planRun(point, moved[bend]!) < 1)).toBe(true);
    expect(getCondensateOwnership(movedPipe)!.editPolicy).toBe('retain');

    const inserted = insertRouteVertex(route, prefix - 1 + 1, { x: (route[prefix]!.x + route[prefix + 1]!.x) / 2, y: (route[prefix]!.y + route[prefix + 1]!.y) / 2 }, prefix);
    expect(inserted.length).toBe(route.length + 1);
    expect(removeRouteVertex(inserted, prefix + 1, prefix)).toEqual(route);

    const leg = offsetRouteLeg(route, prefix, { x: 180, y: 180 }, prefix);
    const legResult = session.solve({ routes: new Map([[pipeId, leg]]) });
    expect(legResult.ok, legResult.message).toBe(true);
    expect(errors(applyResult(scene, legResult))).toEqual([]);

    const whole = translateRouteInterior(route, { x: 0, y: 200 }, prefix);
    const wholeResult = session.solve({ routes: new Map([[pipeId, whole]]) });
    expect(wholeResult.ok, wholeResult.message).toBe(true);
    const shifted = applyResult(scene, wholeResult).find((element) => element.id === pipeId)!;
    const shiftedRoute = readCondensatePipeSpec(shifted).routePoints;
    // Ends stay attached.
    expect(planRun(shiftedRoute[0]!, route[0]!)).toBeLessThan(1);
    expect(planRun(shiftedRoute[shiftedRoute.length - 1]!, route[route.length - 1]!)).toBeLessThan(1);
  });

  it('moves a riser foot within reach of the outlet and keeps the riser plumb there', () => {
    const scene = baseScene();
    const session = createCondensateEditSession(scene, networkIdOf(scene), context)!;
    const branchId = session.model.unitBranchOf.get('c-2')!;
    const route = session.model.routes.get(branchId)!;
    const port = getIndoorUnitDrainPort(scene.find((element) => element.id === 'c-2')!, settings)!;
    // The hose must leave the socket outward before it can turn aside.
    const target = { x: port.point.x + 900, y: port.point.y - 300 };
    const moved = moveRiserFoot(route, target, settings.liftMaxHorizontalMm);
    expect(planRun(moved[1]!, port.point)).toBeCloseTo(settings.liftMaxHorizontalMm, 3);
    const result = session.solve({ routes: new Map([[branchId, moved]]) });
    expect(result.ok, result.message).toBe(true);
    const nodes = readCondensatePipeSpec(applyResult(scene, result).find((element) => element.id === branchId)!).routeNodes3d;
    expect(planRun(nodes[1]!, moved[1]!)).toBeLessThan(0.6);
    expect(planRun(nodes[1]!, nodes[2]!)).toBeLessThan(0.6);
    expect(nodes[2]!.z).toBeGreaterThan(nodes[1]!.z + 100);

    const sideways = moveRiserFoot(route, { x: port.point.x + 900, y: port.point.y - 900 }, settings.liftMaxHorizontalMm);
    const blocked = session.solve({ routes: new Map([[branchId, sideways]]) });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('no unobstructed connection from the drain outlet');
  });

  it('refuses edits that cannot drain, run through equipment, or change a locked run — with the reason', () => {
    const scene = baseScene();
    const session = createCondensateEditSession(scene, networkIdOf(scene), context)!;
    const branchId = session.model.unitBranchOf.get('c-3')!;
    const route = session.model.routes.get(branchId)!;
    // A 100 m detour needs far more fall than the void holds.
    const detour = insertRouteVertex(route, 1, { x: route[1]!.x - 50000, y: route[1]!.y }, 2);
    const short = session.solve({ routes: new Map([[branchId, detour]]) });
    expect(short.ok).toBe(false);
    expect(short.status).toBe('short');
    expect(short.message).toMatch(/C-3: .*(fall|drain)/);

    // Straight through the body of another cassette.
    const c1 = scene.find((element) => element.id === 'c-1')!;
    const through = insertRouteVertex(route, 1, { x: c1.position.x + c1.width / 2, y: c1.position.y + c1.depth / 2 }, 2);
    const blocked = session.solve({ routes: new Map([[branchId, through]]) });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('blocked');
    expect(blocked.message).toContain('C-1');

    const lockedScene = scene.map((element) => (element.id === branchId ? { ...element, properties: { ...element.properties, locked: true } } : element));
    const lockedSession = createCondensateEditSession(lockedScene, networkIdOf(scene), context)!;
    const nudged = offsetRouteLeg(route, 1, { x: 150, y: 150 }, 2);
    expect(nudged).not.toEqual(route);
    const locked = lockedSession.solve({ routes: new Map([[branchId, nudged]]) });
    expect(locked.status).toBe('locked');
  });

  it('deletes a run or re-routes it, and keeps design overrides on the network', () => {
    const scene = baseScene();
    const networkId = networkIdOf(scene);
    const session = createCondensateEditSession(scene, networkId, context)!;
    const branchId = session.model.unitBranchOf.get('c-2')!;

    const deleted = session.solve({ removePipeIds: [branchId] });
    expect(deleted.ok, deleted.message).toBe(true);
    expect(deleted.removeIds).toContain(branchId);
    const withoutC2 = applyResult(scene, deleted);
    expect(withoutC2.some((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).drainStart?.unitId === 'c-2')).toBe(false);
    expect(errors(withoutC2)).toEqual([]);

    const rerouted = session.solve({ rerouteUnitIds: ['c-2'] });
    expect(rerouted.ok, rerouted.message).toBe(true);
    expect(rerouted.generation!.perUnit.find((unit) => unit.unitId === 'c-2')!.status).not.toBe('infeasible');

    const mainId = [...session.model.specs].find(([, spec]) => spec.segmentRole === 'main')?.[0] ?? branchId;
    const overridden = session.solve({
      fallPercent: 1.5,
      liftLimitMm: { 'c-1': 200 },
      minOuterDiameterMm: { [mainId]: 50 },
      fittingEdits: { [branchId]: [{ action: 'add', kind: 'cleanout', point: session.model.routes.get(branchId)![2]! }] },
    });
    expect(overridden.ok, overridden.message).toBe(true);
    const next = applyResult(scene, overridden);
    expect(errors(next)).toEqual([]);
    const pipes = next.filter((element) => element.type === 'condensate-pipe');
    expect(pipes.every((element) => element.properties.designFallPercent === 1.5)).toBe(true);
    const c1Branch = pipes.find((element) => readCondensatePipeSpec(element).drainStart?.unitId === 'c-1')!;
    const c1Nodes = readCondensatePipeSpec(c1Branch).routeNodes3d;
    expect(c1Nodes[2]!.z - c1Nodes[1]!.z).toBeLessThanOrEqual(200.5);
    expect(readCondensatePipeSpec(next.find((element) => element.id === mainId)!).outerDiameterMm).toBeGreaterThanOrEqual(50);
    const withEye = readCondensatePipeSpec(next.find((element) => element.id === branchId)!);
    expect(withEye.fittings.some((fitting) => fitting.kind === 'cleanout' && fitting.note === 'placed by hand')).toBe(true);

    // A later edit keeps every override (they are read back from the pipes).
    const again = createCondensateEditSession(next, networkId, context)!.solve({});
    expect(again.ok, again.message).toBe(true);
    const kept = applyResult(next, again).find((element) => element.id === branchId)!;
    expect(readCondensatePipeSpec(kept).fittings.some((fitting) => fitting.note === 'placed by hand')).toBe(true);
    expect(kept.properties.designFallPercent).toBe(1.5);
  });

  it('keeps a run at or below a hand-set level limit, and refuses one the fall cannot meet', () => {
    const scene = baseScene();
    const networkId = networkIdOf(scene);
    const session = createCondensateEditSession(scene, networkId, context)!;
    const branchId = session.model.unitBranchOf.get('c-1')!;
    const before = readCondensatePipeSpec(scene.find((element) => element.id === branchId)!).routeNodes3d;
    const top = Math.max(...before.slice(2).map((node) => node.z));
    const cap = top - 120;
    const capped = session.solve({ levelCapMm: { [branchId]: cap } });
    expect(capped.ok, capped.message).toBe(true);
    const after = applyResult(scene, capped);
    expect(errors(after)).toEqual([]);
    const branch = after.find((element) => element.id === branchId)!;
    expect(branch.properties.levelCapMm).toBe(cap);
    const nodes = readCondensatePipeSpec(branch).routeNodes3d;
    // The outlet stays at the unit; everything from the riser top on is under the limit.
    expect(nodes.slice(2).every((node) => node.z <= cap + 0.5)).toBe(true);

    const cleared = createCondensateEditSession(after, networkId, context)!.solve({ levelCapMm: { [branchId]: null } });
    expect(cleared.ok, cleared.message).toBe(true);
    const restored = applyResult(after, cleared).find((element) => element.id === branchId)!;
    expect(restored.properties.levelCapMm).toBeUndefined();
    expect(Math.max(...readCondensatePipeSpec(restored).routeNodes3d.slice(2).map((node) => node.z))).toBeCloseTo(top, 0);

    const impossible = session.solve({ levelCapMm: { [branchId]: 1500 } });
    expect(impossible.ok).toBe(false);
    expect(impossible.status).toBe('short');
  });

  it('lets drains follow a moved unit and a moved gully in one step', () => {
    const scene = baseScene();
    const movedUnit = scene.map((element) => (element.id === 'c-2' ? { ...element, position: { x: element.position.x + 400, y: element.position.y + 250 } } : element));
    const follow = followCondensateDrains(scene, movedUnit, ['c-2'], context);
    expect(follow.messages).toEqual([]);
    expect(follow.updates.length).toBeGreaterThan(0);
    const afterUnit = applyResult(movedUnit, { ok: true, status: 'ok', message: '', elements: [], generation: null, ...follow });
    const port = getIndoorUnitDrainPort(afterUnit.find((element) => element.id === 'c-2')!, settings)!;
    const branch = afterUnit.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).drainStart?.unitId === 'c-2')!;
    const start = readCondensatePipeSpec(branch).routeNodes3d[0] as Point3;
    expect(planRun(start, port.point)).toBeLessThan(1);
    expect(errors(afterUnit)).toEqual([]);

    const movedGully = scene.map((element) => (element.id === 'fg' ? { ...element, position: { x: element.position.x - 600, y: element.position.y + 300 } } : element));
    const followGully = followCondensateDrains(scene, movedGully, ['fg'], context);
    expect(followGully.messages).toEqual([]);
    const afterGully = applyResult(movedGully, { ok: true, status: 'ok', message: '', elements: [], generation: null, ...followGully });
    const drop = afterGully.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).segmentRole === 'drop')!;
    const gullyCentre = { x: 6500 - 600, y: 3400 + 300 };
    expect(planRun(readCondensatePipeSpec(drop).routeNodes3d[0]!, gullyCentre)).toBeLessThan(1);
    expect(errors(afterGully)).toEqual([]);

    expect(readCondensateNetworkModel(afterGully, networkIdOf(scene))).not.toBeNull();
  });
});
