'use client';

/**
 * A duct system as a tree: from the unit's collar, each run on its rail and
 * the runs it feeds nested where they leave it; one row a stretch — its
 * standard size, a bar of the airflow it carries (the sum of the terminals
 * past it), that airflow and its velocity, coloured against its part's limit.
 * Hovering a row outlines the stretch on the plan; a click pins it there
 * (again lets it go). The figures are the sizing report's.
 */
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useDuctNetworkFocusStore, type DuctNetworkFocus } from '../duct/ductNetworkFocusStore';
import type { DuctNetworkRow } from '../duct/ductNetworkTree';
import { figureStatus } from '../duct/ductSegmentFigures';
import { DUCT_SECTION_SET_BY_LABELS, type DuctSystemSizingReport } from '../duct/ductSystemSizing';
import type { DuctLeg } from '../duct/ductTypes';
import { useHvacUnits } from '../units/useHvacUnits';

import { PanelButton } from './unitPanelKit';

const RAIL_TONES = ['bg-blue-200', 'bg-blue-100', 'bg-sky-100'] as const;
const VELOCITY_TEXT = { ok: 'text-slate-700', near: 'font-semibold text-amber-700', over: 'font-semibold text-red-600' } as const;
const ROW = 'grid grid-cols-[12px_minmax(0,1fr)_minmax(24px,46px)_38px_30px] items-center gap-[5px]';
/** Indent a nesting level takes (px). */
const STEP = 9;

export function focusOfRow(row: DuctNetworkRow): DuctNetworkFocus {
  return { key: row.key, runId: row.section.runId, fromMm: row.section.fromMm, toMm: row.section.toMm, toEnd: row.last };
}

function SectionIcon({ leg, service }: { leg: DuctLeg; service: 'supply' | 'return' }) {
  const tone = service === 'return' ? 'text-teal-600' : 'text-blue-600';
  return (
    <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2} className={tone} aria-hidden="true">
      {leg.diameterMm !== undefined ? <circle cx="12" cy="12" r="7" />
        : leg.widthMm >= leg.heightMm * 1.4 ? <rect x="3" y="8" width="18" height="8" rx="1" /> : <rect x="5" y="6" width="14" height="12" rx="1" />}
    </svg>
  );
}

