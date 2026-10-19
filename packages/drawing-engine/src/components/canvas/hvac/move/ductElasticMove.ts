/**
 * A duct run moved elastically, as a draughtsman stretches it by hand.
 *
 * Every rigid leg keeps its direction and may only change length (never
 * shorter than a minimum, never reversed); a flexible runout bends to wherever
 * its two ends go. What the run is fixed to is met exactly: its start moves as
 * the collar, take-off wall or split outlet it leaves from, its end as the
 * terminal it serves (not at all when that stays). A take-off may also slide
 * along its parent's wall, and a dragged straight moves where it is dragged.
 * Every other vertex moves as little as it can — or, for a run being moved, as
 * close to the drag as it can. So the leg nearest a fixed point that runs the
 * way of the move takes it up: move a unit sideways and the first straight off
 * its collar slides across while the leg after it shortens; drag a trunk and it
 * shifts while the straight to its collar stretches.
 *
 * One small least-squares problem per run. Unknowns: the start vertex's shift
 * and each leg's length change (a flexible leg: its free shift), so every
 * vertex's shift is linear in them. What is fixed is met by an augmented
 * Lagrangian (penalty plus multiplier updates on one factorisation), which
 * stays well posed when fixed points over-determine a short run: inconsistency
 * is then a residual, reported, not a singular matrix. Leg minimums and slide
 * limits are inequalities, enforced by an active set (the most violated is held
 * at its limit and the run solved again).
 */
import { MIN_EDITED_LEG_MM } from '../duct/ductEdits';
import type { DuctPoint3 } from '../duct/ductTypes';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const ZERO3: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });
export const AXES3: readonly Vec3[] = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scaleVec3(a: Vec3, factor: number): Vec3 {
  return { x: a.x * factor, y: a.y * factor, z: a.z * factor };
}

export function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function lengthVec3(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/** The shift of `vertex` along `axis` (a unit vector) is exactly `value`. */
export interface ElasticConstraint {
  vertex: number;
  axis: Vec3;
  value: number;
}

/** The shift of `vertex` along `axis` stays within [min, max]. */
export interface ElasticBound {
  vertex: number;
  axis: Vec3;
  min?: number;
  max?: number;
}

/** A vertex that moves exactly by `shift`. */
export function pinVertex(vertex: number, shift: Vec3): ElasticConstraint[] {
  return [
    { vertex, axis: AXES3[0]!, value: shift.x },
    { vertex, axis: AXES3[1]!, value: shift.y },
    { vertex, axis: AXES3[2]!, value: shift.z },
  ];
}

export interface ElasticLegOption {
  /** A flexible runout: it bends freely. */
  flex?: boolean;
  /** The direction a zero-length leg grows in (a riser just made); others keep the path's. */
  direction?: Vec3;
}

export interface ElasticRunInput {
  path: readonly DuctPoint3[];
  /** Per leg (path.length − 1); absent: every leg rigid. */
  legs?: ReadonlyArray<ElasticLegOption | undefined>;
  constraints?: readonly ElasticConstraint[];
  bounds?: readonly ElasticBound[];
  /** What each vertex would like to move by (the drag for a run being moved); absent: stay. */
  desire?: Vec3 | ((vertex: number) => Vec3);
  /** Vertices pulled harder toward a shift than `desire` holds them (an end that lost its terminal reaching for it). */
  pulls?: ReadonlyArray<{ vertex: number; shift: Vec3; weight: number }>;
  /** The shortest a rigid leg may get (a leg already shorter may not get shorter still). */
  minLegMm?: number;
}

export type ElasticRunResult =
  | {
      ok: true;
      path: DuctPoint3[];
      /** How far each vertex moved. */
      shifts: Vec3[];
      /** Legs held at their minimum length. */
      shortest: number[];
    }
  /** `fixed`: what the run is fixed to cannot all be met with its legs' directions. */
  | { ok: false; reason: 'fixed' };

/** Residual allowed on a fixed point after the solve (mm). */
const FIXED_TOLERANCE_MM = 0.05;
/** Inequalities count as met within this (mm). */
const BOUND_TOLERANCE_MM = 1e-3;
const PENALTY = 1e5;
const TIE_BREAK = 1e-9;
const MAX_MULTIPLIER_ROUNDS = 40;
/** Rigid legs shorter than this keep their length and direction (ties), unless given a direction. */
const DEGENERATE_LEG_MM = 0.5;

type LegModel =
  | { kind: 'rigid'; u: Vec3; length: number; column: number }
  | { kind: 'flex'; column: number }
  | { kind: 'tie' };

interface Factorisation {
  lu: number[][];
  pivots: number[];
}

/** LU factorisation with partial pivoting; null when singular. */
function factorise(matrix: number[][]): Factorisation | null {
  const n = matrix.length;
  const lu = matrix.map((row) => [...row]);
  const pivots = Array.from({ length: n }, (_, index) => index);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(lu[row]![col]!) > Math.abs(lu[pivot]![col]!)) pivot = row;
    if (Math.abs(lu[pivot]![col]!) < 1e-300) return null;
    if (pivot !== col) {
      [lu[pivot], lu[col]] = [lu[col]!, lu[pivot]!];
      [pivots[pivot], pivots[col]] = [pivots[col]!, pivots[pivot]!];
    }
    const p = lu[col]![col]!;
    for (let row = col + 1; row < n; row += 1) {
      const factor = lu[row]![col]! / p;
      lu[row]![col] = factor;
      if (factor === 0) continue;
      for (let k = col + 1; k < n; k += 1) lu[row]![k]! -= factor * lu[col]![k]!;
    }
  }
  return { lu, pivots };
}

