import { describe, expect, it } from 'vitest';

import type { HvacElement, Point2D } from '../../../../types';

import { resolveUnitAirPorts } from './ductAirPorts';
import { tapOrigin } from './ductBranchTargets';
import { buildDuctRunDraftElement } from './ductDraft';
import { planDuctRun, type DuctFabricationPlan } from './ductFabricationPlanner';
import { segmentFocusMarkup } from './ductOverlayMarkup';
import {
  ductSegmentKey,
  ductSegmentOf,
  ductSegments,
  neighbourSegment,
  polygonHotspot,
  segmentAtModelPoint,
  segmentAtPlanPoint,
  segmentBounds,
  segmentBounds3D,
  segmentEnds,
  segmentIssues,
  segmentOutlines,
} from './ductSegments';
import { resolveDuctSettings } from './ductSettings';
import { readDuctRunSpec, roundLeg } from './ductTypes';

const settings = resolveDuctSettings({});
const unit: HvacElement = {
  id: 'fdum', type: 'ducted-ac', position: { x: 0, y: 0 }, rotation: 0, width: 1084, depth: 697, height: 300,
  elevation: 2600, mountType: 'ceiling', label: 'FDUM22', supplyZoneRatio: 0.5, properties: { modelCode: 'FDUM22KXE6F-W' },
};
const supply = resolveUnitAirPorts(unit).find((port) => port.kind === 'supply')!;
/** A point `along` the collar's outward normal (−y) and `across` it (+x). */
const P = (along: number, across = 0): Point2D => ({ x: supply.lip.x + across, y: supply.lip.y - along });

/** 600×300 down 3 m, a 90° turn, 2.5 m on, a reduction to 500×300 for 2 m, an end cap. */
function rectMain(nodeOverrides?: Record<string, unknown>): { element: HvacElement; plan: DuctFabricationPlan } {
  let element = buildDuctRunDraftElement({
    port: supply, points: [P(3000), P(3000, 2500), P(3000, 4500)],
    legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }, { widthMm: 500, heightMm: 300 }],
  }, 'main');
  if (nodeOverrides) {
    const spec = readDuctRunSpec(element)!;
    element = { ...element, properties: { ...element.properties, ductRun: { ...spec, nodeOverrides } } };
  }
  return { element, plan: planDuctRun(element, { settings, scene: [unit, element] })! };
}

