/**
 * Reisekosten: Verpflegungspauschalen (Verpflegungsmehraufwand, § 9 Abs. 4a EStG) und Kilometergeld.
 * Inland 2026: 14 € bei mehr als 8 Stunden Abwesenheit sowie An- und Abreisetag, 28 € je vollem Tag.
 * Gestellte Mahlzeiten kürzen: Frühstück 20 %, Mittag- und Abendessen je 40 % der vollen Pauschale.
 */
export interface MealDay { breakfast?: boolean; lunch?: boolean; dinner?: boolean }
export interface PerDiemRates { full: number; partial: number }
export const DOMESTIC_RATES: PerDiemRates = { full: 28, partial: 14 };
export const KM_RATE = 0.3;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Tage einer Reise mit Pauschale; start/end als Ortszeit (YYYY-MM-DDTHH:MM) */
export function perDiem(start: string, end: string, meals: Record<string, MealDay> = {}, rates: PerDiemRates = DOMESTIC_RATES) {
  const s = new Date(start), e = new Date(end);
  if (!(e > s)) return { days: [] as { date: string; kind: 'none' | 'partial' | 'full'; base: number; cut: number; amount: number }[], total: 0 };
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const first = day(s), last = day(e);
  const days: { date: string; kind: 'none' | 'partial' | 'full'; base: number; cut: number; amount: number }[] = [];
  const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 12);
  while (day(cur) <= last) {
    const d = day(cur);
    let kind: 'none' | 'partial' | 'full';
    if (first === last) kind = (e.getTime() - s.getTime()) / 3600000 > 8 ? 'partial' : 'none';
    else kind = d === first || d === last ? 'partial' : 'full';
    const base = kind === 'full' ? rates.full : kind === 'partial' ? rates.partial : 0;
    const m = meals[d] ?? {};
    const cut = base ? r2((m.breakfast ? 0.2 : 0) * rates.full + (m.lunch ? 0.4 : 0) * rates.full + (m.dinner ? 0.4 : 0) * rates.full) : 0;
    days.push({ date: d, kind, base, cut: Math.min(cut, base), amount: r2(Math.max(0, base - cut)) });
    cur.setDate(cur.getDate() + 1);
  }
  return { days, total: r2(days.reduce((a, x) => a + x.amount, 0)) };
}

export const EXPENSE_KINDS: Record<string, string> = { receipt: 'Beleg', mileage: 'Kilometer (eigenes Fahrzeug)', lodging: 'Übernachtung', travel: 'Fahrkarte / Flug', other: 'Sonstiges' };
export const EXPENSE_CATEGORIES = ['Bewirtung', 'Parken', 'Maut', 'Taxi', 'Bahn', 'Flug', 'Hotel', 'Tanken (Firmenwagen)', 'Material', 'Porto', 'Sonstiges'];
