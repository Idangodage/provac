/**
 * Elevation projection helpers.
 *
 * Transforms plan walls + openings + HVAC elements into 2D elevation geometry.
 */

import type {
  CompassDirection,
  ElevationFurnitureProjection,
  ElevationHvacProjection,
  ElevationSettings,
  ElevationView,
  ElevationViewKind,
  ElevationWallProjection,
  HvacElement,
  Opening,
  Point2D,
  SectionLine,
  SymbolInstance2D,
  Wall,
} from '../../../types';
import type { ArchitecturalObjectDefinition } from '../../../data';
import { DEFAULT_ELEVATION_SETTINGS } from '../../../types/wall';
import { generateId } from '../../../utils/geometry';

/** Lightweight info needed to project a placed furniture object */
export interface FurnitureProjectionInput {
  instance: SymbolInstance2D;
  definition: ArchitecturalObjectDefinition;
}

const STANDARD_VIEW_ORDER: ElevationViewKind[] = ['north', 'south', 'east', 'west'];

interface Basis {
  origin: Point2D;
  axisX: Point2D;
  axisDepth: Point2D;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y;
}

function length(v: Point2D): number {
  return Math.hypot(v.x, v.y);
}

function normalize(v: Point2D): Point2D {
  const len = length(v) || 1;
  return { x: v.x / len, y: v.y / len };
}

function perpendicular(v: Point2D): Point2D {
  return { x: -v.y, y: v.x };
}

function orientation(a: Point2D, b: Point2D, c: Point2D): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function onSegment(a: Point2D, b: Point2D, c: Point2D): boolean {
  return (
    Math.min(a.x, c.x) <= b.x + 0.0001 &&
    b.x <= Math.max(a.x, c.x) + 0.0001 &&
    Math.min(a.y, c.y) <= b.y + 0.0001 &&
    b.y <= Math.max(a.y, c.y) + 0.0001
  );
}

function segmentsIntersect(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if ((o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) && (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0)) {
    return true;
  }
  if (Math.abs(o1) < 0.0001 && onSegment(a1, b1, a2)) return true;
  if (Math.abs(o2) < 0.0001 && onSegment(a1, b2, a2)) return true;
  if (Math.abs(o3) < 0.0001 && onSegment(b1, a1, b2)) return true;
  if (Math.abs(o4) < 0.0001 && onSegment(b1, a2, b2)) return true;
  return false;
}

function wallHatchPattern(wall: Wall): ElevationWallProjection['hatchPattern'] {
  if (wall.material === 'brick') return 'brick';
  if (wall.material === 'concrete') return 'concrete';
  if (wall.properties3D.materialId.includes('wood')) return 'wood';
  return 'none';
}

function projectOpening(
  opening: Opening,
  wall: Wall,
  xStart: number,
  xEnd: number,
  wallLength: number
): ElevationWallProjection['openings'][number] {
  const t = wallLength > 0 ? clamp(opening.position / wallLength, 0, 1) : 0.5;
  const centerX = xStart + (xEnd - xStart) * t;
  const projectedScale = wallLength > 0 ? Math.max(0.25, Math.abs((xEnd - xStart) / wallLength)) : 1;
  const projectedWidth = Math.max(120, opening.width * projectedScale);
  const sillHeight = opening.type === 'door' ? 0 : opening.sillHeight ?? 900;
  const yBottom = opening.type === 'door' ? 0 : sillHeight;
  const yTop = yBottom + opening.height;

  return {
    id: `${wall.id}:${opening.id}`,
    wallId: wall.id,
    openingId: opening.id,
    type: opening.type,
    xStart: centerX - projectedWidth / 2,
    xEnd: centerX + projectedWidth / 2,
    yBottom,
    yTop,
    sillHeight,
    height: opening.height,
    wallXStart: xStart,
    wallXEnd: xEnd,
    wallLength,
    wallOpeningPosition: opening.position,
  };
}

