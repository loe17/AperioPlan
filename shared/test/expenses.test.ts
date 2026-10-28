import { describe, expect, it } from 'vitest';
import { perDiem } from '../src/expenses';

describe('Verpflegungspauschalen', () => {
  it('eintägig über 8 Stunden: 14 €, darunter nichts', () => {
    expect(perDiem('2026-03-02T07:00', '2026-03-02T16:30').total).toBe(14);
    expect(perDiem('2026-03-02T08:00', '2026-03-02T15:00').total).toBe(0);
  });
  it('dreitägig: 14 + 28 + 14, Frühstück im Hotel kürzt um 5,60 €', () => {
    const r = perDiem('2026-03-02T10:00', '2026-03-04T15:00', { '2026-03-03': { breakfast: true }, '2026-03-04': { breakfast: true } });
    expect(r.days.map((d) => d.amount)).toEqual([14, 22.4, 8.4]);
    expect(r.total).toBe(44.8);
  });
  it('Kürzung nie unter null', () => {
    expect(perDiem('2026-03-02T06:00', '2026-03-02T20:00', { '2026-03-02': { lunch: true, dinner: true } }).total).toBe(0);
  });
});
