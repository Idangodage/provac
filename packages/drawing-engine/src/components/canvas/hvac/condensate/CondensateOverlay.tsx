'use client';

/**
 * Plan painter for condensate drainage (SVG, model millimetres).
 *
 * Draws committed condensate pipes as scaled insulated uPVC tubes with flow
 * arrows, fall tags ("CD 32 · 1:100 →"), invert-level tags, riser/drop
 * symbols and fitting glyphs — and, while a generation preview is open, the
 * proposed network coloured by head margin with a status chip at every unit.
 *
 * Condensate pipes are picked geometrically by the plan renderer, so select
 * works like any other element. A selected drain run gets micro-editing
 * handles and the drain edit bar (CondensateEditLayer / CondensateEditBar);
 * while a handle is dragged the re-solved network is drawn live in place of
 * the committed one. It shares the same-frame viewport bond as the pipe
 * studio overlay.
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

import { CondensateEditBar } from './CondensateEditBar';
import { CondensateEditHandles, useCondensateEditing } from './CondensateEditLayer';
import { FittingGlyph, PipeTube, Tag, pathData } from './condensatePlanGlyphs';
import {
  buildCondensatePlanPresentation,
  headMarginColor,
  type CondensatePlanPresentation,
} from './condensatePlanPresentation';
import { getIndoorUnitDrainPort } from './condensatePorts';
import { useCondensatePreviewStore } from './condensatePreviewStore';
import type { CondensateDesignSettings } from './condensateSettings';
import { layoutCondensateSupports } from './condensateSupports';
import { isCondensateGully, isCondensatePipe, readCondensateGullySpec, readCondensatePipeSpec } from './condensateTypes';

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
  /** Micro-editing of a selected drain run (select tool, plan view). */
  interactive?: boolean;
  /** Live re-solved network while a handle is dragged (for the 3D preview). */
  onEditPreviewChange?: (elements: HvacElement[] | null, removeIds: string[]) => void;
}

/** A fall tag is drawn on runs at least this long on screen. */
const FALL_TAG_MIN_SCREEN_PX = 90;

export const CondensateOverlay = forwardRef<CondensateOverlayHandle, CondensateOverlayProps>(function CondensateOverlay(props, ref) {
  const { enabled, width, height, viewportZoom, panOffset, hvacElements, selectedIds, settings, interactive = false, onEditPreviewChange } = props;
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
  // The selected drain run (one at a time) is editable while no Auto route preview is open.
  const editPipe = useMemo(() => {
    if (!enabled || !interactive || preview || selectedIds.length !== 1) return null;
    const element = hvacElements.find((candidate) => candidate.id === selectedIds[0]);
    return element && isCondensatePipe(element) ? element : null;
  }, [enabled, interactive, preview, selectedIds, hvacElements]);
  const edit = useCondensateEditing({
    enabled: editPipe !== null, pipe: editPipe, hvacElements, selectedIds, settings, gRef, hpx, onPreviewChange: onEditPreviewChange,
  });
  const editResult = edit.preview?.result?.ok ? edit.preview.result : null;
  const editIds = useMemo(() => new Set(editResult ? [...editResult.elements.map((element) => element.id), ...editResult.removeIds] : []), [editResult]);
  const editViews = useMemo(() => (editResult?.elements ?? [])
    .map(buildCondensatePlanPresentation)
    .filter((entry): entry is CondensatePlanPresentation => entry !== null), [editResult]);
  const pumpMaxLiftMm = useMemo(() => {
    const unitId = editPipe ? readCondensatePipeSpec(editPipe).drainStart?.unitId : undefined;
    const unit = unitId ? hvacElements.find((element) => element.id === unitId) : undefined;
    return (unit ? getIndoorUnitDrainPort(unit, settings)?.pumpMaxLiftMm : undefined) ?? settings.defaultPumpMaxLiftMm;
  }, [editPipe, hvacElements, settings]);
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
            if (editIds.has(entry.id)) return null;
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

          {editViews.map((entry) => (
            <g key={`edit-${entry.id}`} data-testid="condensate-edit-ghost">
              <PipeTube view={entry} hpx={hpx} k={k} selected={entry.id === editPipe?.id} showArrows={showDetail} />
              {showDetail ? entry.fittings.map((fitting) => <FittingGlyph key={fitting.id} fitting={fitting} hpx={hpx} />) : null}
              {settings.showFallTags && entry.fallTag && entry.fallTag.runLengthMm * k > FALL_TAG_MIN_SCREEN_PX
                ? <Tag x={entry.fallTag.point.x} y={entry.fallTag.point.y} angle={entry.fallTag.angleDeg} text={entry.fallTag.text} hpx={hpx} />
                : null}
            </g>
          ))}

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
          {editPipe && edit.model ? <CondensateEditHandles api={edit} pipe={editPipe} hpx={hpx} settings={settings} /> : null}
        </g>
      </svg>
      {editPipe && edit.model ? <CondensateEditBar pipe={editPipe} api={edit} pumpMaxLiftMm={pumpMaxLiftMm} /> : null}
    </div>
  );
});
