import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { validateHvacElementsAsVrf } from '../../hooks/useVrfLiveValidation';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';
import { buildHvacElementMesh } from '../three3d/buildHvacElementMesh';

import { generateCondensateNetwork } from './condensateGenerator';
import { buildCondensatePlanPresentation, condensateFlowArrows } from './condensatePlanPresentation';
import { resolveCondensateSettings } from './condensateSettings';
import { readCondensatePipeSpec } from './condensateTypes';

const settings = resolveCondensateSettings({});

function cassette(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y }, rotation: 0, width: 950, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: id, supplyZoneRatio: 0.5, properties: { capacityKw: 2.8 },
  };
}

const gully: HvacElement = {
  id: 'fg', type: 'condensate-gully', position: { x: 6900, y: 1400 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
  mountType: 'floor', label: 'FG', supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully' },
};

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('condensate integration', () => {
  const base = [cassette('c-1', 0, 0), cassette('c-2', 3000, 0), gully];
  const generated = generateCondensateNetwork(base, { settings }).elementsToAdd;

  it('is invisible to the refrigerant (VRF) validation', () => {
    const without = validateHvacElementsAsVrf(base);
    const withDrains = validateHvacElementsAsVrf([...base, ...generated]);
    expect(withDrains.issues.map((issue) => issue.id).sort()).toEqual(without.issues.map((issue) => issue.id).sort());
  });

  it('builds a 3D run that follows the sloped centreline in world coordinates', () => {
    const pipe = generated.find((element) => readCondensatePipeSpec(element).segmentRole === 'main') ?? generated[0]!;
    const nodes = readCondensatePipeSpec(pipe).routeNodes3d;
    const mesh = buildHvacElementMesh(pipe, { allElements: [...base, ...generated] });
    expect(mesh).not.toBeNull();
    const box = new THREE.Box3().setFromObject(mesh!);
    const zs = nodes.map((node) => node.z);
    expect(box.min.z).toBeLessThanOrEqual(Math.min(...zs));
    expect(box.max.z).toBeGreaterThanOrEqual(Math.max(...zs));
    expect(box.min.z).toBeGreaterThan(Math.min(...zs) - 60);
  });

  it('builds the gully and its tundish at the floor', () => {
    const mesh = buildHvacElementMesh(gully, { allElements: [gully] });
    const names = new Set<string>();
    mesh!.traverse((child) => names.add(child.name));
    expect(names.has('condensate-gully-grate')).toBe(true);
    expect(names.has('condensate-gully-tundish')).toBe(true);
  });

  it('presents fall tags, invert levels and downstream arrows in plan', () => {
    const presentation = generated.map(buildCondensatePlanPresentation).find((entry) => entry && entry.runs.length && entry.fallTag)!;
    expect(presentation.fallTag!.text).toMatch(/^CD 32 · 1:\d+ [→←]$/);
    expect(presentation.levelTags[0]!.text).toMatch(/^IL \d+$/);
    const arrows = condensateFlowArrows(presentation.runs, 500, 100);
    expect(arrows.length).toBeGreaterThan(0);
    const drop = generated.map(buildCondensatePlanPresentation).find((entry) => entry?.spec.segmentRole === 'drop');
    expect(drop?.verticals[0]?.direction).toBe('down');
  });
});
