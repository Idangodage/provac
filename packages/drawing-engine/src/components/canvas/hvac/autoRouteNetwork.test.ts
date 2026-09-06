import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';

import { autoRouteElementSignature, planAutoRouteNetwork, type AutoRouteNetworkOptions } from './autoRouteNetwork';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import { applyNetworkPipeLevels, planNetworkPipeLevels } from './networkPipeLevels';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from './pipeRoutingSettings';
import { buildRefrigerantPipeElements, getRefrigerantPipeBundleSnapTargets } from './refrigerantPipePairModel';

const options: AutoRouteNetworkOptions = { settings: DEFAULT_PIPE_ROUTING_SETTINGS, objective: 'balanced' };
function indoor(id: string, x: number, y = 300): HvacElement {
  const element: HvacElement = { id, type: 'ceiling-cassette-ac', category: 'indoor-unit',
    label: id, position: { x, y }, rotation: 0, width: 600, depth: 600, height: 250,
    elevation: 2200, mountType: 'ceiling', supplyZoneRatio: 0, properties: {} };
  element.elevation += 2607 - getRefrigerantPipeBundleSnapTargets([element])[0]!.liquidElevationMm;
  return element;
}
function outdoor(id = 'outdoor', x = 6900): HvacElement {
  const element: HvacElement = { id, type: 'outdoor-unit', category: 'outdoor-unit',
    label: id, position: { x, y: 2600 }, rotation: 180, width: 900, depth: 450, height: 1200,
    elevation: 0, mountType: 'floor', supplyZoneRatio: 0, properties: {} };
  element.elevation += 1437 - getRefrigerantPipeBundleSnapTargets([element])[0]!.gasElevationMm;
  return element;
}
function verifyPhysicalNetwork(scene: HvacElement[], added: HvacElement[], indoorIds: string[]) {
  const document = buildVrfDocumentFromHvacElements([...scene, ...added]);
  for (const id of indoorIds) {
    const ports = Object.values(document.equipmentPorts).filter(port => port.equipmentId === id);
    expect(ports.length).toBe(2);
    expect(ports.every(port => port.isConnected)).toBe(true);
  }
  expect(findNewNetworkPipeClashes(scene, added)).toEqual([]);
  for (const pipe of added.filter(element => element.type === 'refrigerant-pipe')) {
    expect(pipe.properties.startConnection).toBeTruthy();
    expect(pipe.properties.endConnection).toBeTruthy();
    const nodes = normalizePipeRouteNodes3d(pipe.properties.routeNodes3d);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < nodes.length; index += 1) {
      const a = nodes[index - 1]!; const b = nodes[index]!;
      expect(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6 || Math.abs(a.z - b.z) < 1e-6).toBe(true);
    }
    expect((pipe.properties.autoRouteNetwork as { signature: string }).signature).toBe(autoRouteElementSignature(pipe));
  }
}

