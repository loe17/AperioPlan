import type { Tool } from './tools';

/**
 * App-Store: mitgelieferte Anwendungen, die der Administrator ein- und ausschaltet.
 * Weitere Anwendungen (Plugins) liegen als Ordner mit manifest.json im Plugin-Verzeichnis
 * oder werden als ZIP-Datei hochgeladen. Wer eine eingeschaltete Anwendung nutzen darf,
 * regelt die Werkzeug-Freigabe je Benutzer bzw. Abteilung.
 */
export type AppCategory = 'Zusammenarbeit' | 'Kommunikation' | 'Kunden & Verkauf' | 'Technik' | 'Lager & Material' | 'Personal' | 'Finanzen' | 'Wissen & Organisation';
export const APP_CATEGORIES: AppCategory[] = ['Zusammenarbeit', 'Kommunikation', 'Kunden & Verkauf', 'Technik', 'Lager & Material', 'Personal', 'Finanzen', 'Wissen & Organisation'];

export interface AppInfo {
  id: Tool;
  name: string;
  category: AppCategory;
  icon: string;
  /** Kurzbeschreibung für die Kachel */
  summary: string;
  /** Was die Anwendung kann (Liste in der Detailansicht) */
  features: string[];
  /** Seite in der Seitenleiste */
  route?: string;
  /** Andere Anwendungen, die vorausgesetzt werden */
  requires?: Tool[];
  /** Bis 0.1.3 fester Bestandteil – bei bestehenden Installationen eingeschaltet */
  preinstalled?: boolean;
}

