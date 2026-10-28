/**
 * Rechnungen: Rechenregeln (gleich für PDF, E-Rechnung und Oberfläche) und Bezeichnungen.
 * Gerundet wird wie in der E-Rechnung (EN 16931): Nettopreis je Einheit auf 4 Stellen,
 * Positionsbetrag und Steuer je Steuersatz auf Cent.
 */

export interface InvoicePosition {
  text: string;
  description?: string;
  qty: number;
  unit: string;
  price: number;
  discount?: number;
  /** Umsatzsteuersatz der Position (Standard: Satz der Rechnung) */
  vatRate?: number;
}

export type InvoiceKind = 'invoice' | 'partial' | 'final' | 'credit';
export type TaxMode = 'standard' | 'reverse_charge' | 'intra_eu' | 'export' | 'small_business';
export type EInvoiceFormat = 'zugferd' | 'xrechnung' | 'pdf';

export const INVOICE_KIND: Record<InvoiceKind, string> = { invoice: 'Rechnung', partial: 'Abschlagsrechnung', final: 'Schlussrechnung', credit: 'Stornorechnung' };
export const INVOICE_STATUS: Record<string, string> = { draft: 'Entwurf', open: 'offen', partial: 'teilweise bezahlt', paid: 'bezahlt', cancelled: 'storniert' };
export const E_INVOICE_FORMAT: Record<EInvoiceFormat, string> = { zugferd: 'ZUGFeRD (PDF mit eingebetteter E-Rechnung)', xrechnung: 'XRechnung (nur XML, z. B. für Behörden)', pdf: 'nur PDF' };

/** Steuerart der Rechnung: Kategorie und Pflichtvermerk nach EN 16931 bzw. UStG */
export const TAX_MODES: Record<TaxMode, { label: string; category: string; note: string; reasonCode?: string }> = {
  standard: { label: 'mit Umsatzsteuer', category: 'S', note: '' },
  reverse_charge: { label: 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)', category: 'AE', note: 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG).', reasonCode: 'VATEX-EU-AE' },
  intra_eu: { label: 'Innergemeinschaftliche Lieferung/Leistung', category: 'K', note: 'Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1b UStG) bzw. Leistung, Steuerschuldnerschaft des Leistungsempfängers.', reasonCode: 'VATEX-EU-IC' },
  export: { label: 'Ausfuhr (Drittland)', category: 'G', note: 'Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1a UStG).', reasonCode: 'VATEX-EU-G' },
  small_business: { label: 'Kleinunternehmer (§ 19 UStG)', category: 'E', note: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.' },
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

/** Nettopreis je Einheit nach Rabatt */
export const netUnitPrice = (p: Pick<InvoicePosition, 'price' | 'discount'>) => r4(p.price * (1 - (p.discount ?? 0) / 100));
/** Positionsbetrag netto */
export const positionNet = (p: Pick<InvoicePosition, 'qty' | 'price' | 'discount'>) => r2(p.qty * netUnitPrice(p));

export interface TaxGroup { category: string; rate: number; basis: number; tax: number }
export interface InvoiceTotals { net: number; tax: number; gross: number; groups: TaxGroup[] }

export function invoiceTotals(positions: InvoicePosition[], defaultRate: number, mode: TaxMode = 'standard'): InvoiceTotals {
  const groups = new Map<string, TaxGroup>();
  for (const p of positions) {
    const rate = mode === 'standard' ? p.vatRate ?? defaultRate : 0;
    const category = TAX_MODES[mode].category;
    const key = `${category}:${rate}`;
    const g = groups.get(key) ?? { category, rate, basis: 0, tax: 0 };
    g.basis = r2(g.basis + positionNet(p));
    groups.set(key, g);
  }
  const list = [...groups.values()].map((g) => ({ ...g, tax: r2((g.basis * g.rate) / 100) }));
  const net = r2(list.reduce((s, g) => s + g.basis, 0));
  const tax = r2(list.reduce((s, g) => s + g.tax, 0));
  return { net, tax, gross: r2(net + tax), groups: list };
}

/** Mengeneinheit → UN/ECE-Code (Empfehlung 20/21) für die E-Rechnung */
export function unitCode(unit: string): string {
  const u = unit.trim().toLowerCase().replace(/\.$/, '');
  const map: Record<string, string> = {
    stk: 'H87', stück: 'H87', st: 'H87', pcs: 'H87', x: 'H87',
    h: 'HUR', std: 'HUR', stunde: 'HUR', stunden: 'HUR', min: 'MIN', minute: 'MIN', minuten: 'MIN',
    tag: 'DAY', tage: 'DAY', d: 'DAY', woche: 'WEE', monat: 'MON', monate: 'MON', jahr: 'ANN',
    m: 'MTR', meter: 'MTR', mm: 'MMT', cm: 'CMT', km: 'KMT', 'm²': 'MTK', m2: 'MTK', 'm³': 'MTQ', m3: 'MTQ',
    kg: 'KGM', g: 'GRM', t: 'TNE', l: 'LTR', liter: 'LTR', ml: 'MLT',
    psch: 'LS', pauschal: 'LS', pausch: 'LS', pauschale: 'LS', lfm: 'MTR', satz: 'SET', set: 'SET', paar: 'PR', kwh: 'KWH',
  };
  return map[u] ?? 'C62';
}

/** Fälligkeit: Rechnungsdatum + Zahlungsziel in Tagen */
export function dueDate(invoiceDate: string, days: number): string {
  const d = new Date(`${invoiceDate.slice(0, 10)}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Prüfziffer einer IBAN (ISO 13616) */
export function validIban(iban: string): boolean {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const ch of r) m = (m * 10 + Number(ch)) % 97;
  return m === 1;
}