function projectWall(
  wall: Wall,
  basis: Basis,
  settings: ElevationSettings,
  includeWall: (wall: Wall) => { include: boolean; signedDepth: number }
): ElevationWallProjection | null {
  const inclusion = includeWall(wall);
  if (!inclusion.include) return null;

  const startRelative = subtract(wall.startPoint, basis.origin);
  const endRelative = subtract(wall.endPoint, basis.origin);
  const xStart = dot(startRelative, basis.axisX);
  const xEnd = dot(endRelative, basis.axisX);
  const midpoint = {
    x: (wall.startPoint.x + wall.endPoint.x) / 2,
    y: (wall.startPoint.y + wall.endPoint.y) / 2,
  };
  const midpointRelative = subtract(midpoint, basis.origin);
  const signedDepth = dot(midpointRelative, basis.axisDepth);
  const depth = Math.max(0, inclusion.signedDepth >= 0 ? inclusion.signedDepth : signedDepth);
  const depthAlpha = settings.showDepthCueing ? clamp(1 - depth / 12000, 0.25, 1) : 1;
  const wallLength = Math.max(1, length(subtract(wall.endPoint, wall.startPoint)));
  const yBottom = wall.properties3D.baseElevation;
  const yTop = wall.properties3D.baseElevation + wall.properties3D.height;

  return {
    id: wall.id,
    wallId: wall.id,
    xStart,
    xEnd,
    yBottom,
    yTop,
    depth,
    depthAlpha,
    materialId: wall.properties3D.materialId,
    wallMaterial: wall.material,
    hatchPattern: wallHatchPattern(wall),
    openings: wall.openings.map((opening) => projectOpening(opening, wall, xStart, xEnd, wallLength)),
  };
}

/**
 * Projects an HVAC element into an elevation view.
 *
 * The HVAC element has a plan-view bounding box (position, width, depth)
 * and a vertical extent (elevation, height). We project the four corners
 * of the plan bounding box onto the elevation basis to find xStart/xEnd,
 * and check the depth axis to determine visibility.
 */
function projectHvacElement(
  element: HvacElement,
  basis: Basis,
  _settings: ElevationSettings,
  sectionDepthMm: number
): ElevationHvacProjection | null {
  // HVAC element corners in plan
  const corners = [
    element.position,
    { x: element.position.x + element.width, y: element.position.y },
    { x: element.position.x + element.width, y: element.position.y + element.depth },
    { x: element.position.x, y: element.position.y + element.depth },
  ];

  // Project corners onto the elevation axis
  const projections = corners.map((corner) => {
    const relative = subtract(corner, basis.origin);
    return {
      x: dot(relative, basis.axisX),
      depth: dot(relative, basis.axisDepth),
    };
  });

  const xValues = projections.map((p) => p.x);
  const depthValues = projections.map((p) => p.depth);
  const xStart = Math.min(...xValues);
  const xEnd = Math.max(...xValues);
  const minDepth = Math.min(...depthValues);
  const maxDepth = Math.max(...depthValues);
  const avgDepth = (minDepth + maxDepth) / 2;

  // Determine visibility based on depth relative to section plane
  let visibility: ElevationHvacProjection['visibility'];
  if (maxDepth < 0) {
    // Entirely behind the viewer — not visible
    return null;
  } else if (minDepth >= 0 && maxDepth <= sectionDepthMm) {
    visibility = 'visible';
  } else if (minDepth < 0 || maxDepth > sectionDepthMm) {
    // Section plane cuts through the element
    visibility = 'cut';
  } else {
    visibility = 'ghost';
  }

  return {
    id: `hvac-elev-${element.id}`,
    hvacElementId: element.id,
    type: element.type,
    xStart,
    xEnd,
    yBottom: element.elevation,
    yTop: element.elevation + element.height,
    depth: Math.max(0, avgDepth),
    visibility,
    label: element.label,
  };
}

/**
 * Projects a placed furniture/fixture into an elevation view.
 * Uses the object's plan position + dimensions and the definition's heightMm.
 */
