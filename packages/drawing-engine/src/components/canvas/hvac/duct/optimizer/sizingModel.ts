/**
 * The priced physics the optimiser works with: what a metre of a section, a
 * fitting or a runout costs (ductEconomics.ts, SMACNA gauges) and what
 * pressure it loses at a flow (Darcy–Weisbach friction and the fitting losses
 * of ductPressure.ts). The same functions the verification uses, so the model
 * and the planned result agree to within the geometry the realiser settles.
 */
import type { ServiceCtx } from '../ductAutoContext';
import { damperCost, energyPricePerPa, fittingCost, flexCost, sectionCostPerMetre, type SectionCostContext } from '../ductEconomics';
import {
  elbowCoefficient,
  FITTING_LOSS_COEFFICIENTS,
  mainPassageLossPa,
  splitOutletLossPa,
  takeoffBranchLossPa,
  transitionCoefficient,
} from '../ductPressure';
import { roundMainTapGeometry, roundReducerMinLengthMm, wyeLegLengthMm } from '../ductRoundFittings';
import { SMACNA_TABLE_3_1 } from '../ductRoundRules';
import type { DuctDesignSettings } from '../ductSettings';
import { frictionPaPerM, sizingLimits, velocityMs, velocityPressurePa } from '../ductSizing';
import { isRoundLeg, isRoundMainTapStyle, roundLeg, type DuctLeg, type DuctSplitStyle, type DuctTapStyle } from '../ductTypes';

export type ShapeMode = 'rect' | 'round' | 'optimal';

/** Slowest trunk air the catalogue offers (m/s): at about 2 USD a pascal, bigger ducts do not pay back (practice). */
const MIN_TRUNK_VELOCITY_MS = 1.8;
/** Largest rectangular section height tried (mm). */
const MAX_RECT_HEIGHT_MM = 600;

export interface CostLoss {
  cost: number;
  loss: number;
}

export class SizingModel {
  readonly settings: DuctDesignSettings;
  readonly costContext: SectionCostContext;
  /** Clear bottom to soffit less the sheet, insulation and a hanger allowance (mm). */
  readonly maxHeightMm: number;
  readonly terminalDropPa: number;
  readonly returnFlow: boolean;
  /** Currency per pascal of fan pressure (present worth of the energy). */
  readonly pricePerPa: number;

  constructor(readonly ctx: ServiceCtx, readonly shape: ShapeMode, unitAirflowM3h: number) {
    this.settings = ctx.settings;
    const insulationMm = ctx.construction === 'gi-nbr'
      ? (ctx.service === 'return' ? ctx.settings.nbrReturnThicknessMm : ctx.settings.nbrSupplyThicknessMm) : 0;
    this.costContext = { service: ctx.service, construction: ctx.construction, settings: ctx.settings, insulationMm };
    this.maxHeightMm = ctx.maxHeightMm;
    this.terminalDropPa = ctx.service === 'return' ? ctx.settings.autoGrilleDropPa : ctx.settings.autoDiffuserDropPa;
    this.returnFlow = ctx.service === 'return';
    this.pricePerPa = energyPricePerPa(unitAirflowM3h, ctx.settings);
  }

  // ---- Catalogues ----

  /**
   * Trunk sections for an airflow: round stock sizes and rectangular sizes on
   * a 50 mm grid (width ≥ height, aspect ≤ 4), within the velocity cap and
   * above a floor, and within the void. The shape mode filters them.
   */
  trunkOptions(airflowM3h: number, allowRect = this.shape !== 'round', allowRound = this.shape !== 'rect'): DuctLeg[] {
    const cap = sizingLimits(this.settings, this.ctx.service, 'trunk').maxVelocityMs;
    const out: DuctLeg[] = [];
    const fits = (leg: DuctLeg) => leg.heightMm <= this.maxHeightMm;
    const inWindow = (leg: DuctLeg) => velocityMs(leg, airflowM3h) <= cap * 1.001 && velocityMs(leg, airflowM3h) >= MIN_TRUNK_VELOCITY_MS;
    if (allowRound) {
      const sizes = this.settings.autoRoundSizesMm.map((d) => roundLeg(d)).filter(fits);
      const within = sizes.filter(inWindow);
      // At least the smallest that keeps under the cap, even for a tiny flow.
      const smallest = sizes.find((leg) => velocityMs(leg, airflowM3h) <= cap * 1.001);
      out.push(...(within.length ? within : smallest ? [smallest] : []));
    }
    if (allowRect) {
      const rect: DuctLeg[] = [];
      for (let h = 100; h <= Math.min(MAX_RECT_HEIGHT_MM, this.maxHeightMm); h += 50) {
        for (let w = h; w <= 4 * h; w += 50) rect.push({ widthMm: w, heightMm: h });
      }
      const within = rect.filter(inWindow);
      const smallest = rect.filter((leg) => velocityMs(leg, airflowM3h) <= cap * 1.001)
        .sort((a, b) => a.widthMm * a.heightMm - b.widthMm * b.heightMm)[0];
      out.push(...(within.length ? within : smallest ? [smallest] : []));
    }
    return out;
  }

