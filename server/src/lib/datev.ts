/**
 * DATEV-Format (EXTF, Buchungsstapel, Formatversion 700/13) für die Übergabe an den Steuerberater.
 * Zeichensatz Windows-1252, Trennzeichen Semikolon, Dezimalkomma.
 */

/** Spaltenüberschriften des Buchungsstapels (125 Felder, Reihenfolge laut DATEV-Formatbeschreibung) */
const COLUMNS = 'Umsatz (ohne Soll/Haben-Kz);Soll/Haben-Kennzeichen;WKZ Umsatz;Kurs;Basisumsatz;WKZ Basisumsatz;Konto;Gegenkonto (ohne BU-Schlüssel);BU-Schlüssel;Belegdatum;Belegfeld 1;Belegfeld 2;Skonto;Buchungstext;Postensperre;Diverse Adressnummer;Geschäftspartnerbank;Sachverhalt;Zinssperre;Beleglink;Beleginfo – Art 1;Beleginfo – Inhalt 1;Beleginfo – Art 2;Beleginfo – Inhalt 2;Beleginfo – Art 3;Beleginfo – Inhalt 3;Beleginfo – Art 4;Beleginfo – Inhalt 4;Beleginfo – Art 5;Beleginfo – Inhalt 5;Beleginfo – Art 6;Beleginfo – Inhalt 6;Beleginfo – Art 7;Beleginfo – Inhalt 7;Beleginfo – Art 8;Beleginfo – Inhalt 8;KOST1 – Kostenstelle;KOST2 – Kostenstelle;Kost Menge;EU-Land u. USt-IdNr.;EU-Steuersatz;Abw. Versteuerungsart;Sachverhalt L+L;Funktionsergänzung L+L;BU 49 Hauptfunktionstyp;BU 49 Hauptfunktionsnummer;BU 49 Funktionsergänzung;Zusatzinformation – Art 1;Zusatzinformation – Inhalt 1;Zusatzinformation – Art 2;Zusatzinformation – Inhalt 2;Zusatzinformation – Art 3;Zusatzinformation – Inhalt 3;Zusatzinformation – Art 4;Zusatzinformation – Inhalt 4;Zusatzinformation – Art 5;Zusatzinformation – Inhalt 5;Zusatzinformation – Art 6;Zusatzinformation – Inhalt 6;Zusatzinformation – Art 7;Zusatzinformation – Inhalt 7;Zusatzinformation – Art 8;Zusatzinformation – Inhalt 8;Zusatzinformation – Art 9;Zusatzinformation – Inhalt 9;Zusatzinformation – Art 10;Zusatzinformation – Inhalt 10;Zusatzinformation – Art 11;Zusatzinformation – Inhalt 11;Zusatzinformation – Art 12;Zusatzinformation – Inhalt 12;Zusatzinformation – Art 13;Zusatzinformation – Inhalt 13;Zusatzinformation – Art 14;Zusatzinformation – Inhalt 14;Zusatzinformation – Art 15;Zusatzinformation – Inhalt 15;Zusatzinformation – Art 16;Zusatzinformation – Inhalt 16;Zusatzinformation – Art 17;Zusatzinformation – Inhalt 17;Zusatzinformation – Art 18;Zusatzinformation – Inhalt 18;Zusatzinformation – Art 19;Zusatzinformation – Inhalt 19;Zusatzinformation – Art 20;Zusatzinformation – Inhalt 20;Stück;Gewicht;Zahlweise;Forderungsart;Veranlagungsjahr;Zugeordnete Fälligkeit;Skontotyp;Auftragsnummer;Buchungstyp;USt-Schlüssel (Anzahlungen);EU-Mitgliedstaat (Anzahlungen);Sachverhalt L+L (Anzahlungen);EU-Steuersatz (Anzahlungen);Erlöskonto (Anzahlungen);Herkunft-Kz;Leerfeld;KOST-Datum;SEPA-Mandatsreferenz;Skontosperre;Gesellschaftername;Beteiligtennummer;Identifikationsnummer;Zeichnernummer;Postensperre bis;Bezeichnung;Kennzeichen;Festschreibung;Leistungsdatum;Datum Zuord.;Fälligkeit;Generalumkehr;Steuersatz;Land;Abrechnungsreferent;BVV-Position;EU-Mitgliedstaat u. UStID (Ursprung);EU-Steuersatz (Ursprung);Abw. Skontokonto'.split(';');

export interface DatevBooking {
  amount: number; side: 'S' | 'H'; account: string; contra: string; buKey?: string;
  date: string; docNo: string; docNo2?: string; text: string; cost1?: string; euVatId?: string; serviceDate?: string;
}

const WIN: Record<string, number> = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
export function cp1252(s: string): Buffer {
  const out: number[] = [];
  for (const ch of s) { const c = WIN[ch] ?? ch.charCodeAt(0); out.push(c > 255 ? 63 : c); }
  return Buffer.from(out);
}

const q = (s: string | undefined | null) => (s ? `"${String(s).replace(/"/g, '""')}"` : '');
const money = (n: number) => n.toFixed(2).replace('.', ',');
const ddmm = (d: string) => `${d.slice(8, 10)}${d.slice(5, 7)}`;
const ymd = (d: string) => d.slice(0, 10).replace(/-/g, '');

export function datevExtf(o: { consultantNo: string; clientNo: string; fiscalYearStart: string; accountLength: number; from: string; to: string; title: string; bookings: DatevBooking[] }): Buffer {
  const created = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const head = ['"EXTF"', '700', '21', '"Buchungsstapel"', '13', created, '', '"AP"', '"AperioPlan"', '', o.consultantNo || '', o.clientNo || '', ymd(o.fiscalYearStart), String(o.accountLength),
    ymd(o.from), ymd(o.to), q(o.title.slice(0, 30)), '', '1', '', '0', '"EUR"', '', '', '', '', '', '', '', '', ''].join(';');
  const leistung = COLUMNS.indexOf('Leistungsdatum');
  const rows = o.bookings.map((b) => {
    const f: string[] = new Array(COLUMNS.length).fill('');
    f[0] = money(Math.abs(b.amount)); f[1] = q(b.side); f[2] = q('EUR'); f[6] = b.account; f[7] = b.contra; f[8] = b.buKey ? q(b.buKey) : '';
    f[9] = ddmm(b.date); f[10] = q(b.docNo.slice(0, 36)); f[11] = q(b.docNo2?.slice(0, 12)); f[13] = q(b.text.slice(0, 60));
    if (b.cost1) f[36] = q(b.cost1.slice(0, 36));
    if (b.euVatId) f[39] = q(b.euVatId);
    if (b.serviceDate && leistung >= 0) f[leistung] = ymd(b.serviceDate).replace(/^(\d{4})(\d{2})(\d{2})$/, '$3$2$1');
    return f.join(';');
  });
  return cp1252([head, COLUMNS.join(';'), ...rows].join('\r\n') + '\r\n');
}
