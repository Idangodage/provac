## Objective

Make "connect a new pipe into an existing pipe run" (a **tap-in / merge**) a first-class, robust operation in the refrigerant HVAC engine. When the user routes a new pipe (or a branch drop) so its start/end lands on an existing refrigerant run, the engine must: (1) project the tap point onto the existing run's centerline, (2) **split that run at the tap station into two flow-connected halves** sharing a tee node, (3) auto-insert the correct fitting (tee/saddle, with a reducer when diameters differ), (4) rewrite topology so the network is genuinely connected through the fitting (not a cosmetic overlay on an intact run), and (5) blend the junction so it is **distortion-free and identical in 2D plan and 3D**. The end state: tap-in is the default behavior, `enableRealTeeTopology` is on by default, the junction is a real parametric tee with a true line+arc fillet, and all connection geometry is computed from the **model** (route points + spec) — never reconstructed from rendered Fabric pixels.

The primitives for this already exist on the branch (`splitPolylineAtStation`, `buildTeeRunHalves`, `buildBranchKitInsertion`) but are gated off and bypassed; T6 promotes, hardens, generalizes, and de-distorts them.

## Current State & Why It Hurts

The tap-in machinery is **built but dormant and overlay-faked by default**:

- `buildBranchKitInsertion` (`packages/drawing-engine/src/components/canvas/hvac/branchKitProposal.ts:849`) returns `removeElementIds = []` and **overlays** the kit on the *intact* run unless `getActivePipeRoutingSettings().enableRealTeeTopology` is true (`branchKitProposal.ts:967-994`). The default is **false** (`pipeRoutingSettings.ts:116`). So by default the "tee" is two unconnected pipes crossing — topology is faked. → user symptom (b) distortion, (d) editing not smooth (edits don't propagate through the joint).
- The real-split path exists and is correct in isolation: `buildTeeRunHalves` (`branchKitProposal.ts:812`) calls `splitPolylineAtStation` (`pipeTopology.ts:117`) to produce `run-in` / `run-out` halves that share the station vertex and null out the cut-end connection (`branchKitProposal.ts:829,841`). It is even unit-tested (`branchKitProposal.test.ts`, `pipeTopology.test.ts`). But it only fires for branch-KIT insertion, not for a plain pipe tapping into a run, and only when the flag is on.
- **Connection geometry is reconstructed from rendered pixels.** `findNearestRenderedRefrigerantPipeBundleTarget` (`HvacPlanRenderer.ts:722-1089`) reads back Fabric object centers via `calcTransformMatrix()` then `/MM_TO_PX` and re-pairs gas/liquid by heuristics (directionDot, lateralAlignment, expectedSpacing tolerances at ~`HvacPlanRenderer.ts:980-1037`). There are **three** overlapping bundle-finders with divergent tolerances: `HvacPlanRenderer.findNearestRenderedRefrigerantPipeBundleTarget`, `refrigerantPipeRenderState.findNearestVisibleRefrigerantPipeBundleSegmentTarget` (`refrigerantPipeRenderState.ts:585-984`), and `refrigerantPipePairModel.findNearestRefrigerantPipeBundleSegmentTarget` (`refrigerantPipePairModel.ts:4382/4474`). The pipe tool tries all three and picks by priority (`useRefrigerantPipeTool.ts:484-615`). Different engines disagree about the same tap point → symptom (b) connection distortions, (c) non-smooth branch.
- **The junction is not blended.** The connecting route is a hand-built orthogonal L/Z (`buildOrthogonalConnectionRoute`, `branchKitProposal.ts:872`) meeting the run at a sharp overlay; the branch-outlet direction is forced `{x:1,y:0}` while the copper physically departs at an angle (`refrigerantBranchKitModel.ts:1049`). 2D strokes a `strokeLineJoin:'round'` polyline (`HvacPlanRenderer.ts:1175-1183`) — cosmetic, not a fillet — while 3D builds a `QuadraticBezierCurve3` fillet (`pipeJointGeometry.ts:120-180,205-221`). `pipeTopology.filletPolyline` (`pipeTopology.ts:211`, the only true plan-space arc fillet) is **never consumed by 2D**. So the same tee renders three different curves → symptom (c).
- **Stale snap metadata makes the tap drift.** `resolveInlineBranchKitCenter` (`refrigerantPipePairModel.ts:1576-1666`) re-projects the kit from stored `branchKitSnap*` metadata, not the live run; a hard 1mm `MAX_INLINE_ANCHOR_LOCAL_DRIFT_MM` cliff (`refrigerantPipePairModel.ts:1633`) makes the tee **jump** when a diameter is edited. → symptom (d).
- **Spacing mismatch at the joint.** Unit ports use fixed 42mm spacing (`unitPipePortModel.ts:149`); kit outlets use 94/87mm (`refrigerantBranchKitModel.ts:1200-1213`); the pair builder computes its own. `buildUnitPortBundleConnection` fabricates synthetic field spacing to paper over it (`refrigerantPipePairModel.ts:1339-1402`). The gas/liquid pair splays/converges at the tap → symptom (b).

## Root Causes to Fix

- Tap-in defaults to a **cosmetic overlay** instead of a real topological split (`enableRealTeeTopology:false`, `removeElementIds:[]`).
- Plain pipe-into-run tap-in (not just branch-kit) has **no split path at all** — only branch-kit insertion can split.
- Connection point is **reconstructed from rendered Fabric matrices**, not the model; **three duplicated bundle-finders** with divergent tolerances disagree.
- The junction curve is derived **independently** in 2D (round stroke-join), 3D (quadratic bezier), and the unused `filletPolyline` — no single fillet source of truth.
- Tee placement re-projects **stale stored snap metadata** with a 1mm drift cliff instead of healing against the live run.
- Branch-outlet **direction lies** about its true departure tangent; the connecting route meets the run at a sharp right angle.
- Per-mouse-move recompute + full `syncElements` rebuild makes the live tap preview heavy (`useRendererSync.ts:1010-1014`, `HvacPlanRenderer.ts:4086`).

## Target Design

### Data model: explicit tee node + stable split
Introduce a first-class **tee junction** record stored on the spawned half-runs and the fitting, keyed by a shared `teeId` (already emitted at `branchKitProposal.ts:969`). Each tap-in produces, atomically:
- `run-in` half: `routePoints = split.before`, `endConnection = teeNode` (was `null`; make it a real connection to the tee, not just nulled).
- `run-out` half: `routePoints = split.after`, `startConnection = teeNode`.
- the **branch/connecting** pipe whose run-end connection is the same `teeNode`.
- a **fitting element** (tee, or reducing-tee when run OD ≠ branch OD) positioned at `split.station`, with `branchKitPlacementMode:'fixed'` and `teeId`.

The split station comes from `splitPolylineAtStation(readRoutePoints(run), tapStation)` (`pipeTopology.ts:117`) which already projects onto the nearest leg and refuses endpoint splits — reuse it verbatim.

### Algorithm: tap-in pipeline (headless, renderer-agnostic)
Create `pipeTapIn.ts` as the single source of truth:
1. **Find target run + station.** Index existing run segments in an `rbush` tree (bbox of each leg + insulation envelope). Query near the tap point, then for each candidate compute the exact nearest point on the leg via `@flatten-js/core` `Segment.distanceTo(Point)`. Rank by **screen-space** distance (convert a fixed pixel tolerance through current zoom, as `useRefrigerantPipeTool.ts:489-490` does). This **replaces** the three rendered-pixel bundle-finders for tap targeting.
2. **Split** with `splitPolylineAtStation`.
3. **Build the junction fillet** with the line+arc primitive (see below) at the tee so the branch tangentially blends into the trunk — one filleted centerline shared by 2D and 3D.
4. **Emit elements** (run-in, run-out, branch, fitting) + `removeElementIds=[originalRun.id]`. This is the same shape `BranchKitInsertion` returns (`branchKitProposal.ts:996`), generalized to plain pipes.
5. **Reducer**: when `runOuterDiameterMm !== branchOuterDiameterMm`, mark the fitting `reducing:true` and carry both diameters so 3D inserts a `CylinderGeometry(r1,r2)` reducer into the union.

### Smooth junction: true line+arc fillet (the one curve)
Replace the divergent corner curves with **one** arc-fillet definition, computed once in plan space and consumed by every view:
- Use `filletPolyline` (`pipeTopology.ts:211`) — or a focused `pipeFillet.ts` built on `@flatten-js/core` `Arc` — as the canonical fillet. Bend radius from `bendRadiusFromDiameterMm(diameterMm, settings.bendRadiusFactor)` (`pipeTopology.ts:183`); **wire `bendRadiusFactor` in** (currently "reserved/not consumed", `pipeRoutingSettings.ts:42-43`).
- **2D**: feed the filleted (line+arc) centerline to Fabric as a `fabric.Path` with `A` arc commands (or Konva `arcTo`/`Konva.Path`), not a `strokeLineJoin:'round'` polyline. No tessellation.
- **3D**: in `buildTubeCurve` (`pipeJointGeometry.ts:120`) replace the `QuadraticBezierCurve3` corner with a true circular `ArcCurve`/cubic-kappa (0.5523·r) handle so the swept radius equals the real bend radius and matches 2D by construction. Stop double-rounding (round in 2D model OR 3D, not both — drive 3D from the already-filleted plan centerline).

### Make placement heal against the live run
Replace `resolveInlineBranchKitCenter`'s stale-metadata re-projection (`refrigerantPipePairModel.ts:1576`) on the tap path: with **real tee topology** the fitting connects to the live `teeNode` shared by the half-runs, so it follows the run when the run is edited. Drop/relax the 1mm anchor-drift cliff (`refrigerantPipePairModel.ts:1633`) for tee-mode kits.

### Why this approach (vs alternatives)
- **Line+arc fillet over Bezier/Catmull/NURBS**: a pipe elbow is physically a constant-radius arc tangent to two legs (G1). Bezier corners (current 3D) cannot pin the radius to the bend radius and disagree with 2D — the exact "2D and 3D don't match" defect. Verb-nurbs/paper.js are heavier/staler and add a renderer.
- **Real split over overlay**: an overlay tee is two crossing pipes; editing one leg cannot propagate through a non-existent joint. A genuine `run-in`/`run-out` split connected via `teeNode` is the only topology that survives edits.
- **Model-derived connection over pixel readback**: `calcTransformMatrix()/MM_TO_PX` round-trips and heuristic re-pairing are the prime suspect for (b). Compute from `routePoints` + spec only.
- **rbush over O(n·m) scans**: already transitively installed; broad-phase makes tap targeting scale without changing results.

## Libraries & Dependencies

**Add**
- `@flatten-js/core` — headless mm-space geometry kernel for nearest-point-on-run, split-station projection, and the line+arc fillet. Pure TS, zero-dep, tree-shakeable. ~40 lines on top to express the fillet (it has `Arc`/`Segment`/`Circle` but no one-call `fillet()`).
- `rbush` — dynamic R-tree for tap-target broad phase. Already transitively present via `@turf/turf`; add as a direct dep so the pure-geometry module imports it cleanly.

**Keep**
- `@turf/turf` — `nearestPointOnLine`/`pointToLineDistance` for snap ranking only; never in uncached per-frame loops.
- `three-bvh-csg ^0.0.18` — **scope to the tee/saddle union only**; memoize by tee signature; treat the merge fallback as an error. Note: 0.0.x is version-coupled to three internals — pin and add a regression test on the union output.
- `three-mesh-bvh ^0.9` — wire up `computeBoundsTree` + `shapecast` for a **post-build** 3D clash check of the new tee vs neighbours (not for overlap-by-CSG).
- `konva`/`react-konva` — single interaction engine for the live tap ghost.

**Remove / do NOT add**
- `elkjs`, `dagre` (graph-layout — would relocate fixed CAD geometry), `pixi.js`, `paper.js` (4th renderer), `verb-nurbs` (wrong curve model). None belong in tap-in.

## Implementation Steps

1. **Flip the default.** Set `enableRealTeeTopology: true` in `pipeRoutingSettings.ts:116`. Verify the W3b branch-kit path still passes `branchKitProposal.test.ts`.
2. **Add deps.** `pnpm --filter @provacx/drawing-engine add @flatten-js/core rbush` (confirm package name in `packages/drawing-engine/package.json`). Add `@types/rbush` if needed.
3. **Create `packages/drawing-engine/src/components/canvas/hvac/pipeTapIn.ts`** (pure, no Fabric/Konva/three imports):
   - `findTapTarget(tapPoint, runElements, pixelToleranceMm): TapTarget | null` — rbush broad phase + `@flatten-js/core` exact nearest point; returns `{ runId, station, leg, runDirection, runOuterDiameterMm, gas/liquid spec }`.
   - `buildTapInInsertion(tapTarget, newPipeSpec, sceneElements): BranchKitInsertion` — reuse `splitPolylineAtStation` + a generalized `buildTeeRunHalves` (make the cut end a real `teeNode` connection, not `null`); emit run-in/run-out/branch/fitting + `removeElementIds=[runId]`.
4. **Generalize `buildTeeRunHalves`** (`branchKitProposal.ts:812`): replace `endConnection:null`/`startConnection:null` (`:829,:841`) with a shared `teeNode: RefrigerantPipeConnection` so halves are flow-connected, not merely cut.
5. **Create `packages/drawing-engine/src/components/canvas/hvac/pipeFillet.ts`** (or extend `filletPolyline`): canonical line+arc fillet from `prev/corner/next + radius`, radius via `bendRadiusFromDiameterMm(d, settings.bendRadiusFactor)`. Export a `FilletedCenterline` (ordered `line|arc` segments) + a `toSvgArcPath()` helper.
6. **Wire `bendRadiusFactor`** through `pipeRoutingSettings.ts` into the fillet (it is documented unused at `:42-43`); thread settings as an argument, not the module singleton, where the tap path touches it.
7. **2D render the fillet as arcs.** In `HvacPlanRenderer.renderPipePolyline` (`HvacPlanRenderer.ts:1163-1183`) consume the `FilletedCenterline` and emit `fabric.Path` `A` commands at corners/junction instead of `fabric.Polyline` + `strokeLineJoin:'round'`.
8. **3D arc corner.** In `pipeJointGeometry.buildTubeCurve` (`:120-180`) replace `QuadraticBezierCurve3` with a true arc (ArcCurve / cubic-kappa) sampled from the same plan fillet; make `buildSweptTubeGeometry` consume the already-filleted centerline (stop the 2D+3D double-round at `refrigerantPipePairModel.ts:2418`).
9. **Reducer + tee CSG scope.** In `buildHvacElementMesh.renderLine` (`buildHvacElementMesh.ts:1697-1788`) build the fitting as run-trunk + branch-takeoff (+ reducer cylinder when ODs differ), `three-bvh-csg` union ONLY here, **memoized by tee signature**; fix the branch connection point (`buildHvacElementMesh.ts:1758-1772`) to project onto the actual (possibly rotated) run centerline rather than `{x:branchHead.x, y:runStart.y}`.
10. **Konva live ghost.** In `PipeKonvaInteractionLayer.tsx` / `useRefrigerantPipeTool.ts` snap path, when the cursor is within tolerance of an existing run show a **ghost** of the split + fitting (drawn in the same Konva stage) and a snap indicator; commit `buildTapInInsertion` to the store **only on click** (`addHvacElements` + one `saveToHistory`, `removeElementIds` applied in the same transaction so it is one undo step).
11. **Delete the pixel-readback tap path** for targeting: stop calling `HvacPlanRenderer.findNearestRenderedRefrigerantPipeBundleTarget` (`:722-1089`) from the tool's tap-target resolution; route through `pipeTapIn.findTapTarget`. Collapse the three duplicated finders to the new one (deprecate `refrigerantPipeRenderState` / `refrigerantPipePairModel` segment-target variants for tap targeting).
12. **Heal placement.** For tee-mode, make the fitting follow the live half-runs via `teeNode`; bypass the stale `resolveInlineBranchKitCenter` re-projection (`refrigerantPipePairModel.ts:1576`) and relax the 1mm drift cliff (`:1633`).
13. **3D clash check.** Add a `three-mesh-bvh` `shapecast` verification of the new tee vs neighbours (report only, not in the routing loop).

## Data Model / Type Changes

```ts
// pipeTopology.ts — promote the tee node to a real connection
export interface TeeNode {
  teeId: string;
  station: Point2D;            // split point on the run centerline (mm, world)
  runOuterDiameterMm: number;  // trunk OD at the tap
  branchOuterDiameterMm: number;
  reducing: boolean;           // runOD !== branchOD
  bendRadiusMm: number;        // from bendRadiusFromDiameterMm(d, settings.bendRadiusFactor)
}

// branchKitProposal.ts BranchKitInsertion is reused as the tap-in result shape:
export interface TapInInsertion {
  elementsToAdd: HvacElement[]; // [runIn, runOut, branchPipe, fittingElement]
  removeElementIds: string[];   // [originalRunId]  (NO LONGER [])
  teeId: string;
  fittingElementId: string;
}

// pipeFillet.ts — the one curve both 2D and 3D consume
export type FilletSegment =
  | { type: 'line'; a: Point2D; b: Point2D }
  | { type: 'arc'; center: Point2D; radiusMm: number; startAngle: number; endAngle: number; ccw: boolean };
export interface FilletedCenterline { segments: FilletSegment[]; }

// RefrigerantPipeConnection on the cut ends gains the tee linkage (replaces null):
interface RefrigerantPipeConnection { /* …existing… */ teeNode?: TeeNode; }
```

`splitPolylineAtStation`'s `PolylineSplit` (`pipeTopology.ts:102-109`) is unchanged and reused as-is.

## UX & Interaction Requirements

- **Magnetic tap snap**: when the new pipe's endpoint approaches an existing run within a fixed pixel tolerance, the cursor snaps to the projected station on the run centerline; show a **snap indicator** (a small marker at the station) and a live ghost of the resulting tee + fitting.
- **Live, cheap preview**: the ghost is drawn in the Konva overlay only; the heavy `buildTapInInsertion` + store write happens **on click**, never per mouse-move. No full-plan `syncElements` during hover.
- **Smooth junction**: the branch must blend into the trunk via a visible constant-radius arc — no kink, no overlapping-different-diameter seam. The bend looks identical in plan and 3D.
- **Single undo step**: a tap-in (split + add halves + branch + fitting + remove original) is one history entry.
- **Reducer feedback**: if the branch OD differs from the run OD, the inserted fitting visibly steps the diameter (reducing tee) rather than abutting two diameters.
- **Edit propagation**: dragging the run after a tap moves the half-runs and the fitting follows (because they share `teeNode`); the tap does not detach or jump.

## Acceptance Criteria

- Tapping a new pipe onto an existing run **removes the original run** and adds `run-in` + `run-out` + branch + fitting, all sharing one `teeId` (`removeElementIds` is non-empty).
- The fitting auto-selects tee vs **reducing-tee** based on run vs branch OD.
- The junction centerline is a **line+arc fillet** whose radius equals `bendRadiusFromDiameterMm(d, settings.bendRadiusFactor)` and is **byte-for-byte the same source** for 2D and 3D (no Bezier vs round-join divergence).
- No tap connection geometry is derived from `calcTransformMatrix()`/rendered Fabric centers; `findTapTarget` reads only the model.
- A whole tap-in is **one undo step**; undo restores the original intact run exactly (round-trip identity).
- Editing the run after a tap keeps the fitting attached (no >1mm drift, no jump on diameter change).
- `enableRealTeeTopology` defaults true; existing `branchKitProposal.test.ts` / `pipeTopology.test.ts` still pass.

## Test Plan

- **Unit (vitest)** in `pipeTapIn.test.ts`:
  - `findTapTarget` projects onto the nearest leg and returns the correct station for axis-aligned, 45°, and rotated runs; returns null when the tap lands on an endpoint (mirror `pipeTopology.test.ts:79`).
  - `buildTapInInsertion` yields `[runIn, runOut, branch, fitting]`, `removeElementIds=[runId]`, shared `teeId`, and run-in/run-out share the station vertex (extend `branchKitProposal.test.ts:35-66`).
  - Round-trip: split then "undo" (recombine `before`+`after`) reproduces the original `routePoints` within tolerance.
- **Unit** in `pipeFillet.test.ts`: fillet radius equals bend radius; setback clamped to half the shorter leg; straight/short corners pass through (mirror existing `filletPolyline` coverage in `pipeTopology.test.ts`).
- **3D geometry** in `pipeJointGeometry.test.ts`: corner is a true arc of the requested radius (sample tangents at arc ends are continuous); reducer present when ODs differ; CSG union memoized (second build with same signature returns cached geometry).
- **Manual / visual**: use **Claude Preview** (`preview_start` + `preview_screenshot`) to draw a pipe tapping into an existing run at 1×, 3× zoom and a rotated run; confirm no kink, no diameter seam, snap indicator appears. Use the **three.js MCP** (`show_threejs_scene`) to confirm the 3D tee matches the 2D plan bend. Run `/verify` on the tap-in flow end-to-end.

## Edge Cases & Pitfalls

- **Tap at/near a run endpoint** → `splitPolylineAtStation` returns null (`pipeTopology.ts:152-157`); fall back to a normal endpoint connection, do NOT create a degenerate zero-length half.
- **Tap onto a corner/elbow vertex** → split on the nearest leg, but recompute the fillet for BOTH the trunk corner and the new branch so arcs don't overlap (clamp setback to half the shorter leg).
- **Reducing tee with very different ODs** → ensure the reducer cylinder is unioned, not abutted; the 2D fill/stroke must show the step.
- **Diameter edit after tap** → fitting must not jump (the 1mm `MAX_INLINE_ANCHOR_LOCAL_DRIFT_MM` cliff at `refrigerantPipePairModel.ts:1633` must be relaxed for tee mode).
- **Gas/liquid pair tap** → tap BOTH lines at the same station (paired); never let gas and liquid pick different stations/orientations (the independent-proposal bug at `branchKitProposal.ts:617-630`). Route ONE centerline, then offset the pair.
- **CSG failure** → do not silently fall back to `mergeGeometries` (reintroduces interpenetration, `pipeJointGeometry.ts:394`); surface an error and keep the last good cached union.

**Do NOT:**
- Do NOT keep the overlay-only tee as the default (`removeElementIds:[]`) — it fakes topology.
- Do NOT reconstruct the tap connection from rendered Fabric matrices (`HvacPlanRenderer.ts:684-720,722-1089`).
- Do NOT recompute `buildRefrigerantPipeVisual` / full `syncElements` on every mouse-move during hover — preview is a Konva ghost; commit on click only.
- Do NOT add a 4th render library or a graph-layout engine.
- Do NOT double-round corners (2D `roundPolylineCorners` AND 3D bezier) — one filleted centerline drives both.
- Do NOT run `three-bvh-csg` for plain elbows/continuations — only the genuine tee/saddle, memoized.

## Dependencies on Other Tasks

- **Depends on the smooth-bend/fillet task** (the line+arc `pipeFillet`/`filletPolyline` unification and the 2D-arc-rendering work) — tap-in reuses that single fillet source for the junction. If that task is a separate T# (the "unify corner derivation / swept-elbow 2D wiring" brief), land its `pipeFillet`/`FilletedCenterline` first or co-deliver it.
- **Depends on the interaction-engine consolidation task** (single Konva interaction overlay + cheap live preview / decoupled commit) — tap-in's ghost-preview-then-commit-on-click relies on that being the model.
- **Depends on the connection-spacing-unification task** (one canonical gas/liquid bundle spacing across unit ports, kit outlets, and the pair builder) — the tap junction must use the unified spacing so the pair doesn't splay at the tee.
- **Relates to the 3D pipe-builder unification task** (delete the legacy capped-cylinder `createTubeAlongPoints` in `IsometricViewCanvas.tsx:1761`) — the tee must render through the single swept-tube builder in both 3D paths.
