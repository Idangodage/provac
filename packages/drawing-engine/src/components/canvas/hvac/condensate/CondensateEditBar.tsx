'use client';

/**
 * Contextual bar for the selected drain run (bottom centre of the board):
 * add a bend, re-route the run, place / remove rodding eyes, set the network
 * fall, upsize the run, set the riser height, lock, release to Auto route,
 * delete. Every action re-solves the network and commits as one undo step.
 */
import { CircleDot, Lock, LockOpen, Plus, RotateCcw, Route, Trash2 } from 'lucide-react';

import type { HvacElement } from '../../../../types';

import type { CondensateEditingApi } from './CondensateEditLayer';
import {
  addBendToRun,
  deleteDrainRun,
  releaseDrainNetwork,
  rerouteDrainRun,
  setNetworkFall,
  setRiserLimit,
  setRunLocked,
  setRunSize,
} from './condensateEditController';
import { isUnitBranchSpec } from './condensateEditing';
import { getCondensatePipeSystem } from './condensatePipeCatalog';
import { formatFallRatio } from './condensateSettings';
import { getCondensateOwnership, readCondensatePipeSpec } from './condensateTypes';

const FALLS = [1, 1.25, 1.5, 2, 2.5];
const RISERS = [150, 250, 350, 450, 600];

const button = 'inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40';
const select = 'rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700 focus:border-sky-600 focus:outline-none';

export function CondensateEditBar({ pipe, api, pumpMaxLiftMm }: { pipe: HvacElement; api: CondensateEditingApi; pumpMaxLiftMm: number }) {
  const spec = readCondensatePipeSpec(pipe);
  const owner = getCondensateOwnership(pipe);
  const branch = isUnitBranchSpec(spec);
  const system = getCondensatePipeSystem(spec.pipeSystem);
  const locked = spec.locked;
  const nodes = spec.routeNodes3d;
  const rise = branch && spec.pumped && nodes.length >= 3 ? Math.round(nodes[2]!.z - nodes[1]!.z) : 0;
  const fall = typeof pipe.properties.designFallPercent === 'number' ? String(pipe.properties.designFallPercent) : 'auto';
  const size = typeof pipe.properties.minOuterDiameterMm === 'number' ? String(pipe.properties.minOuterDiameterMm) : 'auto';
  const riser = typeof pipe.properties.riserLiftLimitMm === 'number' ? String(pipe.properties.riserLiftLimitMm) : 'auto';
  const busy = api.preview !== null;
  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 z-[26] flex max-w-[calc(100%-32px)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur"
      role="toolbar" aria-label="Edit drain run" data-testid="condensate-edit-bar"
      onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <span className="flex items-center gap-1.5 px-1 text-xs font-semibold text-sky-900"
        title="Drag bends, legs or the run · double-click adds a bend · right-click removes one · Shift = free · Esc cancels">
        <span className="h-2.5 w-2.5 rounded-full bg-sky-400" aria-hidden="true" />
        {branch ? 'Drain run' : spec.segmentRole === 'main' ? 'Drain main' : 'Drain drop'}
        <span className="font-normal text-slate-500">· {spec.nominalSize} · {formatFallRatio(spec.designSlopePercent)}{rise > 0 ? ` · riser ${rise}` : ''}</span>
        {owner?.editPolicy === 'retain' ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800" title="Hand-edited: Auto route keeps this network">Edited</span> : null}
        {locked ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">Locked</span> : null}
      </span>
      <span className="h-5 border-l border-slate-200" aria-hidden="true" />
      <button type="button" className={button} disabled={locked || busy} onClick={() => addBendToRun(pipe)} title="Add a bend in the middle of the longest leg">
        <Plus size={13} /> Bend
      </button>
      <button type="button" className={button} disabled={locked || busy || !branch} onClick={() => rerouteDrainRun(pipe)}
        title={branch ? 'Route this unit\'s drain again onto the network' : 'Re-route works on a unit\'s drain run'}>
        <Route size={13} /> Re-route
      </button>
      <button type="button" className={`${button} ${api.eyeMode ? 'bg-sky-50 text-sky-800' : ''}`} aria-pressed={api.eyeMode} disabled={locked || busy}
        onClick={() => api.setEyeMode(!api.eyeMode)} title="Click on the run to place a rodding eye; click an eye to remove it">
        <CircleDot size={13} /> Rodding eye
      </button>
      <label className="flex items-center gap-1 text-xs text-slate-500" title="Design fall for this whole network (never below the code minimum)">
        Fall
        <select className={select} value={fall} disabled={locked || busy} aria-label="Network fall"
          onChange={(event) => setNetworkFall(pipe, event.target.value === 'auto' ? null : Number(event.target.value))}>
          <option value="auto">Auto</option>
          {FALLS.map((value) => <option key={value} value={value}>{formatFallRatio(value)}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-slate-500" title="Upsize this run (never below the size its load needs)">
        Size
        <select className={select} value={size} disabled={locked || busy} aria-label="Run size"
          onChange={(event) => setRunSize(pipe, event.target.value === 'auto' ? null : Number(event.target.value))}>
          <option value="auto">Auto</option>
          {system.sizes.filter((entry) => entry.outerDiameterMm >= spec.outerDiameterMm - 0.01 || String(entry.outerDiameterMm) === size)
            .map((entry) => <option key={entry.nominalSize} value={entry.outerDiameterMm}>{entry.nominalSize}</option>)}
        </select>
      </label>
      {branch && spec.pumped ? (
        <label className="flex items-center gap-1 text-xs text-slate-500" title="Riser height above the drain outlet (Auto = the high point)">
          Riser
          <select className={select} value={riser} disabled={locked || busy} aria-label="Riser height"
            onChange={(event) => setRiserLimit(pipe, event.target.value === 'auto' ? null : Number(event.target.value))}>
            <option value="auto">High point</option>
            {RISERS.filter((value) => value <= pumpMaxLiftMm).map((value) => <option key={value} value={value}>{value} mm</option>)}
          </select>
        </label>
      ) : null}
      <span className="h-5 border-l border-slate-200" aria-hidden="true" />
      <button type="button" className={button} disabled={busy} onClick={() => setRunLocked(pipe, !locked)} title={locked ? 'Allow edits to this run' : 'Keep this run exactly as it is'}>
        {locked ? <LockOpen size={13} /> : <Lock size={13} />} {locked ? 'Unlock' : 'Lock'}
      </button>
      {owner?.editPolicy === 'retain' ? (
        <button type="button" className={button} disabled={busy} onClick={() => releaseDrainNetwork(pipe)} title="Let Auto route regenerate this network">
          <RotateCcw size={13} /> Release
        </button>
      ) : null}
      <button type="button" className={`${button} text-red-700 hover:bg-red-50`} disabled={locked || busy} onClick={() => deleteDrainRun(pipe)}
        title={branch ? 'Delete this unit\'s drain run; the network re-solves' : 'Delete this drain network'}>
        <Trash2 size={13} /> Delete
      </button>
    </div>
  );
}
