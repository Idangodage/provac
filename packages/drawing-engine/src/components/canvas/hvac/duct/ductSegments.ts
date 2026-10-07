/**
 * Segments of a duct run: what a designer points at and talks about. A
 * segment groups the fabricated pieces that are one design decision:
 *
 *  - a leg's straight sections (its size and shape are one choice, made from
 *    fitting to fitting), keyed `leg:<i>`;
 *  - each fitting at a node (an elbow, or an offset spanning two nodes),
 *    keyed `node:<i>`; each transition at a leg's start, `transition:<i>`;
 *  - the run's start pieces (`start:connector`, `start:takeoff`,
 *    `start:damper`), its end (`end:split`, `end:plenum`, `end:cap`,
 *    `end:flex`), each fire damper in a wall (`pen:<wall>:<n>`) and each
 *    accessory set into a straight (`inline:<id>`: a volume damper, an
 *    access door, a sound attenuator).
 *
 * Keys are stable across edits that keep the run's topology (a resize, a
 * shape change, a different elbow), so an options card stays on "its"
 * segment after the designer applies a change. Pure; memoised per plan.
 */
import type { Point2D } from '../../../../types';

import type { DuctFabricationPlan, DuctPiece } from './ductFabricationPlanner';
import { DUCT_VANES } from './ductFittingRules';
import { distanceToPolygon, getDuctPlanPresentation, insidePolygon } from './ductPick';
import type { DuctLeg, DuctTapStyle } from './ductTypes';

export type DuctSegmentKind =
  | 'connector' | 'takeoff' | 'damper' | 'straight' | 'riser' | 'elbow' | 'offset' | 'transition'
  | 'split' | 'plenum' | 'end-cap' | 'flex' | 'fire-damper' | 'access-door' | 'attenuator';

/** A segment of one run, identified by its key on that run. */
export interface DuctSegmentRef {
  runId: string;
  key: string;
}

export interface DuctSegment {
  key: string;
  kind: DuctSegmentKind;
  /** Indices into the plan's pieces, in path order. */
  pieceIndices: number[];
  marks: string[];
  legIndex: number;
  nodeIndex?: number;
  /** What it is, e.g. "90° radius elbow", "Spiral duct", "45° lateral". */
  title: string;
  /** Its section, e.g. "600×300", "Ø450", "600×300 → Ø450". */
  size: string;
  /** The parameters that define it, e.g. "R/W 1.5 · throat 600 mm". */
  detail: string;
  /** Developed centreline length (mm). */
  lengthMm: number;
  round: boolean;
}

/** The segment key a piece belongs to. */
export function ductSegmentKey(piece: DuctPiece): string {
  if (piece.inlineId) return `inline:${piece.inlineId}`;
  switch (piece.kind) {
    case 'connector': return 'start:connector';
    case 'takeoff': return 'start:takeoff';
    case 'damper': return 'start:damper';
    case 'elbow':
    case 'offset': return `node:${piece.nodeIndex ?? piece.legIndex}`;
    case 'transition': return `transition:${piece.legIndex}`;
    case 'split': return 'end:split';
    case 'plenum': return 'end:plenum';
    case 'end-cap': return 'end:cap';
    case 'flex': return 'end:flex';
    case 'fire-damper': return `pen:${piece.penetrationKey ?? piece.mark}`;
    default: return `leg:${piece.legIndex}`;
  }
}

export function sectionLabel(section: Pick<DuctLeg, 'widthMm' | 'heightMm' | 'diameterMm'>): string {
  return section.diameterMm !== undefined
    ? `Ø${Math.round(section.diameterMm)}`
    : `${Math.round(section.widthMm)}×${Math.round(section.heightMm)}`;
}

function pieceStartSection(piece: DuctPiece): DuctLeg {
  return piece.diameterMm !== undefined
    ? { widthMm: piece.diameterMm, heightMm: piece.diameterMm, diameterMm: piece.diameterMm }
    : { widthMm: piece.widthMm, heightMm: piece.heightMm };
}

