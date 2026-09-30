/**
 * Shared context of the duct auto layout and its optimiser: the collar's local
 * frame (x along its normal, y across), the service context (terminals,
 * obstacles with their height bands, the void), and the geometric checks both
 * use (flexible runout fit, blocked stretches, collinear clean-up).
 */
import type { HvacElement, Point2D } from '../../../../types';
import type { OrthogonalRouteObstacle } from '../obstacleAwareOrthogonalRoute';

import type { DuctAirPort } from './ductAirPorts';
import { flexCurve } from './ductFlex';
import type { DuctDesignSettings } from './ductSettings';
import type { DuctTerminalSpigotSide } from './ductTerminalCatalog';
import { readDuctTerminalSpec, terminalSpigotPort, type DuctTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, type DuctService } from './ductTypes';

export type AutoDuctIssueCode =
  | 'DU_AUTO_NO_DATA'
  | 'DU_AUTO_NO_PORT'
  | 'DU_AUTO_OCCUPIED'
  | 'DU_AUTO_CONNECTED'
  | 'DU_AUTO_AIRFLOW'
  | 'DU_AUTO_VOID'
  | 'DU_AUTO_NO_LAYOUT'
  | 'DU_AUTO_WALL'
  | 'DU_AUTO_ESP'
  | 'DU_AUTO_SPIGOT'
  | 'DU_TERMINAL_VELOCITY';

export interface AutoDuctIssue {
  code: AutoDuctIssueCode | string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  service?: DuctService;
  point?: Point2D;
  /** The run it was found on (the optimiser traces it back to the tree). */
  runId?: string;
}

// ---- Local frame ----

export interface Frame { origin: Point2D; n: Point2D; t: Point2D }

export const dot = (a: Point2D, b: Point2D) => a.x * b.x + a.y * b.y;
export const sub = (a: Point2D, b: Point2D): Point2D => ({ x: a.x - b.x, y: a.y - b.y });
export const toLocal = (frame: Frame, point: Point2D): Point2D => {
  const d = sub(point, frame.origin);
  return { x: dot(d, frame.n), y: dot(d, frame.t) };
};
export const toWorld = (frame: Frame, point: Point2D): Point2D => ({
  x: frame.origin.x + frame.n.x * point.x + frame.t.x * point.y,
  y: frame.origin.y + frame.n.y * point.x + frame.t.y * point.y,
});
export const dirToLocal = (frame: Frame, direction: Point2D): Point2D => ({ x: dot(direction, frame.n), y: dot(direction, frame.t) });
export const dirToWorld = (frame: Frame, direction: Point2D): Point2D => ({
  x: frame.n.x * direction.x + frame.t.x * direction.y,
  y: frame.n.y * direction.x + frame.t.y * direction.y,
});
export const cardinal = (direction: Point2D): Point2D => (Math.abs(direction.x) >= Math.abs(direction.y)
  ? { x: Math.sign(direction.x) || 1, y: 0 } : { x: 0, y: Math.sign(direction.y) || 1 });
export const roundUp = (value: number, step = 50) => Math.ceil(value / step - 1e-9) * step;

export function boxToLocal(frame: Frame, corners: readonly Point2D[], padMm: number, id?: string): OrthogonalRouteObstacle {
  const local = corners.map((corner) => toLocal(frame, corner));
  return {
    ...(id ? { id } : {}),
    minX: Math.min(...local.map((p) => p.x)) - padMm, maxX: Math.max(...local.map((p) => p.x)) + padMm,
    minY: Math.min(...local.map((p) => p.y)) - padMm, maxY: Math.max(...local.map((p) => p.y)) + padMm,
  };
}

export function footprintCorners(element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'rotation'>): Point2D[] {
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const angle = ((element.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx! * element.width) / 2;
    const y = (sy! * element.depth) / 2;
    return { x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos };
  });
}

export function segmentHitsBox(a: Point2D, b: Point2D, box: OrthogonalRouteObstacle): boolean {
  // Axis-aligned segments only (the layout is orthogonal in the local frame).
  if (Math.abs(a.y - b.y) < 1e-6) {
    return a.y > box.minY && a.y < box.maxY && Math.max(a.x, b.x) > box.minX && Math.min(a.x, b.x) < box.maxX;
  }
  return a.x > box.minX && a.x < box.maxX && Math.max(a.y, b.y) > box.minY && Math.min(a.y, b.y) < box.maxY;
}

