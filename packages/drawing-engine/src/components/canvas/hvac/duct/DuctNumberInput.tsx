'use client';

import { Minus, Plus } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { parseDuctNumber } from './ductNumericValue';

/**
 * How the field is drawn: `default` (the settings panels), `tile` (a large
 * figure inside a sizing tile, its frame the tile's), `compact` (a small
 * figure inside a tile: the velocity limits) or `cell` (a framed table cell:
 * a terminal's airflow, the system airflow). Behaviour is the same for all.
 */
export type DuctNumberInputVariant = 'default' | 'tile' | 'compact' | 'cell';

/** Hides the browser's own spin buttons: the steppers (or the arrow keys) step the value. */
const NO_SPIN = '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

/** Shared numeric editing for sizing, fabrication settings and terminal airflow. */
export function DuctNumberInput({ value, onChange, step, min, max, label, live = false, allowEmpty = false, steppers = false, derived = false, digits, displayDigits, placeholder, className = 'w-16', variant = 'default', suffix, testId }: {
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
  /** Decimals a derived value is shown (and nudged from) with; typed values keep their own. */
  digits?: number;
  /** At least this many decimals shown (5.0, 0.80); a value with more keeps them. */
  displayDigits?: number;
  placeholder?: string;
  className?: string;
  variant?: DuctNumberInputVariant;
  /** Inside the frame after the number (a cell's unit). */
  suffix?: ReactNode;
  testId?: string;
}) {
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [badInput, setBadInput] = useState(false);
  const parsed = draft === null ? null : parseDuctNumber(draft, min, max, allowEmpty);
  const error = badInput ? 'Enter a number.' : parsed && !parsed.valid ? parsed.message : null;
  // A value that follows from another (e.g. the friction rate at a set velocity) reads rounded: 0.45, not 0.448.
  const shown = value === null ? null : derived && digits !== undefined ? Number(value.toFixed(digits)) : Number(value.toPrecision(12));
  const shownText = shown === null ? '' : displayDigits === undefined ? String(shown)
    : shown.toFixed(Math.max(displayDigits, String(shown).split('.')[1]?.length ?? 0));
  const commit = (next: number | null) => {
    if (next !== value) onChange(next);
  };
  const nudge = (direction: -1 | 1) => {
    const base = parsed?.valid ? parsed.value : shown;
    // Round only floating-point step noise; typed values retain their precision.
    const next = Number(Math.min(max, Math.max(min, (base ?? 0) + direction * step)).toPrecision(12));
    setDraft(null);
    setBadInput(false);
    commit(next);
  };
  const plain = variant === 'default';
  const frame = plain ? `inline-flex items-center rounded border bg-white ${error ? 'border-red-400' : 'border-slate-200'}`
    : variant === 'cell' ? `inline-flex h-6 items-center rounded-[7px] border bg-white transition-colors ${error ? 'border-red-400' : 'border-slate-200 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-100'}`
      : `flex w-full min-w-0 items-center rounded-md ${error ? 'ring-1 ring-red-400' : ''}`;
  const input = plain
    ? `${className} rounded px-1 text-right text-xs ${steppers ? 'border-x border-slate-200' : ''} ${derived ? 'italic text-slate-500' : 'text-slate-900'}`
    : variant === 'cell'
      ? `${className} min-w-0 bg-transparent px-1.5 text-right text-xs font-medium tabular-nums outline-none placeholder:font-normal placeholder:italic placeholder:text-slate-400 ${NO_SPIN} ${derived ? 'italic text-slate-500' : 'text-slate-900'}`
      : `${className} min-w-0 flex-1 bg-transparent text-center tabular-nums outline-none ${NO_SPIN} ${variant === 'tile' ? 'text-[15px]' : 'text-[12.5px]'} ${derived ? 'font-medium italic text-slate-500' : 'font-semibold text-slate-900'}`;
  const stepper = (direction: -1 | 1) => (plain ? (
    <button type="button" aria-label={`${label} ${direction < 0 ? 'down' : 'up'}`} onClick={() => nudge(direction)} className="px-1 text-[11px] text-slate-500 hover:text-slate-900">
      {direction < 0 ? '−' : '+'}
    </button>
  ) : (
    <button type="button" aria-label={`${label} ${direction < 0 ? 'down' : 'up'}`} onClick={() => nudge(direction)}
      className="flex h-5 w-4 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-white hover:text-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
      {direction < 0 ? <Minus size={10} aria-hidden="true" /> : <Plus size={10} aria-hidden="true" />}
    </button>
  ));
  return (
    <span className={`${plain || variant === 'cell' ? 'inline-flex' : 'flex w-full min-w-0'} flex-col items-end`} data-testid={testId}>
      <span className={frame}>
        {steppers ? stepper(-1) : null}
        <input
          type="number" step={step} min={min} max={max} required={!allowEmpty} aria-label={label}
          aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
          placeholder={placeholder}
          value={draft ?? shownText}
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
          className={input}
        />
        {suffix ? <span className="shrink-0 pr-1.5 text-[10px] text-slate-400">{suffix}</span> : null}
        {steppers ? stepper(1) : null}
      </span>
      {error ? (
        <span id={errorId} role="status" className={`mt-0.5 max-w-36 text-[10px] text-red-600 ${plain ? '' : 'text-right leading-3'}`}>{error} Escape restores the current value.</span>
      ) : null}
    </span>
  );
}
