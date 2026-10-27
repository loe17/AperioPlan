import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { Icon } from '../components/Icon';

/**
 * Videoanruf im Browser (WebRTC, ohne Zusatzsoftware) mit Bildschirmfreigabe.
 * Jeder Teilnehmer verbindet sich direkt mit jedem anderen (Mesh) – ideal für kleine Runden bis ca. 6 Personen.
 * Die Signalisierung läuft über den WebSocket-Kanal call:<channelId>.
 */
export function VideoCall({ channelId, title, onClose }: { channelId: string; title: string; onClose: () => void }) {
  const { me, users } = useSession();
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');
  const peers = useRef(new Map<string, RTCPeerConnection>());
  const localRef = useRef<MediaStream | null>(null);
  const screenRef = useRef<MediaStream | null>(null);
  const iceRef = useRef<RTCIceServer[]>([]);
  const channel = `call:${channelId}`;

  const send = (to: string, data: unknown) => realtime.send({ type: 'signal', to, callId: channelId, data });

  const createPeer = (userId: string) => {
    let pc = peers.current.get(userId);
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...iceRef.current] });
    peers.current.set(userId, pc);
    const stream = screenRef.current ?? localRef.current;
    localRef.current?.getAudioTracks().forEach((t) => pc!.addTrack(t, localRef.current!));
    stream?.getVideoTracks().forEach((t) => pc!.addTrack(t, localRef.current!));
    pc.onicecandidate = (e) => e.candidate && send(userId, { candidate: e.candidate });
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
  };

  useEffect(() => {
    let alive = true;
    let unsub = () => {};
    (async () => {
      try {
        const r = await post(`/chat/channels/${channelId}/call`);
        iceRef.current = r.iceServers ?? [];
        let stream: MediaStream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720 } }); }
        catch { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); setCam(false); }
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        localRef.current = stream;
        setLocal(stream);
        unsub = realtime.subscribe(channel, async (event, data) => {
          if (event === 'call.joined' && data.userId !== me?.id) {
            // Neuer Teilnehmer: wir rufen ihn an
            const pc = createPeer(data.userId);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            send(data.userId, { sdp: pc.localDescription });
          } else if (event === 'call.left') {
            removePeer(data.userId);
          } else if (event === 'signal') {
            const from = data.from as string;
            const msg = data.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
            const pc = createPeer(from);
            if (msg.sdp) {
              await pc.setRemoteDescription(msg.sdp);
              if (msg.sdp.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                send(from, { sdp: pc.localDescription });
              }
            } else if (msg.candidate) {
              try { await pc.addIceCandidate(msg.candidate); } catch { /* veraltet */ }
            }
          }
        });
      } catch (e) {
        setError(`Kamera/Mikrofon nicht verfügbar: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
      unsub();
      peers.current.forEach((pc) => pc.close());
      peers.current.clear();
      localRef.current?.getTracks().forEach((t) => t.stop());
      screenRef.current?.getTracks().forEach((t) => t.stop());
      void post(`/chat/channels/${channelId}/call/end`).catch(() => {});
    };
  }, [channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceVideo = (track: MediaStreamTrack | null) => {
    peers.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) void sender.replaceTrack(track);
      else if (track) pc.addTrack(track, localRef.current!);
    });
  };

  const toggleShare = async () => {
    if (sharing) {
      screenRef.current?.getTracks().forEach((t) => t.stop());
      screenRef.current = null;
      replaceVideo(localRef.current?.getVideoTracks()[0] ?? null);
      setSharing(false);
      return;
    }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenRef.current = screen;
      const track = screen.getVideoTracks()[0]!;
      track.onended = () => { if (screenRef.current) void toggleShare(); };
      replaceVideo(track);
      setSharing(true);
    } catch { /* abgebrochen */ }
  };

  const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? 'Teilnehmer';

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: '#0b0c0e', zIndex: 70, display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ padding: '10px 16px', color: '#e6edf3' }}>
        <b><Icon name="video" /> {title}</b><span className="small" style={{ opacity: 0.6 }}>{Object.keys(streams).length + 1} Teilnehmer</span>
        {error && <span style={{ color: '#f0817d' }}>{error}</span>}
      </div>
      <div className="video-grid" style={{ flex: 1, alignContent: 'center' }}>
        <VideoTile stream={sharing ? screenRef.current : local} label={`${me?.displayName} (Sie)${sharing ? ' – Bildschirm' : ''}`} muted mirror={!sharing} />
        {Object.entries(streams).map(([id, s]) => <VideoTile key={id} stream={s} label={nameOf(id)} />)}
        {Object.keys(streams).length === 0 && <div style={{ color: '#7d8590', textAlign: 'center', alignSelf: 'center' }}>Warte auf weitere Teilnehmer …<br />Kollegen sehen eine Einladung im Chat.</div>}
      </div>
      <div className="row" style={{ justifyContent: 'center', padding: 14, gap: 10 }}>
        <button className="btn" onClick={() => { localRef.current?.getAudioTracks().forEach((t) => (t.enabled = !mic)); setMic(!mic); }}>{mic ? 'Mikro an' : 'Mikro aus'}</button>
        <button className="btn" onClick={() => { localRef.current?.getVideoTracks().forEach((t) => (t.enabled = !cam)); setCam(!cam); }}>{cam ? 'Kamera an' : 'Kamera aus'}</button>
        <button className={`btn ${sharing ? 'primary' : ''}`} onClick={toggleShare}><Icon name="monitor" /> {sharing ? 'Freigabe beenden' : 'Bildschirm teilen'}</button>
        <button className="btn danger solid" onClick={onClose}><Icon name="phone" /> Auflegen</button>
      </div>
    </div>,
    document.body,
  );
}

function VideoTile({ stream, label, muted, mirror }: { stream: MediaStream | null; label: string; muted?: boolean; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return (
    <div style={{ position: 'relative' }}>
      <video ref={ref} autoPlay playsInline muted={muted} style={{ transform: mirror ? 'scaleX(-1)' : undefined }} />
      <span style={{ position: 'absolute', left: 8, bottom: 8, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 12, padding: '2px 8px', borderRadius: 6 }}>{label}</span>
    </div>
  );
}
