You are implementing **T4 — Refrigerant branch kit modeling & smooth connection** in the `provacx` repo (Next.js 14 web app `apps/web`, drawing engine in `packages/drawing-engine`). Branch: `feat/hvac-2d3d-precision`. This prompt is self-contained; execute it against the real files cited below.

The goal is to make refrigerant branch kits (tees / headers / Y-joints) **first-class, connectable, parametric fittings with typed ports** whose geometry is correct and **identical in 2D and 3D**, and whose connections to the main run and the branch drop are **smooth and tangent** — fixing the user-reported branch-kit connection distortion and non-smooth joins.

---

## 1. Objective

End state: A refrigerant branch kit is a parametric fitting defined by **typed ports** (inlet, run-outlet, branch-outlet) where each port carries a position **and a departure tangent** consistent with the copper it physically meets. Both the kit and the pipes connecting to it derive their geometry from **one canonical, headless `pipeCenterline` representation** (straight legs + true circular-arc fillets). The 2D Fabric renderer, the 2D Konva interaction overlay, and the 3D `three.js` swept-tube builder all consume this single centerline, so a branch joint looks the same in plan and in 3D and the branch copper leaves the kit along a tangent (no kink, no forced-diagonal mismatch). Gas/liquid bundle spacing is governed by **one shared spacing function** so every joint (unit port ↔ pipe ↔ kit) meets at consistent spacing. The branch kit is a **real topological tee by default**, with a blended (filleted) junction rather than a cosmetic overlay. Editing a kit or its connected run re-runs connection logic against the **live** scene so the kit stays glued to the run.

---

## 2. Current State & Why It Hurts

The branch kit today is a **cosmetic blob, not a parametric tee**, and its ports lie about their tangents. Grounded specifics:

- **Branch-outlet direction is forced `{x:1, y:0}` while the outlet physically drops down.** `refrigerantBranchKitModel.ts:1044-1053` (`branchOutletTerminal`) pins `direction: {x:1, y:0}` even though the outlet point is offset DOWN by `outletSeparationMm` (gas 94mm / liquid 87mm, `refrigerantBranchKitModel.ts:1190-1215`) and the branch is drawn as a diagonal stub (`branchGuidePoints`, `refrigerantBranchKitModel.ts:788-801`). The connecting pipe is told to leave horizontally while the copper angles down → guaranteed kink at the joint. **→ symptom (c) branch-kit connection not smooth, (b) distortion.**
- **The manifold is a decorative bezier hull**, not the flow centerline (`refrigerantBranchKitModel.ts:622-765`). The visible fitting shape is unrelated to the actual connection geometry.
- **Three different gas/liquid spacings must meet at one joint.** Unit ports use a fixed 42mm center spacing (`unitPipePortModel.ts:149`); ducted/cassette use their own formulas (`ductedIndoorUnitModel.ts:495-500`, `ceilingCassetteModel.ts:355-362`); kit outlets use 94/87mm (`refrigerantBranchKitModel.ts:1200-1213`); the pipe pair computes `gasR+liquidR+pipeGap`. `buildUnitPortBundleConnection` then **fabricates synthetic "field" points** at a different spacing (`refrigerantPipePairModel.ts:1339-1402`) and `repairDegenerateBundlePoints` re-spaces again (`refrigerantPipePairModel.ts:408-491`). The pair splays/converges between endpoints. **→ symptom (b) distortion.**
- **The tee is faked, not connected.** `buildBranchKitInsertion` returns `removeElementIds=[]` and overlays the kit on the intact run unless `enableRealTeeTopology` is on (default **false**, `pipeRoutingSettings.ts:116`; overlay path `branchKitProposal.ts:952-994`). The run pipe and the kit are not graph-connected; the connecting route is a hand-built orthogonal L/Z (`buildOrthogonalConnectionRoute`, `branchKitProposal.ts:210-232`) producing a right-angle corner at the fitting instead of a tangent blend. **→ symptom (b)/(c)/(d).**
- **2D and 3D derive bends with unrelated math.** 2D strokes a sharp/round-joined polyline (`HvacPlanRenderer.ts:1175-1183`, `strokeLineJoin:'round'` — cosmetic, not a fillet) plus Catmull-Rom wobble for flexible segments (`refrigerantPipePairModel.ts:920-943`); 3D builds a **QuadraticBezierCurve3** fillet (`pipeJointGeometry.ts:152-171`), which is G1 but **not a constant-radius arc** and does not honor the real bend radius. The one true plan-space fillet (`pipeTopology.ts:211 filletPolyline`, `buildRouteCornerNodes:293`) is **never consumed by 2D**. So the same corner is three different curves. **→ symptom (c).**
- **Placement re-projects through stale stored snap metadata.** `resolveInlineBranchKitCenter` (`refrigerantPipePairModel.ts:1576-1666`) recomputes the kit center from `branchKitSnapSegmentStart/End` + `branchKitSnapProjectedDistanceMm`, not from the live run; if the run moves, the kit stays glued to the stale segment, and a hard `MAX_INLINE_ANCHOR_LOCAL_DRIFT_MM=1mm` cliff (`:1633-1641`, mirrored `HvacPlanRenderer.ts:206-213`) makes the kit **jump** when a diameter is edited. **→ symptom (d).**
- **Gas and liquid kits are placed by two independent proposals** (`branchKitProposal.ts:617-630`) that can disagree on rotation/flip on a near-symmetric drop, so outlets face opposite ways and the connecting pair crosses itself. **→ symptom (b).**
- **Hand-rolled vector/intersection math is duplicated 4+ times** (`branchKitProposal.ts:166-245`, `refrigerantPipePairModel.ts:669-716`, `refrigerantBranchKitModel.ts:152-265`) with divergent rotate/normalize copies — correctness hazard and the user's "wrong library" suspicion (e).

