/**
 * useMiddlePan Hook
 *
 * Handles middle mouse button panning for the canvas.
 */

import type * as fabric from 'fabric';
import { useRef, useCallback } from 'react';
import type { Point2D } from '../../../types';
import {
    buildViewportTransform,
    panFromViewportDelta,
} from '../viewTransform';

export interface MiddlePanState {
    active: boolean;
    lastX: number;
    lastY: number;
}

export interface UseMiddlePanOptions {
    fabricRef: React.RefObject<fabric.Canvas | null>;
    zoomRef: React.MutableRefObject<number>;
    panOffsetRef: React.MutableRefObject<Point2D>;
    safePaperPerRealRatio: number;
    setInteractionViewTransform: (zoom: number, offset: Point2D) => void;
    setViewTransform: (zoom: number, offset: Point2D) => void;
    wheelPendingZoom: React.MutableRefObject<number>;
    wheelPendingPan: React.MutableRefObject<Point2D>;
    wheelRafId: React.MutableRefObject<number | null>;
    setCanvasState: React.Dispatch<React.SetStateAction<{
        isPanning: boolean;
        lastPanPoint: Point2D | null;
        isDrawing: boolean;
        drawingPoints: Point2D[];
    }>>;
    canvasStateRef: React.MutableRefObject<{
        isPanning: boolean;
        lastPanPoint: Point2D | null;
        isDrawing: boolean;
        drawingPoints: Point2D[];
    }>;
}

export function useMiddlePan({
    fabricRef,
    zoomRef,
    panOffsetRef,
    safePaperPerRealRatio,
    setInteractionViewTransform,
    setViewTransform,
    wheelPendingZoom,
    wheelPendingPan,
    wheelRafId,
    setCanvasState,
    canvasStateRef,
}: UseMiddlePanOptions) {
    const middlePanRef = useRef<MiddlePanState>({
        active: false,
        lastX: 0,
        lastY: 0,
    });

    const stopMiddlePan = useCallback(() => {
        if (!middlePanRef.current.active) return;
        middlePanRef.current.active = false;
        const nextState = {
            ...canvasStateRef.current,
            isPanning: false,
            lastPanPoint: null,
        };
        canvasStateRef.current = nextState;
        setCanvasState(nextState);
    }, [canvasStateRef, setCanvasState]);

    const handleMiddleMouseDown = useCallback(
        (event: MouseEvent) => {
            if (event.button !== 1) return;
            event.preventDefault();
            const canvas = fabricRef.current;
            const downViewportPoint = canvas
                ? canvas.getViewportPoint(event as unknown as fabric.TPointerEvent)
                : { x: event.clientX, y: event.clientY };
            middlePanRef.current = {
                active: true,
                lastX: downViewportPoint.x,
                lastY: downViewportPoint.y,
            };
            const nextState = {
                ...canvasStateRef.current,
                isPanning: true,
                lastPanPoint: { x: downViewportPoint.x, y: downViewportPoint.y },
            };
            canvasStateRef.current = nextState;
            setCanvasState(nextState);
        },
        [fabricRef, canvasStateRef, setCanvasState]
    );

    const handleMiddleMouseMove = useCallback(
        (event: MouseEvent) => {
            if (!middlePanRef.current.active) return;
            if ((event.buttons & 4) !== 4) {
                stopMiddlePan();
                return;
            }
            event.preventDefault();

            const canvas = fabricRef.current;
            const viewportPoint = canvas
                ? canvas.getViewportPoint(event as unknown as fabric.TPointerEvent)
                : { x: event.clientX, y: event.clientY };
            const dx = viewportPoint.x - middlePanRef.current.lastX;
            const dy = viewportPoint.y - middlePanRef.current.lastY;

            middlePanRef.current.lastX = viewportPoint.x;
            middlePanRef.current.lastY = viewportPoint.y;

            const nextPan = panFromViewportDelta(
                panOffsetRef.current,
                dx,
                dy,
                zoomRef.current
            );
            panOffsetRef.current = nextPan;
            if (canvas) {
                canvas.setViewportTransform(
                    buildViewportTransform(zoomRef.current, nextPan)
                );
                canvas.requestRenderAll();
            }
            wheelPendingZoom.current = zoomRef.current / safePaperPerRealRatio;
            wheelPendingPan.current = nextPan;
            setInteractionViewTransform(wheelPendingZoom.current, nextPan);
            if (!wheelRafId.current) {
                wheelRafId.current = requestAnimationFrame(() => {
                    wheelRafId.current = null;
                    setViewTransform(
                        wheelPendingZoom.current,
                        wheelPendingPan.current
                    );
                });
            }
        },
        [
            fabricRef,
            zoomRef,
            panOffsetRef,
            safePaperPerRealRatio,
            setInteractionViewTransform,
            wheelPendingZoom,
            wheelPendingPan,
            wheelRafId,
            setViewTransform,
            stopMiddlePan,
        ]
    );

    const handleMiddleMouseUp = useCallback(
        (event: MouseEvent) => {
            if (event.button !== 1 && !middlePanRef.current.active) return;
            stopMiddlePan();
        },
        [stopMiddlePan]
    );

    const preventMiddleAuxClick = useCallback((event: MouseEvent) => {
        if (event.button === 1) {
            event.preventDefault();
        }
    }, []);

    return {
        middlePanRef,
        stopMiddlePan,
        handleMiddleMouseDown,
        handleMiddleMouseMove,
        handleMiddleMouseUp,
        preventMiddleAuxClick,
    };
}
