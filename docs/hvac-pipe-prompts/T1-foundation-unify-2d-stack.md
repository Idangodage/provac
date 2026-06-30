> Self-contained engineering brief for the provacx repo, branch `feat/hvac-2d3d-precision`. You are the senior engineer (or coding agent) executing **T1 — Foundation: unify the 2D rendering stack & smart drawing architecture**. This is the foundational task other pipe-system tasks build on. All paths are absolute from the repo root `D:/myWorks/ProvacX/provacx/provacx`.

## 1. Objective

Establish a single, coherent foundation for the refrigerant-pipe system so that every view derives from one source of truth and one transform. Concretely: (a) **resolve the Fabric-vs-Konva split** by making Konva the sole owner of the *pipe interaction layer* (draw + edit handles + live preview + snapping for `refrigerant-pipe`, `refrigerant-pipe-pair`, and branch kits) while Fabric remains the static document backdrop renderer for everything else; (b) **make `coordinateTransform.ts` load-bearing** so Fabric, Konva and three.js all un-project pointer/geometry through one transform definition instead of three hand-synced copies; (c) **introduce a headless `pipeCenterline` module** (pure, framework-free, arc-spline based) that is the single derivation of pipe geometry consumed by both the 2D renderer and the 3D mesh builder; and (d) **define the smart drawing-tool architecture** — a tool state machine, a cheap live-preview ghost decoupled from store commits, and a clean command/undo boundary. The end state: dragging a pipe vertex updates a ghost at 60fps with no store thrash, the handles sit exactly on the rendered pipe at every zoom, and 2D and 3D agree on every bend because they read the same centerline.

## 2. Current State & Why It Hurts

The 2D canvas is a **layered stack, not one renderer** (`packages/drawing-engine/src/components/DrawingCanvas.tsx`, render tree ~line 2479). One `fabric.Canvas` is constructed once (~line 1979, `preserveObjectStacking:true`) and shared by six renderer classes (~lines 1990-1994). `HvacPlanRenderer` (`packages/drawing-engine/src/components/canvas/hvac/HvacPlanRenderer.ts`, 4163 lines) draws ALL HVAC plan geometry as Fabric objects, including Fabric-native pipe handles (`createPipeVertexHandle` ~line 1295, `createPipeSegmentHandle` ~line 1418). On top of that, a **second** 2D engine — `PipeKonvaInteractionLayer.tsx` (756 lines) — mounts a transparent react-konva `<Stage>` at `z-[9]` (DrawingCanvas ~line 2546) but ONLY when `localStorage.getItem('hvac.pipe.engine')==='konva'` (DrawingCanvas line 765), which is **OFF by default** (verified). So in the shipped build all pipe editing is Fabric; Konva is a dormant, half-finished duplicate covering only `type==='refrigerant-pipe'` (filter line 190-197), skipping endpoints (line 700), pipe-pairs and branch kits.

This dual-engine split is the structural root of the user's symptoms:

- **(b) connection distortions / misalignment.** Two **independent coordinate-transform implementations** that are algebraically equal *today* but hand-synced: Fabric sets `viewportTransform` `[vz,0,0,vz,-pan.x*vz,-pan.y*vz]` (`useRendererSync.ts` line 321-329) where `viewportZoom = zoom * safePaperPerRealRatio` (DrawingCanvas line 570); Konva builds its own `<Layer x={stageOffsetX} y={stageOffsetY} scaleX/Y={viewportZoom}>` inline (`PipeKonvaInteractionLayer.tsx` line 575-596) and the Konva layer does **not** fold in `safePaperPerRealRatio` explicitly the way Fabric does. The canonical module that was meant to fix this — `coordinateTransform.ts` (`worldToScreen`/`screenToWorld`/`worldTo3D`, 73 lines, round-trip pinned by `coordinateTransform.test.ts`) — **is imported by nothing except its own test** (verified by grep). It is dead/aspirational infrastructure; every renderer re-derives `*MM_TO_PX` inline (`MM_TO_PX = 96/25.4`, `scale.ts:9`).

