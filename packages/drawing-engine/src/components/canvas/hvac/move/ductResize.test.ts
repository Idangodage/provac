import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { resolveUnitAirPorts } from '../duct/ductAirPorts';
import { tapOrigin } from '../duct/ductBranchTargets';
import { buildDuctRunDraftElement, type DuctDraftOrigin } from '../duct/ductDraft';
import { getDuctRunPlan } from '../duct/ductFabricationPlanner';
import { ductLegs } from '../duct/ductGeometry';
import { resolveDuctSettings } from '../duct/ductSettings';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from '../duct/ductTerminals';
import { readDuctRunSpec, roundLeg, type DuctRunSpec } from '../duct/ductTypes';

import { DuctResizeSolver, ductResizeGrips, snapResizeValue, type DuctResizeGrip } from './ductResize';
import type { HvacMovePlan } from './hvacMoveModel';
import { HvacMoveSession, type HvacMoveHudState, type HvacMoveSessionHost } from './hvacMoveSession';

const settings = resolveDuctSettings({ soffitMm: 3000 });
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
/** A plan point `along` up from the supply collar (−y) and `across` to its right (+x). */
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });
const trunk = { widthMm: 400, heightMm: 250 };

/** A square Ø200 diffuser whose spigot's lip is at `lip` (plan), the lip's bottom at `lipBottomZ`. */
function diffuser(id: string, lip: Point2D, lipBottomZ = 2085): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  const draft: HvacElement = {
    id, type: 'diffuser', position: { x: 0, y: 0 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
    elevation: 0, mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
  };
  const at = terminalSpigotPort(draft)!.lip;
  return { ...draft, position: { x: lip.x - at.x, y: lip.y - at.y }, elevation: lipBottomZ + 100 - at.z };
}
const lipBottom = (terminal: HvacElement) => {
  const lip = terminalSpigotPort(terminal)!.lip;
  return { x: lip.x, y: lip.y, z: lip.z - 100 };
};

// ---- A Z: up 2000 from the collar, right 1000, up 1200, right 1600, a flexible runout to D1. ----
const d1 = diffuser('d1', S(3600, 3200));
const zed = buildDuctRunDraftElement({
  port, points: [S(2000), S(2000, 1000), S(3200, 1000), S(3200, 2600), lipBottom(d1)], legSizes: [trunk, trunk, trunk, trunk, roundLeg(200)],
  end: { kind: 'terminal', terminalId: 'd1', portId: 'spigot', flex: true },
}, 'zed');
const scene = [unit, zed, d1];

const byId = (list: readonly HvacElement[], id: string) => list.find((element) => element.id === id)!;
const specOf = (list: readonly HvacElement[], id: string): DuctRunSpec => readDuctRunSpec(byId(list, id))!;
const withPlan = (plan: HvacMovePlan) => {
  const replaced = new Map(plan.updated.map((element) => [element.id, element]));
  return scene.map((element) => replaced.get(element.id) ?? element);
};
const gripsOf = (key: string) => ductResizeGrips(scene, settings, 'zed', key);
const grip = (key: string, kind: DuctResizeGrip['kind'], side?: 1 | -1) => gripsOf(key).find((entry) => entry.kind === kind && (side === undefined || entry.side === side))!;
const near = (a: { x: number; y: number }, b: { x: number; y: number }, tolerance = 0.05) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

describe('ductResizeGrips: the grips a straight offers', () => {
  it('a straight off the collar: its far end, its two sides and its top (its near end is held at the collar)', () => {
    expect(gripsOf('leg:0').map((entry) => `${entry.kind}${entry.side ? `:${entry.side}` : ''}`)).toEqual(['length-end', 'width:1', 'width:-1', 'depth']);
  });

  it('a straight in the middle of the Z: both ends (the straight before it running the same way takes up a change at its start)', () => {
    const grips = gripsOf('leg:2');
    expect(grips.map((entry) => entry.kind)).toEqual(['length-end', 'length-start', 'width', 'width', 'depth']);
    const end = grips[0]!;
    const legs = ductLegs(specOf(scene, 'zed'));
    expect(near(end.point, legs[2]!.end)).toBe(true);
    expect(end.axis).toEqual({ x: legs[2]!.direction.x, y: legs[2]!.direction.y, z: 0 });
    expect(end.value).toBeCloseTo(1200, 1);
    const side = grips[2]!;
    expect(side.rate).toBe(2);
    expect(side.value).toBe(400);
    // On the left face (looking downstream), half the width out from the centreline.
    const middle = { x: (legs[2]!.start.x + legs[2]!.end.x) / 2, y: (legs[2]!.start.y + legs[2]!.end.y) / 2 };
    expect(Math.hypot(side.point.x - middle.x, side.point.y - middle.y)).toBeCloseTo(200, 6);
    const top = grips[4]!;
    expect(top.axis).toEqual({ x: 0, y: 0, z: 1 });
    expect(top.value).toBe(250);
    expect(top.point.z).toBeCloseTo(legs[2]!.start.z + 250, 6);
  });

  it('the flexible runout: one grip at its start, sliding back up the straight before it; a locked run: none', () => {
    const [runout] = gripsOf('end:flex');
    expect(runout!.kind).toBe('runout');
    expect(runout!.value).toBeGreaterThan(300);
    const locked = { ...zed, properties: { ...zed.properties, ductRun: { ...(zed.properties.ductRun as object), locked: true } } };
    expect(ductResizeGrips([unit, locked, d1], settings, 'zed', 'leg:2')).toEqual([]);
  });
});

