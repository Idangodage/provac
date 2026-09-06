# Auto route performance verification

Date: 2026-09-08.

The performance changes preserve the planner's existing candidate generation,
candidate limits, retry order, feasibility rules, numerical tolerances, objective
weights, and tie breaking. They accelerate evaluation of the same search. The
planner still selects the best feasible candidate it explores; these changes do
not establish a global optimum or add manufacturer qualification.

## Changes

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

## Measurement method

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

## Regression verification

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

## Repeatable benchmark

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
