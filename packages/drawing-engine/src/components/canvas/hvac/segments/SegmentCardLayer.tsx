'use client';

/**
 * The segment card of a run's piece, in any service and either view. Point at
 * a piece of a selected run and, after a short rest, a peek card shows what it
 * is, its figures and its best two alternatives; click it and the card pins
 * beside it, a leader line from the card to the piece and a chip naming it on
 * the drawing. The pinned card keeps text to a minimum: a header, one strip of
 * figures, and up to three tabs —
 *
 *  - Edit: the piece's own values, typed or nudged, each shown on the drawing
 *    and judged before it is applied;
 *  - Swap: the same duty another way, one line per option (its change as
 *    chips, its badges as icons);
 *  - Add: accessories, and taking them out.
 *
 * Why an option is offered, what it would change and the rules it would break
 * appear on one line at the foot of the card while it is hovered; how the piece
 * is built and its issues sit behind ⓘ. What a piece is, what it offers and
 * how an option is applied come from its service's SegmentProvider; this layer
 * does the rest, the same for every service. One card per piece whichever view
 * shows it, and one card open at a time whatever its service — the plan
 * overlays and the 3D layer only report what the pointer is on and where that
 * piece is on screen. The card and its leader follow the piece every frame
 * (pan, zoom, orbit) by writing their transforms directly; React renders only
 * when the focus or the drawing changes. Hover content follows WCAG 2.2
 * SC 1.4.13: it can be dismissed (Esc), the pointer can move onto it, and it
 * stays while the pointer is on the piece or the card.
 */
