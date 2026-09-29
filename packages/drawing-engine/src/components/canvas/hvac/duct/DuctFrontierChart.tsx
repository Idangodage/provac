'use client';

/**
 * The cost–pressure frontier of the verified designs: first cost against the
 * external static pressure each needs. The dashed line is the fan's maximum;
 * the sloping line is the least life-cycle cost — every point on it costs the
 * same over the life (first cost + the energy its pressure takes), so designs
 * below it would be better and none is. Click a point to preview it.
 */
import type { AutoDuctDesign } from './ductAutoLayout';
import { formatCost } from './ductEconomics';

export interface DuctFrontierChartProps {
  designs: readonly AutoDuctDesign[];
  picks: { cheapest: number; lifeCycle: number; quietest: number };
  selected: number;
  maxEspPa: number | null;
  pricePerPa: number;
  currency: string;
  onSelect: (index: number) => void;
}

const WIDTH = 260;
const HEIGHT = 128;
const PAD = { left: 38, right: 8, top: 8, bottom: 22 };

export function DuctFrontierChart({ designs, picks, selected, maxEspPa, pricePerPa, currency, onSelect }: DuctFrontierChartProps) {
  if (!designs.length) return null;
  const esps = designs.map((design) => design.requiredEspPa);
  const costs = designs.map((design) => design.firstCost);
  const xMax = Math.max(maxEspPa ?? 0, ...esps) * 1.08 || 1;
  const xMin = Math.max(0, Math.min(...esps) * 0.8);
  const yMin = Math.min(...costs) * 0.96;
  const yMax = Math.max(...costs) * 1.04 || 1;
  const x = (pa: number) => PAD.left + ((pa - xMin) / (xMax - xMin || 1)) * (WIDTH - PAD.left - PAD.right);
  const y = (cost: number) => HEIGHT - PAD.bottom - ((cost - yMin) / (yMax - yMin || 1)) * (HEIGHT - PAD.top - PAD.bottom);
  const best = designs[picks.lifeCycle]!;
  // Iso life-cycle line: cost = LCC* − E·p.
  const iso = (pa: number) => best.lifeCycleCost - pricePerPa * pa;
  const isoFrom = { x: xMin, y: iso(xMin) };
  const isoTo = { x: xMax, y: iso(xMax) };
  const role = (index: number) => (index === picks.lifeCycle ? 'life' : index === picks.cheapest ? 'cheap' : index === picks.quietest ? 'quiet' : 'other');
  const fill: Record<string, string> = { life: '#0f766e', cheap: '#b45309', quiet: '#0369a1', other: '#94a3b8' };
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full select-none" role="img" data-testid="duct-frontier"
      aria-label={`Cost against fan pressure for ${designs.length} verified design${designs.length === 1 ? '' : 's'}`}>
      <rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} fill="#f8fafc" stroke="#e2e8f0" />
      <clipPath id="duct-frontier-clip"><rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} /></clipPath>
      <g clipPath="url(#duct-frontier-clip)">
        <line x1={x(isoFrom.x)} y1={y(isoFrom.y)} x2={x(isoTo.x)} y2={y(isoTo.y)} stroke="#14b8a6" strokeDasharray="1 3" strokeWidth={1.2} />
        {maxEspPa !== null ? (
          <line x1={x(maxEspPa)} y1={PAD.top} x2={x(maxEspPa)} y2={HEIGHT - PAD.bottom} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
        ) : null}
      </g>
      {maxEspPa !== null && x(maxEspPa) < WIDTH - PAD.right ? (
        <text x={x(maxEspPa) - 2} y={PAD.top + 8} textAnchor="end" fontSize={7} fill="#ef4444">fan max {maxEspPa} Pa</text>
      ) : null}
      {/* Axes */}
      <text x={PAD.left} y={HEIGHT - 6} fontSize={7} fill="#64748b">{Math.round(xMin)}</text>
      <text x={WIDTH - PAD.right} y={HEIGHT - 6} fontSize={7} fill="#64748b" textAnchor="end">{Math.round(xMax)} Pa</text>
      <text x={(PAD.left + WIDTH - PAD.right) / 2} y={HEIGHT - 6} fontSize={7} fill="#64748b" textAnchor="middle">external static pressure</text>
      <text x={PAD.left - 3} y={PAD.top + 6} fontSize={7} fill="#64748b" textAnchor="end">{Math.round(yMax)}</text>
      <text x={PAD.left - 3} y={HEIGHT - PAD.bottom} fontSize={7} fill="#64748b" textAnchor="end">{Math.round(yMin)}</text>
      <text x={8} y={(PAD.top + HEIGHT - PAD.bottom) / 2} fontSize={7} fill="#64748b" textAnchor="middle" transform={`rotate(-90 8 ${(PAD.top + HEIGHT - PAD.bottom) / 2})`}>{currency}</text>
      {designs.map((design, index) => {
        const cx = x(design.requiredEspPa);
        const cy = y(design.firstCost);
        const kind = role(index);
        const reference = design.label.includes('(equal friction)');
        const label = `${reference ? 'Equal friction (reference)' : design.label}: ${formatCost(design.firstCost, currency)}, ${design.requiredEspPa.toFixed(1)} Pa, life-cycle ${formatCost(design.lifeCycleCost, currency)}${design.errors ? `, ${design.errors} issue(s)` : ''}`;
        return (
          <g key={design.key} role="button" tabIndex={0} aria-label={label} aria-pressed={index === selected} className="cursor-pointer outline-none"
            onClick={() => onSelect(index)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(index); } }}>
            <title>{label}</title>
            {index === selected ? <circle cx={cx} cy={cy} r={6.5} fill="none" stroke="#0f172a" strokeWidth={1} /> : null}
            {reference ? (
              <path d={`M${cx - 3.5} ${cy - 3.5} L${cx + 3.5} ${cy + 3.5} M${cx + 3.5} ${cy - 3.5} L${cx - 3.5} ${cy + 3.5}`} stroke="#64748b" strokeWidth={1.6} />
            ) : kind === 'life' ? (
              <path d={starPath(cx, cy, 5, 2.2)} fill={fill.life} />
            ) : kind === 'quiet' ? (
              <path d={`M${cx} ${cy - 4.2} L${cx + 4.2} ${cy} L${cx} ${cy + 4.2} L${cx - 4.2} ${cy} Z`} fill={fill.quiet} />
            ) : (
              <circle cx={cx} cy={cy} r={kind === 'cheap' ? 3.8 : 2.6} fill={fill[kind]} opacity={design.errors ? 0.45 : 1} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function starPath(cx: number, cy: number, outer: number, inner: number): string {
  const points: string[] = [];
  for (let k = 0; k < 10; k += 1) {
    const radius = k % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (k * Math.PI) / 5;
    points.push(`${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
}
