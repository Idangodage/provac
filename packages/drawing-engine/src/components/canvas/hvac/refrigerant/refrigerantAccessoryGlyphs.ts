/**
 * Inline refrigerant accessories as the plan draws them: a symbol on the pipe,
 * centred on the body and turned with the straight it sits on, the body's own
 * length and width (an annotative minimum keeps it legible far out):
 *
 *  - ball valve: the valve bow-tie with its ball, and its lever;
 *  - strainer: a Y-strainer, its screen leg and cap;
 *  - sight glass: the window on its body, the moisture indicator in it;
 *  - flare union: two flare nuts and the body between them.
 *
 * Shapes are in the accessory's own frame (u along the pipe, v across, mm) so
 * the overlay places one transform per accessory. One with no room where it is
 * is drawn dashed in red.
 *
 * PURE.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { ACCESSORY_NAMES, accessoryDrawnRadiusMm, readRefrigerantAccessories, type RefrigerantAccessoryKind } from './refrigerantAccessories';
import { refrigerantLineOf } from './refrigerantPieces';

export type AccessoryGlyphFill = 'body' | 'ink' | 'glass' | 'indicator' | 'none';

export interface AccessoryGlyphShape {
  /** An SVG path in the accessory's frame (mm), or a circle. */
  d?: string;
  circle?: { cx: number; cy: number; r: number };
  fill: AccessoryGlyphFill;
  /** Stroke weight as a multiple of the base line (0 for none). */
  weight: number;
}

export interface AccessoryGlyph {
  id: string;
  kind: RefrigerantAccessoryKind;
  elementId: string;
  lineKind: 'gas' | 'liquid' | 'pair';
  /** Its centre in plan (model mm) and the straight's heading there (deg, plan y down). */
  centre: Point2D;
  angleDeg: number;
  /** The body's length along the pipe (mm). */
  lengthMm: number;
  /** Its scale up from the true body where that would be smaller than the legible minimum. */
  scale: number;
  problem: string | null;
  title: string;
  shapes: AccessoryGlyphShape[];
}

const f = (value: number) => Number(value.toFixed(2));

/** A rectangle with its corners cut (a nut's flats seen side on): u from `u0` to `u1`, v ±`h`. */
function chamfered(u0: number, u1: number, h: number, cut: number): string {
  const c = Math.min(cut, (u1 - u0) / 3, h / 2);
  return `M ${f(u0 + c)} ${f(-h)} L ${f(u1 - c)} ${f(-h)} L ${f(u1)} ${f(-h + c)} L ${f(u1)} ${f(h - c)} L ${f(u1 - c)} ${f(h)} L ${f(u0 + c)} ${f(h)} L ${f(u0)} ${f(h - c)} L ${f(u0)} ${f(-h + c)} Z`;
}

function rounded(u0: number, u1: number, h: number, radius: number): string {
  const r = Math.min(radius, (u1 - u0) / 2, h);
  return `M ${f(u0 + r)} ${f(-h)} H ${f(u1 - r)} A ${f(r)} ${f(r)} 0 0 1 ${f(u1)} ${f(-h + r)} V ${f(h - r)} A ${f(r)} ${f(r)} 0 0 1 ${f(u1 - r)} ${f(h)}`
    + ` H ${f(u0 + r)} A ${f(r)} ${f(r)} 0 0 1 ${f(u0)} ${f(h - r)} V ${f(-h + r)} A ${f(r)} ${f(r)} 0 0 1 ${f(u0 + r)} ${f(-h)} Z`;
}

