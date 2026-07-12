# HVAC Refrigerant-Pipe System — Engineering Overhaul Prompt Set

Repo: `provacx` · Package: `@provacx/drawing-engine` · Branch: `feat/hvac-2d3d-precision`

This folder contains a set of **self-contained engineering prompts** — one per task — for overhauling the
refrigerant-pipe drawing/editing/rendering system so that pipe laying, smooth bends, branch-kit and indoor-unit
connections, tap-ins, and post-draw micro-editing become smooth, distortion-free, and user-friendly.

Each `T*.md` is written to be handed **directly** to a senior engineer or an autonomous coding agent. They were
produced from a deep, evidence-based audit of the actual source (every claim carries `file:line` references) plus
research into modern 2D/3D CAD techniques, then reconciled by an architect pass for a single coherent stack.

---

## TL;DR — the diagnosis

Your symptoms map to four structural root causes, all confirmed in the code:

| Symptom you reported | Root cause found in the code |
|---|---|
| Pipe **connection distortions** | Two independent, hand-synced coordinate transforms (Fabric vs Konva); connections reconstructed from **rendered pixels** (`HvacPlanRenderer.findNearestRenderedRefrigerantPipeBundleTarget`), not the model; the canonical `coordinateTransform.ts` is **dead** (imported only by its own test). |
| **Bends not smooth / inconsistent 2D↔3D** | Three different curves for one corner: 2D `strokeLineJoin:'round'` + Catmull-Rom; 3D `QuadraticBezierCurve3`; and the *real* arc fillet `pipeTopology.filletPolyline` that **nobody in 2D consumes**. No single bend definition; `bendRadiusFactor` setting is declared but ignored. |
| **Editing not smooth** after drawing | Every drag tick (~100×/sec) writes the whole pipe to the store + `JSON.stringify` diff + `regenerateElevations`, fanning out a full-document re-sync across **two uncoordinated render loops** (Fabric rAF + Konva reconciler). |
| **Not user-friendly / "wrong library"** | Pipe interaction is split across **two 2D engines**: Fabric draws the pipe, Konva edits a **localStorage-flag-gated subset** (off by default, no endpoints / no pipe-pairs / no branch kits). `three-mesh-bvh` is a dependency with **zero imports** (dead weight). `utils/spline.ts` NURBS util is unused on the pipe path. |

**The fix in one sentence:** make **Konva** the single owner of all pipe interaction, **Fabric** the static-document
backdrop, derive **all** geometry (2D + 3D) from **one headless arc-fillet centerline** module, route everything through
**one** coordinate transform, and **commit to the store once per gesture** (not once per frame).

---

## The prompts

| ID | File | Goal | Owns |
|----|------|------|------|
| **T1** | [T1-foundation-unify-2d-stack.md](T1-foundation-unify-2d-stack.md) | Unify the 2D stack (Konva = interaction, Fabric = backdrop), make `coordinateTransform.ts` load-bearing, add transient drag channel, define the tool/command architecture. | Engine decision · single transform · store-thrash fix |
| **T2** | [T2-pipe-centerline-bend-model.md](T2-pipe-centerline-bend-model.md) | One canonical **arc-fillet centerline** + typed segment/corner model that 2D and 3D both consume; **idempotent resolve** (stop healing-on-read). | Centerline data model · bend math |
| **T3** | [T3-3d-pipe-elbow-rendering.md](T3-3d-pipe-elbow-rendering.md) | Rebuild three.js geometry around the shared centerline — true arcs, clean frames, scope CSG to tees + cache, wire `three-mesh-bvh`. | 3D geometry · CSG cache · BVH |
| **T4** | [T4-branch-kit-modeling.md](T4-branch-kit-modeling.md) | Branch kits as first-class fittings with typed ports + **one canonical bundle-spacing function**; smooth tangent transitions. | Branch kits · bundle spacing |
| **T5** | [T5-indoor-unit-connection.md](T5-indoor-unit-connection.md) | Clean, smooth pipe→indoor-unit-port connections that stay valid through edits. | Unit-port connection |
| **T6** | [T6-tap-in-existing-pipe.md](T6-tap-in-existing-pipe.md) | Tap a new pipe into an existing run — split, auto-insert tee, keep topology flow-connected; `rbush` target search. | Tap-in / real tee topology |
| **T7** | [T7-micro-editing-ux.md](T7-micro-editing-ux.md) | CAD-grade post-draw editing: grips, insert/delete vertex, bend handles, magnetic snapping, live ghost, one-step undo. | Edit-UX affordances |
| **T8** | [T8-library-dependency-audit.md](T8-library-dependency-audit.md) | Executed dependency right-sizing + the add/keep/replace/remove plan + final gates. | Dependency cleanup (runs last) |
| **T9** | [T9-schema-migration-persistence.md](T9-schema-migration-persistence.md) | *(gap-closure)* Versioned save schema migration (`v1→v2` typed `routePoints`/segment identity) + idempotent-resolve persistence hardening + round-trip tests. | Schema migration |
| **T10** | [T10-parity-verification-harness.md](T10-parity-verification-harness.md) | *(gap-closure)* Cross-renderer **parity test** proving 2D/Konva/3D agree on every bend, CSG version-pin smoke test, store-thrash guard, idempotency test. | Verification harness |