function pieceEndSection(piece: DuctPiece): DuctLeg {
  return piece.endDiameterMm !== undefined
    ? { widthMm: piece.endDiameterMm, heightMm: piece.endDiameterMm, diameterMm: piece.endDiameterMm }
    : { widthMm: piece.endWidthMm, heightMm: piece.endHeightMm };
}

export const TAKEOFF_TITLES: Record<DuctTapStyle, string> = {
  'shoe-45': '45° shoe take-off',
  straight: 'Straight take-off',
  'spin-in': 'Spin-in collar',
  conical: 'Conical spin-in',
  'round-tee': '90° tee',
  'round-conical': 'Conical tee',
  'round-lateral': '45° lateral (Y)',
};

const SPLIT_TITLES: Record<string, string> = { y: 'Y split', bullhead: 'Bullhead tee', wye: 'Wye' };

const round1 = (value: number) => Math.round(value * 10) / 10;
const metres = (mm: number) => `${(mm / 1000).toFixed(2)} m`;

function describe(plan: DuctFabricationPlan, kind: DuctSegmentKind, pieces: DuctPiece[]): Pick<DuctSegment, 'title' | 'size' | 'detail'> {
  const first = pieces[0]!;
  const length = pieces.reduce((total, piece) => total + piece.lengthMm, 0);
  const size = sectionLabel(pieceStartSection(first));
  switch (kind) {
    case 'connector':
      return { title: 'Flexible connector', size, detail: 'at the unit\'s collar' };
    case 'takeoff': {
      const takeoff = first.takeoff;
      const main = plan.tap?.parentSection;
      const mouth = takeoff?.openingMm && (takeoff.style === 'conical' || takeoff.style === 'round-conical') ? `mouth Ø${Math.round(takeoff.openingMm)} · ` : '';
      const lead = takeoff?.leadInMm ? `lead-in ${Math.round(takeoff.leadInMm)} mm · ` : '';
      const off = plan.spec.start.kind === 'spigot' ? 'off the plenum' : main ? `off ${sectionLabel(main)} main` : 'off its parent';
      return { title: takeoff ? TAKEOFF_TITLES[takeoff.style] : 'Take-off', size, detail: `${mouth}${lead}${off}` };
    }
    case 'damper':
      return { title: first.inlineId ? 'Volume damper (in line)' : 'Volume damper', size, detail: first.damper?.description ?? 'manual, locking quadrant' };
    case 'access-door': {
      const door = first.accessDoor;
      return { title: 'Access door', size, detail: door ? `${door.sizeMm}×${door.sizeMm} door in the ${door.face} · ${metres(length)} section` : metres(length) };
    }
    case 'attenuator': {
      const attenuator = first.attenuator;
      return {
        title: 'Sound attenuator', size,
        detail: `${metres(length)} · ${attenuator?.type === 'podded' ? 'round podded' : 'rectangular splitter'}${attenuator ? ` · casing ${attenuator.casingMm} mm proud` : ''}`,
      };
    }
    case 'straight':
    case 'riser': {
      const roundSection = first.diameterMm !== undefined;
      const title = kind === 'riser'
        ? (first.vertical === -1 ? 'Drop' : 'Riser')
        : roundSection ? (plan.seamRound === 'spiral' ? 'Spiral duct' : 'Round duct') : 'Straight duct';
      return { title, size, detail: `${metres(length)} · ${pieces.length} section${pieces.length === 1 ? '' : 's'}` };
    }
    case 'elbow': {
      const elbow = first.elbow!;
      const angle = Math.round(elbow.angleDeg);
      const inPlane = elbow.inPlaneMm ?? first.widthMm;
      const ratio = inPlane > 0 ? round1(elbow.centrelineRadiusMm / inPlane) : 0;
      const throat = Math.max(0, Math.round(elbow.centrelineRadiusMm - inPlane / 2));
      const plane = elbow.plane === 'vertical' ? ' (vertical)' : '';
      if (elbow.style === 'square-vaned') {
        const vanes = elbow.vanes ? DUCT_VANES[elbow.vanes.spec.type]?.label.split(' (')[0] ?? 'vanes' : 'vanes';
        return { title: `${angle}° square elbow${plane}`, size, detail: `${elbow.vaneCount} ${vanes} vanes` };
      }
      if (elbow.style === 'gored') {
        return { title: `${angle}° gored elbow${plane}`, size, detail: `${elbow.gores ?? 5}-piece · R/D ${ratio} · throat ${throat} mm` };
      }
      return { title: `${angle}° radius elbow${plane}`, size, detail: `R/${elbow.plane === 'vertical' ? 'H' : 'W'} ${ratio} · throat ${throat} mm` };
    }
    case 'offset': {
      const offset = first.offset!;
      return {
        title: `${offset.type === 'ogee' ? 'Ogee' : 'Mitred'} offset`, size,
        detail: `${Math.round(offset.lateralOffsetMm)} mm jog · ${Math.round(offset.angleDeg)}°`,
      };
    }
    case 'transition': {
      const from = pieceStartSection(first);
      const to = pieceEndSection(first);
      const fromRound = from.diameterMm !== undefined;
      const toRound = to.diameterMm !== undefined;
      const title = fromRound === toRound
        ? (fromRound ? ((to.diameterMm ?? 0) < (from.diameterMm ?? 0) ? 'Reducer' : 'Increaser') : 'Transition')
        : (fromRound ? 'Round-to-square' : 'Square-to-round');
      const info = first.transition;
      const angle = info ? Math.max(info.angleWidthDeg, info.angleHeightDeg) : null;
      return { title, size: `${sectionLabel(from)} → ${sectionLabel(to)}`, detail: `${metres(first.lengthMm)}${angle !== null ? ` · ${round1(angle)}° per side` : ''}` };
    }
    case 'split': {
      const style = first.split?.style ?? (plan.spec.end.kind === 'split' ? plan.spec.end.style : 'y');
      const outlets = first.split?.branches.map((branch) => sectionLabel(branch.section)).join(' + ');
      return { title: SPLIT_TITLES[style] ?? 'Split', size, detail: outlets ? `to ${outlets}` : 'outlets open' };
    }
    case 'plenum': {
      const box = first.plenum;
      return { title: 'Plenum box', size: box ? `${Math.round(box.widthMm)}×${Math.round(box.heightMm)}×${Math.round(box.lengthMm)}` : size, detail: `${box?.spigots.length ?? 0} spigot(s)` };
    }
    case 'end-cap':
      return { title: 'End cap', size, detail: 'closes the run' };
    case 'flex': {
      const flex = first.flex;
      const type = flex?.type === 'nm-il' ? 'insulated' : flex?.type === 'm-un' ? 'metallic' : 'non-metallic';
      return { title: 'Flexible runout', size, detail: `${metres(first.lengthMm)} · ${type}` };
    }
    case 'fire-damper': {
      const penetration = plan.penetrations.find((candidate) => candidate.key === first.penetrationKey);
      return { title: 'Fire damper', size, detail: penetration ? `${penetration.mark} · ${Math.round(penetration.thicknessMm)} mm wall` : 'in a wall' };
    }
    default:
      return { title: 'Duct', size, detail: '' };
  }
}

