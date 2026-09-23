/**
 * A pipe end as a real 3D frame, not a plan direction plus a scalar height.
 *
 * Connection records store `direction` as a 2D plan vector and the height as a
 * separate `elevationMm`. That shape cannot express a port whose axis is tilted,
 * so the editor rejects any edit that would need one outright ("this connected
 * port cannot represent a tilted direction"). It also cannot say "I have a
 * connection record but I cannot resolve what it points at" — an unresolved
 * connection silently reads as an open end, which is a different and much more
 * dangerous claim.
 *
 * This module derives a `PipePortFrame` for either end of a pipe:
 *
 *   - a real 3D `origin` and unit `axis` (the direction the pipe leaves the port
 *     along), tilted when the data supports it,
 *   - the stable identity of what it is attached to,
 *   - an explicit `kind`, including `unresolved`,
 *   - the straight approach the attachment reserves, carrying provenance so an
 *     unverified figure can never be mistaken for a manufacturer limit,
 *   - and what the attachment is permitted to do when the pipe moves.
 *
 * Legacy 2D records are read losslessly: the axis is derived in the plan and
 * flagged as such. A persisted 3D axis wins when one exists. Writers keep the
 * legacy `direction` / `elevationMm` keys in sync so every existing consumer —
 * four renderers, the VRF adapter, the branch-kit healer — keeps working.
 *
 * PURE: reads elements, writes nothing.
 */

import type { HvacElement, Point2D } from '../../../types';
import type { RuleValue } from '../../../vrf/rules/rule-profile';

import { getActivePipeRoutingSettings } from './pipeRoutingSettings';
import { isRefrigerantBranchKitElement, type RefrigerantBranchTerminalRole } from './refrigerantBranchKitModel';
import { ALL_PIPE_PORT_TYPES } from './unitPipePortModel';

export interface Vec3 { x: number; y: number; z: number }

/** What a pipe end is attached to. `unresolved` is never folded into `open`. */
export type PipePortKind = 'unit-port' | 'branch-kit' | 'pipe-weld' | 'open' | 'unresolved';

/** What the far side may do to accommodate a move of this pipe. */
export type PipePortMobility = 'fixed' | 'rotatable-about-origin' | 'free';

/** Stable identity of the thing on the other side of the weld. */
export interface PipePortIdentity {
  sourceElementId: string | null;
  portId: string | null;
  nodeId: string | null;
  terminalRole: RefrigerantBranchTerminalRole | null;
}

export interface PipePortFrame {
  endpoint: 'start' | 'end';
  kind: PipePortKind;
  identity: PipePortIdentity;
  /** Human label for diagnostics and the adaptation ribbon. */
  label: string;
  /** Weld position in model space (mm). Null only for an open end. */
  origin: Vec3 | null;
  /** Unit direction leaving the port INTO the pipe. Null when unknown. */
  axis: Vec3 | null;
  /**
   * Whether the axis carries real 3D information or was derived by dropping it
   * into the plan. A derived axis must not be treated as evidence that the port
   * is horizontal — only that nothing better was recorded.
   */
  axisSource: 'explicit-3d' | 'derived-plan' | 'unknown';
  /** Straight run the attachment reserves before the first fitting. */
  straightApproachMm: RuleValue<number>;
  mobility: PipePortMobility;
  /** Plan footprint of the owning component, when it publishes one. */
  boundsMm?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Why the frame is `unresolved`, for an honest diagnostic. */
  unresolvedReason?: string;
}

const EPSILON = 1e-9;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function readPoint2D(value: unknown): Point2D | null {
  const point = record(value);
  return point && isFiniteNumber(point.x) && isFiniteNumber(point.y)
    ? { x: point.x, y: point.y } : null;
}

export function normalizeVec3(value: Vec3): Vec3 | null {
  const length = Math.hypot(value.x, value.y, value.z);
  return Number.isFinite(length) && length > EPSILON
    ? { x: value.x / length, y: value.y / length, z: value.z / length } : null;
}

