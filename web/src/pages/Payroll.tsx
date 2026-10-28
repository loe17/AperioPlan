import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { computePayslip, DEFAULT_PAY_PROFILE, EMPLOYMENT_GROUPS, PAY_LINE_KINDS, STATES, SURCHARGES, type PayLine, type PayLineKind, type PayProfile, type PayslipResult } from '@aperio/shared';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate, fmtEuro2, isoDate } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, Tabs, useAction, useToast } from '../components/ui';
import { Icon } from '../components/Icon';
import { UserPicker } from '../components/UserPicker';
import { useAdminSettings } from './Settings';

type Tab = 'runs' | 'employees' | 'calc' | 'settings';
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const TAX_CLASSES = ['I', 'II', 'III', 'IV', 'V', 'VI'];

export default function PayrollPage() {
  useCrumbs([{ label: 'Lohnabrechnung' }]);
  const { me } = useSession();
  const [tab, setTab] = useTabState<Tab>('payroll', 'runs');
  if (!me?.payrollManager) return <div className="page"><Empty icon="lock" title="Kein Zugriff">Die Lohnabrechnung sehen nur Lohnbuchhalter und Administratoren. Eigene Lohnzettel stehen unter „Meine Lohnzettel“.</Empty></div>;
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Lohnabrechnung</h1><div className="sub">Lohn und Gehalt abrechnen, Lohnzettel bereitstellen, Daten an Steuerberater und Bank geben</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'runs', label: 'Abrechnung' }, { id: 'employees', label: 'Mitarbeiter' }, { id: 'calc', label: 'Brutto-Netto-Rechner' },
        ...(me.role === 'admin' ? [{ id: 'settings' as Tab, label: 'Einstellungen' }] : [])]} />
      {tab === 'runs' && <Runs />}
      {tab === 'employees' && <Employees />}
      {tab === 'calc' && <Calculator />}
      {tab === 'settings' && <PayrollSettings />}
      <p className="hint" style={{ marginTop: 24 }}>Lohnsteuer und Solidaritätszuschlag nach dem amtlichen Programmablaufplan des Bundesfinanzministeriums, Sozialversicherung mit den Werten 2026.
        Meldungen an Krankenkassen (DEÜV, Beitragsnachweis) und Finanzamt (Lohnsteuer-Anmeldung) übermittelt AperioPlan nicht – dafür sv.net bzw. ELSTER oder den Steuerberater nutzen.
        Sonderfälle wie Kurzarbeit, Altersteilzeit, Mehrfachbeschäftigung oder Pfändungen bitte mit dem Steuerberater klären.</p>
    </div>
  );
}

function useLive(reload: () => void) {
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'payroll.changed') void reload(); }), [reload]);
}

// ---------------------------------------------------------------- Abrechnungsmonate
function Runs() {
  const [params, setParams] = useSearchParams();
  const { data: runs, reload } = useApi<any[]>('/payroll/runs');
  const [create, setCreate] = useState(false);
  useLive(reload);
  const open = params.get('run') ?? runs?.[0]?.id ?? null;
  const setOpen = (id: string) => { params.set('run', id); setParams(params, { replace: true }); };
  const next = useMemo(() => {
    const last = runs?.[0];
    if (!last) { const d = new Date(); return { year: Math.max(2026, d.getFullYear()), month: d.getFullYear() < 2026 ? 1 : d.getMonth() + 1 }; }
    return last.month === 12 ? { year: last.year + 1, month: 1 } : { year: last.year, month: last.month + 1 };
  }, [runs]);
  if (!runs) return null;
  return (
    <div className="pay-layout">
      <div className="pay-runs">
        <button className="btn primary" style={{ width: '100%', marginBottom: 8 }} onClick={() => setCreate(true)}><Icon name="plus" /> {MONTHS[next.month - 1]} {next.year} abrechnen</button>
        {runs.map((r) => (
          <button key={r.id} className={`pay-run ${open === r.id ? 'on' : ''}`} onClick={() => setOpen(r.id)}>
            <span className="grow"><b>{MONTHS[r.month - 1]} {r.year}</b><div className="small muted">{r.slips} Lohnzettel · {fmtEuro2(r.gross)}</div></span>
            {r.status === 'final' ? <Pill tone="green">fest</Pill> : <Pill tone="amber">Entwurf</Pill>}
          </button>
        ))}
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        {!runs.length && <Empty icon="euro" title="Noch keine Abrechnung">Zuerst unter „Mitarbeiter“ den Personalstamm anlegen (Steuerklasse, Krankenkasse, Gehalt), dann den ersten Monat abrechnen.</Empty>}
        {open && <RunView id={open} onChanged={reload} />}
      </div>
      {create && <Modal title="Monat abrechnen" onClose={() => setCreate(false)}><NewRun def={next} onDone={(id) => { setCreate(false); void reload(); setOpen(id); }} /></Modal>}
    </div>
  );
}

