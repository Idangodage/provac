'use client';

/**
 * Plan painter for condensate drainage (SVG, model millimetres).
 *
 * Draws committed condensate pipes as scaled insulated uPVC tubes with flow
 * arrows, fall tags ("CD 32 · 1:100 →"), invert-level tags, riser/drop
 * symbols and fitting glyphs — and, while a generation preview is open, the
 * proposed network coloured by head margin with a status chip at every unit.
 *
 * The layer never takes pointer events: condensate pipes are picked
 * geometrically by the plan renderer, so select / Delete work like any other
 * element. It shares the same-frame viewport bond as the pipe studio overlay.
 */
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';

import type { HvacElement, Point2D } from '../../../../types';
import {
  affineMatrixToSvg,
  canvasTransformToSvgMatrix,
  fabricViewportToWorldSvgMatrix,
  getCanvasTransform,
  type FabricViewportMatrix,
} from '../../coordinateTransform';
import { MM_TO_PX } from '../../scale';

import {
  buildCondensatePlanPresentation,
  condensateFlowArrows,
  headMarginColor,
  type CondensatePlanPresentation,
} from './condensatePlanPresentation';
import { useCondensatePreviewStore } from './condensatePreviewStore';
import type { CondensateDesignSettings } from './condensateSettings';
import { layoutCondensateSupports } from './condensateSupports';
import { isCondensateGully, isCondensatePipe, readCondensateGullySpec, type CondensateFitting } from './condensateTypes';

export interface CondensateOverlayHandle {
  syncViewTransform: (viewport: readonly number[]) => void;
}

export interface CondensateOverlayProps {
  enabled: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: HvacElement[];
  selectedIds: string[];
  settings: CondensateDesignSettings;
}

const TUBE = {
  edge: '#0c4a6e',
  insulation: '#7dd3fc',
  sheen: '#e0f2fe',
  selected: '#0ea5e9',
  text: '#0c4a6e',
  tagFill: '#f0f9ff',
  tagStroke: '#7dd3fc',
};

/** A fall tag is drawn on runs at least this long on screen. */
const FALL_TAG_MIN_SCREEN_PX = 90;

