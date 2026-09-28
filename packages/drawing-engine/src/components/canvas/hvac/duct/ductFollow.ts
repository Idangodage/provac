/**
 * Runs follow what they hang off. When a unit moves or turns, the runs on its
 * collars move rigidly with it; when a run changes (moved, resized, re-routed),
 * every branch taken off it is re-anchored on its take-off wall or split outlet
 * and moved rigidly, and so on down the branch tree. The callers fold these
 * updates into the gesture's own command, so one undo reverts everything.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { findAirPort } from './ductAirPorts';
import { splitOutlet, tapAttachment } from './ductBranches';
import { resolveSectionConstruction } from './ductGauge';
import { ductLegs } from './ductGeometry';
import { ductBranchesOf } from './ductNetwork';
import { spigotAttachment } from './ductPlenum';
import { findTerminalPort } from './ductTerminals';
import type { DuctDesignSettings } from './ductSettings';
import { buildDuctRunElement, readDuctRunSpec, type DuctLeg, type DuctRunSpec } from './ductTypes';

/** Where a run is anchored: a plan point, the direction it leaves in, and its level. */
export interface DuctAnchor {
  point: Point2D;
  direction: Point2D;
  z: number;
}

/** Move a run so `from` lands on `to` (rotation about the anchor, then translation). */
export function rigidTransformSpec(spec: DuctRunSpec, from: DuctAnchor, to: DuctAnchor): DuctRunSpec {
  const angle = Math.atan2(to.direction.y, to.direction.x) - Math.atan2(from.direction.y, from.direction.x);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dz = to.z - from.z;
  const path = spec.path.map((point) => {
    const x = point.x - from.point.x;
    const y = point.y - from.point.y;
    return {
      x: to.point.x + x * cos - y * sin,
      y: to.point.y + x * sin + y * cos,
      z: point.z + dz,
    };
  });
  return { ...spec, path };
}

/** The document update for a run whose spec changed (its envelope follows the path). */
export function ductRunElementWithSpec(element: HvacElement, spec: DuctRunSpec): HvacElement {
  const built = buildDuctRunElement(spec, { label: element.label });
  return {
    ...element,
    position: built.position,
    width: built.width,
    depth: built.depth,
    height: built.height,
    elevation: built.elevation,
    properties: { ...element.properties, ...built.properties },
  };
}

export function toElementUpdate(element: HvacElement): { id: string; updates: Partial<HvacElement> } {
  const { position, width, depth, height, elevation, properties } = element;
  return { id: element.id, updates: { position, width, depth, height, elevation, properties } };
}

function sheetOf(spec: DuctRunSpec, section: DuctLeg, settings: DuctDesignSettings): number {
  return resolveSectionConstruction({
    widthMm: section.widthMm, heightMm: section.heightMm, service: spec.service, construction: spec.construction,
    settings, pressureClassPa: spec.pressureClassPa, jointSystem: spec.jointSystem, gaugeOverrideMm: spec.gaugeOverrideMm,
  }).sheetThicknessMm ?? 1;
}

function startAnchor(spec: DuctRunSpec): DuctAnchor | null {
  const a = spec.path[0];
  const b = spec.path[1];
  if (!a || !b) return null;
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { point: { x: a.x, y: a.y }, direction: { x: (b.x - a.x) / length, y: (b.y - a.y) / length }, z: a.z };
}

