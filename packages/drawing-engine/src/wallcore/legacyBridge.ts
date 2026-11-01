/**
 * Bridge between the NEW wall graph (shared-node topology — the reference
 * architecture, source of truth) and ProvacX's legacy `Wall[]` mirror that the
 * existing renderers/persistence/history still consume during the migration.
 *
 * Direction of truth: graph → walls. Every mirrored wall carries its graph
 * identity (`graph: {a, b, justification}`), so the graph is EXACTLY
 * reconstructible from any history snapshot or saved document — undo/redo and
 * persistence need no schema surgery. Legacy documents (walls without graph
 * metadata) migrate once: endpoints weld into shared nodes (WELD_EPS) but
 * bodies are NOT retro-split, so old drawings keep their wall ids/openings.
 */
import { OPENING_EDGE_MARGIN } from './tolerances';
import { dist2, type Vec2 } from './vec2';
import { findNodeNear } from './wallGraph';
import {
  createEmptyWallGraph,
  type WallEdge2,
  type WallEdgeSource,
  type WallEntityId,
  type WallGraphDoc,
  type WallIdSource,
  type WallJustification,
} from './wallModel';

/** Graph identity stamped onto mirrored legacy walls. */
export interface WallGraphMeta {
  a: WallEntityId;
  b: WallEntityId;
  justification: WallJustification;
}

/** A door or window: `position` is the distance of its centre from the wall's start. */
export interface LegacyOpeningLike {
  id: string;
  position: number;
  width: number;
}

/** The minimal legacy-wall surface the bridge reads/writes (structural typing). */
export interface LegacyWallLike {
  id: string;
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  thickness: number;
  material: string;
  properties3D?: { height?: number; baseElevation?: number; materialId?: string };
  graph?: WallGraphMeta;
  openings?: LegacyOpeningLike[];
}

export const DEFAULT_LEGACY_WALL_HEIGHT = 2900;

/**
 * Reconstruct/migrate the wall graph from a legacy mirror.
 * - Walls WITH graph metadata rebuild their nodes/edges verbatim (shared node
 *   ids ⇒ shared corners; first writer of a node fixes its position).
 * - Walls WITHOUT metadata (legacy docs) weld endpoints into nearby nodes.
 */
export function wallGraphFromLegacyWalls(
  walls: readonly LegacyWallLike[],
  ids: WallIdSource,
): WallGraphDoc {
  const doc = createEmptyWallGraph();

  const stamped = walls.filter((w) => w.graph);
  const bare = walls.filter((w) => !w.graph);

  for (const wall of stamped) {
    const meta = wall.graph!;
    if (!doc.nodes[meta.a]) {
      doc.nodes[meta.a] = { id: meta.a, p: [wall.startPoint.x, wall.startPoint.y] };
    }
    if (!doc.nodes[meta.b]) {
      doc.nodes[meta.b] = { id: meta.b, p: [wall.endPoint.x, wall.endPoint.y] };
    }
    doc.edges[wall.id] = {
      id: wall.id,
      a: meta.a,
      b: meta.b,
      thickness: wall.thickness,
      height: wall.properties3D?.height ?? DEFAULT_LEGACY_WALL_HEIGHT,
      baseOffset: wall.properties3D?.baseElevation ?? 0,
      justification: meta.justification,
      material: wall.material,
      materialId: wall.properties3D?.materialId,
    };
  }

  for (const wall of bare) {
    const resolve = (p: Vec2): WallEntityId => {
      const near = findNodeNear(doc, p);
      if (near) return near.id;
      const id = ids.newId();
      doc.nodes[id] = { id, p };
      return id;
    };
    const a = resolve([wall.startPoint.x, wall.startPoint.y]);
    const b = resolve([wall.endPoint.x, wall.endPoint.y]);
    if (a === b) continue; // degenerate zero-length legacy wall
    doc.edges[wall.id] = {
      id: wall.id,
      a,
      b,
      thickness: wall.thickness,
      height: wall.properties3D?.height ?? DEFAULT_LEGACY_WALL_HEIGHT,
      baseOffset: wall.properties3D?.baseElevation ?? 0,
      justification: 'center',
      material: wall.material,
      materialId: wall.properties3D?.materialId,
    };
  }

  return doc;
}

export interface MirrorCallbacks<W extends LegacyWallLike> {
  /** Create a brand-new legacy wall for an edge the mirror has never seen. */
  createWall(edge: WallEdge2, start: Vec2, end: Vec2): W;
  /** Recompute derived legacy geometry (offset lines, bevel normalization); `previous` is this wall before the edit. */
  rebuildGeometry(wall: W, previous?: W): W;
  /** A door or window had to shift to stay whole on the piece of wall it now sits on. */
  onOpeningMoved?(openingId: string, movedMm: number): void;
}

/**
 * Doors and windows of walls this operation split or merged, on their new pieces.
 * Each stays on the piece holding its centre and is never lost: if a new wall end
 * lands on it, it moves the minimum needed to stay whole, or to the longest piece
 * when its own cannot hold it. Only new ends push: a door already close to the
 * wall's own end, as the user placed it, stays where it is.
 */
