/**
 * PVC condensate pipe catalogue and sizing.
 *
 * Sizing follows the capacity method (IMC 307.2.2 / UPC 814.3): the connected
 * cooling capacity upstream of a pipe sets its minimum internal diameter; the
 * pipe is never smaller than the unit outlets it serves and never gets smaller
 * toward the discharge. A Manning partial-flow check confirms the chosen size at
 * the solved fall (condensate flows are small, so it almost never governs, but
 * a professional tool states it rather than assuming it).
 */
import type { CondensateDesignSettings } from './condensateSettings';
import type { CondensatePipeSystemId } from './condensateTypes';

export interface CondensatePipeSize {
  /** Label printed on drawings and in the BOM ("32", "VP25", "3/4\""). */
  nominalSize: string;
  outerDiameterMm: number;
  innerDiameterMm: number;
}

export interface CondensatePipeSystem {
  id: CondensatePipeSystemId;
  label: string;
  standard: string;
  verified: boolean;
  sizes: CondensatePipeSize[];
}

/**
 * Dimensions: JIS K 6741 VP and ASTM D1785 Sch 40 are published nominal walls.
 * BS EN 1329-1 metric waste walls vary by application area; the values below
 * are typical and flagged unverified until checked against the standard.
 */
export const CONDENSATE_PIPE_SYSTEMS: Record<CondensatePipeSystemId, CondensatePipeSystem> = {
  'bs-en-1329': {
    id: 'bs-en-1329',
    label: 'Metric uPVC waste (BS EN 1329)',
    standard: 'BS EN 1329-1',
    verified: false,
    sizes: [
      { nominalSize: '21.5', outerDiameterMm: 21.5, innerDiameterMm: 18.5 },
      { nominalSize: '32', outerDiameterMm: 32, innerDiameterMm: 28.4 },
      { nominalSize: '40', outerDiameterMm: 40, innerDiameterMm: 36.2 },
      { nominalSize: '50', outerDiameterMm: 50, innerDiameterMm: 46 },
      { nominalSize: '63', outerDiameterMm: 63, innerDiameterMm: 58.6 },
    ],
  },
  'jis-vp': {
    id: 'jis-vp',
    label: 'JIS PVC VP',
    standard: 'JIS K 6741',
    verified: true,
    sizes: [
      { nominalSize: 'VP20', outerDiameterMm: 26, innerDiameterMm: 20.6 },
      { nominalSize: 'VP25', outerDiameterMm: 32, innerDiameterMm: 25.8 },
      { nominalSize: 'VP30', outerDiameterMm: 38, innerDiameterMm: 31.8 },
      { nominalSize: 'VP40', outerDiameterMm: 48, innerDiameterMm: 40.8 },
      { nominalSize: 'VP50', outerDiameterMm: 60, innerDiameterMm: 51.8 },
    ],
  },
  'astm-sch40': {
    id: 'astm-sch40',
    label: 'PVC Schedule 40 (ASTM D1785)',
    standard: 'ASTM D1785',
    verified: true,
    sizes: [
      { nominalSize: '3/4"', outerDiameterMm: 26.67, innerDiameterMm: 20.93 },
      { nominalSize: '1"', outerDiameterMm: 33.4, innerDiameterMm: 26.64 },
      { nominalSize: '1-1/4"', outerDiameterMm: 42.16, innerDiameterMm: 35.04 },
      { nominalSize: '1-1/2"', outerDiameterMm: 48.26, innerDiameterMm: 40.9 },
      { nominalSize: '2"', outerDiameterMm: 60.33, innerDiameterMm: 52.51 },
    ],
  },
};

export function getCondensatePipeSystem(id: CondensatePipeSystemId): CondensatePipeSystem {
  return CONDENSATE_PIPE_SYSTEMS[id] ?? CONDENSATE_PIPE_SYSTEMS['bs-en-1329'];
}

/** Minimum internal diameter for a connected capacity; above the table the last row is used and flagged. */
export function minimumInnerDiameterForCapacity(
  capacityKw: number,
  settings: Pick<CondensateDesignSettings, 'capacityTable'>,
): { minInnerDiameterMm: number; beyondTable: boolean } {
  const table = settings.capacityTable;
  for (const row of table) {
    if (capacityKw <= row.maxCapacityKw) return { minInnerDiameterMm: row.minInnerDiameterMm, beyondTable: false };
  }
  const last = table[table.length - 1];
  return { minInnerDiameterMm: last ? last.minInnerDiameterMm : 50.8, beyondTable: true };
}

