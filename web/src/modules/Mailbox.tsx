import { View3DButton } from './View3D';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, post, invalidate } from '../lib/api';
import { useApi } from '../lib/hooks';
import { realtime } from '../lib/realtime';
import { useCan, useSession } from '../session';
import { fmtBytes, fmtDateTime, fmtTime } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { CustomerPicker } from './CrmShared';
import { Compose, type ComposeInit } from './mail/MailCompose';
import { AccountSettings, MailSetupWizard } from './mail/MailSetup';
import { SignatureManager } from './mail/MailSignatures';
import type { MailAccount } from './mail/types';

interface Folder { id: string; path: string; name: string; specialUse: string | null; total: number; unseen: number; localUnseen: number }
interface Item { id: string; folderId: string; from: string; to: string; subject: string; date: string; seen: boolean; flagged: boolean; answered: boolean; threadKey: string | null;
  attachmentCount: number; preview: string; projectId: string | null; projectNumber: string | null; crmAccountId: string | null; crmAccountName: string | null; direction: string }
interface OutboxItem { id: string; accountId: string; status: 'queued' | 'sending' | 'failed'; attempts: number; lastError: string | null; nextTryAt: string; createdAt: string; subject: string; to: string }
interface Draft { id: string; accountId: string; to: string; cc: string; bcc: string; subject: string; html: string; replyOf: string | null; attachments: { name: string; path: string; size: number }[]; updatedAt: string }

const FOLDER_ICON: Record<string, string> = { '\\Inbox': 'inbox', '\\Sent': 'send', '\\Drafts': 'edit', '\\Trash': 'trash', '\\Junk': 'ban', '\\Archive': 'archive' };
const nameOnly = (a: string) => (a.match(/^"?([^"<]+?)"?\s*</)?.[1] ?? a).trim();
const sameDay = (d: string) => new Date(d).toDateString() === new Date().toDateString();
const ACCOUNT_KEY = 'aperio-mail-account';
const readKey = () => { try { return localStorage.getItem(ACCOUNT_KEY); } catch { return null; } };
const writeKey = (v: string) => { try { localStorage.setItem(ACCOUNT_KEY, v); } catch { /* egal */ } };

/** Persönliche Postfächer im gewohnten Aufbau: Ordner links, Liste in der Mitte, Lesebereich rechts */
export function Mailbox() {
  const { data: accounts, reload } = useApi<MailAccount[]>('/mailbox/accounts');
  if (accounts === undefined) return null;
  if (!accounts.length) return <AccountSetup onDone={reload} />;
  return <MailboxView accounts={accounts} reloadAccounts={reload} />;
}

type Special = { kind: 'outbox' } | { kind: 'drafts' };

