/**
 * Plan (2D) presentation of a fabrication plan, in world millimetres: piece
 * outlines, flange ticks at every joint, the hatched flexible connector, the
 * end cap, turning vanes, piece marks and the size tag. The same piece
 * polygons drive geometric picking, so what you click is what is drawn.
 */
import type { Point2D } from '../../../../types';

import { gaugeLabelForSheet } from './ductCatalog';
import type { DuctFabricationPlan, DuctPiece } from './ductFabricationPlanner';
import { describeJoint } from './ductGauge';
import { add, dot, perpToward, sampleArc, scale, sub } from './ductGeometry';

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
  jointTicks: Array<{ a: Point2D; b: Point2D; kind: 'flange' | 'unit-connection' | 'end-cap' }>;
  /** Zig-zag inside the connector fabric band. */
  connectorHatch: Point2D[][];
  vanes: Point2D[][];
  centreline: Point2D[];
  marks: Array<{ point: Point2D; text: string }>;
  tag: DuctPlanTag | null;
  errorPoints: Point2D[];
}

/** Flange projection drawn beyond the duct side (mm). */
const FLANGE_TICK_OVERHANG_MM = 30;
const ARC_SEGMENTS = 12;

function rectangle(start: Point2D, end: Point2D, direction: Point2D, halfWidth: number): Point2D[] {
  const n = { x: -direction.y * halfWidth, y: direction.x * halfWidth };
  return [add(start, n), add(end, n), sub(end, n), sub(start, n)];
}

function elbowPolygon(piece: DuctPiece, halfWidth: number): Point2D[] {
  const elbow = piece.elbow!;
  const outerIn = perpToward(elbow.inDirection, -elbow.turnSign);
  const outerOut = perpToward(elbow.outDirection, -elbow.turnSign);
  const startHeel = add(elbow.startPoint, scale(outerIn, halfWidth));
  const startThroat = sub(elbow.startPoint, scale(outerIn, halfWidth));
  const endHeel = add(elbow.endPoint, scale(outerOut, halfWidth));
  const endThroat = sub(elbow.endPoint, scale(outerOut, halfWidth));
  if (elbow.style === 'radius') {
    const heel = sampleArc(elbow, elbow.centrelineRadiusMm + halfWidth, ARC_SEGMENTS);
    const throat = sampleArc(elbow, Math.max(0, elbow.centrelineRadiusMm - halfWidth), ARC_SEGMENTS);
    return [startHeel, ...heel, endHeel, endThroat, ...throat.reverse(), startThroat];
  }
  // Square throat: mitre vertices where the heel and throat lines meet.
  const miter = scale(add(outerIn, outerOut), halfWidth / (1 + dot(outerIn, outerOut)));
  return [startHeel, add(elbow.corner, miter), endHeel, endThroat, sub(elbow.corner, miter), startThroat];
}

function vanesFor(piece: DuctPiece, halfWidth: number): Point2D[][] {
  const elbow = piece.elbow!;
  if (elbow.style !== 'square-vaned' || elbow.vaneCount < 1) return [];
  const outerIn = perpToward(elbow.inDirection, -elbow.turnSign);
  const outerOut = perpToward(elbow.outDirection, -elbow.turnSign);
  const miter = scale(add(outerIn, outerOut), halfWidth / (1 + dot(outerIn, outerOut)));
  const inner = sub(elbow.corner, miter);
  const outer = add(elbow.corner, miter);
  const radius = Math.min(51, (2 * halfWidth) / (elbow.vaneCount + 1));
  const vanes: Point2D[][] = [];
  for (let index = 1; index <= elbow.vaneCount; index += 1) {
    const p = add(inner, scale(sub(outer, inner), index / (elbow.vaneCount + 1)));
    // Quadratic curve start / control / end: tangent to the incoming and outgoing flow.
    vanes.push([sub(p, scale(elbow.inDirection, radius)), p, add(p, scale(elbow.outDirection, radius))]);
  }
  return vanes;
}

