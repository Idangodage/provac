# The 3D building audit (1 November 2026)

Six 3D screenshots of a user's building, and their drawing (JSON export, kept as
`packages/drawing-engine/src/components/canvas/hvac/__fixtures__/users-building-nov-scene.json`:
three FDUM ducted units with 8, 7 and 8 terminals, three FDT28 cassettes, one FDC280,
one gully, 19 walls of 2700 mm, five rooms). Fifteen issues were found; this note says
what each was, what was done, and what is still open. Decisions the user took are
marked *(decided)*.

## On the user's drawing, before and after

Auto route, every service, as the app runs it (`autoRouteBuildingNov.test.ts`, gated by
`AUTO_ROUTE_BUILDING=1`; the figures from `audit-probes/layoutReport.ts`).

| | As applied (1 Nov) | Now |
| --- | --- | --- |
| Units on refrigerant | 6 / 6 | 6 / 6 |
| Refrigerant mains | stacked: gas 2406, liquid 2266 mm | side by side at 2840 mm |
| Mains in the rooms below the 2400 ceiling | gas 66 %, liquid 85 % of length | none |
| Terminals with a duct | 7 / 15 (two rooms empty) | 15 / 15 |
| Longest collar transition | 1860 mm | 1264 mm |
| Three joints inside 500 mm | 10 places | none |
| Drains | 58.4 m, doubled 3.5 m | 44.7 m, nothing doubled |
| Clashes | 0 | 0 |
| VRF checks shown | 39 | 20, all open on their merits (below) |
| Auto route | — | about 60 s in plain Node |

## What was wrong, and what was done

1. **Two rooms without ducts, and no word of it.** The 14° design taper made every collar's
   transition 1.7 to 1.9 m; DU-1 and DU-3 had no such room, got no layout, and "Apply complete
   parts" left their terminals unconnected with nothing on the canvas. Now: a 22° taper (just
   inside SMACNA's 22.5°); a saved 14 takes it. A main narrowed by constant friction is widened
   until its collar transition fits its leg. A terminal in a system that no duct reaches is a
   warning on the terminal (`DU_TERMINAL_NOT_DUCTED`); a unit Auto route leaves out keeps the
   reason, and the warning repeats it. Auto route turns a ducted unit whose terminals are behind
   its collars, as it does a 4-way cassette *(decided)*, shown in the preview, kept only if the
   unit is then designed, never one turned by hand or locked.
2. **Refrigerant mains in the rooms, below the ceiling** and **3. gas and liquid knotting at
   every connection.** The pair is now laid side by side on one level, high in the void, over
   what it can clear and round what it cannot *(decided)*; both lines step at one station. Where
   the liquid would meet the gas (at a tee, on a kit's branch) it dips 125 mm under it on plumb
   steps, two full bends each (`pairDips.ts`); the gas never dips (an oil trap). Where side by side cannot reach
   every unit the pair is stacked, gas over liquid, and said so. A layout with mains in the rooms
   below the ceiling ranks after any that has none; where it is the only one, it is said in the
   preview and flagged on each run (`REFRIGERANT_BELOW_CEILING`) *(decided: a last resort with a
   visible warning)*. Setting: Route defaults, "pair arrangement".
4. **Drains wandering and running double.** The router's grid thinning dropped the network's own
   lines, so a branch ran beside the main and hooked in further on: those lines now stay. The
   search knows how high the drain can still be along its length, so it passes over a low duct or
   terminal where it is high enough (held above it), and under a refrigerant line where it must
   (held down from there on). Where that leaves a unit out, the routes that keep round every body
   are tried too.
5. **The Y fitting had no body**: routers and the clash check saw a hole there. It has one now;
   only the branches off its outlets touch it.
6. **Heights that disagreed.** One building section (`buildingSection.ts`): the ceiling (what
   sits flush with it says), the soffit (a service's own setting, else the routing ceiling limit),
   read by drains, duct hangers and moves. New walls are 2900 high, to the soffit *(decided)*;
   older walls are flagged (`BUILDING_WALL_LOW`, advisory) and raised in one click. Sleeves stand
   where a wall holds the pipe at its own height, derived from the walls as they are (3D, plan,
   BOM): none floats above a wall. Refrigerant lines get sleeves too (3D, the penetration
   schedule, the BOM).
7. **1.8 m transitions**: see 1.
8. **Hanger bars wider than the duct** at a transition's narrow end: sized to the section where
   they hang.
9. **Stacked short duct pieces**: a take-off and its damper are one assembly (no joint between,
   one schedule row); the shortest make-up is 300 mm (a saved 200 takes it), and what is left of a
   leg after a transition goes into the transition.
10. **Auto route failing its own checks.** Kits are made insulated. The straight off a branch kit
    is one figure for the router and the check: the project's (Route defaults) until the maker's
    is loaded. A liquid line is not judged for low points (the oil comes back in the gas line),
    and a main above the units is not a "rise and fall". The FDT28's pipe sizes were the drawn
    flare stubs' (13.2 / 15 mm, liquid larger than gas); they are the maker's 9.52 / 6.35.
11. **Every elbow looked broken** and **12. kits were bare copper**: the Insulated view is the
    default *(decided)*; kits wear their cover in it. Copper detail stays for inspection.
13. **Cassettes looked like glass**: drawn solid.
14. **A spiky selection outline**: a duct's outline traces the duct, not its rods.
15. **Supports**: drain rods keep off bends; "Show supports" governs 3D; refrigerant lines have
    clips on rods to the soffit (1.5 m apart to Ø19.05, 2 m above; practice), in 3D and the BOM.

## Still open

- **The straight off a branch kit.** The router and the check both read 300 mm (Route defaults).
  500 mm (LG's 20 in, the check's former fallback) makes the pair wrap DU-2's drain outlet on the
  user's drawing: the drain must pass under the pair and can then no longer clear the ducts
  beyond, so Auto route falls back to mains below the ceiling. Set the maker's figure once MHI's
  DIS kit manual confirms it; both follow.
- **Two reducers** (`diameter-mismatch`): the seed run keeps the main's 19.05 mm to DU-3's 15.88
  mm connection. Capacity sizing of each leg needs the maker's data.
- **Seven pair spacings** (`pipe-pair-separation`): at the unit stubs the pair runs at the
  maker's port spacing (62 to 82 mm), not the field spacing (88.9 mm). Present before.
- **Ten kit catalogue advisories** (`BRANCH_PROFILE`) and **the outdoor unit** (187 % of an
  FDC280's capacity): design decisions for the user.
- **The low main with 45° steps** the plan described (mains just above the ceiling, round the
  ducts, hopping where they must) was not built: the side-by-side main high in the void reached
  every unit on this drawing. A void too shallow for it falls back to the stacked arrangement,
  with the warning. The price of side by side: the liquid dips (four elbows each) at the tees,
  and each unit's riser is longer (about 300 mm).
- The drawing's walls are 2700 mm: one click in the checks raises them to the soffit.
