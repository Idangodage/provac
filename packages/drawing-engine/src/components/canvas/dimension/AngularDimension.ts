import type { Point2D } from '../../../types';

import type { LinearDimensionStyle } from './LinearDimension';

const TWO_PI = Math.PI * 2;
const EPSILON = 0.000001;
const EXTENSION_OVERSHOOT = 5;
const TEXT_OUTWARD_OFFSET = 12;
const DEFAULT_HIT_THRESHOLD = 6;

export interface AngularDimensionInput {
  id?: string;
  vertex: Point2D;
  point1: Point2D;
  point2: Point2D;
  arcRadius: number;
  reflex?: boolean;
  style?: Partial<LinearDimensionStyle>;
}

export interface AngularDimensionGrip {
  id: 'vertex' | 'arc-midpoint' | 'p1' | 'p2';
  point: Point2D;
  draggable: true;
}

export interface AngularDimensionRendererApi {
  draw(ctx: CanvasRenderingContext2D): void;
  hitTest(point: Point2D, threshold?: number): boolean;
  move(delta: Point2D): void;
  getGrips(): AngularDimensionGrip[];
  dragGrip(id: AngularDimensionGrip['id'], nextPoint: Point2D): void;
}

interface ArcSolveResult {
  angle1: number;
  angle2: number;
  ccw: boolean;
  sweep: number;
  valueDegrees: number;
  startPoint: Point2D;
  endPoint: Point2D;
  extensionEnd1: Point2D;
  extensionEnd2: Point2D;
  midpointAngle: number;
  midpointPoint: Point2D;
  textPosition: Point2D;
  label: string;
}

interface SolveArcOptions {
  pxToWorld?: number;
}

const DEFAULT_STYLE: LinearDimensionStyle = {
  lineColor: '#111827',
  textColor: '#111827',
  fontSize: 12,
  arrowSize: 8,
  lineWidth: 1,
};

