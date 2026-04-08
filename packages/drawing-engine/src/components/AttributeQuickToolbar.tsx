/**
 * Quick-edit toolbar for architectural 3D wall attributes.
 */

'use client';

import React, { useMemo } from 'react';
import { shallow } from 'zustand/shallow';

import {
  DEFAULT_ARCHITECTURAL_MATERIALS,
  getArchitecturalMaterial,
  resolveWallMaterialFromLibrary,
} from '../attributes';
import { useSmartDrawingStore } from '../store';
import { MAX_WALL_THICKNESS, MIN_WALL_THICKNESS } from '../types/wall';

const HEIGHT_PRESETS = [2400, 2700, 3000, 3300];
const THICKNESS_PRESETS = [100, 150, 200, 250];

function PresetButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-md border px-1.5 py-1 text-[11px] font-medium transition-colors ${
        active
          ? 'border-amber-400 bg-amber-200 text-amber-900'
          : 'border-amber-200/80 bg-white text-slate-600 hover:bg-amber-50'
      }`}
    >
      {label}
    </button>
  );
}

export interface AttributeQuickToolbarProps {
  className?: string;
  keepSpaceWhenHidden?: boolean;
}

export function AttributeQuickToolbar({
  className = '',
  keepSpaceWhenHidden = false,
}: AttributeQuickToolbarProps) {
  const {
    activeTool,
    selectedElementIds,
    walls,
    wallSettings,
    setWallSettings,
    setWallPreviewThickness,
    setWallPreviewMaterial,
    updateWall,
    updateWall3DAttributes,
  } = useSmartDrawingStore((state) => ({
    activeTool: state.activeTool,
    selectedElementIds: state.selectedElementIds,
    walls: state.walls,
    wallSettings: state.wallSettings,
    setWallSettings: state.setWallSettings,
    setWallPreviewThickness: state.setWallPreviewThickness,
    setWallPreviewMaterial: state.setWallPreviewMaterial,
    updateWall: state.updateWall,
    updateWall3DAttributes: state.updateWall3DAttributes,
  }), shallow);

  const selectedWall = useMemo(() => {
    if (selectedElementIds.length !== 1) return null;
    const [selectedId] = selectedElementIds;
    return walls.find((wall) => wall.id === selectedId) ?? null;
  }, [selectedElementIds, walls]);

  const visible = activeTool === 'wall' || activeTool === 'partition-wall' || Boolean(selectedWall);
  if (!visible && !keepSpaceWhenHidden) return null;

  const partitionToolActive = activeTool === 'partition-wall';

  const currentMaterialId = selectedWall?.properties3D.materialId ?? '';
  const currentHeight = selectedWall?.properties3D.height ?? wallSettings.defaultHeight;
  const currentThickness = selectedWall?.thickness
    ?? (partitionToolActive ? wallSettings.defaultPartitionThickness : wallSettings.defaultThickness);

  const applyHeightPreset = (heightMm: number) => {
    if (selectedWall) {
      updateWall3DAttributes(selectedWall.id, { height: heightMm });
    } else {
      setWallSettings({ defaultHeight: heightMm });
    }
  };

  const applyThicknessPreset = (thicknessMm: number) => {
    const safeThickness = Math.min(MAX_WALL_THICKNESS, Math.max(MIN_WALL_THICKNESS, thicknessMm));
    if (selectedWall) {
      updateWall(selectedWall.id, { thickness: safeThickness });
    }
    setWallSettings(
      partitionToolActive
        ? { defaultPartitionThickness: safeThickness }
        : { defaultThickness: safeThickness }
    );
    setWallPreviewThickness(safeThickness);
  };

  const applyMaterial = (materialId: string) => {
    const material = getArchitecturalMaterial(materialId);
    if (!material) return;
    if (selectedWall) {
      updateWall3DAttributes(selectedWall.id, {
        materialId,
        thermalResistance: material.thermalResistance,
      });
      updateWall(selectedWall.id, {
        material: resolveWallMaterialFromLibrary(materialId),
      });
    } else {
      setWallSettings({ defaultMaterial: resolveWallMaterialFromLibrary(materialId) });
      setWallPreviewMaterial(resolveWallMaterialFromLibrary(materialId));
    }
  };

  if (!visible) {
    return <div className={`h-full ${className}`} aria-hidden="true" />;
  }

  return (
    <div className={`h-full px-2 ${className}`}>
      <div className="flex h-full items-center gap-1.5 overflow-x-auto whitespace-nowrap scrollbar-thin scrollbar-thumb-amber-300">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Height</span>
        {HEIGHT_PRESETS.map((heightMm) => (
          <PresetButton
            key={heightMm}
            label={`${(heightMm / 1000).toFixed(1)}m`}
            active={Math.abs(currentHeight - heightMm) < 0.1}
            onClick={() => applyHeightPreset(heightMm)}
          />
        ))}
        <PresetButton
          label="Custom"
          active={false}
          onClick={() => {
            const raw = window.prompt('Enter wall height in mm', `${Math.round(currentHeight)}`);
            if (!raw) return;
            const parsed = Number.parseFloat(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) return;
            applyHeightPreset(parsed);
          }}
        />

        <span className="mx-0.5 h-4 w-px bg-amber-200/80" />

        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Material</span>
        {DEFAULT_ARCHITECTURAL_MATERIALS.map((material) => (
          <button
            key={material.id}
            type="button"
            onClick={() => applyMaterial(material.id)}
            title={`${material.name} (${material.defaultThicknessMm}mm, R-${material.thermalResistance})`}
            className={`shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
              currentMaterialId === material.id
                ? 'border-amber-400 bg-amber-200 text-amber-900'
                : 'border-amber-200/80 bg-white text-slate-600 hover:bg-amber-50'
            }`}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full border border-slate-300"
              style={{ backgroundColor: material.color }}
            />
            <span>{material.name}</span>
          </button>
        ))}

        <span className="mx-0.5 h-4 w-px bg-amber-200/80" />

        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Thickness</span>
        {THICKNESS_PRESETS.map((thicknessMm) => (
          <PresetButton
            key={thicknessMm}
            label={`${thicknessMm}mm`}
            active={Math.abs(currentThickness - thicknessMm) < 0.1}
            onClick={() => applyThicknessPreset(thicknessMm)}
          />
        ))}
        <PresetButton
          label="Custom"
          active={false}
          onClick={() => {
            const raw = window.prompt('Enter wall thickness in mm', `${Math.round(currentThickness)}`);
            if (!raw) return;
            const parsed = Number.parseFloat(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) return;
            applyThicknessPreset(parsed);
          }}
        />
      </div>
    </div>
  );
}

export default AttributeQuickToolbar;
