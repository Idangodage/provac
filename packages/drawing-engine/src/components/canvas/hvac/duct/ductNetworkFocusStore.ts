/**
 * The stretch of a duct system the unit panel points at: hovering a network
 * row (or its dot on the friction chart) outlines that stretch on the plan; a
 * click pins it there until it is clicked again or the panel lets it go. The
 * duct overlay paints it; it is apart from the segment cards' hover and pin,
 * and never selects anything (the unit stays selected, its panel open).
 * Never saved, never undone.
 */
import { create } from 'zustand';

export interface DuctNetworkFocus {
  /** The network row's key (networkRowKey). */
  key: string;
  runId: string;
  /** The stretch, mm from the run's start. */
  fromMm: number;
  toMm: number;
  /** The run's last stretch: it reaches the run's end (its flexible runout too). */
  toEnd: boolean;
}

interface DuctNetworkFocusState {
  hovered: DuctNetworkFocus | null;
  pinned: DuctNetworkFocus | null;
  setHovered: (focus: DuctNetworkFocus | null) => void;
  /** Pins a stretch, or lets it go when it is the one pinned. */
  togglePinned: (focus: DuctNetworkFocus) => void;
  clear: () => void;
}

const same = (a: DuctNetworkFocus | null, b: DuctNetworkFocus | null) => a?.key === b?.key;

export const useDuctNetworkFocusStore = create<DuctNetworkFocusState>((set) => ({
  hovered: null,
  pinned: null,
  setHovered: (focus) => set((state) => (same(state.hovered, focus) ? state : { hovered: focus })),
  togglePinned: (focus) => set((state) => ({ pinned: same(state.pinned, focus) ? null : focus })),
  clear: () => set((state) => (state.hovered || state.pinned ? { hovered: null, pinned: null } : state)),
}));
