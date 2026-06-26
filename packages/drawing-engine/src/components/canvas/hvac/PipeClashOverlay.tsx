import { useEffect, useMemo, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva/lib/ReactKonvaCore';
import 'konva/lib/shapes/Circle';
import 'konva/lib/shapes/Line';
import 'konva/lib/shapes/Rect';
import 'konva/lib/shapes/Text';

import type { HvacElement, Point2D } from '../../../types';
import { MM_TO_PX } from '../scale';

import { PipeClashSuggestionCard } from './PipeClashSuggestionCard';
import {
  normalizeBypasses,
  type BypassRoutingMode,
  type PipeBypass,
  type PipeLineKind,
} from './pipeBypass';
import { planBundleBypasses } from './pipeClashRouting';

export interface PipeClashOverlayProps {
  enabled: boolean;
  width: number;
  height: number;
  viewportZoom: number;
  panOffset: Point2D;
  hvacElements: HvacElement[];
  selectedIds: string[];
  updateHvacElement: (
    id: string,
    updates: Partial<HvacElement>,
    options?: { skipHistory?: boolean },
  ) => void;
  setProcessingStatus?: (status: string, isProcessing: boolean) => void;
}

const GAS_COLOR = '#ea580c';
const LIQUID_COLOR = '#2563eb';
const SHADOW_COLOR = 'rgba(15,23,42,0.20)';
const CONFLICT_FILL = 'rgba(244,63,94,0.14)';
const CONFLICT_STROKE = 'rgba(244,63,94,0.65)';
const CASING_COLOR = '#ffffff';

interface PipeBypassVisual {
  elementId: string;
  bundleId: string;
  lineKind: PipeLineKind;
  outerDiameterMm: number;
  bypass: PipeBypass;
  selected: boolean;
}

function lineColor(lineKind: PipeLineKind): string {
  return lineKind === 'liquid' ? LIQUID_COLOR : GAS_COLOR;
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(point: Point2D, factor: number): Point2D {
  return { x: point.x * factor, y: point.y * factor };
}

function normalize(point: Point2D): Point2D {
  const length = Math.hypot(point.x, point.y);
  if (length < 1e-6) {
    return { x: 1, y: 0 };
  }
  return { x: point.x / length, y: point.y / length };
}

function readBundleId(element: HvacElement): string {
  const value = (element.properties as { bundleId?: unknown }).bundleId;
  return typeof value === 'string' ? value : element.id;
}

function readLineKind(element: HvacElement): PipeLineKind {
  const value = (element.properties as { lineKind?: unknown }).lineKind;
  return value === 'liquid' ? 'liquid' : 'gas';
}

function readOuterDiameterMm(element: HvacElement): number {
  const value = (element.properties as { outerDiameterMm?: unknown }).outerDiameterMm;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 19;
}

/** Local (pre-zoom) point: world mm scaled to the Konva layer's coordinate space. */
function toLocal(point: Point2D): Point2D {
  return { x: point.x * MM_TO_PX, y: point.y * MM_TO_PX };
}

function flat(points: Point2D[]): number[] {
  return points.flatMap((point) => [point.x, point.y]);
}

/** Semicircular crossover "hop" centred on `center`, bumping along `perp`. */
function buildHopPoints(
  center: Point2D,
  tangent: Point2D,
  perp: Point2D,
  radius: number,
): Point2D[] {
  const steps = 18;
  const points: Point2D[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = (Math.PI * index) / steps;
    const along = -Math.cos(angle) * radius;
    const out = Math.sin(angle) * radius;
    points.push(
      add(center, add(scale(tangent, along), scale(perp, out))),
    );
  }
  return points;
}

export function PipeClashOverlay({
  enabled,
  width,
  height,
  viewportZoom,
  panOffset,
  hvacElements,
  selectedIds,
  updateHvacElement,
  setProcessingStatus,
}: PipeClashOverlayProps): JSX.Element | null {
  const [dismissedBundleId, setDismissedBundleId] = useState<string | null>(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const visuals = useMemo<PipeBypassVisual[]>(() => {
    const result: PipeBypassVisual[] = [];
    hvacElements.forEach((element) => {
      if (element.type !== 'refrigerant-pipe') {
        return;
      }
      const bypasses = normalizeBypasses(
        (element.properties as { bypasses?: unknown }).bypasses,
      );
      if (bypasses.length === 0) {
        return;
      }
      const bundleId = readBundleId(element);
      const lineKind = readLineKind(element);
      const outerDiameterMm = readOuterDiameterMm(element);
      const selected = selectedSet.has(element.id);
      bypasses.forEach((bypass) => {
        result.push({ elementId: element.id, bundleId, lineKind, outerDiameterMm, bypass, selected });
      });
    });
    return result;
  }, [hvacElements, selectedSet]);

  // The selected refrigerant-pipe bundle (if any), used to detect clashes live.
  const selectedBundleId = useMemo(() => {
    const selected = hvacElements.find(
      (element) => element.type === 'refrigerant-pipe' && selectedSet.has(element.id),
    );
    return selected ? readBundleId(selected) : null;
  }, [hvacElements, selectedSet]);

  const selectedBundleElementIds = useMemo(() => {
    if (!selectedBundleId) {
      return [];
    }
    return hvacElements
      .filter(
        (element) =>
          element.type === 'refrigerant-pipe' && readBundleId(element) === selectedBundleId,
      )
      .map((element) => element.id);
  }, [hvacElements, selectedBundleId]);

  const selectedBundleHasBaked = useMemo(
    () => visuals.some((visual) => visual.bundleId === selectedBundleId),
    [visuals, selectedBundleId],
  );

  // Live clash detection: when a bundle is selected but has no applied offset,
  // detect crossings on demand so the user can opt in to a bypass via the card.
  const livePreview = useMemo(() => {
    if (
      !selectedBundleId ||
      selectedBundleHasBaked ||
      selectedBundleId === dismissedBundleId ||
      selectedBundleElementIds.length === 0
    ) {
      return null;
    }
    let plan;
    try {
      plan = planBundleBypasses(hvacElements, selectedBundleElementIds, { mode: 'auto' });
    } catch {
      return null;
    }
    if (plan.clashCount === 0) {
      return null;
    }
    const previewVisuals: PipeBypassVisual[] = [];
    hvacElements.forEach((element) => {
      if (element.type !== 'refrigerant-pipe') {
        return;
      }
      const bypasses = plan.byElementId.get(element.id);
      if (!bypasses || bypasses.length === 0) {
        return;
      }
      const lineKind = readLineKind(element);
      const outerDiameterMm = readOuterDiameterMm(element);
      bypasses.forEach((bypass) => {
        previewVisuals.push({
          elementId: element.id,
          bundleId: selectedBundleId,
          lineKind,
          outerDiameterMm,
          bypass,
          selected: true,
        });
      });
    });
    const representative = previewVisuals[0]?.bypass;
    if (!representative) {
      return null;
    }
    const clashCount = Math.max(
      ...selectedBundleElementIds.map(
        (id) => previewVisuals.filter((visual) => visual.elementId === id).length,
      ),
      1,
    );
    return {
      visuals: previewVisuals,
      card: {
        bundleId: selectedBundleId,
        elementIds: selectedBundleElementIds,
        anchor: representative.obstaclePoint,
        direction: representative.direction,
        recommended: plan.recommendedDirection ?? representative.direction,
        clearanceMm: representative.clearanceMm,
        reason: representative.reason || 'Crossing detected — apply an offset to clear it.',
        isAuto: true,
        clashCount,
      },
    };
  }, [
    hvacElements,
    selectedBundleElementIds,
    selectedBundleId,
    selectedBundleHasBaked,
    dismissedBundleId,
  ]);

  // The bundle whose suggestion card is shown: a selected pipe that has bypasses.
  const bakedActiveBundle = useMemo(() => {
    const selectedVisual = visuals.find((visual) => visual.selected);
    if (!selectedVisual || selectedVisual.bundleId === dismissedBundleId) {
      return null;
    }
    const bundleId = selectedVisual.bundleId;
    const elementIds = Array.from(
      new Set(
        hvacElements
          .filter(
            (element) =>
              element.type === 'refrigerant-pipe' && readBundleId(element) === bundleId,
          )
          .map((element) => element.id),
      ),
    );
    const bundleBypasses = visuals.filter((visual) => visual.bundleId === bundleId);
    const representative = bundleBypasses[0]!.bypass;
    const clashCount = Math.max(
      ...elementIds.map(
        (id) => bundleBypasses.filter((visual) => visual.elementId === id).length,
      ),
      1,
    );
    const isAuto = bundleBypasses.every((visual) => visual.bypass.auto);
    return {
      bundleId,
      elementIds,
      anchor: representative.obstaclePoint,
      direction: representative.direction,
      recommended: isAuto ? representative.direction : null,
      clearanceMm: representative.clearanceMm,
      reason: representative.reason,
      isAuto,
      clashCount,
    };
  }, [visuals, hvacElements, dismissedBundleId]);

  // An applied bypass (edit its direction) takes priority over a live proposal.
  const activeCard = bakedActiveBundle ?? livePreview?.card ?? null;

  // Reset the dismissed flag when the selection moves to a different bundle.
  useEffect(() => {
    if (!activeCard && dismissedBundleId && selectedBundleId !== dismissedBundleId) {
      setDismissedBundleId(null);
    }
  }, [activeCard, dismissedBundleId, selectedBundleId]);

  const handleSelectDirection = (mode: BypassRoutingMode): void => {
    if (!activeCard) {
      return;
    }
    const plan = planBundleBypasses(hvacElements, activeCard.elementIds, { mode });
    activeCard.elementIds.forEach((id) => {
      updateHvacElement(id, {
        properties: { bypasses: plan.byElementId.get(id) ?? [] },
      });
    });
    if (setProcessingStatus) {
      const label = mode === 'auto' ? 'Auto offset' : `Offset ${mode}`;
      setProcessingStatus(`${label} applied · ${activeCard.clearanceMm} mm clearance`, false);
    }
  };

  if (
    !enabled ||
    width <= 0 ||
    height <= 0 ||
    (visuals.length === 0 && !livePreview)
  ) {
    return null;
  }

  const stageOffsetX = -panOffset.x * viewportZoom;
  const stageOffsetY = -panOffset.y * viewportZoom;
  const safeZoom = Math.max(viewportZoom, 0.01);
  const inv = 1 / safeZoom; // keeps UI glyph sizes constant on screen

  const cardScreen = activeCard
    ? {
        x: stageOffsetX + viewportZoom * activeCard.anchor.x * MM_TO_PX,
        y: stageOffsetY + viewportZoom * activeCard.anchor.y * MM_TO_PX,
      }
    : null;

  return (
    <>
      <div className="absolute left-0 top-0 z-[8]" style={{ pointerEvents: 'none' }}>
        <Stage width={width} height={height} listening={false}>
          <Layer
            x={stageOffsetX}
            y={stageOffsetY}
            scaleX={viewportZoom}
            scaleY={viewportZoom}
            listening={false}
          >
            {visuals.map((visual, index) => (
              <BypassShape
                key={`${visual.elementId}-${visual.bypass.id}-${index}`}
                visual={visual}
                inv={inv}
              />
            ))}
            {livePreview && (
              <Group opacity={0.42}>
                {livePreview.visuals.map((visual, index) => (
                  <BypassShape
                    key={`preview-${visual.elementId}-${visual.bypass.id}-${index}`}
                    visual={visual}
                    inv={inv}
                  />
                ))}
              </Group>
            )}
          </Layer>
        </Stage>
      </div>
      {activeCard && cardScreen && (
        <PipeClashSuggestionCard
          screenX={cardScreen.x}
          screenY={cardScreen.y}
          direction={activeCard.direction}
          recommended={activeCard.recommended}
          clearanceMm={activeCard.clearanceMm}
          clashCount={activeCard.clashCount}
          isAuto={activeCard.isAuto}
          reason={activeCard.reason}
          onSelect={handleSelectDirection}
          onClose={() => setDismissedBundleId(activeCard.bundleId)}
        />
      )}
    </>
  );
}

interface BypassShapeProps {
  visual: PipeBypassVisual;
  inv: number;
}

function BypassShape({ visual, inv }: BypassShapeProps): JSX.Element | null {
  const { bypass, lineKind, outerDiameterMm, selected } = visual;
  const tangentRaw = subtract(bypass.exitPoint, bypass.enterPoint);
  if (Math.hypot(tangentRaw.x, tangentRaw.y) < 1e-3) {
    return null;
  }
  // Work entirely in the layer's local space (world mm * MM_TO_PX). Direction
  // vectors are scale-invariant; screen-constant sizes are `px * inv`.
  const tangent = normalize(tangentRaw);
  const perp = { x: -tangent.y, y: tangent.x };
  const color = lineColor(lineKind);
  const isAbove = bypass.direction === 'above';

  const enter = toLocal(bypass.enterPoint);
  const exit = toLocal(bypass.exitPoint);
  const obstacle = toLocal(bypass.obstaclePoint);

  const odLocal = outerDiameterMm * MM_TO_PX;
  const innerWidth = Math.max(odLocal, 3);
  const casingWidth = innerWidth + 4 * inv;

  // Conflict highlight band centred on the obstacle, oriented along the route.
  const bandLength = Math.max(outerDiameterMm * 2.4, 220) * MM_TO_PX;
  const bandWidth = Math.max(outerDiameterMm * 1.8, 150) * MM_TO_PX;

  // Crossover hop (above), sized to the pipe.
  const hopRadius = Math.max(odLocal * 0.85, 38 * MM_TO_PX);
  const hopPoints = buildHopPoints(obstacle, tangent, perp, hopRadius);

  // Below: dashed span with a visible break at the crossing.
  const gapHalf = scale(tangent, hopRadius);
  const beforeGap = subtract(obstacle, gapHalf);
  const afterGap = add(obstacle, gapHalf);

  // Drop shadow offset (screen-constant) to imply the raised span.
  const shadowOffset = scale(perp, 5 * inv);

  // Label chip placement (screen-constant offset to one side of the crossing).
  const calloutAnchor = add(obstacle, scale(perp, hopRadius + 22 * inv));
  const labelText = `Offset ${isAbove ? 'Above' : 'Below'} +${Math.round(bypass.clearanceMm)} mm Clearance`;
  const fontSize = 11 * inv;
  const labelWidth = labelText.length * fontSize * 0.56 + 14 * inv;
  const labelHeight = fontSize + 8 * inv;

  return (
    <Group>
      {/* conflict highlight */}
      <Rect
        x={obstacle.x}
        y={obstacle.y}
        width={bandLength}
        height={bandWidth}
        offsetX={bandLength / 2}
        offsetY={bandWidth / 2}
        rotation={(Math.atan2(tangent.y, tangent.x) * 180) / Math.PI}
        cornerRadius={6 * inv}
        fill={CONFLICT_FILL}
        stroke={CONFLICT_STROKE}
        strokeWidth={1.2 * inv}
        dash={[6 * inv, 4 * inv]}
        listening={false}
      />

      {isAbove ? (
        <>
          {/* drop shadow of the raised span */}
          <Line
            points={flat([
              add(enter, shadowOffset),
              add(obstacle, shadowOffset),
              add(exit, shadowOffset),
            ])}
            stroke={SHADOW_COLOR}
            strokeWidth={casingWidth}
            lineCap="round"
            lineJoin="round"
            listening={false}
          />
          {/* white casing + coloured raised pipe span */}
          <Line points={flat([enter, obstacle, exit])} stroke={CASING_COLOR} strokeWidth={casingWidth} lineCap="round" lineJoin="round" listening={false} />
          <Line points={flat([enter, obstacle, exit])} stroke={color} strokeWidth={innerWidth} lineCap="round" lineJoin="round" opacity={0.95} listening={false} />
          {/* crossover hop */}
          <Line points={flat(hopPoints)} stroke={CASING_COLOR} strokeWidth={casingWidth} lineCap="round" lineJoin="round" listening={false} />
          <Line points={flat(hopPoints)} stroke={color} strokeWidth={innerWidth} lineCap="round" lineJoin="round" listening={false} />
        </>
      ) : (
        <>
          {/* dashed under-run with a break at the crossing */}
          <Line points={flat([enter, beforeGap])} stroke={color} strokeWidth={innerWidth} lineCap="round" opacity={0.55} dash={[14 * inv, 9 * inv]} listening={false} />
          <Line points={flat([afterGap, exit])} stroke={color} strokeWidth={innerWidth} lineCap="round" opacity={0.55} dash={[14 * inv, 9 * inv]} listening={false} />
        </>
      )}

      {/* enter / exit fitting glyphs */}
      <Circle x={enter.x} y={enter.y} radius={3.4 * inv} fill={color} stroke={CASING_COLOR} strokeWidth={1.4 * inv} listening={false} />
      <Circle x={exit.x} y={exit.y} radius={3.4 * inv} fill={color} stroke={CASING_COLOR} strokeWidth={1.4 * inv} listening={false} />

      {/* leader + label chip */}
      <Line points={flat([obstacle, calloutAnchor])} stroke={CONFLICT_STROKE} strokeWidth={1 * inv} dash={[3 * inv, 3 * inv]} listening={false} />
      <Rect
        x={calloutAnchor.x}
        y={calloutAnchor.y - labelHeight / 2}
        width={labelWidth}
        height={labelHeight}
        cornerRadius={4 * inv}
        fill="rgba(15,23,42,0.88)"
        listening={false}
      />
      <Text
        x={calloutAnchor.x + 7 * inv}
        y={calloutAnchor.y - fontSize / 2}
        text={labelText}
        fontSize={fontSize}
        fontStyle="600"
        fill="#ffffff"
        listening={false}
      />

      {/* clearance dimension (shown when the bundle is selected) */}
      {selected && (
        <ClearanceDimension
          obstacle={obstacle}
          tangent={tangent}
          perp={perp}
          isAbove={isAbove}
          riseMm={bypass.riseMm}
          clearanceMm={bypass.clearanceMm}
          color={color}
          inv={inv}
        />
      )}
    </Group>
  );
}

interface ClearanceDimensionProps {
  /** Crossing point in the layer's local space. */
  obstacle: Point2D;
  tangent: Point2D;
  perp: Point2D;
  isAbove: boolean;
  riseMm: number;
  clearanceMm: number;
  color: string;
  inv: number;
}

/** Mini elevation callout: two pipe-level bars + a dimension arrow labelled in mm. */
function ClearanceDimension({
  obstacle,
  tangent,
  perp,
  isAbove,
  riseMm,
  clearanceMm,
  color,
  inv,
}: ClearanceDimensionProps): JSX.Element {
  // All sizes are screen-constant (px * inv) in the local layer space.
  const sideSign = isAbove ? -1 : 1;
  const barHalf = 26 * inv;
  const separation = 22 * inv;
  const arrowHead = 4 * inv;
  const fontSize = 10 * inv;

  const glyphCenter = add(obstacle, scale(tangent, -70 * inv));
  const existingLevel = glyphCenter;
  const newLevel = add(glyphCenter, scale(perp, sideSign * separation));

  const existingBar: Point2D[] = [
    add(existingLevel, scale(tangent, -barHalf)),
    add(existingLevel, scale(tangent, barHalf)),
  ];
  const newBar: Point2D[] = [
    add(newLevel, scale(tangent, -barHalf)),
    add(newLevel, scale(tangent, barHalf)),
  ];

  const textAnchor = add(
    add(glyphCenter, scale(perp, sideSign * (separation / 2))),
    scale(tangent, barHalf + 6 * inv),
  );

  return (
    <Group>
      {/* new pipe level bar */}
      <Line points={flat(newBar)} stroke={color} strokeWidth={2 * inv} lineCap="round" listening={false} />
      {/* existing pipe level bar */}
      <Line points={flat(existingBar)} stroke="#475569" strokeWidth={2 * inv} lineCap="round" listening={false} />
      {/* dimension line */}
      <Line points={flat([newLevel, existingLevel])} stroke="#0f172a" strokeWidth={1.1 * inv} listening={false} />
      {/* arrow heads */}
      <Line
        points={flat([
          add(newLevel, add(scale(tangent, -arrowHead), scale(perp, -sideSign * arrowHead))),
          newLevel,
          add(newLevel, add(scale(tangent, arrowHead), scale(perp, -sideSign * arrowHead))),
        ])}
        stroke="#0f172a"
        strokeWidth={1.1 * inv}
        listening={false}
      />
      <Line
        points={flat([
          add(existingLevel, add(scale(tangent, -arrowHead), scale(perp, sideSign * arrowHead))),
          existingLevel,
          add(existingLevel, add(scale(tangent, arrowHead), scale(perp, sideSign * arrowHead))),
        ])}
        stroke="#0f172a"
        strokeWidth={1.1 * inv}
        listening={false}
      />
      <Text
        x={textAnchor.x}
        y={textAnchor.y - fontSize / 2}
        text={`${Math.round(clearanceMm)} mm clear · Δ${Math.round(riseMm)} mm ${isAbove ? 'up' : 'down'}`}
        fontSize={fontSize}
        fontStyle="600"
        fill="#0f172a"
        listening={false}
      />
    </Group>
  );
}
