/**
 * Pure 2D presentation geometry for condensate pipes: plan runs, riser/drop
 * symbols, flow-arrow stations, fall tags and level (invert) tags. The SVG
 * overlay only paints what this returns, so it is testable without a DOM.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { formatFallRatio } from './condensateSettings';
import { condensateInsulatedRadiusMm, readCondensatePipeSpec, type CondensateFitting, type CondensatePipeSpec, type Point3 } from './condensateTypes';

export interface CondensatePlanRun {
  a: Point2D;
  b: Point2D;
  zA: number;
  zB: number;
  lengthMm: number;
  slopePercent: number;
}

export interface CondensateVerticalMark {
  point: Point2D;
  /** 'up' = pump riser, 'down' = drop. */
  direction: 'up' | 'down';
  heightMm: number;
  zTop: number;
  zBottom: number;
}

export interface CondensatePlanPresentation {
  id: string;
  spec: CondensatePipeSpec;
  insulatedDiameterMm: number;
  outerDiameterMm: number;
  runs: CondensatePlanRun[];
  path: Point2D[];
  verticals: CondensateVerticalMark[];
  fittings: CondensateFitting[];
  /** Fall tag on the longest run. */
  fallTag: { point: Point2D; angleDeg: number; text: string; runLengthMm: number } | null;
  /** Invert-level tags at the pipe ends. */
  levelTags: Array<{ point: Point2D; text: string }>;
}

function planDistance(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function buildCondensatePlanPresentation(element: HvacElement): CondensatePlanPresentation | null {
  const spec = readCondensatePipeSpec(element);
  const nodes: Point3[] = spec.routeNodes3d.length >= 2
    ? spec.routeNodes3d
    : spec.routePoints.map((point) => ({ ...point, z: element.elevation }));
  if (nodes.length < 2) return null;
  const runs: CondensatePlanRun[] = [];
  const verticals: CondensateVerticalMark[] = [];
  const path: Point2D[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    const length = planDistance(a, b);
    if (length < 0.5) {
      const height = Math.abs(b.z - a.z);
      if (height > 1) {
        verticals.push({
          point: { x: a.x, y: a.y },
          direction: b.z > a.z ? 'up' : 'down',
          heightMm: height,
          zTop: Math.max(a.z, b.z),
          zBottom: Math.min(a.z, b.z),
        });
      }
      continue;
    }
    runs.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, zA: a.z, zB: b.z, lengthMm: length, slopePercent: ((a.z - b.z) / length) * 100 });
  }
  for (const node of nodes) {
    const last = path[path.length - 1];
    if (!last || planDistance(last, node) >= 0.5) path.push({ x: node.x, y: node.y });
  }
  const longest = runs.reduce<CondensatePlanRun | null>((best, run) => (!best || run.lengthMm > best.lengthMm ? run : best), null);
  let fallTag: CondensatePlanPresentation['fallTag'] = null;
  if (longest) {
    let angle = (Math.atan2(longest.b.y - longest.a.y, longest.b.x - longest.a.x) * 180) / Math.PI;
    // Keep text upright; the arrow in the text still points downstream.
    const flipped = angle > 90 || angle < -90;
    if (flipped) angle += angle > 0 ? -180 : 180;
    const arrow = flipped ? '←' : '→';
    fallTag = {
      point: { x: (longest.a.x + longest.b.x) / 2, y: (longest.a.y + longest.b.y) / 2 },
      angleDeg: angle,
      text: `CD ${spec.nominalSize} · ${formatFallRatio(Math.max(0, longest.slopePercent))} ${arrow}`,
      runLengthMm: longest.lengthMm,
    };
  }
  const invert = (z: number) => Math.round(z - spec.innerDiameterMm / 2);
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const levelTags = [{ point: { x: first.x, y: first.y }, text: `IL ${invert(first.z)}` }];
  if (planDistance(first, last) > 1 || Math.abs(first.z - last.z) > 1) levelTags.push({ point: { x: last.x, y: last.y }, text: `IL ${invert(last.z)}` });
  return {
    id: element.id,
    spec,
    insulatedDiameterMm: condensateInsulatedRadiusMm(spec) * 2,
    outerDiameterMm: spec.outerDiameterMm,
    runs,
    path,
    verticals,
    fittings: spec.fittings,
    fallTag,
    levelTags,
  };
}

/** Flow-arrow stations along the runs, every `spacingMm` (at least one per long run). */
export function condensateFlowArrows(runs: readonly CondensatePlanRun[], spacingMm: number, minimumRunMm: number): Array<{ point: Point2D; angleDeg: number }> {
  const arrows: Array<{ point: Point2D; angleDeg: number }> = [];
  for (const run of runs) {
    if (run.lengthMm < minimumRunMm) continue;
    const count = Math.max(1, Math.floor(run.lengthMm / spacingMm));
    const angle = (Math.atan2(run.b.y - run.a.y, run.b.x - run.a.x) * 180) / Math.PI;
    for (let k = 0; k < count; k += 1) {
      const t = (k + 0.5) / count;
      arrows.push({ point: { x: run.a.x + (run.b.x - run.a.x) * t, y: run.a.y + (run.b.y - run.a.y) * t }, angleDeg: angle });
    }
  }
  return arrows;
}

/** Head-margin colour ramp used by the generation preview. */
export function headMarginColor(slackMm: number): string {
  if (slackMm >= 100) return '#16a34a';
  if (slackMm >= 40) return '#ca8a04';
  return '#dc2626';
}