import { ChevronLeft, ChevronRight, Info, Keyboard, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type { HvacElement } from '../../../../types';
import type { ScreenRect } from '../duct/popoverPlacement';

import {
  OptionRow,
  PEEK_DELAY_MS,
  PEEK_GRACE_MS,
  PEEK_SWAPS,
  PEEK_SWITCH_MS,
  ROWS_SHOWN,
  onListKey,
  useAnchoredCard,
  useOptionEvaluations,
  type HoverInfo,
} from './SegmentCardKit';
import type { SegmentEvaluationLike, SegmentOptionLike, SegmentProvider } from './segmentProvider';
import { domainOf, focusId, sameFocus, useSegmentUiStore, type SegmentDomain, type SegmentFocus, type SegmentPreview } from './segmentUiStore';

// Providers of different services sit in one list; each card is typed by its own.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySegmentProvider = SegmentProvider<any, any>;

type CardTab = 'edit' | 'swap' | 'add';
const TAB_TITLES: Record<CardTab, string> = { edit: 'Edit', swap: 'Swap', add: 'Add' };
/** The tab a designer last used for a kind of piece, per service (this session). */
const LAST_TAB = new Map<string, CardTab>();
const NO_OPTIONS: readonly never[] = [];
const NO_BADGES = new Map<string, string[]>();

/** An evaluation that changes nothing on the drawing. */
function changesNothing(evaluation: SegmentEvaluationLike): boolean {
  return evaluation.updates.length === 0 && !evaluation.add?.length && !evaluation.removeIds?.length;
}

function previewOf(domain: SegmentDomain, optionId: string, evaluation: SegmentEvaluationLike): SegmentPreview {
  return {
    domain,
    optionId,
    updates: evaluation.updates,
    ...(evaluation.add?.length ? { add: evaluation.add } : {}),
    ...(evaluation.removeIds?.length ? { removeIds: evaluation.removeIds } : {}),
  };
}

type ApplyHandler = (focus: SegmentFocus, option: SegmentOptionLike, evaluation: SegmentEvaluationLike, rekeyToken: unknown) => void;

function SegmentCard<O extends SegmentOptionLike, E extends SegmentEvaluationLike>({ provider, variant, focus, scene, resolveAnchor, containerRef, onPointerEnter, onPointerLeave, onApply }: {
  provider: SegmentProvider<O, E>;
  variant: 'peek' | 'pinned';
  focus: SegmentFocus;
  scene: HvacElement[];
  resolveAnchor: (focus: SegmentFocus) => ScreenRect | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onApply: ApplyHandler;
}) {
  // Read on every render (cached by the provider per drawing), so the card follows the drawing and the building.
  const model = provider.model(scene, focus);
  const options: readonly O[] = model?.options ?? NO_OPTIONS;
  const evaluations = useOptionEvaluations(model?.evaluate ?? null, options);
  const badges = useMemo(() => provider.rank?.(options, evaluations) ?? NO_BADGES, [provider, options, evaluations]);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo<O, E> | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [moreRows, setMoreRows] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const leaderRef = useRef<SVGSVGElement | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const pinned = variant === 'pinned';
  useAnchoredCard(cardRef, containerRef, () => resolveAnchor(focus), Boolean(model), pinned ? { leaderRef, chipRef } : undefined);
  const pin = useSegmentUiStore((state) => state.pin);
  const unpin = useSegmentUiStore((state) => state.unpin);
  const domain = provider.domain;
  const preview = useCallback((option: O | null) => {
    const store = useSegmentUiStore.getState();
    if (!option || !model) {
      if (store.preview) store.setPreview(null);
      return;
    }
    const evaluation = evaluations.get(option.id) ?? model.evaluate(option);
    store.setPreview(evaluation.refused || changesNothing(evaluation) ? null : previewOf(domain, option.id, evaluation));
  }, [evaluations, model, domain]);
  // Hovering an option (a row, a chip, a field) explains it at the card's foot, and shows it on the drawing when it can be built.
  const hover = useCallback((info: HoverInfo<O, E> | null) => {
    setHoverInfo(info);
    if (!info) {
      preview(null);
      return;
    }
    const reason = info.option.disabledReason ?? info.evaluation?.refused;
    preview(reason || info.option.current ? null : info.option);
  }, [preview]);
  // A card closing (or turning to another piece) leaves no preview behind.
  const pieceId = focusId(focus);
  useEffect(() => () => {
    if (useSegmentUiStore.getState().preview) useSegmentUiStore.getState().setPreview(null);
  }, [pieceId]);
  const swaps = useMemo(() => (model ? options.filter((option) => model.tabOf(option) === 'swap') : []), [model, options]);
  const accessories = useMemo(() => (model ? options.filter((option) => model.tabOf(option) === 'add') : []), [model, options]);
  const apply = (option: O) => {
    if (!model) return;
    setHoverInfo(null);
    onApply(focus, option, evaluations.get(option.id) ?? model.evaluate(option), model.rekeyToken);
  };
  const editContent = model
    ? model.edit({ evaluate: model.evaluate, evaluations, onPreview: preview, onHover: hover, onApply: apply, result: provider.result })
    : null;
  const tabs = useMemo(() => {
    const list: CardTab[] = [];
    if (editContent) list.push('edit');
    if (swaps.length) list.push('swap');
    if (accessories.length) list.push('add');
    return list;
  }, [editContent, swaps.length, accessories.length]);
  const kindKey = model ? `${domain}|${model.head.kind}` : '';
  const [tab, setTab] = useState<CardTab | null>(null);
  const activeTab: CardTab | null = tab && tabs.includes(tab) ? tab
    : (LAST_TAB.get(kindKey) && tabs.includes(LAST_TAB.get(kindKey)!) ? LAST_TAB.get(kindKey)! : tabs.includes('swap') ? 'swap' : tabs[0] ?? null);
  if (!model) return null;
  const { head, issues } = model;
  const ids = provider.testIdPrefix;
  const step = (direction: -1 | 1) => {
    const next = model.neighbour(direction);
    if (next) pin({ ...focus, key: next.key, anchorMark: next.anchorMark });
  };
  const chooseTab = (next: CardTab) => {
    setTab(next);
    LAST_TAB.set(kindKey, next);
    setMoreRows(false);
  };
  const recommended = provider.recommendedBadge;
  // The peek's quick picks: swaps that break no rule, the recommended first, then by the provider's score.
  const quick = swaps.filter((option) => {
    const evaluation = evaluations.get(option.id);
    return !option.current && !option.disabledReason && evaluation && !evaluation.refused && !evaluation.newIssues.some((issue) => issue.severity === 'error');
  })
    .sort((a, b) => {
      const ra = recommended && badges.get(a.id)?.includes(recommended) ? -1 : 0;
      const rb = recommended && badges.get(b.id)?.includes(recommended) ? -1 : 0;
      if (ra !== rb) return ra - rb;
      const ea = evaluations.get(a.id);
      const eb = evaluations.get(b.id);
      return (ea && provider.quickScore ? provider.quickScore(ea) : 0) - (eb && provider.quickScore ? provider.quickScore(eb) : 0);
    }).slice(0, PEEK_SWAPS);
  const row = (option: O) => (
    <OptionRow key={option.id} option={option} evaluation={evaluations.get(option.id)} badges={badges.get(option.id) ?? []} badgeDefs={provider.badges}
      glyph={provider.optionGlyph(option)} chips={provider.chips} onHover={hover} onApply={apply} />
  );
  const rows = (list: readonly O[], limit: boolean) => {
    const shown = limit && !moreRows ? list.slice(0, ROWS_SHOWN) : list;
    return (
      <>
        {shown.map(row)}
        {limit && list.length > ROWS_SHOWN && !moreRows ? (
          <button type="button" className="w-full rounded-lg px-2 py-1 text-left text-[11px] font-medium text-violet-700 hover:bg-violet-50" onClick={() => setMoreRows(true)}>
            {list.length - ROWS_SHOWN} more…
          </button>
        ) : null}
      </>
    );
  };
  const hoverReason = hoverInfo ? hoverInfo.option.disabledReason ?? hoverInfo.evaluation?.refused : null;
  const hoverNotes = hoverInfo?.evaluation && !hoverInfo.evaluation.refused ? hoverInfo.evaluation.notes : [];
  return (
    <>
      {pinned ? (
        <>
          <svg ref={leaderRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" style={{ visibility: 'hidden', zIndex: 1 }}
            aria-hidden="true" data-testid={`${ids}-leader`}>
            <line stroke="#7c3aed" strokeWidth={1.5} strokeLinecap="round" />
            <circle data-attach r={2.5} fill="#7c3aed" />
            <circle data-pin r={4.5} fill="#7c3aed" stroke="#ffffff" strokeWidth={2} />
          </svg>
          <div ref={chipRef} data-testid={`${ids}-chip`}
            className="pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-full bg-violet-600 px-2 py-[2px] text-[10.5px] font-semibold text-white shadow-md ring-2 ring-white"
            style={{ visibility: 'hidden', zIndex: 1 }}>
            {head.tag} · {head.size}
          </div>
        </>
      ) : null}
      <div
        ref={cardRef}
        role="dialog"
        aria-label={`${head.title} ${head.size}, ${head.tag}`}
        data-testid={pinned ? `${ids}-card` : `${ids}-peek`}
        data-segment-domain={domain}
        data-segment-key={focus.key}
        data-segment-run={focus.runId}
        // The 3D layer leaves pointer events on this card to it.
        data-pipe-edit-gizmo={ids}
        className={`pointer-events-auto absolute left-0 top-0 flex max-h-[min(72vh,560px)] flex-col ${pinned ? 'w-[320px]' : 'w-[272px]'} overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 text-slate-700 shadow-[0_18px_48px_-16px_rgba(15,23,42,0.38)] backdrop-blur-md`}
        style={{ visibility: 'hidden', zIndex: pinned ? 2 : 3 }}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        {/* Header: what it is, where it is in the run. */}
        <div className="flex items-start gap-2 px-3 pt-2.5">
          <span className={`mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${head.tone}`} aria-hidden="true">
            {head.glyph}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-slate-900">{head.title}</span>
              <span className="shrink-0 rounded-md bg-violet-50 px-1 py-[1px] font-mono text-[10px] text-violet-700">{head.tag}</span>
            </div>
            <div className="truncate text-[11.5px] text-slate-500" title={head.detail}>{head.size}{head.detail ? ` · ${head.detail}` : ''}</div>
          </div>
          {pinned ? (
            <div className="-mr-1 flex shrink-0 items-center text-slate-400">
              {issues.length ? (
                <button type="button" className="mr-0.5 inline-flex items-center gap-0.5 rounded-md bg-red-50 px-1 py-[1px] text-[10.5px] font-semibold text-red-700 hover:bg-red-100"
                  aria-label={`${issues.length} issue${issues.length === 1 ? '' : 's'}`} title="Its issues" onClick={() => setInfoOpen(true)}>
                  <TriangleAlert size={11} aria-hidden="true" />{issues.length}
                </button>
              ) : null}
              <button type="button" className={`rounded-md p-1 hover:bg-slate-100 hover:text-slate-700 ${infoOpen ? 'bg-slate-100 text-slate-700' : ''}`}
                aria-label="How it is built" aria-expanded={infoOpen} title="How it is built" onClick={() => setInfoOpen((open) => !open)}><Info size={13} /></button>
              <button type="button" className="rounded-md p-1 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" aria-label="Previous segment" title="Previous segment ( [ )"
                disabled={!model.neighbour(-1)} onClick={() => step(-1)}><ChevronLeft size={14} /></button>
              <button type="button" className="rounded-md p-1 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" aria-label="Next segment" title="Next segment ( ] )"
                disabled={!model.neighbour(1)} onClick={() => step(1)}><ChevronRight size={14} /></button>
              <button type="button" className="rounded-md p-1 hover:bg-slate-100 hover:text-slate-700" aria-label="Close" title="Close (Esc)" onClick={unpin}><X size={14} /></button>
            </div>
          ) : null}
        </div>
        <div className="pt-1.5">{model.figures}</div>
        {pinned ? (
          <>
            {/* How it is built, and its issues: behind ⓘ (kept in the page for assistive technology). */}
            <div className="mx-3 mb-2 space-y-1 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-600" data-testid={`${ids}-info`} hidden={!infoOpen}>
              {model.info}
              {issues.length ? (
                <ul className="space-y-0.5 pt-0.5" data-testid={`${ids}-issues`}>
                  {issues.map((issue, index) => (
                    <li key={index} className={issue.severity === 'error' ? 'text-red-700' : 'text-amber-700'}>{issue.code}: {issue.message}</li>
                  ))}
                </ul>
              ) : null}
              <div className="flex items-center gap-1 pt-0.5 text-[10.5px] text-slate-400">
                <Keyboard size={11} aria-hidden="true" />[ ] previous / next segment · ↑ ↓ options · Enter applies · Esc closes
              </div>
            </div>
            {tabs.length ? (
              <div className="mx-3 mb-1.5 flex rounded-xl bg-slate-100 p-0.5" role="tablist" aria-label="Segment options">
                {tabs.map((value) => (
                  <button key={value} type="button" role="tab" aria-selected={activeTab === value} data-segment-tab={value}
                    className={`flex-1 rounded-lg px-2 py-[3px] text-[11.5px] font-semibold transition-colors ${activeTab === value ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                    onClick={() => chooseTab(value)}>
                    {TAB_TITLES[value]}
                    {value === 'swap' ? <span className="ml-1 text-[10.5px] font-medium text-slate-400">{swaps.length}</span> : null}
                    {value === 'add' ? <span className="ml-1 text-[10.5px] font-medium text-slate-400">{accessories.length}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
              <div role="tabpanel" data-tab-panel="edit" hidden={activeTab !== 'edit'} data-testid={`${ids}-edit`} onKeyDown={onListKey}>{editContent}</div>
              <div role="tabpanel" data-tab-panel="swap" hidden={activeTab !== 'swap'} data-testid={`${ids}-swaps`} onKeyDown={onListKey}>{rows(swaps, true)}</div>
              <div role="tabpanel" data-tab-panel="add" hidden={activeTab !== 'add'} data-testid={`${ids}-accessories`} onKeyDown={onListKey}>{rows(accessories, false)}</div>
            </div>
            {/* What the option under the pointer is, does and changes — one line or two, only while it is pointed at. */}
            {hoverInfo ? (
              <div className="border-t border-slate-100 bg-slate-50/80 px-3 py-1.5 text-[11px] leading-snug" aria-live="polite" data-testid={`${ids}-hover`}>
                <div className={hoverReason ? 'text-red-700' : 'text-slate-600'}>{hoverReason ?? hoverInfo.option.detail}</div>
                {!hoverReason && hoverInfo.evaluation ? <div className="text-slate-500">{provider.result(hoverInfo.evaluation)}</div> : null}
                {hoverNotes.length ? (
                  <div className="line-clamp-2 text-violet-800" data-testid={`${ids}-notes`} title={hoverNotes.join(' · ')}>
                    <span className="font-medium">Also changes: </span>{hoverNotes.join(' · ')}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          quick.length ? (
            <div className="border-t border-slate-100 px-1.5 py-1" data-testid={`${ids}-quick`} onKeyDown={onListKey}>
              {quick.map(row)}
            </div>
          ) : null
        )}
      </div>
    </>
  );
}

export interface SegmentCardLayerProps {
  enabled: boolean;
  hvacElements: HvacElement[];
  selectedIds: string[];
  /** One per service with segment cards; a focus of a service without one shows no card. */
  providers: readonly AnySegmentProvider[];
  /** Client rectangle of a focused piece's anchor (and a point on it), or null when it is off screen or gone. */
  resolveAnchor: (focus: SegmentFocus) => ScreenRect | null;
}

export function SegmentCardLayer({ enabled, hvacElements, selectedIds, providers, resolveAnchor }: SegmentCardLayerProps) {
  const byDomain = useMemo(() => new Map<SegmentDomain, AnySegmentProvider>(providers.map((provider) => [provider.domain, provider])), [providers]);
  const storedHovered = useSegmentUiStore((state) => state.hovered);
  const storedPinned = useSegmentUiStore((state) => state.pinned);
  const hovered = storedHovered && byDomain.has(domainOf(storedHovered)) ? storedHovered : null;
  const pinned = storedPinned && byDomain.has(domainOf(storedPinned)) ? storedPinned : null;
  const unpin = useSegmentUiStore((state) => state.unpin);
  const pin = useSegmentUiStore((state) => state.pin);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [peek, setPeek] = useState<SegmentFocus | null>(null);
  const [dismissed, setDismissed] = useState('');
  const overPeekRef = useRef(false);
  /** Where the card should go once an applied option has changed the run (its piece may have changed key). */
  const afterApplyRef = useRef<{ focus: SegmentFocus; token: unknown } | null>(null);
  const peekOpen = peek !== null;

  // Hover intent: a short rest before a card peeks; leaving gives a moment to reach the card.
  useEffect(() => {
    if (!enabled) {
      setPeek(null);
      return undefined;
    }
    const onPinned = hovered && pinned && focusId(pinned) === focusId(hovered);
    if (hovered && !onPinned && focusId(hovered) !== dismissed) {
      const timer = window.setTimeout(() => setPeek(hovered), peekOpen ? PEEK_SWITCH_MS : PEEK_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    if (!hovered && dismissed) setDismissed('');
    const timer = window.setTimeout(() => {
      if (!overPeekRef.current || onPinned) setPeek(null);
    }, onPinned ? 0 : PEEK_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, hovered, pinned, dismissed, peekOpen]);

  // A pinned card closes with its run: deselected, deleted, or another tool taken. Judged when the selection changes (or
  // the tool), so a card pinned by the same click that selects its run is never closed before that selection arrives.
  const selectionRef = useRef(selectedIds);
  useEffect(() => {
    const selectionChanged = selectionRef.current !== selectedIds;
    selectionRef.current = selectedIds;
    if (pinned && (!enabled || (selectionChanged && !selectedIds.includes(pinned.runId)))) unpin();
  }, [enabled, pinned, selectedIds, unpin]);

  // After an option is applied the card stays on its piece, or on the one its service says it became.
  useEffect(() => {
    const after = afterApplyRef.current;
    if (!after || !pinned || focusId(pinned) !== focusId(after.focus)) return;
    afterApplyRef.current = null;
    const provider = byDomain.get(domainOf(pinned));
    if (!provider) return;
    const next = provider.rekey(hvacElements, pinned, after.token);
    if (!next) unpin();
    else if (!sameFocus(next, pinned)) pin(next);
  }, [hvacElements, byDomain, pinned, pin, unpin]);

  // A pinned piece can go while its card is open: another editor changed the run (a drag renumbered its pieces, say).
  // The card then follows it as after its own edits — the same key, else what its service says it became — or closes.
  const lastTokenRef = useRef<{ id: string; token: unknown } | null>(null);
  useEffect(() => {
    if (!pinned) {
      lastTokenRef.current = null;
      return;
    }
    const provider = byDomain.get(domainOf(pinned));
    if (!provider) return;
    const model = provider.model(hvacElements, pinned);
    if (model) {
      lastTokenRef.current = { id: focusId(pinned), token: model.rekeyToken };
      return;
    }
    const last = lastTokenRef.current;
    if (!last || last.id !== focusId(pinned)) return;
    const next = provider.rekey(hvacElements, pinned, last.token);
    if (!next) unpin();
    else if (!sameFocus(next, pinned)) pin(next);
  }, [hvacElements, byDomain, pinned, pin, unpin]);

  const apply = useCallback<ApplyHandler>((focus, option, evaluation, rekeyToken) => {
    const provider = byDomain.get(domainOf(focus));
    useSegmentUiStore.getState().setPreview(null);
    if (!provider || evaluation.refused || changesNothing(evaluation)) return;
    afterApplyRef.current = { focus: useSegmentUiStore.getState().pinned ?? focus, token: rekeyToken };
    provider.commit(evaluation, option);
  }, [byDomain]);

  const step = useCallback((direction: -1 | 1) => {
    if (!pinned) return;
    const next = byDomain.get(domainOf(pinned))?.model(hvacElements, pinned)?.neighbour(direction);
    if (next) pin({ ...pinned, key: next.key, anchorMark: next.anchorMark });
  }, [pinned, hvacElements, byDomain, pin]);

  // Esc hides a peek (until the pointer moves to another piece), else closes the pinned card; [ ] step along the run.
  useEffect(() => {
    if (!peek && !pinned) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable));
      if (event.key === 'Escape') {
        if (peek) {
          setDismissed(focusId(peek));
          setPeek(null);
        } else if (pinned && !typing) {
          unpin();
        } else return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!pinned || typing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '[' || event.key === ']') {
        step(event.key === '[' ? -1 : 1);
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peek, pinned, unpin, step]);

  if (!enabled) return null;
  const pinnedProvider = pinned ? byDomain.get(domainOf(pinned)) : undefined;
  const peekProvider = peek ? byDomain.get(domainOf(peek)) : undefined;
  const showPeek = peek && peekProvider && !(pinned && focusId(pinned) === focusId(peek));
  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[28]" data-testid="segment-cards">
      {pinned && pinnedProvider ? (
        <SegmentCard key={`pin|${focusId(pinned)}`} provider={pinnedProvider} variant="pinned" focus={pinned} scene={hvacElements}
          resolveAnchor={resolveAnchor} containerRef={containerRef} onApply={apply} />
      ) : null}
      {showPeek ? (
        <SegmentCard key={`peek|${focusId(peek)}`} provider={peekProvider} variant="peek" focus={peek} scene={hvacElements}
          resolveAnchor={resolveAnchor} containerRef={containerRef} onApply={apply}
          onPointerEnter={() => { overPeekRef.current = true; }}
          onPointerLeave={() => {
            overPeekRef.current = false;
            if (!useSegmentUiStore.getState().hovered) setPeek(null);
          }} />
      ) : null}
    </div>
  );
}
