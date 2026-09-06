import { getActivePipeRoutingSettings } from './pipeRoutingSettings';

/** Copper-to-copper capillary elbows. Dimensions are millimetres of actual
 * tube OD, never plumbing nominal size. These profiles describe geometry;
 * product/system qualification is deliberately not inferred from a shape. */
export interface CopperSocketElbowSpec {
  id: string;
  angleDeg: 45 | 90;
  tubeOutsideDiameterMm: number;
  socketInsideDiameterMm: number;
  socketOutsideDiameterMm: number;
  bodyOutsideDiameterMm: number;
  bodyInsideDiameterMm: number;
  centerlineRadiusMm: number;
  centerToFaceMm: number;
  insertionDepthMm: number;
  wallThicknessMm: number;
  sourceUrl: string;
  /** Published scalar dimensions; transition contours remain parametric. */
  dimensionBasis?: 'published' | 'planning';
  catalogueModel?: string;
  catalogueTubeSizeMm?: number;
  sizeMatch?: 'exact' | 'rounded-imperial' | 'planning';
  /** A published cup table does not establish the unswaged body bore/contour. */
  bodyDimensionBasis?: 'parametric-tube-envelope';
  qualificationStatus?: 'unverified';
}

const COMPACT_90_SOURCE = 'https://www.tingertech.com/Pipe-Fittings-Reducing-Elbow-Welding-Copper-Fittings-90-Deg-Long-Radius-Elbow-For-Air-Condition-pd49565802.html';
const LONG_90_SOURCE = 'https://www.tingertech.com/Hvac-Asme-Plumbing-Welding-Manufacturer-Copper-Fittings-90-Deg-Long-Radius-Elbow-For-Refrigeration-Hvac-pd41635802.html';
const ELBOW_45_SOURCE = 'https://www.tingertech.com/45-Degree-Easy-Bend-Refrigeration-Pipe-Fittings-Copper-Pipe-Elbow-for-HVAC-and-Plumbing-pd43605802.html';
const HANDBOOK_SOURCE = 'https://www.copper.org/publications/pub_list/pdf/copper_tube_handbook.pdf';

interface CatalogueRow { model: string; tube: number; bore: number; wall: number; radius: number; face: number; insertion: number; source: string }
const row = (model: string, tube: number, bore: number, wall: number, radius: number, face: number, insertion: number, source: string): CatalogueRow =>
  ({ model, tube, bore, wall, radius, face, insertion, source });

// Accessed 2026-09-07. Do not use the inconsistent compact L-15.88/L-19
// radius/takeoff rows. The long-radius 15.88 has a 1 mm overlapping swage;
// its straight cup and published radius are retained by the body model.
const NINETY = [
  row('L-6.35', 6.35, 6.40, 0.8, 5, 12, 6, COMPACT_90_SOURCE),
  row('L-9.52', 9.52, 9.57, 0.8, 7, 16, 8, COMPACT_90_SOURCE),
  row('L-12.7', 12.7, 12.75, 0.8, 8.5, 20, 10, COMPACT_90_SOURCE),
  row('LD-15.88', 15.88, 15.95, 1, 27, 38, 12, LONG_90_SOURCE),
  row('L-22.23', 22.23, 22.33, 1, 15, 32, 15, COMPACT_90_SOURCE),
  row('L-25.4', 25.4, 25.50, 1.1, 16, 36, 17, COMPACT_90_SOURCE),
  row('L-28.58', 28.58, 28.68, 1.1, 18, 39, 19, COMPACT_90_SOURCE),
  row('L-32', 32, 32.10, 1.2, 20, 43, 21, COMPACT_90_SOURCE),
  row('L-35', 35, 35.10, 1.3, 22, 47, 22, COMPACT_90_SOURCE),
  row('L-38', 38, 38.10, 1.4, 24, 48, 23, COMPACT_90_SOURCE),
  row('L-42', 42, 42.10, 1.5, 26, 54, 25, COMPACT_90_SOURCE),
];
const FORTY_FIVE = [
  row('V-6.35', 6.35, 6.40, 0.8, 6.6, 10, 6, ELBOW_45_SOURCE),
  row('V-9.52', 9.52, 9.58, 0.8, 9.4, 13, 8, ELBOW_45_SOURCE),
  row('V-12.7', 12.7, 12.75, 0.8, 10.8, 16, 10, ELBOW_45_SOURCE),
  row('V-15.88', 15.88, 15.95, 0.8, 13.6, 19, 12, ELBOW_45_SOURCE),
  row('V-22.23', 22.23, 22.33, 1, 17.8, 25, 15, ELBOW_45_SOURCE),
];
// Explicit drawing-label aliases only. Never pick a fitting by nearest size.
const IMPERIAL_LABELS = new Map([[9.525, 9.52], [15.875, 15.88], [22.225, 22.23], [28.575, 28.58]]);