describe('snapResizeValue', () => {
  const length = { kind: 'length-end' as const, round: false };
  const width = { kind: 'width' as const, round: false };
  const diameter = { kind: 'width' as const, round: true };
  it('lengths to 10 mm, sections to 50 mm, round sections to the stocked diameters; Alt to 1 mm; within the card\'s limits', () => {
    expect(snapResizeValue(length, 1494, settings)).toBe(1490);
    expect(snapResizeValue(length, 1496, settings)).toBe(1500);
    expect(snapResizeValue(length, 1496.4, settings, true)).toBe(1496);
    expect(snapResizeValue(length, 12, settings)).toBe(50);
    expect(snapResizeValue(width, 287, settings)).toBe(300);
    expect(snapResizeValue(width, 9000, settings)).toBe(4000);
    expect(snapResizeValue(diameter, 212, settings)).toBe(200);
    expect(snapResizeValue(diameter, 232, settings)).toBe(250);
    expect(snapResizeValue(diameter, 232, settings, true)).toBe(232);
  });
});

describe('DuctResizeSolver: a value asked, made or stopped short', () => {
  it('the far end dragged 300 mm on: the straight is 1,300 mm, everything before it stays, the runout takes it up', () => {
    const solver = new DuctResizeSolver(scene, settings, grip('leg:1', 'length-end'));
    const plan = solver.plan(1300);
    expect(plan.limitedBy).toBeNull();
    expect(plan.resize).toMatchObject({ from: 1000, asked: 1300, made: 1300, subject: 'Straight 2', scope: 'leg', sections: null });
    expect(plan.label).toBe('Duct straight 2 1300 mm');
    const after = specOf(withPlan(plan), 'zed');
    const before = specOf(scene, 'zed');
    expect(ductLegs(after)[1]!.lengthMm).toBeCloseTo(1300, 1);
    expect(after.path[0]).toEqual(before.path[0]);
    expect(near(after.path[1]!, before.path[1]!)).toBe(true);
    expect(after.path.at(-1)).toEqual(before.path.at(-1));
    expect(plan.outcomes.get('zed')).toEqual({ kind: 'moved' });
  });

  it('the near end dragged 300 mm back: the straight grows at its start; the run after it stays, the straight before it running the same way gives way', () => {
    const plan = new DuctResizeSolver(scene, settings, grip('leg:2', 'length-start')).plan(1500);
    expect(plan.limitedBy).toBeNull();
    const after = specOf(withPlan(plan), 'zed');
    const before = specOf(scene, 'zed');
    expect(ductLegs(after)[2]!.lengthMm).toBeCloseTo(1500, 1);
    for (const vertex of [3, 4, 5]) expect(near(after.path[vertex]!, before.path[vertex]!)).toBe(true);
    expect(ductLegs(after)[0]!.lengthMm).toBeCloseTo(1700, 1);
    expect(after.path[0]).toEqual(before.path[0]);
  });

  it('a side dragged out: the straight is wider (both faces move); Shift: every straight of its size takes the section', () => {
    const one = new DuctResizeSolver(scene, settings, grip('leg:2', 'width', 1)).plan(500);
    expect(one.limitedBy).toBeNull();
    expect(one.resize.sections).toEqual({ from: '400×250', to: '500×250' });
    expect(specOf(withPlan(one), 'zed').legs.slice(0, 4).map((leg) => leg.widthMm)).toEqual([400, 400, 500, 400]);
    const all = new DuctResizeSolver(scene, settings, grip('leg:2', 'width', 1)).plan(500, 'size');
    expect(all.resize.scope).toBe('size');
    expect(specOf(withPlan(all), 'zed').legs.slice(0, 4).map((leg) => leg.widthMm)).toEqual([500, 500, 500, 500]);
  });

  it('one straight made deeper under a high soffit: it stops where the transitions to its neighbours would be too steep, and says why', () => {
    const high = resolveDuctSettings({ soffitMm: 4500 });
    const plan = new DuctResizeSolver(scene, high, ductResizeGrips(scene, high, 'zed', 'leg:2').find((entry) => entry.kind === 'depth')!, { soffitMm: 4500 }).plan(900);
    expect(plan.resize.made).toBeGreaterThan(250);
    expect(plan.resize.made).toBeLessThan(900);
    expect(plan.limitedBy?.reason).toMatch(/^Straight 3 stops at 400×\d+: eccentric transition \(flat bottom\) at \d+° exceeds 30° \(SMACNA Fig\. 2-7\); lengthen the leg$/);
    // Its bottom stays at its level: the top rises.
    const bottom = specOf(scene, 'zed').path[2]!.z;
    expect(specOf(withPlan(plan), 'zed').path[2]!.z).toBeCloseTo(bottom, 6);
  });

  it('every straight of its size made deeper (Shift): it stops where its top would reach the soffit, and says why', () => {
    const plan = new DuctResizeSolver(scene, settings, grip('leg:2', 'depth'), { soffitMm: 3000 }).plan(900, 'size');
    const bottom = specOf(scene, 'zed').path[2]!.z;
    expect(plan.resize.made).toBe(500);
    expect(bottom + 500).toBeLessThanOrEqual(3000);
    expect(bottom + 550).toBeGreaterThan(3000);
    expect(plan.limitedBy?.reason).toMatch(/^Straight 3 stops at 400×500: .*soffit/);
    expect(specOf(withPlan(plan), 'zed').legs.slice(0, 4).map((leg) => leg.heightMm)).toEqual([500, 500, 500, 500]);
  });

  it('a straight shortened past the shortest a straight may be: it stops at 50 mm, and says why', () => {
    const plan = new DuctResizeSolver(scene, settings, grip('leg:1', 'length-end')).plan(20);
    expect(plan.resize.made).toBe(50);
    expect(plan.limitedBy?.reason).toBe('Straight 2 stops at 50 mm: a straight is at least 50 mm long');
  });

  it('the runout made longer: the rigid duct before it stops short', () => {
    const runout = grip('end:flex', 'runout');
    const plan = new DuctResizeSolver(scene, settings, runout).plan(runout.value + 400);
    expect(plan.limitedBy).toBeNull();
    expect(plan.updated.map((element) => element.id)).toContain('zed');
    expect(plan.resize.made).toBe(runout.value + 400);
  });
});

