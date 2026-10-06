/**
 * Sheet thickness, joint class and joint member for a rectangular section —
 * SMACNA 1995 §1.8.1 "Rectangular Table Reading Guide", then the commercial
 * sheet stock, then the joint system.
 *
 *  1. The greater dimension's row at the joint-spacing column gives the minimum
 *     thickness for all four sides and that side's class — or the column-2
 *     "no reinforcement" thickness when it is not heavier.
 *  2. The narrow side needs no class if that thickness meets its own column 2;
 *     otherwise its class is the letter in its row at the same column.
 *  3. The joint must reach the higher of the two classes.
 *  4. The smallest stocked sheet ≥ the SMACNA minimum is used (never thinner).
 *  5. Formed flanges (TDC/TDF, Ductmate) are rated by duct thickness, a T-22
 *     angle by its member (Table 1-12M).
 *
 * Pressure classes above 500 Pa return an explicit unsupported result: Tables
 * 1-6M..1-9M have not been transcribed and verified.
 */
import {
  COMMON_LONGEST_SIDE_TABLE,
  companionAngleForClass,
  creditedNominalThicknessMm,
  formedFlangeRatingForSheet,
  gaugeLabelForSheet,
  maxRigidityClass,
  rigidityIndex,
  selectDuctmateSeries,
  type DuctmateSeries,
  type JointRigidityRow,
  type PressureMode,
} from './ductCatalog';
import { roundMinimumThickness, ROUND_REINFORCEMENT_ANGLES, type DuctRoundJointType } from './ductRoundRules';
import type { DuctDesignSettings, DuctGaugeMode, DuctJointSystem } from './ductSettings';
import type { DuctConstruction, DuctLeg, DuctRunSpec, DuctService } from './ductTypes';
import {
  SMACNA_REINFORCEMENT_SPACINGS_MM,
  SMACNA_TABLE_1_3M,
  SMACNA_TABLE_1_4M,
  SMACNA_TABLE_1_5M,
  type SmacnaReinforcementCell,
  type SmacnaReinforcementRow,
  type SmacnaReinforcementTable,
  type SmacnaRigidityClass,
} from './smacnaRectangularTables';

export type DuctConstructionStatus =
  | 'ok'
  | 'unsupported-pressure'
  | 'gauge-override-invalid'
  | 'size-over-table'
  | 'no-stock'
  | 'joint-not-achievable';

export type ResolvedDuctJoint =
  | { system: 'tdc'; ratedClass: SmacnaRigidityClass | null; thickened: boolean }
  | { system: 'ductmate'; series: DuctmateSeries['id']; ratedClass: SmacnaRigidityClass; flangeHeightMm: number }
  | { system: 'angle-flange'; member: NonNullable<JointRigidityRow['companionAngle']>; forClass: SmacnaRigidityClass | null }
  /** Round duct slip joint (SMACNA Fig. 3-2): RT-1 beaded sleeve or RT-5 crimp. */
  | { system: 'round-slip'; type: DuctRoundJointType };

export interface SectionConstruction {
  status: DuctConstructionStatus;
  /** Why a non-ok status was returned (user-facing). */
  message?: string;
  gaugeMode: DuctGaugeMode;
  pressureClassPa: number;
  pressureMode: PressureMode;
  /** The SMACNA table used (null in longest-side mode or when refused); round: '3-2AM' / '3-2BM'. */
  table: SmacnaReinforcementTable['table'] | '3-2AM' | '3-2BM' | null;
  jointSpacingMm: number;
  /** SMACNA spacing column actually read (mm). */
  spacingColumnMm: number | null;
  smacnaMinThicknessMm: number | null;
  sheetThicknessMm: number | null;
  gaugeLabel: string;
  /** The greater side qualifies without reinforcement (column 2). */
  unreinforced: boolean;
  requiredClass: SmacnaRigidityClass | null;
  sideClasses: { width: SmacnaRigidityClass | null; height: SmacnaRigidityClass | null };
  /** Tie-rodded alternative printed in the governing cell (not applied). */
  tieRodAlternative: SmacnaRigidityClass | null;
  /** Between-joint reinforcement needed because the joint spacing is Not Designed. */
  intermediate: { spacingMm: number; cls: SmacnaRigidityClass } | null;
  joint: ResolvedDuctJoint | null;
  crossBreak: { width: boolean; height: boolean };
  notes: string[];
}

