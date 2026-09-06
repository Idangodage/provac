import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';

import {
  buildBranchKitInsertion,
  buildBranchKitRoutePreview,
  buildTeeRunHalves,
  proposeBranchKit,
  type BranchKitProposal,
} from './branchKitProposal';
import { findNewNetworkPipeClashes } from './networkPipeClearance';
import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import {
  DEFAULT_PIPE_ROUTING_SETTINGS,
  setActivePipeRoutingSettings,
} from './pipeRoutingSettings';
import { buildRefrigerantBranchKitViewModel } from './refrigerantBranchKitModel';
import {
  buildRefrigerantPipeElements,
  getRefrigerantPipeBundleSnapTargets,
  resolveRefrigerantPipeBranchKitReconnectionUpdates,
  type RefrigerantPipeConnection,
  type RefrigerantPipeBundleConnection,
} from './refrigerantPipePairModel';

function makeGasRun(): HvacElement {
  return {
    id: 'gas-run-1',
    type: 'refrigerant-pipe',
    position: { x: 0, y: 0 },
    rotation: 0,
    width: 1,
    depth: 1,
    height: 1,
    elevation: 2800 - 66.675 / 2,
    mountType: 'ceiling',
    label: 'Gas Pipe',
    supplyZoneRatio: 0.5,
    properties: {
      lineKind: 'gas',
      bundleId: 'orig-bundle',
      routePoints: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ],
      startConnection: { kind: 'start' },
      endConnection: { kind: 'end' },
    },
  } as HvacElement;
}

const props = (el: HvacElement) => el.properties as Record<string, unknown>;

describe('buildTeeRunHalves', () => {
  it('splits a run at the station into run-in / run-out and clears the cut-end connection', () => {
    const halves = buildTeeRunHalves(makeGasRun(), { x: 400, y: 0 }, 'tee-1');
    expect(halves).not.toBeNull();
    const [runIn, runOut] = halves!;

    // run-in: original start … tee. Keeps the start connection, clears the (cut) end.
    expect(props(runIn).routePoints).toEqual([{ x: 0, y: 0 }, { x: 400, y: 0 }]);
    expect(props(runIn).startConnection).toEqual({ kind: 'start' });
    expect(props(runIn).endConnection).toBeNull();
    expect(props(runIn).teeRole).toBe('run-in');
    expect(props(runIn).teeId).toBe('tee-1');
    expect(props(runIn).bundleId).toBe('tee-1-in');

    // run-out: tee … original end. Clears the (cut) start, keeps the end connection.
    expect(props(runOut).routePoints).toEqual([{ x: 400, y: 0 }, { x: 1000, y: 0 }]);
    expect(props(runOut).startConnection).toBeNull();
    expect(props(runOut).endConnection).toEqual({ kind: 'end' });
    expect(props(runOut).teeRole).toBe('run-out');
    expect(props(runOut).bundleId).toBe('tee-1-out');
  });

  it('gives each half a fresh, distinct id (never reuses the original run id)', () => {
    const run = makeGasRun();
    const [runIn, runOut] = buildTeeRunHalves(run, { x: 400, y: 0 }, 'tee-1')!;
    expect(runIn.id).not.toBe(run.id);
    expect(runOut.id).not.toBe(run.id);
    expect(runIn.id).not.toBe(runOut.id);
  });

  it('returns null when the station resolves to an endpoint (nothing to split off)', () => {
    expect(buildTeeRunHalves(makeGasRun(), { x: 0, y: 0 }, 'tee-1')).toBeNull();
  });

  it.each([
    { materials: ['hard', 'hard', 'hard'], before: ['hard', 'hard'], after: ['hard', 'hard'] },
    { materials: ['flexible', 'flexible', 'flexible'], before: ['flexible', 'flexible'], after: ['flexible', 'flexible'] },
    { materials: ['flexible', 'hard', 'flexible'], before: ['flexible', 'hard'], after: ['hard', 'flexible'] },
  ])('preserves host material ownership when splitting $materials', ({ materials, before, after }) => {
    const run = makeGasRun();
    run.properties.routePoints = [0, 1000, 2000, 3000].map(x => ({ x, y: 0 }));
    run.properties.segmentMaterials = materials;
    const halves = buildTeeRunHalves(run, { x: 1500, y: 0 }, 'tee-materials');
    expect(halves).not.toBeNull();
    expect(halves![0].properties.segmentMaterials).toEqual(before);
    expect(halves![1].properties.segmentMaterials).toEqual(after);
  });
});

function makeLiquidRun(): HvacElement {
  const gas = makeGasRun();
  return {
    ...gas,
    id: 'liquid-run-1',
    label: 'Liquid Pipe',
    elevation: 2600 - 60.325 / 2,
    properties: {
      ...gas.properties,
      lineKind: 'liquid',
      pipeDiameterMm: 9.525,
      bundleId: 'orig-liquid-bundle',
      routePoints: [
        { x: 0, y: 40 },
        { x: 1000, y: 40 },
      ],
    },
  };
}

function proposalKitElement(
  lineKind: 'gas' | 'liquid',
  sourceElementId: string,
): Omit<HvacElement, 'id'> {
  return {
    type: 'refrigerant-branch-kit',
    category: 'accessory',
    subtype: lineKind === 'gas' ? 'dis-22-1g-gas' : 'dis-22-1g-liquid',
    modelLabel: lineKind === 'gas' ? 'DIS-22-1G Gas' : 'DIS-22-1G Liquid',
    position: { x: 300, y: lineKind === 'gas' ? -80 : -40 },
    rotation: 0,
    width: 442,
    depth: 180,
    height: 90,
    elevation: 2600,
    mountType: 'ceiling',
    label: `${lineKind} branch kit`,
    supplyZoneRatio: 0.5,
    properties: {
      branchKitType: 'dis-22-1g',
      branchKitLineKind: lineKind,
      branchKitPlacementMode: 'inline-pipe-run',
      branchKitSnapSourceElementId: sourceElementId,
    },
  };
}

function validProposal(): BranchKitProposal {
  return {
    connectionType: 'indoor-to-branch',
    validity: 'valid',
    violations: [],
    score: 0,
    teePoint: { x: 400, y: 20 },
    runDirection: { x: 1, y: 0 },
    gasGhost: {
      lineKind: 'gas',
      element: proposalKitElement('gas', 'gas-run-1'),
      center: { x: 400, y: 0 },
      rotationDeg: 0,
      stationPoint: { x: 400, y: 0 },
      inletPoint: { x: 300, y: 0 },
      runOutletPoint: { x: 500, y: 0 },
      branchOutletPoint: { x: 400, y: 180 },
      branchOutletDirection: { x: 0, y: 1 },
      outerDiameterMm: 28,
      nudged: false,
    },
    liquidGhost: {
      lineKind: 'liquid',
      element: proposalKitElement('liquid', 'liquid-run-1'),
      center: { x: 400, y: 40 },
      rotationDeg: 0,
      stationPoint: { x: 400, y: 40 },
      inletPoint: { x: 300, y: 40 },
      runOutletPoint: { x: 500, y: 40 },
      branchOutletPoint: { x: 400, y: 220 },
      branchOutletDirection: { x: 0, y: 1 },
      outerDiameterMm: 22,
      nudged: false,
    },
    target: {
      sourceId: 'orig-pair',
      segmentStart: { x: 0, y: 20 },
      segmentEnd: { x: 1000, y: 20 },
      segmentLengthMm: 1000,
      direction: { x: 1, y: 0 },
      gasPoint: { x: 400, y: 0 },
      liquidPoint: { x: 400, y: 40 },
      gasOuterDiameterMm: 28,
      liquidOuterDiameterMm: 22,
      elevationMm: 2600,
      gasElevationMm: 2800,
      liquidElevationMm: 2600,
    },
    flip: false,
  };
}