/** A window stand-in: listeners by type, animation frames run when flushed. */
class FakeWindow {
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  private frames: Array<() => void> = [];
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  requestAnimationFrame(callback: () => void): number {
    this.frames.push(callback);
    return this.frames.length;
  }
  cancelAnimationFrame(): void {
    this.frames = [];
  }
  flush(): void {
    const frames = this.frames;
    this.frames = [];
    frames.forEach((frame) => frame());
  }
  fire(type: string, payload: Record<string, unknown>): void {
    const event = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault() {}, stopPropagation() {}, ...payload };
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

describe('the move session\'s resize mode', () => {
  /** One screen pixel is one millimetre; the plan's origin at the client origin. */
  function setup() {
    const target = new FakeWindow();
    let current: HvacElement[] = [...scene];
    const log = { previews: [] as Array<HvacMovePlan | null>, huds: [] as Array<HvacMoveHudState | null>, commits: [] as HvacMovePlan[] };
    const host: HvacMoveSessionHost = {
      scene: () => current,
      selection: () => ['zed'],
      select: () => undefined,
      clientToWorld: (x: number, y: number): Point2D => ({ x, y }),
      pxPerMm: () => 1,
      gridMm: () => 50,
      context: () => ({ ductSettings: settings, ceilingVoid: { ceilingMm: 2400, soffitMm: 3000 } }),
      preview: (plan) => { log.previews.push(plan); },
      hud: (state) => { log.huds.push(state); },
      commit: (plan) => {
        log.commits.push(plan);
        const replaced = new Map(plan.updated.map((element) => [element.id, element]));
        current = current.map((element) => replaced.get(element.id) ?? element);
      },
    };
    return { target, session: new HvacMoveSession(host, target as unknown as Window), log, scene: () => current };
  }

  it('a grip dragged along its axis: the value follows the pointer, snapped; release stores it as one step', () => {
    const { target, session, log, scene: now } = setup();
    const end = grip('leg:1', 'length-end');
    const at = { x: end.point.x, y: end.point.y };
    expect(session.beginResize({ grip: end, clientX: at.x, clientY: at.y })).toBe(true);
    // 286 mm along the straight (and 40 across, which does nothing): 1,290 mm.
    target.fire('pointermove', { clientX: at.x + end.axis.x * 286 - end.axis.y * 40, clientY: at.y + end.axis.y * 286 + end.axis.x * 40 });
    target.flush();
    const hud = log.huds.at(-1)!;
    expect(hud.resize).toMatchObject({ from: 1000, asked: 1290, made: 1290 });
    expect(log.previews.at(-1)!.updated.map((element) => element.id)).toContain('zed');
    target.fire('pointerup', { clientX: at.x + end.axis.x * 286, clientY: at.y + end.axis.y * 286 });
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0]!.label).toBe('Duct straight 2 1290 mm');
    expect(ductLegs(specOf(now(), 'zed'))[1]!.lengthMm).toBeCloseTo(1290, 1);
  });

