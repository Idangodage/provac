/**
 * What a selected pipe is actually attached to, and what its corners are made of.
 *
 * The adaptive solver treats a fixed end as an anonymous position + direction
 * constraint. That is enough to avoid breaking a weld, but not enough to decide
 * HOW to accommodate a move: a unit port is immovable and reserves a straight
 * approach, a branch kit can be rolled about its own centre to face a new
 * direction, a weld to another field pipe can often just travel with it, and an
 * open end is free. Likewise a corner is not simply an angle — it is either a
 * purchasable socket elbow, a formed field bend, or a riser elbow, and which one
 * it is decides whether the angle may change at all.
 *
 * This module answers those questions for one element, so the solver and the UI
 * can both reason about the real environment instead of about coordinates.
 *
 * PURE: reads the scene, writes nothing.
 */

import type { HvacElement, Point2D } from '../../../types';

import { resolveCopperSocketElbow } from './copperSocketElbows';
import type { PipeRouteNode3D } from './pipeRoute3d';
import { standardAngleFor, type PipeRuleContext } from './pipeRuleModel';
import type { PipeSkeleton } from './pipeSkeleton';
import { isRefrigerantBranchKitElement, type RefrigerantBranchTerminalRole } from './refrigerantBranchKitModel';
import { ALL_PIPE_PORT_TYPES } from './unitPipePortModel';

/** What sits at one end of a pipe. */
export type PipeEdgeAttachment =
  | {
      kind: 'unit-port';
      elementId: string;
      label: string;
      /** Direction the port pushes the pipe away along; the approach must hold it. */
      direction: PipeRouteNode3D | null;
      /** Straight copper the port reserves before the first bend. */
      stubMm: number;
      /** Plan footprint of the unit, so a reconnection does not cross its body. */
      boundsMm?: { minX: number; minY: number; maxX: number; maxY: number };
    }
  | {
      kind: 'branch-kit';
      elementId: string;
      label: string;
      terminalRole: RefrigerantBranchTerminalRole | null;
      direction: PipeRouteNode3D | null;
      /** Current kit orientation; rolling it re-aims every one of its ports. */
      rotationDeg: number;
      /** A kit with other pipes on its remaining ports cannot be freely rolled. */
      attachedPipeIds: string[];
    }
  | { kind: 'pipe-weld'; elementId: string; label: string; direction: PipeRouteNode3D | null }
  | { kind: 'open' };

/** What one corner of the route physically is. */
export interface PipeCornerFitting {
  jointIndex: number;
  angleDeg: number;
  kind: 'socket-elbow' | 'field-bend' | 'riser-elbow';
  /** The turn plane, named the way a fitter would name it. */
  orientation: 'plan' | 'riser' | 'compound';
  /** Catalogue part when the turn is a purchasable angle on hard copper. */
  catalogue: { model: string; angleDeg: 45 | 90; centerToFaceMm: number } | null;
  /** False when the angle is fixed by a catalogue part rather than formable. */
  angleIsFree: boolean;
}

export interface PipeEnvironment {
  elementId: string;
  start: PipeEdgeAttachment;
  end: PipeEdgeAttachment;
  fittings: PipeCornerFitting[];
  /** Legs that run vertically — the risers in the route. */
  riserLegIndices: number[];
  /** The other line of the same gas/liquid bundle, when there is one. */
  bundlePartnerId: string | null;
  /** Branch kits whose ports touch this route without being one of its ends. */
  touchingKitIds: string[];
}

const VERTICAL_DOT = 0.94;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readPoint(value: unknown): Point2D | null {
  const point = record(value);
  return point && typeof point.x === 'number' && typeof point.y === 'number'
    ? { x: point.x, y: point.y } : null;
}

function connectionFor(element: HvacElement, endpoint: 'start' | 'end'): Record<string, unknown> | null {
  const key = element.type === 'refrigerant-pipe-pair'
    ? (endpoint === 'start' ? 'startBundleConnection' : 'endBundleConnection')
    : (endpoint === 'start' ? 'startConnection' : 'endConnection');
  return record(element.properties[key]);
}

