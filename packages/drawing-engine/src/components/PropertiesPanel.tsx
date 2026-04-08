/**
 * Properties panel for wall + room 3D attributes and drawing defaults.
 */

'use client';

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { shallow } from 'zustand/shallow';

import {
  DEFAULT_HVAC_DESIGN_CONDITIONS,
  DEFAULT_ARCHITECTURAL_MATERIALS,
  DEFAULT_ROOM_HVAC_TEMPLATES,
  calculateMaterialResistance,
  getArchitecturalMaterial,
  resolveWallMaterialFromLibrary,
} from '../attributes';
import { useSmartDrawingStore } from '../store';
import type {
  CompassDirection,
  DimensionDisplayFormat,
  DimensionPlacementType,
  DisplayUnit,
  PartitionWallMode,
  RoomType,
  RoomOccupancySchedule,
  Wall,
  WallMaterial,
} from '../types';
import {
  MAX_U_VALUE,
  MAX_WALL_HEIGHT,
  MAX_WALL_THICKNESS,
  MIN_U_VALUE,
  MIN_WALL_HEIGHT,
  MIN_WALL_THICKNESS,
} from '../types/wall';

import {
  circularMeetingFootprintMm,
  squareMeetingFootprintMm,
} from './canvas/object/three3d/geometry/meeting-tables';
import { fromMillimeters, toMillimeters } from './canvas/scale';