> T9 and T10 close gaps the architect review found falling *between* the eight feature prompts. T1–T8 were generated
> from the code audit; T9–T10 were authored to make the cross-cutting work explicitly owned.

---

## ⚖️ Authoritative Library Decision Matrix

**This matrix supersedes any hedging inside individual prompts.** Where T2/T3 say "evaluate `@flatten-js/core`",
the decision is **ADD** — adopt it as THE single 2D geometry kernel. Adopting it in some tasks and hand-rolling in
others would re-create the duplicated, divergent vector math the whole effort exists to eliminate.

| Feature | Today | Decision | Action | Why |
|---|---|---|---|---|
| 2D static document (walls/rooms/dims/objects, idle pipe backdrop) | `fabric ^6` | `fabric ^6` (v7 deferred) | **keep** | Correct retained-mode renderer for the static plan. Demote it from owning *any* pipe interaction handles. |
| Interactive pipe layer (draw + edit + grips + ghost) | split: Fabric draws / Konva edits (flag-gated, off) | `konva ^9.3` + `react-konva ^18.2` | **keep + promote** | Node-based hit-testing/dragging beats Fabric's whole-object transform for parametric polylines; `Konva.Path` supports native `A` arc commands. Becomes the **single** pipe interaction owner. |
| Headless 2D CAD geometry kernel (arc fillet, tangency, nearest-point, snapping) | hand-rolled vector math duplicated 4+ times | **`@flatten-js/core`** (pin 1.x) | **add** | Zero-dep, TS-native, ESM, tiny next to three. No built-in `fillet()` — implement the ~40-line line+arc tangent formula on its primitives. **Pick ONE kernel.** |
| Arc-fillet bend geometry (the shared centerline) | 3 different curves (round-join, Catmull, QuadraticBezier) | one `pipeCenterline`/`filletPolyline` module on `@flatten-js` | **replace** | Collapse to ONE constant-radius arc representation driven by `bendRadiusFactor`. Round corners **once**. |
| 3D sweep / elbows / tee sampling | `three ^0.183` (Tube + QuadraticBezierCurve3) | `three ^0.183` (Tube + `LineCurve3` + `THREE.ArcCurve`) | **keep** | Swap the quadratic-bezier corner for a true circular arc seeded from the shared center/radius/angle. (Note: `computeFrenetFrames` is minimal-rotation, not pure Frenet — the real risk is the start-seam + vertical-riser normal seed.) |
| 3D boolean union (genuine tee/saddle/reducer only) | `three-bvh-csg ^0.0.18` (runs per-build) | `three-bvh-csg ^0.0.18` (exact pin) | **keep + scope down** | Use **only** for real axis-intersection fittings; **never** for elbows/straight runs (a swept Tube is already watertight). Memoize by stable fitting signature. Treat `mergeGeometries` fallback as an **error**. |
| 3D accelerated picking + clash **verification** | `three-mesh-bvh ^0.9.10` (**zero imports — dead**) | `three-mesh-bvh ^0.9.10` | **keep + wire up** | `computeBoundsTree` + `acceleratedRaycast` for fast 3D pick/hover; `shapecast` for clash verification. Already paid for (pulled transitively). Don't use CSG to test overlap. |
| Spatial index (tap-in target search + clash broad-phase) | hand-rolled O(segments×obstacles) loops | **`rbush`** | **add** | Pure-JS dynamic R-tree (already transitive via turf). Broad-phase bbox query + existing narrow-phase = same results, removes the scaling cliff. Don't use `flatbush` (static index, wrong for a live scene). |
| Geospatial / nearest-point where convenient (room/clash polygons) | `@turf/turf ^7.3` (shipped, largely unused on pipe path) | `@turf/turf ^7.3` | **keep + right-size** | Acceptable for `nearestPointOnLine` snap ranking; **prefer `@flatten-js`** for mm-space arc/fillet math (turf is GeoJSON/lng-lat, allocates per call). Never in uncached per-frame loops. |
| State store + transient drag channel + history | `zustand ^4.5` (full map + `JSON.stringify` diff + `regenerateElevations` every 10ms) | `zustand ^4.5` (+ transient drag slice) | **keep** | Live drags must **not** write `hvacElements`/`regenerateElevations` per tick. Commit + `saveToHistory` only on drag end. Promote `routePoints` out of the untyped `properties` bag. |
| Hand-rolled Catmull/Bezier/NURBS→SVG util | `utils/spline.ts` (not wired to pipe path) | none | **remove (quarantine)** | Outputs SVG strings, never feeds three or the 2D pipe path. The prime "wrong/duplicated tooling" smell. Keep only if a separate freehand-annotation tool needs it; **never** for pipe centerlines. |
| Canonical coordinate transform (mm ↔ px ↔ 3D) | `coordinateTransform.ts` (**dead**, test-only importer) | `coordinateTransform.ts` made load-bearing | **keep + wire up** | Route `HvacPlanRenderer`, `PipeKonvaInteractionLayer`, `buildHvacElementMesh`, `IsometricViewCanvas` through it. |
| 4th renderer (PixiJS), competing scene graph (Paper.js) | none | none | **reject** | Not GPU-bound on 2D; Pixi has no CAD primitives; Paper.js is a 3rd/4th scene graph. Borrow Paper's *segment+handleIn/handleOut data-model idea* only. |
| Graph auto-layout (elkjs/dagre), NURBS (verb-nurbs), r3f, WASM routing (libavoid-js) | none | none | **reject** (libavoid = flagged Tier-3 spike only) | elk/dagre relocate nodes (wrong for fixed MEP coords); verb-nurbs is heavy/wrong (bends are arcs); r3f is a rendering rewrite. `libavoid-js` only worth a *flagged spike* for orthogonal auto-routing **after** the core split is fixed. |

