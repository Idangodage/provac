import type * as fabric from 'fabric';

import type { Point2D } from '../../types';

const MIN_SAFE_ZOOM = 0.0001;

function safeZoom(zoom: number): number {
    return Math.max(Number.isFinite(zoom) ? zoom : 0, MIN_SAFE_ZOOM);
}

export function buildViewportTransform(
    viewportZoom: number,
    panOffset: Point2D
): fabric.TMat2D {
    const z = safeZoom(viewportZoom);
    return [
        z,
        0,
        0,
        z,
        -panOffset.x * z,
        -panOffset.y * z,
    ];
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
