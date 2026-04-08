'use client';

import React, { useMemo } from 'react';

import type { DisplayUnit, Point2D } from '../../types';

import {
  MM_TO_PX,
  PX_TO_MM,
  type PaperUnit,
  fromMillimeters,
  getAdaptiveInterval,
  getUnitLabel,
  toMillimeters,
} from './scale';

interface RulerTick {
  valueMm: number;
  pos: number;
}

interface RulerTickData {
  major: RulerTick[];
  minor: RulerTick[];
  majorStepMm: number;
}

export interface RulersProps {
  pageWidth: number;
  pageHeight: number;
  zoom: number;
  panOffset: Point2D;
  viewportWidth: number;
  viewportHeight: number;
  showRulers?: boolean;
  rulerSize?: number;
  originOffset?: Point2D;
  gridSize?: number;
  displayUnit?: DisplayUnit;
  /** Mouse position in canvas coordinates for cursor indicator */
  mousePosition?: Point2D;
  rulerMode?: 'paper' | 'real';
  paperUnit?: PaperUnit;
  realWorldUnit?: DisplayUnit;
  scaleDrawing?: number;
  scaleReal?: number;
  majorTickInterval?: number;
  tickSubdivisions?: number;
  showRulerLabels?: boolean;
}

const DEFAULT_RULER_BG = '#fff2d6';
const DEFAULT_RULER_BORDER = 'rgba(217, 177, 117, 0.9)';
const DEFAULT_RULER_TEXT = '#6b7280';
const DEFAULT_TICK_MAJOR = '#7f7f7f';
const DEFAULT_TICK_MINOR = '#b5b5b5';
const CURSOR_INDICATOR_COLOR = '#4CAF50';
const PAGE_EXTENT_FILL = 'rgba(76, 175, 80, 0.12)';
const PAGE_EDGE_COLOR = 'rgba(76, 175, 80, 0.7)';
const MIN_VISIBLE_RULER_PX = 72;
const PAGE_ATTACH_OVERLAP_PX = 1;
const DEFAULT_MAJOR_TICK_INTERVAL = 10;
const DEFAULT_TICK_SUBDIVISIONS = 10;
const RULER_MAJOR_TARGET_PX = 96;
const RULER_MIN_MINOR_PX = 3;
const MIN_TICK_MM = 0.1;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const positiveModulo = (value: number, mod: number) => (mod > 0 ? ((value % mod) + mod) % mod : 0);

function clampKeepVisible(
  start: number,
  size: number,
  minBound: number,
  maxBound: number,
  minVisiblePx = MIN_VISIBLE_RULER_PX
): number {
  if (!Number.isFinite(start) || !Number.isFinite(size) || size <= 0) return minBound;
  const span = Math.max(1, maxBound - minBound);
  const visible = clamp(Math.min(size, minVisiblePx), 1, span);
  const minStart = minBound - (size - visible);
  const maxStart = maxBound - visible;
  return clamp(start, minStart, maxStart);
}

