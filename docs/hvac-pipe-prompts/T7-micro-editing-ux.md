> **Task ID:** T7 — Micro-editing & path-editing UX (grips, vertices, bends, snapping)
> **Branch:** `feat/hvac-2d3d-precision`
> **Package:** `packages/drawing-engine` (consumed by `apps/web`, Next.js 14)
> **Audience:** A senior engineer or autonomous coding agent with full repo access.

You are implementing post-draw editing for refrigerant pipes. This brief is self-contained. Read it fully before touching code. Every file path below is real and verified against the current branch.

---

## 1. Objective

After a refrigerant pipe is committed, selecting it with the `select` tool must present a smooth, modern, AutoCAD-grade editing experience: draggable endpoint/vertex/segment **grips**, **insert/delete vertex**, per-corner **bend adjustment** with an arc-true preview, **ortho/45° lock** (Shift to free), **magnetic snapping** to unit ports, grid, branch-kit terminals and other pipe centerlines, a **live lightweight ghost preview** during drag, and **single-step undo/redo**. Crucially, this is delivered through **one renderer-agnostic interaction core** feeding **one interaction overlay (Konva)** — eliminating the current Fabric-handles-vs-Konva-handles split, the per-frame whole-route rebuild, and the per-tick store-write thrash. The end state: dragging a grip feels instant (no re-render flicker, no selection loss), bends look identical in 2D and 3D, and connections re-snap to ports instead of drifting.

---

## 2. Current State & Why It Hurts

The editing layer today is `packages/drawing-engine/src/components/canvas/hvac/PipeKonvaInteractionLayer.tsx`, a **flag-gated** Konva overlay (`localStorage 'hvac.pipe.engine' === 'konva'`, OFF by default — `DrawingCanvas.tsx:760-769,779-782`). It is mounted at `z-[9]` over the Fabric canvas (`z-[2]`) and only handles `type === 'refrigerant-pipe'` (filter `PipeKonvaInteractionLayer.tsx:190-197`).

**What exists and where it hurts:**

- **Two render libraries own one pipe.** Fabric draws pipe bodies AND its own vertex/segment handles (`HvacPlanRenderer.ts` `createPipeVertexHandle ~1295`, `createPipeSegmentHandle ~1418`); Konva draws a *second*, partial handle set. The two are deconflicted by stripping pipe ids from Fabric's selection set (`useRendererSync.ts:1016-1034`). Two coordinate transforms are hand-kept in sync: Fabric's `setViewportTransform` (`useRendererSync.ts:321-329`) vs Konva's inline `Layer x/y/scaleX` (`PipeKonvaInteractionLayer.tsx:575-596`). → user symptoms **(b) distortion**, **(e) wrong library**.
- **Every drag tick rewrites the whole route to the store.** `handleSegmentDragMove`/`handleVertexDragMove` call `updateHvacElement(..., {skipHistory:true})` every `DRAG_APPLY_INTERVAL_MS = 10ms` (`PipeKonvaInteractionLayer.tsx:83,97-102,476-489,552-565`). `updateHvacElement` (`store/index.ts:3972-4008`) does a full `hvacElements.map` + per-element `JSON.stringify` diff + `regenerateElevations({debounce:true})`. The new array identity fires `useRendererSync.ts:1010-1014` → `HvacPlanRenderer.syncElements` → `rebuildRefrigerantPipeRenderStateMaps` (`HvacPlanRenderer.ts:4086`) which calls `buildRefrigerantPipeVisual` for **every pipe twice** (`refrigerantPipeRenderState.ts:239-326`). This whole cascade runs ~100×/sec during a drag. → **(d) editing not smooth**, **(a) not user-friendly**.
- **Missing affordances.** No insert-vertex, no delete-vertex, no endpoint re-drag (endpoints are explicitly non-draggable — `PipeKonvaInteractionLayer.tsx:700` gates the hit-circle behind `{!handle.endpoint}`), no whole-segment-along-axis move, no bend handle. Vertices between two hard segments get NO handle (`:252-254`). The generic `types/grips.ts` Grip system excludes pipes (`GripOwnerType` has no `'pipe'`). → **(a)**.
- **Edit-time snapping is far weaker than draw-time and fights the user.** Draw uses rich port/bundle snap + ortho/45 + live grid (`useRefrigerantPipeTool.ts:484-615`). Edit uses ONLY grid snap, ONLY at drag-end forceApply, ONLY for hard segments (`PipeKonvaInteractionLayer.tsx:308-311,512-514`). Hard-segment drags silently snap back to `lastValidHandlePoint` on any direction-class change or `invalidHardSegmentCount>0`, which reads as the handle "sticking". → **(a)**, **(b)**, **(d)**.
- **Bends disagree between 2D and 3D.** 2D strokes a sharp polyline with `strokeLineJoin:'round'` (`HvacPlanRenderer.ts:1175-1183`) — a cosmetic stroke join, not a geometric arc. 3D builds a real `QuadraticBezierCurve3` fillet (`pipeJointGeometry.ts:152-171`). The one true plan-space arc fillet, `filletPolyline` (`pipeTopology.ts:211-266`, verified: clamps setback to half the shorter leg, emits arc points), is **never consumed by the 2D renderer**. So adjusting a bend shows a bare vertex in 2D and a different curve in 3D. → **(c) bends not smooth**.
- **The canonical transform module is dead.** `coordinateTransform.ts` (`worldToScreen`/`screenToWorld`/`worldTo3D`, verified pure + tested) has **zero non-test importers**; every view re-inlines `*MM_TO_PX`. → **(b)**, **(e)**.

