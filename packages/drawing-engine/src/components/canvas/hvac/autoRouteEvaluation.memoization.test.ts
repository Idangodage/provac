import { describe, expect, it } from 'vitest';

import type { VrfPipingDocument } from '../../../vrf/domain/types';
import { buildVrfGeometrySnapshot, buildVrfValidationSnapshot } from '../../../vrf/rules/document-validation-adapter';

import baselineData from './__fixtures__/auto-route-evaluation-baseline.json';
import { evaluateAutoRouteDocument, type AutoRouteEvaluation, type AutoRouteEvaluationOptions } from './autoRouteEvaluation';

interface Baseline {
  name: string;
  document: VrfPipingDocument;
  options: Omit<AutoRouteEvaluationOptions, 'elements'>;
  expected: AutoRouteEvaluation;
}

// Captured from the evaluator before measurement memoization. Shared trunk
// bends, both services, three objectives and verified failures preserve exact
// numeric results and the order of every issue, path and recommendation.
const baselines = baselineData as Baseline[];

describe('automatic route measurement equivalence', () => {
  it.each(baselines)('returns the exact pre-optimization evaluation for $name', (baseline) => {
    const document = structuredClone(baseline.document);
    const before = structuredClone(document);
    const result = evaluateAutoRouteDocument(document, baseline.options);
    expect(JSON.parse(JSON.stringify(result))).toEqual(baseline.expected);
    expect(document).toEqual(before);
  });

  it.each(baselines)('shares the full rule snapshot geometry for $name', (baseline) => {
    const document = structuredClone(baseline.document);
    const full = buildVrfValidationSnapshot(document, baseline.options.profile);
    const focused = buildVrfGeometrySnapshot(document, baseline.options.profile);
    expect(focused).toEqual({
      runs: full.runs.map(({ id, startPort, endPort, startPortStubMm, endPortStubMm }) =>
        ({ id, startPort, endPort, startPortStubMm, endPortStubMm })),
      branches: full.branches.map(({ id, model, frame, upstreamStraightMm, downstreamStraightMm }) =>
        ({ id, model, frame, upstreamStraightMm, downstreamStraightMm })),
    });
  });

  it('remeasures an in-place document edit on the next evaluation', () => {
    const baseline = baselines[0]!;
    const document = structuredClone(baseline.document);
    const before = evaluateAutoRouteDocument(document, baseline.options);
    document.routeNodes['gas:root']!.position.x -= 333;
    const after = evaluateAutoRouteDocument(document, baseline.options);
    expect(after.metrics.gasLengthMm).toBeGreaterThan(before.metrics.gasLengthMm);
    expect(after.score).not.toBe(before.score);
    document.routeNodes['gas:root']!.position.x += 333;
    expect(evaluateAutoRouteDocument(document, baseline.options)).toEqual(before);
  });
});
