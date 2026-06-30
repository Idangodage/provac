## Objective

Make refrigerant pipes connect to indoor-unit ports the way a real fitter expects: the pipe endpoint lands exactly on the port tip, leaves the port along the port's true outward direction, blends into the route through a smooth constant-radius arc (no gap, no kink, no diagonal-into-axis mismatch), and stays connected and clean when either the pipe or the unit is moved/edited. The port pose (position + direction + gas/liquid spacing) must be derived from ONE model source of truth — never reconstructed from rendered Fabric pixels — and the connection geometry must be produced by a single headless centerline module shared by the 2D Fabric renderer, the Konva interaction overlay, and the three.js sweep, so 2D and 3D never disagree at the joint. Build on `unitPipePortModel.ts`.

## Current State & Why It Hurts

The connection-to-unit path today is fragile in four concrete ways, each mapped to a user symptom:

- **Port geometry is internally inconsistent (gap at every port).** `getUnitPipePortRenderMetrics` (`packages/drawing-engine/src/components/canvas/hvac/unitPipePortModel.ts:64-89`) computes `collarEndX = (localX + flangeThickness*0.35) + collarLength` but `pipeStartX = localX + collarLength - flangeThickness*0.15` (lines 73-75). These differ by `flangeThickness*0.5`, so the drawn pipe stub does not begin where the collar ends — a small but real seam at the collar→pipe boundary on every unit. The connection point the pipe snaps to (`getUnitPipePortConnectionLocal` → `pipeStartX`, lines 99-105) and the visible stub start therefore disagree. → symptom (b) connection distortions.
- **Gas/liquid spacing differs across the three coordinate systems that must meet.** Unit ports use a fixed 42mm center spacing (`PIPE_PORT_CENTER_SPACING_MM = 42`, `unitPipePortModel.ts:149`, `gasOffsetY=-21`/`liquidOffsetY=+21`, lines 157-158); ducted/cassette units use *different* spacing formulas; the pipe pair wants `gasR + liquidR + pipeGap`. When a 42mm-spaced bundle meets a wider route, `buildUnitPortBundleConnection` (`refrigerantPipePairModel.ts:1339`) fabricates SEPARATE synthetic `gasFieldPoint`/`liquidFieldPoint` pushed out by `spacingDeltaMm/2` and re-spaced (lines 1387-1397), and `repairDegenerateBundlePoints` re-spaces yet again. So the two pipes splay/converge between the port tips and the route — visible distortion. → symptom (b).
- **The approach is an off-axis straight, not a smooth blend.** Ports report `localDirection {x:1,y:0}` (right) but the route may arrive at any angle; there is no arc/fillet that blends the port-axis stub into the first route leg. 2D strokes a sharp polyline with `strokeLineJoin:'round'` (cosmetic only) while 3D fillets corners with a `QuadraticBezierCurve3` whose radius is NOT the bend radius (`pipeJointGeometry.ts:168-171`, default radius `max(radius*1.5,12)` at :219-220). The one true plan-space fillet (`pipeTopology.filletPolyline`) is not consumed at the port junction. So the port-to-route corner is a kink in 2D and an approximate parabola in 3D. → symptom (c) bends/branch-kit not smooth.
- **Connections are reconstructed from rendered pixels and silently mutate on read.** `findNearestRenderedRefrigerantPipeBundleTarget` (`HvacPlanRenderer.ts:722-1089`) re-pairs gas/liquid by reading back Fabric object centers through `calcTransformMatrix()/MM_TO_PX` with heuristic tolerances; `resolveRefrigerantPipePairSpec` heals endpoints from the live scene and TRANSLATES the whole route by a delta on read (`refrigerantPipePairModel.ts:1148-1168`). So the same stored element resolves to different geometry depending on neighbours and float round-trips, and an endpoint can drift off the port after an edit. → symptoms (b), (d).

Editing-time behaviour compounds this: endpoint vertices are explicitly **non-draggable** in the Konva overlay (`PipeKonvaInteractionLayer.tsx:700-749`), so a user cannot re-grab and re-snap a connection at all, and edit-time snapping is grid-only on drag-end with **no port re-snap** (`PipeKonvaInteractionLayer.tsx:308-311,512-514`), far weaker than the draw-time `snapPoint` (`useRefrigerantPipeTool.ts:484-615`). → symptoms (a), (d).