- **(d) editing after assigning pipes is not smooth.** Every drag tick (throttled to `DRAG_APPLY_INTERVAL_MS=10ms`) calls `updateHvacElement(id, {...}, {skipHistory:true})` (`PipeKonvaInteractionLayer.tsx` line 476/552), which in the store (`store/index.ts:3972-4008`) does a full `hvacElements.map`, a per-element `JSON.stringify` equality check (~3995-3997), AND `regenerateElevations({debounce:true})` (~4004). The new array identity then fires `useRendererSync.ts:1010-1014` → `HvacPlanRenderer.syncElements` → `rebuildRefrigerantPipeRenderStateMaps` (~line 4086) which calls `buildRefrigerantPipeVisual` for **every** pipe twice. The Konva layer *also* recomputes `buildRefrigerantPipeVisual` independently each tick (line 461/537), and the `handles` `useMemo` rebuilds mid-drag because the dragged element's identity changes each tick. A single gesture thus fires this whole-document cascade ~100×/sec across **two uncoordinated render loops** (Fabric's rAF-coalesced `requestRenderAll` in `renderScheduler.ts` + react-konva's reconciler), so the handle (Konva) and the pipe body (Fabric) can paint on different frames.

- **(b)/(c) connection geometry reconstructed from rendered pixels.** `HvacPlanRenderer.findNearestRenderedRefrigerantPipeBundleTarget` (line 722-1089) reads back **rendered fabric object centers** via `calcTransformMatrix()` then `/MM_TO_PX` (~line 698,717-718) and re-pairs gas/liquid by heuristics (`directionDot<0.92`, `lateralAlignment>0.35`, spacing `±tolerance`). There are **three** overlapping bundle-pairing implementations with copy-pasted, divergent tolerances (`HvacPlanRenderer` 967-1037; `refrigerantPipeRenderState.ts` 599-643/768-867; `refrigerantPipePairModel.ts` `findNearestRefrigerantPipeBundleTarget`), and the draw tool calls all three and picks by priority (`useRefrigerantPipeTool.ts:512-554`). Connections therefore depend on which heuristic wins and on float round-trips through `MM_TO_PX`.

- **(c) bends don't match between 2D and 3D.** The stored route is **sharp vertices** (`routePoints: Point2D[]`). 2D strokes a sharp polyline with cosmetic `strokeLineJoin:'round'` (`HvacPlanRenderer.ts:1175-1183`) plus a Catmull-Rom wobble for flexible segments (`refrigerantPipePairModel.ts:920-943`); 3D builds a real `QuadraticBezierCurve3` fillet (`pipeJointGeometry.ts:120-180`); and the **one true plan-space fillet** `pipeTopology.filletPolyline` (line 211) is consumed by nobody in 2D. Three different curves for one corner.

- **(a) not user-friendly.** Handles depend on a hidden localStorage flag; edit-time snapping is far weaker than draw-time (edit = grid-snap only, on drag-end only, hard segments only — `PipeKonvaInteractionLayer.tsx:308-311,512-514` vs the rich `useRefrigerantPipeTool.snapPoint` 484-615); there is no insert-vertex, delete-vertex, endpoint re-drag/reconnect, whole-segment move, or bend handle; and `types/grips.ts` (`GripOwnerType = 'wall'|'room'|'furniture'`) excludes pipes entirely.

## 3. Root Causes to Fix

- **Two 2D engines own the same pipe** (Fabric draws it, Konva edits a flag-gated subset) → two coordinate transforms, two hit-test models, two render loops that must be hand-kept in sync.
- **The canonical transform is dead.** `coordinateTransform.ts` is not wired into any live view; each renderer inlines `*MM_TO_PX` and its own pan/zoom math.
- **No single source of truth for derived pipe geometry.** 2D, 3D, and the unused `filletPolyline` each derive corners independently; connections are reconstructed from rendered Fabric pixels, not from the model.
- **The live-edit path is the commit path.** Each drag tick writes the whole element to the store and triggers a full-document re-sync + elevation regen; there is no cheap ephemeral preview.
- **No real tool/command architecture.** Drawing and editing logic is entangled with the render engine (Fabric tool hooks + Konva drag handlers), so there is no engine-agnostic, testable core and no clean undo boundary.

