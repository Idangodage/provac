/**
 * The draft a unit's next Auto duct design is made from, shared by the Auto
 * duct card and the unit panel: the system airflow its bases are linked at
 * (typed, else the unit's Airflow field, else the maker's at the fan speed),
 * the basis per service (the project's defaults until changed), the services
 * sized, and the per-unit store both panels read.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveDuctSettings } from './ductSettings';
import {
  EMPTY_DUCT_SIZING_DRAFT,
  draftAirflow,
  draftBases,
  draftBasis,
  draftServices,
  useDuctSizingDraftStore,
  type DuctSizingDraft,
} from './ductSizingDraft';
import { defaultSizingBasis, frictionAtVelocity, linkSizingBasis } from './ductSystemSizing';

const settings = resolveDuctSettings({});
/** MHI FDUM22KXE6F-W: 13 / 10 / 9 / 8 m³/min at P-Hi / Hi / Me / Lo. */
const fdum22: Pick<HvacElement, 'properties'> = { properties: { modelCode: 'FDUM22KXE6F-W' } };
const draft = (patch: Partial<DuctSizingDraft> = {}): DuctSizingDraft => ({ ...EMPTY_DUCT_SIZING_DRAFT, ...patch });

describe('draftAirflow', () => {
  it("untyped: the maker's airflow at the fan speed", () => {
    expect(draftAirflow(fdum22, draft())).toEqual({ override: null, error: null, systemAirflowM3h: 600, defaultAirflowM3h: 600 });
    expect(draftAirflow(fdum22, draft({ fanSpeed: 'p-hi' })).systemAirflowM3h).toBe(780);
    expect(draftAirflow(fdum22, draft({ fanSpeed: 'lo' })).systemAirflowM3h).toBe(480);
  });

  it("typed: it overrides, and what it would be untyped stays the fan speed's", () => {
    expect(draftAirflow(fdum22, draft({ airflowDraft: '700' }))).toEqual({ override: 700, error: null, systemAirflowM3h: 700, defaultAirflowM3h: 600 });
  });

  it("the unit's Airflow field stands in when nothing is typed", () => {
    const withField: Pick<HvacElement, 'properties'> = { properties: { modelCode: 'FDUM22KXE6F-W', airflowLps: 200 } };
    expect(draftAirflow(withField, draft()).systemAirflowM3h).toBe(720);
    expect(draftAirflow(withField, draft({ airflowDraft: '650' })).systemAirflowM3h).toBe(650);
  });

  it('text that is not an airflow: an error, and no airflow to size at', () => {
    for (const text of ['abc', '0', '60000']) {
      const entry = draftAirflow(fdum22, draft({ airflowDraft: text }));
      expect(entry.override).toBeNull();
      expect(entry.error).toBeTruthy();
      expect(entry.systemAirflowM3h).toBeNull();
      expect(entry.defaultAirflowM3h).toBe(600);
    }
  });
});

describe('draftBasis and draftBases', () => {
  it("the project's defaults until changed, linked at the system airflow", () => {
    const empty = draft();
    const basis = draftBasis('supply', empty, settings, draftAirflow(fdum22, empty));
    expect(basis).toEqual(linkSizingBasis({ ...defaultSizingBasis(settings, 'supply', null, 'hi'), fanSpeed: 'hi', airflowM3h: null }, 600));
    expect(basis.drive).toBe('friction');
    expect(basis.frictionPaPerM).toBe(settings.autoFrictionSupplyPaPerM);
  });

  it('the return service starts at its own friction rate', () => {
    const empty = draft();
    expect(draftBasis('return', empty, settings, draftAirflow(fdum22, empty)).frictionPaPerM).toBe(settings.autoFrictionReturnPaPerM);
  });

  it("a changed basis is kept; its fan speed and typed airflow are the draft's, and it is linked at that airflow", () => {
    const changed = { ...defaultSizingBasis(settings, 'supply', null, 'hi'), drive: 'velocity' as const, mainVelocityMs: 3 };
    const typed = draft({ fanSpeed: 'p-hi', airflowDraft: '700', bases: { supply: changed } });
    const basis = draftBasis('supply', typed, settings, draftAirflow(fdum22, typed));
    expect(basis).toMatchObject({ drive: 'velocity', mainVelocityMs: 3, fanSpeed: 'p-hi', airflowM3h: 700 });
    expect(basis.frictionPaPerM).toBeCloseTo(frictionAtVelocity(700, 3), 3);
    // The other service keeps the defaults, at the same fan speed and airflow.
    expect(draftBasis('return', typed, settings, draftAirflow(fdum22, typed))).toMatchObject({ drive: 'friction', fanSpeed: 'p-hi', airflowM3h: 700 });
  });

  it('one basis per service sized, each as draftBasis gives it', () => {
    const empty = draft();
    const airflow = draftAirflow(fdum22, empty);
    expect(Object.keys(draftBases(['supply'], empty, settings, airflow))).toEqual(['supply']);
    expect(draftBases(['supply', 'return'], empty, settings, airflow)).toEqual({
      supply: draftBasis('supply', empty, settings, airflow),
      return: draftBasis('return', empty, settings, airflow),
    });
  });
});

describe('draftServices', () => {
  it('sizes the services ticked that have terminals to serve', () => {
    expect(draftServices(draft(), { supply: 2, return: 0 })).toEqual(['supply']);
    expect(draftServices(draft(), { supply: 2, return: 1 })).toEqual(['supply', 'return']);
    expect(draftServices(draft({ services: { supply: false, return: true } }), { supply: 2, return: 1 })).toEqual(['return']);
    expect(draftServices(draft(), { supply: 0, return: 0 })).toEqual([]);
  });
});

describe('the draft store', () => {
  afterEach(() => useDuctSizingDraftStore.setState({ drafts: {} }));

  it('keeps one draft per unit: updates merge onto the empty draft, reset drops it', () => {
    useDuctSizingDraftStore.getState().update('u1', { fanSpeed: 'me' });
    useDuctSizingDraftStore.getState().update('u1', { airflowDraft: '500' });
    expect(useDuctSizingDraftStore.getState().drafts.u1).toEqual({ ...EMPTY_DUCT_SIZING_DRAFT, fanSpeed: 'me', airflowDraft: '500' });
    expect(useDuctSizingDraftStore.getState().drafts.u2).toBeUndefined();
    useDuctSizingDraftStore.getState().reset('u1');
    expect(useDuctSizingDraftStore.getState().drafts.u1).toBeUndefined();
  });

  it('an update never changes the shared empty draft', () => {
    useDuctSizingDraftStore.getState().update('u1', {
      bases: { supply: defaultSizingBasis(settings, 'supply', null, 'hi') },
      terminalAirflows: { d1: 300 },
      services: { supply: true, return: false },
    });
    expect(EMPTY_DUCT_SIZING_DRAFT).toEqual({ fanSpeed: 'hi', airflowDraft: '', services: { supply: true, return: true }, bases: {}, terminalAirflows: {} });
  });

  it('resetting a unit without a draft leaves the state as it is', () => {
    const before = useDuctSizingDraftStore.getState().drafts;
    useDuctSizingDraftStore.getState().reset('nobody');
    expect(useDuctSizingDraftStore.getState().drafts).toBe(before);
  });
});