/** The connection record for one end, whichever schema this element uses. */
export function pipeConnectionRecord(element: HvacElement,
  endpoint: 'start' | 'end'): Record<string, unknown> | null {
  const key = element.type === 'refrigerant-pipe-pair'
    ? (endpoint === 'start' ? 'startBundleConnection' : 'endBundleConnection')
    : (endpoint === 'start' ? 'startConnection' : 'endConnection');
  return record(element.properties[key]);
}

/**
 * Centreline height of a connection.
 *
 * A bundle record carries one height per lane; the pair's own centreline sits
 * between them, which is exactly how `editablePipeNodes` derives it.
 */
function connectionElevationMm(connection: Record<string, unknown>): number | null {
  if (isFiniteNumber(connection.elevationMm)) return connection.elevationMm;
  const gas = connection.gasElevationMm;
  const liquid = connection.liquidElevationMm;
  return isFiniteNumber(gas) && isFiniteNumber(liquid) ? (gas + liquid) / 2 : null;
}

function connectionPlanPoint(connection: Record<string, unknown>): Point2D | null {
  for (const key of ['portPoint', 'point', 'gasPoint', 'liquidPoint']) {
    const point = readPoint2D(connection[key]);
    if (point) return point;
  }
  return null;
}

function connectionPlanDirection(connection: Record<string, unknown>): Point2D | null {
  for (const key of ['direction', 'gasDirection', 'liquidDirection']) {
    const direction = readPoint2D(connection[key]);
    if (direction && Math.hypot(direction.x, direction.y) > EPSILON) return direction;
  }
  return null;
}

const OPEN_APPROACH: RuleValue<number> = {
  value: 0, source: 'fallback', verified: false,
  note: 'An open end reserves no approach.',
};

/**
 * Straight approach a port reserves.
 *
 * The configured stub is a project setting, not a manufacturer figure, so it is
 * reported as `project-default` / unverified. Nothing here may claim compliance.
 */
function straightApproachFor(kind: PipePortKind): RuleValue<number> {
  if (kind === 'open') return OPEN_APPROACH;
  if (kind === 'unit-port') {
    return {
      value: getActivePipeRoutingSettings().minimumPortStubMm,
      source: 'project-default',
      verified: false,
      note: 'Configured minimum port stub. Not a verified manufacturer limit.',
    };
  }
  return {
    value: 0, source: 'project-default', verified: false,
    note: 'No straight approach is configured for this attachment kind.',
  };
}

function labelFor(source: HvacElement | undefined, fallback: string): string {
  return source?.label || source?.modelLabel || fallback;
}

function identityFrom(connection: Record<string, unknown>): PipePortIdentity {
  const text = (key: string): string | null =>
    typeof connection[key] === 'string' && connection[key] ? connection[key] as string : null;
  const role = text('terminalRole');
  return {
    sourceElementId: text('sourceElementId') ?? text('gasSourceElementId') ?? text('liquidSourceElementId'),
    portId: text('portId') ?? text('gasPortId') ?? text('liquidPortId'),
    nodeId: text('nodeId') ?? text('gasNodeId') ?? text('liquidNodeId'),
    terminalRole: role === 'inlet' || role === 'run-outlet' || role === 'branch-outlet' ? role : null,
  };
}

function readBounds(value: unknown): PipePortFrame['boundsMm'] {
  const raw = record(value);
  if (!raw) return undefined;
  const keys = ['minX', 'minY', 'maxX', 'maxY'] as const;
  return keys.every(key => isFiniteNumber(raw[key]))
    ? { minX: raw.minX as number, minY: raw.minY as number, maxX: raw.maxX as number, maxY: raw.maxY as number }
    : undefined;
}

const OPEN_FRAME = (endpoint: 'start' | 'end'): PipePortFrame => ({
  endpoint,
  kind: 'open',
  identity: { sourceElementId: null, portId: null, nodeId: null, terminalRole: null },
  label: 'Open end',
  origin: null,
  axis: null,
  axisSource: 'unknown',
  straightApproachMm: OPEN_APPROACH,
  mobility: 'free',
});

