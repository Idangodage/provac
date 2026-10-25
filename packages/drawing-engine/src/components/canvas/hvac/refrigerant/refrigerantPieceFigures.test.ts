import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../../vrf/domain';
import { PROJECT_FALLBACK_RULE_PROFILE, type ManufacturerRuleProfile, type RuleValue } from '../../../../vrf/rules';
import { getRefrigerantPipeBundleSnapTargets, resolveRefrigerantPipeSpec } from '../refrigerantPipePairModel';

import { copperInchLabel, copperSizeText, refrigerantCircuitFigures, refrigerantPieceFigures } from './refrigerantPieceFigures';
import { refrigerantLineOf } from './refrigerantPieces';

interface Point3 { x: number; y: number; z: number }
const verified = (value: number): RuleValue<number> => ({ value, verified: true, source: 'manufacturer-model', sourceReference: 'test' });

/** An outdoor unit and a cassette 4 m apart, joined by a gas and a liquid line on their ports (as refrigerantChangeValidation's tests). */
function circuit(length = 4000): HvacElement[] {
  const unit = (id: string, outdoor: boolean, x: number): HvacElement => ({
    id, type: outdoor ? 'outdoor-unit' : 'ceiling-cassette-ac', category: outdoor ? 'outdoor-unit' : 'indoor-unit',
    label: id, position: { x, y: 0 }, rotation: 0, width: 600, depth: 600, height: 300,
    elevation: 2400, mountType: 'ceiling', supplyZoneRatio: 0.5, properties: {},
  });
  const outdoor = unit('odu', true, 0);
  const indoor = unit('idu', false, length);
  const equipment = [outdoor, indoor];
  const initial = getRefrigerantPipeBundleSnapTargets(equipment);
  indoor.elevation += initial.find((port) => port.sourceElementId === outdoor.id)!.gasElevationMm!
    - initial.find((port) => port.sourceElementId === indoor.id)!.gasElevationMm!;
  const ports = getRefrigerantPipeBundleSnapTargets(equipment);
  const a = ports.find((port) => port.sourceElementId === outdoor.id)!;
  const b = ports.find((port) => port.sourceElementId === indoor.id)!;
  const pipes = (['gas', 'liquid'] as const).map((line) => {
    const start = { ...a[line === 'gas' ? 'gasPoint' : 'liquidPoint']!, z: a[line === 'gas' ? 'gasElevationMm' : 'liquidElevationMm']! };
    const end = { ...b[line === 'gas' ? 'gasPoint' : 'liquidPoint']!, z: b[line === 'gas' ? 'gasElevationMm' : 'liquidElevationMm']! };
    const connection = (elementId: string, point: Point3) => ({ connectionKind: 'unit-port', sourceElementId: elementId,
      portPoint: { x: point.x, y: point.y }, elevationMm: point.z, direction: { x: 1, y: 0 } });
    return {
      id: line, label: line, type: 'refrigerant-pipe', position: { x: start.x, y: start.y }, rotation: 0,
      width: length, depth: 30, height: 30, elevation: start.z - 15, mountType: 'ceiling', supplyZoneRatio: 0.5,
      properties: { lineKind: line, pipeDiameterMm: line === 'gas' ? 15.88 : 9.52, insulationThicknessMm: 25,
        routePoints: [start, end].map(({ x, y }) => ({ x, y })), routeNodes3d: [start, end], bendRadiusFactor: 4,
        startConnection: connection(outdoor.id, start), endConnection: connection(indoor.id, end) },
    } satisfies HvacElement;
  });
  const scene = [...equipment, ...pipes];
  const document = buildVrfDocumentFromHvacElements(scene);
  return scene.map((element) => {
    const run = document.pipeRuns[element.id];
    if (!run) return element;
    const nodes = [document.routeNodes[run.nodeIds[0]!]!.position, document.routeNodes[run.nodeIds.at(-1)!]!.position];
    return { ...element, properties: { ...element.properties, routeNodes3d: nodes } };
  });
}

/** The gas line hopped 400 mm up over its middle: four bends and two risers. */
function hopped(scene: HvacElement[], extra: Record<string, unknown> = {}): HvacElement[] {
  return scene.map((element) => {
    if (element.id !== 'gas') return element;
    const previous = element.properties.routeNodes3d as Point3[];
    const a = previous[0]!;
    const b = previous.at(-1)!;
    const at = (t: number, rise = 0) => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), z: a.z + t * (b.z - a.z) + rise });
    const nodes = [a, at(0.25), at(0.25, 400), at(0.75, 400), at(0.75), b];
    return { ...element, properties: { ...element.properties, routeNodes3d: nodes, routePoints: nodes.map(({ x, y }) => ({ x, y })), ...extra } };
  });
}

const piecesOf = (scene: HvacElement[], id: string) => {
  const element = scene.find((candidate) => candidate.id === id)!;
  return { element, line: refrigerantLineOf(element, scene)! };
};