function labelFor(element: HvacElement | undefined, fallback: string): string {
  return element?.label || element?.modelLabel || fallback;
}

/**
 * Classify one end.
 *
 * The connection record names its source element; the element's own type decides
 * what kind of thing it is. A record with no resolvable source is still a weld —
 * it pins the end — but nothing can be inferred about moving the other side.
 */
export function analysePipeEdge(element: HvacElement, endpoint: 'start' | 'end',
  elements: readonly HvacElement[], stubMm: number): PipeEdgeAttachment {
  const connection = connectionFor(element, endpoint);
  if (!connection) return { kind: 'open' };
  const sourceId = typeof connection.sourceElementId === 'string' ? connection.sourceElementId : null;
  const source = sourceId ? elements.find(candidate => candidate.id === sourceId) : undefined;
  const plan = readPoint(connection.direction) ?? readPoint(connection.gasDirection);
  const direction = plan ? { x: plan.x, y: plan.y, z: 0 } : null;

  if (source && isRefrigerantBranchKitElement(source)) {
    const attachedPipeIds = elements.filter(candidate =>
      candidate.id !== element.id
      && (candidate.type === 'refrigerant-pipe' || candidate.type === 'refrigerant-pipe-pair')
      && (['start', 'end'] as const).some(side => {
        const other = connectionFor(candidate, side);
        return other && other.sourceElementId === source.id;
      })).map(candidate => candidate.id);
    return {
      kind: 'branch-kit', elementId: source.id, label: labelFor(source, 'Branch kit'),
      terminalRole: typeof connection.terminalRole === 'string'
        ? connection.terminalRole as RefrigerantBranchTerminalRole : null,
      direction, rotationDeg: source.rotation ?? 0, attachedPipeIds,
    };
  }
  if (connection.connectionKind === 'unit-port' || (source && ALL_PIPE_PORT_TYPES.has(source.type))) {
    const raw = record(connection.sourceBoundsMm);
    const bounds = raw && (['minX', 'minY', 'maxX', 'maxY'] as const).every(key => typeof raw[key] === 'number')
      ? { minX: raw.minX as number, minY: raw.minY as number, maxX: raw.maxX as number, maxY: raw.maxY as number }
      : undefined;
    return {
      kind: 'unit-port', elementId: sourceId ?? '', label: labelFor(source, 'Equipment port'),
      direction, stubMm, ...(bounds ? { boundsMm: bounds } : {}),
    };
  }
  return { kind: 'pipe-weld', elementId: sourceId ?? '', label: labelFor(source, 'Field pipe'), direction };
}

/** Name the plane a turn happens in, the way a fitter would. */
function orientationOf(planeNormal: PipeRouteNode3D): PipeCornerFitting['orientation'] {
  const vertical = Math.abs(planeNormal.z);
  return vertical > VERTICAL_DOT ? 'plan' : vertical < 1 - VERTICAL_DOT ? 'riser' : 'compound';
}

/**
 * Identify every corner of the route as a real fitting.
 *
 * A turn on hard copper at a catalogue angle IS that catalogue part, and its
 * angle is not free — changing it means buying a different fitting. A formed
 * bend on flexible tube can take any angle its former allows. A turn whose legs
 * include a vertical is a riser elbow however it is made.
 */
export function analysePipeCornerFittings(skeleton: PipeSkeleton, context: PipeRuleContext): PipeCornerFitting[] {
  return skeleton.joints.map(joint => {
    const standard = standardAngleFor(joint.angleDeg);
    const hard = skeleton.legs[joint.index - 1]?.material === 'hard'
      || skeleton.legs[joint.index]?.material === 'hard';
    const socket = standard && context.socketElbows && hard
      ? resolveCopperSocketElbow(context.pipeDiameterMm, standard) : null;
    const orientation = orientationOf(joint.planeNormal);
    const vertical = [joint.index - 1, joint.index]
      .some(legIndex => Math.abs(skeleton.legs[legIndex]?.direction.z ?? 0) > VERTICAL_DOT);
    return {
      jointIndex: joint.index,
      angleDeg: joint.angleDeg,
      kind: vertical ? 'riser-elbow' : socket ? 'socket-elbow' : 'field-bend',
      orientation,
      catalogue: socket
        ? { model: socket.catalogueModel ?? socket.id, angleDeg: standard!, centerToFaceMm: socket.centerToFaceMm }
        : null,
      // A socket elbow's angle is a purchased property; a formed bend's is not.
      angleIsFree: !socket,
    } satisfies PipeCornerFitting;
  });
}

