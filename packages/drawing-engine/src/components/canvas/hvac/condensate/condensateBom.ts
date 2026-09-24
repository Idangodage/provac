/**
 * Bill of materials for condensate drainage, read from the persisted pipes
 * (so it reflects field edits, not only what the generator produced).
 */
import type { HvacElement } from '../../../../types';

import { getCondensatePipeSystem } from './condensatePipeCatalog';
import type { CondensateDesignSettings } from './condensateSettings';
import { layoutCondensateSupportsForScene } from './condensateSupports';
import { isCondensateGully, isCondensatePipe, readCondensateGullySpec, readCondensatePipeSpec, type CondensateFittingKind } from './condensateTypes';

export interface CondensateBomRow {
  category: 'Pipe' | 'Fitting' | 'Insulation' | 'Support' | 'Termination';
  description: string;
  size: string;
  quantity: number;
  unit: 'm' | 'no.' | 'lengths';
}

const FITTING_LABELS: Record<CondensateFittingKind, string> = {
  wye: '45° wye (branch from top)',
  'elbow-90': '90° bend (long radius)',
  'elbow-45': '45° bend',
  cleanout: 'Rodding eye / cleanout',
  'air-vent': 'Air vent (anti air-lock)',
  'p-trap': 'P-trap',
  tundish: 'Tundish (air break)',
  hepvo: 'Waterless trap valve (HepVO type)',
  'stack-wye': 'Stack branch boss',
  'wall-sleeve': 'Wall sleeve + fire/weather seal',
  'terminal-outlet': 'External outlet bend',
  reducer: 'Reducer',
};

const STOCK_LENGTH_M = 3;
const WASTE_FACTOR = 1.1;

function length3(nodes: Array<{ x: number; y: number; z: number }>): number {
  let total = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1]!;
    const b = nodes[index]!;
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

export function buildCondensateBom(
  elements: readonly HvacElement[],
  settings: CondensateDesignSettings,
): CondensateBomRow[] {
  const pipes = elements.filter(isCondensatePipe);
  const pipeRows = new Map<string, { system: string; size: string; lengthMm: number; insulationMm: number; insulationThickness: number }>();
  const fittingRows = new Map<string, number>();
  const hoseRows = new Map<string, number>();
  for (const pipe of pipes) {
    const spec = readCondensatePipeSpec(pipe);
    if (spec.drainHoseLengthMm > 0) hoseRows.set(spec.nominalSize, (hoseRows.get(spec.nominalSize) ?? 0) + 1);
    const system = getCondensatePipeSystem(spec.pipeSystem);
    const key = `${system.id}|${spec.nominalSize}`;
    const row = pipeRows.get(key) ?? { system: system.label, size: spec.nominalSize, lengthMm: 0, insulationMm: 0, insulationThickness: spec.insulationThicknessMm };
    const length = length3(spec.routeNodes3d);
    row.lengthMm += length;
    if (spec.insulationThicknessMm > 0) row.insulationMm += length;
    pipeRows.set(key, row);
    for (const fitting of spec.fittings) {
      const fittingKey = `${fitting.kind}|${fitting.nominalSize}`;
      fittingRows.set(fittingKey, (fittingRows.get(fittingKey) ?? 0) + 1);
    }
  }
  const rows: CondensateBomRow[] = [];
  for (const row of [...pipeRows.values()].sort((a, b) => a.system.localeCompare(b.system) || a.size.localeCompare(b.size, undefined, { numeric: true }))) {
    const metres = row.lengthMm / 1000;
    rows.push({ category: 'Pipe', description: `${row.system} pipe (installed length)`, size: row.size, quantity: Math.round(metres * 100) / 100, unit: 'm' });
    rows.push({ category: 'Pipe', description: `${row.system} stock lengths (${STOCK_LENGTH_M} m, +10 % waste)`, size: row.size, quantity: Math.ceil((metres * WASTE_FACTOR) / STOCK_LENGTH_M), unit: 'lengths' });
    if (row.insulationMm > 0) {
      rows.push({ category: 'Insulation', description: `${row.insulationThickness} mm closed-cell insulation`, size: row.size, quantity: Math.round((row.insulationMm / 1000) * 100) / 100, unit: 'm' });
    }
  }
  for (const [key, count] of [...fittingRows].sort(([a], [b]) => a.localeCompare(b))) {
    const [kind, size] = key.split('|') as [CondensateFittingKind, string];
    rows.push({ category: 'Fitting', description: FITTING_LABELS[kind] ?? kind, size, quantity: count, unit: 'no.' });
  }
  for (const [size, count] of [...hoseRows].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    rows.push({ category: 'Fitting', description: 'Flexible drain hose + 2 clamps (unit connection)', size, quantity: count, unit: 'no.' });
  }
  const supports = layoutCondensateSupportsForScene(pipes, settings);
  const supportRows = new Map<string, number>();
  let rodLengthMm = 0;
  for (const support of supports) {
    const key = `${support.orientation}|${support.nominalSize}`;
    supportRows.set(key, (supportRows.get(key) ?? 0) + 1);
    rodLengthMm += support.rodLengthMm;
  }
  for (const [key, count] of [...supportRows].sort(([a], [b]) => a.localeCompare(b))) {
    const [orientation, size] = key.split('|') as [string, string];
    rows.push({
      category: 'Support',
      description: orientation === 'vertical' ? 'Wall bracket / clip (vertical run)' : 'Hanger rod + clip with insulation saddle',
      size,
      quantity: count,
      unit: 'no.',
    });
  }
  if (rodLengthMm > 0) {
    rows.push({ category: 'Support', description: 'Threaded rod M8 from the slab (cut lengths, +10 % waste)', size: 'M8', quantity: Math.round((rodLengthMm * WASTE_FACTOR) / 10) / 100, unit: 'm' });
  }
  const gullies = elements.filter(isCondensateGully);
  const terminations = new Map<string, number>();
  for (const gully of gullies) {
    const spec = readCondensateGullySpec(gully);
    const label = spec.terminationKind === 'floor-gully' ? 'Floor gully' : spec.terminationKind === 'stack-connection' ? 'Stack branch connection' : 'External wall discharge';
    terminations.set(label, (terminations.get(label) ?? 0) + 1);
  }
  for (const [label, count] of terminations) rows.push({ category: 'Termination', description: label, size: '-', quantity: count, unit: 'no.' });
  return rows;
}

export function condensateBomToCsv(rows: readonly CondensateBomRow[]): string {
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    ['Category', 'Description', 'Size', 'Quantity', 'Unit'].join(','),
    ...rows.map((row) => [row.category, row.description, row.size, row.quantity, row.unit].map(escape).join(',')),
  ].join('\n');
}
