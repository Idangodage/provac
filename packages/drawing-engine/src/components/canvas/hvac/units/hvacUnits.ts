/**
 * HVAC quantities in the units a designer reads them in: SI (m³/h, m/s, Pa/m,
 * Pa, mm, kW, a fall in %, L/h, kg/m, m², kg; prices per kg, m² and m) or IP
 * (CFM, fpm, in. wg per 100 ft, in. wg, in, kBtu/h, in/ft, gph, lb/ft, ft²,
 * lb; prices per lb, ft² and ft). The model stays SI; a figure is converted
 * only where it is shown or typed.
 *
 * Factors are exact where the definitions are (1 ft = 0.3048 m, 1 in =
 * 25.4 mm, 1 lb = 0.45359237 kg, 1 US gal = 3.785411784 L, a 1 % fall is
 * 0.12 in/ft); inches of water are taken at 60 °F (248.84 Pa, ASHRAE's
 * convention), a ton of refrigeration is 12 000 Btu/h, and 1 W = 3.412142 Btu/h.
 */

export type HvacUnitSystem = 'si' | 'ip';

/** What a number is: each kind has its unit, precision and input step in either system. */
export type HvacQuantity = 'airflow' | 'velocity' | 'friction' | 'pressure' | 'size' | 'length' | 'capacity' | 'mass' | 'slope' | 'flow' | 'charge'
  | 'area' | 'volume' | 'perMass' | 'perArea' | 'perLength' | 'coverage';

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
/** A fall of 1 % in inches per foot (12 in × 1/100). */
const IN_PER_FT_PER_PERCENT = 0.12;
const GAL_PER_L = 1 / 3.785411784;

