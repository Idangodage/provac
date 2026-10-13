import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import type { VrfValidationReport } from '../../../../vrf/rules/validation-engine';
import type { SegmentFocus } from '../segments/segmentUiStore';
import { addRefrigerantAccessoryMeshes } from '../three3d/refrigerantAccessoryMeshes';

import { createRefrigerantSegmentProvider, matchingPiece, refrigerantPieceRows } from './RefrigerantSegmentCard';
import {
  accessoryBody,
  freeStationFor,
  nextAccessoryId,
  placeAccessories,
  readRefrigerantAccessories,
  type AccessoryStraight,
  type RefrigerantInlineAccessory,
} from './refrigerantAccessories';
import { accessoryGlyphShapes, refrigerantAccessoryGlyphs } from './refrigerantAccessoryGlyphs';
import { refrigerantLineOf, refrigerantPieceAtModelPoint, refrigerantPieceAtPlanPoint, refrigerantPieceOutline, type RefrigerantPiece } from './refrigerantPieces';
import { evaluateRefrigerantOption, refrigerantPieceOptions, type RefrigerantPartner } from './refrigerantSegmentOptions';

/** A gas and a liquid line side by side, free at both ends, hopped 400 mm up over their middle: the high straight is 2 m. */
function hoppedPair(extra: { gas?: Record<string, unknown>; liquid?: Record<string, unknown> } = {}): HvacElement[] {
  const line = (id: 'gas' | 'liquid', y: number): HvacElement => {
    const nodes = [
      { x: 0, y, z: 2600 }, { x: 1000, y, z: 2600 }, { x: 1000, y, z: 3000 }, { x: 3000, y, z: 3000 }, { x: 3000, y, z: 2600 }, { x: 4000, y, z: 2600 },
    ];
    return {
      id, label: id, type: 'refrigerant-pipe', position: { x: 0, y }, rotation: 0, width: 4000, depth: 100, height: 500,
      elevation: 2550, mountType: 'ceiling', supplyZoneRatio: 0,
      properties: { lineKind: id, pipeDiameterMm: id === 'gas' ? 15.88 : 9.52, insulationThicknessMm: 25.4, bundleId: 'b-2',
        routePoints: nodes.map(({ x, y: py }) => ({ x, y: py })), routeNodes3d: nodes, segmentMaterials: nodes.slice(1).map(() => 'hard'), ...extra[id] },
    } as unknown as HvacElement;
  };
  return [line('gas', 0), line('liquid', 90)];
}

const read = (scene: HvacElement[], id: string) => {
  const element = scene.find((candidate) => candidate.id === id)!;
  return { element, line: refrigerantLineOf(element, scene)! };
};
/** The high straight across the top of the hop. */
const highStraight = (pieces: readonly RefrigerantPiece[]) => pieces.filter((piece) => piece.kind === 'straight').sort((a, b) => b.path[0]!.z - a.path[0]!.z)[0]!;
const partnerFor = (scene: HvacElement[], piece: RefrigerantPiece, otherId: string): RefrigerantPartner => {
  const other = read(scene, otherId);
  return { element: other.element, line: other.line, piece: matchingPiece(other.line, piece)! };
};
/** The scene with a valve (or another kind) on the gas line's high straight, its centre `stationMm` from the leg's start. */
function withAccessory(stationMm: number, kind: RefrigerantInlineAccessory['kind'] = 'ball-valve', lineId: 'gas' | 'liquid' = 'gas'): HvacElement[] {
  const scene = hoppedPair();
  const high = highStraight(read(scene, lineId).line.pieces);
  const accessory: RefrigerantInlineAccessory = { id: 'a1', kind, legId: high.legId!, stationMm, at: { x: 1000 + stationMm, y: lineId === 'gas' ? 0 : 90, z: 3000 } };
  return hoppedPair({ [lineId]: { inlineAccessories: [accessory] } });
}
const ROW: AccessoryStraight = { legId: 'l1', legIndex: 0, start: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, freeFromMm: 20, freeToMm: 980 };

