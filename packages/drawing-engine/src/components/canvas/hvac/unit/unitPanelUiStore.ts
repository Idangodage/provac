/**
 * How the unit panel was left — its tab and which folded sections are open —
 * kept for the session, so selecting another unit shows it the same way.
 * Never saved, never undone.
 */
import { create } from 'zustand';

import type { HvacUnitSystem } from '../units/hvacUnits';

export type UnitPanelTab = 'sizing' | 'spec';

interface UnitPanelUiState {
  tab: UnitPanelTab;
  /** Folded sections by key ('chart', 'first-sizing', 'limits', …): open or not. */
  open: Record<string, boolean>;
  /** The size series offered with a unit system, declined for the session ("Keep metric"). */
  seriesDeclined: Partial<Record<HvacUnitSystem, boolean>>;
  setTab: (tab: UnitPanelTab) => void;
  setOpen: (key: string, open: boolean) => void;
  declineSeries: (system: HvacUnitSystem) => void;
}

export const useUnitPanelUiStore = create<UnitPanelUiState>((set) => ({
  tab: 'sizing',
  open: {},
  seriesDeclined: {},
  setTab: (tab) => set({ tab }),
  setOpen: (key, open) => set((state) => (state.open[key] === open ? state : { open: { ...state.open, [key]: open } })),
  declineSeries: (system) => set((state) => ({ seriesDeclined: { ...state.seriesDeclined, [system]: true } })),
}));

/** A folded section's state (closed until opened) and its setter. */
export function useUnitPanelSection(key: string, initial = false): [boolean, (open: boolean) => void] {
  const open = useUnitPanelUiStore((state) => state.open[key] ?? initial);
  const setOpen = useUnitPanelUiStore((state) => state.setOpen);
  return [open, (value: boolean) => setOpen(key, value)];
}
