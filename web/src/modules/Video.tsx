import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { get, post, upload } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtBytes, fmtTime } from '../lib/format';
import { Avatar, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { BackgroundProcessor, builtinBackgrounds, type BackgroundMode } from './VideoBackground';
import type { Message } from './ChatView';

interface PeerState { mic: boolean; cam: boolean; hand: boolean; sharing: boolean; name?: string }
/** Gast ohne Benutzerkonto (Meeting-Link) */
export interface GuestInfo { token: string; guest: string; key: string; name: string }
interface Request { kind: 'screen' | 'control'; from: string; fromName: string }

export const REMOTE_HELPER_URL = 'https://github.com/loe17/AperioPlan/releases/latest/download/AperioPlan-Fernsteuerung.exe';

/**
 * Videoanruf im Browser (WebRTC, ohne Zusatzsoftware): Bildschirmfreigabe, Chat, Teilnehmer,
 * Hand heben, Hintergrund, Dateien senden und – mit Hilfsprogramm – Fernsteuerung.
 * Jeder Teilnehmer verbindet sich direkt mit jedem anderen (Mesh) – ideal für Runden bis ca. 6 Personen.
 * Die Signalisierung läuft über den WebSocket-Kanal call:<channelId>.
 */
export function VideoCall({ channelId, title, onClose, guest }: { channelId: string; title: string; onClose: () => void; guest?: GuestInfo }) {
  const { me, users } = useSession();
  const selfId = guest ? guest.guest : me!.id;
  const selfName = guest ? guest.name : me!.displayName;
  const [names, setNames] = useState<Record<string, string>>({});
  const gq = guest ? `guest=${guest.guest}&key=${encodeURIComponent(guest.key)}` : '';
  const toast = useToast();
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [states, setStates] = useState<Record<string, PeerState>>({});
  const [present, setPresent] = useState<string[]>([]);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [hand, setHand] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<'chat' | 'people' | null>(null);
  const [bgMenu, setBgMenu] = useState(false);
  const [bg, setBg] = useState<BackgroundMode>({ kind: 'none' });
  const [info, setInfo] = useState<{ callId: string; hostId: string | null; startedAt: string } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const [requests, setRequests] = useState<Request[]>([]);
  const [controlling, setControlling] = useState<string | null>(null);
  const [controlledBy, setControlledBy] = useState<string | null>(null);
  const [helperOnline, setHelperOnline] = useState(false);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [, tick] = useState(0);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  const localRef = useRef<MediaStream | null>(null);
  const camTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenRef = useRef<MediaStream | null>(null);
  const iceRef = useRef<RTCIceServer[]>([]);
  const procRef = useRef<BackgroundProcessor | null>(null);
  const stateRef = useRef<PeerState>({ mic: true, cam: true, hand: false, sharing: false });
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const channel = `call:${channelId}`;
  const isHost = Boolean(!guest && me && (info?.hostId === me.id || me.role === 'admin'));

  const signal = (to: string, data: unknown) => realtime.send({ type: 'signal', to, callId: channelId, data });
  const callEvent = (event: string, data?: unknown, to?: string) => realtime.send({ type: 'call-event', callId: channelId, event, data, to });
  const shareState = (patch: Partial<PeerState>, to?: string) => { stateRef.current = { ...stateRef.current, ...patch }; callEvent('state', { ...stateRef.current, name: selfName }, to); };
  const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? names[id] ?? 'Teilnehmer';

  const outgoingVideo = () => screenRef.current?.getVideoTracks()[0] ?? localRef.current?.getVideoTracks()[0] ?? null;

  const createPeer = (userId: string) => {
    let pc = peers.current.get(userId);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...iceRef.current] });
    peers.current.set(userId, pc);
    localRef.current?.getAudioTracks().forEach((t) => pc!.addTrack(t, localRef.current!));
    const v = outgoingVideo();
    if (v) pc.addTrack(v, localRef.current!);
    pc.onicecandidate = (e) => e.candidate && signal(userId, { candidate: e.candidate });
    pc.ontrack = (e) => setStreams((s) => ({ ...s, [userId]: e.streams[0]! }));
    pc.onconnectionstatechange = () => {
      if (pc!.connectionState === 'failed' || pc!.connectionState === 'closed') removePeer(userId);
    };
    return pc;
  };

  const removePeer = (userId: string) => {
    peers.current.get(userId)?.close();
    peers.current.delete(userId);
    setStreams((s) => { const c = { ...s }; delete c[userId]; return c; });
    setPresent((p) => p.filter((x) => x !== userId));
    setControlling((c) => (c === userId ? null : c));
    setControlledBy((c) => (c === userId ? null : c));
  };

  const replaceVideo = (track: MediaStreamTrack | null) => {
    peers.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video' || (s.track === null && s.transport));
      if (sender) void sender.replaceTrack(track);
      else if (track) pc.addTrack(track, localRef.current!);
    });
  };

  // ---------------------------------------------------------------- Aufbau
  useEffect(() => {
    let alive = true;
    let unsubCall = () => {};
    let unsubChat = () => {};
    let unsubUser = () => {};
    (async () => {
      try {
        type CallInfo = { callId: string; iceServers: RTCIceServer[]; hostId: string | null; startedAt: string };
        const r = guest ? await get<CallInfo>(`/meet/${guest.token}/status?${gq}`) : await post<CallInfo>(`/chat/channels/${channelId}/call`);
        iceRef.current = r.iceServers ?? [];
        setInfo({ callId: r.callId, hostId: r.hostId, startedAt: r.startedAt });
        get<Message[]>(guest ? `/meet/${guest.token}/messages?${gq}&callId=${r.callId}` : `/chat/calls/${r.callId}/messages`).then(setMessages).catch(() => {});
        let stream: MediaStream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720 } }); }
        catch { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); setCam(false); stateRef.current.cam = false; }
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        camTrackRef.current = stream.getVideoTracks()[0] ?? null;
        localRef.current = stream;
        setLocal(stream);
        if (me) get<{ connected: boolean }>(`/remote/helper/${me.id}`).then((h) => setHelperOnline(h.connected)).catch(() => {});
        unsubUser = me ? realtime.subscribe(`user:${me.id}`, (event, data) => { if (event === 'remote.helper') setHelperOnline(Boolean(data.connected)); }) : () => {};
        unsubChat = guest ? () => {} : realtime.subscribe(`chat:${channelId}`, () => {});
        unsubCall = realtime.subscribe(channel, async (event, data) => {
          if (event === 'call.joined' && data.userId !== selfId) {
            if (data.displayName) setNames((n) => ({ ...n, [data.userId]: data.displayName }));
            setPresent((p) => (p.includes(data.userId) ? p : [...p, data.userId]));
            const pc = createPeer(data.userId);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            signal(data.userId, { sdp: pc.localDescription });
            shareState({}, data.userId);
          } else if (event === 'call.left') {
            removePeer(data.userId);
          } else if (event === 'signal') {
            const from = data.from as string;
            setPresent((p) => (p.includes(from) ? p : [...p, from]));
            const msg = data.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
            const pc = createPeer(from);
            if (msg.sdp) {
              await pc.setRemoteDescription(msg.sdp);
              if (msg.sdp.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                signal(from, { sdp: pc.localDescription });
                shareState({}, from);
              }
            } else if (msg.candidate) {
              try { await pc.addIceCandidate(msg.candidate); } catch { /* veraltet */ }
            }
          } else if (event === 'call.event') {
            handleEvent(data.event, data.from, data.fromName, data.data);
          } else if (event === 'call.message') {
            setMessages((m) => (m.some((x) => x.id === data.id) ? m : [...m, data]));
            if (panelRef.current !== 'chat' && data.userId !== selfId && data.guestId !== selfId) setUnreadChat((n) => n + 1);
          } else if (event === 'remote.granted') {
            if (data.controller === me?.id) {
              setControlling(data.target);
              if (!data.helperOnline) toast(`${nameOf(data.target)} hat zugestimmt – das Hilfsprogramm auf dessen Rechner ist aber nicht gestartet.`, 'error');
              else toast(`Sie steuern jetzt den Bildschirm von ${nameOf(data.target)}`);
            }
            if (data.target === me?.id) setControlledBy(data.controller);
          } else if (event === 'remote.revoked') {
            if (data.target === me?.id) setControlledBy(null);
            setControlling((c) => (c === data.target ? null : c));
          }
        });
      } catch (e) {
        setError(`Kamera/Mikrofon nicht verfügbar: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
      unsubCall(); unsubChat(); unsubUser();
      peers.current.forEach((pc) => pc.close());
      peers.current.clear();
      procRef.current?.stop();
      localRef.current?.getTracks().forEach((t) => t.stop());
      camTrackRef.current?.stop();
      screenRef.current?.getTracks().forEach((t) => t.stop());
      void (guest ? post(`/meet/${guest.token}/leave`, { guest: guest.guest, key: guest.key }) : post(`/chat/channels/${channelId}/call/end`)).catch(() => {});
    };
  }, [channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const leave = () => onClose();

  const handleEvent = (event: string, from: string, fromName: string, data: any) => {
    if (event === 'state') { setStates((s) => ({ ...s, [from]: data as PeerState })); if (data?.name) setNames((n) => (n[from] === data.name ? n : { ...n, [from]: data.name })); }
    else if (event === 'mute') { setMicOn(false); toast(`${fromName} hat Ihr Mikrofon stummgeschaltet`); }
    else if (event === 'kick') { toast(`${fromName} hat Sie aus dem Anruf genommen`, 'error'); onClose(); }
    else if (event === 'end-for-all') { toast(`${fromName} hat den Anruf für alle beendet`); onClose(); }
    else if (event === 'request-screen') setRequests((r) => [...r.filter((x) => !(x.kind === 'screen' && x.from === from)), { kind: 'screen', from, fromName }]);
    else if (event === 'request-control') setRequests((r) => [...r.filter((x) => !(x.kind === 'control' && x.from === from)), { kind: 'control', from, fromName }]);
    else if (event === 'request-declined') toast(`${fromName} hat die Anfrage abgelehnt`);
  };

  // ---------------------------------------------------------------- Sprecher erkennen (leuchtender Rand)
  useEffect(() => {
    const ac = new AudioContext();
    const meters: { id: string; an: AnalyserNode; src: MediaStreamAudioSourceNode }[] = [];
    const all: [string, MediaStream | null][] = [[selfId, local], ...Object.entries(streams)];
    for (const [id, s] of all) {
      if (!s || !s.getAudioTracks().length) continue;
      const src = ac.createMediaStreamSource(s);
      const an = ac.createAnalyser(); an.fftSize = 512;
      src.connect(an);
      meters.push({ id, an, src });
    }
    const buf = new Uint8Array(256);
    const timer = setInterval(() => {
      const now = new Set<string>();
      for (const m of meters) {
        m.an.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        if (avg > 18) now.add(m.id);
      }
      setSpeaking((old) => (old.size === now.size && [...now].every((x) => old.has(x)) ? old : now));
    }, 250);
    return () => { clearInterval(timer); meters.forEach((m) => m.src.disconnect()); void ac.close(); };
  }, [local, streams, selfId]);

  // Laufzeit-Anzeige
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  // ---------------------------------------------------------------- Bedienung
  const setMicOn = (on: boolean) => { localRef.current?.getAudioTracks().forEach((t) => (t.enabled = on)); setMic(on); shareState({ mic: on }); };
  const setCamOn = (on: boolean) => { localRef.current?.getVideoTracks().forEach((t) => (t.enabled = on)); setCam(on); shareState({ cam: on }); };

  const applyBackground = async (mode: BackgroundMode) => {
    setBgMenu(false);
    const camTrack = camTrackRef.current;
    if (!camTrack || !localRef.current) { toast('Keine Kamera verfügbar', 'error'); return; }
    try {
      let videoTrack: MediaStreamTrack = camTrack;
      if (mode.kind === 'none') { procRef.current?.stop(); procRef.current = null; }
      else if (procRef.current) { await procRef.current.setMode(mode); setBg(mode); return; }
      else { procRef.current = new BackgroundProcessor(); videoTrack = await procRef.current.start(camTrack, mode); }
      const s = localRef.current;
      s.getVideoTracks().forEach((t) => { if (t !== camTrack) t.stop(); s.removeTrack(t); });
      s.addTrack(videoTrack);
      videoTrack.enabled = cam;
      if (!screenRef.current) replaceVideo(videoTrack);
      setLocal(new MediaStream(s.getTracks()));
      setBg(mode);
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const toggleShare = async () => {
    if (sharing) {
      screenRef.current?.getTracks().forEach((t) => t.stop());
      screenRef.current = null;
      replaceVideo(localRef.current?.getVideoTracks()[0] ?? null);
      setSharing(false); shareState({ sharing: false });
      if (controlledBy) realtime.send({ type: 'remote-revoke', callId: channelId });
      return;
    }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenRef.current = screen;
      const track = screen.getVideoTracks()[0]!;
      track.onended = () => { if (screenRef.current) void toggleShare(); };
      replaceVideo(track);
      setSharing(true); shareState({ sharing: true });
    } catch { /* abgebrochen */ }
  };

  const answer = async (r: Request, yes: boolean) => {
    setRequests((x) => x.filter((y) => y !== r));
    if (!yes) { callEvent('request-declined', { kind: r.kind }, r.from); return; }
    if (r.kind === 'screen') { if (!sharing) await toggleShare(); return; }
    // Fernsteuerung erlauben: der Bildschirm muss geteilt sein, das Hilfsprogramm muss laufen
    if (!sharing) await toggleShare();
    realtime.send({ type: 'remote-grant', callId: channelId, to: r.from });
  };

  const sendChat = async (body: string, files?: FileList) => {
    if (guest) {
      if (files?.length) { toast('Als Gast können Sie keine Dateien senden', 'error'); return; }
      try {
        const m = await post<Message>(`/meet/${guest.token}/messages`, { guest: guest.guest, key: guest.key, callId: info?.callId, body });
        setMessages((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]));
      } catch (e) { toast((e as Error).message, 'error'); }
      return;
    }
    try {
      let attachments: unknown[] = [];
      if (files?.length) {
        const fd = new FormData();
        for (const f of files) fd.append('file', f, f.name);
        attachments = await upload(`/chat/channels/${channelId}/upload`, fd);
      }
      const m = await post<Message>(`/chat/channels/${channelId}/messages`, { body, attachments, callId: info?.callId });
      setMessages((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]));
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const participants = [selfId, ...present.filter((p) => p !== selfId)];
  const elapsed = info ? Math.max(0, Math.floor((Date.now() - new Date(info.startedAt).getTime()) / 1000)) : 0;
  const hhmm = `${Math.floor(elapsed / 3600) ? `${Math.floor(elapsed / 3600)}:` : ''}${String(Math.floor(elapsed / 60) % 60).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  return createPortal(
    <div className="call">
      <div className="call-top">
        <b className="row" style={{ gap: 8 }}><Icon name="video" /> {title}</b>
        <span className="call-time mono">{hhmm}</span>
        <span className="small" style={{ opacity: 0.7 }}>{participants.length} Teilnehmer</span>
        {controlledBy && <span className="call-banner warn"><Icon name="mouse" /> {nameOf(controlledBy)} steuert Ihren Bildschirm
          <button className="btn sm" onClick={() => realtime.send({ type: 'remote-revoke', callId: channelId })}>Beenden</button></span>}
        {error && <span style={{ color: '#f0817d' }}>{error}</span>}
        <span className="grow" />
        <button className={`btn sm ${panel === 'people' ? 'primary' : ''}`} onClick={() => setPanel(panel === 'people' ? null : 'people')}><Icon name="users" /> Teilnehmer</button>
        <button className={`btn sm ${panel === 'chat' ? 'primary' : ''}`} onClick={() => { setPanel(panel === 'chat' ? null : 'chat'); setUnreadChat(0); }}>
          <Icon name="chat" /> Chat{unreadChat > 0 && <span className="count">{unreadChat}</span>}
        </button>
      </div>

      {requests.map((r) => (
        <div key={`${r.kind}-${r.from}`} className="call-request">
          <Icon name={r.kind === 'screen' ? 'screen-share' : 'mouse'} />
          <span className="grow">{r.kind === 'screen' ? <><b>{r.fromName}</b> bittet Sie, Ihren Bildschirm zu teilen.</>
            : <><b>{r.fromName}</b> möchte Ihren Bildschirm mit Maus und Tastatur steuern.
              {!helperOnline && <> Dafür muss auf diesem Rechner das Hilfsprogramm <b>AperioPlan Fernsteuerung</b> laufen – <a href={REMOTE_HELPER_URL} target="_blank" rel="noreferrer">herunterladen</a>, starten, dann erlauben.</>}</>}</span>
          <button className="btn sm primary" disabled={r.kind === 'control' && !helperOnline} onClick={() => answer(r, true)}>{r.kind === 'screen' ? 'Teilen' : 'Erlauben'}</button>
          <button className="btn sm" onClick={() => answer(r, false)}>Ablehnen</button>
        </div>
      ))}

      <div className="call-body">
        <div className="video-grid">
          <VideoTile stream={sharing ? screenRef.current : local} label={`${selfName} (Sie)${sharing ? ' – Bildschirm' : ''}`} muted mirror={!sharing && bg.kind === 'none'}
            speaking={speaking.has(selfId)} state={{ mic, cam, hand, sharing }} userId={selfId} name={selfName} />
          {Object.entries(streams).map(([id, s]) => (
            <VideoTile key={id} stream={s} label={nameOf(id)} speaking={speaking.has(id)} state={states[id]} userId={id} name={nameOf(id)}
              controlling={controlling === id ? channelId : null}
              onRequestControl={!guest && states[id]?.sharing && controlling !== id ? () => { callEvent('request-control', null, id); toast(`Anfrage an ${nameOf(id)} gesendet`); } : undefined}
              onStopControl={controlling === id ? () => realtime.send({ type: 'remote-revoke', callId: channelId, to: id }) : undefined} />
          ))}
          {Object.keys(streams).length === 0 && <div className="call-wait">Warte auf weitere Teilnehmer …{!guest && <><br />Kollegen sehen eine Einladung im Chat.</>}</div>}
        </div>
        {panel === 'people' && (
          <aside className="call-panel">
            <h3>Teilnehmer ({participants.length})</h3>
            {participants.map((id) => {
              const st = id === selfId ? { mic, cam, hand, sharing } : states[id];
              return (
                <div key={id} className={`call-person ${speaking.has(id) ? 'speaking' : ''}`}>
                  <Avatar id={id} name={nameOf(id)} />
                  <div className="grow">
                    <div>{id === selfId ? `${selfName} (Sie)` : nameOf(id)}{info?.hostId === id && <span className="pill" style={{ marginLeft: 6 }}>Gastgeber</span>}</div>
                    <div className="small" style={{ opacity: 0.7 }}>{st?.hand && 'Hand gehoben · '}{st?.sharing && 'teilt Bildschirm · '}{st?.mic === false ? 'stumm' : 'Mikro an'}</div>
                  </div>
                  {st?.hand && <Icon name="hand" />}
                  <Icon name={st?.mic === false ? 'mic-off' : 'mic'} />
                  {id !== selfId && (
                    <div className="call-person-actions">
                      {!st?.sharing && <button className="btn sm" title="Bildschirm anfordern" onClick={() => { callEvent('request-screen', null, id); toast(`Anfrage an ${nameOf(id)} gesendet`); }}><Icon name="screen-share" /></button>}
                      {!guest && st?.sharing && controlling !== id && <button className="btn sm" title="Steuerung anfragen" onClick={() => { callEvent('request-control', null, id); toast(`Anfrage an ${nameOf(id)} gesendet`); }}><Icon name="mouse" /></button>}
                      {isHost && st?.mic !== false && <button className="btn sm" title="Stummschalten" onClick={() => callEvent('mute', null, id)}><Icon name="mic-off" /></button>}
                      {isHost && <button className="btn sm danger" title="Aus dem Anruf nehmen" onClick={() => callEvent('kick', null, id)}><Icon name="x" /></button>}
                    </div>
                  )}
                </div>
              );
            })}
          </aside>
        )}
        {panel === 'chat' && <CallChat messages={messages} onSend={sendChat} />}
      </div>

      <div className="call-controls">
        <button className={`btn ${mic ? '' : 'danger solid'}`} onClick={() => setMicOn(!mic)} title={mic ? 'Mikrofon ausschalten' : 'Mikrofon einschalten'}><Icon name={mic ? 'mic' : 'mic-off'} /> {mic ? 'Mikro an' : 'Mikro aus'}</button>
        <button className={`btn ${cam ? '' : 'danger solid'}`} onClick={() => setCamOn(!cam)}><Icon name={cam ? 'video' : 'video-off'} /> {cam ? 'Kamera an' : 'Kamera aus'}</button>
        <div style={{ position: 'relative' }}>
          <button className={`btn ${bg.kind !== 'none' ? 'primary' : ''}`} onClick={() => setBgMenu(!bgMenu)}><Icon name="image" /> Hintergrund</button>
          {bgMenu && <BackgroundMenu current={bg} onPick={applyBackground} onClose={() => setBgMenu(false)} />}
        </div>
        <button className={`btn ${sharing ? 'primary' : ''}`} onClick={toggleShare}><Icon name="screen-share" /> {sharing ? 'Freigabe beenden' : 'Bildschirm teilen'}</button>
        <button className={`btn ${hand ? 'primary' : ''}`} onClick={() => { setHand(!hand); shareState({ hand: !hand }); }}><Icon name="hand" /> {hand ? 'Hand senken' : 'Hand heben'}</button>
        {!guest && <button className="btn" onClick={() => { setPanel('chat'); setUnreadChat(0); }}><Icon name="paperclip" /> Datei senden</button>}
        <button className="btn danger solid" onClick={leave}><Icon name="phone" /> Verlassen</button>
        {isHost && present.length > 0 && <button className="btn danger" onClick={async () => { await post(`/chat/channels/${channelId}/call/end`, { forAll: true }).catch(() => {}); onClose(); }}>Für alle beenden</button>}
      </div>
    </div>,
    document.body,
  );
}

function BackgroundMenu({ current, onPick, onClose }: { current: BackgroundMode; onPick: (m: BackgroundMode) => void; onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [images] = useState(() => builtinBackgrounds());
  const own = (() => { try { return localStorage.getItem('aperio-call-bg'); } catch { return null; } })();
  return (
    <>
      <div className="overlay transparent" onClick={onClose} />
      <div className="dropdown-menu bg-menu" style={{ bottom: 'calc(100% + 6px)', top: 'auto', left: 0, right: 'auto', width: 300 }}>
        <div className={`item ${current.kind === 'none' ? 'active' : ''}`} onClick={() => onPick({ kind: 'none' })}><Icon name="x-circle" /> Kein Effekt</div>
        <div className={`item ${current.kind === 'blur' && current.strength < 10 ? 'active' : ''}`} onClick={() => onPick({ kind: 'blur', strength: 6 })}><Icon name="circle-dashed" /> Leicht unscharf</div>
        <div className={`item ${current.kind === 'blur' && current.strength >= 10 ? 'active' : ''}`} onClick={() => onPick({ kind: 'blur', strength: 14 })}><Icon name="circle" /> Stark unscharf</div>
        <div className="bg-thumbs">
          {images.map((i) => <img key={i.name} src={i.src} title={i.name} alt={i.name} className={current.kind === 'image' && current.src === i.src ? 'active' : ''} onClick={() => onPick({ kind: 'image', src: i.src })} />)}
          {own && <img src={own} title="Eigenes Bild" alt="Eigenes Bild" onClick={() => onPick({ kind: 'image', src: own })} />}
        </div>
        <div className="item" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Eigenes Bild …</div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return;
          const r = new FileReader();
          r.onload = () => { const src = String(r.result); try { localStorage.setItem('aperio-call-bg', src); } catch { /* zu groß */ } onPick({ kind: 'image', src }); };
          r.readAsDataURL(f);
        }} />
        <div className="small" style={{ padding: '4px 10px', opacity: 0.7 }}>Die Erkennung läuft nur auf diesem Rechner.</div>
      </div>
    </>
  );
}

function CallChat({ messages, onSend }: { messages: Message[]; onSend: (body: string, files?: FileList) => Promise<void> }) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [messages.length]);
  return (
    <aside className="call-panel call-chat">
      <h3>Chat im Anruf</h3>
      <div className="call-chat-list" ref={listRef}>
        {!messages.length && <div className="small" style={{ opacity: 0.6 }}>Nachrichten und Dateien aus dem Anruf erscheinen danach auch im Chat-Verlauf.</div>}
        {messages.map((m) => (
          <div key={m.id} className="call-msg">
            <div className="small"><b>{m.userName}</b> <span style={{ opacity: 0.6 }}>{fmtTime(m.createdAt)}</span></div>
            {m.body && <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>}
            {m.attachments?.map((a) => <a key={a.fileId} href={`/api/files/${a.fileId}/download`} target="_blank" rel="noreferrer" className="call-file"><Icon name="paperclip" /> {a.name} <span style={{ opacity: 0.6 }}>{fmtBytes(a.size)}</span></a>)}
          </div>
        ))}
      </div>
      <div className="call-chat-input">
        <button className="btn sm" title="Datei senden" onClick={() => fileRef.current?.click()}><Icon name="paperclip" /></button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void onSend(text, e.target.files).then(() => setText('')); e.target.value = ''; }} />
        <textarea rows={1} value={text} placeholder="Nachricht …" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && text.trim()) { e.preventDefault(); void onSend(text).then(() => setText('')); } }} />
      </div>
    </aside>
  );
}

