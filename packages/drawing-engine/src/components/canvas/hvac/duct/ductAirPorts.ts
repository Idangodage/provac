/**
 * Air connection ports of ducted units, in world millimetres.
 *
 * Resolution order:
 *  1. `properties.airPorts` on the element (explicit data);
 *  2. MEASURED_UNIT_AIR_PORTS by model code (collars measured on the real model);
 *  3. the procedural ducted-unit openings — only a fallback, flagged unverified,
 *     because they do not match any real unit's collars.
 *
 * Local frame (same as the plan renderer and the GLB placement): origin at the
 * element's footprint centre, X/Y along the unrotated element axes (model space,
 * Y down), z measured up from the unit's bottom face (= element.elevation).
 */
import type { HvacElement, Point2D } from '../../../../types';
import { buildDuctedIndoorUnitModel, getDuctedIndoorUnitOpeningPlanProjection } from '../ductedIndoorUnitModel';

import type { DuctRuleProvenance } from './ductSources';
import type { DuctPoint3, DuctService } from './ductTypes';

export interface LocalAirPortSpec {
  id: string;
  kind: DuctService;
  /** Centre of the collar lip in the unit's local frame (z from the unit bottom). */
  lip: DuctPoint3;
  /** Outward direction in the local plan frame (axis-aligned unit vector). */
  normal: Point2D;
  /** Collar outside dimensions = the duct's clear inside section (mm). */
  widthMm: number;
  heightMm: number;
  /** Collar projection from the casing face (mm). */
  collarDepthMm: number;
}

export interface DuctAirPort {
  unitId: string;
  portId: string;
  kind: DuctService;
  lip: DuctPoint3;
  normal: Point2D;
  widthMm: number;
  heightMm: number;
  collarDepthMm: number;
  /** Plan endpoints of the lip edge (for markers and hit testing). */
  edgeA: Point2D;
  edgeB: Point2D;
  source: 'element' | 'measured' | 'procedural';
  provenance: DuctRuleProvenance;
  /** A round spigot (an air terminal's): its diameter; width and height equal it. */
  diameterMm?: number;
}

/**
 * Collars measured on the MEPcontent MACO VRF GLB (bounding box 1084 × 697 ×
 * 300, rendered centred with its bottom at the element elevation). Face
 * assignment confirmed against the MHI dimensions: pressure side ≈680 × 170,
 * suction side ≈660 × 200.
 */
export const MEASURED_UNIT_AIR_PORTS: Record<string, readonly LocalAirPortSpec[]> = {
  'FDUM22KXE6F-W': [
    { id: 'supply', kind: 'supply', lip: { x: -117, y: -348.5, z: 152 }, normal: { x: 0, y: -1 }, widthMm: 674, heightMm: 164, collarDepthMm: 30 },
    { id: 'return', kind: 'return', lip: { x: -117, y: 348.5, z: 139 }, normal: { x: 0, y: 1 }, widthMm: 654, heightMm: 194, collarDepthMm: 30 },
  ],
};

/** What port resolution reads from a unit. */
type UnitShape = Pick<HvacElement, 'type' | 'width' | 'depth' | 'height' | 'properties'>;

const MEASURED_PROVENANCE: DuctRuleProvenance = {
  sourceId: 'fdum22-glb-measured', verified: true, reference: 'docs/hvac-duct-smacna-research.md, "Unit air ports"',
};
const PROCEDURAL_PROVENANCE: DuctRuleProvenance = {
  sourceId: 'fabricator-practice', verified: false,
  note: 'Procedural placeholder openings; this unit has no measured collars (DU_MOUTH_APPROX).',
};
const ELEMENT_PROVENANCE: DuctRuleProvenance = { sourceId: 'project-configuration', verified: false, note: 'airPorts stored on the element.' };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function modelCodeOf(element: Pick<HvacElement, 'properties'>): string | null {
  for (const key of ['modelCode', 'model']) {
    const value = element.properties[key];
    if (typeof value === 'string' && MEASURED_UNIT_AIR_PORTS[value]) return value;
  }
  return null;
}

