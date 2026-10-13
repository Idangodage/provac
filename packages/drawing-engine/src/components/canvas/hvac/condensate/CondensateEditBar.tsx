'use client';

/**
 * Contextual bar for the selected drain run (bottom centre of the board): the
 * run's and the network's own tools — re-route the run, place / remove rodding
 * eyes by clicking on it, lock, release to Auto route, delete. A piece's size,
 * the network's fall, a riser's height, a level limit and bends are on the
 * piece's segment card (click the piece), previewed before they are applied.
 * Every action re-solves the network and commits as one undo step.
 */
import { CircleDot, Lock, LockOpen, RotateCcw, Route, Trash2 } from 'lucide-react';

import type { HvacElement } from '../../../../types';

import type { CondensateEditingApi } from './CondensateEditLayer';
import {
  deleteDrainRun,
  releaseDrainNetwork,
  rerouteDrainRun,
  setRunLocked,
} from './condensateEditController';
import { isUnitBranchSpec } from './condensateEditing';
import { formatFallRatio } from './condensateSettings';
import { getCondensateOwnership, readCondensatePipeSpec } from './condensateTypes';

const button = 'inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40';

export function CondensateEditBar({ pipe, api, surface }: {
  pipe: HvacElement;
  api: CondensateEditingApi;
  /** The drag surface of the current 3D view (XY / XZ / YZ); absent on the 2D board. */
  surface?: string;
}) {
  const spec = readCondensatePipeSpec(pipe);
  const owner = getCondensateOwnership(pipe);
  const branch = isUnitBranchSpec(spec);
  const locked = spec.locked;
  const nodes = spec.routeNodes3d;
  const rise = branch && spec.pumped && nodes.length >= 3 ? Math.round(nodes[2]!.z - nodes[1]!.z) : 0;
  const busy = api.preview !== null;
  const levelCap = typeof pipe.properties.levelCapMm === 'number' ? pipe.properties.levelCapMm : null;
  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 z-[26] flex max-w-[calc(100%-32px)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur"
      role="toolbar" aria-label="Edit drain run" data-testid="condensate-edit-bar"
      onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <span className="flex items-center gap-1.5 px-1 text-xs font-semibold text-sky-900"
        title="Drag bends, legs or the run · double-click adds a bend · right-click removes one · click a piece for its card (size, fall, riser, level) · Shift = free · Esc cancels">
        <span className="h-2.5 w-2.5 rounded-full bg-sky-400" aria-hidden="true" />
        {branch ? 'Drain run' : spec.segmentRole === 'main' ? 'Drain main' : 'Drain drop'}
        <span className="font-normal text-slate-500">· {spec.nominalSize} · {formatFallRatio(spec.designSlopePercent)}{rise > 0 ? ` · riser ${rise}` : ''}</span>
        {owner?.editPolicy === 'retain' ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800" title="Hand-edited: Auto route keeps this network">Edited</span> : null}
        {locked ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">Locked</span> : null}
        {surface ? <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-800" title="A plain drag moves on this surface; the gizmo on the active handle offers X, Y, Z and the other surfaces">Surface {surface}</span> : null}
      </span>
      {levelCap !== null ? (
        <span className="flex items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-1 text-[11px] text-indigo-800" title="This run stays at or below this level; the fall re-solves around it. A leg's card changes or removes it">
          Level ≤ {Math.round(levelCap)}
        </span>
      ) : null}
      <span className="h-5 border-l border-slate-200" aria-hidden="true" />
      <button type="button" className={button} disabled={locked || busy || !branch} onClick={() => rerouteDrainRun(pipe)}
        title={branch ? 'Route this unit\'s drain again onto the network' : 'Re-route works on a unit\'s drain run'}>
        <Route size={13} /> Re-route
      </button>
      <button type="button" className={`${button} ${api.eyeMode ? 'bg-sky-50 text-sky-800' : ''}`} aria-pressed={api.eyeMode} disabled={locked || busy}
        onClick={() => api.setEyeMode(!api.eyeMode)} title="Click on the run to place a rodding eye; click an eye to remove it">
        <CircleDot size={13} /> Rodding eye
      </button>
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
