'use client';

/**
 * The air-system layer of the duct overlay (inside its world-transformed SVG
 * group): rings, tethers and unit tags for the systems in focus, and in pick
 * mode a hit target over every terminal: a click adds it to the picked unit's
 * system (or takes it out, or moves it from another unit), one undo each.
 * Hover state lives here, so hovering never re-renders the duct runs.
 */
import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { shallow } from 'zustand/shallow';

import { useSmartDrawingStore } from '../../../../store';
import type { HvacElement } from '../../../../types';

import { toggleTerminalInSystem } from './airSystemController';
import { useAirSystemUiStore } from './airSystemUiStore';
import { airSystemMarkup } from './ductAirSystemMarkup';
import { analyseAirSystems, type AirSystemsAnalysis } from './ductAirSystems';
import { footprintCorners } from './ductAutoContext';
import { isDuctTerminalElement } from './ductTerminals';

export interface AirSystemLayerProps {
  analysis: AirSystemsAnalysis;
  hvacElements: readonly HvacElement[];
  k: number;
  focusUnitIds: ReadonlySet<string>;
  showAll: boolean;
  showTags: boolean;
}

export function AirSystemLayer({ analysis, hvacElements, k, focusUnitIds, showAll, showTags }: AirSystemLayerProps) {
  const pickUnitId = useAirSystemUiStore((state) => state.pickUnitId);
  const [hoverTerminalId, setHoverTerminalId] = useState<string | null>(null);
  useEffect(() => { if (!pickUnitId) setHoverTerminalId(null); }, [pickUnitId]);
  const markup = useMemo(() => airSystemMarkup(analysis, { k, focusUnitIds, showAll, showTags, pickUnitId, hoverTerminalId }),
    [analysis, k, focusUnitIds, showAll, showTags, pickUnitId, hoverTerminalId]);
  const targets = useMemo(() => (pickUnitId ? hvacElements.filter(isDuctTerminalElement).map((terminal) => ({
    id: terminal.id, points: footprintCorners(terminal).map((point) => `${point.x},${point.y}`).join(' '),
  })) : []), [hvacElements, pickUnitId]);
  const stop = (event: ReactPointerEvent<SVGElement>) => {
    // The click is the pick; the canvas underneath must not select or start a drag.
    event.stopPropagation();
    event.preventDefault();
  };
  return (
    <>
      <g data-testid="duct-air-systems" dangerouslySetInnerHTML={{ __html: markup }} />
      {targets.length ? (
        <g data-testid="air-system-pick-targets">
          {targets.map((target) => (
            <polygon
              key={target.id}
              points={target.points}
              fill="transparent"
              stroke="transparent"
              strokeWidth={10}
              vectorEffect="non-scaling-stroke"
              data-air-system-pick={target.id}
              style={{ pointerEvents: 'all', cursor: 'copy' }}
              onPointerEnter={() => setHoverTerminalId(target.id)}
              onPointerLeave={() => setHoverTerminalId((current) => (current === target.id ? null : current))}
              onPointerDown={stop}
              onClick={(event) => {
                event.stopPropagation();
                if (pickUnitId) toggleTerminalInSystem(pickUnitId, target.id);
              }}
            />
          ))}
        </g>
      ) : null}
    </>
  );
}

/**
 * The floating chip while picking: whose system the clicks go to, and how to
 * stop (Esc or Done). Mounted above every canvas overlay.
 */
export function AirSystemPickChip() {
  const pickUnitId = useAirSystemUiStore((state) => state.pickUnitId);
  const setPickUnit = useAirSystemUiStore((state) => state.setPickUnit);
  const { hvacElements, rooms } = useSmartDrawingStore((state) => ({ hvacElements: state.hvacElements, rooms: state.rooms }), shallow);
  const analysis = useMemo(() => (pickUnitId ? analyseAirSystems(hvacElements, rooms) : null), [pickUnitId, hvacElements, rooms]);
  const system = pickUnitId ? analysis?.byUnit.get(pickUnitId) : undefined;
  useEffect(() => {
    if (!pickUnitId) return undefined;
    // Before anything else handles Esc (the canvas tools clear selections on it).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      event.preventDefault();
      setPickUnit(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pickUnitId, setPickUnit]);
  useEffect(() => {
    // The unit was deleted (or undone away): stop picking.
    if (pickUnitId && analysis && !system) setPickUnit(null);
  }, [pickUnitId, system, setPickUnit]);
  if (!system) return null;
  const supply = system.supply.members.length;
  const ret = system.return.members.length;
  return (
    <div className="absolute bottom-5 left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border bg-white px-3 py-1.5 text-xs text-slate-700 shadow-lg"
      style={{ pointerEvents: 'auto', borderColor: system.color }} role="status" data-testid="air-system-pick-chip">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: system.color }} aria-hidden="true" />
      <span>Assigning terminals to <span className="font-semibold">{system.tag}</span> · click a terminal to add or remove it</span>
      <span className="text-slate-400">{supply} supply · {ret} return</span>
      <button type="button" onClick={() => setPickUnit(null)} className="rounded-full px-2 py-0.5 font-medium text-white" style={{ background: system.color }}>
        Done <kbd className="ml-0.5 font-sans text-[10px] opacity-80">Esc</kbd>
      </button>
    </div>
  );
}