## Root Causes to Fix

- Port endpoint math (`pipeStartX` vs `collarEndX`) is derived from different bases, so the snap point and the drawn stub disagree.
- There is no single canonical "bundle spacing" — at least four spacings (42mm fixed, radius-driven ducted/cassette, 94/87mm branch-kit, `gasR+liquidR+gap` pair) must meet at one joint, papered over by synthetic field points.
- No arc-fillet blend between the port axis and the first route leg; 2D/3D each derive the corner differently and neither honors the real bend radius.
- Connection pose is reconstructed from rendered Fabric objects and re-healed (route-translated) on every resolve, making the connection non-idempotent.
- Endpoint connections cannot be edited/re-snapped, and edit-time snapping lacks the port magnetism the draw tool has.

## Target Design

**1. Canonical port pose from the model (single source of truth).** Add a pure function `getUnitPipePortPose(element, kind)` to `unitPipePortModel.ts` that returns, in WORLD mm, the port `{ point, direction, outerDiameterMm, elevationMm }` derived directly from the element's transform and the port's local offset — never from rendered objects. First fix the seam: make `pipeStartX === collarEndX` (use one base: `collarStartX = localX + flangeThickness*0.35`, `collarEndX = collarStartX + collarLength`, `pipeStartX = collarEndX`). The pipe-connection local point becomes exactly the stub start, and the stub visibly meets the pipe with zero gap.

**2. One canonical bundle spacing.** Introduce `resolveCanonicalBundleSpacingMm(gasOuterMm, liquidOuterMm, pipeGapMm)` in a shared module (e.g. `refrigerantPipeDimensions.ts`) and have unit/ducted/cassette port models AND the pair builder consume it, so the port spacing equals the route spacing and `buildUnitPortBundleConnection` no longer needs to fabricate divergent field points. Where a legacy unit must keep 42mm, transition the spacing geometrically inside the arc-blend (see §3) rather than splaying the straight legs.

**3. Smooth arc-fillet approach (the heart of this task).** Create a headless module `pipeUnitConnection.ts` (pure, no Fabric/Konva/three imports) that, given the canonical port pose and the first route leg, builds the connection centerline as **line → circular-arc fillet → line** using the standard tangent-arc construction:
- half-angle `theta = angleBetween(-portDir, firstLegDir)/2`
- tangent setback `d = r / tan(theta)`, arc center on the interior bisector at `r / sin(theta)` from the corner, tangent points at `corner ± d·legDir`
- clamp `r` to `min(bendRadiusMm, |portStub|/2, |firstLeg|/2)` so the fillet never overruns the stub or the first leg.

`bendRadiusMm` comes from ONE formula (`pipeTopology.bendRadiusFromDiameterMm`, driven by `settings.bendRadiusFactor` which is currently unused). Emit an ordered `{type:'line'|'arc'}[]` centerline. This is the **same representation** consumed by: the 2D Fabric path (SVG `A` arc command — no tessellation), the Konva preview (`Konva.Path` with the same `A` data or `ctx.arc`), and the 3D sweep (replace the `QuadraticBezierCurve3` port corner in `buildTubeCurve` with a true arc sampled from the identical center/radius/angle). Result: identical bend in plan, overlay and 3D.

**Why arc-spline, not Bezier/Catmull-Rom:** a refrigerant elbow is physically a constant-radius bend tangent to two legs (G1 continuity, curvature `1/r` inside the arc). Catmull-Rom/Bezier curvature wanders and you cannot pin the minimum radius to the pipe's bend radius — that mismatch is exactly the reported non-smooth/distorted joint. G2 continuity is unnecessary for pipe. Reject `verb-nurbs`/`paper.js` as renderers; use `@flatten-js/core` purely as the math kernel for the tangent-arc + snap queries.

