/**
 * Auto duct benchmark: the layouts a designer actually draws — rows across the
 * unit, lines on its axis, office grids from 2×2 to 4×3, diffusers dropped as
 * they come (spigot facing away) or turned to the unit, with return grilles,
 * and systems spanning rooms (through a partition, two bedrooms off a
 * corridor) — each must come out as a verified design without errors, serving
 * every terminal, in reasonable time; a system spanning rooms passes only
 * interior walls, by sleeve. The acceptance gate for the optimiser.
 */
import { afterAll, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../../types';
import { resolveUnitAirPorts } from '../ductAirPorts';
import { generateAutoDuct, type AutoDuctResult, type AutoDuctShape } from '../ductAutoLayout';
import type { DuctWallInput } from '../ductBuilding';
import { DEFAULT_DUCT_SETTINGS } from '../ductSettings';
import { terminalEnvelope, typicalTerminalSpec, type DuctTerminalKind } from '../ductTerminals';
import { readDuctRunSpec } from '../ductTypes';

/** Per layout, in the test runner (the worker is faster): a regression guard, not the product target. */
const BUDGET_MS = 30000;

/**
 * About 4½ minutes, and its outcome depends on the time budget, so on how
 * loaded the machine is: run on its own, on request —
 * `DUCT_BENCHMARK=1 npx vitest run src/components/canvas/hvac/duct/optimizer/autoDuctBenchmark.test.ts`.
 * The default suite keeps a quick smoke test (`autoDuctRobustness.test.ts`).
 */
const ENABLED = Boolean((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.DUCT_BENCHMARK);

const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const ports = resolveUnitAirPorts(unit);
const supplyLip = ports.find((port) => port.kind === 'supply')!.lip;
const returnLip = ports.find((port) => port.kind === 'return')!.lip;
/** Ahead of the supply collar (−Y) by `along`, across by `across` (+X). */
const S = (along: number, across = 0): Point2D => ({ x: supplyLip.x + across, y: supplyLip.y - along });
/** Behind the return collar (+Y). */
const R = (along: number, across = 0): Point2D => ({ x: returnLip.x + across, y: returnLip.y + along });

function terminal(id: string, centre: Point2D, rotation: number, kind: DuctTerminalKind = 'square-4way', neck = 200): HvacElement {
  const spec = typicalTerminalSpec(kind, neck);
  const envelope = terminalEnvelope(spec);
  return {
    id, type: spec.service === 'return' ? 'return-grille' : 'diffuser',
    position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}

/** Rotation that turns the spigot (normal (sin θ, −cos θ)) towards the supply collar, to 90°. */
function towardUnit(at: Point2D): number {
  const degrees = (Math.atan2(supplyLip.x - at.x, -(supplyLip.y - at.y)) * 180) / Math.PI;
  return ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
}

type Spigots = 'dropped' | 'toward';
/** A building for a system spanning rooms: its walls, its rooms, which room a point is in, and the sleeves expected at least. */
interface Building { walls: DuctWallInput[]; rooms: Array<{ id: string; vertices: Point2D[] }>; roomOf: (at: Point2D) => string; sleeves: number }
interface Layout { name: string; supply: Point2D[]; returns?: Point2D[]; spigots: Spigots; building?: Building }

const row = (k: number, along: number, pitch: number) => Array.from({ length: k }, (_, i) => S(along, (i - (k - 1) / 2) * pitch));
const line = (k: number, along0: number, pitch: number) => Array.from({ length: k }, (_, i) => S(along0 + i * pitch));
const grid = (cols: number, rows: number, along0: number, pitchAlong: number, pitchAcross: number) =>
  Array.from({ length: rows }, (_, j) => Array.from({ length: cols }, (_, i) => S(along0 + j * pitchAlong, (i - (cols - 1) / 2) * pitchAcross))).flat();

const LAYOUTS: Layout[] = [];
for (const spigots of ['dropped', 'toward'] as const) {
  for (const k of [2, 3, 4, 5, 6, 8]) {
    LAYOUTS.push({ name: `row of ${k}`, supply: row(k, 2500, 2400), spigots });
    LAYOUTS.push({ name: `line of ${k} on the axis`, supply: line(k, 1500, 1500), spigots });
  }
  LAYOUTS.push({ name: 'grid 2×2', supply: grid(2, 2, 1800, 2400, 3000), spigots });
  LAYOUTS.push({ name: 'grid 3×2', supply: grid(3, 2, 1800, 2400, 2700), spigots });
  LAYOUTS.push({ name: 'grid 2×3', supply: grid(2, 3, 1500, 2000, 3000), spigots });
  LAYOUTS.push({ name: 'grid 3×3', supply: grid(3, 3, 1500, 2000, 2500), spigots });
  LAYOUTS.push({ name: 'grid 4×3', supply: grid(4, 3, 1500, 2200, 2400), spigots });
  LAYOUTS.push({ name: 'grid 2×2 + 1 return', supply: grid(2, 2, 1800, 2400, 3000), returns: [R(1500)], spigots });
  LAYOUTS.push({ name: 'grid 3×2 + 2 returns', supply: grid(3, 2, 1800, 2400, 2700), returns: [R(1500, -1500), R(1500, 1500)], spigots });
  LAYOUTS.push({ name: 'beyond a partition: 1 + 2 + 1 return', supply: [S(1500, 1500), S(4500, -1500), S(4500, 1500)], returns: [R(1500)], spigots, building: partitioned() });
  LAYOUTS.push({ name: 'two bedrooms off a corridor', supply: [S(4300, -2000), S(4300, 2000)], spigots, building: corridor() });
}

function wallOf(id: string, a: Point2D, b: Point2D, thickness: number): DuctWallInput {
  return { id, startPoint: a, endPoint: b, thickness, baseZ: 0, topZ: 3000, structural: thickness >= 200, material: thickness >= 200 ? 'brick' : 'partition' };
}
/** A rectangle's corners (an outline). */
function box(x0: number, y0: number, x1: number, y1: number): Point2D[] {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

/** The unit's room, and a room beyond a partition 2.5 m in front of its supply collar. */
function partitioned(): Building {
  const [left, right, far, back] = [supplyLip.x - 4500, supplyLip.x + 4500, supplyLip.y - 7000, returnLip.y + 2500];
  const at = supplyLip.y - 2500;
  return {
    walls: [
      wallOf('north', { x: left, y: back }, { x: right, y: back }, 200), wallOf('south', { x: left, y: far }, { x: right, y: far }, 200),
      wallOf('west', { x: left, y: far }, { x: left, y: back }, 200), wallOf('east', { x: right, y: far }, { x: right, y: back }, 200),
      wallOf('partition', { x: left, y: at }, { x: right, y: at }, 100),
    ],
    rooms: [{ id: 'r', vertices: box(left + 100, at + 50, right - 100, back - 100) }, { id: 'beyond', vertices: box(left + 100, far + 100, right - 100, at - 50) }],
    roomOf: (point) => (point.y > at ? 'r' : 'beyond'),
    sleeves: 1,
  };
}

/** The unit in a corridor; two bedrooms beyond the corridor wall 2 m in front of the collar, a partition between them. */
function corridor(): Building {
  const [left, right, far, back] = [supplyLip.x - 4000, supplyLip.x + 4000, supplyLip.y - 6500, returnLip.y + 2500];
  const at = supplyLip.y - 2000;
  return {
    walls: [
      wallOf('north', { x: left, y: back }, { x: right, y: back }, 200), wallOf('south', { x: left, y: far }, { x: right, y: far }, 200),
      wallOf('west', { x: left, y: far }, { x: left, y: back }, 200), wallOf('east', { x: right, y: far }, { x: right, y: back }, 200),
      wallOf('corridor', { x: left, y: at }, { x: right, y: at }, 100), wallOf('between', { x: supplyLip.x, y: far }, { x: supplyLip.x, y: at }, 100),
    ],
    rooms: [
      { id: 'r', vertices: box(left + 100, at + 50, right - 100, back - 100) },
      { id: 'bedroom-1', vertices: box(left + 100, far + 100, supplyLip.x - 50, at - 50) },
      { id: 'bedroom-2', vertices: box(supplyLip.x + 50, far + 100, right - 100, at - 50) },
    ],
    roomOf: (point) => (point.y > at ? 'r' : point.x < supplyLip.x ? 'bedroom-1' : 'bedroom-2'),
    sleeves: 2,
  };
}

function scene(layout: Layout): { elements: HvacElement[]; ids: string[] } {
  // In a building, each terminal is in the room it stands in.
  const inRoom = (element: HvacElement, at: Point2D): HvacElement => (layout.building ? { ...element, roomId: layout.building.roomOf(at) } : element);
  const supply = layout.supply.map((at, i) => inRoom(terminal(`sd${i + 1}`, at, layout.spigots === 'dropped' ? 0 : towardUnit(at)), at));
  const returns = (layout.returns ?? []).map((at, i) => inRoom(terminal(`rg${i + 1}`, at, layout.spigots === 'dropped' ? 0 : 180, 'return-egg-crate', 250), at));
  return { elements: [unit, ...supply, ...returns], ids: [...supply, ...returns].map((element) => element.id) };
}

function run(layout: Layout, shape: AutoDuctShape = 'optimal'): { result: AutoDuctResult; ms: number; ids: string[] } {
  const { elements, ids } = scene(layout);
  const started = Date.now();
  const result = generateAutoDuct(elements, {
    unitId: 'u', terminalIds: ids, fanSpeed: 'hi', layout: 'auto', services: { supply: true, return: true }, rebuildExisting: false, shape,
    ...(layout.building ? { walls: layout.building.walls, rooms: layout.building.rooms } : {}),
  }, DEFAULT_DUCT_SETTINGS);
  return { result, ms: Date.now() - started, ids };
}

const table: Array<Record<string, string | number>> = [];
afterAll(() => {
  // The benchmark's record: kept in the test log for comparing runs.
  if (table.length) console.log(table.map((entry) => Object.values(entry).join(' | ')).join('\n'));
});

describe.runIf(ENABLED)('auto duct benchmark: every layout within the exact search gives a clean verified design', () => {
  it.each(LAYOUTS.map((layout) => [`${layout.name} (${layout.spigots})`, layout] as const))('%s', (_label, layout) => {
    const { result, ms, ids } = run(layout);
    const design = result.designs[result.selected];
    const served = new Set(result.runs.flatMap((element) => {
      const end = readDuctRunSpec(element)?.end;
      return end?.kind === 'terminal' ? [end.terminalId] : [];
    }));
    const errors = [...result.issues, ...result.services.flatMap((service) => service.issues)]
      .filter((issue) => issue.severity === 'error').map((issue) => `${issue.code}: ${issue.message}`);
    table.push({
      layout: `${layout.name} (${layout.spigots})`, ms, designs: result.designs.length, errors: design?.errors ?? -1,
      cost: design ? Math.round(design.firstCost) : '-', esp: design ? design.requiredEspPa.toFixed(1) : '-',
      certificate: result.certificate
        ? `${result.certificate.exact ? 'exact' : result.certificate.grouped ? 'grouped' : 'heuristic'}${result.certificate.timeLimited ? ' time-limited' : ''}`
          + ` rounds ${result.certificate.rounds} r${result.certificate.routerMs} s${result.certificate.sizingMs}`
        : '-',
    });
    expect(design, errors.join(' / ')).toBeDefined();
    expect(ms).toBeLessThan(BUDGET_MS);
    if (layout.supply.length > DEFAULT_DUCT_SETTINGS.autoExactTerminals) {
      // Past the exact search (known limit): the grouped router runs and is labelled so, and a design that is
      // not clean says why in plain terms.
      expect(result.certificate?.grouped).toBe(true);
      if (design!.errors > 0) {
        expect(result.services.flatMap((service) => service.issues).some((issue) => issue.code === 'DU_AUTO_WHY')).toBe(true);
      }
      return;
    }
    expect(design!.errors, errors.join(' / ')).toBe(0);
    expect([...served].sort()).toEqual([...ids].sort());
    if (layout.building) {
      // Through interior walls only, a sleeve each (at least one per room beyond the unit's).
      const penetrations = design!.services.flatMap((service) => service.plans.flatMap((plan) => plan.penetrations));
      expect(penetrations.length).toBeGreaterThanOrEqual(layout.building.sleeves);
      expect(penetrations.every((penetration) => !penetration.exterior && !penetration.onFlex)).toBe(true);
    }
  }, 120_000);

  it('Optimal is never worse than Rectangular or Round alone (life-cycle)', () => {
    for (const layout of [LAYOUTS.find((entry) => entry.name === 'grid 2×2')!, LAYOUTS.find((entry) => entry.name === 'row of 4')!]) {
      const best = (shape: AutoDuctShape) => {
        const { result } = run(layout, shape);
        const design = result.designs[result.selected];
        return design && design.errors === 0 ? design.lifeCycleCost : Number.POSITIVE_INFINITY;
      };
      const optimal = best('optimal');
      expect(optimal).toBeLessThanOrEqual(Math.min(best('rect'), best('round')) + 1e-6);
      expect(Number.isFinite(optimal)).toBe(true);
    }
  }, 300_000);
});
