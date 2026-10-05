/**
 * Transient air-system UI state (never saved with the document):
 *  - pick mode: clicking terminals on the plan adds them to (or removes them
 *    from) one unit's system;
 *  - the placement target: terminals placed from the toolbox join this unit;
 *  - a placement request from a panel (the editor starts placing the entry).
 */
import { create } from 'zustand';

export interface AirSystemPlacementRequest {
  definitionId: string;
  unitId: string;
  /** Distinguishes two requests for the same entry. */
  nonce: number;
}

interface AirSystemUiState {
  pickUnitId: string | null;
  placementTarget: { unitId: string } | null;
  placementRequest: AirSystemPlacementRequest | null;
  setPickUnit: (unitId: string | null) => void;
  setPlacementTarget: (unitId: string | null) => void;
  /** Ask the editor to start placing a library entry for a unit. */
  requestPlacement: (definitionId: string, unitId: string) => void;
}

let nonce = 0;

export const useAirSystemUiStore = create<AirSystemUiState>((set) => ({
  pickUnitId: null,
  placementTarget: null,
  placementRequest: null,
  setPickUnit: (unitId) => set({ pickUnitId: unitId }),
  setPlacementTarget: (unitId) => set({ placementTarget: unitId ? { unitId } : null }),
  requestPlacement: (definitionId, unitId) => set({ placementRequest: { definitionId, unitId, nonce: (nonce += 1) }, placementTarget: { unitId } }),
}));