### Net dependency change
- **Add:** `@flatten-js/core`, `rbush`  → `pnpm --filter @provacx/drawing-engine add @flatten-js/core rbush`
- **Wire up (already installed, currently dead):** `three-mesh-bvh`, `coordinateTransform.ts`
- **Scope down:** `three-bvh-csg` (tees only, cached, pinned), `@turf/turf` (room/clash only)
- **Remove from pipe path:** `utils/spline.ts`, the dual-engine Fabric pipe handles, the localStorage `hvac.pipe.engine` gate
- **Do NOT add:** `pixi.js`, `paper`, `verb-nurbs`, `elkjs`, `dagre`, `@react-three/fiber`, `flatbush`

---

## 🔢 Recommended build sequence

```
T1  ──►  T2  ──►  ┌─ T3 ─┐  ──►  ┌─ T4 ─►  T5 ─┐
(+ wire   (+ T9    │      │       │           │
 transform migration│ T7  │       └─►  T6 ─────┘  ──►  T8 (cleanup + final gates)
 + store)  ships    └──────┘                          (+ T10 parity/verify gate)
           with T2)
```

1. **T1 first — blocks everything.** Resolves the dual-engine split + per-tick store thrash + dead transform. Nothing
   downstream is coherent until these land (they are the root of symptoms *a/b/d*).
