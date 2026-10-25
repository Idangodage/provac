/**
 * HVAC quantities in the units a designer reads them in: SI (m³/h, m/s, Pa/m,
 * Pa, mm, kW) or IP (CFM, fpm, in. wg per 100 ft, in. wg, in, kBtu/h). The
 * model stays SI; a figure is converted only where it is shown or typed.
 *
 * Factors are exact where the definitions are (1 ft = 0.3048 m, 1 in =
 * 25.4 mm, 1 lb = 0.45359237 kg); inches of water are taken at 60 °F
 * (248.84 Pa, ASHRAE's convention), a ton of refrigeration is 12 000 Btu/h,
 * and 1 W = 3.412142 Btu/h.
 */

export type HvacUnitSystem = 'si' | 'ip';

/** What a number is: each kind has its unit, precision and input step in either system. */
export type HvacQuantity = 'airflow' | 'velocity' | 'friction' | 'pressure' | 'size' | 'length' | 'capacity' | 'mass';

interface Display {
  unit: string;
  /** Decimals a figure is shown with. */
  digits: number;
  /** The step an input nudges by. */
  step: number;
}

interface QuantityDef {
  si: Display;
  ip: Display;
  /** IP value per SI value. */
  perSi: number;
}

const FT = 0.3048;
const IN_MM = 25.4;
/** 1 in. of water at 60 °F (Pa). */
const IN_WG_PA = 248.84;
const CFM_PER_M3H = 1 / ((FT ** 3) * 60);
const FPM_PER_MS = 60 / FT;
const IN_WG_100FT_PER_PA_M = (100 * FT) / IN_WG_PA;
const KBTUH_PER_KW = 3.412142;
const LB_PER_KG = 1 / 0.45359237;
/** kW per ton of refrigeration (12 000 Btu/h). */
const KW_PER_TON = 12 / KBTUH_PER_KW;

const QUANTITIES: Record<HvacQuantity, QuantityDef> = {
  airflow: { si: { unit: 'm³/h', digits: 0, step: 10 }, ip: { unit: 'CFM', digits: 0, step: 10 }, perSi: CFM_PER_M3H },
  velocity: { si: { unit: 'm/s', digits: 1, step: 0.1 }, ip: { unit: 'fpm', digits: 0, step: 20 }, perSi: FPM_PER_MS },
  friction: { si: { unit: 'Pa/m', digits: 2, step: 0.05 }, ip: { unit: 'in. wg/100 ft', digits: 3, step: 0.005 }, perSi: IN_WG_100FT_PER_PA_M },
  pressure: { si: { unit: 'Pa', digits: 0, step: 5 }, ip: { unit: 'in. wg', digits: 2, step: 0.02 }, perSi: 1 / IN_WG_PA },
  size: { si: { unit: 'mm', digits: 0, step: 50 }, ip: { unit: 'in', digits: 1, step: 2 }, perSi: 1 / IN_MM },
  length: { si: { unit: 'm', digits: 2, step: 0.1 }, ip: { unit: 'ft', digits: 1, step: 0.5 }, perSi: 1 / FT },
  capacity: { si: { unit: 'kW', digits: 1, step: 0.1 }, ip: { unit: 'kBtu/h', digits: 1, step: 0.5 }, perSi: KBTUH_PER_KW },
  mass: { si: { unit: 'kg', digits: 0, step: 1 }, ip: { unit: 'lb', digits: 0, step: 1 }, perSi: LB_PER_KG },
};

/** A figure in the display system (no rounding). */
export function toDisplay(kind: HvacQuantity, si: number, system: HvacUnitSystem): number {
  return system === 'ip' ? si * QUANTITIES[kind].perSi : si;
}

/** A displayed figure back in SI. */
export function fromDisplay(kind: HvacQuantity, shown: number, system: HvacUnitSystem): number {
  return system === 'ip' ? shown / QUANTITIES[kind].perSi : shown;
}

export function unitLabel(kind: HvacQuantity, system: HvacUnitSystem): string {
  return QUANTITIES[kind][system].unit;
}

export function displayDigits(kind: HvacQuantity, system: HvacUnitSystem): number {
  return QUANTITIES[kind][system].digits;
}

