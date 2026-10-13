import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import { buildVrfDocumentFromHvacElements } from '../../../../vrf/domain';
import { getBranchKitPortConnections, getRefrigerantPipeBundleSnapTargets, resolveRefrigerantPipeSpec } from '../refrigerantPipePairModel';

import { matchingPiece } from './RefrigerantSegmentCard';
import { refrigerantKitOf } from './refrigerantKits';
import { refrigerantLineOf, type RefrigerantPiece } from './refrigerantPieces';
import {
  evaluateRefrigerantOption,
  kitPartnerOf,
  kitPipeEnds,
  kitRunAxis,
  refrigerantKitOptions,
  refrigerantPieceOptions,
  refrigerantValueOption,
  screenWay,
  type RefrigerantPartner,
} from './refrigerantSegmentOptions';

interface Point3 { x: number; y: number; z: number }

/** An outdoor unit and a cassette 4 m apart, joined by a gas and a liquid line on their ports, one bundle. */
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
      properties: { lineKind: line, pipeDiameterMm: line === 'gas' ? 15.88 : 9.52, insulationThicknessMm: 25.4, bundleId: 'b-1',
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

/** A gas and a liquid line side by side, free at both ends, hopped 400 mm up over their middle: bends, risers, a high straight. */
function hoppedPair(): HvacElement[] {
  const line = (id: string, lineKind: 'gas' | 'liquid', y: number): HvacElement => {
    const nodes = [
      { x: 0, y, z: 2600 }, { x: 1000, y, z: 2600 }, { x: 1000, y, z: 3000 }, { x: 3000, y, z: 3000 }, { x: 3000, y, z: 2600 }, { x: 4000, y, z: 2600 },
    ];
    return {
      id, label: id, type: 'refrigerant-pipe', position: { x: 0, y }, rotation: 0, width: 4000, depth: 100, height: 500,
      elevation: 2550, mountType: 'ceiling', supplyZoneRatio: 0,
      properties: { lineKind, pipeDiameterMm: lineKind === 'gas' ? 15.88 : 9.52, insulationThicknessMm: 25.4, bundleId: 'b-2',
        routePoints: nodes.map(({ x, y: py }) => ({ x, y: py })), routeNodes3d: nodes, segmentMaterials: nodes.slice(1).map(() => 'hard') },
    } as unknown as HvacElement;
  };
  return [line('gas', 'gas', 0), line('liquid', 'liquid', 90)];
}

const read = (scene: HvacElement[], id: string) => {
  const element = scene.find((candidate) => candidate.id === id)!;
  return { element, line: refrigerantLineOf(element, scene)! };
};

function partnerFor(scene: HvacElement[], piece: RefrigerantPiece, otherId: string): RefrigerantPartner {
  const other = read(scene, otherId);
  return { element: other.element, line: other.line, piece: matchingPiece(other.line, piece)! };
}

describe('a refrigerant straight\'s options', () => {
  const scene = circuit();
  const { element, line } = read(scene, 'gas');
  const straight = line.pieces.find((piece) => piece.kind === 'straight')!;
  const options = refrigerantPieceOptions(scene, element, line, straight, partnerFor(scene, straight, 'liquid'));
  const byId = (id: string) => options.find((option) => option.id === id)!;

  it('offers the next ACR sizes either side of its own, saying no sizing table is loaded', () => {
    const sizes = options.filter((option) => option.group === 'size');
    expect(sizes.map((option) => option.id)).toEqual(['size:12.70', 'size:15.88', 'size:19.05']);
    expect(byId('size:15.88').current).toBe(true);
    expect(byId('size:19.05').detail).toMatch(/one size up · no sizing table loaded/);
    expect(byId('size:19.05').title).toBe('Ø19.05 (3/4″)');
  });

  it('resizes the line it is on: its tube, nominal size and outside, one undo', () => {
    const evaluation = evaluateRefrigerantOption(scene, byId('size:19.05'));
    expect(evaluation.refused).toBeUndefined();
    expect(evaluation.updates.map((updated) => updated.id)).toEqual(['gas']);
    const spec = resolveRefrigerantPipeSpec(evaluation.updates[0]!.properties);
    expect(spec.pipeDiameterMm).toBe(19.05);
    expect(spec.outerDiameterMm).toBeCloseTo(19.05 + 2 * 25.4, 6);
    expect(evaluation.action).toMatch(/Resize gas line/);
    expect(evaluateRefrigerantOption(scene, byId('size:19.05'))).toBe(evaluation);
  });

  it('offers insulation from the model\'s minimum up, its own marked', () => {
    const insulation = options.filter((option) => option.group === 'insulation');
    expect(insulation.map((option) => option.title)).toEqual(['25 mm', '32 mm', '38 mm', '50 mm']);
    expect(insulation[0]!.current).toBe(true);
    const thicker = evaluateRefrigerantOption(scene, insulation[2]!);
    expect(resolveRefrigerantPipeSpec(thicker.updates[0]!.properties).insulationThicknessMm).toBe(38);
  });

  it('keeps the stub at a unit port hard copper', () => {
    const port = line.pieces.find((piece) => piece.kind === 'port')!;
    const material = refrigerantPieceOptions(scene, element, line, { ...straight, legId: port.legId, legIndex: port.legIndex }, null)
      .find((option) => option.group === 'material')!;
    if (material.edit.kind === 'material' && material.edit.material === 'flexible') {
      expect(evaluateRefrigerantOption(scene, material).refused).toMatch(/must remain hard copper/);
    } else {
      expect(material.edit).toMatchObject({ kind: 'material', material: 'hard' });
    }
  });

  it('greys every option of a locked line, with the reason', () => {
    const lockedScene = scene.map((candidate) => (candidate.id === 'gas' ? { ...candidate, properties: { ...candidate.properties, routeLocked: true } } : candidate));
    const locked = read(lockedScene, 'gas');
    const lockedOptions = refrigerantPieceOptions(lockedScene, locked.element, locked.line, locked.line.pieces.find((piece) => piece.kind === 'straight')!, null);
    const resize = lockedOptions.find((option) => option.id === 'size:19.05')!;
    expect(resize.disabledReason).toMatch(/locked/);
    expect(evaluateRefrigerantOption(lockedScene, resize).refused).toMatch(/locked/);
  });
});

describe('moving a straight', () => {
  const scene = hoppedPair();
  const { element, line } = read(scene, 'gas');
  // The high straight across the top of the hop.
  const high = line.pieces.filter((piece) => piece.kind === 'straight').sort((a, b) => b.path[0]!.z - a.path[0]!.z)[0]!;
  const partner = partnerFor(scene, high, 'liquid');
  const options = refrigerantPieceOptions(scene, element, line, high, partner);

  it('raises both lines of the pair together, the risers re-made', () => {
    const up = options.find((option) => option.id === 'level:100')!;
    expect(up.detail).toMatch(/both lines of the pair/);
    const evaluation = evaluateRefrigerantOption(scene, up);
    expect(evaluation.refused).toBeUndefined();
    expect(evaluation.updates.map((updated) => updated.id).sort()).toEqual(['gas', 'liquid']);
    // Two risers each 100 mm taller: the line is about 200 mm longer.
    expect(evaluation.deltaLengthMm).toBeGreaterThan(150);
    // The liquid line carries more charge for its extra length (practice table).
    expect(evaluation.deltaChargeKg).toBeGreaterThan(0);
  });

  it('judges the same option on another straight as that straight\'s own edit', () => {
    const low = line.pieces.filter((piece) => piece.kind === 'straight').sort((a, b) => a.path[0]!.z - b.path[0]!.z)[0]!;
    const lowUp = refrigerantPieceOptions(scene, element, line, low, null).find((option) => option.id === 'level:100')!;
    const highUp = options.find((option) => option.id === 'level:100')!;
    const first = evaluateRefrigerantOption(scene, highUp);
    const second = evaluateRefrigerantOption(scene, lowUp);
    expect(second).not.toBe(first);
    expect(JSON.stringify(second.updates.map((updated) => updated.properties.routeNodes3d)))
      .not.toEqual(JSON.stringify(first.updates.map((updated) => updated.properties.routeNodes3d)));
  });

  it('offers sideways offsets named the way they move on screen', () => {
    const offsets = options.filter((option) => option.group === 'offset');
    expect(offsets).toHaveLength(4);
    expect(offsets.every((option) => /^[↑↓←→] \d+$/.test(option.title))).toBe(true);
    expect(screenWay({ x: 0, y: 1 }).words).toBe('down the plan');
    expect(screenWay({ x: -1, y: 0.2 }).arrow).toBe('←');
  });

  it('types a level of its own, and a length with its start or its end held', () => {
    const level = refrigerantValueOption(element, high, partner, { kind: 'level', deltaMm: -60 })!;
    const lowered = evaluateRefrigerantOption(scene, level);
    expect(lowered.refused).toBeUndefined();
    expect(lowered.deltaLengthMm).toBeLessThan(0);
    const longer = refrigerantValueOption(element, high, null, { kind: 'length', deltaMm: 100, keep: 'start' })!;
    expect(longer.edit).toMatchObject({ kind: 'leg-length', deltaMm: 100, keep: 'start' });
    const evaluation = evaluateRefrigerantOption(scene, longer);
    expect(evaluation.refused ?? evaluation.updates.length).toBeTruthy();
  });
});

describe('a refrigerant bend\'s options', () => {
  const scene = hoppedPair();
  const { element, line } = read(scene, 'gas');
  const bend = line.pieces.find((piece) => piece.kind === 'bend' && piece.angleDeg !== null && Math.abs(piece.angleDeg - 90) < 2)!;
  const options = refrigerantPieceOptions(scene, element, line, bend, null);
  const byId = (id: string) => options.find((option) => option.id === id);

  it('offers the line\'s bend construction, its own marked, and formed-bend radii only for formed bends', () => {
    expect(byId('construction:socket')?.current).toBe(true);
    expect(byId('construction:formed')?.current).toBeUndefined();
    expect(options.some((option) => option.group === 'radius')).toBe(false);
    const formed = evaluateRefrigerantOption(scene, byId('construction:formed')!);
    expect(formed.refused ?? formed.updates[0]!.properties.fieldBendConstruction).toBeTruthy();
  });

  it('offers a 90° as two 45°s, turning it into another plane, and taking it out', () => {
    expect(byId('split-bend')?.detail).toMatch(/straight between them/);
    expect(options.filter((option) => option.group === 'plane')).toHaveLength(2);
    expect(byId('remove-bend')).toBeTruthy();
    // Each is evaluated through the engine: applied, or refused with its reason.
    for (const id of ['split-bend', 'roll:90', 'roll:-90', 'remove-bend']) {
      const evaluation = evaluateRefrigerantOption(scene, byId(id)!);
      expect(evaluation.refused ? evaluation.refused.length > 0 : evaluation.updates.length > 0).toBe(true);
    }
  });

  it('makes two 45° bends where the corner was, when the legs have room', () => {
    const evaluation = evaluateRefrigerantOption(scene, byId('split-bend')!);
    if (evaluation.refused) {
      expect(evaluation.refused).toMatch(/45|straight|short|room/i);
      return;
    }
    const after = refrigerantLineOf(evaluation.updates[0]!, scene.map((candidate) => (candidate.id === 'gas' ? evaluation.updates[0]! : candidate)))!;
    const bends = after.pieces.filter((piece) => piece.kind === 'bend');
    expect(bends.filter((piece) => Math.abs(piece.angleDeg! - 45) < 2).length).toBeGreaterThanOrEqual(2);
  });
});

/** A gas kit and a liquid kit splitting a pair: each kit's inlet, run and branch pipes on its ports, one bundle per port. */
function kitPair(inletMm = 1500): HvacElement[] {
  const kit = (id: string, lineKind: 'gas' | 'liquid') => ({
    id, type: 'refrigerant-branch-kit', label: id, modelLabel: `DIS-22-1G ${lineKind === 'gas' ? 'Gas' : 'Liquid'}`, subtype: 'dis-22-1g',
    position: { x: 2000, y: 1000 }, width: 441, depth: 170, height: 120, elevation: 2500, rotation: 0, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { branchKitLineKind: lineKind },
  }) as unknown as HvacElement;
  const kits = [kit('kit-g', 'gas'), kit('kit-l', 'liquid')];
  const axis = kitRunAxis(kits[0]!)!;
  const pipes = kits.flatMap((kitElement) => {
    const lineKind = kitElement.properties.branchKitLineKind as 'gas' | 'liquid';
    return (['inlet', 'run-outlet', 'branch-outlet'] as const).map((role) => {
      const port = getBranchKitPortConnections(kitElement).find((candidate) => candidate.terminalRole === role)!;
      const point = lineKind === 'gas' ? port.gasPoint! : port.liquidPoint!;
      const z = (lineKind === 'gas' ? port.gasElevationMm : port.liquidElevationMm)!;
      const length = role === 'inlet' ? inletMm : 1200;
      const away = role === 'inlet' ? -1 : 1;
      const far = { x: point.x + axis.x * length * away, y: point.y + axis.y * length * away, z };
      const atKit = { connectionKind: 'field-pipe', sourceElementId: kitElement.id, terminalRole: role,
        portPoint: { x: point.x, y: point.y }, direction: { x: axis.x * away, y: axis.y * away }, elevationMm: z };
      const nodes = role === 'inlet' ? [far, { ...point, z }] : [{ ...point, z }, far];
      return {
        id: `${lineKind}-${role}`, label: role, type: 'refrigerant-pipe', position: { x: Math.min(nodes[0]!.x, nodes[1]!.x), y: Math.min(nodes[0]!.y, nodes[1]!.y) },
        rotation: 0, width: length, depth: 60, height: 60, elevation: z - 30, mountType: 'ceiling', supplyZoneRatio: 0,
        properties: { lineKind, pipeDiameterMm: lineKind === 'gas' ? 15.88 : 9.52, insulationThicknessMm: 25.4, bundleId: `b-${role}`,
          routePoints: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes, segmentMaterials: ['hard'],
          ...(role === 'inlet' ? { endConnection: atKit } : { startConnection: atKit }) },
      } as unknown as HvacElement;
    });
  });
  return [...kits, ...pipes];
}

describe("a branch kit's options", () => {
  const scene = kitPair();
  const gasKit = scene.find((element) => element.id === 'kit-g')!;
  const options = refrigerantKitOptions(scene, gasKit);
  const byId = (id: string) => options.find((option) => option.id === id);

  it("knows the pair's other kit and the pipes the kits hold", () => {
    expect(kitPartnerOf(gasKit, scene)?.id).toBe('kit-l');
    expect(kitPartnerOf(scene.find((element) => element.id === 'kit-l')!, scene)?.id).toBe('kit-g');
    expect(kitPipeEnds(scene, ['kit-g', 'kit-l'])).toHaveLength(6);
  });

  it('slides both kits of the pair along their run, their six pipes following', () => {
    const slide = byId('kit-slide:100')!;
    expect(slide.detail).toMatch(/towards its outlets · both kits of the pair/);
    const evaluation = evaluateRefrigerantOption(scene, slide);
    expect(evaluation.refused).toBeUndefined();
    const axis = kitRunAxis(gasKit)!;
    for (const id of ['kit-g', 'kit-l']) {
      const before = scene.find((element) => element.id === id)!;
      const after = evaluation.updates.find((element) => element.id === id)!;
      expect(after.position.x - before.position.x).toBeCloseTo(axis.x * 100, 6);
      expect(after.position.y - before.position.y).toBeCloseTo(axis.y * 100, 6);
    }
    expect(evaluation.updates.filter((element) => element.type === 'refrigerant-pipe')).toHaveLength(6);
    // Each line: its inlet 100 mm longer, its run and branch 100 mm shorter.
    expect(evaluation.deltaLengthMm).toBeCloseTo(-200, 0);
    // The gas inlet ends on the kit's moved port.
    const kitAfter = evaluation.updates.find((element) => element.id === 'kit-g')!;
    const inlet = refrigerantKitOf(kitAfter)!.ports[0]!.inlet;
    const route = resolveRefrigerantPipeSpec(evaluation.updates.find((element) => element.id === 'gas-inlet')!.properties).routePoints;
    expect(Math.hypot(route.at(-1)!.x - inlet.x, route.at(-1)!.y - inlet.y)).toBeLessThan(1);
  });

  it('refuses a slide a pipe has not the straight to give, saying which', () => {
    const short = kitPair(250);
    const evaluation = evaluateRefrigerantOption(short, refrigerantKitOptions(short, short[0]!).find((option) => option.id === 'kit-slide:-200')!);
    expect(evaluation.refused).toMatch(/pipe on its inlet has 250 mm of straight/);
  });

  it('lists turning it over and another model, each with why not', () => {
    expect(byId('kit-flip')?.disabledReason).toMatch(/6 pipes on the two kits would need redrawing/);
    expect(byId('kit-model')?.disabledReason).toMatch(/DIS-22-1G is the only branch kit in the library/);
  });

  it('turns a kit no pipe holds over', () => {
    const lone = [gasKit];
    const flip = refrigerantKitOptions(lone, gasKit).find((option) => option.id === 'kit-flip')!;
    expect(flip.disabledReason).toBeUndefined();
    const evaluation = evaluateRefrigerantOption(lone, flip);
    expect(evaluation.updates[0]!.properties.branchKitRollDeg).toBe(180);
    expect(refrigerantKitOf(evaluation.updates[0]!)!.rollDeg).toBe(180);
  });
});