/** Where a branch now attaches on its (changed) parent; null when it no longer can. */
function branchAnchor(parentSpec: DuctRunSpec, branchSpec: DuctRunSpec, settings: DuctDesignSettings): DuctAnchor | null {
  const start = branchSpec.start;
  const firstSection = branchSpec.legs[0];
  if (!firstSection) return null;
  if (start.kind === 'tap') {
    const section = parentSpec.legs[start.legIndex];
    if (!section) return null;
    const attachment = tapAttachment(parentSpec, start, firstSection, sheetOf(parentSpec, section, settings), settings);
    return attachment ? { point: attachment.wallPoint, direction: attachment.direction, z: attachment.bottomZ } : null;
  }
  if (start.kind === 'spigot') {
    const plenum = parentSpec.end.kind === 'plenum' ? parentSpec.end : null;
    const attachment = plenum ? spigotAttachment(parentSpec, start, firstSection, sheetOf(parentSpec, { widthMm: plenum.widthMm, heightMm: plenum.heightMm }, settings), settings) : null;
    return attachment ? { point: attachment.wallPoint, direction: attachment.direction, z: attachment.bottomZ } : null;
  }
  if (start.kind === 'split-branch' && parentSpec.end.kind === 'split') {
    const last = parentSpec.legs[parentSpec.legs.length - 1]!;
    const outlet = splitOutlet(parentSpec, parentSpec.end.style, start.side, firstSection, sheetOf(parentSpec, last, settings), settings);
    return outlet ? { point: outlet.point, direction: outlet.direction, z: outlet.bottomZ } : null;
  }
  return null;
}

const MOVED_EPSILON_MM = 0.01;

function anchorsDiffer(a: DuctAnchor, b: DuctAnchor): boolean {
  return Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) > MOVED_EPSILON_MM
    || Math.abs(a.z - b.z) > MOVED_EPSILON_MM
    || Math.hypot(a.direction.x - b.direction.x, a.direction.y - b.direction.y) > 1e-9;
}

/**
 * Re-anchor the branches of every changed run, recursively. `changed` holds the
 * new versions of the runs that moved or changed; the result is the moved
 * branch runs (not including `changed` itself).
 */
export function reanchorBranches(
  scene: readonly HvacElement[],
  changed: ReadonlyMap<string, HvacElement>,
  settings: DuctDesignSettings,
): HvacElement[] {
  const current = new Map<string, HvacElement>(changed);
  const result = new Map<string, HvacElement>();
  const withChanges = () => scene.map((element) => current.get(element.id) ?? element);
  const queue = [...changed.keys()];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    if (seen.has(parentId)) continue;
    seen.add(parentId);
    const parent = current.get(parentId);
    const parentSpec = parent ? readDuctRunSpec(parent) : null;
    if (!parentSpec) continue;
    for (const branch of ductBranchesOf(parentId, withChanges())) {
      const from = startAnchor(branch.spec);
      const to = branchAnchor(parentSpec, branch.spec, settings);
      if (!from || !to || !anchorsDiffer(from, to)) continue;
      const moved = ductRunElementWithSpec(branch.element, rigidTransformSpec(branch.spec, from, to));
      current.set(moved.id, moved);
      result.set(moved.id, moved);
      queue.push(moved.id);
    }
  }
  return [...result.values()];
}

/**
 * Runs on the collars of moved units move rigidly with them (a turn of the unit
 * turns the run about its collar), and their branch trees follow.
 */
export function followDuctsForUnitMove(
  before: readonly HvacElement[],
  after: readonly HvacElement[],
  movedUnitIds: readonly string[],
  settings: DuctDesignSettings,
): HvacElement[] {
  const moved = new Set(movedUnitIds);
  const changed = new Map<string, HvacElement>();
  for (const element of after) {
    const spec = readDuctRunSpec(element);
    if (!spec || spec.legacy || spec.start.kind !== 'unit-port' || !moved.has(spec.start.unitId)) continue;
    const oldPort = findAirPort(before, spec.start.unitId, spec.start.portId);
    const newPort = findAirPort(after, spec.start.unitId, spec.start.portId);
    if (!oldPort || !newPort) continue;
    const from = { point: { x: oldPort.lip.x, y: oldPort.lip.y }, direction: oldPort.normal, z: oldPort.lip.z };
    const to = { point: { x: newPort.lip.x, y: newPort.lip.y }, direction: newPort.normal, z: newPort.lip.z };
    if (!anchorsDiffer(from, to)) continue;
    changed.set(element.id, ductRunElementWithSpec(element, rigidTransformSpec(spec, from, to)));
  }
  // A run ending on a moved terminal: its end point follows the spigot (a runout re-bends to it).
  for (const element of after) {
    const current = changed.get(element.id) ?? element;
    const spec = readDuctRunSpec(current);
    if (!spec || spec.end.kind !== 'terminal' || !moved.has(spec.end.terminalId)) continue;
    const port = findTerminalPort(after, spec.end.terminalId, spec.end.portId);
    if (!port) continue;
    const lastSection = spec.legs[spec.legs.length - 1]!;
    const diameter = lastSection.diameterMm ?? lastSection.heightMm;
    const path = spec.path.map((point, index) => (index === spec.path.length - 1 ? { x: port.lip.x, y: port.lip.y, z: port.lip.z - diameter / 2 } : point));
    changed.set(element.id, ductRunElementWithSpec(current, { ...spec, path }));
  }
  if (changed.size === 0) return [];
  const scene = after.map((element) => changed.get(element.id) ?? element);
  return [...changed.values(), ...reanchorBranches(scene, changed, settings)];
}

