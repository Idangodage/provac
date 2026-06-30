## Objective

Deliver a **definitive library-to-feature map and an executable modernization roadmap** for the provacx HVAC drawing engine (`packages/drawing-engine`, consumed by `apps/web` Next.js 14). The end state: exactly **one 2D engine owns interactive pipe drawing/editing** (Konva), **one engine renders the static document** (Fabric), **one headless geometry module is the single source of truth for pipe centerlines and bends** (shared by Fabric, Konva, and three.js so 2D and 3D agree by construction), spatial queries are indexed (rbush / three-mesh-bvh), CSG is scoped strictly to tee unions and cached, and the dependency set is right-sized (add `@flatten-js/core` + `rbush`; keep+wire `three-mesh-bvh`; scope-down `three-bvh-csg`; quarantine `utils/spline.ts` for pipes; reject Pixi/Paper/elk/dagre/verb-nurbs/r3f). This is the cross-cutting deliverable that sequences and de-risks T1–T7.

This task produces TWO artifacts: (A) the **audit map + roadmap document** committed to the repo, and (B) the **Tier-1 mechanical changes** (dependency adds + the spatial-index swap + the shared-centerline module skeleton) that the feature tasks (T1–T7) build on.

---

## Current State & Why It Hurts

The 2D canvas is a layered stack (`DrawingCanvas.tsx` return ~`:2479`): a single `fabric.Canvas` (`:1979`, `z-[2]` at `:2538`) hosts six renderer classes (`:1990-1994`) including `HvacPlanRenderer.ts` which draws **all** HVAC plan geometry AND Fabric-native pipe edit handles (`createPipeVertexHandle :1295`, `createPipeSegmentHandle :1418`). Above it, a transparent react-konva `<Stage>` at `z-[9]` (`PipeKonvaInteractionLayer.tsx :585-595`) draws a **second, redundant** set of pipe drag handles — but only when `localStorage.getItem('hvac.pipe.engine')==='konva'` (`DrawingCanvas.tsx :760-769,779-782`), OFF by default, and only for `type==='refrigerant-pipe'` (filter `:190-197`), skipping endpoints (`:700`), pipe-pairs, and branch kits. So **pipes live across two 2D libraries** with two hand-synced coordinate transforms.

Concretely tied to user-reported symptoms:

