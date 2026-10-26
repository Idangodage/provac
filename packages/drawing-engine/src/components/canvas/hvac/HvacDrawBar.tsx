'use client';

/**
 * The bar above the drawing for ducts, refrigerant lines and drains:
 *  - one selected (or a piece of it picked): what it is, as chips
 *    ("SUPPLY DUCT · Rect 400×250 · Bottom 2.70 m · GI + NBR 25 mm"), and
 *    [Draw like this], which arms its tool to draw exactly it;
 *  - the duct or pipe tool out: what it draws, editable (service, shape and
 *    section, level, construction; lines and copper), in the display units;
 *  - the drain tool out: how to go on;
 *  - gaps left open by deleted pieces: [Reconnect all].
 * It shows nothing otherwise (the wall bar has the strip then).
 */
import { PencilLine, Workflow, X } from 'lucide-react';
import React, { useMemo } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../store';

import { cancelDrainDraw, stopDrainDraw, useDrainDrawStore } from './condensate/drainDrawSession';
import { armDrawSpec } from './drawArm';
import { DRAW_KIND_TITLES, drawSpecOf, ductSectionText, levelText } from './drawSpec';
import { openGapIds, reconnectAllGaps } from './duct/ductGapController';
import { useDuctToolStore } from './duct/ductToolStore';
import { domainOf, useSegmentUiStore } from './segments/segmentUiStore';
import type { HvacUnitSystem } from './units/hvacUnits';
import { useHvacUnits } from './units/useHvacUnits';

const IN = 25.4;
const FT = 304.8;
/** Section presets: rectangular and round, inch series in IP. */
const RECT_PRESETS: Record<HvacUnitSystem, Array<{ widthMm: number; heightMm: number }>> = {
  si: [{ widthMm: 300, heightMm: 200 }, { widthMm: 400, heightMm: 250 }, { widthMm: 500, heightMm: 300 }, { widthMm: 600, heightMm: 300 }],
  ip: [[12, 8], [16, 10], [20, 12], [24, 12]].map(([w, h]) => ({ widthMm: w! * IN, heightMm: h! * IN })),
};
const ROUND_PRESETS: Record<HvacUnitSystem, number[]> = { si: [200, 250, 300], ip: [8, 10, 12].map((d) => d * IN) };
const LEVEL_PRESETS: Record<HvacUnitSystem, number[]> = { si: [2400, 2700, 3000], ip: [8, 9, 10].map((ft) => ft * FT) };
const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

function Chip({ children }: { children: React.ReactNode }) {
  return <span data-testid="draw-bar-chip" className="shrink-0 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-700">{children}</span>;
}

function Choice({ label, active, onClick, title, testId }: { label: string; active: boolean; onClick: () => void; title?: string; testId?: string }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={active} data-testid={testId}
      className={`shrink-0 rounded-md border px-1.5 py-1 text-[11px] font-medium transition-colors ${
        active ? 'border-amber-400 bg-amber-200 text-amber-900' : 'border-amber-200/80 bg-white text-slate-600 hover:bg-amber-50'
      }`}>
      {label}
    </button>
  );
}

const Divider = () => <span className="mx-0.5 h-4 w-px shrink-0 bg-amber-200/80" />;
const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{children}</span>
);

/** A figure asked for in the display unit (a prompt, as the wall bar's Custom), back in mm; null when cancelled or not a number. */
function askNumber(question: string, shown: string, toMm: (value: number) => number): number | null {
  const raw = window.prompt(question, shown);
  const value = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? toMm(value) : null;
}

export interface HvacDrawBarProps {
  className?: string;
  /** Keep the strip's height when there is nothing to show. */
  keepSpaceWhenHidden?: boolean;
}