  /** Round branch sizes to one terminal: its neck and the stock sizes above it within the branch cap (at most three steps). */
  branchOptions(airflowM3h: number, neckMm: number): DuctLeg[] {
    const cap = sizingLimits(this.settings, this.ctx.service, 'branch').maxVelocityMs;
    const sizes = [...new Set([neckMm, ...this.settings.autoRoundSizesMm.filter((d) => d > neckMm)])].sort((a, b) => a - b);
    const out: DuctLeg[] = [];
    for (const d of sizes) {
      const leg = roundLeg(d);
      if (leg.heightMm > this.maxHeightMm && d !== neckMm) break;
      // The neck always (the terminal fixes it); larger only while it earns its keep (≥ 1 m/s).
      if (d !== neckMm && velocityMs(leg, airflowM3h) < 1) break;
      if (d === neckMm || velocityMs(leg, airflowM3h) <= cap * 1.001 || out.length === 0) out.push(leg);
      if (out.length >= 4) break;
    }
    return out;
  }

  // ---- Costs and losses ----

  costPerMetre(leg: DuctLeg): number {
    return sectionCostPerMetre(leg, this.costContext);
  }

  friction(leg: DuctLeg, airflowM3h: number, lengthMm: number, material: 'galvanised' | 'flex' = 'galvanised'): number {
    return airflowM3h > 0 && lengthMm > 0 ? frictionPaPerM(leg, airflowM3h, material) * (lengthMm / 1000) : 0;
  }

  private pv(leg: DuctLeg, airflowM3h: number): number {
    return velocityPressurePa(velocityMs(leg, airflowM3h));
  }

  /** Centreline radius of an elbow on this section (rectangular R/W setting; round per SMACNA Table 3-1). */
  elbowRadiusMm(leg: DuctLeg): number {
    return isRoundLeg(leg)
      ? SMACNA_TABLE_3_1[this.settings.roundVelocityBand].ratio * leg.diameterMm!
      : this.settings.elbowCentrelineRatio * leg.widthMm;
  }

  elbow(leg: DuctLeg, angleDeg: number, airflowM3h: number): CostLoss {
    const radius = this.elbowRadiusMm(leg);
    const developed = radius * (angleDeg * Math.PI) / 180 + 2 * this.settings.elbowNeckMm;
    const ratio = radius / (isRoundLeg(leg) ? leg.diameterMm! : leg.widthMm);
    return {
      // The support plan hangs each elbow within reach of both ends (about one extra hanger).
      cost: fittingCost(leg, developed, this.costContext) + 0.5 * this.settings.econHangerEach,
      loss: elbowCoefficient(isRoundLeg(leg) ? 'gored' : 'radius', ratio, angleDeg) * this.pv(leg, airflowM3h),
    };
  }