function readElementAirPorts(element: Pick<HvacElement, 'properties'>): LocalAirPortSpec[] | null {
  const raw = element.properties.airPorts;
  if (!Array.isArray(raw)) return null;
  const ports = raw.flatMap((entry): LocalAirPortSpec[] => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Record<string, unknown>;
    const lip = candidate.lip as Record<string, unknown> | undefined;
    const normal = candidate.normal as Record<string, unknown> | undefined;
    if (typeof candidate.id !== 'string' || !lip || !normal) return [];
    if (![lip.x, lip.y, lip.z, normal.x, normal.y, candidate.widthMm, candidate.heightMm].every(finite)) return [];
    return [{
      id: candidate.id,
      kind: candidate.kind === 'return' ? 'return' : 'supply',
      lip: { x: lip.x as number, y: lip.y as number, z: lip.z as number },
      normal: { x: normal.x as number, y: normal.y as number },
      widthMm: candidate.widthMm as number,
      heightMm: candidate.heightMm as number,
      collarDepthMm: finite(candidate.collarDepthMm) ? candidate.collarDepthMm : 30,
    }];
  });
  return ports.length > 0 ? ports : null;
}

function proceduralAirPorts(element: UnitShape): LocalAirPortSpec[] {
  if (element.type !== 'ducted-ac') return [];
  const model = buildDuctedIndoorUnitModel(element);
  return model.airOpenings.map((opening) => {
    const projection = getDuctedIndoorUnitOpeningPlanProjection(model, opening);
    return {
      id: opening.kind,
      kind: opening.kind,
      lip: { x: opening.x, y: projection.collarOuterEdgeY, z: opening.z },
      normal: { x: 0, y: projection.outwardDirectionY },
      widthMm: opening.openingWidth,
      heightMm: opening.openingHeight,
      collarDepthMm: opening.collarProjection,
    };
  });
}

function rotate(point: Point2D, angleDeg: number): Point2D {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

/** Local port → world port for a placed unit. */
export function toWorldAirPort(
  element: Pick<HvacElement, 'id' | 'position' | 'width' | 'depth' | 'rotation' | 'elevation'>,
  local: LocalAirPortSpec,
  source: DuctAirPort['source'],
): DuctAirPort {
  const centre = { x: element.position.x + element.width / 2, y: element.position.y + element.depth / 2 };
  const rotation = element.rotation ?? 0;
  const toWorld = (point: Point2D): Point2D => {
    const rotated = rotate(point, rotation);
    return { x: centre.x + rotated.x, y: centre.y + rotated.y };
  };
  const lipPlan = toWorld(local.lip);
  const normal = rotate(local.normal, rotation);
  const length = Math.hypot(normal.x, normal.y) || 1;
  const tangent = { x: -local.normal.y, y: local.normal.x };
  const half = local.widthMm / 2;
  return {
    unitId: element.id,
    portId: local.id,
    kind: local.kind,
    lip: { x: lipPlan.x, y: lipPlan.y, z: element.elevation + local.lip.z },
    normal: { x: normal.x / length, y: normal.y / length },
    widthMm: local.widthMm,
    heightMm: local.heightMm,
    collarDepthMm: local.collarDepthMm,
    edgeA: toWorld({ x: local.lip.x - tangent.x * half, y: local.lip.y - tangent.y * half }),
    edgeB: toWorld({ x: local.lip.x + tangent.x * half, y: local.lip.y + tangent.y * half }),
    source,
    provenance: source === 'measured' ? MEASURED_PROVENANCE : source === 'element' ? ELEMENT_PROVENANCE : PROCEDURAL_PROVENANCE,
  };
}

/** The unit's ports in its local frame, with where they came from. */
export function resolveLocalAirPorts(element: UnitShape): { ports: LocalAirPortSpec[]; source: DuctAirPort['source'] } {
  const own = readElementAirPorts(element);
  if (own) return { ports: own, source: 'element' };
  const code = modelCodeOf(element);
  if (code) return { ports: [...MEASURED_UNIT_AIR_PORTS[code]!], source: 'measured' };
  return { ports: proceduralAirPorts(element), source: 'procedural' };
}

export function resolveUnitAirPorts(element: HvacElement): DuctAirPort[] {
  const { ports, source } = resolveLocalAirPorts(element);
  return ports.map((port) => toWorldAirPort(element, port, source));
}

/** Every air port in the scene (ducted units only for now). */
export function listAirPorts(elements: readonly HvacElement[]): DuctAirPort[] {
  return elements.flatMap((element) => (element.type === 'ducted-ac' ? resolveUnitAirPorts(element) : []));
}

export function findAirPort(elements: readonly HvacElement[], unitId: string, portId: string): DuctAirPort | null {
  const unit = elements.find((element) => element.id === unitId);
  if (!unit) return null;
  return resolveUnitAirPorts(unit).find((port) => port.portId === portId) ?? null;
}
