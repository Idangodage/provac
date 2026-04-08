import type { Point2D } from '../../../types';

import type { LinearDimensionStyle } from './LinearDimension';

const EPSILON = 0.000001;
const TEXT_GAP = 4;
const TEXT_STAGGER_OFFSET = 10;
const EXTENSION_GAP = 2;
const EXTENSION_OVERSHOOT = 3;
const TOTAL_BASELINE_EXTRA = 30;
const DEFAULT_HIT_THRESHOLD = 6;

export type ContinuousDimensionOrientation = 'horizontal' | 'vertical';

export interface ContinuousDimensionInput {
  id?: string;
  points: Point2D[];
  offset: number;
  orientation: ContinuousDimensionOrientation;
  showTotal?: boolean;
  style?: Partial<LinearDimensionStyle>;
}

export interface ContinuousDimensionSerialized {
  type: 'continuous';
  points: Point2D[];
  offset: number;
  orientation: ContinuousDimensionOrientation;
  showTotal: boolean;
  style: LinearDimensionStyle;
}

interface SegmentGeometry {
  start: Point2D;
  end: Point2D;
  label: string;
  textPosition: Point2D;
  textBBox: { x: number; y: number; width: number; height: number };
}

interface ChainGeometry {
  sortedPoints: Point2D[];
  dimensionPoints: Point2D[];
  extensionLines: { start: Point2D; end: Point2D }[];
  segments: SegmentGeometry[];
  total: SegmentGeometry | null;
}

const DEFAULT_STYLE: LinearDimensionStyle = {
  lineColor: '#111827',
  textColor: '#111827',
  fontSize: 1200,
  arrowSize: 800,
  lineWidth: 1000,
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
  const len = Math.hypot(vector.x, vector.y);
  if (len < EPSILON) return { x: 1, y: 0 };
  return { x: vector.x / len, y: vector.y / len };
}

function perpendicular(vector: Point2D): Point2D {
  return { x: -vector.y, y: vector.x };
}

function distanceToSegment(point: Point2D, start: Point2D, end: Point2D): number {
  const segment = subtract(end, start);
  const segmentLenSq = dot(segment, segment);
  if (segmentLenSq < EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, dot(subtract(point, start), segment) / segmentLenSq));
  const projection = add(start, scale(segment, t));
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}

