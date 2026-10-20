/**
 * The resize a drag is making now: the grip, the value it has reached and the
 * elements as they will be, for the grips layer to ride the grip on the duct
 * as it will be and show the dimension it is taking (null: no resize drag).
 */
import { create } from 'zustand';

import type { HvacElement } from '../../../../types';

import type { DuctResizeGrip } from './ductResize';

export interface DuctResizePreview {
  grip: DuctResizeGrip;
  made: number;
  elements: readonly HvacElement[];
}

export const useDuctResizePreviewStore = create<{
  preview: DuctResizePreview | null;
  setPreview: (preview: DuctResizePreview | null) => void;
}>((set) => ({
  preview: null,
  setPreview: (preview) => set({ preview }),
}));
