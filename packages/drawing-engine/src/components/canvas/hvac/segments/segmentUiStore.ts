/**
 * Transient segment-focus state shared by every service's segment card (never
 * saved with the document): the piece of a selected run under the pointer, the
 * one whose card is pinned open, and the option being previewed. The plan
 * overlays and the 3D layer write it and read the preview; the card layer
 * reads all of it, so a piece has one card whichever view shows it, and only
 * one card is open at a time whatever its service.
 */
import { create } from 'zustand';

import type { HvacElement } from '../../../../types';

/** The services whose runs have segment cards. */
export type SegmentDomain = 'duct' | 'refrigerant' | 'condensate';

/** A piece of a run, with the part the pointer was on (the card is placed beside that part). */
export interface SegmentFocus {
  /** The service the run belongs to; absent means a duct (the first service to have cards). */
  domain?: SegmentDomain;
  /** The run's element id. */
  runId: string;
  /** The piece's key within its run (stable across edits that keep the run's shape). */
  key: string;
  anchorMark: string | null;
  /** The view the focus came from: the plan, or a 3D view. */
  view: '2d' | '3d';
}

/**
 * An option shown on the drawing before it is applied: the elements it would
 * change, as they would be, and those it would add or remove (a drain network
 * re-solved can do both).
 */
export interface SegmentPreview {
  /** The service of the card showing it; absent means a duct's. */
  domain?: SegmentDomain;
  optionId: string;
  updates: HvacElement[];
  add?: HvacElement[];
  removeIds?: string[];
}

export function domainOf(focus: Pick<SegmentFocus, 'domain'> | null | undefined): SegmentDomain {
  return focus?.domain ?? 'duct';
}

/** Identity of a focused piece, view and anchor apart. */
export function focusId(focus: Pick<SegmentFocus, 'domain' | 'runId' | 'key'> | null | undefined): string {
  return focus ? `${domainOf(focus)}|${focus.runId}|${focus.key}` : '';
}

export function sameFocus(a: SegmentFocus | null, b: SegmentFocus | null): boolean {
  if (a === b) return true;
  return Boolean(a && b && domainOf(a) === domainOf(b) && a.runId === b.runId && a.key === b.key && a.anchorMark === b.anchorMark && a.view === b.view);
}

interface SegmentUiState {
  hovered: SegmentFocus | null;
  pinned: SegmentFocus | null;
  /**
   * The pieces picked for what is done to pieces (Delete): the pinned one, and
   * those added with Ctrl/⌘ (one) or Shift (a stretch). Any service, any run.
   */
  picked: SegmentFocus[];
  preview: SegmentPreview | null;
  /** Hover on a piece (or off every piece); nothing changes when it is the same part. */
  setHovered: (focus: SegmentFocus | null) => void;
  /** A plain click: this piece, alone (its card opens). */
  pin: (focus: SegmentFocus) => void;
  /** Ctrl/⌘ + click: the piece in or out of the picks; the card shows it (or the last pick left). */
  togglePick: (focus: SegmentFocus) => void;
  /** Shift + click: these pieces added to the picks; the card shows the last. */
  addPicks: (focuses: readonly SegmentFocus[]) => void;
  unpin: () => void;
  setPreview: (preview: SegmentPreview | null) => void;
}

const samePiece = (a: SegmentFocus, b: SegmentFocus) => focusId(a) === focusId(b);

export const useSegmentUiStore = create<SegmentUiState>((set, get) => ({
  hovered: null,
  pinned: null,
  picked: [],
  preview: null,
  setHovered: (focus) => {
    if (!sameFocus(get().hovered, focus)) set({ hovered: focus });
  },
  pin: (focus) => {
    const { pinned, picked } = get();
    if (sameFocus(pinned, focus) && picked.length === 1 && samePiece(picked[0]!, focus)) return;
    set({ pinned: focus, picked: [focus], preview: null });
  },
  togglePick: (focus) => {
    const picked = get().picked;
    const without = picked.filter((pick) => !samePiece(pick, focus));
    const next = without.length < picked.length ? without : [...picked, focus];
    set({ picked: next, pinned: next.length ? (next.includes(focus) ? focus : next[next.length - 1]!) : null, preview: null });
  },
  addPicks: (focuses) => {
    if (!focuses.length) return;
    const picked = [...get().picked];
    for (const focus of focuses) if (!picked.some((pick) => samePiece(pick, focus))) picked.push(focus);
    set({ picked, pinned: focuses[focuses.length - 1]!, preview: null });
  },
  unpin: () => {
    if (get().pinned || get().preview || get().picked.length) set({ pinned: null, picked: [], preview: null });
  },
  setPreview: (preview) => {
    const current = get().preview;
    if (current === preview || (current && preview && domainOf(current) === domainOf(preview) && current.optionId === preview.optionId
      && current.updates === preview.updates && current.add === preview.add && current.removeIds === preview.removeIds)) return;
    set({ preview });
  },
}));
