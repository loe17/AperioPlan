import { describe, expect, it } from 'vitest';
import { addMonths, bookValue, depreciationSchedule } from '../src/inventory';

describe('Abschreibung', () => {
  it('linear, monatsgenau ab Anschaffungsmonat', () => {
    // 3.600 € über 3 Jahre, gekauft im Oktober: 2026 drei Monate = 300 €
    const r = depreciationSchedule(3600, '2026-10-15', 3);
    expect(r[0]).toEqual({ year: 2026, start: 3600, amount: 300, end: 3300 });
    expect(r[1]).toMatchObject({ year: 2027, amount: 1200, end: 2100 });
    expect(r.at(-1)).toMatchObject({ year: 2029, amount: 900, end: 0 });
    expect(r.reduce((s, x) => s + x.amount, 0)).toBeCloseTo(3600);
    expect(bookValue(3600, '2026-10-15', 3, 2027)).toBe(2100);
    expect(bookValue(3600, '2026-10-15', 3, 2035)).toBe(0);
  });
  it('GWG ohne Nutzungsdauer sofort, teure ohne Nutzungsdauer gar nicht', () => {
    expect(depreciationSchedule(650, '2026-03-01', null)).toEqual([{ year: 2026, start: 650, amount: 650, end: 0 }]);
    expect(depreciationSchedule(5000, '2026-03-01', null)).toEqual([]);
  });
  it('Prüftermine', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-05-10', 12)).toBe('2027-05-10');
  });
});
