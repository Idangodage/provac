/**
 * Duct tool options (transient; not saved with the document and never in
 * history). The tool reads them at event time, so changing an option never
 * re-renders the canvas; a change mid-draw applies to the next leg (a new
 * size there becomes a transition).
 */
import { create } from 'zustand';

import type { DuctAngleMode } from './ductDraft';
import { isRoundLeg, type DuctLeg, type DuctSplitStyle, type DuctTapStyle } from './ductTypes';

export interface DuctToolState {
  angleMode: DuctAngleMode;
  /** 'collar' = a run from a unit matches the collar; 'custom' = W × H below. */
  sizeMode: 'collar' | 'custom';
  widthMm: number;
  heightMm: number;
  /** Clear section of a new branch (height is held to the parent's). */
  branchWidthMm: number;
  branchHeightMm: number;
  tapStyle: Extract<DuctTapStyle, 'shoe-45' | 'straight'>;
  splitStyle: DuctSplitStyle;
  /** Branch shape: rectangular, or round (off a rectangular run by a spin-in or conical collar). */
  branchShape: 'rect' | 'round';
  branchDiameterMm: number;
  roundTapStyle: Extract<DuctTapStyle, 'spin-in' | 'conical'>;
  /** Volume control damper at the start of each branch. */
  vcd: boolean;
  /** A run started in free space: its clear-bottom level (mm) and service. */
  freeBottomMm: number;
  freeService: 'supply' | 'return';
  /**
   * Level (clear bottom, mm) for the next leg while drawing; null = the level
   * of the point it starts from. A different level adds a riser or drop there.
   */
  levelMm: number | null;
  /** Level of the point the next leg starts from (set by the tool while drawing; null when idle). */
  anchorLevelMm: number | null;
  endKind: 'end-cap' | 'open';
  setAngleMode: (mode: DuctAngleMode) => void;
  setSize: (update: Partial<Pick<DuctToolState, 'sizeMode' | 'widthMm' | 'heightMm'>>) => void;
  setBranchSize: (update: Partial<Pick<DuctToolState, 'branchWidthMm' | 'branchHeightMm'>>) => void;
  setBranchOptions: (update: Partial<Pick<DuctToolState, 'tapStyle' | 'splitStyle' | 'vcd' | 'freeBottomMm' | 'freeService' | 'branchShape' | 'branchDiameterMm' | 'roundTapStyle'>>) => void;
  setEndKind: (kind: DuctToolState['endKind']) => void;
  setLevel: (levelMm: number | null) => void;
  setAnchorLevel: (levelMm: number | null) => void;
}

const clampSize = (value: number) => Math.max(100, Math.min(3000, Number.isFinite(value) ? value : 100));

export const useDuctToolStore = create<DuctToolState>((set) => ({
  angleMode: '90',
  sizeMode: 'collar',
  widthMm: 600,
  heightMm: 300,
  branchWidthMm: 300,
  branchHeightMm: 150,
  tapStyle: 'shoe-45',
  splitStyle: 'y',
  branchShape: 'rect',
  branchDiameterMm: 200,
  roundTapStyle: 'spin-in',
  vcd: true,
  freeBottomMm: 2700,
  freeService: 'supply',
  levelMm: null,
  anchorLevelMm: null,
  endKind: 'end-cap',
  setAngleMode: (angleMode) => set({ angleMode }),
  setSize: (update) => set((state) => ({
    sizeMode: update.sizeMode ?? state.sizeMode,
    widthMm: clampSize(update.widthMm ?? state.widthMm),
    heightMm: clampSize(update.heightMm ?? state.heightMm),
  })),
  setBranchSize: (update) => set((state) => ({
    branchWidthMm: clampSize(update.branchWidthMm ?? state.branchWidthMm),
    branchHeightMm: clampSize(update.branchHeightMm ?? state.branchHeightMm),
  })),
  setBranchOptions: (update) => set(update),
  setEndKind: (endKind) => set({ endKind }),
  setLevel: (levelMm) => set({ levelMm: levelMm === null || !Number.isFinite(levelMm) ? null : Math.round(Math.max(0, Math.min(30000, levelMm))) }),
  setAnchorLevel: (anchorLevelMm) => set({ anchorLevelMm }),
}));

/** The take-off style for a branch whose first leg is `leg` (a round branch needs a round collar). */
export function tapStyleFor(leg: DuctLeg | undefined): DuctTapStyle {
  const tool = useDuctToolStore.getState();
  return isRoundLeg(leg) ? tool.roundTapStyle : tool.tapStyle;
}