## 4. Target Design

### 4.1 Engine ownership (the decisive call)
- **Fabric stays the static document backdrop** (walls, rooms, dimensions, sections, objects, equipment shells). It **stops owning pipe interaction**: delete the Fabric-native pipe vertex/segment handles from `HvacPlanRenderer` and the rendered-pixel bundle finder.
- **Konva becomes the SINGLE owner of the entire pipe interaction layer** — drawing preview, edit grips, live ghost, snapping markers, and the rendered pipe body *during an active edit/draw gesture* — for `refrigerant-pipe`, `refrigerant-pipe-pair`, AND branch kits. Remove the `localStorage` gate; the Konva layer is always the pipe interaction surface.
- Fabric continues to render the *committed, idle* pipe body (cheap static stroke) so the document export/print path is unchanged; Konva owns the body only while a pipe is selected/being-edited (a "checked-out for edit" handoff). This avoids a full Fabric-out rewrite while removing the dual-ownership-of-the-same-live-pixels problem.

> Rationale vs alternatives: Konva's node-based dragging/hit-testing is the right tool for parametric polyline editing (the Fabric code visibly fights its whole-object transform model by stamping dozens of annotated non-selectable handles). A full migration of *all* HVAC into Konva is too large for T1; deleting Konva and keeping Fabric was the other defensible option but loses the better editing primitives. The chosen middle path makes Konva authoritative for interaction while leaving Fabric's document responsibilities untouched. An SVG+d3-drag overlay is a viable *end state* (few grips, free hover/cursor UX, single CSS transform) and the renderer-agnostic core below keeps that door open — but for T1 we consolidate on Konva, which is already partially built.

### 4.2 Single transform (make `coordinateTransform.ts` load-bearing)
Route ALL un-projection and projection through `coordinateTransform.ts`:
- Build one `ViewTransform2D { zoom, panPx }` per frame from the existing `viewportZoom`/`panOffset` and pass it to both engines.
- Fabric viewport matrix is derived from that same transform (extend `viewTransform.ts:buildViewportTransform` to consume it).
- Konva `<Layer>` x/y/scale come from the same transform (delete the inline math at `PipeKonvaInteractionLayer.tsx:575-596`).
- Pointer→world goes through `screenToWorld` everywhere (replace `canvas.getScenePoint(e)/MM_TO_PX` in the Fabric tool and `node.x()/MM_TO_PX` in Konva).
- 3D mesh builder maps plan points through `worldTo3D` (replace raw `new THREE.Vector3(p.x, p.y, baseZ)` in `buildHvacElementMesh.ts` ~554/599/642). This is a no-op numerically today but makes the convention single-sourced.

### 4.3 Headless `pipeCenterline` module (single source of derived geometry)
Create `packages/drawing-engine/src/components/canvas/hvac/pipeCenterline.ts` — **pure, no fabric/konva/three imports**, backed by `@flatten-js/core`:
- Input: `routePoints: Point2D[]`, per-corner `bendRadiusMm` (one formula, driven by `pipeRoutingSettings.bendRadiusFactor` which is currently ignored), and per-segment material.
- Core primitive `arcFilletCorner(prev, corner, next, r)`: half-angle `θ = angleBetween(-u, v)/2`; setback `d = r/tan(θ)` clamped to `min(r, |inLeg|/2, |outLeg|/2)`; center on interior bisector at `r/sin(θ)`; tangent points at `corner ± d·dir`. Returns an ordered list of `{type:'line'|'arc', ...}` segments (an **arc-spline**, the canonical MEP bend = constant-radius elbow tangent to two legs, G1).
- Output adapters: `toSvgPathData()` (SVG `A` arc commands for Fabric `fabric.Path` / Konva `Konva.Path`), `toPolyline(tolMm)` (adaptive sampling for hit-testing), and `toCurvePath3D()` (consumed by `pipeJointGeometry.ts` so 3D sweeps the SAME arc instead of a quadratic bezier).
- This module replaces `strokeLineJoin:'round'` cosmetic rounding in 2D and the unused `filletPolyline`. **Round corners exactly once** (here), never twice.

