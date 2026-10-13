'use client';

/**
 * A run's pieces in its inspector: a row per piece (its tag, its name, its
 * length or angle). A click pins the piece's segment card; the pinned piece's
 * row is marked and kept in view, so the inspector and the drawing point at the
 * same piece.
 */
import { useEffect, useRef } from 'react';

import { domainOf, useSegmentUiStore, type SegmentDomain } from './segmentUiStore';

export interface SegmentPieceRow {
  key: string;
  tag: string;
  title: string;
  detail: string;
}

export function SegmentPieceList({ domain, runId, rows, testId }: {
  domain: SegmentDomain;
  runId: string;
  rows: readonly SegmentPieceRow[];
  testId: string;
}) {
  const pinnedKey = useSegmentUiStore((state) => (state.pinned && domainOf(state.pinned) === domain && state.pinned.runId === runId ? state.pinned.key : null));
  const pin = useSegmentUiStore((state) => state.pin);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pinnedKey) return;
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-piece-key]') ?? [])].find((node) => node.dataset.pieceKey === pinnedKey);
    row?.scrollIntoView({ block: 'nearest' });
  }, [pinnedKey]);
  if (!rows.length) return null;
  return (
    <div className="rounded border border-amber-200/80 bg-white/90 p-2" data-testid={testId}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Pieces
        <span className="text-[10.5px] font-normal normal-case tracking-normal text-slate-400">click one for its card</span>
      </div>
      <div ref={listRef} className="max-h-56 space-y-0.5 overflow-y-auto" role="list">
        {rows.map((row) => {
          const pinned = pinnedKey === row.key;
          return (
            <button key={row.key} type="button" role="listitem" data-piece-key={row.key} aria-current={pinned || undefined}
              onClick={() => pin({ domain, runId, key: row.key, anchorMark: null, view: '2d' })}
              className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors ${pinned
                ? 'bg-violet-50 text-violet-900 ring-1 ring-violet-300' : 'text-slate-700 hover:bg-slate-50'}`}>
              <span className="w-12 shrink-0 font-mono text-[10.5px] text-slate-400">{row.tag}</span>
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <span className="shrink-0 tabular-nums text-slate-500">{row.detail}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
