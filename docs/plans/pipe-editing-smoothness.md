# Plan: pipe editing and drawing smoothness

Date: 2026-09-17. Scope: the pointer-event path for refrigerant pipe **drawing**
(`useRefrigerantPipeTool`) and **editing** (`PipeStudioOverlay` move/vertex drag), plus
the commit and 3D-rebuild work those gestures trigger. This is a follow-up to the
[professional workflow and performance review](../audits/pipe-professional-workflow-review.md),
which left "remaining frame-time variability" unexplained (P95 50.4 ms, six long tasks
totalling 407 ms over a 100-pipe trace).

## Context

That earlier review optimised the *geometry operation* (`buildPipeModelEdit`: 131 ms →
3–5 ms) and concluded correctly that this was "geometry-operation timing, not whole-
application frame rate". The residual variability it recorded is not in the geometry
operation. It is in three places the earlier work did not measure:

1. the **branch-kit proposal** engine, which runs a whole-network level re-plan on every
   pointer move while drawing;
2. the **snap searches**, which scan the entire element list twice per pointer move;
3. the **3D branch-kit meshes**, which are CSG unions invalidated by *any* element
   changing identity.

None of these are visible in a per-operation benchmark, because none of them are the
operation — they are the per-event overhead around it.

### Measurements

Throwaway Vitest probes against the real engines (Node, same machine, 2026-09-17). Pure
TypeScript geometry, so magnitudes carry to the browser within a constant factor and the
ordering is exact. Scene = 1 indoor + 1 outdoor + a generated network, padded with
duplicate pipe bodies.

Per **pointer move while drawing**:

| | 4 elements | 24 | 64 | 154 |
| --- | --- | --- | --- | --- |
| `proposeBranchKit` | 11.3 ms | 71.8 ms | 213.3 ms | 440.4 ms |
| `planNetworkPipeLevels` (called repeatedly inside it) | 0.7 ms | 6.9 ms | 15.9 ms | 35.3 ms |
| `findNearestRefrigerantPipeExtensionTarget` | 0.8 ms | 4.7 ms | 11.1 ms | 24.8 ms |
| `findNearestRefrigerantPipeBundleTarget` | — | — | 5.3 ms | — |
| `buildRefrigerantPipeElements` (the actual preview build) | — | — | 0.5 ms | — |

Per **pointer move while dragging** (62 pipe bodies):

| | |
| --- | --- |
| `buildAdaptivePipeEdit` (move-node) | 1.0 ms |
| `buildAdaptivePipeEdit` (move-run) | 2.3 ms |
| `buildPipePlanTubes`, one pipe | 2.5 ms |
| `pipeDesignSkeleton` | 0.7 ms |
| presentation cache read, all 62 pipes, warm | 0.13 ms |
| `buildPipePlanTubes`, all 62 pipes, cold | 172.9 ms |

Per **commit / release**:

| | |
| --- | --- |
| `buildHvacElementMesh`, one branch kit (three-bvh-csg union) | 70.8 ms |
| `JSON.stringify(elements)` ×2, 64 elements | 1.1 ms |
| `structuredClone(elements)`, 64 elements | 0.5 ms |

The cheapest item in the drawing table — the work the user actually asked for — is
`buildRefrigerantPipeElements` at 0.5 ms. Everything above it is advisory.

## Findings

### F1. `proposeBranchKit` runs on every pointer move while drawing