const indoorStartBundle: RefrigerantPipeBundleConnection = {
  point: { x: 400, y: 4000 },
  gasPoint: { x: 360, y: 4000 },
  liquidPoint: { x: 440, y: 4000 },
  gasFieldPoint: { x: 360, y: 4000 },
  liquidFieldPoint: { x: 440, y: 4000 },
  gasDirection: { x: 0, y: -1 },
  liquidDirection: { x: 0, y: -1 },
  direction: { x: 0, y: -1 },
  elevationMm: 2700,
  gasElevationMm: 2800,
  liquidElevationMm: 2600,
  connectionKind: 'unit-port',
  sourceElementId: 'indoor-1',
};

function makeFlowHostScene(reverse: boolean, length = 2400): HvacElement[] {
  const outdoor: HvacElement = {
    id: 'outdoor-1',
    type: 'outdoor-unit',
    category: 'outdoor-unit',
    position: { x: -300, y: -200 },
    rotation: 0,
    width: 300,
    depth: 400,
    height: 1000,
    elevation: 1800,
    mountType: 'floor',
    label: 'VRF outdoor unit',
    supplyZoneRatio: 0.5,
    properties: {},
  };
  const bundle = getRefrigerantPipeBundleSnapTargets([outdoor])[0]!;
  const pipes = buildRefrigerantPipeElements([bundle.point, { x: length, y: bundle.point.y }], {
    startBundleConnection: bundle, bundleId: 'host-pair',
  }).map(built => {
    const properties = built.properties!;
    const routePoints = properties.routePoints as Array<{ x: number; y: number }>;
    return {
      ...built,
      id: `host-${properties.lineKind}`,
      rotation: 0,
      properties: {
        ...properties,
        routePoints: reverse ? [...routePoints].reverse() : routePoints,
        startConnection: reverse ? null : properties.startConnection,
        endConnection: reverse ? properties.startConnection : null,
      },
    } as HvacElement;
  });
  return [outdoor, ...pipes];
}

describe('branch-kit proposal flow orientation', () => {
  beforeEach(() => {
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  });

  it.each([false, true])(
    'keeps the fitting inlet facing the outdoor unit when host authoring is reversed=%s',
    (reverse) => {
      const scene = makeFlowHostScene(reverse);
      const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 1200, y: 30 });

      expect(proposal).not.toBeNull();
      expect(proposal!.gasGhost.inletPoint.x).toBeLessThan(proposal!.gasGhost.stationPoint.x);
      expect(proposal!.liquidGhost.inletPoint.x).toBeLessThan(
        proposal!.liquidGhost.stationPoint.x,
      );

      const flipped = proposeBranchKit(scene, indoorStartBundle, { x: 1200, y: 30 }, {
        flip: true,
      });
      expect(flipped).not.toBeNull();
      expect(flipped!.flip).toBe(false);
      expect(flipped!.gasGhost.inletPoint).toEqual(proposal!.gasGhost.inletPoint);
      expect(flipped!.gasGhost.runOutletPoint).toEqual(proposal!.gasGhost.runOutletPoint);
    },
  );

  it('rolls the copper Y-joints toward either side without reversing outdoor flow', () => {
    const scene = makeFlowHostScene(false, 5000);
    const below = proposeBranchKit(scene, indoorStartBundle, { x: 2200, y: 30 })!;
    const aboveStart: RefrigerantPipeBundleConnection = {
      ...indoorStartBundle,
      point: { x: 400, y: -4000 },
      gasPoint: { x: 360, y: -4000 },
      liquidPoint: { x: 440, y: -4000 },
      gasFieldPoint: { x: 360, y: -4000 },
      liquidFieldPoint: { x: 440, y: -4000 },
      gasDirection: { x: 0, y: 1 },
      liquidDirection: { x: 0, y: 1 },
      direction: { x: 0, y: 1 },
      sourceElementId: 'indoor-above',
    };
    const above = proposeBranchKit(scene, aboveStart, { x: 2200, y: 30 })!;

    for (const [proposal, start] of [[below, indoorStartBundle], [above, aboveStart]] as const) {
      expect(proposal.validity, proposal.violations.join(' ')).not.toBe('invalid');
      for (const ghost of [proposal.gasGhost, proposal.liquidGhost]) {
        expect(ghost.inletPoint.x).toBeLessThan(ghost.stationPoint.x);
        expect(Math.sign(ghost.branchOutletPoint.y - ghost.stationPoint.y)).toBe(
          Math.sign(start.point.y - proposal.teePoint.y),
        );
      }
      expect(buildBranchKitInsertion(proposal, start, scene)).not.toBeNull();
    }
    expect(below.gasGhost.element.properties.branchKitRollDeg).not.toBe(
      above.gasGhost.element.properties.branchKitRollDeg,
    );
    expect(below.liquidGhost.element.properties.branchKitRollDeg).not.toBe(
      above.liquidGhost.element.properties.branchKitRollDeg,
    );
  });

  it('keeps the requested takeoff side on a rotated main without floating-point roll flips', () => {
    const rotationDeg = 5;
    const radians = rotationDeg * Math.PI / 180;
    const rotate = (point: { x: number; y: number }) => ({
      x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
      y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
    });
    const scene = makeFlowHostScene(false, 5000).map((element) => {
      if (element.type !== 'refrigerant-pipe') return element;
      const routePoints = (element.properties.routePoints as Array<{ x: number; y: number }>).map(rotate);
      const rotateConnection = (value: unknown) => {
        if (!value || typeof value !== 'object') return value;
        const connection = value as Record<string, unknown>;
        return {
          ...connection,
          ...(connection.portPoint ? { portPoint: rotate(connection.portPoint as { x: number; y: number }) } : {}),
          ...(connection.direction ? { direction: rotate(connection.direction as { x: number; y: number }) } : {}),
        };
      };
      return {
        ...element,
        properties: {
          ...element.properties,
          routePoints,
          routeNodes3d: routePoints.map((point) => ({ ...point, z: element.elevation })),
          startConnection: rotateConnection(element.properties.startConnection),
          endConnection: rotateConnection(element.properties.endConnection),
        },
      };
    });
    const cursor = rotate({ x: 2200, y: 30 });
    const starts = [
      indoorStartBundle,
      {
        ...indoorStartBundle,
        point: { x: 400, y: -4000 },
        sourceElementId: 'indoor-opposite',
      },
    ].map((start) => ({
      ...start,
      point: rotate(start.point),
      gasPoint: rotate(start.gasPoint),
      liquidPoint: rotate(start.liquidPoint),
      gasFieldPoint: rotate(start.gasFieldPoint),
      liquidFieldPoint: rotate(start.liquidFieldPoint),
      direction: rotate(start.direction),
      gasDirection: rotate(start.gasDirection ?? start.direction),
      liquidDirection: rotate(start.liquidDirection ?? start.direction),
    }));

    for (const start of starts) {
      const proposal = proposeBranchKit(scene, start, cursor)!;
      expect(proposal).not.toBeNull();
      expect(proposal.orientationLocked).toBe(true);
      for (const ghost of [proposal.gasGhost, proposal.liquidGhost]) {
        const run = proposal.runDirection;
        const branchSide = run.x * (ghost.branchOutletPoint.y - ghost.stationPoint.y)
          - run.y * (ghost.branchOutletPoint.x - ghost.stationPoint.x);
        const requestedSide = run.x * (start.point.y - proposal.teePoint.y)
          - run.y * (start.point.x - proposal.teePoint.x);
        expect(Math.sign(branchSide)).toBe(Math.sign(requestedSide));
        expect((ghost.stationPoint.x - ghost.inletPoint.x) * run.x
          + (ghost.stationPoint.y - ghost.inletPoint.y) * run.y).toBeGreaterThan(0);
      }
    }
  });

  it('faces the final authored approach across the main from the indoor unit without reversing outdoor flow', () => {
    const scene = makeFlowHostScene(false, 5000);
    // The indoor unit is below the main. The authored route deliberately goes
    // around its open end and returns from above, without crossing either host.
    const authoredRoute = [
      indoorStartBundle.point,
      { x: 400, y: 2000 },
      { x: 6000, y: 2000 },
      { x: 6000, y: -2000 },
      { x: 3000, y: -2000 },
      { x: 3000, y: -1000 },
    ];
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 2200, y: 30 }, { authoredRoute });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join(' ')).not.toBe('invalid');
    expect(proposal!.orientationLocked).toBe(true);
    for (const ghost of [proposal!.gasGhost, proposal!.liquidGhost]) {
      expect(ghost.inletPoint.x).toBeLessThan(ghost.stationPoint.x);
      expect(ghost.runOutletPoint.x).toBeGreaterThan(ghost.stationPoint.x);
      expect(ghost.branchOutletPoint.y).toBeLessThan(ghost.stationPoint.y);
      expect(indoorStartBundle.point.y).toBeGreaterThan(ghost.stationPoint.y);
    }
    const insertion = buildBranchKitInsertion(
      proposal!, indoorStartBundle, scene, [...authoredRoute, proposal!.teePoint],
    );
    expect(insertion).not.toBeNull();
    expect(findNewNetworkPipeClashes(
      scene, [...(insertion!.updates ?? []), ...insertion!.elementsToAdd], insertion!.removeElementIds,
    )).toEqual([]);
    const branches = insertion!.elementsToAdd.filter(element => element.properties.routeClass === 'indoor-connection');
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.properties.authoredCenterlineRoute).toEqual(expect.arrayContaining([
        { x: 6000, y: 2000 }, { x: 6000, y: -2000 }, { x: 3000, y: -1000 },
      ]));
    }
  });

  it('preserves an atomic real-tee split for a reverse-authored host', () => {
    const scene = makeFlowHostScene(true);
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 1200, y: 30 })!;
    expect(proposal.validity, proposal.violations.join(' ')).not.toBe('invalid');
    const insertion = buildBranchKitInsertion(proposal, indoorStartBundle, scene)!;
    expect(insertion).not.toBeNull();

    expect(new Set(insertion.removeElementIds)).toEqual(
      new Set(['host-gas', 'host-liquid']),
    );
    const gasRunIn = insertion.elementsToAdd.find((element) =>
      element.properties.lineKind === 'gas' && element.properties.teeRole === 'run-in')!;
    expect(gasRunIn.properties.startConnection).toMatchObject({ terminalRole: 'inlet' });
    expect(gasRunIn.properties.endConnection).toMatchObject({
      connectionKind: 'unit-port',
      sourceElementId: 'outdoor-1',
    });
    // The new takeoff must fit the indoor sockets as well as the existing
    // outdoor main, without rescuing a small height mismatch with a ramp.
    for (const element of insertion.elementsToAdd.filter(element => element.type === 'refrigerant-pipe')) {
      const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < nodes.length; i += 1) {
        const a = nodes[i - 1]!; const b = nodes[i]!;
        expect(Math.abs(a.z - b.z) < 1e-6 || Math.hypot(a.x - b.x, a.y - b.y) < 1e-6).toBe(true);
      }
    }
  });
});

