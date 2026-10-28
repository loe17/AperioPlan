import { useEffect, useMemo, useRef, useState } from 'react';
import { get, patch, post } from '../lib/api';
import { useCan } from '../session';
import { Field, Modal, useAction } from '../components/ui';
import { Icon } from '../components/Icon';

export interface CrmAccount {
  id: string; number: string; kind: 'customer' | 'supplier' | 'both'; status: 'prospect' | 'customer' | 'former'; name: string; street: string; zip: string; city: string;
  country: string; industry: string; paymentTerms: string; website: string; phone: string; email: string; vatId: string; leitwegId?: string; invoiceEmail?: string; eInvoice?: 'zugferd' | 'xrechnung' | 'pdf' | null; ownerId: string | null; ownerName?: string | null;
  notes: string; custom: Record<string, unknown>; lastContactAt: string | null; contactCount?: number; openOpportunities?: number; projectCount?: number;
  primaryContact?: { name: string; email: string; phone: string } | null;
}
export interface CrmContact {
  id: string; accountId: string; salutation: string; firstName: string; lastName: string; position: string; department: string; phone: string; mobile: string;
  email: string; birthday: string | null; preferredChannel: string; isPrimary: boolean; notes: string;
}

export const ACCOUNT_STATUS: Record<string, { label: string; tone: string }> = { prospect: { label: 'Interessent', tone: 'blue' }, customer: { label: 'Kunde', tone: 'green' }, former: { label: 'ehemalig', tone: '' } };
export const ACCOUNT_KIND: Record<string, string> = { customer: 'Kunde', supplier: 'Lieferant', both: 'Kunde und Lieferant' };
export const STAGES: { id: string; label: string; tone: string }[] = [
  { id: 'request', label: 'Anfrage', tone: 'blue' }, { id: 'offer', label: 'Angebot', tone: 'amber' }, { id: 'negotiation', label: 'Verhandlung', tone: 'amber' },
  { id: 'won', label: 'Gewonnen', tone: 'green' }, { id: 'lost', label: 'Verloren', tone: 'red' },
];
export const QUOTE_STATUS: Record<string, { label: string; tone: string }> = { draft: { label: 'Entwurf', tone: '' }, sent: { label: 'Versendet', tone: 'blue' }, accepted: { label: 'Angenommen', tone: 'green' }, rejected: { label: 'Abgelehnt', tone: 'red' } };
export const CASE_STATUS: Record<string, { label: string; tone: string }> = { open: { label: 'Offen', tone: 'red' }, in_progress: { label: 'In Bearbeitung', tone: 'amber' }, waiting: { label: 'Wartet', tone: 'blue' }, closed: { label: 'Erledigt', tone: 'green' } };
export const CASE_TYPE: Record<string, string> = { complaint: 'Reklamation', service: 'Serviceanfrage', question: 'Frage' };
export const contactName = (c: Pick<CrmContact, 'firstName' | 'lastName'>) => `${c.firstName} ${c.lastName}`.trim();

