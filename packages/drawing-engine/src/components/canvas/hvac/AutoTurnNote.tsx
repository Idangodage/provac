'use client';

/**
 * Under a 4-way cassette's Rotation: who set it. Turned by hand, Auto route
 * keeps it as it is, until [Let Auto route turn it] (one undo). Turned by
 * Auto route, it says so.
 */
import { RotateCw } from 'lucide-react';
import React from 'react';

import { useSmartDrawingStore } from '../../../store';
import type { HvacElement } from '../../../types';

import { isFourWayCassette, ORIENTATION_SET_BY } from './unitOrientation';

export function AutoTurnNote({ element }: { element: HvacElement }) {
  const commit = useSmartDrawingStore((state) => state.commitHvacElementCommand);
  if (!isFourWayCassette(element)) return null;
  const setBy = element.properties?.[ORIENTATION_SET_BY];
  if (setBy === 'user') {
    return (
      <p className="flex flex-wrap items-center gap-1 text-[11px] text-slate-500" data-testid="auto-turn-note" data-set-by="user">
        Turned by hand: Auto route keeps it as it is.
        <button type="button" data-testid="auto-turn-allow"
          onClick={() => commit('Let Auto route turn it', {
            // (Set to undefined outright: the store merges properties.)
            updates: [{ id: element.id, updates: { properties: { ...element.properties, [ORIENTATION_SET_BY]: undefined } } }],
          })}
          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-slate-700 hover:bg-slate-50">
          <RotateCw size={11} aria-hidden="true" />Let Auto route turn it
        </button>
      </p>
    );
  }
  return (
    <p className="text-[11px] text-slate-400" data-testid="auto-turn-note" data-set-by={setBy === 'auto-route' ? 'auto-route' : 'none'}>
      {setBy === 'auto-route' ? 'Turned by Auto route for shorter pipe and drain runs.' : 'Auto route may turn it a quarter for shorter pipe and drain runs.'}
    </p>
  );
}

export default AutoTurnNote;
