import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useCan, useSession } from '../session';
import { fmtDateTime } from '../lib/format';
import { Field, Modal, useToast } from '../components/ui';
import { Icon } from '../components/Icon';

export interface Caller {
  kind: 'contact' | 'account' | 'colleague'; name: string; contactId?: string; accountId?: string; accountName?: string; accountNumber?: string; userId?: string;
  position?: string; city?: string; lastNote?: { body: string; at: string; by: string | null } | null; openCases?: number; openQuotes?: number;
}
interface Ring { id: string; direction: 'in' | 'out'; number: string; rawNumber: string; caller: Caller | null; answeredBy?: string | null; soft?: boolean }
interface PhoneConfig { provider: string; dialMethod: string; softphone: { wsUrl: string; domain: string; user: string; password: string } | null; softphoneAvailable: boolean }
type SoftState = 'off' | 'connecting' | 'ready' | 'error';

interface PhoneApi {
  dial: (number: string) => Promise<void>;
  soft: SoftState;
  softError: string;
  active: ActiveCall | null;
}
interface ActiveCall { number: string; name?: string; direction: 'in' | 'out'; state: 'ringing' | 'calling' | 'talking'; since?: number; muted: boolean; held: boolean }

const Ctx = createContext<PhoneApi | null>(null);
export const usePhone = () => useContext(Ctx);

/** Rufnummer als Link: wählt über die eingestellte Methode (Softphone, FRITZ!Box, sipgate oder tel:) */
export function PhoneLink({ number, label, stop }: { number: string; label?: ReactNode; stop?: boolean }) {
  const phone = usePhone();
  if (!number) return null;
  if (!phone) return <a href={`tel:${number.replace(/[^\d+]/g, '')}`} onClick={(e) => stop && e.stopPropagation()}><Icon name="phone" /> {label ?? number}</a>;
  return <a href={`tel:${number.replace(/[^\d+]/g, '')}`} title="Anrufen" onClick={(e) => { e.preventDefault(); if (stop) e.stopPropagation(); void phone.dial(number); }}><Icon name="phone" /> {label ?? number}</a>;
}

/**
 * Telefonie im Hintergrund: Anrufer-Anzeige bei eingehenden Anrufen, Softphone (SIP über WebSocket)
 * mit Headset am PC und Wählen per Klick. Nur aktiv, wenn die Anwendung Telefonie freigeschaltet ist.
 */
