## Objective

Establish a single **canonical pipe-route data model** and one **headless, framework-agnostic bend-generation module** that converts a centerline polyline into smooth straight-leg + circular-arc (fillet) bends honoring a minimum bend radius. Both the 2D plan renderer (Fabric) and the 3D mesh builder (three.js) must derive their geometry from this **one** centerline so a corner looks identical in plan and 3D. The end state: 2D pipe bends are crisp constant-radius arcs (no sharp kinks, no cosmetic stroke-join "rounding", no zoom-dependent faceting), the bend radius is governed by **one** formula driven by `settings.bendRadiusFactor`, and segment material is bound to identity (not a fragile positional array). This task owns the **data model + geometry generation only** — interactive editing/snapping (T-edit) and 3D twist/CSG fixes (T-3D) consume this module but are scoped separately.

## Current State & Why It Hurts

There are **three different, inconsistent corner treatments for the same stored corner**, which is the direct root of user symptom (c) "smooth bends are not smooth" and (b) "distortion":

1. **Stored route = sharp vertices.** A refrigerant route is a flat `routePoints: Point2D[]` on `HvacElement.properties` (`refrigerantPipePairModel.ts:162`, type `RefrigerantPipeSpec` at `:161`). There is no segment object and no corner/node object persisted; segments are implicit pairs of consecutive points and `segmentMaterials: ('hard'|'flexible')[]` (`:167`) is a **positional parallel array** with no identity binding to vertices.

2. **2D render = cosmetic round-join, NOT a fillet.** `HvacPlanRenderer.ts` `renderPipePolyline` (`:1163`) strokes the raw segment polyline with `new fabric.Polyline(..., { strokeLineJoin: 'round' })` (`:1175-1183`). `strokeLineJoin:'round'` only rounds the *stroke* at line-width scale — it cannot produce a true constant-radius elbow. Flexible segments additionally get a Catmull-Rom wobble from `buildFlexibleSegmentSplinePoints` (`refrigerantPipePairModel.ts:920-943`, `catmullRomPoint` at `:895`), whose sample count is `clamp(round(span/12), 5, 24)` — a curve whose minimum radius cannot be pinned to the pipe's bend radius.

3. **3D render = quadratic-bezier fillet.** `three3d/pipeJointGeometry.ts` `buildTubeCurve` (`:120`) builds `LineCurve3` legs joined by `QuadraticBezierCurve3` corners (`:168-170`) with radius `bendRadiusMm ?? max(radius*1.5, 12)` (`buildSweptTubeGeometry:219-220`). A quadratic bezier is **not** a circular arc, so its radius ≠ the elbow's bend radius, and it differs from whatever 2D drew.

Critically, **the one true plan-space fillet already exists but is unused by 2D**: `pipeTopology.ts` `filletPolyline` (`:211-266`) produces a real circular-arc fillet (setback clamped to half the shorter leg, center on the corner bisector, arc sampled into `segmentsPerCorner` chords), and `bendRadiusFromDiameterMm(d, k=1.5)` (`:183-188`) plus `buildRouteCornerNodes` (`:293`) classify corners. A grep confirms `filletPolyline` is consumed **only** by `three3d/` and its own test — never by `HvacPlanRenderer.ts`. So the W3c/W4 corner foundation is half-wired: it informs 3D but not 2D.

Smoothness is decided by **three unrelated formulas** (`refrigerantPipePairModel.ts:933` flexible span/12; `pipeJointGeometry.ts:219` `max(radius*1.5,12)`; `pipeTopology.ts:56,183` `1.5*outerDiameter`), and `pipeRoutingSettings.ts:42-43,66` documents `bendRadiusFactor` as "reserved/not consumed". There is **no single knob** for bend radius — symptom (a) not user-friendly / not adjustable.

Finally, `segmentMaterials` indexing (`refrigerantPipePairModel.ts:945-967`, `normalizeSegmentMaterialArray`) means inserting/deleting a vertex shifts every subsequent material; a hard segment can silently flip to flexible mid-edit and the corner geometry (L vs spline) changes under the user — symptom (d) "editing after assigning pipes is not smooth".

## Root Causes to Fix

- **No shared bend step.** 2D, 3D, and the unused `filletPolyline` each derive corners independently; nothing forces them to agree.
- **2D uses stroke-join rounding, not geometric arcs** (`HvacPlanRenderer.ts:1182`), so bends look like kinks and degrade at zoom (the polyline is also tessellated, not arc-native).
- **3D corner is a parabola, not a circular arc** (`pipeJointGeometry.ts:169`), so the bend radius is wrong and inconsistent with 2D.
- **Bend radius has no single source of truth**; `settings.bendRadiusFactor` is ignored.
- **Material is positionally indexed**, not identity-bound to segments, so edits corrupt corner geometry.
- **The data model lives in an untyped `properties` bag** (`types/index.ts:268`), re-normalized defensively on every read (`resolveRefrigerantPipeSpec:1212`), making the canonical centerline hard to reason about.

