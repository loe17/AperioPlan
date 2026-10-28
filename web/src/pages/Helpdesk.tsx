import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, get, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useCan, useSession } from '../session';
import { fmtDateTime } from '../lib/format';
import { Empty, Field, Modal, Pill, SlideOver, Tabs, UserSelect, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { CustomerPicker } from '../modules/CrmShared';
import { useAdminSettings } from './Settings';
import { NewJob } from './Service';

type Tab = 'tickets' | 'canned' | 'settings';
export const HD_STATUS: Record<string, [string, string]> = { new: ['neu', 'red'], open: ['offen', 'blue'], waiting: ['wartet auf Kunde', 'amber'], solved: ['gelöst', 'green'], closed: ['geschlossen', ''] };
const PRIO: Record<string, [string, string]> = { low: ['niedrig', ''], normal: ['normal', ''], high: ['hoch', 'amber'], urgent: ['dringend', 'red'] };
const CHANNEL: Record<string, string> = { web: 'Formular', email: 'E-Mail', phone: 'Telefon', internal: 'intern' };
const left = (due: string | null) => {
  if (!due) return '';
  const h = Math.round((new Date(due).getTime() - Date.now()) / 3600000);
  return h < 0 ? `${-h} Std. überfällig` : h < 48 ? `noch ${h} Std.` : `noch ${Math.round(h / 24)} Tage`;
};

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'helpdesk.changed') void reload(); }), [reload]);
}

export default function HelpdeskPage() {
  useCrumbs([{ label: 'Kundenanfragen' }]);
  const { me } = useSession();
  const [tab, setTab] = useTabState<Tab>('helpdesk', 'tickets');
  const { data: ov, reload } = useApi<any>('/helpdesk/overview');
  useLive(reload);
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Kundenanfragen</h1><div className="sub">Fragen, Störungen und Wünsche von Kunden als Tickets</div></div></div>
      {ov && <div className="kpi-row">
        <div className="kpi"><div className="v" style={{ color: ov.new ? 'var(--red)' : undefined }}>{ov.new}</div><div className="l">neu</div></div>
        <div className="kpi"><div className="v">{ov.open}</div><div className="l">offen{ov.unassigned ? ` · ${ov.unassigned} ohne Zuständigen` : ''}</div></div>
        <div className="kpi"><div className="v" style={{ color: ov.breached ? 'var(--red)' : undefined }}>{ov.breached}</div><div className="l">Reaktionszeit überschritten</div></div>
        <div className="kpi"><div className="v">{ov.avgResponseHours ?? '–'}</div><div className="l">Std. bis zur ersten Antwort</div></div>
        <div className="kpi"><div className="v">{ov.rating ? `${ov.rating} / 5` : '–'}</div><div className="l">Zufriedenheit</div></div>
      </div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'tickets', label: 'Tickets' }, { id: 'canned', label: 'Textbausteine' }, ...(me?.role === 'admin' ? [{ id: 'settings' as Tab, label: 'Einstellungen' }] : [])]} />
      {tab === 'tickets' && <Tickets />}
      {tab === 'canned' && <Canned />}
      {tab === 'settings' && <HdSettings />}
    </div>
  );
}

