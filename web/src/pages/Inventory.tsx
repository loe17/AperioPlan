import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ASSET_STATUS, GWG_LIMIT, INSPECTION_KINDS } from '@aperio/shared';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, get, patch, post, upload } from '../lib/api';
import { useSession } from '../session';
import { fmtBytes, fmtDate, fmtDateTime, fmtEuro2, isoDate } from '../lib/format';
import { Confirm, Empty, ErrorBox, Field, Loading, Modal, Pill, Tabs, UserSelect, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { LabelButton, ScanButton, ScanModal, type Label } from '../modules/Scan';

const STATUS_TONE: Record<string, string> = { active: 'green', repair: 'amber', retired: '', lost: 'red' };
const today = () => isoDate(new Date());
const dueTone = (d?: string | null) => (!d ? '' : d < today() ? 'red' : d <= isoDate(new Date(Date.now() + 30 * 86400000)) ? 'amber' : '');
const assetLabel = (a: any): Label => ({ title: a.name, subtitle: [a.manufacturer, a.model].filter(Boolean).join(' ') || a.category, code: a.number, qr: `${location.origin}/inventory/${a.id}` });

export default function InventoryPage() {
  const { id } = useParams();
  return id ? <AssetPage id={id} /> : <AssetList />;
}

function AssetList() {
  useCrumbs([{ label: 'Inventar' }]);
  const nav = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useTabState<'all' | 'inspections' | 'audit'>('inventory', 'all');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [create, setCreate] = useState(false);
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) });
  const { data, reload } = useApi<any[]>(`/inventory/assets?${qs}`);
  const onScan = async (code: string) => {
    try { const r = await get<{ id: string }>(`/inventory/lookup?code=${encodeURIComponent(code)}`); nav(`/inventory/${r.id}`); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const total = data?.reduce((s, a) => s + (a.bookValue ?? 0), 0) ?? 0;
  return (
    <div className="page wide">
      <div className="page-head">
        <div><h1>Inventar</h1><div className="sub">Geräte, Maschinen und Ausstattung mit Prüfterminen</div></div>
        <div className="actions">
          <ScanButton onCode={onScan} title="Inventaretikett scannen" />
          <a className="btn" href="/api/inventory/export.xlsx"><Icon name="download" /> Anlagenverzeichnis</a>
          <button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Inventar</button>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'all', label: 'Alle' }, { id: 'inspections', label: 'Prüftermine' }, { id: 'audit', label: 'Inventur' }]} />
      {tab === 'all' && <>
        <div className="toolbar">
          <input placeholder="Nummer, Name, Seriennr., Standort, Person …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">in Betrieb und in Reparatur</option><option value="all">alle</option>
            {Object.entries(ASSET_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <span className="small muted">{data?.length ?? 0} Einträge · Restbuchwert {fmtEuro2(total)}</span>
          {data && data.length > 0 && <span className="right"><LabelButton labels={() => data.map(assetLabel)} label="Etiketten für alle" /></span>}
        </div>
        {data && !data.length && <Empty icon="equipment" title={q ? 'Nichts gefunden' : 'Noch kein Inventar'}>{q ? null : 'Erfassen Sie Laptops, Messgeräte, Maschinen oder Werkzeuge – mit Prüfterminen (z. B. DGUV V3) erinnert AperioPlan rechtzeitig.'}</Empty>}
        {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Bezeichnung</th><th>Standort</th><th>Verantwortlich</th><th>Nächste Prüfung</th><th>Status</th><th style={{ textAlign: 'right' }}>Restbuchwert</th></tr></thead>
          <tbody>{data.map((a) => (
            <tr key={a.id} className="click" onClick={() => nav(`/inventory/${a.id}`)}>
              <td className="mono">{a.number}</td><td><b>{a.name}</b>{(a.manufacturer || a.model) && <span className="small muted"> · {[a.manufacturer, a.model].filter(Boolean).join(' ')}</span>}</td>
              <td className="small">{a.location}</td><td className="small">{a.holderName ?? a.teamName ?? ''}</td>
              <td>{a.nextInspection ? <Pill tone={dueTone(a.nextInspection)}>{fmtDate(a.nextInspection)}</Pill> : ''}</td>
              <td><Pill tone={STATUS_TONE[a.status]}>{ASSET_STATUS[a.status]}</Pill></td>
              <td style={{ textAlign: 'right' }}>{a.bookValue !== null ? fmtEuro2(a.bookValue) : '–'}</td>
            </tr>
          ))}</tbody></table>}
      </>}
      {tab === 'inspections' && <Inspections />}
      {tab === 'audit' && <Audit />}
      {create && <AssetEditor onClose={() => setCreate(false)} onSaved={(id) => { setCreate(false); reload(); nav(`/inventory/${id}`); }} />}
    </div>
  );
}

