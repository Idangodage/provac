import { describe, expect, it } from 'vitest';

import {
  displayDigits, formatNumberIn, formatQuantity, formatSection, fromDisplay, inchesText, tonsOf, toDisplay, toDisplayText, unitLabel,
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

  it('leaves SI as it is and comes back from IP exactly', () => {
    const kinds: HvacQuantity[] = ['airflow', 'velocity', 'friction', 'pressure', 'size', 'length', 'capacity', 'mass'];
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
    // Not a unit: an area, minutes, a count.
    expect(toDisplayText('12 m² of sheet in 3 min, 2 × Ø300', 'ip')).toBe('12 m² of sheet in 3 min, 2 × Ø300 (Ø11.8 in)');
  });
});
