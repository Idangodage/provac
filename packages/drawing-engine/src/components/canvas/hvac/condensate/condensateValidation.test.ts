import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { generateCondensateNetwork } from './condensateGenerator';
import { resolveCondensateSettings } from './condensateSettings';
import { readCondensatePipeSpec } from './condensateTypes';
import { validateCondensateNetwork } from './condensateValidation';

const settings = resolveCondensateSettings({});
const routingSettings = DEFAULT_PIPE_ROUTING_SETTINGS;

function cassette(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'ceiling-cassette-ac', position: { x, y }, rotation: 0, width: 950, depth: 950, height: 272, elevation: 2400,
    mountType: 'ceiling', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { capacityKw: 2.8 },
  };
}

function gully(id: string, x: number, y: number): HvacElement {
  return {
    id, type: 'condensate-gully', position: { x: x - 100, y: y - 100 }, rotation: 0, width: 200, depth: 200, height: 60, elevation: 0,
    mountType: 'floor', label: id.toUpperCase(), supplyZoneRatio: 0.5, properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish' },
  };
}

let counter = 0;
const idFactory = (prefix: string) => `${prefix}-${counter++}`;

function generatedScene(): HvacElement[] {
  counter = 0;
  const base = [cassette('fcu-1', 0, 0), cassette('fcu-2', 3000, 0), cassette('fcu-3', 3000, 3500), gully('fg-1', 8000, 2000)];
  const result = generateCondensateNetwork(base, { settings, idFactory });
  expect(result.metrics.unitsConnected).toBe(3);
  return [...base, ...result.elementsToAdd];
}

function codes(scene: HvacElement[]): string[] {
  return validateCondensateNetwork(scene, { settings, routingSettings }).issues.map((issue) => issue.code);
}

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('validateCondensateNetwork', () => {
  it('passes a freshly generated network with no errors or warnings', () => {
    const report = validateCondensateNetwork(generatedScene(), { settings, routingSettings });
    expect(report.issues.filter((issue) => issue.level === 'error' || issue.level === 'warning')).toEqual([]);
  });

  it('flags a back-fall introduced by a field edit', () => {
    const scene = generatedScene();
    const main = scene.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).segmentRole === 'main')!;
    const nodes = readCondensatePipeSpec(main).routeNodes3d.map((node, index, all) => (index === all.length - 1 ? { ...node, z: node.z + 200 } : node));
    const edited = scene.map((element) => (element.id === main.id ? { ...element, properties: { ...element.properties, routeNodes3d: nodes } } : element));
    expect(codes(edited)).toContain('CD_ADVERSE_FALL');
  });

  it('flags a run flatter than the minimum fall', () => {
    const scene = generatedScene();
    const main = scene.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).segmentRole === 'main')!;
    const nodes = readCondensatePipeSpec(main).routeNodes3d;
    const flat = nodes.map((node) => ({ ...node, z: nodes[0]!.z }));
    const edited = scene.map((element) => (element.id === main.id ? { ...element, properties: { ...element.properties, routeNodes3d: flat } } : element));
    expect(codes(edited)).toContain('CD_FALL_MIN');
  });

  it('reports a stale network when a unit moves, with a regenerate fix', () => {
    const scene = generatedScene().map((element) => (element.id === 'fcu-2' ? { ...element, position: { x: 3400, y: 0 } } : element));
    const report = validateCondensateNetwork(scene, { settings, routingSettings });
    const stale = report.issues.find((issue) => issue.code === 'CD_STALE');
    expect(stale).toBeDefined();
    expect(stale!.fix).toEqual({ kind: 'regenerate-condensate' });
  });

  it('reports an open end when a downstream pipe is deleted', () => {
    const scene = generatedScene();
    const drop = scene.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).segmentRole === 'drop')!;
    expect(codes(scene.filter((element) => element.id !== drop.id))).toContain('CD_OPEN_END');
  });

  it('reports an indoor unit whose drain is not connected', () => {
    const scene = [...generatedScene(), cassette('fcu-9', 12000, 0)];
    expect(codes(scene)).toContain('CD_UNCONNECTED_UNIT');
  });

  it('reports a reducing pipe downstream', () => {
    const scene = generatedScene();
    const drop = scene.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).segmentRole === 'drop')!;
    const edited = scene.map((element) => (element.id === drop.id
      ? { ...element, properties: { ...element.properties, outerDiameterMm: 21.5, innerDiameterMm: 18.5, nominalSize: '21.5' } }
      : element));
    expect(codes(edited)).toContain('CD_SIZE_DECREASE');
  });

  it('reports a clash when a refrigerant run is drawn through a drain', () => {
    const scene = generatedScene();
    const main = scene.find((element) => element.type === 'condensate-pipe' && readCondensatePipeSpec(element).segmentRole === 'main')!;
    const nodes = readCondensatePipeSpec(main).routeNodes3d;
    const mid = { x: (nodes[0]!.x + nodes[1]!.x) / 2, y: (nodes[0]!.y + nodes[1]!.y) / 2, z: (nodes[0]!.z + nodes[1]!.z) / 2 };
    const vertical = Math.abs(nodes[0]!.x - nodes[1]!.x) < 1;
    const points = vertical
      ? [{ x: mid.x - 2000, y: mid.y }, { x: mid.x + 2000, y: mid.y }]
      : [{ x: mid.x, y: mid.y - 2000 }, { x: mid.x, y: mid.y + 2000 }];
    const refrigerant: HvacElement = {
      id: 'gas-x', type: 'refrigerant-pipe', position: { x: mid.x - 2000, y: mid.y - 2000 }, rotation: 0, width: 4000, depth: 4000, height: 40,
      elevation: mid.z - 20, mountType: 'ceiling', label: 'gas', supplyZoneRatio: 0.5,
      properties: { routePoints: points, routeNodes3d: points.map((point) => ({ ...point, z: mid.z })), pipeDiameterMm: 15.88, insulationThicknessMm: 25.4, lineKind: 'gas', fieldBendConstruction: 'formed-tube' },
    };
    expect(codes([...scene, refrigerant])).toContain('CD_CLASH');
  });
});
