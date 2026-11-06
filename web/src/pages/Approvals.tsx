import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, fmtDateTime, fmtEuro2 } from '../lib/format';
import { Avatar, Empty, Field, Modal, Pill, SlideOver, Tabs, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { ProjectSelect, uploadForm } from '../modules/Pickers';
import { ProjectGroups, TabHead, useGrouping, type TabProps } from '../modules/ProjectApps';
import { useAdminSettings } from './Settings';

const STATUS: Record<string, [string, string]> = { pending: ['offen', 'amber'], approved: ['genehmigt', 'green'], rejected: ['abgelehnt', 'red'], withdrawn: ['zurückgezogen', ''] };
const FIELD_TYPES: Record<string, string> = { text: 'Text', textarea: 'langer Text', number: 'Zahl', money: 'Betrag (€)', date: 'Datum', select: 'Auswahl', checkbox: 'Ja/Nein' };
const STEP_KIND: Record<string, string> = { lead: 'Teamleitung', users: 'bestimmte Personen', admin: 'Geschäftsführung (Administratoren)' };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'approvals.changed') void reload(); }), [reload]);
}
const show = (f: any, v: unknown) => (v === undefined || v === null || v === '' ? '–' : f.type === 'money' ? fmtEuro2(Number(v)) : f.type === 'date' ? fmtDate(String(v)) : f.type === 'checkbox' ? (v ? 'ja' : 'nein') : String(v));

type Tab = 'mine' | 'todo' | 'all' | 'types';

export default function ApprovalsPage() {
  useCrumbs([{ label: 'Freigaben' }]);
  const { data: access } = useApi<{ manager: boolean }>('/approvals/access');
  const { data: todo, reload: reloadTodo } = useApi<any[]>('/approvals/requests?scope=todo');
  const [tab, setTab] = useTabState<Tab>('approvals', 'mine');
  const [params, setParams] = useSearchParams();
  const [create, setCreate] = useState(false);
  const open = params.get('request');
  const setOpen = (id: string | null) => { if (id) params.set('request', id); else params.delete('request'); setParams(params, { replace: true }); };
  useLive(reloadTodo);
  const mgr = !!access?.manager;
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Freigaben</h1><div className="sub">Anträge stellen und genehmigen</div></div>
        <div className="actions">{mgr && tab === 'all' && <a className="btn" href="/api/approvals/export.xlsx"><Icon name="download" /> Excel</a>}
          <button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Antrag</button></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'mine', label: 'Meine Anträge' }, { id: 'todo', label: `Zu genehmigen${todo?.length ? ` (${todo.length})` : ''}` },
        ...(mgr ? [{ id: 'all' as Tab, label: 'Alle Anträge' }, { id: 'types' as Tab, label: 'Antragsarten' }] : [])]} />
      {tab === 'types' ? <Types /> : <List scope={tab} onOpen={setOpen} />}
      {create && <NewRequest onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); setTab('mine'); setOpen(id); }} />}
      {open && <RequestPanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function List({ scope, onOpen }: { scope: string; onOpen: (id: string) => void }) {
  const { data, reload } = useApi<any[]>(`/approvals/requests?scope=${scope}`, [scope]);
  const [grouped, groupToggle] = useGrouping('approvals', false);
  useLive(reload);
  if (!data) return null;
  if (!data.length) return <Empty icon="approve" title={scope === 'todo' ? 'Nichts zu genehmigen' : 'Keine Anträge'}>{scope === 'mine' ? 'Über „Antrag“ eine Anschaffung, Weiterbildung oder etwas anderes zur Genehmigung einreichen.' : undefined}</Empty>;
  if (scope === 'mine') return <RequestTable rows={data} onOpen={onOpen} />;
  return (
    <div>
      <div className="toolbar">{groupToggle}</div>
      {grouped ? <ProjectGroups rows={data} tab="approvals">{(rows) => <RequestTable rows={rows} showUser onOpen={onOpen} />}</ProjectGroups> : <RequestTable rows={data} showUser onOpen={onOpen} />}
    </div>
  );
}

function RequestTable({ rows, showUser, onOpen }: { rows: any[]; showUser?: boolean; onOpen: (id: string) => void }) {
  return (
    <table className="table"><thead><tr><th>Nummer</th><th>Antrag</th>{showUser && <th>von</th>}<th>Betrag</th><th>Stufe</th><th>Status</th><th>Datum</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id} className="click" onClick={() => onOpen(r.id)}>
          <td className="mono small">{r.number}</td><td><b>{r.title}</b><div className="small muted">{r.typeName}</div></td>
          {showUser && <td>{r.userName}</td>}<td className="num">{r.amount !== null ? fmtEuro2(r.amount) : ''}</td>
          <td className="small">{r.status === 'pending' ? `${r.step + 1} von ${r.steps.length}` : ''}</td>
          <td><Pill tone={STATUS[r.status]![1]}>{STATUS[r.status]![0]}</Pill></td><td>{fmtDate(r.createdAt)}</td>
        </tr>
      ))}</tbody></table>
  );
}

