## 1. Objective

Replace and repair the three.js refrigerant-pipe geometry pipeline so that every straight run, swept elbow, branch-kit tee, and reducer is generated from **one shared, cached arc-fillet centerline** — the same centerline the 2D plan view and T2 produce — and renders as a clean, watertight, twist-free, seam-free tube. The end state: there is exactly **one** 3D pipe builder (the W4 `buildSweptTubeGeometry` path in `buildHvacElementMesh.ts`), the legacy capped-cylinder chain in `IsometricViewCanvas.tsx` is deleted, elbows are true constant-radius arcs that match 2D exactly, the cross-section never twists or pinches at straight→elbow transitions, CSG is confined to genuine tee/reducer intersections and is cached, and editing a pipe does not rebuild every other pipe's geometry. This directly fixes user symptoms (b) connection distortions, (c) bends/branch-kit not smooth, and (d) editing not smooth in the 3D view.

## 2. Current State & Why It Hurts

The W4 swept-tube foundation is sound in its bones but has six concrete defects, plus a major duplication.

- **Two divergent 3D pipe builders.** `buildHvacElementMesh.ts` uses the modern swept `TubeGeometry` path (`createTubeAlongPoints` wrapper at `buildHvacElementMesh.ts:388`, swept call ~`:446`). But `IsometricViewCanvas.tsx:1761` defines its **own** legacy `createTubeAlongPoints` that emits a `Group` of per-segment `createCylinderBetweenPoints` with end caps (the exact ball-joint/z-fighting chain W4 was meant to replace) and it is **still live at 4 callsites (`IsometricViewCanvas.tsx:2736, 2819, 3024, 3173`)**. The same pipe renders smooth in one path and faceted/z-fighting in the other depending on which builder runs → symptoms (b), (c), (e). Dead siblings also exist: `_createSmoothTubeAlongPoints` (`IsometricViewCanvas.tsx:1702`) and `createCylinderBetweenPoints` (`buildHvacElementMesh.ts:331`).

- **Elbows are quadratic-bezier approximations, not constant-radius arcs.** `buildTubeCurve` (`pipeJointGeometry.ts:120`) joins straight `LineCurve3` legs with `QuadraticBezierCurve3` corners (`pipeJointGeometry.ts:168-169`) using the control point AT the raw vertex. A quadratic bezier is parabolic, not circular — its radius is **not** the pipe bend radius, so it cannot match the 2D fillet and looks pinched on tight 90° elbows → symptom (c). The fillet is clamped `min(bendRadiusMm, inLen*0.5, outLen*0.5)` (`pipeJointGeometry.ts:152-155`) so closely-spaced vertices collapse to near-zero radius → kinks.

- **Bend radius is computed by three unrelated formulas.** 3D default is `Math.max(radius*1.5, 12)` (`pipeJointGeometry.ts:219-220`); `pipeTopology.ts` uses `bendRadiusFromDiameterMm` k=1.5 (`pipeTopology.ts:56,183`); the configurable `settings.bendRadiusFactor` is documented "reserved/not consumed" (`pipeRoutingSettings.ts:42-43,66`). 2D and 3D therefore choose smoothness independently → 2D and 3D disagree at every bend (symptom c).

- **Double-rounding.** 2D already rounds corners via `roundPolylineCorners` (`refrigerantPipePairModel.ts:2418/2456/2459`) BEFORE handing points to 3D, then `buildTubeCurve` fillets those already-arced points AGAIN → uneven/short radii on tight routes (symptom b/c).

- **Frenet-frame seam/twist surface.** `buildSweptTubeGeometry` feeds the `CurvePath` to `THREE.TubeGeometry` (`pipeJointGeometry.ts:233`), which calls `computeFrenetFrames`. Note: that routine is the **minimal-rotation** propagation (Bloomenthal TR425), so it does *not* flip at inflections. The real, observable artifacts are: (a) the open-curve **start/end seam** lands at an unstable orientation, so end-cap discs and tee saddles can mis-register between runs, and (b) on a **vertical riser** (first tangent ≈ world up) the initial normal seed is ill-defined and the cross-section seam jumps → reads as twist/pinch where a straight leg meets the elbow (symptoms b, c).

