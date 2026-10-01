/**
 * Constant-friction sizing of a laid-out duct system: the linked basis, the
 * airflow walk, sections at the friction rate under the velocity limits,
 * the fitting rules that raise a section, reducers between take-offs,
 * branches kept on their main's wall and their ends on their terminals.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { generateAutoDuct, type AutoDuctRequest } from './ductAutoLayout';
import { splitOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { branchAnchor, ductRunElementWithSpec, startAnchor } from './ductFollow';
import { resolveDuctSettings } from './ductSettings';
import { frictionPaPerM, sizeRectangular, velocityMs } from './ductSizing';
import {
  basisLimits,
  defaultSizingBasis,
  frictionAtVelocity,
  linkSizingBasis,
  sizeDuctSystem,
  velocityAtFriction,
  type DuctSystemSizingResult,
} from './ductSystemSizing';
import { terminalEnvelope, typicalTerminalSpec } from './ductTerminals';
import { buildDuctRunElement, isDuctElement, readDuctRunSpec, type DuctLeg, type DuctRunSpec, type DuctSystemSizing } from './ductTypes';
import { areaOf } from './optimizer/sizingModel';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'u', type: 'ducted-ac', position: { x: -542, y: -348.5 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2400, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, roomId: 'r', properties: { modelCode: 'FDUM22KXE6F-W' },
};
const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
/** A point `along` the supply collar's axis and `across` it (mm). */
const S = (along: number, across = 0): Point2D => ({ x: port.lip.x + across, y: port.lip.y - along });

function diffuser(id: string, centre: Point2D, airflowM3h: number | null = null): HvacElement {
  const spec = { ...typicalTerminalSpec('square-4way', 200), designAirflowM3h: airflowM3h };
  const envelope = terminalEnvelope(spec);
  return {
    id, type: 'diffuser', position: { x: centre.x - envelope.widthMm / 2, y: centre.y - envelope.depthMm / 2 }, rotation: 0,
    width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm, elevation: 2400, mountType: 'ceiling',
    label: id.toUpperCase(), supplyZoneRatio: 0.5, roomId: 'r', properties: { terminal: spec },
  };
}

const basisAt = (friction: number, airflow: number | null = 1500): DuctSystemSizing => ({
  ...defaultSizingBasis(settings, 'supply', null), frictionPaPerM: friction, airflowM3h: airflow,
});

/** The scene with a sizing result's runs and terminals in place. */
function applied(scene: readonly HvacElement[], sized: DuctSystemSizingResult): HvacElement[] {
  const replaced = new Map([...sized.runs, ...sized.terminals].map((element) => [element.id, element]));
  return scene.map((element) => replaced.get(element.id) ?? element);
}

const specOf = (scene: readonly HvacElement[], id: string): DuctRunSpec => readDuctRunSpec(scene.find((element) => element.id === id)!)!;
const legText = (leg: DuctLeg) => (leg.diameterMm ? `Ø${leg.diameterMm}` : `${leg.widthMm}×${leg.heightMm}`);

