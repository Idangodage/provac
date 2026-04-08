/**
 * Tool Utilities
 *
 * Helper functions for drawing tools and canvas interactions.
 */

import * as fabric from 'fabric';

import type { Point2D, DrawingTool } from '../../types';

// =============================================================================
// Tool Helpers
// =============================================================================

export function getToolCursor(tool: DrawingTool): string {
    switch (tool) {
        case 'select':
            return 'default';
        case 'pan':
            return 'grab';
        case 'dimension':
        case 'wall':
        case 'partition-wall':
        case 'section-line':
        case 'room':
            return 'crosshair';
        case 'pencil':
        case 'spline':
            return 'crosshair';
        case 'text':
            return 'text';
        case 'eraser':
            return 'not-allowed';
        case 'offset':
            return 'crosshair';
        case 'trim':
            return 'crosshair';
        case 'extend':
            return 'crosshair';
        default:
            return 'default';
    }
}

export function isDrawingTool(tool: DrawingTool): boolean {
    return ['pencil', 'spline', 'dimension', 'rectangle', 'circle', 'line', 'wall', 'partition-wall', 'room', 'section-line'].includes(tool);
}

export function isEditableElement(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(
        target.closest(
            'input, textarea, select, button, [contenteditable=""], [contenteditable="true"]'
        )
    );
}

export function getScenePointFromMouseEvent(canvas: fabric.Canvas, event: MouseEvent): Point2D {
    const point = canvas.getScenePoint(event as unknown as fabric.TPointerEvent);
    return { x: point.x, y: point.y };
}

// =============================================================================
// Drawing Preview
// =============================================================================

export function renderDrawingPreview(
    canvas: fabric.Canvas,
    points: Point2D[],
    tool: DrawingTool
): void {
    clearDrawingPreviewObjects(canvas);

    if (points.length < 2) return;
    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    if (!firstPoint || !lastPoint) return;

    let previewObject: fabric.Object | null = null;

    switch (tool) {
        case 'line':
            previewObject = new fabric.Line(
                [firstPoint.x, firstPoint.y, lastPoint.x, lastPoint.y],
                {
                    stroke: '#2196F3',
                    strokeWidth: 2,
                    strokeDashArray: [5, 5],
                    selectable: false,
                    evented: false,
                    name: 'drawing-preview',
                }
            );
            break;

        case 'pencil':
        case 'spline':
            previewObject = new fabric.Polyline(
                points.map((p) => ({ x: p.x, y: p.y })),
                {
                    stroke: '#2196F3',
                    strokeWidth: 2,
                    strokeDashArray: [5, 5],
                    fill: 'transparent',
                    selectable: false,
                    evented: false,
                    name: 'drawing-preview',
                }
            );
            break;

        case 'rectangle':
            if (points.length >= 2) {
                const start = points[0];
                const end = points[points.length - 1];
                if (!start || !end) break;
                previewObject = new fabric.Rect({
                    left: Math.min(start.x, end.x),
                    top: Math.min(start.y, end.y),
                    width: Math.abs(end.x - start.x),
                    height: Math.abs(end.y - start.y),
                    stroke: '#2196F3',
                    strokeWidth: 2,
                    strokeDashArray: [5, 5],
                    fill: 'transparent',
                    selectable: false,
                    evented: false,
                    name: 'drawing-preview',
                });
            }
            break;

        case 'circle':
            if (points.length >= 2) {
                const center = points[0];
                const edge = points[points.length - 1];
                if (!center || !edge) break;
                const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
                previewObject = new fabric.Circle({
                    left: center.x - radius,
                    top: center.y - radius,
                    radius,
                    stroke: '#2196F3',
                    strokeWidth: 2,
                    strokeDashArray: [5, 5],
                    fill: 'transparent',
                    selectable: false,
                    evented: false,
                    name: 'drawing-preview',
                });
            }
            break;
    }

    if (previewObject) {
        canvas.add(previewObject);
        canvas.renderAll();
    }
}

function clearDrawingPreviewObjects(canvas: fabric.Canvas): void {
    const previewObjects = canvas
        .getObjects()
        .filter((obj) => (obj as unknown as { name?: string }).name === 'drawing-preview');
    previewObjects.forEach((obj) => canvas.remove(obj));
}
