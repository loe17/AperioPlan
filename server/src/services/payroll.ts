/**
 * Lohnabrechnung: Stunden und Zuschläge aus der Zeiterfassung, bisherige Jahreswerte, Lohnzettel als PDF.
 */
import { computePayslip, contributionGroup, DEFAULT_PAY_PROFILE, EMPLOYMENT_GROUPS, type PayLine, type PayProfile, type PayslipResult, type YearToDate } from '@aperio/shared';
import type { AppContext } from '../context';
import { Pdf, eur } from '../lib/pdf';

const TZ = () => process.env.TZ || 'Europe/Berlin';
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface PayEmployee {
  id: string; userId: string | null; personnelNo: string; firstName: string; lastName: string; birthDate: string | null;
  street: string; zip: string; city: string; email: string; iban: string; bic: string; taxId: string; svNumber: string; healthInsurer: string; jobTitle: string;
  entryDate: string | null; exitDate: string | null; payType: 'salary' | 'hourly'; salary: number; hourlyRate: number; weeklyHours: number;
  timeSurcharges: boolean; profile: PayProfile; recurring: PayLine[]; costCenter: string; notes: string; active: boolean;
}

export const employeeCols = (sql: AppContext['sql']) => sql`e.id, e.user_id as "userId", e.personnel_no as "personnelNo", e.first_name as "firstName", e.last_name as "lastName", e.birth_date::text as "birthDate",
  e.street, e.zip, e.city, e.email, e.iban, e.bic, e.tax_id as "taxId", e.sv_number as "svNumber", e.health_insurer as "healthInsurer", e.job_title as "jobTitle",
  e.entry_date::text as "entryDate", e.exit_date::text as "exitDate", e.pay_type as "payType", e.salary::float as salary, e.hourly_rate::float as "hourlyRate", e.weekly_hours::float as "weeklyHours",
  e.time_surcharges as "timeSurcharges", e.profile, e.recurring, e.cost_center as "costCenter", e.notes, e.active`;

