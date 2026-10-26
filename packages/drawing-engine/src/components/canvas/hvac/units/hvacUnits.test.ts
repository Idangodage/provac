import { describe, expect, it } from 'vitest';

import {
  displayDigits, formatNumberIn, formatQuantity, formatSection, fromDisplay, inchFractionText, inchesText, pressureClassText, sizesText, slopeFigureText, slopeText, storedFieldText, storedFieldValue, tonsOf,
  toDisplay, toDisplayText, unitLabel,
  type HvacQuantity,
} from './hvacUnits';

describe('HVAC units', () => {
  it('converts the air-side quantities to IP by their definitions', () => {
    expect(toDisplay('airflow', 4320, 'ip')).toBeCloseTo(2542.65, 1); // 1 CFM = 1.699011 m³/h
    expect(toDisplay('velocity', 5.08, 'ip')).toBeCloseTo(1000, 6); // 1 fpm = 0.00508 m/s
    expect(toDisplay('friction', 8.16404, 'ip')).toBeCloseTo(1, 4); // 1 in. wg / 100 ft = 248.84 Pa / 30.48 m
    expect(toDisplay('pressure', 248.84, 'ip')).toBeCloseTo(1, 9);
    expect(toDisplay('size', 609.6, 'ip')).toBeCloseTo(24, 9);
    expect(toDisplay('length', 0.3048, 'ip')).toBeCloseTo(1, 9);
    expect(toDisplay('capacity', 28, 'ip')).toBeCloseTo(95.54, 2);
    expect(toDisplay('mass', 0.45359237, 'ip')).toBeCloseTo(1, 9);
    expect(tonsOf(3.516853)).toBeCloseTo(1, 4);
  });

  it('converts the pipe and drain quantities to IP by their definitions', () => {
    expect(toDisplay('slope', 1, 'ip')).toBeCloseTo(0.12, 9); // 1 % = 12 in × 1/100 per ft
    expect(fromDisplay('slope', 0.125, 'ip')).toBeCloseTo(1.0417, 4); // 1/8 in/ft
    expect(toDisplay('flow', 3.785411784, 'ip')).toBeCloseTo(1, 9); // 1 US gal
    expect(toDisplay('charge', 1, 'ip')).toBeCloseTo(0.67197, 5); // 2.20462 lb per 3.28084 ft
    expect(formatQuantity('flow', 12, 'ip')).toBe('3.17 gph');
    expect(formatQuantity('charge', 0.18, 'ip')).toBe('0.121 lb/ft');
    expect(unitLabel('slope', 'ip')).toBe('in/ft');
  });

  it('converts sheet areas, volumes and prices per kg, m² and m to IP', () => {
    expect(toDisplay('area', 1, 'ip')).toBeCloseTo(10.7639, 4); // 1 m² = 10.7639 ft²
    expect(toDisplay('volume', 3.785411784, 'ip')).toBeCloseTo(1, 9); // 1 US gal
    expect(toDisplay('perMass', 10, 'ip')).toBeCloseTo(4.5359, 4); // 10 a kg = 4.54 a lb
    expect(toDisplay('perArea', 100, 'ip')).toBeCloseTo(9.2903, 4); // 100 a m² = 9.29 a ft²
    expect(toDisplay('perLength', 10, 'ip')).toBeCloseTo(3.048, 6); // 10 a m = 3.05 a ft
    expect(toDisplay('coverage', 8, 'ip')).toBeCloseTo(325.97, 1); // 8 m²/L = 326 ft²/gal
    expect(formatQuantity('area', 2.5, 'ip')).toBe('26.9 ft²');
    expect(formatQuantity('mass', 12.34, 'ip', 1)).toBe('27.2 lb');
    expect(unitLabel('perMass', 'ip')).toBe('/ lb');
  });

  it('shows a stored figure in a field in the display system and stores what is typed back in SI', () => {
    // A unit's airflow is stored in L/s: in IP it is typed in CFM (through m³/h, 3.6 per L/s).
    expect(storedFieldText(333, 'airflow', 'si', 0, 3.6)).toBe('333');
    expect(storedFieldText(333, 'airflow', 'ip', 0, 3.6)).toBe('706');
    expect(storedFieldValue('706', 'airflow', 'ip', 3.6)).toBeCloseTo(333.2, 1);
    expect(storedFieldText(2.2, 'capacity', 'ip', 1)).toBe('7.5');
    expect(storedFieldValue('7.5', 'capacity', 'ip')).toBeCloseTo(2.198, 3);
    expect(storedFieldValue('0.4', 'pressure', 'ip')).toBeCloseTo(99.536, 3);
    expect(storedFieldValue('2.5', 'capacity', 'si')).toBe(2.5);
    expect(storedFieldText(null, 'pressure', 'ip', 2)).toBe('');
    expect(storedFieldValue('  ', 'pressure', 'ip')).toBeNull();
    expect(storedFieldValue('-', 'pressure', 'ip')).toBeUndefined();
  });

  it('names a fall by its sixteenth of an inch per foot, as falls are specified', () => {
    expect([0.5, 1, 1.5, 2, 3, 4].map(slopeFigureText)).toEqual(['1/16', '1/8', '3/16', '1/4', '3/8', '1/2']);
    expect(slopeText(1.04)).toBe('1/8 in/ft');
    // Off a sixteenth: to the thousandth.
    expect(slopeText(0.2)).toBe('0.024 in/ft');
    expect(slopeText(0.75)).toBe('0.090 in/ft');
    expect(slopeText(0.9)).toBe('0.108 in/ft');
    expect(slopeText(-1)).toBe('1/8 in/ft');
  });

  it('leaves SI as it is and comes back from IP exactly', () => {
    const kinds: HvacQuantity[] = ['airflow', 'velocity', 'friction', 'pressure', 'size', 'length', 'capacity', 'mass', 'slope', 'flow', 'charge',
      'area', 'volume', 'perMass', 'perArea', 'perLength', 'coverage'];
    for (const kind of kinds) {
      expect(toDisplay(kind, 123.456, 'si')).toBe(123.456);
      expect(fromDisplay(kind, toDisplay(kind, 123.456, 'ip'), 'ip')).toBeCloseTo(123.456, 9);
    }
  });

  it('shows each quantity at its usual precision, with its unit', () => {
    expect(formatQuantity('airflow', 4320, 'si')).toBe('4320 m³/h');
    expect(formatQuantity('airflow', 4320, 'ip')).toBe('2543 CFM');
    expect(formatQuantity('velocity', 4.93, 'si')).toBe('4.9 m/s');
    expect(formatQuantity('velocity', 4.93, 'ip')).toBe('970 fpm');
    expect(formatQuantity('friction', 0.8, 'si')).toBe('0.80 Pa/m');
    expect(formatQuantity('friction', 0.8, 'ip')).toBe('0.098 in. wg/100 ft');
    expect(formatQuantity('pressure', 46, 'ip')).toBe('0.18 in. wg');
    expect(formatNumberIn('airflow', null, 'ip')).toBe('–');
    expect(unitLabel('velocity', 'ip')).toBe('fpm');
    expect(displayDigits('friction', 'ip')).toBe(3);
  });

  it('reads a duct size in mm, or in inches (whole for an inch-series size)', () => {
    expect(formatSection({ widthMm: 600, heightMm: 350 }, 'si')).toBe('600×350');
    expect(formatSection({ widthMm: 600, heightMm: 350 }, 'ip')).toBe('23.6×13.8');
    expect(formatSection({ widthMm: 609.6, heightMm: 355.6 }, 'ip')).toBe('24×14');
    expect(formatSection({ widthMm: 300, heightMm: 300, diameterMm: 300 }, 'si')).toBe('Ø300');
    expect(formatSection({ widthMm: 304.8, heightMm: 304.8, diameterMm: 304.8 }, 'ip')).toBe('Ø12');
    expect(inchesText(300)).toBe('11.8');
  });

  it('keeps an engine message as written in SI', () => {
    const message = 'SAD-1: neck Ø200 → Ø250 for 500 m³/h (4.4 m/s in Ø200, cap 3 m/s).';
    expect(toDisplayText(message, 'si')).toBe(message);
  });

  it('adds the IP figure after every SI figure of a message, never rewriting the sentence', () => {
    expect(toDisplayText('SAD-1: neck Ø200 → Ø250 for 500 m³/h (4.4 m/s in Ø200, cap 3 m/s).', 'ip'))
      .toBe('SAD-1: neck Ø200 (Ø7.9 in) → Ø250 (Ø9.8 in) for 500 m³/h (294 CFM) (4.4 m/s (866 fpm) in Ø200 (Ø7.9 in), cap 3 m/s (591 fpm)).');
    // Figures given without a unit stay as they are: the sentence still adds up.
    expect(toDisplayText('supply 64 + return 48 = 112 Pa of 100', 'ip')).toBe('supply 64 + return 48 = 112 Pa (0.45 in. wg) of 100');
    expect(toDisplayText('Main 700×350 at 0.80 Pa/m, 24 m from the gully', 'ip'))
      .toBe('Main 700×350 (27.6×13.8 in) at 0.80 Pa/m (0.098 in. wg/100 ft), 24 m (78.7 ft) from the gully');
    // An area and a mass read in ft² and lb; minutes and a count are not units.
    expect(toDisplayText('12 m² of sheet in 3 min, 2 × Ø300', 'ip')).toBe('12 m² (129 ft²) of sheet in 3 min, 2 × Ø300 (Ø11.8 in)');
    expect(toDisplayText('Trapeze 1200 mm carrying 35 kg; 4.2 kg per rod; 1.5 m² of NBR', 'ip'))
      .toBe('Trapeze 1200 mm (3.9 ft) carrying 35 kg (77 lb); 4.2 kg (9.3 lb) per rod; 1.5 m² (16 ft²) of NBR');
    expect(toDisplayText('liquid charge 0.050 kg/m', 'ip')).toBe('liquid charge 0.050 kg/m (0.034 lb/ft)');
  });

  it('gives a pipe message its lengths in feet from a metre up, a copper size by its inch name, and its falls in in/ft', () => {
    expect(toDisplayText('Total routed length 92340 mm exceeds 90000 mm.', 'ip')).toBe('Total routed length 92340 mm (303.0 ft) exceeds 90000 mm (295.3 ft).');
    expect(toDisplayText('Pipe diameter 15.88 mm does not match the required 19.05 mm.', 'ip'))
      .toBe('Pipe diameter 15.88 mm (5/8 in) does not match the required 19.05 mm (3/4 in).');
    expect(toDisplayText('Gas port straight stub 120 mm is below 300 mm.', 'ip')).toBe('Gas port straight stub 120 mm (4.7 in) is below 300 mm (11.8 in).');
    expect(toDisplayText('CD-1 (ID 20.6 mm) is below the 25.0 mm required for 7.1 kW.', 'ip'))
      .toBe('CD-1 (ID 20.6 mm (0.81 in)) is below the 25.0 mm (0.98 in) required for 7.1 kW (24.2 kBtu/h).');
    expect(toDisplayText('Gas-line slope 0.50% is below 1.00% toward the outdoor unit.', 'ip'))
      .toBe('Gas-line slope 0.50% (1/16 in/ft) is below 1.00% (1/8 in/ft) toward the outdoor unit.');
    expect(toDisplayText('CD-2 falls only 0.40 % (minimum 1 %).', 'ip')).toBe('CD-2 falls only 0.40 % (0.048 in/ft) (minimum 1 % (1/8 in/ft)).');
    expect(toDisplayText('design flow 3.2 L/h', 'ip')).toBe('design flow 3.2 L/h (0.85 gph)');
    // A percentage that is not a fall is left as it is, as is one in the sentence after a fall's.
    expect(toDisplayText('4 units total 31.2 kW: 112 % of its 28.0 kW (allowed 50–130 %)', 'ip'))
      .toBe('4 units total 31.2 kW (106.5 kBtu/h): 112 % of its 28.0 kW (95.5 kBtu/h) (allowed 50–130 %)');
    expect(toDisplayText('Falls 1 %. Divided 60 / 40 % of the air.', 'ip')).toBe('Falls 1 % (1/8 in/ft). Divided 60 / 40 % of the air.');
  });

  it('turns the sizes in a label into inches, each with its unit; SI as written', () => {
    expect(sizesText('600×300 → Ø450', 'ip')).toBe('23.6×11.8 in → Ø17.7 in');
    expect(sizesText('Ø406.4 spiral', 'ip')).toBe('Ø16 in spiral');
    expect(sizesText('Rectangular radius elbow 609.6×254', 'ip')).toBe('Rectangular radius elbow 24×10 in');
    expect(sizesText('600×300 → Ø450', 'si')).toBe('600×300 → Ø450');
    expect(sizesText('R/W 1.5 · 2 pieces', 'ip')).toBe('R/W 1.5 · 2 pieces');
    expect(sizesText('PLENUM 800×350×500 · GI 0.70', 'ip')).toBe('PLENUM 800×350×500 · GI 0.70');
    expect(sizesText('600×350 · GI 0.70 (24 ga) · TDC · BOD 2479', 'ip')).toBe('23.6×13.8 in · GI 0.70 (24 ga) · TDC · BOD 2479');
  });

  it('names a SMACNA pressure class in Pa or in inches of water', () => {
    expect([125, 250, 500, 750, 1000, 1500, 2500].map((pa) => pressureClassText(pa, 'ip'))).toEqual(['0.5 in. wg', '1 in. wg', '2 in. wg', '3 in. wg', '4 in. wg', '6 in. wg', '10 in. wg']);
    expect(pressureClassText(500, 'si')).toBe('500 Pa');
  });

  it('names copper tube in inches to the eighth, as it is sold', () => {
    expect(['6.35', '9.52', '12.7', '15.88', '19.05', '22.22', '28.58', '34.92', '41.28'].map((mm) => inchFractionText(Number(mm))))
      .toEqual(['1/4', '3/8', '1/2', '5/8', '3/4', '7/8', '1-1/8', '1-3/8', '1-5/8']);
    expect(inchFractionText(25.4)).toBe('1');
  });
});
