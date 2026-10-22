/**
 * The priced physics the optimiser works with: what a metre of a section, a
 * fitting or a runout costs (ductEconomics.ts, SMACNA gauges) and what
 * pressure it loses at a flow (Darcy–Weisbach friction and the fitting losses
 * of ductPressure.ts). The same functions the verification uses, so the model
 * and the planned result agree to within the geometry the realiser settles.
 */
import type { Point2D } from '../../../../../types';
import { portEntryDirection } from '../ductAirPorts';
import { branchStubMm, dirToWorld, flexClear, flexFit, flexOk, runoutStaysOut, toWorld, type ServiceCtx, type TerminalCtx } from '../ductAutoContext';
import { DIVIDED_FLOW_MIN_LEG_MM, dividedFlowLeg, dividedFlowLegWidthMm, shoeLeadInMm } from '../ductBranches';
import { damperCost, energyPricePerPa, fittingCost, flexCost, sectionCostPerMetre, type SectionCostContext } from '../ductEconomics';
import { flexCurve, type DuctFlexGeometry } from '../ductFlex';
import {
  dividedFlowOutletLossPa,
  elbowCoefficient,
  FITTING_LOSS_COEFFICIENTS,
  flexBendLossPa,
  mainPassageLossPa,
  splitOutletLossPa,
  takeoffBranchLossPa,
  transitionCoefficient,
} from '../ductPressure';
import { maxRoundBranchMm, roundMainTapGeometry, roundReducerMinLengthMm, wyeLegLengthMm } from '../ductRoundFittings';
import { SMACNA_TABLE_3_1 } from '../ductRoundRules';
import type { DuctDesignSettings } from '../ductSettings';
import { frictionPaPerM, sizingLimits, velocityMs, velocityPressurePa } from '../ductSizing';
import { isRoundLeg, isRoundMainTapStyle, roundLeg, type DuctConstruction, type DuctLeg, type DuctSplitStyle, type DuctSystemShape, type DuctTapStyle } from '../ductTypes';

/** The system's shape the catalogues follow: rectangular throughout, a rectangular main with round branches, round, or mixed. */
export type ShapeMode = DuctSystemShape;

/** Slowest trunk air the catalogue offers (m/s): at about 2 USD a pascal, bigger ducts do not pay back (practice). */
const MIN_TRUNK_VELOCITY_MS = 1.8;
/** Largest rectangular section height tried (mm). */
export const MAX_RECT_HEIGHT_MM = 600;

export interface CostLoss {
  cost: number;
  loss: number;
}

export class SizingModel {
  readonly settings: DuctDesignSettings;
  readonly costContext: SectionCostContext;
  /** Clear bottom to soffit less the sheet, insulation and a hanger allowance (mm). */
  readonly maxHeightMm: number;
  /** The service's placeholder terminal drop (a terminal without its own figure). */
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

  /** A terminal's own drop at its airflow (a filter grille's media included), else the service's. */
  terminalDrop(terminal: { dropPa?: number }): number {
    return terminal.dropPa ?? this.terminalDropPa;
  }

  // ---- Catalogues ----

  /** The fabricator's rectangular step (mm). */
  get rectStepMm(): number {
    return this.settings.rectStepMm;
  }