  /** Length of a transition between two sections (flat bottom; SMACNA Fig. 3-5 L2 on a round reducer). */
  transitionLengthMm(from: DuctLeg, to: DuctLeg): { lengthMm: number; slopeMm: number; includedDeg: number } {
    const rise = Math.max(Math.abs(to.widthMm - from.widthMm) / 2, Math.abs(to.heightMm - from.heightMm));
    let slope = Math.ceil(rise / Math.tan((this.settings.transitionTaperDeg * Math.PI) / 180) / 10) * 10;
    if (isRoundLeg(from) && isRoundLeg(to)) slope = Math.max(slope, Math.ceil(roundReducerMinLengthMm(from.diameterMm!, to.diameterMm!) / 10) * 10);
    const includedDeg = slope > 0 ? (2 * Math.atan(rise / slope) * 180) / Math.PI : 0;
    return { lengthMm: 2 * this.settings.elbowNeckMm + slope, slopeMm: slope, includedDeg };
  }

  /**
   * A transition from `from` (upstream in the path from the unit) to `to`,
   * carrying `airflowM3h`: its cost, and its loss judged in the flow direction
   * (supply: from → to; return: to → from).
   */
  transition(from: DuctLeg, to: DuctLeg, airflowM3h: number): CostLoss & { lengthMm: number } {
    if (sameLeg(from, to)) return { cost: 0, loss: 0, lengthMm: 0 };
    const geometry = this.transitionLengthMm(from, to);
    const bigger = areaOf(from) >= areaOf(to) ? from : to;
    const downstream = this.returnFlow ? from : to;
    const upstreamArea = areaOf(this.returnFlow ? to : from);
    const expanding = areaOf(downstream) > upstreamArea + 1e-9;
    const shapeChange = isRoundLeg(from) !== isRoundLeg(to) ? FITTING_LOSS_COEFFICIENTS.shapeChange : 0;
    return {
      cost: fittingCost(bigger, geometry.lengthMm, this.costContext),
      loss: (transitionCoefficient(geometry.includedDeg, expanding) + shapeChange) * this.pv(downstream, airflowM3h),
      lengthMm: geometry.lengthMm,
    };
  }

  /** Collar length of a take-off style for a branch. */
  collarLengthMm(style: DuctTapStyle, branch: DuctLeg): number {
    const s = this.settings;
    if (isRoundMainTapStyle(style)) return roundMainTapGeometry(style, branch.diameterMm ?? branch.widthMm, s).collarLengthMm;
    if (style === 'conical') return Math.max(s.tapCollarMm, s.conicalFlareMm + 100);
    if (style === 'shoe-45') return Math.max(s.tapCollarMm, Math.max(102, branch.widthMm / 4) + 50);
    return s.tapCollarMm;
  }

  /** A take-off: its collar and damper, and the loss from the main into the branch (damper wide open included). */
  tee(style: DuctTapStyle, branch: DuctLeg, branchAirflowM3h: number, main: DuctLeg, mainAirflowM3h: number, damper = true): CostLoss {
    const collar = this.collarLengthMm(style, branch);
    const damperPart = damper
      ? damperCost(branch, this.settings) + fittingCost(branch, this.settings.vcdLengthMm, this.costContext)
      : 0;
    const vb = velocityMs(branch, branchAirflowM3h);
    return {
      // A take-off wants a hanger near it on the main and at the branch start (support plan requirements).
      cost: fittingCost(branch, collar, this.costContext) + damperPart + this.settings.econHangerEach,
      loss: takeoffBranchLossPa(style, vb, velocityMs(main, mainAirflowM3h))
        + (damper ? FITTING_LOSS_COEFFICIENTS.damper * velocityPressurePa(vb) : 0),
    };
  }

  /** A spigot off a plenum box: collar, damper, entry from still air. */
  spigot(style: 'spin-in' | 'conical', branch: DuctLeg, airflowM3h: number): CostLoss {
    const collar = this.collarLengthMm(style, branch);
    const pvb = this.pv(branch, airflowM3h);
    return {
      cost: fittingCost(branch, collar, this.costContext) + damperCost(branch, this.settings) + fittingCost(branch, this.settings.vcdLengthMm, this.costContext)
        + 0.5 * this.settings.econHangerEach,
      loss: (FITTING_LOSS_COEFFICIENTS.takeoffPlenum + FITTING_LOSS_COEFFICIENTS.damper) * pvb,
    };
  }

  /** The main's straight-through loss past a take-off. */
  passage(main: DuctLeg, airflowInM3h: number, airflowOutM3h: number): number {
    return mainPassageLossPa(velocityMs(main, airflowOutM3h), velocityMs(main, airflowInM3h));
  }

