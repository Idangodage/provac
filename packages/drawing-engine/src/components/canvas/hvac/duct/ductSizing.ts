/**
 * Airflow sizing for the duct auto layout (the equal-friction method, ASHRAE
 * Handbook—Fundamentals ch. 21): a section's velocity and friction at an
 * airflow, and the smallest standard size that meets both the friction-rate
 * target and the velocity cap. Also the unit's airflow and fan pressure from
 * its data, and each terminal's share of it.
 *
 *  - Friction: Darcy–Weisbach with the Altshul–Tsal friction factor. A
 *    rectangular section is taken as its Huebscher equivalent round duct
 *    (same airflow, same friction per metre): De = 1.30·(ab)^0.625/(a+b)^0.25.
 *  - Air at 1.2 kg/m³ and 1.51·10⁻⁵ m²/s; galvanised steel ε = 0.09 mm, flexible
 *    duct ε ≈ 3 mm (practice: extended, not compressed).
 *
 * The design values themselves (friction rates, velocity caps, sizes) are
 * project settings labelled practice; see ductSettings.ts.
 */
import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement } from '../../../../types';

import type { DuctDesignSettings } from './ductSettings';
import { DUCT_TERMINAL_NECKS_MM, type DuctTerminalSpec } from './ductTerminalCatalog';
import { isRoundLeg, type DuctLeg } from './ductTypes';

export const AIR_DENSITY_KG_M3 = 1.2;
export const AIR_KINEMATIC_VISCOSITY_M2_S = 1.51e-5;
export const DUCT_ROUGHNESS_MM = { galvanised: 0.09, flex: 3 } as const;
export type DuctMaterial = keyof typeof DUCT_ROUGHNESS_MM;

const positiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Huebscher equivalent diameter of a section (mm); a round section is its own. */
export function equivalentDiameterMm(section: Pick<DuctLeg, 'widthMm' | 'heightMm' | 'diameterMm'>): number {
  if (isRoundLeg(section as DuctLeg)) return positiveFinite(section.diameterMm!) ? section.diameterMm! : Number.NaN;
  const a = section.widthMm;
  const b = section.heightMm;
  if (!positiveFinite(a) || !positiveFinite(b)) return Number.NaN;
  return (1.3 * (a * b) ** 0.625) / (a + b) ** 0.25;
}

/** Free area of a section (m²). */
export function sectionAreaM2(section: Pick<DuctLeg, 'widthMm' | 'heightMm' | 'diameterMm'>): number {
  if (isRoundLeg(section as DuctLeg)) return positiveFinite(section.diameterMm!) ? (Math.PI * (section.diameterMm! / 1000) ** 2) / 4 : Number.NaN;
  if (!positiveFinite(section.widthMm) || !positiveFinite(section.heightMm)) return Number.NaN;
  return (section.widthMm / 1000) * (section.heightMm / 1000);
}

/** Mean air velocity in the section (m/s). */
export function velocityMs(section: Pick<DuctLeg, 'widthMm' | 'heightMm' | 'diameterMm'>, airflowM3h: number): number {
  if (!Number.isFinite(airflowM3h) || airflowM3h < 0) return Number.NaN;
  return airflowM3h / 3600 / sectionAreaM2(section);
}

export function velocityPressurePa(velocity: number): number {
  return (AIR_DENSITY_KG_M3 * velocity * velocity) / 2;
}

/** Darcy factor: 64/Re for laminar flow, Altshul–Tsal for turbulent flow.
 * Between Re 2300 and 4000, interpolate the factors continuously; this is an
 * estimate for the unstable transition regime, not a fully turbulent result.
 * https://handbook.ashrae.org/Handbooks/F21/SI/F21_Ch21/F21_Ch21_si.aspx
 */
export function frictionFactor(diameterM: number, reynolds: number, roughnessM: number): number {
  if (!positiveFinite(diameterM) || !Number.isFinite(reynolds) || reynolds < 0 || !Number.isFinite(roughnessM) || roughnessM < 0) return Number.NaN;
  if (reynolds === 0) return 0;
  const laminar = 64 / reynolds;
  if (reynolds <= 2300) return laminar;
  const first = 0.11 * (roughnessM / diameterM + 68 / reynolds) ** 0.25;
  const turbulent = first >= 0.018 ? first : 0.85 * first + 0.0028;
  if (reynolds >= 4000) return turbulent;
  return laminar + ((reynolds - 2300) / 1700) * (turbulent - laminar);
}