/** Everything about one pipe's surroundings the solver or the UI may need. */
export function analysePipeEnvironment(element: HvacElement, elements: readonly HvacElement[],
  skeleton: PipeSkeleton, context: PipeRuleContext): PipeEnvironment {
  const bundleId = typeof element.properties.bundleId === 'string' ? element.properties.bundleId : null;
  const endIds = new Set([
    connectionFor(element, 'start')?.sourceElementId,
    connectionFor(element, 'end')?.sourceElementId,
  ].filter((value): value is string => typeof value === 'string'));

  return {
    elementId: element.id,
    start: analysePipeEdge(element, 'start', elements, context.minimumPortStubMm),
    end: analysePipeEdge(element, 'end', elements, context.minimumPortStubMm),
    fittings: analysePipeCornerFittings(skeleton, context),
    riserLegIndices: skeleton.legs
      .filter(leg => Math.abs(leg.direction.z) > VERTICAL_DOT)
      .map(leg => leg.index),
    bundlePartnerId: bundleId
      ? elements.find(candidate => candidate.id !== element.id
          && candidate.properties.bundleId === bundleId)?.id ?? null
      : null,
    // A kit sitting ON the run (rather than at an end) is part of the
    // environment too: moving the run drags its tap with it.
    touchingKitIds: elements.filter(candidate => isRefrigerantBranchKitElement(candidate)
      && !endIds.has(candidate.id)
      && touchesRoute(candidate, skeleton.nodes)).map(candidate => candidate.id),
  };
}

function touchesRoute(kit: HvacElement, nodes: readonly PipeRouteNode3D[]): boolean {
  const centre = { x: kit.position.x + kit.width / 2, y: kit.position.y + kit.depth / 2 };
  const reach = Math.max(kit.width, kit.depth);
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const t = squared > 1e-9
      ? Math.max(0, Math.min(1, ((centre.x - a.x) * dx + (centre.y - a.y) * dy) / squared)) : 0;
    if (Math.hypot(centre.x - a.x - t * dx, centre.y - a.y - t * dy) <= reach) return true;
  }
  return false;
}

const EDGE_LABEL: Record<PipeEdgeAttachment['kind'], string> = {
  'unit-port': 'equipment port', 'branch-kit': 'branch kit', 'pipe-weld': 'welded pipe', open: 'open end',
};

/** One readable line describing the pipe and what it is tied to. */
export function describePipeEnvironment(environment: PipeEnvironment): string {
  const edge = (attachment: PipeEdgeAttachment): string => attachment.kind === 'open'
    ? 'open end'
    : `${attachment.label} (${EDGE_LABEL[attachment.kind]}${attachment.kind === 'branch-kit' && attachment.terminalRole ? ` · ${attachment.terminalRole}` : ''})`;
  const counts = new Map<string, number>();
  for (const fitting of environment.fittings) {
    const key = fitting.catalogue
      ? `${fitting.catalogue.angleDeg}° ${fitting.catalogue.model}`
      : `${fitting.kind === 'riser-elbow' ? 'riser elbow' : 'field bend'} ${fitting.angleDeg.toFixed(0)}°`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const fittings = [...counts].map(([key, count]) => `${count}× ${key}`).join(', ');
  return `${edge(environment.start)} → ${edge(environment.end)}; ${environment.fittings.length
    ? fittings : 'no bends'}${environment.riserLegIndices.length ? `; ${environment.riserLegIndices.length} riser(s)` : ''}`;
}
