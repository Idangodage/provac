> Self-contained engineering brief for the provacx repo, branch `feat/hvac-2d3d-precision`. You are the senior engineer (or coding agent) executing **T10 — Cross-renderer parity & verification harness**. This prompt closes a gap the architecture review found: every prompt (T2–T7) *asserts* "2D and 3D agree by construction" and "CSG is cached/pinned", but **nothing proves it**. T10 builds the tests that turn those assertions into guarantees. It is the **final merge gate** for the overhaul. All paths are absolute from the repo root `D:/myWorks/ProvacX/provacx/provacx`.

## 1. Objective

Build an automated verification harness that proves the core invariants of the overhaul hold, and wire it as a pre-merge
gate. Specifically: (a) a **cross-renderer parity test** that samples the one canonical centerline and asserts the Fabric
`Path`, the Konva sceneFunc/`Path`, and the three.js `ArcCurve` sampling all reproduce the **same mm-space points within
tolerance** — the only thing that actually validates "2D and 3D agree by construction"; (b) a **store-thrash guard** that
proves a drag commits to the store exactly once; (c) a **`three-bvh-csg` version-pin smoke test** that the union still
returns a `BufferGeometry` after any `three` bump; (d) an **idempotency/round-trip** assertion (shared with T9); and (e) a
scripted **visual diff** loop (2D screenshot vs 3D screenshot of the same bend) using Claude Preview. End state: a single
`pnpm --filter @provacx/drawing-engine test` run fails loudly if any renderer drifts, if a drag thrashes the store, or if
CSG silently degrades.

## 2. Current State & Why It Hurts

- **The parity claim is unverified.** T2–T7 all state the centerline is "the single source of truth" and that 2D/3D
  "agree by construction." But today there are **three different curves** for one corner (2D round-join + Catmull, 3D
  `QuadraticBezierCurve3` at `pipeJointGeometry.ts:169`, and the unused `pipeTopology.filletPolyline` at ~`:211`). After
  the overhaul they're supposed to collapse to one — **with no test, the next refactor silently re-forks them.**
- **`coordinateTransform.test.ts` guards dead code.** The existing round-trip test passes, but it guards a module that no
  live renderer imports. A green test today proves nothing about the shipped views.
- **The store-thrash fix is invisible to CI.** T1/T7 remove the ~100×/sec `updateHvacElement` + `regenerateElevations`
  during drag, but nothing asserts the commit count, so a regression (someone re-adds a per-tick write) won't be caught.
- **CSG is pre-release and version-coupled.** `three-bvh-csg ^0.0.18` is `0.0.x`, coupled to `three` internals; the
  existing `pipeJointGeometry.test.ts` even notes Node loads a separate `three` build so the union result's class
  identity differs (must duck-type `.isBufferGeometry`, never `instanceof`). A `three` bump can silently break the union
  or trigger the `mergeGeometries` fallback (which re-introduces interpenetration) with no alarm.

## 3. Root Causes to Fix

- Invariants are asserted in prose, not in tests.
- The one existing geometry/transform test guards a non-load-bearing module.
- No counter/spy proving the drag→commit contract.
- No guard on the fragile CSG dependency boundary.

## 4. Target Design

### 4.1 Canonical sampling helpers (test support)
Add a small test util `pipeCenterline.sampleForParity(centerline, stepMm): Point2D[]` (3D variant returns `{x,y,z}`),
producing a deterministic, evenly-arc-length-sampled point list from the **canonical** centerline T2 emits. All three
renderers' outputs are converted back to mm-space and compared against this reference.

### 4.2 Cross-renderer parity test (the key one)
`pipeRendererParity.test.ts`:
- Build a representative route (multi-bend, including a 90° elbow, an acute corner that triggers radius clamp, and a
  vertical riser for the 3D frame-seed case).
- Reference = `sampleForParity` of the canonical centerline.
- **Fabric**: parse the `fabric.Path` `A`-command path data the renderer produces (`toSvgPathData`), flatten to points,
  convert px→mm via `coordinateTransform.screenToWorld`, assert ≤ `tolMm` (e.g. 0.5 mm) Hausdorff/pointwise distance to
  reference.
- **Konva**: same for the Konva `Path`/sceneFunc output.
- **three.js**: sample `toCurvePath3D(...).getPoints(n)` and the actual `pipeJointGeometry` curve, project to the plane,
  assert ≤ `tolMm` to reference. This is what catches a `QuadraticBezierCurve3` sneaking back in (a quadratic bezier
  deviates from a true arc by a measurable amount at the apex — the test will see it).
- Run across zoom ∈ {0.25, 1, 4} and a non-1 paper/real ratio.

### 4.3 Store-thrash guard
`pipeDragThrash.test.ts`: spy on `updateHvacElement`, `saveToHistory`, `regenerateElevations`; simulate a 20-tick drag
gesture through `pipeInteractionCore` + `commitPipeCommand`; assert **0** `hvacElements`/`regenerateElevations` writes
mid-drag and **exactly 1** `saveToHistory` on release.

