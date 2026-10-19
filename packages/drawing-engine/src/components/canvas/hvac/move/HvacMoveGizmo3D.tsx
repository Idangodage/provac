'use client';

/**
 * The move gizmo of the 3D views (tilt, isometric, front, side): at the centre
 * of the selected units, terminals and duct runs, X / Y / Z arrows and XY / XZ /
 * YZ plane squares move the selection along an axis or across a plane, and the
 * centre ring on the view's own surface. Up and down is offered only where the
 * selection can go (a ducted unit, a duct run). Every drag is the move session
 * the plan uses: the same model, readout, snapping and one undo step.
 *
 * Projected from the 3D anchor every frame the camera or the selection changes
 * (screen-sized, like the drain gizmo); the 3D layer leaves its pointer events
 * to it (data-pipe-edit-gizmo).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type * as THREE from 'three';

import type { HvacElement } from '../../../../types';
import { beginDrag, createWorkplane, updateDrag, type TransformConstraint } from '../../../../vrf/interaction/interaction-coordinate-service';
import { resolveViewManipulationPolicy, type InteractionViewMode } from '../../../../vrf/interaction/view-manipulation-policy';
import type { HybridViewportController } from '../../hybrid/hybridViewportController';
import { modelPointToWorld, worldPointToModel } from '../../modelSpace';
import { isCondensatePipe } from '../condensate/condensateTypes';
import { isDuctElement, readDuctRunSpec } from '../duct/ductTypes';
import { isRefrigerantPipeElementType } from '../refrigerantPipePairModel';

import type { Vec3 } from './ductElasticMove';
import type { HvacMoveBegin } from './hvacMoveSession';

type Axis = 'x' | 'y' | 'z';
type Plane = 'xy' | 'xz' | 'yz';

interface Projection {
  origin: { x: number; y: number };
  tips: Record<Axis, { x: number; y: number }>;
}

const AXIS_PX = 70;
const AXIS_COLOURS: Record<Axis, string> = { x: '#dc4848', y: '#279568', z: '#357bdf' };
const PLANE_COLOURS: Record<Plane, string> = { xy: AXIS_COLOURS.z, xz: AXIS_COLOURS.y, yz: AXIS_COLOURS.x };
const AXIS_VECTORS: Record<Axis, Vec3> = { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } };
const PLANE_NORMALS: Record<Plane, Vec3> = { xy: AXIS_VECTORS.z, xz: AXIS_VECTORS.y, yz: AXIS_VECTORS.x };

/** What the gizmo moves: units, terminals, gullies and duct runs (pipes and drains have editors of their own). */
function isMovable(element: HvacElement): boolean {
  return !isRefrigerantPipeElementType(element.type) && !isCondensatePipe(element);
}

/** The middle of what is selected (model mm, z up). */
function selectionCentre(elements: readonly HvacElement[]): Vec3 | null {
  const points: Vec3[] = [];
  for (const element of elements) {
    const spec = isDuctElement(element) ? readDuctRunSpec(element) : null;
    if (spec) {
      points.push(...spec.path.map((point) => ({ x: point.x, y: point.y, z: point.z })));
      continue;
    }
    const cx = element.position.x + element.width / 2;
    const cy = element.position.y + element.depth / 2;
    points.push({ x: cx, y: cy, z: element.elevation }, { x: cx, y: cy, z: element.elevation + element.height });
  }
  if (!points.length) return null;
  const range = (pick: (point: Vec3) => number) => (Math.min(...points.map(pick)) + Math.max(...points.map(pick))) / 2;
  return { x: range((point) => point.x), y: range((point) => point.y), z: range((point) => point.z) };
}

/** A model direction as a world direction (the model is mirrored in y). */
function worldDirection(direction: Vec3): THREE.Vector3 {
  return modelPointToWorld({ x: direction.x, y: direction.y }, direction.z).sub(modelPointToWorld({ x: 0, y: 0 }, 0)).normalize();
}

