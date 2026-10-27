# AperioPlan – Handbuch für Anwender

Willkommen bei AperioPlan! Diese Anleitung zeigt Schritt für Schritt, wie Sie im Alltag mit Projekten, Aufgaben, CAD-Daten, Zeiten und Urlaub arbeiten.

---

## 1. Anmelden und erste Schritte

![Anmeldung](screenshots/01-anmeldung.png)

1. Im Browser die Adresse Ihrer Firma öffnen (z. B. `https://plan.firma.de` oder `https://aperioplan.local`). Warnt der Browser vor dem Zertifikat, hat Ihr Rechner das AperioPlan-Zertifikat noch nicht – Ihre IT richtet das einmalig ein (Administrator-Handbuch, Abschnitt 4).
2. Mit Benutzername und Passwort anmelden – bei eingerichtetem Firmen-Login mit Ihren gewohnten Windows-Zugangsdaten.
3. Beim ersten Mal vergeben Sie ein eigenes Passwort (mindestens 8 Zeichen).

Unter **Einstellungen → Profil** stellen Sie Sprache (Deutsch/Englisch) und Farbschema ein. „Wie System“ folgt automatisch dem Hell-/Dunkelmodus von Windows.

## 2. Die Oberfläche

```
┌────────────────────┬──────────────────────────────────────────────────────┐
│ Seitenleiste       │ Brotkrumen-Pfad        Blitzsuche   Glocke   Profil  │
│  Mein Schreibtisch ├──────────────────────────────────────────────────────┤
│  Meine Teams       │                                                      │
│  Werkzeuge         │                 Arbeitsbereich                       │
│                    │                                                      │
│ v1.1.0 ● Verbunden │                                                      │
└────────────────────┴──────────────────────────────────────────────────────┘
```

* **Seitenleiste:** Schnellzugriff auf Ihren Schreibtisch, Ihre Teams mit Projekten und die Werkzeuge. Mit `«` oder **Strg + \\** einklappen, mit dem Menü-Symbol wieder öffnen.
* **Brotkrumen-Pfad:** zeigt immer, wo Sie gerade sind – jeder Teil ist anklickbar.
* **Blitzsuche – Strg + K:** zwei Buchstaben genügen, um zu einem Projekt, einer Baugruppe, einer Aufgabe, Datei oder einem Kollegen zu springen. Mit Pfeiltasten auswählen, Enter öffnet.
* **Glocke:** neue Aufgaben, Erwähnungen, Freigaben und Genehmigungen.
* **Detail-Fenster:** Ein Klick auf eine Aufgabe, ein Bauteil oder eine Idee öffnet rechts eine Karte mit allen Details. Klick daneben oder `Esc` schließt sie.
* **Version unten links:** Ein Klick zeigt „Was ist neu?“.

## 3. Mein Schreibtisch

![Mein Schreibtisch](screenshots/02-schreibtisch.png)

* **Übersicht:** Begrüßung, Stempeluhr, Ihre offenen Aufgaben, Favoriten.
* **Posteingang:** alle Benachrichtigungen.
* **Mein Kalender:** Fristen Ihrer Aufgaben, eigene Abwesenheiten, Feiertage.
* **Stempeluhr, Urlaubskonto, Private Notizen** (nur für Sie sichtbar).

Projekte markieren Sie mit dem Stern neben dem Namen als Favorit.

## 4. Projekte

### Projekt anlegen

**Alle Projekte → Neues Projekt** (oder Strg + K → „Neues Projekt“).

* Die **Projektnummer** wird automatisch vergeben (z. B. `0100`).
* Als **Teilprojekt** eines Hauptprojekts erhält es einen Buchstaben (`0100-A`).
* Der Projektordner mit `01_CAD`, `02_Zeichnungen`, `03_Doku`, `04_Fertigung` wird automatisch angelegt.
* Unter **Symbol** wählen Sie ein Bild und eine Farbe für das Projekt – so finden Sie es in Listen und der Seitenleiste schneller wieder. Teams erhalten ihr Symbol unter **Einstellungen → Teams**.

