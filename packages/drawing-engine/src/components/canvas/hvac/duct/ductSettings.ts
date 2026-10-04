/**
 * Duct design settings (persisted with the document). Engineering tables live
 * in the catalog; these are the project choices that select from them, plus
 * the commercial sheet stock, which is configuration rather than engineering.
 * Every value names its provenance so the panel can show whether a default is
 * verified.
 */
import { ELBOW_RULES, FAN_CONNECTOR, TRANSITION_LIMITS, type DuctVaneType } from './ductFittingRules';
import type { DuctRoundSeam, DuctRoundVelocityBand } from './ductRoundRules';
import type { DuctRuleProvenance } from './ductSources';
import { SUPPORT_RULES, type MetricRod } from './ductSupportTables';
import { ROUND_MAIN_TAP_STYLES, type DuctRoundMainTapStyle } from './ductTypes';

export type DuctGaugeMode = 'smacna' | 'longest-side';
export type DuctJointSystem = 'auto' | 'tdc' | 'ductmate' | 'angle-flange';
export type DuctElbowStyle = 'auto' | 'radius' | 'square-vaned';
export type DuctLongitudinalSeam = 'pittsburgh' | 'snaplock';

export interface DuctDesignSettings {
  gaugeMode: DuctGaugeMode;
  /** Static pressure class of supply ducts (Pa). Above 500 Pa is refused. */
  supplyPressureClassPa: number;
  /** Static pressure class of return ducts (Pa, negative mode). */
  returnPressureClassPa: number;
  /** Straight section (joint-to-joint) length (mm). */
  sectionLengthMm: number;
  /** Shortest straight piece before it is shared with its neighbour (mm). */
  minMakeUpPieceMm: number;
  /** Sheet thicknesses the fabricator stocks (mm). The engine picks the smallest ≥ the SMACNA minimum. */
  availableSheetThicknessesMm: number[];
  jointSystem: DuctJointSystem;
  /** Washers per bolt (one under the head, one under the nut). */
  washersPerBolt: number;
  longitudinalSeam: DuctLongitudinalSeam;
  /** Coil (sheet) width the fabricator cuts from (mm): decides two or four seams per section. */
  coilWidthMm: number;
  elbowStyle: DuctElbowStyle;
  /** Radius elbow centreline radius as a multiple of the in-plane width (R/W). */
  elbowCentrelineRatio: number;
  /** Straight neck on each end of an elbow, for the flange (mm). */
  elbowNeckMm: number;
  /** Turning vanes in square elbows (SMACNA Fig. 2-3); auto = lightest that spans the height. */
  vaneType: DuctVaneType | 'auto';
  /** Design taper of transitions, per side (degrees; 14° ≈ 1:4). */
  transitionTaperDeg: number;
  /** Concentric (plan width) limit, included angle, diverging in the flow direction (degrees). */
  transitionMaxDivergingIncludedDeg: number;
  /** Concentric (plan width) limit, included angle, converging in the flow direction (degrees). */
  transitionMaxConvergingIncludedDeg: number;
  /** Eccentric (flat bottom: the top slopes) limit (degrees). */
  transitionMaxEccentricDeg: number;
  /** Aspect ratio above which a section is flagged (advisory). */
  aspectRatioAdvisory: number;
  /** Take-off collar length out of the parent wall (mm). */
  tapCollarMm: number;
  /** Volume damper section length (mm). */
  vcdLengthMm: number;
  /** Clearance kept around a take-off opening for joints (mm). */
  tapWindowMarginMm: number;
  /** Round branches: seam (SMACNA Fig. 3-1; gauge per Table 3-2AM / 3-2BM). */
  roundSeam: DuctRoundSeam;
  /** Round elbows: velocity band for SMACNA Table 3-1 (R/D and gore count). */
  roundVelocityBand: DuctRoundVelocityBand;
  /** Round straight section length (spiral duct is cut to length) (mm). */
  roundSectionLengthMm: number;
  /** Conical take-off: how much wider the cone is at the parent wall than the branch (mm). */
  conicalFlareMm: number;
  flexibleConnectorAtUnit: boolean;
  /** Fabric width of the flexible connector (mm). */
  connectorFabricMm: number;
  /** Metal edge on each side of the fabric (mm). */
  connectorMetalMm: number;
  /** Maximum hanger spacing along level ducts (mm; SMACNA Table 4-1M columns, §4.2.8 up to 3.05 m). */
  hangerSpacingMm: number;
  /** Rod centre from the duct (or insulation) side (mm; Table 4-3M allows up to 152). */
  hangerRodOffsetMm: number;
  /** Trapeze bar beyond each rod (mm). */
  trapezeOverhangMm: number;
  /** Hangers are kept this far clear of transverse joints (mm). */
  hangerJointClearanceMm: number;
  /** First hanger this far past the unit's flexible connector (mm). */
  hangerFromUnitMm: number;
  /** Smallest threaded rod used. */
  minimumRod: MetricRod['label'];
  /** Riser support interval (mm; §4.2.10 one or two storeys, 3.66–7.32 m). */
  riserSupportIntervalMm: number;
  /** Structure the rods hang from (mm above floor); null = the pipe-routing ceiling limit. */
  soffitMm: number | null;
  /** Construction of new runs (a branch takes its parent's). */
  defaultConstruction: 'gi-bare' | 'gi-nbr';
  /** NBR thickness by service when a run gives none (mm). */
  nbrSupplyThicknessMm: number;
  nbrReturnThicknessMm: number;
  /** Adhesive coverage, both faces glued (m² of sheet per litre). */
  nbrAdhesiveM2PerL: number;
  /** Cutting waste on the insulation sheet (%). */
  nbrWastePercent: number;
  /** Longest flexible runout before it is flagged (mm). */
  flexMaxLengthMm: number;
  /** Flexible duct form (SMACNA Fig. 3-7): non-metallic insulated, non-metallic bare, metallic bare. */
  flexType: 'nm-il' | 'nm-un' | 'm-un';
  /** Insulation on an insulated flexible duct (mm). */
  flexJacketMm: number;
  /** Hang each air terminal on two wires of its own, rather than from the ceiling grid (S3.40). */
  terminalHangerWires: boolean;
  /** Auto layout: friction-rate targets for sizing (Pa per metre; equal-friction method). */
  autoFrictionSupplyPaPerM: number;
  autoFrictionReturnPaPerM: number;
  /** Auto layout: velocity caps by part of the system (m/s). */
  autoMaxVelocityTrunkMs: number;
  autoMaxVelocityBranchMs: number;
  autoMaxVelocityRunoutMs: number;
  /** Auto layout: velocity caps in a terminal's neck (m/s). */
  autoMaxNeckVelocitySupplyMs: number;
  autoMaxNeckVelocityReturnMs: number;
  /** Auto layout: pressure drop across a terminal at its design airflow (Pa). */
  autoDiffuserDropPa: number;
  autoGrilleDropPa: number;
  /** Filter grilles: each class's clean drop at the rated face velocity, and the mid-life design factor. */
  filterG4RatedDropPa: number;
  filterM5RatedDropPa: number;
  filterRatedVelocityMs: number;
  filterDesignFactor: number;
  /** Air systems: the closest a return terminal's face may come to a supply face in the same room before air short-circuits (mm). */
  returnSupplyMinGapMm: number;
  /** Air systems, auto-assign: the price of a wall between a collar and a terminal, and of each terminal past a unit's fair share (mm of duct). */
  autoAssignWallPenaltyMm: number;
  autoAssignOverloadMm: number;
  /** Show every air system on the plan (tethers, rings, unit tags), not only the selected one. */
  showAirSystems: boolean;
  /** Auto layout: round duct sizes to choose from (mm). */
  autoRoundSizesMm: number[];
  /** Auto layout: a trunk reduces only when its width drops by at least this much (mm). */
  autoReducerStepMm: number;
  /** Optimiser: exact tree search up to this many terminals per service (above it, a heuristic). */
  autoExactTerminals: number;
  /** Optimiser: time for one unit's design, after which the best verified design so far is kept (ms). */
  autoTimeBudgetMs: number;
  /** Optimiser: it may turn the spigot of a terminal on a square or round plenum box (not a linear slot) to the side the duct reaches best. */
  autoChooseSpigotSide: boolean;
  /** Optimiser: the round-main take-offs it may use, and whether a round main may end in a wye. */
  autoRoundMainStyles: DuctRoundMainTapStyle[];
  autoAllowWye: boolean;
  /** How Auto duct sizes the sections: the life-cycle optimum, or constant friction (equal friction) at the card's basis. */
  autoSizingMethod: 'life-cycle' | 'constant-friction';
  /**
   * Economics (auto duct optimiser), in `econCurrency`. First cost: galvanised
   * sheet by mass, fabrication and installation by sheet area (fittings at a
   * multiple), NBR by area, flexible duct per metre at Ø200 (scaled by the
   * diameter), dampers each at Ø200 (scaled by the girth), hangers each,
   * joints per metre of perimeter. Energy: the fan's power Q·Δp/η over the
   * operating hours, brought to present worth over the life. All placeholders
   * until the supplier's prices are entered.
   */
  econCurrency: string;
  econSheetPerKg: number;
  econFabricationRectPerM2: number;
  econFabricationSpiralPerM2: number;
  econFittingFactor: number;
  econInstallPerM2: number;
  econInsulationPerM2: number;
  econFlexPerM: number;
  econDamperEach: number;
  econHangerEach: number;
  econJointPerM: number;
  econElectricityPerKWh: number;
  econHoursPerYear: number;
  econFanEfficiency: number;
  econLifeYears: number;
  econDiscountPercent: number;
  econEscalationPercent: number;
  showSizeTags: boolean;
  showJointTicks: boolean;
  showPieceMarks: boolean;
  showSupports: boolean;
}

