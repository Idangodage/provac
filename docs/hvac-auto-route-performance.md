# Auto route performance

## October 2026: the same answers, two to three times as fast on large drawings

Auto route took longer the more units and terminals a drawing had. On the user's building it now
takes a little over a third of the time and gives exactly the same preview. It shows its progress and
each service as it finishes, reuses what has not changed, and no longer gives another design on a slower
computer.

In the real app, both versions built with `next build` and served with `next start`, in the real page,
taking turns, the median of three rounds:

| Drawing | Original | Now | Speed-up |
| --- | ---: | ---: | ---: |
| The user's building, put right (7 units, 23 terminals) | 81.2 s | 30.2 s | 2.7× |
| 3 ducted units (3 + 3 terminals each) and 6 cassettes | 108.7 s | 51.2 s | 2.1× |
| 4 cassettes | 9.8 s | 7.4 s | 1.3× |

The rest was measured on bundles of the same code on a bare page, a more repeatable bench that covers more
drawings. A run there is quicker than in the real page, and these runs were in a cooler hour of the same laptop,
so compare within a table, not across the two:

| Drawing | Original | Now | Speed-up |
| --- | ---: | ---: | ---: |
| The user's building, put right (7 units, 23 terminals) | 58.2 s | 20.0 s | 2.9× |
| The user's building, as drawn | 79.4 s | 32.3 s | 2.5× |
| 3 ducted units (3 + 3 terminals each) and 6 cassettes | 77.1 s | 34.8 s | 2.2× |
| 2 ducted units (3 + 3 each) and 4 cassettes | 26.4 s | 15.0 s | 1.8× |
| 6 cassettes | 38.6 s | 19.3 s | 2.0× |
| 4 cassettes | 7.5 s | 4.7 s | 1.6× |
| 3 ducted units (3 + 3 each), ducts only | 19.1 s | 13.1 s | 1.5× |
| 1 ducted unit (5 + 5), ducts only | 8.7 s | 4.8 s | 1.8× |
| 1 ducted unit (11 + 11), ducts only, routed in groups | 27.3 s | 20.2 s | 1.4× |
| 5 ducted units (4 + 4 each) and 8 cassettes | 131.4 s | 72.2 s | 1.8× |
| 8 ducted units (4 + 4 each) and 12 cassettes | 138.3 s | 59.3 s | 2.3× |

Real Chrome on a Ryzen 7 7730U (15 W, 8 cores, 16 threads) on its charger, production-style bundles,
the exact requests the app sends, the median of three rounds run back and forth (the two largest:
one round).

