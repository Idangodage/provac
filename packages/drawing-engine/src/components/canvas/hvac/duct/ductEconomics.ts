/**
 * Economics of a duct design, in the project's currency.
 *
 *  - First cost, priced from the fabrication plans themselves (so the figure is
 *    the real take-off, not a model): galvanised sheet by mass (the SMACNA
 *    gauge each section resolved), fabrication and installation by sheet area
 *    (fittings at a multiple of a straight's rate, spiral round cheaper per m²
 *    than rectangular), NBR by area, flexible duct per metre, dampers, joints
 *    per metre of perimeter and hangers each.
 *  - Life-cycle cost: first cost + the present worth of the fan energy the
 *    design's external static pressure costs. Fan power is Q·Δp/η, run for
 *    the operating hours each year; the present-worth factor over n years at
 *    discount r with the energy price rising by e a year is
 *    PW = Σ_{k=1..n} ((1+e)/(1+r))^k. So each pascal costs
 *    E_pa = Q·h·price·PW / (1000·η).
 *  - Proxies the optimiser prices a candidate section or fitting with before a
 *    design exists (cost per metre of a section, cost of a fitting by its
 *    sheet area). The optimiser's chosen designs are always re-priced from
 *    their plans.
 *
 * Every rate is a setting (practice placeholder until the supplier's prices
 * are entered).
 */
import type { DuctFabricationPlan, DuctPiece } from './ductFabricationPlanner';
import { galvanisedSheetMassKgPerM2 } from './ductCatalog';
import { resolveSectionConstruction } from './ductGauge';
import type { DuctDesignSettings } from './ductSettings';
import { isRoundLeg, type DuctConstruction, type DuctLeg, type DuctService } from './ductTypes';

export type DuctEconomicsSettings = Pick<DuctDesignSettings,
  | 'econCurrency' | 'econSheetPerKg' | 'econFabricationRectPerM2' | 'econFabricationSpiralPerM2' | 'econFittingFactor'
  | 'econInstallPerM2' | 'econInsulationPerM2' | 'econFlexPerM' | 'econDamperEach' | 'econHangerEach' | 'econJointPerM'
  | 'econElectricityPerKWh' | 'econHoursPerYear' | 'econFanEfficiency' | 'econLifeYears' | 'econDiscountPercent' | 'econEscalationPercent'>;

export interface DuctCostBreakdown {
  /** Galvanised sheet by mass. */
  sheet: number;
  /** Fabrication of straights. */
  fabrication: number;
  /** Fabrication of fittings (elbows, transitions, take-offs, splits, caps, plenums, connectors). */
  fittings: number;
  /** Installation by duct surface. */
  install: number;
  insulation: number;
  flex: number;
  dampers: number;
  joints: number;
  hangers: number;
  total: number;
}

export const EMPTY_COST: DuctCostBreakdown = {
  sheet: 0, fabrication: 0, fittings: 0, install: 0, insulation: 0, flex: 0, dampers: 0, joints: 0, hangers: 0, total: 0,
};

/** Reference size the flexible duct and damper rates are quoted at (mm). */
const REFERENCE_DIAMETER_MM = 200;
/** A flexible runout's strap on a hanger wire, as a share of a rod hanger (practice). */
export const STRAP_SHARE_OF_HANGER = 0.3;

/** Present-worth factor of a yearly amount over `years` at `discountPercent`, the amount rising by `escalationPercent`. */
export function presentWorthFactor(years: number, discountPercent: number, escalationPercent: number): number {
  const ratio = (1 + escalationPercent / 100) / (1 + discountPercent / 100);
  let sum = 0;
  let term = 1;
  for (let k = 1; k <= Math.max(0, Math.round(years)); k += 1) {
    term *= ratio;
    sum += term;
  }
  return sum;
}

/** Present worth of the fan energy one pascal of external static pressure costs at `airflowM3h` (currency per Pa). */
export function energyPricePerPa(airflowM3h: number, settings: DuctEconomicsSettings): number {
  const q = Math.max(0, airflowM3h) / 3600;
  const kWhPerYearPerPa = (q * settings.econHoursPerYear) / (1000 * settings.econFanEfficiency);
  return kWhPerYearPerPa * settings.econElectricityPerKWh
    * presentWorthFactor(settings.econLifeYears, settings.econDiscountPercent, settings.econEscalationPercent);
}