function projectFurnitureElement(
  input: FurnitureProjectionInput,
  basis: Basis,
  sectionDepthMm: number
): ElevationFurnitureProjection | null {
  const { instance, definition } = input;
  const instanceProps = instance.properties ?? {};
  const readNumber = (key: string): number | null => {
    const value = instanceProps[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const scaleFactor = Number.isFinite(instance.scale) && instance.scale > 0 ? instance.scale : 1;
  const widthMm = Math.max(60, (readNumber('widthMm') ?? definition.widthMm) * scaleFactor);
  const depthMm = Math.max(40, (readNumber('depthMm') ?? definition.depthMm) * scaleFactor);
  const heightMm = Math.max(80, (readNumber('heightMm') ?? definition.heightMm) * scaleFactor);
  const baseElevationMm = readNumber('baseElevationMm') ?? 0;

  // Furniture bounding box corners in plan (position is center in mm)
  const halfW = widthMm / 2;
  const halfD = depthMm / 2;
  const cx = instance.position.x;
  const cy = instance.position.y;
  const rotRad = (instance.rotation * Math.PI) / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);

  // 4 corners rotated around center
  const offsets = [
    { x: -halfW, y: -halfD },
    { x: halfW, y: -halfD },
    { x: halfW, y: halfD },
    { x: -halfW, y: halfD },
  ];
  const corners = offsets.map((o) => ({
    x: cx + o.x * cosR - o.y * sinR,
    y: cy + o.x * sinR + o.y * cosR,
  }));

  const projections = corners.map((corner) => {
    const relative = subtract(corner, basis.origin);
    return {
      x: dot(relative, basis.axisX),
      depth: dot(relative, basis.axisDepth),
    };
  });

  const xValues = projections.map((p) => p.x);
  const depthValues = projections.map((p) => p.depth);
  const xStart = Math.min(...xValues);
  const xEnd = Math.max(...xValues);
  const minDepth = Math.min(...depthValues);
  const maxDepth = Math.max(...depthValues);
  const avgDepth = (minDepth + maxDepth) / 2;

  // Visibility based on depth
  let visibility: ElevationFurnitureProjection['visibility'];
  if (maxDepth < 0) return null; // behind viewer
  if (minDepth >= 0 && maxDepth <= sectionDepthMm) {
    visibility = 'visible';
  } else if (minDepth < 0 || maxDepth > sectionDepthMm) {
    visibility = 'cut';
  } else {
    visibility = 'ghost';
  }

  const yBottom = baseElevationMm;
  const yTop = baseElevationMm + heightMm;

  return {
    id: `furn-elev-${instance.id}`,
    instanceId: instance.id,
    renderType: definition.renderType ?? `generic-${definition.category}`,
    name: definition.name,
    xStart,
    xEnd,
    yBottom,
    yTop,
    depth: Math.max(0, avgDepth),
    visibility,
  };
}

function computeViewBounds(projectedWalls: ElevationWallProjection[]): {
  minX: number;
  maxX: number;
  maxHeightMm: number;
} {
  if (projectedWalls.length === 0) {
    return {
      minX: 0,
      maxX: 10000,
      maxHeightMm: 3000,
    };
  }
  const xs = projectedWalls.flatMap((wall) => [wall.xStart, wall.xEnd]);
  const maxHeight = projectedWalls.reduce((maxValue, wall) => Math.max(maxValue, wall.yTop), 0);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    maxHeightMm: Math.max(3000, maxHeight),
  };
}

function buildViewHash(
  walls: Wall[],
  hvacElements: HvacElement[],
  sectionLine: SectionLine | null,
  settings: ElevationSettings,
  kind: ElevationViewKind,
  furnitureInputs: FurnitureProjectionInput[] = []
): string {
  const wallHash = walls
    .map((wall) => {
      const openings = wall.openings
        .map((opening) => `${opening.id}:${opening.type}:${opening.position}:${opening.width}:${opening.height}:${opening.sillHeight ?? 0}`)
        .sort()
        .join(',');
      return [
        wall.id,
        wall.startPoint.x.toFixed(2),
        wall.startPoint.y.toFixed(2),
        wall.endPoint.x.toFixed(2),
        wall.endPoint.y.toFixed(2),
        wall.thickness.toFixed(1),
        wall.properties3D.height.toFixed(1),
        wall.properties3D.baseElevation.toFixed(1),
        openings,
      ].join(':');
    })
    .sort()
    .join('|');

  const hvacHash = hvacElements
    .map((el) => `${el.id}:${el.position.x.toFixed(0)}:${el.position.y.toFixed(0)}:${el.width}:${el.depth}:${el.elevation}:${el.height}`)
    .sort()
    .join('|');

  const sectionHash = sectionLine
    ? [
      sectionLine.id,
      sectionLine.startPoint.x.toFixed(2),
      sectionLine.startPoint.y.toFixed(2),
      sectionLine.endPoint.x.toFixed(2),
      sectionLine.endPoint.y.toFixed(2),
      sectionLine.direction,
      sectionLine.depthMm,
    ].join(':')
    : 'none';

  const furnHash = furnitureInputs
    .map((fi) => `${fi.instance.id}:${fi.instance.position.x.toFixed(0)}:${fi.instance.position.y.toFixed(0)}:${fi.instance.rotation}:${fi.definition.renderType ?? ''}`)
    .sort()
    .join('|');

  return `${kind}:${sectionHash}:${settings.showDepthCueing ? 1 : 0}:${settings.renderMode}:${wallHash}:${hvacHash}:${furnHash}`;
}