- **Synchronous, uncached CSG on the render path.** `unionGeometries` (`pipeJointGeometry.ts:364-403`) runs `three-bvh-csg` ADDITION on the main thread every time a branch-kit mesh is built (`buildHvacElementMesh.ts:~1775`), with a silent `catch → mergeGeometries` fallback (`pipeJointGeometry.ts:394-402`) that **restores the interpenetrating-cylinder look the union was meant to fix**. No memoization → every edit re-runs the boolean (symptoms c, d). CSG also runs for cases that don't need it.

- **Branch takeoff forced onto an axis-aligned centerline.** The CSG branch connection point is synthesized as `{x: branchHead.x, y: runStart.y}` (`buildHvacElementMesh.ts:1758-1772`), assuming the trunk runs along y. For a rotated/angled trunk the saddle is cut in the wrong place → the branch floats or over/under-shoots into the trunk (symptoms b, c).

- **`three-mesh-bvh` declared but never imported** (`package.json:49`) — no `computeBoundsTree`/`acceleratedRaycast`/`MeshBVH` anywhere. Dead dependency; the right tool for clash + pick is sitting unused.

- **No geometry caching.** `buildSweptTubeGeometry`/`unionGeometries` allocate fresh geometry every scene rebuild, and `buildHvacElementMesh` rebuilds full tubes on each rebuild, so dragging one element rebuilds every tube (symptom d).

- **Open-end overlap can misalign.** Open ends are extended by `continuationOverlapMm = max(1.5, radius*0.75)` linearly along the end leg (`buildHvacElementMesh.ts:416-441`); at an elbow or angled join this pokes past the true joint or creates a step/seam (symptom b).

- **Duplicate branch-kit center resolution.** `resolveInlineBranchKitRenderCenter` exists in `buildHvacElementMesh.ts:1118` (which overrides via `resolveInlineBranchKitCenter` at `:1303`) AND in `IsometricViewCanvas.tsx:531` which does NOT call that override → the two 3D paths can place the same kit differently (symptoms b, d).

## 3. Root Causes to Fix

- Two independent 3D pipe builders (modern swept vs legacy capped-cylinder chain) with divergent corner derivation.
- Corner geometry is a parabola, not a circular arc, so it cannot honor the real bend radius and cannot match 2D.
- Bend radius and corner-rounding happen in 2–3 disconnected places (double-rounding; three formulas; `bendRadiusFactor` ignored).
- TubeGeometry's frame is seeded/seamed unstably on open and axis-aligned curves.
- CSG runs synchronously, uncached, for too-broad a set of cases, and degrades silently.
- Branch connection point assumes an axis-aligned trunk.
- No geometry cache; `three-mesh-bvh` unused; clash/pick re-derive geometry.

## 4. Target Design

