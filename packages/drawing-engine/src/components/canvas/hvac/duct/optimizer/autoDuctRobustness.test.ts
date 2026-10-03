/**
 * The auto duct pieces that make 4, 5, 6 … terminals work: the spigot side
 * the optimiser may choose, runouts kept clear of other equipment, terminals
 * grouped for the grouped router, the turn-first root off a short collar
 * straight, and the store updates that turn spigots.
 */
import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../../types';
import { resolveUnitAirPorts } from '../ductAirPorts';
import { flexClear, spigotVariants, type Frame, type ServiceCtx, type TerminalCtx } from '../ductAutoContext';
import { generateAutoDuct, inspectAutoDuctContexts, terminalSpigotUpdates, type AutoDuctRequest } from '../ductAutoLayout';
import { sectionSheetMm } from '../ductEconomics';
import { resolveDuctSettings } from '../ductSettings';
import { readDuctTerminalSpec, terminalEnvelope, typicalTerminalSpec } from '../ductTerminals';
import { readDuctRunSpec } from '../ductTypes';

import { allRuns } from './designTree';
import { buildRoutingGraph } from './routingGraph';
import { SizingModel } from './sizingModel';
import { groupTerminals, routeTrees } from './steinerArborescence';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
/** A point `along` the supply collar's axis and `across` it (mm). */
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });

function diffuser(id: string, centre: Point2D, rotation: number): HvacElement {
  const spec = typicalTerminalSpec('square-4way', 200);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}

const request = (ids: string[]): AutoDuctRequest => ({
  unitId: 'u', terminalIds: ids, fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: false }, rebuildExisting: false, shape: 'optimal',
});

/** The service context the optimiser builds (the run stops once it is made). */
function contextOf(terminals: HvacElement[]): ServiceCtx {
  let captured: ServiceCtx | null = null;
  inspectAutoDuctContexts((ctx) => { captured = ctx; throw new Error('captured'); });
  try {
    generateAutoDuct([unit, ...terminals], request(terminals.map((terminal) => terminal.id)), settings);
  } catch {
    // Stopped on purpose: only the context is wanted.
  } finally {
    inspectAutoDuctContexts(null);
  }
  return captured!;
}

describe('spigot sides the optimiser may choose', () => {
  it('offers the sides with room in front, the one facing the trunk first; the placed side for a slot', () => {
    const ctx = contextOf([diffuser('a', S(3000, 1500), 0), diffuser('b', S(3000, -1500), 0)]);
    for (const terminal of ctx.terminals) {
      expect(terminal.variants!.length).toBeGreaterThanOrEqual(2);
      expect(terminal.variants!.length).toBeLessThanOrEqual(3);
      expect(terminal.variants!.some((variant) => !variant.turnedTo)).toBe(true);
      // Off the collar's axis: the best side faces back towards it.
      expect(terminal.variants![0]!.normal.y * Math.sign(terminal.lip.y)).toBeLessThan(0);
    }
    // Close neighbours (a 350 mm gap): no side that faces straight into the next box.
    const tight = contextOf([diffuser('l', S(2000, -950), 0), diffuser('m', S(2000), 0), diffuser('r', S(2000, 950), 0)]);
    const middle = tight.terminals.find((terminal) => terminal.element.id === 'm')!;
    expect(middle.variants!.every((variant) => Math.abs(variant.normal.y) < 0.5)).toBe(true);
    const frame: Frame = ctx.frame;
    const slot = { ...ctx.terminals[0]!, spec: { ...ctx.terminals[0]!.spec, kind: 'linear-slot' } } as TerminalCtx;
    expect(spigotVariants(frame, slot, true)).toHaveLength(1);
    expect(spigotVariants(frame, ctx.terminals[0]!, false)).toHaveLength(1);
  });

  it('turns a spigot in the store by its terminal properties only', () => {
    const element = diffuser('a', S(3000, 1500), 0);
    const turned = { ...element, properties: { terminal: { ...(element.properties.terminal as object), spigotSide: 'left' } } };
    const [update] = terminalSpigotUpdates([turned]);
    expect(update!.id).toBe('a');
    expect(Object.keys(update!.updates)).toEqual(['properties']);
    expect(readDuctTerminalSpec({ ...element, ...update!.updates })!.spigotSide).toBe('left');
  });
});

describe('runouts run clear of other equipment', () => {
  const frame: Frame = { origin: { x: 0, y: 0 }, n: { x: 1, y: 0 }, t: { x: 0, y: 1 } };
  const terminal = {
    element: { id: 't' }, neck: 200, lip: { x: 2000, y: 0 }, normal: { x: -1, y: 0 },
    port: { lip: { x: 2000, y: 0, z: 2600 }, normal: { x: -1, y: 0, z: 0 } },
  } as unknown as TerminalCtx;
  const ctx = (obstacles: ServiceCtx['obstacles']) => ({ frame, obstacles, settings, bottomZ: 2500 }) as unknown as ServiceCtx;
  const box = { minX: 1400, maxX: 1600, minY: -100, maxY: 100, zMin: 2400, zMax: 2800 };

  it('refuses a runout through another box, not through its own terminal, and not one that passes above', () => {
    expect(flexClear(ctx([]), { x: 1000, y: 0 }, { x: 1, y: 0 }, 2500, terminal)).toBe(true);
    expect(flexClear(ctx([{ ...box, id: 'other' }]), { x: 1000, y: 0 }, { x: 1, y: 0 }, 2500, terminal)).toBe(false);
    expect(flexClear(ctx([{ ...box, id: 't' }]), { x: 1000, y: 0 }, { x: 1, y: 0 }, 2500, terminal)).toBe(true);
    expect(flexClear(ctx([{ ...box, id: 'other', zMin: 3000, zMax: 3200 }]), { x: 1000, y: 0 }, { x: 1, y: 0 }, 2500, terminal)).toBe(true);
  });
});

