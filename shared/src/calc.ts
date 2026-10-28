/**
 * Kalkulation: Sätze (vom Administrator gepflegt) und Rechenwege der Vorlagen.
 * Die Rechnung läuft im Browser (Vorschau beim Tippen) und auf dem Server (gespeichertes Ergebnis, PDF) gleich.
 */

export interface LaborRate { key: string; name: string; wage: number; rate: number; teamIds?: string[] }
export interface MachineRate { key: string; name: string; rate: number }
export interface CalcRates {
  labor: LaborRate[];
  machines: MachineRate[];
  surcharges: { materialOverhead: number; productionOverhead: number; adminSales: number; risk: number; profit: number; purchasedMarkup: number };
  travel: { perKm: number; dailyAllowance: number; partialDayAllowance: number; overnight: number; travelHourRate: number };
}

export const DEFAULT_CALC_RATES: CalcRates = {
  labor: [
    { key: 'konstruktion', name: 'Konstruktion', wage: 42, rate: 95 },
    { key: 'elektro', name: 'Elektrokonstruktion', wage: 40, rate: 90 },
    { key: 'software', name: 'Programmierung', wage: 44, rate: 98 },
    { key: 'fertigung', name: 'Fertigung', wage: 32, rate: 75 },
    { key: 'montage', name: 'Montage', wage: 30, rate: 72 },
    { key: 'inbetriebnahme', name: 'Inbetriebnahme', wage: 38, rate: 85 },
    { key: 'projektleitung', name: 'Projektleitung', wage: 48, rate: 105 },
  ],
  machines: [
    { key: 'fraesen', name: 'CNC-Fräsen', rate: 110 },
    { key: 'drehen', name: 'CNC-Drehen', rate: 95 },
    { key: 'laser', name: 'Laserschneiden', rate: 130 },
    { key: 'schweissen', name: 'Schweißen', rate: 70 },
  ],
  surcharges: { materialOverhead: 8, productionOverhead: 120, adminSales: 15, risk: 3, profit: 10, purchasedMarkup: 10 },
  travel: { perKm: 0.7, dailyAllowance: 28, partialDayAllowance: 14, overnight: 95, travelHourRate: 60 },
};

export type CalcTemplate = 'surcharge' | 'plant' | 'hourly' | 'postcalc' | 'travel';
export const CALC_TEMPLATES: { id: CalcTemplate; name: string; description: string }[] = [
  { id: 'plant', name: 'Angebotskalkulation Anlage', description: 'Baugruppen mit Stunden je Tätigkeit, Material und Zukaufteilen – ergibt den Angebotspreis' },
  { id: 'surcharge', name: 'Zuschlagskalkulation', description: 'Klassisch: Material + Fertigungslöhne + Gemeinkosten-Zuschläge bis zum Verkaufspreis je Stück' },
  { id: 'hourly', name: 'Stundensatz-Kalkulation', description: 'Was kostet eine Stunde? Jahreskosten geteilt durch produktive Stunden' },
  { id: 'postcalc', name: 'Nachkalkulation (Soll/Ist)', description: 'Vergleicht eine freigegebene Kalkulation mit den gebuchten Stunden und dem Einkauf' },
  { id: 'travel', name: 'Reisekosten / Montageeinsatz', description: 'Fahrt, Tagespauschalen, Übernachtung, Reise- und Arbeitszeit' },
];

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (base: number, p: number) => (base * n(p)) / 100;
const laborRate = (rates: CalcRates, key: string, field: 'wage' | 'rate') => rates.labor.find((l) => l.key === key)?.[field] ?? 0;
const machineRate = (rates: CalcRates, key: string) => rates.machines.find((m) => m.key === key)?.rate ?? 0;

export interface Line { label: string; value: number; bold?: boolean; hint?: string; indent?: boolean }
export interface CalcResult { lines: Line[]; total: number; perUnit?: number; extra?: Record<string, unknown> }

// ---------------------------------------------------------------- Zuschlagskalkulation
export interface SurchargeData {
  quantity: number;
  material: { text: string; qty: number; unit: string; price: number }[];
  labor: { text: string; key: string; hours: number }[];
  machines: { text: string; key: string; hours: number }[];
  special: { text: string; amount: number }[];
  surcharges?: Partial<CalcRates['surcharges']>;
}

