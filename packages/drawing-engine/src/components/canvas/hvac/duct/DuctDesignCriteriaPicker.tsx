'use client';

/**
 * The design basis's criteria, behind one chip ("ASHRAE · Open-plan office ·
 * RC 40", or "Custom limits" once a limit is set by hand): the room (its RC
 * from ASHRAE HVAC Applications ch. 49, Table 1), where the main runs, and
 * what they give — the velocity ladder (Table 8: main, branch 80 %, runout
 * 50 %; Table 9: necks), the friction rates, the size series. "Use for new
 * designs" makes them the project's; "Apply to DU-1" also re-sizes that
 * unit's ducts by them (both services, one undo).
 */
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { useSmartDrawingStore } from '../../../../store';
import { PanelButton, Segmented } from '../unit/unitPanelKit';
import { useHvacUnits } from '../units/useHvacUnits';

import { applyDesignCriteriaToUnit, resizeUnitDuctsAtBasis } from './ductAutoController';
import {
  DESIGN_CRITERIA_SOURCE,
  DESIGN_ROOM_TYPES,
  DUCT_MAIN_LOCATION_LABELS,
  RECOMMENDED_DESIGN_CRITERIA,
  criteriaStillApply,
  designCriteriaLimits,
  designCriteriaSettings,
  designRoomType,
  type DesignCriteria,
  type DuctMainLocation,
} from './ductDesignCriteria';

const LOCATION_OPTIONS: ReadonlyArray<{ value: DuctMainLocation; label: string; sub: string }> = [
  { value: 'shaft', label: 'Shaft', sub: 'or drywall' },
  { value: 'suspended', label: 'Above ceiling', sub: 'suspended' },
  { value: 'occupied', label: 'In the room', sub: 'exposed' },
];

const sameCriteria = (a: DesignCriteria | null, b: DesignCriteria | null) => Boolean(a && b && a.room === b.room && a.location === b.location);

/** The chip's words for the project's criteria. */
export function criteriaChipText(criteria: DesignCriteria | null, applies: boolean): string {
  if (!criteria || !applies) return 'Custom limits';
  const room = designRoomType(criteria.room);
  return `ASHRAE · ${room.label} · RC ${room.rc}`;
}

function LadderRow({ label, fraction, value, tone = 'bg-sky-500' }: { label: string; fraction: number; value: string; tone?: string }) {
  return (
    <div className="grid grid-cols-[46px_minmax(0,1fr)_64px] items-center gap-2 text-[10.5px]">
      <span className="text-slate-500">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-slate-100"><span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.max(4, Math.min(100, fraction * 100))}%` }} /></span>
      <span className="text-right font-semibold tabular-nums text-slate-800">{value}</span>
    </div>
  );
}

/**
 * "Design basis" with the criteria chip on its right; the chip opens the
 * criteria in place (they push what follows down, never covering it).
 * `unitId` with `canApply`: the unit whose ducts "Apply" re-sizes.
 */
