'use client';

/**
 * The toolbox's Ducts & pipes: a tile per thing drawn by hand (supply and
 * return ducts, a gas + liquid pair, a gas or a liquid line, a drain), each
 * with what its tool draws now. The tile of the tool out is lit, and so is
 * the tile of what is selected; a click on that one draws exactly it (Draw
 * like this), on another its tool comes out with its own spec, and on the
 * tile of the tool out the tool is put down.
 */
import React, { useMemo } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../store';

import { stopDrainDraw, useDrainDrawStore } from './condensate/drainDrawSession';
import { activeDrawKind, armDrawKind, armDrawSpec } from './drawArm';
import { DRAW_KIND_TITLES, drawSpecOf, ductSectionText, type DrawKind } from './drawSpec';
import { useDuctToolStore } from './duct/ductToolStore';
import { EquipmentIcon, type EquipmentIconKind } from './equipmentIcons';
import { useHvacUnits } from './units/useHvacUnits';

const TILES: Array<{ kind: DrawKind; icon: EquipmentIconKind; dot: string | null; hint: string }> = [
  { kind: 'supply-duct', icon: 'duct-supply', dot: 'bg-blue-700', hint: 'From a unit\'s supply collar, an open end, or anywhere on the plan' },
  { kind: 'return-duct', icon: 'duct-return', dot: 'bg-teal-700', hint: 'From a unit\'s return collar, an open end, or anywhere on the plan' },
  { kind: 'pair', icon: 'pipe-pair', dot: null, hint: 'A gas and a liquid line together, from a unit\'s ports or an open pair' },
  { kind: 'gas', icon: 'pipe-gas', dot: 'bg-orange-500', hint: 'The gas line alone' },
  { kind: 'liquid', icon: 'pipe-liquid', dot: 'bg-blue-600', hint: 'The liquid line alone' },
  { kind: 'drain', icon: 'drain-pipe', dot: null, hint: 'From a unit\'s drain outlet or an open drain end, into a drain or a termination' },
];

export function DrawToolsSection({ onKeyDown }: { onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void }) {
  const { activeTool, lineMode, drawMode, selectedElementIds, hvacElements } = useSmartDrawingStore((state) => ({
    activeTool: state.activeTool,
    lineMode: state.refrigerantPipeLineMode,
    drawMode: state.refrigerantPipeDrawMode,
    selectedElementIds: state.selectedElementIds,
    hvacElements: state.hvacElements,
  }), shallow);
  const duct = useDuctToolStore((state) => ({ freeService: state.freeService, branchShape: state.branchShape, branchWidthMm: state.branchWidthMm,
    branchHeightMm: state.branchHeightMm, branchDiameterMm: state.branchDiameterMm }), shallow);
  const drainTool = useDrainDrawStore((state) => ({ armed: state.armed, session: state.session }), shallow);
  const units = useHvacUnits();
  const active = activeDrawKind({ activeTool, refrigerantPipeLineMode: lineMode }, duct, drainTool);
  const selected = useMemo(() => {
    if (selectedElementIds.length !== 1) return null;
    const element = hvacElements.find((candidate) => candidate.id === selectedElementIds[0]);
    return element ? drawSpecOf(element, hvacElements, units.system) : null;
  }, [selectedElementIds, hvacElements, units.system]);

  /** What a tile's tool draws now (or, lit by the selection, what is selected). */
  const caption = (kind: DrawKind): string => {
    if (selected?.kind === kind) return selected.chips[0] ?? '';
    if (kind === 'supply-duct' || kind === 'return-duct') {
      const section = duct.branchShape === 'round'
        ? { widthMm: duct.branchDiameterMm, heightMm: duct.branchDiameterMm, diameterMm: duct.branchDiameterMm }
        : { widthMm: duct.branchWidthMm, heightMm: duct.branchHeightMm };
      return ductSectionText(section, units.system).replace(/^(Rect|Round) /, '');
    }
    if (kind === 'drain') return 'Fall solved';
    return drawMode === 'hard' ? 'Hard copper' : 'Soft copper';
  };

  const onTile = (kind: DrawKind) => {
    if (active === kind) {
      // The tool out: put down.
      if (kind === 'drain') stopDrainDraw();
      else useSmartDrawingStore.getState().setTool('select');
      return;
    }
    if (selected?.kind === kind) armDrawSpec(selected);
    else armDrawKind(kind);
  };

  return (
    <section className="rounded-xl border border-amber-200/80 bg-white/80 p-2" aria-label="Ducts and pipes" data-testid="draw-tools">
      <header className="mb-1.5 flex items-center gap-1.5 px-0.5 text-slate-600">
        <EquipmentIcon kind="pipe-pair" size={14} />
        <span className="text-[11px] font-semibold uppercase tracking-wide">Ducts &amp; pipes</span>
        <span className="ml-auto text-[10px] text-slate-400">draw by hand</span>
      </header>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(68px,1fr))] gap-1.5" onKeyDown={onKeyDown}>
        {TILES.map((tile) => {
          const isActive = active === tile.kind;
          const isSelected = !isActive && selected?.kind === tile.kind;
          const title = DRAW_KIND_TITLES[tile.kind];
          const text = caption(tile.kind);
          return (
            <button
              key={tile.kind}
              type="button"
              data-equipment-tile={`draw:${tile.kind}`}
              data-draw-tile={tile.kind}
              data-state={isActive ? 'active' : isSelected ? 'selected' : 'idle'}
              aria-label={title}
              aria-pressed={isActive}
              title={isActive ? `${title}: the tool is out (click to put it down)`
                : isSelected ? `${title}: draw exactly what is selected (${selected!.chips.join(', ')})` : `${title}: ${tile.hint}`}
              onClick={() => onTile(tile.kind)}
              className={`group relative flex min-h-[74px] flex-col items-center justify-start gap-1 rounded-lg border px-1 pb-1.5 pt-2 text-center outline-none transition-[background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1 ${
                isActive
                  ? 'border-amber-500 bg-amber-100/80 text-amber-900 shadow-[0_0_0_1px_rgba(245,158,11,0.6)]'
                  : isSelected
                    ? 'border-sky-400 bg-sky-50 text-sky-900 shadow-[0_0_0_1px_rgba(56,189,248,0.5)]'
                    : 'border-amber-200/60 bg-white text-slate-700 hover:border-amber-300 hover:bg-amber-50/70 hover:shadow-sm'
              }`}
            >
              {isSelected ? (
                <span className="absolute right-1 top-1 rounded-full bg-sky-500 px-1 text-[8.5px] font-semibold uppercase leading-[14px] tracking-wide text-white">sel</span>
              ) : null}
              <EquipmentIcon kind={tile.icon} size={26} className={isActive ? 'text-amber-800' : isSelected ? 'text-sky-800' : 'text-slate-600 group-hover:text-slate-800'} />
              <span className="w-full truncate text-[11px] font-medium leading-[14px]">{title}</span>
              <span className="flex w-full items-center justify-center gap-1 text-[9.5px] leading-3 text-slate-400">
                {tile.dot ? <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tile.dot}`} aria-hidden="true" /> : null}
                <span className="truncate" data-testid="draw-tile-caption">{text}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default DrawToolsSection;
