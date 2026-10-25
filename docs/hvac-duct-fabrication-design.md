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

### Automatic layout and system sizing

Select one ducted unit to open **Auto duct**. The card finds unconnected terminals in its room, or within 10 m when room data is missing. Select specific terminals with the unit to override that choice. **Rebuild existing** also includes terminals already served by that unit, and replaces its selected services in one undo step when applied.

Review the airflow source, supply/return selection, layout and shape before **Generate ducts**. The card explains missing airflow or occupied collars. Numeric fields preserve entered precision and show invalid values; Enter commits a valid field, and Escape restores its current value. Terminal airflow summaries show fixed allocations and the remaining shared airflow.

Generation creates a preview. **Apply ducts** is unavailable while generation or live resizing is pending, or when the card inputs no longer match the generated request. Changes to the drawing, walls or duct settings require regeneration. Cancelling generation prevents an older result from reappearing. Applying and rebuilding each remain one undo step.

Constant-friction sizing can update the preview or an applied system. Measuring an applied system preserves its drawn geometry and reports each existing section, including reducers in locked runs. Pressure estimates integrate airflow on either side of take-offs, use developed fitting lengths, and include split outlet losses. Friction uses laminar and turbulent regimes with an estimated transition between them; fitting loss coefficients remain the documented practice estimates in `ductPressure.ts`.

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
- **Applied ducts, on the drawing** (`resizeDuctSystemOnDrawing`; since 17 October 2026 in the unit panel on the left, and the card keeps a one-line summary — see "The unit panel" below): the card shows "Ducts on this unit — sizing" for a unit whose collars have ducts (prefilled from the stored basis, else the project defaults): fan speed or airflow, main velocity ⇄ friction, the limits and each terminal's airflow. Each committed change (Enter, blur, a − / + step, a select) is one command, e.g. "Duct sizing (supply): friction 0.80 → 1.20 Pa/m", holding the resized runs, the branches that follow and the terminals whose airflow changed. Undo restores the earlier sizes. The table shows the sections as drawn, those over the rate or a limit marked.
- **Run inspector:** a System line ("FDUM22 supply · constant friction 1.20 Pa/m · 3.0 m/s", or "life-cycle optimum") and a *Size this system* button that selects the unit (and, since 17 October 2026, opens its unit panel).
- **Unified Auto route:** a Sizing select next to Trunk shape (the project setting); with Constant friction each unit's design is sized at the project's friction rates and limits, and its result reads "· constant friction 0.80 Pa/m".

**Verified (1 October 2026)**
- `duct/ductSystemSizing.test.ts`: the link round-trips within 1 %; airflow 1500 → 1125 → 750 → 375 along a trunk with four take-offs; free sections within R and their limit at their kept height and equal to `sizeRectangular`; the main at or under the velocity set; a higher rate never gives a larger section; reducers placed, every branch on its main's wall, every runout end on its terminal, no planner error; idempotent; locked runs kept; measure changes nothing; a terminal's airflow from the card; a main drawn too low raised for its take-offs (conical → spin-in reported); a Y main as wide as its outlets.
- `store/ductSystemSizing.test.ts`: the preview re-sized without touching the drawing and Apply commits those sizes (one undo); applied ducts re-sized as one command, a terminal airflow in the same command, undo back through each; sizing again at the same basis commits nothing; Generate by constant friction keeps the basis and writes the terminal airflows with the runs.

## Air systems: supply and return terminals per ducted unit, ducted through walls (4–5 October 2026)

**The request:** place supply and return diffusers separately; give each its duct path and accessories, returns included; dedicate terminals to selected ducted units (one or more units in a room, a unit serving several rooms).

**Your decisions (4 October 2026):**
- A unit may serve terminals in other rooms. Its ducts pass interior walls through sleeves, with a fire damper where one is set.
- A return terminal may carry a filter: G4, or M5 (≈ MERV 8).

### Supply and return terminals

- **The service comes from the element type:** `diffuser` is supply and `return-grille` is return, with any face (square 4-way, round, linear slot, egg-crate, perforated, louvred). Old drawings read exactly as before.
- **Tags:** SAD, SAG and LSD for supply; RAD, RAG and LRG for return. Placing one takes the next free number; numbers are never reused.
- **Toolbox:** separate *Supply air terminals* and *Return air terminals* sections, each tile with a service dot. The inspector has Service (locked while a duct is connected), Face and Filter (return only).
- **Pressure:** a terminal's drop is the service's base plus a filter's drop: rated ΔP × face velocity ÷ rated velocity × the mid-life factor (practice). The sizing model and the verified pressure use this one formula; without a filter the figures are as before.
- **BOM and cost:** terminals are described by service and face, with a filter panel row per filter grille. The first set of filter panels is priced with the design (`econFilterEach`, one per filter grille its runs serve).

### Air systems: terminals dedicated to a unit

- **Stored:** `properties.airSystem = { unitId }` on a terminal, and `properties.airSystemTag` ("DU-1") on a ducted unit. A unit gets its tag when placed; older units get a derived one.
- **Derived:** a terminal's system is the unit it is assigned to, else the unit its duct tree starts from. A disagreement between the two is a check (below).
- **Auto-assign:** an exact min-cost flow per service (successive shortest paths), checked against brute force.
  - A pairing costs the collar-to-spigot distance, plus the depth behind the collar, plus each wall between them × `autoAssignWallPenaltyMm`.
  - Each unit takes its airflow share free, then `autoAssignOverloadMm` per terminal over it.
  - A room that has a unit with the right collar keeps its terminals to its own units.
- **UI:**
  - The **Air system card** (one ducted unit selected): members with their airflow and neck velocity, the balance, the rooms served, and its actions: place supply or return terminals for the unit, pick on canvas, assign the selection, auto-assign, remove.
  - A **Served by** row in the terminal inspector.
  - **Systems → Air systems:** every system, the unassigned terminals and the air terminal schedule (CSV).
  - **On the plan:** tethers from each collar in the system's colour, rings and unit badges, for the systems in focus or all of them.
- **Commands:** each command is one undo step. Deleting a unit clears its terminals' assignment; a copied unit drops its tag. The duct tool refuses to end a run on another system's terminal.

### Auto duct and Auto route per system

- **The Auto duct card** designs, in order of precedence:
  - the terminals selected with the unit;
  - otherwise the unit's system (both services, any room);
  - otherwise, while nothing is assigned yet, the unassigned terminals in its room.

  It never takes another unit's terminal. Apply dedicates the unassigned terminals it served, in the same undo step as the runs.
- **The unified Auto route** groups terminals by system. It balances the unassigned ones across the units in scope (the same solver), and designs the units in order of system airflow. It never adopts another room's free terminals: dedicate a terminal to the unit to serve it from there.

### Wall penetrations

**The building ducts see** (`ductBuilding.ts`):
- the walls: centre line, thickness, height band (`properties3D`), construction (brick, concrete or partition; structural);
- the rooms.

Plans derive the penetrations every time they are made, so a moved wall never leaves a stale sleeve. The canvas keeps the active building current (`useDuctBuilding`); the auto layout sets and restores it around its own work, so it is safe in a worker.

**A crossing** (`ductPenetrations.ts`):
- It is a level leg passing through a wall's centre line where their height bands overlap. A duct over a wall that stops below it passes over it.
- Its zone along the leg is the thickness ÷ cos(angle).
- The rooms either side make it interior or exterior.

**The planner:**
- **Plain straight:** the duct is a plain straight through the wall. Transverse joints are moved 50 mm clear of its faces (the take-off window rule). A fitting, take-off or transition in the zone, or a flexible runout through a wall, is an error.
- **Fire damper:** each crossing has one under the project policy (`fireDamperPolicy`: none, masonry and concrete walls, or every wall) or the run's own choice (`ductRun.penetrations["wall:n"]`). It is an inline `fire-damper` piece:
  - centred in the wall, the wall's depth + 2 × `fireDamperSleeveExtensionMm` long;
  - breakaway joints at its sleeve ends;
  - bought in (no fabricated sheet), its mass carried for the supports;
  - ζ 0.12 (curtain type B);
  - the insulation stops at its sleeve.
- **Sleeve:** the opening is the duct's outer size (the insulation runs through a plain sleeve) + 2 × `penetrationClearanceMm`.
- **Supports:** no hanger sits in a wall.
- **BOM,** under *Wall penetrations*:
  - sleeves by opening and wall thickness;
  - mineral wool and acoustic sealant (plain) or fire-stop (fire damper), by the opening's perimeter;
  - fire dampers by size, and their access doors.
- **Penetration schedule** for the builder (WP-01 …, CSV, Systems → Ducts): run and mark, wall, construction and thickness, duct and opening sizes, centre, duct bottom, angle, fire damper, exterior.
- **Economics:** `econPenetrationEach` and `econFireDamperEach` (at Ø200, scaled by the girth) and `econAccessDoorEach`.
- **Plan:** the opening is drawn dashed across the wall ("PN-01 · SLV 725×265"), and a fire damper as its box with a diagonal ("FD FD-01").
- **3D:** sleeve collars at both faces; a fire damper as its sleeve, casing band and access door.
- **Run inspector:** each penetration is listed with a fire damper switch (one undo each). A choice that matches the policy is not kept.

**The router** passes through walls only for a system whose unit and terminals are in different rooms; a one-room system never does (its graph is unchanged, and a test shows crossings only add edges).
- **Edges:** an edge through one interior wall (a room either side at that point), square to it and blocked by nothing else, crosses it. Its corridor is capped by the wall's length, so the duct goes through the wall, not past its end.
- **Price:** the crossing's sleeve, and a fire damper and access door where the policy puts one.
- **Fittings off the wall:** the wall counts as a fitting. The duct may enter it only with a fitting's reach (+ 50 mm) clear of the near face, and leaves it as if a fitting had just ended at the far face. The four pricing sites and the walk that rebuilds the tree use this one rule.
- **The realiser and the constant-friction resizer** keep take-off windows, reducers and the neck fitting out of a wall's zone, a fire damper's sleeve included.
- **The verifier** plans every run with the walls:
  - a crossing through an interior wall of a spanning system is the planner's to judge;
  - any other crossing is `DU_AUTO_WALL`, one per leg, as before.
- **Auto route** reports, e.g., "The supply duct passes through a wall: a sleeve, no fire dampers (see the penetration schedule)".

### Design checks added

| Code | Level | Rule |
|---|---|---|
| `DU_SYSTEM_MISMATCH` | error | Assigned to one unit, its duct comes from another |
| `DU_SERVICE_MISMATCH` | error | A return terminal on a supply duct, or the reverse |
| `DU_SYSTEM_NO_COLLAR` | error | Assigned to a unit with no collar for its service |
| `DU_SYSTEM_AIRFLOW` | warning | A service's fixed airflows more than 10 % off the unit's (TAB tolerance, practice) |
| `DU_SHORT_CIRCUIT` | warning | A return face within `returnSupplyMinGapMm` of a supply face in the same room |
| `DU_ROOM_RETURN_PATH` | warning | A room the unit supplies has none of its returns, though it has ducted returns elsewhere (door undercuts and transfer grilles are not modelled) |
| `DU_TERMINAL_UNASSIGNED` | info | The terminal is in no system |
| `DU_PENETRATION_FLEX` | error | Flexible duct through a wall (UL 181 / NFPA 90A practice) |
| `DU_PENETRATION_FITTING` | error | A fitting, take-off or a fire damper's sleeve that does not fit, in a wall |
| `DU_PENETRATION_JOINT` | warning | A joint that could not be moved out of a wall |
| `DU_PENETRATION_ANGLE` | warning | More than 10° off square to the wall |
| `DU_PENETRATION_EXTERIOR` | warning | Through an exterior wall |

### Settings added

| Setting | Default | Basis |
|---|---|---|
| `filterG4RatedDropPa` / `filterM5RatedDropPa` at `filterRatedVelocityMs`; `filterDesignFactor` | 40 / 60 Pa at 2.5 m/s; × 1.5 | practice |
| `returnSupplyMinGapMm` | 1500 | practice |
| `autoAssignWallPenaltyMm` / `autoAssignOverloadMm` | 4000 / 2500 | practice |
| `showAirSystems` | off | display |
| `penetrationClearanceMm` | 25 | practice |
| `fireDamperPolicy` | none | project (the walls carry no fire rating) |
| `fireDamperSleeveExtensionMm` | 100 (50–152) | practice (UL 555 installations: ≤ 6 in) |
| `econPenetrationEach` / `econFireDamperEach` / `econAccessDoorEach` | 40 / 160 / 45 | placeholders |
| `econFilterEach` | 18 | placeholder |

### Verified

**Verified (5 October 2026):**
- **Unit tests:**
  - terminals and their readers, old drawings included (`ductTerminals`, `ductReturnTerminals`);
  - air systems, the assignment solver against brute force, and the checks (`ductAirSystems`, `airSystemAssignment`, `ductAirSystemChecks`, `store/airSystems`);
  - per-system Auto duct and Auto route (`ductAutoRoute`, `store/ductAutoApply`).
- **`ductPenetrations.test.ts`** (17 tests):
  - crossings by height band, angle and occurrence, with the rooms either side;
  - the fire-damper policy and a run's own choice;
  - a sleeve through the wall with every joint clear of it, or reported (property test);
  - the fire-damper piece, centred and contiguous;
  - every code;
  - BOM, cost, schedule, supports, plan and 3D.
- **`ductCrossRoom.test.ts`** (6 tests):
  - a unit serving a room beyond a partition designs clean through one sleeve;
  - a corridor unit serving two bedrooms designs clean with two sleeves, both through interior walls;
  - the same layout as a one-room system never crosses (`DU_AUTO_WALL`, and the reason names the terminal);
  - the policy puts a fire damper in the partition;
  - crossings only add edges to the routing graph;
  - the unified Auto route serves a dedicated terminal in the other room and reports the sleeve.
- **Filter pricing** (`ductReturnTerminals.test.ts`): one filter panel per filter grille served, none for a plain grille, priced at `econFilterEach`.
- **Full suite and checks:** the full drawing-engine suite (228 files, 1990 tests; the benchmark separately); `tsc` and `eslint` clean.
- **Benchmark** (`DUCT_BENCHMARK=1`): 43/43 in 422 s. The one-room layouts are unchanged; four cross-room layouts were added (beyond a partition with 1 + 2 supply and a return; two bedrooms off a corridor; each with spigots dropped or turned to the unit). Each is clean, serves every terminal and passes only interior walls by sleeve.
- **On canvas** (Playwright against the dev server, project restored exactly each time): Phase 1 25/25, Phase 2 23/23, Phase 3 14/14, and Phase 4 `duct-cross-room.mjs` 18/18:
  - Two rooms: the room tool, then a partition committed through the store's wall action.
  - DU-1 placed, with SAD-1, SAD-2 (beyond the partition) and RAG-1 placed from its Air system card.
  - The Auto duct card's design: clean in 6 s, through the partition by one sleeve (Ø251 for the Ø200 duct).
  - In plan: the dashed opening and "PN-01 · SLV Ø251".
  - The run inspector's switch adds FD-01 in its sleeve, with its symbol (one undo).
  - The BOM's wall-penetration rows: sleeve, fire damper, access door, 0.79 m of fire-stop.
  - The penetration schedule: WP-01, partition 100, BOD 2470.
  - The 3D view.
- **Regression drivers:**
  - On this code: `air-p1` 25/25, `air-p2` 23/23, `air-p3` 14/14.
  - The older duct drivers were re-staged for the project as it now is. They clear the test room's cassette and its refrigerant pipes first (one Delete, undone at the end).
    - duct-p4: 21/21.
    - duct-auto: 16/17, the same as on the code before Phase 1 (A/B). Its one failure is an outdated expectation: it wants every branch to start with a take-off, and the optimiser now feeds one terminal from a split outlet.
    - duct-sizing 21/26 and duct-many 4/8: the same failures on the code before Phase 1 (A/B). This 6.5 × 4.7 m room still leaves those layouts with a wall crossing or tight runouts (the known tight-room limit), unrelated to this work.
  - **Found and fixed through duct-auto:** Phase 2's checks now, correctly, warn on a return grille within 1.5 m of a diffuser (`DU_SHORT_CIRCUIT`), and that warning's marker sits on the grille's centre. A Shift-click on a marker replaced the selection instead of adding to it. A marker click now honours Shift, Ctrl and ⌘ like a click on the canvas (`selectionAfterMarkerClick`).

### Known limits

- The tree router works in front of a collar. A terminal behind a unit's collar plane may be out of reach: turn the unit, or draw that run by hand.
- One level per service: a duct does not rise over a wall. A diagonal wall stays a hard obstacle to the router; a hand-drawn duct can cross it (with the angle warning).
- Walls carry no fire rating: fire dampers come from the project policy and each crossing's switch. Smoke dampers, combination dampers and ratings are not modelled.
- **Room detection and the canvas wall tools:** a wall drawn on the canvas to divide a room splits the walls it meets at a T, and room detection then loses the rooms either side. A system there is then seen as being in no room, so it is treated as one-room and its ducts may not cross the dividing wall. The store's own wall commit (no split) keeps both rooms. Found on 5 October 2026; it is in the walls rebuild, outside this work.
- Door undercuts and transfer grilles are not modelled; the return-path check says so.
- An edge crosses one wall at a time. Two walls closer together than the grid's lines block, as a single wall does without a spanning system.
- Terminal, filter and fire-damper pressure drops are practice values until the supplier's data is entered. The router prices a crossing at the reference size; the verified plan prices the real one.

## Segment cards: the options of each piece of a duct run, in 2D and 3D (6–7 October 2026)

*Refrigerant lines and condensate drains got the same cards on a shared shell (12–13 October 2026): see
`hvac-pipe-segment-cards.md`.*

**The request:** point at a segment of a generated duct path and see its alternatives: a rectangular duct's equivalent spiral duct; for a Y or a bend, rectangular alternatives and parameters such as the inner radius; an easily edited size, the segments around it (round-to-square and so on) following. Every view. The approved plan is in `C:\Users\idang\.claude\plans\duct-segment-options.md` (phases 0–6).

### Round-main collars fit the main (Phase 0, 73f2627)

- A take-off off a round main (45° lateral, 90° tee, conical tee) carries the main's cylinder (`DuctTakeoffInfo.roundMain`: diameter, sheet, axis at the tap station).
- 3D: every generator of the collar runs back to where it meets that cylinder, so the collar ends on the exact saddle; the insulation skin likewise. A conical tap on a round main is concentric. The spin-in bead sits past the saddle.
- Plan: a lateral's sides run to the main's side line, and its joint lies along it.
- A branch resolves a round parent's sheet by the round tables (`runSectionSheetMm`), as the parent's own plan does.

### What a designer sees (Phases 1–2)

- **Hover** a segment of a selected run: it is outlined in violet and, after a quarter of a second, a peek card shows what it is (`E-02 · 90° radius elbow · 600×300 · R/W 1.5 · throat 600 mm`), the air it carries (airflow, velocity against its limit, pressure, ζ, friction rate, terminals served, on the index path or not) and its best few alternatives that break no rule.
- **Click** the segment: the card pins beside it (it never covers the piece; it flips to stay on screen and follows pan and zoom every frame, imperatively). It holds:
  - **Size** (straights and risers): W × H or Ø, ▭ / ◯ (switching shape fills in the equal-friction size), ± 50 mm (Shift ± 10 on the arrow keys), *This leg* or *All legs of this size*, with what the size would do before Apply (Enter).
  - **Same air, another way / Alternatives:** each row says what it would do — velocity, change in the index path's pressure, mass, height — and any rule it would newly break; badges *Recommended* (lowest life-cycle cost of the options that break nothing and keep the velocity in its limit, when it beats the segment as it is), *Lowest ΔP*, *Lowest cost*, *Saves height*.
  - **Inner radius** (radius and gored elbows): a slider of R/W (R/D) showing the throat radius in mm; release applies.
  - **Taper** (transitions), **Accessories** (volume damper, flexible connector, fire damper at a wall, end open/capped).
  - **How it is built:** sheet and gauge, joint, seam, insulation, pressure class, pieces, length, area, mass; the segment's own issues.
- **Hover an option:** the drawing shows the change dashed (the runs it changes, re-planned; the committed ones hidden meanwhile) and the card says what else changes ("The take-off to SAD-1 becomes a spin-in collar · it slides 90 mm on along the main, clear of its fittings · 1 transition added").
- **Click it:** one command, one undo; the card stays on the segment (or the leg it became).
- **Keyboard:** `[` / `]` previous / next segment, ↑ ↓ through the options, Enter applies, Esc hides a peek or closes the card. Hover content follows WCAG 2.2 SC 1.4.13 (dismissible, hoverable, persistent).
- **Inspector:** the pinned segment's leg or elbow row is marked; a row's caption pins its segment.

### Segments (`ductSegments.ts`)

- A segment is a design decision, keyed stably across edits that keep the run's topology: `leg:<i>` (a leg's straights), `node:<i>` (an elbow or an offset), `transition:<i>`, `start:connector | takeoff | damper`, `end:split | plenum | cap | flex`, `pen:<wall>:<n>` (a fire damper).
- 2D picking is geometric (the nearest piece outline under the pointer), so a 102 mm collar next to a damper is found at any zoom.

### Figures (`ductSegmentFigures.ts`)

- The system's flow model is the sizing's own: each terminal's design airflow, else an equal share of the system airflow (`systemTerminalAirflows`, now shared with `sizeDuctSystem`).
- `buildDuctFlowTree` and the per-piece loss were taken out of `systemPressure`, which now uses them: the same additions in the same order, so the duty is unchanged (the duct suite and the benchmark are identical), and a single run's piece losses plus its terminal's drop equal `systemPressure`'s index path to 1e-9 (tested).
- Built once per drawing revision and system (WeakMap on the scene array), shared by every segment.

### Options and their edits (`ductSegmentOptions.ts`, `ductSegmentEdits.ts`, `ductSectionEquivalents.ts`)