describe('inline refrigerant accessories', () => {
  it('sizes each body from its tube (practice), the strainer the longest', () => {
    expect(accessoryBody('ball-valve', 15.88)).toEqual({ lengthMm: 91, diameterMm: 42 });
    expect(accessoryBody('strainer', 9.52).lengthMm).toBeGreaterThan(accessoryBody('ball-valve', 9.52).lengthMm);
    expect(accessoryBody('flare-union', 6.35).lengthMm).toBeLessThan(accessoryBody('sight-glass', 6.35).lengthMm);
  });

  it('reads a line\'s accessories tolerantly and numbers new ones past the highest', () => {
    const element = { properties: { inlineAccessories: [
      { id: 'a1', kind: 'ball-valve', legId: 'l1', stationMm: 400, at: { x: 400, y: 0, z: 0 } },
      { id: 'a3', kind: 'gate-valve', legId: 'l1', stationMm: 100, at: { x: 100, y: 0, z: 0 } },
      { id: 'a4', kind: 'strainer', legId: 'l1', stationMm: Number.NaN, at: { x: 0, y: 0, z: 0 } },
      'junk',
    ] } } as unknown as HvacElement;
    expect(readRefrigerantAccessories(element).map((item) => item.id)).toEqual(['a1']);
    expect(readRefrigerantAccessories({ properties: {} } as HvacElement)).toEqual([]);
    expect(nextAccessoryId([{ id: 'a1' }, { id: 'a7' }, { id: 'x' }] as RefrigerantInlineAccessory[])).toBe('a8');
    expect(nextAccessoryId([])).toBe('a1');
  });

  it('puts a new body at the straight\'s middle, else the nearest free place, else says why not', () => {
    expect(freeStationFor(ROW, 'ball-valve', 15.88, [])).toEqual({ stationMm: 500 });
    const [valve] = placeAccessories([ROW], [{ id: 'a1', kind: 'ball-valve', legId: 'l1', stationMm: 500, at: { x: 500, y: 0, z: 0 } }], 15.88, 'gas');
    // The middle is taken: the next one goes beside it, its clearance kept.
    const beside = freeStationFor(ROW, 'flare-union', 15.88, [valve!]);
    expect('stationMm' in beside && Math.abs(beside.stationMm - 500)).toBeGreaterThanOrEqual(91 / 2 + 30 + accessoryBody('flare-union', 15.88).lengthMm / 2 - 1);
    expect(freeStationFor({ ...ROW, freeToMm: 120 }, 'strainer', 15.88, [])).toEqual({ problem: expect.stringMatching(/too short/) });
  });

  it('says where one cannot be: the wrong line, into a fitting, into the body beside it', () => {
    const at = (stationMm: number) => ({ x: stationMm, y: 0, z: 0 });
    const placed = placeAccessories([ROW], [
      { id: 'a1', kind: 'strainer', legId: 'l1', stationMm: 500, at: at(500) },
      { id: 'a2', kind: 'ball-valve', legId: 'l1', stationMm: 60, at: at(60) },
      { id: 'a3', kind: 'flare-union', legId: 'l1', stationMm: 560, at: at(560) },
    ], 15.88, 'gas');
    expect(placed[0]!.problem).toMatch(/belongs on the liquid line/);
    expect(placed[1]!.problem).toMatch(/runs into a fitting: keep its centre 96–/);
    expect(placed[2]!.problem).toMatch(/runs into the strainer beside it/);
  });

  it('re-attaches to the straight where it was when its leg is gone or no longer reaches it', () => {
    const second: AccessoryStraight = { ...ROW, legId: 'l2', legIndex: 1, start: { x: 1000, y: 0, z: 0 } };
    const [moved] = placeAccessories([ROW, second], [{ id: 'a1', kind: 'ball-valve', legId: 'l1', stationMm: 1500, at: { x: 1500, y: 0, z: 0 } }], 15.88, 'gas');
    expect(moved).toMatchObject({ legId: 'l2', stationMm: 500, problem: null });
    const [renamed] = placeAccessories([ROW], [{ id: 'a1', kind: 'ball-valve', legId: 'gone', stationMm: 0, at: { x: 300, y: 40, z: 0 } }], 15.88, 'gas');
    expect(renamed).toMatchObject({ legId: 'l1', stationMm: 300 });
  });
});

