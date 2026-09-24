/**
 * Condensate design settings. Every engineering number carries its provenance
 * so the panel can show where a default comes from and whether it has been
 * verified against a manufacturer or code document. Nothing downstream
 * hard-codes these values — the generator, validator and renderer all read the
 * resolved settings.
 */
import type { CondensatePipeSystemId } from './condensateTypes';

/**
 * How a unit with a drain pump uses it:
 *  - 'always'      rise straight up beside the unit to the high point (pump head / soffit),
 *                  then fall all the way — site practice for cassettes and pumped ducted units;
 *  - 'when-needed' lift only as high as the fall to the termination requires;
 *  - 'never'       gravity only (pumps ignored).
 */
export type CondensatePumpPolicy = 'when-needed' | 'always' | 'never';

export interface CondensateCapacityRow {
  /** Upper bound of connected cooling capacity for this row (kW). */
  maxCapacityKw: number;
  /** Minimum internal diameter for that capacity (mm). */
  minInnerDiameterMm: number;
}

export interface CondensateDesignSettings {
  /** Minimum fall on every gravity run (%). */
  minSlopePercent: number;
  /** Fall used wherever the available head allows it (%). */
  preferredSlopePercent: number;
  pipeSystem: CondensatePipeSystemId;
  /** Closed-cell anti-sweat insulation on indoor runs (mm, 0 = uninsulated). */
  insulationThicknessMm: number;
  /** Ceiling plane (top of ceiling tiles) in mm above FFL; null = auto-derive. */
  ceilingPlaneMm: number | null;
  /** Structural soffit / highest usable level in mm above FFL; null = routing ceiling limit. */
  soffitMm: number | null;
  /** Clear space kept above the ceiling tiles and below the soffit (mm). */
  envelopeClearanceMm: number;
  /** Surface-to-surface clearance to insulated refrigerant pipes (mm). */
  refrigerantClearanceMm: number;
  /** Plan clearance kept around equipment bodies (mm). */
  equipmentClearanceMm: number;
  pumpPolicy: CondensatePumpPolicy;
  /** Drain-pump lift used when a unit has a pump but no model-specific value (mm). */
  defaultPumpMaxLiftMm: number;
  /** The lift riser must rise within this plan distance of the unit (mm). */
  liftMaxHorizontalMm: number;
  /** Margin added above the minimum required lift (mm). */
  liftMarginMm: number;
  /** A collective main runs at least this far below the gravity drain ports feeding it (mm). */
  mainBelowPortsMm: number;
  /** Advisory maximum horizontal run from a unit to its gully (mm). */
  maxUnitRunMm: number;
  /** Minimum spacing between junctions and bends on a main (mm). */
  junctionSpacingMm: number;
  /** Extra drop so a branch enters the crown of the main through the wye (mm). */
  joinSocketAllowanceMm: number;
  /** Upsize grouped mains (2+ units) to at least this outer diameter (mm); null = off. */
  groupedMainMinOuterDiameterMm: number | null;
  capacityTable: CondensateCapacityRow[];
  /** Design condensate generation per kW of cooling (L/h per kW). */
  condensateLitresPerHourPerKw: number;
  manningN: number;
  /** Maximum design fill ratio (depth / diameter) for the hydraulic check. */
  maxFillRatio: number;
  supportSpacingHorizontalMm: number;
  supportSpacingVerticalMm: number;
  supportNearFittingMm: number;
  cleanoutMaxSpacingMm: number;
  airVentForPumpedMains: boolean;
  trapNegativePressureUnits: boolean;
  /** Trap seal margin added to the fan static pressure head (mm). */
  trapSealMarginMm: number;
  airBreakMm: number;
  // Router cost model (mm-equivalents).
  bendPenaltyMm: number;
  wallPenetrationPenaltyMm: number;
  refrigerantCrossingPenaltyMm: number;
  /** Fractional discount for running inside a refrigerant corridor lane. */
  corridorBonusRatio: number;
  gullyCandidateCount: number;
  // Presentation.
  showFallTags: boolean;
  showLevelTags: boolean;
  showHangers: boolean;
}

