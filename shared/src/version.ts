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
    version: '0.3.0',
    date: '2026-10-27',
    title: 'CAD-Zentrale, PDM & Dateiverwaltung',
    changes: [
      { type: 'neu', text: 'CAD-Nummernvergabe 0100-100-00-0000-00_Benennung mit anpassbarer Speichermaske und Dropdown-Katalogen' },
      { type: 'neu', text: 'Auschecken/Einchecken mit Sperre, Versionsstände mit Begründung und Historie' },
      { type: 'neu', text: 'Verwendungsnachweis „Wo verbaut?“ und mehrstufige Stücklisten (auch als CSV/Excel)' },
      { type: 'neu', text: 'Freigabe-Workflow mit Kopplung Teil ↔ Zeichnung und automatischen PDF/DXF/STEP-Aufträgen' },
      { type: 'neu', text: 'CAD-Wächter für SolidWorks (C#), Export-Dienst und Kommandozeile aperio-cad' },
      { type: 'neu', text: 'Dateiverwaltung mit Versionen, Sperren, Vorschau und Abgleich mit dem Netzlaufwerk' },
      { type: 'neu', text: 'Scan-Assistent zum Einbinden und normgerechten Umbenennen von Bestandsordnern' },
      { type: 'neu', text: 'Gastlinks, „Daten teilen“ und „Daten anfordern“ mit Passwort, Ablaufdatum und Nutzungsgrenze' },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-27',
    title: 'Web-Oberfläche, Projekte & Aufgaben',
    changes: [
      { type: 'neu', text: 'Oberfläche im Notion-/Kaneo-Stil mit einklappbarer Seitenleiste, Brotkrumen-Pfad und Hell-/Dunkelmodus' },
      { type: 'neu', text: 'Globale Blitzsuche mit Strg + K' },
      { type: 'neu', text: 'Projekte mit automatischer Nummer, Teilprojekten, Dokumentnummern und Ordnerstruktur' },
      { type: 'neu', text: 'Kanban-Board, Aufgabenliste, Gantt-Diagramm mit Abhängigkeiten, Whiteboard und Abschlussbericht' },
      { type: 'neu', text: 'Detail-Fenster von rechts mit Kommentaren, @Erwähnungen und Verlauf' },
      { type: 'neu', text: 'Benachrichtigungen in Echtzeit, Favoriten, private Notizen, Deutsch/Englisch' },
      { type: 'neu', text: 'Verwaltung von Benutzern, Teams, Nummernkreisen und Firmen-Login (LDAP)' },
    ],
  },
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