describe('an accessory on the line', () => {
  const scene = withAccessory(1000);
  const { element, line } = read(scene, 'gas');
  const piece = line.pieces.find((candidate) => candidate.key === 'acc:a1')!;

  it('is a piece of its own right after its straight, picked before the straight in plan and in 3D', () => {
    const high = highStraight(line.pieces);
    expect(line.pieces[line.pieces.indexOf(high) + 1]).toBe(piece);
    expect(piece).toMatchObject({ kind: 'accessory', ordinal: 1, legId: high.legId });
    expect(piece.lengthMm).toBeCloseTo(91, 6);
    expect(refrigerantPieceAtPlanPoint(line, { x: 2010, y: 5 })?.key).toBe('acc:a1');
    expect(refrigerantPieceAtPlanPoint(line, { x: 2300, y: 5 })?.key).toBe(high.key);
    expect(refrigerantPieceAtModelPoint(line, { x: 2000, y: 0, z: 3030 })?.key).toBe('acc:a1');
    // Its outline is its body's width, proud of the insulated line.
    const outline = refrigerantPieceOutline(line, piece);
    expect(Math.max(...outline.map((point) => point.y))).toBeGreaterThan(line.halfWidthMm);
  });

  it('is drawn in plan as its symbol, on its straight, turned with it', () => {
    const [glyph] = refrigerantAccessoryGlyphs(element, scene);
    expect(glyph).toMatchObject({ id: 'a1', kind: 'ball-valve', lineKind: 'gas', centre: { x: 2000, y: 0 }, angleDeg: 0, lengthMm: 91, problem: null, scale: 1 });
    expect(glyph!.shapes[0]!.d).toMatch(/^M -45\.5 -/);
    expect(refrigerantAccessoryGlyphs(element, scene, 182)[0]!.scale).toBeCloseTo(2, 6);
    for (const kind of ['strainer', 'sight-glass', 'flare-union'] as const) expect(accessoryGlyphShapes(kind, 100, 20).length).toBeGreaterThan(2);
    expect(refrigerantAccessoryGlyphs(read(scene, 'liquid').element, scene)).toEqual([]);
  });

  it('is built in 3D on its straight: a brass body, its stem and lever', () => {
    const group = new THREE.Group();
    expect(addRefrigerantAccessoryMeshes(group, element, scene)).toBe(1);
    const valve = group.getObjectByName('refrigerant-accessory-ball-valve-a1')!;
    expect(valve.position.x).toBeCloseTo(2000, 3);
    expect(valve.position.z).toBeCloseTo(3000, 3);
    expect(valve.getObjectByName('valve-lever')).toBeDefined();
    const box = new THREE.Box3().setFromObject(valve);
    // Above the line: the lever stands over the body.
    expect(box.max.z).toBeGreaterThan(3000 + line.outsideDiameterMm / 2);
  });
});

