/**
 * Bank: Kontoauszüge einlesen (CAMT.053/.052 als XML, CSV der gängigen Banken), Zahlungen den offenen
 * Rechnungen zuordnen und Überweisungen als SEPA-Datei (pain.001.001.09) für das Online-Banking erzeugen.
 */
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { parseCsv } from '../lib/xlsx';

export interface BankTx { date: string; valueDate: string | null; amount: number; counterparty: string; counterIban: string; purpose: string; reference: string; hash: string }

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: true,
  isArray: (n) => ['Stmt', 'Rpt', 'Ntry', 'TxDtls', 'Ustrd'].includes(n) });
const t = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v));
const hashOf = (...parts: (string | number)[]) => createHash('sha1').update(parts.join('|')).digest('hex');

/** CAMT.053 (Tagesauszug) oder CAMT.052 (Umsatzbericht) */
export function parseCamt(xml: string): { iban: string; tx: BankTx[] } {
  const doc = parser.parse(xml)?.Document;
  const statements = (doc?.BkToCstmrStmt?.Stmt ?? doc?.BkToCstmrAcctRpt?.Rpt ?? []) as any[];
  if (!statements.length) throw new Error('Keine CAMT-Datei (Kontoauszug im XML-Format) erkannt.');
  let iban = '';
  const tx: BankTx[] = [];
  for (const st of statements) {
    iban ||= t(st.Acct?.Id?.IBAN);
    for (const n of (st.Ntry ?? []) as any[]) {
      const sign = t(n.CdtDbtInd) === 'DBIT' ? -1 : 1;
      const total = Number(t(n.Amt)) * sign;
      const date = t(n.BookgDt?.Dt) || t(n.BookgDt?.DtTm).slice(0, 10);
      const valueDate = t(n.ValDt?.Dt) || null;
      const details = ((n.NtryDtls ?? {}).TxDtls ?? [{}]) as any[];
      // Sammelbuchungen mit mehreren Einzelposten aufteilen, sonst die Buchung als Ganzes
      const parts = details.length > 1 ? details : [details[0] ?? {}];
      parts.forEach((d, i) => {
        const amount = parts.length > 1 && d.Amt ? Number(t(d.Amt)) * sign : total;
        const rp = d.RltdPties ?? {};
        const party = sign > 0 ? (rp.Dbtr?.Pty ?? rp.Dbtr ?? rp.UltmtDbtr) : (rp.Cdtr?.Pty ?? rp.Cdtr ?? rp.UltmtCdtr);
        const acct = sign > 0 ? rp.DbtrAcct : rp.CdtrAcct;
        const purpose = ((d.RmtInf?.Ustrd ?? []) as unknown[]).map(t).join(' ').replace(/\s+/g, ' ').trim() || t(n.AddtlNtryInf);
        const reference = t(d.Refs?.EndToEndId) !== 'NOTPROVIDED' ? t(d.Refs?.EndToEndId) : '';
        tx.push({ date, valueDate, amount: Math.round(amount * 100) / 100, counterparty: t(party?.Nm), counterIban: t(acct?.Id?.IBAN), purpose, reference,
          hash: hashOf(t(n.AcctSvcrRef) || t(n.NtryRef) || '', date, amount, purpose, i) });
      });
    }
  }
  return { iban, tx };
}

const deNum = (s: string) => { const v = s.replace(/\s|€|EUR/g, ''); return Number(v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v); };
const deDate = (s: string) => {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s.trim()) ? s.trim().slice(0, 10) : '';
};

/** CSV-Export einer Bank (Sparkasse, Volksbank, DKB, ING, Commerzbank …) – Spalten werden anhand der Überschrift erkannt */
export function parseBankCsv(buf: Buffer): BankTx[] {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1');
  text = text.replace(/^﻿/, '');
  const rows = parseCsv(text);
  const find = (cells: string[], ...names: RegExp[]) => cells.findIndex((c) => names.some((n) => n.test(c.trim())));
  const hi = rows.findIndex((r) => find(r, /^betrag/i, /^umsatz/i) >= 0 && find(r, /buchungstag|buchungsdatum|^datum|^buchung$/i) >= 0);
  if (hi < 0) throw new Error('Die CSV-Datei hat keine erkennbaren Spalten „Datum“ und „Betrag“.');
  const h = rows[hi]!;
  const c = {
    date: find(h, /buchungstag|buchungsdatum|^datum$|^buchung$/i), value: find(h, /valuta|wertstellung/i), amount: find(h, /^betrag/i, /^umsatz/i),
    party: find(h, /beguenstigter|begünstigter|zahlungspflichtige|zahlungsbeteiligte|auftraggeber|empfänger|empfaenger|name/i),
    iban: find(h, /iban|kontonummer/i), purpose: find(h, /verwendungszweck|buchungstext|vorgang/i), ref: find(h, /referenz|end-to-end/i), sign: find(h, /soll\/haben|^s\/h$/i),
  };
  const out: BankTx[] = [];
  rows.slice(hi + 1).forEach((r, i) => {
    const date = deDate(r[c.date] ?? '');
    if (!date || !r[c.amount]) return;
    let amount = deNum(r[c.amount]!);
    if (c.sign >= 0 && /^s/i.test(r[c.sign] ?? '')) amount = -Math.abs(amount);
    if (!Number.isFinite(amount)) return;
    const purpose = (r[c.purpose] ?? '').replace(/\s+/g, ' ').trim();
    out.push({ date, valueDate: c.value >= 0 ? deDate(r[c.value] ?? '') || null : null, amount: Math.round(amount * 100) / 100, counterparty: (r[c.party] ?? '').trim(),
      counterIban: (r[c.iban] ?? '').replace(/\s+/g, ''), purpose, reference: c.ref >= 0 ? (r[c.ref] ?? '').trim() : '', hash: hashOf(date, amount, purpose, r[c.party] ?? '', i) });
  });
  return out;
}

