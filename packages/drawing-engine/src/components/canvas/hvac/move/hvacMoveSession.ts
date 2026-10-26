/**
 * One drag of the selection, whatever layer it starts on (a unit's body on the
 * canvas, a duct run, a straight of a run, a design-check badge), as a move
 * session the host renders:
 *
 * - A press arms it. It becomes a drag after 4 px, so a click stays a click:
 *   a click on a selected item selects it alone; a press on an unselected item
 *   selects it, and a drag then moves it alone.
 * - Pressed on an item of a multi-selection, the whole selection moves.
 * - Each pointer move (one per animation frame) places the drag under the
 *   pointer, with magnetic guides and grid: they catch within a few pixels and
 *   hold until the pointer is further off, so nothing jumps or lags (Shift
 *   keeps to an axis, Alt moves freely); then it asks the move model for the
 *   preview, without the drain re-solve (the slow part).
 * - Release commits the full plan (drains included) as one undo step; Esc
 *   cancels; typing a number moves exactly that far along the drag (Enter).
 * - A turn (the rotation grip, the 3D gizmo's ring) is the same session in its
 *   rotation mode: the angle the pointer sweeps about the pivot, followed to
 *   0.5°, with magnetic stops where the first item's orientation is a multiple
 *   of 45° or square to a wall (they catch within a few pixels at the pointer);
 *   Shift turns in 15° steps, Alt freely; typing a number (and "-" for
 *   anticlockwise) turns exactly that far.
 * - A straight sized by one of its grips is the same session in its resize
 *   mode: the pointer's travel along the grip becomes the value (a length, a
 *   width, a depth), snapped (Alt: 1 mm; Shift: every straight of the run's
 *   size takes a new section), or typed exactly; a value the rules do not
 *   allow stops at the nearest they do, and the readout says why. A piece slid
 *   along its duct (a take-off, an accessory, a transition) is the same mode,
 *   drawn magnetically to the middle of its straight.
 *
 * The host gives the scene, the selection, the coordinate mapping, the model's
 * context, and paints the preview and the readout; the session holds no React
 * state, so a drag never re-renders the canvas.
 */
import type { HvacElement, Point2D } from '../../../../types';
import { isCondensatePipe } from '../condensate/condensateTypes';
import type { DuctTerminalSpigotSide } from '../duct/ductTerminals';
import { isDuctElement } from '../duct/ductTypes';
import { isRefrigerantPipeElementType } from '../refrigerantPipePairModel';

import { ZERO3, type Vec3 } from './ductElasticMove';
import type { DuctSegmentRef } from './ductNetworkMove';
import { DuctResizeSolver, snapResizeValue, type DuctResizeGrip, type DuctResizeOutcome } from './ductResize';
import { hvacMoveChanges, planHvacMove, type HvacMoveContext, type HvacMovePlan } from './hvacMoveModel';
import {
  footprintBox,
  SNAP_CATCH_PX,
  SNAP_RELEASE_PX,
  snapMagneticValue,
  snapMoveDelta,
  type MoveBox,
  type MoveGuide,
  type MoveSnapHold,
} from './moveSnapping';

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
  /** The walls' directions (degrees on the plan): a turn squares the first item up with them as with 15° steps. */
  snapAnglesDeg?(): readonly number[];
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
  /** What the move or turn did, needing nothing from the designer (a run re-routed round its unit). */
  infos?: string[];
  /** Alignment guides (plan mm). */
  guides: MoveGuide[];
  /** "Move FDUM22 and 2 diffusers". */
  label: string;
  /**
   * A turn: the angle made and asked for (degrees, clockwise on the plan), about `pivot`, from the pointer's start
   * angle; the stop holding it (null: it follows the pointer), and the stops round it (as angles swept from the start).
   */
  turn?: { appliedDeg: number; requestedDeg: number; pivot: Point2D; startDeg: number; stop?: HvacTurnStop | null; stopsDeg?: readonly number[] };
  /** A straight being sized: the value before, asked and made. */
  resize?: DuctResizeOutcome;
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
  /**
   * A 3D view's pointer: the model point (mm, z up) under a client point on the
   * drag's surface or axis (through the point grabbed). Absent: the plan's own
   * mapping (z stays).
   */
  resolve?: (clientX: number, clientY: number) => Vec3 | null;
  /** The axes the drag moves (a view's surface, a gizmo arrow): the others stay put. Default: x and y. */
  axes?: Partial<Record<'x' | 'y' | 'z', boolean>>;
}