- **(b) connection distortions / misalignment.** Two independent transform implementations: Fabric via `setViewportTransform` (`useRendererSync.ts :321-329`) folding `viewportZoom = zoom * safePaperPerRealRatio` (`DrawingCanvas.tsx :570`); Konva via an inline `<Layer x={stageOffsetX} scaleX={viewportZoom}>` (`PipeKonvaInteractionLayer.tsx :575-596`) that does **not** explicitly fold the paper/real ratio. The canonical `coordinateTransform.ts` (`worldToScreen/screenToWorld/worldTo3D`) is **dead infrastructure** — grep shows only the test file imports it; every renderer re-derives `*MM_TO_PX` inline (`HvacPlanRenderer.ts :91,698,717`; `PipeKonvaInteractionLayer.tsx :284,600`; `buildHvacElementMesh.ts :554`). Worse, connection geometry is reconstructed from **rendered Fabric pixels** via `findNearestRenderedRefrigerantPipeBundleTarget` (`HvacPlanRenderer.ts :722-1089`) using `calcTransformMatrix()/MM_TO_PX` round-trips and heuristic gas/liquid re-pairing (`:980-1037`), instead of from the model.
- **(c) bends + branch-kit not smooth.** A corner is **three different curves**: stored sharp vertex; 2D `fabric.Polyline` with cosmetic `strokeLineJoin:'round'` plus a Catmull-Rom wobble for flexible segments (`refrigerantPipePairModel.ts :920-943`); 3D `QuadraticBezierCurve3` fillet (`pipeJointGeometry.ts :152-171,205-221`). The one true plan-space fillet (`pipeTopology.filletPolyline :211`) is **never called by 2D**. The 3D fillet is a quadratic Bezier through the raw vertex — **not a constant-radius arc**, so it does not honor the pipe bend radius and disagrees with 2D. The branch kit is a **cosmetic blob** with its branch-outlet direction forced to `{x:1,y:0}` (`refrigerantBranchKitModel.ts :1049`) even though the copper physically drops by `outletSeparationMm` — a guaranteed kink at the joint. Bend smoothness is governed by three unrelated formulas (`span/12`, `max(radius*1.5,12)`, `1.5*outerDiameter`) and `settings.bendRadiusFactor` is documented "reserved/not consumed".
- **(d) editing not smooth.** Every drag tick (throttled 10ms, `PipeKonvaInteractionLayer.tsx :97-102`) calls `updateHvacElement(...,{skipHistory:true})` → `store/index.ts :3972-4008` does a full `hvacElements.map` + per-element `JSON.stringify` diff + `regenerateElevations({debounce:true})` → new array identity fires `useRendererSync.ts :1010-1014` → `HvacPlanRenderer.syncElements` → `rebuildRefrigerantPipeRenderStateMaps` calling `buildRefrigerantPipeVisual` for **every** pipe twice (`refrigerantPipeRenderState.ts :239-326`). One gesture fires this cascade ~100×/sec across **two uncoordinated paint loops** (Fabric rAF scheduler `renderScheduler.ts` + react-konva reconciler). `resolveRefrigerantPipePairSpec` also **mutates geometry on read** (translates the whole route by a heal delta when `0.5mm<delta<=600mm`, `refrigerantPipePairModel.ts :1148-1168`), so resolve is non-idempotent.
- **(a) not user-friendly.** Handle visibility depends on a hidden localStorage flag; no insert-vertex, delete-vertex, endpoint re-drag/reconnect, or bend handle (grep finds none); edit-time snapping is far weaker than draw-time (grid-only, drag-end-only vs the rich port/bundle/ortho/45 snap in `useRefrigerantPipeTool.snapPoint :484-615`).
- **(e) wrong/duplicated library.** Three overlapping bundle-pairing implementations with copy-pasted tolerances (`HvacPlanRenderer :967-1037`, `refrigerantPipeRenderState :599-643`, `refrigerantPipePairModel.findNearestRefrigerantPipeBundleTarget`). `@turf/turf` shipped but unused on the pipe/clash path. `three-mesh-bvh` shipped but **zero imports**. `utils/spline.ts` is hand-rolled NURBS not wired into pipe rendering. Two legacy 3D pipe builders coexist (`IsometricViewCanvas.tsx :1761` capped-cylinder chain vs `buildSweptTubeGeometry`).

---

## Root Causes to Fix

- **Dual-2D-engine ownership of one object.** Pipe bodies render in Fabric; pipe handles render in a separate Konva Stage that must mirror pan/zoom every frame and round-trip through the store to preview. This is the structural root of (a)/(b)/(d)/(e).
- **No single geometry source of truth for bends.** 2D (round-join + spline), 3D (quadratic Bezier), and the unused `filletPolyline` are three derivations of the same corner. There is no shared, headless, arc-based centerline module.
- **Connections reconstructed from rendered pixels, not the model.** Pixel-readback + heuristic re-pairing introduces float drift and ambiguity.
- **Heavy per-tick recompute.** Full store map + `JSON.stringify` diff + elevation regen + whole-plan Fabric re-sync on every 10ms drag tick; no transient preview channel.
- **Non-idempotent resolve.** Reads silently translate/heal/re-space geometry.
- **Mis-sized / unused / duplicated libraries.** turf unused on hot path; three-mesh-bvh unused; spline.ts wrong tool; CSG run beyond its scope; vector math duplicated 4×.

---

## Target Design

### Architectural map (the deliverable)

