import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';
import { resolveDuctSettings } from '../duct/ductSettings';

import type { HvacMovePlan } from './hvacMoveModel';
import { HvacMoveSession, type HvacMoveHudState, type HvacMoveSessionHost } from './hvacMoveSession';

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
  fire(type: string, payload: Record<string, unknown>): { defaultPrevented: boolean } {
    const event = {
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false,
      ...payload,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
    };
    this.listeners.get(type)?.forEach((listener) => listener(event));
    return event;
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

const diffuser = (id: string, x: number, y: number): HvacElement => ({
  id, type: 'diffuser', position: { x: x - 300, y: y - 300 }, rotation: 0, width: 600, depth: 600, height: 300,
  elevation: 2400, mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: {},
});

/** One screen pixel is one millimetre (a move's magnets catch within 4 mm, hold to 6 mm); the plan's origin at the client origin. */
function setup(selection: string[] = [], options: { walls?: number[] } = {}) {
  const target = new FakeWindow();
  let scene: HvacElement[] = [diffuser('d1', 1000, 1000), diffuser('d2', 3000, 1000), diffuser('d3', 6000, 4000), diffuser('d4', 1013, 8987)];
  let selected = [...selection];
  const log = {
    previews: [] as Array<HvacMovePlan | null>, huds: [] as Array<HvacMoveHudState | null>, commits: [] as HvacMovePlan[],
    contexts: [] as boolean[], drags: [] as Array<readonly string[] | null>,
  };
  const host: HvacMoveSessionHost = {
    scene: () => scene,
    selection: () => selected,
    select: (ids) => { selected = [...ids]; },
    clientToWorld: (x: number, y: number): Point2D => ({ x, y }),
    pxPerMm: () => 1,
    gridMm: () => 50,
    context: (preview) => { log.contexts.push(preview); return { ductSettings: resolveDuctSettings({}) }; },
    preview: (plan) => { log.previews.push(plan); },
    hud: (state) => { log.huds.push(state); },
    commit: (plan) => {
      log.commits.push(plan);
      const updated = new Map(plan.updated.map((element) => [element.id, element]));
      scene = scene.map((element) => updated.get(element.id) ?? element);
    },
    dragState: (ids) => { log.drags.push(ids); },
    snapAnglesDeg: () => options.walls ?? [],
  };
  const session = new HvacMoveSession(host, target as unknown as Window);
  return { target, session, log, selected: () => selected, element: (id: string) => scene.find((element) => element.id === id)! };
}

describe('HvacMoveSession', () => {
  it('a press selects the item; a click (no drag) keeps it selected and does what the press asked', () => {
    const { target, session, log, selected } = setup(['d2']);
    let clicked = 0;
    expect(session.begin({ pressedId: 'd1', clientX: 1000, clientY: 1000, onClick: () => { clicked += 1; } })).toBe(true);
    expect(selected()).toEqual(['d1']);
    target.fire('pointermove', { clientX: 1002, clientY: 1001 });
    target.fire('pointerup', { clientX: 1002, clientY: 1001 });
    expect(clicked).toBe(1);
    expect(log.previews).toEqual([]);
    expect(log.commits).toEqual([]);
    expect(target.count('pointermove')).toBe(0);
  });

  it('a press on an item of a selection drags the whole selection; a click selects that item alone', () => {
    const click = setup(['d1', 'd2']);
    click.session.begin({ pressedId: 'd2', clientX: 3000, clientY: 1000 });
    expect(click.selected()).toEqual(['d1', 'd2']);
    click.target.fire('pointerup', { clientX: 3000, clientY: 1000 });
    expect(click.selected()).toEqual(['d2']);

    const { target, session, log, element } = setup(['d1', 'd2']);
    session.begin({ pressedId: 'd2', clientX: 3000, clientY: 1000 });
    target.fire('pointermove', { clientX: 3237, clientY: 1000 });
    target.flush();
    expect(log.drags).toEqual([['d1', 'd2']]);
    expect(log.previews.at(-1)?.updated.map((moved) => moved.id).sort()).toEqual(['d1', 'd2']);
    // Under the pointer: 3237 is 13 mm from the nearest grid line, too far to catch.
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 237, y: 0 }, label: 'Move 2 diffusers' });
    target.fire('pointerup', { clientX: 3237, clientY: 1000 });
    // One commit, planned with the drains (not the preview's context).
    expect(log.commits).toHaveLength(1);
    expect(log.contexts.at(-1)).toBe(false);
    expect(element('d1').position.x).toBe(1000 - 300 + 237);
    expect(element('d2').position.x).toBe(3000 - 300 + 237);
    expect(log.drags.at(-1)).toBeNull();
    expect(log.huds.at(-1)).toBeNull();
    expect(target.count('pointermove')).toBe(0);
  });

  it('Esc cancels: the preview and readout go, nothing is stored', () => {
    const { target, session, log } = setup(['d1']);
    session.begin({ pressedId: 'd1', clientX: 1000, clientY: 1000 });
    target.fire('pointermove', { clientX: 1400, clientY: 1300 });
    target.flush();
    const esc = target.fire('keydown', { key: 'Escape' });
    expect(esc.defaultPrevented).toBe(true);
    expect(log.previews.at(-1)).toBeNull();
    expect(log.huds.at(-1)).toBeNull();
    target.fire('pointerup', { clientX: 1400, clientY: 1300 });
    expect(log.commits).toEqual([]);
  });

  it('aligns with another item\'s centre within 4 px, follows the pointer otherwise, and Shift keeps to one axis', () => {
    const { target, session, log } = setup(['d1']);
    session.begin({ pressedId: 'd1', clientX: 1000, clientY: 1000 });
    // Toward d3's centre line (x 6000): 4997 mm right is 3 px off it and lands on it; y (180, 20 mm from a grid line) is free.
    target.fire('pointermove', { clientX: 5997, clientY: 1180 });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 5000, y: 180 } });
    expect(log.huds.at(-1)?.guides[0]).toMatchObject({ axis: 'x', at: 6000 });
    // Held until 6 px off: 5 px still aligned, 7 px free.
    target.fire('pointermove', { clientX: 6005, clientY: 1180 });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 5000, y: 180 } });
    target.fire('pointermove', { clientX: 6007, clientY: 1180 });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 5007, y: 180 }, guides: [] });
    target.fire('pointermove', { clientX: 5997, clientY: 1180 });
    target.flush();
    target.fire('pointermove', { clientX: 5996, clientY: 1180, shiftKey: true });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 5000, y: 0 } });
    target.fire('keydown', { key: 'Escape' });
  });

  it('a drag starts free, even from a grid line, and comes back onto it once the magnets are on', () => {
    const { target, session, log } = setup(['d1']);
    // d1's centre is on a grid line: 4.5 px in, the magnets are not on yet (6 px), so it follows (no stick at the start).
    session.begin({ pressedId: 'd1', clientX: 1000, clientY: 1000 });
    target.fire('pointermove', { clientX: 1004.5, clientY: 1000 });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 5, y: 0 } });
    // Past 6 px they are; back within 4 px of the line, it is caught.
    target.fire('pointermove', { clientX: 1030, clientY: 1000 });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 30, y: 0 } });
    target.fire('pointermove', { clientX: 1003, clientY: 1000 });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 0, y: 0 } });
    target.fire('keydown', { key: 'Escape' });
  });

  it('a 3D view\'s drag maps the pointer through its own surface and moves up and down too (magnetic)', () => {
    const { target, session, log } = setup([]);
    // A front view: across the screen is x, up the screen is z (y stays); a pixel is a millimetre on it.
    const resolve = (clientX: number, clientY: number) => ({ x: clientX, y: 1000, z: 3000 - clientY });
    session.begin({ pressedId: 'd1', clientX: 1000, clientY: 500, resolve, axes: { x: true, y: false, z: true } });
    target.fire('pointermove', { clientX: 1212, clientY: 420 });
    target.flush();
    // Under the pointer (212 across, 80 up: neither within 5 px of a grid line); diffusers keep their level, so the
    // plan asked for z but applied none to them.
    expect(log.huds.at(-1)).toMatchObject({ requested: { x: 212, y: 0, z: 80 } });
    // Within 4 px of the grid both ways: caught.
    target.fire('pointermove', { clientX: 1203, clientY: 403 });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ requested: { x: 200, y: 0, z: 100 } });
    target.fire('keydown', { key: 'Escape' });
  });

  it('keeps an axis the drag does not move exactly where it is (no grid snap on it)', () => {
    const { target, session, log } = setup([]);
    // Off the grid: with Shift along x, its y stays as it is (the grid would put its centre on 9000).
    session.begin({ pressedId: 'd4', clientX: 1013, clientY: 8987 });
    target.fire('pointermove', { clientX: 1247, clientY: 9000, shiftKey: true });
    target.flush();
    // 1247 is 3 mm from the 1250 line (within 4): caught.
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 237, y: 0 } });
    target.fire('keydown', { key: 'Escape' });
    // An arrow along z (a 3D view): x and y stay exactly.
    session.begin({ pressedId: 'd4', clientX: 1013, clientY: 8987, resolve: (x, y) => ({ x: x + 0.4, y: 8987.3, z: 9000 - y }), axes: { z: true, x: false, y: false } });
    // 97 mm up (from 13 to 110): 3 mm from the 100 mm step, caught.
    target.fire('pointermove', { clientX: 1013, clientY: 8890 });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ requested: { x: 0, y: 0, z: 100 } });
    target.fire('keydown', { key: 'Escape' });
  });

  it('a typed distance moves exactly that far along the drag (Enter)', () => {
    const { target, session, log, element } = setup(['d1']);
    session.begin({ pressedId: 'd1', clientX: 1000, clientY: 1000 });
    target.fire('pointermove', { clientX: 1100, clientY: 1003 });
    target.flush();
    for (const key of ['1', '2', '5', '0']) target.fire('keydown', { key });
    expect(log.huds.at(-1)).toMatchObject({ typed: '1250' });
    target.fire('keydown', { key: 'Enter', shiftKey: true });
    expect(log.commits).toHaveLength(1);
    expect(element('d1').position).toEqual({ x: 700 + 1250, y: 700 });
  });
});