export interface DuctMoveResult {
  /** Moved runs (the selection and every branch that followed). */
  moved: HvacElement[];
  /** Why some selected runs stayed put (attached to a unit collar or a split outlet). */
  refused: string | null;
}

/**
 * Move the selected runs by `delta` (plan). A free run (open start) translates;
 * a take-off slides along its parent (its station changes, it stays square to
 * the wall); a run on a unit collar or a split outlet stays put (move the unit
 * or the parent instead). Branches of every moved run follow. A run whose
 * parent is also moving is carried by its parent, not moved twice.
 */
export function moveDuctRuns(
  scene: readonly HvacElement[],
  ids: readonly string[],
  delta: Point2D,
  settings: DuctDesignSettings,
): DuctMoveResult {
  const selected = new Set(ids);
  const changed = new Map<string, HvacElement>();
  const refusedLabels: string[] = [];
  for (const element of scene) {
    if (!selected.has(element.id)) continue;
    const spec = readDuctRunSpec(element);
    if (!spec || spec.legacy) continue;
    const start = spec.start;
    if ((start.kind === 'tap' || start.kind === 'split-branch') && selected.has(start.parentRunId)) continue;
    if (start.kind === 'unit-port' || start.kind === 'split-branch' || start.kind === 'spigot') {
      refusedLabels.push(element.label || element.id);
      continue;
    }
    if (start.kind === 'tap') {
      const parent = scene.find((candidate) => candidate.id === start.parentRunId);
      const parentSpec = parent ? readDuctRunSpec(parent) : null;
      const leg = parentSpec ? ductLegs(parentSpec)[start.legIndex] : undefined;
      const section = parentSpec?.legs[start.legIndex];
      if (!parentSpec || !leg || !section) continue;
      const along = delta.x * leg.direction.x + delta.y * leg.direction.y;
      const stationMm = Math.round(Math.min(leg.lengthMm, Math.max(0, start.stationMm + along)) / 10) * 10;
      const slid: DuctRunSpec = { ...spec, start: { ...start, stationMm } };
      const to = branchAnchor(parentSpec, slid, settings);
      const from = startAnchor(spec);
      if (!to || !from) continue;
      changed.set(element.id, ductRunElementWithSpec(element, rigidTransformSpec(slid, from, to)));
      continue;
    }
    const translated: DuctRunSpec = { ...spec, path: spec.path.map((point) => ({ ...point, x: point.x + delta.x, y: point.y + delta.y })) };
    changed.set(element.id, ductRunElementWithSpec(element, translated));
  }
  const nextScene = scene.map((element) => changed.get(element.id) ?? element);
  const followers = changed.size > 0 ? reanchorBranches(nextScene, changed, settings) : [];
  return {
    moved: [...changed.values(), ...followers],
    refused: refusedLabels.length > 0
      ? `${refusedLabels.join(', ')} ${refusedLabels.length === 1 ? 'starts' : 'start'} on a unit collar, a split outlet or a plenum spigot: move the unit or the parent run instead.`
      : null,
  };
}