// ---- Context ----

export interface TerminalCtx {
  element: HvacElement;
  spec: DuctTerminalSpec;
  port: DuctAirPort;
  /** Lip and outward normal in the local frame. */
  lip: Point2D;
  normal: Point2D;
  airflowM3h: number;
  fixed: boolean;
  neck: number;
  branch: number;
  /**
   * The spigot sides the optimiser may give the terminal's plenum box (each a
   * full context: the element with that side, its spigot port), placed side
   * included. Only symmetric faces turn; unset = the placed side only.
   */
  variants?: TerminalCtx[];
  /** The side this context's spigot is on, where it differs from the drawing's. */
  turnedTo?: DuctTerminalSpigotSide;
}

/** Symmetric faces: the plenum box's spigot may go on any side without changing what the room sees. */
const TURNABLE: ReadonlySet<DuctTerminalSpec['kind']> = new Set(['square-4way', 'round', 'return-egg-crate']);
const SIDES: readonly DuctTerminalSpigotSide[] = ['back', 'front', 'left', 'right'];

/** The terminal with its plenum box's spigot on `side`: the element as it would be, and its spigot in the local frame. */
export function terminalWithSide(frame: Frame, terminal: TerminalCtx, side: DuctTerminalSpigotSide): TerminalCtx | null {
  if (side === terminal.spec.spigotSide) return { ...terminal, variants: undefined, turnedTo: undefined };
  const raw = (terminal.element.properties.terminal ?? {}) as Record<string, unknown>;
  const element: HvacElement = { ...terminal.element, properties: { ...terminal.element.properties, terminal: { ...raw, spigotSide: side } } };
  const port = terminalSpigotPort(element);
  const spec = readDuctTerminalSpec(element);
  if (!port || !spec) return null;
  return {
    ...terminal, element, spec, port, lip: toLocal(frame, port.lip), normal: cardinal(dirToLocal(frame, port.normal)),
    variants: undefined, turnedTo: side,
  };
}

/** Straight room a runout needs in front of a spigot to come in square (mm, practice). */
const SPIGOT_FRONT_MM = 400;

/**
 * The spigot sides worth trying for a terminal, from the four of a symmetric
 * face: those with room in front of them (a runout can come in square — no
 * equipment, other terminals included, within the neck's half and a margin
 * for `SPIGOT_FRONT_MM`), the most promising first (facing the collar's axis,
 * where trunks run, or back towards the unit), at most two. The placed side
 * alone for other faces, or when no side has room.
 */
export function spigotVariants(frame: Frame, terminal: TerminalCtx, enabled: boolean, obstacles: ServiceCtx['obstacles'] = []): TerminalCtx[] {
  const placed = { ...terminal, variants: undefined, turnedTo: undefined };
  if (!enabled || !TURNABLE.has(terminal.spec.kind)) return [placed];
  const centre = { x: terminal.lip.x - terminal.normal.x * 300, y: terminal.lip.y - terminal.normal.y * 300 };
  const onAxis = Math.abs(centre.y) < 150;
  const towardAxis = onAxis ? null : { x: 0, y: -Math.sign(centre.y) };
  const score = (normal: Point2D) => (towardAxis
    ? dot(normal, towardAxis) + 0.3 * -normal.x
    // On the axis the trunk passes beside the terminal: a side spigot, else one facing the unit.
    : Math.abs(normal.y) + 0.8 * Math.max(0, -normal.x) - Math.max(0, normal.x));
  const own = terminal.element.id;
  const pad = terminal.neck / 2 + FLEX_SKIN_MM;
  const roomInFront = (side: TerminalCtx) => {
    const a = side.lip;
    const b = { x: a.x + side.normal.x * SPIGOT_FRONT_MM, y: a.y + side.normal.y * SPIGOT_FRONT_MM };
    return obstacles.every((box) => box.id === own
      || Math.max(a.x, b.x) + pad <= box.minX || Math.min(a.x, b.x) - pad >= box.maxX
      || Math.max(a.y, b.y) + pad <= box.minY || Math.min(a.y, b.y) - pad >= box.maxY);
  };
  const sides = SIDES.flatMap((side) => terminalWithSide(frame, terminal, side) ?? [])
    .filter(roomInFront)
    .sort((a, b) => score(b.normal) - score(a.normal))
    .slice(0, 2);
  return sides.length ? sides : [placed];
}

