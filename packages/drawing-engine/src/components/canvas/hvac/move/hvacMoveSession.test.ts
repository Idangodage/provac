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

/** One screen pixel is one millimetre; the plan's origin at the client origin. */
function setup(selection: string[] = []) {
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
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 250, y: 0 }, label: 'Move 2 diffusers' });
    target.fire('pointerup', { clientX: 3237, clientY: 1000 });
    // One commit, planned with the drains (not the preview's context).
    expect(log.commits).toHaveLength(1);
    expect(log.contexts.at(-1)).toBe(false);
    expect(element('d1').position.x).toBe(1000 - 300 + 250);
    expect(element('d2').position.x).toBe(3000 - 300 + 250);
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

  it('aligns with another item\'s centre before the grid, and Shift keeps to one axis', () => {
    const { target, session, log } = setup(['d1']);
    session.begin({ pressedId: 'd1', clientX: 1000, clientY: 1000 });
    // Toward d3's centre line (x 6000): 4996 mm right lands on it.
    target.fire('pointermove', { clientX: 5996, clientY: 1180 });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 5000, y: 200 } });
    expect(log.huds.at(-1)?.guides[0]).toMatchObject({ axis: 'x', at: 6000 });
    target.fire('pointermove', { clientX: 5996, clientY: 1180, shiftKey: true });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 5000, y: 0 } });
    target.fire('keydown', { key: 'Escape' });
  });

  it('a 3D view\'s drag maps the pointer through its own surface and moves up and down too (snapped)', () => {
    const { target, session, log } = setup([]);
    // A front view: across the screen is x, up the screen is z (y stays).
    const resolve = (clientX: number, clientY: number) => ({ x: clientX, y: 1000, z: 3000 - clientY });
    session.begin({ pressedId: 'd1', clientX: 1000, clientY: 500, resolve, axes: { x: true, y: false, z: true } });
    target.fire('pointermove', { clientX: 1212, clientY: 420 });
    target.flush();
    // 212 → 200 across, 80 → 100 up; diffusers keep their level, so the plan asked for z but applied none to them.
    expect(log.huds.at(-1)).toMatchObject({ requested: { x: 200, y: 0, z: 100 } });
    target.fire('keydown', { key: 'Escape' });
  });

  it('keeps an axis the drag does not move exactly where it is (no grid snap on it)', () => {
    const { target, session, log } = setup([]);
    // Off the grid: with Shift along x, its y stays as it is (the grid would put its centre on 9000).
    session.begin({ pressedId: 'd4', clientX: 1013, clientY: 8987 });
    target.fire('pointermove', { clientX: 1225, clientY: 9000, shiftKey: true });
    target.flush();
    expect(log.huds.at(-1)).toMatchObject({ applied: { x: 237, y: 0 } });
    target.fire('keydown', { key: 'Escape' });
    // An arrow along z (a 3D view): x and y stay exactly.
    session.begin({ pressedId: 'd4', clientX: 1013, clientY: 8987, resolve: (x, y) => ({ x: x + 0.4, y: 8987.3, z: 9000 - y }), axes: { z: true, x: false, y: false } });
    target.fire('pointermove', { clientX: 1013, clientY: 8900 });
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
