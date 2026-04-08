export {
  WallEndpointEditOperation,
  type KeyModifiers,
  type WallEndpointEditDependencies,
  type EndpointEditPreview,
} from './WallEndpointEditOperation';

export {
  WallRotationOperation,
  type RotationModifiers,
  type RotationPreview,
  type WallRotationDependencies,
} from './WallRotationOperation';

export {
  classifyMoveStrategy,
  previewMove,
  executeMove,
  type MoveStrategy,
  type MoveRequest,
  type MoveValidationResult,
  type MoveResult,
  type MoveWarning,
  type MoveError,
} from './MoveOperation';

export {
  computeThicknessChange,
  THICKNESS_PRESETS_MM,
  THICKNESS_PRESETS,
  type ThicknessChangeRequest,
  type ThicknessChangeResult,
  type CornerUpdate,
} from './ThicknessOperation';