function readableAngle(direction: Point2D): number {
  let angle = (Math.atan2(direction.y, direction.x) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  return angle;
}

export function ductTagText(plan: DuctFabricationPlan): string {
  const leg = plan.spec.legs[0]!;
  const construction = plan.constructionByLeg[0];
  const size = `${Math.round(leg.widthMm)}×${Math.round(leg.heightMm)}`;
  if (!construction || construction.status !== 'ok' || construction.sheetThicknessMm === null) {
    return `${size} · ${construction?.status === 'unsupported-pressure' ? `${construction.pressureClassPa} Pa unsupported` : 'construction unresolved'}`;
  }
  const sheet = construction.sheetThicknessMm;
  const bod = Math.round(plan.spec.path[0]!.z - sheet);
  return `${size} · GI ${sheet.toFixed(2)} (${gaugeLabelForSheet(sheet)}) · ${describeJoint(construction.joint).split(' (')[0]} · BOD ${bod}`;
}

export function buildDuctPlanPresentation(plan: DuctFabricationPlan): DuctPlanPresentation {
  const piecePolygons: DuctPlanPresentation['piecePolygons'] = [];
  const connectorHatch: Point2D[][] = [];
  const vanes: Point2D[][] = [];
  const marks: DuctPlanPresentation['marks'] = [];
  for (const piece of plan.pieces) {
    const sheet = piece.sheetThicknessMm ?? 1;
    const halfWidth = piece.widthMm / 2 + sheet;
    if (piece.kind === 'elbow') {
      piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: elbowPolygon(piece, halfWidth) });
      vanes.push(...vanesFor(piece, halfWidth));
      marks.push({ point: piece.elbow!.corner, text: piece.mark });
      continue;
    }
    if (piece.kind === 'end-cap') {
      const n = { x: -piece.direction.y, y: piece.direction.x };
      const outward = scale(piece.direction, 6);
      piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: [
        add(piece.end, scale(n, halfWidth)), add(add(piece.end, scale(n, halfWidth)), outward),
        add(sub(piece.end, scale(n, halfWidth)), outward), sub(piece.end, scale(n, halfWidth)),
      ] });
      continue;
    }
    piecePolygons.push({ mark: piece.mark, kind: piece.kind, polygon: rectangle(piece.start, piece.end, piece.direction, halfWidth) });
    marks.push({ point: scale(add(piece.start, piece.end), 0.5), text: piece.mark });
    if (piece.kind === 'connector') {
      const metal = Math.min(piece.lengthMm / 3, piece.connectorMetalMm ?? piece.lengthMm * 0.3);
      const from = add(piece.start, scale(piece.direction, metal));
      const to = sub(piece.end, scale(piece.direction, metal));
      const n = { x: -piece.direction.y, y: piece.direction.x };
      const zig: Point2D[] = [];
      const steps = 8;
      for (let index = 0; index <= steps; index += 1) {
        const along = add(from, scale(sub(to, from), index / steps));
        zig.push(add(along, scale(n, (index % 2 === 0 ? 1 : -1) * halfWidth * 0.8)));
      }
      connectorHatch.push(zig);
    }
  }
  const jointTicks = plan.joints.map((joint) => {
    const n = { x: -joint.direction.y, y: joint.direction.x };
    const half = joint.outerWidthMm / 2 + (joint.kind === 'unit-connection' ? 0 : FLANGE_TICK_OVERHANG_MM);
    return { a: add(joint.point, scale(n, half)), b: sub(joint.point, scale(n, half)), kind: joint.kind };
  });

  const centreline: Point2D[] = [];
  for (const piece of plan.pieces) {
    if (piece.kind === 'elbow' && piece.elbow!.style === 'radius') {
      centreline.push(piece.start, ...sampleArc(piece.elbow!, piece.elbow!.centrelineRadiusMm, ARC_SEGMENTS), piece.end);
    } else if (piece.kind === 'elbow') {
      centreline.push(piece.start, piece.elbow!.corner, piece.end);
    } else if (piece.kind !== 'end-cap') {
      centreline.push(piece.start, piece.end);
    }
  }

  const straights = plan.pieces.filter((piece) => piece.kind === 'straight');
  const longest = straights.reduce<DuctPiece | null>((best, piece) => (!best || piece.lengthMm > best.lengthMm ? piece : best), null);
  const tagPiece = longest ?? plan.pieces[0] ?? null;
  const tag = tagPiece ? {
    point: add(scale(add(tagPiece.start, tagPiece.end), 0.5), scale({ x: -tagPiece.direction.y, y: tagPiece.direction.x }, -(tagPiece.widthMm / 2 + 70))),
    angleDeg: readableAngle(tagPiece.direction),
    text: ductTagText(plan),
  } : null;

  return {
    id: plan.elementId,
    service: plan.spec.service,
    status: plan.status,
    piecePolygons,
    jointTicks,
    connectorHatch,
    vanes,
    centreline,
    marks,
    tag,
    errorPoints: plan.issues.filter((issue) => issue.severity === 'error' && issue.point).map((issue) => issue.point!),
  };
}
