import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { cutDuctPieces, ductOpenEnds } from './ductCut';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRunSpec } from './ductFabricationPlanner';
import { extendDuctRunAtStart, joinCorner, joinDuctRuns } from './ductJoin';
import { ductSegments } from './ductSegments';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec } from './ductTypes';

const settings = resolveDuctSettings({});
const noWalls = { walls: [], rooms: [] };
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const P = (along: number, across = 0): Point2D => ({ x: supply.lip.x + across, y: supply.lip.y - along });

/** 600×300 down 3 m, a turn, 5 m on, a reduction to 500×300 for 2 m, an end cap. */
function main(): HvacElement {
  return buildDuctRunDraftElement({
    port: supply, points: [P(3000), P(3000, 5000), P(3000, 7000)],
    legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }, { widthMm: 500, heightMm: 300 }],
  }, 'main');
}

function cutLeg(scene: readonly HvacElement[]) {
  let n = 0;
  const result = cutDuctPieces(scene, [{ runId: 'main', key: 'leg:1' }], { settings, building: noWalls, newId: (kind) => `${kind}-${(n += 1)}` });
  const replaced = new Map(result.updates.map((element) => [element.id, element]));
  return [...scene.map((element) => replaced.get(element.id) ?? element), ...result.add];
}

const ref = (scene: readonly HvacElement[], id: string) => {
  const element = scene.find((candidate) => candidate.id === id)!;
  return { element, spec: readDuctRunSpec(element)! };
};

describe('joining duct runs drawn by hand', () => {
  it('the corner that brings a run in square to an open start (none when it comes in straight on)', () => {
    expect(joinCorner({ x: 0, y: 0, z: 2500 }, { x: 1000, y: 0, z: 2500 }, { x: 1, y: 0 })).toBeNull();
    expect(joinCorner({ x: 0, y: 600, z: 2500 }, { x: 1000, y: 0, z: 2500 }, { x: 1, y: 0 })).toEqual({ x: 0, y: 0, z: 2500 });
    expect(joinCorner({ x: 0, y: 0, z: 2500 }, { x: 1000, y: 800, z: 2500 }, { x: 0, y: 1 })).toEqual({ x: 1000, y: 0, z: 2500 });
  });

  it('drawn back from an open start: the run reaches further, what is on it keeps its place', () => {
    const scene = cutLeg([unit, main()]);
    const second = ref(scene, 'run-1');
    const start = second.spec.path[0]!;
    const drawn = [{ x: start.x - 400, y: start.y, z: start.z }, { x: start.x - 400, y: start.y + 600, z: start.z }];
    const { spec, shift } = extendDuctRunAtStart(second.spec, drawn, [{ widthMm: 600, heightMm: 300 }, { widthMm: 400, heightMm: 300 }]);
    expect(shift).toBe(2);
    expect(spec.path.slice(0, 3)).toEqual([drawn[1], drawn[0], start]);
    // The leg drawn last is the run's first now.
    expect(spec.legs.slice(0, 2)).toEqual([{ widthMm: 400, heightMm: 300 }, { widthMm: 600, heightMm: 300 }]);
    expect(spec.start).toMatchObject({ kind: 'open', gap: { partner: { runId: 'main', end: 'end' } } });
  });

  it('a gap closed by a stretch drawn round something: one run, its turns where they were drawn', () => {
    const scene = cutLeg([unit, main()]);
    const a = ref(scene, 'main');
    const b = ref(scene, 'run-1');
    const pA = a.spec.path[a.spec.path.length - 1]!;
    const pB = b.spec.path[0]!;
    // Up 800 mm, across, and down again onto the second part's line (the last corner from joinCorner).
    const up = { x: pA.x + 800, y: pA.y - 800, z: pA.z };
    const across = { x: pB.x - 800, y: pA.y - 800, z: pA.z };
    const via = [{ x: pA.x + 800, y: pA.y, z: pA.z }, up, across, joinCorner(across, pB, { x: 1, y: 0 })!];
    const joined = joinDuctRuns(scene, a, b, via, { building: noWalls });
    expect(joined.removeIds).toEqual(['run-1']);
    const after = [...scene.filter((element) => element.id !== 'run-1' && element.id !== 'main'), joined.updates[0]!];
    const plan = planDuctRunSpec('main', joined.spec, { settings, scene: after, building: noWalls });
    expect(ductSegments(plan).filter((segment) => segment.kind === 'elbow')).toHaveLength(5);
    expect(plan.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(ductOpenEnds(after)).toHaveLength(0);
  });
});
