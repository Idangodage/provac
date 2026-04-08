/**
 * Formatting Utilities
 * 
 * Display formatting utilities for the drawing canvas.
 * Extracted from DrawingCanvas.tsx for better organization.
 */

import type { DisplayUnit } from '../../types';

import { PX_TO_MM } from './scale';

// =============================================================================
// Unit Formatting
// =============================================================================

export function formatDistance(distanceMm: number, unit: DisplayUnit = 'mm'): string {
    switch (unit) {
        case 'mm':
            return `${Math.round(distanceMm)} mm`;
        case 'cm':
            return `${(distanceMm / 10).toFixed(1)} cm`;
        case 'm':
            return `${(distanceMm / 1000).toFixed(3)} m`;
        case 'ft-in': {
            const inches = distanceMm / 25.4;
            const feet = Math.floor(inches / 12);
            const remainingInches = inches % 12;
            if (feet === 0) {
                return `${remainingInches.toFixed(1)}"`;
            }
            return `${feet}'-${remainingInches.toFixed(1)}"`;
        }
        default:
            return `${Math.round(distanceMm)} mm`;
    }
}

export function formatWallLength(lengthScenePx: number, unit: DisplayUnit = 'mm'): string {
    const mm = lengthScenePx * PX_TO_MM;
    return formatDistance(mm, unit);
}

export function formatRealWallLength(
    lengthScenePx: number,
    paperToRealRatio: number,
    unit: DisplayUnit = 'mm'
): string {
    const safeRatio = Number.isFinite(paperToRealRatio) && paperToRealRatio > 0 ? paperToRealRatio : 1;
    const mm = lengthScenePx * PX_TO_MM * safeRatio;
    return formatDistance(mm, unit);
}

export function formatArea(areaMm2: number, unit: DisplayUnit = 'mm'): string {
    switch (unit) {
        case 'mm':
            return `${Math.round(areaMm2)} mm²`;
        case 'cm':
            return `${(areaMm2 / 100).toFixed(2)} cm²`;
        case 'm':
            return `${(areaMm2 / 1_000_000).toFixed(2)} m²`;
        case 'ft-in': {
            const sqft = areaMm2 / (25.4 * 25.4 * 144);
            return `${sqft.toFixed(2)} ft²`;
        }
        default:
            return `${Math.round(areaMm2)} mm²`;
    }
}

// =============================================================================
// Color Utilities
// =============================================================================

export function normalizeHexColor(value: string, fallback = '#9ca3af'): string {
    if (!value) return fallback;
    const trimmed = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
        const r = trimmed[1];
        const g = trimmed[2];
        const b = trimmed[3];
        if (!r || !g || !b) return fallback;
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return fallback;
}

export function tintHexColor(color: string, amount: number): string {
    const normalized = normalizeHexColor(color);
    const r = Number.parseInt(normalized.slice(1, 3), 16);
    const g = Number.parseInt(normalized.slice(3, 5), 16);
    const b = Number.parseInt(normalized.slice(5, 7), 16);
    const clampChannel = (channel: number) => Math.max(0, Math.min(255, Math.round(channel + amount)));
    return `rgb(${clampChannel(r)}, ${clampChannel(g)}, ${clampChannel(b)})`;
}

export function withPatternAlpha(color: string, alpha: number): string {
    const normalized = normalizeHexColor(color);
    const r = Number.parseInt(normalized.slice(1, 3), 16);
    const g = Number.parseInt(normalized.slice(3, 5), 16);
    const b = Number.parseInt(normalized.slice(5, 7), 16);
    const safeAlpha = Math.max(0, Math.min(alpha, 1));
    return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
}
