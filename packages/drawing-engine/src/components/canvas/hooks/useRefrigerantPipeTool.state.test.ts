import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A persistent hook-cell harness exercises publications across re-renders.
// Canvas effects and pointer projection are covered by their own integration tests.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, changes: 0 }));
vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = { current: initial };
    return hooks.cells[index];
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = initial;
    return [hooks.cells[index], (value: unknown) => {
      const next = typeof value === 'function' ? value(hooks.cells[index]) : value;
      if (!Object.is(next, hooks.cells[index])) { hooks.cells[index] = next; hooks.changes++; }
    }];
  },
  useEffect: () => {},
}));

import { DEFAULT_PIPE_ROUTING_SETTINGS, setActivePipeRoutingSettings } from '../hvac/pipeRoutingSettings';

import { useRefrigerantPipeTool, type UseRefrigerantPipeToolOptions } from './useRefrigerantPipeTool';

function setup() {
  const options: UseRefrigerantPipeToolOptions = {
    fabricRef: { current: null }, hvacRendererRef: { current: null }, activeTool: 'refrigerant-pipe',
    pipeMaterialMode: 'flexible', pipeAngleMode: 'free', pipeLineMode: 'gas', planRouting: false,
    hvacElements: [], zoom: 1, snapToGrid: false, gridSize: 20,
    addHvacElements: vi.fn(() => ['created']), commitHvacElementCommand: vi.fn(() => []),
    setSelectedIds: vi.fn(), setProcessingStatus: vi.fn(),
    onDraftPipesChange: vi.fn(), onDraftRouteChange: vi.fn(), onDraftAnchorChange: vi.fn(), overlayOwnsPipePreview: true,
  };
  const render = () => { hooks.cursor = 0; return useRefrigerantPipeTool(options); };
  return { options, render };
}

describe('committed drawing state publication', () => {
  beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.changes = 0; setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS); });
  afterEach(() => setActivePipeRoutingSettings(DEFAULT_PIPE_ROUTING_SETTINGS));

  it('updates toolbar state after start, level, undo and cancellation without publishing pointer moves', () => {
    const { options, render } = setup();
    let tool = render();
    expect(tool.isDrawing).toBe(false);
    expect(tool.draftElevationMm).toBeNull();
    tool.handleMouseDown({ x: 100, y: 200, z: 1800 });
    tool = render();
    expect(tool.isDrawing).toBe(true);
    expect(tool.draftLineMode).toBe('gas');
    expect(tool.draftElevationMm).toBe(1800);
    const publications = hooks.changes;
    for (let index = 0; index < 10; index++) tool.handleMouseMove({ x: 2000 + index * 10, y: 200, z: 1800 });
    expect(hooks.changes).toBe(publications);
    expect(options.onDraftAnchorChange).toHaveBeenCalledOnce();
    expect(tool.setDrawingElevation(2600)).toBe(true);
    tool = render();
    expect(tool.draftElevationMm).toBe(2600);
    expect(tool.isDrawing).toBe(true);
    tool.undoDrawingStep();
    tool = render();
    expect(tool.draftElevationMm).toBe(1800);
    tool.cancelDrawing();
    tool = render();
    expect(tool.isDrawing).toBe(false);
    expect(tool.draftElevationMm).toBeNull();
    expect(options.onDraftAnchorChange).toHaveBeenLastCalledWith(null);
  });
});
