import * as fabric from 'fabric';

export interface ViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function getCanvasViewportBounds(
  canvas: fabric.Canvas,
  paddingPx: number = 0
): ViewportBounds | null {
  const zoom = Math.max(canvas.getZoom(), 0.01);
  const viewportTransform = canvas.viewportTransform;
  if (!viewportTransform) {
    return null;
  }

  const padding = paddingPx / zoom;
  const left = (-viewportTransform[4] / zoom) - padding;
  const top = (-viewportTransform[5] / zoom) - padding;

  return {
    left,
    top,
    right: left + canvas.getWidth() / zoom + padding * 2,
    bottom: top + canvas.getHeight() / zoom + padding * 2,
  };
}

export function isViewportBoundsContained(
  inner: ViewportBounds,
  outer: ViewportBounds
): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom
  );
}

export function hasMeaningfulViewportZoomChange(
  previousZoom: number | null,
  nextZoom: number,
  tolerance: number = 0.02
): boolean {
  if (previousZoom === null) {
    return true;
  }

  return (
    Math.abs(nextZoom - previousZoom) / Math.max(previousZoom, 0.01) >= tolerance
  );
}