---

## 3. Root Causes to Fix

- Branch-kit ports report a tangent (`{x:1,y:0}`) that contradicts the copper's actual departure direction.
- No single canonical centerline; 2D and 3D each re-derive corners with different (and wrong-radius) curves.
- Gas/liquid bundle spacing is defined in ≥4 places and reconciled by fabricating synthetic points.
- The tee is an overlay, not a real split; the kit→run junction is a sharp orthogonal corner, never tangent-blended.
- Placement heals against stale stored metadata, not the live run; a 1mm anchor-drift cliff causes jumps on edit.
- Gas + liquid kits are placed by two independent rotation/flip decisions.
- Geometry math duplicated across files with subtle divergences; no shared kernel.

---

## 4. Target Design

### 4.1 Typed parametric port model
Define the branch kit as a fitting with **three typed ports** per line (`inlet`, `run-outlet`, `branch-outlet`). **Each port's `direction` MUST equal the actual departure tangent of the copper at that port**, derived from the last segment of the kit's own centerline — never a hard-coded axis. The `branch-outlet.direction` must be derived from the final `branchGuidePoints` segment (fixing `refrigerantBranchKitModel.ts:1049`).

### 4.2 Canonical `pipeCenterline` (arc-spline) — THE single source of truth
Author a **headless, framework-free** module `pipeCenterline.ts` (no Fabric/Konva/three imports) that represents any pipe run / branch drop as an ordered list of `{ type: 'line' | 'arc', ... }` primitives. The corner primitive is a **true circular-arc fillet tangent to both legs**, computed with the standard formula:

> Given incoming leg dir `u`, outgoing leg dir `v`, corner `C`, target radius `r`: half-angle `θ = angleBetween(-u, v)/2`; tangent setback `d = r / tan(θ)`; arc center on the interior bisector at distance `r / sin(θ)` from `C`; tangent points at `C − d·û` and `C + d·v̂`. Clamp `r ← min(r, |inLeg|/2, |outLeg|/2)` so adjacent fillets never overlap.

This is the canonical MEP representation (straight + constant-radius elbow, **G1**; do NOT chase G2 — splines cannot honor a fixed bend radius). One bend-radius knob: wire `pipeRoutingSettings.bendRadiusFactor` (`pipeRoutingSettings.ts:42-43,66` — currently "reserved/not consumed") so it drives the fillet radius everywhere. Reconcile with `pipeTopology.bendRadiusFromDiameterMm` (k=1.5) so there is exactly one formula.

Build this on **`@flatten-js/core`** primitives (`Segment`, `Arc`, `Circle`, `Point`, `nearestPointOnSegment`, intersections). Rationale vs alternatives: pipe bends are arcs not NURBS (reject `verb-nurbs`), and adding `paper.js` as a 4th renderer worsens the fragmentation complaint (e). flatten is headless, ESM, zero-dep, mm-native.

