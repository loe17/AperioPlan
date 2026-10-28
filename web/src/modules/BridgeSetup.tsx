import { useState } from 'react';
import { useApi } from '../lib/hooks';
import { del } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useSession } from '../session';
import { Empty, Pill, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';

interface Client { id: string; kind: 'cad' | 'pcb' | 'export'; host: string; os: string; version: string; appVersion: string; userName: string; lastSeen: string; online: boolean; outdated: boolean }

const KIND_LABEL: Record<string, string> = { cad: 'CAD-Wächter', pcb: 'PCB-Wächter', export: 'Export-Dienst' };

/** Geführte Einrichtung der Wächter: Installationspaket herunterladen und verbundene Arbeitsplätze ansehen */
export function BridgeSetup({ kind }: { kind: 'cad' | 'pcb' }) {
  const toast = useToast();
  const act = useAction();
  const { me } = useSession();
  const [busy, setBusy] = useState(false);
  const { data: clients, reload } = useApi<Client[]>(`/bridge/clients`);
  const { data: info } = useApi<any>('/bridge/info');
  const list = (clients ?? []).filter((c) => (kind === 'cad' ? c.kind !== 'pcb' : c.kind === 'pcb'));
  const download = async (platform: 'windows' | 'linux' | 'mac') => {
    setBusy(true);
    try {
      const res = await fetch('/api/bridge/installer', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ kind, platform }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'AperioPlan-Einrichtung.zip';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Installationspaket heruntergeladen');
    } catch (e) { toast((e as Error).message, 'error'); }
    setBusy(false);
  };
  const pkg = kind === 'cad' ? info?.packages?.['cad-win'] : info?.packages?.['pcb-win'];
  return (
    <div style={{ maxWidth: 920 }}>
      <div className="card">
        <h2 style={{ marginBottom: 6 }}>{kind === 'cad' ? 'CAD-Wächter für SolidWorks einrichten' : 'PCB-Wächter für KiCad einrichten'}</h2>
        <p className="muted">Das Installationspaket ist bereits mit der Serveradresse <span className="mono">{location.origin}</span> und Ihrem persönlichen Zugangsschlüssel vorbereitet – es muss nichts eingetippt werden.</p>
        <ol style={{ lineHeight: 1.9, paddingLeft: 20 }}>
          <li>Installationspaket herunterladen und auf dem {kind === 'cad' ? 'Konstruktions-PC' : 'Elektronik-Arbeitsplatz'} entpacken.</li>
          <li>{kind === 'cad' ? <>Doppelklick auf <b>Einrichten.cmd</b> (fragt nach Administratorrechten).</> : <>Windows: Doppelklick auf <b>Einrichten.cmd</b>. Linux/macOS: im Terminal <span className="mono">sh einrichten.sh</span>.</>}</li>
          <li>{kind === 'cad' ? 'Das Programm erkennt die SolidWorks-Version, meldet das Add-in an, richtet auf Wunsch den Export-Dienst ein und prüft die Verbindung.' : 'Das Programm erkennt KiCad (ab Version 8), richtet den Wächter ein und prüft die Verbindung.'}</li>
          <li>Am Ende steht <b>„Verbunden mit {location.origin}“</b> – oder eine verständliche Fehlermeldung mit Lösungsvorschlag.</li>
        </ol>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={busy} onClick={() => download('windows')}><Icon name="download" /> Installationspaket herunterladen{kind === 'pcb' ? ' (Windows)' : ''}</button>
          {kind === 'pcb' && <button className="btn" disabled={busy} onClick={() => download('linux')}><Icon name="download" /> Linux</button>}
          {kind === 'pcb' && <button className="btn" disabled={busy} onClick={() => download('mac')}><Icon name="download" /> macOS</button>}
        </div>
        <p className="hint">Jedes Paket enthält einen neuen Zugangsschlüssel. Er steht unter Einstellungen → API-Schlüssel und kann dort jederzeit widerrufen werden.</p>
        {me?.role === 'admin' && info && !pkg && <div className="card flat small" style={{ marginTop: 8 }}><Icon name="info" /> Die Programmdateien werden aus dem GitHub-Release geladen. Ohne Internetzugang der Arbeitsplätze die Pakete aus dem Release in den Ordner <span className="mono">{info.downloadsDir}</span> auf dem Server legen.</div>}
      </div>

      <h2 style={{ margin: '22px 0 8px' }}>Verbundene Arbeitsplätze</h2>
      {!list.length ? <Empty icon="monitor" title="Noch kein Arbeitsplatz verbunden">Nach der Einrichtung meldet sich der Wächter hier mit Version und Programmstand.</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Arbeitsplatz</th><th>Art</th><th>Benutzer</th><th>Programm</th><th>Wächter</th><th>Zuletzt</th><th /></tr></thead>
          <tbody>{list.map((c) => (
            <tr key={c.id}>
              <td><span className="row" style={{ gap: 6 }}><span className={`dot ${c.online ? 'green' : ''}`} style={{ width: 8, height: 8, borderRadius: 4, background: c.online ? 'var(--green)' : 'var(--line)', display: 'inline-block' }} /><b>{c.host}</b></span><div className="small muted">{c.os}</div></td>
              <td>{KIND_LABEL[c.kind]}</td><td className="small">{c.userName}</td><td className="small">{c.appVersion || '–'}</td>
              <td>{c.version || '–'} {c.outdated && <Pill tone="amber">Update verfügbar</Pill>}</td>
              <td className="small muted">{fmtDateTime(c.lastSeen)}</td>
              <td><button className="btn ghost sm" title="Aus der Liste entfernen" onClick={async () => { if (await act(() => del(`/bridge/clients/${c.id}`))) reload(); }}><Icon name="x" /></button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <p className="hint">Neue Versionen bietet der Wächter beim Start selbst an. Grün = in den letzten 15 Minuten gemeldet.</p>
    </div>
  );
}
