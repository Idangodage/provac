/**
 * Architectural object library panel.
 */

'use client';

import {
  ArrowDownAZ,
  Box,
  Download,
  Grid2X2,
  Import,
  List,
  Search,
  Star,
  Upload,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  ARCHITECTURAL_OBJECT_CATEGORIES,
  type ArchitecturalObjectCategory,
  type ArchitecturalObjectDefinition,
  searchArchitecturalObjects,
  sortArchitecturalObjects,
  type ObjectSortMode,
} from '../data';
import {
  hasRenderer,
  renderFurniturePlan,
  renderFurnitureFront,
  renderFurnitureEnd,
  renderFurnitureIso,
} from './canvas/object/FurnitureSymbolRenderer';

export interface ObjectLibraryPanelProps {
  className?: string;
  objects: ArchitecturalObjectDefinition[];
  recentUsage: Record<string, number>;
  pendingObjectId: string | null;
  onStartPlacement: (definition: ArchitecturalObjectDefinition) => void;
  onCancelPlacement: () => void;
  onAddCustomObject: (definition: ArchitecturalObjectDefinition) => void;
  onImportCustomObjects: (definitions: ArchitecturalObjectDefinition[]) => void;
}

function formatSize(definition: ArchitecturalObjectDefinition): string {
  return `${Math.round(definition.widthMm)} x ${Math.round(definition.depthMm)} mm`;
}

