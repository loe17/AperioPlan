/**
 * Nachhaltigkeit: Energieverbrauch und Fahrten erfassen, in CO₂ umrechnen (Scope 1, 2 und 3), je Projekt und Standort auswerten.
 * Tankbelege aus dem Fuhrpark und Dienstfahrten aus den Spesen werden automatisch übernommen.
 * Emissionsfaktoren sind vorbelegt (Umweltbundesamt, BAFA) und lassen sich anpassen.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { staffOf, toRow } from '../lib/rows';
import { writeXlsx } from '../lib/xlsx';

const factorBody = z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(), label: z.string().trim().min(1).max(120), unit: z.string().trim().min(1).max(20), kgPerUnit: z.number().min(0).max(100000),
  scope: z.union([z.literal(1), z.literal(2), z.literal(3)]), category: z.string().trim().min(1).max(60), source: z.string().max(300).default(''), active: z.boolean().default(true), sort: z.number().int().default(100) });
const entryBody = z.object({ date: z.string().date(), periodEnd: z.string().date().nullable().default(null), factorId: z.string().uuid(), quantity: z.number().min(0).max(1e9),
  projectId: z.string().uuid().nullable().default(null), site: z.string().max(120).default(''), note: z.string().max(500).default('') });

/** Tankbelege und Dienstfahrten eines Jahres übernehmen (wiederholbar, ändert vorhandene Übernahmen) */
export async function importSustainability(ctx: AppContext, year: number) {
  const { sql } = ctx;
  const installed = (await ctx.settings.get('apps')).installed;
  const factors = new Map((await sql<{ key: string; id: string }[]>`select key, id from sus_factors`).map((f) => [f.key, f.id]));
  let fleet = 0, expenses = 0;
  const upsert = async (origin: 'fleet' | 'expenses', originId: string, date: string, key: string, qty: number, projectId: string | null, note: string) => {
    const fid = factors.get(key);
    if (!fid || !(qty > 0)) return false;
    await sql`insert into sus_entries (date, factor_id, quantity, project_id, note, origin, origin_id) values (${date}, ${fid}, ${qty}, ${projectId}, ${note}, ${origin}, ${originId})
      on conflict (origin, origin_id) where origin_id is not null do update set date = excluded.date, factor_id = excluded.factor_id, quantity = excluded.quantity, note = excluded.note`;
    return true;
  };
  if (installed.includes('fleet')) {
    const rows = await sql<{ id: string; date: string; kind: string; liters: number | null; fuel: string; plate: string }[]>`select e.id, e.date::text, e.kind, e.liters::float as liters, v.fuel, v.plate
      from fl_entries e join fl_vehicles v on v.id = e.vehicle_id where e.kind in ('fuel', 'charge') and extract(year from e.date) = ${year}`;
    for (const r of rows) {
      const key = r.kind === 'charge' ? 'electricity' : r.fuel === 'diesel' ? 'diesel' : r.fuel === 'benzin' || r.fuel === 'hybrid' ? 'petrol' : null;
      if (key && (await upsert('fleet', r.id, r.date, key, r.liters ?? 0, null, `${r.plate}: ${r.kind === 'charge' ? 'Laden' : 'Tanken'}`))) fleet++;
    }
  }
  if (installed.includes('expenses')) {
    const rows = await sql<{ id: string; date: string; km: number; project_id: string | null; number: string }[]>`select x.id, x.date::text, x.km::float as km, r.project_id, r.number
      from exp_items x join exp_reports r on r.id = x.report_id where x.kind = 'mileage' and r.status in ('approved', 'paid') and extract(year from x.date) = ${year}`;
    for (const r of rows) if (await upsert('expenses', r.id, r.date, 'car_km', r.km, r.project_id, `Spesen ${r.number}: Dienstfahrt Privat-Pkw`)) expenses++;
  }
  return { fleet, expenses };
}

export async function sustainabilityDaily(ctx: AppContext) {
  if (!(await ctx.settings.get('apps')).installed.includes('sustainability')) return;
  await importSustainability(ctx, new Date().getFullYear());
}

