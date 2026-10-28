/**
 * Kalkulation: je Projekt beliebig viele Kalkulationen nach Vorlage. Die Sätze des Administrators werden beim Anlegen
 * festgeschrieben, damit spätere Änderungen alte Kalkulationen nicht verfälschen. Status Entwurf → Geprüft → Freigegeben.
 * Eine Kalkulation kann als Grundlage für ein Angebot im CRM dienen; die Nachkalkulation vergleicht Soll und Ist.
 */
import type { FastifyInstance } from 'fastify';
import { CALC_TEMPLATES, calcPostcalc, computeCalc, emptyCalcData, plantItemValue, type CalcRates, type CalcResult, type CalcTemplate, type PlantData } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { nextNumber } from '../services/numbers';
import { Pdf, eur, num } from '../lib/pdf';

const TEMPLATES = ['surcharge', 'plant', 'hourly', 'postcalc', 'travel'] as const;
const STATUS_LABEL: Record<string, string> = { draft: 'Entwurf', checked: 'Geprüft', released: 'Freigegeben' };

interface CalcRow {
  id: string; number: string; project_id: string | null; title: string; template: CalcTemplate; status: string; rates: CalcRates; data: any; result: any;
  base_calculation_id: string | null; quote_id: string | null; note: string; created_by: string | null;
}