  it('a number typed while dragging sets the value exactly (Enter); Esc leaves it as it was', () => {
    const { target, session, log } = setup();
    const side = grip('leg:2', 'width', 1);
    expect(session.beginResize({ grip: side, clientX: side.point.x, clientY: side.point.y })).toBe(true);
    target.fire('pointermove', { clientX: side.point.x + side.axis.x * 30, clientY: side.point.y + side.axis.y * 30 });
    target.flush();
    for (const key of ['5', '5', '0']) target.fire('keydown', { key });
    expect(log.huds.at(-1)!.typed).toBe('550');
    expect(log.huds.at(-1)!.resize).toMatchObject({ asked: 550, made: 550, sections: { from: '400×250', to: '550×250' } });
    target.fire('keydown', { key: 'Enter' });
    expect(log.commits.at(-1)!.resize?.made).toBe(550);

    const again = setup();
    expect(again.session.beginResize({ grip: side, clientX: side.point.x, clientY: side.point.y })).toBe(true);
    again.target.fire('pointermove', { clientX: side.point.x + side.axis.x * 80, clientY: side.point.y + side.axis.y * 80 });
    again.target.flush();
    again.target.fire('keydown', { key: 'Escape' });
    expect(again.log.commits).toHaveLength(0);
    expect(again.log.previews.at(-1)).toBeNull();
    expect(again.log.huds.at(-1)).toBeNull();
  });

  it('a press without a drag changes nothing', () => {
    const { target, session, log } = setup();
    const end = grip('leg:1', 'length-end');
    expect(session.beginResize({ grip: end, clientX: end.point.x, clientY: end.point.y })).toBe(true);
    target.fire('pointerup', { clientX: end.point.x + 1, clientY: end.point.y });
    expect(log.commits).toHaveLength(0);
    expect(log.previews).toHaveLength(0);
  });
});

