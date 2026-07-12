'use client';

import React from 'react';

import type { Point2D } from '../../types';

export interface PageLayoutProps {
  pageWidth: number;
  pageHeight: number;
  zoom: number;
  panOffset: Point2D;
  showPage?: boolean;
  backgroundColor?: string;
  borderColor?: string;
  shadow?: string;
  originOffset?: Point2D;
  /** Tint everything outside the sheet so the printable area reads clearly. */
  dimOutside?: boolean;
}

/**
 * Page layout overlay for the smart drawing canvas.
 * Renders a page boundary to mirror document editor layouts.
 */
export const PageLayout: React.FC<PageLayoutProps> = ({
  pageWidth,
  pageHeight,
  zoom,
  panOffset,
  showPage = true,
  backgroundColor = '#ffffff',
  borderColor = '#000000',
  shadow = '0 20px 45px rgba(15, 23, 42, 0.15)',
  originOffset = { x: 0, y: 0 },
  dimOutside = false,
}) => {
  if (!showPage || pageWidth <= 0 || pageHeight <= 0) return null;

  const pageLeft = originOffset.x + (-panOffset.x) * zoom;
  const pageTop = originOffset.y + (-panOffset.y) * zoom;
  const pageWidthPx = pageWidth * zoom;
  const pageHeightPx = pageHeight * zoom;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const snapPx = (value: number) => Math.round(value * dpr) / dpr;
  const snappedLeft = snapPx(pageLeft);
  const snappedTop = snapPx(pageTop);
  const snappedWidth = Math.max(1, snapPx(pageLeft + pageWidthPx) - snappedLeft);
  const snappedHeight = Math.max(1, snapPx(pageTop + pageHeightPx) - snappedTop);

  return (
    <div
      style={{
        position: 'absolute',
        left: snappedLeft,
        top: snappedTop,
        width: snappedWidth,
        height: snappedHeight,
        backgroundColor,
        border: `1px solid ${borderColor}`,
        // The huge spread shadow tints the off-sheet area, making the page
        // boundary part of the drawing experience rather than a decoration.
        boxShadow: dimOutside
          ? `${shadow}, 0 0 0 100000px rgba(120, 100, 60, 0.055)`
          : shadow,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
};

export default PageLayout;
