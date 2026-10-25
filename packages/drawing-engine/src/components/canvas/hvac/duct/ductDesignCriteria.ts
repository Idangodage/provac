/**
 * Design criteria for constant-friction duct sizing, from ASHRAE Handbook —
 * HVAC Applications (2023), chapter 49 "Noise and Vibration Control":
 *
 *  - Table 1: the room's background-sound target, RC(N) / NC;
 *  - Table 8: the main duct's maximum velocity for that target and where the
 *    main runs (in a shaft or above a drywall ceiling, above a suspended
 *    acoustic ceiling, or in the occupied space); branch ducts at about 80 %
 *    of it, final runouts to outlets at 50 % or less (the table's notes);
 *  - Table 9: the maximum velocity at the neck of a supply diffuser or a
 *    return grille, for use when the terminal's own sound data is not known.
 *
 * Table 8 lists RC 25, 35 and 45: targets between them are interpolated, and
 * the rectangular column is used (round ducts may run faster: conservative).
 * Velocities are capped at the low-pressure ranges this tool sizes for (main
 * 12, branch 10, runout 8 m/s). The friction rates are practice: 0.8 Pa/m for
 * supply (about 0.1 in. wg per 100 ft, the commonly used design rate), 0.6 Pa/m
 * for return.
 */
import type { DuctDesignSettings } from './ductSettings';

export type DuctMainLocation = 'shaft' | 'suspended' | 'occupied';

export type DesignRoomId =
  | 'private-office' | 'conference' | 'teleconference' | 'open-office' | 'corridor' | 'collaborative'
  | 'classroom' | 'lecture' | 'library' | 'hotel-room' | 'residence' | 'patient-room' | 'ward' | 'laboratory' | 'gymnasium';

export interface DesignRoomType {
  id: DesignRoomId;
  label: string;
  /** Background-sound target, RC(N) / NC (ASHRAE 2023 HVAC Applications ch. 49, Table 1). */
  rc: number;
}

/** The rooms offered, with their Table 1 targets. */
export const DESIGN_ROOM_TYPES: readonly DesignRoomType[] = [
  { id: 'private-office', label: 'Private office', rc: 30 },
  { id: 'conference', label: 'Conference room', rc: 30 },
  { id: 'teleconference', label: 'Teleconference room', rc: 25 },
  { id: 'open-office', label: 'Open-plan office', rc: 40 },
  { id: 'corridor', label: 'Corridor, lobby', rc: 40 },
  { id: 'collaborative', label: 'Collaborative area', rc: 35 },
  { id: 'classroom', label: 'Classroom', rc: 30 },
  { id: 'lecture', label: 'Lecture hall, no amplification', rc: 25 },
  { id: 'library', label: 'Library', rc: 30 },
  { id: 'hotel-room', label: 'Hotel room', rc: 30 },
  { id: 'residence', label: 'Living area', rc: 30 },
  { id: 'patient-room', label: 'Patient room', rc: 30 },
  { id: 'ward', label: 'Ward, operating room', rc: 35 },
  { id: 'laboratory', label: 'Laboratory', rc: 45 },
  { id: 'gymnasium', label: 'Gymnasium', rc: 45 },
];

export const DUCT_MAIN_LOCATIONS: readonly DuctMainLocation[] = ['shaft', 'suspended', 'occupied'];

export const DUCT_MAIN_LOCATION_LABELS: Record<DuctMainLocation, string> = {
  shaft: 'In a shaft or above a drywall ceiling',
  suspended: 'Above a suspended acoustic ceiling',
  occupied: 'In the occupied space',
};

export interface DesignCriteria {
  room: DesignRoomId;
  location: DuctMainLocation;
}

/** What a new document starts from: an open-plan office (RC 40), its ducts above a suspended ceiling. */
export const RECOMMENDED_DESIGN_CRITERIA: DesignCriteria = { room: 'open-office', location: 'suspended' };

const FPM = 0.00508;

/** Table 8, rectangular duct, fpm, at RC 25 / 35 / 45. */
const MAIN_RECT_FPM: Record<DuctMainLocation, readonly [number, number, number]> = {
  shaft: [1700, 2500, 3500],
  suspended: [1200, 1750, 2500],
  occupied: [950, 1450, 2000],
};
const MAIN_RC = [25, 35, 45] as const;

/** Table 9, "free" opening velocity at the neck, fpm, at RC 25 / 30 / 35 / 40 / 45. */
const NECK_SUPPLY_FPM = [350, 425, 500, 560, 625] as const;
const NECK_RETURN_FPM = [425, 500, 600, 675, 750] as const;
const NECK_RC = [25, 30, 35, 40, 45] as const;

/** Table 8 notes: branches at about 80 % of the main, final runouts at 50 % or less. */
const BRANCH_SHARE = 0.8;
const RUNOUT_SHARE = 0.5;

/** The ranges the sizing settings accept (low-pressure systems). */
const CAP_MS = { main: 12, branch: 10, runout: 8, neck: 8 } as const;

export const PRACTICE_FRICTION_PA_PER_M = { supply: 0.8, return: 0.6 } as const;

export const DESIGN_CRITERIA_SOURCE = 'ASHRAE Handbook — HVAC Applications (2023), ch. 49, Tables 1, 8 and 9';

