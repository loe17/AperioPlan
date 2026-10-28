/**
 * Nummerierungssystem (Kapitel 6 des Implementierungsplans).
 *
 * A) Projekte:  0100  oder  PRJ-2026-0042, Teilprojekte 0100-A, Dokumente 0100-DOK-001
 * B) 3D-CAD:    0100-100-00-0000-00_Rahmen
 *               │    │   │  │    │  └ sprechende Benennung
 *               │    │   │  │    └ Versionsstand (00 = Urversion)
 *               │    │   │  └ fortlaufende Teilenummer
 *               │    │   └ Unter-Unterbaugruppe
 *               │    └ Unterbaugruppe (100 Gestell, 200 Antrieb, 300 Pneumatik ...)
 *               └ Hauptbaugruppe = Projektnummer
 */

export type ProjectNumberFormat = 'sequential' | 'year' | 'pattern';

export interface ProjectNumberSettings {
  format: ProjectNumberFormat;
  /** Präfix für das Jahresformat, z. B. "PRJ" */
  prefix: string;
  /** Stellen der laufenden Nummer */
  digits: number;
  /** Schrittweite beim sequenziellen Format, z. B. 100 -> 0100, 0200 */
  step: number;
  /** Eigenes Muster aus Bausteinen, z. B. "PRJ-{JJ}{NNN}" (nur bei format = 'pattern') */
  pattern?: string;
  /** erste vergebene laufende Nummer */
  start?: number;
  /** jedes Jahr wieder bei der Startnummer beginnen */
  yearlyReset?: boolean;
  /** Teilprojekte: Buchstaben (0100-A) oder Ziffern (0100-01) */
  subStyle?: 'letters' | 'digits';
}

export const DEFAULT_PROJECT_NUMBER_SETTINGS: ProjectNumberSettings = {
  format: 'sequential',
  prefix: 'PRJ',
  digits: 4,
  step: 100,
  pattern: 'PRJ-{JJ}{NNN}',
  start: 1,
  yearlyReset: false,
  subStyle: 'letters',
};

/** Bausteine für eigene Nummernmuster */
export const NUMBER_TOKENS: { token: string; label: string; example: string }[] = [
  { token: '{NNNN}', label: 'laufende Nummer (so viele Stellen wie N)', example: '0042' },
  { token: '{JJJJ}', label: 'Jahr vierstellig', example: '2026' },
  { token: '{JJ}', label: 'Jahr zweistellig', example: '26' },
  { token: '{MM}', label: 'Monat', example: '10' },
  { token: '{TEAM}', label: 'Kürzel der Abteilung', example: 'KON' },
  { token: '{KUNDE}', label: 'Kundennummer aus dem CRM', example: 'K0042' },
];

export interface NumberContext { year?: number; month?: number; team?: string; customer?: string }

