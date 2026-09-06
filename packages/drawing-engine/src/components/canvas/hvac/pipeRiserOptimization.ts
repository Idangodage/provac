import type { PipeRouteNode3D as Node } from './pipeRoute3d';

const POSITION_EPS = 1e-5;
const DIRECTION_EPS = 1e-7;
const MAX_ARC_CHORDS = 128;
const MAX_ALTERNATIVES = 32;

const subtract = (a: Node, b: Node): Node => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const addScaled = (a: Node, b: Node, amount: number): Node => ({
  x: a.x + b.x * amount, y: a.y + b.y * amount, z: a.z + b.z * amount,
});
const dot = (a: Node, b: Node): number => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: Node): number => Math.hypot(a.x, a.y, a.z);
const distance = (a: Node, b: Node): number => length(subtract(a, b));
const finite = (node: Node): boolean => [node.x, node.y, node.z].every(Number.isFinite);
function direction(a: Node, b: Node): Node | null {
  const delta = subtract(b, a);
  const size = length(delta);
  return size > POSITION_EPS ? { x: delta.x / size, y: delta.y / size, z: delta.z / size } : null;
}
const sameDirection = (a: Node, b: Node): boolean => distance(a, b) <= DIRECTION_EPS;
const horizontal = (a: Node): boolean => Math.abs(a.z) <= DIRECTION_EPS;
const vertical = (a: Node): boolean => Math.hypot(a.x, a.y) <= DIRECTION_EPS;

/** Removes only duplicate and same-direction collinear vertices, never a turn. */
function simplify(nodes: readonly Node[]): Node[] {
  const result: Node[] = [];
  for (const node of nodes) {
    if (result.length && distance(result.at(-1)!, node) <= POSITION_EPS) continue;
    result.push({ ...node });
    while (result.length >= 3) {
      const incoming = direction(result.at(-3)!, result.at(-2)!);
      const outgoing = direction(result.at(-2)!, result.at(-1)!);
      if (!incoming || !outgoing || !sameDirection(incoming, outgoing)) break;
      result.splice(result.length - 2, 1);
    }
  }
  return result;
}

/**
 * Recover sharp tangent intersections only for demonstrably circular 90° arcs
 * with straight leads. This admits saved socket-elbow centerlines in XY, XZ,
 * YZ and rotated planes; custom gathers and diagonal adapters remain intact.
 * The bounded chord window keeps recognition linear in the number of points.
 */
export interface RecoveredQuarterTurn3D {
  corner: Node;
  incoming: Node;
  outgoing: Node;
  samples: readonly Node[];
}

export function recoverQuarterTurnGeometry3D(nodes: readonly Node[]): { nodes: Node[]; arcs: RecoveredQuarterTurn3D[] } {
  if (!nodes.every(finite)) return { nodes: nodes.map(node => ({ ...node })), arcs: [] };
  const result: Node[] = [];
  const arcs: RecoveredQuarterTurn3D[] = [];
  for (let startIndex = 0; startIndex < nodes.length; startIndex += 1) {
    const start = nodes[startIndex]!;
    const incoming = startIndex > 0 ? direction(nodes[startIndex - 1]!, start) : null;
    let match: { corner: Node; endIndex: number; incoming: Node; outgoing: Node } | undefined;
    if (incoming) {
      const maxEnd = Math.min(nodes.length - 2, startIndex + MAX_ARC_CHORDS);
      for (let endIndex = startIndex + 3; endIndex <= maxEnd; endIndex += 1) {
        const end = nodes[endIndex]!;
        const outgoing = direction(end, nodes[endIndex + 1]!);
        if (!outgoing || Math.abs(dot(incoming, outgoing)) > DIRECTION_EPS) continue;
        const chord = subtract(end, start);
        const radius = dot(chord, incoming);
        const tolerance = Math.max(POSITION_EPS, radius * 1e-6);
        if (radius <= POSITION_EPS || Math.abs(radius - dot(chord, outgoing)) > tolerance) continue;
        const corner = addScaled(start, incoming, radius);
        if (distance(corner, addScaled(end, outgoing, -radius)) > tolerance) continue;
        const center = addScaled(start, outgoing, radius);
        let angleBefore = 0;
        let circular = true;
        for (let index = startIndex + 1; index < endIndex; index += 1) {
          const radial = subtract(nodes[index]!, center);
          const sine = dot(radial, incoming) / radius;
          const cosine = -dot(radial, outgoing) / radius;
          const angle = Math.atan2(sine, cosine);
          const inPlane = addScaled(addScaled(center, incoming, radius * sine), outgoing, -radius * cosine);
          if (Math.abs(length(radial) - radius) > tolerance
            || distance(inPlane, nodes[index]!) > tolerance
            || angle <= angleBefore + DIRECTION_EPS || angle >= Math.PI / 2 - DIRECTION_EPS) {
            circular = false;
            break;
          }
          angleBefore = angle;
        }
        if (circular) { match = { corner, endIndex, incoming, outgoing }; break; }
      }
    }
    result.push(match?.corner ?? { ...start });
    if (match) {
      arcs.push({ corner: match.corner, incoming: match.incoming, outgoing: match.outgoing,
        samples: nodes.slice(startIndex, match.endIndex + 1) });
      startIndex = match.endIndex;
    }
  }
  return { nodes: simplify(result), arcs };
}