function VideoTile({ stream, label, muted, mirror, speaking, state, userId, name, controlling, onRequestControl, onStopControl }: {
  stream: MediaStream | null; label: string; muted?: boolean; mirror?: boolean; speaking?: boolean; state?: PeerState; userId: string; name: string;
  controlling?: string | null; onRequestControl?: () => void; onStopControl?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const lastMove = useRef(0);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  const camOff = state && !state.cam && !state.sharing;

  /** Position im tatsächlich sichtbaren Bild (0 … 1), auch bei schwarzen Rändern */
  const norm = (e: ReactPointerEvent<HTMLDivElement>) => {
    const v = ref.current!;
    const r = v.getBoundingClientRect();
    const vw = v.videoWidth || r.width; const vh = v.videoHeight || r.height;
    const s = Math.min(r.width / vw, r.height / vh);
    const w = vw * s; const h = vh * s;
    const x = (e.clientX - r.left - (r.width - w) / 2) / w;
    const y = (e.clientY - r.top - (r.height - h) / 2) / h;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };
  const remote = (data: unknown) => controlling && realtime.send({ type: 'remote-input', callId: controlling, to: userId, data });
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>, t: 'keydown' | 'keyup') => {
    e.preventDefault();
    remote({ t, key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
  };

  return (
    <div className={`video-tile ${speaking ? 'speaking' : ''} ${controlling ? 'controlling' : ''}`}>
      <video ref={ref} autoPlay playsInline muted={muted} style={{ transform: mirror ? 'scaleX(-1)' : undefined, visibility: camOff ? 'hidden' : undefined }} />
      {camOff && <div className="video-off"><Avatar id={userId} name={name} size="xl" /></div>}
      {controlling && (
        <div className="remote-surface" tabIndex={0} title="Klicken, dann Maus und Tastatur steuern den entfernten Rechner"
          onPointerMove={(e) => { if (Date.now() - lastMove.current < 30) return; lastMove.current = Date.now(); remote({ t: 'move', ...norm(e) }); }}
          onPointerDown={(e) => { (e.target as HTMLElement).focus(); remote({ t: 'down', button: e.button, ...norm(e) }); }}
          onPointerUp={(e) => remote({ t: 'up', button: e.button, ...norm(e) })}
          onWheel={(e) => remote({ t: 'wheel', dx: Math.sign(e.deltaX), dy: Math.sign(e.deltaY) })}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => onKey(e, 'keydown')} onKeyUp={(e) => onKey(e, 'keyup')} />
      )}
      <span className="video-label">{state?.hand && <Icon name="hand" />} {state?.mic === false && <Icon name="mic-off" />} {label}</span>
      {onRequestControl && <button className="btn sm video-action" onClick={onRequestControl}><Icon name="mouse" /> Steuerung anfragen</button>}
      {onStopControl && <button className="btn sm danger solid video-action" onClick={onStopControl}><Icon name="mouse" /> Steuerung beenden</button>}
    </div>
  );
}
