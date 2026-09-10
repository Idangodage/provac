'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import * as THREE from 'three';

import {
  beginDrag, createWorkplane, updateDrag, type FrozenDragContext, type TransformConstraint,
} from '../../../vrf/interaction/interaction-coordinate-service';
import type { HybridViewportController } from '../hybrid/hybridViewportController';
import { modelPointToWorld, worldPointToModel } from '../modelSpace';
import type { LinearUnit } from '../scale';

import { PipeDimensionInput } from './PipeDimensionInput';
import { pipeEditPointFromWorld, resolvePipeEditFrame, type PipeEditCoordinateMode, type PipeEditFrame, type PipeEditSelection, type PipeEditWorkplane, type PipeRouteEditOperation } from './pipeEditGeometry';
import { createPointerRay, getPointerNDC } from './pipePointerProjection';
import type { PipeRouteNode3D } from './pipeRoute3d';

interface Props {
  controllerRef: RefObject<HybridViewportController | null>;
  width: number;
  height: number;
  nodes: PipeRouteNode3D[];
  controlIndices: { nodes: number[]; segments: number[] };
  coordinateMode: PipeEditCoordinateMode;
  previewNodes: PipeRouteNode3D[] | null;
  frame: PipeEditFrame;
  pivot: PipeRouteNode3D;
  pivotEnd: 'start' | 'end';
  movingPort?: PipeRouteNode3D;
  mode: 'translate' | 'rotate';
  rotationAxisOnly?: 'x' | 'y' | 'z';
  disabled: boolean;
  invalid: boolean;
  workplane: PipeEditWorkplane | null;
  selection: PipeEditSelection;
  showTransform: boolean;
  onPreview: (operation: PipeRouteEditOperation, selection?: PipeEditSelection) => void;
  onCommit: () => void;
  onCancel: () => void;
  onSelect: (selection: PipeEditSelection) => void;
  lengthMm: number | null;
  unit: LinearUnit;
  onCommitLength: (lengthMm: number) => boolean;
  fixedEndpoints: { start: boolean; end: boolean };
}

type Point = { x: number; y: number; visible: boolean };
interface Projection { pivot: Point; movingPort?: Point; tips: Point[]; nodes: Point[]; preview: Point[]; rings: Point[][]; planes: Point[][]; size: number }
const axes = ['x', 'y', 'z'] as const;
const colors = ['#dc4848', '#279568', '#357bdf'];
const vector = (point: PipeRouteNode3D) => new THREE.Vector3(point.x, point.y, point.z);
const modelWorld = (point: PipeRouteNode3D) => modelPointToWorld(point, point.z);
const path = (points: Point[], close = false) => points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ') + (close ? ' Z' : '');

