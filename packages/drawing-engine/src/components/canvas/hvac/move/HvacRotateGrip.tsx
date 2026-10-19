'use client';

/**
 * The rotation grip of the plan: a round knob on a short stem above the
 * selected units and air terminals. Dragging it turns them about the centre of
 * their box (one block), through the rotation mode of the move session: the
 * same model, live preview, readout, snapping (15° steps and the walls' own
 * angles; Alt turns freely), typed angle and one undo step as `R` and the
 * Properties panel. Screen-sized; it waits while a drag is in progress.
 */
import { RotateCw } from 'lucide-react';
import { useMemo } from 'react';

import type { HvacElement, Point2D } from '../../../../types';
import { MM_TO_PX } from '../../scale';

import { isTurnableElement, turnPivot } from './hvacMoveModel';
import type { HvacRotateBegin } from './hvacMoveSession';

/** Stem from the selection's box to the knob, and the knob's size (screen px). */
const STEM_PX = 34;
const KNOB_PX = 26;

/** The plan corners of an element's footprint, turned. */
function corners(element: HvacElement): Point2D[] {
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const angle = ((element.rotation ?? 0) * Math.PI) / 180;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx! * element.width) / 2;
    const y = (sy! * element.depth) / 2;
    return { x: centre.x + x * Math.cos(angle) - y * Math.sin(angle), y: centre.y + x * Math.sin(angle) + y * Math.cos(angle) };
  });
}

export function HvacRotateGrip(props: {
  enabled: boolean;
  /** A drag is in progress (the grip waits). */
  hidden: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: readonly HvacElement[];
  selectedIds: readonly string[];
  onBeginRotate: (request: HvacRotateBegin) => boolean;
}) {
  const { enabled, hidden, width, height, viewportZoom, panOffset, hvacElements, selectedIds, onBeginRotate } = props;
  const turnable = useMemo(() => {
    if (!enabled) return [];
    const ids = new Set(selectedIds);
    return hvacElements.filter((element) => ids.has(element.id) && isTurnableElement(element));
  }, [enabled, hvacElements, selectedIds]);
  if (!enabled || hidden || turnable.length === 0) return null;

  const toScreen = (point: Point2D) => ({
    x: -panOffset.x * viewportZoom + point.x * MM_TO_PX * viewportZoom,
    y: -panOffset.y * viewportZoom + point.y * MM_TO_PX * viewportZoom,
  });
  const points = turnable.flatMap(corners).map(toScreen);
  const box = {
    minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)), maxY: Math.max(...points.map((point) => point.y)),
  };
  // Above the box, or below it near the top of the view.
  const above = box.minY - STEM_PX - KNOB_PX > 4;
  const stemFrom = { x: (box.minX + box.maxX) / 2, y: above ? box.minY : box.maxY };
  const knob = { x: stemFrom.x, y: above ? box.minY - STEM_PX - KNOB_PX / 2 : box.maxY + STEM_PX + KNOB_PX / 2 };
  if (knob.x < -KNOB_PX || knob.x > width + KNOB_PX || knob.y < -KNOB_PX || knob.y > height + KNOB_PX) return null;
  const label = turnable.length === 1 ? (turnable[0]!.label || 'the selection') : `the ${turnable.length} units and terminals`;

  return (
    <div className="pointer-events-none absolute left-0 top-0 z-[13] overflow-hidden" style={{ width, height }} data-testid="hvac-rotate-grip">
      <svg width={width} height={height} className="pointer-events-none absolute left-0 top-0" aria-hidden="true">
        <line x1={stemFrom.x} y1={stemFrom.y} x2={knob.x} y2={knob.y + (above ? KNOB_PX / 2 : -KNOB_PX / 2)}
          stroke="#0f766e" strokeWidth={1.2} strokeDasharray="3 2" />
      </svg>
      <button
        type="button"
        aria-label={`Rotate ${label}`}
        title={`Drag to rotate ${label} (15° steps and the walls' angles; Alt: free; type an angle). R / Shift+R: 90°.`}
        className="pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full bg-white text-teal-700 shadow-md ring-2 ring-teal-600 transition-colors hover:bg-teal-50 active:cursor-grabbing focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-500/50"
        style={{ left: knob.x, top: knob.y, width: KNOB_PX, height: KNOB_PX }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const begun = onBeginRotate({ ids: turnable.map((element) => element.id), pivot: turnPivot(turnable), clientX: event.clientX, clientY: event.clientY });
          if (begun) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <RotateCw size={14} strokeWidth={2.4} aria-hidden="true" />
      </button>
    </div>
  );
}
