/**
 * One drag of the selection, whatever layer it starts on (a unit's body on the
 * canvas, a duct run, a straight of a run, a design-check badge), as a move
 * session the host renders:
 *
 * - A press arms it. It becomes a drag after 4 px, so a click stays a click:
 *   a click on a selected item selects it alone; a press on an unselected item
 *   selects it, and a drag then moves it alone.
 * - Pressed on an item of a multi-selection, the whole selection moves.
 * - Each pointer move (one per animation frame) snaps the drag (guides, grid;
 *   Shift keeps to an axis, Alt moves freely) and asks the move model for the
 *   preview, without the drain re-solve (the slow part).
 * - Release commits the full plan (drains included) as one undo step; Esc
 *   cancels; typing a number moves exactly that far along the drag (Enter).
 *
 * The host gives the scene, the selection, the coordinate mapping, the model's
 * context, and paints the preview and the readout; the session holds no React
 * state, so a drag never re-renders the canvas.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { isCondensatePipe } from '../condensate/condensateTypes';
import { isDuctElement } from '../duct/ductTypes';
import { isRefrigerantPipeElementType } from '../refrigerantPipePairModel';

import type { Vec3 } from './ductElasticMove';
import type { DuctSegmentRef } from './ductNetworkMove';
import { planHvacMove, type HvacMoveContext, type HvacMovePlan } from './hvacMoveModel';
import { footprintBox, snapMoveDelta, type MoveBox, type MoveGuide } from './moveSnapping';

export interface HvacMoveSessionHost {
  scene(): readonly HvacElement[];
  selection(): readonly string[];
  select(ids: string[]): void;
  /** The plan point (mm) under a client point; null outside the plan. */
  clientToWorld(clientX: number, clientY: number): Point2D | null;
  /** Screen pixels per millimetre at the current zoom. */
  pxPerMm(): number;
  /** The board's snap step (mm) when snapping is on; null when off. */
  gridMm(): number | null;
  /** The move model's context; `preview`: leave the drain re-solve out. */
  context(preview: boolean): HvacMoveContext;
  /** Paint the preview in every layer (null clears it). */
  preview(plan: HvacMovePlan | null, ids: readonly string[]): void;
  /** The readout at the cursor and the alignment guides (null hides them). */
  hud(state: HvacMoveHudState | null): void;
  /** Commit the plan as one undo step. */
  commit(plan: HvacMovePlan): void;
  /** A drag started (the ids it moves) or ended (null): layers that mark the moving items hide them meanwhile. */
  dragState?(ids: readonly string[] | null): void;
}

export interface HvacMoveHudState {
  /** Where the pointer is (client pixels). */
  client: Point2D;
  /** The move as it will be made, and as asked. */
  applied: Vec3;
  requested: Vec3;
  /** A distance being typed (mm), or null. */
  typed: string | null;
  /** Why the selection stops short of the pointer. */
  limitedBy: string | null;
  /** Ducts left for the designer (a run that no longer reaches its terminal, …). */
  notes: string[];
  /** Alignment guides (plan mm). */
  guides: MoveGuide[];
  /** "Move FDUM22 and 2 diffusers". */
  label: string;
}

export interface HvacMoveBegin {
  /** The element pressed (a unit, a terminal, a run…). */
  pressedId: string;
  clientX: number;
  clientY: number;
  /** A straight of a run moved on its own (its card is pinned and the press is on it). */
  segment?: DuctSegmentRef | null;
  /** A click (no drag) also does this (e.g. pins the duct segment under the pointer). */
  onClick?: () => void;
}

/** A host that always calls the latest one `get` returns (a React component's host is rebuilt each render). */
export function latestHost(get: () => HvacMoveSessionHost): HvacMoveSessionHost {
  return {
    scene: () => get().scene(),
    selection: () => get().selection(),
    select: (ids) => get().select(ids),
    clientToWorld: (clientX, clientY) => get().clientToWorld(clientX, clientY),
    pxPerMm: () => get().pxPerMm(),
    gridMm: () => get().gridMm(),
    context: (preview) => get().context(preview),
    preview: (plan, ids) => get().preview(plan, ids),
    hud: (state) => get().hud(state),
    commit: (plan) => get().commit(plan),
    dragState: (ids) => get().dragState?.(ids),
  };
}

/** Pixels the pointer travels before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Guides pull within this many screen pixels. */
const GUIDE_TOLERANCE_PX = 6;

/** Items with a footprint the guides align (units, terminals, gullies; not runs, pipes or drains). */
function hasFootprint(element: HvacElement): boolean {
  return !isDuctElement(element) && !isRefrigerantPipeElementType(element.type) && !isCondensatePipe(element);
}

