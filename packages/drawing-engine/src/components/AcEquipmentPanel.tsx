/**
 * AC equipment planning panel.
 */

'use client';

import {
  Fan,
  Filter,
  LayoutGrid,
  MonitorSmartphone,
  PanelTop,
  Radio,
  SlidersHorizontal,
  Snowflake,
  Wind,
} from 'lucide-react';
import React, { useMemo } from 'react';

import {
  AC_EQUIPMENT_CATEGORY_LABELS,
  groupAcEquipmentByCategory,
  type AcEquipmentDefinition,
} from '../data';

export interface AcEquipmentPanelProps {
  className?: string;
  equipment: AcEquipmentDefinition[];
  pendingEquipmentId: string | null;
  placedCountByType?: Record<string, number>;
  roomEquipmentCounts?: Array<{ roomId: string; roomName: string; count: number }>;
  onStartPlacement: (definition: AcEquipmentDefinition) => void;
  onCancelPlacement: () => void;
}

function categoryIcon(definition: AcEquipmentDefinition): React.ReactNode {
  switch (definition.type) {
    case 'ceiling-cassette-ac':
      return <LayoutGrid size={16} />;
    case 'wall-mounted-ac':
      return <PanelTop size={16} />;
    case 'ceiling-suspended-ac':
      return <Wind size={16} />;
    case 'ducted-ac':
      return <Fan size={16} />;
    case 'outdoor-unit':
      return <Snowflake size={16} />;
    case 'filter':
      return <Filter size={16} />;
    case 'control-panel':
      return <MonitorSmartphone size={16} />;
    case 'remote-controller':
      return <Radio size={16} />;
    default:
      return <SlidersHorizontal size={16} />;
  }
}

function placementLabel(definition: AcEquipmentDefinition): string {
  switch (definition.placementMode) {
    case 'wall':
      return 'Wall';
    case 'outdoor':
      return 'Outdoor';
    case 'room':
    default:
      return 'Room';
  }
}

export function AcEquipmentPanel({
  className = '',
  equipment,
  pendingEquipmentId,
  placedCountByType = {},
  roomEquipmentCounts = [],
  onStartPlacement,
  onCancelPlacement,
}: AcEquipmentPanelProps) {
  const grouped = useMemo(() => groupAcEquipmentByCategory(equipment), [equipment]);
  const totalPlaced = Object.values(placedCountByType).reduce((sum, count) => sum + count, 0);

  return (
    <div className={`h-full overflow-y-auto overflow-x-hidden ${className}`}>
      <div className="space-y-2.5 p-2.5">
        <div className="rounded-xl border border-amber-200/80 bg-white/80 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">AC Equipment Mode</p>
          <p className="mt-2 text-xs leading-5 text-slate-600">
            Select a unit, then place it on the drawing canvas. Wall units snap to nearby room walls.
          </p>
          <div className="mt-3 flex items-center justify-between rounded-lg border border-amber-200/70 bg-amber-50/50 px-3 py-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Placed Equipment</div>
              <div className="text-lg font-semibold text-slate-800">{totalPlaced}</div>
            </div>
            <div className="text-right text-[11px] text-slate-500">
              <div>Click canvas to place</div>
              <div>Press R to rotate</div>
            </div>
          </div>
        </div>

        {Object.entries(grouped).map(([category, definitions]) => {
          if (definitions.length === 0) return null;
          return (
            <div key={category} className="rounded-xl border border-amber-200/80 bg-white/80 p-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                {AC_EQUIPMENT_CATEGORY_LABELS[category as keyof typeof AC_EQUIPMENT_CATEGORY_LABELS]}
              </p>
              <div className="mt-2 space-y-2">
                {definitions.map((definition) => {
                  const isActive = pendingEquipmentId === definition.id;
                  const placedCount = placedCountByType[definition.type] ?? 0;
                  return (
                    <button
                      key={definition.id}
                      type="button"
                      onClick={() => (isActive ? onCancelPlacement() : onStartPlacement(definition))}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                        isActive
                          ? 'border-amber-400 bg-amber-100/80'
                          : 'border-amber-200/70 bg-white hover:bg-amber-50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-2">
                          <span className={`mt-0.5 ${isActive ? 'text-amber-800' : 'text-slate-600'}`}>
                            {categoryIcon(definition)}
                          </span>
                          <div>
                            <div className="text-sm font-medium text-slate-800">{definition.name}</div>
                            <div className="text-[11px] text-slate-500">{definition.modelLabel}</div>
                          </div>
                        </div>
                        <span className="rounded-full border border-amber-200/70 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                          {placementLabel(definition)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                        <span>
                          {Math.round(definition.widthMm)} x {Math.round(definition.depthMm)} mm
                        </span>
                        <span>{placedCount} placed</span>
                      </div>
                      <p className="mt-2 text-[11px] leading-4 text-slate-600">{definition.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div className="rounded-xl border border-amber-200/80 bg-white/80 p-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Room Counts</p>
          {roomEquipmentCounts.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">No room-linked equipment placed yet.</p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {roomEquipmentCounts.slice(0, 8).map((entry) => (
                <div
                  key={entry.roomId}
                  className="flex items-center justify-between rounded-md border border-amber-200/60 bg-amber-50/40 px-2.5 py-1.5 text-xs text-slate-600"
                >
                  <span className="truncate pr-3">{entry.roomName}</span>
                  <span className="font-medium text-slate-800">{entry.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AcEquipmentPanel;
