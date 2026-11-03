/**
 * How a duct comes at the air terminal it serves (practice; SMACNA S3.23 asks
 * for runouts as short as possible, ADC and the terminal makers for a straight
 * entry). A designer feeds a terminal from in front of its inlet: the duct
 * that serves it leaves the shared duct on the side the inlet faces, and comes
 * to it without passing it.
 *
 * - **Fed from behind:** the feed point — where the terminal's own duct leaves
 *   shared duct — lies behind the inlet's face by more than the neck's
 *   diameter (the room a runout's own bend takes). The duct must go round the
 *   box, or across in front of it, to come back into the inlet (a goose-neck),
 *   and a symmetric face's inlet could have been turned to face it.
 * - **Passes the inlet:** fed from one side of the inlet's axis, the duct
 *   crosses that axis and comes back from the other side.
 *
 * The feed point: a branch's start on its parent (a take-off, a split outlet,
 * a plenum spigot); a run from the unit's collar, its last take-off (after
 * which the run carries this terminal's air alone), else the collar. A top
 * collar takes its runout from any side and is not judged.
 */
import type { HvacElement, Point2D } from '../../../../types';

import type { DuctAirPort } from './ductAirPorts';
import { ductBranchesOf } from './ductNetwork';
import type { DuctTerminalSpigotSide } from './ductTerminalCatalog';
import { readDuctTerminalSpec, SQUARE_BOX_TERMINAL_KINDS, terminalSpigotPort } from './ductTerminals';
import type { DuctPoint3, DuctRunSpec } from './ductTypes';

/** A feed point at least this far behind the inlet's face is behind it, whatever the neck (mm). */
export const APPROACH_BEHIND_MM = 10;
/** A duct fed from one side of the inlet's axis may cross it by this much (or half the neck) before it passes the inlet (mm). */
export const APPROACH_PASS_MM = 100;
/** Fed this close to the inlet's axis, the duct is on its axis: no side to pass from (mm). */
const ON_AXIS_MM = 50;

const SIDES: readonly DuctTerminalSpigotSide[] = ['back', 'front', 'left', 'right'];

export interface TerminalApproach {
  /** Where the terminal's own duct leaves shared duct (plan). */
  feed: Point2D;
  /** How far the feed lies behind the inlet's face (≤ 0: in front; mm). */
  behindMm: number;
  /** How far the duct goes past the inlet's axis on the side away from its feed (mm; 0 when it does not). */
  passMm: number;
  passAt: Point2D | null;
}

const dot = (a: Point2D, b: Point2D) => a.x * b.x + a.y * b.y;

/** The point `stationMm` along leg `legIndex` of a path (plan). */
function pointOnLeg(path: readonly DuctPoint3[], legIndex: number, stationMm: number): Point2D {
  const a = path[Math.min(legIndex, path.length - 1)]!;
  const b = path[Math.min(legIndex + 1, path.length - 1)]!;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const t = length > 1e-9 ? Math.max(0, Math.min(1, stationMm / length)) : 0;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * The feed point of a run ending at a terminal and the run's points from there
 * on (plan); null for a run with no start to judge (an open start).
 */
export function terminalFeed(runId: string, spec: Pick<DuctRunSpec, 'start' | 'path'>, scene: readonly HvacElement[]): { feed: Point2D; points: Point2D[] } | null {
  const path = spec.path;
  if (!path.length || spec.start.kind === 'open') return null;
  const plan = path.map((point) => ({ x: point.x, y: point.y }));
  if (spec.start.kind !== 'unit-port') return { feed: plan[0]!, points: plan };
  // A run off the collar: from its last take-off on (the stretch that carries this terminal's air alone).
  let last: { legIndex: number; stationMm: number } | null = null;
  for (const branch of ductBranchesOf(runId, scene)) {
    if (branch.start.kind !== 'tap') continue;
    const { legIndex, stationMm } = branch.start;
    if (!last || legIndex > last.legIndex || (legIndex === last.legIndex && stationMm > last.stationMm)) last = { legIndex, stationMm };
  }
  if (!last) return { feed: plan[0]!, points: plan };
  const feed = pointOnLeg(path, last.legIndex, last.stationMm);
  return { feed, points: [feed, ...plan.slice(last.legIndex + 1)] };
}

/**
 * How the duct reaching `port` from `feed` along `points` (its rigid path from
 * the feed, then its runout's samples) comes at the inlet. Null for a top
 * collar.
 */
export function terminalApproach(port: Pick<DuctAirPort, 'lip' | 'normal' | 'vertical' | 'diameterMm' | 'widthMm'>, feed: Point2D, points: readonly Point2D[]): TerminalApproach | null {
  if (port.vertical) return null;
  const lip = { x: port.lip.x, y: port.lip.y };
  const n = port.normal;
  const t = { x: -n.y, y: n.x };
  const rel = (point: Point2D) => ({ x: point.x - lip.x, y: point.y - lip.y });
  const behindMm = -dot(rel(feed), n);
  const across = dot(rel(feed), t);
  let passMm = 0;
  let passAt: Point2D | null = null;
  if (Math.abs(across) >= ON_AXIS_MM) {
    const side = Math.sign(across);
    for (const point of points) {
      const beyond = -side * dot(rel(point), t);
      if (beyond > passMm) { passMm = beyond; passAt = point; }
    }
  }
  return { feed, behindMm, passMm, passAt };
}

/**
 * How far behind the inlet's face a feed may lie and still come in from the front: the neck's diameter, the room
 * a runout's own bend needs beside the box (mm).
 */
export function approachBehindLimitMm(port: Pick<DuctAirPort, 'diameterMm' | 'widthMm'>): number {
  return Math.max(APPROACH_BEHIND_MM, port.diameterMm ?? port.widthMm);
}

/** The most a duct may pass the inlet's axis before it counts as passing the inlet (mm). */
export function approachPassLimitMm(port: Pick<DuctAirPort, 'diameterMm' | 'widthMm'>): number {
  return Math.max(APPROACH_PASS_MM, (port.diameterMm ?? port.widthMm) / 2);
}

/** Whether the terminal's inlet may be turned (a symmetric face whose side was not set by hand). */
export function terminalInletTurnable(terminal: Pick<HvacElement, 'type' | 'properties'>): boolean {
  const spec = readDuctTerminalSpec(terminal);
  return Boolean(spec && spec.spigotEntry !== 'top' && SQUARE_BOX_TERMINAL_KINDS.has(spec.kind) && terminal.properties.spigotSideSetBy !== 'user');
}

/** The inlet side that faces a feed point best: the one the point lies furthest in front of. */
export function sideFacing(terminal: HvacElement, feed: Point2D): DuctTerminalSpigotSide | null {
  const raw = (terminal.properties.terminal ?? {}) as Record<string, unknown>;
  let best: { side: DuctTerminalSpigotSide; ahead: number } | null = null;
  for (const side of SIDES) {
    const port = terminalSpigotPort({ ...terminal, properties: { ...terminal.properties, terminal: { ...raw, spigotSide: side } } });
    if (!port) continue;
    const ahead = dot({ x: feed.x - port.lip.x, y: feed.y - port.lip.y }, port.normal);
    if (!best || ahead > best.ahead) best = { side, ahead };
  }
  return best?.side ?? null;
}