| Feature | Library / method | Action | Rationale vs alternatives |
|---|---|---|---|
| Static document render (walls/rooms/dims/objects, static pipe backdrop) | **Fabric.js v6** | keep | Incumbent, good at retained-mode document. Pixi/Paper would add a redundant renderer. |
| Interactive pipe draw + edit (drag, grips, ghost preview, snap UI) | **Konva + react-konva** (single owner) | keep/promote | Node-based hit-testing/dragging fits parametric polyline editing; the code already fights Fabric's transform model. SVG+d3-drag is a viable lighter end-state but Konva is already present and partially built. |
| Pipe centerline + bend geometry (the single source of truth) | **`@flatten-js/core`** in a new headless `pipeCenterline`/`pipeFillet` module | add | Arc-spline (line + constant-radius arc fillet) is the real MEP elbow. flatten gives robust Arc/Segment/tangency math, framework-agnostic. verb-nurbs/paper rejected (heavy/wrong/stale). |
| Snapping + hit-testing (port/endpoint/grid/midpoint, ortho/45 lock) | **`@flatten-js/core`** (nearest-point/distance) in a shared `pipeSnapping` module | add | One renderer-agnostic snap core for both draw and edit. turf is GeoJSON-flavored and allocates; flatten is mm-native. |
| 2D spatial index (clash broad-phase, nearest-segment snap) | **`rbush`** | add | Dynamic R-tree, pure JS, already transitively present. Replaces O(n·m) loop in `detectRouteClashes`. |
| 3D pipe/elbow geometry | **three TubeGeometry over one CurvePath**, fillets as **true circular arcs** (cubic-kappa 0.5523·r handles or sampled `ArcCurve`), adaptive sampling | keep/fix | Already correct in bones; fix the Bezier→arc and feed the SAME arc the 2D module computes. r3f rejected (rewrite). |
| 3D tee/saddle unions | **`three-bvh-csg`** scoped to tees only + memoized by kit signature | keep/scope | CSG is right for genuine intersections, wrong (cost + seam artifacts) for elbows. |
| 3D clash verification + picking | **`three-mesh-bvh`** (`computeBoundsTree`/`shapecast`) | keep/wire | Already installed, unused. Correct tool for mesh overlap and fast pick; never CSG for overlap tests. |
| State / history | **zustand** | keep | Correct; add a transient preview channel so live drag does not hit the document store every tick. |
| Coordinate transforms | **`coordinateTransform.ts`** made load-bearing | keep/wire | Route Fabric, Konva, and three through `worldToScreen/screenToWorld/worldTo3D` so the round-trip test guards real call sites. |
| Freehand NURBS spline (`utils/spline.ts`) | — | remove (for pipes) | Not wired into pipe rendering; the 'wrong tooling' smell. |

### Core algorithm — arc-fillet centerline (shared 2D/3D)

For a corner with incoming/outgoing unit dirs `u`,`v` and target radius `r`: `theta = angleBetween(-u,v)/2`; tangent setback `d = r/tan(theta)`; clamp `r' = min(r, |inLeg|/2, |outLeg|/2)`; arc center on the interior bisector at `r/sin(theta)` from the corner; tangent points at `corner - d·u` and `corner + d·v`. Emit an ordered list of `{type:'line'|'arc'}` segments. **2D** renders arcs natively (Fabric Path `A` commands; Konva `sceneFunc` `ctx.arc/arcTo` or `Konva.Path` `A` data) — never tessellate to fixed polylines. **3D** sweeps the identical arc via `THREE.ArcCurve`/sampled arc inside the `CurvePath`. Bend radius comes from ONE knob (`settings.bendRadiusFactor`, finally consumed) backed by `bendRadiusFromDiameterMm`.

### Performance pattern

Live drag: keep candidate geometry in a Konva-local ref / transient preview channel and draw a cheap ghost; run `buildRefrigerantPipeVisual` + `updateHvacElement` + `regenerateElevations` **only on drag end** (or rAF-coalesced). Cache 3D `TubeGeometry`/CSG keyed by `(polyline-hash, radius, bendRadius)`.