/** Projekt-Reiter „Freigaben“: Anträge zum Projekt (Leitung alle, sonst eigene und zu genehmigende) */
export function ProjectApprovals({ project }: TabProps) {
  const { data, reload } = useApi<any[]>(`/approvals/requests?scope=project&projectId=${project.id}`);
  useLive(reload);
  const [create, setCreate] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const approved = (data ?? []).filter((r) => r.status === 'approved').reduce((a, r) => a + (r.amount ?? 0), 0);
  return (
    <div>
      <div className="kpi-row">
        <div className="kpi"><div className="v">{(data ?? []).filter((r) => r.status === 'pending').length}</div><div className="l">offen</div></div>
        <div className="kpi"><div className="v">{fmtEuro2(approved)}</div><div className="l">genehmigt</div></div>
      </div>
      <TabHead hint="z. B. Anschaffungen oder Fremdleistungen für das Projekt" to="/approvals" toLabel="Alle Freigaben" newLabel="Antrag" onNew={() => setCreate(true)} />
      {data && !data.length ? <Empty icon="approve" title="Keine Anträge zu diesem Projekt" /> : data && <RequestTable rows={data} showUser onOpen={setOpen} />}
      {create && <NewRequest projectId={project.id} onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); void reload(); setOpen(id); }} />}
      {open && <RequestPanel id={open} onClose={() => { setOpen(null); void reload(); }} />}
    </div>
  );
}

function NewRequest({ onClose, onDone, projectId: fixedProject }: { onClose: () => void; onDone: (id: string) => void; projectId?: string }) {
  const { data: types } = useApi<any[]>('/approvals/types');
  const act = useAction();
  const [type, setType] = useState<any | null>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState<string | null>(fixedProject ?? null);
  const [files, setFiles] = useState<File[]>([]);
  if (!type) return (
    <Modal title="Was möchtest du beantragen?" onClose={onClose}>
      <div className="bk-types">{types?.map((t) => (
        <div key={t.id} className="card click" onClick={() => setType(t)}><div className="row" style={{ gap: 8 }}><Icon name={t.icon} /><b>{t.name}</b></div><div className="small muted">{t.description}</div></div>
      ))}</div>
    </Modal>
  );
  const set = (k: string, v: unknown) => setData({ ...data, [k]: v });
  return (
    <Modal size="lg" title={type.name} onClose={onClose} footer={<><button className="btn ghost" onClick={() => setType(null)}>Zurück</button><span className="grow" /><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" onClick={async () => {
        const r = await act(async () => {
          const res = await post<{ id: string }>('/approvals/requests', { typeId: type.id, title, data, projectId });
          for (const f of files) await uploadForm(`/approvals/requests/${res.id}/files`, {}, f);
          return res;
        }, 'Eingereicht');
        if (r) onDone(r.id);
      }}><Icon name="send" /> Einreichen</button></>}>
      <Field label="Titel" hint="leer = automatisch"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      {type.fields.map((f: any) => (
        <Field key={f.id} label={f.label} required={f.required}>
          {f.type === 'textarea' ? <textarea rows={4} value={String(data[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} />
            : f.type === 'select' ? <select value={String(data[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)}><option value="">–</option>{f.options.map((o: string) => <option key={o}>{o}</option>)}</select>
            : f.type === 'checkbox' ? <label className="row"><input type="checkbox" checked={Boolean(data[f.id])} onChange={(e) => set(f.id, e.target.checked)} /> ja</label>
            : <input type={f.type === 'date' ? 'date' : f.type === 'number' || f.type === 'money' ? 'number' : 'text'} step={f.type === 'money' ? '0.01' : undefined} value={String(data[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} />}
        </Field>
      ))}
      <div className="grid2">
        <Field label="Projekt"><ProjectSelect value={projectId} onChange={setProjectId} /></Field>
        <Field label="Anhänge" hint="z. B. Angebot"><input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} /></Field>
      </div>
      <p className="hint">Genehmigung: {type.steps.map((s: any) => `${STEP_KIND[s.kind]}${s.minAmount ? ` (ab ${fmtEuro2(s.minAmount)})` : ''}`).join(' → ')}</p>
    </Modal>
  );
}

function RequestPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: r, reload } = useApi<any>(`/approvals/requests/${id}`, [id]);
  const act = useAction();
  const [note, setNote] = useState('');
  useLive(reload);
  if (!r) return null;
  const decide = async (approve: boolean) => { if (await act(() => post(`/approvals/requests/${id}/decide`, { approve, note }), approve ? 'Genehmigt' : 'Abgelehnt')) { setNote(''); void reload(); } };
  return (
    <SlideOver title={`${r.number} · ${r.title}`} onClose={onClose}>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}><Avatar id={r.userId} name={r.userName} /><span className="grow">{r.userName} · {r.typeName} · {fmtDateTime(r.createdAt)}</span><Pill tone={STATUS[r.status]![1]}>{STATUS[r.status]![0]}</Pill></div>
      <table className="table small"><tbody>{r.fields.map((f: any) => <tr key={f.id}><td className="muted" style={{ width: 180 }}>{f.label}</td><td style={{ whiteSpace: 'pre-wrap' }}>{show(f, r.data[f.id])}</td></tr>)}
        {r.projectNumber && <tr><td className="muted">Projekt</td><td>{r.projectNumber} {r.projectName}</td></tr>}</tbody></table>
      {r.files.length > 0 && <div style={{ margin: '8px 0' }}>{r.files.map((f: any) => <div key={f.id}><a href={`/api/approvals/requests/${id}/files/${f.id}`} target="_blank" rel="noreferrer"><Icon name="paperclip" /> {f.name}</a></div>)}</div>}
      <h3>Genehmigung</h3>
      {!r.steps.length && <p className="muted small">Keine Genehmigung nötig – automatisch genehmigt.</p>}
      <ol className="apr-steps">{r.steps.map((s: any, i: number) => {
        const ds = r.decisions.filter((d: any) => d.step === i);
        const state = i < r.step || r.status === 'approved' ? 'done' : i === r.step && r.status === 'pending' ? 'current' : r.status === 'rejected' && ds.some((d: any) => !d.approve) ? 'rejected' : '';
        return (
          <li key={i} className={state}>
            <b>Stufe {i + 1}: {s.label}</b>{s.all && <span className="small muted"> (alle müssen zustimmen)</span>}
            <div className="small muted">{s.approvers.map((a: any) => a.name).join(', ')}</div>
            {ds.map((d: any) => <div key={d.id} className="small"><Icon name={d.approve ? 'check' : 'x'} /> {d.userName}, {fmtDateTime(d.createdAt)}{d.note ? ` – „${d.note}“` : ''}</div>)}
          </li>
        );
      })}</ol>
      {r.canDecide && <div className="card" style={{ marginTop: 10 }}>
        <Field label="Bemerkung" hint="bei Ablehnung Pflicht"><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="row" style={{ gap: 8 }}><button className="btn primary" onClick={() => void decide(true)}><Icon name="check" /> Genehmigen</button><button className="btn danger" onClick={() => void decide(false)}><Icon name="x" /> Ablehnen</button></div>
      </div>}
      {r.canWithdraw && <button className="btn ghost danger sm" style={{ marginTop: 10 }} onClick={async () => { if (await act(() => post(`/approvals/requests/${id}/withdraw`, {}), 'Zurückgezogen')) void reload(); }}>Antrag zurückziehen</button>}
    </SlideOver>
  );
}

