import { describe, expect, it } from 'vitest';
import { computePayslip, DEFAULT_PAY_PROFILE, midijobBases, svParams, type PayProfile } from '../src/payroll';
import { lohnsteuer } from '../src/lohnsteuer';

const prof = (p: Partial<PayProfile> = {}): PayProfile => ({ ...DEFAULT_PAY_PROFILE, ...p });
const salary = (n: number) => [{ kind: 'salary' as const, label: 'Gehalt', qty: 1, rate: n }];

describe('Lohnzettel', () => {
  it('Angestellter 4.000 €, Steuerklasse I, kinderlos', () => {
    const r = computePayslip(2026, 3, prof(), salary(4000));
    expect(r.an).toMatchObject({ kv: 350, pv: 96, rv: 372, av: 52 });
    expect(r.ag).toMatchObject({ kv: 350, pv: 72, rv: 372, av: 52, insolvency: 6 });
    expect(r.tax.lst).toBe(lohnsteuer(2026, { LZZ: 2, RE4: 400000, STKL: 1, KVZ: 2.9, PVZ: 1 }).LSTLZZ / 100);
    expect(r.net).toBeCloseTo(4000 - r.an.total - r.tax.lst - r.tax.soli, 2);
    expect(r.payout).toBe(r.net);
  });
  it('Bemessungsgrenzen: 9.000 € Gehalt', () => {
    const r = computePayslip(2026, 3, prof({ pvChildless: false, pvChildren: 3 }), salary(9000));
    expect(r.an.kv).toBeCloseTo(5812.5 * 0.0875, 1);
    expect(r.an.rv).toBeCloseTo(8450 * 0.093, 1);
    expect(r.an.pv).toBeCloseTo(5812.5 * (0.018 - 0.005), 1);
  });
  it('Kirchensteuer 8 % in BW, 9 % in Hessen', () => {
    const bw = computePayslip(2026, 1, prof({ church: true }), salary(3500));
    const he = computePayslip(2026, 1, prof({ church: true, state: 'HE' }), salary(3500));
    expect(bw.tax.church).toBeCloseTo(Math.floor(bw.tax.lst * 8) / 100, 2);
    expect(he.tax.church).toBeGreaterThan(bw.tax.church);
  });
  it('Midijob 1.200 €: geringere Arbeitnehmerbeiträge, Arbeitgeber trägt mehr', () => {
    const r = computePayslip(2026, 5, prof(), salary(1200));
    expect(r.midijob).toBe(true);
    const { be, beAn } = midijobBases(1200, svParams(2026));
    expect(beAn).toBeLessThan(be);
    expect(be).toBeLessThan(1200);
    expect(r.an.rv).toBeCloseTo(beAn * 0.093, 1);
    expect(r.an.total).toBeLessThan(1200 * 0.2165);
    // an der Obergrenze ist der Übergang stetig
    const top = midijobBases(2000, svParams(2026));
    expect(top.be).toBeCloseTo(2000, 0);
    expect(top.beAn).toBeCloseTo(2000, 0);
  });
  it('Minijob 603 €: Pauschalen des Arbeitgebers, Arbeitnehmer zahlt nichts', () => {
    const r = computePayslip(2026, 2, prof({ group: 'minijob' }), [{ kind: 'hours', label: 'Stunden', qty: 43.38, rate: 13.9 }]);
    expect(r.minijob).toBe(true);
    expect(r.an.total).toBe(0);
    expect(r.ag.kv).toBeCloseTo(r.gross * 0.13, 2);
    expect(r.ag.rv).toBeCloseTo(r.gross * 0.15, 2);
    expect(r.tax.flat).toBeCloseTo(r.gross * 0.02, 2);
    expect(r.payout).toBe(r.gross);
    const ohneBefreiung = computePayslip(2026, 2, prof({ group: 'minijob', rvExempt: false }), salary(603));
    expect(ohneBefreiung.an.rv).toBeCloseTo(603 * 0.036, 1);
  });
  it('Zuschläge: steuerfrei bis 50 €, beitragsfrei bis 25 € Grundlohn', () => {
    const r = computePayslip(2026, 1, prof(), [...salary(3000), { kind: 'surcharge', label: 'Nacht', qty: 10, rate: 30, percent: 25 }]);
    const z = r.lines[1]!;
    expect(z.amount).toBe(75);
    expect(z.taxable).toBe(0);
    expect(z.svable).toBeCloseTo(10 * 5 * 0.25, 2);
  });
  it('Dienstwagen, steuerfreie Erstattung und Vorschuss verändern nur die Auszahlung', () => {
    const r = computePayslip(2026, 6, prof(), [...salary(5000), { kind: 'benefit', label: 'Dienstwagen 1 %', qty: 1, rate: 450 },
      { kind: 'taxfree', label: 'Fahrtkosten', qty: 1, rate: 80 }, { kind: 'deduction', label: 'Vorschuss', qty: 1, rate: 200 }]);
    expect(r.gross).toBe(5450);
    expect(r.payout).toBeCloseTo(r.net - 450 + 80 - 200, 2);
  });
  it('Einmalzahlung als sonstiger Bezug versteuert', () => {
    const ohne = computePayslip(2026, 11, prof(), salary(4000));
    const mit = computePayslip(2026, 11, prof(), [...salary(4000), { kind: 'bonus', label: 'Weihnachtsgeld', qty: 1, rate: 2000 }], { taxableRegular: 40000, taxableOneOff: 0, svKv: 40000, svRv: 40000, svMonths: 10 });
    expect(mit.tax.lst).toBeGreaterThan(ohne.tax.lst + 300);
    expect(mit.svBaseKv).toBe(6000); // anteilige Jahres-BBG (11 × 5.812,50 − 40.000) reicht für die volle Einmalzahlung
    const knapp = computePayslip(2026, 11, prof(), [...salary(5500), { kind: "bonus", label: "Prämie", qty: 1, rate: 8000 }], { taxableRegular: 55000, taxableOneOff: 0, svKv: 55000, svRv: 55000, svMonths: 10 });
    expect(knapp.svBaseKv).toBeCloseTo(11 * 5812.5 - 55000, 2);
  });
  it('Privat versichert: Zuschuss wird steuerfrei ausgezahlt', () => {
    const r = computePayslip(2026, 1, prof({ insurance: 'pkv', pkvPremium: 700 }), salary(7000));
    expect(r.an.kv).toBe(0);
    expect(r.pkvSubsidy).toBe(350);
    expect(r.payout).toBeCloseTo(r.net + 350, 2);
  });
  it('Umstieg mitten im Jahr: fehlende Monate werden mit dem laufenden Lohn geschätzt', () => {
    const lines = [...salary(4000), { kind: 'bonus' as const, label: 'Prämie', qty: 1, rate: 3000 }];
    const geschaetzt = computePayslip(2026, 10, prof(), lines, { taxableRegular: 0, taxableOneOff: 0, svKv: 0, svRv: 0, svMonths: 0, estimateMonths: 9 });
    const erfasst = computePayslip(2026, 10, prof(), lines, { taxableRegular: 36000, taxableOneOff: 0, svKv: 36000, svRv: 36000, svMonths: 9 });
    expect(geschaetzt.tax.lst).toBe(erfasst.tax.lst);
    expect(geschaetzt.svBaseKv).toBe(erfasst.svBaseKv);
    expect(geschaetzt.notes.some((n) => n.includes('9 Monat'))).toBe(true);
  });
});
