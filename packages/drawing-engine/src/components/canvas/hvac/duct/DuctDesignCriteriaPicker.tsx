'use client';

/**
 * The design basis's criteria, behind one chip ("ASHRAE · Conference room ·
 * RC 30" with whose they are: a room's name, the unit's tag, or "project";
 * "Custom limits" once a limit is set by hand): the room type (its RC from
 * ASHRAE HVAC Applications ch. 49, Table 1), where the main runs, and what they
 * give — the velocity ladder (Table 8: main, branch 80 %, runout 50 %; Table 9:
 * necks), the friction rates. Three scopes:
 *
 *  - **Room:** the criteria of a room the unit serves (stored on the room,
 *    suggested from its name and type when it has none); "Apply to Meeting
 *    Room 2" gives them to the room and re-sizes every unit they change, "Use
 *    the project's" goes back — the room and the ducts one undo;
 *  - **DU-1 only:** the unit's own, over its rooms' (stored on the unit);
 *  - **Project:** what new designs size at where no room or unit has criteria
 *    ("Use for new designs"), and the size series.
 */
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement, Room } from '../../../../types';
import { PanelButton, Segmented } from '../unit/unitPanelKit';
import { useHvacUnits } from '../units/useHvacUnits';

import { applyDesignCriteriaToRoom, applyDesignCriteriaToUnit, resizeUnitDuctsAtBasis } from './ductAutoController';
import {
  DESIGN_CRITERIA_SOURCE,
  DESIGN_ROOM_TYPES,
  DUCT_MAIN_LOCATION_LABELS,
  RECOMMENDED_DESIGN_CRITERIA,
  criteriaStillApply,
  designCriteriaLimits,
  designCriteriaSettings,
  designRoomType,
  readUnitCriteria,
  suggestDesignRoom,
  type DesignCriteria,
  type DuctMainLocation,
} from './ductDesignCriteria';
import { readRoomCriteria, unitCriteria } from './unitCriteria';

const LOCATION_OPTIONS: ReadonlyArray<{ value: DuctMainLocation; label: string; sub: string }> = [
  { value: 'shaft', label: 'Shaft', sub: 'or drywall' },
  { value: 'suspended', label: 'Above ceiling', sub: 'suspended' },
  { value: 'occupied', label: 'In the room', sub: 'exposed' },
];

type CriteriaScope = 'room' | 'unit' | 'project';

const sameCriteria = (a: DesignCriteria | null, b: DesignCriteria | null) => Boolean(a && b && a.room === b.room && a.location === b.location);

/** The chip's words for a set of criteria (none: the limits are the designer's own). */
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
 * `unit`: the unit whose rooms and own criteria the first scopes set;
 * `hasDucts`: it has ducts to re-size to the size series.
 */
