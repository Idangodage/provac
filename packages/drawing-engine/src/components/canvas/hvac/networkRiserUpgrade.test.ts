import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { isLegacyGeneratedRamp, prepareNetworkRiserUpgrade, proposeNetworkRiserUpgrade } from './networkRiserUpgrade';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';

const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS };

function fixture() {
  const equipment = (id: string, type: HvacElement['type']): HvacElement => ({
    id, type, position: { x: id === 'outdoor' ? -500 : 4500, y: 0 }, width: 300, depth: 400,
    height: 800, elevation: 0, rotation: 0, label: id, mountType: 'floor', supplyZoneRatio: 0, properties: {},
  });
  const pipes = (['gas', 'liquid'] as const).map(service => {
    const y = service === 'gas' ? 0 : 200;
    const outer = service === 'gas' ? 80 : 70;
    const start = service === 'gas' ? 1000 : 800;
    const end = service === 'gas' ? 2400 : 2200;
    return {
      id: service, type: 'refrigerant-pipe', position: { x: 0, y }, width: 4000, depth: outer,
      height: end - start + outer, elevation: start - outer / 2, rotation: 0, label: service,
      mountType: 'ceiling', supplyZoneRatio: 0,
      properties: {
        lineKind: service, bundleId: 'saved-pair', pipeDiameterMm: outer - 50.8, insulationThicknessMm: 25.4,
        routePoints: [{ x: 0, y }, { x: 4000, y }],
        routeNodes3d: [{ x: 0, y, z: start }, { x: 250, y, z: start },
          { x: 1800, y, z: end }, { x: 4000, y, z: end }],
        startConnection: { connectionKind: 'unit-port', sourceElementId: 'outdoor', portPoint: { x: 0, y },
          elevationMm: start, direction: { x: 1, y: 0 } },
        endConnection: { connectionKind: 'unit-port', sourceElementId: 'indoor', portPoint: { x: 4000, y },
          elevationMm: end, direction: { x: -1, y: 0 } },
        networkLevelPlan: { generated: true, version: 1, corridorElevationMm: end,
          gasElevationMm: 2400, liquidElevationMm: 2200 },
      },
    } as HvacElement;
  });
  return [equipment('outdoor', 'outdoor-unit'), equipment('indoor', 'wall-mounted-ac'), ...pipes];
}

