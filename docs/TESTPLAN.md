# Überprüfungs- und Testplan (Kapitel 14)

Der Testplan ist zweigeteilt:

* **Automatische Server-Tests** (`pnpm test`, 34 Prüfungen) laufen gegen eine echte PostgreSQL-Datenbank.
* **Browser-Test des Testplans** (`node e2e/testplan.mjs`, 17 Prüfungen) bedient die Oberfläche wie ein Mensch – inklusive echtem Videoanruf zwischen zwei Browsern.

Beide laufen bei jedem Hochladen nach GitHub automatisch (GitHub Actions, `.github/workflows/ci.yml`), der Browser-Test lokal gegen eine frische Instanz.

## Ergebnis vom 27.10.2026 (Version 1.0.0)

| # | Prüfung | Ergebnis |
|---|---|---|
| 1.1 | Server startet, Gesundheitsprüfung `GET /api/health` | ✅ |
| 1.2 | Erstzugang `admin`/`admin`, Passwortzwang vor jedem weiteren Zugriff | ✅ |
| 2.1 | Teams und Projekt über die Oberfläche anlegen (Nummer 0100, Ordnerstruktur) | ✅ |
| 2.2 | Brotkrumen-Pfad | ✅ |
| 2.3 | Dunkel-/Hellmodus | ✅ |
| 2.4 | Seitenleiste ein-/ausklappen | ✅ |
| 2.5 | Blitzsuche mit Strg + K | ✅ |
| 2.6 | Aufgabe anlegen, Detail-Fenster, Kanban per Drag & Drop | ✅ |
| 3.1 | Speichermaske im Administrator-Bereich editierbar | ✅ |
| 3.2 | Automatische 3D-Nummer `0100-100-00-0000-00_Rahmen` und Zeichnung `.slddrw` | ✅ |
| 3.3 | Auschecken/Einchecken, Freigabe, PDF/DXF/STEP-Aufträge | ✅ |
| 4.1 | Zeiterfassung und Stempelkorrektur | ✅ |
| 4.2 | DSGVO-konformer Urlaubsantrag im Teamkalender (nur „Abwesend“) | ✅ |
| 5.1 | Chat in Echtzeit | ✅ |
| 5.2 | Videoanruf mit zwei Teilnehmern (WebRTC) | ✅ |
| 6.1 | Verschlüsselte Sicherung, Duplikaterkennung beim Import | ✅ |
| 6.2 | Update-Prüfung | ✅ |

Zusätzlich durch Server-Tests abgedeckt: Teilprojekt-/Dokument-/Jahresnummern, Sichtbarkeit und Rechte,
Abhängigkeiten mit Kreisbezugsschutz, Erwähnungen, Dateiversionen und Explorer-Abgleich, Pfadschutz,
Teilen-/Anforderungslinks mit Passwort, Scan-Assistent, Stückliste und Verwendungsnachweis, Kopplung
Teil ↔ Zeichnung, Versionsstand 00 → 01 mit Historie, Feiertage aller Bundesländer, Resturlaubsprüfung,
KVP-Entscheidungen, KI-Anbindung (OpenAI-kompatibel), SMTP-Versand, WOPI-Zugriffstoken, revisionssicheres
Änderungsprotokoll.

Der CAD-Wächter wurde mit dem Kommandozeilenwerkzeug `aperio-cad` (gleicher API-Client wie das Add-in)
gegen den laufenden Server geprüft: Nummernvergabe, Einchecken, Statuswechsel mit Kopplungsprüfung,
Verwendungsnachweis, neuer Versionsstand.

## Noch auf Firmen-Hardware zu prüfen

Diese Punkte benötigen Software bzw. Infrastruktur, die in der Entwicklungsumgebung nicht verfügbar war:

| Punkt | Vorgehen |
|---|---|
| SolidWorks-Add-in im echten SolidWorks | `cad-bridge` unter Windows bauen, `register.cmd`, Speichern eines neuen Teils, Zeichnung anlegen, Einchecken |
| Export-Dienst PDF/DXF/STEP | `AperioPlan.ExportWorker.exe --once` nach einer Freigabe |
| Docker-Abbild und HTTPS | `./install.sh` auf dem Zielserver, Zertifikat im Browser prüfen |
| Active Directory | Einstellungen → Firmen-Login → „Verbindung testen“, Anmeldung mit Windows-Konto |
| E-Mail-Abruf (IMAP) | Einstellungen → E-Mail-Konto → „Verbindung testen“, „Abrufen“ |
| Collabora Online | `docker compose --profile office up -d`, Word-Datei im Browser öffnen |