> Rationale: arc-spline, not Bezier/Catmull-Rom — a pipe bend is a constant-radius elbow whose radius must be pinnable to the spec; cubic/Catmull curvature wanders and cannot honor min bend radius. `@flatten-js/core` is the headless mm-space kernel (chosen over verb-nurbs = overkill/stale, paper.js = a competing scene graph). Pick ONE geometry kernel.

### 4.4 Connection geometry from the model, never from pixels
Add `packages/drawing-engine/src/components/canvas/hvac/pipeConnections.ts`: ONE `findNearestBundleTarget(world, scene)` computed from `routePoints + spec` only. Collapse the THREE duplicated bundle-pairing implementations into this single function with ONE set of tolerances. Delete `HvacPlanRenderer.findNearestRenderedRefrigerantPipeBundleTarget` (722-1089) and the `calcTransformMatrix` readback. The draw/edit tools call this one function.

### 4.5 Smart drawing-tool architecture
Create a **renderer-agnostic interaction core** `packages/drawing-engine/src/components/canvas/hvac/pipeInteractionCore.ts` (pure functions, no engine imports). Move the pure logic currently embedded in `PipeKonvaInteractionLayer.tsx` (`classifyHardDirection`, `intersectLines`, `snapToGrid`, the parallel-offset solver) and the rich snap logic from `useRefrigerantPipeTool.snapPoint` into it. It exposes:
- A **tool state machine** `PipeToolState` (discriminated union): `Idle → Drawing(points[], cursor) → AwaitingClose/Commit`; and `Selected(id) → DraggingVertex(i)/DraggingSegment(i)/DraggingEndpoint(end) → Commit`. Transitions are pure `(state, event) → state`.
- `applyDrag(state, pointerWorld, modifiers) → { nextRoutePoints, snapResult }` — returns next geometry + a snap descriptor (port/centerline/endpoint/grid/45°). Modifiers: Shift = ortho/45 lock, Alt = freehand override.
- A **command/undo boundary**: drawing/editing produces `PipeCommand` objects (`AddPipe`, `MoveVertex`, `InsertVertex`, `DeleteVertex`, `MoveSegment`, `ReconnectEndpoint`) committed once at gesture end through `updateHvacElement`/`addHvacElements` + a single `saveToHistory(label)`. Intermediate ticks NEVER touch the store.

### 4.6 Live preview decoupled from commit
During a drag, the Konva layer draws a **cheap ghost** (the candidate arc-spline from `pipeCenterline.toSvgPathData()`) in its own stage and updates a **transient ref / ephemeral zustand slice** — NOT `hvacElements`. `buildRefrigerantPipeVisual`, `updateHvacElement`, `regenerateElevations`, and `HvacPlanRenderer.syncElements` run exactly once, on `dragEnd` (or rAF-coalesced). `regenerateElevations` is removed from the `skipHistory` drag path entirely.

## 5. Libraries & Dependencies

