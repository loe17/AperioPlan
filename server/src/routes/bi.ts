/**
 * Auswertungen: Berichte aus vorhandenen Daten (Zeiten, Aufgaben, Verkauf, Rechnungen, Tickets, Spesen, Fuhrpark, CO₂)
 * – gruppiert nach Zeitraum, Person, Projekt oder Kategorie, als Balken, Linie, Tabelle oder Kennzahl.
 * Nur fest definierte Datenquellen; jeder sieht nur, was er auch im jeweiligen Werkzeug sehen darf.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import type { Sql } from '../db';
import type { Tool } from '@aperio/shared';
import { visibleProjects } from '../lib/access';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { staffOf, toRow } from '../lib/rows';
import { writeXlsx } from '../lib/xlsx';

type Frag = ReturnType<Sql['unsafe']>;
type Dim = { label: string; expr: (sql: Sql) => Frag };
type Measure = { label: string; unit: string; expr: (sql: Sql) => Frag; decimals?: number };
type Source = {
  id: string; label: string; description: string; tool?: Tool; app?: string;
  from: (sql: Sql) => Frag; date: (sql: Sql) => Frag; dims: Record<string, Dim>; measures: Record<string, Measure>;
  /** Sichtbarkeit: liefert eine SQL-Bedingung (nicht awaiten – Fragmente würden sonst ausgeführt) */
  scope?: (sql: Sql, u: AuthUser, f: { expensesManager: boolean }) => Frag;
};
const TZ = () => process.env.TZ || 'Europe/Berlin';
const d = (label: string, expr: (sql: Sql) => Frag): Dim => ({ label, expr });
const m = (label: string, unit: string, expr: (sql: Sql) => Frag, decimals = 0): Measure => ({ label, unit, expr, decimals });
const WEEKDAYS = `array['So','Mo','Di','Mi','Do','Fr','Sa']`;

const STATUS_LABEL = (col: string, map: Record<string, string>) => (sql: Sql) =>
  sql.unsafe(`case ${col} ${Object.entries(map).map(([k, v]) => `when '${k}' then '${v.replace(/'/g, "''")}'`).join(' ')} else ${col} end`) as Frag;

