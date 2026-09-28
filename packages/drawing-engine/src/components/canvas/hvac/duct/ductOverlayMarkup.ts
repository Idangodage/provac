/**
 * SVG markup for duct runs and air ports, in world millimetres. One string
 * builder serves committed runs (memoised per run), the live draft (set
 * imperatively, no React render per pointer move) and later the SVG export.
 * Strokes are non-scaling so line weights stay constant at every zoom.
 */
import type { HvacElement, Point2D } from '../../../../types';

import type { DuctAirPort } from './ductAirPorts';
import type { DuctPlanPresentation } from './ductPlanPresentation';
import type { DuctSupportPlan } from './ductSupports';
import { localTerminalSpigot, type DuctTerminalSpec } from './ductTerminals';

export interface DuctMarkupStyle {
  /** Screen pixels per model millimetre. */
  k: number;
  selected?: boolean;
  draft?: boolean;
  showTags: boolean;
  showJointTicks: boolean;
  showMarks: boolean;
  showSupports?: boolean;
}

const COLORS = {
  supply: { stroke: '#1d4ed8', fill: 'rgba(59,130,246,0.12)' },
  return: { stroke: '#0f766e', fill: 'rgba(20,184,166,0.12)' },
  error: { stroke: '#dc2626', fill: 'rgba(220,38,38,0.10)' },
  warning: '#d97706',
  selected: '#f59e0b',
  flange: '#334155',
  fabric: '#475569',
  support: '#78350f',
  insulation: '#111827',
} as const;

function f(value: number): string {
  return Number.isFinite(value) ? (Math.round(value * 100) / 100).toString() : '0';
}