- **ADD `@flatten-js/core`** (`pnpm --filter @provacx/drawing-engine add @flatten-js/core`) — headless mm-space 2D kernel for the centerline + snapping module. Zero-dep, TS-native, tree-shakeable, tiny next to three.
- **KEEP `fabric ^6`** — static document backdrop only. (v7 is a low-friction bump but explicitly out of T1 scope.)
- **KEEP `konva ^9.3` + `react-konva ^18.2`** — promoted to sole pipe interaction owner. Continue importing from `react-konva/lib/ReactKonvaCore` with manual shape registration; dynamic import, SSR off.
- **KEEP `zustand ^4.5`** — add a transient drag channel; do not abuse `hvacElements` for live drags.
- **KEEP `@turf/turf ^7.3`** — already present (and pulls `rbush`); use for nearest-point where convenient, prefer `@flatten-js` for arc math. Not on per-frame hot loops without caching.
- **KEEP `three ^0.183`** — only the `worldTo3D` wiring and consuming `toCurvePath3D()` belong to T1; geometry fixes are deferred.
- **DO NOT ADD** `pixi.js`, `paper`, `verb-nurbs`. **QUARANTINE** `utils/spline.ts` away from the pipe path (candidate for later removal).
- **Version concern**: `@flatten-js/core` must be added to `packages/drawing-engine/package.json` and `pnpm-lock.yaml` regenerated. Confirm it bundles cleanly under Next.js 14 (pure ESM, no DOM dep — should be fine client+server).

## 6. Implementation Steps

Work on branch `feat/hvac-2d3d-precision` (do NOT branch off main; create a sub-branch off the feature branch if the team prefers). Ordered, granular:

1. **Add dependency.** `pnpm --filter @provacx/drawing-engine add @flatten-js/core`; verify lockfile updates. Add a smoke import in a vitest.
2. **Promote the canonical transform.** In `coordinateTransform.ts` confirm `ViewTransform2D`/`worldToScreen`/`screenToWorld`/`worldTo3D` cover all needs (add `viewportPanToScreenPan` helper if the paper/real ratio needs folding). Build a single `useViewTransform()` selector in `useRendererSync.ts` that produces one `ViewTransform2D` from `viewportZoom`+`panOffset`.
3. **Wire Fabric to the transform.** Refactor `viewTransform.ts:buildViewportTransform` and `useRendererSync.ts:321-329` to derive the Fabric matrix from `ViewTransform2D`. No behavior change; pin with a test.
4. **Create `pipeCenterline.ts`** (§4.3) with `arcFilletCorner`, `toSvgPathData`, `toPolyline`, `toCurvePath3D`. Unit-test the fillet math (tangency, radius clamp, overlapping-fillet relaxation).
5. **Create `pipeConnections.ts`** (§4.4): one `findNearestBundleTarget` from the model. Port the *best* of the three existing heuristics; one tolerance set.
6. **Create `pipeInteractionCore.ts`** (§4.5): move pure logic out of `PipeKonvaInteractionLayer.tsx` + `useRefrigerantPipeTool.ts`; implement `PipeToolState`, `applyDrag`, and `PipeCommand` types. No engine imports.
7. **Add the transient drag channel** in the store (new ephemeral slice `pipeDragPreview` or a ref in the interaction layer). Add a `commitPipeCommand(cmd)` store action that performs the one-shot `updateHvacElement`/`addHvacElements` + single `saveToHistory`. Ensure `regenerateElevations` runs only inside commit, never on `skipHistory`.
8. **Rebuild `PipeKonvaInteractionLayer.tsx`** to: consume `ViewTransform2D` (delete inline transform 575-596), render the ghost from `pipeCenterline.toSvgPathData()` during drag, cover all three pipe types + endpoints + insert/delete-vertex + segment move + reconnect, and commit via `commitPipeCommand` on `dragEnd` only. Drive all geometry through `pipeInteractionCore`.
9. **Remove the localStorage gate** (DrawingCanvas line 760-769,779-782): Konva is always the pipe interaction layer (still `!projectionViewOnly`). Update `useRendererSync.ts:1016-1034` so Fabric never draws pipe handles.
10. **Strip Fabric pipe interaction.** Delete `createPipeVertexHandle`/`createPipeSegmentHandle` and `findNearestRenderedRefrigerantPipeBundleTarget` (722-1089) from `HvacPlanRenderer.ts`. Keep the static idle pipe body stroke, but have it consume `pipeCenterline.toSvgPathData()` via `fabric.Path` instead of `fabric.Polyline` + round-join.
11. **Point 2D rendering at the centerline.** `HvacPlanRenderer.renderPipePolyline` (~1163-1183) → use `fabric.Path` from `pipeCenterline`.
12. **Point 3D at the same centerline.** `pipeJointGeometry.ts:buildTubeCurve` consumes `pipeCenterline.toCurvePath3D()`; `buildHvacElementMesh.ts` maps through `worldTo3D`. (Full 3D arc/frame fix is deferred to the 3D task — T1 only establishes the shared input.)
13. **Migrate the draw tool** `useRefrigerantPipeTool.ts` snap/route/commit to call `pipeConnections.findNearestBundleTarget` + `pipeInteractionCore` + `commitPipeCommand`.
14. **Extend `types/grips.ts`** `GripOwnerType` to include `'pipe'` (or document that pipe grips live in the Konva interaction core; pick one and be consistent).
15. **Run** `pnpm --filter @provacx/drawing-engine test` and the typecheck; fix round-trip + fillet tests; manual-verify in the app.

