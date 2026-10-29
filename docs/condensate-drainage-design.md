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

## Micro-editing ("edit the plan, the physics follows")

*A drain's pieces also have segment cards, in plan and 3D (13 October 2026): each piece's figures, its checks, and its
edits solved through the same edit session, previewed before they are applied. See `hvac-pipe-segment-cards.md`.*

Code: `condensateEditing.ts` (engine), `condensateRouteOps.ts` (pure route operations + snapping),
`condensateEditController.ts` (store side), `CondensateEditLayer.tsx` (plan handles) and
`CondensateEditBar.tsx` (contextual bar). Planner support: `CondensatePlanOptions.fixedNetwork`
re-solves ONE network along given plan routes (the same `insertBranch` + `finishNetwork` as Auto
route: fall, risers, 45° offsets, wyes, sizes, fittings, crossings, hangers).

- **Model:** each unit's path is rebuilt from the network's pipes (branch → through-junctions →
  termination; a pipe with a wye arrives as a branch), inserted trunk-first so every branch joins a
  route already placed. Runs keep their element ids: unit branch = its unit, main / drop = the units
  draining through it. A micro-edit marks the network `editPolicy: 'retain'` (Auto route keeps it;
  *Release* hands it back).
- **Verdicts:** `ok`, `short` (a unit cannot drain: the planner's binding reason), `blocked` (a run
  crosses an equipment body), `clash` (more unresolved refrigerant crossings than before), `locked`
  (a locked run would change), `invalid`. Nothing that fails is committed; the reason goes to the
  status line.
- **Plan gestures** (selected run, select tool, plan view): bend dots (drag / right-click or
  Delete removes), leg pills (drag sideways), the run body (drag whole run, ends stay attached),
  double-click (add bend), riser-foot diamond (≤ 300 mm from the outlet, reach circle shown), wye
  diamond (slides along its main, the branch lead-in follows). Snapping: square / 45° to neighbours
  and alignment with the network's points (8 px); Shift = free. One solve per animation frame with
  a live ghost network, verdict chip and leg dimensions; release = one undo step; Esc cancels.
- **Edit bar:** Bend, Re-route (router again for this unit onto the rest), Rodding eye (click the
  run to add, an eye to remove), Fall (network design fall, never below the code minimum), Size
  (upsize floor per run), Riser (height cap), Lock / Unlock, Release, Delete (a unit branch: the
  network re-solves without it; a main / drop: the whole network). Overrides persist on the pipes
  (`designFallPercent`, `minOuterDiameterMm`, `riserLiftLimitMm`, `fittingEdits`) and survive every
  later re-solve.
- **Keyboard:** arrow keys nudge a selected run's legs (ends attached, re-solved); Delete / Backspace
  deletes the selected run smartly (above); z-nudges are refused (levels follow from the fall).
- **Follow:** moving an indoor unit (drag or arrow keys) or a gully re-fits its drains in the same
  undo step (`followCondensateDrains`: outlet + riser foot move with the unit, the run reconnects
  square; runs ending on the termination re-end on it). A network that cannot follow is left as it
  is and reported (then CD_STALE offers Regenerate).
- **Picking:** a click inside a gully's footprint selects the gully, not the drains ending on it.
- **3D views** (`CondensateEditGizmo3D.tsx`, partial tilt, Iso, Front, Side): drains are pickable in
  3D (hybrid layer pick). The selected run's handles are projected from their real 3D positions
  every frame (screen-sized): bends, leg midpoints (hidden when the leg is end-on), riser foot,
  riser top, wye. A plain drag moves on the view's own surface — XY (plan / iso / tilt), XZ
  (front), YZ (side); clicking a handle activates an X / Y / Z + XY / XZ / YZ gizmo on it.
  Pointer rays are solved with the interaction service (`beginDrag` / `updateDrag`, axis or plane
  constraint) into the same edit hook as 2D (`CondensatePointerResolver`). Plan components are the
  2D edits; a vertical component sets the run's **level limit** (`levelCapMm`: every node of the run
  except the outlet stays at or below it; the fall re-solves around it; a limit the fall cannot meet
  is refused with the reason); the riser top sets the riser height (`riserLiftLimitMm`). The layer
  root carries `data-pipe-edit-gizmo` so the hybrid layer leaves its pointer events alone. The edit
  bar renders flat on screen in 3D, with the drag surface and a clearable "Level ≤ N" chip.
