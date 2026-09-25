/**
 * Duct design settings (persisted with the document). Engineering tables live
 * in the catalog; these are the project choices that select from them, plus
 * the commercial sheet stock, which is configuration rather than engineering.
 * Every value names its provenance so the panel can show whether a default is
 * verified.
 */
import type { DuctRuleProvenance } from './ductSources';

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
  elbowStyle: DuctElbowStyle;
  /** Radius elbow centreline radius as a multiple of the in-plane width (R/W). */
  elbowCentrelineRatio: number;
  /** Straight neck on each end of an elbow, for the flange (mm). */
  elbowNeckMm: number;
  /** Turning-vane pitch in square elbows (mm). */
  vaneSpacingMm: number;
  flexibleConnectorAtUnit: boolean;
  /** Fabric width of the flexible connector (mm). */
  connectorFabricMm: number;
  /** Metal edge on each side of the fabric (mm). */
  connectorMetalMm: number;
  showSizeTags: boolean;
  showJointTicks: boolean;
  showPieceMarks: boolean;
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
  elbowStyle: 'auto',
  elbowCentrelineRatio: 1,
  elbowNeckMm: 50,
  vaneSpacingMm: 38,
  flexibleConnectorAtUnit: true,
  connectorFabricMm: 100,
  connectorMetalMm: 75,
  showSizeTags: true,
  showJointTicks: true,
  showPieceMarks: false,
};

export const DUCT_RULE_SOURCES: Partial<Record<keyof DuctDesignSettings, DuctRuleProvenance>> = {
  gaugeMode: { sourceId: 'smacna-1995', reference: '§1.8.1, Tables 1-3M/1-4M/1-5M', verified: true },
  supplyPressureClassPa: { sourceId: 'smacna-1995', reference: 'Table 1-1; only 125/250/500 Pa are encoded', verified: true },
  returnPressureClassPa: { sourceId: 'smacna-1995', reference: 'Table 1-1; negative pressure mode', verified: true },
  sectionLengthMm: { sourceId: 'fabricator-practice', verified: true, note: 'Coil-line section length; SMACNA columns go to 3.0 m.' },
  minMakeUpPieceMm: { sourceId: 'fabricator-practice', verified: false },
  availableSheetThicknessesMm: {
    sourceId: 'project-configuration', verified: false,
    note: 'Provisional Finland stock list; replace with the fabricator/supplier stock.',
  },
  jointSystem: {
    sourceId: 'smacna-1995', reference: 'Table 1-12M', verified: true,
    note: 'auto = TDC when its thickness rating reaches the required class, otherwise a T-22 companion angle.',
  },
  washersPerBolt: { sourceId: 'fabricator-practice', verified: false },
  longitudinalSeam: { sourceId: 'smacna-1995', reference: 'Fig. 1-5 notes', verified: true },
  elbowStyle: { sourceId: 'institutional-specs', verified: false, note: 'SMACNA Fig. 2-2 is an image; square elbows only with vanes.' },
  elbowCentrelineRatio: { sourceId: 'institutional-specs', verified: false, note: 'R/W 1.0 minimum, 1.5 preferred (Fig. 2-2 not read).' },
  elbowNeckMm: { sourceId: 'fabricator-practice', verified: false },
  vaneSpacingMm: { sourceId: 'institutional-specs', verified: false, note: 'Dartmouth: single-thickness vanes at 1½″ (Fig. 2-3 not read).' },
  flexibleConnectorAtUnit: { sourceId: 'institutional-specs', verified: true, note: 'Flexible connection wherever duct meets vibration-isolated equipment.' },
  connectorFabricMm: { sourceId: 'fabricator-practice', verified: false, note: 'Texas State: ≥2½″ (63.5 mm) between metal edges plus slack.' },
  connectorMetalMm: { sourceId: 'fabricator-practice', verified: false },
};

export const DUCT_SUPPORTED_PRESSURE_CLASSES_PA = [125, 250, 500] as const;

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
    elbowStyle: oneOf(raw.elbowStyle, ['auto', 'radius', 'square-vaned'] as const, d.elbowStyle),
    elbowCentrelineRatio: clampNumber(raw.elbowCentrelineRatio, d.elbowCentrelineRatio, 0.5, 3),
    elbowNeckMm: clampNumber(raw.elbowNeckMm, d.elbowNeckMm, 0, 300),
    vaneSpacingMm: clampNumber(raw.vaneSpacingMm, d.vaneSpacingMm, 20, 200),
    flexibleConnectorAtUnit: bool(raw.flexibleConnectorAtUnit, d.flexibleConnectorAtUnit),
    connectorFabricMm: clampNumber(raw.connectorFabricMm, d.connectorFabricMm, 50, 400),
    connectorMetalMm: clampNumber(raw.connectorMetalMm, d.connectorMetalMm, 20, 200),
    showSizeTags: bool(raw.showSizeTags, d.showSizeTags),
    showJointTicks: bool(raw.showJointTicks, d.showJointTicks),
    showPieceMarks: bool(raw.showPieceMarks, d.showPieceMarks),
  };
}
