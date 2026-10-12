/**
 * The plan's duct size tags, laid out together so they stay readable at every
 * zoom:
 *  - zoomed out, each section shows its size only ("Ø200", "600×300");
 *  - from FULL_TAG_MIN_K screen pixels per millimetre (zoomed in), and always
 *    on a selected run, the full tag (gauge, seam, joint, BOD);
 *  - a tag goes beside one of its anchors (the middles of its section's
 *    longest straight stretches, then quarter points; along a runout where it
 *    runs), on either side of the duct, and must fit along that stretch (a
 *    selected run's full tag excepted);
 *  - it may not cover a tag already placed, a duct piece, a unit, a terminal or
 *    its tag, or another label; it tries the full text everywhere, then the
 *    size; failing all, it is left out.
 * The selected runs are labelled first, then bigger sections before smaller,
 * so trunks keep their tags where branches crowd them. Model millimetres
 * throughout; `k` is screen pixels per millimetre.
 */
import type { Point2D } from '../../../../types';

import type { DuctPlanTag, DuctTagAnchor } from './ductPlanPresentation';

/** Tag text size on screen (px), as the plan draws it. */
export const TAG_FONT_PX = 11;
/** Full tags from this zoom on (screen px per mm): a 1 m duct is 80 px long. */
export const FULL_TAG_MIN_K = 0.08;
/** Below this zoom a duct is a hairline: no size tags. */
export const SECTION_TAG_MIN_K = 0.012;
/** Clear space between a duct's side and its tag, and kept round every tag (screen px). */
const SIDE_GAP_PX = 4;
const PAD_PX = 2;
/** The least clear space between a duct's side and its tag (mm): past the flange ticks drawn 30 mm beyond the side. */
const MIN_SIDE_GAP_MM = 40;

export type TextMeasure = (text: string) => number;

/** A width estimate for system-ui at TAG_FONT_PX, a little generous (tests, and where no canvas is at hand). */
export function estimateTagTextPx(text: string): number {
  let em = 0;
  for (const char of text) {
    if (' .,:;·()|![]il'.includes(char)) em += 0.3;
    else if ('MWmw@Ø'.includes(char)) em += 0.84;
    else if (char >= 'A' && char <= 'Z') em += 0.66;
    else em += 0.56;
  }
  return em * TAG_FONT_PX;
}

/** A box in model millimetres: its centre, the unit axis along it, half its length and half its height. */
export interface TagBox {
  centre: Point2D;
  axis: Point2D;
  halfAlong: number;
  halfAcross: number;
}

const dot = (a: Point2D, b: Point2D) => a.x * b.x + a.y * b.y;
const across = (axis: Point2D): Point2D => ({ x: -axis.y, y: axis.x });

/** Whether two boxes overlap (separating axes). */
export function tagBoxesOverlap(a: TagBox, b: TagBox): boolean {
  const d = { x: b.centre.x - a.centre.x, y: b.centre.y - a.centre.y };
  for (const axis of [a.axis, across(a.axis), b.axis, across(b.axis)]) {
    const ra = a.halfAlong * Math.abs(dot(a.axis, axis)) + a.halfAcross * Math.abs(dot(across(a.axis), axis));
    const rb = b.halfAlong * Math.abs(dot(b.axis, axis)) + b.halfAcross * Math.abs(dot(across(b.axis), axis));
    if (Math.abs(dot(d, axis)) > ra + rb) return false;
  }
  return true;
}

/** The box a line of tag text covers, centred on `point` and turned `angleDeg`. */
export function tagTextBox(point: Point2D, angleDeg: number, textPx: number, k: number): TagBox {
  const angle = (angleDeg * Math.PI) / 180;
  const scale = 1 / Math.max(k, 1e-6);
  return {
    centre: point, axis: { x: Math.cos(angle), y: Math.sin(angle) },
    halfAlong: (textPx / 2 + PAD_PX) * scale, halfAcross: (TAG_FONT_PX * 0.62 + PAD_PX) * scale,
  };
}

/**
 * Something on the plan a tag keeps off, in model millimetres: a box (a
 * terminal, a label), or an outline (a duct piece, a unit's casing). `runId`
 * marks a run's own outlines and labels, so they can be set aside while the
 * run is drawn elsewhere (a drag, an edit).
 */
export type TagObstacle = (TagBox & { runId?: string }) | { polygon: readonly Point2D[]; bounds: TagBounds; runId?: string };

export interface TagBounds { minX: number; minY: number; maxX: number; maxY: number }

/** An outline as an obstacle. */
export function polygonObstacle(polygon: readonly Point2D[], runId?: string): TagObstacle {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  return { polygon, bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }, ...(runId ? { runId } : {}) };
}

function boxCorners(box: TagBox): Point2D[] {
  const n = across(box.axis);
  const a = { x: box.axis.x * box.halfAlong, y: box.axis.y * box.halfAlong };
  const b = { x: n.x * box.halfAcross, y: n.y * box.halfAcross };
  return [
    { x: box.centre.x - a.x - b.x, y: box.centre.y - a.y - b.y }, { x: box.centre.x + a.x - b.x, y: box.centre.y + a.y - b.y },
    { x: box.centre.x + a.x + b.x, y: box.centre.y + a.y + b.y }, { x: box.centre.x - a.x + b.x, y: box.centre.y - a.y + b.y },
  ];
}

function insideBox(point: Point2D, box: TagBox): boolean {
  const d = { x: point.x - box.centre.x, y: point.y - box.centre.y };
  return Math.abs(dot(d, box.axis)) <= box.halfAlong && Math.abs(dot(d, across(box.axis))) <= box.halfAcross;
}

