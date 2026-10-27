/**
 * Versionsnummer und Änderungsprotokoll ("Was ist neu?", Kapitel 4).
 * Bei jeder neuen Version oben einen Eintrag ergänzen und APP_VERSION anheben.
 */
export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  changes: { type: 'neu' | 'verbessert' | 'behoben'; text: string }[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.1.0',
    date: '2026-10-27',
    title: 'Grundgerüst',
    changes: [
      { type: 'neu', text: 'Projektstruktur mit Web-Oberfläche, Server, gemeinsamem Modul und CAD-Wächter' },
      { type: 'neu', text: 'Server-Bereitstellung mit einem Startbefehl inkl. HTTPS, Datenbank und Nacht-Sicherung' },
      { type: 'neu', text: 'Nummerierungssystem für Projekte, Dokumente und 3D-CAD-Daten' },
    ],
  },
];

export const APP_VERSION = CHANGELOG[0]!.version;
