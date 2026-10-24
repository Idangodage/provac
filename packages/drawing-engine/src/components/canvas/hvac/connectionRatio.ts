/**
 * A VRF system's connection ratio: the indoor units' total capacity over the
 * outdoor unit's, against the range the manufacturer allows (a project
 * setting; 50–130 % by default, the usual VRF range: some ranges allow more
 * under conditions, so confirm with the maker). Capacities are the units'
 * nominal cooling kW (their capacityKw). The indoor units of a system are
 * found as Auto route finds them: the ones assigned to the outdoor unit (or
 * to its system), else, with a single outdoor unit, every indoor unit.
 * Pure: elements in, ratios and messages out.
 */
import type { HvacElement } from '../../../types';

import type { PipeRoutingSettings } from './pipeRoutingSettings';
import { ALL_PIPE_PORT_TYPES } from './unitPipePortModel';

export interface ConnectionRatio {
  outdoorId: string;
  outdoorLabel: string;
  indoorIds: string[];
  indoorKw: number;
  outdoorKw: number;
  percent: number;
  minPercent: number;
  maxPercent: number;
  /** Indoor units with no capacity to count (the ratio leaves them out). */
  unrated: number;
}

type RatioRange = Pick<PipeRoutingSettings, 'connectionRatioMinPercent' | 'connectionRatioMaxPercent'>;

const isOutdoor = (element: HvacElement) => element.type === 'outdoor-unit' || element.category === 'outdoor-unit';
const capacityOf = (element: HvacElement) => {
  const value = element.properties.capacityKw;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
};
const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

/** Every outdoor unit with a capacity and indoor units: its connection ratio. */
export function connectionRatios(elements: readonly HvacElement[], range: RatioRange): ConnectionRatio[] {
  const outdoors = elements.filter((element) => isOutdoor(element) && ALL_PIPE_PORT_TYPES.has(element.type));
  const indoors = elements.filter((element) => !isOutdoor(element) && ALL_PIPE_PORT_TYPES.has(element.type));
  return outdoors.flatMap((outdoor) => {
    const outdoorKw = capacityOf(outdoor);
    if (!outdoorKw) return [];
    const system = text(outdoor.properties.systemId);
    const served = indoors.filter((indoor) => {
      const assigned = text(indoor.properties.outdoorUnitId);
      if (assigned) return assigned === outdoor.id;
      const indoorSystem = text(indoor.properties.systemId);
      if (indoorSystem) return indoorSystem === system;
      return outdoors.length === 1;
    });
    if (!served.length) return [];
    const rated = served.filter((indoor) => capacityOf(indoor) !== null);
    const indoorKw = rated.reduce((sum, indoor) => sum + capacityOf(indoor)!, 0);
    return [{
      outdoorId: outdoor.id, outdoorLabel: outdoor.label || outdoor.modelLabel || outdoor.id, indoorIds: served.map((indoor) => indoor.id),
      indoorKw, outdoorKw, percent: (indoorKw / outdoorKw) * 100,
      minPercent: range.connectionRatioMinPercent, maxPercent: range.connectionRatioMaxPercent, unrated: served.length - rated.length,
    }];
  });
}

/** The ratios outside their range. */
export function connectionRatioProblems(elements: readonly HvacElement[], range: RatioRange): ConnectionRatio[] {
  return connectionRatios(elements, range).filter((ratio) => ratio.percent > ratio.maxPercent + 1e-6 || ratio.percent < ratio.minPercent - 1e-6);
}

const kw = (value: number) => `${value.toFixed(1)} kW`;

/** What is wrong with a ratio out of range, and what puts it right. */
export function connectionRatioMessage(ratio: ConnectionRatio): string {
  const units = `${ratio.indoorIds.length} indoor unit${ratio.indoorIds.length === 1 ? '' : 's'}`;
  const share = `${units} total ${kw(ratio.indoorKw)}: ${Math.round(ratio.percent)} % of its ${kw(ratio.outdoorKw)} (allowed ${ratio.minPercent}–${ratio.maxPercent} %)`;
  const unrated = ratio.unrated ? ` ${ratio.unrated} unit${ratio.unrated === 1 ? ' has' : 's have'} no capacity and ${ratio.unrated === 1 ? 'is' : 'are'} not counted.` : '';
  return ratio.percent > ratio.maxPercent
    ? `${ratio.outdoorLabel} is too small for its system: its ${share}. Use a larger outdoor unit, or split the indoor units over two systems.${unrated}`
    : `${ratio.outdoorLabel} is too large for its system: its ${share}. Use a smaller outdoor unit, or add indoor units to the system.${unrated}`;
}
