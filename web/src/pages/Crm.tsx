import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { patch, post, upload, invalidate } from '../lib/api';
import { useApi, useTabState } from '../lib/hooks';
import { useCrumbs } from '../components/Layout';
import { useSession } from '../session';
import { fmtDate, fmtDateTime, fmtEuro } from '../lib/format';
import { Empty, Field, Modal, Pill, Tabs, useAction } from '../components/ui';
import { Icon } from '../components/Icon';
import { ACCOUNT_STATUS, AccountModal, CASE_STATUS, CASE_TYPE, QUOTE_STATUS, STAGES, type CrmAccount } from '../modules/CrmShared';
import { CaseModal, OpportunityModal, QuoteEditor } from '../modules/CrmModals';

type Tab = 'overview' | 'customers' | 'suppliers' | 'opportunities' | 'quotes' | 'cases' | 'duplicates';

/** CRM – Kunden, Lieferanten, Verkaufschancen, Angebote, Reklamationen */
export default function CrmPage() {
  useCrumbs([{ label: 'Kunden (CRM)' }]);
  const { me } = useSession();
  const [tab, setTab] = useTabState<Tab>('crm', 'overview');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Übersicht' }, { id: 'customers', label: 'Kunden' }, { id: 'opportunities', label: 'Verkaufschancen' },
    { id: 'quotes', label: 'Angebote' }, { id: 'cases', label: 'Reklamationen' }, { id: 'suppliers', label: 'Lieferanten' },
    ...(me?.role === 'admin' ? [{ id: 'duplicates' as Tab, label: 'Doppelte zusammenführen' }] : []),
  ];
  return (
    <div className={`page ${tab === 'opportunities' ? 'wide' : ''}`}>
      <div className="page-head"><div><h1>Kunden (CRM)</h1><div className="sub">Alles über Kunden und Lieferanten an einer Stelle</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'overview' && <Dashboard onTab={setTab} />}
      {tab === 'customers' && <Accounts kind="customer" />}
      {tab === 'suppliers' && <Accounts kind="supplier" />}
      {tab === 'opportunities' && <OpportunityBoard />}
      {tab === 'quotes' && <Quotes />}
      {tab === 'cases' && <Cases />}
      {tab === 'duplicates' && <Duplicates />}
    </div>
  );
}

