/**
 * Where a kept Auto duct design winds round to reach a terminal: the duct
 * from the unit's collar to the terminal (along the trunk, through each
 * take-off, split or spigot, then its own run and runout) against the
 * straight distance from the collar's lip to the terminal's spigot. Past
 * WINDING_RATIO times — and longer by WINDING_EXTRA_MM or more, so a
 * terminal right by the unit is not flagged for its runout — the design is
 * clean but not sensible, and the card says so.
 */
import type { HvacElement } from '../../../../types';

import type { AutoDuctIssue } from './ductAutoContext';
import { ductParentRunId, readDuctRunSpec, type DuctPoint3, type DuctRunSpec } from './ductTypes';

/** A branch over this many times the straight distance from the collar to its terminal winds round. */
export const WINDING_RATIO = 3;
/** …and this much longer than straight at least (mm). */
export const WINDING_EXTRA_MM = 1500;

const length3 = (a: DuctPoint3, b: DuctPoint3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const pathLength = (spec: DuctRunSpec) => spec.path.slice(1).reduce((total, point, index) => total + length3(spec.path[index]!, point), 0);
/** How far along a run's path its leg `legIndex` reaches at `stationMm` (mm). */
const along = (spec: DuctRunSpec, legIndex: number, stationMm: number) =>
  spec.path.slice(1, legIndex + 1).reduce((total, point, index) => total + length3(spec.path[index]!, point), 0) + stationMm;
const metres = (mm: number) => `${(mm / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} m`;

/** The kept design's terminals it winds round to reach, each as a warning naming it (`labels`: terminal id → label). */
export function windingIssues(runs: readonly HvacElement[], labels: ReadonlyMap<string, string>): AutoDuctIssue[] {
  const specs = new Map(runs.flatMap((run) => {
    const spec = readDuctRunSpec(run);
    return spec ? [[run.id, spec] as const] : [];
  }));
  /** The duct from the unit's collar to the start of run `id`, and the collar's lip. */
  const fromCollar = (id: string, depth = 0): { mm: number; lip: DuctPoint3 } | null => {
    const spec = specs.get(id);
    if (!spec || depth > 32) return null;
    if (spec.start.kind === 'unit-port') return { mm: 0, lip: spec.path[0]! };
    const parentId = ductParentRunId(spec);
    const parent = parentId ? specs.get(parentId) : undefined;
    const above = parent ? fromCollar(parentId!, depth + 1) : null;
    if (!parent || !above) return null;
    const at = spec.start.kind === 'tap' ? along(parent, spec.start.legIndex, spec.start.stationMm) : pathLength(parent);
    return { mm: above.mm + at, lip: above.lip };
  };
  const issues: AutoDuctIssue[] = [];
  for (const [id, spec] of specs) {
    if (spec.end.kind !== 'terminal') continue;
    const above = fromCollar(id);
    if (!above) continue;
    const ductMm = above.mm + pathLength(spec);
    const spigot = spec.path[spec.path.length - 1]!;
    const straightMm = Math.hypot(spigot.x - above.lip.x, spigot.y - above.lip.y);
    if (straightMm <= 0 || ductMm <= WINDING_RATIO * straightMm || ductMm - straightMm < WINDING_EXTRA_MM) continue;
    const name = labels.get(spec.end.terminalId) ?? 'A terminal';
    issues.push({
      code: 'DU_AUTO_WINDING', severity: 'warning', service: spec.service, runId: id,
      message: `${name}: its duct runs ${metres(ductMm)} to reach it, ${(ductMm / straightMm).toFixed(1)} times the ${metres(straightMm)} straight from the collar (it winds round to come at its collar straight). Moving it a little, or a top collar (its runout then comes down from above), may give a shorter design.`,
    });
  }
  return issues;
}