function clonePoint(point: Point2D): Point2D {
  return { x: point.x, y: point.y };
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(vector: Point2D, amount: number): Point2D {
  return { x: vector.x * amount, y: vector.y * amount };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function magnitude(vector: Point2D): number {
  return Math.hypot(vector.x, vector.y);
}

function normalize(vector: Point2D): Point2D {
  const len = magnitude(vector);
  if (len < EPSILON) return { x: 1, y: 0 };
  return { x: vector.x / len, y: vector.y / len };
}

function normalizeAngle(angle: number): number {
  let next = angle;
  while (next > Math.PI) next -= TWO_PI;
  while (next <= -Math.PI) next += TWO_PI;
  return next;
}

function normalizeSweep(value: number): number {
  let next = value % TWO_PI;
  if (next < 0) next += TWO_PI;
  return next;
}

function pointFromAngle(origin: Point2D, angle: number, distance: number): Point2D {
  return {
    x: origin.x + Math.cos(angle) * distance,
    y: origin.y + Math.sin(angle) * distance,
  };
}

function perpendicularLeft(vector: Point2D): Point2D {
  return { x: -vector.y, y: vector.x };
}

function distanceToSegment(point: Point2D, start: Point2D, end: Point2D): number {
  const segment = subtract(end, start);
  const lenSq = dot(segment, segment);
  if (lenSq < EPSILON) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / lenSq));
  const projection = add(start, scale(segment, t));
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

function normalizeStyle(style?: Partial<LinearDimensionStyle>): LinearDimensionStyle {
  return {
    lineColor: style?.lineColor ?? DEFAULT_STYLE.lineColor,
    textColor: style?.textColor ?? DEFAULT_STYLE.textColor,
    fontSize: Math.max(1, style?.fontSize ?? DEFAULT_STYLE.fontSize),
    arrowSize: Math.max(2, style?.arrowSize ?? DEFAULT_STYLE.arrowSize),
    lineWidth: Math.max(0.1, style?.lineWidth ?? DEFAULT_STYLE.lineWidth),
  };
}

function randomId(): string {
  return `ang-dim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatAngleDegrees(value: number): string {
  const normalized = ((value % 360) + 360) % 360;
  const rounded1 = Math.round(normalized * 10) / 10;
  const nearestInt = Math.round(rounded1);
  if (Math.abs(rounded1 - nearestInt) < 0.000001) {
    return `${nearestInt}°`;
  }
  return `${rounded1.toFixed(1)}°`;
}

export class AngularDimension implements AngularDimensionRendererApi {
  readonly id: string;
  private vertex: Point2D;
  private point1: Point2D;
  private point2: Point2D;
  private arcRadius: number;
  private reflex: boolean;
  private style: LinearDimensionStyle;

  constructor(input: AngularDimensionInput) {
    this.id = input.id ?? randomId();
    this.vertex = clonePoint(input.vertex);
    this.point1 = clonePoint(input.point1);
    this.point2 = clonePoint(input.point2);
    this.arcRadius = Math.max(1, input.arcRadius);
    this.reflex = Boolean(input.reflex);
    this.style = normalizeStyle(input.style);
  }

  setVertex(vertex: Point2D): this {
    this.vertex = clonePoint(vertex);
    return this;
  }

  setPoints(point1: Point2D, point2: Point2D): this {
    this.point1 = clonePoint(point1);
    this.point2 = clonePoint(point2);
    return this;
  }

  setArcRadius(arcRadius: number): this {
    this.arcRadius = Math.max(1, arcRadius);
    return this;
  }

  setReflex(reflex: boolean): this {
    this.reflex = reflex;
    return this;
  }

  setStyle(style: Partial<LinearDimensionStyle>): this {
    this.style = normalizeStyle({ ...this.style, ...style });
    return this;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const viewScale = this.getContextScale(ctx);
    const pxToWorld = 1 / viewScale;
    const renderLineWidth = Math.max(this.style.lineWidth, 1) * pxToWorld;
    const renderFontSize = Math.max(this.style.fontSize, 12) * pxToWorld;
    const renderArrowSize = Math.max(this.style.arrowSize, 8) * pxToWorld;
    const geometry = this.solveArcGeometry({
      pxToWorld,
    });

    ctx.save();
    ctx.strokeStyle = this.style.lineColor;
    ctx.fillStyle = this.style.lineColor;
    ctx.lineWidth = renderLineWidth;

    // Extension lines from vertex toward p1 / p2 with overshoot beyond arc.
    ctx.beginPath();
    ctx.moveTo(this.vertex.x, this.vertex.y);
    ctx.lineTo(geometry.extensionEnd1.x, geometry.extensionEnd1.y);
    ctx.moveTo(this.vertex.x, this.vertex.y);
    ctx.lineTo(geometry.extensionEnd2.x, geometry.extensionEnd2.y);
    ctx.stroke();

    // Arc on selected interior/reflex sweep.
    ctx.beginPath();
    ctx.arc(this.vertex.x, this.vertex.y, this.arcRadius, geometry.angle1, geometry.angle2, geometry.ccw);
    ctx.stroke();

    this.drawArcEndArrow(ctx, geometry.angle1, geometry.ccw, true, renderArrowSize);
    this.drawArcEndArrow(ctx, geometry.angle2, geometry.ccw, false, renderArrowSize);

    ctx.font = `${renderFontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.style.textColor;
    ctx.fillText(geometry.label, geometry.textPosition.x, geometry.textPosition.y);

    ctx.restore();
  }

  hitTest(point: Point2D, threshold = DEFAULT_HIT_THRESHOLD): boolean {
    const geometry = this.solveArcGeometry();
    const hitThreshold = Math.max(0, threshold);

    if (distanceToSegment(point, this.vertex, geometry.extensionEnd1) <= hitThreshold) return true;
    if (distanceToSegment(point, this.vertex, geometry.extensionEnd2) <= hitThreshold) return true;

    const radialDistance = Math.hypot(point.x - this.vertex.x, point.y - this.vertex.y);
    if (Math.abs(radialDistance - this.arcRadius) > hitThreshold) return false;
    return this.isAngleOnArc(Math.atan2(point.y - this.vertex.y, point.x - this.vertex.x), geometry);
  }

  move(delta: Point2D): void {
    this.vertex = add(this.vertex, delta);
    this.point1 = add(this.point1, delta);
    this.point2 = add(this.point2, delta);
  }

  getGrips(): AngularDimensionGrip[] {
    const geometry = this.solveArcGeometry();
    return [
      { id: 'vertex', point: clonePoint(this.vertex), draggable: true },
      { id: 'arc-midpoint', point: clonePoint(geometry.midpointPoint), draggable: true },
      { id: 'p1', point: clonePoint(this.point1), draggable: true },
      { id: 'p2', point: clonePoint(this.point2), draggable: true },
    ];
  }

  dragGrip(id: AngularDimensionGrip['id'], nextPoint: Point2D): void {
    if (id === 'vertex') {
      const delta = subtract(nextPoint, this.vertex);
      this.move(delta);
      return;
    }
    if (id === 'arc-midpoint') {
      this.arcRadius = Math.max(1, Math.hypot(nextPoint.x - this.vertex.x, nextPoint.y - this.vertex.y));
      return;
    }
    if (id === 'p1') {
      this.point1 = clonePoint(nextPoint);
      return;
    }
    this.point2 = clonePoint(nextPoint);
  }

  private solveArcGeometry(options: SolveArcOptions = {}): ArcSolveResult {
    const pxToWorld = options.pxToWorld ?? 1;
    const extensionOvershoot = EXTENSION_OVERSHOOT * pxToWorld;
    const textOutwardOffset = TEXT_OUTWARD_OFFSET * pxToWorld;
    const angle1 = Math.atan2(this.point1.y - this.vertex.y, this.point1.x - this.vertex.x);
    const angle2 = Math.atan2(this.point2.y - this.vertex.y, this.point2.x - this.vertex.x);
    const rawCcwSweep = normalizeSweep(angle2 - angle1);
    const cwSweep = TWO_PI - rawCcwSweep;

    let ccw: boolean;
    let sweep: number;
    if (this.reflex) {
      ccw = rawCcwSweep > Math.PI;
      sweep = ccw ? rawCcwSweep : cwSweep;
    } else {
      ccw = rawCcwSweep <= Math.PI;
      sweep = ccw ? rawCcwSweep : cwSweep;
    }

    const valueDegrees = normalizeSweep(sweep) * (180 / Math.PI);
    const midpointAngle = normalizeAngle(angle1 + (ccw ? 1 : -1) * (sweep / 2));

    const extensionEnd1 = pointFromAngle(this.vertex, angle1, this.arcRadius + extensionOvershoot);
    const extensionEnd2 = pointFromAngle(this.vertex, angle2, this.arcRadius + extensionOvershoot);
    const startPoint = pointFromAngle(this.vertex, angle1, this.arcRadius);
    const endPoint = pointFromAngle(this.vertex, angle2, this.arcRadius);
    const midpointPoint = pointFromAngle(this.vertex, midpointAngle, this.arcRadius);
    const textPosition = pointFromAngle(this.vertex, midpointAngle, this.arcRadius + textOutwardOffset);

    return {
      angle1,
      angle2,
      ccw,
      sweep,
      valueDegrees,
      startPoint,
      endPoint,
      extensionEnd1,
      extensionEnd2,
      midpointAngle,
      midpointPoint,
      textPosition,
      label: formatAngleDegrees(valueDegrees),
    };
  }

  private drawArcEndArrow(
    ctx: CanvasRenderingContext2D,
    angle: number,
    ccw: boolean,
    isStart: boolean,
    arrowSize: number
  ): void {
    const tip = pointFromAngle(this.vertex, angle, this.arcRadius);
    const radial = normalize(subtract(tip, this.vertex));
    const tangentBase = perpendicularLeft(radial);
    const sweepSign = ccw ? 1 : -1;
    const tangentAlongSweep = scale(tangentBase, sweepSign);
    const arrowDirection = isStart ? tangentAlongSweep : scale(tangentAlongSweep, -1);
    const normal = perpendicularLeft(arrowDirection);

    const arrowLength = arrowSize;
    const arrowWidth = arrowSize * 0.5;
    const baseCenter = add(tip, scale(arrowDirection, arrowLength));
    const left = add(baseCenter, scale(normal, arrowWidth * 0.5));
    const right = add(baseCenter, scale(normal, -arrowWidth * 0.5));

    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fill();
  }

  private isAngleOnArc(angle: number, geometry: ArcSolveResult): boolean {
    const normalizedAngle = normalizeSweep(angle);
    const normalizedStart = normalizeSweep(geometry.angle1);
    const signedDelta = geometry.ccw
      ? normalizeSweep(normalizedAngle - normalizedStart)
      : normalizeSweep(normalizedStart - normalizedAngle);
    return signedDelta <= geometry.sweep + 0.0001;
  }

  private getContextScale(ctx: CanvasRenderingContext2D): number {
    const transform = ctx.getTransform();
    const scaleX = Math.hypot(transform.a, transform.b);
    const scaleY = Math.hypot(transform.c, transform.d);
    return Math.max((scaleX + scaleY) * 0.5, EPSILON);
  }
}
