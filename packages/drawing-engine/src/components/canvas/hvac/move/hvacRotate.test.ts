import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { tapOrigin } from '../duct/ductBranchTargets';
import { withActiveDuctBuilding } from '../duct/ductBuilding';
import { planObstacles, runClashes, runObstacles } from '../duct/ductCollarReroute';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from '../duct/ductDraft';
import { planDuctRun } from '../duct/ductFabricationPlanner';
import { ductLegs } from '../duct/ductGeometry';
import { resolveDuctSettings } from '../duct/ductSettings';
import { typicalTerminalSpec, type DuctTerminalKind } from '../duct/ductTerminalCatalog';
import { readDuctTerminalSpec, terminalEnvelope, terminalSpigotPort } from '../duct/ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctRunSpec } from '../duct/ductTypes';

import { turnPoint } from './ductNetworkMove';
import { hvacRotateLabel, planHvacMove, type HvacMoveContext, type HvacPlacementCheck } from './hvacMoveModel';

const ductSettings = resolveDuctSettings({});
const context: HvacMoveContext = { ductSettings };
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supplyPort = (element: HvacElement) => resolveUnitAirPorts(element).find((port) => port.kind === 'supply')!;
const supply = supplyPort(unit);
const at = (dx: number, dy: number, from: Point2D = supply.lip) => ({ x: from.x + dx, y: from.y + dy });