function ObjectPreviewGlyph({
  definition,
  className,
}: {
  definition: ArchitecturalObjectDefinition;
  className?: string;
}): React.ReactElement {
  const wallStroke = '#111827';
  const wallFill = '#3f3f46';
  const symbolStroke = '#6b7280';
  const arcStroke = '#2b160b';
  const doorPreviewStrokeWidth = 1.2;
  const wallY = 40;
  const left = 28;
  const right = 72;
  const jambTop = 26;
  const jambBottom = 54;
  const stub = 18;
  const segmentHeight = 8;
  const hatch = '#8f8f92';

  const baseWall = (
    <g>
      <rect
        x={left - stub}
        y={wallY - segmentHeight / 2}
        width={stub}
        height={segmentHeight}
        fill={wallFill}
        stroke={wallStroke}
        strokeWidth="1.2"
      />
      <rect
        x={right}
        y={wallY - segmentHeight / 2}
        width={stub}
        height={segmentHeight}
        fill={wallFill}
        stroke={wallStroke}
        strokeWidth="1.2"
      />
      <line x1={left - stub + 3} y1={wallY - segmentHeight / 2 + 1} x2={left - 3} y2={wallY + segmentHeight / 2 - 1} stroke={hatch} strokeWidth="0.8" />
      <line x1={left - stub + 8} y1={wallY - segmentHeight / 2 + 1} x2={left - 8} y2={wallY + segmentHeight / 2 - 1} stroke={hatch} strokeWidth="0.8" />
      <line x1={right + 3} y1={wallY - segmentHeight / 2 + 1} x2={right + stub - 3} y2={wallY + segmentHeight / 2 - 1} stroke={hatch} strokeWidth="0.8" />
      <line x1={right + 8} y1={wallY - segmentHeight / 2 + 1} x2={right + stub - 8} y2={wallY + segmentHeight / 2 - 1} stroke={hatch} strokeWidth="0.8" />
      <line x1={left} y1={jambTop} x2={left} y2={jambBottom} stroke={wallStroke} strokeWidth="3" />
      <line x1={right} y1={jambTop} x2={right} y2={jambBottom} stroke={wallStroke} strokeWidth="3" />
    </g>
  );

  if (definition.category === 'doors') {
    const type = definition.type;
    if (type === 'double-swing') {
      return (
        <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
          {baseWall}
          <line x1={left} y1={jambTop} x2={50} y2={jambTop} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <line x1={right} y1={jambTop} x2={50} y2={jambTop} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <path d="M 50 26 A 22 22 0 0 1 28 48" fill="none" stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <path d="M 50 26 A 22 22 0 0 0 72 48" fill="none" stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
        </svg>
      );
    }
    if (type === 'sliding') {
      return (
        <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
          {baseWall}
          <line x1={left + 3} y1={34} x2={right - 3} y2={34} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <line x1={left + 3} y1={46} x2={right - 3} y2={46} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <line x1={43} y1={34} x2={37} y2={40} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <line x1={57} y1={46} x2={63} y2={40} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
        </svg>
      );
    }
    if (type === 'bi-fold') {
      return (
        <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
          {baseWall}
          <path d="M 28 26 L 42 40 L 56 26 L 72 40" fill="none" stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <line x1={50} y1={26} x2={50} y2={42} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} strokeDasharray="3 2" />
        </svg>
      );
    }
    if (type === 'overhead') {
      return (
        <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
          {baseWall}
          <rect x={28} y={26} width={44} height={18} fill="none" stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <line x1={39} y1={26} x2={39} y2={44} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <line x1={50} y1={26} x2={50} y2={44} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
          <line x1={61} y1={26} x2={61} y2={44} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
        {baseWall}
        <line x1={left} y1={jambTop} x2={right} y2={jambTop} stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
        <path d="M 72 26 A 44 44 0 0 1 28 70" fill="none" stroke={arcStroke} strokeWidth={doorPreviewStrokeWidth} />
      </svg>
    );
  }

  if (definition.category === 'windows') {
    const type = definition.type;
    if (type === 'sliding') {
      return (
        <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
          {baseWall}
          <line x1={left} y1={34} x2={right} y2={34} stroke={symbolStroke} strokeWidth="1.8" />
          <line x1={left} y1={46} x2={right} y2={46} stroke={symbolStroke} strokeWidth="1.8" />
          <line x1={44} y1={34} x2={44} y2={46} stroke={symbolStroke} strokeWidth="1" />
          <line x1={56} y1={34} x2={56} y2={46} stroke={symbolStroke} strokeWidth="1" />
        </svg>
      );
    }
    if (type === 'fixed') {
      return (
        <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
          {baseWall}
          <line x1={left} y1={34} x2={right} y2={34} stroke={symbolStroke} strokeWidth="1.8" />
          <line x1={left} y1={46} x2={right} y2={46} stroke={symbolStroke} strokeWidth="1.8" />
          <line x1={left} y1={34} x2={right} y2={46} stroke={arcStroke} strokeWidth="1.2" strokeDasharray="3 2" />
          <line x1={right} y1={34} x2={left} y2={46} stroke={arcStroke} strokeWidth="1.2" strokeDasharray="3 2" />
        </svg>
      );
    }
    if (type === 'awning') {
      return (
        <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
          {baseWall}
          <line x1={left} y1={34} x2={right} y2={34} stroke={symbolStroke} strokeWidth="1.8" />
          <line x1={left} y1={46} x2={right} y2={46} stroke={symbolStroke} strokeWidth="1.8" />
          <path d="M 36 46 Q 50 58 64 46" fill="none" stroke={arcStroke} strokeWidth="1.3" />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 100 80" className={className} aria-hidden="true">
        {baseWall}
        <line x1={left} y1={34} x2={right} y2={34} stroke={symbolStroke} strokeWidth="1.8" />
        <line x1={left} y1={46} x2={right} y2={46} stroke={symbolStroke} strokeWidth="1.8" />
        <line x1={50} y1={34} x2={50} y2={46} stroke={symbolStroke} strokeWidth="1" />
      </svg>
    );
  }

  if (definition.symbolPath) {
    return (
      <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
        <path d={definition.symbolPath} fill="none" stroke="#111827" strokeWidth="5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <rect x="14" y="20" width="72" height="60" fill="none" stroke="#111827" strokeWidth="5" />
    </svg>
  );
}

function FurnitureCanvasPreview({
  renderType,
  width,
  height,
  mode = 'plan',
}: {
  renderType: string;
  width: number;
  height: number;
  mode?: PreviewViewMode;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    const pad = 4;
    const drawW = width - pad * 2;
    const drawH = height - pad * 2;
    const cx = width / 2;
    const cy = height / 2;
    if (mode === 'plan') {
      renderFurniturePlan(ctx, renderType, cx, cy, drawW, drawH);
    } else if (mode === 'front') {
      renderFurnitureFront(ctx, renderType, cx, cy, drawW, drawH);
    } else if (mode === 'end') {
      renderFurnitureEnd(ctx, renderType, cx, cy, drawW, drawH);
    } else {
      renderFurnitureIso(ctx, renderType, cx, cy, drawW, drawH, drawH);
    }
    ctx.restore();
  }, [renderType, width, height, mode]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className="rounded"
    />
  );
}

type PreviewViewMode = 'plan' | 'front' | 'end' | 'iso' | '3d';

function Furniture3DPreview({
  renderType,
  width,
  height,
}: {
  renderType: string;
  width: number;
  height: number;
}): React.ReactElement {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadPreview = async () => {
      try {
        const { Furniture3DRenderer } = await import('./canvas/object/three3d');
        if (cancelled) return;
        const renderer = Furniture3DRenderer.getInstance();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const dataURL = renderer.renderToDataURL(renderType, Math.round(width * dpr), Math.round(height * dpr));
        if (!cancelled) {
          setSrc(dataURL);
        }
      } catch {
        if (!cancelled) {
          setSrc(null);
        }
      }
    };

    void loadPreview();

    return () => {
      cancelled = true;
    };
  }, [renderType, width, height]);

  if (!src) {
    return (
      <div
        className="flex items-center justify-center rounded bg-slate-100 text-[10px] text-slate-400"
        style={{ width, height }}
      >
        3D
      </div>
    );
  }

  return (
    <img
      src={src}
      alt="3D preview"
      style={{ width, height }}
      className="rounded object-contain"
    />
  );
}

function downloadTextFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function ObjectLibraryPanel({
  className = '',
  objects,
  recentUsage,
  pendingObjectId,
  onStartPlacement,
  onCancelPlacement,
  onAddCustomObject,
  onImportCustomObjects,
}: ObjectLibraryPanelProps) {
  const [activeCategory, setActiveCategory] = useState<ArchitecturalObjectCategory>('doors');
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<ObjectSortMode>('name');
  const [viewMode, setViewMode] = useState<'thumbnail' | 'list'>('thumbnail');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem('drawing-library-favorites');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setFavorites(new Set(parsed.filter((entry): entry is string => typeof entry === 'string')));
      }
    } catch {
      // Ignore malformed persisted values.
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('drawing-library-favorites', JSON.stringify(Array.from(favorites)));
  }, [favorites]);

  const filteredObjects = useMemo(() => {
    const byCategory = objects.filter((entry) =>
      query.trim().length > 0 ? true : entry.category === activeCategory
    );
    const searched = searchArchitecturalObjects(byCategory, query);
    return sortArchitecturalObjects(searched, sortMode, recentUsage);
  }, [objects, activeCategory, query, sortMode, recentUsage]);

  const selectedDefinition = useMemo(() => {
    const resolved = objects.find((entry) => entry.id === selectedId) ?? null;
    if (resolved) return resolved;
    if (filteredObjects.length > 0) return filteredObjects[0];
    return null;
  }, [objects, selectedId, filteredObjects]);

  const [previewView, setPreviewView] = useState<PreviewViewMode>('plan');

  const toggleFavorite = (definitionId: string): void => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(definitionId)) {
        next.delete(definitionId);
      } else {
        next.add(definitionId);
      }
      return next;
    });
  };

  const handleAddCustomObject = () => {
    if (typeof window === 'undefined') return;
    const name = window.prompt('Custom object name');
    if (!name || !name.trim()) return;
    const widthRaw = window.prompt('Width in mm', '900');
    const depthRaw = window.prompt('Depth in mm', '600');
    const heightRaw = window.prompt('Height in mm', '900');
    const width = Number.parseFloat(widthRaw ?? '');
    const depth = Number.parseFloat(depthRaw ?? '');
    const height = Number.parseFloat(heightRaw ?? '');
    if (!Number.isFinite(width) || !Number.isFinite(depth) || !Number.isFinite(height)) return;

    const customDefinition: ArchitecturalObjectDefinition = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      category: 'my-library',
      type: 'custom',
      widthMm: Math.max(50, width),
      depthMm: Math.max(50, depth),
      heightMm: Math.max(10, height),
      tags: ['custom', 'my-library'],
      symbolPath: 'M 12 12 L 88 12 L 88 88 L 12 88 Z M 12 50 L 88 50 M 50 12 L 50 88',
      view: 'plan-2d',
      material: 'composite',
      hardware: 'none',
      metadata: {
        createdAt: new Date().toISOString(),
      },
    };
    onAddCustomObject(customDefinition);
    setActiveCategory('my-library');
    setSelectedId(customDefinition.id);
  };

  const handleExportCustomObjects = () => {
    const custom = objects.filter((entry) => entry.category === 'my-library');
    downloadTextFile('architectural-library.custom.json', JSON.stringify(custom, null, 2));
  };

  const handleImportCustomObjects = () => {
    if (typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const parsed = JSON.parse(text);
        const rawItems = Array.isArray(parsed) ? parsed : [];
        const imported = rawItems
          .filter((entry): entry is ArchitecturalObjectDefinition => Boolean(entry) && typeof entry === 'object')
          .map((entry, index) => ({
            ...entry,
            id: entry.id || `custom-import-${Date.now()}-${index}`,
            category: 'my-library' as const,
            tags: Array.isArray(entry.tags) ? entry.tags : ['custom', 'imported'],
            widthMm: Math.max(50, Number(entry.widthMm) || 900),
            depthMm: Math.max(50, Number(entry.depthMm) || 600),
            heightMm: Math.max(10, Number(entry.heightMm) || 900),
            view: 'plan-2d' as const,
          }));
        if (imported.length > 0) {
          onImportCustomObjects(imported);
          setActiveCategory('my-library');
        }
      } catch {
        // Ignore malformed imports.
      }
    };
    input.click();
  };

  return (
    <div className={`flex h-full flex-col overflow-hidden bg-[#fbf7ee] ${className}`}>
      <div className="border-b border-amber-200/70 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-semibold text-slate-800">Object Library</h3>
            <p className="text-[10px] text-slate-500">Doors, windows, furniture, fixtures</p>
          </div>
          <button
            type="button"
            onClick={pendingObjectId ? onCancelPlacement : () => selectedDefinition && onStartPlacement(selectedDefinition)}
            className={`rounded border px-2 py-1 text-[11px] ${
              pendingObjectId
                ? 'border-rose-300 bg-rose-50 text-rose-700'
                : 'border-amber-200 bg-white text-slate-700 hover:bg-amber-50'
            }`}
          >
            {pendingObjectId ? 'Cancel' : 'Place'}
          </button>
        </div>

        <div className="mt-2 grid grid-cols-3 gap-1">
          {ARCHITECTURAL_OBJECT_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => setActiveCategory(category.id)}
              className={`rounded border px-1 py-1 text-[10px] ${
                activeCategory === category.id
                  ? 'border-amber-400 bg-amber-200 text-amber-900'
                  : 'border-amber-200 bg-white text-slate-600 hover:bg-amber-50'
              }`}
            >
              {category.label}
            </button>
          ))}
        </div>

        <div className="mt-2 flex gap-1">
          <label className="relative flex-1">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search objects"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full rounded border border-amber-200/80 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-amber-400"
            />
          </label>
          <button
            type="button"
            onClick={() => setViewMode((mode) => (mode === 'thumbnail' ? 'list' : 'thumbnail'))}
            className="rounded border border-amber-200/80 bg-white px-2 text-slate-600 hover:bg-amber-50"
            title="Toggle browser view"
          >
            {viewMode === 'thumbnail' ? <List size={14} /> : <Grid2X2 size={14} />}
          </button>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="inline-flex rounded border border-amber-200/80 bg-white">
            <ArrowDownAZ size={14} className="ml-2 mt-1.5 text-slate-400" />
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as ObjectSortMode)}
              className="rounded-r bg-transparent py-1 pl-1 pr-2 text-xs text-slate-700 focus:outline-none"
            >
              <option value="name">Name</option>
              <option value="type">Type</option>
              <option value="size">Size</option>
              <option value="recent">Recently Used</option>
            </select>
          </div>
          <span className="text-[11px] text-slate-500">{filteredObjects.length} items</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1.5">
        <div className={`grid gap-2 ${viewMode === 'thumbnail' ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {filteredObjects.map((definition) => {
            const favorite = favorites.has(definition.id);
            const isSelected = selectedDefinition?.id === definition.id;
            const isPending = pendingObjectId === definition.id;
            const hasFurnitureRenderer = hasRenderer(definition.renderType);
            const handleSelect = () => {
              setSelectedId(definition.id);
              onStartPlacement(definition);
            };
            return (
              <div
                key={definition.id}
                role="button"
                tabIndex={0}
                onClick={handleSelect}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') {
                    return;
                  }
                  event.preventDefault();
                  handleSelect();
                }}
                className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                  isPending
                    ? 'border-blue-400 bg-blue-50'
                    : isSelected
                      ? 'border-amber-400 bg-amber-100/70'
                      : 'border-amber-200/80 bg-white hover:bg-amber-50'
                } cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300`}
              >
                {hasFurnitureRenderer ? (
                  <div className="relative">
                    <div className="flex items-center justify-center rounded border border-amber-100 bg-[#fff7e6] overflow-hidden" style={{ height: 80 }}>
                      <FurnitureCanvasPreview
                        renderType={definition.renderType!}
                        width={100}
                        height={76}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleFavorite(definition.id);
                      }}
                      className="absolute right-1 top-1 rounded bg-white/80 p-0.5 hover:bg-amber-50"
                      title={favorite ? 'Remove favorite' : 'Add favorite'}
                    >
                      <Star size={12} className={favorite ? 'fill-amber-400 text-amber-500' : 'text-slate-400'} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-1">
                    <div className="inline-flex h-10 w-14 items-center justify-center rounded border border-amber-100 bg-[#fff7e6] overflow-hidden">
                      <ObjectPreviewGlyph definition={definition} className="h-7 w-12" />
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleFavorite(definition.id);
                      }}
                      className="rounded p-0.5 hover:bg-amber-50"
                      title={favorite ? 'Remove favorite' : 'Add favorite'}
                    >
                      <Star size={13} className={favorite ? 'fill-amber-400 text-amber-500' : 'text-slate-400'} />
                    </button>
                  </div>
                )}
                <p className="mt-1 truncate text-[11px] font-medium text-slate-800">{definition.name}</p>
                <p className="text-[10px] text-slate-500">{formatSize(definition)}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-3 rounded border border-amber-200/80 bg-white/80 p-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Box size={13} />
              Preview
            </div>
            {selectedDefinition && hasRenderer(selectedDefinition.renderType) && (
              <div className="inline-flex rounded border border-amber-200/80 bg-white">
                {(['plan', 'front', 'end', 'iso', '3d'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setPreviewView(mode)}
                    className={`px-1.5 py-0.5 text-[10px] capitalize ${
                      previewView === mode
                        ? 'bg-amber-200 text-amber-900'
                        : 'text-slate-500 hover:bg-amber-50'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            )}
          </div>
          {selectedDefinition ? (
            <div className="mt-2">
              {hasRenderer(selectedDefinition.renderType) && (
                <div className="mb-2 flex justify-center rounded border border-amber-100 bg-[#fff7e6] p-2">
                  {previewView === '3d' ? (
                    <Furniture3DPreview
                      renderType={selectedDefinition.renderType!}
                      width={160}
                      height={110}
                    />
                  ) : (
                    <FurnitureCanvasPreview
                      renderType={selectedDefinition.renderType!}
                      width={160}
                      height={110}
                      mode={previewView}
                    />
                  )}
                </div>
              )}
              {!hasRenderer(selectedDefinition.renderType) && (
                <div className="mb-2 flex h-[110px] items-center justify-center rounded border border-amber-100 bg-[#fff7e6] p-2">
                  <ObjectPreviewGlyph definition={selectedDefinition} className="h-16 w-28" />
                </div>
              )}
              <div className="space-y-0.5 text-[11px] text-slate-600">
                <div className="font-medium text-slate-800">{selectedDefinition.name}</div>
                <div>Type: {selectedDefinition.type}</div>
                <div>Size: {formatSize(selectedDefinition)}</div>
                <div>Height: {Math.round(selectedDefinition.heightMm)} mm</div>
                {selectedDefinition.openingWidthMm ? <div>Opening: {Math.round(selectedDefinition.openingWidthMm)} mm</div> : null}
                {selectedDefinition.sillHeightMm ? <div>Sill: {Math.round(selectedDefinition.sillHeightMm)} mm</div> : null}
                {selectedDefinition.uValue ? <div>U-Value: {selectedDefinition.uValue.toFixed(2)}</div> : null}
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-slate-500">Select an object to preview.</p>
          )}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleAddCustomObject}
            className="rounded border border-amber-200/80 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-amber-50"
          >
            Add Custom
          </button>
          <button
            type="button"
            onClick={handleExportCustomObjects}
            className="inline-flex items-center justify-center gap-1 rounded border border-amber-200/80 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-amber-50"
          >
            <Download size={12} />
            Export
          </button>
          <button
            type="button"
            onClick={handleImportCustomObjects}
            className="inline-flex items-center justify-center gap-1 rounded border border-amber-200/80 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-amber-50"
          >
            <Upload size={12} />
            Import
          </button>
          <button
            type="button"
            onClick={() => setSortMode('recent')}
            className="inline-flex items-center justify-center gap-1 rounded border border-amber-200/80 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-amber-50"
          >
            <Import size={12} />
            Recent
          </button>
        </div>
      </div>
    </div>
  );
}


export default ObjectLibraryPanel;