function MailboxView({ accounts, reloadAccounts }: { accounts: MailAccount[]; reloadAccounts: () => void }) {
  const act = useAction();
  const toast = useToast();
  const { me } = useSession();
  const [accountId, setAccountIdRaw] = useState<string>(() => { const k = readKey(); return accounts.some((a) => a.id === k) ? k! : accounts[0]!.id; });
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0]!;
  const setAccountId = (id: string) => { writeKey(id); setAccountIdRaw(id); setFolderId(null); setSpecial(null); setOpen(null); setSel(new Set()); };
  const { data: folders, reload: reloadFolders } = useApi<Folder[]>(`/mailbox/folders?accountId=${account.id}`);
  const { data: outbox, reload: reloadOutbox } = useApi<OutboxItem[]>(`/mailbox/outbox?accountId=${account.id}`);
  const { data: drafts, reload: reloadDrafts } = useApi<Draft[]>(`/mailbox/drafts?accountId=${account.id}`);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [special, setSpecial] = useState<Special | null>(null);
  const [q, setQ] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [threads, setThreads] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const [settings, setSettings] = useState(false);
  const [wizard, setWizard] = useState<'new' | 'fix' | null>(null);
  const [signatures, setSignatures] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [newContacts, setNewContacts] = useState<{ name: string; email: string }[] | null>(null);
  const can = useCan();
  const inbox = folders?.find((f) => f.specialUse === '\\Inbox') ?? folders?.[0];
  const current = special ? undefined : folders?.find((f) => f.id === folderId) ?? inbox;
  const url = current ? `/mailbox/messages?accountId=${account.id}&folderId=${current.id}${q ? `&q=${encodeURIComponent(q)}` : ''}${onlyUnread ? '&unread=1' : ''}` : null;
  const { data: list, reload } = useApi<Item[]>(url);
  useEffect(() => (me ? realtime.subscribe(`user:${me.id}`, (e, d) => {
    if (e === 'mailbox.changed') { void reload(); void reloadFolders(); if (d?.accountId !== account.id) reloadAccounts(); }
    if (e === 'notification') { void reloadOutbox(); }
  }) : undefined), [me, reload, reloadFolders, reloadOutbox, account.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (folders && !folders.length) void sync(); }, [folders?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const sync = async () => { setSyncing(true); await act(() => post('/mailbox/sync', { accountId: account.id })); setSyncing(false); void reloadFolders(); void reload(); reloadAccounts(); };
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
  const pick = (f: Folder | Special) => { if ('kind' in f) { setSpecial(f); setFolderId(null); } else { setSpecial(null); setFolderId(f.id); } setOpen(null); setSel(new Set()); };
  const sentDone = (r: { queued?: boolean; message?: string; recipients: { name: string; email: string }[] }) => {
    setCompose(null);
    if (can('crm') && r.recipients.length) void unknownRecipients(r.recipients).then((list) => { if (list.length) setNewContacts(list); });
    if (r.queued) toast(r.message ?? 'Die E-Mail liegt im Postausgang und wird automatisch nachgeschickt.', 'error');
    else toast('Gesendet');
    void reload(); void reloadFolders(); void reloadOutbox(); void reloadDrafts();
  };
  const outboxCount = outbox?.length ?? 0;

  return (
    <div className="mailbox">
      <aside className="mb-folders">
        <button className="btn primary" style={{ width: '100%', marginBottom: 10 }} onClick={() => setCompose({ accountId: account.id })}><Icon name="edit" /> Neue E-Mail</button>
        {accounts.length > 1 ? (
          <div className="mb-accounts">
            {accounts.map((a) => (
              <div key={a.id} className={`nav-item ${a.id === account.id ? 'active' : ''}`} onClick={() => setAccountId(a.id)} title={a.email}>
                <span className="ico"><Icon name={a.lastError ? 'alert' : 'mail'} /></span><span className="grow mb-acc-name">{a.label || a.email}</span>
                {(a.unseen ?? 0) > 0 && <span className="count">{a.unseen}</span>}
              </div>
            ))}
            <hr />
          </div>
        ) : <div className="small muted" style={{ padding: '0 6px 6px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={account.email}>{account.email}</div>}
        {folders?.map((f) => (
          <div key={f.id} className={`nav-item ${current?.id === f.id ? 'active' : ''}`} onClick={() => pick(f)}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const ids = e.dataTransfer.getData('text/x-mail-ids').split(',').filter(Boolean); void bulk('move', ids, f.id); }}
            style={{ paddingLeft: 8 + (f.path.split(/[./]/).length - 1) * 10 }}>
            <span className="ico"><Icon name={FOLDER_ICON[f.specialUse ?? ''] ?? 'folder'} /></span><span className="grow">{f.name}</span>
            {f.unseen > 0 && !['\\Sent', '\\Trash', '\\Drafts'].includes(f.specialUse ?? '') && <span className="count">{f.unseen}</span>}
          </div>
        ))}
        {(drafts?.length ?? 0) > 0 && <div className={`nav-item ${special?.kind === 'drafts' ? 'active' : ''}`} onClick={() => pick({ kind: 'drafts' })}><span className="ico"><Icon name="edit" /></span><span className="grow">Meine Entwürfe</span><span className="count">{drafts!.length}</span></div>}
        {outboxCount > 0 && <div className={`nav-item ${special?.kind === 'outbox' ? 'active' : ''}`} onClick={() => pick({ kind: 'outbox' })}><span className="ico"><Icon name="clock" /></span><span className="grow">Postausgang</span><span className="count warn">{outboxCount}</span></div>}
        <div className="mb-actions">
          <button className="btn ghost sm" onClick={sync} disabled={syncing}><Icon name="refresh" /> {syncing ? 'Ruft ab …' : 'Abrufen'}</button>
          <button className="btn ghost sm" onClick={() => setSettings(true)}><Icon name="settings" /> Konto</button>
          <button className="btn ghost sm" onClick={() => setSignatures(true)}><Icon name="signature" /> Signaturen</button>
          <button className="btn ghost sm" onClick={() => setWizard('new')}><Icon name="plus" /> Postfach hinzufügen</button>
        </div>
      </aside>
      <section className="mb-list">
        {account.lastError && (
          <div className="mb-problem"><Icon name="alert" /><span className="grow">{account.lastError}</span><button className="btn sm" onClick={() => setWizard('fix')}>Jetzt beheben</button></div>
        )}
        {special?.kind === 'outbox' ? <OutboxList items={outbox ?? []} onChanged={() => { void reloadOutbox(); void reloadDrafts(); }} />
          : special?.kind === 'drafts' ? <DraftList items={drafts ?? []} onOpen={(d) => setCompose({ draftId: d.id, accountId: d.accountId, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, html: d.html, replyOf: d.replyOf ?? undefined, attachments: d.attachments })} onChanged={reloadDrafts} />
          : <>
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
        </>}
      </section>
      <section className="mb-read">
        {open && !special ? <ReadingPane id={open} folders={folders ?? []} onCompose={(c) => setCompose({ ...c, accountId: account.id })} onAction={(a, f) => bulk(a, [open], f)} onChanged={() => void reload()} />
          : <Empty icon="mail" title={special?.kind === 'outbox' ? 'Postausgang' : special?.kind === 'drafts' ? 'Entwürfe' : 'Nachricht auswählen'}>
            {special?.kind === 'outbox' ? 'Diese E-Mails werden automatisch nachgeschickt, sobald der Server wieder erreichbar ist.' : special?.kind === 'drafts' ? 'Ein Klick öffnet den Entwurf zum Weiterschreiben.' : 'Ziehen Sie Nachrichten auf einen Ordner, um sie zu verschieben.'}
          </Empty>}
      </section>
      {compose && <Compose init={compose} accounts={accounts} onClose={() => { setCompose(null); void reloadDrafts(); }} onSent={sentDone} />}
      {settings && <AccountSettings account={account} onClose={() => setSettings(false)} onChanged={reloadAccounts} onSignatures={() => { setSettings(false); setSignatures(true); }} />}
      {signatures && <SignatureManager onClose={() => setSignatures(false)} />}
      {newContacts && <CrmSuggest people={newContacts} onClose={() => setNewContacts(null)} />}
      {wizard && <MailSetupWizard account={wizard === 'fix' ? account : null} hasAccounts onClose={() => setWizard(null)} onDone={(a) => { setWizard(null); reloadAccounts(); if (wizard === 'new') setAccountId(a.id); }} />}
    </div>
  );
}

/** Empfänger, die weder im CRM noch unter den Mitarbeitern stehen (höchstens fünf werden geprüft) */
async function unknownRecipients(list: { name: string; email: string }[]) {
  const out: { name: string; email: string }[] = [];
  for (const p of list.slice(0, 5)) {
    const r = await get<{ entries: { email: string; kind: string }[] }>(`/mailbox/addressbook?q=${encodeURIComponent(p.email)}&limit=5`).catch(() => null);
    if (r && !r.entries.some((e) => e.kind !== 'recent' && e.email.toLowerCase() === p.email.toLowerCase())) out.push(p);
  }
  return out;
}

/** Nach dem Senden: neue Adressen als Kontakt ins CRM übernehmen */
function CrmSuggest({ people, onClose }: { people: { name: string; email: string }[]; onClose: () => void }) {
  const act = useAction();
  const [rows, setRows] = useState(people.map((p) => {
    const parts = (p.name && p.name !== p.email ? p.name : '').trim().split(/\s+/);
    return { ...p, take: true, firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : '', lastName: parts.length > 1 ? parts.at(-1)! : parts[0] ?? '', company: null as { id: string; name: string } | null };
  }));
  const ok = rows.filter((r) => r.take).every((r) => r.company && r.lastName.trim());
  return (
    <Modal size="lg" title="Neue Adressen ins CRM übernehmen?" onClose={onClose} footer={<>
      <span className="grow" /><button className="btn" onClick={onClose}>Nein, danke</button>
      <button className="btn primary" disabled={!rows.some((r) => r.take) || !ok} onClick={async () => {
        for (const r of rows.filter((x) => x.take)) await act(() => post(`/crm/accounts/${r.company!.id}/contacts`, { firstName: r.firstName.trim(), lastName: r.lastName.trim() || r.email, email: r.email }));
        onClose();
      }}>Als Kontakte anlegen</button>
    </>}>
      <p className="muted">An diese Adressen haben Sie gerade geschrieben – sie stehen noch nicht im CRM.</p>
      {rows.map((r, i) => (
        <div key={r.email} className="card flat" style={{ marginBottom: 8 }}>
          <label className="row"><input type="checkbox" checked={r.take} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, take: e.target.checked } : x)))} /> <b>{r.email}</b></label>
          {r.take && <div className="grid3" style={{ marginTop: 6 }}>
            <Field label="Vorname"><input value={r.firstName} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, firstName: e.target.value } : x)))} /></Field>
            <Field label="Nachname" required><input value={r.lastName} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, lastName: e.target.value } : x)))} /></Field>
            <Field label="Firma" required><CustomerPicker value={r.company} onChange={(c) => setRows(rows.map((x, j) => (j === i ? { ...x, company: c } : x)))} /></Field>
          </div>}
        </div>
      ))}
    </Modal>
  );
}

