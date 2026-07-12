/**
 * REFNET-style branch kit: a component with 6 typed ports that splits one gas +
 * liquid pair into a MAIN outlet pair and a BRANCH outlet pair. Ports live in the
 * kit-local frame; world position/direction are derived through the kit transform,
 * so moving the kit carries every port (and therefore every connected endpoint).
 */

import type { BranchKit, KitTransform, Point, Port, PortRole } from '../model/types';
import { buildPairedGeometry, type PairedGeometry } from './offset';

export const KIT_TRUNK_HALF_MM = 100;
/** Tight arc for the kit fitting body. */
export const KIT_FITTING_RADIUS_MM = 10;
export const KIT_BRANCH_DROP_MM = 95;
/** Where the branch taps off the trunk (local x). */
export const KIT_BRANCH_TAP_X = 20;

/** The 6 ports for a given pipe gap (port pair spacing = gap, so it matches runs). */
export function refnetPorts(gapMm: number): Port[] {
  const h = gapMm / 2;
  // Sides match buildPairedGeometry's offset (+gap/2 = perpLeft): on the trunk
  // (travel +x) gas is at +y; on the branch (travel +y) gas is at −x. So the port
  // rings land on their own copper tube.
  return [
    { id: 'in-gas', type: 'gas', role: 'in', localPos: { x: -KIT_TRUNK_HALF_MM, y: h }, localDir: { x: -1, y: 0 } },
    { id: 'in-liquid', type: 'liquid', role: 'in', localPos: { x: -KIT_TRUNK_HALF_MM, y: -h }, localDir: { x: -1, y: 0 } },
    { id: 'out_main-gas', type: 'gas', role: 'out_main', localPos: { x: KIT_TRUNK_HALF_MM, y: h }, localDir: { x: 1, y: 0 } },
    { id: 'out_main-liquid', type: 'liquid', role: 'out_main', localPos: { x: KIT_TRUNK_HALF_MM, y: -h }, localDir: { x: 1, y: 0 } },
    { id: 'out_branch-gas', type: 'gas', role: 'out_branch', localPos: { x: KIT_BRANCH_TAP_X - h, y: KIT_BRANCH_DROP_MM }, localDir: { x: 0, y: 1 } },
    { id: 'out_branch-liquid', type: 'liquid', role: 'out_branch', localPos: { x: KIT_BRANCH_TAP_X + h, y: KIT_BRANCH_DROP_MM }, localDir: { x: 0, y: 1 } },
  ];
}

export function createRefnetKit(id: string, transform: KitTransform, gapMm: number): BranchKit {
  return { id, kind: 'refnet', transform, ports: refnetPorts(gapMm) };
}

// --- kit-local → world ---------------------------------------------------
export function kitToWorld(t: KitTransform, local: Point): Point {
  const lx = t.mirror ? -local.x : local.x;
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  return { x: t.pos.x + lx * c - local.y * s, y: t.pos.y + lx * s + local.y * c };
}
export function kitDirToWorld(t: KitTransform, dir: Point): Point {
  const dx = t.mirror ? -dir.x : dir.x;
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  return { x: dx * c - dir.y * s, y: dx * s + dir.y * c };
}
/** World → kit-local (inverse of {@link kitToWorld}). */
export function worldToKitLocal(t: KitTransform, world: Point): Point {
  const dx = world.x - t.pos.x;
  const dy = world.y - t.pos.y;
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const lx = dx * c + dy * s; // rotate by −rotation
  const ly = -dx * s + dy * c;
  return { x: t.mirror ? -lx : lx, y: ly };
}

/** Rough body hit-test (kit-local bounding box, generous). */
export function hitKit(kit: BranchKit, world: Point, padMm = 16): boolean {
  const l = worldToKitLocal(kit.transform, world);
  const halfY = KIT_BRANCH_DROP_MM;
  return (
    l.x >= -KIT_TRUNK_HALF_MM - padMm &&
    l.x <= KIT_TRUNK_HALF_MM + padMm &&
    l.y >= -padMm - 40 &&
    l.y <= halfY + padMm
  );
}

