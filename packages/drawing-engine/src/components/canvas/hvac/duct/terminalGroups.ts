/**
 * Air terminals grouped by spec — service, face, neck, face size, slots,
 * filter — as the unit panel lists them: one airflow for a group (terminals
 * of one spec take the same airflow, `shareAirflow`), each terminal below it
 * when one is set on its own.
 */
import { TERMINAL_FACE_LABELS, type DuctTerminalSpec } from './ductTerminalCatalog';

/** What makes two terminals the same spec. */
export function terminalSpecKey(spec: DuctTerminalSpec): string {
  return [spec.service, spec.kind, spec.neckDiameterMm, `${spec.faceWidthMm}x${spec.faceDepthMm}`, spec.slots ?? '', spec.filter ?? ''].join('|');
}

/** "Square 4-way Ø300", "Linear slot ×2 Ø200", "Egg-crate Ø300 · G4" (`neck`: the neck as the display shows it, "Ø12"). */
export function terminalSpecLabel(spec: DuctTerminalSpec, neck: (diameterMm: number) => string = (diameterMm) => `Ø${diameterMm}`): string {
  const slots = spec.kind === 'linear-slot' && spec.slots ? ` ×${spec.slots}` : '';
  return `${TERMINAL_FACE_LABELS[spec.kind]}${slots} ${neck(spec.neckDiameterMm)}${spec.filter ? ` · ${spec.filter}` : ''}`;
}

export interface TerminalSpecGroup<T> {
  key: string;
  spec: DuctTerminalSpec;
  members: T[];
}

/** The items by spec: supply before return, larger necks first, then by name; members keep their order. */
export function groupTerminalsBySpec<T>(items: readonly T[], specOf: (item: T) => DuctTerminalSpec | null): Array<TerminalSpecGroup<T>> {
  const groups = new Map<string, TerminalSpecGroup<T>>();
  for (const item of items) {
    const spec = specOf(item);
    if (!spec) continue;
    const key = terminalSpecKey(spec);
    const group = groups.get(key);
    if (group) group.members.push(item);
    else groups.set(key, { key, spec, members: [item] });
  }
  return [...groups.values()].sort((a, b) => (a.spec.service === b.spec.service ? 0 : a.spec.service === 'supply' ? -1 : 1)
    || b.spec.neckDiameterMm - a.spec.neckDiameterMm
    || terminalSpecLabel(a.spec).localeCompare(terminalSpecLabel(b.spec)));
}
