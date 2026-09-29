import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctFabricationSchedule, buildDuctBom, ductBomToCsv } from './ductBom';
import { buildDuctRunDraftElement, constrainDuctLeg, type DuctDraftInput } from './ductDraft';
import { planDuctRun, type DuctFabricationPlan } from './ductFabricationPlanner';
import { pickDuctAtWorldPoint } from './ductPick';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import { resolveDuctSettings } from './ductSettings';

const settings = resolveDuctSettings({});

const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
  properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
const ret = resolveUnitAirPorts(unit).find((port) => port.kind === 'return')!;

/** A run drawn from a port by leg offsets. */
function runFrom(port: typeof supply, legs: Point2D[], overrides: Partial<DuctDraftInput> = {}): HvacElement {
  const points: Point2D[] = [];
  let cursor: Point2D = { x: port.lip.x, y: port.lip.y };
  for (const leg of legs) {
    cursor = { x: cursor.x + leg.x, y: cursor.y + leg.y };
    points.push(cursor);
  }
  return buildDuctRunDraftElement({ port, points, ...overrides }, 'run');
}

function plan(element: HvacElement, overrideSettings = settings): DuctFabricationPlan {
  return planDuctRun(element, { settings: overrideSettings, scene: [unit, element] })!;
}

describe('duct run fabrication plan', () => {
  // Supply leaves the −Y collar: 3000 mm away from the unit, then 4000 mm to the right.
  const element = runFrom(supply, [{ x: 0, y: -3000 }, { x: 4000, y: 0 }]);
  const result = plan(element);

  it('starts exactly on the real collar, level with its centre (2D and height)', () => {
    const first = result.pieces[0]!;
    expect(first.kind).toBe('connector');
    expect(first.start.x).toBeCloseTo(supply.lip.x, 9);
    expect(first.start.y).toBeCloseTo(supply.lip.y, 9);
    expect(first.centreZ).toBeCloseTo(supply.lip.z, 9);
    expect(first.widthMm).toBe(674);
    expect(first.heightMm).toBe(164);
    expect(result.startPort?.source).toBe('measured');
    expect(result.issues.filter((issue) => issue.code === 'DU_MOUTH_APPROX')).toEqual([]);
    expect(result.pieces.some((piece) => piece.kind === 'transition')).toBe(false);
  });

  it('lays connector, stock sections, a radius elbow and an end cap', () => {
    // Connector 102 fabric + 2 × 76 metal (SMACNA Fig. 2-17); elbow R = 1.5 × 674 = 1011 (Fig. 2-2 RE1)
    // → setback 1011 + 50 neck. Leg 1: 3000 − 254 − 1061 = 1685; leg 2: 4000 − 1061 = 2939.
    expect(result.pieces.map((piece) => `${piece.kind}:${Math.round(piece.lengthMm)}`)).toEqual([
      'connector:254',
      'straight:1200', 'straight:485',
      `elbow:${Math.round((1011 * Math.PI) / 2 + 100)}`,
      'straight:1200', 'straight:1200', 'straight:539',
      'end-cap:0',
    ]);
    expect(result.pieces.map((piece) => piece.mark)).toEqual(['C-01', 'S-001', 'S-002', 'E-01', 'S-003', 'S-004', 'S-005', 'K-01']);
    expect(result.status).toBe('ok');
  });

  it('puts a joint between every pair of pieces, plus the slip-over at the collar', () => {
    expect(result.joints).toHaveLength(result.pieces.length);
    expect(result.joints[0]!.kind).toBe('unit-connection');
    expect(result.joints[0]!.hardware?.system).toBe('slip-over');
    expect(result.joints.at(-1)!.kind).toBe('end-cap');
    // 674 × 164 at 500 Pa, 1.2 m: D-0.55 → 0.60 stock, TDC.
    expect(result.constructionByLeg[0]!.sheetThicknessMm).toBe(0.6);
    expect(result.joints.slice(1).every((joint) => joint.hardware?.system === 'tdc')).toBe(true);
  });

  it('conserves the drawn length: sections + connector + elbow reserves = polyline', () => {
    const consumed = result.pieces.reduce((total, piece) => total + (piece.stationEndMm - piece.stationStartMm), 0);
    expect(consumed).toBeCloseTo(result.polylineLengthMm, 6);
  });

  it('shares a short remainder with the previous section', () => {
    // 2780 − 254 connector = 2526 = 2 × 1200 + 126; 126 < 200 → 1200, 663, 663.
    const shared = plan(runFrom(supply, [{ x: 0, y: -2780 }]));
    expect(shared.pieces.filter((piece) => piece.kind === 'straight').map((piece) => Math.round(piece.lengthMm))).toEqual([1200, 663, 663]);
  });

  it('switches to a square vaned elbow when a leg is too short for the radius (auto)', () => {
    const tight = plan(runFrom(supply, [{ x: 0, y: -3000 }, { x: 900, y: 0 }, { x: 0, y: -3000 }]));
    const elbows = tight.pieces.filter((piece) => piece.kind === 'elbow');
    expect(elbows.map((piece) => piece.elbow!.style)).toEqual(['square-vaned', 'square-vaned']);
    // SMACNA Fig. 2-3: 164 mm vanes → single-wall small (R51 @ 38 mm) on the 674·√2 = 953 mm diagonal runner.
    expect(elbows[0]!.elbow!.vanes!.spec.type).toBe('single-small');
    expect(elbows[0]!.elbow!.vaneCount).toBe(Math.ceil((674 * Math.SQRT2) / 38) - 1);
    expect(elbows[0]!.elbow!.vanes!.sections).toBe(1);
    expect(tight.issues.some((issue) => issue.code === 'DU_LEG_TOO_SHORT')).toBe(false);
  });

  it('refuses a run that doubles back on itself, with finite numbers (no elbow of R·tan 90°)', () => {
    const back = plan(runFrom(supply, [{ x: 0, y: -2000 }, { x: 0, y: 900 }]));
    expect(back.issues.map((issue) => issue.code)).toContain('DU_TURN_BACK');
    expect(back.pieces.every((piece) => Number.isFinite(piece.lengthMm) && piece.lengthMm < 10000)).toBe(true);
    expect(back.issues.every((issue) => !/e\+|\d{7,}/.test(issue.message))).toBe(true);
  });

  it('reports a leg that cannot hold its fittings', () => {
    // A 300 mm last leg after a 90° turn: even a square vaned elbow needs 337 + 50 mm of it.
    const tooShort = plan(runFrom(supply, [{ x: 0, y: -3000 }, { x: 300, y: 0 }]));
    expect(tooShort.issues.some((issue) => issue.code === 'DU_LEG_TOO_SHORT' && issue.severity === 'error')).toBe(true);
    expect(tooShort.status).toBe('error');
    // A 300 mm sideways Z between long legs is fine: it is made as an ogee offset (SMACNA Fig. 2-7).
    const jog = plan(runFrom(supply, [{ x: 0, y: -3000 }, { x: 300, y: 0 }, { x: 0, y: -3000 }]));
    expect(jog.status).toBe('ok');
    expect(jog.pieces.some((piece) => piece.kind === 'offset')).toBe(true);
  });

  it('a pressure class above 500 Pa is an explicit error state, never fabricated', () => {
    const high = plan(element, resolveDuctSettings({ supplyPressureClassPa: 750 }));
    expect(high.status).toBe('error');
    expect(high.issues.find((issue) => issue.code === 'DU_PRESSURE_UNSUPPORTED')?.message).toMatch(/750 Pa/);
    expect(high.joints.filter((joint) => joint.kind !== 'unit-connection').every((joint) => joint.hardware === null)).toBe(true);
    const bom = buildDuctBom([high]);
    expect(bom.filter((row) => row.category !== 'Issues')).toEqual([]);
    expect(bom[0]!.description).toMatch(/Not fabricated: .*750 Pa/);
  });

  it('return runs take the +Y collar and the return pressure class', () => {
    const back = plan(runFrom(ret, [{ x: 0, y: 2000 }]));
    expect(back.pieces[0]!.start.y).toBeCloseTo(ret.lip.y, 9);
    expect(back.pieces[0]!.widthMm).toBe(654);
    expect(back.pieces[0]!.heightMm).toBe(194);
    expect(back.constructionByLeg[0]!.pressureClassPa).toBe(250);
    expect(back.constructionByLeg[0]!.pressureMode).toBe('negative');
  });

  it('property: any orthogonal route conserves its length and orders its stations', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ turn: fc.constantFrom(-1, 0, 1), length: fc.integer({ min: 1600, max: 9000 }) }), { minLength: 1, maxLength: 6 }),
      (legs) => {
        let direction = { x: 0, y: -1 };
        const offsets = legs.map((leg, index) => {
          if (index > 0 && leg.turn !== 0) direction = leg.turn > 0 ? { x: -direction.y, y: direction.x } : { x: direction.y, y: -direction.x };
          return { x: direction.x * leg.length, y: direction.y * leg.length };
        });
        const result = plan(runFrom(supply, offsets));
        const consumed = result.pieces.reduce((total, piece) => total + (piece.stationEndMm - piece.stationStartMm), 0);
        expect(consumed).toBeCloseTo(result.polylineLengthMm, 4);
        result.pieces.forEach((piece, index) => {
          if (index > 0) expect(piece.stationStartMm).toBeCloseTo(result.pieces[index - 1]!.stationEndMm, 4);
        });
      },
    ), { numRuns: 60 });
  });
});