**4. Idempotent resolve + explicit reconnect.** Split "pure read of stored geometry" from "reconcile against scene". `resolveRefrigerantPipePairSpec` must NOT translate the route on read (`refrigerantPipePairModel.ts:1148-1168`); instead expose `reconnectPipeEndpointToPort(element, port)` invoked only on an explicit edit/commit (draw commit, endpoint drag-end, or unit-move propagation), which rewrites the stored endpoint connection + rebuilds the approach. Stop reconstructing connections from rendered Fabric objects for the unit-port case — read the pose from `getUnitPipePortPose`.

**5. Editable, re-snapping endpoints.** Make endpoint vertices draggable in the Konva overlay with live **port magnetism**: within a pixel tolerance (converted through zoom) of any unit port, snap the dragged endpoint to the port pose and show a snap indicator; on drag-end call `reconnectPipeEndpointToPort`. Reuse the draw tool's snap candidate logic, not the weaker grid-only edit path. During the drag, render only a lightweight ghost of the changed approach + endpoint — commit to the store once on drag-end (do not call `updateHvacElement` every 10ms tick).

## Libraries & Dependencies

- **Add `@flatten-js/core`** — headless TS 2D kernel (Segment/Arc/Circle, nearest-point, intersection, tangency). Use for the tangent-arc fillet construction and port snap queries. ~40 lines of fillet code on its primitives (it has no one-call `fillet()`). Pin a current 1.x. No renderer coupling, tree-shakeable, tiny next to three.
- **Keep `@turf/turf` ^7.3** — already installed; acceptable fallback for `nearestPointOnLine` if you choose not to add flatten-js, but do not put new mm-space pipe math in it (GeoJSON allocation / lng-lat naming). Prefer flatten-js.
- **Keep `three` ^0.183** — modify the port-approach corner in `buildTubeCurve` to a true arc; do not add r3f/three-stdlib for this task.
- **Keep `konva`/`react-konva`** — reuse the existing overlay for preview + snap indicator. Do NOT introduce a second transform or a third rendering library. This task must not widen the Fabric/Konva split.
- **Do NOT add** `verb-nurbs`, `paper.js`, or route pipe geometry through `utils/spline.ts` (Catmull-Rom/NURBS) — wrong tool for constant-radius elbows and the source of the "wrong library" smell.

## Implementation Steps

1. **Fix the port seam.** In `unitPipePortModel.ts:64-89`, set `collarStartX = port.localX + flangeThickness*0.35`, `collarEndX = collarStartX + collarLength`, `pipeStartX = collarEndX`, `pipeEndX = pipeStartX + port.length`. Update `getUnitPipePortConnectionLocal`/`getUnitPipePortEndpointLocal` accordingly. Add a unit test asserting `pipeStartX === collarEndX`.
2. **Add `getUnitPipePortPose(element, kind): { point, direction, outerDiameterMm, elevationMm }`** to `unitPipePortModel.ts`, rotating the local connection point/direction by element rotation and translating by world center (mirror `resolveRefrigerantBranchKitConnectionIdentity` semantics). World mm only; no Fabric readback.
3. **Add `resolveCanonicalBundleSpacingMm(gasOuterMm, liquidOuterMm, pipeGapMm)`** to `refrigerantPipeDimensions.ts`; route `unitPipePortModel.ts`, `ductedIndoorUnitModel.ts`, `ceilingCassetteModel.ts` and the pair builder through it. Replace per-file spacing constants where safe; keep a per-unit override only where a real product requires it.
4. **Create `packages/drawing-engine/src/components/canvas/hvac/pipeUnitConnection.ts`** (pure): export `buildPortApproachCenterline(portPose, firstRouteLeg, bendRadiusMm)` returning an ordered `Array<{type:'line', a, b} | {type:'arc', center, radius, startAngle, endAngle, ccw}>` using the tangent-arc formula (§3) via `@flatten-js/core`. Pull `bendRadiusMm` from `pipeTopology.bendRadiusFromDiameterMm`, honoring `settings.bendRadiusFactor`.
5. **Create `packages/drawing-engine/src/components/canvas/hvac/pipeUnitConnection.test.ts`** (vitest): tangency (arc start/end tangent to legs within 1e-6), radius honored, clamp on short legs, zero-angle (straight) passthrough, 90° and 45° approaches.
6. **2D Fabric render:** in `HvacPlanRenderer.ts` pipe rendering, emit the approach centerline as a `fabric.Path` with SVG `A` arc commands at the port junction (stop relying on `strokeLineJoin:'round'` for the corner). Do not tessellate the arc.
7. **3D sweep:** in `pipeJointGeometry.ts:buildTubeCurve`, replace the `QuadraticBezierCurve3` at the port-approach corner (lines 168-171) with a true circular arc sampled from the same center/radius/angle the 2D module produced; remove the local `max(radius*1.5,12)` default for this corner in favor of the shared bend radius.
8. **Idempotent resolve:** in `refrigerantPipePairModel.ts`, gate the route-translation heal (lines 1148-1168) behind an explicit `reconnectPipeEndpointToPort(element, port)` action; make `resolveRefrigerantPipePairSpec` a pure read. For unit-port connections, source the pose from `getUnitPipePortPose` instead of `findNearestRenderedRefrigerantPipeBundleTarget`.
9. **Editable endpoints + port magnetism:** in `PipeKonvaInteractionLayer.tsx`, make endpoint vertices draggable (remove the `{!handle.endpoint}` lock at 700-749); add live port snap (reuse `useRefrigerantPipeTool.snapPoint` candidate logic, not the grid-only path at 308-311). Show a snap indicator at the snapped port. Render a ghost of the approach during `onDragMove`; call `reconnectPipeEndpointToPort` + `updateHvacElement` + `saveToHistory` once on `onDragEnd` only.
10. **Unit-move propagation:** when an indoor unit moves, call `reconnectPipeEndpointToPort` for pipes whose endpoint connection references it, so the approach re-blends and the endpoint re-lands on the moved port (one history entry).
11. **Run vitest + `/verify` + the three.js MCP scene** to confirm 2D and 3D agree at the joint.

