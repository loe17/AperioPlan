import { useState } from 'react';
import { useApi } from '../lib/hooks';
import { get } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useSession } from '../session';
import { Avatar, Empty, useAction } from '../components/ui';
import { Icon } from '../components/Icon';

const AREA: Record<string, string> = {
  project: 'Projekte', task: 'Aufgaben', file: 'Dateien', cad: 'CAD', user: 'Benutzer', settings: 'Einstellungen', time: 'Zeiterfassung', crm: 'CRM',
  purchasing: 'Einkauf', calc: 'Kalkulation', mail: 'E-Mail', calendar: 'Kalender', resource: 'Ressourcen', absence: 'Abwesenheiten', share: 'Freigaben', team: 'Teams',
};

/** Lückenloses Änderungsprotokoll: Wer? Wann? Was? – mit Filtern und Download (Excel, CSV, PDF mit Prüfsumme) */
export function AuditView({ projectId }: { projectId?: string }) {
  const { users, me } = useSession();
  const act = useAction();
  const [f, setF] = useState({ from: '', to: '', action: '', userId: '', q: '' });
  const [checksum, setChecksum] = useState<{ checksum: string; count: number } | null>(null);
  const qs = new URLSearchParams(Object.entries({ ...f, projectId: projectId ?? '' }).filter(([, v]) => v) as [string, string][]).toString();
  const { data } = useApi<any[]>(`/audit?limit=300${qs ? `&${qs}` : ''}`);
  const { data: actions } = useApi<string[]>(!projectId && me?.role === 'admin' ? '/audit/actions' : null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { setF({ ...f, [k]: e.target.value }); setChecksum(null); };
  const dl = (format: string) => `/api/audit/export?format=${format}${qs ? `&${qs}` : ''}`;
  return (
    <div>
      <div className="toolbar wrap" style={{ gap: 8 }}>
        <label className="row small">von <input type="date" value={f.from} onChange={set('from')} /></label>
        <label className="row small">bis <input type="date" value={f.to} onChange={set('to')} /></label>
        {actions && <select value={f.action} onChange={set('action')} style={{ width: 'auto' }}><option value="">alle Bereiche</option>{actions.map((a) => <option key={a} value={a}>{AREA[a] ?? a}</option>)}</select>}
        <select value={f.userId} onChange={set('userId')} style={{ width: 'auto' }}><option value="">alle Personen</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
        <input placeholder="Suchen …" value={f.q} onChange={set('q')} style={{ maxWidth: 200 }} />
        <span className="grow" />
        <span className="small muted">Herunterladen:</span>
        <a className="btn sm" href={dl('xlsx')}><Icon name="file-excel" /> Excel</a>
        <a className="btn sm" href={dl('csv')}><Icon name="file-text" /> CSV</a>
        <a className="btn sm" href={dl('pdf')}><Icon name="file-pdf" /> PDF</a>
        <button className="btn sm ghost" title="Prüfsumme dieses Auszugs berechnen" onClick={async () => { const r = await act(() => get<{ checksum: string; count: number }>(dl('checksum').replace('/api', ''))); if (r) setChecksum(r); }}><Icon name="shield" /> Prüfsumme</button>
      </div>
      {checksum && <div className="card flat small" style={{ marginBottom: 10 }}><b>SHA-256</b> über {checksum.count} Einträge: <span className="mono" style={{ wordBreak: 'break-all' }}>{checksum.checksum}</span>
        <div className="muted">Derselbe Auszug (gleiche Filter) ergibt später dieselbe Prüfsumme, solange niemand Einträge verändert hat. Die Prüfsumme steht auch in jeder heruntergeladenen Datei.</div></div>}
      {!data?.length ? <Empty icon="history" title="Keine Einträge" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Wann</th><th>Wer</th><th>Was</th><th>Bereich</th></tr></thead>
          <tbody>{data.map((a) => (
            <tr key={a.id}>
              <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.at)}</td>
              <td><span className="row" style={{ gap: 6 }}><Avatar id={a.userId} name={a.userName} />{a.userName ?? 'System'}</span></td>
              <td>{a.summary}</td>
              <td className="small muted mono">{a.action}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {data && data.length >= 300 && <div className="hint">Es werden die neuesten 300 Einträge angezeigt. Der Download enthält alle Einträge des gewählten Zeitraums.</div>}
    </div>
  );
}