export interface SectionConstructionInput {
  widthMm: number;
  heightMm: number;
  service: DuctService;
  construction: DuctConstruction;
  settings: DuctDesignSettings;
  /** Overrides from the run record. */
  pressureClassPa?: number | null;
  jointSystem?: DuctJointSystem | null;
  jointSpacingMm?: number;
  /** Sheet chosen by the run instead of the automatic stock pick. */
  gaugeOverrideMm?: number | null;
  /** Round section: its diameter (the rectangular tables do not apply). */
  diameterMm?: number;
}

const EPSILON = 1e-6;
/** S1.15 cross-break thresholds. */
const CROSS_BREAK_MIN_SIDE_MM = 483;
const CROSS_BREAK_MAX_SHEET_MM = 1.0;
const CROSS_BREAK_MIN_PANEL_M2 = 0.93;

export function smacnaTableForPressure(pressurePa: number): SmacnaReinforcementTable | null {
  if (!(pressurePa > 0)) return null;
  if (pressurePa <= 125) return SMACNA_TABLE_1_3M;
  if (pressurePa <= 250) return SMACNA_TABLE_1_4M;
  if (pressurePa <= 500) return SMACNA_TABLE_1_5M;
  return null;
}

export function smacnaRowForSide(table: SmacnaReinforcementTable, sideMm: number): SmacnaReinforcementRow | null {
  return table.rows.find((row) => sideMm <= row.maxMm + EPSILON) ?? null;
}

/** Index of the shortest tabulated spacing that is still ≥ the actual spacing. */
export function spacingColumnIndex(jointSpacingMm: number): number | null {
  let index: number | null = null;
  SMACNA_REINFORCEMENT_SPACINGS_MM.forEach((spacing, candidate) => {
    if (spacing + EPSILON >= jointSpacingMm) index = candidate;
  });
  return index;
}

function hasCodes(row: SmacnaReinforcementRow): boolean {
  return row.cells.some((cell) => cell !== null);
}

/** The cell at a column, walking to shorter spacings while it is Not Designed. */
function cellAtOrShorter(row: SmacnaReinforcementRow, column: number): { cell: SmacnaReinforcementCell; column: number } | null {
  for (let index = column; index < row.cells.length; index += 1) {
    const cell = row.cells[index];
    if (cell) return { cell, column: index };
  }
  return null;
}

/** Smallest stocked sheet that is at least the required minimum. */
export function selectStockSheet(requiredMm: number, stockMm: readonly number[]): number | null {
  const sorted = [...stockMm].sort((a, b) => a - b);
  return sorted.find((sheet) => sheet + EPSILON >= requiredMm) ?? null;
}

export function pressureModeForService(service: DuctService): PressureMode {
  return service === 'return' ? 'negative' : 'positive';
}

export function pressureClassForService(service: DuctService, settings: DuctDesignSettings): number {
  return service === 'return' ? settings.returnPressureClassPa : settings.supplyPressureClassPa;
}

function crossBreakFor(sideMm: number, sheetMm: number | null, spacingMm: number, construction: DuctConstruction): boolean {
  if (construction !== 'gi-bare' || sheetMm === null) return false;
  return sideMm >= CROSS_BREAK_MIN_SIDE_MM
    && sheetMm <= CROSS_BREAK_MAX_SHEET_MM + EPSILON
    && (sideMm * spacingMm) / 1e6 > CROSS_BREAK_MIN_PANEL_M2;
}

