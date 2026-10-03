import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../../types';
import { resolveUnitAirPorts } from '../ductAirPorts';
import type { AutoDuctIssue, ServiceCtx } from '../ductAutoContext';
import { resolveDuctSettings } from '../ductSettings';

import { verifyRuns } from './ductOptimizer';

describe('optimizer verification issue counts', () => {
  it('includes inherited design errors and warnings in the candidate totals', () => {
    const unit: HvacElement = {
      id: 'unit', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0,
      width: 1084, depth: 697, height: 300, elevation: 2400, mountType: 'ceiling',
      label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
    };
    const port = resolveUnitAirPorts(unit).find((candidate) => candidate.kind === 'supply')!;
    const ctx: ServiceCtx = {
      service: 'supply', unitId: unit.id,
      frame: { origin: port.lip, n: port.normal, t: { x: -port.normal.y, y: port.normal.x } },
      port, bottomZ: 2400, terminals: [], airflowM3h: 360, baseScene: [unit],
      settings: resolveDuctSettings({}), obstacles: [], maxHeightMm: 500,
      construction: 'gi-bare', ids: () => 'run',
    };
    const notes: AutoDuctIssue[] = [
      { code: 'DU_AUTO_VOID', severity: 'error', service: 'supply', message: 'The trunk does not fit in the void.' },
      { code: 'DU_SIZE_CAPPED', severity: 'warning', service: 'supply', message: 'The section exceeds its velocity limit.' },
      { code: 'DU_SIZE_TAKEOFF', severity: 'info', service: 'supply', message: 'The take-off style was adjusted.' },
    ];
    const result = verifyRuns(ctx, [], notes);
    expect(result.issues).toEqual(notes);
    expect(result.errors).toBe(1);
    expect(result.warnings).toBe(1);
    expect(notes).toHaveLength(3);
  });
});
