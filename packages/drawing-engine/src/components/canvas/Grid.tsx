'use client';

import React, { useMemo } from 'react';

import type { DisplayUnit, Point2D } from '../../types';

import {
  MM_TO_PX,
  type PaperUnit,
  toMillimeters,
} from './scale';

export interface GridProps {
  pageWidth: number;
  pageHeight: number;
  zoom: number;
  panOffset: Point2D;
  gridSize?: number;
  showGrid?: boolean;
  originOffset?: Point2D;
  viewportWidth?: number;
  viewportHeight?: number;
  minorLineColor?: string;
  majorLineColor?: string;
  gridMode?: 'paper' | 'real';
  paperUnit?: PaperUnit;
  realWorldUnit?: DisplayUnit;
  scaleDrawing?: number;
  scaleReal?: number;
  majorGridSize?: number;
  gridSubdivisions?: number;
}

const DEFAULT_MINOR_COLOR = 'rgba(100, 116, 139, 0.34)';
const DEFAULT_MAJOR_COLOR = 'rgba(51, 65, 85, 0.62)';
const DEFAULT_MAJOR_GRID_SIZE = 10;
const DEFAULT_GRID_SUBDIVISIONS = 10;
const MIN_GRID_STEP_MM = 0.1;
const MIN_GRID_STEP_SCENE_PX = MIN_GRID_STEP_MM * MM_TO_PX;
const MIN_MINOR_FADE_START_PX = 0.8;
const MIN_MINOR_FADE_END_PX = 4.2;
const MIN_MAJOR_FADE_START_PX = 0.6;
const MIN_MAJOR_FADE_END_PX = 2.2;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const Grid: React.FC<GridProps> = ({
  pageWidth,
  pageHeight,
  zoom,
  panOffset,
  gridSize = 20,
  showGrid = true,
  originOffset = { x: 0, y: 0 },
  viewportWidth = 0,
  viewportHeight = 0,
  minorLineColor = DEFAULT_MINOR_COLOR,
  majorLineColor = DEFAULT_MAJOR_COLOR,
  gridMode = 'paper',
  paperUnit = 'mm',
  realWorldUnit = 'mm',
  scaleDrawing = 1,
  scaleReal = 50,
  majorGridSize = DEFAULT_MAJOR_GRID_SIZE,
  gridSubdivisions = DEFAULT_GRID_SUBDIVISIONS,
}) => {
  if (!showGrid || pageWidth <= 0 || pageHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return null;
  }

  const scale = Math.max(zoom, 0.01);
  const safeScaleDrawing = Number.isFinite(scaleDrawing) && scaleDrawing > 0 ? scaleDrawing : 1;
  const safeScaleReal = Number.isFinite(scaleReal) && scaleReal > 0 ? scaleReal : 1;
  const paperPerRealRatio = safeScaleDrawing / safeScaleReal;
  const fallbackMajorGridSize = Math.max(gridSize * (1 / MM_TO_PX), MIN_GRID_STEP_MM);
  const safeMajorGridSize = Number.isFinite(majorGridSize) && majorGridSize > 0
    ? Math.max(majorGridSize, MIN_GRID_STEP_MM)
    : fallbackMajorGridSize || DEFAULT_MAJOR_GRID_SIZE;
  const safeSubdivisions = Number.isFinite(gridSubdivisions) && gridSubdivisions >= 1
    ? Math.max(1, Math.floor(gridSubdivisions))
    : DEFAULT_GRID_SUBDIVISIONS;

  const baseMajorStepScenePx = useMemo(() => {
    const majorMm = Math.max(
      gridMode === 'real'
        ? toMillimeters(safeMajorGridSize, realWorldUnit) * paperPerRealRatio
        : toMillimeters(safeMajorGridSize, paperUnit),
      MIN_GRID_STEP_MM
    );
    return Math.max(majorMm * MM_TO_PX, MIN_GRID_STEP_SCENE_PX);
  }, [gridMode, paperPerRealRatio, paperUnit, realWorldUnit, safeMajorGridSize]);

  const pageLeft = originOffset.x + (-panOffset.x) * scale;
  const pageTop = originOffset.y + (-panOffset.y) * scale;
  const pageWidthPx = pageWidth * scale;
  const pageHeightPx = pageHeight * scale;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const snapPx = (value: number) => Math.round(value * dpr) / dpr;
  const lineWidthPx = 1 / dpr;
  const snapStepPx = (value: number) => Math.max(lineWidthPx, snapPx(value));
  const snappedLeft = snapPx(pageLeft);
  const snappedTop = snapPx(pageTop);
  const snappedWidth = Math.max(1, snapPx(pageLeft + pageWidthPx) - snappedLeft);
  const snappedHeight = Math.max(1, snapPx(pageTop + pageHeightPx) - snappedTop);
  const majorStepPx = snapStepPx(baseMajorStepScenePx * scale);
  const minorStepPx = snapStepPx(majorStepPx / safeSubdivisions);
  const minorOpacity = clamp01((minorStepPx - MIN_MINOR_FADE_START_PX) / (MIN_MINOR_FADE_END_PX - MIN_MINOR_FADE_START_PX));
  const majorOpacity = clamp01((majorStepPx - MIN_MAJOR_FADE_START_PX) / (MIN_MAJOR_FADE_END_PX - MIN_MAJOR_FADE_START_PX));

  const majorBackground = useMemo(
    () => ({
      image: [
        `repeating-linear-gradient(to right, ${majorLineColor} 0, ${majorLineColor} ${lineWidthPx}px, transparent ${lineWidthPx}px, transparent ${majorStepPx}px)`,
        `repeating-linear-gradient(to bottom, ${majorLineColor} 0, ${majorLineColor} ${lineWidthPx}px, transparent ${lineWidthPx}px, transparent ${majorStepPx}px)`,
      ].join(', '),
      opacity: majorOpacity,
    }),
    [lineWidthPx, majorLineColor, majorStepPx, majorOpacity]
  );

  const minorBackground = useMemo(
    () => ({
      image: [
        `repeating-linear-gradient(to right, ${minorLineColor} 0, ${minorLineColor} ${lineWidthPx}px, transparent ${lineWidthPx}px, transparent ${minorStepPx}px)`,
        `repeating-linear-gradient(to bottom, ${minorLineColor} 0, ${minorLineColor} ${lineWidthPx}px, transparent ${lineWidthPx}px, transparent ${minorStepPx}px)`,
      ].join(', '),
      opacity: minorOpacity,
    }),
    [lineWidthPx, minorLineColor, minorStepPx, minorOpacity]
  );

  return (
    <div
      style={{
        position: 'absolute',
        left: snappedLeft,
        top: snappedTop,
        width: snappedWidth,
        height: snappedHeight,
        pointerEvents: 'none',
        zIndex: 1,
        overflow: 'hidden',
      }}
    >
      {minorOpacity > 0.01 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: minorBackground.image,
            opacity: minorBackground.opacity,
            backgroundPosition: '0 0',
          }}
        />
      )}
      {majorOpacity > 0.01 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: majorBackground.image,
            opacity: majorBackground.opacity,
            backgroundPosition: '0 0',
          }}
        />
      )}
    </div>
  );
};

export default Grid;
