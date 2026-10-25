import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';
import type { VrfValidationIssue, VrfValidationReport } from '../../../../vrf/rules/validation-engine';
import type { PipeRouteNode3D } from '../pipeRoute3d';
import type { SegmentFocus } from '../segments/segmentUiStore';

import { createRefrigerantSegmentProvider, matchingPiece, partnerOf, pieceIssues, refrigerantPieceRows } from './RefrigerantSegmentCard';
import { KIT_KEY, refrigerantKitOf } from './refrigerantKits';
import { refrigerantLineOf } from './refrigerantPieces';

const line = (id: string, lineKind: 'gas' | 'liquid', nodes: PipeRouteNode3D[], extra: Record<string, unknown> = {}): HvacElement => ({
  id, type: 'refrigerant-pipe', label: `${lineKind} pipe`, position: { x: 0, y: 0 }, width: 100, depth: 100, height: 50,
  elevation: 2000, rotation: 0, mountType: 'ceiling', supplyZoneRatio: 0,
  properties: {
    lineKind, pipeDiameterMm: lineKind === 'gas' ? 15.88 : 9.52, insulationThicknessMm: 25,
    routePoints: nodes.map(({ x, y }) => ({ x, y })), routeNodes3d: nodes, segmentMaterials: nodes.slice(1).map(() => 'hard'),
    ...extra,
  },
} as unknown as HvacElement);

/** Gas: a long straight, a bend, a short straight. Liquid alongside it 80 mm over, with an extra short straight first. */
const GAS: PipeRouteNode3D[] = [{ x: 0, y: 0, z: 2600 }, { x: 4000, y: 0, z: 2600 }, { x: 4000, y: 1500, z: 2600 }];
const LIQUID: PipeRouteNode3D[] = [
  { x: -300, y: 80, z: 2600 }, { x: -300, y: 400, z: 2600 }, { x: -100, y: 400, z: 2600 }, { x: -100, y: 80, z: 2600 },
  { x: 3920, y: 80, z: 2600 }, { x: 3920, y: 1500, z: 2600 },
];
const bundle = { bundleId: 'b-1' };
const gas = line('gas', 'gas', GAS, bundle);
const liquid = line('liquid', 'liquid', LIQUID, bundle);
const scene = [gas, liquid];
const EMPTY_REPORT: VrfValidationReport = { issues: [], commitBlocked: false, counts: { error: 0, warning: 0, advisory: 0, information: 0 } };
const focusOn = (runId: string, key: string): SegmentFocus => ({ domain: 'refrigerant', runId, key, anchorMark: null, view: '2d' });
const issue = (code: string, entityId: string, level: VrfValidationIssue['level'] = 'error'): VrfValidationIssue => ({ id: `${code}:${entityId}`, level, code, entityId, message: code });