describe('the grouped router', () => {
  it('groups a 4 × 3 grid by rows across the collar axis, at most four each, every terminal once', () => {
    const terminals = [1500, 3900, 6300].flatMap((x) => [-4050, -1350, 1350, 4050].map((y) => ({ lip: { x, y } }))) as unknown as TerminalCtx[];
    const groups = groupTerminals(terminals, 4);
    expect(groups).toHaveLength(3);
    expect(groups.flat().sort((a, b) => a - b)).toEqual(terminals.map((_, index) => index));
    for (const group of groups) {
      expect(group.length).toBeLessThanOrEqual(4);
      expect(new Set(group.map((index) => terminals[index]!.lip.x)).size).toBe(1);
    }
    // A long row is cut into balanced runs across.
    const row = Array.from({ length: 10 }, (_, index) => ({ lip: { x: 3000, y: index * 1500 } })) as unknown as TerminalCtx[];
    expect(groupTerminals(row, 4).map((group) => group.length)).toEqual([3, 4, 3]);
  });
});

describe('terminals reachable by flexible take-offs', () => {
  it('routes a terminal even when it has no rigid runout candidates', () => {
    const ctx = contextOf([diffuser('a', S(1800, 1500), 0)]);
    const model = new SizingModel(ctx, 'rect', ctx.airflowM3h);
    const graph = buildRoutingGraph(ctx, model, 1000, 600);
    // A nearby terminal can have no usable grid leaf while a flex take-off
    // from the trunk still reaches its spigot within the bend/length limits.
    graph.leaves[0] = [];
    const solution = routeTrees(ctx, model, graph, {
      lambda: model.pricePerPa, label: 'Flex take-off', fanOutletMm: 1000,
      shortOutletPenaltyPa: 0, maxTerminals: settings.autoExactTerminals,
    });
    expect(solution?.designs.length).toBeGreaterThan(0);
    for (const design of solution!.designs) {
      const ends = allRuns(design.root).filter((run) => run.end.kind === 'terminal');
      expect(ends).toHaveLength(1);
      expect(ends[0]!.allFlex).toBe(true);
      expect(ends[0]!.end).toMatchObject({ kind: 'terminal', terminal: { element: { id: 'a' } } });
    }
  });

  it('still refuses a terminal with neither a rigid route nor a permitted flex connection', () => {
    const captured = contextOf([diffuser('a', S(1800, 1500), 0)]);
    const ctx = { ...captured, settings: { ...captured.settings, flexMaxLengthMm: 1 } };
    const model = new SizingModel(ctx, 'rect', ctx.airflowM3h);
    const graph = buildRoutingGraph(ctx, model, 1000, 600);
    expect(graph.leaves[0]).toHaveLength(0);
    expect(routeTrees(ctx, model, graph, {
      lambda: model.pricePerPa, label: 'No connection', fanOutletMm: 1000,
      shortOutletPenaltyPa: 0, maxTerminals: settings.autoExactTerminals,
    })).toBeNull();
  });
});

describe('a short collar straight', () => {
  it('turns first at the collar\'s own section when a diffuser stands in front of it, and builds clean', () => {
    const line = [1500, 3000, 4500].map((along, index) => diffuser(`d${index + 1}`, S(along), 180));
    const result = generateAutoDuct([unit, ...line], request(line.map((element) => element.id)), settings);
    const design = result.designs[result.selected]!;
    expect(design.errors).toBe(0);
    expect(design.label).not.toMatch(/equal friction/);
    const root = design.runs.map((run) => readDuctRunSpec(run)!).find((spec) => spec.start.kind === 'unit-port')!;
    // The first leg at the collar's section, its elbow square vaned (the transition comes after it).
    expect(root.legs[0]).toMatchObject({ widthMm: port.widthMm, heightMm: port.heightMm });
    expect(Object.values(root.nodeOverrides ?? {}).some((override) => override.elbowStyle === 'square-vaned')).toBe(true);
  }, 60000);
});

describe('four diffusers dropped as they come (the case that used to fail)', () => {
  it('a 2 × 2 grid gets a clean, verified design that serves every diffuser, turning spigots as it needs', () => {
    const grid = [1800, 4200].flatMap((along) => [-1500, 1500].map((across) => S(along, across)))
      .map((centre, index) => diffuser(`g${index + 1}`, centre, 0));
    const result = generateAutoDuct([unit, ...grid], request(grid.map((element) => element.id)), settings);
    const design = result.designs[result.selected]!;
    expect(design.errors).toBe(0);
    expect(design.label).not.toMatch(/equal friction/);
    const served = new Set(result.runs.flatMap((run) => {
      const end = readDuctRunSpec(run)?.end;
      return end?.kind === 'terminal' ? [end.terminalId] : [];
    }));
    expect([...served].sort()).toEqual(grid.map((element) => element.id).sort());
    expect(result.terminalUpdates.length).toBeGreaterThan(0);
  }, 60000);
});

describe('cached section gauges', () => {
  it('return the same sheet as resolving afresh', () => {
    const context = { service: 'supply' as const, construction: settings.defaultConstruction, settings };
    const first = sectionSheetMm({ widthMm: 600, heightMm: 250 }, context);
    expect(sectionSheetMm({ widthMm: 600, heightMm: 250 }, context)).toBe(first);
    expect(sectionSheetMm({ widthMm: 600, heightMm: 250 }, { ...context, settings: resolveDuctSettings({}) })).toBe(first);
  });
});