/** Screen-sized handles project model axes. Camera state is used only to solve pointer rays. */
export function PipeEditGizmo(props: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const live = useRef(props); live.current = props;
  const [projection, setProjection] = useState<Projection | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [hoveredSegment, setHoveredSegment] = useState<number | null>(null);
  const gesture = useRef<{
    pointerId: number; key: string; drag?: FrozenDragContext; frame: PipeEditFrame;
    pivot: PipeRouteNode3D; plane?: THREE.Plane; initial?: THREE.Vector3; camera: THREE.Camera;
    selection?: PipeEditSelection; startX: number; startY: number; moved: boolean;
  } | null>(null);

  useEffect(() => {
    let frameId = 0;
    let previousInput: unknown[] = [];
    let previousCamera: number[] = [];
    const draw = () => {
      const current = live.current; const camera = current.controllerRef.current?.camera;
      if (camera) {
        camera.updateMatrixWorld();
        const input = [current.nodes, current.previewNodes, current.frame, current.pivot.x, current.pivot.y, current.pivot.z,
          current.movingPort?.x, current.movingPort?.y, current.movingPort?.z, current.width, current.height, current.showTransform, current.mode];
        const matrices = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements];
        if (input.every((value, index) => value === previousInput[index]) && matrices.every((value, index) => value === previousCamera[index])) {
          frameId = requestAnimationFrame(draw); return;
        }
        previousInput = input; previousCamera = matrices;
        const project = (point: PipeRouteNode3D): Point => {
          const world = modelWorld(point); const clip = world.clone().project(camera);
          return { x: (clip.x + 1) * current.width / 2, y: (1 - clip.y) * current.height / 2,
            visible: Number.isFinite(clip.x) && Number.isFinite(clip.y) && clip.z >= -1 && clip.z <= 1 };
        };
        const pivotClip = modelWorld(current.pivot).project(camera);
        const atPivot = pivotClip.clone().unproject(camera);
        const beside = pivotClip.clone().add(new THREE.Vector3(160 / Math.max(1, current.width), 0, 0)).unproject(camera);
        const size = Math.max(0.001, beside.distanceTo(atPivot));
        const basis = [current.frame.xAxis, current.frame.yAxis, current.frame.zAxis].map(vector);
        const origin = vector(current.pivot);
        const worldPoint = (offset: THREE.Vector3) => project(origin.clone().add(offset));
        const next: Projection = {
          pivot: project(current.pivot), size,
          movingPort: current.movingPort ? project(current.movingPort) : undefined,
          tips: current.showTransform && current.mode === 'translate' ? basis.map(axis => worldPoint(axis.clone().multiplyScalar(size))) : [],
          nodes: (current.previewNodes ?? current.nodes).map(project), preview: (current.previewNodes ?? []).map(project),
          rings: current.showTransform && current.mode === 'rotate' ? basis.map((_, index) => Array.from({ length: 65 }, (_, step) => {
            const angle = step / 64 * Math.PI * 2;
            return worldPoint(basis[(index + 1) % 3]!.clone().multiplyScalar(Math.cos(angle) * size * 0.8)
              .addScaledVector(basis[(index + 2) % 3]!, Math.sin(angle) * size * 0.8));
          })) : [],
          planes: current.showTransform && current.mode === 'translate' ? basis.map((_, index) => [[0.22, 0.22], [0.43, 0.22], [0.43, 0.43], [0.22, 0.43]].map(([a, b]) =>
            worldPoint(basis[(index + 1) % 3]!.clone().multiplyScalar(a! * size).addScaledVector(basis[(index + 2) % 3]!, b! * size)))) : [],
        };
        setProjection(next);
      }
      frameId = requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(frameId);
  }, []);

  const cancelGesture = () => {
    if (!gesture.current) return;
    const pointerId = gesture.current.pointerId;
    gesture.current = null; setActive(null); live.current.onCancel();
    if (svgRef.current?.hasPointerCapture(pointerId)) svgRef.current.releasePointerCapture(pointerId);
  };
  // A history/model update invalidates the frozen drag baseline. It must never
  // resume against a different committed route on the next pointer event.
  useEffect(() => { cancelGesture(); }, [props.nodes, props.disabled]);
  useEffect(() => {
    const cancelKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelGesture(); };
    window.addEventListener('blur', cancelGesture); window.addEventListener('keydown', cancelKey, true);
    return () => { window.removeEventListener('blur', cancelGesture); window.removeEventListener('keydown', cancelKey, true); };
  }, []);

  const start = (event: ReactPointerEvent, key: string, selection?: PipeEditSelection) => {
    if (event.button !== 0 || props.disabled || !svgRef.current) return;
    event.preventDefault(); event.stopPropagation();
    const controller = props.controllerRef.current; if (!controller) return;
    const camera = controller.camera.clone(); camera.updateMatrixWorld();
    const rect = svgRef.current.getBoundingClientRect();
    const editFrame = selection ? resolvePipeEditFrame({ mode: props.coordinateMode, nodes: props.nodes, selection, workplane: props.workplane }) : props.frame;
    if (!editFrame) return;
    let pivot = props.pivot;
    if (selection?.kind === 'node') pivot = props.nodes[selection.index]!;
    if (selection?.kind === 'segment') {
      const a = props.nodes[selection.index]!; const b = props.nodes[selection.index + 1]!;
      pivot = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    }
    const pivotWorld = modelWorld(pivot);
    const basis = [editFrame.xAxis, editFrame.yAxis, editFrame.zAxis];
    const axisIndex = axes.indexOf(key.slice(-1) as typeof axes[number]);
    const axisModel = basis[axisIndex];
    let drag: FrozenDragContext | null = null; let plane: THREE.Plane | undefined; let initial: THREE.Vector3 | undefined;
    if (key.startsWith('rotate') && axisModel) {
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(modelWorld(axisModel).normalize(), pivotWorld);
      const ray = createPointerRay(getPointerNDC(event.clientX, event.clientY, rect).ndc, camera);
      if (Math.abs(ray.direction.dot(plane.normal)) < 0.0175) { setUnavailable(true); return; }
      const hit = ray.intersectPlane(plane, new THREE.Vector3());
      if (!hit) { setUnavailable(true); return; }
      initial = vector(worldPointToModel(hit)).sub(vector(pivot)).normalize();
    } else {
      let constraint: TransformConstraint = { kind: 'free' };
      if (key.startsWith('axis') && axisModel) constraint = { kind: 'axis', direction: modelWorld(axisModel) };
      if (key.startsWith('plane') && axisModel) constraint = { kind: 'plane', workplane: createWorkplane('pipe-edit-plane', pivotWorld, modelWorld(axisModel)) };
      drag = beginDrag(event, { camera, viewport: rect, viewMode: 'perspective-3d' }, { anchorWorld: pivotWorld, constraint });
      if (!drag) { setUnavailable(true); return; }
    }
    if (selection) props.onSelect(selection);
    gesture.current = { pointerId: event.pointerId, key, drag: drag ?? undefined, plane, initial, camera, frame: editFrame, pivot,
      selection, startX: event.clientX, startY: event.clientY, moved: false };
    setUnavailable(false); setActive(key); svgRef.current.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent) => {
    const current = gesture.current; if (!current || current.pointerId !== event.pointerId || !svgRef.current) return;
    event.preventDefault(); event.stopPropagation();
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 3) return;
    current.moved = true;
    if (current.drag) {
      const solved = updateDrag(current.drag, event); if (!solved) { setUnavailable(true); return; }
      const model = worldPointToModel(solved.worldPoint);
      const from = pipeEditPointFromWorld(current.pivot, current.frame); const to = pipeEditPointFromWorld(model, current.frame);
      live.current.onPreview({ kind: 'translate', offset: { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z } }, current.selection);
    } else if (current.plane && current.initial) {
      const rect = svgRef.current.getBoundingClientRect();
      const ray = createPointerRay(getPointerNDC(event.clientX, event.clientY, rect).ndc, current.camera);
      if (Math.abs(ray.direction.dot(current.plane.normal)) < 0.0175) { setUnavailable(true); return; }
      const hit = ray.intersectPlane(current.plane, new THREE.Vector3()); if (!hit) return;
      const direction = vector(worldPointToModel(hit)).sub(vector(current.pivot)); if (direction.lengthSq() < 1e-9) return;
      direction.normalize(); const axis = current.key.slice(-1) as 'x' | 'y' | 'z';
      const axisVector = vector(current.frame[`${axis}Axis`]);
      let degrees = Math.atan2(axisVector.dot(current.initial.clone().cross(direction)), current.initial.dot(direction)) * 180 / Math.PI;
      if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
      live.current.onPreview({ kind: 'rotate', axis, angleDegrees: degrees, pivot: current.pivot });
    }
    setUnavailable(false);
  };
  const finish = (event: ReactPointerEvent) => {
    if (!gesture.current || gesture.current.pointerId !== event.pointerId) return;
    move(event); const moved = gesture.current.moved; gesture.current = null; setActive(null);
    if (moved) live.current.onCommit();
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
  };

  if (!projection) return null;
  return <svg ref={svgRef} data-pipe-edit-gizmo="true" className="absolute inset-0 z-[21] overflow-visible" width={props.width} height={props.height}
    style={{ pointerEvents: 'none', touchAction: 'none' }} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}>
    {projection.preview.length > 1 && projection.preview.every(point => point.visible) && <path d={path(projection.preview)} fill="none" stroke={props.invalid ? '#dc2626' : '#0d9488'} strokeWidth={3} strokeDasharray="6 4" />}
    {projection.nodes.slice(0, -1).map((point, index) => {
      const end = projection.nodes[index + 1]!;
      if (!props.controlIndices.segments.includes(index) || !point.visible || !end.visible || Math.hypot(end.x - point.x, end.y - point.y) < 18) return null;
      const selected = props.selection.kind === 'segment' && props.selection.index === index;
      const hovered = hoveredSegment === index;
      const x = (point.x + end.x) / 2; const y = (point.y + end.y) / 2;
      return <g key={`segment-${index}`} data-pipe-segment={index} style={{ pointerEvents: props.disabled ? 'none' : 'auto', cursor: 'move' }}
        onPointerEnter={() => setHoveredSegment(index)} onPointerLeave={() => setHoveredSegment(null)}
        onPointerDown={event => start(event, 'free', { kind: 'segment', index })}>
        <path d={path([point, end])} fill="none" stroke={selected || hovered ? '#0d9488' : 'transparent'} strokeWidth={selected || hovered ? 3 : 14} strokeOpacity={selected ? 0.7 : 0.4} />
        {(selected || hovered) && <path d={path([point, end])} fill="none" stroke="transparent" strokeWidth={14} />}
        <rect x={x - 9} y={y - 9} width={18} height={18} fill="transparent" />
        <rect x={x - 3.5} y={y - 3.5} width={7} height={7} rx={1} fill={selected ? '#0d9488' : 'white'} stroke="#0f766e" strokeWidth={1.5} />
        <title>Drag segment {index + 1}</title>
      </g>;
    })}
    {projection.nodes.map((point, index) => {
      if (!props.controlIndices.nodes.includes(index) || !point.visible) return null;
      const fixed = index === 0 ? props.fixedEndpoints.start : index === props.nodes.length - 1 && props.fixedEndpoints.end;
      return <g key={index} data-pipe-node={index}
      style={{ pointerEvents: props.disabled ? 'none' : 'auto', cursor: fixed ? 'default' : 'move' }} onPointerDown={event => {
        if (fixed) { event.preventDefault(); event.stopPropagation(); props.onSelect({ kind: 'node', index }); return; }
        start(event, 'free', { kind: 'node', index });
      }}>
      <circle cx={point.x} cy={point.y} r={10} fill="transparent" />
      <circle cx={point.x} cy={point.y} r={4} stroke={fixed ? '#475569' : '#64748b'} fill={fixed ? '#94a3b8' : props.selection.kind === 'node' && props.selection.index === index ? '#0d9488' : 'white'} strokeWidth={1.5} />
      <title>{fixed ? 'Connected endpoint · adjust the adjoining segment' : `Drag route point ${index + 1}`}</title></g>;
    })}
    {props.selection.kind === 'segment' && props.lengthMm !== null && !active && (() => {
      const a = projection.nodes[props.selection.index]; const b = projection.nodes[props.selection.index + 1];
      if (!a?.visible || !b?.visible) return null;
      const dx = b.x - a.x; const dy = b.y - a.y; const span = Math.hypot(dx, dy);
      if (span < 30) return null;
      const x = Math.max(8, Math.min(props.width - 120, (a.x + b.x) / 2 - dy / span * 28 - 52));
      const y = Math.max(8, Math.min(props.height - 36, (a.y + b.y) / 2 + dx / span * 28 - 14));
      return <foreignObject x={x} y={y} width={112} height={32} style={{ pointerEvents: 'auto', overflow: 'visible' }}
        onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <PipeDimensionInput label="On-canvas segment length" valueMm={props.lengthMm} unit={props.unit} onCommit={props.onCommitLength} disabled={props.disabled} />
      </foreignObject>;
    })()}
    {projection.movingPort?.visible && <g><circle cx={projection.movingPort.x} cy={projection.movingPort.y} r={6} fill="#f59e0b" stroke="white" strokeWidth={2} />
      <text x={projection.movingPort.x + 10} y={projection.movingPort.y - 10} fontSize={11} fill="#a16207" stroke="white" strokeWidth={4} paintOrder="stroke">Moving connection</text></g>}
    {props.showTransform && projection.pivot.visible && (props.mode === 'translate' ? <>
      {projection.planes.map((points, index) => points.every(point => point.visible) && <path key={`plane-${index}`} d={path(points, true)}
        fill={colors[index]} fillOpacity={active === `plane-${axes[index]}` ? 0.6 : 0.18} stroke={colors[index]} strokeWidth={1}
        style={{ pointerEvents: props.disabled ? 'none' : 'auto', cursor: 'move' }} onPointerDown={event => start(event, `plane-${axes[index]}`)}>
        <title>Move in {props.frame.labels[(index + 1) % 3]}/{props.frame.labels[(index + 2) % 3]} plane</title></path>)}
      {projection.tips.map((tip, index) => {
        const length = Math.hypot(tip.x - projection.pivot.x, tip.y - projection.pivot.y);
        const usable = tip.visible && length > 18 && !props.disabled;
        const angle = Math.atan2(tip.y - projection.pivot.y, tip.x - projection.pivot.x);
        const arrow = [{ x: tip.x, y: tip.y, visible: true }, ...[-0.5, 0.5].map(offset => ({ x: tip.x - Math.cos(angle + offset) * 11, y: tip.y - Math.sin(angle + offset) * 11, visible: true }))];
        return <g key={index} opacity={usable ? 1 : 0.3} style={{ pointerEvents: usable ? 'auto' : 'none', cursor: 'move' }} onPointerDown={event => start(event, `axis-${axes[index]}`)}>
          <path d={path([projection.pivot, tip])} stroke="transparent" strokeWidth={16} /><path d={path([projection.pivot, tip])} stroke={colors[index]} strokeWidth={active === `axis-${axes[index]}` ? 4 : 2} />
          <path d={path(arrow, true)} fill={colors[index]} /><text x={tip.x + 8} y={tip.y - 8} fontSize={12} fill={colors[index]} stroke="white" strokeWidth={3} paintOrder="stroke">{props.frame.labels[index]}</text>
          <title>{usable ? `Move along ${props.frame.labels[index]}` : 'Axis points into the view; use numerical input'}</title></g>;
      })}
      <circle cx={projection.pivot.x} cy={projection.pivot.y} r={8} fill="white" stroke="#0f766e" strokeWidth={2}
        style={{ pointerEvents: props.disabled ? 'none' : 'auto', cursor: 'move' }} onPointerDown={event => start(event, 'free')}><title>Free drag in a camera-facing plane</title></circle>
    </> : <>
      {projection.rings.map((ring, index) => (!props.rotationAxisOnly || axes[index] === props.rotationAxisOnly) && ring.every(point => point.visible) && <g key={index} style={{ pointerEvents: props.disabled ? 'none' : 'auto', cursor: 'grab' }}
        onPointerDown={event => start(event, `rotate-${axes[index]}`)}><path d={path(ring)} fill="none" stroke="transparent" strokeWidth={14} />
        <path d={path(ring)} fill="none" stroke={colors[index]} strokeWidth={active === `rotate-${axes[index]}` ? 4 : 2} />
        <text x={ring[index * 12]!.x + 4} y={ring[index * 12]!.y - 5} fontSize={12} fill={colors[index]} stroke="white" strokeWidth={3} paintOrder="stroke">{props.frame.labels[index]}</text>
        <title>Rotate around {props.frame.labels[index]}; Shift snaps to 15 degrees</title></g>)}
      <circle cx={projection.pivot.x} cy={projection.pivot.y} r={7} fill="#0d9488" stroke="white" strokeWidth={2} />
    </>)}
    {(unavailable || props.showTransform) && projection.pivot.visible && <text x={projection.pivot.x + 14} y={projection.pivot.y + 22} fill={props.invalid ? '#dc2626' : '#0f766e'} fontSize={11} stroke="white" strokeWidth={4} paintOrder="stroke">
      {unavailable ? 'Edge-on view: use numeric input' : props.disabled ? 'Geometry locked' : props.mode === 'rotate' ? `Fixed ${props.pivotEnd} pivot` : `${props.frame.mode} coordinates`}
    </text>}
  </svg>;
}
