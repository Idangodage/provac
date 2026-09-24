'use client';

/**
 * Direct manipulation of a selected condensate drain run in the plan.
 *
 *  - bend dots: drag to move a bend · right-click or Delete to remove it
 *  - leg pills: drag a straight leg sideways
 *  - the run body: drag to move the whole run (its ends stay attached)
 *  - double-click the run: add a bend there
 *  - riser foot (diamond): drag within reach of the unit's outlet
 *  - wye (diamond at a branch end): slide it along its main
 *
 * Every frame of a drag re-solves the whole network (fall, risers, 45°
 * offsets, wyes, sizes, fittings) and shows it live with a verdict chip; the
 * release commits one undo step, Esc cancels. Shift disables snapping.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import type { HvacElement, Point2D } from '../../../../types';

import { commitCondensateEdit, condensateEditContext, deleteDrainNetwork, editRunFittings, runCondensateEdit } from './condensateEditController';
import { createCondensateEditSession, isUnitBranchSpec, type CondensateEditResult, type CondensateEditSession, type CondensateFittingEdit } from './condensateEditing';
import { closestOnSegment, distance } from './condensateGeometry';
import { Tag, pathData } from './condensatePlanGlyphs';
import {
  fixedPrefixLength,
  insertRouteVertex,
  moveRiserFoot,
  moveRouteVertex,
  offsetRouteLeg,
  reendRoute,
  removeRouteVertex,
  snapPlanPoint,
  translateRouteInterior,
  type PlanRoute,
  type PlanSnap,
} from './condensateRouteOps';
import type { CondensateDesignSettings } from './condensateSettings';
import { getCondensateOwnership, isCondensatePipe, readCondensatePipeSpec } from './condensateTypes';

type DragKind = 'bend' | 'leg' | 'body' | 'foot' | 'wye';

interface DragState {
  kind: DragKind;
  pipeId: string;
  index: number;
  startWorld: Point2D;
  pointerId: number;
}

export interface CondensateEditPreview {
  result: CondensateEditResult | null;
  cursor: Point2D;
  guides: PlanSnap['guides'];
  /** Working plan routes (what the handles follow). */
  routes: Map<string, PlanRoute>;
  pipeId: string;
  kind: DragKind;
  index: number;
}

/** A branch's wye can slide along its main when the main continues past it. */
export interface WyeSlide {
  throughId: string;
  downstreamId: string;
  line: [Point2D, Point2D];
}

const SNAP_PX = 8;
const WYE_END_MARGIN_MM = 150;

function wyeSlideFor(pipe: HvacElement, network: readonly HvacElement[], routes: ReadonlyMap<string, PlanRoute>): WyeSlide | null {
  const spec = readCondensatePipeSpec(pipe);
  const nodeId = spec.drainEnd?.kind === 'junction' ? spec.drainEnd.nodeId : undefined;
  if (!nodeId || !spec.fittings.some((fitting) => fitting.kind === 'wye')) return null;
  const through = network.find((candidate) => candidate.id !== pipe.id && readCondensatePipeSpec(candidate).drainEnd?.nodeId === nodeId);
  const downstream = network.find((candidate) => readCondensatePipeSpec(candidate).drainStart?.nodeId === nodeId);
  if (!through || !downstream) return null;
  const role = readCondensatePipeSpec(downstream).segmentRole;
  if (role === 'drop' || role === 'terminal') return null;
  const t = routes.get(through.id) ?? [];
  const d = routes.get(downstream.id) ?? [];
  if (t.length < 2 || d.length < 2) return null;
  return { throughId: through.id, downstreamId: downstream.id, line: [t[t.length - 2]!, d[1]!] };
}

