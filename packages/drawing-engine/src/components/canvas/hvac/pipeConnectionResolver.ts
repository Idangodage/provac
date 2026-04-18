/**
 * pipeConnectionResolver.ts
 *
 * Utilities for discovering which pipe elements are connected to a given
 * HVAC unit or branch-kit element, and for determining which end of a pipe
 * is the "fixed" anchor vs. the "moving" end when a unit is being dragged.
 *
 * This module is intentionally lightweight — it reads stored pipe properties
 * without resolving or healing them, so it can run on every drag frame
 * without overhead.
 */

import type { HvacElement, Point2D } from '../../../types';
import {
  buildRefrigerantPipePairVisual,
  buildRefrigerantPipeVisual,
  identifyMovingEnd,
  isRefrigerantPipeElementType,
  isRefrigerantPipePairType,
  type RefrigerantPipeBundleConnection,
  type RefrigerantPipeConnection,
} from './refrigerantPipePairModel';
import type { RefrigerantBranchTerminalRole } from './refrigerantBranchKitModel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectedPipeInfo {
  /** The pipe element itself */
  pipeElement: HvacElement;
  /** Which end of the pipe is connected to the moving unit */
  movingEnd: 'start' | 'end';
  /** Which end of the pipe is the fixed anchor */
  fixedEnd: 'start' | 'end';
  /** Whether this is a pipe-pair or single pipe */
  isPipePair: boolean;
}

export interface PipeEndpointInfo {
  /** Bundle center point (for pipe-pair) or port point (for single pipe) */
  point: Point2D;
  /** Direction the pipe leaves this endpoint */
  direction: Point2D;
  /** Connection kind at this end */
  connectionKind: 'unit-port' | 'field-pipe';
  /** Source element ID at this end */
  sourceElementId?: string;
}

// ---------------------------------------------------------------------------
// Helpers to read raw connection properties without full spec resolution
// ---------------------------------------------------------------------------

function readPoint(value: unknown): Point2D | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const x = typeof obj.x === 'number' ? obj.x : NaN;
  const y = typeof obj.y === 'number' ? obj.y : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function readBundleConnection(value: unknown): {
  point: Point2D;
  direction: Point2D;
  connectionKind: 'unit-port' | 'field-pipe';
  sourceElementId?: string;
  gasFieldPoint: Point2D;
  liquidFieldPoint: Point2D;
  gasPoint: Point2D;
  liquidPoint: Point2D;
  gasDirection?: Point2D;
  liquidDirection?: Point2D;
  elevationMm: number;
  gasElevationMm: number;
  liquidElevationMm: number;
  guideReference?: 'gas' | 'liquid' | 'center';
  terminalRole?: RefrigerantBranchTerminalRole;
} | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const point = readPoint(obj.point);
  const direction = readPoint(obj.direction);
  if (!point || !direction) return null;
  const gasFieldPoint = readPoint(obj.gasFieldPoint) ?? point;
  const liquidFieldPoint = readPoint(obj.liquidFieldPoint) ?? point;
  const gasPoint = readPoint(obj.gasPoint) ?? point;
  const liquidPoint = readPoint(obj.liquidPoint) ?? point;
  const gasDirection = readPoint(obj.gasDirection) ?? undefined;
  const liquidDirection = readPoint(obj.liquidDirection) ?? undefined;
  const guideReference = (obj.guideReference === 'gas' || obj.guideReference === 'liquid' || obj.guideReference === 'center')
    ? obj.guideReference
    : undefined;
  const VALID_TERMINAL_ROLES = new Set<string>(['inlet', 'run-outlet', 'branch-outlet']);
  const terminalRole = typeof obj.terminalRole === 'string' && VALID_TERMINAL_ROLES.has(obj.terminalRole)
    ? (obj.terminalRole as RefrigerantBranchTerminalRole)
    : undefined;
  const connectionKind = obj.connectionKind === 'field-pipe' ? 'field-pipe' : 'unit-port';
  const weldedGasFieldPoint = connectionKind === 'unit-port' ? gasPoint : gasFieldPoint;
  const weldedLiquidFieldPoint = connectionKind === 'unit-port' ? liquidPoint : liquidFieldPoint;
  return {
    point,
    direction,
    connectionKind,
    sourceElementId: typeof obj.sourceElementId === 'string' ? obj.sourceElementId : undefined,
    gasFieldPoint: weldedGasFieldPoint,
    liquidFieldPoint: weldedLiquidFieldPoint,
    gasPoint,
    liquidPoint,
    gasDirection,
    liquidDirection,
    elevationMm: typeof obj.elevationMm === 'number' ? obj.elevationMm : 0,
    gasElevationMm: typeof obj.gasElevationMm === 'number' ? obj.gasElevationMm : 0,
    liquidElevationMm: typeof obj.liquidElevationMm === 'number' ? obj.liquidElevationMm : 0,
    guideReference,
    terminalRole,
  };
}