describe('adding an accessory from a straight\'s card', () => {
  const scene = hoppedPair();
  const gas = read(scene, 'gas');
  const high = highStraight(gas.line.pieces);
  const options = refrigerantPieceOptions(scene, gas.element, gas.line, high, partnerFor(scene, high, 'liquid'));
  const byId = (id: string) => options.find((option) => option.id === id)!;

  it('offers what its line takes, here and on both lines of the pair; the strainer and sight glass only on the liquid', () => {
    expect(options.filter((option) => option.group === 'accessory-add').map((option) => option.id))
      .toEqual(['accessory:ball-valve', 'accessory:ball-valve:pair', 'accessory:flare-union', 'accessory:flare-union:pair']);
    const liquid = read(scene, 'liquid');
    const liquidHigh = highStraight(liquid.line.pieces);
    const liquidOptions = refrigerantPieceOptions(scene, liquid.element, liquid.line, liquidHigh, null).filter((option) => option.group === 'accessory-add');
    expect(liquidOptions.map((option) => option.id)).toEqual(['accessory:ball-valve', 'accessory:strainer', 'accessory:sight-glass', 'accessory:flare-union']);
    expect(byId('accessory:ball-valve').detail).toMatch(/isolates the line for service · body 91 mm/);
  });

  it('puts a valve at the straight\'s middle, one undo, and judges it there', () => {
    const evaluation = evaluateRefrigerantOption(scene, byId('accessory:ball-valve'));
    expect(evaluation.refused).toBeUndefined();
    expect(evaluation.action).toBe('Add ball valve');
    expect(evaluation.updates.map((updated) => updated.id)).toEqual(['gas']);
    const [valve] = readRefrigerantAccessories(evaluation.updates[0]!);
    expect(valve).toMatchObject({ id: 'a1', kind: 'ball-valve', legId: high.legId, stationMm: 1000, at: { x: 2000, y: 0, z: 3000 } });
    expect(evaluation.deltaLengthMm).toBe(0);
    expect(evaluation.newIssues).toEqual([]);
  });

  it('puts valves on both lines of the pair side by side', () => {
    const evaluation = evaluateRefrigerantOption(scene, byId('accessory:ball-valve:pair'));
    expect(evaluation.action).toBe('Add ball valves on both lines');
    expect(evaluation.updates.map((updated) => updated.id).sort()).toEqual(['gas', 'liquid']);
    const centres = evaluation.updates.map((updated) => readRefrigerantAccessories(updated)[0]!.at.x);
    expect(Math.abs(centres[0]! - centres[1]!)).toBeLessThan(1);
  });

  it('greys the add on a locked line, with the reason', () => {
    const locked = hoppedPair({ gas: { routeLocked: true } });
    const lockedGas = read(locked, 'gas');
    const add = refrigerantPieceOptions(locked, lockedGas.element, lockedGas.line, highStraight(lockedGas.line.pieces), null)
      .find((option) => option.id === 'accessory:ball-valve')!;
    expect(add.disabledReason).toMatch(/locked/);
  });
});

describe('an accessory\'s own card', () => {
  const scene = withAccessory(1000);
  const { element, line } = read(scene, 'gas');
  const piece = line.pieces.find((candidate) => candidate.key === 'acc:a1')!;
  const options = refrigerantPieceOptions(scene, element, line, piece, null);
  const byId = (id: string) => options.find((option) => option.id === id)!;

  it('moves it along its straight, swaps it for a kind its line takes, takes it out', () => {
    expect(options.map((option) => option.id)).toEqual([
      'accessory-move:-100', 'accessory-move:-50', 'accessory-move:50', 'accessory-move:100',
      'accessory-kind:ball-valve', 'accessory-kind:flare-union', 'accessory-remove',
    ]);
    expect(byId('accessory-kind:ball-valve').current).toBe(true);
    expect(byId('accessory-move:100').title).toBe('→ 100');
    const moved = evaluateRefrigerantOption(scene, byId('accessory-move:100'));
    expect(readRefrigerantAccessories(moved.updates[0]!)[0]).toMatchObject({ stationMm: 1100, at: { x: 2100 } });
    const union = evaluateRefrigerantOption(scene, byId('accessory-kind:flare-union'));
    expect(union.action).toBe('Make it a flare union');
    expect(readRefrigerantAccessories(union.updates[0]!)[0]!.kind).toBe('flare-union');
    const out = evaluateRefrigerantOption(scene, byId('accessory-remove'));
    expect(out.action).toBe('Take out ball valve');
    expect(out.updates[0]!.properties.inlineAccessories).toBeUndefined();
  });

  it('will not move it into a fitting', () => {
    const near = withAccessory(130);
    const nearLine = read(near, 'gas');
    const nearOptions = refrigerantPieceOptions(near, nearLine.element, nearLine.line, nearLine.line.pieces.find((candidate) => candidate.key === 'acc:a1')!, null);
    expect(nearOptions.find((option) => option.id === 'accessory-move:-100')!.disabledReason).toMatch(/run into a fitting/);
  });

  it('keeps an accessory where it was when a corner is added past it, and says when one lands on it', () => {
    // The valve 1.5 m along the 2 m straight; a point at the straight's middle splits it.
    const far = withAccessory(1500);
    const farLine = read(far, 'gas');
    const farHigh = highStraight(farLine.line.pieces);
    const split = refrigerantPieceOptions(far, farLine.element, farLine.line, farHigh, null).find((option) => option.id === 'add-point')!;
    const kept = evaluateRefrigerantOption(far, split);
    expect(kept.refused).toBeUndefined();
    const [carried] = readRefrigerantAccessories(kept.updates.find((updated) => updated.id === 'gas')!);
    expect(carried!.legId).not.toBe(farHigh.legId);
    expect(carried!.at.x).toBeCloseTo(2500, 0);
    expect(kept.newIssues.filter((issue) => issue.code === 'ACCESSORY_FIT')).toEqual([]);
    // The valve at the middle: the new corner lands on it.
    const middle = withAccessory(1000);
    const middleLine = read(middle, 'gas');
    const onIt = refrigerantPieceOptions(middle, middleLine.element, middleLine.line, highStraight(middleLine.line.pieces), null).find((option) => option.id === 'add-point')!;
    expect(evaluateRefrigerantOption(middle, onIt).newIssues).toContainEqual(expect.objectContaining({ code: 'ACCESSORY_FIT', severity: 'error' }));
  });
});