function resolveJoint(
  system: DuctJointSystem,
  sheetMm: number,
  required: SmacnaRigidityClass | null,
  mode: PressureMode,
  stock: readonly number[],
): { joint: ResolvedDuctJoint | null; sheetMm: number; message?: string } {
  const meets = (rating: SmacnaRigidityClass | null) =>
    required === null || (rating !== null && rigidityIndex(rating) >= rigidityIndex(required));
  if (system === 'angle-flange') {
    return { joint: { system: 'angle-flange', member: companionAngleForClass(required), forClass: required }, sheetMm };
  }
  if (system === 'ductmate') {
    const series = selectDuctmateSeries(sheetMm, required);
    if (!series) {
      return { joint: null, sheetMm, message: `No Ductmate series covers a ${sheetMm} mm sheet at class ${required ?? '—'}.` };
    }
    return { joint: { system: 'ductmate', series: series.id, ratedClass: series.ratedClass, flangeHeightMm: series.flangeHeightMm }, sheetMm };
  }
  const rating = formedFlangeRatingForSheet(sheetMm, mode);
  if (meets(rating)) return { joint: { system: 'tdc', ratedClass: rating, thickened: false }, sheetMm };
  if (system === 'auto') {
    return { joint: { system: 'angle-flange', member: companionAngleForClass(required), forClass: required }, sheetMm };
  }
  // Explicit TDC: thicken the duct until its formed flange reaches the class.
  for (const sheet of [...stock].sort((a, b) => a - b)) {
    if (sheet <= sheetMm + EPSILON) continue;
    const thicker = formedFlangeRatingForSheet(sheet, mode);
    if (meets(thicker)) return { joint: { system: 'tdc', ratedClass: thicker, thickened: true }, sheetMm: sheet };
  }
  return {
    joint: null,
    sheetMm,
    message: `A TDC flange cannot reach class ${required} (${mode} pressure) with the stocked sheets; use an angle flange.`,
  };
}

/**
 * The sheet one of a run's sections is made of, by the run's own choices (a
 * round section by the round tables, as the run's own plan resolves it), or
 * `fallback` when it cannot be resolved. Branches use it for their parent's
 * wall, so a collar meets the parent's real outside.
 */
export function runSectionSheetMm(
  spec: Pick<DuctRunSpec, 'service' | 'construction' | 'pressureClassPa' | 'jointSystem' | 'gaugeOverrideMm'>,
  section: DuctLeg,
  settings: DuctDesignSettings,
  fallback = 1,
): number {
  return resolveSectionConstruction({
    widthMm: section.widthMm, heightMm: section.heightMm, service: spec.service, construction: spec.construction,
    settings, pressureClassPa: spec.pressureClassPa, jointSystem: spec.jointSystem, gaugeOverrideMm: spec.gaugeOverrideMm,
    ...(section.diameterMm !== undefined ? { diameterMm: section.diameterMm } : {}),
  }).sheetThicknessMm ?? fallback;
}