/** Provisional commercial stock (Finland) — replace with the fabricator's list. */
export const DEFAULT_SHEET_STOCK_MM: readonly number[] = [0.5, 0.6, 0.7, 0.75, 1.0, 1.25, 1.5];

export const DEFAULT_DUCT_SETTINGS: DuctDesignSettings = {
  gaugeMode: 'smacna',
  supplyPressureClassPa: 500,
  returnPressureClassPa: 250,
  sectionLengthMm: 1200,
  minMakeUpPieceMm: 200,
  availableSheetThicknessesMm: [...DEFAULT_SHEET_STOCK_MM],
  jointSystem: 'auto',
  washersPerBolt: 2,
  longitudinalSeam: 'pittsburgh',
  coilWidthMm: 1250,
  elbowStyle: 'auto',
  elbowCentrelineRatio: ELBOW_RULES.defaultCentrelineRatio,
  elbowNeckMm: 50,
  vaneType: 'auto',
  transitionTaperDeg: 14,
  transitionMaxDivergingIncludedDeg: TRANSITION_LIMITS.concentricDivergingIncludedDeg,
  transitionMaxConvergingIncludedDeg: TRANSITION_LIMITS.concentricConvergingIncludedDeg,
  transitionMaxEccentricDeg: TRANSITION_LIMITS.eccentricMaxDeg,
  aspectRatioAdvisory: 4,
  tapCollarMm: 100,
  vcdLengthMm: 150,
  tapWindowMarginMm: 50,
  roundSeam: 'spiral',
  roundVelocityBand: 'medium',
  roundSectionLengthMm: 3000,
  conicalFlareMm: 50,
  flexibleConnectorAtUnit: true,
  connectorFabricMm: 102,
  connectorMetalMm: FAN_CONNECTOR.metalEdgeMm,
  hangerSpacingMm: 2400,
  hangerRodOffsetMm: 50,
  trapezeOverhangMm: 50,
  hangerJointClearanceMm: 150,
  hangerFromUnitMm: 300,
  minimumRod: 'M8',
  riserSupportIntervalMm: SUPPORT_RULES.riserIntervalMm[0],
  soffitMm: null,
  defaultConstruction: 'gi-bare',
  nbrSupplyThicknessMm: 25,
  nbrReturnThicknessMm: 19,
  nbrAdhesiveM2PerL: 8,
  nbrWastePercent: 10,
  flexMaxLengthMm: 1500,
  flexType: 'nm-il',
  flexJacketMm: 25,
  terminalHangerWires: false,
  autoFrictionSupplyPaPerM: 0.8,
  autoFrictionReturnPaPerM: 0.6,
  autoMaxVelocityTrunkMs: 5,
  autoMaxVelocityBranchMs: 4,
  autoMaxVelocityRunoutMs: 3,
  autoMaxNeckVelocitySupplyMs: 3,
  autoMaxNeckVelocityReturnMs: 3.5,
  autoDiffuserDropPa: 15,
  autoGrilleDropPa: 10,
  filterG4RatedDropPa: 40,
  filterM5RatedDropPa: 60,
  filterRatedVelocityMs: 2.5,
  filterDesignFactor: 1.5,
  returnSupplyMinGapMm: 1500,
  autoAssignWallPenaltyMm: 4000,
  autoAssignOverloadMm: 2500,
  showAirSystems: false,
  autoRoundSizesMm: [100, 125, 150, 160, 200, 250, 300, 315, 355, 400, 450, 500],
  autoReducerStepMm: 100,
  autoExactTerminals: 8,
  autoTimeBudgetMs: 20000,
  autoChooseSpigotSide: true,
  autoRoundMainStyles: ['round-conical', 'round-tee', 'round-lateral'],
  autoAllowWye: true,
  autoSizingMethod: 'life-cycle',
  econCurrency: 'USD',
  econSheetPerKg: 1.6,
  econFabricationRectPerM2: 14,
  econFabricationSpiralPerM2: 6,
  econFittingFactor: 2.5,
  econInstallPerM2: 9,
  econInsulationPerM2: 18,
  econFlexPerM: 7,
  econDamperEach: 25,
  econHangerEach: 14,
  econJointPerM: 5,
  econElectricityPerKWh: 0.15,
  econHoursPerYear: 3000,
  econFanEfficiency: 0.45,
  econLifeYears: 15,
  econDiscountPercent: 6,
  econEscalationPercent: 2,
  showSizeTags: true,
  showJointTicks: true,
  showPieceMarks: false,
  showSupports: true,
};

