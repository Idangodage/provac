import { describe, expect, it } from 'vitest';

import { rigidityIndex } from './ductCatalog';
import { SMACNA_RECTANGULAR_TABLES, SMACNA_REINFORCEMENT_SPACINGS_MM } from './smacnaRectangularTables';

/** Stable digest of every cell, so an accidental edit to a transcribed table fails loudly. */
function digest(value: unknown): number {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash;
}

describe('SMACNA 1995 metric rectangular reinforcement tables', () => {
  it.each(SMACNA_RECTANGULAR_TABLES)('Table $table has contiguous bands up to 3000 mm, 8 cells each', (table) => {
    expect(table.rows[0]!.minMm).toBe(0);
    expect(table.rows[0]!.maxMm).toBe(250);
    table.rows.forEach((row, index) => {
      expect(row.cells).toHaveLength(SMACNA_REINFORCEMENT_SPACINGS_MM.length);
      if (index > 0) expect(row.minMm).toBe(table.rows[index - 1]!.maxMm + 1);
    });
    expect(table.rows[table.rows.length - 1]!.maxMm).toBe(3000);
  });

  it.each(SMACNA_RECTANGULAR_TABLES)('Table $table: class never rises as spacing shortens, never falls as width grows', (table) => {
    for (const row of table.rows) {
      const classes = row.cells.filter((cell) => cell !== null).map((cell) => rigidityIndex(cell!.cls));
      classes.forEach((value, index) => { if (index > 0) expect(value).toBeLessThanOrEqual(classes[index - 1]!); });
    }
    for (let column = 0; column < SMACNA_REINFORCEMENT_SPACINGS_MM.length; column += 1) {
      const classes = table.rows.map((row) => row.cells[column]).filter((cell) => cell !== null).map((cell) => rigidityIndex(cell!.cls));
      classes.forEach((value, index) => { if (index > 0) expect(value).toBeGreaterThanOrEqual(classes[index - 1]!); });
    }
  });

  it('keeps the corrected 500 Pa cells at 1.2 m joint spacing', () => {
    const table = SMACNA_RECTANGULAR_TABLES.find((entry) => entry.pressurePa === 500)!;
    const at = (side: number) => table.rows.find((row) => side <= row.maxMm)!;
    const column = SMACNA_REINFORCEMENT_SPACINGS_MM.indexOf(1200);
    expect(at(280).unreinforcedMm).toBe(0.7);
    expect(at(280).cells[column]).toEqual({ cls: 'B', thicknessMm: 0.55 });
    expect(at(620).cells[column]).toEqual({ cls: 'D', thicknessMm: 0.55 });
    expect(at(1100).cells[column]).toEqual({ cls: 'G', thicknessMm: 0.85 });
    expect(at(1600).cells[column]).toEqual({ cls: 'I', thicknessMm: 1.31, tieRodClass: 'G' });
    // The printed "701, 900" band is the 751–900 row.
    expect(at(800).minMm).toBe(751);
    expect(at(800).note).toMatch(/701, 900/);
    // Large-duct rows lose their long spacings (Not Designed), not their short ones.
    expect(at(1100).cells[0]).toBeNull();
    expect(at(1100).cells[7]).toEqual({ cls: 'E', thicknessMm: 0.7 });
    // Small-duct rows carry the last value to the right (SMACNA 1.8 note).
    expect(at(280).cells[7]).toEqual({ cls: 'B', thicknessMm: 0.55, carried: true });
  });

  it('matches the transcription digest', () => {
    expect(SMACNA_RECTANGULAR_TABLES.map((table) => digest(table))).toEqual(TABLE_DIGESTS);
  });
});

// Digest of the generated tables; regenerate only from a re-verified transcription.
const TABLE_DIGESTS = [1492927482, 1664777961, 2906079970];