## 7. Data Model / Type Changes

Keep the stored route in `routePoints` (world-mm) as the persisted source of truth — do NOT add a parallel persisted geometry. Add **derived** + **interaction** types:

```ts
// coordinateTransform.ts (already present — make it the only transform)
export interface ViewTransform2D { zoom: number; panPx: Point2D }

// pipeCenterline.ts (NEW — pure, derived, never persisted)
export type CenterlineSegment =
  | { type: 'line'; a: Point2D; b: Point2D }
  | { type: 'arc'; center: Point2D; radius: number; startAngle: number; endAngle: number; cw: boolean };
export interface PipeCenterline { segments: CenterlineSegment[] }
export function buildPipeCenterline(routePoints: Point2D[], bendRadiusMm: number | number[]): PipeCenterline;
export function toSvgPathData(c: PipeCenterline): string;
export function toPolyline(c: PipeCenterline, tolMm: number): Point2D[];
export function toCurvePath3D(c: PipeCenterline, elevationZMm: number): import('three').CurvePath<import('three').Vector3>;

// pipeInteractionCore.ts (NEW — pure, framework-free)
export type PipeToolState =
  | { kind: 'idle' }
  | { kind: 'drawing'; points: Point2D[]; cursor: Point2D | null }
  | { kind: 'selected'; elementId: string }
  | { kind: 'draggingVertex'; elementId: string; index: number }
  | { kind: 'draggingSegment'; elementId: string; index: number }
  | { kind: 'draggingEndpoint'; elementId: string; end: 'start' | 'end' };

export interface DragModifiers { ortho: boolean; free: boolean } // Shift / Alt
export type SnapKind = 'none' | 'grid' | 'port' | 'centerline' | 'endpoint' | 'angle45';
export interface SnapResult { point: Point2D; kind: SnapKind; targetId?: string }
export function applyDrag(
  state: PipeToolState, pointerWorld: Point2D, mods: DragModifiers, scene: SceneQuery,
): { nextRoutePoints: Point2D[]; snap: SnapResult };

export type PipeCommand =
  | { type: 'AddPipe'; route: Point2D[]; spec: unknown }
  | { type: 'MoveVertex'; elementId: string; index: number; to: Point2D }
  | { type: 'InsertVertex'; elementId: string; afterIndex: number; at: Point2D }
  | { type: 'DeleteVertex'; elementId: string; index: number }
  | { type: 'MoveSegment'; elementId: string; index: number; deltaNormalMm: number }
  | { type: 'ReconnectEndpoint'; elementId: string; end: 'start' | 'end'; target: SnapResult };
```

> Note: promoting `routePoints` out of the untyped `properties: Record<string,unknown>` bag into a typed field, and making resolution idempotent (stop healing/translating on every read), are addressed in the persistence/state task — see §12. T1 must **not** regress that; keep reads pure where it touches them.