/**
 * Full-bore Manning capacity at a given fill ratio for a circular pipe.
 * Returns litres per hour.
 */
export function manningCapacityLitresPerHour(innerDiameterMm: number, slopePercent: number, fillRatio: number, manningN: number): number {
  const d = innerDiameterMm / 1000;
  const s = Math.max(0, slopePercent) / 100;
  if (!(d > 0) || !(s > 0) || !(manningN > 0)) return 0;
  const y = Math.min(1, Math.max(0.01, fillRatio));
  // Central angle of the wetted segment.
  const theta = 2 * Math.acos(1 - 2 * y);
  const area = (d * d / 8) * (theta - Math.sin(theta));
  const perimeter = (d * theta) / 2;
  const hydraulicRadius = area / perimeter;
  const flowM3s = (1 / manningN) * area * Math.pow(hydraulicRadius, 2 / 3) * Math.sqrt(s);
  return flowM3s * 1000 * 3600;
}

export interface CondensateSizeSelection {
  size: CondensatePipeSize;
  designFlowLitresPerHour: number;
  capacityLitresPerHour: number;
  reasons: string[];
  beyondTable: boolean;
}

export interface CondensateSizeInput {
  upstreamCapacityKw: number;
  /** Largest unit drain outlet outer diameter feeding this pipe (mm). */
  largestOutletOuterDiameterMm: number;
  upstreamUnitCount: number;
  slopePercent: number;
  /** Floor imposed by downstream-monotone sizing of an upstream pipe (mm OD). */
  minimumOuterDiameterMm?: number;
}

/** Smallest catalogue size satisfying capacity, outlet, grouping and hydraulic rules. */
export function selectCondensatePipeSize(
  input: CondensateSizeInput,
  settings: CondensateDesignSettings,
): CondensateSizeSelection {
  const system = getCondensatePipeSystem(settings.pipeSystem);
  const reasons: string[] = [];
  const { minInnerDiameterMm, beyondTable } = minimumInnerDiameterForCapacity(input.upstreamCapacityKw, settings);
  const designFlow = input.upstreamCapacityKw * settings.condensateLitresPerHourPerKw;
  const outletFloor = Math.max(0, input.largestOutletOuterDiameterMm - 1);
  const groupedFloor = input.upstreamUnitCount >= 2 && settings.groupedMainMinOuterDiameterMm
    ? settings.groupedMainMinOuterDiameterMm - 0.5
    : 0;
  const monotoneFloor = Math.max(0, (input.minimumOuterDiameterMm ?? 0) - 0.01);
  let chosen: CondensatePipeSize | null = null;
  let chosenCapacity = 0;
  for (const size of system.sizes) {
    if (size.innerDiameterMm + 1e-6 < minInnerDiameterMm) continue;
    if (size.outerDiameterMm < outletFloor) continue;
    if (size.outerDiameterMm < groupedFloor) continue;
    if (size.outerDiameterMm < monotoneFloor) continue;
    const capacity = manningCapacityLitresPerHour(size.innerDiameterMm, input.slopePercent, settings.maxFillRatio, settings.manningN);
    if (capacity < designFlow) continue;
    chosen = size;
    chosenCapacity = capacity;
    break;
  }
  const largest = system.sizes[system.sizes.length - 1]!;
  if (!chosen) {
    chosen = largest;
    chosenCapacity = manningCapacityLitresPerHour(largest.innerDiameterMm, input.slopePercent, settings.maxFillRatio, settings.manningN);
    reasons.push(`No ${system.label} size satisfies every rule; the largest (${largest.nominalSize}) is used and needs review.`);
  }
  reasons.push(`${input.upstreamCapacityKw.toFixed(1)} kW connected → min ID ${minInnerDiameterMm.toFixed(1)} mm`);
  if (outletFloor > 0) reasons.push(`not smaller than the ${input.largestOutletOuterDiameterMm.toFixed(0)} mm unit outlet`);
  if (groupedFloor > 0) reasons.push(`grouped main ≥ ${settings.groupedMainMinOuterDiameterMm} mm OD`);
  if (beyondTable) reasons.push('capacity beyond the sizing table');
  return {
    size: chosen,
    designFlowLitresPerHour: designFlow,
    capacityLitresPerHour: chosenCapacity,
    reasons,
    beyondTable,
  };
}
