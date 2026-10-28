import { View3DButton } from './View3D';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, post, put, upload, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtBytes, fmtDateTime, fmtTime } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { CustomerPicker } from './CrmShared';

interface Folder { id: string; path: string; name: string; specialUse: string | null; total: number; unseen: number; localUnseen: number }
interface Item { id: string; folderId: string; from: string; to: string; subject: string; date: string; seen: boolean; flagged: boolean; answered: boolean; threadKey: string | null;
  attachmentCount: number; preview: string; projectId: string | null; projectNumber: string | null; crmAccountId: string | null; crmAccountName: string | null; direction: string }

const FOLDER_ICON: Record<string, string> = { '\\Inbox': 'inbox', '\\Sent': 'send', '\\Drafts': 'edit', '\\Trash': 'trash', '\\Junk': 'ban', '\\Archive': 'archive' };
const nameOnly = (a: string) => (a.match(/^"?([^"<]+?)"?\s*</)?.[1] ?? a).trim();
const sameDay = (d: string) => new Date(d).toDateString() === new Date().toDateString();

/** Persönliches Postfach im gewohnten Aufbau: Ordner links, Liste in der Mitte, Lesebereich rechts */
export function Mailbox() {
  const { data: account, reload: reloadAccount } = useApi<any>('/mailbox/account');
  if (account === undefined) return null;
  if (!account) return <AccountSetup onDone={reloadAccount} />;
  return <MailboxView account={account} onSettings={reloadAccount} />;
}

