/**
 * Plan (2D) presentation of a fabrication plan, in world millimetres: piece
 * outlines (sections, elbows, transitions, take-offs, dampers, splits), flange
 * ticks at every joint, the hatched flexible connector, turning vanes, damper
 * blades, piece marks and size tags. The same piece polygons drive geometric
 * picking, so what you click is what is drawn.
 */
import type { Point2D } from '../../../../types';

import { gaugeLabelForSheet } from './ductCatalog';
import type { DuctElbow, DuctFabricationPlan, DuctJointKind, DuctPiece } from './ductFabricationPlanner';
import { describeJoint } from './ductGauge';
import { add, dot, ductLegs, frameToPlan, perpToward, sampleArc, scale, squareElbowGeometry, sub, unit } from './ductGeometry';
import type { DuctLeg } from './ductTypes';

export interface DuctPlanTag {
  point: Point2D;
  angleDeg: number;
  text: string;
}

export interface DuctPlanPresentation {
  id: string;
  service: 'supply' | 'return';
  status: 'ok' | 'error';
  /** Closed outline per piece (for drawing and picking). */
  piecePolygons: Array<{ mark: string; kind: DuctPiece['kind']; polygon: Point2D[] }>;
  /** Flange ticks across the duct at joints. */
  jointTicks: Array<{ a: Point2D; b: Point2D; kind: DuctJointKind }>;
  /** Zig-zag inside the connector fabric band. */
  connectorHatch: Point2D[][];
  /** Turning vanes: quadratic curve start / control / end. */
  vanes: Point2D[][];
  /** Gored (round) elbow seams, throat to heel. */
  goreLines: Array<[Point2D, Point2D]>;
  /** Volume dampers: blade line and the locking quadrant outside the duct. */
  dampers: Array<{ blade: [Point2D, Point2D]; quadrant: Point2D }>;
  centreline: Point2D[];
  marks: Array<{ point: Point2D; text: string }>;
  /** One size / construction tag per distinct section. */
  tags: DuctPlanTag[];
  errorPoints: Point2D[];
  /** Where a warning applies (an open or orphaned end, a stale link, an incomplete split). */
  warningPoints: Point2D[];
  /**
   * Risers and drops: the duct's W × H footprint at the riser with one
   * diagonal (up) or both (down), and "▲ 600 · BOD 3269" (project convention).
   */
  risers: Array<{ box: Point2D[]; diagonals: Array<[Point2D, Point2D]>; label: string; labelPoint: Point2D; up: boolean }>;
  /** Insulated run: the insulation's outer face around each piece (drawn dashed). */
  insulationOutlines: Point2D[][];
  /** Plenum boxes: their diagonals (the usual box symbol). */
  boxDiagonals: Array<[Point2D, Point2D]>;
}

/** Flange projection drawn beyond the duct side (mm). */
const FLANGE_TICK_OVERHANG_MM = 30;
const ARC_SEGMENTS = 12;

function normalOf(direction: Point2D): Point2D {
  return { x: -direction.y, y: direction.x };
}

function rectangle(start: Point2D, end: Point2D, direction: Point2D, halfWidth: number): Point2D[] {
  const n = scale(normalOf(direction), halfWidth);
  return [add(start, n), add(end, n), sub(end, n), sub(start, n)];
}

/** A riser's plan footprint: H along its heading, W across. */
function riserBox(centre: Point2D, heading: Point2D, halfAlong: number, halfAcross: number): Point2D[] {
  return rectangle(sub(centre, scale(heading, halfAlong)), add(centre, scale(heading, halfAlong)), heading, halfAcross);
}

/**
 * Plan footprint of a vertical-plane fitting (an elbow or offset at a riser):
 * the band along the heading from its level end(s) to the riser's far face.
 */
/** A piece's plan outline with its sheet `sheet` thick (grown by the insulation for its outer face). */
function pieceOutline(piece: DuctPiece, sheet: number): Point2D[] | null {
  const halfWidth = piece.widthMm / 2 + sheet;
  if (piece.frame) return verticalFittingBand(piece, sheet).polygon;
  if (piece.vertical) return riserBox(piece.start, piece.direction, piece.heightMm / 2 + sheet, halfWidth);
  switch (piece.kind) {
    case 'elbow': return elbowOutline(piece.elbow!, halfWidth);
    case 'offset': return polylineOutline(piece.offset!.centreline, halfWidth);
    case 'transition': return transitionOutline(piece, sheet);
    case 'takeoff': return takeoffOutline(piece, sheet);
    case 'straight':
    case 'plenum':
    case 'damper': return rectangle(piece.start, piece.end, piece.direction, halfWidth);
    default: return null;
  }
}

