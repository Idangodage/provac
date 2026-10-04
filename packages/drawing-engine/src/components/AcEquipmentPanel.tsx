/**
 * AC equipment toolbox: each category a grid of icon tiles (short name, how
 * many are placed, a ring while placing). Hover or focus a tile for its card:
 * full name, model, size, placement and description. Arrow keys move between
 * tiles; Enter or a click starts placing, again (or Esc on the canvas) stops.
 */

'use client';

import { X } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  AC_EQUIPMENT_CATEGORY_LABELS,
  groupAcEquipmentByCategory,
  type AcEquipmentDefinition,
  type AcEquipmentLibraryCategory,
} from '../data';

import { EQUIPMENT_CATEGORY_ICONS, EquipmentIcon, equipmentIconKind } from './canvas/hvac/equipmentIcons';

export interface AcEquipmentPanelProps {
  className?: string;
  equipment: AcEquipmentDefinition[];
  pendingEquipmentId: string | null;
  /** Placed elements by type (the header total). */
  placedCountByType?: Record<string, number>;
  /** Placed elements by library entry (each tile's badge). */
  placedCountByDefinition?: Record<string, number>;
  roomEquipmentCounts?: Array<{ roomId: string; roomName: string; count: number }>;
  onStartPlacement: (definition: AcEquipmentDefinition) => void;
  onCancelPlacement: () => void;
}

const PLACEMENT_LABELS: Record<AcEquipmentDefinition['placementMode'], string> = {
  wall: 'Wall',
  room: 'Room',
  outdoor: 'Outdoor',
};

const MOUNT_LABELS: Record<string, string> = {
  ceiling: 'ceiling',
  wall: 'wall',
  floor: 'floor',
};

type Tone = 'gas' | 'liquid' | 'supply' | 'return' | null;
const TONE_DOT: Record<Exclude<Tone, null>, string> = {
  gas: 'bg-orange-500',
  liquid: 'bg-blue-600',
  supply: 'bg-blue-700',
  return: 'bg-teal-700',
};

interface TileText {
  title: string;
  caption: string;
  tone: Tone;
}

function terminalOf(definition: AcEquipmentDefinition): { neckDiameterMm?: number; service?: string; filter?: string | null } | null {
  const terminal = definition.defaultProperties?.terminal;
  return terminal && typeof terminal === 'object' ? terminal as { neckDiameterMm?: number; service?: string; filter?: string | null } : null;
}

const SUPPLY_TILE_TITLES: Record<string, string> = { round: 'Round', 'linear-slot': 'Linear slot' };
const RETURN_TILE_TITLES: Record<string, string> = {
  'return-egg-crate': 'Egg-crate', louvred: 'Louvred', perforated: 'Perforated', 'square-4way': 'Square', round: 'Round', 'linear-slot': 'Linear slot',
};

/** The model code of a unit (its label without the brand). */
function modelCode(definition: AcEquipmentDefinition): string {
  const parts = definition.modelLabel.trim().split(/\s+/);
  return parts[parts.length - 1] ?? definition.modelLabel;
}

/** What a tile says: a short name and one caption line (model, neck, line). */
export function equipmentTileText(definition: AcEquipmentDefinition): TileText {
  switch (definition.type) {
    case 'ceiling-cassette-ac': return { title: 'Cassette', caption: modelCode(definition), tone: null };
    case 'wall-mounted-ac': return { title: 'Wall unit', caption: modelCode(definition), tone: null };
    case 'ceiling-suspended-ac': return { title: 'Suspended', caption: modelCode(definition), tone: null };
    case 'ducted-ac': return { title: 'Ducted', caption: modelCode(definition), tone: null };
    case 'outdoor-unit': return { title: 'Outdoor', caption: modelCode(definition), tone: null };
    case 'refrigerant-branch-kit': {
      const liquid = /liquid/i.test(`${definition.subtype} ${definition.modelLabel}`);
      return { title: 'Branch kit', caption: liquid ? 'Liquid' : 'Gas', tone: liquid ? 'liquid' : 'gas' };
    }
    case 'condensate-gully':
      return definition.subtype === 'stack-connection' ? { title: 'Stack', caption: 'Branch + trap', tone: null }
        : definition.subtype === 'external-discharge' ? { title: 'Wall outlet', caption: 'External', tone: null }
          : { title: 'Floor gully', caption: 'Tundish', tone: null };
    case 'diffuser':
    case 'return-grille': {
      // The section header says supply or return; the tile names the face.
      const terminal = terminalOf(definition);
      const neck = terminal?.neckDiameterMm ? `Ø${terminal.neckDiameterMm}` : '';
      const isReturn = definition.type === 'return-grille';
      const tone: Tone = isReturn ? 'return' : 'supply';
      const title = terminal?.filter ? 'Filter grille'
        : isReturn ? RETURN_TILE_TITLES[definition.subtype] ?? 'Return grille'
          : SUPPLY_TILE_TITLES[definition.subtype] ?? 'Square';
      return { title, caption: terminal?.filter ? `${neck} · ${terminal.filter}` : neck, tone };
    }
    default: return { title: definition.name, caption: definition.modelLabel, tone: null };
  }
}

