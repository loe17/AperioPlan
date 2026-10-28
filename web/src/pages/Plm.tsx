import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi } from '../lib/hooks';
import { del, get, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, fmtDateTime } from '../lib/format';
import { Avatar, Confirm, Empty, Field, Modal, Pill, SlideOver, UserSelect, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { ProjectSelect } from '../modules/Pickers';

const STATUS: Record<string, [string, string]> = { draft: ['Entwurf', ''], review: ['in Prüfung', 'blue'], approved: ['freigegeben', 'green'], rejected: ['abgelehnt', 'red'], implemented: ['umgesetzt', 'green'], cancelled: ['zurückgezogen', ''] };
const KIND: Record<string, string> = { change: 'Änderung', deviation: 'Abweichungsgenehmigung', new: 'Neuteil' };
const ACTION: Record<string, string> = { change: 'ändern', new: 'neu', obsolete: 'auslaufen lassen' };
const STOCK: Record<string, string> = { use: 'Bestand aufbrauchen', rework: 'Bestand nacharbeiten', scrap: 'Bestand verschrotten', none: 'kein Bestand betroffen' };
const PRIO: Record<string, string> = { low: 'niedrig', normal: 'normal', high: 'hoch', urgent: 'dringend' };
const TYPE_ICON: Record<string, string> = { cad: 'part', pcb: 'bolt', article: 'box', other: 'file' };

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'plm.changed') void reload(); }), [reload]);
}