### 4.1 One centerline, three consumers (shared with T2/2D)
The single source of truth for a pipe's shape is the **arc-fillet centerline** — an ordered list of `line | arc` primitives in canonical world-mm, produced by the shared headless module from T2 (`pipeFillet.ts` / `pipeTopology.filletPolyline` + `buildRouteCornerNodes`). T3 does **not** re-derive corners. It maps that centerline into a `THREE.CurvePath`:
- `line` segment → `THREE.LineCurve3`.
- `arc` segment → a **true circular arc** sampled in the bend plane. Build a local frame from the in/out leg directions (the arc's own center/radius/sweep that T2 already computed), and either (preferred) sample `THREE.ArcCurve`-equivalent points and add as a poly/`CatmullRomCurve3`-free `LineCurve3` chain, OR use a `CubicBezierCurve3` with the **0.5523·r kappa handle length** for a near-perfect quarter-circle. The arc center/radius/sweep MUST equal what 2D draws, so 2D and 3D agree by construction.

Elevation is the z lift: `worldTo3D(x, y, elevationZ) = {x, y, z}` (use the canonical `coordinateTransform.ts:worldTo3D`, currently uncalled — wire it in). Bypass/elevation ramps (`buildElevationProfiledPoints`, `buildHvacElementMesh.ts:547`) feed z into the same centerline before lift.

### 4.2 Geometry generation rules (decision table)
- **Straight run + elbows (the common case):** ONE `THREE.CurvePath` → ONE `THREE.TubeGeometry(curve, adaptiveSegments, radius, 24, false)`. No per-segment tubes, no spheres, **no CSG**. Flat `CircleGeometry` end caps only at *true* open ends (`openStart`/`openEnd`), never at interior joints or continued ends. This already exists in `buildSweptTubeGeometry` — keep its shape, fix the corner math + sampling + framing.
- **Tee / branch-kit junction (genuine axis intersection):** build the run tube and branch tube as CLOSED manifolds → `unionGeometries` (three-bvh-csg ADDITION) → `mergeVertices` + recompute normals **on the welded result only** → **cache** by a stable fitting signature. CSG ONLY here.
- **Reducer:** `CylinderGeometry(r1, r2)` between ports; union into the tee if it intersects, else merge.
- **Clash / pick:** `three-mesh-bvh` `computeBoundsTree` + `shapecast`/`bvhcast`/`acceleratedRaycast`. Never CSG.

### 4.3 Framing (kill twist at straight→elbow)
Build the whole run as ONE `CurvePath` so the minimal-rotation frame propagates continuously across straights and bends (already done — preserve it; never go back to per-segment tubes). Then add an **explicit initial-normal seed**: choose a deterministic reference up-axis based on the first tangent (e.g. world Z for a horizontal first leg, world X for a vertical riser) so the seam is stable and caps/saddles register. If a fully deterministic seam is needed for welding caps/tees, post-process with an explicit parallel-transport reframe seeded from that reference — but do NOT add a third-party RMF library; three already gives a rotation-minimizing frame.

### 4.4 Adaptive sampling (kill faceting at bends)
Replace the global `sampleStepMm = 8` (`pipeJointGeometry.ts:227`) with **curvature-aware** sampling: straights need ~2 rings, each fillet needs ~10–16. Allocate cross-sections per curve-segment: fillet step ≈ `filletRadius·(π/2)/12`; straights coarse. Keep the 600 total-segment cap.

### 4.5 Caching + instancing (kill edit-time rebuild cost)
- Cache built `TubeGeometry` by a hash of `(centerline-primitive-hash, radius, bendRadius)`. Editing an unrelated element must not rebuild its tube.
- Cache the unioned tee geometry by a stable kit signature `(runCenterlineHash, branchCenterlineHash, radii, fittingType)`.
- Use `InstancedMesh` for repeated fittings (clamps/supports/branch-kit bodies). Merge static runs per material via `BufferGeometryUtils.mergeGeometries`; keep the **actively-edited** run un-merged so only it rebuilds.

### 4.6 Why this approach vs alternatives
- **Keep TubeGeometry, do not hand-roll a swept mesh or use ExtrudeGeometry:** the architecture is already correct; the bugs are corner math + framing seed + sampling + scoping CSG. A rewrite is unjustified risk.
- **Arc fillet (line+arc), not bezier/Catmull-Rom/NURBS:** a real elbow is a constant-radius arc tangent to two legs (G1, constant curvature within the arc). Bezier/Catmull-Rom give wandering curvature you cannot pin to the bend radius; that is the literal cause of "bends don't match / look pinched." Do NOT route pipe through `utils/spline.ts` (Catmull-Rom/NURBS) — wrong tool, and a likely "wrong library" smell.
- **three-mesh-bvh for clash/pick, not CSG:** BVH overlap is far cheaper than booleaning geometry to discover overlap, and it's already installed.
- **Not react-three-fiber / three-stdlib / three-custom-shader-material:** the engine is imperative three.js; r3f would be a rendering-layer rewrite. `examples/jsm` (already imported) is fine. `MeshStandardMaterial` is correct for insulated copper — a custom shader is unjustified here.

## 5. Libraries & Dependencies

- **KEEP `three` ^0.183** — first-party `TubeGeometry`/`CurvePath`/`ArcCurve`/`CubicBezierCurve3`/`InstancedMesh`/`BufferGeometryUtils` cover everything.
- **KEEP + WIRE UP `three-mesh-bvh` ^0.9.10** — currently dead (`package.json:49`, zero imports). Add `computeBoundsTree`/`disposeBoundsTree`/`acceleratedRaycast` patch and `MeshBVH`/`shapecast` for clash + pick.
- **KEEP but SCOPE DOWN `three-bvh-csg` ^0.0.18** — confine to genuine tee/reducer intersections; cache results; treat the `mergeGeometries` fallback as an error path to log/surface, not a happy path. Pin the exact version; duck-type the result with `.isBufferGeometry` (never `instanceof`, per existing test note).
- **DO NOT ADD** PixiJS, paper.js, r3f/drei, three-stdlib, three-custom-shader-material, verb-nurbs — all rejected above.
- **`@flatten-js/core`: EVALUATE, T2-owned.** Only relevant if the shared arc-fillet kernel is not already established by T2. T3 should *consume* T2's centerline, not introduce a new geometry kernel.
- **Version concern:** `three-bvh-csg` 0.0.x is version-coupled to three internals; any `three` bump needs the union smoke test re-run.

## 6. Implementation Steps

Work on branch `feat/hvac-2d3d-precision`. Granular, ordered:

1. **Consume the shared centerline from T2.** Add an adapter `centerlineToCurvePath(centerline: PipeCenterline): THREE.CurvePath<THREE.Vector3>` in `pipeJointGeometry.ts` that maps `line`→`LineCurve3` and `arc`→sampled circular arc (using the arc's stored center/radius/sweep). If T2's `PipeCenterline` type is not yet available, define a temporary shape (see §7) and coordinate with the T2 owner. Lift to 3D via `coordinateTransform.ts:worldTo3D` (wire this in; it is currently uncalled).

2. **Replace the bezier corner in `buildTubeCurve`** (`pipeJointGeometry.ts:120-180`) with a true circular arc. Either deprecate `buildTubeCurve` in favor of `centerlineToCurvePath` (preferred — corners come from T2), or, if a fallback that fillets raw points is still needed, swap `QuadraticBezierCurve3` (`:168-169`) for a `CubicBezierCurve3` with `0.5523·fillet` handle lengths along the in/out tangents. Keep the `min(bendRadius, inLen*0.5, outLen*0.5)` clamp (`:152-155`).

3. **Stop double-rounding.** Decide corners are rounded EXACTLY ONCE — in the shared centerline (2D `roundPolylineCorners`/`filletPolyline`). Make the 3D path consume already-filleted primitives and NOT re-fillet. Remove the independent fillet pass when `centerlineToCurvePath` is used.

4. **Unify bend radius.** Drive all bend radii from `settings.bendRadiusFactor` × outer diameter (consume the currently-ignored `pipeRoutingSettings.ts:42-43,66`), via the single `bendRadiusFromDiameterMm` in `pipeTopology.ts`. Remove the local `Math.max(radius*1.5,12)` default in `buildSweptTubeGeometry` (`pipeJointGeometry.ts:219-220`); require the radius be passed from the shared resolver.

5. **Add explicit initial-normal seeding** in `buildSweptTubeGeometry` (`pipeJointGeometry.ts:205-239`): compute a deterministic reference up from the first tangent (world-Z for horizontal, world-X for vertical risers) and either seed the TubeGeometry frame or post-process with a parallel-transport reframe. Add a unit test for a vertical-riser run.

6. **Adaptive sampling.** Replace `sampleStepMm = 8` (`pipeJointGeometry.ts:227-231`) with per-curve-segment sampling (dense through arcs, sparse on straights), capped at 600.

7. **Delete the legacy 3D builder.** Remove `IsometricViewCanvas.tsx:1761` `createTubeAlongPoints` (capped-cylinder chain) and route its 4 callsites (`:2736, :2819, :3024, :3173`) through `buildHvacElementMesh.ts`'s swept path. Remove dead `_createSmoothTubeAlongPoints` (`IsometricViewCanvas.tsx:1702`) and `createCylinderBetweenPoints` (`buildHvacElementMesh.ts:331`) if no remaining callers.

8. **Consolidate branch-kit center.** Delete the duplicate `resolveInlineBranchKitRenderCenter` in `IsometricViewCanvas.tsx:531`; have both 3D paths call the single `resolveInlineBranchKitCenter` override (`buildHvacElementMesh.ts:1303`).

9. **Fix the branch connection point.** In `renderLine` (`buildHvacElementMesh.ts:1758-1772`), project `branchHead` onto the **actual** (possibly rotated) run centerline (nearest-point-on-segment in the run's local frame) instead of `{x: branchHead.x, y: runStart.y}`.

10. **Scope + cache CSG.** Gate `unionGeometries` (`pipeJointGeometry.ts:364`) strictly to genuine tee/reducer intersections. Add a memo keyed by a stable fitting signature; reuse the cached geometry across re-renders. Change the `catch → mergeGeometries` fallback (`:394-402`) to also emit a structured warning/telemetry so a degraded tee is visible, not silent. `mergeVertices` + recompute normals on the welded union output only.

11. **Wire `three-mesh-bvh`.** Add the `BufferGeometry.prototype.computeBoundsTree`/`disposeBoundsTree` + `Mesh.prototype.raycast = acceleratedRaycast` patch once at 3D init. Build BVH per pipe mesh; use `acceleratedRaycast` for pick/hover/snap and `shapecast` for a clash-verification pass after mesh generation. New file `three3d/pipeClash3d.ts`.

12. **Geometry cache.** Add `three3d/pipeGeometryCache.ts`: cache `TubeGeometry` by `(centerlineHash, radius, bendRadius)` and tee geometry by fitting signature. Invalidate per element on edit; ensure only the edited run rebuilds. Dispose evicted geometries (reuse `disposeGeometryTree`, `pipeJointGeometry.ts:409`).

13. **Open-end overlap.** Make `continuationOverlapMm` (`buildHvacElementMesh.ts:416-441`) follow the centerline tangent at the actual joint, not a straight linear extension, so chained ends meet without a step at elbows.

14. **Tests + verify** (see §10).

**Files to create:** `three3d/pipeGeometryCache.ts`, `three3d/pipeClash3d.ts`, plus tests. **Files to modify:** `three3d/pipeJointGeometry.ts`, `three3d/buildHvacElementMesh.ts`, `isometric/IsometricViewCanvas.tsx`, `pipeTopology.ts`, `pipeRoutingSettings.ts`, `coordinateTransform.ts` (wire `worldTo3D`), `package.json` (no new deps; ensure three-mesh-bvh used).

## 7. Data Model / Type Changes

Consume T2's centerline; if not yet available, define this shared shape (coordinate the canonical version with T2):

```ts
// Shared, headless, world-mm. Produced by T2 / pipeTopology, consumed by 2D + 3D.
export type PipeCenterlineSegment =
  | { kind: "line"; start: Point2D; end: Point2D }
  | {
      kind: "arc";
      start: Point2D;        // tangent point (fillet entry)
      end: Point2D;          // tangent point (fillet exit)
      center: Point2D;       // arc center
      radiusMm: number;      // == bend radius, == 2D
      startAngleRad: number;
      endAngleRad: number;
      clockwise: boolean;
    };

export interface PipeCenterline {
  segments: PipeCenterlineSegment[];
  hash: string;              // stable hash for caching (positions + radii)
}
```

3D-side additions in `pipeJointGeometry.ts`:

```ts
export function centerlineToCurvePath(
  centerline: PipeCenterline,
  elevationZMm: number,           // lift via worldTo3D
  arcSamplesPerQuarter?: number,  // adaptive sampling
): THREE.CurvePath<THREE.Vector3> | null;

export interface SweptTubeOptions {
  radialSegments?: number;
  sampleStepMm?: number;          // becomes adaptive; kept for straights
  referenceUp?: THREE.Vector3;    // NEW: explicit frame seed
  capStart?: boolean;
  capEnd?: boolean;
  weld?: boolean;                 // only true for CSG input
  // REMOVE the local bendRadiusMm default; radius comes from the resolver/centerline.
}
```

Cache key types in `pipeGeometryCache.ts`:

```ts
type TubeCacheKey = `${string}:${number}:${number}`; // centerlineHash:radius:bendRadius
type TeeCacheKey  = string;                           // fitting signature
```

## 8. UX & Interaction Requirements

The 3D view is a render of the shared model; smoothness comes from geometry quality + caching, not from per-frame edits. The user should feel:

- **Smooth, continuous bends** that visually match the 2D plan exactly (same arc radius, same position) — no faceting on tight 90° elbows, no parabolic "pinch."
- **No twist** of the copper/insulation cross-section where a straight leg meets an elbow, including on vertical risers.
- **No z-fighting / ball-joints / seams** at joints; tees show a clean saddle, not interpenetrating cylinders.
- **Responsive editing:** dragging/editing one pipe (via the T1/T2 interaction layer) updates only that pipe's 3D geometry; the rest of the scene does not visibly rebuild or stutter.
- **Consistent placement** of branch kits across the iso and mesh paths (no jump between views).

## 9. Acceptance Criteria

- Exactly ONE 3D pipe builder remains; `IsometricViewCanvas.tsx:1761` legacy `createTubeAlongPoints` and the dead siblings are deleted; all callsites use the swept path.
- Elbow corners are circular arcs whose radius equals the 2D fillet radius for the same corner (assert center/radius parity in a test).
- 2D and 3D bend geometry derive from the SAME centerline; corner rounding happens exactly once.
- Bend radius is driven by `settings.bendRadiusFactor` × diameter through one resolver; the three old formulas are gone.
- A vertical-riser run renders with a stable, non-twisting cross-section (frame-seed test passes).
- Cross-section stays ~constant 2r along straights and through bends (extend the existing `crossSectionExtent` test to a 90° elbow).
- CSG runs ONLY for genuine tee/reducer intersections, is cached by signature, and the fallback path emits a warning (is not silent).
- Branch connection point lies on the actual run centerline for a rotated trunk (test with a 30°-rotated run).
- `three-mesh-bvh` is imported and used for clash/pick; no longer a dead dependency.
- Editing one element rebuilds only its geometry (cache-hit assertion on untouched elements).
- All existing vitest suites pass, including `pipeJointGeometry.test.ts` and `coordinateTransform.test.ts`.

## 10. Test Plan

**Unit (vitest — repo uses vitest; headless three works as the existing test proves):**
- Extend `pipeJointGeometry.test.ts`:
  - `centerlineToCurvePath`: a line+arc centerline maps to a `CurvePath` whose arc sub-curve has the expected center/radius (parity with the input arc).
  - 90° elbow: cross-section extent stays within `[1.9r, 2.1r]` THROUGH the bend (not just on straights).
  - Vertical riser `[vec(0,0,0), vec(0,0,200)]`: build succeeds; cross-section is stable (no NaN normals; seam orientation deterministic with `referenceUp`).
  - Bend-radius source: changing `bendRadiusFactor` changes the arc radius; default local formula is gone.
  - CSG cache: two builds with the same fitting signature return the cached geometry (same object / hash); union still returns something with `.isBufferGeometry === true` (duck-typed).
  - Branch projection: rotated trunk → connection point lies on the run centerline within ε.
- New `pipeGeometryCache.test.ts`: cache hit/miss + disposal on eviction.
- New `pipeClash3d.test.ts`: two overlapping pipe meshes report a clash via `three-mesh-bvh` shapecast; non-overlapping do not.

**Visual / manual:**
- Use the **three.js MCP** (`show_threejs_scene` / `learn_threejs`) to render representative runs (straight, single elbow, S-bend, vertical riser, branch-kit tee, reducer) and eyeball for twist/pinch/seam/z-fighting.
- Use **Claude Preview** (`preview_start` + `preview_screenshot`) on the Next.js app: draw a multi-bend pipe and a branch kit, switch to 3D/iso, screenshot, confirm 2D and 3D bends match and no ball-joints.
- Run **`/verify`** to launch the app and confirm editing a pipe in 3D is smooth and does not rebuild the whole scene.
- Optionally export a run to Blender via the Blender MCP for a high-fidelity manifold/normal check on a tee.

## 11. Edge Cases & Pitfalls

Handle: zero-length / duplicate route points (existing `simplifyTubePoints`); fillet larger than half a leg (clamp); near-collinear corners (skip fillet, straight through); first tangent ≈ world up (riser seed); 180° reversals; single-segment runs (no fillet); open vs continued ends (cap only true open ends); rotated/angled trunks for CSG branch; CSG failure (surface, don't hide).

**Do NOT:**
- Do NOT keep two 3D pipe builders — delete the legacy capped-cylinder chain.
- Do NOT use `QuadraticBezierCurve3` / Catmull-Rom / NURBS / `utils/spline.ts` for elbow corners — use a true circular arc that matches 2D.
- Do NOT re-fillet in 3D corners that 2D already rounded (no double-rounding).
- Do NOT run CSG for ordinary elbows or straight continuations — a single swept tube is already watertight.
- Do NOT run CSG synchronously on every edit without caching, and do NOT treat the `mergeGeometries` fallback as success.
- Do NOT `mergeVertices`/weld a plain swept tube that isn't going into CSG — it collapses the smooth ring seam and pinches normals.
- Do NOT rebuild every pipe's geometry when one element changes — cache by centerline hash.
- Do NOT re-derive the plan→3D mapping inline — go through `coordinateTransform.ts:worldTo3D`.
- Do NOT add r3f, PixiJS, paper.js, three-stdlib, three-custom-shader-material, or verb-nurbs.
- Do NOT leave `three-mesh-bvh` as a dead dependency — use it or justify keeping it.

## 12. Dependencies on Other Tasks

- **T2 (shared centerline + bends)** is the upstream producer of the `PipeCenterline` / arc-fillet primitives this task consumes. T3 MUST NOT define its own corner-rounding; coordinate the canonical `PipeCenterline` type and `bendRadiusFromDiameterMm`/`bendRadiusFactor` wiring with T2. If T2 lands the headless `pipeFillet`/centerline module, T3 imports it directly.
- **T1 (single 2D interaction layer / kill Fabric–Konva split)** owns the edit-time store/preview path. T3's caching assumes edits update one element at a time; align the cache-invalidation hook with whatever commit channel T1 standardizes (commit-on-drag-end, not per-tick), so the 3D rebuild fires once per edit, not ~100×/sec.
- **Branch-kit task (if separate)**: the real-tee topology toggle (`enableRealTeeTopology`, `pipeRoutingSettings.ts:116`) and the orthogonal connection route feed the CSG tee; coordinate so the kit-to-run junction blends through the same arc-fillet centerline rather than meeting at a sharp overlay.