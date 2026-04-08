import type { Point2D } from '../../../types';

export type LinearDimensionOrientation = 'horizontal' | 'vertical' | 'auto';
export type LinearDimensionUnit = 'mm' | 'm';

export interface LinearDimensionStyle {
  lineColor: string;
  textColor: string;
  fontSize: number;
  arrowSize: number;
  lineWidth: number;
}

export interface LinearDimensionInput {
  id?: string;
  startPoint: Point2D;
  endPoint: Point2D;
  offset: number;
  orientation?: LinearDimensionOrientation;
  scaleFactor: number; // real-world mm per pixel
  geometryVertices?: Point2D[];
  style?: Partial<LinearDimensionStyle>;
}

export interface DimensionBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DimensionEntity {
  id: string;
  type: 'linear';
  points: {
    startPoint: Point2D;
    endPoint: Point2D;
    dimensionStart: Point2D;
    dimensionEnd: Point2D;
    extensionAStart: Point2D;
    extensionAEnd: Point2D;
    extensionBStart: Point2D;
    extensionBEnd: Point2D;
    textPosition: Point2D;
  };
  value: number;
  unit: LinearDimensionUnit;
  style: LinearDimensionStyle;
  bbox: DimensionBBox;
}

interface ArrowGeometry {
  tip: Point2D;
  left: Point2D;
  right: Point2D;
}

