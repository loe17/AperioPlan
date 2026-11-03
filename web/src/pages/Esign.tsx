import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, get, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, fmtDateTime } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { SignaturePad, type Stroke } from '../modules/Signature';
import { useAdminSettings } from './Settings';

const STATUS: Record<string, [string, string]> = { draft: ['Entwurf', ''], sent: ['zur Unterschrift', 'amber'], completed: ['unterschrieben', 'green'], declined: ['abgelehnt', 'red'], cancelled: ['zurückgezogen', ''], expired: ['abgelaufen', ''] };
const SIGNER: Record<string, [string, string]> = { pending: ['offen', 'amber'], signed: ['unterschrieben', 'green'], declined: ['abgelehnt', 'red'] };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'esign.changed') void reload(); }), [reload]);
}

export default function EsignPage() {
  useCrumbs([{ label: 'E-Signatur' }]);
  const { me } = useSession();
  const [tab, setTab] = useTabState<'mine' | 'all'>('esign', 'mine');
  const { data, reload } = useApi<{ envelopes: any[]; toSign: any[] }>(`/esign/envelopes?scope=${tab}`, [tab]);
  const [params, setParams] = useSearchParams();
  const [create, setCreate] = useState(false);
  const open = params.get('envelope');
  const setOpen = (id: string | null) => { if (id) params.set('envelope', id); else params.delete('envelope'); setParams(params, { replace: true }); };
  useLive(reload);
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>E-Signatur</h1><div className="sub">PDF-Dokumente online unterschreiben lassen</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setCreate(true)}><Icon name="upload" /> Dokument zur Unterschrift</button></div></div>
      {data && data.toSign.length > 0 && <div className="card" style={{ marginBottom: 12 }}><b>Für dich zum Unterschreiben</b>
        {data.toSign.map((s) => <div key={s.token} className="row small" style={{ gap: 8, padding: '3px 0' }}><span className="grow">{s.title} · von {s.createdByName}</span><a className="btn sm primary" href={`/sign/${s.token}`}><Icon name="signature" /> Unterschreiben</a></div>)}</div>}
      {me?.role === 'admin' && <Tabs value={tab} onChange={setTab} tabs={[{ id: 'mine', label: 'Meine Vorgänge' }, { id: 'all', label: 'Alle' }]} />}
      {data && !data.envelopes.length ? <Empty icon="signature" title="Noch keine Vorgänge">Vertrag, Angebot oder Abnahmeprotokoll als PDF hochladen, Unterzeichner eintragen, absenden – alle unterschreiben im Browser.</Empty>
        : <table className="table"><thead><tr><th>Nummer</th><th>Dokument</th><th>Unterschriften</th><th>Status</th><th>Erstellt</th></tr></thead>
          <tbody>{data?.envelopes.map((e) => (
            <tr key={e.id} className="click" onClick={() => setOpen(e.id)}><td className="mono small">{e.number}</td><td><b>{e.title}</b><div className="small muted">{e.fileName}{tab === 'all' ? ` · ${e.createdByName}` : ''}</div></td>
              <td>{e.signed} / {e.signers}</td><td><Pill tone={STATUS[e.status]![1]}>{STATUS[e.status]![0]}</Pill></td><td>{fmtDate(e.createdAt)}</td></tr>
          ))}</tbody></table>}
      <p className="hint">Einfache elektronische Signatur: geeignet für Angebote, Aufträge, Abnahmen, Arbeitsanweisungen und die meisten Verträge. Nicht ausreichend, wo das Gesetz Schriftform verlangt (z. B. Kündigung eines Arbeitsvertrags).</p>
      {tab === 'all' && <EsignSettings />}
      {create && <NewEnvelope onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); setOpen(id); }} />}
      {open && <EnvelopePanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function NewEnvelope({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { users } = useSession();
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState({ title: '', message: '', sequential: false, expiresAt: '' });
  const [signers, setSigners] = useState<{ name: string; email: string; userId: string | null }[]>([{ name: '', email: '', userId: null }]);
  const setS = (i: number, x: any) => setSigners(signers.map((s, k) => (k === i ? { ...s, ...x } : s)));
  return (
    <Modal size="lg" title="Dokument zur Unterschrift" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!file || signers.some((s) => !s.name.trim() || !s.email.trim())} onClick={async () => {
        const fd = new FormData();
        for (const [k, v] of Object.entries({ ...f, sequential: String(f.sequential), signers: JSON.stringify(signers) })) fd.append(k, v);
        fd.append('file', file!, file!.name);
        const r = await act(async () => { const res = await fetch('/api/esign/envelopes', { method: 'POST', body: fd }); const j = await res.json(); if (!res.ok) throw new Error(j.error ?? 'Fehler'); return j; });
        if (r) onDone(r.id);
      }}>Anlegen</button></>}>
      <Field label="PDF-Dokument"><input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <Field label="Titel" hint="leer = Dateiname"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Nachricht an die Unterzeichner"><textarea rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
      <h3 style={{ margin: '8px 0 4px' }}>Unterzeichner</h3>
      {signers.map((s, i) => (
        <div key={i} className="row" style={{ gap: 6, marginBottom: 4 }}>
          <span className="muted small" style={{ width: 18 }}>{i + 1}.</span>
          <select style={{ width: 170 }} value={s.userId ?? ''} onChange={(e) => { const u = users.find((x) => x.id === e.target.value); setS(i, u ? { userId: u.id, name: u.displayName, email: u.email ?? '' } : { userId: null }); }}>
            <option value="">extern</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
          <input className="grow" placeholder="Name" value={s.name} onChange={(e) => setS(i, { name: e.target.value })} />
          <input className="grow" type="email" placeholder="E-Mail" value={s.email} onChange={(e) => setS(i, { email: e.target.value })} />
          {signers.length > 1 && <button className="btn ghost sm" onClick={() => setSigners(signers.filter((_, k) => k !== i))}><Icon name="x" /></button>}
        </div>
      ))}
      <button className="btn sm" onClick={() => setSigners([...signers, { name: '', email: '', userId: null }])}><Icon name="plus" /> Unterzeichner</button>
      <div className="grid2" style={{ marginTop: 10 }}>
        <label className="row"><input type="checkbox" checked={f.sequential} onChange={(e) => setF({ ...f, sequential: e.target.checked })} /> in dieser Reihenfolge nacheinander</label>
        <Field label="Gültig bis" hint="leer = Standard aus den Einstellungen"><input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function EnvelopePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: e, reload } = useApi<any>(`/esign/envelopes/${id}`, [id]);
  const act = useAction();
  const toast = useToast();
  const [cancel, setCancel] = useState(false);
  useLive(reload);
  if (!e) return null;
  return (
    <SlideOver wide title={`${e.number} · ${e.title}`} onClose={onClose}>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <Pill tone={STATUS[e.status]![1]}>{STATUS[e.status]![0]}</Pill><span className="grow small muted">{e.sequential ? 'nacheinander' : 'beliebige Reihenfolge'}{e.expiresAt ? ` · gültig bis ${fmtDate(e.expiresAt)}` : ''}</span>
        <a className="btn sm" href={`/api/esign/envelopes/${id}/file`} target="_blank" rel="noreferrer"><Icon name="file-pdf" /> Dokument</a>
        {e.hasProtocol && <a className="btn sm primary" href={`/api/esign/envelopes/${id}/protocol`} target="_blank" rel="noreferrer"><Icon name="download" /> Signaturprotokoll</a>}
        {e.status === 'draft' && <><button className="btn sm primary" onClick={async () => { const r = await act(() => post<{ failed: number }>(`/esign/envelopes/${id}/send`, {})); if (r) { toast(r.failed ? `Versendet – ${r.failed} E-Mail(s) konnten nicht zugestellt werden, Link bitte selbst weitergeben` : 'Einladungen versendet'); void reload(); } }}><Icon name="send" /> Absenden</button>
          <button className="btn sm ghost danger" onClick={async () => { if (await act(() => del(`/esign/envelopes/${id}`))) onClose(); }}><Icon name="trash" /></button></>}
        {e.status === 'sent' && <><button className="btn sm" onClick={async () => { const r = await act(() => post<{ reminded: number }>(`/esign/envelopes/${id}/remind`, {})); if (r) toast(`${r.reminded} erinnert`); }}><Icon name="bell" /> Erinnern</button>
          <button className="btn sm ghost danger" onClick={() => setCancel(true)}>Zurückziehen</button></>}
      </div>
      {e.message && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{e.message}</p>}
      <table className="table small"><thead><tr><th>#</th><th>Unterzeichner</th><th>Status</th><th>Verlauf</th><th /></tr></thead>
        <tbody>{e.signers.map((s: any) => (
          <tr key={s.id}><td>{s.sort + 1}</td><td><b>{s.name}</b><div className="muted">{s.email}</div></td><td><Pill tone={SIGNER[s.status]![1]}>{SIGNER[s.status]![0]}</Pill></td>
            <td className="small">{s.invitedAt && <div>eingeladen {fmtDateTime(s.invitedAt)}</div>}{s.viewedAt && <div>geöffnet {fmtDateTime(s.viewedAt)}</div>}{s.signedAt && <div>unterschrieben {fmtDateTime(s.signedAt)}</div>}{s.declineReason && <div className="text-red">„{s.declineReason}“</div>}</td>
            <td>{e.status !== 'draft' && s.status === 'pending' && <button className="btn ghost sm" title="Link kopieren" onClick={() => { void navigator.clipboard.writeText(s.link); toast('Link kopiert'); }}><Icon name="link" /></button>}</td></tr>
        ))}</tbody></table>
      <p className="hint">Prüfsumme des Dokuments (SHA-256): <span className="mono">{e.sha256}</span></p>
      {cancel && <Confirm danger text="Vorgang zurückziehen? Die Links funktionieren danach nicht mehr." onClose={() => setCancel(false)} onConfirm={async () => { if (await act(() => post(`/esign/envelopes/${id}/cancel`, {}))) void reload(); }} />}
    </SlideOver>
  );
}

