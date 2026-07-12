import { beforeEach, describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../vrf/domain';

import {
  buildBranchKitInsertion,
  buildTeeRunHalves,
  proposeBranchKit,
  type BranchKitProposal,
} from './branchKitProposal';
import {
  DEFAULT_PIPE_ROUTING_SETTINGS,
  setActivePipeRoutingSettings,
} from './pipeRoutingSettings';
import {
  resolveRefrigerantPipeBranchKitReconnectionUpdates,
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
    elevation: 2600,
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
});

function makeLiquidRun(): HvacElement {
  const gas = makeGasRun();
  return {
    ...gas,
    id: 'liquid-run-1',
    label: 'Liquid Pipe',
    properties: {
      ...gas.properties,
      lineKind: 'liquid',
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
      gasElevationMm: 2600,
      liquidElevationMm: 2600,
    },
    flip: false,
  };
}

const indoorStartBundle: RefrigerantPipeBundleConnection = {
  point: { x: 400, y: 700 },
  gasPoint: { x: 390, y: 700 },
  liquidPoint: { x: 410, y: 700 },
  gasFieldPoint: { x: 390, y: 700 },
  liquidFieldPoint: { x: 410, y: 700 },
  gasDirection: { x: 0, y: -1 },
  liquidDirection: { x: 0, y: -1 },
  direction: { x: 0, y: -1 },
  elevationMm: 2600,
  gasElevationMm: 2600,
  liquidElevationMm: 2600,
  connectionKind: 'unit-port',
  sourceElementId: 'indoor-1',
};

function makeFlowHostScene(reverse: boolean): HvacElement[] {
  const outdoor: HvacElement = {
    id: 'outdoor-1',
    type: 'outdoor-unit',
    category: 'outdoor-unit',
    position: { x: -300, y: -200 },
    rotation: 0,
    width: 300,
    depth: 400,
    height: 1000,
    elevation: 0,
    mountType: 'floor',
    label: 'VRF outdoor unit',
    supplyZoneRatio: 0.5,
    properties: {},
  };
  const makePipe = (lineKind: 'gas' | 'liquid', y: number): HvacElement => {
    const left = { x: 0, y };
    const right = { x: 2400, y };
    const routePoints = reverse ? [right, left] : [left, right];
    const outdoorConnection = {
      connectionKind: 'unit-port' as const,
      sourceElementId: outdoor.id,
      portPoint: left,
      direction: { x: 1, y: 0 },
      elevationMm: 2600,
    };
    return {
      id: `host-${lineKind}`,
      type: 'refrigerant-pipe',
      position: { x: 0, y },
      rotation: 0,
      width: 2400,
      depth: 1,
      height: 1,
      elevation: 2600,
      mountType: 'ceiling',
      label: `${lineKind} host`,
      supplyZoneRatio: 0.5,
      properties: {
        lineKind,
        bundleId: 'host-pair',
        routePoints,
        pipeDiameterMm: lineKind === 'gas' ? 28 : 22,
        outerDiameterMm: lineKind === 'gas' ? 28 : 22,
        insulationThicknessMm: 0,
        startConnection: reverse ? null : outdoorConnection,
        endConnection: reverse ? outdoorConnection : null,
      },
    } as HvacElement;
  };
  return [outdoor, makePipe('gas', 0), makePipe('liquid', 60)];
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

  it('preserves an atomic real-tee split for a reverse-authored host', () => {
    const scene = makeFlowHostScene(true);
    const proposal = proposeBranchKit(scene, indoorStartBundle, { x: 1200, y: 30 })!;
    const insertion = buildBranchKitInsertion(proposal, indoorStartBundle, scene)!;

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
