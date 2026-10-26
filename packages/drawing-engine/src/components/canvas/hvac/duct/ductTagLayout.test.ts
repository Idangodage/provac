import { describe, expect, it } from 'vitest';

import type { HvacElement } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRunSpec } from './ductFabricationPlanner';
import { airTerminalMarkup, airTerminalTag, ductRunMarkup, ductRunTagObstacles, placedDuctTagMarkup } from './ductOverlayMarkup';
import { buildDuctPlanPresentation, type DuctPlanTag } from './ductPlanPresentation';
import { resolveDuctSettings } from './ductSettings';
import {
  estimateTagTextPx,
  FULL_TAG_MIN_K,
  layoutDuctTags,
  polygonObstacle,
  SECTION_TAG_MIN_K,
  tagBoxesOverlap,
  tagOverlapsObstacle,
  tagTextBox,
  type DuctTagSource,
} from './ductTagLayout';
import { terminalEnvelope, terminalSpigotPort, typicalTerminalSpec } from './ductTerminals';
import { readDuctRunSpec, roundLeg } from './ductTypes';

const FULL = 'Ø200 · GI 0.50 (below 26 ga) · spiral · RT-1 beaded sleeve · BOD 2495';
/** A section tag on a straight along +x from `at`, `length` long, its default side above (−y). */
function tag(at: { x: number; y: number }, length: number, text = FULL, short: string | null = 'Ø200', area = Math.PI * 100 * 100): DuctPlanTag {
  const point = { x: at.x + length / 2, y: at.y };
  return {
    point: { x: point.x, y: point.y - 170 }, angleDeg: 0, text, short, areaMm2: area,
    anchors: [{ point, normal: { x: 0, y: -1 }, halfWidthMm: 100, spanMm: length, angleDeg: 0 }],
  };
}
/** A 200 mm wide duct body along +x from `at`. */
const body = (at: { x: number; y: number }, length: number) => polygonObstacle([
  { x: at.x, y: at.y - 100 }, { x: at.x + length, y: at.y - 100 }, { x: at.x + length, y: at.y + 100 }, { x: at.x, y: at.y + 100 }]);
const source = (runId: string, tags: DuctPlanTag[], extra: Partial<DuctTagSource> = {}): DuctTagSource => ({ runId, service: 'supply', status: 'ok', tags, ...extra });
const texts = (placed: ReturnType<typeof layoutDuctTags>) => placed.map((entry) => `${entry.runId}:${entry.text}`);

