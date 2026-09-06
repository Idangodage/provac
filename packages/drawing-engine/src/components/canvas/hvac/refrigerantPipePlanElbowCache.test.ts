import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import * as elbowCompiler from './copperSocketElbowRoute';
import {
  DEFAULT_PIPE_ROUTING_SETTINGS,
  getActivePipeRoutingSettings,
  setActivePipeRoutingSettings,
} from './pipeRoutingSettings';
import { buildRefrigerantPipePhysicalPath, buildRefrigerantPipeVisual } from './refrigerantPipePairModel';

function fixture(offset: number, overrides: Record<string, unknown> = {}): HvacElement {
  const route = [{ x: offset, y: 0 }, { x: offset + 800, y: 0 }, { x: offset + 800, y: 800 }];
  return { id: `elbow-cache-${offset}`, type: 'refrigerant-pipe', rotation: 0,
    position: { x: offset, y: 0 }, width: 800, depth: 800, height: 70, elevation: 2400,
    mountType: 'ceiling', label: 'Gas pipe', supplyZoneRatio: 0,
    properties: { routePoints: route, authoredCenterlineRoute: route, pipeDiameterMm: 12.7,
      outerDiameterMm: 70, lineKind: 'gas', segmentMaterials: ['hard', 'flexible'], ...overrides } };
}

function addPort(element: HvacElement, end: 'start' | 'end'): void {
  const route = element.properties.routePoints as Point2D[];
  element.properties[`${end}Connection`] = { connectionKind: 'unit-port',
    portPoint: end === 'start' ? route[0] : route.at(-1),
    direction: end === 'start' ? { x: 1, y: 0 } : { x: 0, y: -1 }, elevationMm: 2400 };
}

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));
afterEach(() => { vi.restoreAllMocks(); setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS); });

