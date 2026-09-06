import { resolveCopperSocketElbow, type CopperSocketElbowSpec } from './copperSocketElbows';
import type { PipeRouteNode3D as Node } from './pipeRoute3d';

export interface CopperSocketElbowPlacement {
  id: string;
  spec: CopperSocketElbowSpec;
  corner: Node;
  center: Node;
  entry: Node;
  exit: Node;
  startDirection: Node;
  endDirection: Node;
  normal: Node;
  startFace: Node;
  endFace: Node;
  startStop: Node;
  endStop: Node;
  path: Node[];
}

export interface CompiledCopperSocketElbowRoute {
  centerline: Node[];
  pipeRuns: Node[][];
  insulationRuns: Node[][];
  fittings: CopperSocketElbowPlacement[];
  issues: Array<{ reason: string; point: Node }>;
}

const EPS = 1e-5;
const add = (a: Node, b: Node): Node => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Node, b: Node): Node => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: Node, s: number): Node => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: Node, b: Node) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Node, b: Node): Node => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (a: Node) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Node) => scale(a, 1 / Math.max(length(a), EPS));
const distance = (a: Node, b: Node) => length(sub(a, b));
const finite = (p: Node) => [p.x, p.y, p.z].every(Number.isFinite);
const sameDirection = (a: Node, b: Node) => dot(a, b) > 1 - 1e-7;
const angleOf = (a: Node, b: Node) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
const standardAngle = (angle: number): 45 | 90 | null => Math.abs(angle - Math.PI / 2) < 1e-5 ? 90
  : Math.abs(angle - Math.PI / 4) < 1e-5 ? 45 : null;

interface Line {
  kind: 'line'; points: Node[]; startDirection: Node; endDirection: Node;
}
interface Arc {
  kind: 'arc'; points: Node[]; center: Node; normal: Node; radius: number;
  angle: number; startDirection: Node; endDirection: Node;
}
type Primitive = Line | Arc;
interface Candidate {
  before: number; after: number; arcIndex?: number;
  corner: Node; incoming: Node; outgoing: Node; angle: 45 | 90;
  placement?: CopperSocketElbowPlacement;
}

/** Recover maximal co-circular runs in any 3D plane. Four or more samples
 * distinguish an authored arc from an ordinary three-point corner. */
function sampledArc(points: Node[], start: number): { arc: Arc; end: number } | null {
  if (start + 3 >= points.length) return null;
  const a = points[start]!; const b = points[start + 1]!; const c = points[start + 2]!;
  const ab = sub(b, a); const ac = sub(c, a); const n = cross(ab, ac); const n2 = dot(n, n);
  if (n2 < 1e-12) return null;
  const center = add(a, scale(add(scale(cross(ac, n), dot(ab, ab)), scale(cross(n, ab), dot(ac, ac))), 1 / (2 * n2)));
  const radius = distance(center, a); const normal = unit(n);
  if (!Number.isFinite(radius) || radius < EPS) return null;
  const tolerance = Math.max(1e-5, radius * 1e-6);
  let previous = unit(sub(a, center)); let angle = 0; let end = start;
  for (let index = start + 1; index < points.length; index += 1) {
    const radial = sub(points[index]!, center);
    if (Math.abs(length(radial) - radius) > tolerance || Math.abs(dot(radial, normal)) > tolerance) break;
    const next = unit(radial);
    const turn = Math.atan2(dot(cross(previous, next), normal), dot(previous, next));
    if (turn <= 1e-7 || turn > Math.PI / 12 + 1e-6 || angle + turn > Math.PI + 1e-5) break;
    end = index; angle += turn; previous = next;
  }
  if (end - start < 3) return null;
  return { end, arc: { kind: 'arc', points: points.slice(start, end + 1), center, normal, radius, angle,
    startDirection: unit(cross(normal, sub(a, center))),
    endDirection: unit(cross(normal, sub(points[end]!, center))) } };
}

function primitives(points: Node[]): Primitive[] {
  const result: Primitive[] = [];
  let index = 0;
  while (index < points.length - 1) {
    const recovered = sampledArc(points, index);
    if (recovered) { result.push(recovered.arc); index = recovered.end; continue; }
    const a = points[index]!; const b = points[index + 1]!;
    const direction = unit(sub(b, a)); const previous = result.at(-1);
    if (previous?.kind === 'line' && sameDirection(previous.endDirection, direction)) previous.points.push(b);
    else result.push({ kind: 'line', points: [a, b], startDirection: direction, endDirection: direction });
    index += 1;
  }
  // A resolved unit gather can meet the next field bend exactly at their
  // common tangent. Keep that zero-length straight boundary: a smaller
  // catalogue elbow may free enough tangent length for its real socket face.
  return result.flatMap((part, partIndex): Primitive[] => {
    const next = result[partIndex + 1];
    return part.kind === 'arc' && next?.kind === 'arc'
      && sameDirection(part.endDirection, next.startDirection)
      ? [part, { kind: 'line', points: [part.points.at(-1)!], startDirection: part.endDirection, endDirection: part.endDirection }]
      : [part];
  });
}