export function HvacMoveGizmo3D(props: {
  enabled: boolean;
  /** A drag is in progress (the gizmo waits). */
  hidden: boolean;
  controllerRef: RefObject<HybridViewportController | null>;
  width: number;
  height: number;
  hvacElements: HvacElement[];
  selectedIds: string[];
  viewMode: InteractionViewMode;
  onBeginMove: (request: HvacMoveBegin) => boolean;
}) {
  const { enabled, hidden, controllerRef, width, height, hvacElements, selectedIds, viewMode, onBeginMove } = props;
  const selected = useMemo(() => {
    if (!enabled) return [];
    const ids = new Set(selectedIds);
    return hvacElements.filter((element) => ids.has(element.id) && isMovable(element));
  }, [enabled, hvacElements, selectedIds]);
  const centre = useMemo(() => selectionCentre(selected), [selected]);
  // Up and down: a ducted unit or a duct run can (terminals sit in the ceiling, other units at their level).
  const canRise = selected.some((element) => element.type === 'ducted-ac' || isDuctElement(element));
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const live = useRef({ centre, width, height });
  live.current = { centre, width, height };

  useEffect(() => {
    if (!centre) { setProjection(null); return undefined; }
    let frame = 0;
    let previous = '';
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const camera = controllerRef.current?.camera;
      const { centre: at, width: w, height: h } = live.current;
      if (!camera || !at) return;
      camera.updateMatrixWorld();
      const key = JSON.stringify([camera.matrixWorld.elements, camera.projectionMatrix.elements, at, w, h]);
      if (key === previous) return;
      previous = key;
      const project = (point: Vec3) => {
        const clip = modelPointToWorld({ x: point.x, y: point.y }, point.z).project(camera);
        return { x: (clip.x + 1) * w / 2, y: (1 - clip.y) * h / 2 };
      };
      const origin = project(at);
      // Screen-sized arrows: the model length that covers AXIS_PX at the centre.
      const probe = project({ ...at, x: at.x + 100 });
      const pxPer100 = Math.max(Math.hypot(probe.x - origin.x, probe.y - origin.y), 1e-3);
      const length = (AXIS_PX / pxPer100) * 100;
      setProjection({
        origin,
        tips: {
          x: project({ ...at, x: at.x + length }),
          y: project({ ...at, y: at.y + length }),
          z: project({ ...at, z: at.z + length }),
        },
      });
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [centre, controllerRef]);

  if (!enabled || hidden || !centre || !projection || selected.length === 0) return null;

  /** Start a move of the selection along an axis or across a plane through the gizmo's centre. */
  const start = (event: ReactPointerEvent, constraint: Axis | Plane) => {
    if (event.button !== 0 || !svgRef.current) return;
    const controller = controllerRef.current;
    if (!controller) return;
    const camera = controller.camera.clone();
    camera.updateMatrixWorld();
    const rect = svgRef.current.getBoundingClientRect();
    const anchorWorld = modelPointToWorld({ x: centre.x, y: centre.y }, centre.z);
    const transform: TransformConstraint = constraint.length === 1
      ? { kind: 'axis', direction: worldDirection(AXIS_VECTORS[constraint as Axis]) }
      : { kind: 'plane', workplane: createWorkplane('hvac-move', anchorWorld, worldDirection(PLANE_NORMALS[constraint as Plane])) };
    const drag = beginDrag(event, { camera, viewport: rect, viewMode }, { anchorWorld, constraint: transform });
    if (!drag) return;
    const begun = onBeginMove({
      pressedId: selected[0]!.id, clientX: event.clientX, clientY: event.clientY,
      // An arrow moves along its axis only; a square across its two.
      axes: { x: constraint.includes('x'), y: constraint.includes('y'), z: constraint.includes('z') },
      resolve: (clientX, clientY) => {
        const solved = updateDrag(drag, { clientX, clientY, pointerId: event.pointerId });
        if (!solved) return null;
        const model = worldPointToModel(solved.worldPoint);
        return { x: model.x, y: model.y, z: model.z };
      },
    });
    if (begun) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  const policy = resolveViewManipulationPolicy(viewMode);
  const surface: Plane = policy.defaultDragPlane === 'xz' || policy.defaultDragPlane === 'yz' ? policy.defaultDragPlane : 'xy';
  const allowed = (axis: Axis) => axis !== 'z' || canRise;
  const o = projection.origin;
  const planes: Array<{ id: Plane; a: Axis; b: Axis }> = [
    { id: 'xy', a: 'x', b: 'y' },
    { id: 'xz', a: 'x', b: 'z' },
    { id: 'yz', a: 'y', b: 'z' },
  ];
  const label = selected.length === 1 ? (selected[0]!.label || 'the selection') : `${selected.length} items`;

  return (
    <div className="pointer-events-none absolute inset-0 z-[23]" data-testid="hvac-move-gizmo" data-pipe-edit-gizmo="move">
      <svg ref={svgRef} width={width} height={height} className="absolute left-0 top-0" style={{ pointerEvents: 'none', overflow: 'visible' }}>
        {planes.filter((plane) => allowed(plane.a) && allowed(plane.b)).map((plane) => {
          const pa = projection.tips[plane.a];
          const pb = projection.tips[plane.b];
          const corner = (s: number, t: number) => ({ x: o.x + (pa.x - o.x) * s + (pb.x - o.x) * t, y: o.y + (pa.y - o.y) * s + (pb.y - o.y) * t });
          const quad = [corner(0.24, 0.24), corner(0.46, 0.24), corner(0.46, 0.46), corner(0.24, 0.46)];
          return (
            <path key={plane.id} d={`M${quad.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')} Z`}
              fill={PLANE_COLOURS[plane.id]} fillOpacity={0.22} stroke={PLANE_COLOURS[plane.id]} strokeWidth={1}
              style={{ pointerEvents: 'auto', cursor: 'move' }} data-hvac-move-plane={plane.id}
              onPointerDown={(event) => start(event, plane.id)}>
              <title>Move {label} across the {plane.id.toUpperCase()} plane</title>
            </path>
          );
        })}
        {(['x', 'y', 'z'] as const).filter(allowed).map((axis) => {
          const tip = projection.tips[axis];
          return (
            <g key={axis} style={{ pointerEvents: 'auto', cursor: 'pointer' }} data-hvac-move-axis={axis} onPointerDown={(event) => start(event, axis)}>
              <title>Move {label} along {axis.toUpperCase()}{axis === 'z' ? ' (up and down, within the ceiling void)' : ''}</title>
              <line x1={o.x} y1={o.y} x2={tip.x} y2={tip.y} stroke="rgba(0,0,0,0.001)" strokeWidth={14} />
              <line x1={o.x} y1={o.y} x2={tip.x} y2={tip.y} stroke={AXIS_COLOURS[axis]} strokeWidth={2.4} strokeLinecap="round" />
              <circle cx={tip.x} cy={tip.y} r={5} fill={AXIS_COLOURS[axis]} stroke="#fff" strokeWidth={1} />
              <text x={tip.x + 8} y={tip.y + 4} fontSize={11} fontWeight={600} fontFamily="system-ui, sans-serif" fill={AXIS_COLOURS[axis]}>{axis.toUpperCase()}</text>
            </g>
          );
        })}
        <g style={{ pointerEvents: 'auto', cursor: 'move' }} data-hvac-move-centre="1" onPointerDown={(event) => start(event, surface)}>
          <title>Move {label} on the view&apos;s {surface.toUpperCase()} plane</title>
          <circle cx={o.x} cy={o.y} r={11} fill="rgba(0,0,0,0.001)" />
          <circle cx={o.x} cy={o.y} r={6.5} fill="#fff" stroke="#0f172a" strokeWidth={1.6} />
          <circle cx={o.x} cy={o.y} r={2} fill="#0f172a" />
        </g>
      </svg>
    </div>
  );
}