const SOURCES: Source[] = [
  {
    id: 'time', label: 'Arbeitszeiten', description: 'Erfasste Zeiten aus der Stempeluhr', tool: 'time',
    from: (sql) => sql`time_entries te join users u on u.id = te.user_id left join projects p on p.id = te.project_id`,
    date: (sql) => sql`(te.started_at at time zone ${TZ()})::date`,
    dims: { user: d('Mitarbeiter', (sql) => sql`u.display_name`), project: d('Projekt', (sql) => sql`coalesce(p.number || ' ' || p.name, 'ohne Projekt')`),
      weekday: d('Wochentag', (sql) => sql.unsafe(`(${WEEKDAYS})[extract(dow from te.started_at at time zone '${TZ()}')::int + 1]`) as Frag) },
    measures: { hours: m('Stunden', 'Std.', (sql) => sql`sum(extract(epoch from (coalesce(te.ended_at, now()) - te.started_at)) / 3600)`, 1), entries: m('Buchungen', '', (sql) => sql`count(*)`) },
    scope: (sql, u) => (u.role === 'admin' ? sql`true` : sql`te.user_id = ${u.id}`),
  },
  {
    id: 'tasks', label: 'Aufgaben', description: 'Aufgaben aus allen sichtbaren Projekten',
    from: (sql) => sql`tasks t join projects p on p.id = t.project_id left join users a on a.id = t.assignee_id left join teams tm on tm.id = t.team_id`,
    date: (sql) => sql`(t.created_at at time zone ${TZ()})::date`,
    dims: { status: d('Status', STATUS_LABEL('t.status', { todo: 'offen', in_progress: 'in Arbeit', review: 'Prüfung', done: 'erledigt' })),
      assignee: d('Zuständig', (sql) => sql`coalesce(a.display_name, 'niemand')`), project: d('Projekt', (sql) => sql`p.number || ' ' || p.name`),
      team: d('Abteilung', (sql) => sql`coalesce(tm.name, '–')`), priority: d('Priorität', STATUS_LABEL('t.priority', { low: 'niedrig', normal: 'normal', high: 'hoch', urgent: 'dringend' })) },
    measures: { count: m('Anzahl', '', (sql) => sql`count(*)`), done: m('erledigt', '', (sql) => sql`count(*) filter (where t.status = 'done')`),
      overdue: m('überfällig', '', (sql) => sql`count(*) filter (where t.status <> 'done' and t.due_date < current_date)`), estimate: m('geplante Stunden', 'Std.', (sql) => sql`coalesce(sum(t.estimate_hours), 0)`, 1) },
    scope: (sql, u) => visibleProjects(sql, u) as unknown as Frag,
  },
  {
    id: 'projects', label: 'Projekte', description: 'Projekte nach Status, Kunde und Startjahr',
    from: (sql) => sql`projects p left join teams tm on tm.id = p.team_id`,
    date: (sql) => sql`coalesce(p.start_date, (p.created_at at time zone ${TZ()})::date)`,
    dims: { status: d('Status', STATUS_LABEL('p.status', { planned: 'geplant', active: 'aktiv', paused: 'pausiert', done: 'abgeschlossen', archived: 'archiviert' })),
      customer: d('Kunde', (sql) => sql`coalesce(nullif(p.customer, ''), 'ohne Kunde')`), team: d('Abteilung', (sql) => sql`coalesce(tm.name, '–')`) },
    measures: { count: m('Anzahl', '', (sql) => sql`count(*)`) },
    scope: (sql, u) => sql`p.parent_id is null and ${visibleProjects(sql, u)}`,
  },
  {
    id: 'opportunities', label: 'Verkaufschancen', description: 'Angebote und Aufträge in der Vertriebspipeline', tool: 'crm',
    from: (sql) => sql`crm_opportunities o join crm_accounts a on a.id = o.account_id left join users w on w.id = o.owner_id`,
    date: (sql) => sql`(o.created_at at time zone ${TZ()})::date`,
    dims: { stage: d('Phase', STATUS_LABEL('o.stage', { request: 'Anfrage', offer: 'Angebot', negotiation: 'Verhandlung', won: 'gewonnen', lost: 'verloren' })),
      owner: d('Verantwortlich', (sql) => sql`coalesce(w.display_name, '–')`), customer: d('Kunde', (sql) => sql`a.name`), industry: d('Branche', (sql) => sql`coalesce(nullif(a.industry, ''), '–')`) },
    measures: { value: m('Volumen', '€', (sql) => sql`coalesce(sum(o.value), 0)`, 2), weighted: m('gewichtetes Volumen', '€', (sql) => sql`coalesce(sum(o.value * o.probability / 100.0), 0)`, 2),
      count: m('Anzahl', '', (sql) => sql`count(*)`), winrate: m('Gewinnquote', '%', (sql) => sql`coalesce(100.0 * count(*) filter (where o.stage = 'won') / nullif(count(*) filter (where o.stage in ('won', 'lost')), 0), 0)`, 1) },
  },
  {
    id: 'invoices', label: 'Umsatz (Rechnungen)', description: 'Festgeschriebene Ausgangsrechnungen nach Rechnungsdatum', tool: 'crm',
    from: (sql) => sql`crm_invoices i join crm_accounts a on a.id = i.account_id left join projects p on p.id = i.project_id`,
    date: (sql) => sql`i.invoice_date`,
    dims: { customer: d('Kunde', (sql) => sql`a.name`), project: d('Projekt', (sql) => sql`coalesce(p.number || ' ' || p.name, 'ohne Projekt')`),
      status: d('Zahlungsstand', STATUS_LABEL('i.status', { open: 'offen', partial: 'teilweise bezahlt', paid: 'bezahlt' })) },
    measures: { net: m('Umsatz netto', '€', (sql) => sql`coalesce(sum(case when i.kind = 'credit' then -i.total_net else i.total_net end), 0)`, 2),
      gross: m('Umsatz brutto', '€', (sql) => sql`coalesce(sum(case when i.kind = 'credit' then -i.total_gross else i.total_gross end), 0)`, 2),
      open: m('offene Posten', '€', (sql) => sql`coalesce(sum(i.total_gross - i.paid_amount) filter (where i.status in ('open', 'partial')), 0)`, 2), count: m('Anzahl', '', (sql) => sql`count(*)`) },
    scope: (sql) => sql`i.number is not null and i.status <> 'cancelled' and i.invoice_date is not null`,
  },
  {
    id: 'tickets', label: 'Kundenanfragen', description: 'Tickets aus dem Kundenservice', tool: 'helpdesk', app: 'helpdesk',
    from: (sql) => sql`hd_tickets h left join users a on a.id = h.assignee_id left join crm_accounts c on c.id = h.account_id`,
    date: (sql) => sql`(h.created_at at time zone ${TZ()})::date`,
    dims: { status: d('Status', STATUS_LABEL('h.status', { new: 'neu', open: 'in Arbeit', waiting: 'wartet', solved: 'gelöst', closed: 'geschlossen' })),
      category: d('Kategorie', (sql) => sql`coalesce(nullif(h.category, ''), '–')`), assignee: d('Bearbeiter', (sql) => sql`coalesce(a.display_name, 'niemand')`),
      channel: d('Eingang', STATUS_LABEL('h.channel', { web: 'Formular', email: 'E-Mail', phone: 'Telefon', internal: 'intern' })), customer: d('Kunde', (sql) => sql`coalesce(c.name, '–')`) },
    measures: { count: m('Anzahl', '', (sql) => sql`count(*)`),
      response: m('Ø erste Antwort', 'Std.', (sql) => sql`coalesce(avg(extract(epoch from (h.first_response_at - h.created_at)) / 3600) filter (where h.first_response_at is not null), 0)`, 1),
      rating: m('Ø Bewertung', '★', (sql) => sql`coalesce(avg(h.rating), 0)`, 1) },
  },
  {
    id: 'expenses', label: 'Spesen', description: 'Belege und Kilometer aus Reisekostenabrechnungen (ohne Pauschalen)', tool: 'expenses', app: 'expenses',
    from: (sql) => sql`exp_items x join exp_reports r on r.id = x.report_id join users u on u.id = r.user_id left join projects p on p.id = r.project_id`,
    date: (sql) => sql`x.date`,
    dims: { user: d('Mitarbeiter', (sql) => sql`u.display_name`), category: d('Kategorie', (sql) => sql`coalesce(nullif(x.category, ''), case x.kind when 'mileage' then 'Kilometer' when 'lodging' then 'Übernachtung' when 'travel' then 'Fahrtkosten' else 'Sonstiges' end)`),
      project: d('Projekt', (sql) => sql`coalesce(p.number || ' ' || p.name, 'ohne Projekt')`) },
    measures: { amount: m('Belege', '€', (sql) => sql`coalesce(sum(x.amount) filter (where x.kind <> 'mileage'), 0)`, 2), km: m('Kilometer', 'km', (sql) => sql`coalesce(sum(x.km), 0)`) },
    scope: (sql, u, f) => (u.role === 'admin' || f.expensesManager ? sql`r.status in ('approved', 'paid')` : sql`r.user_id = ${u.id}`),
  },
  {
    id: 'fleet', label: 'Fahrzeugkosten', description: 'Kosten aus dem Fuhrpark', tool: 'fleet', app: 'fleet',
    from: (sql) => sql`fl_entries e join fl_vehicles v on v.id = e.vehicle_id`,
    date: (sql) => sql`e.date`,
    dims: { vehicle: d('Fahrzeug', (sql) => sql`v.plate`), kind: d('Kostenart', STATUS_LABEL('e.kind', { fuel: 'Tanken', charge: 'Laden', service: 'Inspektion', repair: 'Reparatur', tires: 'Reifen', insurance: 'Versicherung', tax: 'Kfz-Steuer', leasing: 'Leasing', other: 'Sonstiges' })) },
    measures: { amount: m('Kosten', '€', (sql) => sql`coalesce(sum(e.amount), 0)`, 2), liters: m('Liter (Tanken)', 'l', (sql) => sql`coalesce(sum(e.liters) filter (where e.kind = 'fuel'), 0)`, 1) },
  },
  {
    id: 'co2', label: 'CO₂-Bilanz', description: 'Emissionen aus der Nachhaltigkeits-App', tool: 'sustainability', app: 'sustainability',
    from: (sql) => sql`sus_entries e join sus_factors f on f.id = e.factor_id left join projects p on p.id = e.project_id`,
    date: (sql) => sql`e.date`,
    dims: { scope: d('Bereich (Scope)', (sql) => sql`'Scope ' || f.scope`), category: d('Kategorie', (sql) => sql`f.category`), source: d('Energieträger', (sql) => sql`f.label`),
      project: d('Projekt', (sql) => sql`coalesce(p.number || ' ' || p.name, 'ohne Projekt')`), site: d('Standort', (sql) => sql`coalesce(nullif(e.site, ''), '–')`) },
    measures: { co2: m('CO₂', 't', (sql) => sql`coalesce(sum(e.quantity * f.kg_per_unit) / 1000, 0)`, 2) },
  },
];
const TIME_DIMS: Record<string, string> = { month: 'Monat', quarter: 'Quartal', year: 'Jahr', week: 'Kalenderwoche', day: 'Tag' };
const timeExpr = (sql: Sql, key: string, date: Frag): Frag =>
  key === 'month' ? sql`to_char(${date}, 'YYYY-MM')` : key === 'quarter' ? sql`to_char(${date}, 'YYYY-"Q"Q')` : key === 'year' ? sql`to_char(${date}, 'YYYY')`
    : key === 'week' ? sql`to_char(${date}, 'IYYY-"KW"IW')` : sql`to_char(${date}, 'YYYY-MM-DD')`;