export function resolveSectionConstruction(input: SectionConstructionInput): SectionConstruction {
  const { settings, service, construction } = input;
  const widthMm = Math.max(1, input.widthMm);
  const heightMm = Math.max(1, input.heightMm);
  const jointSpacingMm = input.jointSpacingMm ?? settings.sectionLengthMm;
  const pressureClassPa = input.pressureClassPa ?? pressureClassForService(service, settings);
  const pressureMode = pressureModeForService(service);
  const system = input.jointSystem ?? settings.jointSystem;
  const base: SectionConstruction = {
    status: 'ok',
    gaugeMode: settings.gaugeMode,
    pressureClassPa,
    pressureMode,
    table: null,
    jointSpacingMm,
    spacingColumnMm: null,
    smacnaMinThicknessMm: null,
    sheetThicknessMm: null,
    gaugeLabel: '—',
    unreinforced: false,
    requiredClass: null,
    sideClasses: { width: null, height: null },
    tieRodAlternative: null,
    intermediate: null,
    joint: null,
    crossBreak: { width: false, height: false },
    notes: [],
  };

  const table = smacnaTableForPressure(pressureClassPa);
  if (!table) {
    return {
      ...base,
      status: 'unsupported-pressure',
      message: `Pressure class ${pressureClassPa} Pa is not supported: only 125, 250 and 500 Pa (SMACNA Tables 1-3M to 1-5M) are verified.`,
    };
  }
  if (input.diameterMm !== undefined) return resolveRoundConstruction(input, base, pressureMode);
  const greater = Math.max(widthMm, heightMm);
  const lesser = Math.min(widthMm, heightMm);

  let minimumMm: number;
  let requiredClass: SmacnaRigidityClass | null = null;
  const sideClasses: SectionConstruction['sideClasses'] = { width: null, height: null };
  let unreinforced = false;
  let spacingColumnMm: number | null = null;
  let intermediate: SectionConstruction['intermediate'] = null;
  let tieRodAlternative: SmacnaRigidityClass | null = null;
  const notes: string[] = [];

  if (settings.gaugeMode === 'longest-side') {
    minimumMm = COMMON_LONGEST_SIDE_TABLE.find((row) => greater <= row.maxSideMm + EPSILON)!.thicknessMm;
    notes.push('Longest-side gauge table: not SMACNA-derived; no joint class is checked.');
  } else {
    const rowG = smacnaRowForSide(table, greater);
    const rowL = smacnaRowForSide(table, lesser);
    const column = spacingColumnIndex(jointSpacingMm);
    if (!rowG || !rowL) {
      return { ...base, table: table.table, status: 'size-over-table', message: `A ${Math.round(greater)} mm side exceeds SMACNA Table ${table.table} (3000 mm).` };
    }
    if (column === null) {
      return { ...base, table: table.table, status: 'size-over-table', message: `Joint spacing ${jointSpacingMm} mm exceeds the 3.0 m SMACNA column.` };
    }
    spacingColumnMm = SMACNA_REINFORCEMENT_SPACINGS_MM[column]!;
    let effectiveColumn = column;
    if (!hasCodes(rowG)) {
      // NOT REQUIRED: flat joints are enough at any spacing.
      minimumMm = rowG.unreinforcedMm ?? 0.55;
      unreinforced = true;
    } else {
      const found = cellAtOrShorter(rowG, column);
      if (!found) {
        return { ...base, table: table.table, status: 'size-over-table', message: `No SMACNA construction for ${Math.round(greater)} mm at ${jointSpacingMm} mm spacing.` };
      }
      if (found.column !== column) {
        effectiveColumn = found.column;
        intermediate = { spacingMm: SMACNA_REINFORCEMENT_SPACINGS_MM[found.column]!, cls: found.cell.cls };
        notes.push(`Joint spacing is Not Designed for ${Math.round(greater)} mm; intermediate reinforcement at ${intermediate.spacingMm} mm (Table 1-10M).`);
      }
      if (intermediate === null && rowG.unreinforcedMm !== null && rowG.unreinforcedMm <= found.cell.thicknessMm + EPSILON) {
        minimumMm = rowG.unreinforcedMm;
        unreinforced = true;
      } else {
        minimumMm = found.cell.thicknessMm;
        requiredClass = found.cell.cls;
        tieRodAlternative = found.cell.tieRodClass ?? null;
      }
    }
    const greaterIsWidth = widthMm >= heightMm;
    const greaterClass = requiredClass;
    let lesserClass: SmacnaRigidityClass | null = null;
    if (!(rowL.unreinforcedMm !== null && minimumMm + EPSILON >= rowL.unreinforcedMm) && hasCodes(rowL)) {
      lesserClass = cellAtOrShorter(rowL, effectiveColumn)?.cell.cls ?? null;
    }
    sideClasses.width = greaterIsWidth ? greaterClass : lesserClass;
    sideClasses.height = greaterIsWidth ? lesserClass : greaterClass;
    if (widthMm === heightMm) sideClasses.height = sideClasses.width;
    requiredClass = maxRigidityClass(greaterClass, lesserClass);
  }

  let stockSheet = selectStockSheet(minimumMm, settings.availableSheetThicknessesMm);
  const partial: SectionConstruction = {
    ...base,
    table: settings.gaugeMode === 'smacna' ? table.table : null,
    spacingColumnMm,
    smacnaMinThicknessMm: minimumMm,
    unreinforced,
    requiredClass,
    sideClasses,
    tieRodAlternative,
    intermediate,
    notes,
  };
  if (stockSheet === null) {
    return {
      ...partial,
      status: 'no-stock',
      message: `No stocked sheet is at least ${minimumMm} mm (stock: ${settings.availableSheetThicknessesMm.join(', ')} mm).`,
    };
  }

  const override = input.gaugeOverrideMm ?? null;
  if (override !== null) {
    const stocked = settings.availableSheetThicknessesMm.some((sheet) => Math.abs(sheet - override) < 1e-6);
    if (!stocked || override + EPSILON < minimumMm) {
      return {
        ...partial,
        status: 'gauge-override-invalid',
        message: !stocked
          ? `The chosen ${override} mm sheet is not in the stock list (${settings.availableSheetThicknessesMm.join(', ')} mm).`
          : `The chosen ${override} mm sheet is lighter than the SMACNA minimum ${minimumMm} mm.`,
      };
    }
    notes.push(`Sheet set to ${override} mm on this run (SMACNA minimum ${minimumMm} mm).`);
    stockSheet = override;
  }

  const effectiveSystem: DuctJointSystem = settings.gaugeMode === 'longest-side' && system === 'auto' ? 'tdc' : system;
  const joint = resolveJoint(effectiveSystem, stockSheet, requiredClass, pressureMode, settings.availableSheetThicknessesMm);
  const sheetMm = joint.sheetMm;
  if (joint.joint?.system === 'tdc' && joint.joint.thickened) {
    notes.push(`Sheet thickened to ${sheetMm} mm so the TDC flange reaches class ${requiredClass}.`);
  }
  if (creditedNominalThicknessMm(sheetMm) === null) {
    notes.push(`${sheetMm} mm is below the lightest SMACNA gauge.`);
  }
  return {
    ...partial,
    status: joint.joint ? 'ok' : 'joint-not-achievable',
    message: joint.message,
    sheetThicknessMm: sheetMm,
    gaugeLabel: gaugeLabelForSheet(sheetMm),
    joint: joint.joint,
    crossBreak: {
      width: crossBreakFor(widthMm, sheetMm, jointSpacingMm, construction),
      height: crossBreakFor(heightMm, sheetMm, jointSpacingMm, construction),
    },
  };
}