function pathData(points: readonly Point2D[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ');
}

function Tag({ x, y, text, hpx, angle = 0, tone = 'info' }: {
  x: number; y: number; text: string; hpx: (n: number) => number; angle?: number; tone?: 'info' | 'ok' | 'warn' | 'bad' | 'pump';
}) {
  const palette = {
    info: { fill: TUBE.tagFill, stroke: TUBE.tagStroke, text: TUBE.text },
    ok: { fill: '#f0fdf4', stroke: '#86efac', text: '#166534' },
    warn: { fill: '#fefce8', stroke: '#fde047', text: '#854d0e' },
    bad: { fill: '#fef2f2', stroke: '#fca5a5', text: '#991b1b' },
    pump: { fill: '#eef2ff', stroke: '#a5b4fc', text: '#3730a3' },
  }[tone];
  const width = hpx(text.length * 5.9 + 12);
  const height = hpx(17);
  return (
    <g transform={`translate(${x} ${y}) rotate(${angle})`}>
      <rect x={-width / 2} y={-height / 2} width={width} height={height} rx={hpx(4)} fill={palette.fill} stroke={palette.stroke} strokeWidth={hpx(1)} />
      <text x={0} y={hpx(4)} textAnchor="middle" fontSize={hpx(10.5)} fontFamily="system-ui, sans-serif" fill={palette.text}>{text}</text>
    </g>
  );
}

function FittingGlyph({ fitting, hpx }: { fitting: CondensateFitting; hpx: (n: number) => number }) {
  const { x, y } = fitting.point;
  const axis = fitting.axis ?? { x: 1, y: 0, z: 0 };
  const planAxisLength = Math.hypot(axis.x, axis.y);
  const angle = planAxisLength > 1e-6 ? (Math.atan2(axis.y, axis.x) * 180) / Math.PI : 0;
  const s = hpx(1);
  const stroke = TUBE.edge;
  switch (fitting.kind) {
    case 'wye':
      return (
        <g transform={`translate(${x} ${y}) rotate(${angle})`}>
          <circle r={6 * s} fill="#fff" stroke={stroke} strokeWidth={1.2 * s} />
          <path d={`M${-4 * s} ${-3 * s} L0 0 L${-4 * s} ${3 * s} M0 0 L${5 * s} 0`} fill="none" stroke={stroke} strokeWidth={1.3 * s} />
        </g>
      );
    case 'cleanout':
      return (
        <g transform={`translate(${x} ${y})`}>
          <circle r={6.5 * s} fill="#fff" stroke={stroke} strokeWidth={1.3 * s} />
          <text y={3 * s} textAnchor="middle" fontSize={7 * s} fontFamily="system-ui, sans-serif" fill={stroke}>CO</text>
        </g>
      );
    case 'air-vent':
      return (
        <g transform={`translate(${x + 9 * s} ${y - 9 * s})`}>
          <circle r={5.5 * s} fill="#fff" stroke="#4338ca" strokeWidth={1.2 * s} />
          <text y={2.6 * s} textAnchor="middle" fontSize={6 * s} fontFamily="system-ui, sans-serif" fill="#4338ca">AV</text>
        </g>
      );
    case 'p-trap':
      return (
        <g transform={`translate(${x} ${y}) rotate(${angle})`}>
          <path d={`M${-5 * s} ${-5 * s} L${-5 * s} ${2 * s} Q${-5 * s} ${7 * s} 0 ${7 * s} Q${5 * s} ${7 * s} ${5 * s} ${2 * s} L${5 * s} ${-5 * s}`} fill="none" stroke="#9a3412" strokeWidth={1.6 * s} />
        </g>
      );
    case 'tundish':
      return (
        <g transform={`translate(${x} ${y})`}>
          <path d={`M${-8 * s} ${-6 * s} L${8 * s} ${-6 * s} L0 ${7 * s} Z`} fill="#fff" stroke={stroke} strokeWidth={1.3 * s} />
        </g>
      );
    case 'hepvo':
      return <rect x={x - 5 * s} y={y - 5 * s} width={10 * s} height={10 * s} fill="#1f2937" stroke="#fff" strokeWidth={s} />;
    case 'wall-sleeve':
      return (
        <g transform={`translate(${x} ${y}) rotate(${angle})`}>
          <path d={`M${-4 * s} ${-9 * s} L${-4 * s} ${9 * s} M${4 * s} ${-9 * s} L${4 * s} ${9 * s}`} stroke="#475569" strokeWidth={1.6 * s} />
        </g>
      );
    case 'terminal-outlet':
      return (
        <g transform={`translate(${x} ${y}) rotate(${angle})`}>
          <path d={`M0 0 L${10 * s} 0 M${6 * s} ${-4 * s} L${10 * s} 0 L${6 * s} ${4 * s}`} fill="none" stroke={stroke} strokeWidth={1.5 * s} />
        </g>
      );
    default:
      return null;
  }
}

function PipeTube({ view, hpx, k, selected, colorFor, opacity = 1, showArrows, dashed = false }: {
  view: CondensatePlanPresentation;
  hpx: (n: number) => number;
  k: number;
  selected: boolean;
  colorFor?: (run: { a: Point2D }) => string;
  opacity?: number;
  showArrows: boolean;
  dashed?: boolean;
}) {
  const width = Math.max(view.insulatedDiameterMm, hpx(3));
  const arrows = showArrows ? condensateFlowArrows(view.runs, Math.max(600, hpx(140)), hpx(60)) : [];
  return (
    <g opacity={opacity}>
      {selected ? <path d={pathData(view.path)} fill="none" stroke={TUBE.selected} strokeOpacity={0.35} strokeWidth={width + hpx(9)} strokeLinecap="round" strokeLinejoin="round" /> : null}
      <path d={pathData(view.path)} fill="none" stroke={TUBE.edge} strokeWidth={width + hpx(1.4)} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dashed ? `${hpx(10)} ${hpx(6)}` : undefined} />
      {colorFor
        ? view.runs.map((run, index) => (
          <path key={index} d={pathData([run.a, run.b])} fill="none" stroke={colorFor(run)} strokeWidth={width} strokeLinecap="round" />
        ))
        : <path d={pathData(view.path)} fill="none" stroke={TUBE.insulation} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />}
      {k > 0.08 ? <path d={pathData(view.path)} fill="none" stroke={TUBE.sheen} strokeOpacity={0.75} strokeWidth={width * 0.28} strokeLinecap="round" strokeLinejoin="round" /> : null}
      {arrows.map((arrow, index) => (
        <path key={index} transform={`translate(${arrow.point.x} ${arrow.point.y}) rotate(${arrow.angleDeg})`}
          d={`M${-hpx(4)} ${-hpx(4)} L${hpx(2)} 0 L${-hpx(4)} ${hpx(4)}`} fill="none" stroke={TUBE.edge} strokeWidth={hpx(1.5)} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {view.verticals.map((mark, index) => (
        <g key={`v${index}`} transform={`translate(${mark.point.x} ${mark.point.y})`}>
          <circle r={Math.max(width / 2 + hpx(2), hpx(6))} fill="#fff" stroke={TUBE.edge} strokeWidth={hpx(1.4)} />
          {mark.direction === 'down'
            ? <path d={`M${-hpx(4)} ${-hpx(4)} L${hpx(4)} ${hpx(4)} M${hpx(4)} ${-hpx(4)} L${-hpx(4)} ${hpx(4)}`} stroke={TUBE.edge} strokeWidth={hpx(1.3)} />
            : <circle r={hpx(2.2)} fill={TUBE.edge} />}
        </g>
      ))}
    </g>
  );
}

export const CondensateOverlay = forwardRef<CondensateOverlayHandle, CondensateOverlayProps>(function CondensateOverlay(props, ref) {
  const { enabled, width, height, viewportZoom, panOffset, hvacElements, selectedIds, settings } = props;
  const gRef = useRef<SVGGElement | null>(null);
  const liveViewportRef = useRef<FabricViewportMatrix | null>(null);
  const preview = useCondensatePreviewStore((state) => state.result);
  const highlightUnitId = useCondensatePreviewStore((state) => state.highlightUnitId);

  const syncViewTransform = useCallback((vpt: readonly number[]) => {
    if (vpt.length < 6) return;
    const live = [0, 1, 2, 3, 4, 5].map((index) => Number(vpt[index])) as unknown as FabricViewportMatrix;
    if (!live.every(Number.isFinite)) return;
    liveViewportRef.current = live;
    const value = affineMatrixToSvg(fabricViewportToWorldSvgMatrix(live));
    if (gRef.current && gRef.current.getAttribute('transform') !== value) gRef.current.setAttribute('transform', value);
  }, []);
  useLayoutEffect(() => {
    if (liveViewportRef.current) syncViewTransform(liveViewportRef.current);
  });
  useImperativeHandle(ref, () => ({ syncViewTransform }), [syncViewTransform]);

  const view = getCanvasTransform(viewportZoom, panOffset);
  const k = MM_TO_PX * view.zoom;
  const hpx = (n: number) => n / Math.max(k, 1e-6);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const committed = useMemo(() => hvacElements
    .filter(isCondensatePipe)
    .map((element) => {
      const presentation = buildCondensatePlanPresentation(element);
      return presentation ? Object.assign(presentation, { element }) : null;
    })
    .filter((entry): entry is CondensatePlanPresentation & { element: HvacElement } => entry !== null), [hvacElements]);
  const gullies = useMemo(() => hvacElements.filter(isCondensateGully), [hvacElements]);
  const previewViews = useMemo(() => (preview?.elementsToAdd ?? [])
    .map(buildCondensatePlanPresentation)
    .filter((entry): entry is CondensatePlanPresentation => entry !== null), [preview]);
  const replaced = useMemo(() => new Set(preview?.removeElementIds ?? []), [preview]);
  const slackLookup = useMemo(() => {
    const map = new Map<string, number>();
    for (const network of preview?.networks ?? []) {
      for (const node of network.nodes) map.set(`${Math.round(node.x)},${Math.round(node.y)}`, node.slackMm);
    }
    return map;
  }, [preview]);

  if (!enabled || (!committed.length && !gullies.length && !preview)) return null;
  const showDetail = k > 0.05;
  const matrix = liveViewportRef.current
    ? affineMatrixToSvg(fabricViewportToWorldSvgMatrix(liveViewportRef.current))
    : canvasTransformToSvgMatrix(view);

  return (
    <div className="absolute left-0 top-0 z-[7]" style={{ width, height, pointerEvents: 'none' }} data-testid="condensate-overlay">
      <svg width={width} height={height} style={{ display: 'block', pointerEvents: 'none' }}>
        <g ref={gRef} transform={matrix}>
          {committed.map((entry) => {
            if (preview && replaced.has(entry.id)) {
              return <PipeTube key={entry.id} view={entry} hpx={hpx} k={k} selected={false} opacity={0.18} showArrows={false} />;
            }
            const selected = selectedSet.has(entry.id);
            return (
              <g key={entry.id}>
                <PipeTube view={entry} hpx={hpx} k={k} selected={selected} showArrows={showDetail} />
                {showDetail ? entry.fittings.map((fitting) => <FittingGlyph key={fitting.id} fitting={fitting} hpx={hpx} />) : null}
                {settings.showHangers && showDetail
                  ? layoutCondensateSupports(entry.element, settings)
                    .filter((support) => support.orientation === 'horizontal')
                    .map((support, index) => (
                      <circle key={`h${index}`} cx={support.point.x} cy={support.point.y} r={hpx(2)} fill="#334155" />
                    ))
                  : null}
                {settings.showFallTags && entry.fallTag && entry.fallTag.runLengthMm * k > FALL_TAG_MIN_SCREEN_PX
                  ? <Tag x={entry.fallTag.point.x} y={entry.fallTag.point.y} angle={entry.fallTag.angleDeg} text={entry.fallTag.text} hpx={hpx} />
                  : null}
                {settings.showLevelTags && (selected || k > 0.22)
                  ? entry.levelTags.map((tag, index) => (
                    <Tag key={index} x={tag.point.x + hpx(28)} y={tag.point.y - hpx(14)} text={tag.text} hpx={hpx} />
                  ))
                  : null}
              </g>
            );
          })}

          {gullies.map((gully) => {
            const spec = readCondensateGullySpec(gully);
            if (!showDetail) return null;
            const label = spec.terminationKind === 'floor-gully' ? `${gully.label} · rim ${Math.round(spec.inletElevationMm)}`
              : spec.terminationKind === 'stack-connection' ? `${gully.label} · stack @ ${Math.round(spec.inletElevationMm)}`
                : `${gully.label} · outlet @ ${Math.round(spec.inletElevationMm)}`;
            return <Tag key={gully.id} x={spec.connectionPoint.x} y={spec.connectionPoint.y + Math.max(gully.depth / 2, hpx(10)) + hpx(14)} text={label} hpx={hpx} />;
          })}

          {preview ? (
            <g data-testid="condensate-preview">
              {previewViews.map((entry) => (
                <g key={entry.id}>
                  <PipeTube view={entry} hpx={hpx} k={k} selected={false} opacity={0.92} showArrows={showDetail}
                    colorFor={(run) => headMarginColor(slackLookup.get(`${Math.round(run.a.x)},${Math.round(run.a.y)}`) ?? 200)} />
                  {showDetail ? entry.fittings.map((fitting) => <FittingGlyph key={fitting.id} fitting={fitting} hpx={hpx} />) : null}
                  {settings.showFallTags && entry.fallTag && entry.fallTag.runLengthMm * k > FALL_TAG_MIN_SCREEN_PX
                    ? <Tag x={entry.fallTag.point.x} y={entry.fallTag.point.y} angle={entry.fallTag.angleDeg} text={entry.fallTag.text} hpx={hpx} />
                    : null}
                </g>
              ))}
              {preview.unresolvedPaths.map((path) => (
                <path key={path.unitId} d={pathData(path.points)} fill="none" stroke="#dc2626" strokeWidth={hpx(2.2)} strokeDasharray={`${hpx(8)} ${hpx(6)}`} />
              ))}
              {preview.crossings.map((crossing, index) => (
                <g key={`${crossing.key}#${index}`} transform={`translate(${crossing.point.x} ${crossing.point.y})`}>
                  <circle r={hpx(7)} fill={crossing.relation === 'hop' ? '#fdf4ff' : '#fff'} stroke={crossing.relation === 'hop' ? '#a21caf' : '#0369a1'} strokeWidth={hpx(1.4)} />
                  <text y={hpx(3.5)} textAnchor="middle" fontSize={hpx(9)} fontFamily="system-ui, sans-serif" fill={crossing.relation === 'hop' ? '#a21caf' : '#0369a1'}>
                    {crossing.relation === 'below' ? '↓' : crossing.relation === 'above' ? '↑' : crossing.relation === 'hop' ? 'H' : '!'}
                  </text>
                </g>
              ))}
              {preview.perUnit.map((unit) => {
                const start = preview.elementsToAdd
                  .map((element) => element.properties.drainStart as { unitId?: string; point?: Point2D } | undefined)
                  .find((connection) => connection?.unitId === unit.unitId)?.point
                  ?? preview.unresolvedPaths.find((path) => path.unitId === unit.unitId)?.points[0];
                if (!start) return null;
                const tone = unit.status === 'gravity' ? 'ok' : unit.status === 'pumped' ? 'pump' : 'bad';
                const text = unit.status === 'gravity' ? `${unit.label} · gravity`
                  : unit.status === 'pumped' ? `${unit.label} · pump +${Math.round(unit.liftMm)}`
                    : unit.status === 'infeasible' ? `${unit.label} · short ${unit.shortfallMm ?? '?'} mm` : `${unit.label} · skipped`;
                return (
                  <g key={unit.unitId} opacity={highlightUnitId && highlightUnitId !== unit.unitId ? 0.45 : 1}>
                    <Tag x={start.x} y={start.y - hpx(22)} text={text} hpx={hpx} tone={tone} />
                  </g>
                );
              })}
            </g>
          ) : null}
        </g>
      </svg>
    </div>
  );
});
