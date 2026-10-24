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
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import type { HvacElement, Point2D, Room } from '../../../../types';
import {
  affineMatrixToSvg,
  canvasTransformToSvgMatrix,
  fabricViewportToWorldSvgMatrix,
  getCanvasTransform,
  type FabricViewportMatrix,
} from '../../coordinateTransform';
import { MM_TO_PX } from '../../scale';
import { useCondensatePreviewStore } from '../condensate/condensatePreviewStore';
import type { HvacMoveBegin } from '../move/hvacMoveSession';

import { AirSystemLayer } from './AirSystemLayer';
import { listAirPorts } from './ductAirPorts';
import { analyseAirSystems, isAirSystemUnit, NO_ROOMS } from './ductAirSystems';
import type { AutoDuctWall } from './ductAutoLayout';
import { isAutoDuctPreviewCurrent, useDuctAutoPreviewStore } from './ductAutoPreviewStore';
import { applyDuctRunEdit, moveDuctLegSideways, moveDuctRiser, moveDuctRunEnd, type DuctEditResult } from './ductEdits';
import { getDuctRunPlan, planDuctRunSpec } from './ductFabricationPlanner';
import { ductLegs } from './ductGeometry';
import {
  airPortMarkup,
  airTerminalMarkup,
  airTerminalTagObstacles,
  branchTargetMarkup,
  draftLabelMarkup,
  ductRunMarkup,
  ductRunTagObstacles,
  ductSupportMarkup,
  equipmentTagObstacle,
  placedDuctTagMarkup,
  segmentFocusMarkup,
  type DuctMarkupStyle,
} from './ductOverlayMarkup';
import { distanceToPolygon, getDuctPlanPresentation } from './ductPick';
import { buildDuctPlanPresentation, type DuctPlanPresentation } from './ductPlanPresentation';
import { domainOf, useDuctSegmentUiStore, type DuctSegmentFocus } from './ductSegmentUiStore';
import { ductSegmentOfMark, polygonHotspot, segmentEnds, segmentOutlines } from './ductSegments';
import type { DuctDesignSettings } from './ductSettings';
import { getDuctSupportPlan } from './ductSupports';
import { estimateTagTextPx, layoutDuctTags, TAG_FONT_PX, type DuctTagSource, type PlacedDuctTag, type TagObstacle } from './ductTagLayout';
import { isDuctTerminalElement, listTerminalPorts, readDuctTerminalSpec } from './ductTerminals';
import { ductParentRunId, isDuctElement, readDuctRunSpec } from './ductTypes';
import type { ScreenRect } from './popoverPlacement';
import { useTerminalProposalStore } from './terminalProposalStore';
import { useDuctBuilding } from './useDuctBuilding';

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
  /** Where a segment of a run is on screen (client pixels): the piece `anchorMark`, else the whole segment. */
  segmentClientRect: (runId: string, key: string, anchorMark: string | null) => ScreenRect | null;
  /**
   * Show a move: the runs and air terminals it changes, drawn as they would be,
   * their committed drawings hidden meanwhile (null ends it). `committed`: the
   * move was just stored, so the drawing holds until the stored runs re-render.
   * `faded`: committed runs left as they are, drawn faint (a turned unit's
   * ducts wait for the release).
   */
  previewMove: (elements: readonly HvacElement[] | null, options?: { committed?: boolean; faded?: readonly string[] }) => void;
}

