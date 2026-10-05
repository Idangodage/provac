'use client';

/**
 * Air system card. With one ducted unit selected: its system tag, the supply
 * and return terminals dedicated to it (airflow share, neck velocity, whether
 * its duct reaches them), the balance against the unit's airflow, the rooms it
 * serves and engineering hints; and how to grow it: place supply or return
 * terminals for it, pick terminals on the plan, assign the selected ones, or
 * auto-assign its room (balanced by airflow). With only terminals selected: a
 * one-line "assign them to" control.
 *
 * The panel is about 240 px wide: two-line rows, not tables.
 */
import { AlertTriangle, CheckCircle2, Info, MousePointerClick, Network, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { shallow } from 'zustand/shallow';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data';
import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { assignTerminalsToUnit, autoAssignTerminals, selectedTerminalsForUnit, setAirSystemTag, unassignTerminals } from './airSystemController';
import { useAirSystemUiStore } from './airSystemUiStore';
import { AIR_BALANCE_TOLERANCE } from './ductAirSystemChecks';
import { analyseAirSystems, isAirSystemUnit, type AirSystem, type AirSystemService } from './ductAirSystems';
import { isDuctTerminalElement, TERMINAL_FACE_LABELS } from './ductTerminals';

const SERVICE_TONE = {
  supply: { dot: 'bg-blue-700', text: 'text-blue-800', label: 'Supply' },
  return: { dot: 'bg-teal-700', text: 'text-teal-800', label: 'Return' },
} as const;

const SUPPLY_ENTRIES = DEFAULT_AC_EQUIPMENT_LIBRARY.filter((definition) => definition.category === 'air-terminals');
const RETURN_ENTRIES = DEFAULT_AC_EQUIPMENT_LIBRARY.filter((definition) => definition.category === 'return-air-terminals');

function TagEditor({ system }: { system: AirSystem }) {
  const [draft, setDraft] = useState(system.tag);
  useEffect(() => setDraft(system.tag), [system.tag]);
  const commit = () => { if (draft.trim() && draft.trim() !== system.tag) setAirSystemTag(system.unit.id, draft); else setDraft(system.tag); };
  return (
    <input value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} maxLength={24}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.currentTarget.blur(); }
        if (event.key === 'Escape') { setDraft(system.tag); event.stopPropagation(); }
      }}
      aria-label="Air system tag" title="System tag (unique): it names this unit's supply and return systems"
      className="w-16 rounded border border-transparent bg-transparent px-1 text-xs font-semibold text-slate-800 hover:border-slate-200 focus:border-slate-300 focus:bg-white focus:outline-none" />
  );
}

function balanceText(group: AirSystemService, airflow: number | null): { text: string; ok: boolean } {
  const total = Math.round(group.totalM3h);
  if (!airflow) return { text: `${total} m³/h`, ok: true };
  const ok = Math.abs(group.totalM3h - airflow) <= airflow * AIR_BALANCE_TOLERANCE;
  return { text: `${total} of ${Math.round(airflow)} m³/h`, ok };
}