function kindOf(piece: DuctPiece): DuctSegmentKind {
  if (piece.kind === 'straight') return piece.vertical ? 'riser' : 'straight';
  return piece.kind as DuctSegmentKind;
}

const SEGMENT_CACHE = new WeakMap<DuctFabricationPlan, DuctSegment[]>();

/** The run's segments in path order (by their first piece). */
export function ductSegments(plan: DuctFabricationPlan): DuctSegment[] {
  const cached = SEGMENT_CACHE.get(plan);
  if (cached) return cached;
  const groups = new Map<string, number[]>();
  plan.pieces.forEach((piece, index) => {
    const key = ductSegmentKey(piece);
    const list = groups.get(key);
    if (list) list.push(index);
    else groups.set(key, [index]);
  });
  const segments = [...groups.entries()].map(([key, pieceIndices]): DuctSegment => {
    const pieces = pieceIndices.map((index) => plan.pieces[index]!);
    const first = pieces[0]!;
    // A leg that is a riser in part is still one leg: its straights call it a riser when all are vertical.
    const kind = first.kind === 'straight' && pieces.some((piece) => !piece.vertical) ? 'straight' : kindOf(first);
    return {
      key, kind, pieceIndices, marks: pieces.map((piece) => piece.mark),
      legIndex: first.legIndex,
      ...(first.nodeIndex !== undefined ? { nodeIndex: first.nodeIndex } : {}),
      ...describe(plan, kind, pieces),
      lengthMm: pieces.reduce((total, piece) => total + piece.lengthMm, 0),
      round: first.diameterMm !== undefined,
    };
  });
  segments.sort((a, b) => a.pieceIndices[0]! - b.pieceIndices[0]!);
  SEGMENT_CACHE.set(plan, segments);
  return segments;
}