---

## Libraries & Dependencies

**Add (this task wires the deps; feature tasks consume them):**
- `@flatten-js/core` — `pnpm --filter @provacx/drawing-engine add @flatten-js/core` (pin a current 1.x). Headless 2D kernel for the centerline + snapping modules.
- `rbush` — `pnpm --filter @provacx/drawing-engine add rbush` (+ `@types/rbush` if needed; verify it isn't already typed). Spatial index for clash + snap.

**Keep (no version change, but change usage):**
- `three-mesh-bvh ^0.9.10` — currently zero imports; wire `computeBoundsTree`/`shapecast` for 3D clash + picking.
- `three-bvh-csg ^0.0.18` — keep, but scope to tee unions only and memoize. **Pin exactly** (`0.0.18`), not `^`, because 0.0.x is pre-release and version-coupled to three internals; the existing test already notes Node loads a separate three build so result-class identity can differ.
- `konva ^9.3.22` + `react-konva ^18.2.10` — promote to the single pipe interaction engine; keep client-only dynamic import.
- `fabric ^6.0.0` — keep as document renderer. (Optional, out of scope: evaluate v7.4 upgrade — canvas v3 + CVE-2026-44311 fix, low-friction.)
- `@turf/turf ^7.3.4` — keep where genuinely used (rooms); do NOT adopt for pipe geometry. After T2/T4 land, grep for remaining importers and flag for removal if none.

**Remove / quarantine:**
- `utils/spline.ts` for pipe paths — delete pipe usage; keep only if a separate freehand annotation tool still imports it (grep to confirm before deleting the file).

**Reject for this task (document why in the roadmap):** `pixi.js`, `paper`, `elkjs`, `dagre`, `verb-nurbs`, `@react-three/fiber` (and `three-stdlib`/`three-custom-shader-material` as unjustified). `libavoid-js` — defer to a flagged Tier-3 auto-routing spike only.

---

## Implementation Steps

> Order matters: the audit doc + low-risk mechanical changes first, then the structural pieces that T1–T7 depend on. Do not attempt the full Fabric↔Konva consolidation inside this task — this task lands the **foundations and the map**; the consolidation itself is executed by the referenced feature tasks.

1. **Author the roadmap doc.** Create `packages/drawing-engine/docs/LIBRARY_AUDIT_AND_ROADMAP.md` containing: the architectural map table above; the add/keep/replace/remove list with the file:line evidence from this brief; the symptom→root-cause→fix matrix; and the sequencing plan that cross-references T1–T7 by ID (see "Dependencies on Other Tasks"). This is the primary deliverable.
2. **Add dependencies.** Run the two `pnpm --filter @provacx/drawing-engine add` commands; pin `three-bvh-csg` to exact `0.0.18` in `packages/drawing-engine/package.json`. Run `pnpm install` and `pnpm --filter @provacx/drawing-engine type-check`.
3. **Inventory grep (record results in the doc).** Confirm: zero non-test importers of `worldToScreen/worldTo3D` from `coordinateTransform.ts`; zero importers of `three-mesh-bvh`; pipe-path importers of `utils/spline.ts`; all call sites of the three duplicated bundle finders. Capture exact paths in the doc as the "before" state.
4. **Create the shared headless centerline module skeleton.** New file `packages/drawing-engine/src/components/canvas/hvac/pipeCenterline.ts` (pure, no fabric/konva/three imports): export `buildPipeCenterline(routePoints, bendRadiusMm): CenterlineSegment[]` implementing the arc-fillet formula on `@flatten-js/core` primitives. Add `pipeCenterline.test.ts` (vitest) pinning tangency, radius clamping, and overlap rejection. Do NOT yet rewire renderers — that is T-bends.
5. **Create the shared snapping module skeleton.** New file `packages/drawing-engine/src/components/canvas/hvac/pipeSnapping.ts`: move the pure rules currently inline in `PipeKonvaInteractionLayer.tsx` (`classifyHardDirection`, `intersectLines`, `snapToGrid`, parallel-pair offset, `DIRECTION_UNIT`) into framework-free functions that take pointer deltas and return next `routePoints` + snap candidates (port/endpoint via flatten nearest-point). Add `pipeSnapping.test.ts`.
6. **Swap clash broad-phase to rbush.** In `pipeClashRouting.ts`, insert each segment's elevation-envelope bbox into an rbush index, query candidates in `detectRouteClashes` (`:308`), then run the existing exact `segmentDistance`/`elevationEnvelopesOverlap` (`:264,:224`) only on candidates. Behavior must be identical — guard with a vitest that compares old-vs-new results on a fixture scene.
7. **Make `coordinateTransform.ts` load-bearing (non-breaking first pass).** Replace the inline `*MM_TO_PX` + pan/zoom math in `PipeKonvaInteractionLayer.tsx` (`:575-601`) and the `toPx` helper in `HvacPlanRenderer.ts` (`:91`) with calls to `worldToScreen/screenToWorld`, and `buildHvacElementMesh.ts` (`:554`) with `worldTo3D`. Keep numerics identical; the round-trip test now guards real callers.
8. **Collapse the three bundle-pairing implementations into one.** Extract a single `findNearestPipeBundleTarget` (model-only, ONE tolerance set) used by `useRefrigerantPipeTool`, `refrigerantPipeRenderState`, and `refrigerantPipePairModel`. Delete the pixel-readback path `findNearestRenderedRefrigerantPipeBundleTarget` (`HvacPlanRenderer.ts :722-1089`). This is shared infra for T-connections; land the unified function + tests here, leave deep callers to that task if scope balloons.
9. **Wire three-mesh-bvh for 3D clash verification (thin).** Add a `pipeClash3d.ts` helper using `computeBoundsTree`/`shapecast` as a verification pass after mesh build; do not put it in the 2D routing loop.
10. **Scope + memoize CSG.** In `buildHvacElementMesh.ts`/`pipeJointGeometry.ts`, gate `unionGeometries` to branch-kit tees only and add a geometry cache keyed by `(routeHash, radius, bendRadius)`; treat the `mergeGeometries` fallback as an error path (it reintroduces interpenetration).
11. **Quarantine `utils/spline.ts` for pipes.** Remove any pipe-path import; if no importers remain, delete the file; otherwise annotate it as freehand-annotation-only.
12. **Run the gate.** `pnpm --filter @provacx/drawing-engine type-check && pnpm --filter @provacx/drawing-engine test`, then manual verification (see Test Plan). Update the roadmap doc "after" state.

---

## Data Model / Type Changes

```ts
// pipeCenterline.ts — the single source of truth for derived bend geometry
export type CenterlineSegment =
  | { type: 'line'; start: Point2D; end: Point2D }
  | { type: 'arc'; center: Point2D; radiusMm: number;
      startAngleRad: number; endAngleRad: number; clockwise: boolean;
      start: Point2D; end: Point2D };

export interface PipeCenterline {
  segments: CenterlineSegment[];
  /** SVG path 'd' string with native A commands for Fabric/Konva Path. */
  toSvgPath(): string;
  /** Sampled Vector3 list (or arc descriptors) for three CurvePath. */
  to3dCurve(elevationZmm: number): { type: 'line' | 'arc'; points: Point2D[] }[];
}

export function buildPipeCenterline(
  routePoints: Point2D[],
  bendRadiusMm: number,
): PipeCenterline;
```

```ts
// Promote bend to a first-class corner property (consumed by 2D AND 3D).
// Replace the positional `segmentMaterials: ('hard'|'flexible')[]` parallel
// array (refrigerantPipePairModel.ts:167) with identity-bound segments+nodes
// (the RouteCornerNode shape already exists in pipeTopology.ts).
export interface RouteSegment { id: string; material: 'hard' | 'flexible'; }
export interface RouteCornerNode {
  id: string; vertexIndex: number; bendRadiusMm: number; // from settings.bendRadiusFactor
}
```

Note: full promotion of `routePoints`/connections out of the untyped `HvacElement.properties: Record<string,unknown>` bag and the segment/node identity model are owned by T-datamodel; this task introduces the `CenterlineSegment`/`PipeCenterline` types and the shared modules.

---

## UX & Interaction Requirements

- Dragging a vertex/segment feels **instant**: a lightweight ghost follows the cursor at 60fps; the heavy recompute + store write happens once on release.
- Bends render as **true smooth arcs** at every zoom level (native arc rendering, no faceting), identical in plan and 3D.
- **Edit-time snapping equals draw-time**: live grid, ortho/45 lock (Shift to free), and **port/bundle re-snap** so dragging an endpoint near a unit port or branch kit re-binds the connection instead of drifting.
- **Endpoints are draggable** and reconnect; missing affordances added: insert-vertex (double-click on segment), delete-vertex (Del / context menu), move-whole-segment along its axis, and a bend-radius handle showing a live arc preview.
- A **snap indicator** marker appears at the active snap target; an inline **length/angle readout** follows the active grip during drag.
- No hidden localStorage flag governs which handles appear — pipe interaction is consistent and default-on.

---

## Acceptance Criteria

- The roadmap doc `LIBRARY_AUDIT_AND_ROADMAP.md` exists, contains the architectural map, the add/keep/replace/remove list with file:line evidence, and the T1–T7 sequencing.
- `@flatten-js/core` and `rbush` are in `package.json`; `three-bvh-csg` pinned exactly to `0.0.18`; `pnpm install` and `type-check` pass.
- `pipeCenterline.ts` + `pipeSnapping.ts` exist as headless modules (no fabric/konva/three imports) with passing vitest specs.
- `detectRouteClashes` uses rbush broad-phase and produces **identical** results to the previous O(n·m) loop on the fixture (equivalence test green).
- `coordinateTransform.ts` `worldToScreen/screenToWorld/worldTo3D` have ≥1 real (non-test) caller each; the round-trip test still passes.
- The pixel-readback bundle finder (`HvacPlanRenderer.findNearestRenderedRefrigerantPipeBundleTarget`) is deleted or no longer on any live snap path.
- `three-mesh-bvh` has ≥1 import; `three-bvh-csg` runs only for tees and is memoized.
- No pipe-path code imports `utils/spline.ts`.
- `pnpm --filter @provacx/drawing-engine test` and `type-check` are green.

---

## Test Plan

- **Unit (vitest, repo standard — `pnpm --filter @provacx/drawing-engine test`):**
  - `pipeCenterline.test.ts`: arc tangency (arc endpoints lie on both legs), radius clamp = `min(r, halfIn, halfOut)`, overlap rejection on short adjacent legs, degenerate (collinear / <2 pts) handling.
  - `pipeSnapping.test.ts`: ortho/45 lock quantization, nearest-port snap within tolerance, parallel-pair offset preserved through corners.
  - `pipeClashRouting` equivalence test: rbush result set === legacy double-loop result set on a multi-pipe fixture.
  - `coordinateTransform.test.ts`: keep the 6-decimal round-trip; add an assertion that a renderer call path produces the same screen coords as `worldToScreen`.
  - CSG memo test: same kit signature returns a cached geometry instance; cache miss on radius change.
- **Visual / manual:**
  - Use the **`/verify`** skill (run the app, observe behavior) to confirm a dragged pipe is smooth and the bend matches between plan and 3D.
  - Use **Claude Preview MCP** (`preview_start`/`preview_screenshot`/`preview_eval`) on the Next.js dev server to capture before/after of a 90° bend at 2 zoom levels and a branch-kit join.
  - Use the **three.js MCP** (`show_threejs_scene` / `learn_threejs`) to validate that the arc-fillet centerline sweeps without Frenet twist at a vertical riser and that elbow radius equals the configured bend radius.
- **Perf check:** record drag-frame timing before/after the transient-preview change (no full store write per tick); confirm `regenerateElevations` is no longer called mid-drag.

---

## Edge Cases & Pitfalls

- **Vertical risers / axis-aligned first segment**: seed a deterministic initial normal so the swept-tube seam and end caps register; do NOT rely on the default up.
- **Short adjacent legs**: fillet radius must clamp so neighboring fillets never overlap (the "editing after assigning" jank source).
- **Opposed gas/liquid port order**: route ONE centerline then offset the pair concentrically; only the genuine crossing gets a local over/under bypass (`planBundleBypasses`).
- **rbush index sync**: rebuild/refresh the index on every zustand mutation that adds/moves/deletes a pipe, or maintain it incrementally — a stale index silently misses clashes.
- **react-konva SSR**: keep client-only dynamic import; Konva must never run during Next.js SSR.
- **CSG pre-release**: pin `three-bvh-csg` exactly; the welded result needs `recompute normals` and the `mergeGeometries` fallback must be treated as a failure, not a silent success.

**Do NOT:**
- Do NOT keep two render libraries fighting over the same pipe — Konva owns interaction, Fabric owns the static document. One transform, one scene graph per responsibility.
- Do NOT recompute the whole route / call `updateHvacElement` + `regenerateElevations` on every drag frame — preview cheaply, commit on drag end.
- Do NOT reconstruct connection geometry from rendered Fabric pixels — compute from the model only.
- Do NOT tessellate arcs into fixed polylines for 2D — render native arcs (Fabric `A` / Konva `arc`).
- Do NOT use `QuadraticBezierCurve3` for elbows — use a true constant-radius arc; round corners in ONE place (the shared centerline), never twice (2D then 3D).
- Do NOT adopt Pixi/Paper/elkjs/dagre/verb-nurbs/r3f, and do NOT route pipe geometry through `utils/spline.ts` or `@turf/turf`.
- Do NOT mutate stored geometry on read — make `resolveRefrigerantPipe(Pair)Spec` idempotent; reconcile only on explicit edit/commit.

---

## Dependencies on Other Tasks

This task is the **sequencing spine**. It lands the foundations (audit doc, deps, headless `pipeCenterline`/`pipeSnapping` modules, rbush swap, transform wiring) that the feature tasks consume:

- **T1 — 2D engine consolidation**: executes the full Fabric(document)/Konva(interaction) split; consumes `pipeSnapping` + the load-bearing `coordinateTransform`.
- **T2 — Geometry / bends**: consumes `pipeCenterline` (arc fillet) and replaces the 2D round-join + the 3D `QuadraticBezierCurve3` so 2D/3D agree; consumes `settings.bendRadiusFactor`.
- **T3 — 3D pipe/elbow**: deletes the legacy `IsometricViewCanvas` cylinder-chain builder; consumes the arc centerline + memoized CSG + three-mesh-bvh.
- **T4 — Routing / clash**: consumes the rbush broad-phase and the unified bundle-finder; the optional Tier-3 `libavoid-js` auto-router spike hangs off here.
- **T5 — Branch kits / connections**: consumes the unified bundle-finder and the parametric-tee fix (branch-outlet direction from the real departure tangent).
- **T6 — Editing UX (grips/insert/delete/snap)**: consumes the transient preview channel + `pipeSnapping`.
- **T7 — State model / persistence**: promotes `routePoints`/connections out of the untyped `properties` bag and replaces positional `segmentMaterials` with identity-bound segments/nodes; this task introduces the `CenterlineSegment`/`RouteSegment`/`RouteCornerNode` types it builds on.

Order the roadmap as: **T8 foundations → T2/T7 (geometry + data model) → T1/T6 (engine split + editing UX) → T3 (3D) → T5 (branch kits) → T4 (routing/clash) → optional T4-Tier3 (libavoid spike)**.