/**
 * Lohnabrechnung: Sozialversicherung, Zuschläge und Berechnung eines Lohnzettels.
 * Lohnsteuer und Solidaritätszuschlag kommen aus dem amtlichen Rechenweg (lohnsteuer.ts).
 *
 * Werte 2026: Sozialversicherungs-Rechengrößenverordnung 2026, Minijob-Zentrale, GKV-Spitzenverband.
 * Vereinfachungen (bewusst, siehe Hinweise im Lohnzettel): keine Märzklausel, keine Mehrfachbeschäftigung,
 * keine Altersteilzeit/Kurzarbeit, Unfallversicherung (Berufsgenossenschaft) nicht enthalten.
 */
import { lohnsteuer } from './lohnsteuer';

export interface SvParams {
  year: number;
  /** Beitragsbemessungsgrenzen je Monat */
  bbgKv: number; bbgRv: number;
  /** Beitragssätze in Prozent (gesamt) */
  kv: number; avgZusatz: number; pv: number; pvAnSachsen: number; pvChildless: number; pvChildReduction: number; rv: number; av: number; insolvency: number;
  /** Minijob-Grenze, Obergrenze Übergangsbereich, Faktor F */
  minijob: number; midiUpper: number; factorF: number;
  /** Minijob-Pauschalen in Prozent */
  mini: { kv: number; rv: number; rvAn: number; tax: number; u1: number; u2: number };
  /** Steuerfreie Zuschläge (§ 3b EStG): Grundlohn höchstens 50 €/Std. steuerfrei, 25 €/Std. beitragsfrei */
  surchargeTaxBase: number; surchargeSvBase: number;
}

export const SV_PARAMS: Record<number, SvParams> = {
  2026: {
    year: 2026, bbgKv: 5812.5, bbgRv: 8450, kv: 14.6, avgZusatz: 2.9, pv: 3.6, pvAnSachsen: 2.3, pvChildless: 0.6, pvChildReduction: 0.25, rv: 18.6, av: 2.6, insolvency: 0.15,
    minijob: 603, midiUpper: 2000, factorF: 0.6619,
    mini: { kv: 13, rv: 15, rvAn: 3.6, tax: 2, u1: 0.8, u2: 0.22 },
    surchargeTaxBase: 50, surchargeSvBase: 25,
  },
};
export const PAYROLL_YEARS = Object.keys(SV_PARAMS).map(Number);
export const svParams = (year: number) => SV_PARAMS[year] ?? SV_PARAMS[Math.max(...PAYROLL_YEARS)]!;

/** Kirchensteuersatz: 8 % in Baden-Württemberg und Bayern, sonst 9 % */
export const churchRate = (state: string) => (['BW', 'BY'].includes(state) ? 8 : 9);
export const STATES: [string, string][] = [['BW', 'Baden-Württemberg'], ['BY', 'Bayern'], ['BE', 'Berlin'], ['BB', 'Brandenburg'], ['HB', 'Bremen'], ['HH', 'Hamburg'], ['HE', 'Hessen'],
  ['MV', 'Mecklenburg-Vorpommern'], ['NI', 'Niedersachsen'], ['NW', 'Nordrhein-Westfalen'], ['RP', 'Rheinland-Pfalz'], ['SL', 'Saarland'], ['SN', 'Sachsen'], ['ST', 'Sachsen-Anhalt'], ['SH', 'Schleswig-Holstein'], ['TH', 'Thüringen']];

export type EmploymentGroup = 'regular' | 'minijob' | 'student';
export const EMPLOYMENT_GROUPS: Record<EmploymentGroup, { label: string; pgr: string }> = {
  regular: { label: 'sozialversicherungspflichtig (auch Midijob bis 2.000 €)', pgr: '101' },
  minijob: { label: 'Minijob (bis 603 €)', pgr: '109' },
  student: { label: 'Werkstudent (nur Rentenversicherung)', pgr: '106' },
};

