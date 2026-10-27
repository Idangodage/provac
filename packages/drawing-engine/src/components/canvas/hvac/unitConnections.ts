/**
 * Where the maker puts an indoor unit's refrigerant and drain connections, by
 * model code: the stubs the field pipes join.
 *
 * Positions are in the unit frame: x along the unit's width, y along its
 * depth, the footprint centre at 0,0, z above the underside. That is the frame
 * the maker's 3D model is placed in (three3d/glbModelCache.ts), so a field
 * pipe that starts at a tip here starts on the model's own stub.
 *
 * Sources:
 *  - the MEPcontent MACO VRF models (converted IFC), measured 27 October 2026
 *    (stub and hose clusters across their axis);
 *  - the FDUM140KXE6F IFC connector parameters (the gas and liquid stub
 *    lengths, which its model does not draw);
 *  - MHI technical manual '14•KX-T-222, drawing PJG000Z287 (FDU224/280KXZE1:
 *    end view A/B/C and the plan view's 80 mm stub projection).
 */
import type { HvacElement, Point2D } from '../../../types';

export type UnitConnectionKind = 'gas' | 'liquid' | 'drain' | 'drain-gravity';

export interface UnitConnection {
  /** `drain`: where a pumped unit drains (the pump's outlet, or the only outlet); `drain-gravity`: the gravity outlet. */
  kind: UnitConnectionKind;
  /** Centre of the stub across its axis: plan offset (mm) and height above the underside (mm). */
  y: number;
  z: number;
  /** Outward along local x: +1 at the +x end, −1 at the −x end. */
  axis: 1 | -1;
  /** Where the stub (or the supplied hose) leaves the casing, along local x (mm). */
  rootX: number;
  /** Where the field pipe joins: the stub's end, or the end of the maker's supplied hose (local x, mm). */
  tipX: number;
  /** Outside diameter of the stub, nut or hose as the maker draws it (mm). */
  outerDiameterMm: number;
  joint: 'flare' | 'brazed' | 'hose' | 'socket';
  /** The maker's 3D model already shows it, so nothing is drawn over it in 3D. */
  inModel: boolean;
}

export interface UnitConnectionSet {
  source: 'maker-3d' | 'maker-drawing';
  reference: string;
  /** The unit size (W × D × H, mm) the data is measured on; a unit drawn at another size keeps its drawn ports. */
  footprintMm: { width: number; depth: number; height: number };
  /** A cassette's panel, when the footprint also spans its connections: its size and centre in the unit frame. */
  panel?: { sizeMm: number; centre: Point2D };
  /**
   * The unit's solid body in plan (unit frame), when the footprint also spans
   * its stubs, hose, hanger plates or panel rim: what field pipes keep out of.
   */
  casing?: { centre: Point2D; width: number; depth: number };
  connections: readonly UnitConnection[];
}

const FDT28: UnitConnectionSet = {
  source: 'maker-3d',
  reference: 'MEPcontent MACO VRF model FDT28KXZE1 (measured)',
  footprintMm: { width: 1043, depth: 950, height: 272 },
  panel: { sizeMm: 950, centre: { x: 47, y: 0 } },
  // The 840 body above the panel; the stubs end on its −x face.
  casing: { centre: { x: 47, y: 0 }, width: 840, depth: 840 },
  connections: [
    { kind: 'gas', y: -303, z: 208.9, axis: -1, rootX: -360.1, tipX: -373.5, outerDiameterMm: 13.2, joint: 'flare', inModel: true },
    { kind: 'liquid', y: -245, z: 166.9, axis: -1, rootX: -362.4, tipX: -373.5, outerDiameterMm: 15, joint: 'flare', inModel: true },
    // The drain pump's outlet, with the supplied hose out past the panel.
    { kind: 'drain', y: 333, z: 223.9, axis: -1, rootX: -203, tipX: -521.5, outerDiameterMm: 32, joint: 'hose', inModel: true },
  ],
};