function formatMeasurement(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const nearestInt = Math.round(rounded);
  if (Math.abs(rounded - nearestInt) < 0.000001) return `${nearestInt}`;
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

function bboxesIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
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
  return `cont-dim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class ContinuousDimension {
  readonly id: string;
  private points: Point2D[];
  private offset: number;
  private orientation: ContinuousDimensionOrientation;
  private showTotal: boolean;
  private style: LinearDimensionStyle;

  constructor(input: ContinuousDimensionInput) {
    this.id = input.id ?? randomId();
    this.points = input.points.map(clonePoint);
    this.offset = input.offset;
    this.orientation = input.orientation;
    this.showTotal = input.showTotal ?? false;
    this.style = normalizeStyle(input.style);
    this.sortPointsInPlace();
  }

  setPoints(points: Point2D[]): this {
    this.points = points.map(clonePoint);
    this.sortPointsInPlace();
    return this;
  }

  setOffset(offset: number): this {
    this.offset = offset;
    return this;
  }

  setOrientation(orientation: ContinuousDimensionOrientation): this {
    this.orientation = orientation;
    this.sortPointsInPlace();
    return this;
  }

  setShowTotal(showTotal: boolean): this {
    this.showTotal = showTotal;
    return this;
  }

  setStyle(style: Partial<LinearDimensionStyle>): this {
    this.style = normalizeStyle({ ...this.style, ...style });
    return this;
  }

  insertPoint(index: number, point: Point2D): this {
    const targetIndex = Math.max(0, Math.min(this.points.length, index));
    this.points.splice(targetIndex, 0, clonePoint(point));
    this.sortPointsInPlace();
    return this;
  }

  removePoint(index: number): this {
    if (index < 0 || index >= this.points.length) return this;
    this.points.splice(index, 1);
    this.sortPointsInPlace();
    return this;
  }

  movePoint(index: number, delta: Point2D): this {
    if (index < 0 || index >= this.points.length) return this;
    this.points[index] = add(this.points[index]!, delta);
    this.sortPointsInPlace();
    return this;
  }

  setPoint(index: number, point: Point2D): this {
    if (index < 0 || index >= this.points.length) return this;
    this.points[index] = clonePoint(point);
    this.sortPointsInPlace();
    return this;
  }

  move(delta: Point2D): this {
    this.points = this.points.map((point) => add(point, delta));
    return this;
  }

  serialize(): ContinuousDimensionSerialized {
    this.sortPointsInPlace();
    return {
      type: 'continuous',
      points: this.points.map(clonePoint),
      offset: this.offset,
      orientation: this.orientation,
      showTotal: this.showTotal,
      style: { ...this.style },
    };
  }

  hitTest(point: Point2D, threshold = DEFAULT_HIT_THRESHOLD): boolean {
    const geometry = this.computeGeometry();
    const hitThreshold = Math.max(0, threshold);

    for (const extension of geometry.extensionLines) {
      if (distanceToSegment(point, extension.start, extension.end) <= hitThreshold) return true;
    }

    for (const segment of geometry.segments) {
      if (distanceToSegment(point, segment.start, segment.end) <= hitThreshold) return true;
    }

    if (geometry.total) {
      if (distanceToSegment(point, geometry.total.start, geometry.total.end) <= hitThreshold) return true;
    }

    return false;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const viewScale = this.getContextScale(ctx);
    const renderLineWidth = Math.max(this.style.lineWidth, 1) / viewScale;
    const renderFontSize = Math.max(this.style.fontSize, 12) / viewScale;
    const renderArrowSize = Math.max(this.style.arrowSize, 8) / viewScale;
    const geometry = this.computeGeometry(ctx, viewScale);
    if (geometry.sortedPoints.length < 2) return;

    ctx.save();
    ctx.strokeStyle = this.style.lineColor;
    ctx.fillStyle = this.style.lineColor;
    ctx.lineWidth = renderLineWidth;

    // Shared extension lines: each chain point contributes one extension.
    ctx.beginPath();
    for (const extension of geometry.extensionLines) {
      ctx.moveTo(extension.start.x, extension.start.y);
      ctx.lineTo(extension.end.x, extension.end.y);
    }
    ctx.stroke();

    // Segment dimension lines and arrowheads.
    for (const segment of geometry.segments) {
      ctx.beginPath();
      ctx.moveTo(segment.start.x, segment.start.y);
      ctx.lineTo(segment.end.x, segment.end.y);
      ctx.stroke();

      const direction = normalize(subtract(segment.end, segment.start));
      this.drawArrow(ctx, segment.start, direction, renderArrowSize);
      this.drawArrow(ctx, segment.end, scale(direction, -1), renderArrowSize);
    }

    if (geometry.total) {
      ctx.beginPath();
      ctx.moveTo(geometry.total.start.x, geometry.total.start.y);
      ctx.lineTo(geometry.total.end.x, geometry.total.end.y);
      ctx.stroke();

      const totalDirection = normalize(subtract(geometry.total.end, geometry.total.start));
      this.drawArrow(ctx, geometry.total.start, totalDirection, renderArrowSize);
      this.drawArrow(ctx, geometry.total.end, scale(totalDirection, -1), renderArrowSize);
    }

    // Segment labels.
    ctx.fillStyle = this.style.textColor;
    ctx.font = `${renderFontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const segment of geometry.segments) {
      ctx.fillText(segment.label, segment.textPosition.x, segment.textPosition.y);
    }
    if (geometry.total) {
      ctx.fillText(geometry.total.label, geometry.total.textPosition.x, geometry.total.textPosition.y);
    }

    ctx.restore();
  }

  private drawArrow(
    ctx: CanvasRenderingContext2D,
    tip: Point2D,
    inwardDirection: Point2D,
    arrowSize: number
  ): void {
    const direction = normalize(inwardDirection);
    const normal = perpendicular(direction);
    const length = arrowSize;
    const width = arrowSize * 0.5;
    const baseCenter = add(tip, scale(direction, length));
    const left = add(baseCenter, scale(normal, width * 0.5));
    const right = add(baseCenter, scale(normal, -width * 0.5));

    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fill();
  }

  private computeGeometry(ctx?: CanvasRenderingContext2D, viewScale = 1): ChainGeometry {
    const sortedPoints = this.getSortedPoints();
    if (sortedPoints.length < 2) {
      return {
        sortedPoints,
        dimensionPoints: sortedPoints,
        extensionLines: [],
        segments: [],
        total: null,
      };
    }

    const baseRef = this.orientation === 'horizontal'
      ? sortedPoints.reduce((sum, point) => sum + point.y, 0) / sortedPoints.length
      : sortedPoints.reduce((sum, point) => sum + point.x, 0) / sortedPoints.length;

    const dimCoord = baseRef + this.offset;
    const normalSign = this.offset >= 0 ? 1 : -1;

    const pxToWorld = 1 / Math.max(viewScale, EPSILON);
    const extensionGap = EXTENSION_GAP * pxToWorld;
    const extensionOvershoot = EXTENSION_OVERSHOOT * pxToWorld;
    const baselineExtra = TOTAL_BASELINE_EXTRA * pxToWorld;

    const dimensionPoints = sortedPoints.map((point) => (
      this.orientation === 'horizontal'
        ? { x: point.x, y: dimCoord }
        : { x: dimCoord, y: point.y }
    ));

    const extensionLines = sortedPoints.map((point, index) => {
      const dimPoint = dimensionPoints[index]!;
      if (this.orientation === 'horizontal') {
        return {
          start: { x: point.x, y: point.y + normalSign * extensionGap },
          end: { x: dimPoint.x, y: dimPoint.y + normalSign * extensionOvershoot },
        };
      }
      return {
        start: { x: point.x + normalSign * extensionGap, y: point.y },
        end: { x: dimPoint.x + normalSign * extensionOvershoot, y: dimPoint.y },
      };
    });

    const segments: SegmentGeometry[] = [];
    for (let i = 0; i < dimensionPoints.length - 1; i += 1) {
      const start = dimensionPoints[i]!;
      const end = dimensionPoints[i + 1]!;
      const measured = this.orientation === 'horizontal'
        ? Math.abs(end.x - start.x)
        : Math.abs(end.y - start.y);
      const label = formatMeasurement(measured);
      const center = { x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5 };
      const textPosition = this.baseTextPosition(center, false, false, viewScale);
      const textBBox = this.computeTextBBox(textPosition, label, ctx, viewScale);
      segments.push({ start, end, label, textPosition, textBBox });
    }

    this.applyOverlapStaggering(segments, ctx, viewScale);

    let total: SegmentGeometry | null = null;
    if (this.showTotal) {
      const totalOffset = this.offset + baselineExtra;
      const totalCoord = baseRef + totalOffset;
      const startGeom = sortedPoints[0]!;
      const endGeom = sortedPoints[sortedPoints.length - 1]!;
      const start = this.orientation === 'horizontal'
        ? { x: startGeom.x, y: totalCoord }
        : { x: totalCoord, y: startGeom.y };
      const end = this.orientation === 'horizontal'
        ? { x: endGeom.x, y: totalCoord }
        : { x: totalCoord, y: endGeom.y };
      const measured = this.orientation === 'horizontal'
        ? Math.abs(end.x - start.x)
        : Math.abs(end.y - start.y);
      const label = formatMeasurement(measured);
      const center = { x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5 };
      const textPosition = this.baseTextPosition(center, true, totalOffset >= 0, viewScale);
      total = {
        start,
        end,
        label,
        textPosition,
        textBBox: this.computeTextBBox(textPosition, label, ctx, viewScale),
      };
    }

    return {
      sortedPoints,
      dimensionPoints,
      extensionLines,
      segments,
      total,
    };
  }

  private baseTextPosition(
    center: Point2D,
    forTotal: boolean,
    offsetPositiveHint: boolean,
    viewScale: number
  ): Point2D {
    const pxToWorld = 1 / Math.max(viewScale, EPSILON);
    const renderFontSize = this.style.fontSize * pxToWorld;
    const baseGap = renderFontSize * 0.5 + TEXT_GAP * pxToWorld;
    const outwardSign = forTotal ? (offsetPositiveHint ? 1 : -1) : -1;
    if (this.orientation === 'horizontal') {
      return { x: center.x, y: center.y + outwardSign * baseGap };
    }
    return { x: center.x + outwardSign * baseGap, y: center.y };
  }

  private computeTextBBox(
    textPosition: Point2D,
    label: string,
    ctx?: CanvasRenderingContext2D,
    viewScale = 1
  ): { x: number; y: number; width: number; height: number } {
    const renderFontSize = this.style.fontSize / Math.max(viewScale, EPSILON);
    const width = ctx
      ? this.measureTextWidth(ctx, label, renderFontSize)
      : estimateTextWidth(label, renderFontSize);
    const height = renderFontSize;
    return {
      x: textPosition.x - width * 0.5,
      y: textPosition.y - height * 0.5,
      width,
      height,
    };
  }

  private measureTextWidth(ctx: CanvasRenderingContext2D, text: string, fontSize: number): number {
    ctx.save();
    ctx.font = `${fontSize}px Arial`;
    const width = ctx.measureText(text).width;
    ctx.restore();
    return width;
  }

  private applyOverlapStaggering(
    segments: SegmentGeometry[],
    ctx?: CanvasRenderingContext2D,
    viewScale = 1
  ): void {
    if (segments.length < 2) return;

    const pxToWorld = 1 / Math.max(viewScale, EPSILON);
    const renderFontSize = this.style.fontSize * pxToWorld;
    const textGap = TEXT_GAP * pxToWorld;
    const stagger = TEXT_STAGGER_OFFSET * pxToWorld;

    let previousSign = -1;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!;
      const overlapWithPrev = i > 0 && bboxesIntersect(segment.textBBox, segments[i - 1]!.textBBox);
      const sign = overlapWithPrev ? -previousSign : -1;
      previousSign = sign;

      const center = { x: (segment.start.x + segment.end.x) * 0.5, y: (segment.start.y + segment.end.y) * 0.5 };
      if (this.orientation === 'horizontal') {
        segment.textPosition = {
          x: center.x,
          y: center.y + sign * (renderFontSize * 0.5 + textGap + (sign > 0 ? stagger : 0)),
        };
      } else {
        segment.textPosition = {
          x: center.x + sign * (renderFontSize * 0.5 + textGap + (sign > 0 ? stagger : 0)),
          y: center.y,
        };
      }
      segment.textBBox = this.computeTextBBox(segment.textPosition, segment.label, ctx, viewScale);
    }
  }

  private getContextScale(ctx: CanvasRenderingContext2D): number {
    const transform = ctx.getTransform();
    const scaleX = Math.hypot(transform.a, transform.b);
    const scaleY = Math.hypot(transform.c, transform.d);
    const scale = (scaleX + scaleY) * 0.5;
    return Math.max(scale, EPSILON);
  }

  private getSortedPoints(): Point2D[] {
    const sorted = this.points.map(clonePoint);
    const primaryKey = this.orientation === 'horizontal' ? 'x' : 'y';
    const secondaryKey = this.orientation === 'horizontal' ? 'y' : 'x';

    sorted.sort((a, b) => {
      const primary = a[primaryKey] - b[primaryKey];
      if (Math.abs(primary) > EPSILON) return primary;
      return a[secondaryKey] - b[secondaryKey];
    });
    return sorted;
  }

  private sortPointsInPlace(): void {
    this.points = this.getSortedPoints();
  }
}
