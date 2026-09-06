import { Check, ChevronDown, FlipHorizontal2, GitBranchPlus, Lock, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import type { BranchKitProposalValidity } from './branchKitProposal';
import type { NetworkLevelSummary } from './networkPipeLevels';

export interface PipeBranchKitProposalCardProps {
  /** Screen position (px, relative to the canvas host) to anchor the card. */
  screenX: number;
  screenY: number;
  viewportWidth?: number;
  viewportHeight?: number;
  /** Human-readable connection classification (e.g. "Indoor unit → branch"). */
  connectionLabel: string;
  validity: BranchKitProposalValidity;
  /** Why the proposal is nudged/invalid (first item shown). */
  violations: string[];
  orientationLocked?: boolean;
  notes?: string[];
  levelSummary?: NetworkLevelSummary;
  onAccept: () => void;
  onFlip: () => void;
  /** Return to drawing without committing an unconnected pipe crossing. */
  onDismiss: () => void;
}

const BASE_BUTTON_CLASS =
  'flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2';

function draftAdjustmentHint(violations: string[]): string {
  const reason = violations[0] ?? '';
  if (/outdoor modules/i.test(reason)) return 'Review the outdoor module arrangement.';
  if (/opposite outdoor sides/i.test(reason)) return 'Check which ends connect to the outdoor unit.';
  if (/legacy composite|combined or unclassified/i.test(reason)) return 'This fitting needs separate gas and liquid runs.';
  if (/locked|available levels|service separation/i.test(reason)) return 'Review the available pipe levels.';
  if (/existing branch kit/i.test(reason)) return 'Move farther from the existing branch.';
  if (/unit clearance/i.test(reason)) return 'Move the branch clear of the indoor unit.';
  if (/clash/i.test(reason)) return 'Move the branch or adjust the last waypoint.';
  if (/straight|approach|run too short/i.test(reason)) return 'Move along the run to leave a longer straight.';
  return reason.length > 0 && reason.length <= 100 ? reason : 'Adjust the branch position or the last waypoint.';
}

export function PipeBranchKitProposalCard({
  screenX,
  screenY,
  viewportWidth,
  viewportHeight,
  connectionLabel,
  validity,
  violations,
  orientationLocked = false,
  notes,
  levelSummary,
  onAccept,
  onFlip,
  onDismiss,
}: PipeBranchKitProposalCardProps): JSX.Element {
  const canAccept = validity !== 'invalid';
  const cardRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const width = viewportWidth ?? card.parentElement?.clientWidth ?? 0;
    const height = viewportHeight ?? card.parentElement?.clientHeight ?? 0;
    if (width <= 0 || height <= 0) return;
    const left = Math.max(8, Math.min(screenX - card.offsetWidth / 2, width - card.offsetWidth - 8));
    const above = screenY - card.offsetHeight - 12;
    const preferredTop = above >= 8 ? above : screenY + 12;
    const top = Math.max(8, Math.min(preferredTop, height - card.offsetHeight - 8));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }, [screenX, screenY, viewportWidth, viewportHeight, validity, orientationLocked, violations, notes, levelSummary, detailsOpen]);

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label="Gas and liquid branch proposal"
      className="pointer-events-auto absolute z-[32] max-h-[calc(100%-16px)] w-[280px] max-w-[calc(100%-16px)] overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg"
      style={{ left: screenX, top: screenY + 12 }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Enter on a disclosure/button belongs to that control, not the global
        // pipe command. The native button click still accepts the visible plan.
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2 px-3 pt-2.5">
        <div>
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-800">
            <GitBranchPlus size={13} className={canAccept ? 'text-sky-600' : 'text-slate-400'} />
            {canAccept ? 'Gas + liquid branch' : 'Adjust branch position'}
          </p>
          <p className="mt-1 text-[11px] leading-snug text-slate-600">
            {canAccept
              ? (!orientationLocked ? 'Check the inlet direction in Details.'
                : validity === 'needs-nudge' ? 'Position adjusted for clearance.' : 'Ready to connect.')
              : draftAdjustmentHint(violations)}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss branch kit proposal"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>

      {canAccept && levelSummary && (
        <div className="px-3 pt-2">
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] tabular-nums">
            <span className="text-sky-700">Gas {(levelSummary.gasElevationMm / 1000).toFixed(3)} m</span>
            <span className="text-amber-700">Liquid {(levelSummary.liquidElevationMm / 1000).toFixed(3)} m</span>
          </p>
          {levelSummary.requiresCoordination && (
            <p className="mt-1.5 text-[10.5px] leading-snug text-slate-600">
              Also updates {levelSummary.coordinatedRunCount} existing runs. One undo restores all.
            </p>
          )}
        </div>
      )}

      <div className="flex gap-1.5 px-3 py-2">
        {canAccept && (
          <button
            type="button"
            className={`${BASE_BUTTON_CLASS} flex-1 border-sky-500 bg-sky-50 text-sky-700 hover:bg-sky-100`}
            onClick={onAccept}
          >
            <Check size={14} />
            <span>{levelSummary?.requiresCoordination ? 'Connect & coordinate' : 'Connect pair'}</span>
          </button>
        )}
        <button
          type="button"
          className={`${BASE_BUTTON_CLASS} ${canAccept
            ? 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
            : 'flex-1 border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100'}`}
          onClick={onDismiss}
        >
          <span>Keep drawing</span>
        </button>
      </div>

      <details
        className="group px-3 pb-2.5 text-[10.5px] text-slate-600"
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-slate-500 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
          <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
          Details
        </summary>
        <div className="mt-2 border-t border-slate-100 pt-2">
          <p className="text-slate-500">{connectionLabel}</p>
          {violations.map((violation, index) => <p key={`violation:${index}`} className="mt-1.5 leading-snug">{violation}</p>)}
          {levelSummary && (
            <>
              {!canAccept && <p className="mt-2 text-slate-500">Draft levels — connection needs adjustment</p>}
              <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 tabular-nums">
                <dt>Gas centreline</dt><dd>{(levelSummary.gasElevationMm / 1000).toFixed(3)} m</dd>
                <dt>Liquid centreline</dt><dd>{(levelSummary.liquidElevationMm / 1000).toFixed(3)} m</dd>
                <dt>Gap outside insulation</dt><dd>{levelSummary.clearGapMm.toFixed(0)} mm</dd>
                <dt>Connected indoor / outdoor</dt><dd>{levelSummary.connectedIndoorCount} / {levelSummary.connectedOutdoorCount}</dd>
                <dt>Estimated terminal transitions</dt><dd>{levelSummary.transitionCount}</dd>
                <dt>Estimated vertical travel</dt><dd>{(levelSummary.verticalTravelMm / 1000).toFixed(2)} m</dd>
              </dl>
              {levelSummary.notes.map((note, index) => <p key={`level:${index}`} className="mt-1.5 leading-snug">{note}</p>)}
            </>
          )}
          <div className="mt-2 flex items-center gap-1.5">
            {orientationLocked ? (
              <><Lock size={11} /><span>Inlet follows outdoor connection</span></>
            ) : (
              <button
                type="button"
                className="flex items-center gap-1 rounded text-slate-600 hover:text-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                title="Outdoor side is unresolved. Reverse the proposed inlet orientation."
                onClick={onFlip}
              >
                <FlipHorizontal2 size={12} /><span>Reverse inlet direction</span>
              </button>
            )}
          </div>
          {(notes?.length ? notes : ['Kit sizing and system compatibility need manufacturer verification.'])
            .map((note, index) => <p key={`note:${index}`} className="mt-2 leading-snug text-slate-500">{note}</p>)}
        </div>
      </details>
    </div>
  );
}
