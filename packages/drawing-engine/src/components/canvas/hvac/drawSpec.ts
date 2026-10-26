/**
 * "Draw like this": what a duct, a refrigerant line or a drain is, as the bar
 * above the drawing names it (its service, section or sizes, level,
 * construction), and what arming its drawing tool to draw more of exactly it
 * sets. The kind also lights its tile in the toolbox's Ducts & pipes. Pure.
 */
import type { HvacElement } from '../../../types';

import { formatFallRatio } from './condensate/condensateSettings';
import { readCondensatePipeSpec, isCondensatePipe } from './condensate/condensateTypes';
import { isDuctElement, isRoundLeg, readDuctRunSpec, type DuctConstruction, type DuctLeg } from './duct/ductTypes';
import { resolveRefrigerantPipeSpec, type RefrigerantPipeLineMode, type RefrigerantPipeMaterial } from './refrigerantPipePairModel';
import { formatQuantity, formatSection, inchFractionText, slopeText, type HvacUnitSystem } from './units/hvacUnits';

export type DrawKind = 'supply-duct' | 'return-duct' | 'pair' | 'gas' | 'liquid' | 'drain';

export type DrawArm =
  | { tool: 'duct'; service: 'supply' | 'return'; section: DuctLeg; bottomMm: number; construction: DuctConstruction; insulationMm: number }
  | { tool: 'refrigerant-pipe'; lineMode: RefrigerantPipeLineMode; material: RefrigerantPipeMaterial }
  | { tool: 'drain'; fallPercent: number | null };

export interface DrawSpec {
  kind: DrawKind;
  elementId: string;
  /** "Supply duct", "Gas + liquid", "Drain". */
  title: string;
  /** "Rect 400×250", "Bottom 2.70 m", "GI + NBR 25 mm". */
  chips: string[];
  arm: DrawArm;
}

export const DRAW_KIND_TITLES: Record<DrawKind, string> = {
  'supply-duct': 'Supply duct', 'return-duct': 'Return duct', pair: 'Gas + liquid', gas: 'Gas', liquid: 'Liquid', drain: 'Drain',
};

/** A tube's outside diameter as a fitter names it: 15.88 (SI) or 5/8″ (IP). */
export function tubeText(mm: number, system: HvacUnitSystem): string {
  return system === 'ip' ? `${inchFractionText(mm)}″` : `${Number(mm.toFixed(2))}`;
}

/** A duct section with its shape: "Rect 400×250", "Round Ø250" (inches in IP). */
export function ductSectionText(section: DuctLeg, system: HvacUnitSystem): string {
  return `${isRoundLeg(section) ? 'Round' : 'Rect'} ${formatSection(section, system)}${system === 'ip' ? ' in' : ''}`;
}

/** A level (mm) as lengths are shown: "2.70 m", "8.9 ft". */
export function levelText(mm: number, system: HvacUnitSystem): string {
  return formatQuantity('length', mm / 1000, system);
}

/** A drain's fall as it is specified: "1:50" (SI) or "1/4 in/ft" (IP). */
export function fallText(percent: number, system: HvacUnitSystem): string {
  return system === 'ip' ? slopeText(percent) : formatFallRatio(percent);
}

/** The other line of a coordinated pair (same bundle, the other service), if there is one. */
function partnerOf(element: HvacElement, scene: readonly HvacElement[]): HvacElement | null {
  const bundleId = element.properties.bundleId;
  if (typeof bundleId !== 'string' || !bundleId) return null;
  const kind = resolveRefrigerantPipeSpec(element.properties).lineKind;
  return scene.find((other) => other.id !== element.id && other.type === 'refrigerant-pipe' && other.properties.bundleId === bundleId
    && resolveRefrigerantPipeSpec(other.properties).lineKind !== kind) ?? null;
}

/**
 * What `element` is, to draw more of (null for anything else). `legIndex`: the duct leg picked (its section and level
 * are the ones drawn), else its first.
 */
export function drawSpecOf(element: HvacElement, scene: readonly HvacElement[], system: HvacUnitSystem, legIndex?: number): DrawSpec | null {
  if (isDuctElement(element)) {
    const spec = readDuctRunSpec(element);
    if (!spec || !spec.legs.length) return null;
    const leg = Math.max(0, Math.min(spec.legs.length - 1, legIndex ?? 0));
    const section = spec.legs[leg]!;
    const service = spec.service === 'return' ? 'return' : 'supply';
    const kind: DrawKind = service === 'return' ? 'return-duct' : 'supply-duct';
    const bottomMm = spec.path[leg]?.z ?? spec.path[0]!.z;
    const insulated = spec.construction === 'gi-nbr' && spec.insulationThicknessMm > 0;
    return {
      kind, elementId: element.id, title: DRAW_KIND_TITLES[kind],
      chips: [
        ductSectionText(section, system),
        `Bottom ${levelText(bottomMm, system)}`,
        insulated ? `GI + NBR ${formatQuantity('size', spec.insulationThicknessMm, system)}` : spec.construction === 'pid' ? 'Pre-insulated' : 'GI, bare',
      ],
      arm: {
        tool: 'duct', service, section: { ...section }, bottomMm, construction: spec.construction,
        insulationMm: insulated ? spec.insulationThicknessMm : 0,
      },
    };
  }
  if (element.type === 'refrigerant-pipe') {
    const spec = resolveRefrigerantPipeSpec(element.properties, scene as HvacElement[]);
    const partner = partnerOf(element, scene);
    const partnerSpec = partner ? resolveRefrigerantPipeSpec(partner.properties, scene as HvacElement[]) : null;
    const gas = spec.lineKind === 'gas' ? spec : partnerSpec;
    const liquid = spec.lineKind === 'liquid' ? spec : partnerSpec;
    const hard = spec.segmentMaterials.length > 0 && spec.segmentMaterials.filter((material) => material === 'hard').length * 2 >= spec.segmentMaterials.length;
    const kind: DrawKind = partner ? 'pair' : spec.lineKind;
    const sizes = partner && gas && liquid ? `${tubeText(gas.pipeDiameterMm, system)} + ${tubeText(liquid.pipeDiameterMm, system)}` : tubeText(spec.pipeDiameterMm, system);
    return {
      kind, elementId: element.id, title: DRAW_KIND_TITLES[kind],
      chips: [
        system === 'ip' ? sizes : `${sizes} mm`,
        `Insul ${formatQuantity('size', spec.insulationThicknessMm, system)}`,
        hard ? 'Hard copper' : 'Soft copper',
      ],
      arm: { tool: 'refrigerant-pipe', lineMode: partner ? 'pair' : spec.lineKind, material: hard ? 'hard' : 'flexible' },
    };
  }
  if (isCondensatePipe(element)) {
    const spec = readCondensatePipeSpec(element);
    const stored = element.properties.designFallPercent;
    const fallPercent = typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? stored : spec.designSlopePercent;
    return {
      kind: 'drain', elementId: element.id, title: DRAW_KIND_TITLES.drain,
      chips: [
        `CD ${spec.nominalSize}`,
        `Fall ${fallText(fallPercent, system)}`,
        ...(spec.insulationThicknessMm > 0 ? [`Insul ${formatQuantity('size', spec.insulationThicknessMm, system)}`] : []),
      ],
      arm: { tool: 'drain', fallPercent },
    };
  }
  return null;
}
