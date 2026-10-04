import { describe, expect, it } from 'vitest';

import { buildAutoRouteReview, ductUnitReview } from './autoRouteReview';
import type { CondensateGenerationResult } from './condensate/condensateGenerator';
import type { AutoRouteDuctUnit } from './duct/ductAutoRoute';
import type { UnifiedAutoRouteResult } from './unifiedAutoRoute';

const result = (overrides: Partial<UnifiedAutoRouteResult> = {}): UnifiedAutoRouteResult => ({
  services: { gas: true, liquid: true, condensate: true, supplyDuct: true },
  ducts: null, refrigerant: null, condensate: null, clashes: [], issues: [], ...overrides,
});
const unit = (overrides: Partial<AutoRouteDuctUnit> = {}): AutoRouteDuctUnit => ({
  unitId: 'fdum', unitLabel: 'FDUM22', status: 'kept', services: [], runIds: [], requiredEspPa: null,
  maxEspPa: null, firstCost: null, lifeCycleCost: null, currency: 'EUR', exact: false, notes: [], ...overrides,
});
const drain = (overrides: Partial<CondensateGenerationResult> = {}): CondensateGenerationResult => ({
  elementsToAdd: [], removeElementIds: [], perUnit: [], crossings: [], hopProposals: [], networks: [], unresolvedPaths: [],
  issues: [], envelope: { ceilingPlaneMm: 2500, soffitMm: 2800, voidFloorMm: 2500, voidTopMm: 2800, derivation: 'Test void' },
  metrics: { unitsTotal: 5, unitsConnected: 5, pumpedUnits: 4, networks: 1, pipeLengthMm: 34000, fittingCount: 10, crossings: 0, hops: 0 }, bom: [], ...overrides,
});

describe('coordinated route review', () => {
  it('never presents five connected drains as ready when final solid checks fail', () => {
    const message = 'Cassette intersects CD 32; reroute or provide clearance before applying.';
    const review = buildAutoRouteReview(result({ condensate: drain(), blockingIssues: [message],
      blockingDetails: [{ code: 'solid-clash', message, elementIds: ['cassette', 'drain'] }], issues: [message] }), []);
    expect(review.state).toBe('blocked');
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0]?.elementIds).toEqual(['cassette', 'drain']);
    expect(review.installationNotes).toEqual([]);
  });

  it('deduplicates a conflict reported by both audits without losing separate same-label objects', () => {
    const message = 'Cassette intersects CD 32.';
    const review = buildAutoRouteReview(result({ blockingIssues: [message],
      blockingDetails: [
        { code: 'solid-clash', message, elementIds: ['cassette1', 'drain1'] },
        { code: 'solid-clash', message, elementIds: ['cassette2', 'drain2'] },
      ], clashes: [{ elementIds: ['drain1', 'cassette1'], services: ['condensate', 'other'],
        distanceMm: 0, requiredMm: 25, message: 'Drain 1 touches unit 1.', resolvedByHop: false }] }), []);
    expect(review.issues).toHaveLength(2);
  });

  it('blocks a failed requested duct layout even when the remaining services contain no clashes', () => {
    const review = buildAutoRouteReview(result({ ducts: { units: [unit()], elementsToAdd: [], removeElementIds: [], terminalUpdates: [], issues: [] } }), []);
    expect(review.state).toBe('blocked');
    expect(review.applyReason).toMatch(/turn off ducts and route again/);
  });

  it('retains both selectable drains when different bodies have the same validation message', () => {
    const message = 'CD 32 has insufficient fall.';
    const review = buildAutoRouteReview(result({ blockingIssues: [message], blockingDetails: [
      { code: 'drainage', elementIds: ['drain-1'], message },
      { code: 'drainage', elementIds: ['drain-2'], message },
    ] }), []);
    expect(review.issues.map(issue => issue.elementIds)).toEqual([['drain-1'], ['drain-2']]);
  });

  it('preserves manufacturer uncertainty separately from physical clearance failures', () => {
    const notes = ['Indoor manufacturer capacity indices are missing.', 'Manufacturer model rules are not verified.',
      'Equivalent length is incomplete until model-specific allowances are supplied.', 'A wall opening requires coordination.'];
    const review = buildAutoRouteReview(result({ issues: [...notes, notes[0]!] }), []);
    expect(review.manufacturerNotes).toEqual(notes.slice(0, 3));
    expect(review.installationNotes).toEqual([notes[3]]);
    expect(review.issues).toEqual([]);
    expect(review.applyReason).toBeNull();
  });

  it('does not claim a rejected candidate turned a spigot; retains its actual constraints', () => {
    const feedback = ductUnitReview(unit({
      notes: ['Its best design still has 2 issues; left as it is.', 'Spigot turned: back to left.', 'Allow room at the take-off.', 'The bend radius is 82 mm; at least 200 mm is required.'],
      diagnostics: [{ code: 'DU_FLEX_BEND', severity: 'error', message: 'The bend radius is 82 mm; at least 200 mm is required.' }],
    }));
    expect(feedback.details[0]?.title).toBe('Bend radius below limit');
    expect(feedback.notes).toEqual(['Allow room at the take-off.']);
    expect(ductUnitReview(unit({ status: 'designed', notes: ['Spigot turned: back to left.'] })).notes).toHaveLength(1);
  });

  it('requires hop approval and never treats pending physical changes as already resolved', () => {
    const condensate = drain({ hopProposals: [{ key: 'hop', withinSoffit: true } as CondensateGenerationResult['hopProposals'][number]] });
    expect(buildAutoRouteReview(result({ condensate }), []).applyReason).toMatch(/Approve 1 required pipe hop/);
    expect(buildAutoRouteReview(result({ condensate }), ['hop']).applyReason).toBeNull();
  });

  it('keeps incomplete drainage visibly blocked even with an older preview without audit strings', () => {
    const condensate = drain();
    condensate.metrics.unitsConnected = 4;
    expect(buildAutoRouteReview(result({ condensate }), []).applyReason).toMatch(/no drain route/);
  });

  it('identifies selected terminals with no unit instead of presenting an empty duct layout as ready', () => {
    const review = buildAutoRouteReview(result({ ducts: { units: [], elementsToAdd: [], removeElementIds: [],
      terminalUpdates: [], issues: [], unservedTerminalIds: ['diffuser'] } }), []);
    expect(review.state).toBe('blocked');
    expect(review.applyReason).toMatch(/1 selected air terminal has no duct route/);
    expect(review.issues[0]?.elementIds).toEqual(['diffuser']);
  });

  it('keeps assignment and physical conflicts distinct when they reference the same two terminals', () => {
    const review = buildAutoRouteReview(result({ ducts: { units: [], elementsToAdd: [], removeElementIds: [],
      terminalUpdates: [], issues: [], unservedTerminalIds: ['a', 'b'] },
    blockingDetails: [{ code: 'solid-clash', message: 'Air terminals overlap.', elementIds: ['a', 'b'] }] }), []);
    expect(review.issues).toHaveLength(2);
    expect(review.issues.map(issue => issue.title)).toContain('Air terminals need a ducted unit');
  });
});