function Inspections() {
  const [days, setDays] = useState(60);
  const { data } = useApi<any[]>(`/inventory/inspections?days=${days}`);
  const nav = useNavigate();
  return (
    <div>
      <div className="toolbar">
        <span>Fällig in den nächsten</span>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>{[30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} Tagen</option>)}</select>
        <span className="small muted">Erinnerungen gehen 14 Tage vorher und am Fälligkeitstag an die verantwortliche Person.</span>
      </div>
      {data && !data.length && <Empty icon="check-circle" title="Keine Prüfungen fällig" />}
      <table className="table"><tbody>{data?.map((i) => (
        <tr key={i.id} className="click" onClick={() => nav(`/inventory/${i.assetId}?tab=inspections`)}>
          <td><Pill tone={i.overdue ? 'red' : 'amber'}>{fmtDate(i.nextDate)}</Pill></td><td><b>{i.kind}</b></td>
          <td><span className="mono">{i.number}</span> {i.name}</td><td className="small">{i.location}</td><td className="small">{i.responsibleName ?? '–'}</td>
        </tr>
      ))}</tbody></table>
    </div>
  );
}

/** Inventur: alles scannen, was man findet; übrig bleibt, was seit dem Stichtag nicht gesehen wurde */
function Audit() {
  const [since, setSince] = useState(() => { try { return localStorage.getItem('aperio-inv-audit') ?? today(); } catch { return today(); } });
  const [scan, setScan] = useState(false);
  const [location, setLocation] = useState('');
  const { data, reload } = useApi<any[]>(`/inventory/assets?notSeenSince=${since}`);
  const toast = useToast();
  const setStart = (d: string) => { setSince(d); try { localStorage.setItem('aperio-inv-audit', d); } catch { /* egal */ } };
  return (
    <div>
      <div className="toolbar">
        <span>Inventur seit</span><input type="date" value={since} onChange={(e) => setStart(e.target.value)} style={{ width: 'auto' }} />
        <input placeholder="Aktueller Raum (optional)" value={location} onChange={(e) => setLocation(e.target.value)} style={{ width: 200 }} />
        <button className="btn primary" onClick={() => setScan(true)}><Icon name="scan" /> Scannen</button>
        <span className="small muted">{data ? `${data.length} noch nicht gesehen` : ''}</span>
      </div>
      <p className="small muted">Gehen Sie durch die Räume und scannen Sie die Etiketten. Mit Raumangabe wird der Standort gleich mit aktualisiert. Übrig bleiben Gegenstände, die fehlen.</p>
      <table className="table"><tbody>{data?.map((a) => (
        <tr key={a.id}><td className="mono">{a.number}</td><td>{a.name}</td><td className="small">{a.location}</td><td className="small">{a.holderName ?? ''}</td>
          <td className="small muted">{a.lastSeenAt ? `zuletzt ${fmtDateTime(a.lastSeenAt)} (${a.lastSeenBy})` : 'noch nie gescannt'}</td>
          <td><button className="btn sm" onClick={async () => { await post(`/inventory/assets/${a.id}/seen`, location ? { location } : {}); reload(); }}>gesehen</button></td></tr>
      ))}</tbody></table>
      {scan && <ScanModal title="Inventur – Etiketten scannen" keepOpen onClose={() => setScan(false)} onCode={async (code) => {
        try {
          const r = await get<{ id: string }>(`/inventory/lookup?code=${encodeURIComponent(code)}`);
          await post(`/inventory/assets/${r.id}/seen`, location ? { location } : {});
          const a = data?.find((x) => x.id === r.id);
          toast(a ? `${a.number} ${a.name} erfasst` : 'Erfasst (war schon gesehen)'); reload();
        } catch (e) { toast((e as Error).message, 'error'); }
      }} />}
    </div>
  );
}