function resolveCandidates(parts: Primitive[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [index, part] of parts.entries()) {
    const previous = parts[index - 1]; const next = parts[index + 1];
    if (part.kind === 'arc') {
      const angle = standardAngle(part.angle);
      // Keep arbitrary-angle equipment gathers, broken imports, and arcs
      // without demonstrable tangent straight legs in their authored form.
      if (!angle || previous?.kind !== 'line' || next?.kind !== 'line'
        || !sameDirection(previous.endDirection, part.startDirection)
        || !sameDirection(next.startDirection, part.endDirection)) continue;
      const setback = part.radius * Math.tan(part.angle / 2);
      const corner = add(part.points[0]!, scale(part.startDirection, setback));
      if (distance(corner, sub(part.points.at(-1)!, scale(part.endDirection, setback))) > Math.max(EPS, part.radius * 1e-5)) continue;
      candidates.push({ before: index - 1, after: index + 1, arcIndex: index, corner,
        incoming: part.startDirection, outgoing: part.endDirection, angle });
    } else if (previous?.kind === 'line') {
      const angle = standardAngle(angleOf(previous.endDirection, part.startDirection));
      if (angle) candidates.push({ before: index - 1, after: index, corner: part.points[0]!,
        incoming: previous.endDirection, outgoing: part.startDirection, angle });
    }
  }
  return candidates;
}

function placement(candidate: Candidate, spec: CopperSocketElbowSpec, index: number): CopperSocketElbowPlacement {
  const { corner, incoming, outgoing } = candidate;
  const angle = spec.angleDeg * Math.PI / 180; const radius = spec.centerlineRadiusMm;
  const setback = radius * Math.tan(angle / 2); const normal = unit(cross(incoming, outgoing));
  const entry = sub(corner, scale(incoming, setback));
  const exit = add(corner, scale(outgoing, setback));
  const center = add(entry, scale(cross(normal, incoming), radius));
  const startFace = sub(corner, scale(incoming, spec.centerToFaceMm));
  const endFace = add(corner, scale(outgoing, spec.centerToFaceMm));
  const radial = sub(entry, center); const tangent = cross(normal, radial);
  const steps = Math.max(4, Math.ceil(angle / (Math.PI / 48)));
  const path = [startFace, ...Array.from({ length: steps + 1 }, (_, step) => {
    if (step === 0) return entry;
    if (step === steps) return exit;
    const t = angle * step / steps;
    return add(center, add(scale(radial, Math.cos(t)), scale(tangent, Math.sin(t))));
  }), endFace];
  return { id: `socket-elbow-${index + 1}`, spec, corner, center, entry, exit,
    startDirection: incoming, endDirection: outgoing, normal, startFace, endFace,
    startStop: add(startFace, scale(incoming, spec.insertionDepthMm)),
    endStop: sub(endFace, scale(outgoing, spec.insertionDepthMm)), path: dedupe(path) };
}

function dedupe(points: readonly Node[]): Node[] {
  const result: Node[] = [];
  for (const p of points) {
    const previous = result.at(-1);
    if (!previous) { result.push({ ...p }); continue; }
    const dx = previous.x - p.x; const dy = previous.y - p.y; const dz = previous.z - p.z;
    // A finite component outside the tolerance proves separation. Retain the
    // original hypot test near the boundary and for overflow/nonfinite data.
    const separated = Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz)
      && (Math.abs(dx) > EPS || Math.abs(dy) > EPS || Math.abs(dz) > EPS)
      || Math.hypot(dx, dy, dz) > EPS;
    if (separated) result.push({ ...p });
  }
  return result;
}

function trimLine(line: Line, start: Node, end: Node): Node[] {
  const direction = line.startDirection; const extent = dot(sub(end, start), direction);
  return dedupe([start, ...line.points.filter(point => {
    const station = dot(sub(point, start), direction);
    return station > EPS && station < extent - EPS;
  }), end]);
}

/** Compile actual C×C fitting geometry from the route's tangent corners. The
 * original sockets stay fixed. Unresolved parts retain their existing path;
 * dimensions are never scaled to make a selected fitting appear to fit. */
