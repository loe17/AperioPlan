import { useEffect, useRef, useState } from 'react';
import { get } from '../lib/api';

/** Word-, Excel- und PowerPoint-Dateien im Browser bearbeiten (Collabora Online via WOPI) */
export default function OfficePage() {
  const fileId = location.pathname.split('/')[2] ?? '';
  const [session, setSession] = useState<{ action: string; accessToken: string; accessTokenTtl: number; name: string; writable: boolean } | null>(null);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { get(`/office/${fileId}/session`).then(setSession).catch((e) => setError(e.message)); }, [fileId]);
  useEffect(() => { if (session) { document.title = `${session.name} – AperioPlan`; formRef.current?.submit(); } }, [session]);
  if (error) return <div className="page"><h2>Dokument kann nicht geöffnet werden</h2><p className="error-text">{error}</p></div>;
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {session && (
        <form ref={formRef} action={session.action} method="post" target="office_frame" style={{ display: 'none' }}>
          <input name="access_token" value={session.accessToken} readOnly />
          <input name="access_token_ttl" value={session.accessTokenTtl} readOnly />
        </form>
      )}
      <iframe name="office_frame" title="Office" style={{ flex: 1, border: 'none' }} allow="clipboard-read; clipboard-write; fullscreen" />
    </div>
  );
}