function EsignSettings() {
  const s = useAdminSettings('esign');
  const act = useAction();
  if (!s.value) return null;
  return (
    <div style={{ maxWidth: 760, marginTop: 24 }}>
      <h3>Einstellungen</h3>
      <div className="grid2">
        <Field label="Erinnern nach (Tagen)" hint="0 = keine automatische Erinnerung"><input type="number" min={0} max={60} value={s.value.reminderDays} onChange={(e) => s.setValue({ ...s.value, reminderDays: Number(e.target.value) })} /></Field>
        <Field label="Links gültig für (Tage)"><input type="number" min={1} max={365} value={s.value.expiryDays} onChange={(e) => s.setValue({ ...s.value, expiryDays: Number(e.target.value) })} /></Field>
      </div>
      <button className="btn primary" onClick={() => act(() => s.save(s.value), 'Gespeichert')}>Speichern</button>
    </div>
  );
}

// ---------------------------------------------------------------- Öffentliche Unterschriftsseite
export function PublicSignPage() {
  const token = location.pathname.match(/^\/sign\/([\w-]+)/)?.[1] ?? '';
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [consent, setConsent] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => get(`/pub/sign/${token}`).then((x: any) => { setD(x); setName((n) => n || x.signer.name); }).catch((x) => setErr((x as Error).message));
  useEffect(() => { void load(); }, [token]);
  if (err && !d) return <div className="pub-page"><div className="pub-card"><p>{err}</p></div></div>;
  if (!d) return null;
  const send = async (url: string, body: unknown) => {
    setBusy(true); setErr('');
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    setBusy(false);
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error ?? 'Fehler'); return; }
    void load();
  };
  const open = d.status === 'sent' && d.signer.status === 'pending';
  return (
    <div className="pub-page"><div className="pub-card wide">
      <div className="pub-company">{d.company}</div>
      <h1>{d.title}</h1>
      {d.message && <p style={{ whiteSpace: 'pre-wrap' }}>{d.message}</p>}
      <iframe className="sign-doc" src={`/api/pub/sign/${token}/file`} title={d.fileName} />
      <p className="small"><a href={`/api/pub/sign/${token}/file`} target="_blank" rel="noreferrer">{d.fileName} öffnen</a></p>
      {d.signer.status === 'signed' ? <div className="card"><b>Vielen Dank – Sie haben am {fmtDateTime(d.signer.signedAt)} unterschrieben.</b>
        {d.status === 'completed' ? <p>Alle Unterschriften liegen vor. <a href={`/api/pub/sign/${token}/protocol`} target="_blank" rel="noreferrer">Signaturprotokoll herunterladen</a></p> : <p className="muted">Sie erhalten das unterschriebene Dokument per E-Mail, sobald alle unterschrieben haben.</p>}</div>
        : d.signer.status === 'declined' ? <div className="card"><b>Sie haben die Unterschrift abgelehnt.</b></div>
        : !open ? <div className="card"><b>{d.status === 'completed' ? 'Dieses Dokument ist bereits unterschrieben.' : 'Dieser Vorgang ist nicht mehr offen.'}</b></div>
        : !d.turn ? <div className="card"><b>Noch nicht an der Reihe.</b><p className="muted">Sie werden per E-Mail benachrichtigt, sobald die vorherigen Unterzeichner unterschrieben haben.</p></div>
        : declining ? <div className="card">
          <Field label="Warum lehnen Sie ab?"><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {err && <p className="text-red">{err}</p>}
          <div className="row" style={{ gap: 8 }}><button className="btn" onClick={() => setDeclining(false)}>Zurück</button><button className="btn danger" disabled={busy} onClick={() => void send(`/api/pub/sign/${token}/decline`, { reason })}>Ablehnen</button></div>
        </div>
        : <div className="card">
          <h3 style={{ marginTop: 0 }}>Unterschreiben</h3>
          <Field label="Ihr vollständiger Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="field"><span>Unterschrift <span className="muted small">(mit Maus, Finger oder Stift)</span></span><SignaturePad onChange={setStrokes} /></div>
          <label className="row small" style={{ margin: '8px 0' }}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Ich habe das Dokument gelesen und unterschreibe es elektronisch. Zeitpunkt und IP-Adresse werden protokolliert.</label>
          {err && <p className="text-red">{err}</p>}
          <div className="row" style={{ gap: 8 }}><button className="btn primary" disabled={busy || !consent || !strokes.length || name.trim().length < 2} onClick={() => void send(`/api/pub/sign/${token}`, { name, consent: true, strokes, aspect: 3 })}><Icon name="signature" /> Verbindlich unterschreiben</button>
            <span className="grow" /><button className="btn ghost" onClick={() => setDeclining(true)}>Ablehnen</button></div>
        </div>}
      {d.others.length > 0 && <p className="small muted" style={{ marginTop: 12 }}>Weitere Unterzeichner: {d.others.map((o: any) => `${o.name} (${SIGNER[o.status]![0]})`).join(', ')}</p>}
      <p className="small muted">Vorgang {d.number} · Prüfsumme <span className="mono">{d.sha256.slice(0, 16)}…</span></p>
    </div></div>
  );
}
