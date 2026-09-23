/**
 * The canonical, persisted design model for a refrigerant pipe.
 *
 * Everything in this application edits `routePoints` / `routeNodes3d` — a
 * FABRICATION polyline that carries arc tessellation, port stubs and takeoff
 * fans as ordinary vertices. Editing it directly has three consequences that no
 * amount of solver work can fix:
 *
 *   1. There are no stable identities. A corner is an array index, so inserting
 *      a bend renumbers everything downstream and any diagnostic, lock or
 *      selection keyed to a corner silently moves to a different corner.
 *   2. The degrees of freedom a solver reasons about — a joint's bend plane, its
 *      radius, which catalogue part it is, whether its angle may change at all —
 *      have nowhere to live, so they are recovered by guesswork on every read
 *      and discarded on every write.
 *   3. A port is a 2D direction plus a scalar height, so a tilted approach
 *      cannot be represented and is rejected rather than solved.
 *
 * `PipeDesign` is the semantic model those three problems need: identified
 * nodes, legs and joints, real 3D port frames, and provenance for every value
 * that was recovered rather than authored.
 *
 * ## Two rules that make this safe to add to a live document
 *
 * **Migrate on read, persist on first real edit.** `readPipeDesign` returns a
 * design for every pipe, reconstructing one when `properties.pipeDesign` is
 * absent. Nothing is written until the user actually edits. This matters more
 * than it looks: `autoRouteElementSignature` hashes the whole element, so
 * writing a new property key into every pipe on load would reclassify every
 * generated circuit as manually edited and stop the auto-router replacing them.
 *
 * **The fabrication route stays the rendered truth.** `writePipeDesign`
 * regenerates `routePoints`, `routeNodes3d` and `segmentMaterials` from the
 * design and keeps the legacy connection keys in sync, so all four renderers,
 * the VRF adapter and the branch-kit healer keep working untouched.
 *
 * PURE: elements in, elements out. No store, React or renderer imports.
 */

import type { HvacElement, Point2D } from '../../../types';
import type { RuleValue } from '../../../vrf/rules/rule-profile';

import { usesCopperSocketElbows } from './copperSocketElbows';
import { resolveFieldPipeBendRadiusMm } from './fieldPipeBends';
import {
  derivePipePortFrame, normalizeVec3, pipeConnectionRecord, portFrameLegacyProjection,
  type PipePortFrame, type Vec3,
} from './pipePortFrame';
import { readPipeRouteNodes3d, type PipeRouteNode3D } from './pipeRoute3d';
import { buildPipeSkeleton } from './pipeSkeleton';
import {
  resolveRefrigerantPipePairSpec, resolveRefrigerantPipeSpec, type RefrigerantPipeMaterial,
} from './refrigerantPipePairModel';

export const PIPE_DESIGN_VERSION = 1;
/** Property key the design is persisted under. Additive; no schema bump. */
export const PIPE_DESIGN_PROPERTY = 'pipeDesign';

/** Where the design came from, so uncertainty is never lost. */
export type PipeDesignProvenance =
  /** Read back from a persisted design written by a previous edit. */
  | 'authored'
  /** Rebuilt from a stored 3D route by collapsing its tessellation. */
  | 'reconstructed'
  /** Rebuilt from a plan-only route whose vertical transitions were recovered. */
  | 'migrated';

export interface PipeDesignNode { id: string; x: number; y: number; z: number }

export interface PipeDesignLeg {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  material: RefrigerantPipeMaterial;
  /** Derived on read — never trusted from storage. */
  lengthMm: number;
  direction: Vec3;
}

/**
 * A corner, as a fitting rather than an angle.
 *
 * `construction` and `catalogueId` are deliberately separate from orientation
 * and from the angle. A 90-degree turn beside a riser is not evidence that a
 * catalogue elbow is installed there, and a visually similar angle is not
 * evidence of a part number.
 */
export interface PipeDesignJoint {
  id: string;
  nodeId: string;
  construction: 'socket-elbow' | 'formed-bend';
  /** How `construction` was established. */
  constructionSource: 'persisted' | 'element-policy';
  /** Installed part. `null` means no part is recorded — never guess one. */
  catalogueId: string | null;
  includedAngleDeg: number;
  radiusMm: RuleValue<number>;
  /** Unit normal of the turn plane. Rolling this re-orients the fitting. */
  planeNormal: Vec3;
  lock?: 'angle' | 'plane' | 'rigid' | 'pinned';
}