describe('a refrigerant piece\'s figures', () => {
  it('names a copper tube by its inch size only when it is one of the series', () => {
    expect(copperInchLabel(15.88)).toBe('5/8″');
    expect(copperInchLabel(9.52)).toBe('3/8″');
    expect(copperInchLabel(16)).toBeNull();
  });

  it('reads a copper size in mm first in SI and by its inch name first in IP', () => {
    expect(copperSizeText(15.88, 'si')).toBe('Ø15.88 (5/8″)');
    expect(copperSizeText(15.88, 'ip')).toBe('5/8″ (Ø15.88)');
    expect(copperSizeText(16, 'si')).toBe('Ø16.00');
    expect(copperSizeText(16, 'ip')).toBe('Ø0.63 in');
  });

  it('reads the circuit: its outdoor unit, the indoor units it serves, the longest path and the profile limit', () => {
    const scene = circuit();
    const { element } = piecesOf(scene, 'gas');
    const figures = refrigerantCircuitFigures(scene, element, 'gas')!;
    expect(figures.outdoorUnitId).toBe('odu');
    expect(figures.outdoorLabel).toBe('odu');
    expect(figures.indoorUnitIds).toEqual(['idu']);
    expect(figures.longestPathMm).toBeGreaterThan(3500);
    expect(figures.onLongestPath).toBe(true);
    // The fallback profile: a per-path limit, unverified, and no sizing table.
    expect(figures.pathLimit?.verified).toBe(false);
    expect(figures.pathStatus).toBe('ok');
    expect(figures.sizingTable).toBe(false);
    expect(refrigerantCircuitFigures(scene, element, 'gas')).toBe(figures);
  });

  it('says a sizing table is loaded only when the profile has one for the line, and judges the path against its limit', () => {
    const scene = circuit();
    const { element } = piecesOf(scene, 'gas');
    const profile: ManufacturerRuleProfile = {
      ...PROJECT_FALLBACK_RULE_PROFILE, id: 'test', verified: true,
      routeLimits: { maximumEquivalentLengthMm: verified(3800) },
      pipeSizing: [{ id: 'gas', systemType: 'refrigerant-gas', capacityIndexMin: 0, capacityIndexMax: 100, outsideDiameterMm: verified(15.88), minimumBendRadiusMm: verified(60) }],
    };
    const figures = refrigerantCircuitFigures(scene, element, 'gas', profile)!;
    expect(figures.sizingTable).toBe(true);
    expect(figures.pathStatus).toBe('over');
    expect(refrigerantCircuitFigures(scene, piecesOf(scene, 'liquid').element, 'liquid', profile)!.sizingTable).toBe(false);
  });

  it('has no circuit for a line on no outdoor unit', () => {
    const scene = circuit().filter((element) => element.id !== 'odu');
    expect(refrigerantCircuitFigures(scene, piecesOf(scene, 'gas').element, 'gas')).toBeNull();
  });

  it('gives a straight its tube, insulation, length and level, and a port its straight against what the port reserves', () => {
    const scene = circuit();
    const { element, line } = piecesOf(scene, 'gas');
    const port = line.pieces.find((piece) => piece.key === 'port:start')!;
    const straight = line.pieces.find((piece) => piece.kind === 'straight')!;
    const figures = refrigerantPieceFigures(scene, element, line, straight);
    expect(figures.tubeOdMm).toBe(15.88);
    expect(figures.inch).toBe('5/8″');
    expect(figures.insulationMm).toBe(resolveRefrigerantPipeSpec(element.properties).insulationThicknessMm);
    expect(figures.lengthMm).toBeCloseTo(straight.lengthMm, 6);
    expect(figures.levelMm).toBeCloseTo(straight.path[0]!.z, 3);
    expect(figures.bend).toBeNull();
    const stub = refrigerantPieceFigures(scene, element, line, port).port!;
    expect(stub.required.value).toBeGreaterThan(0);
    expect(stub.availableMm).toBeGreaterThanOrEqual(stub.required.value);
    expect(stub.status).toBe('ok');
  });

  it('gives a liquid line its additional charge, from a practice table, per metre and for the piece and the line', () => {
    const scene = circuit();
    const { element, line } = piecesOf(scene, 'liquid');
    const straight = line.pieces.find((piece) => piece.kind === 'straight')!;
    const charge = refrigerantPieceFigures(scene, element, line, straight).charge!;
    expect(charge.kgPerM).toBe(0.06);
    expect(charge.pieceKg).toBeCloseTo((0.06 * straight.lengthMm) / 1000, 6);
    expect(charge.lineKg).toBeGreaterThan(charge.pieceKg);
    expect(refrigerantPieceFigures(scene, piecesOf(scene, 'gas').element, piecesOf(scene, 'gas').line, piecesOf(scene, 'gas').line.pieces[0]!).charge).toBeNull();
  });

  it('gives a bend its angle, plane and construction, and judges only a formed bend\'s radius against the profile minimum', () => {
    const socket = hopped(circuit());
    const { element, line } = piecesOf(socket, 'gas');
    const bends = line.pieces.filter((piece) => piece.kind === 'bend');
    expect(bends).toHaveLength(4);
    const elbow = refrigerantPieceFigures(socket, element, line, bends[0]!).bend!;
    expect(elbow.angleDeg).toBeCloseTo(90, 1);
    expect(elbow.plane).toBe('vertical');
    expect(elbow.construction).toBe('socket-elbow');
    expect(elbow.minimumRadius).toBeNull();
    const formed = hopped(circuit(), { fieldBendConstruction: 'formed-tube' });
    const bent = piecesOf(formed, 'gas');
    const bend = refrigerantPieceFigures(formed, bent.element, bent.line, bent.line.pieces.find((piece) => piece.kind === 'bend')!).bend!;
    expect(bend.construction).toBe('formed-bend');
    expect(bend.minimumRadius?.value).toBe(PROJECT_FALLBACK_RULE_PROFILE.portDefaults.minimumBendRadiusMm.value);
    expect(bend.radiusStatus).not.toBeNull();
  });
});
