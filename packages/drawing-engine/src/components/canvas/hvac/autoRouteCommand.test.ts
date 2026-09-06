import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';

import { autoRouteSourceSignature, prepareAutoRouteCommand, type AutoRouteSource } from './autoRouteCommand';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';

function element(id: string, type: HvacElement['type']): HvacElement {
  return { id, type, position: { x: 0, y: 0 }, rotation: 0, width: 600, depth: 600,
    height: 250, elevation: 2200, mountType: 'ceiling', supplyZoneRatio: 0, label: id, properties: {} };
}

function fixture() {
  const source: AutoRouteSource = {
    scene: [element('indoor', 'ceiling-cassette-ac'), element('old-pipe', 'refrigerant-pipe')],
    settings: { ...DEFAULT_PIPE_ROUTING_SETTINGS }, walls: [],
  };
  return { source, signature: autoRouteSourceSignature(source), result: {
    elementsToAdd: [element('gas', 'refrigerant-pipe'), element('liquid', 'refrigerant-pipe'),
      element('gas-kit', 'refrigerant-branch-kit'), element('liquid-kit', 'refrigerant-branch-kit')],
    removeElementIds: ['old-pipe'], updates: [], complete: true, unconnectedIndoorIds: [] as string[],
  } };
}

describe('automatic network command acceptance', () => {
  it('packages both services and their real fittings in one replacement command', () => {
    const { source, signature, result } = fixture();
    const original = JSON.stringify(source);
    const prepared = prepareAutoRouteCommand(signature, source, result);
    expect(prepared.issue).toBeUndefined();
    expect(prepared.command?.add).toEqual(result.elementsToAdd);
    expect(prepared.command?.removeIds).toEqual(['old-pipe']);
    expect(JSON.stringify(source)).toBe(original);
  });

  it('rejects a result after equipment moves even if the array identity is unchanged', () => {
    const { source, signature, result } = fixture();
    source.scene[0]!.position.x = 200;
    expect(prepareAutoRouteCommand(signature, source, result).command).toBeUndefined();
    expect(prepareAutoRouteCommand(signature, source, result).issue).toContain('changed');
  });

  it('rejects a result after routing settings change', () => {
    const { source, signature, result } = fixture();
    source.settings.minimumPortStubMm += 50;
    expect(prepareAutoRouteCommand(signature, source, result).command).toBeUndefined();
  });

  it('allows changing the fitting inspection view while the physical route is calculated', () => {
    const { source, signature, result } = fixture();
    source.settings.fittingDisplay = 'insulated';
    expect(prepareAutoRouteCommand(signature, source, result).issue).toBeUndefined();
    expect(prepareAutoRouteCommand(signature, source, result).command?.add).toEqual(result.elementsToAdd);
    source.settings.minimumFieldBendRadiusMm = 150;
    expect(prepareAutoRouteCommand(signature, source, result).command).toBeUndefined();
  });

  it('rejects new component IDs that would overwrite unrelated geometry', () => {
    const { source, signature, result } = fixture();
    result.elementsToAdd[0]!.id = 'indoor';
    expect(prepareAutoRouteCommand(signature, source, result).command).toBeUndefined();
  });

  it('rejects duplicate component IDs', () => {
    const { source, signature, result } = fixture();
    result.elementsToAdd[1]!.id = 'gas';
    expect(prepareAutoRouteCommand(signature, source, result).command).toBeUndefined();
  });

  it('never removes equipment as part of an automatic network replacement', () => {
    const { source, signature, result } = fixture();
    result.removeElementIds.push('indoor');
    expect(prepareAutoRouteCommand(signature, source, result).command).toBeUndefined();
  });

  it('preserves the whole drawing when a replacement leaves requested indoor units disconnected', () => {
    const { source, signature, result } = fixture();
    const snapshot = structuredClone(source);
    const partial = { ...result, complete: false, unconnectedIndoorIds: ['upper-b', 'lower-c'] };
    const prepared = prepareAutoRouteCommand(signature, source, partial);
    expect(prepared.command).toBeUndefined();
    expect(prepared.issue).toBe('2 indoor units remain unconnected. The drawing was preserved.');
    expect(prepared.issueKind).toBe('incomplete-network');
    expect(source).toEqual(snapshot);
    expect(partial.elementsToAdd).toEqual(result.elementsToAdd);
    expect(partial.removeElementIds).toEqual(['old-pipe']);
  });

  it('accepts a sealed additive partial network without replacing existing pipework', () => {
    const { source, signature, result } = fixture();
    const prepared = prepareAutoRouteCommand(signature, source, {
      ...result, complete: false, removeElementIds: [], unconnectedIndoorIds: ['lower-c'],
    });
    expect(prepared.issue).toBeUndefined();
    expect(prepared.command?.add).toEqual(result.elementsToAdd);
    expect(prepared.command?.removeIds).toEqual([]);
  });

  it('rejects partial updates and removals without applying an incomplete network delta', () => {
    const { source, signature } = fixture();
    for (const mutation of [
      { updates: [{ ...source.scene[1]!, label: 'Proposed pipe' }], removeElementIds: [] },
      { updates: [], removeElementIds: ['old-pipe'] },
    ]) {
      const prepared = prepareAutoRouteCommand(signature, source, {
        elementsToAdd: [], ...mutation, complete: false, unconnectedIndoorIds: ['lower-c'],
      });
      expect(prepared.command).toBeUndefined();
      expect(prepared.issueKind).toBe('incomplete-network');
    }
    expect(source.scene[1]!.label).toBe('old-pipe');
  });

  it('does not trust a complete flag when requested units are still reported unconnected', () => {
    const { source, signature, result } = fixture();
    const prepared = prepareAutoRouteCommand(signature, source, {
      ...result, complete: true, unconnectedIndoorIds: ['lower-c'],
    });
    expect(prepared.command).toBeUndefined();
    expect(prepared.issueKind).toBe('incomplete-network');
  });

  it('preserves an incomplete result even when the planner could not enumerate the remaining units', () => {
    const { source, signature, result } = fixture();
    const prepared = prepareAutoRouteCommand(signature, source, { ...result, complete: false });
    expect(prepared.command).toBeUndefined();
    expect(prepared.issue).toBe('The automatic network could not be completed. The drawing was preserved.');
  });

  it.each([true, false])('does not create an empty history entry for a no-op with complete=%s', (complete) => {
    const { source, signature } = fixture();
    expect(prepareAutoRouteCommand(signature, source, { elementsToAdd: [], removeElementIds: [], updates: [],
      complete, unconnectedIndoorIds: complete ? [] : ['lower-c'] }))
      .toEqual({});
  });
});