/** Life-cycle cost: first cost + the present worth of the energy the pressure costs. */
export function lifeCycleCost(firstCost: number, espPa: number, airflowM3h: number, settings: DuctEconomicsSettings): number {
  return firstCost + energyPricePerPa(airflowM3h, settings) * Math.max(0, espPa);
}

const FITTING_KINDS: ReadonlySet<DuctPiece['kind']> = new Set(['elbow', 'offset', 'transition', 'takeoff', 'split', 'end-cap', 'plenum', 'connector', 'damper']);

function pieceGirthMm(piece: DuctPiece): number {
  return piece.diameterMm !== undefined ? Math.PI * piece.diameterMm : 2 * (piece.widthMm + piece.heightMm);
}

/**
 * First cost of the planned runs. `hangers` = the rod hangers their support
 * plans place and `straps` = the runouts' straps (the caller has the scene to
 * plan them).
 */
export function priceDuctPlans(plans: readonly DuctFabricationPlan[], settings: DuctEconomicsSettings, hangers = 0, straps = 0): DuctCostBreakdown {
  const cost = { ...EMPTY_COST };
  for (const plan of plans) {
    for (const piece of plan.pieces) {
      if (piece.kind === 'flex') {
        cost.flex += (piece.lengthMm / 1000) * settings.econFlexPerM * ((piece.diameterMm ?? piece.widthMm) / REFERENCE_DIAMETER_MM);
        continue;
      }
      if (piece.kind === 'damper') cost.dampers += settings.econDamperEach * (pieceGirthMm(piece) / (Math.PI * REFERENCE_DIAMETER_MM));
      if (piece.sheetAreaM2 <= 0) continue;
      cost.sheet += piece.massKg * settings.econSheetPerKg;
      const round = piece.diameterMm !== undefined && (piece.endDiameterMm !== undefined || piece.kind !== 'transition');
      const rate = round ? settings.econFabricationSpiralPerM2 : settings.econFabricationRectPerM2;
      if (FITTING_KINDS.has(piece.kind)) cost.fittings += piece.sheetAreaM2 * rate * settings.econFittingFactor;
      else cost.fabrication += piece.sheetAreaM2 * rate;
      cost.install += piece.sheetAreaM2 * settings.econInstallPerM2;
    }
    if (plan.insulation) cost.insulation += plan.insulation.areaWithWasteM2 * settings.econInsulationPerM2;
    for (const joint of plan.joints) {
      if (joint.kind === 'flex-connection' || !joint.hardware) continue;
      const round = joint.hardware.system === 'round-slip' || joint.hardware.system === 'round-takeoff';
      const perimeterMm = round ? Math.PI * joint.outerWidthMm : 2 * (joint.outerWidthMm + joint.outerHeightMm);
      cost.joints += (perimeterMm / 1000) * settings.econJointPerM;
    }
  }
  cost.hangers = (hangers + STRAP_SHARE_OF_HANGER * straps) * settings.econHangerEach;
  cost.total = cost.sheet + cost.fabrication + cost.fittings + cost.install + cost.insulation + cost.flex + cost.dampers + cost.joints + cost.hangers;
  return cost;
}

export interface SectionCostContext {
  service: DuctService;
  construction: DuctConstruction;
  settings: DuctDesignSettings;
  /** Insulation thickness carried (0 = bare). */
  insulationMm: number;
}

const SECTION_COST_CACHE = new WeakMap<DuctDesignSettings, Map<string, number>>();

/** Outside girth of a section with its sheet (mm). */
function outerGirthMm(section: DuctLeg, sheetMm: number): number {
  return isRoundLeg(section) ? Math.PI * (section.diameterMm! + 2 * sheetMm) : 2 * (section.widthMm + section.heightMm + 4 * sheetMm);
}