function verticalFittingBand(piece: DuctPiece, sheet: number): { polygon: Point2D[]; from: Point2D; to: Point2D; mid: Point2D } {
  const frame = piece.frame!;
  const halfAlong = (piece.elbow?.inPlaneMm ?? piece.heightMm) / 2 + sheet;
  let values: number[];
  if (piece.kind === 'elbow' && piece.elbow) {
    const elbow = piece.elbow;
    // The level end reaches out along the heading; the riser end sits on the riser (s = 0).
    const levelEnd = Math.abs(elbow.inDirection.x) > 0.5 ? elbow.startPoint.x : elbow.endPoint.x;
    values = [levelEnd, -halfAlong, halfAlong];
  } else {
    values = (piece.offset?.centreline ?? []).map((point) => point.x);
  }
  const from = Math.min(...values);
  const to = Math.max(...values);
  const a = frameToPlan(frame, { x: from, y: 0 });
  const b = frameToPlan(frame, { x: to, y: 0 });
  return { polygon: rectangle(a, b, frame.heading, piece.widthMm / 2 + sheet), from: a, to: b, mid: scale(add(a, b), 0.5) };
}

function elbowOutline(elbow: DuctElbow, halfWidth: number): Point2D[] {
  const outerIn = perpToward(elbow.inDirection, -elbow.turnSign);
  const outerOut = perpToward(elbow.outDirection, -elbow.turnSign);
  const startHeel = add(elbow.startPoint, scale(outerIn, halfWidth));
  const startThroat = sub(elbow.startPoint, scale(outerIn, halfWidth));
  const endHeel = add(elbow.endPoint, scale(outerOut, halfWidth));
  const endThroat = sub(elbow.endPoint, scale(outerOut, halfWidth));
  if (elbow.style === 'radius' || elbow.style === 'gored') {
    const heel = sampleArc(elbow, elbow.centrelineRadiusMm + halfWidth, ARC_SEGMENTS);
    const throat = sampleArc(elbow, Math.max(0, elbow.centrelineRadiusMm - halfWidth), ARC_SEGMENTS);
    return [startHeel, ...heel, endHeel, endThroat, ...throat.reverse(), startThroat];
  }
  // Square throat: mitre vertices where the heel and throat lines meet.
  const miter = scale(add(outerIn, outerOut), halfWidth / (1 + dot(outerIn, outerOut)));
  return [startHeel, add(elbow.corner, miter), endHeel, endThroat, sub(elbow.corner, miter), startThroat];
}

function vanesOf(elbow: DuctElbow, halfWidth: number): Point2D[][] {
  if (elbow.style !== 'square-vaned' || elbow.vaneCount < 1) return [];
  const outerIn = perpToward(elbow.inDirection, -elbow.turnSign);
  const outerOut = perpToward(elbow.outDirection, -elbow.turnSign);
  const miter = scale(add(outerIn, outerOut), halfWidth / (1 + dot(outerIn, outerOut)));
  const inner = sub(elbow.corner, miter);
  const outer = add(elbow.corner, miter);
  // Vane radius from the SMACNA Fig. 2-3 schedule, never wider than the pitch it is drawn at.
  const pitch = (2 * halfWidth * Math.SQRT2) / (elbow.vaneCount + 1);
  const radius = Math.min(elbow.vanes?.spec.radiusMm ?? 51, pitch * 1.5);
  const vanes: Point2D[][] = [];
  for (let index = 1; index <= elbow.vaneCount; index += 1) {
    const p = add(inner, scale(sub(outer, inner), index / (elbow.vaneCount + 1)));
    vanes.push([sub(p, scale(elbow.inDirection, radius)), p, add(p, scale(elbow.outDirection, radius))]);
  }
  return vanes;
}