---

## 3. Root Causes to Fix

- **Dual-engine handle ownership.** Pipe-edit handles exist in BOTH Fabric and Konva. Pick ONE (Konva) and remove the Fabric pipe-handle path for selected single pipes.
- **No transient preview channel.** The live-drag path and the commit path are the same expensive `updateHvacElement → syncElements → rebuildRenderStateMaps → regenerateElevations` cascade. There is no cheap ghost.
- **Identity churn during drag.** The `handles` `useMemo` depends on `selectedPipeElements` (derived from `hvacElements`), so each tick replaces the element and rebuilds the entire handle list mid-gesture (`PipeKonvaInteractionLayer.tsx:199-265`).
- **Snapping logic not shared.** Draw-time snapping (`useRefrigerantPipeTool.snapPoint`) and edit-time snapping are disjoint reimplementations; edit-time is the weak one.
- **Bend geometry not unified.** `filletPolyline` exists but is not the single source feeding 2D + 3D; `settings.bendRadiusFactor` is documented but unconsumed (`pipeRoutingSettings.ts:42-43,66`).
- **Positional `segmentMaterials` parallel array** (`refrigerantPipePairModel.ts:167`) breaks under vertex insert/delete — index shifts silently re-pad materials, flipping hard↔flexible mid-edit.

---

## 4. Target Design

### 4.1 One interaction core, one overlay

Create a **renderer-agnostic interaction core** — pure functions, zero Fabric/Konva/three imports — that takes the current route + a pointer delta + modifier state and returns the next route. The **Konva overlay is the single owner** of all interactive pipe editing (grips, ghost preview, snap indicators). Fabric remains the static document renderer (walls/rooms/dimensions/objects + non-selected pipe bodies). During an active drag, **Fabric does not redraw the edited pipe at all** — the Konva ghost is the live preview; Fabric repaints once on `dragEnd`.

> **Decision: keep Konva, do not migrate to SVG or fold into Fabric.** Konva already owns interaction and its node-drag model is the best fit. Folding into Fabric means the custom-controls boilerplate and reintroduces the immediate-mode rebuild problem. SVG+d3 is a defensible *end state* but is a larger change than this task needs. The win here is removing the *duplication*, not switching engines.

### 4.2 Live preview decoupled from commit

- **`onDragStart`**: snapshot baseline route + materials into a ref (already done at `:631-645/:717-727`). Disable Fabric rendering of this one element (set a `previewingElementId` so `HvacPlanRenderer` skips it).
- **`onDragMove`**: run the interaction core → produce `nextRoute` → draw a **Konva ghost** (a `Konva.Path` arc-filleted line + grip dots) **entirely within the Konva layer**. **Do NOT call `updateHvacElement`.** Coalesce ghost redraws to one per `requestAnimationFrame`.
- **`onDragEnd`**: run the core once more for the final point, call `updateHvacElement` **exactly once** with `{skipHistory:false}` (one history entry), clear `previewingElementId`, let Fabric repaint.

