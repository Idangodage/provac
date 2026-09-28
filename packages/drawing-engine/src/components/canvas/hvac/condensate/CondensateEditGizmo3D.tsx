'use client';

/**
 * Drain micro-editing in the 3D views (partial tilt, isometric, front / side).
 *
 * The selected run's handles are projected from their real 3D positions every
 * frame (screen-sized, like the refrigerant gizmo): bends, leg midpoints, the
 * riser foot and riser top, the wye. A plain drag moves on the view's own
 * surface — XY (plan, iso, tilt), XZ (front) or YZ (side); the active handle
 * also gets X / Y / Z arrows and XY / XZ / YZ plane squares. Plan components
 * are the same edits as the 2D board; a vertical component sets the run's
 * level limit (the riser top sets the riser height). The whole network is
 * re-solved live and one release is one undo step.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import * as THREE from 'three';

import type { HvacElement, Point2D } from '../../../../types';
import { beginDrag, createWorkplane, updateDrag, type TransformConstraint } from '../../../../vrf/interaction/interaction-coordinate-service';
import type { HybridViewportController } from '../../hybrid/hybridViewportController';
import { modelPointToWorld, worldPointToModel } from '../../modelSpace';

import { CondensateEditBar } from './CondensateEditBar';
import { useCondensateEditing, type CondensateDragKind, type CondensatePointerResolver } from './CondensateEditLayer';
import { isUnitBranchSpec } from './condensateEditing';
import { getIndoorUnitDrainPort } from './condensatePorts';
import { fixedPrefixLength } from './condensateRouteOps';
import type { CondensateDesignSettings } from './condensateSettings';
import { isCondensatePipe, readCondensatePipeSpec, type Point3 } from './condensateTypes';

type Surface = 'xy' | 'xz' | 'yz';
type Constraint = Surface | 'x' | 'y' | 'z';

interface HandleSpec {
  key: string;
  kind: CondensateDragKind;
  index: number;
  at: Point3;
  /** Handles whose drag is plan-only or vertical-only. */
  lock?: 'plan' | 'vertical';
}

interface ScreenPoint { x: number; y: number; visible: boolean }

interface Projection {
  handles: Array<HandleSpec & { screen: ScreenPoint; angle: number }>;
  run: ScreenPoint[];
  runModel: Point3[];
  axes: Record<'x' | 'y' | 'z', ScreenPoint> | null;
  origin: ScreenPoint | null;
  mmPerPx: number;
  surface: Surface;
}

const AXIS_PX = 64;
/** Leg handles are only shown on legs at least this long on screen. */
const MIN_LEG_PX = 30;
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) } as const;
const NORMALS: Record<Surface, THREE.Vector3> = { xy: AXES.z, xz: AXES.y, yz: AXES.x };
const AXIS_COLOURS = { x: '#dc4848', y: '#279568', z: '#357bdf' } as const;

function modelWorld(point: Point3): THREE.Vector3 {
  return modelPointToWorld(point, point.z);
}

/** Model direction as a world direction (the model is mirrored in y). */
function modelDirectionWorld(direction: THREE.Vector3): THREE.Vector3 {
  return modelPointToWorld({ x: direction.x, y: direction.y }, direction.z).sub(modelPointToWorld({ x: 0, y: 0 }, 0)).normalize();
}

function planDistance(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Level of the run at a plan point: the top of any node there, else interpolated along the run. */
function levelAt(nodes: readonly Point3[], point: Point2D): number {
  const at = nodes.filter((node) => planDistance(node, point) < 1);
  if (at.length) return Math.max(...at.map((node) => node.z));
  let best = { gap: Number.POSITIVE_INFINITY, z: nodes[0]?.z ?? 0 };
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    const length = planDistance(a, b);
    if (length < 1) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (length * length)));
    const gap = Math.hypot(a.x + (b.x - a.x) * t - point.x, a.y + (b.y - a.y) * t - point.y);
    if (gap < best.gap) best = { gap, z: a.z + (b.z - a.z) * t };
  }
  return best.z;
}