export default function PlmPage() {
  useCrumbs([{ label: 'Änderungsmanagement' }]);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('open');
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const [create, setCreate] = useState(false);
  const { data, reload } = useApi<any[]>(`/plm/changes?${new URLSearchParams({ ...(status ? { status } : {}), ...(mine ? { mine: '1' } : {}), ...(q ? { q } : {}) })}`);
  const { me } = useSession();
  useLive(reload);
  const open = params.get('change');
  const setOpen = (id: string | null) => { if (id) params.set('change', id); else params.delete('change'); setParams(params, { replace: true }); };
  const waiting = (data ?? []).filter((c) => c.status === 'review' && c.approvers.some((a: any) => a.userId === me?.id && !a.decision));
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Änderungsmanagement</h1><div className="sub">Änderungen an Teilen, Baugruppen und Leiterplatten beantragen, prüfen und freigeben</div></div>
        <div className="actions"><button className="btn primary" onClick={() => setCreate(true)}><Icon name="plus" /> Änderungsantrag</button></div></div>
      {waiting.length > 0 && <div className="locked-banner"><Icon name="info" /><span className="grow">{waiting.length} Antrag/Anträge warten auf deine Entscheidung.</span>
        <button className="btn sm" onClick={() => setOpen(waiting[0].id)}>Öffnen</button></div>}
      <div className="toolbar">
        <input placeholder="Nummer, Titel oder Teil …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="open">offen</option><option value="">alle</option>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> mich betreffend</label>
      </div>
      {data && !data.length && <Empty icon="repeat" title="Keine Änderungsanträge">Ein Antrag beschreibt, was sich warum ändern soll und welche Teile betroffen sind. Die eingetragenen Prüfer geben ihn frei.</Empty>}
      {data && data.length > 0 && <table className="table"><thead><tr><th>Nr.</th><th>Änderung</th><th>Teile</th><th>Antragsteller</th><th>Prüfung</th><th>Datum</th><th>Status</th></tr></thead>
        <tbody>{data.map((c) => {
          const ok = c.approvers.filter((a: any) => a.decision === 'approve').length;
          return (
            <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
              <td className="mono small">{c.number}</td>
              <td><b>{c.title}</b><div className="small muted">{KIND[c.kind]}{c.priority !== 'normal' ? ` · ${PRIO[c.priority]}` : ''}{c.projectNumber ? ` · ${c.projectNumber}` : ''}</div></td>
              <td className="small">{c.items.slice(0, 2).map((i: any) => i.number).join(', ')}{c.items.length > 2 ? ` +${c.items.length - 2}` : ''}</td>
              <td>{c.requestedByName}</td><td>{c.approvers.length ? `${ok} / ${c.approvers.length}` : '–'}</td><td>{fmtDate(c.createdAt)}</td>
              <td><Pill tone={STATUS[c.status]![1]}>{STATUS[c.status]![0]}</Pill></td>
            </tr>
          );
        })}</tbody></table>}
      {create && <ChangeModal onClose={() => setCreate(false)} onSaved={(id) => { setCreate(false); void reload(); if (id) setOpen(id); }} />}
      {open && <ChangePanel id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ItemSearch({ onAdd }: { onAdd: (i: any) => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const t = setTimeout(() => { void get<any[]>(`/plm/items?q=${encodeURIComponent(q)}`).then(setRes).catch(() => setRes([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div>
      <div className="row" style={{ gap: 6 }}>
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Teil, Baugruppe, Leiterplatte oder Artikel suchen …" />
        <button className="btn sm" onClick={() => { if (q.trim()) { onAdd({ type: 'other', id: null, number: '', designation: q.trim(), revision: null }); setQ(''); } }}>als freien Text</button>
      </div>
      {res.length > 0 && <div className="mfg-pick">{res.map((r) => <button key={r.id} className="row" onClick={() => { onAdd(r); setQ(''); setRes([]); }}><Icon name={TYPE_ICON[r.type] ?? 'file'} /> <span className="mono">{r.number}</span> {r.designation}{r.revision !== null ? <span className="muted"> · Stand {r.revision}</span> : ''}</button>)}</div>}
    </div>
  );
}

function ChangeModal({ change, onClose, onSaved }: { change?: any; onClose: () => void; onSaved: (id?: string) => void }) {
  const { users } = useSession();
  const act = useAction();
  const [f, setF] = useState<any>(() => change ? { ...change, approverIds: change.approvers.map((a: any) => a.userId), effectiveDate: change.effectiveDate ?? '' }
    : { title: '', reason: '', description: '', kind: 'change', priority: 'normal', projectId: null, items: [], impact: { stock: 'use', cost: null, production: '', customer: '', notes: '' }, approverIds: [], effectiveDate: '', ownerId: null });
  const imp = f.impact;
  return (
    <Modal size="lg" title={change ? `Antrag ${change.number} bearbeiten` : 'Neuer Änderungsantrag'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={async () => {
        const b = { title: f.title, reason: f.reason, description: f.description, kind: f.kind, priority: f.priority, projectId: f.projectId, items: f.items.map((i: any) => ({ type: i.type, id: i.id, number: i.number, designation: i.designation, revision: i.revision ?? null, action: i.action ?? 'change', note: i.note ?? '' })),
          impact: { ...imp, cost: imp.cost === '' || imp.cost === null ? null : Number(imp.cost) }, approverIds: f.approverIds, effectiveDate: f.effectiveDate || null, ownerId: f.ownerId };
        const r = await act(() => (change ? patch(`/plm/changes/${change.id}`, b) : post<{ id: string }>('/plm/changes', b)), 'Gespeichert');
        if (r) onSaved(change ? undefined : (r as any).id);
      }}>Speichern</button></>}>
      <Field label="Was soll sich ändern?"><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Bohrung Grundplatte um 5 mm versetzen" /></Field>
      <div className="grid3">
        <Field label="Art"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Priorität"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(PRIO).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Gültig ab"><input type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></Field>
      </div>
      <Field label="Grund"><textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Warum? Fehler, Kundenwunsch, Kosten, Lieferant …" /></Field>
      <Field label="Beschreibung der Änderung"><textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <h3 style={{ margin: '8px 0 4px' }}>Betroffene Teile</h3>
      {f.items.map((i: any, k: number) => (
        <div key={k} className="row" style={{ gap: 6, padding: '3px 0' }}>
          <Icon name={TYPE_ICON[i.type] ?? 'file'} /><span className="mono">{i.number}</span><span className="grow">{i.designation}</span>
          <select style={{ width: 160 }} value={i.action ?? 'change'} onChange={(e) => setF({ ...f, items: f.items.map((x: any, j: number) => (j === k ? { ...x, action: e.target.value } : x)) })}>{Object.entries(ACTION).map(([a, l]) => <option key={a} value={a}>{l}</option>)}</select>
          <button className="btn ghost sm" onClick={() => setF({ ...f, items: f.items.filter((_: any, j: number) => j !== k) })}><Icon name="x" /></button>
        </div>
      ))}
      <ItemSearch onAdd={(i) => setF({ ...f, items: [...f.items, { ...i, action: 'change' }] })} />
      <h3 style={{ margin: '12px 0 4px' }}>Auswirkungen</h3>
      <div className="grid2">
        <Field label="Vorhandener Bestand"><select value={imp.stock} onChange={(e) => setF({ ...f, impact: { ...imp, stock: e.target.value } })}>{Object.entries(STOCK).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Geschätzte Kosten (€)"><input type="number" value={imp.cost ?? ''} onChange={(e) => setF({ ...f, impact: { ...imp, cost: e.target.value } })} /></Field>
        <Field label="Fertigung / Montage"><input value={imp.production} onChange={(e) => setF({ ...f, impact: { ...imp, production: e.target.value } })} /></Field>
        <Field label="Kunde / Dokumentation"><input value={imp.customer} onChange={(e) => setF({ ...f, impact: { ...imp, customer: e.target.value } })} /></Field>
      </div>
      <div className="grid2">
        <Field label="Projekt"><ProjectSelect value={f.projectId} onChange={(v) => setF({ ...f, projectId: v })} /></Field>
        <Field label="Verantwortlich für die Umsetzung"><UserSelect users={users} value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} placeholder="– ich –" /></Field>
      </div>
      <Field label="Prüfer" hint="alle müssen freigeben"><UserPicker users={users} value={f.approverIds} onChange={(ids) => setF({ ...f, approverIds: ids })} /></Field>
    </Modal>
  );
}

function ChangePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: c, reload } = useApi<any>(`/plm/changes/${id}`, [id]);
  const { me, users } = useSession();
  const act = useAction();
  const [edit, setEdit] = useState(false);
  const [comment, setComment] = useState('');
  const [remove, setRemove] = useState(false);
  useLive(reload);
  if (!c) return null;
  const myTurn = c.status === 'review' && c.approvers.some((a: any) => a.userId === me?.id && !a.decision);
  const name = (uid: string) => users.find((u) => u.id === uid)?.displayName ?? '–';
  const owner = me?.role === 'admin' || me?.id === c.ownerId || me?.id === c.requestedBy;
  return (
    <SlideOver wide title={<span>{c.title} <span className="mono muted">{c.number}</span></span>} onClose={onClose}
      actions={<a className="btn sm" href={`/api/plm/changes/${id}/pdf`} target="_blank" rel="noreferrer"><Icon name="printer" /> PDF</a>}>
      <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
        <Pill tone={STATUS[c.status]![1]}>{STATUS[c.status]![0]}</Pill><span className="small">{KIND[c.kind]} · Priorität {PRIO[c.priority]}</span>
        <span className="small muted">von {c.requestedByName} am {fmtDate(c.createdAt)}{c.effectiveDate ? ` · gültig ab ${fmtDate(c.effectiveDate)}` : ''}</span>
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        {['draft', 'rejected'].includes(c.status) && <><button className="btn" onClick={() => setEdit(true)}><Icon name="edit" /> Bearbeiten</button>
          <button className="btn primary" onClick={async () => { if (await act(() => post(`/plm/changes/${id}/submit`, {}), 'Zur Prüfung gegeben')) void reload(); }}><Icon name="send" /> Zur Prüfung</button></>}
        {c.status === 'approved' && owner && <button className="btn primary" onClick={async () => { if (await act(() => post(`/plm/changes/${id}/status`, { status: 'implemented' }), 'Umgesetzt')) void reload(); }}><Icon name="check" /> Als umgesetzt melden</button>}
        {['review', 'rejected'].includes(c.status) && owner && <button className="btn ghost" onClick={async () => { if (await act(() => post(`/plm/changes/${id}/status`, { status: 'draft' }))) void reload(); }}>Zurück in den Entwurf</button>}
        {['draft', 'review', 'rejected', 'approved'].includes(c.status) && owner && <button className="btn ghost" onClick={async () => { if (await act(() => post(`/plm/changes/${id}/status`, { status: 'cancelled' }), 'Zurückgezogen')) void reload(); }}>Zurückziehen</button>}
        {c.status === 'draft' && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
      </div>
      {myTurn && <div className="card" style={{ borderColor: 'var(--accent)', marginBottom: 12 }}>
        <b>Deine Entscheidung</b>
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Bemerkung (bei Ablehnung Pflicht)" style={{ margin: '6px 0' }} />
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary" onClick={async () => { if (await act(() => post(`/plm/changes/${id}/decide`, { decision: 'approve', comment }), 'Freigegeben')) { setComment(''); void reload(); } }}><Icon name="check" /> Freigeben</button>
          <button className="btn danger" disabled={!comment.trim()} onClick={async () => { if (await act(() => post(`/plm/changes/${id}/decide`, { decision: 'reject', comment }), 'Abgelehnt')) { setComment(''); void reload(); } }}>Ablehnen</button>
        </div>
      </div>}
      {c.reason && <><h3 style={{ margin: '4px 0' }}>Grund</h3><p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{c.reason}</p></>}
      {c.description && <><h3 style={{ margin: '4px 0' }}>Änderung</h3><p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{c.description}</p></>}
      <h3 style={{ margin: '8px 0 4px' }}>Betroffene Teile</h3>
      {!c.items.length ? <p className="muted small">keine</p> : <table className="table small"><tbody>{c.items.map((i: any, k: number) => (
        <tr key={k}><td style={{ width: 24 }}><Icon name={TYPE_ICON[i.type] ?? 'file'} /></td><td className="mono">{i.number}</td><td>{i.designation}</td><td>{i.revision !== null ? `Stand ${i.revision}` : ''}</td><td>{ACTION[i.action]}</td>
          <td>{i.type === 'cad' && i.id && <a href="/cad" className="small">in CAD-Bridge</a>}{i.type === 'pcb' && i.id && <a href="/pcb" className="small">in PCB-Bridge</a>}</td></tr>
      ))}</tbody></table>}
      <h3 style={{ margin: '8px 0 4px' }}>Auswirkungen</h3>
      <div className="small">{STOCK[c.impact.stock]}{c.impact.cost !== null ? ` · Kosten etwa ${Number(c.impact.cost).toLocaleString('de-DE')} €` : ''}{c.impact.production ? ` · Fertigung: ${c.impact.production}` : ''}{c.impact.customer ? ` · Kunde: ${c.impact.customer}` : ''}</div>
      <h3 style={{ margin: '12px 0 4px' }}>Prüfer</h3>
      {c.approvers.map((a: any) => (
        <div key={a.userId} className="row" style={{ gap: 8, padding: '3px 0' }}><Avatar id={a.userId} name={name(a.userId)} /><span className="grow">{name(a.userId)}</span>
          {a.decision === 'approve' ? <Pill tone="green">freigegeben {fmtDate(a.at)}</Pill> : a.decision === 'reject' ? <Pill tone="red">abgelehnt {fmtDate(a.at)}</Pill> : <Pill>offen</Pill>}</div>
      ))}
      <h3 style={{ margin: '14px 0 4px' }}>Verlauf</h3>
      {c.comments.map((m: any) => (
        <div key={m.id} className="plm-comment"><div className="small muted">{m.userName} · {fmtDateTime(m.createdAt)}{m.decision ? ` · ${m.decision === 'approve' ? 'Freigabe' : 'Ablehnung'}` : ''}</div><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></div>
      ))}
      <form className="row" style={{ gap: 6, marginTop: 6 }} onSubmit={async (e) => { e.preventDefault(); if (comment.trim() && !myTurn && await act(() => post(`/plm/changes/${id}/comments`, { body: comment }))) { setComment(''); void reload(); } }}>
        {!myTurn && <><input className="grow" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Kommentar …" /><button className="btn" type="submit">Senden</button></>}
      </form>
      {edit && <ChangeModal change={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); void reload(); }} />}
      {remove && <Confirm danger text="Entwurf löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/plm/changes/${id}`))) onClose(); }} />}
    </SlideOver>
  );
}