export interface PayProfile {
  group: EmploymentGroup;
  taxClass: 1 | 2 | 3 | 4 | 5 | 6;
  /** Faktor bei Steuerklasse IV mit Faktor (0 = kein Faktorverfahren) */
  factor: number;
  /** Zahl der Kinderfreibeträge laut ELStAM */
  childAllowances: number;
  church: boolean;
  /** Bundesland der Betriebsstätte (Kirchensteuersatz, Sachsen bei PV) */
  state: string;
  /** Steuerfreibetrag / Hinzurechnungsbetrag laut ELStAM je Monat (€) */
  taxFreeMonthly: number; taxAddMonthly: number;
  insurance: 'gkv' | 'pkv';
  /** Zusatzbeitrag der Krankenkasse in Prozent */
  kvZusatz: number;
  /** Privat versichert: Monatsbeitrag Basis-Kranken- und Pflegeversicherung (€) */
  pkvPremium: number;
  /** Kinder unter 25 (für PV-Abschläge) und Kinderlosenzuschlag */
  pvChildren: number; pvChildless: boolean;
  /** Minijob: Befreiung von der Rentenversicherungspflicht; Pauschsteuer 2 % durch Arbeitgeber */
  rvExempt: boolean; flatTax: boolean;
  /** Umlagesätze der Krankenkasse in Prozent (U1 Krankheit, U2 Mutterschaft) */
  u1: number; u2: number;
}

export type PayLineKind = 'salary' | 'hours' | 'overtime' | 'surcharge' | 'bonus' | 'benefit' | 'taxfree' | 'deduction';
export const PAY_LINE_KINDS: Record<PayLineKind, { label: string; hint: string }> = {
  salary: { label: 'Gehalt', hint: 'steuer- und beitragspflichtig' },
  hours: { label: 'Stundenlohn', hint: 'Stunden × Satz' },
  overtime: { label: 'Überstunden', hint: 'Stunden × Satz' },
  surcharge: { label: 'Zuschlag Nacht/Sonntag/Feiertag', hint: 'steuerfrei nach § 3b EStG im Rahmen der Grenzen' },
  bonus: { label: 'Einmalzahlung', hint: 'Prämie, Urlaubs-/Weihnachtsgeld – sonstiger Bezug' },
  benefit: { label: 'Sachbezug / geldwerter Vorteil', hint: 'versteuert, wird nicht ausgezahlt (z. B. Dienstwagen)' },
  taxfree: { label: 'Steuerfreie Zahlung', hint: 'z. B. Fahrtkosten, Erstattung, Sachbezug bis 50 €' },
  deduction: { label: 'Abzug vom Netto', hint: 'z. B. Vorschuss, vermögenswirksame Leistung, Pfändung' },
};

export interface PayLine {
  kind: PayLineKind;
  label: string;
  /** Menge (Stunden) und Satz; bei Beträgen ohne Menge qty = 1 */
  qty: number;
  rate: number;
  /** Zuschlag: Prozentsatz auf den Grundlohn und gesetzliche Höchstgrenze für Steuerfreiheit */
  percent?: number;
  /** Herkunft (z. B. „aus Zeiterfassung“) */
  source?: string;
}

/** Zuschlag-Arten nach § 3b EStG mit steuerfreiem Höchstsatz */
export const SURCHARGES: { id: string; label: string; percent: number; maxTaxFree: number }[] = [
  { id: 'night', label: 'Nachtarbeit 20–6 Uhr', percent: 25, maxTaxFree: 25 },
  { id: 'night0', label: 'Nachtarbeit 0–4 Uhr (Beginn vor 0 Uhr)', percent: 40, maxTaxFree: 40 },
  { id: 'sunday', label: 'Sonntagsarbeit', percent: 50, maxTaxFree: 50 },
  { id: 'holiday', label: 'Feiertagsarbeit', percent: 125, maxTaxFree: 125 },
  { id: 'special', label: '24./31. Dezember ab 14 Uhr, 25./26. Dezember, 1. Mai', percent: 150, maxTaxFree: 150 },
];

export interface YearToDate {
  /** Bisher in diesem Jahr gezahlter laufender steuerpflichtiger Lohn und sonstige Bezüge (€) */
  taxableRegular: number; taxableOneOff: number;
  /** Bisheriges beitragspflichtiges Entgelt KV/PV und RV/AV (€) und Zahl der SV-Tage/30 */
  svKv: number; svRv: number; svMonths: number;
  /** Monate dieses Jahres ohne erfasste Werte (vor dem Umstieg auf AperioPlan) – werden mit dem laufenden Lohn geschätzt */
  estimateMonths?: number;
}
export const EMPTY_YTD: YearToDate = { taxableRegular: 0, taxableOneOff: 0, svKv: 0, svRv: 0, svMonths: 0, estimateMonths: 0 };

