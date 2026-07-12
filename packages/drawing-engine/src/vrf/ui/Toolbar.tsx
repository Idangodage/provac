'use client';

/**
 * Board toolbar: tool selection, the Bend-radius + Pipe-gap sliders (debounced so
 * dragging doesn't thrash the geometry recompute), the Gas/Liquid/Both filter, and
 * undo/redo. Bend radius is clamped to the active size's minimum (invariant D).
 *
 * Accessibility: the tool + filter buttons are aria-pressed toggle buttons inside a
 * labelled role=group (each stays independently tab-focusable — no roving-tabindex
 * radio machinery). The sliders carry aria-label + aria-valuetext, disabled controls
 * expose aria-disabled, and a keyboard focus ring is drawn via :focus-visible.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { useBoardStore } from '../model/store';
import { minSpineBendRadiusMm } from '../geometry/bend';
import type { LineFilter, Tool } from '../model/types';

const BTN: React.CSSProperties = {
  border: '1px solid #d8d7d2',
  borderRadius: 7,
  background: '#fff',
  padding: '5px 11px',
  fontSize: 13,
  cursor: 'pointer',
  color: '#46433c',
};
const BTN_ON: React.CSSProperties = { ...BTN, background: '#0f766e', color: '#fff', borderColor: '#0f766e' };

/** Injected once — inline styles can't express :focus-visible. */
const FOCUS_CSS = `
.vrf-tb button:focus-visible, .vrf-tb input:focus-visible {
  outline: 2px solid #0f766e;
  outline-offset: 2px;
}
.vrf-tb button { font-family: inherit; }
`;

function DebouncedSlider({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}): JSX.Element {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  useEffect(() => setLocal(value), [value]);
  const push = (v: number) => {
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(v), 35);
  };
  const shown = Math.min(max, Math.max(min, local));
  return (
    <label htmlFor={id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#57564f' }}>
      <span style={{ minWidth: 66 }}>{label}</span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-label={`${label}, millimetres`}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${Math.round(shown)} millimetres`}
        onChange={(e) => push(Number(e.target.value))}
        style={{ width: 120 }}
      />
      <span style={{ minWidth: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} aria-hidden>
        {Math.round(local)} mm
      </span>
    </label>
  );
}

export function Toolbar(): JSX.Element {
  const tool = useBoardStore((s) => s.tool);
  const setTool = useBoardStore((s) => s.setTool);
  const bendRadiusMm = useBoardStore((s) => s.bendRadiusMm);
  const setBendRadiusMm = useBoardStore((s) => s.setBendRadiusMm);
  const pipeGapMm = useBoardStore((s) => s.pipeGapMm);
  const setPipeGapMm = useBoardStore((s) => s.setPipeGapMm);
  const lineFilter = useBoardStore((s) => s.lineFilter);
  const setLineFilter = useBoardStore((s) => s.setLineFilter);
  const activeSize = useBoardStore((s) => s.activeSize);
  const bendWarning = useBoardStore((s) => s.bendWarning);
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);
  const canUndo = useBoardStore((s) => s.past.length > 0);
  const canRedo = useBoardStore((s) => s.future.length > 0);

  const toolBtn = (t: Tool, label: string) => (
    <button
      type="button"
      aria-pressed={tool === t}
      aria-label={`${label} tool`}
      style={tool === t ? BTN_ON : BTN}
      onClick={() => setTool(t)}
    >
      {label}
    </button>
  );
  const filterBtn = (f: LineFilter, label: string) => (
    <button
      type="button"
      aria-pressed={lineFilter === f}
      aria-label={`Show ${label} lines`}
      style={{
        ...BTN,
        borderRadius: 0,
        padding: '5px 10px',
        background: lineFilter === f ? '#b5742f' : '#fff',
        color: lineFilter === f ? '#fff' : '#46433c',
        borderColor: lineFilter === f ? '#b5742f' : '#d8d7d2',
      }}
      onClick={() => setLineFilter(f)}
    >
      {label}
    </button>
  );

  return (
    <div
      className="vrf-tb"
      role="toolbar"
      aria-label="Pipe board tools"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
        padding: '8px 12px',
        background: '#fbfbfa',
        borderBottom: '1px solid #e6e5e0',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <style>{FOCUS_CSS}</style>
      <div role="group" aria-label="Tool" style={{ display: 'flex', gap: 6 }}>
        {toolBtn('select', 'Select')}
        {toolBtn('pipe', 'Pipe')}
        {toolBtn('branch-kit', 'Branch kit')}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <DebouncedSlider
          label="Bend radius"
          value={bendRadiusMm}
          min={minSpineBendRadiusMm(activeSize, pipeGapMm)}
          max={1000}
          step={1}
          onCommit={setBendRadiusMm}
        />
        {bendWarning ? (
          <span role="status" style={{ fontSize: 10.5, color: '#b45309', maxWidth: 240, lineHeight: 1.25 }}>
            ⚠ {bendWarning}
          </span>
        ) : null}
      </div>
      <DebouncedSlider label="Pipe gap" value={pipeGapMm} min={0} max={200} step={1} onCommit={setPipeGapMm} />

      <span role="group" aria-label="Line filter" style={{ display: 'inline-flex', border: '1px solid #d8d7d2', borderRadius: 7, overflow: 'hidden' }}>
        {filterBtn('gas', 'Gas')}
        {filterBtn('liquid', 'Liquid')}
        {filterBtn('both', 'Both')}
      </span>

      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
        <button type="button" aria-label="Undo" aria-disabled={!canUndo} style={{ ...BTN, opacity: canUndo ? 1 : 0.4 }} onClick={undo} disabled={!canUndo}>
          Undo
        </button>
        <button type="button" aria-label="Redo" aria-disabled={!canRedo} style={{ ...BTN, opacity: canRedo ? 1 : 0.4 }} onClick={redo} disabled={!canRedo}>
          Redo
        </button>
      </div>
    </div>
  );
}
