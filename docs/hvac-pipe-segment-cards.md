# Segment cards for refrigerant lines and condensate drains: design

**The request (12 October 2026):** "similar to the duct editing and proposed panel once select the duct segment,
refrigerant and condensate pipe must have similar features referring to the refrigerant pipe segments and condensate
pipe segments once select them. do this more advance way and very professional and modern way".

**The approved plan:** `C:\Users\idang\.claude\plans\pipe-segment-cards.md` (phases 0–5). It was approved with every
recommended decision:

1. A coordinated gas + liquid pair is one card with a Gas | Liquid switch. Geometry edits move both lines.
2. The card holds piece-level actions. The refrigerant toolbar keeps the whole-run tools; the drain bar keeps the
   network tools.
3. With no manufacturer profile loaded, sizes come from the ACR copper series, labelled "no sizing table loaded".
4. A liquid line's additional charge comes from a practice table, flagged unverified.
5. Inline refrigerant accessories are part of Phase 5.

| Phase | Commit | What |
|---|---|---|
| 0 | `ecd9e7c` | One segment-card shell for every service (the duct card re-expressed on it, unchanged) |
| 1 | `e4706ad` | Refrigerant pieces and branch kits: cards with figures and checks, in plan and 3D |
| 2 | `90a8217` | Refrigerant options, previewed before they are applied |
| 3 | `83a730b` | Condensate pieces: cards with figures and checks, in plan and 3D |
| 4 | `072cd8a` | Condensate options, solved through the network |
| 5a | `fd690e8` | Inspectors list a pipe's pieces; the bars keep the run and network tools |
| 5b | `44b45b5` | Inline refrigerant accessories |

The duct cards these follow are described in `hvac-duct-fabrication-design.md` ("Segment cards").

## What a designer sees

- **Point at a piece** of a selected refrigerant line or drain, in the plan or a 3D view.
  - It is outlined in violet.
  - After a short rest, a **peek** card shows what the piece is and its key figures, with the best one or two swaps
    that break no rule.
- **Click it**, and the card **pins** beside the piece, with a leader to it. The card holds:
  - **Header:** the piece's name and size, a short tag (`G-S2`, `L-B1`, `G-A1`, `Y1`), ‹ › to step along the run, ⓘ
    for how it is built, and ✕.
  - **Figure strip:** three or four figures, with ok / near / over status dots where there is a limit.
  - **Issues:** the design checks about this piece.
  - **Tabs:** Edit (typed values and chips), Swap (alternatives) and Add (fittings and accessories).
- **Hover an option.** The drawing shows it as it would be: dashed in plan, drawn in place in 3D. The row and the
  card's foot give what it changes and the checks it would newly fail, or the engine's reason for refusing it.
- **Click it.** It is applied as one undo, and the card stays on its piece.
- **Keyboard:** `[` / `]` previous and next piece, Enter applies a typed value, Esc hides a peek or closes the card.
- **Inspectors** list the run's pieces with the cards' tags. A row's click pins its card, and the pinned piece's row
  is marked.

## One card shell for every service (Phase 0)

`hvac/segments/` holds what every service shares. The duct card became one provider of it, and its drivers passed
unchanged.

- **`segmentProvider.ts`**: what a service supplies.
  - A piece's model: header, figures, info, issues, options with a pure `evaluate`, the tab of each option, the Edit
    tab, and the neighbours.
  - Badges, chips, the result line, `commit` (one `commitHvacElementCommand`) and `rekey` (finding the piece again
    after an edit).
- **`segmentUiStore.ts`**: the hovered, pinned and previewed focus.
  - Each focus has a service domain (absent means duct).
  - A preview can add and remove elements as well as update them. A drain re-solve returns all three.
- **`SegmentCardLayer.tsx`**: the card and the layer. One card is open at a time, whatever its service.
- **`SegmentCardKit.tsx`**: the shared parts.
  - Anchoring, every frame, without a React render.
  - Time-sliced evaluations: about 12 ms a slice, so the drawing stays responsive while a card fills in.
  - Option rows, chip rows, steppers, value fields, the result row and list keys.
