/**
 * How the unit panel was left — its tab and which folded sections are open —
 * kept for the session, so selecting another unit shows it the same way.
 * Never saved, never undone.
 */
import { create } from 'zustand';

export type UnitPanelTab = 'sizing' | 'spec';

interface UnitPanelUiState {
  tab: UnitPanelTab;
  /** Folded sections by key ('sections', 'calculation', 'first-sizing', 'limits', …): open or not. */
  open: Record<string, boolean>;
  setTab: (tab: UnitPanelTab) => void;
  setOpen: (key: string, open: boolean) => void;
}

export const useUnitPanelUiStore = create<UnitPanelUiState>((set) => ({
  tab: 'sizing',
  open: {},
  setTab: (tab) => set({ tab }),
  setOpen: (key, open) => set((state) => (state.open[key] === open ? state : { open: { ...state.open, [key]: open } })),
}));

/** A folded section's state (closed until opened) and its setter. */
export function useUnitPanelSection(key: string, initial = false): [boolean, (open: boolean) => void] {
  const open = useUnitPanelUiStore((state) => state.open[key] ?? initial);
  const setOpen = useUnitPanelUiStore((state) => state.setOpen);
  return [open, (value: boolean) => setOpen(key, value)];
}