describe('BOM, schedule and presentation', () => {
  const element = runFrom(supply, [{ x: 0, y: -3000 }, { x: 4000, y: 0 }]);
  const result = plan(element);

  it('lists sheet by stock thickness, pieces and joint hardware', () => {
    const rows = buildDuctBom([result]);
    const sheet = rows.find((row) => row.category === 'Sheet metal' && row.unit === 'm²');
    expect(sheet?.size).toBe('0.60 mm (26 ga)');
    expect(sheet!.quantity).toBeGreaterThan(10);
    const corners = rows.find((row) => row.description === 'TDC flange: corner pieces');
    // 7 flanged joints (6 between the 7 duct pieces + the end cap) × 8 corners, 4 bolts each.
    expect(corners?.quantity).toBe(56);
    expect(rows.find((row) => row.description === 'Bolt M10×25')?.quantity).toBe(28);
    expect(ductBomToCsv(rows).split('\n')[0]).toBe('Category,Description,Size,Quantity,Unit,Basis');
    const schedule = buildDuctFabricationSchedule([result]);
    expect(schedule.map((row) => row.mark)).toEqual(result.pieces.map((piece) => piece.mark));
    expect(schedule[1]).toMatchObject({ size: '674×164', sheetMm: 0.6, gauge: '26 ga', requiredClass: 'D' });
  });

  it('draws outlines from the collar lip and tags the size and construction', () => {
    const presentation = buildDuctPlanPresentation(result);
    const connector = presentation.piecePolygons[0]!.polygon;
    const touchesLip = connector.filter((point) => Math.abs(point.y - supply.lip.y) < 1e-6);
    expect(touchesLip.map((point) => Math.round(point.x)).sort((a, b) => a - b))
      .toEqual([Math.round(supply.lip.x - 674 / 2 - 0.6), Math.round(supply.lip.x + 674 / 2 + 0.6)]);
    expect(presentation.tags.map((tag) => tag.text)).toEqual(['674×164 · GI 0.60 (26 ga) · TDC · BOD 2669']);
    expect(presentation.jointTicks).toHaveLength(result.joints.length);
  });

  it('picks the run on its pieces, not in the empty corner of its bounding box', () => {
    const scene = [unit, element];
    const onDuct = { x: supply.lip.x, y: supply.lip.y - 1500 };
    const emptyCorner = { x: supply.lip.x + 3000, y: supply.lip.y - 1000 };
    expect(pickDuctAtWorldPoint(onDuct, scene, settings, 5)?.id).toBe('run');
    expect(pickDuctAtWorldPoint(emptyCorner, scene, settings, 5)).toBeNull();
  });
});

describe('drawing constraints', () => {
  it('locks the first leg to the collar normal and snaps lengths', () => {
    const leg = constrainDuctLeg({ x: 0, y: 0 }, { x: 400, y: -1234 }, supply.normal, { first: true, mode: '90' });
    expect(leg.direction).toEqual({ x: 0, y: -1 });
    expect(leg.lengthMm).toBe(1230);
  });

  it('allows straight on or a right-angle turn, never back; 45° mode adds diagonals', () => {
    const turn = constrainDuctLeg({ x: 0, y: 0 }, { x: 900, y: -100 }, { x: 0, y: -1 }, { first: false, mode: '90' });
    expect(turn.direction.x).toBeCloseTo(1, 9);
    const back = constrainDuctLeg({ x: 0, y: 0 }, { x: 0, y: 500 }, { x: 0, y: -1 }, { first: false, mode: '90' });
    expect(back.lengthMm).toBe(0);
    const diagonal = constrainDuctLeg({ x: 0, y: 0 }, { x: 700, y: -700 }, { x: 0, y: -1 }, { first: false, mode: '45' });
    expect(diagonal.direction.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(diagonal.direction.y).toBeCloseTo(-Math.SQRT1_2, 6);
  });
});