export function pathData(points: readonly Point2D[], close = false): string {
  if (points.length === 0) return '';
  return `M${points.map((point) => `${f(point.x)} ${f(point.y)}`).join(' L')}${close ? ' Z' : ''}`;
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textMarkup(point: Point2D, text: string, sizeMm: number, color: string, angleDeg = 0, anchor: 'middle' | 'start' = 'middle'): string {
  const rotate = angleDeg ? ` transform="rotate(${f(angleDeg)} ${f(point.x)} ${f(point.y)})"` : '';
  return `<text x="${f(point.x)}" y="${f(point.y)}"${rotate} font-size="${f(sizeMm)}" font-family="system-ui, sans-serif" text-anchor="${anchor}" dominant-baseline="middle" fill="${color}" stroke="#ffffff" stroke-width="${f(sizeMm * 0.28)}" paint-order="stroke" stroke-linejoin="round">${escapeText(text)}</text>`;
}

export function ductRunMarkup(presentation: DuctPlanPresentation, style: DuctMarkupStyle): string {
  const palette = presentation.status === 'error' ? COLORS.error : COLORS[presentation.service];
  const px = (value: number) => value / Math.max(style.k, 1e-6);
  const stroke = style.selected ? COLORS.selected : palette.stroke;
  const outlineWidth = style.selected ? 2.2 : 1.3;
  const dash = presentation.status === 'error' || style.draft ? ` stroke-dasharray="6 4"` : '';
  const parts: string[] = [];
  parts.push(`<g data-duct-run="${escapeText(presentation.id)}"${style.draft ? ' opacity="0.9"' : ''}>`);
  for (const outline of presentation.insulationOutlines) {
    parts.push(`<path d="${pathData(outline, true)}" fill="rgba(17,24,39,0.06)" stroke="${COLORS.insulation}" stroke-width="0.9" stroke-dasharray="5 3" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`);
  }
  for (const piece of presentation.piecePolygons) {
    const fill = piece.kind === 'connector' ? 'rgba(71,85,105,0.18)' : palette.fill;
    parts.push(`<path d="${pathData(piece.polygon, true)}" fill="${fill}" stroke="${stroke}" stroke-width="${outlineWidth}" vector-effect="non-scaling-stroke" stroke-linejoin="round"${dash}/>`);
  }
  for (const hatch of presentation.connectorHatch) {
    parts.push(`<path d="${pathData(hatch)}" fill="none" stroke="${COLORS.fabric}" stroke-width="0.9" vector-effect="non-scaling-stroke"/>`);
  }
  for (const vane of presentation.vanes) {
    const [a, c, b] = vane as [Point2D, Point2D, Point2D];
    parts.push(`<path d="M${f(a.x)} ${f(a.y)} Q${f(c.x)} ${f(c.y)} ${f(b.x)} ${f(b.y)}" fill="none" stroke="${stroke}" stroke-width="0.9" vector-effect="non-scaling-stroke"/>`);
  }
  for (const [a, b] of presentation.boxDiagonals) {
    parts.push(`<path d="${pathData([a, b])}" stroke="${stroke}" stroke-width="0.7" vector-effect="non-scaling-stroke" opacity="0.7"/>`);
  }
  for (const [a, b] of presentation.goreLines) {
    parts.push(`<path d="${pathData([a, b])}" stroke="${stroke}" stroke-width="0.8" vector-effect="non-scaling-stroke"/>`);
  }
  if (style.showJointTicks) {
    for (const tick of presentation.jointTicks) {
      const width = tick.kind === 'unit-connection' ? 1.2 : 2.2;
      parts.push(`<path d="${pathData([tick.a, tick.b])}" stroke="${COLORS.flange}" stroke-width="${width}" vector-effect="non-scaling-stroke" stroke-linecap="square"/>`);
    }
  }
  parts.push(`<path d="${pathData(presentation.centreline)}" fill="none" stroke="${stroke}" stroke-width="0.7" stroke-dasharray="10 4 2 4" vector-effect="non-scaling-stroke" opacity="0.7"/>`);
  for (const riser of presentation.risers) {
    parts.push(`<path d="${pathData(riser.box, true)}" fill="none" stroke="${stroke}" stroke-width="${outlineWidth + 0.4}" vector-effect="non-scaling-stroke"/>`);
    for (const diagonal of riser.diagonals) {
      parts.push(`<path d="${pathData(diagonal)}" stroke="${stroke}" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
    }
    if (style.showTags) parts.push(textMarkup(riser.labelPoint, riser.label, px(11), palette.stroke, 0, 'start'));
  }
  if (style.showMarks) {
    for (const mark of presentation.marks) parts.push(textMarkup(mark.point, mark.text, px(9), '#334155'));
  }
  for (const damper of presentation.dampers) {
    parts.push(`<path d="${pathData(damper.blade)}" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`);
    parts.push(`<circle cx="${f(damper.quadrant.x)}" cy="${f(damper.quadrant.y)}" r="${f(px(4))}" fill="#ffffff" stroke="${stroke}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`);
  }
  if (style.showTags) {
    for (const tag of presentation.tags) parts.push(textMarkup(tag.point, tag.text, px(11), palette.stroke, tag.angleDeg));
  }
  for (const point of presentation.warningPoints) {
    parts.push(`<circle cx="${f(point.x)}" cy="${f(point.y)}" r="${f(px(7))}" fill="none" stroke="${COLORS.warning}" stroke-width="2" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>`);
  }
  for (const point of presentation.errorPoints) {
    parts.push(`<circle cx="${f(point.x)}" cy="${f(point.y)}" r="${f(px(7))}" fill="none" stroke="${COLORS.error.stroke}" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
  }
  parts.push('</g>');
  return parts.join('');
}

/**
 * Supports in plan: each trapeze as its bar across the duct with a dot at
 * each rod, a round band as one rod dot on a short band line, and the riser
 * angles as bars beside the riser.
 */
export function ductSupportMarkup(supports: DuctSupportPlan, k: number): string {
  const px = (value: number) => value / Math.max(k, 1e-6);
  const parts: string[] = [`<g data-duct-supports="${escapeText(supports.elementId)}">`];
  const line = (a: Point2D, b: Point2D, width: number) =>
    `<path d="${pathData([a, b])}" stroke="${COLORS.support}" stroke-width="${width}" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`;
  const dot = (point: Point2D) =>
    `<circle cx="${f(point.x)}" cy="${f(point.y)}" r="${f(px(2.6))}" fill="${COLORS.support}" stroke="#ffffff" stroke-width="0.8" vector-effect="non-scaling-stroke"/>`;
  for (const hanger of supports.hangers) {
    const n = { x: -hanger.direction.y, y: hanger.direction.x };
    const reach = hanger.bar ? hanger.bar.lengthMm / 2 : hanger.outerWidthMm / 2 + 20;
    parts.push(line(
      { x: hanger.point.x + n.x * reach, y: hanger.point.y + n.y * reach },
      { x: hanger.point.x - n.x * reach, y: hanger.point.y - n.y * reach },
      hanger.bar ? 1.6 : 1,
    ));
    for (const rod of hanger.rods) parts.push(dot(rod.point));
  }
  for (const riser of supports.risers) {
    const h = riser.heading;
    const n = { x: -h.y, y: h.x };
    for (const side of [1, -1]) {
      const centre = { x: riser.point.x + h.x * side * (riser.outerHeightMm / 2 + 20), y: riser.point.y + h.y * side * (riser.outerHeightMm / 2 + 20) };
      parts.push(line(
        { x: centre.x + n.x * riser.lengthMm / 2, y: centre.y + n.y * riser.lengthMm / 2 },
        { x: centre.x - n.x * riser.lengthMm / 2, y: centre.y - n.y * riser.lengthMm / 2 },
        2,
      ));
    }
  }
  parts.push('</g>');
  return parts.join('');
}

const TERMINAL_TAG: Record<DuctTerminalSpec['kind'], string> = {
  'square-4way': 'SD', round: 'RD', 'linear-slot': 'LSD', 'return-egg-crate': 'RG',
};

/**
 * An air terminal as a ceiling plan shows it: the face with its pattern (the
 * 4-way throw, rings, slots or the egg-crate grid), its spigot above the
 * ceiling (dashed) and a tag such as "SD 595 · Ø200". The plan's 3D top view
 * sees only the plenum box, so the symbol is drawn here, over it.
 */
export function airTerminalMarkup(
  element: Pick<HvacElement, 'id' | 'position' | 'width' | 'depth' | 'rotation'>,
  spec: DuctTerminalSpec,
  k: number,
  showTags: boolean,
): string {
  const px = (value: number) => value / Math.max(k, 1e-6);
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const angle = ((element.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (x: number, y: number): Point2D => ({ x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos });
  const rect = (halfX: number, halfY: number): Point2D[] => [at(-halfX, -halfY), at(halfX, -halfY), at(halfX, halfY), at(-halfX, halfY)];
  const color = spec.service === 'return' ? COLORS.return : COLORS.supply;
  const hw = spec.faceWidthMm / 2;
  const hd = spec.faceDepthMm / 2;
  const line = (a: Point2D, b: Point2D, width = 0.9) => `<path d="${pathData([a, b])}" stroke="${color.stroke}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>`;
  const outline = (points: Point2D[], width = 0.9, fill = 'none') => `<path d="${pathData(points, true)}" fill="${fill}" stroke="${color.stroke}" stroke-width="${width}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  const circle = (radius: number, width = 0.9, fill = 'none') => `<circle cx="${f(centre.x)}" cy="${f(centre.y)}" r="${f(radius)}" fill="${fill}" stroke="${color.stroke}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>`;
  const parts: string[] = [`<g data-duct-terminal="${escapeText(element.id)}">`];
  const face = 'rgba(255,255,255,0.82)';
  if (spec.kind === 'round') {
    parts.push(circle(hw, 1.3, face), circle(hw * 0.66), circle(hw * 0.36));
  } else {
    parts.push(outline(rect(hw, hd), 1.3, face));
    if (spec.kind === 'square-4way') {
      const neck = Math.min(hw, hd) * 0.34;
      parts.push(outline(rect(hw * 0.78, hd * 0.78)), outline(rect(neck, neck)));
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) parts.push(line(at(sx * neck, sy * neck), at(sx * hw, sy * hd), 0.8));
    } else if (spec.kind === 'linear-slot') {
      const slots = spec.slots ?? 2;
      for (let index = 0; index < slots; index += 1) {
        const y = -hd + 25 + 20 * (index + 0.5);
        parts.push(line(at(-hw + 15, y), at(hw - 15, y), 1.4));
      }
    } else {
      for (let index = 1; index < 5; index += 1) {
        const x = -hw + (2 * hw * index) / 5;
        const y = -hd + (2 * hd * index) / 5;
        parts.push(line(at(x, -hd), at(x, hd), 0.6), line(at(-hw, y), at(hw, y), 0.6));
      }
    }
  }
  // The spigot, above the ceiling: dashed from the plenum box to its lip.
  const spigot = localTerminalSpigot(spec);
  const r = spec.neckDiameterMm / 2;
  const from = Math.abs(spigot.normal.x) > 0.5 ? spec.plenumWidthMm / 2 : spec.plenumDepthMm / 2;
  const to = from + spec.spigotLengthMm;
  const side = (distance: number, across: number) => at(spigot.normal.x * distance - spigot.normal.y * across, spigot.normal.y * distance + spigot.normal.x * across);
  parts.push(`<path d="${pathData([side(from, r), side(to, r), side(to, -r), side(from, -r)], true)}" fill="none" stroke="${color.stroke}" stroke-width="0.9" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`);
  if (showTags) {
    const size = spec.kind === 'round' ? `Ø${Math.round(spec.faceWidthMm)}`
      : spec.kind === 'linear-slot' ? `${Math.round(spec.faceWidthMm)}×${spec.slots ?? 2} slots` : `${Math.round(spec.faceWidthMm)}`;
    const reach = Math.max(hw, hd);
    parts.push(textMarkup({ x: centre.x, y: centre.y + reach + px(12) }, `${TERMINAL_TAG[spec.kind]} ${size} · Ø${Math.round(spec.neckDiameterMm)}`, px(11), color.stroke));
  }
  parts.push('</g>');
  return parts.join('');
}

/** Collar and terminal-spigot markers shown while the duct tool is active. */
export function airPortMarkup(ports: readonly DuctAirPort[], k: number, hoveredKey: string | null, occupiedKeys: ReadonlySet<string>): string {
  const px = (value: number) => value / Math.max(k, 1e-6);
  return ports.map((port) => {
    const key = `${port.unitId}:${port.portId}`;
    const hovered = key === hoveredKey;
    const occupied = occupiedKeys.has(key);
    const color = port.kind === 'supply' ? COLORS.supply.stroke : COLORS.return.stroke;
    const width = hovered ? 6 : 3.5;
    const out = { x: port.lip.x + port.normal.x * px(18), y: port.lip.y + port.normal.y * px(18) };
    const size = port.diameterMm !== undefined ? `spigot Ø${Math.round(port.diameterMm)}` : `${port.widthMm}×${port.heightMm}`;
    const label = `${port.kind === 'supply' ? 'SUPPLY' : 'RETURN'} ${size}${port.source === 'procedural' ? ' (approx.)' : ''}${occupied ? ' · connected' : ''}`;
    return [
      `<path d="${pathData([port.edgeA, port.edgeB])}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity="${occupied && !hovered ? 0.45 : 1}"/>`,
      hovered ? textMarkup(out, label, px(11), color) : '',
    ].join('');
  }).join('');
}

/** Where a click would start a branch: the wall a take-off opens, or the split side. */
export function branchTargetMarkup(target: { kind: 'tap' | 'split' | 'spigot'; marker: readonly [Point2D, Point2D]; label: string }, k: number): string {
  const px = (value: number) => value / Math.max(k, 1e-6);
  const [a, b] = target.marker;
  return [
    `<path d="${pathData([a, b])}" stroke="${COLORS.selected}" stroke-width="6" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity="0.9"/>`,
    `<circle cx="${f(b.x)}" cy="${f(b.y)}" r="${f(px(5))}" fill="#ffffff" stroke="${COLORS.selected}" stroke-width="2" vector-effect="non-scaling-stroke"/>`,
    textMarkup({ x: b.x + px(12), y: b.y - px(12) }, target.label, px(11), '#92400e', 0, 'start'),
  ].join('');
}

/** Live length label next to the leg being drawn. */
export function draftLabelMarkup(point: Point2D, text: string, k: number): string {
  const px = (value: number) => value / Math.max(k, 1e-6);
  return textMarkup({ x: point.x + px(14), y: point.y - px(14) }, text, px(11), '#0f172a', 0, 'start');
}