## Data Model / Type Changes

```ts
// unitPipePortModel.ts
export interface UnitPipePortPose {
  point: Point2D;            // world mm, the stub-start connection point
  direction: Point2D;        // world mm, unit outward port axis (normalized)
  outerDiameterMm: number;
  elevationMm: number;
  kind: "gas" | "liquid";
}
export function getUnitPipePortPose(
  element: HvacElement, kind: "gas" | "liquid"
): UnitPipePortPose | null;

// pipeUnitConnection.ts
export type CenterlineSeg =
  | { type: "line"; a: Point2D; b: Point2D }
  | { type: "arc"; center: Point2D; radius: number;
      startAngle: number; endAngle: number; ccw: boolean };

export function buildPortApproachCenterline(
  portPose: UnitPipePortPose,
  firstRouteLeg: { from: Point2D; to: Point2D },
  bendRadiusMm: number,
): CenterlineSeg[];

// reconcile, not resolve-time mutate
export function reconnectPipeEndpointToPort(
  element: HvacElement, port: UnitPipePortPose,
): HvacElement; // returns element with rewritten endpoint connection + approach
```

The stored route stays canonical: `routePoints: Point2D[]` (world mm) + `startBundleConnection`/`endBundleConnection`. The approach centerline is DERIVED, never persisted. Add an optional `bendRadiusFactor`-driven radius to the connection record only if needed for round-trip; otherwise recompute from spec.

## UX & Interaction Requirements

- Dragging a pipe endpoint near a unit port shows a magnetic **snap indicator** (highlighted port + endpoint jumps onto the port tip) before release; releasing locks the connection.
- The pipe meets the port with **zero visible gap** and leaves along the port axis, blending into the route through a visibly smooth, constant-radius arc — no kink, no off-axis diagonal.
- Live drag shows a lightweight **ghost** of the changed approach (no whole-route rebuild, no stutter); the real geometry + one undo entry commit on release.
- Moving the unit drags the connected pipe end with it and re-blends the approach automatically.
- The bend looks **identical in plan, in the interaction overlay, and in 3D**.
- An inline length/angle readout near the active endpoint is desirable (reuse `formatting.ts`).

## Acceptance Criteria

