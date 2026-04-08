/**
 * Store Defaults
 * 
 * Default values and constants for the drawing store.
 * Extracted for cleaner organization and reusability.
 */

import type { PageConfig, DrawingLayer } from '../types';

// =============================================================================
// Page Configuration Defaults
// =============================================================================

export const DEFAULT_PAGE_CONFIG: PageConfig = {
    // A3 landscape at 96 DPI
    width: 1587,
    height: 1122,
    orientation: 'landscape',
};

// =============================================================================
// Layer Defaults
// =============================================================================

export const DEFAULT_LAYERS: DrawingLayer[] = [
    { id: 'default', name: 'Default', visible: true, locked: false, opacity: 1, elements: [] },
    { id: 'imported', name: 'Imported Drawing', visible: true, locked: true, opacity: 0.5, elements: [] },
    { id: 'detected', name: 'AI Detected', visible: true, locked: false, opacity: 0.8, elements: [] },
];