  /**
   * Trunk sections for an airflow: round stock sizes and rectangular sizes on
   * the fabricator's step (width ≥ height, aspect ≤ 4), within the velocity
   * cap and above a floor, and within the void. The shape mode filters them.
   */
  trunkOptions(airflowM3h: number, allowRect = this.shape !== 'round', allowRound = this.shape === 'round' || this.shape === 'optimal'): DuctLeg[] {
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
      const step = this.rectStepMm;
      for (let h = Math.ceil(100 / step) * step; h <= Math.min(MAX_RECT_HEIGHT_MM, this.maxHeightMm); h += step) {
        for (let w = h; w <= 4 * h; w += step) rect.push({ widthMm: w, heightMm: h });
      }
      const within = rect.filter(inWindow);
      const smallest = rect.filter((leg) => velocityMs(leg, airflowM3h) <= cap * 1.001)
        .sort((a, b) => a.widthMm * a.heightMm - b.widthMm * b.heightMm)[0];
      out.push(...(within.length ? within : smallest ? [smallest] : []));
    }
    return out;
  }

  /**
   * Branch sizes to one terminal: round, its neck and the stock sizes above it
   * within the branch cap (at most three steps); rectangular throughout, the
   * smallest rectangles within the cap on the fabricator's step, flat (width ≥
   * height, aspect ≤ 4) — a square-to-round takes each to the neck.
   */
  branchOptions(airflowM3h: number, neckMm: number): DuctLeg[] {
    const cap = sizingLimits(this.settings, this.ctx.service, 'branch').maxVelocityMs;
    if (this.shape === 'rectangular') {
      const step = this.rectStepMm;
      const rect: DuctLeg[] = [];
      for (let h = Math.ceil(100 / step) * step; h <= Math.min(MAX_RECT_HEIGHT_MM, this.maxHeightMm); h += step) {
        for (let w = h; w <= 4 * h; w += step) {
          const leg = { widthMm: w, heightMm: h };
          if (velocityMs(leg, airflowM3h) <= cap * 1.001) { rect.push(leg); break; }
        }
      }
      // The four smallest that keep under the cap (by area; the flatter first at a tie).
      return rect.sort((a, b) => a.widthMm * a.heightMm - b.widthMm * b.heightMm || a.heightMm - b.heightMm).slice(0, 4);
    }
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

  /**
   * The shortest setback an elbow on this section can take, as the realiser
   * will specify it: a 90° turn on a rectangular section may be a square
   * vaned elbow (setback W/2, SMACNA Fig. 2-2 RE2); otherwise the radius
   * elbow's R·tan(θ/2). Neck not included.
   */
  elbowSetbackMm(leg: DuctLeg, angleDeg = 90): number {
    if (!isRoundLeg(leg) && Math.abs(angleDeg - 90) < 1) return leg.widthMm / 2;
    return this.elbowRadiusMm(leg) * Math.tan((angleDeg * Math.PI) / 360);
  }

  /**
   * How far an elbow's fitting reaches along each leg from its corner, as the
   * realiser keeps it clear of take-offs and reducers: setback, neck and a
   * margin. A rectangular 90° turn may be square vaned (the realiser says so).
   */
  bendReachMm(leg: DuctLeg, angleDeg = 90): number {
    return this.elbowSetbackMm(leg, angleDeg) + this.settings.elbowNeckMm + 25;
  }

  /** Half the length of main a take-off occupies (its opening as the planner cuts it) plus the joint margin. */
  tapWindowHalfMm(style: DuctTapStyle, branch: DuctLeg, main: DuctLeg): number {
    const s = this.settings;
    let half: number;
    if (isRoundLeg(main) && isRoundMainTapStyle(style)) half = roundMainTapGeometry(style, branch.diameterMm ?? branch.widthMm, s).windowHalfMm;
    else if (style === 'conical') half = (branch.widthMm + s.conicalFlareMm) / 2;
    else if (style === 'shoe-45') half = branch.widthMm / 2 + shoeLeadInMm(branch.widthMm);
    else half = branch.widthMm / 2;
    return half + s.tapWindowMarginMm;
  }

  /**
   * Straight a run ending on a terminal keeps before its end, as the realiser
   * builds it: the fitting down to the neck and a lead into the runout (the
   * lead alone where the run is already the neck size).
   */
  endStraightMm(leg: DuctLeg, neckMm: number): number {
    const neck = roundLeg(neckMm);
    return sameLeg(leg, neck) ? 400 : Math.max(400, this.transitionLengthMm(leg, neck).lengthMm + 100);
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

  /**
   * Straight a lateral or a wye leg needs on its branch before any other
   * fitting (SMACNA Fig. 3-4 / 3-5): the 45° run (the collar and damper, or
   * the wye's 3A/2 leg), the elbow back square and a margin. One formula for
   * the tree router and the sizing.
   */
  diagonalRoomMm(mainDiameterMm: number, branch: DuctLeg, wye: boolean): number {
    const size = branch.diameterMm ?? branch.widthMm;
    const setback = (this.elbowRadiusMm(branch) / size) * size * Math.tan(Math.PI / 8);
    const diagonal = (wye ? 1.5 * mainDiameterMm : this.collarLengthMm('round-lateral', branch) + this.settings.vcdLengthMm) + setback + this.settings.elbowNeckMm;
    return diagonal * Math.SQRT1_2 + setback + this.settings.elbowNeckMm + 300;
  }

  /**
   * The 45° leg the realiser lays from a lateral's collar or a wye's outlet
   * before the elbow that squares the branch back (collar, damper, that
   * elbow's setback and neck, and a margin).
   */
  diagonalLegMm(first: DuctLeg, collarMm: number, damper: boolean): number {
    const setback = this.elbowRadiusMm(roundLeg(first.diameterMm ?? first.widthMm)) * Math.tan(Math.PI / 8);
    return collarMm + (damper ? this.settings.vcdLengthMm : 0) + setback + this.settings.elbowNeckMm + 50;
  }

  /**
   * A root that turns first at the collar's own section (a square vaned elbow),
   * where the collar straight is too short for its transition: the straight
   * the next leg needs — that elbow's reach, then the transition to a trunk
   * section and that section's next elbow — the least over the sections that
   * can take a branch of Ø`branchNeckMm` (the trunk carries the take-offs),
   * among the catalogue's and ones as wide as the collar (short transitions).
   */
  turnFirstReachMm(airflowM3h: number, branchNeckMm: number): number {
    const collar: DuctLeg = { widthMm: this.ctx.port.widthMm, heightMm: this.ctx.port.heightMm };
    const neck = this.settings.elbowNeckMm;
    const wide: DuctLeg[] = this.shape === 'round' ? [] : [150, 200, 250, 300, 350]
      .filter((h) => h <= this.maxHeightMm && h % this.rectStepMm === 0)
      .map((h) => ({ widthMm: Math.max(100, Math.round(collar.widthMm / this.rectStepMm) * this.rectStepMm), heightMm: h }));
    const sections = [...this.trunkOptions(airflowM3h), ...wide];
    const takes = sections.filter((leg) => (isRoundLeg(leg) ? maxRoundBranchMm(leg.diameterMm!) >= branchNeckMm - 0.5 : leg.heightMm >= branchNeckMm + 50 - 0.5));
    const reach = (leg: DuctLeg) => this.transitionLengthMm(collar, leg).lengthMm + this.elbowSetbackMm(leg) + neck + 25;
    return this.elbowSetbackMm(collar) + neck + 25 + Math.min(...(takes.length ? takes : sections).map(reach));
  }

  /**
   * How far past a run's end the outlet of a split runs on its own line (mm,
   * along the main), as ductBranches builds the fitting: a divided-flow Y's
   * leg elbow (its neck and radius, on the leg's `share` of the main), a
   * bullhead's box to the outlet's centre, a wye's 3A/2 leg and the diagonal
   * to the elbow that squares it (both at 45°).
   */
  splitLeadMm(style: DuctSplitStyle, main: DuctLeg, outlet: DuctLeg, share: number): number {
    const neck = this.settings.elbowNeckMm;
    if (style === 'wye') return (wyeLegLengthMm(main.diameterMm ?? main.widthMm) + this.diagonalLegMm(outlet, 51, false)) * Math.SQRT1_2;
    if (style === 'bullhead') return neck + outlet.widthMm / 2;
    return dividedFlowLeg(main, outlet, share, 1, 90, this.settings).alongMm;
  }

  /** Whether a divided-flow Y can give a leg `share` of `main`: the leg at least DIVIDED_FLOW_MIN_LEG_MM wide. */
  dividedFlowShareOk(main: DuctLeg, share: number): boolean {
    return dividedFlowLegWidthMm(main.widthMm, share, 1) >= DIVIDED_FLOW_MIN_LEG_MM - 0.5;
  }

  /**
   * One leg of a divided-flow Y carrying `outletAirflowM3h` of the main's
   * (its share of the main's width): its elbow, its transition to the outlet
   * and half the splitter, and its loss — as the planner builds it.
   */
  private dividedFlowOutlet(main: DuctLeg, mainAirflowM3h: number, outlet: DuctLeg, outletAirflowM3h: number): CostLoss {
    const share = mainAirflowM3h > 0 ? outletAirflowM3h / mainAirflowM3h : 0.5;
    const shaped = dividedFlowLeg(main, outlet, share, 1, 90, this.settings);
    const larger = shaped.leg.widthMm * shaped.leg.heightMm >= outlet.widthMm * outlet.heightMm ? shaped.leg : outlet;
    const transitionCost = shaped.transitionMm > 0 ? fittingCost(larger, shaped.transitionMm, this.costContext) : 0;
    const splitter = fittingCost({ widthMm: main.heightMm / 4, heightMm: main.heightMm / 4 }, this.settings.elbowNeckMm, this.costContext) / 2;
    return {
      cost: this.elbow(shaped.leg, 90, outletAirflowM3h).cost + transitionCost + splitter,
      loss: dividedFlowOutletLossPa({
        inlet: main, leg: shaped.leg, outlet, radiusRatio: shaped.radiusMm / Math.max(1, shaped.leg.widthMm), angleDeg: 90,
        transitionSlopeMm: shaped.transitionMm > 0 ? shaped.transitionMm - 2 * this.settings.elbowNeckMm : null,
      }, mainAirflowM3h, outletAirflowM3h),
    };
  }

  /**
   * An all-flex branch off a main of section `main`, leaving its centreline
   * at `centre` along `out` (local frame): whether its runout — from the end
   * of the collar and damper stub into the terminal's spigot — bends within
   * limits, is short enough and runs clear, exactly as the realiser lays it.
   */
  stubRunoutFits(centre: Point2D, out: Point2D, main: DuctLeg, style: DuctTapStyle, terminal: TerminalCtx, bottomZ: number): boolean {
    const neck = roundLeg(terminal.neck);
    const stub = branchStubMm(this.settings) + Math.max(0, this.collarLengthMm(style, neck) - this.settings.tapCollarMm);
    const half = (main.diameterMm ?? main.widthMm) / 2;
    const offset = half + stub;
    const end = { x: centre.x + out.x * offset, y: centre.y + out.y * offset };
    return flexOk(flexFit(this.ctx, end, out, bottomZ, terminal), terminal, this.settings) && flexClear(this.ctx, end, out, bottomZ, terminal)
      && runoutStaysOut(this.ctx, centre, out, end, bottomZ, terminal, half);
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
    if (style === 'y') {
      // A divided-flow Y: each leg at its share of the main.
      const [a, b] = outlets.map((outlet) => this.dividedFlowOutlet(main, mainAirflowM3h, outlet.leg, outlet.airflowM3h)) as [CostLoss, CostLoss];
      return { cost: a.cost + b.cost + this.settings.econHangerEach, losses: [a.loss, b.loss] };
    }
    const vMain = velocityMs(main, mainAirflowM3h);
    const losses = outlets.map((outlet) => splitOutletLossPa(style, velocityMs(outlet.leg, outlet.airflowM3h), vMain)) as [number, number];
    let cost: number;
    if (style === 'wye') {
      const leg = wyeLegLengthMm(main.diameterMm ?? main.widthMm);
      cost = outlets.reduce((total, outlet) => total + fittingCost(main, leg + 51, this.costContext) * ((outlet.leg.widthMm + main.widthMm) / (2 * main.widthMm)), 0);
    } else {
      const depth = this.settings.elbowNeckMm + Math.max(...outlets.map((outlet) => outlet.leg.widthMm));
      cost = fittingCost(main, depth + main.widthMm, this.costContext);
    }
    return { cost: cost + this.settings.econHangerEach, losses };
  }

  /** One outlet of a split: its share of the fitting and its loss. */
  splitOutlet(style: DuctSplitStyle, main: DuctLeg, mainAirflowM3h: number, outlet: DuctLeg, outletAirflowM3h: number): CostLoss {
    if (style === 'y') return this.dividedFlowOutlet(main, mainAirflowM3h, outlet, outletAirflowM3h);
    const loss = splitOutletLossPa(style, velocityMs(outlet, outletAirflowM3h), velocityMs(main, mainAirflowM3h));
    if (style === 'wye') {
      const leg = wyeLegLengthMm(main.diameterMm ?? main.widthMm);
      return { cost: fittingCost(main, leg + 51, this.costContext) * ((outlet.widthMm + main.widthMm) / (2 * main.widthMm)), loss };
    }
    // A bullhead: the box over the main, as deep as its outlets are wide (half each), with its vanes.
    return { cost: fittingCost(main, (this.settings.elbowNeckMm + outlet.widthMm + main.widthMm) / 2, this.costContext), loss };
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

  /** The planner's curve, so routing can reject invalid fits before pricing their bends. */
  flexRunoutCurve(start: Point2D, out: Point2D, terminal: TerminalCtx, bottomZ = this.ctx.bottomZ): DuctFlexGeometry & { radiusMm: number } {
    const worldStart = toWorld(this.ctx.frame, start);
    const direction = dirToWorld(this.ctx.frame, out);
    const curve = flexCurve(
      { ...worldStart, z: bottomZ + terminal.neck / 2 }, { ...direction, z: 0 },
      terminal.port.lip, portEntryDirection(terminal.port),
    );
    return { ...curve, radiusMm: curve.minBendRadiusMm };
  }

  /** Geometry and additional bend loss of the runout the fabrication planner draws. */
  flexRunout(start: Point2D, out: Point2D, terminal: TerminalCtx, airflowM3h = terminal.airflowM3h, bottomZ = this.ctx.bottomZ): { lengthMm: number; radiusMm: number; bendLossPa: number } {
    const curve = this.flexRunoutCurve(start, out, terminal, bottomZ);
    return {
      lengthMm: curve.lengthMm,
      radiusMm: curve.minBendRadiusMm,
      bendLossPa: flexBendLossPa(curve.points, terminal.neck, airflowM3h),
    };
  }

  /** With no curve information, explicitly fall back to straight-flex friction. */
  flex(neckMm: number, airflowM3h: number, lengthMm: number, bendLossPa = 0): CostLoss {
    return {
      cost: flexCost(neckMm, lengthMm, this.settings),
      loss: this.friction(roundLeg(neckMm), airflowM3h, lengthMm, 'flex') + bendLossPa,
    };
  }
}

/**
 * A model for the fitting geometry only (elbow reach, take-off windows,
 * transition lengths, collars): those read nothing but the settings, so no
 * terminals, obstacles or void are needed.
 */
export function geometryModel(settings: DuctDesignSettings, service: 'supply' | 'return', construction: DuctConstruction): SizingModel {
  const ctx = { settings, service, construction, maxHeightMm: Number.POSITIVE_INFINITY } as unknown as ServiceCtx;
  return new SizingModel(ctx, 'optimal', 1);
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