describe('buildBranchKitInsertion compliance defaults', () => {
  beforeEach(() => {
    setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS);
  });

  it('replaces both tapped host lines with real run-in/run-out halves by default', () => {
    const scene = [makeGasRun(), makeLiquidRun()];
    const insertion = buildBranchKitInsertion(validProposal(), indoorStartBundle, scene);

    expect(insertion).not.toBeNull();
    expect(new Set(insertion!.removeElementIds)).toEqual(
      new Set(['gas-run-1', 'liquid-run-1']),
    );
    const splitHalves = insertion!.elementsToAdd.filter((element) =>
      element.properties.teeRole === 'run-in' || element.properties.teeRole === 'run-out',
    );
    expect(splitHalves).toHaveLength(4);
    const kits = insertion!.elementsToAdd.filter(
      (element) => element.type === 'refrigerant-branch-kit',
    );
    expect(kits).toHaveLength(2);
    expect(kits.every((kit) => kit.properties.branchKitPlacementMode === 'fixed')).toBe(true);
  });

  it('cuts out the fitting body and binds all three physical terminals', () => {
    const insertion = buildBranchKitInsertion(
      validProposal(),
      indoorStartBundle,
      [makeGasRun(), makeLiquidRun()],
    )!;
    const split = insertion.elementsToAdd.filter((element) =>
      element.properties.teeRole === 'run-in' || element.properties.teeRole === 'run-out');
    const gasIn = split.find((element) =>
      element.properties.lineKind === 'gas' && element.properties.teeRole === 'run-in')!;
    const gasOut = split.find((element) =>
      element.properties.lineKind === 'gas' && element.properties.teeRole === 'run-out')!;
    const gasKit = insertion.elementsToAdd.find((element) =>
      element.type === 'refrigerant-branch-kit'
      && element.properties.branchKitLineKind === 'gas')!;

    expect((gasIn.properties.routePoints as Array<{ x: number; y: number }>).at(-1)).toEqual({
      x: 300,
      y: 0,
    });
    expect((gasOut.properties.routePoints as Array<{ x: number; y: number }>)[0]).toEqual({
      x: 500,
      y: 0,
    });
    expect(gasIn.properties.endConnection).toMatchObject({
      sourceElementId: gasKit.id,
      terminalRole: 'inlet',
      portPoint: { x: 300, y: 0 },
    });
    expect(gasOut.properties.startConnection).toMatchObject({
      sourceElementId: gasKit.id,
      terminalRole: 'run-outlet',
      portPoint: { x: 500, y: 0 },
    });

    const document = buildVrfDocumentFromHvacElements(insertion.elementsToAdd);
    expect(Object.values(document.branchKits)).toHaveLength(2);
    for (const component of Object.values(document.branchKits)) {
      expect(document.routeNodes[component.inletNodeIds[0]!]!.connectedEdgeIds).toHaveLength(1);
      expect(document.routeNodes[component.outletNodeIds[0]!]!.connectedEdgeIds).toHaveLength(1);
      expect(document.routeNodes[component.outletNodeIds[1]!]!.connectedEdgeIds).toHaveLength(1);
      expect(component.hostRunIds).toHaveLength(2);
      expect(component.branchRunIds).toHaveLength(1);
    }
  });

  it('moves a bound fitting endpoint in both the plan and canonical 3D route', () => {
    const insertion = buildBranchKitInsertion(
      validProposal(),
      indoorStartBundle,
      [makeGasRun(), makeLiquidRun()],
    )!;
    const gasKit = insertion.elementsToAdd.find((element) =>
      element.type === 'refrigerant-branch-kit'
      && element.properties.branchKitLineKind === 'gas')!;
    const gasIn = insertion.elementsToAdd.find((element) =>
      element.properties.lineKind === 'gas' && element.properties.teeRole === 'run-in')!;
    const route = gasIn.properties.routePoints as Array<{ x: number; y: number }>;
    const gasIn3d: HvacElement = {
      ...gasIn,
      properties: {
        ...gasIn.properties,
        routeNodes3d: route.map((point) => ({ ...point, z: 2600 })),
      },
    };
    const scene = insertion.elementsToAdd.map((element) =>
      element.id === gasIn.id ? gasIn3d : element);
    const movedKit: HvacElement = {
      ...gasKit,
      position: { x: gasKit.position.x, y: gasKit.position.y + 120 },
    };

    const update = resolveRefrigerantPipeBranchKitReconnectionUpdates(scene, movedKit)
      .find((candidate) => candidate.id === gasIn.id)!;
    const properties = update.updates.properties as Record<string, unknown>;
    const connection = properties.endConnection as {
      portPoint: { x: number; y: number };
      elevationMm: number;
    };
    const routePoints = properties.routePoints as Array<{ x: number; y: number }>;
    const routeNodes3d = properties.routeNodes3d as Array<{ x: number; y: number; z: number }>;
    expect(routePoints.at(-1)).toEqual(connection.portPoint);
    expect(routeNodes3d.at(-1)).toEqual({
      ...connection.portPoint,
      z: connection.elevationMm,
    });
  });
});

