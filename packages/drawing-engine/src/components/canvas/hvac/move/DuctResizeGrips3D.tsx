'use client';

/**
 * The resize grips of the straight whose card is pinned in a 3D view (tilt,
 * isometric, 3D, front, side): its ends (its length; a riser's height), its
 * sides (its width) and its top (its depth), projected from the model each
 * frame the camera moves, screen-sized. A grip drags along its own axis (the
 * camera's ray held to it, as the move gizmo's arrows are) through the move
 * session's resize mode: the readout, the duct drawn as it will be, a typed
 * number, Esc, one undo step. A grip seen end-on (its axis toward the camera)
 * is not offered. While one is dragged, it rides on the duct as it will be,
 * with the dimension it is taking drawn on the duct. Focused, a grip steps
 * with the arrow keys, as on the plan.
 */
import {
  useEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject,
} from 'react';
import type * as THREE from 'three';

import type { HvacElement } from '../../../../types';
import { beginDrag, updateDrag } from '../../../../vrf/interaction/interaction-coordinate-service';
import type { InteractionViewMode } from '../../../../vrf/interaction/view-manipulation-policy';
import type { HybridViewportController } from '../../hybrid/hybridViewportController';
import { modelPointToWorld, worldPointToModel } from '../../modelSpace';
import { ductLegs } from '../duct/ductGeometry';
import { domainOf, useDuctSegmentUiStore } from '../duct/ductSegmentUiStore';
import type { DuctDesignSettings } from '../duct/ductSettings';
import { readDuctRunSpec } from '../duct/ductTypes';

import { cursorFor, gripName, steppedValue } from './DuctResizeGrips';
import type { Vec3 } from './ductElasticMove';
import { ductResizeGrips, type DuctResizeGrip } from './ductResize';
import { useDuctResizePreviewStore, type DuctResizePreview } from './ductResizePreviewStore';
import type { HvacResizeBegin } from './hvacMoveSession';

const COLOUR = '#0369a1';
/** A grip whose axis covers less than this on screen per 100 mm is seen end-on: not offered. */
const END_ON_PX = 4;
/** A side grip sits at least this far off the centreline on screen. */
const MIN_SIDE_PX = 14;

const formatMm = (value: number) => Math.round(value).toLocaleString('en-GB');

/** A model direction as a world direction (the model is mirrored in y). */
function worldDirection(direction: Vec3): THREE.Vector3 {
  return modelPointToWorld({ x: direction.x, y: direction.y }, direction.z).sub(modelPointToWorld({ x: 0, y: 0 }, 0)).normalize();
}

/** The dimension a dragged grip is taking, as two model points and its figure (null: none drawn). */
function dimensionOf(scene: readonly HvacElement[], preview: DuctResizePreview, dragged: DuctResizeGrip): { a: Vec3; b: Vec3; label: string } | null {
  const element = scene.find((candidate) => candidate.id === preview.grip.runId);
  const spec = element ? readDuctRunSpec(element) : null;
  const geometry = spec ? ductLegs(spec)[preview.grip.legIndex] : undefined;
  const section = spec?.legs[preview.grip.legIndex];
  if (!spec || !geometry || !section) return null;
  const depth = section.diameterMm ?? section.heightMm;
  const width = section.diameterMm ?? section.widthMm;
  const label = formatMm(preview.made);
  const kind = preview.grip.kind;
  if (kind === 'length-end' || kind === 'length-start') {
    if (geometry.vertical) return { a: { ...geometry.start, z: geometry.startCentreZ }, b: { ...geometry.end, z: geometry.endCentreZ }, label };
    const top = geometry.start.z + depth + spec.insulationThicknessMm;
    return { a: { x: geometry.start.x, y: geometry.start.y, z: top }, b: { x: geometry.end.x, y: geometry.end.y, z: top }, label };
  }
  const base = dragged.base ?? { x: (geometry.start.x + geometry.end.x) / 2, y: (geometry.start.y + geometry.end.y) / 2, z: geometry.start.z + depth / 2 };
  if (kind === 'width') {
    const half = width / 2;
    const top = geometry.start.z + depth + spec.insulationThicknessMm;
    const axis = dragged.axis;
    return { a: { x: base.x + axis.x * half, y: base.y + axis.y * half, z: top }, b: { x: base.x - axis.x * half, y: base.y - axis.y * half, z: top }, label };
  }
  if (kind === 'depth') {
    const middle = { x: (geometry.start.x + geometry.end.x) / 2, y: (geometry.start.y + geometry.end.y) / 2 };
    const side = { x: -geometry.direction.y * (width / 2 + spec.insulationThicknessMm), y: geometry.direction.x * (width / 2 + spec.insulationThicknessMm) };
    return { a: { x: middle.x + side.x, y: middle.y + side.y, z: geometry.start.z }, b: { x: middle.x + side.x, y: middle.y + side.y, z: geometry.start.z + depth }, label };
  }
  return null;
}

