'use client';

import React, { useMemo } from 'react';

import { GRID_CONSTANTS } from '../../types';

export interface GridProps {
  pageWidth: number;
  pageHeight: number;
  zoom: number;
  showMinorGrid?: boolean;
  minorGridColor?: string;
  majorGridColor?: string;
}

/**
 * Reusable Grid component for document editors and drawing canvases.
 * Displays a metric grid (mm-based) with major and minor grid lines.
 */
export const Grid: React.FC<GridProps> = ({
  pageWidth,
  pageHeight,
  zoom,
  showMinorGrid: forceShowMinor,
  minorGridColor = GRID_CONSTANTS.MINOR_GRID_COLOR,
  majorGridColor = GRID_CONSTANTS.MAJOR_GRID_COLOR,
}) => {
  const editorScale = Math.max(zoom / 100, 0.01);
  const gridDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  
  const snapGridPx = (value: number) => Math.round(value * gridDpr) / gridDpr;
  const gridLinePx = 1 / gridDpr;
  
  const { MM_TO_PX, PX_TO_MM } = GRID_CONSTANTS;
  const minorGridSpacingPx = MM_TO_PX * editorScale;
  const showMinorGrid = forceShowMinor ?? minorGridSpacingPx >= gridLinePx * 2;
  
  const pageWidthMm = Math.ceil(pageWidth * PX_TO_MM);
  const pageHeightMm = Math.ceil(pageHeight * PX_TO_MM);

  // Memoize grid lines for performance
  const { minorXLines, minorYLines, majorXLines, majorYLines } = useMemo(() => {
    const minorX: number[] = [];
    const minorY: number[] = [];
    const majorX: number[] = [];
    const majorY: number[] = [];

    if (showMinorGrid) {
      for (let mm = 0; mm <= pageWidthMm; mm++) {
        if (mm % 5 !== 0) {
          minorX.push(mm);
        }
      }
      for (let mm = 0; mm <= pageHeightMm; mm++) {
        if (mm % 5 !== 0) {
          minorY.push(mm);
        }
      }
    }

    for (let idx = 0; idx <= Math.floor(pageWidthMm / 5); idx++) {
      majorX.push(idx * 5);
    }
    for (let idx = 0; idx <= Math.floor(pageHeightMm / 5); idx++) {
      majorY.push(idx * 5);
    }

    return {
      minorXLines: minorX,
      minorYLines: minorY,
      majorXLines: majorX,
      majorYLines: majorY,
    };
  }, [pageWidthMm, pageHeightMm, showMinorGrid]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: snapGridPx(pageWidth * editorScale),
        height: snapGridPx(pageHeight * editorScale),
        transform: `scale(${1 / editorScale})`,
        transformOrigin: 'top left',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      {/* Minor vertical lines */}
      {showMinorGrid &&
        minorXLines.map((mm) => {
          const left = snapGridPx(mm * minorGridSpacingPx);
          return (
            <div
              key={`grid-minor-x-${mm}`}
              style={{
                position: 'absolute',
                top: 0,
                left,
                width: gridLinePx,
                height: '100%',
                backgroundColor: minorGridColor,
              }}
            />
          );
        })}

      {/* Minor horizontal lines */}
      {showMinorGrid &&
        minorYLines.map((mm) => {
          const top = snapGridPx(mm * minorGridSpacingPx);
          return (
            <div
              key={`grid-minor-y-${mm}`}
              style={{
                position: 'absolute',
                top,
                left: 0,
                height: gridLinePx,
                width: '100%',
                backgroundColor: minorGridColor,
              }}
            />
          );
        })}

      {/* Major vertical lines */}
      {majorXLines.map((mm) => {
        const left = snapGridPx(mm * minorGridSpacingPx);
        return (
          <div
            key={`grid-major-x-${mm}`}
            style={{
              position: 'absolute',
              top: 0,
              left,
              width: gridLinePx,
              height: '100%',
              backgroundColor: majorGridColor,
            }}
          />
        );
      })}

      {/* Major horizontal lines */}
      {majorYLines.map((mm) => {
        const top = snapGridPx(mm * minorGridSpacingPx);
        return (
          <div
            key={`grid-major-y-${mm}`}
            style={{
              position: 'absolute',
              top,
              left: 0,
              height: gridLinePx,
              width: '100%',
              backgroundColor: majorGridColor,
            }}
          />
        );
      })}
    </div>
  );
};

export default Grid;