describe('slide grips: a small piece moved along its duct', () => {
  // Up 4000 from the collar, reduced at 1500 (400×250 → 300×250), then right 2000; a volume damper on the first
  // straight (clear of the collar's transition); a round branch off the second, 900 mm past the reducer.
  const small = { widthMm: 300, heightMm: 250 };
  const drawn = buildDuctRunDraftElement({ port, points: [S(1500), S(4000), S(4000, 2000)], legSizes: [trunk, small, small] }, 'main');
  const main: HvacElement = { ...drawn, properties: { ...drawn.properties, ductRun: { ...readDuctRunSpec(drawn)!, inline: [{ id: 'i1', kind: 'damper', legIndex: 0, stationMm: 1100 }] } } };
  const tap = tapOrigin(main, settings, { legIndex: 1, stationMm: 900, side: 1, style: 'spin-in', vcd: true }, roundLeg(200)) as Extract<DuctDraftOrigin, { kind: 'tap' }>;
  const branch = buildDuctRunDraftElement({
    origin: tap, points: [{ x: tap.point.x + tap.direction.x * 1500, y: tap.point.y + tap.direction.y * 1500 }], legSizes: [roundLeg(200)],
  }, 'branch');
  const pieces = [unit, main, branch];
  const slideOf = (runId: string, key: string) => ductResizeGrips(pieces, settings, runId, key)[0]!;

  it('the drawing starts clean', () => {
    for (const id of ['main', 'branch']) {
      const plan = getDuctRunPlan(pieces.find((element) => element.id === id)!, pieces, settings)!;
      expect(plan.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code)).toEqual([]);
    }
  });

  it('a take-off, an accessory and a transition each offer a slide grip along their duct, drawn to the middle of its clear straight', () => {
    const takeoff = slideOf('branch', 'start:takeoff');
    expect(takeoff).toMatchObject({ kind: 'slide', value: 900, slide: { piece: 'takeoff' } });
    expect(takeoff.axis.x).toBeCloseTo(0, 9);
    expect(takeoff.axis.y).toBeCloseTo(-1, 9);
    const damper = slideOf('main', 'inline:i1');
    expect(damper).toMatchObject({ kind: 'slide', value: 1100, slide: { piece: 'inline', id: 'i1' } });
    // The first straight's clear part runs from the collar's transition to the reducer: its middle.
    const middle = damper.slide!.stops[0]!;
    expect(middle).toBeGreaterThan(900);
    expect(middle).toBeLessThan(1500);
    const reducer = slideOf('main', 'transition:1');
    expect(reducer).toMatchObject({ kind: 'slide', slide: { piece: 'transition', node: 1 } });
    expect(reducer.value).toBeCloseTo(1500, 0);
  });

  it('a transition slid toward the take-off stops short of it, and says why', () => {
    const plan = new DuctResizeSolver(pieces, settings, slideOf('main', 'transition:1')).plan(2600);
    expect(plan.resize.made).toBeGreaterThan(1500);
    expect(plan.resize.made).toBeLessThan(2400);
    expect(plan.limitedBy?.reason).toMatch(/^The transition stops at [\d,]+ mm: .*take-off/);
  });

  it('an accessory slid onto the transition stops short of it, and says why', () => {
    const plan = new DuctResizeSolver(pieces, settings, slideOf('main', 'inline:i1')).plan(1450);
    expect(plan.resize.subject).toBe('The volume damper');
    expect(plan.resize.made).toBeLessThan(1450);
    expect(plan.resize.made).toBeGreaterThan(1200);
    expect(plan.limitedBy?.reason).toMatch(/^The volume damper stops at [\d,]+ mm: .*overlaps/);
  });

  it('a transition does not jump the take-off to a clear place beyond it (it moves continuously)', () => {
    // 2,600 mm is clear (past the take-off), but the way there is not: it stops before the take-off.
    const plan = new DuctResizeSolver(pieces, settings, slideOf('main', 'transition:1')).plan(2700);
    expect(plan.resize.made).toBeLessThan(2400);
  });

  it('a take-off slid onto the transition stops short of it (the main\'s own rules count), and says why', () => {
    // Back toward the reducer (its window would meet the transition at 1,500–1,810 mm from the collar).
    const plan = new DuctResizeSolver(pieces, settings, slideOf('branch', 'start:takeoff')).plan(0);
    expect(plan.resize.made).toBeGreaterThan(200);
    expect(plan.limitedBy?.reason).toMatch(/^The take-off stops at [\d,]+ mm: .*take-off overlaps/);
  });

  it('a take-off slides along its main: its branch keeps its end', () => {
    const plan = new DuctResizeSolver(pieces, settings, slideOf('branch', 'start:takeoff')).plan(600);
    expect(plan.resize).toMatchObject({ subject: 'The take-off', made: 600 });
    expect(plan.label).toBe('Take-off moved 300 mm back along the main');
  });

  it('a drag is drawn to the middle of its straight (within 4 px, held to 6 px)', () => {
    const target = new FakeWindow();
    const huds: Array<HvacMoveHudState | null> = [];
    const host: HvacMoveSessionHost = {
      scene: () => pieces, selection: () => ['main'], select: () => undefined,
      clientToWorld: (x: number, y: number): Point2D => ({ x, y }), pxPerMm: () => 1, gridMm: () => 50,
      context: () => ({ ductSettings: settings }), preview: () => undefined, hud: (state) => { huds.push(state); }, commit: () => undefined,
    };
    const session = new HvacMoveSession(host, target as unknown as Window);
    const damper = slideOf('main', 'inline:i1');
    expect(session.beginResize({ grip: damper, clientX: damper.point.x, clientY: damper.point.y })).toBe(true);
    // Up the straight is −y: 2 mm short of the middle of its clear straight, it is held there.
    const middle = damper.slide!.stops[0]!;
    target.fire('pointermove', { clientX: damper.point.x, clientY: damper.point.y + (damper.value - middle - 2) });
    target.flush();
    expect(huds.at(-1)?.resize).toMatchObject({ asked: middle });
    // 30 mm off it: free again (on the 10 mm grid).
    target.fire('pointermove', { clientX: damper.point.x, clientY: damper.point.y + (damper.value - middle - 30) });
    target.flush();
    expect(huds.at(-1)?.resize).toMatchObject({ asked: Math.round((middle + 30) / 10) * 10 });
    target.fire('keydown', { key: 'Escape' });
  });
});