export default async function calculationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  const cols = sql`c.id, c.number, c.project_id as "projectId", p.number as "projectNumber", p.name as "projectName", c.title, c.template, c.status, c.rates, c.data, c.result,
    c.base_calculation_id as "baseCalculationId", c.quote_id as "quoteId", q.number as "quoteNumber", c.note, c.created_by as "createdBy", cu.display_name as "createdByName",
    ch.display_name as "checkedByName", c.checked_at as "checkedAt", rl.display_name as "releasedByName", c.released_at as "releasedAt", c.created_at as "createdAt", c.updated_at as "updatedAt"`;
  const from = sql`calculations c left join projects p on p.id = c.project_id left join crm_quotes q on q.id = c.quote_id left join users cu on cu.id = c.created_by
    left join users ch on ch.id = c.checked_by left join users rl on rl.id = c.released_by`;

  async function load(u: AuthUser, id: string, write = false) {
    const [c] = await sql<CalcRow[]>`select * from calculations where id = ${id}`;
    if (!c) throw notFound('Kalkulation nicht gefunden');
    if (c.project_id) await projectAccess(sql, u, c.project_id, write ? 'write' : 'read');
    return c;
  }

  /** Ist-Werte eines Projekts: gebuchte Stunden je Tätigkeit (über die Abteilung) und gelieferter Einkauf */
  async function actuals(projectId: string, rates: CalcRates) {
    const hours = await sql<{ team_id: string | null; hours: number }[]>`select u.department_id as team_id,
        sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)) / 3600)::float as hours
      from time_entries e join users u on u.id = e.user_id where e.project_id = ${projectId} group by u.department_id`;
    const laborHoursByKey: Record<string, number> = {};
    for (const h of hours) {
      const key = rates.labor.find((l) => h.team_id && l.teamIds?.includes(h.team_id))?.key ?? '';
      laborHoursByKey[key] = (laborHoursByKey[key] ?? 0) + h.hours;
    }
    const [m] = await sql<{ material: number; purchased: number }[]>`select
        coalesce(sum(delivered_qty * coalesce(unit_price, 0) * (1 - discount / 100)) filter (where source = 'manual'), 0)::float as material,
        coalesce(sum(delivered_qty * coalesce(unit_price, 0) * (1 - discount / 100)) filter (where source <> 'manual'), 0)::float as purchased
      from purchase_items where project_id = ${projectId} and status in ('partial', 'delivered')`;
    return { laborHoursByKey, material: m?.material ?? 0, purchased: m?.purchased ?? 0, other: 0 };
  }

  async function compute(c: Pick<CalcRow, 'template' | 'data' | 'rates' | 'project_id' | 'base_calculation_id'>): Promise<CalcResult> {
    if (c.template !== 'postcalc') return computeCalc(c.template, c.data, c.rates);
    const [base] = c.base_calculation_id ? await sql<CalcRow[]>`select * from calculations where id = ${c.base_calculation_id}` : [];
    const act = c.project_id ? await actuals(c.project_id, c.rates) : { laborHoursByKey: {}, material: 0, purchased: 0, other: 0 };
    act.other = (c.data?.other ?? []).reduce((a: number, x: { amount: number }) => a + (Number(x.amount) || 0), 0);
    return calcPostcalc(base ? base.result : null, base ? base.template : null, act, c.rates);
  }

  app.get('/calculations/templates', async (req) => {
    requireUser(req);
    return CALC_TEMPLATES;
  });

  app.get('/calculations/rates', async (req) => {
    requireUser(req);
    return ctx.settings.get('calcRates');
  });

  app.get('/calculations', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ projectId: z.string().uuid().optional() }), req.query);
    if (q.projectId) await projectAccess(sql, u, q.projectId);
    return sql`select ${cols} from ${from} where ${q.projectId ? sql`c.project_id = ${q.projectId}` : sql`(c.project_id is null or ${u.role === 'admin'} or p.visibility = 'company'
      or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = ${u.id}))`} order by c.created_at desc limit 500`;
  });

  app.get('/calculations/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = await load(u, id);
    const [row] = await sql`select ${cols} from ${from} where c.id = ${id}`;
    // Nachkalkulation zeigt immer den aktuellen Ist-Stand
    if (c.template === 'postcalc' && c.status !== 'released') return { ...row, result: await compute(c) };
    return row;
  });

  app.post('/calculations', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(z.object({ projectId: z.string().uuid().nullable().default(null), title: z.string().trim().min(1).max(300), template: z.enum(TEMPLATES),
      baseCalculationId: z.string().uuid().nullable().default(null), copyFromId: z.string().uuid().nullable().default(null), data: z.record(z.string(), z.unknown()).optional() }), req.body);
    if (b.projectId) await projectAccess(sql, u, b.projectId, 'write');
    if (b.template === 'postcalc' && !b.projectId) throw badRequest('Eine Nachkalkulation gehört zu einem Projekt');
    const rates = await ctx.settings.get('calcRates');
    let data: Record<string, unknown> = b.data ?? emptyCalcData(b.template, rates);
    if (b.copyFromId) { const src = await load(u, b.copyFromId); if (src.template !== b.template) throw badRequest('Nur Kalkulationen derselben Vorlage lassen sich kopieren'); data = src.data; }
    const n = await ctx.settings.get('numbers');
    const [p] = b.projectId ? await sql<{ number: string }[]>`select number from projects where id = ${b.projectId}` : [];
    const number = await nextNumber(sql, 'calculation', n.calculation, async (x) => (await sql`select 1 from calculations where number = ${x}`).length > 0, { customer: p?.number });
    const result = await compute({ template: b.template, data, rates, project_id: b.projectId, base_calculation_id: b.baseCalculationId });
    const [c] = await sql<{ id: string }[]>`insert into calculations (number, project_id, title, template, rates, data, result, base_calculation_id, created_by)
      values (${number}, ${b.projectId}, ${b.title}, ${b.template}, ${sql.json(rates as never)}, ${sql.json(data as never)}, ${sql.json(result as never)}, ${b.baseCalculationId}, ${u.id}) returning id`;
    await audit(sql, u, { action: 'calc.create', entityType: 'calculation', entityId: c!.id, projectId: b.projectId, summary: `Kalkulation ${number} „${b.title}“ angelegt` });
    return { id: c!.id, number };
  });

  app.patch('/calculations/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = await load(u, id, true);
    if (c.status === 'released') throw forbidden('Freigegebene Kalkulationen sind festgeschrieben – bitte eine Kopie anlegen');
    const b = parse(z.object({ title: z.string().trim().min(1).max(300).optional(), data: z.record(z.string(), z.unknown()).optional(), note: z.string().max(10000).optional(),
      baseCalculationId: z.string().uuid().nullable().optional(), refreshRates: z.boolean().optional() }), req.body);
    const rates = b.refreshRates ? await ctx.settings.get('calcRates') : c.rates;
    const data = b.data ?? c.data;
    const result = await compute({ ...c, data, rates, base_calculation_id: b.baseCalculationId === undefined ? c.base_calculation_id : b.baseCalculationId });
    // jede inhaltliche Änderung setzt „Geprüft“ zurück
    await sql`update calculations set title = coalesce(${b.title ?? null}, title), data = ${sql.json(data)}, result = ${sql.json(result as never)}, rates = ${sql.json(rates as never)},
      note = coalesce(${b.note ?? null}, note), base_calculation_id = ${b.baseCalculationId === undefined ? sql`base_calculation_id` : b.baseCalculationId},
      status = case when ${Boolean(b.data || b.refreshRates)} then 'draft' else status end, checked_by = case when ${Boolean(b.data || b.refreshRates)} then null else checked_by end,
      updated_at = now() where id = ${id}`;
    return { ok: true, result };
  });

  app.post('/calculations/:id/status', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = await load(u, id, true);
    const b = parse(z.object({ status: z.enum(['draft', 'checked', 'released']) }), req.body);
    if (b.status === 'released') {
      if (c.status !== 'checked') throw badRequest('Bitte die Kalkulation zuerst prüfen lassen');
      const p = c.project_id ? await projectAccess(sql, u, c.project_id) : null;
      if (u.role !== 'admin' && u.role !== 'teamlead' && !p?.canManage) throw forbidden('Freigeben dürfen Teamleiter, Projektverantwortliche und Administratoren');
    }
    if (b.status === 'checked' && c.created_by === u.id && u.role !== 'admin') throw forbidden('Prüfen soll eine zweite Person (Vier-Augen-Prinzip)');
    if (c.status === 'released' && b.status !== 'released' && u.role !== 'admin') throw forbidden('Nur Administratoren heben eine Freigabe auf');
    let result = c.result;
    if (b.status === 'released' && c.template === 'postcalc') result = await compute(c);
    await sql`update calculations set status = ${b.status}, result = ${sql.json(result)},
      checked_by = case when ${b.status} = 'checked' then ${u.id}::uuid when ${b.status} = 'draft' then null else checked_by end,
      checked_at = case when ${b.status} = 'checked' then now() when ${b.status} = 'draft' then null else checked_at end,
      released_by = case when ${b.status} = 'released' then ${u.id}::uuid else null end, released_at = case when ${b.status} = 'released' then now() else null end,
      updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'calc.status', entityType: 'calculation', entityId: id, projectId: c.project_id, summary: `Kalkulation ${c.number}: ${STATUS_LABEL[c.status]} → ${STATUS_LABEL[b.status]}` });
    return { ok: true };
  });

  app.delete('/calculations/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = await load(u, id, true);
    if (c.status === 'released' && u.role !== 'admin') throw forbidden('Freigegebene Kalkulationen löscht nur ein Administrator');
    await sql`delete from calculations where id = ${id}`;
    await audit(sql, u, { action: 'calc.delete', entityType: 'calculation', entityId: id, projectId: c.project_id, summary: `Kalkulation ${c.number} gelöscht` });
    return { ok: true };
  });

  /** Material aus dem Einkauf bzw. der Stückliste des Projekts übernehmen */
  app.get('/calculations/projects/:id/material', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id);
    return sql`select designation as text, qty::float as qty, unit, coalesce(unit_price, 0)::float as price, source, number from purchase_items
      where project_id = ${id} and status <> 'cancelled' order by sort`;
  });

  /** Angebot im CRM aus der Kalkulation erzeugen (Positionen = Baugruppen bzw. Gesamtpreis) */
  app.post('/calculations/:id/quote', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = await load(u, id);
    if (c.status !== 'released' && c.status !== 'checked') throw badRequest('Angebote entstehen aus geprüften oder freigegebenen Kalkulationen');
    const b = parse(z.object({ accountId: z.string().uuid().optional() }), req.body);
    let accountId = b.accountId;
    if (!accountId && c.project_id) accountId = (await sql<{ customer_id: string | null }[]>`select customer_id from projects where id = ${c.project_id}`)[0]?.customer_id ?? undefined;
    if (!accountId) throw badRequest('Bitte einen Kunden wählen (das Projekt hat keinen Kunden aus dem CRM)');
    const result = c.result as CalcResult;
    let positions: { text: string; description: string; qty: number; unit: string; price: number; discount: number; optional: boolean }[];
    if (c.template === 'plant') {
      // Preis je Baugruppe anteilig inkl. Wagnis und Gewinn
      const s = { ...c.rates.surcharges, ...((c.data as PlantData).surcharges ?? {}) };
      const groups = (c.data as PlantData).groups ?? [];
      const raw = groups.map((g) => (g.items ?? []).reduce((a, it) => a + plantItemValue(it, c.rates, s), 0));
      const sum = raw.reduce((a, b2) => a + b2, 0) || 1;
      positions = groups.map((g, i) => ({ text: g.name || `Baugruppe ${i + 1}`, description: (g.items ?? []).map((it) => it.text).filter(Boolean).join(', '), qty: 1, unit: 'psch',
        price: Math.round((result.total * raw[i]! / sum) * 100) / 100, discount: 0, optional: false }));
    } else {
      positions = [{ text: c.title, description: '', qty: c.template === 'surcharge' ? Number((c.data as { quantity?: number }).quantity) || 1 : 1, unit: c.template === 'surcharge' ? 'Stk' : 'psch',
        price: result.perUnit ?? result.total, discount: 0, optional: false }];
    }
    const res = await app.inject({ method: 'POST', url: '/api/crm/quotes', headers: { cookie: req.headers.cookie ?? '', authorization: req.headers.authorization ?? '' },
      payload: { accountId, projectId: c.project_id, calculationId: c.id, title: c.title, positions } });
    if (res.statusCode !== 200) throw badRequest(JSON.parse(res.body).error ?? 'Angebot konnte nicht angelegt werden');
    const q = JSON.parse(res.body) as { id: string; number: string };
    await sql`update calculations set quote_id = ${q.id} where id = ${id}`;
    return q;
  });

  app.get('/calculations/:id/pdf', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const c = await load(u, id);
    const [row] = await sql<any[]>`select ${cols} from ${from} where c.id = ${id}`;
    const result = (c.template === 'postcalc' && c.status !== 'released' ? await compute(c) : c.result) as CalcResult & { rows?: { label: string; plan: number; actual: number; unit: string }[] };
    const company = await ctx.settings.get('company');
    const pdf = new Pdf(`Kalkulation ${c.number}`, company.name);
    pdf.text(pdf.margin, pdf.y, company.name, { size: 9, color: '#6b7280' }); pdf.y += 18;
    pdf.paragraph(`${CALC_TEMPLATES.find((t) => t.id === c.template)?.name}: ${c.title}`, { size: 15, bold: true, gap: 6 });
    pdf.paragraph(`${c.number}${row.projectNumber ? ` · Projekt ${row.projectNumber} ${row.projectName}` : ''} · Stand ${STATUS_LABEL[c.status]}${row.releasedByName ? ` (freigegeben von ${row.releasedByName})` : ''} · ${new Date().toLocaleDateString('de-DE')}`, { color: '#4b5563', gap: 12 });
    const d = c.data;
    const L = (n: string) => c.rates.labor.find((l) => l.key === n)?.name ?? n;
    if (c.template === 'plant') {
      for (const g of (d.groups ?? []) as PlantData['groups']) {
        pdf.paragraph(g.name, { bold: true, size: 11 });
        pdf.table([{ label: 'Position', width: 200 }, { label: 'Art', width: 90 }, { label: 'Menge', width: 70, align: 'right' }, { label: 'Satz / Preis', width: 70, align: 'right' }, { label: 'Betrag', width: 65, align: 'right' }],
          (g.items ?? []).map((it) => {
            const kind = it.kind === 'labor' ? L(it.key ?? '') : it.kind === 'machine' ? c.rates.machines.find((m) => m.key === it.key)?.name ?? '' : it.kind === 'material' ? 'Material' : 'Zukauf';
            const rate = it.kind === 'labor' ? c.rates.labor.find((l) => l.key === it.key)?.rate ?? 0 : it.kind === 'machine' ? c.rates.machines.find((m) => m.key === it.key)?.rate ?? 0 : Number(it.price) || 0;
            return [it.text, kind, `${num(Number(it.qty))} ${it.unit ?? (it.kind === 'labor' || it.kind === 'machine' ? 'Std' : '')}`, eur(rate), eur(plantItemValue(it, c.rates, { ...c.rates.surcharges, ...((d as PlantData).surcharges ?? {}) }))];
          }));
      }
    } else if (c.template === 'surcharge') {
      if (d.material?.length) { pdf.paragraph('Material', { bold: true }); pdf.table([{ label: 'Position', width: 260 }, { label: 'Menge', width: 80, align: 'right' }, { label: 'Preis', width: 75, align: 'right' }, { label: 'Betrag', width: 80, align: 'right' }], d.material.map((m: any) => [m.text, `${num(m.qty)} ${m.unit}`, eur(m.price), eur(m.qty * m.price)])); }
      if (d.labor?.length) { pdf.paragraph('Fertigungslöhne', { bold: true }); pdf.table([{ label: 'Arbeitsgang', width: 260 }, { label: 'Tätigkeit', width: 120 }, { label: 'Stunden', width: 115, align: 'right' }], d.labor.map((l: any) => [l.text, L(l.key), num(l.hours)])); }
    } else if (c.template === 'postcalc' && result.rows) {
      pdf.table([{ label: 'Bereich', width: 230 }, { label: 'Soll', width: 85, align: 'right' }, { label: 'Ist', width: 85, align: 'right' }, { label: 'Abweichung', width: 95, align: 'right' }],
        result.rows.map((r) => [r.label, r.unit === '€' ? eur(r.plan) : `${num(r.plan)} Std.`, r.unit === '€' ? eur(r.actual) : `${num(r.actual)} Std.`, r.unit === '€' ? eur(r.actual - r.plan) : `${num(r.actual - r.plan)} Std.`]));
    }
    pdf.y += 6;
    pdf.paragraph('Ergebnis', { bold: true, size: 12 });
    for (const l of result.lines) {
      pdf.ensure(16);
      pdf.text(pdf.margin + (l.indent ? 14 : 0), pdf.y, l.label, { bold: l.bold, size: 10 });
      pdf.text(pdf.width - pdf.margin - 140, pdf.y, l.hint === 'Stunden' ? `${num(l.value)} Std.` : c.template === 'hourly' && l.label.includes('Stundensatz') || l.label.startsWith('Verrechnungssatz') ? `${eur(l.value)} / Std.` : eur(l.value), { bold: l.bold, align: 'right', width: 140 });
      pdf.y += 15;
      if (l.bold) pdf.line(pdf.margin, pdf.y - 3, pdf.width - pdf.margin, pdf.y - 3, 0.3, '#d1d5db');
    }
    if (c.note) { pdf.y += 8; pdf.paragraph('Bemerkung', { bold: true }); pdf.paragraph(c.note); }
    pdf.y += 8;
    pdf.paragraph('Verwendete Sätze (beim Anlegen festgeschrieben): ' + c.rates.labor.map((l) => `${l.name} ${eur(l.rate)}`).join(', ') +
      ` · Zuschläge: Material ${c.rates.surcharges.materialOverhead} %, Fertigung ${c.rates.surcharges.productionOverhead} %, VwVt ${c.rates.surcharges.adminSales} %, Wagnis ${c.rates.surcharges.risk} %, Gewinn ${c.rates.surcharges.profit} %`, { size: 8, color: '#6b7280' });
    pdf.footer((p, t) => `${company.name} · Kalkulation ${c.number} · vertraulich · Seite ${p} von ${t}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Kalkulation_${c.number}.pdf"`);
    return pdf.toBuffer();
  });
}