### 4.3 Smooth tangent junction (kit ↔ run ↔ branch)
The connecting branch route must **arrive along the port tangent**, not an orthogonal L/Z that meets a horizontal `{x:1,y:0}` outlet. Replace `buildOrthogonalConnectionRoute` (`branchKitProposal.ts:210-232`) usage for the kit→drop leg with a centerline whose final segment is tangent to `branch-outlet.direction`. Where two fixed ports with fixed tangents must be joined and a single fillet can't satisfy tangency at both ends, use a **biarc** (two G1-joined circular arcs) — reserve biarc ONLY for that port-to-port case, not ordinary free corners.

### 4.4 Real tee by default + shared spacing
- Flip `enableRealTeeTopology` to **true** by default (`pipeRoutingSettings.ts:116`) so `buildTeeRunHalves` / `splitPolylineAtStation` (`branchKitProposal.ts:812`, `pipeTopology.ts:117`) genuinely splits the run and clears the cut-end connection, and the kit becomes graph-connected. Keep a settings escape hatch.
- Author **ONE** `bundleSpacing.ts` canonical gas/liquid spacing function consumed by `unitPipePortModel`, `ductedIndoorUnitModel`, `ceilingCassetteModel`, the kit's `outletSeparationMm`, and the pipe-pair builder. Delete the synthetic-field-point fabrication in `buildUnitPortBundleConnection` (`refrigerantPipePairModel.ts:1339-1402`) and the re-spacing in `repairDegenerateBundlePoints` (`:408-491`) once all producers agree.

### 4.5 3D agreement
In `pipeJointGeometry.buildTubeCurve` (`pipeJointGeometry.ts:120-180`), replace `QuadraticBezierCurve3` corners with a true circular arc (either `THREE.ArcCurve` lifted into the bend plane via a local frame, or `CubicBezierCurve3` with the 0.5523·r kappa handle for a near-perfect quarter-circle) sweeping the **same center/radius/angle** the `pipeCenterline` module produced. Keep ONE continuous `CurvePath` per run (already done) — never per-segment tubes. Stop double-rounding: round corners EITHER in the shared 2D module OR in 3D, not both (remove `roundPolylineCorners` 2D pre-rounding if 3D consumes the canonical centerline). For the tee saddle, keep `unionGeometries` (`pipeJointGeometry.ts:364`, three-bvh-csg) but **scope it strictly to the kit junction**, cache by stable kit signature, and treat the `mergeGeometries` fallback (`:394`) as an error. Project the branch connection point onto the **actual** run centerline (fix `buildHvacElementMesh.ts:1758-1772`, which assumes `y = runStart.y`).

### 4.6 Coordinated pair placement + live heal
- Replace the two independent `placeKitOnLineSegment` calls (`branchKitProposal.ts:617-630`) with **one shared rotation/flip decision** applied to both gas and liquid kits so they can never face opposite ways.
- Make `resolveInlineBranchKitCenter` heal against the **live run element** (mirror `healStartBundleConnectionFromScene` semantics, `refrigerantPipePairModel.ts:574-634`) instead of stale stored snap segments, and **remove/relax the 1mm anchor-drift cliff** (`:1633`) so a diameter edit does not teleport the kit.
- Route ALL paired auto-generated routes through **route-one-centerline-then-offset-the-pair** (already in `buildRefrigerantPipeElements`) so the gas/liquid gap never collapses on the branch bend.

---

## 5. Libraries & Dependencies

- **ADD `@flatten-js/core`** (v1.x, actively maintained, pure TS, zero-dep) — the headless 2D geometry kernel for `pipeCenterline.ts`, `bundleSpacing.ts`, and port-snap math. Add to `packages/drawing-engine/package.json` and run `pnpm install`. Confirm ESM import works under the package's existing build.
- **KEEP `three` ^0.183** — swap quadratic-bezier corners for true arcs.
- **KEEP `three-bvh-csg` ^0.0.18** — tee/saddle union ONLY; cache + treat fallback as error. Note it is pre-1.0 and version-coupled to three internals; the existing test already flags a separate-three-build identity issue — do not upgrade three without re-checking CSG.
- **KEEP `@turf/turf` ^7.3** — optional `nearestPointOnLine` for tap-in snap; not the fillet kernel.
- **EVALUATE `rbush`** (transitively present via turf) — only if branch-kit nearest-run snap lookup profiles slow.
- **DO NOT ADD** `verb-nurbs`, `paper.js`, `pixi.js` (wrong tool / 4th renderer).
- **DO NOT** route pipe through `utils/spline.ts` (Catmull-Rom/NURBS) — fine for freehand annotation, wrong for pipe; it is part of the "wrong library" smell (e).