interface Projected {
  items: Array<{ grip: DuctResizeGrip; at: { x: number; y: number }; angle: number; cursor: string }>;
  dimension: { a: { x: number; y: number }; b: { x: number; y: number }; label: string } | null;
}

export function DuctResizeGrips3D(props: {
  enabled: boolean;
  controllerRef: RefObject<HybridViewportController | null>;
  width: number;
  height: number;
  hvacElements: readonly HvacElement[];
  settings: DuctDesignSettings;
  viewMode: InteractionViewMode;
  onBeginResize?: (request: HvacResizeBegin) => boolean;
  /** A grip stepped from the keyboard to `value` (one undo step). */
  onStep?: (grip: DuctResizeGrip, value: number) => void;
}) {
  const { enabled, controllerRef, width, height, hvacElements, settings, viewMode, onBeginResize, onStep } = props;
  const pinned = useDuctSegmentUiStore((state) => state.pinned);
  const preview = useDuctResizePreviewStore((state) => state.preview);
  const focus = enabled && pinned && pinned.view === '3d' && domainOf(pinned) === 'duct' ? pinned : null;
  const svgRef = useRef<SVGSVGElement | null>(null);

  const grips = useMemo(() => (focus ? ductResizeGrips(hvacElements, settings, focus.runId, focus.key) : []), [focus, hvacElements, settings]);
  const subject = useMemo(() => {
    if (!focus) return '';
    if (focus.key === 'end:flex') return 'the runout';
    const element = hvacElements.find((candidate) => candidate.id === focus.runId);
    const spec = element ? readDuctRunSpec(element) : null;
    const index = Number(/^leg:(\d+)$/.exec(focus.key)?.[1] ?? -1);
    return `${spec && ductLegs(spec)[index]?.vertical ? 'riser' : 'straight'} ${index + 1}`;
  }, [focus, hvacElements]);

  // While a grip is dragged: it, on the duct as it will be, and the dimension it is taking.
  const dragging = preview && focus && preview.grip.runId === focus.runId ? preview : null;
  const dragScene = useMemo(() => {
    if (!dragging) return null;
    const replaced = new Map(dragging.elements.map((element) => [element.id, element]));
    return hvacElements.map((element) => replaced.get(element.id) ?? element);
  }, [dragging, hvacElements]);
  const dragged = useMemo(() => {
    if (!dragging || !dragScene || !focus) return null;
    const { grip } = dragging;
    return ductResizeGrips(dragScene, settings, grip.runId, focus.key, { probe: false })
      .find((candidate) => candidate.kind === grip.kind && candidate.side === grip.side) ?? null;
  }, [dragging, dragScene, focus, settings]);
  const shown = useMemo(() => (dragged ? [dragged] : grips), [dragged, grips]);
  const dimension = useMemo(() => (dragging && dragScene && dragged ? dimensionOf(dragScene, dragging, dragged) : null), [dragging, dragScene, dragged]);

  // Projected each frame the camera, the grips or the canvas change.
  const [projected, setProjected] = useState<Projected | null>(null);
  const live = useRef({ shown, dimension, width, height });
  live.current = { shown, dimension, width, height };
  useEffect(() => {
    if (!focus) {
      setProjected(null);
      return undefined;
    }
    let frame = 0;
    let previous = '';
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const camera = controllerRef.current?.camera;
      if (!camera) return;
      camera.updateMatrixWorld();
      const { shown: list, dimension: wanted, width: w, height: h } = live.current;
      const key = JSON.stringify([camera.matrixWorld.elements, camera.projectionMatrix.elements, list.map((grip) => [grip.kind, grip.side, grip.point, grip.value]), wanted, w, h]);
      if (key === previous) return;
      previous = key;
      const project = (point: Vec3) => {
        const clip = modelPointToWorld({ x: point.x, y: point.y }, point.z).project(camera);
        return { x: ((clip.x + 1) * w) / 2, y: ((1 - clip.y) * h) / 2, visible: Number.isFinite(clip.x) && clip.z >= -1 && clip.z <= 1 };
      };
      const items = list.flatMap((grip) => {
        let at = project(grip.point);
        const tip = project({ x: grip.point.x + grip.axis.x * 100, y: grip.point.y + grip.axis.y * 100, z: grip.point.z + grip.axis.z * 100 });
        const dx = tip.x - at.x;
        const dy = tip.y - at.y;
        const span = Math.hypot(dx, dy);
        if (!at.visible || span < END_ON_PX) return [];
        const direction = { x: dx / span, y: dy / span };
        if (grip.base) {
          const base = project(grip.base);
          if (Math.hypot(at.x - base.x, at.y - base.y) < MIN_SIDE_PX) at = { ...at, x: base.x + direction.x * MIN_SIDE_PX, y: base.y + direction.y * MIN_SIDE_PX };
        }
        return [{ grip, at: { x: at.x, y: at.y }, angle: (Math.atan2(dy, dx) * 180) / Math.PI, cursor: cursorFor(direction) }];
      });
      const ends = wanted ? [project(wanted.a), project(wanted.b)] : null;
      setProjected({
        items,
        dimension: wanted && ends && ends[0]!.visible && ends[1]!.visible ? { a: ends[0]!, b: ends[1]!, label: wanted.label } : null,
      });
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [focus, controllerRef]);

  if (!focus || !projected || projected.items.length === 0) return null;

  const press = (event: ReactPointerEvent<SVGGElement>, grip: DuctResizeGrip) => {
    if (event.button !== 0 || !svgRef.current || !onBeginResize) return;
    const controller = controllerRef.current;
    if (!controller) return;
    const camera = controller.camera.clone();
    camera.updateMatrixWorld();
    const rect = svgRef.current.getBoundingClientRect();
    const anchorWorld = modelPointToWorld({ x: grip.point.x, y: grip.point.y }, grip.point.z);
    const drag = beginDrag(event, { camera, viewport: rect, viewMode }, { anchorWorld, constraint: { kind: 'axis', direction: worldDirection(grip.axis) } });
    if (!drag) return;
    const begun = onBeginResize({
      grip, clientX: event.clientX, clientY: event.clientY,
      resolve: (clientX, clientY) => {
        const solved = updateDrag(drag, { clientX, clientY, pointerId: event.pointerId });
        if (!solved) return null;
        const model = worldPointToModel(solved.worldPoint);
        return { x: model.x, y: model.y, z: model.z };
      },
    });
    if (!begun) return;
    event.stopPropagation();
    event.preventDefault();
  };
  const key = (event: ReactKeyboardEvent<SVGGElement>, grip: DuctResizeGrip) => {
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction || !onStep) return;
    event.preventDefault();
    event.stopPropagation();
    const value = steppedValue(grip, direction, event, settings);
    if (Math.abs(value - grip.value) >= 0.5) onStep(grip, value);
  };

  const { dimension: drawn } = projected;
  let angle = drawn ? (Math.atan2(drawn.b.y - drawn.a.y, drawn.b.x - drawn.a.x) * 180) / Math.PI : 0;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;

  return (
    <div className="pointer-events-none absolute inset-0 z-[24]" data-testid="duct-resize-grips-3d" data-pipe-edit-gizmo="resize">
      <svg ref={svgRef} width={width} height={height} className="absolute left-0 top-0" style={{ pointerEvents: 'none', overflow: 'visible' }}>
        {drawn ? (
          <g data-testid="duct-resize-dimension">
            <path d={`M${drawn.a.x},${drawn.a.y} L${drawn.b.x},${drawn.b.y}`} stroke={COLOUR} strokeWidth={1.4} fill="none" />
            <circle cx={drawn.a.x} cy={drawn.a.y} r={2.2} fill={COLOUR} />
            <circle cx={drawn.b.x} cy={drawn.b.y} r={2.2} fill={COLOUR} />
            <g transform={`translate(${(drawn.a.x + drawn.b.x) / 2} ${(drawn.a.y + drawn.b.y) / 2}) rotate(${angle})`}>
              <rect x={-26} y={-20} width={52} height={18} rx={4} fill={COLOUR} />
              <text x={0} y={-7} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="#ffffff" style={{ fontFamily: 'ui-monospace, monospace' }}>{drawn.label}</text>
            </g>
          </g>
        ) : null}
        {projected.items.map(({ grip, at, angle: turn, cursor }) => {
          const name = gripName(grip, subject);
          const sectional = grip.kind === 'width' || grip.kind === 'depth';
          return (
            <g
              key={`${grip.kind}${grip.side ?? ''}`}
              data-duct-resize-grip={`${grip.kind}${grip.side ? `:${grip.side}` : ''}`}
              transform={`translate(${at.x} ${at.y}) rotate(${turn})`}
              role="slider"
              tabIndex={dragged ? -1 : 0}
              aria-label={name}
              aria-valuenow={Math.round(grip.value)}
              aria-valuetext={`${formatMm(grip.value)} mm`}
              className="group outline-none"
              style={{ pointerEvents: 'all', cursor }}
              onPointerDown={(event) => press(event, grip)}
              onKeyDown={(event) => key(event, grip)}
            >
              <title>{`${name}: drag (Alt: 1 mm${sectional ? '; Shift: every straight of its size' : ''}; type a number for an exact value), or the arrow keys`}</title>
              <circle r={13} fill="transparent" />
              {sectional ? (
                <>
                  <rect x={-4.5} y={-9} width={9} height={18} rx={4.5} fill="#ffffff" stroke={COLOUR} strokeWidth={1.5}
                    className="transition-colors group-hover:fill-sky-100 group-focus-visible:fill-sky-200" />
                  <path d="M-1.5,0 L1.5,0 M1.5,0 L-0.5,-2 M1.5,0 L-0.5,2" stroke={COLOUR} strokeWidth={1.4} fill="none" strokeLinecap="round" />
                </>
              ) : (
                <>
                  <rect x={-10} y={-6} width={20} height={12} rx={6} fill="#ffffff" stroke={COLOUR} strokeWidth={1.5}
                    className="transition-colors group-hover:fill-sky-100 group-focus-visible:fill-sky-200" />
                  <path d="M-6,0 L6,0 M-6,0 L-3.5,-2.5 M-6,0 L-3.5,2.5 M6,0 L3.5,-2.5 M6,0 L3.5,2.5" stroke={COLOUR} strokeWidth={1.4} fill="none" strokeLinecap="round" />
                </>
              )}
              <circle r={14} fill="none" stroke={COLOUR} strokeWidth={2} className="opacity-0 group-focus-visible:opacity-60" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