export function calcSurcharge(d: SurchargeData, rates: CalcRates): CalcResult {
  const s = { ...rates.surcharges, ...(d.surcharges ?? {}) };
  const mek = (d.material ?? []).reduce((a, m) => a + n(m.qty) * n(m.price), 0);
  const mgk = pct(mek, s.materialOverhead);
  const mk = mek + mgk;
  const fl = (d.labor ?? []).reduce((a, l) => a + n(l.hours) * laborRate(rates, l.key, 'wage'), 0);
  const fgk = pct(fl, s.productionOverhead);
  const mach = (d.machines ?? []).reduce((a, m) => a + n(m.hours) * machineRate(rates, m.key), 0);
  const sekf = (d.special ?? []).reduce((a, x) => a + n(x.amount), 0);
  const fk = fl + fgk + mach + sekf;
  const hk = mk + fk;
  const vwvt = pct(hk, s.adminSales);
  const sk = hk + vwvt;
  const risk = pct(sk, s.risk);
  const profit = pct(sk + risk, s.profit);
  const net = sk + risk + profit;
  const qty = Math.max(1, n(d.quantity) || 1);
  return {
    total: r2(net), perUnit: r2(net / qty),
    lines: [
      { label: 'Materialeinzelkosten', value: r2(mek), indent: true },
      { label: `Materialgemeinkosten (${s.materialOverhead} %)`, value: r2(mgk), indent: true },
      { label: 'Materialkosten', value: r2(mk), bold: true },
      { label: 'Fertigungslöhne', value: r2(fl), indent: true },
      { label: `Fertigungsgemeinkosten (${s.productionOverhead} % auf Löhne)`, value: r2(fgk), indent: true },
      { label: 'Maschinenkosten', value: r2(mach), indent: true },
      { label: 'Sondereinzelkosten der Fertigung', value: r2(sekf), indent: true },
      { label: 'Fertigungskosten', value: r2(fk), bold: true },
      { label: 'Herstellkosten', value: r2(hk), bold: true },
      { label: `Verwaltung und Vertrieb (${s.adminSales} %)`, value: r2(vwvt), indent: true },
      { label: 'Selbstkosten', value: r2(sk), bold: true },
      { label: `Wagnis (${s.risk} %)`, value: r2(risk), indent: true },
      { label: `Gewinn (${s.profit} %)`, value: r2(profit), indent: true },
      { label: `Verkaufspreis netto${qty > 1 ? ` für ${qty} Stück` : ''}`, value: r2(net), bold: true },
      ...(qty > 1 ? [{ label: 'je Stück', value: r2(net / qty), bold: true }] : []),
    ],
  };
}

// ---------------------------------------------------------------- Angebotskalkulation Anlage
export type PlantItemKind = 'labor' | 'machine' | 'material' | 'purchased';
export interface PlantData {
  groups: { name: string; items: { text: string; kind: PlantItemKind; key?: string; qty: number; unit?: string; price?: number }[] }[];
  surcharges?: Partial<CalcRates['surcharges']>;
  discount?: number;
}

export function plantItemValue(it: PlantData['groups'][number]['items'][number], rates: CalcRates, s: CalcRates['surcharges']): number {
  if (it.kind === 'labor') return n(it.qty) * laborRate(rates, it.key ?? '', 'rate');
  if (it.kind === 'machine') return n(it.qty) * machineRate(rates, it.key ?? '');
  if (it.kind === 'material') return n(it.qty) * n(it.price) * (1 + n(s.materialOverhead) / 100);
  return n(it.qty) * n(it.price) * (1 + n(s.purchasedMarkup) / 100);
}

export function calcPlant(d: PlantData, rates: CalcRates): CalcResult {
  const s = { ...rates.surcharges, ...(d.surcharges ?? {}) };
  const byKind: Record<PlantItemKind, number> = { labor: 0, machine: 0, material: 0, purchased: 0 };
  const hoursByKey: Record<string, number> = {};
  const groups = (d.groups ?? []).map((g) => {
    let sum = 0;
    for (const it of g.items ?? []) {
      const v = plantItemValue(it, rates, s);
      byKind[it.kind] += v;
      sum += v;
      if (it.kind === 'labor') hoursByKey[it.key ?? ''] = (hoursByKey[it.key ?? ''] ?? 0) + n(it.qty);
    }
    return { name: g.name, value: r2(sum) };
  });
  const sub = byKind.labor + byKind.machine + byKind.material + byKind.purchased;
  const risk = pct(sub, s.risk);
  const profit = pct(sub + risk, s.profit);
  const gross = sub + risk + profit;
  const disc = pct(gross, d.discount ?? 0);
  const net = gross - disc;
  const hours = Object.values(hoursByKey).reduce((a, b) => a + b, 0);
  return {
    total: r2(net),
    extra: { groups, hoursByKey, hours, byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, r2(v)])) },
    lines: [
      ...groups.map((g) => ({ label: g.name || 'ohne Namen', value: g.value, indent: true })),
      { label: `Arbeitsstunden (${r2(hours)} Std.)`, value: r2(byKind.labor) },
      { label: 'Maschinenstunden', value: r2(byKind.machine) },
      { label: `Material (inkl. ${s.materialOverhead} % Gemeinkosten)`, value: r2(byKind.material) },
      { label: `Zukaufteile (inkl. ${s.purchasedMarkup} % Aufschlag)`, value: r2(byKind.purchased) },
      { label: 'Zwischensumme', value: r2(sub), bold: true },
      { label: `Wagnis (${s.risk} %)`, value: r2(risk), indent: true },
      { label: `Gewinn (${s.profit} %)`, value: r2(profit), indent: true },
      ...(disc ? [{ label: `Nachlass (${d.discount} %)`, value: r2(-disc), indent: true }] : []),
      { label: 'Angebotspreis netto', value: r2(net), bold: true },
    ],
  };
}

