# Adaptive pipe editing — design plan

Date: 2026-09-11. Branch: `rebuild-canvas-walls`. Scope: editing an auto-routed (or drawn)
refrigerant pipe by direct manipulation, where the move is treated as a **goal to be solved**
rather than a transform to be vetoed.

---

## 1. The problem with today's engine

The current edit path is `pointer → buildPipeModelEdit → applyPipeRouteEdit → validatePipeBendSpace`.
That path is **rigid transform + veto**:

- `applyPipeRouteEdit` (`pipeEditGeometry.ts`) translates / rotates / sets the selected nodes.
  Neighbouring geometry only follows through `slidePipeSegment`, which propagates a segment slide
  along *orthogonal* neighbour legs and gives up (`intersects = false`) otherwise.
- `validatePipeBendSpace` (`pipeEditModel.ts`) then **rejects** the candidate whenever it
  - makes a non-45/90 turn on a `hard` leg,
  - leaves less straight than `takeoff_in + takeoff_out + port stubs`,
  - disturbs a sampled arc chord (`preservesSampledBend`),
  - reverses direction,
  - moves or tilts a connected port.

So a bend is an immovable fact and a leg length is an immovable fact. Any drag that needs either to
change comes back as a red message. On **auto-routed** pipes this is near-total: a generated route
bakes arc tessellation into `routePoints` (~77 points for 4 corners), so `pipeEditControlIndices`
exposes no corner handles at all, and every direction-changing edit invalidates the ~4 mm arc chords
next to it.

**What is actually being asked for:** the drag states an intent. The engine should find the nearest
*buildable* configuration by changing what is permitted to change — bend angles, bend planes, leg
lengths, fitting selection, material — and then **report** what it changed. A refusal should be rare
and should name the one hard thing that blocked it.

---

## 2. Architecture

Four layers. Each is pure, testable, and lives beside the existing modules.

### Layer 0 — `pipeSkeleton.ts` — the design graph

Editing must not operate on the fabrication polyline. Introduce the *skeleton*: sharp design
corners plus typed joints and legs.

```ts
export interface PipeJoint {
  index: number;                      // node index in the skeleton
  kind: 'field-bend' | 'socket-elbow' | 'terminal' | 'passthrough';
  angleDeg: number;                   // 0..180 turn between adjoining legs
  planeNormal: Vec3;                  // THE key DOF: rolling this turns a vertical bend horizontal
  radiusMm: number;
  takeoffMm: number;                  // r*tan(theta/2), or catalogue centreToFaceMm
  lock: 'free' | 'angle' | 'plane' | 'rigid' | 'pinned';
}

export interface PipeLeg {
  index: number;
  material: RefrigerantPipeMaterial;  // 'hard' | 'flexible'
  lengthMm: number;
  axisLock: 'none' | 'horizontal' | 'vertical' | 'direction';
  minLengthMm: number;                // takeoff_in + takeoff_out + reserved port stubs
}

export interface PipeSkeleton {
  nodes: PipeRouteNode3D[];
  joints: PipeJoint[];
  legs: PipeLeg[];
  terminals: { start: TerminalConstraint | null; end: TerminalConstraint | null };
}
```

**Construction** (`toPipeSkeleton(element)`):

1. `authoredCenterlineRoute` is the ground truth for plan XY wherever it exists — both drawn and
   auto-routed pipes persist it, and the reflow work already established that it is immutable
   design intent.
2. Otherwise **decimate** the fabrication polyline: merge collinear runs, then arc-fit runs of
   consecutive small equal-sign turns whose chords are <= 12 mm into one bend, recovering the sharp
   corner by intersecting the two tangent lines and the radius from the setback. This is the exact
   inverse of `buildCircularFieldPipeSegments` / `resolveFieldPipeBends`.
3. Z comes from `routeNodes3d` when present. When it is absent and the two connections carry
   different `elevationMm`, synthesise a **real riser** through `planTerminalCornerRisers` and the
   existing lifting machinery — never a linear ramp, which would turn every corner into a compound
   angle and break hard-pipe fitting checks.