function insidePolygon(point: Point2D, polygon: readonly Point2D[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const cross = (o: Point2D, p: Point2D, q: Point2D) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** A candidate box with its corners and bounds worked out once, for the obstacle tests. */
interface PreparedBox { box: TagBox; corners: Point2D[]; bounds: TagBounds }

function prepareBox(box: TagBox): PreparedBox {
  const corners = boxCorners(box);
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return { box, corners, bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } };
}

function preparedOverlaps({ box, corners, bounds: own }: PreparedBox, obstacle: TagObstacle): boolean {
  if (!('polygon' in obstacle)) return tagBoxesOverlap(box, obstacle);
  const { bounds } = obstacle;
  if (own.maxX < bounds.minX || own.minX > bounds.maxX || own.maxY < bounds.minY || own.minY > bounds.maxY) return false;
  if (obstacle.polygon.some((point) => insideBox(point, box)) || corners.some((point) => insidePolygon(point, obstacle.polygon))) return true;
  for (let index = 0; index < obstacle.polygon.length; index += 1) {
    const a = obstacle.polygon[index]!;
    const b = obstacle.polygon[(index + 1) % obstacle.polygon.length]!;
    for (let corner = 0; corner < 4; corner += 1) if (segmentsCross(a, b, corners[corner]!, corners[(corner + 1) % 4]!)) return true;
  }
  return false;
}

/** Whether a tag's box covers an obstacle. */
export function tagOverlapsObstacle(box: TagBox, obstacle: TagObstacle): boolean {
  return preparedOverlaps(prepareBox(box), obstacle);
}

export interface DuctTagSource {
  runId: string;
  service: 'supply' | 'return';
  status: 'ok' | 'error';
  /** A selected run shows full tags at any zoom and is labelled first. */
  selected?: boolean;
  /** A proposal (Auto duct, Auto route) not yet applied. */
  draft?: boolean;
  tags: readonly DuctPlanTag[];
}

export interface PlacedDuctTag {
  runId: string;
  service: 'supply' | 'return';
  status: 'ok' | 'error';
  draft: boolean;
  point: Point2D;
  angleDeg: number;
  text: string;
  /** The full tag (else the size alone). */
  full: boolean;
  box: TagBox;
}

export interface DuctTagLayoutOptions {
  measure?: TextMeasure;
  /** Already on the plan: duct pieces, units, terminals and their tags, other labels (tags keep off them). */
  obstacles?: readonly TagObstacle[];
}

/** Where a tag goes beside an anchor, on one side: clear of the duct's side by SIDE_GAP_PX. */
function tagPoint(anchor: DuctTagAnchor, side: 1 | -1, k: number): Point2D {
  const offset = anchor.halfWidthMm + Math.max(SIDE_GAP_PX / Math.max(k, 1e-6), MIN_SIDE_GAP_MM) + (TAG_FONT_PX * 0.62) / Math.max(k, 1e-6);
  return { x: anchor.point.x + anchor.normal.x * offset * side, y: anchor.point.y + anchor.normal.y * offset * side };
}

/** The tags to draw at zoom `k`, laid out as described above. */
export function layoutDuctTags(sources: readonly DuctTagSource[], k: number, options: DuctTagLayoutOptions = {}): PlacedDuctTag[] {
  if (k < SECTION_TAG_MIN_K) return [];
  const measure = options.measure ?? estimateTagTextPx;
  const placed: PlacedDuctTag[] = [];
  const taken: TagObstacle[] = [...(options.obstacles ?? [])];
  const queue = sources.flatMap((source, sourceIndex) => source.tags.map((tag, tagIndex) => ({ source, tag, order: sourceIndex * 1000 + tagIndex })))
    .sort((a, b) => Number(Boolean(b.source.selected)) - Number(Boolean(a.source.selected))
      || (b.tag.areaMm2 ?? 0) - (a.tag.areaMm2 ?? 0) || a.order - b.order);
  for (const { source, tag } of queue) {
    const full = Boolean(source.selected) || k >= FULL_TAG_MIN_K;
    const texts = [...new Set([...(full ? [tag.text] : []), ...(tag.short ? [tag.short] : [])])];
    // A tag without anchors stays where the run puts it.
    const places = tag.anchors?.length ? tag.anchors.flatMap((anchor) => ([1, -1] as const).map((side) => ({ anchor, side })))
      : [{ anchor: null, side: 1 as const }];
    let chosen: PlacedDuctTag | null = null;
    for (const text of texts) {
      const textPx = measure(text);
      // Along its own straight, or not at all; but a selected run's full tag is what the designer asked to read, so it
      // may run past (it is placed before any other; outlines and labels still stop it).
      const mustFit = !(source.selected && text === tag.text);
      for (const { anchor, side } of places) {
        if (mustFit && anchor && anchor.spanMm !== null && textPx / Math.max(k, 1e-6) > anchor.spanMm) continue;
        const point = anchor ? tagPoint(anchor, side, k) : tag.point;
        const angleDeg = anchor ? anchor.angleDeg : tag.angleDeg;
        const box = tagTextBox(point, angleDeg, textPx, k);
        const prepared = prepareBox(box);
        if (taken.some((other) => preparedOverlaps(prepared, other))) continue;
        chosen = { runId: source.runId, service: source.service, status: source.status, draft: Boolean(source.draft), point, angleDeg, text, full: text === tag.text, box };
        break;
      }
      if (chosen) break;
    }
    if (!chosen) continue;
    placed.push(chosen);
    taken.push(chosen.box);
  }
  return placed;
}
