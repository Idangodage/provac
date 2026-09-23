import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';

import { buildCircularFieldPipeSegments } from './fieldPipeBends';
import { pipeEditControlIndices } from './pipeEditModel';
import type { PipeRouteNode3D } from './pipeRoute3d';

const point = (x: number, y: number, z = 2400): PipeRouteNode3D => ({ x, y, z });
const separation = (a: PipeRouteNode3D, b: PipeRouteNode3D) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function pipe(nodes: PipeRouteNode3D[]): HvacElement {
  return {
    id: 'pipe', type: 'refrigerant-pipe', label: 'Gas pipe',
    position: { x: 0, y: 0 }, width: 2000, depth: 1000, height: 40, elevation: 2380,
    rotation: 0, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: {
      lineKind: 'gas', pipeDiameterMm: 15.88, insulationThicknessMm: 12,
      routeNodes3d: nodes, routePoints: nodes.map(({ x, y }) => ({ x, y })),
      segmentMaterials: nodes.slice(1).map(() => 'hard'),
    },
  };
}

function roundedRoute(radiusMm: number, route: Point2D[] = [point(0, 0), point(1000, 0), point(1000, 1000)]) {
  return buildCircularFieldPipeSegments(route, radiusMm).flatMap(segment => segment.points)
    .map(({ x, y }) => point(x, y))
    .filter((node, index, nodes) => index === 0 || separation(node, nodes[index - 1]!) > 1e-6);
}

describe('pipe edit control geometry', () => {
  it.each([25, 50, 250, 600])('removes all samples and tangent boundaries of an actual radius-%imm field bend', radiusMm => {
    const nodes = roundedRoute(radiusMm);
    const element = pipe(nodes);
    const before = structuredClone(element);
    expect(nodes.length).toBeGreaterThan(20);
    expect(pipeEditControlIndices(element)).toEqual({ nodes: [0, nodes.length - 1], segments: [0, nodes.length - 2] });
    expect(element).toEqual(before);
  });

  it.each(['vertical', 'oblique'] as const)('recognizes the same bend in a %s 3D plane', plane => {
    const nodes = roundedRoute(250).map(node => plane === 'vertical'
      ? point(node.x, 100, node.y + 2400)
      : point(node.x / Math.SQRT2 + 11000, node.y + 8000, node.x / Math.SQRT2 + 2400));
    expect(pipeEditControlIndices(pipe(nodes))).toEqual({ nodes: [0, nodes.length - 1], segments: [0, nodes.length - 2] });
  });

  it('removes the shared inflection point between two tangent socket-gather bends', () => {
    const radius = 50; const angle = Math.PI / 6; const divisions = 8;
    const nodes = [point(0, 0), point(100, 0)];
    for (let step = 1; step <= divisions; step++) {
      const theta = angle * step / divisions;
      nodes.push(point(100 + radius * Math.sin(theta), radius * (1 - Math.cos(theta))));
    }
    for (let step = 1; step <= divisions; step++) {
      const theta = angle * (1 - step / divisions);
      nodes.push(point(100 + radius * (2 * Math.sin(angle) - Math.sin(theta)),
        radius * (1 - 2 * Math.cos(angle) + Math.cos(theta))));
    }
    nodes.push(point(nodes.at(-1)!.x + 100, nodes.at(-1)!.y));
    expect(pipeEditControlIndices(pipe(nodes))).toEqual({ nodes: [0, nodes.length - 1], segments: [0, nodes.length - 2] });
  });

  it('keeps a 10mm real straight between two bends even though both of its endpoints are tangent samples', () => {
    const nodes = roundedRoute(50, [point(0, 0), point(1000, 0), point(1000, 110), point(2000, 110)]);
    const straight = nodes.findIndex((node, index) => index < nodes.length - 1
      && Math.abs(separation(node, nodes[index + 1]!) - 10) < 1e-6);
    expect(straight).toBeGreaterThan(0);
    expect(pipeEditControlIndices(pipe(nodes))).toEqual({
      nodes: [0, nodes.length - 1], segments: [0, straight, nodes.length - 2],
    });
  });

  it('retains authored sharp corners, short doglegs and collinear material stations', () => {
    const routes = [
      [point(0, 0), point(1000, 0), point(1000, 1000)],
      [point(0, 0), point(5, 0), point(10, 1), point(15, 1), point(20, 2)],
      [point(0, 0), point(5, 0), point(10, 0), point(15, 0)],
    ];
    for (const nodes of routes) expect(pipeEditControlIndices(pipe(nodes))).toEqual({
      nodes: nodes.map((_, index) => index), segments: nodes.slice(1).map((_, index) => index),
    });
  });

  it('retains a real corner where the first straight meets an arc without tangency', () => {
    const nodes = roundedRoute(50);
    nodes[0] = point(0, -200);
    expect(pipeEditControlIndices(pipe(nodes))).toEqual({ nodes: [0, 1, nodes.length - 1], segments: [0, nodes.length - 2] });
  });

  it('preserves a material junction inside an otherwise sampled bend', () => {
    const nodes = roundedRoute(50);
    const element = pipe(nodes);
    element.properties.segmentMaterials = nodes.slice(1).map((_, index) => index < 10 ? 'hard' : 'flexible');
    expect(pipeEditControlIndices(element)).toEqual({ nodes: [0, 10, nodes.length - 1], segments: [0, nodes.length - 2] });
  });

  it('honors an explicit persisted design when its authored nodes match the current route', () => {
    const nodes = roundedRoute(50);
    const element = pipe(nodes);
    element.properties.pipeDesign = {
      version: 1,
      nodes: nodes.map((node, index) => ({ ...node, id: `node-${index}` })),
      legs: nodes.slice(1).map((_, index) => ({ id: `leg-${index}`, fromNodeId: `node-${index}`, toNodeId: `node-${index + 1}`, material: 'hard' })),
      joints: [],
    };
    expect(pipeEditControlIndices(element)).toEqual({
      nodes: nodes.map((_, index) => index), segments: nodes.slice(1).map((_, index) => index),
    });
    // Editing legacy geometry must not let stale design metadata resurrect dots.
    (element.properties.pipeDesign as { nodes: PipeRouteNode3D[] }).nodes[2]!.z += 100;
    expect(pipeEditControlIndices(element)).toEqual({ nodes: [0, nodes.length - 1], segments: [0, nodes.length - 2] });
  });

  it('applies the same source-index contract to paired and legacy plan-only pipes', () => {
    const nodes = roundedRoute(250);
    const element = pipe(nodes);
    element.type = 'refrigerant-pipe-pair';
    expect(pipeEditControlIndices(element)).toEqual({ nodes: [0, nodes.length - 1], segments: [0, nodes.length - 2] });
    delete element.properties.routeNodes3d;
    expect(pipeEditControlIndices(element)).toEqual({ nodes: [0, nodes.length - 1], segments: [0, nodes.length - 2] });
  });
});