export function ductSegmentOf(plan: DuctFabricationPlan, key: string): DuctSegment | null {
  return ductSegments(plan).find((segment) => segment.key === key) ?? null;
}

/** The segment a piece mark belongs to. */
export function ductSegmentOfMark(plan: DuctFabricationPlan, mark: string): DuctSegment | null {
  const index = plan.pieces.findIndex((piece) => piece.mark === mark);
  return index < 0 ? null : ductSegmentOf(plan, ductSegmentKey(plan.pieces[index]!));
}

/** The segment before (−1) or after (+1) `key` along the run, or null at either end. */
export function neighbourSegment(plan: DuctFabricationPlan, key: string, step: -1 | 1): DuctSegment | null {
  const segments = ductSegments(plan);
  const index = segments.findIndex((segment) => segment.key === key);
  return index < 0 ? null : segments[index + step] ?? null;
}

/** The plan outlines of a segment's pieces (for highlighting and anchoring). */
export function segmentOutlines(plan: DuctFabricationPlan, key: string): Point2D[][] {
  const segment = ductSegmentOf(plan, key);
  if (!segment) return [];
  const marks = new Set(segment.marks);
  return getDuctPlanPresentation(plan).piecePolygons.filter((polygon) => marks.has(polygon.mark)).map((polygon) => polygon.polygon);
}

/** The segment whose outline is nearest a plan point, within `toleranceMm`. */
export function segmentAtPlanPoint(plan: DuctFabricationPlan, point: Point2D, toleranceMm: number): DuctSegment | null {
  let best: { mark: string; distance: number } | null = null;
  for (const polygon of getDuctPlanPresentation(plan).piecePolygons) {
    const distance = distanceToPolygon(point, polygon.polygon);
    if (distance <= toleranceMm && (!best || distance < best.distance)) best = { mark: polygon.mark, distance };
  }
  return best ? ductSegmentOfMark(plan, best.mark) : null;
}

/** A point inside an outline: its vertex centroid when inside, else the middle of a chord across it. */
export function polygonHotspot(outline: readonly Point2D[]): Point2D | null {
  if (outline.length < 3) return null;
  const centroid = {
    x: outline.reduce((total, point) => total + point.x, 0) / outline.length,
    y: outline.reduce((total, point) => total + point.y, 0) / outline.length,
  };
  if (insidePolygon(centroid, outline)) return centroid;
  const half = Math.floor(outline.length / 2);
  for (let index = 0; index < outline.length; index += 1) {
    const a = outline[index]!;
    const b = outline[(index + half) % outline.length]!;
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (insidePolygon(middle, outline)) return middle;
  }
  return null;
}

/** A plan point inside a segment's outline (its first piece): where a pointer rests to point at it. */
export function segmentHotspot(plan: DuctFabricationPlan, key: string): Point2D | null {
  const outline = segmentOutlines(plan, key).find((polygon) => polygon.length >= 3);
  return outline ? polygonHotspot(outline) : null;
}

/** A point inside one piece's plan outline, half way up it: where a card's leader line ends. */
export function pieceHotspot3D(plan: DuctFabricationPlan, mark: string): { x: number; y: number; z: number } | null {
  const piece = plan.pieces.find((candidate) => candidate.mark === mark);
  const outline = getDuctPlanPresentation(plan).piecePolygons.find((polygon) => polygon.mark === mark)?.polygon;
  const point = outline ? polygonHotspot(outline) : null;
  if (!piece || !point) return null;
  const { minZ, maxZ } = pieceZRange(piece);
  return { x: point.x, y: point.y, z: (minZ + maxZ) / 2 };
}

