import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { condensateOpenEnds, cutCondensatePieces } from './condensateCut';
import { drainDrawStarts, drainDrawTargets, drawDrainAlong, nearestOnRoute, type DrainDrawStart } from './condensateDrawRoute';
import type { CondensateEditContext } from './condensateEditing';
import { generateCondensateNetwork } from './condensateGenerator';
import { seatedRiserFoot } from './condensateNetworkPlanner';
import { condensateRunOf } from './condensatePieces';
import { resolveCondensateSettings } from './condensateSettings';
import { getCondensateOwnership, isCondensatePipe, readCondensatePipeSpec } from './condensateTypes';
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

function network(units: HvacElement[]): HvacElement[] {
  let ids = 0;
  const generated = generateCondensateNetwork(units, { settings, idFactory: (prefix) => `${prefix}-${ids++}` });
  return [...units, ...generated.elementsToAdd];
}

/** A command applied as the store applies one: an update's properties merged over the element's own. */
function applied(scene: readonly HvacElement[], command: { updates?: readonly HvacElement[]; add?: readonly HvacElement[]; removeIds?: readonly string[] }): HvacElement[] {
  const replaced = new Map((command.updates ?? []).map((element) => [element.id, element]));
  const removed = new Set(command.removeIds ?? []);
  const merged = (element: HvacElement) => {
    const update = replaced.get(element.id);
    return update ? { ...element, ...update, properties: { ...element.properties, ...update.properties } } : element;
  };
  return [...scene.filter((element) => !removed.has(element.id)).map(merged), ...(command.add ?? [])];
}

const pipes = (scene: readonly HvacElement[]) => scene.filter(isCondensatePipe);
const branchOf = (scene: readonly HvacElement[], unitId: string) => pipes(scene).find((pipe) => readCondensatePipeSpec(pipe).drainStart?.unitId === unitId);
const errors = (scene: HvacElement[]) => validateCondensateNetwork(scene, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS }).issues
  .filter((issue) => issue.level === 'error').map((issue) => issue.code);
const ids = () => { let n = 0; return (kind: 'run' | 'gap') => `${kind}-${(n += 1)}`; };
const unitStart = (scene: readonly HvacElement[], unitId: string) => drainDrawStarts(scene, settings)
  .find((start): start is Extract<DrainDrawStart, { kind: 'unit' }> => start.kind === 'unit' && start.unitId === unitId);

