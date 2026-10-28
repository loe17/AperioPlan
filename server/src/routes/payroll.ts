/**
 * Lohnabrechnung: Personalstamm, Abrechnungsmonate, Lohnzettel, Übergabe an Steuerberater und Bank.
 * Zugriff nur für Administratoren und die in den Einstellungen eingetragenen Lohnbuchhalter.
 * Jeder Mitarbeiter sieht seine eigenen festgeschriebenen Lohnzettel unter /me/payslips.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { computePayslip, contributionGroup, EMPLOYMENT_GROUPS, PAY_LINE_KINDS, type PayLine, type PayProfile, type PayslipResult } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { sendMail } from '../services/mail';
import { writeXlsx } from '../lib/xlsx';
import { datevExtf, type DatevBooking } from '../lib/datev';
import { painCreditTransfer } from '../services/bank';
import { calcSlip, employeeCols, fullProfile, monthName, monthRange, payslipPdf, suggestLines, type PayEmployee } from '../services/payroll';

const r2 = (n: number) => Math.round(n * 100) / 100;
const profileSchema = z.object({
  group: z.enum(['regular', 'minijob', 'student']), taxClass: z.number().int().min(1).max(6), factor: z.number().min(0).max(1), childAllowances: z.number().min(0).max(20),
  church: z.boolean(), state: z.string().length(2), taxFreeMonthly: z.number().min(0), taxAddMonthly: z.number().min(0), insurance: z.enum(['gkv', 'pkv']),
  kvZusatz: z.number().min(0).max(10), pkvPremium: z.number().min(0), pvChildren: z.number().int().min(0).max(20), pvChildless: z.boolean(), rvExempt: z.boolean(), flatTax: z.boolean(),
  u1: z.number().min(0).max(10), u2: z.number().min(0).max(10),
}).partial();
const lineSchema = z.object({ kind: z.enum(Object.keys(PAY_LINE_KINDS) as [string, ...string[]]), label: z.string().trim().min(1).max(120), qty: z.number(), rate: z.number(), percent: z.number().min(0).max(300).optional(), source: z.string().max(60).optional() });
const employeeBody = z.object({
  userId: z.string().uuid().nullable().default(null), personnelNo: z.string().trim().max(20).default(''), firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(100),
  birthDate: z.string().date().nullable().default(null), street: z.string().max(200).default(''), zip: z.string().max(10).default(''), city: z.string().max(100).default(''), email: z.string().max(200).default(''),
  iban: z.string().max(40).default(''), bic: z.string().max(20).default(''), taxId: z.string().max(20).default(''), svNumber: z.string().max(20).default(''), healthInsurer: z.string().max(100).default(''),
  jobTitle: z.string().max(100).default(''), entryDate: z.string().date().nullable().default(null), exitDate: z.string().date().nullable().default(null),
  payType: z.enum(['salary', 'hourly']).default('salary'), salary: z.number().min(0).default(0), hourlyRate: z.number().min(0).default(0), weeklyHours: z.number().min(0).max(80).default(40),
  timeSurcharges: z.boolean().default(false), profile: profileSchema.default({}), recurring: z.array(lineSchema).max(50).default([]), costCenter: z.string().max(40).default(''), notes: z.string().max(5000).default(''), active: z.boolean().default(true),
});

export default async function payrollRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const manager = async (req: Parameters<typeof requireUser>[0]): Promise<AuthUser> => {
    const u = requireUser(req);
    if (u.role === 'admin') return u;
    const s = await ctx.settings.get('payroll');
    if (!s.managerIds.includes(u.id)) throw forbidden('Die Lohnabrechnung ist nur für Lohnbuchhalter und Administratoren sichtbar.');
    return u;
  };
  const changed = () => ctx.hub.publish('global', 'payroll.changed', {});
  const loadEmployee = async (id: string) => {
    const [e] = await sql<PayEmployee[]>`select ${employeeCols(sql)} from pay_employees e where e.id = ${id}`;
    if (!e) throw notFound('Mitarbeiter nicht gefunden');
    return e;
  };

  // ------------------------------------------------ Personalstamm
  app.get('/payroll/access', async (req) => { await manager(req); return { ok: true }; });
  app.get('/payroll/employees', async (req) => {
    await manager(req);
    return sql`select ${employeeCols(sql)}, u.display_name as "userName" from pay_employees e left join users u on u.id = e.user_id order by e.active desc, e.last_name, e.first_name`;
  });
  app.get('/payroll/employees/:id', async (req) => { await manager(req); return loadEmployee(parse(idParam, req.params).id); });
  async function nextPersonnelNo() {
    const s = await ctx.settings.get('payroll');
    const [r] = await sql<{ n: number | null }[]>`select max(personnel_no::bigint)::int as n from pay_employees where personnel_no ~ '^[0-9]+$'`;
    return String(Math.max(s.firstPersonnelNo, (r?.n ?? 0) + 1));
  }
  const toRow = (b: Partial<z.infer<typeof employeeBody>>) => {
    const m: Record<string, unknown> = {};
    const map: Record<string, string> = { userId: 'user_id', personnelNo: 'personnel_no', firstName: 'first_name', lastName: 'last_name', birthDate: 'birth_date', taxId: 'tax_id', svNumber: 'sv_number',
      healthInsurer: 'health_insurer', jobTitle: 'job_title', entryDate: 'entry_date', exitDate: 'exit_date', payType: 'pay_type', hourlyRate: 'hourly_rate', weeklyHours: 'weekly_hours',
      timeSurcharges: 'time_surcharges', costCenter: 'cost_center' };
    for (const [k, v] of Object.entries(b)) if (v !== undefined) m[map[k] ?? k] = (k === 'profile' || k === 'recurring') ? sql.json(v as never) : v;
    return m;
  };
  app.post('/payroll/employees', async (req) => {
    const u = await manager(req);
    const b = parse(employeeBody, req.body);
    const pay = await ctx.settings.get('payroll');
    const profile = fullProfile({ state: pay.state, u1: pay.u1, u2: pay.u2, ...b.profile });
    const row = toRow({ ...b, personnelNo: b.personnelNo || await nextPersonnelNo(), profile });
    const [r] = await sql<{ id: string }[]>`insert into pay_employees ${sql(row)} returning id`.catch((e: Error) => { throw /unique/.test(e.message) ? badRequest('Personalnummer oder Benutzer ist schon vergeben.') : e; });
    await audit(sql, u, { action: 'payroll.employee.create', entityType: 'pay_employee', entityId: r!.id, summary: `${b.firstName} ${b.lastName}` });
    changed();
    return { id: r!.id };
  });
  app.patch('/payroll/employees/:id', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(employeeBody), req.body);
    const cur = await loadEmployee(id);
    const row = toRow({ ...b, ...(b.profile ? { profile: fullProfile({ ...cur.profile, ...b.profile }) } : {}) });
    if (!Object.keys(row).length) return { ok: true };
    await sql`update pay_employees set ${sql(row)}, updated_at = now() where id = ${id}`.catch((e: Error) => { throw /unique/.test(e.message) ? badRequest('Personalnummer oder Benutzer ist schon vergeben.') : e; });
    await audit(sql, u, { action: 'payroll.employee.update', entityType: 'pay_employee', entityId: id, summary: `${cur.firstName} ${cur.lastName}: ${Object.keys(b).join(', ')}` });
    changed();
    return { ok: true };
  });
  app.delete('/payroll/employees/:id', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from pay_slips s join pay_runs r on r.id = s.run_id where s.employee_id = ${id} and r.status = 'final'`;
    if (n!.n) throw badRequest('Für diesen Mitarbeiter gibt es festgeschriebene Abrechnungen – bitte stattdessen als ausgeschieden markieren (Austrittsdatum).');
    await sql`delete from pay_employees where id = ${id}`;
    await audit(sql, u, { action: 'payroll.employee.delete', entityType: 'pay_employee', entityId: id, summary: 'Mitarbeiter gelöscht' });
    changed();
    return { ok: true };
  });
  /** Benutzer ohne Personalstammsatz übernehmen */
  app.post('/payroll/employees/from-users', async (req) => {
    const u = await manager(req);
    const pay = await ctx.settings.get('payroll');
    const users = await sql<{ id: string; display_name: string; email: string }[]>`select id, display_name, email from users where active and role <> 'guest' and id not in (select user_id from pay_employees where user_id is not null) order by display_name`;
    for (const x of users) {
      const parts = x.display_name.trim().split(/\s+/);
      const last = parts.length > 1 ? parts.pop()! : x.display_name;
      await sql`insert into pay_employees ${sql({ user_id: x.id, personnel_no: await nextPersonnelNo(), first_name: parts.join(' ') || last, last_name: last, email: x.email ?? '',
        profile: sql.json(fullProfile({ state: pay.state, u1: pay.u1, u2: pay.u2 }) as never), active: true })}`;
    }
    if (users.length) await audit(sql, u, { action: 'payroll.employee.import', entityType: 'pay_employee', summary: `${users.length} Mitarbeiter aus den Benutzern übernommen` });
    changed();
    return { added: users.length };
  });

  // ------------------------------------------------ Abrechnungsmonate
  app.get('/payroll/runs', async (req) => {
    await manager(req);
    return sql`select r.id, r.year, r.month, r.status, r.finalized_at as "finalizedAt", r.exported_at as "exportedAt", count(s.id)::int as slips,
      coalesce(sum(s.gross), 0)::float as gross, coalesce(sum(s.payout), 0)::float as payout, coalesce(sum(s.employer_cost), 0)::float as "employerCost"
      from pay_runs r left join pay_slips s on s.run_id = r.id group by r.id order by r.year desc, r.month desc`;
  });
  const runCols = sql`s.id, s.employee_id as "employeeId", e.personnel_no as "personnelNo", e.first_name as "firstName", e.last_name as "lastName", s.lines, s.profile, s.result,
    s.gross::float as gross, s.net::float as net, s.payout::float as payout, s.employer_cost::float as "employerCost", s.pdf_path is not null as "hasPdf", s.sent_at as "sentAt"`;
  app.get('/payroll/runs/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const [run] = await sql`select id, year, month, status, finalized_at as "finalizedAt", exported_at as "exportedAt" from pay_runs where id = ${id}`;
    if (!run) throw notFound();
    const slips = await sql`select ${runCols} from pay_slips s join pay_employees e on e.id = s.employee_id where s.run_id = ${id} order by e.last_name, e.first_name`;
    return { ...run, slips };
  });

  async function buildSlip(runId: string, e: PayEmployee, year: number, month: number, lines?: PayLine[]) {
    const profile = fullProfile(e.profile);
    const l = lines ?? await suggestLines(ctx, e, year, month);
    const res = await calcSlip(ctx, e.id, year, month, profile, l);
    await sql`insert into pay_slips (run_id, employee_id, lines, profile, result, gross, net, payout, employer_cost) values (${runId}, ${e.id}, ${sql.json(l as never)}, ${sql.json(profile as never)},
      ${sql.json(res as never)}, ${res.gross}, ${res.net}, ${res.payout}, ${res.employerCost})
      on conflict (run_id, employee_id) do update set lines = excluded.lines, profile = excluded.profile, result = excluded.result, gross = excluded.gross, net = excluded.net,
      payout = excluded.payout, employer_cost = excluded.employer_cost, pdf_path = null, updated_at = now()`;
  }
  async function activeEmployees(year: number, month: number) {
    const { from, to } = monthRange(year, month);
    return sql<PayEmployee[]>`select ${employeeCols(sql)} from pay_employees e where e.active and (e.entry_date is null or e.entry_date <= ${to}) and (e.exit_date is null or e.exit_date >= ${from}) order by e.last_name`;
  }
  async function draftRun(runId: string) {
    const [r] = await sql<{ status: string; year: number; month: number }[]>`select status, year, month from pay_runs where id = ${runId}`;
    if (!r) throw notFound();
    if (r.status !== 'draft') throw badRequest('Der Monat ist festgeschrieben. Zum Ändern zuerst wieder öffnen.');
    return r;
  }

  app.post('/payroll/runs', async (req) => {
    const u = await manager(req);
    const b = parse(z.object({ year: z.number().int().min(2026).max(2100), month: z.number().int().min(1).max(12) }), req.body);
    const [prev] = await sql<{ id: string }[]>`select id from pay_runs where (year, month) < (${b.year}, ${b.month}) and status = 'draft' limit 1`;
    if (prev) throw badRequest('Ein früherer Monat ist noch nicht festgeschrieben. Bitte die Monate der Reihe nach abrechnen.');
    const [r] = await sql<{ id: string }[]>`insert into pay_runs (year, month, created_by) values (${b.year}, ${b.month}, ${u.id}) on conflict (year, month) do nothing returning id`;
    if (!r) throw badRequest(`${monthName(b.month)} ${b.year} ist schon angelegt.`);
    for (const e of await activeEmployees(b.year, b.month)) await buildSlip(r.id, e, b.year, b.month);
    await audit(sql, u, { action: 'payroll.run.create', entityType: 'pay_run', entityId: r.id, summary: `Abrechnung ${monthName(b.month)} ${b.year} angelegt` });
    changed();
    return { id: r.id };
  });
  /** Fehlende Mitarbeiter ergänzen bzw. alle Vorschläge neu aus Stammdaten und Zeiterfassung holen */
  app.post('/payroll/runs/:id/refresh', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ all: z.boolean().default(false), employeeId: z.string().uuid().optional() }), req.body ?? {});
    const run = await draftRun(id);
    const have = new Set((await sql<{ e: string }[]>`select employee_id as e from pay_slips where run_id = ${id}`).map((x) => x.e));
    for (const e of await activeEmployees(run.year, run.month)) {
      if (b.employeeId ? e.id === b.employeeId : (b.all || !have.has(e.id))) await buildSlip(id, e, run.year, run.month);
    }
    changed();
    return { ok: true };
  });
  app.patch('/payroll/slips/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ lines: z.array(lineSchema).max(100) }), req.body);
    const [s] = await sql<{ run_id: string; employee_id: string }[]>`select run_id, employee_id from pay_slips where id = ${id}`;
    if (!s) throw notFound();
    const run = await draftRun(s.run_id);
    const e = await loadEmployee(s.employee_id);
    await buildSlip(s.run_id, e, run.year, run.month, b.lines as PayLine[]);
    changed();
    return { ok: true };
  });
  app.delete('/payroll/slips/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const [s] = await sql<{ run_id: string }[]>`select run_id from pay_slips where id = ${id}`;
    if (!s) throw notFound();
    await draftRun(s.run_id);
    await sql`delete from pay_slips where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/payroll/runs/:id', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const run = await draftRun(id);
    await sql`delete from pay_runs where id = ${id}`;
    await audit(sql, u, { action: 'payroll.run.delete', entityType: 'pay_run', entityId: id, summary: `Entwurf ${monthName(run.month)} ${run.year} gelöscht` });
    changed();
    return { ok: true };
  });

  /** Festschreiben: Werte neu berechnen (bisherige Jahreswerte), Lohnzettel erzeugen, Mitarbeiter benachrichtigen */
  app.post('/payroll/runs/:id/finalize', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const run = await draftRun(id);
    const slips = await sql<{ id: string; employee_id: string; lines: PayLine[]; profile: PayProfile }[]>`select id, employee_id, lines, profile from pay_slips where run_id = ${id}`;
    if (!slips.length) throw badRequest('Keine Lohnzettel in diesem Monat.');
    for (const s of slips) {
      const e = await loadEmployee(s.employee_id);
      const profile = fullProfile(s.profile);
      const res = await calcSlip(ctx, e.id, run.year, run.month, profile, s.lines);
      const pdf = await payslipPdf(ctx, e, profile, res);
      const path = `.aperio/payroll/${run.year}/${String(run.month).padStart(2, '0')}/${e.personnelNo}-${randomUUID().slice(0, 8)}.pdf`;
      await storage.write(path, Readable.from(pdf));
      await sql`update pay_slips set result = ${sql.json(res as never)}, gross = ${res.gross}, net = ${res.net}, payout = ${res.payout}, employer_cost = ${res.employerCost}, pdf_path = ${path}, updated_at = now() where id = ${s.id}`;
      if (e.userId) await notify(ctx, [e.userId], { kind: 'payroll.slip', title: `Lohnzettel ${monthName(run.month)} ${run.year}`, body: 'Deine Entgeltabrechnung liegt bereit.', link: '/payslips' }).catch(() => undefined);
    }
    await sql`update pay_runs set status = 'final', finalized_at = now(), finalized_by = ${u.id} where id = ${id}`;
    await audit(sql, u, { action: 'payroll.run.finalize', entityType: 'pay_run', entityId: id, summary: `Abrechnung ${monthName(run.month)} ${run.year} festgeschrieben (${slips.length} Lohnzettel)` });
    changed();
    return { ok: true };
  });
  app.post('/payroll/runs/:id/reopen', async (req) => {
    const u = await manager(req);
    if (u.role !== 'admin') throw forbidden('Nur Administratoren können einen festgeschriebenen Monat wieder öffnen.');
    const { id } = parse(idParam, req.params);
    const [later] = await sql<{ id: string }[]>`select l.id from pay_runs l, pay_runs r where r.id = ${id} and (l.year, l.month) > (r.year, r.month) and l.status = 'final' limit 1`;
    if (later) throw badRequest('Ein späterer Monat ist schon festgeschrieben – bitte zuerst diesen öffnen.');
    await sql`update pay_runs set status = 'draft', finalized_at = null where id = ${id}`;
    await audit(sql, u, { action: 'payroll.run.reopen', entityType: 'pay_run', entityId: id, summary: 'Abrechnung wieder geöffnet (Korrektur)' });
    changed();
    return { ok: true };
  });

  app.get('/payroll/slips/:id/pdf', async (req, reply) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    return sendSlipPdf(id, reply);
  });
  async function sendSlipPdf(id: string, reply: FastifyReply) {
    const [s] = await sql<{ pdf_path: string | null; employee_id: string; lines: PayLine[]; profile: PayProfile; result: PayslipResult; personnel_no: string }[]>`
      select s.pdf_path, s.employee_id, s.lines, s.profile, s.result, e.personnel_no from pay_slips s join pay_employees e on e.id = s.employee_id where s.id = ${id}`;
    if (!s) throw notFound();
    const name = `Entgeltabrechnung_${s.result.year}-${String(s.result.month).padStart(2, '0')}_${s.personnel_no}.pdf`;
    reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${name}"`);
    if (s.pdf_path) return reply.send(storage.read(s.pdf_path));
    // Entwurf: Vorschau ohne Speichern
    const e = await loadEmployee(s.employee_id);
    return reply.send(await payslipPdf(ctx, e, fullProfile(s.profile), s.result));
  }
  /** Lohnzettel per E-Mail an die Mitarbeiter (an die im Personalstamm hinterlegte Adresse) */
  app.post('/payroll/runs/:id/send', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const [run] = await sql<{ status: string; year: number; month: number }[]>`select status, year, month from pay_runs where id = ${id}`;
    if (!run) throw notFound();
    if (run.status !== 'final') throw badRequest('Bitte den Monat zuerst festschreiben.');
    const company = (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name;
    const slips = await sql<{ id: string; pdf_path: string; email: string; first_name: string; personnel_no: string; sent_at: Date | null }[]>`select s.id, s.pdf_path, coalesce(nullif(e.email, ''), u.email, '') as email,
      e.first_name, e.personnel_no, s.sent_at from pay_slips s join pay_employees e on e.id = s.employee_id left join users u on u.id = e.user_id where s.run_id = ${id}`;
    let sent = 0; const missing: string[] = [];
    for (const s of slips) {
      if (s.sent_at) continue;
      if (!s.email) { missing.push(s.personnel_no); continue; }
      await sendMail(ctx, { to: s.email, subject: `Deine Entgeltabrechnung ${monthName(run.month)} ${run.year}`,
        text: `Hallo ${s.first_name},\n\nanbei deine Entgeltabrechnung für ${monthName(run.month)} ${run.year}.\n\nViele Grüße\n${company}`,
        attachments: [{ path: s.pdf_path, name: `Entgeltabrechnung_${run.year}-${String(run.month).padStart(2, '0')}.pdf` }] });
      await sql`update pay_slips set sent_at = now() where id = ${s.id}`;
      sent++;
    }
    await audit(sql, u, { action: 'payroll.run.send', entityType: 'pay_run', entityId: id, summary: `${sent} Lohnzettel per E-Mail versendet` });
    return { sent, missing };
  });

  // ------------------------------------------------ Auswertungen und Übergabe
  async function runData(id: string) {
    const [run] = await sql<{ year: number; month: number; status: string }[]>`select year, month, status from pay_runs where id = ${id}`;
    if (!run) throw notFound();
    const slips = await sql<{ result: PayslipResult; profile: PayProfile; personnel_no: string; first_name: string; last_name: string; health_insurer: string; iban: string; bic: string; cost_center: string; pay_type: string }[]>`
      select s.result, s.profile, e.personnel_no, e.first_name, e.last_name, e.health_insurer, e.iban, e.bic, e.cost_center, e.pay_type from pay_slips s join pay_employees e on e.id = s.employee_id
      where s.run_id = ${id} order by e.last_name, e.first_name`;
    return { run, slips };
  }
  /** Beitragsnachweise je Krankenkasse und Lohnsteuer-Anmeldung (Summen) */
  app.get('/payroll/runs/:id/summary', async (req) => {
    await manager(req);
    const { run, slips } = await runData(parse(idParam, req.params).id);
    const kassen = new Map<string, { name: string; kv: number; pv: number; rv: number; av: number; u1: number; u2: number; insolvency: number; count: number }>();
    const mini = { kv: 0, rv: 0, tax: 0, u1: 0, u2: 0, insolvency: 0, count: 0 };
    const tax = { lst: 0, soli: 0, church: 0, count: 0 };
    let gross = 0, payout = 0, employerCost = 0;
    for (const s of slips) {
      const r = s.result;
      gross += r.gross; payout += r.payout; employerCost += r.employerCost;
      if (r.minijob) {
        mini.kv += r.ag.kv; mini.rv += r.ag.rv + r.an.rv; mini.tax += r.tax.flat; mini.u1 += r.ag.u1; mini.u2 += r.ag.u2; mini.insolvency += r.ag.insolvency; mini.count++;
      } else {
        const key = s.profile.insurance === 'pkv' ? `${s.health_insurer || 'Krankenkasse für RV/AV (privat Versicherte)'}` : s.health_insurer || 'ohne Angabe';
        const k = kassen.get(key) ?? { name: key, kv: 0, pv: 0, rv: 0, av: 0, u1: 0, u2: 0, insolvency: 0, count: 0 };
        k.kv += r.an.kv + r.ag.kv; k.pv += r.an.pv + r.ag.pv; k.rv += r.an.rv + r.ag.rv; k.av += r.an.av + r.ag.av; k.u1 += r.ag.u1; k.u2 += r.ag.u2; k.insolvency += r.ag.insolvency; k.count++;
        kassen.set(key, k);
      }
      tax.lst += r.tax.lst; tax.soli += r.tax.soli; tax.church += r.tax.church; if (r.tax.lst || r.tax.soli) tax.count++;
    }
    const round = <T extends Record<string, number | string>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])) as T;
    const sv = [...kassen.values()].map((k) => ({ ...round(k), total: r2(k.kv + k.pv + k.rv + k.av + k.u1 + k.u2 + k.insolvency) }));
    const { to } = monthRange(run.year, run.month);
    const d = new Date(`${to}T12:00:00`);
    // Fälligkeit SV: drittletzter Bankarbeitstag des Monats (vereinfacht: ohne Feiertage)
    let bank = 0;
    while (true) { const wd = d.getDay(); if (wd !== 0 && wd !== 6) { bank++; if (bank === 3) break; } d.setDate(d.getDate() - 1); }
    return {
      year: run.year, month: run.month, status: run.status, gross: r2(gross), payout: r2(payout), employerCost: r2(employerCost),
      sv, minijob: mini.count ? { ...round(mini), total: r2(mini.kv + mini.rv + mini.tax + mini.u1 + mini.u2 + mini.insolvency) } : null,
      tax: { ...round(tax), total: r2(tax.lst + tax.soli + tax.church) },
      svDue: d.toISOString().slice(0, 10), taxDue: `${run.month === 12 ? run.year + 1 : run.year}-${String((run.month % 12) + 1).padStart(2, '0')}-10`,
    };
  });
  app.get('/payroll/runs/:id/journal.xlsx', async (req, reply) => {
    await manager(req);
    const { run, slips } = await runData(parse(idParam, req.params).id);
    const head = ['Pers.-Nr.', 'Name', 'Brutto', 'steuerpfl. lfd.', 'steuerpfl. einmalig', 'SV-Brutto', 'Lohnsteuer', 'Soli', 'Kirchensteuer', 'KV AN', 'PV AN', 'RV AN', 'AV AN',
      'Netto', 'Auszahlung', 'KV AG', 'PV AG', 'RV AG', 'AV AG', 'U1', 'U2', 'Insolvenzgeld', 'Pauschsteuer', 'Gesamtkosten', 'Beitragsgruppe', 'Kostenstelle'];
    const rows = slips.map((s) => { const r = s.result; return [s.personnel_no, `${s.last_name}, ${s.first_name}`, r.gross, r.taxRegular, r.taxOneOff, r.svBase, r.tax.lst, r.tax.soli, r.tax.church,
      r.an.kv, r.an.pv, r.an.rv, r.an.av, r.net, r.payout, r.ag.kv, r.ag.pv, r.ag.rv, r.ag.av, r.ag.u1, r.ag.u2, r.ag.insolvency, r.tax.flat, r.employerCost, contributionGroup(s.profile), s.cost_center]; });
    const sumRow = head.map((_, i) => (i < 2 || i >= 24 ? (i === 1 ? 'Summe' : '') : r2(rows.reduce((a, r) => a + Number(r[i]), 0))));
    const buf = writeXlsx([{ name: `Lohnjournal ${run.month}-${run.year}`, rows: [head, ...rows, sumRow], widths: [10, 26, ...head.slice(2).map(() => 12)] }]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="Lohnjournal_${run.year}-${String(run.month).padStart(2, '0')}.xlsx"`);
    return reply.send(buf);
  });
  /** Buchungsstapel für die Finanzbuchhaltung (DATEV-Format) */
  app.get('/payroll/runs/:id/datev.csv', async (req, reply) => {
    const u = await manager(req);
    const id = parse(idParam, req.params).id;
    const { run, slips } = await runData(id);
    if (run.status !== 'final') throw badRequest('Bitte den Monat zuerst festschreiben.');
    const a = (await ctx.settings.get('payroll')).accounts;
    const inv = await ctx.settings.get('invoicing');
    const { to } = monthRange(run.year, run.month);
    const docNo = `LOHN${run.year}${String(run.month).padStart(2, '0')}`;
    const B: DatevBooking[] = [];
    const add = (amount: number, account: string, contra: string, text: string, cost1?: string) => { if (Math.abs(amount) >= 0.005) B.push({ amount: r2(amount), side: amount >= 0 ? 'S' : 'H', account, contra, date: to, docNo, text, cost1 }); };
    for (const s of slips) {
      const r = s.result, name = `${s.last_name} ${s.personnel_no}`, cc = s.cost_center || undefined;
      const wageAcc = r.minijob ? a.minijob : s.pay_type === 'hourly' ? a.wages : a.salaries;
      // Bruttolohn (ohne Sachbezüge) an Verbindlichkeiten; Sachbezüge sind Erlös/Gegenbuchung beim Steuerberater
      const cash = r2(r.gross - r.lines.filter((l) => l.kind === 'benefit').reduce((x, l) => x + l.amount, 0));
      add(cash, wageAcc, a.liabilityNet, `Lohn ${monthName(run.month)} ${name}`, cc);
      const taxFree = r.lines.filter((l) => l.kind === 'taxfree').reduce((x, l) => x + l.amount, 0) + r.pkvSubsidy;
      add(taxFree, a.taxFree, a.liabilityNet, `steuerfreie Bezüge ${name}`, cc);
      add(r.tax.lst + r.tax.soli + r.tax.church, a.liabilityNet, a.liabilityTax, `Lohnsteuer ${name}`);
      add(r.an.total, a.liabilityNet, r.minijob ? a.liabilityMini : a.liabilitySv, `SV Arbeitnehmer ${name}`);
      const agSv = r2(r.ag.kv + r.ag.pv + r.ag.rv + r.ag.av + r.ag.u1 + r.ag.u2 + r.ag.insolvency);
      add(agSv, a.social, r.minijob ? a.liabilityMini : a.liabilitySv, `SV Arbeitgeber ${name}`, cc);
      add(r.tax.flat, a.flatTax, a.liabilityMini, `Pauschsteuer ${name}`, cc);
      const deductions = r.lines.filter((l) => l.kind === 'deduction').reduce((x, l) => x + l.amount, 0);
      if (deductions) B.push({ amount: r2(deductions), side: 'S', account: a.liabilityNet, contra: '1590', date: to, docNo, text: `Abzüge vom Netto ${name}` });
    }
    const buf = datevExtf({ consultantNo: inv.datev.consultantNo, clientNo: inv.datev.clientNo, fiscalYearStart: `${run.year}-01-01`, accountLength: inv.datev.accountLength,
      from: monthRange(run.year, run.month).from, to, title: `Lohn ${run.month}/${run.year}`, bookings: B });
    await sql`update pay_runs set exported_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'payroll.run.export', entityType: 'pay_run', entityId: id, summary: 'Lohnbuchungen exportiert (DATEV)' });
    reply.header('content-type', 'text/csv; charset=windows-1252').header('content-disposition', `attachment; filename="EXTF_Lohn_${run.year}-${String(run.month).padStart(2, '0')}.csv"`);
    return reply.send(buf);
  });
  /** Überweisungen der Nettolöhne als SEPA-Datei */
  app.post('/payroll/runs/:id/sepa', async (req, reply) => {
    const u = await manager(req);
    const id = parse(idParam, req.params).id;
    const b = parse(z.object({ debtorIban: z.string().min(15).max(40), debtorName: z.string().max(70).default(''), execDate: z.string().date() }), req.body);
    const { run, slips } = await runData(id);
    if (run.status !== 'final') throw badRequest('Bitte den Monat zuerst festschreiben.');
    const missing = slips.filter((s) => s.result.payout > 0 && !s.iban).map((s) => s.personnel_no);
    if (missing.length) throw badRequest(`Ohne IBAN: Personal-Nr. ${missing.join(', ')}`);
    const company = (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name;
    const xml = painCreditTransfer({ debtorName: b.debtorName || company, debtorIban: b.debtorIban, execDate: b.execDate, msgId: `LOHN-${run.year}-${run.month}-${Date.now()}`,
      payments: slips.filter((s) => s.result.payout > 0).map((s) => ({ endToEnd: `LOHN${run.year}${String(run.month).padStart(2, '0')}${s.personnel_no}`, name: `${s.first_name} ${s.last_name}`,
        iban: s.iban, bic: s.bic || undefined, amount: s.result.payout, purpose: `Lohn/Gehalt ${monthName(run.month)} ${run.year} Pers.-Nr. ${s.personnel_no}` })) });
    await audit(sql, u, { action: 'payroll.run.sepa', entityType: 'pay_run', entityId: id, summary: 'SEPA-Datei für Lohnzahlungen erstellt' });
    reply.header('content-type', 'application/xml').header('content-disposition', `attachment; filename="Lohnzahlung_${run.year}-${String(run.month).padStart(2, '0')}.xml"`);
    return reply.send(xml);
  });

  /** Brutto-Netto-Rechner (ohne Speichern) */
  app.post('/payroll/calculate', async (req) => {
    await manager(req);
    const b = parse(z.object({ year: z.number().int(), month: z.number().int().min(1).max(12), profile: profileSchema, lines: z.array(lineSchema).max(100) }), req.body);
    return computePayslip(b.year, b.month, fullProfile(b.profile), b.lines as PayLine[]);
  });
  app.get('/payroll/meta', async (req) => { await manager(req); return { groups: EMPLOYMENT_GROUPS, kinds: PAY_LINE_KINDS }; });

  // ------------------------------------------------ Eigene Lohnzettel (alle Mitarbeiter)
  app.get('/me/payslips', async (req) => {
    const u = requireUser(req);
    const apps = await ctx.settings.get('apps');
    if (!apps.installed.includes('payroll')) return [];
    return sql`select s.id, r.year, r.month, s.gross::float as gross, s.payout::float as payout from pay_slips s join pay_runs r on r.id = s.run_id join pay_employees e on e.id = s.employee_id
      where e.user_id = ${u.id} and r.status = 'final' order by r.year desc, r.month desc`;
  });
  app.get('/me/payslips/:id/pdf', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [own] = await sql`select 1 from pay_slips s join pay_runs r on r.id = s.run_id join pay_employees e on e.id = s.employee_id where s.id = ${id} and e.user_id = ${u.id} and r.status = 'final'`;
    if (!own) throw notFound();
    return sendSlipPdf(id, reply);
  });
}
