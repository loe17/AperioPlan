import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, fmtTime } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, useAction, useToast } from '../components/ui';
import { UserPicker } from '../components/UserPicker';
import { Icon } from '../components/Icon';
import { VideoCall } from '../modules/Video';

interface Meeting {
  id: string; title: string; description: string; startsAt: string; endsAt: string; hostId: string; hostName: string; channelId: string; projectId: string | null; projectNumber: string | null;
  guestsAllowed: boolean; lobby: boolean; hasPin: boolean; cancelledAt: string | null; guestUrl: string; live: boolean; waiting: number;
}

const dayLabel = (d: string) => {
  const x = new Date(d), today = new Date(new Date().toDateString());
  const diff = Math.round((new Date(x.toDateString()).getTime() - today.getTime()) / 86400000);
  return diff === 0 ? 'Heute' : diff === 1 ? 'Morgen' : x.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
};

export default function MeetingsPage() {
  const { id } = useParams();
  return id ? <MeetingDetail id={id} /> : <MeetingList />;
}

function MeetingList() {
  useCrumbs([{ label: 'Meetings' }]);
  const nav = useNavigate();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const { data, reload } = useApi<Meeting[]>(`/meetings?${tab}=1`);
  const { me } = useSession();
  const [create, setCreate] = useState<'plan' | 'now' | null>(null);
  useEffect(() => (me ? realtime.subscribe(`user:${me.id}`, (e) => { if (e === 'meetings.changed') void reload(); }) : undefined), [me, reload]);
  const groups = new Map<string, Meeting[]>();
  for (const m of data ?? []) { const k = tab === 'past' ? fmtDate(m.startsAt) : dayLabel(m.startsAt); groups.set(k, [...(groups.get(k) ?? []), m]); }
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Meetings</h1><div className="sub">Videokonferenzen mit Kollegen, Kunden und Partnern – Gäste brauchen nur einen Link</div></div>
        <div className="actions">
          <button className="btn" onClick={() => setCreate('now')}><Icon name="video" /> Jetzt starten</button>
          <button className="btn primary" onClick={() => setCreate('plan')}><Icon name="plus" /> Meeting planen</button>
        </div>
      </div>
      <div className="row" style={{ gap: 4, marginBottom: 14 }}>
        <button className={`btn sm ${tab === 'upcoming' ? 'primary' : ''}`} onClick={() => setTab('upcoming')}>Anstehend</button>
        <button className={`btn sm ${tab === 'past' ? 'primary' : ''}`} onClick={() => setTab('past')}>Vergangen</button>
      </div>
      {data && !data.length && <Empty icon="video" title={tab === 'upcoming' ? 'Keine Meetings geplant' : 'Noch keine vergangenen Meetings'}>Planen Sie eine Videokonferenz – Teilnehmer erhalten eine Einladung im Kalender, Gäste einen Link.</Empty>}
      {[...groups].map(([day, list]) => (
        <section key={day} style={{ marginBottom: 18 }}>
          <h3 className="muted" style={{ marginBottom: 6 }}>{day}</h3>
          {list.map((m) => (
            <div key={m.id} className={`card meeting-row ${m.cancelledAt ? 'muted' : ''}`} onClick={() => nav(`/meetings/${m.id}`)}>
              <div className="meeting-time"><b>{fmtTime(m.startsAt)}</b><span className="small muted">{fmtTime(m.endsAt)}</span></div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 6 }}><b>{m.title}</b>{m.live && <Pill tone="green">läuft</Pill>}{m.cancelledAt && <Pill tone="red">abgesagt</Pill>}{m.waiting > 0 && <Pill tone="amber">{m.waiting} im Warteraum</Pill>}</div>
                <div className="small muted">{m.hostName}{m.projectNumber ? ` · Projekt ${m.projectNumber}` : ''}{m.guestsAllowed ? ' · Gäste erlaubt' : ''}</div>
              </div>
              {!m.cancelledAt && tab === 'upcoming' && <Link className="btn primary sm" to={`/meetings/${m.id}?join=1`} onClick={(e) => e.stopPropagation()}><Icon name="video" /> Beitreten</Link>}
            </div>
          ))}
        </section>
      ))}
      {create && <MeetingModal instant={create === 'now'} onClose={() => setCreate(null)} onSaved={(id) => { setCreate(null); nav(`/meetings/${id}${create === 'now' ? '?join=1' : ''}`); }} />}
    </div>
  );
}

