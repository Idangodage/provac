/**
 * Duct runs in the 3D views: the run and the point on it under the pointer,
 * the segment there (the plan's own keys, so a segment has one card whichever
 * view points at it), outline proxies of a segment, and a segment's box as
 * the camera sees it (where its card goes).
 */
import * as THREE from 'three';

import type { HvacElement } from '../../../types';
import { getDuctRunPlan } from '../hvac/duct/ductFabricationPlanner';
import type { DuctSegmentFocus } from '../hvac/duct/ductSegmentUiStore';
import { ductSegmentOf, segmentAtModelPoint, segmentBounds3D } from '../hvac/duct/ductSegments';
import type { DuctDesignSettings } from '../hvac/duct/ductSettings';
import type { ScreenRect } from '../hvac/duct/popoverPlacement';
import { ductPiecesOuterGeometry } from '../hvac/three3d/ductMeshes';
import { modelPointToWorld } from '../modelSpace';

import { OUTLINE_PROXY_MATERIAL } from './postfx';

export interface DuctHit3D {
  runId: string;
  /** The picked point on the run's surface (model mm, z up). */
  model: { x: number; y: number; z: number };
  /** Along the ray (world units), to compare with other picks. */
  distance: number;
}

/** A pick up to this far off a piece (beyond its insulation) still finds it: flanges, hangers, rounding (mm). */
const PICK_TOLERANCE_MM = 60;

/** The duct run nearest along the ray and where on it, among the visible runs under `root` (whose frame is the model's). */
export function raycastDuctRun(raycaster: THREE.Raycaster, root: THREE.Object3D): DuctHit3D | null {
  const runs = root.children.filter((object) => object.visible && object.userData.hvacElementType === 'duct');
  if (runs.length === 0) return null;
  for (const hit of raycaster.intersectObjects(runs, true)) {
    let node: THREE.Object3D | null = hit.object;
    while (node && node.parent !== root) node = node.parent;
    const runId = node?.userData.hvacElementId as string | undefined;
    if (!runId) continue;
    const local = root.worldToLocal(hit.point.clone());
    return { runId, model: { x: local.x, y: local.y, z: local.z }, distance: hit.distance };
  }
  return null;
}

/** The segment of `runId` at a picked model point, as a 3D focus, or null. */
export function ductSegmentFocusAt(
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
  runId: string,
  model: { x: number; y: number; z: number },
): DuctSegmentFocus | null {
  const element = scene.find((candidate) => candidate.id === runId);
  const plan = element ? getDuctRunPlan(element, scene, settings) : null;
  const found = plan ? segmentAtModelPoint(plan, model, plan.insulationMm + PICK_TOLERANCE_MM) : null;
  return found ? { runId, key: found.segment.key, anchorMark: found.mark, view: '3d' } : null;
}

/** A segment's outline proxy (its pieces' outer surface, drawing nothing itself), or null. */
export function ductSegmentProxy(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string, key: string): THREE.Mesh | null {
  const element = scene.find((candidate) => candidate.id === runId);
  const plan = element ? getDuctRunPlan(element, scene, settings) : null;
  const segment = plan ? ductSegmentOf(plan, key) : null;
  const geometry = plan && segment ? ductPiecesOuterGeometry(plan, segment.pieceIndices) : null;
  if (!geometry) return null;
  const mesh = new THREE.Mesh(geometry, OUTLINE_PROXY_MATERIAL);
  mesh.name = `duct-segment-proxy-${runId}-${key}`;
  return mesh;
}

/** The meshes a duct run is drawn with (visible ones), for an outline of the whole run; none for another element. */
export function ductRunMeshes(root: THREE.Object3D, runId: string): THREE.Mesh[] {
  const group = root.children.find((object) => object.userData.hvacElementId === runId && object.userData.hvacElementType === 'duct' && object.visible);
  const meshes: THREE.Mesh[] = [];
  group?.traverse((object) => {
    if (object instanceof THREE.Mesh && object.visible) meshes.push(object);
  });
  return meshes;
}

/**
 * A segment's box (its anchor piece's, when the focus has one) as `camera`
 * sees it, in client pixels of a canvas whose client rect is `host`; null when
 * it is wholly behind the camera or off the drawing.
 */
export function segmentClientRect3D(
  scene: readonly HvacElement[],
  settings: DuctDesignSettings,
  focus: Pick<DuctSegmentFocus, 'runId' | 'key' | 'anchorMark'>,
  camera: THREE.Camera,
  host: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): ScreenRect | null {
  const element = scene.find((candidate) => candidate.id === focus.runId);
  const plan = element ? getDuctRunPlan(element, scene, settings) : null;
  const bounds = plan ? segmentBounds3D(plan, focus.key, focus.anchorMark) : null;
  if (!bounds || host.width <= 0 || host.height <= 0) return null;
  camera.updateMatrixWorld();
  const xs: number[] = [];
  const ys: number[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const clip = modelPointToWorld({ x, y }, z).project(camera);
        if (!Number.isFinite(clip.x) || !Number.isFinite(clip.y) || clip.z < -1 || clip.z > 1) continue;
        xs.push(host.left + ((clip.x + 1) / 2) * host.width);
        ys.push(host.top + ((1 - clip.y) / 2) * host.height);
      }
    }
  }
  if (xs.length === 0) return null;
  const rect = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  // Wholly off the drawing: no card.
  if (rect.right < host.left || rect.left > host.left + host.width || rect.bottom < host.top || rect.top > host.top + host.height) return null;
  return rect;
}