/**
 * Placement transform that binds the kit INLET pair centre onto a run open end and
 * points the trunk along the run's outward heading, so the run feeds straight into
 * the kit with no kink. (Inlet pair centre is kit-local (−TRUNK_HALF, 0).)
 */
export function snapKitToRunEnd(runEnd: Point, runOutward: Point): KitTransform {
  const rotation = Math.atan2(runOutward.y, runOutward.x);
  return {
    pos: { x: runEnd.x + KIT_TRUNK_HALF_MM * runOutward.x, y: runEnd.y + KIT_TRUNK_HALF_MM * runOutward.y },
    rotation,
    mirror: false,
  };
}

export function portWorld(kit: BranchKit, port: Port): { pos: Point; dir: Point } {
  return { pos: kitToWorld(kit.transform, port.localPos), dir: kitDirToWorld(kit.transform, port.localDir) };
}
export function findPort(kit: BranchKit, id: string): Port | undefined {
  return kit.ports.find((p) => p.id === id);
}
export function portOf(kit: BranchKit, role: PortRole, type: 'gas' | 'liquid'): Port | undefined {
  return kit.ports.find((p) => p.role === role && p.type === type);
}

/** World centre of a port PAIR (where a paired run's spine endpoint binds). */
export function portPairCenterWorld(kit: BranchKit, role: PortRole): Point | null {
  const g = portOf(kit, role, 'gas');
  const l = portOf(kit, role, 'liquid');
  if (!g || !l) return null;
  const gp = kitToWorld(kit.transform, g.localPos);
  const lp = kitToWorld(kit.transform, l.localPos);
  return { x: (gp.x + lp.x) / 2, y: (gp.y + lp.y) / 2 };
}

/** The world direction a run should leave the kit at a given port pair (outward). */
export function portPairDirWorld(kit: BranchKit, role: PortRole): Point | null {
  const g = portOf(kit, role, 'gas');
  if (!g) return null;
  return kitDirToWorld(kit.transform, g.localDir);
}

/** Only gas↔gas and liquid↔liquid may connect. */
export function canConnect(portType: 'gas' | 'liquid', lineType: 'gas' | 'liquid'): boolean {
  return portType === lineType;
}

/** The kit's own port-pair spacing (from its stored ports, not the live slider). */
export function kitGapMm(kit: BranchKit): number {
  const g = portOf(kit, 'in', 'gas');
  const l = portOf(kit, 'in', 'liquid');
  if (!g || !l) return 0;
  return Math.hypot(g.localPos.x - l.localPos.x, g.localPos.y - l.localPos.y);
}

/** Local centrelines of the kit body, for the copper render. */
export function kitChannels(): { trunk: Point[]; branch: Point[] } {
  return {
    trunk: [{ x: -KIT_TRUNK_HALF_MM, y: 0 }, { x: KIT_TRUNK_HALF_MM, y: 0 }],
    branch: [{ x: KIT_BRANCH_TAP_X, y: 0 }, { x: KIT_BRANCH_TAP_X, y: KIT_BRANCH_DROP_MM }],
  };
}

export interface KitBodyGeometry {
  trunk: PairedGeometry;
  branch: PairedGeometry;
}

/**
 * The kit's copper body (trunk + branch paired tubes) in the kit's LOCAL frame.
 * Because it is local it depends ONLY on the gap, so it is identical for every kit
 * of the same size and can be cached + rendered inside a transformed Konva Group —
 * moving/rotating the kit then just re-blits the cache (no geometry rebuild).
 */
export function buildKitBodyGeometry(gapMm: number): KitBodyGeometry {
  const ch = kitChannels();
  return {
    trunk: buildPairedGeometry(ch.trunk, gapMm, KIT_FITTING_RADIUS_MM),
    branch: buildPairedGeometry(ch.branch, gapMm, KIT_FITTING_RADIUS_MM),
  };
}

/** Kit rotation in DEGREES (Konva Group.rotation), from the radians transform. */
export function kitRotationDeg(kit: BranchKit): number {
  return (kit.transform.rotation * 180) / Math.PI;
}