export function DesignCriteriaPicker({ unit, unitTag, hasDucts = false, caption = 'Design basis' }: {
  unit: HvacElement | null; unitTag: string; hasDucts?: boolean; caption?: string;
}) {
  const units = useHvacUnits();
  const { settings, setDuctSettings, rooms, scene } = useSmartDrawingStore((state) => ({
    settings: state.ductSettings, setDuctSettings: state.setDuctSettings, rooms: state.rooms, scene: state.hvacElements,
  }), shallow);
  const resolved = unit ? unitCriteria(settings, unit, { scene, rooms }) : null;
  const served = (resolved?.roomIds ?? []).flatMap((id) => rooms.filter((room) => room.id === id));
  const projectApplies = criteriaStillApply(settings);
  const projectCriteria = projectApplies ? settings.designCriteria : null;
  const unitOwn = readUnitCriteria(unit);
  const [roomId, setRoomId] = useState<string | null>(null);
  const targetRoom: Room | null = served.find((room) => room.id === roomId) ?? served[0] ?? null;
  const roomOwn = readRoomCriteria(targetRoom);
  const location = settings.designCriteria?.location ?? RECOMMENDED_DESIGN_CRITERIA.location;
  const suggestionFor = (room: Room | null): DesignCriteria | null => {
    const suggested = suggestDesignRoom(room);
    return suggested ? { room: suggested, location } : null;
  };
  // What a scope starts from: a room's own, else what it suggests (its mains where the project's run), else the
  // project's; the unit's own, else what it follows now; the project's own, else the recommended set.
  const startOf = (scope: CriteriaScope, room: Room | null = targetRoom): DesignCriteria => {
    if (scope === 'room') return readRoomCriteria(room) ?? suggestionFor(room) ?? settings.designCriteria ?? RECOMMENDED_DESIGN_CRITERIA;
    if (scope === 'unit') return unitOwn ?? resolved?.criteria ?? settings.designCriteria ?? RECOMMENDED_DESIGN_CRITERIA;
    return settings.designCriteria ?? RECOMMENDED_DESIGN_CRITERIA;
  };
  const scopeToOpen = (): CriteriaScope => (unitOwn ? 'unit' : served.length ? 'room' : unit ? 'unit' : 'project');
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<CriteriaScope>(scopeToOpen);
  const [draft, setDraft] = useState<DesignCriteria>(() => startOf(scopeToOpen()));
  const limits = designCriteriaLimits(draft);
  const draftRoom = designRoomType(draft.room);
  const shown = resolved ? resolved.criteria : projectCriteria;
  const whoseRoom = resolved?.whose.kind === 'room' ? rooms.find((room) => room.id === (resolved.whose as { roomId: string }).roomId) ?? null : null;
  const whose = resolved?.whose.kind === 'unit' ? unitTag : whoseRoom ? whoseRoom.name : shown ? 'project' : null;
  const fromSuggestion = scope === 'room' && !roomOwn && targetRoom !== null && sameCriteria(suggestionFor(targetRoom), draft);
  const inUse = scope === 'room' ? sameCriteria(roomOwn, draft)
    : scope === 'unit' ? sameCriteria(unitOwn, draft)
      : projectApplies && sameCriteria(settings.designCriteria, draft);
  const toggle = () => {
    if (!open) {
      const next = scopeToOpen();
      setScope(next);
      setRoomId(null);
      setDraft(startOf(next, served[0] ?? null));
    }
    setOpen(!open);
  };
  const switchScope = (next: CriteriaScope) => {
    setScope(next);
    setDraft(startOf(next));
  };
  const pickRoom = (id: string) => {
    const room = served.find((candidate) => candidate.id === id) ?? null;
    setRoomId(id);
    setDraft(startOf('room', room));
  };
  const v = (ms: number) => units.num('velocity', ms);
  const chipTitle = shown
    ? `${DESIGN_CRITERIA_SOURCE}: ${designRoomType(shown.room).label} (RC ${designRoomType(shown.room).rc}), main ${DUCT_MAIN_LOCATION_LABELS[shown.location].toLowerCase()} — ${whose === 'project' ? 'the project\'s' : `${whose}'s`}`
    : 'The limits and friction rates are set by hand: choose the room and where the main runs';
  const scopeOptions = [
    ...(served.length ? [{ value: 'room' as const, label: served.length === 1 ? 'Room' : `Rooms · ${served.length}`, title: 'The criteria of a room this unit serves: every unit serving it designs by them' }] : []),
    ...(unit ? [{ value: 'unit' as const, label: `${unitTag} only`, title: `${unitTag}'s own criteria, over its rooms': its ducts are designed and checked by them` }] : []),
    { value: 'project' as const, label: 'Project', title: 'What new designs size at, where no room or unit has criteria of its own' },
  ];
  return (
    <div data-testid="duct-sizing-criteria">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-slate-400">{caption}</span>
        <button type="button" aria-expanded={open} onClick={toggle} data-testid="duct-sizing-criteria-chip" title={chipTitle}
          className={`inline-flex min-w-0 items-center gap-1 truncate rounded-full border py-px pl-[7px] pr-1 text-[10px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${shown ? 'border-sky-200 bg-sky-50 text-sky-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
          <span className="truncate">{criteriaChipText(shown, Boolean(shown))}</span>
          {whose ? (
            <span className={`max-w-[88px] shrink-0 truncate rounded-full px-1 text-[8.5px] font-bold leading-[13px] ${whose === 'project' ? 'bg-white text-sky-700' : 'bg-sky-600 text-white'}`}
              data-testid="duct-sizing-criteria-whose">{whose}</span>
          ) : null}
          <ChevronDown size={10} aria-hidden="true" className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open ? (
        <div role="group" aria-label="Design criteria" className="mt-2 rounded-[10px] border border-sky-100 bg-white p-2.5 shadow-[0_6px_16px_-10px_rgba(2,132,199,0.45)]" data-testid="duct-sizing-criteria-editor">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11.5px] font-bold text-slate-900">Design criteria</span>
            <span className="text-[9.5px] text-slate-400">ASHRAE 2023 · ch. 49</span>
          </div>
          {scopeOptions.length > 1 ? (
            <Segmented label="Criteria for" value={scope} onChange={switchScope} className="mb-2" testId="duct-sizing-criteria-scope" options={scopeOptions} />
          ) : null}
          {scope === 'room' && targetRoom ? (
            <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[10.5px]">
              {served.length > 1 ? (
                <select aria-label="Room" value={targetRoom.id} onChange={(event) => pickRoom(event.target.value)} data-testid="duct-sizing-criteria-room"
                  className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10.5px] font-semibold text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
                  {served.map((room) => (
                    <option key={room.id} value={room.id}>{room.name}{resolved?.whose.kind === 'room' && resolved.whose.roomId === room.id ? ' · sets the limits' : ''}</option>
                  ))}
                </select>
              ) : (
                <span className="min-w-0 truncate font-semibold text-slate-800" data-testid="duct-sizing-criteria-room">{targetRoom.name}</span>
              )}
              <span className="shrink-0 text-[9.5px] text-slate-400">{roomOwn ? 'its own' : 'the project\'s now'}</span>
            </div>
          ) : null}
          <span className="text-[9px] font-semibold uppercase tracking-[0.07em] text-slate-400">Room type</span>
          {fromSuggestion && targetRoom ? (
            <span className="ml-1 text-[9.5px] text-sky-700" data-testid="duct-sizing-criteria-suggested">· suggested from {targetRoom.name}</span>
          ) : null}
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
          <Segmented variant="speed" label="Main duct location" value={draft.location} onChange={(next) => setDraft({ ...draft, location: next })} className="mt-1"
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
          {scope === 'project' ? (
            <>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[10.5px]">
                <span className="text-slate-500">Sizes</span>
                <Segmented label="Size series" value={settings.sizeSeries} onChange={(sizeSeries) => setDuctSettings({ sizeSeries })} className="w-[150px]"
                  options={[
                    { value: 'metric', label: 'Metric', title: 'Rectangles in the fabricator\'s steps (50 mm), round from the stocked list' },
                    { value: 'imperial', label: 'Inch', title: 'Rectangles in 2 in steps, round 4–10 in by the inch, then by 2 in' },
                  ]} />
              </div>
              {hasDucts && unit ? (
                <button type="button" onClick={() => resizeUnitDuctsAtBasis(unit.id, `Duct sizing: ${unitTag} re-sized to the ${settings.sizeSeries === 'imperial' ? 'inch' : 'metric'} series`)}
                  className="mt-1 block w-full text-right text-[10px] text-sky-700 hover:underline" data-testid="duct-sizing-series-resize">
                  Re-size {unitTag} to the {settings.sizeSeries === 'imperial' ? 'inch' : 'metric'} sizes
                </button>
              ) : null}
            </>
          ) : null}
          <div className="mt-2.5 flex gap-1.5">
            {scope === 'room' && targetRoom ? (
              <>
                <PanelButton tone="primary" className="min-w-0 flex-1 justify-center" testId="duct-sizing-criteria-apply" disabled={inUse}
                  title={`Give ${targetRoom.name} these criteria; every unit serving it is re-sized by them (one undo)`}
                  onClick={() => { applyDesignCriteriaToRoom(targetRoom.id, draft, `Design criteria: ${draftRoom.label} RC ${draftRoom.rc} → ${targetRoom.name}`); setOpen(false); }}>
                  {inUse ? <><Check size={11} aria-hidden="true" />In use</> : <span className="truncate">Apply to {targetRoom.name}</span>}
                </PanelButton>
                {roomOwn ? (
                  <PanelButton className="flex-1 justify-center" testId="duct-sizing-criteria-clear" title={`${targetRoom.name} goes back to the project's criteria; the units serving it are re-sized by them (one undo)`}
                    onClick={() => { applyDesignCriteriaToRoom(targetRoom.id, null, `Design criteria: ${targetRoom.name} → the project's`); setOpen(false); }}>
                    Use the project&apos;s
                  </PanelButton>
                ) : null}
              </>
            ) : scope === 'unit' && unit ? (
              <>
                <PanelButton tone="primary" className="flex-1 justify-center" testId="duct-sizing-criteria-apply" disabled={inUse}
                  title={`Give ${unitTag} these criteria of its own, over its rooms', and re-size its ducts by them (one undo)`}
                  onClick={() => { applyDesignCriteriaToUnit(unit.id, draft, `Design criteria: ${draftRoom.label} RC ${draftRoom.rc} → ${unitTag}`); setOpen(false); }}>
                  {inUse ? <><Check size={11} aria-hidden="true" />In use</> : `Apply to ${unitTag} only`}
                </PanelButton>
                {unitOwn ? (
                  <PanelButton className="flex-1 justify-center" testId="duct-sizing-criteria-clear"
                    title={`${unitTag} goes back to ${served.length ? 'the criteria of the rooms it serves' : 'the project\'s criteria'}; its ducts are re-sized by them (one undo)`}
                    onClick={() => { applyDesignCriteriaToUnit(unit.id, null, `Design criteria: ${unitTag} → ${served.length ? 'its rooms\'' : 'the project\'s'}`); setOpen(false); }}>
                    {served.length ? 'Use the room\'s' : 'Use the project\'s'}
                  </PanelButton>
                ) : null}
              </>
            ) : (
              <PanelButton tone="primary" className="flex-1 justify-center" testId="duct-sizing-criteria-use" disabled={inUse}
                title={`Make ${draftRoom.label} (RC ${draftRoom.rc}) the project's: new designs size by it, where no room or unit has criteria of its own`}
                onClick={() => { setDuctSettings(designCriteriaSettings(draft)); setOpen(false); }}>
                {inUse ? <><Check size={11} aria-hidden="true" />In use</> : 'Use for new designs'}
              </PanelButton>
            )}
          </div>
          <p className="mt-2 text-[9px] leading-3 text-slate-400">
            Tables 1 (room → RC), 8 (main; branch 80 %, final runout 50 %), 9 (necks); RC 30 and 40 between the table&apos;s rows. Friction about 0.1 in. wg per 100 ft.
          </p>
        </div>
      ) : null}
    </div>
  );
}