![Kanban-Board](screenshots/03-kanban.png)

### Werkzeuge im Projekt (Reiter)

| Reiter | Wofür |
|---|---|
| Übersicht | Fortschritt, überfällige Aufgaben, Teilprojekte, nächste Fristen |
| Kanban-Board | Aufgaben per Maus zwischen *Zu erledigen*, *In Arbeit*, *Prüfung*, *Fertig* verschieben |
| Aufgabenliste | Tabelle mit Filtern und Sortierung |
| Gantt-Diagramm | Zeitbalken mit Meilensteinen ◆ und Abhängigkeiten (Pfeile). Balken ziehen verschiebt, rechte Kante verlängert |
| Whiteboard | freie Zeichenfläche: Haftnotizen, Formen, Pfeile, Freihand – Doppelklick bearbeitet Text, Mausrad zoomt |
| Dateien | Projektordner mit Hochladen, Versionen und Freigaben |
| CAD-Dateien | alle Teile, Baugruppen und Zeichnungen des Projekts |
| Chat | Projekt-Chat mit Videoanruf |
| Zeiterfassung | Stempeluhr für das Projekt, Auswertung nach Mitarbeiter und Aufgabe |
| Abschlussbericht | Ziele, Ergebnis, Kosten, Abnahme – druckbar |
| Dokumente | Schriftverkehr, Verträge, Berichte mit Nummer (`0100-DOK-001`) |
| Änderungsprotokoll | Wer hat wann was geändert? |

Welche Reiter ein Projekt hat, legen Projektverantwortliche unter **Einstellungen** im Projekt fest.

### Aufgaben

* **Neue Aufgabe** oben rechts oder `＋` in einer Kanban-Spalte.
* Im Detail-Fenster: Status, Priorität, Bearbeiter, Abteilung, Start/Fällig, geschätzter Aufwand, Meilenstein, Beschreibung, Abhängigkeiten.
* **Kommentare:** Mit `@benutzername` erwähnen Sie Kollegen – sie werden benachrichtigt. Strg + Enter sendet.
* **Einstempeln** im Detail-Fenster bucht Ihre Zeit direkt auf diese Aufgabe.

## 5. Dateien

![Dateien eines Projekts](screenshots/06-dateien.png)

* **Hochladen:** Dateien einfach in das Fenster ziehen oder „Hochladen“ wählen. Gleichnamige Dateien werden nicht überschrieben, sondern als neue **Version** gespeichert (v2, v3 …) – ältere Stände bleiben abrufbar.
* **Vorschau:** PDFs, Bilder und Videos öffnen sich direkt im Browser.
* **Sperren (Schloss):** verhindert, dass Kollegen eine Datei gleichzeitig bearbeiten.
* **Office (Bearbeiten-Knopf):** Word-, Excel- und PowerPoint-Dateien im Browser bearbeiten (falls eingerichtet).
* Gelöschte Dateien landen im Papierkorb des Projekts.
* Der Pfad für den **Windows-Explorer** steht oberhalb der Liste.

### Freigaben für Externe (Knopf „Freigaben“)

| Art | Wofür |
|---|---|
| Daten teilen | Kunden/Lieferanten laden Dateien eines Ordners herunter |
| Daten anfordern | Lieferanten laden große 3D-Dateien oder Datenblätter **ohne Benutzerkonto** direkt in einen Projektordner hoch |
| Gastzugang | Kunden, Statiker oder Partner sehen nur die freigegebenen Bereiche (Dateien, freigegebene Zeichnungen, Termine) |

Jeder Link kann ein **Passwort**, ein **Ablaufdatum** und eine **maximale Anzahl Nutzungen** erhalten und jederzeit widerrufen werden. Bei Uploads über einen Anforderungslink werden Sie benachrichtigt.

## 6. CAD-Zentrale (SolidWorks)

![CAD-Zentrale mit Stückliste](screenshots/08-cad-stueckliste.png)