export const reportDef = z.object({
  source: z.string().max(40), dim: z.string().max(40), dim2: z.string().max(40).nullable().default(null), measure: z.string().max(40),
  period: z.enum(['year', 'lastYear', '12m', 'quarter', 'month', 'all', 'custom']).default('12m'), from: z.string().date().nullable().default(null), to: z.string().date().nullable().default(null),
  chart: z.enum(['bar', 'hbar', 'line', 'table', 'number']).default('bar'), limit: z.number().int().min(1).max(100).default(20),
});
export type ReportDef = z.infer<typeof reportDef>;

function range(p: ReportDef): [string | null, string | null] {
  const now = new Date();
  const y = now.getFullYear();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  if (p.period === 'year') return [`${y}-01-01`, `${y}-12-31`];
  if (p.period === 'lastYear') return [`${y - 1}-01-01`, `${y - 1}-12-31`];
  if (p.period === '12m') return [iso(new Date(Date.UTC(y - 1, now.getMonth() + 1, 1))), iso(new Date(Date.UTC(y, now.getMonth() + 1, 0)))];
  if (p.period === 'quarter') { const q = Math.floor(now.getMonth() / 3); return [iso(new Date(Date.UTC(y, q * 3, 1))), iso(new Date(Date.UTC(y, q * 3 + 3, 0)))]; }
  if (p.period === 'month') return [iso(new Date(Date.UTC(y, now.getMonth(), 1))), iso(new Date(Date.UTC(y, now.getMonth() + 1, 0)))];
  if (p.period === 'custom') return [p.from, p.to];
  return [null, null];
}

