'use client';

import { useEffect, useState } from 'react';

import { useSmartDrawingStore } from '../../../store';
import type { ManufacturerRuleProfile } from '../../../vrf/rules';

import { AutoRouteNetworkAction } from './AutoRouteNetworkAction';
import type { PipeRoutingSettings } from './pipeRoutingSettings';

interface PipeRoutingToolbarProps {
  ruleProfile?: ManufacturerRuleProfile;
  drawing: boolean;
  placingKit: boolean;
  kitKind: 'gas' | 'liquid' | 'both';
  onKitKindChange: (kind: 'gas' | 'liquid' | 'both') => void;
  onPlaceKit: () => void;
}

function DefaultDistance({ label, value, min, max, onCommit }: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const number = draft.trim() ? Number(draft) : NaN;
    if (!Number.isFinite(number) || number < min || number > max) {
      setDraft(String(value));
      return;
    }
    if (number !== value) onCommit(number);
  };
  return (
    <label className="flex items-center justify-between gap-4 text-xs text-slate-600">
      {label}
      <span className="flex items-center gap-1.5 text-slate-400">
        <input
          type="number" min={min} max={max} step="any" value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') { event.preventDefault(); setDraft(String(value)); }
          }}
          className="w-20 rounded-md border border-slate-200 px-2 py-1.5 text-right text-slate-800 outline-none focus:border-teal-500"
        />
        mm
      </span>
    </label>
  );
}

/** Only model-backed controls belong on the drawing surface. Advanced defaults
 * are disclosed on demand; each numeric change commits once, on blur/Enter. */
export function PipeRoutingToolbar(props: PipeRoutingToolbarProps) {
  const settings = useSmartDrawingStore((state) => state.pipeRoutingSettings);
  const setSettings = useSmartDrawingStore((state) => state.setPipeRoutingSettings);
  const lineMode = useSmartDrawingStore((state) => state.refrigerantPipeLineMode);
  const setLineMode = useSmartDrawingStore((state) => state.setRefrigerantPipeLineMode);
  const [showDefaults, setShowDefaults] = useState(false);
  const update = (key: keyof PipeRoutingSettings) => (value: number) => setSettings({ [key]: value });

  return (
    <div
      className="absolute left-3 top-12 max-w-[calc(100%-24px)] rounded-xl border border-slate-200 bg-white/95 text-slate-700 shadow-sm backdrop-blur"
      style={{ pointerEvents: 'auto', zIndex: 20 }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      data-testid="pipe-routing-toolbar"
    >
      <div role="toolbar" aria-label="Refrigerant routing" className="flex flex-wrap items-center gap-2 p-2">
        <span className="px-1 text-xs font-semibold">Refrigerant</span>
        {props.drawing ? (
          <select
            aria-label="Pipes to draw" value={lineMode}
            onChange={(event) => setLineMode(event.target.value as 'pair' | 'gas' | 'liquid')}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs"
          >
            <option value="pair">Gas + liquid</option>
            <option value="gas">Gas only</option>
            <option value="liquid">Liquid only</option>
          </select>
        ) : (
          <span className="flex gap-3 px-1 text-xs">
            <span><span className="mr-1 text-blue-600">●</span>Gas</span>
            <span><span className="mr-1 text-amber-600">●</span>Liquid</span>
          </span>
        )}
        <button type="button" aria-expanded={showDefaults} onClick={() => setShowDefaults(!showDefaults)}
          className="rounded-lg px-2 py-1.5 text-xs hover:bg-slate-100">
          Route defaults <span aria-hidden="true">{showDefaults ? '▴' : '▾'}</span>
        </button>
        <button type="button" aria-pressed={props.placingKit} onClick={props.onPlaceKit}
          title="Place a copper branch fitting at an open compatible pipe end"
          className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${props.placingKit ? 'bg-teal-700 text-white' : 'bg-amber-50 text-amber-800 hover:bg-amber-100'}`}>
          {props.placingKit ? 'Cancel placement' : 'Branch kit'}
        </button>
        {props.placingKit ? (
          <select aria-label="Branch kit services" value={props.kitKind}
            onChange={(event) => props.onKitKindChange(event.target.value as 'gas' | 'liquid' | 'both')}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs">
            <option value="both">Gas + liquid kits</option>
            <option value="gas">Gas kit</option>
            <option value="liquid">Liquid kit</option>
          </select>
        ) : null}
        <AutoRouteNetworkAction profile={props.ruleProfile} disabled={props.placingKit} />
      </div>
      {showDefaults ? (
        <div className="space-y-2.5 border-t border-slate-100 p-3">
          <p className="max-w-80 text-xs leading-5 text-slate-500">Defaults for new routes. Equipment connections keep their actual port levels.</p>
          <DefaultDistance label="Clear gap outside insulation" value={settings.defaultPipeGapMm} min={0} max={600} onCommit={update('defaultPipeGapMm')} />
          <DefaultDistance label="Clearance at service crossings" value={settings.zOffsetClearanceMm} min={0} max={600} onCommit={update('zOffsetClearanceMm')} />
          <DefaultDistance label="Free route level above floor" value={settings.defaultPipeElevationMm} min={0} max={100000} onCommit={update('defaultPipeElevationMm')} />
          <DefaultDistance label="Straight length at unit port" value={settings.minimumPortStubMm} min={0} max={2000} onCommit={update('minimumPortStubMm')} />
          <label className="flex items-center justify-between gap-4 text-xs text-slate-600">
            Fitting view
            <select aria-label="Fitting view" value={settings.fittingDisplay}
              onChange={event => setSettings({ fittingDisplay: event.target.value as 'copper' | 'insulated' })}
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-slate-800">
              <option value="copper">Copper detail</option>
              <option value="insulated">Insulated</option>
            </select>
          </label>
          <p className="max-w-80 text-[11px] leading-4 text-slate-400">90° and 45° turns use C×C socket elbows where they fit. Copper detail hides fitting covers for inspection. Planning profiles still need project part selection.</p>
        </div>
      ) : null}
    </div>
  );
}