The dev server is as quick as a production build (28.8 s against 30.0 s on the building, in one rotation
with the bare page's 23.9 s). Why the real page is slower than the bare page was not traced. It is not the page's
own thread, busy for about a tenth of a run (3.4 s of 30 s), and not the build's browser targets (below).

### Measuring this

- **In Chrome, not under Vitest.** Vitest runs this code about three times slower than Chrome and
  distorts what is slow: the first figure for the building (198 s) was Vitest's overhead.
- **Back and forth, not one set after another, and swap the order.** Other programs on the machine
  moved one step by 12 % between runs, and a first conclusion that the worker pool hurt small jobs
  (7.8 s against 4.8 s) was only that.
- **On the charger.** On battery this laptop runs at less than half the speed.

### What changed

| Phase | Commit | What | Rule for later work |
| --- | --- | --- | --- |
| P0 | 2ff5969 | Benchmark set, golden master, step timings | A change of answers is deliberate: record again, and say why |
| P1 | 0153b7d | A plan index (`spatial/boxIndex.ts`, rbush) for obstacles and services | Candidates come in list order; a box is padded by the test's clearance and a little more |
| P2 | 15b38de | Routing session (`routingSession.ts`): what is worked out from an unchanged element is kept for the run | Valid only inside an Auto route run, where planners never edit elements in place. A variant string holds every dependency, the active settings included. `ROUTING_SESSION_CHECKS=1` freezes values and recomputes each hit |
| P3 | 24f33d7, 9157c98 | The duct search no longer reads the clock to decide what to search; the time per unit is a true safety net (5 minutes) | No decision depends on the clock below the safety net. A saved 20 s (the former default) takes today's default |
| P4 | 931f11f, 99ab79e | Up to four workers (`parallel/`) run the refrigerant starts, with a spare one starting from the unit most often left out | A task is a pure function of its input, answers merge in the original order. Where workers cannot start, the tasks run in the run's own worker |
| P5 | f4981f4, 388e53a | Sizing frontiers kept as their steps (`duct/optimizer/frontierSteps.ts`), choices recovered when asked for | The forward pass and reconstruction share the candidate walkers: change one, both follow. A loss can be NaN: such a frontier adds nothing, and the tests for it must come first |
| | e094b49 | Corner finding and the drain search stop repeating small sums | |
| P6 | ee7f576, e50c8d0 | Progress bar and time left, services shown as they finish, Route again reuses unchanged steps | A step's key holds everything it reads. Apply waits for the final answer |

Duct sizing went to the workers in P4 and came back in 99ab79e: once P5 made it cheap, the two ways
take the same time (measured back and forth), and without it a run with no refrigerant starts no worker.

### How the answers were kept exact

Every case must give exactly the original preview: every duct, pipe, drain and fitting, every size,
connection, cost, score, warning and clash. Only generated ids are renamed, consistently, so a
reference between elements still has to match.

- **Original against new in real Chrome** (`bench-browser.mjs`), both bundled the same way, the same
  requests, compared with no tolerance: the 9 benchmark cases (27 runs), 36 variations of the options
  (duct shapes, fan speeds, single services, objectives, rates, rule profile, selection scope, grouped
  router, drawings that already hold an applied network), 18 requests from drawings of earlier real
  sessions, a project in the app, 10 requests captured while the canvas drivers worked in the real app, and
  the 2 larger buildings. No differences.
- **The real app** (`speed-check.mjs`): on the dev server, exactly the original's answer.
- **A real production build**, the page and the pool's workers as webpack emits them: all 9 cases equal the
  original's answer, and the original built the same way gives its bundle's answer on the 3 cases run on it, so the
  bundles speak for the app. The canvas driver (`auto-route-live.mjs`: progress, services as they finish, Route again, Apply, Undo,
  Cancel) passes 20 of 20 on it. The debug handle is compiled out of a production build, so these copies kept it in
  with a scratch webpack loader.
- **A computer 30 times slower** (a bundle whose clock runs 30 times fast): all 9 cases, exactly the
  same answer. The original changes at 3 times: it gives another design on the building as drawn.
- **Golden master** (`autoRouteCorpus.golden.test.ts`), recorded on the original code (2ff5969): 9 cases,
  in checked mode (every reuse recomputed) and split as for a pool of workers.
- **The old sizing next to the new**, through the whole HVAC test suite: 2,275 tests, every frontier value,
  reconstruction and failure reason identical (run once; the old code is not kept).
- **Property tests** of each frontier operation against the loop over the grid; the pool and its fallback
  (the pool's file missing, in real Chrome: the same answers).
- **The HVAC test suite:** 2,275 passed, 64 skipped.

Two blind spots this work found in its own checks: the golden master fixed `Math.random` while it drew
the scene too, so every wall and room had the same id (scenes are now drawn with distinct ids, recorded
again on the original code); and no benchmark case met a NaN loss, so a hang in f4981f4 reached the repo
until the full test suite met it on eleven diffusers (388e53a).

### Where the time goes now

On the building, on its charger: ducts 8.7 s, refrigerant 7.6 s, drains 3.3 s. The profile is flat: no
function takes over 6 %. What grows fastest with size is refrigerant: each start attaches the units one
by one and tries up to 24 stations for each, and starts cannot share what they work out across workers.

Left out of the plan, with the reason:

- **The three orders of a drain tree in parallel.** Their setup lives in closures, so a worker would have to
  repeat it (over a second each), for about 2 s gained on the building.
- **The rectangular and round duct router sessions in parallel.** They build and verify whole options, ids
  included, in the middle: much to move between workers, for about 2 s gained on the building.
- **A build for modern browsers only.** Next's default targets rewrite newer syntax for old browsers, in the workers
  too. Targeting Chrome and Edge 120, Firefox 121 and Safari 17 made the drawing page 50 kB smaller but Auto route no
  quicker: 32.0, 31.9 and 29.0 s on the building against 29.6 and 31.7 s, taking turns. (Measured on that one drawing;
  the rotation was stopped early when the machine ran short of memory.)
- **Speculating on more than one left-out unit.** In all three benchmark cases with a unit left out, the
  start needed first was the first spare unit; the others only slowed the rest. More than four workers gain
  nothing on this kind of laptop: with six, the same work took 2.1 times the CPU.

### Found on the way, not changed (they would change answers)

- **Two units unconnected on the building as drawn** and as advised: `autoRouteBuilding.test.ts` fails on
  those two cases, on the original code too. It starts at b142c6d (27 October, field pipes start on the maker's
  stubs): 7 of 7 before it, 5 of 7 now.
- **A flow residue drops designs.** A run's airflow less its terminals' can round to just below zero
  (−7×10⁻¹⁴ m³/h with 54.54 m³/h shares), `velocityMs` gives NaN, and a design ending in a cap just past its
  last take-off is silently discarded, depending on rounding. Of ten common airflows split equally, 11 terminals
  round below zero on seven, 9 terminals on three, 7 terminals on one. Clamping the flow at zero (one line in
  `planSegments`), tried on a copy: the 9 benchmark cases stay exactly as they are and the two duct test files with
  larger units pass. A ducted unit with 9 + 9 terminals in a test drawing gets the better supply design it had been
  losing (first cost 4,583 to 4,386, life-cycle cost 4,839 to 4,600, supply index path 27.7 to 20.7 Pa); with 3, 4, 6, 7,
  11 and 12 terminals its cost, layouts and index path do not change.

### Repeating the measurements

The scripts live outside the repo, with the other canvas drivers (`D:\claude-tmp-vrf-check`, `D:\claude-perf`):

```bash
node D:/claude-perf/browser/bundle.mjs <drawing-engine root> current     # production-style bundles; NOMIN=1, SLOW_CLOCK=30
MODES=original:plain,current:pool CASES=building-put-right node bench-browser.mjs
MODES=current-dev:warm PROFILE=name node bench-browser.mjs               # a CPU profile taken in Chrome (unminified bundle)
node auto-route-live.mjs                                                 # what the user sees, on the real canvas
sh D:/claude-perf/prod-compare.sh                                        # old against new as real production builds, in the real page
```

`prod-compare.sh` needs the two builds on ports 3100 and 3101, in copies of the repo: `git archive`, `prod-links.ps1`
for `node_modules`, a copy of `.env.local`, `open-handle-loader.js` as a webpack rule to keep the debug handle, and for the
original `patch-prod-original.mjs` (a copy's `node_modules` links back to the repo's engine, so the original needs its alias).

In the repo:

```bash
AUTO_ROUTE_GOLDEN=verify npx vitest run src/components/canvas/hvac/autoRouteCorpus.golden.test.ts
AUTO_ROUTE_GOLDEN=verify ROUTING_SESSION_CHECKS=1 ...     # every reuse checked against a fresh value
AUTO_ROUTE_GOLDEN=verify AUTO_ROUTE_RUNNER=pool-like ...  # tasks taken as by a pool
AUTO_ROUTE_BENCH=1 npx vitest run src/components/canvas/hvac/autoRouteCorpus.bench.test.ts  # holds each case to a budget
```

---

## September 2026: refrigerant search verification

Date: 2026-09-08.

The performance changes preserve the planner's existing candidate generation,
candidate limits, retry order, feasibility rules, numerical tolerances, objective
weights, and tie breaking. They accelerate evaluation of the same search. The
planner still selects the best feasible candidate it explores; these changes do
not establish a global optimum or add manufacturer qualification.

### Changes

- Reuse normalized pipe entries and service terminal lists within one unchanged
  level-planning operation, preserving the original arithmetic order.
- Reuse projection metrics and use ordered station lookup. Conservative bounds
  skip only projection blocks that cannot improve or tie the current result;
  nonfinite cases retain the original scan.
- Reuse exact private clearance geometry, equipment adapter regions, and contact
  witnesses. Connection identities and existing-clash preservation are checked
  against the current scene. Existence checks stop only at a proven new clash;
  complete clash reports still examine every applicable contact.
- Compare normalized coordinates and materials before rebuilding long geometry
  keys. In-place edits, moved equipment, connection changes, and routing settings
  remain part of invalidation. Caches have explicit retention budgets.
- Share a physical pipe-path builder with the full drawing model, avoiding unused
  local drawing arrays and material ownership work during route construction.
  The full visual retains its warnings and material ownership.
- Reuse private, exact plan elbow projections. Cached fitted coordinates are
  copied before returning; unfitted routes preserve the current caller's points.
- Reuse evaluation geometry and path measurements inside one evaluation, and
  omit unrelated engineering fields from the geometry-only validation snapshot.
- Avoid nearest-segment material searches for uniform-material hosts. Mixed
  materials retain the original projection calculation.

### Measurement method

Before changing source, the planner and three equipment fixtures were bundled
into a frozen Node executable. The same fixtures were bundled after the changes.
Measurements use fresh processes, one routing calculation per process, the same
settings and objective, and no CPU profiler or concurrent regression workload.
Hardware: AMD Ryzen 7 7730U; Node 20.20.2 on Windows.

Each comparison includes the complete generated result, connected unit order,
candidate count, objective score, and all reported metrics. Timestamp-derived
retired host metadata differs between ordinary executions even before these
changes. The installation-cost and mixed-orientation comparisons fix only
`Date.now()` for generated IDs; `performance.now()` remains real elapsed time.

| Fixture / objective | Before | After | Speedup | Evaluated candidates, unchanged |
| --- | ---: | ---: | ---: | ---: |
| Four indoor units in two rows / balanced | 149.3 s | 66.5 s | 2.25x | 80 |
| Three indoor units / installation cost | 37.5 s | 18.7 s | 2.00x | 41 |
| Four indoor orientations / fewest fittings | 60.1 s | 27.6 s | 2.18x | 91 |

These are individual fresh-process observations, not statistical guarantees or
live-browser timings. Layout complexity and hardware still affect latency.

The cost and mixed-orientation results are byte-for-byte identical with the
fixed ID clock. In the balanced case, all geometry, topology, evaluation and
metrics match; the only differences are four retired host timestamp IDs and
their four derived ownership signatures. The same eight metadata differences
also appear between two executions of the pre-change baseline.

All requested indoor units remain connected in each fixture. The selected
installation cost remains EUR 2638.1120916199975, with two branch pairs and no
elevation reversals. The balanced and mixed-orientation fixtures retain three
branch pairs each and no elevation reversals.

### Regression verification

- The broad HVAC/VRF run covered 83 files and 735 tests. 731 passed on that run;
  four branch-host rebinding tests used an outdated clearance mock. Updating
  that mock for the new existence-query export and rerunning the file passed
  all four cases.
- All eight new plan-elbow cache tests pass; the combined compiler, visual,
  ownership and cache check passed 29 tests.
- Exact projection parity includes 128 seeded cases against the original
  linear implementation, including numerical endpoint rounding and nonfinite
  fallbacks. Clearance tests include mutation, eviction, dense contact scans,
  adapter changes and existing-contact preservation.
- Drawing-engine and web TypeScript checks, affected-file ESLint, browser UI
  and worker bundling, and whitespace checks pass.

### Repeatable benchmark

From the repository root, run one fixture in a fresh process:

```powershell
pnpm --dir packages/drawing-engine exec vitest bench --run src/components/canvas/hvac/autoRouteNetwork.bench.ts -t "two rows"
pnpm --dir packages/drawing-engine exec vitest bench --run src/components/canvas/hvac/autoRouteNetwork.bench.ts -t "installation cost"
pnpm --dir packages/drawing-engine exec vitest bench --run src/components/canvas/hvac/autoRouteNetwork.bench.ts -t "four orientations"
```

The benchmark runs once per selected fixture without warmup and asserts the
pre-optimization candidate count, connected units, score, pipe length, bend
equivalents, branch pairs, elevation reversals, and installation cost. It is
excluded from normal test runs. Repeat fresh processes to assess variability;
the Vitest harness adds overhead compared with the standalone Node comparison.
