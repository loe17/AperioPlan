/** Formulare und Umfragen (wie Nextcloud Forms) – gemeinsame Typen und Prüfung der Antworten */
export const FORM_QUESTION_TYPES = ['short', 'long', 'single', 'multiple', 'dropdown', 'date', 'time', 'datetime', 'scale', 'file', 'section'] as const;
export type FormQuestionType = (typeof FORM_QUESTION_TYPES)[number];

export const FORM_TYPE_LABELS: Record<FormQuestionType, string> = {
  short: 'Kurze Antwort', long: 'Langer Text', single: 'Einfachauswahl', multiple: 'Mehrfachauswahl', dropdown: 'Auswahlliste',
  date: 'Datum', time: 'Uhrzeit', datetime: 'Datum und Uhrzeit', scale: 'Skala', file: 'Datei hochladen', section: 'Abschnitt (Überschrift)',
};

export interface FormOption { id: string; text: string }
export interface FormQuestion {
  id: string; type: FormQuestionType; text: string; description: string; required: boolean; options: FormOption[];
  extra: {
    /** Auswahl: Feld „Sonstiges“ anbieten, Reihenfolge mischen; Mehrfachauswahl: min./max. Anzahl */
    other?: boolean; shuffle?: boolean; minSelect?: number; maxSelect?: number;
    /** Kurze Antwort: Prüfung */
    validation?: 'none' | 'email' | 'phone' | 'number' | 'regex'; regex?: string;
    /** Skala */
    min?: number; max?: number; minLabel?: string; maxLabel?: string;
    /** Datei */
    maxFiles?: number; fileTypes?: string[]; maxSizeMb?: number;
  };
}

export interface FormSettings {
  /** Antworten ohne Namen speichern */
  anonymous: boolean;
  /** Mehrfach ausfüllen erlaubt */
  allowMultiple: boolean;
  /** Eigene Antwort nachträglich ändern */
  allowEdit: boolean;
  /** Ende der Teilnahme (ISO-Zeitpunkt) */
  expiresAt: string | null;
  /** Von Hand geschlossen */
  closed: boolean;
  /** Text nach dem Absenden */
  submitMessage: string;
  /** Wer sieht die Ergebnisse: nur Eigentümer/Berechtigte oder auch alle Teilnehmer nach dem Absenden */
  showResultsToRespondents: boolean;
}
export const DEFAULT_FORM_SETTINGS: FormSettings = {
  anonymous: false, allowMultiple: false, allowEdit: false, expiresAt: null, closed: false, submitMessage: 'Vielen Dank für Ihre Antwort!', showResultsToRespondents: false,
};

export type FormAnswerValue = string | string[] | { name: string; path: string; size: number }[] | null;
/** Antworten: je Frage-ID ein Text, eine Liste (Mehrfachauswahl) oder hochgeladene Dateien; „Sonstiges“ als other:<Frage-ID> */
export type FormAnswers = Record<string, FormAnswerValue>;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^[+()\d\s/-]{5,30}$/;

/** Prüft Antworten gegen die Fragen; liefert Fehlermeldungen je Frage-ID */
export function validateFormAnswers(questions: FormQuestion[], answers: FormAnswers): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const q of questions) {
    if (q.type === 'section') continue;
    const v = answers[q.id];
    const other = answers[`other:${q.id}`];
    const empty = v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (q.required && !(typeof other === 'string' && other.trim())) errors[q.id] = 'Bitte beantworten';
      continue;
    }
    const optIds = new Set(q.options.map((o) => o.id));
    switch (q.type) {
      case 'short':
        if (typeof v !== 'string') { errors[q.id] = 'Ungültig'; break; }
        if (v.length > 2000) errors[q.id] = 'Zu lang';
        else if (q.extra.validation === 'email' && !EMAIL.test(v)) errors[q.id] = 'Bitte eine E-Mail-Adresse angeben';
        else if (q.extra.validation === 'phone' && !PHONE.test(v)) errors[q.id] = 'Bitte eine Telefonnummer angeben';
        else if (q.extra.validation === 'number' && !/^-?\d+([.,]\d+)?$/.test(v.trim())) errors[q.id] = 'Bitte eine Zahl angeben';
        else if (q.extra.validation === 'regex' && q.extra.regex) { try { if (!new RegExp(q.extra.regex).test(v)) errors[q.id] = 'Eingabe entspricht nicht dem verlangten Format'; } catch { /* ungültiges Muster */ } }
        break;
      case 'long': if (typeof v !== 'string' || v.length > 20000) errors[q.id] = 'Zu lang'; break;
      case 'single': case 'dropdown':
        if (typeof v !== 'string' || !optIds.has(v)) errors[q.id] = 'Ungültige Auswahl'; break;
      case 'multiple': {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !optIds.has(x))) { errors[q.id] = 'Ungültige Auswahl'; break; }
        const n = v.length + (typeof other === 'string' && other.trim() ? 1 : 0);
        if (q.extra.minSelect && n < q.extra.minSelect) errors[q.id] = `Bitte mindestens ${q.extra.minSelect} auswählen`;
        if (q.extra.maxSelect && n > q.extra.maxSelect) errors[q.id] = `Bitte höchstens ${q.extra.maxSelect} auswählen`;
        break;
      }
      case 'date': if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[q.id] = 'Ungültiges Datum'; break;
      case 'time': if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) errors[q.id] = 'Ungültige Uhrzeit'; break;
      case 'datetime': if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) errors[q.id] = 'Ungültige Angabe'; break;
      case 'scale': {
        const n = Number(v), min = q.extra.min ?? 1, max = q.extra.max ?? 5;
        if (!Number.isInteger(n) || n < min || n > max) errors[q.id] = 'Ungültiger Wert';
        break;
      }
      case 'file':
        if (!Array.isArray(v) || v.length > (q.extra.maxFiles ?? 1)) errors[q.id] = `Höchstens ${q.extra.maxFiles ?? 1} Datei(en)`;
        break;
    }
  }
  return errors;
}