/** What holds a turn: a 45° stop or a wall's square (the first item's orientation there, degrees), or Shift's 15° steps. */
export interface HvacTurnStop {
  kind: 'step' | 'wall' | 'shift';
  orientationDeg: number;
}

/** A turn of the selected units and terminals about a pivot (the rotation grip, the 3D gizmo's ring). */
export interface HvacRotateBegin {
  /** What turns: units and air terminals. */
  ids: readonly string[];
  /** What they turn about (plan mm): the centre of their box. */
  pivot: Point2D;
  clientX: number;
  clientY: number;
  /** A 3D view's pointer: the model point under a client point on the level plane through the pivot. Absent: the plan's. */
  resolve?: (clientX: number, clientY: number) => Vec3 | null;
}

/** A straight sized by dragging one of its grips (its length, width or depth; a runout's length). */
export interface HvacResizeBegin {
  grip: DuctResizeGrip;
  clientX: number;
  clientY: number;
  /** A 3D view's pointer: the model point (mm, z up) on the grip's line under a client point. Absent: the plan's. */
  resolve?: (clientX: number, clientY: number) => Vec3 | null;
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
    snapAnglesDeg: () => get().snapAnglesDeg?.() ?? [],
  };
}

/** Pixels the pointer travels before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
/** A turn's magnetic stops (the first item's orientation on multiples of this), Shift's steps, and how finely it follows the pointer (degrees). */
const TURN_STOP_DEG = 45;
const TURN_SHIFT_STEP_DEG = 15;
const TURN_FINE_DEG = 0.5;
/** A turn's stop catches within this many screen pixels at the pointer, and lets go past this many (stops are few: firmer than a move's guides). */
const TURN_STOP_CATCH_PX = 5;
const TURN_STOP_RELEASE_PX = 9;
/** Nearer the pivot than this (screen pixels), the pointer's angle is too unsteady to follow: the turn holds. */
const PIVOT_DEAD_PX = 12;

const degrees = (radians: number) => (radians * 180) / Math.PI;