Steps 2 and 3 remove the two engine limits that block editing on generated pipes today.

**Round trip** (`fromPipeSkeleton`): the skeleton writes back the *authored* route and re-runs the
existing builders. It never derives new geometry from previous build output — that is the invariant
the unit-move reflow work paid for in spiralled 25 m routes.

### Layer 1 — `pipeRuleModel.ts` — rules as data, with a relaxation ladder

Every `if (...) return 'message'` inside `validatePipeBendSpace` becomes a typed constraint:

```ts
export type PipeConstraint =
  | { kind: 'port-position';  endpoint: 'start' | 'end'; position: Vec3; toleranceMm: number }
  | { kind: 'port-direction'; endpoint: 'start' | 'end'; direction: Vec3; toleranceDeg: number }
  | { kind: 'min-straight';   legIndex: number; requiredMm: number }
  | { kind: 'standard-angle'; jointIndex: number; allowed: readonly number[] }    // socket elbows: [45, 90]
  | { kind: 'angle-range';    jointIndex: number; minDeg: number; maxDeg: number } // field bends
  | { kind: 'min-radius';     jointIndex: number; radiusMm: number }
  | { kind: 'no-reversal';    jointIndex: number }
  | { kind: 'axis-lock';      legIndex: number; axis: 'horizontal' | 'vertical' }
  | { kind: 'clearance';      /* … */ };

export type Hardness = 'hard' | { relaxable: PipeRelaxation[]; costPerUnit: number };
```

`validatePipeBendSpace` is refactored to `evaluatePipeBendSpace(): PipeRuleViolation[]` — structured,
carrying the joint or leg it belongs to. The existing string-returning signature stays as a thin
wrapper so nothing downstream breaks.

**The relaxation ladder** — what "the rules should be changed" means concretely. Cheapest first:

| # | Relaxation                                             | Physical meaning                              |
|---|--------------------------------------------------------|-----------------------------------------------|
| 1 | `extend-leg` / `shorten-leg`                            | more or less straight copper                  |
| 2 | `re-angle-bend` within the material's continuous range  | a field bend at 62° instead of 90°            |
| 3 | `roll-bend-plane` (includes vertical → horizontal)      | the elbow is rolled about its incoming leg    |
| 4 | `adjust-radius` within `[minimumFieldBendRadiusMm, …]`  | a tighter or larger former                    |
| 5 | `elbow-to-field-bend` (implies `hard` → `flexible` leg) | drop the catalogue fitting, bend the tube     |
| 6 | `insert-offset` (a new pair of bends)                   | a classic dog-leg absorbing the move          |
| 7 | `insert-riser` / split a leg                            | reach a new elevation                         |
| 8 | `move-free-terminal` approach                           | only when that end is not connected           |

**Never relaxed:** connected port position and direction; explicit locks
(`routeLocked` / `routingLocked` / `locked` / `isLocked` / `reviewed` / `installationReviewed`);
user pins; direction reversal; radius below the manufacturer minimum; clearance from equipment
bodies.

### Layer 2 — `pipeAdaptiveSolver.ts` — solve, don't veto

The DOFs are leg lengths (n), joint angles (n−1), joint plane rolls (n−1), plus insertable bends.
The move is a constrained least-squares:

```
minimise   w_goal · |p_target − p(q)|²  +  Σ w_i (q_i − q_i⁰)²  +  Σ cost(relaxation used)
subject to hard constraints
```

Implemented as two stages, because a general NLP is both overkill and unpredictable at 60 fps.

**Stage A — analytic local re-solve.** Covers the overwhelming majority of drags in well under a
millisecond. For a dragged leg or node with two adjoining joints: hold the far ends of the
neighbouring legs, let the two adjoining joints change **angle and roll**, let the three affected
legs change **length**. In the coplanar case this is a line/line intersection —
`intersectStraightLeg` already does it, and `slidePipeSegment` is a restricted orthogonal-only
version of exactly this idea. The generalisation is the skew case: when the moved leg's line and the
neighbour's line do not intersect, either roll the joint plane until they are coplanar (this is
literally "rotate the bend to whatever degree the move needs", including 90° of roll turning a
vertical bend into a horizontal one), or spend ladder rung 6 and insert one extra bend.

