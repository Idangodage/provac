/**
 * What a segment's card offers, and what each choice would do.
 *
 * Options are edits (ductSegmentEdits) grouped as a designer thinks of them:
 *  - size: the constant-friction size for the air it carries;
 *  - swap: the same air another way — the equal-friction spiral duct for a
 *    rectangle (ASHRAE Fundamentals ch. 21, Huebscher), flatter or squarer
 *    rectangles of the same friction, another elbow or take-off fitting;
 *  - tune: a fitting's parameters (an elbow's radius, a transition's taper);
 *  - accessory: a damper, a connector, a fire damper, an end.
 *
 * Each option is evaluated by applying its edit to a copy of the drawing and
 * re-reading the system (ductSegmentFigures): the segment's velocity against
 * the system's limits, its loss and the fan's index path, the first and the
 * life-cycle cost (the optimiser's own economics), the mass, the void it
 * needs, and any rule it newly breaks — so the card compares honestly, and
 * what is previewed is exactly what is applied.
 */
import type { HvacElement } from '../../../../types';

import { getActiveDuctBuilding } from './ductBuilding';
import { energyPricePerPa, priceDuctPlans } from './ductEconomics';
import { getDuctRunPlan, type DuctFabricationPlan } from './ductFabricationPlanner';
import { accessDoorFor } from './ductFabricationPlanner';
import { DUCT_VANES } from './ductFittingRules';
import { ductLegs } from './ductGeometry';
import { ductParentOf } from './ductNetwork';
import { penetrationHasFireDamper } from './ductPenetrations';
import { aspectOf, outerHeightMm, rectangularEquivalents, roundEquivalents, sameSectionSize } from './ductSectionEquivalents';
import { applyDuctSegmentEdit, INLINE_TITLES, rigidLegIndices, type DuctSegmentEdit } from './ductSegmentEdits';
import { ductSegmentFigures, type DuctFigureStatus, type DuctSegmentFigures } from './ductSegmentFigures';
import { ductSegmentOf, sectionLabel, TAKEOFF_TITLES, type DuctSegment } from './ductSegments';
import type { DuctDesignSettings } from './ductSettings';
import { equivalentDiameterMm, sizeRectangular, sizeRound, velocityMs } from './ductSizing';
import { resolveSoffitZ } from './ductSupports';
import { DUCT_TERMINAL_NECKS_MM, TERMINAL_FACE_LABELS, TERMINAL_FACES_BY_SERVICE, terminalLabel } from './ductTerminalCatalog';
import { readDuctTerminalSpec } from './ductTerminals';
import { DUCT_ATTENUATOR_LENGTHS_MM, isRoundLeg, readDuctRunSpec, roundLeg, type DuctLeg, type DuctRunSpec, type DuctTapStyle } from './ductTypes';

export type DuctOptionGroup = 'size' | 'swap' | 'tune' | 'accessory' | 'terminal';

/** What an option's small picture shows. */
export type DuctOptionGlyph =
  | 'rect' | 'round' | 'elbow-radius' | 'elbow-vaned' | 'elbow-gored' | 'taper'
  | 'tap-shoe' | 'tap-straight' | 'tap-spin' | 'tap-conical' | 'tap-tee' | 'tap-lateral'
  | 'split-y' | 'split-bullhead' | 'damper' | 'connector' | 'fire-damper' | 'cap' | 'open' | 'flex' | 'terminal'
  | 'access-door' | 'attenuator';

export interface DuctSegmentOption {
  /** Stable within the segment (survives a re-read of the same drawing). */
  id: string;
  group: DuctOptionGroup;
  glyph: DuctOptionGlyph;
  title: string;
  detail: string;
  edit: DuctSegmentEdit;
  /** What the segment is now (shown, not applied). */
  current?: boolean;
  /** Offered, but it cannot be made here: why. */
  disabledReason?: string;
}

export type DuctOptionScope = 'leg' | 'size';

export interface DuctSegmentOptionContext {
  plan: DuctFabricationPlan;
  spec: DuctRunSpec;
  segment: DuctSegment;
  figures: DuctSegmentFigures | null;
  /** The clear inside height a duct here may take (to the structure, less insulation and hanger room) (mm). */
  voidHeightMm: number;
}

