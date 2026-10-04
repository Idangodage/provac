import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';
import { PROJECT_FALLBACK_RULE_PROFILE, type ManufacturerRuleProfile, type RuleValue } from '../../../vrf/rules';

import * as evaluation from './autoRouteEvaluation';
import { refrigerantChangeIssues } from './refrigerantChangeValidation';
import { getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';

interface Point3 { x: number; y: number; z: number }
const verified = (value: number): RuleValue<number> => ({ value, verified: true, source: 'manufacturer-model', sourceReference: 'test' });

function fixture(prefix = 'local', length = 4000, offsetY = 0): HvacElement[] {
  const unit = (id: string, outdoor: boolean, x: number): HvacElement => ({
    id, type: outdoor ? 'outdoor-unit' : 'ceiling-cassette-ac', category: outdoor ? 'outdoor-unit' : 'indoor-unit',
    label: id, position: { x, y: offsetY }, rotation: 0, width: 600, depth: 600, height: 300,
    elevation: 2400, mountType: 'ceiling', supplyZoneRatio: 0.5, properties: {},
  });
  const outdoor = unit(`${prefix}-outdoor`, true, 0);
  const indoor = unit(`${prefix}-indoor`, false, length);
  const equipment = [outdoor, indoor];
  const initial = getRefrigerantPipeBundleSnapTargets(equipment);
  indoor.elevation += initial.find(port => port.sourceElementId === outdoor.id)!.gasElevationMm!
    - initial.find(port => port.sourceElementId === indoor.id)!.gasElevationMm!;
  const ports = getRefrigerantPipeBundleSnapTargets(equipment);
  const a = ports.find(port => port.sourceElementId === outdoor.id)!;
  const b = ports.find(port => port.sourceElementId === indoor.id)!;
  const pipes = (['gas', 'liquid'] as const).map(line => {
    const start = { ...a[line === 'gas' ? 'gasPoint' : 'liquidPoint']!, z: a[line === 'gas' ? 'gasElevationMm' : 'liquidElevationMm']! };
    const end = { ...b[line === 'gas' ? 'gasPoint' : 'liquidPoint']!, z: b[line === 'gas' ? 'gasElevationMm' : 'liquidElevationMm']! };
    const connection = (elementId: string, point: Point3) => ({ connectionKind: 'unit-port', sourceElementId: elementId,
      portPoint: { x: point.x, y: point.y }, elevationMm: point.z, direction: { x: 1, y: 0 } });
    return {
      id: `${prefix}-${line}`, label: `${prefix}-${line}`, type: 'refrigerant-pipe', position: { x: start.x, y: start.y }, rotation: 0,
      width: length, depth: 30, height: 30, elevation: start.z - 15, mountType: 'ceiling', supplyZoneRatio: 0.5,
      properties: { lineKind: line, pipeDiameterMm: line === 'gas' ? 15.88 : 9.52, insulationThicknessMm: 25,
        routePoints: [start, end].map(({ x, y }) => ({ x, y })), routeNodes3d: [start, end], bendRadiusFactor: 4,
        startConnection: connection(outdoor.id, start), endConnection: connection(indoor.id, end) },
    } satisfies HvacElement;
  });
  const scene = [...equipment, ...pipes];
  // Pin the fixture to the adapter's actual equipment sockets, including its
  // equipment geometry transforms, so no tiny synthetic end riser remains.
  const document = buildVrfDocumentFromHvacElements(scene);
  return scene.map(element => {
    const run = document.pipeRuns[element.id];
    if (!run) return element;
    const nodes = [document.routeNodes[run.nodeIds[0]!]!.position, document.routeNodes[run.nodeIds.at(-1)!]!.position];
    return { ...element, properties: { ...element.properties, routeNodes3d: nodes } };
  });
}

function hop(scene: HvacElement[], heightMm = 400, prefix = 'local', bendRadiusFactor = 4): HvacElement[] {
  return scene.map(element => {
    if (element.id !== `${prefix}-gas`) return element;
    const previous = element.properties.routeNodes3d as Point3[];
    const a = previous[0]!; const b = previous.at(-1)!;
    const at = (t: number, rise = 0) => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), z: a.z + t * (b.z - a.z) + rise });
    const nodes = [a, at(0.25), at(0.35, heightMm), at(0.65, heightMm), at(0.75), b];
    return { ...element, properties: { ...element.properties, routeNodes3d: nodes, bendRadiusFactor } };
  });
}

