import { describe, expect, it } from 'vitest';

import { DEFAULT_AC_EQUIPMENT_LIBRARY } from '../../../data/ac-equipment-library';
import type { Point2D } from '../../../types';

import { defaultMinBranchKitSpacingMm, getBranchKitApproachRouteOptions, type BranchKitGhost, type BranchKitProposal } from './branchKitProposal';
import { coordinatedBranchApproachStations } from './coordinatedBranchStations';
import { buildOrthogonalConnectionRouteCandidates, getOrthogonalConnectionRouteCost } from './orthogonalConnectionRoute';
import { DEFAULT_PIPE_ROUTING_SETTINGS } from './pipeRoutingSettings';
import { buildRefrigerantBranchKitViewModel, resolveRefrigerantBranchKitConnectionIdentity,
  resolveRefrigerantBranchKitInlineAnchorLocal } from './refrigerantBranchKitModel';
import type { RefrigerantPipeBundleConnection } from './refrigerantPipePairModel';

const settings = { ...DEFAULT_PIPE_ROUTING_SETTINGS, defaultPipeGapMm: 0, minimumPortStubMm: 200,
  defaultBranchKitClearanceMm: 300, minBranchKitSpacingMm: 500, bendRadiusFactor: 1 };
const rotate = (point: Point2D, degrees: number): Point2D => {
  const cos = Math.round(Math.cos(degrees * Math.PI / 180));
  const sin = Math.round(Math.sin(degrees * Math.PI / 180));
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
};

function proposal(rotation: number): BranchKitProposal {
  const point = (x: number, y: number) => rotate({ x, y }, rotation);
  const ghost = (lineKind: 'gas' | 'liquid'): BranchKitGhost => {
    const y = lineKind === 'gas' ? -20 : 20;
    return {
      lineKind, center: point(800, y), rotationDeg: rotation,
      stationPoint: point(800, y), inletPoint: point(1000, y), runOutletPoint: point(600, y),
      branchOutletPoint: point(650, y + 80), branchOutletDirection: point(-1, 0),
      outerDiameterMm: 40, nudged: false,
      element: { type: 'refrigerant-branch-kit', position: point(600, y - 50), rotation,
        width: 400, depth: 100, height: 40, elevation: 2600, mountType: 'ceiling', label: lineKind,
        supplyZoneRatio: 0.5, properties: { branchKitSnapSourceElementId: `host-${lineKind}` } },
    };
  };
  return {
    connectionType: 'indoor-to-branch', validity: 'valid', violations: [], score: 0,
    teePoint: point(800, 0), runDirection: point(-1, 0), gasGhost: ghost('gas'), liquidGhost: ghost('liquid'),
    flip: false, orientationLocked: true, bendRadiusFactor: 1,
    target: { sourceId: 'host', segmentStart: point(-2000, 0), segmentEnd: point(4000, 0),
      segmentLengthMm: 6000, direction: point(1, 0), gasPoint: point(800, -20), liquidPoint: point(800, 20),
      gasOuterDiameterMm: 40, liquidOuterDiameterMm: 40, elevationMm: 2600, gasElevationMm: 2600, liquidElevationMm: 2600 },
  };
}

function port(x: number, rotation: number): RefrigerantPipeBundleConnection {
  const point = (px: number, py: number) => rotate({ x: px, y: py }, rotation);
  return {
    point: point(x, 1500), gasPoint: point(x, 1480), liquidPoint: point(x, 1520),
    gasFieldPoint: point(x, 1480), liquidFieldPoint: point(x, 1520), direction: point(1, 0),
    elevationMm: 2600, gasElevationMm: 2600, liquidElevationMm: 2600,
    connectionKind: 'unit-port', gasOuterDiameterMm: 40, liquidOuterDiameterMm: 40,
  };
}

function fixture(rotation = 0) {
  return { previous: proposal(rotation), previousPort: port(-1000, rotation),
    next: proposal(rotation), nextPort: port(0, rotation), settings };
}

