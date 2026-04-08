import type { Point2D } from '../../../types';

import type { LinearDimensionStyle } from './LinearDimension';

const DEFAULT_LEADER_EXTENSION = 40;
const DEFAULT_TEXT_GAP = 4;
const DEFAULT_HIT_THRESHOLD = 6;
const CENTER_DOT_RADIUS = 2;
const EPSILON = 0.000001;

export interface RadiusDimensionInput {
  id?: string;
  center: Point2D;
  radius: number; // px
  angle: number; // radians
  scaleFactor: number; // real-world units per px
  style?: Partial<LinearDimensionStyle>;
}

export interface RadiusDimensionGrip {
  id: 'center' | 'surface' | 'text';
  point: Point2D;
  draggable: true;
}

export interface RadiusDimensionRendererApi {
  draw(ctx: CanvasRenderingContext2D): void;
  hitTest(point: Point2D, threshold?: number): boolean;
  move(delta: Point2D): void;
  getGrips(): RadiusDimensionGrip[];
}

interface RadiusDimensionGeometry {
  center: Point2D;
  leaderStart: Point2D;
  leaderEnd: Point2D;
  textPosition: Point2D;
  label: string;
  direction: Point2D;
  angle: number;
}

interface ComputeGeometryOptions {
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

function normalize(vector: Point2D): Point2D {
  const length = Math.hypot(vector.x, vector.y);
  if (length < EPSILON) return { x: 1, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

function perpendicular(vector: Point2D): Point2D {
  return { x: -vector.y, y: vector.x };
}

function normalizeAngle(angle: number): number {
  let next = angle;
  while (next > Math.PI) next -= Math.PI * 2;
  while (next <= -Math.PI) next += Math.PI * 2;
  return next;
}

function distanceToSegment(point: Point2D, start: Point2D, end: Point2D): number {
  const segment = subtract(end, start);
  const segmentLengthSq = dot(segment, segment);
  if (segmentLengthSq < EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);

  const t = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / segmentLengthSq));
  const projection = add(start, scale(segment, t));
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

function randomId(): string {
  return `rad-dim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStyle(override?: Partial<LinearDimensionStyle>): LinearDimensionStyle {
  return {
    lineColor: override?.lineColor ?? DEFAULT_STYLE.lineColor,
    textColor: override?.textColor ?? DEFAULT_STYLE.textColor,
    fontSize: Math.max(1, override?.fontSize ?? DEFAULT_STYLE.fontSize),
    arrowSize: Math.max(2, override?.arrowSize ?? DEFAULT_STYLE.arrowSize),
    lineWidth: Math.max(0.1, override?.lineWidth ?? DEFAULT_STYLE.lineWidth),
  };
}

export class RadiusDimension implements RadiusDimensionRendererApi {
  readonly id: string;
  private center: Point2D;
  private radius: number;
  private angle: number;
  private scaleFactor: number;
  private style: LinearDimensionStyle;

  constructor(input: RadiusDimensionInput) {
    this.id = input.id ?? randomId();
    this.center = clonePoint(input.center);
    this.radius = Math.max(0, input.radius);
    this.angle = input.angle;
    this.scaleFactor = Math.max(0, input.scaleFactor);
    this.style = normalizeStyle(input.style);
  }

  setCenter(center: Point2D): this {
    this.center = clonePoint(center);
    return this;
  }

  setRadius(radius: number): this {
    this.radius = Math.max(0, radius);
    return this;
  }

  setAngle(angle: number): this {
    this.angle = normalizeAngle(angle);
    return this;
  }

  setScaleFactor(scaleFactor: number): this {
    this.scaleFactor = Math.max(0, scaleFactor);
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
    const geometry = this.computeGeometry({
      width: ctx.canvas.width,
      height: ctx.canvas.height,
      pxToWorld,
    });
    this.angle = geometry.angle;

    ctx.save();
    ctx.strokeStyle = this.style.lineColor;
    ctx.fillStyle = this.style.lineColor;
    ctx.lineWidth = renderLineWidth;

    // Leader line from arc/circle surface to label anchor.
    ctx.beginPath();
    ctx.moveTo(geometry.leaderStart.x, geometry.leaderStart.y);
    ctx.lineTo(geometry.leaderEnd.x, geometry.leaderEnd.y);
    ctx.stroke();

    // Arrow at leader start, pointing inward (toward center).
    this.drawArrowAtLeaderStart(ctx, geometry.leaderStart, geometry.center, renderArrowSize);

    // Center marker.
    ctx.beginPath();
    ctx.arc(geometry.center.x, geometry.center.y, CENTER_DOT_RADIUS * pxToWorld, 0, Math.PI * 2);
    ctx.fill();

    // Text label "Rxxxx" with 4px gap from leader end.
    ctx.font = `${renderFontSize}px Arial`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = geometry.direction.x >= 0 ? 'left' : 'right';
    ctx.fillStyle = this.style.textColor;
    ctx.fillText(geometry.label, geometry.textPosition.x, geometry.textPosition.y);

    ctx.restore();
  }

  hitTest(point: Point2D, threshold = DEFAULT_HIT_THRESHOLD): boolean {
    const geometry = this.computeGeometry();
    const hitThreshold = Math.max(0, threshold);
    return distanceToSegment(point, geometry.leaderStart, geometry.leaderEnd) <= hitThreshold;
  }

  move(delta: Point2D): void {
    this.center = add(this.center, delta);
  }

  getGrips(): RadiusDimensionGrip[] {
    const geometry = this.computeGeometry();
    return [
      { id: 'center', point: clonePoint(geometry.center), draggable: true },
      { id: 'surface', point: clonePoint(geometry.leaderStart), draggable: true },
      { id: 'text', point: clonePoint(geometry.textPosition), draggable: true },
    ];
  }

  private drawArrowAtLeaderStart(
    ctx: CanvasRenderingContext2D,
    leaderStart: Point2D,
    center: Point2D,
    arrowSize: number
  ): void {
    const toCenter = normalize(subtract(center, leaderStart));
    const normal = perpendicular(toCenter);
    const arrowLength = arrowSize;
    const arrowWidth = arrowSize * 0.5;

    // Put base opposite to center so arrow points inward.
    const baseCenter = add(leaderStart, scale(toCenter, -arrowLength));
    const left = add(baseCenter, scale(normal, arrowWidth * 0.5));
    const right = add(baseCenter, scale(normal, -arrowWidth * 0.5));

    ctx.beginPath();
    ctx.moveTo(leaderStart.x, leaderStart.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fill();
  }

  private computeGeometry(canvasBounds?: { width: number; height: number; pxToWorld?: number }): RadiusDimensionGeometry {
    const pxToWorld = canvasBounds?.pxToWorld ?? 1;
    const leaderExtension = DEFAULT_LEADER_EXTENSION * pxToWorld;
    const textGap = DEFAULT_TEXT_GAP * pxToWorld;
    let angle = this.angle;
    let direction = { x: Math.cos(angle), y: Math.sin(angle) };
    let leaderStart = add(this.center, scale(direction, this.radius));
    let leaderEnd = add(leaderStart, scale(direction, leaderExtension));

    if (canvasBounds && this.isOutsideCanvas(leaderEnd, canvasBounds)) {
      angle = normalizeAngle(angle + Math.PI);
      direction = { x: Math.cos(angle), y: Math.sin(angle) };
      leaderStart = add(this.center, scale(direction, this.radius));
      leaderEnd = add(leaderStart, scale(direction, leaderExtension));
    }

    const textPosition = add(leaderEnd, scale(direction, textGap));
    const value = Math.hypot(direction.x * this.radius, direction.y * this.radius) * this.scaleFactor;
    const label = `R${Math.round(value)}`;

    return {
      center: clonePoint(this.center),
      leaderStart,
      leaderEnd,
      textPosition,
      label,
      direction,
      angle,
    };
  }

  private isOutsideCanvas(point: Point2D, bounds: { width: number; height: number }): boolean {
    return (
      point.x < 0 ||
      point.y < 0 ||
      point.x > bounds.width ||
      point.y > bounds.height
    );
  }

  private getContextScale(ctx: CanvasRenderingContext2D): number {
    const transform = ctx.getTransform();
    const scaleX = Math.hypot(transform.a, transform.b);
    const scaleY = Math.hypot(transform.c, transform.d);
    return Math.max((scaleX + scaleY) * 0.5, EPSILON);
  }
}