// ---------------------------------------------------------------- Stundensatz
export interface HourlyData { label: string; employees: number; hoursPerYear: number; productivity: number; costs: { text: string; amount: number }[]; profit: number }

export function calcHourly(d: HourlyData): CalcResult {
  const hours = n(d.employees) * n(d.hoursPerYear) * n(d.productivity) / 100;
  const cost = (d.costs ?? []).reduce((a, c) => a + n(c.amount), 0);
  const costRate = hours ? cost / hours : 0;
  const rate = costRate * (1 + n(d.profit) / 100);
  return {
    total: r2(rate),
    lines: [
      ...(d.costs ?? []).map((c) => ({ label: c.text || 'Kosten', value: r2(n(c.amount)), indent: true })),
      { label: 'Jahreskosten', value: r2(cost), bold: true },
      { label: `Produktive Stunden im Jahr (${n(d.employees)} × ${n(d.hoursPerYear)} Std. × ${n(d.productivity)} %)`, value: r2(hours), hint: 'Stunden' },
      { label: 'Kostendeckender Stundensatz', value: r2(costRate), bold: true },
      { label: `Gewinnaufschlag (${n(d.profit)} %)`, value: r2(rate - costRate), indent: true },
      { label: `Verrechnungssatz ${d.label ?? ''}`.trim(), value: r2(rate), bold: true },
    ],
  };
}

// ---------------------------------------------------------------- Reisekosten / Montageeinsatz
export interface TravelData { persons: number; fullDays: number; partialDays: number; nights: number; km: number; travelHours: number; workHours: number; workKey: string; extras: { text: string; amount: number }[] }

export function calcTravel(d: TravelData, rates: CalcRates): CalcResult {
  const t = rates.travel;
  const p = Math.max(1, n(d.persons));
  const km = n(d.km) * n(t.perKm);
  const allowance = p * (n(d.fullDays) * n(t.dailyAllowance) + n(d.partialDays) * n(t.partialDayAllowance));
  const hotel = p * n(d.nights) * n(t.overnight);
  const travel = p * n(d.travelHours) * n(t.travelHourRate);
  const work = p * n(d.workHours) * laborRate(rates, d.workKey, 'rate');
  const extras = (d.extras ?? []).reduce((a, x) => a + n(x.amount), 0);
  const total = km + allowance + hotel + travel + work + extras;
  return {
    total: r2(total),
    lines: [
      { label: `Fahrtkosten (${n(d.km)} km × ${t.perKm.toLocaleString('de-DE')} €)`, value: r2(km) },
      { label: `Tagespauschalen (${p} Pers.)`, value: r2(allowance) },
      { label: `Übernachtungen (${p} × ${n(d.nights)})`, value: r2(hotel) },
      { label: `Reisezeit (${p} × ${n(d.travelHours)} Std.)`, value: r2(travel) },
      { label: `Arbeitszeit vor Ort (${p} × ${n(d.workHours)} Std., ${rates.labor.find((l) => l.key === d.workKey)?.name ?? ''})`, value: r2(work) },
      ...(d.extras ?? []).map((x) => ({ label: x.text || 'Sonstiges', value: r2(n(x.amount)), indent: true })),
      { label: 'Summe netto', value: r2(total), bold: true },
    ],
  };
}

// ---------------------------------------------------------------- Nachkalkulation
export interface PostcalcActual { laborHoursByKey: Record<string, number>; material: number; purchased: number; other: number }
export interface PostcalcRow { label: string; plan: number; actual: number; unit: '€' | 'Std.' }