function Dashboard({ onTab }: { onTab: (t: Tab) => void }) {
  const { data: d } = useApi<any>('/crm/dashboard');
  if (!d) return null;
  const stage = (id: string) => d.byStage.find((s: any) => s.stage === id) ?? { count: 0, value: 0 };
  return (
    <div>
      <div className="kpi-row">
        <div className="kpi click" onClick={() => onTab('customers')}><div className="v">{d.customers}</div><div className="l">Kunden · {d.prospects} Interessenten</div></div>
        <div className="kpi click" onClick={() => onTab('opportunities')}><div className="v">{fmtEuro(d.pipeline)}</div><div className="l">{d.openOpportunities} offene Verkaufschancen</div></div>
        <div className="kpi"><div className="v">{fmtEuro(d.weighted)}</div><div className="l">gewichtet nach Wahrscheinlichkeit</div></div>
        <div className="kpi"><div className="v">{fmtEuro(d.wonThisYear)}</div><div className="l">gewonnen in diesem Jahr</div></div>
        <div className="kpi click" onClick={() => onTab('quotes')}><div className="v">{d.openQuotes}</div><div className="l">versendete Angebote ohne Antwort</div></div>
        <div className="kpi click" onClick={() => onTab('cases')}><div className="v">{d.openCases}</div><div className="l">offene Reklamationen</div></div>
      </div>
      <div className="grid2">
        <div className="card">
          <h3>Verkaufschancen nach Phase</h3>
          {STAGES.map((s) => { const x = stage(s.id); const max = Math.max(1, ...d.byStage.map((b: any) => b.value)); return (
            <div key={s.id} style={{ margin: '6px 0' }}>
              <div className="row small"><span className="grow">{s.label} ({x.count})</span><b>{fmtEuro(x.value)}</b></div>
              <div className="progress"><div style={{ width: `${(x.value / max) * 100}%`, background: `var(--${s.tone || 'accent'})` }} /></div>
            </div>
          ); })}
        </div>
        <div className="card">
          <h3>Nächste Termine mit Kunden</h3>
          {!d.upcoming.length && <div className="muted small">Keine Termine in den nächsten 14 Tagen</div>}
          {d.upcoming.map((e: any) => <div key={e.id} className="row small" style={{ padding: '4px 0' }}><Icon name="calendar" /><span className="grow"><Link to={`/calendar?event=${e.id}`}>{e.title}</Link> · <Link to={`/crm/${e.accountId}`}>{e.accountName}</Link></span><span className="muted">{fmtDateTime(e.startsAt)}</span></div>)}
        </div>
        <div className="card">
          <h3>Bald fällige Abschlüsse</h3>
          {!d.closing.length && <div className="muted small">Keine</div>}
          {d.closing.map((o: any) => <div key={o.id} className="row small" style={{ padding: '4px 0' }}><span className="grow"><Link to={`/crm/${o.accountId}?tab=opportunities`}>{o.title}</Link> · {o.accountName}</span><span>{fmtEuro(o.value)}</span><span className="muted">{fmtDate(o.expectedClose)}</span></div>)}
        </div>
        <div className="card">
          <h3>Seit 90 Tagen ohne Kontakt</h3>
          {!d.quiet.length && <div className="muted small">Alle Kunden wurden kürzlich kontaktiert</div>}
          {d.quiet.map((a: any) => <div key={a.id} className="row small" style={{ padding: '4px 0' }}><span className="grow"><Link to={`/crm/${a.id}`}>{a.name}</Link> <span className="muted">{a.number}</span></span><span className="muted">{a.lastContactAt ? fmtDate(a.lastContactAt) : 'noch nie'}{a.ownerName ? ` · ${a.ownerName}` : ''}</span></div>)}
        </div>
      </div>
    </div>
  );
}

