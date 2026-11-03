# Überprüfungs- und Testplan (Kapitel 14)

Der Testplan ist zweigeteilt:

* **Automatische Server-Tests** (`pnpm test`, 164 Prüfungen: 131 Server in 34 Dateien, 33 Fachlogik) laufen gegen eine echte PostgreSQL-Datenbank.
* **Browser-Test des Testplans** (`node e2e/testplan.mjs`, 50 Prüfungen) bedient die Oberfläche wie ein Mensch – inklusive echtem Videoanruf zwischen zwei Browsern.

Beide laufen bei jedem Hochladen nach GitHub automatisch (GitHub Actions, `.github/workflows/ci.yml`), der Browser-Test lokal gegen eine frische Instanz.

## Ergebnis vom 03.11.2026 (Version 0.2.0)

Alle 50 Schritte des Browser-Tests und alle 164 Server- und Fachlogik-Tests bestanden.

| # | Prüfung | Ergebnis |
|---|---|---|
| 1.1 | Gesundheitsprüfung des Servers | bestanden |
| 1.2 | Erstzugang admin/admin mit Passwort-Zwang | bestanden |
| 1.3 | Startassistent: Firmenname setzen und beenden | bestanden |
| 2.1 | Teams und Projekt über die Oberfläche anlegen | bestanden |
| 2.2 | Brotkrumen-Pfad zeigt das Projekt | bestanden |
| 2.3 | Dunkel-/Hellmodus umschalten | bestanden |
| 2.4 | Seitenleiste einklappen und öffnen | bestanden |
| 2.5 | Blitzsuche mit Strg + K | bestanden |
| 2.6 | Aufgabe anlegen, Detail-Fenster von rechts, Kanban-Verschieben | bestanden |
| 3.1 | Speichermaske ist im Administrator-Bereich editierbar | bestanden |
| 3.2 | Automatische 3D-Nummer 0100-100-00-0000-00_Rahmen und Zeichnung | bestanden |
| 3.3 | Auschecken/Einchecken und Freigabe mit PDF/DXF/STEP-Aufträgen | bestanden |
| 4.1 | Zeiterfassung: Einstempeln, Ausstempeln, Korrekturanfrage | bestanden |
| 4.2 | DSGVO-konformer Urlaubsantrag im Teamkalender | bestanden |
| 5.1 | Chat in Echtzeit | bestanden |
| 5.2 | Videoanruf mit zwei Teilnehmern (WebRTC) | bestanden |
| 6.1 | Verschlüsseltes Backup und Duplikaterkennung beim Import | bestanden |
| 6.2 | Update-Prüfung | bestanden |
| 7.1 | Ressource buchen, Doppelbuchung wird abgelehnt | bestanden |
| 7.2 | Oberfläche ohne Emojis | bestanden |
| 8.1 | Eigene Kanban-Spalte anlegen | bestanden |
| 8.2 | Termin mit Einladung im Kalender anlegen | bestanden |
| 8.3 | Abgeschlossenes Projekt ist nur lesbar | bestanden |
| 9.1 | Kunde beim Projekt anlegen und im CRM wiederfinden | bestanden |
| 10.1 | Einkauf: Position anlegen und bestellen | bestanden |
| 10.2 | Kalkulation: Angebotskalkulation rechnet beim Tippen | bestanden |
| 11.1 | Regelsatz Deutschland laden, Stempeluhr zeigt die Regeln | bestanden |
| 12.1 | Ordnerstruktur mit Unterordner anlegen | bestanden |
| 12.2 | Persönliches Postfach fordert zur Einrichtung auf | bestanden |
| 12.3 | KI-Anbieter hinzufügen | bestanden |
| 12.4 | Änderungsprotokoll als Excel herunterladen | bestanden |
| 13.1 | PCB-Bridge: Leiterplatte über die Speichermaske anlegen | bestanden |
| 13.2 | Wächter einrichten: Installationspaket herunterladen | bestanden |
| 13.3 | Speichermaske: Reiter CAD und PCB | bestanden |
| 14.1 | App-Store: Meetings installieren, erscheint in der Seitenleiste | bestanden |
| 14.2 | Meeting mit Gast-Link: Gast wartet, wird eingelassen, beide sehen sich | bestanden |
| 14.3 | Formular anlegen, öffentlich ausfüllen, Auswertung | bestanden |
| 14.4 | Schwarzes Brett: Mitteilung mit Lesebestätigung, Marktplatz-Angebot | bestanden |
| 14.5 | 3D-Viewer: Baugruppe öffnen, Teile im Baum, Messen | bestanden |
| 14.6 | Mindmap: mit Tastatur anlegen, speichern, als Gliederung exportieren | bestanden |
| 14.7 | Wissensdatenbank: Artikel aus Vorlage, „/“-Befehl, Unterseite, Suche, öffentlicher Link | bestanden |
| 14.8 | Lager: Lagerort, Artikel, Zugang, Entnahme fürs Projekt, Scan per Eingabe | bestanden |
| 14.9 | Inventar: Gerät mit Prüftermin, Übergabe, Etikett | bestanden |
| 14.10 | Rechnung: aus Angebot, festschreiben (ZUGFeRD), Zahlung erfassen | bestanden |
| 14.11 | Finanzen: Eingangsrechnung freigeben, Kontoauszug einlesen, Zahlung zuordnen | bestanden |
| 14.12 | Lohnabrechnung: Personalstamm, Monat abrechnen, Prämie, festschreiben, eigener Lohnzettel | bestanden |
| 14.13 | Instandhaltung, Qualität, Fertigung, Änderungen: Störung melden, Prüfung, Auftrag, Antrag | bestanden |
| 14.14 | Service, Kundenanfragen, Verträge, Terminbuchung, Messe: Einsatz unterschreiben, Formular, Buchung | bestanden |
| 14.15 | Spesen, Einsatzplanung, Personal, Unterweisungen, Fuhrpark: Abrechnung, Schicht, Bewerbung, Quiz, Fahrt | bestanden |
| 14.16 | Freigaben, E-Signatur, Auswertungen, Eigene Felder, Nachhaltigkeit: Antrag, Unterschrift, Bericht, Feld, CO₂ | bestanden |

