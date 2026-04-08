/**
 * SelectionModel
 *
 * Typed, priority-aware selection system for the building editor.
 * Works alongside (not replacing) the existing flat selectedElementIds
 * array, providing semantic understanding of what is selected.
 *
 * Key responsibilities:
 * - Track selection entries with their kinds
 * - Handle room selection (with implicit wall tracking)
 * - Resolve click priority when geometry overlaps
 * - Support Shift+Click additive/toggle selection
 */

import type { Point2D, Bounds, Room, Wall, SymbolInstance2D } from '../types';
import { GeometryEngine } from '../utils/geometry-engine';

// =============================================================================
// Types
// =============================================================================

export type SelectionKind =
  | 'wall'
  | 'room'
  | 'symbol'
  | 'dimension'
  | 'annotation'
  | 'sketch'
  | 'section-line'
  | 'hvac';

export interface SelectionEntry {
  id: string;
  kind: SelectionKind;
  /** When a room is selected, these are the wall IDs implicitly included */
  implicitWallIds?: string[];
}

export interface SelectionState {
  entries: SelectionEntry[];

  // Computed views
  primaryEntry: SelectionEntry | null;
  allWallIds: string[];
  allRoomIds: string[];
  allSymbolIds: string[];
  selectionBounds: Bounds | null;
}

// =============================================================================
// Priority
// =============================================================================

/**
 * Click priority for overlapping elements (1 = highest).
 */
const PRIORITY_MAP: Record<string, number> = {
  'grip': 1,
  'symbol': 2,
  'wall': 3,
  'room': 4,
  'dimension': 5,
  'section-line': 5,
  'annotation': 5,
  'sketch': 6,
  'hvac': 5,
  'empty': 99,
};

export interface HitTestCandidate {
  id: string;
  kind: SelectionKind;
  /** If this is a room, provide wallIds for implicit tracking */
  wallIds?: string[];
}

// =============================================================================
// SelectionModel class
// =============================================================================

export class SelectionModel {
  private _entries: SelectionEntry[] = [];

  // ---- Static factory -------------------------------------------------------

  static empty(): SelectionModel {
    return new SelectionModel();
  }

  static fromIds(
    ids: string[],
    walls: Wall[],
    rooms: Room[],
  ): SelectionModel {
    const model = new SelectionModel();
    const wallIdSet = new Set(walls.map((w) => w.id));
    const roomMap = new Map(rooms.map((r) => [r.id, r]));

    for (const id of ids) {
      if (wallIdSet.has(id)) {
        model._addEntry({ id, kind: 'wall' });
      } else if (roomMap.has(id)) {
        const room = roomMap.get(id)!;
        model._addEntry({
          id,
          kind: 'room',
          implicitWallIds: [...room.wallIds],
        });
      } else {
        // Try to identify kind heuristically
        model._addEntry({ id, kind: 'symbol' });
      }
    }

    return model;
  }

  // ---- Core state -----------------------------------------------------------

  get entries(): SelectionEntry[] {
    return this._entries;
  }

  get state(): SelectionState {
    const entries = this._entries;
    return {
      entries,
      primaryEntry: entries.length > 0 ? entries[0] : null,
      allWallIds: this.getAllWallIds(),
      allRoomIds: entries.filter((e) => e.kind === 'room').map((e) => e.id),
      allSymbolIds: entries.filter((e) => e.kind === 'symbol').map((e) => e.id),
      selectionBounds: null, // computed lazily by consumers
    };
  }

  get isEmpty(): boolean {
    return this._entries.length === 0;
  }

  get count(): number {
    return this._entries.length;
  }

  // ---- Queries --------------------------------------------------------------

  isSelected(id: string): boolean {
    return this._entries.some((e) => e.id === id);
  }

  isImplicitlySelected(id: string): boolean {
    return this._entries.some((e) =>
      e.implicitWallIds?.includes(id) ?? false,
    );
  }

  isSelectedOrImplicit(id: string): boolean {
    return this.isSelected(id) || this.isImplicitlySelected(id);
  }

  getEntry(id: string): SelectionEntry | undefined {
    return this._entries.find((e) => e.id === id);
  }

  getEntriesByKind(kind: SelectionKind): SelectionEntry[] {
    return this._entries.filter((e) => e.kind === kind);
  }

  /**
   * Get all wall IDs including both explicit and implicit (from room selection).
   */
  getAllWallIds(): string[] {
    const ids = new Set<string>();
    for (const entry of this._entries) {
      if (entry.kind === 'wall') {
        ids.add(entry.id);
      }
      if (entry.implicitWallIds) {
        for (const wid of entry.implicitWallIds) {
          ids.add(wid);
        }
      }
    }
    return Array.from(ids);
  }

