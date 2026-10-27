import { useState } from 'react';
import { Field, useAction } from '../components/ui';
import { useSession } from '../session';
import { useAdminSettings } from './Settings';

const Later = ({ title }: { title: string }) => <div><h1 style={{ marginBottom: 12 }}>{title}</h1><div className="empty">Folgt in einer der nächsten Etappen.</div></div>;
export const CadMaskSettings = () => <Later title="Speichermaske (CAD)" />;
export const BackupSettings = () => <Later title="Sicherung" />;
export const UpdateSettings = () => <Later title="Aktualisierung" />;
export const MailSettings = () => <Later title="E-Mail-Konto" />;
export const AiSettings = () => <Later title="KI-Anbindung" />;
export const HolidaySettings = () => <Later title="Feiertage" />;

export function StorageSettings() {
  const act = useAction();
  const { refreshLists } = useSession();
  const s = useAdminSettings('storage');
  const [folder, setFolder] = useState('');
  if (!s.value) return null;
  const v = s.value;
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>Speicherorte</h1>
      <p className="muted">Der Speicherort der Projektdateien wird beim Server-Start festgelegt (FILES_PATH in der Datei .env). Dort kann ein lokaler Ordner oder ein eingebundenes Netzlaufwerk (NAS / SMB / Windows-Freigabe) stehen – siehe Administrator-Handbuch.</p>
      <Field label="Art der Ablage">
        <select value={v.mode} onChange={(e) => s.setValue({ ...v, mode: e.target.value })}><option value="local">Lokal auf dem Server</option><option value="network">Netzlaufwerk (NAS / SMB)</option></select>
      </Field>
      <Field label="Netzwerkpfad für den Windows-Explorer" hint="Wird bei jedem Projekt angezeigt, z. B. \\nas01\projekte">
        <input className="mono" value={v.networkPath} onChange={(e) => s.setValue({ ...v, networkPath: e.target.value })} />
      </Field>
      <Field label="Automatische Ordnerstruktur für neue Projekte">
        <div className="card flat" style={{ padding: 8 }}>
          {v.projectFolders.map((f: string, i: number) => (
            <div key={i} className="row" style={{ padding: 2 }}>
              <span className="mono grow">📁 {f}</span>
              <button className="btn ghost sm" onClick={() => s.setValue({ ...v, projectFolders: v.projectFolders.filter((_: string, j: number) => j !== i) })}>✕</button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 6 }}>
            <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="z. B. 05_Einkauf" />
            <button className="btn" disabled={!folder.trim()} onClick={() => { s.setValue({ ...v, projectFolders: [...v.projectFolders, folder.trim()] }); setFolder(''); }}>Hinzufügen</button>
          </div>
        </div>
      </Field>
      <button className="btn primary" onClick={async () => { await act(() => s.save(v), 'Gespeichert'); refreshLists(); }}>Speichern</button>
    </div>
  );
}