function MeetingModal({ meeting, instant, onClose, onSaved }: { meeting?: any; instant?: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const { users, me } = useSession();
  const act = useAction();
  const { data: projects } = useApi<any[]>('/projects');
  const now = new Date(); now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
  const start = meeting ? new Date(meeting.startsAt) : now;
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [f, setF] = useState({
    title: meeting?.title ?? (instant ? `Besprechung von ${me?.displayName}` : ''), description: meeting?.description ?? '',
    start: local(start), duration: meeting ? Math.round((new Date(meeting.endsAt).getTime() - start.getTime()) / 60000) : 60,
    participantIds: (meeting?.participants ?? []).map((p: any) => p.id).filter((id: string) => id !== meeting?.hostId) as string[],
    invitees: (meeting?.invitees ?? []).map((i: any) => i.email).join(', '), guestsAllowed: meeting?.guestsAllowed ?? true, lobby: meeting?.lobby ?? true,
    pin: meeting?.pin ?? '', projectId: meeting?.projectId ?? '',
  });
  const emails = f.invitees.split(/[,;\s]+/).map((x: string) => x.trim()).filter(Boolean);
  const badMail = emails.find((e: string) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const save = async () => {
    const body = { title: f.title.trim(), description: f.description, startsAt: instant ? new Date().toISOString() : new Date(f.start).toISOString(), durationMinutes: Number(f.duration),
      participantIds: f.participantIds, invitees: emails.map((email: string) => ({ email, name: '' })), guestsAllowed: f.guestsAllowed, lobby: f.lobby,
      pin: f.pin || null, projectId: f.projectId || null };
    const r = await act(() => (meeting ? patch(`/meetings/${meeting.id}`, body) : post<{ id: string }>('/meetings', body)), meeting ? 'Gespeichert' : 'Meeting angelegt');
    if (r) onSaved(meeting?.id ?? (r as { id: string }).id);
  };
  return (
    <Modal size="lg" title={meeting ? 'Meeting bearbeiten' : instant ? 'Meeting jetzt starten' : 'Meeting planen'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim() || Boolean(badMail)} onClick={save}>{instant ? 'Starten' : meeting ? 'Speichern' : 'Planen und einladen'}</button></>}>
      <Field label="Thema" required><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Abnahme Roboterzelle" /></Field>
      {!instant && <div className="grid3">
        <Field label="Beginn"><input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="Dauer"><select value={f.duration} onChange={(e) => setF({ ...f, duration: Number(e.target.value) })}>{[15, 30, 45, 60, 90, 120, 180, 240, 480].map((d) => <option key={d} value={d}>{d < 60 ? `${d} Minuten` : `${d / 60} Stunde${d > 60 ? 'n' : ''}`}</option>)}</select></Field>
        <Field label="Projekt"><select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">–</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></Field>
      </div>}
      <Field label="Kollegen einladen" hint="erhalten einen Termin im Kalender"><UserPicker users={users.filter((u) => u.id !== me?.id)} value={f.participantIds} onChange={(participantIds) => setF({ ...f, participantIds })} /></Field>
      <Field label="Externe Gäste per E-Mail" hint={badMail ? `Ungültige Adresse: ${badMail}` : 'mehrere mit Komma trennen – erhalten Link und Kalenderdatei'}>
        <input value={f.invitees} onChange={(e) => setF({ ...f, invitees: e.target.value })} placeholder="kunde@firma.de, partner@firma.de" />
      </Field>
      {!instant && <Field label="Beschreibung / Tagesordnung"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>}
      <div className="row wrap" style={{ gap: 16 }}>
        <label className="row"><input type="checkbox" checked={f.guestsAllowed} onChange={(e) => setF({ ...f, guestsAllowed: e.target.checked })} /> Gäste über Link zulassen</label>
        {f.guestsAllowed && <label className="row"><input type="checkbox" checked={f.lobby} onChange={(e) => setF({ ...f, lobby: e.target.checked })} /> Warteraum (Gäste werden eingelassen)</label>}
        {f.guestsAllowed && <label className="row">PIN <input style={{ width: 100 }} value={f.pin} maxLength={8} placeholder="optional" onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} /></label>}
      </div>
    </Modal>
  );
}