export interface ServiceCtx {
  service: DuctService;
  unitId: string;
  frame: Frame;
  port: DuctAirPort;
  bottomZ: number;
  terminals: TerminalCtx[];
  airflowM3h: number;
  baseScene: HvacElement[];
  settings: DuctDesignSettings;
  /** Obstacles in the local frame, unpadded; routes pad them by their own half width. */
  obstacles: Array<OrthogonalRouteObstacle & { zMin: number; zMax: number }>;
  /** The drawing's walls (centre lines, world): a run that crosses one fails verification. */
  walls?: ReadonlyArray<{ id: string; startPoint: Point2D; endPoint: Point2D }>;
  maxHeightMm: number;
  construction: DuctDesignSettings['defaultConstruction'];
  ids: () => string;
}

/** The candidate under construction: its own trunk and branches become obstacles for the branches routed after them. */
export interface Build {
  extra: Array<OrthogonalRouteObstacle & { zMin: number; zMax: number }>;
  notes: AutoDuctIssue[];
}

export function newBuild(): Build {
  return { extra: [], notes: [] };
}

/** A run's legs as boxes in the local frame (half its width either side). */
export function addRunObstacles(ctx: ServiceCtx, build: Build, run: HvacElement): void {
  const spec = readDuctRunSpec(run);
  if (!spec) return;
  spec.legs.forEach((leg, index) => {
    const a = spec.path[index]!;
    const b = spec.path[index + 1]!;
    const half = (leg.diameterMm ?? leg.widthMm) / 2 + spec.insulationThicknessMm;
    build.extra.push({
      ...boxToLocal(ctx.frame, [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], half, run.id),
      zMin: Math.min(a.z, b.z), zMax: Math.max(a.z, b.z) + (leg.diameterMm ?? leg.heightMm),
    });
  });
}

// ---- Branches (shared by every layout) ----

/** Collar + damper at the start of a round branch (spin-in). */
export function branchStubMm(settings: DuctDesignSettings): number {
  return settings.tapCollarMm + settings.vcdLengthMm;
}

/** How far a flexible runout may reach from the collar stub before rigid duct is needed (mm, practice). */
export const ALL_FLEX_REACH_MM = 1300;
/** Where the rigid branch stops short of the terminal spigot: the runout's length (mm, practice). */
export const RUNOUT_TARGETS_MM = [800, 600, 1000];

/**
 * The flexible runout from a collar stub (leaving along `out`, local) into the
 * terminal's spigot, curved as the planner will draw it: its tightest bend and length.
 */
export function flexFit(ctx: ServiceCtx, stubEnd: Point2D, out: Point2D, stubBottomZ: number, terminal: TerminalCtx): { radiusMm: number; lengthMm: number } {
  const start = toWorld(ctx.frame, stubEnd);
  const direction = dirToWorld(ctx.frame, out);
  const curve = flexCurve(
    { ...start, z: stubBottomZ + terminal.neck / 2 }, { ...direction, z: 0 },
    terminal.port.lip, { x: -terminal.port.normal.x, y: -terminal.port.normal.y, z: 0 },
  );
  return { radiusMm: curve.minBendRadiusMm, lengthMm: curve.lengthMm };
}

/**
 * A runout the planner accepts: its tightest bend at least one diameter
 * (SMACNA S3.24, the planner's DU_FLEX_BEND rule; 2 mm for rounding) and no
 * longer than the settings allow. The curve is the planner's own (flexFit).
 */
export function flexOk(fit: { radiusMm: number; lengthMm: number }, terminal: TerminalCtx, settings: DuctDesignSettings): boolean {
  return fit.radiusMm >= terminal.neck + 2 && fit.lengthMm <= settings.flexMaxLengthMm;
}

/** Room kept around an insulated flexible runout (half its jacket over the neck, plus a margin; mm, practice). */
const FLEX_SKIN_MM = 25;

/**
 * Whether the flexible runout from a stub end (local frame, leaving along
 * `out`) into the terminal's spigot passes clear of every obstacle in its
 * height band — equipment, other terminals' boxes, pipes and existing ducts —
 * but the terminal it serves. The same curve the planner draws.
 */
