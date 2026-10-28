import { useState } from 'react';
import { validIban } from '@aperio/shared';
import { useAdminSettings } from './Settings';
import { Field, useAction } from '../components/ui';

const CHARTS = {
  SKR03: { revenue19: '8400', revenue7: '8300', revenueEu: '8125', revenueExport: '8120', revenueReverse: '8337', revenueSmall: '8195' },
  SKR04: { revenue19: '4400', revenue7: '4300', revenueEu: '4125', revenueExport: '4120', revenueReverse: '4337', revenueSmall: '4185' },
};

/** Einstellungen → Rechnungen: Pflichtangaben, Bank, Versand, Übergabe an die Buchhaltung */
export default function InvoicingSettings() {
  const s = useAdminSettings('invoicing');
  const act = useAction();
  const [open, setOpen] = useState(false);
  if (!s.value) return null;
  const v = s.value;
  const set = (k: string) => (e: { target: { value: string } }) => s.setValue({ ...v, [k]: e.target.value });
  const dset = (k: string) => (e: { target: { value: string } }) => s.setValue({ ...v, datev: { ...v.datev, [k]: e.target.value } });
  const ibanBad = v.iban && !validIban(v.iban);
  return (
    <div style={{ maxWidth: 860 }}>
      <h1>Rechnungen</h1>
      <p className="muted">Diese Angaben erscheinen auf jeder Rechnung und in der E-Rechnung (ZUGFeRD/XRechnung). Fehlt etwas Vorgeschriebenes, sagt AperioPlan beim Festschreiben Bescheid.</p>
      <h2 style={{ margin: '18px 0 8px' }}>Firma</h2>
      <div className="grid2">
        <Field label="Firmenname laut Handelsregister"><input value={v.legalName} onChange={set('legalName')} placeholder="z. B. Muster Maschinenbau GmbH" /></Field>
        <Field label="Geschäftsführung"><input value={v.managingDirector} onChange={set('managingDirector')} /></Field>
        <Field label="Straße und Hausnummer"><input value={v.street} onChange={set('street')} /></Field>
        <div className="grid2" style={{ gap: 8, gridTemplateColumns: '90px 1fr 70px' }}>
          <Field label="PLZ"><input value={v.zip} onChange={set('zip')} /></Field>
          <Field label="Ort"><input value={v.city} onChange={set('city')} /></Field>
          <Field label="Land"><input value={v.countryCode} onChange={set('countryCode')} maxLength={2} /></Field>
        </div>
        <Field label="Umsatzsteuer-ID" hint="z. B. DE123456789"><input value={v.vatId} onChange={set('vatId')} /></Field>
        <Field label="Steuernummer"><input value={v.taxNumber} onChange={set('taxNumber')} /></Field>
        <Field label="Handelsregister" hint="z. B. HRB 123456, Amtsgericht Freiburg"><input value={v.registry} onChange={set('registry')} /></Field>
        <Field label="Kleinunternehmer (§ 19 UStG)"><select value={v.smallBusiness ? '1' : ''} onChange={(e) => s.setValue({ ...v, smallBusiness: Boolean(e.target.value) })}><option value="">nein</option><option value="1">ja – ohne Umsatzsteuer</option></select></Field>
      </div>
      <h2 style={{ margin: '18px 0 8px' }}>Ansprechpartner für Rechnungen</h2>
      <div className="grid3">
        <Field label="Name"><input value={v.contactName} onChange={set('contactName')} /></Field>
        <Field label="Telefon"><input value={v.contactPhone} onChange={set('contactPhone')} /></Field>
        <Field label="E-Mail" hint="auch Absender-Adresse der E-Rechnung"><input type="email" value={v.contactEmail} onChange={set('contactEmail')} /></Field>
      </div>
      <h2 style={{ margin: '18px 0 8px' }}>Bank und Zahlung</h2>
      <div className="grid3">
        <Field label="IBAN" hint={ibanBad ? 'Prüfziffer stimmt nicht' : undefined}><input className="mono" value={v.iban} onChange={set('iban')} style={ibanBad ? { borderColor: 'var(--red)' } : undefined} /></Field>
        <Field label="BIC"><input className="mono" value={v.bic} onChange={set('bic')} /></Field>
        <Field label="Bank"><input value={v.bankName} onChange={set('bankName')} /></Field>
        <Field label="Zahlungsziel (Tage)"><input type="number" min={0} value={v.dueDays} onChange={(e) => s.setValue({ ...v, dueDays: Number(e.target.value) })} /></Field>
        <Field label="Skonto (%)" hint="leer = kein Skonto"><input type="number" min={0} step="0.5" value={v.skonto?.percent ?? ''} onChange={(e) => s.setValue({ ...v, skonto: e.target.value ? { percent: Number(e.target.value), days: v.skonto?.days ?? 7 } : null })} /></Field>
        {v.skonto && <Field label="Skonto innerhalb (Tage)"><input type="number" min={1} value={v.skonto.days} onChange={(e) => s.setValue({ ...v, skonto: { ...v.skonto, days: Number(e.target.value) } })} /></Field>}
        <Field label="Standard-Format"><select value={v.defaultFormat} onChange={set('defaultFormat')}><option value="zugferd">ZUGFeRD (PDF mit E-Rechnung) – empfohlen</option><option value="xrechnung">XRechnung (nur XML)</option><option value="pdf">nur PDF</option></select></Field>
      </div>
      <h2 style={{ margin: '18px 0 8px' }}>E-Mail an Kunden</h2>
      <Field label="Betreff" hint="Platzhalter: {nummer}, {betrag}, {faellig}, {firma}, {kunde}"><input value={v.mailSubject} onChange={set('mailSubject')} /></Field>
      <Field label="Text"><textarea rows={5} value={v.mailText} onChange={set('mailText')} /></Field>
      <h2 style={{ margin: '18px 0 8px' }}>Übergabe an die Buchhaltung</h2>
      <div className="grid3">
        <Field label="E-Mail Buchhaltung / Steuerberater"><input type="email" value={v.accountingEmail} onChange={set('accountingEmail')} /></Field>
        <Field label="DATEV Beraternummer"><input value={v.datev.consultantNo} onChange={dset('consultantNo')} /></Field>
        <Field label="DATEV Mandantennummer"><input value={v.datev.clientNo} onChange={dset('clientNo')} /></Field>
        <Field label="Kontenrahmen"><select value={v.datev.chart} onChange={(e) => s.setValue({ ...v, datev: { ...v.datev, chart: e.target.value, ...CHARTS[e.target.value as 'SKR03'] } })}><option>SKR03</option><option>SKR04</option></select></Field>
        <Field label="Sachkontenlänge"><input type="number" min={4} max={8} value={v.datev.accountLength} onChange={(e) => s.setValue({ ...v, datev: { ...v.datev, accountLength: Number(e.target.value) } })} /></Field>
        <Field label="Erste Debitorennummer"><input type="number" value={v.datev.firstDebtor} onChange={(e) => s.setValue({ ...v, datev: { ...v.datev, firstDebtor: Number(e.target.value) } })} /></Field>
      </div>
      <button className="link small" onClick={() => setOpen(!open)}>{open ? 'Erlöskonten ausblenden' : 'Erlöskonten anpassen …'}</button>
      {open && <div className="grid3" style={{ marginTop: 8 }}>
        <Field label="Erlöse 19 %"><input value={v.datev.revenue19} onChange={dset('revenue19')} /></Field>
        <Field label="Erlöse 7 %"><input value={v.datev.revenue7} onChange={dset('revenue7')} /></Field>
        <Field label="Innergemeinschaftlich"><input value={v.datev.revenueEu} onChange={dset('revenueEu')} /></Field>
        <Field label="Ausfuhr"><input value={v.datev.revenueExport} onChange={dset('revenueExport')} /></Field>
        <Field label="§ 13b (Reverse Charge)"><input value={v.datev.revenueReverse} onChange={dset('revenueReverse')} /></Field>
        <Field label="Kleinunternehmer"><input value={v.datev.revenueSmall} onChange={dset('revenueSmall')} /></Field>
      </div>}
      <p className="hint">Die Kontenvorschläge entsprechen dem gewählten Kontenrahmen. Bitte im Zweifel mit dem Steuerberater abstimmen.</p>
      <button className="btn primary" style={{ marginTop: 10 }} onClick={() => act(() => s.save(v), 'Gespeichert')}>Speichern</button>
    </div>
  );
}
