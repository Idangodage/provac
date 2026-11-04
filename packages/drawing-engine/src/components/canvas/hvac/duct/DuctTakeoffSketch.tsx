'use client';

/**
 * A take-off drawn in true proportion, in plan: the main's wall along the foot with its air from the left, the fitting
 * on it. A radius take-off is its real shape (ductRadiusTakeoff), a shoe its real lead-in; every picture is to the same
 * scale, a branch width, so they compare at a glance. Lines take the current colour.
 */
import { shoeLeadInMm } from './ductFittingRules';
import { formatRadiusRatio, radiusTakeoffCollarMm, radiusTakeoffOutline, radiusTakeoffShape } from './ductRadiusTakeoff';
import type { DuctTapStyle } from './ductTypes';

/** Across the main (x), out of it (y), in branch widths. */
type SketchPoint = [number, number];

interface TakeoffSketchShape {
  outline: SketchPoint[];
  /** Where the main's wall is open. */
  mouth: [number, number];
}

const COLLAR = 0.75;

function collarShape(mouthHalf: number, neckHalf: number): TakeoffSketchShape {
  return { outline: [[-mouthHalf, 0], [-neckHalf, -COLLAR], [neckHalf, -COLLAR], [mouthHalf, 0]], mouth: [-mouthHalf, mouthHalf] };
}

function shapeOf(style: DuctTapStyle, widthMm: number, radiusRatio: number | undefined): TakeoffSketchShape {
  if (style === 'radius') {
    const shape = radiusTakeoffShape(widthMm, radiusRatio);
    const outline = radiusTakeoffOutline(shape, radiusTakeoffCollarMm(shape, 100));
    return { outline: outline.map(({ a, b }): SketchPoint => [b / widthMm, -a / widthMm]), mouth: [outline[0]!.b / widthMm, outline[outline.length - 1]!.b / widthMm] };
  }
  if (style === 'shoe-45') {
    const lead = shoeLeadInMm(widthMm) / widthMm;
    return { outline: [[-0.5 - lead, 0], [-0.5, -lead], [-0.5, -lead - COLLAR / 2], [0.5, -lead - COLLAR / 2], [0.5, 0]], mouth: [-0.5 - lead, 0.5] };
  }
  if (style === 'round-lateral') return { outline: [[-1, 0], [-0.4, -0.65], [0.6, -0.65], [0.4, 0]], mouth: [-1, 0.4] };
  if (style === 'conical' || style === 'round-conical') return collarShape(0.72, 0.5);
  return collarShape(0.5, 0.5);
}

const pointsOf = (outline: readonly SketchPoint[]) => outline.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ');

/** Two views of the same scale: a tile's, and the Edit tab's with room for the widest sweep and its figures. */
const VIEWS = { tile: { x: -2.1, y: -1.75, width: 3.3, height: 2.05 }, edit: { x: -2.55, y: -2.05, width: 4.3, height: 2.5 } } as const;
const FOOT = 0.26;

export function DuctTakeoffSketch({ style, widthMm, radiusRatio, view = 'tile', length = (mm) => String(Math.round(mm)), className }: {
  style: DuctTapStyle;
  widthMm: number;
  radiusRatio?: number;
  view?: keyof typeof VIEWS;
  /** A length on the Edit view's figures, in the drawing's units. */
  length?: (mm: number) => string;
  className?: string;
}) {
  const box = VIEWS[view];
  const { outline, mouth } = shapeOf(style, widthMm, radiusRatio);
  const right = box.x + box.width;
  const shape = style === 'radius' ? radiusTakeoffShape(widthMm, radiusRatio) : null;
  const centre: SketchPoint | null = shape ? [shape.centre.b / widthMm, -shape.centre.a / widthMm] : null;
  const round = style === 'spin-in' || style === 'round-tee';
  return (
    <svg viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} preserveAspectRatio="xMidYMid meet" className={className} aria-hidden="true" focusable="false"
      data-takeoff-sketch={style} data-radius-ratio={shape ? shape.ratio : undefined}>
      <rect x={box.x} y={0} width={box.width} height={FOOT} className="fill-slate-200/70" />
      <polygon points={pointsOf(outline)} fill="currentColor" fillOpacity={0.1} stroke="none" />
      <path d={`M${box.x} 0H${mouth[0].toFixed(3)}M${mouth[1].toFixed(3)} 0H${right}`} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      <polyline points={pointsOf(outline)} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      {round ? <path d="M-0.62 -0.14H0.62" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinecap="round" /> : null}
      {view === 'edit' && centre && shape ? (
        <g data-takeoff-figures="">
          <circle cx={centre[0]} cy={centre[1]} r={0.05} fill="currentColor" />
          <path d={`M${centre[0]} ${centre[1]}L${(centre[0] + (shape.throatMm / widthMm) * Math.SQRT1_2).toFixed(3)} ${(centre[1] + (shape.throatMm / widthMm) * Math.SQRT1_2).toFixed(3)}`}
            stroke="currentColor" strokeWidth={1} strokeDasharray="3 2.5" vectorEffect="non-scaling-stroke" />
          <text x={centre[0] - 0.08} y={centre[1] - 0.08} textAnchor="end" fontSize={0.21} fontWeight={600} fill="currentColor">r {length(shape.throatMm)}</text>
          <path d={`M-0.5 ${(-shape.throatMm / widthMm - 0.28).toFixed(3)}H0.5`} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.55} />
          <text x={0} y={-shape.throatMm / widthMm - 0.34} textAnchor="middle" fontSize={0.19} fontWeight={500} fill="currentColor" opacity={0.75}>W {length(widthMm)}</text>
          <text x={right - 0.06} y={-0.08} textAnchor="end" fontSize={0.19} fontWeight={600} fill="currentColor">r/W {formatRadiusRatio(shape.ratio)}</text>
        </g>
      ) : null}
    </svg>
  );
}
