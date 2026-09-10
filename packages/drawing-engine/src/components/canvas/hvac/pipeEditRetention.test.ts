import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { autoRouteElementSignature, isPipeRegenerationProtected, pipeRegenerationPolicy,
  protectedPipeNetworkElementIds, retainGeneratedPipeEdit, withPipeRegenerationPolicy } from './pipeEditRetention';

function generated(id = 'gas', networkId = 'network'): HvacElement {
  const element: HvacElement = { id, type: 'refrigerant-pipe', label: id, position: { x: 0, y: 0 }, rotation: 0,
    width: 1000, depth: 20, height: 20, elevation: 2600, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { routeNodes3d: [{ x: 0, y: 0, z: 2600 }, { x: 1000, y: 0, z: 2600 }], diameterMm: 20 } };
  element.properties.autoRouteNetwork = { version: 1, networkId, outdoorUnitId: 'outdoor', indoorUnitIds: ['indoor'],
    signature: autoRouteElementSignature(element) };
  return element;
}

describe('generated pipe edit retention', () => {
  it('recognizes legacy generated geometry and retains an edit even without new policy metadata', () => {
    const pipe = generated();
    expect(pipeRegenerationPolicy(pipe)).toBe('generated');
    const edited = { ...pipe, properties: { ...pipe.properties, diameterMm: 25 } };
    expect(pipeRegenerationPolicy(edited)).toBe('retain');
    expect(isPipeRegenerationProtected(edited)).toBe(true);
  });

  it('limits reconsideration to the exact accepted state and preserves dimensions and ownership', () => {
    const original = generated();
    const edited = retainGeneratedPipeEdit(original, { ...original, label: 'Field adjustment' });
    const accepted = withPipeRegenerationPolicy(edited, 'reconsider');
    expect(pipeRegenerationPolicy(accepted)).toBe('reconsider');
    expect(isPipeRegenerationProtected(accepted)).toBe(false);
    expect(accepted.id).toBe(original.id);
    expect(accepted.properties.routeNodes3d).toEqual(original.properties.routeNodes3d);
    expect(accepted.properties.diameterMm).toBe(original.properties.diameterMm);
    expect(pipeRegenerationPolicy(edited)).toBe('retain');
    const subsequentlyEdited = retainGeneratedPipeEdit(accepted, { ...accepted, label: 'Second field adjustment' });
    expect(pipeRegenerationPolicy(subsequentlyEdited)).toBe('retain');
    expect((subsequentlyEdited.properties.autoRouteNetwork as Record<string, unknown>).reconsideredSignature).toBeUndefined();
  });

  it('protects the complete service pair while leaving unrelated networks eligible', () => {
    const gas = withPipeRegenerationPolicy(generated(), 'retain');
    const liquid = generated('liquid');
    const other = generated('other', 'other-network');
    expect([...protectedPipeNetworkElementIds([gas, liquid, other])].sort()).toEqual(['gas', 'liquid']);
  });

  it.each(['routeLocked', 'networkLevelLocked', 'reviewed', 'installationReviewed'])('never releases %s with reconsideration', key => {
    const pipe = generated();
    pipe.properties[key] = true;
    const reconsidered = withPipeRegenerationPolicy(pipe, 'reconsider');
    expect(isPipeRegenerationProtected(reconsidered)).toBe(true);
  });

  it('leaves manually drawn pipes and policy-only updates unchanged', () => {
    const manual = generated(); delete manual.properties.autoRouteNetwork;
    expect(pipeRegenerationPolicy(manual)).toBe('manual');
    expect(withPipeRegenerationPolicy(manual, 'retain')).toBe(manual);
    const pipe = generated();
    const accepted = withPipeRegenerationPolicy(pipe, 'reconsider');
    expect(retainGeneratedPipeEdit(pipe, accepted)).toBe(accepted);
  });
});