function MailboxView({ account, onSettings }: { account: any; onSettings: () => void }) {
  const act = useAction();
  const toast = useToast();
  const { me } = useSession();
  const { data: folders, reload: reloadFolders } = useApi<Folder[]>('/mailbox/folders');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [threads, setThreads] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const [settings, setSettings] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const inbox = folders?.find((f) => f.specialUse === '\\Inbox') ?? folders?.[0];
  const current = folders?.find((f) => f.id === folderId) ?? inbox;
  const url = current ? `/mailbox/messages?folderId=${current.id}${q ? `&q=${encodeURIComponent(q)}` : ''}${onlyUnread ? '&unread=1' : ''}` : null;
  const { data: list, reload } = useApi<Item[]>(url);
  useEffect(() => (me ? realtime.subscribe(`user:${me.id}`, (e) => { if (e === 'mailbox.changed') { void reload(); void reloadFolders(); } }) : undefined), [me, reload, reloadFolders]);
  useEffect(() => { if (folders && !folders.length) void sync(); }, [folders?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const sync = async () => { setSyncing(true); await act(() => post('/mailbox/sync', {})); setSyncing(false); void reloadFolders(); void reload(); };
  const bulk = async (action: string, ids = [...sel], folder?: string) => {
    if (!ids.length) return;
    await act(() => post('/mailbox/messages/bulk', { ids, action, folderId: folder }));
    setSel(new Set()); if (action === 'delete' || action === 'move') setOpen(null);
    void reload(); void reloadFolders();
  };
  // Unterhaltungen: Nachrichten mit gleichem Schlüssel zusammenfassen, neueste oben
  const rows = useMemo(() => {
    if (!list) return [];
    if (!threads || q) return list.map((m) => ({ m, count: 1, unread: !m.seen }));
    const groups = new Map<string, Item[]>();
    for (const m of list) { const k = m.threadKey ?? m.id; groups.set(k, [...(groups.get(k) ?? []), m]); }
    return [...groups.values()].map((g) => ({ m: g[0]!, count: g.length, unread: g.some((x) => !x.seen) }));
  }, [list, threads, q]);

  return (
    <div className="mailbox">
      <aside className="mb-folders">
        <button className="btn primary" style={{ width: '100%', marginBottom: 10 }} onClick={() => setCompose({})}><Icon name="edit" /> Neue E-Mail</button>
        <div className="small muted" style={{ padding: '0 6px 6px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={account.email}>{account.email}</div>
        {folders?.map((f) => (
          <div key={f.id} className={`nav-item ${current?.id === f.id ? 'active' : ''}`} onClick={() => { setFolderId(f.id); setOpen(null); setSel(new Set()); }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const ids = e.dataTransfer.getData('text/x-mail-ids').split(',').filter(Boolean); void bulk('move', ids, f.id); }}
            style={{ paddingLeft: 8 + (f.path.split(/[./]/).length - 1) * 10 }}>
            <span className="ico"><Icon name={FOLDER_ICON[f.specialUse ?? ''] ?? 'folder'} /></span><span className="grow">{f.name}</span>
            {f.unseen > 0 && f.specialUse !== '\\Sent' && <span className="count">{f.unseen}</span>}
          </div>
        ))}
        <div style={{ marginTop: 12 }}>
          <button className="btn ghost sm" onClick={sync} disabled={syncing}><Icon name="refresh" /> {syncing ? 'Ruft ab …' : 'Abrufen'}</button>
          <button className="btn ghost sm" onClick={() => setSettings(true)}><Icon name="settings" /> Konto</button>
        </div>
        {account.lastError && <div className="error-text small" style={{ padding: 6 }}>Letzter Abruf: {account.lastError}</div>}
      </aside>
      <section className="mb-list">
        <div className="mb-toolbar">
          <input placeholder={`In allen Ordnern suchen …`} value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="row small" title="Nur ungelesene"><input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} /> ungelesen</label>
          <label className="row small" title="Nachrichten einer Unterhaltung zusammenfassen"><input type="checkbox" checked={threads} onChange={(e) => setThreads(e.target.checked)} /> Unterhaltungen</label>
        </div>
        {sel.size > 0 && (
          <div className="mb-toolbar">
            <span className="small">{sel.size} markiert</span>
            <button className="btn sm" onClick={() => bulk('seen')}>gelesen</button>
            <button className="btn sm" onClick={() => bulk('unseen')}>ungelesen</button>
            <button className="btn sm" onClick={() => bulk('flag')}><Icon name="flag" /></button>
            <select value="" onChange={(e) => e.target.value && bulk('move', [...sel], e.target.value)} style={{ width: 'auto' }}><option value="">Verschieben …</option>{folders?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
            <button className="btn sm danger" onClick={() => bulk('delete')}><Icon name="trash" /></button>
          </div>
        )}
        <div className="mb-items">
          {!rows.length && <Empty icon="mail" title={q ? 'Nichts gefunden' : 'Keine Nachrichten'} />}
          {rows.map(({ m, count, unread }) => (
            <div key={m.id} className={`mb-item ${open === m.id ? 'active' : ''} ${unread ? 'unread' : ''}`} draggable
              onDragStart={(e) => e.dataTransfer.setData('text/x-mail-ids', (sel.has(m.id) ? [...sel] : [m.id]).join(','))}
              onClick={() => setOpen(m.id)}>
              <input type="checkbox" checked={sel.has(m.id)} onClick={(e) => e.stopPropagation()} onChange={() => { const n = new Set(sel); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); setSel(n); }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="mb-from">{current?.specialUse === '\\Sent' || m.direction === 'out' ? `An: ${nameOnly(m.to)}` : nameOnly(m.from)}</span>
                  {count > 1 && <span className="pill small">{count}</span>}
                  <span className="grow" />
                  {m.attachmentCount > 0 && <Icon name="paperclip" />}
                  {m.answered && <Icon name="undo" />}
                  <button className={`btn ghost sm flag ${m.flagged ? 'on' : ''}`} title="Kennzeichnen" onClick={(e) => { e.stopPropagation(); void bulk(m.flagged ? 'unflag' : 'flag', [m.id]); }}><Icon name="flag" /></button>
                  <span className="small muted">{sameDay(m.date) ? fmtTime(m.date) : new Date(m.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</span>
                </div>
                <div className="mb-subject">{m.subject || '(kein Betreff)'}</div>
                <div className="small muted mb-preview">{m.preview}</div>
                {(m.projectNumber || m.crmAccountName) && <div className="row" style={{ gap: 4, marginTop: 2 }}>{m.projectNumber && <Pill tone="accent">{m.projectNumber}</Pill>}{m.crmAccountName && <Pill>{m.crmAccountName}</Pill>}</div>}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="mb-read">
        {open ? <ReadingPane id={open} folders={folders ?? []} onCompose={setCompose} onAction={(a, f) => bulk(a, [open], f)} onChanged={() => void reload()} />
          : <Empty icon="mail" title="Nachricht auswählen">Ziehen Sie Nachrichten auf einen Ordner, um sie zu verschieben.</Empty>}
      </section>
      {compose && <Compose init={compose} account={account} onClose={() => setCompose(null)} onSent={() => { setCompose(null); toast('Gesendet'); void reload(); void reloadFolders(); }} />}
      {settings && <AccountModal account={account} onClose={() => setSettings(false)} onSaved={() => { setSettings(false); onSettings(); }} />}
    </div>
  );
}

/** HTML der Nachricht sicher anzeigen: ohne Skripte; Bilder aus dem Internet erst auf Klick */
function MailHtml({ html, messageId, attachments }: { html: string; messageId: string; attachments: { index: number; cid: string | null }[] }) {
  const [remote, setRemote] = useState(false);
  const hasRemote = /<img[^>]+src=["']?https?:/i.test(html);
  let doc = html.replace(/cid:([^"'\s)>]+)/gi, (m, cid) => { const a = attachments.find((x) => x.cid && x.cid.replace(/[<>]/g, '') === cid); return a ? `/api/mailbox/messages/${messageId}/attachments/${a.index}?inline=1` : m; });
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:${remote ? ' https: http:' : ''}; style-src 'unsafe-inline' ${remote ? 'https:' : ''}; font-src data:">`;
  doc = `<!doctype html><html><head>${csp}<base target="_blank"><style>body{font-family:system-ui,sans-serif;font-size:14px;margin:12px;color:#111;background:#fff}</style></head><body>${doc}</body></html>`;
  return (
    <>
      {hasRemote && !remote && <div className="small muted" style={{ marginBottom: 6 }}><Icon name="shield" /> Bilder aus dem Internet wurden zum Schutz nicht geladen. <button className="btn sm ghost" onClick={() => setRemote(true)}>Bilder laden</button></div>}
      <iframe title="Nachricht" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin" srcDoc={doc} className="mb-frame" />
    </>
  );
}

function ReadingPane({ id, folders, onCompose, onAction, onChanged }: { id: string; folders: Folder[]; onCompose: (c: ComposeInit) => void; onAction: (a: string, folder?: string) => void; onChanged: () => void }) {
  const { data: m, reload } = useApi<any>(`/mailbox/messages/${id}`);
  const [assign, setAssign] = useState(false);
  const [task, setTask] = useState(false);
  useEffect(() => { if (m) { onChanged(); invalidate('/mailbox/folders'); } }, [m?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return null;
  const quote = `<br><br><div style="border-left:2px solid #ccc;padding-left:8px;color:#555">Am ${fmtDateTime(m.date)} schrieb ${m.from.replace(/</g, '&lt;')}:<br>${m.html ? m.html.replace(/<\/?(html|head|body)[^>]*>/gi, '') : (m.text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</div>`;
  const re = (s: string) => (/^(re|aw):/i.test(s) ? s : `AW: ${s}`);
  const archive = folders.find((f) => f.specialUse === '\\Archive');
  return (
    <div className="mb-pane">
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <button className="btn sm" onClick={() => onCompose({ to: m.from, subject: re(m.subject), html: quote, replyOf: m.id })}><Icon name="undo" /> Antworten</button>
        <button className="btn sm" onClick={() => onCompose({ to: [m.from, ...m.to.split(',')].filter(Boolean).join(', '), cc: m.cc, subject: re(m.subject), html: quote, replyOf: m.id, replyAll: true })}><Icon name="users" /> Allen antworten</button>
        <button className="btn sm" onClick={() => onCompose({ subject: /^(wg|fw):/i.test(m.subject) ? m.subject : `WG: ${m.subject}`, html: quote, forwardOf: m.id, forwardAttachments: m.attachments })}><Icon name="arrow-right" /> Weiterleiten</button>
        <span className="grow" />
        <button className="btn sm" onClick={() => setAssign(true)} title="Einem Projekt oder Kunden zuordnen"><Icon name="link" /> Zuordnen</button>
        <button className="btn sm" onClick={() => setTask(true)}><Icon name="check-circle" /> Aufgabe</button>
        {archive && <button className="btn sm ghost" title="Archivieren" onClick={() => onAction('move', archive.id)}><Icon name="archive" /></button>}
        <button className="btn sm ghost" title="Ungelesen" onClick={() => onAction('unseen')}><Icon name="mail" /></button>
        <button className="btn sm ghost danger" title="Löschen" onClick={() => onAction('delete')}><Icon name="trash" /></button>
      </div>
      <h2 style={{ margin: '0 0 6px' }}>{m.subject || '(kein Betreff)'}</h2>
      <div className="small"><b>{m.from}</b></div>
      <div className="small muted">An: {m.to}{m.cc ? ` · Cc: ${m.cc}` : ''} · {fmtDateTime(m.date)}</div>
      {(m.projectNumber) && <div style={{ marginTop: 6 }}><Link to={`/projects/${m.projectId}`}><Pill tone="accent">{m.projectNumber} {m.projectName}</Pill></Link></div>}
      {m.thread.length > 1 && (
        <details className="small" style={{ margin: '8px 0' }}><summary>{m.thread.length} Nachrichten in dieser Unterhaltung</summary>
          {m.thread.map((t: any) => <div key={t.id} style={{ padding: '2px 0', fontWeight: t.id === m.id ? 600 : undefined }}>{fmtDateTime(t.date)} · {nameOnly(t.from)} · <span className="muted">{t.folder}</span></div>)}
        </details>
      )}
      {m.attachments.filter((a: any) => !a.cid || !m.html?.includes(a.cid.replace(/[<>]/g, ''))).length > 0 && (
        <div className="row wrap" style={{ margin: '10px 0', gap: 6 }}>
          {m.attachments.map((a: any) => <span key={a.index} className="row" style={{ gap: 2 }}><a className="card row" style={{ padding: '5px 10px' }} href={`/api/mailbox/messages/${m.id}/attachments/${a.index}`}><Icon name="paperclip" /> {a.name} <span className="small muted">{fmtBytes(a.size)}</span></a><View3DButton url={`/api/mailbox/messages/${m.id}/attachments/${a.index}`} name={a.name} /></span>)}
        </div>
      )}
      <div style={{ marginTop: 10 }}>{m.html ? <MailHtml html={m.html} messageId={m.id} attachments={m.attachments} /> : <pre className="mb-text">{m.text}</pre>}</div>
      {assign && <AssignModal m={m} onClose={() => setAssign(false)} onDone={() => { setAssign(false); void reload(); onChanged(); }} />}
      {task && <TaskModal m={m} onClose={() => setTask(false)} onDone={() => setTask(false)} />}
    </div>
  );
}

function AssignModal({ m, onClose, onDone }: { m: any; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const { data: projects } = useApi<any[]>('/projects');
  const [projectId, setProjectId] = useState<string>(m.projectId ?? '');
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [files, setFiles] = useState<number[]>(m.attachments.map((a: any) => a.index));
  const [folder, setFolder] = useState('03_Doku/Mail');
  return (
    <Modal title="E-Mail zuordnen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" onClick={async () => {
        const r = await act(() => post<{ saved: number }>(`/mailbox/messages/${m.id}/assign`, { projectId: projectId || null, ...(customer ? { crmAccountId: customer.id } : {}), saveAttachments: projectId ? files : [], folder }));
        if (r) onDone();
      }}>Zuordnen</button></>}>
      <Field label="Projekt"><select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">–</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></Field>
      {projectId && m.attachments.length > 0 && <Field label="Anhänge im Projektordner ablegen">
        {m.attachments.map((a: any) => <label key={a.index} className="row small"><input type="checkbox" checked={files.includes(a.index)} onChange={() => setFiles(files.includes(a.index) ? files.filter((x) => x !== a.index) : [...files, a.index])} />{a.name}</label>)}
        <input value={folder} onChange={(e) => setFolder(e.target.value)} style={{ marginTop: 6 }} title="Unterordner im Projekt" />
      </Field>}
      <Field label="Kunde (CRM)" hint="erscheint dann im Verlauf des Kunden"><CustomerPicker value={customer} onChange={setCustomer} /></Field>
    </Modal>
  );
}

function TaskModal({ m, onClose, onDone }: { m: any; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const { users } = useSession();
  const { data: projects } = useApi<any[]>('/projects');
  const [d, setD] = useState({ projectId: m.projectId ?? '', title: m.subject.replace(/^(re|aw|wg|fw):\s*/i, ''), assigneeId: '', dueDate: '' });
  return (
    <Modal title="Aufgabe aus E-Mail" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!d.projectId || !d.title.trim()} onClick={async () => { if (await act(() => post(`/mailbox/messages/${m.id}/task`, { ...d, assigneeId: d.assigneeId || null, dueDate: d.dueDate || null }), 'Aufgabe angelegt')) onDone(); }}>Anlegen</button></>}>
      <Field label="Projekt" required><select value={d.projectId} onChange={(e) => setD({ ...d, projectId: e.target.value })}><option value="">bitte wählen</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></Field>
      <Field label="Titel" required><input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
      <div className="grid2">
        <Field label="Bearbeiter"><select value={d.assigneeId} onChange={(e) => setD({ ...d, assigneeId: e.target.value })}><option value="">–</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></Field>
        <Field label="Frist"><input type="date" value={d.dueDate} onChange={(e) => setD({ ...d, dueDate: e.target.value })} /></Field>
      </div>
      <div className="hint">Der Text der E-Mail wird in die Beschreibung übernommen.</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Verfassen
interface ComposeInit { to?: string; cc?: string; subject?: string; html?: string; replyOf?: string; replyAll?: boolean; forwardOf?: string; forwardAttachments?: { name: string; size: number }[]; draftId?: string }

function Compose({ init, account, onClose, onSent }: { init: ComposeInit; account: any; onClose: () => void; onSent: () => void }) {
  const act = useAction();
  const editor = useRef<HTMLDivElement>(null);
  const [d, setD] = useState({ to: init.to ?? '', cc: init.cc ?? '', bcc: '', subject: init.subject ?? '' });
  const [showCc, setShowCc] = useState(Boolean(init.cc));
  const [atts, setAtts] = useState<{ name: string; path: string; size: number }[]>([]);
  const [draftId] = useState(() => init.draftId ?? crypto.randomUUID());
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const sig = account.signatureHtml ? `<br><br>-- <br>${account.signatureHtml}` : '';
  useEffect(() => { if (editor.current) editor.current.innerHTML = `<br>${sig}${init.html ?? ''}`; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const html = () => editor.current?.innerHTML ?? '';
  // Entwurf automatisch alle 20 Sekunden sichern
  useEffect(() => {
    const t = setInterval(() => { void put(`/mailbox/drafts/${draftId}`, { ...d, html: html(), attachments: atts, replyOf: init.replyOf ?? null }).then(() => setSaved(new Date().toISOString())).catch(() => {}); }, 20000);
    return () => clearInterval(t);
  }, [d, atts]); // eslint-disable-line react-hooks/exhaustive-deps
  const cmd = (c: string, v?: string) => { document.execCommand(c, false, v); editor.current?.focus(); };
  const attach = async (files: FileList) => {
    const fd = new FormData(); for (const f of files) fd.append('file', f, f.name);
    const r = await act(() => upload('/mailbox/uploads', fd));
    if (r) setAtts([...atts, ...r]);
  };
  const send = async () => {
    const r = await act(() => post('/mailbox/send', { ...d, html: html(), attachments: atts, replyOf: init.replyOf ?? null, forwardOf: init.forwardOf ?? null, draftId }));
    if (r) onSent();
  };
  return (
    <Modal size="lg" title={init.replyOf ? 'Antworten' : init.forwardOf ? 'Weiterleiten' : 'Neue E-Mail'} onClose={() => setConfirmClose(true)} footer={<>
      <label className="btn ghost"><Icon name="paperclip" /> Anhang<input type="file" multiple hidden onChange={(e) => e.target.files && attach(e.target.files)} /></label>
      <span className="small muted">{saved ? `Entwurf gesichert ${fmtTime(saved)}` : ''}</span>
      <span className="grow" />
      <button className="btn" onClick={() => setConfirmClose(true)}>Schließen</button>
      <button className="btn primary" disabled={!d.to.trim()} onClick={send}><Icon name="send" /> Senden</button>
    </>}>
      <div className="mb-compose-head">
        <label>An</label><input value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} placeholder="name@firma.de, …" autoFocus={!init.to} />
        {!showCc && <button className="btn ghost sm" onClick={() => setShowCc(true)}>Cc/Bcc</button>}
        {showCc && <><label>Cc</label><input value={d.cc} onChange={(e) => setD({ ...d, cc: e.target.value })} /><label>Bcc</label><input value={d.bcc} onChange={(e) => setD({ ...d, bcc: e.target.value })} /></>}
        <label>Betreff</label><input value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} autoFocus={Boolean(init.to)} />
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
      </div>
      <div ref={editor} className="mb-editor" contentEditable suppressContentEditableWarning />
      {(atts.length > 0 || init.forwardAttachments?.length) && (
        <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
          {init.forwardAttachments?.map((a) => <span key={a.name} className="pill small"><Icon name="paperclip" /> {a.name}</span>)}
          {atts.map((a, i) => <span key={a.path} className="pill small"><Icon name="paperclip" /> {a.name} {fmtBytes(a.size)} <button className="btn ghost sm" onClick={() => setAtts(atts.filter((_, j) => j !== i))}><Icon name="x" /></button></span>)}
        </div>
      )}
      {confirmClose && <Confirm text="Fenster schließen? Der Entwurf bleibt gespeichert." confirmLabel="Als Entwurf behalten" onClose={() => setConfirmClose(false)}
        onConfirm={async () => { await put(`/mailbox/drafts/${draftId}`, { ...d, html: html(), attachments: atts, replyOf: init.replyOf ?? null }).catch(() => {}); onClose(); }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Konto einrichten
function AccountSetup({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="page"><Empty icon="mail" title="Ihr Firmen-Postfach in AperioPlan">
      Hinterlegen Sie Ihre Firmen-E-Mail-Adresse (IMAP/SMTP). Danach lesen und schreiben Sie E-Mails hier – und ordnen sie mit einem Klick Projekten und Kunden zu.
      <div style={{ marginTop: 12 }}><button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" /> E-Mail-Konto einrichten</button></div>
    </Empty>
    {open && <AccountModal account={null} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onDone(); }} />}</div>
  );
}

function AccountModal({ account, onClose, onSaved }: { account: any; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const toast = useToast();
  const { me } = useSession();
  const [a, setA] = useState<any>(account ?? { email: me?.email ?? '', displayName: me?.displayName ?? '', imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 587, smtpSecure: false, username: me?.email ?? '', signatureHtml: '' });
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState(false);
  const preset = async () => {
    if (!a.email.includes('@')) return;
    const p = await get(`/mailbox/preset?email=${encodeURIComponent(a.email)}`).catch(() => null);
    if (p && !a.imapHost) setA({ ...a, ...p, username: a.username || a.email });
  };
  const n = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setA({ ...a, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal size="lg" title={account ? 'E-Mail-Konto' : 'E-Mail-Konto einrichten'} onClose={onClose} footer={<>
      {account && <button className="btn danger" onClick={() => setRemove(true)}>Konto entfernen</button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={busy || !a.email || !a.imapHost || !a.smtpHost || (!account && !pw)} onClick={async () => {
        setBusy(true);
        const r = await act(() => put<{ message: string }>('/mailbox/account', { ...a, ...(pw ? { password: pw } : {}) }));
        setBusy(false);
        if (r) { toast(r.message); onSaved(); }
      }}>{busy ? 'Prüfe Verbindung …' : 'Speichern und prüfen'}</button></>}>
      <div className="grid2">
        <Field label="E-Mail-Adresse" required><input value={a.email} onChange={n('email')} onBlur={preset} /></Field>
        <Field label="Anzeigename"><input value={a.displayName} onChange={n('displayName')} /></Field>
        <Field label="Benutzername" hint="meist die E-Mail-Adresse"><input value={a.username} onChange={n('username')} autoComplete="off" /></Field>
        <Field label={account ? 'Passwort (leer = unverändert)' : 'Passwort'} required={!account}><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
      </div>
      <h3>Posteingang (IMAP)</h3>
      <div className="grid2" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
        <Field label="Server"><input value={a.imapHost} onChange={n('imapHost')} placeholder="imap.firma.de" /></Field>
        <Field label="Port"><input type="number" value={a.imapPort} onChange={n('imapPort')} /></Field>
        <Field label="Verschlüsselung"><label className="row"><input type="checkbox" checked={a.imapSecure} onChange={n('imapSecure')} /> SSL/TLS</label></Field>
      </div>
      <h3>Postausgang (SMTP)</h3>
      <div className="grid2" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
        <Field label="Server"><input value={a.smtpHost} onChange={n('smtpHost')} placeholder="smtp.firma.de" /></Field>
        <Field label="Port" hint="587 = STARTTLS, 465 = SSL"><input type="number" value={a.smtpPort} onChange={n('smtpPort')} /></Field>
        <Field label="Verschlüsselung"><label className="row"><input type="checkbox" checked={a.smtpSecure} onChange={n('smtpSecure')} /> SSL/TLS (Port 465)</label></Field>
      </div>
      <Field label="Signatur" hint="erscheint unter neuen E-Mails"><SignatureEditor value={a.signatureHtml} onChange={(signatureHtml) => setA({ ...a, signatureHtml })} /></Field>
      <div className="hint">Das Passwort wird verschlüsselt gespeichert. Bei Google oder Microsoft ggf. ein App-Passwort verwenden.</div>
      {remove && <Confirm danger text="Konto entfernen? Die zwischengespeicherten Nachrichten werden gelöscht; im Postfach selbst bleibt alles erhalten. Projekten zugeordnete E-Mails bleiben im Projekt." onClose={() => setRemove(false)}
        onConfirm={async () => { if (await act(() => del('/mailbox/account'), 'Konto entfernt')) onSaved(); }} />}
    </Modal>
  );
}

function SignatureEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={ref} className="mb-editor" style={{ minHeight: 70 }} contentEditable suppressContentEditableWarning onInput={() => onChange(ref.current?.innerHTML ?? '')} />;
}