function profile(): ManufacturerRuleProfile {
  return { ...PROJECT_FALLBACK_RULE_PROFILE, id: 'verified-test', verified: true, routeLimits: {},
    portDefaults: { ...PROJECT_FALLBACK_RULE_PROFILE.portDefaults }, pipeSizing: [], branchKits: [] };
}

afterEach(() => vi.restoreAllMocks());

describe('refrigerant command engineering revalidation', () => {
  it('finds manual circuits without ownership and rejects new verified length violations after a hop', () => {
    const before = fixture();
    const after = hop(before, 900);
    const selected = profile();
    const baseline = evaluation.evaluateAutoRouteNetwork({ elements: before, outdoorUnitId: 'local-outdoor', indoorUnitIds: ['local-indoor'] });
    expect(baseline.feasible, baseline.hardIssues.join('\n')).toBe(true);
    selected.routeLimits.maximumTotalLengthMm = verified(baseline.metrics.networkLengthMm + 100);
    const issues = refrigerantChangeIssues(before, after, ['local-gas'], { profile: selected });
    expect(issues.some(issue => issue.includes('local-outdoor') && issue.includes('one-way network length'))).toBe(true);
  });

  it('rejects a newly introduced gas low pocket even with a preliminary profile', () => {
    const before = fixture();
    const issues = refrigerantChangeIssues(before, hop(before, -400), new Set(['local-gas']));
    expect(issues.some(issue => issue.includes('low pocket'))).toBe(true);
  });

  it('checks the actual new bend radius against verified minima', () => {
    const before = fixture();
    const selected = profile();
    selected.portDefaults.minimumBendRadiusMm = verified(150);
    const prior = evaluation.evaluateAutoRouteNetwork({ elements: before, outdoorUnitId: 'local-outdoor', indoorUnitIds: ['local-indoor'], profile: selected });
    expect(prior.hardIssues).toEqual([]);
    const issues = refrigerantChangeIssues(before, hop(before, 400, 'local', 1), ['local-gas'], { profile: selected });
    expect(issues.some(issue => issue.includes('measured bend radius')), issues.join('\n')).toBe(true);
  });

  it('keeps unknown manufacturer allowances advisory and leaves both scenes untouched', () => {
    const before = fixture();
    const after = hop(before);
    const saved = JSON.stringify([before, after]);
    expect(refrigerantChangeIssues(before, after, ['local-gas'])).toEqual([]);
    expect(evaluation.evaluateAutoRouteNetwork({ elements: after, outdoorUnitId: 'local-outdoor', indoorUnitIds: ['local-indoor'] })
      .manufacturerQualification).toBe('preliminary');
    expect(JSON.stringify([before, after])).toBe(saved);
  });

  it('does not evaluate unrelated circuits with old violations', () => {
    const before = [...fixture(), ...fixture('unrelated', 20000, 5000)];
    const selected = profile();
    selected.routeLimits.maximumTotalLengthMm = verified(10000);
    const spy = vi.spyOn(evaluation, 'evaluateAutoRouteNetwork');
    expect(refrigerantChangeIssues(before, hop(before), ['local-gas'], { profile: selected })).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map(([options]) => options.outdoorUnitId)).toEqual(['local-outdoor', 'local-outdoor']);
    expect(spy.mock.calls.every(([options]) => options.indoorUnitIds.join() === 'local-indoor')).toBe(true);
  });

  it('does not treat existing issues in the affected circuit as newly introduced', () => {
    const before = hop(fixture(), -300);
    const after = before.map(element => element.id === 'local-gas' ? { ...element, label: 'Retained reviewed pipe' } : element);
    expect(evaluation.evaluateAutoRouteNetwork({ elements: before, outdoorUnitId: 'local-outdoor', indoorUnitIds: ['local-indoor'] })
      .hardIssues.some(issue => issue.includes('low pocket'))).toBe(true);
    expect(refrigerantChangeIssues(before, after, ['local-gas'])).toEqual([]);
  });

  it('keeps the before scope when a changed pipe loses its equipment connection', () => {
    const before = fixture();
    const after = before.map(element => element.id === 'local-gas' ? {
      ...element, properties: { ...element.properties, endConnection: undefined },
    } : element);
    const issues = refrigerantChangeIssues(before, after, ['local-gas']);
    expect(issues.some(issue => issue.includes('local-indoor') && issue.includes('disconnected'))).toBe(true);
  });

  it('avoids circuit evaluation when only an unrelated service changes', () => {
    const before = fixture();
    const spy = vi.spyOn(evaluation, 'evaluateAutoRouteNetwork');
    expect(refrigerantChangeIssues(before, before, ['unrelated-drain'])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
