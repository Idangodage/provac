import {
  difference as turfDifference,
  featureCollection as turfFeatureCollection,
  multiPolygon as turfMultiPolygon,
  polygon as turfPolygon,
} from '@turf/turf';

import type { JoinData, Point2D, Wall } from '../../../types';
import { computeWallJoinMapWithShadows } from '../wall/WallJoinNetwork';
import {
  computeJunctionPatchPolygons,
  computeRenderableWallPolygon,
} from '../wall/WallUnionGeometry';

const EPSILON = 0.001;

export type IsometricWallPalette = {
  top: string;
  side: string;
  outline: string;
};

export type IsometricWallBand = {
  polygon: Point2D[][];
  baseElevation: number;
  height: number;
  palette: IsometricWallPalette;
  name: string;
  showOutline?: boolean;
  showTopCap?: boolean;
  topCapInsetMm?: number;
};

type OpeningSpan = {
  id: string;
  start: number;
  end: number;
  bottom: number;
  top: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wallPalette(material: Wall['material']): IsometricWallPalette {
  switch (material) {
    case 'brick':
      return { top: '#d9b8a4', side: '#b7866b', outline: '#7a5643' };
    case 'concrete':
      return { top: '#d7dde5', side: '#b6c0cb', outline: '#6c7783' };
    case 'partition':
    default:
      return { top: '#e4d2c2', side: '#ba8a6d', outline: '#8a654d' };
  }
}

function wallStyleKey(wall: Wall): string {
  return [
    wall.material,
    Math.round(wall.properties3D.baseElevation ?? 0),
    Math.round(wall.properties3D.height ?? 2700),
  ].join('|');
}

function openingHoleRectWorld(wall: Wall, span: OpeningSpan): Point2D[] {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const len = Math.hypot(dx, dy);
  if (len <= EPSILON) {
    return [];
  }

  const dirX = dx / len;
  const dirY = dy / len;
  const perpX = -dirY;
  const perpY = dirX;
  const halfThickCut = wall.thickness / 2 + 50;

  const cx = wall.startPoint.x + dirX * (span.start + span.end) / 2;
  const cy = wall.startPoint.y + dirY * (span.start + span.end) / 2;
  const halfLen = (span.end - span.start) / 2;

  return [
    { x: cx - dirX * halfLen + perpX * halfThickCut, y: cy - dirY * halfLen + perpY * halfThickCut },
    { x: cx + dirX * halfLen + perpX * halfThickCut, y: cy + dirY * halfLen + perpY * halfThickCut },
    { x: cx + dirX * halfLen - perpX * halfThickCut, y: cy + dirY * halfLen - perpY * halfThickCut },
    { x: cx - dirX * halfLen - perpX * halfThickCut, y: cy - dirY * halfLen - perpY * halfThickCut },
  ];
}

function ringToCoords(ring: Point2D[]): number[][] {
  const coords = ring.map((point) => [point.x, point.y]);
  if (coords.length > 0) {
    coords.push([ring[0].x, ring[0].y]);
  }
  return coords;
}

function turfCoordsToPolygons(
  geometry: { type: string; coordinates: number[][][] | number[][][][] }
): Point2D[][][] {
  if (geometry.type === 'Polygon') {
    const coords = geometry.coordinates as number[][][];
    return [coords.map((ring) => ring.slice(0, -1).map((coordinate) => ({ x: coordinate[0], y: coordinate[1] })))];
  }

  if (geometry.type === 'MultiPolygon') {
    const coords = geometry.coordinates as number[][][][];
    return coords.map((polygon) =>
      polygon.map((ring) => ring.slice(0, -1).map((coordinate) => ({ x: coordinate[0], y: coordinate[1] })))
    );
  }

  return [];
}

function subtractOpeningHoles(
  polygon: Point2D[][],
  holes: Point2D[][]
): Point2D[][][] {
  const outerRing = polygon[0];
  if (!outerRing || outerRing.length < 3) {
    return [polygon];
  }

  const existingHoles = polygon.slice(1).filter((ring) => ring.length >= 3);
  const turfOuter = ringToCoords(outerRing);
  const turfHoles = existingHoles.map(ringToCoords);

  let current: ReturnType<typeof turfPolygon> | ReturnType<typeof turfMultiPolygon>;
  try {
    current = turfPolygon([turfOuter, ...turfHoles]);
  } catch {
    return [polygon];
  }

  for (const hole of holes) {
    if (hole.length < 3) {
      continue;
    }

    try {
      const holePolygon = turfPolygon([ringToCoords(hole)]);
      const diff = turfDifference(turfFeatureCollection([current, holePolygon]));
      if (!diff) {
        return [];
      }
      current = diff as typeof current;
    } catch {
      // Preserve the current polygon if Turf fails on this specific cut.
    }
  }

  return turfCoordsToPolygons(
    current.geometry as { type: string; coordinates: number[][][] | number[][][][] }
  );
}

function openingSpansForWall(wall: Wall): OpeningSpan[] {
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const wallLength = Math.hypot(dx, dy);
  if (wallLength <= EPSILON) {
    return [];
  }

  const wallBase = wall.properties3D.baseElevation ?? 0;
  const wallTop = wallBase + Math.max(1, wall.properties3D.height ?? 2700);

  return wall.openings
    .map((opening) => {
      const halfWidth = Math.max(10, opening.width / 2);
      const start = clamp(opening.position - halfWidth, 0, wallLength);
      const end = clamp(opening.position + halfWidth, 0, wallLength);
      const bottom = opening.type === 'window'
        ? wallBase + (opening.sillHeight ?? 900)
        : wallBase;
      const top = Math.min(
        wallTop,
        bottom + Math.max(100, opening.height || (opening.type === 'door' ? 2100 : 1200))
      );
      if (end - start <= EPSILON || top - bottom <= EPSILON) {
        return null;
      }
      return {
        id: opening.id,
        start,
        end,
        bottom,
        top,
      } satisfies OpeningSpan;
    })
    .filter((span): span is OpeningSpan => span !== null)
    .sort((left, right) => left.start - right.start);
}

function pushBandPolygons(
  bands: IsometricWallBand[],
  polygons: Point2D[][][],
  baseElevation: number,
  height: number,
  palette: IsometricWallPalette,
  name: string,
  showOutline: boolean,
  showTopCap: boolean,
  topCapInsetMm = 0,
): void {
  polygons.forEach((polygon, polygonIndex) => {
    const outerRing = polygon[0];
    if (!outerRing || outerRing.length < 3) {
      return;
    }

    bands.push({
      polygon,
      baseElevation,
      height,
      palette,
      name: polygonIndex === 0 ? name : `${name}-p${polygonIndex}`,
      showOutline,
      showTopCap,
      topCapInsetMm,
    });
  });
}

export function buildUnifiedWallBands(
  walls: Wall[],
  precomputedJoinsMap?: Map<string, JoinData[]>
): IsometricWallBand[] {
  const joinResult = precomputedJoinsMap
    ? { joinsMap: precomputedJoinsMap, shadowedWallIds: new Set<string>() }
    : computeWallJoinMapWithShadows(walls);
  const { joinsMap, shadowedWallIds } = joinResult;
  const groups = new Map<string, Wall[]>();
  walls.forEach((wall) => {
    const key = wallStyleKey(wall);
    groups.set(key, [...(groups.get(key) ?? []), wall]);
  });

  const bands: IsometricWallBand[] = [];
  let groupIndex = 0;

  groups.forEach((groupWalls) => {
    if (groupWalls.length === 0) {
      return;
    }

    groupIndex += 1;
    const visibleWalls = groupWalls.filter((wall) => !shadowedWallIds.has(wall.id));
    if (visibleWalls.length === 0) {
      return;
    }

    const baseElevation = groupWalls[0].properties3D.baseElevation ?? 0;
    const wallHeight = Math.max(1, groupWalls[0].properties3D.height ?? 2700);
    const wallTop = baseElevation + wallHeight;
    const palette = wallPalette(groupWalls[0].material);

    visibleWalls.forEach((wall, wallIndex) => {
      const polygon: Point2D[][] = [computeRenderableWallPolygon(wall, joinsMap.get(wall.id))];
      const spans = openingSpansForWall(wall);
      const baseName = `wall-${groupIndex}-${wallIndex}`;

      if (spans.length === 0) {
        pushBandPolygons(
          bands,
          [polygon],
          baseElevation,
          wallHeight,
          palette,
          baseName,
          false,
          true,
          0,
        );
        return;
      }

      const heightBreaks = new Set<number>([baseElevation, wallTop]);
      spans.forEach((span) => {
        heightBreaks.add(Math.max(baseElevation, span.bottom));
        heightBreaks.add(Math.min(wallTop, span.top));
      });
      const sortedBreaks = [...heightBreaks].filter(Number.isFinite).sort((left, right) => left - right);

      for (let index = 0; index < sortedBreaks.length - 1; index += 1) {
        const bandBottom = sortedBreaks[index];
        const bandTop = sortedBreaks[index + 1];
        const bandHeight = bandTop - bandBottom;
        if (bandHeight <= EPSILON) {
          continue;
        }

        const activeSpans = spans.filter(
          (span) => span.bottom < bandTop - EPSILON && span.top > bandBottom + EPSILON
        );

        if (activeSpans.length === 0) {
          pushBandPolygons(
            bands,
            [polygon],
            bandBottom,
            bandHeight,
            palette,
            `${baseName}-b${index}`,
            false,
            bandTop >= wallTop - EPSILON,
            0,
          );
          continue;
        }

        const holes = activeSpans.map((span) => openingHoleRectWorld(wall, span));
        pushBandPolygons(
          bands,
          subtractOpeningHoles(polygon, holes),
          bandBottom,
          bandHeight,
          palette,
          `${baseName}-b${index}`,
          false,
          bandTop >= wallTop - EPSILON,
          0,
        );
      }
    });

    computeJunctionPatchPolygons(visibleWalls, joinsMap).forEach((patch, patchIndex) => {
      pushBandPolygons(
        bands,
        [[patch.polygon]],
        baseElevation,
        wallHeight,
        palette,
        `wall-${groupIndex}-patch-${patchIndex}`,
        false,
        true,
        0.8,
      );
    });
  });

  return bands;
}

export function buildIsometricWallBandsSignature(walls: Wall[]): string {
  return JSON.stringify(
    walls.map((wall) => ({
      id: wall.id,
      material: wall.material,
      thickness: wall.thickness,
      connectedWalls: wall.connectedWalls,
      startPoint: wall.startPoint,
      endPoint: wall.endPoint,
      interiorLine: wall.interiorLine,
      exteriorLine: wall.exteriorLine,
      startBevel: wall.startBevel ?? null,
      endBevel: wall.endBevel ?? null,
      properties3D: {
        baseElevation: wall.properties3D.baseElevation,
        height: wall.properties3D.height,
        materialId: wall.properties3D.materialId,
      },
      openings: wall.openings.map((opening) => ({
        id: opening.id,
        type: opening.type,
        position: opening.position,
        width: opening.width,
        height: opening.height,
        sillHeight: opening.sillHeight ?? null,
      })),
    }))
  );
}
