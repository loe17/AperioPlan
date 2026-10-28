/** Inventar und Lager: gemeinsame Hilfen (Abschreibung, Bezeichnungen) */

export const ASSET_STATUS: Record<string, string> = { active: 'In Betrieb', repair: 'In Reparatur', retired: 'Ausgemustert', lost: 'Verloren' };
export const INSPECTION_KINDS = ['DGUV V3 (Elektroprüfung)', 'UVV-Prüfung', 'Kalibrierung', 'Wartung', 'Sichtprüfung', 'TÜV / Hauptuntersuchung', 'Leiter- und Trittprüfung', 'Feuerlöscher'];
export const MOVE_KIND: Record<string, string> = { receipt: 'Zugang', issue: 'Entnahme', transfer: 'Umlagerung', adjust: 'Inventurkorrektur', return: 'Rückgabe' };
export const LOCATION_KIND: Record<string, string> = { warehouse: 'Lager', zone: 'Bereich', shelf: 'Regal', bin: 'Fach' };

/** Geringwertiges Wirtschaftsgut: bis 800 € netto sofort abschreibbar (§ 6 Abs. 2 EStG) */
export const GWG_LIMIT = 800;

export interface DepreciationRow { year: number; start: number; amount: number; end: number }

/**
 * Lineare Abschreibung (AfA) monatsgenau ab Anschaffungsmonat (§ 7 Abs. 1 EStG).
 * GWG bis 800 € werden im Anschaffungsjahr voll abgeschrieben, wenn keine Nutzungsdauer angegeben ist.
 */
export function depreciationSchedule(price: number | null | undefined, purchaseDate: string | null | undefined, years: number | null | undefined): DepreciationRow[] {
  if (!price || price <= 0 || !purchaseDate) return [];
  const d = new Date(`${purchaseDate.slice(0, 10)}T12:00:00`);
  const startYear = d.getFullYear();
  if (!years || years <= 0) {
    return price <= GWG_LIMIT ? [{ year: startYear, start: price, amount: price, end: 0 }] : [];
  }
  const totalMonths = Math.round(years * 12);
  const perMonth = price / totalMonths;
  const rows: DepreciationRow[] = [];
  let remaining = price, monthsLeft = totalMonths, year = startYear, firstMonths = 12 - d.getMonth();
  while (monthsLeft > 0 && rows.length < 100) {
    const m = Math.min(year === startYear ? firstMonths : 12, monthsLeft);
    const amount = monthsLeft === m ? remaining : Math.round(perMonth * m * 100) / 100;
    rows.push({ year, start: Math.round(remaining * 100) / 100, amount, end: Math.round((remaining - amount) * 100) / 100 });
    remaining -= amount; monthsLeft -= m; year++;
  }
  return rows;
}

/** Restbuchwert zum Jahresende des angegebenen Jahres (Standard: aktuelles Jahr) */
export function bookValue(price: number | null | undefined, purchaseDate: string | null | undefined, years: number | null | undefined, atYear = new Date().getFullYear()): number | null {
  if (!price || !purchaseDate) return null;
  const rows = depreciationSchedule(price, purchaseDate, years);
  if (!rows.length) return price;
  if (atYear < rows[0]!.year) return price;
  const row = rows.find((r) => r.year === atYear);
  return row ? row.end : 0;
}

/** nächster Prüftermin: Datum + Intervall in Monaten */
export function addMonths(date: string, months: number): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00`);
  const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