export function calcPostcalc(planResult: CalcResult | null, planTemplate: CalcTemplate | null, actual: PostcalcActual, rates: CalcRates): CalcResult & { rows: PostcalcRow[] } {
  const rows: PostcalcRow[] = [];
  const planHours = (planResult?.extra?.hoursByKey ?? {}) as Record<string, number>;
  const keys = [...new Set([...Object.keys(planHours), ...Object.keys(actual.laborHoursByKey)])];
  let planLabor = 0, actLabor = 0;
  for (const k of keys) {
    const name = rates.labor.find((l) => l.key === k)?.name ?? (k || 'ohne Zuordnung');
    const rate = laborRate(rates, k, 'rate');
    rows.push({ label: `${name} – Stunden`, plan: r2(n(planHours[k])), actual: r2(n(actual.laborHoursByKey[k])), unit: 'Std.' });
    planLabor += n(planHours[k]) * rate; actLabor += n(actual.laborHoursByKey[k]) * rate;
  }
  const byKind = (planResult?.extra?.byKind ?? {}) as Record<string, number>;
  const planMat = planTemplate === 'plant' ? n(byKind.material) : 0;
  const planPur = planTemplate === 'plant' ? n(byKind.purchased) : 0;
  rows.push({ label: 'Arbeit (bewertet mit Verrechnungssätzen)', plan: r2(planLabor), actual: r2(actLabor), unit: '€' });
  rows.push({ label: 'Material', plan: r2(planMat), actual: r2(actual.material), unit: '€' });
  rows.push({ label: 'Zukaufteile', plan: r2(planPur), actual: r2(actual.purchased), unit: '€' });
  if (actual.other) rows.push({ label: 'Sonstiges', plan: 0, actual: r2(actual.other), unit: '€' });
  const planTotal = planLabor + planMat + planPur;
  const actTotal = actLabor + actual.material + actual.purchased + actual.other;
  rows.push({ label: 'Kosten gesamt', plan: r2(planTotal), actual: r2(actTotal), unit: '€' });
  const price = planResult?.total ?? 0;
  return {
    rows, total: r2(actTotal),
    lines: [
      { label: 'Geplante Kosten', value: r2(planTotal) },
      { label: 'Tatsächliche Kosten', value: r2(actTotal) },
      { label: 'Abweichung', value: r2(actTotal - planTotal), bold: true },
      ...(price ? [{ label: 'Angebotspreis laut Kalkulation', value: r2(price) }, { label: 'Ergebnis (Preis − Ist-Kosten)', value: r2(price - actTotal), bold: true }] : []),
    ],
  };
}

export function emptyCalcData(t: CalcTemplate, rates: CalcRates): Record<string, unknown> {
  const first = rates.labor[0]?.key ?? '';
  if (t === 'surcharge') return { quantity: 1, material: [], labor: [{ text: 'Fertigung', key: rates.labor.find((l) => l.key === 'fertigung')?.key ?? first, hours: 0 }], machines: [], special: [] };
  if (t === 'plant') return { groups: [{ name: 'Konstruktion und Planung', items: [{ text: 'Mechanische Konstruktion', kind: 'labor', key: first, qty: 0, unit: 'Std' }] }], discount: 0 };
  if (t === 'hourly') return { label: '', employees: 1, hoursPerYear: 1720, productivity: 80, profit: 10, costs: [{ text: 'Personalkosten (Lohn + Nebenkosten)', amount: 0 }, { text: 'Raumkosten', amount: 0 }, { text: 'Energie', amount: 0 }, { text: 'Abschreibung Maschinen', amount: 0 }, { text: 'Zinsen', amount: 0 }, { text: 'Sonstiges', amount: 0 }] };
  if (t === 'travel') return { persons: 1, fullDays: 0, partialDays: 2, nights: 1, km: 0, travelHours: 0, workHours: 8, workKey: rates.labor.find((l) => l.key === 'inbetriebnahme')?.key ?? first, extras: [] };
  return {};
}

/** Rechnet eine Kalkulation (außer Nachkalkulation, die braucht Ist-Daten vom Server) */
export function computeCalc(t: CalcTemplate, data: any, rates: CalcRates): CalcResult {
  if (t === 'surcharge') return calcSurcharge(data, rates);
  if (t === 'plant') return calcPlant(data, rates);
  if (t === 'hourly') return calcHourly(data);
  if (t === 'travel') return calcTravel(data, rates);
  return { lines: [], total: 0 };
}