function Types() {
  const { data, reload } = useApi<any[]>('/approvals/types?all=1');
  const [edit, setEdit] = useState<any | null>(null);
  useLive(reload);
  return (
    <div>
      <div className="toolbar"><span className="right"><button className="btn primary" onClick={() => setEdit({ name: '', description: '', icon: 'approve', fields: [{ id: 'text', label: 'Beschreibung', type: 'textarea', options: [], required: true }], steps: [{ kind: 'lead', userIds: [], minAmount: null, all: false }], amountField: null, active: true, sort: 10 })}><Icon name="plus" /> Antragsart</button></span></div>
      <div className="bk-types">{data?.map((t) => (
        <div key={t.id} className="card click" onClick={() => setEdit(t)} style={!t.active ? { opacity: 0.5 } : undefined}>
          <div className="row" style={{ gap: 8 }}><Icon name={t.icon} /><b>{t.name}</b></div><div className="small muted">{t.description}</div>
          <div className="small">{t.fields.length} Felder · {t.steps.map((s: any) => `${STEP_KIND[s.kind]}${s.minAmount ? ` ab ${fmtEuro2(s.minAmount)}` : ''}`).join(' → ')}</div>
        </div>
      ))}</div>
      {edit && <TypeModal type={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void reload(); }} />}
      <ApprovalSettings />
    </div>
  );
}

function ApprovalSettings() {
  const { me, users } = useSession();
  const s = useAdminSettings('approvals');
  const act = useAction();
  if (me?.role !== 'admin' || !s.value) return null;
  return (
    <div style={{ maxWidth: 760, marginTop: 24 }}>
      <h3>Einstellungen</h3>
      <Field label="Verwalter" hint="dürfen Antragsarten pflegen und alle Anträge sehen (zusätzlich zu Administratoren)"><UserPicker users={users} value={s.value.managerIds} onChange={(ids) => s.setValue({ ...s.value, managerIds: ids })} /></Field>
      <button className="btn primary" onClick={() => act(() => s.save(s.value), 'Gespeichert')}>Speichern</button>
    </div>
  );
}