[`useRefrigerantPipeTool.ts:1416-1422`](../../packages/drawing-engine/src/components/canvas/hooks/useRefrigerantPipeTool.ts#L1416-L1422)
gates on `canOfferPipeBranch`, which is `planRouting && lineMode === 'pair' && hasStart
&& !hasEndpointSnap && !freePointer` — true in the **default** configuration once the
first click has landed. `refreshBranchKitProposal` then calls
[`proposeBranchKit`](../../packages/drawing-engine/src/components/canvas/hvac/branchKitProposal.ts#L995),
which runs `planNetworkPipeLevels` (line 1233), riser re-plans
(`replanNetworkPipeRisers`), and repeated whole-scene `findLineSegmentNear` scans. There
is no cache, no debounce and no queue: every pointer sample pays in full.

At 213 ms/move on 64 elements the event queue cannot drain, so the preview trails the
cursor by hundreds of milliseconds and the pointer stream backs up. This is the dominant
cause of "re-drawing is not very smooth".

`refreshBranchKitProposal` also calls `setBranchKitProposalState` with a freshly
constructed object on every move — never reference-equal, so it re-renders unconditionally.

### F2. Snap search is O(scene) and runs twice per move

`findNearestRefrigerantPipeExtensionTarget` and `findNearestRefrigerantPipeBundleTarget`
walk every element. Both are called from `handleMouseMove` — one via `snapPoint`, one via
the idle-hover branch (`routePointsRef.current.length === 0`) or the single-line weld
branch. There is no spatial index, and nothing is memoised on scene identity, so simply
hovering with the pipe tool costs ~16 ms/move on 64 elements before a single click.

### F3. The drag solve is not frame-coalesced; only the `setState` is

[`PipeStudioOverlay.tsx:1343`](../../packages/drawing-engine/src/components/canvas/hvac/PipeStudioOverlay.tsx#L1343):

```ts
scheduleMovePreview(buildMovePreview(md, dx, dy));
```

The argument is evaluated eagerly. `scheduleMovePreview` defers only
`setMovePreviewElements`; `buildMovePreview` — which runs `buildAdaptivePipeEdit` per
dragged pipe plus `resolveRefrigerantPipeBranchKitReconnectionUpdates` per kit — still
runs once per pointer event. The rAF is in the wrong place.

The vertex-drag branch
([`:1358-1373`](../../packages/drawing-engine/src/components/canvas/hvac/PipeStudioOverlay.tsx#L1358-L1373))
has no rAF at all: `buildAdaptivePipeEdit` then `setGhost`, synchronously, per event.

[`pipePreviewScheduler.ts`](../../packages/drawing-engine/src/components/canvas/hvac/pipePreviewScheduler.ts)
already implements exactly the right primitive ("only the newest pointer sample matters
for a visual frame"), is unit-tested, and is used only by `PipeEditingTools` — not by
either overlay drag path.

### F4. The dragged pipe's geometry can never hit its cache

`pipeTubes()` builds `withPipeRoute(p.element, route)` whenever the rendered route is the
ghost's rather than the stored one. That is a fresh object every render, and
[`pipePresentationCache`](../../packages/drawing-engine/src/components/canvas/hvac/pipePresentationCache.ts)
is a `WeakMap` keyed on element identity — so the dragged pipe misses every frame and
pays the full 2.5 ms rebuild.

Compounding it, per preview frame:

- `selectedHandleRoutes` ([`:867`](../../packages/drawing-engine/src/components/canvas/hvac/PipeStudioOverlay.tsx#L867))
  depends on `pipes` (a new array each frame) and recomputes `pipeDesignSkeleton` for
  every selected pipe — 2.3 ms for two.
- `visibleBranchKitPortKeys` ([`:1765`](../../packages/drawing-engine/src/components/canvas/hvac/PipeStudioOverlay.tsx#L1765))
  walks **every ghost route node** (58 on a generated run) against every kit port.
- `branchKitPorts` and `placedKits` depend on `previewElements`, so every kit's view
  model and three connection identities are re-resolved each frame.
- React reconciles the full `pipes.map` — roughly 500 SVG `<path>` nodes at 60 pipes —
  even though only one pipe's `d` changed.

### F5. Release triggers document-wide serialization and a 3D CSG rebuild

- [`commitHvacElementCommand`](../../packages/drawing-engine/src/store/index.ts#L4291)
  decides `changed` with `JSON.stringify(nextElements) !== JSON.stringify(state.hvacElements)`
  — two full serializations, when the updates map already names every changed id.
- `regenerateElevations` then builds `elevationGenerationSignature`, another
  `JSON.stringify` over walls + section lines + elevation views + hvacElements.
- `saveToHistory` `structuredClone`s the element array.
- Worst: [`hybridHvacScene.ts:39`](../../packages/drawing-engine/src/components/canvas/hybrid/hybridHvacScene.ts#L39)
  gives a `refrigerant-branch-kit` the dependency list `[element, revision, settings,
  ...context.allElements]`. Any single element changing identity makes the array differ,
  so **every kit rebuilds** — and one kit rebuild is a `three-bvh-csg` union at 70.8 ms.
  Eight kits ≈ 570 ms of frozen main thread on pointer-up. The effect that drives this
  ([`HybridProjectionLayer.tsx:2942-2957`](../../packages/drawing-engine/src/components/canvas/hybrid/HybridProjectionLayer.tsx#L2942-L2957))
  is unconditional, so a 2D-only edit pays the full 3D cost.
- `undo`/`redo` `deepClone` the whole document, changing every identity: 172.9 ms of plan
  tube rebuilds plus every 3D mesh plus every kit's CSG.

### F6. Three edit paths, two solvers, one dead fourth

| Gesture | Solver |
| --- | --- |
| Overlay vertex drag / segment slide | `buildAdaptivePipeEdit` |
| `PipeEditingTools` + `PipeEditGizmo` | `buildPipeModelEdit` |
| 3D handle drag → `handleCommitHybridPipeRouteEdit` | `buildPipeModelEdit` |
| `PipeKonvaInteractionLayer` (937 lines) | `buildPipeDrag` + direct store writes |

The Konva path is dead behind `localStorage 'hvac.pipe.engine' === 'konva'`, and
[`pipeDragSession`](../../packages/drawing-engine/src/components/canvas/hvac/pipeDragSession.ts)
— which is the correct "zero writes until release, one commit on release" abstraction —
is reachable only from it.

The two live solvers apply different rules to the same gesture, so an edit behaves
differently depending on which control was grabbed. That reads as unsmooth independently
of frame rate.

### F7. Drags are silently discarded

[`:1335`](../../packages/drawing-engine/src/components/canvas/hvac/PipeStudioOverlay.tsx#L1335)
and [`:1391`](../../packages/drawing-engine/src/components/canvas/hvac/PipeStudioOverlay.tsx#L1391):

```ts
if (md.baseline !== hvacElements) { cancelOverlayDrag(); return; }
```

Any store write that replaces the element array mid-gesture throws the move away with no
feedback. `PipeEditingTools` does the same (`useEffect(() => previewScheduler.cancel(),
[props.elements])`), and `PipeStudioOverlay`'s `interactive={... && !pipeEditPreview}`
prop can flip gesture ownership mid-drag.

## Design

Four phases, ordered by payoff over risk. P0 alone should remove the dominant stall.

### P0 — take the planners off the pointer path

**P0.1 Split `handleMouseMove` into a cheap synchronous part and a deferred advisory part.**
The synchronous part keeps what the user is directly steering: snap resolution, the
straight-line route preview through `buildRefrigerantPipeElements` (0.5 ms), and the HUD
readout. The branch-kit proposal is a *suggestion*; it does not need the cursor's frame.

Defer it behind pointer stillness (~100 ms) and run it through the existing
[`LatestOnlyAsyncQueue`](../../packages/drawing-engine/src/store/latestOnlyAsyncQueue.ts),
so a fast-moving cursor never queues more than one pending proposal and a superseded
caller still settles. Cancel on click, Escape, tool change and route commit.

**P0.2 Memoise `planNetworkPipeLevels` within a proposal.** It is called from two sites
inside one `proposeBranchKit` pass (lines 1028 and 1233) plus once per riser re-plan, on
the same scene and largely the same keys. Key on
`(scene identity, gasHostId, liquidHostId, host elevations, settings, excludedLevels)`.

**P0.3 Index the snap targets.** Build a uniform grid over segment bounding boxes,
rebuilt when `hvacElements` identity changes rather than per move, and query it from
`findNearestRefrigerantPipeExtensionTarget` / `findNearestRefrigerantPipeBundleTarget`.

**P0.4 (stretch) Move `proposeBranchKit` into a worker**, reusing the
[`autoRouteNetwork.worker.ts`](../../packages/drawing-engine/src/components/canvas/hvac/autoRouteNetwork.worker.ts)
pattern, so the pointer path is free of it entirely. Only worth doing if P0.1–P0.3 leave
a measurable stall.

### P1 — bound the drag loop to one frame

- Move `buildMovePreview` **inside** the rAF; keep the raw pointer delta in a ref.
- Route the vertex drag through `createPipePreviewScheduler` rather than calling
  `setGhost` directly.
- Key the tube cache on `(element id, route revision)` so a ghost route can hit it; or
  hoist the dragged pipe into its own `<g>` so the other 60 pipes are not reconciled.
- Make `selectedHandleRoutes` depend on the selected *elements*, not on `pipes`.
- Limit `visibleBranchKitPortKeys` to the ghost route's endpoints.

### P2 — make release cheap

- Replace the `JSON.stringify` change-check in `commitHvacElementCommand` with an
  identity scan over the ids the updates map already names.
- Hash ids + revisions in `elevationGenerationSignature` instead of serialising geometry.
- Fix `dependencyReader`: a branch kit depends on the runs it can actually bind to, not
  on `...context.allElements`. Cache the CSG result on the kit's geometric signature so a
  pure translate never re-runs the boolean.
- Skip `hvacScene.update` while the plan sheet is flat; flush on the 2D→3D transition.

### P3 — one editor, one solver

- Make `buildAdaptivePipeEdit` the single entry point; `buildPipeModelEdit` becomes its
  internal primitive. Route `PipeEditingTools` and `handleCommitHybridPipeRouteEdit`
  through it.
- Delete `PipeKonvaInteractionLayer` and its flag; fold `pipeDragSession` into the overlay
  so every path shares the commit-once invariant.
- Replace the `baseline !== hvacElements` bail with a rebase onto the new scene, or at
  minimum report why the drag was dropped.

## P0 — applied and verified on canvas, 2026-09-17

**P0.1** `handleMouseMove` no longer runs `proposeBranchKit` unconditionally. New
`branchProposalScheduler.ts` supplies two pieces:

- `createBranchProposalScheduler` — a debounce (not the throttle in
  `pipePreviewScheduler`; a 100 ms throttle would still admit ten 200 ms
  proposals a second). Each sample restarts the timer and replaces the pending
  input, so the proposal runs once, when the cursor stops. `flush()` runs it
  synchronously for Enter / double-click, so a commit still decides against the
  suggestion the pointer had earned rather than silently saving a plain
  crossing. Cancelled on click, reset and unmount.
- `createProposalCostEstimator` — decides whether the proposal still fits on the
  pointer path by measuring it, not by counting elements. Keyed on scene
  identity so a commit re-measures.

**P0.3** `getRefrigerantPipeBundleSnapTargets` and
`getRefrigerantPipeEndpointTargets` are memoized on scene identity through the
new `sceneDerivedCache.ts`. Every call site was checked to be read-only
(`filter` / `flatMap` / `forEach` / `new Map` / spread / index read), so a shared
instance is safe.

### What the canvas run corrected

Two things in this plan's first draft were wrong, and only the browser showed it.

**The cost statistic.** The estimator first used the *minimum* of observed
durations, reasoning that the minimum is the steady state and a maximum would
over-react to a GC pause. On canvas the deferral then never engaged: the
instrumented estimator reported `bestMs: 4.1` after 48 samples while the same
gesture was costing 1 200 ms per move. `proposeBranchKit`'s cost is **bimodal**,
not "steady state plus noise" — it returns in ~4 ms when no run is near enough to
tee into, and takes hundreds of milliseconds when a candidate is found and the
network level re-plan runs. The minimum tracked the cheap mode and answered the
wrong question. It is now the **maximum over a sliding window of 8 samples**,
which answers the question actually being asked: could the next run blow the
frame budget? The window slides so a document that becomes cheap again returns to
the pointer path.

**An inline run that returns null no longer schedules a deferred repeat** of the
same search — caught by a regression that counted one proposal too many.

### Measured on canvas

Chrome (headless, `--disable-gpu`, dev build), a real saved project populated to
22 drawn pipe bodies, a route started from a real unit port, then 41 pointer
moves **along a drawn run** so the branch-kit search actually engages. A/B on one
build behind a temporary switch, since removed.

| | proposal inline (pre-P0) | proposal deferred (P0) |
| --- | --- | --- |
| Per pointer move | **1 202 ms** | **62 ms** |
| Main thread blocked over the sweep | 49 285 ms | 3 646 ms |
| Longest single task | 1 578 ms | 1 141 ms |
| Branch kit still offered | yes | yes, on settle |

Engine-level probes (Node, same machine) behind those numbers: `proposeBranchKit`
11 ms at 4 elements, 72 ms at 24, 213 ms at 64, 440 ms at 154;
`findNearestRefrigerantPipeExtensionTarget` 24.76 ms → 0.01 ms per move once
memoized.

### Three measurement traps worth recording

Each of these produced a confident, wrong "no difference" before being caught:

1. **Driving the sweep one CDP round-trip per move.** Playwright's `mouse.move`
   costs ~225 ms round-trip, which is *slower* than the 110 ms debounce, so the
   proposal fired between every pair of moves and the deferral was a no-op. One
   `mouse.move(to, { steps: N })` dispatches them back to back, like a cursor.
2. **Sweeping through open space.** `proposeBranchKit` early-outs cheaply when no
   run is within the proposal radius, so a path that misses the pipes measures
   nothing. The sweep has to follow a run.
3. **Starting the route from empty space.** `canOfferPipeBranch` requires
   `startBundleRef`, which is only set when the route starts snapped to a port or
   pipe end. A free-space start means no proposal is ever offered.

### What is left, and a revised priority

The deferred arm still shows **62 ms per move** and a **1 141 ms** longest task.
Those are two different things:

- The 1 141 ms task is the one deferred proposal firing after the pointer
  settles. It is off the interaction path but is a visible pause before the ghost
  kit appears. **P0.2 (memoize `planNetworkPipeLevels` within a proposal) is
  therefore worth doing after all** — the first draft of this plan dismissed it.
- The 62 ms per move is everything else on the draw path: the 2D overlay
  re-render plus `HybridProjectionLayer.schedulePreviewRebuild` rebuilding the 3D
  pipe preview on every `setDraftPipes`. A CPU profile of the sweep puts the time
  in `buildRefrigerantPipePhysicalState` / `buildRefrigerantPipeSegmentPaths` /
  `planSocketElbowCacheKey` / `resolveFieldPipeBends` — i.e. finding F4, on the
  draw path rather than the drag path. This is what P1 should lead with.

### Checks run

- `tsc --noEmit` for the drawing engine: clean.
- ESLint on all changed and added files: clean.
- **1018 / 1018 tests across 100 suites.**
- 19 new tests for the scheduler, estimator and scene cache; the three
  pre-existing branch-dismissal regressions kept their assertions and were given
  an explicit `settle()` step, because the contract they protect now completes on
  pointer stillness rather than on the sample itself.
- All temporary instrumentation (the A/B switch, proposal counters, estimator
  probes) removed.

## P0.2 — attempted and reverted, 2026-09-17

The premise was wrong. Instrumenting one expensive proposal (24 elements, cursor
on a run) gave:

| | |
| --- | --- |
| One `proposeBranchKit` | **15 632 ms** |
| `hasNewNetworkPipeClash` calls inside it | **288** |
| `planNetworkPipeLevels` calls inside it | **12** |
| `JSON.stringify([settings, scene])` (the `baselineLanes` cache key) | 4.97 ms each |

`planNetworkPipeLevels` is already well cached by `levelPlanForTarget`; memoizing
it buys nothing. The cost is 288 whole-scene lane rebuilds. Two caches were tried
against that and **both were unsound**:

1. **Per-element lane memo** keyed on element identity + active settings + the
   element's connection sources. This broke 20 cases in
   `networkPipeClearanceReuse.test.ts`. The context does not only reach
   `resolveRefrigerantPipeSpec` → `healPipeConnectionFromScene`; it also reaches
   `buildRefrigerantPipePhysicalPath`, which an inline branch kit resolves
   against nearby runs. The connection-source contract that
   `pipePresentationCache` uses is therefore too narrow here.
2. **Identity-based `baselineLanes` key** replacing the whole-scene
   `JSON.stringify`. This broke `networkPipeClearance.test.ts` >
   "rechecks an in-place changed scene before classifying an existing conflict",
   which mutates an element through `Object.assign` and expects a fresh
   classification. The serialization is load-bearing exactly as its comment says.

Both reverted; the reasons are now recorded in comments at both sites so this is
not retried. **Cutting this cost needs a design change, not a cache** — either
fewer station evaluations (`maxRecoveryStations` is 16, times 4 level indices),
or an incremental clash check that reuses the baseline for the elements a station
does not touch, or hoisting one baseline per `proposeBranchKit` call and passing
it down. That is a larger piece of work than this phase was scoped for and should
be planned separately.

It is also no longer urgent: the proposal is off the pointer path after P0, so
its cost is a pause before the ghost kit appears, not a stall on every move.

## P1 — the drag loop is now frame-bound, 2026-09-17

Applied the F3 fix to both drag paths in `PipeStudioOverlay`:

- **Whole-element move.** `scheduleMovePreview` now takes the pointer *delta* and
  runs `buildMovePreview` inside the rAF. Previously the call was written
  `scheduleMovePreview(buildMovePreview(md, dx, dy))`, so the argument was
  evaluated eagerly on every pointer event and the rAF deferred only the
  `setState` — the expensive half ran unthrottled.
- **Corner (vertex) drag.** Previously `buildAdaptivePipeEdit` + `setGhost` ran
  synchronously per event with no rAF at all. Now `scheduleVertexPreview` queues
  the delta and `solveQueuedVertexPreview` runs once per frame.
- **Release flushes both.** `endDrag` cancels the pending frames and solves the
  queued delta synchronously, so the commit is the position the pointer actually
  released at rather than one frame behind. Cancel paths and unmount drop the
  queued frames.

### Verified on canvas

Same harness, 22 drawn pipe bodies, a 40-move batched drag of a pipe body:

| | |
| --- | --- |
| Main thread blocked across the whole drag | **87 ms, 1 long task** |
| Committed displacement ÷ dragged distance | **1.000** |
| Console errors | none |

The second row is the one that matters for the flush: a frame-deferred solve that
committed a stale delta would land short. It lands exactly on the release point.

No A/B was run for the drag, so no speedup factor is claimed here — the absolute
figure (87 ms of blocked main thread across a 40-move drag) is the evidence that
the gesture does not stall.

### Still open from the P1 list

`selectedHandleRoutes` recomputing `pipeDesignSkeleton` per frame, the ghost pipe
defeating the tube cache, and `visibleBranchKitPortKeys` walking every ghost node
are unchanged. A clean profile of the deferred draw path (batched moves along a
run) puts the remaining per-move time in three roughly equal thirds: three.js
elbow mesh rebuilds (`mergeVertices` + `buildAnnularShell`, 7.3%), React
reconciliation of the SVG overlay (~6%), and the pipe geometry pipeline (~6%) —
with 57% in `(program)`, which in a headless `--disable-gpu` run is rasterisation
and is not representative of a real machine. That caveat is why the remaining
items should be re-measured on a GPU before being optimised.

## P2 — commit cost, 2026-09-17

**P2.1 — the branch-kit 3D dependency (the headline).** A `refrigerant-branch-kit`
depended on `[element, revision, settings, ...context.allElements]`, so changing
any one element invalidated every kit, and one kit rebuild is a `three-bvh-csg`
union measured at 70.8 ms.

A kit touches the scene through exactly one function,
`resolveInlineBranchKitRenderCenter`, which early-returns unless
`branchKitPlacementMode === 'inline-pipe-run'`. Everything else in the kit's mesh
(`buildRefrigerantBranchKitViewModel`, the palette, the projection height) reads
the element alone. And the mode matters: the branch proposal engine writes
`'fixed'` and the place-kit tool leaves it undefined — **only a manual drop onto a
run is inline**. So the whole-scene dependency now applies to inline kits only.

Three tests in `hybridHvacScene.test.ts` lock the contract in: a fixed kit
survives an unrelated pipe edit, an inline kit does not, and a fixed kit still
rebuilds when its own record changes.

**P2.2 — the commit change check.** `commitHvacElementCommand` decided `changed`
with `JSON.stringify(nextElements) !== JSON.stringify(state.hvacElements)`, two
full-document serializations per commit. The map above returns the *same object*
for any element without an update, so the comparison is now a per-index walk that
short-circuits on reference equality and only serializes elements that actually
differ. Identical references are trivially value-equal and the walk keeps order
part of the comparison, so this is the same predicate, not a weaker one.

### Measured on canvas

A/B on one build behind a temporary switch, since removed. 18 drawn pipe bodies,
**6 placed branch kits**, measuring the release-and-commit window of a pipe drag:

| | whole-scene dependency (pre-P2) | narrowed (P2) |
| --- | --- | --- |
| Main thread blocked | **551 ms** | **80 ms** |
| Long tasks | 2 (max 317 ms) | 1 (max 80 ms) |

The old cost scaled with kit count, so this grows with the drawing.

### P2.3 and P2.4 — deliberately not done

- **P2.3 (`elevationGenerationSignature`)** is the same shape as the
  `baselineLanes` key that P0.2 proved un-weakenable: the signature decides
  whether elevations regenerate at all, so a cheaper key risks *skipping* a
  regeneration that was needed. That is a silent correctness bug, traded against
  a few milliseconds of a commit that now blocks 80 ms in total.
- **P2.4 (skip `hvacScene.update` while the sheet is flat)** would have to flush
  correctly on the 2D→3D transition, and `refreshSceneContentBounds` /
  `setContentBounds` feed the camera fit from the same effect. Getting it wrong
  shows stale 3D geometry when the board tilts.

Neither is refused on principle — the remaining commit cost is 80 ms in a single
task, which is below the level where either risk is worth taking. I did not break
that 80 ms down further, so this is a judgement about risk against a measured
total, not a claim that the two items are worthless.

## Verification

Each phase is verified the same way, in this order:

1. Targeted Vitest suites for the touched modules, plus new regressions for the deferral
   (a fast cursor must produce exactly one proposal; a click during a pending proposal
   must not commit a stale one).
2. A checked-in probe extending `pipeEditModel.bench.ts` with the per-move drawing cost,
   so F1/F2 cannot silently regress.
3. `tsc --noEmit` for the drawing engine and ESLint on changed files.
4. **On canvas**: draw a pair route across a populated floor and confirm the preview
   tracks the cursor; drag a corner and a segment and confirm the body follows without
   stepping; release and confirm no visible freeze. A green test suite is not the
   deliverable here — the deliverable is the gesture feeling continuous.