/** Keyboard focus (not a click): the card opens at once. */
function focusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-slate-300 bg-white px-1 font-sans text-[10px] font-medium text-slate-600 shadow-[inset_0_-1px_0_rgba(148,163,184,0.5)]">
      {children}
    </kbd>
  );
}

interface HoverState {
  definition: AcEquipmentDefinition;
  anchor: DOMRect;
}

const CARD_WIDTH = 272;

function EquipmentHoverCard({ hover, placedCount, id }: { hover: HoverState; placedCount: number; id: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(hover.anchor.top);
  const { definition, anchor } = hover;
  const left = Math.max(8, Math.min(anchor.right + 10, window.innerWidth - CARD_WIDTH - 8));
  useLayoutEffect(() => {
    const height = ref.current?.getBoundingClientRect().height ?? 0;
    setTop(Math.max(8, Math.min(anchor.top - 6, window.innerHeight - height - 8)));
  }, [anchor]);
  const text = equipmentTileText(definition);
  return (
    <div ref={ref} id={id} role="tooltip" data-testid="equipment-hover-card" style={{ left, top, width: CARD_WIDTH }}
      className="pointer-events-none fixed z-[1000] rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600 shadow-xl ring-1 ring-black/5">
      <div className="flex items-start gap-2.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-slate-700 ring-1 ring-amber-200/80">
          <EquipmentIcon kind={equipmentIconKind(definition)} size={28} />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-4 text-slate-900">{definition.name}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
            {text.tone ? <span className={`inline-block h-1.5 w-1.5 rounded-full ${TONE_DOT[text.tone]}`} aria-hidden="true" /> : null}
            {definition.modelLabel}
          </p>
        </div>
      </div>
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-slate-400">Size</dt>
        <dd className="text-slate-700">{Math.round(definition.widthMm)} × {Math.round(definition.depthMm)} × {Math.round(definition.heightMm)} mm</dd>
        <dt className="text-slate-400">Placement</dt>
        <dd className="text-slate-700">{PLACEMENT_LABELS[definition.placementMode]}{MOUNT_LABELS[definition.mountType] ? ` · ${MOUNT_LABELS[definition.mountType]} mounted` : ''}</dd>
        <dt className="text-slate-400">Placed</dt>
        <dd className="text-slate-700">{placedCount}</dd>
      </dl>
      <p className="mt-2 leading-4 text-slate-600">{definition.description}</p>
      <p className="mt-2 flex flex-wrap items-center gap-1 border-t border-slate-100 pt-2 text-[10px] text-slate-500">
        <Kbd>Click</Kbd> place <Kbd>R</Kbd> rotate 90° <Kbd>Shift R</Kbd> 15° <Kbd>Esc</Kbd> stop
      </p>
    </div>
  );
}

export function AcEquipmentPanel({
  className = '',
  equipment,
  pendingEquipmentId,
  placedCountByType = {},
  placedCountByDefinition = {},
  roomEquipmentCounts = [],
  onStartPlacement,
  onCancelPlacement,
}: AcEquipmentPanelProps) {
  const grouped = useMemo(() => groupAcEquipmentByCategory(equipment), [equipment]);
  const totalPlaced = Object.values(placedCountByType).reduce((sum, count) => sum + count, 0);
  const pending = pendingEquipmentId ? equipment.find((definition) => definition.id === pendingEquipmentId) ?? null : null;
  const [hover, setHover] = useState<HoverState | null>(null);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardId = 'ac-equipment-hover-card';

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const showCard = useCallback((definition: AcEquipmentDefinition, element: HTMLElement, immediate: boolean) => {
    clearTimer();
    const open = () => setHover({ definition, anchor: element.getBoundingClientRect() });
    if (immediate) open();
    else timer.current = window.setTimeout(open, 320);
  }, []);
  const hideCard = useCallback(() => {
    clearTimer();
    setHover(null);
  }, []);
  useEffect(() => () => clearTimer(), []);

  /** Arrow keys walk the tiles: left/right in order, up/down by rows of the same grid. */
  const onGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const tiles = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-equipment-tile]') ?? []);
    const index = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const current = tiles[index]!;
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowRight') next = tiles[index + 1];
    else if (event.key === 'ArrowLeft') next = tiles[index - 1];
    else if (event.key === 'Home') next = tiles[0];
    else if (event.key === 'End') next = tiles[tiles.length - 1];
    else {
      const down = event.key === 'ArrowDown';
      const x = current.getBoundingClientRect().left;
      const y = current.getBoundingClientRect().top;
      const rows = tiles.filter((tile) => (down ? tile.getBoundingClientRect().top > y + 4 : tile.getBoundingClientRect().top < y - 4));
      const rowTop = rows.length ? (down ? Math.min(...rows.map((tile) => tile.getBoundingClientRect().top)) : Math.max(...rows.map((tile) => tile.getBoundingClientRect().top))) : null;
      if (rowTop !== null) {
        const row = rows.filter((tile) => Math.abs(tile.getBoundingClientRect().top - rowTop) < 4);
        next = row.reduce((best, tile) => (Math.abs(tile.getBoundingClientRect().left - x) < Math.abs(best.getBoundingClientRect().left - x) ? tile : best), row[0]!);
      }
    }
    next?.focus();
  };

  return (
    <div ref={rootRef} className={`h-full overflow-y-auto overflow-x-hidden ${className}`} onScroll={hideCard} data-testid="ac-equipment-panel">
      <div className="space-y-2 p-2.5">
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200/80 bg-white/80 px-2.5 py-2">
          <div className="flex items-baseline gap-1" title="Equipment placed in the drawing">
            <span className="text-base font-semibold tabular-nums text-slate-800">{totalPlaced}</span>
            <span className="text-[11px] text-slate-500">placed</span>
          </div>
          <div className="flex items-center justify-end gap-1 whitespace-nowrap text-[10px] text-slate-500" title="Click a tile, then click the canvas to place it">
            <Kbd>R</Kbd>rotate<span className="text-slate-300" aria-hidden="true">·</span><Kbd>Esc</Kbd>stop
          </div>
        </div>

        {pending ? (
          <div className="flex items-center gap-2 rounded-xl border border-amber-400 bg-amber-100/80 px-2.5 py-1.5 text-xs text-amber-900" role="status">
            <EquipmentIcon kind={equipmentIconKind(pending)} size={18} />
            <span className="min-w-0 flex-1 truncate">Placing <span className="font-medium">{equipmentTileText(pending).title}</span> — click the canvas{pending.placementMode === 'wall' ? ' near a wall' : ''}</span>
            <button type="button" onClick={onCancelPlacement} aria-label="Stop placing" className="rounded p-0.5 text-amber-800 hover:bg-amber-200/70">
              <X size={14} />
            </button>
          </div>
        ) : null}

        {(Object.entries(grouped) as Array<[AcEquipmentLibraryCategory, AcEquipmentDefinition[]]>).map(([category, definitions]) => {
          if (definitions.length === 0) return null;
          const categoryPlaced = definitions.reduce((sum, definition) => sum + (placedCountByDefinition[definition.id] ?? 0), 0);
          return (
            <section key={category} className="rounded-xl border border-amber-200/80 bg-white/80 p-2" aria-label={AC_EQUIPMENT_CATEGORY_LABELS[category]}>
              <header className="mb-1.5 flex items-center gap-1.5 px-0.5 text-slate-600">
                <EquipmentIcon kind={EQUIPMENT_CATEGORY_ICONS[category]} size={14} />
                <span className="text-[11px] font-semibold uppercase tracking-wide">{AC_EQUIPMENT_CATEGORY_LABELS[category]}</span>
                {categoryPlaced ? <span className="ml-auto text-[10px] tabular-nums text-slate-400">{categoryPlaced} placed</span> : null}
              </header>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(68px,1fr))] gap-1.5" onKeyDown={onGridKeyDown}>
                {definitions.map((definition) => {
                  const isActive = pendingEquipmentId === definition.id;
                  const placedCount = placedCountByDefinition[definition.id] ?? 0;
                  const text = equipmentTileText(definition);
                  return (
                    <button
                      key={definition.id}
                      type="button"
                      data-equipment-tile={definition.id}
                      aria-label={definition.name}
                      aria-pressed={isActive}
                      aria-describedby={hover?.definition.id === definition.id ? cardId : undefined}
                      onClick={() => { hideCard(); if (isActive) onCancelPlacement(); else onStartPlacement(definition); }}
                      onMouseEnter={(event) => showCard(definition, event.currentTarget, false)}
                      onMouseLeave={hideCard}
                      onFocus={(event) => { if (focusVisible(event.currentTarget)) showCard(definition, event.currentTarget, true); }}
                      onBlur={hideCard}
                      className={`group relative flex min-h-[74px] flex-col items-center justify-start gap-1 rounded-lg border px-1 pb-1.5 pt-2 text-center outline-none transition-[background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1 ${
                        isActive
                          ? 'border-amber-500 bg-amber-100/80 text-amber-900 shadow-[0_0_0_1px_rgba(245,158,11,0.6)]'
                          : 'border-amber-200/60 bg-white text-slate-700 hover:border-amber-300 hover:bg-amber-50/70 hover:shadow-sm'
                      }`}
                    >
                      {placedCount ? (
                        <span className="absolute right-1 top-1 min-w-[16px] rounded-full bg-slate-700 px-1 text-[9px] font-semibold leading-4 tabular-nums text-white" aria-label={`${placedCount} placed`}>
                          {placedCount}
                        </span>
                      ) : null}
                      <EquipmentIcon kind={equipmentIconKind(definition)} size={26} className={isActive ? 'text-amber-800' : 'text-slate-600 group-hover:text-slate-800'} />
                      <span className="w-full truncate text-[11px] font-medium leading-[14px]">{text.title}</span>
                      {text.caption ? (
                        <span className="flex w-full items-center justify-center gap-1 text-[9.5px] leading-3 text-slate-400">
                          {text.tone ? <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[text.tone]}`} aria-hidden="true" /> : null}
                          <span className="truncate">{text.caption}</span>
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}

        <details className="group rounded-xl border border-amber-200/80 bg-white/80 px-2.5 py-2" open={roomsOpen}
          onToggle={(event) => setRoomsOpen(event.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-600">
            Rooms
            <span className="font-normal normal-case tracking-normal text-slate-400">
              {roomEquipmentCounts.length ? `${roomEquipmentCounts.length} with equipment` : 'none yet'}
            </span>
          </summary>
          {roomEquipmentCounts.length ? (
            <ul className="mt-1.5 space-y-0.5 text-xs text-slate-600">
              {roomEquipmentCounts.slice(0, 12).map((entry) => (
                <li key={entry.roomId} className="flex items-center justify-between gap-2">
                  <span className="truncate">{entry.roomName}</span>
                  <span className="tabular-nums font-medium text-slate-800">{entry.count}</span>
                </li>
              ))}
              {roomEquipmentCounts.length > 12 ? <li className="text-slate-400">+{roomEquipmentCounts.length - 12} more</li> : null}
            </ul>
          ) : (
            <p className="mt-1.5 text-xs text-slate-500">Equipment placed in a room is counted here.</p>
          )}
        </details>
      </div>
      {/* Fixed to the viewport, so the panel's scroll clipping does not cut it. */}
      {hover ? <EquipmentHoverCard hover={hover} id={cardId} placedCount={placedCountByDefinition[hover.definition.id] ?? 0} /> : null}
    </div>
  );
}

export default AcEquipmentPanel;
