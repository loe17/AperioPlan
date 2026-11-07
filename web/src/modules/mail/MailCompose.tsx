/**
 * E-Mail schreiben: Absender wählen, Empfänger mit Vorschlägen und Adressbuch (Kontakte aus dem CRM, Mitarbeiter,
 * Abteilungen als Gruppe), Signaturen wie in Outlook, stilles Sichern des Entwurfs und Senden ohne Doppelklick-Probleme.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, put, upload } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { fmtBytes, fmtTime } from '../../lib/format';
import { Confirm, Dropdown, Empty, Modal, useAction, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { resolveSignature, senderLine, type MailAccount, type SignatureData } from './types';

export interface ComposeInit { to?: string; cc?: string; bcc?: string; subject?: string; html?: string; replyOf?: string; replyAll?: boolean; forwardOf?: string; forwardAttachments?: { name: string; size: number }[]; draftId?: string; accountId?: string; attachments?: { name: string; path: string; size: number }[] }

type Field = 'to' | 'cc' | 'bcc';
interface Person { kind: 'person'; name: string; email: string }
interface Group { kind: 'group'; id: string; name: string; members: { name: string; email: string }[]; excluded: string[] }
type Chip = Person | Group;
interface Entry { kind: string; name: string; email: string; detail: string }
interface GroupInfo { id: string; name: string; count: number }

/** Adressliste „Name <a@b>, c@d; …“ in Einträge zerlegen (Kommas in Anführungszeichen bleiben) */
export function parseAddresses(s: string): Person[] {
  const out: Person[] = [];
  let cur = '', quoted = false;
  const flush = () => {
    const t = cur.trim(); cur = '';
    if (!t) return;
    const m = t.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
    out.push(m ? { kind: 'person', name: m[1]!.trim(), email: m[2]!.trim() } : { kind: 'person', name: '', email: t });
  };
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === ',' || ch === ';' || ch === '\n')) flush(); else cur += ch;
  }
  flush();
  return out;
}
const personText = (p: { name: string; email: string }) => (p.name && p.name !== p.email ? `"${p.name.replace(/"/g, '')}" <${p.email}>` : p.email);
export function chipsToString(chips: Chip[]) {
  return chips.flatMap((c) => (c.kind === 'person' ? [personText(c)] : c.members.filter((m) => !c.excluded.includes(m.email)).map(personText))).join(', ');
}
const validEmail = (e: string) => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(e);

