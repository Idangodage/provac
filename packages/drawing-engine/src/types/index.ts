/**
 * Smart Drawing Types
 *
 * Core type definitions for the drawing system.
 */

import type { ReactNode } from 'react';

// Re-export wall types
export * from './wall';
export * from './grips';
export * from './room';

// =============================================================================
// Geometry Types
// =============================================================================

export interface Point2D {
  x: number;
  y: number;
}

export type DisplayUnit = 'mm' | 'cm' | 'm' | 'ft-in';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface Transform2D {
  position: Point2D;
  rotation: number;
  scale: number;
}

// =============================================================================
// Spline Types (AutoCAD-like)
// =============================================================================

export type SplineType = 'catmullRom' | 'bezier' | 'bspline' | 'nurbs';
export type SplineMethod = 'catmull-rom' | 'bezier' | 'b-spline' | 'nurbs';
export type SplineFitMethod = 'fit-points' | 'control-vertices';
export type KnotParameterization = 'uniform' | 'chord' | 'centripetal' | 'custom';

export interface SplineSettings {
  type?: SplineType;
  method: SplineMethod;
  fitMethod: SplineFitMethod;
  tension: number;
  continuity: number;
  bias: number;
  closed: boolean;
  degree: number;
  fitTolerance: number;
  knotParameterization: KnotParameterization;
  weights?: number[];
  samplesPerSegment?: number;
  showControlPoints: boolean;
  showControlPolygon: boolean;
  showFitPoints: boolean;
  showTangentHandles: boolean;
}

export interface SplineControlPoint {
  position: Point2D;
  tangentIn?: Point2D;
  tangentOut?: Point2D;
  weight?: number;
  isCorner?: boolean;
}

// =============================================================================
// Drawing Elements
// =============================================================================

export type SketchType =
  | 'line'
  | 'construction-line'
  | 'polyline'
  | 'polygon'
  | 'rectangle'
  | 'circle'
  | 'ellipse'
  | 'arc'
  | 'spline'
  | 'revision-cloud'
  | 'freehand'
  | 'pencil';

export type DrawingTool =
  | 'select'
  | 'pan'
  | 'wall'
  | 'partition-wall'
  | 'section-line'
  | 'room'
  | 'dimension'
  | 'text'
  | 'eraser'
  | 'calibrate'
  | 'line'
  | 'construction-line'
  | 'polyline'
  | 'polygon'
  | 'rectangle'
  | 'circle'
  | 'ellipse'
  | 'arc'
  | 'spline'
  | 'revision-cloud'
  | 'pencil'
  | 'refrigerant-pipe'
  | 'offset'
  | 'trim'
  | 'extend';

export type DimensionType = 'linear' | 'aligned' | 'angular' | 'radius' | 'diameter' | 'area';
export type DimensionLinearMode = 'horizontal' | 'vertical' | 'aligned';
export type DimensionStyle = 'architectural' | 'engineering' | 'minimal';
export type DimensionUnitSystem = 'metric' | 'imperial';
export type DimensionDisplayFormat = 'auto' | 'mm' | 'm' | 'in' | 'ft-in';
export type DimensionTerminator = 'arrow' | 'tick';
export type DimensionPlacementType = 'linear' | 'angular' | 'area';

export interface DimensionAnchor {
  kind: 'point' | 'wall-endpoint' | 'wall-midpoint';
  point?: Point2D;
  wallId?: string;
  endpoint?: 'start' | 'end';
}

export interface DimensionSettings {
  style: DimensionStyle;
  unitSystem: DimensionUnitSystem;
  displayFormat: DimensionDisplayFormat;
  precision: 0 | 1 | 2;
  defaultOffset: number;            // mm
  extensionGap: number;             // mm
  extensionBeyond: number;          // mm
  textHeightPaperMm: number;        // intended paper text size
  terminator: DimensionTerminator;
  placementType: DimensionPlacementType;
  showAreaPerimeter: boolean;
  autoAvoidOverlap: boolean;
  showLayer: boolean;
}

export const DEFAULT_DIMENSION_SETTINGS: DimensionSettings = {
  style: 'architectural',
  unitSystem: 'metric',
  displayFormat: 'auto',
  precision: 1,
  defaultOffset: 500,
  extensionGap: 2,
  extensionBeyond: 20,
  textHeightPaperMm: 2.5,
  terminator: 'tick',
  placementType: 'linear',
  showAreaPerimeter: false,
  autoAvoidOverlap: true,
  showLayer: true,
};

