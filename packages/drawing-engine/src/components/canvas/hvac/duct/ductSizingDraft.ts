/**
 * What the designer has set for a unit's next Auto duct design — fan speed,
 * typed system airflow, services, the constant-friction bases and terminal
 * airflows — kept per unit for the session (never saved, never undone).
 * The Auto duct card and the unit panel read and write the same draft, so
 * the request Generate sends, the preview's live resize and both panels agree.
 */
import { create } from 'zustand';

import type { HvacElement } from '../../../../types';

import type { AutoDuctSizingBases } from './ductAutoLayout';
import { parseDuctNumber } from './ductNumericValue';
import type { DuctDesignSettings } from './ductSettings';
import type { FanSpeed } from './ductSizing';
import { basisAirflowM3h, defaultSizingBasis, linkSizingBasis } from './ductSystemSizing';
import type { DuctService, DuctSystemSizing } from './ductTypes';

export interface DuctSizingDraft {
  fanSpeed: FanSpeed;
  /** The system airflow as typed ('' = the unit's own at the fan speed). */
  airflowDraft: string;
  services: { supply: boolean; return: boolean };
  /** Constant-friction bases the designer changed, per service. */
  bases: Partial<Record<DuctService, DuctSystemSizing>>;
  /** Terminal airflows typed (m³/h; null = an equal share of what is left). */
  terminalAirflows: Record<string, number | null>;
}

export const EMPTY_DUCT_SIZING_DRAFT: DuctSizingDraft = Object.freeze({
  fanSpeed: 'hi',
  airflowDraft: '',
  services: { supply: true, return: true },
  bases: {},
  terminalAirflows: {},
}) as DuctSizingDraft;

interface DuctSizingDraftState {
  drafts: Record<string, DuctSizingDraft>;
  update: (unitId: string, patch: Partial<DuctSizingDraft>) => void;
  reset: (unitId: string) => void;
}

export const useDuctSizingDraftStore = create<DuctSizingDraftState>((set) => ({
  drafts: {},
  update: (unitId, patch) => set((state) => ({
    drafts: { ...state.drafts, [unitId]: { ...(state.drafts[unitId] ?? EMPTY_DUCT_SIZING_DRAFT), ...patch } },
  })),
  reset: (unitId) => set((state) => {
    if (!state.drafts[unitId]) return state;
    const { [unitId]: _dropped, ...rest } = state.drafts;
    return { drafts: rest };
  }),
}));

/** A unit's draft (the empty one until something is set). */
export function useDuctSizingDraft(unitId: string | null | undefined): DuctSizingDraft {
  return useDuctSizingDraftStore((state) => (unitId ? state.drafts[unitId] : undefined) ?? EMPTY_DUCT_SIZING_DRAFT);
}

export interface DraftAirflow {
  /** The typed airflow when valid (m³/h), else null. */
  override: number | null;
  /** Why the typed text is not an airflow. */
  error: string | null;
  /** The airflow the design is made for: typed, the unit's Airflow field, else its data at the fan speed. */
  systemAirflowM3h: number | null;
  /** What it would be untyped. */
  defaultAirflowM3h: number | null;
}

export function draftAirflow(unit: Pick<HvacElement, 'properties'>, draft: DuctSizingDraft): DraftAirflow {
  const entry = parseDuctNumber(draft.airflowDraft, 0.01, 50000, true);
  const override = entry.valid ? entry.value : null;
  return {
    override,
    error: entry.valid ? null : entry.message,
    systemAirflowM3h: entry.valid ? basisAirflowM3h(unit, { airflowM3h: override, fanSpeed: draft.fanSpeed }).airflowM3h : null,
    defaultAirflowM3h: basisAirflowM3h(unit, { airflowM3h: null, fanSpeed: draft.fanSpeed }).airflowM3h,
  };
}

/** A service's basis in the draft (the project's defaults until changed), linked at the system airflow. */
export function draftBasis(service: DuctService, draft: DuctSizingDraft, settings: DuctDesignSettings, airflow: DraftAirflow): DuctSystemSizing {
  return linkSizingBasis({
    ...(draft.bases[service] ?? defaultSizingBasis(settings, service, null, draft.fanSpeed)),
    fanSpeed: draft.fanSpeed,
    airflowM3h: airflow.override,
  }, airflow.systemAirflowM3h);
}

/** The bases of the services sized, as Generate and the preview take them. */
export function draftBases(services: readonly DuctService[], draft: DuctSizingDraft, settings: DuctDesignSettings, airflow: DraftAirflow): AutoDuctSizingBases {
  return Object.fromEntries(services.map((service) => [service, draftBasis(service, draft, settings, airflow)]));
}

/** The services a design sizes: ticked, with terminals to serve. */
export function draftServices(draft: DuctSizingDraft, counts: Record<DuctService, number>): DuctService[] {
  return (['supply', 'return'] as const).filter((service) => draft.services[service] && counts[service] > 0);
}
