'use client';

import React from 'react';

import type { AlignmentGuide } from '../../types';
import { GRID_CONSTANTS } from '../../types';

export interface AlignmentGuidesProps {
  guides: AlignmentGuide[];
  zoom: number;
  mainColor?: string;
  subColor?: string;
}

/**
 * Reusable AlignmentGuides component for displaying snap guides during element dragging.
 */
export const AlignmentGuides: React.FC<AlignmentGuidesProps> = ({
  guides,
  zoom,
  mainColor = GRID_CONSTANTS.GUIDE_MAIN_COLOR,
  subColor = GRID_CONSTANTS.GUIDE_SUB_COLOR,
}) => {
  const editorScale = Math.max(zoom / 100, 0.01);
  const gridDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const gridLinePx = 1 / gridDpr;
  const guideLinePx = gridLinePx / editorScale;

  const snapGuidePx = (value: number) => {
    const scaled = value * editorScale;
    const snapped = Math.round(scaled * gridDpr) / gridDpr;
    return snapped / editorScale;
  };

  return (
    <>
      {guides.map((guide, index) => {
        const position = snapGuidePx(guide.position);
        const color = guide.strength === 'minor' ? subColor : mainColor;
        
        return (
          <div
            key={`${guide.type}-${guide.position}-${index}`}
            style={{
              position: 'absolute',
              ...(guide.type === 'vertical'
                ? { left: position, top: 0, bottom: 0, width: guideLinePx }
                : { top: position, left: 0, right: 0, height: guideLinePx }),
              backgroundColor: color,
              pointerEvents: 'none',
              zIndex: 9999,
            }}
          />
        );
      })}
    </>
  );
};

export default AlignmentGuides;
