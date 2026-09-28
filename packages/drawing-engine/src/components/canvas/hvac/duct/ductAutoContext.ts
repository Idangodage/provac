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
import type { DuctTerminalSpec } from './ductTerminals';
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
  | 'DU_TERMINAL_VELOCITY';

export interface AutoDuctIssue {
  code: AutoDuctIssueCode | string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  service?: DuctService;
  point?: Point2D;
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

export function flexOk(fit: { radiusMm: number; lengthMm: number }, terminal: TerminalCtx, settings: DuctDesignSettings): boolean {
  return fit.radiusMm >= terminal.neck * 1.05 && fit.lengthMm <= settings.flexMaxLengthMm;
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