function Accounts({ kind }: { kind: 'customer' | 'supplier' }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const { data, reload } = useApi<CrmAccount[]>(`/crm/accounts?kind=${kind}${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}`);
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Suchen nach Name, Nummer, Ort, Ansprechpartner …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 320 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">Alle</option>{Object.entries(ACCOUNT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <span className="grow" />
        <button className="btn" onClick={() => setImporting(true)}><Icon name="upload" /> Importieren</button>
        <a className="btn" href={`/api/crm/export.xlsx?kind=${kind}`}><Icon name="file-excel" /> Als Excel</a>
        <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" /> {kind === 'supplier' ? 'Lieferant' : 'Kunde'}</button>
      </div>
      {!data?.length ? <Empty icon="building" title={q ? 'Kein Treffer' : `Noch keine ${kind === 'supplier' ? 'Lieferanten' : 'Kunden'}`}>Legen Sie den ersten an oder importieren Sie eine Liste aus Excel oder Outlook.</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Nr.</th><th>Name</th><th>Ort</th><th>Ansprechpartner</th><th>Status</th><th>Zuständig</th><th>Letzter Kontakt</th>{kind === 'customer' && <th>Projekte</th>}</tr></thead>
          <tbody>{data.map((a) => (
            <tr key={a.id} className="click" onClick={() => nav(`/crm/${a.id}`)}>
              <td className="mono small">{a.number}</td><td><b>{a.name}</b>{a.industry && <div className="small muted">{a.industry}</div>}</td>
              <td>{[a.zip, a.city].filter(Boolean).join(' ')}</td>
              <td className="small">{a.primaryContact ? <>{a.primaryContact.name}<div className="muted">{a.primaryContact.phone || a.primaryContact.email}</div></> : <span className="muted">–</span>}</td>
              <td><Pill tone={ACCOUNT_STATUS[a.status]?.tone}>{ACCOUNT_STATUS[a.status]?.label}</Pill></td>
              <td className="small">{a.ownerName ?? '–'}</td><td className="small">{a.lastContactAt ? fmtDate(a.lastContactAt) : <span className="muted">–</span>}</td>
              {kind === 'customer' && <td>{a.projectCount || ''}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {creating && <AccountModal initial={{ kind }} onClose={() => setCreating(false)} onSaved={(a) => { setCreating(false); nav(`/crm/${a.id}`); }} />}
      {importing && <ImportModal kind={kind} onClose={() => setImporting(false)} onDone={() => { setImporting(false); void reload(); }} />}
    </div>
  );
}

function ImportModal({ kind, onClose, onDone }: { kind: 'customer' | 'supplier'; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [prev, setPrev] = useState<{ header: string[]; rows: string[][]; mapping: Record<string, string>; fields: Record<string, string> } | null>(null);
  const [dup, setDup] = useState('skip');
  const [result, setResult] = useState<any>(null);
  const pick = async (f: File) => {
    const fd = new FormData(); fd.append('file', f, f.name);
    const r = await act(() => upload('/crm/import/preview', fd));
    if (r) setPrev(r);
  };
  return (
    <Modal size="lg" title="Kunden importieren" onClose={onClose} footer={result ? <button className="btn primary" onClick={onDone}>Fertig</button> : <>
      <button className="btn" onClick={onClose}>Abbrechen</button>
      {prev && <button className="btn primary" disabled={!Object.values(prev.mapping).includes('name')} onClick={async () => {
        const r = await act(() => post('/crm/import', { rows: prev.rows, mapping: prev.mapping, kind, onDuplicate: dup }));
        if (r) setResult(r);
      }}>{prev.rows.length} Zeilen importieren</button>}
    </>}>
      {result ? <div className="card">{result.created} neu angelegt, {result.updated} aktualisiert, {result.contacts} Ansprechpartner übernommen, {result.skipped} übersprungen.</div>
        : !prev ? <>
          <p className="muted">Excel (.xlsx), CSV oder Outlook-Kontakte (.vcf oder als CSV exportiert). Die erste Zeile enthält die Spaltennamen.</p>
          <input type="file" accept=".xlsx,.csv,.txt,.vcf" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
        </> : <>
          <p className="muted">Bitte prüfen, welche Spalte wohin gehört. Mehrere Zeilen mit derselben Firma ergeben einen Kunden mit mehreren Ansprechpartnern.</p>
          <div className="table-wrap" style={{ maxHeight: 320 }}><table className="table">
            <thead><tr>{prev.header.map((h, i) => (
              <th key={i}><div className="small">{h}</div>
                <select value={prev.mapping[i] ?? ''} onChange={(e) => setPrev({ ...prev, mapping: { ...prev.mapping, [i]: e.target.value } })}>
                  <option value="">nicht übernehmen</option>{Object.entries(prev.fields).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></th>))}</tr></thead>
            <tbody>{prev.rows.slice(0, 8).map((r, i) => <tr key={i}>{prev.header.map((_, j) => <td key={j} className="small">{r[j]}</td>)}</tr>)}</tbody>
          </table></div>
          <Field label="Wenn eine Firma schon existiert"><select value={dup} onChange={(e) => setDup(e.target.value)}>
            <option value="skip">überspringen (nur neue Ansprechpartner ergänzen)</option><option value="update">leere Felder ergänzen</option><option value="create">trotzdem neu anlegen</option>
          </select></Field>
        </>}
    </Modal>
  );
}

function OpportunityBoard() {
  const act = useAction();
  const { data, reload } = useApi<any[]>('/crm/opportunities');
  const [edit, setEdit] = useState<any | null | 'new'>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const drop = async (stage: string) => {
    const o = data?.find((x) => x.id === drag);
    setDrag(null);
    if (!o || o.stage === stage) return;
    await act(() => patch(`/crm/opportunities/${o.id}`, { stage }), stage === 'won' ? 'Gewonnen!' : undefined);
    void reload();
  };
  return (
    <div>
      <div className="toolbar"><span className="grow muted small">Karten in die nächste Phase ziehen. Gewonnen → Projekt mit einem Klick anlegen.</span><button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> Verkaufschance</button></div>
      <div className="crm-board">
        {STAGES.map((s) => { const items = (data ?? []).filter((o) => o.stage === s.id); return (
          <div key={s.id} className={`kanban-col ${drag ? 'drop' : ''}`} onDragOver={(e) => drag && e.preventDefault()} onDrop={(e) => { e.preventDefault(); void drop(s.id); }}>
            <div className="kanban-col-head"><Pill tone={s.tone}>{s.label}</Pill> <span className="muted">{items.length} · {fmtEuro(items.reduce((a, o) => a + (o.value ?? 0), 0))}</span></div>
            <div className="kanban-cards">{items.map((o) => (
              <div key={o.id} className="kcard" draggable onDragStart={() => setDrag(o.id)} onDragEnd={() => setDrag(null)} onClick={() => setEdit(o)}>
                <div className="title">{o.title}</div>
                <div className="meta"><span><Icon name="building" /> {o.accountName}</span>{o.value != null && <b>{fmtEuro(o.value)}</b>}<span className="muted">{o.probability} %</span>
                  {o.expectedClose && <span className="muted"><Icon name="calendar" /> {fmtDate(o.expectedClose)}</span>}{o.ownerName && <span className="muted">{o.ownerName}</span>}</div>
                {o.stage === 'won' && (o.projectId ? <Link className="small" to={`/projects/${o.projectId}`} onClick={(e) => e.stopPropagation()}><Icon name="projects" /> Projekt {o.projectNumber}</Link>
                  : <WonToProject opp={o} onDone={reload} />)}
              </div>
            ))}</div>
          </div>
        ); })}
      </div>
      {edit && <OpportunityModal opp={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

/** Gewonnene Verkaufschance → neues Projekt mit Kunde */
export function WonToProject({ opp, onDone }: { opp: any; onDone: () => void }) {
  const act = useAction();
  const nav = useNavigate();
  return (
    <button className="btn sm primary" style={{ marginTop: 6 }} onClick={async (e) => {
      e.stopPropagation();
      const p = await act(() => post<{ id: string; number: string }>('/projects', { name: opp.title, customerId: opp.accountId, customerContactId: opp.contactId ?? null, description: opp.description ?? '' }), 'Projekt angelegt');
      if (!p) return;
      await act(() => post(`/crm/opportunities/${opp.id}/project`, { projectId: p.id }));
      invalidate('/projects'); onDone(); nav(`/projects/${p.id}`);
    }}><Icon name="plus" /> Projekt anlegen</button>
  );
}

function Quotes() {
  const { data, reload } = useApi<any[]>('/crm/quotes');
  const [edit, setEdit] = useState<any | null | 'new'>(null);
  return (
    <div>
      <div className="toolbar"><span className="grow" /><button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> Angebot</button></div>
      {!data?.length ? <Empty icon="file-text" title="Noch keine Angebote" /> : <QuoteTable rows={data} onOpen={setEdit} />}
      {edit && <QuoteEditor quote={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

export function QuoteTable({ rows, onOpen, hideAccount }: { rows: any[]; onOpen: (q: any) => void; hideAccount?: boolean }) {
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Nummer</th><th>Betreff</th>{!hideAccount && <th>Kunde</th>}<th>Datum</th><th>Gültig bis</th><th style={{ textAlign: 'right' }}>Netto</th><th>Status</th><th /></tr></thead>
      <tbody>{rows.map((q) => (
        <tr key={q.id} className="click" onClick={() => onOpen(q)}>
          <td className="mono small">{q.number}</td><td>{q.title}</td>{!hideAccount && <td>{q.accountName}</td>}<td>{fmtDate(q.quoteDate)}</td>
          <td className={q.validUntil && q.validUntil < new Date().toISOString().slice(0, 10) && q.status === 'sent' ? 'error-text' : ''}>{fmtDate(q.validUntil)}</td>
          <td style={{ textAlign: 'right' }}>{fmtEuro(q.totalNet)}</td><td><Pill tone={QUOTE_STATUS[q.status]?.tone}>{QUOTE_STATUS[q.status]?.label}</Pill></td>
          <td onClick={(e) => e.stopPropagation()}><a className="btn ghost sm" href={`/api/crm/quotes/${q.id}/pdf`} target="_blank" rel="noreferrer" title="PDF"><Icon name="file-pdf" /></a></td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function Cases() {
  const [open, setOpen] = useState(true);
  const { data, reload } = useApi<any[]>(`/crm/cases${open ? '?open=1' : ''}`);
  const [edit, setEdit] = useState<any | null | 'new'>(null);
  return (
    <div>
      <div className="toolbar"><label className="row"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> nur offene</label><span className="grow" /><button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> Reklamation</button></div>
      {!data?.length ? <Empty icon="alert" title="Keine Reklamationen" /> : <CaseTable rows={data} onOpen={setEdit} />}
      {edit && <CaseModal item={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

export function CaseTable({ rows, onOpen, hideAccount }: { rows: any[]; onOpen: (c: any) => void; hideAccount?: boolean }) {
  const PRIO: Record<string, string> = { low: '', normal: '', high: 'amber', urgent: 'red' };
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Nummer</th><th>Titel</th>{!hideAccount && <th>Kunde</th>}<th>Art</th><th>Priorität</th><th>Zuständig</th><th>Status</th><th>Bearbeitungszeit</th></tr></thead>
      <tbody>{rows.map((c) => (
        <tr key={c.id} className="click" onClick={() => onOpen(c)}>
          <td className="mono small">{c.number}</td><td>{c.title}</td>{!hideAccount && <td>{c.accountName}</td>}<td>{CASE_TYPE[c.type]}</td>
          <td>{PRIO[c.priority] ? <Pill tone={PRIO[c.priority]}>{c.priority === 'urgent' ? 'dringend' : 'hoch'}</Pill> : c.priority === 'low' ? 'niedrig' : 'normal'}</td>
          <td className="small">{c.assigneeName ?? '–'}</td><td><Pill tone={CASE_STATUS[c.status]?.tone}>{CASE_STATUS[c.status]?.label}</Pill></td>
          <td className="small">{c.hoursOpen < 48 ? `${Math.round(c.hoursOpen)} Std.` : `${Math.round(c.hoursOpen / 24)} Tage`}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function Duplicates() {
  const act = useAction();
  const { data, reload } = useApi<any[][]>('/crm/duplicates');
  const [into, setInto] = useState<Record<number, string>>({});
  if (!data?.length) return <Empty icon="check" title="Keine doppelten Kunden gefunden">Gleiche Namen mit unterschiedlicher Schreibweise (z. B. „Muster GmbH“ und „Muster AG“) erscheinen hier.</Empty>;
  return (
    <div>
      <p className="muted">Wählen Sie, welcher Eintrag bleibt. Ansprechpartner, Notizen, Projekte und Angebote der anderen werden übernommen.</p>
      {data.map((g, i) => (
        <div key={i} className="card" style={{ marginBottom: 10 }}>
          {g.map((a) => <label key={a.id} className="row" style={{ padding: 3 }}><input type="radio" name={`d${i}`} checked={(into[i] ?? g[0].id) === a.id} onChange={() => setInto({ ...into, [i]: a.id })} />
            <span className="mono small">{a.number}</span> <b>{a.name}</b> <span className="muted small">{a.city} · {a.projects} Projekte</span></label>)}
          <button className="btn sm primary" style={{ marginTop: 6 }} onClick={async () => {
            const keep = into[i] ?? g[0].id;
            for (const a of g) if (a.id !== keep) await act(() => post(`/crm/accounts/${a.id}/merge`, { intoId: keep }));
            void reload();
          }}>Zusammenführen</button>
        </div>
      ))}
    </div>
  );
}