  /** A split at the end of `main` into two outlets: its cost and each outlet's loss. */
  split(style: DuctSplitStyle, main: DuctLeg, mainAirflowM3h: number, outlets: [{ leg: DuctLeg; airflowM3h: number }, { leg: DuctLeg; airflowM3h: number }]): { cost: number; losses: [number, number] } {
    const vMain = velocityMs(main, mainAirflowM3h);
    const losses = outlets.map((outlet) => splitOutletLossPa(style, velocityMs(outlet.leg, outlet.airflowM3h), vMain)) as [number, number];
    let cost: number;
    if (style === 'wye') {
      const leg = wyeLegLengthMm(main.diameterMm ?? main.widthMm);
      cost = outlets.reduce((total, outlet) => total + fittingCost(main, leg + 51, this.costContext) * ((outlet.leg.widthMm + main.widthMm) / (2 * main.widthMm)), 0);
    } else if (style === 'bullhead') {
      const depth = this.settings.elbowNeckMm + Math.max(...outlets.map((outlet) => outlet.leg.widthMm));
      cost = fittingCost(main, depth + main.widthMm, this.costContext);
    } else {
      cost = outlets.reduce((total, outlet) => total + this.elbow(outlet.leg, 90, outlet.airflowM3h).cost, 0);
    }
    return { cost: cost + this.settings.econHangerEach, losses };
  }

  /** One outlet of a split: its share of the fitting and its loss. */
  splitOutlet(style: DuctSplitStyle, main: DuctLeg, mainAirflowM3h: number, outlet: DuctLeg, outletAirflowM3h: number): CostLoss {
    const loss = splitOutletLossPa(style, velocityMs(outlet, outletAirflowM3h), velocityMs(main, mainAirflowM3h));
    if (style === 'wye') {
      const leg = wyeLegLengthMm(main.diameterMm ?? main.widthMm);
      return { cost: fittingCost(main, leg + 51, this.costContext) * ((outlet.widthMm + main.widthMm) / (2 * main.widthMm)), loss };
    }
    if (style === 'bullhead') {
      // The box over the main, as deep as its outlets are wide (half each), with its vanes.
      return { cost: fittingCost(main, (this.settings.elbowNeckMm + outlet.widthMm + main.widthMm) / 2, this.costContext), loss };
    }
    return { cost: this.elbow(outlet, 90, outletAirflowM3h).cost, loss };
  }

  /** The part of a split's cost that is not per outlet (its hanger). */
  splitBaseCost(_style: DuctSplitStyle, _main: DuctLeg, _mainAirflowM3h: number): number {
    return this.settings.econHangerEach;
  }

  capCost(leg: DuctLeg): number {
    return fittingCost(leg, 50, this.costContext) + 0.5 * this.settings.econHangerEach;
  }

  /** A plenum box, by its sheet (the sides over its length and the two faces). */
  plenumCost(box: DuctLeg, lengthMm: number): number {
    return fittingCost(box, lengthMm + box.heightMm, this.costContext, 2) + this.settings.econHangerEach;
  }

  /** A flexible runout: its cost and friction. */
  flex(neckMm: number, airflowM3h: number, lengthMm: number): CostLoss {
    return { cost: flexCost(neckMm, lengthMm, this.settings), loss: this.friction(roundLeg(neckMm), airflowM3h, lengthMm, 'flex') };
  }
}

export function areaOf(leg: DuctLeg): number {
  return isRoundLeg(leg) ? (Math.PI * leg.diameterMm! * leg.diameterMm!) / 4e6 : (leg.widthMm * leg.heightMm) / 1e6;
}

export function sameLeg(a: DuctLeg, b: DuctLeg): boolean {
  return isRoundLeg(a) === isRoundLeg(b) && Math.abs(a.widthMm - b.widthMm) < 0.5 && Math.abs(a.heightMm - b.heightMm) < 0.5;
}

export function legLabel(leg: DuctLeg): string {
  return isRoundLeg(leg) ? `Ø${Math.round(leg.diameterMm!)}` : `${Math.round(leg.widthMm)}×${Math.round(leg.heightMm)}`;
}
