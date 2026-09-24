/**
 * Exact fall-profile solver for a gravity drainage tree.
 *
 * Every node carries a centreline elevation z. Each node (except the root)
 * drains into exactly one downstream node, and the edge imposes
 *
 *     z(node) − z(down) ≥ w(node)                  (a difference constraint)
 *
 * where w is the required fall: slope × plan length for a sloped run, a fixed
 * drop for a branch entering the crown of a main, or a NEGATIVE value for a
 * pump lift riser (the discharge may rise by at most the pump head).
 * Nodes also carry bounds L ≤ z ≤ U (void envelope, drain port level, the
 * "below"/"above" windows at refrigerant crossings, the termination level).
 *
 * On a tree this system is solved exactly in linear time:
 *  - greatest solution z* (leaves → root): z*(n) = min(U(n), min_c z*(c) − w(c))
 *  - least solution  z_low (root → leaves): z_low(c) = max(L(c), z_low(down) + w(c))
 *  - feasible  ⇔  z*(n) ≥ L(n) for every node (any solution is ≤ z* pointwise)
 *  - slack z* − z_low is the head margin at each node.
 * When infeasible, the worst deficit L − z* is the exact fall shortfall, and
 * following the binding child from that node leads to the constraint that
 * caused it (a drain port, a crossing window, …).
 */

export interface ProfileNode {
  id: string;
  /** Downstream node id; null for the root (the termination). */
  down: string | null;
  /** Required fall from this node to `down` (mm, may be negative for a lift). */
  w: number;
  upper: number;
  lower: number;
  /** Why the upper bound exists — reported when it becomes the binding constraint. */
  upperReason?: string;
  lowerReason?: string;
}

export interface ProfileDiagnosis {
  nodeId: string;
  shortfallMm: number;
  /** The node whose upper bound (port level, crossing window…) limited the profile. */
  bindingNodeId: string;
  bindingReason: string | null;
  lowerReason: string | null;
}

export interface ProfileSolution {
  feasible: boolean;
  zHigh: Map<string, number>;
  zLow: Map<string, number>;
  diagnosis: ProfileDiagnosis | null;
}

const EPS = 1e-6;

interface TreeIndex {
  order: string[];
  children: Map<string, string[]>;
  byId: Map<string, ProfileNode>;
  roots: string[];
}

function indexTree(nodes: readonly ProfileNode[]): TreeIndex {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of nodes) {
    if (node.down === null || !byId.has(node.down)) {
      roots.push(node.id);
      continue;
    }
    const list = children.get(node.down);
    if (list) list.push(node.id);
    else children.set(node.down, [node.id]);
  }
  // Breadth-first from each root: parents before children. A malformed input
  // with a cycle leaves nodes unreached; they are simply not solved.
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [...roots].sort();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const child of [...(children.get(id) ?? [])].sort()) queue.push(child);
  }
  return { order, children, byId, roots };
}

export function solveProfile(nodes: readonly ProfileNode[]): ProfileSolution {
  const { order, children, byId } = indexTree(nodes);
  const zHigh = new Map<string, number>();
  const bindingChild = new Map<string, string | null>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index]!;
    const node = byId.get(id)!;
    let value = node.upper;
    let binding: string | null = null;
    for (const childId of children.get(id) ?? []) {
      const child = byId.get(childId)!;
      const candidate = (zHigh.get(childId) ?? Number.POSITIVE_INFINITY) - child.w;
      if (candidate < value - EPS) {
        value = candidate;
        binding = childId;
      }
    }
    zHigh.set(id, value);
    bindingChild.set(id, binding);
  }
  const zLow = new Map<string, number>();
  for (const id of order) {
    const node = byId.get(id)!;
    const down = node.down !== null ? zLow.get(node.down) : undefined;
    zLow.set(id, Math.max(node.lower, down === undefined ? Number.NEGATIVE_INFINITY : down + node.w));
  }
  let worst: { id: string; deficit: number } | null = null;
  for (const id of order) {
    const node = byId.get(id)!;
    const deficit = node.lower - zHigh.get(id)!;
    if (deficit > EPS && (!worst || deficit > worst.deficit + EPS)) worst = { id, deficit };
  }
  let diagnosis: ProfileDiagnosis | null = null;
  if (worst) {
    let cursor = worst.id;
    const guard = new Set<string>();
    while (bindingChild.get(cursor) && !guard.has(cursor)) {
      guard.add(cursor);
      cursor = bindingChild.get(cursor)!;
    }
    diagnosis = {
      nodeId: worst.id,
      shortfallMm: worst.deficit,
      bindingNodeId: cursor,
      bindingReason: byId.get(cursor)?.upperReason ?? null,
      lowerReason: byId.get(worst.id)?.lowerReason ?? null,
    };
  }
  return { feasible: worst === null, zHigh, zLow, diagnosis };
}

/**
 * Largest uniform slope in [min, max] for which `build(slope)` is feasible.
 * Feasibility only gets harder as the slope rises (every sloped edge demands
 * more fall), so bisection is exact to the tolerance. Returns null when even
 * the minimum slope is infeasible.
 */
export function maxFeasibleSlope(
  build: (slopePercent: number) => ProfileNode[],
  minSlopePercent: number,
  maxSlopePercent: number,
  tolerancePercent = 0.01,
): { slopePercent: number; solution: ProfileSolution } | null {
  const atMin = solveProfile(build(minSlopePercent));
  if (!atMin.feasible) return null;
  const atMax = solveProfile(build(maxSlopePercent));
  if (atMax.feasible) return { slopePercent: maxSlopePercent, solution: atMax };
  let lo = minSlopePercent;
  let hi = maxSlopePercent;
  let best = { slopePercent: lo, solution: atMin };
  for (let iteration = 0; iteration < 24 && hi - lo > tolerancePercent; iteration += 1) {
    const mid = (lo + hi) / 2;
    const solution = solveProfile(build(mid));
    if (solution.feasible) {
      lo = mid;
      best = { slopePercent: mid, solution };
    } else {
      hi = mid;
    }
  }
  return best;
}
