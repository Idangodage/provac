/**
 * Transient Auto route preview state (gas / liquid / condensate) shared by the
 * toolbar action, the plan overlays, the 3D preview and the properties panel.
 * Never persisted and never part of undo history: only Apply commits (one
 * store command).
 */
import { create } from 'zustand';

import type { AutoRouteServices, UnifiedAutoRouteResult } from '../unifiedAutoRoute';

import type { CondensateGenerationResult } from './condensateGenerator';

export interface CondensateProgress {
  stage: string;
  completed: number;
  total: number;
}

export interface AutoRouteSignatures {
  /** Refrigerant source signature (autoRouteSourceSignature) at generation time. */
  refrigerant: string | null;
  /** Condensate source signature at generation time. */
  condensate: string | null;
}

export interface CondensatePreviewState {
  /** The whole Auto route proposal (every ticked service). */
  unified: UnifiedAutoRouteResult | null;
  /** Condensate part of the proposal (read by the condensate overlay and panel). */
  result: CondensateGenerationResult | null;
  signatures: AutoRouteSignatures | null;
  running: boolean;
  progress: CondensateProgress | null;
  message: string | null;
  /** Refrigerant hop proposals the user approved (by proposal key). */
  approvedHopKeys: string[];
  highlightUnitId: string | null;
  setRunning: (progress: CondensateProgress | null) => void;
  setUnified: (unified: UnifiedAutoRouteResult | null, signatures: AutoRouteSignatures | null) => void;
  setMessage: (message: string | null) => void;
  toggleHop: (key: string) => void;
  setHighlightUnit: (unitId: string | null) => void;
  clear: () => void;
}

export const useCondensatePreviewStore = create<CondensatePreviewState>((set) => ({
  unified: null,
  result: null,
  signatures: null,
  running: false,
  progress: null,
  message: null,
  approvedHopKeys: [],
  highlightUnitId: null,
  setRunning: (progress) => set({ running: progress !== null, progress }),
  setUnified: (unified, signatures) => set({
    unified,
    result: unified?.condensate ?? null,
    signatures,
    running: false,
    progress: null,
    approvedHopKeys: [],
  }),
  setMessage: (message) => set({ message }),
  toggleHop: (key) => set((state) => ({
    approvedHopKeys: state.approvedHopKeys.includes(key)
      ? state.approvedHopKeys.filter((candidate) => candidate !== key)
      : [...state.approvedHopKeys, key],
  })),
  setHighlightUnit: (unitId) => set({ highlightUnitId: unitId }),
  clear: () => set({
    unified: null, result: null, signatures: null, running: false, progress: null, message: null, approvedHopKeys: [], highlightUnitId: null,
  }),
}));

/** The ticked services, remembered for the browser session. */
export const AUTO_ROUTE_SERVICES_STORAGE_KEY = 'provacx.autoRoute.services';

export function readStoredAutoRouteServices(): AutoRouteServices {
  const fallback: AutoRouteServices = { gas: true, liquid: true, condensate: true };
  try {
    const raw = typeof window !== 'undefined' ? window.sessionStorage.getItem(AUTO_ROUTE_SERVICES_STORAGE_KEY) : null;
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AutoRouteServices>;
    return {
      gas: typeof parsed.gas === 'boolean' ? parsed.gas : true,
      liquid: typeof parsed.liquid === 'boolean' ? parsed.liquid : true,
      condensate: typeof parsed.condensate === 'boolean' ? parsed.condensate : true,
    };
  } catch {
    return fallback;
  }
}

export function storeAutoRouteServices(services: AutoRouteServices): void {
  try {
    window.sessionStorage.setItem(AUTO_ROUTE_SERVICES_STORAGE_KEY, JSON.stringify(services));
  } catch {
    // Storage unavailable (private mode): the ticks simply reset next session.
  }
}