---

## 6. Implementation Steps

Work in vertical slices; keep each slice green (`pnpm test`, `pnpm typecheck`).

1. **Add dependency.** Add `@flatten-js/core` to `packages/drawing-engine/package.json`; `pnpm install`; commit lockfile.
2. **Create `packages/drawing-engine/src/components/canvas/hvac/pipeCenterline.ts`** (headless). Implement: `arcFillet(prev, corner, next, radiusMm)` → line→arc→line primitives (formula in §4.2); `buildCenterline(routePoints, radii)` → ordered `CenterlineSegment[]`; `biarc(p0, t0, p1, t1)` for fixed-tangent port joins; `sampleCenterline(segments, opts)` → `Point2D[]` (adaptive: dense through arcs, sparse on straights). Reuse/replace `pipeTopology.filletPolyline` math; export a single `bendRadiusMm(diameterMm, settings)` honoring `bendRadiusFactor`.
3. **Create `packages/drawing-engine/src/components/canvas/hvac/bundleSpacing.ts`** — one `resolveBundleSpacingMm(gasDiameterMm, liquidDiameterMm, settings)` and `bundleOffsets()` helpers. Replace fixed 42mm / radius-driven / 94-87mm constants in `unitPipePortModel.ts:149`, `ductedIndoorUnitModel.ts:495-500`, `ceilingCassetteModel.ts:355-362`, and `refrigerantBranchKitModel.ts:1200-1213` with calls to it.
4. **Fix branch-kit port tangents** in `refrigerantBranchKitModel.ts`: derive `branchOutletTerminal.direction` (`:1049`) and `run-outlet`/`inlet` directions from the actual final centerline segment of each line, not hard-coded axes. Build the branch leg from `pipeCenterline.buildCenterline` so the cosmetic manifold (`:622-765`) follows the real flow tangent (or keep the hull purely decorative but ensure terminals come from the centerline).
5. **Rewrite the connecting drop** in `branchKitProposal.ts`: replace the orthogonal L/Z for the kit→drop leg (`:210-232`, `:849-1001`) with a centerline whose final segment is tangent to `branch-outlet.direction` (use `biarc` when both ends are tangent-fixed). Make `outletDirection` (`:869-877`) the true port tangent, not `normalize(gas+liquid {x:1,y:0})`.
6. **Single rotation/flip decision** for the coordinated pair: refactor `placeKitOnLineSegment` (`:318`) so gas and liquid share one orientation decision (replace the two independent calls at `:617-630`).
7. **Enable real tee by default**: set `enableRealTeeTopology` default `true` (`pipeRoutingSettings.ts:116`); ensure `buildBranchKitInsertion` returns the split-run halves (`buildTeeRunHalves`, `:812`) and clears cut-end connections; keep overlay behind the flag for fallback.
8. **Live heal placement**: in `refrigerantPipePairModel.ts`, make `resolveInlineBranchKitCenter` (`:1576-1666`) look up the live run element and reproject onto its current segment; relax/remove `MAX_INLINE_ANCHOR_LOCAL_DRIFT_MM` cliff (`:1633`); mirror the change in `HvacPlanRenderer.ts:196-214`.
9. **2D render from the canonical centerline**: in `HvacPlanRenderer.renderPipePolyline` (`:1163-1183`) and the branch-kit render path, emit a `fabric.Path` using SVG arc (`A`) commands (or sample the centerline) instead of `strokeLineJoin:'round'` on raw points. Same centerline feeds the Konva overlay (`PipeKonvaInteractionLayer.tsx`) — use `Konva.Path` `A` data or `ctx.arc/arcTo` in a `sceneFunc`. Do NOT pre-tessellate arcs into fixed polylines.
10. **3D arc corners**: in `pipeJointGeometry.buildTubeCurve` (`:120-180`) replace `QuadraticBezierCurve3` with a true arc sweeping the same params as `pipeCenterline`. Remove 2D double-rounding (`refrigerantPipePairModel.ts roundPolylineCorners :2418/2456/2459`) if 3D now consumes the canonical centerline.
11. **3D branch connection point**: fix `buildHvacElementMesh.ts:1758-1772` to project `branchHead` onto the real (possibly rotated) run centerline; cache the CSG union by kit signature; treat `mergeGeometries` fallback as error.
12. **Remove synthetic spacing**: once §3/§6.3 producers agree, delete `buildUnitPortBundleConnection` field-point fabrication (`refrigerantPipePairModel.ts:1339-1402`) and `repairDegenerateBundlePoints` re-spacing (`:408-491`); make resolve idempotent (no route translation on read — gate any reconcile behind explicit edit/commit, `:1148-1168`).
13. **Consolidate vector math**: route the duplicated rotate/normalize/intersect helpers (`branchKitProposal.ts:166-245`, `refrigerantPipePairModel.ts:669-716`, `refrigerantBranchKitModel.ts:152-265`) through one shared util or `@flatten-js/core`.
14. **Tests** (see §10) and **manual verification** via Claude Preview MCP.

