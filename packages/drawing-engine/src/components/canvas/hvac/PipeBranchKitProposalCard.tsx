import { Check, FlipHorizontal2, GitBranchPlus, X } from 'lucide-react';

import type { BranchKitProposalValidity } from './branchKitProposal';

export interface PipeBranchKitProposalCardProps {
  /** Screen position (px, relative to the canvas host) to anchor the card. */
  screenX: number;
  screenY: number;
  /** Human-readable connection classification (e.g. "Indoor unit → branch"). */
  connectionLabel: string;
  validity: BranchKitProposalValidity;
  /** Why the proposal is nudged/invalid (first item shown). */
  violations: string[];
  onAccept: () => void;
  onFlip: () => void;
  /** Decline the kit — continue the route as a plain vertex/tee. */
  onDismiss: () => void;
}

const BASE_BUTTON_CLASS =
  'flex flex-1 flex-col items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors';

const VALIDITY_META: Record<
  BranchKitProposalValidity,
  { label: string; dot: string; text: string }
> = {
  valid: { label: 'Valid tee', dot: 'bg-emerald-500', text: 'text-emerald-600' },
  'needs-nudge': { label: 'Nudged to fit', dot: 'bg-amber-500', text: 'text-amber-600' },
  invalid: { label: 'Cannot place here', dot: 'bg-rose-500', text: 'text-rose-600' },
};

export function PipeBranchKitProposalCard({
  screenX,
  screenY,
  connectionLabel,
  validity,
  violations,
  onAccept,
  onFlip,
  onDismiss,
}: PipeBranchKitProposalCardProps): JSX.Element {
  const meta = VALIDITY_META[validity];
  const canAccept = validity !== 'invalid';

  return (
    <div
      className="pointer-events-auto absolute z-[32] w-[236px] -translate-x-1/2 -translate-y-full rounded-lg border border-slate-200 bg-white shadow-xl"
      style={{ left: screenX, top: screenY - 12 }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <div>
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-800">
            <GitBranchPlus size={13} className="text-sky-600" />
            Insert branch kit
          </p>
          <p className="text-[11px] text-slate-500">{connectionLabel}</p>
          <p className={`mt-0.5 flex items-center gap-1 text-[10.5px] ${meta.text}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {meta.label}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss branch kit proposal"
          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex gap-1.5 px-3 py-2">
        <button
          type="button"
          disabled={!canAccept}
          className={`${BASE_BUTTON_CLASS} ${
            canAccept
              ? 'border-sky-500 bg-sky-50 text-sky-700 hover:bg-sky-100'
              : 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-300'
          }`}
          onClick={() => {
            if (canAccept) {
              onAccept();
            }
          }}
        >
          <Check size={15} />
          <span>Accept</span>
        </button>
        <button
          type="button"
          className={`${BASE_BUTTON_CLASS} border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50`}
          onClick={onFlip}
        >
          <FlipHorizontal2 size={15} />
          <span>Flip</span>
        </button>
        <button
          type="button"
          className={`${BASE_BUTTON_CLASS} border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50`}
          onClick={onDismiss}
        >
          <X size={15} />
          <span>Plain tee</span>
        </button>
      </div>

      {violations.length > 0 && (
        <p className="border-t border-slate-100 px-3 py-1.5 text-[10.5px] leading-snug text-slate-500">
          {violations[0]}
        </p>
      )}
    </div>
  );
}
