import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { resolveCopperSocketElbow } from '../copperSocketElbows';
import { designWithNodePositions, readPipeDesign, writePipeDesign } from '../pipeDesignModel';
import type { PipeRouteNode3D } from '../pipeRoute3d';
import { resolveRefrigerantPipeSpec } from '../refrigerantPipePairModel';

import {
  neighbourPiece,
  pieceMidpoint,
  refrigerantLineOf,
  refrigerantPieceAtModelPoint,
  refrigerantPieceAtPlanPoint,
  refrigerantPieceEnds,
  refrigerantPieceOf,
  refrigerantPieceOutline,
} from './refrigerantPieces';

const pipe = (properties: Record<string, unknown>, overrides: Partial<HvacElement> = {}): HvacElement => ({
  id: 'pipe-1',
  type: 'refrigerant-pipe',
  label: 'Gas Pipe',
  position: { x: 0, y: 0 },
  width: 100, depth: 100, height: 50,
  elevation: 2000, rotation: 0,
  mountType: 'ceiling', supplyZoneRatio: 0,
  properties: { lineKind: 'gas', pipeDiameterMm: 15.88, outerDiameterMm: 65.88, insulationThicknessMm: 25, ...properties },
  ...overrides,
} as unknown as HvacElement);

/** 2 m along x, up 600, 3 m along y: straight, bend, riser, bend, straight. */
const ROUTE: PipeRouteNode3D[] = [
  { x: 0, y: 0, z: 2600 }, { x: 2000, y: 0, z: 2600 }, { x: 2000, y: 0, z: 3200 }, { x: 2000, y: 3000, z: 3200 },
];

const routed = (nodes: PipeRouteNode3D[], extra: Record<string, unknown> = {}, overrides: Partial<HvacElement> = {}) => pipe({
  routePoints: nodes.map(({ x, y }) => ({ x, y })),
  routeNodes3d: nodes,
  segmentMaterials: nodes.slice(1).map(() => 'hard'),
  ...extra,
}, overrides);

