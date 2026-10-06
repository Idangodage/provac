/**
 * Transient segment-focus state (never saved with the document): the segment
 * of a selected duct run under the pointer, the one whose options card is
 * pinned open, and the option being previewed. Both views write it (the plan
 * overlay and the 3D layer) and read the preview, and the card layer reads
 * all of it, so a segment has one card whichever view shows it.
 */
import { create } from 'zustand';

import type { HvacElement } from '../../../../types';

import type { DuctSegmentRef } from './ductSegments';

/** A segment with the piece the pointer was on (the card is placed beside that piece). */
export interface DuctSegmentFocus extends DuctSegmentRef {
  anchorMark: string | null;
  /** The view the focus came from: the plan, or a 3D view. */
  view: '2d' | '3d';
}

/** An option shown on the drawing before it is applied: the elements it would change, as they would be. */
export interface DuctSegmentPreview {
  optionId: string;
  updates: HvacElement[];
}

interface DuctSegmentUiState {
  hovered: DuctSegmentFocus | null;
  pinned: DuctSegmentFocus | null;
  preview: DuctSegmentPreview | null;
  /** Hover on a segment (or off every segment); nothing changes when it is the same piece. */
  setHovered: (focus: DuctSegmentFocus | null) => void;
  pin: (focus: DuctSegmentFocus) => void;
  unpin: () => void;
  setPreview: (preview: DuctSegmentPreview | null) => void;
}

export function sameFocus(a: DuctSegmentFocus | null, b: DuctSegmentFocus | null): boolean {
  if (a === b) return true;
  return Boolean(a && b && a.runId === b.runId && a.key === b.key && a.anchorMark === b.anchorMark && a.view === b.view);
}

export const useDuctSegmentUiStore = create<DuctSegmentUiState>((set, get) => ({
  hovered: null,
  pinned: null,
  preview: null,
  setHovered: (focus) => {
    if (!sameFocus(get().hovered, focus)) set({ hovered: focus });
  },
  pin: (focus) => {
    if (!sameFocus(get().pinned, focus)) set({ pinned: focus, preview: null });
  },
  unpin: () => {
    if (get().pinned || get().preview) set({ pinned: null, preview: null });
  },
  setPreview: (preview) => {
    const current = get().preview;
    if (current === preview || (current && preview && current.optionId === preview.optionId && current.updates === preview.updates)) return;
    set({ preview });
  },
}));