/** Prüft ein Muster: genau ein Baustein für die laufende Nummer, nur bekannte Bausteine */
export function validateNumberPattern(pattern: string): string | null {
  const tokens = pattern.match(/\{[^}]*\}/g) ?? [];
  const seq = tokens.filter((t) => /^\{N+\}$/.test(t));
  if (seq.length !== 1) return 'Das Muster braucht genau einen Baustein für die laufende Nummer, z. B. {NNNN}';
  const bad = tokens.find((t) => !/^\{(N+|JJJJ|JJ|MM|TEAM|KUNDE)\}$/.test(t));
  if (bad) return `Unbekannter Baustein ${bad}`;
  if (/[/\\:*?"<>|]/.test(pattern.replace(/\{[^}]*\}/g, ''))) return 'Das Muster enthält Zeichen, die in Ordnernamen nicht erlaubt sind';
  return null;
}

/** Setzt ein Muster wie "PRJ-{JJ}{NNN}" zusammen */
export function formatNumberPattern(pattern: string, seq: number, c: NumberContext = {}): string {
  const now = new Date();
  const year = c.year ?? now.getFullYear();
  const month = c.month ?? now.getMonth() + 1;
  return pattern.replace(/\{(N+|JJJJ|JJ|MM|TEAM|KUNDE)\}/g, (_, t: string) => {
    if (t.startsWith('N')) return String(seq).padStart(t.length, '0');
    if (t === 'JJJJ') return String(year);
    if (t === 'JJ') return String(year % 100).padStart(2, '0');
    if (t === 'MM') return String(month).padStart(2, '0');
    if (t === 'TEAM') return sanitizeName(c.team ?? '').toUpperCase() || 'XX';
    return sanitizeName(c.customer ?? '') || 'K0000';
  });
}

export const pad = (n: number, digits: number): string => {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Ungültige Zahl: ${n}`);
  const s = String(n);
  if (s.length > digits) throw new Error(`Zahl ${n} passt nicht in ${digits} Stellen`);
  return s.padStart(digits, '0');
};

/** Formatiert die laufende Nummer eines Projekts gemäß Einstellung. */
export function formatProjectNumber(seq: number, settings: ProjectNumberSettings, year = new Date().getFullYear(), ctx: NumberContext = {}): string {
  if (settings.format === 'pattern') return formatNumberPattern(settings.pattern || 'PRJ-{JJ}{NNN}', seq, { ...ctx, year });
  if (settings.format === 'year') return `${settings.prefix}-${year}-${pad(seq, settings.digits)}`;
  return pad(seq, settings.digits);
}

/** Nächste laufende Nummer aus den bereits vergebenen Nummern. */
export function nextProjectSequence(existing: number[], settings: ProjectNumberSettings): number {
  const max = existing.length ? Math.max(...existing) : 0;
  if (settings.format === 'pattern') {
    const start = Math.max(0, settings.start ?? 1);
    return max >= start ? max + Math.max(1, settings.step || 1) : start;
  }
  if (settings.format === 'year') return max + 1;
  return (Math.floor(max / settings.step) + 1) * settings.step;
}

/** Teilprojekt-Kennung: A, B, ... Z, AA, AB ... */
export function subprojectLetter(index: number): string {
  let s = '';
  let i = index;
  do {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return s;
}

export const formatSubprojectNumber = (parent: string, index: number, style: 'letters' | 'digits' = 'letters') =>
  `${parent}-${style === 'digits' ? String(index + 1).padStart(2, '0') : subprojectLetter(index)}`;

export const formatDocumentNumber = (projectNumber: string, seq: number) => `${projectNumber}-DOK-${pad(seq, 3)}`;

/** Wandelt Umlaute und Sonderzeichen in dateisystemtaugliche Zeichen um. */
export function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Ordnername eines Projekts: 0100_Verpackungsanlage */
export const projectFolderName = (number: string, name: string) => `${number}_${sanitizeName(name)}`;

/** Standard-Ordnerstruktur für neue Projekte (Kapitel 9). */
export const DEFAULT_PROJECT_FOLDERS = ['01_CAD', '02_Zeichnungen', '03_Doku', '04_Fertigung'];

// ---------------------------------------------------------------- CAD

export interface CadNumber {
  /** Hauptbaugruppe (4 Stellen, aus der Projektnummer) */
  main: string;
  /** Unterbaugruppe (3 Stellen) */
  sub: string;
  /** Unter-Unterbaugruppe (2 Stellen) */
  subsub: string;
  /** Teilenummer (4 Stellen) */
  part: string;
  /** Versionsstand (2 Stellen) */
  revision: string;
  /** sprechende Benennung (optional) */
  designation?: string;
}

const CAD_RE = /^(\d{4})-(\d{3})-(\d{2})-(\d{4})-(\d{2})(?:_(.+))?$/;

export function parseCadNumber(value: string): CadNumber | null {
  const base = value.replace(/\.(sldprt|sldasm|slddrw)$/i, '');
  const m = CAD_RE.exec(base);
  if (!m) return null;
  const [, main, sub, subsub, part, revision, designation] = m;
  return { main: main!, sub: sub!, subsub: subsub!, part: part!, revision: revision!, designation };
}

/** Nummer ohne Versionsstand und Benennung – identifiziert ein Bauteil über alle Revisionen. */
export const cadBaseNumber = (n: CadNumber) => `${n.main}-${n.sub}-${n.subsub}-${n.part}`;

export function formatCadNumber(n: CadNumber, withDesignation = true): string {
  const core = `${cadBaseNumber(n)}-${n.revision}`;
  return withDesignation && n.designation ? `${core}_${sanitizeName(n.designation)}` : core;
}

/** Leitet die 4-stellige Hauptbaugruppe aus einer Projektnummer ab (0100 oder PRJ-2026-0042 -> 0042). */
export function cadMainFromProject(projectNumber: string): string {
  const m = /(\d{1,4})(?:-[A-Z]+)?$/.exec(projectNumber);
  if (!m) throw new Error(`Projektnummer ${projectNumber} enthält keine Ziffernfolge`);
  return m[1]!.padStart(4, '0');
}

export function buildCadNumber(opts: {
  projectNumber: string;
  sub: number;
  subsub: number;
  part: number;
  revision?: number;
  designation?: string;
}): CadNumber {
  return {
    main: cadMainFromProject(opts.projectNumber),
    sub: pad(opts.sub, 3),
    subsub: pad(opts.subsub, 2),
    part: pad(opts.part, 4),
    revision: pad(opts.revision ?? 0, 2),
    designation: opts.designation,
  };
}

/** Zählt den Versionsstand hoch: 00 -> 01. */
export function bumpRevision(n: CadNumber): CadNumber {
  const next = Number(n.revision) + 1;
  if (next > 99) throw new Error('Maximaler Versionsstand 99 erreicht');
  return { ...n, revision: pad(next, 2) };
}

/** Nächste freie Teilenummer innerhalb einer (Unter-)Baugruppe. */
export function nextPartNumber(existingParts: number[]): number {
  return existingParts.length ? Math.max(...existingParts) + 1 : 1;
}

export type CadFileType = 'part' | 'assembly' | 'drawing';

export const CAD_EXTENSIONS: Record<CadFileType, string> = {
  part: '.sldprt',
  assembly: '.sldasm',
  drawing: '.slddrw',
};

export function cadFileTypeFromName(fileName: string): CadFileType | null {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  const entry = Object.entries(CAD_EXTENSIONS).find(([, e]) => e === ext);
  return entry ? (entry[0] as CadFileType) : null;
}

export const cadFileName = (n: CadNumber, type: CadFileType) => formatCadNumber(n) + CAD_EXTENSIONS[type];