type PropertyUnit = 'mm' | 'in' | 'ft';
const COMPASS_DIRECTIONS: CompassDirection[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const OPENING_EDGE_MARGIN_MM = 50;
const MIN_DOOR_WIDTH_MM = 500;
const MAX_DOOR_WIDTH_MM = 4000;
const MIN_WINDOW_WIDTH_MM = 400;
const MAX_WINDOW_WIDTH_MM = 4000;
const MIN_DOOR_HEIGHT_MM = 1800;
const MIN_WINDOW_HEIGHT_MM = 300;

export interface PropertiesPanelProps {
  className?: string;
  onClose?: () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fromMm(mm: number, unit: PropertyUnit): number {
  return fromMillimeters(mm, unit);
}

function toMm(value: number, unit: PropertyUnit): number {
  return toMillimeters(value, unit);
}

function formatUnit(unit: PropertyUnit): string {
  switch (unit) {
    case 'ft':
      return 'ft';
    case 'in':
      return 'in';
    case 'mm':
    default:
      return 'mm';
  }
}

function propertyAsString(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function propertyAsNumber(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-2 border-b border-amber-100/70 last:border-0">
      <span className="text-sm text-slate-600">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function computeOpeningWidthLimits(
  wall: Wall,
  openingId: string,
  openingPositionMm: number,
  minWidthMm: number,
  maxWidthMm: number
): { min: number; max: number } {
  const wallLength = Math.hypot(
    wall.endPoint.x - wall.startPoint.x,
    wall.endPoint.y - wall.startPoint.y
  );
  const distanceToNearestEnd = Math.min(
    openingPositionMm - OPENING_EDGE_MARGIN_MM,
    wallLength - openingPositionMm - OPENING_EDGE_MARGIN_MM
  );
  let maxWidth = Math.max(0, distanceToNearestEnd * 2);

  for (const existing of wall.openings) {
    if (existing.id === openingId) continue;
    const centerDistance = Math.abs(existing.position - openingPositionMm);
    const neighborLimit =
      2 * (centerDistance - OPENING_EDGE_MARGIN_MM - existing.width / 2);
    maxWidth = Math.min(maxWidth, neighborLimit);
  }

  const normalizedMax = Math.max(0, Math.floor(maxWidth / 10) * 10);
  return {
    min: minWidthMm,
    max: Math.min(maxWidthMm, normalizedMax),
  };
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-1 text-xs ${active
          ? 'border-amber-400 bg-amber-200 text-amber-900'
          : 'border-amber-200/80 bg-white text-slate-600 hover:bg-amber-50'
        }`}
    >
      {label}
    </button>
  );
}

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-amber-200/70 bg-white/80">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</span>
        {open ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function UnitSelector({
  propertyUnit,
  onPropertyUnitChange,
}: {
  propertyUnit: PropertyUnit;
  onPropertyUnitChange: (unit: PropertyUnit) => void;
}) {
  const { displayUnit, setDisplayUnit } = useSmartDrawingStore((state) => ({
    displayUnit: state.displayUnit,
    setDisplayUnit: state.setDisplayUnit,
  }), shallow);
  return (
    <div className="rounded-lg border border-amber-200/70 bg-white/80 p-3 space-y-2">
      <PropertyRow label="Display Unit">
        <select
          value={displayUnit}
          onChange={(e) => setDisplayUnit(e.target.value as DisplayUnit)}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value="mm">mm</option>
          <option value="cm">cm</option>
          <option value="m">m</option>
          <option value="ft-in">ft</option>
        </select>
      </PropertyRow>
      <PropertyRow label="Property Unit">
        <select
          value={propertyUnit}
          onChange={(e) => onPropertyUnitChange(e.target.value as PropertyUnit)}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value="mm">mm</option>
          <option value="in">in</option>
          <option value="ft">ft</option>
        </select>
      </PropertyRow>
    </div>
  );
}

function WallSection({ propertyUnit }: { propertyUnit: PropertyUnit }) {
  const {
    selectedElementIds,
    walls,
    materialLibrary,
    wallSettings,
    setWallSettings,
    updateWall,
    updateWall3DAttributes,
  } = useSmartDrawingStore((state) => ({
    selectedElementIds: state.selectedElementIds,
    walls: state.walls,
    materialLibrary: state.materialLibrary,
    wallSettings: state.wallSettings,
    setWallSettings: state.setWallSettings,
    updateWall: state.updateWall,
    updateWall3DAttributes: state.updateWall3DAttributes,
  }), shallow);
  const [tab, setTab] = useState<'general' | 'thermal' | 'openings'>('general');
  const [dragLayerIndex, setDragLayerIndex] = useState<number | null>(null);
  const [dragMaterialId, setDragMaterialId] = useState<string | null>(null);

  const selectedWall = useMemo(() => {
    const selectedFromCanvas = walls.find((wall) => selectedElementIds.includes(wall.id));
    return selectedFromCanvas ?? walls[0] ?? null;
  }, [selectedElementIds, walls]);

  if (!selectedWall) {
    return <p className="text-sm text-slate-400">No wall available</p>;
  }

  const length = Math.hypot(
    selectedWall.endPoint.x - selectedWall.startPoint.x,
    selectedWall.endPoint.y - selectedWall.startPoint.y
  );
  const angle = (((Math.atan2(
    selectedWall.endPoint.y - selectedWall.startPoint.y,
    selectedWall.endPoint.x - selectedWall.startPoint.x
  ) * 180) / Math.PI) + 360) % 360;
  const selectedMaterial = getArchitecturalMaterial(selectedWall.properties3D.materialId);
  const thermalAssembly = selectedWall.properties3D.thermalAssembly ?? [];
  const thermalBreakdown = selectedWall.properties3D.thermalBreakdown ?? [];

  const updateThermalAssembly = (nextAssembly: typeof thermalAssembly) => {
    updateWall3DAttributes(selectedWall.id, {
      thermalAssembly: nextAssembly.map((layer, index) => ({
        ...layer,
        order: index,
      })),
    });
  };

  const addThermalLayer = () => {
    const fallback = materialLibrary[0];
    if (!fallback) return;
    updateThermalAssembly([
      ...thermalAssembly,
      {
        id: `layer-${Date.now()}`,
        materialId: fallback.id,
        thicknessMm: fallback.defaultThicknessMm,
        order: thermalAssembly.length,
      },
    ]);
  };

  const removeThermalLayer = (index: number) => {
    const next = thermalAssembly.filter((_, layerIndex) => layerIndex !== index);
    updateThermalAssembly(next);
  };

  const updateThermalLayer = (index: number, updates: Partial<(typeof thermalAssembly)[number]>) => {
    const next = thermalAssembly.map((layer, layerIndex) =>
      layerIndex === index
        ? { ...layer, ...updates }
        : layer
    );
    updateThermalAssembly(next);
  };

  const reorderThermalLayer = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    const next = [...thermalAssembly];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    updateThermalAssembly(next);
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1 pb-2 border-b border-amber-100/70">
        <TabButton active={tab === 'general'} label="General" onClick={() => setTab('general')} />
        <TabButton active={tab === 'thermal'} label="Thermal" onClick={() => setTab('thermal')} />
        <TabButton active={tab === 'openings'} label="Openings" onClick={() => setTab('openings')} />
      </div>

      {tab === 'general' && (
        <div className="space-y-1">
          <PropertyRow label="ID">
            <span className="text-xs text-slate-500">{selectedWall.id.slice(0, 10)}</span>
          </PropertyRow>
          <PropertyRow label="Length">
            <span className="text-sm text-slate-700">{fromMm(length, propertyUnit).toFixed(2)} {formatUnit(propertyUnit)}</span>
          </PropertyRow>
          <PropertyRow label="Angle">
            <span className="text-sm text-slate-700">{angle.toFixed(1)}&deg;</span>
          </PropertyRow>
          <PropertyRow label="Thickness">
            <input
              type="number"
              min={fromMm(MIN_WALL_THICKNESS, propertyUnit)}
              max={fromMm(MAX_WALL_THICKNESS, propertyUnit)}
              step={propertyUnit === 'mm' ? 1 : 0.01}
              value={fromMm(selectedWall.thickness, propertyUnit).toFixed(2)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                const nextThicknessMm = clamp(toMm(parsed, propertyUnit), MIN_WALL_THICKNESS, MAX_WALL_THICKNESS);
                updateWall(selectedWall.id, { thickness: nextThicknessMm });
              }}
              className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Height">
            <input
              type="number"
              min={fromMm(MIN_WALL_HEIGHT, propertyUnit)}
              max={fromMm(MAX_WALL_HEIGHT, propertyUnit)}
              step={propertyUnit === 'mm' ? 1 : 0.01}
              value={fromMm(selectedWall.properties3D.height, propertyUnit).toFixed(2)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                const nextHeightMm = clamp(toMm(parsed, propertyUnit), MIN_WALL_HEIGHT, MAX_WALL_HEIGHT);
                updateWall3DAttributes(selectedWall.id, { height: nextHeightMm });
              }}
              className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Layer Count">
            <input
              type="number"
              min={1}
              step={1}
              value={Math.max(1, Math.round(selectedWall.properties3D.layerCount))}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                if (!Number.isFinite(parsed)) return;
                updateWall3DAttributes(selectedWall.id, { layerCount: Math.max(1, parsed) });
              }}
              className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Connections">
            <span className="text-xs text-slate-500">{selectedWall.connectedWalls.length} linked</span>
          </PropertyRow>
          {selectedMaterial && (
            <PropertyRow label="Material Color">
              <span className="inline-flex items-center gap-1 text-xs text-slate-600">
                <span className="inline-block h-3 w-3 rounded-full border border-slate-300" style={{ backgroundColor: selectedMaterial.color }} />
                {selectedMaterial.color}
              </span>
            </PropertyRow>
          )}
        </div>
      )}

      {tab === 'thermal' && (
        <div className="space-y-2">
          <PropertyRow label="Base Material">
            <select
              value={selectedWall.properties3D.materialId}
              onChange={(e) => {
                const materialId = e.target.value;
                const material = getArchitecturalMaterial(materialId);
                updateWall3DAttributes(selectedWall.id, {
                  materialId,
                  thermalResistance: material?.thermalResistance ?? selectedWall.properties3D.thermalResistance,
                });
                updateWall(selectedWall.id, {
                  material: resolveWallMaterialFromLibrary(materialId) as WallMaterial,
                });
              }}
              className="w-44 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            >
              {materialLibrary.map((material) => (
                <option key={material.id} value={material.id}>
                  {material.name} ({material.family}, R-{material.thermalResistance.toFixed(2)}, U-{material.uValue.toFixed(2)})
                </option>
              ))}
            </select>
          </PropertyRow>
          <PropertyRow label="Overall R-Value">
            <span className="text-sm text-slate-700">{selectedWall.properties3D.thermalResistance.toFixed(2)} m²K/W</span>
          </PropertyRow>
          <PropertyRow label="Overall U-Value">
            <span className={`text-sm ${selectedWall.properties3D.overallUValue < MIN_U_VALUE || selectedWall.properties3D.overallUValue > MAX_U_VALUE
                ? 'text-rose-600'
                : 'text-slate-700'
              }`}>
              {selectedWall.properties3D.overallUValue.toFixed(2)} W/(m².K)
            </span>
          </PropertyRow>
          <PropertyRow label="Exposure Angle">
            <span className="text-sm text-slate-700">{selectedWall.properties3D.exposureAngleFromNorth.toFixed(1)}&deg; from North</span>
          </PropertyRow>
          <PropertyRow label="Exposure">
            <span className="text-sm text-slate-700">{selectedWall.properties3D.exposureDirection}</span>
            <select
              value={selectedWall.properties3D.exposureOverride ?? 'auto'}
              onChange={(e) =>
                updateWall3DAttributes(selectedWall.id, {
                  exposureOverride: e.target.value === 'auto' ? null : (e.target.value as CompassDirection),
                })
              }
              className="w-24 px-2 py-1 text-xs border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            >
              <option value="auto">Auto</option>
              {COMPASS_DIRECTIONS.map((direction) => (
                <option key={direction} value={direction}>{direction}</option>
              ))}
            </select>
          </PropertyRow>
          <PropertyRow label="Shading">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={selectedWall.properties3D.shadingFactor.toFixed(2)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateWall3DAttributes(selectedWall.id, { shadingFactor: clamp(parsed, 0, 1) });
              }}
              className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Wall Heat Map">
            <select
              value={wallSettings.wallColorMode}
              onChange={(e) => {
                const nextMode = e.target.value as typeof wallSettings.wallColorMode;
                setWallSettings({
                  wallColorMode: nextMode,
                  colorCodeByMaterial: nextMode === 'material',
                });
              }}
              className="w-32 px-2 py-1 text-xs border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            >
              <option value="material">Material</option>
              <option value="u-value">U-Value</option>
              <option value="exposure">Exposure</option>
            </select>
          </PropertyRow>

          <div className="rounded border border-amber-200/80 bg-amber-50/30 p-2 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-600">Wall Assembly (Exterior to Interior)</span>
              <button
                type="button"
                onClick={addThermalLayer}
                className="rounded border border-amber-200/80 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-amber-50"
              >
                Add Layer
              </button>
            </div>
            <div className="text-[11px] text-slate-500">Drag rows to reorder layer sequence.</div>
            <div className="flex flex-wrap gap-1">
              {materialLibrary.map((material) => (
                <div
                  key={material.id}
                  draggable
                  onDragStart={() => {
                    setDragMaterialId(material.id);
                    setDragLayerIndex(null);
                  }}
                  onDragEnd={() => setDragMaterialId(null)}
                  className="inline-flex items-center gap-1 rounded border border-amber-200/80 bg-white px-2 py-1 text-[11px] text-slate-600 cursor-grab active:cursor-grabbing"
                  title={`Drag to assign ${material.name} to a layer`}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full border border-slate-300"
                    style={{ backgroundColor: material.color }}
                  />
                  {material.name}
                </div>
              ))}
            </div>
            {thermalAssembly.map((layer, index) => (
              <div
                key={layer.id}
                draggable
                onDragStart={() => setDragLayerIndex(index)}
                onDragEnd={() => {
                  setDragLayerIndex(null);
                  setDragMaterialId(null);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragMaterialId) {
                    updateThermalLayer(index, { materialId: dragMaterialId });
                    setDragMaterialId(null);
                    return;
                  }
                  if (dragLayerIndex === null) return;
                  reorderThermalLayer(dragLayerIndex, index);
                  setDragLayerIndex(null);
                }}
                className={`grid grid-cols-[1fr_auto_auto] gap-1 items-center rounded px-1 ${dragLayerIndex === index ? 'bg-amber-100/70' : ''
                  }`}
              >
                <select
                  value={layer.materialId}
                  onChange={(e) => updateThermalLayer(index, { materialId: e.target.value })}
                  className="px-2 py-1 text-xs border border-amber-200/80 rounded bg-white"
                >
                  {materialLibrary.map((material) => (
                    <option key={material.id} value={material.id}>{material.name}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={Math.round(layer.thicknessMm)}
                  onChange={(e) => {
                    const parsed = Number.parseFloat(e.target.value);
                    if (!Number.isFinite(parsed)) return;
                    updateThermalLayer(index, { thicknessMm: Math.max(1, parsed) });
                  }}
                  className="w-20 px-2 py-1 text-xs border border-amber-200/80 rounded bg-white"
                  title="Layer thickness (mm)"
                />
                <button
                  type="button"
                  onClick={() => removeThermalLayer(index)}
                  className="rounded border border-amber-200/80 bg-white px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-50"
                >
                  Remove
                </button>
              </div>
            ))}
            {thermalAssembly.length < 2 && (
              <div className="text-xs text-rose-600">Assembly must have at least 2 layers.</div>
            )}
            {thermalBreakdown.length > 0 && (
              <div className="space-y-1">
                {thermalBreakdown.map((item) => {
                  const layer = thermalAssembly.find((entry) => entry.id === item.layerId);
                  const material = getArchitecturalMaterial(item.materialId);
                  const computedResistance = layer
                    ? calculateMaterialResistance(layer.materialId, layer.thicknessMm)
                    : item.resistance;
                  return (
                    <div key={item.layerId} className="space-y-0.5">
                      <div className="flex items-center justify-between text-[11px] text-slate-600">
                        <span>{material?.name ?? item.materialId}</span>
                        <span>R {computedResistance.toFixed(2)}</span>
                      </div>
                      <div className="h-1.5 rounded bg-slate-200">
                        <div
                          className="h-1.5 rounded bg-amber-400"
                          style={{ width: `${Math.max(2, Math.min(100, item.percentage))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'openings' && (
        <div className="space-y-1">
          <PropertyRow label="Openings">
            <span className="text-sm text-slate-700">{selectedWall.openings.length}</span>
          </PropertyRow>
          {selectedWall.openings.length === 0 && (
            <p className="text-xs text-slate-500">No door/window openings on this wall.</p>
          )}
          {selectedWall.openings.map((opening) => (
            <div key={opening.id} className="rounded border border-amber-200/70 bg-white px-2 py-1 text-xs text-slate-600">
              {opening.type.toUpperCase()} | W {Math.round(opening.width)} mm | H {Math.round(opening.height)} mm | Pos {Math.round(opening.position)} mm
            </div>
          ))}
          <PropertyRow label="Volume">
            <span className="text-sm text-slate-700">{selectedWall.properties3D.computedVolumeM3.toFixed(3)} m&sup3;</span>
          </PropertyRow>
        </div>
      )}
    </div>
  );
}

function ObjectSection({ propertyUnit }: { propertyUnit: PropertyUnit }) {
  const {
    selectedElementIds,
    symbols,
    walls,
    updateSymbol,
    updateWall,
    setProcessingStatus,
  } = useSmartDrawingStore((state) => ({
    selectedElementIds: state.selectedElementIds,
    symbols: state.symbols,
    walls: state.walls,
    updateSymbol: state.updateSymbol,
    updateWall: state.updateWall,
    setProcessingStatus: state.setProcessingStatus,
  }), shallow);

  const selectedObject = useMemo(() => {
    const selectedFromCanvas = symbols.find((symbol) => selectedElementIds.includes(symbol.id));
    return selectedFromCanvas ?? symbols[0] ?? null;
  }, [selectedElementIds, symbols]);

  if (!selectedObject) {
    return <p className="text-sm text-slate-400">No library object selected</p>;
  }

  const category = propertyAsString(selectedObject.properties, 'category', 'object');
  const type = propertyAsString(selectedObject.properties, 'type', 'custom');
  const material = propertyAsString(selectedObject.properties, 'material', '');
  const widthMm = propertyAsNumber(selectedObject.properties, 'widthMm', 0);
  const depthMm = propertyAsNumber(selectedObject.properties, 'depthMm', 0);
  const heightMm = propertyAsNumber(selectedObject.properties, 'heightMm', 0);
  const sillHeightMm = propertyAsNumber(selectedObject.properties, 'sillHeightMm', 900);
  const swingDirection = propertyAsString(selectedObject.properties, 'swingDirection', 'left');
  const doorHingeMode = propertyAsString(selectedObject.properties, 'doorHingeMode', 'manual');
  const doorSwingBehavior = propertyAsString(selectedObject.properties, 'doorSwingBehavior', 'inward');
  const hostWallId = propertyAsString(selectedObject.properties, 'hostWallId', '');
  const positionAlongWallMm = propertyAsNumber(selectedObject.properties, 'positionAlongWallMm', NaN);
  const isDoor = category === 'doors';
  const isWindow = category === 'windows';
  const isOpening = isDoor || isWindow;
  const hostWall = hostWallId ? walls.find((wall) => wall.id === hostWallId) ?? null : null;
  const hostOpening = hostWall?.openings.find((opening) => opening.id === selectedObject.id) ?? null;
  const hostWallBaseElevationMm = hostWall?.properties3D.baseElevation ?? 0;
  const openingMinWidthMm = isDoor ? MIN_DOOR_WIDTH_MM : MIN_WINDOW_WIDTH_MM;
  const openingMaxWidthMm = isDoor ? MAX_DOOR_WIDTH_MM : MAX_WINDOW_WIDTH_MM;
  const openingMinHeightMm = isDoor ? MIN_DOOR_HEIGHT_MM : MIN_WINDOW_HEIGHT_MM;
  const openingWidthBaseMm = widthMm > 0
    ? widthMm
    : hostOpening
      ? Math.max(1, hostOpening.width - 50)
      : isDoor ? 900 : 1200;
  const openingHeightBaseMm = heightMm > 0
    ? heightMm
    : hostOpening
      ? Math.max(1, hostOpening.height)
      : isDoor ? 2100 : 1200;
  const windowSillBaseMm = hostOpening?.sillHeight ?? sillHeightMm;
  const openingWidthLimits = (() => {
    if (!isOpening || !hostWall) return null;
    const openingPosition = hostOpening?.position ?? positionAlongWallMm;
    if (!Number.isFinite(openingPosition)) return null;
    return computeOpeningWidthLimits(
      hostWall,
      selectedObject.id,
      openingPosition,
      openingMinWidthMm,
      openingMaxWidthMm
    );
  })();
  const canResizeOpening = !openingWidthLimits || openingWidthLimits.max >= openingWidthLimits.min;
  const effectiveOpeningWidthMm = Math.max(1, openingWidthBaseMm);
  const sliderMin = openingWidthLimits?.min ?? openingMinWidthMm;
  const sliderMax = Math.max(sliderMin, openingWidthLimits?.max ?? openingMaxWidthMm);
  const sliderValue = clamp(Math.round(effectiveOpeningWidthMm), sliderMin, sliderMax);
  const openingWidthPresets = isDoor
    ? (type === 'double-swing' ? [1200, 1400, 1600, 1800] : [700, 800, 900, 1000, 1100])
    : [600, 900, 1200, 1500, 1800];

  const updateProperty = (key: string, value: unknown) => {
    updateSymbol(selectedObject.id, {
      properties: {
        ...selectedObject.properties,
        [key]: value,
      },
    });
  };

  const updateDimensionProperty = (key: string, value: number) => {
    if (!Number.isFinite(value)) return;
    updateProperty(key, Math.max(1, value));
  };

  const updateHostedOpening = (updates: Partial<{ width: number; height: number; sillHeight: number }>) => {
    if (!hostWall || !hostOpening) return;
    const nextOpenings = hostWall.openings.map((opening) =>
      opening.id === selectedObject.id
        ? {
          ...opening,
          ...updates,
        }
        : opening
    );
    updateWall(hostWall.id, { openings: nextOpenings }, { source: 'ui', skipHistory: true });
  };

  const applyOpeningWidth = (requestedWidthMm: number) => {
    if (!Number.isFinite(requestedWidthMm)) return;

    let nextWidthMm = Math.max(openingMinWidthMm, Math.round(requestedWidthMm));
    if (openingWidthLimits) {
      if (openingWidthLimits.max < openingWidthLimits.min) {
        setProcessingStatus(
          `${isDoor ? 'Door' : 'Window'} cannot be resized at this position. Move it away from wall ends/openings first.`,
          false
        );
        return;
      }
      const clampedWidthMm = clamp(nextWidthMm, openingWidthLimits.min, openingWidthLimits.max);
      if (Math.abs(clampedWidthMm - nextWidthMm) > 0.01) {
        setProcessingStatus(
          `${isDoor ? 'Door' : 'Window'} width limited to ${Math.round(clampedWidthMm)} mm to keep valid clearances.`,
          false
        );
      }
      nextWidthMm = clampedWidthMm;
    }

    if (Math.abs(openingWidthBaseMm - nextWidthMm) > 0.01) {
      updateProperty('widthMm', nextWidthMm);
    }

    if (hostOpening) {
      const targetOpeningWidthMm = nextWidthMm + 50;
      if (Math.abs(hostOpening.width - targetOpeningWidthMm) > 0.01) {
        updateHostedOpening({ width: targetOpeningWidthMm });
      }
    }
  };

  const applyOpeningHeight = (requestedHeightMm: number) => {
    if (!Number.isFinite(requestedHeightMm)) return;
    const nextHeightMm = Math.max(openingMinHeightMm, Math.round(requestedHeightMm));
    if (Math.abs(openingHeightBaseMm - nextHeightMm) > 0.01) {
      updateProperty('heightMm', nextHeightMm);
    }
    if (hostOpening && Math.abs(hostOpening.height - nextHeightMm) > 0.01) {
      updateHostedOpening({ height: nextHeightMm });
    }
  };

  const applyWindowSillHeight = (requestedSillHeightMm: number) => {
    if (!isWindow || !Number.isFinite(requestedSillHeightMm)) return;
    const nextSillHeightMm = Math.max(0, Math.round(requestedSillHeightMm));
    updateSymbol(selectedObject.id, {
      properties: {
        ...selectedObject.properties,
        sillHeightMm: nextSillHeightMm,
        baseElevationMm: hostWallBaseElevationMm + nextSillHeightMm,
      },
    });
    if (hostOpening && Math.abs((hostOpening.sillHeight ?? 0) - nextSillHeightMm) > 0.01) {
      updateHostedOpening({ sillHeight: nextSillHeightMm });
    }
  };

  return (
    <div className="space-y-1">
      <PropertyRow label="ID">
        <span className="text-xs text-slate-500">{selectedObject.id.slice(0, 10)}</span>
      </PropertyRow>
      <PropertyRow label="Symbol">
        <span className="text-xs text-slate-600">{selectedObject.symbolId}</span>
      </PropertyRow>
      <PropertyRow label="Category">
        <span className="text-sm text-slate-700">{category}</span>
      </PropertyRow>
      <PropertyRow label="Type">
        <input
          type="text"
          value={type}
          onChange={(e) => updateProperty('type', e.target.value)}
          className="w-36 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Material">
        <input
          type="text"
          value={material}
          onChange={(e) => updateProperty('material', e.target.value)}
          className="w-36 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Width">
        <input
          type="number"
          min={fromMm(isOpening ? sliderMin : 1, propertyUnit)}
          max={isOpening ? fromMm(sliderMax, propertyUnit) : undefined}
          step={propertyUnit === 'mm' ? 1 : 0.01}
          value={fromMm(isOpening ? effectiveOpeningWidthMm : widthMm, propertyUnit).toFixed(2)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            const nextWidthMm = toMm(parsed, propertyUnit);
            if (isOpening) {
              applyOpeningWidth(nextWidthMm);
              return;
            }
            updateDimensionProperty('widthMm', nextWidthMm);
          }}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        />
      </PropertyRow>
      {isOpening && (
        <div className="rounded border border-amber-200/70 bg-amber-50/50 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              Smart {isDoor ? 'Door' : 'Window'} Width
            </span>
            <span className="text-xs text-slate-700">{Math.round(effectiveOpeningWidthMm)} mm</span>
          </div>
          <input
            type="range"
            min={sliderMin}
            max={sliderMax}
            step={10}
            value={sliderValue}
            disabled={!canResizeOpening}
            onChange={(e) => {
              const parsed = Number.parseFloat(e.target.value);
              if (!Number.isFinite(parsed)) return;
              applyOpeningWidth(parsed);
            }}
            className="w-full accent-amber-700 disabled:opacity-50"
          />
          <div className="flex flex-wrap gap-1">
            {openingWidthPresets.map((preset) => (
              <button
                key={preset}
                type="button"
                disabled={!canResizeOpening}
                onClick={() => applyOpeningWidth(preset)}
                className={`rounded border px-2 py-1 text-[11px] ${
                  Math.abs(openingWidthBaseMm - preset) < 0.5
                    ? 'border-amber-500 bg-amber-200 text-amber-900'
                    : 'border-amber-200 bg-white text-slate-700 hover:bg-amber-100'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {preset}
              </button>
            ))}
            {openingWidthLimits && (
              <button
                type="button"
                disabled={!canResizeOpening}
                onClick={() => applyOpeningWidth(openingWidthLimits.max)}
                className="rounded border border-amber-300 bg-white px-2 py-1 text-[11px] text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Fit Max
              </button>
            )}
          </div>
          <p className="text-[11px] text-slate-500">
            {openingWidthLimits
              ? canResizeOpening
                ? `Allowed width: ${openingWidthLimits.min}-${openingWidthLimits.max} mm (auto-clamped for edges/openings)`
                : `No valid ${isDoor ? 'door' : 'window'} width at this position. Move it before resizing.`
              : `${isDoor ? 'Door' : 'Window'} is not currently hosted on a wall. Width updates the symbol only.`}
          </p>
        </div>
      )}
      <PropertyRow label="Depth">
        <input
          type="number"
          min={fromMm(1, propertyUnit)}
          step={propertyUnit === 'mm' ? 1 : 0.01}
          value={fromMm(depthMm, propertyUnit).toFixed(2)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            updateDimensionProperty('depthMm', toMm(parsed, propertyUnit));
          }}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Height">
        <input
          type="number"
          min={fromMm(isOpening ? openingMinHeightMm : 1, propertyUnit)}
          step={propertyUnit === 'mm' ? 1 : 0.01}
          value={fromMm(isOpening ? openingHeightBaseMm : heightMm, propertyUnit).toFixed(2)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            const nextHeightMm = toMm(parsed, propertyUnit);
            if (isOpening) {
              applyOpeningHeight(nextHeightMm);
              return;
            }
            updateDimensionProperty('heightMm', nextHeightMm);
          }}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        />
      </PropertyRow>
      {(selectedObject.symbolId === 'furn-circular-table-chairs' || selectedObject.symbolId === 'furn-square-table-chairs') && (
        <div className="rounded border border-amber-200/70 bg-amber-50/50 p-2 space-y-2">
          <PropertyRow label="Chairs">
            <input
              type="number"
              min={2}
              max={20}
              step={1}
              value={propertyAsNumber(selectedObject.properties, 'chairCount', 4)}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                if (!Number.isFinite(parsed)) return;
                const nextCount = Math.max(2, Math.min(20, parsed));
                const footprint = selectedObject.symbolId === 'furn-circular-table-chairs'
                  ? circularMeetingFootprintMm(nextCount)
                  : squareMeetingFootprintMm(nextCount);
                updateSymbol(selectedObject.id, {
                  properties: {
                    ...selectedObject.properties,
                    chairCount: nextCount,
                    widthMm: footprint.widthMm,
                    depthMm: footprint.depthMm,
                  },
                });
              }}
              className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <div className="flex flex-wrap gap-1">
            {[4, 6, 8, 10, 12].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  const footprint = selectedObject.symbolId === 'furn-circular-table-chairs'
                    ? circularMeetingFootprintMm(preset)
                    : squareMeetingFootprintMm(preset);
                  updateSymbol(selectedObject.id, {
                    properties: {
                      ...selectedObject.properties,
                      chairCount: preset,
                      widthMm: footprint.widthMm,
                      depthMm: footprint.depthMm,
                    },
                  });
                }}
                className={`rounded border px-2 py-1 text-[11px] ${
                  propertyAsNumber(selectedObject.properties, 'chairCount', 4) === preset
                    ? 'border-amber-500 bg-amber-200 text-amber-900'
                    : 'border-amber-200 bg-white text-slate-700 hover:bg-amber-100'
                }`}
              >
                {preset} chairs
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            Table and footprint auto-resize to fit selected chair count.
          </p>
        </div>
      )}
      {isWindow && (
        <PropertyRow label="Sill">
          <input
            type="number"
            min={fromMm(0, propertyUnit)}
            step={propertyUnit === 'mm' ? 1 : 0.01}
            value={fromMm(windowSillBaseMm, propertyUnit).toFixed(2)}
            onChange={(e) => {
              const parsed = Number.parseFloat(e.target.value);
              if (!Number.isFinite(parsed)) return;
              applyWindowSillHeight(toMm(parsed, propertyUnit));
            }}
            className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
          />
        </PropertyRow>
      )}
      <PropertyRow label="Rotation">
        <input
          type="number"
          step={1}
          value={selectedObject.rotation.toFixed(1)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            updateSymbol(selectedObject.id, { rotation: parsed });
          }}
          className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        />
        <span className="text-xs text-slate-500">&deg;</span>
      </PropertyRow>
      {category === 'doors' && (
        <PropertyRow label="Opening">
          <button
            type="button"
            onClick={() => updateProperty('doorSwingBehavior', doorSwingBehavior === 'outward' ? 'inward' : 'outward')}
            className="rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
          >
            {doorSwingBehavior === 'outward' ? 'Outward' : 'Inward'}
          </button>
        </PropertyRow>
      )}
      {category === 'doors' && (
        <PropertyRow label="Hinge Mode">
          <button
            type="button"
            onClick={() => updateProperty('doorHingeMode', doorHingeMode === 'auto-corner' ? 'manual' : 'auto-corner')}
            className="rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
          >
            {doorHingeMode === 'auto-corner' ? 'Auto Corner' : 'Manual'}
          </button>
        </PropertyRow>
      )}
      {category === 'doors' && (
        <PropertyRow label="Swing">
          <button
            type="button"
            onClick={() => updateSymbol(selectedObject.id, {
              properties: {
                ...selectedObject.properties,
                doorHingeMode: 'manual',
                swingDirection: swingDirection === 'right' ? 'left' : 'right',
              },
            })}
            className="rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
          >
            {swingDirection === 'right' ? 'Right-Hand' : 'Left-Hand'}
          </button>
        </PropertyRow>
      )}
      {category === 'doors' && (
        <p className="text-[11px] text-slate-500">
          Inward opening plus Auto Corner hinge is the recommended setup. Auto Corner places the hinge near the nearest wall corner for typical room-entry layout; manual hand override is still available.
        </p>
      )}
    </div>
  );
}

function AcEquipmentSection({ propertyUnit }: { propertyUnit: PropertyUnit }) {
  const {
    selectedElementIds,
    hvacElements,
    rooms,
    updateHvacElement,
  } = useSmartDrawingStore((state) => ({
    selectedElementIds: state.selectedElementIds,
    hvacElements: state.hvacElements,
    rooms: state.rooms,
    updateHvacElement: state.updateHvacElement,
  }), shallow);

  const selectedEquipment = useMemo(() => {
    return hvacElements.find((element) => selectedElementIds.includes(element.id)) ?? null;
  }, [hvacElements, selectedElementIds]);

  if (!selectedEquipment) {
    return <p className="text-sm text-slate-400">No AC equipment selected</p>;
  }

  const roomName = selectedEquipment.roomId
    ? rooms.find((room) => room.id === selectedEquipment.roomId)?.name ?? selectedEquipment.roomId
    : 'Unassigned';
  const capacityKw = propertyAsNumber(selectedEquipment.properties, 'capacityKw');
  const heatingCapacityKw = propertyAsNumber(selectedEquipment.properties, 'heatingCapacityKw');
  const airflowLps = propertyAsNumber(selectedEquipment.properties, 'airflowLps');
  const staticPressurePa = propertyAsNumber(selectedEquipment.properties, 'staticPressurePa');
  const voltage = propertyAsNumber(selectedEquipment.properties, 'voltage');
  const refrigerantType = propertyAsString(selectedEquipment.properties, 'refrigerantType', '-');

  const updateProperties = (properties: Record<string, unknown>) => {
    updateHvacElement(selectedEquipment.id, { properties });
  };

  return (
    <div className="space-y-1">
      <PropertyRow label="Label">
        <input
          type="text"
          value={selectedEquipment.label}
          onChange={(e) => updateHvacElement(selectedEquipment.id, { label: e.target.value })}
          className="w-36 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
      </PropertyRow>
      <PropertyRow label="Type">
        <span className="text-sm text-slate-700">{selectedEquipment.modelLabel ?? selectedEquipment.type}</span>
      </PropertyRow>
      <PropertyRow label="Room">
        <span className="text-sm text-slate-700">{roomName}</span>
      </PropertyRow>
      <PropertyRow label="Wall Ref">
        <span className="text-xs text-slate-500">{selectedEquipment.wallId ?? 'Free placement'}</span>
      </PropertyRow>
      <PropertyRow label="Rotation">
        <input
          type="number"
          min={-360}
          max={360}
          step={5}
          value={selectedEquipment.rotation.toFixed(1)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            updateHvacElement(selectedEquipment.id, { rotation: parsed });
          }}
          className="w-24 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
      </PropertyRow>
      <PropertyRow label="Elevation">
        <input
          type="number"
          step={propertyUnit === 'mm' ? 1 : 0.01}
          value={fromMm(selectedEquipment.elevation, propertyUnit).toFixed(2)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            updateHvacElement(selectedEquipment.id, { elevation: Math.max(0, toMm(parsed, propertyUnit)) });
          }}
          className="w-24 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <span className="text-xs text-slate-500">{formatUnit(propertyUnit)}</span>
      </PropertyRow>
      <PropertyRow label="Plan Size">
        <span className="text-sm text-slate-700">
          {fromMm(selectedEquipment.width, propertyUnit).toFixed(2)} x {fromMm(selectedEquipment.depth, propertyUnit).toFixed(2)} {formatUnit(propertyUnit)}
        </span>
      </PropertyRow>
      <PropertyRow label="Capacity">
        <input
          type="number"
          step={0.1}
          value={capacityKw.toFixed(1)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            updateProperties({ capacityKw: parsed });
          }}
          className="w-24 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <span className="text-xs text-slate-500">kW</span>
      </PropertyRow>
      <PropertyRow label="Airflow">
        <input
          type="number"
          step={1}
          value={airflowLps.toFixed(0)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            updateProperties({ airflowLps: parsed });
          }}
          className="w-24 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <span className="text-xs text-slate-500">L/s</span>
      </PropertyRow>
      <PropertyRow label="Heating">
        <input
          type="number"
          step={0.1}
          value={heatingCapacityKw.toFixed(1)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            updateProperties({ heatingCapacityKw: parsed });
          }}
          className="w-24 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <span className="text-xs text-slate-500">kW</span>
      </PropertyRow>
      <PropertyRow label="External Static Pressure">
        <input
          type="number"
          step={1}
          value={staticPressurePa.toFixed(0)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            updateProperties({ staticPressurePa: parsed, espPa: parsed });
          }}
          className="w-24 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <span className="text-xs text-slate-500">Pa</span>
      </PropertyRow>
      <PropertyRow label="Voltage">
        <input
          type="number"
          step={1}
          value={voltage.toFixed(0)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            updateProperties({ voltage: parsed });
          }}
          className="w-24 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <span className="text-xs text-slate-500">V</span>
      </PropertyRow>
      <PropertyRow label="Refrigerant">
        <input
          type="text"
          value={refrigerantType}
          onChange={(e) => updateProperties({ refrigerantType: e.target.value })}
          className="w-24 rounded border border-amber-200/80 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
      </PropertyRow>
    </div>
  );
}

function RoomSection({ propertyUnit }: { propertyUnit: PropertyUnit }) {
  const {
    rooms,
    selectedElementIds,
    setSelectedIds,
    materialLibrary,
    updateRoom,
    updateRoom3DAttributes,
    applyRoomTemplateToSelectedRooms,
  } = useSmartDrawingStore((state) => ({
    rooms: state.rooms,
    selectedElementIds: state.selectedElementIds,
    setSelectedIds: state.setSelectedIds,
    materialLibrary: state.materialLibrary,
    updateRoom: state.updateRoom,
    updateRoom3DAttributes: state.updateRoom3DAttributes,
    applyRoomTemplateToSelectedRooms: state.applyRoomTemplateToSelectedRooms,
  }), shallow);
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [tab, setTab] = useState<'general' | 'thermal' | 'ventilation' | 'calculated'>('general');
  const roomTypeOptions: RoomType[] = [
    'Bathroom/Closet',
    'Bedroom',
    'Living Room',
    'Open Space',
    'Corridor',
    'Passage',
    'Balcony',
    'Custom',
  ];
  const scheduleOptions: RoomOccupancySchedule[] = ['daytime', 'evening', '24-hour'];

  const selectedFromCanvas = rooms.find((room) => selectedElementIds.includes(room.id));
  const resolvedRoomId = selectedFromCanvas?.id || selectedRoomId || rooms[0]?.id || '';
  const selectedRoom = rooms.find((room) => room.id === resolvedRoomId) ?? null;
  const roomAreaM2 = selectedRoom ? selectedRoom.area / 1_000_000 : 0;
  const template = selectedRoom
    ? DEFAULT_ROOM_HVAC_TEMPLATES.find((entry) => entry.id === selectedRoom.properties3D.hvacTemplateId) ?? null
    : null;

  if (!selectedRoom) {
    return <p className="text-sm text-slate-400">No room available</p>;
  }

  const applyTemplateToRoom = (templateId: string) => {
    const next = DEFAULT_ROOM_HVAC_TEMPLATES.find((entry) => entry.id === templateId);
    if (!next) return;
    const occupancyFromDensity = next.occupantsPer10m2 > 0 ? (roomAreaM2 / 10) * next.occupantsPer10m2 : 0;
    const occupantCount = Math.max(1, Math.round(Math.max(next.occupantsBase, occupancyFromDensity) * 10) / 10);
    updateRoom3DAttributes(selectedRoom.id, {
      hvacTemplateId: next.id,
      occupantCount,
      occupancySchedule: next.schedule,
      lightingLoadWm2: next.lightingWm2,
      equipmentLoadWm2: next.equipmentWm2,
      requiresExhaust: next.requiresExhaust,
    });
  };

  const loadBreakdown = selectedRoom.properties3D.loadBreakdown;
  const loadTotal = loadBreakdown.occupancyW + loadBreakdown.lightingW + loadBreakdown.equipmentW;
  const occPct = loadTotal > 0 ? (loadBreakdown.occupancyW / loadTotal) * 100 : 0;
  const lightPct = loadTotal > 0 ? (loadBreakdown.lightingW / loadTotal) * 100 : 0;
  const equipPct = Math.max(0, 100 - occPct - lightPct);

  return (
    <div className="space-y-1">
      <PropertyRow label="Room">
        <select
          value={resolvedRoomId}
          onChange={(e) => {
            setSelectedRoomId(e.target.value);
            setSelectedIds([e.target.value]);
          }}
          className="w-40 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          {rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.name}
            </option>
          ))}
        </select>
      </PropertyRow>
      <div className="flex flex-wrap gap-1 pb-2 border-b border-amber-100/70">
        <TabButton active={tab === 'general'} label="General" onClick={() => setTab('general')} />
        <TabButton active={tab === 'thermal'} label="Thermal" onClick={() => setTab('thermal')} />
        <TabButton active={tab === 'ventilation'} label="Ventilation" onClick={() => setTab('ventilation')} />
        <TabButton active={tab === 'calculated'} label="Calculated" onClick={() => setTab('calculated')} />
      </div>

      {tab === 'general' && (
        <div className="space-y-1">
          <PropertyRow label="Name">
            <input
              type="text"
              value={selectedRoom.name}
              onChange={(e) => updateRoom(selectedRoom.id, { name: e.target.value })}
              className="w-40 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Type">
            <select
              value={selectedRoom.roomType}
              onChange={(e) => updateRoom(selectedRoom.id, { roomType: e.target.value as RoomType })}
              className="w-40 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            >
              {roomTypeOptions.map((roomType) => (
                <option key={roomType} value={roomType}>{roomType}</option>
              ))}
            </select>
          </PropertyRow>
          <PropertyRow label="Area">
            <span className="text-sm text-slate-700">{roomAreaM2.toFixed(2)} m2</span>
          </PropertyRow>
          <PropertyRow label="Perimeter">
            <span className="text-sm text-slate-700">{selectedRoom.perimeter.toFixed(0)} mm</span>
          </PropertyRow>
          <PropertyRow label="Height">
            <input
              type="number"
              min={fromMm(MIN_WALL_HEIGHT, propertyUnit)}
              step={propertyUnit === 'mm' ? 1 : 0.01}
              value={fromMm(selectedRoom.properties3D.ceilingHeight, propertyUnit).toFixed(2)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateRoom3DAttributes(selectedRoom.id, { ceilingHeight: Math.max(MIN_WALL_HEIGHT, toMm(parsed, propertyUnit)) });
              }}
              className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Floor Elevation">
            <input
              type="number"
              step={propertyUnit === 'mm' ? 1 : 0.01}
              value={fromMm(selectedRoom.properties3D.floorElevation, propertyUnit).toFixed(2)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateRoom3DAttributes(selectedRoom.id, { floorElevation: toMm(parsed, propertyUnit) });
              }}
              className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Material">
            <select
              value={selectedRoom.properties3D.materialId}
              onChange={(e) => updateRoom3DAttributes(selectedRoom.id, { materialId: e.target.value })}
              className="w-44 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            >
              {materialLibrary.map((material) => (
                <option key={material.id} value={material.id}>{material.name} ({material.family})</option>
              ))}
            </select>
          </PropertyRow>
          <PropertyRow label="Finishes">
            <input
              type="text"
              value={selectedRoom.finishes}
              onChange={(e) => updateRoom(selectedRoom.id, { finishes: e.target.value })}
              className="w-44 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Notes">
            <textarea
              value={selectedRoom.notes}
              onChange={(e) => updateRoom(selectedRoom.id, { notes: e.target.value })}
              rows={2}
              className="w-44 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white resize-none"
            />
          </PropertyRow>
          <PropertyRow label="Fill Color">
            <input
              type="color"
              value={selectedRoom.fillColor}
              onChange={(e) => updateRoom(selectedRoom.id, { fillColor: e.target.value })}
              className="h-8 w-12 rounded border border-amber-200/80 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Show Label">
            <input
              type="checkbox"
              checked={selectedRoom.showLabel}
              onChange={(e) => updateRoom(selectedRoom.id, { showLabel: e.target.checked })}
            />
          </PropertyRow>
        </div>
      )}

      {tab === 'thermal' && (
        <div className="space-y-1">
          <PropertyRow label="HVAC Template">
            <select
              value={selectedRoom.properties3D.hvacTemplateId}
              onChange={(e) => applyTemplateToRoom(e.target.value)}
              className="w-40 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            >
              {DEFAULT_ROOM_HVAC_TEMPLATES.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.roomType}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => applyRoomTemplateToSelectedRooms(selectedRoom.properties3D.hvacTemplateId)}
              className="rounded border border-amber-200/80 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-amber-50"
            >
              Bulk Apply
            </button>
          </PropertyRow>
          {template && (
            <div className="rounded border border-amber-200/80 bg-amber-50/30 px-2 py-1 text-[11px] text-slate-600">
              Defaults: {template.occupantsBase} occupants, {template.lightingWm2} W/m2 lighting, {template.equipmentWm2} W/m2 equipment.
            </div>
          )}
          <PropertyRow label="Occupancy">
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={selectedRoom.properties3D.occupantCount.toFixed(1)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateRoom3DAttributes(selectedRoom.id, { occupantCount: Math.max(0.1, parsed) });
              }}
              className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
          </PropertyRow>
          <PropertyRow label="Schedule">
            <select
              value={selectedRoom.properties3D.occupancySchedule}
              onChange={(e) => updateRoom3DAttributes(selectedRoom.id, { occupancySchedule: e.target.value as RoomOccupancySchedule })}
              className="w-28 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            >
              {scheduleOptions.map((schedule) => (
                <option key={schedule} value={schedule}>{schedule}</option>
              ))}
            </select>
          </PropertyRow>
          <PropertyRow label="Lighting">
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              title="Recommended range 5-20 W/m2."
              value={selectedRoom.properties3D.lightingLoadWm2.toFixed(1)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateRoom3DAttributes(selectedRoom.id, { lightingLoadWm2: clamp(parsed, 0, 100) });
              }}
              className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
            <span className="text-xs text-slate-500">W/m2</span>
          </PropertyRow>
          <PropertyRow label="Equipment">
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              title="Recommended range 5-30 W/m2."
              value={selectedRoom.properties3D.equipmentLoadWm2.toFixed(1)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateRoom3DAttributes(selectedRoom.id, { equipmentLoadWm2: clamp(parsed, 0, 100) });
              }}
              className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
            <span className="text-xs text-slate-500">W/m2</span>
          </PropertyRow>
          <PropertyRow label="Setpoints">
            <div className="flex items-center gap-1">
              <input
                type="number"
                step={0.5}
                value={selectedRoom.properties3D.heatingSetpointC.toFixed(1)}
                onChange={(e) => {
                  const parsed = Number.parseFloat(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  updateRoom3DAttributes(selectedRoom.id, { heatingSetpointC: parsed });
                }}
                className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
              />
              <input
                type="number"
                step={0.5}
                value={selectedRoom.properties3D.coolingSetpointC.toFixed(1)}
                onChange={(e) => {
                  const parsed = Number.parseFloat(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  updateRoom3DAttributes(selectedRoom.id, { coolingSetpointC: parsed });
                }}
                className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
              />
            </div>
          </PropertyRow>
          <PropertyRow label="Window SHGC">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={selectedRoom.properties3D.windowShgc.toFixed(2)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateRoom3DAttributes(selectedRoom.id, { windowShgc: clamp(parsed, 0, 1) });
              }}
              className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
            />
          </PropertyRow>
        </div>
      )}

      {tab === 'ventilation' && (
        <div className="space-y-1">
          <PropertyRow label="OA / Person">
            <input
              type="number"
              min={0}
              step={0.1}
              value={selectedRoom.properties3D.outdoorAirPerPersonLps.toFixed(1)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateRoom3DAttributes(selectedRoom.id, { outdoorAirPerPersonLps: Math.max(0, parsed) });
              }}
              className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
            />
            <span className="text-xs text-slate-500">L/s-person</span>
          </PropertyRow>
          <PropertyRow label="OA / Area">
            <input
              type="number"
              min={0}
              step={0.05}
              value={selectedRoom.properties3D.outdoorAirPerAreaLpsm2.toFixed(2)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateRoom3DAttributes(selectedRoom.id, { outdoorAirPerAreaLpsm2: Math.max(0, parsed) });
              }}
              className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
            />
            <span className="text-xs text-slate-500">L/s-m2</span>
          </PropertyRow>
          <PropertyRow label="Minimum OA">
            <span className="text-sm text-slate-700">{selectedRoom.properties3D.ventilationOutdoorAirLps.toFixed(1)} L/s</span>
          </PropertyRow>
          <PropertyRow label="Exhaust Required">
            <input
              type="checkbox"
              checked={selectedRoom.properties3D.requiresExhaust}
              onChange={(e) => updateRoom3DAttributes(selectedRoom.id, { requiresExhaust: e.target.checked })}
            />
          </PropertyRow>
          <PropertyRow label="Windows">
            <span className="text-xs text-slate-500">{selectedRoom.hasWindows ? 'Detected' : 'None detected'}</span>
          </PropertyRow>
        </div>
      )}

      {tab === 'calculated' && (
        <div className="space-y-1">
          <PropertyRow label="Cooling Load">
            <span className="text-sm text-slate-700">{selectedRoom.properties3D.calculatedCoolingLoadW.toFixed(0)} W</span>
          </PropertyRow>
          <PropertyRow label="Heating Load">
            <span className="text-sm text-slate-700">{selectedRoom.properties3D.calculatedHeatingLoadW.toFixed(0)} W</span>
          </PropertyRow>
          <PropertyRow label="Volume">
            <span className="text-sm text-slate-700">{selectedRoom.properties3D.computedVolumeM3.toFixed(3)} m3</span>
          </PropertyRow>
          <div className="rounded border border-amber-200/80 bg-amber-50/30 p-2 space-y-1">
            <div className="text-xs text-slate-600">Load Distribution</div>
            <div className="flex items-center gap-2">
              <div
                className="h-10 w-10 rounded-full border border-slate-300"
                style={{
                  background: `conic-gradient(#3B82F6 0 ${occPct}%, #F59E0B ${occPct}% ${occPct + lightPct}%, #10B981 ${occPct + lightPct}% ${occPct + lightPct + equipPct}%)`,
                }}
              />
              <div className="text-[11px] text-slate-600">
                <div>Occ: {loadBreakdown.occupancyW.toFixed(0)} W</div>
                <div>Light: {loadBreakdown.lightingW.toFixed(0)} W</div>
                <div>Equip: {loadBreakdown.equipmentW.toFixed(0)} W</div>
              </div>
            </div>
          </div>
          {selectedRoom.validationWarnings.length > 0 && (
            <div className="rounded border border-amber-200/80 bg-amber-50 px-2 py-2 text-xs text-amber-800 space-y-1">
              {selectedRoom.validationWarnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          )}
          <PropertyRow label="Library Entries">
            <span className="text-xs text-slate-500">{DEFAULT_ARCHITECTURAL_MATERIALS.length} materials</span>
          </PropertyRow>
        </div>
      )}
    </div>
  );
}

function HvacDesignSection() {
  const { hvacDesignConditions, setHvacDesignConditions } = useSmartDrawingStore((state) => ({
    hvacDesignConditions: state.hvacDesignConditions,
    setHvacDesignConditions: state.setHvacDesignConditions,
  }), shallow);

  const parseAndApply = (value: string, setter: (next: number) => void) => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return;
    setter(parsed);
  };

  return (
    <div className="space-y-1">
      <PropertyRow label="Location">
        <input
          type="text"
          value={hvacDesignConditions.location}
          onChange={(e) => setHvacDesignConditions({ location: e.target.value })}
          className="w-36 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Country">
        <input
          type="text"
          value={hvacDesignConditions.country}
          onChange={(e) => setHvacDesignConditions({ country: e.target.value })}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Summer DB/WB">
        <div className="flex items-center gap-1">
          <input
            type="number"
            step={0.5}
            value={hvacDesignConditions.summerDryBulbC.toFixed(1)}
            onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({ summerDryBulbC: next }))}
            className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
          />
          <input
            type="number"
            step={0.5}
            value={hvacDesignConditions.summerWetBulbC.toFixed(1)}
            onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({ summerWetBulbC: next }))}
            className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
          />
          <span className="text-xs text-slate-500">C</span>
        </div>
      </PropertyRow>
      <PropertyRow label="Winter DB">
        <input
          type="number"
          step={0.5}
          value={hvacDesignConditions.winterDryBulbC.toFixed(1)}
          onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({ winterDryBulbC: next }))}
          className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Ground Temp">
        <input
          type="number"
          step={0.5}
          value={hvacDesignConditions.groundTemperatureC.toFixed(1)}
          onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({ groundTemperatureC: next }))}
          className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Altitude">
        <input
          type="number"
          step={1}
          value={hvacDesignConditions.altitudeM.toFixed(0)}
          onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({ altitudeM: next }))}
          className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
        />
        <span className="text-xs text-slate-500">m</span>
      </PropertyRow>
      <PropertyRow label="Peak Cooling">
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={hvacDesignConditions.peakCoolingMonth}
            onChange={(e) => setHvacDesignConditions({ peakCoolingMonth: e.target.value })}
            className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
          />
          <input
            type="number"
            min={0}
            max={23}
            step={1}
            value={hvacDesignConditions.peakCoolingHour}
            onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({ peakCoolingHour: next }))}
            className="w-14 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
          />
        </div>
      </PropertyRow>
      <PropertyRow label="Default Diversity">
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={hvacDesignConditions.internalGainDiversityFactor.toFixed(2)}
          onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({ internalGainDiversityFactor: clamp(next, 0, 1) }))}
          className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Default SHGC">
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={hvacDesignConditions.defaultWindowShgc.toFixed(2)}
          onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({ defaultWindowShgc: clamp(next, 0, 1) }))}
          className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Seasonal Adj">
        <div className="flex items-center gap-1">
          <input
            type="number"
            step={0.05}
            value={hvacDesignConditions.seasonalVariation.summerAdjustment.toFixed(2)}
            onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({
              seasonalVariation: {
                ...hvacDesignConditions.seasonalVariation,
                summerAdjustment: next,
              },
            }))}
            className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
          />
          <input
            type="number"
            step={0.05}
            value={hvacDesignConditions.seasonalVariation.winterAdjustment.toFixed(2)}
            onChange={(e) => parseAndApply(e.target.value, (next) => setHvacDesignConditions({
              seasonalVariation: {
                ...hvacDesignConditions.seasonalVariation,
                winterAdjustment: next,
              },
            }))}
            className="w-16 px-2 py-1 text-sm border border-amber-200/80 rounded bg-white"
          />
        </div>
      </PropertyRow>
      <button
        type="button"
        onClick={() => setHvacDesignConditions({ ...DEFAULT_HVAC_DESIGN_CONDITIONS })}
        className="w-full rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
      >
        Reset HVAC Defaults
      </button>
    </div>
  );
}

