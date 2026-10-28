import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, fmtEuro2, isoDate } from '../lib/format';
import { Empty, Field, Modal, Pill, SlideOver, Tabs, UserSelect, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { useAdminSettings } from './Settings';

const KIND: Record<string, string> = { car: 'Pkw', van: 'Transporter', truck: 'Lkw', trailer: 'Anhänger', other: 'Sonstiges' };
const ENTRY: Record<string, string> = { fuel: 'Tanken', charge: 'Laden', service: 'Inspektion', repair: 'Reparatur', tires: 'Reifen', insurance: 'Versicherung', tax: 'Kfz-Steuer', leasing: 'Leasing', other: 'Sonstiges' };
const TRIP: Record<string, string> = { business: 'dienstlich', private: 'privat', commute: 'Arbeitsweg' };
const DAMAGE: Record<string, [string, string]> = { open: ['offen', 'red'], repaired: ['repariert', 'green'], closed: ['erledigt', ''] };
const km = (n: number | null | undefined) => (n == null ? '' : `${n.toLocaleString('de-DE')} km`);
const soon = (d: string | null) => !!d && d <= isoDate(new Date(Date.now() + 30 * 86400000));

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'fleet.changed') void reload(); }), [reload]);
}

type Tab = 'vehicles' | 'licenses' | 'settings';

