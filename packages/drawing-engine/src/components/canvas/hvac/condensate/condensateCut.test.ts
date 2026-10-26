import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { condensateOpenEnds, cutCondensatePieces, readDrainGaps } from './condensateCut';
import type { CondensateEditContext } from './condensateEditing';
import { proposeCondensateGap } from './condensateGapProposal';
import { generateCondensateNetwork } from './condensateGenerator';
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

function baseScene(): HvacElement[] {
  const units = [cassette('c-1', 0, 0), cassette('c-2', 3000, 0), cassette('c-3', 0, 3000), gully('fg', 6500, 3400)];
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
const branchOf = (scene: readonly HvacElement[], unitId: string) => pipes(scene).find((pipe) => readCondensatePipeSpec(pipe).drainStart?.unitId === unitId)!;
const errors = (scene: HvacElement[]) => validateCondensateNetwork(scene, { settings, routingSettings: DEFAULT_PIPE_ROUTING_SETTINGS }).issues
  .filter((issue) => issue.level === 'error').map((issue) => issue.code);
const ids = () => { let n = 0; return (kind: 'run' | 'gap') => `${kind}-${(n += 1)}`; };

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('deleting pieces of a condensate drain', () => {
  it('a leg of a unit\'s run: the run in two, the rest of the network as it was, the gap remembered', () => {
    const scene = baseScene();
    const branch = branchOf(scene, 'c-1');
    const leg = condensateRunOf(branch)!.pieces.filter((piece) => piece.kind === 'leg').sort((a, b) => b.lengthMm - a.lengthMm)[0]!;
    const result = cutCondensatePieces(scene, [{ runId: branch.id, key: leg.key }], { newId: ids() });
    expect(result.pieces).toBe(1);
    expect(result.gaps).toBe(1);
    const after = applied(scene, result);
    // Nothing else changed.
    for (const pipe of pipes(scene)) if (pipe.id !== branch.id) expect(after.find((element) => element.id === pipe.id)).toBe(pipe);
    const first = after.find((element) => element.id === branch.id)!;
    const second = result.add[0]!;
    expect(readCondensatePipeSpec(first).drainStart?.unitId).toBe('c-1');
    expect(readCondensatePipeSpec(first).drainEnd).toBeNull();
    expect(readCondensatePipeSpec(second).drainStart).toBeNull();
    expect(readDrainGaps(first).end).toMatchObject({ id: 'gap-1', partner: { runId: second.id, end: 'start' } });
    expect(condensateOpenEnds(after)).toHaveLength(2);
    // The levels kept: each part's nodes are the run's own.
    const nodes = condensateRunOf(branch)!.nodes;
    expect(condensateRunOf(first)!.nodes[0]).toEqual(nodes[0]);
    // The network is hand-edited now, and the design checks name the open end.
    expect(getCondensateOwnership(first)?.editPolicy).toBe('retain');
    expect(errors(after)).toContain('CD_OPEN_END');
  });

  it('"As it was" puts the stretch back exactly: the run as it was, no open end', () => {
    const scene = baseScene();
    const branch = branchOf(scene, 'c-1');
    const leg = condensateRunOf(branch)!.pieces.filter((piece) => piece.kind === 'leg').sort((a, b) => b.lengthMm - a.lengthMm)[0]!;
    const after = applied(scene, cutCondensatePieces(scene, [{ runId: branch.id, key: leg.key }], { newId: ids() }));
    const gapId = condensateOpenEnds(after)[0]!.gap.id;
    const best = proposeCondensateGap(after, gapId, context).candidates[0]!;
    expect(best.key).toBe('as-before');
    const restored = applied(after, best);
    expect(condensateOpenEnds(restored)).toHaveLength(0);
    const run = restored.find((element) => element.id === branch.id)!;
    const spec = readCondensatePipeSpec(run);
    const original = readCondensatePipeSpec(branch);
    // Exactly the run it was: its 3D centreline, its plan route and its ends as stored.
    expect(spec.routeNodes3d).toEqual(original.routeNodes3d);
    expect(run.properties.routePoints).toEqual(branch.properties.routePoints);
    expect(JSON.stringify(run.properties.drainEnd)).toBe(JSON.stringify(branch.properties.drainEnd));
    expect(spec.drainEnd).toEqual(original.drainEnd);
    expect(spec.fittings.map((fitting) => fitting.kind).sort()).toEqual(original.fittings.map((fitting) => fitting.kind).sort());
    expect(errors(restored)).toEqual(errors(scene));
  });

  it('routed again: the joined run solved with the network, the gap closed, the network as sound as before', () => {
    const scene = baseScene();
    const branch = branchOf(scene, 'c-1');
    const leg = condensateRunOf(branch)!.pieces.filter((piece) => piece.kind === 'leg').sort((a, b) => b.lengthMm - a.lengthMm)[0]!;
    const after = applied(scene, cutCondensatePieces(scene, [{ runId: branch.id, key: leg.key }], { newId: ids() }));
    // Without the stretch it remembered, only a routed way is left.
    const forgotten = after.map((element) => {
      const gaps = readDrainGaps(element);
      return gaps.end ? { ...element, properties: { ...element.properties, drainGap: { ...element.properties.drainGap as object, end: { ...gaps.end, removed: null } } } } : element;
    });
    const gapId = condensateOpenEnds(forgotten)[0]!.gap.id;
    const proposals = proposeCondensateGap(forgotten, gapId, context);
    const routed = proposals.candidates.find((candidate) => candidate.key === 'shortest');
    expect(routed, proposals.reason ?? '').toBeDefined();
    expect(routed!.note).toMatch(/levels solved again/);
    const joined = applied(forgotten, routed!);
    expect(condensateOpenEnds(joined)).toHaveLength(0);
    expect(errors(joined)).toEqual(errors(scene));
  });

  it('a rodding eye goes and the run stays whole', () => {
    const scene = baseScene();
    const withEye = pipes(scene).find((pipe) => condensateRunOf(pipe)!.pieces.some((piece) => piece.kind === 'eye'));
    if (!withEye) return;
    const eye = condensateRunOf(withEye)!.pieces.find((piece) => piece.kind === 'eye')!;
    const result = cutCondensatePieces(scene, [{ runId: withEye.id, key: eye.key }], { newId: ids() });
    expect(result.add).toHaveLength(0);
    const after = applied(scene, result);
    expect(readCondensatePipeSpec(after.find((element) => element.id === withEye.id)!).fittings.some((fitting) => fitting.kind === 'cleanout')).toBe(false);
  });

  it('a locked run is refused', () => {
    const scene = baseScene().map((element) => (isCondensatePipe(element) ? { ...element, properties: { ...element.properties, locked: true } } : element));
    const branch = branchOf(scene, 'c-1');
    const leg = condensateRunOf(branch)!.pieces.find((piece) => piece.kind === 'leg')!;
    expect(cutCondensatePieces(scene, [{ runId: branch.id, key: leg.key }]).refused[0]!.reason).toMatch(/locked/);
  });
});