- **Anchoring rules** (`useAnchoredCard`), each learned from a click that landed on the wrong thing:
  - The pointer is tracked for the whole page, so a peek that mounts after the pointer rests knows where it is.
  - A new placement keeps 8 px clear of the pointer. Where no side clears both the piece and the pointer, the card
    stands beside the pointer, over the piece.
  - A card the pointer is on never moves:
    - not when a hovered row's foot grows it past the drawing's edge;
    - not when its piece moves or changes size after an option is applied or a neighbour is stepped to (5b).
    - Its leader follows the piece, and the card settles by the piece once the pointer leaves it.
  - A row re-rendered under the pointer (a tab switched) detaches the event's target. The last answer stands until the
    pointer moves again.
  - An anchor can name preferred sides. A drain's card prefers the sides across its run, so it never lies along the
    pipe over the next piece.

## Refrigerant lines

### Pieces (`refrigerant/refrigerantPieces.ts`, Phase 1)

A line's pieces are listed in path order. Keys come from the line's persisted design (`pipeDesignModel.ts`), so a
piece keeps its key across an edit that keeps its leg or joint.

| Key | Piece |
|---|---|
| `port:start` / `port:end` | the hard-copper stub at a unit or branch-kit port, as long as the port reserves |
| `leg:<legId>` | a straight or a riser (rise over length ≥ 0.7) between fittings, trimmed where they take over |
| `joint:<jointId>` | a bend: a catalogued copper socket elbow, or a formed bend with its arc |
| `acc:<id>` | an inline accessory, right after the straight it sits on (5b) |
| `kit` | a branch kit's own card, on the kit element |

- Each piece carries its own centreline in model space. The plan outline, the brackets at its ends, the 3D proxy and
  rings, and its card's anchor all come from it.
- **Picking.** In plan, the nearest piece within the line's half width plus a few screen pixels. In 3D, the nearest
  piece to the ray's hit on the line's surface. Where pieces tie, the smaller part wins: an accessory, then a riser, a
  bend, a port, a straight.
- **Clicks.** Refrigerant clicks belong to `PipeStudioOverlay`: a press released without moving pins the piece; a drag
  stays a drag. A selected line's segment handles (`PipeEditGizmo`) report the piece under the pointer and clicks on
  it.
- **A stale stored design is rebuilt from the route.** An adaptive drag writes the route but not the design. Without
  this, the stale design misplaced pieces, and the rotate and bend tools acted on the old shape.

### Figures (`refrigerantPieceFigures.ts`)

Each figure says where it comes from.

- **The line:** tube OD and inch size, insulation and outside diameter, hard or flexible copper.
- **The piece:** length, level, rise and slope.
  - A bend's angle, centreline radius, construction, catalogue part and plane. A formed bend's radius is judged
    against the profile's minimum.
  - A port stub's straight against what the port reserves.
- **The circuit**, from the outdoor unit's network evaluation:
  - the indoor units it serves, and their capacity index;
  - the longest path through it against the profile's limit;
  - the equivalent length, only when every bend allowance is known (else "unknown");
  - the height difference;
  - the profile's size, or "no sizing table loaded" (never a made-up recommendation).
- **A liquid line's additional charge**, from typical published R410A values per tube size. It is flagged as a practice
  table, unverified: the outdoor unit's own table governs.

### Options (`refrigerantSegmentOptions.ts`, Phase 2)

Each option is applied to a copy of the drawing through the pipe engine. The engines used are the adaptive solver
(`buildAdaptivePipeEdit` / `buildPipeModelEdit`, which re-make risers and offsets at fixed ports), the topology edits
and the design edits.

- **What each option is judged on:**
  - the change in tube length, and in charge on a liquid line;
  - the VRF checks it newly fails, and the circuit's hard rules before and after (`refrigerantChangeIssues`);
  - the line's own fittings, held to the standard the line arrived with.
- **Caching:** pure, and cached per drawing and edit. The same option on another piece is another edit (the cache key
  carries the edit itself). A straight's options take about 80 ms on the test project.