describe('coordinated branch layout', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  const guideSegments = (element: HvacElement) => {
    const guide = element.properties.authoredCenterlineRoute as Array<{ x: number; y: number }>;
    const segments = guide.slice(1).map((point, index) => ({
      x: point.x - guide[index]!.x,
      y: point.y - guide[index]!.y,
    })).filter((segment) => Math.hypot(segment.x, segment.y) > 1e-6);
    return segments.map((segment) => {
      const length = Math.hypot(segment.x, segment.y);
      return { x: segment.x / length, y: segment.y / length };
    });
  };

  const guideBendCount = (element: HvacElement) => {
    const segments = guideSegments(element);
    return segments.slice(1).filter((segment, index) =>
      segment.x * segments[index]!.x + segment.y * segments[index]!.y < 1 - 1e-6,
    ).length;
  };

  it.each([-1, 1])('uses two elbows for sockets facing the same side with lateral offset %s', (side) => {
    const proposal = validProposal();
    const outletY = 500 + side * 1000;
    proposal.gasGhost = { ...proposal.gasGhost,
      branchOutletPoint: { x: 1800, y: outletY - 40 }, branchOutletDirection: { x: 1, y: 0 } };
    proposal.liquidGhost = { ...proposal.liquidGhost,
      branchOutletPoint: { x: 1800, y: outletY + 40 }, branchOutletDirection: { x: 1, y: 0 } };
    const start = { ...indoorStartBundle, point: { x: 0, y: 500 },
      gasPoint: { x: 0, y: 460 }, gasFieldPoint: { x: 0, y: 460 },
      liquidPoint: { x: 0, y: 540 }, liquidFieldPoint: { x: 0, y: 540 },
      direction: { x: 1, y: 0 }, gasDirection: { x: 1, y: 0 }, liquidDirection: { x: 1, y: 0 } };
    const preview = buildBranchKitRoutePreview(proposal, start);

    expect(preview).toHaveLength(2);
    for (const pipe of preview) {
      const segments = guideSegments(pipe);
      expect(guideBendCount(pipe)).toBe(2);
      expect(segments[0]).toEqual({ x: 1, y: 0 });
      expect(segments.at(-1)).toEqual({ x: -1, y: 0 });
      expect(segments.filter((segment) => Math.abs(segment.y) > 1e-6)).toEqual([{ x: 0, y: side }]);
      const guide = pipe.properties.authoredCenterlineRoute as Array<{ x: number; y: number }>;
      expect(Math.max(...guide.map((point) => point.x)) - 1800)
        .toBeGreaterThanOrEqual(DEFAULT_PIPE_ROUTING_SETTINGS.defaultBranchKitClearanceMm);
    }
  });

  it.each([-1, 1])('turns at an authored waypoint without extending it into an S-shaped tail on side %s', (side) => {
    const proposal = validProposal();
    const outletY = 500 + side * 1000;
    proposal.gasGhost = { ...proposal.gasGhost,
      branchOutletPoint: { x: 1800, y: outletY - 40 }, branchOutletDirection: { x: 1, y: 0 } };
    proposal.liquidGhost = { ...proposal.liquidGhost,
      branchOutletPoint: { x: 1800, y: outletY + 40 }, branchOutletDirection: { x: 1, y: 0 } };
    const start = { ...indoorStartBundle, point: { x: 0, y: 500 },
      gasPoint: { x: 0, y: 460 }, gasFieldPoint: { x: 0, y: 460 },
      liquidPoint: { x: 0, y: 540 }, liquidFieldPoint: { x: 0, y: 540 },
      direction: { x: 1, y: 0 }, gasDirection: { x: 1, y: 0 }, liquidDirection: { x: 1, y: 0 } };
    const waypoint = { x: 3000, y: 500 };
    const preview = buildBranchKitRoutePreview(proposal, start, [start.point, waypoint, proposal.teePoint]);

    expect(preview).toHaveLength(2);
    for (const pipe of preview) {
      const guide = pipe.properties.authoredCenterlineRoute as Array<{ x: number; y: number }>;
      expect(guide).toContainEqual(waypoint);
      expect(guideBendCount(pipe)).toBe(2);
      expect(Math.max(...guide.map((point) => point.x))).toBeLessThanOrEqual(waypoint.x + 1e-6);
      expect(guideSegments(pipe).filter((segment) => Math.abs(segment.y) > 1e-6)).toEqual([{ x: 0, y: side }]);
    }
  });

  it.each([-1, 1])('commits the simple authored two-elbow connection shown by the real branch preview on side %s', (side) => {
    const scene = makeFlowHostScene(false, 5000);
    const startY = side * 4000;
    const start: RefrigerantPipeBundleConnection = {
      ...indoorStartBundle, point: { x: 0, y: startY },
      gasPoint: { x: 0, y: startY - 40 }, gasFieldPoint: { x: 0, y: startY - 40 },
      liquidPoint: { x: 0, y: startY + 40 }, liquidFieldPoint: { x: 0, y: startY + 40 },
      direction: { x: 1, y: 0 }, gasDirection: { x: 1, y: 0 }, liquidDirection: { x: 1, y: 0 },
    };
    const waypoint = { x: 3500, y: startY };
    const proposal = proposeBranchKit(scene, start, { x: 2200, y: 30 }, {
      authoredRoute: [start.point, waypoint],
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join(' ')).not.toBe('invalid');
    const route = [start.point, waypoint, proposal!.teePoint];
    const preview = buildBranchKitRoutePreview(proposal!, start, route);
    const insertion = buildBranchKitInsertion(proposal!, start, scene, route);
    expect(insertion).not.toBeNull();
    const branches = insertion!.elementsToAdd.filter((element) => element.properties.routeClass === 'indoor-connection');
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      const ghost = preview.find((element) => element.properties.lineKind === branch.properties.lineKind)!;
      expect(branch.properties.authoredCenterlineRoute).toContainEqual(waypoint);
      expect(guideBendCount(branch)).toBe(2);
      expect(ghost.properties.routePoints).toEqual(branch.properties.routePoints);
      expect(ghost.properties.routeNodes3d).toEqual(branch.properties.routeNodes3d);
    }
  });

  it('uses two plan elbows when facing sockets have room for their straight approaches', () => {
    const proposal = validProposal();
    proposal.gasGhost = { ...proposal.gasGhost, branchOutletPoint: { x: 1800, y: 1460 }, branchOutletDirection: { x: -1, y: 0 } };
    proposal.liquidGhost = { ...proposal.liquidGhost, branchOutletPoint: { x: 1800, y: 1540 }, branchOutletDirection: { x: -1, y: 0 } };
    const start = { ...indoorStartBundle, point: { x: 0, y: 500 },
      gasPoint: { x: 0, y: 460 }, gasFieldPoint: { x: 0, y: 460 },
      liquidPoint: { x: 0, y: 540 }, liquidFieldPoint: { x: 0, y: 540 },
      direction: { x: 1, y: 0 }, gasDirection: { x: 1, y: 0 }, liquidDirection: { x: 1, y: 0 } };
    const preview = buildBranchKitRoutePreview(proposal, start);
    const guide = preview[0]!.properties.authoredCenterlineRoute as Array<{x:number;y:number}>;
    expect(guide).toHaveLength(4);
    expect(guide[1]!.y).toBe(500);
    expect(guide[2]!.y).toBe(1500);
    expect(guide[1]!.x).toBe(guide[2]!.x);
    expect(guide[1]!.x).toBeGreaterThan(150);
    expect(1800 - guide[2]!.x).toBeGreaterThanOrEqual(DEFAULT_PIPE_ROUTING_SETTINGS.defaultBranchKitClearanceMm);
  });

  it('keeps both fittings at the same safe station when their lengths differ', () => {
    const proposal = proposeBranchKit(makeFlowHostScene(false), indoorStartBundle, { x: 350, y: 30 })!;
    expect(proposal.validity).toBe('needs-nudge');
    expect(proposal.gasGhost.stationPoint.x).toBeCloseTo(proposal.liquidGhost.stationPoint.x, 6);
    for (const ghost of [proposal.gasGhost, proposal.liquidGhost]) {
      expect(Math.min(ghost.inletPoint.x, ghost.runOutletPoint.x)).toBeGreaterThanOrEqual(
        DEFAULT_PIPE_ROUTING_SETTINGS.defaultBranchKitClearanceMm - 1e-6,
      );
    }
  });

  it('recovers on the same physical hosts when the hovered straight is too short for fitting clearance', () => {
    const scene = [makeGasRun(), makeLiquidRun()].map(element => {
      const y = element.properties.lineKind === 'gas' ? 0 : 40;
      return { ...element, properties: {
        ...element.properties, bundleId: 'recovery-main', networkLevelLocked: true,
        startConnection: null, endConnection: null,
        routePoints: [{ x: 0, y }, { x: 600, y }, { x: 600, y: y + 120 }, { x: 4000, y: y + 120 }],
      } };
    });
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 400, y: 20 }, { proposalRadiusMm: 180 });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join(' ')).toBe('needs-nudge');
    expect(proposal!.teePoint.x).toBeGreaterThan(600);
    expect(proposal!.gasGhost.element.properties.branchKitSnapSourceElementId).toBe('gas-run-1');
    expect(proposal!.liquidGhost.element.properties.branchKitSnapSourceElementId).toBe('liquid-run-1');
    const insertion = buildBranchKitInsertion(proposal!, indoorStartBundle, scene);
    expect(insertion).not.toBeNull();
    expect(new Set(insertion!.removeElementIds)).toEqual(new Set(['gas-run-1', 'liquid-run-1']));
  });

  it('puts fixed fitting terminal centerlines on their own host elevations', () => {
    const scene = makeFlowHostScene(false).map((element) => element.type === 'refrigerant-pipe'
      ? { ...element, elevation: element.properties.lineKind === 'gas' ? 2720 : 2610 }
      : element);
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 1200, y: 30 })!;
    for (const ghost of [proposal.gasGhost, proposal.liquidGhost]) {
      const model = buildRefrigerantBranchKitViewModel(ghost.element);
      const line = ghost.lineKind === 'gas' ? model.gas : model.liquid;
      expect(ghost.element.elevation + line.centerlineZMm).toBeCloseTo(
        ghost.lineKind === 'gas' ? proposal.target.gasElevationMm : proposal.target.liquidElevationMm, 6,
      );
    }
    expect(proposal.orientationLocked).toBe(true);
    expect(proposal.selectionStatus).toBe('layout-only');
  });

  it('rejects a pair whose persisted gas and liquid outdoor sides disagree', () => {
    const scene = makeFlowHostScene(false).map((element) => element.id === 'host-liquid'
      ? { ...element, properties: {
          ...element.properties,
          startConnection: null,
          endConnection: { ...(element.properties.startConnection as object), portPoint: { x: 2400, y: 60 } },
        } }
      : element);
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 1200, y: 30 })!;
    expect(proposal.validity).toBe('invalid');
    expect(proposal.violations[0]).toContain('opposite outdoor sides');
    expect(buildBranchKitInsertion(proposal, indoorStartBundle, scene)).toBeNull();
  });

  it('moves socket bodies clear of an indoor unit and rejects a fully obstructed main', () => {
    const scene = makeFlowHostScene(false);
    const baseline = proposeBranchKit(scene, indoorStartBundle, { x: 1200, y: 30 })!;
    const outlet = baseline.gasGhost.runOutletPoint;
    const unit: HvacElement = {
      ...scene[0]!, id: 'clearance-obstacle', type: 'wall-mounted-ac', category: 'indoor-unit',
      position: { x: outlet.x - 20, y: outlet.y - 20 }, width: 40, depth: 40, rotation: 35,
    };
    const proposal = proposeBranchKit([...scene, unit], indoorStartBundle, { x: 1200, y: 30 })!;
    expect(proposal.validity, proposal.violations.join(' ')).toBe('needs-nudge');
    const rotation = unit.rotation * Math.PI / 180;
    const clearance = DEFAULT_PIPE_ROUTING_SETTINGS.defaultUnitClearanceMm;
    const unitLeft = unit.position.x + unit.width / 2
      - (unit.width / 2 + clearance) * Math.cos(rotation)
      - (unit.depth / 2 + clearance) * Math.sin(rotation);
    // The original station is outside the clearance envelope, but its socket
    // is inside. Recovery must clear the complete fitting, not just its tee.
    expect(baseline.teePoint.x).toBeLessThan(unitLeft);
    expect(outlet.x).toBeGreaterThan(unitLeft);
    for (const ghost of [proposal.gasGhost, proposal.liquidGhost]) {
      expect(ghost.rotationDeg).toBe(0);
      expect(ghost.center.x + ghost.element.width / 2).toBeLessThan(unitLeft);
    }
    expect(buildBranchKitInsertion(proposal, indoorStartBundle, [...scene, unit])).not.toBeNull();

    const blockedUnit = { ...unit, position: { x: 0, y: -200 }, width: 2400, depth: 400, rotation: 0 };
    const blocked = proposeBranchKit([...scene, blockedUnit], indoorStartBundle, { x: 1200, y: 30 })!;
    expect(blocked.validity).toBe('invalid');
    expect(blocked.violations[0]).toContain('clearance zone');
    expect(buildBranchKitInsertion(blocked, indoorStartBundle, [...scene, blockedUnit])).toBeNull();
  });

  it('rejects a preview that became obstructed before acceptance', () => {
    const scene = makeFlowHostScene(false);
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 1200, y: 30 })!;
    expect(proposal.validity, proposal.violations.join(' ')).not.toBe('invalid');
    expect(buildBranchKitInsertion(proposal, indoorStartBundle, scene)).not.toBeNull();

    const staleObstacle: HvacElement = {
      ...scene[0]!,
      id: 'late-indoor-obstacle',
      type: 'ceiling-cassette-ac',
      category: 'indoor-unit',
      position: { x: proposal.gasGhost.center.x - 200, y: proposal.gasGhost.center.y - 200 },
      width: 400,
      depth: 400,
      properties: {},
    };
    expect(buildBranchKitInsertion(proposal, indoorStartBundle, [...scene, staleObstacle])).toBeNull();
  });

  it('rejects an incomplete or stale host replacement without emitting a decorative connection', () => {
    expect(buildBranchKitInsertion(validProposal(), indoorStartBundle, [makeGasRun()])).toBeNull();
    expect(buildBranchKitInsertion(validProposal(), indoorStartBundle, [])).toBeNull();
    const changedLiquid = makeLiquidRun();
    changedLiquid.properties.routePoints = [{ x: 0, y: 140 }, { x: 1000, y: 140 }];
    expect(buildBranchKitInsertion(validProposal(), indoorStartBundle, [makeGasRun(), changedLiquid])).toBeNull();
  });

  it('preserves authored detours and uses identical preview and committed branch geometry', () => {
    const proposal = validProposal();
    const start = {
      ...indoorStartBundle, point: { x: 400, y: 1400 },
      gasPoint: { x: 390, y: 1400 }, gasFieldPoint: { x: 390, y: 1400 },
      liquidPoint: { x: 410, y: 1400 }, liquidFieldPoint: { x: 410, y: 1400 },
    };
    const route = [start.point, { x: 400, y: 900 }, { x: 900, y: 900 }, { x: 900, y: 20 }];
    const preview = buildBranchKitRoutePreview(proposal, start, route);
    const repeated = buildBranchKitRoutePreview(proposal, start, route);
    expect(preview.map((element) => element.id)).toEqual(repeated.map((element) => element.id));
    const insertion = buildBranchKitInsertion(proposal, start, [makeGasRun(), makeLiquidRun()], route)!;
    const branches = insertion.elementsToAdd.filter((element) => element.properties.routeClass === 'indoor-connection');
    expect(branches).toHaveLength(2);
    expect(branches[0]!.properties.bundleId).toBe(branches[1]!.properties.bundleId);
    for (const branch of branches) {
      const ghost = preview.find((element) => element.properties.lineKind === branch.properties.lineKind)!;
      expect(ghost.properties.routePoints).toEqual(branch.properties.routePoints);
      const points = branch.properties.routePoints as Array<{ x: number; y: number }>;
      expect(Math.max(...points.map((point) => point.x))).toBeGreaterThan(800);
    }
  });
});

