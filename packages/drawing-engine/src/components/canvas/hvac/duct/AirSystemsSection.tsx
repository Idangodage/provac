'use client';

/**
 * Systems → Air systems: every ducted unit's supply and return system at a
 * glance (terminals, balance, rooms, how many are ducted), the terminals in no
 * system with a balanced Auto-assign for the whole drawing, the plan display,
 * the assignment and placement rules, and the air terminal schedule (CSV).
 */
import { AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';

import { CopyButton, SettingNumber } from './DuctPanels';
import { autoAssignTerminals } from './airSystemController';
import { AIR_BALANCE_TOLERANCE } from './ductAirSystemChecks';
import { airTerminalSchedule, airTerminalScheduleToCsv, analyseAirSystems, terminalTagOf, type AirSystem } from './ductAirSystems';
import { readDuctTerminalSpec } from './ductTerminals';

function SystemSummary({ system, roomNames }: { system: AirSystem; roomNames: ReadonlyMap<string, string> }) {
  const selectElement = useSmartDrawingStore((state) => state.selectElement);
  const line = (group: AirSystem['supply']) => {
    const airflow = system.airflowM3h;
    const ok = !airflow || !group.members.length || Math.abs(group.totalM3h - airflow) <= airflow * AIR_BALANCE_TOLERANCE;
    return (
      <span className={ok ? 'text-slate-600' : 'text-amber-700'}>
        {group.members.length} · {group.connected} ducted{group.members.length ? ` · ${Math.round(group.totalM3h)} m³/h` : ''}
      </span>
    );
  };
  const healthy = [...system.supply.members, ...system.return.members].every((member) => !member.mismatch && !member.serviceMismatch);
  return (
    <li className="rounded-md border border-slate-200 bg-white p-1.5 text-[11px]" data-air-system-summary={system.unit.id}>
      <div className="flex items-center justify-between gap-1">
        <button type="button" onClick={() => selectElement(system.unit.id)} className="flex items-center gap-1 font-semibold text-slate-800 hover:underline"
          title="Select the unit: its Air system card shows every terminal">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: system.color }} aria-hidden="true" />
          {system.tag}
        </button>
        {healthy ? <CheckCircle2 size={12} className="text-emerald-600" aria-label="No system conflicts" /> : <AlertTriangle size={12} className="text-red-600" aria-label="A terminal is ducted from another unit" />}
      </div>
      <div className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 text-[10px]">
        <span className="text-blue-800">Supply</span>{line(system.supply)}
        <span className="text-teal-800">Return</span>{line(system.return)}
      </div>
      {system.roomIds.length ? <p className="mt-0.5 text-[10px] text-slate-500">{system.roomIds.map((id) => roomNames.get(id) ?? 'room').join(', ')}</p> : null}
    </li>
  );
}

export function AirSystemsSection() {
  const { hvacElements, rooms, ductSettings, setDuctSettings } = useSmartDrawingStore((state) => ({
    hvacElements: state.hvacElements, rooms: state.rooms, ductSettings: state.ductSettings, setDuctSettings: state.setDuctSettings,
  }), shallow);
  const analysis = useMemo(() => analyseAirSystems(hvacElements, rooms), [hvacElements, rooms]);
  const roomNames = useMemo(() => new Map(rooms.map((room) => [room.id, room.name])), [rooms]);
  const schedule = useMemo(() => airTerminalSchedule(analysis, ductSettings, roomNames), [analysis, ductSettings, roomNames]);
  const unassignedTags = analysis.unassigned.map((terminal) => {
    const spec = readDuctTerminalSpec(terminal);
    return spec ? terminalTagOf(terminal, spec) : terminal.label;
  });
  return (
    <div className="space-y-2" data-testid="air-systems-section">
      <p className="text-[11px] leading-4 text-slate-500">
        Each ducted unit serves the supply and return terminals dedicated to it. Auto duct and Auto route connect a unit to its own terminals only.
      </p>
      {analysis.systems.length ? (
        <ul className="space-y-1">{analysis.systems.map((system) => <SystemSummary key={system.unit.id} system={system} roomNames={roomNames} />)}</ul>
      ) : <p className="text-xs text-slate-500">No ducted units in the drawing yet.</p>}
      <div className="rounded-md border border-slate-200 bg-white p-1.5 text-[11px]">
        <div className="flex items-center justify-between gap-1">
          <span className="font-medium text-slate-700">In no system: {analysis.unassigned.length}</span>
          <button type="button" disabled={!analysis.unassigned.length || !analysis.systems.length} onClick={() => autoAssignTerminals()}
            title="Assign every terminal in no system to a ducted unit: in its room when the room has one (balanced by airflow, shortest ducts), else the nearest unit through the walls. One undo."
            className="inline-flex items-center gap-1 rounded-md bg-sky-700 px-1.5 py-0.5 text-[11px] font-medium text-white hover:bg-sky-800 disabled:opacity-40">
            <Sparkles size={12} />Auto-assign all
          </button>
        </div>
        {unassignedTags.length ? <p className="mt-0.5 break-words text-[10px] text-slate-500">{unassignedTags.join(', ')}</p> : null}
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-slate-700">
        <input type="checkbox" checked={ductSettings.showAirSystems} onChange={(event) => setDuctSettings({ showAirSystems: event.target.checked })}
          aria-label="Show every air system on the plan" />
        Show every air system on the plan (otherwise the selected one)
      </label>
      <div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Rules</div>
      <SettingNumber settingKey="returnSupplyMinGapMm" label="Return ↔ supply gap at least" step={100} min={0} max={10000} />
      <SettingNumber settingKey="autoAssignWallPenaltyMm" label="Auto-assign: a wall costs" step={500} min={0} max={100000} />
      <SettingNumber settingKey="autoAssignOverloadMm" label="Auto-assign: over a fair share costs" step={500} min={0} max={100000} />
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Air terminal schedule</span>
        <CopyButton text={airTerminalScheduleToCsv(schedule)} label="Copy CSV" />
      </div>
      {schedule.length ? (
        <ul className="space-y-0.5 text-[10px] text-slate-600" data-testid="air-terminal-schedule">
          {schedule.map((row) => (
            <li key={`${row.system}:${row.tag}`} className="rounded px-1 py-0.5 odd:bg-slate-50">
              <span className="font-medium text-slate-800">{row.tag}</span>
              <span className={row.service === 'supply' ? 'text-blue-800' : 'text-teal-800'}> · {row.system || 'no system'} {row.service}</span>
              <span> · {row.type} {row.face} · Ø{row.neckMm}</span>
              <span className="block">
                {row.airflowM3h} m³/h{row.fixed ? '' : ' (share)'} · {row.neckVelocityMs} m/s · {row.pressureDropPa} Pa{row.filter ? ` · ${row.filter}` : ''}{row.room ? ` · ${row.room}` : ''} · {row.status}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-slate-500">No air terminals yet.</p>}
    </div>
  );
}
