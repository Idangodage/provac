import { describe, expect, it } from 'vitest';

import { resolveSectionConstruction, selectStockSheet, type SectionConstructionInput } from './ductGauge';
import { DEFAULT_SHEET_STOCK_MM, resolveDuctSettings } from './ductSettings';

const settings = resolveDuctSettings({});

function construct(overrides: Partial<SectionConstructionInput> & Pick<SectionConstructionInput, 'widthMm' | 'heightMm'>) {
  return resolveSectionConstruction({ service: 'supply', construction: 'gi-bare', settings, ...overrides });
}

describe('commercial sheet stock', () => {
  it('uses the configured provisional stock list', () => {
    expect(settings.availableSheetThicknessesMm).toEqual([0.5, 0.6, 0.7, 0.75, 1.0, 1.25, 1.5]);
    expect(DEFAULT_SHEET_STOCK_MM).toEqual([0.5, 0.6, 0.7, 0.75, 1.0, 1.25, 1.5]);
  });

  it.each([
    [0.55, 0.6],
    [0.7, 0.7],
    [0.85, 1.0],
    [1.0, 1.0],
    [1.31, 1.5],
  ])('rounds the SMACNA minimum %s mm up to %s mm', (required, sheet) => {
    expect(selectStockSheet(required, settings.availableSheetThicknessesMm)).toBe(sheet);
  });

  it('never picks a thinner sheet, and reports when nothing is thick enough', () => {
    expect(selectStockSheet(1.61, settings.availableSheetThicknessesMm)).toBeNull();
    expect(selectStockSheet(0.55, [0.5])).toBeNull();
  });

  it('is configuration: a different stock list changes the sheet, not the SMACNA minimum', () => {
    const smacnaStock = resolveDuctSettings({ availableSheetThicknessesMm: [0.55, 0.7, 0.85, 1.0, 1.31, 1.61] });
    const a = construct({ widthMm: 1100, heightMm: 400 });
    const b = resolveSectionConstruction({ widthMm: 1100, heightMm: 400, service: 'supply', construction: 'gi-bare', settings: smacnaStock });
    expect(a.smacnaMinThicknessMm).toBe(0.85);
    expect(b.smacnaMinThicknessMm).toBe(0.85);
    expect(a.sheetThicknessMm).toBe(1.0);
    expect(b.sheetThicknessMm).toBe(0.85);
  });
});

