import type * as fabric from 'fabric';

import type { Point2D } from '../../types';

import { viewportToViewTransform, type ViewTransform2D } from './coordinateTransform';

const MIN_SAFE_ZOOM = 0.0001;

function safeZoom(zoom: number): number {
    return Math.max(Number.isFinite(zoom) ? zoom : 0, MIN_SAFE_ZOOM);
}

/** Fabric viewport matrix for a canonical {@link ViewTransform2D}. */
export function viewTransformToFabricMatrix(view: ViewTransform2D): fabric.TMat2D {
    return [view.zoom, 0, 0, view.zoom, view.panPx.x, view.panPx.y];
}

export interface KonvaLayerTransform {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
}

/** Konva interaction-layer transform for a canonical {@link ViewTransform2D}. */
export function viewTransformToKonvaLayer(view: ViewTransform2D): KonvaLayerTransform {
    return { x: view.panPx.x, y: view.panPx.y, scaleX: view.zoom, scaleY: view.zoom };
}

/**
 * Fabric viewport matrix from raw viewport state. Now derived from the single
 * canonical {@link viewportToViewTransform} so Fabric and the Konva pipe layer
 * share one transform definition (numerically identical to the prior inline
 * `[z,0,0,z,-pan.x*z,-pan.y*z]`).
 */
export function buildViewportTransform(
    viewportZoom: number,
    panOffset: Point2D
): fabric.TMat2D {
    return viewTransformToFabricMatrix(viewportToViewTransform(viewportZoom, panOffset));
}

export function panFromViewportDelta(
    currentPan: Point2D,
    deltaViewportX: number,
    deltaViewportY: number,
    viewportZoom: number
): Point2D {
    const z = safeZoom(viewportZoom);
    return {
        x: currentPan.x - deltaViewportX / z,
        y: currentPan.y - deltaViewportY / z,
    };
}

export function panForZoomAtViewportPoint(
    currentPan: Point2D,
    currentViewportZoom: number,
    nextViewportZoom: number,
    viewportPoint: Point2D
): Point2D {
    const currentZ = safeZoom(currentViewportZoom);
    const nextZ = safeZoom(nextViewportZoom);
    const sceneX = currentPan.x + viewportPoint.x / currentZ;
    const sceneY = currentPan.y + viewportPoint.y / currentZ;
    return {
        x: sceneX - viewportPoint.x / nextZ,
        y: sceneY - viewportPoint.y / nextZ,
    };
}
