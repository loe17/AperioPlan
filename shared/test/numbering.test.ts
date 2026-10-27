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