function directBends(source: BranchKitProposal, sourcePort: RefrigerantPipeBundleConnection, station: Point2D): number {
  const route = getBranchKitApproachRouteOptions(source, sourcePort, settings);
  const options = { ...route, end: { x: route.end.x + station.x - source.teePoint.x,
    y: route.end.y + station.y - source.teePoint.y } };
  const points = buildOrthogonalConnectionRouteCandidates(options)[0];
  return points ? getOrthogonalConnectionRouteCost(points).bends : Infinity;
}

function withCatalogGhosts(source: BranchKitProposal): BranchKitProposal {
  const ghost = (lineKind: 'gas' | 'liquid'): BranchKitGhost => {
    const original = source[lineKind === 'gas' ? 'gasGhost' : 'liquidGhost'];
    const id = lineKind === 'gas' ? 'ac-branch-kit-dis-22-1g' : 'ac-branch-kit-dis-22-1g-liquid';
    const definition = DEFAULT_AC_EQUIPMENT_LIBRARY.find(item => item.id === id)!;
    const properties = { ...definition.defaultProperties, definitionId: id, branchKitRollDeg: 180,
      branchKitSnapSourceElementId: original.element.properties.branchKitSnapSourceElementId };
    const model = buildRefrigerantBranchKitViewModel({ ...original.element, subtype: definition.subtype, properties });
    const localAnchor = resolveRefrigerantBranchKitInlineAnchorLocal(model, lineKind);
    const rotatedAnchor = rotate(localAnchor, 180);
    const center = { x: original.stationPoint.x - rotatedAnchor.x, y: original.stationPoint.y - rotatedAnchor.y };
    const terminal = (role: 'inlet' | 'run-outlet' | 'branch-outlet') => resolveRefrigerantBranchKitConnectionIdentity({
      model, role, lineSelection: lineKind, worldCenter: center, rotationDeg: 180,
    })!;
    const takePoint = (role: 'inlet' | 'run-outlet' | 'branch-outlet') => terminal(role)[lineKind === 'gas' ? 'gasPoint' : 'liquidPoint'];
    return { ...original, center, rotationDeg: 180, inletPoint: takePoint('inlet'), runOutletPoint: takePoint('run-outlet'),
      branchOutletPoint: takePoint('branch-outlet'),
      branchOutletDirection: terminal('branch-outlet')[lineKind === 'gas' ? 'gasDirection' : 'liquidDirection'],
      element: { ...original.element, properties, rotation: 180, width: model.widthMm, depth: model.depthMm,
        position: { x: center.x - model.widthMm / 2, y: center.y - model.depthMm / 2 } } };
  };
  return { ...source, gasGhost: ghost('gas'), liquidGhost: ghost('liquid') };
}

