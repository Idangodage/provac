/**
 * Board store — Zustand + Immer with a patch-based command/undo stack.
 *
 * Undo granularity: the DOCUMENT (runs + kits + connections + selection) is
 * undoable. View (zoom/pan), the active tool, and slider values are UI state and
 * never touch the undo stack. Each undoable mutation goes through `commit(label,
 * recipe)`, which records the Immer patches + their inverse so undo/redo restores
 * geometry AND topology AND selection exactly.
 */

import { create } from 'zustand';
import {
  applyPatches,
  enablePatches,
  produceWithPatches,
  type Patch,
} from 'immer';

import {
  emptyDoc,
  PIPE_SIZES,
  type BoardDoc,
  type LineFilter,
  type PipeSize,
  type Tool,
} from './types';
import type { ViewTransform } from '../geometry/transform';
import { identityView } from '../geometry/transform';
import { clampBendRadius } from '../geometry/bend';

enablePatches();

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
}

export interface BoardState {
  /** Undoable document. */
  doc: BoardDoc;

  /** View + tool + tool settings — NOT undoable. */
  view: ViewTransform;
  tool: Tool;
  /** Requested spine bend radius — always kept legal (clamped, invariants C+D). */
  bendRadiusMm: number;
  pipeGapMm: number;
  lineFilter: LineFilter;
  activeSize: PipeSize;
  /** Set when the last bend-radius/gap/size change forced a clamp; else null. */
  bendWarning: string | null;

  past: HistoryEntry[];
  future: HistoryEntry[];

  /** Apply an undoable change; empty recipes are ignored. */
  commit: (label: string, recipe: (doc: BoardDoc) => void) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  setView: (v: ViewTransform) => void;
  setTool: (t: Tool) => void;
  setBendRadiusMm: (mm: number) => void;
  setPipeGapMm: (mm: number) => void;
  setLineFilter: (f: LineFilter) => void;
  setActiveSize: (s: PipeSize) => void;

  /** Selection is document state (restored by undo) but changing it directly is
   *  not itself an undo step — use commit() when a geometry edit also selects. */
  setSelection: (ids: string[]) => void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  doc: emptyDoc(),

  view: identityView(),
  tool: 'select',
  bendRadiusMm: 200,
  pipeGapMm: 30,
  lineFilter: 'both',
  activeSize: PIPE_SIZES[1]!,
  bendWarning: null,

  past: [],
  future: [],

  commit: (label, recipe) =>
    set((state) => {
      const [nextDoc, patches, inverse] = produceWithPatches(state.doc, recipe);
      if (patches.length === 0) return {};
      return {
        doc: nextDoc,
        past: [...state.past, { label, patches, inverse }],
        future: [],
      };
    }),

  undo: () =>
    set((state) => {
      const entry = state.past[state.past.length - 1];
      if (!entry) return {};
      return {
        doc: applyPatches(state.doc, entry.inverse),
        past: state.past.slice(0, -1),
        future: [entry, ...state.future],
      };
    }),

  redo: () =>
    set((state) => {
      const entry = state.future[0];
      if (!entry) return {};
      return {
        doc: applyPatches(state.doc, entry.patches),
        past: [...state.past, entry],
        future: state.future.slice(1),
      };
    }),

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  setView: (view) => set({ view }),
  setTool: (tool) => set({ tool }),
  // Bend radius, gap and size all feed the C+D clamp: keep bendRadiusMm legal
  // against the CURRENT size + gap, and surface the warning when it had to move.
  setBendRadiusMm: (requested) =>
    set((s) => {
      const c = clampBendRadius(requested, s.activeSize, s.pipeGapMm);
      return { bendRadiusMm: c.value, bendWarning: c.warning ?? null };
    }),
  setPipeGapMm: (pipeGapMm) =>
    set((s) => {
      const c = clampBendRadius(s.bendRadiusMm, s.activeSize, pipeGapMm);
      return { pipeGapMm, bendRadiusMm: c.value, bendWarning: c.warning ?? null };
    }),
  setLineFilter: (lineFilter) => set({ lineFilter }),
  setActiveSize: (activeSize) =>
    set((s) => {
      const c = clampBendRadius(s.bendRadiusMm, activeSize, s.pipeGapMm);
      return { activeSize, bendRadiusMm: c.value, bendWarning: c.warning ?? null };
    }),

  setSelection: (ids) =>
    set((state) => ({ doc: { ...state.doc, selection: ids } })),
}));

// Re-export so callers importing the store need not reach into types for these.
export { PIPE_SIZES };