function readPipeConnection(value: unknown): {
  portPoint: Point2D;
  direction: Point2D;
  connectionKind: 'unit-port' | 'field-pipe';
  sourceElementId?: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const portPoint = readPoint(obj.portPoint);
  const direction = readPoint(obj.direction);
  if (!portPoint || !direction) return null;
  return {
    portPoint,
    direction,
    connectionKind: obj.connectionKind === 'field-pipe' ? 'field-pipe' : 'unit-port',
    sourceElementId: typeof obj.sourceElementId === 'string' ? obj.sourceElementId : undefined,
  };
}

function readPointArray(value: unknown): Point2D[] {
  if (!Array.isArray(value)) return [];
  const out: Point2D[] = [];
  for (const item of value) {
    const pt = readPoint(item);
    if (pt) out.push(pt);
  }
  return out;
}

function readStoredLeadPivotPoint(
  properties: Record<string, unknown>,
  movingEnd: 'start' | 'end',
): Point2D | null {
  const key = movingEnd === 'start' ? 'startLeadPivotPoint' : 'endLeadPivotPoint';
  return readPoint(properties[key]);
}

function anchorRouteEndpoints(
  routePoints: Point2D[],
  startPoint: Point2D | null,
  endPoint: Point2D | null,
): Point2D[] {
  const route = routePoints.map((point) => ({ x: point.x, y: point.y }));
  if (route.length === 0) {
    if (startPoint && endPoint) {
      if (Math.hypot(startPoint.x - endPoint.x, startPoint.y - endPoint.y) <= 0.01) {
        return [startPoint];
      }
      return [startPoint, endPoint];
    }
    if (startPoint) return [startPoint];
    if (endPoint) return [endPoint];
    return route;
  }
  if (startPoint) {
    route[0] = startPoint;
  }
  if (endPoint) {
    route[route.length - 1] = endPoint;
  }
  if (route.length === 1 && startPoint && endPoint) {
    if (Math.hypot(startPoint.x - endPoint.x, startPoint.y - endPoint.y) > 0.01) {
      route.push(endPoint);
    }
  }
  return route;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find all pipe elements (single pipes or pipe-pairs) that are connected
 * to the given unit element by `sourceElementId`.
 */
export function findConnectedPipeElements(
  unitId: string,
  hvacElements: readonly HvacElement[],
): ConnectedPipeInfo[] {
  const result: ConnectedPipeInfo[] = [];

  for (const elem of hvacElements) {
    if (!isRefrigerantPipeElementType(elem.type)) continue;

    const props = elem.properties;
    const isPipePair = isRefrigerantPipePairType(elem.type);

    if (isPipePair) {
      const startConn = readBundleConnection(props.startBundleConnection);
      const endConn = readBundleConnection(props.endBundleConnection);
      const movingEnd = identifyMovingEnd(startConn, endConn, unitId);
      if (movingEnd) {
        result.push({
          pipeElement: elem,
          movingEnd,
          fixedEnd: movingEnd === 'start' ? 'end' : 'start',
          isPipePair: true,
        });
      }
    } else {
      // Single pipe
      const startConn = readPipeConnection(props.startConnection);
      const endConn = readPipeConnection(props.endConnection);

      if (startConn?.sourceElementId === unitId) {
        result.push({
          pipeElement: elem,
          movingEnd: 'start',
          fixedEnd: 'end',
          isPipePair: false,
        });
      } else if (endConn?.sourceElementId === unitId) {
        result.push({
          pipeElement: elem,
          movingEnd: 'end',
          fixedEnd: 'start',
          isPipePair: false,
        });
      }
    }
  }

  return result;
}

/**
 * Extract the fixed-end anchor information from a pipe element's stored
 * properties. This reads the connection at the fixed end (the one NOT
 * connected to the moving unit).
 */
export function getFixedEndInfo(
  pipeElement: HvacElement,
  fixedEnd: 'start' | 'end',
): PipeEndpointInfo | null {
  const props = pipeElement.properties;
  const isPipePair = isRefrigerantPipePairType(pipeElement.type);

  if (isPipePair) {
    const connKey = fixedEnd === 'start' ? 'startBundleConnection' : 'endBundleConnection';
    const conn = readBundleConnection(props[connKey]);
    if (!conn) return null;
    return {
      point: conn.point,
      direction: conn.direction,
      connectionKind: conn.connectionKind,
      sourceElementId: conn.sourceElementId,
    };
  } else {
    const connKey = fixedEnd === 'start' ? 'startConnection' : 'endConnection';
    const conn = readPipeConnection(props[connKey]);
    if (!conn) return null;
    return {
      point: conn.portPoint,
      direction: conn.direction,
      connectionKind: conn.connectionKind,
      sourceElementId: conn.sourceElementId,
    };
  }
}

/**
 * Extract the existing route points from a pipe element.
 */
export function getExistingRoutePoints(pipeElement: HvacElement): Point2D[] {
  return readPointArray(pipeElement.properties.routePoints);
}

export function getStoredLeadPivotPoint(
  pipeElement: HvacElement,
  movingEnd: 'start' | 'end',
): Point2D | null {
  return readStoredLeadPivotPoint(pipeElement.properties, movingEnd);
}

/**
 * Build updated pipe-pair properties after a unit move.
 *
 * This function:
 * - Keeps the fixed-end bundle connection unchanged
 * - Updates the moving-end bundle connection with the new unit port data
 * - Replaces routePoints with the rerouted path
 *
 * It returns a partial properties object that should be merged onto the
 * existing pipe element properties.
 */
export function buildReroutedPipePairProperties(params: {
  existingProperties: Record<string, unknown>;
  movingEnd: 'start' | 'end';
  newRoutePoints: Point2D[];
  newMovingEndBundle: RefrigerantPipeBundleConnection;
  leadPivotPoint?: Point2D | null;
}): Record<string, unknown> {
  const {
    existingProperties,
    movingEnd,
    newRoutePoints,
    newMovingEndBundle,
    leadPivotPoint = null,
  } = params;
  const existingStartBundle = readBundleConnection(existingProperties.startBundleConnection);
  const existingEndBundle = readBundleConnection(existingProperties.endBundleConnection);
  const nextStartBundle = movingEnd === 'start' ? newMovingEndBundle : existingStartBundle;
  const nextEndBundle = movingEnd === 'end' ? newMovingEndBundle : existingEndBundle;
  const anchoredRoutePoints = anchorRouteEndpoints(
    newRoutePoints,
    nextStartBundle?.point ?? null,
    nextEndBundle?.point ?? null,
  );

  const updates: Record<string, unknown> = {
    routePoints: anchoredRoutePoints,
  };

  if (movingEnd === 'start') {
    updates.startBundleConnection = newMovingEndBundle;
    if (leadPivotPoint) {
      updates.startLeadPivotPoint = leadPivotPoint;
    }
    // endBundleConnection stays as-is (fixed)
  } else {
    updates.endBundleConnection = newMovingEndBundle;
    if (leadPivotPoint) {
      updates.endLeadPivotPoint = leadPivotPoint;
    }
    // startBundleConnection stays as-is (fixed)
  }

  return { ...existingProperties, ...updates };
}

/**
 * Build updated single-pipe properties after a unit move.
 */
export function buildReroutedSinglePipeProperties(params: {
  existingProperties: Record<string, unknown>;
  movingEnd: 'start' | 'end';
  newRoutePoints: Point2D[];
  newMovingEndConnection: RefrigerantPipeConnection;
  leadPivotPoint?: Point2D | null;
}): Record<string, unknown> {
  const {
    existingProperties,
    movingEnd,
    newRoutePoints,
    newMovingEndConnection,
    leadPivotPoint = null,
  } = params;
  const existingStartConnection = readPipeConnection(existingProperties.startConnection);
  const existingEndConnection = readPipeConnection(existingProperties.endConnection);
  const nextStartConnection =
    movingEnd === 'start' ? newMovingEndConnection : existingStartConnection;
  const nextEndConnection =
    movingEnd === 'end' ? newMovingEndConnection : existingEndConnection;
  const anchoredRoutePoints = anchorRouteEndpoints(
    newRoutePoints,
    nextStartConnection?.portPoint ?? null,
    nextEndConnection?.portPoint ?? null,
  );

  const updates: Record<string, unknown> = {
    routePoints: anchoredRoutePoints,
  };

  if (movingEnd === 'start') {
    updates.startConnection = newMovingEndConnection;
    if (leadPivotPoint) {
      updates.startLeadPivotPoint = leadPivotPoint;
    }
  } else {
    updates.endConnection = newMovingEndConnection;
    if (leadPivotPoint) {
      updates.endLeadPivotPoint = leadPivotPoint;
    }
  }

  return { ...existingProperties, ...updates };
}

export function buildReroutedPipeElementFrame(
  pipeElement: HvacElement,
  nextProperties: Record<string, unknown>,
  contextElements?: readonly HvacElement[],
): Pick<HvacElement, 'position' | 'width' | 'depth'> {
  const visualContext = contextElements ? [...contextElements] : undefined;
  if (isRefrigerantPipePairType(pipeElement.type)) {
    const visual = buildRefrigerantPipePairVisual({
      position: pipeElement.position,
      width: pipeElement.width,
      depth: pipeElement.depth,
      elevation: pipeElement.elevation,
      properties: nextProperties,
    }, visualContext);
    return {
      position: {
        x: visual.bounds.minX,
        y: visual.bounds.minY,
      },
      width: visual.bounds.width,
      depth: visual.bounds.height,
    };
  }

  const visual = buildRefrigerantPipeVisual({
    position: pipeElement.position,
    width: pipeElement.width,
    depth: pipeElement.depth,
    elevation: pipeElement.elevation,
    properties: nextProperties,
  }, visualContext);
  return {
    position: {
      x: visual.bounds.minX,
      y: visual.bounds.minY,
    },
    width: visual.bounds.width,
    depth: visual.bounds.height,
  };
}

/**
 * Reads the raw bundle connection for the moving end. Used to get the
 * current (pre-move) connection data that needs to be updated.
 */
export function getMovingEndBundleConnection(
  pipeElement: HvacElement,
  movingEnd: 'start' | 'end',
): ReturnType<typeof readBundleConnection> {
  const connKey = movingEnd === 'start' ? 'startBundleConnection' : 'endBundleConnection';
  return readBundleConnection(pipeElement.properties[connKey]);
}

/**
 * Reads the raw single-pipe connection for the moving end.
 */
export function getMovingEndPipeConnection(
  pipeElement: HvacElement,
  movingEnd: 'start' | 'end',
): ReturnType<typeof readPipeConnection> {
  const connKey = movingEnd === 'start' ? 'startConnection' : 'endConnection';
  return readPipeConnection(pipeElement.properties[connKey]);
}