export function resolveCopperSocketElbow(tubeOD: number, angle: number): CopperSocketElbowSpec | null {
  if (!Number.isFinite(tubeOD) || tubeOD < 3 || tubeOD > 110 || (angle !== 45 && angle !== 90)) return null;
  const catalogue = angle === 90 ? NINETY : FORTY_FIVE;
  const alias = [...IMPERIAL_LABELS].find(([actual]) => Math.abs(actual - tubeOD) < 1e-6)?.[1];
  const selected = catalogue.find(item => Math.abs(item.tube - tubeOD) < 1e-6)
    ?? (alias === undefined ? undefined : catalogue.find(item => item.tube === alias));
  if (selected && selected.bore > tubeOD) {
    return { id: `tingertech-${selected.model}-${angle}`, angleDeg: angle,
      tubeOutsideDiameterMm: tubeOD, socketInsideDiameterMm: selected.bore,
      socketOutsideDiameterMm: selected.bore + 2 * selected.wall,
      bodyOutsideDiameterMm: tubeOD, bodyInsideDiameterMm: tubeOD - 2 * selected.wall,
      centerlineRadiusMm: selected.radius, centerToFaceMm: selected.face,
      insertionDepthMm: selected.insertion, wallThicknessMm: selected.wall,
      sourceUrl: selected.source, dimensionBasis: 'published', catalogueModel: selected.model,
      bodyDimensionBasis: 'parametric-tube-envelope', qualificationStatus: 'unverified',
      catalogueTubeSizeMm: selected.tube, sizeMatch: Math.abs(selected.tube - tubeOD) < 1e-6 ? 'exact' : 'rounded-imperial' };
  }
  // Uncatalogued sizes still get a coherent CxC planning shape. These are
  // explicit design assumptions, not fabricated manufacturer dimensions/SKUs.
  const wall = Math.max(0.8, tubeOD * 0.04);
  const insertion = Math.max(6, tubeOD * 0.65);
  const radius = tubeOD;
  const bore = tubeOD + Math.max(0.05, tubeOD * 0.003);
  return { id: `planning-cxc-${tubeOD}-${angle}`, angleDeg: angle,
    tubeOutsideDiameterMm: tubeOD, socketInsideDiameterMm: bore, socketOutsideDiameterMm: bore + 2 * wall,
    bodyOutsideDiameterMm: tubeOD, bodyInsideDiameterMm: tubeOD - 2 * wall,
    centerlineRadiusMm: radius, centerToFaceMm: radius * Math.tan(angle * Math.PI / 360) + insertion + 2 * wall,
    insertionDepthMm: insertion, wallThicknessMm: wall, sourceUrl: HANDBOOK_SOURCE,
    bodyDimensionBasis: 'parametric-tube-envelope', qualificationStatus: 'unverified',
    dimensionBasis: 'planning', sizeMatch: 'planning' };
}

/** A pipe may retain an explicitly authored formed-tube construction. */
export function usesCopperSocketElbows(properties: Record<string, unknown>): boolean {
  return properties.fieldBendConstruction !== 'formed-tube';
}

/** Stored constraints survive worker completion, reload and active-default changes. */
export function resolveCopperSocketElbowMinimumRadius(properties: Record<string, unknown>): number {
  const values = [getActivePipeRoutingSettings().minimumFieldBendRadiusMm,
    properties.minimumFieldBendRadiusMm, properties.minimumBendRadiusMm];
  return Math.max(0, ...values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
}