function createBasisForStandard(kind: ElevationViewKind): { basis: Basis; viewDirection: CompassDirection } {
  if (kind === 'north') {
    return {
      basis: {
        origin: { x: 0, y: 0 },
        axisX: { x: 1, y: 0 },
        axisDepth: { x: 0, y: -1 },
      },
      viewDirection: 'N',
    };
  }
  if (kind === 'south') {
    return {
      basis: {
        origin: { x: 0, y: 0 },
        axisX: { x: 1, y: 0 },
        axisDepth: { x: 0, y: 1 },
      },
      viewDirection: 'S',
    };
  }
  if (kind === 'east') {
    return {
      basis: {
        origin: { x: 0, y: 0 },
        axisX: { x: 0, y: 1 },
        axisDepth: { x: 1, y: 0 },
      },
      viewDirection: 'E',
    };
  }
  return {
    basis: {
      origin: { x: 0, y: 0 },
      axisX: { x: 0, y: 1 },
      axisDepth: { x: -1, y: 0 },
    },
    viewDirection: 'W',
  };
}

export function createStandardElevationViews(
  walls: Wall[],
  existingViews: ElevationView[],
  settings: ElevationSettings = DEFAULT_ELEVATION_SETTINGS,
  hvacElements: HvacElement[] = [],
  furnitureInputs: FurnitureProjectionInput[] = []
): ElevationView[] {
  return STANDARD_VIEW_ORDER.map((kind) => {
    const existing = existingViews.find((view) => view.kind === kind);
    const sourceHash = buildViewHash(walls, hvacElements, null, settings, kind, furnitureInputs);
    if (existing && existing.sourceHash === sourceHash) {
      return existing;
    }

    const { basis, viewDirection } = createBasisForStandard(kind);
    const projected = walls
      .map((wall) =>
        projectWall(wall, basis, settings, (candidate) => {
          const midpoint = {
            x: (candidate.startPoint.x + candidate.endPoint.x) / 2,
            y: (candidate.startPoint.y + candidate.endPoint.y) / 2,
          };
          const signedDepth = dot(subtract(midpoint, basis.origin), basis.axisDepth);
          return { include: true, signedDepth };
        })
      )
      .filter((wall): wall is ElevationWallProjection => Boolean(wall))
      .sort((a, b) => b.depth - a.depth);

    // Project HVAC elements
    const projectedHvac = hvacElements
      .map((el) => projectHvacElement(el, basis, settings, Infinity))
      .filter((el): el is ElevationHvacProjection => Boolean(el));

    // Project furniture elements
    const projectedFurniture = furnitureInputs
      .map((fi) => projectFurnitureElement(fi, basis, Infinity))
      .filter((el): el is ElevationFurnitureProjection => Boolean(el));

    const bounds = computeViewBounds(projected);
    return {
      id: existing?.id ?? `elevation-${kind}`,
      name: existing?.name ?? `${kind[0].toUpperCase()}${kind.slice(1)} Elevation`,
      kind,
      sectionLineId: null,
      viewDirection,
      walls: projected,
      hvacElements: projectedHvac,
      furnitureElements: projectedFurniture,
      minX: bounds.minX,
      maxX: bounds.maxX,
      maxHeightMm: bounds.maxHeightMm,
      gridIncrementMm: settings.defaultGridIncrementMm,
      scale: settings.defaultScale,
      sourceHash,
      updatedAt: Date.now(),
    };
  });
}