function solveFactorised({ lu, pivots }: Factorisation, rhs: readonly number[]): number[] {
  const n = rhs.length;
  const y = pivots.map((index) => rhs[index]!);
  for (let row = 0; row < n; row += 1) for (let k = 0; k < row; k += 1) y[row]! -= lu[row]![k]! * y[k]!;
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = y[row]!;
    for (let k = row + 1; k < n; k += 1) sum -= lu[row]![k]! * x[k]!;
    x[row] = sum / lu[row]![row]!;
  }
  return x;
}

/** A linear row over the unknowns and the value it must take. */
interface HardRow {
  row: number[];
  value: number;
}

/**
 * The run's path after an elastic move, or why it cannot move so. Pure; the
 * input path is not changed.
 */
export function solveElasticRun(input: ElasticRunInput): ElasticRunResult {
  const { path } = input;
  const vertexCount = path.length;
  if (vertexCount < 2) return { ok: false, reason: 'fixed' };
  const minLegMm = input.minLegMm ?? MIN_EDITED_LEG_MM;

  // ---- Unknowns: the start vertex's shift (3), then per leg a length change (rigid) or a free shift (flex). ----
  let columns = 3;
  const legs: LegModel[] = [];
  for (let k = 0; k < vertexCount - 1; k += 1) {
    const option = input.legs?.[k];
    const d = subVec3(path[k + 1]!, path[k]!);
    const length = lengthVec3(d);
    if (option?.flex) {
      legs.push({ kind: 'flex', column: columns });
      columns += 3;
    } else if (length >= DEGENERATE_LEG_MM) {
      legs.push({ kind: 'rigid', u: scaleVec3(d, 1 / length), length, column: columns });
      columns += 1;
    } else if (option?.direction && lengthVec3(option.direction) > 1e-9) {
      legs.push({ kind: 'rigid', u: scaleVec3(option.direction, 1 / lengthVec3(option.direction)), length, column: columns });
      columns += 1;
    } else {
      legs.push({ kind: 'tie' });
    }
  }
  // ---- Each vertex's shift as a 3 × columns map of the unknowns: x_j = A_j z. ----
  const maps: number[][][] = [];
  let current: number[][] = [0, 1, 2].map((axis) => {
    const row = new Array<number>(columns).fill(0);
    row[axis] = 1;
    return row;
  });
  maps.push(current);
  for (const leg of legs) {
    const next = current.map((row) => [...row]);
    if (leg.kind === 'rigid') {
      next[0]![leg.column] = leg.u.x;
      next[1]![leg.column] = leg.u.y;
      next[2]![leg.column] = leg.u.z;
    } else if (leg.kind === 'flex') {
      next[0]![leg.column] = 1;
      next[1]![leg.column + 1] = 1;
      next[2]![leg.column + 2] = 1;
    }
    maps.push(next);
    current = next;
  }
  const along = (vertex: number, axis: Vec3): number[] => {
    const a = maps[vertex]!;
    return a[0]!.map((_, i) => a[0]![i]! * axis.x + a[1]![i]! * axis.y + a[2]![i]! * axis.z);
  };
  const evaluate = (row: readonly number[], z: readonly number[]) => row.reduce((sum, value, i) => sum + value * z[i]!, 0);

  // ---- The soft part: every vertex as close as it can to what it would like. ----
  const desireOf = (vertex: number): Vec3 => {
    const desire = input.desire;
    if (!desire) return ZERO3;
    return typeof desire === 'function' ? desire(vertex) : desire;
  };
  const softNormal = Array.from({ length: columns }, () => new Array<number>(columns).fill(0));
  const softRhs = new Array<number>(columns).fill(0);
  const pull = (vertex: number, target: Vec3, weight: number) => {
    const t = [target.x, target.y, target.z];
    const a = maps[vertex]!;
    for (let axis = 0; axis < 3; axis += 1) {
      const row = a[axis]!;
      for (let i = 0; i < columns; i += 1) {
        if (row[i] === 0) continue;
        softRhs[i]! += weight * row[i]! * t[axis]!;
        for (let j = 0; j < columns; j += 1) if (row[j] !== 0) softNormal[i]![j]! += weight * row[i]! * row[j]!;
      }
    }
  };
  for (let vertex = 0; vertex < vertexCount; vertex += 1) pull(vertex, desireOf(vertex), 1);
  for (const extra of input.pulls ?? []) {
    if (extra.vertex >= 0 && extra.vertex < vertexCount && extra.weight > 0) pull(extra.vertex, extra.shift, extra.weight);
  }
  for (let i = 0; i < columns; i += 1) softNormal[i]![i]! += TIE_BREAK;

  const fixedRows: HardRow[] = (input.constraints ?? [])
    .filter((constraint) => constraint.vertex >= 0 && constraint.vertex < vertexCount)
    .map((constraint) => ({ row: along(constraint.vertex, constraint.axis), value: constraint.value }));

  /** Least squares with `rows` met exactly (augmented Lagrangian on one factorisation); null when they cannot be. */
  const solveWith = (rows: readonly HardRow[]): number[] | null => {
    const normal = softNormal.map((row) => [...row]);
    for (const { row } of rows) {
      for (let i = 0; i < columns; i += 1) {
        if (row[i] === 0) continue;
        for (let j = 0; j < columns; j += 1) if (row[j] !== 0) normal[i]![j]! += PENALTY * row[i]! * row[j]!;
      }
    }
    const factors = factorise(normal);
    if (!factors) return null;
    const targets = rows.map((entry) => entry.value);
    let z: number[] = [];
    for (let round = 0; round < MAX_MULTIPLIER_ROUNDS; round += 1) {
      const rhs = [...softRhs];
      rows.forEach(({ row }, index) => {
        for (let i = 0; i < columns; i += 1) if (row[i] !== 0) rhs[i]! += PENALTY * row[i]! * targets[index]!;
      });
      z = solveFactorised(factors, rhs);
      let worst = 0;
      rows.forEach(({ row, value }, index) => {
        const residual = evaluate(row, z) - value;
        worst = Math.max(worst, Math.abs(residual));
        targets[index]! -= residual;
      });
      if (worst <= 1e-7) return z;
    }
    const worst = rows.reduce((max, { row, value }) => Math.max(max, Math.abs(evaluate(row, z) - value)), 0);
    return worst <= FIXED_TOLERANCE_MM ? z : null;
  };

  // ---- Inequalities: legs never shorter than their minimum, slides within their limits (active set). ----
  type Limit = { row: number[]; min: number; max: number; leg?: number };
  const limits: Limit[] = [];
  legs.forEach((leg, index) => {
    if (leg.kind !== 'rigid') return;
    const row = new Array<number>(columns).fill(0);
    row[leg.column] = 1;
    limits.push({ row, min: Math.min(minLegMm, leg.length) - leg.length, max: Number.POSITIVE_INFINITY, leg: index });
  });
  for (const bound of input.bounds ?? []) {
    if (bound.vertex < 0 || bound.vertex >= vertexCount) continue;
    limits.push({ row: along(bound.vertex, bound.axis), min: bound.min ?? Number.NEGATIVE_INFINITY, max: bound.max ?? Number.POSITIVE_INFINITY });
  }
  const held: HardRow[] = [];
  const heldLimits = new Set<Limit>();
  let z: number[] | null = null;
  for (let round = 0; round <= limits.length; round += 1) {
    z = solveWith([...fixedRows, ...held]);
    if (!z) return { ok: false, reason: 'fixed' };
    let worst: { limit: Limit; value: number; excess: number } | null = null;
    for (const limit of limits) {
      if (heldLimits.has(limit)) continue;
      const value = evaluate(limit.row, z);
      const excess = Math.max(limit.min - value, value - limit.max);
      if (excess > BOUND_TOLERANCE_MM && (!worst || excess > worst.excess)) worst = { limit, value, excess };
    }
    if (!worst) break;
    heldLimits.add(worst.limit);
    held.push({ row: worst.limit.row, value: worst.value < worst.limit.min ? worst.limit.min : worst.limit.max });
  }
  if (!z) return { ok: false, reason: 'fixed' };
  const solution = z;

  // ---- The path, rebuilt leg by leg so every rigid leg keeps its direction exactly. ----
  const shiftAt = (vertex: number): Vec3 => {
    const a = maps[vertex]!;
    return { x: evaluate(a[0]!, solution), y: evaluate(a[1]!, solution), z: evaluate(a[2]!, solution) };
  };
  const exact: DuctPoint3[] = [addVec3(path[0]!, shiftAt(0))];
  legs.forEach((leg, k) => {
    const from = exact[k]!;
    if (leg.kind === 'rigid') {
      exact.push(addVec3(from, scaleVec3(leg.u, leg.length + solution[leg.column]!)));
    } else if (leg.kind === 'tie') {
      exact.push(addVec3(from, subVec3(path[k + 1]!, path[k]!)));
    } else {
      exact.push(addVec3(path[k + 1]!, shiftAt(k + 1)));
    }
  });
  const out = exact.map((point, index) => ({ ...path[index]!, x: round2(point.x), y: round2(point.y), z: round2(point.z) }));
  return {
    ok: true,
    path: out,
    shifts: out.map((point, index) => subVec3(point, path[index]!)),
    shortest: [...heldLimits].flatMap((limit) => (limit.leg !== undefined ? [limit.leg] : [])),
  };
}

function round2(value: number): number {
  // (No −0: a vertex that did not move keeps its coordinate exactly.)
  return Math.round(value * 100) / 100 || 0;
}