---

## 7. Data Model / Type Changes

```ts
// pipeCenterline.ts
export type CenterlineSegment =
  | { type: 'line'; start: Point2D; end: Point2D }
  | { type: 'arc'; center: Point2D; radiusMm: number;
      startAngleRad: number; endAngleRad: number; clockwise: boolean;
      startPoint: Point2D; endPoint: Point2D };

export interface Centerline {
  segments: CenterlineSegment[];
  sample(stepMm?: number): Point2D[];   // adaptive
}

// refrigerantBranchKitModel.ts — port carries the REAL departure tangent
export interface RefrigerantBranchKitTerminalSpec {
  key: string;
  kind: RefrigerantBranchLineKind;            // 'gas' | 'liquid'
  role: RefrigerantBranchTerminalRole;        // 'inlet' | 'run-outlet' | 'branch-outlet'
  point: Point2D;
  direction: Point2D;                         // MUST equal copper departure tangent (unit vector)
  coreDiameterMm: number;
  outerDiameterMm: number;
  socketLengthMm: number;
}

// bundleSpacing.ts — one source of truth
export function resolveBundleSpacingMm(
  gasDiameterMm: number, liquidDiameterMm: number,
  settings: PipeRoutingSettings,
): number;
```

If you promote a strongly-typed pipe geometry field (optional, coordinate with T-state task): add `RefrigerantPipeGeometry` to `HvacElement` instead of the untyped `properties` bag (`types/index.ts:268`) and add a `v1→v2` migration step in `canvasDataMigration.ts` — do NOT change `routePoints`/connection shape without a migration (`store/index.ts:4831-4843` spreads raw unvalidated).

---

## 8. UX & Interaction Requirements

- Dragging a branch drop or its kit shows a **live tangent-correct ghost** of the connecting copper; the branch leaves the kit smoothly (no visible kink), and the bend honors the configured bend radius.
- Branch-kit proposal card snaps the kit cleanly onto the run centerline; the gas+liquid kit pair always faces the same way.
- Editing a connected run **drags the kit with it** (live heal); editing a diameter does NOT teleport the kit.
- 2D plan and 3D view show the **same** bend at the junction at all zoom levels (arc-native render, no faceting/distortion when zoomed).
- Snap-to-port / snap-to-centerline feedback with a fixed **pixel** tolerance (converted through current zoom).

---

## 9. Acceptance Criteria

- [ ] Every branch-kit terminal's `direction` equals the unit tangent of the copper at that terminal (assert in test for gas + liquid, all three roles).
- [ ] A branch drop connected to a kit has **zero tangent discontinuity** at the branch-outlet (angle between connecting-route final segment and `branch-outlet.direction` < 1°).
- [ ] 2D and 3D produce the **same** junction geometry: the arc center/radius/sweep used by `HvacPlanRenderer` equals (within float tolerance) that used by `buildTubeCurve`.
- [ ] Gas/liquid spacing is identical at unit port, mid-run, and kit outlet (single `resolveBundleSpacingMm`); no synthetic field points generated.
- [ ] `enableRealTeeTopology` defaults true; an inserted kit splits the run into two graph-connected halves with cleared cut-end connections.
- [ ] Gas and liquid kits of one proposal always share the same rotation/flip.
- [ ] Moving the underlying run moves the kit with it; editing a diameter does not jump the kit.
- [ ] `resolveRefrigerantPipe(Pair)Spec` is idempotent (round-trip resolve does not translate routePoints).
- [ ] No new use of `utils/spline.ts` on the pipe path; vector math consolidated.
- [ ] `pnpm typecheck` and `pnpm test` (vitest) pass.