/** The runout's centreline as the planner curves it, from a stub end along `out` into the terminal's spigot (world points). */
function runoutCurve(ctx: ServiceCtx, stubEnd: Point2D, out: Point2D, stubBottomZ: number, terminal: TerminalCtx) {
  const start = toWorld(ctx.frame, stubEnd);
  const direction = dirToWorld(ctx.frame, out);
  return flexCurve(
    { ...start, z: stubBottomZ + terminal.neck / 2 }, { ...direction, z: 0 },
    terminal.port.lip, { x: -terminal.port.normal.x, y: -terminal.port.normal.y, z: 0 },
  );
}

/** The same runout in the local frame, with the half-width it keeps clear (its radius and skin). */
export function runoutPath(ctx: ServiceCtx, stubEnd: Point2D, out: Point2D, stubBottomZ: number, terminal: TerminalCtx): { points: Point2D[]; radiusMm: number } {
  return {
    points: runoutCurve(ctx, stubEnd, out, stubBottomZ, terminal).points.map((point) => toLocal(ctx.frame, point)),
    radiusMm: terminal.neck / 2 + FLEX_SKIN_MM,
  };
}

/**
 * An all-flex branch's runout stays on its own side of the main it leaves
 * (local frame): no point of the curve comes back within the main's half
 * and the runout's own radius of the main's centreline.
 */
export function runoutStaysOut(ctx: ServiceCtx, mainPoint: Point2D, out: Point2D, stubEnd: Point2D, stubBottomZ: number, terminal: TerminalCtx, mainHalfMm: number): boolean {
  const path = runoutPath(ctx, stubEnd, out, stubBottomZ, terminal);
  return path.points.every((point) => (point.x - mainPoint.x) * out.x + (point.y - mainPoint.y) * out.y >= mainHalfMm + path.radiusMm);
}

export function flexClear(ctx: ServiceCtx, stubEnd: Point2D, out: Point2D, stubBottomZ: number, terminal: TerminalCtx): boolean {
  const curve = runoutCurve(ctx, stubEnd, out, stubBottomZ, terminal);
  const radius = terminal.neck / 2 + FLEX_SKIN_MM;
  const own = terminal.element.id;
  for (const point of curve.points) {
    const local = toLocal(ctx.frame, point);
    for (const box of ctx.obstacles) {
      if (box.id === own || box.zMax <= point.z - radius || box.zMin >= point.z + radius) continue;
      if (local.x > box.minX - radius && local.x < box.maxX + radius && local.y > box.minY - radius && local.y < box.maxY + radius) return false;
    }
  }
  return true;
}

export function obstaclesFor(ctx: ServiceCtx, padMm: number, zMin: number, zMax: number, exclude: ReadonlySet<string> = new Set(), build?: Build): OrthogonalRouteObstacle[] {
  return [...ctx.obstacles, ...(build?.extra ?? [])]
    .filter((box) => !(box.id && exclude.has(box.id)) && box.zMax > zMin && box.zMin < zMax)
    .map((box) => ({ ...(box.id ? { id: box.id } : {}), minX: box.minX - padMm, minY: box.minY - padMm, maxX: box.maxX + padMm, maxY: box.maxY + padMm }));
}

/** Whether a straight stretch of round duct (local frame, at `bottomZ`) runs into an obstacle. */
export function stretchBlocked(ctx: ServiceCtx, a: Point2D, b: Point2D, diameterMm: number, bottomZ: number, exclude: ReadonlySet<string>): boolean {
  const boxes = obstaclesFor(ctx, diameterMm / 2 + 50, bottomZ, bottomZ + diameterMm, exclude);
  return boxes.some((box) => segmentHitsBox(a, b, box));
}

/** Drops vertices where the path goes straight on. */
export function simplifyCollinear(points: Point2D[]): Point2D[] {
  const out: Point2D[] = [];
  for (const point of points) {
    if (out.length && Math.hypot(point.x - out[out.length - 1]!.x, point.y - out[out.length - 1]!.y) < 1) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      if (Math.abs(cross) < 1e-3 && (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y) > 0) out.pop();
    }
    out.push(point);
  }
  return out;
}
