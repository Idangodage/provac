/**
 * The tags a selected unit with maker data shows at its stubs on the plan:
 * G / L / D, the field size and the joint, in the service colour, laid just
 * beyond each tip (unit frame).
 */
import { unitSpecificationFor } from '../../../data/unitSpecifications';
import type { HvacElement, Point2D } from '../../../types';

import { drainConnectionOf, unitConnectionOf, unitConnectionsFor } from './unitConnections';
import { unitHasDrainPump } from './unitDrainPump';
import { inchFractionText } from './units/hvacUnits';

export interface MakerConnectionTag {
  text: string;
  /** Where the tag starts (unit frame): 30 mm beyond the stub's tip. */
  at: Point2D;
  axis: 1 | -1;
  colour: string;
}

/** Field-pipe tags at a maker unit's stubs (unit frame): letter, size and joint, in the service colour. */
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
      at: { x: connection.tipX + connection.axis * 30, y: connection.y },
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

