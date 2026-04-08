/**
 * Types, interfaces, and constants for DrawingCanvas.
 */

import type * as fabric from 'fabric';

import type { AcEquipmentDefinition, ArchitecturalObjectDefinition } from '../data';
import type { DisplayUnit, Point2D, SymbolInstance2D } from '../types';

import type { PaperUnit } from './canvas';

// =============================================================================
// Component Props
// =============================================================================

export interface DrawingCanvasProps {
    className?: string;
    gridSize?: number;
    snapToGrid?: boolean;
    showGrid?: boolean;
    showRulers?: boolean;
    paperUnit?: PaperUnit;
    realWorldUnit?: DisplayUnit;
    scaleDrawing?: number;
    scaleReal?: number;
    rulerMode?: 'paper' | 'real';
    majorTickInterval?: number;
    tickSubdivisions?: number;
    showRulerLabels?: boolean;
    gridMode?: 'paper' | 'real';
    majorGridSize?: number;
    gridSubdivisions?: number;
    backgroundColor?: string;
    onCanvasReady?: (canvas: fabric.Canvas) => void;
    objectDefinitions?: ArchitecturalObjectDefinition[];
    equipmentDefinitions?: AcEquipmentDefinition[];
    pendingPlacementObjectId?: string | null;
    pendingPlacementEquipmentId?: string | null;
    onObjectPlaced?: (definitionId: string, instance: SymbolInstance2D) => void;
    onCancelObjectPlacement?: () => void;
    onEquipmentPlaced?: (definitionId: string) => void;
    onCancelEquipmentPlacement?: () => void;
}

// =============================================================================
// Internal State Types
// =============================================================================

export interface CanvasState {
    isPanning: boolean;
    lastPanPoint: Point2D | null;
    isDrawing: boolean;
    drawingPoints: Point2D[];
}

export interface MarqueeSelectionState {
    active: boolean;
    start: Point2D | null;
    current: Point2D | null;
    mode: 'window' | 'crossing';
}

export interface WallContextMenuState {
    wallId: string;
    x: number;
    y: number;
}

export interface DimensionContextMenuState {
    dimensionId: string;
    x: number;
    y: number;
}

export interface SectionLineContextMenuState {
    sectionLineId: string;
    x: number;
    y: number;
}

export interface ObjectContextMenuState {
    objectId: string;
    x: number;
    y: number;
}

export interface OpeningResizeHandleHit {
    openingId: string;
    wallId: string;
    side: 'start' | 'end';
}

export interface OpeningPointerInteraction {
    openingId: string;
    mode: 'move' | 'resize-start' | 'resize-end';
    wallId?: string;
    anchorEdgeAlongWall?: number;
    grabOffsetAlongWallMm?: number;
    changed: boolean;
}

// =============================================================================
// Constants
// =============================================================================

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;
export const WHEEL_ZOOM_SENSITIVITY = 0.0015;
export const MIN_OPENING_EDGE_MARGIN_MM = 50;
export const MIN_OPENING_GEOMETRY_WIDTH_MM = 120;
export const OPENING_HIT_PADDING_MM = 20;
export const OPENING_RESIZE_HANDLE_SIZE_PX = 16;
export const OPENING_RESIZE_HANDLE_COLOR = '#7a2e0a';

// =============================================================================
// Utility Functions
// =============================================================================

export const clampValue = (value: number, min: number, max: number): number => {
    if (min > max) return value;
    return Math.min(max, Math.max(min, value));
};

export const hideActiveSelectionChrome = (canvas: fabric.Canvas | null): void => {
    if (!canvas) return;
    const activeObject = canvas.getActiveObject() as
        | (fabric.Object & {
            setControlsVisibility?: (options: Record<string, boolean>) => void;
            allowRotationControl?: boolean;
            objectCategory?: string;
            controls?: Record<string, fabric.Control | undefined>;
        })
        | null;
    if (!activeObject) return;

    if (activeObject.allowRotationControl) {
        activeObject.set({
            hasControls: true,
            hasBorders: false,
            borderColor: 'rgba(0,0,0,0)',
            cornerColor: '#2563EB',
            cornerStrokeColor: '#FFFFFF',
            transparentCorners: false,
            cornerSize: 14,
            touchCornerSize: 26,
            padding: 0,
        });
        if (typeof activeObject.setControlsVisibility === 'function') {
            activeObject.setControlsVisibility({
                tl: false,
                tr: false,
                bl: false,
                br: false,
                ml: false,
                mt: false,
                mr: false,
                mb: false,
                mtr: true,
            });
        }
        const rotationControl = activeObject.controls?.mtr;
        if (rotationControl) {
            rotationControl.offsetY = -28;
            rotationControl.withConnection = true;
        }
        return;
    }

    activeObject.set({
        hasControls: false,
        hasBorders: false,
        borderColor: 'rgba(0,0,0,0)',
        cornerColor: 'rgba(0,0,0,0)',
        cornerStrokeColor: 'rgba(0,0,0,0)',
        transparentCorners: true,
        cornerSize: 0,
        padding: 0,
    });
    if (typeof activeObject.setControlsVisibility === 'function') {
        activeObject.setControlsVisibility({
            tl: false,
            tr: false,
            bl: false,
            br: false,
            ml: false,
            mt: false,
            mr: false,
            mb: false,
            mtr: false,
        });
    }
};

/** Fabric object with a `name` property for identification. */
export type NamedObject = fabric.Object & { name?: string };