export interface Contributions { kv: number; pv: number; rv: number; av: number }
export interface PayslipResult {
  year: number; month: number;
  lines: (PayLine & { amount: number; taxable: number; svable: number })[];
  /** Gesamtbrutto (inkl. Sachbezüge), steuerpflichtig laufend/einmalig, SV-pflichtig */
  gross: number; taxRegular: number; taxOneOff: number; svBase: number; svBaseKv: number; svBaseRv: number;
  tax: { lst: number; soli: number; church: number; flat: number };
  an: Contributions & { total: number };
  ag: Contributions & { u1: number; u2: number; insolvency: number; total: number };
  /** Zuschuss zur privaten Kranken-/Pflegeversicherung (steuerfrei, wird ausgezahlt) */
  pkvSubsidy: number;
  net: number; payout: number; employerCost: number;
  midijob: boolean; minijob: boolean;
  notes: string[];
}

const r2 = (n: number) => Math.round(n * 100 + Number.EPSILON * Math.sign(n)) / 100;
const cents = (n: number) => Math.round(n * 100);

/** Betrag einer Zeile; Zuschläge: Stunden × Grundlohn × Prozent */
export function lineAmount(l: PayLine): number {
  if (l.kind === 'surcharge') return r2(l.qty * l.rate * ((l.percent ?? 0) / 100));
  return r2(l.qty * l.rate);
}

/** Zuschlag: steuer- und beitragsfreier Anteil nach § 3b EStG / § 1 SvEV */
export function surchargeSplit(l: PayLine, p: SvParams): { taxFree: number; svFree: number } {
  const pct = l.percent ?? 0;
  const max = SURCHARGES.reduce((m, s) => (Math.abs(s.percent - pct) < 1e-9 ? Math.max(m, s.maxTaxFree) : m), 0) || Math.min(pct, 25);
  const usePct = Math.min(pct, max);
  const taxFree = r2(l.qty * Math.min(l.rate, p.surchargeTaxBase) * usePct / 100);
  const svFree = r2(l.qty * Math.min(l.rate, p.surchargeSvBase) * usePct / 100);
  return { taxFree: Math.min(taxFree, lineAmount(l)), svFree: Math.min(svFree, taxFree) };
}

/** Übergangsbereich (§ 20 Abs. 2a SGB IV): beitragspflichtige Einnahme gesamt und für den Arbeitnehmeranteil */
export function midijobBases(ae: number, p: SvParams) {
  const G = p.minijob, OG = p.midiUpper, F = p.factorF;
  const be = r2(F * G + (OG / (OG - G) - (G / (OG - G)) * F) * (ae - G));
  const beAn = r2((OG / (OG - G)) * (ae - G));
  return { be, beAn };
}

