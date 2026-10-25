/**
 * A duct system as a tree of rows, the way the unit panel draws it: each run's
 * sections in the order the air meets them (take-off to take-off), and the
 * runs it feeds nested where they leave it — a take-off after the stretch it
 * is cut at the end of, a split's outlets and a plenum's spigots after the
 * run's last stretch. Built from a sizing report (its figures unchanged) and
 * the runs' own starts; a run's last row names the terminal it serves.
 */
import type { HvacElement } from '../../../../types';

import type { DuctSizedSection, DuctSystemSizingReport } from './ductSystemSizing';
import { isDuctElement, readDuctRunSpec, type DuctPoint3, type DuctRunSpec } from './ductTypes';

export interface DuctNetworkRow {
  /** Unique within a report: the run and where the stretch starts. */
  key: string;
  /** 0 for the root run, one more for each run it hangs off. */
  depth: number;
  /** The system's first stretch: the main off the collar. */
  main: boolean;
  /** The run's last stretch (what follows it is a terminal, a split or a plenum). */
  last: boolean;
  /** The terminal the run serves, on its last row. */
  terminalLabel: string | null;
  section: DuctSizedSection;
}

/** The key a stretch is known by (the network row, its chart dot, the plan highlight). */
export function networkRowKey(section: Pick<DuctSizedSection, 'runId' | 'fromMm'>): string {
  return `${section.runId}@${Math.round(section.fromMm)}`;
}

const length3 = (a: DuctPoint3, b: DuctPoint3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** Where a take-off leaves its parent (mm from the parent's start, along its rigid path), as the sizing measures it. */
function tapStation(parent: DuctRunSpec, legIndex: number, stationMm: number): number {
  const flexTail = parent.end.kind === 'terminal' && parent.end.flex && parent.path.length >= 3;
  const rigid = flexTail ? parent.path.slice(0, -1) : parent.path;
  let before = 0;
  for (let index = 1; index <= Math.min(legIndex, rigid.length - 1); index += 1) before += length3(rigid[index - 1]!, rigid[index]!);
  return before + stationMm;
}

export function ductNetworkRows(report: DuctSystemSizingReport, scene: readonly HvacElement[]): DuctNetworkRow[] {
  const sectionsOf = new Map<string, DuctSizedSection[]>();
  for (const section of report.sections) {
    const list = sectionsOf.get(section.runId);
    if (list) list.push(section);
    else sectionsOf.set(section.runId, [section]);
  }
  for (const list of sectionsOf.values()) list.sort((a, b) => a.fromMm - b.fromMm);
  const specs = new Map<string, DuctRunSpec>();
  for (const element of scene) {
    if (!isDuctElement(element) || !sectionsOf.has(element.id)) continue;
    const spec = readDuctRunSpec(element);
    if (spec) specs.set(element.id, spec);
  }
  // Each run's children: where they leave it (a take-off's station; the end for a split's outlets and a plenum's spigots).
  const children = new Map<string, Array<{ id: string; station: number; order: number }>>();
  for (const [id, spec] of specs) {
    const start = spec.start;
    if (start.kind !== 'tap' && start.kind !== 'split-branch' && start.kind !== 'spigot') continue;
    const parent = specs.get(start.parentRunId);
    if (!parent) continue;
    const station = start.kind === 'tap' ? tapStation(parent, start.legIndex, start.stationMm) : Number.POSITIVE_INFINITY;
    // Left before right at a split; a plenum's spigots along their faces.
    const order = start.kind === 'split-branch' ? -start.side : start.kind === 'spigot' ? start.alongMm + start.acrossMm : 0;
    const list = children.get(start.parentRunId) ?? [];
    list.push({ id, station, order });
    children.set(start.parentRunId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.station - b.station || a.order - b.order);
  const terminalOf = new Map(report.terminals.map((terminal) => [terminal.runId, terminal.label]));

  const rows: DuctNetworkRow[] = [];
  const seen = new Set<string>();
  const emit = (runId: string, depth: number) => {
    if (seen.has(runId)) return;
    seen.add(runId);
    const sections = sectionsOf.get(runId) ?? [];
    const pending = [...(children.get(runId) ?? [])];
    sections.forEach((section, index) => {
      const last = index === sections.length - 1;
      rows.push({
        key: networkRowKey(section), depth, main: runId === report.rootRunId && index === 0, last,
        terminalLabel: last ? terminalOf.get(runId) ?? null : null, section,
      });
      // The take-offs at the end of this stretch (the last stretch takes the rest: a split's, a plenum's).
      while (pending.length && (last || pending[0]!.station <= section.toMm + 0.5)) emit(pending.shift()!.id, depth + 1);
    });
    for (const child of pending) emit(child.id, depth + 1);
  };
  emit(report.rootRunId, 0);
  // Runs the report sized but no start ties to the tree (none in a sound system) go last, at the top level.
  for (const runId of sectionsOf.keys()) emit(runId, 0);
  return rows;
}
