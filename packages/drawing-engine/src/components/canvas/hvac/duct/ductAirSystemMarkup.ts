/**
 * Air systems on the plan (SVG, world millimetres, non-scaling strokes):
 *  - a ring in the system's colour round every terminal of a system in focus;
 *  - a tether from the unit's collar of the terminal's service to each member
 *    not yet connected by its duct (dashed; an arrowhead shows the air going
 *    out for supply, back for return); red where the duct comes from another
 *    unit;
 *  - the system tag on the unit;
 *  - while a system is in focus, a dashed grey ring on every terminal in no
 *    system, so what can still be assigned shows;
 *  - in pick mode, the hovered terminal and what a click will do.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { airSystemMembers, type AirSystemMember, type AirSystemsAnalysis } from './ductAirSystems';
import { footprintCorners } from './ductAutoContext';
import { pathData } from './ductOverlayMarkup';
import { readDuctTerminalSpec } from './ductTerminals';

export interface AirSystemMarkupOptions {
  /** Screen pixels per model millimetre. */
  k: number;
  /** Systems drawn in full (tethers, tags); `showAll` draws every system. */
  focusUnitIds: ReadonlySet<string>;
  showAll: boolean;
  showTags: boolean;
  /** Pick mode: the unit clicks assign to, and the terminal under the cursor. */
  pickUnitId?: string | null;
  hoverTerminalId?: string | null;
}

const MISMATCH = '#dc2626';
const UNASSIGNED = '#94a3b8';