function rehostOpenings(
  doc: WallGraphDoc,
  prevById: ReadonlyMap<string, LegacyWallLike>,
  onMoved: MirrorCallbacks<LegacyWallLike>['onOpeningMoved'],
): Map<WallEntityId, LegacyOpeningLike[]> {
  const rehosted = new Map<WallEntityId, LegacyOpeningLike[]>();
  const piecesByWall = new Map<WallEntityId, Array<{ edgeId: WallEntityId; source: WallEdgeSource }>>();
  for (const [edgeId, sources] of Object.entries(doc.sources ?? {})) {
    if (!doc.edges[edgeId]) continue;
    rehosted.set(edgeId, []);
    for (const source of sources) {
      const pieces = piecesByWall.get(source.wallId);
      if (pieces) pieces.push({ edgeId, source });
      else piecesByWall.set(source.wallId, [{ edgeId, source }]);
    }
  }

  for (const [wallId, pieces] of piecesByWall) {
    const openings = prevById.get(wallId)?.openings ?? [];
    if (openings.length === 0) continue;
    const wallEnd = Math.max(...pieces.map(({ source }) => source.toMm));
    const longestFirst = [...pieces].sort((x, y) => (y.source.toMm - y.source.fromMm) - (x.source.toMm - x.source.fromMm));
    for (const opening of openings) {
      const centre = opening.position;
      const halfWidth = opening.width / 2;
      const range = ({ fromMm, toMm }: WallEdgeSource): [number, number] => [
        fromMm > 0 ? fromMm + halfWidth + OPENING_EDGE_MARGIN : Math.min(centre, halfWidth),
        toMm < wallEnd ? toMm - halfWidth - OPENING_EDGE_MARGIN : Math.max(centre, wallEnd - halfWidth),
      ];
      const home = pieces.find(({ source }) => centre >= source.fromMm && centre < source.toMm)
        ?? longestFirst[0]!;
      const fits = (candidate: typeof home) => {
        const [lo, hi] = range(candidate.source);
        return lo <= hi;
      };
      const piece = [home, ...longestFirst].find(fits) ?? longestFirst[0]!;
      const [lo, hi] = range(piece.source);
      const settled = lo <= hi
        ? Math.min(hi, Math.max(lo, centre))
        : (piece.source.fromMm + piece.source.toMm) / 2; // nowhere can hold it whole: it still is not deleted
      const { offsetMm, reversed } = piece.source;
      rehosted.get(piece.edgeId)!.push({ ...opening, position: reversed ? offsetMm - settled : offsetMm + settled });
      if (Math.abs(settled - centre) > 0.5) onMoved?.(opening.id, Math.abs(settled - centre));
    }
  }
  return rehosted;
}

/**
 * Mirror the graph into the legacy wall array. Edges keep their legacy wall
 * (openings, bevels, 3D attributes preserved) whenever the id survives, and a
 * new piece of a split wall is still that wall in everything but its extent;
 * `connectedWalls` is derived from TRUE shared-node adjacency.
 */
export function legacyWallsFromGraph<W extends LegacyWallLike>(
  doc: WallGraphDoc,
  prevWalls: readonly W[],
  callbacks: MirrorCallbacks<W>,
): W[] {
  const prevById = new Map(prevWalls.map((w) => [w.id, w]));
  const edges = Object.values(doc.edges).sort((x, y) => (x.id < y.id ? -1 : 1));
  const rehosted = doc.sources ? rehostOpenings(doc, prevById, callbacks.onOpeningMoved) : null;

  // shared-node adjacency → connectedWalls
  const edgesByNode = new Map<WallEntityId, WallEntityId[]>();
  for (const e of edges) {
    for (const n of [e.a, e.b]) {
      const list = edgesByNode.get(n);
      if (list) list.push(e.id);
      else edgesByNode.set(n, [e.id]);
    }
  }

  const out: W[] = [];
  for (const edge of edges) {
    const start = doc.nodes[edge.a]?.p;
    const end = doc.nodes[edge.b]?.p;
    if (!start || !end || dist2(start, end) < 1e-9) continue;

    const meta: WallGraphMeta = { a: edge.a, b: edge.b, justification: edge.justification };
    const connected = Array.from(
      new Set([...(edgesByNode.get(edge.a) ?? []), ...(edgesByNode.get(edge.b) ?? [])]),
    ).filter((id) => id !== edge.id);

    const sources = doc.sources?.[edge.id];
    const prev = prevById.get(edge.id)
      ?? sources?.map((source) => prevById.get(source.wallId)).find((wall) => wall !== undefined);
    const base: W = prev
      ? {
          ...prev,
          id: edge.id,
          startPoint: { x: start[0], y: start[1] },
          endPoint: { x: end[0], y: end[1] },
          thickness: edge.thickness,
          material: edge.material,
          properties3D: prev.properties3D
            ? {
                ...prev.properties3D,
                height: edge.height,
                baseElevation: edge.baseOffset,
                materialId: edge.materialId ?? prev.properties3D.materialId,
              }
            : prev.properties3D,
          graph: meta,
        }
      : { ...callbacks.createWall(edge, start, end), graph: meta };
    const openings = rehosted?.get(edge.id);
    const withConnections = { ...base, connectedWalls: connected, ...(openings ? { openings } : {}) } as W;
    out.push(callbacks.rebuildGeometry(withConnections, prevById.get(edge.id)));
  }
  return out;
}