/**
 * Round sections (SMACNA chapter 3): the ±500 Pa column of Table 3-2AM (supply)
 * or 3-2BM (return) by diameter and seam, the stock sheet at or above it, and a
 * slip joint (RT-1 beaded sleeve for spiral duct, RT-5 crimp for longitudinal).
 */
function resolveRoundConstruction(input: SectionConstructionInput, base: SectionConstruction, pressureMode: PressureMode): SectionConstruction {
  const { settings } = input;
  const diameter = input.diameterMm!;
  const round = roundMinimumThickness(diameter, settings.roundSeam, pressureMode === 'negative');
  if (!round) {
    return { ...base, status: 'size-over-table', message: `Ø${Math.round(diameter)} with a ${settings.roundSeam} seam is beyond SMACNA Table 3-2${pressureMode === 'negative' ? 'B' : 'A'}M.` };
  }
  const notes: string[] = [];
  if (round.reinforcement) {
    notes.push(`Reinforcement angle ${round.reinforcement.angle} (${ROUND_REINFORCEMENT_ANGLES[round.reinforcement.angle]} mm) at ${round.reinforcement.spacingM} m (Table 3-2BM).`);
  }
  const partial: SectionConstruction = {
    ...base, table: round.table, smacnaMinThicknessMm: round.minimumMm, unreinforced: !round.reinforcement, notes,
  };
  let sheet = selectStockSheet(round.minimumMm, settings.availableSheetThicknessesMm);
  const override = input.gaugeOverrideMm ?? null;
  if (override !== null) {
    const stocked = settings.availableSheetThicknessesMm.some((candidate) => Math.abs(candidate - override) < 1e-6);
    if (!stocked || override + EPSILON < round.minimumMm) {
      return {
        ...partial, status: 'gauge-override-invalid',
        message: !stocked
          ? `The chosen ${override} mm sheet is not in the stock list (${settings.availableSheetThicknessesMm.join(', ')} mm).`
          : `The chosen ${override} mm sheet is lighter than the SMACNA minimum ${round.minimumMm} mm.`,
      };
    }
    sheet = override;
  }
  if (sheet === null) {
    return { ...partial, status: 'no-stock', message: `No stocked sheet is at least ${round.minimumMm} mm (stock: ${settings.availableSheetThicknessesMm.join(', ')} mm).` };
  }
  return {
    ...partial,
    sheetThicknessMm: sheet,
    gaugeLabel: gaugeLabelForSheet(sheet),
    joint: { system: 'round-slip', type: settings.roundSeam === 'spiral' ? 'RT-1' : 'RT-5' },
  };
}

/** Short label, e.g. "TDC (class G)", "DM35", "L 38.1×3.2". */
export function describeJoint(joint: ResolvedDuctJoint | null): string {
  if (!joint) return '—';
  if (joint.system === 'tdc') return joint.ratedClass ? `TDC (rates ${joint.ratedClass})` : 'TDC';
  if (joint.system === 'ductmate') return `Ductmate ${joint.series.slice(2)} (rates ${joint.ratedClass})`;
  if (joint.system === 'round-slip') return joint.type === 'RT-1' ? 'RT-1 beaded sleeve' : 'RT-5 crimp';
  return `Angle flange L${joint.member.legMm}×${joint.member.thicknessMm}${joint.member.hotRolled ? ' HR' : ''}`;
}
