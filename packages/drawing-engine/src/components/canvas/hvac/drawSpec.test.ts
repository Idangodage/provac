import { beforeEach, describe, expect, it } from 'vitest';

import { useSmartDrawingStore } from '../../../store';
import type { HvacElement } from '../../../types';

import { useDrainDrawStore } from './condensate/drainDrawSession';
import { activeDrawKind, armDrawKind, armDrawSpec } from './drawArm';
import { drawSpecOf } from './drawSpec';
import { useDuctToolStore } from './duct/ductToolStore';
import { buildDuctRunElement, type DuctRunSpec } from './duct/ductTypes';

function ductRun(id: string, overrides: Partial<DuctRunSpec> = {}): HvacElement {
  const spec: DuctRunSpec = {
    version: 1, service: 'supply', construction: 'gi-nbr',
    path: [{ x: 0, y: 0, z: 2700 }, { x: 3000, y: 0, z: 2700 }, { x: 3000, y: 2000, z: 2900 }],
    legs: [{ widthMm: 400, heightMm: 250 }, { widthMm: 300, heightMm: 250 }],
    insulationThicknessMm: 25, pressureClassPa: null, jointSystem: null,
    start: { kind: 'open' }, end: { kind: 'end-cap' }, nodeOverrides: {}, locked: false,
    ...overrides,
  };
  return { id, rotation: 0, supplyZoneRatio: 0, ...buildDuctRunElement(spec) } as HvacElement;
}

function pipe(id: string, lineKind: 'gas' | 'liquid', diameterMm: number, bundleId: string | null, material: 'hard' | 'flexible'): HvacElement {
  return {
    id, type: 'refrigerant-pipe', position: { x: 0, y: 0 }, rotation: 0, width: 10, depth: 10, height: 10, elevation: 2800,
    mountType: 'ceiling', label: id, supplyZoneRatio: 0,
    properties: {
      lineKind, pipeDiameterMm: diameterMm, insulationThicknessMm: 32, routePoints: [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 1500 }],
      segmentMaterials: [material, material], ...(bundleId ? { bundleId } : {}),
    },
  };
}

function drain(id: string, properties: Record<string, unknown> = {}): HvacElement {
  return {
    id, type: 'condensate-pipe', position: { x: 0, y: 0 }, rotation: 0, width: 10, depth: 10, height: 10, elevation: 2600,
    mountType: 'ceiling', label: id, supplyZoneRatio: 0,
    properties: {
      routePoints: [{ x: 0, y: 0 }, { x: 2000, y: 0 }], nominalSize: '32', outerDiameterMm: 32, insulationThicknessMm: 9,
      designSlopePercent: 2, segmentRole: 'main', ...properties,
    },
  };
}

beforeEach(() => {
  useSmartDrawingStore.getState().setTool('select');
  useDrainDrawStore.setState({ armed: false, fallPercent: null, session: null });
  useDuctToolStore.setState({ sizeMode: 'collar', branchShape: 'rect', freeService: 'supply', freeBottomMm: 2700, like: null });
});

describe('what is selected, to draw more of', () => {
  it('a duct: its service, the picked leg\'s section and level, its construction', () => {
    const run = ductRun('d-1', { service: 'return' });
    const first = drawSpecOf(run, [run], 'si')!;
    expect(first).toMatchObject({ kind: 'return-duct', title: 'Return duct' });
    expect(first.chips).toEqual(['Rect 400×250', 'Bottom 2.70 m', 'GI + NBR 25 mm']);
    const second = drawSpecOf(run, [run], 'si', 1)!;
    expect(second.chips[0]).toBe('Rect 300×250');
    expect(second.arm).toMatchObject({ tool: 'duct', service: 'return', section: { widthMm: 300, heightMm: 250 }, bottomMm: 2700, construction: 'gi-nbr', insulationMm: 25 });
    // Inches and feet in IP; a round, bare duct.
    const round = ductRun('d-2', { construction: 'gi-bare', insulationThicknessMm: 0, legs: [{ widthMm: 254, heightMm: 254, diameterMm: 254 }, { widthMm: 254, heightMm: 254, diameterMm: 254 }] });
    expect(drawSpecOf(round, [round], 'ip')!.chips).toEqual(['Round Ø10 in', 'Bottom 8.9 ft', 'GI, bare']);
  });

  it('a refrigerant line: a pair\'s two sizes, or one line\'s, its copper', () => {
    const gas = pipe('g', 'gas', 15.88, 'b-1', 'hard');
    const liquid = pipe('l', 'liquid', 9.52, 'b-1', 'hard');
    const pair = drawSpecOf(liquid, [gas, liquid], 'si')!;
    expect(pair).toMatchObject({ kind: 'pair', title: 'Gas + liquid', arm: { tool: 'refrigerant-pipe', lineMode: 'pair', material: 'hard' } });
    expect(pair.chips).toEqual(['15.88 + 9.52 mm', 'Insul 32 mm', 'Hard copper']);
    expect(drawSpecOf(gas, [gas, liquid], 'ip')!.chips[0]).toBe('5/8″ + 3/8″');
    const alone = pipe('a', 'liquid', 6.35, null, 'flexible');
    expect(drawSpecOf(alone, [alone], 'si')).toMatchObject({ kind: 'liquid', chips: ['6.35 mm', 'Insul 32 mm', 'Soft copper'], arm: { lineMode: 'liquid', material: 'flexible' } });
  });

  it('a drain: its size and its network\'s fall', () => {
    const run = drain('cd-1', { designFallPercent: 2 });
    const spec = drawSpecOf(run, [run], 'si')!;
    expect(spec).toMatchObject({ kind: 'drain', title: 'Drain', arm: { tool: 'drain', fallPercent: 2 } });
    expect(spec.chips).toEqual(['CD 32', 'Fall 1:50', 'Insul 9 mm']);
    expect(drawSpecOf(run, [run], 'ip')!.chips[1]).toBe('Fall 1/4 in/ft');
  });

  it('anything else: nothing', () => {
    const unit = { ...drain('u'), type: 'ceiling-cassette-ac' } as HvacElement;
    expect(drawSpecOf(unit, [unit], 'si')).toBeNull();
  });
});