**Stage B — iterative relaxation.** Fallback for chains where Stage A's two-joint window is not
enough. Projected Gauss–Seidel / position-based iteration over the node chain:
(i) satisfy leg length and direction constraints, (ii) project each joint's angle onto its allowed
set — a *snap* for discrete socket elbows `{45, 90}`, a *clamp* for continuous field bends —
(iii) re-anchor the fixed terminals. O(n) per iteration, 8–20 iterations, damped and
deterministically seeded so a held drag does not jitter.

**Escalation.** Run with rung 0 (nothing relaxed). On infeasibility enable the next rung and re-run,
accumulating `PipeAdaptation[]`. Stop at the first feasible configuration. A hard-constraint failure
ends the search and is reported by name, with the nearest feasible position offered as a clamp.

```ts
export interface PipeAdaptation {
  relaxation: PipeRelaxation;
  jointIndex?: number;
  legIndex?: number;
  before: number | Vec3;
  after: number | Vec3;
  label: string;   // "90° → 62°", "elbow → field bend", "leg +340 mm", "bend rolled to horizontal"
}
```

### Layer 3 — UX

`buildPipeModelEdit` remains the single chokepoint — every entry point already routes through it
(`PipeStudioOverlay` drag, `PipeEditingTools`, `pipeSegmentDimensions`, `pipePropertyEdits`,
`DrawingCanvas`), so they all inherit adaptivity from one change:

```ts
interface PipeModelEditRequest { /* … */ mode?: 'rigid' | 'adaptive' }   // default 'adaptive'
type PipeModelEditResult =
  | { ok: true; elements: HvacElement[]; adaptations: PipeAdaptation[] }
  | { ok: false; message: string; blockedBy?: PipeConstraint; nearestFeasible?: Vec3 };
```

- **Live adaptive ghost.** Affected joints re-angle and roll, legs grow and shrink, during the drag —
  not on release. Unchanged geometry normal, adapted geometry in the accent colour, locked geometry
  grey with a pin, blocked in red.
- **Joint chips.** A small chip at each changed joint: `90° → 62°`, `elbow → field bend`,
  `rolled 90° · vertical → horizontal`, `+340 mm`.
- **"What changed" ribbon** on release: one line per adaptation, each with revert-this-one and
  pin-this. The whole gesture stays a single undo step — `beginPipeDrag` already gives that boundary.
- **Pins** promote a joint or leg to `hard` for subsequent solves. This is the user's steering wheel
  over which rules the engine is allowed to change.