describe('the basis: main velocity ⇄ friction rate', () => {
  it('links both ways within 1 %, friction rising with the velocity', () => {
    for (const airflow of [400, 1500, 4000]) {
      for (const velocity of [2.5, 4, 6]) {
        const friction = frictionAtVelocity(airflow, velocity);
        expect(velocityAtFriction(airflow, friction)).toBeCloseTo(velocity, 1);
        expect(Math.abs(velocityAtFriction(airflow, friction) - velocity) / velocity).toBeLessThan(0.01);
      }
      expect(frictionAtVelocity(airflow, 3)).toBeLessThan(frictionAtVelocity(airflow, 5));
    }
  });

  it('follows the value that drives; a new basis takes the project rate and limits', () => {
    const basis = defaultSizingBasis(settings, 'supply', 1500);
    expect(basis.drive).toBe('friction');
    expect(basis.frictionPaPerM).toBe(settings.autoFrictionSupplyPaPerM);
    expect(basis.maxVelocity).toEqual({ trunk: settings.autoMaxVelocityTrunkMs, branch: settings.autoMaxVelocityBranchMs, runout: settings.autoMaxVelocityRunoutMs });
    expect(basis.mainVelocityMs).toBeCloseTo(velocityAtFriction(1500, settings.autoFrictionSupplyPaPerM), 2);
    const byVelocity = linkSizingBasis({ ...basis, drive: 'velocity', mainVelocityMs: 4 }, 1500);
    expect(byVelocity.mainVelocityMs).toBe(4);
    expect(byVelocity.frictionPaPerM).toBeCloseTo(frictionAtVelocity(1500, 4), 3);
    expect(defaultSizingBasis(settings, 'return', 1500).frictionPaPerM).toBe(settings.autoFrictionReturnPaPerM);
  });

  it('is kept on the run tolerantly (a corrupt record is ignored)', () => {
    const run = buildDuctRunDraftElement({ port, points: [S(2000)] }, 'r');
    const basis = linkSizingBasis(basisAt(0.9), 1500);
    const stored = ductRunElementWithSpec(run, { ...readDuctRunSpec(run)!, sizing: basis });
    expect(readDuctRunSpec(stored)!.sizing).toEqual(basis);
    const corrupt = { ...stored, properties: { ...stored.properties, ductRun: { ...(stored.properties.ductRun as object), sizing: { method: 'nonsense' } } } };
    expect(readDuctRunSpec(corrupt)!.sizing).toBeUndefined();
  });
});