/** Square turns from `from` to `to`: along x first, then y. */
const squareVia = (from: Point2D, to: Point2D): Point2D[] => (Math.abs(from.y - to.y) > 1 && Math.abs(from.x - to.x) > 1 ? [{ x: to.x, y: from.y }] : []);

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('the drain tool', () => {
  it('a unit that drains nowhere, drawn into a drain of a network: its branch joins with a wye, the network solved', () => {
    const base = network([cassette('c-1', 0, 0), cassette('c-2', 3000, 0), gully('fg', 6500, 3400)]);
    const scene = [...base, cassette('c-9', 4200, 1300)];
    const offered = unitStart(scene, 'c-9');
    expect(offered).toBeDefined();
    expect(unitStart(scene, 'c-1')).toBeUndefined();
    // It leaves by the riser foot Auto route seats, within reach of its outlet.
    const foot = seatedRiserFoot(scene, 'c-9', context);
    expect(foot).not.toBeNull();
    expect(Math.hypot(foot!.x - offered!.outlet.x, foot!.y - offered!.outlet.y)).toBeLessThanOrEqual(settings.liftMaxHorizontalMm + 1);
    const start = { ...offered!, foot: foot! };
    const targets = drainDrawTargets(scene, start!);
    expect(targets.partner).toBeNull();
    expect(targets.gullies.map((entry) => entry.id)).toEqual(['fg']);
    // The longest drain it may join, at the point of it nearest the unit.
    const main = targets.pipes.map((entry) => ({ entry, near: nearestOnRoute(entry.route, start!.foot)! })).sort((a, b) => a.near.distanceMm - b.near.distanceMm)[0]!;
    const drawn = drawDrainAlong(scene, start!, squareVia(start!.foot, main.near.point), { kind: 'pipe', pipeId: main.entry.id, point: main.near.point }, context);
    expect(drawn.ok, drawn.ok ? '' : drawn.message).toBe(true);
    if (!drawn.ok) return;
    const after = applied(scene, drawn);
    const branch = branchOf(after, 'c-9')!;
    expect(drawn.runId).toBe(branch.id);
    expect(drawn.add.map((element) => element.id)).toContain(branch.id);
    const networkId = getCondensateOwnership(pipes(base)[0]!)!.networkId;
    expect(getCondensateOwnership(branch)?.networkId).toBe(networkId);
    expect(pipes(after).every((pipe) => getCondensateOwnership(pipe)?.unitIds.includes('c-9') || !readCondensatePipeSpec(pipe).upstreamUnitIds.includes('c-9'))).toBe(true);
    expect(pipes(after).some((pipe) => readCondensatePipeSpec(pipe).fittings.some((fitting) => fitting.kind === 'wye'))).toBe(true);
    expect(drawn.note).toMatch(/levels solved for the .+ fall/);
    expect(errors(after)).toEqual(errors(base));
  });

  it('a unit drawn into a gully no network runs to: a new network, falling all the way', () => {
    const scene = [cassette('c-1', 0, 0), gully('fg', 3000, 2400)];
    const start = unitStart(scene, 'c-1')!;
    const targets = drainDrawTargets(scene, start);
    expect(targets.gullies).toEqual([expect.objectContaining({ id: 'fg', networkId: null })]);
    const drawn = drawDrainAlong(scene, start, squareVia(start.foot, targets.gullies[0]!.point), { kind: 'gully', gullyId: 'fg' }, context, { fallPercent: 2 });
    expect(drawn.ok, drawn.ok ? '' : drawn.message).toBe(true);
    if (!drawn.ok) return;
    expect(drawn.updates).toHaveLength(0);
    const after = applied(scene, drawn);
    const runs = pipes(after);
    expect(runs.length).toBeGreaterThan(0);
    const owners = new Set(runs.map((pipe) => getCondensateOwnership(pipe)?.networkId));
    expect(owners.size).toBe(1);
    expect(getCondensateOwnership(runs[0]!)).toMatchObject({ gullyId: 'fg', unitIds: ['c-1'], editPolicy: 'retain' });
    expect(runs.some((pipe) => readCondensatePipeSpec(pipe).designSlopePercent >= 2 - 1e-6)).toBe(true);
    expect(errors(after)).toEqual([]);
  });

  it('a unit drawn into a gully a network runs to: it joins that network', () => {
    const base = network([cassette('c-1', 0, 0), gully('fg', 3000, 2400)]);
    const scene = [...base, cassette('c-2', 0, 2400)];
    const start = unitStart(scene, 'c-2')!;
    const gullyTarget = drainDrawTargets(scene, start).gullies.find((entry) => entry.id === 'fg')!;
    expect(gullyTarget.networkId).toBe(getCondensateOwnership(pipes(base)[0]!)!.networkId);
    const drawn = drawDrainAlong(scene, start, squareVia(start.foot, gullyTarget.point), { kind: 'gully', gullyId: 'fg' }, context);
    expect(drawn.ok, drawn.ok ? '' : drawn.message).toBe(true);
    if (!drawn.ok) return;
    const after = applied(scene, drawn);
    expect(new Set(pipes(after).map((pipe) => getCondensateOwnership(pipe)?.networkId)).size).toBe(1);
    expect(branchOf(after, 'c-1')).toBeDefined();
    expect(branchOf(after, 'c-2')).toBeDefined();
    expect(errors(after)).toEqual(errors(base));
  });

  it('a unit\'s connection deleted: drawn again from its outlet to the run it fed, the gap closed', () => {
    const scene = network([cassette('c-1', 0, 0), cassette('c-2', 3000, 0), gully('fg', 6500, 3400)]);
    const branch = branchOf(scene, 'c-1')!;
    const connection = condensateRunOf(branch)!.pieces.find((piece) => piece.kind === 'connection');
    expect(connection).toBeDefined();
    const after = applied(scene, cutCondensatePieces(scene, [{ runId: branch.id, key: connection!.key }], { newId: ids() }));
    const offered = unitStart(after, 'c-1');
    expect(offered?.gapId).toBeTruthy();
    // Its network is hand-edited now (the cut): seated as part of it, the unit is not held back.
    const fed = condensateOpenEnds(after).find((end) => end.end === 'start')!;
    const editNetworkId = getCondensateOwnership(after.find((element) => element.id === fed.runId)!)!.networkId;
    expect(seatedRiserFoot(after, 'c-1', context)).toBeNull();
    const foot = seatedRiserFoot(after, 'c-1', { ...context, editNetworkId });
    expect(foot).not.toBeNull();
    const start = { ...offered!, foot: foot! };
    const targets = drainDrawTargets(after, start);
    expect(targets.partner).not.toBeNull();
    expect(targets.pipes).toHaveLength(0);
    const drawn = drawDrainAlong(after, start, squareVia(start.foot, targets.partner!), { kind: 'partner' }, context);
    expect(drawn.ok, drawn.ok ? '' : drawn.message).toBe(true);
    if (!drawn.ok) return;
    const joined = applied(after, drawn);
    expect(condensateOpenEnds(joined)).toHaveLength(0);
    expect(branchOf(joined, 'c-1')?.id).toBe(drawn.runId);
    expect(errors(joined)).toEqual(errors(scene));
  });

  it('a lone open end carried on into its network: not into a drain upstream of it, then into the termination', () => {
    const scene = network([cassette('c-1', 0, 0), cassette('c-2', 3000, 0), gully('fg', 6500, 3400)]);
    // The run that reaches the termination, cut at its end: what it fed is gone.
    const trunk = pipes(scene).find((pipe) => condensateRunOf(pipe)!.pieces.some((piece) => piece.kind === 'end')
      && readCondensatePipeSpec(pipe).upstreamUnitIds.length === 2) ?? pipes(scene).find((pipe) => condensateRunOf(pipe)!.pieces.some((piece) => piece.kind === 'end'))!;
    const end = condensateRunOf(trunk)!.pieces.find((piece) => piece.kind === 'end')!;
    const after = applied(scene, cutCondensatePieces(scene, [{ runId: trunk.id, key: end.key }], { newId: ids() }));
    const start = drainDrawStarts(after, settings).find((candidate) => candidate.kind === 'open-end');
    expect(start).toBeDefined();
    const targets = drainDrawTargets(after, start!);
    expect(targets.partner).toBeNull();
    const fed = new Set(readCondensatePipeSpec(trunk).upstreamUnitIds);
    for (const entry of targets.pipes) {
      const upstream = readCondensatePipeSpec(after.find((element) => element.id === entry.id)!).upstreamUnitIds;
      expect(upstream.every((unitId) => fed.has(unitId))).toBe(false);
    }
    expect(targets.gullies.map((entry) => entry.id)).toEqual(['fg']);
    const from = (start as Extract<DrainDrawStart, { kind: 'open-end' }>).point;
    const drawn = drawDrainAlong(after, start!, squareVia(from, targets.gullies[0]!.point), { kind: 'gully', gullyId: 'fg' }, context);
    expect(drawn.ok, drawn.ok ? '' : drawn.message).toBe(true);
    if (!drawn.ok) return;
    const closed = applied(after, drawn);
    expect(condensateOpenEnds(closed)).toHaveLength(0);
    expect(errors(closed)).not.toContain('CD_OPEN_END');
  });

  it('refuses a drain of a network with a gap open, and a pipe that is not a target', () => {
    const scene = network([cassette('c-1', 0, 0), cassette('c-2', 3000, 0), gully('fg', 6500, 3400)]);
    const branch = branchOf(scene, 'c-2')!;
    const leg = condensateRunOf(branch)!.pieces.filter((piece) => piece.kind === 'leg').sort((a, b) => b.lengthMm - a.lengthMm)[0]!;
    const cut = applied(scene, cutCondensatePieces(scene, [{ runId: branch.id, key: leg.key }], { newId: ids() }));
    const withUnit = [...cut, cassette('c-9', 3000, 2600)];
    const start = unitStart(withUnit, 'c-9')!;
    const targets = drainDrawTargets(withUnit, start);
    // The gapped network is out, its termination too; there is nothing else.
    expect(targets.pipes).toHaveLength(0);
    expect(targets.gullies).toHaveLength(0);
    expect(targets.reason).toMatch(/place a floor gully/);
    const anyPipe = pipes(withUnit)[0]!;
    const refused = drawDrainAlong(withUnit, start, [], { kind: 'pipe', pipeId: anyPipe.id, point: readCondensatePipeSpec(anyPipe).routePoints[1]! }, context);
    expect(refused.ok).toBe(false);
  });
});
