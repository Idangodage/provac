/**
 * Duct tool options (transient; not saved with the document and never in
 * history). The tool reads them at event time, so changing an option never
 * re-renders the canvas.
 */
import { create } from 'zustand';

import type { DuctAngleMode } from './ductDraft';

export interface DuctToolState {
  angleMode: DuctAngleMode;
  /** 'collar' = the duct matches the unit collar; 'custom' = W × H below. */
  sizeMode: 'collar' | 'custom';
  widthMm: number;
  heightMm: number;
  endKind: 'end-cap' | 'open';
  setAngleMode: (mode: DuctAngleMode) => void;
  setSize: (update: Partial<Pick<DuctToolState, 'sizeMode' | 'widthMm' | 'heightMm'>>) => void;
  setEndKind: (kind: DuctToolState['endKind']) => void;
}

export const useDuctToolStore = create<DuctToolState>((set) => ({
  angleMode: '90',
  sizeMode: 'collar',
  widthMm: 600,
  heightMm: 300,
  endKind: 'end-cap',
  setAngleMode: (angleMode) => set({ angleMode }),
  setSize: (update) => set((state) => ({
    sizeMode: update.sizeMode ?? state.sizeMode,
    widthMm: Math.max(100, Math.min(3000, update.widthMm ?? state.widthMm)),
    heightMm: Math.max(100, Math.min(3000, update.heightMm ?? state.heightMm)),
  })),
  setEndKind: (endKind) => set({ endKind }),
}));