describe('a rectangular trunk with four take-offs (1500 m³/h)', () => {
  const terminals = [0, 1, 2, 3].map((k) => diffuser(`d${k}`, S(2500 + k * 1800, 1200)));
  let scene: HvacElement[] = [];
  let rootId = '';

  beforeAll(() => {
    const request: AutoDuctRequest = {
      unitId: 'u', terminalIds: terminals.map((terminal) => terminal.id), fanSpeed: 'hi', layout: 'auto',
      services: { supply: true, return: false }, rebuildExisting: false, shape: 'rect', airflowM3h: 1500,
    };
    const result = generateAutoDuct([unit, ...terminals], request, settings);
    expect(result.designs[result.selected]!.errors).toBe(0);
    const turned = new Map(result.terminalUpdates.map((element) => [element.id, element]));
    scene = [unit, ...terminals.map((element) => turned.get(element.id) ?? element), ...result.runs];
    rootId = result.runs.find((run) => readDuctRunSpec(run)!.start.kind === 'unit-port')!.id;
  }, 120000);

  it('carries the airflow of the terminals downstream, stepping down at each take-off', () => {
    const { report } = sizeDuctSystem(scene, rootId, { basis: basisAt(0.8) }, settings);
    const main = report.sections.filter((section) => section.runId === rootId);
    expect(main.map((section) => section.airflowM3h)).toEqual([1500, 1125, 750, 375, 0]);
    expect(main.slice(0, 3).every((section) => section.part === 'trunk')).toBe(true);
    expect(report.terminals.map((terminal) => terminal.airflowM3h)).toEqual([375, 375, 375, 375]);
    expect(report.terminalsAirflowM3h).toBe(1500);
  });

  it('sizes each free section at the friction rate under its limit, keeping its height', () => {
    for (const friction of [0.5, 0.8, 1.2]) {
      const basis = linkSizingBasis(basisAt(friction), 1500);
      const sized = sizeDuctSystem(scene, rootId, { basis }, settings);
      const before = specOf(scene, rootId);
      for (const section of sized.report.sections) {
        if (section.setBy !== 'friction' && section.setBy !== 'velocity') continue;
        const limits = basisLimits(basis, section.part);
        expect(frictionPaPerM(section.section, section.airflowM3h)).toBeLessThanOrEqual(limits.frictionPaPerM * 1.001);
        expect(velocityMs(section.section, section.airflowM3h)).toBeLessThanOrEqual(limits.maxVelocityMs * 1.001);
        if (section.runId === rootId && !section.section.diameterMm) {
          expect(section.section.heightMm).toBe(before.legs[0]!.heightMm);
          const expected = sizeRectangular(section.airflowM3h, section.section.heightMm, limits, {
            stepMm: 50, minWidthMm: Math.min(section.section.heightMm, before.legs[0]!.widthMm), maxAspect: settings.aspectRatioAdvisory,
          });
          expect(section.section.widthMm).toBe(expected.widthMm);
        }
      }
    }
  });

  it('keeps the main\'s velocity at or under the main velocity set', () => {
    const basis = linkSizingBasis({ ...basisAt(0.8), drive: 'velocity', mainVelocityMs: 4 }, 1500);
    const { report } = sizeDuctSystem(scene, rootId, { basis }, settings);
    const first = report.sections.find((section) => section.runId === rootId)!;
    expect(first.velocityMs).toBeLessThanOrEqual(4.001);
  });

  it('never gives a larger section at a higher friction rate', () => {
    const low = sizeDuctSystem(scene, rootId, { basis: basisAt(0.5) }, settings).report.sections;
    const high = sizeDuctSystem(scene, rootId, { basis: basisAt(1.5) }, settings).report.sections;
    expect(high.length).toBe(low.length);
    high.forEach((section, index) => expect(areaOf(section.section)).toBeLessThanOrEqual(areaOf(low[index]!.section) + 1e-9));
  });

  it('places reducers between the take-offs and keeps each branch on its main\'s wall and its runout on its terminal', () => {
    const sized = sizeDuctSystem(scene, rootId, { basis: basisAt(0.5) }, settings);
    expect(sized.report.changedRunIds).toContain(rootId);
    const after = applied(scene, sized);
    const root = specOf(after, rootId);
    expect(root.sizing?.frictionPaPerM).toBe(0.5);
    // At least one reducer: a collinear vertex with different sections either side.
    expect(new Set(root.legs.map(legText)).size).toBeGreaterThan(1);
    // Every section change lies between two take-off windows, never on one.
    const taps = after.filter(isDuctElement).map((element) => readDuctRunSpec(element)!).filter((spec) => spec.start.kind === 'tap');
    for (const spec of taps) {
      const anchor = branchAnchor(root, spec, settings)!;
      const start = startAnchor(spec)!;
      expect(Math.hypot(anchor.point.x - start.point.x, anchor.point.y - start.point.y)).toBeLessThan(0.5);
      expect(Math.abs(anchor.z - start.z)).toBeLessThan(0.5);
    }
    for (const element of scene.filter(isDuctElement)) {
      const old = readDuctRunSpec(element)!;
      if (old.end.kind !== 'terminal') continue;
      const now = specOf(after, element.id);
      expect(now.path[now.path.length - 1]).toEqual(old.path[old.path.length - 1]);
    }
    // The planner finds no error in the result.
    expect(sized.report.errors).toBe(0);
  });

  it('is idempotent: sizing again at the same basis changes nothing', () => {
    for (const friction of [0.5, 0.8, 1.2]) {
      const first = sizeDuctSystem(scene, rootId, { basis: basisAt(friction) }, settings);
      const again = sizeDuctSystem(applied(scene, first), rootId, { basis: basisAt(friction) }, settings);
      expect(again.report.changedRunIds).toEqual([]);
    }
  });

  it('leaves a locked run as it is (its branches are still sized) and measures without changing anything', () => {
    const root = scene.find((element) => element.id === rootId)!;
    const locked = scene.map((element) => (element.id === rootId ? ductRunElementWithSpec(root, { ...readDuctRunSpec(root)!, locked: true }) : element));
    const sized = sizeDuctSystem(locked, rootId, { basis: basisAt(0.5) }, settings);
    expect(specOf(applied(locked, sized), rootId).legs).toEqual(specOf(locked, rootId).legs);
    expect(sized.report.sections.filter((section) => section.runId === rootId).every((section) => section.setBy === 'locked')).toBe(true);
    const measured = sizeDuctSystem(scene, rootId, { basis: basisAt(0.5), measure: true }, settings);
    expect(measured.report.changedRunIds).toEqual([]);
    expect(measured.report.sections.every((section) => section.setBy === 'drawn')).toBe(true);
    expect(measured.report.pressure!.indexPa).toBeGreaterThan(0);
  });

  it('raises a main drawn too low for its take-offs (spin-in: Ø + 50; a conical one becomes a spin-in) and says so', () => {
    const root = scene.find((element) => element.id === rootId)!;
    const low = readDuctRunSpec(root)!;
    const lowered = scene.map((element) => (element.id === rootId
      ? ductRunElementWithSpec(root, { ...low, legs: low.legs.map((leg) => (leg.diameterMm ? leg : { ...leg, heightMm: 150 })) }) : element));
    const { report } = sizeDuctSystem(lowered, rootId, { basis: basisAt(0.8) }, settings);
    const main = report.sections.filter((section) => section.runId === rootId && section.airflowM3h > 0);
    for (const section of main) expect(section.section.heightMm).toBeGreaterThanOrEqual(250);
    expect(main.some((section) => section.setBy === 'take-off' && /take-off to D\d/.test(section.note ?? ''))).toBe(true);
    const branches = lowered.filter(isDuctElement).map((element) => readDuctRunSpec(element)!).filter((spec) => spec.start.kind === 'tap');
    if (branches.some((spec) => spec.start.kind === 'tap' && spec.start.style === 'conical')) {
      expect(report.issues.some((issue) => issue.code === 'DU_SIZE_TAKEOFF')).toBe(true);
    }
  });

  it('takes a terminal\'s airflow from the card: the terminal changes with the runs', () => {
    const sized = sizeDuctSystem(scene, rootId, { basis: basisAt(0.8), terminalAirflows: { d3: 600 } }, settings);
    expect(sized.terminals.map((element) => element.id)).toEqual(['d3']);
    expect((sized.terminals[0]!.properties.terminal as { designAirflowM3h: number }).designAirflowM3h).toBe(600);
    expect(sized.report.terminals.find((terminal) => terminal.terminalId === 'd3')!.airflowM3h).toBe(600);
    // The others share what is left of the system's 1500.
    expect(sized.report.terminals.filter((terminal) => terminal.terminalId !== 'd3').map((terminal) => terminal.airflowM3h)).toEqual([300, 300, 300]);
    const main = sized.report.sections.filter((section) => section.runId === rootId);
    expect(main[main.length - 2]!.airflowM3h).toBe(600);
  });
});

