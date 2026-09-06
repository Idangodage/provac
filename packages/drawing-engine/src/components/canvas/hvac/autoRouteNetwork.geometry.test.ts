import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';

import { planAutoRouteNetwork } from './autoRouteNetwork';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS, getActivePipeRoutingSettings, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { getBranchKitPortConnections, getRefrigerantPipeBundleSnapTargets, resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';
import { buildHvacElementMesh } from './three3d/buildHvacElementMesh';

function unit(id: string, x: number, y: number, outdoor = false): HvacElement {
  return {
    id, type: outdoor ? 'outdoor-unit' : 'ceiling-cassette-ac',
    category: outdoor ? 'outdoor-unit' : 'indoor-unit',
    position: { x, y }, rotation: outdoor ? 180 : 0,
    width: outdoor ? 900 : 600, depth: outdoor ? 450 : 600,
    height: outdoor ? 1200 : 250, elevation: outdoor ? 0 : 2300,
    mountType: outdoor ? 'floor' : 'ceiling', label: id, supplyZoneRatio: 0, properties: {},
  };
}

function rotate(point: Point2D, angle: number): Point2D {
  const sin = Math.round(Math.sin(angle * Math.PI / 180));
  const cos = Math.round(Math.cos(angle * Math.PI / 180));
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function equipmentScene(angle = 0): HvacElement[] {
  return [unit('outdoor', 10500, 6500, true), unit('cassette-1', 500, 500),
    unit('cassette-2', 3500, 500), unit('cassette-3', 6500, 500)].map(element => {
    const center = rotate({ x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 }, angle);
    return { ...element, position: { x: center.x - element.width / 2, y: center.y - element.depth / 2 }, rotation: (element.rotation + angle) % 360 };
  });
}

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('automatic network physical geometry', () => {
  it('connects ordinary equipment elevations with one cassette across the distribution corridor', async () => {
    const equipment = [{ ...unit('outdoor', 6900, 2600, true), elevation: 1000 },
      ...[500, 2900, 4700].map((x, index) => ({ ...unit(`indoor-${index}`, x, index === 2 ? -1800 : 300), elevation: 2200 }))];
    const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS, scaleMmPerPx: 10, defaultPipeElevationMm: 2600 };
    const result = await planAutoRouteNetwork(equipment, { settings, objective: 'balanced' });
    expect(result.complete, result.issues.join('\n')).toBe(true);
    expect(result.connectedIndoorIds).toHaveLength(3);
    expect(result.metrics?.branchPairCount).toBe(2);
    expect(result.metrics?.elevationReversalCount).toBe(0);
  }, 60000);

  it('connects a mixed group whose indoor ports face all four cardinal directions', async () => {
    const equipment = [unit('outdoor', 14000, 6500, true),
      unit('east-cassette', 500, 500), { ...unit('south-cassette', 3500, 1800), rotation: 90 },
      { ...unit('west-cassette', 6500, 500), rotation: 180 }, { ...unit('north-cassette', 9500, 1800), rotation: 270 }];
    const result = await planAutoRouteNetwork(equipment, { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' });
    expect(result.complete, result.issues.join('\n')).toBe(true);
    expect(result.connectedIndoorIds).toHaveLength(4);
    expect(result.metrics?.branchPairCount).toBe(3);
    expect(result.metrics?.elevationReversalCount).toBe(0);
  }, 60000);

  it('resolves equipment field spacing from the requested document settings and restores the previous settings', async () => {
    const equipment = [unit('outdoor', 7500, 4500, true), unit('cassette', 500, 500)];
    const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS, defaultPipeGapMm: 120 };
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
    const first = await planAutoRouteNetwork(equipment, { settings, objective: 'balanced' });
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, defaultPipeGapMm: 300 });
    const second = await planAutoRouteNetwork(equipment, { settings, objective: 'balanced' });
    expect(first.complete, first.issues.join('\n')).toBe(true);
    expect(second.elementsToAdd).toEqual(first.elementsToAdd);
    expect(getActivePipeRoutingSettings().defaultPipeGapMm).toBe(300);
  }, 60000);

  it('leaves unsupported angled unit ports unconnected instead of moving their physical terminals', async () => {
    const equipment = [unit('outdoor', 5000, 4000, true), { ...unit('angled-cassette', 500, 500), rotation: 45 }];
    const result = await planAutoRouteNetwork(equipment, { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' });
    expect(result.complete).toBe(false);
    expect(result.elementsToAdd).toEqual([]);
    expect(result.unconnectedIndoorIds).toEqual(['angled-cassette']);
  });

  it.each([0, 90, 180, 270])('connects all three cassettes through actual copper ports when the room rotates %s degrees', async angle => {
    const equipment = equipmentScene(angle);
    const result = await planAutoRouteNetwork(equipment, { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' });
    expect(result.complete, result.issues.join('\n')).toBe(true);
    expect(result.connectedIndoorIds.sort()).toEqual(['cassette-1', 'cassette-2', 'cassette-3']);
    expect(result.metrics?.branchPairCount).toBe(2);
    expect(result.metrics?.elevationReversalCount).toBe(0);
    const scene = [...equipment, ...result.elementsToAdd];
    const byId = new Map(scene.map(element => [element.id, element]));
    const connectedCounts = new Map<string, number>();
    for (const element of result.elementsToAdd.filter(element => element.type === 'refrigerant-pipe')) {
      const spec = resolveRefrigerantPipeSpec(element.properties);
      const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
      expect(nodes.length).toBeGreaterThan(1);
      expect(element.properties.bypasses ?? []).toEqual([]);
      expect(element.properties.networkLevelPlan).not.toHaveProperty('deferRiserTurnOptimization');
      for (let index = 1; index < nodes.length; index += 1) {
        if (Math.abs(nodes[index]!.z - nodes[index - 1]!.z) < 1e-6) continue;
        expect(nodes[index]!.x).toBeCloseTo(nodes[index - 1]!.x, 6);
        expect(nodes[index]!.y).toBeCloseTo(nodes[index - 1]!.y, 6);
      }
      for (const [connection, node] of [[spec.startConnection, nodes[0]], [spec.endConnection, nodes.at(-1)]] as const) {
        expect(connection, element.id).not.toBeNull();
        expect(node).toBeDefined();
        const source = byId.get(connection!.sourceElementId!);
        expect(source, `${element.id} must reference a real component`).toBeDefined();
        const target = source!.type === 'refrigerant-branch-kit'
          ? getBranchKitPortConnections(source!).find(port => port.terminalRole === connection!.terminalRole)
          : getRefrigerantPipeBundleSnapTargets([source!])[0];
        expect(target, `${element.id} must attach to a physical port`).toBeDefined();
        const gas = spec.lineKind === 'gas';
        const point = gas ? target!.gasPoint : target!.liquidPoint;
        expect(node!.x).toBeCloseTo(point.x, 4);
        expect(node!.y).toBeCloseTo(point.y, 4);
        expect(node!.z).toBeCloseTo(gas ? target!.gasElevationMm : target!.liquidElevationMm, 4);
        const key = `${source!.id}:${spec.lineKind}:${connection!.terminalRole ?? 'unit'}`;
        connectedCounts.set(key, (connectedCounts.get(key) ?? 0) + 1);
      }
    }
    for (const count of connectedCounts.values()) expect(count).toBe(1);
    for (const element of equipment) for (const service of ['gas', 'liquid']) expect(connectedCounts.get(`${element.id}:${service}:unit`)).toBe(1);
    const document = buildVrfDocumentFromHvacElements(scene);
    for (const branch of Object.values(document.branchKits)) {
      expect(branch.inletNodeIds).toHaveLength(1);
      expect(branch.outletNodeIds).toHaveLength(2);
      for (const id of [...branch.inletNodeIds, ...branch.outletNodeIds]) expect(document.routeNodes[id]!.connectedEdgeIds).toHaveLength(1);
    }
    expect(result.evaluations.every(evaluation => evaluation.feasible)).toBe(true);
    if (angle === 0) {
      // Exercise the actual persisted properties through the production 3D
      // builders, including equipment, insulated tubing, and copper fittings.
      for (const element of scene) {
        const group = buildHvacElementMesh(element, { allElements: scene });
        expect(group, element.id).not.toBeNull();
        const meshes: THREE.Mesh[] = [];
        group!.traverse(object => { if (object instanceof THREE.Mesh) meshes.push(object); });
        expect(meshes.some(mesh => mesh.visible), element.id).toBe(true);
        const bounds = new THREE.Box3().setFromObject(group!);
        expect(bounds.isEmpty(), element.id).toBe(false);
        expect([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)).toBe(true);
        for (const mesh of meshes) {
          const positions = mesh.geometry.getAttribute('position');
          expect(positions?.count, element.id).toBeGreaterThan(0);
          expect(Array.from(positions.array).every(Number.isFinite), element.id).toBe(true);
        }
        if (element.type === 'refrigerant-pipe') {
          const tubes = meshes.filter(mesh => mesh.userData.pipeSurfaceRole === 'insulation');
          const spec = resolveRefrigerantPipeSpec(element.properties);
          expect(tubes.length).toBeGreaterThan(0);
          expect(tubes.every(tube => tube.userData.pipeLineKind === spec.lineKind)).toBe(true);
          for (const [end, connection] of [['start', spec.startConnection], ['end', spec.endConnection]] as const) {
            const terminalTube = end === 'start' ? tubes[0]! : tubes.at(-1)!;
            const endpoint = terminalTube.userData.pipeRouteEndpoints[end] as number[];
            expect(endpoint[0]).toBeCloseTo(connection!.portPoint.x, 4);
            expect(endpoint[1]).toBeCloseTo(connection!.portPoint.y, 4);
            expect(endpoint[2]).toBeCloseTo(connection!.elevationMm, 4);
          }
        }
        if (element.type === 'refrigerant-branch-kit') expect(meshes.some(mesh => mesh.userData.pipeSurfaceRole === 'fitting')).toBe(true);
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
        }
      }
    }
  }, 120000);
});
