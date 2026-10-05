/**
 * The duct auto layout waiting for Apply: never saved and never in the undo
 * history (Apply commits it as one command). The preview belongs to the
 * drawing it was generated from; once the drawing changes it is out of date
 * and has to be generated again.
 */
import { create } from 'zustand';

import type { HvacElement } from '../../../../types';

import { selectAutoDuctDesign, type AutoDuctRequest, type AutoDuctResult, type AutoDuctWall } from './ductAutoLayout';
import { ductDesignSettingsKey, type DuctDesignSettings } from './ductSettings';

export interface AutoDuctPreviewInputs {
  settings: DuctDesignSettings;
  walls: readonly AutoDuctWall[];
}

const SETTINGS_KEYS = new WeakMap<DuctDesignSettings, string>();

function designSettingsKey(settings: DuctDesignSettings): string {
  let key = SETTINGS_KEYS.get(settings);
  if (key === undefined) {
    key = ductDesignSettingsKey(settings);
    SETTINGS_KEYS.set(settings, key);
  }
  return key;
}

export interface DuctAutoPreviewState {
  result: AutoDuctResult | null;
  request: AutoDuctRequest | null;
  /** The drawing the preview was generated from. */
  scene: readonly HvacElement[] | null;
  inputs: AutoDuctPreviewInputs | null;
  message: string | null;
  /** Generating (in the worker): the unit it is for. */
  running: string | null;
  resizing: boolean;
  setPreview: (result: AutoDuctResult, request: AutoDuctRequest, scene: readonly HvacElement[], inputs?: AutoDuctPreviewInputs) => void;
  setRunning: (unitId: string | null) => void;
  setResizing: (resizing: boolean) => void;
  /** Shows another verified design of the preview (a frontier pick). */
  selectDesign: (index: number) => void;
  clear: (message?: string | null) => void;
}

export const useDuctAutoPreviewStore = create<DuctAutoPreviewState>((set, get) => ({
  result: null,
  request: null,
  scene: null,
  inputs: null,
  message: null,
  running: null,
  resizing: false,
  setPreview: (result, request, scene, inputs) => set((state) => ({ result, request, scene, inputs: inputs ?? state.inputs, message: null, running: null })),
  setRunning: (running) => set({ running }),
  setResizing: (resizing) => set({ resizing }),
  selectDesign: (index) => {
    const { result, running, resizing } = get();
    if (!running && !resizing && result && result.designs[index]) set({ result: selectAutoDuctDesign(result, index) });
  },
  clear: (message = null) => set({ result: null, request: null, scene: null, inputs: null, message, running: null, resizing: false }),
}));

/** Every input that affects routing and sizing must still belong to the preview. */
export function isAutoDuctPreviewCurrent(
  preview: Pick<DuctAutoPreviewState, 'result' | 'scene' | 'inputs'>,
  hvacElements: readonly HvacElement[],
  settings?: DuctDesignSettings,
  walls?: readonly AutoDuctWall[],
): boolean {
  return Boolean(preview.result && preview.scene === hvacElements
    && (!settings || (preview.inputs && designSettingsKey(preview.inputs.settings) === designSettingsKey(settings)))
    && (!walls || preview.inputs?.walls === walls));
}

/** The preview's runs as they would be stored, and the drawing they replace runs in; null when out of date. */
export function currentAutoDuctPreview(hvacElements: readonly HvacElement[], settings?: DuctDesignSettings, walls?: readonly AutoDuctWall[]): AutoDuctResult | null {
  const preview = useDuctAutoPreviewStore.getState();
  return isAutoDuctPreviewCurrent(preview, hvacElements, settings, walls) ? preview.result : null;
}
