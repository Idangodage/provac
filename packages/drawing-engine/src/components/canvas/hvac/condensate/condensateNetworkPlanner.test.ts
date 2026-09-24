import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement, Wall } from '../../../../types';
import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../pipeRoutingSettings';

import { generateCondensateNetwork, type CondensateGenerationResult } from './condensateGenerator';
import { resolveCondensateSettings, type CondensateDesignSettings } from './condensateSettings';
import { readCondensatePipeSpec, type Point3 } from './condensateTypes';

function unit(id: string, x: number, y: number, overrides: Partial<HvacElement> = {}): HvacElement {
  return {
    id,
    type: 'ceiling-cassette-ac',
    position: { x, y },
    rotation: 0,
    width: 950,
    depth: 950,
    height: 272,
    elevation: 2400,
    mountType: 'ceiling',
    label: id.toUpperCase(),
    supplyZoneRatio: 0.5,
    properties: { capacityKw: 2.8 },
    ...overrides,
  };
}

function ducted(id: string, x: number, y: number, properties: Record<string, unknown> = {}): HvacElement {
  return unit(id, x, y, { type: 'ducted-ac', width: 1084, depth: 697, height: 300, properties: { capacityKw: 5.6, ...properties } });
}

function gully(id: string, x: number, y: number, properties: Record<string, unknown> = {}): HvacElement {
  return {
    id,
    type: 'condensate-gully',
    position: { x: x - 100, y: y - 100 },
    rotation: 0,
    width: 200,
    depth: 200,
    height: 60,
    elevation: 0,
    mountType: 'floor',
    label: id.toUpperCase(),
    supplyZoneRatio: 0.5,
    properties: { terminationKind: 'floor-gully', inletElevationMm: 50, terminalTrap: 'tundish', ...properties },
  };
}

function refrigerant(id: string, points: Array<{ x: number; y: number }>, z: number): HvacElement {
  return {
    id,
    type: 'refrigerant-pipe',
    position: { x: Math.min(...points.map((p) => p.x)), y: Math.min(...points.map((p) => p.y)) },
    rotation: 0,
    width: 10,
    depth: 10,
    height: 40,
    elevation: z - 20,
    mountType: 'ceiling',
    label: id,
    supplyZoneRatio: 0.5,
    properties: {
      routePoints: points,
      routeNodes3d: points.map((point) => ({ ...point, z })),
      pipeDiameterMm: 15.88,
      insulationThicknessMm: 25.4,
      lineKind: 'gas',
      fieldBendConstruction: 'formed-tube',
    },
  };
}

let ids = 0;
const idFactory = (prefix: string) => `${prefix}-${ids++}`;

function run(scene: HvacElement[], settings: Partial<CondensateDesignSettings> = {}): CondensateGenerationResult {
  ids = 0;
  return generateCondensateNetwork(scene, { settings: resolveCondensateSettings(settings), idFactory });
}

function pipeNodes(result: CondensateGenerationResult): Array<{ id: string; role: string; pumped: boolean; nodes: Point3[] }> {
  return result.elementsToAdd.map((element) => {
    const spec = readCondensatePipeSpec(element);
    return { id: element.id, role: spec.segmentRole, pumped: spec.pumped, nodes: spec.routeNodes3d };
  });
}

/** Every sloped run falls at least `minSlope`; nothing rises except a pump riser at the unit. */
function expectGravityCompliant(result: CondensateGenerationResult, minSlopePercent = 1): void {
  for (const pipe of pipeNodes(result)) {
    pipe.nodes.forEach((node, index) => {
      if (index === 0) return;
      const previous = pipe.nodes[index - 1]!;
      const plan = Math.hypot(node.x - previous.x, node.y - previous.y);
      const rise = node.z - previous.z;
      // A pumped unit discharges through a short level hose into its riser (≤ 300 mm), then lifts.
      const isPumpConnection = pipe.pumped && index <= 2 && (plan < 1 || plan <= 300);
      if (isPumpConnection) return;
      expect(rise, `${pipe.id} segment ${index} rises`).toBeLessThanOrEqual(0.5);
      if (plan > 60) expect(((previous.z - node.z) / plan) * 100, `${pipe.id} segment ${index} fall`).toBeGreaterThanOrEqual(minSlopePercent - 0.02);
    });
  }
}

beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

describe('generateCondensateNetwork — single termination', () => {
  const scene = [
    unit('fcu-1', 0, 0),
    unit('fcu-2', 3000, 0),
    unit('fcu-3', 6000, 0),
    unit('fcu-4', 3000, 3500),
    gully('fg-1', 9500, 2000),
  ];

  it('connects every unit into one tree with continuous fall', () => {
    const result = run(scene);
    expect(result.issues).toEqual([]);
    expect(result.metrics.unitsConnected).toBe(4);
    expect(result.metrics.networks).toBe(1);
    expectGravityCompliant(result);
    // One drop into the gully, ending an air break above the tundish.
    const drop = pipeNodes(result).find((pipe) => pipe.role === 'drop')!;
    expect(drop).toBeDefined();
    expect(drop.nodes[drop.nodes.length - 1]!.z).toBeCloseTo(50 + 110 + 25, 1);
  });

  it('enters every branch into the crown of its main through a wye', () => {
    const result = run(scene);
    const wyes = result.elementsToAdd.flatMap((element) => readCondensatePipeSpec(element).fittings.filter((fitting) => fitting.kind === 'wye')
      .map((fitting) => ({ fitting, nodes: readCondensatePipeSpec(element).routeNodes3d })));
    expect(wyes.length).toBeGreaterThanOrEqual(2);
    for (const { fitting, nodes } of wyes) {
      const crown = nodes[nodes.length - 1]!;
      // The branch arrives above the main centreline (top entry).
      expect(crown.z).toBeGreaterThan(fitting.point.z + fitting.outerDiameterMm / 2 - 0.5);
    }
  });

  it('never sizes a pipe smaller than the pipes feeding it', () => {
    const result = run(scene, { groupedMainMinOuterDiameterMm: 40 });
    const byNode = new Map<string, number>();
    for (const element of result.elementsToAdd) {
      const spec = readCondensatePipeSpec(element);
      if (spec.drainStart?.nodeId) byNode.set(spec.drainStart.nodeId, spec.outerDiameterMm);
    }
    for (const element of result.elementsToAdd) {
      const spec = readCondensatePipeSpec(element);
      const downstream = spec.drainEnd?.nodeId ? byNode.get(spec.drainEnd.nodeId) : undefined;
      if (downstream !== undefined) expect(downstream).toBeGreaterThanOrEqual(spec.outerDiameterMm);
      if (spec.upstreamUnitIds.length >= 2) expect(spec.outerDiameterMm).toBeGreaterThanOrEqual(40);
    }
  });

  it('is deterministic', () => {
    const a = run(scene);
    const b = run(scene);
    expect(JSON.stringify(a.elementsToAdd)).toBe(JSON.stringify(b.elementsToAdd));
  });

  it('tags ownership so a regenerate replaces only its own network', () => {
    const first = run(scene);
    const again = run([...scene, ...first.elementsToAdd]);
    expect(new Set(again.removeElementIds)).toEqual(new Set(first.elementsToAdd.map((element) => element.id)));
  });
});

describe('generateCondensateNetwork — fall budget', () => {
  it('lifts a pumped cassette only as much as it needs, and reports gravity units that cannot reach', () => {
    const scene = [
      unit('far-cassette', 0, 0),
      ducted('far-ducted', 0, 4000),
      gully('fg-1', 30000, 2000),
    ];
    const result = run(scene);
    const cassette = result.perUnit.find((entry) => entry.unitId === 'far-cassette')!;
    const ductedResult = result.perUnit.find((entry) => entry.unitId === 'far-ducted')!;
    expect(cassette.status).toBe('pumped');
    expect(cassette.liftMm).toBeGreaterThan(0);
    expect(cassette.liftMm).toBeLessThanOrEqual(600);
    expect(ductedResult.status).toBe('infeasible');
    expect(ductedResult.shortfallMm).toBeGreaterThan(0);
    expect(result.unresolvedPaths.some((path) => path.unitId === 'far-ducted')).toBe(true);
    expectGravityCompliant(result);
  });

  it('sends a unit to a second termination when the first is out of reach', () => {
    const scene = [
      ducted('d-1', 0, 0),
      gully('fg-far', 40000, 0),
      gully('fg-near', 3500, 2500),
    ];
    const result = run(scene);
    expect(result.perUnit.find((entry) => entry.unitId === 'd-1')?.gullyId).toBe('fg-near');
  });

  it('ends at a stack branch level through a waterless valve', () => {
    const scene = [unit('c-1', 0, 0), gully('stack', 5000, 1500, { terminationKind: 'stack-connection', inletElevationMm: 2300, terminalTrap: 'hepvo' })];
    const result = run(scene);
    expect(result.metrics.unitsConnected).toBe(1);
    const terminal = pipeNodes(result).find((pipe) => pipe.role === 'terminal')!;
    expect(terminal.nodes[terminal.nodes.length - 1]!.z).toBeCloseTo(2300, 1);
    expect(result.elementsToAdd.some((element) => readCondensatePipeSpec(element).fittings.some((fitting) => fitting.kind === 'hepvo'))).toBe(true);
  });
});