function WallToolSection() {
  const {
    activeTool,
    wallSettings,
    setWallSettings,
    setWallPreviewMaterial,
    setWallPreviewThickness,
  } = useSmartDrawingStore((state) => ({
    activeTool: state.activeTool,
    wallSettings: state.wallSettings,
    setWallSettings: state.setWallSettings,
    setWallPreviewMaterial: state.setWallPreviewMaterial,
    setWallPreviewThickness: state.setWallPreviewThickness,
  }), shallow);

  const partitionToolActive = activeTool === 'partition-wall';
  const activeDefaultThickness = partitionToolActive
    ? wallSettings.defaultPartitionThickness
    : wallSettings.defaultThickness;

  const gridPreset =
    wallSettings.gridSize === 50
      ? '50'
      : wallSettings.gridSize === 100
        ? '100'
        : 'custom';

  return (
    <div className="space-y-1">
      <PropertyRow label="Snap to Grid">
        <input
          type="checkbox"
          checked={wallSettings.snapToGrid}
          onChange={(e) => setWallSettings({ snapToGrid: e.target.checked })}
        />
      </PropertyRow>
      <PropertyRow label="Grid Size">
        <select
          value={gridPreset}
          onChange={(e) => {
            const value = e.target.value;
            if (value === '50') setWallSettings({ gridSize: 50 });
            if (value === '100') setWallSettings({ gridSize: 100 });
            if (value === 'custom') setWallSettings({ gridSize: Math.max(1, wallSettings.gridSize) });
          }}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value="50">50 mm</option>
          <option value="100">100 mm</option>
          <option value="custom">Custom</option>
        </select>
        {gridPreset === 'custom' && (
          <input
            type="number"
            min={1}
            step={1}
            value={Math.round(wallSettings.gridSize)}
            onChange={(e) => {
              const parsed = Number.parseFloat(e.target.value);
              if (!Number.isFinite(parsed)) return;
              setWallSettings({ gridSize: Math.max(1, parsed) });
            }}
            className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
          />
        )}
      </PropertyRow>
      {partitionToolActive && (
        <PropertyRow label="Partition Mode">
          <select
            value={wallSettings.partitionMode}
            onChange={(e) => setWallSettings({ partitionMode: e.target.value as PartitionWallMode })}
            className="w-28 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
          >
            <option value="full">Full</option>
            <option value="half">Half (4 ft)</option>
            <option value="top">Top (&lt; 1 ft below)</option>
          </select>
        </PropertyRow>
      )}
      <PropertyRow label={partitionToolActive ? 'Partition Thickness' : 'Default Thickness'}>
        <input
          type="number"
          min={MIN_WALL_THICKNESS}
          max={MAX_WALL_THICKNESS}
          step={10}
          value={Math.round(activeDefaultThickness)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            const next = clamp(parsed, MIN_WALL_THICKNESS, MAX_WALL_THICKNESS);
            setWallSettings(partitionToolActive
              ? { defaultPartitionThickness: next }
              : { defaultThickness: next });
            setWallPreviewThickness(next);
          }}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Default Height">
        <input
          type="number"
          min={MIN_WALL_HEIGHT}
          max={MAX_WALL_HEIGHT}
          step={100}
          value={Math.round(wallSettings.defaultHeight)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            setWallSettings({ defaultHeight: clamp(parsed, MIN_WALL_HEIGHT, MAX_WALL_HEIGHT) });
          }}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        />
      </PropertyRow>
      <PropertyRow label={partitionToolActive ? 'Partition Material' : 'Default Material'}>
        <select
          value={partitionToolActive ? 'partition' : wallSettings.defaultMaterial}
          onChange={(e) => {
            const material = e.target.value as WallMaterial;
            setWallSettings({ defaultMaterial: material });
            setWallPreviewMaterial(material);
          }}
          disabled={partitionToolActive}
          className="w-32 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value="brick">Brick</option>
          <option value="concrete">Concrete</option>
          <option value="partition">Partition</option>
        </select>
      </PropertyRow>
      <PropertyRow label="Show Height Tag">
        <input
          type="checkbox"
          checked={wallSettings.showHeightTags}
          onChange={(e) => setWallSettings({ showHeightTags: e.target.checked })}
        />
      </PropertyRow>
      <PropertyRow label="Color by Material">
        <input
          type="checkbox"
          checked={wallSettings.wallColorMode === 'material'}
          onChange={(e) =>
            setWallSettings({
              colorCodeByMaterial: e.target.checked,
              wallColorMode: e.target.checked ? 'material' : 'u-value',
            })
          }
        />
      </PropertyRow>
      <PropertyRow label="Show Layer Count">
        <input
          type="checkbox"
          checked={wallSettings.showLayerCountIndicators}
          onChange={(e) => setWallSettings({ showLayerCountIndicators: e.target.checked })}
        />
      </PropertyRow>
      <PropertyRow label="Room Temp Icons">
        <input
          type="checkbox"
          checked={wallSettings.showRoomTemperatureIcons}
          onChange={(e) => setWallSettings({ showRoomTemperatureIcons: e.target.checked })}
        />
      </PropertyRow>
      <PropertyRow label="Ventilation Badges">
        <input
          type="checkbox"
          checked={wallSettings.showRoomVentilationBadges}
          onChange={(e) => setWallSettings({ showRoomVentilationBadges: e.target.checked })}
        />
      </PropertyRow>
    </div>
  );
}