export interface CondensateRuleSource {
  source: string;
  verified: boolean;
  note?: string;
}

/**
 * IMC 2015+ Table 307.2.2 / UPC 814.3 converted from tons (3.517 kW/TR).
 * Secondary sources disagree on the first rows, so the table stays an editable
 * project setting and is flagged unverified until checked against the adopted
 * code edition.
 */
export const DEFAULT_CONDENSATE_CAPACITY_TABLE: CondensateCapacityRow[] = [
  { maxCapacityKw: 70.3, minInnerDiameterMm: 19.05 },
  { maxCapacityKw: 140.7, minInnerDiameterMm: 25.4 },
  { maxCapacityKw: 316.5, minInnerDiameterMm: 31.75 },
  { maxCapacityKw: 439.6, minInnerDiameterMm: 38.1 },
  { maxCapacityKw: 879.2, minInnerDiameterMm: 50.8 },
];

export const DEFAULT_CONDENSATE_SETTINGS: CondensateDesignSettings = {
  minSlopePercent: 1,
  preferredSlopePercent: 2,
  pipeSystem: 'bs-en-1329',
  insulationThicknessMm: 9,
  ceilingPlaneMm: null,
  soffitMm: null,
  envelopeClearanceMm: 25,
  refrigerantClearanceMm: 50,
  equipmentClearanceMm: 60,
  pumpPolicy: 'always',
  defaultPumpMaxLiftMm: 600,
  liftMaxHorizontalMm: 300,
  liftMarginMm: 50,
  mainBelowPortsMm: 100,
  maxUnitRunMm: 20000,
  junctionSpacingMm: 300,
  joinSocketAllowanceMm: 20,
  groupedMainMinOuterDiameterMm: null,
  capacityTable: DEFAULT_CONDENSATE_CAPACITY_TABLE,
  condensateLitresPerHourPerKw: 0.5,
  manningN: 0.009,
  maxFillRatio: 0.5,
  supportSpacingHorizontalMm: 1000,
  supportSpacingVerticalMm: 1500,
  supportNearFittingMm: 300,
  cleanoutMaxSpacingMm: 15000,
  airVentForPumpedMains: true,
  trapNegativePressureUnits: true,
  trapSealMarginMm: 25,
  airBreakMm: 25,
  bendPenaltyMm: 400,
  wallPenetrationPenaltyMm: 1500,
  refrigerantCrossingPenaltyMm: 600,
  corridorBonusRatio: 0.12,
  gullyCandidateCount: 3,
  showFallTags: true,
  showLevelTags: true,
  showHangers: false,
};