export function CondensateEditGizmo3D(props: {
  enabled: boolean;
  controllerRef: RefObject<HybridViewportController | null>;
  width: number;
  height: number;
  hvacElements: HvacElement[];
  selectedIds: string[];
  settings: CondensateDesignSettings;
  onPreviewChange?: (elements: HvacElement[] | null, removeIds: string[]) => void;
}) {
  const { enabled, controllerRef, width, height, hvacElements, selectedIds, settings, onPreviewChange } = props;
  const pipe = useMemo(() => {
    if (!enabled || selectedIds.length !== 1) return null;
    const element = hvacElements.find((candidate) => candidate.id === selectedIds[0]);
    return element && isCondensatePipe(element) ? element : null;
  }, [enabled, selectedIds, hvacElements]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const unusedPlanRef = useRef<SVGGElement | null>(null);
  const mmPerPxRef = useRef(5);
  const api = useCondensateEditing({
    enabled: pipe !== null, pipe, hvacElements, selectedIds, settings, gRef: unusedPlanRef,
    hpx: (n) => n * mmPerPxRef.current, onPreviewChange,
  });
  const [projection, setProjection] = useState<Projection | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const live = useRef({ api, pipe, active, width, height });
  live.current = { api, pipe, active, width, height };
  useEffect(() => { setActive(null); }, [pipe?.id]);

  // Project the selected run and its handles every frame the camera or the preview changes.
  useEffect(() => {
    if (!pipe) { setProjection(null); return undefined; }
    let frame = 0;
    let previous = '';
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const { api: current, pipe: selected, active: activeKey, width: w, height: h } = live.current;
      const camera = controllerRef.current?.camera;
      const model = current.model;
      if (!camera || !selected || !model) return;
      camera.updateMatrixWorld();
      const previewElement = current.preview?.result?.ok ? current.preview.result.elements.find((element) => element.id === selected.id) : undefined;
      const spec = readCondensatePipeSpec(previewElement ?? selected);
      const route = current.preview?.routes.get(selected.id) ?? model.routes.get(selected.id);
      if (!route || spec.routeNodes3d.length < 2) return;
      const key = JSON.stringify([camera.matrixWorld.elements, camera.projectionMatrix.elements, spec.routeNodes3d, route, activeKey, w, h]);
      if (key === previous) return;
      previous = key;
      const project = (point: Point3): ScreenPoint => {
        const clip = modelWorld(point).project(camera);
        return { x: (clip.x + 1) * w / 2, y: (1 - clip.y) * h / 2, visible: Number.isFinite(clip.x) && Number.isFinite(clip.y) && clip.z >= -1 && clip.z <= 1 };
      };
      const nodes = spec.routeNodes3d;
      const branch = isUnitBranchSpec(spec);
      const prefix = fixedPrefixLength(branch);
      const last = route.length - 1;
      const handles: HandleSpec[] = [];
      for (let index = Math.max(0, prefix - 1); index < last; index += 1) {
        const mid = { x: (route[index]!.x + route[index + 1]!.x) / 2, y: (route[index]!.y + route[index + 1]!.y) / 2 };
        handles.push({ key: `leg${index}`, kind: 'leg', index, at: { ...mid, z: levelAt(nodes, mid) } });
      }
      for (let index = prefix; index < last; index += 1) {
        handles.push({ key: `bend${index}`, kind: 'bend', index, at: { ...route[index]!, z: levelAt(nodes, route[index]!) } });
      }
      if (branch && route.length >= 2) {
        handles.push({ key: 'foot', kind: 'foot', index: 1, at: { ...route[1]!, z: nodes[1]!.z }, lock: 'plan' });
        const top = nodes[2];
        if (spec.pumped && top && planDistance(top, nodes[1]!) < 1 && top.z > nodes[1]!.z + 1) {
          handles.push({ key: 'riser-top', kind: 'riser-top', index: 2, at: { ...top }, lock: 'vertical' });
        }
      }
      if (spec.drainEnd?.kind === 'junction' && spec.fittings.some((fitting) => fitting.kind === 'wye')) {
        handles.push({ key: 'wye', kind: 'wye', index: last, at: { ...route[last]!, z: nodes[nodes.length - 1]!.z }, lock: 'plan' });
      }
      const projected = handles.map((handle) => {
        const screen = project(handle.at);
        let angle = 0;
        if (handle.kind === 'leg') {
          const a = project({ ...route[handle.index]!, z: handle.at.z });
          const b = project({ ...route[handle.index + 1]!, z: handle.at.z });
          angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        }
        return { ...handle, screen, angle };
      }).filter((handle) => {
        // A leg seen end-on (e.g. along the view axis in front / side) has no sideways drag: hide its handle.
        if (handle.kind !== 'leg') return true;
        const a = project({ ...route[handle.index]!, z: handle.at.z });
        const b = project({ ...route[handle.index + 1]!, z: handle.at.z });
        return Math.hypot(b.x - a.x, b.y - a.y) >= MIN_LEG_PX;
      });
      // Scale (mm per screen pixel) at the run and the view's own drag surface.
      const probe = nodes[Math.floor(nodes.length / 2)]!;
      const a = project(probe);
      const b = project({ ...probe, x: probe.x + 100 });
      const c = project({ ...probe, y: probe.y + 100 });
      const px = Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y), 1e-3);
      mmPerPxRef.current = 100 / px;
      const forward = worldPointToModel(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).add(camera.position))
        .sub(worldPointToModel(camera.position.clone())).normalize();
      const surface: Surface = Math.abs(forward.y) >= 0.9 ? 'xz' : Math.abs(forward.x) >= 0.9 ? 'yz' : 'xy';
      const activeHandle = projected.find((handle) => handle.key === activeKey);
      let axes: Projection['axes'] = null;
      if (activeHandle) {
        const scale = AXIS_PX * mmPerPxRef.current;
        axes = {
          x: project({ ...activeHandle.at, x: activeHandle.at.x + scale }),
          y: project({ ...activeHandle.at, y: activeHandle.at.y + scale }),
          z: project({ ...activeHandle.at, z: activeHandle.at.z + scale }),
        };
      }
      setProjection({
        handles: projected, run: nodes.map(project), runModel: nodes.map((node) => ({ ...node })), axes,
        origin: activeHandle?.screen ?? null, mmPerPx: mmPerPxRef.current, surface,
      });
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [pipe, controllerRef]);

  if (!pipe || !api.model || !projection) return null;

  const start = (event: ReactPointerEvent, handle: HandleSpec, constraint: Constraint) => {
    if (event.button !== 0 || !svgRef.current) return;
    const controller = controllerRef.current;
    if (!controller) return;
    const camera = controller.camera.clone();
    camera.updateMatrixWorld();
    const rect = svgRef.current.getBoundingClientRect();
    const anchorWorld = modelWorld(handle.at);
    let chosen = constraint;
    // Handles that only move in plan or only vertically keep that, whatever was grabbed.
    if (handle.lock === 'vertical') chosen = 'z';
    if (handle.lock === 'plan' && (chosen === 'z' || chosen === 'xz' || chosen === 'yz')) chosen = 'xy';
    const transform: TransformConstraint = chosen.length === 1
      ? { kind: 'axis', direction: modelDirectionWorld(AXES[chosen as 'x' | 'y' | 'z']) }
      : { kind: 'plane', workplane: createWorkplane('condensate-edit', anchorWorld, modelDirectionWorld(NORMALS[chosen as Surface])) };
    const drag = beginDrag(event, { camera, viewport: rect, viewMode: 'perspective-3d' }, { anchorWorld, constraint: transform });
    if (!drag) { setUnavailable(true); return; }
    setUnavailable(false);
    const resolver: CondensatePointerResolver = {
      start: { plan: { x: handle.at.x, y: handle.at.y }, z: handle.at.z },
      resolve: (pointerEvent) => {
        setPointer({ x: pointerEvent.clientX - rect.left, y: pointerEvent.clientY - rect.top });
        const solved = updateDrag(drag, pointerEvent);
        if (!solved) return null;
        const model = worldPointToModel(solved.worldPoint);
        return { plan: { x: model.x, y: model.y }, z: chosen === 'xy' ? handle.at.z : model.z };
      },
    };
    setActive(handle.key);
    api.beginDrag(handle.kind, handle.index, event, resolver);
  };

  /** Nearest model point on the projected run to a screen point. */
  const modelAtScreen = (x: number, y: number): Point3 | null => {
    let best: { gap: number; point: Point3 } | null = null;
    for (let index = 1; index < projection.run.length; index += 1) {
      const a = projection.run[index - 1]!;
      const b = projection.run[index]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / (length * length)));
      const gap = Math.hypot(a.x + (b.x - a.x) * t - x, a.y + (b.y - a.y) * t - y);
      if (best && gap >= best.gap) continue;
      const ma = projection.runModel[index - 1]!;
      const mb = projection.runModel[index]!;
      best = { gap, point: { x: ma.x + (mb.x - ma.x) * t, y: ma.y + (mb.y - ma.y) * t, z: ma.z + (mb.z - ma.z) * t } };
    }
    return best?.point ?? null;
  };

  const runPath = projection.run.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const dragging = api.preview !== null;
  const tone = !api.preview?.result ? '#0c4a6e' : !api.preview.result.ok ? '#b91c1c' : /hop/.test(api.preview.result.message) ? '#92400e' : '#166534';
  const unitId = readCondensatePipeSpec(pipe).drainStart?.unitId;
  const unit = unitId ? hvacElements.find((element) => element.id === unitId) : undefined;
  const pumpMaxLiftMm = (unit ? getIndoorUnitDrainPort(unit, settings)?.pumpMaxLiftMm : undefined) ?? settings.defaultPumpMaxLiftMm;
  const surfaceLabel = { xy: 'XY', xz: 'XZ', yz: 'YZ' }[projection.surface];

  return (
    // data-pipe-edit-gizmo: the 3D layer leaves these pointer events to the editor.
    <div className="pointer-events-none absolute inset-0 z-[24]" data-testid="condensate-edit-3d" data-pipe-edit-gizmo="condensate">
      <svg ref={svgRef} width={width} height={height} className="absolute left-0 top-0" style={{ pointerEvents: 'none', overflow: 'visible' }}>
        {/* The run: grab to move it on the view's surface, double-click adds a bend, eye mode places rodding eyes. */}
        <path d={runPath} fill="none" stroke="#0ea5e9" strokeOpacity={0.35} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
        <path d={runPath} fill="none" stroke="rgba(0,0,0,0.001)" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round"
          style={{ pointerEvents: 'stroke', cursor: api.eyeMode ? 'copy' : 'move' }} data-condensate-3d-run="1"
          onPointerDown={(event) => {
            const rect = svgRef.current!.getBoundingClientRect();
            const at = modelAtScreen(event.clientX - rect.left, event.clientY - rect.top);
            if (!at) return;
            if (api.eyeMode) { event.stopPropagation(); api.toggleEyeAt({ x: at.x, y: at.y }, false); return; }
            start(event, { key: 'body', kind: 'body', index: 0, at }, projection.surface);
          }}
          onDoubleClick={(event) => {
            const rect = svgRef.current!.getBoundingClientRect();
            const at = modelAtScreen(event.clientX - rect.left, event.clientY - rect.top);
            if (!at) return;
            event.stopPropagation();
            api.insertBendAtPlan({ x: at.x, y: at.y });
          }}>
          <title>Drag to move the run on the {surfaceLabel} surface · double-click adds a bend</title>
        </path>

        {projection.handles.filter((handle) => handle.screen.visible).map((handle) => {
          const { x, y } = handle.screen;
          const isActive = active === handle.key;
          const common = {
            style: { pointerEvents: 'auto' as const, cursor: handle.lock === 'vertical' ? 'ns-resize' : 'grab' },
            onPointerDown: (event: ReactPointerEvent) => start(event, handle, handle.lock === 'vertical' ? 'z' : projection.surface),
            'data-condensate-3d-handle': handle.kind,
          };
          if (handle.kind === 'leg') {
            return (
              <g key={handle.key} transform={`translate(${x} ${y}) rotate(${handle.angle})`} {...common}>
                <title>Drag the leg on the {surfaceLabel} surface (down = level limit)</title>
                <rect x={-12} y={-8} width={24} height={16} fill="rgba(0,0,0,0.001)" />
                <rect x={-8} y={-3} width={16} height={6} rx={3} fill={isActive ? '#e0f2fe' : '#fff'} stroke="#0369a1" strokeWidth={1.3} />
              </g>
            );
          }
          if (handle.kind === 'bend') {
            return (
              <g key={handle.key} {...common}
                onPointerEnter={() => api.setHoverBend(handle.index)} onPointerLeave={() => api.setHoverBend(null)}
                onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); api.removeBend(handle.index); }}>
                <title>Drag the bend on the {surfaceLabel} surface · right-click or Delete removes it</title>
                <circle cx={x} cy={y} r={10} fill="rgba(0,0,0,0.001)" />
                <circle cx={x} cy={y} r={isActive ? 5.5 : 4.5} fill={isActive ? '#0ea5e9' : '#fff'} stroke="#0369a1" strokeWidth={1.6} />
              </g>
            );
          }
          if (handle.kind === 'riser-top') {
            return (
              <g key={handle.key} {...common}>
                <title>Drag up / down to set the riser height</title>
                <circle cx={x} cy={y} r={11} fill="rgba(0,0,0,0.001)" />
                <path d={`M${x} ${y - 9} L${x - 5} ${y - 3} L${x + 5} ${y - 3} Z M${x} ${y + 9} L${x - 5} ${y + 3} L${x + 5} ${y + 3} Z`} fill="#357bdf" stroke="#fff" strokeWidth={0.8} />
              </g>
            );
          }
          const tint = handle.kind === 'wye' ? { fill: '#fff7ed', stroke: '#c2410c' } : { fill: '#ecfeff', stroke: '#0e7490' };
          return (
            <g key={handle.key} {...common}>
              <title>{handle.kind === 'wye' ? 'Slide the wye along its main' : 'Drag the riser foot (within reach of the outlet)'}</title>
              <circle cx={x} cy={y} r={11} fill="rgba(0,0,0,0.001)" />
              <rect x={x - 5} y={y - 5} width={10} height={10} transform={`rotate(45 ${x} ${y})`} fill={tint.fill} stroke={tint.stroke} strokeWidth={1.6} />
            </g>
          );
        })}

        {/* X / Y / Z arrows and XY / XZ / YZ surfaces on the active handle. */}
        {projection.axes && projection.origin && !dragging ? (() => {
          const handle = projection.handles.find((candidate) => candidate.key === active);
          if (!handle) return null;
          const o = projection.origin;
          const allowed = (axis: 'x' | 'y' | 'z') => handle.lock === 'vertical' ? axis === 'z' : handle.lock === 'plan' ? axis !== 'z' : true;
          const planes: Array<{ id: Surface; a: 'x' | 'y' | 'z'; b: 'x' | 'y' | 'z'; colour: string }> = [
            { id: 'xy', a: 'x', b: 'y', colour: AXIS_COLOURS.z },
            { id: 'xz', a: 'x', b: 'z', colour: AXIS_COLOURS.y },
            { id: 'yz', a: 'y', b: 'z', colour: AXIS_COLOURS.x },
          ];
          return (
            <g data-testid="condensate-3d-gizmo">
              {planes.filter((plane) => allowed(plane.a) && allowed(plane.b)).map((plane) => {
                const pa = projection.axes![plane.a];
                const pb = projection.axes![plane.b];
                const corner = (s: number, t: number) => ({ x: o.x + (pa.x - o.x) * s + (pb.x - o.x) * t, y: o.y + (pa.y - o.y) * s + (pb.y - o.y) * t });
                const quad = [corner(0.22, 0.22), corner(0.45, 0.22), corner(0.45, 0.45), corner(0.22, 0.45)];
                return (
                  <path key={plane.id} d={`M${quad.map((p) => `${p.x},${p.y}`).join(' L')} Z`} fill={plane.colour} fillOpacity={0.25} stroke={plane.colour} strokeWidth={1}
                    style={{ pointerEvents: 'auto', cursor: 'move' }} data-condensate-3d-plane={plane.id}
                    onPointerDown={(event) => start(event, handle, plane.id)}>
                    <title>Drag on the {plane.id.toUpperCase()} surface</title>
                  </path>
                );
              })}
              {(['x', 'y', 'z'] as const).filter(allowed).map((axis) => {
                const tip = projection.axes![axis];
                return (
                  <g key={axis} style={{ pointerEvents: 'auto', cursor: 'pointer' }} data-condensate-3d-axis={axis} onPointerDown={(event) => start(event, handle, axis)}>
                    <title>Drag along {axis.toUpperCase()}{axis === 'z' ? ' (level limit / riser height)' : ''}</title>
                    <line x1={o.x} y1={o.y} x2={tip.x} y2={tip.y} stroke="rgba(0,0,0,0.001)" strokeWidth={12} />
                    <line x1={o.x} y1={o.y} x2={tip.x} y2={tip.y} stroke={AXIS_COLOURS[axis]} strokeWidth={2.2} />
                    <circle cx={tip.x} cy={tip.y} r={4.5} fill={AXIS_COLOURS[axis]} />
                    <text x={tip.x + 7} y={tip.y + 4} fontSize={11} fontFamily="system-ui, sans-serif" fill={AXIS_COLOURS[axis]}>{axis.toUpperCase()}</text>
                  </g>
                );
              })}
            </g>
          );
        })() : null}

        {dragging && pointer ? (
          <g transform={`translate(${pointer.x + 16} ${pointer.y - 26})`} style={{ pointerEvents: 'none' }} data-testid="condensate-3d-chip">
            <rect x={0} y={-12} rx={4} width={(api.preview?.result?.message.length ?? 1) * 6.2 + 14} height={20} fill="#fff" stroke={tone} strokeWidth={1} />
            <text x={7} y={2} fontSize={11} fontFamily="system-ui, sans-serif" fill={tone}>{api.preview?.result?.message ?? '…'}</text>
          </g>
        ) : null}
        {unavailable ? (
          <text x={16} y={height - 90} fontSize={11} fill="#92400e" fontFamily="system-ui, sans-serif">That direction is edge-on in this view — pick another axis or surface.</text>
        ) : null}
      </svg>
      <CondensateEditBar pipe={pipe} api={api} pumpMaxLiftMm={pumpMaxLiftMm} surface={surfaceLabel} />
    </div>
  );
}
