'use client';

/**
 * "Move by" for the selection: an exact Δx, Δy and Δz, moved through the same
 * model as a drag or the arrow keys (rules for the whole selection, what is
 * attached follows, one undo step).
 */
import { MoveRight } from 'lucide-react';
import { useState } from 'react';

import { toMillimeters, type LinearUnit } from '../../scale';

import { requestHvacMove } from './hvacMoveBus';

const AXES = [
  { key: 'x', label: 'Δx', hint: 'right (+) or left (−) on the plan' },
  { key: 'y', label: 'Δy', hint: 'down (+) or up (−) on the plan' },
  { key: 'z', label: 'Δz', hint: 'up (+) or down (−): ducted units and duct straights only' },
] as const;

type Axis = (typeof AXES)[number]['key'];

export function HvacMoveSection({ unit }: { unit: Extract<LinearUnit, 'mm' | 'in' | 'ft'> }) {
  const [values, setValues] = useState<Record<Axis, string>>({ x: '', y: '', z: '' });
  const parsed = (axis: Axis) => {
    const value = Number.parseFloat(values[axis].replace(',', '.'));
    return Number.isFinite(value) ? toMillimeters(value, unit) : 0;
  };
  const delta = { x: parsed('x'), y: parsed('y'), z: parsed('z') };
  const empty = Math.hypot(delta.x, delta.y, delta.z) < 0.01;
  const move = () => {
    if (empty) return;
    if (requestHvacMove(delta)) setValues({ x: '', y: '', z: '' });
  };
  return (
    <form
      className="space-y-2"
      data-testid="hvac-move-section"
      onSubmit={(event) => {
        event.preventDefault();
        move();
      }}
    >
      <p className="text-[11px] leading-4 text-slate-500">
        Move the selection by an exact distance. What it is attached to follows, and its rules hold.
      </p>
      <div className="grid grid-cols-3 gap-1.5">
        {AXES.map((axis) => (
          <label key={axis.key} className="flex min-w-0 flex-col gap-0.5" title={axis.hint}>
            <span className="text-[10px] font-semibold text-slate-500">{axis.label} ({unit})</span>
            <input
              type="text"
              inputMode="decimal"
              value={values[axis.key]}
              placeholder="0"
              aria-label={`Move ${axis.label} in ${unit}`}
              onChange={(event) => setValues((current) => ({ ...current, [axis.key]: event.target.value }))}
              className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-right font-mono text-xs tabular-nums text-slate-700 focus:border-teal-400 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
            />
          </label>
        ))}
      </div>
      <button
        type="submit"
        disabled={empty}
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-teal-700 text-xs font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1"
      >
        <MoveRight size={14} aria-hidden="true" />
        Move selection
      </button>
    </form>
  );
}
