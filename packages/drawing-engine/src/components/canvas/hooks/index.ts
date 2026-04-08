/**
 * Canvas Hooks
 *
 * Custom React hooks for canvas interactions and drawing operations.
 * Following industry best practices with tool/mode-specific hooks.
 */

// Keyboard handling
export { useCanvasKeyboard, type UseCanvasKeyboardOptions } from './useCanvasKeyboard';

// Tool mode hooks
export { useSelectMode, type UseSelectModeOptions } from './useSelectMode';

// Pan handling
export { useMiddlePan, type UseMiddlePanOptions, type MiddlePanState } from './useMiddlePan';

// Wall tool
export { useWallTool, type UseWallToolOptions, type UseWallToolResult } from './useWallTool';

// Room tool
export { useRoomTool, type UseRoomToolOptions, type UseRoomToolResult } from './useRoomTool';

// Dimension tool
export { useDimensionTool, type UseDimensionToolOptions } from './useDimensionTool';

// Symbol placement tool
export {
  useSymbolPlacementTool,
  type UseSymbolPlacementToolOptions,
  type UseSymbolPlacementToolResult,
  type PlacementState,
  type WallSnapInfo,
} from './useSymbolPlacementTool';

// Offset tool
export { useOffsetTool, type UseOffsetToolOptions, type UseOffsetToolResult } from './useOffsetTool';

// Trim tool
export { useTrimTool, type UseTrimToolOptions, type UseTrimToolResult } from './useTrimTool';

// Extend tool
export { useExtendTool, type UseExtendToolOptions, type UseExtendToolResult } from './useExtendTool';

// Target resolvers
export { useTargetResolvers, type UseTargetResolversResult } from './useTargetResolvers';

// Context menu handlers
export { useContextMenuHandlers, type UseContextMenuHandlersOptions, type UseContextMenuHandlersResult } from './useContextMenuHandlers';

// Geometry helpers
export { useGeometryHelpers, type UseGeometryHelpersOptions, type UseGeometryHelpersResult, type WallPlacementSnap, type PointProjection } from './useGeometryHelpers';

// Opening placement
export { useOpeningPlacement, type UseOpeningPlacementOptions, type UseOpeningPlacementResult } from './useOpeningPlacement';

// HVAC placement
export { useHvacPlacement, type UseHvacPlacementOptions, type UseHvacPlacementResult, type HvacPlacementResult } from './useHvacPlacement';

// Refrigerant pipe tool
export {
  useRefrigerantPipeTool,
  type UseRefrigerantPipeToolOptions,
  type UseRefrigerantPipeToolResult,
} from './useRefrigerantPipeTool';

// Opening interaction
export { useOpeningInteraction, type UseOpeningInteractionOptions, type UseOpeningInteractionResult } from './useOpeningInteraction';

// Renderer synchronisation
export { useRendererSync, type UseRendererSyncOptions, type UseRendererSyncResult } from './useRendererSync';

// Canvas mouse handlers
export { useCanvasMouseHandlers, type UseCanvasMouseHandlersOptions, type UseCanvasMouseHandlersResult } from './useCanvasMouseHandlers';

// Canvas event binding
export { useCanvasEventBinding, type UseCanvasEventBindingOptions, type UseCanvasEventBindingResult } from './useCanvasEventBinding';
