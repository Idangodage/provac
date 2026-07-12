import type { HvacElement, Point2D } from '../../../types';
import type { VrfValidationIssue } from '../../../vrf/rules';

import { withCanonicalPipeRoute } from './pipeRoute3d';
import {
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipeVisual,
  constrainRefrigerantPipeRouteForConnections,
  resolveRefrigerantPipePairSpec,
  resolveRefrigerantPipeSpec,
} from './refrigerantPipePairModel';

export interface VrfValidationFixCommand {
  action: string;
  updates: Array<{ id: string; updates: Partial<HvacElement> }>;
}

export function resolveVrfValidationIssueElement(
  issue: VrfValidationIssue,
  elements: readonly HvacElement[],
): HvacElement | null {
  if (!issue.entityId) return null;
  const direct = elements.find((element) => element.id === issue.entityId)
    ?? elements.find((element) => issue.entityId!.startsWith(`${element.id}:`));
  if (direct) return direct;
  const pairPrefix = 'vrf:pipe-pair:';
  if (!issue.entityId.startsWith(pairPrefix)) return null;
  const sourceId = issue.entityId.slice(pairPrefix.length);
  return elements.find((element) => (
    element.id === sourceId || element.properties.bundleId === sourceId
  )) ?? null;
}

function routePoints(element: HvacElement): Point2D[] {
  if (element.type === 'refrigerant-pipe') {
    return resolveRefrigerantPipeSpec(element.properties).routePoints;
  }
  if (element.type === 'refrigerant-pipe-pair') {
    return resolveRefrigerantPipePairSpec(element.properties).routePoints;
  }
  return [];
}

function pipeGeometryUpdate(
  element: HvacElement,
  properties: Record<string, unknown>,
  elements: readonly HvacElement[],
): Partial<HvacElement> {
  const nextElement = { ...element, properties };
  const sceneElements = [...elements];
  const visual = element.type === 'refrigerant-pipe-pair'
    ? buildRefrigerantPipePairVisual(nextElement, sceneElements)
    : buildRefrigerantPipeVisual(nextElement, sceneElements);
  return {
    position: { x: visual.bounds.minX, y: visual.bounds.minY },
    width: visual.bounds.width,
    depth: visual.bounds.height,
    properties,
  };
}

/** Builds, but never commits, a deterministic one-step fix for an issue. */
export function buildVrfValidationFixCommand(
  issue: VrfValidationIssue,
  elements: readonly HvacElement[],
): VrfValidationFixCommand | null {
  const fix = issue.fix;
  const element = resolveVrfValidationIssueElement(issue, elements);
  if (!fix || !element) return null;

  if (fix.kind === 'mark-insulated') {
    return {
      action: 'Specify VRF insulation',
      updates: [{
        id: element.id,
        updates: { properties: { ...element.properties, insulated: true } },
      }],
    };
  }

  if (fix.kind === 'set-branch-model') {
    if (element.type !== 'refrigerant-branch-kit') return null;
    return {
      action: 'Apply recommended branch kit',
      updates: [{
        id: element.id,
        updates: {
          modelLabel: fix.model,
          properties: {
            ...element.properties,
            model: fix.model,
            modelOverride: false,
          },
        },
      }],
    };
  }

  if (fix.kind === 'level-branch') {
    if (element.type !== 'refrigerant-branch-kit') return null;
    const raw = element.properties.orientationQuaternion ?? element.properties.orientation3d;
    const quaternion: Record<string, unknown> | null = Array.isArray(raw)
      ? { x: raw[0], y: raw[1], z: raw[2], w: raw[3] }
      : raw && typeof raw === 'object'
        ? raw as Record<string, unknown>
        : null;
    const components = quaternion
      ? ['x', 'y', 'z', 'w'].map((key) => quaternion[key])
      : [];
    const hasQuaternion = components.length === 4
      && components.every((value) => typeof value === 'number' && Number.isFinite(value));
    const [rawX, rawY, rawZ, rawW] = hasQuaternion
      ? components as number[]
      : [0, 0, Math.sin(element.rotation * Math.PI / 360), Math.cos(element.rotation * Math.PI / 360)];
    const magnitude = Math.hypot(rawX!, rawY!, rawZ!, rawW!);
    const x = magnitude > 1e-9 ? rawX! / magnitude : 0;
    const y = magnitude > 1e-9 ? rawY! / magnitude : 0;
    const z = magnitude > 1e-9 ? rawZ! / magnitude : 0;
    const w = magnitude > 1e-9 ? rawW! / magnitude : 1;
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    const leveled = {
      x: 0,
      y: 0,
      z: Math.sin(yaw / 2),
      w: Math.cos(yaw / 2),
    };
    return {
      action: 'Level VRF branch fitting',
      updates: [{
        id: element.id,
        updates: {
          rotation: yaw * 180 / Math.PI,
          properties: {
            ...element.properties,
            orientationQuaternion: leveled,
            orientation3d: leveled,
          },
        },
      }],
    };
  }

  if (element.type !== 'refrigerant-pipe' && element.type !== 'refrigerant-pipe-pair') {
    return null;
  }

  if (fix.kind === 'set-pipe-diameter') {
    const properties = {
      ...element.properties,
      ...(element.type === 'refrigerant-pipe-pair'
        ? fix.lineKind === 'liquid'
          ? { liquidPipeDiameterMm: fix.diameterMm }
          : { gasPipeDiameterMm: fix.diameterMm }
        : { pipeDiameterMm: fix.diameterMm }),
    };
    return {
      action: 'Apply manufacturer pipe size',
      updates: [{
        id: element.id,
        updates: pipeGeometryUpdate(element, properties, elements),
      }],
    };
  }

  const currentRoute = routePoints(element);
  const constrained = constrainRefrigerantPipeRouteForConnections(
    element.type,
    element.properties,
    currentRoute,
  );
  const routed = withCanonicalPipeRoute(element, constrained);
  return {
    action: 'Repair equipment port stub',
    updates: [{
      id: element.id,
      updates: pipeGeometryUpdate(element, routed.properties, elements),
    }],
  };
}