describe('nearest feasible station on a paired main', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  const straightMain = (): HvacElement[] => [makeGasRun(), makeLiquidRun()].map(element => {
    const gas = element.properties.lineKind === 'gas';
    const y = gas ? 0 : 40;
    const z = gas ? 2800 : 2600;
    return { ...element, properties: {
      ...element.properties, bundleId: 'station-search-main', networkLevelLocked: true,
      startConnection: null, endConnection: null,
      routePoints: [{ x: 0, y }, { x: 8000, y }],
      routeNodes3d: [{ x: 0, y, z }, { x: 8000, y, z }],
    } };
  });

  it('keeps the requested station when a clean approach avoids an unrelated pipe crossing', () => {
    const main = makeFlowHostScene(false, 8000);
    const baseline = proposeBranchKit(main, indoorStartBundle, { x: 4000, y: 20 })!;
    const gasZ = baseline.target.gasElevationMm;
    const obstacle: HvacElement = {
      ...makeGasRun(), id: 'unrelated-crossing', position: { x: 3000, y: -1000 },
      properties: {
        ...makeGasRun().properties, bundleId: 'unrelated-system', networkLevelLocked: true,
        startConnection: null, endConnection: null,
        routePoints: [{ x: 3000, y: -1000 }, { x: 3000, y: 1000 }],
        routeNodes3d: [{ x: 3000, y: -1000, z: gasZ }, { x: 3000, y: 1000, z: gasZ }],
      },
    };
    const scene = [...main, obstacle];
    // The preserved main already crosses this pipe. A clean socket approach
    // can now avoid adding another clash without moving the requested kit.
    const feasible = proposeBranchKit(scene, indoorStartBundle, { x: 1800, y: 20 });
    expect(feasible?.validity, feasible?.violations.join(' ')).not.toBe('invalid');
    expect(feasible).not.toBeNull();
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 4000, y: 20 });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join(' ')).toBe('valid');
    expect(proposal!.teePoint.x).toBeCloseTo(4000, 5);
    expect(proposal!.gasGhost.element.properties.branchKitSnapSourceElementId).toBe('host-gas');
    expect(proposal!.liquidGhost.element.properties.branchKitSnapSourceElementId).toBe('host-liquid');
    const insertion = buildBranchKitInsertion(proposal!, indoorStartBundle, scene);
    expect(insertion).not.toBeNull();
    expect(new Set(insertion!.removeElementIds)).toEqual(new Set(['host-gas', 'host-liquid']));
    expect(findNewNetworkPipeClashes(scene,
      [...(insertion!.updates ?? []), ...insertion!.elementsToAdd], insertion!.removeElementIds)).toEqual([]);
  });

  it('searches beyond both failed one-step nudges when nearby fitting stations are physically obstructed', () => {
    const main = makeFlowHostScene(false, 8000);
    const obstacle: HvacElement = {
      ...main[0]!, id: 'equipment-enclosure', type: 'ducted-ac', category: 'indoor-unit',
      position: { x: 3000, y: -300 }, rotation: 0, width: 4000, depth: 600,
      elevation: 0, height: 4000, properties: {},
    };
    const scene = [...main, obstacle];
    for (const x of [3700, 4000, 4300]) {
      const blocked = proposeBranchKit(scene, indoorStartBundle, { x, y: 20 }, { maxRecoveryStations: 0 });
      expect(blocked).not.toBeNull();
      expect(blocked!.validity).toBe('invalid');
      expect(blocked!.failureReason).toBe('station');
    }
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 4000, y: 20 })!;
    expect(proposal.validity, proposal.violations.join(' ')).toBe('needs-nudge');
    expect(proposal.teePoint.x).toBeLessThan(3000);
    expect(proposal.gasGhost.element.properties.branchKitSnapSourceElementId).toBe('host-gas');
    expect(proposal.liquidGhost.element.properties.branchKitSnapSourceElementId).toBe('host-liquid');
    const insertion = buildBranchKitInsertion(proposal, indoorStartBundle, scene);
    expect(insertion).not.toBeNull();
    expect(new Set(insertion!.removeElementIds)).toEqual(new Set(['host-gas', 'host-liquid']));
    expect(findNewNetworkPipeClashes(scene,
      [...(insertion!.updates ?? []), ...insertion!.elementsToAdd], insertion!.removeElementIds)).toEqual([]);
  });

  it('chooses the nearer feasible side instead of the first direction searched', () => {
    const main = makeFlowHostScene(false, 8000);
    const cursor = { x: 1400, y: 20 };
    const baseline = proposeBranchKit(main, indoorStartBundle, cursor)!;
    expect(baseline.validity, baseline.violations.join(' ')).not.toBe('invalid');
    const ghosts = [baseline.gasGhost, baseline.liquidGhost];
    const leftReach = Math.min(...ghosts.map(ghost => ghost.center.x - ghost.element.width / 2 - cursor.x));
    const minY = Math.min(...ghosts.map(ghost => ghost.center.y - ghost.element.depth / 2));
    const maxY = Math.max(...ghosts.map(ghost => ghost.center.y + ghost.element.depth / 2));
    const obstacle: HvacElement = {
      ...makeGasRun(), id: 'asymmetric-clearance', type: 'wall-mounted-ac', category: 'indoor-unit',
      position: { x: cursor.x + 149 + leftReach, y: minY - 10 },
      width: 1, depth: maxY - minY + 20, properties: {},
    };
    const scene = [...main, obstacle];
    // Both coarse directions have a valid station, but the right clearance
    // boundary is about 250 mm away and the left boundary almost 500 mm away.
    for (const x of [900, 1900]) {
      const control = proposeBranchKit(scene, indoorStartBundle, { x, y: cursor.y });
      expect(control).not.toBeNull();
      expect(control!.validity, control!.violations.join(' ')).not.toBe('invalid');
    }
    const proposal = proposeBranchKit(scene, indoorStartBundle, cursor)!;
    expect(proposal.validity, proposal.violations.join(' ')).toBe('needs-nudge');
    expect(proposal.teePoint.x).toBeGreaterThan(cursor.x);
    expect(proposal.teePoint.x - cursor.x).toBeLessThan(350);
    expect(proposeBranchKit(scene, indoorStartBundle, cursor)!.teePoint).toEqual(proposal.teePoint);
    expect(buildBranchKitInsertion(proposal, indoorStartBundle, scene)).not.toBeNull();
  });

  it('recovers around a bend with both fittings on the same actual straight and physical hosts', () => {
    const scene = straightMain().map(element => {
      const gas = element.properties.lineKind === 'gas';
      const y = gas ? 0 : 40;
      const x = gas ? 600 : 640;
      const z = gas ? 2800 : 2600;
      const routePoints = [{ x: 0, y }, { x, y }, { x, y: 4000 }];
      return { ...element, properties: {
        ...element.properties, routePoints, routeNodes3d: routePoints.map(point => ({ ...point, z })),
      } };
    });
    const control = proposeBranchKit(scene, indoorStartBundle, { x: 620, y: 1800 }, { proposalRadiusMm: 180 });
    expect(control).not.toBeNull();
    expect(control!.validity, control!.violations.join(' ')).not.toBe('invalid');
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 550, y: 20 }, { proposalRadiusMm: 180 });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join(' ')).toBe('needs-nudge');
    expect(proposal!.runDirection.x).toBeCloseTo(0, 6);
    expect(Math.abs(proposal!.runDirection.y)).toBeCloseTo(1, 6);
    expect(proposal!.gasGhost.stationPoint.x).toBeCloseTo(600, 6);
    expect(proposal!.liquidGhost.stationPoint.x).toBeCloseTo(640, 6);
    expect(proposal!.gasGhost.stationPoint.y).toBeCloseTo(proposal!.liquidGhost.stationPoint.y, 6);
    for (const ghost of [proposal!.gasGhost, proposal!.liquidGhost]) {
      expect(ghost.inletPoint.x).toBeCloseTo(ghost.stationPoint.x, 6);
      expect(ghost.runOutletPoint.x).toBeCloseTo(ghost.stationPoint.x, 6);
    }
    const insertion = buildBranchKitInsertion(proposal!, indoorStartBundle, scene);
    expect(insertion).not.toBeNull();
    expect(new Set(insertion!.removeElementIds)).toEqual(new Set(['gas-run-1', 'liquid-run-1']));
  });

  it('recovers from a straight shorter than the fitting to a later usable leg', () => {
    const scene = straightMain().map((element) => {
      const gas = element.properties.lineKind === 'gas';
      const y = gas ? 0 : 40;
      const x = gas ? 2300 : 2340;
      const z = gas ? 2800 : 2600;
      const routePoints = [{ x: 2000, y }, { x, y }, { x, y: 4000 }];
      return { ...element, properties: {
        ...element.properties,
        routePoints,
        routeNodes3d: routePoints.map((point) => ({ ...point, z })),
      } };
    });
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 2250, y: 20 }, {
      proposalRadiusMm: 180,
    });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join(' ')).toBe('needs-nudge');
    expect(Math.abs(proposal!.runDirection.y)).toBeCloseTo(1, 6);
    expect(proposal!.gasGhost.stationPoint.x).toBeCloseTo(2300, 6);
    expect(proposal!.liquidGhost.stationPoint.x).toBeCloseTo(2340, 6);
    expect(buildBranchKitInsertion(proposal!, indoorStartBundle, scene)).not.toBeNull();
  });
});