describe('the refrigerant segment provider', () => {
  const provider = createRefrigerantSegmentProvider({ report: EMPTY_REPORT });
  const gasLine = refrigerantLineOf(gas, scene)!;
  const straight = gasLine.pieces.find((piece) => piece.kind === 'straight')!;
  const bend = gasLine.pieces.find((piece) => piece.kind === 'bend')!;

  it('heads a piece with its line, kind and number, a short tag and the line\'s colour', () => {
    const model = provider.model(scene, focusOn('gas', straight.key))!;
    expect(provider.domain).toBe('refrigerant');
    expect(provider.testIdPrefix).toBe('refrigerant-segment');
    expect(model.head.title).toBe('Gas · Straight 1');
    expect(model.head.tag).toBe('G-S1');
    expect(model.head.size).toBe('Ø15.88 (5/8″)');
    expect(model.head.tone).toContain('orange');
    expect(provider.model(scene, focusOn('liquid', refrigerantLineOf(liquid, scene)!.pieces[0]!.key))!.head.tone).toContain('blue');
    expect(provider.model(scene, focusOn('gas', bend.key))!.head.title).toBe('Gas · Bend 1');
  });

  it('sorts its options into Swap, Add and the Edit tab, and steps along the line', () => {
    const model = provider.model(scene, focusOn('gas', straight.key))!;
    const tabOf = (group: string) => model.options.filter((option) => option.group === group).map((option) => model.tabOf(option));
    expect(new Set(tabOf('size'))).toEqual(new Set(['swap']));
    expect(new Set(tabOf('material'))).toEqual(new Set(['swap']));
    expect(new Set(tabOf('add-point'))).toEqual(new Set(['add']));
    // A straight's level, offset and insulation are the Edit tab's own fields and chips.
    for (const group of ['level', 'offset', 'insulation']) expect(new Set(tabOf(group))).toEqual(new Set([null]));
    const host = { evaluate: model.evaluate, evaluations: new Map(), onPreview: () => undefined, onHover: () => undefined, onApply: () => undefined, result: () => null };
    expect(model.edit(host)).not.toBeNull();
    expect(model.neighbour(1)).toEqual({ key: bend.key, anchorMark: null });
    expect(model.neighbour(-1)).toBeNull();
    const bendModel = provider.model(scene, focusOn('gas', bend.key))!;
    expect(bendModel.options.some((option) => option.group === 'construction' && bendModel.tabOf(option) === 'swap')).toBe(true);
    expect(bendModel.options.some((option) => option.group === 'remove-bend' && bendModel.tabOf(option) === 'add')).toBe(true);
  });

  it('reads in IP: the tube by its inch name, insulation in inches, the checks with their IP figures', () => {
    const report = { ...EMPTY_REPORT, issues: [{ ...issue('PIPE_LENGTH', 'gas'), message: 'Total routed length 92340 mm exceeds 90000 mm.' }] };
    const model = createRefrigerantSegmentProvider({ report, unitSystem: 'ip' }).model(scene, focusOn('gas', straight.key))!;
    const titles = (group: string) => model.options.filter((option) => option.group === group).map((option) => option.title);
    expect(model.head.size).toBe('5/8″ (Ø15.88)');
    expect(titles('size')).toEqual(['1/2″ (Ø12.70)', '5/8″ (Ø15.88)', '3/4″ (Ø19.05)']);
    expect(titles('insulation')).toEqual(['1 in', '1-1/4 in', '1-1/2 in', '2 in']);
    expect(model.issues.map((line) => line.message)).toEqual(['Total routed length 92340 mm (303.0 ft) exceeds 90000 mm (295.3 ft).']);
    // SI reads as it did.
    expect(provider.model(scene, focusOn('gas', straight.key))!.options.filter((option) => option.group === 'insulation').map((option) => option.title))
      .toEqual(['25 mm', '32 mm', '38 mm', '50 mm']);
  });

  it('commits through the drawing\'s command (one undo) and recommends the profile\'s size', () => {
    expect(typeof provider.commit).toBe('function');
    expect(provider.recommendedBadge).toBe('recommended');
    const model = provider.model(scene, focusOn('gas', straight.key))!;
    const ranked = provider.rank!(model.options, new Map());
    // With no sizing table, nothing is recommended.
    expect([...ranked.values()].flat()).not.toContain('recommended');
  });

  it('reads a piece once per drawing and closes on a piece that is gone', () => {
    expect(provider.model(scene, focusOn('gas', straight.key))).toBe(provider.model(scene, focusOn('gas', straight.key)));
    expect(provider.model(scene, focusOn('gas', 'leg:none'))).toBeNull();
    expect(provider.model(scene, focusOn('nope', straight.key))).toBeNull();
  });

  it('keeps its piece after an edit, else the piece of its kind and number, else closes', () => {
    const focus = focusOn('gas', straight.key);
    expect(provider.rekey(scene, focus, { kind: 'straight', ordinal: 1 })).toBe(focus);
    expect(provider.rekey(scene, focusOn('gas', 'leg:gone'), { kind: 'bend', ordinal: 1 })?.key).toBe(bend.key);
    expect(provider.rekey(scene, focusOn('gas', 'leg:gone'), { kind: 'riser', ordinal: 1 })).toBeNull();
  });

  it('finds the pair\'s other line by its bundle, and the piece running alongside, not the one of the same number', () => {
    expect(partnerOf(gas, scene)?.id).toBe('liquid');
    expect(partnerOf(liquid, scene)?.id).toBe('gas');
    expect(partnerOf(line('lone', 'gas', GAS), scene)).toBeNull();
    const liquidLine = refrigerantLineOf(liquid, scene)!;
    const alongside = matchingPiece(liquidLine, straight)!;
    expect(alongside.kind).toBe('straight');
    // The liquid's first straights are short ones of its own; the long one beside the gas straight is the match.
    expect(alongside.lengthMm).toBeGreaterThan(3000);
    expect(alongside.ordinal).not.toBe(straight.ordinal);
  });

  it('puts a design check on the piece it is about: a port stub\'s on the port, a run\'s on every piece', () => {
    const unit = { ...line('odu', 'gas', GAS), id: 'odu', type: 'outdoor-unit' } as HvacElement;
    const ported = line('gas', 'gas', GAS, { startConnection: { connectionKind: 'unit-port', sourceElementId: 'odu', portPoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, elevationMm: 2600 } });
    const portScene = [unit, ported];
    const portLine = refrigerantLineOf(ported, portScene)!;
    const report: VrfValidationReport = { ...EMPTY_REPORT, issues: [issue('PORT_STUB', 'gas'), issue('PIPE_SIZE', 'gas', 'warning'), issue('INSULATION', 'other'), issue('SLOPE', 'gas', 'advisory')] };
    const port = portLine.pieces.find((piece) => piece.kind === 'port')!;
    const run = portLine.pieces.find((piece) => piece.kind === 'straight')!;
    expect(pieceIssues(report, ported, portLine, port).map((line) => line.code)).toEqual(['PORT_STUB', 'PIPE_SIZE']);
    expect(pieceIssues(report, ported, portLine, run).map((line) => line.code)).toEqual(['PIPE_SIZE']);
  });
});