- `getUnitPipePortRenderMetrics` satisfies `pipeStartX === collarEndX` (unit test); no collar→pipe seam in 2D or 3D.
- `getUnitPipePortPose` returns world-mm pose derived only from the model; no Fabric object readback on the unit-port connection path.
- `buildPortApproachCenterline` produces an arc tangent to both legs (≤1e-6 tangency error), with radius = clamped `bendRadiusFromDiameterMm`, and degrades to a straight line at ~0° approach.
- 2D, Konva preview, and 3D all consume the same `CenterlineSeg[]`; a visual diff at a 90° and a 45° port approach shows matching curves across views.
- `resolveRefrigerantPipePairSpec` is idempotent: resolving the same stored element twice yields identical geometry (no route translation on read). Round-trip test passes.
- Endpoint vertices are draggable and re-snap to ports; dragging produces exactly one undo entry.
- Moving a connected indoor unit keeps the pipe attached with a re-blended approach (one undo entry).

## Test Plan

- **Unit (vitest):** `pipeUnitConnection.test.ts` (tangency, radius, clamp, 0°/45°/90°, ccw correctness); `unitPipePortModel.test.ts` seam + pose tests; idempotent-resolve test in the existing pair-model test suite (resolve twice → deep-equal). Co-locate with the existing `pipeJointGeometry.test.ts` / `coordinateTransform.test.ts` style.
- **Visual/manual:** use **Claude Preview** (`mcp__Claude_Preview__*`) to drive the Next.js app — draw a pipe into a wall-mounted and a ducted unit at orthogonal and 45° angles, screenshot the joint, confirm zero gap + smooth arc; drag the endpoint and confirm magnetism; move the unit and confirm re-attach. Use the **three.js MCP** (`mcp__de970454-...__show_threejs_scene`) to render the same run in 3D and confirm the arc matches plan. Run **`/verify`** on the change before pushing.
- **Regression:** confirm branch-kit and pipe-pair drawing still resolve (this task only changes the unit-port approach + endpoint editing).

## Edge Cases & Pitfalls

- **Near-zero approach angle** (route already collinear with port axis): emit a single line, no arc (avoid divide-by-`tan(0)`).
- **Very short port stub or first leg:** clamp fillet radius; never overrun the stub into the unit body.
- **Gas/liquid spacing mismatch at legacy 42mm units:** transition spacing through the arc blend, not by splaying straight legs (do not reintroduce divergent `gasFieldPoint`/`liquidFieldPoint`).
- **Opposed port order** (gas/liquid crossing): keep the existing local over/under bypass; do not let the pair self-intersect at the port.
- **DO NOT** reconstruct the connection from rendered Fabric objects (`findNearestRenderedRefrigerantPipeBundleTarget`) for unit ports — read the model pose.
- **DO NOT** translate/heal the route inside `resolveRefrigerantPipePairSpec` on every read — gate behind explicit reconnect.
- **DO NOT** call `updateHvacElement` on every 10ms drag tick — ghost during drag, commit once on drag-end.
- **DO NOT** add a third rendering library or a second coordinate transform; consume the existing Fabric render + Konva overlay.
- **DO NOT** use Catmull-Rom/Bezier/NURBS for the elbow — use the constant-radius tangent arc so the bend radius is real and 2D/3D agree.

## Dependencies on Other Tasks

- **Shared with the swept-elbow / fillet task** (the W4 `pipeJointGeometry.ts` + `pipeTopology.filletPolyline` unification): the `CenterlineSeg[]` arc representation and `bendRadiusFromDiameterMm` MUST be the same primitive used by the general route-corner fillet work, not a parallel one. Coordinate so there is ONE arc-fillet implementation consumed by both the general corners and this port approach.
- **Depends on / coordinates with the snapping-unification task** (port/bundle magnetism at edit time mirroring `useRefrigerantPipeTool.snapPoint`) — reuse its renderer-agnostic snap core for endpoint re-snap.
- **Coordinates with the branch-kit task** (parametric tee + outlet-direction fix): both rely on the same canonical bundle spacing and arc-blend; align the spacing function and approach builder so kit-to-run and unit-to-pipe junctions blend identically.
- **Relies on the coordinate-transform canonicalization** (`coordinateTransform.ts` W5/R3): port pose and snap math should produce world-mm consumed via the canonical transforms, not inline `MM_TO_PX` round-trips.