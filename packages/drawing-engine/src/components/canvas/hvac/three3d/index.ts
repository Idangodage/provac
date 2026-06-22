export {
  buildHvacElementMesh,
  buildHvacSceneMetadata,
  isProjectionCoreHvacType,
  type HvacBuildSceneContext,
  type HvacProjectionLabelAnchor,
} from "./buildHvacElementMesh";
export {
  deriveHvac3DProjectionAttributes,
  deriveHvacProjectionElements,
  hasProjectableHvac3D,
  type Hvac3DProjectionAttributes,
  type Hvac3DProjectionCategory,
  type HvacElementWithProjection3D,
  type HvacProjectionElement3D,
} from "./hvac3dAttributes";
export { HvacProjectionLayer, type HvacProjectionLayerProps } from "./HvacProjectionLayer";
export {
  ProjectionAxisGizmo,
  type ProjectionAxis,
  type ProjectionAxisGizmoProps,
  type ProjectionAxisGizmoVector,
} from "./ProjectionAxisGizmo";
export {
  fitPerspectiveCameraToBox,
  projectLabelAnchors,
  resolveProjectionCameraDirection,
} from "./projectionMath";
export {
  getPlanProjectionVisualState,
  type ProjectionVisualState,
} from "./projectionState";