export function computePayslip(year: number, month: number, prof: PayProfile, input: PayLine[], ytd: YearToDate = EMPTY_YTD): PayslipResult {
  const p = svParams(year);
  const notes: string[] = [];
  const lines = input.map((l) => {
    const amount = lineAmount(l);
    let taxable = amount, svable = amount;
    if (l.kind === 'surcharge') { const s = surchargeSplit(l, p); taxable = r2(amount - s.taxFree); svable = r2(amount - s.svFree); }
    if (l.kind === 'taxfree') { taxable = 0; svable = 0; }
    if (l.kind === 'deduction') { taxable = 0; svable = 0; }
    return { ...l, amount, taxable, svable };
  });
  const sum = (f: (l: (typeof lines)[number]) => number) => r2(lines.reduce((s, l) => s + f(l), 0));
  const gross = sum((l) => (l.kind === 'deduction' || l.kind === 'taxfree' ? 0 : l.amount));
  const taxOneOff = sum((l) => (l.kind === 'bonus' ? l.taxable : 0));
  const taxRegular = sum((l) => (l.kind === 'bonus' ? 0 : l.taxable));
  const svRegular = sum((l) => (l.kind === 'bonus' ? 0 : l.svable));
  const svOneOff = sum((l) => (l.kind === 'bonus' ? l.svable : 0));
  const paidTaxFree = sum((l) => (l.kind === 'taxfree' ? l.amount : 0));
  const deductions = sum((l) => (l.kind === 'deduction' ? l.amount : 0));
  const benefits = sum((l) => (l.kind === 'benefit' ? l.amount : 0));

  const an = { kv: 0, pv: 0, rv: 0, av: 0, total: 0 };
  const ag = { kv: 0, pv: 0, rv: 0, av: 0, u1: 0, u2: 0, insolvency: 0, total: 0 };
  const tax = { lst: 0, soli: 0, church: 0, flat: 0 };
  let pkvSubsidy = 0;
  const svTotal = r2(svRegular + svOneOff);
  const minijob = prof.group === 'minijob';
  const midijob = !minijob && prof.group === 'regular' && svTotal > p.minijob && svTotal <= p.midiUpper;
  if (minijob && svTotal > p.minijob) notes.push(`Das Entgelt liegt über der Minijob-Grenze von ${p.minijob} € – bitte Beschäftigungsart prüfen.`);
  if (prof.group === 'regular' && svTotal > 0 && svTotal <= p.minijob) notes.push('Das Entgelt liegt im Minijob-Bereich – bitte Beschäftigungsart prüfen.');

  // Beitragspflichtige Entgelte mit Bemessungsgrenzen; Einmalzahlungen im Rahmen der anteiligen Jahresgrenze
  const est = ytd.estimateMonths ?? 0;
  const months = ytd.svMonths + est + 1;
  const capOneOff = (bbg: number, prev: number) => Math.max(0, Math.min(svOneOff, bbg * months - prev - Math.min(svRegular, bbg) * (1 + est)));
  const svBaseKv = r2(Math.min(svRegular, p.bbgKv) + capOneOff(p.bbgKv, ytd.svKv));
  const svBaseRv = r2(Math.min(svRegular, p.bbgRv) + capOneOff(p.bbgRv, ytd.svRv));
  if (est > 0 && (svOneOff > 0 || taxOneOff > 0)) notes.push(`Für ${est} Monat(e) dieses Jahres ohne Abrechnung in AperioPlan wurde der laufende Lohn angenommen.`);

  const pvParity = prof.state === 'SN' ? p.pvAnSachsen : p.pv / 2;
  const pvReduction = prof.pvChildless ? 0 : Math.min(4, Math.max(0, prof.pvChildren - 1)) * p.pvChildReduction;
  const pvAnRate = pvParity + (prof.pvChildless ? p.pvChildless : 0) - pvReduction;
  const pvAgRate = p.pv - pvParity;
  const kvHalf = (p.kv + prof.kvZusatz) / 2;
  const pct = (base: number, rate: number) => r2((base * rate) / 100);

  if (minijob) {
    if (prof.insurance === 'gkv') ag.kv = pct(svTotal, p.mini.kv);
    ag.rv = pct(svTotal, p.mini.rv);
    if (!prof.rvExempt) an.rv = r2(pct(svTotal, p.rv) - ag.rv);
    ag.u1 = pct(svTotal, p.mini.u1); ag.u2 = pct(svTotal, p.mini.u2); ag.insolvency = pct(svTotal, p.insolvency);
    if (prof.flatTax) tax.flat = pct(r2(taxRegular + taxOneOff), p.mini.tax);
  } else if (midijob && svOneOff === 0) {
    const { be, beAn } = midijobBases(svTotal, p);
    notes.push(`Übergangsbereich (Midijob): Beiträge aus ${be.toFixed(2)} € (Arbeitnehmer aus ${beAn.toFixed(2)} €).`);
    const split = (fullRate: number, anRate: number, anExtra = 0) => {
      const total = pct(be, fullRate), anPart = pct(beAn, anRate);
      return { an: r2(anPart + pct(beAn, anExtra)), ag: r2(total - anPart) };
    };
    if (prof.insurance === 'gkv') { const k = split(p.kv + prof.kvZusatz, kvHalf); an.kv = k.an; ag.kv = k.ag; }
    if (prof.insurance === 'gkv') { const v = split(p.pv, pvParity, pvAnRate - pvParity); an.pv = v.an; ag.pv = v.ag; }
    const r = split(p.rv, p.rv / 2); an.rv = r.an; ag.rv = r.ag;
    const a = split(p.av, p.av / 2); an.av = a.an; ag.av = a.ag;
    ag.insolvency = pct(svTotal, p.insolvency);
    ag.u1 = pct(svTotal, prof.u1); ag.u2 = pct(svTotal, prof.u2);
  } else {
    if (midijob) notes.push('Einmalzahlung im Übergangsbereich: vereinfacht wie reguläre Beschäftigung berechnet.');
    if (prof.group === 'regular') {
      if (prof.insurance === 'gkv') {
        an.kv = pct(svBaseKv, kvHalf); ag.kv = pct(svBaseKv, kvHalf);
        an.pv = pct(svBaseKv, pvAnRate); ag.pv = pct(svBaseKv, pvAgRate);
      }
      an.av = pct(svBaseRv, p.av / 2); ag.av = pct(svBaseRv, p.av / 2);
    }
    an.rv = pct(svBaseRv, p.rv / 2); ag.rv = pct(svBaseRv, p.rv / 2);
    ag.insolvency = pct(svBaseRv, p.insolvency);
    ag.u1 = pct(Math.min(svTotal, p.bbgRv), prof.u1); ag.u2 = pct(Math.min(svTotal, p.bbgRv), prof.u2);
  }
  if (prof.insurance === 'pkv' && !minijob && prof.group !== 'student') {
    const maxKv = r2(p.bbgKv * (p.kv / 2 + p.avgZusatz / 2) / 100), maxPv = r2(p.bbgKv * (p.pv / 2) / 100);
    pkvSubsidy = r2(Math.min(prof.pkvPremium / 2, maxKv + maxPv));
  }
  an.total = r2(an.kv + an.pv + an.rv + an.av);

  // Lohnsteuer nach amtlichem Programmablaufplan
  if (!(minijob && prof.flatTax) && (taxRegular > 0 || taxOneOff > 0)) {
    const common = {
      STKL: prof.taxClass, ZKF: prof.taxClass <= 4 ? prof.childAllowances : 0, R: prof.church ? 1 : 0, KVZ: prof.kvZusatz,
      PVZ: (prof.pvChildless ? 1 : 0) as 0 | 1, PVA: prof.pvChildless ? 0 : Math.min(4, Math.max(0, prof.pvChildren - 1)), PVS: (prof.state === 'SN' ? 1 : 0) as 0 | 1,
      PKV: (prof.insurance === 'pkv' ? 1 : 0) as 0 | 1, PKPV: cents(prof.pkvPremium), PKPVAGZ: cents(pkvSubsidy),
      KRV: (minijob && prof.rvExempt ? 1 : 0) as 0 | 1, ALV: (prof.group !== 'regular' ? 1 : 0) as 0 | 1,
      af: (prof.taxClass === 4 && prof.factor > 0 ? 1 : 0) as 0 | 1, f: prof.taxClass === 4 && prof.factor > 0 ? prof.factor : 1,
      LZZFREIB: cents(prof.taxFreeMonthly), LZZHINZU: cents(prof.taxAddMonthly),
    };
    // voraussichtlicher Jahresarbeitslohn: bisheriger Lohn + laufender Lohn hochgerechnet auf den Rest des Jahres + bisherige Einmalzahlungen
    const jre4 = r2(ytd.taxableRegular + taxRegular * (13 - month + est) + ytd.taxableOneOff);
    const res = lohnsteuer(year, { LZZ: 2, RE4: cents(taxRegular), ...common, SONSTB: cents(taxOneOff), JRE4: cents(jre4), JFREIB: cents(prof.taxFreeMonthly * 12), JHINZU: cents(prof.taxAddMonthly * 12) });
    tax.lst = r2((res.LSTLZZ + res.STS) / 100);
    tax.soli = r2((res.SOLZLZZ + res.SOLZS) / 100);
    if (prof.church) tax.church = r2((Math.floor(((res.BK + res.BKS) * churchRate(prof.state)) / 100)) / 100);
  }
  if (minijob && prof.flatTax) notes.push('Pauschsteuer 2 % trägt der Arbeitgeber (an die Minijob-Zentrale).');

  const taxTotal = r2(tax.lst + tax.soli + tax.church);
  const net = r2(gross - taxTotal - an.total);
  const payout = r2(net - benefits + paidTaxFree + pkvSubsidy - deductions);
  ag.total = r2(ag.kv + ag.pv + ag.rv + ag.av + ag.u1 + ag.u2 + ag.insolvency + tax.flat);
  const employerCost = r2(gross + paidTaxFree + pkvSubsidy + ag.total);
  return { year, month, lines, gross, taxRegular, taxOneOff, svBase: svTotal, svBaseKv, svBaseRv, tax, an, ag, pkvSubsidy, net, payout, employerCost, midijob, minijob, notes };
}

/** Beitragsgruppenschlüssel (KV RV AV PV) für Meldungen und Lohnzettel */
export function contributionGroup(prof: PayProfile): string {
  if (prof.group === 'minijob') return `${prof.insurance === 'gkv' ? '6' : '0'}${prof.rvExempt ? '5' : '1'}00`;
  if (prof.group === 'student') return '0100';
  return prof.insurance === 'gkv' ? '1111' : '0110';
}

export const DEFAULT_PAY_PROFILE: PayProfile = {
  group: 'regular', taxClass: 1, factor: 0, childAllowances: 0, church: false, state: 'BW', taxFreeMonthly: 0, taxAddMonthly: 0,
  insurance: 'gkv', kvZusatz: 2.9, pkvPremium: 0, pvChildren: 0, pvChildless: true, rvExempt: true, flatTax: true, u1: 1.6, u2: 0.44,
};