/** Outline of a constant-width duct along a polyline, mitred at every vertex. */
export function polylineOutline(points: readonly Point2D[], halfWidth: number): Point2D[] {
  const left: Point2D[] = [];
  const right: Point2D[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const before = index > 0 ? normalOf(unit(sub(points[index]!, points[index - 1]!))) : null;
    const after = index + 1 < points.length ? normalOf(unit(sub(points[index + 1]!, points[index]!))) : null;
    const n1 = before ?? after!;
    const n2 = after ?? before!;
    const sum = add(n1, n2);
    const miter = Math.hypot(sum.x, sum.y) < 1e-9 ? n1 : unit(sum);
    const reach = halfWidth / Math.max(0.2, dot(miter, n1));
    left.push(add(points[index]!, scale(miter, reach)));
    right.push(sub(points[index]!, scale(miter, reach)));
  }
  return [...left, ...right.reverse()];
}

function transitionOutline(piece: DuctPiece, sheet: number): Point2D[] {
  const n = normalOf(piece.direction);
  const neck = Math.min(piece.transition?.neckMm ?? 0, piece.lengthMm / 2);
  const h1 = piece.widthMm / 2 + sheet;
  const h2 = piece.endWidthMm / 2 + sheet;
  const s1 = add(piece.start, scale(piece.direction, neck));
  const s2 = sub(piece.end, scale(piece.direction, neck));
  return [
    add(piece.start, scale(n, h1)), add(s1, scale(n, h1)), add(s2, scale(n, h2)), add(piece.end, scale(n, h2)),
    sub(piece.end, scale(n, h2)), sub(s2, scale(n, h2)), sub(s1, scale(n, h1)), sub(piece.start, scale(n, h1)),
  ];
}

/** Take-off: a straight collar, or a shoe with its 45° lead-in toward the parent's start. */
function takeoffOutline(piece: DuctPiece, sheet: number): Point2D[] {
  const half = piece.widthMm / 2 + sheet;
  const lead = piece.takeoff?.leadInMm ?? 0;
  if ((piece.takeoff?.style === 'conical' || piece.takeoff?.style === 'round-conical') && piece.takeoff.openingMm) {
    // Cone: the mouth on the parent wall is wider than the branch (SMACNA Fig. 2-6, D1 ≥ D2).
    const n = normalOf(piece.direction);
    const mouth = piece.takeoff.openingMm / 2 + sheet;
    return [add(piece.start, scale(n, mouth)), add(piece.end, scale(n, half)), sub(piece.end, scale(n, half)), sub(piece.start, scale(n, mouth))];
  }
  if (lead <= 0 || !piece.takeoff) return rectangle(piece.start, piece.end, piece.direction, half);
  const u = piece.direction;
  const v = piece.takeoff.parentDirection;
  const at = (a: number, b: number) => add(add(piece.start, scale(u, a)), scale(v, b));
  const length = piece.lengthMm;
  return [at(0, -half - lead), at(0, half), at(length, half), at(length, -half), at(Math.min(lead, length), -half)];
}

/**
 * Square-to-round fold lines in plan: from each corner of the rectangular end
 * to the round end's 45° points, the usual symbol for the development.
 */
function squareToRoundFolds(piece: DuctPiece, sheet: number): Array<[Point2D, Point2D]> {
  if (piece.kind !== 'transition' || (piece.diameterMm === undefined) === (piece.endDiameterMm === undefined)) return [];
  const n = normalOf(piece.direction);
  const neck = Math.min(piece.transition?.neckMm ?? 0, piece.lengthMm / 2);
  const rectFirst = piece.diameterMm === undefined;
  const rectHalf = (rectFirst ? piece.widthMm : piece.endWidthMm) / 2 + sheet;
  const roundHalf = ((rectFirst ? piece.endDiameterMm! : piece.diameterMm!) / 2 + sheet) * Math.SQRT1_2;
  const rectAt = rectFirst ? add(piece.start, scale(piece.direction, neck)) : sub(piece.end, scale(piece.direction, neck));
  const roundAt = rectFirst ? sub(piece.end, scale(piece.direction, neck)) : add(piece.start, scale(piece.direction, neck));
  return [
    [add(rectAt, scale(n, rectHalf)), add(roundAt, scale(n, roundHalf))],
    [sub(rectAt, scale(n, rectHalf)), sub(roundAt, scale(n, roundHalf))],
  ];
}