2. **T2 second — the data model every geometry task consumes.** Author `pipeCenterline` on `@flatten-js`, own the
   idempotent-resolve fix. **T9 (schema migration) ships *with* T2** because T2 changes the stored shape.
3. **T3 + T7 in parallel after T2** (different layers: 3D mesh vs 2D interaction; both consume T2's centerline).
4. **T4 → then T5/T6** (T4 owns bundle-spacing which T5 consumes; T6 flips on real-tee topology + `rbush`).
5. **T8 last** — executed cleanup/right-sizing of what the earlier tasks unified.
6. **T10 is the final gate** — run its parity + version-pin + thrash-guard tests before each PR merges.

**Key dependency edges:** T1 blocks all · T2 blocks T3,T4,T5,T6,T7 · T9 ships with T2 · T4 (spacing) blocks T5 ·
T3's CSG cache is consumed by T4/T6 · T8 + T10 last.

---

## 🛠️ Tooling to use during implementation (Claude Code)

- **`/code-review` (high effort) + `/simplify`** after each task's diff — especially T1/T2/T3 where a vector/transform
  bug propagates to every view. Point it at the de-dup: confirm the 4 hand-rolled vector copies
  (`refrigerantPipePairModel.ts:669-716`, `branchKitProposal.ts:166-245`, `refrigerantBranchKitModel.ts:152-265`) are
  actually removed, not just shadowed.
- **`/run` + `/verify`** to launch the Next.js app and confirm each fix against the real symptom (draw a 90° bend and
  compare 2D vs 3D; drag a vertex and watch for jank; tap into a run; connect to a unit port). The symptoms are
  visual/interaction, so behavior-level verification is essential.
- **Claude Preview MCP** (`preview_start` / `preview_screenshot` / `preview_eval` / `preview_console_logs`) — drive the
  running web app headlessly: screenshot the 2D canvas and the 3D view after a scripted draw/drag and **diff the bend**;
  `preview_eval` to read back resolved centerline points from the store; catch the CSG `mergeGeometries`-fallback error
  and any transform `NaN`. This is the primary loop for the T10 parity work.
- **three.js MCP** (`learn_threejs` / `show_threejs_scene`) — for T3: confirm r183 `TubeGeometry`/`ArcCurve`/
  `computeFrenetFrames` behavior and prototype the ArcCurve elbow + vertical-riser normal seed **in isolation** before
  touching `pipeJointGeometry.ts`.
- **Blender MCP** *(optional)* — model a ground-truth tee/elbow with a real fillet and `render_viewport_to_path` to
  visually judge whether the CSG saddle is acceptable. Not on the critical path.
- **vitest** (`^4.1.9`, already the runner) — extend the existing `coordinateTransform.test.ts` / `pipeTopology.test.ts`
  / `pipeJointGeometry.test.ts` patterns with the T10 tests.

*Not recommended here:* `design/*` skills, computer-use (use Claude Preview instead), the deep-research skill
(research is done), and `@react-three/fiber`/`drei` (provacx uses imperative three.js).

---

## How to use these prompts

1. Start with **T1**, in its own PR. Treat its acceptance criteria as the gate.
2. Each prompt is self-contained (objective → current pain w/ file refs → root causes → target design → libraries →
   ordered steps → type changes → UX → acceptance criteria → test plan → pitfalls → cross-task deps). Hand the whole
   file to your implementer; it does not need this README to be actionable, but **this README's matrix is authoritative**
   where any prompt hedges on a library choice.
3. Keep the **"Do NOT" lists** visible — they encode the specific traps (two engines fighting, per-frame store writes,
   rounding corners twice, reconstructing connections from pixels).
4. Reference task IDs (T1…T10) in PR descriptions so the dependency edges stay legible.