export function DesignCriteriaPicker({ unitId, unitTag, canApply, caption = 'Design basis' }: { unitId: string | null; unitTag: string; canApply: boolean; caption?: string }) {
  const units = useHvacUnits();
  const settings = useSmartDrawingStore((state) => state.ductSettings);
  const setDuctSettings = useSmartDrawingStore((state) => state.setDuctSettings);
  const applies = criteriaStillApply(settings);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DesignCriteria>(settings.designCriteria ?? RECOMMENDED_DESIGN_CRITERIA);
  const limits = designCriteriaLimits(draft);
  const inUse = applies && sameCriteria(settings.designCriteria, draft);
  const room = designRoomType(draft.room);
  const toggle = () => {
    if (!open) setDraft(settings.designCriteria ?? RECOMMENDED_DESIGN_CRITERIA);
    setOpen(!open);
  };
  const v = (ms: number) => units.num('velocity', ms);
  return (
    <div data-testid="duct-sizing-criteria">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-slate-400">{caption}</span>
        <button type="button" aria-expanded={open} onClick={toggle} data-testid="duct-sizing-criteria-chip"
          title={applies && settings.designCriteria ? `${DESIGN_CRITERIA_SOURCE}: ${designRoomType(settings.designCriteria.room).label} (RC ${designRoomType(settings.designCriteria.room).rc}), main ${DUCT_MAIN_LOCATION_LABELS[settings.designCriteria.location].toLowerCase()}` : 'The limits and friction rates are set by hand: choose the room and where the main runs'}
          className={`inline-flex min-w-0 items-center gap-1 truncate rounded-full border py-px pl-[7px] pr-1 text-[10px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${applies ? 'border-sky-200 bg-sky-50 text-sky-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
          <span className="truncate">{criteriaChipText(settings.designCriteria, applies)}</span>
          <ChevronDown size={10} aria-hidden="true" className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open ? (
        <div role="group" aria-label="Design criteria" className="mt-2 rounded-[10px] border border-sky-100 bg-white p-2.5 shadow-[0_6px_16px_-10px_rgba(2,132,199,0.45)]" data-testid="duct-sizing-criteria-editor">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11.5px] font-bold text-slate-900">Design criteria</span>
            <span className="text-[9.5px] text-slate-400">ASHRAE 2023 · ch. 49</span>
          </div>
          <span className="text-[9px] font-semibold uppercase tracking-[0.07em] text-slate-400">Room</span>
          <div role="radiogroup" aria-label="Room type" className="mt-1 max-h-[132px] overflow-y-auto rounded-lg border border-slate-100">
            {DESIGN_ROOM_TYPES.map((type) => {
              const on = type.id === draft.room;
              return (
                <button key={type.id} type="button" role="radio" aria-checked={on} onClick={() => setDraft({ ...draft, room: type.id })}
                  className={`flex w-full items-center justify-between gap-2 px-2 py-[3px] text-left text-[11px] focus:outline-none focus-visible:bg-sky-50 ${on ? 'bg-sky-50 font-semibold text-sky-900' : 'text-slate-700 hover:bg-slate-50'}`}>
                  <span className="truncate">{type.label}</span>
                  <span className={`shrink-0 rounded-full px-1.5 text-[9.5px] font-semibold leading-4 tabular-nums ${on ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500'}`}>RC {type.rc}</span>
                </button>
              );
            })}
          </div>
          <span className="mt-2 block text-[9px] font-semibold uppercase tracking-[0.07em] text-slate-400">Main duct runs</span>
          <Segmented variant="speed" label="Main duct location" value={draft.location} onChange={(location) => setDraft({ ...draft, location })} className="mt-1"
            options={LOCATION_OPTIONS.map((option) => ({ value: option.value, label: option.label, sub: option.sub, title: DUCT_MAIN_LOCATION_LABELS[option.value] }))} />
          <span className="mt-2 block text-[9px] font-semibold uppercase tracking-[0.07em] text-slate-400">
            Velocity limits · {units.unit('velocity')}{limits.interpolated ? ` · RC ${limits.rc} between the table's rows` : ''}
          </span>
          <div className="mt-1 space-y-1" data-testid="duct-sizing-criteria-ladder">
            <LadderRow label="Main" fraction={1} value={v(limits.mainMs)} />
            <LadderRow label="Branch" fraction={limits.branchMs / limits.mainMs} value={v(limits.branchMs)} />
            <LadderRow label="Runout" fraction={limits.runoutMs / limits.mainMs} value={v(limits.runoutMs)} />
            <LadderRow label="Neck" fraction={limits.neckSupplyMs / limits.mainMs} value={`${v(limits.neckSupplyMs)} / ${v(limits.neckReturnMs)}`} tone="bg-sky-300" />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 text-[10.5px]">
            <span className="text-slate-500">Friction</span>
            <span className="font-semibold tabular-nums text-slate-800">{units.num('friction', limits.frictionSupplyPaPerM)} supply · {units.num('friction', limits.frictionReturnPaPerM)} return {units.unit('friction')}</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[10.5px]">
            <span className="text-slate-500">Sizes</span>
            <Segmented label="Size series" value={settings.sizeSeries} onChange={(sizeSeries) => setDuctSettings({ sizeSeries })} className="w-[150px]"
              options={[
                { value: 'metric', label: 'Metric', title: 'Rectangles in the fabricator\'s steps (50 mm), round from the stocked list' },
                { value: 'imperial', label: 'Inch', title: 'Rectangles in 2 in steps, round 4–10 in by the inch, then by 2 in' },
              ]} />
          </div>
          {canApply && unitId ? (
            <button type="button" onClick={() => resizeUnitDuctsAtBasis(unitId, `Duct sizing: ${unitTag} re-sized to the ${settings.sizeSeries === 'imperial' ? 'inch' : 'metric'} series`)}
              className="mt-1 block w-full text-right text-[10px] text-sky-700 hover:underline" data-testid="duct-sizing-series-resize">
              Re-size {unitTag} to the {settings.sizeSeries === 'imperial' ? 'inch' : 'metric'} sizes
            </button>
          ) : null}
          <div className="mt-2.5 flex gap-1.5">
            <PanelButton tone="primary" className="flex-1 justify-center" testId="duct-sizing-criteria-use" disabled={inUse}
              title={`Make ${room.label} (RC ${room.rc}) the project's: new designs size by it`}
              onClick={() => { setDuctSettings(designCriteriaSettings(draft)); setOpen(false); }}>
              {inUse ? <><Check size={11} aria-hidden="true" />In use</> : 'Use for new designs'}
            </PanelButton>
            {canApply && unitId ? (
              <PanelButton className="flex-1 justify-center" testId="duct-sizing-criteria-apply" title={`Also re-size ${unitTag}'s ducts by these criteria (one undo)`}
                onClick={() => { applyDesignCriteriaToUnit(unitId, draft, `Design criteria: ${room.label} RC ${room.rc} → ${unitTag}`); setOpen(false); }}>
                Apply to {unitTag}
              </PanelButton>
            ) : null}
          </div>
          <p className="mt-2 text-[9px] leading-3 text-slate-400">
            Tables 1 (room → RC), 8 (main; branch 80 %, final runout 50 %), 9 (necks); RC 30 and 40 between the table&apos;s rows. Friction about 0.1 in. wg per 100 ft.
          </p>
        </div>
      ) : null}
    </div>
  );
}
