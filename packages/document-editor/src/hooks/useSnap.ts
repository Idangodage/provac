'use client';

import { useCallback } from 'react';

import type { EditorElement, AlignmentGuide } from '../types';
import { GRID_CONSTANTS } from '../types';

export interface UseSnapOptions {
  snapToGrid: boolean;
  snapToElements: boolean;
  snapThreshold?: number;
  zoom: number;
  showGrid: boolean;
}

/**
 * Hook for snapping logic during element drag operations.
 */
export const useSnap = (options: UseSnapOptions) => {
  const { snapToGrid, snapToElements, snapThreshold = 6, zoom, showGrid } = options;
  
  const editorScale = Math.max(zoom / 100, 0.01);
  const { MM_TO_PX, GRID_MINOR_STEP_PX, GRID_MAJOR_STEP_PX } = GRID_CONSTANTS;
  
  const minorGridSpacingPx = MM_TO_PX * editorScale;
  const showMinorGrid = minorGridSpacingPx >= (1 / (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)) * 2;

  const snapToGridValue = useCallback((value: number): number => {
    if (!showGrid && !snapToGrid) return value;
    const gridUnit = showMinorGrid ? GRID_MINOR_STEP_PX : GRID_MAJOR_STEP_PX;
    return Math.round(value / gridUnit) * gridUnit;
  }, [showGrid, snapToGrid, showMinorGrid, GRID_MINOR_STEP_PX, GRID_MAJOR_STEP_PX]);

  const calculateSnapPosition = useCallback((
    movingElement: EditorElement,
    targetX: number,
    targetY: number,
    allElements: EditorElement[]
  ): {
    x: number;
    y: number;
    guides: AlignmentGuide[];
  } => {
    const guides: AlignmentGuide[] = [];
    const threshold = snapThreshold / editorScale;
    
    let nextX = targetX;
    let nextY = targetY;
    let snappedX = false;
    let snappedY = false;
    
    const movingWidth = movingElement.width;
    const movingHeight = movingElement.height;

    const addGuide = (guide: AlignmentGuide) => {
      const exists = guides.some(
        (existing) => existing.type === guide.type && Math.abs(existing.position - guide.position) < 0.5
      );
      if (!exists) {
        guides.push(guide);
      }
    };

    if (snapToElements) {
      let bestXDelta = threshold + 1;
      let bestYDelta = threshold + 1;
      let bestX = targetX;
      let bestY = targetY;
      let bestGuideX: number | null = null;
      let bestGuideY: number | null = null;

      allElements.forEach((el) => {
        if (el.id === movingElement.id || !el.visible) return;

        const targetLeft = el.x;
        const targetRight = el.x + el.width;
        const targetTop = el.y;
        const targetBottom = el.y + el.height;

        const moveLeft = targetX;
        const moveRight = targetX + movingWidth;
        const moveTop = targetY;
        const moveBottom = targetY + movingHeight;

        // Left to Left alignment
        const deltaLeftLeft = Math.abs(moveLeft - targetLeft);
        if (deltaLeftLeft <= threshold && deltaLeftLeft < bestXDelta) {
          bestXDelta = deltaLeftLeft;
          bestX = targetLeft;
          bestGuideX = targetLeft;
        }

        // Right to Right alignment
        const deltaRightRight = Math.abs(moveRight - targetRight);
        if (deltaRightRight <= threshold && deltaRightRight < bestXDelta) {
          bestXDelta = deltaRightRight;
          bestX = targetRight - movingWidth;
          bestGuideX = targetRight;
        }

        // Left to Right alignment
        const deltaLeftRight = Math.abs(moveLeft - targetRight);
        if (deltaLeftRight <= threshold && deltaLeftRight < bestXDelta) {
          bestXDelta = deltaLeftRight;
          bestX = targetRight;
          bestGuideX = targetRight;
        }

        // Right to Left alignment
        const deltaRightLeft = Math.abs(moveRight - targetLeft);
        if (deltaRightLeft <= threshold && deltaRightLeft < bestXDelta) {
          bestXDelta = deltaRightLeft;
          bestX = targetLeft - movingWidth;
          bestGuideX = targetLeft;
        }

        // Top to Top alignment
        const deltaTopTop = Math.abs(moveTop - targetTop);
        if (deltaTopTop <= threshold && deltaTopTop < bestYDelta) {
          bestYDelta = deltaTopTop;
          bestY = targetTop;
          bestGuideY = targetTop;
        }

        // Bottom to Bottom alignment
        const deltaBottomBottom = Math.abs(moveBottom - targetBottom);
        if (deltaBottomBottom <= threshold && deltaBottomBottom < bestYDelta) {
          bestYDelta = deltaBottomBottom;
          bestY = targetBottom - movingHeight;
          bestGuideY = targetBottom;
        }

        // Top to Bottom alignment
        const deltaTopBottom = Math.abs(moveTop - targetBottom);
        if (deltaTopBottom <= threshold && deltaTopBottom < bestYDelta) {
          bestYDelta = deltaTopBottom;
          bestY = targetBottom;
          bestGuideY = targetBottom;
        }

        // Bottom to Top alignment
        const deltaBottomTop = Math.abs(moveBottom - targetTop);
        if (deltaBottomTop <= threshold && deltaBottomTop < bestYDelta) {
          bestYDelta = deltaBottomTop;
          bestY = targetTop - movingHeight;
          bestGuideY = targetTop;
        }

        // Center alignments
        const targetCenterX = el.x + el.width / 2;
        const targetCenterY = el.y + el.height / 2;
        const moveCenterX = targetX + movingWidth / 2;
        const moveCenterY = targetY + movingHeight / 2;

        const deltaCenterX = Math.abs(moveCenterX - targetCenterX);
        if (deltaCenterX <= threshold && deltaCenterX < bestXDelta) {
          bestXDelta = deltaCenterX;
          bestX = targetCenterX - movingWidth / 2;
          bestGuideX = targetCenterX;
        }

        const deltaCenterY = Math.abs(moveCenterY - targetCenterY);
        if (deltaCenterY <= threshold && deltaCenterY < bestYDelta) {
          bestYDelta = deltaCenterY;
          bestY = targetCenterY - movingHeight / 2;
          bestGuideY = targetCenterY;
        }
      });

      if (bestXDelta <= threshold) {
        nextX = bestX;
        snappedX = true;
        if (bestGuideX !== null) {
          addGuide({ type: 'vertical', position: bestGuideX, strength: 'element' });
        }
      }
      if (bestYDelta <= threshold) {
        nextY = bestY;
        snappedY = true;
        if (bestGuideY !== null) {
          addGuide({ type: 'horizontal', position: bestGuideY, strength: 'element' });
        }
      }
    }

    // Grid snapping (only if not already snapped to element)
    const gridEnabled = showGrid || snapToGrid;
    if (gridEnabled) {
      const gridX = snapToGridValue(targetX);
      const gridY = snapToGridValue(targetY);
      const deltaX = Math.abs(targetX - gridX);
      const deltaY = Math.abs(targetY - gridY);

      if (!snappedX && (snapToGrid || deltaX <= threshold)) {
        nextX = gridX;
      }

      if (!snappedY && (snapToGrid || deltaY <= threshold)) {
        nextY = gridY;
      }
    }

    return { x: nextX, y: nextY, guides };
  }, [snapToElements, snapToGrid, snapThreshold, editorScale, showGrid, snapToGridValue]);

  return {
    calculateSnapPosition,
    snapToGridValue,
  };
};

export default useSnap;
