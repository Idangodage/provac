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

/** The box a tee sketch is drawn for (px) and its figures' size there. */
const TEE_BOX = { w: 290, h: 112 } as const;
const TEE_FONT_PX = 10;

/**
 * A radius take-off's tee in true proportion, the main's start on the left: the piece it is made as one with on the main,
 * its sweep and its branch part, its three joints, and its lengths figured: A and B along the main from the branch's
 * centre, C down the branch from the main's side. Lines take the current colour; the main and branch beyond, grey.
 */
export function DuctTeeSketch({ widthMm, mainWidthMm, radiusRatio, beforeMm, afterMm, branchMm, className }: {
  widthMm: number;
  mainWidthMm: number;
  radiusRatio?: number;
  beforeMm: number;
  afterMm: number;
  branchMm: number;
  className?: string;
}) {
  const shape = radiusTakeoffShape(widthMm, radiusRatio);
  const A = beforeMm;
  const B = afterMm;
  const C = branchMm;
  const M = mainWidthMm;
  const half = widthMm / 2;
  const figure = (mm: number) => Math.round(mm).toLocaleString('en-GB');
  const labels = { a: `A ${figure(A)}`, b: `B ${figure(B)}`, c: `C ${figure(C)}` };
  // The view: some main and branch past the joints, room above for A and B and beside the branch for C. Its figures are
  // about 10 px whatever the tee's size, so the view is found with them (a few passes settle it).
  const context = Math.max(120, 0.12 * (A + B));
  let scale = 1;
  let box = { x: 0, y: 0, w: 1, h: 1 };
  for (let pass = 0; pass < 4; pass += 1) {
    const font = TEE_FONT_PX / scale;
    const x0 = -A - context;
    const x1 = Math.max(B + context, half + 1.2 * font + labels.c.length * 0.62 * font);
    const y0 = -M - 1.9 * font;
    const y1 = C + 0.6 * context;
    box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    scale = Math.min(TEE_BOX.w / box.w, TEE_BOX.h / box.h);
  }
  const font = TEE_FONT_PX / scale;
  const gap = 0.5 * font;
  const tick = 0.35 * font;
  const ext = 3 / scale;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const pts = (points: ReadonlyArray<readonly [number, number]>) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  // Its outline: the main piece, then round the sweep from the heel's foot to the throat's toe (its mouth open on the main).
  const sweep = radiusTakeoffOutline(shape, C).map(({ a, b }) => [b, a] as const).reverse();
  const tee = [[-A, -M], [B, -M], [B, 0], ...sweep, [-A, 0]] as const;
  const line = (x1: number, y1: number, x2: number, y2: number) => `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
  const yd = -M - gap;
  const xd = half + gap;
  const halo = { stroke: '#ffffff', strokeWidth: 0.28 * font, paintOrder: 'stroke' as const, strokeLinejoin: 'round' as const };
  return (
    <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="xMidYMid meet" className={className} aria-hidden="true" focusable="false"
      data-tee-sketch={`${Math.round(A)},${Math.round(B)},${Math.round(C)}`}>
      <rect x={box.x} y={-M} width={box.w} height={M} className="fill-slate-100" />
      <rect x={-half} y={C} width={widthMm} height={Math.max(0, bottom - C)} className="fill-slate-100" />
      <path d={[line(box.x, -M, -A, -M), line(B, -M, right, -M), line(box.x, 0, -A, 0), line(B, 0, right, 0), line(-half, C, -half, bottom), line(half, C, half, bottom)].join('')}
        className="stroke-slate-300" strokeWidth={1} vectorEffect="non-scaling-stroke" fill="none" />
      <polygon points={pts(tee)} fill="currentColor" fillOpacity={0.14} stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <path d={[line(-A, -M - ext, -A, ext), line(B, -M - ext, B, ext), line(-half - ext, C, half + ext, C)].join('')}
        stroke="#334155" strokeWidth={2.4} vectorEffect="non-scaling-stroke" strokeLinecap="square" fill="none" />
      <g stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" fill="none">
        <path d={[line(-A, yd, B, yd), line(-A, yd - tick, -A, yd + tick), line(0, yd - tick, 0, yd + tick), line(B, yd - tick, B, yd + tick)].join('')} />
        <path d={[line(xd, 0, xd, C), line(xd - tick, 0, xd + tick, 0), line(xd - tick, C, xd + tick, C)].join('')} />
        <path d={line(0, yd, 0, 0)} strokeDasharray="3 3" opacity={0.6} />
      </g>
      <g fill="currentColor" fontSize={font} fontWeight={600} style={{ fontFamily: 'inherit' }}>
        <text x={-A / 2} y={yd - 0.4 * font} textAnchor="middle" {...halo}>{labels.a}</text>
        <text x={B / 2} y={yd - 0.4 * font} textAnchor="middle" {...halo}>{labels.b}</text>
        <text x={xd + gap} y={C / 2 + 0.35 * font} textAnchor="start" {...halo}>{labels.c}</text>
      </g>
    </svg>
  );
}