function readableAngle(direction: Point2D): number {
  let angle = (Math.atan2(direction.y, direction.x) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  return angle;
}

function sectionKey(section: DuctLeg): string {
  return section.diameterMm !== undefined ? `d${Math.round(section.diameterMm)}` : `${Math.round(section.widthMm)}x${Math.round(section.heightMm)}`;
}

/**
 * Seams of a gored elbow: n pieces over θ are two half-gores and n − 2 full
 * gores, so the n − 1 seams sit at θ/(2(n − 1)) + k·θ/(n − 1).
 */
function goreSeams(elbow: DuctElbow, halfWidth: number): Array<[Point2D, Point2D]> {
  const pieces = elbow.gores ?? 0;
  if (elbow.style !== 'gored' || pieces < 2 || !elbow.arcCentre) return [];
  const theta = (elbow.angleDeg * Math.PI) / 180;
  const step = theta / (pieces - 1);
  const start = sub(elbow.bendStart, elbow.arcCentre);
  const startAngle = Math.atan2(start.y, start.x);
  const seams: Array<[Point2D, Point2D]> = [];
  for (let k = 0; k < pieces - 1; k += 1) {
    const angle = startAngle + elbow.turnSign * (step / 2 + k * step);
    const radial = { x: Math.cos(angle), y: Math.sin(angle) };
    seams.push([
      add(elbow.arcCentre, scale(radial, Math.max(0, elbow.centrelineRadiusMm - halfWidth))),
      add(elbow.arcCentre, scale(radial, elbow.centrelineRadiusMm + halfWidth)),
    ]);
  }
  return seams;
}

/** "674×164 · GI 0.60 (26 ga) · TDC · BOD 2669" for one section of the run (at `bottomZ` when given). */
export function ductTagText(plan: DuctFabricationPlan, section: DuctLeg = plan.spec.legs[0]!, bottomZ?: number): string {
  const legIndex = Math.max(0, plan.spec.legs.findIndex((leg) => sectionKey(leg) === sectionKey(section)));
  const construction = plan.constructionByLeg[legIndex];
  const round = section.diameterMm !== undefined;
  const size = round ? `Ø${Math.round(section.diameterMm!)}` : `${Math.round(section.widthMm)}×${Math.round(section.heightMm)}`;
  if (!construction || construction.status !== 'ok' || construction.sheetThicknessMm === null) {
    return `${size} · ${construction?.status === 'unsupported-pressure' ? `${construction.pressureClassPa} Pa unsupported` : 'construction unresolved'}`;
  }
  const sheet = construction.sheetThicknessMm;
  // BOD is the outside bottom: of the sheet, or of the insulation on an insulated run.
  const bod = Math.round((bottomZ ?? plan.spec.path[legIndex]!.z) - sheet - plan.insulationMm);
  const seam = round ? ` · ${plan.seamRound === 'spiral' ? 'spiral' : 'long seam'}` : '';
  const insulation = plan.insulationMm > 0 ? ` · NBR ${Math.round(plan.insulationMm)}` : '';
  return `${size} · GI ${sheet.toFixed(2)} (${gaugeLabelForSheet(sheet)})${seam}${insulation} · ${describeJoint(construction.joint).split(' (')[0]} · BOD ${bod}`;
}

export function buildDuctPlanPresentation(plan: DuctFabricationPlan): DuctPlanPresentation {
  const piecePolygons: DuctPlanPresentation['piecePolygons'] = [];
  const connectorHatch: Point2D[][] = [];
  const vanes: Point2D[][] = [];
  const goreLines: Array<[Point2D, Point2D]> = [];
  const dampers: DuctPlanPresentation['dampers'] = [];
  const marks: DuctPlanPresentation['marks'] = [];
  const centreline: Point2D[] = [];
  const boxDiagonals: Array<[Point2D, Point2D]> = [];
  const tags: DuctPlanTag[] = [];
  for (const piece of plan.pieces) {
    const sheet = piece.sheetThicknessMm ?? 1;
    const halfWidth = piece.widthMm / 2 + sheet;
    const mid = scale(add(piece.start, piece.end), 0.5);
    if (piece.frame) {
      // Elbow or offset at a riser: in plan, the band it covers along the heading.
      const band = verticalFittingBand(piece, sheet);
      piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: band.polygon });
      marks.push({ point: band.mid, text: piece.mark });
      centreline.push(band.from, band.to);
      continue;
    }
    if (piece.vertical) {
      // Riser pieces stack on the riser's footprint (the riser symbol labels them).
      piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: riserBox(piece.start, piece.direction, piece.heightMm / 2 + sheet, halfWidth) });
      continue;
    }
    switch (piece.kind) {
      case 'elbow': {
        piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: elbowOutline(piece.elbow!, halfWidth) });
        vanes.push(...vanesOf(piece.elbow!, halfWidth));
        goreLines.push(...goreSeams(piece.elbow!, halfWidth));
        marks.push({ point: piece.elbow!.corner, text: piece.mark });
        const elbow = piece.elbow!;
        centreline.push(piece.start, ...(elbow.style !== 'square-vaned' ? sampleArc(elbow, elbow.centrelineRadiusMm, ARC_SEGMENTS) : [elbow.corner]), piece.end);
        break;
      }
      case 'end-cap': {
        const n = normalOf(piece.direction);
        const outward = scale(piece.direction, 6);
        piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: [
          add(piece.end, scale(n, halfWidth)), add(add(piece.end, scale(n, halfWidth)), outward),
          add(sub(piece.end, scale(n, halfWidth)), outward), sub(piece.end, scale(n, halfWidth)),
        ] });
        break;
      }
      case 'split': {
        const split = piece.split!;
        const half = split.parentSection.widthMm / 2 + sheet;
        if (split.style === 'wye') {
          // Round wye: each 45° leg tapers from the main to its outlet.
          for (const branch of split.branches) {
            const out = unit(sub(branch.outlet.point, split.origin));
            const across = normalOf(out);
            const branchHalf = branch.section.widthMm / 2 + sheet;
            piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: [
              add(split.origin, scale(across, half)), add(branch.outlet.point, scale(across, branchHalf)),
              sub(branch.outlet.point, scale(across, branchHalf)), sub(split.origin, scale(across, half)),
            ] });
            centreline.push(split.origin, branch.outlet.point);
          }
          for (const side of split.cappedSides) {
            const out = unit(add(split.direction, scale(split.normal, side)));
            const cap = add(split.origin, scale(out, half));
            const across = normalOf(out);
            piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: [
              add(split.origin, scale(across, half)), add(cap, scale(across, half * 0.8)), sub(cap, scale(across, half * 0.8)), sub(split.origin, scale(across, half)),
            ] });
          }
        } else if (split.style === 'bullhead') {
          const far = add(split.origin, scale(split.direction, split.depthMm));
          piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: [
            add(split.origin, scale(split.normal, half)), add(far, scale(split.normal, half)),
            sub(far, scale(split.normal, half)), sub(split.origin, scale(split.normal, half)),
          ] });
          for (const branch of split.branches) {
            const offset = branch.side * (split.parentSection.widthMm / 2 - branch.section.widthMm / 2);
            const corner = add(add(split.origin, scale(split.normal, offset)), scale(split.direction, split.neckMm + branch.section.widthMm / 2));
            const turn = squareElbowGeometry(corner, split.direction, scale(split.normal, branch.side), branch.section.widthMm, 0);
            vanes.push(...vanesOf({ ...turn, style: 'square-vaned', vaneCount: branch.vaneCount }, branch.section.widthMm / 2));
          }
        } else {
          for (const branch of split.branches) {
            if (!branch.elbow) continue;
            const elbow: DuctElbow = { ...branch.elbow, style: 'radius', vaneCount: 0 };
            piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: elbowOutline(elbow, branch.section.widthMm / 2 + sheet) });
            centreline.push(elbow.startPoint, ...sampleArc(elbow, elbow.centrelineRadiusMm, ARC_SEGMENTS), elbow.endPoint);
          }
          for (const side of split.cappedSides) {
            // A capped half of the Y: a blank plate across that half of the run.
            const a = add(split.origin, scale(split.normal, side * half));
            piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: [a, add(a, scale(split.direction, 6)), add(split.origin, scale(split.direction, 6)), split.origin] });
          }
        }
        marks.push({ point: add(split.origin, scale(split.direction, split.depthMm / 2)), text: piece.mark });
        break;
      }
      case 'offset': {
        const offset = piece.offset!;
        piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: polylineOutline(offset.centreline, halfWidth) });
        marks.push({ point: offset.centreline[Math.floor(offset.centreline.length / 2)]!, text: piece.mark });
        centreline.push(...offset.centreline);
        break;
      }
      case 'flex': {
        // Flexible runout: its outline along the curve, the usual zig-zag, and its tag.
        const plan = piece.flex!.points.map((point) => ({ x: point.x, y: point.y }));
        const path = plan.filter((point, index) => index === 0 || Math.hypot(point.x - plan[index - 1]!.x, point.y - plan[index - 1]!.y) > 1);
        if (path.length < 2) break;
        piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: polylineOutline(path, piece.widthMm / 2) });
        const zig: Point2D[] = [];
        const steps = Math.max(4, Math.round(piece.lengthMm / 60));
        const flat = path;
        let travelled = 0;
        const segments = flat.slice(1).map((point, index) => {
          const from = flat[index]!;
          const length = Math.hypot(point.x - from.x, point.y - from.y);
          travelled += length;
          return { from, to: point, length, end: travelled };
        });
        for (let k = 0; k <= steps; k += 1) {
          const at = (travelled * k) / steps;
          const segment = segments.find((candidate) => candidate.end >= at - 1e-6) ?? segments[segments.length - 1]!;
          const t = segment.length > 1e-9 ? 1 - (segment.end - at) / segment.length : 0;
          const point = { x: segment.from.x + (segment.to.x - segment.from.x) * t, y: segment.from.y + (segment.to.y - segment.from.y) * t };
          const n = normalOf(unit(sub(segment.to, segment.from)));
          zig.push(add(point, scale(n, (k % 2 === 0 ? 1 : -1) * piece.widthMm * 0.4)));
        }
        connectorHatch.push(zig);
        centreline.push(...path);
        const middle = path[Math.floor(path.length / 2)]!;
        tags.push({
          point: add(middle, { x: 0, y: -(piece.widthMm / 2 + 60) }), angleDeg: 0,
          text: `FLEX Ø${Math.round(piece.widthMm)} · ${(piece.lengthMm / 1000).toFixed(2)} m${piece.flex!.type === 'nm-il' ? ' · insulated' : ''}`,
        });
        break;
      }
      case 'plenum': {
        const box = rectangle(piece.start, piece.end, piece.direction, halfWidth);
        piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: box });
        boxDiagonals.push([box[0]!, box[2]!], [box[1]!, box[3]!]);
        marks.push({ point: mid, text: piece.mark });
        centreline.push(piece.start, piece.end);
        tags.push({
          point: add(mid, scale(normalOf(piece.direction), -(halfWidth + 70))), angleDeg: readableAngle(piece.direction),
          text: `PLENUM ${Math.round(piece.widthMm)}×${Math.round(piece.heightMm)}×${Math.round(piece.lengthMm)} · GI ${sheet.toFixed(2)}`,
        });
        break;
      }
      case 'transition': {
        piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: transitionOutline(piece, sheet) });
        goreLines.push(...squareToRoundFolds(piece, sheet));
        marks.push({ point: mid, text: piece.mark });
        centreline.push(piece.start, piece.end);
        break;
      }
      case 'takeoff': {
        piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: takeoffOutline(piece, sheet) });
        marks.push({ point: mid, text: piece.mark });
        centreline.push(piece.start, piece.end);
        break;
      }
      default: {
        piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: rectangle(piece.start, piece.end, piece.direction, halfWidth) });
        marks.push({ point: mid, text: piece.mark });
        centreline.push(piece.start, piece.end);
        const n = normalOf(piece.direction);
        if (piece.kind === 'damper') {
          const skew = scale(piece.direction, Math.min(piece.lengthMm / 3, halfWidth / 2));
          dampers.push({
            blade: [sub(sub(mid, scale(n, halfWidth * 0.9)), skew), add(add(mid, scale(n, halfWidth * 0.9)), skew)],
            quadrant: add(mid, scale(n, halfWidth + 45)),
          });
        }
        if (piece.kind === 'connector') {
          const metal = Math.min(piece.lengthMm / 3, piece.connectorMetalMm ?? piece.lengthMm * 0.3);
          const from = add(piece.start, scale(piece.direction, metal));
          const to = sub(piece.end, scale(piece.direction, metal));
          const zig: Point2D[] = [];
          const steps = 8;
          for (let index = 0; index <= steps; index += 1) {
            const along = add(from, scale(sub(to, from), index / steps));
            zig.push(add(along, scale(n, (index % 2 === 0 ? 1 : -1) * halfWidth * 0.8)));
          }
          connectorHatch.push(zig);
        }
      }
    }
  }
  // Flanges only: a runout's draw bands and a terminal's spigot carry no flange tick.
  const jointTicks = plan.joints.filter((joint) => !joint.vertical && joint.kind !== 'flex-connection' && joint.kind !== 'terminal-connection').map((joint) => {
    const n = normalOf(joint.direction);
    const half = joint.outerWidthMm / 2 + (joint.kind === 'unit-connection' || joint.kind === 'tap-connection' ? 0 : FLANGE_TICK_OVERHANG_MM);
    return { a: add(joint.point, scale(n, half)), b: sub(joint.point, scale(n, half)), kind: joint.kind };
  });

  // One tag per distinct section and level, on its longest level straight.
  const longestBySection = new Map<string, DuctPiece>();
  for (const piece of plan.pieces) {
    if (piece.kind !== 'straight' || piece.vertical) continue;
    const key = `${sectionKey(piece)}@${Math.round(piece.bottomZ)}`;
    const best = longestBySection.get(key);
    if (!best || piece.lengthMm > best.lengthMm) longestBySection.set(key, piece);
  }
  if (longestBySection.size === 0 && plan.pieces[0]) longestBySection.set(sectionKey(plan.pieces[0]), plan.pieces[0]);
  for (const piece of longestBySection.values()) {
    tags.push({
      point: add(scale(add(piece.start, piece.end), 0.5), scale(normalOf(piece.direction), -(piece.widthMm / 2 + 70))),
      angleDeg: readableAngle(piece.direction),
      text: ductTagText(plan, { widthMm: piece.widthMm, heightMm: piece.heightMm, ...(piece.diameterMm !== undefined ? { diameterMm: piece.diameterMm } : {}) },
        piece.vertical ? undefined : piece.bottomZ),
    });
  }

  // Risers and drops, from the run's own legs (also where an offset took the whole leg).
  const risers: DuctPlanPresentation['risers'] = [];
  for (const leg of ductLegs(plan.spec)) {
    if (!leg.vertical) continue;
    const section = plan.spec.legs[leg.index]!;
    const sheet = plan.constructionByLeg[leg.index]?.sheetThicknessMm ?? 1;
    const centre = { x: leg.start.x, y: leg.start.y };
    const halfAlong = section.heightMm / 2 + sheet;
    const halfAcross = section.widthMm / 2 + sheet;
    const box = riserBox(centre, leg.direction, halfAlong, halfAcross);
    const up = leg.vertical > 0;
    const diagonals: Array<[Point2D, Point2D]> = up ? [[box[0]!, box[2]!]] : [[box[0]!, box[2]!], [box[1]!, box[3]!]];
    const rise = Math.round(Math.abs(leg.end.z - leg.start.z));
    risers.push({
      box, diagonals, up,
      label: `${up ? '▲' : '▼'} ${rise} · BOD ${Math.round(leg.end.z - sheet - plan.insulationMm)}`,
      labelPoint: add(add(centre, scale(normalOf(leg.direction), halfAcross + 60)), scale(leg.direction, halfAlong)),
    });
  }

  return {
    id: plan.elementId,
    service: plan.spec.service,
    status: plan.status,
    piecePolygons,
    jointTicks,
    connectorHatch,
    vanes,
    goreLines,
    dampers,
    centreline,
    marks,
    tags,
    errorPoints: plan.issues.filter((issue) => issue.severity === 'error' && issue.point).map((issue) => issue.point!),
    warningPoints: plan.issues.filter((issue) => issue.severity === 'warning' && issue.point).map((issue) => issue.point!),
    risers,
    boxDiagonals,
    insulationOutlines: plan.insulationMm > 0
      ? plan.pieces.filter((piece) => piece.kind !== 'connector')
        .map((piece) => pieceOutline(piece, (piece.sheetThicknessMm ?? 1) + plan.insulationMm))
        .filter((outline): outline is Point2D[] => outline !== null)
      : [],
  };
}
