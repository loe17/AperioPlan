/** Qualität: Prüfmerkmale, Bewertung von Messwerten, 8D-Schritte */

export interface Characteristic {
  id: string;
  name: string;
  /** Messmerkmal (Zahl mit Toleranz) oder attributives Merkmal (i. O. / n. i. O.) */
  kind: 'measure' | 'attribute';
  nominal?: number | null;
  lower?: number | null;
  upper?: number | null;
  unit?: string;
  method?: string;
  /** Messwerte bzw. Bewertungen (true = i. O.) einer Prüfung */
  values?: (number | boolean | null)[];
  note?: string;
}

export type CharResult = 'open' | 'pass' | 'fail';

/** Bewertet ein Merkmal: alle Werte innerhalb der Toleranz bzw. alle i. O. */
export function evaluateCharacteristic(c: Characteristic): CharResult {
  const vals = (c.values ?? []).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return 'open';
  if (c.kind === 'attribute') return vals.every((v) => v === true) ? 'pass' : 'fail';
  const lo = c.lower ?? -Infinity, hi = c.upper ?? Infinity;
  return vals.every((v) => typeof v === 'number' && v >= lo - 1e-12 && v <= hi + 1e-12) ? 'pass' : 'fail';
}

/** Gesamtergebnis: offen, solange ein Merkmal offen ist; sonst n. i. O., sobald eines n. i. O. ist */
export function evaluateInspection(chars: Characteristic[]): CharResult {
  const r = chars.map(evaluateCharacteristic);
  if (!r.length || r.includes('open')) return 'open';
  return r.includes('fail') ? 'fail' : 'pass';
}

/** Kennwerte einer Messreihe (Mittelwert, Spannweite, Standardabweichung, Cpk) */
export function stats(c: Characteristic) {
  const v = (c.values ?? []).filter((x): x is number => typeof x === 'number');
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
  const lo = c.lower ?? null, hi = c.upper ?? null;
  const cpk = sd > 0 && lo !== null && hi !== null ? Math.min(hi - mean, mean - lo) / (3 * sd) : null;
  return { n: v.length, mean, min: Math.min(...v), max: Math.max(...v), range: Math.max(...v) - Math.min(...v), sd, cpk };
}

export const EIGHT_D: { key: string; title: string; hint: string }[] = [
  { key: 'd1', title: 'D1 Team', hint: 'Wer arbeitet an der Lösung? Verantwortlicher und Fachleute.' },
  { key: 'd2', title: 'D2 Problembeschreibung', hint: 'Was, wo, wann, wie viel? Fakten, Fotos, betroffene Teile und Mengen.' },
  { key: 'd3', title: 'D3 Sofortmaßnahmen', hint: 'Was schützt den Kunden jetzt? Sperren, Sortieren, Nacharbeit.' },
  { key: 'd4', title: 'D4 Ursachenanalyse', hint: 'Grundursache für Entstehung und Nicht-Entdecken (z. B. 5-Why, Ishikawa).' },
  { key: 'd5', title: 'D5 Abstellmaßnahmen', hint: 'Welche dauerhaften Maßnahmen beseitigen die Ursache? Nachweis der Wirksamkeit geplant.' },
  { key: 'd6', title: 'D6 Umsetzung und Wirksamkeit', hint: 'Umsetzung mit Termin; Nachweis, dass der Fehler nicht mehr auftritt.' },
  { key: 'd7', title: 'D7 Wiederholung verhindern', hint: 'Was ändert sich an Abläufen, Prüfplänen, FMEA, Anweisungen?' },
  { key: 'd8', title: 'D8 Abschluss und Würdigung', hint: 'Abschluss mit dem Team, Erfahrungen sichern.' },
];
export const EIGHT_D_STATUS: Record<string, string> = { open: 'offen', containment: 'Sofortmaßnahmen', analysis: 'Ursachenanalyse', actions: 'Maßnahmen', verification: 'Wirksamkeit', closed: 'abgeschlossen' };
export const INSPECTION_KIND: Record<string, string> = { incoming: 'Wareneingang', production: 'Fertigung', final: 'Endprüfung', other: 'Sonstige' };
