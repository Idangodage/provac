'use client';

/**
 * Board toolbar: tool selection, the Bend-radius + Pipe-gap sliders (debounced so
 * dragging doesn't thrash the geometry recompute), the Gas/Liquid/Both filter, and
 * undo/redo. Bend radius is clamped to the active size's minimum (invariant D).
 */

import { useEffect, useRef, useState } from 'react';

import { useBoardStore } from '../model/store';
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
  useEffect(() => setLocal(value), [value]);
  const push = (v: number) => {
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(v), 35);
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#57564f' }}>
      <span style={{ minWidth: 66 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, local))}
        onChange={(e) => push(Number(e.target.value))}
        style={{ width: 120 }}
      />
      <span style={{ minWidth: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
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
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);
  const canUndo = useBoardStore((s) => s.past.length > 0);
  const canRedo = useBoardStore((s) => s.future.length > 0);

  const toolBtn = (t: Tool, label: string) => (
    <button type="button" style={tool === t ? BTN_ON : BTN} onClick={() => setTool(t)}>
      {label}
    </button>
  );
  const filterBtn = (f: LineFilter, label: string) => (
    <button
      type="button"
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
      <div style={{ display: 'flex', gap: 6 }}>
        {toolBtn('select', 'Select')}
        {toolBtn('pipe', 'Pipe')}
        {toolBtn('branch-kit', 'Branch kit')}
      </div>

      <DebouncedSlider label="Bend radius" value={bendRadiusMm} min={activeSize.minBendRadiusMm} max={1000} step={1} onCommit={setBendRadiusMm} />
      <DebouncedSlider label="Pipe gap" value={pipeGapMm} min={0} max={200} step={1} onCommit={setPipeGapMm} />

      <span style={{ display: 'inline-flex', border: '1px solid #d8d7d2', borderRadius: 7, overflow: 'hidden' }}>
        {filterBtn('gas', 'Gas')}
        {filterBtn('liquid', 'Liquid')}
        {filterBtn('both', 'Both')}
      </span>

      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
        <button type="button" style={{ ...BTN, opacity: canUndo ? 1 : 0.4 }} onClick={undo} disabled={!canUndo}>
          Undo
        </button>
        <button type="button" style={{ ...BTN, opacity: canRedo ? 1 : 0.4 }} onClick={redo} disabled={!canRedo}>
          Redo
        </button>
      </div>
    </div>
  );
}