/** A terminal of `kind` whose spigot's lip is at `lip` (plan), its face at `elevation`. */
function terminalAt(id: string, kind: DuctTerminalKind, lip: Point2D, label: string, elevation = 2400): HvacElement {
  const spec = typicalTerminalSpec(kind, 200);
  const envelope = terminalEnvelope(spec);
  const draft: HvacElement = {
    id, type: 'diffuser', position: { x: 0, y: 0 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation, mountType: 'ceiling', label, supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
  const port = terminalSpigotPort(draft)!;
  return { ...draft, position: { x: lip.x - (port.lip.x - draft.position.x), y: lip.y - (port.lip.y - draft.position.y) } };
}

// ---- A collar main straight up 4000 mm, a take-off at 2000 mm to +x, its straight and a flexible runout to SAD-1. ----
const main = buildDuctRunDraftElement({ port: supply, points: [at(0, -4000)] }, 'main');
const tap = tapOrigin(main, ductSettings, { legIndex: 0, stationMm: 2000, side: 1, style: 'shoe-45', vcd: true }, { widthMm: 300, heightMm: 150 }) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
const straightEnd = at(1500 * tap.direction.x, 1500 * tap.direction.y, tap.point);
const d1 = terminalAt('d1', 'square-4way', { x: straightEnd.x + 400, y: straightEnd.y + 600 }, 'SAD-1');
const runoutTo = (terminal: HvacElement) => {
  const lip = terminalSpigotPort(terminal)!.lip;
  return { x: lip.x, y: lip.y, z: lip.z - 100 };
};
const branch = buildDuctRunDraftElement({
  origin: tap, points: [straightEnd, runoutTo(d1)], legSizes: [{ widthMm: 300, heightMm: 150 }, roundLeg(200)],
  end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
}, 'branch');
const scene = [unit, main, branch, d1];

const byId = (elements: readonly HvacElement[], id: string) => elements.find((element) => element.id === id);
const specIn = (elements: readonly HvacElement[], id: string): DuctRunSpec => readDuctRunSpec(byId(elements, id)!)!;
const after = (plan: { updated: HvacElement[] }, base: readonly HvacElement[] = scene) => base.map((element) => byId(plan.updated, element.id) ?? element);
const errors = (element: HvacElement, elements: readonly HvacElement[]) => planDuctRun(element, { settings: ductSettings, scene: [...elements] })!.issues
  .filter((issue) => issue.severity === 'error').map((issue) => issue.code);
/** Errors a run has after that it did not have before (by code). */
const newErrors = (id: string, before: readonly HvacElement[], now: readonly HvacElement[]) => {
  const was = errors(byId(before, id)!, before);
  return errors(byId(now, id)!, now).filter((code) => {
    const index = was.indexOf(code);
    if (index < 0) return true;
    was.splice(index, 1);
    return false;
  });
};
const turn = (ids: string[], angleDeg: number, extra: Partial<Parameters<typeof planHvacMove>[1]['rotation'] & object> = {}, base: HvacElement[] = scene, ctx = context) =>
  planHvacMove(base, { ids, delta: { x: 0, y: 0, z: 0 }, rotation: { angleDeg, ...extra } }, ctx);

describe('planHvacMove: a unit turned alone (its runs rejoin their route, its diffusers stay)', () => {
  for (const angle of [90, -90, 180]) {
    it(`turned ${angle}°: the main leaves the turned collar and rejoins its line before the take-off; the branch and SAD-1 are as they were`, () => {
      const plan = turn(['fdum'], angle);
      expect(plan.rotation).toMatchObject({ requestedDeg: angle, appliedDeg: angle });
      const turned = byId(plan.updated, 'fdum')!;
      expect(turned.rotation).toBe(((angle % 360) + 360) % 360);
      expect(turned.position).toEqual(unit.position);
      const elements = after(plan);
      const mainAfter = specIn(elements, 'main');
      const port = supplyPort(turned);
      expect(mainAfter.path[0]!.x).toBeCloseTo(port.lip.x, 6);
      expect(mainAfter.path[0]!.y).toBeCloseTo(port.lip.y, 6);
      expect(ductLegs(mainAfter)[0]!.direction.x).toBeCloseTo(port.normal.x, 6);
      expect(ductLegs(mainAfter)[0]!.direction.y).toBeCloseTo(port.normal.y, 6);
      expect(mainAfter.path[mainAfter.path.length - 1]).toEqual(readDuctRunSpec(main)!.path[1]);
      // The branch keeps its route; only its take-off's place on the main is renumbered.
      const branchAfter = specIn(elements, 'branch');
      expect(branchAfter.path).toEqual(readDuctRunSpec(branch)!.path);
      expect(branchAfter.start).toMatchObject({ kind: 'tap', legIndex: mainAfter.legs.length - 1 });
      expect(byId(plan.updated, 'd1')).toBeUndefined();
      for (const id of ['main', 'branch']) expect(newErrors(id, scene, elements)).toEqual([]);
      expect(plan.messages.join(' ')).toMatch(/rejoins its route round FDUM22 \(\d new elbows\)/);
      expect(plan.outcomes.get('main')).toEqual({ kind: 'follows' });
      expect(plan.label).toBe(angle === 180 ? 'Rotate FDUM22 180°' : `Rotate FDUM22 90° ${angle > 0 ? 'clockwise' : 'anticlockwise'}`);
    });
  }

  it('turned 45°: a stub leaves the turned collar at a new elbow and the main shifts to meet it; the branch stretches, SAD-1 stays', () => {
    const plan = turn(['fdum'], 45);
    const elements = after(plan);
    const turned = byId(elements, 'fdum')!;
    const port = supplyPort(turned);
    const mainAfter = specIn(elements, 'main');
    const legs = ductLegs(mainAfter);
    expect(mainAfter.path[0]!.x).toBeCloseTo(port.lip.x, 6);
    // (The solved run is stored to 0.01 mm: its directions to a few millionths.)
    expect(legs[0]!.direction.x).toBeCloseTo(port.normal.x, 4);
    expect(legs[0]!.direction.y).toBeCloseTo(port.normal.y, 4);
    // Then on its old heading (up the plan).
    expect(legs[1]!.direction.x).toBeCloseTo(0, 4);
    expect(legs[1]!.direction.y).toBeCloseTo(-1, 4);
    // The branch still hangs off the main and still ends on SAD-1.
    const branchAfter = specIn(elements, 'branch');
    expect(branchAfter.path[branchAfter.path.length - 1]).toEqual(readDuctRunSpec(branch)!.path[2]);
    expect(planDuctRun(byId(elements, 'branch')!, { settings: ductSettings, scene: elements })!.issues.filter((issue) => issue.code === 'DU_STALE')).toEqual([]);
    expect(plan.messages.join(' ')).toMatch(/leaves the turned collar at a new elbow/);
  });

  it('each in place: the unit turns about its own centre whatever the pivot', () => {
    const plan = turn(['fdum'], 90, { pivot: 'each' });
    expect(byId(plan.updated, 'fdum')!.position).toEqual(unit.position);
    expect(plan.rotation!.pivot).toBeNull();
  });
});

describe('planHvacMove: a turn of several (one block)', () => {
  it('the unit and its diffuser turned together: the whole system turns rigidly about the block centre', () => {
    const plan = turn(['fdum', 'd1'], 90);
    const pivot = plan.rotation!.pivot!;
    const elements = after(plan);
    for (const [id, run] of [['main', main], ['branch', branch]] as const) {
      const before = readDuctRunSpec(run)!;
      const now = specIn(elements, id);
      now.path.forEach((point, index) => {
        const expected = turnPoint(before.path[index]!, pivot, 90);
        expect(point.x).toBeCloseTo(expected.x, 6);
        expect(point.y).toBeCloseTo(expected.y, 6);
        expect(point.z).toBe(before.path[index]!.z);
      });
      expect(now.start).toEqual(before.start);
    }
    // Its spigot turned with it (its runout turned too).
    expect(readDuctTerminalSpec(byId(elements, 'd1')!)!.spigotSide).toBe('back');
    expect(plan.label).toBe('Rotate FDUM22 and SAD-1 90° clockwise');
  });

  it('stops at the placement rules: all or nothing for an exact turn, the last allowed angle for a drag', () => {
    const far = { ...unit, id: 'far', label: 'FDUM22 B', position: { x: 6000, y: 0 } };
    const base = [unit, far];
    // Room rule: a centre inside x < 6000.
    const place = (center: Point2D, element: HvacElement): HvacPlacementCheck => ({
      valid: center.x < 6000, invalidReason: center.x < 6000 ? null : 'Equipment must be placed inside a valid room.',
      point: { x: center.x - element.width / 2, y: center.y - element.depth / 2 }, rotationDeg: element.rotation,
      widthMm: element.width, depthMm: element.depth, heightMm: element.height, roomId: 'room', wallId: null,
    });
    // `far` already breaks the rule (it turns as it is); `fdum` swings out past x = 6000 at a quarter turn about the block centre.
    const ctx = { ...context, place };
    const exact = turn(['fdum', 'far'], 180, {}, base, ctx);
    expect(exact.updated).toEqual([]);
    expect(exact.messages[0]).toMatch(/^Cannot turn: FDUM22: Equipment must be placed inside a valid room\./);
    const dragged = turn(['fdum', 'far'], 180, { partial: true }, base, ctx);
    expect(dragged.fraction).toBeGreaterThan(0);
    expect(dragged.fraction).toBeLessThan(1);
    expect(dragged.messages[0]).toMatch(/^Stopped short:/);
  });
});

describe('planHvacMove: an air terminal turned', () => {
  it('a square diffuser keeps its spigot facing its runout (its side is chosen anew): its duct does not change', () => {
    const plan = turn(['d1'], 90);
    expect(plan.updated.map((element) => element.id)).toEqual(['d1']);
    const turned = byId(plan.updated, 'd1')!;
    expect(turned.rotation).toBe(90);
    expect(readDuctTerminalSpec(turned)!.spigotSide).toBe('left');
    const lipBefore = terminalSpigotPort(d1)!.lip;
    const lipAfter = terminalSpigotPort(turned)!.lip;
    expect(lipAfter.x).toBeCloseTo(lipBefore.x, 6);
    expect(lipAfter.y).toBeCloseTo(lipBefore.y, 6);
  });

  it('a linear slot turns its spigot with it: its flexible runout re-curves to the turned spigot', () => {
    const slot = terminalAt('l1', 'linear-slot', runoutTo(d1), 'LSD-1');
    const slotBranch = buildDuctRunDraftElement({
      origin: tap, points: [straightEnd, runoutTo(slot)], legSizes: [{ widthMm: 300, heightMm: 150 }, roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'l1', portId: 'spigot', flex: true },
    }, 'branch');
    const base = [unit, main, slotBranch, slot];
    const plan = turn(['l1'], 90, {}, base);
    const turned = byId(plan.updated, 'l1')!;
    expect(readDuctTerminalSpec(turned)!.spigotSide).toBe('back');
    const runout = specIn(after(plan, base), 'branch');
    const lip = terminalSpigotPort(turned)!.lip;
    const last = runout.path[runout.path.length - 1]!;
    expect(last.x).toBeCloseTo(lip.x, 6);
    expect(last.y).toBeCloseTo(lip.y, 6);
    expect(last.z).toBeCloseTo(lip.z - 100, 6);
    // Its rigid straight is where it was.
    expect(runout.path.slice(0, -1)).toEqual(readDuctRunSpec(slotBranch)!.path.slice(0, -1));
  });

  /** A rigid round run off a spin-in take-off: along +x, then down the plan into a linear slot's back spigot. */
  function rigidRunToSlot(elevation: number) {
    const spin = tapOrigin(main, ductSettings, { legIndex: 0, stationMm: 2000, side: 1, style: 'spin-in', vcd: true }, roundLeg(200)) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
    const corner = at(2300 * spin.direction.x, 2300 * spin.direction.y, spin.point);
    const slot = terminalAt('l1', 'linear-slot', at(0, 1000, corner), 'LSD-1', elevation);
    const lip = terminalSpigotPort(slot)!.lip;
    const rigidRun = buildDuctRunDraftElement({
      origin: spin, points: [corner, { x: lip.x, y: lip.y, z: lip.z - 100 }], legSizes: [roundLeg(200), roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'l1', portId: 'spigot', flex: false },
    }, 'branch');
    return { spin, slot, rigidRun, base: [unit, main, rigidRun, slot] };
  }

  it('a rigid run into a turned linear slot is re-aimed onto its spigot', () => {
    // The slot's spigot at the take-off's level (2670 mm), so the run is level all the way.
    const { spin, slot, rigidRun, base } = rigidRunToSlot(2590);
    expect(terminalSpigotPort(slot)!.lip.z - 100).toBeCloseTo(spin.bottomZ, 6);
    const plan = turn(['l1'], 90, {}, base);
    const elements = after(plan, base);
    const turned = byId(elements, 'l1')!;
    const port = terminalSpigotPort(turned)!;
    const run = specIn(elements, 'branch');
    const legs = ductLegs(run);
    const last = run.path[run.path.length - 1]!;
    expect(last.x).toBeCloseTo(port.lip.x, 6);
    expect(last.y).toBeCloseTo(port.lip.y, 6);
    // It comes in square to the turned spigot.
    expect(legs[legs.length - 1]!.direction.x).toBeCloseTo(-port.normal.x, 6);
    expect(legs[legs.length - 1]!.direction.y).toBeCloseTo(-port.normal.y, 6);
    expect(run.path[0]).toEqual(readDuctRunSpec(rigidRun)!.path[0]);
    expect(plan.messages.join(' ')).toMatch(/re-aimed onto LSD-1's turned spigot/);
    expect(newErrors('branch', base, elements)).toEqual([]);
    expect(plan.outcomes.get('branch')).toEqual({ kind: 'follows' });
  });

  it('a rigid run that drops just before the turned slot cannot be re-aimed: it reaches the spigot and says it meets it at an angle', () => {
    const { base } = rigidRunToSlot(2400);
    const plan = turn(['l1'], 90, {}, base);
    const elements = after(plan, base);
    const port = terminalSpigotPort(byId(elements, 'l1')!)!;
    const run = specIn(elements, 'branch');
    const last = run.path[run.path.length - 1]!;
    expect(last.x).toBeCloseTo(port.lip.x, 4);
    expect(last.y).toBeCloseTo(port.lip.y, 4);
    expect(plan.outcomes.get('branch')?.note).toBe("meets LSD-1's turned spigot at an angle: re-route its last straight.");
  });
});

describe('planHvacMove: a unit turned alone, its trunk a loop round a diffuser (as Auto duct lays two out)', () => {
  // The shape Auto duct gave an FDUM22 and two Ø200 diffusers on the canvas: a 250 × 250 trunk up from the collar
  // (a transition from the 674 × 164 collar first), across, down past the take-off to SAD-2, back towards the unit
  // (reducing to Ø200), up, and a runout to SAD-1. Its return passes just above where the turned unit reaches.
  const low: HvacElement = { ...unit, elevation: 2400 };
  const collar = supplyPort(low);
  const rel = (dx: number, dy: number) => ({ x: collar.lip.x + dx, y: collar.lip.y + dy });
  const square = { widthMm: 250, heightMm: 250 };
  const sad1 = terminalAt('sad1', 'square-4way', rel(-484, -1609), 'SAD-1');
  const sad2 = terminalAt('sad2', 'square-4way', rel(792, -1284), 'SAD-2');
  const loop = buildDuctRunDraftElement({
    port: collar,
    points: [rel(0, -2309), rel(1492, -2309), rel(1492, -284), rel(901, -284), rel(0, -284), rel(0, -609), runoutTo(sad1)],
    legSizes: [square, square, square, square, roundLeg(200), roundLeg(200), roundLeg(200)],
    end: { kind: 'terminal', terminalId: 'sad1', portId: 'spigot', flex: true },
  }, 'loop');
  const spin = tapOrigin(loop, ductSettings, { legIndex: 2, stationMm: 1359, side: 1, style: 'spin-in', vcd: true }, roundLeg(200)) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
  const toSad2 = buildDuctRunDraftElement({
    origin: spin, points: [at(250 * spin.direction.x, 250 * spin.direction.y, spin.point), runoutTo(sad2)], legSizes: [roundLeg(200), roundLeg(200)],
    end: { kind: 'terminal', terminalId: 'sad2', portId: 'spigot', flex: true },
  }, 'to-sad2');
  const looped = [low, loop, toSad2, sad1, sad2];

  for (const [angle, how] of [[90, /rejoins its route round FDUM22 \(3 new elbows\)/], [-90, /rejoins its route/], [180, /rejoins its route round FDUM22 \(4 new elbows\)/]] as const) {
    it(`turned ${angle}°: the trunk is re-routed off the turned collar (its transition first) onto its loop, clear of the casing, the diffusers and its own legs`, () => {
      const plan = turn(['fdum'], angle, {}, looped);
      expect(plan.messages.join(' ')).toMatch(how);
      const elements = after(plan, looped);
      const turned = byId(elements, 'fdum')!;
      const port = supplyPort(turned);
      const trunk = specIn(elements, 'loop');
      expect(trunk.path[0]!.x).toBeCloseTo(port.lip.x, 6);
      expect(trunk.path[0]!.y).toBeCloseTo(port.lip.y, 6);
      // Its first straight holds the connector and the collar's transition before it turns.
      expect(ductLegs(trunk)[0]!.lengthMm).toBeGreaterThan(1000);
      // Its new legs (up to where it joins the loop's old line) clash with nothing; the loop's own legs it keeps are as
      // they were (the turned casing reaching its return leg is the turn's own clash, which the design checks report).
      const oldPath = readDuctRunSpec(loop)!.path;
      const kept = trunk.path.findIndex((point, index) => index > 0 && oldPath.some((old) => old.x === point.x && old.y === point.y));
      // (The new corners run from the collar to the join on the old line, the point before the first old vertex.)
      const fresh: DuctRunSpec = { ...trunk, path: trunk.path.slice(0, kept), legs: trunk.legs.slice(0, kept - 1), end: { kind: 'open' } };
      expect(kept).toBeGreaterThan(2);
      expect(runClashes(fresh, [...planObstacles(elements, new Set(['loop', 'to-sad2'])), ...runObstacles('loop', trunk, kept)], { firstLegClearOf: new Set(['fdum']) })).toBe(false);
      // The take-off, its branch and both diffusers are where they were.
      expect(specIn(elements, 'to-sad2').path).toEqual(readDuctRunSpec(toSad2)!.path);
      expect(byId(plan.updated, 'sad1')).toBeUndefined();
      expect(byId(plan.updated, 'sad2')).toBeUndefined();
      for (const id of ['loop', 'to-sad2']) expect(newErrors(id, looped, elements)).toEqual([]);
      expect([...plan.outcomes.values()].filter((outcome) => outcome.note)).toEqual([]);
    });
  }

  it("a half turn with a wall 1.46 m in front of the turned collar: the collar's transition is made steeper (within SMACNA) and the trunk still goes round", () => {
    const wall = { id: 'w', a: { x: -5000, y: low.depth + 1460 }, b: { x: 5000, y: low.depth + 1460 }, thicknessMm: 200, baseZ: 0, topZ: 3000, structural: true };
    withActiveDuctBuilding([wall], [], () => {
      const plan = turn(['fdum'], 180, {}, looped);
      expect(plan.messages.join(' ')).toMatch(/rejoins its route round FDUM22/);
      const elements = after(plan, looped);
      const trunk = specIn(elements, 'loop');
      // Shorter than the connector and the transition at the design taper (254 + 960 mm), and nothing past the wall.
      expect(ductLegs(trunk)[0]!.lengthMm).toBeLessThan(1214);
      expect(Math.max(...trunk.path.map((point) => point.y))).toBeLessThan(low.depth + 1460 - 100 - 125);
      expect(newErrors('loop', looped, elements)).toEqual([]);
    });
  });

  it('turned 45°: no way back onto the loop keeps clear of it, so it turns with its unit and says to re-route it', () => {
    const plan = turn(['fdum'], 45, {}, looped);
    expect(plan.outcomes.get('loop')).toEqual({ kind: 'follows', note: 'turned with its unit: re-route it, or re-design it with Auto duct.' });
    const elements = after(plan, looped);
    const port = supplyPort(byId(elements, 'fdum')!);
    const trunk = specIn(elements, 'loop');
    expect(trunk.path[0]!.x).toBeCloseTo(port.lip.x, 6);
    expect(trunk.path[0]!.y).toBeCloseTo(port.lip.y, 6);
    // Its runout still ends on SAD-1.
    expect(trunk.path[trunk.path.length - 1]).toEqual(readDuctRunSpec(loop)!.path[readDuctRunSpec(loop)!.path.length - 1]);
  });
});

describe('planHvacMove: what does not turn', () => {
  it('a wall unit stays square to its wall: the turn is refused with the reason', () => {
    const wallUnit: HvacElement = { ...unit, id: 'wall', type: 'wall-mounted-ac', mountType: 'wall', label: 'SRK35', wallId: 'w1', properties: {} };
    const plan = turn(['wall'], 90, {}, [wallUnit]);
    expect(plan.updated).toEqual([]);
    expect(plan.limitedBy).toEqual({ id: 'wall', reason: 'SRK35 hangs on its wall and stays square to it: move it to another wall instead.' });
    expect(plan.messages).toEqual(['Cannot turn: SRK35 hangs on its wall and stays square to it: move it to another wall instead.']);
  });

  it('only ducts selected: nothing turns, and it says what does', () => {
    const plan = turn(['main'], 90);
    expect(plan.updated).toEqual([]);
    expect(plan.messages[0]).toMatch(/^Only units and air terminals turn/);
  });

  it('names the turn for the undo step', () => {
    expect(hvacRotateLabel([unit], 90, false)).toBe('Rotate FDUM22 90° clockwise');
    expect(hvacRotateLabel([unit], -45, false)).toBe('Rotate FDUM22 45° anticlockwise');
    expect(hvacRotateLabel([d1, { ...d1, id: 'd2' }], 90, true)).toBe('Rotate 2 diffusers 90° clockwise each');
  });
});