interface TextBoxGeometry {
  text: string;
  position: Point2D;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DimensionLayout {
  orientation: Exclude<LinearDimensionOrientation, 'auto'>;
  snappedStart: Point2D;
  snappedEnd: Point2D;
  dimensionStart: Point2D;
  dimensionEnd: Point2D;
  extensionAStart: Point2D;
  extensionAEnd: Point2D;
  extensionBStart: Point2D;
  extensionBEnd: Point2D;
  arrowA: ArrowGeometry;
  arrowB: ArrowGeometry;
  text: TextBoxGeometry;
  value: number;
  unit: LinearDimensionUnit;
  bbox: DimensionBBox;
}

interface ComputeLayoutOptions {
  ctx?: CanvasRenderingContext2D;
  pxToWorld?: number;
  fontSize?: number;
  arrowSize?: number;
}

const EXTENSION_GAP_PX = 2;
const EXTENSION_OVERSHOOT_PX = 3;
const SNAP_THRESHOLD_PX = 8;
const TEXT_OFFSET_FROM_LINE_PX = 4;
const TEXT_BG_PADDING_PX = 2;

const DEFAULT_STYLE: LinearDimensionStyle = {
  lineColor: '#111827',
  textColor: '#111827',
  fontSize: 12,
  arrowSize: 8,
  lineWidth: 1,
};

function toFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clonePoint(point: Point2D): Point2D {
  return { x: point.x, y: point.y };
}

function normalize(vector: Point2D): Point2D {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.000001) return { x: 1, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

function perpendicular(vector: Point2D): Point2D {
  return { x: -vector.y, y: vector.x };
}

function distanceSquared(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function estimateTextWidth(label: string, fontSize: number): number {
  return label.length * fontSize * 0.6;
}

function stripTrailingZeros(value: string): string {
  return value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgNum(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function randomId(): string {
  return `dim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStyle(
  base: LinearDimensionStyle,
  override?: Partial<LinearDimensionStyle>
): LinearDimensionStyle {
  return {
    lineColor: override?.lineColor ?? base.lineColor,
    textColor: override?.textColor ?? base.textColor,
    fontSize: Math.max(1, toFinite(override?.fontSize ?? base.fontSize, base.fontSize)),
    arrowSize: Math.max(2, toFinite(override?.arrowSize ?? base.arrowSize, base.arrowSize)),
    lineWidth: Math.max(0.1, toFinite(override?.lineWidth ?? base.lineWidth, base.lineWidth)),
  };
}

export class LinearDimension {
  private id: string;
  private startPoint: Point2D;
  private endPoint: Point2D;
  private offset: number;
  private orientation: LinearDimensionOrientation;
  private scaleFactor: number;
  private geometryVertices: Point2D[];
  private style: LinearDimensionStyle;

  constructor(input: LinearDimensionInput) {
    this.id = input.id ?? randomId();
    this.startPoint = clonePoint(input.startPoint);
    this.endPoint = clonePoint(input.endPoint);
    this.offset = toFinite(input.offset, 0);
    this.orientation = input.orientation ?? 'auto';
    this.scaleFactor = Math.max(0, toFinite(input.scaleFactor, 1));
    this.geometryVertices = [...(input.geometryVertices ?? [])].map(clonePoint);
    this.style = normalizeStyle(DEFAULT_STYLE, input.style);
  }

  setPoints(startPoint: Point2D, endPoint: Point2D): this {
    this.startPoint = clonePoint(startPoint);
    this.endPoint = clonePoint(endPoint);
    return this;
  }

  setOffset(offset: number): this {
    this.offset = toFinite(offset, this.offset);
    return this;
  }

  setOrientation(orientation: LinearDimensionOrientation): this {
    this.orientation = orientation;
    return this;
  }

  setScaleFactor(scaleFactor: number): this {
    this.scaleFactor = Math.max(0, toFinite(scaleFactor, this.scaleFactor));
    return this;
  }

  setGeometryVertices(vertices: Point2D[]): this {
    this.geometryVertices = vertices.map(clonePoint);
    return this;
  }

  setStyle(style: Partial<LinearDimensionStyle>): this {
    this.style = normalizeStyle(this.style, style);
    return this;
  }

  toEntity(): DimensionEntity {
    const layout = this.computeLayout();
    return this.layoutToEntity(layout);
  }

  renderCanvas(ctx: CanvasRenderingContext2D): DimensionEntity {
    const viewScale = this.getContextScale(ctx);
    const pxToWorld = 1 / viewScale;
    const renderLineWidth = Math.max(this.style.lineWidth, 1) * pxToWorld;
    const renderFontSize = Math.max(this.style.fontSize, 12) * pxToWorld;
    const renderArrowSize = Math.max(this.style.arrowSize, 8) * pxToWorld;
    const layout = this.computeLayout({
      ctx,
      pxToWorld,
      fontSize: renderFontSize,
      arrowSize: renderArrowSize,
    });

    ctx.save();
    ctx.strokeStyle = this.style.lineColor;
    ctx.fillStyle = this.style.lineColor;
    ctx.lineWidth = renderLineWidth;

    ctx.beginPath();
    ctx.moveTo(layout.extensionAStart.x, layout.extensionAStart.y);
    ctx.lineTo(layout.extensionAEnd.x, layout.extensionAEnd.y);
    ctx.moveTo(layout.extensionBStart.x, layout.extensionBStart.y);
    ctx.lineTo(layout.extensionBEnd.x, layout.extensionBEnd.y);
    ctx.moveTo(layout.dimensionStart.x, layout.dimensionStart.y);
    ctx.lineTo(layout.dimensionEnd.x, layout.dimensionEnd.y);
    ctx.stroke();

    this.drawArrow(ctx, layout.arrowA);
    this.drawArrow(ctx, layout.arrowB);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(layout.text.x, layout.text.y, layout.text.width, layout.text.height);

    ctx.font = `${renderFontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.style.textColor;
    ctx.fillText(layout.text.text, layout.text.position.x, layout.text.position.y);

    ctx.restore();

    return this.layoutToEntity(this.computeLayout());
  }

  toSvg(): string {
    const layout = this.computeLayout();
    const style = this.style;
    const text = escapeXml(layout.text.text);

    return [
      `<g id="${escapeXml(this.id)}" data-type="linear-dimension">`,
      `<line x1="${svgNum(layout.extensionAStart.x)}" y1="${svgNum(layout.extensionAStart.y)}" x2="${svgNum(layout.extensionAEnd.x)}" y2="${svgNum(layout.extensionAEnd.y)}" stroke="${escapeXml(style.lineColor)}" stroke-width="${svgNum(style.lineWidth)}" />`,
      `<line x1="${svgNum(layout.extensionBStart.x)}" y1="${svgNum(layout.extensionBStart.y)}" x2="${svgNum(layout.extensionBEnd.x)}" y2="${svgNum(layout.extensionBEnd.y)}" stroke="${escapeXml(style.lineColor)}" stroke-width="${svgNum(style.lineWidth)}" />`,
      `<line x1="${svgNum(layout.dimensionStart.x)}" y1="${svgNum(layout.dimensionStart.y)}" x2="${svgNum(layout.dimensionEnd.x)}" y2="${svgNum(layout.dimensionEnd.y)}" stroke="${escapeXml(style.lineColor)}" stroke-width="${svgNum(style.lineWidth)}" />`,
      `<polygon points="${this.toSvgPolygon(layout.arrowA)}" fill="${escapeXml(style.lineColor)}" />`,
      `<polygon points="${this.toSvgPolygon(layout.arrowB)}" fill="${escapeXml(style.lineColor)}" />`,
      `<rect x="${svgNum(layout.text.x)}" y="${svgNum(layout.text.y)}" width="${svgNum(layout.text.width)}" height="${svgNum(layout.text.height)}" fill="#FFFFFF" />`,
      `<text x="${svgNum(layout.text.position.x)}" y="${svgNum(layout.text.position.y)}" text-anchor="middle" dominant-baseline="middle" fill="${escapeXml(style.textColor)}" font-size="${svgNum(style.fontSize)}" font-family="Arial">${text}</text>`,
      `</g>`,
    ].join('');
  }

  renderSvg(): string {
    return this.toSvg();
  }

  private layoutToEntity(layout: DimensionLayout): DimensionEntity {
    return {
      id: this.id,
      type: 'linear',
      points: {
        startPoint: clonePoint(layout.snappedStart),
        endPoint: clonePoint(layout.snappedEnd),
        dimensionStart: clonePoint(layout.dimensionStart),
        dimensionEnd: clonePoint(layout.dimensionEnd),
        extensionAStart: clonePoint(layout.extensionAStart),
        extensionAEnd: clonePoint(layout.extensionAEnd),
        extensionBStart: clonePoint(layout.extensionBStart),
        extensionBEnd: clonePoint(layout.extensionBEnd),
        textPosition: clonePoint(layout.text.position),
      },
      value: layout.value,
      unit: layout.unit,
      style: { ...this.style },
      bbox: { ...layout.bbox },
    };
  }

  private computeLayout(options: ComputeLayoutOptions = {}): DimensionLayout {
    const pxToWorld = options.pxToWorld ?? 1;
    const fontSize = options.fontSize ?? this.style.fontSize;
    const arrowSize = options.arrowSize ?? this.style.arrowSize;
    const extensionGap = EXTENSION_GAP_PX * pxToWorld;
    const extensionOvershoot = EXTENSION_OVERSHOOT_PX * pxToWorld;
    const textOffsetFromLine = TEXT_OFFSET_FROM_LINE_PX * pxToWorld;
    const textBgPadding = TEXT_BG_PADDING_PX * pxToWorld;

    const snappedStart = this.snapPoint(this.startPoint);
    const snappedEnd = this.snapPoint(this.endPoint);

    const orientation = this.resolveOrientation(snappedStart, snappedEnd);
    const normal = this.getNormal(orientation, this.offset);

    let dimensionStart: Point2D;
    let dimensionEnd: Point2D;
    let extensionAStart: Point2D;
    let extensionAEnd: Point2D;
    let extensionBStart: Point2D;
    let extensionBEnd: Point2D;
    let measuredLengthPx: number;

    if (orientation === 'horizontal') {
      const baseY = (snappedStart.y + snappedEnd.y) * 0.5;
      const dimensionY = baseY + this.offset;

      dimensionStart = { x: snappedStart.x, y: dimensionY };
      dimensionEnd = { x: snappedEnd.x, y: dimensionY };

      extensionAStart = { x: snappedStart.x, y: snappedStart.y + normal.y * extensionGap };
      extensionAEnd = { x: snappedStart.x, y: dimensionY + normal.y * extensionOvershoot };
      extensionBStart = { x: snappedEnd.x, y: snappedEnd.y + normal.y * extensionGap };
      extensionBEnd = { x: snappedEnd.x, y: dimensionY + normal.y * extensionOvershoot };

      measuredLengthPx = Math.abs(snappedEnd.x - snappedStart.x);
    } else {
      const baseX = (snappedStart.x + snappedEnd.x) * 0.5;
      const dimensionX = baseX + this.offset;

      dimensionStart = { x: dimensionX, y: snappedStart.y };
      dimensionEnd = { x: dimensionX, y: snappedEnd.y };

      extensionAStart = { x: snappedStart.x + normal.x * extensionGap, y: snappedStart.y };
      extensionAEnd = { x: dimensionX + normal.x * extensionOvershoot, y: snappedStart.y };
      extensionBStart = { x: snappedEnd.x + normal.x * extensionGap, y: snappedEnd.y };
      extensionBEnd = { x: dimensionX + normal.x * extensionOvershoot, y: snappedEnd.y };

      measuredLengthPx = Math.abs(snappedEnd.y - snappedStart.y);
    }

    const measurement = this.formatMeasurement(measuredLengthPx);
    const textMetricsWidth = options.ctx
      ? this.measureTextWidth(options.ctx, measurement.label, fontSize)
      : estimateTextWidth(measurement.label, fontSize);
    const textHeight = fontSize;
    const textBoxHeight = textHeight + textBgPadding * 2;

    const midpoint = {
      x: (dimensionStart.x + dimensionEnd.x) * 0.5,
      y: (dimensionStart.y + dimensionEnd.y) * 0.5,
    };

    const textPosition = {
      x: midpoint.x,
      y: midpoint.y - textOffsetFromLine - textBoxHeight * 0.5,
    };

    const textBox: TextBoxGeometry = {
      text: measurement.label,
      position: textPosition,
      x: textPosition.x - textMetricsWidth * 0.5 - textBgPadding,
      y: textPosition.y - textHeight * 0.5 - textBgPadding,
      width: textMetricsWidth + textBgPadding * 2,
      height: textHeight + textBgPadding * 2,
    };

    const direction = normalize({
      x: dimensionEnd.x - dimensionStart.x,
      y: dimensionEnd.y - dimensionStart.y,
    });
    const arrowA = this.createArrow(dimensionStart, direction, arrowSize);
    const arrowB = this.createArrow(dimensionEnd, { x: -direction.x, y: -direction.y }, arrowSize);

    const bbox = this.buildBBox(
      [
        snappedStart,
        snappedEnd,
        dimensionStart,
        dimensionEnd,
        extensionAStart,
        extensionAEnd,
        extensionBStart,
        extensionBEnd,
        arrowA.tip,
        arrowA.left,
        arrowA.right,
        arrowB.tip,
        arrowB.left,
        arrowB.right,
      ],
      textBox
    );

    return {
      orientation,
      snappedStart,
      snappedEnd,
      dimensionStart,
      dimensionEnd,
      extensionAStart,
      extensionAEnd,
      extensionBStart,
      extensionBEnd,
      arrowA,
      arrowB,
      text: textBox,
      value: measurement.value,
      unit: measurement.unit,
      bbox,
    };
  }

  private measureTextWidth(ctx: CanvasRenderingContext2D, text: string, fontSize: number): number {
    ctx.save();
    ctx.font = `${fontSize}px Arial`;
    const width = ctx.measureText(text).width;
    ctx.restore();
    return width;
  }

  private drawArrow(ctx: CanvasRenderingContext2D, arrow: ArrowGeometry): void {
    ctx.beginPath();
    ctx.moveTo(arrow.tip.x, arrow.tip.y);
    ctx.lineTo(arrow.left.x, arrow.left.y);
    ctx.lineTo(arrow.right.x, arrow.right.y);
    ctx.closePath();
    ctx.fill();
  }

  private toSvgPolygon(arrow: ArrowGeometry): string {
    return [
      `${svgNum(arrow.tip.x)},${svgNum(arrow.tip.y)}`,
      `${svgNum(arrow.left.x)},${svgNum(arrow.left.y)}`,
      `${svgNum(arrow.right.x)},${svgNum(arrow.right.y)}`,
    ].join(' ');
  }

  private buildBBox(points: Point2D[], textBox: TextBoxGeometry): DimensionBBox {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    points.forEach((point) => {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    });

    minX = Math.min(minX, textBox.x);
    minY = Math.min(minY, textBox.y);
    maxX = Math.max(maxX, textBox.x + textBox.width);
    maxY = Math.max(maxY, textBox.y + textBox.height);

    const halfStroke = this.style.lineWidth * 0.5;
    minX -= halfStroke;
    minY -= halfStroke;
    maxX += halfStroke;
    maxY += halfStroke;

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  private createArrow(tip: Point2D, inwardDirection: Point2D, arrowSize: number): ArrowGeometry {
    const length = Math.max(2, arrowSize);
    const width = length * 0.5;
    const normal = perpendicular(inwardDirection);
    const baseCenter = {
      x: tip.x + inwardDirection.x * length,
      y: tip.y + inwardDirection.y * length,
    };

    return {
      tip,
      left: {
        x: baseCenter.x + normal.x * (width * 0.5),
        y: baseCenter.y + normal.y * (width * 0.5),
      },
      right: {
        x: baseCenter.x - normal.x * (width * 0.5),
        y: baseCenter.y - normal.y * (width * 0.5),
      },
    };
  }

  private formatMeasurement(lengthPx: number): { value: number; unit: LinearDimensionUnit; label: string } {
    const mmValue = Math.max(0, lengthPx * this.scaleFactor);
    if (mmValue >= 1000) {
      const meters = Number.parseFloat((mmValue / 1000).toFixed(2));
      const label = `${stripTrailingZeros(meters.toFixed(2))} m`;
      return { value: meters, unit: 'm', label };
    }

    const mmRounded = Math.round(mmValue);
    return { value: mmRounded, unit: 'mm', label: `${mmRounded} mm` };
  }

  private resolveOrientation(start: Point2D, end: Point2D): Exclude<LinearDimensionOrientation, 'auto'> {
    if (this.orientation === 'horizontal' || this.orientation === 'vertical') {
      return this.orientation;
    }

    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    return dx > dy ? 'horizontal' : 'vertical';
  }

  private getNormal(
    orientation: Exclude<LinearDimensionOrientation, 'auto'>,
    offset: number
  ): Point2D {
    const sign = offset >= 0 ? 1 : -1;
    if (orientation === 'horizontal') {
      return { x: 0, y: sign };
    }
    return { x: sign, y: 0 };
  }

  private snapPoint(point: Point2D): Point2D {
    if (this.geometryVertices.length === 0) {
      return clonePoint(point);
    }

    let nearest = point;
    let nearestDistanceSq = SNAP_THRESHOLD_PX * SNAP_THRESHOLD_PX;

    for (const vertex of this.geometryVertices) {
      const d2 = distanceSquared(point, vertex);
      if (d2 <= nearestDistanceSq) {
        nearest = vertex;
        nearestDistanceSq = d2;
      }
    }

    return clonePoint(nearest);
  }

  private getContextScale(ctx: CanvasRenderingContext2D): number {
    const transform = ctx.getTransform();
    const scaleX = Math.hypot(transform.a, transform.b);
    const scaleY = Math.hypot(transform.c, transform.d);
    return Math.max((scaleX + scaleY) * 0.5, 0.000001);
  }
}
