/**
 * SVG markup for duct runs and air ports, in world millimetres. One string
 * builder serves committed runs (memoised per run), the live draft (set
 * imperatively, no React render per pointer move) and later the SVG export.
 * Strokes are non-scaling so line weights stay constant at every zoom.
 */
import type { Point2D } from '../../../../types';

import type { DuctAirPort } from './ductAirPorts';
import type { DuctPlanPresentation } from './ductPlanPresentation';

export interface DuctMarkupStyle {
  /** Screen pixels per model millimetre. */
  k: number;
  selected?: boolean;
  draft?: boolean;
  showTags: boolean;
  showJointTicks: boolean;
  showMarks: boolean;
}

const COLORS = {
  supply: { stroke: '#1d4ed8', fill: 'rgba(59,130,246,0.12)' },
  return: { stroke: '#0f766e', fill: 'rgba(20,184,166,0.12)' },
  error: { stroke: '#dc2626', fill: 'rgba(220,38,38,0.10)' },
  selected: '#f59e0b',
  flange: '#334155',
  fabric: '#475569',
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
  if (style.showJointTicks) {
    for (const tick of presentation.jointTicks) {
      const width = tick.kind === 'unit-connection' ? 1.2 : 2.2;
      parts.push(`<path d="${pathData([tick.a, tick.b])}" stroke="${COLORS.flange}" stroke-width="${width}" vector-effect="non-scaling-stroke" stroke-linecap="square"/>`);
    }
  }
  parts.push(`<path d="${pathData(presentation.centreline)}" fill="none" stroke="${stroke}" stroke-width="0.7" stroke-dasharray="10 4 2 4" vector-effect="non-scaling-stroke" opacity="0.7"/>`);
  if (style.showMarks) {
    for (const mark of presentation.marks) parts.push(textMarkup(mark.point, mark.text, px(9), '#334155'));
  }
  if (style.showTags && presentation.tag) {
    parts.push(textMarkup(presentation.tag.point, presentation.tag.text, px(11), palette.stroke, presentation.tag.angleDeg));
  }
  for (const point of presentation.errorPoints) {
    parts.push(`<circle cx="${f(point.x)}" cy="${f(point.y)}" r="${f(px(7))}" fill="none" stroke="${COLORS.error.stroke}" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
  }
  parts.push('</g>');
  return parts.join('');
}

/** Collar markers shown while the duct tool is active. */
export function airPortMarkup(ports: readonly DuctAirPort[], k: number, hoveredKey: string | null, occupiedKeys: ReadonlySet<string>): string {
  const px = (value: number) => value / Math.max(k, 1e-6);
  return ports.map((port) => {
    const key = `${port.unitId}:${port.portId}`;
    const hovered = key === hoveredKey;
    const occupied = occupiedKeys.has(key);
    const color = port.kind === 'supply' ? COLORS.supply.stroke : COLORS.return.stroke;
    const width = hovered ? 6 : 3.5;
    const out = { x: port.lip.x + port.normal.x * px(18), y: port.lip.y + port.normal.y * px(18) };
    const label = `${port.kind === 'supply' ? 'SUPPLY' : 'RETURN'} ${port.widthMm}×${port.heightMm}${port.source === 'procedural' ? ' (approx.)' : ''}${occupied ? ' · connected' : ''}`;
    return [
      `<path d="${pathData([port.edgeA, port.edgeB])}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" vector-effect="non-scaling-stroke" opacity="${occupied && !hovered ? 0.45 : 1}"/>`,
      hovered ? textMarkup(out, label, px(11), color) : '',
    ].join('');
  }).join('');
}

/** Live length label next to the leg being drawn. */
export function draftLabelMarkup(point: Point2D, text: string, k: number): string {
  const px = (value: number) => value / Math.max(k, 1e-6);
  return textMarkup({ x: point.x + px(14), y: point.y - px(14) }, text, px(11), '#0f172a', 0, 'start');
}