function NewRun({ def, onDone }: { def: { year: number; month: number }; onDone: (id: string) => void }) {
  const [v, setV] = useState(def);
  const act = useAction();
  return <div>
    <div className="grid2">
      <Field label="Monat"><select value={v.month} onChange={(e) => setV({ ...v, month: Number(e.target.value) })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
      <Field label="Jahr"><input type="number" min={2026} value={v.year} onChange={(e) => setV({ ...v, year: Number(e.target.value) })} /></Field>
    </div>
    <p className="hint">Für alle aktiven Mitarbeiter wird ein Lohnzettel vorbereitet: Gehalt bzw. Stunden und Zuschläge aus der Zeiterfassung sowie wiederkehrende Lohnarten. Alles lässt sich vor dem Festschreiben ändern.</p>
    <button className="btn primary" onClick={async () => { const r = await act(() => post<{ id: string }>('/payroll/runs', v), 'Angelegt'); if (r) onDone(r.id); }}>Anlegen</button>
  </div>;
}

function RunView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data: run, reload } = useApi<any>(`/payroll/runs/${id}`, [id]);
  const { data: sum, reload: reloadSum } = useApi<any>(`/payroll/runs/${id}/summary`, [id]);
  const { me } = useSession();
  const act = useAction();
  const toast = useToast();
  const [slip, setSlip] = useState<string | null>(null);
  const [finalize, setFinalize] = useState(false);
  const [remove, setRemove] = useState(false);
  const [sepa, setSepa] = useState(false);
  useLive(() => { void reload(); void reloadSum(); });
  if (!run) return null;
  const draft = run.status === 'draft';
  const changed = () => { void reload(); void reloadSum(); onChanged(); };
  const tot = (k: string) => run.slips.reduce((s: number, x: any) => s + x[k], 0);
  return (
    <div>
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>{MONTHS[run.month - 1]} {run.year}</h2>
        {draft ? <Pill tone="amber">Entwurf</Pill> : <Pill tone="green">festgeschrieben {fmtDate(run.finalizedAt)}</Pill>}
        <span className="right row wrap" style={{ gap: 6 }}>
          {draft && <>
            <button className="btn" title="Neue Mitarbeiter ergänzen" onClick={async () => { if (await act(() => post(`/payroll/runs/${id}/refresh`, {}), 'Aktualisiert')) changed(); }}><Icon name="refresh" /> Ergänzen</button>
            <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>
            <button className="btn primary" disabled={!run.slips.length} onClick={() => setFinalize(true)}><Icon name="lock" /> Festschreiben</button>
          </>}
          {!draft && <>
            <button className="btn" onClick={async () => { const r = await act(() => post<any>(`/payroll/runs/${id}/send`, {})); if (r) { toast(`${r.sent} Lohnzettel per E-Mail versendet${r.missing.length ? ` – ohne E-Mail-Adresse: Pers.-Nr. ${r.missing.join(', ')}` : ''}`); changed(); } }}><Icon name="send" /> Lohnzettel mailen</button>
            <button className="btn" onClick={() => setSepa(true)}><Icon name="euro" /> Überweisungen</button>
            <a className="btn" href={`/api/payroll/runs/${id}/datev.csv`}><Icon name="download" /> DATEV-Buchungen</a>
            {me?.role === 'admin' && <button className="btn ghost" onClick={async () => { if (await act(() => post(`/payroll/runs/${id}/reopen`, {}), 'Wieder geöffnet')) changed(); }}><Icon name="unlock" /> Öffnen</button>}
          </>}
          <a className="btn" href={`/api/payroll/runs/${id}/journal.xlsx`}><Icon name="file-excel" /> Lohnjournal</a>
        </span>
      </div>
      {!run.slips.length && <Empty icon="users" title="Keine Lohnzettel">Im Personalstamm ist kein aktiver Mitarbeiter für diesen Monat.</Empty>}
      {run.slips.length > 0 && <table className="table">
        <thead><tr><th>Pers.-Nr.</th><th>Name</th><th style={{ textAlign: 'right' }}>Brutto</th><th style={{ textAlign: 'right' }}>Steuern</th><th style={{ textAlign: 'right' }}>SV Arbeitnehmer</th><th style={{ textAlign: 'right' }}>Netto</th><th style={{ textAlign: 'right' }}>Auszahlung</th><th style={{ textAlign: 'right' }}>Kosten Firma</th><th /></tr></thead>
        <tbody>{run.slips.map((s: any) => { const r: PayslipResult = s.result; return (
          <tr key={s.id} className="click" onClick={() => setSlip(s.id)}>
            <td className="mono">{s.personnelNo}</td>
            <td><b>{s.lastName}, {s.firstName}</b>{r.minijob && <span className="pill small" style={{ marginLeft: 6 }}>Minijob</span>}{r.midijob && <span className="pill small" style={{ marginLeft: 6 }}>Midijob</span>}
              {r.notes.some((n) => /prüfen/.test(n)) && <span className="small text-red" style={{ marginLeft: 6 }}>bitte prüfen</span>}</td>
            <td style={{ textAlign: 'right' }}>{fmtEuro2(r.gross)}</td>
            <td style={{ textAlign: 'right' }}>{fmtEuro2(r.tax.lst + r.tax.soli + r.tax.church)}</td>
            <td style={{ textAlign: 'right' }}>{fmtEuro2(r.an.total)}</td>
            <td style={{ textAlign: 'right' }}>{fmtEuro2(r.net)}</td>
            <td style={{ textAlign: 'right' }}><b>{fmtEuro2(r.payout)}</b></td>
            <td style={{ textAlign: 'right' }} className="muted">{fmtEuro2(r.employerCost)}</td>
            <td onClick={(e) => e.stopPropagation()}><a className="btn ghost sm" title="Lohnzettel (PDF)" href={`/api/payroll/slips/${s.id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file" /></a></td>
          </tr>); })}
        </tbody>
        <tfoot><tr><td /><td><b>Summe</b></td><td style={{ textAlign: 'right' }}><b>{fmtEuro2(tot('gross'))}</b></td><td /><td /><td style={{ textAlign: 'right' }}>{fmtEuro2(tot('net'))}</td>
          <td style={{ textAlign: 'right' }}><b>{fmtEuro2(tot('payout'))}</b></td><td style={{ textAlign: 'right' }}>{fmtEuro2(tot('employerCost'))}</td><td /></tr></tfoot>
      </table>}
      {sum && run.slips.length > 0 && <div className="grid2" style={{ alignItems: 'flex-start', marginTop: 16 }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Beitragsnachweise <span className="small muted">fällig {fmtDate(sum.svDue)}</span></h3>
          <table className="table small"><thead><tr><th>Krankenkasse</th><th style={{ textAlign: 'right' }}>KV</th><th style={{ textAlign: 'right' }}>PV</th><th style={{ textAlign: 'right' }}>RV</th><th style={{ textAlign: 'right' }}>AV</th><th style={{ textAlign: 'right' }}>Umlagen</th><th style={{ textAlign: 'right' }}>Summe</th></tr></thead>
            <tbody>{sum.sv.map((k: any) => <tr key={k.name}><td>{k.name} <span className="muted">({k.count})</span></td><td style={{ textAlign: 'right' }}>{fmtEuro2(k.kv)}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(k.pv)}</td>
              <td style={{ textAlign: 'right' }}>{fmtEuro2(k.rv)}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(k.av)}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(k.u1 + k.u2 + k.insolvency)}</td><td style={{ textAlign: 'right' }}><b>{fmtEuro2(k.total)}</b></td></tr>)}
              {sum.minijob && <tr><td>Minijob-Zentrale <span className="muted">({sum.minijob.count})</span></td><td style={{ textAlign: 'right' }}>{fmtEuro2(sum.minijob.kv)}</td><td /><td style={{ textAlign: 'right' }}>{fmtEuro2(sum.minijob.rv)}</td><td />
                <td style={{ textAlign: 'right' }}>{fmtEuro2(sum.minijob.u1 + sum.minijob.u2 + sum.minijob.insolvency + sum.minijob.tax)}</td><td style={{ textAlign: 'right' }}><b>{fmtEuro2(sum.minijob.total)}</b></td></tr>}
            </tbody></table>
          <p className="hint">Den Beitragsnachweis mit diesen Summen über sv.net an jede Krankenkasse senden (zwei Tage vor Fälligkeit). Bei Minijobs einschließlich Pauschsteuer an die Minijob-Zentrale.</p>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Lohnsteuer-Anmeldung <span className="small muted">fällig {fmtDate(sum.taxDue)}</span></h3>
          <div className="inv-totals" style={{ marginLeft: 0 }}>
            <div><span>Lohnsteuer (Kz. 42)</span><span>{fmtEuro2(sum.tax.lst)}</span></div>
            <div><span>Solidaritätszuschlag (Kz. 49)</span><span>{fmtEuro2(sum.tax.soli)}</span></div>
            <div><span>Kirchensteuer</span><span>{fmtEuro2(sum.tax.church)}</span></div>
            <div className="big"><span>Summe</span><b>{fmtEuro2(sum.tax.total)}</b></div>
          </div>
          <p className="hint">Anmeldung über ELSTER bis zum 10. des Folgemonats. Die Kirchensteuer ist dort nach Konfession aufzuteilen. Arbeitnehmer: {sum.tax.count}.</p>
        </div>
      </div>}
      {slip && <SlipPanel id={slip} run={run} onClose={() => setSlip(null)} onChanged={changed} />}
      {finalize && <Confirm text={`${MONTHS[run.month - 1]} ${run.year} festschreiben? Die Lohnzettel werden erzeugt und die Mitarbeiter benachrichtigt. Änderungen danach nur über „Öffnen“ (Administrator).`}
        onClose={() => setFinalize(false)} onConfirm={async () => { if (await act(() => post(`/payroll/runs/${id}/finalize`, {}), 'Festgeschrieben')) changed(); }} />}
      {remove && <Confirm danger text="Entwurf dieses Monats löschen?" onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/payroll/runs/${id}`))) onChanged(); }} />}
      {sepa && <SepaModal runId={id} onClose={() => setSepa(false)} />}
    </div>
  );
}

function SepaModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { settings } = useSession();
  const { data: banks } = useApi<any[]>((settings as any)?.apps?.installed?.includes?.('finance') ? '/finance/bank-accounts' : null);
  const [iban, setIban] = useState('');
  const [date, setDate] = useState(isoDate(new Date()));
  const toast = useToast();
  useEffect(() => { if (banks?.length && !iban) setIban(banks[0].iban); }, [banks]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Lohnzahlungen überweisen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={iban.replace(/\s/g, '').length < 15} onClick={async () => {
        const res = await fetch(`/api/payroll/runs/${runId}/sepa`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ debtorIban: iban, execDate: date }) });
        if (!res.ok) { toast((await res.json()).error, 'error'); return; }
        const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `Lohnzahlung_${date}.xml`; a.click(); onClose();
      }}><Icon name="download" /> SEPA-Datei erzeugen</button></>}>
      <div className="grid2">
        <Field label="Vom Konto (IBAN)">{banks?.length ? <select value={iban} onChange={(e) => setIban(e.target.value)}>{banks.map((b) => <option key={b.id} value={b.iban}>{b.name} {b.iban}</option>)}</select>
          : <input className="mono" value={iban} onChange={(e) => setIban(e.target.value)} />}</Field>
        <Field label="Ausführen am"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <p className="hint">Die Datei (pain.001) im Online-Banking hochladen und freigeben. Verwendungszweck: Lohn/Gehalt mit Monat und Personalnummer.</p>
    </Modal>
  );
}