export interface DuctSegmentEnd {
  point: Point2D;
  /** The centreline's height there (mm). */
  z: number;
  /** The run's heading there (along the run). */
  direction: Point2D;
  /** Half the duct's width there, to its outer face: the sheet, the insulation where it is drawn, an attenuator's casing (mm). */
  halfWidthMm: number;
  /** Half its height there, to the same face (mm). */
  halfHeightMm: number;
  round: boolean;
}

/** The plan heading at either end of a curve through 3D points. */
function headingOf(points: ReadonlyArray<{ x: number; y: number }>, at: 'start' | 'end'): Point2D | null {
  const [a, b] = at === 'start' ? [points[0], points[1]] : [points[points.length - 2], points[points.length - 1]];
  if (!a || !b) return null;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return length > 1e-6 ? { x: (b.x - a.x) / length, y: (b.y - a.y) / length } : null;
}

/**
 * Where a segment begins and ends — the brackets marking its extent in plan,
 * the rings in 3D: the point and its height, the run's heading there and the
 * duct's half section to its outer face. None for a segment that is vertical
 * in plan (a riser's pieces stack on one spot).
 */
export function segmentEnds(plan: DuctFabricationPlan, key: string): DuctSegmentEnd[] {
  const segment = ductSegmentOf(plan, key);
  if (!segment) return [];
  const pieces = segment.pieceIndices.map((index) => plan.pieces[index]!).filter((piece) => !piece.vertical && !piece.frame);
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (!first || !last) return [];
  const end = (piece: DuctPiece, at: 'start' | 'end', direction: Point2D): DuctSegmentEnd => {
    // The outer face as the plan draws it: the sheet, the insulation (not on a connector or a fire damper), a casing.
    const outer = (piece.sheetThicknessMm ?? 1) + (plan.insulationMm > 0 && piece.kind !== 'connector' && piece.kind !== 'fire-damper' ? plan.insulationMm : 0)
      + (piece.attenuator?.casingMm ?? 0);
    const diameter = at === 'start' ? piece.diameterMm : piece.endDiameterMm;
    const width = diameter ?? (at === 'start' ? piece.widthMm : piece.endWidthMm);
    const height = diameter ?? (at === 'start' ? piece.heightMm : piece.endHeightMm);
    return {
      point: at === 'start' ? piece.start : piece.end, z: at === 'start' ? piece.centreZ : piece.endCentreZ, direction,
      halfWidthMm: width / 2 + outer, halfHeightMm: height / 2 + outer, round: diameter !== undefined,
    };
  };
  return [
    end(first, 'start', first.elbow?.inDirection ?? (first.flex ? headingOf(first.flex.points, 'start') : null) ?? first.direction),
    end(last, 'end', last.elbow?.outDirection ?? (last.flex ? headingOf(last.flex.points, 'end') : null) ?? last.direction),
  ];
}

/** Plan bounds of a segment (for placing a card beside it), or null when it has no outline. */
export function segmentBounds(plan: DuctFabricationPlan, key: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const points = segmentOutlines(plan, key).flat();
  if (points.length === 0) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)), minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)), maxY: Math.max(...points.map((point) => point.y)),
  };
}

/**
 * The heights a piece spans, bottom to top (mm): its section about its
 * centreline at a level end, the end itself where the duct is vertical (its
 * face is horizontal: a riser, either end of a vertical elbow), a plenum's
 * box, a flexible runout's curve.
 */
