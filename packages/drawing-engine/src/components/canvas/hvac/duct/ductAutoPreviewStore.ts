/**
 * The duct auto layout waiting for Apply: never saved and never in the undo
 * history (Apply commits it as one command). The preview belongs to the
 * drawing it was generated from; once the drawing changes it is out of date
 * and has to be generated again.
 */
import { create } from 'zustand';

import type { HvacElement } from '../../../../types';

import type { AutoDuctRequest, AutoDuctResult } from './ductAutoLayout';

export interface DuctAutoPreviewState {
  result: AutoDuctResult | null;
  request: AutoDuctRequest | null;
  /** The drawing the preview was generated from. */
  scene: readonly HvacElement[] | null;
  message: string | null;
  setPreview: (result: AutoDuctResult, request: AutoDuctRequest, scene: readonly HvacElement[]) => void;
  clear: (message?: string | null) => void;
}

export const useDuctAutoPreviewStore = create<DuctAutoPreviewState>((set) => ({
  result: null,
  request: null,
  scene: null,
  message: null,
  setPreview: (result, request, scene) => set({ result, request, scene, message: null }),
  clear: (message = null) => set({ result: null, request: null, scene: null, message }),
}));

/** The preview's runs as they would be stored, and the drawing they replace runs in; null when out of date. */
export function currentAutoDuctPreview(hvacElements: readonly HvacElement[]): AutoDuctResult | null {
  const { result, scene } = useDuctAutoPreviewStore.getState();
  return result && scene === hvacElements ? result : null;
}
