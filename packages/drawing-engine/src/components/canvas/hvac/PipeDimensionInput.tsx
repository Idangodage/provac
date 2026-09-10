'use client';
import { useEffect, useRef, useState } from 'react';

import { fromMillimeters, getUnitLabel, toMillimeters, type LinearUnit } from '../scale';

/** Shared temporary dimension and toolbar input. One edit commits on Enter or
 * blur; Escape restores the displayed model measurement without saving. */
export function PipeDimensionInput({ valueMm, unit, onCommit, disabled = false, label = 'Segment length' }: {
  valueMm: number; unit: LinearUnit; onCommit: (millimeters: number) => boolean; disabled?: boolean; label?: string;
}) {
  const display = String(Number(fromMillimeters(valueMm, unit).toFixed(3)));
  const [draft, setDraft] = useState(display);
  const skipBlur = useRef(false);
  useEffect(() => setDraft(display), [display]);
  const apply = () => {
    const value = draft.trim() ? toMillimeters(Number(draft), unit) : NaN;
    if (draft !== display && (!Number.isFinite(value) || value <= 0 || !onCommit(value))) setDraft(display);
  };
  return <label className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow-sm">
    <input aria-label={label} title="Enter a length · Enter to apply · Escape to cancel" type="number" min="0" step="any" value={draft} disabled={disabled}
      onFocus={event => { skipBlur.current = false; event.currentTarget.select(); }} onChange={event => setDraft(event.target.value)}
      onBlur={() => { if (!skipBlur.current) apply(); skipBlur.current = false; }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); skipBlur.current = true; setDraft(display); event.currentTarget.blur(); }
        if (event.key === 'Enter') { event.preventDefault(); skipBlur.current = true; apply(); event.currentTarget.blur(); }
      }} className="w-16 min-w-0 bg-transparent text-right font-medium text-slate-800 outline-none disabled:text-slate-400" />
    <span className="text-[10px] text-slate-400">{getUnitLabel(unit)}</span>
  </label>;
}