export function useCondensateEditing(options: {
  enabled: boolean;
  pipe: HvacElement | null;
  hvacElements: HvacElement[];
  selectedIds: readonly string[];
  settings: CondensateDesignSettings;
  gRef: RefObject<SVGGElement | null>;
  hpx: (n: number) => number;
  onPreviewChange?: (elements: HvacElement[] | null, removeIds: string[]) => void;
}) {
  const { enabled, pipe, hvacElements, settings, gRef, hpx, onPreviewChange } = options;
  const sessionRef = useRef<{ key: string; elements: HvacElement[]; session: CondensateEditSession } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const latestRef = useRef<{ world: Point2D; shift: boolean } | null>(null);
  const frameRef = useRef<number | null>(null);
  const [preview, setPreview] = useState<CondensateEditPreview | null>(null);
  const previewRef = useRef<CondensateEditPreview | null>(null);
  const [hoverBend, setHoverBend] = useState<number | null>(null);
  const [hoverFoot, setHoverFoot] = useState(false);
  /** Rodding-eye placement: a click on the run adds one, a click on an eye removes it. */
  const [eyeMode, setEyeMode] = useState(false);
  useEffect(() => { setEyeMode(false); }, [pipe?.id]);
  const hpxRef = useRef(hpx);
  hpxRef.current = hpx;

  const networkId = pipe && isCondensatePipe(pipe) ? getCondensateOwnership(pipe)?.networkId ?? null : null;

  const session = useCallback((): CondensateEditSession | null => {
    if (!networkId) return null;
    const cached = sessionRef.current;
    if (cached && cached.key === networkId && cached.elements === hvacElements) return cached.session;
    const created = createCondensateEditSession([...hvacElements], networkId, condensateEditContext());
    sessionRef.current = created ? { key: networkId, elements: hvacElements, session: created } : null;
    return created;
  }, [networkId, hvacElements]);

  const model = useMemo(() => (enabled && networkId ? session()?.model ?? null : null), [enabled, networkId, session]);

  const publish = useCallback((next: CondensateEditPreview | null) => {
    previewRef.current = next;
    setPreview(next);
    if (!onPreviewChange) return;
    if (next?.result?.ok) onPreviewChange(next.result.elements, next.result.removeIds);
    else onPreviewChange(null, []);
  }, [onPreviewChange]);

  const toWorld = useCallback((clientX: number, clientY: number): Point2D | null => {
    const ctm = gRef.current?.getScreenCTM();
    if (!ctm) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  }, [gRef]);

  /** Working routes for a drag at `world`. */
  const routesFor = useCallback((drag: DragState, world: Point2D, shift: boolean): { routes: Map<string, PlanRoute>; guides: PlanSnap['guides'] } | null => {
    const current = session();
    if (!current) return null;
    const { model: m } = current;
    const route = m.routes.get(drag.pipeId);
    const spec = m.specs.get(drag.pipeId);
    if (!route || !spec) return null;
    const prefix = fixedPrefixLength(isUnitBranchSpec(spec));
    const tolerance = SNAP_PX * hpxRef.current(1);
    const targets: Point2D[] = [];
    for (const [id, other] of m.routes) {
      other.forEach((point, index) => { if (id !== drag.pipeId || index !== drag.index) targets.push(point); });
    }
    const snap = (raw: Point2D, neighbours: Point2D[]) => (shift ? { point: raw, guides: [] } : snapPlanPoint(raw, neighbours, targets, tolerance));
    const delta = { x: world.x - drag.startWorld.x, y: world.y - drag.startWorld.y };
    switch (drag.kind) {
      case 'bend': {
        const snapped = snap(world, [route[drag.index - 1]!, route[drag.index + 1]!]);
        return { routes: new Map([[drag.pipeId, moveRouteVertex(route, drag.index, snapped.point, prefix)]]), guides: snapped.guides };
      }
      case 'leg': {
        const a = route[drag.index]!;
        const b = route[drag.index + 1]!;
        const mid = { x: (a.x + b.x) / 2 + delta.x, y: (a.y + b.y) / 2 + delta.y };
        const snapped = snap(mid, []);
        const adjusted = { x: snapped.point.x - (a.x + b.x) / 2, y: snapped.point.y - (a.y + b.y) / 2 };
        return { routes: new Map([[drag.pipeId, offsetRouteLeg(route, drag.index, adjusted, prefix)]]), guides: snapped.guides };
      }
      case 'body':
        return { routes: new Map([[drag.pipeId, translateRouteInterior(route, delta, prefix)]]), guides: [] };
      case 'foot': {
        const snapped = snap(world, [route[0]!]);
        return { routes: new Map([[drag.pipeId, moveRiserFoot(route, snapped.point, settings.liftMaxHorizontalMm)]]), guides: snapped.guides };
      }
      case 'wye': {
        const branch = m.pipes.find((candidate) => candidate.id === drag.pipeId)!;
        const slide = wyeSlideFor(branch, m.pipes, m.routes);
        if (!slide) return null;
        const [p, q] = slide.line;
        const length = distance(p, q);
        if (length < 2 * WYE_END_MARGIN_MM) return null;
        const along = closestOnSegment(world, p, q).t * length;
        const t = Math.max(WYE_END_MARGIN_MM, Math.min(length - WYE_END_MARGIN_MM, along)) / length;
        const junction = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
        const oldJunction = route[route.length - 1]!;
        const shift2 = { x: junction.x - oldJunction.x, y: junction.y - oldJunction.y };
        const through = m.routes.get(slide.throughId)!;
        const downstream = m.routes.get(slide.downstreamId)!;
        const head = route.slice(0, -1);
        const leadIn = head[head.length - 1]!;
        const branchRoute = head.length > prefix
          ? [...reendRoute(head, { x: leadIn.x + shift2.x, y: leadIn.y + shift2.y }), junction]
          : [...head, junction];
        return {
          routes: new Map([
            [drag.pipeId, branchRoute],
            [slide.throughId, [...through.slice(0, -1), junction]],
            [slide.downstreamId, [junction, ...downstream.slice(1)]],
          ]),
          guides: [{ from: p, to: q }],
        };
      }
      default:
        return null;
    }
  }, [session, settings.liftMaxHorizontalMm]);

  const solveFrame = useCallback(() => {
    frameRef.current = null;
    const drag = dragRef.current;
    const latest = latestRef.current;
    if (!drag || !latest) return;
    const working = routesFor(drag, latest.world, latest.shift);
    const current = session();
    if (!working || !current) return;
    const result = current.solve({ routes: working.routes });
    publish({ result, cursor: latest.world, guides: working.guides, routes: working.routes, pipeId: drag.pipeId, kind: drag.kind, index: drag.index });
  }, [routesFor, session, publish]);

  const endDrag = useCallback((commit: boolean) => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    const drag = dragRef.current;
    dragRef.current = null;
    if (commit && drag && latestRef.current) {
      const moved = distance(latestRef.current.world, drag.startWorld) > hpxRef.current(2);
      if (moved) {
        solveFrame();
        const final = previewRef.current?.result;
        if (final) {
          const label = { bend: 'Move drain bend', leg: 'Move drain leg', body: 'Move drain run', foot: 'Move riser', wye: 'Slide drain wye' }[drag.kind];
          commitCondensateEdit(final, label, [drag.pipeId]);
        }
      }
    }
    latestRef.current = null;
    publish(null);
  }, [publish, solveFrame]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const world = toWorld(event.clientX, event.clientY);
      if (!world) return;
      latestRef.current = { world, shift: event.shiftKey };
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(solveFrame);
    };
    const onUp = (event: PointerEvent) => {
      if (dragRef.current && event.pointerId === dragRef.current.pointerId) endDrag(true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [toWorld, solveFrame, endDrag]);

  const removeBend = useCallback((index: number) => {
    const current = session();
    if (!current || !pipe) return;
    const route = current.model.routes.get(pipe.id);
    const spec = current.model.specs.get(pipe.id);
    if (!route || !spec) return;
    const next = removeRouteVertex(route, index, fixedPrefixLength(isUnitBranchSpec(spec)));
    if (next === route) return;
    commitCondensateEdit(current.solve({ routes: new Map([[pipe.id, next]]) }), 'Remove drain bend', [pipe.id]);
  }, [session, pipe]);

  // Esc cancels a drag; Delete removes the hovered bend, or deletes the selected run(s) smartly.
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'Escape' && dragRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        endDrag(false);
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (hoverBend !== null && pipe) {
        event.preventDefault();
        event.stopImmediatePropagation();
        removeBend(hoverBend);
        setHoverBend(null);
        return;
      }
      const selected = hvacElements.filter((element) => options.selectedIds.includes(element.id));
      if (!selected.length || !selected.every(isCondensatePipe)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const branches = selected.filter((element) => isUnitBranchSpec(readCondensatePipeSpec(element)));
      const others = selected.filter((element) => !branches.includes(element));
      for (const other of others) deleteDrainNetwork(other);
      if (!others.length && branches.length) {
        runCondensateEdit(branches[0]!, { removePipeIds: branches.map((element) => element.id) }, 'Delete drain run', { select: false });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, hoverBend, pipe, removeBend, endDrag, hvacElements, options.selectedIds]);

  useEffect(() => () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current); }, []);
  // A drawing change under an open preview discards it.
  useEffect(() => { if (!dragRef.current && previewRef.current) publish(null); }, [hvacElements, publish]);

  const beginDrag = useCallback((kind: DragKind, index: number, event: ReactPointerEvent) => {
    if (!enabled || !pipe || event.button !== 0) return;
    const world = toWorld(event.clientX, event.clientY);
    if (!world || !session()) return;
    event.stopPropagation();
    event.preventDefault();
    dragRef.current = { kind, pipeId: pipe.id, index, startWorld: world, pointerId: event.pointerId };
    latestRef.current = { world, shift: event.shiftKey };
  }, [enabled, pipe, toWorld, session]);

  const insertBendAt = useCallback((event: ReactMouseEvent) => {
    const current = session();
    if (!current || !pipe) return;
    const world = toWorld(event.clientX, event.clientY);
    const route = current.model.routes.get(pipe.id);
    const spec = current.model.specs.get(pipe.id);
    if (!world || !route || !spec) return;
    event.stopPropagation();
    event.preventDefault();
    const prefix = fixedPrefixLength(isUnitBranchSpec(spec));
    let best = -1;
    let gap = Number.POSITIVE_INFINITY;
    let at = world;
    for (let index = Math.max(0, prefix - 1); index < route.length - 1; index += 1) {
      const hit = closestOnSegment(world, route[index]!, route[index + 1]!);
      const d = distance(hit.point, world);
      if (d < gap) { gap = d; best = index; at = hit.point; }
    }
    if (best < 0) return;
    const next = insertRouteVertex(route, best, at, prefix);
    commitCondensateEdit(current.solve({ routes: new Map([[pipe.id, next]]) }), 'Add drain bend', [pipe.id]);
  }, [session, pipe, toWorld]);

  /** Adds a rodding eye where the run was clicked, or removes the eye at that point. */
  const toggleEyeAt = useCallback((point: Point2D, remove: boolean) => {
    if (!pipe) return;
    const current = Array.isArray(pipe.properties.fittingEdits) ? pipe.properties.fittingEdits as CondensateFittingEdit[] : [];
    const near = (edit: CondensateFittingEdit) => distance(edit.point, point) < 150;
    const next: CondensateFittingEdit[] = remove
      ? current.some((edit) => edit.action === 'add' && near(edit))
        ? current.filter((edit) => !(edit.action === 'add' && near(edit)))
        : [...current, { action: 'remove', kind: 'cleanout', point }]
      : [...current.filter((edit) => !(edit.action === 'remove' && near(edit))), { action: 'add', kind: 'cleanout', point }];
    editRunFittings(pipe, next, remove ? 'Remove rodding eye' : 'Add rodding eye');
  }, [pipe]);

  return {
    model, preview, beginDrag, insertBendAt, removeBend, hoverBend, setHoverBend, hoverFoot, setHoverFoot,
    eyeMode, setEyeMode, toggleEyeAt, toWorld, dragging: dragRef,
  };
}

