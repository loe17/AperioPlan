/**
 * Gesetzliche Regeln der Zeiterfassung als änderbare Vorlagen (Deutschland, Österreich, Schweiz).
 * Hilfe, keine Rechtsberatung: Tarifverträge oder Betriebsvereinbarungen können abweichen – alle Werte sind änderbar.
 */

export interface BreakRule { afterMinutes: number; totalMinutes: number }
export interface TimeRuleSet {
  id: string;
  name: string;
  country: 'DE' | 'AT' | 'CH' | 'other';
  /** gestaffelte Pausen: ab mehr als X Minuten Arbeit insgesamt Y Minuten Pause */
  breaks: BreakRule[];
  /** Pausenabschnitte zählen erst ab dieser Länge (DE: 15 Min.) */
  minSegmentMinutes: number;
  maxDailyHours: number;
  restHours: number;
  /** Vorwarnung vor fälliger Pause bzw. Höchstarbeitszeit */
  warnBeforeMinutes: number;
  teamIds: string[];
  source: string;
}

export interface ScheduledBreak { id: string; name: string; start: string; end: string; weekdays: number[]; teamIds: string[] }

export interface TimeRuleSettings {
  sets: TimeRuleSet[];
  defaultSetId: string | null;
  autoBreaks: boolean;
  scheduledBreaks: ScheduledBreak[];
  /** nach so vielen Stunden wird automatisch ausgestempelt (0 = aus) */
  autoClockOutHours: number;
}

export const TIME_RULE_TEMPLATES: Omit<TimeRuleSet, 'teamIds'>[] = [
  { id: 'de', name: 'Deutschland (ArbZG)', country: 'DE', breaks: [{ afterMinutes: 360, totalMinutes: 30 }, { afterMinutes: 540, totalMinutes: 45 }], minSegmentMinutes: 15, maxDailyHours: 10, restHours: 11, warnBeforeMinutes: 15, source: '§§ 3, 4, 5 ArbZG' },
  { id: 'at', name: 'Österreich (AZG)', country: 'AT', breaks: [{ afterMinutes: 360, totalMinutes: 30 }], minSegmentMinutes: 10, maxDailyHours: 10, restHours: 11, warnBeforeMinutes: 15, source: '§ 11 AZG' },
  { id: 'ch', name: 'Schweiz (ArG)', country: 'CH', breaks: [{ afterMinutes: 330, totalMinutes: 15 }, { afterMinutes: 420, totalMinutes: 30 }, { afterMinutes: 540, totalMinutes: 60 }], minSegmentMinutes: 15, maxDailyHours: 12.5, restHours: 11, warnBeforeMinutes: 15, source: 'Art. 15 ArG' },
];

export const DEFAULT_TIME_RULES: TimeRuleSettings = { sets: [], defaultSetId: null, autoBreaks: true, scheduledBreaks: [], autoClockOutHours: 12 };

export interface Interval { start: number; end: number }

/** Pflichtpause in Minuten für eine Arbeitszeit (Minuten) */
export function requiredBreak(set: Pick<TimeRuleSet, 'breaks'>, workMinutes: number): number {
  let req = 0;
  for (const b of set.breaks) if (workMinutes > b.afterMinutes) req = Math.max(req, b.totalMinutes);
  return req;
}

/**
 * Prüft einen Arbeitstag (sortierte Arbeitsabschnitte in Millisekunden) gegen die Regeln:
 * Arbeitszeit, angerechnete Pausen, fehlende Pause und wo sie hingehört (Zeitpunkt, an dem die Schwelle überschritten wurde).
 */
export function evaluateDay(set: Pick<TimeRuleSet, 'breaks' | 'minSegmentMinutes' | 'maxDailyHours'>, work: Interval[]) {
  const sorted = [...work].sort((a, b) => a.start - b.start);
  const workMin = sorted.reduce((a, i) => a + Math.max(0, i.end - i.start), 0) / 60000;
  let breakMin = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i]!.start - sorted[i - 1]!.end) / 60000;
    if (gap >= set.minSegmentMinutes) breakMin += gap;
  }
  const required = requiredBreak(set, workMin);
  const missing = Math.max(0, required - breakMin);
  // Zeitpunkt, an dem die erste nicht erfüllte Stufe überschritten wurde
  let at: number | null = null;
  if (missing > 0) {
    const stage = [...set.breaks].sort((a, b) => a.afterMinutes - b.afterMinutes).find((b) => workMin > b.afterMinutes && breakMin < b.totalMinutes);
    if (stage) {
      let acc = 0;
      for (const i of sorted) {
        const len = (i.end - i.start) / 60000;
        if (acc + len >= stage.afterMinutes) { at = i.start + (stage.afterMinutes - acc) * 60000; break; }
        acc += len;
      }
    }
  }
  return { workMinutes: Math.round(workMin), breakMinutes: Math.round(breakMin), requiredBreak: required, missingBreak: Math.round(missing), breakAt: at, overMax: workMin > set.maxDailyHours * 60 };
}

/** Welcher Regelsatz gilt für eine Abteilung? */
export function ruleSetFor(s: TimeRuleSettings, departmentId: string | null | undefined): TimeRuleSet | null {
  return s.sets.find((x) => departmentId && x.teamIds.includes(departmentId)) ?? s.sets.find((x) => x.id === s.defaultSetId) ?? s.sets[0] ?? null;
}