- **Modifiers.** `Alt` = rigid (today's behaviour), default = adaptive, `Shift` = ortho-constrained
  adaptive, `Ctrl` = permit adding bends (rungs 6–7).

---

## 3. Correctness and performance

- Round-trip property test: `toPipeSkeleton(fromPipeSkeleton(s)) ≈ s` within tolerance, including
  generated routes with baked arc tessellation.
- Property tests over random drags: no solved route ever fails `evaluatePipeBendSpace` at hard level;
  connected ports never move; pinned and locked joints never change; drag-and-drag-back is
  idempotent.
- Regression: every existing message in `pipeEditModel.test.ts` and `pipeEditGeometry.test.ts` must
  still be produced under `mode: 'rigid'`.
- Perf: extend `pipeEditModel.bench.ts`. Budget — adaptive solve under **4 ms** for a 40-leg run in a
  500-pipe scene, matching the 3–5 ms the current rigid edit achieves.
- On-canvas verification through `__PROVACX_DEBUG__` and the Playwright driver on `D:` — drag a real
  auto-routed pipe, snapshot **all** pipes and diff (the gas and liquid lines sit ~2 px apart, so
  never assume which element a gesture hit), assert the adaptation list, capture screenshots.

---

## 4. Phases

| Phase | Deliverable | Status |
|---|---|---|
| **P0** | `pipeSkeleton.ts` — decimation, arc recovery, legacy Z synthesis | **done** |
| **P1** | `pipeRuleModel.ts` — typed constraints, relaxation ladder, structured evaluation | **done** |
| **P2** | `pipeAdaptiveSolver.ts` — Stage A + Stage B, feasible-travel clamping | **done** |
| **P3** | `buildAdaptivePipeEdit` + overlay corner drag and segment slide wired | **done, verified on canvas** |
| **P4** | Joint chips, what-changed ribbon with per-item revert, pins, Shift/Alt/Ctrl modifiers | not started |
| **P5** | Rebuild the lost micro-edit gesture layer (`+` insert, double-tap remove, context menu) | not started |

## 5. What the build changed against the design

Three things only became clear against real project geometry, and each changed the design.

**Rules are judged against the baseline, not against perfection.** A generated route arrives already
failing its own fitting rules — on the verified project, five pre-existing `insufficient-straight`
violations on the gas line (a 200 mm port stub with a 38 mm takeoff inside it, 16–20 mm gather legs
against 76 mm of required takeoff). Holding an edit to a standard the original never met makes every
generated pipe permanently uneditable, which is the exact complaint this work exists to answer. The
solver therefore evaluates the route as it ARRIVED and only refuses a violation that is **new or
worse**. The guarantee kept is the one that matters: a compliant route can never be edited into a
non-compliant one.

**A legacy plan-only route needs a synthesised riser before it can be edited at all.** A pipe stored
without `routeNodes3d` has its nodes flattened onto the start elevation by `editablePipeNodes`, so
when the two ends are welded at different heights the route cannot reach its own end port — the
verified project's gas line starts at 2632.7 mm and ends at 1436.5 mm. Every edit was refused by the
whole 1196 mm delta before the user changed anything. `pipeDesignSkeleton` now drops a real vertical
riser at the corner feeding the terminal stub, keeping the port approach straight and horizontal. A
linear ramp would have turned every corner into a compound angle.

**A blocked drag travels as far as the rules allow.** Refusal was the behaviour being removed, so an
unreachable goal is now bisected along its own direction to the last buildable position and the
reason it stopped is named ("clamped to the fitting space on segment 1"). This applies only to
FITTING limits: a pinned joint, a fixed port, a reversal or a collapsed leg are matters of identity,
not of degree, and still refuse outright.

Two smaller notes. `adjust-radius` is absent from the active ladder because a per-joint radius has
nowhere to persist, and a solution relying on one would be rejected by the polyline validator at
commit. And the main canvas previously set `showRouteHandles={false}`; corner dragging is the gesture
this work is about, so it is now enabled there.

## 6. Verified

- 879/879 drawing-engine HVAC tests pass (the suite needs `--testTimeout=120000`; several auto-route
  tests legitimately exceed the 5 s default and flake under parallel CPU load).
- On the real project, through the real canvas:
  - **segment slide** — the 5.9 m main slid; both neighbouring legs extended by the same amount;
    status line read "2 segments resized".
  - **corner drag** — status line read "3 bends re-angled, 2 segments resized"; resulting turns
    90°, 83.9°, 133.7°, 16.5°, 90°, 90°.
  - **endpoint integrity after editing** — start and end offsets 0 mm from their port points, and
    elevations exactly 2607 mm and 1318 mm as the connection records require.
  - the edited pipe gained real 3D nodes (`routeNodes3d` 0 → 8) including the synthesised riser.
- Per-corner sweep on the real geometry exercises the whole ladder: `re-angle-bend`,
  `roll-bend-plane`, `elbow-to-field-bend`, port-axis clamping and fitting-space clamping.

## 7. Environment-aware moves (second increment)

The solver above treats a fixed end as an anonymous position + direction constraint. That is enough
not to break a weld, but not enough to decide HOW to accommodate a move, and it can only ever move
geometry that already exists — it cannot create a fitting.

**`pipeEnvironment.ts` — what is actually at the edges.** Each end is classified as a `unit-port`
(immovable, reserves a straight approach, carries the unit's footprint), a `branch-kit` (carries its
terminal role, its current rotation, and the other pipes on it — which is what forbids turning it), a
`pipe-weld`, or `open`. Each corner is classified as the part it really is: a catalogue `socket-elbow`
(with its model number, and an angle that is NOT free because changing it means buying a different
fitting), a formed `field-bend` (angle free), or a `riser-elbow`. Risers, the bundle partner line and
kits sitting on the run are reported too. On the verified project this reads:

> MHI 4-Way Cassette — FDT28KXZE1 (equipment port) → MHI Outdoor VRF — FDC280KXZE1 (equipment port);
> 3× 90° LD-15.88, 6× field bend 90°; 1 riser

**`move-run` — moving the whole pipe in X/Y/Z.** The run translates and every connection it keeps is
then RE-MADE. The gap between a port's untouched straight approach and the displaced run is closed
with an axis-aligned staircase expressed in the route's OWN frame: along the port axis, then along
the direction the next leg already runs, then along the remaining axis. A plan component becomes a
dog-leg; a vertical component becomes a riser with an elbow at each end. Working in the route's frame
is what keeps an orthogonal installation orthogonal — letting the first leg swing to meet the run
would "work" geometrically and produce a diagonal nobody would install.

Two refinements that only real geometry exposed:

- **A component along the next leg's own direction needs no fitting at all** — that leg simply gets
  longer or shorter. Emitting a corner for it added a second riser beside the existing one and folded
  the route back on itself. It now falls back to a corner only when absorbing would collapse the leg.
- **Violation identity must survive insertions.** Adding a riser at the start shifts every downstream
  leg index by one, so the end stub's pre-existing complaint read as brand new and clamped the move
  to nothing. Leg and joint indices are now mapped back through the head insertion counts.

**Fittings that rotate.** A branch kit with no other pipe on it swivels about its JOINT (not its own
centre) so the weld stays exactly where it is and only the body swings — `rotate-fitting`. And every
corner whose purchasable part changed is reported as `refit-elbow` (`LD-15.88 → V-15.88`, or
`formed bend → …`). A kit that feeds other runs is never turned.

Reachable from the pipe command bar: **Whole run → Move → Offset (mm) X/Y/Z → Preview → Apply**, and
from a whole-pipe drag in the overlay.

### Verified on the real project

Moving the liquid run **down 600 mm in Z**, welded to equipment ports at both ends at different
elevations (2607 mm and 1318 mm), reported:

> 1 riser added, 2 bends re-angled, 4 bends rolled, 1 elbow → field bend, 6 segments resized.

and produced:

```
[6079,3709,2607]  start port                     — untouched
[6279,3709,2607]  200 mm stub, horizontal at port level
[6279,3709,2007]  NEW riser, auto-generated
[6279,8127,2007]  run at the new level
   … 
[12111,7601,2007]
[12111,7601,1318]  EXISTING riser, now 689 mm instead of 1289 — absorbed the move
[11911,7601,1318]  200 mm end stub at the end port level — untouched
```

Confirmed in the Front elevation as two horizontal runs joined by a vertical drop — a real riser, not
a diagonal.

## 8. Known rough edges

- Segment slide and whole-run move act on one line of a gas/liquid bundle, not the pair, so the VRF
  pair-separation check fires. Bundle-coordinated moves are the natural next item.
- A few corners in very tight gather geometry (16–20 mm legs) still refuse rather than clamp; the
  refusal names the segment.
- `PipeEditingTools` Rotate still uses the rigid path; only translation is adaptive.
- Branch-kit rotation is implemented and unit-tested but has not yet been exercised on canvas — the
  verified project's pipes run port-to-port with no kit at either end.

## 9. Note on a missing prior change

---



Session notes record a micro-edit gesture layer (`pipeMicroEditActions.ts`, `PipeContextMenu.tsx`,
and a `{ kind: 'remove', heal }` kernel operation) as delivered on this branch. None of it exists at
`1e4192f` with a clean working tree. It is planned as P5 rather than assumed present.