function DimensionSection() {
  const {
    dimensions,
    selectedElementIds,
    dimensionSettings,
    setDimensionSettings,
    updateDimension,
    autoDimensionExteriorWalls,
    addAreaDimensions,
  } = useSmartDrawingStore((state) => ({
    dimensions: state.dimensions,
    selectedElementIds: state.selectedElementIds,
    dimensionSettings: state.dimensionSettings,
    setDimensionSettings: state.setDimensionSettings,
    updateDimension: state.updateDimension,
    autoDimensionExteriorWalls: state.autoDimensionExteriorWalls,
    addAreaDimensions: state.addAreaDimensions,
  }), shallow);

  const selectedDimension = useMemo(
    () => dimensions.find((dimension) => selectedElementIds.includes(dimension.id)) ?? null,
    [dimensions, selectedElementIds]
  );

  const placementOptions: { value: DimensionPlacementType; label: string }[] = [
    { value: 'linear', label: 'Linear' },
    { value: 'angular', label: 'Angular' },
    { value: 'area', label: 'Area' },
  ];

  const displayFormatOptions: { value: DimensionDisplayFormat; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'mm', label: 'mm' },
    { value: 'm', label: 'm' },
    { value: 'ft-in', label: 'ft-in' },
    { value: 'in', label: 'in' },
  ];

  return (
    <div className="space-y-1">
      <PropertyRow label="Placement">
        <select
          value={dimensionSettings.placementType}
          onChange={(e) => setDimensionSettings({ placementType: e.target.value as DimensionPlacementType })}
          className="w-32 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          {placementOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </PropertyRow>
      <PropertyRow label="Style">
        <select
          value={dimensionSettings.style}
          onChange={(e) => setDimensionSettings({ style: e.target.value as typeof dimensionSettings.style })}
          className="w-32 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value="architectural">Architectural</option>
          <option value="engineering">Engineering</option>
          <option value="minimal">Minimal</option>
        </select>
      </PropertyRow>
      <PropertyRow label="Terminator">
        <select
          value={dimensionSettings.terminator}
          onChange={(e) => setDimensionSettings({ terminator: e.target.value as typeof dimensionSettings.terminator })}
          className="w-32 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value="tick">Tick</option>
          <option value="arrow">Arrow</option>
        </select>
      </PropertyRow>
      <PropertyRow label="Unit System">
        <select
          value={dimensionSettings.unitSystem}
          onChange={(e) => setDimensionSettings({ unitSystem: e.target.value as typeof dimensionSettings.unitSystem })}
          className="w-32 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value="metric">Metric</option>
          <option value="imperial">Imperial</option>
        </select>
      </PropertyRow>
      <PropertyRow label="Display Format">
        <select
          value={dimensionSettings.displayFormat}
          onChange={(e) => setDimensionSettings({ displayFormat: e.target.value as DimensionDisplayFormat })}
          className="w-32 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          {displayFormatOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </PropertyRow>
      <PropertyRow label="Precision">
        <select
          value={dimensionSettings.precision}
          onChange={(e) => setDimensionSettings({ precision: Number.parseInt(e.target.value, 10) as 0 | 1 | 2 })}
          className="w-20 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value={0}>0</option>
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>
      </PropertyRow>
      <PropertyRow label="Default Offset">
        <input
          type="number"
          min={20}
          step={10}
          value={Math.round(dimensionSettings.defaultOffset)}
          onChange={(e) => {
            const parsed = Number.parseFloat(e.target.value);
            if (!Number.isFinite(parsed)) return;
            setDimensionSettings({ defaultOffset: Math.max(20, parsed) });
          }}
          className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        />
      </PropertyRow>
      <PropertyRow label="Show Area Perimeter">
        <input
          type="checkbox"
          checked={dimensionSettings.showAreaPerimeter}
          onChange={(e) => setDimensionSettings({ showAreaPerimeter: e.target.checked })}
        />
      </PropertyRow>
      <PropertyRow label="Show Layer">
        <input
          type="checkbox"
          checked={dimensionSettings.showLayer}
          onChange={(e) => setDimensionSettings({ showLayer: e.target.checked })}
        />
      </PropertyRow>

      {selectedDimension && (
        <PropertyRow label="Selected Dim">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-600">{selectedDimension.type}</span>
            <input
              type="checkbox"
              checked={selectedDimension.visible}
              onChange={(e) => updateDimension(selectedDimension.id, { visible: e.target.checked })}
              title="Visible"
            />
          </div>
        </PropertyRow>
      )}

      <div className="grid grid-cols-1 gap-2 pt-2">
        <button
          type="button"
          onClick={autoDimensionExteriorWalls}
          className="rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
        >
          Dimension All Walls
        </button>
        <button
          type="button"
          onClick={addAreaDimensions}
          className="rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
        >
          Add Room Area Labels
        </button>
      </div>
    </div>
  );
}

