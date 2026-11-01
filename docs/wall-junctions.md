# Wall junctions: one correct shape in 2D and 3D

**The request (31 October 2026):** a screenshot of a six-wall junction with a white hole under the node and a selection
highlight that did not match the wall. "Inconsistancy of the wall junction give the bad accuracy of the 2D and 3D view.
So please solve that issue. Do this very proffessional way."

**The approved plan:** `C:\Users\idang\.claude\plans\peaceful-greeting-cupcake.md`. The user then opened their saved
drawing, a junction of about twelve walls, with the fix in place and confirmed it came up clean.

| Commit | What |
|---|---|
| `f068cb6` | Exact union and difference on an integer grid (Clipper) |
| `7cc2b85` | The solver's junction rules |
| `8053959` | Development wall report on the debug handle |
| `ee93065` | One solved shape for selection, clicks, rooms and 3D |
| `0d50b6b` | Real junctions, and splits that keep doors and attributes |
| `f320c7b` | One route for every wall edit |
| `314d4f8` | A click inside a wall joins it, at any zoom |
| `e958674` | Edits stay fast on large drawings |
| `0c41f44` | Auto dimensions on plain rooms pinned |

## What was wrong

Four separate causes, each confirmed against the real code before anything changed.

1. **The solver broke at tight corners.** It applied the miter limit to inner corners too, so any two equal walls closer
   than 29° fell back to points near the node, and sorting the core by angle then folded it inward. The user's junction
   came out as 3 separate bodies. The reference app has the same bug, so this code now knowingly differs from it.
2. **2D kept overwriting the solved shape.** The solver's corners were stored on each wall as its interior and exterior
   lines, then the next render replaced them with square-ended lines on the same objects. Selection and clicks used one
   shape and 3D another, and rooms saw either depending on timing. Reading the stored quads with no core is what lost the
   rooms either side of a tee.
3. **The polygon union could fail.** turf's float clipper can throw on nearly-collinear edges, and also returned the wrong
   area with no error (worst 37 cm² at one junction).
4. **Walls could avoid the graph, or look joined when they were not.** The room tool made walls outside the graph; a tee
   deleted doors and reset the wall's height; a click on a wall's face joined only by grid luck; a wall moved across
   another stayed unjoined.

Measured on random junctions, holes / split bodies, before and after:

| Junction | Before | After |
|---|---|---|
| 4 walls | 23.5% / 25% | 0 / 0 |
| 5 walls | 63% / 57% | 0 / 0 |
| 6 walls | 85.8% / 78% | 0 / 0 |
| Mixed thickness | 43.8% / 26.8% | 0 / 0 |
| Short walls (150–600 mm) | 27.8% / 22.3%, 24.5% twisted | 0 / 0, 0 twisted |

Plain joints did not move: 4000 random junctions with gaps of 30° and up gave identical corners and cores to the old
solver. Saved drawings need no conversion, because shapes are derived when a drawing opens.

Auto dimensions did not move either. Six plain plans gave the same values, points and text positions from the old and new
code once both had rooms. What changed is when that happens. The old code lost the rooms either side of a tee until a
later render and detection, and until then it dimensioned the partition as an outside wall, with runs of 2800 + 3000
instead of 2900 + 2900. Room areas also matched, within 2 mm², apart from one correction: an L plan's clear area is
33.24 m², where the old code gave 33.25 m² after a render because no core filled the inside corner.

## The rules of a junction (`wallcore/wallSolver.ts`)

Walls at a node are taken in order around it. Each neighbouring pair makes one corner:

- **An inner corner both faces reach going forward** is always taken. It lies inside both walls, so it cannot spike. It is
  only valid if each face really runs inside the other wall back to the node, and both walls are long enough to reach it.
- **An outer corner** is mitred only when both faces run backward and stay within the miter limit (2× the thicker of those
  two walls). Otherwise it is bevelled. A mixed one would bite a wall's own corner.