- **Equivalents:** the Huebscher equivalent diameter (ASHRAE Fundamentals ch. 21): round sizes from the stock either side of a rectangle's De; rectangles of at least a round's (or a rectangle's) De, one per height in 50 mm steps, lying flat, within the aspect limit and the void (soffit − bottom − 2 × insulation − 50).
- **Size for its air:** the constant-friction size at the system's friction rate and the part's velocity limit (a rectangle lies flat). Where it is also an equivalent, one row says both.
- **Elbows:** radius R/W 1.5 (SMACNA RE1 default), 1.0, 0.75 (tight throat, ≤ 5 m/s); square with turning vanes (auto, or double-wall); the turn in spiral duct (the legs either side round); gored R/D 1.5 (Table 3-1) and 1.0; the turn in rectangles.
- **Take-offs:** rectangular main: shoe, straight, spin-in, conical (a round collar takes a round branch, a square one a rectangular branch, each its equal-friction size); round main: conical tee, 90° tee, lateral; *Rectangular main* (edits the parent leg).
- **Cascade (one command):**
  - A main that changes shape changes its take-offs' fittings, keeping the angle their branch leaves at: rectangular → round: shoe → conical tee, straight / spin-in → 90° tee, conical → conical tee; round → rectangular: tee → spin-in, conical tee → conical (spin-in where the main is under Ø + flare + 20). A rectangular branch off a main turned round takes a round first leg (equal friction, at most ⅔ of the main, S3.4), or round all along when asked.
  - Every branch re-anchors on its parent's new wall **keeping its end** (`reanchorBranchesKeepingEnds`): its first straight slides onto the new line, so the rest and its terminal stay. Inspector edits (`commitDuctRunSpec`) now do the same; moves still move branches rigidly.
  - **Make room:** a take-off whose window a new fitting (a longer transition, a bigger elbow) would overlap slides along its leg just clear of it and of the others — the planner's own rule. With no room left the clash stays and the card shows it.
- **Evaluation:** an option's edit is applied to a copy of the drawing and the system re-read: the segment's velocity and loss, the index path, first cost and life-cycle cost (`priceDuctPlans`, `energyPricePerPa`), mass, the outside height it needs, and new or cleared errors and warnings on the runs it changes (by kind, so an issue whose numbers change is not new). Cached per drawing; the card evaluates a few options per 12 ms slice.
- **Per-transition taper:** `nodeOverrides[i].taperDeg` (5–45°) sets the taper of the transition starting at node i.

### Verified (Phases 1–2)

- Tests: `ductSegments` (6), `ductSegmentFigures` (4), `popoverPlacement` (4, one property), `ductSectionEquivalents` (6, one property), `ductSegmentEdits` (8), `ductSegmentOptions` (9). The duct suite, the full suite and `DUCT_BENCHMARK` (43/43) pass.
- Canvas (`D:\claude-tmp-vrf-check`): `duct-seg-p1` 16/16 and `duct-seg-p2` 22/22 on a generated system (FDUM22 with three diffusers and a return grille, Auto route), the mouse and keyboard only, project restored exactly. In that tightly packed layout the main's first leg has no room for a rectangle's longer transition: those rows say "1 new error", and applying one gives exactly the errors its row predicted.

### Swaps that turn a branch, runouts and terminals (Phase 3)

- **Re-aim (`ductBranchReaim.ts`).** A fitting that leaves its parent at another angle — a 45° lateral ↔ a 90° tee, a lateral whose main turns rectangular (it becomes a spin-in), a Y or bullhead ↔ a wye — would swing the whole branch off its terminal if moved rigidly. Instead the branch's start moves onto the new fitting, leaves at its angle, and rejoins its old route as soon as it can; the rest of the branch and its terminal stay. Candidates, fewest new elbows first (a new elbow costs 300 mm of sliding):
  1. straight on: the take-off slides along its main until the new first leg runs into a later leg (a lateral and its 45° elbow becoming a tee: the elbow goes);
  2. one turn onto a later leg's line at a new elbow; 3. the same, sliding the take-off just far enough;
  4. a stub at the new angle onto the flexible runout, which re-curves;
  5. two turns: a stub, then parallel to an old leg, meeting the next at a new elbow (a wye's 45° outlets replacing a Y's square ones);
  6. onto a flexible runout, back on its old heading: the take-off slides so a new elbow turns the stub onto the line it ran on (a lateral and its 45° elbow).
  Elbow setbacks are angle-aware (R·tan(θ/2) + neck, R = 1.5 W). Each candidate is planned with its parent; the first that breaks no rule the branch or its parent did not already break is taken. None: the option is offered disabled with the reason (a downstream lateral cannot reach a diffuser upstream of it; a slide onto the main's elbow would clash).
- **Splits:** a Y's run made round becomes a wye, its outlets round (equal friction, within the main) and turned 45°; a wye's run made rectangular becomes a Y (a bullhead where the Y's outlets do not fit side by side, or as chosen), its outlets rectangular within the run's height. Each outlet branch is re-aimed keeping its end.
- **Runouts:** *Rigid runout in Ø… spiral* on a flexible runout's card: spiral duct at the spigot's diameter, arriving as the planner asks of a rigid end — level, square to the spigot, on its axis, at its height. Routes tried, fewest fittings first: straight on (a reducer where the run was larger), one turn onto the axis, a jog onto it (jogging early, leaving a straight on the axis a flexible runout can later take over); each with the shortest straights that plan without a new error. A spigot above or below the run is reached by a drop on its axis: two elbows, or one offset where the drop is short (a diffuser's spigot sits 15 mm above a branch centred on the main: an ogee, SMACNA Fig. 2-7). A spigot facing away is refused with the reason. *Flexible runout to the terminal* on a rigid run's straights: the rigid route is kept to the top of its drop and the flexible duct leaves 800 mm before the spigot where a level leg heads at it (the auto layout's target; SMACNA S3.23 keeps flex short), with the planner's check and fallbacks so it never bends under one diameter where another start would not.
- **Terminal (from its runout's card):** the necks either side of the current one (the spigot, and the runout's legs at the old neck back from the spigot, take the new size; a flexible runout re-curves, a rigid one is re-made onto the new spigot) and the other faces of its service. The box resizes on its centre, the tag follows its type (SAD-1 → LSD-1), one undo.
- **Taper:** a transition offers 10°, the project's, 20° and 30° per side (SMACNA Fig. 2-7; the planner checks the limits), the current marked.

### Verified (Phase 3)

- Tests: `ductBranchReaim` (5), `ductSegmentEdits` (13: runout straight on with its offset and back at 800 mm; a turn; a jog and a spigot facing away; a new neck on flexible and rigid runouts; a new face and tag), `ductSegmentOptions` (10). Full suite 235 files / 2044 tests; `DUCT_BENCHMARK` 43/43.
- Canvas: `duct-seg-p3` 29/29 on the generated system, the mouse and keyboard only, project restored exactly: every lateral first offered disabled with its reason (the diffusers sit upstream of their take-offs); one diffuser nudged 500 mm downstream (Shift + arrows), its runout following, and the lateral offered and applied, the branch turning with it, its end kept; its main made rectangular from the take-off card (its row predicted one new take-off clash, and applying it gave exactly that), two undos back to the generated system; the main's runout to SAD-3 made rigid (straight, offset, no errors) and flexible again; SAD-3's neck Ø150 (runout follows) and a linear-slot face (tag LSD-1), each one undo; a transition at 10°.
- Found while verifying, not part of this work: equipment (a diffuser, the FDUM22) does not move under a mouse drag in this state — the press selects it, nothing moves; the 28 September driver logged the same after the Duct tool had been used. Keyboard nudges work.

### The same cards in 3D (Phase 4)

- **Selecting and pointing in 3D.** Duct runs are picked by a ray against their meshes (`hybridDuctSegments.raycastDuctRun`, after refrigerant and drain pipes, before walls): a click on a run selects it; on a selected run, resting on a segment peeks its card and a click pins it — the plan's segment keys and the one UI store (`view: '3d'`), so a segment has one card whichever view points at it, and the card survives a switch of views.
- **Which piece:** the meshes are merged per material, so the ray's hit (in the model frame: `root.worldToLocal`) is matched to the nearest piece by its plan outline and its height range (`segmentAtModelPoint`, `pieceZRange`: a level end spans its section, a vertical end — a riser's, either end of a vertical elbow — only its end point), within the insulation plus 60 mm. A riser and the elbows over it in plan are told apart by height.
- **Outlines** (the post-process outline effect): a selected run by its own meshes; the pinned segment instead of its run, and the hovered one, by a proxy of their pieces' outer surface (`ductPiecesOuterGeometry`: the insulation's face where insulated, positions only). Refreshed on selection, hover, focus and every rebuild of the HVAC scene.
- **Anchored card:** the segment's box (its anchor piece's) projected through the live camera (`segmentClientRect3D`), read every frame by the card's own positioning loop, so an orbit or a zoom carries the card and it flips to stay beside the segment, never over it.
- **Live 3D preview:** the option under the pointer goes through the 3D preview path the Auto route uses: the runs it changes are drawn as they would be, planned against the drawing with all its changes, and their committed meshes are hidden meanwhile.

### Verified (Phase 4)

- Tests: `ductSegments` (7: picks in 3D with a riser between its elbows, 3D bounds), `ductMeshes` (17: a segment's outer surface inside its 3D box, standing the sheet and insulation off it), `hybridDuctSegments` (3: a ray through the mirrored model basis finds the run, its surface point and segment; proxies; the projected box, and none off the drawing). Full suite 236 files / 2049 tests; `DUCT_BENCHMARK` 43/43.
- Canvas: `duct-seg-p4` 15/15 in the Iso view on the generated system, mouse only, project restored exactly: a click selects the main; resting on its leg focuses `leg:0` (3D) and peeks the card; a click pins it beside the leg; hovering *Ø315 spiral* changes the 3D drawing there (the leg larger, a transition) and the card lists the take-off sliding 70 mm; leaving the option restores the drawing pixel for pixel; clicking applies it (one undo) with the card kept on its segment; an orbit carries the card to the leg's other side; Esc closes it. The 2D drivers `duct-seg-p1`–`p3` re-run against the same build.
- Possible follow-up: hover picks test every duct mesh the ray's bounds admit (per triangle); for very large drawings, a BVH (`three-mesh-bvh`, already a dependency) would make them constant-time.

### Accessories set into straights (Phase 5)

- **Data.** `DuctRunSpec.inline`: `{ id, kind: 'damper' | 'access-door' | 'attenuator', legIndex, stationMm, lengthMm? }` — the accessory's centre along its leg from the leg's start; ids unique on the run (`i1`, `i2`, …), read tolerantly (unknown kinds, duplicate ids and negative stations are left out).
- **Pieces.** Each is a piece of its own on its leg's straight, laid as a fire damper is (straights before and after, no joint inside it), `piece.inlineId` set:
  - volume damper: a `damper` piece of the project's VCD length with its blade layout (SMACNA Fig. 2-12 / 2-13);
  - access door: an `access-door` piece, a straight section framed for the door (SMACNA Fig. 7-2; size practice): 450 mm square where the duct's wider face takes it with 50 mm a side, else 300, else 200, else what fits; in a flat duct's bottom (reached from the ceiling below), a tall or round duct's side; the section 100 mm longer than the door;
  - sound attenuator: an `attenuator` piece of a catalogue length (600, 900, 1200, 1500 mm), its casing 50 mm proud; rectangular splitter or round podded by the duct's shape; bought in (no sheet of the run's), its mass a 1 mm casing × 2.5 for the infill and splitters.
  One that would sit on a fitting, a take-off, a wall crossing or another accessory, or on a leg the run no longer has, is `DU_INLINE_CLASH` (error) and is not laid. Edits that change a run's legs carry its accessories with the legs they keep (a re-aimed branch, a runout made rigid or flexible).
- **Loss.** Damper: the take-off damper's ζ (open). Access door: friction only. Attenuator: ζ 1.5 rectangular splitter, 0.5 round podded, on the duct velocity — practice estimates until the supplier's data — through the same per-piece loss the system pressure sums.
- **Drawing.** Plan: the damper's blade and quadrant; the door on the duct's side, or dashed through it in its bottom, `AD 450×450`; the attenuator's casing with its splitters (or pod), `SA SA-01`. 3D: the damper as at a take-off; the door a panel on the skin; the attenuator's casing framed shut at its ends.
- **BOM and price.** The door's section among the fabricated pieces ("framed opening for an access door") and the door itself under Accessories (SMACNA Fig. 7-2); the attenuator under Accessories (catalogue length; its loss flagged as a practice estimate). Price: `econAccessDoorEach`; `econAttenuatorEach` (new, placeholder: a 900 mm attenuator at Ø200, scaled by the girth and the length), in a new `accessories` line of the cost; an inline damper as a take-off damper.
- **Cards.** A straight's (or riser's) card offers *Add a volume damper / an access door / a sound attenuator here*: the edit puts it at the clear spot nearest the middle of the leg's straights — tried there, then along the leg's straight stretches (adjoining sections as one) every 50 mm, nearest first, each checked by the planner — and says where it went ("placed 61 mm back, clear of the fittings and take-offs"); an attenuator that finds no room at its length takes the longest shorter one that fits. An accessory's own card (`inline:<id>`) takes it out; an attenuator's offers its catalogue lengths, each re-placed at the clear spot nearest where it is (one that fits nowhere is shown disabled, with the reason).

### Verified (Phase 5)

- Tests: `ductInline` (9: reading, laying and the length invariant, no joint inside, clashes, segments, the attenuator's loss rectangular and round, plan symbols and 3D, BOM rows and price, the card's options and its clear-spot placement, an attenuator's lengths and removal), `ductSegmentEdits` (+1: a damper set into a branch stays through a runout made rigid and flexible again). Full suite 237 files / 2059 tests; `DUCT_BENCHMARK` 43/43.
- Canvas: `duct-seg-p5` 14/14 on the generated system, mouse only, project restored exactly: the main's first leg offers the three accessories; hovering the attenuator previews it (placed 61 mm back, clear of the take-off) and clicking adds it, drawn `SA SA-01`, with no error; its own card offers 600–1500 mm (900 current) and removal; 1200 mm applied (re-placed, the card kept on it; 1500 then disabled: no room); the first leg then has no room for an access door (its row says so), the third leg takes one, drawn `AD`; in the Iso view the attenuator's casing shows and a click on it pins its card from 3D.

### Final verification (Phase 6, 7 October 2026)

- The full suite (237 files / 2059 tests), the type-check and `DUCT_BENCHMARK` (43/43) pass; lint is clean but for an import-order error in `ductPlenum.test.ts` and `pipeSimplify.test.ts` that predates this work.
- Every driver re-run against the final build, mouse and keyboard only, each restoring the project exactly: `duct-y-fit` (Phase 0), `duct-seg-p1` 16/16, `-p2` 22/22, `-p3` 29/29, `-p4` 15/15, `-p5` 14/14, and `duct-seg-views` 8/8 — in the plan and in the Iso, Front and Side views a click selects the duct under the pointer (the nearest along the ray: in the Front view the return main stands in front of the supply main and its elbow is the one picked), a second click pins that segment's card, beside it.

### Card v2: a selection you can see, a simpler card, values of your own (7 October 2026)

**The request**, after using the card: the segment a click selects should be more visible and specific; the card has too much text and should be simple but comprehensive; and it should take values of the designer's own. Approved plan: `C:\Users\idang\.claude\plans\duct-segment-card-v2.md` ("do this the modern way"). The rest of the drawing is not dimmed.

**The selection**
- **Plan:**
  - The pinned segment is filled violet (26 %), with a soft glow and a 2.6 px outline.
  - It is bracketed square across the duct at both of its ends: violet over a white underlay, so they read on any background.
  - The ends are the headings of its first and last level pieces (`segmentEnds`). Each bracket reaches 9 px past the duct's outer face as the plan draws it: the sheet, the insulation, an attenuator's casing.
  - A segment only hovered keeps a dashed outline and a light fill.
- **Pin, leader and chip:**
  - A pin sits inside the segment's outline (`polygonHotspot`), with a leader line to the card.
  - A chip names the segment's marks and size (`S-001 · Ø300`). It is kept on the far side of the pin from the card, never under it.
- **3D:**
  - The segment gets a violet wash over its skin (polygon offset, no depth write) and a thick violet outline. The outline is the outline effect's own focus layer, sampled at 1–3 texels.
  - A violet ring stands round the duct at each of its ends, 25 mm clear of its outer face: the plan's brackets in 3D (`ductSegmentEndRings`). It is a circle round a round duct, a rounded rectangle round a rectangular one, and is outlined with the segment. A riser has none, since its ends stack in plan; the wash marks it.
  - Pin, leader and chip come from the anchor piece's projected centre (`pieceHotspot3D`).
  - While an option is previewed, the wash and rings step aside, because the drawing then shows the option.

**The card**
- **Header:**
  - The segment's glyph in its service colour, its name, marks and size.
  - An issue chip.
  - ⓘ for how it is built: construction, its issues and the keys.
  - ‹ › ✕.
- **Figures:** one strip with the airflow, the velocity (a dot against its limit) and the pressure. A flag shows when the segment is on the fan's index path.
- **Tabs:** **Edit · Swap · Add**, with counts. The card opens on the tab last used for that kind of segment.
- **Option rows:** each is one line.
  - A glyph tile and its name.
  - Its change as chips: ΔP, mass, and a red count of the errors it would add.
  - Its badges as icons: recommended, lowest ΔP, lowest cost, saves height.
  - Six rows show, then "N more…".
- **Hovering a row:** the drawing previews it, and the card's foot gives the rest: what it is, velocity, ΔP, mass, height, "Also changes: …". A disabled row gives its reason there and as its tooltip.
- **The peek:** the header, the figures and the two best swaps that break no rule.

**Values of the designer's own (the Edit tab)**

Each field is judged as it is typed. Once the value differs, its result (velocity, ΔP, mass, new errors) and **Apply** show under it. Enter applies it, and each change is one undo.

- **Size** (straights, risers):
  - Ø or W × H: ± 50 mm, Shift ± 10.
  - ▭ / ◯.
  - This leg, or all legs of this size.
- **Elbow:** the R/W (R/D) slider, the ratio typed, or the throat radius in mm.
- **Transition:** 10°, the project's, 20° or 30°, or an angle of the designer's own (5–45° a side; `nodeOverrides[i].taperDeg`).
- **Take-off:** its position along the main (`tap-station`). The branch slides with it and keeps its end.
- **Flexible runout:**
  - **Its length** (`runout-length`). The rigid leg before the runout runs on or stops short. Where it stops is bisected, each try planned.
  - **Limits:** a first leg never goes shorter than its take-off's collar and damper plus 20 mm, a later leg than 300 mm (an elbow's room). It runs on to no closer than 150 mm short of the spigot. The card says when the length stops at a limit.
  - **The terminal's neck** (quick picks) and **its design airflow** in m³/h (`terminal` with `airflowM3h`). **Share** returns it to an equal share of the system's airflow.
- **Accessory:**
  - Its position along its leg (`inline-move`): the clear spot nearest the value. It is refused when it cannot go further that way.
  - An attenuator's length: the catalogue lengths, or 300–3000 mm.
  - An access door's size (`inline-door`): 100–600 mm in 10 mm steps, stored as `DuctInlineAccessory.doorMm`. Its section stays 100 mm longer than the door.

**Found and fixed while verifying**
- **The card re-placed itself** whenever its foot changed its height, and could swap sides back and forth. Its place is now held while its anchor and the canvas are unchanged and it still fits.
- **In 3D, leaving a previewed option left the pinned segment without its wash.** The outlines were rebuilt before the preview pass showed the committed run again. They are now rebuilt whenever that pass hides or shows a run.

**Verified**
- **Unit tests:**
  - `ductSegmentCustom` (4):
    - a take-off moved 400 mm, its branch's end kept;
    - runouts of 800 and 500 mm, and of 2500 mm, which stops at the collar and damper plus 20 mm;
    - an attenuator moved, a 300 mm access door, and the door size it already has refused;
    - a terminal's airflow, and back to a share.
  - `ductSegments` (+2): the ends, a pin point inside an L-shaped outline, and the focus markup.
  - `hybridDuctSegments` (+1): the end rings lie in the ends' cross-sections, clear of the outer face.
  - Full suite: 238 files and 2066 tests pass (the benchmark's 43 skip without `DUCT_BENCHMARK`).
  - `DUCT_BENCHMARK`: 43/43.
  - Type-check: clean.
  - Lint: clean on every changed file. The duct and 3D folders have only `ductPlenum.test.ts`'s old import-order error.
- **On canvas.** Each driver uses the mouse and keyboard only and restores the project exactly.
  - `duct-seg-v2-highlight`, 5/5:
    - In plan, a leg and an elbow pinned: each drawn with its halo, fill and two brackets.
    - In the Iso view, a leg pinned from 3D: 30 % of its box is violet (wash, outline, rings), and none once the card closes.
  - `duct-seg-v2`, 10/10:
    - a 12° taper typed, its result shown, then applied;
    - R/D 1.25 typed;
    - an attenuator added, moved 150 mm back and made 600 mm;
    - a take-off moved 200 mm back, its branch still ending on its terminal. In that layout the runout then bends tighter than the planner allows (`DU_FLEX_BEND`), shown as a new error before Apply;
    - a 600 mm flexible runout;
    - a terminal's 450 m³/h;
    - in the Iso view, Ø250 typed into a leg's card.
  - The earlier drivers, re-run against the final build:
    - `duct-seg-p1` 16/16, `-p2` 22/22, `-p3` 29/29, `-p5` 14/14, `duct-seg-views` 8/8;
    - `-p4` 15/15: leaving a previewed option restores the 3D drawing pixel for pixel, wash included.

### One click selects a segment (7 October 2026)

**What the user saw:** no segment got selected in plan or 3D.

**Why:** the first click on a duct selected only its whole run; a segment was pinned only by a second click on the
run once it was selected.
- **Plan:** the overlay draws its segment hit areas on selected runs only, and the first click goes to the general
  select handler.
- **3D:** the duct click pinned only on a selected run.
- **Why no check caught it:** the drivers selected the run through the debug handle (plan) or clicked twice (3D).

**Now, in the select tool, in both views:**
- **A plain click on a duct** selects its run and pins the segment under the pointer, its card beside it.
  - Plan: the select handler's duct branch pins through `HvacPlanRenderer.ductSegmentAtWorldPoint`
    (`segmentPieceAtPlanPoint`, at the duct pick's own tolerance).
  - 3D: the duct click selects the run if it is not selected, then pins.
- **A click on another segment** of the selected run pins that one, as before.
- **Shift / Ctrl-click** adds the run to the selection, or takes it out, and pins nothing.
- **Esc** closes the card and leaves the run selected.
- **Hover** is unchanged.

**The card closes with its run only when the selection changes**, so a card pinned by the click that selects its run is
never closed before that selection arrives.

**Verified**
- **Unit test:** `ductSegments` (+1): the piece under a plan point on a leg and on an elbow.
- **On canvas** (mouse only, the project restored): `duct-seg-click` 8/8.
  - Plan and Iso: one click selects the run and pins the segment, with its card and highlight.
  - Esc closes the card and keeps the run.
  - Shift-click adds a second run and pins nothing.
  - A drag on the selected run opens no card.
- **`duct-seg-p4`:** updated for the one-click pin (Esc, then rest and peek as before).

**Found while verifying, not part of this work:** a selected duct does not move under a mouse drag in plan. It is the
same as the equipment drag noted above, and was confirmed on the code before this change.

### Round to rectangular with a split in the way (7 October 2026)

**What the user saw:** a round duct could not be set to rectangular.

**Why:** the layout ran from the unit, through a square-to-round, along a round main to a wye whose outlets turned
about 0.5 m on.
- A rectangular main cannot end in a wye, so the edit turns the wye into a rectangular split (bullhead tee or Y).
- That split's outlets leave square, so each outlet branch is re-aimed to keep its end.
- With so little room before they turn, no route exists, and the change was refused on both the main's card and the
  wye's.
- **Probe**, by outlet length before the turn: 500 mm, both rectangles refused; 800 mm, one of two; 1200 mm, both
  converted.

**Now:**
- **The split stays, behind a transition** (`keepSplitBehindTransition`).
  - **When:** the outlets cannot turn to the new split, or a row asks for it (`keepSplit`).
  - **How:** the last leg is cut by a straight-through vertex: the new section up to it, a neck of the old section into
    the split. The planner lays the transition at that vertex.
  - **Neck length:** the shortest, from 150 mm in 50 mm steps, that plans with no new error.
  - **What moves:** take-offs and accessories on the neck move onto it, their stations re-based and their positions
    unchanged. The split and its outlets do not change.
  - **The reverse:** a rectangular Y or bullhead run made round keeps its split behind a round-to-square.
  - **The card's foot says so:** "The wye stays as it is: the duct turns back to Ø500 through a square-to-round 400 mm
    before it".
  - **Since 8 October:** a wye's run made rectangular becomes a 45° Y junction instead (its outlets keep their angle,
    see the next section). The split is kept behind a transition when asked ("wye kept"), or when no Y can be built.
- **Rows:**
  - the wye's card: "Rectangular main W×H, wye kept";
  - a rectangular split's card: "Round main ØD, Y split kept";
  - the cone at the unit (`transition:0`): "Rectangular duct W×H" (its first leg in the equal-friction rectangle,
    lying flat in the void) and "Rectangular run" (every round leg of the run).
- **Elbows that fit** (`fitElbows`). A round run made rectangular takes wider elbows. Where an edit leaves a leg too
  short for its elbows:
  - each elbow takes the largest of R/W 1.25, 1.0 or 0.75 that fits and breaks no new rule;
  - failing that, turning vanes on a 90° turn;
  - the card's foot says which.

**Verified**
- **Unit tests:** `ductRoundToRect` (6):
  - the layout as drawn: the wye kept, a 400 mm neck, the outlets untouched, no errors;
  - at 800 mm: the wye becomes a rectangular split;
  - "wye kept" chosen where the outlets could turn;
  - a rectangular Y made round keeping its Y;
  - a take-off on the neck: the neck reaches back past it, which stays a round tee, re-based, not moved;
  - the cone's rows on a one-leg and a two-leg run;
  - an outlet elbow made rectangular taking R/W 1.25.
  - The segment suites pass (61 tests).
- **On canvas:** `duct-round-rect` 9/9, mouse only, the project restored. The layout (unit, round main, wye, outlets
  turning at 500 mm) is committed into the room in one step.
  - **Plan:**
    - one click on the cone, then "Rectangular duct 650×350": the wye is kept behind a 400 mm square-to-round, the
      card's foot said so first, no errors, one undo;
    - the wye's card offers "wye kept";
    - an outlet elbow made rectangular applies with no error.
  - **Iso:** one click on the round main, then "950×250": the wye is kept behind a 550 mm neck, the outlets are as they
    were, no errors, one undo.
- **Both changes, on the final build:**
  - The full suite: 239 files and 2072 tests pass.
  - `DUCT_BENCHMARK`: 43/43.
  - Type-check and lint: clean on the changed files.
  - Every card driver re-run, each restoring the project: `duct-seg-p1` 16/16, `-p2` 22/22, `-p3` 29/29, `-p4` 16/16,
    `-p5` 14/14, `duct-seg-views` 8/8, `-v2-highlight` 5/5, `-v2` 10/10, `duct-seg-click` 8/8.

### A rectangular Y junction at 45° (8 October 2026)

**The request:** "why there is no any option of Y junction from square duct. please solve". Approved plan:
`C:\Users\idang\.claude\plans\duct-rect-y-junction.md`.

**Why there was none:**
- A rectangular run split only by a "Y split" (each half turning a full 90° on a radius elbow, SMACNA Fig. 2-5 divided
  flow) or a bullhead tee. Both have outlets leaving at 90°.
- Only the round wye left at 45°.
- So a round wye could not become rectangular without its outlets turning to 90°. With outlets that turn soon after it
  the edit kept the wye round behind a transition: the junction the user saw.

**The Y split takes a leaving angle.**
- `end.angleDeg: 45` on a Y is a **Y junction** (a "pair of pants"). Absent, it is 90°: every existing drawing reads as
  before, and the optimiser still lays 90° Ys.
- **Geometry** (`ductBranches`): the same fitting as the Y. Each half keeps its share of the run's width, flush with its
  wall, on a radius elbow, turning 45° instead of 90°.
  - The outlets leave as a wye's do.
  - The fitting's depth runs to the farthest outlet's outer corner.
  - `SplitFittingGeometry.angleDeg` carries the angle.
- **Plan, 3D and BOM:** plan and 3D draw the two 45° elbows with the Y's own code, which takes any angle. The BOM reads
  "Y junction, 45° legs (2 radius elbows)".
- **Pressure:** `splitY45` is 0.18, the Y's 0.3 × 0.6, the standard 45° elbow-angle factor (practice estimate).
- **Validation:** the Y's rules: the outlets side by side within the run's width, no taller than it.

**Where it is offered:**
- **Duct tool, "Split style":** "Y junction 45° (pair of pants)", "Y split 90°", "Bullhead tee". A new split takes the
  angle chosen (`splitOrigin` and the draft carry it).
- **Inspector, "Ends in":** "Y junction 45°", "Y split 90°", "Bullhead tee".
  - With branches attached, the change goes through the card's split edit, so the outlets turn, keeping their ends.
  - Where they cannot turn, the reason shows under the choice.
- **Card, on a rectangular split:** "Y junction 45°", "Y split 90°", "Bullhead tee", the current one marked. The split
  edit re-aims outlets that leave at a new angle.
- **Card, on a round wye:** "Y junction 45° in W×H". The run's last leg becomes rectangular and the outlets rectangular,
  at the same 45°, so nothing is re-routed.

**Round ↔ rectangular follows the outlets' angle.**
- **A wye's run made rectangular** (from the main, the cone or the wye) becomes a 45° Y junction: the outlets keep their
  heading and their ends. "Wye kept" remains a row of its own.
- **A Y junction's run made round** becomes a wye.
- **The outlets of a Y sit side by side.** Where no flat rectangle of an outlet's friction fits within its share of the
  run's width, the outlet stands at the run's height:
  - as narrow as keeps its friction (Ø355 in a 650×350 run: 310×350);
  - else at its share of the width (the run's own velocity).
- **Levels:** a rectangular junction's outlets sit flush with the run's bottom, where a wye centred them on the round's
  axis. A branch's level follows.

**Verified**
- **Unit tests:**
  - `ductYJunction` (5):
    - the 45° geometry, and the 90° as before;
    - old drawings read as 90°;
    - the duct tool's split origin and the run's end;
    - a Y split made a Y junction from its card and back, the outlets turning, keeping their ends, with its title and
      BOM row;
    - the 45° loss.
  - `ductRoundToRect`: the layout as drawn (outlets turning at 500 and 800 mm) now becomes a Y junction, its outlets
    310×350 at the same heading, no errors.
  - The duct, 3D and store suites pass (704 tests); type-check clean.
- **On canvas** (mouse only, the project restored): `duct-y-junction` 9/9.
  - **The user's layout:** the wye's card, "Y junction 45° in 650×350", gives a rectangular junction, its outlets
    310×350 at the same heading, no errors. The card's foot said so. Plan and Iso shots; one undo.
  - **The round main made rectangular in 3D:** the wye becomes a Y junction, no errors; one undo.
  - **The duct tool:** a main drawn off the unit's return collar and split with "Y junction 45°": the run ends in a Y
    junction, two branches leaving at exactly 45°, no errors.
  - **The inspector:** shows "Y junction 45°". Switched to "Y split 90°", it refuses with the reason under the choice:
    those straight branches cannot turn.
- **On the final build:**
  - The full suite: 240 files and 2077 tests pass.
  - `DUCT_BENCHMARK`: 43/43.
  - Type-check and lint: clean on the changed files.
  - Every card driver re-run, each restoring the project: `duct-seg-p1` 16/16, `-p2` 22/22, `-p3` 29/29, `-p4` 16/16,
    `-p5` 14/14, `duct-seg-views` 8/8, `-v2-highlight` 5/5, `-v2` 10/10, `duct-seg-click` 8/8,
    `duct-round-rect` 10/10 (now applying "wye kept" from the wye's card too), `duct-y-junction` 9/9.

### Known limits

- Accessories are kept with their legs through the card's edits; an edit elsewhere that inserts or removes a vertex shifts the legs after it, and an accessory left on the wrong leg is reported (`DU_INLINE_CLASH`) or sits where its station falls.
- Attenuator and access-door sizes, prices and the attenuator's loss are practice placeholders until the supplier's data is entered.
- A runout's length is set along a level rigid leg only. Where the rigid duct reaches the runout down a riser, the card refuses with the reason; move its end by hand.
- 3D picks test the duct meshes the ray's bounds admit, triangle by triangle; a very large drawing would want a BVH (`three-mesh-bvh` is already a dependency).
- Found while verifying, not part of this work: equipment (a diffuser, the FDUM22) does not move under a mouse drag after placing through the Air system card and Auto route (the press selects it; the 28 September driver logged the same after the Duct tool); keyboard nudges work. A selected duct does not move under a mouse drag in plan either.
- Where a split is kept behind a transition and a take-off sits near the split, the neck reaches back past the take-off (it stays on round duct): the neck can be long (1.3 m in the test).

## Auto route audit: far-served terminals, partial apply, a second pass, readable tags (8–11 October 2026)

**The request:** an audit of the user's 26 m room (four FDUM22 in a row, diffusers along the top, grilles along the
bottom), where Auto route showed DU-3 "Needs layout / Equipment clearance conflict", Apply was blocked, routes were long
and labels cluttered; then "you fix the issues as you observed". Approved plan:
`C:\Users\idang\.claude\plans\duct-autoroute-audit-fixes.md`.

**What was found** (the room rebuilt from the user's screenshot in the test project, `duct-user-repro*.mjs`):
- **The root cause: terminals served by far-away units.** Terminals had been placed "for DU-n" across the room: DU-4's
  supply main ran 21 m along the top wall to a diffuser 4 m from DU-1. The balanced assignment never does this; the
  pairing was the designer's. With two diffusers placed that way, DU-1's duct crosses the room, and DU-2, DU-3 and DU-4
  then fail with `DU_CLASH`.
- **One failed unit blocked applying the others** (deliberate: nothing is applied silently as a subset).
- **Order:** units are designed one after another, each around the ducts proposed before it, so an early long duct
  boxes in the later units.
- **The preview's tags were unreadable:** the Auto route preview drew every run's full tags ("Ø200 · GI 0.50 (below
  26 ga) · spiral · RT-1 · beaded sleeve · BOD 2495") at any zoom; they piled up, covered the terminal tags and ran out
  of the room.
- The "VRF checks" count was the units' unconnected refrigerant ports: no change.

### A. Terminals served by far units (e6dc5ee)

- **`farAssignments()`** (`airSystemAssignment.ts`): a terminal whose unit is more than `farAssignmentExtraMm` (6 m)
  farther than the nearest other unit in its room with a collar of its service, **and** more than
  `farAssignmentRatio` (2×) as far. Each distance is priced as the balanced assignment prices a pairing (L1 collar lip
  to spigot lip, twice the depth behind the collar, walls crossed).
  - The balanced assignment never produces one while the fair-share overload (2.5 m) is under the margin: moving the
    terminal to the near unit would cost less. A property test checks it (fast-check, 120 cases).
  - A terminal its far unit already ducts is flagged too, with the re-route advice instead of a fix.
  - A terminal ducted from another unit than its own is left to `DU_SYSTEM_MISMATCH`.
- **Design check `DU_SYSTEM_FAR`** (warning): "SAD-1 is served by DU-1, about 25.0 m of duct away; DU-4 in its room is
  about 7.6 m away." Its **Fix** reassigns it.
- **`reassignToNearestUnits(ids)`** (`airSystemController.ts`): the terminals are taken out of their systems and solved
  again by the balanced assignment, every other terminal kept where it is. One undo. A terminal a duct already reaches is
  left alone.
- **Offered from:**
  - the checks panel (Fix);
  - the unit's Air system card: "Far: DU-1 is 8.2 m away (DU-4 26.0 m)" on the member, and "Reassign N far terminals
    to nearer units";
  - the Auto route result: "2 terminals are served by far units", with **Reassign and route again** (one undo for the
    reassignment, then Auto route with the same options).
- **When placing:** "SAD-1 placed for DU-1; DU-4 is nearer (7.6 m, DU-1 25.0 m)."
- **Settings** (Air systems, Rules): "Far unit: another nearer by over" (6000 mm) and "Far unit: and own farther by
  over" (2×), practice.

### B. Apply the units that have a layout (7bd71fe)

- When some units have no layout, the result panel offers **Apply N designed units** (since 24 October 2026 **Apply complete parts**, see below) and names what is left out
  ("DU-2, DU-3, DU-4 keep their existing ducts."). The main Apply still refuses the whole preview.
- `partialDuctApplyRefusal()` (`autoRouteCompleteness.ts`): allowed while some requested unit has no layout, at least
  one has, and every other requested service is complete. Anything else that would block Apply still blocks it: a
  clash or blocking detail from the coordinated audit, unapproved hops, a stale drawing, the final commit check.
- `applyAutoRoutePreview({ designedUnitsOnly: true })`: one undo. The message names the units left out first, so the
  toolbar's truncated status keeps them: "Auto route applied without DU-2, DU-3, DU-4 (no duct layout; they keep their
  ducts): 6 duct runs for 1 unit. One undo reverts it."
- **Found by the review, fixed here:** every coordinated candidate (refrigerant-first, drainage-first) carried the same
  duct refusal among its blocking issues, so with a unit kept they all looked infeasible and the ranking fell through to
  price: a cheaper candidate with a real pipe or drain clash could beat a clean one. It did not matter while Apply was
  all-or-nothing. `selectServiceRouteCandidate()` now ranks on everything but that shared refusal (kept in the result),
  and the drainage-first retry is decided the same way.

### C. A second pass, boxed-in units first (d74c33d)

- `planAutoRouteDucts` designs the units as before. When a unit fails on a clash (`DU_CLASH`) after another unit's
  ducts were proposed (`boxedInUnits()`), it designs them all once more with such units first.
- `betterDuctPass()`: the pass that designs more units wins, then the one with less duct (centreline length); the first
  pass on a tie. At most one retry, so routing time grows only when something failed.
- Each unit designed first on the second pass says so: "Designed before the other units, on a second pass: on the
  first, the ducts proposed for units designed before it boxed it in."
- **On the user's room** (two diffusers placed for the far units): the first pass designs DU-1 only (43 s); the second
  designs DU-2, DU-3 and DU-4, DU-1 left out (its duct to the far diffuser has nowhere to go) — 3 of 4 in 117 s, and
  "Apply 3 designed units" applies them. Reassigning the two diffusers (A) gives 4 of 4 in one pass.

### D. Readable duct tags (3760b69)

- **Before:** the plan drew each section's full tag on every leg once a duct was a few pixels wide, and the Auto route
  and Auto duct previews forced every label on at any zoom. On the user's room at 47 % they piled up, covered the
  terminal tags and ran past their legs and out of the room.
- **Now** (`ductTagLayout.ts`): every run's size tags, committed and previewed, are laid out together.
  - **Zoomed out** (under 0.08 screen px per mm, about 105 % at 1:50): each section shows its size alone ("Ø200",
    "600×300", "PLENUM 600×300"). A flexible runout, whose size the terminal's tag gives, shows nothing.
  - **Zoomed in, and on a selected run at any zoom:** the full tag.
  - **Where** (`DuctPlanTag.anchors`): beside the middle of one of its section's three longest straight stretches
    (level straight pieces end to end along a leg), else a quarter of the way along one; a runout's along the runout
    where it runs. On either side of the duct, at least 40 mm (and 4 px) off its side, clear of the flange ticks. The
    tag must fit along the stretch (a selected run's full tag excepted).
  - **No clutter:** a tag may not cover another tag, a duct piece (or its insulation), a unit, a terminal face or a
    terminal's tag, or another label the run draws (fire damper, riser, sleeve, attenuator, access door, a volume
    damper's quadrant). It tries the full text at every anchor and side, then the size; failing all, it is left out.
  - **Order:** the selected runs first, then bigger sections before smaller, so trunks keep their tags where branches
    crowd them.
  - Below 0.012 px per mm there are no section tags. Widths are measured in the plan's font (canvas `measureText`,
    cached per text).
- **The previews** draw their other labels by the committed runs' zoom rule. A drag, an edit handle, a hovered card
  option and a draft (`transientTags`) lay their run's tags out the same way, around everything else, while the
  originals and their tags hide. The preview's plans are computed once per proposal, not on every zoom step.
- **Review:** two reviewers and a verifier found duct bodies, runouts, single anchors, other labels and the transient
  previews unaccounted for in the first version; all are addressed above.

### Verified

- **Unit tests:**
  - `airSystemFar` (6): the swapped room flagged, the margin and the factor both needed, rooms and services, a ducted
    terminal, a balanced assignment never flagged (property, 120 cases), the settings.
  - Store `airSystems` (+2): reassign in one step and undo; the placement note.
  - `autoRouteReview` (+1), `autoRouteController.coordination` (+1), `serviceRouteObjective` (+1): the partial-apply
    offer and its blockers, the partial apply and its undo, the coordinated ranking with a kept unit.
  - `ductAutoRouteOrder` (3): boxed-in units, the better pass, and two units from the user's room where the first
    order boxes DU-2 in and the second pass designs both.
  - `ductTagLayout` (9): levels, the fit rule, a selected run's full tag, no overlaps with tags or ducts, every anchor
    tried, terminals, a real run's tags and markup, a terminal's tag, a runout's tag along it.
- **On canvas** (mouse only; the user's room rebuilt in the test project; each driver restores it exactly):
  `duct-far-assign` 14/14, `duct-partial-apply` 6/6, `duct-second-pass` 5/5, `duct-tags` 14/14 (sizes only at the
  room view and at 47 %, no two tags overlapping, none on a straight duct, the runs drawing none of their own; full
  tags zoomed in; a selected run's full tag; a hovered card option's tags laid out with the rest).
- **Regressions:** every segment-card driver (`duct-seg-p1` 16, `-p2` 22, `-p3` 29, `-p4` 16, `-p5` 14, `-views` 8,
  `-v2-highlight` 5, `-v2` 10, `-click` 8, `duct-round-rect` 10, `duct-y-junction` 9) and the air-system drivers
  (`air-p1` 25, `-p2` 23, `-p3` 14, `duct-cross-room` 18) pass, each restoring the project.
- **Final build:** the full suite, 2099 tests (one refrigerant geometry test, near its 60 s limit, timed out under the
  suite's parallel load and passes alone); `DUCT_BENCHMARK` 43/43; type-check and lint clean on the changed files.

### Found while auditing, not changed

- The design-check markers draw over the Auto route result panel: the floating route bar lives in the pipe overlay's
  stacking layer (`z-[8]`), below the checks overlay (`z-[12]`).
- Auto route's ducts, once applied, carry `DU_SUPPORT_RULE` warnings (no support position within 610 mm of an elbow,
  SMACNA S4.1): the optimiser does not weigh support positions.
- Reassigning a terminal its duct already reaches, then routing with Rebuild existing ducts, can leave it unserved:
  the duct step decides which terminals are free per unit, not from every collar being rebuilt.
- `autoRouteNetwork.geometry` "four cardinal directions" sits near its 60 s limit and can time out under the full
  suite's parallel load (it passes alone).

## The unit panel, a constant-friction audit and high-capacity ducted units (17 October 2026)

**The request:** recheck the constant-friction sizing logic. Clicking an AC unit should turn the left panel into that
unit's: its specification, the parameters its ducts were first sized with, how constant friction continues, and
velocity and diffuser-airflow controls that resize the ducts. Add a high-capacity unit. Approved plan:
`C:\Users\idang\.claude\plans\unit-design-panel-constant-friction.md`.

**Your decisions (17 October 2026):** "you decide … professional and modern", so every recommended option:
- The left panel holds the specification and the sizing. Generate and Apply stay in the Auto duct card (right).
- The card's applied-sizing editor becomes a one-line summary with "◂ Size it in the unit panel".
- A main velocity over the trunk limit is reported, with a one-click "Raise the trunk limit".
- A terminal whose airflow needs more than its neck's velocity cap takes the next catalogue neck, its flexible runout
  with it. Necks never shrink on their own.
- Continuing constant friction on a life-cycle design starts from the main as drawn.
- All four high-capacity units. Drain pumps per MHI data on the new units only. A Ø300 square diffuser and a Ø300
  egg-crate return grille in the toolbox.
- The unit panel opens when a unit is selected, with a toggle.

### The audit (22d32fe)

**Verified correct:** Darcy–Weisbach with the Altshul–Tsal factor is within ±1.3 % of Colebrook (ASHRAE's reference
equation) from Ø200 at 400 m³/h to Ø800 at 4800 m³/h; the ASHRAE SI chart point 1000 L/s → Ø450, 6.3 m/s, 0.91 Pa/m
matches. Huebscher's equivalent diameter for rectangles, velocity on the real rectangle; air 1.2 kg/m³, ν 1.51e-5 m²/s,
ε 0.09 mm galvanised and 3 mm flex. The method order is ASHRAE Fundamentals ch. 21 equal friction (main velocity at the
system airflow → friction rate → every section at that rate under its velocity limit → index path → damper throttling).

**Fixed:**
1. **One fan for both services.** Applied sizing compared each service alone with the unit's maximum ESP, so supply
   64 + return 48 = 112 Pa on a 100 Pa unit raised nothing. Sizing now takes the other service's index pressure
   (`otherServicePa`); `DU_AUTO_ESP` reads "supply 64 + return 48 = 112 Pa of 100". Generate already summed them.
2. **How a system was first sized is kept** (`DuctRunSpec.initialSizing`, `ductSizingRecord.ts`), on the run off the
   collar. It holds the method, where from (Auto duct or Auto route), the design's label, the fan speed, the airflow
   and its source, the main as measured (velocity, friction), the limits, the basis (constant friction), each
   terminal's airflow and the date. Auto duct's Apply and the unified Auto route write it; later resizes never change
   it. Before, a life-cycle design kept no fan speed or airflow: one designed at P-Hi 780 m³/h was re-sized for Hi
   600 m³/h at the first change.
3. **The main's governing constraint is reported** (`DuctMainCheck`): its section, real velocity and friction, what
   set it, the linked velocity, and whether the basis velocity is over the part's limit (`velocityCapped`). Before, a
   28 kW unit at the default 0.80 Pa/m showed 6.25 m/s while the main was quietly sized at the 5.0 m/s trunk limit.
4. **Round stock reaches Ø1000:** Ø560, 630, 710, 800, 900 and 1000 (EN 1506 series) follow Ø500. A project whose
   stored list is the old default reads the new one (`resolveRoundStock`); edited lists are kept.
5. **The basis is linked at the airflow the main carries** (the system's when the terminals' shares fill it), not the
   unit's.
6. **Necks follow airflow** (`autoNecksFollowAirflow`, on by default, practice): `necksToGrow` gives each terminal over
   its cap the smallest catalogue neck within it; the neck, its runout and the resized runs are one command.
7. **Drift:** `dryRunSizing` sizes at the stored basis without changing anything and lists the runs that differ (a hand
   edit, a new branch, a changed airflow), for "Re-size at this basis".

`unitAirSide.ts` gathers a unit's air side: its systems, the combined ESP check with the setting to make where the maker
lists settings, and the basis a service continues from — stored, else the first sizing's, else the main as drawn
(velocity drives), else the project defaults.

**Kept as practice, and said so in the panel:** rectangles are never narrower than tall (so low-flow tails are
oversized), heights step from the collar's, fitting coefficients are practice values, not ASHRAE DFDB.

### High-capacity ducted units (b47c9b1)

| Model | kW cool / heat | m³/h at Hi | Max ESP | Body | Collars supply / return |
|---|---|---|---|---|---|
| FDUM140KXE6F | 14.0 / 16.0 | 1920 | 100 Pa | the maker's 3D model (MEPcontent IFC → GLB) | 1194 × 164 / 1274 × 229 (measured) |
| FDUM160KXE6F | 16.0 / 18.0 | 2100 | 100 Pa | the FDUM140's (same cabinet per MHI) | as FDUM140 |
| FDU224KXZE1 | 22.4 / 25.0 | 4320 | 200 Pa (settings 10–200) | drawn to MHI drawing PJG000Z287, 379 × 1600 × 893 | 1450 × 250 / 1450 × 250, 25 mm flanges |
| FDU280KXZE1 | 28.0 / 31.5 | 4320 | 200 Pa (settings 10–200) | as FDU224 | as FDU224 |

- Each unit carries its specification (`data/unitSpecifications.ts`) with sources; the research doc lists them.
- The drawn FDU body (`buildHvacElementMesh.ts`) has the declared collars, their flanges and the control box, so the
  ducts meet it in 3D. The plan already drew declared collars.
- In the toolbox they are titled by capacity ("Ducted 14 kW" … "Ducted 28 kW"). FDUM140/160 have the built-in drain
  pump, FDU224/280 drain by gravity (VP25).

### The unit panel (left)

- **Opening:** selecting exactly one AC unit (a unit with its terminals counts) turns the left panel into the unit's;
  deselecting brings back the toolbox mode it replaced. The mode switch reads Building | AC Equipment | Unit (a dot when
  a unit is selected), and "◂ Toolbox" in the panel's header returns to the toolbox with the unit still selected.
  Starting a placement still shows the toolbox. "Open this panel when a unit is selected" is remembered with the panel
  layout; a reload opens the toolbox the panel stood in for. A narrower panel widens to 312 px while it is open.
- **Specification:** the maker's data with its sources: capacity, airflow by fan speed (m³/h and L/s), the fan's ESP
  (maximum, rated, settings, as delivered), collars, casing and weight, refrigerant and pipes, drain and pump (with a
  note when the drawing treats a pump unit as gravity), power, sound, fan, and where the 3D body comes from. A unit
  without a sheet in the catalogue (the cassette, the outdoor units) shows its maker, capacity and size as placed, and
  says what is missing.
- **Duct sizing,** per service:
  - *Before ducts:* what Generate sizes at — the method, fan speed, system airflow, main velocity ⇄ friction rate,
    limits and each terminal's airflow. They are the unit's draft (`ductSizingDraft.ts`), which the Auto duct card
    reads and writes too, so both show the same values. With a preview open, a change resizes it live and the card
    keeps it (its request and inputs still agree).
  - *Applied ducts:* the status (constant friction, its rate and velocity, and where the basis comes from); the first
    sizing with what changed since and "Reset to the first sizing" (its basis and airflows, one undo); "Continue by
    constant friction": fan speed, system airflow, main velocity ⇄ friction rate and limits, each committed change
    resizing the ducts on the drawing (one undo, named in the status bar). Under them, the main as that basis sizes it
    — section, velocity, friction and what set it. When the main is already at its smallest section and runs under
    the basis, the line says where it starts to grow ("≤ 0.39 Pa/m or ≤ 2.8 m/s", rounded down so the figure typed
    enlarges it). When the trunk limit governs, a notice offers "Raise the trunk limit to X m/s" — only when a dry run
    at the raised limit changes the ducts; otherwise it says what else sizes the main ("the split it feeds needs that
    width").
  - *Terminal airflow:* each terminal typed or an equal share, its neck and neck velocity, and "→ Ø250" where its neck
    will grow; "Share equally".
  - *Step by step:* Q and its source; V → Ø = √(4Q/πV) → R; every section at R (or as drawn when the drawing differs);
    supply + return against the fan; each terminal's damper throttling.
  - *Drift:* "N runs no longer match 0.80 Pa/m … Re-size at this basis".
- **Fan:** supply + return index pressure against the fan's maximum, with a bar, and the ESP to set on the wired
  remote where the maker lists settings.
- **Numbers that follow** (the friction rate while the velocity drives, and the other way round) read rounded to two
  decimals, and − / + step from the rounded value. Typed values keep their own precision.
- **The right panel:** the Auto duct card shows "Ducts on this unit" (one line per service) with "◂ Size it in the
  unit panel". The unit's generic fields show the maker's airflow, heating capacity, ESP, voltage and refrigerant as
  placeholders instead of zeros; a typed value still overrides, and clearing it returns to the maker's.

### Found while verifying on canvas

- **A main generated at one size stayed that size to its end** (constant friction). Past its last take-off a main
  carries no air; that stretch is meant to carry on as the section before it. But the "nothing grows downstream" pass
  read the size it was drawn at first, so it held every section upstream at that size. Generate draws a main at one
  size end to end, so the FDU280's main stayed 700 × 350 from 4320 m³/h down to its last 720 m³/h (0.8 m/s). The same
  thing made "Raise the trunk limit" change nothing there. The pass now starts at the last section with air, and the
  dead end follows once the rest is final (`ductSystemSizing.ts`; test "steps a main drawn larger than it needs down
  with the airflow"). The FDUM22 systems tested so far sat at their smallest sections, so it never showed there.
- **The 30 m² test room is too small for a 28 kW unit** (it serves about 150 m² and up). With six Ø300 diffusers on a
  1.4 m grid there, Auto duct ran the trunk out through a wall and its runouts clashed (`DU_AUTO_WALL`, `DU_CLASH`,
  `DU_TAP_CLASH`, `DU_FLEX_BEND`). That is the tight-room limit below, not the sizing. The canvas check builds a
  12 × 9 m room instead.

### Verified

- **Unit tests:**
  - P1 (22d32fe): `ductSystemSizing` (+5: the fan against both services, the main and what governs it, the link at
    the main's airflow, the first-sizing record read tolerantly, round stock to Ø1000 with the old list migrated);
    `unitAirSide` (new, 7: necks over their cap and the one each takes, the grown necks sized as one set of changes,
    drift, the basis a system continues from, the fan's setting, the first-sizing record measured on the design and
    keeping its basis); the store (+4: the record kept at Apply, dated; a neck grown in the same command as the resize;
    the reset to the first sizing as one command; a life-cycle design refused a reset, a hand-edited one re-sized at
    its basis).
  - P2 (b47c9b1): the library (counts; each new unit GLB-backed or drawn to a cited drawing), the measured ports, the
    drawn FDU body's collars in 3D, and `highCapacityUnits` (an FDU280 with six Ø300 diffusers by constant friction:
    nothing capped, the trunk limit sizing the main, the fan covering it).
  - P3 (47c24f7): `ductSizingDraft` (12: the airflow it is linked at, the bases, the services, the per-unit store).
  - The dead end (72f055b): a four-take-off main drawn 600 × 250 steps down with the airflow (400 → 300, then carried
    on under the reducer step), its dead end follows, sizing again changes nothing; the test fails without the fix.
  - Full suite after the fix: 258 files, 2243 tests passed (43 skipped as before); type-check and lint clean on the
    changed files.
- **On canvas** (real toolbox, mouse and inputs; each driver restores the project exactly; nothing is saved):
  - `unit-panel` 34/34: a cassette shows its specification only; an FDUM22 with two Ø200 diffusers — the maker's
    data, Generate's parameters set from the panel and shown in the card, a preview resized live from the panel with
    the card keeping it, Apply and its first-sizing record, the fan card, the steps; "◂ Toolbox" and the card's
    "Size it in the unit panel"; 3.0 m/s changing no duct and the panel saying where the main grows, its figure
    (2.8 m/s) enlarging the main 250 × 250 → 300 × 250; a diffuser at 500 m³/h taking a Ø250 neck; the reset; the undo
    chain; deselecting brings the toolbox back.
  - `unit-hc-probe` 4/4: the four units in the toolbox titled by capacity; FDU280 and FDUM140 placed with their
    collars (1450 × 250 from the drawing; 1194 × 164 / 1274 × 229 measured), in plan and Iso.
  - `unit-high-capacity` 19/19: an FDU280 in a 12 × 9 m room with six Ø300 diffusers — the specification,
    constant friction from the panel, Generate (about 10 s: no errors, nothing capped, 720 m³/h each, 46 Pa of the
    fan's 200), Apply, the main sized by the 5 m/s trunk limit and said so, "raising the limit would not change these
    ducts: the split it feeds needs that width" (its Y's two 350 × 350 outlets side by side), the ESP to set (60 Pa),
    the steps; plan and Iso.
- **Regressions:** `air-p2` 23/23, `air-p3` 14/14, `duct-seg-click` 8/8, `duct-far-assign` 14/14, `duct-tags` 14/14,
  `pipe-seg-inspector` 8/8, `duct-cross-room` 18/18; `air-p1` 25/25 (its toolbox counts now include the
  Ø300 pair). `duct-sizing`, with its applied-sizing steps moved to the unit panel, was 23/26 here: its three
  failures came from an older layout change, found and fixed afterwards (see below).

### Known limits

- The FDU224/280 body is drawn to the maker's dimensions until a maker 3D file is provided; their refrigerant and drain
  connection points stay procedural, as for the FDUM22. The 28 kW refrigerant side (branch kits above DIS-22-1G) is out
  of scope.
- Small systems sit at their smallest sections (as wide as tall at the collar's height): a velocity or friction change
  above the main's own changes no duct. The panel says where it starts to grow.
- The cassette and the outdoor units have no maker sheet in the catalogue yet: capacity and size only.
- The draft (Generate's parameters set in either panel) lasts the session; it is not saved with the project.
- Auto duct with 9–12 terminals is still the known limit below; a 28 kW unit at Ø300 needs about six diffusers.
- A neck that grows with its airflow keeps its runout's route: a bend that was tight for Ø200 falls further under one
  diameter at Ø300 (`DU_FLEX_BEND`, shown on the run). Generate again routes for the new sizes.

### Found while verifying, fixed afterwards (18 October 2026)

- **Auto duct chose a trunk into the wall in the `duct-sizing` room** (the driver was 25/25 on 1 October; it now
  failed the same way on the code before this work). In the 30 m² room its FDUM22 design ran a straight trunk whose
  end crossed the wall (`DU_AUTO_WALL`), and after the live resize to 3 m/s two Ø200 runouts bent at 149 and 177 mm
  (`DU_FLEX_BEND`).
  - **Bisect** (a separate worktree, the canvas check on port 3100, the 31 commits touching the engine or the web app
    between 6d878c8 and f44ec66): the first bad commit is 101783b (4 October, the auto-route recovery work). Replaying
    the canvas scene in a test at 1ddc3ec and 101783b showed what changed: every "Split trunk + branches" seed now
    failed exact sizing ("its all-flex runout fits from none of this main's sections"), so a straight trunk won.
  - **Cause:** 101783b added take-off stations at the edges of obstacles in a stub's way (`alternateStations` in
    `placeTaps`). The stub check is a heuristic, and in a tight room it calls the take-off in front of each diffuser
    blocked (its padded box touches the diffuser's own box and the wall), so the moved stations won on cost and then
    could not be built. Disabling only the moved stations brought the split trunk back (39 Pa, no errors); restoring
    only the old stub check did not.
  - **Fix** (`ductAutoLayout.ts`, `ductAutoContext.ts`): the trunk candidates are built both ways — with the moved
    stations, as 101783b intended, and with the take-offs at their terminals (`ServiceCtx.tapStations`) — duplicates
    (the same run paths) dropped, and exact sizing and verification choose among all of them, as they already rank
    every option. Test `ductAutoLayoutTapStations` (the room rebuilt): a clean design with no wall crossing, and a clean
    split trunk among the options; it fails without the fix. Full suite 259 files / 2244 tests; `DUCT_BENCHMARK`
    43/43. On canvas: `duct-sizing` 26/26 again (a split trunk; no errors in the preview, the applied runs or the
    resized ones), and `unit-panel` 34/34, `unit-high-capacity` 19/19, `duct-far-assign` 14/14, `duct-tags` 14/14,
    `duct-cross-room` 18/18, `air-p1` 25/25, `air-p2` 23/23, `air-p3` 14/14, `duct-seg-click` 8/8,
    `pipe-seg-inspector` 8/8, `probe-space-pan` 3/3, each restoring the project.
- **Panning with Space + drag from inside a room selected the room** (from on a wall it did not). Fixed afterwards: the
  canvas's selection listener checked the tool, which stays Select while Space is held, and finds rooms by geometry
  rather than through Fabric targets (made inert while panning); it now skips while Space is held. `probe-space-pan`
  3/3 (no selection from a room or a wall; a plain click still selects the room).

## Moving units, terminals and ducts: one or many, in every view (19 October 2026)

**The request:** diffusers, AC units and duct segments can be selected one by one, and the selection moves together
or on its own, in the plan, isometric, 3D or any other view. Approved plan:
`C:\Users\idang\.claude\plans\hvac-move-anywhere.md`.

**Your decisions (19 October 2026):** "do your recommendations very professional and very modern way", so every
recommended option:
1. A unit moved alone: its ducts stretch, its diffusers stay where they are.
2. A group move where one item would break a rule: the whole selection stops at the last position where every item
   is valid.
3. A move that gives ducts new problems (a clash, a wall crossing, a short leg): allowed, shown amber, kept in the
   design checks.
4. Up and down: ducted units and duct straights, within the ceiling void; diffusers and grilles stay in the ceiling.
5. A straight moved on its own: sideways (and up and down in 3D), its neighbours stretching.
6. Snapping: grid, smart alignment guides and a Shift axis lock.
7. Design-check badges: at the element's corner, letting a drag pass through.

### What it did before (probed on the canvas)

| | Plan (2D) | Iso / 3D / Front / Side |
|---|---|---|
| Diffuser / grille | Drag works; its runout follows | Cannot be selected or moved |
| AC unit | Cannot be dragged: the design-check badge (24 px, `pointer-events-auto`, z-12) sits on its centre and swallows the press | Cannot be selected or moved |
| Several selected | Only the pressed item moves; the selection collapses to it | — |
| Duct run | Drag refused for any run on a unit collar (every generated trunk) | Click selects; no move |
| Duct segment | Handles move a leg sideways, the end, a riser; one run only, never the first leg | No move |
| Keyboard | Whole selection, one undo; but a unit's ducts moved rigidly with it, so diffusers that stayed were left behind | — |

### Phase 1: one move model

Every input (the arrow keys now; drags, the gizmo and typed moves in the next phases) calls one pure function,
`planHvacMove(scene, { ids, segment, delta }, context)` in `hvac/move/hvacMoveModel.ts`. It returns every changed
element as it will be stored, the drain pieces added and removed, each element's outcome (moved, or follows), the
notes worth showing, what stopped the move short, and the undo step's name ("Move FDUM22 and 2 diffusers").

- **How far the whole selection can go.** Each unit and terminal keeps its placement rules (the canvas's own
  `computeHvacPlacement`: indoor units in a room, outdoor units outside, wall units on a wall, branch kits on their
  pipe run). The first point along the move where any of them would break is found by bisection, and everything
  stops there ("Stopped short: FDUM22: Equipment must be placed inside a valid room."). An item that already breaks
  its rules where it is moves as it is and holds nothing back, so it can be moved back in.
- **Up and down.** Ducted units, duct straights, refrigerant pipes and branch kits move; diffusers, grilles and
  cassettes sit in the ceiling, wall units at their mounting height, outdoor units at their own level (the status
  says which and why). A ducted unit's underside stays above the ceiling and its top below the soffit, and so does
  every duct run that rises with it. The ceiling is where the air terminals sit (else the rooms' ceiling heights, the
  cassettes' faces, 2400 mm); the soffit is the duct settings' (else the routing ceiling limit).
- **Ducts stretch** (`ductNetworkMove.ts`, `ductElasticMove.ts`). Each run is solved from the unit outwards, a
  branch on its parent's new wall. A run's start moves exactly as what it leaves from: the collar, a split outlet or
  a plenum spigot at its parent's end, or a take-off, which moves square to its parent's wall and in level with it
  but may slide along the wall within its straight. Its end moves exactly as the terminal it serves, so an unmoved
  diffuser keeps its runout. Every rigid leg keeps its direction and only changes length (never below 50 mm or its
  own length); a flexible runout bends to wherever its ends go. Every other vertex moves as little as it can, or,
  for a run being moved, as close to the drag as it can. One small least-squares problem per run: unknowns are the
  start's shift and each leg's length change (a flexible leg's free shift); fixed points are met exactly by an
  augmented Lagrangian on one factorisation; leg minimums and slide limits by an active set.
  - Move a unit across its main and the main shifts with the collar while the branch's first straight shortens;
    move it along the main and the main shortens while each take-off keeps its place in the room (its station
    changes). Move it toward its trunk and the collar's straight stops at 50 mm, then pushes the trunk.
  - A run moved without its unit offsets: its straight to the collar stretches. Moved along the trunk's own line
    it cannot slide (the collar's straight is square to it), so its far end extends.
  - A diffuser moved along its trunk drags a rigid runout's take-off with it; one moved past the trunk's end leaves
    the run as near as it can get, with "SD-2 no longer reaches SAD-3: re-route its runout."
  - Moved together = moved rigidly: a run whose collar and terminals all move by one vector translates exactly,
    whether it was picked or not (a unit and its diffusers moved, the ducts between them not picked).
  - A turned unit (a wall unit snapping to a new wall) turns its runs rigidly about the collar, as before.
- **One straight on its own.** A level straight moves sideways (the along-component of the drag is dropped), the
  legs either side stretching and shortening; a riser moves along its heading. Up or down it rises on risers made in
  it: a riser at a plan corner would bend the hard way (`DU_HARD_WAY_ELBOW`), so where a neighbour turns, a stub
  long enough for the corner's elbow and the riser's (W/2 + neck + H/2 + neck + 50 mm) stays at the old level and
  the riser stands at its end; a neighbour running on in line takes the riser at the joint; a riser neighbour simply
  stretches. Later node overrides, accessories and take-offs are re-keyed to their new legs. Refused, with the
  reason, for the first straight off a collar, the last one into a terminal, a flexible runout and a straight too
  short for its elbows.
- **What follows.** Refrigerant pipes on moved units and kits re-attach one item after another (a pipe between two
  moved items meets both); selected pipes translate or rise as before. Drains follow moved units and gullies, and
  selected drain runs re-solve per network, all of a network's picked runs in one solve. The preview will leave the
  drain re-solve out (it is the slow part) and the commit will include it.
- **The keyboard.** Arrows move by the grid step (Shift ×10, Ctrl ×0.1); Alt + Up / Down, or Up / Down in Front
  and Side, move up and down. One undo step per press.

### Verified (Phase 1)

- Unit tests: `ductElasticMove` 11, `ductNetworkMove` 13, `hvacMoveModel` 10. Full suite 262 files / 2278 tests (2244 before, plus these 34).
- On canvas, `move-p1` 24/24 (an FDUM22, two Ø200 diffusers, Auto duct applied; real key presses), restoring the
  project exactly:
  - the unit alone, 500 mm right (Shift + Right): the diffusers stay, both runouts still end on their spigots (0 mm off),
    the collar run starts on the moved collar (0 mm off), no new duct plan error; the stretched branch then clashes
    with the trunk and with SAD-2's body (two `DU_CLASH`, allowed and reported: decision 3; this line said "no new duct
    error" until 19 October, from a check that read a field the duct report does not carry); one undo restores it;
  - the whole system (unit, both runs, both diffusers), 500 mm down: every duct vertex moves by the same vector;
  - the unit up twice (Alt + Up, 50 mm each): the collar run rises 100 mm, its runout takes the height, both runouts
    still on their spigots; two undos;
  - a diffuser up: nothing moves, the status says "SAD-1 sits in the ceiling";
  - the branch run across its trunk: it offsets (its first straight 250 → 750 mm), its take-off stays; along its
    trunk: its take-off slides (station 1359 → 859 mm); its runout stays on SAD-1 both times.
- `move-checks`: the unit 500 mm right in that tight looped layout adds two support-spacing warnings (the leg after
  the collar is shorter) and two clashes (its trunk now crosses the branch and SAD-2): reported, as decided (3).
- `move-drains` 13/13 (the FDUM22 and a floor gully, drains by Auto route): the unit 500 mm right, its drain starts at
  its new drain port; a drain run nudged, its network re-solves with its start still on the unit; the gully 500 mm
  left, the drains follow; no new drain error; one undo each; restored exactly.
- Regressions: `duct-p4` 21 (a diffuser nudge drags its runout end, one undo), `duct-seg-p3` 29/29, `air-p1` 25/25,
  `duct-seg-click` 8/8. `duct-complete` and `micro` no longer run: both fail while setting up (an old draw step; a
  toolbox label that is now a tile), before any nudge.

### Known limits (Phase 1)

- **A drain run nudged along its last leg** (as before this work: the same route operation) moves the bend, not the
  leg: the run overshoots its fixed joint and comes back (in `move-drains` B, down to y 5251 and back to 5133). To
  be done with the drain drag in Phase 2.
- **Undo clears the selection** (as before): a second nudge after an undo needs the item picked again.
- **A rise shorter than two elbows** (a straight lifted 200 mm on a 164 mm deep duct needs 264 mm) is made and
  reported (`DU_LEG_TOO_SHORT`), not refused.

### Phase 2: dragging on the plan

- **One gesture, whatever it starts on** (`hvac/move/hvacMoveSession.ts`). A press on a unit's or terminal's body, on a
  duct run's outline, on a straight's edit handle or on a design-check badge arms a move. After 4 px it is a drag, so
  a click stays a click: a click on an item of a selection selects it alone (on a duct it also pins the piece under
  the pointer, as before); a press on an unselected item selects it and a drag then moves it alone; pressed on an
  item of a multi-selection, the whole selection moves. Each pointer move (at most one per animation frame) snaps the
  drag and asks the move model for the preview; the release commits the full plan as one undo step; Esc cancels;
  typing a number moves exactly that far along the drag (Enter; Backspace edits; Shift keeps it on an axis).
- **Snapping** (`moveSnapping.ts`). Alignment guides first: on each axis, a moving item's centre or edge within 6
  screen pixels of another unit's, terminal's or gully's centre or edge snaps onto it (the centre line wins when
  several line up at once, as two diffusers of one size do), shown as a dashed magenta line. Otherwise the grabbed
  item's centre lands on the board's snap step (the same step as the arrow keys). Shift keeps to the dominant axis;
  Alt moves freely.
- **The preview.** Unit and terminal bodies (Fabric) are placed where the move puts them
  (`HvacPlanRenderer.previewMove`); duct runs and air terminals are redrawn in the duct overlay's draft layer, their
  stored drawings hidden meanwhile (`DuctOverlay.previewMove`), and a run the move gives a problem shows the planner's
  own dashed red. After the release both keep the preview until the stored move re-renders them, so nothing flashes
  back. The drain re-solve is the slow part: the preview leaves it out and the release does it; pipes and drains
  re-attach on release. No React state changes per frame.
- **The readout** (`HvacMoveHud.tsx`), beside the cursor: what moves ("Move DU-1 and 2 diffusers"), Δx, Δy and the
  distance, a distance being typed, why the selection stops short (red) and what the move leaves for the designer
  (amber), e.g. "The run to SAD-2 is pushed along: its first straight is at its shortest."
- **Fabric no longer drags HVAC bodies.** Their movement is locked; the single-item drag (`object:moving` /
  `object:modified` for HVAC), which moved a unit's whole duct tree rigidly, is gone with its helpers.
- **Design-check badges.** A unit's or terminal's badge sits on its footprint's top-right corner (a run's on its
  middle, as before), so the body under it can be grabbed; a drag that starts on a badge moves its element; the badges
  of the items being dragged wait until the move is stored.
- **Ducts.** A press on a selected run's outline moves the selection (a run without its unit offsets); the straight
  whose card is pinned moves on its own; a leg's or riser's edit handle moves that straight through the same session
  (they used to re-anchor branches rigidly, which pulled flexible runouts off their terminals); the end handle keeps
  its own edit (it slides the run's end along its last leg).
- **Move by** in Properties: Δx, Δy and Δz in the project's unit and "Move selection", which runs the arrow keys'
  move (`hvacMoveBus.ts`): the same rules, followers and undo.
- **Names.** Units by their air-system tag (DU-1), library names without their "(3D)", and a run whose label is the
  generic "Supply duct" by what it serves ("The run to SAD-2").

### Verified (Phase 2)

- Unit tests: `moveSnapping` 6 and `hvacMoveSession` 5 (a fake window: click against drag, a selection kept, the
  preview then one commit with the drains, Esc, guides before the grid, Shift, a typed distance); 45 in `hvac/move`.
- On canvas, `move-p2` 32/32 (an FDUM22, two Ø200 diffusers, Auto duct applied; real pointer drags), restoring the
  project exactly:
  - the unit dragged by its body (its badge no longer in the way): the readout at the cursor ("Δx +675 Δy +9 ·
    675 mm"), an alignment guide placed it, the diffusers stayed, both runouts still on their spigots; one undo;
  - two diffusers selected, dragged by one: both moved by one vector, the selection stayed, their runouts followed;
  - a duct run dragged by its outline: it offsets, its start stays on the collar, the runouts stay on their spigots;
  - a straight clicked (its card pins, `leg:2`), then dragged: only it moves ("Move a straight of Supply duct");
    its leg handle does the same through the session, and the branch's runout stays on its spigot;
  - Esc mid-drag: nothing changes, the readout goes; a typed 1000 with Shift + Enter moves exactly 1000 mm;
  - "Move by" Δx −400, Δy 250: exactly that; a drag starting on the unit's badge moves the unit.
- Again with every driver run together: `move-p2` 32/32, `move-p1` 24/24, `move-drains` 13/13, `duct-p4` (its
  diffuser now dragged through the session, one undo), `duct-seg-p3` 29/29, `duct-seg-click` 8/8, `air-p1` 25/25.
- Full suite 264 files / 2289 tests.

### Phase 3: the 3D views

- **Picking.** Units, terminals and gullies are found under the pointer in the 3D views (the nearest of them and of
  the duct runs wins; runs, pipes and kits keep their own picks). A click selects (Shift adds or takes out); a press
  arms the same move session as the plan's, so a drag moves the selection, the whole of it when the item is part of
  it. A press on a duct run arms it too (a click still selects the run and pins the segment under the pointer).
- **Each view's surface.** The drag runs on the view's own construction plane through the point grabbed, so the item
  stays under the cursor: level (XY) in the tilted plan, Iso and 3D; XZ in Front; YZ in Side (the view policy of
  `vrf/interaction`). Only the axes a drag moves change: in Front the depth stays exactly as it was.
- **The move gizmo** (`HvacMoveGizmo3D.tsx`), at the centre of the selected units, terminals and runs: X / Y / Z arrows
  and XY / XZ / YZ plane squares move along an axis or across a plane, and its centre ring on the view's surface.
  Up and down is offered only where the selection can go (a ducted unit, a duct run; terminals sit in the ceiling).
  Screen-sized, projected every frame the camera or the selection changes; it waits while a drag is under way.
- **One session.** The session takes the 3D view's pointer as a resolver (the interaction service's `beginDrag` /
  `updateDrag` with the axis or plane), so the readout, snapping (the grid step on every axis the drag moves; no
  guides, which the plan draws), Esc, a typed distance and the one undo step are those of the plan. Δz shows once a
  move has height. The ceiling void stops a rise ("Stopped short: Supply duct would rise above the soffit
  (2900 mm)").
- **The preview in 3D** goes through the scene's own edit preview (`setMovePreview` on the imperative bridge): the
  moved units, terminals and runs are drawn as they would be, their committed meshes hidden, held after the release
  until the stored move re-renders — no React update per frame.
- **The keyboard:** Page Up / Page Down move up and down in every view (the arrows as before: Alt + Up / Down, or Up /
  Down in Front and Side).
- **Also in the plan:** a faint dashed outline stays where each moved unit and terminal was while it is dragged.

### Verified (Phase 3)

- Unit tests: the session in a 3D view (its own surface, up and down snapped), an axis a drag does not move kept
  exactly (an off-grid item with Shift; a Z arrow), Page Up / Down; 47 in `hvac/move`.
- On canvas, `move-p3` 18/18 (the same scene; real pointer input), restoring the project exactly:
  - Iso: a click on a diffuser selects it and its gizmo has no Z arrow; the unit dragged by its body moves level
    ("Move DU-1"), its runouts still on their spigots; one undo;
  - the gizmo's Z arrow lifts the unit exactly (0, 0, +180 mm, stopped at the soffit) and its collar run rises with
    it, the runouts taking the height;
  - Front: the unit drags across and up (+454, 0, +180): no depth;
  - a duct run dragged in Iso offsets, its runouts on their spigots.
- `move-p2` 33/33 (the outline where the unit was shows mid-drag), `move-p1` 24/24; 3D picking and cards unchanged:
  `duct-seg-p4` 16/16, `duct-seg-p5` 14/14, `cd-seg-pieces` 14/14, `pipe-seg-inspector` 8/8, `air-p3` 14/14,
  `duct-seg-click` 8/8.
- Full suite 264 files / 2292 tests.

### Refrigerant pipes follow live, and the known limits (19 October 2026)

- **Pipes and kits follow while dragging.** The pipe overlay takes the move as it is previewed (`setMovePreview` on
  its handle; the moved pipes, kits and units substituted in its own list, so only it re-renders) and holds it after
  the release until the stored move arrives. `move-pipes` (the FDUM22 and the outdoor unit piped by Auto route, gas +
  liquid): the pipes are redrawn while the unit is dragged, end on its moved ports as they did before, one undo.
- **Known limits:**
  - Drains re-solve on release (the slow part); while dragging they stay where they were.
  - A drain run nudged or dragged along its last leg overshoots its fixed joint and comes back (the route operation
    the drain nudge used before this work, `translateRouteInterior`).
  - A straight raised less than its two elbows need (264 mm on a 164 mm deep duct) is made and reported
    (`DU_LEG_TOO_SHORT`), not refused.
  - Undo clears the selection (as before): a second move after an undo needs the item picked again.
  - Alignment guides are drawn in the plan only; the 3D views snap to the grid step.
  - Copying while moving is not part of this work; it fits the same session. Rotating is the next section.

## Rotating units and air terminals: what is connected follows (19 October 2026)

**The request:** a rotation feature for AC equipment and diffusers; when the rotation changes, the corresponding items,
ducts and other accessories included, change with it. Approved plan: `C:\Users\idang\.claude\plans\hvac-rotate.md`.

**Your decisions (19 October 2026):** "yes do", so every recommended option:
1. A unit turned alone re-aims its duct runs from the turned collar to rejoin their route; where none fits, the run
   swings rigidly about the collar (runouts kept on their diffusers) and is named.
2. A square or round diffuser keeps its spigot facing its runout (its side is re-chosen); a slot or rectangular grille
   turns its spigot with it and the runout follows.
3. Several selected turn as one block about the selection's centre; "each in place" on request.
4. Snapping: 15° steps and the walls' angles; Alt turns freely.
5. `R` / `Shift + R` turn the selected units and terminals 90° clockwise / anticlockwise (the Room tool otherwise).
6. Wall units stay square to their wall (a turn is refused with the reason); branch kits turn with their pipe run.
7. A rotation ring on the 3D gizmo (Iso, 3D, tilted plan); Front and Side do not offer it.

### What it did before

Only the Properties "Rotation" field turned a placed item, writing the angle straight onto it: its ducts, pipes and
drains stayed where they were (the run's start off the collar), a diffuser's spigot turned away from its runout, a wall
unit could be turned off its wall, and `R` only turned an item being placed.

### Phase 1: one turn in the move model

`planHvacMove(scene, { ids, delta: 0, rotation: { angleDeg, pivot, partial } }, context)` (`hvac/move/hvacMoveModel.ts`)
plans a turn exactly as it plans a move: every changed element, the outcomes, the notes, what stopped it, and the undo
step's name ("Rotate DU-1 90° clockwise", "Rotate 2 diffusers 45° anticlockwise each").

- **What turns.** Units and air terminals (and drain gullies); branch kits turn with their pipe run, not on their own;
  duct runs, pipes and drains follow what they are attached to. One block turns about the centre of the selection's box
  (each item's position and orientation), or each item about its own centre ("each in place").
- **Rules.** A wall unit refuses the turn ("SRK35 hangs on its wall and stays square to it: move it to another wall
  instead."). Every other unit and terminal keeps its placement rule (indoor in a room, outdoor outside): an exact turn
  (a key, a button, a typed angle) is made whole or not at all; a drag stops at the last angle every rule allows.
- **A square or round face** (square 4-way, round, egg-crate, perforated, louvred, with a square plenum box) keeps its
  spigot facing its runout: its side is chosen anew, so a quarter turn leaves its duct exactly as it was. A face whose
  box is not square (a linear slot) turns its spigot with it: a flexible runout re-curves to it; a rigid run's end is
  re-aimed onto it (the run read from its end), or reaches it and says "meets LSD-1's turned spigot at an angle:
  re-route its last straight."
- **Moved together = turned rigidly.** A system whose unit and every terminal it serves turn in the block turns whole
  (every vertex about the pivot, the spigots on the same sides).
- **A run on a turned collar** (`ductNetworkMove.ts`, `duct/ductCollarReroute.ts`): it leaves the turned collar square
  to it and rejoins its own route before its first take-off, so the take-offs, their branches, the accessories and
  every diffuser stay exactly as they were. Two ways are found and the cheaper to make is taken (its rigid length plus
  1500 mm of duct per elbow):
  - a re-aim onto the route as it runs (straight on, one new elbow, two turns, a stub onto its flexible runout), each
    candidate planned;
  - a route round the unit onto the old line, by the obstacle-aware orthogonal router in the old route's own frame:
    square-throat elbow room at each turn (what the planner makes where a radius elbow does not fit), round the
    casing, the terminals, other equipment, other runs and the walls (a re-route stays in its room). A collar turned
    off the room's axes (45°) leaves on a stub that turns onto one of them, so the ducts stay square to the room.
  Every candidate's first straight holds the connector and the collar's transition (674 × 164 to 250 × 250 is 960 mm
  at the 14° design taper; where a wall is close in front, as short as SMACNA Fig. 2-7 allows, about 470 mm), is
  planned with the run's take-offs renumbered onto it, and is checked for clashes with what it keeps (its own legs and
  branches included). Where neither fits, a stub off the collar with one elbow onto the route's heading, the route
  stretching to meet it, validated the same way; where that does not fit either, the run turns rigidly about the
  collar, its runouts still on their diffusers, and says "turned with its unit: re-route it, or re-design it with Auto
  duct."
- **Pipes and drains.** Refrigerant pipes re-attach to the turned ports (one unit after another); drains re-solve from
  the turned outlets (the commit; a preview leaves them out).
- **The keyboard and the Properties panel.** `R` / `Shift + R` turn the selected units and terminals 90° clockwise /
  anticlockwise; with none selected, `R` is the Room tool, and during a placement it still turns the item being
  placed. The Rotation field of a unit turns it to the angle typed (Enter or leaving the field; one undo step, not one
  per keystroke). A "Rotate" section offers ⟲ 90°, 180°, ⟳ 90°, an exact "Turn by" and, for several, "Turn each in
  place".

### Phase 2: the rotation grip on the plan

- **The grip.** A round knob with a turning arrow on a short dashed stem above the selected units and terminals (one
  for the whole selection, above its box; below it near the top of the view). Dragging it turns them about the centre
  of their box through the move session's rotation mode (`hvacMoveSession.beginRotate`): the same model, the preview
  in every layer each frame (one plan per angle: moving within a snap step plans nothing new), one undo step.
- **Snapping.** The angle the pointer sweeps about the pivot is snapped so the first item's orientation lands on a 15°
  step, or on a wall's angle (or a quarter turn from it) within 4°, whichever is nearer; Alt turns freely (to a tenth
  of a degree). Typing a number turns exactly that far ("-" for anticlockwise), Enter makes it, Esc cancels.
- **The readout** names the turn and its angle ("Rotate DU-1 90° clockwise", "+90°"), with the pivot, a spoke to the
  pointer, the swept wedge, and a faint outline where each item was. What the turn did without needing the designer
  ("The run to SAD-1 leaves the turned collar and rejoins its route round DU-1 (3 new elbows).") is said plainly; what
  it leaves for the designer stays amber, why it stopped short red.

### Phase 3: the ring on the 3D gizmo

The move gizmo of the tilted plan, Iso and 3D views carries a rotation ring: a level circle round the centre of the
selected units' and terminals' box, at the selection's mid-height, screen-sized like the arrows. Dragging along it
turns them through the same rotation mode; the angle is the point under the pointer on the level plane through the
pivot (the drag service's displaced anchor is a move's delta, not an angle about a point). Front and Side look at the
ring edge-on and do not offer it.

### Verified

- Unit tests: `ductCollarReroute` 4 (a quarter turn either way and a half turn re-routed round the casing onto the
  old line before the take-off, a wall sending a half turn round the other side, a 45° collar left to the other ways),
  `hvacRotate` 19 (the unit alone at 90°, −90°, 180° and 45°; a block turned rigidly; the placement rule all or nothing,
  a drag stopping short; a square diffuser's spigot re-chosen, its duct unchanged; a slot's flexible runout re-curved;
  a rigid run re-aimed onto a turned slot, and one that drops just before it reaching it at an angle; the loop Auto
  duct lays out, re-routed at 90°, −90° and 180°, a half turn with a wall 1.46 m in front of the collar compressing the
  transition, and 45° turning rigidly with its note; a wall unit refused; ducts alone refused; the labels),
  `hvacMoveSession` +5 (the rotation mode: 15° steps, a wall's angle, Alt, a typed angle with "-", Esc, a block).
  Full suite 266 files / 2320 tests.
- On canvas (an FDUM22, two square Ø200 diffusers, Auto duct applied; real key presses, clicks and drags), each
  restoring the project exactly:
  - `rotate-p1` 37/37: `R` turns the unit 90° (the trunk re-routed round it, 3 new elbows), `Shift + R` −90°, `R`
    twice and the 180° button a half turn (re-routed, no rigid swing, no new duct error), a diffuser turned with its
    duct untouched (its spigot moved from the right side to the back), the Rotation field to 45° (no way back onto the
    tangled loop: it turns rigidly and says so), the Rotate section's buttons, the whole system as one block (rigid,
    nothing new clashing), and `R` with nothing selected turning nothing;
  - `rotate-p2` 31/31: the grip, a quarter turn by dragging (the readout and the wedge while dragging), 80° swept
    snapping to 75°, Alt to exactly 37°, a typed 45 with Enter, Esc, a diffuser, the block;
  - `rotate-p3` 15/15: in Iso the ring on the unit's gizmo, a quarter of it each way (+90°, −90°), a diffuser, and no
    ring in Front;
  - `rotate-p4` 17/17: the unit piped and drained by Auto route turned with `R`: both pipes end on its turned ports as
    before, its drain starts at its turned outlet, no new drain error; a linear slot turned: its spigot turned with it
    and its flexible runout re-curved (the rigid part within 0.003 mm); two diffusers turned each in place.
- Regressions, each restoring the project exactly: `move-p1` 24/24, `move-p2` 33/33, `move-p3` 18/18, `move-drains`
  13/13, `move-pipes` 6/6, `duct-seg-p3` 29/29 (the take-off re-aims, now through the shared candidate search),
  `duct-seg-p4` 16/16, `duct-seg-p5` 14/14, `duct-seg-click` 8/8, `air-p1` 25/25, `air-p3` 14/14, `cd-seg-pieces`
  14/14, `pipe-seg-inspector` 8/8.

### Found while verifying, fixed

- **The collar's transition.** The trunk Auto duct makes is 250 × 250 off a 674 × 164 collar: the transition takes
  960 mm of the first leg at the 14° design taper. The first re-route left 455 mm and every candidate failed its plan
  (`DU_TRANSITION_ANGLE`); the first leg now holds the connector and the transition, compressed to the steepest SMACNA
  Fig. 2-7 allows (about 470 mm) only where a wall is close in front.
- **Auto duct's loops.** Its trunk can wrap round a diffuser and return 184 mm above the unit, overlapping its own
  first leg in plan. Routes are now found round the terminals, other equipment, other runs and the walls, and every
  candidate is checked against what it keeps (its own legs and branches included); the stub fallback is validated the
  same way, and a template re-aim and a re-route are compared on what they cost to make (one re-aim had looped the
  trunk round both diffusers, 4 m of duct more than needed).
- **The drivers' duct-error check** (also in the move drivers) read `severity`, which the duct report's issues do not
  carry (they carry `level`): it passed whatever happened. The rotate drivers use `level`, and so does `move-p1` now, listing clashes on their own: the unit alone moved 500 mm
  right leaves the stretched branch clashing with the trunk and with SAD-2's body (two `DU_CLASH`, allowed and
  reported by the move's decision 3). The move section's Phase 1 line is corrected.

### Known limits

- A unit whose trunk loops tightly round its diffusers has no clean way back onto the loop at 45°: the run turns
  rigidly with the unit and says "re-route it, or re-design it with Auto duct".
- A turn can bring the unit's casing onto a duct it keeps: a quarter turn makes the FDUM22 193 mm longer across its
  old face, so the loop above reaches it by about 10 mm. The design checks report the clash (`DU_CLASH`); the turn is
  not refused (as a move that makes a clash is not).
- Refrigerant pipes re-attach to the turned ports rather than turning with a block, and branch kits stay where they
  are; drains re-solve on release (the preview leaves them, as a move's does).
- Wall units refuse a turn (your decision 6); the toolbox has no wall unit, so this is checked by the unit tests only.
- While an item is being placed, `R` still turns the item being placed and `Shift + R` steps it 15° (the placement's
  own keys), unlike `Shift + R` on a selection (90° anticlockwise).


## Each straight to size, and a turned unit's ducts re-designed (19–20 October 2026)

**The request:** change the size of each duct segment one by one (its length, width and depth); and when an indoor
unit is rotated, its ducts should take the optimum, efficient, technical and most economical path, with no need to
follow the path they had. Approved plan: `C:\Users\idang\.claude\plans\duct-dimensions-and-turn-redesign.md`.

**Your decisions (19 October 2026):** "yes do as i told you", so every recommended option:
1. Every run on a turned unit's collars is re-designed (drawn by Auto duct or by hand), except where a run is locked.
2. While a turn is dragged, the quick re-route is shown as the draft; the re-design comes on release.
3. Accessories the designer set are set again on the new design where a straight takes them, else listed.
4. The new design keeps the system's own sizing basis and fan speed, and the trunk's shape.
5. A length change is taken up elastically, every end kept.
6. The plan shows a temporary dimension on the straight being edited.

This changes the rotation's decision 1: a turned unit's re-aimed or re-routed runs are now the draft, kept only where
they are the better design.

### Phase 1: a straight of an exact length (93e5751)

A new segment edit, `leg-length`, sizes one straight (or a riser) of a run. The run is re-solved elastically with that
leg's length fixed (a hard row on its length unknown in `ductElasticMove`), so every end stays on what it is fixed to
(the collar, a take-off's wall, a terminal's spigot) and the change is taken up downstream first, by straights running
the same way and by flexible runouts; the vertices before the straight are held, so it grows at its far end. Take-offs
on it keep their place in the room; branches off a straight that moves follow its wall and keep their terminals, as in
a move. Refused, with the reason and what would do instead, where nothing can give ("Straight 2 cannot be 2000 mm: the
run to D3 is held at its collar and D3's spigot, and no other straight can give way: move D3, or change a straight
that runs the same way."), and for a flexible runout (its own length edit), under 50 mm, or a locked run.

### Phase 2: length, width and depth, one straight at a time (af1f606)

- **The card.** A straight's card (plan or 3D) opens on one Dimensions block: Length (centreline, corner to corner; a
  riser's Height), then its section, rectangular or round, width × depth (or diameter), for this straight or every
  straight of its size. A typed length is previewed on the drawing with what it changes (velocity, pressure, mass) and
  made with Enter or Apply: one undo step.
- **The plan's dimension.** The pinned straight shows its length as a temporary dimension, on the side away from the
  rest of its run and clear of the segment's tag. Click the figure, type, Enter (Esc leaves it); a length it cannot take
  says why, in place.
- **Properties** lists each straight's length beside its section (L … W × D); the section's second size is called
  depth, as the trade does.

### Phase 3: a turned unit's ducts re-designed

After a turn is stored (`R` / `Shift + R`, the Properties panel, the plan's grip, the 3D ring), the Auto duct optimiser
designs each turned ducted unit's ducts afresh for its new collars, in its worker (about 2 s for three diffusers), and
the better of its design and the turn's own re-route is kept (`duct/ductTurnRedesign.ts`,
`move/turnRedesignController.ts`).

- **Which systems.** Every run on a turned unit's collars and its whole branch tree. Left as the turn made them: a
  system with a locked run (the status says so), a system whose unit and every terminal turned together (it turned
  whole, its layout holds), and a system that serves no terminal yet. A run left ending open with nothing taken off it
  serves nothing: a new design leaves it out and says so.
- **The request** keeps what was chosen for the system: the terminals it serves and their airflows, its services, its
  constant-friction basis where it was sized so (else the life-cycle optimum), its fan speed and an airflow typed in,
  and its trunk's shape. Where the trunk's shape gives no clean design at the turned collar, the optimiser also chooses
  the shapes freely, and the better of its two designs is taken (and said: "the optimiser chose the shapes (no clean
  round layout fits the turned collar)").
- **The better of two.** The design is applied only where it is better than the turn's own re-route. Both are
  appraised as the canvas checks them (each plan's and support's rules and the clashes, `validateDuctRuns`) and priced
  alike (first cost by `priceDuctPlans` with the hangers, the index path's pressure measured by `sizeDuctSystem` in
  `measure` mode, and the fan's energy over the system's life at the optimiser's own price per pascal). Fewer errors
  win; as many, the lower life-cycle cost; a tie goes to the design. The optimiser's own error count is not trusted for
  this: it can miss what the planner finds.
- **What the status says.** Taken: "DU-1's ducts re-designed for the turn by the optimiser: 12.5 m of duct (was 6.5 m),
  2 elbows (was 4), 22 Pa for the fan, first cost USD 695; the turn's re-route would break 2 fittings in walls, 3
  runouts bent too tight, a flexible runout through a wall, 6 clashes, an accessory on a fitting." Kept: "DU-1's ducts
  keep the turn's re-route: the optimiser's best design breaks 3 runouts bent too tight, 2 straights too short for
  their fittings, …; the turn's re-route breaks fewer (3 runouts bent too tight, 2 clashes)", or, both clean, "… the turn's
  re-route costs USD … less over its life than the optimiser's best design".
- **Accessories** are set again on the design by where they were along the air's path: one on the run off the collar
  (an attenuator, a door to the coil: all the air passes it) on the new run off the collar at the same distance from
  the collar; one on a branch to a terminal (a balancing damper) on the new run to that terminal, the same distance
  before its end; one on a run between, on the nearest run at the same distance from the collar. Where the new run off
  the collar has no clear straight for it (a plenum or a split close to the collar), it goes on the nearest clear
  straight and the status says where ("The run off the collar has no clear straight for the access door: it is set on
  the duct to SAD-1 instead."); where no straight takes it, it is listed to add again.
- **One undo.** The design is committed as Auto duct's Apply commits one (the old runs out, the new ones with their
  sizing records, the spigots it turns, its terminals in the unit's air system) and joined to the turn's own undo step
  (`amendLastHistoryEntry`: "Rotate DU-1 90° clockwise, ducts re-designed"). One undo takes back the turn and its
  design; redo makes both.
- **While it works** a badge at the top of the drawing says "Optimising DU-1's ducts for the turn…" with "Keep the
  re-route" (Esc does the same). A newer turn supersedes it; a change meanwhile to anything the design replaces or
  serves, or a newer undo step, leaves the turn as it was stored ("The drawing changed while the ducts were being
  re-designed: …"); Auto duct's card generating meanwhile takes the worker, and the turn keeps its re-route.
- **While a turn is dragged** the readout adds "On release the optimiser looks for a better design of DU-1's ducts for
  the new collar." (or says a locked run keeps them).

### Verified

- Unit tests: `ductTurnRedesign` 17 (the systems a turn hands over, with their requests; turned whole, no ducts, a
  terminal alone; a locked run; a drawn main and branch; the design at 90°, 180°, −90° and 45°, every terminal served
  from the turned collar, the choice never the worse of the two; in open space the design taken at 45° (the re-route
  clashes) and the re-route kept at 90° (clean, and cheaper over its life); a drawn system re-designed; a door on
  the collar run set again on the new one; a damper on a branch set again before its terminal; the attempts; the
  appraisal, the wording and the choice; a run's plan following the terminal it ends on), `turnRedesignController` 5
  (one undo step for the turn and the design, with the status; the re-route kept and the turn left one step; a change
  meanwhile; Esc; the readout). Full suite 270 files / 2349 tests.
- On canvas (`redesign-p3`, an FDUM22 in a 6.5 × 4.7 m walled room, three square Ø200 diffusers, Auto duct applied,
  an access door on the collar run from its card; real keys, clicks and drags), restoring the project exactly:
  `R` 90° and the Iso ring 90° take the design (5 errors against the re-route's 6), the 180° button takes it (none
  against 13), the grip to 45° keeps the re-route (5 against the design's 9); each with the badge while the optimiser
  works, the runs attached, the status saying which and why, never more errors than the re-route, and one undo for the
  turn and its design; Esc keeps the re-route at once.
- Regressions, each restoring the project exactly: `rotate-p1` 41/41 (now waiting for the optimiser after each turn and
  checking it never leaves more errors than the re-route: with two diffusers `R` took the design, the re-route would
  clash; a second `R` took a clean one USD 408 cheaper over its life, 0 elbows where the re-route had 5; the 180°
  button kept the clean re-route over a design with a tight runout and a clash), `rotate-p2` 32/32, `rotate-p3` 16/16,
  `rotate-p4` 17/17, `dims-p2` 23/23, `move-p1` 24/24, `air-p1` 25/25 (Auto duct's Apply, now sharing the terminal
  updates), `duct-seg-p5` 14/14 (accessories from the card).

### Found while verifying, fixed

- **The optimiser's design could be worse than the re-route.** The first canvas run applied every design: in the
  walled room at 90° the design had runouts bent to 2 mm radius, a straight too short and clashes where the re-route
  had two clashes; at 45° a flexible runout through a wall. The optimiser returns the best of what it found even when
  everything it found breaks rules, so the re-design now takes it only where it is the better of the two (above).
- **A run's cached plan ignored the terminal it ends on.** `getDuctRunPlan` memoised plans on the run, its unit, its
  parent and its branches, not on the terminal or unit its end is on: a terminal's spigot turned with the run object
  unchanged returned the plan made against the old spigot (a runout "bent at 50 mm radius" that a fresh plan does not
  have). The end's terminal (or unit) is now one of the plan's dependencies.
- **Auto duct's Apply and the re-design share the terminal updates** (`autoDuctTerminalUpdates`: the spigots a
  design turns, carrying the airflows it sets).

### Known limits

- **Off the room's axes.** The optimiser designs in the turned collar's own frame: at 45° the room's walls and the
  terminals become diagonal boxes in that frame, so it rarely finds a clean design in a walled room ("Equipment stands
  810 mm in front of the collar…"), and its ducts run at 45° to the room. The turn's re-route, which leaves on a stub
  squared to the room, is usually kept there.
- **Tight rooms.** Where the turned collar faces a nearby diffuser or wall, the optimiser often finds nothing clean
  either; the turn keeps whichever of the two breaks fewer rules, and says what each breaks.
- **The trunk's shape** is read from the trunk: Auto duct's Rect / Round / Optimal choice is not recorded with a
  system, so a system Auto duct made round under Optimal is re-designed round first (then freely, where that is not
  clean).
- The appraisal runs on the main thread after the worker returns (about 0.1–0.5 s per design for a few systems).
- A system with a locked run keeps the turn's re-route whole (a locked run is not re-designed, and its branches hang
  from it).
- A hand-drawn system is checked by the unit tests only: the duct tool cannot be driven to end a run on a diffuser by
  script.

## Sizing a straight by dragging (20 October 2026)

**The request:** adjust each segment's size graphically, by dragging, instead of typing the amount. Approved plan:
`C:\Users\idang\.claude\plans\duct-segment-drag-resize.md`.

**Your decisions (20 October 2026):** "yes", so every recommended option:
1. The grips show on the straight whose card is pinned (one click), so one straight at a time carries them.
2. Both ends drag: the far end grows the straight downstream, the near end upstream (the run before it gives way).
3. Width grows on both faces about the centreline; depth grows upward, the bottom (its level) kept.
4. Sections snap to 50 mm (a round duct to the stocked diameters), lengths to 10 mm; Alt drags by 1 mm; a typed number
   is exact.
5. Hard rules stop the drag at the last size they allow and say why; advisories (velocity, aspect) show amber.
6. Depth on the plan is scrubbed on the card (the depth grip is in the 3D views).
7. Shift while dragging a side or the top gives the new section to every straight of the run of the same size.

### Phase 1: the resize model (65e8e17)

`move/ductResize.ts`. `ductResizeGrips(scene, settings, runId, key)` gives a straight's grips: its two ends (its length),
its two sides (its width; each moves the value twice its own travel, both faces moving), its top (its depth), a
riser's two ends (its height) and a flexible runout's start (its length). An end grip is offered only where a trial
edit either way is made: the collar, a take-off's wall and a terminal's spigot hold their ends, and a straight's near
end moves only where a straight before it runs the same way to take the change up.

A value is snapped (`snapResizeValue`) or typed, and made by the card's own edits (`leg-length`, `leg-section`,
`runout-length`). `leg-length` gains `grow: 'start'`, which holds the straight's far end exactly so the change goes
upstream or is refused.

`DuctResizeSolver` keeps what it has planned (a drag stepping on costs one edit a step). A value the rules do not
allow stops at the nearest one they do, found by halving on the grip's grid. The rules:
- the edit is refused;
- a planner or support error the run did not have before;
- a clash it would make (`findDuctClashes`, against the clashes the drawing already had);
- the duct's top through the soffit.

The readout quotes the rule just past the stop ("Straight 2 stops at 1,290 mm: the runout bends at 197 mm radius,
under one diameter (200 mm, SMACNA S3.24)"). Its plan is a move plan with a `resize` outcome, so the move session's
resize mode (`beginResize`) previews it in every layer, reads it out, takes a typed number and Esc, and stores it as
one undo step.

### Phase 2: the plan's grips (16c9ece)

`DuctResizeGrips` draws the pinned straight's grips over the plan's layers (z 14), screen-sized:
- a capsule with a double arrow at each end that can move;
- a pill on each side, at least 14 px off the centreline on a narrow duct.

**Pointer:**
- The cursor follows the straight's angle.
- A press starts the resize mode. While dragging:
  - the grip rides on the duct as it will be;
  - a dimension shows the length (beside it) or the width (across it) it is taking;
  - the readout at the cursor says "Straight 2 · length 1,492 → 1,790 mm", the segment's velocity and friction, the
    fan's index pressure from and to, and "Shift: every 250×250 straight of the run".

**Keyboard:** each grip is a slider. Focused, ↑ / ↓ step it (Shift: five steps; Alt: 1 mm; a round duct: the next
stocked size), one undo each.

**Around it:**
- The run's own move and end handles step aside on that straight.
- Its card keeps clear of the grips (the card's anchor is inflated round the straight's vertices).
- Every card fades while a drag runs; the cards set their own visibility, so the layer fades by opacity.

### Phase 3: the 3D views' grips (edca6ca)

`DuctResizeGrips3D` projects the same grips, the top's included, from the model each frame the camera moves. A grip
drags along its own axis: the camera's ray is held to it by the move gizmo's axis constraint (`beginDrag` /
`updateDrag`). A grip seen end-on (under 4 px per 100 mm on screen) is not offered: in Front or Side, a straight
running away from the camera has no side grips. The dimension is drawn on the duct, and the card keeps clear of the
projected grips.

### Phase 4: the card's fields scrub

On a straight's card:
- **The Length label scrubs** (10 mm a step, 6 px a step; Shift five steps; Alt 1 mm a pixel).
- **The section's fields carry W, D and Ø labels** that scrub at 50 mm a step.

While the pointer is on a field, the drawing follows its value as it changes (typed, stepped or scrubbed). Releasing a
scrub applies the value once it has rendered (one undo step); ↑ / ↓ still step a field. This is how a depth is
dragged on the plan, where a duct's depth cannot be seen.

### Verified

- **Unit tests:** `ductResize` 14:
  - the grips of a collar straight and of a middle straight of a Z, and the runout's;
  - snapping;
  - both ends (the near end with the straight before it giving way);
  - width, and Shift for every straight of the size;
  - one straight made deeper stopped by its transitions, and every straight of the size stopped by the soffit;
  - the 50 mm minimum;
  - the session's drag, typed value, Esc and a click.
- **Full suite:** 271 files / 2,363 tests.
- **On canvas** (an FDUM22, two square Ø200 diffusers, Auto duct applied), each restoring the project exactly:
  - `resize-p2` 26/26 on the plan: the grips; the far end +300 mm with its readout, dimension and the card aside; a
    side +50 mm (100 mm wider); Shift narrowing every 250×250 straight; a typed 1,948 mm; Esc; a drag stopped at
    1,290 mm by the runout's bend radius; the arrow key.
  - `resize-p3` 18/18 in 3D:
    - Iso: the top up 100 mm with its bottom kept, the far end +300 mm, a side +50 mm, Esc;
    - Side: the side grips seen end-on not offered, the top up 50 mm.
  - `resize-p4` 10/10 on the card: the Length label scrubbed +100 mm onto the grid with the drawing previewing it,
    W scrubbed two steps, and W with Shift.
- **Regressions,** each restoring the project exactly: `dims-p2` 23/23, `duct-seg-p4` 16/16, `duct-seg-p5` 14/14,
  `move-p1` 24/24, `rotate-p2` 32/32.

### Found while verifying, fixed

- **A pinned straight's card covered its far-end grip.** The card is placed to clear its piece, and the grip sits on the
  corner vertex beyond it. An anchor can now carry an `avoid` region (the straight's vertices and grips with 18 px
  round them) that the card keeps clear of. Its tag still names the piece itself: widening the whole anchor had pushed
  the tag onto the plan's length figure (`dims-p2`'s check caught it).
- **A width grip at a low zoom.** A 250 mm duct is about 9 px wide at 100 %, so a 50 mm drag is under the 4 px that
  makes a press a drag. Side grips sit at least 14 px off the centreline; the drivers size a straight zoomed in, as a
  designer would.
- **Cards over the preview.** The pinned card stayed over the duct being dragged. Cards fade while a drag runs (by
  opacity: a placed card sets its own visibility).
- **What Enter does.** A typed resize said "Enter moves it"; it says "Enter sets it".

### Known limits

- **Front and Side picking.** A straight behind the unit or a diffuser in Front or Side cannot be clicked there to pin
  it. Pin it in Iso, or from the plan.
- **No near-end grip on most Auto layouts.** The straight before rarely runs the same way, so the near end cannot
  move.
- **Missing figures.** The readout's air figures appear where the card's own figures do; some straights of a
  generated trunk have none (the system model has no losses for them).
- **The card's own Apply** (typed or scrubbed) keeps its existing checks; the drag's hard-rule stop applies to the grips.

## Six duct fixes: smooth turns, design after a turn, sliding pieces, top collars, technical Ys, the system's shape (21–22 October 2026)

**The request:**
- Turning and moving diffusers by dragging felt slippery and not smooth.
- The whole duct system should be rectangular or round, as chosen, and designed by constant friction onto common
  fabrication sizes (technical and economical).
- A diffuser's collar should go on its top or on its side, as the designer chooses.
- Y branches should follow the sizes going in and coming out.
- A duct's small pieces (take-off collars, square-to-rounds, reducers and the like) should move and be edited on their
  own.
- When an indoor unit is rotated, its ducts should not swing about while it turns: turn first, then design the ducts
  again.

Approved plan: `C:\Users\idang\.claude\plans\duct-six-issues.md`.

**Your decisions (21 October 2026):** "yes", so every recommended option:
1. Turning: free, with magnetic stops at 45° steps and the walls' angles; Shift for 15° steps; Alt with no stops.
2. Moving: guides and grid both magnetic (they catch within about 5 px); tidy rounding you cannot see; Alt with no
   snapping.
3. While a unit turns, its ducts and duct accessories wait, faded; refrigerant pipes still follow their ports live.
4. What slides: take-off collars, reducers and square-to-rounds, volume dampers, access doors and attenuators. Fire
   dampers stay in their walls, and a take-off's own damper stays at its collar.
5. A piece is picked up by clicking it (its card pins), then dragging its slide handle, as with a straight's grips.
6. The collar entry is chosen per terminal (Properties and its card), on the Auto duct card ("Diffuser collars"), and as
   a project default for new terminals.
7. A top collar that does not fit the void is reported as an error with the numbers and the fix; Auto keeps your
   choice.
8. A rectangular Y's splitter sits at the airflow ratio, the legs then transitioning to their outgoing sizes inside the
   fitting.
9. Shapes: Rectangular · Round · Rect main + round branches · Optimiser's choice.
10. A rectangular branch meets its diffuser with a square-to-round to the neck, its balancing damper, then a flexible
    runout (≤ 1.5 m).
11. Constant friction is the default, at the project's friction rates and velocity limits, onto the fabrication steps;
    the life-cycle optimum stays as an option.
12. The trunk takes the cheapest standard height that fits the void, kept through the trunk.

### Phase 1: smooth turning and moving (ff3e9c1)

What is dragged stays under the pointer; a snap catches only near its line and never turns the drag into steps.

**Moves:**
- Guides and the grid catch within 4 px and hold to 6 px (the grid within an eighth of its step on screen, held to a
  fifth).
- Between them, the grabbed centre lands on a tidy millimetre under a pixel: 10, 5 or 1 mm by zoom.
- Guides align a centre with a centre and an edge with the same edge, not an edge with the far one.
- Alt: whole millimetres, no snapping.

**Turns:**
- The orientation follows the pointer to 0.5°, with magnetic stops at multiples of 45° and at the walls' squares (5 px
  catch, 9 px hold at the pointer).
- Shift turns in 15° steps, Alt freely; near the pivot the turn holds.
- A drag starts free, even from a stop or a grid line: the magnets come on past their release distance.
- A square face's spigot keeps its side until a turn is 10° past the diagonal. The drag passes the sides it showed back
  to the model, so a new side holds back to 35°: the spigot no longer swings at 45°.
- The readout names the turn from its first degree and says which stop holds ("at 45°", "square to the wall"); the
  protractor marks the stops.
- 3D drags and the gizmo ring measure the catch distances in pixels on their own surface.

### Phase 2: turn the unit, then design its ducts (c455a3c)

While a unit's turn is dragged, its ducts and their accessories stay where they are, drawn faint, and nothing re-routed
is drawn. The ducts no longer swing about, and a large unit's turn no longer costs a duct re-route every frame.

On release the turn is stored and the optimiser designs the unit's ducts for the new collar (against the plain
re-route, as before). The runs stay faint under "Designing DU-1's ducts for the new collar…" until the design lands,
then are drawn solid. It is one undo step for all of it.

- **Which runs wait:** `ductsAwaitingTurn` (`ductNetworkMove`) lists the runs of every system whose unit turns without
  the whole system. A system turned whole still turns rigidly, live; a diffuser turned alone keeps its runout
  following.
- **The 3D views** draw the same runs faint (transparent copies of their materials) and freeze them: they are not
  re-drawn against the turned unit.
- **The readout while turning:** "On release, DU-1's ducts are designed for the new collar."

### Phase 3: slide the small pieces along a duct (6879fa2)

Pin one of these with one click, and a slide grip sits on it, on the plan and in the 3D views:
- a take-off collar;
- a reducer or square-to-round;
- a volume damper, an access door or an attenuator.

Dragged, it moves along its duct:
- 10 mm steps, Alt 1 mm, with a magnetic stop at the middle of its clear straight;
- a typed number is exact, and the arrow keys step it when it is focused;
- the readout says where it is ("The take-off to SAD-1 · along the main: 1,500 → 1,200 mm"), with a dimension from
  where its place is measured;
- one undo step each.

**It moves continuously.** It stops at the first place the rules refuse on its way (a fitting, a take-off, a wall, its
branch's runout) and the readout says why. It never jumps an obstacle to a clear place beyond.

**A transition** (`transition-move`) slides along its level straight. A vertex is added where it leaves an elbow or the
collar, and dropped where it comes back. Take-offs, accessories and node choices keep their places, its taper goes
with it, and its card follows its new key.

**A take-off's branch follows.** Where its slid stub would bend the runout too tight, the terminal's spigot turns to meet
it (as Auto duct chooses a side), or the runout is laid again with a new elbow toward its terminal. The solver also
checks the main the branch is taken off, where its take-off windows are planned.

**Accessories:** one dragged goes exactly where asked (the planner says what it would overlap); the card's typed place
still finds the nearest clear spot. The cards gain a transition's place (and length) field, and take-off and
accessory places scrub.

### Phase 4: a diffuser's collar on top or on its side (1b9e33c)

A terminal's plenum box takes its collar on a side or on its top (`spigotEntry`). A top collar's port is vertical:
- **A flexible runout** comes straight down into it for its lead, bending at a diameter or more.
- **A rigid runout** runs on to above the collar, turns down on an elbow and drops onto it. It is reduced on the level
  first, or takes a 45° offset for a short step across.
- **Where the void is too shallow,** the planner says so with the numbers (`DU_TOP_COLLAR_VOID`: the soffit, or the
  duct feeding it, is too low).

**Where it is set:**
- the terminal's Properties: a Side / Top toggle;
- a project default for new terminals (Systems → Ducts);
- Auto duct's "Diffuser collars: As set / Side / Top", written with the runs;
- the runout's card: a Collar Side / Top toggle in the terminal's block.

A collar moved off the top of a square box goes on the side its runout reaches cleanly (its own side first), and the
status names any rule the change now breaks. The plan draws a dashed circle on the box; 3D puts the collar on its roof.

**Moves:** a rigid runout its legs cannot stretch to is re-made onto the moved spigot (straight on, with a turn or with
an offset). A run left as it was still says why it cannot follow. The runout builders move to `ductRunouts.ts`.

### Phase 5: a Y divided in its airflow ratio (f63d035)

A rectangular Y now divides the flow as SMACNA Fig. 2-5 draws it:
- **The splitter** gives each leg its share of the main's width at the airflow ratio (the split end's `share`), so the
  air leaves both legs at the main's velocity. It sits off-centre when the flows differ.
- **Each leg** turns on its own radius elbow (R/W at least 1 on its own width).
- **A transition inside the fitting** takes each leg to its outlet's size (flat bottom, at the design taper).
- **A leg under 100 mm** is an error that names the bullhead tee with turning vanes.

**Losses** come from the fitting's own flow and area ratios, part by part: a sudden change where the air divides off the
designed share (nil at it), the leg's elbow on its own velocity, and its transition. The optimiser prices the same
fitting and lead, and no longer needs a Y's main as wide as its two outlets side by side.

**Who writes the share:** Auto duct, at the outlets' airflow ratio, and sizing a system by constant friction; the
outlets' runs follow their flanges. The split's card offers "Splitter at the airflow ratio" (on a Y drawn before it,
by its outlets' sizes when no airflow is known). Switching Y split / Y junction keeps the splitter.

**Drawing:** the plan and 3D draw each leg, its transition and the splitter. The card and the BOM say it in full:
"divided 56 / 44 % · legs 222×250 + 178×250 · to 250×200 + 200×200". A Y drawn before the splitter (no share) keeps
its geometry.

### Phase 6: the system's shape, sized by constant friction onto fabrication sizes (740b9cd)

**Four shapes** on the Auto duct card: Rectangular, Rect + round, Round, Optimal.

**Rectangular** is new: trunk and branches rectangular. Branches leave on 45° shoe take-offs or Y splits, each with its
balancing damper at the take-off. At each terminal a square-to-round takes the branch to the neck, then its flexible
runout.

*Not as decision 10 reads.* It put the damper between the square-to-round and the runout. It sits at the take-off
instead, as every Auto duct branch's damper does: practice keeps a balancing damper as far from its diffuser as it
can, so the noise of a part-closed damper is not at the outlet. Moving it means one more fitting in the straight
before the runout, which tight layouts do not have.
- The router, the sizing and the realiser lay a rectangular branch by the same rules. A take-off's reach on its branch
  is the main's half, the shoe's own collar, its damper and a lead; its last leg holds the square-to-round and its
  lead after that reach, or after the last bend's setback, neck and margin (`endLegNeedMm`, exactly the realiser's,
  with no floor).
- A rigid branch's take-off stays where the design put it: past the unit's connector and collar transition, within
  100 mm (its runout takes up that much).
- No round stubs, spin-ins or plenum branches are offered in this shape.

**Kept only where it is the design.** Auto duct designs Rectangular alongside Rect + round:
- Rectangular is kept where it is clean and costs at most 1.5 times Rect + round (`RECTANGULAR_COST_LIMIT`). Where its
  branches run straight to the terminals it costs 1.1–1.2 times; where they wind round to reach the spigots straight,
  2 to 2.5 times, with twice the duct or more.
- Otherwise Rect + round is designed, and the card says why on its own line:
  - "No clean layout rectangular throughout fits these terminals (each rectangular branch needs a straight for its
    square-to-round before its runout): designed with a rectangular main and round branches instead."
  - "Rectangular throughout would cost USD 1,140 here, 1.9 times a rectangular main with round branches (USD 600): its
    branches would wind round to reach the terminals' spigots straight. Designed with a rectangular main and round
    branches instead."

In the project's 6.45 × 4.65 m room, the FDUM22 with two diffusers 2.3 m out, either side, is rectangular throughout
(USD 400, 5.3 m: a 350 × 150 trunk, one shoe take-off, one elbow). Four diffusers in a row there, or a 2 × 2 grid,
fall back: the 674 × 164 collar needs about 1 m of transition before the first take-off, and the room's depth leaves no
straight for four square-to-rounds.

**No route through the unit.** The routing graph had left the unit's own casing out of its obstacles, and trees ran
along its face and through it. The casing is now an obstacle like any other.

**The system remembers its shape.** It is written in the system's sizing record (`initialSizing.shape`). A re-design
after a turn asks for the same shape; a system designed before the shape was kept is read off its trunk.

**"Re-design as…" on the unit's card.** The card says "Ducts: Rectangular" and offers the other three shapes. One click:
- the optimiser designs the system again in that shape, in its worker, as the system was set: its terminals, airflows,
  services, sizing basis and fan speed;
- while it works, the card says "Re-designing DU-1's ducts as round…" with Cancel;
- the result is one undo step;
- the status says what changed, each figure against what it was: "DU-1's ducts re-designed as round: 4.0 m of duct
  (was 5.3 m), 2 elbows (was 1), 22 Pa for the fan (was 26 Pa), first cost USD 271 (was USD 400)."

A design that would break more rules than the ducts it replaces is not taken, and the status says which rules. A
change meanwhile to what it replaces or serves leaves the ducts as they are; so does a locked run ("unlock it to
re-design them").

**Constant friction is the default** (`autoSizingMethod`); the life-cycle optimum stays as an option. Each section is
sized at the friction rate for the air it carries, under its part's velocity limit, onto fabrication sizes:
- **Rectangular sides** go in steps of 25, 50 or 100 mm: a project setting, "Rectangular sizes in" (Systems → Ducts),
  default 50. The optimiser's grid, the router's take-off mains, the split sides and the cards' recommended sizes all
  use it.
- **Round** takes the stocked list.

**The economical trunk height.** The three cheapest routes are each sized again at every standard height that fits the
void (up to 600 mm), one height through the trunk with the width reducing. Each is verified and priced exactly as the
optimiser's own (sheet, fabrication, insulation, reducers, fittings, supports), and the cheapest is kept: fewer errors
first, then the lower first cost, a tie to fewer pieces. Heights are tried nearest the optimiser's own first. A height
whose sizes come out as one already priced is not verified again (the take-offs raise a low trunk to the same
sections). On the FDU280 test case, this took a route from 600×500 at USD 1,873 to 700×350 at USD 1,798, and that route
became the selected design.

**The fit at the collar.** Sizing by constant friction widens a take-off's first section toward the collar at the same
height, rather than ending in a transition steeper than the rules allow. A collar's own size is used only where it is
at least as tall as the section.

**The card's line** gives the basis and what came of it: "Constant friction 0.80 Pa/m · 600 m³/h · trunk 400×250 →
300×250 · 2 reducers · max 4.2 m/s". The trunk is the stretches carrying two terminals or more (not the run on to the
last one). The same line, measured on the ducts as drawn, heads the applied system's summary.

### Verified

- **Unit tests:**
  - `ductSystemShape` 17:
    - the settings and the step grid;
    - rectangular throughout on a roomy row (shoe take-offs, square-to-rounds, runouts, no planner errors);
    - the fallback on a tight row with its note, and the cost limit with its figures;
    - in the project's room: two diffusers rectangular throughout, nothing back past the unit's face; four in a row
      falling back;
    - the routing graph keeping out of the unit's casing;
    - the end-leg rule, exactly the realiser's;
    - the record keeping the shape, a turn re-design asking for it, the card reading it;
    - the re-design request and its refusals; a round re-design end to end (one command, no errors, the sentence);
    - the command applied as the store applies it; the phrases; the sizing line.
  - `highCapacityUnits` 4 (one new): the sizing line, and the economical trunk height. No other standard height that
    fits the void prices the FDU280's system lower, and the trunk keeps one height with its width reducing. Its time
    budget is raised to 60 s: under the full suite's load, the 20 s budget stopped the search early and kept another
    design.
  - `ductTopCollar` 17; `ductYSplit` 11.
- **Full suite:** 275 files / 2,445 tests (the benchmark gate's 43 cases run on their own).
- **Benchmark gate:** `DUCT_BENCHMARK=1` 43/43, before and after the routing graph took in the unit's casing.
- **On canvas,** each restoring the project exactly:
  - `smooth-p1` 24/24, `turn-p2` 15/15, `slide-p3` 31/31, `collar-p4` 28/28, `split-p5` 12/12;
  - `shape-p6` 32/32 in the project's room (the FDUM22, two square Ø200 diffusers 2.3 m out, 2.6 m either side):
    - Auto duct Rectangular: the four shapes, the card's sizing line, rectangular throughout applied (a 350 × 150
      trunk, a shoe take-off with its damper, a square-to-round and runout at each terminal), no errors, the shape
      kept;
    - the unit's card: "Ducts Rectangular", Re-design as Round (busy with Cancel, the status's figures, round
      throughout, one undo back exactly), Cancel at once (nothing changes, and it says so), Re-design as Rect + round;
    - the applied system's measured line;
    - 100 mm steps;
    - four diffusers in the row: the fallback said on its own line, kept when another design is picked.
- **Regressions** on the final code, each restoring the project exactly: `unit-panel` 34/34, `air-p1` 25/25,
  `redesign-p3` 46/46, `collar-p4` 28/28, `duct-seg-p3` 29/29, `duct-seg-p4` 16/16, `duct-seg-p5` 14/14, `dims-p2`
  23/23, `resize-p2` 26/26, `slide-p3` 31/31, `move-p1` 24/24, `move-p2` 33/33, `rotate-p2` 32/32, `turn-p2` 15/15,
  `smooth-p1` 24/24, `split-p5` 12/12, `unit-high-capacity` 20/20.
- **Driver note:** the shape radio once named "Rect" is now "Rect + round". A driver picks it with `exact: true`;
  "Rect" alone matches "Rectangular" too.

### Found while verifying, fixed

- **Guides held the drag.** Pairing every guide with every edge held a moving diffuser on some guide in 76 % of frames.
  Guides now pair a centre with a centre and an edge with the same edge, per axis.
- **A turned unit's runs re-drawn solid.** In 3D, the preview re-drew the waiting runs against the turned unit; they are
  frozen until the design lands.
- **A run that could not follow said nothing.** A move left a run as it was without the reason ("can no longer reach
  it"); the reason is now reported for unchanged runs too.
- **Collar options did not show.** Options in the card's terminal block need chips (that block has no tab).
- **Constant friction made a plenum design fail.** A take-off's first section ended in a 152° transition at a wider,
  shorter collar. Constant friction now widens toward the collar at the same height, and takes the collar's size only
  where it is as tall.
- **Rectangular gave spin-ins and stubs.** The all-flexible seed trees and the router's stubs came through in the
  rectangular shape. They are filtered out, and the leaf straight rule and the DP's end rule make room for the
  square-to-round.
- **The split's side width was off the step.** Auto duct's split-trunk layout sized its sides on the default 50 mm,
  whatever the step setting; it now uses the setting.
- **Trunk heights priced twice.** Low heights that the take-offs raise to the same sections were each verified, and the
  cap of eight could stop short of the tall heights in a deep void. Identical sizings are verified once, nearest the
  optimiser's own height first.
- **Rectangular failed in the project's own room.** The driver's first layout did not fit the 6.45 m room, and the
  layouts that did all came out with clashes. Three stages disagreed about a rectangular branch:
  - the router asked 625 mm before its runout where the realiser needs about 960 mm;
  - the sizing used a 100 mm collar where a shoe's is 152 mm or more;
  - the realiser moved take-offs off the collar transition by up to 370 mm, so a rigid branch's runout bent too tight.

  Only contorted trees survived (trunks doubling back past the unit). The rules are now aligned (above), the casing is
  an obstacle, and the cost limit keeps a design that still winds round from being shown as rectangular.
- **The fallback was buried.** The card listed "designed with a rectangular main and round branches instead" among its
  collapsed notes, below the chart. It now opens the result, under the card's buttons. It also stays when another
  design is picked on the chart (it had been dropped with the issues of the design first shown).
- **A take-off stopped the collar's transition.** Sizing by constant friction (the fit at the collar, above) treated
  a run's first take-off as fixed, so in the unit panel a main velocity the main already met widened it to 300 × 300.
  The rule now looks only at what stays put (elbows, walls, the run's end); take-offs are placed past the transition.
- **A reserved collar straight, tried and taken out.** Keeping every route off the straight in front of the collar
  removed the take-offs the router places there (the realiser moves them past the transition; a flexible stub takes
  that up), and contorted the designs of the unit panel's layout. The casing alone is kept.
- **A take-off slid back stops sooner.** With constant friction the default, the slide driver's trunk is narrower and its
  collar transition longer: a take-off dragged 300 mm back stops after 130 mm, the readout saying it would overlap the
  transition. That is right; the driver's check now accepts any stop the readout explains, and its 3D drag stays within
  the room.
- **The sizing line called a square-to-round a reducer.** On a trunk running on to its last terminal, the line read
  "trunk 250×250 → Ø200 · 1 reducer". It now gives the trunk's own stretches.

### Known limits

- **Rectangular throughout needs room.** Each rectangular branch needs a straight for its square-to-round before the
  runout, and the router cannot take two branches off at one station (a cross). In tight layouts Auto duct falls back
  to Rect + round and says so.
- **Rectangular takes twice as long** to design (Rect + round is designed alongside it for the comparison): a few
  seconds in the worker.
- **The trunk height is priced for the three cheapest routes,** at up to eight distinct sizings each; other routes keep
  the height the optimiser chose.
- **Re-design as…** designs the unit's whole system. Its accessories are set again where a straight takes them, else
  listed, as in a turn re-design.
- **Fitting losses** for the divided-flow Y are practice values built from its parts, not a certified table.
- **Front and Side** views cannot pin a take-off behind the unit to slide it; use Iso or the plan.
- **A run can cross itself (found here, not new).** Two diffusers 0.8 m either side of an FDUM22's axis, 1.6 m out:
  every layout the optimiser verifies winds round, and the one it keeps runs its trunk back over its own straight.
  The clash check does not compare a run's own pieces, so it counts as clean. The same design comes out at f63d035,
  before this work. It needs a self-crossing check in verification and a router that does not loop back; to be
  planned.

## A run that crosses itself, and diffusers close to the unit (22–23 October 2026)

**The request:** "yes do", then "yes": plan, then fix, the trunk found running back over itself while verifying the six
duct fixes. Approved plan: `C:\Users\idang\.claude\plans\duct-self-crossing-and-close-diffusers.md`.

**Your decisions (22 October 2026):** "yes", so every recommended option:
1. A run crossing itself is an error: Auto duct looks for another design, and the canvas flags drawn runs.
2. The plenum places its spigots for clean runouts and turns the diffusers' collars to suit.
3. A design that still winds round gets a note on the Auto duct card (a branch over 3 times the straight distance),
   with what would help.

**What was found.** In the project's room (the FDUM22, two square Ø200 diffusers 1.6 m out, 0.8 m either side), every
shape kept a design counted clean that no designer would draw:
- Rect + round ran its trunk 2.3 m out, back down beside itself, across its own first straight at the collar, and up
  the axis to D1 (USD 537).
- Round and Optimal looped each branch of a wye round the far side of its diffuser: about 4 m of duct to reach
  diffusers about 1 m away (USD 407).

The same designs came out at `f63d035`, before the six fixes. Two causes:
- The clash check compared a run with other runs, terminals, equipment and pipes, never with its own pieces.
- The router joins a run's path from parts it solves separately; nothing stops a later part from running back over
  an earlier one.

### Phase 1: a run crossing itself is a clash (b206bf0)

`findDuctClashes` compares each run's pieces with its own pieces further along. It leaves out the piece each is joined
to, and a piece's own boxes never meet (a runout's curve is the bend check's).
- **Reported as** kind `self`, with both marks: "S-004 crosses R-01 of its own run." On the canvas: "Supply duct: S-004
  crosses R-01 of the same run at (x, y, z)", with "Re-route the run so it does not double back over itself, or change
  the level of one stretch." Auto duct's verification and the sizing report share one message (`clashMessage`).
- **In Auto duct** the error feeds the router's cuts like any clash, so the router steers off the crossing; where
  nothing clean is left, the least bad design shows the error with the optimiser's reasons.
- **A unit turned 45°:** its quick re-route also runs back over itself, so the reason the optimiser's design is taken
  reads "would break 2 clashes" (the turn tests now assert the crossing).

Over 64 designs (the benchmark's rows, lines and grids, collars dropped and turned to the unit, in Optimal and Rect +
round), one other crossed itself: a row of three with collars turned to the unit, in Rect + round.

### Phase 2: the plenum's spigots (935580e)

The plenum on the collar put each spigot as near its diffuser as the face allowed, scored only against the diffuser's
current collar side. It now tries, for each diffuser:
- each face (end, left, right);
- each place along it, every 25 mm, clear of the face's other spigot;
- each of the diffuser's collar sides with room in front.

Each runout is scored as the planner draws it: the shortest clean one wins; where none is clean, the nearest to clean
(how far its bend falls short of one diameter), then the nearest to the diffuser's front. The chosen collar side is
turned as Auto duct turns collars.

Close two-diffuser layouts in the project's room now get a clean plenum: 2.3 m out at ±0.8 m or ±1.2 m, and 1.6 m out at
±1.5 m. At 1.6 m out, ±0.8 m, Rect + round keeps the plenum (USD 245, 1.4 m of rigid duct, no elbows) with one runout
bending at 173 mm, where the rule is 200 mm (see Known limits).

### Phase 3: a note where the design winds round (935580e)

`ductAutoWinding.ts`: for each terminal of the kept design, the duct from the unit's collar (along the trunk, through
each take-off, split or spigot, then its own run) against the straight distance from the collar's lip to its spigot.
Past 3 times, and 1.5 m longer (so a terminal right by the unit is not flagged for its runout), the Auto duct card
says so, naming it:

"D1: its duct runs 5.7 m to reach it, 3.8 times the 1.5 m straight from the collar (it winds round to come at its
collar straight). Moving it a little, or a top collar (its runout then comes down from above), may give a shorter
design."

Auto duct already tries each diffuser's side collars, so the note points at what it does not try: moving the
diffuser, or a top collar.

It is worked out when a design is selected, so it follows the design picked on the chart.

### Verified

- **Unit tests:**
  - `ductSelfClash` 7: a run doubling back, a run crossing itself, an offset, back-to-back elbows and a U-turn with
    room, the canvas message; and in the project's room, no shape keeping a crossing, the plenum in Rect + round, the
    winding named in Round and Optimal.
  - `ductAutoWinding` 2: a winding run named with its figures; a direct run and a terminal by the unit not.
  - `ductTurnRedesign`, `turnRedesignController`: the 45° re-route's own crossing.
- **HVAC and store suites:** 228 files / 2,092 tests. **Full suite:** 277 files / 2,454 tests.
- **Benchmark gate:** 43/43.
- **On canvas:** `selfcross-p4` 7/7 in the project's room, restoring it exactly:
  - a run drawn back across itself: the checks panel lists "Supply duct: S-003 crosses R-01 of the same run at (…)";
    one undo takes it away;
  - two diffusers 1.6 m out, ±0.8 m: Rect + round previews the plenum with a runout to each, nothing crossing itself;
  - Round: the card names both diffusers with the winding figures.
- **Regressions,** each restoring the project exactly: `unit-panel` 34/34, `dims-p2` 23/23, `resize-p2` 26/26,
  `move-p1` 24/24, `move-p2` 33/33, `redesign-p3` 45/45, `shape-p6` 32/32, `slide-p3` 31/31, `air-p1` 25/25,
  `collar-p4` 28/28, `duct-seg-p3` 29/29, `duct-seg-p4` 16/16, `duct-seg-p5` 14/14, `rotate-p2` 32/32, `turn-p2` 15/15,
  `smooth-p1` 24/24, `split-p5` 12/12, `unit-high-capacity` 20/20.

### Found while verifying

- **The plenum fix fell short in the room's own layout.** The plan expected spigots at about ±225 mm to give clean
  runouts. Measured, the runout curve bends tighter than that: clean only within about 115 mm of the axis, and two
  spigots must sit 250 mm apart. D1 now gets a clean runout and D2 one at 173 mm.
- **Six drivers stood on designs that crossed themselves or now get the plenum.**
  - The unit panel, dims, resize and both move drivers placed two diffusers at this very layout. They sized and
    dragged the looping trunk. They now place them to one side (2.3 m out, 1.5 m and 2.7 m across): a clean trunk
    that turns, with a take-off on its second straight.
  - The re-design driver's three diffusers (1.5 m out at ±1.6 m, and 2.35 m on the axis) had a trunk whose elbow
    E-03 ran back over the collar's connector C-01. It was counted clean before; it is now an error, and that layout
    has no clean design. The driver places a third diffuser by the two (1.3 m out, 2.7 m across) for a trunk with a
    long second straight for its access door.
  - In the new layout, `move-p1` nudges the unit away from its ducts (toward them, its take-off met a transition).
    `move-p2` types its 1,000 mm move on the nearer diffuser, toward the axis (the far one met the room's side wall).
    Their checks are otherwise unchanged.

### Known limits

- **The runout curve model** (closed 23 October 2026: see "Runouts bent as a fitter bends them" below). A runout
  was drawn as a Bézier curve, with a 100 mm straight lead at each end and handles 0.4 of its chord. For a 90° turn
  with unequal offsets, it bent tighter than the true arc a fitter makes: at 150 mm off the axis, 173 mm against an
  arc's 225 mm.
- **Opposed take-offs** (two spin-ins on opposite walls at one station) are refused by the planner ("two take-offs
  overlap"). At the room's spacing they would not help: the runout has about 100 mm to drop into the diffuser's side
  collar.
- **Lines of diffusers on the collar's axis** come out with 1–6 errors in Rect + round (Optimal is clean): a separate
  limit, seen in the survey.

## Runouts bent as a fitter bends them (23 October 2026)

**The request:** "yes do", then "yes": plan, then build, the runout curve change proposed after the self-crossing fix,
so that the two diffusers close to the FDUM22 in the project's room come out fully clean. Approved plan:
`C:\Users\idang\.claude\plans\duct-runout-arc-shape.md`.

**Your decisions (23 October 2026):** "yes", so the recommended options:
1. Each runout is the gentler of the new bend path and the earlier curve: none bends tighter than before.
2. Existing runouts redraw in the new shape. A runout's shape is worked out, not stored, so their checks run again.

### The shape (c6d4b6c)

`flexCurve` (`ductFlex.ts`) still runs the flex straight for 100 mm off each collar. Between the leads it now bends the
duct as a fitter does: straight, then arcs as large as the space allows, then straight.

| Runout | How it bends | Example | Before |
|---|---|---|---|
| A turn in one plane (the lead lines meet ahead of both leads) | One arc, as large as the shorter leg allows; the rest straight | Legs 300 and 800 mm: 300 mm | 223 mm |
| A top collar straight ahead of its duct | The same, in the vertical plane of the turn | 500 mm across, 200 mm down: 200 mm | 147 mm |
| Leads parallel, offset (an S) | Two equal arcs, each turning 2·atan(offset / run); past 90° each turns 90° with a straight across between | 300 mm across over 900 mm: 750 mm | 654 mm |
| A turn with a drop, a top collar off to one side | A bend off each lead with a straight between, sloping with the drop, placed for the largest radius (the shortest runout among bends as large) | Legs 250 and 250 mm, 200 mm drop: 214 mm | 176 mm |
| A spigot facing away (a turn over 90°, a U-turn) | The earlier curve, unchanged | | |

- **The search** (a turn with a drop): a grid over where the two bends sit, then a pattern search to 0.05 mm for the
  largest radius, then another for the shortest runout among bends as large (within 0.01%).
- **It never passes the spigot's face.** Every bend turns 90° at most, and the straight between two bends never heads
  back against either lead. So the runout heads on toward the spigot all the way, and never swings past it or into
  its terminal's box. A spigot facing away would need the runout to come round the back of the box: it keeps the
  earlier curve, flagged as before where that bends under one diameter (the fix is to turn the collar).
- **The earlier curve stays where it bends more gently:** one cubic Bézier between the leads, its handles 0.4 of the
  chord. On an equal bend, the shorter is kept.
- **The radius it reports** is the arcs' own. The drawn samples, 5° apart on an arc at most, bend no tighter.

**The cost, and a memory of runouts (b1549cb).** Bending a runout that turns and drops takes a search, so a fit costs
about twice the earlier curve, and Auto duct slowed by about a fifth. But Auto duct fits the same runout many times
over: a row of four diffusers asks for 18,000 fits, half of them repeats; a 2 × 3 grid 43,000, two thirds repeats.
`flexCurve` now keeps the last 4,096 runouts it worked out (by their ends, directions and options) and hands back the
same result, frozen so that no caller can change what another reads. Auto duct runs at least as fast as before: the
row of four in 3.8 s (3.9 s before), the grid in 20–22 s (23.5 s before); the survey below in 143 s (187 s before),
the benchmark in 299 s (327 s).

**Changed from the plan.** The plan drew a turn with a drop as the plan's arc, with the drop eased along it. Measured,
that bends tighter than the earlier curve once the drop is more than a little: legs 250 and 250 mm with a 200 mm drop
give 122 mm, against 176 mm. It would rarely have been kept. Two bends in tilted planes with a sloped straight between
bend more gently than the earlier curve in every case measured. They also cover a top collar off to one side, which the
plan had left to the earlier curve.

### What it changes

**The project's room** (the FDUM22, two square Ø200 diffusers 1.6 m out, 0.8 m either side). Every shape now keeps the
plenum on the collar, clean, at USD 245:
- Rect + round: the runout that bent at 173 mm bends at 225 mm.
- Round and Optimal: the plenum, where they took the wye that wound round both diffusers (USD 407); the winding note
  goes.

**The same designs, their runouts redrawn:** 64 designs (the benchmark's rows, lines and grids, two and three diffusers
close together, collars dropped and turned to the unit, in Optimal and Rect + round), and the room in each shape:
- no runout bends tighter;
- runout lengths (BOM): +1.1% at the median, +3.3% at most;
- bend losses: +15% in all (454 → 522 Pa over every design's runouts, at 300 m³/h), see below;
- `DU_FLEX_BEND` on the designs kept: 4 → 1 (over every design Auto duct showed: 23 → 16).

**The designs Auto duct now picks** (the same 64 and the room):
- **Errors:** 13 designs had errors. 8 are now clean: lines of 3, 4, 5 and 6 with collars dropped, in Rect + round
  (the last three cheaper too: USD 917 → 840, 1,106 → 939, 1,294 → 1,000); three close in a row turned to the unit, in
  both shapes; the pair 1.6 m out turned to the unit, and the room, in Rect + round. The other 5 keep the errors they
  had (lines on the collar's axis turned to the unit, and a pair 1.2 m out, in Rect + round); none has new ones.
- **First cost,** over the 54 designs clean before and after: 15 cheaper, 31 within USD 2, 8 dearer; −2.8% in all
  (USD 29,448 → 28,634). Cheaper: the room's Round and Optimal (USD 407 → 245), a row of 3 turned to the unit in
  Rect + round (714 → 574), a 2 × 3 grid in Optimal (613 → 555). Dearer: a row of 2 in Optimal (230 → 256, collars
  either way), a row of 3 dropped in Optimal (462 → 497), three close in a row dropped in Optimal (540 → 573), and four
  others by USD 6–13.

**Why a few are dearer.** Not because their runouts break anything. Redrawn with the new runouts, the earlier designs
are still clean (no errors, clashes or checks); Auto duct no longer reaches them.

Take the row of 2 (USD 230 before, 256 now):
- Before, the USD 230 design came from the router's second round. A failure in the first round steered it there: a
  fitting with no straight before its runout, which the router then cut.
- The new runouts shift the model's costs a little. The row is nearly mirror-symmetric, and the router's first tree is
  now the mirror image. That tree builds without the failure, so no cut is made and the second round never goes there.

The optimiser's search is that sensitive to small changes in its model. A follow-up could have it try each tree's
mirror image and its other sizes before settling.

**Bend losses rise where a runout is an S or drops while it turns.** The plan expected them to fall.
- **Why:** the loss model charges a bend by how far it turns: 0.84–0.87 velocity pressures per 90°, almost whatever the
  radius from 1 to 4 diameters (Thermaflex). The largest arcs make an S turn further at its middle: 37° each way
  against the earlier curve's 30°, for 300 mm across over 900 mm (74° of turning in all, against 60°).
- **Plain turns** come out a little lower: the same turn, with more of the arc's own friction taken off.
- **On a design:** under 1 Pa on its index path.

### Verified

- **Unit tests:**
  - `ductFlex` 16 (7 new): an unequal turn's single arc (each sample on the arc or the straight); an S's two equal arcs,
    point-symmetric about its middle; a top collar straight ahead, bent in its vertical plane; a turn with a drop that
    never climbs; a spigot facing away keeping the earlier curve; and a seeded sweep of 4,000 runouts against the
    earlier curve (a frozen copy of it): never tighter, on the collars and straight for the leads exactly, the radius
    the samples' own, no kink, never past the spigot's face, and runouts as drawn (turns to 90°, offsets, drops)
    within 5% of their length; and a top collar off to one side, the same length for collars a hair apart.
  - `ductSelfClash` 7: in the project's room every shape keeps the clean plenum, each runout at a diameter or more and
    no winding note; the facing pair still winds round in Round and Optimal, and the card names both.
  - `highCapacityUnits` 4: the FDU280's split trunk at its economical height.
  - `ductBranchReaim` 6 (1 new): a tee made a lateral with room for its runout keeps the bare stub; 1.6 m away the
    take-off slides back and an elbow turns the stub onto its old heading.
  - `ductTapSlide` 3: slid 1.2 m, the branch is laid again, its runout within the maximum length.
- **Full suite:** 277 files / 2,462 tests (the benchmark's 43 run on request, below).
- **Benchmark gate:** 43/43, in 299 s (327 s before the change).
- **On canvas:** `arc-p3` 16/16 in the project's room, restoring it exactly:
  - Auto duct in Round, Optimal and Rect + round previews the plenum on the collar with a runout to each diffuser, no
    error and no winding note on the card;
  - applied, the two runouts bend at 209 and 217 mm (one diameter is 200 mm), the drawn samples at exactly those
    radii, and the checks list no `DU_FLEX_BEND`. In plan each runs straight off the plenum's end face and turns one
    arc into its diffuser's side collar; in 3D the corrugated flex follows the same sweep. The other checks there are
    the plenum design's own, as before the change: no clear support position within 610 mm of each spigot stub's ends
    (warnings), the collar's aspect ratio and the plenum's cross-break (information);
  - each runout's card gives its length as the plan has it (0.68 m) and its pressure (friction 0.57 Pa, the bend
    3.44 Pa: "4.0 Pa");
  - one undo takes the design away.
- **Regressions,** each restoring the project exactly: `selfcross-p4` 9/9, `collar-p4` 28/28, `duct-seg-p3` 29/29,
  `duct-seg-p4` 16/16, `duct-seg-p5` 15/15, `unit-panel` 34/34, `dims-p2` 23/23, `resize-p2` 26/26, `move-p1` 24/24,
  `move-p2` 33/33, `redesign-p3` 46/46, `shape-p6` 32/32, `slide-p3` 31/31, `air-p1` 25/25, `rotate-p2` 32/32,
  `turn-p2` 15/15, `smooth-p1` 24/24, `split-p5` 12/12, `unit-high-capacity` 20/20.

### Found while building and verifying

- **A U-turn bent round passed the bend rule while doubling back round its own box.** A semicircle as wide as the gap
  was tried for opposed leads. The top-collar test caught it: a collar moved to the side facing away from its duct
  came out clean, its runout running over the box and back down into the spigot. A runout is not clash-checked
  against the terminal it serves, so nothing else would have caught it; the earlier curve bends tightly there, so it
  was always flagged. So no bend may turn past 90°, and a spigot facing away keeps the earlier curve (above).
- **The FDU280 with six Ø300 diffusers** now gets a split trunk (USD 1,635, life-cycle 2,158) where it took a
  reducing trunk (USD 1,798, life-cycle 2,356): with the gentler runouts its take-offs stay short. The test that its
  trunk is at the economical height took the trunk as the main from the collar only; it now takes every rectangular
  stretch carrying two terminals or more (the main, and a split's branches), as the sizing's trunk height does. The
  height still holds: no other standard height that fits the void is cheaper.
- **The largest bend was a plateau.** For a top collar off to one side, the drop fixes the largest radius while the
  two bends can still slide along their leads. The search stopped wherever it landed, so collars a hair apart got
  runouts from 1.38 m to 1.53 m long. In the project's room one came out over the 1.5 m maximum, and Auto duct laid that
  branch as a rigid detour that broke the leg rule (`collar-p4` on the canvas). The search now takes the shortest
  runout among bends as large as the largest (ccb60a5, d15a037): 1.37 m at a 325 mm bend every time there (the earlier
  curve: 1.37 m at 247 mm). A test holds five collars a hair apart to one length within 5 mm. "As large" was first
  within 0.5%: that let a take-off's runout that only just bent at one diameter slip under it, and a row of two
  diffusers came out at USD 276 (Rect + round 308); 0.01% keeps the plateau, which is flat to the millimetre, and not
  that.
- **A take-off slid along its main** has its runout branch repaired where the slide breaks a rule: its terminal's
  spigot turns to meet the runout, or the branch is laid again with a new elbow. Slid 1.2 m, a runout used to bend
  too tightly as well as run long, and the bend error set off the repair. Bent as a fitter bends it, it ran 1.69 m to
  the spigot with only a length warning, and was left so. The slide now also repairs a runout it leaves over the
  project's maximum length (where it was within it), and either repair keeps the runout within it: laid again, that
  runout is 1.34 m. Where the slide breaks a rule and only a long runout is left, the turned spigot is still taken.
- **A tee made a lateral** keeps the bare 45° stub where its runout has room to bend (1.8 m away: 1.25 m at a 306 mm
  bend), where it used to slide the take-off back and add an elbow. Re-aiming takes the cheapest candidate that breaks
  no rule, and the bare stub no longer breaks the bend rule. The slide-back-and-elbow case is now tested 1.6 m away.
- **Three segment-card drivers** (`duct-seg-p3`, `-p4`, `-p5`) generate a system for an FDUM22 and three diffusers
  1.5–1.9 m ahead of it, and check the cards of its main's take-offs and straights. Auto duct now serves those
  diffusers from a plenum on the collar (clean), so there is no main to check. The drivers place them 300 mm further
  ahead (the room's front wall allows no more), where it gives a round main with tee take-offs as before. There,
  `duct-seg-p5` lengthens its attenuator to a length its straight takes (the card rightly disables 1,200 mm on the new
  main's straight), and `duct-seg-p3`'s diffuser nudge stops at the room's edge after 374 mm (it asks 300 mm now).
  `duct-seg-p5` had crashed on that disabled length without counting a failure: it, `duct-seg-p3`, `-p4` and `air-p1`
  now count a crash as one.
- **The winding note's own check** used the room's pair, which no longer winds. It now uses a pair 1.2 m out, 0.9 m
  either side, with their spigots facing the unit: Round and Optimal still wind round there, and the card names both.
  The `selfcross-p4` driver does the same on the canvas.

### Known limits

- **A runout is not clash-checked against the terminal it serves.** That is why no bend turns past 90°: a spigot
  facing away keeps the earlier curve, and the bend check flags it where it is tight.
- **The optimiser's search** can miss a cheaper tree that a small change in its model no longer leads it to (above).

## What Auto route left out of the user's building, and why (23–24 October 2026)

**The request:** "see some of details are generated for some areas. it may be pipe, duct and etc. so please
investigate why this kind of issues can append and solve those issues very professional way", then "page was
refreshed. so can you analys the image and fix the issues instead of the json file", then "do according to your
recommendation". Approved plan: `C:\Users\idang\.claude\plans\auto-route-missing-services.md`.

**Your decisions (24 October 2026):** the recommended options:
1. Too few terminals: Auto route proposes them, dashed on the drawing, and adds them on request.
2. Apply while something cannot be routed: "Apply complete parts".
3. An outdoor unit too small for its system: a connection-ratio check, 50–130 % by default.

### The building

The drawing was not saved, so it was rebuilt from the two screenshots: walls and rooms measured off the plan
(43.457 mm a pixel), an FDU224KXZE1 in the top hall, FDUM140KXE6Fs bottom left and in the middle room, four FDT28KXZE1
cassettes in the east wing, an FDC280KXZE1 outside, one floor gully, and the Ø250 diffusers and grilles as drawn. The
app's own Auto route reproduces the screenshot exactly (the same parts missing, "short 84 mm" for the screenshot's 85).
It is a test fixture now (`hvac/__fixtures__/usersBuilding.ts`), run through Auto route on request:
`AUTO_ROUTE_BUILDING=1 npx vitest run src/components/canvas/hvac/autoRouteBuilding.test.ts` (about 9 minutes).

### Why parts were left out

| Missing | Cause | Fix |
|---|---|---|
| FDU224: no ducts | **Turned away from its terminals.** At rotation 0 its supply collar faces down the plan, the FDUM140's up; placed alike, both its diffusers were behind the supply collar and both grilles behind the return. The duct router's graph spans only what is ahead of a collar, so no terminal had a way in, and the message said only "No buildable layout". | Turn advice and button; the reason named; SA / RA marks in plan |
| FDU224: no ducts | **Far too few terminals:** 4,320 m³/h through two Ø250 diffusers is 12.2 m/s in each neck (limit 3 m/s). | Terminal advice; terminals proposed and added |
| Bottom left: return duct only | One diffuser for 1,920 m³/h (10.9 m/s). The unit was marked "Proposed" with its supply dropped in a note. | Designed as a whole; terminal advice |
| Middle: designed, noisy | Four Ø250 necks at 960 m³/h each (5.4 m/s), shown only as warnings. | Terminal advice (not refused) |
| NE cassette: no refrigerant | All three starts of the network search laid the main past it (the ducts shaped them): every branch-kit position near it was too close, clashed, or lacked straight for the level change. | One more start from each unit left out |
| FDU224: no drain ("short 85 mm") | A gravity drain (no pump built in, MHI KX-T-222) about 24 m from the only gully: about 240 mm of fall needed, about 160 mm in the void. | The shortfall explained; a pump offered in one click |
| Bottom left: no drain | The drain router searched only 1.5 m round the unit and the gully; the middle room's ducts sealed that box. | The search widens when it finds nothing |
| Nothing could be applied | Any failure blocked everything, even "Apply N designed units". | Apply complete parts |

Also found: a drain passing through another's pump riser (once the NE cassette was on refrigerant), the outdoor unit
at 220 % (61.6 kW of indoor units on 28 kW), and the drain router taking minutes round refrigerant.

### Ducts

- **Designed as a whole (5377f54).** A service whose terminals have no layout keeps the unit as it is: "No supply
  layout, so its return layout is not applied on its own: the unit is left as it is." A busy or missing collar still
  lets the other service be designed.
- **Why no layout (d8d3d49).** The routing graph reports, per terminal, the runout positions tried and how many lay
  behind the collar. "No buildable layout for these terminals" now names the cause, the most actionable first: terminals
  behind the collar; too much air through each neck (over 1.5 times its limit); terminals no runout reaches; else what
  failed most often across the trees. The FDU224: "… SAD-1 and SAD-2 are behind the supply collar; too much air
  through each terminal for their necks."
- **Advice with one click (5f65e42).** A unit's card leads with what puts it right:
  - turned away from its terminals: the quarter turn that puts the most of them ahead of their collars, 180° first
    (the footprint stays). "Turn DU-1 180°: all 4 of its terminals are then ahead of their collars (none are now)."
    The button turns the unit through the existing rotate (ducts, pipes and drains follow, one undo) and routes again;
  - too few terminals for the unit's airflow (an equal share over the neck's limit): how many at each catalogue neck of
    their face. "DU-1 supply: 4,320 m³/h through 2 × Ø250 is 2,160 m³/h each, 12.2 m/s in the neck (limit 3 m/s). It
    needs at least 6 × Ø300 or 9 × Ø250 diffusers." **Propose terminals** shows them dashed in plan and 3D, laid out
    as a designer lays them (68a37f5): in a row parallel to the collar's face, where the service's terminals already
    are (at least 2.5 m ahead of the collar), else halfway across the room; the room's stretch there cut into equal
    strips, one terminal at the middle of each; the terminals there re-necked to the largest neck, joined to the
    unit's air system and moved onto their nearest places in the row, the new ones in the free places. Always at least
    1.5 m ahead of the collar, 800 mm from walls, 900 mm from the unit and 300 mm from other bodies; where no row takes
    them all, the rest go where they spread the air most evenly. **Add terminals** commits them (one undo) and routes
    again. A new Auto route run, or putting the preview away, clears a proposal.
- **SA / RA marks in plan (c6e070d).** Every ducted unit's collars are marked outside the duct tool too: the collar's
  edge in its service's colour and "SA" or "RA" just outside it.

### Refrigerant

- **One more start from a unit left out (a1eb1e4).** The search grows trees from three starts (the farthest unit, the
  next, the nearest). When units are left out, one more is grown from each of them (at most two), the main laid out
  from that unit first; the most connected network wins as before. As drawn: 7 of 7 (6 before). Put right, with 32
  duct runs in the void, the three starts connect 2 of 7 and the extra start 7 of 7.
- **A unit left out says why (c87da48),** from the reason its branch-kit positions failed most often: "FDUM140: not
  connected — every branch-kit position near it leaves too little straight for the bends down to its connections.
  Move the unit, or the ducts and pipes by its connections, or route its pipes by hand."
- **The connection ratio (4807f89).** The indoor units' nominal capacity over the outdoor unit's, against Connection
  Min / Max in the routing settings (50–130 %; confirm with the maker). Out of range, Auto route says it first, on its
  own in the panel, without blocking Apply; the live checks put a warning on the outdoor unit. The user's FDC280:
  "… is too small for its system: its 7 indoor units total 61.6 kW: 220 % of its 28.0 kW (allowed 50–130 %). Use a
  larger outdoor unit, or split the indoor units over two systems."

### Drains

See `condensate-drainage-design.md` (24 October 2026): the search widens when ducts wall a unit in (b516cfd), and when
the only route found cannot fall (759cab4); a branch keeps clear of the drains already laid (c1f9447) and of other
units' riser spots (7b7c06b); the router is eight times faster round refrigerant (4589088); a drain short of fall says
by how much and offers a pump (202703d).

### Apply complete parts (ffe29ce)

"Apply N designed units" becomes **Apply complete parts**: the duct units with a layout, the refrigerant network as far
as it reaches (sealed; a partial network never replaces one already there), and the drains that route, as one undo.
The panel and the status message name each part left out ("DU-2 (no duct layout)", "… (no refrigerant route)", "…
(no drain route)"); those keep what they have and stay flagged. A clash or a hop to approve still blocks it, and the
main Apply still refuses an incomplete preview.

### Verified

- **Unit tests (new):** `condensateRouter` 4 (the widening: walled-off area, the caller's area kept, the whole
  drawing, no way at all); `condensateNetworkKeepOut` 2 (two cassettes with their outlets on one line, the gully
  south-west and due south: no drain through the other); `condensateShortfall` 2 (the FDU224's message, the pump
  offer, pumped with a pump); `ductUnitAdvice` 9 (the turn, the shortfall at 3 and 3.5 m/s, the row proposal ahead of
  the collar, and the turned FDU224 designed from its proposed terminals); `ductAutoRouteAdvice` 2 (as drawn: kept,
  the reasons, the three pieces of advice; turned: no word of turning); `ductCollarMarks` 2; `connectionRatio` 6
  (220 %, in and under the range, two outdoor units, the setting, the live warning, the panel); plus the per-unit
  reason in `autoRouteNetwork.completeness` and the complete-parts rules in `autoRouteReview` and the controller.
- **Full suite:** 284 files, 2,489 tests, all pass (344 s); the two gated files, the benchmark and the building, skipped.
- **Benchmark gate:** 43/43 (349 s, alongside a canvas run).
- **The user's building** (`autoRouteBuilding`, on request): 3/3 in 529 s —
  - as drawn: the FDU224 kept with "turn 180°", "6 × Ø300" and "5 × Ø300"; the bottom-left FDUM140 kept with
    "3 × Ø300" twice; the middle one designed with its advice; 7 of 7 on refrigerant; the bottom-left drain pumped; the
    FDU224's drain short of fall with a pump offered; 220 %; no drain crossing another;
  - as advised (turned, the proposed terminals added for all three units, the pump fitted): three layouts, no advice
    left, 7 of 7 on refrigerant, 7 of 7 drains, no clashes, applied;
  - put right by hand (the grid of terminals used in the investigation): the same.
- **On canvas:** `building-fixes` 21/21, restoring the project exactly. The building drawn with the toolbox (six
  rooms); SA / RA marked on all three ducted units; Auto route as drawn shows every reason and fix above; "Turn 180°
  and route again" turns the FDU224; "Propose terminals" draws four diffusers dashed, "Add 4 terminals and route
  again" adds them, then three grilles; "Fit a condensate pump and route again"; the two FDUM140s' terminals the same
  way; then three layouts, 7 of 7 on refrigerant, 7 of 7 drains, Apply open and applied ("Auto route applied: 33
  duct runs for 3 units, 7 units on refrigerant, 7 drains"); screenshots `building-01` to `-07` (plan and 3D).
  Regressions: `rotate-p2` 32/32, `turn-p2` 15/15, `smooth-p1` 24/24 (the turn handler), `duct-partial-apply` 6/6 (three units designed, DU-1 left out and named, "Apply complete parts" applies the
  three, one undo takes them out), restoring the project exactly.

### Found while building and verifying

- **A drain–duct "clash"** in an early probe was the probe's own: it checked the proposal against the drawing without
  the terminals' spigot turns, so the runouts it built differed from the planner's. The planner's audit has it right.
- **The drain–drain clash had two forms.** A branch passing through a pump riser of the network (the router saw only
  the network's long runs) — and, once that was fixed, the south cassette's riser landing on the NE cassette's drain
  laid first (both outlets on one line). Hence the keep-outs and the reserved riser spots.
- **The drains took 270 s round the refrigerant** (17 s without): every refrigerant bend reached the router as hundreds
  of short chords, each tested on every grid edge, and the widened searches multiplied it. Now 32 s.
- **"Apply N designed units"'s refusal by an incomplete refrigerant network** is gone with it: such a unit is now a part
  left out (a test kept the old refusal and was changed to the new rule).
- **On the canvas, "Turn 180° and route again" turned the wrong thing** (986b2da): it selected the unit and asked for
  the turn at once, but the canvas's turn handler read the selection as it was at its last render, and turned the
  grille selected before. The handler now reads the selection and the drawing when it is called. The drain's "Fit a
  condensate pump" button sat in a collapsed entry; an entry that offers a fix now shows open.
- **Following the advice still left two units without ducts** on the canvas: the first proposal spread the new
  terminals over the whole room, some behind the supply collar and the rest in layouts the optimiser could not build
  cleanly. Hence the row ahead of the collar, in equal strips (68a37f5), checked by a test that designs the turned
  FDU224 from the proposed terminals, and by the building test's "as advised" case.
- **The FDU224's pumped drain then found only a junction it could not fall into** among the new ducts, and the search
  did not widen for that. It widens now (759cab4), and the FDU224 drains (+245 mm).

### Known limits

- **The refrigerant route search plans in plan without seeing the ducts**; only the 3D check rejects a crossing. In a
  dense ceiling it relies on the extra starts, and a unit still left out says why. The plan's deeper option (the
  search seeing the ducts' true footprints, the main above the duct layer, branch positions further along) was not
  needed on this building and is not built.
- **A terminal beside or behind a collar** in a layout that is otherwise ahead is not reached (the turn advice covers a
  unit turned away from all of them).
- **The terminal proposal** lays a row ahead of the collar, and spreads the rest over the free ceiling where no row
  takes them all; it does not model throw or coverage, and uses the largest catalogue neck of the face.
- **The connection ratio** uses nominal kW, not the makers' capacity indices (absent from the library).
- **Auto route on this building** takes about 3.5 minutes as drawn and 4 put right (in tests).

## The unit panel, redesigned (24 October 2026)

**The request:** "once click on the unit and details of the unit pallete in the left side have more words and it is
not user friendly, also constant friction duct sizing looks like messy. so please do this very smart, very modern and
very proffessional way". Approved plan: `C:\Users\idang\.claude\plans\toasty-giggling-shamir.md`; the mockup it was
approved on (a private Design canvas): https://claude.ai/artifact/P7RKkFBZv1zJDKz4RPnHx1.

**A presentation redesign.** The sizing engine, the store's commands (one undo per change), the shared draft and every
figure are as they were; what changed is how they are shown and operated. Sentences became figures, tables and
chips; explanations moved into tooltips; what is rarely needed folds away.

### What the panel shows

- **Header:** tag, kind, model, room, "◂ Toolbox", and three key figures: Cooling (heating under it), Airflow at the
  design fan speed (L/s under it; "typed" or "Airflow field" when it comes from there), and Fan ESP: what supply and
  return need together against the fan's maximum ("46 / 200 Pa"), a thin supply / return bar, and the setting for the
  remote ("set 60 Pa", amber where it is outside the factory range). It replaces the Fan card; the whole sentence is
  its tooltip.
- **Tabs, pinned while the panel scrolls:** Duct sizing (a dot: green clean, amber warnings, red errors or over the
  fan, grey without ducts) | Specification. A unit that is not ducted shows its specification alone. The tab and the
  folded sections stay as they were left, for the session (`unitPanelUiStore.ts`).
- **Duct sizing,** one card per service:
  - Supply | Return, each with its colour and its rate; a service with neither ducts nor terminals is shown disabled,
    the reason in its tooltip ("No return terminals: the collar draws from the ceiling void").
  - A status line: the method, where the basis comes from ("as last sized"), and a health chip ("No issues",
    "2 warnings", "1 drifted"). Alerts only when they apply, each one line and one action: drift → "Re-size at this
    basis"; the issues (three, then "and n more"); over the fan.
  - **Basis:** the fan speed as four segments with their airflow; the system airflow (its placeholder the fan speed's,
    "typed ×" clears a typed one); the **friction rate ⇄ main velocity as two linked tiles**, the one that drives
    marked SET, the other muted and linked (typing in either makes it drive); the velocity limits as one summary row
    ("5.0 · 4.0 · 3.0 m/s") that opens three compact steppers; Necks follow airflow as a switch.
  - **Main duct:** its size, large; its velocity with a dot against its part's limit; its friction; what set it, as a
    chip ("Friction rate", "Trunk limit", "Smallest size", "As drawn"). Already at its smallest under the basis: "grows
    at ≤ 2.5 m/s (≤ 0.31 Pa/m)" and **one click, "Use 2.5 m/s"**, in the unit that drives (one undo). A velocity limit
    holding it: "Trunk limit 5.0 m/s holds the main below the basis (6.3 m/s)" and "Raise the limit to 6.3 m/s", or
    "Raising it changes nothing here: the split it feeds needs that width".
  - **Terminals:** the allocation ("600 / 600 m³/h") with a bar, then one line each: tag, neck (and "→250" where it
    will grow), its airflow (grey: an equal share; typed: fixed), its neck velocity with a dot; "Share equally".
  - **Folded:** *Sections* — a table grouped by run (size, m³/h, m/s, Pa/m), velocities amber near and red over their
    part's limit, a swatch for what set each size (friction rate, velocity limit, size rule, fitting, terminal) with a
    legend, and **Copy** (tab-separated, for a spreadsheet); *Calculation* — Q → V → Ø → R → the main → ESP → the
    dampers, one line each, the method as one footnote; *First sizing* — the record as four small tiles, the changes
    since as chips, "Reset to the first sizing".
  - **Before ducts:** one banner ("No supply ducts yet. Generate sizes them at this basis." with "Generate in Auto
    duct"; with a preview, "Preview open. Changes here resize it live." with "Apply in Auto duct"), the method switch,
    the same basis and terminal controls, live, on the Auto duct card's draft.
- **Specification:** the maker and the range; the fan speeds as one table (m³/h, L/s, dB(A)) with the design speed's
  column marked; the ESP as a range bar (what can be set, what is delivered, where capacity is rated) and four short
  rows; connections (collars in their service's colour, refrigerant and joint, pipes, drain and pump, "drawn as
  gravity" where the drawing ignores a built-in pump); body and power; the 3D model's origin; the source as one link,
  its reference in a tooltip. A unit without a sheet: what it holds, and one line saying so.
- **Status colours** follow the segment cards' rule (`figureStatus`, now exported from `ductSegmentFigures.ts`: near
  above 90 % of the limit, over above 100.1 %).

### The Auto duct card

Its sizing block — method, fan speed, system airflow, service, basis, terminals (folded when more than four) — is
built from the same controls, so both panels read and behave alike. Its other rows, Generate / Apply and the design
picks are as before. "Ducts on this unit" keeps the measured sizing line whole.

### Code

- `hvac/unit/unitPanelKit.tsx` (new): the card and its sections, captions, key-figure tiles, segmented pickers (tabs,
  choices, fan speeds; arrow keys move the choice), chips, status dots, a switch, folding rows, one-line alerts, a
  meter, a tooltip fixed to the window (`InfoTip`, so a card's clipping or the panel's scroll never cuts it), spec rows.
- `hvac/unit/unitPanelUiStore.ts` (new): the tab and the folded sections, for the session.
- `duct/DuctSizingSection.tsx`: the shared controls rebuilt under the same exports, plus `FanSpeedPicker`,
  `SystemAirflowRow` and `ServiceSwitch`.
- `duct/DuctNumberInput.tsx`: `variant` (`tile`, `compact`, `cell`), `suffix`, `displayDigits` (5.0, 0.80; a value with
  more decimals keeps them); the default look, used by the fabrication settings, is unchanged.
- `unit/UnitDesignPanel.tsx`: the view rebuilt; the unit's air side is measured once for the header, the tab's dot and
  the cards.
- `duct/DuctAutoCard.tsx`: the sizing block.

### Verified

- **Type-check and lint** clean on the changed files. **Full suite:** 2,487 tests passed, 2 failed (46 skipped as
  before). The two are timeouts, not assertions — "connects a mixed group whose indoor ports face all four cardinal
  directions" (`autoRouteNetwork.geometry`) and "serves staggered rows of eleven default-facing diffusers"
  (`ductAutoRoute`) run 62–67 s against their 60 s limit, and do the same on the code before this work (run alone,
  the change stashed). No component tests exist; the drivers below check the panel.
- **On canvas** (real mouse and inputs; each driver restores the project exactly; nothing is saved):
  - `unit-panel` 39/39 (was 34): the cassette's specification alone; an FDUM22 with two Ø200 diffusers — the key
    figures, the Duct sizing tab first, the Specification tab (780 / 600 / 540 / 480 m³/h with L/s and dB(A)), the
    basis set in the panel shown in the card (one draft), a preview resized live from the panel with the card keeping
    it, Apply and its record, the status line, the Fan ESP tile (supply 26 + return – of 100 Pa), the calculation and
    the sections opened, "◂ Toolbox" and the card's "Size it in the unit panel", 3.0 m/s changing no duct and the panel
    saying where the main grows, **"Use 2.5 m/s" enlarging the main 200×350 → 250×350 in one click**, a diffuser at
    500 m³/h taking a Ø250 neck, the reset, the undo chain, the toolbox back on deselecting.
  - `unit-high-capacity` 20/20: an FDU280 with six Ø300 diffusers — its specification (settable 10–200 Pa, 1450 × 250
    collars), Generate (46 Pa of the fan's 200), the main held by the 5 m/s trunk limit and said so, "set 60 Pa" on
    the ESP tile, "Raise the limit to 6.3 m/s" (700×350 → 600×350, one undo).
  - Regressions through the Auto duct card: `shape-p6` 32/32, `duct-auto` 17/17, `air-p3` 14/14, `duct-cross-room`
    18/18.
  - `duct-sizing` 24/26. Its two failures — after Apply one run reports `DU_TRANSITION_ANGLE` (a converging transition
    of 78°, then 148° at 1.2 Pa/m) — are the same on the code before this work (an A/B with the change stashed): a
    duct-engine regression since 18 October, when it last passed 26/26, not the panel's. Left for its own fix.

### Found while verifying

- **The dev server answered 500 on every route.** It had run since the morning through a day of hot reloads (5.7 GB,
  at its heap limit), and `apps/web/.next/static/webpack` — about a thousand hot-update files — had become unreadable
  ("UNKNOWN: scandir"), so a restart failed too. The damaged cache was moved aside (to
  `D:\claude-tmp-vrf-check\next-broken-20261024`, outside the repository), its compile cache kept, and the server
  started again. Nothing in the source was involved.

## The unit panel v2: sizing drawn, practice-based criteria, SI ⇄ IP (25 October 2026)

**The request,** after the first redesign: "further reduce the simple interface but comprehensive with less text and
more graphic"; make it convincing that the initial velocity and friction set the constant friction, that every segment
takes a standard duct size at that friction and its velocity follows; changing the friction re-sizes every segment;
diffusers of the same spec take the same airflow unless one is set; branches carry the cumulative airflow of their
diffusers; auto-generation uses industry practice for velocity, friction and sizes; and SI ⇄ IP. Approved plan:
`C:\Users\idang\.claude\plans\toasty-giggling-shamir.md` (v2); mockups: the v2 row of
https://claude.ai/artifact/P7RKkFBZv1zJDKz4RPnHx1 (V2Sizing, V2Criteria, V2Chart, V2Terminals, V2IP).

What already held before v2 (verified in the code): a branch's airflow is the sum of the terminals past it
(`ductSystemSizing.ts`, the suffix walk), and each section takes the smallest stock size within R and its velocity
limit. What v2 adds is below, one phase a commit.

### P1 — HVAC units (896facf)

`units/hvacUnits.ts`: quantity kinds (airflow, velocity, friction, pressure, size, length, capacity, mass), exact
factors (CFM = m³/h ÷ 1.69901; fpm = m/s ÷ 0.00508; in. wg/100 ft = Pa/m ÷ 8.164; in. wg = Pa ÷ 248.84 at 60 °F;
in = mm ÷ 25.4; kBtu/h = kW × 3.412; TR = kW ÷ 3.517), the precision and input step of each, and `toDisplayText`,
which adds the IP figure after each SI figure of an engine message ("112 Pa (0.45 in. wg)") without rewriting it.
The choice is a duct setting (`unitSystem`, it travels with the document; missing = SI); `useHvacUnits()` gives the
formatters; `DuctNumberInput` takes a `quantity` and then shows, steps and parses in the display system while the
model stays SI.

### P2 — The same spec, the same airflow (dec2994)

`shareAirflow` gave every untyped terminal an equal share, so a Ø150 and a Ø300 took the same air. Untyped
terminals now share what the typed ones leave **at one neck velocity** (in proportion to neck area): identical specs
get identical airflow, larger necks more; a uniform system is unchanged. `terminalGroups.ts` groups terminals by spec
(service, face, neck, face size, slots, filter) for the panel.

### P3 — Criteria from ASHRAE HVAC Applications ch. 49 (efa8284)

`duct/ductDesignCriteria.ts` holds Table 1 (room → RC: private office 30, open-plan office 40, conference 30,
classroom 30, ward 35, laboratory 45 …), Table 8 (maximum main-duct velocity by RC and where the main runs: in a shaft
or above drywall, above a suspended ceiling, in the occupied space; branches about 80 % of it, final runouts at most
50 %), Table 9 (supply and return neck velocities), with RC 30 and 40 between the table's rows and caps of 12 / 10 / 8
m/s. Open-plan office, RC 40, above a suspended ceiling gives main 10.8, branch 8.6, runout 5.4 m/s and necks 2.8
supply / 3.4 return m/s; with the practice friction rates of 0.80 supply and 0.60 return Pa/m (about 0.1 in. wg per
100 ft). **New documents start from those criteria; documents saved before keep their own values** (the chip says
"Custom limits"); the engine defaults are unchanged. A new design's basis takes the practice rate, or the rate at
which the main reaches its limit when that is lower, so every section shares one friction rate.

### P4 — An inch size series (d1f4aa4)

`sizeSeries: 'metric' | 'imperial'` picks the sizes every sizing path uses (`duct/ductSizeCatalog.ts`): the
fabricator's step and the stocked round list as set, or rectangles in 2 in steps and round 4–10 in by the inch, then
by 2 in. Steps are taken as exact multiples (never a running sum: 50.8 mm steps would drift). Constant friction, Auto
duct and its optimiser, segment options and edits, round ⇄ rectangle equivalents and drag-resize read it. In the inch
series a height drawn off the grid re-sizes to the nearest even inch the void gives.

### P5 — The sizing card, drawn (2ee5e76)

- **Design basis.** The criteria chip ("ASHRAE · Open-plan office · RC 40") opens the criteria in place: the room
  (with its RC), where the main runs, the velocity ladder they give, the friction rates, metric | inch sizes; "Use
  for new designs" makes them the project's, "Apply to DU-n" also re-sizes that unit's ducts by them (both services,
  one undo). Under it, **the method strip**: V₀ main ⇄ R (the one set last marked SET, the other linked) › Sizes (how
  many standard sizes) › Velocity (the range the sections run at, ✓ within their limits or "n over"). **R on a slider**
  over 0.2–1.6 Pa/m with the usual 0.6–1.0 band shaded: dragging dry-runs the network at the rate under the thumb
  (the network and the strip follow, the drawing untouched), letting go re-sizes every section (one undo); arrow keys
  step it. The fan speed with a pencil for a typed airflow, the limits folded.
- **The network** (`duct/ductNetworkTree.ts`, `unit/NetworkTree.tsx`): from the collar, each run on its rail and the
  runs it feeds nested where they leave it; a row a stretch: its size, a bar of the airflow it carries (the
  terminals past it), the airflow, the velocity coloured against its part's limit. Hovering a row outlines the
  stretch on the plan (`ductNetworkFocusStore`, painted by `DuctOverlay`); a click pins it there. It never selects
  the run, so the unit stays selected and the panel open.
- **Terminals by spec:** a bar of how the air is shared between the specs, one "each" airflow a group (typing it sets
  every terminal of that spec), each terminal under its group (open by itself where one is set on its own), necks
  follow airflow with its cap.
- **Friction chart** (`unit/FrictionChart.tsx`, folded): airflow against friction on log scales, lines of equal
  diameter and velocity from the same Darcy–Weisbach figures, R and the usual band, a dot per stretch (hover ↔ its
  row ↔ the plan), and Q · V₀ · Ø · R under it. Warnings read one line a kind ("Neck velocity over its cap · SAD-2,
  SAD-3 +4"), each message in full on hover. The first sizing stays folded at the end.
- **Before ducts** the same controls set what Generate sizes at; with a preview open its network and chart show.
- **SI | IP** in the header; switching offers the matching size series and then re-sizing the unit's ducts to it
  (one undo). The Auto duct card uses the same controls.

### P6 — SI | IP across the air side (0788074)

Segment cards (the figure strip, pressure class, results, the size editor in inches, the terminal airflow, option
titles with their sizes in inches, details and issues with the IP figure beside the SI one), the air system card, the
run inspector and duct settings, the Auto duct card's designs, chart and summary, the equipment tiles (by tons:
"Ducted 8 TR") and their hover card, and the plan's duct size tags. **Drawing dimensions** — lengths, levels, sheet
thickness, support spacing — keep following the drawing's own Display / Input unit.

### Verified

- **Type-check and lint** clean. **Full suite: 2,513 passed, 0 failed** (46 skipped as before). New tests: units
  (conversions, round trips, formatting, message annotation, sizes in labels, pressure classes, tube fractions),
  sharing at one neck velocity, the ch. 49 table values and interpolation, the inch catalogue (sizes land on the
  series; an auto-generated rectangular design all on 2 in steps), and the network rows (take-offs nested after the
  stretch they leave, a split's outlets after the run, the terminal on its run's last row).
- **On canvas** (real mouse and inputs; each driver restores the project and the settings exactly; nothing is saved):
  - `unit-v2` 45/45 (new): an FDU280 with four Ø300 and two Ø250 diffusers — two spec groups sharing at one neck
    velocity (802 : 557 m³/h = 1.44, summing to 4320); the criteria editor (open-plan office RC 40 above a suspended
    ceiling → 10.8 / 8.6 / 5.4 m/s, necks 2.8 / 3.4) and "Use for new designs"; Generate within the limits, the
    preview's network in the panel; after Apply the network row for row against the report, hover outlining the
    stretch on the plan and a click pinning it; dragging R to 0.50 Pa/m previewing with the drawing untouched, letting
    go re-sizing every section, one undo back; the Ø250 group set to 500 m³/h each, one undo; the friction chart's
    dots and trace; IP in the header, strip, network, plan tags, air system card, run inspector, a segment card and
    the toolbox (Ducted 8 TR); "Use inch sizes" and "Re-size DU-1" putting every new duct on the inch series, one undo;
    "Apply to DU-1" with RC 30 criteria (trunk 7.5 m/s on the project and the ducts), one undo.
  - The first redesign's drivers, moved to v2 (same scenarios): `unit-panel` 39/39, `unit-high-capacity` 20/20.
  - Regressions: `shape-p6` 32/32, `duct-auto` 17/17, `air-p3` 14/14, `duct-cross-room` 18/18, `duct-sizing` 24/26 —
    its two failures are the `DU_TRANSITION_ANGLE` ones reported above (78°, then 148°, the same figures), not this
    work's.

### Known limits

- One set of criteria for the project; criteria per room (a different RC per unit) are a follow-up.
- Refrigerant pipe and condensate figures stay SI / mm (pipe sizes in the unit's specification read in tube inches).
- Engine messages in IP keep their SI figure with the IP one beside it; they are not rewritten.
- Terminal tags on the plan keep their catalogue names ("595 · Ø300").
- The network's highlight is on the plan only (not in the 3D views).
- Undo (and redo) clear the selection everywhere in the app, so after Ctrl+Z the unit panel shows the toolbox until
  the unit is selected again.

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
- Auto duct designs one level per service and adds no risers. A one-room system keeps clear of walls (obstacles in their own height band; there are no beams or storeys in the model); a system spanning rooms passes interior walls by sleeve (see Air systems above). Units are designed one after another (each around the ones before), with one more pass, boxed-in units first, when a unit failed on a clash after another was designed; not jointly.
- Auto duct's pressure figures are estimates with practice loss coefficients, not a certified duct calculation.
- Terminal sizes are typical catalog values (practice) until a supplier's data is entered.
- A rigid connection to a terminal is checked, not routed: its last leg has to be drawn straight into the spigot.
- Plenum spigots are round, on the side and end faces; there are no bottom spigots or rectangular necks yet.
- During equipment placement, R with nothing focused switches to the Room tool (the single-key tool shortcuts do not know about placement). R works while the picked card keeps focus, as it does after a click. This is pre-existing.