export function PhoneProvider({ children }: { children: ReactNode }) {
  const can = useCan();
  const { me } = useSession();
  const enabled = Boolean(me && can('phone'));
  const toast = useToast();
  const [cfg, setCfg] = useState<PhoneConfig | null>(null);
  const [rings, setRings] = useState<Ring[]>([]);
  const [noteFor, setNoteFor] = useState<Ring | null>(null);
  const [soft, setSoft] = useState<SoftState>('off');
  const [softError, setSoftError] = useState('');
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [incomingSoft, setIncomingSoft] = useState<{ number: string; name?: string } | null>(null);
  const uaRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ringtone = useRef<{ stop: () => void } | null>(null);

  useEffect(() => { if (enabled) get<PhoneConfig>('/phone/config').then(setCfg).catch(() => setCfg(null)); else setCfg(null); }, [enabled]);

  // Anrufer-Anzeige aus der Telefonanlage
  useEffect(() => {
    if (!enabled || !me) return;
    return realtime.subscribe(`user:${me.id}`, (event, data) => {
      if (event === 'phone.ring') setRings((r) => [...r.filter((x) => x.id !== data.id), data].slice(-3));
      else if (event === 'phone.answered') setRings((r) => r.map((x) => (x.id === data.id ? { ...x, answeredBy: data.userId } : x)).filter((x) => x.id !== data.id || data.userId === me.id));
      else if (event === 'phone.ended') {
        setRings((r) => {
          const ended = r.find((x) => x.id === data.id);
          if (ended && ended.answeredBy === me.id && ended.caller?.accountId) setNoteFor(ended);
          return r.filter((x) => x.id !== data.id);
        });
      }
    });
  }, [enabled, me]);

  // ---------------------------------------------------------------- Softphone
  const log = (type: 'ring' | 'call' | 'answer' | 'hangup', callId: string, number = '') => post('/phone/softphone-event', { type, callId, number }).catch(() => {});

  const attachSession = useCallback((session: any, direction: 'in' | 'out', number: string) => {
    sessionRef.current = session;
    const id = session.id ?? String(Date.now());
    const playRemote = (pc: RTCPeerConnection) => pc.addEventListener('track', (e) => {
      if (!audioRef.current) { audioRef.current = new Audio(); audioRef.current.autoplay = true; }
      audioRef.current.srcObject = e.streams[0] ?? null;
    });
    if (session.connection) playRemote(session.connection);
    session.on('peerconnection', (e: any) => playRemote(e.peerconnection));
    session.on('confirmed', () => { ringtone.current?.stop(); setIncomingSoft(null); setActive((a) => (a ? { ...a, state: 'talking', since: Date.now() } : a)); void log('answer', id); });
    const end = () => { ringtone.current?.stop(); setIncomingSoft(null); setActive(null); sessionRef.current = null; void log('hangup', id); };
    session.on('ended', end);
    session.on('failed', (e: any) => { end(); if (e?.cause && !/Canceled|Terminated|Rejected/i.test(e.cause)) toast(`Anruf: ${e.cause}`, 'error'); });
    void log(direction === 'in' ? 'ring' : 'call', id, number);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cfg?.softphone) return;
    let ua: any;
    let stopped = false;
    (async () => {
      setSoft('connecting');
      try {
        const JsSIP = (await import('jssip')).default;
        if (stopped) return;
        const s = cfg.softphone!;
        ua = new JsSIP.UA({ sockets: [new JsSIP.WebSocketInterface(s.wsUrl)], uri: `sip:${s.user}@${s.domain}`, password: s.password, register: true, session_timers: false, user_agent: 'AperioPlan Softphone' });
        uaRef.current = ua;
        ua.on('registered', () => { setSoft('ready'); setSoftError(''); });
        ua.on('registrationFailed', (e: any) => { setSoft('error'); setSoftError(e?.cause ?? 'Anmeldung an der Telefonanlage fehlgeschlagen'); });
        ua.on('disconnected', () => setSoft((x) => (x === 'ready' ? 'connecting' : x)));
        ua.on('newRTCSession', (e: any) => {
          if (e.originator !== 'remote') return;
          if (sessionRef.current) { e.session.terminate({ status_code: 486 }); return; }
          const number = e.request?.from?.uri?.user ?? 'unbekannt';
          const name = e.request?.from?.display_name;
          attachSession(e.session, 'in', number);
          setIncomingSoft({ number, name });
          setActive({ number, name, direction: 'in', state: 'ringing', muted: false, held: false });
          ringtone.current = playRingtone();
        });
        ua.start();
      } catch (e) { setSoft('error'); setSoftError((e as Error).message); }
    })();
    return () => { stopped = true; try { ua?.stop(); } catch { /* bereits beendet */ } uaRef.current = null; setSoft('off'); };
  }, [cfg?.softphone?.wsUrl, cfg?.softphone?.user, cfg?.softphone?.password]); // eslint-disable-line react-hooks/exhaustive-deps

  const callSoft = (number: string, name?: string) => {
    const ua = uaRef.current;
    if (!ua || soft !== 'ready') { toast('Das Softphone ist nicht verbunden', 'error'); return; }
    if (sessionRef.current) { toast('Es läuft bereits ein Gespräch', 'error'); return; }
    const session = ua.call(`sip:${number}@${cfg!.softphone!.domain}`, { mediaConstraints: { audio: true, video: false } });
    setActive({ number, name, direction: 'out', state: 'calling', muted: false, held: false });
    attachSession(session, 'out', number);
  };

  const dial = async (number: string) => {
    try {
      const r = await post<{ method: string; number: string }>('/phone/dial', { number });
      if (r.method === 'softphone') callSoft(r.number);
      else if (r.method === 'tel') window.location.href = `tel:${r.number}`;
      else toast(r.method === 'fritzbox' ? 'Ihr Telefon klingelt gleich – abheben, dann wird gewählt' : 'Ihr sipgate-Telefon klingelt gleich');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const api: PhoneApi = { dial, soft, softError, active };

  return (
    <Ctx.Provider value={enabled ? api : null}>
      {children}
      {enabled && createPortal(
        <div className="phone-stack">
          {active && (
            <div className="card phone-card live">
              <div className="row"><Icon name="phone" /> <b className="grow">{active.name || active.number}</b>
                <span className="small muted">{active.state === 'ringing' ? 'klingelt' : active.state === 'calling' ? 'wählt …' : <CallTimer since={active.since} />}</span></div>
              {active.name && <div className="small muted">{active.number}</div>}
              <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
                {incomingSoft && <button className="btn sm primary" onClick={() => sessionRef.current?.answer({ mediaConstraints: { audio: true, video: false } })}><Icon name="phone" /> Annehmen</button>}
                {active.state === 'talking' && <>
                  <button className={`btn sm ${active.muted ? 'danger solid' : ''}`} onClick={() => { const s = sessionRef.current; if (!s) return; active.muted ? s.unmute({ audio: true }) : s.mute({ audio: true }); setActive({ ...active, muted: !active.muted }); }}>
                    <Icon name={active.muted ? 'mic-off' : 'mic'} /> {active.muted ? 'stumm' : 'Mikro'}</button>
                  <button className={`btn sm ${active.held ? 'primary' : ''}`} onClick={() => { const s = sessionRef.current; if (!s) return; active.held ? s.unhold() : s.hold(); setActive({ ...active, held: !active.held }); }}>{active.held ? 'Fortsetzen' : 'Halten'}</button>
                  <Dtmf onKey={(k) => sessionRef.current?.sendDTMF(k)} />
                </>}
                <button className="btn sm danger solid" onClick={() => sessionRef.current?.terminate()}><Icon name="x" /> {incomingSoft ? 'Ablehnen' : 'Auflegen'}</button>
              </div>
            </div>
          )}
          {rings.map((r) => (
            <div key={r.id} className="card phone-card">
              <div className="row"><Icon name="phone" /> <span className="small muted grow">{r.direction === 'in' ? 'Eingehender Anruf' : 'Ausgehender Anruf'}</span>
                <button className="btn ghost sm" onClick={() => setRings((x) => x.filter((y) => y.id !== r.id))}><Icon name="x" /></button></div>
              <CallerInfo caller={r.caller} number={r.number} />
              <div className="row" style={{ marginTop: 8, gap: 6 }}>
                {r.caller?.accountId && <Link className="btn sm" to={`/crm/${r.caller.accountId}`} onClick={() => setRings((x) => x.filter((y) => y.id !== r.id))}><Icon name="building" /> Kunde öffnen</Link>}
                <button className="btn sm" onClick={() => setNoteFor(r)}><Icon name="note" /> Notiz</button>
              </div>
            </div>
          ))}
        </div>, document.body)}
      {noteFor && <CallNoteModal call={noteFor} onClose={() => setNoteFor(null)} />}
    </Ctx.Provider>
  );
}

function CallTimer({ since }: { since?: number }) {
  const [, t] = useState(0);
  useEffect(() => { const i = setInterval(() => t((x) => x + 1), 1000); return () => clearInterval(i); }, []);
  const s = since ? Math.floor((Date.now() - since) / 1000) : 0;
  return <span className="mono">{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

function Dtmf({ onKey }: { onKey: (k: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative' }}>
      <button className="btn sm" onClick={() => setOpen(!open)} title="Tastenfeld">#</button>
      {open && <div className="dialpad mini">{'123456789*0#'.split('').map((k) => <button key={k} className="btn sm" onClick={() => onKey(k)}>{k}</button>)}</div>}
    </span>
  );
}

export function CallerInfo({ caller, number }: { caller: Caller | null; number: string }) {
  if (!caller) return <div style={{ marginTop: 6 }}><b style={{ fontSize: 16 }}>{number}</b><div className="small muted">nicht im CRM</div></div>;
  return (
    <div style={{ marginTop: 6 }}>
      <b style={{ fontSize: 16 }}>{caller.name}</b>
      {caller.kind === 'contact' && <div className="small">{[caller.position, caller.accountName].filter(Boolean).join(' · ')}</div>}
      {caller.kind === 'colleague' && <div className="small">Kollege</div>}
      <div className="small muted">{number}{caller.accountNumber ? ` · Kd.-Nr. ${caller.accountNumber}` : ''}{caller.city ? ` · ${caller.city}` : ''}</div>
      {(caller.openCases || caller.openQuotes) ? <div className="small" style={{ marginTop: 4 }}>{caller.openCases ? <span className="pill" style={{ background: 'var(--red-soft)' }}>{caller.openCases} offene Reklamation{caller.openCases > 1 ? 'en' : ''}</span> : null} {caller.openQuotes ? <span className="pill">{caller.openQuotes} offene Angebote</span> : null}</div> : null}
      {caller.lastNote && <div className="small muted" style={{ marginTop: 4, borderLeft: '2px solid var(--line)', paddingLeft: 6 }}>Letzte Notiz ({fmtDateTime(caller.lastNote.at)}{caller.lastNote.by ? `, ${caller.lastNote.by}` : ''}): {caller.lastNote.body.slice(0, 140)}</div>}
    </div>
  );
}

export function CallNoteModal({ call, onClose, onSaved }: { call: { id: string; caller?: Caller | null; number?: string; accountName?: string | null; accountId?: string | null }; onClose: () => void; onSaved?: () => void }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const accountId = call.caller?.accountId ?? call.accountId;
  const [toCrm, setToCrm] = useState(Boolean(accountId));
  return (
    <Modal title="Gesprächsnotiz" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Später</button>
      <button className="btn primary" disabled={!body.trim()} onClick={async () => {
        try { await post(`/phone/calls/${call.id}/note`, { body, toCrm }); toast(toCrm ? 'Notiz im Kundenverlauf gespeichert' : 'Notiz gespeichert'); onSaved?.(); onClose(); } catch (e) { toast((e as Error).message, 'error'); }
      }}>Speichern</button></>}>
      <div className="small muted" style={{ marginBottom: 8 }}>{call.caller?.name ?? call.accountName ?? call.number}</div>
      <Field label="Worum ging es?"><textarea autoFocus rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="z. B. fragt nach Liefertermin, Rückruf bis Freitag zugesagt" /></Field>
      {accountId && <label className="row small"><input type="checkbox" checked={toCrm} onChange={(e) => setToCrm(e.target.checked)} /> Im Verlauf des Kunden speichern</label>}
    </Modal>
  );
}

/** Klingelton ohne Audiodatei */
function playRingtone() {
  try {
    const ac = new AudioContext();
    let on = true;
    const beep = () => {
      if (!on) return;
      const o = ac.createOscillator(); const g = ac.createGain();
      o.frequency.value = 440; g.gain.value = 0.08; o.connect(g); g.connect(ac.destination);
      o.start(); o.stop(ac.currentTime + 0.8);
      setTimeout(beep, 2500);
    };
    beep();
    return { stop: () => { on = false; void ac.close(); } };
  } catch { return { stop: () => {} }; }
}
