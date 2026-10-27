/**
 * Whether an indoor unit drains through a built-in pump. Every ducted unit
 * (the project's rule, 26 October 2026) and every cassette has one unless its
 * own Drain pump setting says otherwise; other types drain by gravity unless
 * set. The port models (which outlet the drain leaves from) and the drain
 * design both read it from here.
 */
import { unitSpecificationFor } from '../../../data/unitSpecifications';
import type { HvacElement } from '../../../types';

/** Every ducted unit (the project's rule) and every cassette ships with a built-in drain pump. */
export function pumpedByType(type: HvacElement['type']): boolean {
  return type === 'ceiling-cassette-ac' || type === 'ducted-ac';
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'yes') return true;
  if (value === 'false' || value === 'no') return false;
  return null;
}

/**
 * The unit's own Drain pump setting, or null for its type default. A setting
 * made in the field carries `drainPumpSetBy: 'user'`; one stored before that
 * was recorded counts when it differs from the maker sheet's (a catalogue
 * unit stored the sheet's value, e.g. FDU224 "gravity").
 */
export function drainPumpChoice(element: Pick<HvacElement, 'properties'>): boolean | null {
  const properties = element.properties ?? {};
  const stored = readBoolean(properties.hasDrainPump);
  if (stored === null) return null;
  if (properties.drainPumpSetBy === 'user') return stored;
  return unitSpecificationFor(element)?.drain.pump === stored ? null : stored;
}

/** Whether the unit drains through a built-in pump: its own setting, else its type's. */
export function unitHasDrainPump(element: Pick<HvacElement, 'type' | 'properties'>): boolean {
  return drainPumpChoice(element) ?? pumpedByType(element.type);
}
