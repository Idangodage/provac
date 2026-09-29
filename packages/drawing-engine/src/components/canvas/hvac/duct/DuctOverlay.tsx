'use client';

/**
 * Plan painter for duct runs (SVG, model millimetres): every fabricated piece,
 * flange ticks at joints, the hatched flexible connector, turning vanes, piece
 * marks and the size / construction tag — all read from the fabrication plan,
 * the same plan the 3D view and the BOM use.
 *
 * While the duct tool is active it also shows the units' air collars and the
 * branch target under the cursor, and the tool pushes its live draft here
 * imperatively (no React render per pointer move). A branch draft also
 * re-plans its parent, so the moved joints or the new split show live. Duct runs are picked geometrically by the plan renderer, so select
 * works like any other element. Shares the same-frame viewport bond as the
 * condensate and pipe overlays.
 */
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import type { HvacElement, Point2D } from '../../../../types';
import {
  affineMatrixToSvg,
  canvasTransformToSvgMatrix,
  fabricViewportToWorldSvgMatrix,
  getCanvasTransform,
  type FabricViewportMatrix,
} from '../../coordinateTransform';
import { MM_TO_PX } from '../../scale';
import { useCondensatePreviewStore } from '../condensate/condensatePreviewStore';

import { listAirPorts } from './ductAirPorts';
import { useDuctAutoPreviewStore } from './ductAutoPreviewStore';
import { applyDuctRunEdit, moveDuctLegSideways, moveDuctRiser, moveDuctRunEnd, type DuctEditResult } from './ductEdits';
import { getDuctRunPlan, planDuctRunSpec } from './ductFabricationPlanner';
import { moveDuctRuns } from './ductFollow';
import { ductLegs } from './ductGeometry';
import { airPortMarkup, airTerminalMarkup, branchTargetMarkup, draftLabelMarkup, ductRunMarkup, ductSupportMarkup, type DuctMarkupStyle } from './ductOverlayMarkup';
import { getDuctPlanPresentation } from './ductPick';
import { buildDuctPlanPresentation } from './ductPlanPresentation';
import type { DuctDesignSettings } from './ductSettings';
import { getDuctSupportPlan } from './ductSupports';
import { isDuctTerminalElement, listTerminalPorts, readDuctTerminalSpec } from './ductTerminals';
import { ductParentRunId, isDuctElement, readDuctRunSpec } from './ductTypes';

export interface DuctOverlayDraft {
  element: HvacElement;
  /** Existing runs the draft changes (a parent whose end becomes a split). */
  changed?: HvacElement[];
  label?: { point: Point2D; text: string };
}

export interface DuctOverlayBranchTarget {
  kind: 'tap' | 'split' | 'spigot';
  marker: readonly [Point2D, Point2D];
  label: string;
}

export interface DuctOverlayHandle {
  syncViewTransform: (viewport: readonly number[]) => void;
  /** Live draft run (or null to clear), with an optional label at the cursor. */
  setDraft: (draft: DuctOverlayDraft | null) => void;
  setHoveredPort: (key: string | null) => void;
  setBranchTarget: (target: DuctOverlayBranchTarget | null) => void;
}

function markupStyle(k: number, settings: DuctDesignSettings): DuctMarkupStyle {
  // Level of detail: joint ticks and tags need the duct to be a few pixels wide.
  return {
    k,
    showTags: settings.showSizeTags && k > 0.035,
    showJointTicks: settings.showJointTicks && k > 0.03,
    showMarks: settings.showPieceMarks && k > 0.2,
    showSupports: settings.showSupports && k > 0.03,
  };
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
  /** Selected runs can be dragged (select tool). */
  moveEnabled?: boolean;
  /** Commit a drag of the selected runs by a plan delta (mm). */
  onMoveCommit?: (ids: string[], delta: Point2D) => void;
  /** Commit an in-place edit of one run (a leg, its end or a riser dragged). */
  onEditCommit?: (elementId: string, result: DuctEditResult, action: string) => void;
}

/** A drag handle on the selected run: a leg (sideways), its end (along) or a riser (along its heading). */
interface DuctEditHandle {
  kind: 'leg' | 'end' | 'riser';
  legIndex: number;
  point: Point2D;
  /** The axis the handle moves along (plan). */
  axis: Point2D;
}

const HANDLE_ACTIONS: Record<DuctEditHandle['kind'], string> = { leg: 'Move duct leg', end: 'Move duct end', riser: 'Move duct riser' };