## 8. UX & Interaction Requirements

- **Smoothness:** dragging a vertex/segment/endpoint updates the ghost at ≥60fps with zero store writes until release. No frame where the handle is off the rendered body.
- **Live preview ghost:** a translucent arc-spline preview follows the cursor while drawing/editing; commits crisply on release.
- **Snapping feedback:** a visible snap indicator (distinct marker per `SnapKind`) appears when the cursor is within tolerance of a port/centerline/endpoint/grid/45°-lock. Edit-time snapping must be as rich as draw-time (port + centerline + ortho/45 + live grid) — not grid-only-on-release.
- **Affordances:** every route vertex (including endpoints) is draggable; double-click a segment inserts a vertex; Del/right-click deletes a vertex; dragging an endpoint near a unit port / branch kit re-binds the connection (`ReconnectEndpoint`) instead of drifting; Shift = ortho/45 lock, Alt = freehand.
- **Inline readout:** segment length + bend angle label follows the active grip during drag (reuse `formatting.ts` mm formatting).
- **Zoom-stable hit targets:** handle radii / snap thresholds are computed from the live `ViewTransform2D` each frame (screen-px constant), not baked into geometry at build time.
- **One consistent handle set** regardless of any flag.

## 9. Acceptance Criteria

- [ ] `coordinateTransform.ts` is imported by Fabric sync, the Konva layer, and the 3D mapping (grep shows non-test importers). No renderer contains an inline `*MM_TO_PX` pan/zoom transform for pipes.
- [ ] Konva is the sole pipe interaction layer; the `hvac.pipe.engine` localStorage gate is removed; Fabric draws no pipe handles. `PipeKonvaInteractionLayer` covers `refrigerant-pipe`, `refrigerant-pipe-pair`, and branch kits, including draggable endpoints.
- [ ] A pipe drag produces exactly **one** `saveToHistory` entry and **zero** `hvacElements`/`regenerateElevations` writes until `dragEnd` (assert via store spy / counter).
- [ ] Pipe bends are arc-spline (line+arc) derived from `pipeCenterline.ts`; 2D (`fabric.Path`), the Konva ghost, and 3D (`toCurvePath3D`) all consume the same centerline — no `strokeLineJoin:'round'` cosmetic rounding, no quadratic-bezier-in-2D mismatch.
- [ ] Exactly one bundle-connection finder (`pipeConnections.findNearestBundleTarget`) computed from the model; `findNearestRenderedRefrigerantPipeBundleTarget` and the `calcTransformMatrix` pixel readback are deleted.
- [ ] Handles sit exactly on the rendered pipe at zoom ∈ {0.25, 1, 4} and with a non-1 paper/real ratio (visual check).
- [ ] `@flatten-js/core` added to `packages/drawing-engine/package.json` + lockfile; app builds under Next.js 14.
- [ ] Full vitest suite green, including the existing `coordinateTransform.test.ts` round-trip (still passing, now guarding live code).

## 10. Test Plan

