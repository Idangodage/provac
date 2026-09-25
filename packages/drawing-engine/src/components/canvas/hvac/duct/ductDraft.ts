/**
 * The one builder behind the duct tool's live preview, its commit and the
 * scripted debug handle: a run from a unit collar through the clicked points.
 * Because preview and commit share it, what is drawn is what is stored.
 */
import type { HvacElement, Point2D } from '../../../../types';

import type { DuctAirPort } from './ductAirPorts';
import { add, dot, scale, unit } from './ductGeometry';
import { buildDuctRunElement, type DuctConstruction, type DuctRunSpec } from './ductTypes';

export type DuctAngleMode = '90' | '45';

export interface DuctDraftInput {
  port: DuctAirPort;
  /** Leg end points after the collar lip, in order. */
  points: Point2D[];
  /** Clear section; defaults to the collar (the duct slips over it). */
  widthMm?: number;
  heightMm?: number;
  construction?: DuctConstruction;
  end?: 'end-cap' | 'open';
}

/** Path z is the clear bottom, so the centreline sits on the collar centre. */
export function buildDuctRunSpecFromPort(input: DuctDraftInput): DuctRunSpec {
  const widthMm = input.widthMm ?? input.port.widthMm;
  const heightMm = input.heightMm ?? input.port.heightMm;
  const z = input.port.lip.z - heightMm / 2;
  const path = [{ x: input.port.lip.x, y: input.port.lip.y, z }, ...input.points.map((point) => ({ x: point.x, y: point.y, z }))];
  return {
    version: 1,
    service: input.port.kind,
    construction: input.construction ?? 'gi-bare',
    path,
    legs: path.slice(1).map(() => ({ widthMm, heightMm })),
    insulationThicknessMm: 0,
    pressureClassPa: null,
    jointSystem: null,
    start: { kind: 'unit-port', unitId: input.port.unitId, portId: input.port.portId, connector: true },
    end: input.end === 'open' ? { kind: 'open' } : { kind: 'end-cap' },
    nodeOverrides: {},
    locked: false,
  };
}

export function buildDuctRunDraftElement(input: DuctDraftInput, id: string): HvacElement {
  const element = buildDuctRunElement(buildDuctRunSpecFromPort(input), { id });
  return { ...element, id, rotation: 0, supplyZoneRatio: 0, category: element.category ?? 'accessory', properties: element.properties ?? {} };
}

function rotate(direction: Point2D, degrees: number): Point2D {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: direction.x * Math.cos(radians) - direction.y * Math.sin(radians),
    y: direction.x * Math.sin(radians) + direction.y * Math.cos(radians),
  };
}

export interface ConstrainedLeg {
  point: Point2D;
  direction: Point2D;
  lengthMm: number;
}

/**
 * Snap the next leg end to the allowed directions from the anchor.
 *  - first leg: along the collar's outward normal only;
 *  - later legs: straight on or a 90° turn (plus ±45° in 45° mode), never back.
 * Lengths round to `stepMm`.
 */
export function constrainDuctLeg(
  anchor: Point2D,
  cursor: Point2D,
  previousDirection: Point2D,
  options: { first: boolean; mode: DuctAngleMode; stepMm?: number },
): ConstrainedLeg {
  const step = options.stepMm ?? 10;
  const base = unit(previousDirection);
  const candidates = options.first
    ? [base]
    : [0, 90, -90, ...(options.mode === '45' ? [45, -45] : [])].map((angle) => rotate(base, angle));
  const offset = { x: cursor.x - anchor.x, y: cursor.y - anchor.y };
  let best = candidates[0]!;
  let bestProjection = -Infinity;
  for (const candidate of candidates) {
    const projection = dot(offset, candidate);
    if (projection > bestProjection) {
      bestProjection = projection;
      best = candidate;
    }
  }
  const lengthMm = Math.max(0, Math.round(Math.max(0, bestProjection) / step) * step);
  const direction = { x: Math.round(best.x * 1e9) / 1e9, y: Math.round(best.y * 1e9) / 1e9 };
  return { point: add(anchor, scale(direction, lengthMm)), direction, lengthMm };
}
