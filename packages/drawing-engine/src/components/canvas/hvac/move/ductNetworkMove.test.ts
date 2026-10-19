import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { tapOrigin } from '../duct/ductBranchTargets';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from '../duct/ductDraft';
import { planDuctRun } from '../duct/ductFabricationPlanner';
import { resolveDuctSettings } from '../duct/ductSettings';
import { typicalTerminalSpec } from '../duct/ductTerminalCatalog';
import { terminalEnvelope, terminalSpigotPort } from '../duct/ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctRunSpec } from '../duct/ductTypes';

import type { Vec3 } from './ductElasticMove';
import { moveDuctNetwork, type DuctSegmentRef } from './ductNetworkMove';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const lip = { x: supply.lip.x, y: supply.lip.y };
const at = (dx: number, dy: number, from: Point2D = lip) => ({ x: from.x + dx, y: from.y + dy });
const branchSection = { widthMm: 300, heightMm: 150 };

/** A square diffuser whose spigot (on `side`) has its lip's bottom at `lipBottom`. */
function terminalAt(id: string, lipBottom: { x: number; y: number; z: number }, side: 'back' | 'left' = 'back'): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), spigotSide: side };
  const envelope = terminalEnvelope(spec);
  const draft: HvacElement = {
    id, type: 'diffuser', position: { x: 0, y: 0 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: 0, mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
  const port = terminalSpigotPort(draft)!;
  return { ...draft, position: { x: lipBottom.x - port.lip.x, y: lipBottom.y - port.lip.y }, elevation: lipBottom.z + 100 - port.lip.z };
}

const moved = (element: HvacElement, d: Vec3): HvacElement => ({
  ...element, position: { x: element.position.x + d.x, y: element.position.y + d.y }, elevation: element.elevation + d.z,
});
const specOf = (runs: readonly HvacElement[], id: string): DuctRunSpec => readDuctRunSpec(runs.find((run) => run.id === id)!)!;
const xy = (spec: DuctRunSpec) => spec.path.map((point) => [Math.round(point.x * 100) / 100, Math.round(point.y * 100) / 100]);
const staleIssues = (element: HvacElement, scene: HvacElement[]) => planDuctRun(element, { settings, scene })!.issues.filter((issue) => issue.code === 'DU_STALE');

// ---- A collar main straight down −y, a take-off at 2000 to +x, its straight and a flexible runout to D1. ----
const main = buildDuctRunDraftElement({ port: supply, points: [at(0, -4000)] }, 'main');
const tap = tapOrigin(main, settings, { legIndex: 0, stationMm: 2000, side: 1, style: 'shoe-45', vcd: true }, branchSection) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
const tapPoint = tap.point;
const straightEnd = at(1500 * tap.direction.x, 1500 * tap.direction.y, tapPoint);
const d1 = terminalAt('d1', { x: straightEnd.x + 700, y: straightEnd.y + 500, z: tap.bottomZ - 150 });
const d1Lip = terminalSpigotPort(d1)!.lip;
const branch = buildDuctRunDraftElement({
  origin: tap, points: [straightEnd, { x: d1Lip.x, y: d1Lip.y, z: d1Lip.z - 100 }], legSizes: [branchSection, roundLeg(200)],
  end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
}, 'branch');
const scene = [unit, main, branch, d1];

function move(options: {
  before?: HvacElement[]; equipment?: Map<string, Vec3>; runs?: string[]; segment?: DuctSegmentRef; delta?: Vec3;
}) {
  const before = options.before ?? scene;
  const equipment = options.equipment ?? new Map<string, Vec3>();
  const after = before.map((element) => (equipment.has(element.id) ? moved(element, equipment.get(element.id)!) : element));
  const result = moveDuctNetwork({
    before, after, movedEquipmentIds: new Set(equipment.keys()), runIds: new Set(options.runs ?? []),
    segment: options.segment ?? null, delta: options.delta ?? { x: 0, y: 0, z: 0 }, settings,
  });
  const final = after.map((element) => result.runs.find((run) => run.id === element.id) ?? element);
  return { ...result, after: final };
}

describe('moveDuctNetwork: a unit moved alone (its ducts stretch, its diffusers stay)', () => {
  it('moved across its main: the main shifts with the collar, the branch straight shortens, the runout and D1 stay', () => {
    const result = move({ equipment: new Map([['fdum', { x: 200, y: 0, z: 0 }]]) });
    expect(result.runs.map((run) => run.id).sort()).toEqual(['branch', 'main']);
    expect(xy(specOf(result.runs, 'main'))).toEqual(xy(readDuctRunSpec(main)!).map(([x, y]) => [x! + 200, y!]));
    const before = readDuctRunSpec(branch)!;
    const after = specOf(result.runs, 'branch');
    expect(after.path[0]!.x - before.path[0]!.x).toBeCloseTo(200, 6);
    expect(xy(after).slice(1)).toEqual(xy(before).slice(1));
    expect(after.start).toMatchObject({ kind: 'tap', stationMm: 2000 });
    expect(result.outcomes.get('main')).toEqual({ kind: 'follows' });
    for (const id of ['main', 'branch']) expect(staleIssues(result.after.find((element) => element.id === id)!, result.after)).toEqual([]);
  });

  it('moved along its main: the main shortens, the take-off keeps its place in the room (its station shortens)', () => {
    const result = move({ equipment: new Map([['fdum', { x: 0, y: -300, z: 0 }]]) });
    const mainAfter = specOf(result.runs, 'main');
    expect(mainAfter.path[1]).toMatchObject(readDuctRunSpec(main)!.path[1]!);
    const branchAfter = specOf(result.runs, 'branch');
    expect(branchAfter.start).toMatchObject({ kind: 'tap', stationMm: 1700 });
    expect(xy(branchAfter)).toEqual(xy(readDuctRunSpec(branch)!));
    expect(staleIssues(result.after.find((element) => element.id === 'branch')!, result.after)).toEqual([]);
  });
});

describe('moveDuctNetwork: moved together = moved rigidly', () => {
  it('the unit, its runs and its diffuser translate exactly; take-offs keep their stations', () => {
    const d = { x: 150, y: -250, z: 0 };
    const result = move({ equipment: new Map([['fdum', d], ['d1', d]]), runs: ['main', 'branch'], delta: d });
    for (const [id, element] of [['main', main], ['branch', branch]] as const) {
      const before = readDuctRunSpec(element)!;
      const after = specOf(result.runs, id);
      after.path.forEach((point, index) => {
        expect(point.x - before.path[index]!.x).toBeCloseTo(150, 6);
        expect(point.y - before.path[index]!.y).toBeCloseTo(-250, 6);
        expect(point.z).toBeCloseTo(before.path[index]!.z, 6);
      });
      expect(result.outcomes.get(id)?.kind).toBe('moved');
    }
    expect(specOf(result.runs, 'branch').start).toMatchObject({ stationMm: 2000 });
  });

  it('a unit and every diffuser it serves moved by one vector carry the ducts between them (not picked) rigidly', () => {
    const d = { x: -120, y: 340, z: 0 };
    const result = move({ equipment: new Map([['fdum', d], ['d1', d]]) });
    for (const [id, element] of [['main', main], ['branch', branch]] as const) {
      const before = readDuctRunSpec(element)!;
      specOf(result.runs, id).path.forEach((point, index) => {
        expect(point.x - before.path[index]!.x).toBeCloseTo(-120, 6);
        expect(point.y - before.path[index]!.y).toBeCloseTo(340, 6);
      });
      expect(result.outcomes.get(id)).toEqual({ kind: 'follows' });
    }
    // Its own diffuser left behind (another, unconnected one moved): the system is not moved whole, its ducts stretch.
    const d2 = terminalAt('d2', { x: 0, y: 0, z: 2000 });
    const partial = move({ before: [...scene, d2], equipment: new Map([['fdum', d], ['d2', d]]) });
    const branchAfter = specOf(partial.runs, 'branch');
    expect(branchAfter.path[branchAfter.path.length - 1]).toEqual(readDuctRunSpec(branch)!.path[2]);
  });
});

describe('moveDuctNetwork: runs and terminals moved on their own', () => {
  it('a moved diffuser re-bends only its flexible runout', () => {
    const result = move({ equipment: new Map([['d1', { x: 300, y: 200, z: 0 }]]) });
    expect(result.runs.map((run) => run.id)).toEqual(['branch']);
    const before = readDuctRunSpec(branch)!;
    const after = specOf(result.runs, 'branch');
    expect(xy(after).slice(0, 2)).toEqual(xy(before).slice(0, 2));
    expect(after.path[2]!.x - before.path[2]!.x).toBeCloseTo(300, 6);
    expect(after.path[2]!.y - before.path[2]!.y).toBeCloseTo(200, 6);
  });

  it('a selected branch dragged along its trunk slides its take-off; its runout still ends on D1', () => {
    const result = move({ runs: ['branch'], delta: { x: 0, y: -500, z: 0 } });
    const before = readDuctRunSpec(branch)!;
    const after = specOf(result.runs, 'branch');
    expect(after.start).toMatchObject({ kind: 'tap', stationMm: 2500 });
    expect(after.path[0]!.y - before.path[0]!.y).toBeCloseTo(-500, 6);
    expect(after.path[1]!.y - before.path[1]!.y).toBeCloseTo(-500, 6);
    expect(after.path[2]).toMatchObject(before.path[2]!);
    expect(result.outcomes.get('branch')).toEqual({ kind: 'moved' });
    expect(staleIssues(result.after.find((element) => element.id === 'branch')!, result.after)).toEqual([]);
  });

  it('a trunk dragged sideways offsets, the collar straight stretching; its branch keeps its diffuser', () => {
    const lMain = buildDuctRunDraftElement({ port: supply, points: [at(0, -1000), at(4000, -1000)] }, 'lmain');
    const lTap = tapOrigin(lMain, settings, { legIndex: 1, stationMm: 2000, side: -1, style: 'shoe-45', vcd: true }, branchSection) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
    const lStraight = at(1200 * lTap.direction.x, 1200 * lTap.direction.y, lTap.point);
    const d2 = terminalAt('d2', { x: lStraight.x + 400, y: lStraight.y - 600, z: lTap.bottomZ - 150 });
    const d2Lip = terminalSpigotPort(d2)!.lip;
    const lBranch = buildDuctRunDraftElement({
      origin: lTap, points: [lStraight, { x: d2Lip.x, y: d2Lip.y, z: d2Lip.z - 100 }], legSizes: [branchSection, roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'd2', portId: 'spigot', flex: true },
    }, 'lbranch');
    const result = move({ before: [unit, lMain, lBranch, d2], runs: ['lmain'], delta: { x: 0, y: -300, z: 0 } });
    const mainBefore = readDuctRunSpec(lMain)!;
    const mainAfter = specOf(result.runs, 'lmain');
    expect(mainAfter.path[0]).toMatchObject(mainBefore.path[0]!);
    expect(mainAfter.path[1]!.y - mainBefore.path[1]!.y).toBeCloseTo(-300, 6);
    expect(mainAfter.path[2]!.y - mainBefore.path[2]!.y).toBeCloseTo(-300, 6);
    const branchBefore = readDuctRunSpec(lBranch)!;
    const branchAfter = specOf(result.runs, 'lbranch');
    expect(branchAfter.path[0]!.y - branchBefore.path[0]!.y).toBeCloseTo(-300, 6);
    expect(xy(branchAfter).slice(1)).toEqual(xy(branchBefore).slice(1));
    expect(staleIssues(result.after.find((element) => element.id === 'lbranch')!, result.after)).toEqual([]);
  });
});

describe('moveDuctNetwork: a rigid runout straight into its terminal', () => {
  const gTap = tapOrigin(main, settings, { legIndex: 0, stationMm: 2000, side: 1, style: 'shoe-45', vcd: true }, branchSection) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
  const spigotAt = at(1800 * gTap.direction.x, 1800 * gTap.direction.y, gTap.point);
  const g1 = terminalAt('g1', { x: spigotAt.x, y: spigotAt.y, z: gTap.bottomZ }, 'left');
  const rigidBranch = buildDuctRunDraftElement({
    origin: gTap, points: [spigotAt], legSizes: [branchSection], end: { kind: 'terminal', terminalId: 'g1', portId: 'spigot', flex: false },
  }, 'rigid');
  const rigidScene = [unit, main, rigidBranch, g1];

  it('slides its take-off along the trunk when the terminal moves along it', () => {
    const result = move({ before: rigidScene, equipment: new Map([['g1', { x: 0, y: -400, z: 0 }]]) });
    const after = specOf(result.runs, 'rigid');
    expect(after.start).toMatchObject({ kind: 'tap', stationMm: 2400 });
    const before = readDuctRunSpec(rigidBranch)!;
    after.path.forEach((point, index) => expect(point.y - before.path[index]!.y).toBeCloseTo(-400, 6));
    expect(result.messages).toEqual([]);
  });

  it('keeps its take-off on the trunk and says so when the terminal goes past the trunk\'s end', () => {
    const result = move({ before: rigidScene, equipment: new Map([['g1', { x: 0, y: -2500, z: 0 }]]) });
    const after = specOf(result.runs, 'rigid');
    expect(after.start).toMatchObject({ kind: 'tap', stationMm: 4000 });
    expect(after.path[1]!.y - readDuctRunSpec(rigidBranch)!.path[1]!.y).toBeCloseTo(-2000, 3);
    expect(result.outcomes.get('rigid')?.note).toMatch(/no longer reaches G1/);
    // Named by what it serves (its label is the generic one), said once.
    expect(result.messages).toEqual(['The run to G1 can no longer reach it: re-route its runout.']);
  });
});

describe('moveDuctNetwork: a straight moved on its own', () => {
  // Collar → 1000 down → 2000 right → 1500 down → 2000 right, end cap; a take-off on the last straight.
  const dogleg = buildDuctRunDraftElement({ port: supply, points: [at(0, -1000), at(2000, -1000), at(2000, -2500), at(4000, -2500)] }, 'dog');
  const kTap = tapOrigin(dogleg, settings, { legIndex: 3, stationMm: 1000, side: 1, style: 'shoe-45', vcd: true }, branchSection) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
  const kBranch = buildDuctRunDraftElement({ origin: kTap, points: [at(1200 * kTap.direction.x, 1200 * kTap.direction.y, kTap.point)], legSizes: [branchSection] }, 'k');
  const doglegScene = [unit, dogleg, kBranch];

  it('moves sideways, the legs either side stretching and shortening; the rest stays', () => {
    const result = move({ before: doglegScene, segment: { runId: 'dog', legIndex: 2 }, delta: { x: 250, y: 80, z: 0 } });
    expect(result.segmentRefused).toBeNull();
    const before = xy(readDuctRunSpec(dogleg)!);
    expect(xy(specOf(result.runs, 'dog'))).toEqual([before[0], before[1], [before[2]![0]! + 250, before[2]![1]], [before[3]![0]! + 250, before[3]![1]], before[4]]);
    // The take-off on the last straight keeps its place in the room.
    const k = specOf(result.runs, 'k');
    expect(k.start).toMatchObject({ legIndex: 3, stationMm: 750 });
    expect(xy(k)).toEqual(xy(readDuctRunSpec(kBranch)!));
  });

  it('moves up on a riser and a drop made in it clear of its corners; later legs and take-offs are re-keyed', () => {
    const result = move({ before: doglegScene, segment: { runId: 'dog', legIndex: 2 }, delta: { x: 0, y: 0, z: 200 } });
    expect(result.segmentRefused).toBeNull();
    const before = readDuctRunSpec(dogleg)!;
    const after = specOf(result.runs, 'dog');
    const z0 = before.path[0]!.z;
    // Corner, a stub at the old level, the riser, the raised middle, the drop, a stub, corner.
    expect(after.path.map((point) => point.z - z0)).toEqual([0, 0, 0, 0, 200, 200, 0, 0, 0]);
    expect(after.legs).toHaveLength(8);
    // Each stub holds the corner's square-throat elbow (674/2 + 50) and the riser's (164/2 + 50), plus 50.
    const stub = 674 / 2 + 50 + 164 / 2 + 50 + 50;
    expect(after.path[3]!.y).toBeCloseTo(before.path[2]!.y - stub, 6);
    expect(after.path[6]!.y).toBeCloseTo(before.path[3]!.y + stub, 6);
    expect(specOf(result.runs, 'k').start).toMatchObject({ legIndex: 7, stationMm: 1000 });
    const issues = planDuctRun(result.after.find((element) => element.id === 'dog')!, { settings, scene: result.after })!.issues;
    expect(issues.filter((issue) => issue.code === 'DU_HARD_WAY_ELBOW')).toEqual([]);
    // The stubs hold their elbows; a 200 mm rise is short for two elbows of a 164 mm duct (the planner says so: 264 mm).
    expect(issues.filter((issue) => issue.code === 'DU_LEG_TOO_SHORT').map((issue) => issue.message)).toEqual([
      'Leg 4 is 64 mm too short for its fittings.', 'Leg 6 is 64 mm too short for its fittings.',
    ]);
  });

  it('refuses to rise on a straight too short for its elbows', () => {
    const short = buildDuctRunDraftElement({ port: supply, points: [at(0, -1000), at(2000, -1000), at(2000, -1800), at(4000, -1800)] }, 'short');
    const result = move({ before: [unit, short], segment: { runId: 'short', legIndex: 2 }, delta: { x: 0, y: 0, z: 200 } });
    expect(result.segmentRefused).toMatch(/too short to rise on its own/);
    expect(result.runs).toEqual([]);
  });

  it('refuses the first straight off the collar, and leaves the run alone', () => {
    const result = move({ before: doglegScene, segment: { runId: 'dog', legIndex: 0 }, delta: { x: 300, y: 0, z: 0 } });
    expect(result.segmentRefused).toMatch(/first straight leaves the unit's collar/);
    expect(result.runs).toEqual([]);
  });
});
