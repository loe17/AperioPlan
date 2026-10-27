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
    version: '1.1.1',
    date: '2026-10-27',
    title: 'Installation und Deinstallation zuverlässiger',
    changes: [
      { type: 'behoben', text: 'Installation über "curl … | bash" brach beim Warten auf AperioPlan ohne Meldung ab' },
      { type: 'verbessert', text: 'Installationsskript prüft am Ende, ob die https-Adresse wirklich antwortet, und zeigt sonst die Meldungen des Webservers' },
      { type: 'verbessert', text: 'Deinstallation läuft vollautomatisch: findet die Installation selbst und legt vorher eine Abschlusssicherung an' },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-10-27',
    title: 'Ressourcen, neues Erscheinungsbild und sichere Installation',
    changes: [
      { type: 'neu', text: 'Räume, Fahrzeuge und Geräte im Kalender buchen – ohne Doppelbuchungen, mit Genehmigung und Serienterminen' },
      { type: 'neu', text: 'Ressourcen werden vom Administrator angelegt, gesperrt oder auf Teams beschränkt' },
      { type: 'neu', text: 'Eigener Symbolsatz statt Emojis; Projekte und Teams erhalten Symbol und Farbe' },
      { type: 'neu', text: 'Neues Logo' },
      { type: 'neu', text: 'Installationsskript richtet immer HTTPS ein – Let\'s Encrypt auch im lokalen Netz über den DNS-Anbieter' },
      { type: 'neu', text: 'Deinstallations-Skript mit optionaler Abschlusssicherung' },
      { type: 'behoben', text: 'Anmeldung über http://Server-IP schien nichts zu tun' },
      { type: 'behoben', text: 'Nach einer Ein-Klick-Aktualisierung konnten Projektdateien leer erscheinen' },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-27',
    title: 'Erste vollständige Version',
    changes: [
      { type: 'neu', text: 'Handbücher für Administratoren, Anwender und Entwickler' },
      { type: 'neu', text: 'Automatischer Browser-Test des kompletten Testplans inkl. Videoanruf' },
      { type: 'neu', text: 'Plugins können eigene Seiten in der Seitenleiste ergänzen' },
      { type: 'neu', text: 'Resturlaub und Sonderurlaub in der Benutzerverwaltung buchen' },
      { type: 'neu', text: 'Wartungsbefehl zum Zurücksetzen des Administrator-Zugangs' },
      { type: 'verbessert', text: 'Darstellung auf Smartphones und Tablets' },
      { type: 'behoben', text: 'E-Mail-Versand über interne Relays ohne Anmeldung' },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-10-27',
    title: 'Kommunikation, KVP, KI, Sicherung & Erweiterungen',
    changes: [
      { type: 'neu', text: 'Projekt-Chat, Team-Chat und Direktnachrichten in Echtzeit mit Anhängen und @Erwähnungen' },
      { type: 'neu', text: 'Videoanrufe mit Bildschirmfreigabe direkt im Browser' },
      { type: 'neu', text: 'Integrierte E-Mail-Verwaltung: Projektpostfach, automatische Zuordnung über die Projektnummer' },
      { type: 'neu', text: 'Büro-Dokumente im Browser bearbeiten (Collabora Online)' },
      { type: 'neu', text: 'KVP-Ideenbox mit Einsparpotenzial, Zuständigkeit, Fotos und Entscheidung' },
      { type: 'neu', text: 'KI-Assistent für Projektzusammenfassung, Schreibhilfe und Dokumentenanalyse (lokal oder extern)' },
      { type: 'neu', text: 'Sicherungen herunterladen und einspielen – mit Duplikaterkennung und Datumsvergleich' },
      { type: 'neu', text: 'Ein-Klick-Aktualisierung über GitHub, Plugins und Webhooks für Entwickler' },
      { type: 'behoben', text: 'Teiländerungen setzen nicht mehr ungewollt andere Felder zurück' },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-10-27',
    title: 'Zeiterfassung & Urlaub',
    changes: [
      { type: 'neu', text: 'Projekt-Stempeluhr mit Projektwechsel per Klick, Wochenübersicht und CSV-Export' },
      { type: 'neu', text: 'Korrekturanfragen für Fehlbuchungen (Was? Welche Zeit? Warum?) mit Genehmigung durch die Teamleitung' },
      { type: 'neu', text: 'Urlaubskonto mit Anspruch, genommenen und offenen Tagen sowie Genehmigungsworkflow' },
      { type: 'neu', text: 'Automatische Feiertage je Bundesland, halbe Tage, Wochenenden werden nicht gezählt' },
      { type: 'neu', text: 'DSGVO-sauberer Teamkalender: Kollegen sehen nur „Abwesend“, keine Gründe' },
      { type: 'neu', text: 'Mein Kalender mit Fristen, eigenen Abwesenheiten und Feiertagen' },
      { type: 'behoben', text: 'Web-Oberfläche wird nach Aktualisierungen ohne Neustart korrekt ausgeliefert' },
    ],
  },
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