export function generateCustomElevationView(
  sectionLine: SectionLine,
  walls: Wall[],
  existing: ElevationView | null,
  settings: ElevationSettings = DEFAULT_ELEVATION_SETTINGS,
  hvacElements: HvacElement[] = [],
  furnitureInputs: FurnitureProjectionInput[] = []
): ElevationView {
  const lineVector = normalize(subtract(sectionLine.endPoint, sectionLine.startPoint));
  const basis: Basis = {
    origin: sectionLine.startPoint,
    axisX: lineVector,
    axisDepth: {
      x: perpendicular(lineVector).x * sectionLine.direction,
      y: perpendicular(lineVector).y * sectionLine.direction,
    },
  };
  const sourceHash = buildViewHash(walls, hvacElements, sectionLine, settings, 'custom', furnitureInputs);
  if (existing && existing.sourceHash === sourceHash) {
    return existing;
  }

  const projected = walls
    .map((wall) =>
      projectWall(wall, basis, settings, (candidate) => {
        const midpoint = {
          x: (candidate.startPoint.x + candidate.endPoint.x) / 2,
          y: (candidate.startPoint.y + candidate.endPoint.y) / 2,
        };
        const signedDepth = dot(subtract(midpoint, basis.origin), basis.axisDepth);
        const intersectsSection = segmentsIntersect(
          candidate.startPoint,
          candidate.endPoint,
          sectionLine.startPoint,
          sectionLine.endPoint
        );
        const include = intersectsSection || (signedDepth >= -candidate.thickness && signedDepth <= sectionLine.depthMm);
        return { include, signedDepth };
      })
    )
    .filter((wall): wall is ElevationWallProjection => Boolean(wall))
    .sort((a, b) => b.depth - a.depth);

  // Project HVAC elements with section line depth
  const projectedHvac = hvacElements
    .map((el) => projectHvacElement(el, basis, settings, sectionLine.depthMm))
    .filter((el): el is ElevationHvacProjection => Boolean(el));

  // Project furniture elements
  const projectedFurniture = furnitureInputs
    .map((fi) => projectFurnitureElement(fi, basis, sectionLine.depthMm))
    .filter((el): el is ElevationFurnitureProjection => Boolean(el));

  const bounds = computeViewBounds(projected);
  return {
    id: existing?.id ?? generateId(),
    name: existing?.name ?? sectionLine.label,
    kind: 'custom',
    sectionLineId: sectionLine.id,
    viewDirection: 'custom',
    walls: projected,
    hvacElements: projectedHvac,
    furnitureElements: projectedFurniture,
    minX: bounds.minX,
    maxX: bounds.maxX,
    maxHeightMm: bounds.maxHeightMm,
    gridIncrementMm: existing?.gridIncrementMm ?? settings.defaultGridIncrementMm,
    scale: existing?.scale ?? settings.defaultScale,
    sourceHash,
    updatedAt: Date.now(),
  };
}

export function regenerateElevationViews(
  walls: Wall[],
  sectionLines: SectionLine[],
  existingViews: ElevationView[],
  settings: ElevationSettings = DEFAULT_ELEVATION_SETTINGS,
  hvacElements: HvacElement[] = [],
  furnitureInputs: FurnitureProjectionInput[] = []
): ElevationView[] {
  const standardViews = createStandardElevationViews(walls, existingViews, settings, hvacElements, furnitureInputs);
  const sectionsById = new Map(sectionLines.map((sectionLine) => [sectionLine.id, sectionLine]));
  const existingCustom = existingViews.filter((view) => view.kind === 'custom');

  const customViews = existingCustom
    .map((view) => {
      if (!view.sectionLineId) return null;
      const line = sectionsById.get(view.sectionLineId);
      if (!line) return null;
      return generateCustomElevationView(line, walls, view, settings, hvacElements, furnitureInputs);
    })
    .filter((view): view is ElevationView => Boolean(view));

  return [...standardViews, ...customViews];
}