export type CondensateEditingApi = ReturnType<typeof useCondensateEditing>;

/** Handles of the selected run, the drag guides and the verdict chip (world millimetres). */
export function CondensateEditHandles({ api, pipe, hpx, settings }: {
  api: CondensateEditingApi;
  pipe: HvacElement;
  hpx: (n: number) => number;
  settings: CondensateDesignSettings;
}) {
  const { model, preview } = api;
  if (!model) return null;
  const spec = model.specs.get(pipe.id);
  const baseRoute = model.routes.get(pipe.id);
  if (!spec || !baseRoute) return null;
  const route = preview?.routes.get(pipe.id) ?? baseRoute;
  const branch = isUnitBranchSpec(spec);
  const prefix = fixedPrefixLength(branch);
  const last = route.length - 1;
  const insulated = spec.outerDiameterMm + 2 * spec.insulationThicknessMm;
  const wye = wyeSlideFor(pipe, model.pipes, preview?.routes ? new Map([...model.routes, ...preview.routes]) : model.routes);
  const tone = !preview?.result ? 'info' : !preview.result.ok ? 'bad' : /hop/.test(preview.result.message) ? 'warn' : 'ok';
  const handle = { fill: '#fff', stroke: '#0369a1', active: '#0ea5e9' };
  const legs = route.slice(0, -1).map((a, index) => ({ a, b: route[index + 1]!, index }))
    .filter(({ index, a, b }) => index >= prefix - 1 && distance(a, b) > hpx(36));
  return (
    <g data-testid="condensate-edit-handles">
      {/* Whole-run grab and double-click to add a bend. */}
      <path d={pathData(route)} fill="none" stroke="rgba(0,0,0,0.001)" strokeWidth={Math.max(insulated, hpx(14))}
        strokeLinecap="round" strokeLinejoin="round"
        onPointerDown={(event) => {
          if (!api.eyeMode) { api.beginDrag('body', 0, event); return; }
          event.stopPropagation();
          const world = api.toWorld(event.clientX, event.clientY);
          if (world) api.toggleEyeAt(world, false);
        }}
        onDoubleClick={api.eyeMode ? undefined : api.insertBendAt}
        style={{ pointerEvents: 'stroke', cursor: api.eyeMode ? 'copy' : 'move' }}>
        <title>{api.eyeMode ? 'Click to place a rodding eye' : 'Drag to move the run · Double-click to add a bend'}</title>
      </path>
      {api.eyeMode ? spec.fittings.filter((fitting) => fitting.kind === 'cleanout').map((fitting) => (
        <circle key={`eye${fitting.id}`} cx={fitting.point.x} cy={fitting.point.y} r={hpx(10)} fill="rgba(220,38,38,0.12)" stroke="#dc2626"
          strokeWidth={hpx(1.2)} style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          onPointerDown={(event) => { event.stopPropagation(); api.toggleEyeAt({ x: fitting.point.x, y: fitting.point.y }, true); }}>
          <title>Click to remove this rodding eye</title>
        </circle>
      )) : null}

      {preview && !preview.result?.ok ? (
        <path d={pathData(route)} fill="none" stroke="#dc2626" strokeWidth={hpx(2.4)} strokeDasharray={`${hpx(8)} ${hpx(5)}`} style={{ pointerEvents: 'none' }} />
      ) : null}

      {/* Riser reach while the foot is in play. */}
      {branch && (api.hoverFoot || preview?.kind === 'foot') ? (
        <circle cx={route[0]!.x} cy={route[0]!.y} r={settings.liftMaxHorizontalMm} fill="rgba(14,165,233,0.06)" stroke="#0ea5e9"
          strokeWidth={hpx(1)} strokeDasharray={`${hpx(5)} ${hpx(4)}`} style={{ pointerEvents: 'none' }} />
      ) : null}

      {preview?.guides.map((guide, index) => (
        <line key={`g${index}`} x1={guide.from.x} y1={guide.from.y} x2={guide.to.x} y2={guide.to.y} stroke="#14b8a6"
          strokeWidth={hpx(1)} strokeDasharray={`${hpx(4)} ${hpx(3)}`} style={{ pointerEvents: 'none' }} />
      ))}

      {legs.map(({ a, b, index }) => {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        return (
          <g key={`leg${index}`} transform={`translate(${mid.x} ${mid.y}) rotate(${angle})`} style={{ cursor: Math.abs(Math.sin((angle * Math.PI) / 180)) > 0.7 ? 'ew-resize' : 'ns-resize', pointerEvents: 'auto' }}
            data-condensate-leg={index} onPointerDown={(event) => api.beginDrag('leg', index, event)}>
            <title>Drag to move this leg</title>
            <rect x={-hpx(11)} y={-hpx(7)} width={hpx(22)} height={hpx(14)} fill="rgba(0,0,0,0.001)" />
            <rect x={-hpx(8)} y={-hpx(3)} width={hpx(16)} height={hpx(6)} rx={hpx(3)} fill={handle.fill} stroke={handle.stroke} strokeWidth={hpx(1.3)} />
          </g>
        );
      })}

      {route.map((point, index) => {
        if (index < prefix || index >= last) return null;
        const active = preview?.kind === 'bend' && preview.index === index;
        return (
          <g key={`b${index}`} style={{ cursor: 'grab', pointerEvents: 'auto' }} data-condensate-bend={index}
            onPointerDown={(event) => api.beginDrag('bend', index, event)}
            onPointerEnter={() => api.setHoverBend(index)} onPointerLeave={() => api.setHoverBend(null)}
            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); api.removeBend(index); }}>
            <title>Drag to move the bend · Right-click or Delete to remove it</title>
            <circle cx={point.x} cy={point.y} r={hpx(10)} fill="rgba(0,0,0,0.001)" />
            <circle cx={point.x} cy={point.y} r={hpx(api.hoverBend === index || active ? 5.5 : 4.5)} fill={active ? handle.active : handle.fill} stroke={handle.stroke} strokeWidth={hpx(1.6)} />
          </g>
        );
      })}

      {branch && route.length >= 2 ? (
        <g style={{ cursor: 'move', pointerEvents: 'auto' }} data-condensate-foot="1"
          onPointerDown={(event) => api.beginDrag('foot', 1, event)}
          onPointerEnter={() => api.setHoverFoot(true)} onPointerLeave={() => api.setHoverFoot(false)}>
          <title>{spec.pumped ? 'Drag the riser (within reach of the drain outlet)' : 'Drag the outlet stub'}</title>
          <circle cx={route[1]!.x} cy={route[1]!.y} r={hpx(11)} fill="rgba(0,0,0,0.001)" />
          <rect x={route[1]!.x - hpx(5)} y={route[1]!.y - hpx(5)} width={hpx(10)} height={hpx(10)} transform={`rotate(45 ${route[1]!.x} ${route[1]!.y})`}
            fill="#ecfeff" stroke="#0e7490" strokeWidth={hpx(1.6)} />
        </g>
      ) : null}

      {wye ? (
        <g style={{ cursor: 'grab', pointerEvents: 'auto' }} data-condensate-wye="1" onPointerDown={(event) => api.beginDrag('wye', last, event)}>
          <title>Slide the wye along its main</title>
          <circle cx={route[last]!.x} cy={route[last]!.y} r={hpx(11)} fill="rgba(0,0,0,0.001)" />
          <rect x={route[last]!.x - hpx(5)} y={route[last]!.y - hpx(5)} width={hpx(10)} height={hpx(10)} transform={`rotate(45 ${route[last]!.x} ${route[last]!.y})`}
            fill="#fff7ed" stroke="#c2410c" strokeWidth={hpx(1.6)} />
        </g>
      ) : null}

      {/* Fixed ends: the unit outlet and the joint / termination. */}
      {[route[0]!, ...(wye ? [] : [route[last]!])].map((point, index) => (
        <rect key={`end${index}`} x={point.x - hpx(3.5)} y={point.y - hpx(3.5)} width={hpx(7)} height={hpx(7)} fill="#0c4a6e" style={{ pointerEvents: 'none' }} />
      ))}

      {preview ? (
        <Tag x={preview.cursor.x + hpx(20)} y={preview.cursor.y - hpx(22)} hpx={hpx} tone={tone}
          text={preview.result?.message ?? '…'} />
      ) : null}
      {preview && (preview.kind === 'bend' || preview.kind === 'leg') ? (
        route.slice(0, -1).map((a, index) => {
          const b = route[index + 1]!;
          const near = preview.kind === 'bend' ? index === preview.index - 1 || index === preview.index : Math.abs(index - preview.index) <= 1;
          if (!near || distance(a, b) < hpx(40)) return null;
          return <Tag key={`d${index}`} x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 + hpx(16)} hpx={hpx} text={`${Math.round(distance(a, b))}`} />;
        })
      ) : null}
    </g>
  );
}