const TAP_GLYPH: Record<DuctTapStyle, DuctOptionGlyph> = {
  'shoe-45': 'tap-shoe', straight: 'tap-straight', 'spin-in': 'tap-spin', conical: 'tap-conical',
  'round-tee': 'tap-tee', 'round-conical': 'tap-conical', 'round-lateral': 'tap-lateral',
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The outer height a leg has from its bottom up to the soffit, less its insulation and a 50 mm margin (mm). */
function voidHeightOf(spec: DuctRunSpec, legIndex: number, settings: DuctDesignSettings): number {
  const leg = spec.path[Math.min(legIndex, spec.path.length - 1)]!;
  return Math.max(100, resolveSoffitZ(settings) - leg.z - 2 * spec.insulationThicknessMm - 50);
}

/** The rectangle of a round section's friction nearest 2 : 1, lying flat and no taller than the round or `maxHeightMm`; null when none fits. */
function moderateRectangle(diameterMm: number, maxHeightMm: number, maxAspect: number): DuctLeg | null {
  const rects = rectangularEquivalents(diameterMm, { maxHeightMm: Math.min(maxHeightMm, diameterMm), maxAspect });
  return [...rects].sort((a, b) => Math.abs(aspectOf(a) - 2) - Math.abs(aspectOf(b) - 2))[0] ?? null;
}

export function segmentOptionContext(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, key: string): DuctSegmentOptionContext | null {
  const element = scene.find((candidate) => candidate.id === runId);
  const spec = element ? readDuctRunSpec(element) : null;
  const plan = element ? getDuctRunPlan(element, scene, settings) : null;
  const segment = plan ? ductSegmentOf(plan, key) : null;
  if (!element || !spec || !plan || !segment) return null;
  return { plan, spec, segment, figures: ductSegmentFigures(scene, settings, runId, key), voidHeightMm: voidHeightOf(spec, segment.legIndex, settings) };
}

/** The legs a size applies to: the leg alone, or every leg of the run that has the same section. */
export function scopeLegs(spec: DuctRunSpec, legIndex: number, scope: DuctOptionScope): number[] {
  const rigid = rigidLegIndices(spec);
  if (scope === 'leg' || !rigid.includes(legIndex)) return rigid.includes(legIndex) ? [legIndex] : [];
  const section = spec.legs[legIndex]!;
  return rigid.filter((index) => sameSectionSize(spec.legs[index]!, section));
}

function sectionOptions(runId: string, legs: number[], current: DuctLeg, context: DuctSegmentOptionContext, settings: DuctDesignSettings): DuctSegmentOption[] {
  const options: DuctSegmentOption[] = [];
  const add = (section: DuctLeg, title: string, detail: string, id: string) => {
    if (sameSectionSize(section, current) || options.some((option) => option.id === id)) return;
    options.push({
      id, group: 'swap', glyph: isRoundLeg(section) ? 'round' : 'rect', title, detail,
      edit: { kind: 'leg-section', runId, sections: legs.map((leg) => ({ leg, section })) },
    });
  };
  const stock = settings.autoRoundSizesMm;
  const de = equivalentDiameterMm(current);
  const seam = context.plan.seamRound === 'spiral' ? 'spiral' : 'round';
  const maxAspect = settings.aspectRatioAdvisory;
  if (!isRoundLeg(current)) {
    const { atOrAbove, below } = roundEquivalents(current, stock);
    if (atOrAbove) add(atOrAbove, `Ø${atOrAbove.diameterMm} ${seam}`, `same friction (equivalent Ø${Math.round(de)})`, `round:${atOrAbove.diameterMm}`);
    if (below && below.diameterMm! >= de * 0.9) add(below, `Ø${below.diameterMm} ${seam}`, 'a size smaller: a little more friction', `round:${below.diameterMm}`);
    const rects = rectangularEquivalents(de, { maxHeightMm: context.voidHeightMm, maxAspect });
    const flatter = [...rects].reverse().find((leg) => leg.heightMm < current.heightMm);
    const squarer = rects.find((leg) => leg.heightMm > current.heightMm);
    const squarest = rects[rects.length - 1];
    if (flatter) add(flatter, sectionLabel(flatter), `same friction, ${current.heightMm - flatter.heightMm} mm lower`, `rect:${flatter.widthMm}x${flatter.heightMm}`);
    if (squarer) add(squarer, sectionLabel(squarer), `same friction, squarer (aspect ${round1(aspectOf(squarer))})`, `rect:${squarer.widthMm}x${squarer.heightMm}`);
    if (squarest && squarest !== squarer) add(squarest, sectionLabel(squarest), `same friction, the squarest that fits (aspect ${round1(aspectOf(squarest))})`, `rect:${squarest.widthMm}x${squarest.heightMm}`);
  } else {
    const d = current.diameterMm!;
    const rects = rectangularEquivalents(d, { maxHeightMm: Math.min(context.voidHeightMm, d), maxAspect });
    const flattest = rects[0];
    const moderate = [...rects].sort((a, b) => Math.abs(aspectOf(a) - 2) - Math.abs(aspectOf(b) - 2))[0];
    const squarest = rects[rects.length - 1];
    for (const [leg, words] of [[flattest, 'lowest'], [moderate, 'about 2 : 1'], [squarest, 'squarest']] as const) {
      if (leg) add(leg, sectionLabel(leg), `same friction, rectangular, ${words} (${d - leg.heightMm} mm lower)`, `rect:${leg.widthMm}x${leg.heightMm}`);
    }
    const sizes = [...new Set(stock)].sort((a, b) => a - b);
    const up = sizes.find((size) => size > d + 0.5);
    const down = [...sizes].reverse().find((size) => size < d - 0.5);
    if (up) add(roundLeg(up), `Ø${up} ${seam}`, 'a size larger: less friction and noise', `round:${up}`);
    if (down) add(roundLeg(down), `Ø${down} ${seam}`, 'a size smaller: more friction', `round:${down}`);
  }
  // The constant-friction size for the air it carries, at the system's friction rate and the part's velocity limit.
  const flow = context.figures?.flow;
  if (flow && flow.airflowM3h.max > 0) {
    const limits = { frictionPaPerM: flow.limits.frictionPaPerM, maxVelocityMs: flow.limits.velocityMs };
    const recommended = isRoundLeg(current)
      ? roundLeg(sizeRound(flow.airflowM3h.max, limits, stock))
      : (() => {
        // The tallest height up to the current one at which the narrowest size within the limits lies flat (a ceiling duct).
        const top = Math.min(current.heightMm, context.voidHeightMm);
        for (let height = Math.floor(top / 50) * 50; height >= 100; height -= 50) {
          const rect = sizeRectangular(flow.airflowM3h.max, height, limits, { stepMm: 50, maxAspect, maxHeightMm: height });
          if (!rect.capped && rect.widthMm >= rect.heightMm) return { widthMm: rect.widthMm, heightMm: rect.heightMm };
        }
        const rect = sizeRectangular(flow.airflowM3h.max, top, limits, { stepMm: 50, maxAspect, maxHeightMm: context.voidHeightMm });
        return { widthMm: Math.max(rect.widthMm, rect.heightMm), heightMm: Math.min(rect.widthMm, rect.heightMm) };
      })();
    if (!sameSectionSize(recommended, current)) {
      const sized = `sized for ${Math.round(flow.airflowM3h.max)} m³/h at ${flow.limits.frictionPaPerM.toFixed(2)} Pa/m, ≤ ${flow.limits.velocityMs} m/s`;
      // One row per size: an equivalent that is also the size for its air says both.
      const twin = options.findIndex((option) => option.edit.kind === 'leg-section' && sameSectionSize(option.edit.sections[0]!.section, recommended));
      if (twin >= 0) {
        const [same] = options.splice(twin, 1);
        options.unshift({ ...same!, group: 'size', detail: `${sized} · ${same!.detail}` });
      } else {
        options.unshift({
          id: `size:${sectionLabel(recommended)}`, group: 'size', glyph: isRoundLeg(recommended) ? 'round' : 'rect',
          title: `${sectionLabel(recommended)}${isRoundLeg(recommended) ? ` ${seam}` : ''}`, detail: sized,
          edit: { kind: 'leg-section', runId, sections: legs.map((leg) => ({ leg, section: recommended })) },
        });
      }
    }
  }
  return options;
}

function elbowOptions(runId: string, context: DuctSegmentOptionContext, settings: DuctDesignSettings): DuctSegmentOption[] {
  const piece = context.plan.pieces[context.segment.pieceIndices[0]!]!;
  const elbow = piece.elbow;
  const node = context.segment.nodeIndex;
  if (!elbow || node === undefined) return [];
  const spec = context.spec;
  const override = spec.nodeOverrides[String(node)] ?? {};
  const inPlane = elbow.inPlaneMm ?? piece.widthMm;
  const ratio = inPlane > 0 ? elbow.centrelineRadiusMm / inPlane : 0;
  const options: DuctSegmentOption[] = [];
  const nodeOption = (id: string, glyph: DuctOptionGlyph, title: string, detail: string, next: typeof override, current: boolean): DuctSegmentOption => ({
    id, group: 'swap', glyph, title, detail, edit: { kind: 'node', runId, node, override: Object.keys(next).length ? next : null }, ...(current ? { current } : {}),
  });
  const legs = [node - 1, node].filter((index) => rigidLegIndices(spec).includes(index));
  const ratioName = elbow.plane === 'vertical' ? 'R/H' : 'R/W';
  if (elbow.style !== 'gored') {
    for (const [r, words] of [[1.5, 'SMACNA RE1 default, low loss'], [1, 'compact'], [0.75, 'tight throat, up to 5 m/s']] as const) {
      const throat = Math.max(0, Math.round(r * inPlane - inPlane / 2));
      options.push(nodeOption(`radius:${r}`, 'elbow-radius', `Radius elbow ${ratioName} ${r}`, `throat ${throat} mm · ${words}`,
        { ...override, elbowStyle: 'radius', centrelineRatio: r, vaneType: undefined }, elbow.style === 'radius' && Math.abs(ratio - r) < 0.01));
    }
    if (Math.abs(elbow.angleDeg - 90) < 1) {
      options.push(nodeOption('vaned:auto', 'elbow-vaned', 'Square elbow, turning vanes', 'lightest vanes that span it (SMACNA Fig. 2-3)',
        { ...override, elbowStyle: 'square-vaned', vaneType: undefined, centrelineRatio: undefined }, elbow.style === 'square-vaned' && !override.vaneType));
      options.push(nodeOption('vaned:double-large', 'elbow-vaned', 'Square elbow, double-wall vanes', DUCT_VANES['double-large'].label,
        { ...override, elbowStyle: 'square-vaned', vaneType: 'double-large', centrelineRatio: undefined }, elbow.style === 'square-vaned' && override.vaneType === 'double-large'));
    }
    // The same turn in spiral duct: the legs either side take their equal-friction round size.
    const sections = legs.map((leg) => ({ leg, section: roundEquivalents(spec.legs[leg]!, settings.autoRoundSizesMm).atOrAbove }))
      .filter((entry): entry is { leg: number; section: DuctLeg } => entry.section !== null);
    if (sections.length === legs.length && legs.length > 0) {
      const sizes = [...new Set(sections.map((entry) => sectionLabel(entry.section)))].join(' / ');
      options.push({
        id: 'gored', group: 'swap', glyph: 'elbow-gored', title: `Round gored elbow ${sizes}`,
        detail: `the legs either side become ${sizes} ${context.plan.seamRound === 'spiral' ? 'spiral' : 'round'} duct`,
        edit: { kind: 'leg-section', runId, sections },
      });
    }
  } else {
    for (const [r, words] of [[1.5, 'SMACNA Table 3-1, low loss'], [1, 'compact']] as const) {
      const throat = Math.max(0, Math.round(r * inPlane - inPlane / 2));
      options.push(nodeOption(`gored:${r}`, 'elbow-gored', `Gored elbow R/D ${r}`, `throat ${throat} mm · ${words}`,
        { ...override, centrelineRatio: r }, Math.abs(ratio - r) < 0.01));
    }
    const sections = legs.map((leg) => {
      const d = spec.legs[leg]!.diameterMm ?? spec.legs[leg]!.widthMm;
      const rects = rectangularEquivalents(d, { maxHeightMm: Math.min(context.voidHeightMm, d), maxAspect: settings.aspectRatioAdvisory });
      const moderate = [...rects].sort((a, b) => Math.abs(aspectOf(a) - 2) - Math.abs(aspectOf(b) - 2))[0];
      return moderate ? { leg, section: moderate } : null;
    }).filter((entry): entry is { leg: number; section: DuctLeg } => entry !== null);
    if (sections.length === legs.length && legs.length > 0) {
      const sizes = [...new Set(sections.map((entry) => sectionLabel(entry.section)))].join(' / ');
      options.push({
        id: 'rect-elbow', group: 'swap', glyph: 'elbow-radius', title: `Rectangular radius elbow ${sizes}`,
        detail: `the legs either side become ${sizes} rectangular duct`, edit: { kind: 'leg-section', runId, sections },
      });
    }
  }
  return options;
}

function transitionOptions(runId: string, context: DuctSegmentOptionContext, settings: DuctDesignSettings): DuctSegmentOption[] {
  const legIndex = context.segment.legIndex;
  const spec = context.spec;
  const options: DuctSegmentOption[] = [];
  // Its taper (per side): gentler is longer and loses less; SMACNA Fig. 2-7 caps the angles (the planner checks them).
  const override = spec.nodeOverrides[String(legIndex)] ?? {};
  const project = settings.transitionTaperDeg;
  const now = override.taperDeg ?? project;
  for (const taper of [...new Set([10, project, 20, 30])].sort((a, b) => a - b)) {
    options.push({
      id: `taper:${taper}`, group: 'tune', glyph: 'taper', title: `${taper}° per side`,
      detail: taper === project ? 'the project taper' : taper < project ? 'longer and gentler: less loss' : 'shorter and steeper: more loss',
      edit: { kind: 'node', runId, node: legIndex, override: { ...override, taperDeg: taper === project ? undefined : taper } },
      ...(Math.abs(now - taper) < 0.01 ? { current: true } : {}),
    });
  }
  const rigid = rigidLegIndices(spec);
  if (legIndex < 1) {
    // Off the unit's collar onto a round first leg: that leg — or every round leg of the run — in rectangular duct
    // of the same friction keeps the duct square; this becomes a rectangular transition (or goes, at the collar's size).
    const first = spec.legs[0];
    if (first && isRoundLeg(first) && rigid.includes(0)) {
      const rect = moderateRectangle(first.diameterMm!, context.voidHeightMm, settings.aspectRatioAdvisory);
      if (rect) {
        options.push({
          id: `rect-first:${rect.widthMm}x${rect.heightMm}`, group: 'swap', glyph: 'rect', title: `Rectangular duct ${sectionLabel(rect)}`,
          detail: 'the leg after it in rectangular duct of the same friction: this becomes a rectangular transition',
          edit: { kind: 'leg-section', runId, sections: [{ leg: 0, section: rect }] },
        });
      }
      const run = rigid.filter((index) => isRoundLeg(spec.legs[index]!)).flatMap((index) => {
        const section = moderateRectangle(spec.legs[index]!.diameterMm!, voidHeightOf(spec, index, settings), settings.aspectRatioAdvisory);
        return section ? [{ leg: index, section }] : [];
      });
      if (run.length > 1) {
        options.push({
          id: 'rect-run', group: 'swap', glyph: 'rect', title: 'Rectangular run',
          detail: `every round leg of the run (${run.length}) in rectangular duct of the same friction; its fittings follow`,
          edit: { kind: 'leg-section', runId, sections: run },
        });
      }
    }
    return options;
  }
  const before = spec.legs[legIndex - 1]!;
  const after = spec.legs[legIndex]!;
  if (rigid.includes(legIndex)) {
    options.push({ id: 'continue-before', group: 'swap', glyph: isRoundLeg(before) ? 'round' : 'rect', title: `Carry ${sectionLabel(before)} on`,
      detail: 'no transition: the next leg keeps the size before it', edit: { kind: 'leg-section', runId, sections: [{ leg: legIndex, section: before }] } });
  }
  if (rigid.includes(legIndex - 1)) {
    options.push({ id: 'continue-after', group: 'swap', glyph: isRoundLeg(after) ? 'round' : 'rect', title: `Bring ${sectionLabel(after)} back`,
      detail: 'no transition: the leg before takes the size after it', edit: { kind: 'leg-section', runId, sections: [{ leg: legIndex - 1, section: after }] } });
  }
  return options;
}

function takeoffOptions(scene: readonly HvacElement[], runId: string, context: DuctSegmentOptionContext, settings: DuctDesignSettings): DuctSegmentOption[] {
  const spec = context.spec;
  const start = spec.start;
  if (start.kind !== 'tap') return [];
  const parent = ductParentOf(spec, scene);
  const parentSpec = parent ? readDuctRunSpec(parent) : null;
  const main = parentSpec?.legs[start.legIndex];
  if (!parent || !parentSpec || !main) return [];
  const first = spec.legs[0]!;
  const options: DuctSegmentOption[] = [];
  const lateralNow = start.style === 'round-lateral';
  const offer = (style: DuctTapStyle, detail: string, firstLeg?: DuctLeg) => {
    const turns = lateralNow !== (style === 'round-lateral');
    options.push({
      id: `tap:${style}`, group: 'swap', glyph: TAP_GLYPH[style], title: TAKEOFF_TITLES[style], detail: turns ? `${detail}; the branch turns with it` : detail,
      edit: { kind: 'tap', runId, style, ...(firstLeg ? { firstLeg } : {}) },
      ...(style === start.style ? { current: true } : {}),
    });
  };
  if (isRoundLeg(main)) {
    offer('round-conical', 'cone into the main: lower loss than a straight tee (SMACNA Fig. 3-5)');
    offer('round-tee', '90° tap with a 51 mm spigot (SMACNA Fig. 3-4)');
    offer('round-lateral', 'leaves at 45° downstream: the lowest loss (SMACNA Fig. 3-4)');
    // The main as a rectangle of the same friction: the take-off becomes the square collar that fits it.
    const rects = rectangularEquivalents(main.diameterMm!, { maxHeightMm: Math.min(context.voidHeightMm, main.diameterMm!), maxAspect: settings.aspectRatioAdvisory });
    const moderate = [...rects].sort((a, b) => Math.abs(aspectOf(a) - 2) - Math.abs(aspectOf(b) - 2))[0];
    if (moderate) {
      options.push({
        id: `main-rect:${moderate.widthMm}x${moderate.heightMm}`, group: 'swap', glyph: 'rect', title: `Rectangular main ${sectionLabel(moderate)}`,
        detail: lateralNow ? 'the main leg in rectangular duct; this lateral becomes a spin-in and its branch turns with it'
          : 'the main leg in rectangular duct; this collar becomes a spin-in or conical one',
        edit: { kind: 'leg-section', runId: parent.id, sections: [{ leg: start.legIndex, section: moderate }] },
      });
    }
  } else {
    const roundBranch = isRoundLeg(first) ? first : roundEquivalents(first, settings.autoRoundSizesMm).atOrAbove ?? roundLeg(Math.min(first.widthMm, first.heightMm));
    const rectBranch = !isRoundLeg(first) ? first : (() => {
      const rects = rectangularEquivalents(first.diameterMm!, { maxHeightMm: Math.min(main.heightMm, context.voidHeightMm), maxAspect: settings.aspectRatioAdvisory });
      return rects[rects.length - 1] ?? { widthMm: first.widthMm, heightMm: Math.min(first.heightMm, main.heightMm) };
    })();
    offer('shoe-45', `45° entry, lead-in ${Math.round(Math.max(102, rectBranch.widthMm / 4))} mm: the lowest loss (SMACNA Fig. 2-6)`, isRoundLeg(first) ? rectBranch : undefined);
    offer('straight', 'square tap (SMACNA Fig. 2-6)', isRoundLeg(first) ? rectBranch : undefined);
    offer('conical', `round collar, cone mouth Ø${Math.round((roundBranch.diameterMm ?? 0) + settings.conicalFlareMm)} (SMACNA Fig. 2-6)`, isRoundLeg(first) ? undefined : roundBranch);
    offer('spin-in', 'round collar at the branch Ø (SMACNA Fig. 2-6)', isRoundLeg(first) ? undefined : roundBranch);
  }
  return options;
}

function accessoryOptions(runId: string, context: DuctSegmentOptionContext, settings: DuctDesignSettings): DuctSegmentOption[] {
  const spec = context.spec;
  const kind = context.segment.kind;
  const start = spec.start;
  const options: DuctSegmentOption[] = [];
  if ((kind === 'takeoff' || context.segment.key === 'start:damper') && (start.kind === 'tap' || start.kind === 'split-branch' || start.kind === 'spigot')) {
    options.push({
      id: `vcd:${!start.vcd}`, group: 'accessory', glyph: 'damper',
      title: start.vcd ? 'Remove the volume damper' : 'Add a volume damper',
      detail: start.vcd ? 'the branch is then balanced at its terminal' : 'balances this branch (SMACNA Fig. 2-12 / 2-13)',
      edit: { kind: 'start', runId, vcd: !start.vcd },
    });
  }
  if (kind === 'connector' && start.kind === 'unit-port') {
    options.push({
      id: `connector:${!start.connector}`, group: 'accessory', glyph: 'connector',
      title: start.connector ? 'Remove the flexible connector' : 'Add a flexible connector',
      detail: 'isolates the unit\'s vibration from the ductwork', edit: { kind: 'start', runId, connector: !start.connector },
    });
  }
  if (kind === 'fire-damper' || kind === 'straight') {
    for (const penetration of context.plan.penetrations) {
      const piece = context.plan.pieces.find((candidate) => candidate.penetrationKey === penetration.key);
      const inSegment = kind === 'fire-damper' ? context.segment.key === `pen:${penetration.key}` : penetration.legIndex === context.segment.legIndex;
      if (!inSegment) continue;
      const byPolicy = penetrationHasFireDamper(penetration, undefined, settings.fireDamperPolicy);
      options.push({
        id: `fd:${penetration.key}:${!penetration.fireDamper}`, group: 'accessory', glyph: 'fire-damper',
        title: penetration.fireDamper ? `No fire damper at ${penetration.mark}` : `Fire damper at ${penetration.mark}`,
        detail: penetration.fireDamper ? 'a plain sleeve through the wall' : `a curtain fire damper in its sleeve, with an access door${piece ? '' : ' (UL 555)'}`,
        edit: { kind: 'fire-damper', runId, key: penetration.key, fireDamper: !penetration.fireDamper, byPolicy },
      });
    }
  }
  if (kind === 'split' && spec.end.kind === 'split') {
    const now = spec.end.style;
    const last = rigidLegIndices(spec).at(-1);
    const section = last !== undefined ? spec.legs[last]! : null;
    if (now !== 'wye') {
      for (const style of ['y', 'bullhead'] as const) {
        options.push({
          id: `split:${style}`, group: 'swap', glyph: style === 'y' ? 'split-y' : 'split-bullhead',
          title: style === 'y' ? 'Y split' : 'Bullhead tee', detail: style === 'y' ? 'divides the flow on radius elbows: the lower loss (SMACNA Fig. 2-5)' : 'square tee with turning vanes (SMACNA Fig. 2-5)',
          edit: { kind: 'split', runId, style }, ...(style === now ? { current: true } : {}),
        });
      }
      // The same split in spiral duct: the last leg its equal-friction round size, a wye, the outlets round and turned 45°.
      const round = section ? roundEquivalents(section, settings.autoRoundSizesMm).atOrAbove : null;
      if (round && last !== undefined) {
        options.push({
          id: `split:wye:${round.diameterMm}`, group: 'swap', glyph: 'split-y', title: `Wye in Ø${round.diameterMm} spiral`,
          detail: 'the run\'s last leg round, a wye (SMACNA Fig. 3-5); its outlets round, leaving at 45°',
          edit: { kind: 'leg-section', runId, sections: [{ leg: last, section: round }] },
        });
        const name = now === 'y' ? 'Y split' : 'bullhead tee';
        options.push({
          id: `split:keep:${round.diameterMm}`, group: 'swap', glyph: 'round', title: `Round main Ø${round.diameterMm}, ${name} kept`,
          detail: `the run's last leg round up to a short rectangular neck: a round-to-square before the ${name}, its outlets as they are`,
          edit: { kind: 'leg-section', runId, sections: [{ leg: last, section: round }], keepSplit: true },
        });
      }
    } else if (section && last !== undefined) {
      options.push({ id: 'split:wye', group: 'swap', glyph: 'split-y', title: 'Wye', detail: 'SMACNA Fig. 3-5', edit: { kind: 'split', runId, style: 'wye' }, current: true });
      const rects = rectangularEquivalents(section.diameterMm!, { maxHeightMm: Math.min(context.voidHeightMm, section.diameterMm!), maxAspect: settings.aspectRatioAdvisory });
      const moderate = [...rects].sort((a, b) => Math.abs(aspectOf(a) - 2) - Math.abs(aspectOf(b) - 2))[0];
      if (moderate) {
        for (const style of ['y', 'bullhead'] as const) {
          options.push({
            id: `split:${style}:${moderate.widthMm}x${moderate.heightMm}`, group: 'swap', glyph: style === 'y' ? 'split-y' : 'split-bullhead',
            title: `${style === 'y' ? 'Y split' : 'Bullhead tee'} in ${sectionLabel(moderate)}`,
            detail: `the run's last leg rectangular (SMACNA Fig. 2-5); its outlets rectangular, leaving square`,
            edit: { kind: 'leg-section', runId, sections: [{ leg: last, section: moderate }], splitStyle: style },
          });
        }
        options.push({
          id: `split:keep:${moderate.widthMm}x${moderate.heightMm}`, group: 'swap', glyph: 'rect', title: `Rectangular main ${sectionLabel(moderate)}, wye kept`,
          detail: 'the run\'s last leg rectangular up to a short round neck: a square-to-round before the wye, its outlets as they are',
          edit: { kind: 'leg-section', runId, sections: [{ leg: last, section: moderate }], keepSplit: true },
        });
      }
    }
  }
  if (kind === 'end-cap') {
    options.push({ id: 'end:open', group: 'accessory', glyph: 'open', title: 'Leave the end open', detail: 'for a later extension', edit: { kind: 'end', runId, end: 'open' } });
  }
  options.push(...inlineOptions(runId, context));
  return options;
}

/**
 * Accessories set into a straight: on a straight (or riser), a volume damper,
 * an access door or a sound attenuator at its middle (the edit takes the clear
 * spot nearest it); on an accessory, taking it out and an attenuator's lengths.
 */
function inlineOptions(runId: string, context: DuctSegmentOptionContext): DuctSegmentOption[] {
  const { spec, segment, plan } = context;
  const options: DuctSegmentOption[] = [];
  if ((segment.kind === 'straight' || segment.kind === 'riser') && rigidLegIndices(spec).includes(segment.legIndex)) {
    const pieces = segment.pieceIndices.map((index) => plan.pieces[index]!);
    const legStart = pieces.length ? Math.min(...pieces.map((piece) => piece.stationStartMm)) : 0;
    const legEnd = pieces.length ? Math.max(...pieces.map((piece) => piece.stationEndMm)) : 0;
    // The middle of the leg's straights, along the leg (from the leg's own start).
    const legOrigin = ductLegs(spec).slice(0, segment.legIndex).reduce((total, leg) => total + leg.lengthMm, 0);
    const stationMm = Math.round((legStart + legEnd) / 2 - legOrigin);
    const section = spec.legs[segment.legIndex]!;
    const door = accessDoorFor(section);
    const add = (kind: 'damper' | 'access-door' | 'attenuator', title: string, detail: string) => options.push({
      id: `inline:${kind}`, group: 'accessory', glyph: kind === 'damper' ? 'damper' : kind, title, detail,
      edit: { kind: 'inline-add', runId, accessory: { kind, legIndex: segment.legIndex, stationMm, ...(kind === 'attenuator' ? { lengthMm: 900 } : {}) } },
    });
    add('damper', 'Volume damper', 'a volume damper here: balances the air past it (SMACNA Fig. 2-12 / 2-13)');
    add('access-door', `Access door ${door.sizeMm}×${door.sizeMm}`, `an access door here, in the duct's ${door.face}, for cleaning and inspection (SMACNA Fig. 7-2)`);
    add('attenuator', 'Sound attenuator 900 mm', `a ${isRoundLeg(section) ? 'round podded' : 'rectangular splitter'} attenuator here: quietens the air to the rooms (its loss a practice estimate)`);
    return options;
  }
  const id = segment.key.startsWith('inline:') ? segment.key.slice('inline:'.length) : null;
  const item = id ? spec.inline?.find((candidate) => candidate.id === id) : undefined;
  if (!item) return options;
  if (item.kind === 'attenuator') {
    const now = item.lengthMm ?? 900;
    for (const length of DUCT_ATTENUATOR_LENGTHS_MM) {
      options.push({
        id: `attenuator:${length}`, group: 'tune', glyph: 'attenuator', title: `${length} mm`,
        detail: length === now ? 'as it is' : length < now ? 'shorter: less attenuation and loss' : 'longer: more attenuation and loss',
        edit: { kind: 'inline-length', runId, id: item.id, lengthMm: length }, ...(length === now ? { current: true } : {}),
      });
    }
  }
  options.push({
    id: 'inline:remove', group: 'accessory', glyph: item.kind === 'damper' ? 'damper' : item.kind,
    title: `Remove the ${INLINE_TITLES[item.kind].toLowerCase()}`, detail: 'the straight closes over its place',
    edit: { kind: 'inline-remove', runId, id: item.id },
  });
  return options;
}

/** A runout made rigid or flexible, and the terminal at its end: other faces of its service, other necks. */
function runoutOptions(scene: readonly HvacElement[], runId: string, context: DuctSegmentOptionContext): DuctSegmentOption[] {
  const spec = context.spec;
  const end = spec.end;
  if (end.kind !== 'terminal') return [];
  const options: DuctSegmentOption[] = [];
  const terminal = scene.find((element) => element.id === end.terminalId);
  const terminalSpec = terminal ? readDuctTerminalSpec(terminal) : null;
  const kind = context.segment.kind;
  if (kind === 'flex') {
    options.push({
      id: 'runout:rigid', group: 'swap', glyph: 'round', title: `Rigid runout in Ø${terminalSpec?.neckDiameterMm ?? ''} spiral`,
      detail: 'a slip joint on the spigot: no flexible duct to sag or kink (SMACNA S3.23 keeps flex short)',
      edit: { kind: 'runout', runId, flex: false },
    });
  } else if (!end.flex && (kind === 'straight' || kind === 'riser')) {
    options.push({
      id: 'runout:flex', group: 'accessory', glyph: 'flex', title: 'Flexible runout to the terminal',
      detail: 'flexible duct from the run\'s level to the spigot (easier to fit; keep it short)', edit: { kind: 'runout', runId, flex: true },
    });
  }
  if (terminal && terminalSpec && (kind === 'flex' || (!end.flex && context.segment.legIndex === spec.legs.length - 1))) {
    const necks = [...DUCT_TERMINAL_NECKS_MM];
    const at = necks.indexOf(terminalSpec.neckDiameterMm as (typeof necks)[number]);
    for (const neck of [necks[at - 1], necks[at + 1]].filter((value): value is (typeof necks)[number] => value !== undefined)) {
      options.push({
        id: `neck:${neck}`, group: 'terminal', glyph: 'terminal', title: `Neck Ø${neck}`,
        detail: `${terminal.label || 'the terminal'} on a Ø${neck} spigot; its runout follows (${neck > terminalSpec.neckDiameterMm ? 'slower and quieter' : 'smaller'})`,
        edit: { kind: 'terminal', terminalId: terminal.id, neckMm: neck },
      });
    }
    for (const face of TERMINAL_FACES_BY_SERVICE[terminalSpec.service]) {
      if (face === terminalSpec.kind) continue;
      options.push({
        id: `face:${face}`, group: 'terminal', glyph: 'terminal', title: terminalLabel({ kind: face, service: terminalSpec.service, filter: terminalSpec.filter ?? null }),
        detail: `${terminal.label || 'the terminal'} with a ${TERMINAL_FACE_LABELS[face].toLowerCase()} face, the same neck`,
        edit: { kind: 'terminal', terminalId: terminal.id, face },
      });
    }
  }
  return options;
}

/** Everything the card offers for a segment (none for a locked run). */
export function ductSegmentOptions(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, key: string, scope: DuctOptionScope = 'leg'): DuctSegmentOption[] {
  const context = segmentOptionContext(scene, settings, runId, key);
  if (!context || context.spec.legacy) return [];
  const { segment, spec } = context;
  let options: DuctSegmentOption[] = [];
  if (segment.kind === 'straight' || segment.kind === 'riser') {
    const legs = scopeLegs(spec, segment.legIndex, scope);
    if (legs.length) options = sectionOptions(runId, legs, spec.legs[segment.legIndex]!, context, settings);
  } else if (segment.kind === 'elbow') {
    options = elbowOptions(runId, context, settings);
  } else if (segment.kind === 'transition') {
    options = transitionOptions(runId, context, settings);
  } else if (segment.kind === 'takeoff') {
    options = takeoffOptions(scene, runId, context, settings);
  }
  options.push(...runoutOptions(scene, runId, context));
  options.push(...accessoryOptions(runId, context, settings));
  if (spec.locked) return options.map((option) => (option.current ? option : { ...option, disabledReason: 'The run is locked: unlock it to change it.' }));
  return options;
}

// ---- What an option would do ----

export interface DuctIssueChange {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface DuctOptionEvaluation {
  optionId: string;
  refused?: string;
  updates: HvacElement[];
  /** The undo step's name when applied. */
  action: string;
  /** What else it changes (the edit's notes and the fittings the planner adds or drops). */
  notes: string[];
  /** The segment after the change (null when it no longer exists as such). */
  after: DuctSegmentFigures | null;
  section: DuctLeg | null;
  velocityMs: number | null;
  velocityStatus: DuctFigureStatus | null;
  /** Change in the segment's own loss, and in the fan's index path (Pa). */
  deltaSegmentPa: number | null;
  deltaIndexPa: number | null;
  /** Change in first cost and in life-cycle cost (first cost + the present worth of the fan energy) (currency). */
  deltaFirstCost: number;
  deltaLifeCycleCost: number | null;
  deltaMassKg: number;
  /** The outside height the segment needs, and its change (mm). */
  outerHeightMm: number | null;
  deltaOuterHeightMm: number | null;
  newIssues: DuctIssueChange[];
  /** Issues of the changed runs it clears. */
  clearedIssues: number;
}

const EVALUATION_CACHE = new WeakMap<readonly HvacElement[], Map<string, { settings: DuctDesignSettings; building: unknown; evaluation: DuctOptionEvaluation }>>();

/** A plan's errors and warnings by kind (severity and code), with how many of each. */
function issueCounts(plan: DuctFabricationPlan | null): Map<string, { count: number; issue: DuctIssueChange }> {
  const map = new Map<string, { count: number; issue: DuctIssueChange }>();
  for (const issue of plan?.issues ?? []) {
    if (issue.severity === 'info') continue;
    const key = `${issue.severity}|${issue.code}`;
    const entry = map.get(key);
    if (entry) entry.count += 1;
    else map.set(key, { count: 1, issue: { severity: issue.severity, code: issue.code, message: issue.message } });
  }
  return map;
}

function countKinds(plan: DuctFabricationPlan | null, kind: string): number {
  return plan ? plan.pieces.filter((piece) => piece.kind === kind).length : 0;
}

function segmentSection(figures: DuctSegmentFigures | null, plan: DuctFabricationPlan | null, key: string): DuctLeg | null {
  const segment = plan ? ductSegmentOf(plan, key) : null;
  if (!plan || !segment) return null;
  const piece = plan.pieces[segment.pieceIndices[0]!]!;
  void figures;
  return piece.diameterMm !== undefined ? roundLeg(piece.diameterMm) : { widthMm: piece.widthMm, heightMm: piece.heightMm };
}

/** What applying `option` to the segment `key` of run `runId` would do (cached per drawing). */
export function evaluateDuctSegmentOption(
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
  runId: string,
  key: string,
  option: DuctSegmentOption,
): DuctOptionEvaluation {
  const building = getActiveDuctBuilding();
  let byScene = EVALUATION_CACHE.get(scene);
  if (!byScene) EVALUATION_CACHE.set(scene, (byScene = new Map()));
  const cacheKey = `${runId}|${key}|${option.id}|${JSON.stringify(option.edit)}`;
  const hit = byScene.get(cacheKey);
  if (hit && hit.settings === settings && hit.building === building) return hit.evaluation;

  const result = applyDuctSegmentEdit(scene, settings, option.edit);
  const empty: DuctOptionEvaluation = {
    optionId: option.id, updates: [], action: '', notes: [], after: null, section: null, velocityMs: null, velocityStatus: null,
    deltaSegmentPa: null, deltaIndexPa: null, deltaFirstCost: 0, deltaLifeCycleCost: null, deltaMassKg: 0,
    outerHeightMm: null, deltaOuterHeightMm: null, newIssues: [], clearedIssues: 0,
  };
  let evaluation: DuctOptionEvaluation;
  if (result.refused || result.updates.length === 0) {
    evaluation = { ...empty, ...(result.refused ? { refused: result.refused } : {}) };
  } else {
    const replaced = new Map(result.updates.map((element) => [element.id, element]));
    const next = scene.map((element) => replaced.get(element.id) ?? element);
    const plansBefore = result.updates.map((element) => {
      const original = scene.find((candidate) => candidate.id === element.id);
      return original ? getDuctRunPlan(original, scene, settings) : null;
    });
    const plansAfter = result.updates.map((element) => getDuctRunPlan(element, next, settings));
    const before = ductSegmentFigures(scene, settings, runId, key);
    const after = ductSegmentFigures(next, settings, runId, key);
    const existing = (plans: Array<DuctFabricationPlan | null>) => plans.filter((plan): plan is DuctFabricationPlan => plan !== null);
    const deltaFirstCost = priceDuctPlans(existing(plansAfter), settings).total - priceDuctPlans(existing(plansBefore), settings).total;
    const mass = (plans: Array<DuctFabricationPlan | null>) => existing(plans).reduce((total, plan) => total + plan.totals.massKg, 0);
    const deltaIndexPa = before?.system?.indexPa !== null && before?.system?.indexPa !== undefined && after?.system?.indexPa !== null && after?.system?.indexPa !== undefined
      ? after.system.indexPa - before.system.indexPa : null;
    const airflow = after?.system?.airflowM3h ?? before?.system?.airflowM3h ?? null;
    // New and cleared issues on the runs it changes, by kind (an issue that was there with other numbers is not new).
    const newIssues: DuctIssueChange[] = [];
    let clearedIssues = 0;
    result.updates.forEach((_, index) => {
      const was = issueCounts(plansBefore[index] ?? null);
      const now = issueCounts(plansAfter[index] ?? null);
      for (const [issueKey, entry] of now) if (entry.count > (was.get(issueKey)?.count ?? 0)) newIssues.push(entry.issue);
      for (const [issueKey, entry] of was) clearedIssues += Math.max(0, entry.count - (now.get(issueKey)?.count ?? 0));
    });
    // The fittings the planner adds or drops on the run itself.
    const runIndex = result.updates.findIndex((element) => element.id === runId);
    const notes = [...result.notes];
    if (runIndex >= 0) {
      const transitions = countKinds(plansAfter[runIndex] ?? null, 'transition') - countKinds(plansBefore[runIndex] ?? null, 'transition');
      if (transitions > 0) notes.push(`${transitions} transition${transitions === 1 ? '' : 's'} added where the size changes`);
      if (transitions < 0) notes.push(`${-transitions} transition${transitions === -1 ? '' : 's'} no longer needed`);
    }
    const followers = result.updates.length - 1 - result.notes.filter((note) => note.includes('becomes')).length;
    if (followers > 0 && result.updates.some((element) => element.id !== runId)) notes.push('branches stay on their terminals (re-anchored on the new wall)');
    const planAfter = runIndex >= 0 ? plansAfter[runIndex] ?? null : getDuctRunPlan(next.find((element) => element.id === runId)!, next, settings);
    const section = segmentSection(after, planAfter, key);
    const sheet = (after?.construction?.sheetMm ?? before?.construction?.sheetMm ?? 1);
    const insulation = after?.construction?.insulationMm ?? 0;
    const outer = section ? outerHeightMm(section, sheet, insulation) : null;
    const sectionBefore = segmentSection(before, getDuctRunPlan(scene.find((element) => element.id === runId)!, scene, settings), key);
    const outerBefore = sectionBefore ? outerHeightMm(sectionBefore, before?.construction?.sheetMm ?? 1, before?.construction?.insulationMm ?? 0) : null;
    const flow = after?.flow ?? null;
    evaluation = {
      ...empty,
      updates: result.updates,
      action: result.action,
      notes,
      after,
      section,
      velocityMs: flow ? flow.velocityMs.max : section && before?.flow ? velocityMs(section, before.flow.airflowM3h.max) : null,
      velocityStatus: flow?.velocityStatus ?? null,
      deltaSegmentPa: flow && before?.flow ? flow.totalPa - before.flow.totalPa : null,
      deltaIndexPa,
      deltaFirstCost,
      deltaLifeCycleCost: deltaIndexPa !== null && airflow ? deltaFirstCost + energyPricePerPa(airflow, settings) * deltaIndexPa : null,
      deltaMassKg: mass(plansAfter) - mass(plansBefore),
      outerHeightMm: outer,
      deltaOuterHeightMm: outer !== null && outerBefore !== null ? outer - outerBefore : null,
      newIssues,
      clearedIssues,
    };
  }
  byScene.set(cacheKey, { settings, building, evaluation });
  return evaluation;
}

export type DuctOptionBadge = 'recommended' | 'lowest-pressure' | 'lowest-cost' | 'saves-height';

/**
 * Badges over the evaluated swaps and sizes: Recommended = the lowest
 * life-cycle cost of those that break no rule and keep the velocity within
 * its limit, when it beats the segment as it is; Lowest pressure, Lowest cost;
 * Saves height = 25 mm or more of the void.
 */
export function rankDuctOptions(options: readonly DuctSegmentOption[], evaluations: ReadonlyMap<string, DuctOptionEvaluation>): Map<string, DuctOptionBadge[]> {
  const badges = new Map<string, DuctOptionBadge[]>();
  const add = (id: string, badge: DuctOptionBadge) => badges.set(id, [...(badges.get(id) ?? []), badge]);
  const candidates = options
    .filter((option) => (option.group === 'swap' || option.group === 'size') && !option.current && !option.disabledReason)
    .map((option) => ({ option, evaluation: evaluations.get(option.id) }))
    .filter((entry): entry is { option: DuctSegmentOption; evaluation: DuctOptionEvaluation } => Boolean(entry.evaluation && !entry.evaluation.refused));
  const clean = candidates.filter(({ evaluation }) => !evaluation.newIssues.some((issue) => issue.severity === 'error') && evaluation.velocityStatus !== 'over');
  const best = (list: typeof clean, score: (evaluation: DuctOptionEvaluation) => number | null) => {
    let winner: (typeof clean)[number] | null = null;
    let low = Number.POSITIVE_INFINITY;
    for (const entry of list) {
      const value = score(entry.evaluation);
      if (value !== null && value < low - 1e-9) {
        low = value;
        winner = entry;
      }
    }
    return winner ? { id: winner.option.id, value: low } : null;
  };
  const recommended = best(clean, (evaluation) => evaluation.deltaLifeCycleCost);
  if (recommended && recommended.value < 0) add(recommended.id, 'recommended');
  const pressure = best(clean, (evaluation) => evaluation.deltaIndexPa ?? evaluation.deltaSegmentPa);
  if (pressure && pressure.value < -0.05) add(pressure.id, 'lowest-pressure');
  const cost = best(clean, (evaluation) => evaluation.deltaFirstCost);
  if (cost && cost.value < 0) add(cost.id, 'lowest-cost');
  for (const { option, evaluation } of clean) {
    if (evaluation.deltaOuterHeightMm !== null && evaluation.deltaOuterHeightMm <= -25) add(option.id, 'saves-height');
  }
  return badges;
}