### Nummern verstehen

`0100-100-00-0000-00_Rahmen`

| Teil | Bedeutung |
|---|---|
| `0100` | Hauptbaugruppe = Projektnummer |
| `100` | Unterbaugruppe (z. B. 100 Gestell, 200 Antrieb, 300 Pneumatik) |
| `00` | Unter-Unterbaugruppe |
| `0000` | laufende Teilenummer |
| `00` | Versionsstand (00 = Urversion, 01 = erste Überarbeitung) |
| `_Rahmen` | sprechende Benennung |

### In SolidWorks speichern

1. Neues Teil/Baugruppe konstruieren und **Speichern** drücken.
2. Die **Speichermaske** öffnet sich: Projekt, Unterbaugruppe, Benennung, Werkstoff, Beschaffungsart … ausfüllen. Pflichtfelder sind mit * markiert; die Vorschau zeigt den künftigen Dateinamen.
3. Auf Wunsch wird die **passende 2D-Zeichnung** (`.slddrw`) gleich mit angelegt.
4. Alle Eingaben stehen danach als Eigenschaften in der Datei – und damit **ohne Abtippen im Schriftkopf** der Zeichnung.

### Auschecken und Einchecken

* Eine Datei, die Sie bearbeiten, ist für andere **gesperrt** („Gesperrt durch Max Mustermann“). Kollegen können sie in Baugruppen laden und ansehen, aber nicht überschreiben.
* Menü **AperioPlan → Einchecken …**: Datei mit kurzem Kommentar hochladen. Bei Baugruppen wird die Stückliste automatisch übertragen.
* **Strg + S** auf einer nicht ausgecheckten Datei: Der Wächter bietet das Auschecken an.

### Änderungen: Neuer Versionsstand

Freigegebene Teile sind schreibgeschützt. Für Änderungen **AperioPlan → Neuer Versionsstand**: Grund eingeben (z. B. *„Bohrungsdurchmesser auf 12 mm vergrößert wegen stärkerer Welle“*). Aus `…-00` wird `…-01`. Jeder Stand bleibt für immer abrufbar.

### Wo verbaut?

Vor dem Ändern oder Löschen zeigt **Wo verbaut?** alle Baugruppen und Projekte, die das Teil verwenden.

### Freigabe

1. Konstrukteur: **Zur Prüfung geben**.
2. Teamleitung/Projektverantwortliche prüfen und **freigeben**.
3. Ein Eigenfertigungsteil kann erst freigegeben werden, wenn seine **Zeichnung freigegeben** ist.
4. Nach der Freigabe entstehen automatisch **PDF** (Werkstatt, Einkauf), **DXF** (Laser/Brennschneiden) und **STEP** (CNC) im Ordner `04_Fertigung`.

### Stückliste

Im Detail-Fenster einer Baugruppe: **Stückliste** – mehrstufig oder als Mengenübersicht, Export als CSV für Excel.

> Ohne SolidWorks können Nummern auch im Browser vergeben werden: **CAD-Zentrale → Neue Nummer**.

## 7. Zeiterfassung

![Zeiterfassung](screenshots/11-zeiterfassung.png)

* **Einstempeln:** Stempeluhr auf dem Schreibtisch, unter **Stempeluhr** oder direkt in einer Aufgabe. Ein erneutes Einstempeln auf ein anderes Projekt **wechselt** automatisch.
* **Ausstempeln** beendet die Buchung.
* **Fehlbuchung?** Bei der Buchung **Korrektur …** wählen (oder „Zeit nachtragen“): *Was? Welche Zeit? Warum?* angeben. Die Teamleitung genehmigt mit einem Klick, Sie werden benachrichtigt.
* Wochenübersicht mit Summen, Export als CSV.

## 8. Urlaub und Abwesenheit

1. **Urlaubskonto → Urlaub beantragen**: ersten und letzten Tag wählen, ggf. halbe Tage. AperioPlan rechnet Wochenenden und Feiertage heraus und zeigt die Arbeitstage.
2. Die Teamleitung erhält den Antrag und genehmigt ihn.
3. Das Konto zeigt Anspruch, genommene, beantragte und verbleibende Tage.

