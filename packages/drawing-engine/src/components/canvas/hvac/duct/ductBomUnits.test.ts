import { describe, expect, it } from 'vitest';

import { ductBomRowIn, ductBomToCsv, ductScheduleToCsv, type DuctBomRow, type DuctScheduleRow } from './ductBom';

const rows: DuctBomRow[] = [
  { category: 'Sheet metal', description: 'Galvanised sheet G-60', size: '0.60 mm', quantity: 12.5, unit: 'm²', basis: 'SMACNA 1995 table → stock sheet' },
  { category: 'Sheet metal', description: 'Galvanised sheet mass', size: '0.60 mm', quantity: 61.2, unit: 'kg', basis: '7850 kg/m³ + G-60 coating' },
  { category: 'Joints', description: 'Gasket tape', size: '—', quantity: 24, unit: 'm', basis: 'SMACNA Fig. 1-5' },
  { category: 'Insulation', description: 'Contact adhesive', size: '25 mm', quantity: 3.2, unit: 'L', basis: 'mid-plane area 25.6 m² glued' },
  { category: 'Accessories', description: 'Volume damper', size: 'Ø200', quantity: 2, unit: 'no.', basis: 'SMACNA Fig. 2-3' },
];

describe('the duct bill of materials in either system', () => {
  it('reads as written in SI', () => {
    expect(rows.map((row) => ductBomRowIn(row, 'si'))).toEqual(rows);
  });

  it('reads in IP: m² in ft², kg in lb, m in ft, L in US gal; counts as they are, the basis annotated', () => {
    const ip = rows.map((row) => ductBomRowIn(row, 'ip'));
    expect(ip.map((row) => [row.quantity, row.unit])).toEqual([[134.55, 'ft²'], [134.92, 'lb'], [78.74, 'ft'], [0.85, 'gal'], [2, 'no.']]);
    expect(ip[3]!.basis).toBe('mid-plane area 25.6 m² (276 ft²) glued');
  });

  it('copies its CSV and the fabrication schedule in the system shown', () => {
    expect(ductBomToCsv(rows, 'ip').split('\n')[1]).toContain('134.55,ft²');
    const schedule: DuctScheduleRow[] = [{ run: 'D1', mark: 'S1', kind: 'straight', size: '600×300', lengthMm: 1200, sheetMm: 0.6, gauge: '24', joint: 'TDC',
      requiredClass: '500 Pa', crossBreak: true, areaM2: 2.16, massKg: 10.6 }];
    const [header, line] = ductScheduleToCsv(schedule, 'ip').split('\n');
    expect(header).toContain('Area ft²');
    expect(header).toContain('Mass lb');
    expect(line).toContain('1200');
    expect(line).toContain('23.25');
    expect(line).toContain('23.37');
    expect(ductScheduleToCsv(schedule).split('\n')[0]).toContain('Area m²');
  });
});