export const fullProfile = (p: object | null | undefined): PayProfile => ({ ...DEFAULT_PAY_PROFILE, ...((p ?? {}) as Partial<PayProfile>) });
export const monthRange = (year: number, month: number) => {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`, days: last };
};
/** Stundensatz für Zuschläge: Stundenlohn oder Gehalt je Stunde (Wochenstunden × 13 / 3) */
export const baseHourly = (e: Pick<PayEmployee, 'payType' | 'salary' | 'hourlyRate' | 'weeklyHours'>) =>
  e.payType === 'hourly' ? e.hourlyRate : e.weeklyHours > 0 ? r2(e.salary / ((e.weeklyHours * 13) / 3)) : 0;

/** Gearbeitete Stunden eines Monats aus der Zeiterfassung, aufgeteilt nach Nacht, Sonntag und Feiertag (Ortszeit) */
export async function workedHours(ctx: AppContext, userId: string, year: number, month: number) {
  const { sql } = ctx;
  const { from, to } = monthRange(year, month);
  const start = new Date(`${from}T00:00:00`), end = new Date(`${to}T23:59:59`);
  start.setDate(start.getDate() - 1); end.setDate(end.getDate() + 1);
  const entries = await sql<{ s: Date; e: Date }[]>`select started_at as s, coalesce(ended_at, least(now(), started_at + interval '16 hours')) as e from time_entries
    where user_id = ${userId} and started_at < ${end} and coalesce(ended_at, now()) > ${start}`;
  const breaks = await sql<{ s: Date; e: Date }[]>`select starts_at as s, ends_at as e from time_breaks where user_id = ${userId} and starts_at < ${end} and ends_at > ${start}`;
  const holidays = new Set((await sql<{ day: string }[]>`select day::text as day from holidays where day between ${from} and ${to}`).map((h) => h.day));
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const STEP = 5 * 60000; // 5-Minuten-Raster
  let total = 0, night = 0, sunday = 0, holiday = 0;
  const cache = new Map<number, { day: string; hour: number; sun: boolean }>();
  const local = (t: number) => {
    const key = Math.floor(t / 3600000);
    let v = cache.get(key);
    if (!v) {
      const parts = Object.fromEntries(fmt.formatToParts(new Date(key * 3600000 + 1)).map((p) => [p.type, p.value]));
      v = { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, sun: parts.weekday === 'Sun' };
      cache.set(key, v);
    }
    return v;
  };
  for (const en of entries) {
    for (let t = en.s.getTime(); t < en.e.getTime(); t += STEP) {
      const mid = t + STEP / 2;
      if (breaks.some((b) => mid >= b.s.getTime() && mid < b.e.getTime())) continue;
      const l = local(mid);
      if (l.day < from || l.day > to) continue;
      const len = Math.min(STEP, en.e.getTime() - t) / 3600000;
      total += len;
      if (holidays.has(l.day)) holiday += len;
      else if (l.sun) sunday += len;
      if (l.hour >= 20 || l.hour < 6) night += len;
    }
  }
  const h = (x: number) => Math.round(x * 100) / 100;
  return { total: h(total), night: h(night), sunday: h(sunday), holiday: h(holiday) };
}

/** Bisherige Werte im Kalenderjahr aus festgeschriebenen Abrechnungen */
export async function yearToDate(ctx: AppContext, employeeId: string, year: number, month: number): Promise<YearToDate> {
  const rows = await ctx.sql<{ result: PayslipResult; month: number }[]>`select s.result, r.month from pay_slips s join pay_runs r on r.id = s.run_id
    where s.employee_id = ${employeeId} and r.year = ${year} and r.month < ${month} and r.status = 'final'`;
  const ytd: YearToDate = { taxableRegular: 0, taxableOneOff: 0, svKv: 0, svRv: 0, svMonths: 0, estimateMonths: 0 };
  for (const { result: r } of rows) {
    ytd.taxableRegular += r.taxRegular; ytd.taxableOneOff += r.taxOneOff; ytd.svKv += r.svBaseKv; ytd.svRv += r.svBaseRv;
    if (r.svBase > 0) ytd.svMonths++;
  }
  // Monate dieses Jahres vor dem Eintritt bzw. ohne Abrechnung in AperioPlan (z. B. Umstieg mitten im Jahr): mit dem laufenden Lohn schätzen
  const [e] = await ctx.sql<{ entry: string | null }[]>`select entry_date::text as entry from pay_employees where id = ${employeeId}`;
  const firstMonth = e?.entry && e.entry >= `${year}-01-01` ? Number(e.entry.slice(5, 7)) : 1;
  const covered = new Set(rows.map((x) => x.month));
  for (let m = firstMonth; m < month; m++) if (!covered.has(m)) ytd.estimateMonths!++;
  return ytd;
}

/** Vorschlag der Lohnarten eines Monats: Gehalt bzw. Stunden, Zuschläge aus der Zeiterfassung, wiederkehrende Posten */
export async function suggestLines(ctx: AppContext, e: PayEmployee, year: number, month: number): Promise<PayLine[]> {
  const lines: PayLine[] = [];
  const { from, to, days } = monthRange(year, month);
  // Ein- oder Austritt im Monat: Gehalt anteilig nach Kalendertagen
  const a = e.entryDate && e.entryDate > from ? Number(e.entryDate.slice(8, 10)) : 1;
  const b = e.exitDate && e.exitDate < to ? Number(e.exitDate.slice(8, 10)) : days;
  const share = Math.max(0, b - a + 1) / days;
  const needTime = e.userId && (e.payType === 'hourly' || e.timeSurcharges);
  const hours = needTime ? await workedHours(ctx, e.userId!, year, month) : null;
  if (e.payType === 'salary') {
    lines.push({ kind: 'salary', label: share < 1 ? `Gehalt (anteilig ${Math.round(share * days)}/${days} Tage)` : 'Gehalt', qty: 1, rate: r2(e.salary * share) });
  } else {
    lines.push({ kind: 'hours', label: 'Stundenlohn', qty: hours?.total ?? 0, rate: e.hourlyRate, source: e.userId ? 'Zeiterfassung' : undefined });
  }
  if (e.timeSurcharges && hours) {
    const s = (await ctx.settings.get('payroll')).surcharges;
    const base = baseHourly(e);
    if (hours.night && s.night) lines.push({ kind: 'surcharge', label: `Nachtzuschlag ${s.night} %`, qty: hours.night, rate: base, percent: s.night, source: 'Zeiterfassung' });
    if (hours.sunday && s.sunday) lines.push({ kind: 'surcharge', label: `Sonntagszuschlag ${s.sunday} %`, qty: hours.sunday, rate: base, percent: s.sunday, source: 'Zeiterfassung' });
    if (hours.holiday && s.holiday) lines.push({ kind: 'surcharge', label: `Feiertagszuschlag ${s.holiday} %`, qty: hours.holiday, rate: base, percent: s.holiday, source: 'Zeiterfassung' });
  }
  for (const r of e.recurring ?? []) lines.push({ ...r });
  return lines;
}

export async function calcSlip(ctx: AppContext, employeeId: string, year: number, month: number, profile: PayProfile, lines: PayLine[]) {
  const ytd = await yearToDate(ctx, employeeId, year, month);
  return computePayslip(year, month, profile, lines, ytd);
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monthName = (m: number) => MONTHS[m - 1]!;
const TAX_CLASS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

/** Lohnzettel (Entgeltabrechnung) als PDF */
export async function payslipPdf(ctx: AppContext, e: PayEmployee, profile: PayProfile, res: PayslipResult): Promise<Buffer> {
  const inv = await ctx.settings.get('invoicing');
  const company = await ctx.settings.get('company');
  const pay = await ctx.settings.get('payroll');
  const firm = inv.legalName || company.name;
  const pdf = new Pdf(`Entgeltabrechnung ${monthName(res.month)} ${res.year}`, firm);
  const L = pdf.margin;
  pdf.text(L, pdf.y, firm, { size: 13, bold: true });
  pdf.text(L, pdf.y + 16, [inv.street, `${inv.zip} ${inv.city}`].filter((x) => x.trim()).join(' · '), { size: 7, color: '#6b7280' });
  pdf.text(330, pdf.y, `Entgeltabrechnung ${monthName(res.month)} ${res.year}`, { size: 12, bold: true });
  pdf.y += 50;
  const addr = [`${e.firstName} ${e.lastName}`, e.street, `${e.zip} ${e.city}`].filter((x) => x.trim());
  const y0 = pdf.y;
  for (const l of addr) { pdf.text(L, pdf.y, l, { size: 10 }); pdf.y += 13; }
  const meta: [string, string][] = [['Personal-Nr.', e.personnelNo], ['Steuer-ID', e.taxId || '–'], ['Steuerklasse', `${TAX_CLASS[profile.taxClass]}${profile.childAllowances ? ` / Kinderfreibeträge ${profile.childAllowances}` : ''}${profile.factor ? ` / Faktor ${profile.factor}` : ''}`],
    ['Konfession', profile.church ? `kirchensteuerpflichtig (${['BW', 'BY'].includes(profile.state) ? 8 : 9} %)` : '–'], ['SV-Nummer', e.svNumber || '–'], ['Krankenkasse', profile.insurance === 'pkv' ? 'privat versichert' : `${e.healthInsurer || '–'} (Zusatzbeitrag ${profile.kvZusatz} %)`],
    ['Beitragsgruppe', `${contributionGroup(profile)} · Personengruppe ${EMPLOYMENT_GROUPS[profile.group].pgr}`]];
  let my = y0;
  for (const [k, v] of meta) { pdf.text(330, my, k, { size: 8, color: '#6b7280' }); pdf.text(410, my, v, { size: 8 }); my += 11; }
  pdf.y = Math.max(pdf.y, my) + 18;
  const num = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  pdf.paragraph('Bezüge', { bold: true, size: 11, gap: 4 });
  pdf.table([{ label: 'Lohnart', width: 195 }, { label: 'Menge', width: 55, align: 'right' }, { label: 'Satz', width: 65, align: 'right' }, { label: 'steuerpfl.', width: 60, align: 'right' }, { label: 'SV-pfl.', width: 60, align: 'right' }, { label: 'Betrag', width: 60, align: 'right' }],
    [...res.lines.filter((l) => l.kind !== 'deduction' && l.kind !== 'taxfree').map((l) => [l.label + (l.kind === 'bonus' ? ' (einmalig)' : l.kind === 'benefit' ? ' (Sachbezug)' : ''),
      l.qty !== 1 ? num(l.qty) : '', l.qty !== 1 || l.kind === 'surcharge' ? `${num(l.rate)}${l.percent ? ` × ${l.percent} %` : ''}` : '', num(l.taxable), num(l.svable), num(l.amount)]),
    [{ text: 'Gesamtbrutto', bold: true }, '', '', num(r2(res.taxRegular + res.taxOneOff)), num(res.svBase), { text: num(res.gross), bold: true }]]);
  pdf.paragraph('Gesetzliche Abzüge', { bold: true, size: 11, gap: 4 });
  const rows: (string | { text: string; bold?: boolean })[][] = [];
  if (res.tax.lst) rows.push(['Lohnsteuer', num(res.tax.lst)]);
  if (res.tax.soli) rows.push(['Solidaritätszuschlag', num(res.tax.soli)]);
  if (res.tax.church) rows.push(['Kirchensteuer', num(res.tax.church)]);
  if (res.an.kv) rows.push(['Krankenversicherung', num(res.an.kv)]);
  if (res.an.pv) rows.push(['Pflegeversicherung', num(res.an.pv)]);
  if (res.an.rv) rows.push(['Rentenversicherung', num(res.an.rv)]);
  if (res.an.av) rows.push(['Arbeitslosenversicherung', num(res.an.av)]);
  const legal = r2(res.tax.lst + res.tax.soli + res.tax.church + res.an.total);
  rows.push([{ text: 'Summe gesetzliche Abzüge', bold: true }, { text: num(legal), bold: true }], [{ text: 'Nettoverdienst', bold: true }, { text: num(res.net), bold: true }]);
  pdf.table([{ label: '', width: 435 }, { label: 'Betrag', width: 60, align: 'right' }], rows);
  const extra = res.lines.filter((l) => ['benefit', 'taxfree', 'deduction'].includes(l.kind));
  if (extra.length || res.pkvSubsidy) {
    pdf.paragraph('Be- und Abzüge vom Netto', { bold: true, size: 11, gap: 4 });
    pdf.table([{ label: '', width: 435 }, { label: 'Betrag', width: 60, align: 'right' }], [
      ...extra.map((l) => [l.kind === 'benefit' ? `${l.label} (bereits im Brutto, keine Auszahlung)` : l.label, num(l.kind === 'taxfree' ? l.amount : -l.amount)]),
      ...(res.pkvSubsidy ? [['Zuschuss private Kranken- und Pflegeversicherung (steuerfrei)', num(res.pkvSubsidy)]] : []),
    ]);
  }
  pdf.ensure(60);
  pdf.rect(L, pdf.y, pdf.width - 2 * L, 30, '#eef2ff');
  pdf.text(L + 10, pdf.y + 10, `Auszahlungsbetrag${e.iban ? ` auf IBAN ${e.iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()}` : ''}`, { size: 10, bold: true });
  pdf.text(L, pdf.y + 9, eur(res.payout), { size: 12, bold: true, align: 'right', width: pdf.width - 2 * L - 10 });
  pdf.y += 44;
  pdf.paragraph('Arbeitgeberanteile (zur Information)', { bold: true, size: 9, gap: 2 });
  pdf.paragraph([`KV ${num(res.ag.kv)}`, `PV ${num(res.ag.pv)}`, `RV ${num(res.ag.rv)}`, `AV ${num(res.ag.av)}`, `Umlagen U1 ${num(res.ag.u1)} / U2 ${num(res.ag.u2)} / Insolvenzgeld ${num(res.ag.insolvency)}`,
    ...(res.tax.flat ? [`Pauschsteuer ${num(res.tax.flat)}`] : [])].join(' · '), { size: 8, color: '#374151', gap: 8 });
  for (const n of res.notes) pdf.paragraph(n, { size: 8, color: '#6b7280', gap: 2 });
  pdf.footer((p, n) => `${firm}${pay.companyNo ? ` · Betriebsnummer ${pay.companyNo}` : ''} · erstellt mit AperioPlan · Seite ${p} von ${n}`);
  return pdf.toBuffer();
}