/** An accessory's symbol, `lengthMm` along the pipe and `halfWidthMm` either side of it. */
export function accessoryGlyphShapes(kind: RefrigerantAccessoryKind, lengthMm: number, halfWidthMm: number): AccessoryGlyphShape[] {
  const a = lengthMm / 2;
  const h = halfWidthMm;
  switch (kind) {
    case 'ball-valve':
      return [
        // The bow-tie, its ball, and the lever on its stem.
        { d: `M ${f(-a)} ${f(-h)} L ${f(-a)} ${f(h)} L ${f(a)} ${f(-h)} L ${f(a)} ${f(h)} Z`, fill: 'body', weight: 1 },
        { circle: { cx: 0, cy: 0, r: f(h * 0.3) }, fill: 'ink', weight: 0 },
        { d: `M 0 ${f(-h * 0.3)} V ${f(-h * 1.35)} M ${f(-a * 0.1)} ${f(-h * 1.35)} H ${f(a * 0.9)}`, fill: 'none', weight: 1.4 },
      ];
    case 'strainer': {
      // The body, and the screen leg slanting off it with its cap.
      const legFrom = { u: -a * 0.2, v: 0 };
      const legTo = { u: a * 0.25, v: h * 1.55 };
      const length = Math.hypot(legTo.u - legFrom.u, legTo.v - legFrom.v) || 1;
      const across = { u: -(legTo.v - legFrom.v) / length, v: (legTo.u - legFrom.u) / length };
      const w = h * 0.38;
      const leg = `M ${f(legFrom.u + across.u * w)} ${f(legFrom.v + across.v * w)} L ${f(legTo.u + across.u * w)} ${f(legTo.v + across.v * w)}`
        + ` L ${f(legTo.u - across.u * w)} ${f(legTo.v - across.v * w)} L ${f(legFrom.u - across.u * w)} ${f(legFrom.v - across.v * w)} Z`;
      const cap = `M ${f(legTo.u + across.u * w * 1.45)} ${f(legTo.v + across.v * w * 1.45)} L ${f(legTo.u - across.u * w * 1.45)} ${f(legTo.v - across.v * w * 1.45)}`;
      return [
        { d: leg, fill: 'body', weight: 1 },
        { d: `M ${f(legFrom.u)} ${f(legFrom.v)} L ${f(legTo.u)} ${f(legTo.v)}`, fill: 'none', weight: 0.6 },
        { d: rounded(-a, a, h * 0.62, h * 0.3), fill: 'body', weight: 1 },
        { d: cap, fill: 'none', weight: 2 },
      ];
    }
    case 'sight-glass':
      // The body, its window, the indicator in the window.
      return [
        { d: rounded(-a, a, h * 0.58, h * 0.28), fill: 'body', weight: 1 },
        { circle: { cx: 0, cy: 0, r: f(Math.min(h * 0.98, a * 0.85)) }, fill: 'glass', weight: 1 },
        { circle: { cx: 0, cy: 0, r: f(Math.min(h, a) * 0.42) }, fill: 'indicator', weight: 0 },
      ];
    default: {
      // Two flare nuts (their flats) and the union body between them.
      const gap = a * 0.14;
      const facets = (u0: number, u1: number) => `M ${f(u0)} ${f(-h * 0.45)} H ${f(u1)} M ${f(u0)} ${f(h * 0.45)} H ${f(u1)}`;
      return [
        { d: rounded(-gap * 1.2, gap * 1.2, h * 0.72, h * 0.1), fill: 'body', weight: 1 },
        { d: chamfered(-a, -gap, h, h * 0.35), fill: 'body', weight: 1 },
        { d: chamfered(gap, a, h, h * 0.35), fill: 'body', weight: 1 },
        { d: `${facets(-a, -gap)} ${facets(gap, a)}`, fill: 'none', weight: 0.6 },
      ];
    }
  }
}

/**
 * A line's accessories as the plan draws them, each at least `minLengthMm` long on the drawing (a symbol scaled up
 * from a body too small to read at the zoom).
 */
export function refrigerantAccessoryGlyphs(element: HvacElement, scene: readonly HvacElement[], minLengthMm = 0): AccessoryGlyph[] {
  if (!readRefrigerantAccessories(element).length) return [];
  const line = refrigerantLineOf(element, scene);
  if (!line) return [];
  return line.accessories.map((placed) => {
    const halfWidth = accessoryDrawnRadiusMm(placed, line.outsideDiameterMm);
    const plan = Math.hypot(placed.direction.x, placed.direction.y);
    const name = ACCESSORY_NAMES[placed.accessory.kind];
    return {
      id: placed.accessory.id,
      kind: placed.accessory.kind,
      elementId: element.id,
      lineKind: line.lineKind,
      centre: { x: placed.centre.x, y: placed.centre.y },
      angleDeg: plan > 1e-6 ? (Math.atan2(placed.direction.y, placed.direction.x) * 180) / Math.PI : 0,
      lengthMm: placed.lengthMm,
      scale: Math.max(1, minLengthMm / Math.max(placed.lengthMm, 1)),
      problem: placed.problem,
      title: `${name} · ${line.lineKind} line Ø${line.tubeOdMm.toFixed(2)} · body ${Math.round(placed.lengthMm)} mm${placed.problem ? ` — ${placed.problem}` : ''}`,
      shapes: accessoryGlyphShapes(placed.accessory.kind, placed.lengthMm, halfWidth),
    };
  });
}
