import * as fabric from 'fabric';
import { Mesh, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../types';
import { MM_TO_PX } from '../scale';

import { HvacPlanRenderer } from './HvacPlanRenderer';
import { resolveUnitAirPorts } from './duct/ductAirPorts';
import { buildHvacElementMesh } from './three3d/buildHvacElementMesh';
import { unitConnectionsFor } from './unitConnections';

// Font measurement needs a browser canvas. Keep actual Fabric objects, group
// layout and transforms, with deterministic text extents for these geometry tests.
beforeEach(() => {
  vi.spyOn(fabric.FabricText.prototype, 'initDimensions').mockImplementation(function (this: fabric.FabricText) {
    this.width = this.text.length * this.fontSize * 0.6;
    this.height = this.fontSize;
  });
});
afterEach(() => vi.restoreAllMocks());

function unit(definitionId: string, rotation: number): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find(entry => entry.id === definitionId)!;
  return {
    id: definitionId, type: 'ducted-ac', position: { x: 4200, y: 1900 }, rotation,
    width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm,
    elevation: 2600, mountType: 'ceiling', label: definition.name, supplyZoneRatio: 0.5,
    properties: { ...definition.defaultProperties },
  };
}

function rendererHarness() {
  const groups: fabric.Group[] = [];
  const canvas = {
    add: (group: fabric.Group) => groups.push(group), bringObjectToFront: vi.fn(),
    requestRenderAll: vi.fn(), remove: vi.fn(), getZoom: () => 1,
  } as unknown as fabric.Canvas;
  return { renderer: new HvacPlanRenderer(canvas), groups };
}

function named(group: fabric.Group, name: string): fabric.FabricObject {
  const object = group.getObjects().find(object => (object as fabric.FabricObject & { name?: string }).name === name);
  expect(object, name).toBeDefined();
  return object!;
}

function world(element: HvacElement, local: Point2D): Point2D {
  const radians = (element.rotation ?? 0) * Math.PI / 180;
  return {
    x: element.position.x + element.width / 2 + local.x * Math.cos(radians) - local.y * Math.sin(radians),
    y: element.position.y + element.depth / 2 + local.x * Math.sin(radians) + local.y * Math.cos(radians),
  };
}

function expectAligned(element: HvacElement, group: fabric.Group): void {
  const body = named(group, 'hvac-body').getCenterPoint();
  const expectedBody = world(element, unitConnectionsFor(element)?.casing?.centre ?? { x: 0, y: 0 });
  expect(body.x / MM_TO_PX).toBeCloseTo(expectedBody.x, 6);
  expect(body.y / MM_TO_PX).toBeCloseTo(expectedBody.y, 6);

  // These are the same lip coordinates used as generated ducts' start points.
  for (const port of resolveUnitAirPorts(element)) {
    const collar = named(group, `hvac-air-port-${port.kind}-collar`).getCenterPoint();
    const lip = {
      x: collar.x / MM_TO_PX + port.normal.x * port.collarDepthMm / 2,
      y: collar.y / MM_TO_PX + port.normal.y * port.collarDepthMm / 2,
    };
    expect(lip.x, `${port.kind} x`).toBeCloseTo(port.lip.x, 6);
    expect(lip.y, `${port.kind} y`).toBeCloseTo(port.lip.y, 6);
  }
}

describe('ducted unit plan alignment', () => {
  for (const id of ['vrf-fdum22kxe6f-w', 'vrf-fdum140kxe6f', 'vrf-fdum160kxe6f', 'vrf-fdu224kxze1', 'vrf-fdu280kxze1', 'generic']) {
    it.each([false, true])(`keeps ${id} body and air collars on the routed ports (placement preview %s)`, preview => {
      for (const rotation of [0, 45, 90, 180, 270]) {
        const element = unit(id === 'generic' ? 'vrf-fdum140kxe6f' : id, rotation);
        if (id === 'generic') element.properties = {};
        const snapshot = structuredClone(element);
        const { renderer, groups } = rendererHarness();
        if (preview) renderer.renderElementPreview(element, true);
        else renderer.renderElement(element);
        expectAligned(element, groups[0]!);
        expect(element).toEqual(snapshot);
      }
    });
  }

  it('keeps connections aligned while moving, turning, cancelling and committing a move', () => {
    const element = unit('vrf-fdum140kxe6f', 0);
    const { renderer, groups } = rendererHarness();
    renderer.renderElement(element);
    const group = groups[0]!;
    const moved = { ...element, position: { x: 7800, y: 5200 }, rotation: 90 };
    renderer.previewMove([moved]);
    expectAligned(moved, group);
    renderer.previewMove(null);
    expectAligned(element, group);
    renderer.previewMove([moved]);
    renderer.previewMove(null, { committed: true });
    expectAligned(moved, group);
  });
});