export function HvacDrawBar({ className = '', keepSpaceWhenHidden = false }: HvacDrawBarProps) {
  const { activeTool, selectedElementIds, hvacElements, lineMode, drawMode, setLineMode, setDrawMode } = useSmartDrawingStore((state) => ({
    activeTool: state.activeTool,
    selectedElementIds: state.selectedElementIds,
    hvacElements: state.hvacElements,
    lineMode: state.refrigerantPipeLineMode,
    drawMode: state.refrigerantPipeDrawMode,
    setLineMode: state.setRefrigerantPipeLineMode,
    setDrawMode: state.setRefrigerantPipeDrawMode,
  }), shallow);
  const pinned = useSegmentUiStore((state) => state.pinned);
  const duct = useDuctToolStore();
  const drainTool = useDrainDrawStore((state) => ({ armed: state.armed, session: state.session }), shallow);
  const units = useHvacUnits();
  const system = units.system;
  // One run selected (a duct's picked straight gives its section and level).
  const spec = useMemo(() => {
    if (selectedElementIds.length !== 1) return null;
    const element = hvacElements.find((candidate) => candidate.id === selectedElementIds[0]);
    if (!element) return null;
    const leg = pinned && domainOf(pinned) === 'duct' && pinned.runId === element.id ? /^leg:(\d+)$/.exec(pinned.key)?.[1] : undefined;
    return drawSpecOf(element, hvacElements, system, leg !== undefined ? Number(leg) : undefined);
  }, [selectedElementIds, hvacElements, pinned, system]);
  const gaps = useMemo(() => openGapIds().length, [hvacElements]);

  const reconnect = gaps > 0 ? (
    <button type="button" data-testid="draw-bar-reconnect-all" onClick={() => reconnectAllGaps()}
      title="Reconnect every gap deleted pieces left open, each the best way (one undo)"
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-teal-200 bg-teal-50 px-2 py-1 text-[11px] font-medium text-teal-800 hover:bg-teal-100">
      <Workflow size={12} aria-hidden="true" />Reconnect all ({gaps})
    </button>
  ) : null;

  let body: React.ReactNode = null;
  let mode = '';
  if (drainTool.armed || drainTool.session) {
    mode = 'drain-tool';
    const drawing = drainTool.session;
    body = (
      <>
        <Label>Drain tool</Label>
        <span className="truncate text-[11px] text-slate-600">
          {drawing
            ? `Click where it turns · finish on ${drawing.to ? 'the other part\'s open end' : 'a drain (a wye) or a termination'} · Backspace takes a point back · Esc steps back`
            : 'Click a unit\'s drain outlet or an open drain end to start · levels are solved for the fall'}
        </span>
        <button type="button" onClick={() => (drawing ? cancelDrainDraw() : stopDrainDraw())} data-testid="draw-bar-drain-stop"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-600 hover:bg-slate-50">
          <X size={11} aria-hidden="true" />{drawing ? 'Step back' : 'Stop'}
        </button>
      </>
    );
  } else if (activeTool === 'duct') {
    mode = 'duct-tool';
    const round = duct.branchShape === 'round';
    const rect = { widthMm: duct.branchWidthMm, heightMm: duct.branchHeightMm };
    const setRect = (size: { widthMm: number; heightMm: number }) => {
      duct.setBranchOptions({ branchShape: 'rect' });
      duct.setBranchSize({ branchWidthMm: size.widthMm, branchHeightMm: size.heightMm });
      if (duct.sizeMode === 'custom') duct.setSize({ widthMm: size.widthMm, heightMm: size.heightMm });
    };
    const setRound = (diameterMm: number) => duct.setBranchOptions({ branchShape: 'round', branchDiameterMm: diameterMm });
    const like = duct.like;
    body = (
      <>
        <Label>Duct</Label>
        <Choice label="Supply" active={duct.freeService === 'supply'} onClick={() => duct.setBranchOptions({ freeService: 'supply' })} />
        <Choice label="Return" active={duct.freeService === 'return'} onClick={() => duct.setBranchOptions({ freeService: 'return' })} />
        <Divider />
        <Label>Size</Label>
        <Choice label="Rect" active={!round} onClick={() => duct.setBranchOptions({ branchShape: 'rect' })} />
        <Choice label="Round" active={round} onClick={() => duct.setBranchOptions({ branchShape: 'round' })} />
        {round
          ? ROUND_PRESETS[system].map((diameterMm) => (
            <Choice key={diameterMm} label={ductSectionText({ widthMm: diameterMm, heightMm: diameterMm, diameterMm }, system).replace(/^Round /, '')}
              active={near(duct.branchDiameterMm, diameterMm)} onClick={() => setRound(diameterMm)} />
          ))
          : RECT_PRESETS[system].map((size) => (
            <Choice key={`${size.widthMm}x${size.heightMm}`} label={ductSectionText(size, system).replace(/^Rect /, '')}
              active={near(rect.widthMm, size.widthMm) && near(rect.heightMm, size.heightMm)} onClick={() => setRect(size)} />
          ))}
        <Choice label="Custom" active={false} onClick={() => {
          if (round) {
            const diameter = askNumber(`Round duct diameter (${units.unit('size')})`, units.num('size', duct.branchDiameterMm), (value) => units.fromDisplay('size', value));
            if (diameter) setRound(diameter);
            return;
          }
          const raw = window.prompt(`Duct section W × H (${units.unit('size')})`, `${units.num('size', rect.widthMm)} × ${units.num('size', rect.heightMm)}`);
          const match = raw ? /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i.exec(raw) : null;
          if (match) setRect({ widthMm: units.fromDisplay('size', Number(match[1])), heightMm: units.fromDisplay('size', Number(match[2])) });
        }} />
        <Choice label="Collar" title="A run from a unit's collar takes the collar's size" active={duct.sizeMode === 'collar'}
          onClick={() => duct.setSize(duct.sizeMode === 'collar' ? { sizeMode: 'custom', widthMm: rect.widthMm, heightMm: rect.heightMm } : { sizeMode: 'collar' })} />
        <Divider />
        <Label>Bottom</Label>
        {LEVEL_PRESETS[system].map((level) => (
          <Choice key={level} label={levelText(level, system)} active={near(duct.freeBottomMm, level)} onClick={() => duct.setBranchOptions({ freeBottomMm: level })} />
        ))}
        <Choice label="Custom" active={!LEVEL_PRESETS[system].some((level) => near(duct.freeBottomMm, level))} onClick={() => {
          const level = askNumber(`Clear bottom level (${units.unit('length')})`, units.num('length', duct.freeBottomMm / 1000), (value) => units.fromDisplay('length', value) * 1000);
          if (level) duct.setBranchOptions({ freeBottomMm: level });
        }} />
        {like ? (
          <>
            <Divider />
            <span className="shrink-0 text-[11px] text-slate-600" data-testid="draw-bar-like">
              {like.construction === 'gi-nbr' && like.insulationMm > 0 ? `GI + NBR ${units.fmt('size', like.insulationMm)}` : 'GI, bare'}
            </span>
          </>
        ) : null}
      </>
    );
  } else if (activeTool === 'refrigerant-pipe') {
    mode = 'pipe-tool';
    body = (
      <>
        <Label>Pipe</Label>
        <Choice label={DRAW_KIND_TITLES.pair} active={lineMode === 'pair'} onClick={() => setLineMode('pair')} />
        <Choice label={DRAW_KIND_TITLES.gas} active={lineMode === 'gas'} onClick={() => setLineMode('gas')} />
        <Choice label={DRAW_KIND_TITLES.liquid} active={lineMode === 'liquid'} onClick={() => setLineMode('liquid')} />
        <Divider />
        <Label>Copper</Label>
        <Choice label="Hard" active={drawMode === 'hard'} onClick={() => setDrawMode('hard')} />
        <Choice label="Soft" active={drawMode === 'flexible'} onClick={() => setDrawMode('flexible')} />
        <Divider />
        <span className="shrink-0 text-[11px] text-slate-500">Sizes follow the port or line it starts from</span>
      </>
    );
  } else if (spec) {
    mode = 'selection';
    body = (
      <>
        <Label>{spec.title}</Label>
        {spec.chips.map((chip, index) => <Chip key={index}>{chip}</Chip>)}
        <button type="button" data-testid="draw-like-this" onClick={() => armDrawSpec(spec)}
          title={spec.arm.tool === 'drain' ? 'Take the drain tool out: drains drawn by hand, levels solved for this fall'
            : `Take the ${spec.arm.tool === 'duct' ? 'duct' : 'pipe'} tool out to draw exactly this`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-400 bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-200">
          <PencilLine size={12} aria-hidden="true" />Draw like this
        </button>
      </>
    );
  }
  if (!body && !reconnect) return keepSpaceWhenHidden ? <div className={`h-full ${className}`} aria-hidden="true" /> : null;
  return (
    <div className={`h-full px-2 ${className}`}>
      <div className="flex h-full items-center gap-1 overflow-x-auto whitespace-nowrap scrollbar-thin scrollbar-thumb-amber-300" data-testid="hvac-draw-bar" data-mode={mode}>
        {body}
        {reconnect}
      </div>
    </div>
  );
}

export default HvacDrawBar;