/** The sheet a section resolves to (SMACNA gauge at the project's class), or null when it cannot be built. */
export function sectionSheetMm(section: DuctLeg, context: Omit<SectionCostContext, 'insulationMm'>): number | null {
  const construction = resolveSectionConstruction({
    widthMm: section.widthMm, heightMm: section.heightMm, service: context.service, construction: context.construction,
    settings: context.settings, pressureClassPa: null, jointSystem: null,
    ...(isRoundLeg(section) ? { diameterMm: section.diameterMm } : {}),
  });
  return construction.status === 'ok' ? construction.sheetThicknessMm : null;
}

/**
 * Installed cost of one metre of straight duct of `section`: sheet, fabrication
 * and installation by area, the joints of its section length, the hangers of
 * its spacing and its insulation. Infinity when the section cannot be built.
 */
export function sectionCostPerMetre(section: DuctLeg, context: SectionCostContext): number {
  const s = context.settings;
  const key = `${context.service}|${context.construction}|${context.insulationMm}|${isRoundLeg(section) ? `d${section.diameterMm}` : `${section.widthMm}x${section.heightMm}`}`;
  let cache = SECTION_COST_CACHE.get(s);
  if (!cache) SECTION_COST_CACHE.set(s, (cache = new Map()));
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const sheet = sectionSheetMm(section, context);
  let value = Number.POSITIVE_INFINITY;
  if (sheet !== null) {
    const round = isRoundLeg(section);
    const girth = outerGirthMm(section, sheet);
    const area = girth / 1000;
    const fabrication = round ? s.econFabricationSpiralPerM2 : s.econFabricationRectPerM2;
    const sectionLength = round && s.roundSeam === 'spiral' ? s.roundSectionLengthMm : s.sectionLengthMm;
    const joints = (1000 / sectionLength) * (girth / 1000) * s.econJointPerM;
    const hangers = (1000 / s.hangerSpacingMm) * s.econHangerEach;
    const insulation = context.insulationMm > 0 ? ((girth + 8 * context.insulationMm) / 1000) * s.econInsulationPerM2 : 0;
    value = area * (galvanisedSheetMassKgPerM2(sheet) * s.econSheetPerKg + fabrication + s.econInstallPerM2) + joints + hangers + insulation;
  }
  cache.set(key, value);
  return value;
}

/**
 * Cost of a fitting of `section` whose developed length along the duct is
 * `developedMm` (its sheet at the fitting rate, installed), e.g. an elbow's
 * arc plus necks, a transition's slope plus necks, a collar's length.
 */
export function fittingCost(section: DuctLeg, developedMm: number, context: SectionCostContext, joints = 1): number {
  const s = context.settings;
  const sheet = sectionSheetMm(section, context);
  if (sheet === null) return Number.POSITIVE_INFINITY;
  const girth = outerGirthMm(section, sheet);
  const area = (girth / 1000) * (developedMm / 1000);
  const fabrication = isRoundLeg(section) ? s.econFabricationSpiralPerM2 : s.econFabricationRectPerM2;
  const insulation = context.insulationMm > 0 ? area * s.econInsulationPerM2 : 0;
  // Each fitting brings a joint of its own (the planner flanges or sleeves every piece end).
  return area * (galvanisedSheetMassKgPerM2(sheet) * s.econSheetPerKg + fabrication * s.econFittingFactor + s.econInstallPerM2) + insulation
    + joints * (girth / 1000) * s.econJointPerM;
}

/** A damper's cost at a section. */
export function damperCost(section: DuctLeg, settings: DuctEconomicsSettings): number {
  const girth = isRoundLeg(section) ? Math.PI * section.diameterMm! : 2 * (section.widthMm + section.heightMm);
  return settings.econDamperEach * (girth / (Math.PI * REFERENCE_DIAMETER_MM));
}

/** A flexible runout's cost, its straps (S3.35: at ≤ 1.5 m, the connections counting) included. */
export function flexCost(diameterMm: number, lengthMm: number, settings: DuctEconomicsSettings): number {
  const straps = Math.max(0, Math.ceil(lengthMm / 1500) - 1);
  return (lengthMm / 1000) * settings.econFlexPerM * (diameterMm / REFERENCE_DIAMETER_MM) + straps * STRAP_SHARE_OF_HANGER * settings.econHangerEach;
}

/** "USD 1,234" */
export function formatCost(value: number, currency: string): string {
  return `${currency} ${Math.round(value).toLocaleString('en-US')}`;
}
