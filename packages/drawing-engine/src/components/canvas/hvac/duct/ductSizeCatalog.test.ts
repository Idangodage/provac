/**
 * The size series designs are made of: metric (the fabricator's step and the
 * stocked round list, as set) or inch (2 in rectangular steps, the inch round
 * list). Sizes in the inch series land exactly on it (no running-sum drift).
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuct } from './ductAutoLayout';
import { legNormal } from './ductBranches';
import { rectangularEquivalents, widthForEquivalent } from './ductSectionEquivalents';
import { resolveDuctSettings } from './ductSettings';
import {
  IMPERIAL_RECT_STEP_MM,
  IMPERIAL_ROUND_SIZES_IN,
  ductRectStepMm,
  ductRoundSizesMm,
  isOnStep,
  nearestStep,
  onStep,
  stepAtOrAbove,
} from './ductSizeCatalog';
import { sizeRectangular, sizingLimits } from './ductSizing';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, type DuctLeg } from './ductTypes';

const metric = resolveDuctSettings({ soffitMm: 3000 });
const imperial = resolveDuctSettings({ soffitMm: 3000, sizeSeries: 'imperial' });
const INCH = 25.4;
const inchRound = new Set(IMPERIAL_ROUND_SIZES_IN.map((inches) => onStep(inches, INCH)));
const onInchSeries = (leg: DuctLeg) => (leg.diameterMm !== undefined
  ? inchRound.has(leg.diameterMm)
  : isOnStep(leg.widthMm, IMPERIAL_RECT_STEP_MM) && isOnStep(leg.heightMm, IMPERIAL_RECT_STEP_MM));

describe('the size catalogue', () => {
  it('keeps the metric step and stock list as set; the inch series is 2 in and the inch round list', () => {
    expect(metric.sizeSeries).toBe('metric');
    expect(resolveDuctSettings({ sizeSeries: 'nonsense' as never }).sizeSeries).toBe('metric');
    expect(ductRectStepMm(metric)).toBe(metric.rectStepMm);
    expect(ductRectStepMm(resolveDuctSettings({ rectStepMm: 25 }))).toBe(25);
    expect(ductRoundSizesMm(metric)).toEqual(metric.autoRoundSizesMm);
    expect(ductRectStepMm(imperial)).toBe(50.8);
    const round = ductRoundSizesMm(imperial);
    expect(round.slice(0, 4)).toEqual([101.6, 127, 152.4, 177.8]);
    expect(round.every((size) => Number.isInteger(Math.round(size / INCH * 1e6) / 1e6))).toBe(true);
  });

  it('steps land exactly on multiples of the step', () => {
    expect(onStep(3, 50.8)).toBe(152.4);
    expect(onStep(12, 50.8)).toBe(609.6);
    expect(stepAtOrAbove(152.4, 50.8)).toBe(152.4);
    expect(stepAtOrAbove(152.5, 50.8)).toBe(203.2);
    expect(stepAtOrAbove(250, 50)).toBe(250);
    expect(nearestStep(250, 50.8)).toBe(254);
    expect(isOnStep(609.6, 50.8)).toBe(true);
    expect(isOnStep(600, 50.8)).toBe(false);
    // Twenty steps by multiples, not a running sum (which drifts off 1016).
    expect(onStep(20, 50.8)).toBe(1016);
  });
});

describe('sizing on the inch series', () => {
  it('sizes rectangles on even inches, raising the height on the step', () => {
    const limits = sizingLimits(imperial, 'supply', 'trunk');
    for (const airflow of [300, 900, 2400, 6000]) {
      for (const height of [152.4, 254, 304.8]) {
        const sized = sizeRectangular(airflow, height, limits, { stepMm: IMPERIAL_RECT_STEP_MM, minWidthMm: height, maxAspect: 4, maxHeightMm: 609.6 });
        expect(onInchSeries(sized), `${airflow} m³/h at ${height}`).toBe(true);
      }
    }
  });

  it('gives round ⇄ rectangle equivalents on the series step', () => {
    for (const d of [203.2, 304.8, 406.4]) {
      const rects = rectangularEquivalents(d, { maxHeightMm: d, maxAspect: 4, stepMm: IMPERIAL_RECT_STEP_MM });
      expect(rects.length).toBeGreaterThan(0);
      expect(rects.every(onInchSeries)).toBe(true);
    }
    expect(widthForEquivalent(300, 200, IMPERIAL_RECT_STEP_MM)).toBe(406.4);
    // The metric step is unchanged.
    expect(rectangularEquivalents(300, { maxHeightMm: 300, maxAspect: 4 })).toEqual(rectangularEquivalents(300, { maxHeightMm: 300, maxAspect: 4, stepMm: 50 }));
  });

  it('auto-generates every duct on the series (the collar and the necks as the unit and terminals have them)', () => {
    const unit: HvacElement = {
      id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
      elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5,
      properties: { modelCode: 'FDUM22KXE6F-W', modelUrl: '/models/vrf/maco-vrf-fdum22kxe6f-w.glb' },
    };
    const port = resolveUnitAirPorts(unit).find((candidate) => candidate.kind === 'supply')!;
    const t = legNormal(port.normal);
    const at = (along: number, across: number): Point2D => ({
      x: port.lip.x + port.normal.x * along + t.x * across, y: port.lip.y + port.normal.y * along + t.y * across,
    });
    const terminal = (id: string, centre: Point2D, facing: Point2D): HvacElement => {
      const spec = typicalTerminalSpec('square-4way', 250);
      const envelope = terminalEnvelope(spec);
      return {
        id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 },
        rotation: (((Math.atan2(facing.x, -facing.y) * 180) / Math.PI) + 360) % 360,
        width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
        label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminal: spec },
      };
    };
    const scene = [unit,
      terminal('a1', at(1800, 1500), { x: -t.x, y: -t.y }),
      terminal('a2', at(1800, -1500), t),
      terminal('a3', at(3600, 1500), { x: -t.x, y: -t.y }),
      terminal('a4', at(3600, -1500), t)];
    const collar = (leg: DuctLeg) => Math.abs(leg.widthMm - port.widthMm) < 0.5 && Math.abs(leg.heightMm - port.heightMm) < 0.5;
    const neck = (leg: DuctLeg) => leg.diameterMm !== undefined && Math.abs(leg.diameterMm - 250) < 0.5;
    for (const shape of [undefined, 'rectangular'] as const) {
      const result = generateAutoDuct(scene, {
        unitId: 'fdum', terminalIds: ['a1', 'a2', 'a3', 'a4'], fanSpeed: 'hi', layout: 'trunk', airflowM3h: 2000,
        services: { supply: true, return: false }, rebuildExisting: false, shape,
      }, imperial);
      const legs = result.runs.flatMap((run) => readDuctRunSpec(run)!.legs);
      expect(legs.filter((leg) => onInchSeries(leg) && !collar(leg) && !neck(leg)).length, shape).toBeGreaterThan(0);
      expect(legs.filter((leg) => !onInchSeries(leg) && !collar(leg) && !neck(leg)), shape).toEqual([]);
    }
  });
});
