'use client';

import React, { useCallback, useEffect, useState, useMemo } from 'react';

import { GRID_CONSTANTS, type RulerMetrics, type RulerTick, type RulerTickData } from '../../types';

export interface RulersProps {
  pageWidth: number;
  pageHeight: number;
  zoom: number;
  scrollRef: React.RefObject<HTMLDivElement>;
  canvasRef: React.RefObject<HTMLDivElement>;
  showRulers?: boolean;
  rulerSize?: number;
  toolbarGapPx?: number;
}

/**
 * Reusable Rulers component for document editors and drawing canvases.
 * Displays horizontal and vertical rulers with metric measurements (cm).
 */
export const Rulers: React.FC<RulersProps> = ({
  pageWidth,
  pageHeight,
  zoom,
  scrollRef,
  canvasRef,
  showRulers = true,
  rulerSize: customRulerSize,
  toolbarGapPx: customToolbarGapPx,
}) => {
  const [rulerMetrics, setRulerMetrics] = useState<RulerMetrics>({
    offsetX: 0,
    offsetY: 0,
    viewportWidth: 0,
    viewportHeight: 0,
  });

  const { MM_TO_PX, PX_TO_MM, RULER_GAP_X_MM, RULER_GAP_Y_MM, RULER_TOOLBAR_GAP_MM } = GRID_CONSTANTS;
  
  const editorScale = Math.max(zoom / 100, 0.01);
  const rulerSize = customRulerSize ?? Math.max(20, Math.min(36, Math.round(Math.min(pageWidth, pageHeight) * 0.03)));
  const leftRulerWidth = rulerSize * 1.2;
  const toolbarGapPx = customToolbarGapPx ?? RULER_TOOLBAR_GAP_MM * MM_TO_PX;
  const rulerGapXPx = RULER_GAP_X_MM * MM_TO_PX * editorScale;
  const rulerGapYPx = RULER_GAP_Y_MM * MM_TO_PX * editorScale;

  const gutterTop = toolbarGapPx + rulerSize + rulerGapYPx;
  const gutterLeft = leftRulerWidth + rulerGapXPx;

  const updateRulerMetrics = useCallback(() => {
    const scrollEl = scrollRef.current;
    const canvasEl = canvasRef.current;
    if (!scrollEl || !canvasEl) return;

    const scrollRect = scrollEl.getBoundingClientRect();
    const canvasRect = canvasEl.getBoundingClientRect();
    const next = {
      offsetX: canvasRect.left - scrollRect.left,
      offsetY: canvasRect.top - scrollRect.top,
      viewportWidth: scrollEl.clientWidth,
      viewportHeight: scrollEl.clientHeight,
    };

    setRulerMetrics((prev) => {
      if (
        Math.abs(prev.offsetX - next.offsetX) < 0.5 &&
        Math.abs(prev.offsetY - next.offsetY) < 0.5 &&
        prev.viewportWidth === next.viewportWidth &&
        prev.viewportHeight === next.viewportHeight
      ) {
        return prev;
      }
      return next;
    });
  }, [scrollRef, canvasRef]);

  useEffect(() => {
    if (!showRulers) return;

    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const handleScroll = () => updateRulerMetrics();
    handleScroll();

    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handleScroll);
      resizeObserver.observe(scrollEl);
      if (canvasRef.current) {
        resizeObserver.observe(canvasRef.current);
      }
    }

    return () => {
      scrollEl.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
      resizeObserver?.disconnect();
    };
  }, [showRulers, updateRulerMetrics, scrollRef, canvasRef]);

  useEffect(() => {
    if (!showRulers) return;
    updateRulerMetrics();
  }, [zoom, pageWidth, pageHeight, showRulers, updateRulerMetrics]);

  const getMajorStepMm = (scale: number) => {
    if (scale < 1.25) return 20;
    if (scale < 2.5) return 10;
    if (scale < 4.5) return 5;
    return 1;
  };

  const getMinorStepMm = (scale: number, majorStepMm: number) => {
    const mmPx = MM_TO_PX * scale;
    const candidates = [1, 2, 5];
    for (const step of candidates) {
      if (majorStepMm % step !== 0) continue;
      if (step * mmPx >= 1.5) return step;
    }
    return majorStepMm;
  };

  const getRulerTicks = useCallback((axis: 'x' | 'y'): RulerTickData => {
    const scale = Math.max(zoom / 100, 0.01);
    const offset = axis === 'x' ? rulerMetrics.offsetX : rulerMetrics.offsetY;
    const viewport = axis === 'x' ? rulerMetrics.viewportWidth : rulerMetrics.viewportHeight;
    const pageSizePx = axis === 'x' ? pageWidth : pageHeight;
    const pageSizeMm = pageSizePx * PX_TO_MM;
    const majorStep = getMajorStepMm(scale);

    if (viewport <= 0 || pageSizePx <= 0) {
      return { major: [], minor: [], majorStep };
    }

    const minorStep = getMinorStepMm(scale, majorStep);
    const minorStepPx = minorStep * MM_TO_PX * scale;
    const showMinor = minorStepPx >= 1;

    const viewStartPx = Math.max(0, (-offset) / scale);
    const viewEndPx = Math.min(pageSizePx, (viewport - offset) / scale);
    const viewStart = viewStartPx * PX_TO_MM;
    const viewEnd = viewEndPx * PX_TO_MM;

    if (viewEnd <= 0 || viewStart >= pageSizeMm) {
      return { major: [], minor: [], majorStep };
    }

    const firstMajor = Math.floor(viewStart / majorStep) * majorStep;
    const lastMajor = Math.ceil(viewEnd / majorStep) * majorStep;

    const major: RulerTick[] = [];
    const minor: RulerTick[] = [];
    const maxMajorTicks = 400;
    let count = 0;

    for (let value = firstMajor; value <= lastMajor && count < maxMajorTicks; value += majorStep, count++) {
      if (value < 0 || value > pageSizeMm) continue;
      const pos = (value / PX_TO_MM) * scale;
      major.push({ value, pos });

      if (showMinor && minorStep < majorStep) {
        const stepsPerMajor = Math.round(majorStep / minorStep);
        for (let i = 1; i < stepsPerMajor; i++) {
          const minorValue = value + i * minorStep;
          if (minorValue < viewStart || minorValue > viewEnd) continue;
          if (minorValue < 0 || minorValue > pageSizeMm) continue;
          minor.push({ value: minorValue, pos: (minorValue / PX_TO_MM) * scale });
        }
      }
    }

    return { major, minor, majorStep };
  }, [zoom, rulerMetrics, pageWidth, pageHeight, PX_TO_MM, MM_TO_PX]);

  const formatRulerLabel = (value: number, majorStepMm: number) => {
    const cm = value / 10;
    if (majorStepMm >= 10) {
      const rounded = Math.round(cm);
      return rounded === 0 ? '0' : rounded.toString();
    }
    if (Math.abs(cm) < 0.0001) return '0';
    return cm.toFixed(1);
  };

  const rulerData = useMemo(() => {
    return {
      x: getRulerTicks('x'),
      y: getRulerTicks('y'),
    };
  }, [getRulerTicks]);

  if (!showRulers) return null;

  const { major: majorX, minor: minorX, majorStep: majorStepX } = rulerData.x;
  const { major: majorY, minor: minorY, majorStep: majorStepY } = rulerData.y;

  const pageLeft = gutterLeft + rulerMetrics.offsetX;
  const pageTop = gutterTop + rulerMetrics.offsetY;
  const topRulerTop = toolbarGapPx;
  const topRulerLeft = leftRulerWidth;
  const leftRulerTop = toolbarGapPx + rulerSize;
  const leftRulerLeft = 0;
  const xOffset = pageLeft - topRulerLeft;
  const yOffset = pageTop - leftRulerTop;

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const snapPx = (value: number) => Math.round(value * dpr) / dpr;
  const snappedTopRulerTop = snapPx(topRulerTop);
  const snappedTopRulerLeft = snapPx(topRulerLeft);
  const snappedLeftRulerTop = snapPx(leftRulerTop);
  const snappedLeftRulerLeft = snapPx(leftRulerLeft);

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 25 }}>
      {/* Corner Box */}
      <div
        style={{
          position: 'absolute',
          top: snappedTopRulerTop,
          left: snappedLeftRulerLeft,
          width: leftRulerWidth,
          height: rulerSize,
          backgroundColor: '#f2f2f2',
          borderRight: '1px solid #cfcfcf',
          borderBottom: '1px solid #cfcfcf',
        }}
      />

      {/* Horizontal Ruler */}
      <div
        style={{
          position: 'absolute',
          top: snappedTopRulerTop,
          left: snappedTopRulerLeft,
          right: 0,
          height: rulerSize,
          overflow: 'hidden',
          backgroundColor: '#f2f2f2',
          borderBottom: '1px solid #cfcfcf',
          borderRight: '1px solid #cfcfcf',
        }}
      >
        {/* Minor ticks */}
        {minorX.map((tick) => {
          const isMid = Math.abs((tick.value % 10) - 5) < 0.001;
          return (
            <div
              key={`x-minor-${tick.value}-${tick.pos}`}
              style={{
                position: 'absolute',
                left: snapPx(tick.pos + xOffset),
                bottom: 0,
                width: 1,
                height: isMid ? 9 : 6,
                backgroundColor: isMid ? '#9aa0a6' : '#b5b5b5',
              }}
            />
          );
        })}

        {/* Major ticks and labels */}
        {majorX.map((tick) => (
          <React.Fragment key={`x-major-${tick.value}-${tick.pos}`}>
            <div
              style={{
                position: 'absolute',
                left: snapPx(tick.pos + xOffset),
                bottom: 0,
                width: 1,
                height: 12,
                backgroundColor: '#8b8b8b',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: snapPx(tick.pos + xOffset + 3),
                top: 2,
                fontSize: 9,
                color: '#666',
                whiteSpace: 'nowrap',
              }}
            >
              {formatRulerLabel(tick.value, majorStepX)}
            </div>
          </React.Fragment>
        ))}
      </div>

      {/* Vertical Ruler */}
      <div
        style={{
          position: 'absolute',
          top: snappedLeftRulerTop,
          left: snappedLeftRulerLeft,
          bottom: 0,
          width: leftRulerWidth,
          overflow: 'hidden',
          backgroundColor: '#f2f2f2',
          borderRight: '1px solid #cfcfcf',
          borderBottom: '1px solid #cfcfcf',
        }}
      >
        {/* Minor ticks */}
        {minorY.map((tick) => {
          const isMid = Math.abs((tick.value % 10) - 5) < 0.001;
          return (
            <div
              key={`y-minor-${tick.value}-${tick.pos}`}
              style={{
                position: 'absolute',
                top: snapPx(tick.pos + yOffset),
                right: 0,
                height: 1,
                width: isMid ? 9 : 6,
                backgroundColor: isMid ? '#9aa0a6' : '#b5b5b5',
              }}
            />
          );
        })}

        {/* Major ticks and labels */}
        {majorY.map((tick) => (
          <React.Fragment key={`y-major-${tick.value}-${tick.pos}`}>
            <div
              style={{
                position: 'absolute',
                top: snapPx(tick.pos + yOffset),
                right: 0,
                height: 1,
                width: 12,
                backgroundColor: '#8b8b8b',
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: snapPx(tick.pos + yOffset),
                right: 14,
                fontSize: 9,
                color: '#666',
                lineHeight: 1,
                writingMode: 'horizontal-tb',
                textOrientation: 'upright',
                transform: 'translate(0, -50%)',
                whiteSpace: 'nowrap',
              }}
            >
              {formatRulerLabel(tick.value, majorStepY)}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

// Export gutter calculation utilities for use by parent components
export const useRulerGutters = (
  pageWidth: number,
  pageHeight: number,
  zoom: number,
  showRulers: boolean,
  customRulerSize?: number,
  customToolbarGapPx?: number
) => {
  const { MM_TO_PX, RULER_GAP_X_MM, RULER_GAP_Y_MM, RULER_TOOLBAR_GAP_MM, BASE_PADDING_PX } = GRID_CONSTANTS;
  
  const editorScale = Math.max(zoom / 100, 0.01);
  const rulerSize = customRulerSize ?? Math.max(20, Math.min(36, Math.round(Math.min(pageWidth, pageHeight) * 0.03)));
  const leftRulerWidth = rulerSize * 1.2;
  const toolbarGapPx = customToolbarGapPx ?? RULER_TOOLBAR_GAP_MM * MM_TO_PX;
  const rulerGapXPx = RULER_GAP_X_MM * MM_TO_PX * editorScale;
  const rulerGapYPx = RULER_GAP_Y_MM * MM_TO_PX * editorScale;

  return {
    gutterTop: showRulers ? toolbarGapPx + rulerSize + rulerGapYPx : 0,
    gutterLeft: showRulers ? leftRulerWidth + rulerGapXPx : 0,
    gutterRight: showRulers ? rulerGapXPx : 0,
    gutterBottom: showRulers ? rulerGapYPx : 0,
    basePaddingTop: showRulers ? 0 : BASE_PADDING_PX,
    basePaddingLeft: showRulers ? 0 : BASE_PADDING_PX,
    basePaddingRight: BASE_PADDING_PX,
    basePaddingBottom: BASE_PADDING_PX,
    rulerSize,
    leftRulerWidth,
  };
};

export default Rulers;
