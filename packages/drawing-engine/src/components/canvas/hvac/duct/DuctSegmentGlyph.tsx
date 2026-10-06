'use client';

/**
 * Small line pictures of duct shapes and fittings for the segment card: what
 * an option would put there, read at a glance (the words say it too, so the
 * picture is decoration for assistive technology).
 */
import type { DuctOptionGlyph } from './ductSegmentOptions';

const PATHS: Record<DuctOptionGlyph, string> = {
  rect: 'M3 7h14v6H3z',
  round: 'M10 4a6 6 0 1 0 0.01 0z',
  'elbow-radius': 'M3 6h4a7 7 0 0 1 7 7v4 M3 11h4a2 2 0 0 1 2 2v4',
  'elbow-vaned': 'M3 5h12v12 M3 11h6v6 M8 6.5a3 3 0 0 1 3 3 M11 8.5a3 3 0 0 1 3 3',
  'elbow-gored': 'M3 6h4l4 1.5l3 3l1.5 4v2.5 M3 11h3l2 0.8l1.6 1.6l0.8 2v1.6',
  taper: 'M3 6l14 2.5v3L3 14z',
  'tap-shoe': 'M2 12h16 M2 16h16 M7 12l3-5h5v5',
  'tap-straight': 'M2 12h16 M2 16h16 M7 12V5 M13 12V5',
  'tap-spin': 'M2 12h16 M2 16h16 M7.5 12V6h5v6 M7 7h6',
  'tap-conical': 'M2 12h16 M2 16h16 M6 12l2-5h4l2 5',
  'tap-tee': 'M3 13a5 5 0 1 0 10 0a5 5 0 1 0-10 0 M13 11h5 M13 15h5',
  'tap-lateral': 'M2 12h16 M2 16h16 M6 12l5-6h4 M10 12l5-4',
  'split-y': 'M2 8h6l5-4h5 M2 13h6l5 4h5 M10 10.5h2',
  'split-bullhead': 'M2 8h7v-4 M2 13h7v4 M9 4h9 M9 17h9 M18 4v13',
  damper: 'M2 6h16 M2 14h16 M6 13l8-6 M14 4.5v-2',
  connector: 'M2 6h4 M2 14h4 M14 6h4 M14 14h4 M6 6l2 8l2-8l2 8l2-8',
  'fire-damper': 'M5 4h10v12H5z M5 16L15 4',
  cap: 'M2 6h12 M2 14h12 M14 5v10',
  open: 'M2 6h14 M2 14h14',
};

export function DuctSegmentGlyph({ glyph, className }: { glyph: DuctOptionGlyph; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" width={20} height={20} className={className} aria-hidden="true" focusable="false">
      <path d={PATHS[glyph]} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