/** Tag widths on screen (px), measured once per text in the font the plan draws tags in. */
const TAG_WIDTHS = new Map<string, number>();
let tagContext: CanvasRenderingContext2D | null | undefined;
function measureTagText(text: string): number {
  const known = TAG_WIDTHS.get(text);
  if (known !== undefined) return known;
  if (tagContext === undefined) {
    tagContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    if (tagContext) tagContext.font = `${TAG_FONT_PX}px system-ui, sans-serif`;
  }
  const width = tagContext ? tagContext.measureText(text).width : estimateTagTextPx(text);
  if (TAG_WIDTHS.size > 5000) TAG_WIDTHS.clear();
  TAG_WIDTHS.set(text, width);
  return width;
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
  walls?: readonly AutoDuctWall[];
  /** Room outlines (air systems place terminals without a room id by them). */
  rooms?: ReadonlyArray<Pick<Room, 'id' | 'vertices'>>;
  /** Show the units' air collars (duct tool active). */
  showPorts: boolean;
  /** Selected runs can be dragged (select tool). */
  moveEnabled?: boolean;
  /** A press on a selected run starts a move of the selection (or of the pinned straight); false: it did not. */
  onBeginMove?: (request: HvacMoveBegin) => boolean;
  /** Commit an in-place edit of one run (a leg, its end or a riser dragged). */
  onEditCommit?: (elementId: string, result: DuctEditResult, action: string) => void;
  /** Runs drawn faded: a turned unit's ducts while they are designed. */
  fadedRunIds?: readonly string[];
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
/** How far round a pinned straight's resize grips its card keeps clear (px). */
const GRIP_CLEARANCE_PX = 18;
/** A run that waits for a turn's release, or is being designed, is drawn this faint. */
const FADED_RUN_OPACITY = 0.28;

export const DuctOverlay = forwardRef<DuctOverlayHandle, DuctOverlayProps>(function DuctOverlay(props, ref) {
  const { enabled, width, height, viewportZoom, panOffset, hvacElements, selectedIds, settings, showPorts, moveEnabled, onBeginMove, onEditCommit, fadedRunIds } = props;
  const gRef = useRef<SVGGElement | null>(null);
  const draftRef = useRef<SVGGElement | null>(null);
  const portsRef = useRef<SVGGElement | null>(null);
  const targetRef = useRef<SVGGElement | null>(null);
  /** Committed runs only — the draft layer draws the re-planned parent with the same run id. */
  const runsRef = useRef<SVGGElement | null>(null);
  /** Committed runs the draft re-draws (a branch's parent, or runs being moved), hidden meanwhile. */
  const hiddenRunsRef = useRef<ReadonlySet<string>>(new Set());
  /** Committed runs drawn faded: a turned unit's ducts, waiting for the release (a move preview), then being designed (the prop). */
  const fadedPreviewRef = useRef<ReadonlySet<string>>(new Set());
  const fadedPropRef = useRef<readonly string[]>([]);
  fadedPropRef.current = fadedRunIds ?? [];
  /** The air terminals' layer, and the terminals a move preview re-draws (hidden meanwhile). */
  const terminalsRef = useRef<SVGGElement | null>(null);
  const hiddenTerminalsRef = useRef<ReadonlySet<string>>(new Set());
  /** A move just stored: its preview stays drawn until the stored runs re-render. */
  const heldMoveRef = useRef<readonly HvacElement[] | null>(null);
  /** The segment focus outlines (painted imperatively from the segment store). */
  const segmentRef = useRef<SVGGElement | null>(null);
  /** A segment option shown before it is applied: the runs it changes, drawn as they would be (dashed). */
  const optionPreviewRef = useRef<SVGGElement | null>(null);
  const previewHiddenRef = useRef<ReadonlySet<string>>(new Set());
  const editRef = useRef<{ handle: DuctEditHandle; elementId: string; start: Point2D; result: DuctEditResult | null } | null>(null);
  /** The pinned segment: its straight's own resize grips take the place of the move and end handles there. */
  const pinnedFocus = useDuctSegmentUiStore((state) => state.pinned);
  const liveViewportRef = useRef<FabricViewportMatrix | null>(null);
  const hoveredPortRef = useRef<string | null>(null);

  const view = getCanvasTransform(viewportZoom, panOffset);
  const k = MM_TO_PX * view.zoom;
  const kRef = useRef(k);
  kRef.current = k;
  const sceneRef = useRef({ hvacElements, settings });
  sceneRef.current = { hvacElements, settings };
  /** The plan's tag layout as drawn now (set each render): what a transient preview lays its own tags out around. */
  const tagLayoutRef = useRef<{ placed: PlacedDuctTag[]; obstacles: TagObstacle[] } | null>(null);
  /**
   * The size tags of runs drawn for a moment over their hidden selves (a drag,
   * an edit, an option, a branch draft): laid out by the same rules, around
   * everything else on the plan.
   */
  const transientTags = useCallback((presentations: ReadonlyArray<{ presentation: DuctPlanPresentation; selected: boolean }>, hidden: ReadonlySet<string>): string => {
    const layout = tagLayoutRef.current;
    if (!layout) return '';
    const k = kRef.current;
    const style = markupStyle(k, sceneRef.current.settings);
    const obstacles: TagObstacle[] = [
      ...layout.obstacles.filter((obstacle) => !obstacle.runId || !hidden.has(obstacle.runId)),
      ...layout.placed.filter((tag) => !hidden.has(tag.runId)).map((tag) => tag.box),
      ...presentations.flatMap(({ presentation }) => ductRunTagObstacles(presentation, style, measureTagText)),
    ];
    const sources: DuctTagSource[] = presentations.map(({ presentation, selected }) => ({
      runId: presentation.id, service: presentation.service, status: presentation.status, selected, tags: presentation.tags,
    }));
    return placedDuctTagMarkup(layoutDuctTags(sources, k, { measure: measureTagText, obstacles }), k);
  }, []);

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
    root.querySelectorAll<SVGGElement>('[data-duct-run], [data-duct-supports], [data-duct-tags]').forEach((node) => {
      const id = node.getAttribute('data-duct-run') ?? node.getAttribute('data-duct-supports') ?? node.getAttribute('data-duct-tags') ?? '';
      const hide = hiddenRunsRef.current.has(id) || previewHiddenRef.current.has(id);
      if ((node.style.display === 'none') !== hide) node.style.display = hide ? 'none' : '';
    });
  }, []);

  const applyFadedRuns = useCallback(() => {
    const root = runsRef.current;
    if (!root) return;
    const faded = new Set([...fadedPreviewRef.current, ...fadedPropRef.current]);
    root.querySelectorAll<SVGGElement>('[data-duct-run], [data-duct-supports], [data-duct-tags]').forEach((node) => {
      const id = node.getAttribute('data-duct-run') ?? node.getAttribute('data-duct-supports') ?? node.getAttribute('data-duct-tags') ?? '';
      const opacity = faded.has(id) ? String(FADED_RUN_OPACITY) : '';
      if (node.style.opacity === opacity) return;
      node.style.transition = 'opacity 160ms ease-out';
      node.style.opacity = opacity;
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
    // The run being drawn shows its full tags (as a selected run does), laid out with the rest.
    const drawn = { presentation: buildDuctPlanPresentation(plan), selected: true };
    let markup = ductRunMarkup(drawn.presentation, {
      k: kRef.current, draft: true, showTags: true, sectionTags: false, showJointTicks: true, showMarks: false,
    });
    const tagged = [drawn];
    const parentId = ductParentRunId(spec);
    const parent = parentId ? scene.find((element) => element.id === parentId) : undefined;
    const parentSpec = parent ? readDuctRunSpec(parent) : null;
    if (parent && parentSpec) {
      const parentPresentation = buildDuctPlanPresentation(planDuctRunSpec(parent.id, parentSpec, { settings: current, scene }));
      markup = ductRunMarkup(parentPresentation, { ...markupStyle(kRef.current, current), sectionTags: false }) + markup;
      tagged.push({ presentation: parentPresentation, selected: false });
    }
    // Hide the committed drawings the draft re-draws: the parent, and the run itself when it is being extended.
    const hidden = [...(parent ? [parent.id] : []), ...(stored.some((element) => element.id === draft.element.id) ? [draft.element.id] : [])];
    if (hidden.join() !== [...hiddenRunsRef.current].join()) {
      hiddenRunsRef.current = new Set(hidden);
      applyHiddenRun();
    }
    target.innerHTML = markup + transientTags(tagged, new Set(hidden))
      + (draft.label ? draftLabelMarkup(draft.label.point, draft.label.text, kRef.current) : '');
  }, [applyHiddenRun, transientTags]);

  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  /**
   * The piece of a selected run under a plan point: the one whose outline is
   * nearest (inside = 0), within a few pixels. Geometric, so a short collar
   * beside a long section is found even where their hit strokes overlap.
   */
  const pieceAt = useCallback((point: Point2D): { runId: string; mark: string } | null => {
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const tolerance = 6 / Math.max(kRef.current, 1e-6);
    let best: { runId: string; mark: string; distance: number } | null = null;
    for (const id of selectedIdsRef.current) {
      const element = stored.find((candidate) => candidate.id === id);
      if (!element || !isDuctElement(element)) continue;
      const plan = getDuctRunPlan(element, stored, current);
      if (!plan) continue;
      for (const piece of getDuctPlanPresentation(plan).piecePolygons) {
        const distance = distanceToPolygon(point, piece.polygon);
        if (distance <= tolerance && (!best || distance < best.distance)) best = { runId: id, mark: piece.mark, distance };
      }
    }
    return best ? { runId: best.runId, mark: best.mark } : null;
  }, []);

  // ---- Drag the selected runs (select tool). ----
  const toWorld = useCallback((clientX: number, clientY: number): Point2D | null => {
    const matrix = gRef.current?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const focusOfPiece = useCallback((runId: string, mark: string): DuctSegmentFocus | null => {
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const element = stored.find((candidate) => candidate.id === runId);
    const plan = element ? getDuctRunPlan(element, stored, current) : null;
    const segment = plan ? ductSegmentOfMark(plan, mark) : null;
    return segment ? { runId, key: segment.key, anchorMark: mark, view: '2d' } : null;
  }, []);

  const applyHiddenTerminals = useCallback(() => {
    terminalsRef.current?.querySelectorAll<SVGGElement>('[data-duct-terminal]').forEach((node) => {
      const hide = hiddenTerminalsRef.current.has(node.getAttribute('data-duct-terminal') ?? '');
      if ((node.style.display === 'none') !== hide) node.style.display = hide ? 'none' : '';
    });
  }, []);

  const clearMovePreview = useCallback(() => {
    heldMoveRef.current = null;
    if (draftRef.current) draftRef.current.innerHTML = '';
    hiddenRunsRef.current = new Set();
    hiddenTerminalsRef.current = new Set();
    fadedPreviewRef.current = new Set();
    applyHiddenRun();
    applyHiddenTerminals();
    applyFadedRuns();
  }, [applyHiddenRun, applyHiddenTerminals, applyFadedRuns]);

  const previewMove = useCallback((elements: readonly HvacElement[] | null, options: { committed?: boolean; faded?: readonly string[] } = {}) => {
    const target = draftRef.current;
    if (!target) return;
    if (!elements) {
      // Just stored: hold the drawing (and the faded runs) until the stored runs re-render (else the old ones flash back
      // for a frame).
      if (options.committed && (target.innerHTML || fadedPreviewRef.current.size)) heldMoveRef.current = sceneRef.current.hvacElements;
      else clearMovePreview();
      return;
    }
    heldMoveRef.current = null;
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const replaced = new Map(elements.map((element) => [element.id, element]));
    const scene = stored.map((element) => replaced.get(element.id) ?? element);
    const selected = new Set(selectedIdsRef.current);
    const moved = elements.filter(isDuctElement).flatMap((element) => {
      const plan = getDuctRunPlan(element, scene, current);
      return plan ? [{ presentation: buildDuctPlanPresentation(plan), selected: selected.has(element.id) }] : [];
    });
    const terminals = elements.flatMap((element) => {
      const spec = isDuctTerminalElement(element) ? readDuctTerminalSpec(element) : null;
      return spec ? [{ element, spec }] : [];
    });
    const style = markupStyle(kRef.current, current);
    const hidden = new Set(moved.map(({ presentation }) => presentation.id));
    target.innerHTML = terminals.map(({ element, spec }) => airTerminalMarkup(element, spec, kRef.current, style.showTags)).join('')
      + moved.map(({ presentation, selected: isSelected }) => ductRunMarkup(presentation, { ...style, sectionTags: false, selected: isSelected })).join('')
      + transientTags(moved, hidden);
    hiddenRunsRef.current = hidden;
    hiddenTerminalsRef.current = new Set(terminals.map(({ element }) => element.id));
    fadedPreviewRef.current = new Set(options.faded ?? []);
    applyHiddenRun();
    applyHiddenTerminals();
    applyFadedRuns();
  }, [applyHiddenRun, applyHiddenTerminals, applyFadedRuns, clearMovePreview, transientTags]);

  /** A press on a selected run: the move session takes it (a drag moves the selection, or the pinned straight; a click pins the piece). */
  const onHitPointerDown = useCallback((event: ReactPointerEvent<SVGPathElement>) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || !onBeginMove) return;
    const start = toWorld(event.clientX, event.clientY);
    if (!start) return;
    const hitRun = event.currentTarget.getAttribute('data-duct-hit');
    const piece = pieceAt(start) ?? (hitRun ? { runId: hitRun, mark: event.currentTarget.getAttribute('data-duct-mark') ?? '' } : null);
    if (!piece) return;
    const focus = focusOfPiece(piece.runId, piece.mark);
    // The pinned straight under the press moves on its own; elsewhere the selection moves.
    const pinned = useDuctSegmentUiStore.getState().pinned;
    const straight = focus && pinned && domainOf(pinned) === 'duct' && pinned.runId === focus.runId && pinned.key === focus.key
      ? /^leg:(\d+)$/.exec(focus.key) : null;
    const begun = onBeginMove({
      pressedId: piece.runId, clientX: event.clientX, clientY: event.clientY,
      segment: straight ? { runId: piece.runId, legIndex: Number(straight[1]) } : null,
      onClick: () => { if (focus) useDuctSegmentUiStore.getState().pin(focus); },
    });
    if (!begun) return;
    event.stopPropagation();
    event.preventDefault();
    useDuctSegmentUiStore.getState().setHovered(null);
  }, [onBeginMove, toWorld, pieceAt, focusOfPiece]);

  // ---- Segments of the selected runs: hover shows a segment's card, a click pins it. ----

  const onHitPointerOver = useCallback((event: ReactPointerEvent<SVGPathElement>) => {
    if (event.buttons !== 0) return;
    const at = toWorld(event.clientX, event.clientY);
    const piece = at ? pieceAt(at) : null;
    useDuctSegmentUiStore.getState().setHovered(piece ? focusOfPiece(piece.runId, piece.mark) : null);
  }, [focusOfPiece, toWorld, pieceAt]);

  const onHitPointerOut = useCallback(() => {
    useDuctSegmentUiStore.getState().setHovered(null);
  }, []);

  // ---- Edit handles on the one selected run: legs sideways, the end along, risers along. ----
  const renderEditPreview = useCallback((elements: HvacElement[], selectedId: string) => {
    const target = draftRef.current;
    if (!target) return;
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const replaced = new Map(elements.map((element) => [element.id, element]));
    const scene = stored.map((element) => replaced.get(element.id) ?? element);
    const edited = elements.flatMap((element) => {
      const plan = getDuctRunPlan(element, scene, current);
      return plan ? [{ presentation: buildDuctPlanPresentation(plan), selected: element.id === selectedId }] : [];
    });
    const hidden = new Set(elements.map((element) => element.id));
    target.innerHTML = edited.map(({ presentation, selected }) => ductRunMarkup(presentation, { ...markupStyle(kRef.current, current), sectionTags: false, selected })).join('')
      + transientTags(edited, hidden);
    hiddenRunsRef.current = hidden;
    applyHiddenRun();
  }, [applyHiddenRun, transientTags]);

  const onHandlePointerDown = useCallback((event: ReactPointerEvent<SVGElement>, handle: DuctEditHandle, elementId: string) => {
    if (event.button !== 0) return;
    const start = toWorld(event.clientX, event.clientY);
    if (!start) return;
    // A leg's or riser's handle moves that straight through the move session: its neighbours stretch, branches
    // follow elastically (their runouts stay on their terminals), with the readout and one undo step.
    if (handle.kind !== 'end' && onBeginMove?.({
      pressedId: elementId, clientX: event.clientX, clientY: event.clientY, segment: { runId: elementId, legIndex: handle.legIndex },
    })) {
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    editRef.current = { handle, elementId, start, result: null };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }, [toWorld, onBeginMove]);

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

  /** A run's plan as drawn now. */
  const planOf = useCallback((runId: string) => {
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const element = stored.find((candidate) => candidate.id === runId);
    return element ? getDuctRunPlan(element, stored, current) : null;
  }, []);

  const segmentClientRect = useCallback((runId: string, key: string, anchorMark: string | null): ScreenRect | null => {
    const matrix = gRef.current?.getScreenCTM();
    const plan = planOf(runId);
    if (!matrix || !plan) return null;
    const anchor = anchorMark ? getDuctPlanPresentation(plan).piecePolygons.filter((piece) => piece.mark === anchorMark).map((piece) => piece.polygon) : [];
    const polygons = anchor.length ? anchor : segmentOutlines(plan, key);
    const points = polygons.flat();
    if (points.length === 0) return null;
    const client = points.map((point) => new DOMPoint(point.x, point.y).matrixTransform(matrix));
    // A straight's resize grips sit on its corner vertices and on its sides: its card (not its chip) keeps clear of them.
    let avoid: ScreenRect['avoid'];
    const leg = /^leg:(\d+)$/.exec(key);
    if (leg || key === 'end:flex') {
      const index = leg ? Number(leg[1]) : plan.spec.path.length - 2;
      const around = [plan.spec.path[index], plan.spec.path[index + 1]].filter((vertex): vertex is NonNullable<typeof vertex> => Boolean(vertex))
        .map((vertex) => new DOMPoint(vertex.x, vertex.y).matrixTransform(matrix));
      const xs = [...client, ...around].map((point) => point.x);
      const ys = [...client, ...around].map((point) => point.y);
      avoid = {
        left: Math.min(...xs) - GRIP_CLEARANCE_PX, top: Math.min(...ys) - GRIP_CLEARANCE_PX,
        right: Math.max(...xs) + GRIP_CLEARANCE_PX, bottom: Math.max(...ys) + GRIP_CLEARANCE_PX,
      };
    }
    // The leader line ends on the piece itself (a point inside its outline).
    const inside = polygons.map((polygon) => polygonHotspot(polygon)).find((point): point is Point2D => point !== null);
    const pin = inside ? new DOMPoint(inside.x, inside.y).matrixTransform(matrix) : null;
    return {
      left: Math.min(...client.map((point) => point.x)), right: Math.max(...client.map((point) => point.x)),
      top: Math.min(...client.map((point) => point.y)), bottom: Math.max(...client.map((point) => point.y)),
      ...(pin ? { pinX: pin.x, pinY: pin.y } : {}),
      ...(avoid ? { avoid } : {}),
    };
  }, [planOf]);

  /** Draw the option being previewed: the runs it changes as they would be, the committed ones hidden meanwhile. */
  const paintOptionPreview = useCallback(() => {
    const target = optionPreviewRef.current;
    if (!target) return;
    const { preview } = useDuctSegmentUiStore.getState();
    const { hvacElements: stored, settings: current } = sceneRef.current;
    const ducts = preview && domainOf(preview) === 'duct' ? preview.updates.filter(isDuctElement) : [];
    const ids = new Set(ducts.map((element) => element.id));
    let markup = '';
    if (ducts.length) {
      const replaced = new Map(preview!.updates.map((element) => [element.id, element]));
      const scene = stored.map((element) => replaced.get(element.id) ?? element);
      const pinnedRun = useDuctSegmentUiStore.getState().pinned?.runId;
      const previewed = ducts.flatMap((element) => {
        const plan = getDuctRunPlan(element, scene, current);
        return plan ? [{ presentation: buildDuctPlanPresentation(plan), selected: element.id === pinnedRun }] : [];
      });
      markup = previewed.map(({ presentation, selected }) => ductRunMarkup(presentation, { ...markupStyle(kRef.current, current), draft: true, sectionTags: false, selected })).join('')
        + transientTags(previewed, ids);
    }
    if (target.innerHTML !== markup) target.innerHTML = markup;
    if ([...ids].join() !== [...previewHiddenRef.current].join()) {
      previewHiddenRef.current = ids;
      applyHiddenRun();
    }
  }, [applyHiddenRun, transientTags]);

  /** Outline the segment under the pointer and the pinned one (from the segment store; no React render). */
  const paintSegments = useCallback(() => {
    const target = segmentRef.current;
    if (!target) return;
    paintOptionPreview();
    const state = useDuctSegmentUiStore.getState();
    // Only a duct's segments are outlined here (another service's pieces are drawn by their own overlay).
    const hovered = domainOf(state.hovered) === 'duct' ? state.hovered : null;
    const pinned = domainOf(state.pinned) === 'duct' ? state.pinned : null;
    if (state.preview && domainOf(state.preview) === 'duct') {
      // While an option is previewed the drawing shows it, not the outline of what it replaces.
      if (target.innerHTML) target.innerHTML = '';
      return;
    }
    const outlinesOf = (focus: DuctSegmentFocus) => {
      const plan = planOf(focus.runId);
      return plan ? segmentOutlines(plan, focus.key) : [];
    };
    const endsOf = (focus: DuctSegmentFocus) => {
      const plan = planOf(focus.runId);
      return plan ? segmentEnds(plan, focus.key) : [];
    };
    const samePinned = hovered && pinned && hovered.runId === pinned.runId && hovered.key === pinned.key;
    const markup = (pinned ? segmentFocusMarkup(outlinesOf(pinned), 'pinned', endsOf(pinned), kRef.current) : '')
      + (hovered && !samePinned ? segmentFocusMarkup(outlinesOf(hovered), 'hovered') : '');
    if (target.innerHTML !== markup) target.innerHTML = markup;
  }, [planOf, paintOptionPreview]);
  useEffect(() => useDuctSegmentUiStore.subscribe(paintSegments), [paintSegments]);

  useImperativeHandle(ref, () => ({ syncViewTransform, setDraft, setHoveredPort, setBranchTarget, segmentClientRect, previewMove }),
    [syncViewTransform, setDraft, setHoveredPort, setBranchTarget, segmentClientRect, previewMove]);

  useLayoutEffect(() => {
    // A stored move re-rendered: its preview goes (the runs it drew are the stored ones now).
    if (heldMoveRef.current && heldMoveRef.current !== hvacElements) clearMovePreview();
    if (liveViewportRef.current) syncViewTransform(liveViewportRef.current);
    paintPorts();
    applyHiddenRun();
    applyHiddenTerminals();
    applyFadedRuns();
    paintSegments();
  });

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Air systems: the selected units' systems, and those of the selected terminals, are in focus.
  const rooms = props.rooms ?? NO_ROOMS;
  // The walls the runs pass through: a moved wall re-plans their sleeves and fire dampers.
  const building = useDuctBuilding();
  const airSystems = useMemo(() => analyseAirSystems(hvacElements, rooms), [hvacElements, rooms]);
  const focusUnitIds = useMemo(() => {
    const focus = new Set<string>();
    for (const element of hvacElements) {
      if (!selectedSet.has(element.id)) continue;
      if (isAirSystemUnit(element)) focus.add(element.id);
      const unitId = airSystems.byTerminal.get(element.id)?.unitId;
      if (unitId) focus.add(unitId);
    }
    return focus;
  }, [hvacElements, selectedSet, airSystems]);
  // Auto duct preview: the proposed runs, dashed, over the drawing they were generated from (hiding the runs they replace).
  const cardPreview = useDuctAutoPreviewStore((state) => (isAutoDuctPreviewCurrent(state, hvacElements, settings, props.walls) ? state.result : null));
  // The unified Auto route's duct proposal previews the same way.
  const routePreview = useCondensatePreviewStore((state) => state.unified?.ducts ?? null);
  const autoPreview = useMemo(() => {
    const runs = [...(cardPreview?.runs ?? []), ...(routePreview?.elementsToAdd ?? [])];
    const removeIds = [...(cardPreview?.removeIds ?? []), ...(routePreview?.removeElementIds ?? [])];
    // Terminals whose spigot the design turns show turned while the preview is open.
    const turned = [...(cardPreview?.terminalUpdates ?? []), ...(routePreview?.terminalUpdates ?? [])];
    return runs.length || removeIds.length || turned.length ? { runs, removeIds, turned } : null;
  }, [cardPreview, routePreview]);
  const terminals = useMemo(() => {
    const turned = new Map((autoPreview?.turned ?? []).map((element) => [element.id, element]));
    return hvacElements.flatMap((original) => {
      const element = turned.get(original.id) ?? original;
      const spec = isDuctTerminalElement(element) ? readDuctTerminalSpec(element) : null;
      return spec ? [{ element, spec }] : [];
    });
  }, [hvacElements, autoPreview]);
  const replacedIds = useMemo(() => new Set(autoPreview?.removeIds ?? []), [autoPreview]);
  // The proposal's runs, planned over the drawing they were generated from (once per proposal, not per zoom).
  const previewPresentations = useMemo(() => {
    if (!autoPreview?.runs.length) return [];
    const turned = new Map(autoPreview.turned.map((element) => [element.id, element]));
    const scene = [...hvacElements.filter((element) => !replacedIds.has(element.id)).map((element) => turned.get(element.id) ?? element), ...autoPreview.runs];
    return autoPreview.runs.flatMap((run) => {
      const spec = readDuctRunSpec(run);
      return spec ? [buildDuctPlanPresentation(planDuctRunSpec(run.id, spec, { settings, scene, building }))] : [];
    });
  }, [autoPreview, hvacElements, replacedIds, settings, building]);
  // Drawn as the committed runs are (their other labels where tags show), the size tags by the layout.
  const previewMarkup = useMemo(() => previewPresentations.map((presentation) => ductRunMarkup(presentation, {
    k, draft: true, showTags: markupStyle(k, settings).showTags, sectionTags: false, showJointTicks: true, showMarks: false,
  })).join(''), [previewPresentations, k, settings]);
  // Terminals the Auto route panel proposes for a unit short of them: dashed, until they are added or put away.
  const proposal = useTerminalProposalStore((state) => state.proposal);
  const proposalMarkup = useMemo(() => (proposal?.add ?? []).flatMap((element) => {
    const spec = readDuctTerminalSpec(element);
    return spec ? [airTerminalMarkup(element, spec, k, markupStyle(k, settings).showTags)] : [];
  }).join(''), [proposal, k, settings]);
  const runs = useMemo(() => hvacElements
    .filter(isDuctElement)
    .map((element) => getDuctRunPlan(element, hvacElements, settings))
    // (The plans read the active building, which `building` tracks.)
    .filter((plan): plan is NonNullable<typeof plan> => plan !== null), [hvacElements, settings, building]);
  // Every run's size tags, laid out together (ductTagLayout.ts): the size alone when zoomed out, the full tag zoomed in
  // and on the selected runs; none over another tag, a duct, a unit, a terminal (and its tag) or another label, none
  // longer than its own straight.
  const tagLayout = useMemo(() => {
    if (!settings.showSizeTags) return null;
    const style = markupStyle(k, settings);
    const drawn = [
      ...runs.filter((plan) => !replacedIds.has(plan.elementId)).map((plan) => ({ presentation: getDuctPlanPresentation(plan), selected: selectedSet.has(plan.elementId), draft: false })),
      ...previewPresentations.map((presentation) => ({ presentation, selected: false, draft: true })),
    ];
    const obstacles: TagObstacle[] = [
      ...hvacElements.filter(isAirSystemUnit).map((unit) => equipmentTagObstacle(unit)),
      ...terminals.flatMap(({ element, spec }) => airTerminalTagObstacles(element, spec, k, style.showTags, measureTagText)),
      ...drawn.flatMap(({ presentation }) => ductRunTagObstacles(presentation, style, measureTagText)),
    ];
    const sources: DuctTagSource[] = drawn.map(({ presentation, selected, draft }) => ({
      runId: presentation.id, service: presentation.service, status: presentation.status, selected, draft, tags: presentation.tags,
    }));
    return { placed: layoutDuctTags(sources, k, { measure: measureTagText, obstacles }), obstacles };
  }, [settings, k, hvacElements, terminals, runs, replacedIds, selectedSet, previewPresentations]);
  tagLayoutRef.current = tagLayout;
  const tagMarkup = useMemo(() => (tagLayout ? {
    committed: placedDuctTagMarkup(tagLayout.placed.filter((tag) => !tag.draft), k),
    preview: placedDuctTagMarkup(tagLayout.placed.filter((tag) => tag.draft), k),
  } : { committed: '', preview: '' }), [tagLayout, k]);
  const hitAreas = useMemo(() => (moveEnabled ? runs.filter((plan) => selectedSet.has(plan.elementId)) : [])
    .flatMap((plan) => getDuctPlanPresentation(plan).piecePolygons.map((piece) => ({ runId: plan.elementId, mark: piece.mark, polygon: piece.polygon }))),
  [moveEnabled, runs, selectedSet]);
  // A segment under the pointer belongs to a selected run, in the plan's select tool.
  useEffect(() => {
    const { hovered } = useDuctSegmentUiStore.getState();
    if (hovered?.view === '2d' && domainOf(hovered) === 'duct' && (!moveEnabled || !selectedSet.has(hovered.runId))) useDuctSegmentUiStore.getState().setHovered(null);
  }, [moveEnabled, selectedSet]);
  // Handles on the run when it alone is selected (legs that start on a collar or parent wall stay put).
  const editTarget = useMemo(() => {
    if (!moveEnabled || !onEditCommit) return null;
    const selectedRuns = runs.filter((plan) => selectedSet.has(plan.elementId));
    const plan = selectedRuns.length === 1 && selectedIds.length === 1 ? selectedRuns[0]! : null;
    if (!plan || plan.spec.legacy || plan.spec.locked) return null;
    const legs = ductLegs(plan.spec);
    const anchored = plan.spec.start.kind !== 'open';
    const handles: DuctEditHandle[] = [];
    const pinnedKey = pinnedFocus && pinnedFocus.view === '2d' && domainOf(pinnedFocus) === 'duct' && pinnedFocus.runId === plan.elementId ? pinnedFocus.key : null;
    legs.forEach((leg, index) => {
      if (leg.vertical) {
        if (!legs[index - 1]?.vertical) handles.push({ kind: 'riser', legIndex: index, point: { x: leg.start.x, y: leg.start.y }, axis: leg.direction });
        return;
      }
      if (leg.sloped || leg.lengthMm < 200 || (index === 0 && anchored) || pinnedKey === `leg:${index}`) return;
      handles.push({ kind: 'leg', legIndex: index, point: { x: (leg.start.x + leg.end.x) / 2, y: (leg.start.y + leg.end.y) / 2 }, axis: { x: -leg.direction.y, y: leg.direction.x } });
    });
    const last = legs[legs.length - 1];
    if (last && !last.vertical && plan.spec.end.kind !== 'split' && pinnedKey !== `leg:${legs.length - 1}`) {
      handles.push({ kind: 'end', legIndex: legs.length - 1, point: { x: last.end.x, y: last.end.y }, axis: last.direction });
    }
    return { elementId: plan.elementId, handles };
  }, [moveEnabled, onEditCommit, pinnedFocus, runs, selectedIds.length, selectedSet]);

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
            ref={terminalsRef}
            data-testid="duct-terminals"
            dangerouslySetInnerHTML={{ __html: terminals.map(({ element, spec }) => airTerminalMarkup(element, spec, k, style.showTags)).join('') }}
          />
          {proposalMarkup ? <g data-testid="duct-terminal-proposal" opacity={0.7} style={{ strokeDasharray: '5 3' }} dangerouslySetInnerHTML={{ __html: proposalMarkup }} /> : null}
          <g ref={runsRef}>
            {runs.filter((plan) => !replacedIds.has(plan.elementId)).map((plan) => (
              <g
                key={plan.elementId}
                dangerouslySetInnerHTML={{
                  __html: ductRunMarkup(getDuctPlanPresentation(plan), { ...style, sectionTags: false, selected: selectedSet.has(plan.elementId) })
                    + (style.showSupports ? ductSupportMarkup(getDuctSupportPlan(plan, hvacElements, settings), k) : ''),
                }}
              />
            ))}
            <g data-testid="duct-tags" dangerouslySetInnerHTML={{ __html: tagMarkup.committed }} />
          </g>
          <AirSystemLayer analysis={airSystems} hvacElements={hvacElements} k={k} focusUnitIds={focusUnitIds}
            showAll={settings.showAirSystems} showTags={style.showTags} />
          <g data-testid="duct-auto-preview" dangerouslySetInnerHTML={{ __html: previewMarkup + tagMarkup.preview }} />
          <g ref={optionPreviewRef} data-testid="duct-option-preview" style={{ pointerEvents: 'none' }} />
          <g ref={segmentRef} data-testid="duct-segment-focus" style={{ pointerEvents: 'none' }} />
          <g ref={portsRef} data-testid="duct-ports" />
          <g ref={targetRef} data-testid="duct-branch-target" />
          <g ref={draftRef} data-testid="duct-draft" />
          {hitAreas.length > 0 ? (
            <g data-testid="duct-move-handles">
              {hitAreas.map((hit, index) => (
                <path
                  key={`${hit.runId}|${hit.mark}|${index}`}
                  d={`M${hit.polygon.map((point) => `${point.x} ${point.y}`).join(' L')} Z`}
                  fill="transparent"
                  stroke="transparent"
                  strokeWidth={8}
                  vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: 'all', cursor: 'move' }}
                  data-duct-hit={hit.runId}
                  data-duct-mark={hit.mark}
                  onPointerDown={onHitPointerDown}
                  onPointerOver={onHitPointerOver}
                  onPointerMove={onHitPointerOver}
                  onPointerOut={onHitPointerOut}
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