/** Linear between the table's rows; the end rows outside them. */
function interpolate(rcs: readonly number[], values: readonly number[], rc: number): number {
  if (rc <= rcs[0]!) return values[0]!;
  if (rc >= rcs[rcs.length - 1]!) return values[values.length - 1]!;
  for (let k = 1; k < rcs.length; k += 1) {
    if (rc <= rcs[k]!) {
      const t = (rc - rcs[k - 1]!) / (rcs[k]! - rcs[k - 1]!);
      return values[k - 1]! + t * (values[k]! - values[k - 1]!);
    }
  }
  return values[values.length - 1]!;
}

const tenth = (value: number) => Math.round(value * 10) / 10;

export function designRoomType(id: DesignRoomId): DesignRoomType {
  return DESIGN_ROOM_TYPES.find((room) => room.id === id) ?? DESIGN_ROOM_TYPES[0]!;
}

export interface DesignCriteriaLimits {
  rc: number;
  /** Maximum velocity (m/s), rounded to 0.1, capped at the low-pressure ranges. */
  mainMs: number;
  branchMs: number;
  runoutMs: number;
  neckSupplyMs: number;
  neckReturnMs: number;
  frictionSupplyPaPerM: number;
  frictionReturnPaPerM: number;
  /** Table 8 has no row at this RC: the main's limit lies between two rows. */
  interpolated: boolean;
  /** A limit was lowered to the tool's low-pressure range. */
  capped: boolean;
}

/** The limits a room and duct location give. */
export function designCriteriaLimits(criteria: DesignCriteria): DesignCriteriaLimits {
  const { rc } = designRoomType(criteria.room);
  const main = interpolate(MAIN_RC, MAIN_RECT_FPM[criteria.location], rc) * FPM;
  const raw = {
    main, branch: main * BRANCH_SHARE, runout: main * RUNOUT_SHARE,
    neckSupply: interpolate(NECK_RC, NECK_SUPPLY_FPM, rc) * FPM,
    neckReturn: interpolate(NECK_RC, NECK_RETURN_FPM, rc) * FPM,
  };
  const capped = raw.main > CAP_MS.main || raw.branch > CAP_MS.branch || raw.runout > CAP_MS.runout;
  return {
    rc,
    mainMs: tenth(Math.min(raw.main, CAP_MS.main)),
    branchMs: tenth(Math.min(raw.branch, CAP_MS.branch)),
    runoutMs: tenth(Math.min(raw.runout, CAP_MS.runout)),
    neckSupplyMs: tenth(Math.min(raw.neckSupply, CAP_MS.neck)),
    neckReturnMs: tenth(Math.min(raw.neckReturn, CAP_MS.neck)),
    frictionSupplyPaPerM: PRACTICE_FRICTION_PA_PER_M.supply,
    frictionReturnPaPerM: PRACTICE_FRICTION_PA_PER_M.return,
    interpolated: !(MAIN_RC as readonly number[]).includes(rc),
    capped,
  };
}

export type DesignCriteriaSettings = Pick<DuctDesignSettings,
  | 'designCriteria' | 'autoFrictionSupplyPaPerM' | 'autoFrictionReturnPaPerM'
  | 'autoMaxVelocityTrunkMs' | 'autoMaxVelocityBranchMs' | 'autoMaxVelocityRunoutMs'
  | 'autoMaxNeckVelocitySupplyMs' | 'autoMaxNeckVelocityReturnMs'>;

/** The duct settings a set of criteria writes (the rest of the settings are its own). */
export function designCriteriaSettings(criteria: DesignCriteria): DesignCriteriaSettings {
  const limits = designCriteriaLimits(criteria);
  return {
    designCriteria: { ...criteria },
    autoFrictionSupplyPaPerM: limits.frictionSupplyPaPerM,
    autoFrictionReturnPaPerM: limits.frictionReturnPaPerM,
    autoMaxVelocityTrunkMs: limits.mainMs,
    autoMaxVelocityBranchMs: limits.branchMs,
    autoMaxVelocityRunoutMs: limits.runoutMs,
    autoMaxNeckVelocitySupplyMs: limits.neckSupplyMs,
    autoMaxNeckVelocityReturnMs: limits.neckReturnMs,
  };
}

/** Criteria read back from a saved document: both fields known, else none (the settings are the designer's own). */
export function readDesignCriteria(value: unknown): DesignCriteria | null {
  if (!value || typeof value !== 'object') return null;
  const { room, location } = value as { room?: unknown; location?: unknown };
  const knownRoom = DESIGN_ROOM_TYPES.some((entry) => entry.id === room);
  const knownLocation = (DUCT_MAIN_LOCATIONS as readonly unknown[]).includes(location);
  return knownRoom && knownLocation ? { room: room as DesignRoomId, location: location as DuctMainLocation } : null;
}

/** The settings still match their criteria (a limit changed by hand makes them the designer's own). */
export function criteriaStillApply(settings: DesignCriteriaSettings): boolean {
  if (!settings.designCriteria) return false;
  const expected = designCriteriaSettings(settings.designCriteria);
  return (Object.keys(expected) as Array<keyof DesignCriteriaSettings>).every((key) => key === 'designCriteria'
    || Math.abs((settings[key] as number) - (expected[key] as number)) < 1e-9);
}
