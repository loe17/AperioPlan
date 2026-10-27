# Überprüfungs- und Testplan (Kapitel 14)

Der Testplan ist zweigeteilt:

* **Automatische Server-Tests** (`pnpm test`, 41 Prüfungen: 31 Server, 10 Fachlogik) laufen gegen eine echte PostgreSQL-Datenbank.
* **Browser-Test des Testplans** (`node e2e/testplan.mjs`, 19 Prüfungen) bedient die Oberfläche wie ein Mensch – inklusive echtem Videoanruf zwischen zwei Browsern.

Beide laufen bei jedem Hochladen nach GitHub automatisch (GitHub Actions, `.github/workflows/ci.yml`), der Browser-Test lokal gegen eine frische Instanz.

## Ergebnis vom 27.10.2026 (Version 1.1.0)

| # | Prüfung | Ergebnis |
|---|---|---|
| 1.1 | Server startet, Gesundheitsprüfung `GET /api/health` | bestanden |
| 1.2 | Erstzugang `admin`/`admin`, Passwortzwang vor jedem weiteren Zugriff | bestanden |
| 2.1 | Teams und Projekt über die Oberfläche anlegen (Nummer 0100, Ordnerstruktur) | bestanden |
| 2.2 | Brotkrumen-Pfad | bestanden |
| 2.3 | Dunkel-/Hellmodus | bestanden |
| 2.4 | Seitenleiste ein-/ausklappen | bestanden |
| 2.5 | Blitzsuche mit Strg + K | bestanden |
| 2.6 | Aufgabe anlegen, Detail-Fenster, Kanban per Drag & Drop | bestanden |
| 3.1 | Speichermaske im Administrator-Bereich editierbar | bestanden |
| 3.2 | Automatische 3D-Nummer `0100-100-00-0000-00_Rahmen` und Zeichnung `.slddrw` | bestanden |
| 3.3 | Auschecken/Einchecken, Freigabe, PDF/DXF/STEP-Aufträge | bestanden |
| 4.1 | Zeiterfassung und Stempelkorrektur | bestanden |
| 4.2 | DSGVO-konformer Urlaubsantrag im Teamkalender (nur „Abwesend“) | bestanden |
| 5.1 | Chat in Echtzeit | bestanden |
| 5.2 | Videoanruf mit zwei Teilnehmern (WebRTC) | bestanden |
| 6.1 | Verschlüsselte Sicherung, Duplikaterkennung beim Import | bestanden |
| 6.2 | Update-Prüfung | bestanden |
| 7.1 | Ressource über die Oberfläche buchen, gleichzeitige Doppelbuchung wird abgelehnt | bestanden |
| 7.2 | Oberfläche ohne Emojis (eigener Symbolsatz) | bestanden |

Zusätzlich durch Server-Tests abgedeckt: Teilprojekt-/Dokument-/Jahresnummern, Sichtbarkeit und Rechte,
Abhängigkeiten mit Kreisbezugsschutz, Erwähnungen, Dateiversionen und Explorer-Abgleich, Pfadschutz,
Teilen-/Anforderungslinks mit Passwort, Scan-Assistent, Stückliste und Verwendungsnachweis, Kopplung
Teil ↔ Zeichnung, Versionsstand 00 → 01 mit Historie, Feiertage aller Bundesländer, Resturlaubsprüfung,
KVP-Entscheidungen, KI-Anbindung (OpenAI-kompatibel), SMTP-Versand, WOPI-Zugriffstoken, revisionssicheres
Änderungsprotokoll, Ressourcen (nur Administratoren legen an, Überschneidung und gleichzeitige Buchung,
Genehmigung, Wochenserien, Sperre, Team-Beschränkung), Emoji-Prüfung des gesamten Quelltexts.

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
