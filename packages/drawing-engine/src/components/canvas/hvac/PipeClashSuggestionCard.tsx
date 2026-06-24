import { ArrowDownToLine, ArrowUpToLine, Wand2, X } from 'lucide-react';

import type { BypassDirection, BypassRoutingMode } from './pipeBypass';

export interface PipeClashSuggestionCardProps {
  /** Screen position (px, relative to the canvas host) to anchor the card. */
  screenX: number;
  screenY: number;
  /** Direction currently applied to the bundle's offsets. */
  direction: BypassDirection;
  /** Direction the engine recommends (for the "Best" badge on Auto). */
  recommended: BypassDirection | null;
  clearanceMm: number;
  clashCount: number;
  /** Whether the user has forced a direction (so Auto is not the active mode). */
  isAuto: boolean;
  reason: string;
  onSelect: (mode: BypassRoutingMode) => void;
  onClose: () => void;
}

const BASE_BUTTON_CLASS =
  'flex flex-1 flex-col items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors';

export function PipeClashSuggestionCard({
  screenX,
  screenY,
  direction,
  recommended,
  clearanceMm,
  clashCount,
  isAuto,
  reason,
  onSelect,
  onClose,
}: PipeClashSuggestionCardProps): JSX.Element {
  const activeAbove = !isAuto && direction === 'above';
  const activeBelow = !isAuto && direction === 'below';

  const buttonClass = (active: boolean): string =>
    `${BASE_BUTTON_CLASS} ${
      active
        ? 'border-sky-500 bg-sky-50 text-sky-700'
        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
    }`;

  return (
    <div
      className="pointer-events-auto absolute z-[32] w-[224px] -translate-x-1/2 -translate-y-full rounded-lg border border-slate-200 bg-white shadow-xl"
      style={{ left: screenX, top: screenY - 12 }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <div>
          <p className="text-[12px] font-semibold text-slate-800">
            Pipe clash detected
          </p>
          <p className="text-[11px] text-slate-500">
            {clashCount} crossing{clashCount > 1 ? 's' : ''} · {clearanceMm} mm clearance
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss clash suggestion"
          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex gap-1.5 px-3 py-2">
        <button
          type="button"
          className={buttonClass(activeAbove)}
          onClick={() => onSelect('above')}
        >
          <ArrowUpToLine size={15} />
          <span>Above</span>
        </button>
        <button
          type="button"
          className={buttonClass(activeBelow)}
          onClick={() => onSelect('below')}
        >
          <ArrowDownToLine size={15} />
          <span>Below</span>
        </button>
        <button
          type="button"
          className={`${buttonClass(isAuto)} relative`}
          onClick={() => onSelect('auto')}
        >
          {recommended && (
            <span className="absolute -right-1 -top-1 rounded-full bg-emerald-500 px-1 text-[8px] font-semibold uppercase text-white">
              best
            </span>
          )}
          <Wand2 size={15} />
          <span>Auto</span>
        </button>
      </div>

      {reason && (
        <p className="border-t border-slate-100 px-3 py-1.5 text-[10.5px] leading-snug text-slate-500">
          {reason}
        </p>
      )}
    </div>
  );
}