describe('private plan socket elbow memoization', () => {
  it('reuses exact compiler inputs across public visual and physical paths without changing geometry', () => {
    const element = fixture(10_000);
    const source = element.properties.routePoints as Point2D[];
    const expected = elbowCompiler.compileCopperSocketElbowRoute(source.map(point => ({ ...point, z: 0 })), 12.7);
    expect(expected.fittings).toHaveLength(1);
    const compile = vi.spyOn(elbowCompiler, 'compileCopperSocketElbowRoute');
    const visual = buildRefrigerantPipeVisual(element);
    const repeated = buildRefrigerantPipeVisual(structuredClone(element));
    const physical = buildRefrigerantPipePhysicalPath(structuredClone(element));
    expect(compile).toHaveBeenCalledTimes(1);
    expect(repeated).toEqual(visual);
    expect(physical.outerPoints).toEqual(expected.centerline.map(({ x, y }) => ({ x, y })));
    expect(physical.outerPoints).not.toBe(visual.outerPoints);
    expect(physical.outerPoints[1]).not.toBe(visual.outerPoints[1]);
  });

  it('keeps cache storage private when callers mutate returned arrays and point objects', () => {
    const element = fixture(20_000);
    const compile = vi.spyOn(elbowCompiler, 'compileCopperSocketElbowRoute');
    const visual = buildRefrigerantPipeVisual(element);
    const expected = structuredClone(visual);
    visual.outerPoints[1]!.x += 123;
    visual.outerPoints.splice(2, 1);
    visual.segmentVisuals[0]!.points[0]!.y += 123;
    const repeated = buildRefrigerantPipeVisual(element);
    expect(repeated).toEqual(expected);
    repeated.outerPoints[1]!.y += 456;
    expect(buildRefrigerantPipeVisual(element)).toEqual(expected);
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('invalidates every coordinate and diameter change without rounding small edits', () => {
    const element = fixture(30_000);
    const compile = vi.spyOn(elbowCompiler, 'compileCopperSocketElbowRoute');
    buildRefrigerantPipePhysicalPath(element);
    const route = element.properties.routePoints as Point2D[];
    route[1]!.x += 1e-8;
    buildRefrigerantPipePhysicalPath(element);
    route[2]!.y += 1e-8;
    buildRefrigerantPipePhysicalPath(element);
    element.properties.pipeDiameterMm = 15.875;
    buildRefrigerantPipePhysicalPath(element);
    expect(compile).toHaveBeenCalledTimes(4);
    buildRefrigerantPipePhysicalPath(structuredClone(element));
    expect(compile).toHaveBeenCalledTimes(4);
  });

  it('resolves live and saved radius constraints on every call, with only effective values in the key', () => {
    const element = fixture(40_000);
    const compile = vi.spyOn(elbowCompiler, 'compileCopperSocketElbowRoute');
    buildRefrigerantPipePhysicalPath(element);
    element.properties.minimumBendRadiusMm = 150;
    const saved = buildRefrigerantPipePhysicalPath(element);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.lastCall?.[2]?.minimumBendRadiusMm).toBe(150);
    setActivePipeRoutingSettings({ minimumFieldBendRadiusMm: 100, defaultPipeGapMm: 100 });
    expect(buildRefrigerantPipePhysicalPath(element).outerPoints).toEqual(saved.outerPoints);
    expect(compile).toHaveBeenCalledTimes(2);
    setActivePipeRoutingSettings({ minimumFieldBendRadiusMm: 200 });
    buildRefrigerantPipePhysicalPath(element);
    expect(compile).toHaveBeenCalledTimes(3);
    expect(compile.mock.lastCall?.[2]?.minimumBendRadiusMm).toBe(200);
    element.properties.fieldBendConstruction = 'formed-tube';
    expect(buildRefrigerantPipePhysicalPath(element).outerPoints).toEqual(element.properties.routePoints);
    expect(compile).toHaveBeenCalledTimes(3);
  });

  it('keys start and end protected straights independently even when the authored coordinates are unchanged', () => {
    const element = fixture(50_000);
    const compile = vi.spyOn(elbowCompiler, 'compileCopperSocketElbowRoute');
    buildRefrigerantPipePhysicalPath(element);
    addPort(element, 'start');
    buildRefrigerantPipePhysicalPath(element);
    expect(compile.mock.lastCall?.[2]).toMatchObject({ startStraightMm: 200, endStraightMm: 0 });
    addPort(element, 'end');
    buildRefrigerantPipePhysicalPath(element);
    expect(compile.mock.lastCall?.[2]).toMatchObject({ startStraightMm: 200, endStraightMm: 200 });
    setActivePipeRoutingSettings({ minimumPortStubMm: 400 });
    buildRefrigerantPipePhysicalPath(element);
    expect(compile.mock.lastCall?.[2]).toMatchObject({ startStraightMm: 400, endStraightMm: 400 });
    expect(compile).toHaveBeenCalledTimes(4);
    expect(compile.mock.calls.every(call => JSON.stringify(call[0]) === JSON.stringify(compile.mock.calls[0]![0]))).toBe(true);
    buildRefrigerantPipePhysicalPath(element);
    expect(compile).toHaveBeenCalledTimes(4);
  });

  it('preserves authored span ownership on cache hits when no socket fitting is present', () => {
    // Retraced spans tie geometrically. Reassigning ownership because the cache
    // cloned an unfitted route would incorrectly make both spans belong to 0.
    const route = [{ x: 60_000, y: 0 }, { x: 60_800, y: 0 }, { x: 60_000, y: 0 }];
    const element = fixture(60_000, { routePoints: route, authoredCenterlineRoute: route });
    const compile = vi.spyOn(elbowCompiler, 'compileCopperSocketElbowRoute');
    const first = buildRefrigerantPipeVisual(element);
    const second = buildRefrigerantPipeVisual(structuredClone(element));
    expect(compile).toHaveBeenCalledTimes(1);
    expect(first.outerPoints).toEqual(route);
    expect(second).toEqual(first);
    expect(second.segmentVisuals.map(segment => [segment.index, segment.material])).toEqual([[0, 'hard'], [1, 'flexible']]);
    second.outerPoints[1]!.x += 100;
    expect(buildRefrigerantPipeVisual(element)).toEqual(first);
  });

  it('bypasses caching nonfinite effective inputs rather than aliasing them as JSON null', () => {
    const element = fixture(70_000);
    addPort(element, 'start');
    const compile = vi.spyOn(elbowCompiler, 'compileCopperSocketElbowRoute');
    for (const invalid of [NaN, Infinity, -Infinity]) {
      // The public setter normally sanitizes malformed saved settings. Mutate
      // the active object to exercise the helper's independent cache boundary.
      getActivePipeRoutingSettings().minimumPortStubMm = invalid;
      buildRefrigerantPipePhysicalPath(element);
      buildRefrigerantPipePhysicalPath(element);
    }
    expect(compile).toHaveBeenCalledTimes(6);
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
    buildRefrigerantPipePhysicalPath(element);
    buildRefrigerantPipePhysicalPath(element);
    expect(compile).toHaveBeenCalledTimes(7);
  });

  it('refreshes recently used entries and evicts the oldest route at the entry budget', () => {
    const compile = vi.spyOn(elbowCompiler, 'compileCopperSocketElbowRoute');
    const anchor = fixture(100_000);
    buildRefrigerantPipePhysicalPath(anchor);
    for (let index = 1; index < 512; index += 1) buildRefrigerantPipePhysicalPath(fixture(100_000 + index * 1000));
    expect(compile).toHaveBeenCalledTimes(512);
    buildRefrigerantPipePhysicalPath(anchor);
    expect(compile).toHaveBeenCalledTimes(512);
    buildRefrigerantPipePhysicalPath(fixture(700_000));
    buildRefrigerantPipePhysicalPath(anchor);
    expect(compile).toHaveBeenCalledTimes(513);
    buildRefrigerantPipePhysicalPath(fixture(101_000));
    expect(compile).toHaveBeenCalledTimes(514);
  });
});
