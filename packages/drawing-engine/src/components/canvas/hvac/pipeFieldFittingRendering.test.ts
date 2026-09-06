import * as fabric from 'fabric';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HvacElement } from '../../../types';
import { MM_TO_PX } from '../scale';

import { HvacPlanRenderer } from './HvacPlanRenderer';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import {
  buildRefrigerantPipeElement, buildRefrigerantPipePairElement, buildRefrigerantPipeVisual,
  type RefrigerantPipeBundleConnection,
} from './refrigerantPipePairModel';
import { buildHvacElementMesh } from './three3d/buildHvacElementMesh';

function materialize(element: Partial<HvacElement>): HvacElement {
  return { id: 'fitting-render-test', rotation: 0, supplyZoneRatio: 0, properties: {}, ...element } as HvacElement;
}
function vertices(element: HvacElement): { line: string; points: number[]; start: number[]; end: number[] }[] {
  const group = buildHvacElementMesh(element, { allElements: [element] })!;
  const result: { line: string; points: number[]; start: number[]; end: number[] }[] = [];
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.pipeSurfaceRole !== 'insulation') return;
    result.push({ line: object.userData.pipeLineKind, points: Array.from(object.geometry.getAttribute('position').array),
      start: object.userData.pipeRouteEndpoints.start, end: object.userData.pipeRouteEndpoints.end });
    object.geometry.dispose();
  });
  return result;
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('field fitting presentation consistency', () => {
  it('draws the production connection-aware plan points without fitting a second display curve', () => {
    const element = materialize(buildRefrigerantPipeElement([
      { x: 0, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 900 }, { x: 1800, y: 900 },
    ], { lineKind: 'gas', pipeDiameterMm: 15.88, outerDiameterMm: 40, segmentMaterialMode: 'flexible' }));
    element.properties.fieldBendConstruction = 'formed-tube';
    const visual = buildRefrigerantPipeVisual(element);
    const rendered: fabric.Group[] = [];
    const canvas = { add: (group: fabric.Group) => rendered.push(group), bringObjectToFront: vi.fn(),
      requestRenderAll: vi.fn(), remove: vi.fn(), getZoom: () => 1 } as unknown as fabric.Canvas;
    new HvacPlanRenderer(canvas).renderElementPreview(element, true);
    const polylines = rendered[0]!.getObjects().filter((object): object is fabric.Polyline => object instanceof fabric.Polyline);
    expect(polylines.length).toBeGreaterThan(0);
    for (const segment of visual.segmentVisuals) {
      const expected = segment.localPoints.map(point => ({ x: point.x * MM_TO_PX, y: point.y * MM_TO_PX }));
      expect(polylines.some(polyline => JSON.stringify(polyline.points) === JSON.stringify(expected))).toBe(true);
    }
  });

  it.each(['single', 'pair'] as const)('keeps the saved %s socket transition unchanged when the document bend default changes', kind => {
    const start: RefrigerantPipeBundleConnection = {
      point: { x: 0, y: 0 }, gasPoint: { x: 0, y: -20 }, liquidPoint: { x: 0, y: 20 },
      gasFieldPoint: { x: 0, y: -20 }, liquidFieldPoint: { x: 0, y: 20 }, direction: { x: 1, y: 0 },
      elevationMm: 1800, gasElevationMm: 1800, liquidElevationMm: 1800, connectionKind: 'unit-port',
    };
    const route = [{ x: 0, y: 0 }, { x: 3000, y: 0 }];
    const built = kind === 'pair'
      ? buildRefrigerantPipePairElement(route, { startBundleConnection: start, bendRadiusFactor: 4, elevationMm: 2400 })
      : buildRefrigerantPipeElement(route, { lineKind: 'gas', pipeDiameterMm: 15.88, outerDiameterMm: 40, elevationMm: 2400,
        startConnection: { portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 1800, connectionKind: 'unit-port' } });
    const saved = materialize({ ...built, properties: { ...built.properties, bendRadiusFactor: 4, fieldBendConstruction: 'formed-tube',
      routeNodes3d: [{ x: 0, y: 0, z: 2400 }, { x: 3000, y: 0, z: 2400 }] } });
    const snapshot = structuredClone(saved);
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 1 });
    const first = vertices(saved);
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 6 });
    const second = vertices(saved);
    expect(second).toEqual(first);
    expect(first).toHaveLength(kind === 'pair' ? 2 : 1);
    for (const pipe of first) {
      expect(pipe.start[2]).toBe(1800);
      expect(pipe.points.every(Number.isFinite)).toBe(true);
    }
    expect(saved).toEqual(snapshot);
  });

  it.each(['gas', 'liquid'] as const)('keeps the manufactured %s kit and its sockets independent of field-pipe bend settings', lineKind => {
    const kit = materialize({ type: 'refrigerant-branch-kit', position: { x: 300, y: 500 }, width: 450, depth: 250,
      height: 100, elevation: 2400, properties: { branchKitLineKind: lineKind } });
    const surfaces = (element: HvacElement) => {
      const result: { name: string; role: string; positions: number[] }[] = [];
      buildHvacElementMesh(element, { allElements: [element] })!.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        result.push({ name: object.name, role: object.userData.pipeSurfaceRole,
          positions: Array.from(object.geometry.getAttribute('position').array) });
        object.geometry.dispose();
      });
      return result;
    };
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 1 });
    const first = surfaces(kit);
    expect(first.filter(surface => surface.role === 'fitting')).toHaveLength(1);
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, bendRadiusFactor: 6 });
    expect(surfaces({ ...kit, properties: { ...kit.properties, bendRadiusFactor: 4 } })).toEqual(first);
  });
});