## Target Design

### Data model: line + circular-arc "arc-spline" centerline
A refrigerant bend is physically a constant-radius elbow tangent to two straight legs — exactly a **circular arc fillet** (G1 continuity, curvature pinned to the bend radius). This is the correct representation, NOT free splines (Catmull-Rom/NURBS) whose minimum radius cannot be controlled. Rationale vs alternatives: Bezier/Catmull "organic" curves wander in curvature and were the *cause* of the non-smooth complaint; arc-splines are what real MEP/CAD tools use and let 2D and 3D share one definition.

### One headless module: `pipeCenterline.ts`
Create a pure, framework-free module (no fabric/konva/three imports) that is the single source of truth:
- Input: `routePoints: Point2D[]`, a per-corner target `bendRadiusMm` (from `bendRadiusFromDiameterMm(outerDiameterMm, settings.bendRadiusFactor)`), and segment material info.
- Output: a **canonical centerline** = ordered list of typed primitives `{ type: 'line', a, b } | { type: 'arc', center, radius, startAngle, endAngle, cw }`, PLUS a flattened `Point2D[]` for renderers that want points.
- Core primitive (reuse the math already proven in `filletPolyline`): at corner with incoming dir `u`, outgoing dir `v`, target `r`: `halfAngle = angleBetween(-u, v)/2`; `setback = r / tan(halfAngle)` clamped to `min(r/tan, |inLeg|/2, |outLeg|/2)`; `effectiveRadius = setback * tan(halfAngle)`; center on the interior bisector at `effectiveRadius / sin(halfAngle)`; tangent points at `corner ± setback·legDir`. Reject/auto-relax corners where consecutive fillets would overlap.

**Refactor, don't fork:** lift the proven body of `pipeTopology.ts::filletPolyline` into `pipeCenterline.ts` as the arc generator, and have it emit *arc primitives* (not just chords) so 2D/3D can render arcs natively. `pipeTopology.ts` keeps `classifyNode` / `buildRouteCornerNodes` / `bendRadiusFromDiameterMm`.

### One bend-radius formula
`bendRadiusFromDiameterMm(outerDiameterMm, settings.bendRadiusFactor)` becomes the **only** source. Delete the local `max(radius*1.5,12)` in `pipeJointGeometry.ts:219` and the `span/12` Catmull sampling for bends; thread `bendRadiusFactor` from `pipeRoutingSettings` (make it a real consumed setting). 3D `buildTubeCurve` takes the same per-corner radius the 2D module computed.

### Renderers consume the centerline
- **2D (Fabric):** `HvacPlanRenderer.ts` `renderPipePolyline` either (a) builds a `fabric.Path` from the centerline arc primitives using SVG `A` (arc) commands — crisp at any zoom, no tessellation — or (b) renders the pre-filleted dense `Point2D[]` from the module. Prefer arc-native `fabric.Path`. Drop reliance on `strokeLineJoin:'round'` for bend smoothness.
- **3D (three.js):** `buildTubeCurve` replaces `QuadraticBezierCurve3` with a true circular arc in the bend plane (sample `THREE.ArcCurve`/an arc, or `CubicBezierCurve3` with the 0.5523·r kappa handle for a near-perfect quarter-circle), built from the centerline's arc center/radius/angles so it matches 2D by construction.

## Libraries & Dependencies