describe('fittings bind a section', () => {
  it('makes a Y\'s main at least as wide as its two outlets side by side', () => {
    const trunkSpec = readDuctRunSpec(buildDuctRunDraftElement({ port, points: [S(4000)], legSizes: [{ widthMm: 400, heightMm: 250 }] }, 'trunk'))!;
    const trunk = ductRunElementWithSpec(buildDuctRunDraftElement({ port, points: [S(4000)] }, 'trunk'), { ...trunkSpec, end: { kind: 'split', style: 'y' } });
    const a = diffuser('a', S(4600, 2600), 450);
    const b = diffuser('b', S(4600, -2600), 450);
    const outlet = (id: string, side: 1 | -1, terminal: HvacElement): HvacElement => {
      const origin = splitOrigin(trunk, settings, { side, style: 'y', vcd: false }, { widthMm: 350, heightMm: 250 })!;
      const point = (origin as { point: Point2D }).point;
      const direction = (origin as { direction: Point2D }).direction;
      const element = buildDuctRunDraftElement({ origin, points: [{ x: point.x + direction.x * 1500, y: point.y + direction.y * 1500 }], legSizes: [{ widthMm: 350, heightMm: 250 }] }, id);
      const spec = readDuctRunSpec(element)!;
      const lip = { x: terminal.position.x + terminal.width / 2, y: terminal.position.y + terminal.depth / 2, z: 2400 };
      return { ...element, properties: buildDuctRunElement({
        ...spec, path: [...spec.path, lip], legs: [...spec.legs, { widthMm: 200, heightMm: 200, diameterMm: 200 }],
        end: { kind: 'terminal', terminalId: terminal.id, portId: 'spigot', flex: true },
      }).properties! };
    };
    const scene = [unit, a, b, trunk, outlet('left', 1, a), outlet('right', -1, b)];
    const { report } = sizeDuctSystem(scene, 'trunk', { basis: basisAt(0.8, 900), verify: false }, settings);
    const outlets = report.sections.filter((section) => section.runId !== 'trunk');
    const main = report.sections.filter((section) => section.runId === 'trunk').at(-1)!;
    expect(outlets).toHaveLength(2);
    expect(main.section.widthMm).toBeGreaterThanOrEqual(outlets.reduce((sum, section) => sum + section.section.widthMm, 0));
    expect(main.section.heightMm).toBeGreaterThanOrEqual(Math.max(...outlets.map((section) => section.section.heightMm)));
  });
});