function f(value: number): string {
  return Number.isFinite(value) ? (Math.round(value * 100) / 100).toString() : '0';
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function centreOf(element: Pick<HvacElement, 'position' | 'width' | 'depth'>): Point2D {
  return { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
}

/** The face outline grown by `pad` (its corners pushed out from the centre). */
function grownOutline(element: HvacElement, pad: number): Point2D[] {
  const centre = centreOf(element);
  return footprintCorners(element).map((corner) => {
    const dx = corner.x - centre.x;
    const dy = corner.y - centre.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: corner.x + (dx / length) * pad * Math.SQRT2, y: corner.y + (dy / length) * pad * Math.SQRT2 };
  });
}

function label(point: Point2D, text: string, size: number, color: string, anchor: 'middle' | 'start' = 'middle'): string {
  return `<text x="${f(point.x)}" y="${f(point.y)}" font-size="${f(size)}" font-family="system-ui, sans-serif" font-weight="600" text-anchor="${anchor}" dominant-baseline="middle" fill="${color}" stroke="#ffffff" stroke-width="${f(size * 0.3)}" paint-order="stroke" stroke-linejoin="round">${escapeText(text)}</text>`;
}

function arrowhead(from: Point2D, to: Point2D, size: number, color: string): string {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const d = { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
  const n = { x: -d.y, y: d.x };
  const tip = { x: mid.x + d.x * size, y: mid.y + d.y * size };
  const a = { x: mid.x - d.x * size + n.x * size * 0.7, y: mid.y - d.y * size + n.y * size * 0.7 };
  const b = { x: mid.x - d.x * size - n.x * size * 0.7, y: mid.y - d.y * size - n.y * size * 0.7 };
  return `<path d="${pathData([tip, a, b], true)}" fill="${color}" stroke="none"/>`;
}

function memberTether(member: AirSystemMember, collar: Point2D | null, unitCentre: Point2D, color: string, px: (value: number) => number): string {
  const terminal = centreOf(member.terminal);
  const start = collar ?? unitCentre;
  const stroke = member.mismatch || !collar ? MISMATCH : color;
  // Air leaves the unit for supply and comes back for return.
  const [from, to] = member.spec.service === 'supply' ? [start, terminal] : [terminal, start];
  return [
    `<path d="${pathData([start, terminal])}" fill="none" stroke="${stroke}" stroke-width="1.4"${member.mismatch ? '' : ' stroke-dasharray="7 5"'} vector-effect="non-scaling-stroke" stroke-linecap="round" opacity="0.9" data-air-system-tether="${escapeText(member.terminal.id)}"/>`,
    arrowhead(from, to, px(6), stroke),
  ].join('');
}

/** The air-system layer's markup. */
export function airSystemMarkup(analysis: AirSystemsAnalysis, options: AirSystemMarkupOptions): string {
  const px = (value: number) => value / Math.max(options.k, 1e-6);
  const parts: string[] = ['<g data-air-systems="1">'];
  const focused = (unitId: string) => options.showAll || options.focusUnitIds.has(unitId) || options.pickUnitId === unitId;
  let anyFocus = Boolean(options.pickUnitId);
  for (const system of analysis.systems) {
    if (!focused(system.unit.id)) continue;
    anyFocus = true;
    const unitCentre = centreOf(system.unit);
    for (const member of airSystemMembers(system)) {
      const collar = (member.spec.service === 'supply' ? system.supply.collar : system.return.collar)?.lip ?? null;
      const connected = Boolean(member.connection) && !member.mismatch && !member.serviceMismatch;
      if (!connected) parts.push(memberTether(member, collar ? { x: collar.x, y: collar.y } : null, unitCentre, system.color, px));
      parts.push(`<path d="${pathData(grownOutline(member.terminal, px(5)), true)}" fill="none" stroke="${member.mismatch ? MISMATCH : system.color}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" data-air-system-member="${escapeText(member.terminal.id)}"/>`);
      if (options.showTags) {
        const corner = grownOutline(member.terminal, px(5)).reduce((best, point) => (point.y < best.y || (point.y === best.y && point.x > best.x) ? point : best));
        parts.push(label({ x: corner.x + px(3), y: corner.y - px(7) }, system.tag, px(10), system.color, 'start'));
      }
    }
    // The system tag above its unit (the unit's centre carries the design-check badges): a pill in the system's colour.
    const text = system.tag;
    const width = px(10 + text.length * 7.2);
    const height = px(18);
    const top = Math.min(...footprintCorners(system.unit).map((corner) => corner.y));
    const pill = { x: unitCentre.x, y: top - height / 2 - px(6) };
    parts.push(`<rect x="${f(pill.x - width / 2)}" y="${f(pill.y - height / 2)}" width="${f(width)}" height="${f(height)}" rx="${f(height / 2)}" fill="${system.color}" stroke="#ffffff" stroke-width="1.5" vector-effect="non-scaling-stroke" data-air-system-tag="${escapeText(system.unit.id)}"/>`);
    parts.push(`<text x="${f(pill.x)}" y="${f(pill.y)}" font-size="${f(px(11))}" font-family="system-ui, sans-serif" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="#ffffff">${escapeText(text)}</text>`);
  }
  if (anyFocus) {
    for (const terminal of analysis.unassigned) {
      parts.push(`<path d="${pathData(grownOutline(terminal, px(5)), true)}" fill="none" stroke="${UNASSIGNED}" stroke-width="1.4" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" data-air-system-unassigned="${escapeText(terminal.id)}"/>`);
    }
  }
  // Pick mode: what a click on the hovered terminal does.
  if (options.pickUnitId && options.hoverTerminalId) {
    const target = analysis.byUnit.get(options.pickUnitId);
    const entry = analysis.byTerminal.get(options.hoverTerminalId);
    const terminal = entry?.member?.terminal ?? analysis.unassigned.find((element) => element.id === options.hoverTerminalId);
    if (target && terminal) {
      const spec = readDuctTerminalSpec(terminal);
      const tag = entry?.member?.tag ?? (spec ? terminal.label : terminal.id);
      const from = entry?.unitId && entry.unitId !== target.unit.id ? analysis.byUnit.get(entry.unitId)?.tag : null;
      const assignedHere = entry?.unitId === target.unit.id && entry.member?.source !== 'connected';
      const text = assignedHere ? `Remove ${tag} from ${target.tag}` : from ? `Move ${tag} from ${from} to ${target.tag}` : `Add ${tag} to ${target.tag}`;
      parts.push(`<path d="${pathData(grownOutline(terminal, px(8)), true)}" fill="${target.color}" fill-opacity="0.08" stroke="${target.color}" stroke-width="3" vector-effect="non-scaling-stroke"/>`);
      const top = grownOutline(terminal, px(8)).reduce((best, point) => (point.y < best.y ? point : best));
      parts.push(label({ x: centreOf(terminal).x, y: top.y - px(14) }, text, px(12), target.color));
    }
  }
  parts.push('</g>');
  return parts.join('');
}
