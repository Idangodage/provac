'use client';

/**
 * The friction chart of a duct system (ASHRAE Fundamentals ch. 21, Fig. 10
 * style): airflow against friction rate on log scales, with lines of equal
 * round-duct diameter (solid) and equal velocity (dashed) worked from the
 * same Darcy–Weisbach figures the sizing uses; the usual design range
 * shaded, the design rate R as a line, and a dot per stretch of the network
 * at its own friction and airflow — constant friction puts them on R or to
 * its left, held there by a velocity limit or a size rule. A dot and its
 * network row point at each other, and at the stretch on the plan. Under it,
 * the main step by step: Q, V₀, Ø, R.
 */
import { useId, useMemo } from 'react';

import { useDuctNetworkFocusStore } from '../duct/ductNetworkFocusStore';
import type { DuctNetworkRow } from '../duct/ductNetworkTree';
import { figureStatus } from '../duct/ductSegmentFigures';
import { frictionPaPerM } from '../duct/ductSizing';
import { DUCT_SECTION_SET_BY_LABELS, diameterAtVelocityMm, frictionAtVelocity, type DuctSystemSizingReport } from '../duct/ductSystemSizing';
import { roundLeg } from '../duct/ductTypes';
import { useHvacUnits } from '../units/useHvacUnits';

import { focusOfRow } from './NetworkTree';

const W = 290;
const H = 196;
const X0 = 34;
const X1 = 280;
const Y0 = 10;
const Y1 = 170;
/** The friction axis (Pa/m): both systems' ticks fall inside it. */
const R_MIN = 0.1;
const R_MAX = 4.2;

const AXES = {
  si: { rTicks: [0.1, 0.2, 0.5, 1, 2, 4], band: [0.6, 1.0], diameters: [150, 200, 300, 400, 500, 630, 800, 1000], velocities: [2, 3, 4, 6, 8, 10] },
  ip: { rTicks: [0.02, 0.05, 0.1, 0.2, 0.5], band: [0.075, 0.125], diameters: [6, 8, 12, 16, 20, 24, 30, 36], velocities: [400, 600, 800, 1200, 1600, 2000] },
} as const;

const SERIES_125 = [1, 2, 5];

/** Ticks of the 1–2–5 series between `lo` and `hi`. */
function ticks125(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let decade = Math.floor(Math.log10(lo)) - 1; decade <= Math.ceil(Math.log10(hi)); decade += 1) {
    for (const step of SERIES_125) {
      const value = step * 10 ** decade;
      if (value >= lo * 0.999 && value <= hi * 1.001) out.push(Number(value.toPrecision(6)));
    }
  }
  return out;
}

const pathOf = (points: ReadonlyArray<{ x: number; y: number }>) => points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join('');