export interface PipeDesign {
  version: typeof PIPE_DESIGN_VERSION;
  provenance: PipeDesignProvenance;
  nodes: PipeDesignNode[];
  legs: PipeDesignLeg[];
  joints: PipeDesignJoint[];
  ports: { start: PipePortFrame; end: PipePortFrame };
  /**
   * Conditions the model could not establish. Never empty just to look clean —
   * an unresolved transition must stay visible rather than be presented as a
   * verified route.
   */
  unresolved: string[];
}

const EPSILON = 1e-9;
/** Below this a vertical difference is not a riser. */
const RISER_EPSILON_MM = 0.5;

const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const magnitude = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const distance = (a: Vec3, b: Vec3): number => magnitude(subtract(a, b));
const cross = (a: Vec3, b: Vec3): Vec3 =>
  ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function turnDegrees(incoming: Vec3, outgoing: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(incoming, outgoing)))) * 180 / Math.PI;
}

/** A turn plane; a straight pass-through still needs a rollable frame. */
function planeNormalFor(incoming: Vec3, outgoing: Vec3): Vec3 {
  const normal = normalizeVec3(cross(incoming, outgoing));
  if (normal) return normal;
  const reference: Vec3 = Math.abs(incoming.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  return normalizeVec3(cross(incoming, reference)) ?? { x: 0, y: 0, z: 1 };
}

// --- identities -------------------------------------------------------------

/**
 * Deterministic seed identities.
 *
 * These are stable for as long as the topology is, and are replaced by the
 * persisted ones the moment a design is written — after which they survive
 * insertion, removal and splitting because the solver carries them.
 */
const seedNodeId = (elementId: string, index: number) => `${elementId}:n${index}`;
const seedLegId = (elementId: string, index: number) => `${elementId}:l${index}`;
const seedJointId = (elementId: string, index: number) => `${elementId}:j${index}`;

// --- route reading ----------------------------------------------------------

/**
 * The stored 3D route, or the plan route lifted onto whatever elevation the
 * connection records establish.
 *
 * This is the historic `editablePipeNodes` behaviour, kept byte-compatible: a
 * plan-only route is flattened onto the START elevation. The flattening is a
 * defect, not an intent — {@link recoverTerminalRiser} repairs it during
 * reconstruction and records that it did.
 */
export function readPipeRouteNodes(element: HvacElement): PipeRouteNode3D[] {
  const stored = readPipeRouteNodes3d(element);
  if (stored.length >= 2) return stored;
  if (element.type === 'refrigerant-pipe-pair') {
    const spec = resolveRefrigerantPipePairSpec(element.properties);
    const z = spec.startBundleConnection
      ? (spec.startBundleConnection.gasElevationMm + spec.startBundleConnection.liquidElevationMm) / 2
      : element.elevation + (spec.gasOuterDiameterMm + spec.liquidOuterDiameterMm) / 4;
    return spec.routePoints.map(point => ({ ...point, z }));
  }
  const spec = resolveRefrigerantPipeSpec(element.properties);
  const z = spec.startConnection?.elevationMm ?? spec.endConnection?.elevationMm
    ?? element.elevation + spec.outerDiameterMm / 2;
  return spec.routePoints.map(point => ({ ...point, z }));
}

/** Per-segment material for the stored route, inferring only when unrecorded. */
export function readPipeSegmentMaterials(element: HvacElement,
  nodes = readPipeRouteNodes(element)): RefrigerantPipeMaterial[] {
  const raw = element.properties.segmentMaterials;
  if (Array.isArray(raw) && raw.length === nodes.length - 1) {
    return raw.map(material => material === 'hard' ? 'hard' : 'flexible');
  }
  const spec = resolveRefrigerantPipeSpec(element.properties);
  return nodes.slice(1).map((end, index) => {
    const start = nodes[index]!;
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    let closest = Infinity;
    let material: RefrigerantPipeMaterial = 'flexible';
    for (let planIndex = 0; planIndex < spec.routePoints.length - 1; planIndex += 1) {
      const a = spec.routePoints[planIndex]!;
      const b = spec.routePoints[planIndex + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const squared = dx * dx + dy * dy;
      const fraction = squared > 1e-9
        ? Math.max(0, Math.min(1, ((midpoint.x - a.x) * dx + (midpoint.y - a.y) * dy) / squared)) : 0;
      const separation = Math.hypot(midpoint.x - a.x - fraction * dx, midpoint.y - a.y - fraction * dy);
      const nextMaterial = spec.segmentMaterials[planIndex] ?? 'flexible';
      if (separation < closest - 1e-6) { closest = separation; material = nextMaterial; }
      else if (Math.abs(separation - closest) <= 1e-6 && nextMaterial === 'hard') material = 'hard';
    }
    return material;
  });
}

// --- reconstruction ---------------------------------------------------------

/**
 * Give a plan-only route its missing vertical transition.
 *
 * A pipe stored without `routeNodes3d` has no elevation beyond its two
 * connection records, so every node is flattened onto the start elevation. When
 * the ends are welded at different heights the route cannot reach its own end
 * port and every edit is refused by the whole elevation delta before the user
 * has touched anything.
 *
 * The repair is a real riser at the corner feeding the terminal stub, so the
 * port approach stays straight and horizontal — never a linear ramp along the
 * run, which would turn every corner into a compound angle and invalidate the
 * hard-pipe fitting checks.
 *
 * Reversible: it inserts one node whose XY duplicates its neighbour, which
 * {@link writePipeDesign} collapses back out if the transition is later removed.
 * Idempotent: a route that already reaches both elevations is returned as-is.
 */
function recoverTerminalRiser(element: HvacElement, nodes: readonly PipeRouteNode3D[],
  materials: readonly RefrigerantPipeMaterial[], ports: { start: PipePortFrame; end: PipePortFrame }):
  { nodes: PipeRouteNode3D[]; materials: RefrigerantPipeMaterial[]; migrated: boolean; unresolved: string[] } {
  const plain = {
    nodes: nodes.map(node => ({ ...node })),
    materials: [...materials],
    migrated: false,
    unresolved: [] as string[],
  };
  if (readPipeRouteNodes3d(element).length >= 2) return plain;

  const startZ = ports.start.origin?.z ?? null;
  const endZ = ports.end.origin?.z ?? null;
  if (startZ === null || endZ === null) return plain;
  if (Math.abs(startZ - endZ) < RISER_EPSILON_MM) return plain;

  if (nodes.length < 3) {
    // Two nodes and two different elevations: a transition is required but
    // there is no interior corner to hang it on. Say so rather than inventing
    // a location; the solver can still create one as an explicit edit.
    return {
      ...plain,
      unresolved: [`A vertical transition of ${Math.abs(startZ - endZ).toFixed(0)} mm is required `
        + 'between the two ends, but the stored plan route has no interior corner to place it at.'],
    };
  }

  const corner = nodes[nodes.length - 2]!;
  return {
    nodes: [
      ...plain.nodes.slice(0, -1),
      { x: corner.x, y: corner.y, z: endZ },
      { ...plain.nodes[plain.nodes.length - 1]!, z: endZ },
    ],
    // The riser is the same physical drop into the unit as the stub it feeds.
    materials: [...plain.materials.slice(0, -1),
      plain.materials.at(-1) ?? 'flexible', plain.materials.at(-1) ?? 'flexible'],
    migrated: true,
    unresolved: [],
  };
}

function radiusRuleValue(recoveredMm: number, fallbackMm: number): RuleValue<number> {
  return recoveredMm > EPSILON
    ? {
        value: recoveredMm, source: 'fallback', verified: false,
        note: 'Recovered from sampled arc geometry; not a recorded fitting radius.',
      }
    : {
        value: fallbackMm, source: 'project-default', verified: false,
        note: 'Derived from the configured bend-radius factor.',
      };
}

/** Rebuild a design from whatever the element actually stores. */
function reconstructPipeDesign(element: HvacElement, scene: readonly HvacElement[]): PipeDesign {
  const ports = {
    start: derivePipePortFrame(element, 'start', scene),
    end: derivePipePortFrame(element, 'end', scene),
  };
  const storedNodes = readPipeRouteNodes(element);
  const storedMaterials = readPipeSegmentMaterials(element, storedNodes);

  const defaultBendRadiusMm = resolveFieldPipeBendRadiusMm(
    resolveRefrigerantPipeSpec(element.properties).outerDiameterMm,
    element.properties.bendRadiusFactor,
  );

  // Collapse tessellation first so a recovered riser lands on a design corner
  // rather than inside a sampled arc.
  const flat = buildPipeSkeleton(storedNodes, { materials: storedMaterials, defaultBendRadiusMm });
  const lifted = recoverTerminalRiser(element, flat.nodes, flat.legs.map(leg => leg.material), ports);
  const skeleton = lifted.migrated
    ? buildPipeSkeleton(lifted.nodes, { materials: lifted.materials, defaultBendRadiusMm })
    : flat;

  const construction: PipeDesignJoint['construction'] =
    usesCopperSocketElbows(element.properties) ? 'socket-elbow' : 'formed-bend';

  const nodes: PipeDesignNode[] = skeleton.nodes.map((node, index) => ({
    id: seedNodeId(element.id, index), x: node.x, y: node.y, z: node.z,
  }));
  const legs: PipeDesignLeg[] = skeleton.legs.map((leg, index) => ({
    id: seedLegId(element.id, index),
    fromNodeId: nodes[index]!.id,
    toNodeId: nodes[index + 1]!.id,
    material: leg.material,
    lengthMm: leg.lengthMm,
    direction: leg.direction,
  }));
  const joints: PipeDesignJoint[] = skeleton.joints.map((joint, index) => ({
    id: seedJointId(element.id, index),
    nodeId: nodes[joint.index]!.id,
    construction,
    constructionSource: 'element-policy',
    // No part number is recorded anywhere on the element. Inferring one from a
    // matching angle would be fabricating a bill-of-materials entry.
    catalogueId: null,
    includedAngleDeg: joint.angleDeg,
    radiusMm: radiusRuleValue(joint.filleted ? joint.radiusMm : 0, defaultBendRadiusMm),
    planeNormal: joint.planeNormal,
  }));

  const unresolved = [...lifted.unresolved];
  for (const port of [ports.start, ports.end]) {
    if (port.unresolvedReason) unresolved.push(`${port.endpoint}: ${port.unresolvedReason}`);
  }

  return {
    version: PIPE_DESIGN_VERSION,
    provenance: lifted.migrated ? 'migrated' : skeleton.decimated ? 'reconstructed' : 'reconstructed',
    nodes, legs, joints, ports, unresolved,
  };
}

// --- persisted form ---------------------------------------------------------

function readPersistedDesign(element: HvacElement, scene: readonly HvacElement[]): PipeDesign | null {
  const raw = element.properties[PIPE_DESIGN_PROPERTY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const design = raw as Record<string, unknown>;
  if (design.version !== PIPE_DESIGN_VERSION) return null;

  const rawNodes = Array.isArray(design.nodes) ? design.nodes : [];
  const nodes: PipeDesignNode[] = [];
  for (const candidate of rawNodes) {
    const node = candidate as Record<string, unknown> | null;
    if (!node || typeof node.id !== 'string'
      || !isFiniteNumber(node.x) || !isFiniteNumber(node.y) || !isFiniteNumber(node.z)) return null;
    nodes.push({ id: node.id, x: node.x, y: node.y, z: node.z });
  }
  if (nodes.length < 2) return null;

  const byId = new Map(nodes.map(node => [node.id, node]));
  const rawLegs = Array.isArray(design.legs) ? design.legs : [];
  if (rawLegs.length !== nodes.length - 1) return null;
  const legs: PipeDesignLeg[] = [];
  for (const candidate of rawLegs) {
    const leg = candidate as Record<string, unknown> | null;
    if (!leg || typeof leg.id !== 'string'
      || typeof leg.fromNodeId !== 'string' || typeof leg.toNodeId !== 'string') return null;
    const from = byId.get(leg.fromNodeId);
    const to = byId.get(leg.toNodeId);
    if (!from || !to) return null;
    // Derived values are always recomputed; a stale stored length must never
    // be able to disagree with the geometry it claims to describe.
    legs.push({
      id: leg.id, fromNodeId: leg.fromNodeId, toNodeId: leg.toNodeId,
      material: leg.material === 'hard' ? 'hard' : 'flexible',
      lengthMm: distance(from, to),
      direction: normalizeVec3(subtract(to, from)) ?? { x: 1, y: 0, z: 0 },
    });
  }

  const rawJoints = Array.isArray(design.joints) ? design.joints : [];
  const joints: PipeDesignJoint[] = [];
  for (const candidate of rawJoints) {
    const joint = candidate as Record<string, unknown> | null;
    if (!joint || typeof joint.id !== 'string' || typeof joint.nodeId !== 'string') return null;
    const index = nodes.findIndex(node => node.id === joint.nodeId);
    if (index <= 0 || index >= nodes.length - 1) return null;
    const incoming = normalizeVec3(subtract(nodes[index]!, nodes[index - 1]!));
    const outgoing = normalizeVec3(subtract(nodes[index + 1]!, nodes[index]!));
    const storedNormal = joint.planeNormal as Vec3 | undefined;
    const radius = joint.radiusMm as RuleValue<number> | undefined;
    joints.push({
      id: joint.id,
      nodeId: joint.nodeId,
      construction: joint.construction === 'socket-elbow' ? 'socket-elbow' : 'formed-bend',
      constructionSource: 'persisted',
      catalogueId: typeof joint.catalogueId === 'string' ? joint.catalogueId : null,
      includedAngleDeg: incoming && outgoing ? turnDegrees(incoming, outgoing) : 0,
      radiusMm: radius && isFiniteNumber(radius.value) ? radius
        : { value: 0, source: 'fallback', verified: false, note: 'No radius recorded.' },
      planeNormal: (storedNormal && normalizeVec3(storedNormal))
        ?? (incoming && outgoing ? planeNormalFor(incoming, outgoing) : { x: 0, y: 0, z: 1 }),
      ...(typeof joint.lock === 'string'
        ? { lock: joint.lock as PipeDesignJoint['lock'] } : {}),
    });
  }

  const axisFor = (endpoint: 'start' | 'end'): Vec3 | null => {
    const ports = design.ports as Record<string, unknown> | undefined;
    const port = ports?.[endpoint] as Record<string, unknown> | undefined;
    const axis = port?.axis as Vec3 | undefined;
    return axis && isFiniteNumber(axis.x) && isFiniteNumber(axis.y) && isFiniteNumber(axis.z)
      ? axis : null;
  };

  return {
    version: PIPE_DESIGN_VERSION,
    provenance: 'authored',
    nodes, legs, joints,
    ports: {
      start: derivePipePortFrame(element, 'start', scene, axisFor('start')),
      end: derivePipePortFrame(element, 'end', scene, axisFor('end')),
    },
    unresolved: Array.isArray(design.unresolved)
      ? design.unresolved.filter((entry): entry is string => typeof entry === 'string') : [],
  };
}

/**
 * The design for a pipe — persisted when one exists, reconstructed otherwise.
 *
 * Always returns a design. A pipe too degenerate to describe comes back with an
 * empty topology and a populated `unresolved`, never as a silent success.
 */
export function readPipeDesign(element: HvacElement, scene: readonly HvacElement[] = []): PipeDesign {
  return readPersistedDesign(element, scene) ?? reconstructPipeDesign(element, scene);
}

/** True when this element already carries a persisted design. */
export function hasPersistedPipeDesign(element: HvacElement): boolean {
  const raw = element.properties[PIPE_DESIGN_PROPERTY];
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw)
    && (raw as Record<string, unknown>).version === PIPE_DESIGN_VERSION);
}

/** The storage shape: identities and authored choices, never derived values. */
function toPersistedDesign(design: PipeDesign): Record<string, unknown> {
  return {
    version: PIPE_DESIGN_VERSION,
    nodes: design.nodes.map(node => ({ id: node.id, x: node.x, y: node.y, z: node.z })),
    legs: design.legs.map(leg => ({
      id: leg.id, fromNodeId: leg.fromNodeId, toNodeId: leg.toNodeId, material: leg.material,
    })),
    joints: design.joints.map(joint => ({
      id: joint.id, nodeId: joint.nodeId,
      construction: joint.construction,
      catalogueId: joint.catalogueId,
      radiusMm: joint.radiusMm,
      planeNormal: joint.planeNormal,
      ...(joint.lock ? { lock: joint.lock } : {}),
    })),
    ports: {
      start: design.ports.start.axis ? { axis: design.ports.start.axis } : null,
      end: design.ports.end.axis ? { axis: design.ports.end.axis } : null,
    },
    unresolved: design.unresolved,
  };
}

/** Recompute the derived fields so nothing stored can contradict the nodes. */
export function refreshPipeDesign(design: PipeDesign): PipeDesign {
  const byId = new Map(design.nodes.map(node => [node.id, node]));
  const legs = design.legs.map(leg => {
    const from = byId.get(leg.fromNodeId);
    const to = byId.get(leg.toNodeId);
    if (!from || !to) return leg;
    return {
      ...leg,
      lengthMm: distance(from, to),
      direction: normalizeVec3(subtract(to, from)) ?? leg.direction,
    };
  });
  const indexOf = new Map(design.nodes.map((node, index) => [node.id, index]));
  const joints = design.joints.map(joint => {
    const index = indexOf.get(joint.nodeId);
    if (index === undefined || index <= 0 || index >= design.nodes.length - 1) return joint;
    const incoming = normalizeVec3(subtract(design.nodes[index]!, design.nodes[index - 1]!));
    const outgoing = normalizeVec3(subtract(design.nodes[index + 1]!, design.nodes[index]!));
    if (!incoming || !outgoing) return joint;
    return {
      ...joint,
      includedAngleDeg: turnDegrees(incoming, outgoing),
      planeNormal: planeNormalFor(incoming, outgoing),
    };
  });
  return { ...design, legs, joints };
}

/**
 * Write a design back onto an element.
 *
 * The design becomes the authority, and every legacy representation is
 * regenerated from it in the same operation: the plan route, the 3D route, the
 * per-leg materials and the connection records' 2D projections. Callers still
 * need to rebuild visual bounds — that stays with the element writer that owns
 * the visual model.
 */
export function writePipeDesign(element: HvacElement, input: PipeDesign): HvacElement {
  const design = refreshPipeDesign(input);
  const routePoints: Point2D[] = design.nodes.map(node => ({ x: node.x, y: node.y }));
  const routeNodes3d = design.nodes.map(node => ({ x: node.x, y: node.y, z: node.z }));

  const properties: Record<string, unknown> = {
    ...element.properties,
    [PIPE_DESIGN_PROPERTY]: toPersistedDesign(design),
    routePoints,
    routeNodes3d,
    // One material per leg, by construction — this cannot fall out of step with
    // the node count the way an independently-spliced array can.
    segmentMaterials: design.legs.map(leg => leg.material),
    centerline_start: routePoints[0],
    centerline_end: routePoints[routePoints.length - 1],
    networkLevelPlan: undefined,
  };

  // Keep the connection records' legacy projections in sync so every existing
  // consumer of `direction` / `elevationMm` keeps reading the truth.
  for (const port of [design.ports.start, design.ports.end]) {
    const key = element.type === 'refrigerant-pipe-pair'
      ? (port.endpoint === 'start' ? 'startBundleConnection' : 'endBundleConnection')
      : (port.endpoint === 'start' ? 'startConnection' : 'endConnection');
    const existing = pipeConnectionRecord(element, port.endpoint);
    if (!existing) continue;
    const projection = portFrameLegacyProjection(port);
    properties[key] = {
      ...existing,
      ...(projection.direction ? { direction: projection.direction } : {}),
      ...(projection.elevationMm !== undefined ? { elevationMm: projection.elevationMm } : {}),
    };
  }

  return { ...element, properties };
}

/** Node positions as the geometry kernels expect them. */
export function designRouteNodes(design: PipeDesign): PipeRouteNode3D[] {
  return design.nodes.map(node => ({ x: node.x, y: node.y, z: node.z }));
}

/** Replace node positions while preserving every identity. */
export function designWithNodePositions(design: PipeDesign,
  positions: readonly PipeRouteNode3D[]): PipeDesign {
  if (positions.length !== design.nodes.length) return design;
  return refreshPipeDesign({
    ...design,
    nodes: design.nodes.map((node, index) => ({
      id: node.id, x: positions[index]!.x, y: positions[index]!.y, z: positions[index]!.z,
    })),
  });
}

// --- topology ------------------------------------------------------------

/**
 * Mint an identity that cannot collide with one already in the design.
 *
 * Identities are seeded from the element id, so they stay readable; the counter
 * only has to avoid what already exists, which keeps insertion deterministic.
 */
function mintId(existing: ReadonlySet<string>, seed: string, kind: 'n' | 'l' | 'j'): string {
  for (let index = 0; ; index += 1) {
    const candidate = `${seed}:${kind}${index}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function identitySeed(design: PipeDesign): string {
  const first = design.nodes[0]?.id ?? 'pipe';
  const separator = first.lastIndexOf(':');
  return separator > 0 ? first.slice(0, separator) : first;
}

export type PipeTopologyResult = { ok: true; design: PipeDesign } | { ok: false; message: string };

/**
 * Split a leg, producing a new corner.
 *
 * Every surviving identity is carried through: the original leg keeps its id for
 * the first half, the second half is a new leg, and the new corner gets a new
 * joint. The inserted joint inherits the construction policy of the leg it
 * splits and records no part number, because none has been chosen.
 */
export function insertDesignJoint(design: PipeDesign, legId: string,
  at?: PipeRouteNode3D): PipeTopologyResult {
  const legIndex = design.legs.findIndex(leg => leg.id === legId);
  if (legIndex < 0) return { ok: false, message: 'Select a straight segment to insert a bend into.' };
  const from = design.nodes[legIndex];
  const to = design.nodes[legIndex + 1];
  if (!from || !to) return { ok: false, message: 'That segment no longer exists.' };

  const point = at ?? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 };
  if (distance(from, point) < 1 || distance(point, to) < 1) {
    return { ok: false, message: 'A new bend needs room on both sides of the segment.' };
  }

  const used = new Set([
    ...design.nodes.map(node => node.id),
    ...design.legs.map(leg => leg.id),
    ...design.joints.map(joint => joint.id),
  ]);
  const seed = identitySeed(design);
  const nodeId = mintId(used, seed, 'n');
  used.add(nodeId);
  const legIdNew = mintId(used, seed, 'l');
  used.add(legIdNew);
  const jointId = mintId(used, seed, 'j');

  const leg = design.legs[legIndex]!;
  const nodes = [...design.nodes];
  nodes.splice(legIndex + 1, 0, { id: nodeId, x: point.x, y: point.y, z: point.z });

  const legs = [...design.legs];
  legs.splice(legIndex, 1,
    { ...leg, toNodeId: nodeId },
    { ...leg, id: legIdNew, fromNodeId: nodeId, toNodeId: leg.toNodeId });

  // The construction policy comes from the neighbouring fittings, never from
  // the angle the new corner happens to land on.
  const neighbour = design.joints[0];
  const joints = [...design.joints, {
    id: jointId,
    nodeId,
    construction: neighbour?.construction ?? 'formed-bend',
    constructionSource: 'element-policy' as const,
    catalogueId: null,
    includedAngleDeg: 0,
    radiusMm: neighbour?.radiusMm
      ?? { value: 0, source: 'project-default' as const, verified: false, note: 'No radius recorded.' },
    planeNormal: { x: 0, y: 0, z: 1 },
  }];
  // Joints are kept in route order so index-based consumers stay coherent.
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  joints.sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0));

  return { ok: true, design: refreshPipeDesign({ ...design, nodes, legs, joints }) };
}

/**
 * Remove a corner and rejoin the route.
 *
 * A corner that separates two different materials is a real boundary: deleting
 * it would silently reassign one of them, so it is refused with the reason
 * rather than quietly resolved. The surviving leg keeps the upstream leg's
 * identity, and the obsolete joint and leg are dropped.
 */
export function removeDesignJoint(design: PipeDesign, jointId: string): PipeTopologyResult {
  const joint = design.joints.find(candidate => candidate.id === jointId);
  if (!joint) return { ok: false, message: 'Select a bend to remove.' };
  const nodeIndex = design.nodes.findIndex(node => node.id === joint.nodeId);
  if (nodeIndex <= 0 || nodeIndex >= design.nodes.length - 1) {
    return { ok: false, message: 'Only an intermediate bend can be removed.' };
  }
  if (joint.lock) {
    return { ok: false, message: 'This bend is locked. Unlock it before removing it.' };
  }

  const incoming = design.legs[nodeIndex - 1]!;
  const outgoing = design.legs[nodeIndex]!;
  if (incoming.material !== outgoing.material) {
    return {
      ok: false,
      message: 'This point separates different pipe materials. Match the materials before removing it.',
    };
  }

  const nodes = design.nodes.filter((_, index) => index !== nodeIndex);
  const legs = design.legs.filter(leg => leg.id !== outgoing.id)
    .map(leg => leg.id === incoming.id ? { ...leg, toNodeId: outgoing.toNodeId } : leg);
  const joints = design.joints.filter(candidate => candidate.id !== jointId);

  return { ok: true, design: refreshPipeDesign({ ...design, nodes, legs, joints }) };
}
