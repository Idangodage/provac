# Rectangular ductwork: SMACNA construction, joints, supports, insulation and pre-insulated duct

Research checked 24 September 2026. This document records the construction rules the duct fabrication engine encodes, with their sources and how certain each one is. It does not certify a duct system for a particular project. The project specification and the authority having jurisdiction always take precedence.

The design that consumes these rules is in [Duct fabrication engine: design](hvac-duct-fabrication-design.md).

## Four constructions need separate rules

| Construction | Wall | Joints | Insulation | Primary source |
|---|---|---|---|---|
| **GI bare** | G-60 galvanised steel sheet, lock-forming grade (ASTM A653/A924) | SMACNA transverse joints: TDC/TDF (T-25a/b), formed flange (T-24, e.g. Ductmate), companion angle (T-22) | none | SMACNA 1995 |
| **GI + NBR** | as GI bare | as GI bare | closed-cell nitrile rubber sheet bonded to the outside | SMACNA 1995 + Armacell data |
| **Pre-insulated (PID)** | PIR or phenolic foam panel faced with aluminium on both sides | extruded aluminium/PVC profiles (invisible flange, traditional flange, F-profile) | the panel itself | P3ductal handbook + catalogue |
| **Flexible duct** | factory flexible duct, round | draw band to a metal collar | factory jacket | SMACNA 1995 §3.6–3.7 |

Externally insulated GI duct is exempt from cross-breaking/beading (SMACNA S1.15 and 1.8.1). Nothing else in the metal construction changes when NBR is added. The insulation only adds a takeoff, a heavier support load and a thermal-break insert at each trapeze.

## Source: SMACNA HVAC Duct Construction Standards, Metal and Flexible (1995)

