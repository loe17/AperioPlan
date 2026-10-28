/** Wissensdatenbank: Inhalt im Format des Editors (ProseMirror/TipTap-JSON) und eingebaute Vorlagen.
 *  Symbole sind Namen aus dem eigenen Symbolsatz (wie bei Projekten: "name" oder "name:#farbe"). */

export type KbNode = { type: string; attrs?: Record<string, unknown>; content?: KbNode[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };
export type KbScope = 'workspace' | 'shared' | 'private';
export const KB_SCOPES: Record<KbScope, string> = { workspace: 'Firma', shared: 'Geteilt', private: 'Privat' };

/** reiner Text eines Dokuments (für Suche und Vorschau) */
export function kbText(doc: KbNode | null | undefined): string {
  const out: string[] = [];
  const walk = (n: KbNode) => {
    if (n.text) out.push(n.text);
    if (n.content) n.content.forEach(walk);
    if (['paragraph', 'heading', 'listItem', 'taskItem', 'tableCell', 'tableHeader', 'codeBlock', 'blockquote'].includes(n.type)) out.push('\n');
  };
  if (doc) walk(doc);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// kleine Bausteine für Vorlagen
const t = (text: string): KbNode => ({ type: 'text', text });
const p = (text = ''): KbNode => (text ? { type: 'paragraph', content: [t(text)] } : { type: 'paragraph' });
const h = (level: number, text: string): KbNode => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const ul = (...items: string[]): KbNode => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const ol = (...items: string[]): KbNode => ({ type: 'orderedList', attrs: { start: 1 }, content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const todo = (...items: string[]): KbNode => ({ type: 'taskList', content: items.map((i) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(i)] })) });
const note = (text: string): KbNode => ({ type: 'blockquote', content: [p(text)] });
const table = (head: string[], rows: string[][]): KbNode => ({
  type: 'table',
  content: [
    { type: 'tableRow', content: head.map((c) => ({ type: 'tableHeader', content: [p(c)] })) },
    ...rows.map((r) => ({ type: 'tableRow', content: r.map((c) => ({ type: 'tableCell', content: [p(c)] })) })),
  ],
});
const doc = (...content: KbNode[]): KbNode => ({ type: 'doc', content });

export interface KbTemplate { id: string; title: string; icon: string; description: string; content: KbNode }

export const KB_TEMPLATES: KbTemplate[] = [
  { id: 'instruction', title: 'Arbeitsanweisung', icon: 'wrench', description: 'Schritt für Schritt, mit Sicherheitshinweisen',
    content: doc(h(2, 'Zweck'), p('Wofür ist diese Anweisung da?'), h(2, 'Geltungsbereich'), p('Für welche Maschine, welchen Arbeitsplatz, welche Personen?'),
      h(2, 'Sicherheit'), note('Achtung – persönliche Schutzausrüstung: …'), h(2, 'Ablauf'), ol('Vorbereitung …', 'Durchführung …', 'Kontrolle …', 'Aufräumen …'),
      h(2, 'Bei Störungen'), p('Wen anrufen, was tun?'), h(2, 'Mitgeltende Unterlagen'), ul('…')) },
  { id: 'howto', title: 'Anleitung (How-to)', icon: 'lightbulb', description: 'Kurze Erklärung, wie etwas geht',
    content: doc(p('Kurz in einem Satz: Was erreicht man mit dieser Anleitung?'), h(2, 'Voraussetzungen'), ul('…'), h(2, 'So geht’s'), ol('…', '…', '…'), h(2, 'Häufige Fehler'), ul('…')) },
  { id: 'meeting', title: 'Besprechungsprotokoll', icon: 'note', description: 'Teilnehmer, Themen, Beschlüsse, Aufgaben',
    content: doc(table(['Datum', 'Ort', 'Leitung', 'Protokoll'], [['', '', '', '']]), h(2, 'Teilnehmer'), ul('…'), h(2, 'Themen'), ol('…'),
      h(2, 'Beschlüsse'), ul('…'), h(2, 'Aufgaben'), todo('… (wer, bis wann)'), h(2, 'Nächster Termin'), p('…')) },
  { id: 'checklist', title: 'Checkliste', icon: 'check-circle', description: 'Zum Abhaken, z. B. Inbetriebnahme oder Einarbeitung',
    content: doc(p('Wofür ist die Liste?'), h(2, 'Vorher'), todo('…', '…'), h(2, 'Durchführung'), todo('…', '…'), h(2, 'Abschluss'), todo('Dokumentation abgelegt', 'Kunde informiert')) },
  { id: 'onboarding', title: 'Einarbeitung neuer Kollegen', icon: 'users', description: 'Erste Woche, Ansprechpartner, Zugänge',
    content: doc(h(2, 'Willkommen!'), p('Schön, dass Sie da sind. Hier finden Sie alles für den Start.'), h(2, 'Ansprechpartner'),
      table(['Thema', 'Person', 'Telefon'], [['Personal', '', ''], ['IT', '', ''], ['Pate', '', '']]),
      h(2, 'Erste Woche'), todo('Zugänge und Arbeitsplatz', 'Sicherheitsunterweisung', 'Rundgang durch die Firma', 'Vorstellung im Team'), h(2, 'Wichtige Links'), ul('…')) },
  { id: 'project', title: 'Projektsteckbrief', icon: 'pin', description: 'Ziel, Umfang, Termine, Beteiligte',
    content: doc(table(['Projekt', 'Kunde', 'Start', 'Ende'], [['', '', '', '']]), h(2, 'Ziel'), p('…'), h(2, 'Umfang'), ul('Enthalten: …', 'Nicht enthalten: …'),
      h(2, 'Meilensteine'), table(['Meilenstein', 'Termin', 'Verantwortlich'], [['', '', ''], ['', '', '']]), h(2, 'Risiken'), ul('…')) },
  { id: 'faq', title: 'Häufige Fragen (FAQ)', icon: 'info', description: 'Fragen und Antworten',
    content: doc(h(3, 'Frage 1?'), p('Antwort …'), h(3, 'Frage 2?'), p('Antwort …'), h(3, 'Frage 3?'), p('Antwort …')) },
  { id: 'lessons', title: 'Erkenntnisse (Lessons learned)', icon: 'flag', description: 'Was lief gut, was machen wir künftig anders',
    content: doc(h(2, 'Was lief gut?'), ul('…'), h(2, 'Was lief nicht gut?'), ul('…'), h(2, 'Was ändern wir?'), todo('…')) },
];