function MeetingDetail({ id }: { id: string }) {
  const { data: m, reload } = useApi<any>(`/meetings/${id}`);
  const nav = useNavigate();
  const act = useAction();
  const toast = useToast();
  const [joined, setJoined] = useState(() => new URLSearchParams(location.search).get('join') === '1');
  const [edit, setEdit] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [mail, setMail] = useState('');
  useCrumbs([{ label: 'Meetings', to: '/meetings' }, { label: m?.title ?? '…' }]);
  useEffect(() => realtime.subscribe(`meeting:${id}`, (e) => { if (e === 'meeting.lobby') void reload(); }), [id, reload]);
  if (!m) return null;
  const waiting = m.guests.filter((g: any) => g.status === 'waiting');
  const copy = async () => { await navigator.clipboard.writeText(m.guestUrl).catch(() => {}); toast('Gast-Link kopiert'); };
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{m.title} {m.live && <Pill tone="green">läuft</Pill>} {m.cancelledAt && <Pill tone="red">abgesagt</Pill>}</h1>
          <div className="sub">{dayLabel(m.startsAt)}, {fmtTime(m.startsAt)}–{fmtTime(m.endsAt)} · Organisator {m.hostName}{m.projectNumber ? <> · <Link to={`/projects/${m.projectId}`}>Projekt {m.projectNumber}</Link></> : null}</div>
        </div>
        <div className="actions">
          {m.isHost && !m.cancelledAt && <button className="btn" onClick={() => setEdit(true)}><Icon name="edit" /> Bearbeiten</button>}
          {m.isHost && !m.cancelledAt && <button className="btn ghost danger" onClick={() => setCancel(true)}>Absagen</button>}
          {!m.cancelledAt && <button className="btn primary" onClick={() => setJoined(true)}><Icon name="video" /> Beitreten</button>}
        </div>
      </div>
      {waiting.length > 0 && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--amber)' }}>
          <b><Icon name="door" /> Im Warteraum</b>
          {waiting.map((g: any) => (
            <div key={g.id} className="row" style={{ marginTop: 6 }}>
              <span className="grow">{g.name} <span className="small muted">seit {fmtTime(g.joinedAt)}</span></span>
              <button className="btn sm primary" onClick={async () => { await act(() => post(`/meetings/${id}/guests/${g.id}/admit`)); reload(); }}>Einlassen</button>
              <button className="btn sm" onClick={async () => { await act(() => post(`/meetings/${id}/guests/${g.id}/deny`)); reload(); }}>Ablehnen</button>
            </div>
          ))}
        </div>
      )}
      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="card">
          <h3 style={{ marginBottom: 8 }}>Teilnehmer</h3>
          {m.participants.map((p: any) => (
            <div key={p.id} className="row" style={{ padding: '3px 0' }}><span className="grow">{p.displayName}{p.id === m.hostId && <span className="small muted"> · Organisator</span>}</span>
              {p.id !== m.hostId && <Pill tone={p.response === 'accepted' ? 'green' : p.response === 'declined' ? 'red' : undefined}>{p.response === 'accepted' ? 'zugesagt' : p.response === 'declined' ? 'abgesagt' : 'offen'}</Pill>}</div>
          ))}
          {m.invitees.length > 0 && <>
            <h3 style={{ margin: '12px 0 6px' }}>Externe Gäste</h3>
            {m.invitees.map((i: any) => <div key={i.email} className="row small" style={{ padding: '2px 0' }}><span className="grow">{i.name || i.email}</span><span className="muted">{i.invitedAt ? 'eingeladen' : 'noch nicht verschickt'}</span></div>)}
          </>}
          {m.guests.filter((g: any) => g.status === 'admitted').length > 0 && <>
            <h3 style={{ margin: '12px 0 6px' }}>Gäste im Meeting</h3>
            {m.guests.filter((g: any) => g.status === 'admitted').map((g: any) => <div key={g.id} className="row small"><span className="grow">{g.name}</span>
              <button className="btn ghost sm" title="Aus dem Meeting entfernen" onClick={async () => { await act(() => post(`/meetings/${id}/guests/${g.id}/remove`)); reload(); }}><Icon name="x" /></button></div>)}
          </>}
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 8 }}>Gast-Link</h3>
          {m.guestsAllowed ? <>
            <div className="row"><input readOnly value={m.guestUrl} className="mono small" onFocus={(e) => e.target.select()} /><button className="btn" onClick={copy}><Icon name="copy" /></button></div>
            <p className="small muted" style={{ marginTop: 6 }}>Gäste öffnen den Link im Browser, geben ihren Namen ein{m.hasPin ? ' und die PIN' : ''}{m.lobby ? ' und warten, bis jemand sie einlässt' : ''}. Keine Installation nötig.</p>
            {m.isHost && m.pin && <p className="small">PIN: <b className="mono">{m.pin}</b></p>}
            <div className="row" style={{ marginTop: 8 }}>
              <input placeholder="weitere E-Mail-Adresse" value={mail} onChange={(e) => setMail(e.target.value)} />
              <button className="btn" disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)} onClick={async () => { if (await act(() => post(`/meetings/${id}/invite`, { emails: [mail] }), 'Einladung verschickt')) { setMail(''); reload(); } }}>Einladen</button>
            </div>
            {m.isHost && <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={async () => { if (await act(() => post(`/meetings/${id}/new-link`), 'Neuer Link erzeugt – der alte gilt nicht mehr')) reload(); }}>Neuen Link erzeugen</button>}
          </> : <p className="muted small">Für dieses Meeting sind keine Gäste zugelassen.</p>}
          {m.description && <><h3 style={{ margin: '14px 0 6px' }}>Tagesordnung</h3><div style={{ whiteSpace: 'pre-wrap' }}>{m.description}</div></>}
        </div>
      </div>
      {joined && <VideoCall channelId={m.channelId} title={m.title} onClose={() => { setJoined(false); reload(); history.replaceState(null, '', `/meetings/${id}`); }} />}
      {edit && <MeetingModal meeting={m} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />}
      {cancel && <Confirm danger text="Meeting absagen? Alle Teilnehmer werden benachrichtigt, der Kalendertermin wird gelöscht und der Gast-Link gilt nicht mehr." confirmLabel="Absagen"
        onClose={() => setCancel(false)} onConfirm={async () => { if (await act(() => del(`/meetings/${id}`), 'Meeting abgesagt')) nav('/meetings'); }} />}
    </div>
  );
}