/** Friction loss per metre of the section at the airflow (Pa/m). */
export function frictionPaPerM(
  section: Pick<DuctLeg, 'widthMm' | 'heightMm' | 'diameterMm'>,
  airflowM3h: number,
  material: DuctMaterial = 'galvanised',
): number {
  if (!Number.isFinite(airflowM3h) || airflowM3h < 0) return Number.NaN;
  if (airflowM3h === 0) return 0;
  const diameter = equivalentDiameterMm(section) / 1000;
  const velocity = airflowM3h / 3600 / ((Math.PI * diameter * diameter) / 4);
  const reynolds = (velocity * diameter) / AIR_KINEMATIC_VISCOSITY_M2_S;
  const f = frictionFactor(diameter, reynolds, DUCT_ROUGHNESS_MM[material] / 1000);
  return (f / diameter) * velocityPressurePa(velocity);
}

export interface DuctSizingLimits {
  frictionPaPerM: number;
  maxVelocityMs: number;
}

/** Whether a section carries the airflow within both limits (a hair of tolerance on the rounding). */
export function withinLimits(section: DuctLeg, airflowM3h: number, limits: DuctSizingLimits, material: DuctMaterial = 'galvanised'): boolean {
  if (!Number.isFinite(limits.frictionPaPerM) || limits.frictionPaPerM < 0
    || !Number.isFinite(limits.maxVelocityMs) || limits.maxVelocityMs < 0) return false;
  return frictionPaPerM(section, airflowM3h, material) <= limits.frictionPaPerM * 1.001
    && velocityMs(section, airflowM3h) <= limits.maxVelocityMs * 1.001;
}

/** The smallest standard round size of at least `minimumMm` within the limits; the largest if none is. */
export function sizeRound(
  airflowM3h: number,
  limits: DuctSizingLimits,
  sizesMm: readonly number[],
  options: { minimumMm?: number; material?: DuctMaterial } = {},
): number {
  const stocked = [...new Set(sizesMm.filter(positiveFinite))].sort((a, b) => a - b);
  const sizes = stocked.filter((size) => size >= (options.minimumMm ?? 0));
  for (const size of sizes) {
    if (withinLimits({ widthMm: size, heightMm: size, diameterMm: size }, airflowM3h, limits, options.material)) return size;
  }
  return sizes[sizes.length - 1] ?? stocked[stocked.length - 1] ?? 200;
}

export interface RectangularSize {
  widthMm: number;
  heightMm: number;
  /** No size up to the height limit and the aspect limit meets the targets; this is the largest tried. */
  capped: boolean;
}

/**
 * The narrowest rectangular section at `heightMm` within the limits, widths in
 * `stepMm` steps. Past the aspect limit the height rises a step at a time, up
 * to `maxHeightMm` (the ceiling void).
 */
export function sizeRectangular(
  airflowM3h: number,
  heightMm: number,
  limits: DuctSizingLimits,
  options: { stepMm?: number; minWidthMm?: number; maxAspect?: number; maxHeightMm?: number } = {},
): RectangularSize {
  const step = options.stepMm ?? 50;
  const maxAspect = options.maxAspect ?? 4;
  const maxHeight = Math.max(heightMm, options.maxHeightMm ?? heightMm);
  const minWidth = Math.max(step, options.minWidthMm ?? step);
  if (!positiveFinite(step) || !positiveFinite(heightMm) || !positiveFinite(maxHeight)
    || !positiveFinite(minWidth) || !Number.isFinite(maxAspect) || maxAspect < 1
    || !Number.isFinite(maxHeight * maxAspect) || maxHeight + step === maxHeight || minWidth + step === minWidth) {
    throw new RangeError('Duct sizing requires finite positive dimensions and a width step, and an aspect limit of at least 1.');
  }
  let best: RectangularSize = { widthMm: minWidth, heightMm, capped: true };
  for (let height = heightMm; height <= maxHeight + 1e-6; height += step) {
    const widest = Math.max(minWidth, Math.floor((height * maxAspect) / step) * step);
    const narrowest = Math.ceil(Math.max(minWidth, height / maxAspect) / step) * step;
    for (let width = narrowest; width <= widest; width += step) {
      if (Math.max(width / height, height / width) <= maxAspect
        && withinLimits({ widthMm: width, heightMm: height }, airflowM3h, limits)) return { widthMm: width, heightMm: height, capped: false };
    }
    best = { widthMm: widest, heightMm: height, capped: true };
  }
  return best;
}

// ---- The unit's air data ----

export type FanSpeed = 'p-hi' | 'hi' | 'me' | 'lo';
export const FAN_SPEEDS: readonly FanSpeed[] = ['p-hi', 'hi', 'me', 'lo'];
export const FAN_SPEED_LABELS: Record<FanSpeed, string> = { 'p-hi': 'P-Hi', hi: 'Hi', me: 'Me', lo: 'Lo' };

