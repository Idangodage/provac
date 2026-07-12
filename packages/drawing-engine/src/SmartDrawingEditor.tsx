/**
 * Smart Drawing Editor
 * 
 * Main editor component that combines all smart drawing features
 * into a complete HVAC CAD application.
 */

'use client';

import * as fabric from 'fabric';
import {
  PanelLeftClose,
  PanelRightClose,
  Settings,
  Download,
  Upload,
  Save,
  Grid3X3,
  Ruler,
  Move,
  Minus,
  BoxSelect,
  Type,
  ZoomIn,
  ZoomOut,
  Home,
  RotateCcw,
  RotateCw,
  Layers,
  Fan,
} from 'lucide-react';
import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { shallow } from 'zustand/shallow';

import {
  DrawingCanvas,
  Toolbar,
  AttributeQuickToolbar,
  PropertiesPanel,
  ObjectLibraryPanel,
  SymbolPalette,
  ZoomIndicator,
  CoordinatesDisplay,
  AcEquipmentPanel,
} from './components';
import {
  boardSettingsToCanvasProps,
  boardValueFromMm,
  boardValueToMm,
  type BoardMeasurementMode,
  type BoardSettings,
} from './components/canvas/measurement';
import { PX_TO_MM, fromMillimeters, getUnitLabel } from './components/canvas/scale';
import {
  DEFAULT_AC_EQUIPMENT_LIBRARY,
  DEFAULT_ARCHITECTURAL_OBJECT_LIBRARY,
  type AcEquipmentDefinition,
  type ArchitecturalObjectDefinition,
} from './data';
import type { SymbolDefinition } from './data/symbol-library';
import { useSmartDrawingStore } from './store';
import { useDrawingInteractionStore } from './store/interactionStore';
import type { DisplayUnit, DrawingTool, PageLayout } from './types';
import type { ManufacturerRuleProfile } from './vrf/rules';


// =============================================================================
// Types
// =============================================================================

export interface SmartDrawingEditorProps {
  /** Unique identifier for the project/drawing */
  projectId?: string;
  /** Initial drawing data to load */
  initialData?: unknown;
  /** Callback when drawing data changes */
  onDataChange?: (data: unknown) => void;
  /** Callback when saving is requested */
  onSave?: (data: unknown) => Promise<void>;
  /** Whether the editor is in read-only mode */
  readOnly?: boolean;
  /** Custom class name */
  className?: string;
  /** Verified manufacturer engineering profile used for VRF routing and validation. */
  vrfRuleProfile?: ManufacturerRuleProfile;
}

// =============================================================================
// Ribbon Controls
// =============================================================================

type RibbonTone = 'default' | 'accent' | 'ghost';
const PX_PER_INCH = 96;
const MM_PER_INCH = 25.4;
const mmToPx = (mm: number) => (mm / MM_PER_INCH) * PX_PER_INCH;

const SCALE_PRESETS = [
  '1:1',
  '1:2',
  '1:5',
  '1:10',
  '1:20',
  '1:25',
  '1:50',
  '1:100',
  '1:200',
  '1:500',
  '1:1000',
  '2:1',
  '5:1',
  '10:1',
] as const;

function parseScaleRatio(input: string): { drawing: number; real: number } | null {
  const parts = input.split(':');
  if (parts.length !== 2) return null;
  const drawingRaw = parts[0];
  const realRaw = parts[1];
  if (!drawingRaw || !realRaw) return null;
  const drawing = Number.parseInt(drawingRaw, 10);
  const real = Number.parseInt(realRaw, 10);
  if (!Number.isFinite(drawing) || !Number.isFinite(real) || drawing <= 0 || real <= 0) return null;
  return { drawing, real };
}