function OutboxList({ items, onChanged }: { items: OutboxItem[]; onChanged: () => void }) {
  const act = useAction();
  return (
    <div className="mb-items">
      <div className="mb-toolbar small muted">Wartet auf den Versand – wird automatisch erneut versucht.</div>
      {items.map((o) => (
        <div key={o.id} className="mb-item">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 6 }}><span className="mb-from">An: {nameOnly(o.to)}</span><span className="grow" />
              <Pill tone={o.status === 'failed' ? 'red' : 'amber'}>{o.status === 'failed' ? 'fehlgeschlagen' : o.status === 'sending' ? 'wird gesendet' : `nächster Versuch ${fmtTime(o.nextTryAt)}`}</Pill></div>
            <div className="mb-subject">{o.subject || '(kein Betreff)'}</div>
            {o.lastError && <div className="small muted">{o.lastError} · {o.attempts} Versuch{o.attempts === 1 ? '' : 'e'}</div>}
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <button className="btn sm" disabled={o.status === 'sending'} onClick={async () => { const r = await act(() => post<{ ok: boolean; error?: string }>(`/mailbox/outbox/${o.id}/retry`)); if (r) { if (!r.ok && r.error) alertLike(r.error); onChanged(); } }}><Icon name="send" /> Jetzt senden</button>
              <button className="btn sm ghost" disabled={o.status === 'sending'} onClick={async () => { if (await act(() => del(`/mailbox/outbox/${o.id}`), 'Zurück in den Entwürfen')) onChanged(); }}><Icon name="edit" /> Zurück in die Entwürfe</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
const alertLike = (msg: string) => window.dispatchEvent(new CustomEvent('aperio:warning', { detail: msg }));

function DraftList({ items, onOpen, onChanged }: { items: Draft[]; onOpen: (d: Draft) => void; onChanged: () => void }) {
  const act = useAction();
  const [remove, setRemove] = useState<string | null>(null);
  return (
    <div className="mb-items">
      {items.map((d) => (
        <div key={d.id} className="mb-item" onClick={() => onOpen(d)}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 6 }}><span className="mb-from">{d.to ? `An: ${nameOnly(d.to)}` : '(noch kein Empfänger)'}</span><span className="grow" /><span className="small muted">{fmtDateTime(d.updatedAt)}</span>
              <button className="btn ghost sm" title="Entwurf löschen" onClick={(e) => { e.stopPropagation(); setRemove(d.id); }}><Icon name="trash" /></button></div>
            <div className="mb-subject">{d.subject || '(kein Betreff)'}</div>
          </div>
        </div>
      ))}
      {remove && <Confirm danger text="Entwurf löschen?" onClose={() => setRemove(null)} onConfirm={async () => { if (await act(() => del(`/mailbox/drafts/${remove}`))) { setRemove(null); onChanged(); } }} />}
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

// ---------------------------------------------------------------- Erstes Konto einrichten
function AccountSetup({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="page"><Empty icon="mail" title="Ihr Postfach in AperioPlan">
      Der Assistent führt Sie Schritt für Schritt durch die Einrichtung – für alle gängigen Anbieter (z. B. netcup, IONOS, Strato, GMX, Gmail, Microsoft 365) und eigene Server – und prüft alles mit einer Test-E-Mail.
      Danach lesen und schreiben Sie E-Mails hier und ordnen sie mit einem Klick Projekten und Kunden zu.
      <div style={{ marginTop: 12 }}><button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" /> E-Mail-Konto einrichten</button></div>
    </Empty>
    {open && <MailSetupWizard onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone(); }} />}</div>
  );
}

