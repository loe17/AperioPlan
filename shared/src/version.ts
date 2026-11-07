/**
 * Versionsnummer und Änderungsprotokoll ("Was ist neu?", Kapitel 4).
 * Bei jeder neuen Version oben einen Eintrag ergänzen und APP_VERSION anheben.
 * Zählung: 0.x = Entwicklungsstand vor der ersten offiziellen Fassung (1.0.0).
 */
export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  changes: { type: 'neu' | 'verbessert' | 'behoben'; text: string }[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.4.0',
    date: '2026-11-07',
    title: 'E-Mail-Assistent, mehrere Postfächer, Signaturen wie in Outlook, Adressbuch mit Abteilungen',
    changes: [
      { type: 'neu', text: 'Einrichtungsassistent für E-Mail-Konten: erkennt den Anbieter selbst (netcup, IONOS, Strato, Hetzner, All-Inkl, GMX, WEB.DE, Telekom, Gmail, Microsoft 365 u. v. m.) oder hilft beim eigenen Server, sagt, was beim Anbieter zu tun ist, und prüft alles bis zu einer Test-E-Mail, die hin- und zurückgeht' },
      { type: 'neu', text: 'Anmeldung mit Microsoft bzw. Google (einmalig vom Administrator unter Einstellungen → E-Mail-Anmeldung eingerichtet)' },
      { type: 'neu', text: 'Mehrere Postfächer je Person (z. B. zusätzlich info@), Umschalten links oben, Absender beim Schreiben wählbar' },
      { type: 'neu', text: 'Mehrere HTML-Signaturen: gestalten oder fertiges HTML einfügen, Logo wird eingebettet, Platzhalter für Name, Position, Abteilung, Telefon und Mobil; je Postfach getrennt für neue E-Mails und Antworten, beim Schreiben einfügen oder wechseln' },
      { type: 'neu', text: 'Firmen-Signatur für alle (Voreinstellung oder Pflicht); Berufsbezeichnung im Benutzerkonto, Mobilnummer im Profil' },
      { type: 'neu', text: 'Adressbuch beim Schreiben: Kontakte und Firmen aus dem CRM, alle Mitarbeiter, zuletzt verwendete Adressen und Gruppen je Abteilung (z. B. Gruppe Konstruktion); Vorschläge schon beim Tippen' },
      { type: 'neu', text: 'Postausgang: Ist der Mail-Server gerade nicht erreichbar, wird die E-Mail automatisch nachgeschickt; Verlauf je Postfach in Klartext' },
      { type: 'neu', text: 'Reiter in Projekten für sich ausblenden; mit Berechtigung für alle entfernen (Inhalte bleiben erhalten) und per Ziehen sortieren' },
      { type: 'neu', text: 'Werkzeug-Favoriten in einem eigenen Bereich der Seitenleiste (Stern beim Werkzeug, Reihenfolge per Ziehen)' },
      { type: 'verbessert', text: 'Stempeluhr steht mittig in der Kopfzeile zwischen Pfad und Suchfeld' },
      { type: 'verbessert', text: 'Benachrichtigungen nur noch über die Glocke – der Eintrag „Posteingang“ im Schreibtisch entfällt' },
      { type: 'behoben', text: 'Senden klappte manchmal erst beim zweiten Versuch: nur noch eine Verbindung je Postfach, Wiederholung bei kurzen Störungen, Knopf „Wird gesendet …“, nie doppelt verschickt' },
      { type: 'behoben', text: 'Ständige Meldung „Gespeichert“ beim Schreiben und Abrufen von E-Mails' },
      { type: 'behoben', text: 'Geänderter Anzeigename wurde nicht übernommen bzw. „Administrator“ als Absender; jetzt Pflichtfeld mit Vorschau „So sehen Empfänger Sie“' },
      { type: 'behoben', text: 'Keine Kopie in „Gesendet“, wenn der Server die Ordner nicht kennzeichnet – Ordner werden jetzt nach dem Namen erkannt oder von Hand zugeordnet' },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-11-07',
    title: 'Apps in Projekten, Lager und Einkauf verbunden, 3D-Ansicht und Mindmaps wie FreeMind',
    changes: [
      { type: 'neu', text: 'Apps als Reiter im Projekt: Verkauf (Angebote, Rechnungen, Reklamationen), Material, Service, Qualität, Fertigung, Änderungen, Reisekosten, Freigaben, Unterschriften, CO₂, Eingangsrechnungen, Ressourcen und Meetings – jeweils nur mit den Einträgen dieses Projekts, mit Anlegen und Status' },
      { type: 'neu', text: 'Mit „+“ am Ende der Reiterleiste blendet die Projektleitung weitere Reiter ein; die Standard-Reiter für neue Projekte legt der Administrator fest' },
      { type: 'neu', text: 'Gesamtübersichten (Einkauf, Angebote, Rechnungen, Service, Qualität, Fertigung, Änderungen, Freigaben, Spesen, E-Signatur, Eingangsrechnungen) lassen sich nach Projekt gruppieren' },
      { type: 'neu', text: 'Einkauf: Lagerbestellungen ohne Projekt, Positionen mit Lagerartikel und Lagerort; Wareneingang mit Lieferschein, Charge und Seriennummern – wahlweise ins Lager oder gleich ins Projekt' },
      { type: 'neu', text: 'Verlauf je Bestellposition: Änderungen, Bestellung, Lieferungen und Lagerbewegungen auf einen Blick' },
      { type: 'neu', text: 'Lager: Nachbestellen direkt am Artikel, Bestellvorschlag als Lagerbestellung, Reiter „Material“ im Projekt mit Entnahme und Rückgabe' },
      { type: 'neu', text: 'E-Rechnungen mit einer Bestellnummer aus dem Einkauf werden automatisch dem Projekt zugeordnet' },
      { type: 'neu', text: '3D-Dateien öffnen sich im selben Fenster wie Word-Dateien – mit Schnitt und Messen; zusätzlich FBX, Collada, VRML, AMF, 3DS, VTK und USDZ' },
      { type: 'neu', text: 'Native CAD-Dateien (SolidWorks, Inventor, Solid Edge, CATIA, Parasolid, JT u. a.): sofort mit dem gespeicherten Vorschaubild, als 3D-Modell nach Umwandlung durch einen CAD-Arbeitsplatz (neuer Umwandlungsdienst der CAD-Bridge)' },
      { type: 'neu', text: 'Mindmaps wie FreeMind: Schrift, Farben, Formen, Linienarten, Symbole, Prioritäten, Wolken, Pfeile, Verknüpfungen, Attribute, Erinnerungen, Zeitstempel, Suche und Filter, Tabellenansicht, Klappen nach Ebenen, Kopieren und Einfügen' },
      { type: 'neu', text: 'Mindmaps exportieren als PNG, SVG, PDF, HTML, Markdown, Text und FreeMind (.mm); FreeMind- und Freeplane-Dateien einlesen' },
      { type: 'verbessert', text: 'Seitenleiste: E-Mail und Chat unter „Mein Schreibtisch“, App-Store und Einstellungen eigener Bereich, Abschnitte einklappbar' },
      { type: 'verbessert', text: 'Der 3D-Viewer ist keine eigene App mehr – die 3D-Ansicht steht allen zur Verfügung' },
    ],
  },
  {
    version: '0.2.1',
    date: '2026-11-04',
    title: 'Ältere Versionen installieren',
    changes: [
      { type: 'neu', text: 'Einstellungen → Aktualisierung: jede Version ab 0.2.0 installieren – auch eine ältere. Vorher wird gesichert, Daten bleiben vollständig erhalten' },
      { type: 'verbessert', text: 'Die frühen Testfassungen 1.0 und 1.1 werden nicht mehr als Aktualisierung angeboten' },
      { type: 'verbessert', text: 'Das Installationsskript holt auch nach einem Wechsel auf eine ältere Version wieder den neuesten Stand' },
      { type: 'behoben', text: 'Office im Browser: Word-, Excel- und PowerPoint-Dateien öffnen wieder (Fehler 404 „file not found“)' },
      { type: 'verbessert', text: 'Office-Dokumente öffnen im selben Fenster; „Zurück“ bzw. „Schließen“ im Editor führt in den Ordner zurück' },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-11-03',
    title: 'App-Store mit über 40 Apps – von Meetings bis Lohnabrechnung',
    changes: [
      { type: 'neu', text: 'App-Store: jedes Werkzeug ist eine App, die der Administrator installiert oder entfernt. Neue Installationen starten nur mit Chat und E-Mail' },
      { type: 'neu', text: 'Eigene Startseite (Dashboard) mit Bausteinen je Benutzer' },
      { type: 'neu', text: 'Meetings mit Gast-Link und Warteraum, Telefonie über die Firmen-Telefonanlage (SIP)' },
      { type: 'neu', text: 'Formulare und Umfragen, Schwarzes Brett mit Marktplatz, Mindmaps, Wissensdatenbank, 3D-Viewer' },
      { type: 'neu', text: 'Lager mit Lagerorten, Chargen und Seriennummern; Inventar mit Prüfterminen, Übergaben und Abschreibung' },
      { type: 'neu', text: 'Rechnungen als E-Rechnung (ZUGFeRD, XRechnung) mit Abschlags- und Schlussrechnung' },
      { type: 'neu', text: 'Finanzen: Eingangsrechnungen mit Freigabe, Kontoauszug-Abgleich, Zahlungslauf, Mahnwesen, Umsatzsteuer-Übersicht, DATEV-Übergabe' },
      { type: 'neu', text: 'Lohnabrechnung mit Lohnsteuer nach amtlichem Programmablaufplan 2026, Sozialversicherung, Midi- und Minijob, Lohnzettel und SEPA-Datei' },
      { type: 'neu', text: 'Produktion und Service: Instandhaltung, Qualität (Prüfpläne, Messmittel, 8D), Fertigungsaufträge, Änderungsmanagement, Service-Einsätze mit Unterschrift' },
      { type: 'neu', text: 'Kunden: Kundenanfragen (Tickets), Wartungsverträge mit automatischer Rechnung, Terminbuchung per Link, Messen und Veranstaltungen' },
      { type: 'neu', text: 'Personal: Spesen und Reisekosten, Einsatzplanung, Personalakte mit Bewerbungen, Unterweisungen mit Nachweis, Fuhrpark mit Fahrtenbuch' },
      { type: 'neu', text: 'Freigaben für allgemeine Anträge, E-Signatur für PDF-Dokumente, Auswertungen mit Diagrammen, eigene Felder, CO₂-Bilanz' },
      { type: 'verbessert', text: 'Nummernkreise für alle neuen Belege in den Einstellungen anpassbar' },
      { type: 'verbessert', text: 'Tägliche Hintergrundaufgaben (Erinnerungen, fällige Prüfungen, Vertragsrechnungen) laufen gesammelt am Morgen' },
    ],
  },
  {
    version: '0.1.3',
    date: '2026-10-27',
    title: 'Installation und Deinstallation zuverlässiger',
    changes: [
      { type: 'behoben', text: 'Installation über "curl … | bash" brach beim Warten auf AperioPlan ohne Meldung ab' },
      { type: 'verbessert', text: 'Installationsskript prüft am Ende, ob die https-Adresse wirklich antwortet, und zeigt sonst die Meldungen des Webservers' },
      { type: 'verbessert', text: 'Installation fragt nicht mehr nach dem Programmordner (Standard /opt/aperioplan)' },
      { type: 'verbessert', text: 'Deinstallation läuft vollautomatisch: findet die Installation selbst und legt vorher eine Abschlusssicherung an' },
    ],
  },
  {
    version: '0.1.2',
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
    version: '0.1.1',
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
    version: '0.1.0',
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
    version: '0.0.4',
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
    version: '0.0.3',
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
    version: '0.0.2',
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
    version: '0.0.1',
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