function AssetEditor({ asset, onClose, onSaved }: { asset?: any; onClose: () => void; onSaved: (id: string) => void }) {
  const act = useAction();
  const { users, teams } = useSession();
  const { data: suppliers } = useApi<any[]>('/crm/accounts?kind=supplier');
  const { data: resources } = useApi<any[]>('/resources');
  const [f, setF] = useState({ number: asset?.number ?? '', name: asset?.name ?? '', category: asset?.category ?? '', manufacturer: asset?.manufacturer ?? '', model: asset?.model ?? '',
    serialNo: asset?.serialNo ?? '', location: asset?.location ?? '', holderId: asset?.holderId ?? '', teamId: asset?.teamId ?? '', resourceId: asset?.resourceId ?? '',
    supplierId: asset?.supplierId ?? '', purchaseDate: asset?.purchaseDate ?? '', purchasePrice: asset?.purchasePrice ?? '', warrantyUntil: asset?.warrantyUntil ?? '',
    depreciationYears: asset?.depreciationYears ?? '', status: asset?.status ?? 'active', notes: asset?.notes ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const price = f.purchasePrice === '' ? null : Number(f.purchasePrice);
  return (
    <Modal size="lg" title={asset ? `${asset.number} bearbeiten` : 'Neues Inventar'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.name.trim()} onClick={async () => {
        const body = { ...f, holderId: f.holderId || null, teamId: f.teamId || null, resourceId: f.resourceId || null, supplierId: f.supplierId || null,
          purchaseDate: f.purchaseDate || null, warrantyUntil: f.warrantyUntil || null, purchasePrice: price, depreciationYears: f.depreciationYears === '' ? null : Number(f.depreciationYears) };
        if (asset && body.number === asset.number) delete (body as Partial<typeof body>).number;
        const r = await act(() => (asset ? patch(`/inventory/assets/${asset.id}`, body).then(() => ({ id: asset.id })) : post<{ id: string }>('/inventory/assets', body)), 'Gespeichert');
        if (r) onSaved(r.id);
      }}>Speichern</button></>}>
      <div className="grid3">
        <Field label="Inventarnummer" hint={asset ? undefined : 'leer = automatisch'}><input className="mono" value={f.number} onChange={set('number')} /></Field>
        <Field label="Bezeichnung" required><input autoFocus value={f.name} onChange={set('name')} placeholder="z. B. Laptop, Bohrmaschine" /></Field>
        <Field label="Kategorie"><input value={f.category} onChange={set('category')} placeholder="z. B. IT, Werkzeug, Messmittel" /></Field>
        <Field label="Hersteller"><input value={f.manufacturer} onChange={set('manufacturer')} /></Field>
        <Field label="Modell"><input value={f.model} onChange={set('model')} /></Field>
        <Field label="Seriennummer"><input className="mono" value={f.serialNo} onChange={set('serialNo')} /></Field>
        <Field label="Standort"><input value={f.location} onChange={set('location')} placeholder="z. B. Büro 2.14, Werkstatt" /></Field>
        <Field label="Verantwortlich / hat es"><UserSelect users={users} value={f.holderId || null} onChange={(v) => setF({ ...f, holderId: v ?? '' })} placeholder="– niemand –" /></Field>
        <Field label="Abteilung"><select value={f.teamId} onChange={set('teamId')}><option value="">–</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        <Field label="Anschaffung am"><input type="date" value={f.purchaseDate} onChange={set('purchaseDate')} /></Field>
        <Field label="Anschaffungswert (netto, €)"><input type="number" min={0} step="0.01" value={f.purchasePrice} onChange={set('purchasePrice')} /></Field>
        <Field label="Nutzungsdauer (Jahre)" hint={price !== null && price <= GWG_LIMIT ? 'bis 800 € leer lassen = GWG, sofort abgeschrieben' : 'laut AfA-Tabelle, z. B. Laptop 1–3, Maschinen 10'}>
          <input type="number" min={0} step="0.5" value={f.depreciationYears} onChange={set('depreciationYears')} /></Field>
        <Field label="Lieferant"><select value={f.supplierId} onChange={set('supplierId')}><option value="">–</option>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Garantie bis"><input type="date" value={f.warrantyUntil} onChange={set('warrantyUntil')} /></Field>
        <Field label="Buchbar als Ressource" hint="verknüpft mit „Ressourcen“"><select value={f.resourceId} onChange={set('resourceId')}><option value="">–</option>{resources?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        {asset && <Field label="Status"><select value={f.status} onChange={set('status')}>{Object.entries(ASSET_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>}
      </div>
      <Field label="Notizen"><textarea rows={3} value={f.notes} onChange={set('notes')} /></Field>
    </Modal>
  );
}

function AssetPage({ id }: { id: string }) {
  const { data: a, error, reload } = useApi<any>(`/inventory/assets/${id}`);
  const { me, users } = useSession();
  const act = useAction();
  const nav = useNavigate();
  const [tab, setTab] = useTabState<'info' | 'inspections' | 'handovers' | 'afa' | 'files'>('asset', 'info');
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
  const [insp, setInsp] = useState<any | null>(null);
  const [log, setLog] = useState<any | null>(null);
  const [handover, setHandover] = useState(false);
  useCrumbs([{ label: 'Inventar', to: '/inventory' }, { label: a ? `${a.number} ${a.name}` : '…' }]);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!a) return <Loading />;
  const pendingMine = a.handovers.find((h: any) => h.toUserId === me?.id && !h.confirmedAt);
  const uploadFiles = async (files: FileList | null, image = false) => {
    if (!files?.length) return;
    const fd = new FormData(); for (const f of files) fd.append('file', f, f.name);
    if (await act(() => upload(`/inventory/assets/${id}/files${image ? '?image=1' : ''}`, fd))) reload();
  };
  return (
    <div className="page">
      <div className="page-head">
        <div className="inv-head grow">
          <div className="wh-img" onClick={() => document.getElementById('inv-img')?.click()} title="Foto ändern">
            {a.hasImage ? <img src={`/api/inventory/assets/${id}/image?v=${encodeURIComponent(a.updatedAt)}`} alt="" /> : <Icon name="camera" size={28} />}
            <input id="inv-img" type="file" accept="image/*" capture="environment" hidden onChange={(e) => void uploadFiles(e.target.files, true)} />
          </div>
          <div>
            <h1 style={{ marginBottom: 4 }}>{a.name}</h1>
            <div className="sub row wrap" style={{ gap: 8 }}><span className="mono">{a.number}</span><Pill tone={STATUS_TONE[a.status]}>{ASSET_STATUS[a.status]}</Pill>
              {a.location && <span><Icon name="location" /> {a.location}</span>}{a.holderName && <span><Icon name="user" /> {a.holderName}</span>}</div>
          </div>
        </div>
        <div className="actions">
          <LabelButton labels={() => [assetLabel(a)]} label="Etikett" />
          <button className="btn" onClick={() => setHandover(true)}><Icon name="users" /> Übergeben</button>
          <button className="btn" onClick={() => setEdit(true)}><Icon name="edit" /> Bearbeiten</button>
          <button className="btn" onClick={async () => { const r = await act(() => post<{ id: string }>(`/inventory/assets/${id}/duplicate`, {}), 'Kopie angelegt'); if (r) nav(`/inventory/${r.id}`); }} title="Gleiches Gerät noch einmal anlegen"><Icon name="copy" /></button>
          {me?.role === 'admin' && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
        </div>
      </div>
      {pendingMine && <div className="locked-banner"><Icon name="info" /><span className="grow">Dieser Gegenstand wurde Ihnen am {fmtDate(pendingMine.date)} übergeben.</span>
        <button className="btn sm primary" onClick={async () => { if (await act(() => post(`/inventory/handovers/${pendingMine.id}/confirm`, {}), 'Empfang bestätigt')) reload(); }}>Empfang bestätigen</button></div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'info', label: 'Übersicht' }, { id: 'inspections', label: `Prüfungen (${a.inspections.length})` }, { id: 'handovers', label: 'Übergaben' }, { id: 'afa', label: 'Abschreibung' }, { id: 'files', label: `Dateien (${a.attachments.length})` }]} />
      {tab === 'info' && <table className="table"><tbody>
        <tr><td className="muted" style={{ width: 220 }}>Kategorie</td><td>{a.category || '–'}</td></tr>
        <tr><td className="muted">Hersteller / Modell</td><td>{[a.manufacturer, a.model].filter(Boolean).join(' ') || '–'}</td></tr>
        <tr><td className="muted">Seriennummer</td><td className="mono">{a.serialNo || '–'}</td></tr>
        <tr><td className="muted">Abteilung</td><td>{a.teamName ?? '–'}</td></tr>
        <tr><td className="muted">Lieferant</td><td>{a.supplierName ?? '–'}</td></tr>
        <tr><td className="muted">Anschaffung</td><td>{a.purchaseDate ? fmtDate(a.purchaseDate) : '–'}{a.purchasePrice !== null && ` · ${fmtEuro2(a.purchasePrice)}`}</td></tr>
        <tr><td className="muted">Restbuchwert (Jahresende)</td><td>{a.bookValue !== null ? fmtEuro2(a.bookValue) : '–'}</td></tr>
        <tr><td className="muted">Garantie bis</td><td>{a.warrantyUntil ? <Pill tone={a.warrantyUntil < today() ? '' : 'green'}>{fmtDate(a.warrantyUntil)}</Pill> : '–'}</td></tr>
        {a.resourceId && <tr><td className="muted">Buchbar</td><td><Link to="/resources">als Ressource</Link></td></tr>}
        <tr><td className="muted">Zuletzt gesehen</td><td>{a.lastSeenAt ? `${fmtDateTime(a.lastSeenAt)} (${a.lastSeenBy})` : '–'}</td></tr>
        {a.notes && <tr><td className="muted">Notizen</td><td style={{ whiteSpace: 'pre-wrap' }}>{a.notes}</td></tr>}
      </tbody></table>}
      {tab === 'inspections' && <div>
        <div className="toolbar"><span className="small muted">Wiederkehrende Prüfungen mit Erinnerung, z. B. DGUV V3 alle 24 Monate.</span>
          <button className="btn primary right" onClick={() => setInsp({ kind: INSPECTION_KINDS[0], intervalMonths: 24, nextDate: today(), responsibleId: a.holderId ?? '' })}><Icon name="plus" /> Prüfung</button></div>
        {!a.inspections.length && <Empty icon="shield" title="Keine Prüfungen hinterlegt" />}
        {a.inspections.map((i: any) => (
          <div key={i.id} className="card" style={{ marginBottom: 10 }}>
            <div className="row"><b className="grow">{i.kind}</b><span className="small muted">alle {i.intervalMonths} Monate · {i.responsibleName ?? 'niemand verantwortlich'}</span>
              {i.nextDate && <Pill tone={dueTone(i.nextDate)}>fällig {fmtDate(i.nextDate)}</Pill>}
              <button className="btn sm primary" onClick={() => setLog({ inspection: i, date: today(), result: 'ok', notes: '', attachments: [] })}>Durchgeführt</button>
              <button className="btn sm ghost" onClick={() => setInsp(i)}><Icon name="edit" /></button></div>
            {i.log.length > 0 && <table className="table small" style={{ marginTop: 8 }}><tbody>{i.log.map((l: any) => (
              <tr key={l.id}><td style={{ width: 100 }}>{fmtDate(l.date)}</td><td><Pill tone={l.result === 'ok' ? 'green' : l.result === 'defect' ? 'amber' : 'red'}>{{ ok: 'bestanden', defect: 'Mängel', failed: 'nicht bestanden' }[l.result as string]}</Pill></td>
                <td>{l.notes}{l.attachments.map((f: any) => <a key={f.path} className="small" style={{ marginLeft: 8 }} href={`/api/inventory/file?path=${encodeURIComponent(f.path)}`} target="_blank" rel="noreferrer"><Icon name="paperclip" /> {f.name}</a>)}</td>
                <td className="muted">{l.userName}</td></tr>
            ))}</tbody></table>}
          </div>
        ))}
      </div>}
      {tab === 'handovers' && <div>
        {!a.handovers.length && <Empty icon="users" title="Noch keine Übergaben">Mit „Übergeben“ wechselt die verantwortliche Person; es entsteht ein Übergabeprotokoll.</Empty>}
        <table className="table"><tbody>{a.handovers.map((h: any) => (
          <tr key={h.id}><td>{fmtDate(h.date)}</td><td>{h.fromName ?? 'Firma'} → <b>{h.toName ?? 'Firma'}</b></td><td className="small">{h.note}</td>
            <td>{h.toName && (h.confirmedAt ? <Pill tone="green">bestätigt</Pill> : <Pill tone="amber">nicht bestätigt</Pill>)}</td>
            <td><a className="btn sm" href={`/api/inventory/handovers/${h.id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file-pdf" /> Protokoll</a></td></tr>
        ))}</tbody></table>
      </div>}
      {tab === 'afa' && <div>
        {!a.depreciation.length ? <p className="muted">{!a.purchasePrice || !a.purchaseDate ? 'Für die Abschreibung bitte Anschaffungsdatum und -wert eintragen.' : 'Bitte eine Nutzungsdauer eintragen (bis 800 € ohne Nutzungsdauer: sofort abgeschrieben).'}</p> : (
          <table className="table"><thead><tr><th>Jahr</th><th style={{ textAlign: 'right' }}>Buchwert Jahresanfang</th><th style={{ textAlign: 'right' }}>Abschreibung</th><th style={{ textAlign: 'right' }}>Buchwert Jahresende</th></tr></thead>
            <tbody>{a.depreciation.map((r: any) => <tr key={r.year} className={r.year === new Date().getFullYear() ? 'row-current' : ''}><td>{r.year}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(r.start)}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(r.amount)}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(r.end)}</td></tr>)}</tbody></table>
        )}
        <p className="hint">Lineare Abschreibung, monatsgenau ab dem Anschaffungsmonat. Die Werte sind eine Hilfe – maßgeblich bleibt die Buchhaltung bzw. der Steuerberater.</p>
      </div>}
      {tab === 'files' && <div>
        <div className="toolbar"><label className="btn"><Icon name="upload" /> Dateien hinzufügen<input type="file" multiple hidden onChange={(e) => void uploadFiles(e.target.files)} /></label>
          <span className="small muted">z. B. Rechnung, Bedienungsanleitung, Prüfbericht</span></div>
        <table className="table"><tbody>{a.attachments.map((f: any) => (
          <tr key={f.path}><td><a href={`/api/inventory/file?path=${encodeURIComponent(f.path)}`} target="_blank" rel="noreferrer"><Icon name="paperclip" /> {f.name}</a></td><td className="small muted">{fmtBytes(f.size)}</td>
            <td><button className="btn sm ghost danger" onClick={async () => { if (await act(() => del(`/inventory/assets/${id}/files?path=${encodeURIComponent(f.path)}`))) reload(); }}><Icon name="trash" /></button></td></tr>
        ))}</tbody></table>
      </div>}
      {edit && <AssetEditor asset={a} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />}
      {remove && <Confirm danger text={`${a.number} „${a.name}“ endgültig löschen? Normalerweise wird ausgemustert (Status ändern).`} onClose={() => setRemove(false)}
        onConfirm={async () => { if (await act(() => del(`/inventory/assets/${id}`), 'Gelöscht')) nav('/inventory'); }} />}
      {insp && <InspectionModal assetId={id} insp={insp} onClose={() => setInsp(null)} onSaved={() => { setInsp(null); reload(); }} />}
      {log && <Modal title={`Prüfung durchgeführt: ${log.inspection.kind}`} onClose={() => setLog(null)} footer={<><button className="btn" onClick={() => setLog(null)}>Abbrechen</button>
        <button className="btn primary" onClick={async () => { const r = await act(() => post<{ nextDate: string }>(`/inventory/inspections/${log.inspection.id}/log`, { date: log.date, result: log.result, notes: log.notes, attachments: log.attachments }), 'Eingetragen'); if (r) { setLog(null); reload(); } }}>Speichern</button></>}>
        <div className="grid2">
          <Field label="Datum"><input type="date" value={log.date} onChange={(e) => setLog({ ...log, date: e.target.value })} /></Field>
          <Field label="Ergebnis"><select value={log.result} onChange={(e) => setLog({ ...log, result: e.target.value })}><option value="ok">bestanden</option><option value="defect">Mängel (weiter nutzbar)</option><option value="failed">nicht bestanden (Reparatur)</option></select></Field>
        </div>
        <Field label="Bemerkung"><textarea rows={3} value={log.notes} onChange={(e) => setLog({ ...log, notes: e.target.value })} /></Field>
        <label className="btn sm"><Icon name="paperclip" /> Prüfbericht anhängen<input type="file" multiple hidden onChange={async (e) => {
          const files = e.target.files; if (!files?.length) return;
          const fd = new FormData(); for (const f of files) fd.append('file', f, f.name);
          const r = await act(() => upload(`/inventory/assets/${id}/files`, fd)); if (r) { setLog({ ...log, attachments: [...log.attachments, ...r] }); reload(); }
        }} /></label>
        {log.attachments.map((f: any) => <div key={f.path} className="small"><Icon name="paperclip" /> {f.name}</div>)}
        <p className="hint">Der nächste Termin wird automatisch berechnet (Datum + {log.inspection.intervalMonths} Monate).</p>
      </Modal>}
      {handover && <HandoverModal asset={a} users={users} onClose={() => setHandover(false)} onDone={() => { setHandover(false); reload(); setTab('handovers'); }} />}
    </div>
  );
}

function InspectionModal({ assetId, insp, onClose, onSaved }: { assetId: string; insp: any; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const { users } = useSession();
  const [f, setF] = useState({ kind: insp.kind, intervalMonths: insp.intervalMonths, nextDate: insp.nextDate ?? '', responsibleId: insp.responsibleId ?? '', notes: insp.notes ?? '' });
  const [remove, setRemove] = useState(false);
  return (
    <Modal title={insp.id ? 'Prüfung bearbeiten' : 'Neue Prüfung'} onClose={onClose} footer={<>
      {insp.id && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.kind.trim()} onClick={async () => {
        const body = { ...f, intervalMonths: Number(f.intervalMonths), nextDate: f.nextDate || null, responsibleId: f.responsibleId || null };
        if (await act(() => (insp.id ? patch(`/inventory/inspections/${insp.id}`, body) : post(`/inventory/assets/${assetId}/inspections`, body)), 'Gespeichert')) onSaved();
      }}>Speichern</button></>}>
      <Field label="Art der Prüfung"><input list="insp-kinds" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} /><datalist id="insp-kinds">{INSPECTION_KINDS.map((k) => <option key={k} value={k} />)}</datalist></Field>
      <div className="grid2">
        <Field label="Intervall (Monate)"><input type="number" min={1} value={f.intervalMonths} onChange={(e) => setF({ ...f, intervalMonths: e.target.value })} /></Field>
        <Field label="Nächster Termin"><input type="date" value={f.nextDate} onChange={(e) => setF({ ...f, nextDate: e.target.value })} /></Field>
      </div>
      <Field label="Verantwortlich" hint="bekommt die Erinnerung"><UserSelect users={users} value={f.responsibleId || null} onChange={(v) => setF({ ...f, responsibleId: v ?? '' })} /></Field>
      <Field label="Hinweise"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="z. B. Prüfer, Prüfmittel" /></Field>
      {remove && <Confirm danger text="Diese Prüfung mit ihrem Verlauf löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/inventory/inspections/${insp.id}`))) onSaved(); }} />}
    </Modal>
  );
}

function HandoverModal({ asset, users, onClose, onDone }: { asset: any; users: any[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [to, setTo] = useState<string>('');
  const [note, setNote] = useState('');
  const [loc, setLoc] = useState(asset.location ?? '');
  return (
    <Modal title={`Übergeben: ${asset.number} ${asset.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" onClick={async () => { if (await act(() => post(`/inventory/assets/${asset.id}/handover`, { toUserId: to || null, note, location: loc }), 'Übergabe erfasst')) onDone(); }}>Übergeben</button></>}>
      <p className="small muted" style={{ marginTop: 0 }}>Bisher: {asset.holderName ?? 'niemand (Firma)'}</p>
      <Field label="An" hint="leer = Rückgabe an die Firma"><UserSelect users={users} value={to || null} onChange={(v) => setTo(v ?? '')} placeholder="– zurück an die Firma –" /></Field>
      <Field label="Neuer Standort"><input value={loc} onChange={(e) => setLoc(e.target.value)} /></Field>
      <Field label="Bemerkung" hint="z. B. Zubehör, Zustand"><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <p className="hint">Die empfangende Person bekommt eine Nachricht und bestätigt den Empfang in AperioPlan. Das Protokoll lässt sich als PDF drucken.</p>
    </Modal>
  );
}