describe('a branch kit\'s card', () => {
  const kit = {
    id: 'kit-1', type: 'refrigerant-branch-kit', label: 'Copper Branch Kit (Gas)', modelLabel: 'DIS-22-1G Gas', subtype: 'dis-22-1g',
    position: { x: 1000, y: 1000 }, width: 441, depth: 170, height: 120, elevation: 2400, rotation: 180, mountType: 'ceiling', supplyZoneRatio: 0,
    properties: { branchKitLineKind: 'gas', branchKitRollDeg: 180 },
  } as unknown as HvacElement;

  it('knows the kit\'s ports and draws an outline round them', () => {
    const shape = refrigerantKitOf(kit)!;
    expect(shape.lines).toEqual(['gas']);
    expect(shape.model).toBe('DIS-22-1G Gas');
    expect(shape.rollDeg).toBe(180);
    const inside = (point: { x: number; y: number }) => {
      // The outline is convex and counter-clockwise: every port is on its inner side of every edge.
      const outline = shape.outline;
      return outline.every((a, index) => {
        const b = outline[(index + 1) % outline.length]!;
        return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) >= -1e-6;
      });
    };
    for (const port of [shape.ports[0]!.inlet, shape.ports[0]!.run, shape.ports[0]!.branch, shape.centre]) expect(inside(port)).toBe(true);
    expect(refrigerantKitOf(line('gas', 'gas', GAS))).toBeNull();
  });

  it('heads the kit with its model, its line and how it sits, and a short tag', () => {
    const provider = createRefrigerantSegmentProvider({ report: { ...EMPTY_REPORT, issues: [issue('BRANCH_TILT', 'kit-1', 'warning'), issue('PIPE_SIZE', 'gas')] } });
    const model = provider.model([kit], focusOn('kit-1', KIT_KEY))!;
    expect(model.head.title).toBe('Branch kit · DIS-22-1G');
    expect(model.head.size).toBe('Gas line');
    expect(model.head.detail).toBe('branch turned over');
    expect(model.head.tag).toBe('G-Y1');
    expect(model.issues.map((line) => line.code)).toEqual(['BRANCH_TILT']);
    expect(provider.rekey([kit], focusOn('kit-1', KIT_KEY), null)?.key).toBe(KIT_KEY);
    expect(provider.rekey([], focusOn('kit-1', KIT_KEY), null)).toBeNull();
  });

  it('puts turning it over and other models in Swap, and the slide along its run on its Edit tab', () => {
    const provider = createRefrigerantSegmentProvider({ report: EMPTY_REPORT });
    const model = provider.model([kit], focusOn('kit-1', KIT_KEY))!;
    const tabs = (group: string) => [...new Set(model.options.filter((option) => option.group === group).map((option) => model.tabOf(option)))];
    expect(tabs('kit-flip')).toEqual(['swap']);
    expect(tabs('kit-model')).toEqual(['swap']);
    expect(tabs('kit-slide')).toEqual([null]);
    const host = { evaluate: model.evaluate, evaluations: new Map(), onPreview: () => undefined, onHover: () => undefined, onApply: () => undefined, result: () => null };
    expect(model.edit(host)).not.toBeNull();
    // No pipe holds this kit: it can be turned back over.
    const flip = model.options.find((option) => option.group === 'kit-flip')!;
    expect(model.evaluate(flip).updates[0]!.properties.branchKitRollDeg).toBe(0);
  });
});

describe('a refrigerant line in its inspector', () => {
  it("lists its pieces with the card's tags, lengths and angles", () => {
    const gas = line('gas', 'gas', GAS);
    const rows = refrigerantPieceRows(gas, [gas]);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => /^G-[PSRB]\d+$/.test(row.tag))).toBe(true);
    const bend = rows.find((row) => row.title.startsWith('Bend'));
    if (bend) expect(bend.detail).toMatch(/^\d+°$/);
    expect(rows.filter((row) => row.title.startsWith('Straight')).every((row) => /^\d+\.\d\d m$/.test(row.detail))).toBe(true);
  });
});
