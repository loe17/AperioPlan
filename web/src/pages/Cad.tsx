import { useState } from 'react';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { fmtDateTime } from '../lib/format';
import { Empty, Pill, Tabs } from '../components/ui';
import { CadCenter } from '../modules/CadCenter';
import { BridgeSetup } from '../modules/BridgeSetup';

export default function CadPage() {
  useCrumbs([{ label: 'CAD-Bridge' }]);
  const [tab, setTab] = useTabState<'items' | 'exports' | 'setup'>('cad', 'items');
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>CAD-Bridge</h1><div className="sub">Baugruppen, Einzelteile und Zeichnungen aller Projekte – mit Sperren, Versionsständen und Freigaben</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'items', label: 'Teile & Baugruppen' }, { id: 'exports', label: 'Fertigungsableitungen' }, { id: 'setup', label: 'Wächter einrichten' }]} />
      {tab === 'items' && <CadCenter />}
      {tab === 'exports' && <Exports />}
      {tab === 'setup' && <Setup />}
    </div>
  );
}

function Exports() {
  const { data } = useApi<any[]>('/cad/exports');
  if (!data?.length) return <Empty icon="factory" title="Noch keine Aufträge">Bei jeder Freigabe entstehen hier Aufträge für PDF, DXF und STEP.</Empty>;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Angefordert</th><th>Nummer</th><th>Benennung</th><th>Format</th><th>Status</th><th>Bearbeitet von</th><th>Hinweis</th></tr></thead>
      <tbody>{data.map((e) => (
        <tr key={e.id}><td className="small">{fmtDateTime(e.requestedAt)}</td><td className="mono small">{e.baseNumber}-{String(e.revision).padStart(2, '0')}</td><td>{e.designation}</td><td><b>{e.format.toUpperCase()}</b></td>
          <td>{e.status === 'done' ? <Pill tone="green">erzeugt</Pill> : e.status === 'failed' ? <Pill tone="red">Fehler</Pill> : e.status === 'running' ? <Pill tone="blue">läuft</Pill> : <Pill tone="amber">wartet</Pill>}</td>
          <td className="small">{e.worker ?? '–'}</td><td className="small muted">{e.error ?? ''}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

function Setup() {
  return <BridgeSetup kind="cad" />;
}
