'use client';

/**
 * "Rotate" for the selection: quarter and half turns, an exact angle, and
 * "each in place" for several, turned through the same model as `R` and the
 * rotation grip (rules for the whole selection, what is attached follows, one
 * undo step). Also the Rotation field of a unit's properties, which turns it
 * to the angle typed.
 */
import { RotateCcw, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { requestHvacRotate } from './hvacMoveBus';
import { isTurnableElement } from './hvacMoveModel';

/** An angle in (−180, 180]: the shorter way round to the same orientation. */
export function shortestTurnDeg(angleDeg: number): number {
  const wrapped = ((((angleDeg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

function parseDegrees(text: string): number | null {
  const value = Number.parseFloat(text.replace(',', '.').replace('°', ''));
  return Number.isFinite(value) ? value : null;
}

const formatDegrees = (value: number) => `${Math.round(value * 10) / 10}`;

const button = 'flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

export function HvacRotateSection() {
  const { selectedElementIds, hvacElements } = useSmartDrawingStore(
    (state) => ({ selectedElementIds: state.selectedElementIds, hvacElements: state.hvacElements }),
    shallow,
  );
  const turnable = useMemo(() => {
    const selected = new Set(selectedElementIds);
    return hvacElements.filter((element) => selected.has(element.id) && isTurnableElement(element));
  }, [hvacElements, selectedElementIds]);
  const [typed, setTyped] = useState('');
  const [each, setEach] = useState(false);
  const several = turnable.length > 1;
  const pivot = several && each ? 'each' as const : 'group' as const;
  const angle = parseDegrees(typed);
  const turn = (angleDeg: number) => requestHvacRotate({ angleDeg, pivot });
  if (turnable.length === 0) {
    return <p className="text-[11px] leading-4 text-slate-500">Select a unit or an air terminal to turn it: duct runs, pipes and drains follow what they are attached to.</p>;
  }
  return (
    <form
      className="space-y-2"
      data-testid="hvac-rotate-section"
      onSubmit={(event) => {
        event.preventDefault();
        if (angle !== null && Math.abs(angle) > 1e-6 && turn(angle)) setTyped('');
      }}
    >
      <p className="text-[11px] leading-4 text-slate-500">
        {several ? `Turn the ${turnable.length} units and terminals ${each ? 'each about its own centre' : 'as one block about their centre'}.` : `Turn ${turnable[0]!.label || 'it'} about its centre (now ${formatDegrees(turnable[0]!.rotation ?? 0)}°).`}
        {' '}Ducts, pipes and drains follow; its rules hold. <kbd className="rounded border border-slate-200 px-1 font-mono text-[10px]">R</kbd> / <kbd className="rounded border border-slate-200 px-1 font-mono text-[10px]">Shift R</kbd> turn 90° on the canvas.
      </p>
      <div className="flex gap-1.5">
        <button type="button" className={button} onClick={() => turn(-90)} aria-label="Turn 90° anticlockwise" title="90° anticlockwise (Shift + R)">
          <RotateCcw size={14} aria-hidden="true" />90°
        </button>
        <button type="button" className={button} onClick={() => turn(180)} aria-label="Turn 180°" title="Half turn">
          180°
        </button>
        <button type="button" className={button} onClick={() => turn(90)} aria-label="Turn 90° clockwise" title="90° clockwise (R)">
          <RotateCw size={14} aria-hidden="true" />90°
        </button>
      </div>
      <div className="flex items-end gap-1.5">
        <label className="flex min-w-0 flex-1 flex-col gap-0.5" title="Degrees: + clockwise, − anticlockwise on the plan">
          <span className="text-[10px] font-semibold text-slate-500">Turn by (°, + clockwise)</span>
          <input
            type="text"
            inputMode="decimal"
            value={typed}
            placeholder="0"
            aria-label="Turn by degrees"
            onChange={(event) => setTyped(event.target.value)}
            className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-right font-mono text-xs tabular-nums text-slate-700 focus:border-teal-400 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
          />
        </label>
        <button
          type="submit"
          disabled={angle === null || Math.abs(angle) < 1e-6}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-teal-700 px-3 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1"
        >
          <RotateCw size={14} aria-hidden="true" />
          Turn
        </button>
      </div>
      {several && (
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={each} onChange={(event) => setEach(event.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 text-teal-700 focus:ring-teal-500" />
          Turn each in place
        </label>
      )}
    </form>
  );
}

/**
 * A unit's Rotation as a field: typing an angle and pressing Enter (or
 * leaving the field) turns it there through the move model.
 */
export function HvacRotationField({ element, className }: { element: Pick<HvacElement, 'id' | 'rotation'>; className?: string }) {
  const current = element.rotation ?? 0;
  const [draft, setDraft] = useState(formatDegrees(current));
  useEffect(() => setDraft(formatDegrees(current)), [current]);
  const commit = () => {
    const target = parseDegrees(draft);
    const turnBy = target === null ? 0 : shortestTurnDeg(target - current);
    if (Math.abs(turnBy) < 1e-6 || !requestHvacRotate({ angleDeg: turnBy, pivot: 'group' })) setDraft(formatDegrees(current));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label="Rotation in degrees"
      title="Degrees clockwise on the plan: Enter turns it there (its ducts, pipes and drains follow)"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { event.preventDefault(); setDraft(formatDegrees(current)); }
      }}
      className={className}
    />
  );
}
