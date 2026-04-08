/**
 * Selection Module
 *
 * Barrel export for the selection and permission system.
 */

export { SelectionModel } from './SelectionModel';
export type {
  SelectionKind,
  SelectionEntry,
  SelectionState,
  HitTestCandidate,
  HandleCategory,
} from './SelectionModel';

export {
  getEndpointPermission,
  getCenterMovePermission,
  getThicknessPermission as getThicknessHandlePermission,
  getRoomCenterMovePermission,
  getRoomCornerPermission,
  getRotationPermission,
} from './HandlePermissions';
export type {
  HandlePermission,
  HandleVisibility,
  ConstraintAxis,
} from './HandlePermissions';

export {
  getThicknessPermission,
  requiresThicknessConfirmation,
} from './ThicknessPermissions';
export type {
  ThicknessPermission,
} from './ThicknessPermissions';
