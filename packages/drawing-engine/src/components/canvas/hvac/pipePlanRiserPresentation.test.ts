import type * as fabric from 'fabric';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { HvacPlanRenderer } from './HvacPlanRenderer';
import { copperSocketCupOutline } from './copperSocketElbowPlanGeometry';
import { buildPipePlanTubes } from './pipePlanPresentation';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipePairElement } from './refrigerantPipePairModel';

function cornerRiser(reverse = false): HvacElement {
  const routePoints = [{ x: 100, y: 100 }, { x: 800, y: 100 }, { x: 800, y: 1100 }];
  const routeNodes3d = [{ x: 100, y: 100, z: 2300 }, { x: 800, y: 100, z: 2300 },
    { x: 800, y: 100, z: 2600 }, { x: 800, y: 1100, z: 2600 }];
  return { id: 'corner-riser-plan', type: 'refrigerant-pipe', position: { x: 100, y: 100 },
    width: 700, depth: 1000, height: 40, elevation: 2280, rotation: 0, mountType: 'ceiling',
    label: 'Gas pipe', supplyZoneRatio: 0,
    properties: { routePoints: reverse ? [...routePoints].reverse() : routePoints,
      routeNodes3d: reverse ? [...routeNodes3d].reverse() : routeNodes3d,
      lineKind: 'gas', pipeDiameterMm: 12.7, outerDiameterMm: 40,
      segmentMaterials: ['flexible', 'flexible'] } };
}

function preview(element: HvacElement, inExistingScene = false): fabric.Object[] {
  const rendered: fabric.Group[] = [];
  const canvas = { add: (group: fabric.Group) => rendered.push(group), bringObjectToFront: vi.fn(),
    requestRenderAll: vi.fn(), remove: vi.fn(), getZoom: () => 1 } as unknown as fabric.Canvas;
  const renderer = new HvacPlanRenderer(canvas);
  if (inExistingScene) renderer.renderAll([element]);
  renderer.renderElementPreview(element, true);
  return rendered[0]!.getObjects();
}
function named(objects: fabric.Object[], name: string): fabric.Object[] {
  return objects.filter(object => (object as fabric.Object & { name?: string }).name === name);
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('plan projection of a corner riser', () => {
  it.each([false, true])('shows the two real vertical-plane elbows without an extra plan elbow (reverse %s)', reverse => {
    const pipe = cornerRiser(reverse);
    const snapshot = structuredClone(pipe);
    const tube = buildPipePlanTubes(pipe)[0]!;
    expect(tube.fittings).toHaveLength(2);
    for (const fitting of tube.fittings!) {
      expect(fitting.spec.angleDeg).toBe(90);
      expect(fitting.corner.x).toBeCloseTo(800, 6);
      expect(fitting.corner.y).toBeCloseTo(100, 6);
      expect(Math.abs(fitting.normal.z)).toBeLessThan(1e-6);
    }
    expect(tube.fittings!.map(fitting => fitting.corner.z).sort()).toEqual([2300, 2600]);
    const endpoints = pipe.properties.routePoints as Point2D[];
    expect(tube.points[0]).toMatchObject(endpoints[0]!);
    expect(tube.points.at(-1)).toMatchObject(endpoints.at(-1)!);
    expect(pipe).toEqual(snapshot);
  });

  it('projects the same two fittings in Fabric placement previews', () => {
    const pipe = cornerRiser();
    const objects = preview(pipe);
    expect(named(objects, 'hvac-copper-elbow-body')).toHaveLength(2);
    const cups = named(objects, 'hvac-copper-elbow-cup') as fabric.Polygon[];
    expect(cups).toHaveLength(4);
    expect(cups.filter(cup => cup.points.length === 24)).toHaveLength(2);
    // Only the two horizontal socket mouths project to straight end lines.
    expect(named(objects, 'hvac-copper-elbow-mouth')).toHaveLength(2);
  });

  it.each([false, true])('projects an automatic terminal level adapter using the same two-elbow corner (existing scene %s)', inExistingScene => {
    const pipe = cornerRiser();
    delete pipe.properties.routeNodes3d;
    pipe.properties.startConnection = { connectionKind: 'field-pipe', portPoint: { x: 100, y: 100 },
      direction: { x: 1, y: 0 }, elevationMm: 2300 };
    pipe.properties.endConnection = { connectionKind: 'unit-port', portPoint: { x: 800, y: 1100 },
      direction: { x: 0, y: -1 }, elevationMm: 2600 };
    const tube = buildPipePlanTubes(pipe)[0]!;
    expect(tube.fittings).toHaveLength(2);
    expect(tube.fittings!.every(fitting => Math.abs(fitting.normal.z) < 1e-6)).toBe(true);
    expect(named(preview(pipe, inExistingScene), 'hvac-copper-elbow-body')).toHaveLength(2);
  });

  it('preserves both gas and liquid riser fittings in the paired presentation', () => {
    const single = cornerRiser();
    const built = buildRefrigerantPipePairElement(single.properties.routePoints as Point2D[], {
      gasPipeDiameterMm: 15.875, liquidPipeDiameterMm: 9.525, elevationMm: 2300, bendRadiusFactor: 1,
    });
    const pair = { ...single, ...built, id: 'paired-corner-riser',
      properties: { ...built.properties, routeNodes3d: single.properties.routeNodes3d } } as HvacElement;
    const tubes = buildPipePlanTubes(pair);
    expect(tubes).toHaveLength(2);
    for (const tube of tubes) {
      expect(tube.fittings).toHaveLength(2);
      expect(tube.fittings!.every(fitting => Math.abs(fitting.normal.z) < 1e-6)).toBe(true);
    }
    expect(named(preview(pair), 'hvac-copper-elbow-body')).toHaveLength(4);
  });

  it('draws a vertical socket at its actual projected outside diameter', () => {
    const outline = copperSocketCupOutline({ x: 150, y: 300 }, { x: 150, y: 300 }, { x: 0, y: 0 }, 7);
    expect(outline).toHaveLength(24);
    outline.forEach(point => expect(Math.hypot(point.x - 150, point.y - 300)).toBeCloseTo(7, 8));
    expect(Math.max(...outline.map(point => point.x)) - Math.min(...outline.map(point => point.x))).toBe(14);
    expect(Math.max(...outline.map(point => point.y)) - Math.min(...outline.map(point => point.y))).toBe(14);
  });
});
