'use client';

/**
 * The resize grips of the straight whose card is pinned on the plan: its two
 * ends (its length), its two sides (its width) and a flexible runout's start
 * (its length), those that can move; and the slide grip of a small piece whose
 * card is pinned (a take-off, an accessory, a transition), which moves it
 * along its duct. A press starts the move session's resize
 * mode (the readout at the cursor, the duct drawn as it will be, a typed
 * number, Esc, one undo). While it drags, the grip rides on the duct as it will
 * be, with the length or width it is taking dimensioned beside it.
 *
 * A grip is a slider for the keyboard: focused (Tab), the arrow keys step it
 * (Shift: five steps; Alt: 1 mm; a round duct: the next stocked size), each
 * step one undo. Drawn in screen pixels over the plan's layers.
 */
import { useMemo, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import type { HvacElement, Point2D } from '../../../../types';
import { MM_TO_PX } from '../../scale';
import { ductLegs } from '../duct/ductGeometry';
import { domainOf, useDuctSegmentUiStore } from '../duct/ductSegmentUiStore';
import type { DuctDesignSettings } from '../duct/ductSettings';
import { ductRoundSizesMm } from '../duct/ductSizeCatalog';
import { readDuctRunSpec } from '../duct/ductTypes';

import { RESIZE_LENGTH_STEP_MM, ductResizeGrips, resizeSectionStepMm, snapResizeValue, type DuctResizeGrip } from './ductResize';
import { useDuctResizePreviewStore } from './ductResizePreviewStore';
import type { HvacResizeBegin } from './hvacMoveSession';

const COLOUR = '#0369a1';
/** A slide grip (a piece moved along its duct, not sized). */
const SLIDE_COLOUR = '#0f766e';
/** A side grip sits at least this far off the centreline on screen (a duct only a few pixels wide). */
const MIN_SIDE_PX = 14;
/** How far beyond the duct's side a length dimension runs while dragging (px). */
const DIMENSION_OFFSET_PX = 30;

const formatMm = (value: number) => Math.round(value).toLocaleString('en-GB');

/** The resize cursor for a drag along `axis` (plan, y down like the screen). */
export function cursorFor(axis: { x: number; y: number }): string {
  const angle = (((Math.atan2(axis.y, axis.x) * 180) / Math.PI) % 180 + 180) % 180;
  if (angle < 22.5 || angle >= 157.5) return 'ew-resize';
  if (angle < 67.5) return 'nwse-resize';
  if (angle < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

export function gripName(grip: DuctResizeGrip, subject: string): string {
  if (grip.kind === 'slide') return `Place of ${subject} along its duct`;
  if (grip.kind === 'runout') return `Length of ${subject}`;
  if (grip.kind === 'width') return `${grip.round ? 'Diameter' : 'Width'} of ${subject}`;
  if (grip.kind === 'depth') return `${grip.round ? 'Diameter' : 'Depth'} of ${subject}`;
  return `Length of ${subject} (${grip.kind === 'length-end' ? 'its far end' : 'its near end'})`;
}

/** The value one arrow-key step makes (Shift: five steps; Alt: 1 mm; a round section: the next stocked size). */
export function steppedValue(grip: DuctResizeGrip, direction: 1 | -1, event: { shiftKey: boolean; altKey: boolean }, settings: DuctDesignSettings): number {
  if (event.altKey) return snapResizeValue(grip, grip.value + direction, settings, true);
  const sectional = grip.kind === 'width' || grip.kind === 'depth';
  if (sectional && grip.round) {
    const stock = ductRoundSizesMm(settings).sort((a, b) => a - b);
    const next = direction > 0 ? stock.find((size) => size > grip.value + 0.5) : [...stock].reverse().find((size) => size < grip.value - 0.5);
    return next ?? grip.value;
  }
  const step = (sectional ? resizeSectionStepMm(settings) : RESIZE_LENGTH_STEP_MM) * (event.shiftKey ? 5 : 1);
  const snapped = snapResizeValue(grip, grip.value + direction * step, settings);
  // (A value off the grid steps onto it; one already on it moves a whole step.)
  return Math.abs(snapped - grip.value) < 0.5 ? snapResizeValue(grip, grip.value + 2 * direction * step, settings) : snapped;
}

/** What a pinned piece is called on its grips ("straight 2", "the take-off"). */
export function gripSubject(key: string, hvacElements: readonly HvacElement[], runId: string): string {
  if (key === 'end:flex') return 'the runout';
  if (key === 'start:takeoff') return 'the take-off';
  if (key.startsWith('inline:')) return 'the accessory';
  if (key.startsWith('transition:')) return 'the transition';
  const element = hvacElements.find((candidate) => candidate.id === runId);
  const spec = element ? readDuctRunSpec(element) : null;
  const index = Number(/^leg:(\d+)$/.exec(key)?.[1] ?? -1);
  return `${spec && ductLegs(spec)[index]?.vertical ? 'riser' : 'straight'} ${index + 1}`;
}

/** The grip a drag is moving, where it is in the drawing as it will be (a slid transition by its key there). */
export function draggedGrip(scene: readonly HvacElement[], settings: DuctDesignSettings, preview: { grip: DuctResizeGrip; key?: string }, key: string): DuctResizeGrip | null {
  const { grip } = preview;
  return ductResizeGrips(scene, settings, grip.runId, preview.key ?? key, { probe: false })
    .find((candidate) => candidate.kind === grip.kind && candidate.side === grip.side) ?? null;
}

/** A slide grip's face: a capsule along its duct with an arrow each way and a dot (the piece). */
export function SlideGripFace() {
  return (
    <>
      <rect x={-14} y={-7} width={28} height={14} rx={7} fill="#ffffff" stroke={SLIDE_COLOUR} strokeWidth={1.6}
        className="transition-colors group-hover:fill-teal-50 group-focus-visible:fill-teal-100" />
      <path d="M-10,0 L-6,-3.5 L-6,3.5 Z M10,0 L6,-3.5 L6,3.5 Z" fill={SLIDE_COLOUR} />
      <circle r={2.2} fill={SLIDE_COLOUR} />
    </>
  );
}

export function DuctResizeGrips(props: {
  enabled: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: readonly HvacElement[];
  settings: DuctDesignSettings;
  onBeginResize?: (request: HvacResizeBegin) => boolean;
  /** A grip stepped from the keyboard to `value` (one undo step). */
  onStep?: (grip: DuctResizeGrip, value: number) => void;
}) {
  const { enabled, width, height, viewportZoom, panOffset, hvacElements, settings, onBeginResize, onStep } = props;
  const pinned = useDuctSegmentUiStore((state) => state.pinned);
  const preview = useDuctResizePreviewStore((state) => state.preview);
  const focus = enabled && pinned && pinned.view === '2d' && domainOf(pinned) === 'duct' ? pinned : null;

  // The grips that can move, in the drawing as stored (a few trial edits each: once per pin or change).
  const grips = useMemo(
    () => (focus ? ductResizeGrips(hvacElements, settings, focus.runId, focus.key).filter((grip) => grip.kind !== 'depth') : []),
    [focus, hvacElements, settings],
  );
  const subject = useMemo(() => (focus ? gripSubject(focus.key, hvacElements, focus.runId) : ''), [focus, hvacElements]);

  // While a grip is dragged: it, where it is on the duct as it will be.
  const dragging = preview && focus && preview.grip.runId === focus.runId ? preview : null;
  const dragScene = useMemo(() => {
    if (!dragging) return null;
    const replaced = new Map(dragging.elements.map((element) => [element.id, element]));
    return hvacElements.map((element) => replaced.get(element.id) ?? element);
  }, [dragging, hvacElements]);
  const dragged = useMemo(() => (dragging && dragScene && focus ? draggedGrip(dragScene, settings, dragging, focus.key) : null), [dragging, dragScene, focus, settings]);

  if (!focus || (!grips.length && !dragged)) return null;
  const k = MM_TO_PX * viewportZoom;
  const toScreen = (point: { x: number; y: number }) => ({ x: -panOffset.x * viewportZoom + point.x * k, y: -panOffset.y * viewportZoom + point.y * k });

  const shown = dragged ? [dragged] : grips;

  const press = (event: ReactPointerEvent<SVGGElement>, grip: DuctResizeGrip) => {
    if (event.button !== 0 || !onBeginResize) return;
    if (!onBeginResize({ grip, clientX: event.clientX, clientY: event.clientY })) return;
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

  // The dimension a dragged grip is taking: a straight's length beside it, or its width across it.
  let dimension: ReactNode = null;
  if (dragging && dragScene && dragged) {
    const element = dragScene.find((candidate) => candidate.id === dragging.grip.runId);
    const spec = element ? readDuctRunSpec(element) : null;
    const geometry = spec ? ductLegs(spec)[dragging.grip.legIndex] : undefined;
    const section = spec?.legs[dragging.grip.legIndex];
    if (spec && geometry && section && !geometry.vertical && (dragging.grip.kind === 'length-end' || dragging.grip.kind === 'length-start')) {
      const a = toScreen(geometry.start);
      const b = toScreen(geometry.end);
      const left = { x: -geometry.direction.y, y: geometry.direction.x };
      const centre = spec.path.reduce((sum, point) => ({ x: sum.x + point.x / spec.path.length, y: sum.y + point.y / spec.path.length }), { x: 0, y: 0 });
      const middle = { x: (geometry.start.x + geometry.end.x) / 2, y: (geometry.start.y + geometry.end.y) / 2 };
      const side = (centre.x - middle.x) * left.x + (centre.y - middle.y) * left.y > 1 ? -1 : 1;
      const n = { x: left.x * side, y: left.y * side };
      const off = ((section.diameterMm ?? section.widthMm) / 2 + spec.insulationThicknessMm) * k + DIMENSION_OFFSET_PX;
      const at = (point: Point2D, distance: number) => ({ x: point.x + n.x * distance, y: point.y + n.y * distance });
      const a2 = at(a, off);
      const b2 = at(b, off);
      let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle <= -90) angle += 180;
      const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
      dimension = (
        <g data-testid="duct-resize-dimension">
          <path d={`M${at(a, off - 22).x},${at(a, off - 22).y} L${at(a, off + 6).x},${at(a, off + 6).y} M${at(b, off - 22).x},${at(b, off - 22).y} L${at(b, off + 6).x},${at(b, off + 6).y}`}
            stroke={COLOUR} strokeWidth={0.9} fill="none" />
          <path d={`M${a2.x},${a2.y} L${b2.x},${b2.y}`} stroke={COLOUR} strokeWidth={1.2} fill="none" />
          <g transform={`translate(${mid.x} ${mid.y}) rotate(${angle})`}>
            <rect x={-26} y={-9} width={52} height={18} rx={4} fill="#0369a1" />
            <text x={0} y={4} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="#ffffff" style={{ fontFamily: 'ui-monospace, monospace' }}>{formatMm(dragging.made)}</text>
          </g>
        </g>
      );
    } else if (dragged.slide && dragging.grip.kind === 'slide') {
      // A slid piece: how far it is from where its place is measured (the main's leg start, its own leg's, its straight's).
      const a = toScreen(dragged.slide.origin);
      const b = toScreen(dragged.point);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > 1) {
        const n = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
        const off = 20;
        const a2 = { x: a.x + n.x * off, y: a.y + n.y * off };
        const b2 = { x: b.x + n.x * off, y: b.y + n.y * off };
        let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle <= -90) angle += 180;
        const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
        dimension = (
          <g data-testid="duct-resize-dimension">
            <path d={`M${a.x},${a.y} L${a2.x + n.x * 5},${a2.y + n.y * 5} M${b.x},${b.y} L${b2.x + n.x * 5},${b2.y + n.y * 5}`} stroke={SLIDE_COLOUR} strokeWidth={0.9} fill="none" />
            <path d={`M${a2.x},${a2.y} L${b2.x},${b2.y}`} stroke={SLIDE_COLOUR} strokeWidth={1.2} fill="none" />
            <g transform={`translate(${mid.x} ${mid.y}) rotate(${angle})`}>
              <rect x={-26} y={-9} width={52} height={18} rx={4} fill={SLIDE_COLOUR} />
              <text x={0} y={4} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="#ffffff" style={{ fontFamily: 'ui-monospace, monospace' }}>{formatMm(dragging.made)}</text>
            </g>
          </g>
        );
      }
    } else if (spec && geometry && section && !geometry.vertical && dragging.grip.kind === 'width') {
      const halfMm = (section.diameterMm ?? section.widthMm) / 2;
      const left = { x: -geometry.direction.y, y: geometry.direction.x };
      // Across the duct, a third of the way along (clear of the grips at its middle).
      const third = { x: geometry.start.x + (geometry.end.x - geometry.start.x) / 3, y: geometry.start.y + (geometry.end.y - geometry.start.y) / 3 };
      const a = toScreen({ x: third.x + left.x * halfMm, y: third.y + left.y * halfMm });
      const b = toScreen({ x: third.x - left.x * halfMm, y: third.y - left.y * halfMm });
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      dimension = (
        <g data-testid="duct-resize-dimension">
          <path d={`M${a.x},${a.y} L${b.x},${b.y}`} stroke={COLOUR} strokeWidth={1.2} fill="none" markerStart="url(#duct-resize-tick)" markerEnd="url(#duct-resize-tick)" />
          <rect x={mid.x - 22} y={mid.y - 9} width={44} height={18} rx={4} fill="#0369a1" />
          <text x={mid.x} y={mid.y + 4} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="#ffffff" style={{ fontFamily: 'ui-monospace, monospace' }}>{formatMm(dragging.made)}</text>
        </g>
      );
    }
  }

  return (
    <div className="pointer-events-none absolute left-0 top-0 z-[14] overflow-hidden" style={{ width, height }} data-testid="duct-resize-grips">
      <svg width={width} height={height} className="absolute left-0 top-0" style={{ pointerEvents: 'none' }}>
        <defs>
          <marker id="duct-resize-tick" viewBox="-5 -5 10 10" markerWidth={10} markerHeight={10} orient="auto">
            <path d="M-3,3 L3,-3" stroke={COLOUR} strokeWidth={1.2} />
          </marker>
        </defs>
        {dimension}
        {shown.map((grip) => {
          let at = toScreen(grip.point);
          if (grip.base) {
            const base = toScreen(grip.base);
            const out = Math.hypot(at.x - base.x, at.y - base.y);
            if (out < MIN_SIDE_PX) at = { x: base.x + grip.axis.x * MIN_SIDE_PX, y: base.y + grip.axis.y * MIN_SIDE_PX };
          }
          const angle = (Math.atan2(grip.axis.y, grip.axis.x) * 180) / Math.PI;
          const name = gripName(grip, subject);
          const sectional = grip.kind === 'width' || grip.kind === 'depth';
          const slide = grip.kind === 'slide';
          return (
            <g
              key={`${grip.kind}${grip.side ?? ''}`}
              data-duct-resize-grip={`${grip.kind}${grip.side ? `:${grip.side}` : ''}`}
              transform={`translate(${at.x} ${at.y}) rotate(${angle})`}
              role="slider"
              tabIndex={dragged ? -1 : 0}
              aria-label={name}
              aria-valuenow={Math.round(grip.value)}
              aria-valuetext={`${formatMm(grip.value)} mm`}
              className="group outline-none"
              style={{ pointerEvents: 'all', cursor: cursorFor(grip.axis) }}
              onPointerDown={(event) => press(event, grip)}
              onKeyDown={(event) => key(event, grip)}
            >
              <title>{slide
                ? `${name}: drag along the duct (it stops where a fitting, a take-off or a wall is in the way; Alt: 1 mm; type a number for an exact place), or the arrow keys`
                : `${name}: drag (Alt: 1 mm${sectional ? '; Shift: every straight of its size' : ''}; type a number for an exact value), or the arrow keys`}</title>
              <circle r={slide ? 16 : 13} fill="transparent" />
              {slide ? <SlideGripFace /> : sectional ? (
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
              <circle r={slide ? 17 : 14} fill="none" stroke={slide ? SLIDE_COLOUR : COLOUR} strokeWidth={2} className="opacity-0 group-focus-visible:opacity-60" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