describe('duct tag layout', () => {
  it('shows the size alone zoomed out, the full tag zoomed in, and the full tag of a selected run at any zoom', () => {
    const runs = [source('a', [tag({ x: 0, y: 0 }, 12000)]), source('b', [tag({ x: 0, y: 3000 }, 12000)], { selected: true })];
    expect(texts(layoutDuctTags(runs, 0.036))).toEqual([`b:${FULL}`, 'a:Ø200']);
    expect(texts(layoutDuctTags(runs, FULL_TAG_MIN_K))).toEqual([`b:${FULL}`, `a:${FULL}`]);
    expect(layoutDuctTags(runs, SECTION_TAG_MIN_K * 0.9)).toEqual([]);
  });

  it('keeps a tag along its own straight: too long for it, the size; too long even for that, nothing', () => {
    const k = 0.1;
    const fullMm = estimateTagTextPx(FULL) / k;
    const shortMm = estimateTagTextPx('Ø200') / k;
    expect(texts(layoutDuctTags([source('a', [tag({ x: 0, y: 0 }, fullMm + 10)])], k))).toEqual([`a:${FULL}`]);
    expect(texts(layoutDuctTags([source('a', [tag({ x: 0, y: 0 }, fullMm - 10)])], k))).toEqual(['a:Ø200']);
    expect(layoutDuctTags([source('a', [tag({ x: 0, y: 0 }, shortMm - 10)])], k)).toEqual([]);
    // A selected run's full tag is what the designer asked to read: it may run past a short straight.
    expect(texts(layoutDuctTags([source('a', [tag({ x: 0, y: 0 }, fullMm - 10)], { selected: true })], 0.05))).toEqual([`a:${FULL}`]);
    // A flexible runout has no short form: nothing when zoomed out.
    expect(layoutDuctTags([source('a', [tag({ x: 0, y: 0 }, 5000, 'FLEX Ø200 · 1.20 m · insulated', null)])], 0.03)).toEqual([]);
  });

  it('never overlaps two tags nor a duct, and labels the bigger section first', () => {
    const k = 0.05;
    // Two parallel ducts 400 mm apart: between them is no room, so the bigger (lower) one's tag goes below it.
    const upper = source('upper', [tag({ x: 0, y: 0 }, 8000, FULL, '300×200', 300 * 200)]);
    const lower = source('lower', [tag({ x: 0, y: 400 }, 8000, FULL, '600×300', 600 * 300)]);
    const ducts = [body({ x: 0, y: 0 }, 8000), body({ x: 0, y: 400 }, 8000)];
    const placed = layoutDuctTags([upper, lower], k, { obstacles: ducts });
    expect(texts(placed)).toEqual(['lower:600×300', 'upper:300×200']);
    const [first, second] = placed;
    expect(first!.point.y).toBeGreaterThan(500);
    expect(second!.point.y).toBeLessThan(-100);
    expect(tagBoxesOverlap(first!.box, second!.box)).toBe(false);
    for (const tagged of placed) for (const duct of ducts) expect(tagOverlapsObstacle(tagged.box, duct)).toBe(false);
    // Without the ducts as obstacles, the lower one's tag would have gone between them, onto the upper duct.
    expect(tagOverlapsObstacle(layoutDuctTags([lower], k)[0]!.box, ducts[0]!)).toBe(true);
  });

  it('tries every anchor before giving up: a section blocked at its middle is labelled further along', () => {
    const k = 0.05;
    const blocked = tag({ x: 0, y: 0 }, 8000, FULL, 'Ø250');
    blocked.anchors!.push({ point: { x: 6000, y: 0 }, normal: { x: 0, y: -1 }, halfWidthMm: 100, spanMm: 4000, angleDeg: 0 });
    const middle = layoutDuctTags([source('a', [blocked])], k)[0]!;
    // A diffuser over both sides of the middle.
    const diffuser = { centre: { x: 4000, y: 0 }, axis: { x: 1, y: 0 }, halfAlong: 900, halfAcross: 900 };
    const moved = layoutDuctTags([source('a', [blocked])], k, { obstacles: [diffuser] })[0]!;
    expect(middle.point.x).toBeCloseTo(4000, 6);
    expect(moved.point.x).toBeCloseTo(6000, 6);
  });

  it('keeps off the terminals and their tags: the other side of its duct, else left out', () => {
    const k = 0.05;
    const run = source('a', [tag({ x: 0, y: 0 }, 8000)]);
    const free = layoutDuctTags([run], k)[0]!;
    const blocked = layoutDuctTags([run], k, { obstacles: [free.box] })[0]!;
    expect(blocked.point.y).toBeGreaterThan(0);
    expect(layoutDuctTags([run], k, { obstacles: [free.box, tagTextBox(blocked.point, 0, 200, k)] })).toEqual([]);
  });

  it('boxes overlap by their real outline, turned or not', () => {
    const a = tagTextBox({ x: 0, y: 0 }, 0, 100, 1);
    expect(tagBoxesOverlap(a, tagTextBox({ x: 0, y: 8 }, 0, 100, 1))).toBe(true);
    expect(tagBoxesOverlap(a, tagTextBox({ x: 0, y: 30 }, 0, 100, 1))).toBe(false);
    // A turned tag just past the end of a level one is clear of it; one over its end is not.
    expect(tagBoxesOverlap(a, tagTextBox({ x: 75, y: 40 }, 90, 60, 1))).toBe(false);
    expect(tagBoxesOverlap(a, tagTextBox({ x: 45, y: 30 }, 90, 60, 1))).toBe(true);
  });

  it("a run's section tags carry their size and the straight they label: sizes zoomed out, full tags zoomed in, never overlapping", () => {
    const settings = resolveDuctSettings({});
    const unit: HvacElement = {
      id: 'u', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2400,
      mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
    };
    const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
    // A 600×300 main 6 m out of the collar, a turn, then 4 m of Ø250.
    const run = buildDuctRunDraftElement({
      port, points: [{ x: port.lip.x, y: port.lip.y - 6000 }, { x: port.lip.x + 4000, y: port.lip.y - 6000 }], legSizes: [{ widthMm: 600, heightMm: 300 }, roundLeg(250)],
    }, 'run');
    const presentation = buildDuctPlanPresentation(planDuctRunSpec('run', readDuctRunSpec(run)!, { scene: [unit, run], settings }));
    const sections = presentation.tags.filter((entry) => entry.short && !entry.short.startsWith('PLENUM') && entry.anchors?.length);
    expect(sections.map((entry) => entry.short).sort()).toEqual(['600×300', 'Ø250']);
    for (const entry of sections) {
      expect(entry.text.startsWith(`${entry.short} · GI `)).toBe(true);
      expect(entry.areaMm2).toBeGreaterThan(0);
      // The middle of the longest stretch first, with all of the stretch to take; quarter points with half of it.
      expect(entry.anchors![0]!.spanMm).toBeGreaterThan(entry.anchors!.at(-1)!.spanMm!);
    }
    const runSource = source('run', [...presentation.tags]);
    const zoomedOut = layoutDuctTags([runSource], 0.036);
    expect(zoomedOut.map((entry) => entry.text).sort()).toEqual(['600×300', 'Ø250']);
    const zoomedIn = layoutDuctTags([runSource], 0.12);
    expect(zoomedIn.filter((entry) => entry.full).length).toBeGreaterThan(0);
    for (const placed of [zoomedOut, zoomedIn]) {
      for (let a = 0; a < placed.length; a += 1) for (let b = a + 1; b < placed.length; b += 1) expect(tagBoxesOverlap(placed[a]!.box, placed[b]!.box)).toBe(false);
    }
    // The run's own markup leaves them to the layout when asked; the layout's markup groups them by run.
    const style = { k: 0.05, showTags: true, showJointTicks: true, showMarks: false };
    expect(ductRunMarkup(presentation, style)).toContain('>600×300 · GI ');
    expect(ductRunMarkup(presentation, { ...style, sectionTags: false })).not.toContain('600×300');
    expect(placedDuctTagMarkup(zoomedOut, 0.036)).toMatch(/^<g data-duct-tags="run"><text [^>]+>(600×300|Ø250)<\/text>/);
  });

  it("keeps a terminal's tag where the terminal draws it", () => {
    const spec = typicalTerminalSpec('square-4way', 200);
    const envelope = terminalEnvelope(spec);
    const terminal: HvacElement = {
      id: 'sd1', type: 'diffuser', position: { x: 1000, y: 2000 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm, height: envelope.heightMm,
      elevation: 2400, mountType: 'ceiling', label: 'SAD-1', supplyZoneRatio: 0.5, properties: { terminal: spec },
    };
    const tag = airTerminalTag(terminal, spec, 0.5);
    expect(tag.text).toBe('SAD-1 · 595 · Ø200');
    expect(airTerminalMarkup(terminal, spec, 0.5, true)).toContain(`<text x="${Math.round(tag.point.x * 100) / 100}" y="${Math.round(tag.point.y * 100) / 100}"`);
    // In IP its face and neck read in inches, beside the runout's own tag in inches.
    expect(airTerminalTag(terminal, spec, 0.5, 'ip').text).toBe('SAD-1 · 23.4 in · Ø7.9 in');
    expect(airTerminalMarkup(terminal, spec, 0.5, true, 'ip')).toContain('SAD-1 · 23.4 in · Ø7.9 in');
    const inchNeck = { ...spec, neckDiameterMm: 254 };
    expect(airTerminalTag(terminal, inchNeck, 0.5, 'ip').text).toBe('SAD-1 · 23.4 in · Ø10 in');
  });

  it("lays a runout's tag along the runout, and keeps every tag off the run's own pieces and labels", () => {
    const settings = resolveDuctSettings({});
    const unit: HvacElement = {
      id: 'u', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300, elevation: 2400,
      mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
    };
    const port = resolveUnitAirPorts(unit).find((entry) => entry.kind === 'supply')!;
    const spec = { ...typicalTerminalSpec('square-4way', 200), spigotSide: 'front' as const };
    const envelope = terminalEnvelope(spec);
    const diffuser: HvacElement = {
      id: 'sd1', type: 'diffuser', position: { x: 2000 - envelope.widthMm / 2, y: -3000 - envelope.depthMm / 2 }, rotation: 0, width: envelope.widthMm, depth: envelope.depthMm,
      height: envelope.heightMm, elevation: 2400, mountType: 'ceiling', label: 'SAD-1', supplyZoneRatio: 0.5, properties: { terminal: spec },
    };
    const lip = terminalSpigotPort(diffuser)!.lip;
    // The run turns over the diffuser and drops onto it down a flexible runout running along y.
    const run = buildDuctRunDraftElement({
      port, points: [{ x: port.lip.x, y: lip.y + 1400 }, { x: lip.x, y: lip.y + 1400 }, { x: lip.x, y: lip.y, z: lip.z - 100 }],
      legSizes: [{ widthMm: port.widthMm, heightMm: port.heightMm }, roundLeg(200), roundLeg(200)],
      end: { kind: 'terminal', terminalId: 'sd1', portId: 'spigot', flex: true },
    }, 'run');
    const presentation = buildDuctPlanPresentation(planDuctRunSpec('run', readDuctRunSpec(run)!, { scene: [unit, diffuser, run], settings }));
    const flex = presentation.tags.find((entry) => entry.text.startsWith('FLEX '));
    expect(flex).toBeDefined();
    // It follows the runout where it runs (here mostly along y as it curves onto the spigot), no longer level across it.
    expect(Math.abs(flex!.anchors![0]!.angleDeg)).toBeGreaterThan(45);
    const obstacles = ductRunTagObstacles(presentation, { k: 0.1, showTags: true, showMarks: false }, estimateTagTextPx);
    expect(obstacles.filter((obstacle) => 'polygon' in obstacle)).toHaveLength(presentation.piecePolygons.length + presentation.insulationOutlines.length);
    const placed = layoutDuctTags([source('run', [...presentation.tags])], 0.1, { obstacles });
    expect(placed.length).toBeGreaterThan(0);
    for (const tagged of placed) for (const obstacle of obstacles) expect(tagOverlapsObstacle(tagged.box, obstacle)).toBe(false);
  });
});