- **KEEP** `three`, `fabric`, `@turf/turf` (already installed) — no new top-level renderer.
- **EVALUATE / OPTIONAL** `@flatten-js/core` — a typed 2D CAD kernel (Segment/Arc/Circle, tangency, distance) that can host the fillet/offset math cleanly. Adopt **only** if you want the typed kernel; otherwise implement the fillet on the existing hand-rolled vector helpers (it's ~40 lines, already present in `filletPolyline`). If added: pin a `1.x` release, keep it confined to the headless module, and do **not** also push the same math through `@turf` (avoid two geometry stacks).
- **DO NOT ADD** `verb-nurbs`, `paper.js`, `pixi.js` — NURBS is overkill for constant-radius elbows; paper/pixi add a fourth renderer and worsen the fragmentation the user already complains about (symptom e).
- **DO NOT** route pipe bends through `utils/spline.ts` (Catmull/NURBS→SVG string). It is not the smooth-bend source and is a likely "wrong library" smell.

## Implementation Steps

1. **Create `packages/drawing-engine/src/components/canvas/hvac/pipeCenterline.ts`** (pure, no renderer imports). Define `CenterlineSegment` union (`line`/`arc`) and `PipeCenterline` (segments + flattened points + total length).
2. **Move the arc-fillet body from `pipeTopology.ts::filletPolyline`** into `pipeCenterline.ts` as `buildArcFilletCenterline(points, perCornerRadiusMm)`, returning arc primitives. Keep a thin `filletPolyline` wrapper in `pipeTopology.ts` (delegating, for backward compatibility) so existing `three3d` callers and the existing `pipeTopology.test.ts` keep passing.
3. **Add `resolveBendRadiusMm(outerDiameterMm)`** in `pipeCenterline.ts` calling `bendRadiusFromDiameterMm(outerDiameterMm, settings.bendRadiusFactor)`; make `pipeRoutingSettings.ts` actually consume `bendRadiusFactor` (remove the "reserved/not consumed" note at `:42-43`).
4. **Promote a typed route geometry.** In `refrigerantPipePairModel.ts`, add `segments: PipeSegment[]` (id + material + endpoint vertex ids) alongside `routePoints`, and make `resolveRefrigerantPipeSpec`/`...PairSpec` populate it. `segmentMaterials` stays as a derived view for back-compat but the canonical store becomes identity-bound (see Data Model section). Keep reads idempotent — no geometry mutation in this task.
5. **Wire 2D:** modify `HvacPlanRenderer.ts::renderPipePolyline` (`:1163`) to take the `PipeCenterline` and emit a `fabric.Path` of `M`/`L`/`A` commands (world→px via existing `toPx`). Remove the dependence on `strokeLineJoin:'round'` for bend smoothness (keep `round` joins only as a cosmetic fallback for the few non-arc paths).
6. **Wire 3D:** modify `three3d/pipeJointGeometry.ts::buildTubeCurve` (`:120`) to accept the centerline's per-corner arc params and build a true circular arc (replace `QuadraticBezierCurve3` at `:169`). Delete the local `max(radius*1.5,12)` default at `:219`; take radius from the shared resolver.
7. **Replace flexible Catmull bends for hard routes** in `refrigerantPipePairModel.ts::buildRefrigerantPipeSegmentPaths` (`:945`) with the arc-fillet centerline. Retain Catmull only if an explicit `'flexible'` material is still a product requirement; otherwise route everything through the arc model.
8. **Add adaptive arc sampling** for 3D (`sampleStepMm` much smaller through fillets than straights) so tight 90° elbows are not faceted — see `pipeJointGeometry.ts:227-231`.
9. **Update `three3d/buildHvacElementMesh.ts`** (consumes `finalPoints` → `buildSweptTubeGeometry`, ~`:446`) to pass the shared centerline/radius.
10. **Stop double-rounding:** ensure corners are filleted EITHER in 2D-feeding centerline OR in 3D `buildTubeCurve`, not both. Since the centerline is now shared, 3D should sweep the *already-canonical* centerline; remove any 2D `roundPolylineCorners` re-pass that would double-round (`refrigerantPipePairModel.ts` ~`:2418`).

## Data Model / Type Changes

```ts
// pipeCenterline.ts
export type CenterlineSegment =
  | { type: 'line'; a: Point2D; b: Point2D }
  | {
      type: 'arc';
      center: Point2D;
      radiusMm: number;
      startAngleRad: number;
      endAngleRad: number;
      clockwise: boolean;
      // tangent entry/exit points, for renderers that want explicit anchors
      from: Point2D;
      to: Point2D;
    };

export interface PipeCenterline {
  segments: CenterlineSegment[];
  /** Densely-sampled flattened polyline (arcs chorded) for point consumers. */
  flattened: Point2D[];
  totalLengthMm: number;
}

export function buildPipeCenterline(
  routePoints: Point2D[],
  perCornerBendRadiusMm: number | ((cornerIndex: number) => number),
  options?: { segmentsPerArc?: number; collinearToleranceDeg?: number },
): PipeCenterline;
```

```ts
// refrigerantPipePairModel.ts — identity-bound segment model
export interface PipeSegment {
  id: string;                 // stable across vertex insert/delete
  material: RefrigerantPipeMaterial; // 'hard' | 'flexible'
  startVertexId: string;
  endVertexId: string;
}
// RefrigerantPipeSpec gains:
//   segments: PipeSegment[];           // canonical, identity-bound
//   segmentMaterials: ...[];           // derived view, kept for back-compat
```

## UX & Interaction Requirements

This task is geometry/model only, but it must make the downstream UX possible:
- **Bends render as true constant-radius arcs** in 2D — visibly smooth, crisp at any zoom, no kink at the vertex.
- **2D and 3D bends match** at the same corner (same radius, same tangent points).
- **One adjustable bend-radius knob** (`settings.bendRadiusFactor`) changes both views consistently.
- The centerline API is cheap to recompute for a single route (used by the editor's live preview in the edit task) — keep `buildPipeCenterline` allocation-light and pure so it can run per-drag without store thrash.

## Acceptance Criteria

- `buildPipeCenterline` exists in `pipeCenterline.ts`, is pure (no fabric/konva/three imports), and emits arc primitives whose `radiusMm` equals the requested bend radius (clamped only where legs are too short).
- `HvacPlanRenderer.ts` renders pipe bends as `fabric.Path` arcs (or pre-filleted points) derived from `buildPipeCenterline`; grep shows `renderPipePolyline` no longer relies on `strokeLineJoin:'round'` to fake bends.
- `pipeJointGeometry.ts::buildTubeCurve` builds circular arcs (no `QuadraticBezierCurve3`) seeded from the same centerline; the local `max(radius*1.5,12)` default is gone.
- A test asserts that, for a 90° corner with given diameter and `bendRadiusFactor`, the 2D centerline arc radius and the 3D arc radius are equal within 1e-6.
- `settings.bendRadiusFactor` measurably changes both 2D and 3D bend radius; the "reserved/not consumed" note is removed.
- Inserting/deleting a vertex no longer flips a segment's material (identity-bound `segments`).
- Existing `pipeTopology.test.ts`, `pipeJointGeometry.test.ts`, `branchKitProposal.test.ts` still pass.

## Test Plan

- **Unit (vitest):** create `pipeCenterline.test.ts`:
  - Right-angle corner → one `line`/`arc`/`line` with `arc.radiusMm == requested` and tangent points at `setback = r/tan(45°) = r` along each leg.
  - Acute/obtuse corners → correct setback clamp; near-straight corner (≈180°) → no arc.
  - Short-leg corner → fillet clamped to `min(leg)/2`, no overlap with neighbor.
  - 2D-vs-3D radius parity test (the acceptance bullet).
  - Round-trip: `flattened` points stay within `radius*tolerance` of the analytic arc.
- **Regression:** keep `pipeTopology.test.ts` green via the delegating `filletPolyline` wrapper.
- **Visual/manual:** use **Claude Preview** (`mcp__Claude_Preview__preview_*`) on the Next.js `apps/web` canvas to draw an L-shaped and a Z-shaped refrigerant run and confirm crisp arc bends at 100% and at high zoom. Use the **three.js MCP** (`mcp__de970454...__show_threejs_scene`) or the in-app 3D view to confirm the same corner is a smooth swept arc, not a parabola. Run **/verify** to confirm the app launches and a drawn pipe renders without console errors.

## Edge Cases & Pitfalls

- **Hairpin / ≈0° corners:** cannot fillet — pass the vertex through unchanged (mirror `filletPolyline:233`).
- **Consecutive tight corners:** clamp each setback to half its shorter leg so arcs never overlap; if they still would, reduce radius rather than producing self-intersecting geometry.
- **Collinear vertices:** treat as straight (collinear tolerance), emit a single `line`.
- **Very short legs / dedup:** dedupe consecutive coincident points before filleting (`dedupeConsecutivePoints`).
- **Do NOT** keep two libraries fighting over the same corner — the centerline is the single source; 2D and 3D only *render* it.
- **Do NOT** double-round (2D arc + 3D bezier over already-arced points) — fillet once in the shared centerline.
- **Do NOT** recompute the whole route on every drag frame downstream — the centerline must be cheap; heavy per-tick rebuilds are the editor task's concern, but keep this function allocation-light.
- **Do NOT** revive `utils/spline.ts` or pull in NURBS for constant-radius elbows.
- **Frenet/twist** at the straight→arc transition is a known 3D issue — **out of scope here** (T-3D); this task only guarantees the centerline and a circular-arc corner.

## Dependencies on Other Tasks

- **Consumed by T-edit (pipe micro-editing UX):** the editor reads `buildPipeCenterline` for live ghost previews and binds material/fitting to the new identity-bound `segments`; it must not regress the single-source-of-truth.
- **Consumed by T-3D (three.js swept tube / twist / CSG):** T-3D takes the shared centerline + per-corner arc params; this task removes the local 3D bend-radius formula it must replace.
- **Coordinated with T-branch-kit:** the branch-kit connection route should pass through this same arc-fillet centerline so the drop blends instead of meeting at a sharp overlay; the kit's branch-outlet direction fix is in that task but should consume this module's bend generation.
- **Aligns with T-canonical-transforms (W5/R3):** centerline math stays in WORLD mm; renderers apply the canonical `worldToScreen`/`worldTo3D` transforms.