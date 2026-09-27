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
    showSizeTags: bool(raw.showSizeTags, d.showSizeTags),
    showJointTicks: bool(raw.showJointTicks, d.showJointTicks),
    showPieceMarks: bool(raw.showPieceMarks, d.showPieceMarks),
    showSupports: bool(raw.showSupports, d.showSupports),
  };
}
