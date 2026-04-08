import type { Point2D } from '../../../types';

import type { LinearDimensionStyle } from './LinearDimension';

const EPSILON = 0.000001;
const JOG_THRESHOLD = 2;
const TICK_LENGTH = 3;
const DEFAULT_HIT_THRESHOLD = 6;

export type OrdinateAxis = 'x' | 'y';

export interface OrdinateDimensionInput {
  id?: string;
  featurePoint: Point2D;
  leaderEndPoint: Point2D;
  datumOrigin: Point2D;
  axis: OrdinateAxis;
  scaleFactor: number;
  unit?: string;
  showUnit?: boolean;
  style?: Partial<LinearDimensionStyle>;
}

export interface OrdinateDimensionGrip {
  id: 'feature' | 'leader-end' | 'datum';
  point: Point2D;
  draggable: true;
}

interface LeaderGeometry {
  points: Point2D[];
  jogPoint: Point2D | null;
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

function randomId(): string {
  return `ord-dim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function formatNumber(value: number): string {
  const rounded2 = Math.round(value * 100) / 100;
  if (Math.abs(rounded2 - Math.round(rounded2)) < 0.000001) {
    return `${Math.round(rounded2)}`;
  }
  return rounded2.toFixed(2).replace(/\.?0+$/, '');
}

export class OrdinateDimension {
  readonly id: string;
  private featurePoint: Point2D;
  private leaderEndPoint: Point2D;
  private datumOrigin: Point2D;
  private axis: OrdinateAxis;
  private scaleFactor: number;
  private unit: string;
  private showUnit: boolean;
  private style: LinearDimensionStyle;

  constructor(input: OrdinateDimensionInput) {
    this.id = input.id ?? randomId();
    this.featurePoint = clonePoint(input.featurePoint);
    this.leaderEndPoint = clonePoint(input.leaderEndPoint);
    this.datumOrigin = clonePoint(input.datumOrigin);
    this.axis = input.axis;
    this.scaleFactor = Number.isFinite(input.scaleFactor) ? input.scaleFactor : 1;
    this.unit = input.unit ?? 'mm';
    this.showUnit = input.showUnit ?? Boolean(input.unit);
    this.style = normalizeStyle(input.style);
  }

  setFeaturePoint(point: Point2D): this {
    this.featurePoint = clonePoint(point);
    return this;
  }

  setLeaderEndPoint(point: Point2D): this {
    this.leaderEndPoint = clonePoint(point);
    return this;
  }

  setDatumOrigin(point: Point2D): this {
    this.datumOrigin = clonePoint(point);
    return this;
  }

  setAxis(axis: OrdinateAxis): this {
    this.axis = axis;
    return this;
  }

  setScaleFactor(scaleFactor: number): this {
    this.scaleFactor = Number.isFinite(scaleFactor) ? scaleFactor : this.scaleFactor;
    return this;
  }

  setUnit(unit: string, showUnit = true): this {
    this.unit = unit;
    this.showUnit = showUnit;
    return this;
  }

  setStyle(style: Partial<LinearDimensionStyle>): this {
    this.style = normalizeStyle({ ...this.style, ...style });
    return this;
  }

  getValue(): number {
    const raw = this.axis === 'x'
      ? (this.featurePoint.x - this.datumOrigin.x) * this.scaleFactor
      : (this.featurePoint.y - this.datumOrigin.y) * this.scaleFactor;
    return Number.isFinite(raw) ? raw : 0;
  }

  getText(): string {
    const base = formatNumber(this.getValue());
    if (this.showUnit) return `${base} ${this.unit}`;
    return base;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const viewScale = this.getContextScale(ctx);
    const pxToWorld = 1 / viewScale;
    const renderLineWidth = Math.max(this.style.lineWidth, 1) * pxToWorld;
    const renderFontSize = Math.max(this.style.fontSize, 12) * pxToWorld;
    const leader = this.getLeaderGeometry(pxToWorld);
    const text = this.getText();

    ctx.save();
    ctx.strokeStyle = this.style.lineColor;
    ctx.fillStyle = this.style.textColor;
    ctx.lineWidth = renderLineWidth;

    ctx.beginPath();
    ctx.moveTo(leader.points[0]!.x, leader.points[0]!.y);
    for (let i = 1; i < leader.points.length; i += 1) {
      const point = leader.points[i]!;
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();

    this.drawFeatureTick(ctx, leader, pxToWorld);
    this.drawText(ctx, text, renderFontSize, pxToWorld);

    ctx.restore();
  }

  hitTest(point: Point2D, threshold = DEFAULT_HIT_THRESHOLD): boolean {
    const leader = this.getLeaderGeometry();
    const hitThreshold = Math.max(0, threshold);
    for (let i = 0; i < leader.points.length - 1; i += 1) {
      const a = leader.points[i]!;
      const b = leader.points[i + 1]!;
      if (distanceToSegment(point, a, b) <= hitThreshold) return true;
    }
    return false;
  }

  move(delta: Point2D, options?: { includeDatum?: boolean }): void {
    this.featurePoint = add(this.featurePoint, delta);
    this.leaderEndPoint = add(this.leaderEndPoint, delta);
    if (options?.includeDatum) {
      this.datumOrigin = add(this.datumOrigin, delta);
    }
  }

  getGrips(): OrdinateDimensionGrip[] {
    return [
      { id: 'feature', point: clonePoint(this.featurePoint), draggable: true },
      { id: 'leader-end', point: clonePoint(this.leaderEndPoint), draggable: true },
      { id: 'datum', point: clonePoint(this.datumOrigin), draggable: true },
    ];
  }

  dragGrip(id: OrdinateDimensionGrip['id'], nextPoint: Point2D): void {
    if (id === 'feature') {
      this.featurePoint = clonePoint(nextPoint);
      return;
    }
    if (id === 'leader-end') {
      this.leaderEndPoint = clonePoint(nextPoint);
      return;
    }
    this.datumOrigin = clonePoint(nextPoint);
  }

  static alignBatch(dimensions: OrdinateDimension[]): void {
    const xDims = dimensions.filter((dim) => dim.axis === 'x');
    const yDims = dimensions.filter((dim) => dim.axis === 'y');

    if (xDims.length > 1) {
      const rightScore = xDims.reduce(
        (score, dim) => score + (dim.leaderEndPoint.x >= dim.featurePoint.x ? 1 : -1),
        0
      );
      const columnX = rightScore >= 0
        ? Math.max(...xDims.map((dim) => dim.leaderEndPoint.x))
        : Math.min(...xDims.map((dim) => dim.leaderEndPoint.x));
      xDims.forEach((dim) => {
        dim.leaderEndPoint = { x: columnX, y: dim.leaderEndPoint.y };
      });
    }

    if (yDims.length > 1) {
      const downScore = yDims.reduce(
        (score, dim) => score + (dim.leaderEndPoint.y >= dim.featurePoint.y ? 1 : -1),
        0
      );
      const columnY = downScore >= 0
        ? Math.max(...yDims.map((dim) => dim.leaderEndPoint.y))
        : Math.min(...yDims.map((dim) => dim.leaderEndPoint.y));
      yDims.forEach((dim) => {
        dim.leaderEndPoint = { x: dim.leaderEndPoint.x, y: columnY };
      });
    }
  }

  private getLeaderGeometry(pxToWorld = 1): LeaderGeometry {
    const jogThreshold = JOG_THRESHOLD * pxToWorld;
    if (this.axis === 'x') {
      const nonPrimaryDelta = this.leaderEndPoint.y - this.featurePoint.y;
      const needJog = Math.abs(nonPrimaryDelta) > jogThreshold;
      if (!needJog) {
        return {
          points: [clonePoint(this.featurePoint), clonePoint(this.leaderEndPoint)],
          jogPoint: null,
        };
      }
      const jogPoint = {
        x: this.leaderEndPoint.x,
        y: this.featurePoint.y,
      };
      return {
        points: [clonePoint(this.featurePoint), jogPoint, clonePoint(this.leaderEndPoint)],
        jogPoint,
      };
    }

    const nonPrimaryDelta = this.leaderEndPoint.x - this.featurePoint.x;
    const needJog = Math.abs(nonPrimaryDelta) > jogThreshold;
    if (!needJog) {
      return {
        points: [clonePoint(this.featurePoint), clonePoint(this.leaderEndPoint)],
        jogPoint: null,
      };
    }

    const jogPoint = {
      x: this.featurePoint.x,
      y: this.leaderEndPoint.y,
    };
    return {
      points: [clonePoint(this.featurePoint), jogPoint, clonePoint(this.leaderEndPoint)],
      jogPoint,
    };
  }

  private drawFeatureTick(ctx: CanvasRenderingContext2D, leader: LeaderGeometry, pxToWorld = 1): void {
    const firstSegment = subtract(leader.points[1]!, leader.points[0]!);
    const fallback = this.axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const primaryDirection = normalize(
      Math.hypot(firstSegment.x, firstSegment.y) < EPSILON ? fallback : firstSegment
    );
    const normal = normalize(perpendicular(primaryDirection));
    const half = TICK_LENGTH * pxToWorld * 0.5;
    const start = add(this.featurePoint, scale(normal, half));
    const end = add(this.featurePoint, scale(normal, -half));

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }

  private drawText(
    ctx: CanvasRenderingContext2D,
    text: string,
    fontSize: number,
    pxToWorld = 1
  ): void {
    ctx.fillStyle = this.style.textColor;
    ctx.font = `${fontSize}px Arial`;
    ctx.textBaseline = 'middle';
    const textOffset = 2 * pxToWorld;

    if (this.axis === 'x') {
      const direction = this.leaderEndPoint.x >= this.featurePoint.x ? 1 : -1;
      ctx.textAlign = direction >= 0 ? 'left' : 'right';
      ctx.fillText(text, this.leaderEndPoint.x + direction * textOffset, this.leaderEndPoint.y);
      return;
    }

    const direction = this.leaderEndPoint.y >= this.featurePoint.y ? 1 : -1;
    ctx.save();
    ctx.translate(this.leaderEndPoint.x, this.leaderEndPoint.y);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = direction >= 0 ? 'left' : 'right';
    ctx.fillText(text, direction * textOffset, 0);
    ctx.restore();
  }

  private getContextScale(ctx: CanvasRenderingContext2D): number {
    const transform = ctx.getTransform();
    const scaleX = Math.hypot(transform.a, transform.b);
    const scaleY = Math.hypot(transform.c, transform.d);
    return Math.max((scaleX + scaleY) * 0.5, EPSILON);
  }
}
