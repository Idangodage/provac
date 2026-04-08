/**
 * Symbol Palette Component
 * 
 * Displays available HVAC symbols for drag-and-drop onto the canvas.
 */

'use client';

import { Search, ChevronRight, ChevronDown, GripVertical } from 'lucide-react';
import React, { useState, useMemo } from 'react';

import {
  SYMBOL_LIBRARY,
  SYMBOL_CATEGORIES,
  getSymbolsByCategory,
  searchSymbols,
  type SymbolDefinition,
  type SymbolCategory,
} from '../data/symbol-library';

// =============================================================================
// Types
// =============================================================================

export interface SymbolPaletteProps {
  className?: string;
  variant?: 'panel' | 'embedded';
  onSymbolSelect?: (symbol: SymbolDefinition) => void;
  onSymbolDragStart?: (symbol: SymbolDefinition, event: React.DragEvent) => void;
}

// =============================================================================
// Symbol Item Component
// =============================================================================

function SymbolItem({
  symbol,
  onSelect,
  onDragStart,
}: {
  symbol: SymbolDefinition;
  onSelect?: (symbol: SymbolDefinition) => void;
  onDragStart?: (symbol: SymbolDefinition, event: React.DragEvent) => void;
}) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify(symbol));
    e.dataTransfer.effectAllowed = 'copy';
    onDragStart?.(symbol, e);
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={() => onSelect?.(symbol)}
      className="
        flex items-center gap-2 p-1.5
        bg-white border border-amber-200/70 rounded-lg
        cursor-grab active:cursor-grabbing
        hover:border-amber-300 hover:bg-amber-50
        transition-colors shadow-sm
      "
    >
      {/* Symbol Preview */}
      <div className="flex h-8 w-8 items-center justify-center rounded border border-amber-100 bg-[#fff7e6]">
        <svg
          width="26"
          height="26"
          viewBox="0 0 100 100"
          className="text-slate-700"
        >
          <path
            d={symbol.svgPath}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      </div>

      {/* Symbol Info */}
      <div className="flex-1 min-w-0">
        <p className="truncate text-xs font-medium text-slate-800">
          {symbol.name}
        </p>
        <p className="truncate text-[10px] text-slate-500">
          {symbol.defaultWidth}m x {symbol.defaultHeight}m
        </p>
      </div>

      {/* Drag Handle */}
      <GripVertical size={16} className="text-slate-400" />
    </div>
  );
}

// =============================================================================
// Category Section Component
// =============================================================================

function CategorySection({
  category,
  symbols,
  isExpanded,
  onToggle,
  onSymbolSelect,
  onSymbolDragStart,
}: {
  category: { id: SymbolCategory; label: string };
  symbols: SymbolDefinition[];
  isExpanded: boolean;
  onToggle: () => void;
  onSymbolSelect?: (symbol: SymbolDefinition) => void;
  onSymbolDragStart?: (symbol: SymbolDefinition, event: React.DragEvent) => void;
}) {
  return (
    <div className="border-b border-amber-100/70 last:border-0">
      {/* Category Header */}
      <button
        onClick={onToggle}
        className="
          flex items-center justify-between w-full
          px-3 py-2
          text-left text-xs font-semibold text-slate-700
          hover:bg-amber-50
          transition-colors
        "
      >
        <span>{category.label}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{symbols.length}</span>
          {isExpanded ? (
            <ChevronDown size={16} className="text-slate-400" />
          ) : (
            <ChevronRight size={16} className="text-slate-400" />
          )}
        </div>
      </button>

      {/* Category Content */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-2">
          {symbols.map((symbol) => (
            <SymbolItem
              key={symbol.id}
              symbol={symbol}
              onSelect={onSymbolSelect}
              onDragStart={onSymbolDragStart}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// SymbolPalette Component
// =============================================================================

export function SymbolPalette({
  className = '',
  variant = 'panel',
  onSymbolSelect,
  onSymbolDragStart,
}: SymbolPaletteProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<SymbolCategory>>(
    new Set(['indoor-units'])
  );

  // Filter symbols based on search
  const filteredSymbols = useMemo(() => {
    if (!searchQuery.trim()) {
      return null; // Show categories when not searching
    }
    return searchSymbols(searchQuery);
  }, [searchQuery]);

  const toggleCategory = (categoryId: SymbolCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  return (
    <div
      className={`
        flex flex-col
        ${variant === 'panel' ? 'w-64 bg-[#fffaf0] border-r border-amber-200/70' : 'w-full bg-transparent'}
        ${className}
      `}
    >
      {/* Header */}
      <div className="border-b border-amber-200/70 px-3 py-2">
        <h2 className="mb-2 text-xs font-semibold text-slate-800">Symbols</h2>
        
        {/* Search */}
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="text"
            placeholder="Search symbols..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="
              w-full py-1.5 pl-8 pr-3
              text-xs
              border border-amber-200/80 rounded-md
              bg-white placeholder:text-slate-400
              focus:outline-none focus:ring-1 focus:ring-amber-400 focus:border-amber-400
            "
          />
        </div>
      </div>

      {/* Symbol List */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-amber-300">
        {filteredSymbols ? (
          // Search Results
          <div className="p-2 space-y-1.5">
            {filteredSymbols.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-500">
                No symbols found
              </p>
            ) : (
              filteredSymbols.map((symbol) => (
                <SymbolItem
                  key={symbol.id}
                  symbol={symbol}
                  onSelect={onSymbolSelect}
                  onDragStart={onSymbolDragStart}
                />
              ))
            )}
          </div>
        ) : (
          // Category View
          SYMBOL_CATEGORIES.map((category) => {
            const symbols = getSymbolsByCategory(category.id);
            if (symbols.length === 0) return null;

            return (
              <CategorySection
                key={category.id}
                category={category}
                symbols={symbols}
                isExpanded={expandedCategories.has(category.id)}
                onToggle={() => toggleCategory(category.id)}
                onSymbolSelect={onSymbolSelect}
                onSymbolDragStart={onSymbolDragStart}
              />
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-amber-200/70">
        <p className="text-xs text-slate-500">
          {SYMBOL_LIBRARY.length} symbols available
        </p>
      </div>
    </div>
  );
}

export default SymbolPalette;
