import type { Point2D } from '../../../types';

const DEFAULT_SNAP_THRESHOLD = 8;
const EPSILON = 0.000001;

export interface AlignedDimensionStyle {
  lineColor: string;
  textColor: string;
  lineWidth: number;
  fontSize: number;
  arrowSize: number;
  textPadding: number;
  backgroundColor: string;
}

export interface SnapEdge {
  start: Point2D;
  end: Point2D;
}

export interface AlignedDimensionSnapTargets {
  vertices?: Point2D[];
  edges?: SnapEdge[];
}

export interface AlignedDimensionInput {
  id?: string;
  startPoint: Point2D;
  endPoint: Point2D;
  offsetDistance: number;
  scaleFactor: number;
  snapTargets?: AlignedDimensionSnapTargets;
  snapThreshold?: number;
  style?: Partial<AlignedDimensionStyle>;
}

export interface AlignedDimensionGrip {
  id: 'geometry-start' | 'geometry-end' | 'dimension-start' | 'dimension-end';
  point: Point2D;
  draggable: true;
}

export interface AlignedDimensionRendererApi {
  draw(ctx: CanvasRenderingContext2D): void;
  hitTest(point: Point2D, threshold?: number): boolean;
  move(delta: Point2D): void;
  getGrips(): AlignedDimensionGrip[];
}

interface AlignedDimensionGeometry {
  start: Point2D;
  end: Point2D;
  dimensionStart: Point2D;
  dimensionEnd: Point2D;
  textPosition: Point2D;
  label: string;
  textRotation: number;
}

interface ComputeGeometryOptions {
  pxToWorld?: number;
  fontSize?: number;
}

const DEFAULT_STYLE: AlignedDimensionStyle = {
  lineColor: '#111827',
  textColor: '#111827',
  lineWidth: 1,
  fontSize: 12,
  arrowSize: 8,
  textPadding: 2,
  backgroundColor: '#FFFFFF',
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

function length(vector: Point2D): number {
  return Math.hypot(vector.x, vector.y);
}

function normalize(vector: Point2D): Point2D {
  const len = length(vector);
  if (len < EPSILON) return { x: 1, y: 0 };
  return { x: vector.x / len, y: vector.y / len };
}

function perpendicularLeft(vector: Point2D): Point2D {
  return { x: -vector.y, y: vector.x };
}

function distanceSquared(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function distanceToSegment(point: Point2D, start: Point2D, end: Point2D): number {
  const segment = subtract(end, start);
  const segmentLenSq = dot(segment, segment);
  if (segmentLenSq < EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);

  const projectionRatio = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / segmentLenSq));
  const projection = add(start, scale(segment, projectionRatio));
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

function projectPointOnSegment(point: Point2D, start: Point2D, end: Point2D): Point2D {
  const segment = subtract(end, start);
  const segmentLenSq = dot(segment, segment);
  if (segmentLenSq < EPSILON) return clonePoint(start);
  const projectionRatio = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / segmentLenSq));
  return add(start, scale(segment, projectionRatio));
}

function normalizeStyle(style?: Partial<AlignedDimensionStyle>): AlignedDimensionStyle {
  return {
    lineColor: style?.lineColor ?? DEFAULT_STYLE.lineColor,
    textColor: style?.textColor ?? DEFAULT_STYLE.textColor,
    lineWidth: Math.max(0.1, style?.lineWidth ?? DEFAULT_STYLE.lineWidth),
    fontSize: Math.max(1, style?.fontSize ?? DEFAULT_STYLE.fontSize),
    arrowSize: Math.max(2, style?.arrowSize ?? DEFAULT_STYLE.arrowSize),
    textPadding: Math.max(0, style?.textPadding ?? DEFAULT_STYLE.textPadding),
    backgroundColor: style?.backgroundColor ?? DEFAULT_STYLE.backgroundColor,
  };
}

function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}

