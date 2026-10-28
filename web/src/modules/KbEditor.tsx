import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { generateHTML, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import Highlight from '@tiptap/extension-highlight';
import { Placeholder } from '@tiptap/extensions';
import { upload } from '../lib/api';
import { useToast } from '../components/ui';
import { Icon, isIconName } from '../components/Icon';

/** Erweiterungen des Editors – auch für die Nur-Lesen-Ansicht (gleiches Schema) */
export function kbExtensions(placeholder = '') {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList, TaskItem.configure({ nested: true }),
    Image.configure({ inline: false, allowBase64: false }),
    Highlight,
    ...(placeholder ? [Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? 'Überschrift' : placeholder) })] : []),
  ];
}

/** Inhalt als HTML (Nur-Lesen, z. B. öffentliche Seite, Versionsvorschau). Sicher: läuft durch das Schema. */
export function KbView({ content }: { content: JSONContent }) {
  const html = useMemo(() => { try { return generateHTML(content, kbExtensions()); } catch { return '<p>Inhalt konnte nicht angezeigt werden.</p>'; } }, [content]);
  return <div className="kb-content tiptap" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------------------------------------------------------------- Befehle („/“-Menü und Werkzeugleiste)
interface Cmd { id: string; label: string; hint: string; icon: string; keys: string; run: (e: Editor) => void }
const COMMANDS: Cmd[] = [
  { id: 'p', label: 'Text', hint: 'Normaler Absatz', icon: 'T', keys: 'text absatz', run: (e) => e.chain().focus().setParagraph().run() },
  { id: 'h1', label: 'Überschrift 1', hint: 'Große Überschrift', icon: 'H1', keys: 'überschrift titel h1', run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { id: 'h2', label: 'Überschrift 2', hint: 'Abschnitt', icon: 'H2', keys: 'überschrift h2 abschnitt', run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { id: 'h3', label: 'Überschrift 3', hint: 'Unterabschnitt', icon: 'H3', keys: 'überschrift h3', run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { id: 'ul', label: 'Aufzählung', hint: 'Liste mit Punkten', icon: 'list', keys: 'liste aufzählung punkte', run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'ol', label: 'Nummerierung', hint: 'Liste mit Zahlen', icon: '1.', keys: 'nummer liste zahlen schritte', run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'todo', label: 'Checkliste', hint: 'Zum Abhaken', icon: 'check-circle', keys: 'checkliste aufgaben todo haken', run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'table', label: 'Tabelle', hint: '3 × 3 mit Kopfzeile', icon: 'layout', keys: 'tabelle', run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'quote', label: 'Hinweis', hint: 'Hervorgehobener Kasten', icon: 'info', keys: 'hinweis zitat achtung kasten', run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', label: 'Code', hint: 'Programmcode, Befehle', icon: '</>', keys: 'code befehl', run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: 'hr', label: 'Trennlinie', hint: 'Waagerechte Linie', icon: '—', keys: 'trennlinie linie', run: (e) => e.chain().focus().setHorizontalRule().run() },
];

function SlashMenu({ editor, onPickImage, extra }: { editor: Editor; onPickImage: () => void; extra: Cmd[] }) {
  const [state, setState] = useState<{ from: number; query: string; x: number; y: number } | null>(null);
  const [idx, setIdx] = useState(0);
  const all = useMemo(() => [...COMMANDS, { id: 'img', label: 'Bild oder Datei', hint: 'Vom Rechner hochladen', icon: 'image', keys: 'bild foto datei anhang', run: () => onPickImage() }, ...extra], [extra, onPickImage]);
  const list = state ? all.filter((c) => !state.query || `${c.label} ${c.keys}`.toLowerCase().includes(state.query.toLowerCase())) : [];
  const ref = useRef({ list, idx, state });
  ref.current = { list, idx, state };

  useEffect(() => {
    const check = () => {
      const { $from, empty } = editor.state.selection;
      if (!empty || $from.parent.type.name === 'codeBlock') return setState(null);
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
      const m = before.match(/(?:^|\s)\/([\wäöüß]{0,20})$/i);
      if (!m) return setState(null);
      const from = $from.pos - m[1]!.length - 1;
      const c = editor.view.coordsAtPos($from.pos);
      setState((s) => { if (!s || s.query !== m[1]) setIdx(0); return { from, query: m[1]!, x: c.left, y: c.bottom }; });
    };
    editor.on('update', check); editor.on('selectionUpdate', check);
    return () => { editor.off('update', check); editor.off('selectionUpdate', check); };
  }, [editor]);

  const pick = (c: Cmd) => {
    const s = ref.current.state; if (!s) return;
    editor.chain().focus().deleteRange({ from: s.from, to: editor.state.selection.from }).run();
    setState(null); c.run(editor);
  };
  useEffect(() => {
    const dom = editor.view.dom;
    const key = (e: KeyboardEvent) => {
      const { list, idx, state } = ref.current;
      if (!state || !list.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((idx + 1) % list.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((idx - 1 + list.length) % list.length); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(list[idx]!); }
      else if (e.key === 'Escape') { e.preventDefault(); setState(null); }
    };
    dom.addEventListener('keydown', key, true);
    return () => dom.removeEventListener('keydown', key, true);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state || !list.length) return null;
  return (
    <div className="kb-slash" style={{ left: Math.min(state.x, window.innerWidth - 280), top: Math.min(state.y + 6, window.innerHeight - 320) }} onMouseDown={(e) => e.preventDefault()}>
      {list.map((c, i) => (
        <button key={c.id} className={i === idx ? 'on' : ''} onMouseEnter={() => setIdx(i)} onClick={() => pick(c)}>
          <span className="kb-slash-ico">{isIconName(c.icon) ? <Icon name={c.icon} size={16} /> : c.icon}</span><span><b>{c.label}</b><span className="small muted">{c.hint}</span></span>
        </button>
      ))}
    </div>
  );
}

function Toolbar({ editor, onPickImage }: { editor: Editor; onPickImage: () => void }) {
  const s = useEditorState({ editor, selector: ({ editor: e }) => ({
    bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'), hl: e.isActive('highlight'),
    h1: e.isActive('heading', { level: 1 }), h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
    ul: e.isActive('bulletList'), ol: e.isActive('orderedList'), todo: e.isActive('taskList'), quote: e.isActive('blockquote'), link: e.isActive('link'),
    table: e.isActive('table'), undo: e.can().undo(), redo: e.can().redo(),
  }) });
  const b = (on: boolean, title: string, run: () => void, child: React.ReactNode) =>
    <button type="button" className={`kb-tb ${on ? 'on' : ''}`} title={title} onMouseDown={(e) => e.preventDefault()} onClick={run}>{child}</button>;
  const link = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link-Adresse (leer = Link entfernen)', prev ?? 'https://');
    if (url === null) return;
    if (!url.trim() || url === 'https://') editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };
  const c = () => editor.chain().focus();
  return (
    <div className="kb-toolbar">
      {b(false, 'Rückgängig (Strg+Z)', () => c().undo().run(), <Icon name="undo" size={15} />)}
      {b(false, 'Wiederholen (Strg+Y)', () => c().redo().run(), <Icon name="redo" size={15} />)}
      <span className="kb-sep" />
      {b(s.h1, 'Überschrift 1', () => c().toggleHeading({ level: 1 }).run(), 'H1')}
      {b(s.h2, 'Überschrift 2', () => c().toggleHeading({ level: 2 }).run(), 'H2')}
      {b(s.h3, 'Überschrift 3', () => c().toggleHeading({ level: 3 }).run(), 'H3')}
      <span className="kb-sep" />
      {b(s.bold, 'Fett (Strg+B)', () => c().toggleBold().run(), <b>F</b>)}
      {b(s.italic, 'Kursiv (Strg+I)', () => c().toggleItalic().run(), <i>K</i>)}
      {b(s.underline, 'Unterstrichen (Strg+U)', () => c().toggleUnderline().run(), <u>U</u>)}
      {b(s.strike, 'Durchgestrichen', () => c().toggleStrike().run(), <s>S</s>)}
      {b(s.hl, 'Markieren', () => c().toggleHighlight().run(), <span className="kb-hl">M</span>)}
      {b(s.link, 'Link', link, <Icon name="link" size={15} />)}
      <span className="kb-sep" />
      {b(s.ul, 'Aufzählung', () => c().toggleBulletList().run(), <Icon name="list" size={15} />)}
      {b(s.ol, 'Nummerierung', () => c().toggleOrderedList().run(), '1.')}
      {b(s.todo, 'Checkliste', () => c().toggleTaskList().run(), <Icon name="check-circle" size={15} />)}
      {b(s.quote, 'Hinweis-Kasten', () => c().toggleBlockquote().run(), <Icon name="info" size={15} />)}
      {b(false, 'Tabelle einfügen', () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), <Icon name="layout" size={15} />)}
      {b(false, 'Bild oder Datei', onPickImage, <Icon name="image" size={15} />)}
      {s.table && <>
        <span className="kb-sep" />
        {b(false, 'Zeile darunter', () => c().addRowAfter().run(), '+Zeile')}
        {b(false, 'Spalte rechts', () => c().addColumnAfter().run(), '+Spalte')}
        {b(false, 'Zeile löschen', () => c().deleteRow().run(), '−Zeile')}
        {b(false, 'Spalte löschen', () => c().deleteColumn().run(), '−Spalte')}
        {b(false, 'Tabelle löschen', () => c().deleteTable().run(), <Icon name="trash" size={14} />)}
      </>}
    </div>
  );
}

/** Editor mit Werkzeugleiste, „/“-Befehlen, Bildern per Einfügen/Ziehen */
export function KbEditor({ articleId, content, editable, onChange, extraCommands = [], editorRef }: {
  articleId: string; content: JSONContent; editable: boolean; onChange: (c: JSONContent) => void; extraCommands?: Cmd[]; editorRef?: React.MutableRefObject<Editor | null>;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  // Erst nach einer echten Eingabe speichern – das Öffnen allein (Editor ergänzt z. B. einen leeren Schlussabsatz) ist keine Änderung
  const touched = useRef(false);
  const touch = () => { touched.current = true; };
  const uploadFiles = async (ed: Editor, files: File[], pos?: number) => {
    if (!files.length) return;
    const fd = new FormData(); for (const f of files) fd.append('file', f, f.name);
    try {
      const res = await upload(`/knowledge/uploads?articleId=${articleId}`, fd) as { name: string; url: string; image: boolean }[];
      const nodes: JSONContent[] = res.map((r) => (r.image ? { type: 'image', attrs: { src: r.url, alt: r.name } }
        : { type: 'paragraph', content: [{ type: 'text', text: `Anhang: ${r.name}`, marks: [{ type: 'link', attrs: { href: r.url } }] }] }));
      const chain = ed.chain().focus();
      (pos !== undefined ? chain.insertContentAt(pos, nodes) : chain.insertContent(nodes)).run();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const editor = useEditor({
    extensions: kbExtensions('Schreiben Sie los – oder tippen Sie „/“ für Überschriften, Listen, Tabellen und mehr …'),
    content, editable, immediatelyRender: true, shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'kb-content tiptap' },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length) return false;
        event.preventDefault(); touch(); void uploadFiles(editor!, files); void view; return true;
      },
      handleDrop: (view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        touch(); void uploadFiles(editor!, files, pos); return true;
      },
    },
    onUpdate: ({ editor: e }) => { if (touched.current && e.isEditable) onChangeRef.current(e.getJSON()); },
  }, [articleId]);
  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);
  useEffect(() => { if (editorRef) editorRef.current = editor; }, [editor, editorRef]);
  if (!editor) return null;
  return (
    <div className="kb-editor" onKeyDownCapture={touch} onMouseDownCapture={touch} onPasteCapture={touch} onDropCapture={touch}>
      {editable && <Toolbar editor={editor} onPickImage={() => fileRef.current?.click()} />}
      <EditorContent editor={editor} />
      {editable && <SlashMenu editor={editor} onPickImage={() => fileRef.current?.click()} extra={extraCommands} />}
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void uploadFiles(editor, [...(e.target.files ?? [])]); e.target.value = ''; }} />
    </div>
  );
}
export type { Cmd as KbCommand };