export function FrictionChart({ report, rows, interactive = true }: {
  report: DuctSystemSizingReport;
  rows: readonly DuctNetworkRow[];
  interactive?: boolean;
}) {
  const units = useHvacUnits();
  const clipId = `friction-chart-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const axes = AXES[units.system];
  const basis = report.basis;
  const hovered = useDuctNetworkFocusStore((state) => state.hovered?.key ?? null);
  const pinned = useDuctNetworkFocusStore((state) => state.pinned?.key ?? null);
  const setHovered = useDuctNetworkFocusStore((state) => state.setHovered);
  const togglePinned = useDuctNetworkFocusStore((state) => state.togglePinned);
  const flowing = rows.filter((row) => row.section.airflowM3h > 0);

  // The airflow axis (m³/h) around the network's airflows, at least a decade.
  const [qMin, qMax] = useMemo(() => {
    const flows = flowing.map((row) => row.section.airflowM3h);
    let lo = (flows.length ? Math.min(...flows) : 100) / 1.6;
    let hi = (flows.length ? Math.max(...flows) : 1000) * 1.6;
    if (hi / lo < 10) {
      const middle = Math.sqrt(hi * lo);
      lo = middle / Math.sqrt(10);
      hi = middle * Math.sqrt(10);
    }
    return [lo, hi];
  }, [flowing]);
  const x = (r: number) => X0 + ((Math.log10(r) - Math.log10(R_MIN)) / (Math.log10(R_MAX) - Math.log10(R_MIN))) * (X1 - X0);
  const y = (q: number) => Y1 - ((Math.log10(q) - Math.log10(qMin)) / (Math.log10(qMax) - Math.log10(qMin))) * (Y1 - Y0);

  const lines = useMemo(() => {
    const samples = Array.from({ length: 25 }, (_, index) => qMin * (qMax / qMin) ** (index / 24));
    const line = (frictionAt: (q: number) => number) => samples.map((q) => ({ q, r: frictionAt(q) })).filter((point) => Number.isFinite(point.r) && point.r > 0);
    const xs = (r: number) => X0 + ((Math.log10(r) - Math.log10(R_MIN)) / (Math.log10(R_MAX) - Math.log10(R_MIN))) * (X1 - X0);
    const ys = (q: number) => Y1 - ((Math.log10(q) - Math.log10(qMin)) / (Math.log10(qMax) - Math.log10(qMin))) * (Y1 - Y0);
    const label = (points: ReadonlyArray<{ q: number; r: number }>) => {
      // Where the line leaves the plot at the top or the right: the last point inside it.
      const inside = points.filter((point) => point.r >= R_MIN && point.r <= R_MAX);
      const end = inside.at(-1);
      return end ? { x: xs(end.r), y: ys(end.q) } : null;
    };
    const diameters = axes.diameters.map((shown) => {
      const mm = units.fromDisplay('size', shown);
      const points = line((q) => frictionPaPerM(roundLeg(mm), q));
      return { key: `d${shown}`, text: `Ø${shown}`, path: pathOf(points.map((point) => ({ x: xs(point.r), y: ys(point.q) }))), end: label(points) };
    });
    const velocities = axes.velocities.map((shown) => {
      const ms = units.fromDisplay('velocity', shown);
      const points = line((q) => frictionAtVelocity(q, ms));
      return { key: `v${shown}`, text: String(shown), path: pathOf(points.map((point) => ({ x: xs(point.r), y: ys(point.q) }))), end: label(points) };
    });
    return { diameters, velocities };
  }, [axes, qMin, qMax, units]);

  const qTicks = ticks125(units.toDisplay('airflow', qMin), units.toDisplay('airflow', qMax));
  const qLabels = qTicks.length > 5 ? qTicks.filter((_, index) => index % 2 === (qTicks.length % 2 ? 0 : 1)) : qTicks;
  const rTicks = axes.rTicks.map((shown) => ({ shown, r: units.fromDisplay('friction', shown) })).filter((tick) => tick.r >= R_MIN * 0.999 && tick.r <= R_MAX * 1.001);
  const band = axes.band.map((shown) => units.fromDisplay('friction', shown));
  const rDesign = Math.min(R_MAX, Math.max(R_MIN, basis.frictionPaPerM));

  const focusKey = hovered ?? pinned;
  const focused = focusKey ? flowing.find((row) => row.key === focusKey) ?? null : null;
  const q = report.main?.airflowM3h ?? report.terminalsAirflowM3h;
  const diameter = q > 0 && basis.mainVelocityMs > 0 ? diameterAtVelocityMm(q, basis.mainVelocityMs) : null;
  const dotColour = (row: DuctNetworkRow) => {
    const status = figureStatus(row.section.velocityMs, basis.maxVelocity[row.section.part]);
    return status === 'over' ? '#dc2626' : status === 'near' ? '#f59e0b' : report.service === 'return' ? '#0d9488' : row.section.part === 'trunk' ? '#2563eb' : '#0ea5e9';
  };
  return (
    <div className="relative" data-testid="unit-friction-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img"
        aria-label={`Friction chart: airflow against friction rate, with lines of equal diameter and velocity; R ${units.fmt('friction', basis.frictionPaPerM)} and ${flowing.length} stretches`}>
        <defs>
          <clipPath id={clipId}><rect x={X0} y={Y0} width={X1 - X0} height={Y1 - Y0} /></clipPath>
        </defs>
        <rect x={X0} y={Y0} width={X1 - X0} height={Y1 - Y0} fill="#ffffff" stroke="#e2e8f0" />
        <rect x={x(band[0]!)} y={Y0} width={Math.max(0, x(band[1]!) - x(band[0]!))} height={Y1 - Y0} fill="#e0f2fe" />
        <g stroke="#eef2f6" strokeWidth={0.6}>
          {rTicks.map((tick) => <line key={tick.shown} x1={x(tick.r)} y1={Y0} x2={x(tick.r)} y2={Y1} />)}
          {qTicks.map((tick) => {
            const yy = y(units.fromDisplay('airflow', tick));
            return <line key={tick} x1={X0} y1={yy} x2={X1} y2={yy} />;
          })}
        </g>
        <g clipPath={`url(#${clipId})`} fill="none">
          {lines.diameters.map((line) => <path key={line.key} d={line.path} stroke="#cbd5e1" strokeWidth={0.9} />)}
          {lines.velocities.map((line) => <path key={line.key} d={line.path} stroke="#fca5a5" strokeWidth={0.9} strokeDasharray="3 2" />)}
        </g>
        <g fontSize={7.5} fontFamily="Inter, ui-sans-serif, system-ui, sans-serif">
          {lines.diameters.map((line) => (line.end ? <text key={line.key} x={Math.min(X1 - 2, line.end.x)} y={Math.max(Y0 + 8, line.end.y - 2)} fill="#94a3b8" textAnchor="end">{line.text}</text> : null))}
          {lines.velocities.map((line, index) => (line.end ? (
            <text key={line.key} x={Math.min(X1 - 2, line.end.x + 2)} y={Math.max(Y0 + 8, line.end.y + 8)} fill="#f87171">
              {line.text}{index === Math.floor(lines.velocities.length / 2) ? ` ${units.unit('velocity')}` : ''}
            </text>
          ) : null))}
        </g>
        <line x1={x(rDesign)} y1={Y0} x2={x(rDesign)} y2={Y1} stroke="#0284c7" strokeWidth={1.6} />
        <text x={x(rDesign) + 2} y={Y1 - 4} fill="#0369a1" fontSize={8} fontWeight={700} fontFamily="Inter, ui-sans-serif, system-ui, sans-serif">R {units.num('friction', basis.frictionPaPerM)}</text>
        <g>
          {flowing.map((row) => {
            const on = row.key === hovered || row.key === pinned;
            const cx = x(Math.min(R_MAX, Math.max(R_MIN, row.section.frictionPaPerM)));
            const cy = y(Math.min(qMax, Math.max(qMin, row.section.airflowM3h)));
            const focus = focusOfRow(row);
            return (
              <circle key={row.key} cx={cx} cy={cy} r={(row.section.part === 'trunk' ? 4.2 : 3.6) + (on ? 1.4 : 0)} fill={dotColour(row)}
                stroke={on ? '#0f172a' : '#ffffff'} strokeWidth={on ? 1.3 : 1.1} data-testid="unit-friction-dot"
                style={{ cursor: interactive ? 'pointer' : undefined }}
                onPointerEnter={() => setHovered(focus)} onPointerLeave={() => setHovered(null)}
                onClick={interactive ? () => togglePinned(focus) : undefined}>
                <title>{`${units.section(row.section.section)} · ${units.fmt('airflow', row.section.airflowM3h)} · ${units.fmt('velocity', row.section.velocityMs)} · ${units.fmt('friction', row.section.frictionPaPerM)}`}</title>
              </circle>
            );
          })}
        </g>
        <g fill="#64748b" fontSize={8} fontFamily="Inter, ui-sans-serif, system-ui, sans-serif">
          {rTicks.map((tick) => <text key={tick.shown} x={x(tick.r)} y={Y1 + 12} textAnchor="middle">{tick.shown}</text>)}
          <text x={(X0 + X1) / 2} y={H - 2} textAnchor="middle">friction, {units.unit('friction')}</text>
          {qLabels.map((tick) => <text key={tick} x={X0 - 4} y={y(units.fromDisplay('airflow', tick)) + 3} textAnchor="end">{tick}</text>)}
          <text x={X0 - 4} y={Y0 + 3} textAnchor="end">{units.unit('airflow')}</text>
        </g>
      </svg>
      {focused ? (
        <div role="tooltip" className="pointer-events-none absolute z-10 rounded-md bg-slate-900 px-2 py-1 text-[10px] leading-[14px] text-white shadow-lg"
          style={{
            left: `${(Math.min(X1 - 70, Math.max(X0, x(Math.min(R_MAX, Math.max(R_MIN, focused.section.frictionPaPerM))) + 8)) / W) * 100}%`,
            top: `${(Math.max(Y0, y(Math.min(qMax, Math.max(qMin, focused.section.airflowM3h))) - 30) / H) * 100}%`,
          }}>
          <b>{units.section(focused.section.section)}</b>{focused.terminalLabel ? ` ${focused.terminalLabel}` : ''} · {units.fmt('airflow', focused.section.airflowM3h)}
          <br />{units.fmt('velocity', focused.section.velocityMs)} · {units.fmt('friction', focused.section.frictionPaPerM)}
          <br /><span className="text-amber-300">{DUCT_SECTION_SET_BY_LABELS[focused.section.setBy]}</span>
        </div>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[9.5px] text-slate-500" aria-hidden="true">
        <span className="inline-flex items-center gap-1"><i className="inline-block h-0.5 w-2.5 rounded-sm bg-sky-600" />R</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-2 w-2.5 rounded-sm bg-sky-100" />usual range</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block w-3 border-t-[1.5px] border-dashed border-red-300" />velocity</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block w-3 border-t-[1.5px] border-slate-300" />diameter</span>
        <span className="inline-flex items-center gap-1"><i className="inline-block h-1.5 w-1.5 rounded-full bg-blue-600" />stretch</span>
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-1 rounded-lg bg-slate-50 p-1 text-center tabular-nums" aria-label="The main, step by step" data-testid="unit-friction-trace">
        {[
          { symbol: 'Q', value: units.num('airflow', q), unit: units.unit('airflow') },
          { symbol: 'V₀', value: units.num('velocity', basis.mainVelocityMs, units.digits('velocity') + 1), unit: units.unit('velocity') },
          { symbol: 'Ø', value: diameter ? units.num('size', diameter) : '–', unit: units.unit('size') },
          { symbol: 'R', value: units.num('friction', basis.frictionPaPerM), unit: units.unit('friction') },
        ].map((step) => (
          <div key={step.symbol} className="min-w-0" title={step.symbol === 'Ø' ? 'Round equivalent: √(4Q / πV₀)' : undefined}>
            <i className="block font-mono text-[9.5px] font-semibold not-italic text-sky-700">{step.symbol}</i>
            <b className="block truncate text-[11px] text-slate-900">{step.value}</b>
            <span className="block truncate text-[8.5px] text-slate-400">{step.unit}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
