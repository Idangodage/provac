import * as fabric from 'fabric';

interface CanvasRenderSchedulerState {
  frameId: number | null;
  requestRenderAll: fabric.Canvas['requestRenderAll'];
  renderAll: fabric.Canvas['renderAll'];
}

const renderSchedulerState = new WeakMap<fabric.Canvas, CanvasRenderSchedulerState>();

export function installCanvasRenderScheduler(canvas: fabric.Canvas): void {
  if (renderSchedulerState.has(canvas)) {
    return;
  }

  const originalRequestRenderAll = canvas.requestRenderAll.bind(canvas);
  const originalRenderAll = canvas.renderAll.bind(canvas);
  const state: CanvasRenderSchedulerState = {
    frameId: null,
    requestRenderAll: originalRequestRenderAll,
    renderAll: originalRenderAll,
  };
  renderSchedulerState.set(canvas, state);

  canvas.requestRenderAll = (() => {
    if (typeof window === 'undefined') {
      originalRenderAll();
      return canvas;
    }
    if (state.frameId !== null) {
      return canvas;
    }
    state.frameId = window.requestAnimationFrame(() => {
      state.frameId = null;
      originalRenderAll();
    });
    return canvas;
  }) as fabric.Canvas['requestRenderAll'];

  canvas.renderAll = (() => {
    if (typeof window !== 'undefined' && state.frameId !== null) {
      window.cancelAnimationFrame(state.frameId);
      state.frameId = null;
    }
    return originalRenderAll();
  }) as fabric.Canvas['renderAll'];
}

export function restoreCanvasRenderScheduler(canvas: fabric.Canvas): void {
  const state = renderSchedulerState.get(canvas);
  if (!state) {
    return;
  }

  if (typeof window !== 'undefined' && state.frameId !== null) {
    window.cancelAnimationFrame(state.frameId);
  }

  canvas.requestRenderAll = state.requestRenderAll;
  canvas.renderAll = state.renderAll;
  renderSchedulerState.delete(canvas);
}