// ------------------------------------------------ Zuordnung
export interface OpenItem { id: string; number: string; open: number; name: string; iban?: string; skontoPercent?: number }
export interface Match { id: string; score: number; reason: string }
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Bewertet, welche offene Rechnung zu einer Zahlung passt (100 = eindeutig) */
export function rankMatches(tx: Pick<BankTx, 'amount' | 'purpose' | 'counterparty' | 'counterIban' | 'reference'>, items: OpenItem[]): Match[] {
  const amount = Math.abs(tx.amount);
  const text = norm(`${tx.purpose} ${tx.reference}`);
  return items.map((it) => {
    let score = 0; const why: string[] = [];
    const n = norm(it.number);
    if (n.length >= 4 && text.includes(n)) { score += 60; why.push('Rechnungsnummer im Verwendungszweck'); }
    if (Math.abs(amount - it.open) < 0.005) { score += 35; why.push('Betrag stimmt'); }
    else if (it.skontoPercent && Math.abs(amount - Math.round(it.open * (1 - it.skontoPercent / 100) * 100) / 100) < 0.02) { score += 30; why.push('Betrag mit Skonto'); }
    else if (amount < it.open && score >= 60) why.push('Teilzahlung');
    if (it.iban && tx.counterIban && norm(it.iban) === norm(tx.counterIban)) { score += 15; why.push('IBAN bekannt'); }
    const nm = norm(it.name).slice(0, 8);
    if (nm.length >= 4 && norm(tx.counterparty).includes(nm)) { score += 10; why.push('Name passt'); }
    return { id: it.id, score: Math.min(100, score), reason: why.join(', ') };
  }).filter((m) => m.score >= 35).sort((a, b) => b.score - a.score);
}

// ------------------------------------------------ SEPA-Überweisungen
const sepaText = (s: string, max: number) => s.replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/&/g, '+').replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const xe = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function painCreditTransfer(o: { debtorName: string; debtorIban: string; debtorBic?: string; execDate: string; msgId: string;
  payments: { endToEnd: string; name: string; iban: string; bic?: string; amount: number; purpose: string }[] }): string {
  const sum = o.payments.reduce((s, p) => s + Math.round(p.amount * 100), 0) / 100;
  const now = new Date().toISOString().slice(0, 19);
  const tx = o.payments.map((p) => `<CdtTrfTxInf><PmtId><EndToEndId>${xe(sepaText(p.endToEnd, 35))}</EndToEndId></PmtId><Amt><InstdAmt Ccy="EUR">${p.amount.toFixed(2)}</InstdAmt></Amt>`
    + `${p.bic ? `<CdtrAgt><FinInstnId><BICFI>${xe(p.bic.replace(/\s+/g, ''))}</BICFI></FinInstnId></CdtrAgt>` : ''}<Cdtr><Nm>${xe(sepaText(p.name, 70))}</Nm></Cdtr>`
    + `<CdtrAcct><Id><IBAN>${xe(p.iban.replace(/\s+/g, '').toUpperCase())}</IBAN></Id></CdtrAcct><RmtInf><Ustrd>${xe(sepaText(p.purpose, 140))}</Ustrd></RmtInf></CdtTrfTxInf>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><CstmrCdtTrfInitn>`
    + `<GrpHdr><MsgId>${xe(sepaText(o.msgId, 35))}</MsgId><CreDtTm>${now}</CreDtTm><NbOfTxs>${o.payments.length}</NbOfTxs><CtrlSum>${sum.toFixed(2)}</CtrlSum><InitgPty><Nm>${xe(sepaText(o.debtorName, 70))}</Nm></InitgPty></GrpHdr>`
    + `<PmtInf><PmtInfId>${xe(sepaText(`${o.msgId}-1`, 35))}</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>true</BtchBookg><NbOfTxs>${o.payments.length}</NbOfTxs><CtrlSum>${sum.toFixed(2)}</CtrlSum>`
    + `<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf><ReqdExctnDt><Dt>${o.execDate}</Dt></ReqdExctnDt><Dbtr><Nm>${xe(sepaText(o.debtorName, 70))}</Nm></Dbtr>`
    + `<DbtrAcct><Id><IBAN>${xe(o.debtorIban.replace(/\s+/g, '').toUpperCase())}</IBAN></Id></DbtrAcct>`
    + `<DbtrAgt><FinInstnId>${o.debtorBic ? `<BICFI>${xe(o.debtorBic.replace(/\s+/g, ''))}</BICFI>` : '<Othr><Id>NOTPROVIDED</Id></Othr>'}</FinInstnId></DbtrAgt><ChrgBr>SLEV</ChrgBr>`
    + `${tx}</PmtInf></CstmrCdtTrfInitn></Document>\n`;
}