export function pieceZRange(piece: DuctPiece): { minZ: number; maxZ: number } {
  // A vertical-plane elbow turns between a level end and a vertical one; an offset's ends are both level.
  const startVertical = piece.vertical !== undefined && piece.kind !== 'offset';
  const endVertical = piece.kind === 'elbow' && piece.frame ? !startVertical : startVertical;
  const start = startVertical ? 0 : (piece.diameterMm ?? piece.heightMm) / 2;
  const end = endVertical ? 0 : (piece.endDiameterMm ?? piece.endHeightMm) / 2;
  const zs = [piece.bottomZ, piece.centreZ - start, piece.centreZ + start, piece.endCentreZ - end, piece.endCentreZ + end];
  if (piece.plenum) zs.push(piece.bottomZ + piece.plenum.heightMm);
  for (const point of piece.flex?.points ?? []) zs.push(point.z - start, point.z + start);
  return { minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/**
 * The segment at a point on the run in 3D (a picked point on its surface): the
 * piece nearest it in plan (its outline) and in height (its range), within
 * `toleranceMm` — so a riser and the elbows over it in plan are told apart.
 * With the piece's mark, where the card is placed.
 */
export function segmentAtModelPoint(
  plan: DuctFabricationPlan,
  point: { x: number; y: number; z: number },
  toleranceMm: number,
): { segment: DuctSegment; mark: string } | null {
  const pieces = new Map(plan.pieces.map((piece) => [piece.mark, piece]));
  let best: { mark: string; distance: number } | null = null;
  for (const polygon of getDuctPlanPresentation(plan).piecePolygons) {
    const piece = pieces.get(polygon.mark);
    if (!piece) continue;
    const { minZ, maxZ } = pieceZRange(piece);
    const distance = Math.hypot(distanceToPolygon(point, polygon.polygon), Math.max(0, minZ - point.z, point.z - maxZ));
    if (distance <= toleranceMm && (!best || distance < best.distance)) best = { mark: polygon.mark, distance };
  }
  const segment = best ? ductSegmentOfMark(plan, best.mark) : null;
  return segment && best ? { segment, mark: best.mark } : null;
}

/**
 * A segment's box in the model (its pieces' plan outlines and heights; with
 * `anchorMark`, that piece's alone — where a card is placed), or null when it
 * has no outline.
 */
export function segmentBounds3D(
  plan: DuctFabricationPlan,
  key: string,
  anchorMark: string | null = null,
): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  const segment = ductSegmentOf(plan, key);
  if (!segment) return null;
  const marks = new Set(anchorMark && segment.marks.includes(anchorMark) ? [anchorMark] : segment.marks);
  const points = getDuctPlanPresentation(plan).piecePolygons.filter((polygon) => marks.has(polygon.mark)).flatMap((polygon) => polygon.polygon);
  const ranges = plan.pieces.filter((piece) => marks.has(piece.mark)).map(pieceZRange);
  if (points.length === 0 || ranges.length === 0) return null;
  return {
    min: { x: Math.min(...points.map((point) => point.x)), y: Math.min(...points.map((point) => point.y)), z: Math.min(...ranges.map((range) => range.minZ)) },
    max: { x: Math.max(...points.map((point) => point.x)), y: Math.max(...points.map((point) => point.y)), z: Math.max(...ranges.map((range) => range.maxZ)) },
  };
}

/** A model point on a segment's first piece, half way up it: where a pointer rests to point at the segment in 3D. */
export function segmentHotspot3D(plan: DuctFabricationPlan, key: string): { x: number; y: number; z: number } | null {
  const segment = ductSegmentOf(plan, key);
  const point = segmentHotspot(plan, key);
  const piece = segment ? plan.pieces[segment.pieceIndices[0]!] : undefined;
  if (!point || !piece) return null;
  const { minZ, maxZ } = pieceZRange(piece);
  return { x: point.x, y: point.y, z: (minZ + maxZ) / 2 };
}

/** The issues of a plan that belong to a segment (by their node, leg, wall crossing, or where they point). */
export function segmentIssues(plan: DuctFabricationPlan, key: string): DuctFabricationPlan['issues'] {
  const segment = ductSegmentOf(plan, key);
  if (!segment) return [];
  const outlines = segmentOutlines(plan, key);
  return plan.issues.filter((issue) => {
    if (issue.penetrationKey !== undefined) return key === `pen:${issue.penetrationKey}`;
    if (issue.nodeIndex !== undefined) return segment.nodeIndex === issue.nodeIndex && (segment.kind === 'elbow' || segment.kind === 'offset');
    if (issue.legIndex !== undefined) return segment.key === `leg:${issue.legIndex}`;
    if (!issue.point) return false;
    return outlines.some((outline) => distanceToPolygon(issue.point!, outline) <= 1);
  });
}
