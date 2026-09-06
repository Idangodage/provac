import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { attachPipeRoute3dToElements } from '../pipeRoute3d';
import {
  buildRefrigerantPipeElements,
  buildRefrigerantPipePairElement,
} from '../refrigerantPipePairModel';
import {
  buildRefrigerantPipeEndpointRenderStateMap,
  buildRefrigerantPipeRenderChainStateMap,
} from '../refrigerantPipeRenderState';

import { buildHvacElementMesh } from './buildHvacElementMesh';

function buildPipe(route: Array<{ x: number; y: number; z: number }>): HvacElement {
  const base = buildRefrigerantPipeElements(route, {
    lineMode: 'gas',
    elevationMm: Math.min(...route.map((point) => point.z)),
  });
  const [stamped] = attachPipeRoute3dToElements(base, route);
  if (!stamped) throw new Error('Expected a pipe element');
  return {
    ...stamped,
    id: 'route-3d-test',
    rotation: stamped.rotation ?? 0,
    category: stamped.category ?? 'accessory',
    subtype: stamped.subtype ?? 'gas',
    modelLabel: stamped.modelLabel ?? 'Gas Pipe',
    supplyZoneRatio: stamped.supplyZoneRatio ?? 0,
    properties: stamped.properties ?? {},
  };
}

describe('buildHvacElementMesh routeNodes3d', () => {
  it.each([0, 1, 2])('keeps the entire continuation visible when member %i has its own 3D route', (authoredIndex) => {
    const scene = makeContinuationScene(authoredIndex);
    const context = continuationContext(scene);
    const rendered = scene.map(element => buildHvacElementMesh(element, context)!);
    const bounds = new THREE.Box3();
    for (const mesh of rendered) bounds.union(new THREE.Box3().setFromObject(mesh));
    const endpoints = insulationEndpoints(rendered);
    const level = Number(scene[0]!.properties.outerDiameterMm) / 2 + scene[0]!.elevation;

    // A chain head must cover all hidden members. An authored 3D member is
    // rendered independently, so neither side may disappear behind its ID.
    expect(bounds.min.x).toBeCloseTo(0, 3);
    expect(bounds.max.x).toBeCloseTo(3000, 3);
    expect(endpoints).toContainEqual([0, 0, level]);
    expect(endpoints).toContainEqual([3000, 0, level]);
    for (let x = 250; x < 3000; x += 250) {
      const ray = new THREE.Raycaster(new THREE.Vector3(x, -500, level), new THREE.Vector3(0, 1, 0));
      expect(ray.intersectObjects(rendered, true).length, `Missing pipe at x=${x}`).toBeGreaterThan(0);
    }
    expect(rendered[authoredIndex]!.children.length).toBeGreaterThan(0);
  });

  it('still renders a complete plan-only continuation chain once at its head', () => {
    const scene = makeContinuationScene();
    const context = continuationContext(scene);
    const rendered = scene.map(element => buildHvacElementMesh(element, context)!);
    const bounds = new THREE.Box3().setFromObject(rendered[0]!);
    const level = Number(scene[0]!.properties.outerDiameterMm) / 2 + scene[0]!.elevation;

    expect(rendered[0]!.children.length).toBeGreaterThan(0);
    expect(rendered.slice(1).map(mesh => mesh.children.length)).toEqual([0, 0]);
    expect(bounds.min.x).toBeCloseTo(0, 3);
    expect(bounds.max.x).toBeCloseTo(3000, 3);
    expect(insulationEndpoints(rendered)).toEqual([[0, 0, level], [3000, 0, level]]);
  });

  it('renders a true vertical riser at its absolute model coordinates', () => {
    const element = buildPipe([
      { x: 120, y: 80, z: 100 },
      { x: 120, y: 80, z: 900 },
    ]);
    const mesh = buildHvacElementMesh(element, { allElements: [element] });
    expect(mesh).not.toBeNull();
    mesh?.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(mesh!);
    expect(bounds.min.z).toBeCloseTo(100, 3);
    expect(bounds.max.z).toBeCloseTo(900, 3);
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(800, 3);
    expect((bounds.min.x + bounds.max.x) / 2).toBeCloseTo(120, 3);
    expect((bounds.min.y + bounds.max.y) / 2).toBeCloseTo(80, 3);
  });

  it('renders an inclined route without flattening its authored Z nodes', () => {
    const element = buildPipe([
      { x: 0, y: 0, z: 150 },
      { x: 500, y: 250, z: 650 },
    ]);
    const mesh = buildHvacElementMesh(element, { allElements: [element] });
    const bounds = new THREE.Box3().setFromObject(mesh!);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(500);
    expect(bounds.max.y - bounds.min.y).toBeGreaterThan(250);
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(500);
  });

  it('renders opaque insulation without a hidden coaxial core', () => {
    const element = buildPipe([
      { x: 0, y: 0, z: 300 },
      { x: 900, y: 0, z: 300 },
    ]);
    const mesh = buildHvacElementMesh(element, { allElements: [element] });
    const roles: string[] = [];
    mesh?.traverse((object) => {
      const role = object.userData.pipeSurfaceRole as string | undefined;
      if (role) roles.push(role);
    });

    expect(roles.filter((role) => role === 'insulation')).toHaveLength(1);
    expect(roles.filter((role) => role === 'core')).toHaveLength(0);
    expect(roles.filter((role) => role === 'exposed-core')).toHaveLength(2);
  });

  it('renders a composite pair from its editable 3D guide', () => {
    const base = buildRefrigerantPipePairElement([
      { x: 100, y: 200 },
      { x: 100, y: 200 },
    ], { elevationMm: 100 });
    const element = {
      ...base,
      id: 'pair-route-3d-test',
      rotation: base.rotation ?? 0,
      properties: {
        ...(base.properties ?? {}),
        routeNodes3d: [
          { x: 100, y: 200, z: 120 },
          { x: 100, y: 200, z: 920 },
        ],
      },
    } as HvacElement;
    const mesh = buildHvacElementMesh(element, { allElements: [element] });
    const bounds = new THREE.Box3().setFromObject(mesh!);
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(800);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(20);

    const roles: string[] = [];
    mesh?.traverse((object) => {
      const role = object.userData.pipeSurfaceRole as string | undefined;
      if (role) roles.push(role);
    });
    expect(roles.filter((role) => role === 'insulation')).toHaveLength(2);
    expect(roles.filter((role) => role === 'core')).toHaveLength(0);
    expect(roles.filter((role) => role === 'exposed-core')).toHaveLength(4);
  });
});