export default function FleetPage() {
  useCrumbs([{ label: 'Fuhrpark' }]);
  const { me } = useSession();
  const { data, reload } = useApi<any[]>('/fleet/vehicles');
  const { data: access } = useApi<{ manager: boolean }>('/fleet/access');
  const [tab, setTab] = useTabState<Tab>('fleet', 'vehicles');
  const [params, setParams] = useSearchParams();
  const [edit, setEdit] = useState<any | null>(null);
  const open = params.get('vehicle');
  const setOpen = (id: string | null) => { if (id) params.set('vehicle', id); else params.delete('vehicle'); setParams(params, { replace: true }); };
  useLive(reload);
  const mgr = !!access?.manager;
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Fuhrpark</h1><div className="sub">Fahrzeuge, Kosten, Fahrtenbuch, Schäden und Termine</div></div>
        {mgr && tab === 'vehicles' && <div className="actions"><button className="btn primary" onClick={() => setEdit({ plate: '', make: '', model: '', vin: '', kind: 'car', fuel: 'diesel', firstRegistration: null, listPrice: null, ownership: 'owned', leasingEnd: null, leasingRate: null, driverId: null, privateUse: false, resourceId: null, mileage: 0, nextHu: null, nextService: null, serviceKm: null, insurance: '', notes: '', active: true })}><Icon name="plus" /> Fahrzeug</button></div>}</div>
      {mgr && <Tabs value={tab} onChange={setTab} tabs={[{ id: 'vehicles', label: 'Fahrzeuge' }, { id: 'licenses', label: 'Führerscheinkontrolle' }, ...(me?.role === 'admin' ? [{ id: 'settings' as Tab, label: 'Einstellungen' }] : [])]} />}
      {tab === 'vehicles' && data && (!data.length ? <Empty icon="truck" title="Noch keine Fahrzeuge">{mgr ? 'Lege Dienstwagen, Transporter und Anhänger an – mit Fahrer, Terminen und Kosten.' : 'Fahrzeuge legen die Fuhrparkverantwortlichen an.'}</Empty>
        : <table className="table"><thead><tr><th>Kennzeichen</th><th>Fahrzeug</th><th>Fahrer</th><th>km-Stand</th><th>HU</th><th>Inspektion</th><th>Kosten 12 Mon.</th><th>€/km</th></tr></thead>
          <tbody>{data.map((v) => (
            <tr key={v.id} className="click" onClick={() => setOpen(v.id)} style={!v.active ? { opacity: 0.5 } : undefined}>
              <td><b>{v.plate}</b>{v.openDamages > 0 && <span className="pill small red" style={{ marginLeft: 6 }}>{v.openDamages} Schaden</span>}</td>
              <td>{[v.make, v.model].filter(Boolean).join(' ')}<div className="small muted">{KIND[v.kind]} · {v.fuel}</div></td>
              <td>{v.driverName ?? <span className="muted">Pool</span>}</td><td>{km(v.mileage)}</td>
              <td className={soon(v.nextHu) ? 'text-red' : ''}>{fmtDate(v.nextHu)}</td><td className={soon(v.nextService) ? 'text-red' : ''}>{fmtDate(v.nextService)}</td>
              <td>{fmtEuro2(v.cost12)}</td><td>{v.costPerKm != null ? v.costPerKm.toLocaleString('de-DE', { minimumFractionDigits: 2 }) : ''}</td>
            </tr>
          ))}</tbody></table>)}
      {tab === 'licenses' && <Licenses />}
      {tab === 'settings' && <FleetSettings />}
      {open && <VehiclePanel id={open} onClose={() => setOpen(null)} onEdit={setEdit} />}
      {edit && <VehicleModal v={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function VehiclePanel({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (v: any) => void }) {
  const { data: v, reload } = useApi<any>(`/fleet/vehicles/${id}`, [id]);
  const act = useAction();
  const toast = useToast();
  const [tab, setTab] = useState<'trips' | 'costs' | 'damages' | 'info'>('trips');
  const last = v?.trips[0];
  const [t, setT] = useState<any>(null);
  const [e, setE] = useState({ date: isoDate(new Date()), kind: 'fuel', amount: '', liters: '', mileage: '', note: '' });
  const [d, setD] = useState({ date: isoDate(new Date()), description: '' });
  useLive(reload);
  useEffect(() => { if (v && !t) setT({ date: isoDate(new Date()), startKm: last?.endKm ?? v.mileage, endKm: '', origin: last?.destination ?? '', destination: '', purpose: '', partner: '', kind: 'business' }); }, [v, t, last]);
  if (!v || !t) return null;
  const year = new Date().getFullYear();
  return (
    <SlideOver wide title={`${v.plate} – ${[v.make, v.model].filter(Boolean).join(' ')}`} onClose={onClose}>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <span className="grow small muted">{km(v.mileage)} · Fahrer: {v.driverName ?? 'Pool'}{v.benefitMonthly ? ` · geldwerter Vorteil ${fmtEuro2(v.benefitMonthly)}/Monat` : ''}</span>
        <a className="btn sm" href={`/api/fleet/vehicles/${id}/logbook.xlsx?year=${year}`}><Icon name="download" /> Fahrtenbuch {year}</a>
        {v.manager && <button className="btn sm" onClick={() => onEdit(v)}><Icon name="edit" /> Bearbeiten</button>}
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'trips', label: 'Fahrtenbuch' }, { id: 'costs', label: 'Kosten' }, { id: 'damages', label: `Schäden${v.damages.filter((x: any) => x.status === 'open').length ? ` (${v.damages.filter((x: any) => x.status === 'open').length})` : ''}` }, { id: 'info', label: 'Daten' }]} />
      {tab === 'trips' && <>
        <form className="card flat" style={{ marginBottom: 10 }} onSubmit={async (ev) => {
          ev.preventDefault();
          const r = await act(() => post<{ gap: number }>(`/fleet/vehicles/${id}/trips`, { ...t, startKm: Number(t.startKm), endKm: Number(t.endKm) }));
          if (r) { if (r.gap > 0) toast(`Hinweis: ${r.gap} km Lücke zur vorherigen Fahrt`); setT(null); void reload(); }
        }}>
          <div className="grid4">
            <Field label="Datum"><input type="date" value={t.date} onChange={(x) => setT({ ...t, date: x.target.value })} /></Field>
            <Field label="km Beginn"><input type="number" value={t.startKm} onChange={(x) => setT({ ...t, startKm: x.target.value })} /></Field>
            <Field label="km Ende"><input type="number" required value={t.endKm} onChange={(x) => setT({ ...t, endKm: x.target.value })} /></Field>
            <Field label="Art"><select value={t.kind} onChange={(x) => setT({ ...t, kind: x.target.value })}>{Object.entries(TRIP).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </div>
          <div className="grid2">
            <Field label="Start"><input value={t.origin} onChange={(x) => setT({ ...t, origin: x.target.value })} /></Field>
            <Field label="Ziel"><input value={t.destination} onChange={(x) => setT({ ...t, destination: x.target.value })} /></Field>
          </div>
          {t.kind === 'business' && <div className="grid2">
            <Field label="Zweck"><input value={t.purpose} onChange={(x) => setT({ ...t, purpose: x.target.value })} placeholder="z. B. Montage, Kundentermin" /></Field>
            <Field label="Geschäftspartner"><input value={t.partner} onChange={(x) => setT({ ...t, partner: x.target.value })} /></Field>
          </div>}
          <button className="btn primary sm" type="submit">Fahrt eintragen</button>
        </form>
        <table className="table small"><thead><tr><th>Datum</th><th>km</th><th>Strecke</th><th>Zweck</th><th>Fahrer</th><th /></tr></thead>
          <tbody>{v.trips.map((x: any, i: number) => (
            <tr key={x.id}><td>{fmtDate(x.date)}</td><td>{x.startKm.toLocaleString('de-DE')}–{x.endKm.toLocaleString('de-DE')}<div className="muted">{x.endKm - x.startKm} km</div></td>
              <td>{x.origin} → {x.destination}</td><td>{x.kind === 'business' ? `${x.purpose}${x.partner ? ` (${x.partner})` : ''}` : TRIP[x.kind]}</td><td>{x.userName}</td>
              <td>{i === 0 && <button className="btn ghost sm" title="Nur die letzte Fahrt der vergangenen 7 Tage lässt sich löschen" onClick={async () => { if (await act(() => del(`/fleet/trips/${x.id}`))) { setT(null); void reload(); } }}><Icon name="trash" /></button>}</td></tr>
          ))}</tbody></table>
        <p className="hint">Das Fahrtenbuch muss zeitnah und lückenlos geführt werden; nachträgliches Ändern ist nicht möglich.</p>
      </>}
      {tab === 'costs' && <>
        <form className="row wrap" style={{ gap: 6, marginBottom: 10 }} onSubmit={async (ev) => {
          ev.preventDefault();
          if (await act(() => post(`/fleet/vehicles/${id}/entries`, { date: e.date, kind: e.kind, amount: Number(e.amount.replace(',', '.')), liters: e.liters ? Number(e.liters.replace(',', '.')) : null, mileage: e.mileage ? Number(e.mileage) : null, note: e.note }))) { setE({ ...e, amount: '', liters: '', mileage: '', note: '' }); void reload(); }
        }}>
          <input type="date" style={{ width: 140 }} value={e.date} onChange={(x) => setE({ ...e, date: x.target.value })} />
          <select style={{ width: 130 }} value={e.kind} onChange={(x) => setE({ ...e, kind: x.target.value })}>{Object.entries(ENTRY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input style={{ width: 100 }} required placeholder="Betrag €" value={e.amount} onChange={(x) => setE({ ...e, amount: x.target.value })} />
          {(e.kind === 'fuel' || e.kind === 'charge') && <input style={{ width: 90 }} placeholder={e.kind === 'fuel' ? 'Liter' : 'kWh'} value={e.liters} onChange={(x) => setE({ ...e, liters: x.target.value })} />}
          <input style={{ width: 110 }} placeholder="km-Stand" value={e.mileage} onChange={(x) => setE({ ...e, mileage: x.target.value })} />
          <input className="grow" placeholder="Bemerkung" value={e.note} onChange={(x) => setE({ ...e, note: x.target.value })} />
          <button className="btn primary sm" type="submit">Erfassen</button>
        </form>
        <div className="small muted" style={{ marginBottom: 6 }}>Letzte 12 Monate: {fmtEuro2(v.cost12)} für {km(v.km12)}{v.costPerKm != null ? ` = ${v.costPerKm.toLocaleString('de-DE')} €/km` : ''}</div>
        <table className="table small"><tbody>{v.entries.map((x: any) => (
          <tr key={x.id}><td>{fmtDate(x.date)}</td><td>{ENTRY[x.kind]}</td><td className="num">{fmtEuro2(x.amount)}</td><td>{x.liters ? `${x.liters.toLocaleString('de-DE')} ${x.kind === 'charge' ? 'kWh' : 'l'}` : ''}</td><td>{km(x.mileage)}</td><td>{x.note}</td><td className="muted">{x.userName}</td>
            <td>{v.manager && <button className="btn ghost sm" onClick={async () => { if (await act(() => del(`/fleet/entries/${x.id}`))) void reload(); }}><Icon name="x" /></button>}</td></tr>
        ))}</tbody></table>
      </>}
      {tab === 'damages' && <>
        <form className="card flat" style={{ marginBottom: 10 }} onSubmit={async (ev) => { ev.preventDefault(); if (await act(() => post(`/fleet/vehicles/${id}/damages`, d), 'Schaden gemeldet')) { setD({ ...d, description: '' }); void reload(); } }}>
          <div className="row" style={{ gap: 6 }}><input type="date" style={{ width: 150 }} value={d.date} onChange={(x) => setD({ ...d, date: x.target.value })} />
            <input className="grow" required minLength={3} placeholder="Was ist beschädigt? Wo und wie ist es passiert?" value={d.description} onChange={(x) => setD({ ...d, description: x.target.value })} />
            <button className="btn primary sm" type="submit">Schaden melden</button></div>
        </form>
        {v.damages.map((x: any) => (
          <div key={x.id} className="card flat" style={{ marginBottom: 6 }}>
            <div className="row" style={{ gap: 6 }}><b className="grow">{fmtDate(x.date)} · {x.reportedByName}</b><Pill tone={DAMAGE[x.status]![1]}>{DAMAGE[x.status]![0]}</Pill></div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{x.description}</div>
            {v.manager && <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <select style={{ width: 140 }} value={x.status} onChange={async (ev) => { if (await act(() => patch(`/fleet/damages/${x.id}`, { status: ev.target.value }))) void reload(); }}>{Object.entries(DAMAGE).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
              <input style={{ width: 120 }} placeholder="Kosten €" defaultValue={x.cost ?? ''} onBlur={async (ev) => { const c = ev.target.value ? Number(ev.target.value.replace(',', '.')) : null; if (c !== x.cost && await act(() => patch(`/fleet/damages/${x.id}`, { cost: c }))) void reload(); }} />
            </div>}
          </div>
        ))}
      </>}
      {tab === 'info' && <table className="table small"><tbody>
        {([['Art', KIND[v.kind]], ['Antrieb', v.fuel], ['Fahrgestellnummer', v.vin], ['Erstzulassung', fmtDate(v.firstRegistration)], ['Bruttolistenpreis', v.listPrice != null ? fmtEuro2(v.listPrice) : ''],
          ['Eigentum', { owned: 'gekauft', leased: 'geleast', rented: 'gemietet' }[v.ownership as string]], ['Leasingende', fmtDate(v.leasingEnd)], ['Leasingrate', v.leasingRate != null ? fmtEuro2(v.leasingRate) : ''],
          ['Privatnutzung', v.privateUse ? 'ja' : 'nein'], ['Nächste HU', fmtDate(v.nextHu)], ['Nächste Inspektion', `${fmtDate(v.nextService)}${v.serviceKm ? ` / bei ${km(v.serviceKm)}` : ''}`], ['Versicherung', v.insurance], ['Notizen', v.notes]] as [string, string][])
          .filter(([, x]) => x).map(([k, x]) => <tr key={k}><td className="muted" style={{ width: 180 }}>{k}</td><td style={{ whiteSpace: 'pre-wrap' }}>{x}</td></tr>)}
      </tbody></table>}
    </SlideOver>
  );
}

function VehicleModal({ v, onClose, onDone }: { v: any; onClose: () => void; onDone: () => void }) {
  const { users } = useSession();
  const act = useAction();
  const [f, setF] = useState({ ...v });
  const keys = ['plate', 'make', 'model', 'vin', 'kind', 'fuel', 'firstRegistration', 'listPrice', 'ownership', 'leasingEnd', 'leasingRate', 'driverId', 'privateUse', 'mileage', 'nextHu', 'nextService', 'serviceKm', 'insurance', 'notes', 'active'];
  const body = Object.fromEntries(keys.map((k) => [k, f[k]]));
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value === '' ? null : Number(e.target.value) });
  const date = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value || null });
  return (
    <Modal size="lg" title={v.id ? 'Fahrzeug bearbeiten' : 'Neues Fahrzeug'} onClose={onClose} footer={<>
      {v.id && <button className="btn ghost danger" onClick={async () => { if (await act(() => del(`/fleet/vehicles/${v.id}`))) onDone(); }}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.plate.trim()} onClick={async () => { if (await act(() => (v.id ? patch(`/fleet/vehicles/${v.id}`, body) : post('/fleet/vehicles', { ...body, mileage: f.mileage ?? 0 })), 'Gespeichert')) onDone(); }}>Speichern</button></>}>
      <div className="grid4">
        <Field label="Kennzeichen"><input value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} placeholder="M-AB 1234" /></Field>
        <Field label="Hersteller"><input value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} /></Field>
        <Field label="Modell"><input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></Field>
        <Field label="Art"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      </div>
      <div className="grid4">
        <Field label="Antrieb"><select value={f.fuel} onChange={(e) => setF({ ...f, fuel: e.target.value })}>{['diesel', 'benzin', 'hybrid', 'electric', 'gas'].map((x) => <option key={x} value={x}>{{ diesel: 'Diesel', benzin: 'Benzin', hybrid: 'Plug-in-Hybrid', electric: 'Elektro', gas: 'Gas' }[x]}</option>)}</select></Field>
        <Field label="Erstzulassung"><input type="date" value={f.firstRegistration ?? ''} onChange={date('firstRegistration')} /></Field>
        <Field label="km-Stand"><input type="number" value={f.mileage ?? ''} onChange={num('mileage')} /></Field>
        <Field label="Fahrgestellnummer"><input value={f.vin} onChange={(e) => setF({ ...f, vin: e.target.value })} /></Field>
      </div>
      <div className="grid4">
        <Field label="Eigentum"><select value={f.ownership} onChange={(e) => setF({ ...f, ownership: e.target.value })}><option value="owned">gekauft</option><option value="leased">geleast</option><option value="rented">gemietet</option></select></Field>
        <Field label="Leasingende"><input type="date" value={f.leasingEnd ?? ''} onChange={date('leasingEnd')} /></Field>
        <Field label="Leasingrate €"><input type="number" step="0.01" value={f.leasingRate ?? ''} onChange={num('leasingRate')} /></Field>
        <Field label="Bruttolistenpreis €"><input type="number" value={f.listPrice ?? ''} onChange={num('listPrice')} /></Field>
      </div>
      <div className="grid2">
        <Field label="Fahrer" hint="leer = Poolfahrzeug"><UserSelect users={users} value={f.driverId} onChange={(x) => setF({ ...f, driverId: x })} placeholder="– Pool –" /></Field>
        <Field label="Privatnutzung"><label className="row"><input type="checkbox" checked={f.privateUse} onChange={(e) => setF({ ...f, privateUse: e.target.checked })} /> Fahrer darf privat fahren (geldwerter Vorteil)</label></Field>
      </div>
      <div className="grid3">
        <Field label="Nächste HU"><input type="date" value={f.nextHu ?? ''} onChange={date('nextHu')} /></Field>
        <Field label="Nächste Inspektion"><input type="date" value={f.nextService ?? ''} onChange={date('nextService')} /></Field>
        <Field label="… oder bei km"><input type="number" value={f.serviceKm ?? ''} onChange={num('serviceKm')} /></Field>
      </div>
      <Field label="Versicherung"><input value={f.insurance} onChange={(e) => setF({ ...f, insurance: e.target.value })} placeholder="Versicherer, Vertragsnummer" /></Field>
      <Field label="Notizen"><textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> im Einsatz</label>
    </Modal>
  );
}