describe('the segments of a duct run', () => {
  it('group its pieces into the decisions a designer makes, in path order', () => {
    const { plan } = rectMain();
    const keys = ductSegments(plan).map((segment) => segment.key);
    // The collar's own section first needs a transition to the 600×300 leg.
    expect(keys).toEqual(['start:connector', 'transition:0', 'leg:0', 'node:1', 'leg:1', 'transition:2', 'leg:2', 'end:cap']);
    // Every piece is in exactly one segment.
    const covered = ductSegments(plan).flatMap((segment) => segment.pieceIndices).sort((a, b) => a - b);
    expect(covered).toEqual(plan.pieces.map((_, index) => index));
    for (const segment of ductSegments(plan)) {
      for (const index of segment.pieceIndices) expect(ductSegmentKey(plan.pieces[index]!)).toBe(segment.key);
    }
  });

  it('name each one as a designer would, with its size and defining parameters', () => {
    const { plan } = rectMain();
    expect(ductSegmentOf(plan, 'leg:0')).toMatchObject({ kind: 'straight', title: 'Straight duct', size: '600×300', round: false });
    const elbow = ductSegmentOf(plan, 'node:1')!;
    expect(elbow.kind).toBe('elbow');
    expect(elbow.title).toBe('90° radius elbow');
    expect(elbow.size).toBe('600×300');
    // R/W 1.5 (SMACNA RE1 default): centreline 900, throat 900 − 300 = 600.
    expect(elbow.detail).toBe('R/W 1.5 · throat 600 mm');
    expect(ductSegmentOf(plan, 'transition:2')).toMatchObject({ kind: 'transition', title: 'Transition', size: '600×300 → 500×300' });
    expect(ductSegmentOf(plan, 'end:cap')).toMatchObject({ kind: 'end-cap', title: 'End cap', size: '500×300' });
    expect(ductSegmentOf(plan, 'start:connector')).toMatchObject({ kind: 'connector', title: 'Flexible connector' });
    // A square vaned elbow by override.
    const vaned = rectMain({ 1: { elbowStyle: 'square-vaned' } }).plan;
    expect(ductSegmentOf(vaned, 'node:1')!.title).toBe('90° square elbow');
    expect(ductSegmentOf(vaned, 'node:1')!.detail).toMatch(/^\d+ .+ vanes$/);
  });

  it('name round segments and a round-main take-off', () => {
    const main = buildDuctRunDraftElement({ port: supply, points: [P(6000)], legSizes: [roundLeg(355)] }, 'round');
    const mainPlan = planDuctRun(main, { settings, scene: [unit, main] })!;
    expect(ductSegmentOf(mainPlan, 'leg:0')).toMatchObject({ title: settings.roundSeam === 'spiral' ? 'Spiral duct' : 'Round duct', size: 'Ø355', round: true });
    expect(ductSegmentOf(mainPlan, 'transition:0')!.title).toBe('Square-to-round');
    const origin = tapOrigin(main, settings, { legIndex: 0, stationMm: 3000, side: 1, style: 'round-lateral', vcd: true }, roundLeg(200))!;
    const d = (origin as { direction: Point2D }).direction;
    const start = (origin as { point: Point2D }).point;
    const branch = buildDuctRunDraftElement({
      origin, points: [{ x: start.x + d.x * 800, y: start.y + d.y * 800 }, { x: start.x + d.x * 800 + Math.sign(d.x) * 1500, y: start.y + d.y * 800 }],
      legSizes: [roundLeg(200)],
    }, 'branch');
    const plan = planDuctRun(branch, { settings, scene: [unit, main, branch] })!;
    expect(ductSegments(plan).map((segment) => segment.key).slice(0, 3)).toEqual(['start:takeoff', 'start:damper', 'leg:0']);
    expect(ductSegmentOf(plan, 'start:takeoff')).toMatchObject({ kind: 'takeoff', title: '45° lateral (Y)', size: 'Ø200', detail: 'off Ø355 main' });
    expect(ductSegmentOf(plan, 'start:damper')!.title).toBe('Volume damper');
    expect(ductSegmentOf(plan, 'node:1')!.title).toBe('45° gored elbow');
  });

  it('step to the segment before or after, and stop at either end', () => {
    const { plan } = rectMain();
    expect(neighbourSegment(plan, 'node:1', 1)!.key).toBe('leg:1');
    expect(neighbourSegment(plan, 'node:1', -1)!.key).toBe('leg:0');
    expect(neighbourSegment(plan, 'start:connector', -1)).toBeNull();
    expect(neighbourSegment(plan, 'end:cap', 1)).toBeNull();
    expect(neighbourSegment(plan, 'nope', 1)).toBeNull();
  });

  it('are found under a plan point, and outline and bound the pieces drawn', () => {
    const { plan } = rectMain();
    const elbow = plan.pieces.find((piece) => piece.kind === 'elbow')!.elbow!;
    // The elbow's arc midpoint lies on its centreline.
    const mid = { x: (elbow.startPoint.x + elbow.endPoint.x) / 2, y: (elbow.startPoint.y + elbow.endPoint.y) / 2 };
    const onArc = { x: elbow.corner.x + (mid.x - elbow.corner.x) * 0.6, y: elbow.corner.y + (mid.y - elbow.corner.y) * 0.6 };
    expect(segmentAtPlanPoint(plan, onArc, 5)!.key).toBe('node:1');
    expect(segmentAtPlanPoint(plan, P(1500), 5)!.key).toBe('leg:0');
    expect(segmentAtPlanPoint(plan, P(1500, 2000), 5)).toBeNull();
    expect(segmentOutlines(plan, 'leg:0').length).toBe(ductSegmentOf(plan, 'leg:0')!.pieceIndices.length);
    const bounds = segmentBounds(plan, 'leg:0')!;
    // 600 wide, centred on the collar's line.
    expect(bounds.maxX - bounds.minX).toBeGreaterThan(600);
    expect(bounds.maxX - bounds.minX).toBeLessThan(610);
  });

  it('are found at a point in 3D, a riser told apart from the elbows over it by height, and bound in 3D', () => {
    // 600×300 out 3 m, up 1.2 m, then 2.5 m on at the new level.
    const flat = buildDuctRunDraftElement({ port: supply, points: [P(3000)], legSizes: [{ widthMm: 600, heightMm: 300 }] }, 'r');
    const z0 = readDuctRunSpec(flat)!.path[1]!.z;
    const element = buildDuctRunDraftElement({
      port: supply, points: [P(3000), { ...P(3000), z: z0 + 1200 }, { ...P(5500), z: z0 + 1200 }],
      legSizes: [{ widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }, { widthMm: 600, heightMm: 300 }],
    }, 'r');
    const plan = planDuctRun(element, { settings, scene: [unit, element] })!;
    const at = (point: Point2D, z: number) => segmentAtModelPoint(plan, { ...point, z }, 50)?.segment.key ?? null;
    // On the first leg's top face, half way along.
    expect(at(P(1500), z0 + 300)).toBe('leg:0');
    // Over the riser in plan: its middle is the riser, its foot the lower elbow, its head the upper one.
    expect(at(P(3000), z0 + 750)).toBe('leg:1');
    expect(ductSegmentOf(plan, 'leg:1')!.kind).toBe('riser');
    expect(at(P(3000), z0 + 150)).toBe('node:1');
    expect(at(P(3000), z0 + 1350)).toBe('node:2');
    // Far from the run: nothing.
    expect(at(P(1500), z0 + 900)).toBeNull();
    expect(ductSegmentOf(plan, 'leg:0')!.marks).toContain(segmentAtModelPoint(plan, { ...P(1500), z: z0 + 300 }, 50)!.mark);
    // The riser runs between its elbows: each takes 1.5 × 300 + 50 mm of it, from the levels' centrelines.
    const riser = segmentBounds3D(plan, 'leg:1')!;
    expect(riser.min.z).toBeCloseTo(z0 + 150 + 500, 6);
    expect(riser.max.z).toBeCloseTo(z0 + 1200 + 150 - 500, 6);
    const first = segmentBounds3D(plan, 'leg:0')!;
    expect(first.max.z - first.min.z).toBeCloseTo(300, 0);
  });

  it('mark where they begin and end, and have a point inside them for a pin', () => {
    const { plan } = rectMain();
    // The first leg runs along −y: its ends are its first and last pieces' ends, square across it, at their height,
    // the 600×300 section out to its outer face (the sheet and the insulation the plan draws).
    const leg = ductSegmentOf(plan, 'leg:0')!;
    const first = plan.pieces[leg.pieceIndices[0]!]!;
    const last = plan.pieces[leg.pieceIndices.at(-1)!]!;
    const [start, end] = segmentEnds(plan, 'leg:0');
    expect(start!.point).toEqual(first.start);
    expect(end!.point).toEqual(last.end);
    expect(start!.z).toBe(first.centreZ);
    expect(end!.z).toBe(last.endCentreZ);
    expect(start!.direction.x).toBeCloseTo(0, 9);
    expect(start!.direction.y).toBeCloseTo(-1, 9);
    const outer = (first.sheetThicknessMm ?? 1) + plan.insulationMm;
    expect(start!.halfWidthMm).toBeCloseTo(300 + outer, 9);
    expect(start!.halfHeightMm).toBeCloseTo(150 + outer, 9);
    expect(start!.round).toBe(false);
    // The elbow: in along −y, out along +x.
    const [into, out] = segmentEnds(plan, 'node:1');
    expect(into!.direction.y).toBeCloseTo(-1, 9);
    expect(out!.direction.x).toBeCloseTo(1, 9);
    // The pin is inside the segment's outline.
    const pin = polygonHotspot(segmentOutlines(plan, 'leg:0')[0]!)!;
    expect(segmentAtPlanPoint(plan, pin, 1)!.key).toBe('leg:0');
    // An L whose centroid falls outside it still gets a point inside it.
    const ell = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 100 }, { x: 0, y: 100 }];
    const inside = polygonHotspot(ell)!;
    expect((inside.x > 0 && inside.x < 10 && inside.y > 0 && inside.y < 100) || (inside.y > 0 && inside.y < 10 && inside.x > 0 && inside.x < 100)).toBe(true);
    expect(polygonHotspot([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBeNull();
  });

  it('are drawn in focus: a pinned one filled, haloed and bracketed at both ends; a hovered one dashed', () => {
    const { plan } = rectMain();
    const outlines = segmentOutlines(plan, 'leg:0');
    const ends = segmentEnds(plan, 'leg:0');
    const paths = (markup: string) => markup.match(/<path /g)?.length ?? 0;
    const pinned = segmentFocusMarkup(outlines, 'pinned', ends, 2);
    // A halo and a filled outline per piece, a white underlay and a violet bracket per end.
    expect(paths(pinned)).toBe(outlines.length * 2 + ends.length * 2);
    expect(pinned).toContain('stroke="#ffffff"');
    const hovered = segmentFocusMarkup(outlines, 'hovered', ends, 2);
    expect(paths(hovered)).toBe(outlines.length);
    expect(hovered).toContain('stroke-dasharray');
  });

  it('carry the issues that belong to them', () => {
    // R/W 0.4 is below SMACNA's tightest radius: an error on the elbow, nowhere else.
    const { plan } = rectMain({ 1: { elbowStyle: 'radius', centrelineRatio: 0.4 } });
    expect(segmentIssues(plan, 'node:1').map((issue) => issue.code)).toContain('DU_ELBOW_RADIUS');
    expect(segmentIssues(plan, 'leg:1').map((issue) => issue.code)).not.toContain('DU_ELBOW_RADIUS');
  });
});