function makeContinuationScene(authoredIndex?: number): HvacElement[] {
  return [0, 1, 2].map(index => {
    const start = { x: index * 1000, y: 0 };
    const end = { x: (index + 1) * 1000, y: 0 };
    const base = buildRefrigerantPipeElements([start, end], { lineMode: 'gas', elevationMm: 2200 })[0]!;
    const level = 2200 + Number(base.properties!.outerDiameterMm) / 2;
    return {
      ...base,
      id: `continuation-${index}`,
      rotation: base.rotation ?? 0,
      supplyZoneRatio: base.supplyZoneRatio ?? 0,
      properties: {
        ...base.properties,
        bundleId: `continuation-${index}`,
        ...(index > 0 ? { startConnection: {
          portPoint: start, direction: { x: 1, y: 0 }, elevationMm: level,
          connectionKind: 'field-pipe', sourceElementId: `continuation-${index - 1}`,
        } } : {}),
        ...(index === authoredIndex ? { routeNodes3d: [{ ...start, z: level }, { ...end, z: level }] } : {}),
      },
    } as HvacElement;
  });
}

function continuationContext(scene: HvacElement[]) {
  const pipeEndpointStateMap = buildRefrigerantPipeEndpointRenderStateMap(scene);
  return {
    allElements: scene,
    pipeEndpointStateMap,
    pipeRenderChainStateMap: buildRefrigerantPipeRenderChainStateMap(scene, pipeEndpointStateMap),
  };
}

function insulationEndpoints(groups: THREE.Object3D[]): number[][] {
  const endpoints: number[][] = [];
  for (const group of groups) group.traverse(object => {
    if (object.userData.pipeSurfaceRole !== 'insulation') return;
    const route = object.userData.pipeRouteEndpoints as { start: number[]; end: number[] };
    endpoints.push(route.start, route.end);
  });
  return endpoints;
}