function stripTrailingZeros(value: string): string {
  return value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function toReadableTextRotation(angleRad: number): number {
  const angleDeg = (angleRad * 180) / Math.PI;
  if (angleDeg > 90 || angleDeg < -90) {
    return angleRad + Math.PI;
  }
  return angleRad;
}

function randomId(): string {
  return `aligned-dim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class AlignedDimension implements AlignedDimensionRendererApi {
  readonly id: string;
  private startPoint: Point2D;
  private endPoint: Point2D;
  private offsetDistance: number;
  private scaleFactor: number;
  private snapTargets: AlignedDimensionSnapTargets;
  private snapThreshold: number;
  private style: AlignedDimensionStyle;

  constructor(input: AlignedDimensionInput) {
    this.id = input.id ?? randomId();
    this.startPoint = clonePoint(input.startPoint);
    this.endPoint = clonePoint(input.endPoint);
    this.offsetDistance = input.offsetDistance;
    this.scaleFactor = Math.max(0, input.scaleFactor);
    this.snapTargets = {
      vertices: [...(input.snapTargets?.vertices ?? [])].map(clonePoint),
      edges: [...(input.snapTargets?.edges ?? [])].map((edge) => ({
        start: clonePoint(edge.start),
        end: clonePoint(edge.end),
      })),
    };
    this.snapThreshold = Math.max(0, input.snapThreshold ?? DEFAULT_SNAP_THRESHOLD);
    this.style = normalizeStyle(input.style);
  }

  setPoints(startPoint: Point2D, endPoint: Point2D): this {
    this.startPoint = clonePoint(startPoint);
    this.endPoint = clonePoint(endPoint);
    return this;
  }

  setOffsetDistance(offsetDistance: number): this {
    this.offsetDistance = offsetDistance;
    return this;
  }

  setScaleFactor(scaleFactor: number): this {
    this.scaleFactor = Math.max(0, scaleFactor);
    return this;
  }

  setSnapTargets(snapTargets: AlignedDimensionSnapTargets): this {
    this.snapTargets = {
      vertices: [...(snapTargets.vertices ?? [])].map(clonePoint),
      edges: [...(snapTargets.edges ?? [])].map((edge) => ({
        start: clonePoint(edge.start),
        end: clonePoint(edge.end),
      })),
    };
    return this;
  }

  setStyle(style: Partial<AlignedDimensionStyle>): this {
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
      pxToWorld,
      fontSize: renderFontSize,
    });
    const direction = subtract(geometry.dimensionEnd, geometry.dimensionStart);
    const directionUnit = normalize(direction);

    ctx.save();
    ctx.strokeStyle = this.style.lineColor;
    ctx.fillStyle = this.style.lineColor;
    ctx.lineWidth = renderLineWidth;

    // Extension lines: geometry -> dimension line (perpendicular to dimension line)
    ctx.beginPath();
    ctx.moveTo(geometry.start.x, geometry.start.y);
    ctx.lineTo(geometry.dimensionStart.x, geometry.dimensionStart.y);
    ctx.moveTo(geometry.end.x, geometry.end.y);
    ctx.lineTo(geometry.dimensionEnd.x, geometry.dimensionEnd.y);
    ctx.moveTo(geometry.dimensionStart.x, geometry.dimensionStart.y);
    ctx.lineTo(geometry.dimensionEnd.x, geometry.dimensionEnd.y);
    ctx.stroke();

    this.drawArrow(ctx, geometry.dimensionStart, directionUnit, renderArrowSize);
    this.drawArrow(ctx, geometry.dimensionEnd, scale(directionUnit, -1), renderArrowSize);

    const textWidth = this.measureTextWidth(ctx, geometry.label, renderFontSize);
    const textHeight = renderFontSize;
    const textPadding = this.style.textPadding * pxToWorld;
    const textBoxWidth = textWidth + textPadding * 2;
    const textBoxHeight = textHeight + textPadding * 2;

    ctx.translate(geometry.textPosition.x, geometry.textPosition.y);
    ctx.rotate(geometry.textRotation);

    ctx.fillStyle = this.style.backgroundColor;
    ctx.fillRect(-textBoxWidth * 0.5, -textBoxHeight * 0.5, textBoxWidth, textBoxHeight);

    ctx.fillStyle = this.style.textColor;
    ctx.font = `${renderFontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(geometry.label, 0, 0);

    ctx.restore();
  }

  hitTest(point: Point2D, threshold = DEFAULT_SNAP_THRESHOLD): boolean {
    const geometry = this.computeGeometry();
    const hitThreshold = Math.max(0, threshold);

    if (distanceToSegment(point, geometry.start, geometry.dimensionStart) <= hitThreshold) return true;
    if (distanceToSegment(point, geometry.end, geometry.dimensionEnd) <= hitThreshold) return true;
    if (distanceToSegment(point, geometry.dimensionStart, geometry.dimensionEnd) <= hitThreshold) return true;

    const textWidth = estimateTextWidth(geometry.label, this.style.fontSize) + this.style.textPadding * 2;
    const textHeight = this.style.fontSize + this.style.textPadding * 2;
    return this.isPointInRotatedRect(
      point,
      geometry.textPosition,
      textWidth + hitThreshold * 2,
      textHeight + hitThreshold * 2,
      geometry.textRotation
    );
  }

  move(delta: Point2D): void {
    this.startPoint = add(this.startPoint, delta);
    this.endPoint = add(this.endPoint, delta);
  }

  getGrips(): AlignedDimensionGrip[] {
    const geometry = this.computeGeometry();
    return [
      { id: 'geometry-start', point: clonePoint(geometry.start), draggable: true },
      { id: 'geometry-end', point: clonePoint(geometry.end), draggable: true },
      { id: 'dimension-start', point: clonePoint(geometry.dimensionStart), draggable: true },
      { id: 'dimension-end', point: clonePoint(geometry.dimensionEnd), draggable: true },
    ];
  }

  private computeGeometry(options: ComputeGeometryOptions = {}): AlignedDimensionGeometry {
    const pxToWorld = options.pxToWorld ?? 1;
    const fontSize = options.fontSize ?? this.style.fontSize;
    const snappedStart = this.snapPoint(this.startPoint);
    const snappedEnd = this.snapPoint(this.endPoint);
    const measuredVector = subtract(snappedEnd, snappedStart);
    const measuredLength = Math.max(length(measuredVector), EPSILON);
    const directionUnit = scale(measuredVector, 1 / measuredLength);

    // Required by spec: angle based on raw line vector.
    const angle = Math.atan2(measuredVector.y, measuredVector.x);
    const textRotation = toReadableTextRotation(angle);

    // Perpendicular left unit vector; offset sign handles left/right.
    const perpendicularUnit = perpendicularLeft(directionUnit);
    const offsetVector = scale(perpendicularUnit, this.offsetDistance);

    const dimensionStart = add(snappedStart, offsetVector);
    const dimensionEnd = add(snappedEnd, offsetVector);

    const midpoint = {
      x: (dimensionStart.x + dimensionEnd.x) * 0.5,
      y: (dimensionStart.y + dimensionEnd.y) * 0.5,
    };
    const textSide = this.offsetDistance >= 0 ? 1 : -1;
    const textOffset = scale(perpendicularUnit, textSide * (fontSize * 0.6 + 4 * pxToWorld));
    const textPosition = add(midpoint, textOffset);

    const value = Math.hypot(measuredVector.x, measuredVector.y) * this.scaleFactor;
    const label = this.formatValue(value);

    return {
      start: snappedStart,
      end: snappedEnd,
      dimensionStart,
      dimensionEnd,
      textPosition,
      label,
      textRotation,
    };
  }

  private formatValue(value: number): string {
    const safeValue = Math.max(0, value);
    if (safeValue >= 1000) {
      const meters = safeValue / 1000;
      return `${stripTrailingZeros(meters.toFixed(2))} m`;
    }
    return `${Math.round(safeValue)} mm`;
  }

  private drawArrow(
    ctx: CanvasRenderingContext2D,
    tip: Point2D,
    inwardDirection: Point2D,
    arrowSize: number
  ): void {
    const directionUnit = normalize(inwardDirection);
    const normal = perpendicularLeft(directionUnit);
    const arrowLength = arrowSize;
    const arrowWidth = arrowSize * 0.5;
    const baseCenter = add(tip, scale(directionUnit, arrowLength));
    const left = add(baseCenter, scale(normal, arrowWidth * 0.5));
    const right = add(baseCenter, scale(normal, -arrowWidth * 0.5));

    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fill();
  }

  private measureTextWidth(ctx: CanvasRenderingContext2D, text: string, fontSize: number): number {
    ctx.save();
    ctx.font = `${fontSize}px Arial`;
    const width = ctx.measureText(text).width;
    ctx.restore();
    return width;
  }

  private isPointInRotatedRect(
    point: Point2D,
    center: Point2D,
    width: number,
    height: number,
    rotation: number
  ): boolean {
    const local = subtract(point, center);
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const x = local.x * cos - local.y * sin;
    const y = local.x * sin + local.y * cos;
    return Math.abs(x) <= width * 0.5 && Math.abs(y) <= height * 0.5;
  }

  private snapPoint(point: Point2D): Point2D {
    const thresholdSq = this.snapThreshold * this.snapThreshold;
    const endpoints: Point2D[] = [];
    const midpoints: Point2D[] = [];
    const edges = this.snapTargets.edges ?? [];

    endpoints.push(...(this.snapTargets.vertices ?? []));
    edges.forEach((edge) => {
      endpoints.push(edge.start, edge.end);
      midpoints.push({
        x: (edge.start.x + edge.end.x) * 0.5,
        y: (edge.start.y + edge.end.y) * 0.5,
      });
    });

    const endpointHit = this.findNearestPoint(point, endpoints, thresholdSq);
    if (endpointHit) return endpointHit;

    const midpointHit = this.findNearestPoint(point, midpoints, thresholdSq);
    if (midpointHit) return midpointHit;

    let nearestOnEdge: Point2D | null = null;
    let nearestDistanceSq = thresholdSq;
    for (const edge of edges) {
      const projected = projectPointOnSegment(point, edge.start, edge.end);
      const d2 = distanceSquared(point, projected);
      if (d2 <= nearestDistanceSq) {
        nearestDistanceSq = d2;
        nearestOnEdge = projected;
      }
    }
    return nearestOnEdge ?? clonePoint(point);
  }

  private findNearestPoint(point: Point2D, candidates: Point2D[], maxDistanceSq: number): Point2D | null {
    let nearest: Point2D | null = null;
    let nearestDistanceSq = maxDistanceSq;
    for (const candidate of candidates) {
      const d2 = distanceSquared(point, candidate);
      if (d2 <= nearestDistanceSq) {
        nearestDistanceSq = d2;
        nearest = candidate;
      }
    }
    return nearest ? clonePoint(nearest) : null;
  }

  private getContextScale(ctx: CanvasRenderingContext2D): number {
    const transform = ctx.getTransform();
    const scaleX = Math.hypot(transform.a, transform.b);
    const scaleY = Math.hypot(transform.c, transform.d);
    return Math.max((scaleX + scaleY) * 0.5, EPSILON);
  }
}
