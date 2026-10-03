import { describe, expect, it } from 'vitest';

import { autoRouteDuctFeedback } from './autoRouteDuctFeedback';
import type { AutoRouteDuctResult, AutoRouteDuctUnit } from './duct/ductAutoRoute';

function unit(status: AutoRouteDuctUnit['status'], notes: string[] = []): AutoRouteDuctUnit {
  return {
    unitId: 'unit', unitLabel: 'Unit 2', status, notes, services: [], runIds: [],
    requiredEspPa: null, maxEspPa: null, firstCost: null, lifeCycleCost: null,
    currency: 'EUR', exact: null,
  };
}

function result(units: AutoRouteDuctUnit[], issues: string[] = []): AutoRouteDuctResult {
  return { units, issues, elementsToAdd: [], removeElementIds: [], terminalUpdates: [] };
}

describe('duct routing feedback', () => {
  it('calls attention to a rejected design even when the clash list is empty', () => {
    expect(autoRouteDuctFeedback(result([unit('kept', ['The route overlaps equipment.'])])))
      .toMatchObject({ summary: 'No ducts generated', needsAttention: true });
  });

  it('identifies partial results so generated ducts do not hide another unit failure', () => {
    expect(autoRouteDuctFeedback(result([unit('designed'), { ...unit('kept'), unitId: 'other' }])))
      .toMatchObject({ summary: 'Ducts 1/2 · 1 unit needs review', needsAttention: true });
  });

  it('surfaces assignment issues when no unit reached the designer', () => {
    const issue = 'Ducts: selected terminals have no unit with a free collar in the same room.';
    expect(autoRouteDuctFeedback(result([], [issue])))
      .toMatchObject({ summary: 'No ducts generated', needsAttention: true, additionalIssues: [issue] });
  });

  it('does not bury an empty scope behind a successful status', () => {
    expect(autoRouteDuctFeedback(result([])))
      .toMatchObject({ summary: 'No ducts to route', needsAttention: true });
  });

  it('keeps every unit reason in the unit card and only additional scope issues outside it', () => {
    const notes = ['The route overlaps equipment.', 'Required pressure exceeds the unit limit.'];
    const scopeIssue = 'Ducts: some terminals have no free collar.';
    const feedback = autoRouteDuctFeedback(result([unit('kept', notes)], [
      ...notes.map((note) => `Unit 2: ${note}`), scopeIssue, scopeIssue,
    ]));
    expect(feedback?.additionalIssues).toEqual([scopeIssue]);
  });

  it('leaves successful designs and pipe-only routing without a failure notice', () => {
    expect(autoRouteDuctFeedback(result([unit('designed')]))?.needsAttention).toBe(false);
    expect(autoRouteDuctFeedback(null)).toBeNull();
  });
});
