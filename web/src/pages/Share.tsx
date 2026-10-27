import { useEffect, useRef, useState } from 'react';
import { fmtBytes, fmtDate, fmtDateTime } from '../lib/format';
import { Field, StatusPill } from '../components/ui';
import { fileIcon } from '../modules/ProjectFiles';
import { Icon } from '../components/Icon';

/** Öffentliche Seite für Gast-, Teilen- und Anforderungslinks (ohne Anmeldung) */
export default function SharePage() {
  const token = location.pathname.split('/')[2] ?? '';
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState('');
  const [pw, setPw] = useState('');
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    fetch(`/api/public/links/${token}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) setError(j.error); else { setInfo(j); if (!j.needsPassword) setUnlocked(true); }
    }).catch(() => setError('Server nicht erreichbar'));
  }, [token]);

  const call = (url: string, init: RequestInit = {}) => fetch(`/api/public/links/${token}${url}`, { ...init, headers: { ...(init.headers ?? {}), ...(pw ? { 'x-link-password': pw } : {}) } });

  return (
    <div className="auth-wrap" style={{ alignItems: 'flex-start', paddingTop: '8vh' }}>
      <div className="auth-card" style={{ width: 'min(860px, 100%)' }}>
        <div className="row" style={{ marginBottom: 18 }}>
          <img className="logo" src="/logo-mark.svg" alt="" style={{ width: 32, height: 32 }} />
          <div><b>{info?.company ?? 'AperioPlan'}</b><div className="small muted">{info?.project}</div></div>
        </div>
        {error && <div className="error-text">{error}</div>}
        {info && info.expired && <div className="error-text">Dieser Link ist abgelaufen.</div>}
        {info && !info.expired && !unlocked && (
          <form onSubmit={async (e) => {
            e.preventDefault();
            const r = await call(info.kind === 'request' ? '' : info.kind === 'guest' && !info.areas.includes('files') ? (info.areas.includes('tasks') ? '/tasks' : '/drawings') : '/files');
            if (r.ok) setUnlocked(true); else setError('Passwort falsch');
          }}>
            <Field label="Dieser Link ist passwortgeschützt"><input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <button className="btn primary">Öffnen</button>
          </form>
        )}
        {info && unlocked && !info.expired && (
          <>
            <h2 style={{ marginBottom: 4 }}>{info.label || { share: 'Geteilte Dateien', request: 'Dateien hochladen', guest: 'Gastzugang' }[info.kind as string]}</h2>
            <div className="small muted" style={{ marginBottom: 16 }}>{info.creator && `Bereitgestellt von ${info.creator}`}{info.expiresAt && ` · gültig bis ${fmtDateTime(info.expiresAt)}`}</div>
            {info.kind === 'request' && <RequestUpload call={call} />}
            {(info.kind === 'share' || (info.kind === 'guest' && info.areas.includes('files'))) && <PublicFiles call={call} token={token} pw={pw} />}
            {info.kind === 'guest' && info.areas.includes('drawings') && <PublicDrawings call={call} token={token} pw={pw} />}
            {info.kind === 'guest' && info.areas.includes('tasks') && <PublicTasks call={call} />}
          </>
        )}
      </div>
    </div>
  );
}

type Call = (url: string, init?: RequestInit) => Promise<Response>;

function PublicFiles({ call, token, pw }: { call: Call; token: string; pw: string }) {
  const [path, setPath] = useState('');
  const [data, setData] = useState<any>(null);
  useEffect(() => { call(`/files?path=${encodeURIComponent(path)}`).then((r) => r.json()).then(setData); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const dl = (e: any) => `/api/public/links/${token}/download?${e.id && !e.relPath.includes('/') && !path ? `fileId=${e.id}` : `path=${encodeURIComponent(e.relPath)}`}${pw ? `&pw=${encodeURIComponent(pw)}` : ''}`;
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={{ marginBottom: 8 }}><Icon name="folder" /> Dateien {path && <span className="muted">/ {path}</span>}</h3>
      <div className="table-wrap"><table className="table"><tbody>
        {path && <tr className="click" onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}><td colSpan={3}><Icon name="upload" /> ..</td></tr>}
        {data?.entries?.map((e: any) => (
          <tr key={e.relPath} className="click" onClick={() => (e.isDir ? setPath(e.relPath) : (location.href = dl(e)))}>
            <td><span className="row" style={{ gap: 6 }}><Icon name={fileIcon(e.name, e.isDir)} /> {e.name}</span></td><td className="small muted">{e.isDir ? '' : fmtBytes(e.size)}</td><td className="small muted">{fmtDate(e.modified)}</td>
          </tr>
        ))}
        {data?.entries?.length === 0 && <tr><td className="muted">Keine Dateien</td></tr>}
      </tbody></table></div>
    </div>
  );
}

function PublicDrawings({ call, token, pw }: { call: Call; token: string; pw: string }) {
  const [data, setData] = useState<any[]>([]);
  useEffect(() => { call('/drawings').then((r) => r.json()).then(setData); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={{ marginBottom: 8 }}><Icon name="cad" /> Freigegebene Zeichnungen</h3>
      {!data.length ? <div className="muted">Noch keine freigegebenen Zeichnungen</div> : (
        <div className="table-wrap"><table className="table"><tbody>
          {data.map((d) => <tr key={d.fileId}><td className="mono">{d.baseNumber}-{d.revision}</td><td>{d.designation}</td><td>{d.format.toUpperCase()}</td>
            <td><a className="btn sm" href={`/api/public/links/${token}/download?fileId=${d.fileId}${pw ? `&pw=${encodeURIComponent(pw)}` : ''}`}><Icon name="download" /> {d.name}</a></td></tr>)}
        </tbody></table></div>
      )}
    </div>
  );
}

function PublicTasks({ call }: { call: Call }) {
  const [data, setData] = useState<any[]>([]);
  useEffect(() => { call('/tasks').then((r) => r.json()).then(setData); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <h3 style={{ marginBottom: 8 }}><Icon name="list" /> Aufgaben & Termine</h3>
      <div className="table-wrap"><table className="table"><tbody>
        {data.map((t) => <tr key={t.number}><td className="mono muted">P{t.number}</td><td>{t.milestone && <Icon name="milestone" className="mr" />}{t.title}</td><td><StatusPill status={t.status} /></td><td>{fmtDate(t.dueDate)}</td></tr>)}
      </tbody></table></div>
    </div>
  );
}

function RequestUpload({ call }: { call: Call }) {
  const [name, setName] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const send = async (files: FileList | File[]) => {
    if (!files.length) return;
    if (!name.trim()) { setErr('Bitte zuerst Ihren Namen bzw. Ihre Firma angeben'); return; }
    setBusy(true); setErr('');
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    const r = await call('/upload', { method: 'POST', body: fd, headers: { 'x-uploader-name': name } });
    const j = await r.json();
    setBusy(false);
    if (r.ok) setDone((d) => [...d, ...j.files]); else setErr(j.error);
  };
  return (
    <div>
      <Field label="Ihr Name / Firma" required><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className={`dropzone ${over ? 'over' : ''}`} onClick={() => ref.current?.click()} style={{ cursor: 'pointer', padding: 40 }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); void send(e.dataTransfer.files); }}>
        {busy ? 'Wird hochgeladen …' : 'Dateien hierher ziehen oder klicken (auch große 3D-Dateien)'}
      </div>
      <input ref={ref} type="file" multiple hidden onChange={(e) => e.target.files && send(e.target.files)} />
      {err && <div className="error-text" style={{ marginTop: 8 }}>{err}</div>}
      {done.length > 0 && <div className="card" style={{ marginTop: 12, borderColor: 'var(--green)' }}><Icon name="check-circle" /> Erfolgreich übermittelt: {done.join(', ')}</div>}
    </div>
  );
}
