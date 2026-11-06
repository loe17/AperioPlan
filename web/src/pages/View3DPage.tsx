import { useEffect, useState } from 'react';
import { api, get, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { Icon } from '../components/Icon';
import { Loading } from '../components/ui';
import { LazyViewer3D } from '../modules/View3D';

interface Info {
  kind: 'direct' | 'native'; name: string; format: string; label?: string; program?: string;
  conversion?: { status: 'queued' | 'running' | 'done' | 'failed'; error: string | null; worker: string | null } | null; workers?: string[]; anyWorker?: boolean;
}

/** 3D-Ansicht im ganzen Fenster: drehen, schneiden, messen – auch für native CAD-Dateien (über einen CAD-Arbeitsplatz) */
export default function View3DPage() {
  const q = new URLSearchParams(location.search);
  const back = q.get('back');
  const [fileId, setFileId] = useState<string | null>(q.get('file'));
  const src = q.get('src');
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const name = info?.name ?? q.get('name') ?? '3D-Modell';
  const goBack = () => {
    if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
    else location.assign(back && back.startsWith('/') ? back : '/');
  };
  const load = (id: string) => get<Info>(`/files/${id}/view3d`).then(setInfo).catch((e) => setError(e.message));
  useEffect(() => {
    const cad = q.get('cad');
    if (cad && !fileId) get<{ fileId: string }>(`/view3d/cad/${cad}`).then((r) => setFileId(r.fileId)).catch((e) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (fileId) void load(fileId); }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = `${name} – AperioPlan`; }, [name]);
  const download = fileId ? `/api/files/${fileId}/download` : src;

  let body;
  if (error) body = <div className="page"><h2>Die 3D-Ansicht lässt sich nicht öffnen</h2><p className="error-text">{error}</p></div>;
  else if (src && !fileId) body = src.startsWith('/api/') ? <LazyViewer3D src={src} name={name} height="100%" /> : <div className="page">Ungültige Adresse.</div>;
  else if (!info) body = <Loading />;
  else if (info.kind === 'direct') body = <LazyViewer3D src={`/api/files/${fileId}/download?inline=1`} name={info.name} height="100%" />;
  else body = <NativeView fileId={fileId!} info={info} reload={() => load(fileId!)} />;

  return (
    <div className="v3d-page">
      <div className="office-bar">
        <button className="btn ghost sm" onClick={goBack}><Icon name="chevron-left" /> Zurück</button>
        <Icon name="cube" /><b className="grow">{name}</b>
        {info?.label && <span className="small muted">{info.label}</span>}
        {download && <a className="btn sm" href={download}><Icon name="download" /> Herunterladen</a>}
      </div>
      <div className="v3d-page-body">{body}</div>
    </div>
  );
}

/** Native CAD-Datei: STEP-Umwandlung anstoßen, solange das Vorschaubild zeigen */
function NativeView({ fileId, info, reload }: { fileId: string; info: Info; reload: () => void }) {
  const c = info.conversion;
  const [requested, setRequested] = useState(false);
  const [noPreview, setNoPreview] = useState(false);
  useEffect(() => {
    if (!c && !requested) { setRequested(true); void api(`/files/${fileId}/view3d/convert`, { method: 'POST', body: {}, quiet: true }).then(reload).catch(() => undefined); }
  }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (c?.status !== 'queued' && c?.status !== 'running') return;
    const t = setInterval(reload, 5000);
    const off = realtime.subscribe('global', (e, d: any) => { if (e === 'view3d.converted' && d?.fileId === fileId) reload(); });
    return () => { clearInterval(t); off(); };
  }, [c?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (c?.status === 'done') return <LazyViewer3D src={`/api/files/${fileId}/view3d/model`} name={`${info.name.replace(/\.[^.]+$/, '')}.step`} height="100%" />;
  const status = !c || c.status === 'queued'
    ? info.workers?.length ? `Wird gleich auf ${info.workers[0]} in ein 3D-Modell umgewandelt …` : null
    : c.status === 'running' ? `${c.worker ?? 'Ein CAD-Arbeitsplatz'} wandelt die Datei gerade um …` : null;
  return (
    <div className="v3d-native">
      <div className="v3d-native-img">
        {noPreview ? <div className="muted"><Icon name="cube" size={64} strokeWidth={1.2} /><div>Kein Vorschaubild in der Datei</div></div>
          : <img src={`/api/files/${fileId}/view3d/preview`} alt="Vorschau" onError={() => setNoPreview(true)} />}
      </div>
      <div className="card v3d-native-info">
        <h3 style={{ marginTop: 0 }}>{info.label}</h3>
        {c?.status === 'failed' ? <>
          <p className="error-text">Die Umwandlung ist fehlgeschlagen: {c.error}</p>
          <button className="btn primary" onClick={async () => { await post(`/files/${fileId}/view3d/convert`); reload(); }}><Icon name="refresh" /> Erneut versuchen</button>
        </> : status ? <p className="row"><span className="spinner" /> {status}</p> : <>
          <p>Diese Datei kann nur {info.program} selbst lesen. Für die 3D-Ansicht wandelt ein Rechner mit {info.program} sie einmalig in STEP um – danach lässt sie sich hier drehen, schneiden und messen.</p>
          <p className="muted small">Gerade ist kein solcher Rechner verbunden. Der Auftrag ist vorgemerkt und wird erledigt, sobald dort der Umwandlungsdienst der CAD-Bridge läuft (das richtet Ihr Administrator ein, siehe Handbuch für Administratoren, Abschnitt „3D-Ansicht“). Bis dahin sehen Sie das Vorschaubild, das {info.program} in der Datei gespeichert hat.</p>
        </>}
      </div>
    </div>
  );
}