describe('planAutoRouteNetwork', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it('connects actual outdoor and indoor sockets with a paired level route and plumb risers', async () => {
    const scene = [outdoor(), indoor('indoor-a', 500)];
    const snapshot = structuredClone(scene);
    const result = await planAutoRouteNetwork(scene, options);
    expect(result.complete, `${result.connectedIndoorIds.join(', ')}: ${result.issues.join(' ')}`).toBe(true);
    expect(result.elementsToAdd.filter(element => element.type === 'refrigerant-pipe')).toHaveLength(2);
    expect(result.elementsToAdd.filter(element => element.type === 'refrigerant-branch-kit')).toHaveLength(0);
    expect(scene).toEqual(snapshot);
    verifyPhysicalNetwork(scene, result.elementsToAdd, ['indoor-a']);
  });

  it('builds two service trees with physical copper kits and no dangling ends', async () => {
    const scene = [outdoor(), indoor('indoor-a', 500), indoor('indoor-b', 2900), indoor('indoor-c', 4700, -1800)];
    const result = await planAutoRouteNetwork(scene, options);
    expect(result.complete, `${result.connectedIndoorIds.join(', ')}: ${result.issues.join(' ')}`).toBe(true);
    expect(result.connectedIndoorIds).toHaveLength(3);
    expect(result.elementsToAdd.filter(element => element.type === 'refrigerant-branch-kit')).toHaveLength(4);
    expect(result.evaluatedCandidates).toBeGreaterThan(1);
    verifyPhysicalNetwork(scene, result.elementsToAdd, ['indoor-a', 'indoor-b', 'indoor-c']);
  // The bounded search now compares socket-derived stations on several hosts.
  // Keep geometry assertions strict while allowing the full network search.
  }, 120000);

  it('reroutes an untouched generated network deterministically and preserves unit placement', async () => {
    const scene = [outdoor(), indoor('indoor-a', 500)];
    const first = await planAutoRouteNetwork(scene, options);
    expect(first.complete, first.issues.join(' ')).toBe(true);
    const second = await planAutoRouteNetwork([...scene, ...first.elementsToAdd], options);
    expect(second.complete, second.issues.join(' ')).toBe(true);
    expect(second.removeElementIds).toEqual([]);
    expect(second.elementsToAdd).toEqual([]);
    expect(second.issues.join(' ')).toContain('no better feasible alternative');
    expect(second.updates).toEqual([]);
  });

  it('preserves an edited generated tree instead of replacing only its unchanged fragments', async () => {
    const scene = [outdoor(), indoor('indoor-a', 500)];
    const first = await planAutoRouteNetwork(scene, options);
    expect(first.complete, first.issues.join(' ')).toBe(true);
    const edited = first.elementsToAdd.map((element, index) => index === 0 ? { ...element, label: 'Reviewed pipe' } : element);
    const result = await planAutoRouteNetwork([...scene, ...edited], options);
    expect(result.elementsToAdd).toEqual([]);
    expect(result.removeElementIds).toEqual([]);
    expect(result.issues.join(' ')).toContain('preserved');
  });

  it('preserves manually occupied ports and does not join ambiguous outdoor circuits', async () => {
    const unit = indoor('indoor-a', 500); const out = outdoor();
    const port = getRefrigerantPipeBundleSnapTargets([out])[0]!;
    const existing = buildRefrigerantPipeElements([port.point, { x: port.point.x - 1500, y: port.point.y }], { startBundleConnection: port })
      .map((element, index) => ({ ...element, id: `manual-${index}`, rotation: 0 } as HvacElement));
    const manual = await planAutoRouteNetwork([out, unit, ...existing], options);
    expect(manual.elementsToAdd).toEqual([]);
    expect(manual.removeElementIds).toEqual([]);
    const ambiguous = await planAutoRouteNetwork([out, outdoor('outdoor-b', 12000), unit], options);
    expect(ambiguous.elementsToAdd).toEqual([]);
    expect(ambiguous.complete).toBe(false);
    expect(ambiguous.issues.join(' ')).toContain('assign');
  });

  it('uses an explicitly selected outdoor and indoor group without connecting another outdoor', async () => {
    const scene = [outdoor(), outdoor('outdoor-b', 12000), indoor('indoor-a', 500)];
    const result = await planAutoRouteNetwork(scene, { ...options, selectedIds: ['outdoor', 'indoor-a'] });
    expect(result.complete, result.issues.join(' ')).toBe(true);
    expect(JSON.stringify(result.elementsToAdd)).not.toContain('outdoor-b');
  });

  it('does not represent heat recovery as a complete two-pipe network', async () => {
    const source = outdoor(); source.properties.arrangement = 'heat-recovery';
    const result = await planAutoRouteNetwork([source, indoor('indoor-a', 500)], options);
    expect(result.elementsToAdd).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.unconnectedIndoorIds).toEqual(['indoor-a']);
    expect(result.issues.join(' ')).toContain('branch-selector');
  });

  it('reports invalid indoor ports and does not route unselected equipment in their place', async () => {
    const invalid = indoor('invalid', Number.NaN);
    const result = await planAutoRouteNetwork([outdoor(), invalid, indoor('valid', 500)], {
      ...options, selectedIds: ['invalid', 'outdoor'],
    });
    expect(result.elementsToAdd).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.unconnectedIndoorIds).toEqual(['invalid']);
    expect(result.issues.join(' ')).toContain('invalid');
    const pipesSelected = await planAutoRouteNetwork([outdoor(), indoor('valid', 500)], { ...options, selectedIds: ['unrelated-pipe'] });
    expect(pipesSelected.elementsToAdd).toEqual([]);
    expect(pipesSelected.issues.join(' ')).toContain('Select indoor');
  });

  it('rebuilds an explicitly eligible manual circuit and preserves its units', async () => {
    const equipment = [outdoor(), indoor('indoor-a', 500)];
    const from = getRefrigerantPipeBundleSnapTargets([equipment[0]!])[0]!;
    const to = getRefrigerantPipeBundleSnapTargets([equipment[1]!])[0]!;
    const drawn = buildRefrigerantPipeElements([from.point, { x: 6000, y: from.point.y }, { x: 6000, y: 8000 },
      { x: 1800, y: 8000 }, { x: 1800, y: to.point.y }, to.point], { startBundleConnection: from, endBundleConnection: to })
      .map((element, index) => ({ ...element, id: `manual-${index}`, rotation: 0 } as HvacElement));
    const levelPlan = planNetworkPipeLevels([...equipment, ...drawn], { gasHostId: drawn[0]!.id, liquidHostId: drawn[1]!.id,
      gasHostElevationMm: to.gasElevationMm, liquidHostElevationMm: to.liquidElevationMm, startBundle: to, settings: options.settings });
    const manual = applyNetworkPipeLevels(drawn, levelPlan).elements;
    expect(manual).toHaveLength(2);
    const result = await planAutoRouteNetwork([...equipment, ...manual], { ...options, rebuildExisting: true });
    expect(result.complete, result.issues.join(' ')).toBe(true);
    expect(result.removeElementIds.sort()).toEqual(manual.map(element => element.id).sort());
    expect(result.elementsToAdd).toHaveLength(2);
    expect(result.updates).toEqual([]);
    const locked = manual.map((element, index) => index === 0 ? { ...element, properties: { ...element.properties, networkLevelLocked: true } } : element);
    const preserved = await planAutoRouteNetwork([...equipment, ...locked], { ...options, rebuildExisting: true });
    expect(preserved.removeElementIds).toEqual([]);
    expect(preserved.elementsToAdd).toEqual([]);
    expect(preserved.connectedIndoorIds).toEqual(['indoor-a']);
    const blocked = await planAutoRouteNetwork([...equipment, ...manual], { ...options, rebuildExisting: true,
      obstacles: [{ minX: -20000, minY: -20000, maxX: 20000, maxY: 20000 }] });
    expect(blocked.elementsToAdd).toEqual([]);
    expect(blocked.removeElementIds).toEqual([]);
    expect(blocked.connectedIndoorIds).toEqual(['indoor-a']);
    expect(blocked.complete).toBe(true);
    expect(blocked.issues.join(' ')).toContain('preserved');
  });

  it('keeps a cheaper feasible incumbent when an explicit rebuild cannot improve the selected objective', async () => {
    const equipment = [outdoor(), indoor('indoor-a', 500)];
    const first = await planAutoRouteNetwork(equipment, options);
    expect(first.complete).toBe(true);
    const manual = first.elementsToAdd.map((element, index) => {
      const properties = { ...element.properties }; delete properties.autoRouteNetwork;
      return { ...element, id: `incumbent-${index}`, properties };
    });
    const optimized = await planAutoRouteNetwork([...equipment, ...manual], { ...options, rebuildExisting: true });
    expect(optimized.complete, optimized.issues.join(' ')).toBe(true);
    expect(optimized.elementsToAdd).toEqual([]);
    expect(optimized.removeElementIds).toEqual([]);
    expect(optimized.issues.join(' ')).toContain('no better feasible alternative');
  });

  it('preserves an indoor unit assignment when a different outdoor unit is selected', async () => {
    const unit = indoor('indoor-a', 500); unit.properties.outdoorUnitId = 'outdoor';
    const result = await planAutoRouteNetwork([outdoor(), outdoor('other-outdoor', 12000), unit], {
      ...options, selectedIds: ['other-outdoor', 'indoor-a'], rebuildExisting: true,
    });
    expect(result.elementsToAdd).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.unconnectedIndoorIds).toEqual(['indoor-a']);
    expect(result.issues.join(' ')).toContain('assigned');
    expect(unit.properties.outdoorUnitId).toBe('outdoor');
  });

  it('routes only the assigned indoor group when one of several outdoor units is selected', async () => {
    const a = indoor('indoor-a', 500); a.properties.outdoorUnitId = 'outdoor';
    const b = indoor('indoor-b', 13500); b.properties.outdoorUnitId = 'other-outdoor';
    const result = await planAutoRouteNetwork([outdoor(), outdoor('other-outdoor', 18000), a, b], {
      ...options, selectedIds: ['outdoor'],
    });
    expect(result.complete, result.issues.join(' ')).toBe(true);
    expect(result.connectedIndoorIds).toEqual(['indoor-a']);
    expect(result.unconnectedIndoorIds).toEqual([]);
    expect(JSON.stringify(result.elementsToAdd)).not.toContain('indoor-b');
  });
});