function Licenses() {
  const { data, reload } = useApi<any[]>('/fleet/licenses');
  const act = useAction();
  const [check, setCheck] = useState<any | null>(null);
  useLive(reload);
  if (!data) return null;
  return (
    <div>
      <p className="hint">Halter müssen regelmäßig prüfen, dass Fahrer einen gültigen Führerschein haben. Hier wird die Sichtkontrolle mit Datum und Klassen festgehalten.</p>
      <table className="table"><thead><tr><th>Mitarbeiter</th><th>Letzte Kontrolle</th><th>Klassen</th><th>Nächste fällig</th><th /></tr></thead>
        <tbody>{data.map((r) => (
          <tr key={r.id}><td>{r.displayName}{r.drives && <span className="small muted"> · fährt</span>}</td><td>{fmtDate(r.last)}</td><td>{r.classes}</td>
            <td className={r.overdue ? 'text-red' : ''}>{r.overdue && !r.last ? 'noch nie' : fmtDate(r.due)}</td>
            <td><button className="btn sm" onClick={() => setCheck({ userId: r.id, name: r.displayName, date: isoDate(new Date()), classes: r.classes ?? 'B', note: '' })}><Icon name="check" /> Kontrolliert</button></td></tr>
        ))}</tbody></table>
      {check && <Modal title={`Führerscheinkontrolle ${check.name}`} onClose={() => setCheck(null)} footer={<><button className="btn" onClick={() => setCheck(null)}>Abbrechen</button>
        <button className="btn primary" onClick={async () => { if (await act(() => post('/fleet/licenses', { userId: check.userId, date: check.date, classes: check.classes, note: check.note }), 'Gespeichert')) { setCheck(null); void reload(); } }}>Speichern</button></>}>
        <div className="grid2">
          <Field label="Datum"><input type="date" value={check.date} onChange={(e) => setCheck({ ...check, date: e.target.value })} /></Field>
          <Field label="Klassen"><input value={check.classes} onChange={(e) => setCheck({ ...check, classes: e.target.value })} /></Field>
        </div>
        <Field label="Bemerkung"><input value={check.note} onChange={(e) => setCheck({ ...check, note: e.target.value })} /></Field>
      </Modal>}
    </div>
  );
}

function FleetSettings() {
  const s = useAdminSettings('fleet');
  const { users } = useSession();
  const act = useAction();
  if (!s.value) return null;
  return (
    <div style={{ maxWidth: 760 }}>
      <Field label="Fuhrparkverantwortliche" hint="legen Fahrzeuge an, sehen alle Kosten und erhalten Schadensmeldungen und Terminerinnerungen"><UserPicker users={users} value={s.value.managerIds} onChange={(ids) => s.setValue({ ...s.value, managerIds: ids })} /></Field>
      <Field label="Führerscheinkontrolle alle (Monate)"><input type="number" min={1} max={24} value={s.value.licenseCheckMonths} onChange={(e) => s.setValue({ ...s.value, licenseCheckMonths: Number(e.target.value) })} /></Field>
      <button className="btn primary" onClick={() => act(() => s.save(s.value), 'Gespeichert')}>Speichern</button>
    </div>
  );
}
