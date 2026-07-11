# Plan: wall system rebuild — faithful port from "Advance canvas board"

## Context

User directive: remove ProvacX's legacy wall logic and reimplement walls exactly the
way the reference app does (`D:\myWorks\Advance canvas board`): drawing, rendering,
transformations, drag and flip. Per the standing rebuild strategy (pipe invariant:
`components/canvas/hvac/*` untouched), the NEW system is built alongside and the old
entangled wall code (WallRenderer, wall paths in useSelectMode/useCanvasMouseHandlers,
store wall actions, isometric wallBands) is retired LAST, wholesale.

## How the reference implements walls (audited)

- **Model = shared-node graph, not shapes** (LAW 2): `WallNode {p}` + `WallEdge
  {a,b,thickness,height,baseOffset,justification,material}`. Rooms/footprints derived.
- **`wallGraph.ts` (topology, pure):** weld (`findNodeNear`, WELD_EPS = 0.5 mm), split
  (`splitEdgeAt`), draw-through crossings (`addSegmentWithCrossings` splits every
  crossed wall → X junctions), `resolvePointToNode`, orphan-node GC on delete.
- **`wallSolver.ts` (footprints, pure & deterministic, LAW 4):** justification-aware
  centerline offsets (`halfWidths`), per-node join resolution — miter →
  bevel past `MITER_LIMIT_FACTOR·maxT` → butt caps; valence ≥ 3 wedge polygons;
  edge-id sorting ⇒ output independent of iteration order (property-tested).
- **Commands (`cmds/wall.ts`):** addWallChain, moveNode (endpoint drag WITH weld/split
  on drop), setParams (thickness/height/justification/…), setLength (temp-dim numeric
  edit, anchored end), split, merge (2-valence collinear), delete (cascades openings,
  GCs nodes), entity.move (edges move via deduped nodes). Every mutation one command.
- **Rendering (`builders/wallMesh.ts`):** footprints + wedges → prisms → ONE merged
  BufferGeometry (earcut caps + side quads, per-vertex entityIndex for picking).
  The 2D plan is the SAME geometry through the top ortho camera.
- **Tool (`tools/wall.ts`):** FSM chain drawing, per-segment commit (Backspace =
  undo()), auto-close near first point, soft angle locks 0/45/90 + Shift hard lock,
  numeric HUD (L/∠) commits a point.
- **Flip:** wall body flip = justification left↔right about the fixed centerline;
  opening flipX/flipSwing (openings milestone).

## Why ProvacX's old wall code cannot be "fixed" into this

ProvacX walls are independent segments (`Wall {startPoint,endPoint}`) with per-wall
fabric shapes and ad-hoc endpoint matching — no shared nodes, so joins/junctions/drag
can never be topology-true; exactly the anti-pattern the reference spec §1 calls out.

## Milestones

- **W1 (this change) — headless core, verbatim-faithful port.**
  `packages/drawing-engine/src/wallcore/` (ZERO imports from three/fabric/react):
  `vec2.ts`, `angle.ts`, `tolerances.ts`, `wallModel.ts` (WallGraphDoc = plain
  records of nodes/edges — JSON-serializable), `wallGraph.ts`, `wallSolver.ts`,
  `wallOps.ts` (addWallChain / moveWallNode(weld) / setWallParams /
  flipWallJustification / setWallLength / splitWall / mergeAtNode / deleteWalls /
  moveWallEdges). Tests: the reference's golden solver suite ported verbatim
  (L/T/X junctions, miter limit, collinear pass-through, order-invariance
  property test) + ops tests (weld/split/crossings/merge/length/flip).
- **W2 — store + persistence:** `wallGraph` slice in the smart-drawing store, ops
  executed through it with history; serialization of the graph in canvasData
  (schema-versioned; legacy `Wall[]` docs migrated once: each legacy wall →
  addWallChain with weld, preserving thickness/height).
- **W3 — rendering:** solver output → 2D plan (fabric polygons: footprint+wedge
  fills with poché, per-edge hit regions) AND → hybrid 3D prisms (port
  wallMesh.ts; replaces isometric wallBands for walls). One solve, both views.
- **W4 — tool + interactions:** wall tool FSM per reference (chain, per-segment
  commit, Backspace, auto-close, angle locks, HUD); drag = moveWallNode with
  weld/split on drop + edge body-drag via deduped nodes; flip action + temp-dim
  length edit in the properties panel.
- **W5 — retire old:** delete WallRenderer/wallBands wall paths, wall branches in
  useSelectMode/useCanvasMouseHandlers/useRendererSync, store `walls[]` actions;
  keep `Wall` type only in the migration reader.

## Verification

W1: full golden+property suite green, type-check, lint. W3/W4 per milestone: draw an
L, T, X junction on canvas — joins miter correctly in 2D, prisms match in 3D through
the tilt; drag a corner across another wall → welds; flip switches the body side
about a fixed centerline; 100 undo/redo cycles stable.