export default async function biRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const changed = () => ctx.hub.publish('global', 'bi.changed', {});
  async function available(u: AuthUser) {
    const installed = (await ctx.settings.get('apps')).installed;
    return SOURCES.filter((s) => (!s.tool || (u.tools.includes(s.tool) && (installed as string[]).includes(s.tool))) && (!s.app || (installed as string[]).includes(s.app)));
  }

  app.get('/bi/sources', async (req) => {
    const u = staffOf(req);
    return (await available(u)).map((s) => ({ id: s.id, label: s.label, description: s.description,
      dims: [...Object.entries(TIME_DIMS).map(([k, label]) => ({ key: k, label, time: true })), ...Object.entries(s.dims).map(([k, x]) => ({ key: k, label: x.label, time: false }))],
      measures: Object.entries(s.measures).map(([k, x]) => ({ key: k, label: x.label, unit: x.unit, decimals: x.decimals })) }));
  });

  async function run(u: AuthUser, def: ReportDef) {
    const src = (await available(u)).find((s) => s.id === def.source);
    if (!src) throw forbidden('Diese Datenquelle steht dir nicht zur Verfügung.');
    const measure = src.measures[def.measure];
    if (!measure) throw badRequest('Unbekannte Kennzahl');
    const dimExpr = (key: string) => (TIME_DIMS[key] ? timeExpr(sql, key, src.date(sql)) : src.dims[key]?.expr(sql));
    const k = dimExpr(def.dim);
    if (!k) throw badRequest('Unbekannte Gruppierung');
    const s2 = def.dim2 ? dimExpr(def.dim2) : null;
    if (def.dim2 && !s2) throw badRequest('Unbekannte Unterteilung');
    const [from, to] = range(def);
    const date = src.date(sql);
    const expensesManager = src.id === 'expenses' && (await ctx.settings.get('expenses')).managerIds.includes(u.id);
    const scope = src.scope ? src.scope(sql, u, { expensesManager }) : sql`true`;
    const where = sql`${scope} ${from ? sql`and ${date} >= ${from}` : sql``} ${to ? sql`and ${date} <= ${to}` : sql``}`;
    const total = await sql<{ v: number }[]>`select (${measure.expr(sql)})::float as v from ${src.from(sql)} where ${where}`;
    const rows = await sql<{ k: string | null; s: string | null; v: number }[]>`select ${k} as k, ${s2 ?? sql`null::text`} as s, (${measure.expr(sql)})::float as v
      from ${src.from(sql)} where ${where} group by 1, 2 order by 1 limit 5000`;
    const isTime = !!TIME_DIMS[def.dim];
    // Kategorien nach Wert sortieren und auf die größten begrenzen, Zeitachsen chronologisch
    const keys = [...new Set(rows.map((r) => r.k ?? '–'))];
    const sum = (key: string) => rows.filter((r) => (r.k ?? '–') === key).reduce((a, r) => a + r.v, 0);
    const ordered = isTime ? keys.sort() : keys.sort((a, b) => sum(b) - sum(a)).slice(0, def.limit);
    const series = s2 ? [...new Set(rows.map((r) => r.s ?? '–'))].sort((a, b) => rows.filter((r) => (r.s ?? '–') === b).reduce((x, r) => x + r.v, 0) - rows.filter((r) => (r.s ?? '–') === a).reduce((x, r) => x + r.v, 0)) : [null];
    const shown = series.slice(0, 8);
    const data = ordered.map((key) => ({ key, values: shown.map((s) => rows.filter((r) => (r.k ?? '–') === key && (s === null || (r.s ?? '–') === s)).reduce((a, r) => a + r.v, 0)) }));
    return { source: src.label, measure: { key: def.measure, label: measure.label, unit: measure.unit, decimals: measure.decimals ?? 0 }, dim: TIME_DIMS[def.dim] ?? src.dims[def.dim]!.label,
      dim2: def.dim2 ? (TIME_DIMS[def.dim2] ?? src.dims[def.dim2]!.label) : null, series: shown.filter((x): x is string => x !== null), otherSeries: Math.max(0, series.length - shown.length),
      rows: data, total: total[0]?.v ?? 0, from, to, truncated: !isTime && keys.length > ordered.length };
  }

  app.post('/bi/run', async (req) => run(staffOf(req), parse(reportDef, req.body)));

  // gespeicherte Berichte
  const reportBody = z.object({ name: z.string().trim().min(1).max(120), def: reportDef, shared: z.boolean().default(false), pinned: z.boolean().default(true) });
  app.get('/bi/reports', async (req) => {
    const u = staffOf(req);
    return sql`select r.id, r.name, r.def, r.shared, r.pinned, r.sort, r.owner_id as "ownerId", u.display_name as "ownerName", r.owner_id = ${u.id} as mine
      from bi_reports r left join users u on u.id = r.owner_id where r.owner_id = ${u.id} or r.shared order by r.sort, r.created_at`;
  });
  app.post('/bi/reports', async (req) => {
    const u = staffOf(req);
    const b = parse(reportBody, req.body);
    if (b.shared && u.role !== 'admin') throw forbidden('Berichte für alle freigeben dürfen Administratoren.');
    const [r] = await sql<{ id: string }[]>`insert into bi_reports ${sql({ ...toRow(sql, b, ['def']), owner_id: u.id, sort: Date.now() / 1000 })} returning id`;
    changed();
    return { id: r!.id };
  });
  const mine = async (u: AuthUser, id: string) => {
    const [r] = await sql<{ owner_id: string | null }[]>`select owner_id from bi_reports where id = ${id}`;
    if (!r) throw notFound();
    if (r.owner_id !== u.id && u.role !== 'admin') throw forbidden();
  };
  app.patch('/bi/reports/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await mine(u, id);
    const b = parse(patchSchema(reportBody.extend({ sort: z.number() })), req.body);
    if (b.shared && u.role !== 'admin') throw forbidden('Berichte für alle freigeben dürfen Administratoren.');
    const row = toRow(sql, b, ['def']);
    if (Object.keys(row).length) await sql`update bi_reports set ${sql(row)}, updated_at = now() where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/bi/reports/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    await mine(u, id);
    await sql`delete from bi_reports where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.post('/bi/export.xlsx', async (req, reply) => {
    const u = staffOf(req);
    const b = parse(z.object({ name: z.string().max(120).default('Auswertung'), def: reportDef }), req.body);
    const r = await run(u, b.def);
    const head = [r.dim, ...(r.series.length ? r.series : [`${r.measure.label}${r.measure.unit ? ` (${r.measure.unit})` : ''}`])];
    const buf = writeXlsx([{ name: b.name.slice(0, 30) || 'Auswertung', rows: [head, ...r.rows.map((x) => [x.key, ...x.values.map((v) => Math.round(v * 100) / 100)]), [], ['Gesamt', Math.round(r.total * 100) / 100]], widths: [30, ...head.slice(1).map(() => 16)] }]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${encodeURIComponent(b.name)}.xlsx"`);
    return reply.send(buf);
  });
}