describe('arming a tool', () => {
  it('Draw like this: the duct tool set to draw exactly the duct', () => {
    const run = ductRun('d-1', { service: 'return' });
    armDrawSpec(drawSpecOf(run, [run], 'si', 1)!);
    const tool = useDuctToolStore.getState();
    expect(useSmartDrawingStore.getState().activeTool).toBe('duct');
    expect(tool).toMatchObject({ freeService: 'return', freeBottomMm: 2700, branchShape: 'rect', branchWidthMm: 300, branchHeightMm: 250, sizeMode: 'custom', widthMm: 300, heightMm: 250 });
    expect(tool.like).toEqual({ construction: 'gi-nbr', insulationMm: 25 });
    expect(activeDrawKind({ activeTool: 'duct', refrigerantPipeLineMode: 'pair' }, tool, useDrainDrawStore.getState())).toBe('return-duct');
  });

  it('Draw like this: a round duct takes the round section, from a collar its own', () => {
    const run = ductRun('d-2', { legs: [{ widthMm: 250, heightMm: 250, diameterMm: 250 }, { widthMm: 250, heightMm: 250, diameterMm: 250 }] });
    armDrawSpec(drawSpecOf(run, [run], 'si')!);
    expect(useDuctToolStore.getState()).toMatchObject({ branchShape: 'round', branchDiameterMm: 250, sizeMode: 'collar' });
  });

  it('Draw like this: the pipe tool with the lines and copper', () => {
    const gas = pipe('g', 'gas', 15.88, null, 'hard');
    armDrawSpec(drawSpecOf(gas, [gas], 'si')!);
    const state = useSmartDrawingStore.getState();
    expect(state).toMatchObject({ activeTool: 'refrigerant-pipe', refrigerantPipeLineMode: 'gas', refrigerantPipeDrawMode: 'hard' });
  });

  it('Draw like this: the drain tool, with the drain\'s fall for a network it starts', () => {
    const run = drain('cd-1', { designFallPercent: 2 });
    useSmartDrawingStore.setState({ hvacElements: [run] });
    armDrawSpec(drawSpecOf(run, [run], 'si')!);
    expect(useDrainDrawStore.getState()).toMatchObject({ armed: true, fallPercent: 2, session: null });
    expect(activeDrawKind({ activeTool: 'select', refrigerantPipeLineMode: 'pair' }, useDuctToolStore.getState(), useDrainDrawStore.getState())).toBe('drain');
  });

  it('a tile: the tool of its kind with the project\'s construction', () => {
    useDuctToolStore.getState().setLike({ construction: 'gi-nbr', insulationMm: 25 });
    armDrawKind('supply-duct');
    expect(useDuctToolStore.getState()).toMatchObject({ freeService: 'supply', like: null });
    armDrawKind('liquid');
    expect(useSmartDrawingStore.getState()).toMatchObject({ activeTool: 'refrigerant-pipe', refrigerantPipeLineMode: 'liquid' });
    armDrawKind('drain');
    expect(useDrainDrawStore.getState().armed).toBe(true);
  });
});