export function recoverQuarterTurnCorners3D(nodes: readonly Node[]): Node[] {
  return recoverQuarterTurnGeometry3D(nodes).nodes;
}

/** Keep original verified radii on every circular fitting a proposal did not move. */
export function restoreUnchangedQuarterTurns3D(nodes: readonly Node[], arcs: readonly RecoveredQuarterTurn3D[]): Node[] {
  const key = (node: Node) => `${node.x},${node.y},${node.z}`;
  const byCorner = new Map(arcs.map(arc => [key(arc.corner), arc]));
  return nodes.flatMap((node, index) => {
    const arc = byCorner.get(key(node));
    const incoming = index > 0 ? direction(nodes[index - 1]!, node) : null;
    const outgoing = index + 1 < nodes.length ? direction(node, nodes[index + 1]!) : null;
    return arc && incoming && outgoing && sameDirection(incoming, arc.incoming) && sameDirection(outgoing, arc.outgoing)
      ? arc.samples.map(point => ({ ...point })) : [{ ...node }];
  });
}

export interface RiserTurnOptimizationOptions {
  /** Corner-to-socket-face takeoff, including the full selected 90° fitting. */
  bendTakeoffMm: number;
  startStraightMm?: number;
  endStraightMm?: number;
  /** Clear tube length required between adjacent fitting socket faces. */
  minimumFittingStraightMm?: number;
  /** Includes the candidate combining compatible improvements. Capped at 32. */
  maxAlternatives?: number;
  /** Enumerate every independent move, still linear, for final scene checks. */
  includeAllAlternatives?: boolean;
}

export interface RiserTurnRelocation {
  /** Index immediately before this move; combined relocations apply in order. */
  sourceStartIndex: number;
  oldStart: Node;
  oldEnd: Node;
  newStart: Node;
  newEnd: Node;
  /** The removed intermediate leg is absorbed by the adjoining straight. */
  removedStraightMm: number;
}

export interface RiserTurnAlternative {
  nodes: Node[];
  elbowsRemoved: number;
  relocations: RiserTurnRelocation[];
  originalLengthMm: number;
  lengthMm: number;
}

interface Change {
  start: number;
  replacement: [Node, Node];
  relocation: RiserTurnRelocation;
}

const routeLength = (nodes: readonly Node[]): number => nodes.slice(1)
  .reduce((sum, node, index) => sum + distance(nodes[index]!, node), 0);