describe('coordinated adjacent copper branch stations', () => {
  it.each([0, 90, 180, 270])('moves the previous pair upstream to reserve a direct next takeoff at %s degrees', rotation => {
    const options = fixture(rotation);
    const untouched = JSON.stringify(options);
    const candidates = coordinatedBranchApproachStations(options);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(4);
    const first = candidates[0]!;
    const previous = rotate(first.previousStation, -rotation);
    const next = rotate(first.nextStation, -rotation);
    expect(previous.x).toBeGreaterThan(800);
    expect(previous.y).toBe(0);
    expect(next.y).toBe(0);
    // Two 200 mm terminal reaches leave the full protected 300 mm straight.
    expect(previous.x - next.x).toBeCloseTo(700, 6);
    expect(directBends(options.previous, options.previousPort, first.previousStation)).toBe(2);
    expect(directBends(options.next, options.nextPort, first.nextStation)).toBe(2);
    expect(JSON.stringify(options)).toBe(untouched);
    // Before the preceding pair moves, the remaining split straight ends at
    // x=600; its largest fitting station x=100 cannot admit a direct takeoff.
    expect(directBends(options.next, options.nextPort, rotate({ x: 100, y: 0 }, rotation))).toBeGreaterThan(2);
  });

  it('uses the inlet side even when the original host endpoints are reversed', () => {
    const options = fixture();
    const expected = coordinatedBranchApproachStations(options);
    const reversed = { ...options, previous: { ...options.previous, target: { ...options.previous.target,
      segmentStart: options.previous.target.segmentEnd, segmentEnd: options.previous.target.segmentStart } } };
    expect(coordinatedBranchApproachStations(reversed)).toEqual(expected);
  });

  it('respects larger configured kit spacing and the original host end clearance', () => {
    const options = fixture();
    options.settings = { ...settings, minBranchKitSpacingMm: 1500 };
    const candidates = coordinatedBranchApproachStations(options);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.previousStation.x - candidate.nextStation.x).toBeGreaterThanOrEqual(1500 - 0.001);
      expect(candidate.previousStation.x).toBeLessThanOrEqual(3500);
      expect(candidate.nextStation.x).toBeGreaterThanOrEqual(-1500);
    }
  });

  it('returns no plan when moving the previous kit cannot fit within the original straight', () => {
    const options = fixture();
    options.previous.target.segmentEnd = { x: 1500, y: 0 };
    expect(coordinatedBranchApproachStations(options)).toEqual([]);
  });

  it('uses the same catalog spacing fallback as insertion when the configured spacing is zero', () => {
    const options = fixture();
    options.settings = { ...settings, minBranchKitSpacingMm: 0, defaultBranchKitClearanceMm: 0 };
    options.nextPort = port(1000, 0);
    for (const item of [options.previous, options.next]) for (const ghost of [item.gasGhost, item.liquidGhost]) {
      ghost.inletPoint.x = ghost.stationPoint.x + 50;
      ghost.runOutletPoint.x = ghost.stationPoint.x - 50;
    }
    const candidates = coordinatedBranchApproachStations(options);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.previousStation.x - candidates[0]!.nextStation.x)
      .toBeCloseTo(defaultMinBranchKitSpacingMm(options.settings), 6);
    expect(defaultMinBranchKitSpacingMm(options.settings)).toBeLessThan(DEFAULT_PIPE_ROUTING_SETTINGS.minBranchKitSpacingMm);
  });

  it('rejects a pair with conflicting inlet directions or a different host identity', () => {
    const reversed = fixture();
    [reversed.next.liquidGhost.inletPoint, reversed.next.liquidGhost.runOutletPoint]
      = [reversed.next.liquidGhost.runOutletPoint, reversed.next.liquidGhost.inletPoint];
    expect(coordinatedBranchApproachStations(reversed)).toEqual([]);
    const otherHost = fixture();
    otherHost.next.gasGhost.element.properties.branchKitSnapSourceElementId = 'another-system';
    expect(coordinatedBranchApproachStations(otherHost)).toEqual([]);
  });

  it('recovers a direct previous approach too when the previous station was folded', () => {
    const options = fixture();
    options.previousPort = port(500, 0);
    expect(directBends(options.previous, options.previousPort, options.previous.teePoint)).toBeGreaterThan(2);
    const candidates = coordinatedBranchApproachStations(options);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(candidate => directBends(options.previous, options.previousPort, candidate.previousStation) <= 2)).toBe(true);
  });

  it('reserves both real DIS catalog socket footprints, including their unequal service lengths', () => {
    const options = fixture();
    options.previous = withCatalogGhosts(options.previous);
    options.next = withCatalogGhosts(options.next);
    const candidates = coordinatedBranchApproachStations(options);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const previousShift = candidate.previousStation.x - options.previous.teePoint.x;
      const nextShift = candidate.nextStation.x - options.next.teePoint.x;
      for (const key of ['gasGhost', 'liquidGhost'] as const) {
        const previousOutlet = options.previous[key].runOutletPoint.x + previousShift;
        const nextInlet = options.next[key].inletPoint.x + nextShift;
        expect(previousOutlet - nextInlet).toBeGreaterThanOrEqual(settings.defaultBranchKitClearanceMm - 1e-6);
      }
      expect(directBends(options.previous, options.previousPort, candidate.previousStation)).toBeLessThanOrEqual(2);
      expect(directBends(options.next, options.nextPort, candidate.nextStation)).toBeLessThanOrEqual(2);
    }
  });
});
