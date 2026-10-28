import { InvoicePanel, QuoteInvoiceButtons } from './Invoices';
import { useState } from 'react';
import { del, patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../session';
import { fmtEuro2, isoDate } from '../lib/format';
import { Confirm, Field, Modal, useAction } from '../components/ui';
import { UserPicker } from '../components/UserPicker';
import { Icon } from '../components/Icon';
import { CASE_STATUS, CASE_TYPE, CustomerPicker, QUOTE_STATUS, STAGES, contactName, useContacts, type CrmContact } from './CrmShared';

const toLocal = (d: Date) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };

// ---------------------------------------------------------------- Ansprechpartner
export function ContactModal({ accountId, contact, onClose, onSaved }: { accountId: string; contact?: CrmContact | null; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const [c, setC] = useState<Partial<CrmContact>>(contact ?? { salutation: '', firstName: '', lastName: '', preferredChannel: '', isPrimary: false });
  const [confirm, setConfirm] = useState(false);
  const set = (k: keyof CrmContact) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setC({ ...c, [k]: e.target.value });
  const save = async () => {
    const body = { salutation: c.salutation, firstName: c.firstName, lastName: c.lastName, position: c.position ?? '', department: c.department ?? '', phone: c.phone ?? '', mobile: c.mobile ?? '',
      email: c.email ?? '', birthday: c.birthday || null, preferredChannel: c.preferredChannel ?? '', isPrimary: c.isPrimary ?? false, notes: c.notes ?? '' };
    if (await act(() => (contact ? patch(`/crm/contacts/${contact.id}`, body) : post(`/crm/accounts/${accountId}/contacts`, body)), 'Gespeichert')) onSaved();
  };
  return (
    <Modal title={contact ? contactName(contact) : 'Neuer Ansprechpartner'} onClose={onClose} footer={<>
      {contact && <button className="btn danger" onClick={() => setConfirm(true)}>Löschen</button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!c.lastName?.trim()} onClick={save}>Speichern</button></>}>
      <div className="grid2" style={{ gridTemplateColumns: '110px 1fr 1fr' }}>
        <Field label="Anrede"><select value={c.salutation} onChange={set('salutation')}><option value="">–</option><option>Herr</option><option>Frau</option><option>Divers</option></select></Field>
        <Field label="Vorname"><input autoFocus value={c.firstName ?? ''} onChange={set('firstName')} /></Field>
        <Field label="Nachname" required><input value={c.lastName ?? ''} onChange={set('lastName')} /></Field>
      </div>
      <div className="grid2">
        <Field label="Position"><input value={c.position ?? ''} onChange={set('position')} placeholder="z. B. Einkaufsleiter" /></Field>
        <Field label="Abteilung"><input value={c.department ?? ''} onChange={set('department')} /></Field>
        <Field label="Telefon"><input value={c.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="Mobil"><input value={c.mobile ?? ''} onChange={set('mobile')} /></Field>
        <Field label="E-Mail"><input type="email" value={c.email ?? ''} onChange={set('email')} /></Field>
        <Field label="Geburtstag"><input type="date" value={c.birthday ?? ''} onChange={set('birthday')} /></Field>
        <Field label="Bevorzugter Kontaktweg"><select value={c.preferredChannel} onChange={set('preferredChannel')}>
          <option value="">egal</option><option value="phone">Telefon</option><option value="mobile">Mobil</option><option value="email">E-Mail</option><option value="visit">persönlich</option></select></Field>
        <Field label="Hauptansprechpartner"><label className="row"><input type="checkbox" checked={Boolean(c.isPrimary)} onChange={(e) => setC({ ...c, isPrimary: e.target.checked })} /> ja</label></Field>
      </div>
      <Field label="Notizen"><textarea rows={2} value={c.notes ?? ''} onChange={set('notes')} /></Field>
      {confirm && contact && <Confirm danger text={`${contactName(contact)} löschen?`} onClose={() => setConfirm(false)} onConfirm={async () => { await act(() => del(`/crm/contacts/${contact.id}`), 'Gelöscht'); onSaved(); }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Gesprächsprotokoll
interface Agreement { text: string; assigneeId: string | null; dueDate: string | null; projectId: string | null; taskId?: string | null }
export function MinutesModal({ accountId, minutes, onClose, onSaved }: { accountId: string; minutes?: any; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const { users } = useSession();
  const contacts = useContacts(accountId);
  const { data: projects } = useApi<any[]>('/projects');
  const [m, setM] = useState({
    heldAt: toLocal(minutes ? new Date(minutes.heldAt) : new Date()), topic: minutes?.topic ?? '', contactIds: (minutes?.contactIds ?? []) as string[], userIds: (minutes?.userIds ?? []) as string[],
    otherParticipants: minutes?.otherParticipants ?? '', discussed: minutes?.discussed ?? '', agreements: (minutes?.agreements ?? []) as Agreement[],
  });
  const setAg = (i: number, p: Partial<Agreement>) => setM({ ...m, agreements: m.agreements.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  const save = async () => {
    const body = { ...m, heldAt: new Date(m.heldAt).toISOString(), agreements: m.agreements.filter((a) => a.text.trim()) };
    if (await act(() => (minutes ? patch(`/crm/minutes/${minutes.id}`, body) : post(`/crm/accounts/${accountId}/minutes`, body)), 'Protokoll gespeichert')) onSaved();
  };
  return (
    <Modal size="lg" title={minutes ? 'Gesprächsprotokoll' : 'Neues Gesprächsprotokoll'} onClose={onClose} footer={<>
      {minutes && <a className="btn" href={`/api/crm/minutes/${minutes.id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file-pdf" /> PDF</a>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!m.topic.trim()} onClick={save}>Speichern</button></>}>
      <div className="grid2">
        <Field label="Thema" required><input autoFocus value={m.topic} onChange={(e) => setM({ ...m, topic: e.target.value })} placeholder="z. B. Abstimmung Lastenheft" /></Field>
        <Field label="Datum und Uhrzeit"><input type="datetime-local" value={m.heldAt} onChange={(e) => setM({ ...m, heldAt: e.target.value })} /></Field>
      </div>
      <Field label="Teilnehmer beim Kunden">
        <div className="row wrap">{contacts.map((c) => (
          <label key={c.id} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={m.contactIds.includes(c.id)} onChange={() => setM({ ...m, contactIds: m.contactIds.includes(c.id) ? m.contactIds.filter((x) => x !== c.id) : [...m.contactIds, c.id] })} />{contactName(c)}</label>
        ))}{!contacts.length && <span className="muted small">noch keine Ansprechpartner</span>}</div>
      </Field>
      <div className="grid2">
        <Field label="Teilnehmer aus der Firma"><UserPicker users={users} value={m.userIds} onChange={(userIds) => setM({ ...m, userIds })} /></Field>
        <Field label="Weitere Teilnehmer"><input value={m.otherParticipants} onChange={(e) => setM({ ...m, otherParticipants: e.target.value })} /></Field>
      </div>
      <Field label="Besprochen"><textarea rows={6} value={m.discussed} onChange={(e) => setM({ ...m, discussed: e.target.value })} /></Field>
      <Field label="Vereinbarte Punkte" hint="Mit Projekt gewählt wird beim Speichern eine Aufgabe mit Frist angelegt">
        {m.agreements.map((a, i) => (
          <div key={i} className="row" style={{ marginBottom: 6, gap: 6 }}>
            <input value={a.text} placeholder="Was?" onChange={(e) => setAg(i, { text: e.target.value })} />
            <select value={a.assigneeId ?? ''} onChange={(e) => setAg(i, { assigneeId: e.target.value || null })} style={{ width: 150 }}><option value="">Wer?</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
            <input type="date" value={a.dueDate ?? ''} onChange={(e) => setAg(i, { dueDate: e.target.value || null })} style={{ width: 140 }} />
            {a.taskId ? <span className="pill green small" title="Aufgabe angelegt"><Icon name="check" /> Aufgabe</span>
              : <select value={a.projectId ?? ''} onChange={(e) => setAg(i, { projectId: e.target.value || null })} style={{ width: 160 }}><option value="">ohne Aufgabe</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select>}
            <button className="btn ghost sm" onClick={() => setM({ ...m, agreements: m.agreements.filter((_, j) => j !== i) })}><Icon name="x" /></button>
          </div>
        ))}
        <button className="btn sm" onClick={() => setM({ ...m, agreements: [...m.agreements, { text: '', assigneeId: null, dueDate: null, projectId: null }] })}><Icon name="plus" /> Punkt</button>
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- Verkaufschance
export function OpportunityModal({ opp, accountId, onClose, onSaved }: { opp?: any; accountId?: string; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const { users } = useSession();
  const [o, setO] = useState({
    account: opp ? { id: opp.accountId, name: opp.accountName, number: opp.accountNumber } : accountId ? { id: accountId, name: '', number: '' } : null as { id: string; name: string; number?: string } | null,
    title: opp?.title ?? '', stage: opp?.stage ?? 'request', value: opp?.value ?? '', probability: opp?.probability ?? '', expectedClose: opp?.expectedClose ?? '',
    ownerId: opp?.ownerId ?? '', contactId: opp?.contactId ?? '', description: opp?.description ?? '', lostReason: opp?.lostReason ?? '',
  });
  const contacts = useContacts(o.account?.id);
  const [confirm, setConfirm] = useState(false);
  const save = async () => {
    const body = { title: o.title, stage: o.stage, value: o.value === '' ? null : Number(o.value), ...(o.probability !== '' ? { probability: Number(o.probability) } : {}),
      expectedClose: o.expectedClose || null, ownerId: o.ownerId || null, contactId: o.contactId || null, description: o.description, lostReason: o.lostReason };
    if (await act(() => (opp ? patch(`/crm/opportunities/${opp.id}`, body) : post('/crm/opportunities', { ...body, accountId: o.account!.id })), 'Gespeichert')) onSaved();
  };
  return (
    <Modal title={opp ? opp.title : 'Neue Verkaufschance'} onClose={onClose} footer={<>
      {opp && <button className="btn danger" onClick={() => setConfirm(true)}>Löschen</button>}<span className="grow" />
      <button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!o.title.trim() || !o.account} onClick={save}>Speichern</button></>}>
      {!accountId && !opp && <Field label="Kunde" required><CustomerPicker value={o.account} onChange={(account) => setO({ ...o, account })} /></Field>}
      <Field label="Titel" required><input autoFocus value={o.title} onChange={(e) => setO({ ...o, title: e.target.value })} placeholder="z. B. Roboterzelle Linie 3" /></Field>
      <div className="grid2">
        <Field label="Phase"><select value={o.stage} onChange={(e) => setO({ ...o, stage: e.target.value, probability: '' })}>{STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
        <Field label="Wert (netto, €)"><input type="number" min={0} value={o.value} onChange={(e) => setO({ ...o, value: e.target.value })} /></Field>
        <Field label="Wahrscheinlichkeit (%)" hint="leer = passend zur Phase"><input type="number" min={0} max={100} value={o.probability} onChange={(e) => setO({ ...o, probability: e.target.value })} /></Field>
        <Field label="Voraussichtlicher Abschluss"><input type="date" value={o.expectedClose} onChange={(e) => setO({ ...o, expectedClose: e.target.value })} /></Field>
        <Field label="Zuständig"><select value={o.ownerId} onChange={(e) => setO({ ...o, ownerId: e.target.value })}><option value="">ich</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></Field>
        <Field label="Ansprechpartner"><select value={o.contactId} onChange={(e) => setO({ ...o, contactId: e.target.value })}><option value="">–</option>{contacts.map((c) => <option key={c.id} value={c.id}>{contactName(c)}</option>)}</select></Field>
      </div>
      {o.stage === 'lost' && <Field label="Grund für den Verlust"><input value={o.lostReason} onChange={(e) => setO({ ...o, lostReason: e.target.value })} placeholder="z. B. Preis, Liefertermin, Wettbewerber" /></Field>}
      <Field label="Beschreibung"><textarea rows={3} value={o.description} onChange={(e) => setO({ ...o, description: e.target.value })} /></Field>
      {confirm && opp && <Confirm danger text={`„${opp.title}“ löschen?`} onClose={() => setConfirm(false)} onConfirm={async () => { await act(() => del(`/crm/opportunities/${opp.id}`), 'Gelöscht'); onSaved(); }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Angebot
interface Pos { text: string; description: string; qty: number; unit: string; price: number; discount: number; optional: boolean }
const posTotal = (p: Pos) => (p.optional ? 0 : p.qty * p.price * (1 - p.discount / 100));

export function QuoteEditor({ quote, accountId, opportunityId, projectId, initialPositions, calculationId, title, onClose, onSaved }: {
  quote?: any; accountId?: string; opportunityId?: string | null; projectId?: string | null; initialPositions?: Pos[]; calculationId?: string | null; title?: string;
  onClose: () => void; onSaved: (id: string) => void;
}) {
  const act = useAction();
  const [q, setQ] = useState({
    account: quote ? { id: quote.accountId, name: quote.accountName } : accountId ? { id: accountId, name: '' } : null as { id: string; name: string } | null,
    title: quote?.title ?? title ?? '', status: quote?.status ?? 'draft', quoteDate: quote?.quoteDate ?? isoDate(new Date()), validUntil: quote?.validUntil ?? '',
    contactId: quote?.contactId ?? '', intro: quote?.intro ?? undefined as string | undefined, outro: quote?.outro ?? undefined as string | undefined,
    vatRate: quote?.vatRate ?? 19, positions: (quote?.positions ?? initialPositions ?? [{ text: '', description: '', qty: 1, unit: 'Stk', price: 0, discount: 0, optional: false }]) as Pos[],
  });
  const contacts = useContacts(q.account?.id);
  const [invoice, setInvoice] = useState<string | null>(null);
  const net = q.positions.reduce((s, p) => s + posTotal(p), 0);
  const setPos = (i: number, p: Partial<Pos>) => setQ({ ...q, positions: q.positions.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const move = (i: number, d: -1 | 1) => { const n = [...q.positions]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; setQ({ ...q, positions: n }); };
  const save = async () => {
    const body = { title: q.title, status: q.status, quoteDate: q.quoteDate, validUntil: q.validUntil || null, contactId: q.contactId || null, positions: q.positions.filter((p) => p.text.trim()),
      vatRate: Number(q.vatRate), ...(q.intro !== undefined ? { intro: q.intro } : {}), ...(q.outro !== undefined ? { outro: q.outro } : {}) };
    if (quote) { if (await act(() => patch(`/crm/quotes/${quote.id}`, body), 'Angebot gespeichert')) onSaved(quote.id); return; }
    const r = await act(() => post<{ id: string; number: string }>('/crm/quotes', { ...body, accountId: q.account!.id, opportunityId: opportunityId ?? null, projectId: projectId ?? null, calculationId: calculationId ?? null }), 'Angebot angelegt');
    if (r) onSaved(r.id);
  };
  return (
    <Modal size="lg" title={quote ? `Angebot ${quote.number}` : 'Neues Angebot'} onClose={onClose} footer={<>
      {quote && <a className="btn" href={`/api/crm/quotes/${quote.id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file-pdf" /> PDF ansehen</a>}
      {quote && <QuoteInvoiceButtons quoteId={quote.id} onCreated={setInvoice} />}
      <span className="grow" /><span className="muted">Summe netto <b>{fmtEuro2(net)}</b> · brutto {fmtEuro2(net * (1 + Number(q.vatRate) / 100))}</span>
      <button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!q.title.trim() || !q.account} onClick={save}>Speichern</button></>}>
      {!quote && !accountId && <Field label="Kunde" required><CustomerPicker value={q.account} onChange={(account) => setQ({ ...q, account })} /></Field>}
      <div className="grid2">
        <Field label="Betreff" required><input autoFocus value={q.title} onChange={(e) => setQ({ ...q, title: e.target.value })} placeholder="z. B. Roboterzelle RZ-1" /></Field>
        <Field label="Status"><select value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })}>{Object.entries(QUOTE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Datum"><input type="date" value={q.quoteDate} onChange={(e) => setQ({ ...q, quoteDate: e.target.value })} /></Field>
        <Field label="Gültig bis" hint="leer = Standard-Gültigkeit"><input type="date" value={q.validUntil} onChange={(e) => setQ({ ...q, validUntil: e.target.value })} /></Field>
        <Field label="Ansprechpartner"><select value={q.contactId} onChange={(e) => setQ({ ...q, contactId: e.target.value })}><option value="">–</option>{contacts.map((c) => <option key={c.id} value={c.id}>{contactName(c)}</option>)}</select></Field>
        <Field label="MwSt. (%)"><input type="number" value={q.vatRate} onChange={(e) => setQ({ ...q, vatRate: e.target.value })} /></Field>
      </div>
      {q.intro !== undefined && <Field label="Einleitung"><textarea rows={2} value={q.intro} onChange={(e) => setQ({ ...q, intro: e.target.value })} /></Field>}
      <div className="table-wrap"><table className="table pos-table">
        <thead><tr><th style={{ width: 28 }}>Pos.</th><th>Bezeichnung</th><th style={{ width: 80 }}>Menge</th><th style={{ width: 70 }}>Einheit</th><th style={{ width: 100 }}>Einzelpreis €</th><th style={{ width: 70 }}>Rabatt %</th><th style={{ width: 100, textAlign: 'right' }}>Gesamt</th><th style={{ width: 90 }} /></tr></thead>
        <tbody>{q.positions.map((p, i) => (
          <tr key={i}>
            <td className="muted">{i + 1}</td>
            <td><input value={p.text} onChange={(e) => setPos(i, { text: e.target.value })} placeholder="Leistung oder Artikel" />
              <textarea rows={1} value={p.description} onChange={(e) => setPos(i, { description: e.target.value })} placeholder="Beschreibung (optional)" style={{ marginTop: 4, fontSize: 12 }} /></td>
            <td><input type="number" value={p.qty} onChange={(e) => setPos(i, { qty: Number(e.target.value) })} /></td>
            <td><input value={p.unit} onChange={(e) => setPos(i, { unit: e.target.value })} /></td>
            <td><input type="number" step="0.01" value={p.price} onChange={(e) => setPos(i, { price: Number(e.target.value) })} /></td>
            <td><input type="number" min={0} max={100} value={p.discount} onChange={(e) => setPos(i, { discount: Number(e.target.value) })} /></td>
            <td style={{ textAlign: 'right' }} className={p.optional ? 'muted' : ''}>{p.optional ? `(${fmtEuro2(p.qty * p.price * (1 - p.discount / 100))})` : fmtEuro2(posTotal(p))}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button className={`btn ghost sm ${p.optional ? 'primary' : ''}`} title="Optional (nicht in der Summe)" onClick={() => setPos(i, { optional: !p.optional })}>opt.</button>
              <button className="btn ghost sm" onClick={() => move(i, -1)} title="nach oben"><Icon name="arrow-up" /></button>
              <button className="btn ghost sm" onClick={() => setQ({ ...q, positions: q.positions.filter((_, j) => j !== i) })} title="Entfernen"><Icon name="x" /></button>
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="row" style={{ margin: '8px 0' }}>
        <button className="btn sm" onClick={() => setQ({ ...q, positions: [...q.positions, { text: '', description: '', qty: 1, unit: 'Stk', price: 0, discount: 0, optional: false }] })}><Icon name="plus" /> Position</button>
        {q.intro === undefined && <button className="btn sm ghost" onClick={() => setQ({ ...q, intro: quote?.intro ?? '', outro: quote?.outro ?? '' })}>Einleitung und Schluss bearbeiten</button>}
      </div>
      {q.outro !== undefined && <Field label="Schlusstext"><textarea rows={2} value={q.outro} onChange={(e) => setQ({ ...q, outro: e.target.value })} /></Field>}
      {invoice && <InvoicePanel id={invoice} onClose={() => setInvoice(null)} onOpen={setInvoice} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- Reklamation / Serviceanfrage
export function CaseModal({ item, accountId, onClose, onSaved }: { item?: any; accountId?: string; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const { users } = useSession();
  const { data: projects } = useApi<any[]>('/projects');
  const [c, setC] = useState({
    account: item ? { id: item.accountId, name: item.accountName } : accountId ? { id: accountId, name: '' } : null as { id: string; name: string } | null,
    type: item?.type ?? 'complaint', title: item?.title ?? '', description: item?.description ?? '', priority: item?.priority ?? 'normal', status: item?.status ?? 'open',
    resolution: item?.resolution ?? '', assigneeId: item?.assigneeId ?? '', projectId: item?.projectId ?? '', contactId: item?.contactId ?? '',
  });
  const contacts = useContacts(c.account?.id);
  const save = async () => {
    const body = { type: c.type, title: c.title, description: c.description, priority: c.priority, status: c.status, resolution: c.resolution, assigneeId: c.assigneeId || null, projectId: c.projectId || null, contactId: c.contactId || null };
    if (await act(() => (item ? patch(`/crm/cases/${item.id}`, body) : post('/crm/cases', { ...body, accountId: c.account!.id })), 'Gespeichert')) onSaved();
  };
  return (
    <Modal size="lg" title={item ? `${CASE_TYPE[item.type]} ${item.number}` : 'Neue Reklamation oder Serviceanfrage'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!c.title.trim() || !c.account} onClick={save}>Speichern</button></>}>
      {!item && !accountId && <Field label="Kunde" required><CustomerPicker value={c.account} onChange={(account) => setC({ ...c, account })} /></Field>}
      <div className="grid2">
        <Field label="Titel" required><input autoFocus value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} placeholder="z. B. Lager am Förderband läuft heiß" /></Field>
        <Field label="Art"><select value={c.type} onChange={(e) => setC({ ...c, type: e.target.value })}>{Object.entries(CASE_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Status"><select value={c.status} onChange={(e) => setC({ ...c, status: e.target.value })}>{Object.entries(CASE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Priorität"><select value={c.priority} onChange={(e) => setC({ ...c, priority: e.target.value })}><option value="low">niedrig</option><option value="normal">normal</option><option value="high">hoch</option><option value="urgent">dringend</option></select></Field>
        <Field label="Zuständig"><select value={c.assigneeId} onChange={(e) => setC({ ...c, assigneeId: e.target.value })}><option value="">–</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></Field>
        <Field label="Projekt"><select value={c.projectId} onChange={(e) => setC({ ...c, projectId: e.target.value })}><option value="">–</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></Field>
        <Field label="Gemeldet von"><select value={c.contactId} onChange={(e) => setC({ ...c, contactId: e.target.value })}><option value="">–</option>{contacts.map((x) => <option key={x.id} value={x.id}>{contactName(x)}</option>)}</select></Field>
      </div>
      <Field label="Beschreibung"><textarea rows={4} value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} /></Field>
      <Field label="Lösung / Maßnahmen"><textarea rows={3} value={c.resolution} onChange={(e) => setC({ ...c, resolution: e.target.value })} /></Field>
    </Modal>
  );
}