function findChange(
  nodes: readonly Node[], start: number, options: RiserTurnOptimizationOptions, endsAtTerminal = true,
): Change | null {
  const [a, b, c, d, e] = nodes.slice(start, start + 5) as [Node, Node, Node, Node, Node];
  const first = direction(a, b); const second = direction(b, c);
  const third = direction(c, d); const fourth = direction(d, e);
  if (!first || !second || !third || !fourth) return null;
  let replacement: [Node, Node];
  let oldStart: Node; let oldEnd: Node; let removedStraightMm: number;
  if (horizontal(first) && vertical(second) && horizontal(third) && horizontal(fourth)
    && sameDirection(first, third) && Math.abs(dot(third, fourth)) <= DIRECTION_EPS) {
    // A → Z → A → B: continue A to the existing plan corner, then rise and turn B.
    replacement = [{ x: d.x, y: d.y, z: b.z }, { ...d }];
    oldStart = b; oldEnd = c; removedStraightMm = distance(c, d);
  } else if (horizontal(first) && horizontal(second) && vertical(third) && horizontal(fourth)
    && sameDirection(second, fourth) && Math.abs(dot(first, second)) <= DIRECTION_EPS) {
    // The reverse traversal, B → A → Z → A, relocates onto the preceding corner.
    replacement = [{ ...b }, { x: b.x, y: b.y, z: d.z }];
    oldStart = c; oldEnd = d; removedStraightMm = distance(b, c);
  } else return null;

  const takeoff = options.bendTakeoffMm;
  const fittingStraight = Math.max(0, options.minimumFittingStraightMm ?? 0);
  const incomingRequired = takeoff + (start === 0 ? Math.max(0, options.startStraightMm ?? 0) : takeoff + fittingStraight);
  const outgoingRequired = takeoff + (endsAtTerminal && start + 4 === nodes.length - 1
    ? Math.max(0, options.endStraightMm ?? 0) : takeoff + fittingStraight);
  if (distance(a, replacement[0]) + POSITION_EPS < incomingRequired
    || distance(replacement[0], replacement[1]) + POSITION_EPS < 2 * takeoff + fittingStraight
    || distance(replacement[1], e) + POSITION_EPS < outgoingRequired) return null;
  return {
    start, replacement,
    relocation: { sourceStartIndex: start, oldStart: { ...oldStart }, oldEnd: { ...oldEnd },
      newStart: { ...replacement[0] }, newEnd: { ...replacement[1] }, removedStraightMm },
  };
}

/**
 * Generate geometric alternatives that move a free riser onto its neighbouring
 * horizontal corner. Three 90° elbows become two in perpendicular vertical
 * planes. Endpoints, terminal directions, elevations, vertical travel and sharp
 * route length are preserved. Patterns can appear anywhere along a route.
 *
 * The caller owns equipment locks, collision checks and economic evaluation;
 * these are proposals, never silently accepted route changes. Inputs must be
 * sharp centerlines (use recoverQuarterTurnCorners3D for sampled fittings).
 * Fixed candidate/chord bounds avoid combinatorial route enumeration.
 */
export function generateRiserTurnAlternatives(
  input: readonly Node[], options: RiserTurnOptimizationOptions,
): RiserTurnAlternative[] {
  if (input.length < 5 || !input.every(finite)
    || !Number.isFinite(options.bendTakeoffMm) || options.bendTakeoffMm <= 0
    || [options.startStraightMm, options.endStraightMm, options.minimumFittingStraightMm, options.maxAlternatives]
      .some(value => value !== undefined && !Number.isFinite(value))) return [];
  const nodes = simplify(input);
  const cap = options.includeAllAlternatives ? Infinity
    : Math.max(1, Math.min(MAX_ALTERNATIVES, Math.floor(options.maxAlternatives ?? 16)));
  const individual: Change[] = [];
  for (let start = 0; start + 4 < nodes.length; start += 1) {
    const change = findChange(nodes, start, options);
    if (!change) continue;
    if (individual.length < cap) individual.push(change);
  }
  if (!individual.length) return [];
  const originalLengthMm = routeLength(nodes);
  // Stack rewriting considers the updated adjoining legs after every move.
  // A removed vertex is never scanned again, so chains of risers also finish
  // in linear time without suppressing improvements that share a boundary.
  const combinedNodes: Node[] = [];
  const combinedRelocations: RiserTurnRelocation[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    combinedNodes.push(nodes[index]!);
    while (combinedNodes.length >= 5) {
      const change = findChange(combinedNodes, combinedNodes.length - 5, options, index === nodes.length - 1);
      if (!change) break;
      combinedNodes.splice(combinedNodes.length - 4, 3, ...change.replacement);
      combinedRelocations.push(change.relocation);
    }
  }
  const alternatives: RiserTurnAlternative[] = [];
  if (combinedRelocations.length > 1) alternatives.push({
    nodes: combinedNodes.map(node => ({ ...node })), elbowsRemoved: combinedRelocations.length,
    relocations: combinedRelocations, originalLengthMm, lengthMm: routeLength(combinedNodes),
  });
  for (const change of individual) {
    if (alternatives.length >= cap) break;
    const candidate = [...nodes.slice(0, change.start + 1), ...change.replacement, ...nodes.slice(change.start + 4)]
      .map(node => ({ ...node }));
    alternatives.push({ nodes: candidate, elbowsRemoved: 1, relocations: [change.relocation],
      originalLengthMm, lengthMm: routeLength(candidate) });
  }
  return alternatives;
}
