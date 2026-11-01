/**
 * Refrigerant line supports: a rubber-lined clip round the insulation on a
 * threaded rod from the soffit, along each level stretch. Practice spacing
 * (mounting guides of the VRF makers, not yet a loaded maker figure): 1.5 m up
 * to Ø19.05, 2 m above; the first and last 300 mm clear of a bend, a riser or
 * a fitting, and each stretch held at least once. Derived from the route,
 * never stored, so the 3D and the BOM follow every edit.
 * Pure.
 */
import type { HvacElement } from '../../../types';

import type { DuctBomRow } from './duct/ductBom';

import { normalizePipeRouteNodes3d } from './pipeRoute3d';
import { resolveRefrigerantPipeSpec } from './refrigerantPipePairModel';

/** Clip spacing on a level stretch (mm, practice): up to this copper size … */
const SMALL_PIPE_MAX_MM = 19.05;
const SMALL_PIPE_SPACING_MM = 1500;
const LARGE_PIPE_SPACING_MM = 2000;
/** The first and last clip of a stretch keep this far from its ends (mm, practice). */
const CLEAR_OF_BENDS_MM = 300;
/** A stretch shorter than this is held by the clips either side of it (mm). */
const SHORTEST_HELD_MM = 2 * CLEAR_OF_BENDS_MM;

export interface RefrigerantSupport {
  elementId: string;
  lineKind: 'gas' | 'liquid';
  point: { x: number; y: number; z: number };
  /** The run's direction through the clip (plan, unit). */
  axis: { x: number; y: number };
  /** The insulated line the clip goes round (mm). */
  insulatedDiameterMm: number;
  /** From the top of the insulation up to the soffit (mm). */
  rodLengthMm: number;
}

/** The supports of one refrigerant line, hung from `soffitMm`. */
export function layoutRefrigerantSupports(element: HvacElement, soffitMm: number): RefrigerantSupport[] {
  if (element.type !== 'refrigerant-pipe') return [];
  const spec = resolveRefrigerantPipeSpec(element.properties);
  const nodes = normalizePipeRouteNodes3d(element.properties.routeNodes3d);
  if (nodes.length < 2) return [];
  const radius = spec.outerDiameterMm / 2;
  const spacing = spec.pipeDiameterMm > SMALL_PIPE_MAX_MM + 0.01 ? LARGE_PIPE_SPACING_MM : SMALL_PIPE_SPACING_MM;
  const supports: RefrigerantSupport[] = [];
  // Level stretches: runs of level, collinear segments (a fitted arc's chords end a stretch: they are a bend).
  let index = 1;
  while (index < nodes.length) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1 || Math.abs(b.z - a.z) > 1) { index += 1; continue; }
    const axis = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    let end = index;
    while (end + 1 < nodes.length) {
      const p = nodes[end]!;
      const q = nodes[end + 1]!;
      const next = Math.hypot(q.x - p.x, q.y - p.y);
      if (next < 1 || Math.abs(q.z - p.z) > 1 || (q.x - p.x) * axis.x + (q.y - p.y) * axis.y < next * (1 - 1e-6)) break;
      end += 1;
    }
    const from = nodes[index - 1]!;
    const to = nodes[end]!;
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    if (span >= SHORTEST_HELD_MM) {
      const usable = span - 2 * CLEAR_OF_BENDS_MM;
      const count = Math.max(1, Math.ceil(usable / spacing) + 1);
      for (let k = 0; k < count; k += 1) {
        const at = count === 1 ? span / 2 : CLEAR_OF_BENDS_MM + (usable * k) / (count - 1);
        const point = { x: from.x + axis.x * at, y: from.y + axis.y * at, z: from.z };
        supports.push({
          elementId: element.id, lineKind: spec.lineKind, point, axis, insulatedDiameterMm: spec.outerDiameterMm,
          rodLengthMm: Math.max(0, soffitMm - (point.z + radius)),
        });
      }
    }
    index = end + 1;
  }
  return supports;
}

/** The BOM rows of the refrigerant supports: clips by insulated size, the rods, their anchors. */
export function refrigerantSupportBomRows(supports: readonly RefrigerantSupport[]): DuctBomRow[] {
  if (!supports.length) return [];
  const clips = new Map<number, number>();
  let rodMm = 0;
  for (const support of supports) {
    const size = Math.round(support.insulatedDiameterMm);
    clips.set(size, (clips.get(size) ?? 0) + 1);
    rodMm += support.rodLengthMm;
  }
  const rows: DuctBomRow[] = [...clips].sort((p, q) => p[0] - q[0]).map(([size, count]) => ({
    category: 'Supports', description: 'Pipe clip, rubber-lined, round the insulated refrigerant line', size: `Ø${size}`,
    quantity: count, unit: 'no.', basis: 'Level runs: 1.5 m spacing to Ø19.05, 2 m above; 300 mm clear of bends (practice)',
  }));
  rows.push(
    { category: 'Supports', description: 'Threaded rod M8, soffit to refrigerant clip', size: 'M8', quantity: Math.round(rodMm / 100) / 10, unit: 'm', basis: 'Each clip to the soffit' },
    { category: 'Supports', description: 'Soffit anchor for the M8 rod of a refrigerant clip', size: 'M8', quantity: supports.length, unit: 'no.', basis: 'One per rod' },
  );
  return rows;
}