/** An angle in (−180, 180]. */
function halfTurn(angleDeg: number): number {
  const wrapped = ((((angleDeg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** An orientation in [0, 360). */
function wholeTurn(angleDeg: number): number {
  const turned = ((angleDeg % 360) + 360) % 360;
  return turned >= 360 - 1e-9 ? 0 : turned;
}

/** The unit vector of the axis a drag mostly runs along (Shift). */
function dominantAxis(vector: Vec3): Vec3 {
  const ax = Math.abs(vector.x);
  const ay = Math.abs(vector.y);
  const az = Math.abs(vector.z);
  if (ax >= ay && ax >= az) return { x: Math.sign(vector.x) || 1, y: 0, z: 0 };
  if (ay >= az) return { x: 0, y: Math.sign(vector.y) || 1, z: 0 };
  return { x: 0, y: 0, z: Math.sign(vector.z) || 1 };
}

/** Items with a footprint the guides align (units, terminals, gullies; not runs, pipes or drains). */
function hasFootprint(element: HvacElement): boolean {
  return !isDuctElement(element) && !isRefrigerantPipeElementType(element.type) && !isCondensatePipe(element);
}

interface Armed {
  ids: string[];
  segment: DuctSegmentRef | null;
  pressedId: string;
  startClient: Point2D;
  startWorld: Vec3;
  /** The 3D views' pointer mapping (null: the plan's). */
  resolve: ((clientX: number, clientY: number) => Vec3 | null) | null;
  /** The axes the drag moves. */
  axes: { x: boolean; y: boolean; z: boolean };
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
  delta: Vec3;
  frame: number | null;
  /** What the guides and grid hold (a magnet lets go only past its release distance), and the height's grid line. */
  snapHeld: MoveSnapHold | null;
  zHeld: number | null;
  /** The magnets (guides, grid, a turn's stops) are on once the pointer has gone past their release distance: a drag starts free, even from a stop. */
  magnets: boolean;
  /**
   * A turn: its pivot, the pointer's angle at the press, the first item's orientation then, the angle last planned
   * and turned, the stop holding it, and the spigot sides last shown (a side changes only past its margin).
   */
  rotate: {
    pivot: Point2D; startDeg: number; baseDeg: number; walls: readonly number[]; planned: number | null; turn: number;
    stop: HvacTurnStop | null; sides: Readonly<Record<string, DuctTerminalSpigotSide>> | null;
  } | null;
  /** A straight being sized: its grip, the solver (it keeps what it has planned), and the value last planned. */
  resize: {
    grip: DuctResizeGrip; solver: DuctResizeSolver; settings: HvacMoveContext['ductSettings']; planned: string | null;
    /** A slide's magnetic stop holding it (its place), or null. */
    stopHeld: number | null;
  } | null;
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
    const resolve = request.resolve ?? null;
    const startWorld = this.pointAt(resolve, request.clientX, request.clientY);
    if (!pressed || !startWorld) return false;
    const selection = this.host.selection().filter((id) => byId.has(id));
    const pressedSelected = selection.includes(pressed.id);
    if (!pressedSelected) this.host.select([pressed.id]);
    const segment = request.segment ?? null;
    const ids = segment ? [] : pressedSelected ? selection : [pressed.id];
    const movingSet = new Set(ids);
    const moving = ids.map((id) => byId.get(id)!).filter(hasFootprint).map(footprintBox);
    // Guides align with the units, terminals and gullies that stay (not with kits: they sit on their pipe run); the
    // plan draws them, so the 3D views go without.
    const others = moving.length && !resolve
      ? scene.filter((element) => !movingSet.has(element.id) && hasFootprint(element) && element.type !== 'refrigerant-branch-kit').map(footprintBox)
      : [];
    const anchor = hasFootprint(pressed) && !segment
      ? { x: pressed.position.x + pressed.width / 2, y: pressed.position.y + pressed.depth / 2 }
      : { x: 0, y: 0 };
    this.armed = {
      ids, segment, pressedId: pressed.id, startClient: { x: request.clientX, y: request.clientY }, startWorld, resolve, anchor, moving, others,
      axes: { x: request.axes?.x ?? true, y: request.axes?.y ?? true, z: request.axes?.z ?? false },
      collapseOnClick: pressedSelected && selection.length > 1, onClick: request.onClick, dragging: false,
      lastClient: { x: request.clientX, y: request.clientY }, modifiers: { shift: false, alt: false }, typed: null, plan: null,
      delta: { x: 0, y: 0, z: 0 }, frame: null, snapHeld: null, zHeld: null, magnets: false, rotate: null, resize: null,
    };
    this.listen();
    return true;
  }

  /** Arm a turn on a press (the rotation grip, the gizmo's ring); false when nothing it could turn was pressed. */
  beginRotate(request: HvacRotateBegin): boolean {
    this.cancel();
    const scene = this.host.scene();
    const byId = new Map(scene.map((element) => [element.id, element]));
    const ids = request.ids.filter((id) => byId.has(id));
    const resolve = request.resolve ?? null;
    const startWorld = this.pointAt(resolve, request.clientX, request.clientY);
    if (!ids.length || !startWorld) return false;
    this.armed = {
      ids, segment: null, pressedId: ids[0]!, startClient: { x: request.clientX, y: request.clientY }, startWorld, resolve,
      axes: { x: true, y: true, z: false }, anchor: request.pivot, moving: [], others: [], collapseOnClick: false, dragging: false,
      lastClient: { x: request.clientX, y: request.clientY }, modifiers: { shift: false, alt: false }, typed: null, plan: null,
      delta: { x: 0, y: 0, z: 0 }, frame: null, snapHeld: null, zHeld: null, magnets: false,
      rotate: {
        pivot: request.pivot, startDeg: degrees(Math.atan2(startWorld.y - request.pivot.y, startWorld.x - request.pivot.x)),
        baseDeg: byId.get(ids[0]!)!.rotation ?? 0, walls: this.host.snapAnglesDeg?.() ?? [], planned: null, turn: 0, stop: null, sides: null,
      },
      resize: null,
    };
    this.listen();
    return true;
  }

  /** Arm a resize on a press of a straight's grip; false when its run is gone or the press is off the view. */
  beginResize(request: HvacResizeBegin): boolean {
    this.cancel();
    const scene = this.host.scene();
    const resolve = request.resolve ?? null;
    const startWorld = this.pointAt(resolve, request.clientX, request.clientY);
    if (!startWorld || !scene.some((element) => element.id === request.grip.runId)) return false;
    const context = this.host.context(true);
    this.armed = {
      ids: [request.grip.runId], segment: null, pressedId: request.grip.runId, startClient: { x: request.clientX, y: request.clientY }, startWorld,
      resolve, axes: { x: true, y: true, z: Boolean(resolve) }, anchor: { x: 0, y: 0 }, moving: [], others: [], collapseOnClick: false,
      dragging: false, lastClient: { x: request.clientX, y: request.clientY }, modifiers: { shift: false, alt: false }, typed: null, plan: null,
      delta: { x: 0, y: 0, z: 0 }, frame: null, snapHeld: null, zHeld: null, magnets: false, rotate: null,
      resize: {
        grip: request.grip, settings: context.ductSettings, planned: null, stopHeld: null,
        solver: new DuctResizeSolver(scene, context.ductSettings, request.grip, { soffitMm: context.ceilingVoid?.soffitMm ?? null, ...(context.rooms ? { rooms: context.rooms } : {}) }),
      },
    };
    this.listen();
    return true;
  }

  private listen(): void {
    this.target.addEventListener('pointermove', this.onPointerMove, true);
    this.target.addEventListener('pointerup', this.onPointerUp, true);
    this.target.addEventListener('pointercancel', this.onCancel, true);
    this.target.addEventListener('keydown', this.onKeyDown, true);
    this.target.addEventListener('keyup', this.onKeyUp, true);
    this.target.addEventListener('blur', this.onCancel);
  }

  private pointAt(resolve: Armed['resolve'], clientX: number, clientY: number): Vec3 | null {
    if (resolve) return resolve(clientX, clientY);
    const point = this.host.clientToWorld(clientX, clientY);
    return point ? { x: point.x, y: point.y, z: 0 } : null;
  }

  /**
   * Screen pixels per millimetre where the pointer is: the plan's zoom, or in a
   * 3D view what ten pixels of pointer travel cover on the drag's surface there.
   */
  private pxPerMmAt(armed: Armed): number {
    const zoom = Math.max(this.host.pxPerMm(), 1e-9);
    if (!armed.resolve) return zoom;
    const { x, y } = armed.lastClient;
    const at = armed.resolve(x, y);
    if (!at) return zoom;
    const reach = Math.max(...[armed.resolve(x + 10, y), armed.resolve(x, y + 10)]
      .map((point) => (point ? Math.hypot(point.x - at.x, point.y - at.y, point.z - at.z) : 0)));
    return reach > 1e-6 ? 10 / reach : zoom;
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
    if (!armed.magnets && Math.hypot(event.clientX - armed.startClient.x, event.clientY - armed.startClient.y) > (armed.rotate ? TURN_STOP_RELEASE_PX : SNAP_RELEASE_PX)) {
      armed.magnets = true;
    }
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
      armed.typed = `${armed.typed ?? ''}${event.key}`.replace(/^(-?\d*\.\d*)\./, '$1');
      this.update();
    } else if (event.key === '-' && armed.rotate) {
      // A turn typed anticlockwise.
      armed.typed = armed.typed?.startsWith('-') ? armed.typed.slice(1) || null : `-${armed.typed ?? ''}`;
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
  private currentDelta(armed: Armed): { delta: Vec3; guides: MoveGuide[] } {
    const point = this.pointAt(armed.resolve, armed.lastClient.x, armed.lastClient.y);
    const { axes } = armed;
    // Only the axes the drag moves change: a front view's depth, an arrow's other two axes stay exactly put.
    const raw: Vec3 = point
      ? {
        x: axes.x ? point.x - armed.startWorld.x : 0,
        y: axes.y ? point.y - armed.startWorld.y : 0,
        z: axes.z ? point.z - armed.startWorld.z : 0,
      }
      : armed.delta;
    const typed = armed.typed !== null ? Number.parseFloat(armed.typed) : Number.NaN;
    if (Number.isFinite(typed)) {
      const length = Math.hypot(raw.x, raw.y, raw.z);
      let direction: Vec3 = length > 1e-6 ? { x: raw.x / length, y: raw.y / length, z: raw.z / length } : { x: 1, y: 0, z: 0 };
      if (armed.modifiers.shift) direction = dominantAxis(direction);
      return { delta: { x: direction.x * typed, y: direction.y * typed, z: direction.z * typed }, guides: [] };
    }
    // Shift keeps to the axis the drag mostly runs along: the others stay put too (unsnapped).
    const lock = armed.modifiers.shift ? dominantAxis(raw) : null;
    const moves = {
      x: axes.x && (!lock || lock.x !== 0),
      y: axes.y && (!lock || lock.y !== 0),
      z: axes.z && (!lock || lock.z !== 0),
    };
    const grid = this.host.gridMm();
    const pxPerMm = this.pxPerMmAt(armed);
    const snapped = snapMoveDelta({
      delta: { x: moves.x ? raw.x : 0, y: moves.y ? raw.y : 0 }, anchor: armed.anchor, moving: armed.moving,
      others: armed.magnets ? armed.others : [], gridMm: armed.magnets ? grid : null,
      axisLock: false, free: armed.modifiers.alt, pxPerMm, held: armed.snapHeld, fixedAxes: { x: !moves.x, y: !moves.y },
    });
    armed.snapHeld = snapped.held;
    // Up and down: the same magnets on the height (the 3D views; the plan has no height to drag).
    let z = 0;
    if (moves.z) {
      const level = snapMagneticValue(raw.z, { gridMm: armed.magnets ? grid : null, pxPerMm, held: armed.zHeld, free: armed.modifiers.alt });
      armed.zHeld = level.held;
      z = level.value;
    } else {
      armed.zHeld = null;
    }
    return { delta: { x: snapped.delta.x, y: snapped.delta.y, z: z || 0 }, guides: snapped.guides };
  }

  /**
   * The turn as it stands (degrees, clockwise on the plan): the angle typed, or
   * the angle the pointer swept about the pivot. The first item's orientation
   * follows the pointer to 0.5°; a magnetic stop holds it where it comes within
   * a few pixels (at the pointer) of a multiple of 45° or of a wall's square,
   * until the pointer is further off. Shift turns in 15° steps, Alt freely.
   */
  private currentTurn(armed: Armed): number {
    const rotate = armed.rotate!;
    const typed = armed.typed !== null ? Number.parseFloat(armed.typed) : Number.NaN;
    if (Number.isFinite(typed)) {
      rotate.stop = null;
      return typed;
    }
    const point = this.pointAt(armed.resolve, armed.lastClient.x, armed.lastClient.y);
    if (!point) return rotate.turn;
    const radiusPx = Math.hypot(point.x - rotate.pivot.x, point.y - rotate.pivot.y) * this.pxPerMmAt(armed);
    if (radiusPx < PIVOT_DEAD_PX) return rotate.turn;
    const swept = halfTurn(degrees(Math.atan2(point.y - rotate.pivot.y, point.x - rotate.pivot.x)) - rotate.startDeg);
    const target = rotate.baseDeg + swept;
    if (armed.modifiers.alt) {
      rotate.stop = null;
      return Math.round(swept * 10) / 10;
    }
    if (armed.modifiers.shift) {
      const step = Math.round(target / TURN_SHIFT_STEP_DEG) * TURN_SHIFT_STEP_DEG;
      rotate.stop = { kind: 'shift', orientationDeg: wholeTurn(step) };
      return halfTurn(step - rotate.baseDeg);
    }
    // A turn starts free (even from a stop); then the stop held last frame, while the pointer is within its release distance.
    const fine = halfTurn(Math.round(target / TURN_FINE_DEG) * TURN_FINE_DEG - rotate.baseDeg);
    if (!armed.magnets) {
      rotate.stop = null;
      return fine;
    }
    const held = rotate.stop && rotate.stop.kind !== 'shift' ? rotate.stop : null;
    if (held && Math.abs(halfTurn(target - held.orientationDeg)) <= degrees(TURN_STOP_RELEASE_PX / radiusPx)) {
      return halfTurn(held.orientationDeg - rotate.baseDeg);
    }
    rotate.stop = null;
    // A stop within its catch distance; a wall's square wins a tie with a 45° stop (the same orientation).
    const catchDeg = degrees(TURN_STOP_CATCH_PX / radiusPx);
    let best: HvacTurnStop | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const stop of this.turnStops(rotate, target)) {
      const gap = Math.abs(halfTurn(target - stop.orientationDeg));
      if (gap > catchDeg + 1e-9) continue;
      if (gap < bestGap - 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && stop.kind === 'wall')) {
        best = stop;
        bestGap = gap;
      }
    }
    if (best) {
      rotate.stop = best;
      return halfTurn(best.orientationDeg - rotate.baseDeg);
    }
    return fine;
  }

  /** The stops nearest an orientation: the 45° multiple and each wall's square. */
  private turnStops(rotate: NonNullable<Armed['rotate']>, target: number): HvacTurnStop[] {
    return [
      { kind: 'step', orientationDeg: wholeTurn(Math.round(target / TURN_STOP_DEG) * TURN_STOP_DEG) },
      ...rotate.walls.map((wall): HvacTurnStop => ({ kind: 'wall', orientationDeg: wholeTurn(wall + 90 * Math.round((target - wall) / 90)) })),
    ];
  }

  /** Every stop round the turn, as angles swept from the start (the readout's protractor marks them). */
  private turnStopSweeps(armed: Armed): number[] {
    const rotate = armed.rotate!;
    if (armed.typed !== null || armed.modifiers.alt) return [];
    const step = armed.modifiers.shift ? TURN_SHIFT_STEP_DEG : TURN_STOP_DEG;
    const orientations = Array.from({ length: Math.round(360 / step) }, (_, index) => index * step);
    if (!armed.modifiers.shift) rotate.walls.forEach((wall) => orientations.push(...[0, 90, 180, 270].map((quarter) => wall + quarter)));
    const sweeps = orientations.map((orientation) => Math.round(halfTurn(orientation - rotate.baseDeg) * 100) / 100);
    return [...new Set(sweeps)].sort((a, b) => a - b);
  }

  private planTurn(armed: Armed, turn: number, preview: boolean): HvacMovePlan {
    const rotate = armed.rotate!;
    return planHvacMove(this.host.scene(), {
      ids: armed.ids, delta: ZERO3,
      rotation: { angleDeg: turn, pivot: rotate.pivot, partial: true, ...(rotate.sides ? { spigotSides: rotate.sides } : {}) },
    }, this.host.context(preview));
  }

  private updateTurn(armed: Armed): void {
    const rotate = armed.rotate!;
    const turn = this.currentTurn(armed);
    rotate.turn = turn;
    // A plan per angle: the pointer moving within one snap step re-plans nothing.
    if (rotate.planned === null || Math.abs(rotate.planned - turn) > 1e-6 || !armed.plan) {
      try {
        armed.plan = this.planTurn(armed, turn, true);
      } catch (error) {
        this.cancel();
        throw error;
      }
      rotate.planned = turn;
      rotate.sides = armed.plan.rotation?.spigotSides ?? null;
      this.host.preview(armed.plan, armed.ids);
    }
    const plan = armed.plan;
    const limitedBy = plan.limitedBy?.reason ?? null;
    const infos = plan.infos ?? [];
    this.host.hud({
      client: armed.lastClient, applied: ZERO3, requested: ZERO3, typed: armed.typed, limitedBy, infos,
      notes: plan.messages.filter((message) => (!limitedBy || !message.includes(limitedBy)) && !infos.includes(message)), guides: [], label: plan.label,
      turn: {
        appliedDeg: plan.rotation?.appliedDeg ?? 0, requestedDeg: turn, pivot: rotate.pivot, startDeg: rotate.startDeg,
        stop: rotate.stop, stopsDeg: this.turnStopSweeps(armed),
      },
    });
  }

  /**
   * The value a resize asks as it stands: the number typed (exact), or the
   * pointer's travel along the grip, snapped (Alt: 1 mm). Shift gives a new
   * section to every straight of the run's size.
   */
  private currentResize(armed: Armed): { value: number; scope: 'leg' | 'size'; fine: boolean } {
    const resize = armed.resize!;
    const { grip } = resize;
    const scope = (grip.kind === 'width' || grip.kind === 'depth') && armed.modifiers.shift ? 'size' : 'leg';
    const typed = armed.typed !== null ? Number.parseFloat(armed.typed) : Number.NaN;
    if (Number.isFinite(typed)) return { value: typed, scope, fine: true };
    const point = this.pointAt(armed.resolve, armed.lastClient.x, armed.lastClient.y);
    if (!point) return { value: grip.value, scope, fine: armed.modifiers.alt };
    const travel = (point.x - armed.startWorld.x) * grip.axis.x + (point.y - armed.startWorld.y) * grip.axis.y
      + (armed.resolve ? (point.z - armed.startWorld.z) * grip.axis.z : 0);
    const raw = grip.value + travel * grip.rate;
    // A slide is drawn to its stops (the middle of its straight), magnetically, as a move to its guides.
    const stops = grip.slide?.stops ?? [];
    if (stops.length && armed.magnets && !armed.modifiers.alt) {
      const pxPerMm = this.pxPerMmAt(armed);
      if (resize.stopHeld !== null && Math.abs(raw - resize.stopHeld) * pxPerMm <= SNAP_RELEASE_PX) return { value: resize.stopHeld, scope, fine: false };
      resize.stopHeld = stops.find((stop) => Math.abs(raw - stop) * pxPerMm <= SNAP_CATCH_PX) ?? null;
      if (resize.stopHeld !== null) return { value: resize.stopHeld, scope, fine: false };
    }
    return { value: snapResizeValue(grip, raw, resize.settings, armed.modifiers.alt), scope, fine: armed.modifiers.alt };
  }

  private updateResize(armed: Armed): void {
    const resize = armed.resize!;
    const { value, scope, fine } = this.currentResize(armed);
    // A plan per value: the pointer moving within one snap step re-plans nothing.
    const key = `${scope}|${value}|${fine}`;
    if (resize.planned !== key || !armed.plan) {
      try {
        armed.plan = resize.solver.plan(value, scope, fine);
      } catch (error) {
        this.cancel();
        throw error;
      }
      resize.planned = key;
      this.host.preview(armed.plan, armed.ids);
    }
    const plan = armed.plan;
    this.host.hud({
      client: armed.lastClient, applied: ZERO3, requested: ZERO3, typed: armed.typed, limitedBy: plan.limitedBy?.reason ?? null,
      notes: plan.messages, infos: plan.infos ?? [], guides: [], label: plan.label, ...(plan.resize ? { resize: plan.resize } : {}),
    });
  }

  private update(): void {
    const armed = this.armed;
    if (!armed?.dragging) return;
    if (armed.rotate) {
      this.updateTurn(armed);
      return;
    }
    if (armed.resize) {
      this.updateResize(armed);
      return;
    }
    const { delta, guides } = this.currentDelta(armed);
    armed.delta = delta;
    let plan: HvacMovePlan;
    try {
      plan = planHvacMove(this.host.scene(), { ids: armed.ids, segment: armed.segment, delta }, this.host.context(true));
    } catch (error) {
      // A move the model cannot plan must not leave a drag hanging.
      this.cancel();
      throw error;
    }
    armed.plan = plan;
    this.host.preview(plan, armed.ids);
    // The stop is shown on its own line; the rest are what the move leaves for the designer, or what it did.
    const limitedBy = plan.limitedBy?.reason ?? null;
    const infos = plan.infos ?? [];
    this.host.hud({
      client: armed.lastClient, applied: plan.applied, requested: plan.requested, typed: armed.typed, infos,
      limitedBy, notes: plan.messages.filter((message) => (!limitedBy || !message.includes(limitedBy)) && !infos.includes(message)), guides, label: plan.label,
    });
  }

  /** Commit what the drag (or the typed distance or angle) asks, drains included, as one step. */
  private finish(): void {
    const armed = this.armed;
    if (!armed) return;
    if (armed.resize) {
      const { value, scope, fine } = this.currentResize(armed);
      this.detach();
      this.host.hud(null);
      this.host.dragState?.(null);
      let plan: HvacMovePlan;
      try {
        plan = armed.resize.solver.plan(value, scope, fine);
      } catch (error) {
        this.host.preview(null, []);
        throw error;
      }
      if (!hvacMoveChanges(plan)) {
        this.host.preview(null, []);
        return;
      }
      this.host.commit(plan);
      return;
    }
    if (armed.rotate) {
      const turn = this.currentTurn(armed);
      this.detach();
      this.host.hud(null);
      this.host.dragState?.(null);
      if (Math.abs(turn) < 0.01) {
        this.host.preview(null, []);
        return;
      }
      let plan: HvacMovePlan;
      try {
        plan = this.planTurn(armed, turn, false);
      } catch (error) {
        this.host.preview(null, []);
        throw error;
      }
      this.host.commit(plan);
      return;
    }
    const { delta } = this.currentDelta(armed);
    this.detach();
    this.host.hud(null);
    this.host.dragState?.(null);
    if (Math.hypot(delta.x, delta.y, delta.z) < 0.01) {
      this.host.preview(null, []);
      return;
    }
    // The preview stays until the host replaces it with the stored move (no flicker back).
    let plan: HvacMovePlan;
    try {
      plan = planHvacMove(this.host.scene(), { ids: armed.ids, segment: armed.segment, delta }, this.host.context(false));
    } catch (error) {
      this.host.preview(null, []);
      throw error;
    }
    this.host.commit(plan);
  }
}