describe('saved network riser upgrade', () => {
  it('offers a complete undoable network command with plumb risers and unchanged equipment ports', () => {
    const scene = fixture(); const before = JSON.stringify(scene);
    const proposal = proposeNetworkRiserUpgrade(scene, 'gas', settings)!;
    expect(proposal.issue).toBeUndefined();
    expect(proposal.plan!.coordinatedRunCount).toBe(2);
    expect(proposal.plan!.connectedOutdoorCount).toBe(1);
    expect(proposal.plan!.connectedIndoorCount).toBe(1);
    const prepared = prepareNetworkRiserUpgrade(proposal, scene, settings);
    expect(prepared.issue).toBeUndefined();
    expect(prepared.command!.add).toBeUndefined();
    expect(prepared.command!.removeIds).toBeUndefined();
    expect(prepared.command!.updates).toHaveLength(2);
    for (const update of prepared.command!.updates!) {
      const original = scene.find(element => element.id === update.id)!;
      expect(update.updates.properties!.startConnection).toEqual(original.properties.startConnection);
      expect(update.updates.properties!.endConnection).toEqual(original.properties.endConnection);
      const nodes = normalizePipeRouteNodes3d(update.updates.properties!.routeNodes3d);
      for (let i = 1; i < nodes.length; i += 1) {
        const a = nodes[i - 1]!; const b = nodes[i]!;
        expect(Math.abs(a.z - b.z) < 1e-6 || Math.hypot(a.x - b.x, a.y - b.y) < 1e-6).toBe(true);
      }
      expect(update.updates.properties!.networkLevelPlan).toMatchObject({ version: 2, transitionStyle: 'vertical-riser' });
    }
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('hides the action for authored, locked, bypassed and already upgraded routes', () => {
    for (const properties of [
      { networkLevelLocked: true }, { networkLevelPlan: undefined },
      { bypasses: [{ id: 'explicit' }] }, { networkLevelPlan: { generated: true, version: 2 } },
    ]) {
      const scene = fixture().map(element => element.id === 'gas'
        ? { ...element, properties: { ...element.properties, ...properties } } : element);
      expect(isLegacyGeneratedRamp(scene.find(element => element.id === 'gas')!)).toBe(false);
      expect(proposeNetworkRiserUpgrade(scene, 'gas', settings)).toBeNull();
    }
  });

  it('preserves locked companion geometry while upgrading an eligible service', () => {
    const scene = fixture().map(element => element.id === 'liquid'
      ? { ...element, properties: { ...element.properties, networkLevelLocked: true } } : element);
    const proposal = proposeNetworkRiserUpgrade(scene, 'gas', settings)!;
    expect(proposal.issue).toBeUndefined();
    expect(proposal.plan!.lockedRoutes.some(route => route.sourceIds.includes('liquid'))).toBe(true);
    expect(prepareNetworkRiserUpgrade(proposal, scene, settings).command!.updates!.map(update => update.id)).toEqual(['gas']);
  });

  it('does not guess a service partner from proximity or an ambiguous bundle', () => {
    const scene = fixture();
    const liquid = scene.find(element => element.id === 'liquid')!;
    const unpaired = scene.map(element => element.id === 'liquid'
      ? { ...element, properties: { ...element.properties, bundleId: 'unrelated' } } : element);
    expect(proposeNetworkRiserUpgrade(unpaired, 'gas', settings)!.issue).toContain('identified gas and liquid pair');
    expect(proposeNetworkRiserUpgrade([...scene, { ...liquid, id: 'duplicate' }], 'gas', settings)!.issue)
      .toContain('identified gas and liquid pair');
  });

  it('rejects stale source geometry and changed route defaults before emitting a command', () => {
    const scene = fixture(); const proposal = proposeNetworkRiserUpgrade(scene, 'gas', settings)!;
    const changed = scene.map(element => element.id === 'liquid' ? { ...element, elevation: element.elevation + 100 } : element);
    expect(prepareNetworkRiserUpgrade(proposal, changed, settings).command).toBeUndefined();
    expect(prepareNetworkRiserUpgrade(proposal, scene, { ...settings, minimumPortStubMm: 350 }).command).toBeUndefined();
  });

  it('rechecks unrelated pipes added after preview and blocks a new riser clash', () => {
    const scene = fixture(); const proposal = proposeNetworkRiserUpgrade(scene, 'gas', settings)!;
    expect(proposal.issue).toBeUndefined();
    const gas = proposal.plan!.updates.find(element => element.id === 'gas')!;
    const nodes = normalizePipeRouteNodes3d(gas.properties.routeNodes3d);
    const rise = nodes.findIndex((node, index) => index > 0 && Math.abs(node.z - nodes[index - 1]!.z) > 1);
    const upper = nodes[rise]!; const lower = nodes[rise - 1]!;
    const z = (upper.z + lower.z) / 2;
    const obstacle: HvacElement = { ...gas, id: 'unrelated-pipe', elevation: z - 20,
      properties: { lineKind: 'gas', bundleId: 'unrelated', pipeDiameterMm: 40, insulationThicknessMm: 0,
        routePoints: [{ x: upper.x, y: upper.y - 150 }, { x: upper.x, y: upper.y + 150 }],
        routeNodes3d: [{ x: upper.x, y: upper.y - 150, z }, { x: upper.x, y: upper.y + 150, z }] } };
    const result = prepareNetworkRiserUpgrade(proposal, [...scene, obstacle], settings);
    expect(result.command).toBeUndefined();
    expect(result.issue).toContain('another insulated pipe');
  });
});
