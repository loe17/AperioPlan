import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { post, put } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDateTime } from '../lib/format';
import { Empty, Field, Pill, Tabs, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { CallNoteModal, usePhone } from '../modules/Phone';

const STATUS: Record<string, [string, string]> = { ringing: ['klingelt', 'amber'], answered: ['läuft', 'blue'], ended: ['angenommen', 'green'], missed: ['verpasst', 'red'], busy: ['besetzt', 'amber'], failed: ['nicht erreicht', 'amber'] };
const pretty = (n: string) => (n && n.length > 6 ? `+${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}` : n || 'unbekannt');
const dur = (s: number | null) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} Min.` : '');

export default function PhonePage() {
  useCrumbs([{ label: 'Telefonie' }]);
  const { me } = useSession();
  const [tab, setTab] = useTabState<'calls' | 'settings'>('phone', 'calls');
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Telefonie</h1><div className="sub">Anrufliste mit Kundendaten, Gesprächsnotizen und Telefonieren am PC</div></div>
        {me?.role === 'admin' && <div className="actions"><Link className="btn" to="/settings/phone"><Icon name="settings" /> Telefonanlage einrichten</Link></div>}</div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'calls', label: 'Anrufe' }, { id: 'settings', label: 'Mein Telefon' }]} />
      {tab === 'calls' ? <CallList /> : <MyPhone />}
    </div>
  );
}

function CallList() {
  const { me } = useSession();
  const phone = usePhone();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [filter, setFilter] = useState<'' | 'missed' | 'in' | 'out'>('');
  const [q, setQ] = useState('');
  const [note, setNote] = useState<any | null>(null);
  const qs = new URLSearchParams({ scope, ...(filter === 'missed' ? { missed: '1' } : filter ? { direction: filter } : {}), ...(q ? { q } : {}) });
  const { data, reload } = useApi<any[]>(`/phone/calls?${qs}`);
  useEffect(() => (me ? realtime.subscribe(`user:${me.id}`, (e) => { if (e.startsWith('phone.')) void reload(); }) : undefined), [me, reload]);
  return (
    <div className="phone-layout">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="toolbar">
          <input placeholder="Name, Firma oder Nummer …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
          {(['', 'missed', 'in', 'out'] as const).map((f) => <button key={f} className={`btn sm ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>{{ '': 'Alle', missed: 'Verpasst', in: 'Eingehend', out: 'Ausgehend' }[f]}</button>)}
          {(me?.role === 'admin' || me?.role === 'teamlead') && <select value={scope} onChange={(e) => setScope(e.target.value as 'mine')} style={{ width: 'auto' }}><option value="mine">Meine Anrufe</option><option value="all">Alle Anrufe</option></select>}
        </div>
        {!data?.length ? <Empty icon="phone" title="Noch keine Anrufe">Sobald die Telefonanlage angebunden ist, erscheinen hier alle Gespräche mit Kundendaten.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th /><th>Wer</th><th>Nummer</th><th>Wann</th><th>Dauer</th><th>Status</th>{scope === 'all' && <th>Mitarbeiter</th>}<th>Notiz</th><th /></tr></thead>
            <tbody>{data.map((c) => {
              const [label, tone] = STATUS[c.status] ?? [c.status, ''];
              return (
                <tr key={c.id}>
                  <td><Icon name={c.direction === 'in' ? 'arrow-down' : 'arrow-up'} /></td>
                  <td>{c.accountId ? <Link to={`/crm/${c.accountId}`}><b>{c.contactName || c.accountName}</b>{c.contactName && c.accountName ? <div className="small muted">{c.accountName}</div> : null}</Link> : c.colleagueName ? <b>{c.colleagueName}</b> : <span className="muted">unbekannt</span>}</td>
                  <td className="mono small">{pretty(c.remoteNumber)}</td>
                  <td className="small">{fmtDateTime(c.startedAt)}</td>
                  <td className="small">{dur(c.durationSec)}</td>
                  <td><Pill tone={tone as 'red'}>{label}</Pill></td>
                  {scope === 'all' && <td className="small">{c.userName ?? '–'}</td>}
                  <td className="small" style={{ maxWidth: 260 }}>{c.note ? <span title={c.note}>{c.note.slice(0, 80)}</span> : <button className="btn ghost sm" onClick={() => setNote(c)}><Icon name="note" /> Notiz</button>}</td>
                  <td>{c.remoteNumber && phone && <button className="btn sm" title="Zurückrufen" onClick={() => phone.dial(`+${c.remoteNumber}`)}><Icon name="phone" /></button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
      <Dialpad />
      {note && <CallNoteModal call={{ id: note.id, accountId: note.accountId, accountName: note.accountName, number: pretty(note.remoteNumber) }} onClose={() => setNote(null)} onSaved={reload} />}
    </div>
  );
}

function Dialpad() {
  const phone = usePhone();
  const [n, setN] = useState('');
  if (!phone) return null;
  return (
    <aside className="card dialpad-card">
      <div className="row small" style={{ marginBottom: 8 }}>
        <span className={`dot ${phone.soft === 'ready' ? 'ok' : 'off'}`} />
        <span>{phone.soft === 'ready' ? 'Softphone verbunden' : phone.soft === 'connecting' ? 'Softphone verbindet …' : phone.soft === 'error' ? `Softphone: ${phone.softError}` : 'Wählen über Ihr Telefon'}</span>
      </div>
      <input className="dial-input mono" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d+*# ]/g, ''))} placeholder="Nummer" onKeyDown={(e) => { if (e.key === 'Enter' && n.trim()) void phone.dial(n); }} />
      <div className="dialpad">{'123456789*0#'.split('').map((k) => <button key={k} className="btn" onClick={() => setN(n + k)}>{k}</button>)}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary grow" disabled={!n.trim() || Boolean(phone.active)} onClick={() => phone.dial(n)}><Icon name="phone" /> Anrufen</button>
        <button className="btn" onClick={() => setN(n.slice(0, -1))} title="Löschen">⌫</button>
      </div>
    </aside>
  );
}

function MyPhone() {
  const act = useAction();
  const { data } = useApi<any>('/phone/config');
  const [sipUser, setSipUser] = useState<string | null>(null);
  const [sipPassword, setSipPassword] = useState('');
  const [device, setDevice] = useState<string | null>(null);
  if (!data) return null;
  return (
    <div style={{ maxWidth: 640 }}>
      <div className="card flat" style={{ marginBottom: 14 }}>
        <div className="small">Nebenstelle: <b>{data.extension || '–'}</b>{data.numbers?.length ? <> · Durchwahl: <b>{data.numbers.join(', ')}</b></> : null}</div>
        <div className="small muted">Nebenstelle und Durchwahl trägt der Administrator ein. Damit erscheinen Anrufe für Sie bei Ihnen.</div>
      </div>
      {data.softphoneAvailable && (
        <>
          <h3>Softphone (Telefonieren mit dem Headset am PC)</h3>
          <p className="small muted">Zugangsdaten Ihres SIP-Kontos aus der Telefonanlage. AperioPlan meldet sich damit im Browser an, solange es geöffnet ist.</p>
          <div className="grid2">
            <Field label="SIP-Benutzer"><input value={sipUser ?? data.softphone?.user ?? ''} onChange={(e) => setSipUser(e.target.value)} /></Field>
            <Field label="SIP-Passwort"><input type="password" value={sipPassword} placeholder={data.softphone ? '(gespeichert)' : ''} onChange={(e) => setSipPassword(e.target.value)} autoComplete="new-password" /></Field>
          </div>
          <button className="btn primary" onClick={async () => { if (await act(() => put('/phone/me', { sipUser: sipUser ?? undefined, ...(sipPassword ? { sipPassword } : {}) }), 'Gespeichert – Seite neu laden, um das Softphone zu verbinden')) setSipPassword(''); }}>Speichern</button>
        </>
      )}
      {data.dialMethod === 'sipgate' && (
        <>
          <h3 style={{ marginTop: 18 }}>sipgate-Gerät</h3>
          <Field label="Gerät, das beim Wählen per Klick klingeln soll" hint="z. B. e0 (Telefon) oder p0 (Softphone) – steht im sipgate-Konto"><input value={device ?? data.sipgateDevice ?? ''} onChange={(e) => setDevice(e.target.value)} /></Field>
          <button className="btn primary" onClick={() => act(() => put('/phone/me', { sipgateDevice: device ?? '' }), 'Gespeichert')}>Speichern</button>
        </>
      )}
      {!data.softphoneAvailable && data.dialMethod !== 'sipgate' && <p className="muted">{data.dialMethod === 'fritzbox' ? 'Beim Wählen per Klick klingelt zuerst Ihr Telefon an der FRITZ!Box, dann wird verbunden.' : 'Beim Wählen per Klick öffnet sich das Telefonprogramm Ihres Rechners (z. B. Teams, 3CX oder Ihr Smartphone über Windows Phone Link).'}</p>}
      <TestRing />
    </div>
  );
}

function TestRing() {
  const { me } = useSession();
  const act = useAction();
  if (me?.role !== 'admin') return null;
  return <p className="small" style={{ marginTop: 18 }}><button className="btn sm" onClick={() => act(() => post('/phone/admin/test-call', { number: '+4930123456' }), 'Testanruf ausgelöst')}>Anrufer-Anzeige testen</button> <span className="muted">zeigt einen gespielten Anruf an</span></p>;
}