function ServiceGroup({ system, group }: { system: AirSystem; group: AirSystemService }) {
  const tone = SERVICE_TONE[group.service];
  const balance = balanceText(group, system.airflowM3h);
  return (
    <div className="rounded-md bg-white/80 p-1" data-testid={`air-system-${group.service}`}>
      <div className="flex items-center justify-between gap-1 text-[11px]">
        <span className={`flex items-center gap-1 font-semibold ${tone.text}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${tone.dot}`} aria-hidden="true" />
          {tone.label} · {group.members.length}
        </span>
        {group.members.length ? (
          <span className={`flex items-center gap-0.5 text-[10px] ${balance.ok ? 'text-emerald-700' : 'text-amber-700'}`}
            title="Sum of the terminals' airflows (design airflow, else an equal share) against the unit's airflow at Hi">
            {balance.ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}{balance.text}
          </span>
        ) : null}
      </div>
      {!group.collar && group.members.length ? <p className="text-[10px] text-red-600">The unit has no {group.service} collar.</p> : null}
      {group.members.length ? (
        <ul className="mt-0.5 space-y-0.5">
          {group.members.map((member) => (
            <li key={member.terminal.id} className="flex items-start justify-between gap-1 rounded px-0.5 text-[10px] hover:bg-slate-50" data-air-system-row={member.terminal.id}>
              <span className="min-w-0">
                <span className="font-medium text-slate-800">{member.tag}</span>
                <span className="text-slate-500"> · {TERMINAL_FACE_LABELS[member.spec.kind]}{member.spec.filter ? ` · ${member.spec.filter}` : ''} · Ø{member.spec.neckDiameterMm}</span>
                <span className="block text-slate-500">
                  {Math.round(member.airflowM3h)} m³/h{member.fixed ? '' : ' (share)'} · {member.neckVelocityMs.toFixed(1)} m/s ·{' '}
                  {member.mismatch ? <span className="text-red-600">ducted from another unit</span>
                    : member.connection ? <span className="text-emerald-700">● ducted</span> : <span className="text-slate-400">○ not ducted yet</span>}
                </span>
              </span>
              {member.source !== 'connected' ? (
                <button type="button" onClick={() => unassignTerminals([member.terminal.id])} title={`Take ${member.tag} out of ${system.tag}`}
                  aria-label={`Unassign ${member.tag}`} className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                  <X size={11} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-[10px] text-slate-400">{group.service === 'return' ? 'No return terminals: the collar draws from the ceiling void (plenum return).' : 'No supply terminals yet.'}</p>}
    </div>
  );
}

function hints(system: AirSystem): string[] {
  const out: string[] = [];
  const returns = system.return.members;
  if (returns.length && !returns.some((member) => member.spec.filter)) {
    out.push(`Return filtration: none at the grilles. Unless ${system.tag} filters its air itself, fit M5 (≈ MERV 8) filter grilles: ASHRAE 62.1 §5.8 asks for MERV 8 upstream of a wet cooling coil.`);
  }
  const returnRooms = new Set(returns.map((member) => member.roomId).filter(Boolean));
  if (returnRooms.size > 1) {
    out.push(`The return serves ${returnRooms.size} rooms, so it carries sound between them (crosstalk): line its first metres or fit a crosstalk attenuator where privacy matters.`);
  }
  return out;
}

function UnitSystemCard({ unit, selectedIds }: { unit: HvacElement; selectedIds: readonly string[] }) {
  const { hvacElements, rooms } = useSmartDrawingStore((state) => ({ hvacElements: state.hvacElements, rooms: state.rooms }), shallow);
  const analysis = useMemo(() => analyseAirSystems(hvacElements, rooms), [hvacElements, rooms]);
  const { pickUnitId, setPickUnit, requestPlacement } = useAirSystemUiStore((state) => ({
    pickUnitId: state.pickUnitId, setPickUnit: state.setPickUnit, requestPlacement: state.requestPlacement,
  }), shallow);
  const system = analysis.byUnit.get(unit.id);
  const selectable = useMemo(() => selectedTerminalsForUnit(unit.id, selectedIds, hvacElements), [unit.id, selectedIds, hvacElements]);
  if (!system) return null;
  const roomNames = system.roomIds.map((id) => rooms.find((room) => room.id === id)?.name ?? 'a room');
  const picking = pickUnitId === unit.id;
  const unassignedInScene = analysis.unassigned.length;
  const place = (definitionId: string) => { if (definitionId) requestPlacement(definitionId, unit.id); };
  const select = 'min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1 py-0.5 text-[11px] text-slate-700';
  return (
    <div className="mb-2 space-y-1.5 rounded-lg border p-2" style={{ borderColor: `${system.color}66`, background: `${system.color}0d` }} data-testid="air-system-card">
      <div className="flex items-center justify-between gap-1">
        <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: system.color }}>
          <Network size={12} />Air system
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: system.color }} aria-hidden="true" />
          <TagEditor system={system} />
        </span>
      </div>
      <p className="text-[10px] text-slate-500">
        {system.airflowM3h ? `${Math.round(system.airflowM3h)} m³/h at Hi` : 'No airflow data: enter it in the Auto duct card'}
        {roomNames.length ? ` · serves ${roomNames.join(', ')}` : ''}
      </p>
      <ServiceGroup system={system} group={system.supply} />
      <ServiceGroup system={system} group={system.return} />
      <div className="flex gap-1" role="group" aria-label="Place terminals for this unit">
        <select className={select} value="" onChange={(event) => place(event.target.value)} aria-label={`Place a supply terminal for ${system.tag}`}>
          <option value="">+ Supply terminal…</option>
          {SUPPLY_ENTRIES.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
        </select>
        <select className={select} value="" onChange={(event) => place(event.target.value)} aria-label={`Place a return terminal for ${system.tag}`}>
          <option value="">+ Return terminal…</option>
          {RETURN_ENTRIES.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap gap-1">
        <button type="button" onClick={() => setPickUnit(picking ? null : unit.id)} aria-pressed={picking}
          title="Click terminals on the plan to add them to this system (or take them out); Esc stops"
          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${picking ? 'border-transparent text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
          style={picking ? { background: system.color } : undefined}>
          <MousePointerClick size={12} />{picking ? 'Picking… Done' : 'Pick on plan'}
        </button>
        {selectable.length ? (
          <button type="button" onClick={() => assignTerminalsToUnit(unit.id, selectable.map((terminal) => terminal.id))}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50">
            Assign {selectable.length} selected
          </button>
        ) : null}
        <button type="button" onClick={() => autoAssignTerminals({ unitId: unit.id })} disabled={!unassignedInScene}
          title="Assign the room's unassigned terminals to its ducted units, balanced by airflow and kept short (one undo)"
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-40">
          <Sparkles size={12} />Auto-assign room
        </button>
      </div>
      {hints(system).map((hint) => (
        <p key={hint} className="flex gap-1 text-[10px] leading-4 text-slate-600"><Info size={11} className="mt-0.5 shrink-0 text-slate-400" />{hint}</p>
      ))}
    </div>
  );
}

function TerminalSelectionCard({ terminals }: { terminals: HvacElement[] }) {
  const { hvacElements, rooms } = useSmartDrawingStore((state) => ({ hvacElements: state.hvacElements, rooms: state.rooms }), shallow);
  const analysis = useMemo(() => analyseAirSystems(hvacElements, rooms), [hvacElements, rooms]);
  if (!analysis.systems.length) return null;
  return (
    <div className="mb-2 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-2 text-[11px] text-slate-700" data-testid="air-system-selection-card">
      <Network size={12} className="shrink-0 text-slate-500" />
      <span className="shrink-0">{terminals.length} terminals:</span>
      <select className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1 py-0.5 text-[11px]" value="" aria-label="Assign the selected terminals to a unit"
        onChange={(event) => {
          if (event.target.value === '-') unassignTerminals(terminals.map((terminal) => terminal.id));
          else if (event.target.value) assignTerminalsToUnit(event.target.value, terminals.map((terminal) => terminal.id));
        }}>
        <option value="">Assign to…</option>
        {analysis.systems.map((system) => <option key={system.unit.id} value={system.unit.id}>{system.tag}</option>)}
        <option value="-">No system (unassign)</option>
      </select>
    </div>
  );
}

/** The card for the selection: one ducted unit's system, or a quick assign for several terminals. */
export function AirSystemCard() {
  const { hvacElements, selectedElementIds } = useSmartDrawingStore((state) => ({ hvacElements: state.hvacElements, selectedElementIds: state.selectedElementIds }), shallow);
  const selection = useMemo(() => {
    const selected = new Set(selectedElementIds);
    const chosen = hvacElements.filter((element) => selected.has(element.id));
    const units = chosen.filter(isAirSystemUnit);
    return { units, terminals: chosen.filter(isDuctTerminalElement) };
  }, [hvacElements, selectedElementIds]);
  if (selection.units.length === 1) return <UnitSystemCard unit={selection.units[0]!} selectedIds={selectedElementIds} />;
  if (!selection.units.length && selection.terminals.length > 1) return <TerminalSelectionCard terminals={selection.terminals} />;
  return null;
}