export function displayStep(kind: HvacQuantity, system: HvacUnitSystem): number {
  return QUANTITIES[kind][system].step;
}

/** "4320", "2543"; `digits` overrides the kind's precision. */
export function formatNumberIn(kind: HvacQuantity, si: number | null | undefined, system: HvacUnitSystem, digits?: number): string {
  if (si === null || si === undefined || !Number.isFinite(si)) return '–';
  return toDisplay(kind, si, system).toFixed(digits ?? displayDigits(kind, system));
}

/** "4320 m³/h", "2543 CFM". */
export function formatQuantity(kind: HvacQuantity, si: number | null | undefined, system: HvacUnitSystem, digits?: number): string {
  return `${formatNumberIn(kind, si, system, digits)} ${unitLabel(kind, system)}`;
}

/** Tons of refrigeration for a capacity in kW. */
export function tonsOf(kw: number): number {
  return kw / KW_PER_TON;
}

/** A length in inches as a duct size: whole inches when it is one (an inch-series size), else one decimal. */
export function inchesText(mm: number): string {
  const inches = mm / IN_MM;
  return Math.abs(inches - Math.round(inches)) < 0.05 ? String(Math.round(inches)) : inches.toFixed(1);
}

/** A duct section as the system reads it: "600×350" / "Ø300" in mm, "24×14" / "Ø12" in inches. */
export function formatSection(section: { widthMm: number; heightMm: number; diameterMm?: number }, system: HvacUnitSystem): string {
  if (section.diameterMm !== undefined) return system === 'ip' ? `Ø${inchesText(section.diameterMm)}` : `Ø${Math.round(section.diameterMm)}`;
  return system === 'ip'
    ? `${inchesText(section.widthMm)}×${inchesText(section.heightMm)}`
    : `${Math.round(section.widthMm)}×${Math.round(section.heightMm)}`;
}

// ---- Engine messages ----

/**
 * One pass over a message: a figure with its SI unit (or a duct size, written
 * without one), longest units first so "Pa/m" is not read as "Pa".
 */
const MESSAGE_FIGURE = /(\d+(?:\.\d+)?) ?(m³\/h|Pa\/m|m\/s|Pa|kW|mm|m)(?![\w/²³])|Ø(\d+(?:\.\d+)?)|\b(\d{2,4})×(\d{2,4})\b/g;

const IP_OF_UNIT: Record<string, (value: number) => string> = {
  'm³/h': (v) => `${Math.round(v * CFM_PER_M3H)} CFM`,
  'Pa/m': (v) => `${(v * IN_WG_100FT_PER_PA_M).toFixed(3)} in. wg/100 ft`,
  'm/s': (v) => `${Math.round(v * FPM_PER_MS)} fpm`,
  Pa: (v) => `${(v / IN_WG_PA).toFixed(2)} in. wg`,
  kW: (v) => `${(v * KBTUH_PER_KW).toFixed(1)} kBtu/h`,
  mm: (v) => `${inchesText(v)} in`,
  m: (v) => `${(v / FT).toFixed(1)} ft`,
};

/**
 * An engine message as the display system reads it. In SI it is as written.
 * In IP the sentence keeps its SI wording and every figure that carries a
 * unit (m³/h, Pa/m, m/s, Pa, kW, mm, m, "Ø300", "700×350") is followed by its
 * IP value in brackets: "500 m³/h (294 CFM)". Messages give some figures
 * without a unit ("supply 64 + return 48 = 112 Pa"), so rewriting them in
 * place would mix the systems; the dual form never changes what a sentence
 * says.
 */
export function toDisplayText(text: string, system: HvacUnitSystem): string {
  if (system === 'si' || !text) return text;
  return text.replace(MESSAGE_FIGURE, (match, value?: string, unit?: string, diameter?: string, width?: string, height?: string) => {
    if (value !== undefined && unit !== undefined) return `${match} (${IP_OF_UNIT[unit]!(Number(value))})`;
    if (diameter !== undefined) return `${match} (Ø${inchesText(Number(diameter))} in)`;
    return `${match} (${inchesText(Number(width))}×${inchesText(Number(height))} in)`;
  });
}