/**
 * Derive the 3D frame for one end.
 *
 * `axisOverride` carries a persisted 3D axis (from the design model) which wins
 * over the legacy plan direction. Without one the axis is the plan direction
 * lifted into 3D and flagged `derived-plan`.
 */
export function derivePipePortFrame(element: HvacElement, endpoint: 'start' | 'end',
  scene: readonly HvacElement[], axisOverride?: Vec3 | null): PipePortFrame {
  const connection = pipeConnectionRecord(element, endpoint);
  if (!connection) return OPEN_FRAME(endpoint);

  const identity = identityFrom(connection);
  const source = identity.sourceElementId
    ? scene.find(candidate => candidate.id === identity.sourceElementId)
    : undefined;

  const planPoint = connectionPlanPoint(connection);
  const elevationMm = connectionElevationMm(connection);
  const planDirection = connectionPlanDirection(connection);

  // A record that names a source we cannot find, or that carries no usable
  // position, is UNRESOLVED. Reporting it as open would assert freedom the
  // model has no evidence for.
  const unresolvedReason = !planPoint ? 'The connection record has no usable position.'
    : elevationMm === null ? 'The connection record has no elevation.'
      : identity.sourceElementId && !source ? `Connected element ${identity.sourceElementId} is not in the scene.`
        : null;

  const kind: PipePortKind = unresolvedReason ? 'unresolved'
    : source && isRefrigerantBranchKitElement(source) ? 'branch-kit'
      : connection.connectionKind === 'unit-port' || (source && ALL_PIPE_PORT_TYPES.has(source.type)) ? 'unit-port'
        : 'pipe-weld';

  const explicit = axisOverride ? normalizeVec3(axisOverride) : null;
  const derived = planDirection
    ? normalizeVec3({ x: planDirection.x, y: planDirection.y, z: 0 }) : null;

  return {
    endpoint,
    kind,
    identity,
    label: labelFor(source, kind === 'branch-kit' ? 'Branch kit'
      : kind === 'unit-port' ? 'Equipment port'
        : kind === 'unresolved' ? 'Unresolved connection' : 'Field pipe'),
    origin: planPoint && elevationMm !== null
      ? { x: planPoint.x, y: planPoint.y, z: elevationMm } : null,
    axis: explicit ?? derived,
    axisSource: explicit ? 'explicit-3d' : derived ? 'derived-plan' : 'unknown',
    straightApproachMm: straightApproachFor(kind),
    // A kit may be turned about its own weld; equipment and unresolved records
    // may not be moved by a pipe edit at all.
    mobility: kind === 'branch-kit' ? 'rotatable-about-origin' : 'fixed',
    ...(readBounds(connection.sourceBoundsMm) ? { boundsMm: readBounds(connection.sourceBoundsMm) } : {}),
    ...(unresolvedReason ? { unresolvedReason } : {}),
  };
}

/** True when this end pins the pipe's position (anything but a free open end). */
export function portFramePinsPosition(frame: PipePortFrame): boolean {
  return frame.kind !== 'open' && frame.origin !== null;
}

/**
 * True when the pipe's approach direction at this end must be preserved.
 *
 * An unresolved record pins what it can — the position — but asserting a
 * direction from data we could not resolve would be inventing a constraint.
 */
export function portFramePinsDirection(frame: PipePortFrame): boolean {
  return frame.kind !== 'open' && frame.kind !== 'unresolved' && frame.axis !== null;
}

/** The legacy keys a writer must keep in sync with a frame. */
export function portFrameLegacyProjection(frame: PipePortFrame): {
  direction?: Point2D; elevationMm?: number;
} {
  const projection: { direction?: Point2D; elevationMm?: number } = {};
  if (frame.axis) {
    const planLength = Math.hypot(frame.axis.x, frame.axis.y);
    // A purely vertical axis has no plan direction to write; leaving the legacy
    // key untouched is better than writing a zero vector every consumer would
    // normalise into garbage.
    if (planLength > EPSILON) {
      projection.direction = { x: frame.axis.x / planLength, y: frame.axis.y / planLength };
    }
  }
  if (frame.origin) projection.elevationMm = frame.origin.z;
  return projection;
}
