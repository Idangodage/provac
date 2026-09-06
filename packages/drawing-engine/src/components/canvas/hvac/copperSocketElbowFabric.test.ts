import type * as fabric from 'fabric';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';
import { MM_TO_PX } from '../scale';

import { HvacPlanRenderer } from './HvacPlanRenderer';
import { copperSocketCupOutline } from './copperSocketElbowPlanGeometry';
import { compileCopperSocketElbowRoute } from './copperSocketElbowRoute';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipePairElement, buildRefrigerantPipeVisual } from './refrigerantPipePairModel';

function single(routePoints: Point2D[]): HvacElement {
  return { id: 'socket-preview', type: 'refrigerant-pipe', position: { x: 0, y: 0 }, width: 2000, depth: 2000,
    height: 40, elevation: 2400, rotation: 0, mountType: 'ceiling', label: 'Gas pipe', supplyZoneRatio: 0,
    properties: { routePoints, lineKind: 'gas', pipeDiameterMm: 12.7, outerDiameterMm: 40,
      segmentMaterials: routePoints.slice(1).map(() => 'flexible') } };
}
function preview(element: HvacElement): fabric.Object[] {
  const rendered: fabric.Group[] = [];
  const canvas = { add: (group: fabric.Group) => rendered.push(group), bringObjectToFront: vi.fn(),
    requestRenderAll: vi.fn(), remove: vi.fn(), getZoom: () => 1 } as unknown as fabric.Canvas;
  new HvacPlanRenderer(canvas).renderElementPreview(element, true);
  return rendered[0]!.getObjects();
}
function named(objects: fabric.Object[], name: string): fabric.Object[] {
  return objects.filter(object => (object as fabric.Object & { name?: string }).name === name);
}
const scaled = (point: Point2D): Point2D => ({ x: point.x * MM_TO_PX, y: point.y * MM_TO_PX });
function equalPoints(a: Point2D[], b: Point2D[]): boolean {
  return a.length === b.length && a.every((point, index) => Math.hypot(point.x - b[index]!.x, point.y - b[index]!.y) < 1e-6);
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('Fabric copper socket elbow placement previews', () => {
  it.each([45, 90])('shows the actual %i-degree cups and trims insulation to their mouths', angle => {
    const radians = angle * Math.PI / 180;
    const pipe = single([{ x: 0, y: 0 }, { x: 700, y: 0 },
      { x: 700 + Math.cos(radians) * 900, y: Math.sin(radians) * 900 }]);
    const snapshot = structuredClone(pipe);
    const visual = buildRefrigerantPipeVisual(pipe);
    const expected = compileCopperSocketElbowRoute(visual.localContinuousOuterPoints.map(point => ({ ...point, z: 0 })), 12.7);
    const objects = preview(pipe);
    expect(named(objects, 'hvac-copper-elbow-body')).toHaveLength(1);
    const cups = named(objects, 'hvac-copper-elbow-cup') as fabric.Polygon[];
    expect(cups).toHaveLength(2);
    const fitting = expected.fittings[0]!;
    for (const [face, stop, direction] of [[fitting.startFace, fitting.startStop, fitting.startDirection],
      [fitting.endFace, fitting.endStop, fitting.endDirection]] as const) {
      const polygon = copperSocketCupOutline(face, stop, direction, fitting.spec.socketOutsideDiameterMm / 2).map(scaled);
      expect(cups.some(cup => equalPoints(cup.points, polygon))).toBe(true);
    }
    const insulation = named(objects, 'hvac-socket-pipe-insulation') as fabric.Polyline[];
    expect(insulation).toHaveLength(expected.insulationRuns.length);
    expected.insulationRuns.forEach(run => expect(insulation.some(polyline => equalPoints(polyline.points, run.map(scaled)))).toBe(true));
    const copper = named(objects, 'hvac-socket-pipe-copper') as fabric.Polyline[];
    expected.pipeRuns.forEach(run => expect(copper.some(polyline => equalPoints(polyline.points, run.map(scaled)))).toBe(true));
    expect(pipe).toEqual(snapshot);
  });

  it('shows both service fittings once for a paired pipe', () => {
    const built = buildRefrigerantPipePairElement([{ x: 0, y: 0 }, { x: 1400, y: 0 }, { x: 1400, y: 1700 }],
      { gasPipeDiameterMm: 15.875, liquidPipeDiameterMm: 9.525, elevationMm: 2400, bendRadiusFactor: 1 });
    const pipe = { ...single([]), ...built, id: 'paired-socket-preview' } as HvacElement;
    const objects = preview(pipe);
    expect(named(objects, 'hvac-copper-elbow-body')).toHaveLength(2);
    expect(named(objects, 'hvac-copper-elbow-cup')).toHaveLength(4);
    expect(named(objects, 'hvac-socket-pipe-insulation')).toHaveLength(4);
  });

  it('switches to conservative covers without moving adjoining pipe runs', () => {
    const pipe = single([{ x: 0, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 900 }]);
    const copper = preview(pipe);
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, fittingDisplay: 'insulated' });
    const covered = preview(pipe);
    expect(named(covered, 'hvac-copper-elbow-body')).toHaveLength(0);
    expect(named(covered, 'hvac-copper-elbow-cover')).toHaveLength(1);
    expect(named(covered, 'hvac-socket-pipe-insulation').map(object => (object as fabric.Polyline).points))
      .toEqual(named(copper, 'hvac-socket-pipe-insulation').map(object => (object as fabric.Polyline).points));
  });

  it('respects formed-tube opt-out and a minimum radius that excludes the compact fitting', () => {
    const pipe = single([{ x: 0, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 900 }]);
    pipe.properties.fieldBendConstruction = 'formed-tube';
    expect(named(preview(pipe), 'hvac-copper-elbow-body')).toHaveLength(0);
    delete pipe.properties.fieldBendConstruction;
    pipe.properties.minimumFieldBendRadiusMm = 150;
    expect(named(preview(pipe), 'hvac-copper-elbow-body')).toHaveLength(0);
  });
});