export const DuctOverlay = forwardRef<DuctOverlayHandle, DuctOverlayProps>(function DuctOverlay(props, ref) {
  const { enabled, width, height, viewportZoom, panOffset, hvacElements, selectedIds, settings, showPorts, moveEnabled, onMoveCommit, onEditCommit } = props;
  const gRef = useRef<SVGGElement | null>(null);
  const draftRef = useRef<SVGGElement | null>(null);
  const portsRef = useRef<SVGGElement | null>(null);
  const targetRef = useRef<SVGGElement | null>(null);
  /** Committed runs only — the draft layer draws the re-planned parent with the same run id. */
  const runsRef = useRef<SVGGElement | null>(null);
  /** Committed runs the draft re-draws (a branch's parent, or runs being moved), hidden meanwhile. */
  const hiddenRunsRef = useRef<ReadonlySet<string>>(new Set());
  const moveRef = useRef<{ ids: string[]; start: Point2D; startClient: Point2D; moved: boolean; delta: Point2D } | null>(null);
  const editRef = useRef<{ handle: DuctEditHandle; elementId: string; start: Point2D; result: DuctEditResult | null } | null>(null);
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

  const ports = useMemo(() => (showPorts ? [...listAirPorts(hvacElements), ...listTerminalPorts(hvacElements)] : []), [showPorts, hvacElements]);
  const occupied = useMemo(() => {
    const keys = new Set<string>();
    for (const element of hvacElements) {
      if (!isDuctElement(element)) continue;
      const spec = readDuctRunSpec(element);
      if (spec?.start.kind === 'unit-port') keys.add(`${spec.start.unitId}:${spec.start.portId}`);
      if (spec?.end.kind === 'terminal') keys.add(`${spec.end.terminalId}:${spec.end.portId}`);
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

  const applyHiddenRun = useCallback(() => {
    const root = runsRef.current;
    if (!root) return;
    root.querySelectorAll<SVGGElement>('[data-duct-run], [data-duct-supports]').forEach((node) => {
      const hide = hiddenRunsRef.current.has(node.getAttribute('data-duct-run') ?? node.getAttribute('data-duct-supports') ?? '');
      if ((node.style.display === 'none') !== hide) node.style.display = hide ? 'none' : '';
    });
  }, []);

  const setDraft = useCallback((draft: DuctOverlayDraft | null) => {
    const target = draftRef.current;
    if (!target) return;
    const spec = draft ? readDuctRunSpec(draft.element) : null;
    if (!draft || !spec) {
      target.innerHTML = '';
      hiddenRunsRef.current = new Set();
      applyHiddenRun();
      return;
    }
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const replaced = new Map((draft.changed ?? []).map((element) => [element.id, element]));
    const scene = [...stored.map((element) => replaced.get(element.id) ?? element), draft.element];
    const plan = planDuctRunSpec(draft.element.id, spec, { settings: current, scene });
    let markup = ductRunMarkup(buildDuctPlanPresentation(plan), {
      k: kRef.current, draft: true, showTags: true, showJointTicks: true, showMarks: false,
    });
    const parentId = ductParentRunId(spec);
    const parent = parentId ? scene.find((element) => element.id === parentId) : undefined;
    const parentSpec = parent ? readDuctRunSpec(parent) : null;
    if (parent && parentSpec) {
      const parentPlan = planDuctRunSpec(parent.id, parentSpec, { settings: current, scene });
      markup = ductRunMarkup(buildDuctPlanPresentation(parentPlan), markupStyle(kRef.current, current)) + markup;
    }
    // Hide the committed drawings the draft re-draws: the parent, and the run itself when it is being extended.
    const hidden = [...(parent ? [parent.id] : []), ...(stored.some((element) => element.id === draft.element.id) ? [draft.element.id] : [])];
    if (hidden.join() !== [...hiddenRunsRef.current].join()) {
      hiddenRunsRef.current = new Set(hidden);
      applyHiddenRun();
    }
    target.innerHTML = markup + (draft.label ? draftLabelMarkup(draft.label.point, draft.label.text, kRef.current) : '');
  }, [applyHiddenRun]);

  // ---- Drag the selected runs (select tool). ----
  const toWorld = useCallback((clientX: number, clientY: number): Point2D | null => {
    const matrix = gRef.current?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const renderMovePreview = useCallback((ids: string[], delta: Point2D) => {
    const target = draftRef.current;
    if (!target) return;
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const result = moveDuctRuns(stored, ids, delta, current);
    const replaced = new Map(result.moved.map((element) => [element.id, element]));
    const scene = stored.map((element) => replaced.get(element.id) ?? element);
    target.innerHTML = result.moved.map((element) => {
      const plan = getDuctRunPlan(element, scene, current);
      return plan ? ductRunMarkup(buildDuctPlanPresentation(plan), { ...markupStyle(kRef.current, current), selected: ids.includes(element.id) }) : '';
    }).join('');
    hiddenRunsRef.current = new Set(result.moved.map((element) => element.id));
    applyHiddenRun();
  }, [applyHiddenRun]);

  const endMove = useCallback((commit: boolean) => {
    const move = moveRef.current;
    moveRef.current = null;
    if (draftRef.current) draftRef.current.innerHTML = '';
    hiddenRunsRef.current = new Set();
    applyHiddenRun();
    if (commit && move?.moved) onMoveCommit?.(move.ids, move.delta);
  }, [applyHiddenRun, onMoveCommit]);

  const onHitPointerDown = useCallback((event: ReactPointerEvent<SVGPathElement>) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
    const start = toWorld(event.clientX, event.clientY);
    if (!start) return;
    event.stopPropagation();
    event.preventDefault();
    const { hvacElements: stored } = sceneRef.current;
    const ids = selectedIds.filter((id) => stored.some((element) => element.id === id && isDuctElement(element)));
    moveRef.current = { ids, start, startClient: { x: event.clientX, y: event.clientY }, moved: false, delta: { x: 0, y: 0 } };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }, [selectedIds, toWorld]);

  const onHitPointerMove = useCallback((event: ReactPointerEvent<SVGPathElement>) => {
    const move = moveRef.current;
    if (!move) return;
    const at = toWorld(event.clientX, event.clientY);
    if (!at) return;
    if (!move.moved && Math.hypot(event.clientX - move.startClient.x, event.clientY - move.startClient.y) < 4) return;
    move.moved = true;
    // Snap the drag to 10 mm so moved runs keep round coordinates.
    move.delta = { x: Math.round((at.x - move.start.x) / 10) * 10, y: Math.round((at.y - move.start.y) / 10) * 10 };
    renderMovePreview(move.ids, move.delta);
  }, [renderMovePreview, toWorld]);

  // ---- Edit handles on the one selected run: legs sideways, the end along, risers along. ----
  const renderEditPreview = useCallback((elements: HvacElement[], selectedId: string) => {
    const target = draftRef.current;
    if (!target) return;
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const replaced = new Map(elements.map((element) => [element.id, element]));
    const scene = stored.map((element) => replaced.get(element.id) ?? element);
    target.innerHTML = elements.map((element) => {
      const plan = getDuctRunPlan(element, scene, current);
      return plan ? ductRunMarkup(buildDuctPlanPresentation(plan), { ...markupStyle(kRef.current, current), selected: element.id === selectedId }) : '';
    }).join('');
    hiddenRunsRef.current = new Set(elements.map((element) => element.id));
    applyHiddenRun();
  }, [applyHiddenRun]);

  const onHandlePointerDown = useCallback((event: ReactPointerEvent<SVGElement>, handle: DuctEditHandle, elementId: string) => {
    if (event.button !== 0) return;
    const start = toWorld(event.clientX, event.clientY);
    if (!start) return;
    event.stopPropagation();
    event.preventDefault();
    editRef.current = { handle, elementId, start, result: null };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }, [toWorld]);

  const onHandlePointerMove = useCallback((event: ReactPointerEvent<SVGElement>) => {
    const edit = editRef.current;
    if (!edit) return;
    const at = toWorld(event.clientX, event.clientY);
    if (!at) return;
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const element = stored.find((candidate) => candidate.id === edit.elementId);
    const spec = element ? readDuctRunSpec(element) : null;
    if (!element || !spec) return;
    // Snap the handle's travel to 10 mm along its axis.
    const along = Math.round(((at.x - edit.start.x) * edit.handle.axis.x + (at.y - edit.start.y) * edit.handle.axis.y) / 10) * 10;
    const offset = { x: edit.handle.axis.x * along, y: edit.handle.axis.y * along };
    const result = edit.handle.kind === 'leg' ? moveDuctLegSideways(spec, edit.handle.legIndex, offset)
      : edit.handle.kind === 'riser' ? moveDuctRiser(spec, edit.handle.legIndex, offset)
        : moveDuctRunEnd(spec, { x: edit.handle.point.x + offset.x, y: edit.handle.point.y + offset.y });
    if (!result) return;
    edit.result = result;
    renderEditPreview(applyDuctRunEdit(stored, element, result, current), element.id);
  }, [renderEditPreview, toWorld]);

  const endEdit = useCallback((commit: boolean) => {
    const edit = editRef.current;
    editRef.current = null;
    if (draftRef.current) draftRef.current.innerHTML = '';
    hiddenRunsRef.current = new Set();
    applyHiddenRun();
    if (commit && edit?.result) onEditCommit?.(edit.elementId, edit.result, HANDLE_ACTIONS[edit.handle.kind]);
  }, [applyHiddenRun, onEditCommit]);

  const setBranchTarget = useCallback((target: DuctOverlayBranchTarget | null) => {
    if (targetRef.current) targetRef.current.innerHTML = target ? branchTargetMarkup(target, kRef.current) : '';
  }, []);

  useImperativeHandle(ref, () => ({ syncViewTransform, setDraft, setHoveredPort, setBranchTarget }), [syncViewTransform, setDraft, setHoveredPort, setBranchTarget]);

  useLayoutEffect(() => {
    if (liveViewportRef.current) syncViewTransform(liveViewportRef.current);
    paintPorts();
    applyHiddenRun();
  });

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const terminals = useMemo(() => hvacElements.flatMap((element) => {
    const spec = isDuctTerminalElement(element) ? readDuctTerminalSpec(element) : null;
    return spec ? [{ element, spec }] : [];
  }), [hvacElements]);
  // Auto duct preview: the proposed runs, dashed, over the drawing they were generated from (hiding the runs they replace).
  const cardPreview = useDuctAutoPreviewStore((state) => (state.result && state.scene === hvacElements ? state.result : null));
  // The unified Auto route's duct proposal previews the same way.
  const routePreview = useCondensatePreviewStore((state) => state.unified?.ducts ?? null);
  const autoPreview = useMemo(() => {
    const runs = [...(cardPreview?.runs ?? []), ...(routePreview?.elementsToAdd ?? [])];
    const removeIds = [...(cardPreview?.removeIds ?? []), ...(routePreview?.removeElementIds ?? [])];
    return runs.length || removeIds.length ? { runs, removeIds } : null;
  }, [cardPreview, routePreview]);
  const replacedIds = useMemo(() => new Set(autoPreview?.removeIds ?? []), [autoPreview]);
  const previewMarkup = useMemo(() => {
    if (!autoPreview?.runs.length) return '';
    const scene = [...hvacElements.filter((element) => !replacedIds.has(element.id)), ...autoPreview.runs];
    return autoPreview.runs.map((run) => {
      const spec = readDuctRunSpec(run);
      return spec ? ductRunMarkup(buildDuctPlanPresentation(planDuctRunSpec(run.id, spec, { settings, scene })), {
        k, draft: true, showTags: true, showJointTicks: true, showMarks: false,
      }) : '';
    }).join('');
  }, [autoPreview, hvacElements, replacedIds, settings, k]);
  const runs = useMemo(() => hvacElements
    .filter(isDuctElement)
    .map((element) => getDuctRunPlan(element, hvacElements, settings))
    .filter((plan): plan is NonNullable<typeof plan> => plan !== null), [hvacElements, settings]);
  const hitAreas = useMemo(() => (moveEnabled ? runs.filter((plan) => selectedSet.has(plan.elementId)) : [])
    .flatMap((plan) => getDuctPlanPresentation(plan).piecePolygons.map((piece) => piece.polygon)), [moveEnabled, runs, selectedSet]);
  // Handles on the run when it alone is selected (legs that start on a collar or parent wall stay put).
  const editTarget = useMemo(() => {
    if (!moveEnabled || !onEditCommit) return null;
    const selectedRuns = runs.filter((plan) => selectedSet.has(plan.elementId));
    const plan = selectedRuns.length === 1 && selectedIds.length === 1 ? selectedRuns[0]! : null;
    if (!plan || plan.spec.legacy || plan.spec.locked) return null;
    const legs = ductLegs(plan.spec);
    const anchored = plan.spec.start.kind !== 'open';
    const handles: DuctEditHandle[] = [];
    legs.forEach((leg, index) => {
      if (leg.vertical) {
        if (!legs[index - 1]?.vertical) handles.push({ kind: 'riser', legIndex: index, point: { x: leg.start.x, y: leg.start.y }, axis: leg.direction });
        return;
      }
      if (leg.sloped || leg.lengthMm < 200 || (index === 0 && anchored)) return;
      handles.push({ kind: 'leg', legIndex: index, point: { x: (leg.start.x + leg.end.x) / 2, y: (leg.start.y + leg.end.y) / 2 }, axis: { x: -leg.direction.y, y: leg.direction.x } });
    });
    const last = legs[legs.length - 1];
    if (last && !last.vertical && plan.spec.end.kind !== 'split') handles.push({ kind: 'end', legIndex: legs.length - 1, point: { x: last.end.x, y: last.end.y }, axis: last.direction });
    return { elementId: plan.elementId, handles };
  }, [moveEnabled, onEditCommit, runs, selectedIds.length, selectedSet]);

  if (!enabled) return null;
  const style = markupStyle(k, settings);
  const matrix = liveViewportRef.current
    ? affineMatrixToSvg(fabricViewportToWorldSvgMatrix(liveViewportRef.current))
    : canvasTransformToSvgMatrix(view);

  return (
    <div className="absolute left-0 top-0 z-[6]" style={{ width, height, pointerEvents: 'none' }} data-testid="duct-overlay">
      <svg width={width} height={height} style={{ display: 'block', pointerEvents: 'none' }}>
        <g ref={gRef} transform={matrix}>
          <g
            data-testid="duct-terminals"
            dangerouslySetInnerHTML={{ __html: terminals.map(({ element, spec }) => airTerminalMarkup(element, spec, k, style.showTags)).join('') }}
          />
          <g ref={runsRef}>
            {runs.filter((plan) => !replacedIds.has(plan.elementId)).map((plan) => (
              <g
                key={plan.elementId}
                dangerouslySetInnerHTML={{
                  __html: ductRunMarkup(getDuctPlanPresentation(plan), { ...style, selected: selectedSet.has(plan.elementId) })
                    + (style.showSupports ? ductSupportMarkup(getDuctSupportPlan(plan, hvacElements, settings), k) : ''),
                }}
              />
            ))}
          </g>
          <g data-testid="duct-auto-preview" dangerouslySetInnerHTML={{ __html: previewMarkup }} />
          <g ref={portsRef} data-testid="duct-ports" />
          <g ref={targetRef} data-testid="duct-branch-target" />
          <g ref={draftRef} data-testid="duct-draft" />
          {hitAreas.length > 0 ? (
            <g data-testid="duct-move-handles">
              {hitAreas.map((polygon, index) => (
                <path
                  key={index}
                  d={`M${polygon.map((point) => `${point.x} ${point.y}`).join(' L')} Z`}
                  fill="transparent"
                  stroke="transparent"
                  strokeWidth={8}
                  vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: 'all', cursor: 'move' }}
                  onPointerDown={onHitPointerDown}
                  onPointerMove={onHitPointerMove}
                  onPointerUp={() => endMove(true)}
                  onPointerCancel={() => endMove(false)}
                />
              ))}
            </g>
          ) : null}
          {editTarget && editTarget.handles.length > 0 ? (
            <g data-testid="duct-edit-handles">
              {editTarget.handles.map((handle) => {
                const size = 11 / Math.max(k, 1e-6);
                const common = {
                  fill: '#ffffff', stroke: '#b45309', strokeWidth: 1.6, vectorEffect: 'non-scaling-stroke' as const,
                  style: { pointerEvents: 'all' as const, cursor: handle.kind === 'end' ? 'grab' : 'move' },
                  'data-duct-handle': `${handle.kind}:${handle.legIndex}`,
                  onPointerDown: (event: ReactPointerEvent<SVGElement>) => onHandlePointerDown(event, handle, editTarget.elementId),
                  onPointerMove: onHandlePointerMove,
                  onPointerUp: () => endEdit(true),
                  onPointerCancel: () => endEdit(false),
                };
                const { x, y } = handle.point;
                if (handle.kind === 'end') return <circle key={`${handle.kind}${handle.legIndex}`} cx={x} cy={y} r={size / 2} {...common} />;
                if (handle.kind === 'riser') {
                  const r = size * 0.7;
                  return <path key={`${handle.kind}${handle.legIndex}`} d={`M${x} ${y - r} L${x + r} ${y} L${x} ${y + r} L${x - r} ${y} Z`} {...common} />;
                }
                return <rect key={`${handle.kind}${handle.legIndex}`} x={x - size / 2} y={y - size / 2} width={size} height={size} {...common} />;
              })}
            </g>
          ) : null}
        </g>
      </svg>
    </div>
  );
});