export const CONDENSATE_RULE_SOURCES: Partial<Record<keyof CondensateDesignSettings, CondensateRuleSource>> = {
  minSlopePercent: { source: 'Daikin VRV/FXDQ IM, Mitsubishi City Multi IM, IMC 307.2.1 (1/8 in per ft)', verified: true },
  preferredSlopePercent: { source: 'Industry practice (1/4 in per ft), CSE cooling-coil condensate design', verified: true },
  pumpPolicy: { source: 'Daikin FXFQ/FXDQ, MHI FDT IM: drain-raising pipe rises vertically at the unit, then falls ≥ 1/100 immediately', verified: true, note: 'Rise to the high point; "only as high as needed" keeps the minimum lift.' },
  defaultPumpMaxLiftMm: { source: 'Daikin FXDQ 600 mm / FXFQ 675 mm; others 500–750 mm', verified: true, note: 'Use the unit manual value when known.' },
  liftMaxHorizontalMm: { source: 'Daikin FXDQ drain-raising pipe within 300 mm of the unit', verified: true },
  mainBelowPortsMm: { source: 'Mitsubishi City Multi: collected pipe 10 cm lower than unit drain port', verified: true },
  maxUnitRunMm: { source: 'Mitsubishi City Multi: cross-wise drain < 20 m', verified: true, note: 'Advisory.' },
  insulationThicknessMm: { source: 'Mitsubishi City Multi: 9 mm or more', verified: true },
  capacityTable: { source: 'IMC Table 307.2.2 / UPC Table 814.3', verified: false, note: 'Secondary sources conflict on the first rows; confirm against the adopted code edition.' },
  supportSpacingHorizontalMm: { source: 'Daikin 0.8–1.0 m horizontal (IMC 1.2 m for PVC)', verified: true },
  supportSpacingVerticalMm: { source: 'Daikin 1.5–2.0 m vertical', verified: true },
  airVentForPumpedMains: { source: 'Daikin VRV IM: air vent at the highest point of collective drain piping', verified: true },
  trapNegativePressureUnits: { source: 'Daikin; CSE "H + 1 in" draw-through trap rule', verified: true },
  airBreakMm: { source: 'IMC 307.2.1 indirect discharge; UK tundish practice', verified: true },
  refrigerantClearanceMm: { source: 'Coordination practice (1–2 in between drain and refrigerant insulation)', verified: false, note: 'Project setting.' },
  cleanoutMaxSpacingMm: { source: 'IMC 307.2.5 (clearable without cutting); project spacing', verified: false },
  manningN: { source: 'Manning roughness for smooth PVC', verified: true },
  condensateLitresPerHourPerKw: { source: 'Rule of thumb for humid climates (0.6–1.8 L/h per TR)', verified: false },
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return finite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function nullableNumber(value: unknown, fallback: number | null, min: number, max: number): number | null {
  if (value === null) return null;
  return finite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function resolveCapacityTable(value: unknown): CondensateCapacityRow[] {
  if (!Array.isArray(value)) return DEFAULT_CONDENSATE_CAPACITY_TABLE;
  const rows = value
    .filter((row): row is CondensateCapacityRow => Boolean(row)
      && finite((row as CondensateCapacityRow).maxCapacityKw)
      && finite((row as CondensateCapacityRow).minInnerDiameterMm)
      && (row as CondensateCapacityRow).maxCapacityKw > 0
      && (row as CondensateCapacityRow).minInnerDiameterMm > 0)
    .map((row) => ({ maxCapacityKw: row.maxCapacityKw, minInnerDiameterMm: row.minInnerDiameterMm }))
    .sort((left, right) => left.maxCapacityKw - right.maxCapacityKw);
  return rows.length > 0 ? rows : DEFAULT_CONDENSATE_CAPACITY_TABLE;
}

/** Drops invalid values field by field; a corrupt document never breaks the generator. */
export function resolveCondensateSettings(input?: Partial<CondensateDesignSettings> | null): CondensateDesignSettings {
  const raw = (input ?? {}) as Partial<Record<keyof CondensateDesignSettings, unknown>>;
  const d = DEFAULT_CONDENSATE_SETTINGS;
  const minSlopePercent = clampNumber(raw.minSlopePercent, d.minSlopePercent, 0.25, 10);
  const pipeSystem: CondensatePipeSystemId = raw.pipeSystem === 'jis-vp' || raw.pipeSystem === 'astm-sch40' || raw.pipeSystem === 'bs-en-1329'
    ? raw.pipeSystem
    : d.pipeSystem;
  const pumpPolicy: CondensatePumpPolicy = raw.pumpPolicy === 'always' || raw.pumpPolicy === 'never' || raw.pumpPolicy === 'when-needed'
    ? raw.pumpPolicy
    : d.pumpPolicy;
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  return {
    minSlopePercent,
    preferredSlopePercent: Math.max(minSlopePercent, clampNumber(raw.preferredSlopePercent, d.preferredSlopePercent, 0.25, 10)),
    pipeSystem,
    insulationThicknessMm: clampNumber(raw.insulationThicknessMm, d.insulationThicknessMm, 0, 50),
    ceilingPlaneMm: nullableNumber(raw.ceilingPlaneMm, d.ceilingPlaneMm, 0, 100000),
    soffitMm: nullableNumber(raw.soffitMm, d.soffitMm, 0, 100000),
    envelopeClearanceMm: clampNumber(raw.envelopeClearanceMm, d.envelopeClearanceMm, 0, 500),
    refrigerantClearanceMm: clampNumber(raw.refrigerantClearanceMm, d.refrigerantClearanceMm, 0, 500),
    equipmentClearanceMm: clampNumber(raw.equipmentClearanceMm, d.equipmentClearanceMm, 0, 1000),
    pumpPolicy,
    defaultPumpMaxLiftMm: clampNumber(raw.defaultPumpMaxLiftMm, d.defaultPumpMaxLiftMm, 0, 2000),
    liftMaxHorizontalMm: clampNumber(raw.liftMaxHorizontalMm, d.liftMaxHorizontalMm, 50, 2000),
    liftMarginMm: clampNumber(raw.liftMarginMm, d.liftMarginMm, 0, 500),
    mainBelowPortsMm: clampNumber(raw.mainBelowPortsMm, d.mainBelowPortsMm, 0, 1000),
    maxUnitRunMm: clampNumber(raw.maxUnitRunMm, d.maxUnitRunMm, 1000, 1000000),
    junctionSpacingMm: clampNumber(raw.junctionSpacingMm, d.junctionSpacingMm, 50, 3000),
    joinSocketAllowanceMm: clampNumber(raw.joinSocketAllowanceMm, d.joinSocketAllowanceMm, 0, 200),
    groupedMainMinOuterDiameterMm: nullableNumber(raw.groupedMainMinOuterDiameterMm, d.groupedMainMinOuterDiameterMm, 10, 200),
    capacityTable: resolveCapacityTable(raw.capacityTable),
    condensateLitresPerHourPerKw: clampNumber(raw.condensateLitresPerHourPerKw, d.condensateLitresPerHourPerKw, 0, 10),
    manningN: clampNumber(raw.manningN, d.manningN, 0.005, 0.03),
    maxFillRatio: clampNumber(raw.maxFillRatio, d.maxFillRatio, 0.1, 0.95),
    supportSpacingHorizontalMm: clampNumber(raw.supportSpacingHorizontalMm, d.supportSpacingHorizontalMm, 200, 5000),
    supportSpacingVerticalMm: clampNumber(raw.supportSpacingVerticalMm, d.supportSpacingVerticalMm, 200, 5000),
    supportNearFittingMm: clampNumber(raw.supportNearFittingMm, d.supportNearFittingMm, 50, 1000),
    cleanoutMaxSpacingMm: clampNumber(raw.cleanoutMaxSpacingMm, d.cleanoutMaxSpacingMm, 2000, 100000),
    airVentForPumpedMains: bool(raw.airVentForPumpedMains, d.airVentForPumpedMains),
    trapNegativePressureUnits: bool(raw.trapNegativePressureUnits, d.trapNegativePressureUnits),
    trapSealMarginMm: clampNumber(raw.trapSealMarginMm, d.trapSealMarginMm, 0, 200),
    airBreakMm: clampNumber(raw.airBreakMm, d.airBreakMm, 0, 200),
    bendPenaltyMm: clampNumber(raw.bendPenaltyMm, d.bendPenaltyMm, 0, 10000),
    wallPenetrationPenaltyMm: clampNumber(raw.wallPenetrationPenaltyMm, d.wallPenetrationPenaltyMm, 0, 100000),
    refrigerantCrossingPenaltyMm: clampNumber(raw.refrigerantCrossingPenaltyMm, d.refrigerantCrossingPenaltyMm, 0, 100000),
    corridorBonusRatio: clampNumber(raw.corridorBonusRatio, d.corridorBonusRatio, 0, 0.5),
    gullyCandidateCount: Math.round(clampNumber(raw.gullyCandidateCount, d.gullyCandidateCount, 1, 8)),
    showFallTags: bool(raw.showFallTags, d.showFallTags),
    showLevelTags: bool(raw.showLevelTags, d.showLevelTags),
    showHangers: bool(raw.showHangers, d.showHangers),
  };
}

/** A slope percentage as the fall ratio drafters write ("1:100"). */
export function formatFallRatio(slopePercent: number): string {
  if (!(slopePercent > 0)) return 'level';
  return `1:${Math.round(100 / slopePercent)}`;
}