const FDUM22: UnitConnectionSet = {
  source: 'maker-3d',
  reference: 'MEPcontent MACO VRF model FDUM22KXE6F-W (measured)',
  footprintMm: { width: 1084, depth: 697, height: 300 },
  // 750 × 635 (MHI KX-DB-175) from x −492.5 to its connection face at 258; hanger plates either side.
  casing: { centre: { x: -117.25, y: 0 }, width: 750, depth: 635 },
  connections: [
    { kind: 'gas', y: -152.5, z: 175, axis: 1, rootX: 288, tipX: 316, outerDiameterMm: 26, joint: 'flare', inModel: true },
    { kind: 'liquid', y: -191.5, z: 105, axis: 1, rootX: 288, tipX: 325, outerDiameterMm: 9.6, joint: 'flare', inModel: true },
    // The pump's drain-up outlet with the supplied hose (insulated), and the gravity outlet in the base.
    { kind: 'drain', y: -94.5, z: 204.1, axis: 1, rootX: 282, tipX: 542, outerDiameterMm: 53, joint: 'hose', inModel: true },
    { kind: 'drain-gravity', y: -148.5, z: 30, axis: 1, rootX: 258, tipX: 283, outerDiameterMm: 32, joint: 'socket', inModel: true },
  ],
};

const FDUM140: UnitConnectionSet = {
  source: 'maker-3d',
  reference: 'MEPcontent MACO VRF model and IFC connectors FDUM140KXE6F (measured)',
  footprintMm: { width: 1684, depth: 802, height: 300 },
  // 1370 × 740 (MHI KX-DB-175) ending at its connection face, x 627.
  casing: { centre: { x: -58, y: 0 }, width: 1370, depth: 740 },
  connections: [
    // The model marks the flare connections on the casing face (x 627); the IFC connectors stand 69 and 59 mm out.
    { kind: 'gas', y: -97, z: 145.5, axis: 1, rootX: 627, tipX: 696, outerDiameterMm: 15.88, joint: 'flare', inModel: false },
    { kind: 'liquid', y: -35, z: 95.5, axis: 1, rootX: 627, tipX: 686, outerDiameterMm: 9.52, joint: 'flare', inModel: false },
    { kind: 'drain', y: -263.5, z: 187.6, axis: 1, rootX: 627, tipX: 842, outerDiameterMm: 53, joint: 'hose', inModel: true },
    { kind: 'drain-gravity', y: -96, z: 30, axis: 1, rootX: 558, tipX: 583, outerDiameterMm: 32, joint: 'socket', inModel: true },
  ],
};

/** FDU224/280KXZE1, drawn to PJG000Z287: A gas and B liquid brazed, 80 mm out of the end; C the VP25 drain socket. */
function fdu(gasMm: number): UnitConnectionSet {
  return {
    source: 'maker-drawing',
    reference: "MHI '14•KX-T-222 §2.1, drawing PJG000Z287",
    footprintMm: { width: 1600, depth: 893, height: 379 },
    connections: [
      { kind: 'gas', y: 39.5, z: 214, axis: 1, rootX: 800, tipX: 880, outerDiameterMm: gasMm, joint: 'brazed', inModel: false },
      { kind: 'liquid', y: 132.5, z: 246, axis: 1, rootX: 800, tipX: 880, outerDiameterMm: 9.52, joint: 'brazed', inModel: false },
      { kind: 'drain', y: 92.5, z: 30, axis: 1, rootX: 800, tipX: 837, outerDiameterMm: 32, joint: 'socket', inModel: false },
    ],
  };
}

const UNIT_CONNECTIONS: Readonly<Record<string, UnitConnectionSet>> = {
  FDT28KXZE1: FDT28,
  'FDUM22KXE6F-W': FDUM22,
  FDUM140KXE6F: FDUM140,
  // The FDUM160 is the FDUM140's cabinet and model.
  FDUM160KXE6F: FDUM140,
  FDU224KXZE1: fdu(19.05),
  FDU280KXZE1: fdu(22.22),
};