const practice = (note?: string): DuctRuleProvenance => ({ sourceId: 'project-practice', verified: false, ...(note ? { note } : {}) });

export const DUCT_RULE_SOURCES: Partial<Record<keyof DuctDesignSettings, DuctRuleProvenance>> = {
  gaugeMode: { sourceId: 'smacna-1995', reference: '§1.8.1, Tables 1-3M/1-4M/1-5M', verified: true },
  supplyPressureClassPa: { sourceId: 'smacna-1995', reference: 'Table 1-1; only 125/250/500 Pa are encoded', verified: true },
  returnPressureClassPa: { sourceId: 'smacna-1995', reference: 'Table 1-1; negative pressure mode', verified: true },
  sectionLengthMm: { sourceId: 'fabricator-practice', verified: true, note: 'Coil-line section length; SMACNA columns go to 3.0 m.' },
  minMakeUpPieceMm: practice('Shortest straight piece a fabricator will make.'),
  availableSheetThicknessesMm: {
    sourceId: 'project-configuration', verified: false,
    note: 'Provisional Finland stock list; replace with the fabricator/supplier stock.',
  },
  jointSystem: {
    sourceId: 'smacna-1995', reference: 'Table 1-12M', verified: true,
    note: 'auto = TDC when its thickness rating reaches the required class, otherwise a T-22 companion angle.',
  },
  washersPerBolt: practice(),
  coilWidthMm: practice('Coil width the fabricator stocks; two L-shaped halves while half the girth fits, else four panels.'),
  longitudinalSeam: { sourceId: 'smacna-1995', reference: 'Fig. 1-5 notes', verified: true },
  elbowStyle: { sourceId: 'smacna-1995', reference: 'Fig. 2-2, p.2.3', verified: true, note: 'RE1 radius elbow; RE2 square throat with vanes. auto = radius, vanes when the radius does not fit.' },
  elbowCentrelineRatio: { sourceId: 'smacna-1995', reference: 'Fig. 2-2 RE1, p.2.3', verified: true, note: 'Centreline R = 3W/2 unless otherwise specified; R/W 0.5 only up to 5 m/s.' },
  elbowNeckMm: practice('Straight neck on each elbow end for its flange.'),
  vaneType: { sourceId: 'smacna-1995', reference: 'Fig. 2-3 (p.2.5), Fig. 2-4 (p.2.6)', verified: true, note: 'Schedule and spans are SMACNA; auto picks the lightest vane that spans the height (practice).' },
  transitionTaperDeg: practice('Design taper within the SMACNA limits.'),
  transitionMaxDivergingIncludedDeg: { sourceId: 'smacna-1995', reference: 'Fig. 2-7, p.2.9', verified: true, note: 'Concentric: 45° included diverging.' },
  transitionMaxConvergingIncludedDeg: { sourceId: 'smacna-1995', reference: 'Fig. 2-7, p.2.9', verified: true, note: 'Concentric: 60° included converging.' },
  transitionMaxEccentricDeg: { sourceId: 'smacna-1995', reference: 'Fig. 2-7, p.2.9', verified: true, note: 'Eccentric: 30° max.' },
  aspectRatioAdvisory: practice('SMACNA sets no aspect-ratio limit; 4:1 is a common design advisory.'),
  tapCollarMm: practice('Collar length out of the parent wall; the 45° lead-in (W/4, 102 mm min) is SMACNA Fig. 2-6.'),
  vcdLengthMm: practice('In-line damper section; blade layout is SMACNA Fig. 2-12/2-13.'),
  tapWindowMarginMm: practice('Clearance between a take-off opening and a transverse joint.'),
  roundSeam: { sourceId: 'smacna-1995', reference: 'Fig. 3-1 (p.3.8), Tables 3-2AM / 3-2BM', verified: true, note: 'All seam types are permitted at ±500 Pa.' },
  roundVelocityBand: { sourceId: 'smacna-1995', reference: 'Table 3-1, p.3.1', verified: true, note: 'R/D and gore count per band are SMACNA; choosing the band (the branch velocity) is the designer\'s.' },
  roundSectionLengthMm: practice('Spiral duct is cut to length; 3 m is a common stock length.'),
  conicalFlareMm: practice('Conical take-off (SMACNA Fig. 2-6): the flare at the wall is not dimensioned.'),
  flexibleConnectorAtUnit: { sourceId: 'institutional-specs', verified: true, note: 'Flexible connection wherever duct meets vibration-isolated equipment.' },
  connectorFabricMm: { sourceId: 'smacna-1995', reference: 'Fig. 2-17, p.2.21', verified: true, note: 'Fabric 76 or 102 mm between metal edges, 254 mm maximum.' },
  connectorMetalMm: { sourceId: 'smacna-1995', reference: 'Fig. 2-17, p.2.21', verified: true, note: '76 mm (3″) metal each side of the fabric.' },
  hangerSpacingMm: { sourceId: 'smacna-1995', reference: '§4.2.8, Table 4-1M (p.4.6)', verified: true, note: 'Table columns 3.0 / 2.4 / 1.5 / 1.2 m; the hanger is sized for the column that covers the spacing. Round: 3.7 m max (Table 4-2).' },
  hangerRodOffsetMm: practice('Rod centre from the duct side; SMACNA Table 4-3M assumes ≤ 152 mm for bars ≤ 2440 mm.'),
  trapezeOverhangMm: practice('Trapeze bar beyond each rod.'),
  hangerJointClearanceMm: practice('Hangers between flanges where possible, kept this far from a joint.'),
  hangerFromUnitMm: practice('The duct is carried independently of the unit: first hanger just past the flexible connector.'),
  minimumRod: practice('Smallest rod used; the rod itself is sized by load at SMACNA\'s 6.2 kg/mm² (derived for metric rods).'),
  riserSupportIntervalMm: { sourceId: 'smacna-1995', reference: '§4.2.10', verified: true, note: 'Angles or channels at one- or two-storey intervals, 3.66–7.32 m.' },
  soffitMm: { sourceId: 'project-configuration', verified: false, note: 'Structure the rods hang from; empty = the pipe-routing ceiling limit.' },
  defaultConstruction: { sourceId: 'project-configuration', verified: false, note: 'Construction of new runs; a branch takes its parent\'s.' },
  nbrSupplyThicknessMm: practice('Typical specifications: 25 mm on supply in a conditioned ceiling void.'),
  nbrReturnThicknessMm: practice('Typical specifications: 19 mm on return in a conditioned ceiling void.'),
  nbrAdhesiveM2PerL: { sourceId: 'armacell-520', verified: true, note: '7–9 m² per litre with both faces glued (sheet); 8 is used.' },
  nbrWastePercent: practice('Cutting waste on the insulation sheet.'),
  flexMaxLengthMm: { sourceId: 'institutional-specs', verified: true, note: 'SMACNA sets no maximum (S3.23: use the minimum length); institutional specifications cap runouts at 1.5–2.1 m.' },
  flexType: { sourceId: 'smacna-1995', reference: 'Fig. 3-7, S3.32–S3.34', verified: true, note: 'Your decision: insulated non-metallic (NM-IL) with draw bands.' },
  flexJacketMm: practice('Insulation on the flexible duct; 25 mm is the common NM-IL grade.'),
  terminalHangerWires: { sourceId: 'smacna-1995', reference: 'S3.40, Fig. 2-15', verified: true, note: 'Terminals on flex are supported independently: by the ceiling grid (default) or by their own wires.' },
  autoFrictionSupplyPaPerM: practice('Equal-friction sizing (method: ASHRAE Fundamentals ch. 21); 0.8 Pa/m is the usual low-pressure supply rate.'),
  autoFrictionReturnPaPerM: practice('Return sized a little lower than supply to keep the fan pressure down.'),
  autoMaxVelocityTrunkMs: practice('Low-velocity trunk above an occupied space (noise).'),
  autoMaxVelocityBranchMs: practice('Branch ducts to terminals.'),
  autoMaxVelocityRunoutMs: practice('Flexible runouts and the last rigid length before a terminal.'),
  autoMaxNeckVelocitySupplyMs: practice('Diffuser neck velocity for a quiet office (about NC 30–35); check the supplier\'s data.'),
  autoMaxNeckVelocityReturnMs: practice('Return grille neck velocity; check the supplier\'s data.'),
  autoDiffuserDropPa: practice('Placeholder terminal pressure drop until the supplier\'s data is entered.'),
  autoGrilleDropPa: practice('Placeholder terminal pressure drop until the supplier\'s data is entered.'),
  filterG4RatedDropPa: practice('Clean drop of a 25 mm G4 panel at the rated face velocity; the supplier\'s curve replaces it.'),
  filterM5RatedDropPa: practice('Clean drop of a 25 mm M5 panel (≈ MERV 8, the ASHRAE 62.1 §5.8 minimum upstream of a wet coil) at the rated face velocity.'),
  filterRatedVelocityMs: practice('Face velocity the clean drops are quoted at; the drop scales linearly with the grille\'s own face velocity.'),
  filterDesignFactor: practice('Mid-life allowance between the clean drop and the change-out drop.'),
  returnSupplyMinGapMm: practice('Keep a return inlet out of a supply outlet\'s primary jet so conditioned air does not go straight back to the unit (ASHRAE Fundamentals ch. 20 principle; the distance is practice).'),
  autoAssignWallPenaltyMm: practice('Auto-assign: a wall between a collar and a terminal costs this much duct (a sleeve and coordination).'),
  autoAssignOverloadMm: practice('Auto-assign: each terminal past a unit\'s fair share (by airflow) costs this much duct, so units share the room.'),
  showAirSystems: { sourceId: 'project-configuration', verified: false, note: 'Display only.' },
  autoRoundSizesMm: { sourceId: 'project-configuration', verified: false, note: 'Round sizes the fabricator stocks (spiral and flex).' },
  autoReducerStepMm: practice('A trunk is reduced only for a worthwhile width change, not at every take-off.'),
  autoExactTerminals: practice('The exact tree search grows as 3^k in time and 2^k in memory; above this many terminals only the layout candidates are sized (labelled, not exact).'),
  autoTimeBudgetMs: practice('The optimiser stops learning (routing again after a failed check) past this time and keeps the best verified design; the result says so.'),
  autoChooseSpigotSide: practice('A symmetric face throws the same pattern whichever side its plenum box is fed from; the optimiser picks the side the duct reaches best. Linear slots keep theirs.'),
  autoRoundMainStyles: { sourceId: 'smacna-1995', reference: 'Fig. 3-4 (p.3.11), Fig. 3-5 (p.3.12)', verified: true, note: 'Which of the SMACNA round-main fittings the optimiser may choose; it picks per branch by cost and loss.' },
  autoAllowWye: { sourceId: 'smacna-1995', reference: 'Fig. 3-5 (p.3.12)', verified: true, note: 'A round main may end in a wye.' },
  autoSizingMethod: practice('Constant friction is the equal-friction method (ASHRAE Fundamentals ch. 21); the life-cycle optimum trades first cost against fan energy.'),
  econCurrency: { sourceId: 'project-configuration', verified: false, note: 'Currency of the rates below.' },
  econSheetPerKg: practice('Placeholder: galvanised coil price per kg; enter the supplier\'s.'),
  econFabricationRectPerM2: practice('Placeholder: rectangular duct fabrication (brake, seams, flanges) per m² of sheet.'),
  econFabricationSpiralPerM2: practice('Placeholder: spiral round duct is machine-made, cheaper per m² than rectangular.'),
  econFittingFactor: practice('Placeholder: a fitting\'s fabrication costs this multiple of a straight\'s per m².'),
  econInstallPerM2: practice('Placeholder: installation labour per m² of duct surface.'),
  econInsulationPerM2: practice('Placeholder: NBR sheet, adhesive and labour per m².'),
  econFlexPerM: practice('Placeholder: insulated flexible duct per metre at Ø200, scaled by the diameter.'),
  econDamperEach: practice('Placeholder: volume damper at Ø200, scaled by the girth.'),
  econHangerEach: practice('Placeholder: a hanger (rods, bar or band, anchors, labour).'),
  econJointPerM: practice('Placeholder: a transverse joint per metre of its perimeter (flanges or sleeve, fasteners, sealant, labour).'),
  econElectricityPerKWh: practice('Placeholder: electricity tariff.'),
  econHoursPerYear: practice('Placeholder: fan running hours a year.'),
  econFanEfficiency: practice('Placeholder: fan and motor efficiency of a small ducted unit.'),
  econLifeYears: practice('Placeholder: economic life of the ductwork.'),
  econDiscountPercent: practice('Placeholder: discount rate for the present worth of the energy.'),
  econEscalationPercent: practice('Placeholder: yearly rise of the energy price.'),
};