function networkBranchStart(id = 'new-indoor', x = 4500): RefrigerantPipeBundleConnection {
  return {
    ...indoorStartBundle, sourceElementId: id,
    point: { x, y: 5000 }, gasPoint: { x: x - 40, y: 5000 }, liquidPoint: { x: x + 40, y: 5000 },
    gasFieldPoint: { x: x - 40, y: 5000 }, liquidFieldPoint: { x: x + 40, y: 5000 },
    gasOuterDiameterMm: 80, liquidOuterDiameterMm: 70,
    elevationMm: 2400, gasElevationMm: 2400, liquidElevationMm: 2400,
  };
}

function networkBranchScene(): HvacElement[] {
  const scene = makeFlowHostScene(false, 12000).map(element => element.type === 'refrigerant-pipe' ? {
    ...element,
    properties: {
      ...element.properties,
      endConnection: {
        connectionKind: 'field-pipe', sourceElementId: `tail-${element.properties.lineKind}`,
        nodeId: `join-${element.properties.lineKind}`, portPoint: (element.properties.routePoints as Array<{x:number;y:number}>).at(-1)!,
        direction: { x: -1, y: 0 }, elevationMm: (element.properties.startConnection as RefrigerantPipeConnection).elevationMm,
      },
    },
  } : element);
  const tails = scene.filter(element => element.type === 'refrigerant-pipe').map(element => {
    const end = element.properties.endConnection as RefrigerantPipeConnection;
    return {
    ...element, id: `tail-${element.properties.lineKind}`, position: { x: 12000, y: end.portPoint.y }, width: 6000,
    properties: { ...element.properties, bundleId: 'tail-pair',
      routePoints: [end.portPoint, { x: 18000, y: end.portPoint.y }],
      startConnection: { connectionKind: 'field-pipe', sourceElementId: element.id,
        nodeId: `join-${element.properties.lineKind}`, portPoint: end.portPoint,
        direction: { x: 1, y: 0 }, elevationMm: end.elevationMm }, endConnection: null },
  }; });
  const unrelated: HvacElement = {
    ...tails[0]!, id: 'unrelated-run', position: { x: 30000, y: 30000 },
    properties: { ...tails[0]!.properties, bundleId: 'unrelated', startConnection: null, endConnection: null,
      routePoints: [{ x: 30000, y: 30000 }, { x: 36000, y: 30000 }] },
  };
  return [...scene, ...tails, unrelated];
}