describe('SMACNA thickness and joint selection (500 Pa, 1.2 m joints)', () => {
  it('251–300 mm: the reinforced 0.55 mm option beats 0.70 unreinforced, class B', () => {
    const result = construct({ widthMm: 280, heightMm: 200 });
    expect(result.status).toBe('ok');
    expect(result.table).toBe('1-5M');
    expect(result.spacingColumnMm).toBe(1200);
    expect(result.smacnaMinThicknessMm).toBe(0.55);
    expect(result.unreinforced).toBe(false);
    expect(result.requiredClass).toBe('B');
    expect(result.sheetThicknessMm).toBe(0.6);
    expect(result.joint).toMatchObject({ system: 'tdc', ratedClass: 'D' });
  });

  it('601–650 mm: D-0.55; the narrow side takes its own class', () => {
    const result = construct({ widthMm: 620, heightMm: 400 });
    expect(result.smacnaMinThicknessMm).toBe(0.55);
    expect(result.sideClasses).toEqual({ width: 'D', height: 'C' });
    expect(result.requiredClass).toBe('D');
    expect(result.joint).toMatchObject({ system: 'tdc', ratedClass: 'D' });
  });

  it('1001–1200 mm: G-0.85 → 1.0 mm stock; TDC rates G at 1.00 mm', () => {
    const result = construct({ widthMm: 1100, heightMm: 400 });
    expect(result.smacnaMinThicknessMm).toBe(0.85);
    expect(result.requiredClass).toBe('G');
    expect(result.sheetThicknessMm).toBe(1.0);
    expect(result.gaugeLabel).toBe('20 ga');
    expect(result.joint).toMatchObject({ system: 'tdc', ratedClass: 'G' });
    expect(result.crossBreak).toEqual({ width: true, height: false });
  });

  it('1501–1800 mm: I-1.31 (tie-rod G) → 1.5 mm; TDC stops at H, so auto uses a T-22 angle', () => {
    const result = construct({ widthMm: 1600, heightMm: 400 });
    expect(result.smacnaMinThicknessMm).toBe(1.31);
    expect(result.requiredClass).toBe('I');
    expect(result.tieRodAlternative).toBe('G');
    expect(result.sheetThicknessMm).toBe(1.5);
    expect(result.joint).toMatchObject({ system: 'angle-flange', member: { legMm: 38.1, thicknessMm: 6.4 } });
    expect(result.crossBreak).toEqual({ width: false, height: false });
  });

  it('never credits a rounded-up sheet beyond the SMACNA nominal it meets', () => {
    // 1.25 mm stock is rated as 1.00 mm (G), not interpolated toward 1.31.
    const result = resolveSectionConstruction({
      widthMm: 1100, heightMm: 400, service: 'supply', construction: 'gi-bare',
      settings: resolveDuctSettings({ availableSheetThicknessesMm: [0.6, 1.25] }),
    });
    expect(result.sheetThicknessMm).toBe(1.25);
    expect(result.joint).toMatchObject({ system: 'tdc', ratedClass: 'G' });
  });

  it('explicit TDC thickens the duct until the formed flange reaches the class', () => {
    const result = resolveSectionConstruction({
      widthMm: 1100, heightMm: 400, service: 'supply', construction: 'gi-bare', jointSystem: 'tdc',
      settings: resolveDuctSettings({ availableSheetThicknessesMm: [0.9, 1.5] }),
    });
    expect(result.smacnaMinThicknessMm).toBe(0.85);
    expect(result.sheetThicknessMm).toBe(1.5);
    expect(result.joint).toMatchObject({ system: 'tdc', thickened: true });
  });

  it('Ductmate picks the lightest series that reaches the class', () => {
    const result = construct({ widthMm: 1100, heightMm: 400, jointSystem: 'ductmate' });
    expect(result.joint).toMatchObject({ system: 'ductmate', series: 'DM35', ratedClass: 'J' });
    const small = construct({ widthMm: 620, heightMm: 400, jointSystem: 'ductmate' });
    expect(small.joint).toMatchObject({ system: 'ductmate', series: 'DM25', ratedClass: 'F' });
  });

  it('return ducts are negative pressure: TDC is not rated for class H there', () => {
    const result = resolveSectionConstruction({
      widthMm: 1400, heightMm: 400, service: 'return', construction: 'gi-bare', pressureClassPa: 500, jointSystem: 'tdc',
      settings,
    });
    expect(result.pressureMode).toBe('negative');
    expect(result.requiredClass).toBe('H');
    expect(result.status).toBe('joint-not-achievable');
  });

  it('insulated ducts are not cross-broken', () => {
    const result = construct({ widthMm: 1100, heightMm: 400, construction: 'gi-nbr' });
    expect(result.crossBreak).toEqual({ width: false, height: false });
  });

  it('design pressures between classes use the next higher SMACNA table', () => {
    expect(construct({ widthMm: 620, heightMm: 400, pressureClassPa: 300 }).table).toBe('1-5M');
    expect(construct({ widthMm: 620, heightMm: 400, pressureClassPa: 200 }).table).toBe('1-4M');
  });
});

describe('unsupported states are explicit', () => {
  it.each([750, 1000, 2500])('%s Pa is refused with a message, not extrapolated', (pressure) => {
    const result = construct({ widthMm: 620, heightMm: 400, pressureClassPa: pressure });
    expect(result.status).toBe('unsupported-pressure');
    expect(result.sheetThicknessMm).toBeNull();
    expect(result.joint).toBeNull();
    expect(result.message).toMatch(/500 Pa/);
  });

  it('refuses above 500 Pa in the longest-side mode too', () => {
    const result = resolveSectionConstruction({
      widthMm: 620, heightMm: 400, service: 'supply', construction: 'gi-bare', pressureClassPa: 750,
      settings: resolveDuctSettings({ gaugeMode: 'longest-side' }),
    });
    expect(result.status).toBe('unsupported-pressure');
  });

  it('reports a side beyond the table and a sheet beyond the stock', () => {
    expect(construct({ widthMm: 3100, heightMm: 400 }).status).toBe('size-over-table');
    const noStock = resolveSectionConstruction({
      widthMm: 1600, heightMm: 400, service: 'supply', construction: 'gi-bare',
      settings: resolveDuctSettings({ availableSheetThicknessesMm: [0.6, 1.0, 1.25] }),
    });
    expect(noStock.status).toBe('no-stock');
    expect(noStock.message).toMatch(/1\.31/);
  });
});

describe('longest-side mode', () => {
  it('takes the common table and derives no joint class', () => {
    const result = resolveSectionConstruction({
      widthMm: 800, heightMm: 400, service: 'supply', construction: 'gi-bare',
      settings: resolveDuctSettings({ gaugeMode: 'longest-side' }),
    });
    expect(result.smacnaMinThicknessMm).toBe(0.85);
    expect(result.sheetThicknessMm).toBe(1.0);
    expect(result.requiredClass).toBeNull();
    expect(result.table).toBeNull();
    expect(result.notes.join(' ')).toMatch(/not SMACNA-derived/);
  });
});