export const APPS: AppInfo[] = [
  { id: 'chat', name: 'Chat und Videoanrufe', category: 'Kommunikation', icon: 'chat', route: '/chat', preinstalled: true,
    summary: 'Nachrichten, Gruppen und Videoanrufe mit Bildschirmfreigabe', features: ['Einzel- und Gruppenchats', 'Reaktionen und @Erwähnungen', 'Videoanruf mit Fernsteuerung', 'Anwesenheitsstatus'] },
  { id: 'meetings', name: 'Meetings', category: 'Kommunikation', icon: 'video', route: '/meetings', requires: ['chat'],
    summary: 'Videokonferenzen planen – Gäste treten über einen Link bei', features: ['Termin mit Einladung im Kalender', 'Gast-Link ohne Benutzerkonto', 'Warteraum mit Einlass', 'Bildschirm teilen, Chat, Hintergrund'] },
  { id: 'phone', name: 'Telefonie', category: 'Kommunikation', icon: 'phone', route: '/phone',
    summary: 'Telefonanlage anbinden: Anrufer aus dem CRM erkennen, mit dem Headset am PC telefonieren', features: ['FRITZ!Box, sipgate, Placetel, 3CX, Asterisk/FreePBX', 'Anrufer-Anzeige mit Kundendaten', 'Anrufliste und Notizen im CRM', 'Softphone im Browser (Headset)', 'Wählen per Klick'] },
  { id: 'mail', name: 'E-Mail', category: 'Kommunikation', icon: 'mail', route: '/mail', preinstalled: true,
    summary: 'Persönliches Postfach und gemeinsames Projekt-Postfach', features: ['Lesen und Schreiben wie in Outlook', 'Zuordnung zu Projekt und Kunde', 'Aufgabe aus E-Mail'] },
  { id: 'calendar', name: 'Kalender', category: 'Zusammenarbeit', icon: 'calendar', route: '/calendar', preinstalled: true,
    summary: 'Termine, Teamkalender und Abgleich mit Outlook/Google', features: ['Einladungen mit Zusage', 'Teamkalender', 'Kalender-Abo'] },
  { id: 'board', name: 'Schwarzes Brett', category: 'Zusammenarbeit', icon: 'pin', route: '/board',
    summary: 'Mitteilungen an alle und interner Marktplatz', features: ['Mitteilungen mit Lesebestätigung', 'Anheften und Ablaufdatum', 'Marktplatz: verkaufen, verschenken, reservieren', 'Angebote der Firma und der Mitarbeiter'] },
  { id: 'forms', name: 'Formulare', category: 'Zusammenarbeit', icon: 'list', route: '/forms',
    summary: 'Umfragen und Formulare mit Auswertung', features: ['Viele Fragetypen', 'Anonym oder namentlich', 'Öffentlicher Link für Externe', 'Auswertung mit Diagrammen, Export nach Excel'] },
  { id: 'mindmap', name: 'Mindmaps', category: 'Zusammenarbeit', icon: 'dependency', route: '/mindmaps',
    summary: 'Ideen sammeln und ordnen – privat oder im Projekt', features: ['Bedienung mit Tastatur', 'Farben und Einklappen', 'Export als Bild und Gliederung'] },
  { id: 'notes', name: 'Notizen', category: 'Wissen & Organisation', icon: 'note', route: '/notes', preinstalled: true,
    summary: 'Private Notizen', features: ['Schnell notiert', 'Durchsuchbar'] },
  { id: 'knowledge', name: 'Wissensdatenbank', category: 'Wissen & Organisation', icon: 'lightbulb', route: '/knowledge',
    summary: 'Anleitungen, Abläufe und Wissen der Firma an einem Ort', features: ['Artikel in Bereichen und Unterseiten', 'Vorlagen und Favoriten', 'Versionen und Kommentare', 'Teilen per Link'] },
  { id: 'kvp', name: 'KVP-Ideenbox', category: 'Wissen & Organisation', icon: 'lightbulb', route: '/kvp', preinstalled: true,
    summary: 'Verbesserungsvorschläge sammeln und bewerten', features: ['Ideen einreichen', 'Bewerten und umsetzen'] },
  { id: 'crm', name: 'CRM', category: 'Kunden & Verkauf', icon: 'building', route: '/crm', preinstalled: true,
    summary: 'Kunden, Lieferanten, Angebote, Rechnungen und Reklamationen', features: ['Kunden- und Lieferantenkartei', 'Angebote und Rechnungen als PDF', 'E-Rechnung (XRechnung, ZUGFeRD)', 'Verlauf aller Kontakte'] },
  { id: 'calculation', name: 'Kalkulation', category: 'Kunden & Verkauf', icon: 'euro', route: '/calculations', preinstalled: true,
    summary: 'Angebots- und Nachkalkulation je Projekt', features: ['Vorlagen für Anlagen, Stundensätze, Reisen', 'Vier-Augen-Prüfung', 'Angebot im CRM erzeugen'] },
  { id: 'purchasing', name: 'Einkauf', category: 'Lager & Material', icon: 'truck', route: '/purchasing', preinstalled: true,
    summary: 'Bestellungen aus Stücklisten, Liefertermine, Wareneingang', features: ['Kaufteile aus CAD und PCB', 'Bestellungen als PDF', 'Liefer-Erinnerungen'] },
  { id: 'warehouse', name: 'Lager', category: 'Lager & Material', icon: 'box', route: '/warehouse',
    summary: 'Bestände, Lagerorte und Warenbewegungen', features: ['Wareneingang aus dem Einkauf', 'Entnahme für Projekte', 'Mindestbestand mit Bestellvorschlag', 'Chargen und Seriennummern', 'Inventur und Barcode per Kamera'] },
  { id: 'inventory', name: 'Inventar', category: 'Lager & Material', icon: 'equipment', route: '/inventory',
    summary: 'Geräte, Maschinen und Ausstattung mit Prüfterminen', features: ['Inventarnummern und QR-Etiketten', 'Standort und Verantwortliche', 'Prüftermine (z. B. DGUV V3)', 'Abschreibung', 'Übergaben und Inventur'] },
  { id: 'resources', name: 'Ressourcen', category: 'Lager & Material', icon: 'car', route: '/resources', preinstalled: true,
    summary: 'Räume, Firmenwagen und Geräte buchen', features: ['Buchung mit Genehmigung', 'Rückgabe mit Zustand'] },
  { id: 'cad', name: 'CAD-Bridge', category: 'Technik', icon: 'cad', route: '/cad', preinstalled: true,
    summary: 'SolidWorks-Dateien mit Nummern, Sperren und Freigaben', features: ['Speichermaske', 'Aus-/Einchecken', 'Stücklisten', 'PDF, DXF und STEP bei Freigabe'] },
  { id: 'pcb', name: 'PCB-Bridge', category: 'Technik', icon: 'bolt', route: '/pcb', preinstalled: true,
    summary: 'Leiterplatten aus KiCad mit Nummern, Stückliste und Fertigungsdaten', features: ['Speichermaske', 'Aus-/Einchecken', 'Gerber, Bohrdaten, STEP bei Freigabe'] },
  { id: 'viewer3d', name: '3D-Viewer', category: 'Technik', icon: 'cube',
    summary: '3D-Modelle direkt im Browser ansehen', features: ['STEP, STL, OBJ, glTF, 3MF', 'Drehen, Schneiden, Messen', 'Baugruppenbaum'] },
  { id: 'time', name: 'Zeiterfassung', category: 'Personal', icon: 'timer', route: '/time', preinstalled: true,
    summary: 'Stempeluhr mit Pausen- und Ruhezeitregeln', features: ['Stempeln und Projektzeiten', 'Regeln nach Arbeitszeitgesetz', 'Korrekturen mit Freigabe'] },
  { id: 'absences', name: 'Urlaub', category: 'Personal', icon: 'palm', route: '/absences', preinstalled: true,
    summary: 'Urlaubsanträge und Urlaubskonto', features: ['Antrag und Genehmigung', 'Teamkalender'] },
  { id: 'payroll', name: 'Lohnabrechnung', category: 'Personal', icon: 'euro', route: '/payroll', requires: ['time'],
    summary: 'Lohn und Gehalt abrechnen, Lohnzettel erstellen, Daten an den Steuerberater', features: ['Lohnsteuer nach amtlichem Rechenweg', 'Sozialversicherung', 'Zuschläge aus der Zeiterfassung', 'Lohnzettel als PDF', 'Übergabe an DATEV'] },
  { id: 'finance', name: 'Finanzbuchhaltung', category: 'Finanzen', icon: 'chart', route: '/finance', requires: ['crm'],
    summary: 'Offene Posten, Zahlungen, Mahnungen und Übergabe an den Steuerberater', features: ['Ausgangs- und Eingangsrechnungen', 'Kontoauszug abgleichen', 'Mahnungen', 'Umsatzsteuer-Übersicht', 'DATEV-Export'] },
  { id: 'ai', name: 'KI-Assistent', category: 'Wissen & Organisation', icon: 'sparkles', preinstalled: true,
    summary: 'Zusammenfassen, Schreiben, Dokumente auswerten', features: ['Eigenes Modell oder Online-Anbieter', 'Je Projekt wählbar'] },
];

export const PREINSTALLED_APPS: Tool[] = APPS.filter((a) => a.preinstalled).map((a) => a.id);
export const appInfo = (id: string) => APPS.find((a) => a.id === id);

/** Widgets der eigenen Startseite */
export const DASHBOARD_WIDGETS = ['clock', 'weather', 'tasks', 'stamp', 'today', 'favorites', 'notifications', 'note', 'links', 'absent', 'board', 'crm', 'deliveries', 'mail', 'meetings', 'calls', 'stats'] as const;
export type DashboardWidgetType = (typeof DASHBOARD_WIDGETS)[number];
export interface DashboardWidget { id: string; type: DashboardWidgetType; size: 1 | 2 | 3 | 4; config?: Record<string, unknown> }
export const DEFAULT_DASHBOARD: DashboardWidget[] = [
  { id: 'w1', type: 'clock', size: 1 }, { id: 'w2', type: 'stamp', size: 1 }, { id: 'w3', type: 'weather', size: 2 },
  { id: 'w4', type: 'tasks', size: 2 }, { id: 'w5', type: 'today', size: 2 }, { id: 'w6', type: 'favorites', size: 4 },
];
