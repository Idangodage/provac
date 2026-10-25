'use client';

/**
 * The document's unit system for air-side figures (its duct settings), and
 * the formatters bound to it, for the panels and cards that show them.
 */
import { useMemo } from 'react';

import { useSmartDrawingStore } from '../../../../store';

import {
  displayDigits, displayStep, formatNumberIn, formatQuantity, formatSection, fromDisplay, toDisplay, toDisplayText, unitLabel,
  type HvacQuantity, type HvacUnitSystem,
} from './hvacUnits';

export interface HvacUnits {
  system: HvacUnitSystem;
  setSystem: (system: HvacUnitSystem) => void;
  /** "4320" / "2543": the figure alone. */
  num: (kind: HvacQuantity, si: number | null | undefined, digits?: number) => string;
  /** "4320 m³/h" / "2543 CFM". */
  fmt: (kind: HvacQuantity, si: number | null | undefined, digits?: number) => string;
  unit: (kind: HvacQuantity) => string;
  digits: (kind: HvacQuantity) => number;
  step: (kind: HvacQuantity) => number;
  toDisplay: (kind: HvacQuantity, si: number) => number;
  fromDisplay: (kind: HvacQuantity, shown: number) => number;
  /** "600×350" / "24×14", "Ø300" / "Ø12". */
  section: (section: { widthMm: number; heightMm: number; diameterMm?: number }) => string;
  /** An engine message in the display system. */
  text: (message: string) => string;
}

export function useHvacUnitSystem(): HvacUnitSystem {
  return useSmartDrawingStore((state) => state.ductSettings.unitSystem ?? 'si');
}

export function useHvacUnits(): HvacUnits {
  const system = useHvacUnitSystem();
  const setDuctSettings = useSmartDrawingStore((state) => state.setDuctSettings);
  return useMemo<HvacUnits>(() => ({
    system,
    setSystem: (next) => { if (next !== system) setDuctSettings({ unitSystem: next }); },
    num: (kind, si, digits) => formatNumberIn(kind, si, system, digits),
    fmt: (kind, si, digits) => formatQuantity(kind, si, system, digits),
    unit: (kind) => unitLabel(kind, system),
    digits: (kind) => displayDigits(kind, system),
    step: (kind) => displayStep(kind, system),
    toDisplay: (kind, si) => toDisplay(kind, si, system),
    fromDisplay: (kind, shown) => fromDisplay(kind, shown, system),
    section: (section) => formatSection(section, system),
    text: (message) => toDisplayText(message, system),
  }), [system, setDuctSettings]);
}