describe('generateCondensateNetwork — external wall discharge', () => {
  it('runs to the wall face, drops to the penetration level and sleeves the wall', () => {
    const wall = {
      id: 'wall-east', startPoint: { x: 9000, y: -2000 }, endPoint: { x: 9000, y: 4000 }, thickness: 200,
      properties3D: { height: 3000, baseElevation: 0 },
    } as unknown as Wall;
    const outlet: HvacElement = {
      ...gully('ext', 8860, 600, { terminationKind: 'external-discharge', inletElevationMm: 2350, terminalTrap: 'none' }),
      mountType: 'wall', wallId: 'wall-east', width: 150, depth: 80,
      position: { x: 8860 - 75, y: 600 - 40 },
    };
    const result = generateCondensateNetwork([unit('c-1', 3000, 0), outlet], { settings: resolveCondensateSettings({}), idFactory, walls: [wall] });
    expect(result.metrics.unitsConnected).toBe(1);
    const terminal = pipeNodes(result).find((pipe) => pipe.role === 'terminal')!;
    const end = terminal.nodes[terminal.nodes.length - 1]!;
    expect(end.x).toBeCloseTo(9000, 0); // the wall centreline: the pipe penetrates the wall
    expect(end.z).toBeCloseTo(2350, 1);
    const fittings = result.elementsToAdd.flatMap((element) => readCondensatePipeSpec(element).fittings.map((fitting) => fitting.kind));
    expect(fittings).toContain('wall-sleeve');
    expect(fittings).toContain('terminal-outlet');
    expectGravityCompliant(result);
  });
});

describe('generateCondensateNetwork — refrigerant coordination', () => {
  it('holds the drain below a refrigerant run it crosses', () => {
    const scene = [
      unit('c-1', 0, 0),
      gully('fg-1', 8000, 500),
      refrigerant('gas-1', [{ x: 4000, y: -3000 }, { x: 4000, y: 4000 }], 2750),
    ];
    const result = run(scene);
    expect(result.metrics.unitsConnected).toBe(1);
    const crossing = result.crossings.find((entry) => entry.serviceElementId === 'gas-1');
    expect(crossing).toBeDefined();
    expect(crossing!.relation).toBe('below');
    expect(crossing!.serviceZMin - crossing!.condensateZ).toBeGreaterThanOrEqual(crossing!.requiredClearanceMm - 0.5);
    expectGravityCompliant(result);
  });

  it('proposes a refrigerant hop when the drain can pass neither below nor above', () => {
    // A refrigerant run sitting just above the ceiling tiles blocks the void.
    const scene = [
      ducted('d-1', 0, 0),
      gully('fg-1', 8000, 400),
      refrigerant('liq-1', [{ x: 4000, y: -3000 }, { x: 4000, y: 4000 }], 2475),
    ];
    const result = run(scene);
    const crossing = result.crossings.find((entry) => entry.serviceElementId === 'liq-1');
    expect(crossing?.relation).toBe('hop');
    expect(result.hopProposals).toHaveLength(1);
    expect(result.hopProposals[0]!.requiredCentrelineZ).toBeGreaterThan(crossing!.condensateZ);
    expectGravityCompliant(result);
  });
});