**Datenschutz:** Im **Teamkalender** sehen Kollegen nur, *wann* Sie abwesend sind – niemals Urlaub, Krankheit oder Ihre Notiz.

## 8a. Räume, Fahrzeuge und Geräte buchen

![Belegungsplan der Ressourcen](screenshots/09-ressourcen.png)

**Werkzeuge → Ressourcen** zeigt den Belegungsplan aller Räume, Firmenwagen und Geräte – als Woche (alle Ressourcen nebeneinander) oder als Tag mit Uhrzeiten.

1. Auf eine freie Stelle im Plan klicken oder **Buchen** wählen.
2. Ressource, Beginn und Ende auswählen. AperioPlan zeigt sofort, ob der Zeitraum frei ist. Ist er belegt, schlägt es freie Ressourcen derselben Art vor.
3. Optional einen Anlass (z. B. „Kundentermin“) und ein Projekt angeben. Für regelmäßige Termine **Wöchentlich wiederholen** ankreuzen.
4. **Buchen.** Muss die Ressource genehmigt werden (z. B. Firmenwagen), ist die Buchung zunächst gestrichelt umrandet und wird nach der Genehmigung durchgezogen dargestellt. Sie werden benachrichtigt.

![Ressource buchen](screenshots/10-ressource-buchen.png)

* **Meine Buchungen** listet alle eigenen Buchungen; dort lassen sie sich verschieben oder stornieren – bei Serien wahlweise nur ein Termin oder die ganze Serie.
* **Zu genehmigen** erscheint für Genehmiger und Administratoren.
* Eigene Buchungen stehen zusätzlich in **Mein Kalender**.
* **Datenschutz:** Kollegen sehen nur, *wer* eine Ressource belegt – den Anlass sehen nur Sie, der Genehmiger und Administratoren.

## 9. Kommunikation

![Projekt-Chat](screenshots/13-chat.png)

* **Chat:** Projekt-, Team- und Direktnachrichten in Echtzeit. Dateien per Büroklammer oder Einfügen (Strg + V) teilen. Ungelesene Nachrichten zeigt eine rote Zahl.
* **Videoanruf:** Im Chat **Videoanruf** – Kollegen erhalten eine Einladung. Mit **Bildschirm teilen** besprechen Sie z. B. gemeinsam ein CAD-Modell. Keine Zusatzsoftware nötig.
* **E-Mail:** Das Projektpostfach unter **E-Mail**. E-Mails Projekten und Aufgaben zuordnen, beantworten, Anhänge landen im Projektordner. Tipp: Die Projektnummer im Betreff (`[0100]`) sorgt für automatische Zuordnung.

## 10. KVP-Ideenbox

**KVP-Ideenbox → Neue Idee**: Titel, Beschreibung, Abteilung, geschätztes Einsparpotenzial in Euro und Fotos. Die zuständige Teamleitung prüft, entscheidet (*angenommen, umgesetzt, abgelehnt*) und gibt Ihnen eine Rückmeldung.

## 11. KI-Assistent

Falls eingerichtet, erscheint im Projekt der Knopf **KI**:

* **Zusammenfassen:** Fortschritt, Risiken, nächste Schritte des Projekts.
* **Schreibhilfe:** z. B. einen Statusbericht an den Kunden formulieren.
* **Frage stellen:** freie Fragen zum Projekt.

Der Assistent sieht nur Daten, auf die Sie selbst Zugriff haben.

## 12. Tastenkürzel

| Kürzel | Funktion |
|---|---|
| Strg + K | Blitzsuche |
| Strg + \\ | Seitenleiste ein-/ausklappen |
| Esc | Fenster schließen |
| Strg + Enter | Kommentar senden |
| Enter / Umschalt + Enter | Chat: senden / neue Zeile |
| Entf | Whiteboard: Auswahl löschen |