function RecipientField({ chips, onChange, onBook, autoFocus, onGroup }: { chips: Chip[]; onChange: (c: Chip[]) => void; onBook: () => void; autoFocus?: boolean; onGroup: (g: Group) => void }) {
  const [text, setText] = useState('');
  const [sugg, setSugg] = useState<{ entries: Entry[]; groups: GroupInfo[] } | null>(null);
  const [hi, setHi] = useState(0);
  useEffect(() => {
    if (text.trim().length < 2) { setSugg(null); return; }
    const t = setTimeout(() => { void get<{ entries: Entry[]; groups: GroupInfo[] }>(`/mailbox/addressbook?q=${encodeURIComponent(text.trim())}&limit=8`).then((r) => { setSugg({ entries: r.entries.slice(0, 8), groups: r.groups.slice(0, 4) }); setHi(0); }).catch(() => setSugg(null)); }, 200);
    return () => clearTimeout(t);
  }, [text]);
  const addRaw = () => {
    const ps = parseAddresses(text).filter((p) => p.email);
    if (!ps.length) return false;
    onChange([...chips, ...ps]); setText(''); setSugg(null);
    return true;
  };
  const addGroup = async (g: GroupInfo) => {
    const r = await get<{ id: string; name: string; members: { name: string; email: string }[] }>(`/mailbox/addressbook/groups/${g.id}`);
    onChange([...chips, { kind: 'group', id: r.id, name: r.name, members: r.members, excluded: [] }]); setText(''); setSugg(null);
  };
  const options: ({ type: 'entry'; e: Entry } | { type: 'group'; g: GroupInfo })[] = [...(sugg?.groups.map((g) => ({ type: 'group' as const, g })) ?? []), ...(sugg?.entries.map((e) => ({ type: 'entry' as const, e })) ?? [])];
  const pick = (i: number) => {
    const o = options[i];
    if (!o) return;
    if (o.type === 'group') void addGroup(o.g);
    else { onChange([...chips, { kind: 'person', name: o.e.name, email: o.e.email }]); setText(''); setSugg(null); }
  };
  return (
    <div className="rcpt">
      {chips.map((c, i) => (
        <span key={i} className={`rcpt-chip ${c.kind === 'person' && !validEmail(c.email) ? 'bad' : ''} ${c.kind}`} title={c.kind === 'person' ? c.email : `${c.members.length - c.excluded.length} Personen`}>
          {c.kind === 'group' ? <button className="link" onClick={() => onGroup(c)}><Icon name="users" size={13} /> Gruppe {c.name} ({c.members.length - c.excluded.length})</button> : (c.name || c.email)}
          <button className="x" title="Entfernen" onClick={() => onChange(chips.filter((_, j) => j !== i))}>×</button>
        </span>
      ))}
      <input value={text} autoFocus={autoFocus} placeholder={chips.length ? '' : 'Name oder Adresse eingeben …'}
        onChange={(e) => { const v = e.target.value; if (/[,;]$/.test(v)) { setText(v.slice(0, -1)); setTimeout(addRaw); } else setText(v); }}
        onBlur={() => { setTimeout(() => { if (text.includes('@')) addRaw(); setSugg(null); }, 150); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(options.length - 1, hi + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(0, hi - 1)); }
          else if (e.key === 'Enter' || e.key === 'Tab') { if (options.length && sugg) { e.preventDefault(); pick(hi); } else if (text.trim() && addRaw()) e.preventDefault(); }
          else if (e.key === 'Backspace' && !text && chips.length) onChange(chips.slice(0, -1));
        }} />
      <button className="btn ghost sm" title="Adressbuch" onClick={onBook}><Icon name="id-card" /></button>
      {sugg && options.length > 0 && (
        <div className="rcpt-sugg">
          {options.map((o, i) => (
            <div key={i} className={`item ${i === hi ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
              {o.type === 'group' ? <><Icon name="users" /> <b>Gruppe {o.g.name}</b> <span className="small muted">{o.g.count} Personen</span></>
                : <><Icon name={o.e.kind === 'user' ? 'user' : o.e.kind === 'recent' ? 'history' : o.e.kind === 'company' ? 'building' : 'id-card'} /> <span>{o.e.name}</span> <span className="small muted">{o.e.email}{o.e.detail ? ` · ${o.e.detail}` : ''}</span></>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SOURCES: [string, string, string][] = [['all', 'Alle', 'list'], ['contacts', 'Kontakte (CRM)', 'id-card'], ['companies', 'Kunden und Firmen', 'building'], ['users', 'Mitarbeiter', 'user'], ['groups', 'Gruppen', 'users'], ['recent', 'Zuletzt verwendet', 'history']];

/** Adressbuch wie in Outlook: Quelle wählen, suchen, ankreuzen und zu An/Cc/Bcc hinzufügen */
export function AddressBook({ field, onAdd, onClose }: { field: Field; onAdd: (field: Field, chips: Chip[]) => void; onClose: () => void }) {
  const [source, setSource] = useState('all');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q), 200); return () => clearTimeout(t); }, [q]);
  const apiSource = source === 'groups' ? 'users' : source;
  const { data } = useApi<{ entries: Entry[]; groups: GroupInfo[]; crm: boolean }>(`/mailbox/addressbook?source=${apiSource}&q=${encodeURIComponent(dq)}&limit=300`);
  const [sel, setSel] = useState<Map<string, Entry | GroupInfo>>(new Map());
  const entries = source === 'groups' ? [] : data?.entries ?? [];
  const groups = source === 'groups' || source === 'all' ? data?.groups ?? [] : [];
  const toggle = (key: string, v: Entry | GroupInfo) => { const n = new Map(sel); if (n.has(key)) n.delete(key); else n.set(key, v); setSel(n); };
  const add = async (f: Field) => {
    const chips: Chip[] = [];
    for (const [key, v] of sel) {
      if (key.startsWith('g:')) { const r = await get<{ id: string; name: string; members: { name: string; email: string }[] }>(`/mailbox/addressbook/groups/${(v as GroupInfo).id}`); chips.push({ kind: 'group', id: r.id, name: r.name, members: r.members, excluded: [] }); }
      else chips.push({ kind: 'person', name: (v as Entry).name, email: (v as Entry).email });
    }
    onAdd(f, chips); setSel(new Map());
  };
  return (
    <Modal size="lg" title="Adressbuch" onClose={onClose} footer={<>
      <span className="small muted">{sel.size} ausgewählt</span><span className="grow" />
      {(['to', 'cc', 'bcc'] as Field[]).map((f) => <button key={f} className={`btn ${f === field ? 'primary' : ''}`} disabled={!sel.size} onClick={() => void add(f)}>{f === 'to' ? 'An' : f === 'cc' ? 'Cc' : 'Bcc'} →</button>)}
      <button className="btn" onClick={onClose}>Fertig</button>
    </>}>
      <div className="abook">
        <div className="abook-sources">
          {SOURCES.filter(([id]) => data?.crm !== false || !['contacts', 'companies'].includes(id)).map(([id, label, ico]) => (
            <div key={id} className={`nav-item ${source === id ? 'active' : ''}`} onClick={() => setSource(id)}><span className="ico"><Icon name={ico} /></span>{label}</div>
          ))}
        </div>
        <div className="abook-list">
          <input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="abook-items">
            {groups.map((g) => (
              <label key={`g:${g.id}`} className="abook-row"><input type="checkbox" checked={sel.has(`g:${g.id}`)} onChange={() => toggle(`g:${g.id}`, g)} />
                <Icon name="users" /> <b>Gruppe {g.name}</b><span className="grow" /><span className="small muted">{g.count} Personen</span></label>
            ))}
            {entries.map((e) => (
              <label key={`${e.kind}:${e.email}`} className="abook-row"><input type="checkbox" checked={sel.has(`${e.kind}:${e.email}`)} onChange={() => toggle(`${e.kind}:${e.email}`, e)} />
                <span>{e.name}</span><span className="small muted">{e.detail}</span><span className="grow" /><span className="small">{e.email}</span></label>
            ))}
            {!groups.length && !entries.length && <Empty icon="id-card" title={data ? 'Nichts gefunden' : 'Lädt …'} />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

const SIG_ATTR = 'data-aperio-signature';
const sigBlock = (id: string, html: string) => `<div ${SIG_ATTR}="${id}">${html}</div>`;

export function Compose({ init, accounts, onClose, onSent }: { init: ComposeInit; accounts: MailAccount[]; onClose: () => void; onSent: (r: { queued?: boolean; message?: string; recipients: { name: string; email: string }[] }) => void }) {
  const act = useAction();
  const toast = useToast();
  const editor = useRef<HTMLDivElement>(null);
  const [accountId, setAccountId] = useState(init.accountId ?? accounts[0]!.id);
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]!;
  const [rc, setRc] = useState<Record<Field, Chip[]>>({ to: parseAddresses(init.to ?? ''), cc: parseAddresses(init.cc ?? ''), bcc: parseAddresses(init.bcc ?? '') });
  const [subject, setSubject] = useState(init.subject ?? '');
  const [showCc, setShowCc] = useState(Boolean(init.cc || init.bcc));
  const [atts, setAtts] = useState<{ name: string; path: string; size: number }[]>(init.attachments ?? []);
  const [draftId] = useState(() => init.draftId ?? crypto.randomUUID());
  const [clientKey] = useState(() => crypto.randomUUID());
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [sending, setSending] = useState(false);
  const [book, setBook] = useState<Field | null>(null);
  const [groupView, setGroupView] = useState<{ field: Field; index: number } | null>(null);
  const { data: sigs } = useApi<SignatureData>(`/mailbox/signatures?accountId=${accountId}`);
  const isReply = Boolean(init.replyOf || init.forwardOf);
  const sigInserted = useRef(false);
  const lastSaved = useRef('');

  useEffect(() => { if (editor.current) editor.current.innerHTML = `<br>${init.html ?? ''}`; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Signatur einmalig einfügen, sobald bekannt (bei Antworten über dem zitierten Text) – nicht bei Entwürfen
  useEffect(() => {
    if (!sigs || sigInserted.current || init.draftId || !editor.current) return;
    sigInserted.current = true;
    const s = resolveSignature(isReply ? account.sigReply : account.sigNew, sigs);
    if (!s) return;
    const first = editor.current.firstChild;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<br>${sigBlock(s.id, s.html)}`;
    for (const n of [...wrap.childNodes]) editor.current.insertBefore(n, first?.nextSibling ?? null);
  }, [sigs]); // eslint-disable-line react-hooks/exhaustive-deps

  const html = () => editor.current?.innerHTML ?? '';
  const snapshot = () => JSON.stringify({ accountId, to: chipsToString(rc.to), cc: chipsToString(rc.cc), bcc: chipsToString(rc.bcc), subject, html: html(), attachments: atts, replyOf: init.replyOf ?? null });
  const saveDraft = async (force = false) => {
    const snap = snapshot();
    if (!force && snap === lastSaved.current) return;
    lastSaved.current = snap;
    await put(`/mailbox/drafts/${draftId}`, JSON.parse(snap));
    setSaved(new Date().toISOString());
  };
  useEffect(() => { lastSaved.current = snapshot(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Entwurf alle 20 Sekunden still sichern – nur wenn sich etwas geändert hat
  useEffect(() => { const t = setInterval(() => { void saveDraft().catch(() => {}); }, 20000); return () => clearInterval(t); });

  const cmd = (c: string, v?: string) => { editor.current?.focus(); document.execCommand(c, false, v); };
  const insertSignature = (id: string, sigHtml: string) => {
    const el = editor.current;
    if (!el) return;
    const existing = el.querySelector(`[${SIG_ATTR}]`);
    if (existing) { existing.outerHTML = id === 'none' ? '' : sigBlock(id, sigHtml); return; }
    if (id === 'none') return;
    el.focus();
    document.execCommand('insertHTML', false, sigBlock(id, sigHtml));
  };
  const attach = async (files: FileList) => {
    const fd = new FormData(); for (const f of files) fd.append('file', f, f.name);
    const r = await act(() => upload('/mailbox/uploads', fd));
    if (r) setAtts([...atts, ...r]);
  };
  const recipients = chipsToString(rc.to);
  const send = async () => {
    if (sending) return;
    setSending(true);
    const r = await act(() => post<{ ok: boolean; queued?: boolean; message?: string; pending?: boolean }>('/mailbox/send', {
      accountId, clientKey, to: recipients, cc: chipsToString(rc.cc), bcc: chipsToString(rc.bcc), subject, html: html(), attachments: atts,
      replyOf: init.replyOf ?? null, forwardOf: init.forwardOf ?? null, draftId,
    }));
    setSending(false);
    if (r) onSent({ queued: r.queued, message: r.message, recipients: [...rc.to, ...rc.cc, ...rc.bcc].filter((c): c is Person => c.kind === 'person') });
  };
  const sigItems = useMemo(() => {
    if (!sigs) return [];
    const list: { id: string; name: string; html: string }[] = [];
    if (sigs.company) list.push({ id: 'company', name: 'Firmen-Signatur', html: sigs.company.rendered });
    if (sigs.company?.mode !== 'mandatory') list.push(...sigs.items.map((s) => ({ id: s.id, name: s.name, html: s.rendered })));
    return list;
  }, [sigs]);
  const group = groupView ? (rc[groupView.field][groupView.index] as Group | undefined) : undefined;
  const invalid = [...rc.to, ...rc.cc, ...rc.bcc].some((c) => c.kind === 'person' && !validEmail(c.email));

  return (
    <Modal size="lg" title={init.replyOf ? 'Antworten' : init.forwardOf ? 'Weiterleiten' : 'Neue E-Mail'} onClose={() => (sending ? undefined : setConfirmClose(true))} footer={<>
      <label className="btn ghost"><Icon name="paperclip" /> Anhang<input type="file" multiple hidden onChange={(e) => e.target.files && attach(e.target.files)} /></label>
      <span className="small muted">{saved ? `Entwurf gesichert ${fmtTime(saved)}` : ''}</span>
      <span className="grow" />
      <button className="btn" disabled={sending} onClick={() => setConfirmClose(true)}>Schließen</button>
      <button className="btn primary" disabled={!recipients || sending || invalid} title={invalid ? 'Eine Adresse ist ungültig (rot markiert)' : undefined} onClick={send}>
        <Icon name="send" /> {sending ? 'Wird gesendet …' : 'Senden'}
      </button>
    </>}>
      <div className="mb-compose-head">
        <label>Von</label>
        {accounts.length > 1
          ? <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{senderLine(a.displayName, a.email)}{a.label ? ` – ${a.label}` : ''}</option>)}</select>
          : <span className="small" title="So sehen Empfänger Sie">{senderLine(account.displayName, account.email)}</span>}
        <span />
        <button className="btn ghost sm rcpt-label" onClick={() => setBook('to')}>An …</button>
        <RecipientField chips={rc.to} onChange={(to) => setRc({ ...rc, to })} onBook={() => setBook('to')} autoFocus={!init.to} onGroup={(g) => setGroupView({ field: 'to', index: rc.to.indexOf(g) })} />
        {!showCc ? <button className="btn ghost sm" onClick={() => setShowCc(true)}>Cc/Bcc</button> : <span />}
        {showCc && <>
          <button className="btn ghost sm rcpt-label" onClick={() => setBook('cc')}>Cc …</button>
          <RecipientField chips={rc.cc} onChange={(cc) => setRc({ ...rc, cc })} onBook={() => setBook('cc')} onGroup={(g) => setGroupView({ field: 'cc', index: rc.cc.indexOf(g) })} /><span />
          <button className="btn ghost sm rcpt-label" onClick={() => setBook('bcc')}>Bcc …</button>
          <RecipientField chips={rc.bcc} onChange={(bcc) => setRc({ ...rc, bcc })} onBook={() => setBook('bcc')} onGroup={(g) => setGroupView({ field: 'bcc', index: rc.bcc.indexOf(g) })} /><span />
        </>}
        <label>Betreff</label><input value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus={Boolean(init.to)} /><span />
      </div>
      <div className="mb-format">
        <button className="btn ghost sm" title="Fett" onClick={() => cmd('bold')}><b>F</b></button>
        <button className="btn ghost sm" title="Kursiv" onClick={() => cmd('italic')}><i>K</i></button>
        <button className="btn ghost sm" title="Unterstrichen" onClick={() => cmd('underline')}><u>U</u></button>
        <button className="btn ghost sm" title="Aufzählung" onClick={() => cmd('insertUnorderedList')}><Icon name="list" /></button>
        <button className="btn ghost sm" title="Nummerierung" onClick={() => cmd('insertOrderedList')}>1.</button>
        <button className="btn ghost sm" title="Link" onClick={() => { const u = prompt('Adresse des Links'); if (u) cmd('createLink', u); }}><Icon name="link" /></button>
        <select onChange={(e) => { cmd('foreColor', e.target.value); e.target.value = ''; }} defaultValue="" style={{ width: 'auto' }}><option value="" disabled>Farbe</option><option value="#000000">Schwarz</option><option value="#c0392b">Rot</option><option value="#1d4ed8">Blau</option><option value="#15803d">Grün</option></select>
        <button className="btn ghost sm" title="Formatierung entfernen" onClick={() => cmd('removeFormat')}><Icon name="x" /></button>
        <span className="grow" />
        <Dropdown trigger={(t) => <button className="btn ghost sm" onClick={t} title="Signatur einfügen oder wechseln"><Icon name="signature" /> Signatur <Icon name="chevron-down" size={13} /></button>}>
          {(close) => <div style={{ minWidth: 220 }}>
            {!sigItems.length && <div className="item muted">Noch keine Signatur – im Postfach links unter „Signaturen“ anlegen.</div>}
            {sigItems.map((s) => <div key={s.id} className="item" onClick={() => { close(); insertSignature(s.id, s.html); }}><Icon name="signature" /> {s.name}</div>)}
            {sigItems.length > 0 && sigs?.company?.mode !== 'mandatory' && <div className="item" onClick={() => { close(); insertSignature('none', ''); }}><Icon name="x" /> Signatur entfernen</div>}
          </div>}
        </Dropdown>
      </div>
      <div ref={editor} className="mb-editor" contentEditable suppressContentEditableWarning />
      {(atts.length > 0 || init.forwardAttachments?.length) && (
        <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
          {init.forwardAttachments?.map((a) => <span key={a.name} className="pill small"><Icon name="paperclip" /> {a.name}</span>)}
          {atts.map((a, i) => <span key={a.path} className="pill small"><Icon name="paperclip" /> {a.name} {a.size ? fmtBytes(a.size) : ''} <button className="btn ghost sm" onClick={() => setAtts(atts.filter((_, j) => j !== i))}><Icon name="x" /></button></span>)}
        </div>
      )}
      {book && <AddressBook field={book} onClose={() => setBook(null)} onAdd={(f, chips) => { setRc((x) => ({ ...x, [f]: [...x[f], ...chips] })); if (f !== 'to') setShowCc(true); toast(`${chips.length} hinzugefügt`); }} />}
      {group && groupView && (
        <Modal title={`Gruppe ${group.name}`} onClose={() => setGroupView(null)} footer={<><span className="grow" />
          <button className="btn" onClick={() => { setRc((x) => ({ ...x, [groupView.field]: [...x[groupView.field].filter((_, i) => i !== groupView.index), ...group.members.filter((m) => !group.excluded.includes(m.email)).map((m) => ({ kind: 'person' as const, ...m }))] })); setGroupView(null); }}>In einzelne Adressen auflösen</button>
          <button className="btn primary" onClick={() => setGroupView(null)}>Fertig</button></>}>
          <p className="muted">Die Gruppe wird beim Senden in die einzelnen Adressen aufgelöst. Alle Empfänger sehen einander. Haken entfernen, um einzelne auszunehmen.</p>
          {group.members.map((m) => (
            <label key={m.email} className="row"><input type="checkbox" checked={!group.excluded.includes(m.email)} onChange={(e) => {
              const excluded = e.target.checked ? group.excluded.filter((x) => x !== m.email) : [...group.excluded, m.email];
              setRc((x) => ({ ...x, [groupView.field]: x[groupView.field].map((c, i) => (i === groupView.index ? { ...group, excluded } : c)) }));
            }} /> {m.name} <span className="small muted">{m.email}</span></label>
          ))}
        </Modal>
      )}
      {confirmClose && <Confirm text="Fenster schließen? Der Entwurf bleibt gespeichert." confirmLabel="Als Entwurf behalten" onClose={() => setConfirmClose(false)}
        onConfirm={async () => { await saveDraft(true).catch(() => {}); onClose(); }} />}
    </Modal>
  );
}
