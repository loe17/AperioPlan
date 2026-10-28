import { useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtTime } from '../lib/format';
import { Icon } from '../components/Icon';
import { VideoCall, type GuestInfo } from '../modules/Video';

/** Öffentliche Seite für Meeting-Gäste: Name eingeben, ggf. warten, beitreten – ohne Benutzerkonto */
export default function MeetPage() {
  const token = location.pathname.split('/')[2] ?? '';
  const { me } = useSession();
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState(() => { try { return localStorage.getItem('aperio-guest-name') ?? ''; } catch { return ''; } });
  const [pin, setPin] = useState('');
  const [guest, setGuest] = useState<GuestInfo | null>(null);
  const [state, setState] = useState<'form' | 'waiting' | 'call' | 'denied' | 'left'>('form');
  const [busy, setBusy] = useState(false);
  const [call, setCall] = useState<{ channelId: string; title: string } | null>(null);

  useEffect(() => { get(`/meet/${token}`).then(setInfo).catch((e) => setError((e as Error).message)); }, [token]);
  useEffect(() => { if (me && !name) setName(me.displayName); }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  // im Warteraum regelmäßig nachfragen
  useEffect(() => {
    if (state !== 'waiting' || !guest) return;
    const t = setInterval(async () => {
      try {
        const s = await get<any>(`/meet/${token}/status?guest=${guest.guest}&key=${encodeURIComponent(guest.key)}`);
        if (s.status === 'admitted') enter(guest, s);
        else if (s.status === 'denied') setState('denied');
      } catch { /* weiter warten */ }
    }, 2000);
    return () => clearInterval(t);
  }, [state, guest]); // eslint-disable-line react-hooks/exhaustive-deps

  const enter = (g: GuestInfo, s: { channelId: string; title: string }) => {
    realtime.stop();
    realtime.start(`guest=${g.guest}&key=${encodeURIComponent(g.key)}`);
    setCall({ channelId: s.channelId, title: s.title });
    setState('call');
  };

  const join = async () => {
    setBusy(true); setError('');
    try {
      try { localStorage.setItem('aperio-guest-name', name.trim()); } catch { /* privat */ }
      const r = await post<{ guest: string; key: string; status: string }>(`/meet/${token}/join`, { name: name.trim(), pin: pin || undefined });
      const g = { token, guest: r.guest, key: r.key, name: name.trim() };
      setGuest(g);
      if (r.status === 'admitted') enter(g, await get(`/meet/${token}/status?guest=${g.guest}&key=${encodeURIComponent(g.key)}`));
      else setState('waiting');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  if (state === 'call' && guest && call) return <VideoCall channelId={call.channelId} title={call.title} guest={guest} onClose={() => { realtime.stop(); setState('left'); }} />;

  return (
    <div className="meet-page">
      <div className="meet-card">
        <img src="/logo-mark.svg" alt="" width={44} height={44} />
        {error && !info ? <><h1>Link ungültig</h1><p className="muted">{error}</p></> : !info ? <p className="muted">Wird geladen …</p> : info.cancelled ? (
          <><h1>{info.title}</h1><p>Dieses Meeting wurde abgesagt.</p></>
        ) : state === 'waiting' ? (
          <><h1>{info.title}</h1><p><Icon name="door" /> Sie sind im Warteraum. {info.hostName} oder ein anderer Teilnehmer lässt Sie gleich ein.</p><div className="meet-spinner" /></>
        ) : state === 'denied' ? (
          <><h1>{info.title}</h1><p>Der Zutritt wurde nicht gewährt.</p></>
        ) : state === 'left' ? (
          <><h1>Danke!</h1><p>Sie haben das Meeting „{info.title}“ verlassen.</p><button className="btn" onClick={() => setState('form')}>Erneut beitreten</button></>
        ) : (
          <>
            <div className="small muted">{info.company}</div>
            <h1>{info.title}</h1>
            <p className="muted">{new Date(info.startsAt).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}, {fmtTime(info.startsAt)}–{fmtTime(info.endsAt)} · Einladung von {info.hostName}</p>
            {!info.guestsAllowed ? <p>Für dieses Meeting sind keine Gäste zugelassen.</p> : (
              <form onSubmit={(e) => { e.preventDefault(); void join(); }}>
                <label className="field"><span className="label">Ihr Name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Vor- und Nachname" /></label>
                {info.needsPin && <label className="field"><span className="label">PIN</span><input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>}
                {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
                <button className="btn primary" style={{ width: '100%' }} disabled={busy || name.trim().length < 2}><Icon name="video" /> Meeting beitreten</button>
                <p className="small muted" style={{ marginTop: 10 }}>Ihr Browser fragt nach Kamera und Mikrofon. Es wird nichts installiert.</p>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