function RoomListSection() {
  const { rooms, setSelectedIds } = useSmartDrawingStore((state) => ({
    rooms: state.rooms,
    setSelectedIds: state.setSelectedIds,
  }), shallow);
  const [typeFilter, setTypeFilter] = useState<'all' | RoomType>('all');
  const [sortBy, setSortBy] = useState<'name' | 'area' | 'type'>('name');

  const filteredRooms = useMemo(() => {
    const next = rooms.filter((room) => (typeFilter === 'all' ? true : room.roomType === typeFilter));
    next.sort((a, b) => {
      if (sortBy === 'area') {
        return b.area - a.area;
      }
      if (sortBy === 'type') {
        return a.roomType.localeCompare(b.roomType);
      }
      return a.name.localeCompare(b.name);
    });
    return next;
  }, [rooms, sortBy, typeFilter]);

  const exportSchedule = () => {
    if (filteredRooms.length === 0) return;
    const header = 'Name,Type,Area(m2),Perimeter(mm),AdjacencyCount,Warnings';
    const rows = filteredRooms.map((room) => [
      `"${room.name.replace(/"/g, '""')}"`,
      `"${room.roomType}"`,
      (room.area / 1_000_000).toFixed(2),
      room.perimeter.toFixed(0),
      room.adjacentRoomIds.length.toString(),
      `"${room.validationWarnings.join('; ').replace(/"/g, '""')}"`,
    ].join(','));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'room-schedule.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as 'all' | RoomType)}
          className="flex-1 px-2 py-1 text-xs border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value="all">All Types</option>
          <option value="Bathroom/Closet">Bathroom/Closet</option>
          <option value="Bedroom">Bedroom</option>
          <option value="Living Room">Living Room</option>
          <option value="Open Space">Open Space</option>
          <option value="Corridor">Corridor</option>
          <option value="Passage">Passage</option>
          <option value="Balcony">Balcony</option>
          <option value="Custom">Custom</option>
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'name' | 'area' | 'type')}
          className="flex-1 px-2 py-1 text-xs border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
        >
          <option value="name">Sort: Name</option>
          <option value="area">Sort: Area</option>
          <option value="type">Sort: Type</option>
        </select>
      </div>

      <div className="max-h-48 overflow-y-auto rounded border border-amber-200/80 bg-white/80">
        {filteredRooms.length === 0 && (
          <div className="px-2 py-2 text-xs text-slate-400">No rooms detected</div>
        )}
        {filteredRooms.map((room) => (
          <button
            key={room.id}
            type="button"
            onClick={() => setSelectedIds([room.id])}
            className="w-full text-left px-2 py-2 border-b border-amber-100/70 last:border-b-0 hover:bg-amber-50"
          >
            <div className="text-xs font-medium text-slate-700">{room.name}</div>
            <div className="text-[11px] text-slate-500">
              {room.roomType} | {(room.area / 1_000_000).toFixed(1)}m²
            </div>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={exportSchedule}
        className="w-full rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
      >
        Export Room Schedule
      </button>
    </div>
  );
}

function ElevationSection() {
  const {
    setTool,
    setWallSettings,
    wallSettings,
    sectionLines,
    elevationViews,
    activeElevationViewId,
    elevationSettings,
    setActiveElevationView,
    setElevationSettings,
    regenerateElevations,
    generateElevationForSection,
    flipSectionLineDirection,
    updateSectionLine,
    deleteSectionLine,
  } = useSmartDrawingStore((state) => ({
    setTool: state.setTool,
    setWallSettings: state.setWallSettings,
    wallSettings: state.wallSettings,
    sectionLines: state.sectionLines,
    elevationViews: state.elevationViews,
    activeElevationViewId: state.activeElevationViewId,
    elevationSettings: state.elevationSettings,
    setActiveElevationView: state.setActiveElevationView,
    setElevationSettings: state.setElevationSettings,
    regenerateElevations: state.regenerateElevations,
    generateElevationForSection: state.generateElevationForSection,
    flipSectionLineDirection: state.flipSectionLineDirection,
    updateSectionLine: state.updateSectionLine,
    deleteSectionLine: state.deleteSectionLine,
  }), shallow);

  const activeView = elevationViews.find((view) => view.id === activeElevationViewId) ?? elevationViews[0] ?? null;
  const linkedSectionLine = activeView?.sectionLineId
    ? sectionLines.find((line) => line.id === activeView.sectionLineId) ?? null
    : null;
  const previewWidth = 340;
  const previewHeight = 180;
  const spanX = activeView ? Math.max(1, activeView.maxX - activeView.minX) : 1;
  const spanY = activeView ? Math.max(1000, activeView.maxHeightMm) : 1000;
  const scaleX = (previewWidth - 20) / spanX;
  const scaleY = (previewHeight - 20) / spanY;
  const toPreviewX = (value: number) => 10 + (value - (activeView?.minX ?? 0)) * scaleX;
  const toPreviewY = (value: number) => previewHeight - 10 - value * scaleY;

  const formatViewLabel = (name: string, kind: string) => {
    if (kind === 'custom') return name;
    return name.replace(' Elevation', '');
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTool('section-line')}
          className="flex-1 rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
        >
          Section Line Tool
        </button>
        <button
          type="button"
          onClick={() => regenerateElevations()}
          className="flex-1 rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
        >
          Generate Elevations
        </button>
      </div>

      <div className="flex flex-wrap gap-1">
        {elevationViews.map((view) => (
          <TabButton
            key={view.id}
            active={activeView?.id === view.id}
            label={formatViewLabel(view.name, view.kind)}
            onClick={() => setActiveElevationView(view.id)}
          />
        ))}
      </div>

      {activeView ? (
        <div className="rounded border border-amber-200/80 bg-white/80 p-2 space-y-1">
          <PropertyRow label="View">
            <span className="text-xs text-slate-600">{activeView.name}</span>
          </PropertyRow>
          <PropertyRow label="Projected Walls">
            <span className="text-sm text-slate-700">{activeView.walls.length}</span>
          </PropertyRow>
          <PropertyRow label="Max Height">
            <span className="text-sm text-slate-700">{(activeView.maxHeightMm / 1000).toFixed(2)} m</span>
          </PropertyRow>
          <PropertyRow label="Scale">
            <span className="text-sm text-slate-700">1:{Math.round(activeView.scale)}</span>
          </PropertyRow>
          <PropertyRow label="Grid Increment">
            <span className="text-sm text-slate-700">{Math.round(activeView.gridIncrementMm)} mm</span>
          </PropertyRow>
          <div className="rounded border border-amber-200/70 bg-white p-1">
            <svg
              viewBox={`0 0 ${previewWidth} ${previewHeight}`}
              className="w-full h-40"
              role="img"
              aria-label="Elevation preview"
            >
              <line
                x1={8}
                y1={toPreviewY(0)}
                x2={previewWidth - 8}
                y2={toPreviewY(0)}
                stroke="#1f2937"
                strokeWidth={1.2}
              />
              {activeView.walls.map((wall) => {
                const x = Math.min(toPreviewX(wall.xStart), toPreviewX(wall.xEnd));
                const width = Math.max(1.5, Math.abs(toPreviewX(wall.xEnd) - toPreviewX(wall.xStart)));
                const yTop = toPreviewY(wall.yTop);
                const yBottom = toPreviewY(wall.yBottom);
                return (
                  <g key={wall.id}>
                    <rect
                      x={x}
                      y={yTop}
                      width={width}
                      height={Math.max(1.5, yBottom - yTop)}
                      fill="#d1d5db"
                      fillOpacity={Math.max(0.2, wall.depthAlpha)}
                      stroke="#111827"
                      strokeWidth={1}
                    />
                    {wall.openings.map((opening) => {
                      const ox = Math.min(toPreviewX(opening.xStart), toPreviewX(opening.xEnd));
                      const ow = Math.max(1, Math.abs(toPreviewX(opening.xEnd) - toPreviewX(opening.xStart)));
                      const oyTop = toPreviewY(opening.yTop);
                      const oyBottom = toPreviewY(opening.yBottom);
                      return (
                        <rect
                          key={opening.id}
                          x={ox}
                          y={oyTop}
                          width={ow}
                          height={Math.max(1, oyBottom - oyTop)}
                          fill="#ffffff"
                          stroke="#6b7280"
                          strokeWidth={0.7}
                        />
                      );
                    })}
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-400">No elevation views available</p>
      )}

      {linkedSectionLine && (
        <div className="rounded border border-amber-200/80 bg-amber-50/30 p-2 space-y-1">
          <PropertyRow label="Section">
            <span className="text-xs text-slate-600">{linkedSectionLine.label}</span>
          </PropertyRow>
          <PropertyRow label="Direction">
            <span className="text-sm text-slate-700">{linkedSectionLine.direction === 1 ? 'Forward' : 'Reverse'}</span>
            <button
              type="button"
              onClick={() => flipSectionLineDirection(linkedSectionLine.id)}
              className="rounded border border-amber-200/80 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-amber-50"
            >
              Flip
            </button>
          </PropertyRow>
          <PropertyRow label="Depth">
            <input
              type="number"
              min={100}
              step={100}
              value={Math.round(linkedSectionLine.depthMm)}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (!Number.isFinite(parsed)) return;
                updateSectionLine(linkedSectionLine.id, { depthMm: Math.max(100, parsed) });
              }}
              className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
            />
            <span className="text-xs text-slate-500">mm</span>
          </PropertyRow>
          <PropertyRow label="Locked">
            <input
              type="checkbox"
              checked={linkedSectionLine.locked}
              onChange={(e) => updateSectionLine(linkedSectionLine.id, { locked: e.target.checked })}
            />
          </PropertyRow>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => generateElevationForSection(linkedSectionLine.id)}
              className="flex-1 rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50"
            >
              Regenerate
            </button>
            <button
              type="button"
              onClick={() => deleteSectionLine(linkedSectionLine.id)}
              className="flex-1 rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
            >
              Delete
            </button>
          </div>
        </div>
      )}

      <div className="rounded border border-amber-200/80 bg-white/80 p-2 space-y-1">
        <PropertyRow label="Default Grid">
          <input
            type="number"
            min={100}
            step={100}
            value={Math.round(elevationSettings.defaultGridIncrementMm)}
            onChange={(e) => {
              const parsed = Number.parseFloat(e.target.value);
              if (!Number.isFinite(parsed)) return;
              setElevationSettings({ defaultGridIncrementMm: Math.max(100, parsed) });
            }}
            className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
          />
          <span className="text-xs text-slate-500">mm</span>
        </PropertyRow>
        <PropertyRow label="Default Scale">
          <select
            value={Math.round(elevationSettings.defaultScale)}
            onChange={(e) => {
              const parsed = Number.parseFloat(e.target.value);
              if (!Number.isFinite(parsed)) return;
              setElevationSettings({ defaultScale: Math.max(1, parsed) });
            }}
            className="w-24 px-2 py-1 text-sm border border-amber-200/80 rounded focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white"
          >
            <option value={20}>1:20</option>
            <option value={50}>1:50</option>
            <option value={100}>1:100</option>
            <option value={200}>1:200</option>
          </select>
        </PropertyRow>
        <PropertyRow label="Depth Cueing">
          <input
            type="checkbox"
            checked={elevationSettings.showDepthCueing}
            onChange={(e) => setElevationSettings({ showDepthCueing: e.target.checked })}
          />
        </PropertyRow>
        <PropertyRow label="Reference Lines">
          <input
            type="checkbox"
            checked={wallSettings.showSectionReferenceLines}
            onChange={(e) => setWallSettings({ showSectionReferenceLines: e.target.checked })}
          />
        </PropertyRow>
      </div>
    </div>
  );
}

function wallBounds(wall: Wall): { minX: number; minY: number; maxX: number; maxY: number } {
  const points = [
    wall.interiorLine.start,
    wall.interiorLine.end,
    wall.exteriorLine.start,
    wall.exteriorLine.end,
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function SelectionAlignSection() {
  const { selectedElementIds, walls, updateWall, saveToHistory } = useSmartDrawingStore((state) => ({
    selectedElementIds: state.selectedElementIds,
    walls: state.walls,
    updateWall: state.updateWall,
    saveToHistory: state.saveToHistory,
  }), shallow);
  const selectedWalls = walls.filter((wall) => selectedElementIds.includes(wall.id));

  const translateWall = (wall: Wall, dx: number, dy: number) => {
    updateWall(
      wall.id,
      {
        startPoint: { x: wall.startPoint.x + dx, y: wall.startPoint.y + dy },
        endPoint: { x: wall.endPoint.x + dx, y: wall.endPoint.y + dy },
      },
      { skipHistory: true, source: 'ui' }
    );
  };

  const runAlignment = (action: string, updater: (wallsToAlign: Wall[]) => void) => {
    if (selectedWalls.length < 2) return;
    updater(selectedWalls);
    saveToHistory(action);
  };

  if (selectedWalls.length < 2) {
    return <p className="text-sm text-slate-400">Select at least 2 walls</p>;
  }

  const alignTop = () =>
    runAlignment('Align walls top', (wallsToAlign) => {
      const target = Math.min(...wallsToAlign.map((wall) => wallBounds(wall).minY));
      wallsToAlign.forEach((wall) => {
        const current = wallBounds(wall).minY;
        translateWall(wall, 0, target - current);
      });
    });

  const alignBottom = () =>
    runAlignment('Align walls bottom', (wallsToAlign) => {
      const target = Math.max(...wallsToAlign.map((wall) => wallBounds(wall).maxY));
      wallsToAlign.forEach((wall) => {
        const current = wallBounds(wall).maxY;
        translateWall(wall, 0, target - current);
      });
    });

  const alignLeft = () =>
    runAlignment('Align walls left', (wallsToAlign) => {
      const target = Math.min(...wallsToAlign.map((wall) => wallBounds(wall).minX));
      wallsToAlign.forEach((wall) => {
        const current = wallBounds(wall).minX;
        translateWall(wall, target - current, 0);
      });
    });

  const alignRight = () =>
    runAlignment('Align walls right', (wallsToAlign) => {
      const target = Math.max(...wallsToAlign.map((wall) => wallBounds(wall).maxX));
      wallsToAlign.forEach((wall) => {
        const current = wallBounds(wall).maxX;
        translateWall(wall, target - current, 0);
      });
    });

  const distributeHorizontal = () =>
    runAlignment('Distribute walls horizontally', (wallsToAlign) => {
      if (wallsToAlign.length < 3) return;
      const sorted = [...wallsToAlign].sort(
        (a, b) =>
          (a.startPoint.x + a.endPoint.x) / 2 - (b.startPoint.x + b.endPoint.x) / 2
      );
      const firstCenter = (sorted[0].startPoint.x + sorted[0].endPoint.x) / 2;
      const lastCenter = (sorted[sorted.length - 1].startPoint.x + sorted[sorted.length - 1].endPoint.x) / 2;
      const step = (lastCenter - firstCenter) / (sorted.length - 1);
      for (let i = 1; i < sorted.length - 1; i++) {
        const wall = sorted[i];
        const currentCenter = (wall.startPoint.x + wall.endPoint.x) / 2;
        const targetCenter = firstCenter + step * i;
        translateWall(wall, targetCenter - currentCenter, 0);
      }
    });

  const distributeVertical = () =>
    runAlignment('Distribute walls vertically', (wallsToAlign) => {
      if (wallsToAlign.length < 3) return;
      const sorted = [...wallsToAlign].sort(
        (a, b) =>
          (a.startPoint.y + a.endPoint.y) / 2 - (b.startPoint.y + b.endPoint.y) / 2
      );
      const firstCenter = (sorted[0].startPoint.y + sorted[0].endPoint.y) / 2;
      const lastCenter = (sorted[sorted.length - 1].startPoint.y + sorted[sorted.length - 1].endPoint.y) / 2;
      const step = (lastCenter - firstCenter) / (sorted.length - 1);
      for (let i = 1; i < sorted.length - 1; i++) {
        const wall = sorted[i];
        const currentCenter = (wall.startPoint.y + wall.endPoint.y) / 2;
        const targetCenter = firstCenter + step * i;
        translateWall(wall, 0, targetCenter - currentCenter);
      }
    });

  const buttonClass =
    'rounded border border-amber-200/80 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-amber-50';

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={alignTop} className={buttonClass}>Top</button>
        <button type="button" onClick={alignBottom} className={buttonClass}>Bottom</button>
        <button type="button" onClick={alignLeft} className={buttonClass}>Left</button>
        <button type="button" onClick={alignRight} className={buttonClass}>Right</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={distributeHorizontal} className={buttonClass}>Distribute X</button>
        <button type="button" onClick={distributeVertical} className={buttonClass}>Distribute Y</button>
      </div>
    </div>
  );
}

export function PropertiesPanel({ className = '', onClose }: PropertiesPanelProps) {
  const {
    selectedElementIds,
    clearSelection,
    walls,
    rooms,
    symbols,
    hvacElements,
    dimensions,
    activeTool,
  } = useSmartDrawingStore((state) => ({
    selectedElementIds: state.selectedElementIds,
    clearSelection: state.clearSelection,
    walls: state.walls,
    rooms: state.rooms,
    symbols: state.symbols,
    hvacElements: state.hvacElements,
    dimensions: state.dimensions,
    activeTool: state.activeTool,
  }), shallow);
  const [propertyUnit, setPropertyUnit] = useState<PropertyUnit>('mm');
  const selectedLookup = useMemo(() => new Set(selectedElementIds), [selectedElementIds]);
  const hasSelectedWall = useMemo(
    () => walls.some((wall) => selectedLookup.has(wall.id)),
    [walls, selectedLookup]
  );
  const hasSelectedRoom = useMemo(
    () => rooms.some((room) => selectedLookup.has(room.id)),
    [rooms, selectedLookup]
  );
  const hasSelectedObject = useMemo(
    () => symbols.some((symbol) => selectedLookup.has(symbol.id)),
    [symbols, selectedLookup]
  );
  const hasSelectedHvac = useMemo(
    () => hvacElements.some((element) => selectedLookup.has(element.id)),
    [hvacElements, selectedLookup]
  );
  const hasSelectedDimension = useMemo(
    () => dimensions.some((dimension) => selectedLookup.has(dimension.id)),
    [dimensions, selectedLookup]
  );

  const handleClose = () => {
    clearSelection();
    onClose?.();
  };

  return (
    <div
      className={`flex flex-col rounded-lg border border-amber-200/50 bg-white/95 shadow-sm backdrop-blur-sm ${className}`}
    >
      <div className="flex items-center justify-between border-b border-amber-100/70 px-3 py-2">
        <h3 className="text-xs font-semibold text-slate-700">Properties</h3>
        <button
          onClick={handleClose}
          className="p-1 rounded hover:bg-amber-50 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
        <div className="rounded-lg border border-amber-200/70 bg-white/80 p-2">
          <PropertyRow label="Selected">
            <span className="text-sm text-slate-600">{selectedElementIds.length} element(s)</span>
          </PropertyRow>
        </div>

        <UnitSelector propertyUnit={propertyUnit} onPropertyUnitChange={setPropertyUnit} />

        <CollapsibleSection title="Wall Properties" defaultOpen={hasSelectedWall || activeTool === 'wall' || activeTool === 'partition-wall'}>
          <WallSection propertyUnit={propertyUnit} />
        </CollapsibleSection>

        <CollapsibleSection title="Object Properties" defaultOpen={hasSelectedObject}>
          <ObjectSection propertyUnit={propertyUnit} />
        </CollapsibleSection>

        <CollapsibleSection title="AC Equipment" defaultOpen={hasSelectedHvac}>
          <AcEquipmentSection propertyUnit={propertyUnit} />
        </CollapsibleSection>

        <CollapsibleSection title="Room Properties" defaultOpen={hasSelectedRoom}>
          <RoomSection propertyUnit={propertyUnit} />
        </CollapsibleSection>

        {rooms.length > 0 && (
          <CollapsibleSection title="Room List" defaultOpen={false}>
            <RoomListSection />
          </CollapsibleSection>
        )}

        {(hasSelectedRoom || rooms.length > 0) && (
          <CollapsibleSection title="HVAC Design" defaultOpen={false}>
            <HvacDesignSection />
          </CollapsibleSection>
        )}

        {walls.length > 0 && (
          <CollapsibleSection title="Elevations" defaultOpen={false}>
            <ElevationSection />
          </CollapsibleSection>
        )}

        {(activeTool === 'wall' || activeTool === 'partition-wall' || hasSelectedWall) && (
          <CollapsibleSection title="Wall Tool" defaultOpen={false}>
            <WallToolSection />
          </CollapsibleSection>
        )}

        <CollapsibleSection title="Dimensions" defaultOpen={hasSelectedDimension}>
          <DimensionSection />
        </CollapsibleSection>

        {selectedElementIds.length > 1 && (
          <CollapsibleSection title="Selection Align" defaultOpen={false}>
            <SelectionAlignSection />
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}