export function compileCopperSocketElbowRoute(
  input: readonly Node[], tubeOD: number,
  options: { startStraightMm?: number; endStraightMm?: number; minimumBendRadiusMm?: number } = {},
): CompiledCopperSocketElbowRoute {
  const valid = input.every(finite);
  const points = valid ? dedupe(input) : input.map(point => ({ ...point }));
  const result: CompiledCopperSocketElbowRoute = { centerline: points, pipeRuns: points.length >= 2 ? [points] : [],
    insulationRuns: points.length >= 2 ? [points] : [], fittings: [], issues: [] };
  if (!valid) {
    result.issues.push({ reason: 'The route contains a non-finite coordinate.', point: points.find(finite) ?? { x: 0, y: 0, z: 0 } });
    return result;
  }
  if (points.length < 3) return result;
  const parts = primitives(points); const candidates = resolveCandidates(parts);
  for (const [index, candidate] of candidates.entries()) {
    const spec = resolveCopperSocketElbow(tubeOD, candidate.angle);
    if (!spec) {
      result.issues.push({ reason: `No socket elbow is available for ${tubeOD} mm tube at ${candidate.angle} degrees.`, point: candidate.corner });
      continue;
    }
    if (spec.centerlineRadiusMm + EPS < Math.max(0, options.minimumBendRadiusMm ?? 0)) {
      result.issues.push({ reason: 'The available socket elbow is below the required minimum bend radius; the existing route is retained.', point: candidate.corner });
      continue;
    }
    if (![spec.centerToFaceMm, spec.centerlineRadiusMm, spec.insertionDepthMm].every(value => Number.isFinite(value) && value > 0)
      || spec.centerToFaceMm + EPS < spec.centerlineRadiusMm * Math.tan(spec.angleDeg * Math.PI / 360)) {
      result.issues.push({ reason: 'The socket elbow dimensions cannot describe a tangent fitting.', point: candidate.corner });
      continue;
    }
    candidate.placement = placement(candidate, spec, index);
  }
  // Both neighbouring fittings consume the SAME straight. Check them together
  // before changing either service path, including protected terminal stubs.
  const incomingCandidates: Candidate[][] = [];
  const outgoingCandidates: Candidate[][] = [];
  for (const candidate of candidates) {
    (incomingCandidates[candidate.after] ??= []).push(candidate);
    (outgoingCandidates[candidate.before] ??= []).push(candidate);
  }
  for (let pass = 0; pass <= candidates.length; pass += 1) {
    let removed = false;
    for (const [index, part] of parts.entries()) {
      if (part.kind !== 'line') continue;
      // Buckets retain candidate order and live placement references, including
      // removals made earlier in this pass. No route-wide rescan is needed.
      const before = incomingCandidates[index]?.find(candidate => candidate.placement);
      const after = outgoingCandidates[index]?.find(candidate => candidate.placement);
      const start = before?.placement?.endFace ?? part.points[0]!;
      const end = after?.placement?.startFace ?? part.points.at(-1)!;
      const required = (index === 0 ? Math.max(0, options.startStraightMm ?? 0) : 0)
        + (index === parts.length - 1 ? Math.max(0, options.endStraightMm ?? 0) : 0);
      if (dot(sub(end, start), part.startDirection) + EPS >= required) continue;
      for (const candidate of [before, after]) if (candidate?.placement) {
        result.issues.push({ reason: 'The available straight cannot fit the socket faces and protected terminal lengths.', point: candidate.corner });
        delete candidate.placement;
        removed = true;
      }
    }
    if (!removed) break;
  }
  const active = candidates.filter(candidate => candidate.placement);
  if (!active.length) return result;
  const beforeLine = new Map(active.map(candidate => [candidate.after, candidate.placement!]));
  const afterLine = new Map(active.map(candidate => [candidate.before, candidate.placement!]));
  const atArc = new Map(active.filter(candidate => candidate.arcIndex !== undefined).map(candidate => [candidate.arcIndex!, candidate.placement!]));
  const atCorner = new Map(active.filter(candidate => candidate.arcIndex === undefined).map(candidate => [candidate.before, candidate.placement!]));
  const centerline: Node[] = []; const pipeRuns: Node[][] = []; const insulationRuns: Node[][] = [];
  let pipe: Node[] = []; let insulation: Node[] = [];
  const flush = () => {
    const core = dedupe(pipe); const outer = dedupe(insulation);
    if (core.length >= 2) pipeRuns.push(core);
    if (outer.length >= 2) insulationRuns.push(outer);
    pipe = []; insulation = [];
  };
  for (const [index, part] of parts.entries()) {
    if (part.kind === 'line') {
      const before = beforeLine.get(index); const after = afterLine.get(index);
      centerline.push(...trimLine(part, before?.endFace ?? part.points[0]!, after?.startFace ?? part.points.at(-1)!));
      pipe.push(...trimLine(part, before?.endStop ?? part.points[0]!, after?.startStop ?? part.points.at(-1)!));
      insulation.push(...trimLine(part, before?.endFace ?? part.points[0]!, after?.startFace ?? part.points.at(-1)!));
      const fitting = atCorner.get(index);
      if (fitting) { flush(); centerline.push(...fitting.path); }
    } else {
      const fitting = atArc.get(index);
      if (fitting) { flush(); centerline.push(...fitting.path); }
      else { centerline.push(...part.points); pipe.push(...part.points); insulation.push(...part.points); }
    }
  }
  flush();
  return { centerline: dedupe(centerline), pipeRuns, insulationRuns,
    fittings: active.map(candidate => candidate.placement!), issues: result.issues };
}
