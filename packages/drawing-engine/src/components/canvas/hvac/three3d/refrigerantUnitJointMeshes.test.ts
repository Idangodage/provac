import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../../data/ac-equipment-library';
import type { HvacElement, Point2D } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';
import { buildRefrigerantPipeElements, getRefrigerantPipeBundleSnapTargets } from '../refrigerantPipePairModel';

import { buildHvacElementMesh } from './buildHvacElementMesh';
import { flareNutAcrossFlatsMm, trimPolylineStart, unitJointBareLengthMm } from './refrigerantUnitJointMeshes';

afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

function unit(definitionId: string): HvacElement {
  const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find((entry) => entry.id === definitionId)!;
  return {
    id: 'indoor', type: definition.type, category: 'indoor-unit', rotation: 0,
    position: { x: 5000 - definition.widthMm / 2, y: 3000 - definition.depthMm / 2 },
    width: definition.widthMm, depth: definition.depthMm, height: definition.heightMm, elevation: 2400,
    mountType: 'ceiling', label: 'Indoor', supplyZoneRatio: 0.5, properties: { ...(definition.defaultProperties ?? {}) },
  } as HvacElement;
}

/** The unit's pair drawn straight out of its stubs, each line's mesh built in its scene. */
function pairMeshes(definitionId: string): Array<{ lineKind: string; mesh: THREE.Object3D; stub: THREE.Vector3 }> {
  const indoor = unit(definitionId);
  const target = getRefrigerantPipeBundleSnapTargets([indoor]).find((entry) => entry.connectionKind === 'unit-port')!;
  const out = (along: number): Point2D => ({ x: target.point.x + target.direction.x * along, y: target.point.y + target.direction.y * along });
  const pipes = buildRefrigerantPipeElements([out(0), out(1500)], { startBundleConnection: target })
    .map((element, index) => ({ ...element, id: `pipe-${index}`, rotation: 0 }) as HvacElement);
  const scene = [indoor, ...pipes];
  return pipes.map((pipe) => {
    const gas = pipe.properties.lineKind === 'gas';
    const point = gas ? target.gasPoint : target.liquidPoint;
    return {
      lineKind: String(pipe.properties.lineKind),
      mesh: buildHvacElementMesh(pipe, { allElements: scene })!,
      stub: new THREE.Vector3(point.x, point.y, gas ? target.gasElevationMm : target.liquidElevationMm),
    };
  });
}

function named(root: THREE.Object3D, name: string): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  root.traverse((object) => { if (object.name === name) found.push(object); });
  return found;
}

describe('maker joints at the stubs', () => {
  it('puts a flare nut on a stub the maker model leaves bare (FDUM140), taped insulation short of it', () => {
    for (const { lineKind, mesh, stub } of pairMeshes('vrf-fdum140kxe6f')) {
      expect(named(mesh, 'refrigerant-flare-nut'), lineKind).toHaveLength(1);
      expect(named(mesh, 'refrigerant-insulation-tape'), lineKind).toHaveLength(1);
      const insulation = named(mesh, `refrigerant-${lineKind}-insulation`)[0]!;
      const start = new THREE.Vector3(...(insulation.userData.pipeRouteEndpoints.start as [number, number, number]));
      // The insulation starts past the nut and the bare copper.
      expect(start.distanceTo(stub), lineKind).toBeGreaterThan(30);
    }
  });

  it('brazes the FDU stubs: a socket and its fillet, no nut', () => {
    for (const { lineKind, mesh } of pairMeshes('vrf-fdu224kxze1')) {
      expect(named(mesh, 'refrigerant-brazed-socket'), lineKind).toHaveLength(1);
      expect(named(mesh, 'refrigerant-braze-fillet'), lineKind).toHaveLength(1);
      expect(named(mesh, 'refrigerant-flare-nut'), lineKind).toHaveLength(0);
    }
  });

  it('leaves the nut to the maker model where it has one (FDT28), still taping the insulation', () => {
    for (const { lineKind, mesh } of pairMeshes('vrf-fdt28kxze1')) {
      expect(named(mesh, 'refrigerant-flare-nut'), lineKind).toHaveLength(0);
      expect(named(mesh, 'refrigerant-insulation-tape'), lineKind).toHaveLength(1);
    }
  });

  it('sleeves the joint instead when fittings are shown insulated', () => {
    setActivePipeRoutingSettings({ ...DEFAULT_PIPE_ROUTING_SETTINGS, fittingDisplay: 'insulated' });
    for (const { lineKind, mesh } of pairMeshes('vrf-fdum140kxe6f')) {
      expect(named(mesh, 'refrigerant-joint-sleeve'), lineKind).toHaveLength(1);
      expect(named(mesh, 'refrigerant-joint-tape'), lineKind).toHaveLength(2);
      expect(named(mesh, 'refrigerant-insulation-tape'), lineKind).toHaveLength(0);
    }
  });

  it('draws no maker joint on a generic unit', () => {
    const indoor = { ...unit('vrf-fdum140kxe6f'), properties: { capacityKw: 14 } } as HvacElement;
    const target = getRefrigerantPipeBundleSnapTargets([indoor]).find((entry) => entry.connectionKind === 'unit-port')!;
    const pipes = buildRefrigerantPipeElements([target.point, { x: target.point.x + 1500, y: target.point.y }], { startBundleConnection: target })
      .map((element, index) => ({ ...element, id: `pipe-${index}`, rotation: 0 }) as HvacElement);
    for (const pipe of pipes) expect(named(buildHvacElementMesh(pipe, { allElements: [indoor, ...pipes] })!, 'refrigerant-unit-joint')).toHaveLength(0);
  });
});

describe('joint sizes', () => {
  it('sizes flare nuts by tube and leaves the nut plus a hand-width bare', () => {
    expect([6.35, 9.52, 12.7, 15.88, 19.05].map(flareNutAcrossFlatsMm)).toEqual([17, 22, 26, 29, 36]);
    expect(unitJointBareLengthMm({ kind: 'flare', inModel: false }, 15.88 / 2)).toBeCloseTo(29 * 0.75 + 35, 6);
    expect(unitJointBareLengthMm({ kind: 'brazed', inModel: false }, 19.05 / 2)).toBeCloseTo(19.05 + 35, 6);
  });

  it('trims a run from its start along the way it goes', () => {
    const run = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(100, 0, 0), new THREE.Vector3(100, 100, 0)];
    expect(trimPolylineStart(run, 150).map((point) => point.toArray())).toEqual([[100, 50, 0], [100, 100, 0]]);
    expect(trimPolylineStart(run, 500)).toEqual([]);
  });
});