| Tab | Options |
|---|---|
| Swap | The line's size: one ACR size down or up, the profile's size, or the unit port's size. The recommended one is badged. |
| Swap | On a bend: socket elbows or formed bends for the line, a formed bend's radius, a 90° made two 45°s with a straight between, the bend turned into another plane |
| Swap | On a straight: hard or flexible copper (the stub on a unit port stays hard) |
| Edit | A straight's level and sideways offset (chips or typed): a pair's two lines move together. Its length, with its start or its end held. The line's insulation. |
| Add | A route point at a straight's middle; a bend taken out; the inline accessories (5b) |

**Branch kits** (`refrigerantKits.ts`; the kit's card):
- The figures give its model, its line and how it sits, the capacity it carries on, the units it serves, and the
  profile's word on its model.
- It slides along its run with the pair's other kit, and every pipe on them follows. The slide is refused, with the
  pipe named, when a pipe leaves the kit sideways or has too little straight to give.
- Turning it over is listed, but refused for a kit any pipe holds: the mirror moves every port across the pair.
  Another model is listed, refused because the library draws one kit.

### Inline accessories (`refrigerantAccessories.ts`, Phase 5b)

**Kinds:**
- a ball (service) valve or a flare union, on either line;
- a strainer or a sight glass, on the liquid line only, as practice places them.

**Stored on the line** as `properties.inlineAccessories: [{ id: "a1", kind, legId, stationMm, at: {x, y, z} }]`:
- `legId` is the design leg it sits on.
- `stationMm` is its centre's distance from that leg's start point: the bend's corner, or the port.
- `at` is its centre as last placed.
- When its leg is renamed, or split by a new corner so its station no longer falls on it, the accessory re-attaches
  to the straight nearest `at`.
- Card edits that rename legs carry each accessory to where it was: adding a route point, taking a bend out, or making
  a 90° two 45°s.

**Bodies** are practice sizes from the tube, unverified until a catalogue is loaded:

| Kind | Length | Diameter |
|---|---|---|
| Ball valve | 2.6 × OD + 50 | 2 × OD + 10 |
| Strainer | 3 × OD + 90 | 2.2 × OD + 12 |
| Sight glass | 2 × OD + 60 | 2.6 × OD + 8 |
| Flare union | 1.6 × OD + 25 | 1.6 × OD + 6 |

**Where it may sit:**
- A body sits inside its straight, 30 mm clear of the fittings either side and of the bodies beside it.
- One that cannot be where it is says why ("belongs on the liquid line", "runs into a fitting: keep its centre
  96–904 mm from the start point", "runs into the strainer beside it").
- Its card shows that as an `ACCESSORY_FIT` error. The plan draws it dashed red and the 3D body glows red.
- An option on another piece that would leave an accessory without room shows a new `ACCESSORY_FIT` error before it
  is applied.

**Options:**
- **A straight's Add tab** offers each kind its line takes, "here": at the straight's middle, else the nearest free
  place. On a pair, "Ball valves on both lines" and "Flare unions on both lines" put one on each line, side by side.
  After the add, the new accessory's card takes over.
- **An accessory's own card:**
  - Edit: ±50 or ±100 mm along its straight, or a typed distance from the start point. A move into a fitting is
    refused, with the range that fits.
  - Swap: the kinds its line takes, its own marked.
  - Add: "Take it out". The straight's card comes back.

**Drawn:**
- **Plan** (`refrigerantAccessoryGlyphs.ts`): a symbol on the pipe, turned with its straight, at the body's size or at
  least 22 px on screen. The symbols are drawn in the line's plan colour on a white body:
  - a valve's bow-tie, ball and handle;
  - a Y-strainer's body, screen leg and cap;
  - a sight glass's window with its green moisture indicator;
  - a flare union's two nuts.
- **3D** (`three3d/refrigerantAccessoryMeshes.ts`), standing proud of the insulation:
  - a brass ball valve with its stem, and a red (gas) or blue (liquid) lever;
  - a steel Y-strainer with its screen leg and cap;
  - a brass sight glass with a green dome;
  - a union's brass nuts.

**Bill of materials:** the refrigerant side has no BOM yet (ducts and drains do). Accessories are listed in the line's
inspector, among its pieces.

## Condensate drains

### Pieces (`condensate/condensatePieces.ts`, Phase 3)

A drain run's pieces are listed in flow order:
- the unit connection: a pumped unit's hose or a gravity unit's stub, with its trap;
- the pump riser;
- the legs between plan bends, their 45° level changes and crown steps included;
- the bends;
- how the run ends: into a main by a wye, a joint it continues through, or the head of the drop;
- the termination: a drop to a gully or stack, or a wall outlet;
- the rodding eyes, air vents and wall sleeves.

**Keys** are ordinals along the run (`start`, `riser`, `leg:n`, `bend:n`, `end`, `termination`, `eye:n`, `vent:n`,
`sleeve:n`), because a re-solve renames the fittings' ids.

**Picking:**
- In plan, the nearest piece wins, a fitting favoured by its own size, so a riser owns its foot without swallowing its
  hose at a far zoom.
- A drop, a point in plan, gets a ring to rest on.
- In 3D, the drain's edit gizmo owns the pointer over a selected run, so hover and click come from it.

### Figures (`condensatePieceFigures.ts`)

- **The run:** its pipe system, size and bore, insulation, and what it carries: the units upstream and their design
  flow.
- **A leg:**
  - its governing fall against the minimum and preferred falls, its 45° offsets told apart;
  - its capacity half full at that fall (Manning) against the design flow;
  - its invert levels;
  - its head margin above the minimum-fall profile.
  - The margin comes from one baseline solve of the network, shared per drawing and network
    (`condensateSessionFor`).
- **Other pieces:**
  - a riser's lift against its unit's pump head;
  - the hose and trap;
  - a bend's angle and elbow;
  - how the run ends;
  - a termination's kind, trap, air break and drop;
  - the refrigerant crossings and the hangers on the piece.
- **Checks are kept to their piece:**
  - the pump lift on the riser;
  - the trap on the connection;
  - joining from the top on the end;
  - the air break on the termination;
  - a fall on the leg that falls too little.

### Options (`condensateSegmentOptions.ts`, Phase 4)

Every option is one edit of the network. It is solved again along the network's routes by the same edit session the
drain handles use: continuous fall, risers, 45° offsets, wyes from the top, sizes, fittings and crossings, with ids
kept.

**What each row shows:**
- the engine's verdict ("Fall 1:50 · margin 254 mm"), or its reason for refusing;
- the change in the network's head margin;
- the drainage checks it would newly fail.

| Tab | Options |
|---|---|
| Swap | A run one or two catalogue sizes up, or back to its automatic size; a termination's kind (floor gully, stack, wall outlet) and its trap |
| Edit | The network's fall (1–2.5 % or typed; the row says it is the whole network); a level the run keeps under; a leg moved sideways; a pumped riser's height up to the pump head; a branch's wye slid along its main; a termination's inlet level |
| Add | A bend at a leg's middle, a bend taken out, a rodding eye added or taken out, an air vent at a pumped main's head |

The wye handle and the card slide a wye the same way: `wyeSlideFor`, `wyeJunctionRoutes` and `slideWyeRoutes` live in
`condensateRouteOps.ts`.

## Inspectors and bars (Phase 5a)

- **`segments/SegmentPieceList.tsx`** lists a run's pieces in its inspector. Each row has the card's tag, a name, and a
  length, rise or angle. Accessories are listed by kind with their body length.
  - A row's click pins its card.
  - The pinned piece's row is marked and kept in view, however it was pinned.
- **The refrigerant toolbar** keeps the run tools: the edit scope, Move, Rotate, Branch kit and Details. A straight's
  length, Split and Remove point are on the piece's card.
- **The drain bar** keeps Re-route, Rodding eye (placing eyes by clicking on the run), Lock, Release and Delete. The
  size, fall and riser controls, the Bend button and the level limit's clear button are on the cards, with previews.

## Engineering basis and provenance

- **Sizes, limits, kits and allowances** come from the active manufacturer rule profile, each value with its source.
  With none loaded, the card says so; it never makes up a recommendation.
  - Sizes come from the ACR copper series (6.35–53.98 mm).
  - Bend allowances count only when the profile has them.
- **Practice values, flagged in the card:**
  - the liquid-line charge per metre (typical R410A values; the outdoor unit's table governs);
  - the accessory body sizes;
  - the 30 mm clearance between bodies and fittings.
- **Drainage** uses the condensate design settings, each with its provenance (`condensateSettings.ts`). The fall,
  capacity (Manning, half full) and the head margin come from the network planner itself, so what a card previews is
  what is applied.

## Verification

**Unit tests**, per phase (all in `packages/drawing-engine`):
- the store and provider contract (0);
- refrigerant pieces, figures, options and provider (1–2);
- condensate pieces, figures, options and provider (3–4);
- the inspector rows (5a);
- `refrigerantAccessories.test.ts` (5b, 19 tests): bodies, the reader, free places, problems and re-attachment, picks,
  the plan symbol and 3D body, the options per line and on both lines, each edit judged, locked lines, corners added
  past and onto an accessory, the card and the inspector row.

**Canvas drivers** live in `D:\claude-tmp-vrf-check`. They use the mouse and keyboard only, and each restores the
project exactly.

| Driver | Phase | Checks |
|---|---|---|
| `pipe-seg-refrigerant` | 1 | 17 |
| `pipe-seg-kit` | 1 | 5 |
| `pipe-seg-options` | 2 | 16 |
| `pipe-seg-kit-options` | 2 | 11 |
| `cd-seg-pieces` | 3 | 14 |
| `cd-seg-options` | 4 | 13 |
| `pipe-seg-inspector` | 5a | 8 |
| `pipe-seg-accessories` | 5b | 22 |

**Final regression (13 October 2026, on `44b45b5`):**
- **Unit tests:** the full suite passes, 254 files and 2207 tests (43 skipped, the benchmarks).
- **Type-check:** clean.
- **Lint:** clean on every file this work touched. The package's other lint errors are in files it did not touch.
- **Canvas:** 26 drivers. Each passed, restored the project exactly, and threw no page errors. The one console error,
  a resource 404, predates this work.

| Group | Drivers and checks |
|---|---|
| Pipe cards | `pipe-seg-refrigerant` 17, `pipe-seg-kit` 5, `pipe-seg-options` 16, `pipe-seg-kit-options` 11, `pipe-seg-inspector` 8, `pipe-seg-accessories` 22 |
| Drain cards | `cd-seg-pieces` 14, `cd-seg-options` 13 |
| Duct cards | `duct-seg-p1` 16, `-p2` 22, `-p3` 29, `-p4` 16, `-p5` 14, `-v2` 10, `-v2-highlight` 5, `-views` 8, `-click` 8 |
| Duct fittings and tags | `duct-round-rect` 10, `duct-y-junction` 9, `duct-tags` 14 |
| Air systems and Auto route | `air-p1` 25, `air-p2` 23, `air-p3` 14, `duct-cross-room` 18, `duct-second-pass` 5, `duct-partial-apply` 6 |

## Known limits and open items

**Limits of what was built:**
- A size swap resizes the whole line (one element is one tube size). Resizing a single straight, or "downstream to the
  next kit", would need the line split with a reducer: not offered yet.
- The pair switch is Gas | Liquid; the planned "Both" was not needed. Geometry edits always move both lines, and size
  and insulation are per line.
- No cost chips on the refrigerant side, because no installation rates are set there.
- A kit can be turned over only while no pipe holds it. There is one kit model in the library, and no rotate option.
- The refrigerant side has no BOM. Accessories are listed in the inspector, and their bodies are practice sizes.
- An accessory without room shows in its card, in the options that would cause it, and in the drawing (dashed red in
  plan, red in 3D). It is not in the VRF checks panel.
- An Auto route that rebuilds an unlocked circuit replaces its lines, and their accessories go with them. A locked
  circuit is kept as it is.
- A pair's concentric 90° bends overlap in plan, so a click on the gas bend can pin the liquid bend. The Gas | Liquid
  switch goes to the other one.

**Found while verifying, not changed** (each is the user's decision):
- In the plan, a Space+drag pan that starts on a refrigerant pipe moves the pipe instead of panning. The overlay's pipe
  drag does not check for a held Space. It predates this work.
- The test project's own cassette has no drain route (boxed in by its refrigerant pair). The drain drivers place two
  cassettes and a gully, and Auto route the selection.
- `autoRouteNetwork.geometry.test.ts` times out now and then in the full suite, and passes alone.
- Duct take-off pick regions cover short runouts (duct cards).
