import { describe, expect, it } from 'vitest';
import {
  buildCadNumber, bumpRevision, cadMainFromProject, formatCadNumber, formatDocumentNumber,
  formatProjectNumber, formatSubprojectNumber, nextProjectSequence, parseCadNumber, projectFolderName,
  sanitizeName, subprojectLetter, DEFAULT_PROJECT_NUMBER_SETTINGS, cadFileName, cadFileTypeFromName,
} from '../src';

describe('Projektnummern', () => {
  it('sequenziell in Hunderterschritten', () => {
    expect(nextProjectSequence([], DEFAULT_PROJECT_NUMBER_SETTINGS)).toBe(100);
    expect(nextProjectSequence([100, 200], DEFAULT_PROJECT_NUMBER_SETTINGS)).toBe(300);
    expect(nextProjectSequence([150], DEFAULT_PROJECT_NUMBER_SETTINGS)).toBe(200);
    expect(formatProjectNumber(100, DEFAULT_PROJECT_NUMBER_SETTINGS)).toBe('0100');
  });
  it('mit Jahreszahl', () => {
    const s = { ...DEFAULT_PROJECT_NUMBER_SETTINGS, format: 'year' as const };
    expect(formatProjectNumber(42, s, 2026)).toBe('PRJ-2026-0042');
    expect(nextProjectSequence([41, 42], s)).toBe(43);
  });
  it('Teilprojekte und Dokumente', () => {
    expect(subprojectLetter(0)).toBe('A');
    expect(subprojectLetter(25)).toBe('Z');
    expect(subprojectLetter(26)).toBe('AA');
    expect(formatSubprojectNumber('0100', 1)).toBe('0100-B');
    expect(formatDocumentNumber('0100', 1)).toBe('0100-DOK-001');
  });
  it('Ordnernamen ohne Umlaute', () => {
    expect(sanitizeName('Zuführung Ölwanne')).toBe('Zufuehrung_Oelwanne');
    expect(projectFolderName('0100', 'Verpackungsanlage')).toBe('0100_Verpackungsanlage');
  });
});

describe('CAD-Nummern', () => {
  it('bauen, formatieren und parsen', () => {
    const n = buildCadNumber({ projectNumber: '0100', sub: 100, subsub: 0, part: 0, designation: 'Rahmen' });
    expect(formatCadNumber(n)).toBe('0100-100-00-0000-00_Rahmen');
    expect(parseCadNumber('0100-100-00-0000-00_Rahmen.SLDPRT')).toEqual(n);
    expect(parseCadNumber('Rahmen.sldprt')).toBeNull();
  });
  it('Projektnummer mit Jahr', () => {
    expect(cadMainFromProject('PRJ-2026-0042')).toBe('0042');
    expect(cadMainFromProject('0100-A')).toBe('0100');
  });
  it('Versionsstand hochzählen', () => {
    const n = parseCadNumber('0100-200-01-0007-00_Motorhalter')!;
    expect(formatCadNumber(bumpRevision(n))).toBe('0100-200-01-0007-01_Motorhalter');
  });
  it('Dateinamen', () => {
    const n = parseCadNumber('0100-100-00-0001-00_Platte')!;
    expect(cadFileName(n, 'drawing')).toBe('0100-100-00-0001-00_Platte.slddrw');
    expect(cadFileTypeFromName('x.SLDASM')).toBe('assembly');
  });
});

import { countWorkingDays, easterSunday, germanHolidays } from '../src';
describe('Feiertage und Urlaubstage', () => {
  it('Ostern und Feiertage BW 2026', () => {
    expect(easterSunday(2026).toISOString().slice(0, 10)).toBe('2026-04-05');
    const bw = germanHolidays(2026, 'BW').map((h) => h.day);
    expect(bw).toContain('2026-06-04'); // Fronleichnam
    expect(bw).toContain('2026-01-06');
    expect(bw).not.toContain('2026-10-31');
    expect(germanHolidays(2026, 'SN').find((h) => h.name === 'Buß- und Bettag')?.day).toBe('2026-11-18');
  });
  it('zählt Arbeitstage ohne Wochenende/Feiertage', () => {
    const h = new Set(germanHolidays(2026, 'BW').map((x) => x.day));
    expect(countWorkingDays('2026-03-30', '2026-04-10', h)).toBe(8); // Karfreitag + Ostermontag frei
    expect(countWorkingDays('2026-11-02', '2026-11-02', h, true)).toBe(0.5);
    expect(countWorkingDays('2026-11-02', '2026-11-06', h, true, true)).toBe(4);
  });
});

import { formatNumberPattern, validateNumberPattern, nextProjectSequence as nextSeq, formatSubprojectNumber as subNo } from '../src';
describe('Projektnummern aus Bausteinen', () => {
  it('setzt das Muster zusammen', () => {
    expect(formatNumberPattern('PRJ-{JJ}{NNN}', 42, { year: 2026 })).toBe('PRJ-26042');
    expect(formatNumberPattern('{TEAM}-{JJJJ}-{MM}-{NNNN}', 7, { year: 2026, month: 3, team: 'Kon' })).toBe('KON-2026-03-0007');
    expect(formatNumberPattern('{KUNDE}/{NN}', 3, { customer: 'K0042' })).toBe('K0042/03');
  });
  it('prüft das Muster', () => {
    expect(validateNumberPattern('PRJ-{JJ}')).toMatch(/genau einen/);
    expect(validateNumberPattern('{NNN}{XY}')).toMatch(/Unbekannter/);
    expect(validateNumberPattern('A/{NNN}')).toMatch(/Ordnernamen/);
    expect(validateNumberPattern('P-{NNN}')).toBeNull();
  });
  it('Startwert und Schrittweite', () => {
    const s = { format: 'pattern' as const, prefix: '', digits: 4, step: 1, start: 500 };
    expect(nextSeq([], s)).toBe(500);
    expect(nextSeq([500, 501], s)).toBe(502);
    expect(subNo('0100', 0, 'digits')).toBe('0100-01');
  });
});