**Unit (vitest — the repo's test runner; e.g. `pipeJointGeometry.test.ts`, `coordinateTransform.test.ts` already exist):**
- `pipeCenterline.test.ts`: arc fillet tangency (tangent points lie on both legs; arc is tangent), radius clamp to `min(r,|in|/2,|out|/2)`, overlapping-fillet relaxation, degenerate (collinear / zero-length) corners, round-trip `routePoints → centerline → toPolyline` close to source within tolerance.
- `pipeInteractionCore.test.ts`: state-machine transitions are pure; `applyDrag` ortho/45 lock; insert/delete-vertex keep segment-material identity intact; `PipeCommand` round-trip.
- `pipeConnections.test.ts`: model-based bundle pairing matches expected gas/liquid for representative scenes; idempotent (same input → same output).
- `coordinateTransform` consumers: a test asserting Fabric matrix and Konva layer transform are both derived from one `ViewTransform2D` and agree to 6 decimals across zoom/pan views (extend the existing round-trip test).
- Store-thrash guard: spy on `updateHvacElement`/`saveToHistory`/`regenerateElevations`; simulate a 20-tick drag; assert 0 commits mid-drag, 1 on end.

**Visual / manual:**
- Use the `/verify` skill (or `/run`) to launch the Next.js app, draw a multi-bend refrigerant pair, branch-kit onto an existing run, then edit vertices/endpoints. Confirm smoothness, snapping markers, and that handles track the body at multiple zooms.
- Use **Claude Preview** MCP (`preview_start`/`preview_screenshot`/`preview_eval`) to screenshot the plan canvas at zoom 0.25/1/4 and diff handle-vs-body alignment.
- Use the **three.js MCP** (`show_threejs_scene`) to confirm 3D bends now match the 2D arc-spline (same corner radii).
- `/code-review` the diff at `high` before opening the PR.

## 11. Edge Cases & Pitfalls

**Edge cases:** vertical risers (first tangent parallel to default up — relevant once 3D consumes the centerline; seed a stable reference axis later in the 3D task); very short legs where the fillet setback would overrun a neighbor (auto-relax radius); 180°/near-collinear corners (no fillet); non-1 paper/real ratio (the historical Konva drift source — must now be single-sourced); pipe-pair where gas/liquid spacing differs from unit-port spacing (do not paper over with synthetic field points in T1 — that's the connection task); branch-kit overlay-vs-real-tee (leave topology default as-is for T1, just route its connection geometry through the shared centerline).

**Do NOT:**
- Do NOT keep two render libraries fighting over the same live pipe pixels. Konva owns interaction; Fabric owns the document.
- Do NOT recompute the whole route / call `buildRefrigerantPipeVisual` / write `hvacElements` / run `regenerateElevations` on every drag frame. Ghost during drag, commit on release.
- Do NOT reconstruct connection geometry from rendered Fabric object matrices / `MM_TO_PX` round-trips. Compute from the model.
- Do NOT round corners twice (2D round-join + 3D bezier). Round once in `pipeCenterline`.
- Do NOT add a third/fourth renderer (Pixi, Paper) or route pipe geometry through `utils/spline.ts` NURBS.
- Do NOT inline a second coordinate transform anywhere; everything goes through `coordinateTransform.ts`.
- Do NOT regress idempotent reads (no healing/translating route points on render — keep that boundary clean for the persistence task).
- Do NOT leave the `hvac.pipe.engine` flag as a hidden toggle.

## 12. Dependencies on Other Tasks

- **T1 is foundational** — the headless `pipeCenterline.ts`, `pipeConnections.ts`, `pipeInteractionCore.ts`, the load-bearing `coordinateTransform.ts`, and the live-preview/command architecture are consumed by the downstream tasks. Build these interfaces stable.
- **Pipe data-model / segment+node model task** (positional `segmentMaterials` → stable-id segments + explicit corner nodes; promote `routePoints` out of the untyped `properties` bag; idempotent resolution / stop healing-on-read): T1 defines `PipeCommand`/`PipeToolState` to be ready for stable segment identity but does not itself rewrite the persisted model — coordinate the `RouteCornerNode` shape with that task.
- **3D geometry task** (true constant-radius arcs / rotation-minimizing frames, scoping CSG to tees, geometry caching, removing the legacy `IsometricViewCanvas.createTubeAlongPoints`): consumes `pipeCenterline.toCurvePath3D()` from T1.
- **Branch-kit / connection task** (parametric tee, unified gas/liquid spacing, real-tee default): consumes `pipeConnections.findNearestBundleTarget` and the shared centerline.
- **Auto-routing / clash task** (rbush broad-phase, optional grid-A* assist, libavoid behind a flag): builds on the renderer-agnostic interaction core and the model-based connection finder.

Reference these by their assigned T# IDs in the PR description when they exist.