function applyBranchInsertion(scene: HvacElement[], insertion: NonNullable<ReturnType<typeof buildBranchKitInsertion>>): HvacElement[] {
  const updates = new Map((insertion.updates ?? []).map(element => [element.id, element]));
  const removed = new Set(insertion.removeElementIds);
  return [...scene.filter(element => !removed.has(element.id)).map(element => updates.get(element.id) ?? element), ...insertion.elementsToAdd];
}

describe('branch insertion coordinates the connected network levels', () => {
  beforeEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it('commits exact fitting levels and monotonic branch profiles without automatic bypasses', () => {
    const scene = networkBranchScene();
    const start = networkBranchStart();
    const proposal = proposeBranchKit(scene, start, { x: 4500, y: 30 });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join(' ')).not.toBe('invalid');
    const insertion = buildBranchKitInsertion(proposal!, start, scene);
    expect(insertion).not.toBeNull();
    const branches = insertion!.elementsToAdd.filter(element => element.properties.routeClass === 'indoor-connection');
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      const service = branch.properties.lineKind as 'gas' | 'liquid';
      const expectedZ = service === 'gas' ? proposal!.target.gasElevationMm : proposal!.target.liquidElevationMm;
      const nodes = normalizePipeRouteNodes3d(branch.properties.routeNodes3d);
      expect(branch.properties.bypasses ?? []).toEqual([]);
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      expect(nodes[0]!.z).toBeCloseTo(2400, 6);
      expect(nodes.at(-1)!.z).toBeCloseTo(expectedZ, 6);
      const changes = nodes.slice(1).map((node, index) => Math.sign(node.z - nodes[index]!.z)).filter(Boolean);
      expect(new Set(changes).size).toBeLessThanOrEqual(1);
      const connection = branch.properties.endConnection as RefrigerantPipeConnection;
      const kit = insertion!.elementsToAdd.find(element => element.id === connection.sourceElementId)!;
      const model = buildRefrigerantBranchKitViewModel(kit);
      expect(kit.elevation + model[service].centerlineZMm).toBeCloseTo(expectedZ, 6);
      expect(connection.elevationMm).toBeCloseTo(expectedZ, 6);
    }
    for (const host of insertion!.elementsToAdd.filter(element => element.properties.teeRole)) {
      const nodes = normalizePipeRouteNodes3d(host.properties.routeNodes3d);
      for (const [key, index] of [['startConnection', 0], ['endConnection', nodes.length - 1]] as const) {
        const connection = host.properties[key] as RefrigerantPipeConnection | null;
        if (connection?.terminalRole) expect(nodes[index]!.z).toBeCloseTo(connection.elevationMm, 6);
      }
    }
  });

  it('updates connected surviving runs atomically and leaves unrelated geometry unchanged', () => {
    const scene = networkBranchScene();
    const start = networkBranchStart();
    const proposal = proposeBranchKit(scene, start, { x: 4500, y: 30 })!;
    const insertion = buildBranchKitInsertion(proposal, start, scene)!;
    expect(insertion).not.toBeNull();
    expect(insertion.updates?.map(element => element.id)).toEqual(expect.arrayContaining(['tail-gas', 'tail-liquid']));
    expect(insertion.updates?.some(element => element.id === 'unrelated-run')).toBe(false);
    expect(insertion.updates?.some(element => insertion.removeElementIds.includes(element.id))).toBe(false);
    const applied = applyBranchInsertion(scene, insertion);
    expect(applied.find(element => element.id === 'unrelated-run')).toBe(scene.find(element => element.id === 'unrelated-run'));
    for (const tail of applied.filter(element => element.id.startsWith('tail-'))) {
      expect(tail.properties.networkLevelPlan).toMatchObject({ generated: true });
      const corridor = tail.properties.lineKind === 'gas' ? proposal.target.gasElevationMm : proposal.target.liquidElevationMm;
      expect(normalizePipeRouteNodes3d(tail.properties.routeNodes3d).every(node => Math.abs(node.z - corridor) < 0.001)).toBe(true);
    }
  });

  it('keeps the established service tiers when adding another indoor branch', () => {
    const scene = networkBranchScene();
    const start = networkBranchStart();
    const first = proposeBranchKit(scene, start, { x: 4500, y: 30 })!;
    const firstInsertion = buildBranchKitInsertion(first, start, scene)!;
    const connected = applyBranchInsertion(scene, firstInsertion);
    const nextStart = networkBranchStart('second-indoor', 8500);
    const second = proposeBranchKit(connected, nextStart, { x: 8500, y: 30 });
    expect(second).not.toBeNull();
    expect(second!.validity, second!.violations.join(' ')).not.toBe('invalid');
    expect(second!.target.gasElevationMm).toBeCloseTo(first.target.gasElevationMm, 6);
    expect(second!.target.liquidElevationMm).toBeCloseTo(first.target.liquidElevationMm, 6);
    const secondInsertion = buildBranchKitInsertion(second!, nextStart, connected);
    expect(secondInsertion).not.toBeNull();
    const oldKits = connected.filter(element => element.type === 'refrigerant-branch-kit');
    const twice = applyBranchInsertion(connected, secondInsertion!);
    for (const kit of oldKits) expect(twice.find(element => element.id === kit.id)!.elevation).toBeCloseTo(kit.elevation, 6);
  });

  it('rejects acceptance after a connected surviving run changes since the preview', () => {
    const scene = networkBranchScene();
    const start = networkBranchStart();
    const proposal = proposeBranchKit(scene, start, { x: 4500, y: 30 })!;
    const changed = scene.map(element => element.id === 'tail-gas'
      ? { ...element, elevation: element.elevation + 100 } : element);
    expect(buildBranchKitInsertion(proposal, start, changed)).toBeNull();
  });

  it('moves to a compatible locked plateau instead of altering the hovered level', () => {
    const scene = networkBranchScene().map(element => element.id === 'host-gas' ? {
      ...element,
      properties: { ...element.properties, startConnection: null, endConnection: null,
        networkLevelLocked: true, routeNodes3d: [
          { x: 0, y: 0, z: 2500 }, { x: 6000, y: 0, z: 2500 },
          { x: 6500, y: 0, z: 2750 }, { x: 12000, y: 0, z: 2750 },
        ] },
    } : element);
    const start = networkBranchStart();
    const proposal = proposeBranchKit(scene, start, { x: 3500, y: 30 });
    expect(proposal).not.toBeNull();
    expect(proposal!.validity, proposal!.violations.join(' ')).toBe('needs-nudge');
    expect(proposal!.teePoint.x).toBeGreaterThan(6500);
    expect(proposal!.target.gasElevationMm).toBeCloseTo(2750, 6);
    expect(buildBranchKitInsertion(proposal!, start, scene)).not.toBeNull();
    expect((scene.find(element => element.id === 'host-gas')!.properties.routeNodes3d as Array<{ z: number }>)[0]!.z).toBe(2500);
  });
});