describe('HvacMoveSession: a turn (the rotation grip, the gizmo ring)', () => {
  /** A client point `r` px from (1000, 1000) at `deg` (clockwise from +x, the screen's y down). */
  const about = (deg: number, r = 300, centre = { x: 1000, y: 1000 }) => ({
    clientX: centre.x + r * Math.cos((deg * Math.PI) / 180), clientY: centre.y + r * Math.sin((deg * Math.PI) / 180),
  });

  it('turns about the pivot by the angle swept, following the pointer to 0.5° between the stops; one commit with the drains', () => {
    const { target, session, log, element } = setup(['d1']);
    // The grip straight above the pivot (d1's centre).
    expect(session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) })).toBe(true);
    // Swept 77.7° clockwise: 77.5° (no stop within 5 px of the pointer, 300 px out).
    target.fire('pointermove', about(-12.3));
    target.flush();
    expect(log.drags).toEqual([['d1']]);
    expect(log.huds.at(-1)).toMatchObject({ turn: { requestedDeg: 77.5, appliedDeg: 77.5, pivot: { x: 1000, y: 1000 }, stop: null }, label: 'Rotate D1 77.5° clockwise' });
    expect(log.contexts.at(-1)).toBe(true);
    target.fire('pointerup', about(-12.3));
    expect(log.commits).toHaveLength(1);
    expect(log.contexts.at(-1)).toBe(false);
    expect(element('d1').rotation).toBe(77.5);
    expect(element('d1').position).toEqual({ x: 700, y: 700 });
    expect(log.huds.at(-1)).toBeNull();
    expect(target.count('pointermove')).toBe(0);
  });

  it('is named a turn from its first degree', () => {
    const { target, session, log } = setup(['d1']);
    session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) });
    // Swept 0.2°: no turn yet, but the readout already says what the drag does.
    target.fire('pointermove', about(-89.8, 300));
    target.fire('pointermove', { clientX: 1001, clientY: 694 });
    target.flush();
    expect(log.huds.at(-1)?.label).toMatch(/^Rotate D1/);
    target.fire('keydown', { key: 'Escape' });
  });

  it('a stop catches the 45° orientation within 5 px at the pointer, holds it to 9 px, and lets go', () => {
    const { target, session, log } = setup(['d1']);
    session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) });
    // 300 px out: 5 px is 0.95°, 9 px 1.72°. Swept 44.2°: caught at 45°.
    target.fire('pointermove', about(-90 + 44.2));
    target.flush();
    expect(log.huds.at(-1)?.turn).toMatchObject({ requestedDeg: 45, stop: { kind: 'step', orientationDeg: 45 } });
    expect(log.huds.at(-1)?.turn?.stopsDeg).toEqual(expect.arrayContaining([0, 45, 90, 180, -45, -90]));
    // 46.5°: still held; 47°: free again.
    target.fire('pointermove', about(-90 + 46.5));
    target.flush();
    expect(log.huds.at(-1)?.turn?.requestedDeg).toBe(45);
    target.fire('pointermove', about(-90 + 47));
    target.flush();
    expect(log.huds.at(-1)?.turn).toMatchObject({ requestedDeg: 47, stop: null });
    target.fire('keydown', { key: 'Escape' });
  });

  it('a turn starts free, even from a stop, and comes back onto it', () => {
    const { target, session, log } = setup(['d1']);
    session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) });
    // 1.5° (8 px at 300 px out): the magnets are not on yet, so the 0° stop does not hold it.
    target.fire('pointermove', about(-90 + 1.5));
    target.flush();
    expect(log.huds.at(-1)?.turn).toMatchObject({ requestedDeg: 1.5, stop: null });
    target.fire('pointermove', about(-90 + 10));
    target.flush();
    expect(log.huds.at(-1)?.turn?.requestedDeg).toBe(10);
    target.fire('pointermove', about(-90 + 0.5));
    target.flush();
    expect(log.huds.at(-1)?.turn).toMatchObject({ requestedDeg: 0, stop: { kind: 'step', orientationDeg: 0 } });
    target.fire('keydown', { key: 'Escape' });
  });

  it('Shift turns in 15° steps', () => {
    const { target, session, log } = setup(['d1']);
    session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) });
    target.fire('pointermove', { ...about(-90 + 52), shiftKey: true });
    target.flush();
    expect(log.huds.at(-1)?.turn).toMatchObject({ requestedDeg: 45, stop: { kind: 'shift', orientationDeg: 45 } });
    target.fire('pointermove', { ...about(-90 + 53), shiftKey: true });
    target.flush();
    expect(log.huds.at(-1)?.turn?.requestedDeg).toBe(60);
    target.fire('keydown', { key: 'Escape' });
  });

  it('near the pivot the pointer\'s angle is too unsteady: the turn holds', () => {
    const { target, session, log } = setup(['d1']);
    session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) });
    target.fire('pointermove', about(-90 + 30.2));
    target.flush();
    expect(log.huds.at(-1)?.turn?.requestedDeg).toBe(30);
    target.fire('pointermove', about(120, 8));
    target.flush();
    expect(log.huds.at(-1)?.turn?.requestedDeg).toBe(30);
    target.fire('keydown', { key: 'Escape' });
  });

  it('squares up with a wall within 5 px; Alt turns freely', () => {
    const walls = setup(['d1'], { walls: [12] });
    walls.session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) });
    walls.target.fire('pointermove', about(11.5));
    walls.target.flush();
    // 101.5° swept: the wall's 102° (12° + 90°) is 0.5° off: caught.
    expect(walls.log.huds.at(-1)?.turn?.requestedDeg).toBeCloseTo(102, 9);
    expect(walls.log.huds.at(-1)?.turn?.stop).toMatchObject({ kind: 'wall' });

    const free = setup(['d1']);
    free.session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) });
    free.target.fire('pointermove', { ...about(-27), altKey: true });
    free.target.flush();
    expect(free.log.huds.at(-1)?.turn?.requestedDeg).toBeCloseTo(63, 9);
  });

  it('a typed angle turns exactly that far ("-": anticlockwise); Enter commits it', () => {
    const { target, session, log, element } = setup(['d1']);
    session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) });
    target.fire('pointermove', about(-60));
    target.flush();
    for (const key of ['4', '5']) target.fire('keydown', { key });
    expect(log.huds.at(-1)).toMatchObject({ typed: '45', turn: { requestedDeg: 45 } });
    target.fire('keydown', { key: '-' });
    expect(log.huds.at(-1)).toMatchObject({ typed: '-45', turn: { requestedDeg: -45 }, label: 'Rotate D1 45° anticlockwise' });
    target.fire('keydown', { key: 'Enter' });
    expect(log.commits).toHaveLength(1);
    expect(element('d1').rotation).toBe(315);
  });

  it('Esc cancels: nothing is stored and the preview goes', () => {
    const { target, session, log, element } = setup(['d1']);
    session.beginRotate({ ids: ['d1'], pivot: { x: 1000, y: 1000 }, ...about(-90) });
    target.fire('pointermove', about(0));
    target.flush();
    target.fire('keydown', { key: 'Escape' });
    expect(log.commits).toEqual([]);
    expect(log.previews.at(-1)).toBeNull();
    expect(element('d1').rotation).toBe(0);
    expect(target.count('keydown')).toBe(0);
  });

  it('turns a block about its centre: each item swings round it and turns', () => {
    const { target, session, element } = setup(['d1', 'd2']);
    const pivot = { x: 2000, y: 1000 };
    session.beginRotate({ ids: ['d1', 'd2'], pivot, ...about(-90, 400, pivot) });
    target.fire('pointermove', about(0, 400, pivot));
    target.fire('pointerup', about(0, 400, pivot));
    // A quarter turn clockwise: d1 (1000 mm left of the pivot) is now 1000 mm above it.
    expect(element('d1').rotation).toBe(90);
    expect(element('d1').position.x).toBeCloseTo(2000 - 300, 6);
    expect(element('d1').position.y).toBeCloseTo(0 - 300, 6);
    expect(element('d2').position.x).toBeCloseTo(2000 - 300, 6);
    expect(element('d2').position.y).toBeCloseTo(2000 - 300, 6);
  });
});
