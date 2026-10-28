import { describe, expect, it } from 'vitest';
import { lohnsteuer, type LohnsteuerInput } from '../src/lohnsteuer';

import { BMF_2026 } from './fixtures/lohnsteuer-bmf-2026';

const cases = BMF_2026 as unknown as { inputs: LohnsteuerInput; expected: Record<string, number> }[];

describe('Lohnsteuer 2026 nach amtlichem PAP', () => {
  it(`stimmt in allen ${cases.length} Testfällen des BMF centgenau`, () => {
    const wrong: string[] = [];
    for (const c of cases) {
      const r = lohnsteuer(2026, c.inputs) as unknown as Record<string, number>;
      for (const [k, v] of Object.entries(c.expected)) if (r[k] !== v) wrong.push(`${JSON.stringify(c.inputs)} ${k}: ${r[k]} statt ${v}`);
    }
    expect(wrong.slice(0, 10)).toEqual([]);
  });
  it('Beispiel: 5.000 € Monatslohn, Steuerklasse I', () => {
    const r = lohnsteuer(2026, { LZZ: 2, RE4: 500000, STKL: 1, KVZ: 2.5, PVZ: 1 });
    expect(r.LSTLZZ).toBe(78583);
  });
  it('sonstiger Bezug = Unterschied der Jahreslohnsteuer mit und ohne den Bezug', () => {
    for (const [stkl, jre4, sonst] of [[1, 6000000, 500000], [3, 4200000, 300000], [4, 9000000, 1500000], [6, 3000000, 200000]] as const) {
      const r = lohnsteuer(2026, { LZZ: 2, RE4: jre4 / 12, STKL: stkl, KVZ: 2.9, SONSTB: sonst, JRE4: jre4, R: 1 });
      const ohne = lohnsteuer(2026, { LZZ: 1, RE4: jre4, STKL: stkl, KVZ: 2.9 }).LSTLZZ;
      const mit = lohnsteuer(2026, { LZZ: 1, RE4: jre4 + sonst, STKL: stkl, KVZ: 2.9 }).LSTLZZ;
      expect(r.STS).toBe(Math.floor((mit - ohne) / 100) * 100);
      expect(r.BKS).toBe(r.STS);
    }
  });
  it('Kirchensteuer-Grundlage ohne Kinder = Lohnsteuer, mit Kindern geringer', () => {
    const a = lohnsteuer(2026, { LZZ: 2, RE4: 450000, STKL: 1, KVZ: 2.9, R: 1 });
    expect(a.BK).toBe(a.LSTLZZ);
    const b = lohnsteuer(2026, { LZZ: 2, RE4: 450000, STKL: 1, KVZ: 2.9, R: 1, ZKF: 2 });
    expect(b.LSTLZZ).toBe(a.LSTLZZ);
    expect(b.BK).toBeLessThan(a.BK);
  });
});
