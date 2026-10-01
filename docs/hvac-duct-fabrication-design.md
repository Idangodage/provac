# Duct fabrication engine: design

Rectangular supply and return ductwork, drawn as runs from the unit mouth, with every fabricated piece and accessory generated automatically.

Three constructions are supported: GI bare, GI with nitrile rubber (NBR) insulation, and pre-insulated panel duct (PID). Flexible duct is used for terminal connections.

- Code: `packages/drawing-engine/src/components/canvas/hvac/duct/`
- Construction rules and their sources: [hvac-duct-smacna-research.md](hvac-duct-smacna-research.md)

Status: **Phases 1–3 complete** (GI runs with joints; branches, transitions, offsets and round branches; levels, supports, NBR, design checks, clash and in-place editing — 2D + 3D on the real FDUM22, see [Phases 1–2 completion](#phases-12-completion) and [Phase 3 status](#phase-3-status)). P4–P5 below are next.

## Workflow

1. **Duct tool (U).** Hover a ducted unit: its supply and return collars highlight.
   - Click a collar and draw the centreline. Legs are orthogonal by default; Tab switches to 45°.
   - Set W × H (clear inside), construction, insulation and level (bottom of duct) in the tool panel. Changing them mid-run inserts a transition.
   - A **rise/drop** adds a vertical leg.
   - Starting on an existing run makes a **branch take-off**.
   - Finish with double-click or Enter. The run ends at whatever is under the cursor (a diffuser/grille, an existing duct), or at the default end (end cap / end plenum).
   - Backspace removes the last vertex. Esc cancels the draft with nothing written; a second Esc returns to Select.
2. **Commit.** The run is one undo step. The preview is built by the same code as the commit, so what you see is what is stored.
3. **Automatic fabrication.** From the stored run and the project duct settings, the engine derives everything below. None of it is stored, so an edit re-derives it all consistently.
   - Straight sections cut to stock length.
   - 90°/45° elbows (radius or square with turning vanes), risers, offsets, transitions, take-offs, splits, end caps, plenums.
   - The flexible connector at the unit.
   - Every transverse joint with its hardware: flanges, corner pieces, bolts, nuts, washers, cleats, rivets or screws, gasket, sealant.
   - Sheet thickness and reinforcement class, cross-break flags, seams.
   - NBR or PID takeoff.
   - Hangers and trapezes with rod lengths to the soffit.
   - Validation and a BOM / fabrication schedule.
4. **Review.**
   - Select a run: the inspector shows its sizes, construction, per-node elbow overrides and the run BOM.
   - The **Duct systems** panel shows the settings (with source badges), the project BOM, and the fabrication schedule as CSV.
   - `DU_*` design checks appear in the shared design-check list.

## Engineering rules

Defaults are editable; each carries provenance in `ductSettings.ts`. Rule IDs refer to the research doc.

| Rule | Default | Rule / source |
|---|---|---|
| Gauge mode | SMACNA 1995 schedules; per-project switch to the longest-side table | G-01..G-03 |
| Pressure class | supply 500 Pa, return 250 Pa (125/250/500 only) | SMACNA 1-3M..1-5M; G-05 |
| Joint spacing (GI section length) | 1200 mm (1500 option); make-up pieces ≥200 mm | practice |
| Available GI sheets | configurable stock list, provisional Finland `[0.5, 0.6, 0.7, 0.75, 1.0, 1.25, 1.5]` mm; smallest sheet ≥ the SMACNA minimum, error if none | G-04 |
| Pressure class above 500 Pa | refused with an explicit unsupported state (Tables 1-6M..1-9M not yet verified) | G-05 |
| Unit air ports | catalog `airPorts` first (FDUM22: supply −Y 674×164, return +Y 654×194); procedural openings only as flagged fallback | U-01 |
| Joint system | `auto`: TDC while its thickness rating reaches the class, else T-22 angle; or fixed TDC / Ductmate / angle | J-01..J-04 |
| Longitudinal seam | Pittsburgh (L-1); snaplock option (≤1000 Pa) | SMACNA Fig 1-5 |
| Seal class | from pressure class (Table 1-2); project may force Class A | J-07 |
| Elbow | `auto`: radius R/W 1.0 if the legs allow, else square with vanes; 50 mm necks | F-01 |
| Transition taper | 1:4 (≈14°); limits 20° expanding / 30° contracting | F-02 |
| Take-off | 45° shoe, lead-in max(W/4, 100 mm); VCD with locking quadrant | F-03, SMACNA §2.3 |
| Unit connection | fabric connector: 100 mm fabric + 2 × 75 mm metal | C-01 |
| Flex duct | ≤1.5 m, supports ≤1.5 m, sag ≤41.7 mm/m, draw bands, collars ≥51 mm | X-01 |
| Hangers | pair spacing 2.4 m; sized by Table 4-1M plus load check; ≤0.61 m from each elbow, ≤1.22 m from each branch; M8 minimum | H-01, H-02 |
| Trapeze | Table 4-3M by bar length (width + 2 × 100 mm rod offset) and load | H-03 |
| Risers | angle pair at ≤3.66 m | H-04 |
| NBR | supply 25 mm, return 19 mm; adhesive 8 m²/L of sheet; 50 mm tape; 10 % waste; insert at each trapeze | N-01 |
| PID | 15HP21 (PIR 20 mm, 80/80 µm) indoor; invisible-flange joints; panel 4000 × 1200 | P-01..P-05 |

## Data model

**Persisted: design intent only.** One `duct` element per run (`properties.ductRun`, version 1):
- service; construction; path (plan XY + level z, level reference defaulting to bottom of duct);
- per-leg clear inside W × H; insulation thickness; pressure class; optional joint system or gauge override;
- `start`/`end` ends: unit mouth, tap, split, spigot, terminal, end plenum, end cap or open;
- per-node overrides (elbow style, radius ratio, vane type, riser twist);
- the soffit datum for supports; a lock flag.

The ends are deliberately not named `startConnection`, so refrigerant readers never treat a duct as one of their connections.

**Other persisted elements**
- `duct-plenum` elements (unit plenums with spigots).
- A `plenumBox` property on diffusers and return grilles.
- `ductSettings` on the document.

**Legacy ducts.** The stubs the old tool made (`giDuctModel.ts` shape: outer size, `routePoints`, `startConnection`) are read by `readDuctRunSpec` as a straight run. No migration step.

**Derived: `DuctFabricationPlan`.** Produced by `planDuctRun(run, networkIndex, settings)`, memoised per element, settings and neighbour signature. It holds:
- pieces with marks (S-, E-, T-, O-, B-, C-, P-);
- joints with required and provided class and hardware;
- per-piece thickness, seams, reinforcement and cross-break;
- insulation or PID takeoff; supports; issues.

The 2D overlay, 3D builder, picking, BOM, validation and the debug handle all read this plan.

## Algorithm

1. **Frames.** Centreline in 3D from the path and level reference. W stays horizontal through easy-way vertical elbows; a hard-way elbow is flagged.
2. **Elbows** at every turn over 2°.
   - Radius: setback R·tan(θ/2) + neck.
   - Square with vanes: setback W/2 + neck; vane count from spacing.
   - PID: minimum inner radius by height, and splitter vanes.
   - `auto` falls back from radius to vaned when the legs are short.
   - Two 45° elbows with less than a make-up piece between them become one offset.
3. **Transitions** at size changes: length from the taper; flat bottom when the level reference is the bottom.
4. **Take-off windows** from child runs: no joint may fall inside one.
5. **Straight spans** split into stock sections from the upstream end. A short remainder is shared with the previous section. Joints shift out of take-off windows. PID straights use 4000 mm panels, or ≤1200 mm under the cutting rule.
6. **Construction per section** (SMACNA mode):
   1. Thickness from the greater side's row at the joint-spacing column (G-01).
   2. Class for each side from its own row (G-02). The joint takes the higher.
   3. For TDC, raise the thickness until its Table 1-12M rating reaches the class. Otherwise, in `auto`, use a T-22 angle.
   4. Round the thickness up to the available sheet list.
   5. Not Designed at the joint spacing → intermediate reinforcement (1-10M).
   6. Cross-break flag unless insulated.
7. **Joints and hardware** (per joint = two duct ends)
   - **TDC:** 8 corners, 4 × M10 bolts + nuts (+ washers per setting), gasket = perimeter, 152 mm cleats within 152 mm of each corner then at ≤381 mm.
   - **Ductmate:** series by thickness and class (DM25 F / DM35 J / DM45 K); 8 flange pieces, 8 corners, 4 bolts, 440 gasket; cleats 152 mm at 610 mm centres; manufacturer screw schedule.
   - **Angle (T-22):** 2 welded frames sized by class; M8 bolts at ≤152 mm with corners shared, each with 1 nut and 2 washers; angle-to-duct rivets at ≤305 mm including corners; gasket.
   - **PID invisible flange:** 8 profiles (inner −3 mm), 8 corners, 4 H-bayonets, 4 covering angles.
   - **PID traditional flange, take-off, anti-vibration and machine joints:** per the P3 counts.
8. **Ends and accessories**
   - **Unit mouth:** fabric connector (GI) or F-profiles (PID).
   - **End cap.**
   - **End plenum** with spigots.
   - **Terminal:** spigot + VCD + flex run + diffuser `plenumBox`.
   - **Split:** Y, or bullhead with vanes.
9. **Supports** (derived)
   - Near each elbow and branch first, then fill at the spacing, kept off flanges (±100 mm).
   - Rod and strap sizes from Table 4-1M, then a load check (sheet + joints + insulation) against the metric rod capacity.
   - Trapeze from Table 4-3M. Rod length = soffit − trapeze top.
   - Risers: angle pairs. PID: U-profile over 600 mm, bracket below. Flex: strap every 1.5 m.
10. **Takeoff**
    - **NBR:** area at the mid-plane plus fitting developments, adhesive, tape, sheets, inserts.
    - **PID:** cutting method; strips nested per 4000 × 1200 panel; glue, tape, silicone, rods and discs (count unverified).

Invariant: the lengths of the pieces sum to the centreline length (property-tested).

## Validation codes (`ductValidation.ts`)

| Group | Codes |
|---|---|
| Geometry and fittings | `DU_TRANSITION_ANGLE`, `DU_ELBOW_RADIUS`, `DU_LEG_TOO_SHORT`, `DU_VANE_SPAN`, `DU_SLOPED_LEG` (a leg that runs and climbs; a riser that turns back; a riser straight off a collar), `DU_HARD_WAY_ELBOW` (a plan turn at a riser), `DU_TURN_BACK` (a plan turn sharper than 150°: the run doubles back), `DU_ASPECT_RATIO` (>4:1, info), `DU_SIZE_OVER_TABLE` |
| Construction | `DU_PRESSURE_UNSUPPORTED` (above 500 Pa), `DU_NO_STOCK`, `DU_GAUGE_JOINT`, `DU_GAUGE_OVERRIDE`, `DU_INTERMEDIATE_REINF`, `DU_CROSS_BREAK` (info; not on insulated duct). P5: `DU_PID_LIMITS`, `DU_PID_REINF_UNVERIFIED` |
| Branches | `DU_TAP_TOO_BIG`, `DU_TAP_CLASH`, `DU_SPLIT_INCOMPLETE`, `DU_SPLIT_SIZE`, `DU_BRANCH_DIRECTION` |
| Connections | `DU_MOUTH_APPROX` (unit without measured ports), `DU_OPEN_END`, `DU_STALE`, `DU_TERMINAL_SIZE` (rigid end off the spigot's Ø), `DU_TERMINAL_ALIGN` (rigid end not level, square and on the spigot's axis) |
| Plenums and flex | `DU_PLENUM_SIZE` (a spigot off its face, or a plenum after a riser), `DU_SPIGOT_CLASH` (spigots closer than 50 mm, practice), `DU_FLEX_LENGTH` (over the project maximum, 1.5 m), `DU_FLEX_BEND` (R < 1 D, S3.24), `DU_FLEX_SIZE` (runout Ø ≠ spigot Ø), `DU_FLEX_DROP` (info: over 0.91 m to the terminal, Fig. 2-15). The sag is drawn within 41.7 mm/m, so no sag check is raised. |
| Supports | `DU_SUPPORT_RULE` (no straight within S4.1 reach or the spacing), `DU_SUPPORT_LOAD` (beyond Table 4-3M or an M16 rod), `DU_SOFFIT` (the duct reaches the soffit) |
| Coordination | `DU_CLASH` (duct body against a pipe, another duct, or an air terminal's box) |

All of them reach the design-check list (`ductValidation.ts`, `useDuctLiveValidation`), merged with the refrigerant and condensate checks; information-level entries are counted but not listed.

A freshly drawn standard run validates clean.

## Rendering

- **2D: `DuctOverlay.tsx`**, an SVG overlay like `CondensateOverlay`, synced through `syncViewTransform`. Detail depends on zoom:

  | Zoom | Content |
  |---|---|
  | Far | centre band + size tag |
  | Mid | double lines, joint ticks, elbow arcs, transition trapezoids, taps, end caps, rise/drop symbol, flow arrows, dashed insulation |
  | Near | vanes, hangers, piece marks |

  - Tag: `600×400 · GI 0.70 (24ga) · NBR 25 · BOD 2750`.
  - The Fabric plan renderer skips duct bodies; picking is geometric.
- **3D: `three3d/ductMeshes.ts`**, built in world space, no CSG.
  - Rectangular tubes, rectangular sweeps (radius elbows), mitres with vanes, lofts (transitions, shoes), flange frames (TDC or L-angle), fabric connector, spigots and VCDs, flex with sag, NBR skin (black), PID skin (aluminium), rods, trapezes, riser angles, U-profiles.
  - Merged per material, about 7 meshes per run. Materials are shared; geometry never is.

## Integration points

- **Types and store**
  - `types/wall.ts`: `duct-plenum`.
  - `store/index.ts`: category, `ductSettings` field, setter, export/import, and the delete cascade (orphaned branches become open ends).
- **3D**
  - `three3d/buildHvacElementMesh.ts`: type gate, palette, dispatcher, diffuser `plenumBox`, `HvacBuildSceneContext.ductSettings`.
  - `hybrid/hybridHvacScene.ts`: dependencies (settings + parent/child runs).
  - `HybridProjectionLayer.tsx` and `IsometricViewCanvas.tsx`: context and draft path. The dead isometric `case "duct"` goes.
- **2D**
  - `HvacPlanRenderer.ts`: skip the duct body, pick order, unit mouths from catalog `airPorts`, terminal symbols.
  - `DrawingCanvas.tsx`: overlay mount and view sync, tool wiring, Esc, validation merge.
  - `__PROVACX_DEBUG__`: `getAirPorts`, `getDuctPlan`, `getDuctBom`, `getDuctSchedule`, `getDuctValidation`, `getDuctSupports`, `drawDuct`, `setDuctSettings`.
- **Coordination**
  - `condensate/condensateEnvironment.ts`: per-leg duct footprints instead of the bounding box. An L-shaped duct must not block the empty corner of its bounding box.
  - `networkPipeClearance.ts`: duct volumes.
  - `autoRouteNetwork.ts`: duct obstacles.
- **Catalog and UI**
  - `data/ac-equipment-library.ts`: `air-distribution` category (diffusers, grilles); FDUM22 measured `airPorts`.
  - `PropertiesPanel.tsx`: tool section, run and plenum inspectors, Duct systems section.
  - SVG export (`SmartDrawingEditor.tsx`) composes the duct overlay.

## Phases

Each phase ends with an on-canvas check against real elements.

| Phase | Content | Exit on canvas |
|---|---|---|
| P0 | This doc and the research doc; measured unit ports | reviewed |
| P1 | GI runs: engine core, SMACNA tables, joints (TDC / Ductmate / angle), elbows, sections, connector, end cap, overlay, 3D, tool rewrite, inspector, sheet+joint BOM; per-leg condensate footprints | 4-vertex supply run off the real FDUM22 collar in 2D and 3D; legacy duct still renders; one undo |
| P2 | Branches (shoe, straight, spin-in, VCD; Y and bullhead splits) + transitions; delete cascade | main + 2 taps + reducer + Y split; delete main → branches flagged; one undo restores |
| P3 | Vertical legs, offsets, supports, NBR, validation, clash | 600 mm drop + 600→400 reducer, Table 4-1M hangers, NBR skin, DU_* checks |
| P4 | Plenums (unit, diffuser box, end), diffusers/grilles, flex runs | unit plenum with 3 spigots → flex → 3 diffusers; return to a grille |
| P5 | PID, exports, auto-route obstacles, benchmarks | the same layout in PID; CSVs; SVG export contains the ducts |

## Verification

**Vitest**, run as `pnpm --filter @provacx/drawing-engine test`, with `type-check` and `lint`.
- SMACNA golden cells (see the research doc), band contiguity, and a table checksum.
- Gauge, joint and class escalation.
- Planner splits and length conservation (fast-check).
- Hardware counts, supports, NBR takeoff, PID cutting and nesting.
- Validation codes.
- One-undo commands.
- 3D bounding boxes and mesh names.
- Condensate footprint regression.

**On canvas:** `D:\claude-tmp-vrf-check\duct.mjs` (cloned from `condensate.mjs`). Steps: setup, real mouse draw, scripted runs, undo, a settings switch, export round-trip, screenshots in 2D at three zooms and in tilt and iso. Zero page errors.

## Phase 1 status

**Built** (`hvac/duct/`, `three3d/ductMeshes.ts`, `hooks/useDuctTool.ts`):
- SMACNA Tables 1-3M/1-4M/1-5M generated from the verified transcription (`smacnaRectangularTables.ts`, digest-tested).
- Gauge, class and joint selection with the configurable stock list.
- Joint hardware (TDC, Ductmate, T-22).
- Measured unit air ports.
- Planner: connector, sections with shared make-ups, radius and square vaned elbows, end cap, joints.
- BOM, schedule and CSV.
- Plan overlay, geometric picking, 3D meshes.
- The rewritten Duct tool, the run inspector, the tool section and the Duct Systems section.
- `ductSettings` in the document.
- Per-leg duct footprints for condensate routing. Old stubs keep their bounding box, so condensate is unchanged for existing drawings.

**Verified**
- **Vitest.** The full drawing-engine suite passes: 168 files, 1494 tests. The duct-specific tests cover:
  - FDUM22 −Y supply = 674 × 164 and +Y return = 654 × 194, both checked against the real GLB collars within 2 mm;
  - the run centreline starting on the collar in 2D (piece and outline) and in 3D (mesh bounds, centre height);
  - SMACNA selection and the corrected 500 Pa / 1.2 m cells;
  - stock rounding (0.55→0.60, 0.70→0.70, 0.85→1.00, 1.00→1.00, 1.31→1.50, 1.61→error);
  - above 500 Pa refused with an explicit state in the planner, BOM and 3D;
  - one undo per run;
  - settings export and import;
  - the condensate obstacle regression.
- **On canvas** (`D:\claude-tmp-vrf-check\duct.mjs`, worktree server on :3100):
  1. Placed the real FDUM22 and pressed U; hovering highlights "SUPPLY 674×164".
  2. Clicking the collar and two bends shows the live draft with connector, joints, elbow and tag.
  3. Enter commits. The plan's first piece starts exactly at the collar lip, level with its centre.
  4. Construction resolves to T1-5M D-0.55 → 0.60 stock, TDC. The BOM reads 64 corners, 32 M10 bolts and 48 cleats for 8 joints.
  5. Clicking the duct selects it; the inspector shows the construction.
  6. The iso view shows GI sections, flanges, radius elbows, the fabric connector and the end cap.
  7. 750 Pa gives the explicit error. One undo removes the run and redo restores it.
  8. The project was restored afterwards. No page errors beyond a 404 that is already there on first load.

**Phase 1 limits (all resolved)**
- ~~The FDUM22 GLB renders as a flat slab in iso.~~ Root cause: the IFC → GLB export places only the last of the unit's meshes; the loader now places the unplaced ones (see completion).
- ~~The live draft is drawn in 2D only.~~ The draft (and any run it re-plans) is shown in 3D too.
- ~~A custom W × H that differs from the collar is flagged `DU_MOUTH_MISMATCH`.~~ A transition follows the connector (P2).
- ~~Old Fabric duct code is still present.~~ Removed; the isometric canvas draws ducts from the plan.

## Phase 2 design: branches and transitions

**Transitions (reducers)**
- Each leg keeps its own clear section.
- Where the size changes, a transition is fabricated on the downstream leg (downstream = along the drawn path):
  - at the node itself when the run goes straight on;
  - right after the elbow when the node turns (the elbow keeps the incoming size);
  - right after the connector when the first leg differs from the unit collar (this replaces the Phase 1 `DU_MOUTH_MISMATCH` warning).
- Flat bottom: the clear bottom stays level; the width changes equally on both sides.
- Length = 50 mm neck + slope + 50 mm neck, with slope = max(|ΔW|/2, |ΔH|) / tan(taper), taper 14° (1:4), rounded up to 10 mm.
- If the leg is too short, the slope is compressed. `DU_TRANSITION_ANGLE` fires past the SMACNA Fig. 2-7 limits, judged in the flow direction (supply flows along the path, return against it): the plan width is concentric (45° included diverging, 60° converging) and the flat-bottom height change eccentric (30°).
- A transition takes the construction of its larger end (S1.16).

**Side take-offs (taps)**
- A branch run starts on the side of an existing run: `start = { kind: 'tap', parentRunId, legIndex, stationMm, side, style, vcd }`.
- Branch start point: on the parent's outer wall at the station, leaving square to the parent.
- Its clear bottom is level with the parent's (flat bottom). A branch taller than the parent, or wider than the parent leg can hold, raises `DU_TAP_TOO_BIG`.
- Branch pieces start with:
  - a take-off collar, max(100 mm, lead-in + 50 mm) long (project practice); the `shoe-45` style adds a 45° lead-in of W/4, 102 mm minimum (SMACNA Fig. 2-6), on the upstream side (toward the parent's start);
  - then an optional volume damper (VCD) section, 150 mm, with a locking quadrant;
  - then the branch's own sections.
- The collar is screwed to the parent at the S1.40 spacing and sealed.
- The parent gets a **tap window** (opening + lead-in + 50 mm each side). No transverse joint may fall inside it: the section layout moves the joint to the window edge. A window that overlaps an elbow, transition, connector or another window raises `DU_TAP_CLASH`.

**End splits**
- A run whose end is `{ kind: 'split', style: 'bullhead' | 'y' }` feeds two branch runs: `start = { kind: 'split-branch', parentRunId, side: ±1 }`.
- **Bullhead tee:** the parent continues as a box of depth = neck + the wider branch width. The branch openings sit in its side walls, flush with the far (capped) end, and the tee carries turning vanes.
- **Y (divided flow):** the parent width is shared between the two branches, each turning 90° through its own radius elbow (R = R/W × branch width). The two heels meet on the split line.
- With only one branch present, the other outlet is capped and `DU_SPLIT_INCOMPLETE` fires.

**Network**
- Branch runs refer to their parent by id.
- A plan depends on the run, the project settings, its unit or parent, and its branches. The plan cache and the 3D scene cache key on all of these.

**Delete cascade** (inside `deleteSelectedElements`, one history step)
- Branches of a deleted run keep their geometry, but their start becomes `open` and flagged `orphaned`, so `DU_OPEN_END` is a warning.
- A split whose branches are all deleted reverts to an end cap.

**Tool**
- Hovering a run's side offers a tap; hovering an open or capped run end offers a split side.
- Branch size, tap style, VCD and split style come from the Duct tool section.
- Changing W × H while drawing applies to the next legs and produces a transition.
- Each gesture is one `commitHvacElementCommand`. Starting a split also updates the parent's end in the same command.

**Rendering**
- 2D: transition trapezoids, shoe outlines, the VCD symbol (blade line + quadrant), the tee body with vanes, and the Y's two elbows.
- 3D: the sweep takes a section per ring, so transitions and shoes are lofts. The tee is a box with a capped heel; the Y is two radius sweeps.

**BOM:** transitions with both sizes and length, take-off collars by style, VCDs, split fittings, and collar screws and sealant.

**Exit on canvas:** a main run with two taps, a reducer after the first tap and a Y split at its end. Deleting the main flags the branches `DU_OPEN_END`; one undo restores everything.

## Phase 2 status

**Built**
- `ductTypes.ts`: tap, split-branch and split ends; `ductParentRunId`.
- `ductBranches.ts`: tap attachment (wall point, direction, lead-in, collar, opening) and split outlets. Y: offset half-sections through radius elbows. Bullhead: tee body with vanes.
- `ductNetwork.ts`: branch index per scene, parent lookup, `expandDuctDeletion`.
- Planner:
  - per-leg sections with flat-bottom transitions (at a straight node, after an elbow, after the connector);
  - take-off + VCD start pieces, tap windows with joint relocation, split fittings;
  - issue codes `DU_TRANSITION_ANGLE`, `DU_TAP_TOO_BIG`, `DU_TAP_CLASH`, `DU_SPLIT_INCOMPLETE`, `DU_SPLIT_SIZE`, `DU_BRANCH_DIRECTION` (first leg must leave square to the parent), and `DU_OPEN_END` for orphans;
  - the plan cache keys on the unit, the parent and the branches.
- Take-off hardware (screws round the opening, sealed corners); BOM rows for transitions, take-offs, dampers and splits.
- Rendering:
  - 2D: transition trapezoids, shoe outlines, damper blade + quadrant, tee and Y outlines, amber markers at warnings such as orphaned open starts;
  - 3D: lofted transitions and shoes, damper blade and quadrant, tee body and cap, Y elbow sweeps with capped-side plates.
- `ductBranchTargets.ts`: `tapOrigin`, `splitOrigin`, `findBranchTarget`. Shared by the tool, the debug handle and the tests.
- `ductDraft.ts`: `buildDuctRunDraft` returns the branch plus the parent it changes (a split end). `ductRunDraftCommand` makes that one command.
- Tool:
  - starts from a collar, a run's side wall (take-off) or a run's end (split side);
  - hover marker; per-leg sizes fixed at each click, so a size change mid-draw becomes a transition;
  - the live draft re-plans the parent (moved joints, growing split);
  - the second press of a double-click never adds a leg (a P1 bug: it added a stray turn whenever the click was off the leg axis).
- Tool section: branch W × H, take-off style, split style, damper. Inspector: start and end, a per-leg section list, a piece summary, and the end style (cap/open/Y/bullhead; cap and open are disabled while split branches exist).
- Store: `deleteSelectedElements` and `deleteHvacElement` run the cascade in the same history step. 3D scene deps: parent + branches. Debug handle: `drawDuctBranch`, `drawDuct(..., legSizes)`.

**Verified**
- **Vitest.** `ductBranches.test.ts` (transitions, take-offs, windows, splits, cascade, fast-check window layout), 3D tests for the reducer loft, shoe + damper and Y split, and a store test for delete + one undo. Full drawing-engine suite: 169 files, 1514 of 1515 tests pass. The one failure is the refrigerant `autoRouteNetwork.geometry.test.ts` "four cardinal directions" case, which timed out (65 s against a 60 s limit) under full-suite load. It passes when run alone (8/8) and does not touch duct code.
- **On canvas** (`D:\claude-tmp-vrf-check\duct-branches.mjs`, all drawn with the real tool and the Duct Tool panel on the real FDUM22):
  1. **Main run:** 3.5 m at the collar size, then 500 × 164 set in the panel mid-draw → a 450 mm flat-bottom transition at 3.5 m. No issues.
  2. **Tap 1** (shoe 45° + VCD) at 1.5 m: the main's 1450 joint moves to 1200 / 2400, outside the window. The lead-in faces upstream.
  3. **Tap 2** after the reducer, on the other wall, with a 90° turn. **Y split** at the end with a 250 × 150 branch each side. Every run: status ok, no issues.
  4. **Live drafts:** the draft layer holds the branch and its re-planned parent, and only the committed parent is hidden.
  5. **3D:** iso shows every fitting.
  6. **BOM:** 1 transition, 2 shoe take-offs, 2 dampers, 1 Y split, 2 take-off connections.
  7. **Delete:** selecting the main and pressing Delete leaves 4 branches, each open with `DU_OPEN_END` and an amber marker. One undo restores the exact document.
  8. **Cleanup:** the project was restored exactly afterwards. The only page error is the known first-load 404.

**Phase 2 limits (resolved unless noted)**
- ~~Take-offs are rectangular only.~~ Round branches with spin-in or conical collars and round dampers (see completion).
- Taps sit on straight sections only; not on elbows, transitions, offsets or connectors. This is by design, and `DU_TAP_CLASH` guards moved parents.
- ~~Branches do not follow a moved or resized parent.~~ They re-anchor in the same command.
- ~~An orphaned branch cannot be re-attached.~~ One click with the Duct tool, or the inspector button.

## Phases 1–2 completion

Done on 25 September 2026 at your request ("complete all the missing things"). The SMACNA figures were read from the scanned PDF; see the research doc.

**Rules (verified from the figures)**
- R/W 1.5 default (Fig. 2-2), with `DU_ELBOW_RADIUS` below 1.0 (warning) and below 0.5 (error).
- Vane schedule and span per Figs 2-3 / 2-4: vane-type setting, count along the diagonal runner, and sections with intermediate runners (`DU_VANE_SPAN`); vanes and runners in the BOM.
- Shoe lead-in W/4, 102 mm minimum (Fig. 2-6).
- Transitions: concentric in plan and eccentric in elevation (Fig. 2-7).
- Dampers laid out per Figs 2-12 / 2-13 (single blade to 305 mm high; opposed multi-blade above; round).
- Connector 102 + 2 × 76 (Fig. 2-17). TDC clips per Fig. 1-15.
- Round duct: Tables 3-2AM / 3-2BM, Table 3-1, Figs 3-1 / 3-2.
- Values SMACNA has no number for are labelled "practice" everywhere, never "verified".

**Phase 1 gaps closed**
- **Offsets** (Fig. 2-7): a 45° jog too short for two elbows becomes one mitred offset (Type 2); a tight 90° Z becomes an ogee with a throat of 150 mm or more (Type 3). Drawn in 2D and 3D and in the BOM.
- **Seams:** Pittsburgh / snaplock allowance from the SMACNA pockets, seams per section by coil width, seam length in the BOM.
- **Run inspector:** per-leg W × H, pressure class, sheet override (`DU_GAUGE_OVERRIDE` unless stocked and at least the SMACNA minimum), per-elbow style / R/W / vanes, end, and Re-attach. Every edit is one undo, and branches follow.
- **Duct Systems:** every setting editable with a verified / practice badge.
- **3D live draft**, with the preview hiding what it re-draws, and Escape now cancels from any view. Previously a focused view button swallowed Escape.
- **Tool:** continue a run from its open end (also from an occupied collar); start in free space; a free run finished on a run becomes a take-off.
- **Ducts follow units** (move and turn) in both the drag and the arrow-nudge paths.
- **Run move:** drag a selected run, or nudge it. A take-off slides along its parent; runs on a collar or split outlet refuse. Nudging a duct used to move only its envelope.
- **Legacy code removed:** the Fabric duct case, and `giDuctModel.ts` reduced to the legacy fixture.
- **FDUM22 in 3D:** the MEPcontent IFC → GLB export placed only the last of each unit's meshes. The loader now places the unplaced meshes, so the whole ducted unit (and the other catalog units) render.

**Phase 2 gaps closed**
- **Round branches:** `spin-in` / `conical` collars off rectangular runs; Table 3-2AM / 3-2BM gauge; RT-1 sleeve or RT-5 crimp with Fig. 3-2 screws; gored elbows per Table 3-1; round dampers, reducers and caps; cylinders and gores in 3D; "Ø" tags; BOM rows. Round runs carry no take-offs or splits.
- **Branches follow their parent** (resize, move, unit move), recursively, in one command.
- **Re-attach orphans:** cast back from the open start to the nearest run wall (≤ 1.5 m) and make it a take-off.

**Verified**
- **Vitest:** full drawing-engine suite 175 files, 1563 tests, all passing (219 of them duct / store / 3D), including:
  - `ductFittingRules.test.ts` (figure rules);
  - `ductOffsets.test.ts`, `ductFollow.test.ts`, `ductDraftContinue.test.ts`, `ductRound.test.ts`;
  - `store/ductEdits.test.ts` (one undo per edit, slide, re-attach, sheet override);
  - `glbModelCache.test.ts` (the real FDUM22 file: 7 meshes placed, 1084 × 300 bounds).
- **On canvas** (`D:\claude-tmp-vrf-check\duct-complete.mjs`, real tool / panel / keyboard / mouse on the real FDUM22, project restored exactly), all passing:
  1. A 45° jog became a mitred offset and a tight Z an ogee. Continuing the open end added a leg and a cap.
  2. An inspector leg edit added a reducer.
  3. Round Ø150 spin-in branch with a 4-piece gored elbow; rectangular take-off.
  4. An arrow-nudge of the unit carried the main and both branches, with nothing stale.
  5. Dragging the take-off slid it 400 mm along the main.
  6. Deleting the main orphaned the branches; after redrawing it, one click re-attached the round branch.
  7. A free run finished on the new main became a take-off.
- **On canvas, 3D** (`duct-draft3d.mjs`): the full FDUM22 at the ceiling with the connector on its collar; the live draft rendered translucent; Escape in iso cancelled it.


## Phase 3 design: levels, supports, NBR, validation, clash, editing

**Levels (vertical legs)**
- A path vertex's z is the clear bottom at that vertex. A vertical leg is two consecutive vertices at the same plan point (a riser up or a drop down). A leg that both runs and climbs is refused (`DU_SLOPED_LEG`): ducts are level or vertical.
- **Vertical-plane elbows:**
  - An elbow between a horizontal and a vertical leg bends in the vertical plane and is easy-way (W stays horizontal): the in-plane size is H.
  - Radius R = R/W × H, or square with vanes spanning W.
  - A riser keeps its heading. Turning in plan on a riser (a compound bend) is refused (`DU_HARD_WAY_ELBOW`): turn on a horizontal leg instead.
- **Vertical offsets:** a short rise or drop whose two elbows do not fit becomes one offset (Fig. 2-7), mitred ≤ 60° or ogee, in the vertical plane.
- **Tool:** a Level (clear bottom) field. Changing it mid-draw inserts a riser at the current point before the next leg; `[` / `]` step it by 50 mm. The draft label shows the level.
- **2D:** a riser is its W × H box at the vertex, with a diagonal and "▲ +600" or "▼ −600". Vertical-plane elbows show their horizontal half.
- **3D:** sweeps run in 3D with the W axis held horizontal.
- Take-offs sit on horizontal straights only.

**Supports (`ductSupports.ts`)**, derived from the plan and never stored
- Rectangular hangers per Table 4-1M:
  - the row by half-perimeter P/2 (≤ 1.25 × the widest side above 1520 mm);
  - the column by the pair spacing (default 2.4 m);
  - rod or strap per pair, with a load check (sheet + joints + 4.89 kg/m² insulation allowance) against the single-hanger loads;
  - metric rods from the derived stress-area table.
- Round: Table 4-2 by diameter, 3.7 m maximum.
- **Positions:**
  - at the spacing along every horizontal leg;
  - plus within 610 mm of each elbow and 1220 mm of each branch intersection (S4.1), and 300 mm from the unit (practice);
  - never on a joint (moved clear of flanges by 150 mm, practice).
- **Trapeze:** bar length = duct width + 2 × 50 mm rod offset + rod. Member from Table 4-3M by the load per trapeze. Rods run up to the soffit datum (the pipe-routing ceiling setting), each with length and size.
- **Risers:** angle or channel supports at the floor/level interval 3.66–7.32 m (§4.2.10; default 3.66 m) plus one at the base.
- **Display:** 2D hanger marks (rod dots and the trapeze line) at mid zoom; 3D rods, trapeze bars and riser angles. BOM: rods by size and length, trapeze members, nuts, washers, anchors, riser angles.

**NBR (`gi-nbr` construction, `ductInsulation.ts`)**
- Thickness per run (project default: supply 25 mm, return 19 mm).
- Area at the insulation mid-plane:
  - straights: (girth + 4t) × L;
  - elbows and transitions by developed area;
  - joints boxed with a band.
- Adhesive at 8 m²/L both faces (ArmaFlex 520); 50 mm tape on seams and joints; sheets with a waste setting (10 %).
- One load-bearing insert per trapeze. S1.15 cross-breaking is dropped (exempt when externally insulated).
- 2D: a dashed outline at the insulation's outer face. 3D: a black skin.
- The inspector gets a construction selector (GI bare / GI + NBR) and the thickness.

**Validation (`ductValidation.ts`, `useDuctLiveValidation`)**
- Every `DU_*` issue of every run becomes a design-check entry merged with the VRF and condensate reports (`mergeValidationReports`), so it appears in the checks chip and list with a zoom-to point.

**Clash**
- Duct volumes (per piece: outer box plus insulation, with its z band) join `networkPipeClearance.ts`. `DU_CLASH` is raised for duct against refrigerant or condensate pipe, duct against duct, and duct above the soffit (`DU_ABOVE_SOFFIT`).
- Refrigerant edits and Auto route see ducts as obstacles.

**Editing handles (plan)**
- On a selected run:
  - drag a leg sideways (it stays parallel and both neighbours stretch);
  - drag the end point;
  - drag a riser (it moves along its heading);
  - edit a vertex level from the inspector.
- Branches follow; one undo per gesture.

**Exit on canvas:**
- a supply run from the FDUM22 with a 600 mm drop and a 600 → 400 reducer;
- hangers per Table 4-1M with rods to the soffit; NBR 25 on supply;
- `DU_*` issues in the design checks;
- a clash flagged against a crossing refrigerant pipe.

## Phase 3 status

Built and verified on 25 September 2026.

**Levels (D1)**
- Legs are level or vertical (`ductLegs`: `vertical`, heading, centreline rise). Vertical-plane elbows bend the easy way on H in the riser's plane (local frame `DuctVerticalFrame`), gored when round; square vaned ones span W. A short rise or drop becomes a vertical ogee offset; transitions on a riser are concentric.
- Refused: a sloped leg, a riser that turns back, a riser straight off a collar or parent wall (`DU_SLOPED_LEG`), a plan turn at a riser (`DU_HARD_WAY_ELBOW`). Take-offs and splits stay on level legs.
- A leg remainder shorter than the minimum make-up piece is taken up in the elbow neck (practice). A 600 mm drop on a 164 mm high duct leaves 8 mm between its two R = 1.5 H elbows; that was an 8 mm "section" before.
- **Tool:** a Level field (clear bottom) and `[` / `]` (±50 mm) set the next leg's level. The leg rises or drops where it starts, then goes straight on. At a collar the change waits for the next point. Finishing with a change pending ends the run in that riser. Keys typed in a tool-panel field no longer reach the tool (Backspace in the Level box used to delete a leg).
- **2D:** the riser box with one diagonal (up) or two (down) and "▼ 600 · BOD 1869"; vertical fittings drawn as their plan band; one size tag per section and level.
- **3D:** sweeps along 3D centrelines with the width held horizontal and the section mitred at every bend; flanges on a riser lie flat.

**Supports (D2, `ductSupports.ts`, `ductSupportTables.ts`)**
- Tables 4-1M, 4-2 and 4-3M and the single-hanger loads are in code. Metric rods are derived (6.2 kg per mm² of stress area).
- Required supports:
  - within 610 mm of each side of every level elbow (SMACNA asks for one; practice supports both sides);
  - within 610 mm of the level side of every riser elbow and of each end of an offset;
  - within 1220 mm of each take-off, on the parent and on the branch;
  - 300 mm past the unit's connector (practice);
  - near a free end.
- Gaps are then filled to the spacing (2.4 m; round 3.7 m max). The gap is measured along the straight duct, since an elbow is held at its ends.
- Hangers sit on straights and transitions, 150 mm clear of joints.
- **Sizing:**
  - load from the run's share: sheet, 4.89 kg/m² insulation allowance, and the bar;
  - rods by load from M8;
  - the lightest Table 4-3M angle for the rod span.
- Rods run to the soffit: the pipe-routing ceiling limit, or a Duct Systems value. Risers get angle pairs at the §4.2.10 interval (members are practice sizes). Round ducts up to 900 mm hang from one rod and a band.
- **Display and BOM:**
  - 2D: bar and rod dots.
  - 3D: rods, L-angle bars, bands and riser angles.
  - BOM: rods in metres and cut lengths, one anchor per rod, nuts, washers, angles, bands and riser angles.
  - Inspector: a supports summary.

**NBR (D3, `ductInsulation.ts`)**
- `gi-nbr` construction per run, set from the inspector or as the project default for new runs; a branch takes its parent's.
- Thickness: the run's own, else 25 mm supply / 19 mm return (practice).
- Takeoff at the mid-plane plus flange bands 2 × projection + 100 mm wide. The connector is left free to flex. Adhesive at 8 m²/L (Armacell 520: 7–9); tape and 10 % waste are practice.
- Supports hang under the insulation with a load-bearing insert per trapeze. Cross-breaking is dropped (S1.15).
- 2D dashed outline; tag "NBR 25"; BOD is the insulation's underside. 3D black skin.

**Checks and clash (D4, D5)**
- **Checks:** every `DU_*` issue of every run joins the one design-check list, deduplicated per run.
- **Clash model (`ductVolumes.ts`):** duct bodies are oriented boxes per piece, insulation included; arcs, offsets and risers are split into short segments.
  - Against pipes: a segment-to-box distance below the pipe's insulated radius.
  - Against other ducts: a separating-axis overlap. A branch and its parent never clash.
  - Result: `DU_CLASH`.
- **Obstacles:** the pipe engine's new-clash check (`networkPipeClearance.ts`) now rejects a new pipe route through a duct. Auto route, branch kits and riser upgrades therefore keep clear of ducts. The duct settings reach it through `setActiveDuctSettings`.
- **3D fix:** a 3D bucket that mixed boxes (with UVs) and sweeps (without) failed to merge and vanished silently. UVs are now stripped before merging. This was hiding the NBR skin, and the same bug could drop damper or band meshes.

**Editing (D6, `ductEdits.ts`)**
- Handles on a single selected run:
  - a square per movable leg (it moves sideways and stays parallel; the legs either side stretch along their own lines, a riser at a moved corner goes with it; the leg off a collar or parent wall stays);
  - a diamond per riser (it moves along its heading);
  - a circle at the end (it moves along the last leg).
- The inspector edits a riser's rise or drop, and the run after it moves with it.
- A leg whose neighbour is collinear cannot be dragged sideways: that would need new elbows.
- Take-offs on a leg whose start slid keep their place in the world. One command per gesture, branches following. Space-drag pans over a selected run (it used to start a run move).

**Verified**
- **Vitest:**
  - `ductVertical.test.ts`;
  - `ductSupports.test.ts`;
  - `ductInsulation.test.ts`;
  - `ductChecks.test.ts` (report shape, pipe and duct clashes, ducts as pipe obstacles);
  - `store/ductInPlaceEdits.test.ts`.
  - Duct, 3D and store suites: 254 tests.
- **On canvas** (`D:\claude-tmp-vrf-check\duct-p3.mjs`: real tool, panel, keys and mouse on the real FDUM22; project restored exactly), all passing:
  1. **Draw:** 600 × 164 off the collar, `[` × 12, 400 × 164, a turn. Result: 674 → 600 at the collar, two easy-way elbows meeting on the 600 drop, 600 → 400, and the inspector shows "drop ▼ 600".
  2. **Supports:** 7 hangers. The first is past the connector, there is one within 610 mm of each elbow, and every M8 rod reaches the 2900 soffit.
  3. **NBR 25 from the inspector:** tag, dashed outline, 17.87 m² sheet, adhesive, tape and an insert at each hanger.
  4. **Editing:** dragging the cross leg 500 mm (one undo restores it), dragging the drop 600 mm along, and a −400 rise from the inspector.
  5. **Checks:** `DU_*` in the design checks. A gas pipe through the lower leg is `DU_CLASH` in the list with its marker.
  6. **3D:** iso and side show the drop, the NBR skin, the rods to the soffit and the pipe through the duct.

## Phase 4 status

Built on 27 September 2026 (uncommitted).

**Terminals (`ductTerminalCatalog.ts`, `ductTerminals.ts`)**
- Typical catalog sizes, flagged practice until a supplier's data replaces them (SMACNA gives none):
  - square 4-way, 595 lay-in or 600 surface on a 530 box, box height neck + 100;
  - round;
  - linear slot (1–4 slots);
  - 595 egg-crate return.
- Each has a round side spigot, 60 mm long, half way up the box. The spec is stored on the existing `diffuser` / `return-grille` elements; old ones read as the typical spec of their type.
- An **Air terminals** category in the AC Equipment panel. The face sits in the ceiling plane the ceiling units use (median cassette, else the lowest ducted unit, else 2400). R turns it.
- **2D:** in plan the 3D top view sees only the plenum box, so the duct overlay draws the ceiling-plan symbol over it: the face with its pattern (4-way throw, rings, slots or egg-crate), the spigot dashed above the ceiling, and a tag such as "SD 595 · Ø200" or "RG 595 · Ø250".
- **3D:** face, plenum box, spigot and bead.
- **Inspector:** kind, neck, spigot side and mount.

**Plenums (`ductPlenum.ts`)**
- A run can end in a plenum box `{ widthMm, heightMm, lengthMm }` that fills the end of its last level leg, flat bottom level with the duct, flanged to it.
- Default size (practice): duct W + 200, max(H, spigot + 100), 500 long.
- Round spigot branches start on its side or end face (`{ kind: 'spigot', face, alongMm, acrossMm, style, vcd }`) with a spin-in or conical collar and a damper, half way up the box. `DU_SPIGOT_CLASH` / `DU_PLENUM_SIZE` check the layout.

**Flex runouts (`ductFlex.ts`)**
- A run ending on a terminal (`{ kind: 'terminal', terminalId, portId, flex }`) with `flex` has its last leg as the runout. It is a 3D Bezier from the rigid end to the spigot lip, square to both, with a 100 mm straight lead at each end (Fig. 3-9; practice length).
- A branch that is all runout keeps its collar and damper as a rigid stub.
- NM-IL by default (your decision) with a 25 mm jacket.
- Straps: 25 mm, at ≤ 1.5 m along the curve, the two connections counting (S3.35 / S3.36), each on a wire to the soffit. The sag is drawn within 41.7 mm/m.
- Terminals are carried by the ceiling grid (Fig. 2-15, S3.40). A setting adds two hanger wires per terminal.
- BOM: flex in metres by form and Ø; core and jacket draw bands (S3.33 / S3.34), or screws for a metallic form (S3.32); sealant per connection; straps, wire and anchors; the served terminals by kind and size.
- With `flex: false` the run slips straight onto the spigot, checked by `DU_TERMINAL_SIZE` / `DU_TERMINAL_ALIGN`.

**Tool, follow, delete, clash**
- **Tool:** with a run being drawn, the free spigots of its service highlight next to the collars. Hovering one previews the finish ("Flex Ø200 · 0.70 m to …", flagged over the maximum); a click finishes the run there. The Terminal connection option (flexible runout / rigid duct) sits in the tool panel. Hovering a plenum face offers a spigot.
- **Follow:** moving a terminal pulls the runout's end to the new spigot, in the move's own undo step. Spigot branches re-anchor when their plenum changes.
- **Delete:** deleting a terminal takes its runout with it; the rigid duct ends open (orphaned, `DU_OPEN_END`). Deleting a plenum run orphans its spigot branches.
- **Clash:** terminal boxes join `ductVolumes`: `DU_CLASH` against other runs (never the run that serves them), and obstacles for new pipe routes.
- **Also fixed:** R during AC equipment placement was undone at once. The preview effect re-seeded the default rotation every time the placement callback changed, which it does on every R. The default is now applied once per picked item. This was pre-existing on main.

**Verified**
- **Vitest:** `ductTerminals.test.ts`, `ductPlenum.test.ts`, `ductFlex.test.ts` (curve leads, length and bend; strap spacing and sag; the planner's runout pieces and joints; `DU_FLEX_LENGTH` / `_SIZE` / `_BEND` / `_DROP`; rigid alignment; straps, bands, terminal wires and BOM rows; follow and delete; terminal clash; the 2D tag and the 3D mesh).
- **Unit tests:** the full drawing-engine suite, 177 files and 1,583 tests, plus the type-check. ESLint could not be run: `@typescript-eslint/eslint-plugin` is not installed in this workspace.
- **On canvas** (`D:\claude-tmp-vrf-check\duct-p4.mjs`: real AC Equipment panel, duct tool, keys and mouse on the real FDUM22; project restored exactly). All 22 checks pass on 27 September 2026:
  1. **Terminals:** three square diffusers Ø200 from the Air terminals category, each turned with R so its spigot faces the plenum. Their faces sit at the FDUM22's 2400 plane, and the plan shows "SD 595 · Ø200".
  2. **Supply:** collar → 900 mm → plenum 800 × 350 × 500. Spigots on the left, right and end faces (spin-in + damper) lead to flex runouts of 0.70–0.71 m, with no issues. The plenum lists 3 spigot openings.
  3. **Return:** collar → plenum → Ø250 side spigot → 0.70 m flex → egg-crate grille "RG 595 · Ø250".
  4. **Tool:** the spigots show with the collars, and hovering one previews "Flex Ø200 · 0.70 m to …".
  5. **Moves:**
     - one Shift+→ nudge (500 mm) pulls the runout's end to the new spigot, and one undo puts both back;
     - moving it 900 mm makes a 1.70 m runout, which raises `DU_FLEX_LENGTH` in the design checks.
  6. **Delete:** deleting the diffuser leaves the collar stub open (`DU_OPEN_END` warning, no errors); undo restores it.
  7. **BOM:** diffusers and grille; both plenum boxes with their openings; flex 2.12 m Ø200 and 0.70 m Ø250; core and jacket draw bands; sealant; straps and rods.
  8. **3D (iso):** the plenum on the unit, corrugated runouts sagging to the diffuser boxes, and the return grille.
  9. **Design checks:** the only duct errors are `DU_CLASH` against the test room's two existing refrigerant pipes, which cross the plenum area. That is correct coordination feedback.
  10. **Regressions:** `duct-p3.mjs` (14 of 14) and `duct-complete.mjs` (11 of 11) pass, and both restore the project exactly.

## Duct auto layout

Select a ducted unit together with the diffusers and grilles it serves (Shift-click or a box). The **Auto duct** card appears at the top of the AC Equipment section:

1. **Generate** lays the ducts out as a preview on the canvas (dashed, with size tags) and in 3D.
2. The card shows a design summary: layout, sections, each terminal's airflow, branch Ø and neck velocity, what each damper throttles, the external static pressure against the unit's maximum, and any issues.
3. **Apply** adds the ducts as one undo step. **Discard** drops the preview. A preview of a drawing that has since changed is refused.

With no terminals selected, the card uses the unconnected terminals in the unit's room.

**Data**
- **FDUM22KXE6F (manufacturer data):**
  - airflow P-Hi 13 / Hi 10 / Me 9 / Lo 8 m³/min, maximum external static pressure 100 Pa;
  - read from the MHIAE and Form MHI product pages;
  - stored on the catalog entry (`airflowM3min`, `maxEspPa`) and read by model code for units placed earlier.
- **Airflow used:** the card's Airflow field, else the unit's own Airflow field, else its data at the chosen fan speed (Hi by default).
- **Terminal share:** each terminal takes its Design airflow if set, else an equal share of what the fixed ones leave.

**Sizing (`ductSizing.ts`, the equal-friction method)**
- **Friction:** Darcy–Weisbach with the Altshul–Tsal factor. Rectangular sections use the Huebscher equivalent diameter. Galvanised ε 0.09 mm, flex ε 3 mm, air 1.2 kg/m³.
- **Choice:** the smallest standard size meeting both the friction-rate target (0.8 Pa/m supply, 0.6 return) and the velocity cap:
  - trunk 5, branch 4, runout 3 m/s;
  - necks 3 m/s (diffuser) and 3.5 m/s (grille).
  - These are project settings in Duct Systems, labelled practice.
- **Trunk height:** at least the largest round branch + 50 mm, so each spin-in fits the side wall. It is raised past 4:1 within the ceiling void.
- **Branches:** at least the neck. A larger branch reduces to the neck before the flex. The flex always matches the spigot.

**Layout (`ductAutoLayout.ts`)**
- **Frame:** the layout is worked in the collar's own frame, so it follows the unit whatever its rotation.
- **Candidates:** each is built as real runs, planned and clash-checked; the cheapest wins. Cost = sheet + fittings + flex + fan pressure + heavy penalties for errors.
  - **Plenum + runouts:** up to four terminals, two per face, within about 4 m. The box has room for its spigots. Each terminal takes the face whose runout sits best, and a spigot whose collar + damper would run into a pipe or unit is ruled out.
  - **Straight trunk** along the collar's normal.
  - **Trunk with one turn** along a row of terminals, a branch's reach in front of their spigots.
  - **Y split** along the row: the main carries both outlets and is pulled back so the outlet trunks run on the row.
- **Take-offs:**
  - placed opposite a point a runout's length in front of each spigot, clear of the fan-outlet straight (about 2.5 equivalent diameters), elbows, the split and each other;
  - opposing take-offs are spread evenly about their stations;
  - spin-in + damper.
- **Reducers:** half way between take-offs, only when the width falls by the reducer step (100 mm).
- **Branches:**
  - **All flex** when the stub ends in front of the spigot and the runout fits (bend ≥ 1 D, length ≤ the maximum).
  - **Otherwise rigid round**, routed round the obstacles and the branches already laid, ending a runout's length square in front of the spigot.
  - **Obstacles:** other equipment, terminal boxes, existing ducts, and pipes in the duct's height band.
- **Levels:** one level per service, the collar's bottom. The flex takes up the drop to the ceiling.

**Pressure (`ductPressure.ts`)**
- Each terminal path sums, piece by piece: friction at the airflow the piece carries, fitting loss coefficients × velocity pressure (practice values), and the terminal drop (15 Pa diffuser, 10 Pa grille; placeholders).
- **Index path:** the largest; supply + return index paths are the required external static pressure. `DU_AUTO_ESP` warns when the unit cannot give it. The gap to the index path is what each damper throttles.

**Codes**
- `DU_AUTO_NO_DATA`: the unit has no airflow; enter it.
- `DU_AUTO_OCCUPIED`: the collar already has a duct; tick Rebuild existing.
- `DU_AUTO_CONNECTED`: a terminal is already served by another duct.
- `DU_AUTO_AIRFLOW`: the terminal shares don't add up to the unit's airflow.
- `DU_AUTO_VOID`: too little room under the soffit.
- `DU_AUTO_NO_LAYOUT`: nothing could be built.
- `DU_AUTO_ESP`: the ducts need more static pressure than the fan gives.
- `DU_TERMINAL_VELOCITY`: a neck is too fast; the next neck size is proposed.
- `DU_AUTO_RUNOUT` (info): a runout kept at the neck size.

**Verified**
- **Vitest:**
  - `ductSizing.test.ts`: equivalent diameter, friction against the ASHRAE chart, size choice, unit data, shares, necks.
  - `ductAutoLayout.test.ts`: plenum group, Y split along a row, straight trunk with a reducer, return, rotated unit, occupied collar, no data, neck velocity, pressure index and damper throttle, the ESP warning.
  - `store/ductAutoApply.test.ts`: selection, preview, apply as one undo, stale preview, rebuild.
- **On canvas:** `D:\claude-tmp-vrf-check\duct-auto.mjs` (real panel, Shift-click selection, mouse; project restored exactly), 28 September 2026:
  1. **Compact group:** FDUM22 + 3 diffusers + 1 grille, all selected.
     - The card reads "3 diffusers · 1 grille" and offers the fan speeds from the manufacturer data.
     - Generate previews, without changing the drawing: a supply plenum 900 × 300 with three spin-in + damper + flex runouts, and a return plenum 900 × 400 to the grille. The pressure is 35 Pa of 100 Pa.
     - Apply adds the 6 runs, each planning clean, with runouts of 0.51–0.66 m. One undo removes them.
  2. **Close row:** 6 diffusers in a row 2.3 m in front of the unit.
     - The layout is a split trunk (500 × 250 → 250 × 250 each side) with the fan outlet straight shortened and noted, and six take-offs with dampers and runouts. The pressure is 16 Pa.
     - Apply and one undo work.
  3. **Real conflicts, reported:** the test room's two refrigerant pipes and its ceiling cassette sit at duct level in front of the unit. The generator reports them as `DU_CLASH`: a damper stub against the pipes, and the trunk across the cassette. There is no room above them under the 2900 soffit.

## Duct optimiser (Auto duct v2)

Your decisions (28 September 2026):
- **Trunk shape:** Rectangular / Round / Optimal; branches stay round either way.
- **Objective:** life-cycle cost. The card shows the cost–pressure frontier with three picks.
- **Currency:** USD; every rate is a setting flagged *practice*.
- **Round-main fittings:** all four are allowed (conical, 90°, 45° lateral, wye).

**Standard fittings (planner, drawing by hand and the optimiser alike)**
- **Square-to-round** (`ductSquareToRound.ts`, Fig. 2-7):
  - wherever rectangular meets round, e.g. after the collar's connector when the trunk is round;
  - built as 4 flat triangles + 4 oblique cone quarters, and that development gives both the sheet area and the 3D loft;
  - flat bottom shared; judged on the Fig. 2-7 included angles.
- **Take-offs off a round main** (`ductRoundFittings.ts`, Figs 3-4 / 3-5):
  - `round-conical`, `round-tee` (90°) and `round-lateral` (45° plus a 45° gored elbow, so the branch still leaves square);
  - S3.4 ⅔ limit (`DU_TAP_TOO_BIG`); windows kept clear of joints, fittings and each other;
  - the draw tool picks the style from the parent's shape (Duct Systems → Round-main fittings).
- **Wye** splits a round main, legs 3A/2. **Round reducers** after a tee are L2 = A − B, 102 mm minimum.
- **Losses** (`ductPressure.ts`, practice, Idelchik form — not transcribed from ASHRAE DFDB):
  - tee branch ζ = A′[1 + r² − 2r cos α] on the main's velocity pressure, with A′ by fitting (90° tee > conical > lateral);
  - straight passage 0.4(1 − vs/vc)²;
  - elbows by R/W; transitions by included angle.

**Economics (`ductEconomics.ts`, Duct Systems → Economics)**
- **First cost** is priced from the planner's own pieces: sheet mass (SMACNA gauge × 7850 kg/m³) × rate, fabrication per m² (rectangular / spiral, fittings × a factor), installation, NBR, flex per m, dampers, hangers and straps per support, joints per metre of perimeter.
- **Energy:** present worth PW = Σₖ₌₁..ₙ ((1+e)/(1+r))ᵏ, and the price of a pascal E_pa = Q·h·price·PW / (1000·η).
- **Scale:** with the placeholder rates (0.15 $/kWh, 3000 h, η 0.45, 15 years, 6 % / 2 %), a pascal is worth about 2 USD over the FDUM22's life. The card shows the figure.

**Algorithm (`optimizer/`, pure, run in a Web Worker with a main-thread fallback)**
1. **Routing graph** (`routingGraph.ts`):
   - an escape (Hanan) grid in the collar frame, through the outlet, each terminal's feasible branch ends and the obstacle edges;
   - clearance accumulates in 100 mm levels, so a corridor knows which sections fit;
   - states are (node, heading), so elbows are priced.
2. **Tree** (`steinerArborescence.ts`): an exact Dreyfus–Wagner DP for a flow-weighted Steiner arborescence.
   - Layer S carries exactly the flow of its terminals, so the flow-dependent cost and the corridor fit are exact.
   - Merges are tees, splits or all-flex stubs.
   - Rules:
     - the tail rule (900 mm straight into a branch end, then anything);
     - a root turn rule for the fan-outlet straight;
     - a conflict-repair loop.
   - It routes at the life-cycle price of pressure while the feasibility loop learns; ½ and 2 × E_pa add variety at the end (see "Auto duct for 4, 5, 6 … terminals").
   - It is exact up to `autoExactTerminals` terminals per service (default 8, at most 10: time grows as 3ᵏ). Above that (up to 16) the grouped router runs, exact within groups, and the certificate says "Grouped search".
3. **Sizes, shapes and fittings** (`sizingDp.ts`, `sizingModel.ts`): an exact Pareto-frontier tree DP, the exact counterpart of the T-method.
   - Each subtree keeps first cost per pressure bucket (0.2 Pa): a serial part shifts the frontier, parallel parts add pointwise, and choices take the pointwise minimum.
   - Parent–child rules are checked at each join:
     - ⅔ on round mains;
     - rectangular wall height ≥ branch Ø + 50;
     - Y width ≥ the sum of its outlets;
     - a shape change pays its transition.
   - Velocity window 1.8–5 m/s. Optimal sizes each tree with the mixed catalogue and with each shape's own, and keeps the best.
4. **Verification** (`realiseDesign.ts`, `ductOptimizer.ts`):
   - every design is built as real runs, with tap windows legalised;
   - it is planned (`planDuctRunSpec`), clash-checked and pressure-summed, then re-priced from its pieces;
   - the v1 layouts are seeds too, and the v1 equal-friction design is always kept as the reference, so the choice is never worse than it.
5. **Whole designs:** supply × return combinations, re-checked for clashes between them.
   - The picks are least first cost, **best life-cycle** (shown first) and least pressure, among the designs with the fewest errors within the fan's maximum.
6. **Certificate** (card): exact or heuristic, trees sized, designs realised, router and sizing time, and the gap between the verified and the model life-cycle cost.

**Auto duct card:** Shape (Rect / Round / Optimal), Generate (in the worker, cancellable), the certificate, the frontier (click a point to preview it), the three picks, the cost breakdown, then Apply as one undo.

**Ducts in the unified Auto route** (`duct/ductAutoRoute.ts`, `unifiedAutoRoute.ts`)
- **Ticks:** **Supply** and **Return** duct ticks sit beside Gas / Liquid / Condensate, remembered for the session.
- **Order:** ducts → refrigerant → condensate. Ducts are the largest bodies and the least free to move.
  - Each ducted unit gets its best life-cycle design; its runs join the working scene the next unit sees.
  - The pipe steps route with the new ducts as obstacles (the network clearance check sees duct bodies).
- **Scope:**
  - *All units*: each unit's free terminals. A terminal goes to the nearest unit in its room with a free collar of its service; a collar with a duct is free only with Rebuild existing ducts ticked.
  - *Selected*: the selected ducted units and the selected diffusers and grilles.
- **Only clean designs are proposed:** a unit whose best design still has errors is kept as it is, with the reason, and **Study** selects it for the Auto duct card.
- **Walls** are obstacles to the optimiser (since 30 September 2026); a proposed run that still crosses one is flagged on its unit (sleeve it, or move the unit or terminal).
- **Checks:** the clash audit lists new duct contacts with every service.
- **Apply:** one Apply commits ducts + refrigerant + condensate (+ approved hops) as one undo. A preview of a drawing (or of duct settings) that has since changed is refused.
- **Options:** a Ducts section (trunk shape, fan speed, rebuild). The result panel shows each unit's layouts, trunk sections, ESP against its maximum, first and life-cycle cost.

**AC Equipment toolbox** (`AcEquipmentPanel.tsx`, `hvac/equipmentIcons.tsx`)
- **Tiles:** a custom line-art icon set (cassette, wall unit, suspended, ducted, outdoor, branch kit, gully / stack / wall outlet, square / round / linear diffuser, return grille, controller, remote, filter).
- **Layout:** one grid of tiles per category (two per row in the default panel width, more when it is wider).
- **On each tile:** a short name and caption (model code, Ø, gas / liquid), a placed-count badge per library entry, and an active ring plus a "Placing …" banner.
- **Hover or keyboard focus:** a card with the full name, model, size, placement and mounting, placed count, description and keys.
- **Keys:** arrow keys move between tiles, Enter places, Esc stops.

**Verified**
- **Vitest:**
  - `ductRoundFittings.test.ts` (15), `optimizer/optimizer.test.ts` (9): the DP equals brute force, Dreyfus–Wagner equals brute force (k = 1, 2), a higher energy price never raises the chosen pressure;
  - `ductAutoLayout.test.ts`: invariants, never worse than equal friction, Optimal ≤ min(Rect, Round);
  - `ductAutoRoute.test.ts` (8): assignment, second unit around the first, occupied / rebuild, Selected scope, wall flag, signature, unified order, duct ↔ pipe clash;
  - `store/autoRouteDucts.test.ts`, `store/ductAutoApply.test.ts`: one undo, stale preview refused.
  - Full drawing-engine suite green (190 files, 1676 tests, 29 September 2026); `tsc --noEmit` clean.
- **Results (unit tests):**
  - 6-diffuser row: USD 737 optimised against 836 for equal friction, no errors;
  - far-4 USD 626; line USD 502;
  - two diffusers USD 289 round / 326 rectangular.
- **On canvas** (`D:\claude-tmp-vrf-check\duct-route-ui.mjs`, real panel, keys and mouse; project restored exactly), 28 September 2026:
  - **Toolbox:**
    - 15 tiles with icons in 5 categories;
    - the hover card sits beside the panel and closes on leave;
    - ArrowRight / ArrowDown move focus and open the card;
    - the active tile is pressed with the banner, and Esc stops;
    - the badge counts placed diffusers.
  - **Auto route, ducts only**, FDUM22 + 2 diffusers + 1 grille:
    - optimised trees Ø300 supply / Ø250 return, 45 / 100 Pa, USD 622 first / 705 life-cycle, exact;
    - preview in plan and 3D;
    - Apply adds the 3 runs, all planning without errors, and one undo removes them;
    - the return crossing the room's wall is flagged.
  - **All five ticks:** ducts designed first, then the refrigerant circuit rebuilt around them (2 / 2 units), no clashes; Discard leaves the drawing as it was.
  - **Real refusals** (kept, with the reason):
    - a plenum against the room's refrigerant pair;
    - tight runout bends (SMACNA S3.24) in a cramped layout.
- **Auto duct card on canvas** (`duct-optimise.mjs`, 29 September 2026), same unit and terminals:
  - **Rect:** a rectangular 250×250 trunk to Ø200, 45 Pa. **Round:** the supply falls back to the plenum and is shown with its issues; the fan pressure is finite (42 Pa). **Optimal:** 704 USD / 44.9 Pa, the same design as Rect.
  - **Certificate:** "Optimal on the model · 6 verified · 38 trees sized · 0.5 s".
  - **Frontier and picks:**
    - the frontier plots the 6 verified designs;
    - the three picks are least first cost, best life-cycle (both 704 USD, 44.9 Pa) and least pressure (722 USD, 43.1 Pa);
    - each pick and a frontier point switch the preview.
  - **Apply:** the 3 runs plan without errors, the BOM has 65 rows (square-to-round, gored elbows, spin-in + VCD, flex), and one undo removes them.
- **Round main by hand** (`duct-round-taps.mjs`), with the real duct tool:
  - a 600×400 main off the collar;
  - a Ø300 round main off it (spin-in, then a gored elbow);
  - a Ø150 conical tap, a 90° tap and a 45° lateral off the round main.
  - The taps plan without errors, the round main stays clean, and the BOM lists "Conical tap into round main, mouth Ø201 (Fig. 3-5)", "90° tap … (Fig. 3-4)" and "45° lateral tap … (Fig. 3-4)".
  - Taps placed closer than their windows allow (the Fig. 3-4 / 3-5 body + the 50 mm joint margin) are flagged on the main (`DU_TAP_CLASH`).
- **Fixed on the way:** a plan turn sharper than 150° (a run doubling back) used to give an elbow setback of R·tan 90° ≈ 10¹⁸ mm and a fan pressure of 10¹⁵ Pa. It is now refused as `DU_TURN_BACK` with finite numbers.
- **Regressions:** `duct-auto.mjs` 18/18, `duct-p4.mjs` 21/21, `duct-p3.mjs` 14/14, `duct-complete.mjs` 11/11; each restores the project exactly.

## Auto duct for 4, 5, 6 … terminals (29 September 2026)

**The problem:** with 2–3 diffusers Auto duct worked; with 4 or more it often proposed nothing. Reproduced offline on 38 layouts (rows, lines on the unit's axis, 2×2 … 4×3 grids, spigots as dropped or turned to the unit, with return grilles): 9 were clean. Every miss traced to the tree router's grid model disagreeing with the exact checks (sizing, realiser, planner), and a failed tree was simply dropped.

**Your decision:** for symmetric faces (square 4-way, round, egg-crate) the optimiser chooses the plenum-box spigot side; linear slots keep theirs. The turn shows in the preview and applies in the same undo.

**What changed (`duct/optimizer/`, `ductAutoContext.ts`, `ductAutoLayout.ts`)**
1. **One source for lengths** (`sizingModel.ts`): the router, the sizing and the realiser use the same formulas — elbow setback and reach (a rectangular 90° may be square vaned, W/2), take-off windows, the straight a run keeps before its terminal, a wye's diagonal room, a split's outlet lead, an all-flex stub's runout check, the turn-first reach.
2. **Runouts are checked where they run:** `flexClear` samples the planner's own flex curve against the room's equipment (not its own terminal), in its height band; an all-flex runout must also stay on its side of the main it leaves (`runoutStaysOut`).
3. **Splits:** the realiser ends a run that splits short by its outlets' lead, so the outlets run on the lines the router priced.
4. **Leaves:** a run's last leg needs its last elbow and the end the sizing can build — stepped down to the neck before that elbow (the elbow alone) or the reducer and its lead after it; the router takes the lesser.
5. **Spigot side** (`TerminalCtx.variants`, `spigotVariants`): each symmetric terminal offers its two most promising sides; the router picks per leaf and per stub, the realiser builds against the terminals as turned, verification plans them turned, and the result carries `terminalUpdates`. Card Apply and the unified Auto route commit the turned terminals with the runs (one command). The card lists "Spigot turned: SD-3 back → left"; Auto route shows it on the unit. Setting: Duct Systems → Optimiser → Turn diffuser spigots (on by default, practice).
6. **Turn first** (a terminal in front of the collar): the root may turn at the collar's own section with a square vaned elbow and make the collar transition on the next leg; the router adds a root just short of the obstacle and a trunk line the turn reaches; the sizing offers sections as wide as the collar there (short transitions).
7. **Feasibility loop** (lazy constraint generation, `routerCuts.ts`): every sizing or realiser failure is typed (run, reason, take-off) and every planner error is traced to its run; each forbids the one routing decision that caused it (a take-off, a stub, a split, a runout start, a root), and the router solves again, until its best remaining tree verifies clean. The certificate reports the rounds and cuts.
8. **Conflict repair** also sees what the grid does not: a runout curving through another run of the same tree, or two parallel legs closer than their halves; it rules out every runout start or stub of that terminal that would cross the same duct.
9. **More than 8 terminals:** the grouped router (rows of up to four across the collar axis; subsets inside a group and unions of whole groups only) — exact within the groups, labelled "Grouped search".
10. **Speed** (exact results unchanged; the brute-force tests still hold): the router's Dijkstra on a typed-array heap with no allocation per state, predecessor levels computed directly, the merge loop allocation-free, stub runouts cached per graph, sheet gauges cached per settings, layers reused across repair and loop rounds where no cut touches them, roots that cannot hold the collar fittings rejected before solving. Learning runs at the life-cycle price of pressure; the prices either side add variety at the end while time allows. A tree's other frontier picks are built only when its life-cycle pick verifies.
11. **Honest messages** (`failureMessages.ts`): when no design is clean, the card and Auto route say why from what failed most often, naming the terminal ("SD-4: no room for its take-off where the duct passes … space the terminals further apart, or move the unit").

12. **A run may end on a stub:** its last terminal off its side on an all-flex stub, the run going on 250 mm to an end cap (a trunk with take-offs and a cap); a main going on to its last terminal no longer has to run 900 mm straight first.
13. **Take-off branches** run straight off the main for the main's half, the collar and damper and 150 mm before their first fitting (the realiser's rule).
14. **Walls are obstacles:** the card and the unified Auto route pass the drawing's walls (centre line ± half the thickness, full height); the router keeps clear of them, and verification counts a run through a wall as an error (`DU_AUTO_WALL`, the layout seeds included), so no design through a wall is proposed. Before, a design could loop outside the room through its walls and was only flagged.
15. **Spigot sides with room:** a side is offered only when 400 mm in front of it is clear of equipment (other terminals included), at most two per terminal.
16. **Repair bounds:** a router call stops repairing after 6 s (or at the time budget); only routers whose failed trees could still beat the best clean one route again in the loop; the variety round runs only when the design came in under a quarter of the budget.

**Settings:** `autoTimeBudgetMs` 20 s (practice; past it the best verified design is kept and the certificate says "time-limited"), `autoChooseSpigotSide` on.

**Verified (29–30 September 2026)**
- **Benchmark** (`optimizer/autoDuctBenchmark.test.ts`, run on request: `DUCT_BENCHMARK=1 npx vitest run src/components/canvas/hvac/duct/optimizer/autoDuctBenchmark.test.ts`, about 4½ minutes; its outcome depends on the time budget, so it is kept out of the default suite): **37 / 37** layouts within the exact search clean, every terminal served — rows of 2–8, lines of 2–8 on the unit's axis, 2×2, 3×2 and 2×3 grids, 2×2 + 1 and 3×2 + 2 returns, spigots dropped or turned (before: 9 of 39). Optimal ≤ min(Rect, Round). Slowest 11.6 s (a line of 8, in the test runner); 3×2 / 2×3 grids 6–9 s; 2×2 3–4.5 s.
- **Unit tests:** `optimizer/autoDuctRobustness.test.ts` (spigot sides and room in front, `flexClear`, grouping, turn-first, a dropped 2×2 grid, gauge cache), `optimizer/optimizer.test.ts` (Dreyfus–Wagner still equals brute force; layer reuse equals a fresh solve), `store/ductAutoApply.test.ts` and `store/autoRouteDucts.test.ts` (turned spigots applied with the runs, one undo). Full drawing-engine suite green; `tsc --noEmit` clean.
- **On canvas** (`D:\claude-tmp-vrf-check\duct-many.mjs`, the test project's room, real toolbar and mouse, project restored exactly):
  - 2×2 diffusers dropped as they come, before walls were modelled: designed (exact, 24 Pa, USD 737), four spigots turned in the preview and listed on the unit, Apply adds the runs and turns the spigots together, the runs plan without errors, BOM 57 rows, one undo restores it all; the card path the same. That design ran outside the room (flagged "crosses a wall 4 times"), which is why walls are now obstacles.
  - With walls (30 September 2026): no duct crosses a wall. Two diffusers dropped as they come are designed inside the room (split trunk 250×250, 21 Pa, USD 439): Apply, the runs plan without errors, BOM 47 rows, one undo; the card the same. In this room (the collar 1.4 m from the left wall, the far wall 3.2 m ahead, a cassette and its refrigerant pair on the right) a 2×2 grid is left as it is with 1 issue and the reason given ("no room for its take-off where the duct passes …"), the spigot turns listed.

## Constant-friction sizing: flow rate and velocity, before and after Generate (1 October 2026)

**The request:** set the flow rates and the air velocity on a constant-friction basis, before or after Generate; once the duct path exists, its sizes follow in real time.

**Your decisions (30 September 2026):** main velocity ⇄ friction rate linked (the classic equal-friction method); applied ducts resize live on the drawing, one undo per change; rectangular sections keep their height and change width; the Auto duct card has a Sizing switch (Life-cycle optimum / Constant friction), remembered for the project.

**The basis** (`DuctSystemSizing`, kept on the run off the collar as `DuctRunSpec.sizing`): `drive` (velocity or friction), `mainVelocityMs`, `frictionPaPerM`, the velocity limits `maxVelocity { trunk, branch, runout }` (noise), `fanSpeed`, and a typed `airflowM3h` (null = the unit's at the fan speed). At the system airflow Q₀ the main velocity V gives D = √(4Q₀/πV) and R = friction of Ø D at Q₀ (Altshul–Tsal); setting R inverts it by bisection on D. The one set last drives. A system without a stored basis was sized by the optimiser. New bases take the project's friction rates and velocity limits (practice). Project setting `autoSizingMethod` (life-cycle by default, practice).

**The engine** (`duct/ductSystemSizing.ts`, pure, `sizeDuctSystem(scene, rootRunId, { basis, terminalAirflows?, verify?, measure? }, settings)`):
1. **The system:** the run off the collar and every run hung off it (taps, split outlets, plenum spigots).
2. **Airflow:** each terminal's design airflow (or the card's), else an equal share of the system airflow (`shareAirflow`); a run carries the terminals downstream of it and steps down after each take-off. Trunk limit where two or more terminals are downstream, branch limit for one, runout limit for the flex (the neck).
3. **Sections at the friction rate:** round, the smallest stock size within R and the limit, never under the terminal's neck; rectangular, the narrowest width at the section's own height (`sizeRectangular`, 50 mm steps, at least square, aspect ≤ `aspectRatioAdvisory`; past it the height rises, up to the ceiling void).
4. **Fittings bind:** a spin-in needs a main Ø + 50 mm high (a conical collar that no longer fits becomes a spin-in, and the card says so); a round main takes a branch up to ⅔ of it; a Y's main is as wide as its two outlets side by side; nothing grows downstream (a flat bottom: the height never rises downstream); a rectangle before the round neck is at most 50 mm lower than the neck. The section raised says why ("take-off fit", "split fit", "section downstream").
5. **Reducers:** placed again after each take-off where the flow drops, in the widest straight gap before the next take-off window, clear of elbows and risers (the realiser's rule); a width step under `autoReducerStepMm` is carried on, as is a change with no straight for its transition ("carried on"). The step down to the neck goes `max(400, L + 100)` before the runout, else at the latest free straight.
6. **Branches follow** (`reanchorKeepingEnd`, `ductFollow.ts`): a branch's start moves to its main's wall as resized and its first straight slides onto the new line, so only the legs either side change length; its terminal end stays (the runout re-curves only if the straight moved sideways). A collar-and-damper stub lengthens rather than moving its runout; it moves whole only where it would get shorter than its collar and damper. Take-offs are re-expressed on the new legs (`legIndex`, `stationMm`), elbow overrides re-numbered.
7. **Kept as they are:** locked runs (their branches are still sized; a take-off that no longer fits a locked main is reported), plenum boxes, collar-and-damper stubs before a runout (the neck), and the collar's own section where the root turned at the collar first.
8. **Report:** each section (run, stretch, airflow, size, velocity, friction, what set it), each terminal (airflow, neck velocity, damper throttling), the index-path pressure against the unit's maximum ESP, and the planner's and clash checks' issues. `measure` reports the sections as drawn without changing anything. Sizing twice at one basis changes nothing.

**Where it is used**
- **Generate** (`ductAutoLayout.ts`): with Constant friction every verified route is sized again at the basis and verified again exactly as the optimiser's own (plans, clashes, walls, pressure, price); the frontier and the three picks come from those. Labels read "… · constant friction"; the root run stores the basis. Terminal airflows typed in the card are used in the design and written to the terminals on Apply (same command as the runs and any turned spigots).
- **The preview, live** (`resizeAutoDuctPreview`, debounced 150 ms): the shown design is re-sized at once from the drawing the preview was made on (runs, plans, pressure, price, issues), the others one at a time after it, and the picks are found again. The drawing is untouched; Apply commits the sizes shown. Switching to Constant friction with a preview open re-sizes it; switching back asks for Generate.
- **Applied ducts, on the drawing** (`resizeDuctSystemOnDrawing`): the card shows "Ducts on this unit — sizing" for a unit whose collars have ducts (prefilled from the stored basis, else the project defaults): fan speed or airflow, main velocity ⇄ friction, the limits and each terminal's airflow. Each committed change (Enter, blur, a − / + step, a select) is one command, e.g. "Duct sizing (supply): friction 0.80 → 1.20 Pa/m", holding the resized runs, the branches that follow and the terminals whose airflow changed. Undo restores the earlier sizes. The table shows the sections as drawn, those over the rate or a limit marked.
- **Run inspector:** a System line ("FDUM22 supply · constant friction 1.20 Pa/m · 3.0 m/s", or "life-cycle optimum") and a *Size this system* button that selects the unit.
- **Unified Auto route:** a Sizing select next to Trunk shape (the project setting); with Constant friction each unit's design is sized at the project's friction rates and limits, and its result reads "· constant friction 0.80 Pa/m".

**Verified (1 October 2026)**
- `duct/ductSystemSizing.test.ts`: the link round-trips within 1 %; airflow 1500 → 1125 → 750 → 375 along a trunk with four take-offs; free sections within R and their limit at their kept height and equal to `sizeRectangular`; the main at or under the velocity set; a higher rate never gives a larger section; reducers placed, every branch on its main's wall, every runout end on its terminal, no planner error; idempotent; locked runs kept; measure changes nothing; a terminal's airflow from the card; a main drawn too low raised for its take-offs (conical → spin-in reported); a Y main as wide as its outlets.
- `store/ductSystemSizing.test.ts`: the preview re-sized without touching the drawing and Apply commits those sizes (one undo); applied ducts re-sized as one command, a terminal airflow in the same command, undo back through each; sizing again at the same basis commits nothing; Generate by constant friction keeps the basis and writes the terminal airflows with the runs.

## Known limits (auto duct, 30 September 2026)

- **Grids of 9 and 12 terminals** (the grouped router) still end with errors: runouts and runs of different groups keep clashing, and repair does not converge. The card and Auto route say why.
- **Tight rooms with walls:** where the room leaves only a few hundred millimetres round the terminals, the router's trees clash with themselves once built (larger sections, elbow and collar bodies) and the loop does not always find a clean one; the design is kept and the reason given.
- **Terminal labels:** a terminal placed from the toolbox carries the library name, so "Spigot turned" lines for several diffusers read alike.
- **Constant friction keeps the route:** take-offs stay where they are, so a branch made larger can bring its window onto a neighbour's or an elbow (the planner reports `DU_TAP_CLASH`), and a main made narrower moves its stubs' collars in so a runout can bend tighter (`DU_FLEX_BEND`, seen on a 2×2 grid at 1.5 Pa/m). These are shown with the run; Generate again routes for the new sizes.
- **The reducer step** (`autoReducerStepMm`, 100 mm) carries a section on where the width would drop less than that, so a trunk can stay wider than the friction rate needs; the table says "carried on".

## Known limits

- Round trunks take conical, 90° and 45° lateral taps and wye splits (Figs 3-4 / 3-5). In Round mode a layout often cannot be built near the unit: the square-to-round off the flat collar needs about 0.85 m of straight. The service is then reported `DU_AUTO_NO_LAYOUT`; Optimal falls back to rectangular.
- The optimum is exact on the modelled grid and catalogue (not between grid lines), and only up to `autoExactTerminals` terminals per service. Above that the grouped router is a heuristic (exact within its groups).
- Costs, energy data and fitting loss coefficients are practice placeholders until supplier prices or DFDB data replace them.
- In compact scenes the fallback plenum's runouts can bend under one diameter; such a design is refused by the unified Auto route and shown with its issues in the card.
- Drawing a take-off by hand does not stop a window that clashes with an elbow or another take-off: the parent run reports `DU_TAP_CLASH` afterwards and the tap has to be moved.
- Pressure classes above 500 Pa are refused (your decision, 25 September 2026). The scanned PDF has Tables 1-6 to 1-9 if that changes.
- PID reinforcement counts are unverified until the P3 graph is transcribed.
- No hard-way (twisted) elbows: a plan turn at a riser is refused.
- The design-check chip is still titled "VRF checks" though it lists condensate and duct checks too.
- The NBR skin in 3D does not box the flanges, so a 30 mm TDC flange shows through a 25 mm skin.
- Duct-to-duct clash skips a branch and its own parent.
- Auto duct designs one level per service and adds no risers. It keeps clear of walls (as obstacles; there are no beams or storeys in the model); the unified Auto route still flags a run that crosses one. Units are designed one after another (each around the ones before), not jointly.
- Auto duct's pressure figures are estimates with practice loss coefficients, not a certified duct calculation.
- Terminal sizes are typical catalog values (practice) until a supplier's data is entered.
- A rigid connection to a terminal is checked, not routed: its last leg has to be drawn straight into the spigot.
- Plenum spigots are round, on the side and end faces; there are no bottom spigots or rectangular necks yet.
- During equipment placement, R with nothing focused switches to the Room tool (the single-key tool shortcuts do not know about placement). R works while the picked card keeps focus, as it does after a click. This is pre-existing.
