import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CALC_TEMPLATES, computeCalc, type CalcRates, type CalcResult, type CalcTemplate, type PlantItemKind } from '@aperio/shared';
import { del, get, patch, post, put } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../session';
import { fmtDate, fmtEuro } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { CustomerPicker } from './CrmShared';

const STATUS: Record<string, { label: string; tone: string }> = { draft: { label: 'Entwurf', tone: '' }, checked: { label: 'Geprüft', tone: 'blue' }, released: { label: 'Freigegeben', tone: 'green' } };
const tplName = (t: string) => CALC_TEMPLATES.find((x) => x.id === t)?.name ?? t;

/** Kalkulationen eines Projekts (oder alle, ohne projectId) */
export function CalculationList({ projectId, canEdit = true }: { projectId?: string; canEdit?: boolean }) {
  const { data, reload } = useApi<any[]>(`/calculations${projectId ? `?projectId=${projectId}` : ''}`);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(location.search).get('calc'));
  if (open) return <CalcEditor id={open} onBack={() => { setOpen(null); void reload(); }} />;
  return (
    <div>
      <div className="toolbar"><span className="grow muted small">Sätze werden beim Anlegen festgeschrieben – spätere Änderungen durch den Administrator verfälschen alte Kalkulationen nicht.</span>
        {canEdit && <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" /> Kalkulation</button>}</div>
      {!data?.length ? <Empty icon="euro" title="Noch keine Kalkulationen">Wählen Sie eine Vorlage: Angebotskalkulation, Zuschlagskalkulation, Stundensatz, Nachkalkulation oder Reisekosten.</Empty> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Nummer</th><th>Titel</th><th>Vorlage</th>{!projectId && <th>Projekt</th>}<th style={{ textAlign: 'right' }}>Ergebnis</th><th>Status</th><th>Angebot</th><th>Geändert</th></tr></thead>
          <tbody>{data.map((c) => (
            <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
              <td className="mono small">{c.number}</td><td>{c.title}</td><td className="small">{tplName(c.template)}</td>
              {!projectId && <td className="small">{c.projectNumber ? <Link to={`/projects/${c.projectId}?tab=calculation`} onClick={(e) => e.stopPropagation()}>{c.projectNumber}</Link> : '–'}</td>}
              <td style={{ textAlign: 'right' }}>{fmtEuro(c.result?.total)}{c.template === 'hourly' && ' / Std.'}</td>
              <td><Pill tone={STATUS[c.status]?.tone}>{STATUS[c.status]?.label}</Pill></td><td className="small">{c.quoteNumber ?? ''}</td><td className="small">{fmtDate(c.updatedAt)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {creating && <NewCalcModal projectId={projectId} existing={data ?? []} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
    </div>
  );
}

function NewCalcModal({ projectId, existing, onClose, onCreated }: { projectId?: string; existing: any[]; onClose: () => void; onCreated: (id: string) => void }) {
  const act = useAction();
  const [t, setT] = useState<CalcTemplate>('plant');
  const [title, setTitle] = useState('');
  const [base, setBase] = useState('');
  const [copy, setCopy] = useState('');
  const bases = existing.filter((c) => c.template !== 'postcalc' && c.template !== 'hourly');
  return (
    <Modal size="lg" title="Neue Kalkulation" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!title.trim() || (t === 'postcalc' && !base)} onClick={async () => {
        const r = await act(() => post<{ id: string }>('/calculations', { projectId: projectId ?? null, title, template: t, baseCalculationId: base || null, copyFromId: copy || null }));
        if (r) onCreated(r.id);
      }}>Anlegen</button></>}>
      <div className="card-grid" style={{ marginBottom: 12 }}>
        {CALC_TEMPLATES.filter((x) => projectId || x.id !== 'postcalc').map((x) => (
          <div key={x.id} className={`card click ${t === x.id ? 'selected' : ''}`} style={t === x.id ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 2px var(--accent-soft)' } : undefined} onClick={() => { setT(x.id); setCopy(''); }}>
            <h3>{x.name}</h3><div className="small muted">{x.description}</div>
          </div>
        ))}
      </div>
      <Field label="Titel" required><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t === 'hourly' ? 'z. B. Stundensatz Montage 2027' : 'z. B. Roboterzelle RZ-1'} /></Field>
      {t === 'postcalc' && <Field label="Verglichen mit (Soll)" required><select value={base} onChange={(e) => setBase(e.target.value)}><option value="">bitte wählen</option>{bases.map((c) => <option key={c.id} value={c.id}>{c.number} {c.title} ({STATUS[c.status]?.label})</option>)}</select></Field>}
      {t !== 'postcalc' && existing.some((c) => c.template === t) && <Field label="Als Kopie von (optional)"><select value={copy} onChange={(e) => setCopy(e.target.value)}><option value="">leer beginnen</option>{existing.filter((c) => c.template === t).map((c) => <option key={c.id} value={c.id}>{c.number} {c.title}</option>)}</select></Field>}
    </Modal>
  );
}

/** Kalkulation bearbeiten: links die Eingaben, rechts das Ergebnis (rechnet beim Tippen) */
export function CalcEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const act = useAction();
  const toast = useToast();
  const { me } = useSession();
  const { data: c, reload } = useApi<any>(`/calculations/${id}`);
  const [data, setData] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (c) { setData(c.data); setNote(c.note ?? ''); setDirty(false); } }, [c?.updatedAt, c?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const rates: CalcRates | undefined = c?.rates;
  const result: CalcResult | null = useMemo(() => (c && data && rates && c.template !== 'postcalc' ? computeCalc(c.template, data, rates) : c?.result ?? null), [c, data, rates]);
  if (!c || !data || !rates) return null;
  const locked = c.status === 'released';
  const upd = (d: any) => { setData(d); setDirty(true); };
  const save = async () => { if (await act(() => patch(`/calculations/${id}`, { data, note }), 'Gespeichert')) await reload(); };
  const status = async (s: string) => { if (dirty) await save(); if (await act(() => post(`/calculations/${id}/status`, { status: s }), STATUS[s]!.label)) await reload(); };
  return (
    <div>
      <div className="toolbar">
        <button className="btn ghost" onClick={onBack}><Icon name="chevron-left" /> Alle Kalkulationen</button>
        <h2 style={{ margin: 0 }}>{c.title}</h2><span className="mono muted small">{c.number}</span><Pill tone={STATUS[c.status]?.tone}>{STATUS[c.status]?.label}</Pill>
        <span className="small muted">{tplName(c.template)}{c.checkedByName ? ` · geprüft von ${c.checkedByName}` : ''}{c.releasedByName ? ` · freigegeben von ${c.releasedByName}` : ''}</span>
        <span className="grow" />
        {!locked && <button className="btn primary" disabled={!dirty} onClick={save}>Speichern</button>}
        {c.status === 'draft' && <button className="btn" onClick={() => status('checked')} title={c.createdBy === me?.id && me?.role !== 'admin' ? 'Prüfen soll eine zweite Person' : ''}>Als geprüft markieren</button>}
        {c.status === 'checked' && <><button className="btn" onClick={() => status('draft')}>Zurück zu Entwurf</button><button className="btn primary" onClick={() => status('released')}>Freigeben</button></>}
        {locked && me?.role === 'admin' && <button className="btn" onClick={() => status('draft')}>Freigabe aufheben</button>}
        <a className="btn" href={`/api/calculations/${id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file-pdf" /> PDF</a>
        {c.template !== 'hourly' && c.template !== 'postcalc' && c.status !== 'draft' && (c.quoteId ? <Link className="btn" to={`/crm?tab=quotes`}>Angebot {c.quoteNumber}</Link> : <button className="btn" onClick={() => setQuote(true)}><Icon name="euro" /> Angebot im CRM</button>)}
        {(!locked || me?.role === 'admin') && <button className="btn ghost" title="Löschen" onClick={() => setConfirm(true)}><Icon name="trash" /></button>}
      </div>
      {locked && <div className="locked-banner"><Icon name="lock" /> Freigegeben und festgeschrieben. Für Änderungen eine neue Kalkulation als Kopie anlegen.</div>}
      <div className="calc-layout">
        <div className="calc-input">
          <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
            {c.template === 'plant' && <PlantEditor data={data} rates={rates} onChange={upd} projectId={c.projectId} />}
            {c.template === 'surcharge' && <SurchargeEditor data={data} rates={rates} onChange={upd} projectId={c.projectId} />}
            {c.template === 'hourly' && <HourlyEditor data={data} onChange={upd} />}
            {c.template === 'travel' && <TravelEditor data={data} rates={rates} onChange={upd} />}
            {c.template === 'postcalc' && <PostcalcView c={c} />}
            <Field label="Bemerkung"><textarea rows={2} value={note} onChange={(e) => { setNote(e.target.value); setDirty(true); }} /></Field>
          </fieldset>
        </div>
        <div className="calc-result card">
          <h3>Ergebnis</h3>
          {result?.lines.map((l, i) => (
            <div key={i} className={`calc-line ${l.bold ? 'bold' : ''} ${l.indent ? 'indent' : ''}`}><span>{l.label}</span><span>{l.hint === 'Stunden' ? `${l.value.toLocaleString('de-DE')} Std.` : fmtEuro(l.value)}</span></div>
          ))}
          {result?.perUnit != null && result.perUnit !== result.total && <div className="calc-line bold"><span>je Stück</span><span>{fmtEuro(result.perUnit)}</span></div>}
          <details style={{ marginTop: 12 }} className="small muted"><summary>Verwendete Sätze</summary>
            {rates.labor.map((l) => <div key={l.key}>{l.name}: Lohn {fmtEuro(l.wage)}, Verrechnung {fmtEuro(l.rate)} / Std.</div>)}
            {rates.machines.map((m) => <div key={m.key}>{m.name}: {fmtEuro(m.rate)} / Std.</div>)}
            <div>Zuschläge: Material {rates.surcharges.materialOverhead} %, Fertigung {rates.surcharges.productionOverhead} %, VwVt {rates.surcharges.adminSales} %, Wagnis {rates.surcharges.risk} %, Gewinn {rates.surcharges.profit} %, Zukauf {rates.surcharges.purchasedMarkup} %</div>
            {!locked && <button className="btn sm" style={{ marginTop: 6 }} onClick={async () => { if (await act(() => patch(`/calculations/${id}`, { refreshRates: true }), 'Aktuelle Sätze übernommen')) await reload(); }}>Aktuelle Sätze übernehmen</button>}
          </details>
        </div>
      </div>
      {quote && <QuoteFromCalc calc={c} onClose={() => setQuote(false)} onDone={(n) => { setQuote(false); toast(`Angebot ${n} im CRM angelegt`); void reload(); }} />}
      {confirm && <Confirm danger text={`Kalkulation ${c.number} löschen?`} onClose={() => setConfirm(false)} onConfirm={async () => { if (await act(() => del(`/calculations/${id}`), 'Gelöscht')) onBack(); }} />}
    </div>
  );
}

function QuoteFromCalc({ calc, onClose, onDone }: { calc: any; onClose: () => void; onDone: (number: string) => void }) {
  const act = useAction();
  const [acc, setAcc] = useState<{ id: string; name: string } | null>(null);
  const { data: project } = useApi<any>(calc.projectId ? `/projects/${calc.projectId}` : null);
  const hasCustomer = Boolean(project?.customerId);
  return (
    <Modal title="Angebot aus Kalkulation" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!hasCustomer && !acc} onClick={async () => { const r = await act(() => post<{ number: string }>(`/calculations/${calc.id}/quote`, acc ? { accountId: acc.id } : {})); if (r) onDone(r.number); }}>Angebot anlegen</button></>}>
      <p className="muted">Die Baugruppen werden zu Angebotspositionen; der Preis entspricht dem Ergebnis der Kalkulation. Das Angebot lässt sich danach im CRM bearbeiten und als PDF senden.</p>
      {hasCustomer ? <div className="card flat"><Icon name="building" /> Kunde des Projekts: <b>{project.customer}</b></div> : <Field label="Kunde" required><CustomerPicker value={acc} onChange={setAcc} /></Field>}
    </Modal>
  );
}

// ---------------------------------------------------------------- Eingabe je Vorlage
const numIn = (v: unknown) => (v === '' || v == null ? '' : String(v));
const KIND_LABEL: Record<PlantItemKind, string> = { labor: 'Arbeit', machine: 'Maschine', material: 'Material', purchased: 'Zukauf' };

function PlantEditor({ data, rates, onChange, projectId }: { data: any; rates: CalcRates; onChange: (d: any) => void; projectId: string | null }) {
  const groups = data.groups ?? [];
  const setG = (gi: number, g: any) => onChange({ ...data, groups: groups.map((x: any, i: number) => (i === gi ? g : x)) });
  const importMaterial = async (gi: number) => {
    const rows = await get<any[]>(`/calculations/projects/${projectId}/material`);
    const g = groups[gi];
    setG(gi, { ...g, items: [...g.items, ...rows.map((r) => ({ text: r.text, kind: r.source === 'manual' ? 'material' : 'purchased', qty: r.qty, unit: r.unit, price: r.price }))] });
  };
  return (
    <div>
      {groups.map((g: any, gi: number) => (
        <div key={gi} className="card" style={{ marginBottom: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}><input value={g.name} onChange={(e) => setG(gi, { ...g, name: e.target.value })} placeholder="Baugruppe / Leistungsbereich" style={{ fontWeight: 600 }} />
            <button className="btn ghost sm" title="Baugruppe entfernen" onClick={() => onChange({ ...data, groups: groups.filter((_: any, i: number) => i !== gi) })}><Icon name="trash" /></button></div>
          <table className="table pos-table"><tbody>
            {g.items.map((it: any, ii: number) => {
              const set = (p: any) => setG(gi, { ...g, items: g.items.map((x: any, j: number) => (j === ii ? { ...x, ...p } : x)) });
              return (
                <tr key={ii}>
                  <td><input value={it.text} onChange={(e) => set({ text: e.target.value })} placeholder="Position" /></td>
                  <td style={{ width: 110 }}><select value={it.kind} onChange={(e) => set({ kind: e.target.value, key: e.target.value === 'labor' ? rates.labor[0]?.key : e.target.value === 'machine' ? rates.machines[0]?.key : undefined })}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                  <td style={{ width: 150 }}>{it.kind === 'labor' ? <select value={it.key} onChange={(e) => set({ key: e.target.value })}>{rates.labor.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}</select>
                    : it.kind === 'machine' ? <select value={it.key} onChange={(e) => set({ key: e.target.value })}>{rates.machines.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
                    : <input type="number" step="0.01" value={numIn(it.price)} onChange={(e) => set({ price: Number(e.target.value) })} placeholder="Preis €" />}</td>
                  <td style={{ width: 90 }}><input type="number" value={numIn(it.qty)} onChange={(e) => set({ qty: Number(e.target.value) })} placeholder={it.kind === 'labor' || it.kind === 'machine' ? 'Std.' : 'Menge'} /></td>
                  <td style={{ width: 30 }}><button className="btn ghost sm" onClick={() => setG(gi, { ...g, items: g.items.filter((_: any, j: number) => j !== ii) })}><Icon name="x" /></button></td>
                </tr>
              );
            })}
          </tbody></table>
          <div className="row" style={{ marginTop: 4 }}>
            {(['labor', 'material', 'purchased', 'machine'] as PlantItemKind[]).map((k) => <button key={k} className="btn sm ghost" onClick={() => setG(gi, { ...g, items: [...g.items, { text: '', kind: k, key: k === 'labor' ? rates.labor[0]?.key : k === 'machine' ? rates.machines[0]?.key : undefined, qty: k === 'labor' || k === 'machine' ? 0 : 1, price: 0 }] })}><Icon name="plus" /> {KIND_LABEL[k]}</button>)}
            {projectId && <button className="btn sm ghost" onClick={() => importMaterial(gi)} title="Positionen aus dem Einkauf des Projekts"><Icon name="truck" /> aus Einkauf</button>}
          </div>
        </div>
      ))}
      <div className="row">
        <button className="btn" onClick={() => onChange({ ...data, groups: [...groups, { name: '', items: [] }] })}><Icon name="plus" /> Baugruppe</button>
        <label className="row small">Nachlass % <input type="number" min={0} max={100} value={numIn(data.discount)} onChange={(e) => onChange({ ...data, discount: Number(e.target.value) })} style={{ width: 80 }} /></label>
      </div>
      <SurchargeOverrides data={data} rates={rates} onChange={onChange} keys={['materialOverhead', 'purchasedMarkup', 'risk', 'profit']} />
    </div>
  );
}

function SurchargeOverrides({ data, rates, onChange, keys }: { data: any; rates: CalcRates; onChange: (d: any) => void; keys: (keyof CalcRates['surcharges'])[] }) {
  const L: Record<string, string> = { materialOverhead: 'Material-GK %', productionOverhead: 'Fertigungs-GK %', adminSales: 'Verwaltung/Vertrieb %', risk: 'Wagnis %', profit: 'Gewinn %', purchasedMarkup: 'Zukauf-Aufschlag %' };
  return (
    <details style={{ marginTop: 10 }}><summary className="small">Zuschläge nur für diese Kalkulation ändern</summary>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 6 }}>
        {keys.map((k) => <Field key={k} label={L[k]!}><input type="number" value={numIn(data.surcharges?.[k] ?? rates.surcharges[k])} onChange={(e) => onChange({ ...data, surcharges: { ...(data.surcharges ?? {}), [k]: Number(e.target.value) } })} /></Field>)}
      </div>
    </details>
  );
}

function ListEditor({ rows, onChange, cols, add }: { rows: any[]; onChange: (r: any[]) => void; cols: { key: string; label: string; type?: 'number' | 'select'; options?: { value: string; label: string }[]; width?: number }[]; add: any }) {
  return (
    <div>
      <table className="table pos-table"><thead><tr>{cols.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}<th style={{ width: 30 }} /></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>{cols.map((c) => (
            <td key={c.key}>{c.type === 'select' ? <select value={r[c.key]} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, [c.key]: e.target.value } : x)))}>{c.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              : <input type={c.type ?? 'text'} step="any" value={c.type === 'number' ? numIn(r[c.key]) : r[c.key] ?? ''} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, [c.key]: c.type === 'number' ? Number(e.target.value) : e.target.value } : x)))} />}</td>
          ))}<td><button className="btn ghost sm" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Icon name="x" /></button></td></tr>
        ))}</tbody></table>
      <button className="btn sm ghost" onClick={() => onChange([...rows, { ...add }])}><Icon name="plus" /> Zeile</button>
    </div>
  );
}

function SurchargeEditor({ data, rates, onChange, projectId }: { data: any; rates: CalcRates; onChange: (d: any) => void; projectId: string | null }) {
  return (
    <div>
      <Field label="Stückzahl (Losgröße)"><input type="number" min={1} value={numIn(data.quantity)} onChange={(e) => onChange({ ...data, quantity: Number(e.target.value) })} style={{ width: 120 }} /></Field>
      <h3>Material</h3>
      <ListEditor rows={data.material ?? []} onChange={(material) => onChange({ ...data, material })} add={{ text: '', qty: 1, unit: 'Stk', price: 0 }}
        cols={[{ key: 'text', label: 'Material' }, { key: 'qty', label: 'Menge', type: 'number', width: 90 }, { key: 'unit', label: 'Einheit', width: 70 }, { key: 'price', label: 'Preis €', type: 'number', width: 100 }]} />
      {projectId && <button className="btn sm ghost" onClick={async () => { const rows = await get<any[]>(`/calculations/projects/${projectId}/material`); onChange({ ...data, material: [...(data.material ?? []), ...rows.map((r) => ({ text: r.text, qty: r.qty, unit: r.unit, price: r.price }))] }); }}><Icon name="truck" /> aus Einkauf/Stückliste übernehmen</button>}
      <h3 style={{ marginTop: 12 }}>Fertigungslöhne</h3>
      <ListEditor rows={data.labor ?? []} onChange={(labor) => onChange({ ...data, labor })} add={{ text: '', key: rates.labor[0]?.key, hours: 0 }}
        cols={[{ key: 'text', label: 'Arbeitsgang' }, { key: 'key', label: 'Tätigkeit', type: 'select', options: rates.labor.map((l) => ({ value: l.key, label: `${l.name} (${l.wage} €)` })), width: 190 }, { key: 'hours', label: 'Stunden', type: 'number', width: 90 }]} />
      <h3 style={{ marginTop: 12 }}>Maschinenstunden</h3>
      <ListEditor rows={data.machines ?? []} onChange={(machines) => onChange({ ...data, machines })} add={{ text: '', key: rates.machines[0]?.key, hours: 0 }}
        cols={[{ key: 'text', label: 'Arbeitsgang' }, { key: 'key', label: 'Maschine', type: 'select', options: rates.machines.map((m) => ({ value: m.key, label: `${m.name} (${m.rate} €)` })), width: 190 }, { key: 'hours', label: 'Stunden', type: 'number', width: 90 }]} />
      <h3 style={{ marginTop: 12 }}>Sondereinzelkosten der Fertigung</h3>
      <ListEditor rows={data.special ?? []} onChange={(special) => onChange({ ...data, special })} add={{ text: '', amount: 0 }}
        cols={[{ key: 'text', label: 'z. B. Vorrichtung, Prüfmittel' }, { key: 'amount', label: 'Betrag €', type: 'number', width: 120 }]} />
      <SurchargeOverrides data={data} rates={rates} onChange={onChange} keys={['materialOverhead', 'productionOverhead', 'adminSales', 'risk', 'profit']} />
    </div>
  );
}

function HourlyEditor({ data, onChange }: { data: any; onChange: (d: any) => void }) {
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...data, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  return (
    <div>
      <div className="grid2">
        <Field label="Bereich"><input value={data.label ?? ''} onChange={set('label')} placeholder="z. B. Montage" /></Field>
        <Field label="Mitarbeiter"><input type="number" min={0} step="0.5" value={numIn(data.employees)} onChange={set('employees')} /></Field>
        <Field label="Anwesenheitsstunden je Mitarbeiter und Jahr" hint="z. B. 220 Tage × 7,8 Std."><input type="number" value={numIn(data.hoursPerYear)} onChange={set('hoursPerYear')} /></Field>
        <Field label="Davon verrechenbar (%)"><input type="number" min={0} max={100} value={numIn(data.productivity)} onChange={set('productivity')} /></Field>
        <Field label="Gewinnaufschlag (%)"><input type="number" value={numIn(data.profit)} onChange={set('profit')} /></Field>
      </div>
      <h3>Jahreskosten</h3>
      <ListEditor rows={data.costs ?? []} onChange={(costs) => onChange({ ...data, costs })} add={{ text: '', amount: 0 }} cols={[{ key: 'text', label: 'Kostenart' }, { key: 'amount', label: 'Betrag € / Jahr', type: 'number', width: 150 }]} />
    </div>
  );
}

function TravelEditor({ data, rates, onChange }: { data: any; rates: CalcRates; onChange: (d: any) => void }) {
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange({ ...data, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  return (
    <div>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <Field label="Personen"><input type="number" min={1} value={numIn(data.persons)} onChange={set('persons')} /></Field>
        <Field label="Volle Tage (24 Std.)"><input type="number" min={0} value={numIn(data.fullDays)} onChange={set('fullDays')} /></Field>
        <Field label="An- und Abreisetage"><input type="number" min={0} value={numIn(data.partialDays)} onChange={set('partialDays')} /></Field>
        <Field label="Übernachtungen"><input type="number" min={0} value={numIn(data.nights)} onChange={set('nights')} /></Field>
        <Field label="Kilometer (gesamt)"><input type="number" min={0} value={numIn(data.km)} onChange={set('km')} /></Field>
        <Field label="Reisezeit je Person (Std.)"><input type="number" min={0} value={numIn(data.travelHours)} onChange={set('travelHours')} /></Field>
        <Field label="Arbeitszeit je Person (Std.)"><input type="number" min={0} value={numIn(data.workHours)} onChange={set('workHours')} /></Field>
        <Field label="Tätigkeit vor Ort"><select value={data.workKey} onChange={set('workKey')}>{rates.labor.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}</select></Field>
      </div>
      <h3>Weitere Kosten</h3>
      <ListEditor rows={data.extras ?? []} onChange={(extras) => onChange({ ...data, extras })} add={{ text: '', amount: 0 }} cols={[{ key: 'text', label: 'z. B. Mietwagen, Werkzeugversand' }, { key: 'amount', label: 'Betrag €', type: 'number', width: 120 }]} />
    </div>
  );
}

function PostcalcView({ c }: { c: any }) {
  const rows = c.result?.rows ?? [];
  return (
    <div>
      <p className="muted">Soll aus der Kalkulation, Ist aus der Zeiterfassung (Stunden je Tätigkeit über die Abteilung der Mitarbeiter) und dem gelieferten Einkauf. Wird beim Öffnen neu gerechnet, bis die Nachkalkulation freigegeben ist.</p>
      <table className="table"><thead><tr><th>Bereich</th><th style={{ textAlign: 'right' }}>Soll</th><th style={{ textAlign: 'right' }}>Ist</th><th style={{ textAlign: 'right' }}>Abweichung</th></tr></thead>
        <tbody>{rows.map((r: any, i: number) => {
          const d = r.actual - r.plan;
          const f = (v: number) => (r.unit === '€' ? fmtEuro(v) : `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Std.`);
          return <tr key={i} style={r.label === 'Kosten gesamt' ? { fontWeight: 650 } : undefined}><td>{r.label}</td><td style={{ textAlign: 'right' }}>{f(r.plan)}</td><td style={{ textAlign: 'right' }}>{f(r.actual)}</td>
            <td style={{ textAlign: 'right', color: d > 0 ? 'var(--red)' : 'var(--green)' }}>{d > 0 ? '+' : ''}{f(d)}</td></tr>;
        })}</tbody></table>
    </div>
  );
}

// ---------------------------------------------------------------- Sätze (Administrator)
export function CalcRatesSettings() {
  const act = useAction();
  const { teams } = useSession();
  const [r, setR] = useState<CalcRates | null>(null);
  useEffect(() => { get<CalcRates>('/calculations/rates').then(setR).catch(() => {}); }, []);
  if (!r) return null;
  const slug = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `t${Date.now()}`;
  const S: [keyof CalcRates['surcharges'], string][] = [['materialOverhead', 'Material-Gemeinkosten %'], ['productionOverhead', 'Fertigungs-Gemeinkosten % (auf Löhne)'], ['adminSales', 'Verwaltung und Vertrieb %'], ['risk', 'Wagnis %'], ['profit', 'Gewinn %'], ['purchasedMarkup', 'Aufschlag auf Zukaufteile %']];
  const T: [keyof CalcRates['travel'], string][] = [['perKm', 'Kosten je Kilometer €'], ['dailyAllowance', 'Tagespauschale (24 Std.) €'], ['partialDayAllowance', 'An-/Abreisetag €'], ['overnight', 'Übernachtung €'], ['travelHourRate', 'Reisezeit je Stunde €']];
  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ marginBottom: 8 }}>Kalkulationssätze</h1>
      <p className="muted">Gelten für neue Kalkulationen. Bestehende behalten die Sätze, mit denen sie angelegt wurden.</p>
      <h2 style={{ margin: '18px 0 8px' }}>Stundensätze je Tätigkeit</h2>
      <table className="table pos-table"><thead><tr><th>Tätigkeit</th><th style={{ width: 120 }}>Lohn € / Std.</th><th style={{ width: 140 }}>Verrechnung € / Std.</th><th>Abteilungen (für die Nachkalkulation)</th><th style={{ width: 30 }} /></tr></thead>
        <tbody>{r.labor.map((l, i) => (
          <tr key={i}>
            <td><input value={l.name} onChange={(e) => setR({ ...r, labor: r.labor.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></td>
            <td><input type="number" value={l.wage} onChange={(e) => setR({ ...r, labor: r.labor.map((x, j) => (j === i ? { ...x, wage: Number(e.target.value) } : x)) })} /></td>
            <td><input type="number" value={l.rate} onChange={(e) => setR({ ...r, labor: r.labor.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })} /></td>
            <td><select multiple value={l.teamIds ?? []} style={{ height: 60 }} onChange={(e) => setR({ ...r, labor: r.labor.map((x, j) => (j === i ? { ...x, teamIds: [...e.target.selectedOptions].map((o) => o.value) } : x)) })}>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></td>
            <td><button className="btn ghost sm" onClick={() => setR({ ...r, labor: r.labor.filter((_, j) => j !== i) })}><Icon name="x" /></button></td>
          </tr>
        ))}</tbody></table>
      <button className="btn sm" onClick={() => { const name = 'Neue Tätigkeit'; setR({ ...r, labor: [...r.labor, { key: slug(`${name}_${r.labor.length}`), name, wage: 35, rate: 80 }] }); }}><Icon name="plus" /> Tätigkeit</button>
      <h2 style={{ margin: '18px 0 8px' }}>Maschinenstundensätze</h2>
      <table className="table pos-table"><tbody>{r.machines.map((m, i) => (
        <tr key={i}><td><input value={m.name} onChange={(e) => setR({ ...r, machines: r.machines.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></td>
          <td style={{ width: 140 }}><input type="number" value={m.rate} onChange={(e) => setR({ ...r, machines: r.machines.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })} /></td>
          <td style={{ width: 30 }}><button className="btn ghost sm" onClick={() => setR({ ...r, machines: r.machines.filter((_, j) => j !== i) })}><Icon name="x" /></button></td></tr>
      ))}</tbody></table>
      <button className="btn sm" onClick={() => setR({ ...r, machines: [...r.machines, { key: slug(`maschine_${r.machines.length}_${Date.now() % 1000}`), name: 'Neue Maschine', rate: 80 }] })}><Icon name="plus" /> Maschine</button>
      <h2 style={{ margin: '18px 0 8px' }}>Zuschläge</h2>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>{S.map(([k, l]) => <Field key={k} label={l}><input type="number" value={r.surcharges[k]} onChange={(e) => setR({ ...r, surcharges: { ...r.surcharges, [k]: Number(e.target.value) } })} /></Field>)}</div>
      <h2 style={{ margin: '18px 0 8px' }}>Reisekosten</h2>
      <div className="grid2" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>{T.map(([k, l]) => <Field key={k} label={l}><input type="number" step="0.01" value={r.travel[k]} onChange={(e) => setR({ ...r, travel: { ...r.travel, [k]: Number(e.target.value) } })} /></Field>)}</div>
      <button className="btn primary" onClick={() => act(() => put('/settings/calcRates', r), 'Gespeichert')}>Speichern</button>
    </div>
  );
}