function SlipPanel({ id, run, onClose, onChanged }: { id: string; run: any; onClose: () => void; onChanged: () => void }) {
  const s = run.slips.find((x: any) => x.id === id);
  const act = useAction();
  const [lines, setLines] = useState<PayLine[]>(s?.lines ?? []);
  useEffect(() => { if (s) setLines(s.lines); }, [s?.id, s?.result]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const draft = run.status === 'draft';
  const dirty = JSON.stringify(lines) !== JSON.stringify(s.lines);
  const r: PayslipResult = s.result;
  const set = (i: number, p: Partial<PayLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <SlideOver wide title={<span>{s.lastName}, {s.firstName} <span className="mono muted">{s.personnelNo}</span></span>} onClose={onClose}
      actions={<a className="btn sm" href={`/api/payroll/slips/${id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file" /> Lohnzettel</a>}>
      <h3 style={{ marginTop: 0 }}>Lohnarten</h3>
      <table className="table small pay-lines"><thead><tr><th style={{ width: 170 }}>Art</th><th>Bezeichnung</th><th style={{ width: 80 }}>Menge</th><th style={{ width: 90 }}>Satz €</th><th style={{ width: 70 }}>Zuschlag %</th><th style={{ width: 90, textAlign: 'right' }}>Betrag</th><th /></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i}>
            <td><select disabled={!draft} value={l.kind} onChange={(e) => set(i, { kind: e.target.value as PayLineKind, ...(e.target.value === 'surcharge' ? { percent: 25 } : {}) })}>{Object.entries(PAY_LINE_KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></td>
            <td><input disabled={!draft} value={l.label} onChange={(e) => set(i, { label: e.target.value })} />{l.source && <div className="small muted">aus {l.source}</div>}</td>
            <td><input disabled={!draft} type="number" step="0.01" value={l.qty} onChange={(e) => set(i, { qty: Number(e.target.value) })} /></td>
            <td><input disabled={!draft} type="number" step="0.01" value={l.rate} onChange={(e) => set(i, { rate: Number(e.target.value) })} /></td>
            <td>{l.kind === 'surcharge' && <select disabled={!draft} value={l.percent} onChange={(e) => set(i, { percent: Number(e.target.value) })}>{[...new Set([...SURCHARGES.map((x) => x.percent), l.percent ?? 25])].sort((a, b) => a - b).map((p) => <option key={p} value={p}>{p}</option>)}</select>}</td>
            <td style={{ textAlign: 'right' }}>{fmtEuro2(l.kind === 'surcharge' ? l.qty * l.rate * (l.percent ?? 0) / 100 : l.qty * l.rate)}</td>
            <td>{draft && <button className="btn ghost sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Icon name="x" /></button>}</td>
          </tr>
        ))}</tbody></table>
      {draft && <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        {(['bonus', 'overtime', 'surcharge', 'benefit', 'taxfree', 'deduction'] as PayLineKind[]).map((k) => <button key={k} className="btn sm" onClick={() => setLines([...lines, { kind: k, label: PAY_LINE_KINDS[k].label, qty: 1, rate: 0, ...(k === 'surcharge' ? { percent: 25 } : {}) }])}><Icon name="plus" /> {PAY_LINE_KINDS[k].label}</button>)}
        <span className="grow" />
        <button className="btn" title="Vorschlag aus Stammdaten und Zeiterfassung neu holen" onClick={async () => { if (await act(() => post(`/payroll/runs/${run.id}/refresh`, { employeeId: s.employeeId }), 'Neu geholt')) onChanged(); }}><Icon name="refresh" /> Vorschlag neu</button>
        <button className="btn primary" disabled={!dirty} onClick={async () => { if (await act(() => patch(`/payroll/slips/${id}`, { lines }), 'Neu berechnet')) onChanged(); }}>Speichern und berechnen</button>
      </div>}
      {dirty && <p className="small text-red">Geändert – zum Neuberechnen speichern.</p>}
      <SlipResult r={r} />
    </SlideOver>
  );
}

export function SlipResult({ r }: { r: PayslipResult }) {
  const row = (label: string, v: number, strong = false) => (v ? <div className={strong ? 'big' : ''}><span>{label}</span>{strong ? <b>{fmtEuro2(v)}</b> : <span>{fmtEuro2(v)}</span>}</div> : null);
  return (
    <div className="grid2" style={{ alignItems: 'flex-start' }}>
      <div className="inv-totals" style={{ marginLeft: 0, maxWidth: 'none' }}>
        {row('Gesamtbrutto', r.gross, true)}
        {r.taxOneOff > 0 && <div><span className="muted">davon einmalig</span><span className="muted">{fmtEuro2(r.taxOneOff)}</span></div>}
        {row('Lohnsteuer', -r.tax.lst)}{row('Solidaritätszuschlag', -r.tax.soli)}{row('Kirchensteuer', -r.tax.church)}
        {row('Krankenversicherung', -r.an.kv)}{row('Pflegeversicherung', -r.an.pv)}{row('Rentenversicherung', -r.an.rv)}{row('Arbeitslosenversicherung', -r.an.av)}
        {row('Netto', r.net, true)}
        {r.pkvSubsidy > 0 && row('Zuschuss private KV/PV', r.pkvSubsidy)}
        {r.lines.filter((l) => ['benefit', 'taxfree', 'deduction'].includes(l.kind)).map((l, i) => <div key={i}><span>{l.label}</span><span>{fmtEuro2(l.kind === 'taxfree' ? l.amount : -l.amount)}</span></div>)}
        {row('Auszahlung', r.payout, true)}
      </div>
      <div>
        <div className="card flat small">
          <b>Arbeitgeber</b>
          <div className="row"><span className="grow">Sozialversicherung (KV, PV, RV, AV)</span>{fmtEuro2(r.ag.kv + r.ag.pv + r.ag.rv + r.ag.av)}</div>
          <div className="row"><span className="grow">Umlagen U1, U2, Insolvenzgeld</span>{fmtEuro2(r.ag.u1 + r.ag.u2 + r.ag.insolvency)}</div>
          {r.tax.flat > 0 && <div className="row"><span className="grow">Pauschsteuer</span>{fmtEuro2(r.tax.flat)}</div>}
          <div className="row" style={{ marginTop: 4 }}><b className="grow">Kosten gesamt</b><b>{fmtEuro2(r.employerCost)}</b></div>
          <div className="muted" style={{ marginTop: 6 }}>Steuerpflichtig {fmtEuro2(r.taxRegular + r.taxOneOff)} · SV-pflichtig {fmtEuro2(r.svBase)}</div>
        </div>
        {r.notes.map((n, i) => <p key={i} className="hint">{n}</p>)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Mitarbeiter
function Employees() {
  const { data, reload } = useApi<any[]>('/payroll/employees');
  const [edit, setEdit] = useState<any | null>(null);
  const [all, setAll] = useState(false);
  const act = useAction();
  const toast = useToast();
  useLive(reload);
  const list = (data ?? []).filter((e) => all || e.active);
  return (
    <div>
      <div className="toolbar">
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> auch inaktive</label>
        <span className="right row" style={{ gap: 6 }}>
          <button className="btn" onClick={async () => { const r = await act(() => post<{ added: number }>('/payroll/employees/from-users', {})); if (r) { toast(`${r.added} Mitarbeiter übernommen`); void reload(); } }}><Icon name="users" /> Aus Benutzern übernehmen</button>
          <button className="btn primary" onClick={() => setEdit({})}><Icon name="plus" /> Mitarbeiter</button>
        </span>
      </div>
      {data && !list.length && <Empty icon="users" title="Noch keine Mitarbeiter im Personalstamm">„Aus Benutzern übernehmen“ legt für jeden Benutzer einen Stammsatz an. Aushilfen ohne Benutzerkonto über „Mitarbeiter“.</Empty>}
      {list.length > 0 && <table className="table"><thead><tr><th>Pers.-Nr.</th><th>Name</th><th>Beschäftigung</th><th>Steuerklasse</th><th>Krankenkasse</th><th style={{ textAlign: 'right' }}>Gehalt / Stundenlohn</th><th>Eintritt</th></tr></thead>
        <tbody>{list.map((e) => (
          <tr key={e.id} className="click" onClick={() => setEdit(e)} style={e.active ? undefined : { opacity: 0.55 }}>
            <td className="mono">{e.personnelNo}</td><td><b>{e.lastName}, {e.firstName}</b>{e.userName && <div className="small muted">Benutzer {e.userName}</div>}</td>
            <td>{EMPLOYMENT_GROUPS[(e.profile.group ?? 'regular') as keyof typeof EMPLOYMENT_GROUPS].label.split(' (')[0]}</td>
            <td>{TAX_CLASSES[(e.profile.taxClass ?? 1) - 1]}{e.profile.childAllowances ? ` / ${e.profile.childAllowances}` : ''}</td>
            <td>{e.profile.insurance === 'pkv' ? 'privat' : e.healthInsurer || <span className="text-red small">fehlt</span>}</td>
            <td style={{ textAlign: 'right' }}>{e.payType === 'hourly' ? `${fmtEuro2(e.hourlyRate)}/Std.` : fmtEuro2(e.salary)}</td>
            <td>{fmtDate(e.entryDate)}{e.exitDate && <div className="small muted">bis {fmtDate(e.exitDate)}</div>}</td>
          </tr>
        ))}</tbody></table>}
      {edit && <EmployeeModal emp={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function EmployeeModal({ emp, onClose, onSaved }: { emp: any; onClose: () => void; onSaved: () => void }) {
  const { users } = useSession();
  const act = useAction();
  const [remove, setRemove] = useState(false);
  const [f, setF] = useState<any>(() => ({
    userId: null, personnelNo: '', firstName: '', lastName: '', birthDate: '', street: '', zip: '', city: '', email: '', iban: '', bic: '', taxId: '', svNumber: '', healthInsurer: '', jobTitle: '',
    entryDate: '', exitDate: '', payType: 'salary', salary: 0, hourlyRate: 0, weeklyHours: 40, timeSurcharges: false, recurring: [], costCenter: '', notes: '', active: true, ...emp,
    profile: { ...DEFAULT_PAY_PROFILE, ...(emp.profile ?? {}) },
  }));
  const p: PayProfile = f.profile;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const num = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: Number(e.target.value) });
  const pset = (patchP: Partial<PayProfile>) => setF({ ...f, profile: { ...p, ...patchP } });
  const save = async () => {
    const { id, userName, createdAt, updatedAt, ...rest } = f; void userName; void createdAt; void updatedAt;
    const body = { ...rest, birthDate: rest.birthDate || null, entryDate: rest.entryDate || null, exitDate: rest.exitDate || null, salary: Number(rest.salary), hourlyRate: Number(rest.hourlyRate), weeklyHours: Number(rest.weeklyHours) };
    if (await act(() => (id ? patch(`/payroll/employees/${id}`, body) : post('/payroll/employees', body)), 'Gespeichert')) onSaved();
  };
  return (
    <Modal size="lg" title={emp.id ? `${emp.lastName}, ${emp.firstName}` : 'Neuer Mitarbeiter'} onClose={onClose} footer={<>
      {emp.id && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!f.firstName.trim() || !f.lastName.trim()} onClick={() => void save()}>Speichern</button></>}>
      <h3 className="pay-h">Person</h3>
      <div className="grid3">
        <Field label="Vorname"><input value={f.firstName} onChange={set('firstName')} /></Field>
        <Field label="Nachname"><input value={f.lastName} onChange={set('lastName')} /></Field>
        <Field label="Personalnummer" hint="leer = automatisch"><input value={f.personnelNo} onChange={set('personnelNo')} /></Field>
        <Field label="Geburtsdatum"><input type="date" value={f.birthDate ?? ''} onChange={set('birthDate')} /></Field>
        <Field label="Straße"><input value={f.street} onChange={set('street')} /></Field>
        <div className="grid2" style={{ gap: 8, gridTemplateColumns: '80px 1fr' }}><Field label="PLZ"><input value={f.zip} onChange={set('zip')} /></Field><Field label="Ort"><input value={f.city} onChange={set('city')} /></Field></div>
        <Field label="E-Mail für Lohnzettel"><input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Benutzerkonto" hint="für „Meine Lohnzettel“ und Zeiterfassung"><select value={f.userId ?? ''} onChange={(e) => setF({ ...f, userId: e.target.value || null })}><option value="">– keins –</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></Field>
        <Field label="IBAN für Auszahlung"><input className="mono" value={f.iban} onChange={set('iban')} /></Field>
      </div>
      <h3 className="pay-h">Beschäftigung und Vergütung</h3>
      <div className="grid3">
        <Field label="Art"><select value={p.group} onChange={(e) => pset({ group: e.target.value as PayProfile['group'] })}>{Object.entries(EMPLOYMENT_GROUPS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Tätigkeit"><input value={f.jobTitle} onChange={set('jobTitle')} /></Field>
        <Field label="Kostenstelle"><input value={f.costCenter} onChange={set('costCenter')} /></Field>
        <Field label="Eintritt"><input type="date" value={f.entryDate ?? ''} onChange={set('entryDate')} /></Field>
        <Field label="Austritt"><input type="date" value={f.exitDate ?? ''} onChange={set('exitDate')} /></Field>
        <Field label="Wochenstunden"><input type="number" step="0.5" value={f.weeklyHours} onChange={num('weeklyHours')} /></Field>
        <Field label="Vergütung"><select value={f.payType} onChange={set('payType')}><option value="salary">Monatsgehalt</option><option value="hourly">Stundenlohn (aus Zeiterfassung)</option></select></Field>
        {f.payType === 'salary' ? <Field label="Monatsgehalt brutto (€)"><input type="number" step="0.01" value={f.salary} onChange={num('salary')} /></Field>
          : <Field label="Stundenlohn (€)" hint="Mindestlohn 2026: 13,90 €"><input type="number" step="0.01" value={f.hourlyRate} onChange={num('hourlyRate')} /></Field>}
        <Field label="Zuschläge aus Zeiterfassung"><select value={f.timeSurcharges ? '1' : ''} onChange={(e) => setF({ ...f, timeSurcharges: Boolean(e.target.value) })}><option value="">nein</option><option value="1">Nacht, Sonntag, Feiertag</option></select></Field>
      </div>
      <h3 className="pay-h">Steuer (laut ELStAM)</h3>
      <div className="grid3">
        <Field label="Steuer-ID"><input className="mono" value={f.taxId} onChange={set('taxId')} /></Field>
        <Field label="Steuerklasse"><select value={p.taxClass} onChange={(e) => pset({ taxClass: Number(e.target.value) as PayProfile['taxClass'] })}>{TAX_CLASSES.map((c, i) => <option key={c} value={i + 1}>{c}</option>)}</select></Field>
        <Field label="Kinderfreibeträge"><input type="number" step="0.5" min={0} value={p.childAllowances} onChange={(e) => pset({ childAllowances: Number(e.target.value) })} /></Field>
        {p.taxClass === 4 && <Field label="Faktor (0 = ohne)"><input type="number" step="0.001" min={0} max={1} value={p.factor} onChange={(e) => pset({ factor: Number(e.target.value) })} /></Field>}
        <Field label="Kirchensteuer"><select value={p.church ? '1' : ''} onChange={(e) => pset({ church: Boolean(e.target.value) })}><option value="">nein</option><option value="1">ja</option></select></Field>
        <Field label="Bundesland Betriebsstätte"><select value={p.state} onChange={(e) => pset({ state: e.target.value })}>{STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Freibetrag / Monat (€)"><input type="number" min={0} value={p.taxFreeMonthly} onChange={(e) => pset({ taxFreeMonthly: Number(e.target.value) })} /></Field>
        {p.group === 'minijob' && <Field label="Pauschsteuer 2 %"><select value={p.flatTax ? '1' : ''} onChange={(e) => pset({ flatTax: Boolean(e.target.value) })}><option value="1">ja, trägt der Arbeitgeber</option><option value="">nein, nach Steuerklasse</option></select></Field>}
      </div>
      <h3 className="pay-h">Sozialversicherung</h3>
      <div className="grid3">
        <Field label="SV-Nummer"><input className="mono" value={f.svNumber} onChange={set('svNumber')} /></Field>
        <Field label="Krankenversicherung"><select value={p.insurance} onChange={(e) => pset({ insurance: e.target.value as 'gkv' | 'pkv' })}><option value="gkv">gesetzlich</option><option value="pkv">privat</option></select></Field>
        <Field label={p.insurance === 'pkv' ? 'Einzugsstelle (Krankenkasse für RV/AV)' : 'Krankenkasse'}><input value={f.healthInsurer} onChange={set('healthInsurer')} placeholder="z. B. AOK Baden-Württemberg" /></Field>
        {p.insurance === 'gkv' ? <Field label="Zusatzbeitrag (%)" hint="Durchschnitt 2026: 2,9 %"><input type="number" step="0.01" value={p.kvZusatz} onChange={(e) => pset({ kvZusatz: Number(e.target.value) })} /></Field>
          : <Field label="Beitrag private KV + PV / Monat (€)" hint="Basistarif laut Bescheinigung"><input type="number" step="0.01" value={p.pkvPremium} onChange={(e) => pset({ pkvPremium: Number(e.target.value) })} /></Field>}
        <Field label="Pflegeversicherung"><select value={p.pvChildless ? 'none' : 'kids'} onChange={(e) => pset({ pvChildless: e.target.value === 'none' })}><option value="none">kinderlos (Zuschlag 0,6 %)</option><option value="kids">mit Kindern</option></select></Field>
        {!p.pvChildless && <Field label="Kinder unter 25"><input type="number" min={0} value={p.pvChildren} onChange={(e) => pset({ pvChildren: Number(e.target.value) })} /></Field>}
        {p.group === 'minijob' && <Field label="Rentenversicherung"><select value={p.rvExempt ? '1' : ''} onChange={(e) => pset({ rvExempt: Boolean(e.target.value) })}><option value="1">befreit (Antrag liegt vor)</option><option value="">pflichtig (3,6 % Eigenanteil)</option></select></Field>}
        <Field label="Umlage U1 / U2 (%)"><div className="row" style={{ gap: 6 }}><input type="number" step="0.01" value={p.u1} onChange={(e) => pset({ u1: Number(e.target.value) })} /><input type="number" step="0.01" value={p.u2} onChange={(e) => pset({ u2: Number(e.target.value) })} /></div></Field>
      </div>
      <h3 className="pay-h">Jeden Monat</h3>
      {f.recurring.map((l: PayLine, i: number) => (
        <div key={i} className="row" style={{ gap: 6, marginBottom: 6 }}>
          <select style={{ width: 210 }} value={l.kind} onChange={(e) => setF({ ...f, recurring: f.recurring.map((x: PayLine, j: number) => (j === i ? { ...x, kind: e.target.value } : x)) })}>{Object.entries(PAY_LINE_KINDS).filter(([k]) => !['salary', 'hours'].includes(k)).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          <input className="grow" value={l.label} onChange={(e) => setF({ ...f, recurring: f.recurring.map((x: PayLine, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} />
          <input style={{ width: 110 }} type="number" step="0.01" value={l.rate} onChange={(e) => setF({ ...f, recurring: f.recurring.map((x: PayLine, j: number) => (j === i ? { ...x, rate: Number(e.target.value) } : x)) })} />
          <button className="btn ghost sm" onClick={() => setF({ ...f, recurring: f.recurring.filter((_: PayLine, j: number) => j !== i) })}><Icon name="x" /></button>
        </div>
      ))}
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => setF({ ...f, recurring: [...f.recurring, { kind: 'deduction', label: 'Vermögenswirksame Leistung', qty: 1, rate: 40 }] })}><Icon name="plus" /> VL-Sparvertrag</button>
        <button className="btn sm" onClick={() => setF({ ...f, recurring: [...f.recurring, { kind: 'benefit', label: 'Dienstwagen (1 % vom Listenpreis)', qty: 1, rate: 0 }] })}><Icon name="plus" /> Dienstwagen</button>
        <button className="btn sm" onClick={() => setF({ ...f, recurring: [...f.recurring, { kind: 'taxfree', label: 'Sachbezug (Gutschein, bis 50 €)', qty: 1, rate: 50 }] })}><Icon name="plus" /> Sachbezug 50 €</button>
        <button className="btn sm" onClick={() => setF({ ...f, recurring: [...f.recurring, { kind: 'salary', label: 'Zulage', qty: 1, rate: 0 }] })}><Icon name="plus" /> Zulage</button>
      </div>
      <Field label="Notizen"><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
      <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv (wird abgerechnet)</label>
      {remove && <Confirm danger text="Stammsatz löschen? Geht nur, solange es keine festgeschriebene Abrechnung gibt." onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/payroll/employees/${emp.id}`))) onSaved(); }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Rechner
function Calculator() {
  const [p, setP] = useState<PayProfile>(DEFAULT_PAY_PROFILE);
  const [gross, setGross] = useState(3500);
  const [bonus, setBonus] = useState(0);
  const r = useMemo(() => computePayslip(2026, 6, p, [{ kind: 'salary', label: 'Gehalt', qty: 1, rate: gross }, ...(bonus ? [{ kind: 'bonus' as const, label: 'Einmalzahlung', qty: 1, rate: bonus }] : [])],
    { taxableRegular: gross * 5, taxableOneOff: 0, svKv: gross * 5, svRv: gross * 5, svMonths: 5 }), [p, gross, bonus]);
  const pset = (x: Partial<PayProfile>) => setP({ ...p, ...x });
  return (
    <div className="grid2" style={{ alignItems: 'flex-start', maxWidth: 1100 }}>
      <div className="card">
        <div className="grid2">
          <Field label="Monatsbrutto (€)"><input type="number" step="50" value={gross} onChange={(e) => setGross(Number(e.target.value))} /></Field>
          <Field label="Einmalzahlung (€)"><input type="number" step="100" value={bonus} onChange={(e) => setBonus(Number(e.target.value))} /></Field>
          <Field label="Art"><select value={p.group} onChange={(e) => pset({ group: e.target.value as PayProfile['group'] })}>{Object.entries(EMPLOYMENT_GROUPS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
          <Field label="Steuerklasse"><select value={p.taxClass} onChange={(e) => pset({ taxClass: Number(e.target.value) as PayProfile['taxClass'] })}>{TAX_CLASSES.map((c, i) => <option key={c} value={i + 1}>{c}</option>)}</select></Field>
          <Field label="Kinderfreibeträge"><input type="number" step="0.5" min={0} value={p.childAllowances} onChange={(e) => pset({ childAllowances: Number(e.target.value) })} /></Field>
          <Field label="Kirchensteuer"><select value={p.church ? '1' : ''} onChange={(e) => pset({ church: Boolean(e.target.value) })}><option value="">nein</option><option value="1">ja</option></select></Field>
          <Field label="Bundesland"><select value={p.state} onChange={(e) => pset({ state: e.target.value })}>{STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Krankenversicherung"><select value={p.insurance} onChange={(e) => pset({ insurance: e.target.value as 'gkv' | 'pkv' })}><option value="gkv">gesetzlich</option><option value="pkv">privat</option></select></Field>
          {p.insurance === 'gkv' ? <Field label="Zusatzbeitrag (%)"><input type="number" step="0.1" value={p.kvZusatz} onChange={(e) => pset({ kvZusatz: Number(e.target.value) })} /></Field>
            : <Field label="Beitrag privat KV + PV (€)"><input type="number" value={p.pkvPremium} onChange={(e) => pset({ pkvPremium: Number(e.target.value) })} /></Field>}
          <Field label="Pflegeversicherung"><select value={p.pvChildless ? 'none' : String(p.pvChildren || 1)} onChange={(e) => pset(e.target.value === 'none' ? { pvChildless: true } : { pvChildless: false, pvChildren: Number(e.target.value) })}>
            <option value="none">kinderlos</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'Kind' : 'Kinder'} unter 25</option>)}</select></Field>
        </div>
        <p className="hint">Rechnet mit den Werten 2026. Für die Einmalzahlung wird ein gleichbleibendes Gehalt seit Januar angenommen.</p>
      </div>
      <SlipResult r={r} />
    </div>
  );
}

// ---------------------------------------------------------------- Einstellungen
function PayrollSettings() {
  const s = useAdminSettings('payroll');
  const { users } = useSession();
  const act = useAction();
  if (!s.value) return null;
  const v = s.value;
  const acc = (k: string) => (e: { target: { value: string } }) => s.setValue({ ...v, accounts: { ...v.accounts, [k]: e.target.value } });
  return (
    <div style={{ maxWidth: 860 }}>
      <Field label="Lohnbuchhalter" hint="sehen alle Löhne und rechnen ab – zusätzlich zu Administratoren"><UserPicker users={users} value={v.managerIds} onChange={(ids) => s.setValue({ ...v, managerIds: ids })} /></Field>
      <div className="grid3">
        <Field label="Betriebsnummer"><input value={v.companyNo} onChange={(e) => s.setValue({ ...v, companyNo: e.target.value })} /></Field>
        <Field label="Bundesland der Betriebsstätte"><select value={v.state} onChange={(e) => s.setValue({ ...v, state: e.target.value })}>{STATES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Erste Personalnummer"><input type="number" value={v.firstPersonnelNo} onChange={(e) => s.setValue({ ...v, firstPersonnelNo: Number(e.target.value) })} /></Field>
        <Field label="Umlage U1 (%)" hint="Satz der Krankenkasse, Voreinstellung"><input type="number" step="0.01" value={v.u1} onChange={(e) => s.setValue({ ...v, u1: Number(e.target.value) })} /></Field>
        <Field label="Umlage U2 (%)"><input type="number" step="0.01" value={v.u2} onChange={(e) => s.setValue({ ...v, u2: Number(e.target.value) })} /></Field>
      </div>
      <h3>Zuschläge aus der Zeiterfassung</h3>
      <div className="grid3">
        <Field label="Nacht 20–6 Uhr (%)" hint="steuerfrei bis 25 %"><input type="number" value={v.surcharges.night} onChange={(e) => s.setValue({ ...v, surcharges: { ...v.surcharges, night: Number(e.target.value) } })} /></Field>
        <Field label="Sonntag (%)" hint="steuerfrei bis 50 %"><input type="number" value={v.surcharges.sunday} onChange={(e) => s.setValue({ ...v, surcharges: { ...v.surcharges, sunday: Number(e.target.value) } })} /></Field>
        <Field label="Feiertag (%)" hint="steuerfrei bis 125 %"><input type="number" value={v.surcharges.holiday} onChange={(e) => s.setValue({ ...v, surcharges: { ...v.surcharges, holiday: Number(e.target.value) } })} /></Field>
      </div>
      <h3>Konten für die Buchung (SKR03)</h3>
      <div className="grid3">
        <Field label="Löhne"><input value={v.accounts.wages} onChange={acc('wages')} /></Field>
        <Field label="Gehälter"><input value={v.accounts.salaries} onChange={acc('salaries')} /></Field>
        <Field label="Aushilfslöhne (Minijob)"><input value={v.accounts.minijob} onChange={acc('minijob')} /></Field>
        <Field label="Gesetzliche soziale Aufwendungen"><input value={v.accounts.social} onChange={acc('social')} /></Field>
        <Field label="Pauschale Steuer Aushilfen"><input value={v.accounts.flatTax} onChange={acc('flatTax')} /></Field>
        <Field label="Steuerfreie Bezüge"><input value={v.accounts.taxFree} onChange={acc('taxFree')} /></Field>
        <Field label="Verbindlichkeiten Lohn"><input value={v.accounts.liabilityNet} onChange={acc('liabilityNet')} /></Field>
        <Field label="Verbindlichkeiten Lohnsteuer"><input value={v.accounts.liabilityTax} onChange={acc('liabilityTax')} /></Field>
        <Field label="Verbindlichkeiten Sozialversicherung"><input value={v.accounts.liabilitySv} onChange={acc('liabilitySv')} /></Field>
      </div>
      <button className="btn primary" onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button>
      <p className="hint">Kontonummern mit dem Steuerberater abstimmen. Bei SKR04: Löhne 6000, Gehälter 6020, Aushilfen 6030, soziale Abgaben 6110, Verbindlichkeiten 3720/3730/3740.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Meine Lohnzettel
export function MyPayslipsPage() {
  useCrumbs([{ label: 'Meine Lohnzettel' }]);
  const { data } = useApi<any[]>('/me/payslips');
  return (
    <div className="page">
      <div className="page-head"><div><h1>Meine Lohnzettel</h1><div className="sub">Entgeltabrechnungen zum Ansehen und Herunterladen</div></div></div>
      {data && !data.length && <Empty icon="file-text" title="Noch keine Lohnzettel" />}
      {data && data.length > 0 && <table className="table" style={{ maxWidth: 700 }}><thead><tr><th>Monat</th><th style={{ textAlign: 'right' }}>Brutto</th><th style={{ textAlign: 'right' }}>Auszahlung</th><th /></tr></thead>
        <tbody>{data.map((s) => <tr key={s.id}><td><b>{MONTHS[s.month - 1]} {s.year}</b></td><td style={{ textAlign: 'right' }}>{fmtEuro2(s.gross)}</td><td style={{ textAlign: 'right' }}>{fmtEuro2(s.payout)}</td>
          <td style={{ textAlign: 'right' }}><a className="btn sm" href={`/api/me/payslips/${s.id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file" /> PDF</a></td></tr>)}</tbody></table>}
    </div>
  );
}
