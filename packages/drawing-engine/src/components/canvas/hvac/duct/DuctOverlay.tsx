'use client';

/**
 * Plan painter for duct runs (SVG, model millimetres): every fabricated piece,
 * flange ticks at joints, the hatched flexible connector, turning vanes, piece
 * marks and the size / construction tag — all read from the fabrication plan,
 * the same plan the 3D view and the BOM use.
 *
 * While the duct tool is active it also shows the units' air collars, and the
 * tool pushes its live draft here imperatively (no React render per pointer
 * move). Duct runs are picked geometrically by the plan renderer, so select
 * works like any other element. Shares the same-frame viewport bond as the
 * condensate and pipe overlays.
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

import { listAirPorts } from './ductAirPorts';
import { getDuctRunPlan, planDuctRunSpec } from './ductFabricationPlanner';
import { airPortMarkup, draftLabelMarkup, ductRunMarkup } from './ductOverlayMarkup';
import { getDuctPlanPresentation } from './ductPick';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import type { DuctDesignSettings } from './ductSettings';
import { isDuctElement, readDuctRunSpec } from './ductTypes';

export interface DuctOverlayHandle {
  syncViewTransform: (viewport: readonly number[]) => void;
  /** Live draft run (or null to clear), with an optional label at the cursor. */
  setDraft: (draft: { element: HvacElement; label?: { point: Point2D; text: string } } | null) => void;
  setHoveredPort: (key: string | null) => void;
}

export interface DuctOverlayProps {
  enabled: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: HvacElement[];
  selectedIds: string[];
  settings: DuctDesignSettings;
  /** Show the units' air collars (duct tool active). */
  showPorts: boolean;
}

export const DuctOverlay = forwardRef<DuctOverlayHandle, DuctOverlayProps>(function DuctOverlay(props, ref) {
  const { enabled, width, height, viewportZoom, panOffset, hvacElements, selectedIds, settings, showPorts } = props;
  const gRef = useRef<SVGGElement | null>(null);
  const draftRef = useRef<SVGGElement | null>(null);
  const portsRef = useRef<SVGGElement | null>(null);
  const liveViewportRef = useRef<FabricViewportMatrix | null>(null);
  const hoveredPortRef = useRef<string | null>(null);

  const view = getCanvasTransform(viewportZoom, panOffset);
  const k = MM_TO_PX * view.zoom;
  const kRef = useRef(k);
  kRef.current = k;
  const sceneRef = useRef({ hvacElements, settings });
  sceneRef.current = { hvacElements, settings };

  const syncViewTransform = useCallback((vpt: readonly number[]) => {
    if (vpt.length < 6) return;
    const live = [0, 1, 2, 3, 4, 5].map((index) => Number(vpt[index])) as unknown as FabricViewportMatrix;
    if (!live.every(Number.isFinite)) return;
    liveViewportRef.current = live;
    const value = affineMatrixToSvg(fabricViewportToWorldSvgMatrix(live));
    if (gRef.current && gRef.current.getAttribute('transform') !== value) gRef.current.setAttribute('transform', value);
  }, []);

  const ports = useMemo(() => (showPorts ? listAirPorts(hvacElements) : []), [showPorts, hvacElements]);
  const occupied = useMemo(() => {
    const keys = new Set<string>();
    for (const element of hvacElements) {
      if (!isDuctElement(element)) continue;
      const start = readDuctRunSpec(element)?.start;
      if (start?.kind === 'unit-port') keys.add(`${start.unitId}:${start.portId}`);
    }
    return keys;
  }, [hvacElements]);
  const paintPorts = useCallback(() => {
    if (portsRef.current) portsRef.current.innerHTML = airPortMarkup(ports, kRef.current, hoveredPortRef.current, occupied);
  }, [ports, occupied]);

  const setHoveredPort = useCallback((key: string | null) => {
    if (hoveredPortRef.current === key) return;
    hoveredPortRef.current = key;
    paintPorts();
  }, [paintPorts]);

  const setDraft = useCallback((draft: { element: HvacElement; label?: { point: Point2D; text: string } } | null) => {
    const target = draftRef.current;
    if (!target) return;
    if (!draft) {
      target.innerHTML = '';
      return;
    }
    const spec = readDuctRunSpec(draft.element);
    if (!spec) return;
    const { hvacElements: scene, settings: current } = sceneRef.current;
    const plan = planDuctRunSpec(draft.element.id, spec, { settings: current, scene });
    const markup = ductRunMarkup(buildDuctPlanPresentation(plan), {
      k: kRef.current, draft: true, showTags: true, showJointTicks: true, showMarks: false,
    });
    target.innerHTML = markup + (draft.label ? draftLabelMarkup(draft.label.point, draft.label.text, kRef.current) : '');
  }, []);

  useImperativeHandle(ref, () => ({ syncViewTransform, setDraft, setHoveredPort }), [syncViewTransform, setDraft, setHoveredPort]);

  useLayoutEffect(() => {
    if (liveViewportRef.current) syncViewTransform(liveViewportRef.current);
    paintPorts();
  });

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const runs = useMemo(() => hvacElements
    .filter(isDuctElement)
    .map((element) => getDuctRunPlan(element, hvacElements, settings))
    .filter((plan): plan is NonNullable<typeof plan> => plan !== null), [hvacElements, settings]);

  if (!enabled) return null;
  // Level of detail: joint ticks and tags need the duct to be a few pixels wide.
  const style = {
    k,
    showTags: settings.showSizeTags && k > 0.035,
    showJointTicks: settings.showJointTicks && k > 0.03,
    showMarks: settings.showPieceMarks && k > 0.2,
  };
  const matrix = liveViewportRef.current
    ? affineMatrixToSvg(fabricViewportToWorldSvgMatrix(liveViewportRef.current))
    : canvasTransformToSvgMatrix(view);

  return (
    <div className="absolute left-0 top-0 z-[6]" style={{ width, height, pointerEvents: 'none' }} data-testid="duct-overlay">
      <svg width={width} height={height} style={{ display: 'block', pointerEvents: 'none' }}>
        <g ref={gRef} transform={matrix}>
          {runs.map((plan) => (
            <g
              key={plan.elementId}
              dangerouslySetInnerHTML={{
                __html: ductRunMarkup(getDuctPlanPresentation(plan), { ...style, selected: selectedSet.has(plan.elementId) }),
              }}
            />
          ))}
          <g ref={portsRef} data-testid="duct-ports" />
          <g ref={draftRef} data-testid="duct-draft" />
        </g>
      </svg>
    </div>
  );
});
