'use client';

/**
 * Shared SVG glyphs of the condensate plan: the insulated tube with flow
 * arrows and riser / drop marks, fitting symbols and tags (model millimetres;
 * `hpx` converts screen pixels to millimetres at the current zoom).
 */
import type { Point2D } from '../../../../types';

import { condensateFlowArrows, type CondensatePlanPresentation } from './condensatePlanPresentation';
import type { CondensateFitting } from './condensateTypes';

export const TUBE = {
  edge: '#0c4a6e',
  insulation: '#7dd3fc',
  sheen: '#e0f2fe',
  selected: '#0ea5e9',
  text: '#0c4a6e',
  tagFill: '#f0f9ff',
  tagStroke: '#7dd3fc',
};

export function pathData(points: readonly Point2D[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ');
}

export function Tag({ x, y, text, hpx, angle = 0, tone = 'info' }: {
  x: number; y: number; text: string; hpx: (n: number) => number; angle?: number; tone?: 'info' | 'ok' | 'warn' | 'bad' | 'pump';
}) {
  const palette = {
    info: { fill: TUBE.tagFill, stroke: TUBE.tagStroke, text: TUBE.text },
    ok: { fill: '#f0fdf4', stroke: '#86efac', text: '#166534' },
    warn: { fill: '#fefce8', stroke: '#fde047', text: '#854d0e' },
    bad: { fill: '#fef2f2', stroke: '#fca5a5', text: '#991b1b' },
    pump: { fill: '#eef2ff', stroke: '#a5b4fc', text: '#3730a3' },
  }[tone];
  const width = hpx(text.length * 5.9 + 12);
  const height = hpx(17);
  return (
    <g transform={`translate(${x} ${y}) rotate(${angle})`}>
      <rect x={-width / 2} y={-height / 2} width={width} height={height} rx={hpx(4)} fill={palette.fill} stroke={palette.stroke} strokeWidth={hpx(1)} />
      <text x={0} y={hpx(4)} textAnchor="middle" fontSize={hpx(10.5)} fontFamily="system-ui, sans-serif" fill={palette.text}>{text}</text>
    </g>
  );
}

export function FittingGlyph({ fitting, hpx }: { fitting: CondensateFitting; hpx: (n: number) => number }) {
  const { x, y } = fitting.point;
  const axis = fitting.axis ?? { x: 1, y: 0, z: 0 };
  const planAxisLength = Math.hypot(axis.x, axis.y);
  const angle = planAxisLength > 1e-6 ? (Math.atan2(axis.y, axis.x) * 180) / Math.PI : 0;
  const s = hpx(1);
  const stroke = TUBE.edge;
  switch (fitting.kind) {
    case 'wye':
      return (
        <g transform={`translate(${x} ${y}) rotate(${angle})`}>
          <circle r={6 * s} fill="#fff" stroke={stroke} strokeWidth={1.2 * s} />
          <path d={`M${-4 * s} ${-3 * s} L0 0 L${-4 * s} ${3 * s} M0 0 L${5 * s} 0`} fill="none" stroke={stroke} strokeWidth={1.3 * s} />
        </g>
      );
    case 'cleanout':
      return (
        <g transform={`translate(${x} ${y})`}>
          <circle r={6.5 * s} fill="#fff" stroke={stroke} strokeWidth={1.3 * s} />
          <text y={3 * s} textAnchor="middle" fontSize={7 * s} fontFamily="system-ui, sans-serif" fill={stroke}>CO</text>
        </g>
      );
    case 'air-vent':
      return (
        <g transform={`translate(${x + 9 * s} ${y - 9 * s})`}>
          <circle r={5.5 * s} fill="#fff" stroke="#4338ca" strokeWidth={1.2 * s} />
          <text y={2.6 * s} textAnchor="middle" fontSize={6 * s} fontFamily="system-ui, sans-serif" fill="#4338ca">AV</text>
        </g>
      );
    case 'p-trap':
      return (
        <g transform={`translate(${x} ${y}) rotate(${angle})`}>
          <path d={`M${-5 * s} ${-5 * s} L${-5 * s} ${2 * s} Q${-5 * s} ${7 * s} 0 ${7 * s} Q${5 * s} ${7 * s} ${5 * s} ${2 * s} L${5 * s} ${-5 * s}`} fill="none" stroke="#9a3412" strokeWidth={1.6 * s} />
        </g>
      );
    case 'tundish':
      return (
        <g transform={`translate(${x} ${y})`}>
          <path d={`M${-8 * s} ${-6 * s} L${8 * s} ${-6 * s} L0 ${7 * s} Z`} fill="#fff" stroke={stroke} strokeWidth={1.3 * s} />
        </g>
      );
    case 'hepvo':
      return <rect x={x - 5 * s} y={y - 5 * s} width={10 * s} height={10 * s} fill="#1f2937" stroke="#fff" strokeWidth={s} />;
    case 'wall-sleeve':
      return (
        <g transform={`translate(${x} ${y}) rotate(${angle})`}>
          <path d={`M${-4 * s} ${-9 * s} L${-4 * s} ${9 * s} M${4 * s} ${-9 * s} L${4 * s} ${9 * s}`} stroke="#475569" strokeWidth={1.6 * s} />
        </g>
      );
    case 'terminal-outlet':
      return (
        <g transform={`translate(${x} ${y}) rotate(${angle})`}>
          <path d={`M0 0 L${10 * s} 0 M${6 * s} ${-4 * s} L${10 * s} 0 L${6 * s} ${4 * s}`} fill="none" stroke={stroke} strokeWidth={1.5 * s} />
        </g>
      );
    default:
      return null;
  }
}

export function PipeTube({ view, hpx, k, selected, colorFor, opacity = 1, showArrows, dashed = false }: {
  view: CondensatePlanPresentation;
  hpx: (n: number) => number;
  k: number;
  selected: boolean;
  colorFor?: (run: { a: Point2D }) => string;
  opacity?: number;
  showArrows: boolean;
  dashed?: boolean;
}) {
  const width = Math.max(view.insulatedDiameterMm, hpx(3));
  const arrows = showArrows ? condensateFlowArrows(view.runs, Math.max(600, hpx(140)), hpx(60)) : [];
  return (
    <g opacity={opacity}>
      {selected ? <path d={pathData(view.path)} fill="none" stroke={TUBE.selected} strokeOpacity={0.35} strokeWidth={width + hpx(9)} strokeLinecap="round" strokeLinejoin="round" /> : null}
      <path d={pathData(view.path)} fill="none" stroke={TUBE.edge} strokeWidth={width + hpx(1.4)} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dashed ? `${hpx(10)} ${hpx(6)}` : undefined} />
      {colorFor
        ? view.runs.map((run, index) => (
          <path key={index} d={pathData([run.a, run.b])} fill="none" stroke={colorFor(run)} strokeWidth={width} strokeLinecap="round" />
        ))
        : <path d={pathData(view.path)} fill="none" stroke={TUBE.insulation} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />}
      {k > 0.08 ? <path d={pathData(view.path)} fill="none" stroke={TUBE.sheen} strokeOpacity={0.75} strokeWidth={width * 0.28} strokeLinecap="round" strokeLinejoin="round" /> : null}
      {arrows.map((arrow, index) => (
        <path key={index} transform={`translate(${arrow.point.x} ${arrow.point.y}) rotate(${arrow.angleDeg})`}
          d={`M${-hpx(4)} ${-hpx(4)} L${hpx(2)} 0 L${-hpx(4)} ${hpx(4)}`} fill="none" stroke={TUBE.edge} strokeWidth={hpx(1.5)} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {view.verticals.map((mark, index) => (
        <g key={`v${index}`} transform={`translate(${mark.point.x} ${mark.point.y})`}>
          <circle r={Math.max(width / 2 + hpx(2), hpx(6))} fill="#fff" stroke={TUBE.edge} strokeWidth={hpx(1.4)} />
          {mark.direction === 'down'
            ? <path d={`M${-hpx(4)} ${-hpx(4)} L${hpx(4)} ${hpx(4)} M${hpx(4)} ${-hpx(4)} L${-hpx(4)} ${hpx(4)}`} stroke={TUBE.edge} strokeWidth={hpx(1.3)} />
            : <circle r={hpx(2.2)} fill={TUBE.edge} />}
        </g>
      ))}
    </g>
  );
}
