/**
 * The tags a selected unit with maker data shows at its stubs on the plan:
 * G / L / D, the field size and the joint, in the service colour. They stand
 * in a column just beyond the stubs, one under another on the sheet whatever
 * the unit's turn, each with a leader to its stub's tip.
 */
import { unitSpecificationFor } from '../../../data/unitSpecifications';
import type { HvacElement, Point2D } from '../../../types';

import { drainConnectionOf, unitConnectionOf, unitConnectionsFor } from './unitConnections';
import { unitHasDrainPump } from './unitDrainPump';
import { inchFractionText } from './units/hvacUnits';

export interface MakerConnectionTag {
  text: string;
  /** The stub's tip (unit frame). */
  tip: Point2D;
  axis: 1 | -1;
  colour: string;
}

/** Field-pipe tags at a maker unit's stubs: letter, size and joint, in the service colour. */
export function makerConnectionTags(
  element: Pick<HvacElement, 'type' | 'width' | 'depth' | 'height' | 'properties'>,
): MakerConnectionTag[] {
  const set = unitConnectionsFor(element);
  if (!set) return [];
  const spec = unitSpecificationFor(element);
  const property = (key: string) => {
    const value = element.properties?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const pumped = unitHasDrainPump(element);
  const tags: MakerConnectionTag[] = [];
  const add = (connection: ReturnType<typeof unitConnectionOf>, letter: string, sizeMm: number | null, colour: string, note: string) => {
    if (!connection) return;
    const size = letter === 'D' ? 'VP25' : sizeMm ? `${inchFractionText(sizeMm)}″` : '';
    tags.push({
      text: [letter, size, note].filter(Boolean).join(' '),
      tip: { x: connection.tipX, y: connection.y },
      axis: connection.axis,
      colour,
    });
  };
  const gas = unitConnectionOf(set, 'gas');
  const liquid = unitConnectionOf(set, 'liquid');
  add(gas, 'G', property('refrigerantGasPipeDiameterMm') ?? spec?.gasMm ?? (gas && !gas.inModel ? gas.outerDiameterMm : null), '#2f6f96', gas?.joint ?? '');
  add(liquid, 'L', property('refrigerantLiquidPipeDiameterMm') ?? spec?.liquidMm ?? (liquid && !liquid.inModel ? liquid.outerDiameterMm : null), '#9a6a2a', liquid?.joint ?? '');
  const drain = drainConnectionOf(set, pumped);
  add(drain, 'D', null, '#0f766e', pumped && drain?.kind === 'drain' ? 'pump' : 'gravity');
  return tags;
}

export interface PlacedConnectionTag extends MakerConnectionTag {
  /** Where the text is anchored (unit frame), and which end of it: away from the unit on the sheet. */
  at: Point2D;
  anchor: 'left' | 'right';
  /** The leader from the stub's tip to the text (unit frame). */
  leader: [Point2D, Point2D];
}

/**
 * The tags laid out for a unit turned `rotationDeg`: a column `gapMm` beyond
 * the farthest stub tip along the stubs, the tags `pitchMm` apart down the
 * sheet in the order their stubs come down it (no crossing leaders), text
 * running away from the unit.
 */
export function layoutConnectionTags(tags: readonly MakerConnectionTag[], rotationDeg: number,
  options: { pitchMm: number; gapMm: number }): PlacedConnectionTag[] {
  if (!tags.length) return [];
  const angle = (rotationDeg * Math.PI) / 180;
  const sin = Math.sin(angle); const cos = Math.cos(angle);
  // Down the sheet (world +y) in the unit frame; how far down the sheet a unit-frame point lies.
  const down = { x: sin, y: cos };
  const depth = (point: Point2D) => point.x * sin + point.y * cos;
  const axis = tags[0]!.axis;
  // How far out along the stubs a unit-frame point lies.
  const along = (point: Point2D) => point.x * axis;
  const tipsOut = Math.max(...tags.map((tag) => along(tag.tip)));
  const meanY = tags.reduce((sum, tag) => sum + tag.tip.y, 0) / tags.length;
  const ordered = [...tags].sort((a, b) => depth(a.tip) - depth(b.tip));
  const slots = ordered.map((_, index) => {
    const offset = (index - (ordered.length - 1) / 2) * options.pitchMm;
    return { x: axis * (tipsOut + options.gapMm) + down.x * offset, y: meanY + down.y * offset };
  });
  // A unit turned so its stubs point down the sheet stacks the column along them: keep all of it beyond the tips.
  const shortfall = tipsOut + options.gapMm - Math.min(...slots.map(along));
  if (shortfall > 0) for (const slot of slots) slot.x += axis * shortfall;
  // The text runs away from the unit on the sheet: the stubs' world x direction.
  const anchor: 'left' | 'right' = axis * cos >= -1e-9 ? 'left' : 'right';
  return ordered.map((tag, index) => ({ ...tag, at: slots[index]!, anchor, leader: [{ ...tag.tip }, slots[index]!] }));
}