interface Armed {
  ids: string[];
  segment: DuctSegmentRef | null;
  pressedId: string;
  startClient: Point2D;
  startWorld: Point2D;
  anchor: Point2D;
  moving: MoveBox[];
  others: MoveBox[];
  /** A click selects the pressed item alone (it was part of a larger selection). */
  collapseOnClick: boolean;
  onClick?: () => void;
  dragging: boolean;
  lastClient: Point2D;
  modifiers: { shift: boolean; alt: boolean };
  typed: string | null;
  plan: HvacMovePlan | null;
  delta: Point2D;
  frame: number | null;
}

export class HvacMoveSession {
  private armed: Armed | null = null;

  constructor(private readonly host: HvacMoveSessionHost, private readonly target: Window = window) {}

  /** A drag is in progress (past the threshold). */
  get dragging(): boolean {
    return Boolean(this.armed?.dragging);
  }

  /** Arm a move on a press; false when nothing it could move was pressed. */
  begin(request: HvacMoveBegin): boolean {
    this.cancel();
    const scene = this.host.scene();
    const byId = new Map(scene.map((element) => [element.id, element]));
    const pressed = byId.get(request.pressedId);
    const startWorld = this.host.clientToWorld(request.clientX, request.clientY);
    if (!pressed || !startWorld) return false;
    const selection = this.host.selection().filter((id) => byId.has(id));
    const pressedSelected = selection.includes(pressed.id);
    if (!pressedSelected) this.host.select([pressed.id]);
    const segment = request.segment ?? null;
    const ids = segment ? [] : pressedSelected ? selection : [pressed.id];
    const movingSet = new Set(ids);
    const moving = ids.map((id) => byId.get(id)!).filter(hasFootprint).map(footprintBox);
    // Guides align with the units, terminals and gullies that stay (not with kits: they sit on their pipe run).
    const others = moving.length
      ? scene.filter((element) => !movingSet.has(element.id) && hasFootprint(element) && element.type !== 'refrigerant-branch-kit').map(footprintBox)
      : [];
    const anchor = hasFootprint(pressed) && !segment
      ? { x: pressed.position.x + pressed.width / 2, y: pressed.position.y + pressed.depth / 2 }
      : { x: 0, y: 0 };
    this.armed = {
      ids, segment, pressedId: pressed.id, startClient: { x: request.clientX, y: request.clientY }, startWorld, anchor, moving, others,
      collapseOnClick: pressedSelected && selection.length > 1, onClick: request.onClick, dragging: false,
      lastClient: { x: request.clientX, y: request.clientY }, modifiers: { shift: false, alt: false }, typed: null, plan: null,
      delta: { x: 0, y: 0 }, frame: null,
    };
    this.target.addEventListener('pointermove', this.onPointerMove, true);
    this.target.addEventListener('pointerup', this.onPointerUp, true);
    this.target.addEventListener('pointercancel', this.onCancel, true);
    this.target.addEventListener('keydown', this.onKeyDown, true);
    this.target.addEventListener('keyup', this.onKeyUp, true);
    this.target.addEventListener('blur', this.onCancel);
    return true;
  }

  /** Drop the session (its preview and readout with it). */
  cancel(): void {
    const armed = this.detach();
    if (armed?.dragging) {
      this.host.preview(null, []);
      this.host.hud(null);
      this.host.dragState?.(null);
    }
  }

  /** Stop listening; the preview stays as it is (the caller decides what replaces it). */
  private detach(): Armed | null {
    const armed = this.armed;
    if (!armed) return null;
    this.armed = null;
    if (armed.frame !== null) this.target.cancelAnimationFrame(armed.frame);
    this.target.removeEventListener('pointermove', this.onPointerMove, true);
    this.target.removeEventListener('pointerup', this.onPointerUp, true);
    this.target.removeEventListener('pointercancel', this.onCancel, true);
    this.target.removeEventListener('keydown', this.onKeyDown, true);
    this.target.removeEventListener('keyup', this.onKeyUp, true);
    this.target.removeEventListener('blur', this.onCancel);
    return armed;
  }

