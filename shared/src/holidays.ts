/** Gesetzliche Feiertage in Deutschland je Bundesland (für die Urlaubsberechnung). */
export const GERMAN_STATES: Record<string, string> = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg', HE: 'Hessen',
  MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen', RP: 'Rheinland-Pfalz', SL: 'Saarland',
  SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen',
};

/** Ostersonntag nach Gauß/Meeus */
export function easterSunday(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

export function germanHolidays(year: number, state: string): { day: string; name: string }[] {
  const e = easterSunday(year);
  const fixed = (m: number, d: number) => new Date(Date.UTC(year, m - 1, d));
  const list: [Date, string, string[] | null][] = [
    [fixed(1, 1), 'Neujahr', null],
    [fixed(1, 6), 'Heilige Drei Könige', ['BW', 'BY', 'ST']],
    [fixed(3, 8), 'Internationaler Frauentag', ['BE', 'MV']],
    [addDays(e, -2), 'Karfreitag', null],
    [addDays(e, 1), 'Ostermontag', null],
    [fixed(5, 1), 'Tag der Arbeit', null],
    [addDays(e, 39), 'Christi Himmelfahrt', null],
    [addDays(e, 50), 'Pfingstmontag', null],
    [addDays(e, 60), 'Fronleichnam', ['BW', 'BY', 'HE', 'NW', 'RP', 'SL']],
    [fixed(8, 15), 'Mariä Himmelfahrt', ['SL']],
    [fixed(9, 20), 'Weltkindertag', ['TH']],
    [fixed(10, 3), 'Tag der Deutschen Einheit', null],
    [fixed(10, 31), 'Reformationstag', ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH']],
    [fixed(11, 1), 'Allerheiligen', ['BW', 'BY', 'NW', 'RP', 'SL']],
    [fixed(12, 25), '1. Weihnachtstag', null],
    [fixed(12, 26), '2. Weihnachtstag', null],
  ];
  // Buß- und Bettag (Mittwoch vor dem 23. November) – nur Sachsen
  const nov23 = fixed(11, 23);
  const bb = addDays(nov23, -(((nov23.getUTCDay() + 7 - 3) % 7) || 7));
  list.push([bb, 'Buß- und Bettag', ['SN']]);
  return list.filter(([, , s]) => !s || s.includes(state)).map(([d, name]) => ({ day: iso(d), name })).sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Zählt Urlaubstage zwischen zwei Daten (inklusive) ohne Wochenenden und Feiertage.
 * Halbe Tage am ersten/letzten Tag werden mit 0,5 gezählt.
 */
export function countWorkingDays(start: string, end: string, holidays: Set<string>, halfStart = false, halfEnd = false): number {
  let days = 0;
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  for (let d = s; d <= e; d = addDays(d, 1)) {
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6 || holidays.has(iso(d))) continue;
    let v = 1;
    if (iso(d) === start && halfStart) v -= 0.5;
    if (iso(d) === end && halfEnd && (start !== end || !halfStart)) v -= 0.5;
    days += v;
  }
  return days;
}