export default async function sustainabilityRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const changed = () => ctx.hub.publish('global', 'sustainability.changed', {});
  const isManager = async (u: AuthUser) => u.role === 'admin' || (await ctx.settings.get('sustainability')).managerIds.includes(u.id);
  const manager = async (req: Parameters<typeof staffOf>[0]) => { const u = staffOf(req); if (!(await isManager(u))) throw forbidden('Werte erfassen die Verantwortlichen für Nachhaltigkeit.'); return u; };
  const yearQ = z.object({ year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()) });

  app.get('/sustainability/access', async (req) => ({ manager: await isManager(staffOf(req)) }));

  app.get('/sustainability/factors', async (req) => {
    staffOf(req);
    return sql`select id, key, label, unit, kg_per_unit::float as "kgPerUnit", scope, category, source, active, sort,
      (select count(*)::int from sus_entries e where e.factor_id = f.id) as used from sus_factors f order by sort, label`;
  });
  app.post('/sustainability/factors', async (req) => {
    const u = await manager(req);
    const b = parse(factorBody, req.body);
    const key = b.key ?? `f_${Date.now().toString(36)}`;
    const [f] = await sql<{ id: string }[]>`insert into sus_factors ${sql(toRow(sql, { ...b, key }))} returning id`.catch((e: Error) => { throw /unique/.test(e.message) ? badRequest('Diesen Schlüssel gibt es schon.') : e; });
    await audit(sql, u, { action: 'sustainability.factor', entityType: 'sus_factor', entityId: f!.id, summary: `Emissionsfaktor ${b.label} angelegt` });
    changed();
    return { id: f!.id };
  });
  app.patch('/sustainability/factors/:id', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(factorBody.omit({ key: true })), req.body);
    const row = toRow(sql, b);
    if (Object.keys(row).length) await sql`update sus_factors set ${sql(row)} where id = ${id}`;
    if (b.kgPerUnit !== undefined) await audit(sql, u, { action: 'sustainability.factor', entityType: 'sus_factor', entityId: id, summary: `Emissionsfaktor geändert: ${b.kgPerUnit} kg je Einheit` });
    changed();
    return { ok: true };
  });
  app.delete('/sustainability/factors/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from sus_entries where factor_id = ${id}`;
    if (n!.n) throw badRequest('Der Faktor wird verwendet – bitte deaktivieren.');
    await sql`delete from sus_factors where id = ${id}`;
    changed();
    return { ok: true };
  });

  app.get('/sustainability/entries', async (req) => {
    staffOf(req);
    const q = parse(yearQ, req.query);
    return sql`select e.id, e.date::text, e.period_end::text as "periodEnd", e.factor_id as "factorId", f.label as "factorLabel", f.unit, f.scope, f.category, e.quantity::float as quantity,
      (e.quantity * f.kg_per_unit)::float as kg, e.project_id as "projectId", p.number as "projectNumber", e.site, e.note, e.origin, u.display_name as "createdByName"
      from sus_entries e join sus_factors f on f.id = e.factor_id left join projects p on p.id = e.project_id left join users u on u.id = e.created_by
      where extract(year from e.date) = ${q.year} order by e.date desc, e.created_at desc limit 5000`;
  });
  app.post('/sustainability/entries', async (req) => {
    const u = await manager(req);
    const b = parse(entryBody, req.body);
    if (b.periodEnd && b.periodEnd < b.date) throw badRequest('Das Ende liegt vor dem Beginn.');
    const [e] = await sql<{ id: string }[]>`insert into sus_entries ${sql({ ...toRow(sql, b), created_by: u.id })} returning id`;
    changed();
    return { id: e!.id };
  });
  app.patch('/sustainability/entries/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const [cur] = await sql<{ origin: string }[]>`select origin from sus_entries where id = ${id}`;
    if (!cur) throw notFound();
    if (cur.origin !== 'manual') throw badRequest('Übernommene Werte bitte in Fuhrpark bzw. Spesen ändern.');
    const row = toRow(sql, parse(patchSchema(entryBody), req.body));
    if (Object.keys(row).length) await sql`update sus_entries set ${sql(row)} where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/sustainability/entries/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from sus_entries where id = ${id} and origin = 'manual'`;
    changed();
    return { ok: true };
  });
  app.post('/sustainability/import', async (req) => {
    await manager(req);
    const q = parse(yearQ, req.body ?? {});
    const r = await importSustainability(ctx, q.year);
    changed();
    return r;
  });

  async function summary(year: number) {
    const s = await ctx.settings.get('sustainability');
    const by = (expr: ReturnType<typeof sql>) => sql<{ k: string; t: number }[]>`select ${expr} as k, (sum(e.quantity * f.kg_per_unit) / 1000)::float as t
      from sus_entries e join sus_factors f on f.id = e.factor_id left join projects p on p.id = e.project_id where extract(year from e.date) = ${year} group by 1 order by 2 desc`;
    const [scopes, categories, months, projects, sites, sources] = await Promise.all([
      by(sql`'Scope ' || f.scope`), by(sql`f.category`), by(sql`to_char(e.date, 'MM')`), by(sql`coalesce(p.number || ' ' || p.name, 'ohne Projekt')`), by(sql`coalesce(nullif(e.site, ''), '–')`),
      sql<{ k: string; unit: string; qty: number; t: number; scope: number }[]>`select f.label as k, f.unit, f.scope, sum(e.quantity)::float as qty, (sum(e.quantity * f.kg_per_unit) / 1000)::float as t
        from sus_entries e join sus_factors f on f.id = e.factor_id where extract(year from e.date) = ${year} group by f.label, f.unit, f.scope order by t desc`,
    ]);
    const years = await sql<{ y: number; t: number }[]>`select extract(year from e.date)::int as y, (sum(e.quantity * f.kg_per_unit) / 1000)::float as t from sus_entries e join sus_factors f on f.id = e.factor_id group by 1 order by 1`;
    const total = scopes.reduce((a, r) => a + r.t, 0);
    const [emp] = await sql<{ n: number }[]>`select count(*)::int as n from users where active and role <> 'guest' and deleted_at is null`;
    const base = years.find((x) => x.y === s.baseYear)?.t ?? null;
    return { year, total, perEmployee: emp!.n ? total / emp!.n : null, employees: emp!.n, scopes, categories, months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, t: months.find((m) => Number(m.k) === i + 1)?.t ?? 0 })),
      projects, sites, sources, years, target: { baseYear: s.baseYear, base, targetYear: s.targetYear, percent: s.targetPercent, value: base !== null ? base * (1 - s.targetPercent / 100) : null } };
  }
  app.get('/sustainability/summary', async (req) => { staffOf(req); return summary(parse(yearQ, req.query).year); });
  app.get('/sustainability/report.xlsx', async (req, reply) => {
    staffOf(req);
    const { year } = parse(yearQ, req.query);
    const s = await summary(year);
    const r2 = (n: number) => Math.round(n * 1000) / 1000;
    const entries = await sql<any[]>`select e.date::text as date, f.label, f.unit, f.scope, e.quantity::float as q, f.kg_per_unit::float as kg, p.number as project, e.site, e.note, f.source
      from sus_entries e join sus_factors f on f.id = e.factor_id left join projects p on p.id = e.project_id where extract(year from e.date) = ${year} order by e.date`;
    const buf = writeXlsx([
      { name: `CO2-Bilanz ${year}`, rows: [['Bereich', 't CO₂'], ...s.scopes.map((x) => [x.k, r2(x.t)]), ['Gesamt', r2(s.total)], [], ['Energieträger', 'Menge', 'Einheit', 'Scope', 't CO₂'],
        ...s.sources.map((x) => [x.k, r2(x.qty), x.unit, x.scope, r2(x.t)]), [], ['Projekt', 't CO₂'], ...s.projects.map((x) => [x.k, r2(x.t)])], widths: [40, 14, 10, 8, 12] },
      { name: 'Einzelwerte', rows: [['Datum', 'Energieträger', 'Menge', 'Einheit', 'Scope', 'kg CO₂/Einheit', 'kg CO₂', 'Projekt', 'Standort', 'Bemerkung', 'Quelle Faktor'],
        ...entries.map((e) => [new Date(`${e.date}T12:00:00`).toLocaleDateString('de-DE'), e.label, e.q, e.unit, e.scope, e.kg, r2(e.q * e.kg), e.project ?? '', e.site, e.note, e.source])], widths: [12, 30, 10, 8, 6, 12, 10, 12, 14, 30, 40] },
    ]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="CO2-Bilanz_${year}.xlsx"`);
    return reply.send(buf);
  });
}
