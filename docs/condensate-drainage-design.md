# Condensate drainage — design and engineering basis

Automatic gravity condensate networks from indoor units to user-placed terminations
(floor gully, waste-stack connection, external wall discharge), coordinated with the
refrigerant pipework. Code: `packages/drawing-engine/src/components/canvas/hvac/condensate/`.

## Workflow

1. Place terminations from the equipment palette → **Condensate Drainage**
   (`condensate-gully` elements; floor gully and stack in a room, external discharge on a wall).
2. **Auto route** (routing toolbar: `[✓ Gas] [✓ Liquid] [✓ Condensate] [Auto route] [⚙] status`;
   the *Condensate Drainage* panel's Generate is the condensate-only shortcut). The ticked services
   are computed off-thread together and shown as ONE preview: refrigerant runs in the pipe studio,
   drains coloured by head margin, a status chip per unit (gravity / pump +lift / short by N mm),
   crossing markers. See *Unified Auto route* below.
3. Review via the status line (details: refrigerant + condensate summary, clashes between services,
   **refrigerant hop approvals**, notes) or the panel (per-unit table, BOM Copy CSV). **Apply**
   commits everything (refrigerant + drains + approved hops) as ONE undo step.
4. Live design checks (`CD_*`) run on every edit and appear in the same check list as the
   VRF rules; "Regenerate" fixes re-run the generator.

## Engineering rules (defaults, all editable, with provenance in `condensateSettings.ts`)

| Rule | Default | Source |
|---|---|---|
| Minimum fall | 1 % (1:100) | Daikin / Mitsubishi IMs, IMC 307.2.1 |
| Preferred fall where head allows | 2 % (1:50) | industry practice |
| No trap / sag / back-fall in a gravity run | hard | Daikin, Mitsubishi |
| Pumped unit: flexible hose → plumb riser within 300 mm of the unit, **rising to the high point** (pump head or soffit), then falling all the way | policy `always` (default); `when-needed` = minimal lift | Daikin FXDQ 600 / FXFQ 675, MHI FDT IM; site practice |
| Branches join mains from the top (wye) | hard | Daikin |
| Collective main ≥ 100 mm below gravity outlets | preference* | Mitsubishi City Multi |
| Air vent at head of a pumped collective main | on | Daikin VRV |
| P-trap for negative-pressure gravity units (ESP × 0.102 + 25 mm) | on | Daikin; "H + 1 in" |
| Indirect discharge: tundish air break ≥ 25 mm; HepVO at stacks | on | IMC 307.2.1, Wavin |
| Size by connected kW (IMC 307.2.2 / UPC 814.3 table), never < outlet, never decreasing | table **unverified** | secondary sources conflict — confirm per project |
| Supports: 1.0 m horizontal, 1.5 m vertical, ≤ 300 mm from fittings | | Daikin, IMC |
| Anti-sweat insulation | 9 mm | Mitsubishi |
| Clearance to refrigerant insulation | 50 mm | project setting |

\* Applied first; when the ceiling void is too shallow the planner relaxes it (branches still
enter from the top with continuous fall) and reports an advisory.

Pipe systems: metric uPVC BS EN 1329 (default; wall values flagged unverified), JIS PVC VP,
ASTM Sch 40 PVC (`condensatePipeCatalog.ts`).

## Algorithm ("route in plan, solve in Z, repair, size, fit")

- **Environment** (`condensateEnvironment.ts`): drain ports (`condensatePorts.ts`, exact rendered
  stub tips), sinks, ceiling-void envelope (ceiling plane from cassette bottoms → ducted bottoms →
  room ceilings; soffit = routing ceiling limit; both overridable), plan obstacles, walls
  (penetrable at a cost → sleeves), refrigerant centrelines from `listNetworkPipeLanes` (the exact
  lanes the clash checker uses).
- **Router** (`condensateRouter.ts`): heading-aware multi-target A* on a Hanan grid with refrigerant
  corridor lanes; targets = termination or any admissible station on the tree (junction spacing,
  not inside a service footprint); a target is accepted only if the branch can still fall to it.
- **Planner** (`condensateNetworkPlanner.ts`): K-nearest termination candidates → capacity-aware
  regret assignment → per-termination gravity arborescence grown farthest-first (3 trunk orders
  tried) with 45° wye lead-ins.
- **Z solve** (`condensateProfileSolver.ts`): the tree is a difference-constraint system
  (`z_up − z_down ≥ w`, bounds per node). Greatest solution = "hang high"; least solution; feasible
  iff z* ≥ L everywhere; exact shortfall + binding constraint for diagnostics; slope = largest
  feasible in [min, preferred] (monotone → bisection). Pumped units rise to their high point by
  default; with `when-needed`: gravity first, then minimal pump lifts;
  steeper branches only where they do not lower the main. Head margin = height above the
  minimum-fall profile.
- **Refrigerant coordination (gravity priority)**: each crossing window is held below the
  refrigerant, else above it (e.g. using pump head), else a **refrigerant hop** is proposed
  (`refrigerantHopProposal.ts`): plumb riser / level cross / plumb riser spliced into the route's
  design skeleton (`pipeDesignSkeleton`, same baseline as the adaptive editor), bundle lines hop
  together with one rise, rise ≥ the least buildable elbow height, within the soffit, validated on
  its own spans and against third-party runs. A unit's drain and its own refrigerant stubs share
  a 550 mm connection zone that is exempt (manufacturer layout).
- **Riser foot** (`makeUnitPlan`): for a pumped unit, ~45 foot positions within 300 mm of the
  outlet (60–280 mm out, up to ±260 mm aside) are scored by how high a plumb riser can climb
  before it comes within clearance of any service pipe — the unit's OWN refrigerant stubs included
  (they usually leave right beside the drain outlet) — and the nearest foot to the usual 150 mm
  that climbs (within 10 mm) highest wins. Riser top = min(pump head, soffit, below that service).
- **As installed** (`condensateElements.ts`): a level change (a branch into a wye, a dip under a
  refrigerant run, a lower main) keeps the design fall and steps down as a **45° offset** right
  before the point that set the level; when the leg is too short the remainder is a plumb drop at
  the top of the offset. Only risers and the final drop to a floor gully are plumb.
  `drainHoseLengthMm` marks the unit's flexible hose (socket → riser foot + 80 mm up the riser);
  `hangers` stores the design soffit and spacing so 3D and BOM place the same rods.
- **Elements** (`condensateElements.ts`): one `condensate-pipe` per pipe between unit / junction /
  drop / termination, with derived fittings, sizes, `drainStart`/`drainEnd` identity (deliberately
  not `startConnection`/`sourceElementId`) and `condensateNetwork` ownership (signature-based
  retain-on-edit, shared with `pipeEditRetention.ts`).

## Validation codes (`condensateValidation.ts`)

`CD_ADVERSE_FALL`, `CD_FALL_MIN`, `CD_JOIN_FROM_TOP`, `CD_SIZE_DECREASE`, `CD_SIZE_CAPACITY`,
`CD_PUMP_LIFT`, `CD_RUN_LENGTH` (advisory), `CD_AIR_VENT`, `CD_TRAP`, `CD_AIR_BREAK`,
`CD_ENVELOPE`, `CD_CLASH`, `CD_OPEN_END`, `CD_STALE` (unit/termination moved or removed),
`CD_UNCONNECTED_UNIT` (information). A freshly generated network validates clean (tested).

## Unified Auto route (`hvac/unifiedAutoRoute.ts`, `autoRouteController.ts`, `AutoRouteAction.tsx`)

Order and why:
1. **Refrigerant** first (most constrained: unit ports, branch kits). Drains this run will
   regenerate (`replaceableCondensatePipeIds`) are removed from its scene, so refrigerant never
   bends around pipes that are about to be replaced; existing drains stay obstacles.
2. **Condensate** on the scene *with* the proposed refrigerant (`applyRefrigerantProposal`), gravity
   priority: below → above → refrigerant hop proposal.
3. **Audit** (`auditServiceClashes`): new refrigerant against everything (network clearance, new
   contacts only) plus condensate ↔ refrigerant via `findCondensateRefrigerantClashes` (same unit
   connection zone as the generator). Contacts a proposed hop resolves are listed as such.

Rules that keep the preview honest:
- **One line ticked:** the engine still designs the pair; `reduceRefrigerantResultToLine` keeps the
  ticked line and its kits and never touches the partner line. The engine rebuilds whole circuits,
  so if the new ticked line would run into a partner line that stays, that circuit is left unchanged
  with a note ("tick both lines to reroute it"). Circuits = connection graph + auto-route ownership.
- **Incomplete rebuilds:** a refrigerant result that Apply would refuse
  (`incompleteAutoRouteRefusal`, shared with `prepareAutoRouteCommand`: an incomplete network may
  only add) is dropped at planning time, and the drains are designed around the refrigerant that is
  really there.
- **Apply:** stale-signature checks per service; hops are built on the post-refrigerant scene and
  folded by `foldRefrigerantHopUpdates` (hop on a new run edits the added element and marks it
  retain; on an updated run merges; otherwise an update of an existing run). Apply is disabled when
  nothing changes; a refusal message replaces the status summary.
- While a preview with refrigerant is open the pipe studio is not interactive, but its toolbar stays.
- Ticks persist per browser session (`provacx.autoRoute.services`).

## Integration points

- Types `condensate-gully` / `condensate-pipe` (`types/wall.ts`), category `accessory`.
- 2D: `CondensateOverlay.tsx` (SVG, same-frame viewport sync), gully Fabric symbol and geometric
  pick in `HvacPlanRenderer.ts` (select / Delete work normally). 3D: `three3d/condensateMeshes.ts`
  (black closed-cell insulation, swept long-radius bends, ribbed grey drain hose with clamps, hanger
  clips on M8 rods to the slab — risers on a side arm, low verticals on brackets)
  via `buildHvacElementMesh` (hybrid tilt and isometric).
- Store: `condensateSettings` (persisted with the document); transient preview in
  `condensatePreviewStore.ts` (never persisted, never in history).
- `networkPipeClearance.ts` knows condensate lanes (`service: 'drain'`), so refrigerant routing
  and edits keep clear of drains; the VRF adapter ignores condensate entirely (tested).
- Dev handle `__PROVACX_DEBUG__`: `getDrainPorts`, `generateCondensate`, `planCondensate`,
  `getCondensatePreview`, `applyCondensate`, `getCondensateReport`, `getCondensateProfile`,
  `getSelectedIds`, `autoRoute(services, scope)`, `getAutoRoutePreview`, `approveAllHops`,
  `applyAutoRoute`.

## Verification

- Vitest: `src/components/canvas/hvac/condensate/*.test.ts` (catalogue, ports, solver incl.
  randomised constraint check, planner physics on fixtures incl. all three terminations, crossings
  and hops, validation self-consistency, command/undo, VRF isolation, 3D mesh, presentation).
- Vitest: `hvac/unifiedAutoRoute.test.ts` (tick combinations on the real engines, single-line
  reduction and circuit protection, drain exclusion, hop folding, clash audit) and
  `unifiedAutoRoute.refusal.test.ts` (incomplete rebuild kept out of the preview).
- On canvas: `D:\claude-tmp-vrf-check\condensate.mjs` (`all` = single unit; `multi` = four units,
  pumps, refrigerant crossings with approved hops, 2D/Iso screenshots) and `unified.mjs`
  (`setup,gas,condensate` / `setup,all` / `setup,clear-refrigerant,all`: toolbar ticks, preview,
  details, hop approval, Apply, one undo/redo, 2D + Iso).

## Known limits / next steps

- No beams/columns or storeys in the model: the void envelope is global (per-room ceilings only
  as a fallback source).
- An infeasible crossing falls back to a hop proposal; re-routing the branch around the crossing
  with a penalty is not yet attempted.
- Tree improvement is limited to three trunk orders (no detach/re-attach pass yet).
- Direct geometry editing of condensate runs is limited to whole-pipe nudges; use Regenerate.
