import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/api';
import { Icon } from '../components/Icon';

/** Word-, Excel- und PowerPoint-Dateien im Browser bearbeiten (Collabora Online via WOPI) – im selben Fenster */
export default function OfficePage() {
  const fileId = location.pathname.split('/')[2] ?? '';
  const project = new URLSearchParams(location.search).get('project');
  const [session, setSession] = useState<{ action: string; accessToken: string; accessTokenTtl: number; name: string; writable: boolean } | null>(null);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // zurück dorthin, wo das Dokument geöffnet wurde (Ordner bleibt erhalten)
  const back = () => {
    if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
    else location.assign(project ? `/projects/${project}?tab=files` : '/');
  };
  useEffect(() => { get(`/office/${fileId}/session`).then(setSession).catch((e) => setError(e.message)); }, [fileId]);
  useEffect(() => { if (session) { document.title = `${session.name} – AperioPlan`; formRef.current?.submit(); } }, [session]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      let m: { MessageId?: string } = {};
      try { m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (m.MessageId === 'App_LoadingStatus') frameRef.current?.contentWindow?.postMessage(JSON.stringify({ MessageId: 'Host_PostmessageReady', SendTime: Date.now() }), e.origin);
      if (m.MessageId === 'UI_Close') back();
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div className="office-bar">
        <button className="btn ghost sm" onClick={back}><Icon name="chevron-left" /> Zurück</button>
        <b className="grow">{session?.name ?? ''}</b>
        {session && !session.writable && <span className="small muted">nur lesen</span>}
      </div>
      {error ? <div className="page"><h2>Dokument kann nicht geöffnet werden</h2><p className="error-text">{error}</p></div> : <>
        {session && (
          <form ref={formRef} action={session.action} method="post" target="office_frame" style={{ display: 'none' }}>
            <input name="access_token" value={session.accessToken} readOnly />
            <input name="access_token_ttl" value={session.accessTokenTtl} readOnly />
          </form>
        )}
        <iframe ref={frameRef} name="office_frame" title="Office" style={{ flex: 1, border: 'none' }} allow="clipboard-read; clipboard-write; fullscreen" />
      </>}
    </div>
  );
}