/** Kunde aus dem CRM wählen (mit Suche); „Kunde fehlt? Im CRM anlegen“ öffnet das Formular */
export function CustomerPicker({ value, onChange, kind = 'customer', placeholder = 'Kunde suchen …' }: {
  value: { id: string; name: string; number?: string } | null; onChange: (a: { id: string; name: string; number: string } | null) => void;
  kind?: 'customer' | 'supplier'; placeholder?: string;
}) {
  const can = useCan();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CrmAccount[]>([]);
  const [create, setCreate] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!open || !can('crm')) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { get<CrmAccount[]>(`/crm/accounts?kind=${kind}&limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setList).catch(() => setList([])); }, 150);
  }, [q, open, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (value) return (
    <div className="picker-value">
      <Icon name="building" /> <span className="grow">{value.number && <span className="mono muted small">{value.number} </span>}{value.name}</span>
      <button type="button" className="btn ghost sm" title="Entfernen" onClick={() => onChange(null)}><Icon name="x" /></button>
    </div>
  );
  const label = kind === 'supplier' ? 'Lieferant' : 'Kunde';
  return (
    <div className="picker" style={{ position: 'relative' }}>
      <input value={q} placeholder={placeholder} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 200)} />
      {open && (
        <div className="dropdown-menu" style={{ left: 0, right: 0, maxHeight: 280, overflowY: 'auto' }}>
          {!can('crm') ? <div className="item muted">Bitte den Vertrieb bitten, den {label}n anzulegen</div> : <>
            {list.map((a) => <div key={a.id} className="item" onMouseDown={(e) => { e.preventDefault(); onChange({ id: a.id, name: a.name, number: a.number }); setQ(''); setOpen(false); }}>
              <span className="mono muted small">{a.number}</span> {a.name} {a.city && <span className="muted small">· {a.city}</span>}</div>)}
            {!list.length && <div className="item muted">Kein Treffer</div>}
            <div className="item" style={{ borderTop: '1px solid var(--line)', color: 'var(--accent)' }} onMouseDown={(e) => { e.preventDefault(); setCreate(true); setOpen(false); }}>
              <Icon name="plus" /> {label} fehlt? Im CRM anlegen
            </div>
          </>}
        </div>
      )}
      {create && <AccountModal initial={{ name: q, kind }} onClose={() => setCreate(false)} onSaved={(a) => { setCreate(false); onChange(a); setQ(''); }} />}
    </div>
  );
}

/** Firma im CRM anlegen oder bearbeiten */
export function AccountModal({ initial, onClose, onSaved }: { initial: Partial<CrmAccount>; onClose: () => void; onSaved: (a: { id: string; name: string; number: string }) => void }) {
  const act = useAction();
  const [a, setA] = useState<Partial<CrmAccount> & { contactFirst?: string; contactLast?: string; contactEmail?: string }>({ kind: 'customer', status: 'customer', country: 'Deutschland', ...initial });
  const set = (k: keyof typeof a) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setA({ ...a, [k]: e.target.value });
  const save = async () => {
    const body = { kind: a.kind, status: a.status, name: a.name, street: a.street ?? '', zip: a.zip ?? '', city: a.city ?? '', country: a.country ?? '', industry: a.industry ?? '',
      paymentTerms: a.paymentTerms ?? '', website: a.website ?? '', phone: a.phone ?? '', email: a.email ?? '', vatId: a.vatId ?? '', notes: a.notes ?? '',
      leitwegId: a.leitwegId ?? '', invoiceEmail: a.invoiceEmail ?? '', eInvoice: a.eInvoice || null };
    if (a.id) {
      const r = await act(() => patch(`/crm/accounts/${a.id}`, body), 'Gespeichert');
      if (r !== undefined) onSaved({ id: a.id, name: a.name!, number: a.number! });
      return;
    }
    const r = await act(() => post<{ id: string; number: string; name: string }>('/crm/accounts', body), `${ACCOUNT_KIND[a.kind!]} angelegt`);
    if (!r) return;
    if (a.contactLast?.trim()) await act(() => post(`/crm/accounts/${r.id}/contacts`, { firstName: a.contactFirst ?? '', lastName: a.contactLast!, email: a.contactEmail ?? '' }));
    onSaved(r);
  };
  return (
    <Modal size="lg" title={a.id ? `${a.number} ${a.name}` : `Neuer ${ACCOUNT_KIND[a.kind ?? 'customer']}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!a.name?.trim()} onClick={save}>{a.id ? 'Speichern' : 'Anlegen'}</button></>}>
      <div className="grid2">
        <Field label="Firmenname" required><input autoFocus value={a.name ?? ''} onChange={set('name')} placeholder="z. B. Muster Maschinenbau GmbH" /></Field>
        <div className="grid2" style={{ gap: 8 }}>
          <Field label="Art"><select value={a.kind} onChange={set('kind')}>{Object.entries(ACCOUNT_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Status"><select value={a.status} onChange={set('status')}>{Object.entries(ACCOUNT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        </div>
        <Field label="Straße"><input value={a.street ?? ''} onChange={set('street')} /></Field>
        <div className="grid2" style={{ gap: 8, gridTemplateColumns: '90px 1fr' }}>
          <Field label="PLZ"><input value={a.zip ?? ''} onChange={set('zip')} /></Field>
          <Field label="Ort"><input value={a.city ?? ''} onChange={set('city')} /></Field>
        </div>
        <Field label="Land"><input value={a.country ?? ''} onChange={set('country')} /></Field>
        <Field label="Branche"><input value={a.industry ?? ''} onChange={set('industry')} placeholder="z. B. Automobilzulieferer" /></Field>
        <Field label="Telefon"><input value={a.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="E-Mail"><input type="email" value={a.email ?? ''} onChange={set('email')} /></Field>
        <Field label="Webseite"><input value={a.website ?? ''} onChange={set('website')} /></Field>
        <Field label="USt-IdNr."><input value={a.vatId ?? ''} onChange={set('vatId')} /></Field>
        <Field label="Zahlungsbedingungen" hint="leer = Firmen-Standard"><input value={a.paymentTerms ?? ''} onChange={set('paymentTerms')} placeholder="z. B. 14 Tage 2 % Skonto, 30 Tage netto" /></Field>
        {a.kind !== 'supplier' && <>
          <Field label="E-Mail für Rechnungen" hint="leer = allgemeine E-Mail"><input type="email" value={a.invoiceEmail ?? ''} onChange={set('invoiceEmail')} /></Field>
          <Field label="Rechnungsformat" hint="leer = Firmen-Standard"><select value={a.eInvoice ?? ''} onChange={set('eInvoice')}><option value="">Standard</option><option value="zugferd">ZUGFeRD (PDF mit E-Rechnung)</option><option value="xrechnung">XRechnung (Behörden)</option><option value="pdf">nur PDF</option></select></Field>
          <Field label="Leitweg-ID" hint="nur bei öffentlichen Auftraggebern"><input value={a.leitwegId ?? ''} onChange={set('leitwegId')} placeholder="z. B. 04011000-12345-67" /></Field>
        </>}
      </div>
      {!a.id && <>
        <h3 style={{ margin: '8px 0' }}>Ansprechpartner (optional)</h3>
        <div className="grid2" style={{ gridTemplateColumns: '1fr 1fr 1.4fr' }}>
          <Field label="Vorname"><input value={a.contactFirst ?? ''} onChange={set('contactFirst')} /></Field>
          <Field label="Nachname"><input value={a.contactLast ?? ''} onChange={set('contactLast')} /></Field>
          <Field label="E-Mail"><input value={a.contactEmail ?? ''} onChange={set('contactEmail')} /></Field>
        </div>
      </>}
      <Field label="Notizen"><textarea rows={2} value={a.notes ?? ''} onChange={set('notes')} /></Field>
    </Modal>
  );
}

/** Ansprechpartner eines Kunden als Auswahl */
export function useContacts(accountId: string | null | undefined) {
  const [list, setList] = useState<CrmContact[]>([]);
  useEffect(() => { if (!accountId) { setList([]); return; } get<CrmContact[]>(`/crm/contacts?accountId=${accountId}`).then(setList).catch(() => setList([])); }, [accountId]);
  return useMemo(() => list, [list]);
}