### 4.4 CSG version-pin smoke test
`csgUnionSmoke.test.ts`: build a minimal tee, call the union; assert the result is a geometry by **duck-typing**
(`result.isBufferGeometry === true` and it has a `position` attribute), **never** `instanceof THREE.BufferGeometry`
(class identity differs under the test's separate `three` build). Assert the `mergeGeometries` **fallback did not fire**
(expose a flag/throw from the union wrapper so the test can detect degradation). Pin `three-bvh-csg` to an exact version.

### 4.5 Idempotency / round-trip (shared with T9)
Re-export T9's `resolvePipeGeometry` idempotency + `save(load(x))===x` assertions here so the gate is one command.

### 4.6 Scripted visual diff (Claude Preview)
A documented (not necessarily CI) procedure using **Claude Preview MCP**: `preview_start` the dev server, script a
draw of the parity route, `preview_screenshot` the 2D canvas and the 3D/isometric view, `preview_eval` to dump the
resolved centerline from the store, and visually diff the bend. This is the human-facing backstop for the numeric test.

## 5. Libraries & Dependencies

- **KEEP `vitest ^4.1.9`** — the runner; extend existing patterns (`coordinateTransform.test.ts`, `pipeTopology.test.ts`,
  `pipeJointGeometry.test.ts`).
- **No new runtime dependency.** Parity math uses the same `@flatten-js/core` (T2) + `three` already present. A tiny
  Hausdorff/pointwise-distance helper is ~20 lines — do not add a geometry-test library.
- **Claude Preview MCP** for the visual loop (tooling, not a package).
- Pin **`three-bvh-csg`** to an exact version in `packages/drawing-engine/package.json`.

## 6. Implementation Steps

1. Add `sampleForParity` (2D + 3D) to the T2 centerline module (or a sibling test util).
2. Write `pipeRendererParity.test.ts` (§4.2) — Fabric vs Konva vs three vs canonical reference, across zoom + ratio.
3. Write `pipeDragThrash.test.ts` (§4.3) with store spies.
4. Wrap the CSG union so it can report whether the `mergeGeometries` fallback fired; write `csgUnionSmoke.test.ts` (§4.4);
   pin the exact `three-bvh-csg` version.
5. Re-export/centralize T9's idempotency + round-trip tests into the gate.
6. Add a `pnpm` script alias (e.g. `test:gate`) running the harness; document the Claude Preview visual-diff procedure in
   this folder.
7. Make the existing `coordinateTransform.test.ts` meaningful by asserting the **live** renderers consume it (a test that
   imports the same `ViewTransform2D` the renderers use and checks Fabric-matrix vs Konva-layer agreement to 6 dp).

## 7. Data Model / Type Changes

None (test-only). Add `sampleForParity` to the centerline module's public surface and a `{ usedFallback: boolean }`
return (or thrown error) on the CSG union wrapper so degradation is observable.

## 8. UX & Interaction Requirements

Developer-facing: one command (`pnpm --filter @provacx/drawing-engine test`) is the truth. The visual-diff procedure is
documented so a reviewer can eyeball a bend in 2D vs 3D in under a minute via Claude Preview.

## 9. Acceptance Criteria

- [ ] `pipeRendererParity.test.ts` passes: Fabric, Konva, and three.js sampled centerlines all match the canonical
      reference within `tolMm` across zoom {0.25,1,4} and a non-1 paper/real ratio — and **fails** if a
      `QuadraticBezierCurve3` (or `strokeLineJoin:'round'`-only path) is reintroduced for a corner.
- [ ] `pipeDragThrash.test.ts` passes: 0 store/elevation writes mid-drag, exactly 1 history entry on release.
- [ ] `csgUnionSmoke.test.ts` passes: union returns a duck-typed `BufferGeometry`; the `mergeGeometries` fallback did not
      fire; `three-bvh-csg` is pinned exactly.
- [ ] Idempotency + `save(load(x))===x` (from T9) run as part of the same gate.
- [ ] `coordinateTransform.test.ts` now asserts agreement between the **live** Fabric and Konva transforms (not a dead
      module).
- [ ] The Claude Preview visual-diff procedure is documented and reproducible.

## 10. Test Plan

This prompt *is* the test plan; its deliverables are tests. Validate the harness itself by **fault injection**:
- Temporarily reintroduce a `QuadraticBezierCurve3` corner → `pipeRendererParity` must go red.
- Temporarily add a per-tick `updateHvacElement` in the drag path → `pipeDragThrash` must go red.
- Temporarily force the CSG `mergeGeometries` fallback → `csgUnionSmoke` must go red.
- Temporarily desync the Konva layer transform → the coordinate-parity test must go red.
Each injected fault must be caught; revert after confirming.

## 11. Edge Cases & Pitfalls

**Edge cases:** acute corners that clamp the bend radius (parity must still hold on the clamped arc); vertical risers
(3D initial-normal seed — assert no twist at the seam); near-collinear corners (no arc; all renderers draw a straight
line); very large routes (keep sample step coarse enough to stay fast in CI).

**Do NOT:**
- Do NOT compare raw path-data strings — compare **sampled points in mm-space** (string formatting differs per renderer).
- Do NOT use `instanceof` for the CSG result — duck-type `.isBufferGeometry` (class identity differs under the test's
  separate `three` build, per the existing `pipeJointGeometry.test.ts` note).
- Do NOT let the parity tolerance be so loose it accepts a quadratic bezier — set `tolMm` below the bezier-vs-arc apex
  deviation for the test radii.
- Do NOT keep `coordinateTransform.test.ts` guarding a module no renderer imports — it must assert the live transform.

## 12. Dependencies on Other Tasks

- **Runs last / continuously** — it gates T1–T8 once their interfaces exist. The parity test depends on T2's centerline +
  T3's three.js arc, the thrash guard on T1's command/commit boundary, the CSG smoke test on T3/T4's scoped+cached union.
- **Shares the idempotency/round-trip tests with T9.**
- After it is green, it is the **standard pre-merge gate** for any future pipe-system change.
