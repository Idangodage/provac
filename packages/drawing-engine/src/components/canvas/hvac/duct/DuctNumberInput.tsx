'use client';

import { useId, useState } from 'react';

import { parseDuctNumber } from './ductNumericValue';

/** Shared numeric editing for sizing, fabrication settings and terminal airflow. */
export function DuctNumberInput({ value, onChange, step, min, max, label, live = false, allowEmpty = false, steppers = false, derived = false, placeholder, className = 'w-16' }: {
  value: number | null;
  onChange: (value: number | null) => void;
  step: number;
  min: number;
  max: number;
  label: string;
  live?: boolean;
  allowEmpty?: boolean;
  steppers?: boolean;
  derived?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [badInput, setBadInput] = useState(false);
  const parsed = draft === null ? null : parseDuctNumber(draft, min, max, allowEmpty);
  const error = badInput ? 'Enter a number.' : parsed && !parsed.valid ? parsed.message : null;
  const commit = (next: number | null) => {
    if (next !== value) onChange(next);
  };
  const nudge = (direction: -1 | 1) => {
    const base = parsed?.valid ? parsed.value : value;
    // Round only floating-point step noise; typed values retain their precision.
    const next = Number(Math.min(max, Math.max(min, (base ?? 0) + direction * step)).toPrecision(12));
    setDraft(null);
    setBadInput(false);
    commit(next);
  };
  return (
    <span className="inline-flex flex-col items-end">
      <span className={`inline-flex items-center rounded border bg-white ${error ? 'border-red-400' : 'border-slate-200'}`}>
        {steppers ? <button type="button" aria-label={`${label} down`} onClick={() => nudge(-1)} className="px-1 text-[11px] text-slate-500 hover:text-slate-900">−</button> : null}
        <input
          type="number" step={step} min={min} max={max} required={!allowEmpty} aria-label={label}
          aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
          placeholder={placeholder}
          value={draft ?? (value === null ? '' : String(Number(value.toPrecision(12))))}
          onChange={(event) => {
            const text = event.target.value;
            const invalid = event.target.validity.badInput;
            setDraft(text);
            setBadInput(invalid);
            const next = parseDuctNumber(text, min, max, allowEmpty);
            if (live && !invalid && next.valid) commit(next.value);
          }}
          onBlur={() => {
            if (parsed?.valid && !badInput) {
              commit(parsed.value);
              setDraft(null);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setDraft(null);
              setBadInput(false);
            }
          }}
          className={`${className} rounded px-1 text-right text-xs ${steppers ? 'border-x border-slate-200' : ''} ${derived ? 'italic text-slate-500' : 'text-slate-900'}`}
        />
        {steppers ? <button type="button" aria-label={`${label} up`} onClick={() => nudge(1)} className="px-1 text-[11px] text-slate-500 hover:text-slate-900">+</button> : null}
      </span>
      {error ? <span id={errorId} role="status" className="mt-0.5 max-w-36 text-[10px] text-red-600">{error} Escape restores the current value.</span> : null}
    </span>
  );
}