export interface UnitAirData {
  /** Airflow at each fan speed (m³/h), or null when the unit has no data. */
  airflowM3h: Record<FanSpeed, number> | null;
  /** Highest external static pressure the fan can be set to (Pa). */
  maxEspPa: number | null;
  /** Where the numbers come from. */
  source: string | null;
}

function readAirflowM3min(raw: unknown): Record<FanSpeed, number> | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const out = {} as Record<FanSpeed, number>;
  for (const speed of FAN_SPEEDS) {
    const m3min = value[speed];
    if (typeof m3min !== 'number' || !Number.isFinite(m3min) || m3min <= 0) return null;
    out[speed] = m3min * 60;
  }
  return out;
}

/** The unit's airflow per fan speed and its fan pressure: its own properties, else its catalog entry by model code. */
export function readUnitAirData(element: Pick<HvacElement, 'properties'>): UnitAirData {
  const own = readAirflowM3min(element.properties.airflowM3min);
  const code = typeof element.properties.modelCode === 'string' ? element.properties.modelCode : null;
  const catalog = code
    ? DEFAULT_AC_EQUIPMENT_LIBRARY.find((definition) => definition.defaultProperties?.modelCode === code)?.defaultProperties
    : undefined;
  const airflow = own ?? readAirflowM3min(catalog?.airflowM3min);
  const espRaw = element.properties.maxEspPa ?? catalog?.maxEspPa;
  const source = (typeof element.properties.airDataSource === 'string' ? element.properties.airDataSource : null)
    ?? (typeof catalog?.airDataSource === 'string' ? catalog.airDataSource : null);
  return {
    airflowM3h: airflow,
    maxEspPa: typeof espRaw === 'number' && Number.isFinite(espRaw) && espRaw > 0 ? espRaw : null,
    source: airflow ? source : null,
  };
}

// ---- Terminals ----

export interface TerminalAirflow {
  terminalId: string;
  airflowM3h: number;
  /** Set on the terminal (true) or an equal share of the unit's airflow (false). */
  fixed: boolean;
}

/** Each terminal's airflow: its own design value, else an equal share of what the others leave. */
export function shareAirflow(
  unitAirflowM3h: number,
  terminals: ReadonlyArray<{ id: string; spec: Pick<DuctTerminalSpec, 'designAirflowM3h'> }>,
): TerminalAirflow[] {
  const fixed = terminals.filter((terminal) => (terminal.spec.designAirflowM3h ?? 0) > 0);
  const fixedTotal = fixed.reduce((total, terminal) => total + terminal.spec.designAirflowM3h!, 0);
  const shared = terminals.length - fixed.length;
  const share = shared > 0 ? Math.max(0, unitAirflowM3h - fixedTotal) / shared : 0;
  return terminals.map((terminal) => {
    const own = terminal.spec.designAirflowM3h ?? 0;
    return own > 0
      ? { terminalId: terminal.id, airflowM3h: own, fixed: true }
      : { terminalId: terminal.id, airflowM3h: share, fixed: false };
  });
}

/** Air velocity in a terminal's neck (m/s). */
export function neckVelocityMs(spec: Pick<DuctTerminalSpec, 'neckDiameterMm'>, airflowM3h: number): number {
  return velocityMs({ widthMm: spec.neckDiameterMm, heightMm: spec.neckDiameterMm, diameterMm: spec.neckDiameterMm }, airflowM3h);
}

/** The smallest catalog neck that keeps the velocity within the cap, or null when even the largest does not. */
export function neckForAirflow(airflowM3h: number, maxVelocityMs: number): number | null {
  for (const neck of DUCT_TERMINAL_NECKS_MM) {
    if (neckVelocityMs({ neckDiameterMm: neck }, airflowM3h) <= maxVelocityMs * 1.001) return neck;
  }
  return null;
}

/** The sizing limits by part of the system and service, from the settings. */
export function sizingLimits(
  settings: Pick<DuctDesignSettings, 'autoFrictionSupplyPaPerM' | 'autoFrictionReturnPaPerM' | 'autoMaxVelocityTrunkMs' | 'autoMaxVelocityBranchMs' | 'autoMaxVelocityRunoutMs'>,
  service: 'supply' | 'return',
  part: 'trunk' | 'branch' | 'runout',
): DuctSizingLimits {
  return {
    frictionPaPerM: service === 'return' ? settings.autoFrictionReturnPaPerM : settings.autoFrictionSupplyPaPerM,
    maxVelocityMs: part === 'trunk' ? settings.autoMaxVelocityTrunkMs : part === 'branch' ? settings.autoMaxVelocityBranchMs : settings.autoMaxVelocityRunoutMs,
  };
}