- **A straight run** has a flat joint when its faces line up, and a step where the thickness changes.

The **core** is the ring of the walls' end caps in that same order, so every cap is exactly one of its edges and walls and
core tile with no gap and no overlap. Corners are shared as the same exact point, so they round the same way.

**Hard junctions** take the exact path instead: a thin wall through a thick one, a thickness shoulder, or a wall too short
for what both its ends want. Each wall is square-ended and cut back only where another body really covers it, and its
cut-off part goes into the core. Quad + cut-off part = the wall's whole rectangle, so **a hole cannot form, whatever the
cut-backs are**. Cut-backs stop `CUT_OVERLAP` (0.5 mm) inside the covering body: bodies that merely touch can part by a
grid step once rounded, which would draw a false seam. Open corners are closed by fills.

**Unequal heights** always use the exact path. Each cut-off part keeps its own wall's height and material, so a tall wall
has no slot above a shorter stem. Open corners are filled per height band, between the walls standing in that band, so no
wall grows an ear above a low neighbour and a low stub does not notch a tall corner above it.

The test for all of this is the oracle in `wallSolver.junctions.test.ts`: the union of the pieces must equal the union of
the walls' rectangles, plus only the open corners each neighbouring pair leaves, worked out independently of the solver.
For mixed heights, every height must match solving only the walls standing there.

## One shape for every reader (`wallcore/solvedWalls.ts`)

Shapes are derived and never stored, which is the wall model's own rule. `solveWallList(walls)` keeps one solve per wall
list, shared by the 2D body, selection and click areas, and the 3D prisms. Rooms subtract exactly the drawn body.

- `interiorLine` and `exteriorLine` on a wall are always its **square-ended face lines**. Dimensions, panels and tools rely
  on them. Do not store solved corners there.
- `footprint.outline` is a wall's whole share of the plan: its quad plus its part of each core. Use it for selection and
  hit areas; together the walls' outlines cover the drawn body.
- A wall's Fabric group is hit by its bounding box, which for an angled wall spans its neighbours and empty floor. Only the
  real shape decides what a click hit (`WallRenderer.getWallIdAtPoint`).

## One exact union (`wallcore/wallUnion.ts`)

Every wall union and difference goes through Clipper (`js-angusj-clipper`) in integers, on a 0.01 mm grid. It was about
7–30× faster than turf on these shapes, and it had no failures against turf's up to 33% on the same junctions. Its
plain-JS build is ready a few microtask turns after load, so every caller stays synchronous; the WASM build compiles truly
asynchronously, which is why it is not used. If it could ever not answer, callers get the raw pieces flagged inexact, and
the plan fill is non-zero so those pieces still fill solid. Clipper can rarely return two polygons sharing an edge, which
would draw a false seam, so a union that returns more than one polygon gets a second pass.

## One route for every wall edit (`store/index.ts`)

`applyWallGraphOperation` is where every wall edit ends: it derives the graph, mutates it, normalizes what changed,
mirrors it back and runs rooms, elevations and history once.

| Route | Goes through |
|---|---|
| Wall and partition tools | `wallGraphAddChain` |
| Room tool, paste, offset | `addWall` |
| Panels, nudges | `updateWall`, `updateWalls`: shared nodes move, so neighbours follow |
| Trim, extend | `wallGraphMoveEnd`: only that wall's end moves, then it welds or tees where it lands |
| Drags | Each frame only updates coordinates, neighbours included; `wallGraphCommitDrag` settles it at the drop |
| Delete | `deleteWall`, `deleteWalls` |
| Opening a drawing | `importFromJSON` normalizes every wall once |

## If it looks joined, it is joined (`wallcore/wallGraph.ts`)

`normalizeWallGraph` runs after every edit on the walls that changed, repeating until the graph settles:

- Nodes within `WELD_EPS` weld.
- A node inside another wall's body joins it: on the centreline, or at its end node when within half a thickness of that
  end. Walls near-parallel to it (`MIN_TEE_ANGLE`, 5°) lie side by side and do not join, and neither does a short wall
  already joined to that wall at its other end. A node exactly on the centreline always joins, which is what resolves
  collinear overlaps.
- Crossing walls become an X.
- Two walls between the same nodes become the one already there, which takes over any doors.

When a wall leaves a node and two matching straight walls remain, they merge back into one. Only the node that lost a wall
is considered, so a deliberate split stays.

The same rule applies when drawing: a click inside a wall's body joins it at any zoom (`snapInsideWallBody`). Alt, and
switching wall snaps off, still place the point freely.

## Splits keep everything

Splitting a wall records which stretch each piece carries (`WallGraphDoc.sources`, never saved). In the mirror
(`legacyBridge.ts`):

- The longer piece keeps the wall's id, so whatever refers to it by id stays with most of it.
- Both pieces keep every attribute.
- Doors and windows stay on the piece holding their centre, at the same place in the room. A door a new wall lands on
  stays whole, moves the minimum needed and shows a notice, or goes to the longest piece when its own cannot hold it. A
  door is never deleted, and only new ends push: one the user placed close to the wall's own end stays there.

Hosted door and window symbols follow their opening by id through `useRendererSync`.

## Speed

Timed against the original code on grids of rooms, median of three runs:

| Walls | Adding one wall | 2D union | 3D mesh | Rooms |
|---|---|---|---|---|
| 144 | 11 → 14 ms | 30–41 → 46 ms | 44–55 → 53 ms | 112 → 18 ms |
| 840 | 38 → 43 ms | 139–157 → 126 ms | 222–260 → 184 ms | 540–600 → 53 ms |
| 1860 | 92 → 87 ms | 293–297 → 518 ms | 414–419 → 634 ms | 1526 → 97 ms |

The old room times are flattering: on these plans the old code found no rooms at all, where the new code finds all 64, 400
and 900. The slower union and mesh at the top come from Clipper's plain-JS build on one body with 900 holes; the WASM
build should be faster if a drawing that size ever needs it, but it would have to load asynchronously. Opening a
1860-wall drawing spends about 1 s normalizing it, once. The user's real building has 13 walls.

## Known limits

- Something that remembers a wall by id can lose the link if a split gives its wall a new id. A manual fire-damper override
  stored as `penetrations["wallId:n"]` on the shorter piece can fall back to the default. Rooms match by polygon first, then
  by wall ids, so they are not affected by a split alone. This already happened on every split.
- `WallJoinNetwork.ts` and `WallJoinComputer.ts` remain for walls outside the graph, which a loaded or edited drawing no
  longer has. Removing them is a separate clean-up.
- **Flip Side** does nothing on normal centred walls: the wall tool only draws centred walls, and flip only swaps left and
  right. The solver and selection handle one-sided walls correctly, but the square-ended face lines ignore justification.
- The brick pattern runs along the plan axes on angled walls, not along the wall.

## How it is checked

- `wallSolver.junctions.test.ts`: the user's junction, twelve random families at zero (holes, extra solid, split bodies,
  twists, spikes), order independence, mixed heights against the oracle.
- `wallGraph.normalize.test.ts`, `legacyBridge.test.ts`, `wallUnion.test.ts`: joins, merges, door positions, the union.
- `store/wallJunctions.store.test.ts`: every route through the real store, and the auto-dimension values above, taken from
  the old code.
- `D:\claude-tmp-vrf-check\wall-junctions.mjs`: real keyboard and mouse on the running app, with `WJ_TAG` naming the run
  and `WJ_ONLY` choosing scenes. Solid-wall checks read canvas pixels at the old defect points.
- `__PROVACX_DEBUG__.getWallReport()` shows bodies, cores and each wall's selection shape in a development build.