describe('an accessory\'s card in the provider', () => {
  const EMPTY_REPORT: VrfValidationReport = { issues: [], commitBlocked: false, counts: { error: 0, warning: 0, advisory: 0, information: 0 } };
  const provider = createRefrigerantSegmentProvider({ report: EMPTY_REPORT });
  const focusOn = (runId: string, key: string): SegmentFocus => ({ domain: 'refrigerant', runId, key, anchorMark: null, view: '2d' });
  const scene = withAccessory(1000);

  it('heads it with its line and kind, a short tag, and sorts its options into the tabs', () => {
    const model = provider.model(scene, focusOn('gas', 'acc:a1'))!;
    expect(model.head).toMatchObject({ title: 'Gas · Ball valve', tag: 'G-A1', detail: '91 mm body', kind: 'accessory', size: 'Ø15.88 (5/8″)' });
    expect(model.issues).toEqual([]);
    const tab = (group: string) => new Set(model.options.filter((option) => option.group === group).map((option) => model.tabOf(option)));
    expect(tab('accessory-kind')).toEqual(new Set(['swap']));
    expect(tab('accessory-remove')).toEqual(new Set(['add']));
    expect(tab('accessory-move')).toEqual(new Set([null]));
    const host = { evaluate: model.evaluate, evaluations: new Map(), onPreview: () => undefined, onHover: () => undefined, onApply: () => undefined, result: () => null };
    expect(model.edit(host)).not.toBeNull();
  });

  it('says when it has no room where it is', () => {
    const wrong = withAccessory(1000, 'strainer');
    expect(provider.model(wrong, focusOn('gas', 'acc:a1'))!.issues).toEqual([expect.objectContaining({ code: 'ACCESSORY_FIT', message: expect.stringMatching(/liquid line/) })]);
  });

  it('goes to its straight once it is taken out', () => {
    const high = highStraight(read(scene, 'gas').line.pieces);
    const model = provider.model(scene, focusOn('gas', 'acc:a1'))!;
    expect(provider.rekey(hoppedPair(), focusOn('gas', 'acc:a1'), model.rekeyToken)?.key).toBe(high.key);
  });

  it('lists it among the line\'s pieces in the inspector', () => {
    const gas = scene.find((element) => element.id === 'gas')!;
    expect(refrigerantPieceRows(gas, scene)).toContainEqual({ key: 'acc:a1', tag: 'G-A1', title: 'Ball valve', detail: '91 mm' });
  });
});