export const Rulers: React.FC<RulersProps> = ({
  pageWidth,
  pageHeight,
  zoom,
  panOffset,
  viewportWidth,
  viewportHeight,
  showRulers = true,
  rulerSize = 24,
  originOffset = { x: 0, y: 0 },
  gridSize = 20,
  displayUnit = 'cm',
  mousePosition,
  rulerMode = 'paper',
  paperUnit = 'mm',
  realWorldUnit = displayUnit,
  scaleDrawing = 1,
  scaleReal = 50,
  majorTickInterval = DEFAULT_MAJOR_TICK_INTERVAL,
  tickSubdivisions = DEFAULT_TICK_SUBDIVISIONS,
  showRulerLabels = true,
}) => {
  if (!showRulers || viewportWidth <= 0 || viewportHeight <= 0) return null;

  const leftRulerWidth = Math.round(rulerSize * 1.2);
  const zoomScale = Math.max(zoom, 0.01);
  const safeScaleDrawing = Number.isFinite(scaleDrawing) && scaleDrawing > 0 ? scaleDrawing : 1;
  const safeScaleReal = Number.isFinite(scaleReal) && scaleReal > 0 ? scaleReal : 1;
  const paperPerRealRatio = safeScaleDrawing / safeScaleReal;
  const realPerPaperRatio = safeScaleReal / safeScaleDrawing;
  const fallbackMajorTickInterval = Math.max(gridSize * PX_TO_MM, MIN_TICK_MM);
  const safeMajorTickInterval =
    Number.isFinite(majorTickInterval) && majorTickInterval > 0
      ? majorTickInterval
      : fallbackMajorTickInterval || DEFAULT_MAJOR_TICK_INTERVAL;
  const safeTickSubdivisions =
    Number.isFinite(tickSubdivisions) && tickSubdivisions >= 2
      ? Math.max(2, Math.floor(tickSubdivisions))
      : DEFAULT_TICK_SUBDIVISIONS;
  const baseMajorStepMm = Math.max(
    rulerMode === 'real'
      ? toMillimeters(safeMajorTickInterval, realWorldUnit) * paperPerRealRatio
      : toMillimeters(safeMajorTickInterval, paperUnit),
    MIN_TICK_MM
  );
  const baseMajorStepScenePx = Math.max(baseMajorStepMm * MM_TO_PX, MIN_TICK_MM * MM_TO_PX);
  const adaptiveMajor = useMemo(
    () => getAdaptiveInterval(baseMajorStepScenePx, zoomScale, RULER_MAJOR_TARGET_PX),
    [baseMajorStepScenePx, zoomScale]
  );
  const majorStepScenePx = adaptiveMajor.stepScenePx;
  const minorStepScenePx = majorStepScenePx / safeTickSubdivisions;
  const showMinor = minorStepScenePx * zoomScale >= RULER_MIN_MINOR_PX;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const snapPx = (value: number) => Math.round(value * dpr) / dpr;

  const canvasLeft = originOffset.x;
  const canvasTop = originOffset.y;
  const canvasRight = canvasLeft + viewportWidth;
  const canvasBottom = canvasTop + viewportHeight;

  const pageLeft = canvasLeft + (-panOffset.x) * zoomScale;
  const pageTop = canvasTop + (-panOffset.y) * zoomScale;
  const pageWidthPx = Math.max(1, pageWidth * zoomScale);
  const pageHeightPx = Math.max(1, pageHeight * zoomScale);

  // Page-attached by default, clamped only when leaving viewport to keep always visible.
  const topRulerLeft = clampKeepVisible(pageLeft, pageWidthPx, canvasLeft, canvasRight);
  const topRulerTop = clamp(
    pageTop - rulerSize + PAGE_ATTACH_OVERLAP_PX,
    0,
    Math.max(0, canvasBottom - rulerSize)
  );
  const leftRulerTop = clampKeepVisible(pageTop, pageHeightPx, canvasTop, canvasBottom);
  const leftRulerLeft = clamp(
    pageLeft - leftRulerWidth + PAGE_ATTACH_OVERLAP_PX,
    0,
    Math.max(0, canvasRight - leftRulerWidth)
  );

  const horizontalRulerWidth = pageWidthPx;
  const verticalRulerHeight = pageHeightPx;

  // Compensate tick coordinate mapping when rulers are clamped.
  const sceneOffsetX = (topRulerLeft - pageLeft) / zoomScale;
  const sceneOffsetY = (leftRulerTop - pageTop) / zoomScale;

  const getTicks = (axis: 'x' | 'y'): RulerTickData => {
    const pageSizeScenePx = axis === 'x' ? pageWidth : pageHeight;
    const sceneOffset = axis === 'x' ? sceneOffsetX : sceneOffsetY;
    const rulerSpanPx = axis === 'x' ? horizontalRulerWidth : verticalRulerHeight;
    if (pageSizeScenePx <= 0 || rulerSpanPx <= 0) {
      return {
        major: [],
        minor: [],
        majorStepMm: majorStepScenePx * PX_TO_MM,
      };
    }

    if (majorStepScenePx <= 0 || minorStepScenePx <= 0) {
      return {
        major: [],
        minor: [],
        majorStepMm: majorStepScenePx * PX_TO_MM,
      };
    }

    const major: RulerTick[] = [];
    const minor: RulerTick[] = [];

    const spanScene = rulerSpanPx / zoomScale;
    const visibleStartScenePx = clamp(sceneOffset, 0, pageSizeScenePx);
    const visibleEndScenePx = clamp(sceneOffset + spanScene, 0, pageSizeScenePx);
    if (visibleEndScenePx <= visibleStartScenePx) {
      return {
        major: [],
        minor: [],
        majorStepMm: majorStepScenePx * PX_TO_MM,
      };
    }

    const firstMajor = Math.floor(visibleStartScenePx / majorStepScenePx) * majorStepScenePx;
    const lastMajor = Math.ceil(visibleEndScenePx / majorStepScenePx) * majorStepScenePx;

    const maxMajorTicks = 500;
    let count = 0;
    for (
      let valueScenePx = firstMajor;
      valueScenePx <= lastMajor && count < maxMajorTicks;
      valueScenePx += majorStepScenePx, count++
    ) {
      if (valueScenePx < 0 || valueScenePx > pageSizeScenePx + 0.001) continue;
      const majorPos = (valueScenePx - sceneOffset) * zoomScale;
      if (majorPos < -1 || majorPos > rulerSpanPx + 1) continue;

      major.push({
        valueMm: valueScenePx * PX_TO_MM,
        pos: majorPos,
      });

      if (showMinor && minorStepScenePx < majorStepScenePx) {
        const stepsPerMajor = Math.max(1, Math.round(majorStepScenePx / minorStepScenePx));
        for (let i = 1; i < stepsPerMajor; i++) {
          const minorValueScenePx = valueScenePx + i * minorStepScenePx;
          if (
            minorValueScenePx < visibleStartScenePx ||
            minorValueScenePx > visibleEndScenePx ||
            minorValueScenePx < 0 ||
            minorValueScenePx > pageSizeScenePx + 0.001
          ) {
            continue;
          }

          const minorPos = (minorValueScenePx - sceneOffset) * zoomScale;
          if (minorPos < -1 || minorPos > rulerSpanPx + 1) continue;

          minor.push({
            valueMm: minorValueScenePx * PX_TO_MM,
            pos: minorPos,
          });
        }
      }
    }

    return {
      major,
      minor,
      majorStepMm: majorStepScenePx * PX_TO_MM,
    };
  };

  const rulerData = useMemo(
    () => ({
      x: getTicks('x'),
      y: getTicks('y'),
    }),
    [
      pageWidth,
      pageHeight,
      zoomScale,
      majorStepScenePx,
      minorStepScenePx,
      showMinor,
      sceneOffsetX,
      sceneOffsetY,
      horizontalRulerWidth,
      verticalRulerHeight,
    ]
  );

  const pageStartX = (-sceneOffsetX) * zoomScale;
  const pageEndX = (pageWidth - sceneOffsetX) * zoomScale;
  const pageStartY = (-sceneOffsetY) * zoomScale;
  const pageEndY = (pageHeight - sceneOffsetY) * zoomScale;
  const visiblePageXStart = clamp(pageStartX, 0, horizontalRulerWidth);
  const visiblePageXEnd = clamp(pageEndX, 0, horizontalRulerWidth);
  const visiblePageYStart = clamp(pageStartY, 0, verticalRulerHeight);
  const visiblePageYEnd = clamp(pageEndY, 0, verticalRulerHeight);

  const cursorX = mousePosition ? (mousePosition.x - sceneOffsetX) * zoomScale : null;
  const cursorY = mousePosition ? (mousePosition.y - sceneOffsetY) * zoomScale : null;
  const unitLabel = getUnitLabel(rulerMode === 'paper' ? paperUnit : realWorldUnit);

  const toDisplayValue = (paperMm: number) => {
    if (rulerMode === 'real') {
      const realMm = paperMm * realPerPaperRatio;
      return fromMillimeters(realMm, realWorldUnit);
    }
    return fromMillimeters(paperMm, paperUnit);
  };

  const formatTickLabel = (valueMm: number, majorStepMm: number): string => {
    const value = toDisplayValue(valueMm);
    const majorStepValue = Math.abs(toDisplayValue(majorStepMm));
    const precision =
      majorStepValue < 0.01 ? 3 : majorStepValue < 0.1 ? 2 : majorStepValue < 1 ? 1 : 0;
    if (Math.abs(value) < 0.0000001) return '0';
    return value.toFixed(precision).replace(/\.0+$/, '');
  };

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
      <div
        style={{
          position: 'absolute',
          top: snapPx(topRulerTop),
          left: snapPx(leftRulerLeft),
          width: leftRulerWidth,
          height: rulerSize,
          backgroundColor: DEFAULT_RULER_BG,
          borderRight: `1px solid ${DEFAULT_RULER_BORDER}`,
          borderBottom: `1px solid ${DEFAULT_RULER_BORDER}`,
        }}
      >
        <span
          style={{
            position: 'absolute',
            right: 4,
            bottom: 3,
            fontSize: 9,
            color: DEFAULT_RULER_TEXT,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          {unitLabel}
        </span>
      </div>

      <div
        style={{
          position: 'absolute',
          top: snapPx(topRulerTop),
          left: snapPx(topRulerLeft),
          width: horizontalRulerWidth,
          height: rulerSize,
          backgroundColor: DEFAULT_RULER_BG,
          borderBottom: `1px solid ${DEFAULT_RULER_BORDER}`,
          borderRight: `1px solid ${DEFAULT_RULER_BORDER}`,
          overflow: 'hidden',
        }}
      >
        {visiblePageXEnd > visiblePageXStart && (
          <div
            style={{
              position: 'absolute',
              left: snapPx(visiblePageXStart),
              top: 0,
              width: snapPx(visiblePageXEnd - visiblePageXStart),
              height: '100%',
              backgroundColor: PAGE_EXTENT_FILL,
            }}
          />
        )}
        {pageStartX >= 0 && pageStartX <= horizontalRulerWidth && (
          <div
            style={{
              position: 'absolute',
              left: snapPx(pageStartX),
              top: 0,
              width: 1,
              height: '100%',
              backgroundColor: PAGE_EDGE_COLOR,
            }}
          />
        )}
        {pageEndX >= 0 && pageEndX <= horizontalRulerWidth && (
          <div
            style={{
              position: 'absolute',
              left: snapPx(pageEndX),
              top: 0,
              width: 1,
              height: '100%',
              backgroundColor: PAGE_EDGE_COLOR,
            }}
          />
        )}

        {rulerData.x.minor.map((tick) => {
          const midStep = rulerData.x.majorStepMm / 2;
          const majorMod = positiveModulo(tick.valueMm, rulerData.x.majorStepMm);
          const isMid = midStep > 0 && Math.abs(majorMod - midStep) < 0.001;
          return (
            <div
              key={`x-minor-${tick.valueMm}-${tick.pos}`}
              style={{
                position: 'absolute',
                left: snapPx(tick.pos),
                bottom: 0,
                width: 1,
                height: isMid ? 9 : 6,
                backgroundColor: DEFAULT_TICK_MINOR,
              }}
            />
          );
        })}

        {rulerData.x.major.map((tick) => (
          <React.Fragment key={`x-major-${tick.valueMm}-${tick.pos}`}>
            <div
              style={{
                position: 'absolute',
                left: snapPx(tick.pos),
                bottom: 0,
                width: 1,
                height: 12,
                backgroundColor: DEFAULT_TICK_MAJOR,
              }}
            />
            {showRulerLabels && (
              <div
                style={{
                  position: 'absolute',
                  left: snapPx(clamp(tick.pos + 3, 2, Math.max(2, horizontalRulerWidth - 26))),
                  top: 2,
                  fontSize: 9,
                  color: DEFAULT_RULER_TEXT,
                  whiteSpace: 'nowrap',
                }}
              >
                {formatTickLabel(tick.valueMm, rulerData.x.majorStepMm)}
              </div>
            )}
          </React.Fragment>
        ))}

        {cursorX !== null && cursorX >= 0 && cursorX <= horizontalRulerWidth && (
          <div
            style={{
              position: 'absolute',
              left: snapPx(cursorX),
              top: 0,
              width: 1,
              height: '100%',
              backgroundColor: CURSOR_INDICATOR_COLOR,
              pointerEvents: 'none',
              zIndex: 10,
            }}
          />
        )}
      </div>

      <div
        style={{
          position: 'absolute',
          top: snapPx(leftRulerTop),
          left: snapPx(leftRulerLeft),
          height: verticalRulerHeight,
          width: leftRulerWidth,
          backgroundColor: DEFAULT_RULER_BG,
          borderRight: `1px solid ${DEFAULT_RULER_BORDER}`,
          borderBottom: `1px solid ${DEFAULT_RULER_BORDER}`,
          overflow: 'hidden',
        }}
      >
        {visiblePageYEnd > visiblePageYStart && (
          <div
            style={{
              position: 'absolute',
              top: snapPx(visiblePageYStart),
              left: 0,
              height: snapPx(visiblePageYEnd - visiblePageYStart),
              width: '100%',
              backgroundColor: PAGE_EXTENT_FILL,
            }}
          />
        )}
        {pageStartY >= 0 && pageStartY <= verticalRulerHeight && (
          <div
            style={{
              position: 'absolute',
              top: snapPx(pageStartY),
              left: 0,
              height: 1,
              width: '100%',
              backgroundColor: PAGE_EDGE_COLOR,
            }}
          />
        )}
        {pageEndY >= 0 && pageEndY <= verticalRulerHeight && (
          <div
            style={{
              position: 'absolute',
              top: snapPx(pageEndY),
              left: 0,
              height: 1,
              width: '100%',
              backgroundColor: PAGE_EDGE_COLOR,
            }}
          />
        )}

        {rulerData.y.minor.map((tick) => {
          const midStep = rulerData.y.majorStepMm / 2;
          const majorMod = positiveModulo(tick.valueMm, rulerData.y.majorStepMm);
          const isMid = midStep > 0 && Math.abs(majorMod - midStep) < 0.001;
          return (
            <div
              key={`y-minor-${tick.valueMm}-${tick.pos}`}
              style={{
                position: 'absolute',
                top: snapPx(tick.pos),
                right: 0,
                height: 1,
                width: isMid ? 9 : 6,
                backgroundColor: DEFAULT_TICK_MINOR,
              }}
            />
          );
        })}

        {rulerData.y.major.map((tick) => (
          <React.Fragment key={`y-major-${tick.valueMm}-${tick.pos}`}>
            <div
              style={{
                position: 'absolute',
                top: snapPx(tick.pos),
                right: 0,
                height: 1,
                width: 12,
                backgroundColor: DEFAULT_TICK_MAJOR,
              }}
            />
            {showRulerLabels && (
              <div
                style={{
                  position: 'absolute',
                  top: clamp(Math.max(2, snapPx(tick.pos) - 6), 2, Math.max(2, verticalRulerHeight - 10)),
                  right: 14,
                  fontSize: 9,
                  color: DEFAULT_RULER_TEXT,
                  lineHeight: 1,
                  writingMode: 'horizontal-tb',
                  textOrientation: 'upright',
                  transform: 'translate(0, -50%)',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatTickLabel(tick.valueMm, rulerData.y.majorStepMm)}
              </div>
            )}
          </React.Fragment>
        ))}

        {cursorY !== null && cursorY >= 0 && cursorY <= verticalRulerHeight && (
          <div
            style={{
              position: 'absolute',
              top: snapPx(cursorY),
              left: 0,
              height: 1,
              width: '100%',
              backgroundColor: CURSOR_INDICATOR_COLOR,
              pointerEvents: 'none',
              zIndex: 10,
            }}
          />
        )}
      </div>
    </div>
  );
};

export default Rulers;
