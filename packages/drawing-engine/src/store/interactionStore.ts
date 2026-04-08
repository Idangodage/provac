import { create } from 'zustand';

import type { Point2D } from '../types';

export interface DrawingInteractionState {
  mousePosition: Point2D;
  hoveredElementId: string | null;
  zoom: number;
  panOffset: Point2D;
  setMousePosition: (mousePosition: Point2D) => void;
  resetMousePosition: () => void;
  setHoveredElement: (hoveredElementId: string | null) => void;
  setViewTransform: (zoom: number, panOffset: Point2D) => void;
  resetViewTransform: () => void;
  resetInteractionState: () => void;
}

const ORIGIN: Point2D = { x: 0, y: 0 };
const DEFAULT_ZOOM = 1;

function pointsEqual(left: Point2D, right: Point2D): boolean {
  return left.x === right.x && left.y === right.y;
}

export const useDrawingInteractionStore = create<DrawingInteractionState>()((set) => ({
  mousePosition: ORIGIN,
  hoveredElementId: null,
  zoom: DEFAULT_ZOOM,
  panOffset: ORIGIN,
  setMousePosition: (mousePosition) =>
    set((state) => (
      state.mousePosition.x === mousePosition.x && state.mousePosition.y === mousePosition.y
        ? state
        : { mousePosition }
    )),
  resetMousePosition: () =>
    set((state) => (
      state.mousePosition.x === 0 && state.mousePosition.y === 0
        ? state
        : { mousePosition: ORIGIN }
    )),
  setHoveredElement: (hoveredElementId) =>
    set((state) => (
      state.hoveredElementId === hoveredElementId
        ? state
        : { hoveredElementId }
    )),
  setViewTransform: (zoom, panOffset) =>
    set((state) => {
      const nextZoom = Math.max(0.1, Math.min(10, zoom));
      return state.zoom === nextZoom && pointsEqual(state.panOffset, panOffset)
        ? state
        : { zoom: nextZoom, panOffset };
    }),
  resetViewTransform: () =>
    set((state) => (
      state.zoom === DEFAULT_ZOOM && pointsEqual(state.panOffset, ORIGIN)
        ? state
        : { zoom: DEFAULT_ZOOM, panOffset: ORIGIN }
    )),
  resetInteractionState: () =>
    set((state) => {
      const hasMousePosition = !pointsEqual(state.mousePosition, ORIGIN);
      const hasHover = state.hoveredElementId !== null;
      const hasViewTransform = state.zoom !== DEFAULT_ZOOM || !pointsEqual(state.panOffset, ORIGIN);
      if (!hasMousePosition && !hasHover && !hasViewTransform) {
        return state;
      }
      return {
        mousePosition: ORIGIN,
        hoveredElementId: null,
        zoom: DEFAULT_ZOOM,
        panOffset: ORIGIN,
      };
    }),
}));