- **Performance:** a re-solve of the canvas network takes ~25 ms (the crossing scan's exact
  segment-distance early reject made it ~10× faster, which also speeds up Auto route).

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

## Round ducts and the drains already laid (24 October 2026)

From the user's building (see `hvac-duct-fabrication-design.md`, "What Auto route left out of the user's building").

- **The search widens when the local area has no route (b516cfd).** A branch's grid covered its ends and 1.5 m round
  them. Ducts can wall that box in from side to side (the middle room's supply ducts north, returns south): the
  bottom-left FDUM140 had "no plan route to any termination" though a route ran just outside it. When a caller sets no
  margin and the search finds nothing it can take, it tries 6 m round the ends, then the whole drawing (every obstacle
  and wall), with three times the grid and search caps. "Nothing it can take" is no route at all, or (759cab4) only
  routes to places the branch cannot fall into: a wider area can reach the termination or a lower place on the
  network (the user's FDU224, pumped, among the ducts of its new terminals). Failing that, the best route found is
  kept for the diagnosis.
- **A branch keeps clear of the drains already laid (c1f9447).** The router knew only the network's runs longer than
  twice the junction spacing, the places a branch may join; short jogs, unit stubs and pump risers were invisible, so a
  later branch could pass straight through them. Every piece laid so far that a branch may not join is now a keep-out
  (insulated sizes plus a 25 mm gap); a branch crosses one only where it joins. A riser that would stand on, or whose
  hose would cross, a drain already there is seated again beside its unit (the planner's foot positions), clear of it.
- **Other units' riser spots are kept clear (7b7c06b).** Unit plans are made before a tree grows, so the branch laid
  first could take the spot a later unit's riser needs (two cassettes with their outlets on one line). Every other
  unit's planned outlet stub and riser is a keep-out for a branch's route; where that leaves no route, the branch routes
  without them, and such a riser is seated elsewhere or says why it cannot.
- **Faster round refrigerant (4589088).** Each refrigerant run reached the router as hundreds of short chords (its
  bends), each tested on every grid edge: drains round the user's refrigerant took 270 s (17 s without). The router
  sees each run's plan path simplified to within 10 mm, 10 mm wider (crossing heights still come from the exact
  segments), only the lines reaching into a search's area count, and obstacles are looked up per grid line. The same
  drains: 32 s.
- **A drain short of fall says why, and is offered a pump (202703d).** "about 24 m of drain to Floor Gully / Floor Drain
  needs about 240 mm of fall; the void gives about 160 mm (no drain pump) — 84 mm short". The Auto route review adds
  what puts it right (a condensate pump, a drain point nearer, or the unit raised by the shortfall); where the unit has
  no pump and the project's pump lift would carry it, **Fit a condensate pump and route again** sets the unit's Drain
  pump (one undo) and routes again.
- **Tests:** `condensateRouter.test.ts` (the widening), `condensateNetworkKeepOut.test.ts` (two cassettes with their
  outlets on one line, the gully south-west and due south: no drain through the other), `condensateShortfall.test.ts`
  (the FDU224's message, the pump offer, pumped with a pump).

## Built-in pumps and the maker's outlets (27 October 2026)

The user's rule: **every ducted unit has a built-in drain pump**, as every cassette already had.

- **One reader, `unitHasDrainPump` (`hvac/unitDrainPump.ts`, e1669c6).** A choice made in the unit's Drain pump field
  is recorded with `drainPumpSetBy: 'user'` and always wins ("Gravity only" stays gravity). A value stored before
  choices were recorded counts only where it differs from the maker sheet's: the catalogue stored the FDU224/280's
  "gravity" (MHI drawing PJG000Z287), which now gives way to the rule, while an earlier hand-set value is kept. A pumped
  unit gets no negative-pressure trap by default. The unit panel marks the FDU's pump "project rule".
- **The drain leaves the maker's outlet (b142c6d, 47ecf7c).** Where the catalogue has the maker's connection data
  (`hvac/unitConnections.ts`), a pumped unit drains from its pump's outlet and a gravity one from its base outlet.
  The FDUM's and FDT28's pump outlets carry the hose the maker supplies, which their models already show: the field
  drain starts at the hose's end and no hose of ours is drawn over it (`drainHoseLengthMm` 0; the port says
  `hoseInModel`). The FDU224/280's VP25 socket sits 30 mm above the underside; its hose is still drawn.
- **A concealed unit's drain stays in the void.** An outlet below the void floor used to make the drain "exposed"
  (allowed down through the room) and switched its pump off. Exposed runs remain only for wall, split and suspended
  units; a ducted unit or cassette is lifted by its pump from such an outlet, and on gravity the planner says so:
  "its drain outlet is 20 mm below the ceiling void, so a gravity drain cannot fall from it (about 260 mm short)",
  with the review's pump offer.
- **The unit's solid body is its casing.** A maker footprint also spans the stubs, the hose and the hanger plates, so
  the drain and clash checks take the casing (`unitBodyBoundsMm`, `equipmentBoxOf`) as the unit's body.
- **The connection zone, checked at maker units.** The validator's blanket 550 mm exemption round a unit's outlet stays
  for generic units (their drawn stubs only stand for the maker's); at a maker unit the drain-to-own-refrigerant contact
  check runs in full.
- **Old drawings** re-attach their drains to the new outlets when opened (`reattachCondensateDrains`, beside
  `followCondensateDrains`; see `hvac-pipe-segment-cards.md`, "Maker connections at the indoor units").
- **Two branches into one drop (29 October 2026).** With the FDT28 draining from its maker outlet, two cassettes Auto
  routed to one floor gully were refused: "CD 32 intersects CD 32". The first branch reaches the drop at the level the
  second branch's wye sets, here 9 mm lower than its fall, so it ends in a 9 mm 45° step into the drop's top bend. The
  clash check's joint allowance took each arm's direction from its last piece only, so the 90° turn read as nearly
  straight: the allowance shrank to 27 mm and the branch's own bend touched the drop (43.2 mm against 50). It now takes
  every direction an arm runs in over the first (r1 + r2) of it, the most nearly parallel pair governing, still capped
  so a branch laid along the drop stays a clash (`networkPipeClearance.ts`; tests in `networkPipeClearance.test.ts`,
  "drain joints").
- **Tests:** `condensatePorts.test.ts` (the rule, kept choices, older values), `condensateMakerOutlet.test.ts` (hose
  ends, no second hose, the FDU224 lifted from its low socket, no dip before a pumped rise at four turns, the drain
  clear of its own unit's pair), `condensateShortfall.test.ts` (the low gravity outlet's message).

## Verification

- Vitest: `src/components/canvas/hvac/condensate/*.test.ts` (catalogue, ports, solver incl.
  randomised constraint check, planner physics on fixtures incl. all three terminations, crossings
  and hops, validation self-consistency, command/undo, VRF isolation, 3D mesh, presentation).
- Vitest: `hvac/unifiedAutoRoute.test.ts` (tick combinations on the real engines, single-line
  reduction and circuit protection, drain exclusion, hop folding, clash audit) and
  `unifiedAutoRoute.refusal.test.ts` (incomplete rebuild kept out of the preview).
- Vitest: `condensateEditing.test.ts` (re-solve fidelity, every gesture, verdicts, delete / re-route,
  persisted overrides, follow unit / gully) and `condensateRouteOps.test.ts` (operations, snapping,
  gully-first pick). On canvas: `D:\claude-tmp-vrf-check\micro.mjs` (every gesture with undo,
  bar actions, nudge, gully follow; screenshots `me-*`) and `micro3d.mjs` (Iso / Front / Side /
  partial tilt: 3D pick, bend on XY / XZ / YZ, Z level limit, riser height, undo; screenshots `m3-*`).
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
- Levels stay solved from the fall: a vertical drag sets a level limit (a maximum), never a fixed
  level; gullies and indoor units are moved in plan (their drains follow).
