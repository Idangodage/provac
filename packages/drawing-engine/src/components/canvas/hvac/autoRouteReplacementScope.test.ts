import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { replaceableGeneratedRefrigerantIds } from './autoRouteNetwork';
import { autoRouteElementSignature } from './pipeEditRetention';

function unit(id: string, outdoorId?: string): HvacElement {
  return { id, type: outdoorId ? 'ceiling-cassette-ac' : 'outdoor-unit', position: { x: 0, y: 0 },
    rotation: 0, width: outdoorId ? 1043 : 900, depth: outdoorId ? 950 : 450, height: outdoorId ? 272 : 1200,
    elevation: outdoorId ? 2400 : 0, mountType: outdoorId ? 'ceiling' : 'floor', label: id, supplyZoneRatio: 0.5,
    properties: outdoorId ? { modelCode: 'FDT28KXZE1', capacityKw: 2.8, outdoorUnitId: outdoorId } : {} };
}

function owned(id: string, outdoorId: string, indoorIds: string[], lineKind: 'gas' | 'liquid' = 'gas'): HvacElement {
  const element: HvacElement = { ...unit(id), type: 'refrigerant-pipe',
    properties: { routeNodes3d: [{ x: 1000, y: 0, z: 2600 }, { x: 4000, y: 0, z: 2600 }],
      routePoints: [{ x: 1000, y: 0 }, { x: 4000, y: 0 }], pipeDiameterMm: 15.88, insulationThicknessMm: 9, lineKind } };
  element.properties.autoRouteNetwork = { version: 1, networkId: `network-${outdoorId}`, outdoorUnitId: outdoorId,
    indoorUnitIds: indoorIds, signature: autoRouteElementSignature(element) };
  return element;
}

describe('generated refrigerant space reserved for coordinated rebuilding', () => {
  const equipment = [unit('outdoor-a'), unit('outdoor-b'), unit('a', 'outdoor-a'), unit('b', 'outdoor-b')];
  const gas = owned('gas-a', 'outdoor-a', ['a']);
  const liquid = owned('liquid-a', 'outdoor-a', ['a'], 'liquid');
  const other = owned('gas-b', 'outdoor-b', ['b']);

  it('reserves only the selected generated circuit and leaves the source immutable', () => {
    const manual = { ...owned('manual', 'outdoor-a', ['a']), properties: { ...gas.properties } };
    delete manual.properties.autoRouteNetwork;
    const scene = [...equipment, gas, liquid, other, manual];
    const before = structuredClone(scene);
    expect(replaceableGeneratedRefrigerantIds(scene, { selectedIds: ['a'], rebuildExisting: true })).toEqual(['gas-a', 'liquid-a']);
    expect(replaceableGeneratedRefrigerantIds(scene, { selectedIds: ['a'], rebuildExisting: false })).toEqual([]);
    expect(scene).toEqual(before);
  });

  it.each(['retained', 'locked', 'edited'] as const)('preserves both lines when a circuit is %s', (kind) => {
    const changed = structuredClone(gas);
    if (kind === 'locked') changed.properties.routeLocked = true;
    if (kind === 'edited') changed.elevation += 100;
    if (kind === 'retained') (changed.properties.autoRouteNetwork as { editPolicy?: string }).editPolicy = 'retain';
    expect(replaceableGeneratedRefrigerantIds([...equipment, changed, liquid], { selectedIds: ['a'], rebuildExisting: true })).toEqual([]);
  });

  it('keeps networks serving unselected units and circuits with external attachments', () => {
    const shared = owned('shared', 'outdoor-a', ['a', 'unselected']);
    expect(replaceableGeneratedRefrigerantIds([...equipment, shared], { selectedIds: ['a'], rebuildExisting: true })).toEqual([]);
    const extension = { ...owned('extension', 'outdoor-a', ['a']), properties: {
      startConnection: { connectionKind: 'field-pipe', sourceElementId: gas.id },
    } };
    expect(replaceableGeneratedRefrigerantIds([...equipment, gas, liquid, extension], { selectedIds: ['a'], rebuildExisting: true })).toEqual([]);
  });

  it('does not reserve a three-pipe circuit the network planner cannot rebuild', () => {
    const scene = [...equipment.map(element => element.id === 'outdoor-a'
      ? { ...element, properties: { refrigerantPipeCount: 3 } } : element), gas, liquid];
    expect(replaceableGeneratedRefrigerantIds(scene, { selectedIds: ['a'], rebuildExisting: true })).toEqual([]);
  });
});