const QUANTITIES: Record<HvacQuantity, QuantityDef> = {
  airflow: { si: { unit: 'm³/h', digits: 0, step: 10 }, ip: { unit: 'CFM', digits: 0, step: 10 }, perSi: CFM_PER_M3H },
  velocity: { si: { unit: 'm/s', digits: 1, step: 0.1 }, ip: { unit: 'fpm', digits: 0, step: 20 }, perSi: FPM_PER_MS },
  friction: { si: { unit: 'Pa/m', digits: 2, step: 0.05 }, ip: { unit: 'in. wg/100 ft', digits: 3, step: 0.005 }, perSi: IN_WG_100FT_PER_PA_M },
  pressure: { si: { unit: 'Pa', digits: 0, step: 5 }, ip: { unit: 'in. wg', digits: 2, step: 0.02 }, perSi: 1 / IN_WG_PA },
  size: { si: { unit: 'mm', digits: 0, step: 50 }, ip: { unit: 'in', digits: 1, step: 2 }, perSi: 1 / IN_MM },
  length: { si: { unit: 'm', digits: 2, step: 0.1 }, ip: { unit: 'ft', digits: 1, step: 0.5 }, perSi: 1 / FT },
  capacity: { si: { unit: 'kW', digits: 1, step: 0.1 }, ip: { unit: 'kBtu/h', digits: 1, step: 0.5 }, perSi: KBTUH_PER_KW },
  mass: { si: { unit: 'kg', digits: 0, step: 1 }, ip: { unit: 'lb', digits: 0, step: 1 }, perSi: LB_PER_KG },
  // A drain's or a gas line's fall; a drain's design flow; refrigerant per length of tube.
  slope: { si: { unit: '%', digits: 2, step: 0.1 }, ip: { unit: 'in/ft', digits: 3, step: 0.01 }, perSi: IN_PER_FT_PER_PERCENT },
  flow: { si: { unit: 'L/h', digits: 1, step: 0.5 }, ip: { unit: 'gph', digits: 2, step: 0.1 }, perSi: GAL_PER_L },
  charge: { si: { unit: 'kg/m', digits: 3, step: 0.01 }, ip: { unit: 'lb/ft', digits: 3, step: 0.01 }, perSi: LB_PER_KG * FT },
  // Sheet and insulation areas; a price per kg, per m² and per m of what it buys (in IP per lb, ft² and ft); how far
  // a litre of adhesive goes.
  area: { si: { unit: 'm²', digits: 2, step: 0.1 }, ip: { unit: 'ft²', digits: 1, step: 1 }, perSi: 1 / (FT * FT) },
  volume: { si: { unit: 'L', digits: 2, step: 0.5 }, ip: { unit: 'gal', digits: 2, step: 0.1 }, perSi: GAL_PER_L },
  perMass: { si: { unit: '/ kg', digits: 2, step: 0.1 }, ip: { unit: '/ lb', digits: 2, step: 0.05 }, perSi: 1 / LB_PER_KG },
  perArea: { si: { unit: '/ m²', digits: 2, step: 0.5 }, ip: { unit: '/ ft²', digits: 2, step: 0.05 }, perSi: FT * FT },
  perLength: { si: { unit: '/ m', digits: 2, step: 0.5 }, ip: { unit: '/ ft', digits: 2, step: 0.1 }, perSi: FT },
  coverage: { si: { unit: 'm²/L', digits: 1, step: 0.5 }, ip: { unit: 'ft²/gal', digits: 0, step: 10 }, perSi: 1 / (FT * FT) / GAL_PER_L },
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

/**
 * A stored SI figure as a field shows it, to `digits`: in IP converted
 * (`scale` takes the stored unit to the quantity's SI one: L/s to m³/h is
 * 3.6), in SI as stored. Empty for none.
 */
export function storedFieldText(value: number | null, quantity: HvacQuantity, system: HvacUnitSystem, digits: number, scale = 1): string {
  if (value === null) return '';
  return String(Number((system === 'ip' ? toDisplay(quantity, value * scale, 'ip') : value).toFixed(digits)));
}

/** What a field's typed text stores (SI, in the stored unit): null when empty, undefined when it is not a number. */
export function storedFieldValue(text: string, quantity: HvacQuantity, system: HvacUnitSystem, scale = 1): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return system === 'ip' ? fromDisplay(quantity, parsed, 'ip') / scale : parsed;
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
/**
 * The duct sizes in a label in the display system, each followed by its unit:
 * "Ø450 spiral" / "Ø17.7 in spiral", "600×300 → Ø450" / "23.6×11.8 in → Ø17.7 in".
 * Only sizes change (a label's other figures are left as they are); SI is unchanged.
 */
export function sizesText(text: string, system: HvacUnitSystem): string {
  if (system === 'si' || !text) return text;
  // (A box's W×H×L is not a duct size: left as written.)
  return text.replace(/Ø(\d+(?:\.\d+)?)(?! ?mm)|(?<![×\d.])\b(\d{2,4}(?:\.\d+)?)×(\d{2,4}(?:\.\d+)?)\b(?!×)/g, (match, diameter?: string, width?: string, height?: string) => (diameter !== undefined
    ? `Ø${inchesText(Number(diameter))} in`
    : `${inchesText(Number(width))}×${inchesText(Number(height))} in`));
}

/** A SMACNA pressure class: "500 Pa" / "2 in. wg" (in IP the classes are whole or half inches of water). */
export function pressureClassText(pa: number, system: HvacUnitSystem): string {
  return system === 'ip' ? `${Math.round((pa / IN_WG_PA) * 2) / 2} in. wg` : `${Math.round(pa)} Pa`;
}

/** `parts` of `denominator` (a power of two), reduced, with its whole: 9 of 8 → "1-1/8". */
function fractionText(parts: number, denominator: number): string {
  const whole = Math.floor(parts / denominator);
  let rest = parts % denominator;
  let below = denominator;
  while (rest > 0 && rest % 2 === 0) { rest /= 2; below /= 2; }
  if (!rest) return String(whole);
  return whole ? `${whole}-${rest}/${below}` : `${rest}/${below}`;
}

/** A tube's size in inches to the nearest eighth, as copper tube is named: 6.35 → "1/4", 28.58 → "1-1/8". */
export function inchFractionText(mm: number): string {
  return fractionText(Math.round(mm / (IN_MM / 8)), 8);
}

/**
 * A fall in inches per foot, as falls are specified: a named sixteenth where
 * it is within 5 % of one (1 % reads "1/8", 2 % "1/4": the codes' own
 * equivalents), else to the thousandth ("0.024" for 0.2 %).
 */
export function slopeFigureText(percent: number): string {
  const sixteenths = Math.abs(percent) * IN_PER_FT_PER_PERCENT * 16;
  const named = Math.round(sixteenths);
  return named > 0 && Math.abs(sixteenths - named) <= 0.05 * named ? fractionText(named, 16) : (sixteenths / 16).toFixed(3);
}

/** A fall in inches per foot with its unit: "1/8 in/ft". */
export function slopeText(percent: number): string {
  return `${slopeFigureText(percent)} in/ft`;
}

export function formatSection(section: { widthMm: number; heightMm: number; diameterMm?: number }, system: HvacUnitSystem): string {
  if (section.diameterMm !== undefined) return system === 'ip' ? `Ø${inchesText(section.diameterMm)}` : `Ø${Math.round(section.diameterMm)}`;
  return system === 'ip'
    ? `${inchesText(section.widthMm)}×${inchesText(section.heightMm)}`
    : `${Math.round(section.widthMm)}×${Math.round(section.heightMm)}`;
}

// ---- Engine messages ----

/**
 * One pass over a message: a figure with its SI unit (or a duct size, written
 * without one, or a percentage), longest units first so "Pa/m" is not read as
 * "Pa".
 */
const MESSAGE_FIGURE = /(\d+(?:\.\d+)?) ?(m³\/h|Pa\/m|m\/s|L\/h|kg\/m|kg|m²|Pa|kW|mm|m)(?![\w/²³])|Ø(\d+(?:\.\d+)?)|\b(\d{2,4})×(\d{2,4})\b|(\d+(?:\.\d+)?) ?%/g;

/** A sentence about a fall: its percentages are falls. */
const FALL_WORDS = /\b(?:slopes?|falls?|gradient)\b/i;

/** A length in a message: feet from a metre up; else inches, a size written to the hundredth by the eighth it is named for ("15.88 mm" is 5/8 in). */
function messageLengthText(mm: number, written: string): string {
  if (mm >= 1000) return `${(mm / (FT * 1000)).toFixed(1)} ft`;
  const eighths = mm / (IN_MM / 8);
  if (written.includes('.') && Math.round(eighths) >= 1 && Math.abs(eighths - Math.round(eighths)) < 0.02) return `${inchFractionText(mm)} in`;
  return `${mm < IN_MM ? (mm / IN_MM).toFixed(2) : inchesText(mm)} in`;
}

const IP_OF_UNIT: Record<string, (value: number, written: string) => string> = {
  'm³/h': (v) => `${Math.round(v * CFM_PER_M3H)} CFM`,
  'Pa/m': (v) => `${(v * IN_WG_100FT_PER_PA_M).toFixed(3)} in. wg/100 ft`,
  'm/s': (v) => `${Math.round(v * FPM_PER_MS)} fpm`,
  'L/h': (v) => `${(v * GAL_PER_L).toFixed(2)} gph`,
  'kg/m': (v) => `${(v * LB_PER_KG * FT).toFixed(3)} lb/ft`,
  kg: (v) => `${(v * LB_PER_KG).toFixed(v * LB_PER_KG < 10 ? 1 : 0)} lb`,
  'm²': (v) => `${(v / (FT * FT)).toFixed(v / (FT * FT) < 10 ? 1 : 0)} ft²`,
  Pa: (v) => `${(v / IN_WG_PA).toFixed(2)} in. wg`,
  kW: (v) => `${(v * KBTUH_PER_KW).toFixed(1)} kBtu/h`,
  mm: messageLengthText,
  m: (v) => `${(v / FT).toFixed(1)} ft`,
};

/**
 * An engine message as the display system reads it. In SI it is as written.
 * In IP the sentence keeps its SI wording and every figure that carries a
 * unit (m³/h, Pa/m, m/s, L/h, kg/m, kg, m², Pa, kW, mm, m, "Ø300", "700×350",
 * a fall in %) is followed by its IP value in brackets: "500 m³/h (294 CFM)",
 * "35 kg (77 lb)". Messages give
 * some figures without a unit ("supply 64 + return 48 = 112 Pa"), so rewriting
 * them in place would mix the systems; the dual form never changes what a
 * sentence says. A percentage is a fall only in a sentence about one (a share
 * of the air, a connection ratio are left as they are).
 */
export function toDisplayText(text: string, system: HvacUnitSystem): string {
  if (system === 'si' || !text) return text;
  return text.replace(MESSAGE_FIGURE, (match: string, value: string | undefined, unit: string | undefined, diameter: string | undefined,
    width: string | undefined, height: string | undefined, percent: string | undefined, offset: number, whole: string) => {
    if (value !== undefined && unit !== undefined) return `${match} (${IP_OF_UNIT[unit]!(Number(value), value)})`;
    if (diameter !== undefined) return `${match} (Ø${inchesText(Number(diameter))} in)`;
    if (percent !== undefined) {
      const sentence = whole.slice(0, offset).split(/[.;!?]\s/).pop() ?? '';
      return FALL_WORDS.test(sentence) ? `${match} (${slopeText(Number(percent))})` : match;
    }
    return `${match} (${inchesText(Number(width))}×${inchesText(Number(height))} in)`;
  });
}