const SIZE_TOLERANCE_MM = 1;

/** The maker's connections of a placed unit (by its model code), or null: unknown model, or drawn at another size. */
export function unitConnectionsFor(element: Pick<HvacElement, 'width' | 'depth' | 'height' | 'properties'>): UnitConnectionSet | null {
  for (const key of ['modelCode', 'model']) {
    const value = element.properties?.[key];
    const set = typeof value === 'string' ? UNIT_CONNECTIONS[value] : undefined;
    if (!set) continue;
    const { width, depth, height } = set.footprintMm;
    const fits = Math.abs(element.width - width) <= SIZE_TOLERANCE_MM && Math.abs(element.depth - depth) <= SIZE_TOLERANCE_MM
      && Math.abs(element.height - height) <= SIZE_TOLERANCE_MM;
    return fits ? set : null;
  }
  return null;
}

export function unitConnectionOf(set: UnitConnectionSet, kind: UnitConnectionKind): UnitConnection | null {
  return set.connections.find((connection) => connection.kind === kind) ?? null;
}

/** The outlet the field drain joins: the pump's when the unit is pumped, else the gravity outlet (or the only one). */
export function drainConnectionOf(set: UnitConnectionSet, pumped: boolean): UnitConnection | null {
  const pump = unitConnectionOf(set, 'drain');
  const gravity = unitConnectionOf(set, 'drain-gravity');
  return pumped ? pump ?? gravity : gravity ?? pump;
}

/**
 * The unit's solid body in plan, as a world AABB: its casing where the
 * maker's data has one, else its whole footprint.
 */
export function unitBodyBoundsMm(
  element: Pick<HvacElement, 'position' | 'width' | 'depth' | 'height' | 'rotation' | 'properties'>,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const casing = unitConnectionsFor(element)?.casing;
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const local = casing ?? { centre: { x: 0, y: 0 }, width: element.width, depth: element.depth };
  const angle = ((element.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = local.centre.x + (sx! * local.width) / 2;
    const y = local.centre.y + (sy! * local.depth) / 2;
    return { x: centre.x + x * cos - y * sin, y: centre.y + x * sin + y * cos };
  });
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    maxY: Math.max(...corners.map((corner) => corner.y)),
  };
}

/** The plan point (unit frame) where the field pipe joins. */
export function unitConnectionTipLocal(connection: UnitConnection): Point2D {
  return { x: connection.tipX, y: connection.y };
}

/** The field drain at a maker's hose: VP25 through the socket supplied with it (O.D. 32). */
export const MAKER_DRAIN_FIELD_OUTER_DIAMETER_MM = 32;

export interface MakerPortGeometry {
  radius: number;
  collarRadius: number;
  collarLength: number;
  flangeThickness: number;
  /** The stub after the collar; the port's tip, x + axis·(collarLength + length − 0.15·flange), is the connection's tip. */
  length: number;
}

/**
 * A port's drawn parts (flange, collar, stub) laid along a maker connection
 * so the stub ends exactly on its tip. A drain hose is drawn at the field
 * pipe's size: the hose itself is the maker model's.
 */
export function makerPortGeometry(connection: UnitConnection): MakerPortGeometry {
  const total = Math.abs(connection.tipX - connection.rootX);
  const flangeThickness = 3;
  const collarLength = Math.min(12, Math.max(4, total * 0.2));
  const diameter = connection.joint === 'hose' ? MAKER_DRAIN_FIELD_OUTER_DIAMETER_MM : connection.outerDiameterMm;
  const radius = Math.max(3, diameter / 2);
  return { radius, collarRadius: radius * 1.2, collarLength, flangeThickness, length: total - collarLength + flangeThickness * 0.15 };
}