describe('the pieces of a refrigerant line', () => {
  it('lists straights, risers and bends in path order, keyed on the design', () => {
    const element = routed(ROUTE);
    const line = refrigerantLineOf(element, [element])!;
    const design = readPipeDesign(element, [element]);
    expect(line.pieces.map((piece) => piece.kind)).toEqual(['straight', 'bend', 'riser', 'bend', 'straight']);
    expect(line.pieces.map((piece) => piece.key)).toEqual([
      `leg:${design.legs[0]!.id}`, `joint:${design.joints[0]!.id}`, `leg:${design.legs[1]!.id}`, `joint:${design.joints[1]!.id}`, `leg:${design.legs[2]!.id}`,
    ]);
    expect(line.pieces.map((piece) => piece.ordinal)).toEqual([1, 1, 1, 2, 2]);
    expect(line.lineKind).toBe('gas');
    expect(line.halfWidthMm).toBeCloseTo(resolveRefrigerantPipeSpec(element.properties).outerDiameterMm / 2, 6);
  });

  it('trims a straight where the elbows either side take over, and gives the elbow its catalogue part', () => {
    const element = routed(ROUTE);
    const line = refrigerantLineOf(element, [element])!;
    const elbow = resolveCopperSocketElbow(15.88, 90)!;
    const [first, bend] = line.pieces;
    expect(first!.lengthMm).toBeCloseTo(2000 - elbow.centerToFaceMm, 3);
    expect(bend!.catalogueModel).toBe(elbow.catalogueModel);
    expect(bend!.radiusMm).toBeCloseTo(elbow.centerlineRadiusMm, 6);
    expect(bend!.angleDeg).toBeCloseTo(90, 3);
    // The bend runs from where the straight stops to where the riser starts.
    expect(bend!.path[0]!.x).toBeCloseTo(first!.path[1]!.x, 3);
    const riser = line.pieces[2]!;
    expect(bend!.path[bend!.path.length - 1]!.z).toBeCloseTo(riser.path[0]!.z, 3);
  });

  it('draws a formed bend\'s arc at the bend radius when the line uses formed tube', () => {
    const element = routed(ROUTE, { fieldBendConstruction: 'formed-tube' });
    const line = refrigerantLineOf(element, [element])!;
    const bend = line.pieces[1]!;
    expect(bend.catalogueModel).toBeNull();
    const corner = ROUTE[1]!;
    // Every arc point stands one radius from the arc's centre: the corner moved in by R on both legs.
    const centre = { x: corner.x - bend.radiusMm!, y: 0, z: corner.z + bend.radiusMm! };
    for (const point of bend.path.slice(1, -1)) {
      expect(Math.hypot(point.x - centre.x, point.y - centre.y, point.z - centre.z)).toBeCloseTo(bend.radiusMm!, 1);
    }
  });

  it('keeps every key across a resize and a raise once the design is written', () => {
    const element = writePipeDesign(routed(ROUTE), readPipeDesign(routed(ROUTE)));
    const keys = refrigerantLineOf(element, [element])!.pieces.map((piece) => piece.key);
    const resized = { ...element, properties: { ...element.properties, pipeDiameterMm: 19.05, outerDiameterMm: 69.05 } };
    expect(refrigerantLineOf(resized, [resized])!.pieces.map((piece) => piece.key)).toEqual(keys);
    const design = readPipeDesign(element);
    const raised = writePipeDesign(element, designWithNodePositions(design, design.nodes.map((node, index) => ({ ...node, z: node.z + (index >= 2 ? 100 : 0) }))));
    expect(refrigerantLineOf(raised, [raised])!.pieces.map((piece) => piece.key)).toEqual(keys);
  });

  it('gives a unit port its stub as a piece of its own, the straight starting after it', () => {
    const element = routed(ROUTE, {
      startConnection: { connectionKind: 'unit-port', sourceElementId: 'odu', portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2600 },
    });
    const unit = { ...pipe({}), id: 'odu', type: 'outdoor-unit', label: 'ODU' } as HvacElement;
    const scene = [unit, element];
    const line = refrigerantLineOf(element, scene)!;
    const design = readPipeDesign(element, scene);
    expect(design.ports.start.kind).toBe('unit-port');
    const stub = line.pieces[0]!;
    expect(stub.key).toBe('port:start');
    expect(stub.kind).toBe('port');
    expect(stub.lengthMm).toBeCloseTo(design.ports.start.straightApproachMm.value, 3);
    expect(line.pieces[1]!.path[0]!.x).toBeCloseTo(stub.path[1]!.x, 3);
  });

  it('finds the piece under a plan point: a straight on its run, the riser at its corner', () => {
    const element = routed(ROUTE);
    const line = refrigerantLineOf(element, [element])!;
    expect(refrigerantPieceAtPlanPoint(line, { x: 800, y: 10 })?.kind).toBe('straight');
    expect(refrigerantPieceAtPlanPoint(line, { x: 2000, y: 0 })?.kind).toBe('riser');
    expect(refrigerantPieceAtPlanPoint(line, { x: 1000, y: 500 })).toBeNull();
    expect(refrigerantPieceAtModelPoint(line, { x: 2000, y: 20, z: 2900 })?.kind).toBe('riser');
    expect(refrigerantPieceAtModelPoint(line, { x: 2010, y: 1500, z: 3210 })?.key).toBe(line.pieces[4]!.key);
  });

  it('outlines a straight as a band of the line\'s width, a riser as a disc, and brackets only the straight', () => {
    const element = routed(ROUTE);
    const line = refrigerantLineOf(element, [element])!;
    const straight = line.pieces[0]!;
    const band = refrigerantPieceOutline(line, straight);
    const ys = band.map((point) => point.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * line.halfWidthMm, 3);
    const disc = refrigerantPieceOutline(line, line.pieces[2]!);
    for (const point of disc) expect(Math.hypot(point.x - 2000, point.y)).toBeCloseTo(line.halfWidthMm, 3);
    expect(refrigerantPieceEnds(line, straight)).toHaveLength(2);
    expect(refrigerantPieceEnds(line, line.pieces[2]!)).toHaveLength(0);
  });

  it('steps along the line, and finds a piece by key', () => {
    const element = routed(ROUTE);
    const line = refrigerantLineOf(element, [element])!;
    expect(neighbourPiece(line, line.pieces[1]!.key, 1)?.key).toBe(line.pieces[2]!.key);
    expect(neighbourPiece(line, line.pieces[0]!.key, -1)).toBeNull();
    expect(refrigerantPieceOf(line, line.pieces[3]!.key)).toBe(line.pieces[3]);
    const mid = pieceMidpoint(line.pieces[0]!);
    expect(mid.x).toBeCloseTo(line.pieces[0]!.lengthMm / 2, 3);
  });

  it('has no pieces for anything but a refrigerant line', () => {
    const unit = { ...routed(ROUTE), type: 'outdoor-unit' } as HvacElement;
    expect(refrigerantLineOf(unit, [unit])).toBeNull();
  });
});