  private readonly onCancel = (): void => {
    this.cancel();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const armed = this.armed;
    if (!armed) return;
    armed.lastClient = { x: event.clientX, y: event.clientY };
    armed.modifiers = { shift: event.shiftKey, alt: event.altKey };
    if (!armed.dragging) {
      if (Math.hypot(event.clientX - armed.startClient.x, event.clientY - armed.startClient.y) < DRAG_THRESHOLD_PX) return;
      armed.dragging = true;
      this.host.dragState?.(armed.segment ? [armed.segment.runId] : armed.ids);
    }
    event.preventDefault();
    event.stopPropagation();
    this.schedule();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const armed = this.armed;
    if (!armed) return;
    if (!armed.dragging) {
      // A click: the pressed item alone (it was part of a selection), and whatever the press also asked.
      this.cancel();
      if (armed.collapseOnClick) this.host.select([armed.pressedId]);
      armed.onClick?.();
      return;
    }
    // (The release still reaches the canvas, so its own pointer state ends cleanly.)
    armed.lastClient = { x: event.clientX, y: event.clientY };
    this.finish();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const armed = this.armed;
    if (!armed?.dragging) {
      if (event.key === 'Escape') this.cancel();
      return;
    }
    // The modifiers as held now (Enter with Shift held keeps to the axis).
    armed.modifiers = { shift: event.shiftKey, alt: event.altKey };
    let handled = true;
    if (event.key === 'Escape') {
      this.cancel();
    } else if (event.key === 'Enter') {
      this.finish();
    } else if (/^[0-9.]$/.test(event.key)) {
      armed.typed = `${armed.typed ?? ''}${event.key}`.replace(/^(\d*\.\d*)\./, '$1');
      this.update();
    } else if (event.key === 'Backspace') {
      armed.typed = armed.typed && armed.typed.length > 1 ? armed.typed.slice(0, -1) : null;
      this.update();
    } else if (event.key === 'Shift' || event.key === 'Alt') {
      armed.modifiers = { shift: event.shiftKey, alt: event.altKey };
      if (event.key === 'Alt') event.preventDefault();
      this.schedule();
      return;
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const armed = this.armed;
    if (!armed?.dragging || (event.key !== 'Shift' && event.key !== 'Alt')) return;
    armed.modifiers = { shift: event.shiftKey, alt: event.altKey };
    this.schedule();
  };

  private schedule(): void {
    const armed = this.armed;
    if (!armed || armed.frame !== null) return;
    armed.frame = this.target.requestAnimationFrame(() => {
      if (this.armed !== armed) return;
      armed.frame = null;
      this.update();
    });
  }

  /** The drag as it stands: snapped, or the typed distance along its direction. */
  private currentDelta(armed: Armed): { delta: Point2D; guides: MoveGuide[] } {
    const world = this.host.clientToWorld(armed.lastClient.x, armed.lastClient.y);
    const raw = world ? { x: world.x - armed.startWorld.x, y: world.y - armed.startWorld.y } : armed.delta;
    const typed = armed.typed !== null ? Number.parseFloat(armed.typed) : Number.NaN;
    if (Number.isFinite(typed)) {
      const length = Math.hypot(raw.x, raw.y);
      const direction = length > 1e-6 ? { x: raw.x / length, y: raw.y / length } : { x: 1, y: 0 };
      const locked = armed.modifiers.shift
        ? (Math.abs(direction.x) >= Math.abs(direction.y) ? { x: Math.sign(direction.x) || 1, y: 0 } : { x: 0, y: Math.sign(direction.y) || 1 })
        : direction;
      return { delta: { x: locked.x * typed, y: locked.y * typed }, guides: [] };
    }
    const snapped = snapMoveDelta({
      delta: raw, anchor: armed.anchor, moving: armed.moving, others: armed.others, gridMm: this.host.gridMm(),
      axisLock: armed.modifiers.shift, free: armed.modifiers.alt, toleranceMm: GUIDE_TOLERANCE_PX / Math.max(this.host.pxPerMm(), 1e-9),
    });
    return { delta: snapped.delta, guides: snapped.guides };
  }

  private update(): void {
    const armed = this.armed;
    if (!armed?.dragging) return;
    const { delta, guides } = this.currentDelta(armed);
    armed.delta = delta;
    let plan: HvacMovePlan;
    try {
      plan = planHvacMove(this.host.scene(), { ids: armed.ids, segment: armed.segment, delta: { x: delta.x, y: delta.y, z: 0 } }, this.host.context(true));
    } catch (error) {
      // A move the model cannot plan must not leave a drag hanging.
      this.cancel();
      throw error;
    }
    armed.plan = plan;
    this.host.preview(plan, armed.ids);
    // The stop is shown on its own line; the rest are what the move leaves for the designer.
    const limitedBy = plan.limitedBy?.reason ?? null;
    this.host.hud({
      client: armed.lastClient, applied: plan.applied, requested: plan.requested, typed: armed.typed,
      limitedBy, notes: plan.messages.filter((message) => !limitedBy || !message.includes(limitedBy)), guides, label: plan.label,
    });
  }

  /** Commit what the drag (or the typed distance) asks, drains included, as one step. */
  private finish(): void {
    const armed = this.armed;
    if (!armed) return;
    const { delta } = this.currentDelta(armed);
    this.detach();
    this.host.hud(null);
    this.host.dragState?.(null);
    if (Math.hypot(delta.x, delta.y) < 0.01) {
      this.host.preview(null, []);
      return;
    }
    // The preview stays until the host replaces it with the stored move (no flicker back).
    let plan: HvacMovePlan;
    try {
      plan = planHvacMove(this.host.scene(), { ids: armed.ids, segment: armed.segment, delta: { x: delta.x, y: delta.y, z: 0 } }, this.host.context(false));
    } catch (error) {
      this.host.preview(null, []);
      throw error;
    }
    this.host.commit(plan);
  }
}