function Tickets() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('active');
  const [filter, setFilter] = useState<'' | 'mine' | 'unassigned'>('');
  const [q, setQ] = useState('');
  const [create, setCreate] = useState(false);
  const { data, reload } = useApi<any[]>(`/helpdesk/tickets?${new URLSearchParams({ ...(status ? { status } : {}), ...(filter ? { [filter]: '1' } : {}), ...(q ? { q } : {}) })}`);
  useLive(reload);
  const open = params.get('ticket');
  const setOpen = (id: string | null) => { if (id) params.set('ticket', id); else params.delete('ticket'); setParams(params, { replace: true }); };
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="active">offen</option><option value="">alle</option>{Object.entries(HD_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={{ width: 'auto' }}><option value="">alle Bearbeiter</option><option value="mine">meine</option><option value="unassigned">ohne Zuständigen</option></select>
        <span className="right"><button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Ticket</button></span>
      </div>
      {data && !data.length && <Empty icon="headset" title="Keine offenen Anfragen">Anfragen kommen über das Kontaktformular (Link unter „Einstellungen“) oder werden hier bei Anrufen angelegt.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Anfrage</th><th>Kunde</th><th>Priorität</th><th>Zuständig</th><th>Reaktion</th><th>Status</th></tr></thead>
        <tbody>{data.map((t) => (
          <tr key={t.id} className="click" onClick={() => setOpen(t.id)} style={t.status === 'new' ? { fontWeight: 600 } : undefined}>
            <td className="mono small">{t.number}</td>
            <td>{t.subject}<div className="small muted" style={{ fontWeight: 400 }}>{CHANNEL[t.channel]} · {fmtDateTime(t.createdAt)} · {t.messages} Nachricht(en){t.category ? ` · ${t.category}` : ''}</div></td>
            <td style={{ fontWeight: 400 }}>{t.accountName ?? t.contactName}<div className="small muted">{t.email}</div></td>
            <td><Pill tone={PRIO[t.priority]![1]}>{PRIO[t.priority]![0]}</Pill></td>
            <td style={{ fontWeight: 400 }}>{t.assigneeName ?? <span className="muted">–</span>}</td>
            <td className={t.breached ? 'text-red small' : 'small muted'}>{t.firstResponseAt ? 'beantwortet' : ['new', 'open'].includes(t.status) ? left(t.dueAt) : ''}</td>
            <td><Pill tone={HD_STATUS[t.status]![1]}>{HD_STATUS[t.status]![0]}</Pill></td>
          </tr>
        ))}</tbody></table>}
      {create && <NewTicket onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); void reload(); setOpen(id); }} />}
      {open && <TicketPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function NewTicket({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { users, me } = useSession();
  const act = useAction();
  const [f, setF] = useState<any>({ account: null, subject: '', contactName: '', email: '', phone: '', priority: 'normal', channel: 'phone', assigneeId: me?.id ?? null, message: '', notifyCustomer: false });
  return (
    <Modal title="Neues Ticket" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.subject.trim()} onClick={async () => {
        const r = await act(() => post<{ id: string }>('/helpdesk/tickets', { accountId: f.account?.id ?? null, subject: f.subject, contactName: f.contactName, email: f.email, phone: f.phone, priority: f.priority, channel: f.channel, assigneeId: f.assigneeId, message: f.message, notifyCustomer: f.notifyCustomer && !!f.email }));
        if (r) onDone(r.id);
      }}>Anlegen</button></>}>
      <Field label="Betreff"><input autoFocus value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
      <Field label="Kunde"><CustomerPicker value={f.account} onChange={(a) => setF({ ...f, account: a })} /></Field>
      <div className="grid3">
        <Field label="Name"><input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
        <Field label="E-Mail"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Telefon"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Eingang"><select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>{Object.entries(CHANNEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Priorität"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIO).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Zuständig"><UserSelect users={users} value={f.assigneeId} onChange={(v) => setF({ ...f, assigneeId: v })} /></Field>
      </div>
      <Field label="Anliegen"><textarea rows={4} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
      <label className="row"><input type="checkbox" checked={f.notifyCustomer} disabled={!f.email} onChange={(e) => setF({ ...f, notifyCustomer: e.target.checked })} /> Eingangsbestätigung mit Link an den Kunden senden</label>
    </Modal>
  );
}

function TicketPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: t, reload } = useApi<any>(`/helpdesk/tickets/${id}`, [id]);
  const { data: canned } = useApi<any[]>('/helpdesk/canned');
  const { users } = useSession();
  const can = useCan();
  const act = useAction();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [after, setAfter] = useState<'waiting' | 'solved' | 'open'>('waiting');
  const [job, setJob] = useState(false);
  useLive(reload);
  if (!t) return null;
  const upd = async (p: Record<string, unknown>) => { if (await act(() => patch(`/helpdesk/tickets/${id}`, p))) void reload(); };
  return (
    <SlideOver wide title={<span>{t.subject} <span className="mono muted">{t.number}</span></span>} onClose={onClose}
      actions={<button className="btn sm" title="Link für den Kunden kopieren" onClick={() => { void navigator.clipboard.writeText(t.portalUrl); toast('Link kopiert'); }}><Icon name="link" /> Kundenlink</button>}>
      <div className="grid3">
        <Field label="Status"><select value={t.status} onChange={(e) => void upd({ status: e.target.value })}>{Object.entries(HD_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Priorität"><select value={t.priority} onChange={(e) => void upd({ priority: e.target.value })}>{Object.entries(PRIO).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Zuständig"><UserSelect users={users} value={t.assigneeId} onChange={(v) => void upd({ assigneeId: v })} /></Field>
      </div>
      <div className="row wrap small" style={{ gap: 10, marginBottom: 8 }}>
        <span><b>{t.contactName || '–'}</b> {t.email && <a href={`mailto:${t.email}`}>{t.email}</a>} {t.phone && <a href={`tel:${t.phone}`}>{t.phone}</a>}</span>
        <span className="muted">{CHANNEL[t.channel]} · {fmtDateTime(t.createdAt)}</span>
        {!t.firstResponseAt && ['new', 'open'].includes(t.status) && <span className={t.breached ? 'text-red' : 'muted'}>Antwort {left(t.dueAt)}</span>}
        {t.rating && <span>Bewertung {t.rating} / 5</span>}
      </div>
      <Field label="Kunde"><CustomerPicker value={t.accountId ? { id: t.accountId, name: t.accountName } : null} onChange={(a) => void upd({ accountId: a?.id ?? null })} /></Field>
      {can('service') && <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <button className="btn sm" onClick={() => setJob(true)}><Icon name="tools" /> Service-Einsatz planen</button>
        {t.jobs.map((j: any) => <a key={j.id} className="pill small" href={`/service?job=${j.id}`}>{j.number}</a>)}
      </div>}
      <div className="hd-thread">{t.messages.map((m: any) => (
        <div key={m.id} className={`hd-msg ${m.userId ? 'staff' : 'customer'} ${m.internal ? 'internal' : ''}`}>
          <div className="small muted">{m.author} · {fmtDateTime(m.createdAt)}{m.internal ? ' · interne Notiz' : ''}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
        </div>
      ))}</div>
      <div className="card flat" style={{ marginTop: 10 }}>
        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <label className="row small"><input type="radio" checked={!internal} onChange={() => setInternal(false)} /> Antwort an den Kunden{t.email ? '' : ' (keine E-Mail-Adresse)'}</label>
          <label className="row small"><input type="radio" checked={internal} onChange={() => setInternal(true)} /> interne Notiz</label>
          <span className="grow" />
          {canned && canned.length > 0 && <select style={{ width: 'auto' }} value="" onChange={(e) => { const c = canned.find((x) => x.id === e.target.value); if (c) setBody(body ? `${body}\n\n${c.body}` : c.body); }}>
            <option value="">Textbaustein …</option>{canned.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>}
        </div>
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} className={internal ? 'hd-internal' : ''} />
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          {!internal && <><span className="small">danach:</span><select style={{ width: 'auto' }} value={after} onChange={(e) => setAfter(e.target.value as typeof after)}><option value="waiting">wartet auf Kunde</option><option value="open">offen lassen</option><option value="solved">gelöst</option></select></>}
          <span className="grow" />
          <button className="btn primary" disabled={!body.trim()} onClick={async () => {
            const r = await act(() => post<{ mailed: boolean }>(`/helpdesk/tickets/${id}/messages`, { body, internal, status: internal ? undefined : after }));
            if (r) { setBody(''); void reload(); if (!internal) toast(r.mailed ? 'Antwort per E-Mail gesendet' : 'Gespeichert – keine E-Mail-Adresse, Kunde sieht die Antwort über den Link'); }
          }}><Icon name="send" /> {internal ? 'Notiz speichern' : 'Senden'}</button>
        </div>
      </div>
      {job && <NewJob onClose={() => setJob(false)} onDone={(jid) => { setJob(false); void reload(); window.open(`/service?job=${jid}`, '_self'); }}
        initial={{ account: t.accountId ? { id: t.accountId, name: t.accountName } : null, title: t.subject, description: t.messages[0]?.body ?? '', contactName: t.contactName, contactPhone: t.phone, ticketId: id }} />}
    </SlideOver>
  );
}

function Canned() {
  const { data, reload } = useApi<any[]>('/helpdesk/canned');
  const act = useAction();
  const [f, setF] = useState({ title: '', body: '' });
  return (
    <div style={{ maxWidth: 800 }}>
      {data?.map((c) => (
        <div key={c.id} className="card flat" style={{ marginBottom: 8 }}>
          <div className="row"><b className="grow">{c.title}</b><button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/helpdesk/canned/${c.id}`))) void reload(); }}><Icon name="trash" /></button></div>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
        </div>
      ))}
      <div className="card">
        <Field label="Titel"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Ersatzteil bestellt" /></Field>
        <Field label="Text"><textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <button className="btn primary" disabled={!f.title.trim() || !f.body.trim()} onClick={async () => { if (await act(() => post('/helpdesk/canned', f), 'Gespeichert')) { setF({ title: '', body: '' }); void reload(); } }}>Textbaustein speichern</button>
      </div>
    </div>
  );
}

function HdSettings() {
  const s = useAdminSettings('helpdesk');
  const act = useAction();
  const toast = useToast();
  if (!s.value) return null;
  const v = s.value;
  const url = `${location.origin}/support`;
  return (
    <div style={{ maxWidth: 820 }}>
      <h3>Kontaktformular</h3>
      <label className="row"><input type="checkbox" checked={v.publicForm} onChange={(e) => s.setValue({ ...v, publicForm: e.target.checked })} /> Öffentliches Kontaktformular eingeschaltet</label>
      <div className="row" style={{ gap: 6, margin: '8px 0' }}><input readOnly className="mono" value={url} /><button className="btn" onClick={() => { void navigator.clipboard.writeText(url); toast('Kopiert'); }}><Icon name="copy" /></button>
        <a className="btn" href={url} target="_blank" rel="noreferrer"><Icon name="eye" /></a></div>
      <p className="hint">Den Link auf der Webseite verlinken oder als Rahmen einbinden: <code>{`<iframe src="${url}" style="width:100%;height:720px;border:0"></iframe>`}</code></p>
      <Field label="Kategorien" hint="durch Komma getrennt"><input value={v.categories.join(', ')} onChange={(e) => s.setValue({ ...v, categories: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} /></Field>
      <h3>Reaktionszeiten (Stunden bis zur ersten Antwort)</h3>
      <div className="grid3">{Object.entries(PRIO).map(([k, [l]]) => <Field key={k} label={l}><input type="number" min={1} value={v.sla[k]} onChange={(e) => s.setValue({ ...v, sla: { ...v.sla, [k]: Number(e.target.value) } })} /></Field>)}</div>
      <Field label="Eingangsbestätigung" hint="Platzhalter {nummer}"><textarea rows={3} value={v.autoReply} onChange={(e) => s.setValue({ ...v, autoReply: e.target.value })} /></Field>
      <Field label="Signatur unter Antworten"><textarea rows={3} value={v.signature} onChange={(e) => s.setValue({ ...v, signature: e.target.value })} /></Field>
      <button className="btn primary" onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button>
    </div>
  );
}

// ---------------------------------------------------------------- Öffentlich: Kontaktformular und Verlauf
export function PublicSupportPage() {
  const token = location.pathname.match(/^\/support\/t\/([\w-]+)/)?.[1];
  return <div className="pub-page">{token ? <PublicTicket token={token} /> : <PublicForm />}</div>;
}

function PublicForm() {
  const [info, setInfo] = useState<any>(null);
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', subject: '', message: '', category: '', website: '' });
  const [done, setDone] = useState<{ number: string; token: string } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { void get('/pub/support').then(setInfo).catch(() => setErr('Das Kontaktformular ist nicht verfügbar.')); }, []);
  if (err && !info) return <div className="pub-card"><p>{err}</p></div>;
  if (!info) return null;
  if (!info.enabled) return <div className="pub-card"><p>Das Kontaktformular ist derzeit ausgeschaltet.</p></div>;
  if (done) return <div className="pub-card"><h1>Vielen Dank!</h1><p>Ihre Anfrage ist unter der Nummer <b>{done.number}</b> eingegangen. Eine Bestätigung kommt per E-Mail.</p>
    <a className="btn primary" href={`/support/t/${done.token}`}>Anfrage ansehen</a></div>;
  return (
    <form className="pub-card" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { setDone(await post('/pub/support/tickets', f)); } catch (x) { setErr((x as Error).message); } }}>
      <div className="pub-company">{info.company}</div>
      <h1>Wie können wir helfen?</h1>
      <div className="grid2">
        <Field label="Name" required><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Firma"><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></Field>
        <Field label="E-Mail" required><input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Telefon"><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      </div>
      {info.categories.length > 0 && <Field label="Thema"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">– bitte wählen –</option>{info.categories.map((c: string) => <option key={c}>{c}</option>)}</select></Field>}
      <Field label="Betreff" required><input required value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
      <Field label="Nachricht" required><textarea required rows={6} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
      <input className="hp" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} aria-hidden="true" />
      {err && <p className="text-red">{err}</p>}
      <button className="btn primary" type="submit">Absenden</button>
      <p className="hint">Ihre Angaben verwenden wir nur zur Bearbeitung Ihrer Anfrage.</p>
    </form>
  );
}

function PublicTicket({ token }: { token: string }) {
  const [t, setT] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => get(`/pub/support/t/${token}`).then(setT).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err && !t) return <div className="pub-card"><p>{err}</p></div>;
  if (!t) return null;
  return (
    <div className="pub-card">
      <div className="pub-company">{t.company}</div>
      <h1>{t.subject}</h1>
      <p className="muted">Anfrage {t.number} · {HD_STATUS[t.status]?.[0]}</p>
      <div className="hd-thread">{t.messages.map((m: any, i: number) => (
        <div key={i} className={`hd-msg ${m.staff ? 'staff' : 'customer'}`}><div className="small muted">{m.author} · {fmtDateTime(m.createdAt)}</div><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></div>
      ))}</div>
      {t.status !== 'closed' && <form onSubmit={async (e) => { e.preventDefault(); try { await post(`/pub/support/t/${token}/reply`, { message: msg }); setMsg(''); void load(); } catch (x) { setErr((x as Error).message); } }}>
        <Field label="Antworten"><textarea rows={4} value={msg} onChange={(e) => setMsg(e.target.value)} /></Field>
        <button className="btn primary" disabled={!msg.trim()}>Senden</button>
      </form>}
      {['solved', 'closed'].includes(t.status) && <div style={{ marginTop: 16 }}>
        <b>{t.rating ? 'Danke für Ihre Bewertung!' : 'Wie zufrieden waren Sie?'}</b>
        <div className="row" style={{ gap: 4, marginTop: 6 }}>{[1, 2, 3, 4, 5].map((n) => <button key={n} className={`btn sm ${t.rating === n ? 'primary' : ''}`} onClick={async () => { await post(`/pub/support/t/${token}/rate`, { rating: n }); void load(); }}>{n}</button>)}</div>
      </div>}
      {err && <p className="text-red">{err}</p>}
    </div>
  );
}