export const DUCT_SUPPORTED_PRESSURE_CLASSES_PA = [125, 250, 500] as const;

// The document's duct settings, mirrored for engines that are not handed them
// (the pipe clash check plans ducts as obstacles). Defaults until set.
let activeDuctSettings: DuctDesignSettings | null = null;

export function getActiveDuctSettings(): DuctDesignSettings {
  if (!activeDuctSettings) activeDuctSettings = resolveDuctSettings({});
  return activeDuctSettings;
}

export function setActiveDuctSettings(settings: DuctDesignSettings): void {
  activeDuctSettings = settings;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return finite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function resolveSheetStock(value: unknown): number[] {
  if (!Array.isArray(value)) return [...DEFAULT_SHEET_STOCK_MM];
  const sheets = [...new Set(value.filter((entry): entry is number => finite(entry) && entry > 0 && entry < 10))]
    .sort((a, b) => a - b);
  return sheets.length > 0 ? sheets : [...DEFAULT_SHEET_STOCK_MM];
}

/**
 * Drops invalid values field by field; a corrupt document never breaks the
 * planner. Pressure classes are kept as entered (the planner refuses the
 * unsupported ones explicitly rather than silently clamping them).
 */
export function resolveDuctSettings(input?: Partial<DuctDesignSettings> | null): DuctDesignSettings {
  const raw = (input ?? {}) as Partial<Record<keyof DuctDesignSettings, unknown>>;
  const d = DEFAULT_DUCT_SETTINGS;
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  return {
    gaugeMode: oneOf(raw.gaugeMode, ['smacna', 'longest-side'] as const, d.gaugeMode),
    supplyPressureClassPa: clampNumber(raw.supplyPressureClassPa, d.supplyPressureClassPa, 1, 10000),
    returnPressureClassPa: clampNumber(raw.returnPressureClassPa, d.returnPressureClassPa, 1, 10000),
    sectionLengthMm: clampNumber(raw.sectionLengthMm, d.sectionLengthMm, 300, 3000),
    minMakeUpPieceMm: clampNumber(raw.minMakeUpPieceMm, d.minMakeUpPieceMm, 50, 1000),
    availableSheetThicknessesMm: resolveSheetStock(raw.availableSheetThicknessesMm),
    jointSystem: oneOf(raw.jointSystem, ['auto', 'tdc', 'ductmate', 'angle-flange'] as const, d.jointSystem),
    washersPerBolt: Math.round(clampNumber(raw.washersPerBolt, d.washersPerBolt, 0, 4)),
    longitudinalSeam: oneOf(raw.longitudinalSeam, ['pittsburgh', 'snaplock'] as const, d.longitudinalSeam),
    coilWidthMm: clampNumber(raw.coilWidthMm, d.coilWidthMm, 600, 2000),
    elbowStyle: oneOf(raw.elbowStyle, ['auto', 'radius', 'square-vaned'] as const, d.elbowStyle),
    elbowCentrelineRatio: clampNumber(raw.elbowCentrelineRatio, d.elbowCentrelineRatio, 0.25, 3),
    elbowNeckMm: clampNumber(raw.elbowNeckMm, d.elbowNeckMm, 0, 300),
    vaneType: oneOf(raw.vaneType, ['auto', 'single-small', 'single-large', 'double-small', 'double-large'] as const, d.vaneType),
    transitionTaperDeg: clampNumber(raw.transitionTaperDeg, d.transitionTaperDeg, 5, 30),
    // Stricter than SMACNA is allowed; looser is not.
    transitionMaxDivergingIncludedDeg: clampNumber(raw.transitionMaxDivergingIncludedDeg, d.transitionMaxDivergingIncludedDeg, 10, TRANSITION_LIMITS.concentricDivergingIncludedDeg),
    transitionMaxConvergingIncludedDeg: clampNumber(raw.transitionMaxConvergingIncludedDeg, d.transitionMaxConvergingIncludedDeg, 10, TRANSITION_LIMITS.concentricConvergingIncludedDeg),
    transitionMaxEccentricDeg: clampNumber(raw.transitionMaxEccentricDeg, d.transitionMaxEccentricDeg, 5, TRANSITION_LIMITS.eccentricMaxDeg),
    aspectRatioAdvisory: clampNumber(raw.aspectRatioAdvisory, d.aspectRatioAdvisory, 2, 10),
    tapCollarMm: clampNumber(raw.tapCollarMm, d.tapCollarMm, 50, 400),
    vcdLengthMm: clampNumber(raw.vcdLengthMm, d.vcdLengthMm, 50, 600),
    tapWindowMarginMm: clampNumber(raw.tapWindowMarginMm, d.tapWindowMarginMm, 0, 300),
    roundSeam: oneOf(raw.roundSeam, ['spiral', 'longitudinal'] as const, d.roundSeam),
    roundVelocityBand: oneOf(raw.roundVelocityBand, ['low', 'medium', 'high'] as const, d.roundVelocityBand),
    roundSectionLengthMm: clampNumber(raw.roundSectionLengthMm, d.roundSectionLengthMm, 600, 6000),
    conicalFlareMm: clampNumber(raw.conicalFlareMm, d.conicalFlareMm, 0, 300),
    flexibleConnectorAtUnit: bool(raw.flexibleConnectorAtUnit, d.flexibleConnectorAtUnit),
    connectorFabricMm: clampNumber(raw.connectorFabricMm, d.connectorFabricMm, FAN_CONNECTOR.fabricOptionsMm[0], FAN_CONNECTOR.maxFabricMm),
    connectorMetalMm: clampNumber(raw.connectorMetalMm, d.connectorMetalMm, FAN_CONNECTOR.metalEdgeMm, 200),
    // Never looser than SMACNA: 3.05 m spacing (§4.2.8), rods within 152 mm of the side (Table 4-3M).
    hangerSpacingMm: clampNumber(raw.hangerSpacingMm, d.hangerSpacingMm, 600, SUPPORT_RULES.maxSpacingsMm[1]),
    hangerRodOffsetMm: clampNumber(raw.hangerRodOffsetMm, d.hangerRodOffsetMm, 15, SUPPORT_RULES.maxRodOffsetMm),
    trapezeOverhangMm: clampNumber(raw.trapezeOverhangMm, d.trapezeOverhangMm, 15, 200),
    hangerJointClearanceMm: clampNumber(raw.hangerJointClearanceMm, d.hangerJointClearanceMm, 0, 400),
    hangerFromUnitMm: clampNumber(raw.hangerFromUnitMm, d.hangerFromUnitMm, 50, SUPPORT_RULES.elbowMaxMm),
    minimumRod: oneOf(raw.minimumRod, ['M8', 'M10', 'M12', 'M16'] as const, d.minimumRod),
    riserSupportIntervalMm: clampNumber(raw.riserSupportIntervalMm, d.riserSupportIntervalMm, SUPPORT_RULES.riserIntervalMm[0], SUPPORT_RULES.riserIntervalMm[1]),
    soffitMm: raw.soffitMm === null || raw.soffitMm === undefined ? null : clampNumber(raw.soffitMm, 2900, 500, 30000),
    defaultConstruction: oneOf(raw.defaultConstruction, ['gi-bare', 'gi-nbr'] as const, d.defaultConstruction),
    nbrSupplyThicknessMm: clampNumber(raw.nbrSupplyThicknessMm, d.nbrSupplyThicknessMm, 6, 50),
    nbrReturnThicknessMm: clampNumber(raw.nbrReturnThicknessMm, d.nbrReturnThicknessMm, 6, 50),
    nbrAdhesiveM2PerL: clampNumber(raw.nbrAdhesiveM2PerL, d.nbrAdhesiveM2PerL, 7, 9),
    nbrWastePercent: clampNumber(raw.nbrWastePercent, d.nbrWastePercent, 0, 50),
    flexMaxLengthMm: clampNumber(raw.flexMaxLengthMm, d.flexMaxLengthMm, 300, 3000),
    flexType: oneOf(raw.flexType, ['nm-il', 'nm-un', 'm-un'] as const, d.flexType),
    flexJacketMm: clampNumber(raw.flexJacketMm, d.flexJacketMm, 0, 75),
    terminalHangerWires: bool(raw.terminalHangerWires, d.terminalHangerWires),
    autoFrictionSupplyPaPerM: clampNumber(raw.autoFrictionSupplyPaPerM, d.autoFrictionSupplyPaPerM, 0.2, 3),
    autoFrictionReturnPaPerM: clampNumber(raw.autoFrictionReturnPaPerM, d.autoFrictionReturnPaPerM, 0.2, 3),
    autoMaxVelocityTrunkMs: clampNumber(raw.autoMaxVelocityTrunkMs, d.autoMaxVelocityTrunkMs, 1, 12),
    autoMaxVelocityBranchMs: clampNumber(raw.autoMaxVelocityBranchMs, d.autoMaxVelocityBranchMs, 1, 10),
    autoMaxVelocityRunoutMs: clampNumber(raw.autoMaxVelocityRunoutMs, d.autoMaxVelocityRunoutMs, 1, 8),
    autoMaxNeckVelocitySupplyMs: clampNumber(raw.autoMaxNeckVelocitySupplyMs, d.autoMaxNeckVelocitySupplyMs, 1, 8),
    autoMaxNeckVelocityReturnMs: clampNumber(raw.autoMaxNeckVelocityReturnMs, d.autoMaxNeckVelocityReturnMs, 1, 8),
    autoDiffuserDropPa: clampNumber(raw.autoDiffuserDropPa, d.autoDiffuserDropPa, 0, 150),
    autoGrilleDropPa: clampNumber(raw.autoGrilleDropPa, d.autoGrilleDropPa, 0, 150),
    filterG4RatedDropPa: clampNumber(raw.filterG4RatedDropPa, d.filterG4RatedDropPa, 0, 500),
    filterM5RatedDropPa: clampNumber(raw.filterM5RatedDropPa, d.filterM5RatedDropPa, 0, 500),
    filterRatedVelocityMs: clampNumber(raw.filterRatedVelocityMs, d.filterRatedVelocityMs, 0.5, 5),
    filterDesignFactor: clampNumber(raw.filterDesignFactor, d.filterDesignFactor, 1, 3),
    returnSupplyMinGapMm: clampNumber(raw.returnSupplyMinGapMm, d.returnSupplyMinGapMm, 0, 10000),
    autoAssignWallPenaltyMm: clampNumber(raw.autoAssignWallPenaltyMm, d.autoAssignWallPenaltyMm, 0, 100000),
    autoAssignOverloadMm: clampNumber(raw.autoAssignOverloadMm, d.autoAssignOverloadMm, 0, 100000),
    showAirSystems: bool(raw.showAirSystems, d.showAirSystems),
    autoRoundSizesMm: Array.isArray(raw.autoRoundSizesMm) && raw.autoRoundSizesMm.every((size) => typeof size === 'number' && size >= 50 && size <= 2000)
      ? [...new Set(raw.autoRoundSizesMm as number[])].sort((a, b) => a - b) : [...d.autoRoundSizesMm],
    autoReducerStepMm: clampNumber(raw.autoReducerStepMm, d.autoReducerStepMm, 0, 500),
    autoExactTerminals: Math.round(clampNumber(raw.autoExactTerminals, d.autoExactTerminals, 1, 10)),
    autoTimeBudgetMs: Math.round(clampNumber(raw.autoTimeBudgetMs, d.autoTimeBudgetMs, 1000, 60000)),
    autoChooseSpigotSide: bool(raw.autoChooseSpigotSide, d.autoChooseSpigotSide),
    autoRoundMainStyles: Array.isArray(raw.autoRoundMainStyles)
      ? [...new Set((raw.autoRoundMainStyles as unknown[]).filter((style): style is DuctRoundMainTapStyle => (ROUND_MAIN_TAP_STYLES as readonly unknown[]).includes(style)))]
      : [...d.autoRoundMainStyles],
    autoAllowWye: bool(raw.autoAllowWye, d.autoAllowWye),
    autoSizingMethod: oneOf(raw.autoSizingMethod, ['life-cycle', 'constant-friction'] as const, d.autoSizingMethod),
    econCurrency: typeof raw.econCurrency === 'string' && /^[A-Za-z]{3}$/.test(raw.econCurrency) ? raw.econCurrency.toUpperCase() : d.econCurrency,
    econSheetPerKg: clampNumber(raw.econSheetPerKg, d.econSheetPerKg, 0, 1e4),
    econFabricationRectPerM2: clampNumber(raw.econFabricationRectPerM2, d.econFabricationRectPerM2, 0, 1e5),
    econFabricationSpiralPerM2: clampNumber(raw.econFabricationSpiralPerM2, d.econFabricationSpiralPerM2, 0, 1e5),
    econFittingFactor: clampNumber(raw.econFittingFactor, d.econFittingFactor, 1, 10),
    econInstallPerM2: clampNumber(raw.econInstallPerM2, d.econInstallPerM2, 0, 1e5),
    econInsulationPerM2: clampNumber(raw.econInsulationPerM2, d.econInsulationPerM2, 0, 1e5),
    econFlexPerM: clampNumber(raw.econFlexPerM, d.econFlexPerM, 0, 1e5),
    econDamperEach: clampNumber(raw.econDamperEach, d.econDamperEach, 0, 1e6),
    econHangerEach: clampNumber(raw.econHangerEach, d.econHangerEach, 0, 1e6),
    econJointPerM: clampNumber(raw.econJointPerM, d.econJointPerM, 0, 1e5),
    econElectricityPerKWh: clampNumber(raw.econElectricityPerKWh, d.econElectricityPerKWh, 0, 1e3),
    econHoursPerYear: clampNumber(raw.econHoursPerYear, d.econHoursPerYear, 0, 8760),
    econFanEfficiency: clampNumber(raw.econFanEfficiency, d.econFanEfficiency, 0.05, 0.95),
    econLifeYears: Math.round(clampNumber(raw.econLifeYears, d.econLifeYears, 1, 60)),
    econDiscountPercent: clampNumber(raw.econDiscountPercent, d.econDiscountPercent, 0, 50),
    econEscalationPercent: clampNumber(raw.econEscalationPercent, d.econEscalationPercent, -10, 50),
    showSizeTags: bool(raw.showSizeTags, d.showSizeTags),
    showJointTicks: bool(raw.showJointTicks, d.showJointTicks),
    showPieceMarks: bool(raw.showPieceMarks, d.showPieceMarks),
    showSupports: bool(raw.showSupports, d.showSupports),
  };
}