This single change is the highest-leverage fix for symptoms (b)/(d).

### 4.3 Arc-true bends — one fillet, both views

Make `filletPolyline` (`pipeTopology.ts:211`) the **single source of bend geometry**, driven by a per-corner bend radius derived from `settings.bendRadiusFactor` (wire it up — currently ignored). Then:

- **2D Konva render**: emit a `Konva.Path` whose data string uses SVG `A` arc commands per filleted corner (or sample the fillet arc points — `filletPolyline` already returns them). No `strokeLineJoin` cosmetic hack.
- **3D** (`pipeJointGeometry.ts buildTubeCurve`): feed the SAME filleted centerline / per-corner radius so the swept tube matches. (Full 3D arc-vs-bezier unification is **T-3D's** job — here, ensure the bend *radius value* is one shared number, not three formulas.)

### 4.4 Magnetic snapping — shared with draw-time

Build `pipeSnapping.ts`: a renderer-agnostic snap resolver returning a ranked snap candidate (point + kind + indicator). Candidate sources, ranked by **screen-space pixel distance** with a fixed pixel tolerance converted through current zoom (`screenLengthToWorld` from `coordinateTransform.ts`):

1. Unit ports / branch-kit terminals (reuse `getRefrigerantPipeBundleSnapTargets` from `refrigerantPipePairModel.ts:4335`).
2. Other pipe centerlines (nearest point on segment/arc via `@flatten-js/core`).
3. Grid (`snapPointToGrid`, `snapping.ts:16`).
4. Angle lock: ortho/45 via `applyOrthogonalConstraint`/`applyAngularConstraint` (`snapping.ts:23-55`), **Shift = free**.

Endpoints become **draggable with port re-snap** so dragging an endpoint near a port re-binds `startConnection`/`endConnection` instead of drifting. Show a snap indicator (a small Konva marker) at the active snap.

### 4.5 Use the canonical transform

Route the Konva overlay's world↔screen math through `coordinateTransform.ts` (`worldToScreen`/`screenToWorld`/`worldLengthToScreen`) instead of inline `*MM_TO_PX`. This kills transform #2 drift and makes the dead module load-bearing.

---

## 5. Libraries & Dependencies

| Package | Action | Rationale |
|---|---|---|
| `konva` ^9.3 / `react-konva` ^18.2 | **keep** | Single interaction owner. Native `Konva.Path` `A` arc commands → arc-true bends without tessellation. |
| `@flatten-js/core` | **add** | Headless TS 2D geometry kernel (Segment/Arc/Circle, `distanceTo`, intersect, nearest-point) for mm-space. Backs the shared fillet + snapping. ~40-line fillet on its primitives. Replaces duplicated hand-rolled vector math. |
| `@turf/turf` ^7.3 | **keep** | Already installed; acceptable for `nearestPointOnLine` candidate gen, but prefer flatten for arc/tangency. Never in per-frame loops uncached. |
| `rbush` | **evaluate** | Transitively present via turf. Optional snap broad-phase index if profiling shows snapping over many pipes is hot. Not needed first cut. |
| `paper.js`, `pixi.js`, `elkjs`, `dagre`, `verb-nurbs` | **do NOT add** | Each adds a redundant renderer or the wrong solver. Paper.js only as a *reference* for the segment+handle model. |

Version note: `@flatten-js/core` v1.x, zero-dep, ESM, tree-shakeable — confirm it bundles cleanly under the Next.js 14 client build (it is pure TS, no canvas/DOM, so no SSR externals needed). Konva must stay dynamically imported / client-only (already the case).

---

## 6. Implementation Steps

Work in this order. Each step should compile and pass tests before the next.

1. **Promote a typed route + stable segment ids (foundation for insert/delete).**
   - In `refrigerantPipePairModel.ts`, replace the positional `segmentMaterials: ('hard'|'flexible')[]` (`:167`) usage with a `segments: PipeSegment[]` model carrying stable `id` + `material` + optional `bendRadiusMm` on the *corner node* (see §7). Keep back-compat: `resolveRefrigerantPipeSpec` reads the legacy parallel array and upgrades it to ids on load (load-time migration, not per-render).
   - Add a `v1→v2` step in `store/canvasDataMigration.ts` to stamp segment ids onto old drawings.

2. **Create the renderer-agnostic interaction core.** New file `packages/drawing-engine/src/components/canvas/hvac/pipeEditCore.ts`. Move the pure logic currently inline in `PipeKonvaInteractionLayer.tsx` here: `classifyHardDirection`, `intersectLines`, the collinear-run parallel-offset segment solver, vertex move, plus NEW `insertVertexOnSegment(route, segmentId, point)` and `deleteVertex(route, vertexIndex)`. All take `(route, delta, modifiers)` → `{ nextRoute, snapResult }` and import nothing from Konva/Fabric/three. Unit-test in isolation (vitest).

3. **Create `pipeSnapping.ts`.** New file. Implement the ranked snap resolver from §4.4 using `@flatten-js/core` for nearest-point-on-segment/arc and the existing `getRefrigerantPipeBundleSnapTargets`, `snapPointToGrid`, `applyOrthogonalConstraint`, `applyAngularConstraint`. Pixel tolerance → world via `coordinateTransform.screenLengthToWorld`.

4. **Create `pipeBendFillet.ts` (thin wrapper) OR wire `filletPolyline` directly.** Expose `buildFilletedCenterline(route, segments, settings)` returning either arc-segment descriptors (for `Konva.Path` `A` commands) or sampled points (reuse `pipeTopology.filletPolyline:211`). Derive radius from `settings.bendRadiusFactor` (`pipeRoutingSettings.ts`).

5. **Add a transient preview channel to the Fabric renderer.** In `HvacPlanRenderer.ts`, add `setPreviewingElementId(id|null)` and make `syncElements`/`rebuildRefrigerantPipeRenderStateMaps` **skip** the previewed element entirely (no rebuild, no draw). Confirm `regenerateElevations` is NOT triggered during preview.

6. **Rewrite `PipeKonvaInteractionLayer.tsx` drag lifecycle.**
   - `handles` `useMemo`: key off a **stable per-vertex/segment id**, not the whole element object, so the list is not rebuilt mid-drag (`:199-265`).
   - Coordinate math: replace inline `node.x()/MM_TO_PX` (`:284-285,600-601`) with `coordinateTransform` helpers.
   - `onDragStart`: snapshot + `renderer.setPreviewingElementId(id)`.
   - `onDragMove`: call `pipeEditCore` + `pipeSnapping` → draw a **Konva ghost** (`Konva.Path` from `pipeBendFillet`) + snap indicator. **Remove the per-tick `updateHvacElement` calls** (`:476-489,552-565`). rAF-coalesce.
   - `onDragEnd`: one final core call → single `updateHvacElement` (history on) → `setPreviewingElementId(null)`.
   - Make **endpoints draggable** (remove the `{!handle.endpoint}` gate at `:700`) with port re-snap that rewrites `startConnection`/`endConnection`.
   - Add **insert-vertex** (double-click on a segment → `insertVertexOnSegment`) and **delete-vertex** (Del / right-click on a vertex grip → `deleteVertex`).

7. **Remove the Fabric pipe-handle path for selected single pipes.** Once Konva is the single owner, stop `HvacPlanRenderer` from stamping `createPipeVertexHandle`/`createPipeSegmentHandle` for selected `refrigerant-pipe` elements; keep them only for cases Konva does not yet cover (pipe-pair / branch-kit) until those migrate. Remove the `localStorage 'hvac.pipe.engine'` gate (`DrawingCanvas.tsx:760-769`) — Konva editing becomes the default, not an opt-in flag.

8. **Inline measurement readout.** During drag, render segment length + bend/turn angle as a Konva label following the active grip (reuse mm formatting from `formatting.ts`).

9. **Wire 3D radius source.** Ensure `pipeJointGeometry.ts`/`buildHvacElementMesh.ts` read the same per-corner `bendRadiusMm` the 2D fillet uses (value parity only; geometry-pipeline unification is T-3D).

---

## 7. Data Model / Type Changes

```ts
// refrigerantPipePairModel.ts (or a new pipeRouteModel.ts)

/** Stable-identity segment so vertex insert/delete cannot shift material by index. */
export interface PipeSegment {
  id: string;                       // stable, survives insert/delete
  material: 'hard' | 'flexible';
}

/** Per-corner bend, first-class so 2D + 3D share one radius. */
export interface PipeCornerBend {
  vertexIndex: number;              // interior vertex this bend rounds
  bendRadiusMm: number;             // derived from settings.bendRadiusFactor unless overridden
  overridden?: boolean;             // true if user dragged the bend handle
}

// RefrigerantPipeSpec gains:
//   segments: PipeSegment[];       // replaces positional segmentMaterials[] (legacy still read on load)
//   cornerBends?: PipeCornerBend[];
```

```ts
// pipeEditCore.ts
export type EditModifiers = { ortho: boolean; free: boolean /* Shift */; };
export interface SnapResult {
  point: Point2D;
  kind: 'port' | 'terminal' | 'pipe' | 'grid' | 'angle' | 'none';
}
export function moveVertex(route: Route, vertexIndex: number, target: Point2D, mods: EditModifiers, ctx: SnapContext): { nextRoute: Route; snap: SnapResult };
export function moveSegment(route: Route, segmentId: string, delta: Point2D, mods: EditModifiers, ctx: SnapContext): { nextRoute: Route; snap: SnapResult };
export function insertVertexOnSegment(route: Route, segmentId: string, point: Point2D): Route;
export function deleteVertex(route: Route, vertexIndex: number): Route;
```

```ts
// types/grips.ts — extend ownership to pipes (currently wall/room/furniture only)
export type GripOwnerType = 'wall' | 'room' | 'furniture' | 'pipe';
```

---

## 8. UX & Interaction Requirements

- **Instant drag.** No flicker, no full-canvas repaint, no selection loss while dragging a grip. The pipe must not "jump" or "stick".
- **Live ghost preview** follows the cursor at display refresh rate (rAF), drawn arc-true with the same bend radius the committed pipe will have.
- **Magnetic snapping** with a visible indicator: dragging near a unit port, branch-kit terminal, grid intersection, or another pipe centerline snaps with a clear marker; releasing binds the connection.
- **Ortho/45° lock** by default; **hold Shift** to drag freely; live **length + angle readout** beside the active grip.
- **Affordances:** endpoint grips (re-drag + reconnect), vertex grips (move/delete), segment midpoint grips (move along axis / offset), **double-click a segment to insert a vertex**, **Del or right-click a vertex to delete**, optional bend handle to adjust corner radius.
- **One undo per gesture.** A drag, an insert, or a delete = exactly one history step.
- Bends must look **identical in plan (2D) and 3D**.

---

## 9. Acceptance Criteria

- [ ] Selecting a `refrigerant-pipe` shows Konva grips with **no Fabric handles for the same pipe** (no double handles); the `localStorage` engine flag is gone — Konva is default.
- [ ] A grip drag issues **exactly one** `updateHvacElement` call (verified by spy) and **zero** `regenerateElevations` calls until `dragEnd`.
- [ ] During drag, `HvacPlanRenderer.syncElements` does **not** rebuild the previewed element (assert `previewingElementId` is skipped).
- [ ] Endpoints are draggable and re-snap to ports; releasing near a port rewrites `startConnection`/`endConnection`.
- [ ] Double-click on a segment inserts a vertex; Del/right-click deletes one; **material/bend identity is preserved** (no silent hard↔flexible flip) thanks to stable segment ids.
- [ ] Ortho/45 lock active by default; Shift frees; snap indicator + length/angle readout visible during drag.
- [ ] A single drag/insert/delete = one undo step; undo/redo round-trips geometry exactly.
- [ ] 2D bend at a corner is an arc of the configured `bendRadiusFactor` radius and the 3D swept tube uses the **same** radius value.
- [ ] No selection loss across a drag; no console errors; FPS stays smooth on a route of ≥12 vertices.

---

## 10. Test Plan

**Unit (vitest — repo standard, files like `pipeJointGeometry.test.ts`, `coordinateTransform.test.ts` exist):**
- `pipeEditCore.test.ts`: `moveVertex`, `moveSegment` (collinear-run offset + corner re-intersection), `insertVertexOnSegment`, `deleteVertex` — assert geometry, stable ids, material preservation under insert/delete.
- `pipeSnapping.test.ts`: ranking (port > terminal > pipe > grid), pixel-tolerance→world conversion at zoom 0.5/1/2, ortho/45 with Shift-free bypass.
- `pipeBendFillet.test.ts`: arc setback clamps to half the shorter leg (parity with `filletPolyline`), radius derives from `bendRadiusFactor`.
- Migration test: legacy `segmentMaterials[]` drawing → upgraded `segments[]` with ids round-trips.

**Manual / visual (use the `verify` skill and Claude Preview MCP `mcp__Claude_Preview__*`):**
- Run `apps/web`, draw a multi-bend pipe, select it, and exercise every affordance. Watch for flicker/jump/selection loss.
- Confirm snap indicator + readout appear; confirm port re-bind on endpoint drag.
- Use the three.js MCP (`mcp__de970454-...__show_threejs_scene`) or the in-app 3D view to confirm 2D and 3D bends match radius.
- Profile a drag (React DevTools / Performance) and confirm no ~100Hz store writes.

---

## 11. Edge Cases & Pitfalls

**DO NOT:**
- ❌ Keep two render libraries drawing handles for the same pipe. One owner (Konva).
- ❌ Call `updateHvacElement` (or any store write) on every drag tick. Preview lives in Konva; commit once on `dragEnd`.
- ❌ Trigger `regenerateElevations` during a live drag.
- ❌ Recompute `buildRefrigerantPipeVisual` for *all* pipes per frame; skip the previewed element in `syncElements`.
- ❌ Rebuild the `handles` `useMemo` off the whole element object (rebuilds mid-drag) — key off stable ids.
- ❌ Keep `segmentMaterials` as a bare positional array under insert/delete — use stable segment ids.
- ❌ Add Paper.js/Pixi/elk as renderers, or route pipe geometry through `utils/spline.ts` (Catmull-Rom/NURBS — wrong for constant-radius pipe bends).

**Edge cases to handle:**
- Insert/delete on a 2-point route (don't drop below a valid polyline).
- Fillet setback overrun when two corners are close — clamp (already in `filletPolyline`) and relax overlapping fillets.
- Endpoint drag that lands on no port (free endpoint) — clear the connection cleanly, don't leave a stale `startConnection`.
- Snap-back behavior must NOT feel like sticking: prefer constraining the candidate to a valid direction over silently rejecting the move (replace the `lastValidHandlePoint` snap-back UX at `PipeKonvaInteractionLayer.tsx:338-438`).
- Vertical/short segments where `classifyHardDirection` returns null — still allow free (Shift) drag.
- Zoom extremes: hit radii via `worldLengthToScreen`, not stale baked-in geometry.

---

## 12. Dependencies on Other Tasks

- **T (Fabric/Konva consolidation)** — this task *implements the first concrete slice* of "Konva is the single pipe interaction owner." If a separate consolidation task exists, coordinate so the `previewingElementId` channel and the removal of Fabric pipe-handles land once.
- **T-3D (three.js swept-elbow geometry)** — owns replacing `QuadraticBezierCurve3` with true arcs and rotation-minimizing frames. T7 only guarantees the **bend radius value** is shared; it does not rewrite the 3D pipeline.
- **T (single source of truth for connections)** — the endpoint port re-snap here must write to the same canonical `startBundleConnection`/`endBundleConnection` model; do not reconstruct connections from rendered Fabric pixels (`findNearestRenderedRefrigerantPipeBundleTarget`, `HvacPlanRenderer.ts:722-1089` — avoid).
- **T (branch-kit real-tee)** — pipe-pair and branch-kit grip editing migrate to this same Konva core *after* T7 proves the pattern on single `refrigerant-pipe`.