Zusätzlich durch Server-Tests abgedeckt: Teilprojekt-/Dokument-/Jahresnummern, Sichtbarkeit und Rechte,
Abhängigkeiten mit Kreisbezugsschutz, Erwähnungen, Dateiversionen und Explorer-Abgleich, Pfadschutz,
Teilen-/Anforderungslinks mit Passwort, Scan-Assistent, Stückliste und Verwendungsnachweis, Kopplung
Teil ↔ Zeichnung, Versionsstand 00 → 01 mit Historie, Feiertage aller Bundesländer, Resturlaubsprüfung,
KVP-Entscheidungen, KI-Anbindung (OpenAI-kompatibel), SMTP-Versand, WOPI-Zugriffstoken, revisionssicheres
Änderungsprotokoll, Ressourcen (nur Administratoren legen an, Überschneidung und gleichzeitige Buchung,
Genehmigung, Wochenserien, Sperre, Team-Beschränkung), Emoji-Prüfung des gesamten Quelltexts.

Seit 0.2.0 außerdem: App-Store (Installieren mit Voraussetzungen, Entfernen ohne Datenverlust), Lohnsteuer
gegen 207 Prüffälle des Bundesfinanzministeriums (Programmablaufplan 2026), Sozialversicherung mit Midi- und
Minijob, E-Rechnung (ZUGFeRD/XRechnung) mit Prüfung des XML-Inhalts, Kontoauszug-Abgleich, DATEV-Export,
Verpflegungspauschalen, Fahrtenbuch-Regeln (lückenlos, keine Überschneidung), Unterweisungs-Fristen,
Löschfristen für Bewerbungen, mehrstufige Freigaben mit Wertgrenzen, E-Signatur nacheinander mit
Signaturprotokoll, Rechte in den Auswertungen (eigene Zeiten), Prüfung eigener Felder, CO₂-Bilanz mit
wiederholbarer Übernahme aus dem Fuhrpark und Vollständigkeit der Sicherung (jede Tabelle mit Primärschlüssel).

Das Installations- und Deinstallationsskript wurde mit `shellcheck` geprüft und in allen drei
HTTPS-Varianten (eigenes Zertifikat, Let's Encrypt über DNS, Let's Encrypt öffentlich) mit
Platzhaltern für Docker durchgespielt; die erzeugten Webserver-Konfigurationen wurden kontrolliert.

Der CAD-Wächter wurde mit dem Kommandozeilenwerkzeug `aperio-cad` (gleicher API-Client wie das Add-in)
gegen den laufenden Server geprüft: Nummernvergabe, Einchecken, Statuswechsel mit Kopplungsprüfung,
Verwendungsnachweis, neuer Versionsstand.

## Noch auf Firmen-Hardware zu prüfen

Diese Punkte benötigen Software bzw. Infrastruktur, die in der Entwicklungsumgebung nicht verfügbar war:

| Punkt | Vorgehen |
|---|---|
| SolidWorks-Add-in im echten SolidWorks | `cad-bridge` unter Windows bauen, `register.cmd`, Speichern eines neuen Teils, Zeichnung anlegen, Einchecken |
| Export-Dienst PDF/DXF/STEP | `AperioPlan.ExportWorker.exe --once` nach einer Freigabe |
| Installation und HTTPS | `sudo ./install.sh` auf dem Zielserver mit allen drei Wegen; Zertifikat im Browser prüfen, `aperioplan.local` von Windows/macOS aufrufen |
| Let's Encrypt über DNS | Weg 2 mit echtem DuckDNS-/Cloudflare-Token; `docker compose logs caddy` zeigt „certificate obtained successfully“ |
| Deinstallation | `sudo ./uninstall.sh` auf einem Testsystem; danach `docker ps -a` und `docker volume ls` leer |
| Active Directory | Einstellungen → Firmen-Login → „Verbindung testen“, Anmeldung mit Windows-Konto |
| E-Mail-Abruf (IMAP) | Einstellungen → E-Mail-Konto → „Verbindung testen“, „Abrufen“ |
| Collabora Online | `docker compose --profile office up -d`, Word-Datei im Browser öffnen |
| Telefonie | Anbindung an die echte Telefonanlage (SIP), ein- und ausgehender Anruf |
| Lohnabrechnung | einen Monat parallel zur bisherigen Abrechnung rechnen und vergleichen; DATEV-Datei beim Steuerberater einlesen lassen |
| E-Rechnung beim Empfänger | eine XRechnung über das Portal des Empfängers bzw. den KoSIT-Validator prüfen |
| E-Mail-Versand der neuen Apps | Einladung zur E-Signatur, Ticket-Antwort und Servicebericht mit echtem Postfach empfangen |