  /**
   * Get the flat list of element IDs (for backward compatibility with selectedElementIds).
   */
  toFlatIds(): string[] {
    return this._entries.map((e) => e.id);
  }

  // ---- Mutations (return new model) -----------------------------------------

  /**
   * Select an element. If additive is false, replaces entire selection.
   */
  select(candidate: HitTestCandidate, additive: boolean): SelectionModel {
    const next = new SelectionModel();

    if (additive) {
      // Toggle behavior: if already selected, remove it
      if (this.isSelected(candidate.id)) {
        next._entries = this._entries.filter((e) => e.id !== candidate.id);
        return next;
      }

      // Add to existing selection
      next._entries = [...this._entries];
      next._addEntry(this._buildEntry(candidate));
    } else {
      // Replace selection
      next._addEntry(this._buildEntry(candidate));
    }

    return next;
  }

  /**
   * Select a room, including its walls as implicit selections.
   */
  selectRoom(roomId: string, wallIds: string[], additive: boolean): SelectionModel {
    return this.select(
      { id: roomId, kind: 'room', wallIds },
      additive,
    );
  }

  /**
   * Select multiple elements at once (e.g., marquee selection).
   */
  selectMultiple(candidates: HitTestCandidate[]): SelectionModel {
    const next = new SelectionModel();
    for (const candidate of candidates) {
      next._addEntry(this._buildEntry(candidate));
    }
    return next;
  }

  /**
   * Deselect a specific element.
   */
  deselect(id: string): SelectionModel {
    const next = new SelectionModel();
    next._entries = this._entries.filter((e) => e.id !== id);
    return next;
  }

  /**
   * Clear all selections.
   */
  clear(): SelectionModel {
    return SelectionModel.empty();
  }

  // ---- Priority resolution --------------------------------------------------

  /**
   * From a list of candidates at a click point, pick the highest priority.
   */
  static resolveClickPriority(candidates: HitTestCandidate[]): HitTestCandidate | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    return candidates.reduce((best, candidate) => {
      const bestPri = PRIORITY_MAP[best.kind] ?? 99;
      const candidatePri = PRIORITY_MAP[candidate.kind] ?? 99;
      return candidatePri < bestPri ? candidate : best;
    });
  }

  // ---- Handle exposure rules ------------------------------------------------

  /**
   * Determine which handle categories should be shown for the current selection.
   */
  getVisibleHandleCategories(): HandleCategory[] {
    const categories: HandleCategory[] = [];

    const wallEntries = this.getEntriesByKind('wall');
    const roomEntries = this.getEntriesByKind('room');

    if (roomEntries.length === 1 && wallEntries.length === 0) {
      // Single room selected
      categories.push(
        'room-center-move',
        'room-corner',
        'room-edge-midpoint',
        'room-scale',
      );
    } else if (roomEntries.length > 0 && wallEntries.length > 0) {
      // Room + explicit walls: room handles take precedence
      categories.push('room-center-move', 'room-corner');
    } else if (wallEntries.length === 1) {
      // Single wall selected
      categories.push(
        'wall-endpoint',
        'wall-center-move',
        'wall-thickness',
        'wall-rotation',
      );
    } else if (wallEntries.length > 1) {
      // Multi-wall selected
      categories.push('wall-center-move');
      // Only show shared endpoints if same room
      if (this._wallsInSameRoom(wallEntries)) {
        categories.push('wall-endpoint');
      }
    }

    return categories;
  }

  // ---- Internal helpers -----------------------------------------------------

  private _addEntry(entry: SelectionEntry): void {
    // Prevent duplicate IDs
    if (!this._entries.some((e) => e.id === entry.id)) {
      this._entries.push(entry);
    }
  }

  private _buildEntry(candidate: HitTestCandidate): SelectionEntry {
    const entry: SelectionEntry = {
      id: candidate.id,
      kind: candidate.kind,
    };
    if (candidate.kind === 'room' && candidate.wallIds) {
      entry.implicitWallIds = [...candidate.wallIds];
    }
    return entry;
  }

  private _wallsInSameRoom(entries: SelectionEntry[]): boolean {
    // Check if a single room contains all the selected walls
    for (const entry of this._entries) {
      if (entry.kind === 'room' && entry.implicitWallIds) {
        const implicitSet = new Set(entry.implicitWallIds);
        if (entries.every((e) => implicitSet.has(e.id))) {
          return true;
        }
      }
    }
    return false;
  }
}

// =============================================================================
// Handle category types
// =============================================================================

export type HandleCategory =
  | 'wall-endpoint'
  | 'wall-center-move'
  | 'wall-thickness'
  | 'wall-rotation'
  | 'room-center-move'
  | 'room-corner'
  | 'room-edge-midpoint'
  | 'room-scale'
  | 'room-rotation';
