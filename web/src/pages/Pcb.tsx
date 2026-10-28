import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { fmtDateTime } from '../lib/format';
import { Empty, Pill, Tabs } from '../components/ui';
import { PCB_EXPORT_LABELS } from '@aperio/shared';
import { PcbCenter } from '../modules/PcbCenter';
import { BridgeSetup } from '../modules/BridgeSetup';

export default function PcbPage() {
  useCrumbs([{ label: 'PCB-Bridge' }]);
  const [tab, setTab] = useTabState<'boards' | 'exports' | 'setup'>('pcb', 'boards');
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>PCB-Bridge</h1><div className="sub">Leiterplatten aus KiCad – mit Nummern, Sperren, Versionsständen, Stückliste und Fertigungsdaten</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'boards', label: 'Leiterplatten' }, { id: 'exports', label: 'Fertigungsdaten' }, { id: 'setup', label: 'Wächter einrichten' }]} />
      {tab === 'boards' && <PcbCenter />}
      {tab === 'exports' && <Exports />}
      {tab === 'setup' && <BridgeSetup kind="pcb" />}
    </div>
  );
}

function Exports() {
  const { data } = useApi<any[]>('/pcb/exports');
  if (!data?.length) return <Empty icon="factory" title="Noch keine Aufträge">Bei jeder Freigabe entstehen hier Aufträge für Gerber, Bohrdaten, Bestückungsliste, Schaltplan und STEP.</Empty>;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Angefordert</th><th>Nummer</th><th>Benennung</th><th>Daten</th><th>Status</th><th>Bearbeitet von</th><th>Hinweis</th></tr></thead>
      <tbody>{data.map((e) => (
        <tr key={e.id}><td className="small">{fmtDateTime(e.requestedAt)}</td><td className="mono small">{e.number}-{String(e.revision).padStart(2, '0')}</td><td>{e.designation}</td>
          <td><b>{PCB_EXPORT_LABELS[e.format as keyof typeof PCB_EXPORT_LABELS] ?? e.format}</b></td>
          <td>{e.status === 'done' ? <Pill tone="green">erzeugt</Pill> : e.status === 'failed' ? <Pill tone="red">Fehler</Pill> : e.status === 'running' ? <Pill tone="blue">läuft</Pill> : <Pill tone="amber">wartet</Pill>}</td>
          <td className="small">{e.worker ?? '–'}</td><td className="small muted">{e.error ?? ''}</td></tr>
      ))}</tbody>
    </table></div>
  );
}