function RibbonButton({
  icon,
  label,
  onClick,
  disabled,
  tone = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: RibbonTone;
}) {
  const toneClasses: Record<RibbonTone, string> = {
    default: 'bg-white border-amber-200/80 text-slate-700 hover:bg-amber-50',
    accent: 'bg-amber-400 border-amber-400 text-amber-950 hover:bg-amber-300',
    ghost: 'bg-transparent border-transparent text-slate-600 hover:bg-amber-50',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        `inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ` +
        `${toneClasses[tone]} ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ToggleChip({
  icon,
  label,
  active,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        `inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors ` +
        `${active ? 'bg-amber-200 text-amber-900 border-amber-300' : 'bg-white text-slate-600 border-amber-200/80 hover:bg-amber-50'} ` +
        `${disabled ? 'opacity-60 cursor-not-allowed' : ''}`
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function RibbonIconButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-amber-200/80 bg-white text-slate-700 transition-colors hover:bg-amber-50 ${
        disabled ? 'opacity-60 cursor-not-allowed' : ''
      }`}
    >
      {icon}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function QuickActionButton({
  icon,
  label,
  active,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        `flex items-center gap-1.5 px-2 py-1.5 min-h-[36px] rounded-md border text-[11px] font-medium transition-colors ` +
        `${active ? 'bg-amber-200 text-amber-900 border-amber-300' : 'bg-white text-slate-600 border-amber-200/80 hover:bg-amber-50'} ` +
        `${disabled ? 'opacity-60 cursor-not-allowed' : ''}`
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * Compact "Grid" popover: mode (paper/real), major step in the active unit,
 * sub-divisions, and ruler mode. Writes straight to the persisted board
 * settings so the visible grid AND the snap step change together.
 */
function BoardGridSettings({
  boardSettings,
  displayUnit,
  onChange,
  disabled,
}: {
  boardSettings: BoardSettings;
  displayUnit: DisplayUnit;
  onChange: (settings: Partial<BoardSettings>) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const gridUnit = boardSettings.gridMode === 'real' ? displayUnit : boardSettings.paperUnit;
  const majorMm = boardSettings.gridMode === 'real'
    ? boardSettings.majorGridRealMm
    : boardSettings.majorGridPaperMm;
  const majorValue = boardValueFromMm(majorMm, gridUnit);
  const minorValue = majorValue / boardSettings.gridSubdivisions;

  const applyMajorValue = (raw: string) => {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const mm = boardValueToMm(parsed, gridUnit);
    onChange(
      boardSettings.gridMode === 'real'
        ? { majorGridRealMm: mm }
        : { majorGridPaperMm: mm },
    );
  };

  const selectClass =
    'h-6 rounded border border-amber-200/80 bg-white px-1 text-[10px] text-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-300';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition-colors ${
          open
            ? 'border-amber-300 bg-amber-100 text-amber-900'
            : 'border-amber-200/80 bg-white text-slate-600 hover:bg-amber-50'
        }`}
        title="Grid & ruler settings"
      >
        <Grid3X3 size={12} />
        Grid
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-50 w-60 rounded-lg border border-amber-200/80 bg-white p-3 shadow-lg">
          <div className="space-y-2 text-[11px] text-slate-600">
            <div className="flex items-center justify-between gap-2">
              <span>Grid mode</span>
              <select
                value={boardSettings.gridMode}
                onChange={(e) => onChange({ gridMode: e.target.value as BoardMeasurementMode })}
                className={selectClass}
              >
                <option value="paper">Paper sheet</option>
                <option value="real">Real world</option>
              </select>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Major step ({getUnitLabel(gridUnit)})</span>
              <input
                type="number"
                min={0.1}
                step={boardSettings.gridMode === 'real' ? 100 : 1}
                value={Number.isFinite(majorValue) ? Number(majorValue.toFixed(3)) : 0}
                onChange={(e) => applyMajorValue(e.target.value)}
                className="h-6 w-20 rounded border border-amber-200/80 bg-white px-1 text-right text-[10px] text-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-300"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Sub-divisions</span>
              <select
                value={boardSettings.gridSubdivisions}
                onChange={(e) => onChange({ gridSubdivisions: Number.parseInt(e.target.value, 10) })}
                className={selectClass}
              >
                {[1, 2, 4, 5, 8, 10].map((count) => (
                  <option key={count} value={count}>{count}</option>
                ))}
              </select>
            </div>
            <div className="rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-800">
              Snap step: {Number(minorValue.toFixed(3))} {getUnitLabel(gridUnit)}
              {boardSettings.gridMode === 'paper' &&
                ` (paper) = ${Number(
                  boardValueFromMm(
                    (majorMm / boardSettings.gridSubdivisions) *
                      (boardSettings.scaleReal / boardSettings.scaleDrawing),
                    displayUnit,
                  ).toFixed(3),
                )} ${getUnitLabel(displayUnit)} real`}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-amber-100 pt-2">
              <span>Rulers read</span>
              <select
                value={boardSettings.rulerMode}
                onChange={(e) => onChange({ rulerMode: e.target.value as BoardMeasurementMode })}
                className={selectClass}
              >
                <option value="real">Real world ({getUnitLabel(displayUnit)})</option>
                <option value="paper">Paper sheet ({getUnitLabel(boardSettings.paperUnit)})</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EditorRibbon({
  projectId,
  onExportJSON,
  onExportSVG,
  onExportPNG,
  onImport,
  onSave,
  zoomLevel,
  canUndo,
  canRedo,
  onZoomIn,
  onZoomOut,
  onResetView,
  onUndo,
  onRedo,
  saveState,
  lastSavedAt,
  showGrid,
  showRulers,
  snapToGrid,
  onToggleGrid,
  onToggleRulers,
  onToggleSnap,
  pageConfig,
  pageLayouts,
  onPageChange,
  scalePreset,
  onScaleChange,
  boardSettings,
  displayUnit,
  onBoardSettingsChange,
  onDisplayUnitChange,
  readOnly,
}: {
  projectId?: string;
  onExportJSON: () => void;
  onExportSVG: () => void;
  onExportPNG: () => void;
  onImport: () => void;
  onSave?: () => void;
  zoomLevel: number;
  canUndo: boolean;
  canRedo: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  onUndo: () => void;
  onRedo: () => void;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  lastSavedAt: string | null;
  showGrid: boolean;
  showRulers: boolean;
  snapToGrid: boolean;
  onToggleGrid: () => void;
  onToggleRulers: () => void;
  onToggleSnap: () => void;
  pageConfig: { width: number; height: number; orientation: 'portrait' | 'landscape' };
  pageLayouts: PageLayout[];
  onPageChange: (layoutId: string) => void;
  scalePreset: string;
  onScaleChange: (value: string) => void;
  boardSettings: BoardSettings;
  displayUnit: DisplayUnit;
  onBoardSettingsChange: (settings: Partial<BoardSettings>) => void;
  onDisplayUnitChange: (unit: DisplayUnit) => void;
  readOnly: boolean;
}) {
  const currentLayoutId =
    pageLayouts.find(
      (layout) =>
        layout.width === pageConfig.width &&
        layout.height === pageConfig.height &&
        layout.orientation === pageConfig.orientation
    )?.id ?? 'custom';
  const pageWidthMm = Math.round((pageConfig.width / PX_PER_INCH) * MM_PER_INCH);
  const pageHeightMm = Math.round((pageConfig.height / PX_PER_INCH) * MM_PER_INCH);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-200/70 bg-[#fff3d6] px-3 py-1.5">
      <div className="flex items-center gap-2">
        <RibbonButton icon={<Upload size={14} />} label="Import" onClick={onImport} />
        <RibbonButton icon={<Download size={14} />} label="JSON" onClick={onExportJSON} />
        <RibbonIconButton icon={<Download size={14} />} label="Export SVG" onClick={onExportSVG} />
        <RibbonIconButton icon={<Download size={14} />} label="Export PNG" onClick={onExportPNG} />
        {onSave && (
          <RibbonButton
            icon={<Save size={14} />}
            label={saveState === 'saving' ? 'Saving' : 'Save'}
            onClick={onSave}
            disabled={readOnly || saveState === 'saving'}
            tone="accent"
          />
        )}
      </div>

      <div className="h-5 w-px bg-amber-200/80" />

      <div className="flex items-center gap-1">
        <RibbonIconButton icon={<RotateCcw size={14} />} label="Undo" onClick={onUndo} disabled={!canUndo} />
        <RibbonIconButton icon={<RotateCw size={14} />} label="Redo" onClick={onRedo} disabled={!canRedo} />
        <RibbonIconButton icon={<ZoomOut size={14} />} label="Zoom out" onClick={onZoomOut} />
        <RibbonIconButton icon={<ZoomIn size={14} />} label="Zoom in" onClick={onZoomIn} />
        <RibbonIconButton icon={<Home size={14} />} label="Reset view" onClick={onResetView} />
        <span className="px-1 text-[11px] font-semibold text-slate-600">{Math.round(zoomLevel * 100)}%</span>
      </div>

      <div className="h-5 w-px bg-amber-200/80" />

      <div className="flex items-center gap-2">
        <ToggleChip icon={<Grid3X3 size={14} />} label="Grid" active={showGrid} onClick={onToggleGrid} />
        <ToggleChip icon={<Move size={14} />} label="Snap" active={snapToGrid} onClick={onToggleSnap} />
        <ToggleChip icon={<Ruler size={14} />} label="Rulers" active={showRulers} onClick={onToggleRulers} />
        <div className="ml-2 flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Page</span>
          <select
            value={currentLayoutId}
            onChange={(e) => onPageChange(e.target.value)}
            className="h-7 rounded-md border border-amber-200/80 bg-white px-2 text-[10px] font-medium text-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-300"
          >
            {pageLayouts.map((layout) => (
              <option key={layout.id} value={layout.id}>
                {layout.label}
              </option>
            ))}
            <option value="custom">Custom ({pageWidthMm}x{pageHeightMm} mm)</option>
          </select>
        </div>
        <div className="ml-2 flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Scale</span>
          <select
            value={scalePreset}
            onChange={(e) => onScaleChange(e.target.value)}
            className="h-7 rounded-md border border-amber-200/80 bg-white px-2 text-[10px] font-medium text-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-300"
          >
            {SCALE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {preset}
              </option>
            ))}
          </select>
        </div>
        <div className="ml-2 flex items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Unit</span>
          <select
            value={displayUnit}
            onChange={(e) => onDisplayUnitChange(e.target.value as DisplayUnit)}
            className="h-7 rounded-md border border-amber-200/80 bg-white px-2 text-[10px] font-medium text-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-300"
          >
            <option value="mm">mm</option>
            <option value="cm">cm</option>
            <option value="m">m</option>
            <option value="ft-in">ft-in</option>
          </select>
        </div>
        <div className="ml-2">
          <BoardGridSettings
            boardSettings={boardSettings}
            displayUnit={displayUnit}
            onChange={onBoardSettingsChange}
            disabled={readOnly}
          />
        </div>
      </div>

      <div className="flex-1" />

      <div className="hidden items-center gap-3 text-xs text-slate-500 lg:flex">
        {projectId && (
          <span>
            Project: <span className="font-medium text-slate-700">{projectId}</span>
          </span>
        )}
        <span>
          Scale: <span className="font-medium text-slate-700">{scalePreset}</span>
        </span>
        {saveState === 'saving' && <span>Saving changes...</span>}
        {saveState === 'saved' && lastSavedAt && <span>Saved {lastSavedAt}</span>}
        {saveState === 'error' && <span className="text-red-600">Save failed</span>}
      </div>
    </div>
  );
}

// =============================================================================
// Editor Footer
// =============================================================================

function EditorFooter({
  elementCount,
  areaSummary,
}: {
  elementCount: number;
  areaSummary: {
    totalFloorArea: number;
    usableArea: number;
    circulationArea: number;
  };
}) {
  const mousePosition = useDrawingInteractionStore((state) => state.mousePosition);
  const statusMessage = useSmartDrawingStore((state) => state.processingStatus);
  const displayUnit = useSmartDrawingStore((state) => state.displayUnit);
  // mousePosition is in fabric scene pixels (real mm × MM_TO_PX): convert to
  // the assigned display unit so the readout tracks the board settings.
  const cursorX = fromMillimeters(mousePosition.x * PX_TO_MM, displayUnit);
  const cursorY = fromMillimeters(mousePosition.y * PX_TO_MM, displayUnit);

  return (
    <div className="flex h-7 items-center justify-between border-t border-amber-200/70 bg-[#fffaf0] px-3 text-[11px] text-slate-600">
      <div className="flex items-center gap-3">
        <span>Elements: {elementCount}</span>
        <span>|</span>
        <span className="hidden xl:inline">
          Total: {areaSummary.totalFloorArea.toFixed(1)} m2 | Usable: {areaSummary.usableArea.toFixed(1)} m2
        </span>
        <span className="hidden xl:inline">|</span>
        <CoordinatesDisplay
          x={cursorX}
          y={cursorY}
          unit={getUnitLabel(displayUnit)}
          className="!px-0 !py-0 !border-0 !shadow-none !bg-transparent text-xs"
        />
        {statusMessage && (
          <>
            <span>|</span>
            <span className="truncate text-blue-700">{statusMessage}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        <ZoomIndicator className="!px-0 !py-0 !border-0 !shadow-none !bg-transparent text-xs" />
      </div>
    </div>
  );
}

// =============================================================================
// Main Editor Component
// =============================================================================

export function SmartDrawingEditor({
  projectId,
  initialData,
  onDataChange,
  onSave,
  readOnly = false,
  className = '',
  vrfRuleProfile,
}: SmartDrawingEditorProps) {
  const PAGE_LAYOUTS: PageLayout[] = [
    { id: 'a4-portrait', label: 'A4 Portrait (210 x 297 mm)', width: mmToPx(210), height: mmToPx(297), orientation: 'portrait' },
    { id: 'a4-landscape', label: 'A4 Landscape (297 x 210 mm)', width: mmToPx(297), height: mmToPx(210), orientation: 'landscape' },
    { id: 'a3-portrait', label: 'A3 Portrait (297 x 420 mm)', width: mmToPx(297), height: mmToPx(420), orientation: 'portrait' },
    { id: 'a3-landscape', label: 'A3 Landscape (420 x 297 mm)', width: mmToPx(420), height: mmToPx(297), orientation: 'landscape' },
    { id: 'a2-portrait', label: 'A2 Portrait (420 x 594 mm)', width: mmToPx(420), height: mmToPx(594), orientation: 'portrait' },
    { id: 'a2-landscape', label: 'A2 Landscape (594 x 420 mm)', width: mmToPx(594), height: mmToPx(420), orientation: 'landscape' },
  ];
  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [fabricCanvas, setFabricCanvas] = useState<fabric.Canvas | null>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const minLeftWidth = 84;
  const [maxLeftWidth, setMaxLeftWidth] = useState(320);
  const [leftPanelWidth, setLeftPanelWidth] = useState(248);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [leftPanelMode, setLeftPanelMode] = useState<'building' | 'ac-equipment'>('building');
  const [leftPanelTab, setLeftPanelTab] = useState<'symbols' | 'objects'>('symbols');
  const [layoutReady, setLayoutReady] = useState(false);
  const [pendingPlacementObjectId, setPendingPlacementObjectId] = useState<string | null>(null);
  const [pendingPlacementEquipmentId, setPendingPlacementEquipmentId] = useState<string | null>(null);
  const [customLibraryObjects, setCustomLibraryObjects] = useState<ArchitecturalObjectDefinition[]>([]);
  const [recentObjectUsage, setRecentObjectUsage] = useState<Record<string, number>>({});
  const compactThreshold = Math.max(minLeftWidth + 28, Math.min(168, maxLeftWidth - 32));
  const isLeftCompact = leftPanelWidth <= compactThreshold;
  const {
    sketches,
    annotations,
    dimensions,
    symbols,
    walls,
    rooms,
    activeTool,
    canUndo,
    canRedo,
    showGrid,
    showRulers,
    snapToGrid,
    pageConfig,
    displayUnit,
    boardSettings,
    hvacElements,
  } = useSmartDrawingStore((state) => ({
    sketches: state.sketches,
    annotations: state.annotations,
    dimensions: state.dimensions,
    dimensionSettings: state.dimensionSettings,
    symbols: state.symbols,
    walls: state.walls,
    rooms: state.rooms,
    activeTool: state.activeTool,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    showGrid: state.showGrid,
    showRulers: state.showRulers,
    snapToGrid: state.snapToGrid,
    pageConfig: state.pageConfig,
    displayUnit: state.displayUnit,
    boardSettings: state.boardSettings,
    hvacElements: state.hvacElements,
  }), shallow);
  const {
    loadData,
    exportData,
    setTool,
    undo,
    redo,
    resetView,
    setShowGrid,
    setShowRulers,
    setSnapToGrid,
    setPageConfig,
    setBoardSettings,
    setDisplayUnit,
    setZoom,
    setPanOffset,
  } = useSmartDrawingStore((state) => ({
    loadData: state.loadData,
    exportData: state.exportData,
    setTool: state.setTool,
    undo: state.undo,
    redo: state.redo,
    resetView: state.resetView,
    setShowGrid: state.setShowGrid,
    setShowRulers: state.setShowRulers,
    setSnapToGrid: state.setSnapToGrid,
    setPageConfig: state.setPageConfig,
    setBoardSettings: state.setBoardSettings,
    setDisplayUnit: state.setDisplayUnit,
    setZoom: state.setZoom,
    setPanOffset: state.setPanOffset,
  }), shallow);
  const {
    zoom,
    panOffset,
    setViewTransform: setInteractionViewTransform,
  } = useDrawingInteractionStore((state) => ({
    zoom: state.zoom,
    panOffset: state.panOffset,
    setViewTransform: state.setViewTransform,
  }), shallow);

  const quickActions: { id: DrawingTool; label: string; icon: React.ReactNode }[] = [
    { id: 'wall', label: 'Add Wall', icon: <Minus size={14} /> },
    { id: 'partition-wall', label: 'Partition Wall', icon: <Minus size={14} /> },
    { id: 'room', label: 'Add Room', icon: <BoxSelect size={14} /> },
    { id: 'dimension', label: 'Dimension', icon: <Ruler size={14} /> },
    { id: 'text', label: 'Text', icon: <Type size={14} /> },
  ];
  // All board/sheet context (scale, units, grid, rulers) is store state so it
  // persists with the document and every consumer derives from one source.
  const boardCanvasProps = useMemo(
    () => boardSettingsToCanvasProps(boardSettings, displayUnit),
    [boardSettings, displayUnit],
  );
  const currentScaleRatio = `${boardSettings.scaleDrawing}:${boardSettings.scaleReal}`;
  const currentScalePreset = SCALE_PRESETS.includes(currentScaleRatio as (typeof SCALE_PRESETS)[number])
    ? currentScaleRatio
    : '1:50';
  const applyScaleRatio = useCallback((ratio: string) => {
    const parsed = parseScaleRatio(ratio);
    if (!parsed) return;
    setBoardSettings({ scaleDrawing: parsed.drawing, scaleReal: parsed.real });
  }, [setBoardSettings]);
  const architecturalObjects = useMemo(
    () => [...DEFAULT_ARCHITECTURAL_OBJECT_LIBRARY, ...customLibraryObjects],
    [customLibraryObjects]
  );
  // Calculate total element count
  const elementCount = sketches.length + annotations.length + dimensions.length + symbols.length + walls.length + rooms.length + hvacElements.length;
  const placedEquipmentCountByType = useMemo(() => {
    return hvacElements.reduce<Record<string, number>>((acc, element) => {
      acc[element.type] = (acc[element.type] ?? 0) + 1;
      return acc;
    }, {});
  }, [hvacElements]);
  const roomEquipmentCounts = useMemo(() => {
    return rooms
      .map((room) => ({
        roomId: room.id,
        roomName: room.name,
        count: hvacElements.filter((element) => element.roomId === room.id).length,
      }))
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count || left.roomName.localeCompare(right.roomName));
  }, [hvacElements, rooms]);

  const areaSummary = useMemo(() => {
    return { totalFloorArea: 0, usableArea: 0, circulationArea: 0 };
  }, []);

  // Load initial data
  useEffect(() => {
    if (initialData) {
      loadData(initialData as Parameters<typeof loadData>[0]);
    }
  }, [initialData, loadData]);

  // Notify parent of data changes
  useEffect(() => {
    if (!onDataChange) return;
    if (typeof window === 'undefined') {
      onDataChange(exportData());
      return;
    }

    const timeoutId = window.setTimeout(() => {
      onDataChange(exportData());
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [sketches, dimensions, symbols, walls, rooms, hvacElements, exportData, onDataChange]);

  useEffect(() => {
    if (!onSave || saveState === 'saving' || saveState === 'idle') return;
    setSaveState('idle');
  }, [sketches, dimensions, walls, rooms, hvacElements, onSave, saveState]);

  useEffect(() => {
    if (activeTool !== 'select' && pendingPlacementObjectId) {
      setPendingPlacementObjectId(null);
    }
    if (activeTool !== 'select' && pendingPlacementEquipmentId) {
      setPendingPlacementEquipmentId(null);
    }
  }, [activeTool, pendingPlacementEquipmentId, pendingPlacementObjectId]);

  useEffect(() => {
    if (leftPanelMode === 'ac-equipment' && leftPanelWidth < 220) {
      setLeftPanelWidth(Math.min(Math.max(248, minLeftWidth), maxLeftWidth));
    }
  }, [leftPanelMode, leftPanelWidth, maxLeftWidth, minLeftWidth]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const rawCustom = window.localStorage.getItem('drawing-library-custom');
      if (rawCustom) {
        const parsed = JSON.parse(rawCustom);
        if (Array.isArray(parsed)) {
          setCustomLibraryObjects(
            parsed.filter((entry): entry is ArchitecturalObjectDefinition => Boolean(entry) && typeof entry === 'object')
          );
        }
      }
      const rawRecent = window.localStorage.getItem('drawing-library-recent');
      if (rawRecent) {
        const parsedRecent = JSON.parse(rawRecent);
        if (parsedRecent && typeof parsedRecent === 'object') {
          setRecentObjectUsage(parsedRecent as Record<string, number>);
        }
      }
    } catch {
      // Ignore malformed persisted values.
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('drawing-library-custom', JSON.stringify(customLibraryObjects));
  }, [customLibraryObjects]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('drawing-library-recent', JSON.stringify(recentObjectUsage));
  }, [recentObjectUsage]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const viewport = window.innerWidth;
    const fallbackLeftOpen = viewport >= 1080;
    const fallbackRightOpen = viewport >= 1320;

    try {
      const raw = window.localStorage.getItem('smart-drawing-layout-v1');
      if (!raw) {
        setShowLeftPanel(fallbackLeftOpen);
        setShowRightPanel(fallbackRightOpen);
        setLayoutReady(true);
        return;
      }
      const parsed = JSON.parse(raw) as {
        showLeftPanel?: boolean;
        showRightPanel?: boolean;
        leftPanelWidth?: number;
        leftPanelMode?: 'building' | 'ac-equipment';
        leftPanelTab?: 'symbols' | 'objects';
      };

      setShowLeftPanel(typeof parsed.showLeftPanel === 'boolean' ? parsed.showLeftPanel : fallbackLeftOpen);
      setShowRightPanel(typeof parsed.showRightPanel === 'boolean' ? parsed.showRightPanel : fallbackRightOpen);
      if (typeof parsed.leftPanelWidth === 'number' && Number.isFinite(parsed.leftPanelWidth)) {
        setLeftPanelWidth(parsed.leftPanelWidth);
      }
      if (parsed.leftPanelMode === 'building' || parsed.leftPanelMode === 'ac-equipment') {
        setLeftPanelMode(parsed.leftPanelMode);
      }
      if (parsed.leftPanelTab === 'symbols' || parsed.leftPanelTab === 'objects') {
        setLeftPanelTab(parsed.leftPanelTab);
      }
    } catch {
      setShowLeftPanel(fallbackLeftOpen);
      setShowRightPanel(fallbackRightOpen);
    } finally {
      setLayoutReady(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !layoutReady) return;
    window.localStorage.setItem(
      'smart-drawing-layout-v1',
      JSON.stringify({
        showLeftPanel,
        showRightPanel,
        leftPanelWidth,
        leftPanelMode,
        leftPanelTab,
      })
    );
  }, [layoutReady, showLeftPanel, showRightPanel, leftPanelWidth, leftPanelMode, leftPanelTab]);

  useEffect(() => {
    const handleOpenRoomProperties = () => {
      setShowRightPanel(true);
    };
    const handleOpenPropertiesPanel = () => {
      setShowRightPanel(true);
    };

    window.addEventListener(
      'smart-drawing:open-room-properties',
      handleOpenRoomProperties as EventListener
    );
    window.addEventListener(
      'smart-drawing:open-properties-panel',
      handleOpenPropertiesPanel as EventListener
    );
    return () => {
      window.removeEventListener(
        'smart-drawing:open-room-properties',
        handleOpenRoomProperties as EventListener
      );
      window.removeEventListener(
        'smart-drawing:open-properties-panel',
        handleOpenPropertiesPanel as EventListener
      );
    };
  }, []);

  useEffect(() => {
    const updateBounds = () => {
      const viewport = typeof window !== 'undefined' ? window.innerWidth : 1280;
      const nextMax = Math.max(minLeftWidth, Math.min(360, Math.floor(viewport * 0.28)));
      setMaxLeftWidth(nextMax);
      setLeftPanelWidth((current) => Math.min(Math.max(current, minLeftWidth), nextMax));
    };

    updateBounds();
    window.addEventListener('resize', updateBounds);

    return () => {
      window.removeEventListener('resize', updateBounds);
    };
  }, [minLeftWidth]);

  useEffect(() => {
    if (!isResizingLeft || !showLeftPanel) return;

    const handleMove = (event: PointerEvent) => {
      const rect = leftPanelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = Math.min(Math.max(event.clientX - rect.left, minLeftWidth), maxLeftWidth);
      setLeftPanelWidth(next);
    };

    const handleUp = () => {
      setIsResizingLeft(false);
    };

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizingLeft, showLeftPanel, minLeftWidth, maxLeftWidth]);

  const handleSave = useCallback(async () => {
    if (!onSave || readOnly) return;
    try {
      setSaveState('saving');
      await onSave(exportData());
      setLastSavedAt(
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      );
      setSaveState('saved');
    } catch (err) {
      console.error('Failed to save drawing:', err);
      setSaveState('error');
    }
  }, [onSave, exportData, readOnly]);

  // Handle canvas ready
  const handleCanvasReady = useCallback((canvas: fabric.Canvas) => {
    setFabricCanvas(canvas);
  }, []);

  // Handle symbol selection from palette
  const handleSymbolSelect = useCallback(
    (symbol: SymbolDefinition) => {
      if (!fabricCanvas || readOnly) return;

      // Add symbol to canvas at center
      const center = fabricCanvas.getCenterPoint();
      const path = new fabric.Path(symbol.svgPath, {
        left: center.x,
        top: center.y,
        fill: 'transparent',
        stroke: '#333',
        strokeWidth: 1,
        scaleX: symbol.defaultWidth * 50,
        scaleY: symbol.defaultHeight * 50,
        originX: 'center',
        originY: 'center',
      });

      fabricCanvas.add(path);
      fabricCanvas.setActiveObject(path);
      fabricCanvas.renderAll();
    },
    [fabricCanvas, readOnly]
  );

  const handleStartObjectPlacement = useCallback((definition: ArchitecturalObjectDefinition) => {
    if (readOnly) return;
    setLeftPanelMode('building');
    setPendingPlacementEquipmentId(null);
    setPendingPlacementObjectId(definition.id);
    setTool('select');
  }, [readOnly, setTool]);

  const handleCancelObjectPlacement = useCallback(() => {
    setPendingPlacementObjectId(null);
  }, []);

  const handleShowBuildingPanel = useCallback(() => {
    setLeftPanelMode('building');
    setPendingPlacementEquipmentId(null);
  }, []);

  const handleShowEquipmentPanel = useCallback(() => {
    setLeftPanelMode('ac-equipment');
    setPendingPlacementObjectId(null);
  }, []);

  const handleStartEquipmentPlacement = useCallback((definition: AcEquipmentDefinition) => {
    if (readOnly) return;
    setLeftPanelMode('ac-equipment');
    setPendingPlacementObjectId(null);
    setPendingPlacementEquipmentId(definition.id);
    setTool('select');
  }, [readOnly, setTool]);

  const handleCancelEquipmentPlacement = useCallback(() => {
    setPendingPlacementEquipmentId(null);
  }, []);

  const handleObjectPlaced = useCallback((definitionId: string) => {
    setRecentObjectUsage((prev) => ({
      ...prev,
      [definitionId]: Date.now(),
    }));
  }, []);

  const handleAddCustomObject = useCallback((definition: ArchitecturalObjectDefinition) => {
    setCustomLibraryObjects((prev) => {
      if (prev.some((entry) => entry.id === definition.id)) {
        return prev.map((entry) => (entry.id === definition.id ? definition : entry));
      }
      return [...prev, definition];
    });
  }, []);

  const handleImportCustomObjects = useCallback((definitions: ArchitecturalObjectDefinition[]) => {
    setCustomLibraryObjects((prev) => {
      const merged = new Map(prev.map((entry) => [entry.id, entry]));
      definitions.forEach((definition) => {
        const normalized = {
          ...definition,
          category: 'my-library' as const,
        };
        merged.set(normalized.id, normalized);
      });
      return Array.from(merged.values());
    });
  }, []);

  // Export handlers
  const handleExportJSON = useCallback(() => {
    const data = exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `drawing-${projectId || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportData, projectId]);

  const handleExportSVG = useCallback(() => {
    if (!fabricCanvas) return;

    const svg = fabricCanvas.toSVG();
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `drawing-${projectId || 'export'}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [fabricCanvas, projectId]);

  const handleExportPNG = useCallback(() => {
    if (!fabricCanvas) return;

    const dataURL = fabricCanvas.toDataURL({
      format: 'png',
      quality: 1,
      multiplier: 2,
    });
    const a = document.createElement('a');
    a.href = dataURL;
    a.download = `drawing-${projectId || 'export'}.png`;
    a.click();
  }, [fabricCanvas, projectId]);

  // Import handler
  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const text = await file.text();
      try {
        const data = JSON.parse(text);
        loadData(data);
      } catch (err) {
        console.error('Failed to parse imported file:', err);
        alert('Failed to import file. Please ensure it is a valid JSON file.');
      }
    };
    input.click();
  }, [loadData]);

  return (
    <div className={`flex h-full flex-col overflow-hidden bg-[#f6f1e7] ${className}`}>
      <EditorRibbon
        projectId={projectId}
        onExportJSON={handleExportJSON}
        onExportSVG={handleExportSVG}
        onExportPNG={handleExportPNG}
        onImport={handleImport}
        onSave={onSave ? handleSave : undefined}
        zoomLevel={zoom}
        canUndo={canUndo}
        canRedo={canRedo}
        onZoomIn={() => {
          const nextZoom = Math.min(zoom * 1.2, 5);
          setInteractionViewTransform(nextZoom, panOffset);
          setZoom(nextZoom);
        }}
        onZoomOut={() => {
          const nextZoom = Math.max(zoom / 1.2, 0.1);
          setInteractionViewTransform(nextZoom, panOffset);
          setZoom(nextZoom);
        }}
        onResetView={() => {
          setInteractionViewTransform(1, { x: 0, y: 0 });
          resetView();
        }}
        onUndo={undo}
        onRedo={redo}
        saveState={saveState}
        lastSavedAt={lastSavedAt}
        showGrid={showGrid}
        showRulers={showRulers}
        snapToGrid={snapToGrid}
        onToggleGrid={() => setShowGrid(!showGrid)}
        onToggleRulers={() => setShowRulers(!showRulers)}
        onToggleSnap={() => setSnapToGrid(!snapToGrid)}
        pageConfig={pageConfig}
        pageLayouts={PAGE_LAYOUTS}
        onPageChange={(layoutId) => {
          const layout = PAGE_LAYOUTS.find((item) => item.id === layoutId);
          if (!layout) return;
          setPageConfig({
            width: layout.width,
            height: layout.height,
            orientation: layout.orientation,
          });
          setInteractionViewTransform(1, { x: 0, y: 0 });
          setZoom(1);
          setPanOffset({ x: 0, y: 0 });
        }}
        scalePreset={currentScalePreset}
        onScaleChange={applyScaleRatio}
        boardSettings={boardSettings}
        displayUnit={displayUnit}
        onBoardSettingsChange={setBoardSettings}
        onDisplayUnitChange={setDisplayUnit}
        readOnly={readOnly}
      />

      <div className="flex flex-1 overflow-hidden">
        {showLeftPanel && (
          <aside
            ref={leftPanelRef}
            className={`relative shrink-0 bg-[#fbf7ee] border-r border-amber-200/70 ${
              isResizingLeft ? 'transition-none' : 'transition-[width] duration-200'
            }`}
            style={{ width: leftPanelWidth }}
          >
            {isLeftCompact ? (
              <div className="flex h-full flex-col items-center justify-between py-3">
                <div className="flex flex-col items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-400 text-[10px] font-bold text-amber-950">
                    PX
                  </div>
                  <div className="flex flex-col items-center gap-2 text-slate-600">
                    <button
                      type="button"
                      onClick={handleShowBuildingPanel}
                      className={`flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200/80 bg-white/80 ${leftPanelMode === 'building' ? 'text-amber-700' : ''}`}
                      title="Building tools"
                    >
                      <Layers size={18} />
                    </button>
                    <button
                      type="button"
                      onClick={handleShowEquipmentPanel}
                      className={`flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200/80 bg-white/80 ${leftPanelMode === 'ac-equipment' ? 'text-amber-700' : ''}`}
                      title="AC equipment tools"
                    >
                      <Fan size={18} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowGrid(!showGrid)}
                      className={`flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200/80 bg-white/80 ${showGrid ? 'text-amber-700' : ''}`}
                      title="Toggle grid"
                    >
                      <Grid3X3 size={18} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowRulers(!showRulers)}
                      className={`flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200/80 bg-white/80 ${showRulers ? 'text-amber-700' : ''}`}
                      title="Toggle rulers"
                    >
                      <Ruler size={18} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setLeftPanelTab((prev) => (prev === 'symbols' ? 'objects' : 'symbols'))}
                      className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200/80 bg-white/80"
                      title={leftPanelMode === 'building' ? 'Toggle library tab' : 'Building libraries'}
                      disabled={leftPanelMode !== 'building'}
                    >
                      <BoxSelect size={18} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowRightPanel(true)}
                      className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-200/80 bg-white/80"
                      title="Open properties"
                    >
                      <Settings size={18} />
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowLeftPanel(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-amber-200/80 bg-white/80 text-slate-600 hover:bg-amber-50"
                  title="Hide toolbox"
                >
                  <PanelLeftClose size={16} />
                </button>
              </div>
            ) : (
              <div className="flex h-full flex-col overflow-hidden">
                <div className="shrink-0 border-b border-amber-200/70 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-slate-500">Toolbox</p>
                      <h2 className="text-xs font-semibold text-slate-800">
                        {leftPanelMode === 'ac-equipment' ? 'AC Planning Tools' : 'Drawing Tools'}
                      </h2>
                    </div>
                    <div className="text-[11px] text-slate-500">{elementCount} elements</div>
                  </div>
                  <div className="mt-2 inline-flex rounded-md border border-amber-200/80 bg-white p-0.5">
                    <button
                      type="button"
                      onClick={handleShowBuildingPanel}
                      className={`rounded px-2 py-1 text-[11px] ${
                        leftPanelMode === 'building'
                          ? 'bg-amber-200 text-amber-900'
                          : 'text-slate-600 hover:bg-amber-50'
                      }`}
                    >
                      Building
                    </button>
                    <button
                      type="button"
                      onClick={handleShowEquipmentPanel}
                      className={`rounded px-2 py-1 text-[11px] ${
                        leftPanelMode === 'ac-equipment'
                          ? 'bg-amber-200 text-amber-900'
                          : 'text-slate-600 hover:bg-amber-50'
                      }`}
                    >
                      AC Equipment
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin scrollbar-thumb-amber-300">
                  {leftPanelMode === 'building' ? (
                    <div className="space-y-2.5 p-2.5">
                      <div className="rounded-xl border border-amber-200/80 bg-white/80 p-2.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Core Tools</p>
                        <div className="mt-2">
                          <Toolbar
                            orientation="vertical"
                            layout="grid"
                            variant="toolbox"
                            showLabels
                            showZoomControls={false}
                            showUndoRedo={false}
                            showLayerControls={false}
                          />
                        </div>
                      </div>

                      <div className="rounded-xl border border-amber-200/80 bg-white/80 p-2.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Quick Actions</p>
                        <div className="mt-2 grid grid-cols-2 gap-1.5">
                          {quickActions.map((action) => (
                            <QuickActionButton
                              key={action.id}
                              icon={action.icon}
                              label={action.label}
                              active={activeTool === action.id}
                              onClick={() => {
                                setTool(action.id);
                                if (action.id === 'room' && typeof window !== 'undefined') {
                                  window.dispatchEvent(
                                    new CustomEvent('smart-drawing:room-tool-activate')
                                  );
                                }
                              }}
                              disabled={readOnly}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl border border-amber-200/80 bg-white/80 p-2.5">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Libraries</p>
                          <div className="inline-flex rounded-md border border-amber-200/80 bg-white p-0.5">
                            <button
                              type="button"
                              onClick={() => setLeftPanelTab('symbols')}
                              className={`rounded px-2 py-1 text-[11px] ${
                                leftPanelTab === 'symbols'
                                  ? 'bg-amber-200 text-amber-900'
                                  : 'text-slate-600 hover:bg-amber-50'
                              }`}
                            >
                              Symbols
                            </button>
                            <button
                              type="button"
                              onClick={() => setLeftPanelTab('objects')}
                              className={`rounded px-2 py-1 text-[11px] ${
                                leftPanelTab === 'objects'
                                  ? 'bg-amber-200 text-amber-900'
                                  : 'text-slate-600 hover:bg-amber-50'
                              }`}
                            >
                              Objects
                            </button>
                          </div>
                        </div>
                        <div className="h-[420px] overflow-hidden rounded-lg border border-amber-200/80 bg-white">
                          {leftPanelTab === 'symbols' ? (
                            <SymbolPalette
                              variant="embedded"
                              onSymbolSelect={handleSymbolSelect}
                              className="h-full"
                            />
                          ) : (
                            <ObjectLibraryPanel
                              className="h-full"
                              objects={architecturalObjects}
                              recentUsage={recentObjectUsage}
                              pendingObjectId={pendingPlacementObjectId}
                              onStartPlacement={handleStartObjectPlacement}
                              onCancelPlacement={handleCancelObjectPlacement}
                              onAddCustomObject={handleAddCustomObject}
                              onImportCustomObjects={handleImportCustomObjects}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <AcEquipmentPanel
                      className="h-full"
                      equipment={DEFAULT_AC_EQUIPMENT_LIBRARY}
                      pendingEquipmentId={pendingPlacementEquipmentId}
                      placedCountByType={placedEquipmentCountByType}
                      roomEquipmentCounts={roomEquipmentCounts}
                      onStartPlacement={handleStartEquipmentPlacement}
                      onCancelPlacement={handleCancelEquipmentPlacement}
                    />
                  )}
                </div>

                <div className="shrink-0 border-t border-amber-200/70 p-2.5">
                  <button
                    type="button"
                    onClick={() => setShowLeftPanel(false)}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-200/80 bg-white/80 py-1.5 text-xs font-medium text-slate-600 hover:bg-amber-50"
                    title="Hide toolbox"
                  >
                    <PanelLeftClose size={16} />
                    Hide toolbox
                  </button>
                </div>
              </div>
            )}

            <div
              className="absolute right-0 top-0 h-full w-2 cursor-col-resize bg-amber-200/40 hover:bg-amber-200 z-20"
              onPointerDown={(event) => {
                event.preventDefault();
                setIsResizingLeft(true);
              }}
              title="Resize toolbox"
            />
          </aside>
        )}

        {!showLeftPanel && (
          <button
            onClick={() => setShowLeftPanel(true)}
            className="flex w-6 items-center justify-center border-r border-amber-200/70 bg-[#f2e3c3] transition-colors hover:bg-amber-200"
            title="Show toolbox"
          >
            <PanelLeftClose size={16} className="text-slate-700 rotate-180" />
          </button>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-10 items-center gap-2 border-b border-amber-200/70 bg-[#fef9ec] px-2">
            <div className="min-w-0 flex-1 self-stretch">
              <AttributeQuickToolbar className="h-full w-full !px-0" keepSpaceWhenHidden />
            </div>
          </div>

          <DrawingCanvas
            className="flex-1 bg-white"
            onCanvasReady={handleCanvasReady}
            showGrid={showGrid}
            showRulers={showRulers}
            snapToGrid={snapToGrid}
            paperUnit={boardCanvasProps.paperUnit}
            realWorldUnit={displayUnit}
            scaleDrawing={boardCanvasProps.scaleDrawing}
            scaleReal={boardCanvasProps.scaleReal}
            rulerMode={boardCanvasProps.rulerMode}
            majorTickInterval={boardCanvasProps.majorTickInterval}
            tickSubdivisions={boardCanvasProps.tickSubdivisions}
            showRulerLabels={boardCanvasProps.showRulerLabels}
            gridMode={boardCanvasProps.gridMode}
            majorGridSize={boardCanvasProps.majorGridSize}
            gridSubdivisions={boardCanvasProps.gridSubdivisions}
            objectDefinitions={architecturalObjects}
            equipmentDefinitions={DEFAULT_AC_EQUIPMENT_LIBRARY}
            pendingPlacementObjectId={pendingPlacementObjectId}
            pendingPlacementEquipmentId={pendingPlacementEquipmentId}
            onObjectPlaced={handleObjectPlaced}
            onCancelObjectPlacement={handleCancelObjectPlacement}
            onCancelEquipmentPlacement={handleCancelEquipmentPlacement}
            vrfRuleProfile={vrfRuleProfile}
          />

        </div>

        <button
          onClick={() => setShowRightPanel(!showRightPanel)}
          className="flex w-6 items-center justify-center border-l border-amber-200/70 bg-[#f2e3c3] transition-colors hover:bg-amber-200"
          title={showRightPanel ? 'Hide properties' : 'Show properties'}
        >
          <PanelRightClose
            size={16}
            className={`text-slate-700 transition-transform ${showRightPanel ? '' : 'rotate-180'}`}
          />
        </button>

        {showRightPanel && (
          <aside className="flex w-72 flex-col overflow-hidden border-l border-amber-200/70 bg-[#fbf7ee]">
            <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin scrollbar-thumb-amber-300">
              <PropertiesPanel className="!w-full !border-l-0" />
            </div>
          </aside>
        )}
      </div>

      <EditorFooter
        elementCount={elementCount}
        areaSummary={areaSummary}
      />
    </div>
  );
}

export default SmartDrawingEditor;
