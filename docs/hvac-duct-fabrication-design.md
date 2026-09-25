# Duct fabrication engine: design

Rectangular supply and return ductwork, drawn as runs from the unit mouth, with every fabricated piece and accessory generated automatically.

Three constructions are supported: GI bare, GI with nitrile rubber (NBR) insulation, and pre-insulated panel duct (PID). Flexible duct is used for terminal connections.

- Code: `packages/drawing-engine/src/components/canvas/hvac/duct/`
- Construction rules and their sources: [hvac-duct-smacna-research.md](hvac-duct-smacna-research.md)

Status: **Phase 1 implemented** (GI runs with joints, 2D + 3D on the real FDUM22); P2–P5 below are not yet built. See [Phase 1 status](#phase-1-status).

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
| Geometry and fittings | `DU_TRANSITION_ANGLE`, `DU_ELBOW_RADIUS`, `DU_LEG_TOO_SHORT`, `DU_VANE_SPAN`, `DU_HARD_WAY_ELBOW` (info), `DU_ASPECT_RATIO` (>4:1), `DU_SIZE_OVER_TABLE` (>3000 or class above 500 Pa) |
| Construction | `DU_GAUGE_JOINT`, `DU_INTERMEDIATE_REINF`, `DU_CROSS_BREAK` (info), `DU_PID_LIMITS`, `DU_PID_REINF_UNVERIFIED` |
| Connections | `DU_FLEX_LENGTH`, `DU_FLEX_SAG`, `DU_MOUTH_MISMATCH` (transition inserted), `DU_MOUTH_APPROX` (unit without measured ports), `DU_OPEN_END`, `DU_STALE` |
| Supports | `DU_HANGER_SPECIAL` (P/2 > 4880), `DU_ABOVE_SOFFIT` |
| Coordination | `DU_CLASH` |

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

**Known Phase 1 limits**
- The FDUM22 GLB renders as a flat slab in iso on both the duct branch and the main checkout (a pre-existing model or shading issue), so the collar joint is not visually distinct in 3D. The numeric tests cover the alignment.
- The live draft is drawn in 2D only; 3D shows committed runs.
- A custom W × H that differs from the collar is flagged `DU_MOUTH_MISMATCH` until transitions land (P2).
- Old Fabric duct code (the `HvacPlanRenderer` duct case and the dead isometric case) is still present but unused. Removal is P5.

## Known limits

- Rectangular trunk only; round spiral trunks are not in scope (flex duct is).
- Pressure classes above 500 Pa are refused until Tables 1-6M to 1-9M are encoded.
- Figure-only SMACNA values (vanes, transitions, shoe geometry, TDC cleat spacing) are secondary-sourced and flagged `verified: false`.
- PID reinforcement counts are unverified until the P3 graph is transcribed.
- No airflow sizing or auto-routing from terminals. Sizes are what you draw.
