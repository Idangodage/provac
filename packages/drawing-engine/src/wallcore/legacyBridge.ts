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
import { dist2, type Vec2 } from './vec2';
import { findNodeNear } from './wallGraph';
import {
  createEmptyWallGraph,
  type WallEdge2,
  type WallEntityId,
  type WallGraphDoc,
  type WallIdSource,
  type WallJustification,
} from './wallModel';
import { solveWallGraphDoc, type EdgeFootprint } from './wallSolver';

/** Graph identity stamped onto mirrored legacy walls. */
export interface WallGraphMeta {
  a: WallEntityId;
  b: WallEntityId;
  justification: WallJustification;
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
}

export const DEFAULT_LEGACY_WALL_HEIGHT = 2700;

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
  /** Recompute derived legacy geometry (offset lines, bevel normalization). */
  rebuildGeometry(wall: W): W;
  /**
   * Stamp the SOLVED footprint corners `[aLeft, bLeft, bRight, aRight]` onto
   * the mirrored wall (interior line = aL→bL, exterior = aR→bR), so the 2D
   * renderer draws the exact mitred/bevelled body the solver produced — the
   * same geometry the 3D prisms use.
   */
  applyFootprint?(wall: W, corners: EdgeFootprint['corners']): W;
}

/**
 * Mirror the graph into the legacy wall array. Edges keep their legacy wall
 * (openings, bevels, 3D attributes preserved) whenever the id survives;
 * `connectedWalls` is derived from TRUE shared-node adjacency.
 */
export function legacyWallsFromGraph<W extends LegacyWallLike>(
  doc: WallGraphDoc,
  prevWalls: readonly W[],
  callbacks: MirrorCallbacks<W>,
): W[] {
  const prevById = new Map(prevWalls.map((w) => [w.id, w]));
  const edges = Object.values(doc.edges).sort((x, y) => (x.id < y.id ? -1 : 1));
  const solvedCorners = callbacks.applyFootprint
    ? new Map(solveWallGraphDoc(doc).footprints.map((f) => [f.edgeId, f.corners]))
    : null;

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

    const prev = prevById.get(edge.id);
    const base: W = prev
      ? {
          ...prev,
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
    const withConnections = { ...base, connectedWalls: connected } as W;
    let rebuilt = callbacks.rebuildGeometry(withConnections);
    const corners = solvedCorners?.get(edge.id);
    if (corners && callbacks.applyFootprint) {
      rebuilt = callbacks.applyFootprint(rebuilt, corners);
    }
    out.push(rebuilt);
  }
  return out;
}
