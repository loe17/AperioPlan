import { useEffect, useState } from 'react';
import { useCrumbs } from '../components/Layout';
import { useApi } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { Confirm, Empty, Field, Modal, useAction } from '../components/ui';
import { Icon } from '../components/Icon';

export const CF_ENTITY_LABEL: Record<string, string> = { project: 'Projekte', crm_account: 'Kunden und Lieferanten', crm_contact: 'Kontakte', article: 'Lagerartikel', asset: 'Inventar', ticket: 'Kundenanfragen', service_job: 'Service-Einsätze' };
const TYPES: Record<string, string> = { text: 'Text', textarea: 'langer Text', number: 'Zahl', money: 'Betrag (€)', date: 'Datum', select: 'Auswahl (eine)', multiselect: 'Auswahl (mehrere)', checkbox: 'Ja/Nein', url: 'Link', user: 'Person' };

export default function StudioPage() {
  useCrumbs([{ label: 'Eigene Felder' }]);
  const { me } = useSession();
  const { data, reload } = useApi<any[]>('/custom-fields?all=1');
  const [edit, setEdit] = useState<any | null>(null);
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'studio.changed') void reload(); }), [reload]);
  if (me?.role !== 'admin') return <div className="page"><Empty icon="lock" title="Nur für Administratoren">Eigene Felder legen Administratoren an. Ausfüllen kann sie jeder direkt im jeweiligen Datensatz.</Empty></div>;
  return (
    <div className="page">
      <div className="page-head"><div><h1>Eigene Felder</h1><div className="sub">Zusätzliche Angaben für Projekte, Kunden, Artikel und mehr – ohne Programmieren</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setEdit({ entity: 'project', label: '', type: 'text', options: [], required: false, help: '', sort: 0, active: true })}><Icon name="plus" /> Feld</button></div></div>
      {data && !data.length && <Empty icon="sliders" title="Noch keine eigenen Felder">Beispiele: Kostenstelle am Projekt, Kundenklasse A/B/C am Kunden, Gefahrstoffklasse am Lagerartikel, Garantie bis am Inventar.</Empty>}
      {Object.entries(CF_ENTITY_LABEL).map(([k, l]) => {
        const list = data?.filter((f) => f.entity === k) ?? [];
        if (!list.length) return null;
        return (
          <div key={k} style={{ marginBottom: 18 }}>
            <h3>{l}</h3>
            <table className="table"><tbody>{list.map((f) => (
              <tr key={f.id} className="click" onClick={() => setEdit(f)} style={!f.active ? { opacity: 0.5 } : undefined}>
                <td><b>{f.label}</b>{f.required && <span className="text-red"> *</span>}<div className="small muted mono">{f.key}</div></td><td>{TYPES[f.type]}</td>
                <td className="small muted">{f.options.join(', ')}</td><td className="small muted">{f.help}</td>
              </tr>
            ))}</tbody></table>
          </div>
        );
      })}
      <p className="hint">Die Felder erscheinen im jeweiligen Datensatz unter „Weitere Angaben“ und können dort von allen ausgefüllt werden, die den Datensatz bearbeiten dürfen.</p>
      {edit && <FieldModal f0={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function FieldModal({ f0, onClose, onDone }: { f0: any; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ ...f0, optionsText: f0.options.join('\n') });
  const [remove, setRemove] = useState(false);
  const options = f.optionsText.split('\n').map((x: string) => x.trim()).filter(Boolean);
  const body = { label: f.label, type: f.type, options, required: f.required, help: f.help, sort: f.sort, active: f.active };
  return (
    <Modal title={f0.id ? 'Feld bearbeiten' : 'Neues Feld'} onClose={onClose} footer={<>
      {f0.id && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.label.trim()} onClick={async () => { if (await act(() => (f0.id ? patch(`/custom-fields/${f0.id}`, body) : post('/custom-fields', { ...body, entity: f.entity })), 'Gespeichert')) onDone(); }}>Speichern</button></>}>
      <div className="grid2">
        <Field label="Für"><select disabled={!!f0.id} value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}>{Object.entries(CF_ENTITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Art"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      </div>
      <Field label="Bezeichnung"><input autoFocus value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="z. B. Kostenstelle" /></Field>
      {(f.type === 'select' || f.type === 'multiselect') && <Field label="Auswahlwerte" hint="ein Wert je Zeile"><textarea rows={5} value={f.optionsText} onChange={(e) => setF({ ...f, optionsText: e.target.value })} /></Field>}
      <Field label="Hilfetext"><input value={f.help} onChange={(e) => setF({ ...f, help: e.target.value })} /></Field>
      <div className="row" style={{ gap: 16 }}>
        <label className="row"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> Pflichtfeld</label>
        <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>
        <label className="row small">Reihenfolge <input type="number" style={{ width: 70 }} value={f.sort} onChange={(e) => setF({ ...f, sort: Number(e.target.value) })} /></label>
      </div>
      {remove && <Confirm danger text={`Feld „${f0.label}“ löschen? Alle eingetragenen Werte gehen verloren. Zum Ausblenden lieber „aktiv“ abwählen.`} onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/custom-fields/${f0.id}`), 'Gelöscht')) onDone(); }} />}
    </Modal>
  );
}