function TypeModal({ type, onClose, onDone }: { type: any; onClose: () => void; onDone: () => void }) {
  const { users } = useSession();
  const act = useAction();
  const [f, setF] = useState(type);
  const body = { name: f.name, description: f.description, icon: f.icon, fields: f.fields, steps: f.steps, amountField: f.amountField || null, active: f.active, sort: f.sort };
  const setField = (i: number, x: any) => setF({ ...f, fields: f.fields.map((y: any, k: number) => (k === i ? x : y)) });
  const setStep = (i: number, x: any) => setF({ ...f, steps: f.steps.map((y: any, k: number) => (k === i ? x : y)) });
  const slug = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `f${Date.now() % 1000}`;
  return (
    <Modal size="lg" title={type.id ? 'Antragsart bearbeiten' : 'Neue Antragsart'} onClose={onClose} footer={<>
      {type.id && <button className="btn ghost danger" onClick={async () => { if (await act(() => del(`/approvals/types/${type.id}`))) onDone(); }}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.name.trim()} onClick={async () => { if (await act(() => (type.id ? patch(`/approvals/types/${type.id}`, body) : post('/approvals/types', body)), 'Gespeichert')) onDone(); }}>Speichern</button></>}>
      <div className="grid2">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Beschreibung"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      <h3 style={{ margin: '8px 0 4px' }}>Felder</h3>
      {f.fields.map((x: any, i: number) => (
        <div key={i} className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
          <input style={{ width: 220 }} value={x.label} placeholder="Bezeichnung" onChange={(e) => setField(i, { ...x, label: e.target.value, id: type.id && type.fields.some((o: any) => o.id === x.id) ? x.id : slug(e.target.value) })} />
          <select style={{ width: 130 }} value={x.type} onChange={(e) => setField(i, { ...x, type: e.target.value })}>{Object.entries(FIELD_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {x.type === 'select' && <input className="grow" placeholder="Auswahlwerte, durch Komma getrennt" value={x.options.join(', ')} onChange={(e) => setField(i, { ...x, options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) })} />}
          <label className="row small"><input type="checkbox" checked={x.required} onChange={(e) => setField(i, { ...x, required: e.target.checked })} /> Pflicht</label>
          <button className="btn ghost sm" onClick={() => setF({ ...f, fields: f.fields.filter((_: any, k: number) => k !== i) })}><Icon name="x" /></button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setF({ ...f, fields: [...f.fields, { id: `feld_${f.fields.length + 1}`, label: '', type: 'text', options: [], required: false }] })}><Icon name="plus" /> Feld</button>
      <Field label="Betragsfeld für Wertgrenzen"><select value={f.amountField ?? ''} onChange={(e) => setF({ ...f, amountField: e.target.value || null })}><option value="">–</option>{f.fields.filter((x: any) => x.type === 'money' || x.type === 'number').map((x: any) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></Field>
      <h3 style={{ margin: '8px 0 4px' }}>Genehmigungsstufen</h3>
      {f.steps.map((s: any, i: number) => (
        <div key={i} className="card flat" style={{ marginBottom: 6 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <b>Stufe {i + 1}</b>
            <select style={{ width: 260 }} value={s.kind} onChange={(e) => setStep(i, { ...s, kind: e.target.value })}>{Object.entries(STEP_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <label className="row small">ab <input type="number" style={{ width: 110 }} placeholder="immer" value={s.minAmount ?? ''} onChange={(e) => setStep(i, { ...s, minAmount: e.target.value === '' ? null : Number(e.target.value) })} /> €</label>
            {s.kind !== 'lead' && <label className="row small"><input type="checkbox" checked={s.all} onChange={(e) => setStep(i, { ...s, all: e.target.checked })} /> alle müssen zustimmen</label>}
            <span className="grow" />{f.steps.length > 1 && <button className="btn ghost sm" onClick={() => setF({ ...f, steps: f.steps.filter((_: any, k: number) => k !== i) })}><Icon name="x" /></button>}
          </div>
          {s.kind === 'users' && <UserPicker users={users} value={s.userIds} onChange={(ids) => setStep(i, { ...s, userIds: ids })} />}
        </div>
      ))}
      {f.steps.length < 6 && <button className="btn sm" onClick={() => setF({ ...f, steps: [...f.steps, { kind: 'admin', userIds: [], minAmount: null, all: false }] })}><Icon name="plus" /> Stufe</button>}
      <label className="row" style={{ marginTop: 10 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>
    </Modal>
  );
}