## 10. Test Plan

**Unit (vitest)** — colocate `*.test.ts` next to sources, following `pipeTopology.test.ts` / `pipeJointGeometry.test.ts` conventions:
- `pipeCenterline.test.ts`: arc fillet tangency (tangent points lie on both legs; arc is tangent — distance from center to each leg == radius); radius clamps on short legs; biarc produces two G1-joined arcs meeting prescribed tangents; sampling is dense through arcs.
- `bundleSpacing.test.ts`: one spacing value across producers; round-trips with diameters.
- `branchKit` tests: terminal `direction` == centerline tangent for all roles; connecting route arrives tangent (<1°); single shared rotation/flip for the pair; real-tee split produces two connected halves.
- `refrigerantBranchKitModel` / `pipeJointGeometry`: assert 2D arc params == 3D arc params for a representative junction.
- Idempotency: `resolveRefrigerantPipePairSpec(resolve(x)) ≈ resolve(x)` (no route translation).

**Visual / manual:**
- Use the **Claude Preview MCP** (`mcp__Claude_Preview__preview_start` / `preview_screenshot`) to load `apps/web`, place an indoor unit + run, draw a branch, and screenshot plan + 3D; confirm the branch leaves the kit smoothly and 2D/3D agree at the junction; zoom to confirm arc-native (no faceting).
- Optionally drive the 3D scene via the three.js MCP (`mcp__de970454-...__show_threejs_scene`) to inspect the swept tube at the tee.
- Run `/verify` to confirm the change works in the running app before pushing.

## 11. Edge Cases & Pitfalls

- **Do NOT** recompute the whole route / rebuild the whole fabric group on every drag frame — preview cheaply, commit on drag end (relevant when wiring the live ghost; coordinate with the editing task).
- **Do NOT** keep 2D and 3D deriving bends independently — both must consume `pipeCenterline`.
- **Do NOT** pre-tessellate arcs into fixed polylines for 2D (causes zoom distortion) — use `A` path commands / `arcTo`.
- **Do NOT** use `QuadraticBezierCurve3` for elbows (not constant radius) or chase G2 continuity (splines can't honor bend radius).
- **Do NOT** run CSG per frame or on ordinary elbows — tee saddle only, cached.
- **Do NOT** add a 4th renderer (paper.js/pixi) or `verb-nurbs`; do not use `utils/spline.ts` for pipe.
- Vertical risers: seed a deterministic initial normal in the 3D tube frame so the cross-section seam doesn't jump (the tangent may align with the default up axis).
- Short legs: clamp fillet radius to half the shorter adjacent leg or fillets overlap and corners collapse.
- Near-symmetric drops: the single rotation/flip decision must be deterministic (tie-break consistently).
- Migration: do not change `routePoints`/connection shape without a `canvasDataMigration.ts` step.
- Settings purity: prefer threading `PipeRoutingSettings` as an argument over the mutable module singleton (`pipeRoutingSettings.ts:172-189`) for the new modules so geometry is order-independent.

## 12. Dependencies on Other Tasks

- **Shares the canonical-transform / idempotent-resolve work** (the W5/R3 `coordinateTransform.ts` + resolve-idempotency task) — `pipeCenterline` must operate in canonical world-mm; ensure resolve does not translate routePoints (T-coordinate/state task).
- **Bend-radius unification & swept-elbow geometry** (W4 / the smooth-bend task) — T4 consumes the same `pipeCenterline` arc-fillet primitive; coordinate the single `bendRadiusFactor` knob so both tasks use one formula.
- **Editing-UX task** (the per-tick store-thrash / live-preview task) — the live tangent ghost for branch drops should reuse that task's lightweight preview channel rather than full re-sync.
- **2D engine consolidation task** — T4 only requires that Fabric and Konva consume the same centerline; it does not itself decide the single-engine question, but should not deepen the Fabric/Konva split.