// Independently measured from the indexed triangles in the catalog GLBs, in
// glbModelCache's centred frame. Do not derive these expectations from the
// connection metadata: the former 69 mm error was in that metadata itself.
const MEASURED_SHELLS = [
  { id: 'vrf-fdum22kxe6f-w', x: -117, width: 790, depth: 637 },
  { id: 'vrf-fdum140kxe6f', x: -127, width: 1410, depth: 742 },
  { id: 'vrf-fdum160kxe6f', x: -127, width: 1410, depth: 742 },
];

describe('catalog casing and mouth geometry', () => {
  it.each(MEASURED_SHELLS)('$id matches the actual casing flange and exposes both collars', measured => {
    for (const rotation of [0, 45, 90, 180, 270]) {
      const element = unit(measured.id, rotation);
      const { renderer, groups } = rendererHarness();
      renderer.renderElement(element);
      const group = groups[0]!;
      const body = named(group, 'hvac-body');
      const centre = body.getCenterPoint().scalarDivide(MM_TO_PX);
      const expectedCentre = world(element, { x: measured.x, y: 0 });
      expect(centre.x).toBeCloseTo(expectedCentre.x, 6);
      expect(centre.y).toBeCloseTo(expectedCentre.y, 6);
      expect(body.width / MM_TO_PX).toBeCloseTo(measured.width, 6);
      expect(body.height / MM_TO_PX).toBeCloseTo(measured.depth, 6);

      for (const port of resolveUnitAirPorts(element)) {
        const root = {
          x: port.lip.x - port.normal.x * port.collarDepthMm,
          y: port.lip.y - port.normal.y * port.collarDepthMm,
        };
        // The mouth starts at the actual casing edge; all 30 mm of the collar
        // projects outside it. The full equipment footprint includes these
        // collars and must never be used for the painted casing depth.
        const fromCentre = { x: root.x - centre.x, y: root.y - centre.y };
        expect(fromCentre.x * port.normal.x + fromCentre.y * port.normal.y).toBeCloseTo(measured.depth / 2, 6);
        expect(-fromCentre.x * port.normal.y + fromCentre.y * port.normal.x).toBeCloseTo(0, 6);
        expect(port.widthMm).toBeLessThan(measured.width);
        const mouth = named(group, `hvac-air-port-${port.kind}-mouth`);
        const mouthCentre = mouth.getCenterPoint().scalarDivide(MM_TO_PX);
        expect(mouthCentre.x + port.normal.x * mouth.height / MM_TO_PX / 2).toBeCloseTo(root.x, 6);
        expect(mouthCentre.y + port.normal.y * mouth.height / MM_TO_PX / 2).toBeCloseTo(root.y, 6);
        expectAligned(element, group);
      }
    }
  });

  it.each(MEASURED_SHELLS)('$id keeps the same casing edges before the 3D catalog loads', measured => {
    const element = unit(measured.id, 0);
    const group = buildHvacElementMesh(element, { allElements: [element], pipeTargets: [] })!;
    const shell = group.children[0] as Mesh;
    shell.geometry.computeBoundingBox();
    const bounds = shell.geometry.boundingBox!.clone().translate(shell.position);
    const centre = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    expect(centre.x).toBeCloseTo(measured.x, 3);
    expect(centre.y).toBeCloseTo(0, 3);
    expect(size.x).toBeCloseTo(measured.width, 3);
    expect(size.y).toBeCloseTo(measured.depth, 3);
  });

  it.each(MEASURED_SHELLS)('$id draws the factory necks between the casing and side connectors', measured => {
    const element = unit(measured.id, 0);
    const { renderer, groups } = rendererHarness();
    renderer.renderElement(element);
    const casingFaceX = measured.id === 'vrf-fdum22kxe6f-w' ? 258 : 558;
    for (const kind of ['gas', 'liquid', 'drain']) {
      const neck = named(groups[0]!, `hvac-pipe-port-${kind}-neck`);
      const centre = neck.getCenterPoint().scalarDivide(MM_TO_PX);
      const root = world(element, { x: casingFaceX, y: 0 });
      expect(centre.x - neck.width / MM_TO_PX / 2).toBeCloseTo(root.x, 6);
      const port = unitConnectionsFor(element)!.connections.find(connection => connection.kind === kind)!;
      expect(centre.x + neck.width / MM_TO_PX / 2).toBeCloseTo(world(element, { x: port.rootX, y: 0 }).x, 6);
    }
  });
});