export interface Dimension2D {
  id: string;
  type: DimensionType;
  points: Point2D[];
  value: number;
  unit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'ft-in';
  text?: string;
  textPosition: Point2D;
  visible: boolean;
  linearMode?: DimensionLinearMode;
  style?: DimensionStyle;
  precision?: 0 | 1 | 2;
  displayFormat?: DimensionDisplayFormat;
  offset?: number;
  showPerimeter?: boolean;
  linkedRoomId?: string;
  linkedWallIds?: string[];
  anchors?: DimensionAnchor[];
  isAssociative?: boolean;
  isDesignValue?: boolean;
  textPositionLocked?: boolean;
  textPositionRatio?: number;
  autoBaseOffset?: number;
  autoOffsetAdjustment?: number;
  chainGroupId?: string;
  baselineGroupId?: string;
  baselineOrigin?: Point2D;
}

export interface Annotation2D {
  id: string;
  type: 'text' | 'leader' | 'callout';
  position: Point2D;
  text: string;
  leaderPoints?: Point2D[];
  visible: boolean;
}

export interface Sketch2D {
  id: string;
  type: SketchType;
  points: Point2D[];
  closed?: boolean;
  radius?: number;
  rx?: number;
  ry?: number;
  strokeWidth?: number;
  splineSettings?: SplineSettings;
  controlPoints?: SplineControlPoint[];
  knotVector?: number[];
}

export interface Guide {
  id: string;
  type: 'horizontal' | 'vertical';
  offset: number;
}

// =============================================================================
// Symbol Types
// =============================================================================

export interface Symbol {
  id: string;
  name: string;
  category: string;
  icon: ReactNode;
  svgPath?: string;
  viewBox?: { width: number; height: number };
  defaultWidth: number;
  defaultHeight: number;
  tags: string[];
  favorite?: boolean;
}

export interface SymbolCategory {
  id: string;
  name: string;
  icon: ReactNode;
  symbols: symbol[];
}

export interface SymbolInstance2D {
  id: string;
  symbolId: string;
  position: Point2D;
  rotation: number;
  scale: number;
  flipped: boolean;
  properties: Record<string, unknown>;
}

// =============================================================================
// Import/Calibration Types
// =============================================================================

export type SourceType = 'pdf' | 'image' | 'dxf' | 'ifc' | 'sketch';

export interface CalibrationPoint {
  id: string;
  pixelPoint: Point2D;
  realWorldDistance?: number;
}

export interface ImportedDrawing {
  id: string;
  name: string;
  sourceType: SourceType;
  dataUrl: string;
  originalWidth: number;
  originalHeight: number;
  scale: number;
  rotation: number;
  opacity: number;
  locked: boolean;
  calibrationPoints?: CalibrationPoint[];
}

export interface DetectedElement {
  id: string;
  type: 'wall' | 'door' | 'window' | 'room' | 'text' | 'dimension';
  confidence: number;
  points: Point2D[];
  boundingBox: { x: number; y: number; width: number; height: number };
  metadata?: Record<string, unknown>;
  accepted: boolean;
}

// =============================================================================
// Layer Types
// =============================================================================

export interface DrawingLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  color?: string;
  elements: string[];
}

// =============================================================================
// Page Configuration
// =============================================================================

export interface PageConfig {
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
}

export interface PageLayout {
  id: string;
  label: string;
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
}

// =============================================================================
// History Types
// =============================================================================

import type { ElevationView, HvacElement, Room, SectionLine, Wall } from './wall';

export interface HistorySnapshot {
  detectedElements: DetectedElement[];
  dimensions: Dimension2D[];
  annotations: Annotation2D[];
  sketches: Sketch2D[];
  symbols: SymbolInstance2D[];
  walls: Wall[];
  rooms: Room[];
  sectionLines: SectionLine[];
  elevationViews: ElevationView[];
  activeElevationViewId: string | null;
  hvacElements: HvacElement[];
}

export interface HistoryEntry {
  id: string;
  timestamp: number;
  action: string;
  snapshot: HistorySnapshot;
}
