/**
 * A radius take-off as the tee it is: one piece with its section of the main, its three ends joints. A is the main from
 * the joint toward the main's start to the branch's centre, B the main from that centre to the joint past it, C the
 * branch from the main's outside wall to its joint (its damper included). What a drawing has, what it can be and where
 * each end is, for the card's fields and the drawing's grips.
 */
import type { HvacElement, Point2D } from '../../../../types';

import { radiusCollarMm } from './ductBranches';
import { getDuctRunPlan } from './ductFabricationPlanner';
import { add, dot, ductLegs, scale, sub, type DuctLegGeometry } from './ductGeometry';
import { radiusTakeoffShape } from './ductRadiusTakeoff';
import type { DuctDesignSettings } from './ductSettings';
import { isRoundLeg, readDuctRunSpec, type DuctLeg, type DuctTapStart, type DuctTeeLengths } from './ductTypes';

export interface DuctTeeFigures {
  start: DuctTapStart;
  firstLeg: DuctLeg;
  mainSection: DuctLeg;
  /** The main's leg it stands on. */
  leg: DuctLegGeometry;
  /** A, B and C as drawn (mm). */
  beforeMm: number;
  afterMm: number;
  branchMm: number;
  /** The shortest each can be (mm): the opening with its margin, the sweep with its neck and damper. */
  least: { beforeMm: number; afterMm: number; branchMm: number };
  /** On the main's outside wall, at the branch's centre, and the way the branch leaves it (plan). */
  wallPoint: Point2D;
  direction: Point2D;
  /** The branch's centre on the main's centreline (plan). */
  centre: Point2D;
  /** The tee's clear bottom (the branch's and the main's). */
  bottomZ: number;
}

/** The shortest a tee's three lengths can be (mm). */
export function teeLeastMm(start: Pick<DuctTapStart, 'radiusRatio' | 'vcd'>, firstLeg: DuctLeg, settings: Pick<DuctDesignSettings, 'tapCollarMm' | 'tapWindowMarginMm' | 'vcdLengthMm'>): DuctTeeFigures['least'] {
  const shape = radiusTakeoffShape(firstLeg.widthMm, start.radiusRatio);
  const damper = start.vcd ? settings.vcdLengthMm : 0;
  return {
    beforeMm: firstLeg.widthMm / 2 + shape.throatMm + settings.tapWindowMarginMm,
    afterMm: firstLeg.widthMm / 2 + settings.tapWindowMarginMm,
    branchMm: radiusCollarMm({ radiusRatio: start.radiusRatio }, firstLeg, settings) + damper,
  };
}

/** The tee a run's radius take-off makes, or null: the run has none, or stands where one cannot be told. */
export function ductTeeFigures(scene: readonly HvacElement[], settings: DuctDesignSettings, runId: string): DuctTeeFigures | null {
  const element = scene.find((candidate) => candidate.id === runId);
  const spec = element ? readDuctRunSpec(element) : null;
  const start = spec?.start;
  if (!element || !spec || !start || start.kind !== 'tap' || start.style !== 'radius') return null;
  const parent = scene.find((candidate) => candidate.id === start.parentRunId);
  const parentSpec = parent ? readDuctRunSpec(parent) : null;
  const plan = getDuctRunPlan(element, scene, settings);
  const parentPlan = parent ? getDuctRunPlan(parent, scene, settings) : null;
  const leg = parentSpec ? ductLegs(parentSpec)[start.legIndex] : undefined;
  const mainSection = parentSpec?.legs[start.legIndex];
  const firstLeg = spec.legs[0];
  if (!plan?.tap || !parentPlan || !leg || !mainSection || !firstLeg || isRoundLeg(mainSection) || isRoundLeg(firstLeg) || leg.vertical || leg.sloped) return null;
  const along = (point: Point2D) => dot(sub(point, leg.start), leg.direction);
  const piece = parentPlan.pieces.find((candidate) => candidate.legIndex === start.legIndex && candidate.kind === 'straight'
    && Math.min(along(candidate.start), along(candidate.end)) <= start.stationMm && Math.max(along(candidate.start), along(candidate.end)) >= start.stationMm);
  const collar = plan.pieces.find((candidate) => candidate.kind === 'takeoff');
  if (!piece || !collar) return null;
  const damper = plan.pieces[plan.pieces.indexOf(collar) + 1];
  return {
    start, firstLeg, mainSection, leg,
    beforeMm: start.stationMm - Math.min(along(piece.start), along(piece.end)),
    afterMm: Math.max(along(piece.start), along(piece.end)) - start.stationMm,
    branchMm: collar.lengthMm + (damper?.kind === 'damper' ? damper.lengthMm : 0),
    least: teeLeastMm(start, firstLeg, settings),
    wallPoint: plan.tap.wallPoint, direction: plan.tap.direction,
    centre: add(leg.start, scale(leg.direction, start.stationMm)),
    bottomZ: plan.tap.bottomZ,
  };
}

/** The tee's three joints as model points, their ends at its bottom and top: what a card beside it keeps clear of (its grips). */
export function teeJointPoints(figures: DuctTeeFigures): Array<{ x: number; y: number; z: number }> {
  const { leg, centre, wallPoint, direction, mainSection, firstLeg, bottomZ } = figures;
  const across = { x: -leg.direction.y, y: leg.direction.x };
  const ends: Point2D[] = [];
  for (const along of [-figures.beforeMm, figures.afterMm]) {
    const at = add(centre, scale(leg.direction, along));
    ends.push(add(at, scale(across, mainSection.widthMm / 2)), sub(at, scale(across, mainSection.widthMm / 2)));
  }
  const joint = add(wallPoint, scale(direction, figures.branchMm));
  ends.push(add(joint, scale(leg.direction, firstLeg.widthMm / 2)), sub(joint, scale(leg.direction, firstLeg.widthMm / 2)));
  const low = Math.min(bottomZ, leg.start.z);
  const high = Math.max(bottomZ + firstLeg.heightMm, leg.start.z + mainSection.heightMm);
  return ends.flatMap((point) => [{ ...point, z: low }, { ...point, z: high }]);
}

/**
 * A tee with one main end set: the other is held where it is, so setting one joint never moves the other.
 */
export function teeWithMainEnd(figures: Pick<DuctTeeFigures, 'start' | 'beforeMm' | 'afterMm'>, end: 'beforeMm' | 'afterMm', value: number): DuctTeeLengths {
  return { ...figures.start.tee, beforeMm: figures.beforeMm, afterMm: figures.afterMm, [end]: value };
}