The 2nd edition (1995, with Addendum 1, 1997) is published in full because US federal regulations incorporate it by reference: [law.resource.org](https://law.resource.org/pub/us/cfr/ibr/005/smacna.duct.1995.html). Tables and notes below were extracted from that text and are cited by table number and page. Figures on that page are images, and their notes are not in the text, so figure-only values are marked as coming from secondary sources.

Later editions (2005 3rd, 2020 4th) renumbered chapters, so hangers moved to chapter 5 and fittings to chapter 4. They are not freely available. The engine therefore cites the 1995 numbering, and every rule records its source so a newer edition can replace it.

### How to read the rectangular schedules (§1.8.1, p.1.12)

1. Use the table for the duct's static pressure class.
2. **The greater duct dimension sets the thickness for all four sides.** Reinforcement can still differ between the wide and the narrow side.
3. Column 2 is the thickness at which a side needs **no reinforcement** (flat joints are enough).
4. Columns 3–10 are reinforcement spacing options (3.0 m down to 0.6 m). Each cell gives a minimum thickness and a letter, the minimum rigidity class of each joint or intermediate reinforcement at that spacing. The letter applies to joint-to-joint, joint-to-intermediate or intermediate-to-intermediate intervals.
5. For the narrow side, check whether the chosen thickness is exempt in column 2. If not, "the joint rating cannot be less than" the letter in that side's row at the committed joint spacing.
6. A letter written after the thickness (for example `H-1.31G`) means the class may be reduced to that letter when an internal tie rod is used (§1.10). A `t` would make tie rods compulsory; none appears in the three metric tables used here.
7. "NOT DESIGNED" cells mean that spacing is not permitted for that width. Stay in your joint-spacing column until it becomes Not Designed, then move to a shorter column and add intermediate (between-joint) reinforcement.
8. On page 1.13 the tables note: "the right-most value continues to the end of the row because the minimum duct gage and reinforcement grade remain the same for shorter spacings."

**How blank cells are placed.** The text version of the tables drops blank cells, so the column of each value has to be recovered. The printed tables have two blank regions:
- **"NOT REQUIRED"**, upper right: small ducts at short spacings. Per note 8, the last value carries on to the right.
- **"NOT DESIGNED"**, lower left: large ducts at long spacings.

Rows that come before the first complete row are therefore left-aligned, and rows after the last complete row are right-aligned.

The transcription was checked mechanically on every row and column of the three tables, with no violations:
- Within a row, the class never rises as spacing shortens.
- Within a column, the class never falls as width grows.

The check script is `parse_smacna.py` in the research scratchpad; its output reproduces the tables below.

**Source typo.** Table 1-5M prints the band "701, 900" after "701, 750". It is recorded here as 751–900, which is also its imperial twin in Table 1-5 (31–36").

**Unusual cells kept as printed.** Table 1-5M row 351–400 reads `C-0.70` at 0.9 m, between `C-0.55` at 1.2 m and `B-0.55` at 0.75 m; row 351–400 also reads `B-0.70` at 0.6 m. These are thickness choices, not class inversions, so they are kept.

Cell format is `class-thickness(mm)[tie-rod class]`; `·` is blank. Thicknesses are the metric equivalents of 26/24/22/20/18/16 ga: 0.55 / 0.70 / 0.85 / 1.00 / 1.31 / 1.61 mm.

### Table 1-3M: 125 Pa, positive or negative (p.1.19)

| Longer side (mm) | No reinf. (mm) | 3.0 m | 2.4 m | 1.8 m | 1.5 m | 1.2 m | 0.9 m | 0.75 m | 0.6 m |
|---|---|---|---|---|---|---|---|---|---|
| ≤250 | 0.55 | · | · | · | · | · | · | · | · |
| 251–300 | 0.55 | · | · | · | · | · | · | · | · |
| 301–350 | 0.55 | · | · | · | · | · | · | · | · |
| 351–400 | 0.55 | · | · | · | · | · | · | · | · |
| 401–450 | 0.55 | · | · | · | · | · | · | · | · |
| 451–500 | 0.70 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | A-0.55 | A-0.55 |
| 501–550 | 0.85 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | A-0.55 |
| 551–600 | 0.85 | C-0.55 | C-0.55 | C-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 |
| 601–650 | 1.00 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 |
| 651–700 | 1.31 | C-0.70 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | B-0.55 | B-0.55 | B-0.55 |
| 701–750 | 1.31 | C-0.70 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | B-0.55 | B-0.55 | B-0.55 |
| 751–900 | 1.61 | D-0.85 | D-0.70 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | B-0.55 |
| 901–1000 | — | E-1.00 | E-0.70 | D-0.70 | D-0.55 | C-0.55 | C-0.55 | C-0.55 | C-0.55 |
| 1001–1200 | — | E-1.00 | E-0.85 | E-0.70 | E-0.55 | D-0.55 | D-0.55 | C-0.55 | C-0.55 |
| 1201–1300 | — | F-1.31 | F-1.00 | E-0.85 | E-0.55 | E-0.55 | E-0.55 | D-0.55 | C-0.55 |
| 1301–1500 | — | G-1.31 | F-1.00 | F-0.85 | E-0.70 | E-0.70 | E-0.55 | E-0.55 | D-0.55 |
| 1501–1800 | — | H-1.61 | H-1.31 | F-1.00 | F-0.85 | F-0.70 | E-0.70 | E-0.70 | E-0.70 |
| 1801–2100 | — | · | I-1.61G | H-1.31G | H-0.85G | G-0.70 | F-0.70 | F-0.70 | F-0.70 |
| 2101–2400 | — | · | I-1.61G | I-1.31G | H-1.00G | H-0.85G | G-0.85 | F-0.85 | F-0.85 |
| 2401–2700 | — | · | · | · | I-1.31G | I-1.31G | H-1.31G | H-1.31G | G-1.31 |
| 2701–3000 | — | · | · | · | · | · | H-1.31G | H-1.31G | H-1.31G |

### Table 1-4M: 250 Pa, positive or negative (p.1.21)

| Longer side (mm) | No reinf. (mm) | 3.0 m | 2.4 m | 1.8 m | 1.5 m | 1.2 m | 0.9 m | 0.75 m | 0.6 m |
|---|---|---|---|---|---|---|---|---|---|
| ≤250 | 0.55 | · | · | · | · | · | · | · | · |
| 251–300 | 0.55 | · | · | · | · | · | · | · | · |
| 301–350 | 0.70 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | A-0.55 | A-0.55 | A-0.55 |
| 351–400 | 0.85 | B-0.70 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | A-0.55 |
| 401–450 | 0.85 | B-0.70 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 |
| 451–500 | 1.00 | C-0.70 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | B-0.55 | B-0.55 | B-0.55 |
| 501–550 | 1.31 | C-0.70 | C-0.70 | C-0.55 | C-0.55 | C-0.55 | B-0.55 | B-0.55 | B-0.55 |
| 551–600 | 1.31 | C-0.70 | C-0.70 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | B-0.55 | B-0.55 |
| 601–650 | 1.31 | D-0.85 | D-0.70 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | B-0.55 |
| 651–700 | 1.61 | D-0.85 | D-0.70 | D-0.55 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | C-0.55 |
| 701–750 | 1.61 | E-0.85 | D-0.70 | D-0.55 | D-0.55 | C-0.55 | C-0.55 | C-0.55 | C-0.55 |
| 751–900 | — | E-1.00 | E-0.85 | E-0.70 | D-0.70 | D-0.55 | C-0.55 | C-0.55 | C-0.55 |
| 901–1000 | — | F-1.31 | F-1.00 | E-0.85 | E-0.70 | E-0.55 | D-0.55 | D-0.55 | C-0.55 |
| 1001–1200 | — | G-1.61 | G-1.31 | F-1.00 | F-0.85 | E-0.70 | E-0.55 | E-0.55 | D-0.55 |
| 1201–1300 | — | H-1.61 | H-1.31 | G-1.00 | F-0.85 | F-0.70 | E-0.70 | E-0.70 | E-0.70 |
| 1301–1500 | — | · | H-1.31 | G-1.00 | G-0.85 | F-0.70 | F-0.70 | E-0.70 | E-0.70 |
| 1501–1800 | — | · | · | H-1.31G | H-1.31G | H-0.85G | F-0.70 | F-0.70 | F-0.70 |
| 1801–2100 | — | · | · | I-1.61G | I-1.31G | I-1.00G | H-0.85G | H-0.85G | G-0.85 |
| 2101–2400 | — | · | · | · | I-1.61H | I-1.31H | I-1.00G | H-1.00G | H-0.85G |
| 2401–2700 | — | · | · | · | · | I-1.31H | I-1.31G | I-1.31G | I-1.31G |
| 2701–3000 | — | · | · | · | · | · | I-1.31H | I-1.31H | I-1.31G |

### Table 1-5M: 500 Pa, positive or negative (p.1.23)

| Longer side (mm) | No reinf. (mm) | 3.0 m | 2.4 m | 1.8 m | 1.5 m | 1.2 m | 0.9 m | 0.75 m | 0.6 m |
|---|---|---|---|---|---|---|---|---|---|
| ≤250 | 0.55 | · | · | · | · | · | · | · | · |
| 251–300 | 0.70 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | → |
| 301–350 | 0.85 | B-0.70 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | B-0.55 | → |
| 351–400 | 1.00 | C-0.85 | C-0.70 | C-0.70 | C-0.55 | C-0.55 | C-0.70 | B-0.55 | B-0.70 |
| 401–450 | 1.00 | C-0.85 | C-0.70 | C-0.70 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | B-0.70 |
| 451–500 | 1.31 | C-1.00 | C-0.85 | C-0.70 | C-0.55 | C-0.55 | C-0.55 | C-0.55 | C-0.55 |
| 501–550 | 1.61 | D-1.00 | D-0.85 | D-0.70 | D-0.55 | C-0.55 | C-0.55 | C-0.55 | C-0.55 |
| 551–600 | 1.61 | E-1.00 | E-0.85 | D-0.70 | D-0.55 | D-0.55 | C-0.55 | C-0.55 | C-0.55 |
| 601–650 | — | E-1.00 | E-0.85 | E-0.70 | D-0.55 | D-0.55 | C-0.55 | C-0.55 | C-0.55 |
| 651–700 | — | F-1.31 | E-1.00 | E-0.85 | E-0.70 | D-0.55 | D-0.55 | C-0.55 | C-0.55 |
| 701–750 | — | F-1.31 | F-1.00 | E-0.85 | E-0.70 | E-0.55 | D-0.55 | D-0.55 | C-0.55 |
| 751–900 ¹ | — | G-1.61 | G-1.31 | F-1.00 | F-0.85 | E-0.70 | E-0.55 | D-0.55 | D-0.55 |
| 901–1000 | — | · | H-1.61 | G-1.31 | G-1.00 | F-0.70 | E-0.70 | E-0.55 | E-0.55 |
| 1001–1200 | — | · | I-1.61 | H-1.31 | H-1.00 | G-0.85 | F-0.70 | F-0.70 | E-0.70 |
| 1201–1300 | — | · | · | I-1.61G | H-1.31G | H-1.00G | G-0.70 | F-0.70 | F-0.70 |
| 1301–1500 | — | · | · | I-1.61G | H-1.31G | H-1.31G | G-0.85 | G-0.70 | F-0.70 |
| 1501–1800 | — | · | · | · | I-1.61H | I-1.31G | H-0.85G | H-0.85G | H-0.70 |
| 1801–2100 | — | · | · | · | · | J-1.31G | I-1.00G | I-0.85G | I-0.85G |
| 2101–2400 | — | · | · | · | · | J-1.31I | I-1.31H | I-1.00H | I-0.85H |
| 2401–2700 | — | · | · | · | · | · | K-1.31H | J-1.31H | I-1.31H |
| 2701–3000 | — | · | · | · | · | · | · | K-1.31I | J-1.31I |

¹ The source prints "701, 900". `→` marks the note-8 continuation of the last value.

**Worked cells used as test fixtures** (500 Pa, 1.2 m joint spacing):

| Longer side | Result | Note |
|---|---|---|
| 251–300 mm | `B-0.55`, or 0.70 unreinforced | |
| 601–650 mm | `D-0.55` | |
| 1001–1200 mm | `G-0.85` | the design plan's draft misread this as F-0.70 |
| 1501–1800 mm | `I-1.31G` | the draft misread this as H-0.85G |

Tables 1-6M to 1-9M (750 to 2500 Pa) are in the source but are not transcribed yet. The engine must refuse those pressure classes with an explicit message rather than extrapolate.

### Joint rigidity: Table 1-12M (p.1.37)

Letter classes map to members. T-24 and T-25 flanges are formed from the duct wall, so their rating depends on the duct thickness. `(R)` = tie-rodded; `+`/`−` = pressure-mode restriction; C/H = cold-formed / hot-rolled.

| Class | EI (kN·m²) | T-22 companion angle (H×T mm) | T-24 formed flange (duct t) | T-24a (H×T) | T-25a/b TDC/TDF (duct t) |
|---|---|---|---|---|---|
| A | 0.12 | use E | use D | use D | use D |
| B | 0.29 | use E | use D | use D | use D |
| C | 0.55 | use E | use D | use D | use D |
| D | 0.78 | use E | ±0.55 | 25×0.85 | ±0.55 |
| E | 1.90 | 25×3.2 | ±0.70 | use F | ±0.70 |
| F | 3.70 | 25×3.2 hot-rolled | ±0.85 | 38.1×1.00 | ±0.85 |
| G | 4.50 | 31.8×3.2 | ±0.85 (R) or ±1.00 | 38.1×1.31 | ±0.85 (R) or ±1.00 |
| H | 6.3 (+) / 7.6 (−) | 38.1×3.2 (cold-formed +; hot-rolled ±) | +1.31 | see tie-rod text | +1.31 |
| I | 20 | 38.1×6.4 | ±1.00 (R) | — | ±1.00 (R) |
| J | 23 | 38.1×6.4 (+) or 51×3.2 | ±1.31 (R) | — | ±1.31 (R) |
| K | 30 | 51×4.8 | ±1.31 (R) | — | ±1.31 (R) |
| L | 60 | 51×6.4 | ±1.31 (R) | — | ±1.31 (R) |

- **T-24a** is limited to 500 Pa in either pressure mode.
- **Slip-on flanges** (proprietary): "consult manufacturers" (S1.18). See the Ductmate section below.
- **Tie rods at T-22:** one rod serves both angles (S1.19.3).

### Intermediate reinforcement: Table 1-10M, angle column (p.1.33)

Used only when a section is longer than the permitted reinforcement spacing.

| Class | A | B | C | D | E | F | G | H | I | J | K | L |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Angle H×T (mm) | use C | use C | 25×1.61 C or 19.1×3.2 C | 19.1×3.2 H or 25×3.2 C | 31.8×2.75 C or 25×3.2 ² | 31.8×3.2 H | 38.1×3.2 | 38.1×4.8 or 51×3.2 | 51×4.8 C or 63.5×3.2 | 51×4.8 H, 51×6.4 C or 63.5×3.2 (+) | 63.5×4.8 | 63.5×6.4 H |

² The C/H letter for the second class-E option is garbled in the text source. The engine uses the first listed member.

Channel, zee and hat-section alternatives exist in the same table but are not needed for the first implementation.

### Transverse joint notes (Fig. 1-4 notes, pp.1.62–1.63)

**T-22 companion angle**
- Angles have welded corners.
- They are tack-welded, riveted, bolted or screwed to the duct wall at ≤305 mm spacing, beginning and ending with fasteners at the corners.
- Bolts are ≥5/16″ (8 mm) at ≤152 mm spacing up to 1000 Pa, and ≤102 mm above 1000 Pa (also on 3.2 mm angles at 1000 Pa).
- With flush flange faces, thick sealant may replace the gasket. Otherwise use a gasket that does not protrude into the duct.

**T-24 formed flange**
- Steel corner pieces of ≥16 ga (1.61 mm) with ≥3/8″ (9.5 mm) bolts close the corners.
- Gasket ≥6.4 × 13 mm, continuous around the joint.
- Mating flanges are locked by 152 mm (6″) clips located within 152 mm of each corner.
- Further clips at ≤381 mm centres for ≤750 Pa, and ≤305 mm for 1000–2500 Pa.

**T-24a**: assembled per Fig. 1-15. Limited to 500 Pa unless supplementally reinforced.

**T-25a / T-25b**: the TDC® and TDF® systems. Assembly specifications are in Fig. 1-15, which is an image. The engine applies the T-24 clip and corner rules to TDC/TDF and marks the cleat spacing `verified: false` until Fig. 1-15 is read.

**Fasteners and seams (S1.40–S1.41, p.1.61)**
- Where bar or angle reinforcement backs up a joint, it is fastened within 76 mm of the joint, within 51 mm of the corners, and at ≤305 mm intervals.
- Fasteners on steel duct are steel.
- Blind rivets with pull-through mandrels are not allowed if they leave holes.
- Fasteners project ≤13 mm into the duct.

**Longitudinal seams (Fig. 1-5 notes)**
- **L-1 Pittsburgh:** pocket 6.4–16 mm, typically 8–9.5 mm.
- **L-2 button-punch snaplock:** 16 mm pocket for 0.70–1.00 mm and 12.7 mm for 0.55–0.70 mm. Allowed up to 1000 Pa. At 1000 Pa, and at 750 Pa for widths over 1219 mm, screws are required at the ends.
- **L-4 standing seam:** 25 mm up to 1067 mm wide, 38 mm above.
- **L-5 / L-6 corner seams.**

**Cross-break or bead (S1.15)**: required on sides ≥483 mm that are ≤1.00 mm thick with more than 0.93 m² of unbraced panel. Not required when the duct is lined or externally insulated.

**Seal classes (Table 1-2, p.1.8)**

| Class | What is sealed | Pressure class |
|---|---|---|
| A | All transverse joints, longitudinal seams and duct wall penetrations | ≥1000 Pa |
| B | Transverse joints and longitudinal seams | 750 Pa |
| C | Transverse joints | 500 Pa |

- Ducts at 250 Pa and 125 Pa need no sealing under this manual, except VAV supply upstream of the boxes, which is Class C.
- Many project specifications require Class A everywhere. This is a project setting.

**Material (S1.1)**: G-60 galvanised steel, lock-forming grade, ASTM A653/A924, minimum yield 207 MPa.

### Proprietary formed-flange system: Ductmate 25 / 35 / 45

Source: [Ductmate '25'/'35'/'45' systems specification](https://ductmate.com/wp-content/uploads/2019/01/DuctmateSystemsSpec.pdf) and [Gemaire reprint](https://resource.gemaire.com/is/content/Watscocom/Gemaire/ductmate_d3510ga_article_1420814292569_en_subs.pdf).

| System | Duct thickness range | SMACNA equivalence (manufacturer) | Corner pieces | Cleat |
|---|---|---|---|---|
| DM25 | 26–20 ga (0.55–1.00 mm) | Class F transverse joint | DC25 clip/bolt corners | 20 ga roll-formed, 6″ |
| DM35 | 26–16 ga (0.55–1.61 mm) | Class J | DCIIIA/DCIIIB/DC35 | 20 ga roll-formed, 6″ |
| DM45 | 22–10 ga (0.85–3.5 mm) | Class K | electroplated bolt corners | 22 ga snap-on |

**Components per joint:** roll-formed flanges with integral mastic (four per duct end), four corner pieces per end, 440 butyl gasket (neoprene on request), cleats.

**Corners and bolts**
- Corner clips are 16 ga galvanised.
- Nuts and bolts are optional: 3/8″ × 1″ for DCIIIB corners.
- For DC25 corners the size glyph is lost in the text extraction. A search snippet reads 5/8″, which is implausible for a DC25 corner, so the engine uses M8 and marks it unverified.
- Rated for virtually no leakage from +10″ to −10″ w.g.; sealants meet NFPA 90A/B Class 1.

**Flange-to-duct screw schedule** (screws or spot welds)

| Duct side | ≤4″ w.g. (≤1000 Pa) | 6–10″ w.g. |
|---|---|---|
| ≤24″ (610 mm) | 1 screw each corner | 1 screw each corner |
| 25–48″ (635–1219 mm) | 1 each corner + 1 at centre | 2 each corner + 1 at centre |
| ≥49″ (1245 mm) | 1 each corner + 1 each 24″ (610 mm) | 2 each corner + 1 each 24″ |

**Cleat schedule**
- With 440 gasket: 6″ (152 mm) cleats at 24″ (610 mm) centres, at all pressures.
- With neoprene gasket: 24″ centres at ½–2″ w.g.; 18″ at 3–4″; 12″ at 6–10″.

The Ductmate schedule is the manufacturer's documented alternative to the generic T-24 clip rule (S1.18 allows proprietary systems on manufacturer ratings). The engine therefore applies the Ductmate schedule to Ductmate joints and the SMACNA T-24 rule to generic TDC/TDF.

### Fittings (figures read from the scanned PDF)

The figures are images in the text edition. They were read from the scanned 2nd-edition PDF (law.resource.org `smacna.duct.1995.pdf`, MD5 `32ef97f9b23a140aca03a587ae0d74e7`, local copy `D:\claude-tmp-vrf-check\research\`). PDF page = book page 2.N + 104 for chapter 2, 1.N + 20 for chapter 1, and 3.N + 136 for chapter 3. Every value below is `verified: true` in the engine (`ductFittingRules.ts`).

**Fig. 2-2 Rectangular elbows (p.2.3–2.4)**
- RE1 radius elbow: centreline R = 3W/2 unless otherwise specified; θ is not restricted to 90°. A square throat with R/W = 0.5 may be used up to 1000 fpm (5 m/s).
- RE2 square throat with vanes; RE3 radius with vanes; RE4 square throat without vanes (5 m/s max); RE5 dual radius (R1 = ¾ W1, R2 = R1 + W2); RE6 mitred.
- RE7–RE10 (45° throats, radius heels): all 45° throats are 100 mm minimum.
- Bead, cross-break and reinforce flat surfaces as in straight duct.

**Fig. 2-3 Vanes and vane runners (p.2.5)**

| Vane | Radius | Spacing | Minimum sheet |
|---|---|---|---|
| Single, small | 51 mm | 38 mm | 0.70 (24 ga) |
| Single, large | 114 mm | 83 mm | 0.85 (22 ga) |
| Double wall, small | 25 / 51 mm | 54 mm | 0.55 (26 ga) |
| Double wall, large | 57 / 114 mm | 83 mm | 0.70 (24 ga) |

Runner 38 mm minimum; runner type 1 is 0.85 mm (22 ga). The free area between double-wall vanes approximates the elbow inlet area. Other sizes are acceptable on designer approval.

**Fig. 2-4 Vane support in elbows (p.2.6):** maximum unsupported vane length 914 mm (single small and large), 1219 mm (small double), 1829 mm (large double). Beyond that, install vanes in sections or use tie rods. Vanes must be fastened to the runners. If W2 ≠ W1, special provisions are needed in vane shape (size-change elbows).

**Fig. 2-5 Divided flow branches (p.2.7):** Type 1 (Y with curved heels), Type 2 (bullhead tee, main 2W, splitter optional), Type 3, and Types 4A/4B with dampers (W, D2, D3 ≥ 102 mm). Volume control should be by branch dampers. A splitter, if shown, is 1.5 W or 1.5 D3 long.

**Fig. 2-6 Branch connections (p.2.8)**
- Straight tap: butt flange or clinch lock.
- 45° entry: L = W/4, 4″ (102 mm) minimum; close the opening at the corners.
- Rectangular main to round branch: 45° lead-in with D1 not less than D2.
- Round collars: conical, bellmouth, flanged, spin-in (beaded). Cut the opening accurately.
- Do not use connections with scoops.

**Fig. 2-7 Offsets and transitions (p.2.9)**
- Concentric transition: θ max 45° diverging, 60° converging (θ is the included angle).
- Eccentric transition: θ max 30° (45° only from round to flat oval).
- Offsets: Type 1 angled 15° max; Type 2 mitred 60° max; Type 3 radiussed (ogee) with a 150 mm minimum throat radius.
- Standard bellmouth: C = 76 mm, B = A + 102 mm, R = A/5.

The engine's flat-bottom reducer is concentric in plan (judged on the included angle) and eccentric in elevation (judged on the top slope). The 14° per-side design taper is project practice and sits inside both limits.

**Figs 2-12 / 2-13 Volume dampers (p.2.16–2.17)**
- Single blade up to 305 mm high:
  - Fig. A, up to 457 mm wide: 0.85 blade, 10 mm pin and quadrant, 3.2 mm clearance.
  - Fig. B, 483–1219 mm wide: 1.31 blade minimum, 13 mm continuous rod and quadrant.
- Over 305 mm high, use multiple blades (Fig. 2-13): 1.31 blades 152–229 mm wide, a 51 mm or 38 × 12.7 × 3.2 channel frame, 9.5 or 12.7 mm shafts, 1219 mm maximum frame width. Opposed or parallel action.
- Round damper (Fig. C): blade 0.70 minimum but not less than two gauges more than the duct; the rod is continuous at 500 Pa and on dampers over 305 mm diameter.
- Closed end bearings are required at 750 Pa and over.

**Fig. 2-17 Flexible connections at fan (p.2.21):** fabric (flame retardant) with 76 or 102 mm between the metal edges (254 mm maximum). Metal edges 76 mm each side. Fold, add sealant and staple at 25 mm centres.

**Fig. 1-15 Corner closures, flanges (p.1.81):** this covers T-24a, T-24, T-25a and T-25b tee flanges.
- Clips are 152 mm long minimum, the first within 152 mm of a corner, then at 381 mm maximum centres up to 750 Pa (305 mm above), 0.85 mm minimum.
- Corner pieces 1.61 mm minimum with a 9.5 mm minimum bolt; continuous gasket.
- Formed flanges without corner pieces are allowed to 500 Pa, with a bolt or rivet 25 mm from the end and at 150 mm intervals.

**Chapter 3 Round duct (p.3.1–3.12)**
- S3.1: fittings are not lighter than longitudinal-seam straight duct of the same diameter.
- S3.2: collars to rectangular duct per S3.1 and Figs 2-6, 2-15.
- S3.4: a branch saddle or direct connection is no more than ⅔ of the main diameter; no protrusion into the main; saddles sealed at all pressures.
- Table 3-1 (mitred or gored elbows):

  | Velocity | R/D | 90° pieces | 60° pieces | 45° pieces |
  |---|---|---|---|---|
  | up to 1000 fpm (5.1 m/s) | 0.6 | 3 | 2 | 2 |
  | 1001–1500 fpm | 1.0 | 4 | 3 | 2 |
  | above 1500 fpm (7.6 m/s) | 1.5 | 5 | 4 | 3 |

- Table 3-2AM (unreinforced, positive pressure; nominal mm; max diameter → spiral / longitudinal seam at +500 Pa):

  | Max Ø | Spiral | Long seam |
  |---|---|---|
  | 150 | 0.48 | 0.48 |
  | 200 | 0.48 | 0.48 |
  | 250 | 0.48 | 0.55 |
  | 300 | 0.48 | 0.55 |
  | 360 | 0.48 | 0.55 |
  | 400 | 0.55 | 0.70 |
  | 460 | 0.55 | 0.70 |
  | 660 | 0.55 | 0.70 |
  | 910 | 0.70 | 0.85 |
  | 1270 | 0.85 | 1.00 |
  | 1520 | 1.00 | 1.31 |
  | 2130 | 1.31 | 1.61 |

- Table 3-2BM (negative pressure, −500 Pa column; max diameter → spiral / longitudinal seam):

  | Max Ø | Spiral | Long seam |
  |---|---|---|
  | 150–250 | 0.48 | 0.48 |
  | 280–330 | 0.48 | 0.55 |
  | 360–380 | 0.48 | 0.70 |
  | 400–430 | 0.55 | 0.70 |
  | 460–500 | 0.70 | 0.85 |
  | 530–580 | 0.70 | 1.00 |
  | 600–660 | 0.85 | 1.00 |
  | 740–760 | 0.85 | 1.31 |
  | 840–860 | 1.00 | 1.31 |
  | 910–1070 | 1.00 | 1.61 |
  | 1220 | 1.00 | 1.31 + angle A (25 × 25 × 3.2) at 1.8 m |
  | 1520 | 1.31 | 1.31 + angle B (32 × 32 × 4.8) at 1.2 m |
  | 1830 | 1.61 | not designed |

- Fig. 3-1 seams: RL-1 spiral. At +500 Pa all seam types are permitted.
- Fig. 3-2 transverse joints:
  - RT-1 beaded sleeve 102 mm min (sleeve at least duct gauge); RT-3 drawband; RT-5 crimp with a 51 mm minimum lap.
  - Screws on RT-1, 4, 5 and 6 at 381 mm maximum along the circumference, three minimum up to 356 mm diameter.
  - RT-2 Van Stone flange: 8 mm bolts at 203 mm maximum.
- Fig. 3-3: pleated, stamped, adjustable and segmented elbows.

### Flexible duct (§3.5–3.7, pp.3.15–3.21, read from the scanned PDF pages 151–157)

**§3.5 Installation standards**
- **S3.19–S3.22:** "flexible air duct" means UL-classified flexible air ducts or connectors. Indoor comfort service only (not particulates, corrosive fumes, high temperature). Where NFPA 90A/90B applies, the duct is tested to UL 181 and installed to its listing.
- **S3.23:** the minimum length of flexible duct should be used.
- **S3.24:** bends with a centreline radius of at least one duct diameter. Ducts extend a few inches beyond the end of a sheet-metal connection before bending. Not compressed.
- **S3.25:** kept away from hot equipment (furnaces, steam pipes).
- **S3.27:** where the manufacturer's guidelines are more stringent, they govern.

**§3.6 Joining and attaching**
- **S3.28:** sealing per the duct sealing provisions; adhesives compatible with the materials.
- **S3.29:** ends trimmed square.
- **S3.30:** collars ≥51 mm long; joining sleeves ≥102 mm.
- **S3.31:** collars inserted ≥25 mm before fastening.
- **S3.32:** metallic flex duct fastened with ≥3 #8 screws, or ≥5 above 305 mm diameter, at least 13 mm from the end.
- **S3.33:** non-metallic flex duct fastened with a draw band, behind a bead on collars over 305 mm diameter.
- **S3.34:** insulation and vapour barrier fitted over the core connection and also secured with a draw band.
- **Fig. 3-7 (p.3.16):** forms M-UN (metallic uninsulated), M-I (metallic insulated), NM-UN (non-metallic uninsulated), NM-IL (non-metallic insulated, lined).
- **§3.6.1 accessories (p.3.18, Fig. 3-8):** metal and non-metallic clamps; collars: dovetail, spin-in flared, spin-in straight, spin-in conical; 4″ (102 mm) sleeve; collar in duct 2″ (51 mm) minimum.

**§3.7 Supporting**
- **S3.35:** supports at the manufacturer's interval but at least every 1.5 m. Maximum sag 41.7 mm per metre of spacing between supports. A connection to another duct or to equipment counts as a support.
- **S3.36:** hanger or saddle material in contact with the duct wide enough not to reduce the inside diameter, never less than 25 mm; narrower hangers with a sheet-metal saddle covering half the circumference.
- **S3.37–S3.39:** factory suspension systems acceptable; hangers attached to the structure; no single hanger carries the whole duct; damaged vapour barrier repaired with tape.
- **S3.40:** terminal devices connected by flexible duct are supported independently of the flexible duct.
- **Fig. 3-9 (p.3.20):** 1.5 m maximum between supports; sag ≤ 41.7 mm per metre; "duct should extend straight for several inches from a connection before bending". Closer intervals may be required by a UL listing.
- **Fig. 3-10 (p.3.21):** strap or saddle ≥25 mm wide; a 25 mm band clamp with a wire is optional; the support must not damage the duct or put it out of round.
- **Maximum length:** SMACNA sets none (S3.23 asks for the minimum). Institutional specifications cap runouts at 1.5–2.1 m (Texas State: 6 ft installed; another: 7 ft). The engine default is 1.5 m (practice, editable).

### Air terminals (chapter 2, read from the scanned PDF pages 122–124)

- **Fig. 2-14 Grille and register connections (p.2.18):** grille flanges must cover the duct flanges. A register contains volume control at the grille; a grille has none. A surface-mounted terminal in a lay-in ceiling rests on two supplemental terminal-to-duct support members bearing on the tee bars.
- **Fig. 2-15 Ceiling diffuser branch ducts (p.2.19):**
  - The ceiling support system must carry the diffuser's weight when flexible connections are used; a properly sized hole is cut in the tile, and the diffuser does not carry the tile.
  - Branch: round duct tap-in (Figs 2-6, 3-8) with the volume damper (if specified) at its preferred location, near the tap; then flexible duct or a connector; lay-in (25 mm exposed tee bar) or surface-mounted diffusers.
  - A rigid metal collar (drop) is shown; a flexible runout is preferred to adjust the rough-in to the installed ceiling pattern.
  - Add supports if the drop A exceeds 0.91 m (3 ft) or the diffuser is heavy. Maximum hanger spacing 3 m rectangular, 3.7 m round.
- **Fig. 2-16 Linear diffuser plenum (p.2.20):** strap across the plenum when its dimension A is 203 mm or more; neck typically 76 mm; 25 mm lining if specified.

**Terminal sizes (not SMACNA):** SMACNA gives no terminal dimensions. The engine's terminal table uses common catalog sizes (your decision, 27 September 2026: typical sizes, flagged "practice", replaced later with the chosen supplier's data).

### Hangers and supports (chapter 4)

**S4.1 (p.4.1):** supports per Tables 4-1 to 4-3 and Figs 4-1 to 4-8. **Horizontal ducts have a support within 0.61 m of each elbow and within 1.22 m (four feet) of each branch intersection.** Upper attachments carry at most one quarter of their proof-test failure load.

**§4.2.8:** hangers at the maximum spacing of 2.44 m or 3.05 m, even with one or two joints between them. Wide ducts need closer spacing.

**§4.2.10 risers:** angles or channels fastened to the duct sides, at one- or two-storey intervals (3.66–7.32 m). Over 762 mm wide, take care fastening to the sheet.

**Table 4-1M: rectangular duct hangers, minimum size, per pair** (p.4.6)

| Max half-perimeter P/2 (mm) | 3.0 m: strap / wire-rod ⌀ | 2.4 m | 1.5 m | 1.2 m |
|---|---|---|---|---|
| 760 | 25.4×0.85 / 3.4 | 25.4×0.85 / 3.4 | 25.4×0.85 / 2.7 | 25.4×0.85 / 2.7 |
| 1830 | 25.4×1.31 / 9.5 | 25.4×1.00 / 6.4 | 25.4×0.85 / 6.4 | 25.4×0.85 / 6.4 |
| 2440 | 25.4×1.61 / 9.5 | 25.4×1.31 / 9.5 | 25.4×1.00 / 9.5 | 25.4×0.85 / 6.4 |
| 3050 | 38.1×1.61 / 12.7 | 25.4×1.61 / 9.5 | 25.4×1.31 / 9.5 | 25.4×1.00 / 6.4 |
| 4270 | 38.1×1.61 / 12.7 | 38.1×1.61 / 12.7 | 25.4×1.61 / 9.5 | 25.4×1.31 / 9.5 |
| 4880 | not given / 12.7 | 38.1×1.61 / 12.7 | 25.4×1.61 / 9.5 | 25.4×1.61 / 9.5 |
| more | special analysis | | | |

**Single-hanger maximum loads**

| Hanger | Max load (kg) |
|---|---|
| Strap 25.4×0.85 | 118 |
| Strap 25.4×1.00 | 145 |
| Strap 25.4×1.31 | 191 |
| Strap 25.4×1.61 | 318 |
| Strap 38.1×1.61 | 500 |
| Wire/rod ⌀2.7 | 36 |
| Wire/rod ⌀3.4 | 54 |
| Wire/rod ⌀4.1 | 73 |
| Rod ⌀6.4 | 122 |
| Rod ⌀9.5 | 308 |
| Rod ⌀12.7 | 567 |
| Rod ⌀15.9 | 907 |
| Rod ⌀19.1 | 1360 |

**Table notes**
- The table allows for duct weight, 4.89 kg/m² of insulation, normal reinforcement and the trapeze, but no external loads.
- P/2 values assume duct ≤1.61 mm thick. When the widest side exceeds 1520 mm, the maximum P/2 is 1.25 × that width.
- Lap-joined straps: 25.4 × 0.85–1.31 need one 6.4 mm bolt; 25.4 × 1.61 needs two 6.4 mm bolts; 38.1 × 1.61 needs two 9.5 mm bolts. Bolts go in series.

**Metric rods (derived).** The tabulated rod loads equal about 6.2 kg per mm² of UNC tensile-stress area for every size: 1/4″ 122 kg ÷ 20.5 mm²; 3/8″ 308 ÷ 50.0; 1/2″ 567 ÷ 91.5; 5/8″ 907 ÷ 146; 3/4″ 1360 ÷ 215. The engine applies the same stress to ISO metric stress areas, and marks this as derived:

| Metric rod | Stress area (mm²) | Allowable (kg) |
|---|---|---|
| M8 | 36.6 | 227 |
| M10 | 58.0 | 360 |
| M12 | 84.3 | 523 |
| M16 | 157 | 973 |

M12 is slightly weaker than a 1/2″ rod, so the load check, not a naive size mapping, decides the rod. M8 is the practical minimum for trapeze rods.

**Table 4-2: round duct hangers** (p.4.7), maximum spacing 3.7 m throughout

| Diameter | Wire | Rod | Strap |
|---|---|---|---|
| ≤250 mm | one 2.75 mm | 6.4 | 25.4×0.85 |
| ≤460 mm | two 12 ga or one 4.27 mm | 6.4 | 25.4×0.85 |
| ≤610 mm | two 3.51 mm | 6.4 | 25.4×0.85 |
| ≤900 mm | two 2.7 mm (8 ga) | 9.5 | 25.4×1.00 |
| ≤1270 mm | — | two 9.5 | two 25.4×1.00 |
| ≤1520 mm | — | two 9.5 | two 25.4×1.31 |
| ≤2130 mm | — | two 9.5 | two 25.4×1.61 |

**Table 4-3M: allowable trapeze loads (kg)** (p.4.11)

Assumes steel yield ≥172.4 MPa and the hanger rod ≤152 mm from the duct side for lengths ≤2440 mm (≤76 mm for longer bars).

| Trapeze length (mm) | 25.4×1.61 | 25.4×3.2 | 38.1×1.61 | 38.1×3.2 | 38.1×4.8 | 38.1×6.4 / 51×3.2 | 51×4.8 | 51×6.4 | 63.5×4.8 | 63.5×6.4 |
|---|---|---|---|---|---|---|---|---|---|---|
| 450 | 36 | 68 | 81 | 159 | 231 | 295 | 426 | 558 | 680 | 889 |
| 600 | 34 | 68 | 81 | 159 | 231 | 295 | 426 | 558 | 680 | 889 |
| 760 | 32 | 68 | 81 | 159 | 231 | 295 | 426 | 558 | 680 | 889 |
| 900 | 27 | 59 | 72 | 154 | 227 | 281 | 417 | 549 | 671 | 880 |
| 1060 | 18 | 50 | 63 | 145 | 218 | 277 | 408 | 540 | 667 | 875 |
| 1220 | — | 36 | 50 | 132 | 204 | 263 | 395 | 526 | 653 | 862 |
| 1370 | — | — | — | 113 | 181 | 245 | 381 | 508 | 635 | 844 |
| 1520 | — | — | — | 86 | 159 | 222 | 354 | 480 | 608 | 818 |
| 1670 | — | — | — | 45 | 86 | 181 | 318 | 444 | 571 | 780 |
| 1830 | — | — | — | — | — | 145 | 281 | 408 | 535 | 744 |
| 2010 | — | — | — | — | — | 95 | 227 | 358 | 485 | 694 |

**How the engine reads these (Phase 3)**
- **Wide ducts:** when the widest side exceeds 1520 mm, P/2 is taken as at least 1.25 × that side. This is a conservative reading of the note.
- **Rods:** sized by the load check. The Table 4-1M minimum per pair is reported alongside for reference.
- **Elbows:** S4.1 asks for one support within 0.61 m of each elbow. The engine supports both sides of every level elbow (practice).
- **Spacing:** measured along the straight duct, since an elbow or offset is carried by the supports at its ends.
- **Joints and rods:** hangers sit 150 mm clear of joints (practice: "between flanges"), and rods leave 30 mm of thread below the bar (practice).
- **Risers:** supported per §4.2.10 at the interval from the settings. The angle sizes (L40×4 up to 762 mm wide, L50×5 over) are practice.

**Longer bars (2130–3660 mm).** These rows add 76×6.4 and 102×6.4 angles and 76/102 mm channels.
- At 2130 mm the text gives 454 kg for 51×4.8, which contradicts both its neighbours (227 kg at 2010 mm) and its section modulus. It is treated as an extraction error and not used.
- The rest of those rows: 2130: 51×6.4 299, 63.5×4.8 426, 63.5×6.4 635, 76×6.4 1048, 102×6.4 2123; 2440: 145, 272, 480, 894, 1969. They are transcribed in the catalog with that cell nulled.
- The source header "51 × 3.8" is a misprint for 51 × 4.8 (its 3.63 kg/m and Z = 3.11 × 10³ mm³ match a 51 × 4.8 angle).

### Galvanised sheet

The appendix sheet-weight table (A.7) is an image. The engine uses the manufacturers' standard galvanised gauge weights; confirm them against A.7 before relying on sheet mass for costing.

| Gauge | Nominal (mm) | Weight (lb/ft²) | Weight (kg/m²) |
|---|---|---|---|
| 26 | 0.55 | 0.906 | 4.42 |
| 24 | 0.70 | 1.156 | 5.64 |
| 22 | 0.85 | 1.406 | 6.86 |
| 20 | 1.00 | 1.656 | 8.08 |
| 18 | 1.31 | 2.156 | 10.53 |
| 16 | 1.61 | 2.656 | 12.97 |

**Commercial sheet stock is configuration, not engineering data.** The SMACNA tables give a minimum thickness. The engine then picks the smallest sheet in the project's stock list that is at least that thickness (never a thinner one).

The provisional stock list (Finland, per the user's review of 24 September 2026) is `[0.5, 0.6, 0.7, 0.75, 1.0, 1.25, 1.5]` mm:

| SMACNA minimum | Selected sheet |
|---|---|
| 0.55 | 0.60 |
| 0.70 | 0.70 |
| 0.85 | 1.00 |
| 1.00 | 1.00 |
| 1.31 | 1.50 (1.25 is too thin) |
| 1.61 | none available → explicit error |

The list is replaced with the actual fabricator or supplier stock without touching the SMACNA tables.

**Joint ratings after rounding.** Joint rigidity ratings (Table 1-12M) are tabulated at the SMACNA nominal thicknesses. The engine credits a rounded-up sheet only with the rating of the highest SMACNA nominal thickness it equals or exceeds; it never interpolates. For example, a 1.25 mm sheet (between 1.00 and 1.31) is rated as 1.00 mm.

**Common longest-side table (alternative mode).** Many specifications write gauge by longest side without reference to joint spacing. For example, Texas State 23 31 00 (low pressure):

| Longest side | Gauge (mm) |
|---|---|
| ≤12″ (≤300 mm) | 26 ga (0.55) |
| 13–30″ (301–750 mm) | 24 ga (0.70) |
| 31–54″ (751–1350 mm) | 22 ga (0.85) |
| 55–84″ (1351–2100 mm) | 20 ga (1.00) |
| ≥85″ (>2100 mm) | 18 ga (1.31) |

In this mode the engine does not claim SMACNA reinforcement compliance.

## Unit air ports: MHI FDUM22KXE6F-W (measured)

The only ducted unit in the catalog is a GLB converted by ifcopenshell and trimesh from the MEPcontent MACO VRF IFC4 file. The file holds 7 meshes, but only the last is placed in the node tree (the loader now places the other six itself; see the design doc), and the IFC distribution ports were dropped. The collars were measured from the geometry itself: flat collar lips 30 mm proud of the casing faces.

The GLB is rendered with its bounding-box centre at the element centre and its bottom face at the element's elevation (`glbModelCache.ts:121-126`). The bounding box is 1084 × 697 × 300 mm and runs from x −425 to 659 in the model's own frame. Converted to element-local coordinates (origin at the footprint centre, z up from the unit's bottom face):

| Port | Face | Collar outer W × H (mm) | Manufacturer nominal (mm) | Centre (x, y) | Centre z | Casing face → lip |
|---|---|---|---|---|---|---|
| **supply** (pressure side) | −Y | 674 × 164 | ≈680 × 170 | (−117, −348.5) | 152 | −318.5 → −348.5 |
| **return** (suction side) | +Y | 654 × 194 | ≈660 × 200 | (−117, 348.5) | 139 | 318.5 → 348.5 |

- **Face assignment is confirmed by the user against the MHI FDUM22 dimensions** (review of 24 September 2026). The pressure side is ≈680 × 170 mm and the suction side ≈660 × 200 mm, which match the −Y and +Y collars respectively.
- This is the **opposite** of the procedural `ducted-ac` convention (supply on +Y), which remains only as the fallback for units without measured ports.
- The procedural openings that the old duct tool used are centred at x = 0, i.e. 117 mm off the real collars.
- The duct inside dimension equals the collar outer dimension (the duct slips over the collar).

## Nitrile rubber (NBR / elastomeric) insulation

**Adhesive.** [ArmaFlex 520 brochure](https://www.armacell.com/sites/default/files/2025/06/10/ArmaFlex%20520%20Adhesive%20-%20Product%20Brochure%20-%20en-LU.pdf): yield with adhesive applied to both surfaces is 7–9 m² per litre for sheets, i.e. ≈0.11–0.14 L per m² of bonded sheet.
- Application temperature is ideally +20 °C, never below 0 °C.
- Full bond strength is reached after 168 h.
- The engine uses 8 m²/L of sheet area; tape and seam adhesive are separate rows.

**Other values (common manufacturer ranges, not yet tied to one datasheet; `verified: false`)**
- Sheet thicknesses 9 / 13 / 19 / 25 / 32 mm.
- λ ≈ 0.033–0.036 W/m·K at 0 °C.
- 50 mm self-adhesive tape on seams.
- Typical specifications use 25 mm on supply and 19 mm on return in conditioned ceiling voids. This is a project setting.

**Engine takeoff (Phase 3, practice unless noted)**
- **Area:** sheet at the insulation mid-plane (girth + 4t) over each piece's developed centreline length, plus end-cap faces.
- **Flanges:** each flange is boxed with a band 2 × its projection + 100 mm wide.
- **Connector:** left bare so it can flex.
- **Adhesive:** at 8 m²/L (Armacell 520, verified range 7–9).
- **Tape:** one longitudinal seam per 1 m of girth, plus both edges of every band.
- **Waste:** 10 %.

**At supports.** Insulation must stay continuous under the trapeze. A load-bearing insert (a high-density block or duct support insert) between the trapeze and the duct avoids crushing the insulation and a cold bridge. The support load includes insulation mass; SMACNA's hanger tables already allow 4.89 kg/m².

## Pre-insulated duct (PID): P3ductal

Sources:
- [P3ductal handbook for construction and installation of ducts](https://www.p3italy.it/wp-content/uploads/2018/02/P3_manuale_costruzione_condotte_eng.pdf)
- P3 catalogue as distributed by [Abans Engineering](http://abansengineering.lk/wp-content/uploads/2016/05/catalogue_gaine_P3.pdf)

The handbook illustrates 20 mm panels and states that the same methods apply to 30 mm panels.

**Panels** (catalogue): all 4000 × 1200 mm.

| Code | Foam | Density (kg/m³) | Thickness (mm) | Aluminium facing (µm) | λ at 10 °C (W/m·K) | Use |
|---|---|---|---|---|---|---|
| 15HP21 Piral HD Hydrotec | PIR | 52 ±2 | 20 | 80/80 embossed, lacquered | 0.024 | general HVAC |
| 15HL21 smooth | PIR | 52 ±2 | 20 | 80 smooth | — | — |
| 15HG21 | PIR | 48 ±2 | 20 | 60/60 | — | medium/small ducts |
| 15HP31 Big Size | PIR | 48 ±2 | 30 | 80 | — | large ducts |
| 15HS31 Outsider | PIR | 48 ±2 | 30 | 200 outside / 80 inside, waterproof coating | — | outdoor |
| 14PR01 Piralyte | phenolic | 60 ±2 | 20 | 80 | — | fire-performance applications |

The catalogue lists panel "rigidity classes" (e.g. 200 000, 900 000), the EN 13403 concept used to select reinforcement.

**Straight ducts: cutting method by inner sides (handbook §1)**

| Condition | Method |
|---|---|
| Sum of 4 sides ≤1040 mm | one piece from one panel |
| Sum of 3 sides ≤1080 | U + 1 |
| Sum of 2 sides ≤1120 | two L |
| Each side ≤1160 | four separate strips |
| Two opposite sides >1160 | cut widthwise and join; sections made this way are at most 1200 mm long |

Otherwise the duct length runs along the 4000 mm panel direction.

**Elbows (§4, §5)**
- Neck ≥50 mm, so the flange can be inserted.
- Minimum inner radius:

  | Duct height | Minimum inner radius |
  |---|---|
  | <500 mm | 150 mm |
  | 500–1000 mm | 200 mm |
  | >1000 mm | 250 mm |

- Ribbing (kerf) pitch for bent cheeks: 25 mm for R150–300; 35 for R301–500; 50 for R501–800; 80 above.
- Splitter vanes:

  | Width | Splitters | Positions |
  |---|---|---|
  | 400–800 mm | 1 | ≈A/3 |
  | >800–1600 mm | 2 | ≈A/4 and A/2 |
  | >1600–2000 mm | 3 | ≈A/8, A/3 and A/2 |

  None below 45° or on the smallest ducts.
- Raw-edge (square) elbows need aluminium turning vanes (21CP03) on a guide (21CP04). Vane height is the inner height minus about 8 mm. They are riveted to a plate, and the unit is fixed with screws (21RF03) and reinforcement discs (21RF01).

**Reductions and offsets (§7, §9)**: necks ≥50 mm; sloping sides drawn at 30°.

**Junctions (§10, §11)**: a gap of ≥45 mm (≥60 mm for 30 mm panel) between the 30° line and the arc, to insert the central strips.

**Accessories per joint** (handbook §15–§25; codes are for 20 mm / 30 mm panels)

**Invisible flange joint**
- 8 flange pieces: 21FN01 / 21FN06 aluminium, or 21FN02 / 21FN09 PVC. Cut to the inner size −2 to 3 mm.
- 8 reinforcement corners: 21SQ01 / 21SQ02.
- 4 PVC H-bayonets: 21FN04, cut to the inner size.
- 4 covering angles: 21FN05 / 21FN08.

**Traditional flange joint**
- 8 flange pieces: 21FT01 / 21FT06. Cut to the inner size −3 mm.
- 8 corners: 21FT05 / 21SQ05.
- 4 C-bayonets: 21FT03. Vertical bayonets are cut to the outer size; horizontal ones to the outer size +20 mm.
- Optional self-adhesive gasket: 21GR01.

**Other joints**
- **Take-off flange:** 4 × 21FN03 / 21FN07 on the hole, plus 4 invisible-flange pieces on the branch, plus 4 bayonets.
- **Anti-vibration joint:** 8 sheet-holder profiles (21GN04), each side −5 mm; anti-vibration sheet (21GN05); 21SQ01 used as brackets; bayonets and covering angles.
- **Connection to a machine:** 4 F-profiles (21PR03 / 21PR07 aluminium, 21PR13 PVC) cut to the inner size −3 mm, and 4 corners (21SQ03 / 21SQ04). Fixed to the machine flange by rivets, bolts or screws at the installer's choice.
- **Damper frame:** C-profile 21SR03 and omega 21SR02; blades 21SR01; gear 21SR04 / 21SR05; mechanism 21SR07. Fixed to the duct with seat, U or F profiles (21PR01 / 02 / 03 / 07 / 14 / 15), a gasket, and rivets or screws.

**Reinforcement (§21)**
- Profile 21RF02 with an aluminium disc 21RF01 at each end.
- Length = inner dimension − 12 mm.
- Fixed with self-threading screws from outside.
- Placed at b/3 (and h/2 for crossed pairs).
- The count comes from a graphical table of pressure × side × panel rigidity class, which is not machine-readable.
- **Until it is transcribed the engine reports `DU_PID_REINF_UNVERIFIED`.**

**Supports (§20)**

| Longer side | Maximum support spacing |
|---|---|
| <1000 mm | 4000 mm |
| >1000 mm | 2000 mm |

- Outdoor installations: 2 m.
- Ducts wider than 600 mm sit on a supporting profile (21PR05) hung on threaded rods, chains or cables. Small ducts use fixing brackets (21SS01/05).
- Put hangers between flanges wherever possible.
- Ducts not tight to the ceiling also get upper brackets on the suspension rod.

**Consumables**
- Panel adhesive and aluminium tape on every glued edge ("pressing, taping and siliconing").
- Silicone on inner corners.
- Sealing adhesive at 500–800 cm³/m², 0.6–1.0 mm thick, applied at +5 to +35 °C (catalogue).

## Sources that must not be substituted silently

- **`@provacx/shared` `getRecommendedGauge`** chooses the gauge from the width alone (height is ignored). Its bands match neither SMACNA 1995 nor the common longest-side table. **`DUCT_SECTIONS`** is a size list, not a construction schedule. Neither is used.
- **Blog summaries** quoting "15° converging / 7° diverging per side" or vane spacings conflict with each other and with the institutional specifications above. They are not used.
- **The procedural ducted-unit openings** (`ductedIndoorUnitModel.ts`) are not the real collars of the catalogued unit; see the measured ports above.
- **Ductmate class equivalence** (F/J/K) is the manufacturer's statement; SMACNA does not grade proprietary joints (§1.15). It is marked `manufacturer`, not `smacna`.

## Implementable rules

The rule IDs are referenced by `DUCT_RULE_SOURCES` in the engine.

| ID | Rule | Provenance |
|---|---|---|
| G-01 | Thickness for all four sides comes from the greater dimension's row at the joint-spacing column, or the "no reinforcement" thickness when it is lighter or equal. | SMACNA 1.8.1 |
| G-02 | Each side's joint class is the letter in its own row at the joint-spacing column. A side needs no class if the chosen thickness is at or above its column-2 value. The joint uses the higher class of the two sides. | SMACNA 1.8.1 |
| G-03 | Blank cells: left-aligned before the first complete row (carry the last value right), right-aligned after the last (Not Designed). Not Designed at the joint spacing → shorter column plus intermediate reinforcement from Table 1-10M. | SMACNA 1.8.1 + tables |
| G-04 | Select the smallest sheet in the configured stock list that is ≥ the SMACNA minimum; error if none. Joint ratings use the highest SMACNA nominal thickness the sheet meets. | project configuration (user decision 2026-09-24) |
| G-05 | Pressure classes above 500 Pa are refused until Tables 1-6M to 1-9M are encoded. | scope |
| J-01 | TDC/TDF (T-25) and T-24 are rated by duct thickness per Table 1-12M. Raise the thickness until the rating reaches the class, or change joint system in `auto` mode. | SMACNA 1-12M |
| J-02 | T-22: member from Table 1-12M; M8 bolts at ≤152 mm (≤1000 Pa) with corners shared; angle-to-duct fasteners at ≤305 mm, including the corners; welded frame corners; gasket or sealant. | SMACNA T-22 notes |
| J-03 | Generic T-24/T-25: 4 corners per duct end (16 ga) with one ≥3/8″ (M10) bolt per corner pair; continuous 6.4 × 13 gasket; 152 mm clips within 152 mm of each corner and at ≤381 mm (≤750 Pa). | SMACNA T-24 notes |
| J-04 | Ductmate: series by thickness range and required class (DM25 F, DM35 J, DM45 K); manufacturer screw and cleat schedules above. | Ductmate spec |
| J-05 | Fasteners: steel; no open-hole blind rivets; ≤13 mm projection. | SMACNA S1.41 |
| J-06 | Cross-break or bead per S1.15 unless insulated or lined. | SMACNA S1.15 |
| J-07 | Seal class from the pressure class (Table 1-2) unless the project demands Class A. | SMACNA 1-2 |
| F-01 | Radius elbow R/W default 1.0 (1.5 preferred); square elbows only with vanes; vane spacing by vane type. | institutional (unverified vs figure) |
| F-02 | Transition taper default 1:4; limits 20° expanding and 30° contracting. | institutional (unverified vs figure) |
| F-03 | Branch shoe (45° entry) lead-in max(W/4, 100 mm). | unverified |
| F-04 | Fittings take the thickness of the larger adjoining straight; branches are reinforced like straight duct of the larger dimension. | SMACNA S1.16 |
| C-01 | Unit connection: fabric connector, ≥63.5 mm clear between metal edges plus slack; default 100 mm fabric + 2 × 75 mm metal. | Texas State spec; practice |
| X-01 | Flex duct: collars ≥51 mm, inserted ≥25 mm, draw bands; supports ≤1.5 m, sag ≤41.7 mm/m, length ≤1.5 m (project). | SMACNA S3.30–S3.40 |
| H-01 | Hanger size by P/2 and spacing from Table 4-1M. Load check against single-hanger capacity, metric rods by the derived stress area. | SMACNA 4-1M + derived |
| H-02 | A support within 0.61 m of each elbow and 1.22 m of each branch intersection. | SMACNA S4.1 |
| H-03 | Trapeze member from Table 4-3M by bar length (duct width + 2 × rod offset) and load. | SMACNA 4-3M |
| H-04 | Risers: angle or channel pair at 3.66–7.32 m. | SMACNA 4.2.10 |
| N-01 | NBR takeoff at the insulation mid-plane; adhesive 8 m²/L of sheet (both surfaces); a thermal-break insert at each trapeze. | Armacell 520 |
| P-01 | PID cutting method and section length per the handbook table. | P3 §1 |
| P-02 | PID elbow minimum radius, splitters, 50 mm necks; 30° reductions. | P3 §4–§9 |
| P-03 | PID joint accessories per joint as listed. | P3 §15–§23 |
| P-04 | PID supports: 4 m / 2 m by the longer side; a profile above 600 mm. | P3 §20 |
| P-05 | PID reinforcement count unverified until the graphical table is transcribed. | gap |
| U-01 | FDUM22KXE6F-W air ports as measured: supply −Y 674 × 164, return +Y 654 × 194. | measured; face assignment confirmed by user against MHI dimensions |

## Open gaps

1. Tables 1-6M to 1-9M (750 to 2500 Pa): transcribe before enabling those classes.
2. ~~Figures 1-15, 2-2 to 2-7 and 2-17 are images.~~ Read from the scanned PDF on 25 September 2026 (see "Fittings (figures read from the scanned PDF)"); these values are now verified.
3. P3 reinforcement selection graph (handbook p.47).
4. A single NBR datasheet for λ, sheet sizes and thicknesses (Armaflex or K-Flex, whichever the project uses).
5. Galvanised sheet weight appendix A.7 (confirm the gauge weights).
6. The fabricator's actual sheet stock list (the Finland list is provisional).

The FDUM22 supply/return face assignment is no longer open; it was confirmed on 24 September 2026.

Item 3 stays `verified: false` in the engine and is never shown as an authoritative default (user decision, 24 September 2026). Values SMACNA gives no number for (make-up minimum, elbow neck, washers per bolt, collar and damper section lengths, tap-window margin, the 4:1 aspect advisory, the 14° design taper) are labelled "project practice". Pressure classes above 500 Pa stay refused (user decision, 25 September 2026).