export function NetworkTree({ report, rows, unitTag, collar, interactive = true }: {
  report: DuctSystemSizingReport;
  /** The report's stretches as a tree (ductNetworkRows). */
  rows: readonly DuctNetworkRow[];
  unitTag: string;
  /** The unit's collar on this service. */
  collar: { widthMm: number; heightMm: number } | null;
  /** Off for a preview's network: its runs are not on the plan yet. */
  interactive?: boolean;
}) {
  const units = useHvacUnits();
  const hovered = useDuctNetworkFocusStore((state) => state.hovered?.key ?? null);
  const pinned = useDuctNetworkFocusStore((state) => state.pinned?.key ?? null);
  const setHovered = useDuctNetworkFocusStore((state) => state.setHovered);
  const togglePinned = useDuctNetworkFocusStore((state) => state.togglePinned);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  // Let the plan go when the network does.
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    useDuctNetworkFocusStore.getState().clear();
  }, []);
  const peak = Math.max(1, ...rows.map((row) => row.section.airflowM3h));
  const basis = report.basis;
  const total = report.terminalsAirflowM3h;
  const balanced = report.airflowM3h === null || Math.abs(total - report.airflowM3h) <= Math.max(1, report.airflowM3h * 1e-6);
  const copy = () => {
    const lines = [
      ['Run', 'Size', `Airflow ${units.unit('airflow')}`, `Velocity ${units.unit('velocity')}`, `Friction ${units.unit('friction')}`, 'Set by'].join('\t'),
      ...rows.map(({ section, depth }) => [`${'  '.repeat(depth)}${section.runLabel}`, units.section(section.section), units.num('airflow', section.airflowM3h),
        units.num('velocity', section.velocityMs, units.digits('velocity') + 1), units.num('friction', section.frictionPaPerM, units.digits('friction') + 1),
        DUCT_SECTION_SET_BY_LABELS[section.setBy]].join('\t')),
    ];
    void navigator.clipboard?.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };
  return (
    <div data-testid="unit-network">
      <div className="flex items-center gap-1.5">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-slate-400">Network</span>
        <span className={`ml-auto flex items-center gap-1 text-[10.5px] tabular-nums ${balanced ? 'text-slate-600' : 'text-amber-700'}`} data-testid="unit-network-total"
          title={balanced ? 'The terminals take the system airflow' : `The terminals take ${units.fmt('airflow', total)} of ${units.fmt('airflow', report.airflowM3h)}`}>
          Σ {units.fmt('airflow', total)}
          {balanced ? <span className="rounded-full bg-emerald-100 px-[5px] text-[10px] font-medium leading-[17px] text-emerald-800">✓</span> : null}
        </span>
        <PanelButton tone="ghost" onClick={copy} title="Copy the network as a table (paste it into a spreadsheet)" className="!px-1 text-[10.5px]">
          {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}<span className="sr-only">{copied ? 'Copied' : 'Copy'}</span>
        </PanelButton>
      </div>
      <div className={`${ROW} mt-1 h-[19px] text-[10px] text-slate-400`}>
        <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><rect x="3" y="7" width="18" height="10" rx="2" /></svg>
        <span className="col-span-4 truncate">{unitTag}{collar ? ` · collar ${units.section(collar)}` : ''}</span>
      </div>
      <div role="tree" aria-label={`${report.service === 'return' ? 'Return' : 'Supply'} network`} className="relative" data-testid="unit-network-tree"
        onPointerLeave={() => { if (interactive) setHovered(null); }}>
        {rows.map((row) => {
          const { section } = row;
          const status = section.airflowM3h > 0 ? figureStatus(section.velocityMs, basis.maxVelocity[section.part]) : 'ok';
          const focus = focusOfRow(row);
          const on = row.key === pinned;
          const hot = row.key === hovered;
          const tip = `${units.section(section.section)} · ${units.fmt('airflow', section.airflowM3h)} · ${units.fmt('velocity', section.velocityMs)} (${section.part} limit ${units.fmt('velocity', basis.maxVelocity[section.part])}) · ${units.fmt('friction', section.frictionPaPerM)} — ${DUCT_SECTION_SET_BY_LABELS[section.setBy]}${section.note ? `: ${section.note}` : ''}`;
          return (
            <div key={row.key} role="treeitem" aria-level={row.depth + 1} aria-selected={on} tabIndex={interactive ? 0 : -1} title={tip} data-testid="unit-network-row"
              data-run-id={section.runId} data-main={row.main || undefined}
              onPointerEnter={interactive ? () => setHovered(focus) : undefined}
              onFocus={interactive ? () => setHovered(focus) : undefined}
              onBlur={interactive ? () => setHovered(null) : undefined}
              onClick={interactive ? () => togglePinned(focus) : undefined}
              onKeyDown={interactive ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePinned(focus); } } : undefined}
              className={`${ROW} relative h-[21px] rounded-md text-[10.5px] tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${interactive ? 'cursor-pointer' : ''} ${on ? 'bg-sky-100 ring-1 ring-inset ring-sky-300' : hot ? 'bg-sky-50' : row.main ? 'bg-sky-50/70' : interactive ? 'hover:bg-slate-50' : ''}`}
              style={{ paddingLeft: row.depth * STEP + 2 }}>
              {Array.from({ length: row.depth }, (_, level) => (
                <span key={level} aria-hidden="true" className={`absolute inset-y-0 w-[1.5px] ${RAIL_TONES[Math.min(level, RAIL_TONES.length - 1)]}`} style={{ left: level * STEP + 5 }} />
              ))}
              <SectionIcon leg={section.section} service={report.service} />
              <span className="min-w-0 truncate font-semibold text-slate-900">
                {units.section(section.section)}{row.terminalLabel ? <span className="ml-1 font-medium text-sky-700">{row.terminalLabel}</span> : null}
              </span>
              <span className="h-[5px] overflow-hidden rounded-full bg-blue-50" aria-hidden="true">
                <span className={`block h-full rounded-full ${report.service === 'return' ? 'bg-teal-400' : 'bg-blue-400'}`} style={{ width: `${Math.max(0, Math.min(100, (section.airflowM3h / peak) * 100))}%` }} />
              </span>
              <span className="text-right text-slate-600">{units.num('airflow', section.airflowM3h)}</span>
              <span className={`text-right ${VELOCITY_TEXT[status]}`}>{section.airflowM3h > 0 ? units.num('velocity', section.velocityMs) : '–'}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex items-center justify-between text-[9px] text-slate-400">
        <span>bar = {units.unit('airflow')} (the terminals past it){units.system === 'ip' ? ' · sizes in inches' : ''}</span>
        <span>{units.unit('velocity')}</span>
      </div>
    </div>
  );
}
