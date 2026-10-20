'use client';

/**
 * While the optimiser re-designs a turned unit's ducts: a badge at the top of
 * the drawing says so, with the way to keep the turn's own re-route instead.
 */
import { Loader2 } from 'lucide-react';

import { cancelTurnRedesign, useTurnRedesignStore } from './turnRedesignController';

export function TurnRedesignBadge() {
  const busy = useTurnRedesignStore((state) => state.busy);
  if (!busy) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="turn-redesign-badge"
      className="pointer-events-auto absolute left-1/2 top-3 z-[30] flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-slate-900/90 py-1.5 pl-3 pr-1.5 text-[12px] text-white shadow-lg ring-1 ring-white/10 backdrop-blur"
    >
      <Loader2 size={14} className="animate-spin text-teal-300" aria-hidden="true" />
      <span>Optimising {busy.subject} for the turn…</span>
      <button
        type="button"
        className="rounded-full px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
        title="Keep the turn's re-routed ducts instead (Esc)"
        onClick={() => cancelTurnRedesign()}
      >
        Keep the re-route
      </button>
    </div>
  );
}
