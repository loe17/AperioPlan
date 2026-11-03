/**
 * Freigaben: allgemeine Anträge (Anschaffung, Weiterbildung, …) mit frei definierbaren Feldern
 * und mehrstufiger Genehmigung – Teamleitung, bestimmte Personen oder Geschäftsführung, auch ab Wertgrenzen.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { nextNumber } from '../services/numbers';
import { safeName } from '../services/files';
import { sendStored, staffOf, toRow } from '../lib/rows';
import { writeXlsx } from '../lib/xlsx';

const FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'select', 'checkbox'] as const;
const field = z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(200), type: z.enum(FIELD_TYPES), options: z.array(z.string().max(200)).max(50).default([]), required: z.boolean().default(false) });
const step = z.object({ kind: z.enum(['lead', 'users', 'admin']), userIds: z.array(z.string().uuid()).default([]), minAmount: z.number().min(0).nullable().default(null), all: z.boolean().default(false) });
const typeBody = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().max(1000).default(''), icon: z.string().max(40).default('approve'),
  fields: z.array(field).max(30).default([]), steps: z.array(step).min(1, 'Mindestens eine Genehmigungsstufe angeben.').max(6), amountField: z.string().max(40).nullable().default(null),
  active: z.boolean().default(true), sort: z.number().int().default(0),
});
type Field = z.infer<typeof field>;
type StepDef = z.infer<typeof step>;
type Resolved = { label: string; approverIds: string[]; all: boolean };

export default async function approvalRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const changed = () => ctx.hub.publish('global', 'approvals.changed', {});
  const isManager = async (u: AuthUser) => u.role === 'admin' || (await ctx.settings.get('approvals')).managerIds.includes(u.id);
  const manager = async (req: Parameters<typeof staffOf>[0]) => { const u = staffOf(req); if (!(await isManager(u))) throw forbidden('Antragsarten verwalten Administratoren.'); return u; };
  const admins = async (except: string) => {
    const ids = (await sql<{ id: string }[]>`select id from users where role = 'admin' and active and deleted_at is null`).map((r) => r.id);
    const others = ids.filter((x) => x !== except);
    return others.length ? others : ids;
  };
  async function resolve(s: StepDef, userId: string): Promise<Resolved> {
    if (s.kind === 'lead') {
      const leads = (await sql<{ user_id: string }[]>`select distinct l.user_id from team_members m join team_members l on l.team_id = m.team_id and l.is_lead
        join users u on u.id = l.user_id and u.active where m.user_id = ${userId} and l.user_id <> ${userId}`).map((r) => r.user_id);
      return { label: 'Teamleitung', approverIds: leads.length ? leads : await admins(userId), all: false };
    }
    if (s.kind === 'users') {
      const ids = s.userIds.length ? (await sql<{ id: string }[]>`select id from users where id = any(${s.userIds}) and active and id <> ${userId}`).map((r) => r.id) : [];
      return { label: 'Genehmiger', approverIds: ids.length ? ids : await admins(userId), all: s.all };
    }
    return { label: 'Geschäftsführung', approverIds: await admins(userId), all: s.all };
  }
  function checkData(fields: Field[], data: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = data[f.id];
      const empty = v === undefined || v === null || v === '' || (f.type === 'checkbox' && v === false);
      if (empty) { if (f.required) throw badRequest(`Bitte „${f.label}“ ausfüllen.`); continue; }
      if (f.type === 'number' || f.type === 'money') { const n = Number(v); if (!Number.isFinite(n)) throw badRequest(`„${f.label}“ muss eine Zahl sein.`); out[f.id] = n; }
      else if (f.type === 'date') { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`„${f.label}“: ungültiges Datum.`); out[f.id] = v; }
      else if (f.type === 'select') { if (!f.options.includes(String(v))) throw badRequest(`„${f.label}“: ungültige Auswahl.`); out[f.id] = String(v); }
      else if (f.type === 'checkbox') out[f.id] = Boolean(v);
      else out[f.id] = String(v).slice(0, 10000);
    }
    return out;
  }
  const cols = sql`r.id, r.number, r.type_id as "typeId", t.name as "typeName", t.icon, t.fields, r.user_id as "userId", u.display_name as "userName", r.title, r.data, r.amount::float as amount,
    r.project_id as "projectId", p.number as "projectNumber", p.name as "projectName", r.files, r.status, r.step, r.steps, r.decided_at as "decidedAt", r.created_at as "createdAt", r.updated_at as "updatedAt"`;
  const from = sql`apr_requests r join apr_types t on t.id = r.type_id join users u on u.id = r.user_id left join projects p on p.id = r.project_id`;
  const canSee = async (u: AuthUser, r: { userId: string; steps: Resolved[] }) => r.userId === u.id || r.steps.some((s) => s.approverIds.includes(u.id)) || (await isManager(u));
  const pendingFor = (u: AuthUser, r: { status: string; step: number; steps: Resolved[] }, decided: { step: number; userId: string }[]) =>
    r.status === 'pending' && !!r.steps[r.step]?.approverIds.includes(u.id) && !decided.some((d) => d.step === r.step && d.userId === u.id);

  app.get('/approvals/access', async (req) => ({ manager: await isManager(staffOf(req)) }));

  // ------------------------------------------------ Antragsarten
  app.get('/approvals/types', async (req) => {
    const u = staffOf(req);
    const all = (req.query as { all?: string }).all === '1' && (await isManager(u));
    return sql`select id, name, description, icon, fields, steps, amount_field as "amountField", active, sort from apr_types ${all ? sql`` : sql`where active`} order by sort, name`;
  });
  app.post('/approvals/types', async (req) => {
    const u = await manager(req);
    const b = parse(typeBody, req.body);
    if (b.amountField && !b.fields.some((f) => f.id === b.amountField && (f.type === 'money' || f.type === 'number'))) throw badRequest('Das Betragsfeld muss ein Zahlen- oder Geldfeld sein.');
    const [t] = await sql<{ id: string }[]>`insert into apr_types ${sql(toRow(sql, b, ['fields', 'steps']))} returning id`;
    await audit(sql, u, { action: 'approvals.type.create', entityType: 'apr_type', entityId: t!.id, summary: b.name });
    changed();
    return { id: t!.id };
  });
  app.patch('/approvals/types/:id', async (req) => {
    await manager(req);
    const row = toRow(sql, parse(patchSchema(typeBody), req.body), ['fields', 'steps']);
    if (Object.keys(row).length) await sql`update apr_types set ${sql(row)} where id = ${parse(idParam, req.params).id}`;
    changed();
    return { ok: true };
  });
  app.delete('/approvals/types/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from apr_requests where type_id = ${id}`;
    if (n!.n) throw badRequest('Es gibt Anträge dieser Art – bitte deaktivieren statt löschen.');
    await sql`delete from apr_types where id = ${id}`;
    changed();
    return { ok: true };
  });

  // ------------------------------------------------ Anträge
  app.get('/approvals/requests', async (req) => {
    const u = staffOf(req);
    const q = parse(z.object({ scope: z.enum(['mine', 'todo', 'all']).default('mine'), status: z.string().max(20).optional() }), req.query);
    if (q.scope === 'all' && !(await isManager(u))) throw forbidden();
    const rows = await sql<any[]>`select ${cols} from ${from} where true
      ${q.scope === 'mine' ? sql`and r.user_id = ${u.id}` : q.scope === 'todo' ? sql`and r.status = 'pending' and r.steps -> r.step -> 'approverIds' ? ${u.id}::text` : sql``}
      ${q.status ? sql`and r.status = ${q.status}` : sql``} order by r.created_at desc limit 500`;
    if (q.scope !== 'todo') return rows;
    const decided = await sql<{ requestId: string; step: number; userId: string }[]>`select request_id as "requestId", step, user_id as "userId" from apr_decisions where user_id = ${u.id} and request_id = any(${rows.map((r) => r.id)})`;
    return rows.filter((r) => pendingFor(u, r, decided.filter((d) => d.requestId === r.id)));
  });
  async function load(id: string, u: AuthUser) {
    const [r] = await sql<any[]>`select ${cols} from ${from} where r.id = ${id}`;
    if (!r) throw notFound('Antrag nicht gefunden');
    if (!(await canSee(u, r))) throw forbidden();
    const decisions = await sql<any[]>`select d.id, d.step, d.user_id as "userId", x.display_name as "userName", d.approve, d.note, d.created_at as "createdAt"
      from apr_decisions d join users x on x.id = d.user_id where d.request_id = ${id} order by d.created_at`;
    const names = new Map((await sql<{ id: string; name: string }[]>`select id, display_name as name from users where id = any(${[...new Set(r.steps.flatMap((s: Resolved) => s.approverIds))] as string[]})`).map((x) => [x.id, x.name]));
    return { ...r, files: r.files.map((f: any) => ({ id: f.id, name: f.name })), steps: r.steps.map((s: Resolved) => ({ ...s, approvers: s.approverIds.map((x) => ({ id: x, name: names.get(x) ?? '?' })) })),
      decisions, canDecide: pendingFor(u, r, decisions), canWithdraw: r.userId === u.id && r.status === 'pending' };
  }
  app.get('/approvals/requests/:id', async (req) => load(parse(idParam, req.params).id, staffOf(req)));

  app.post('/approvals/requests', async (req) => {
    const u = staffOf(req);
    const b = parse(z.object({ typeId: z.string().uuid(), title: z.string().max(200).default(''), data: z.record(z.string(), z.unknown()).default({}), projectId: z.string().uuid().nullable().default(null) }), req.body);
    const [t] = await sql<{ name: string; fields: Field[]; steps: StepDef[]; amount_field: string | null; active: boolean }[]>`select name, fields, steps, amount_field, active from apr_types where id = ${b.typeId}`;
    if (!t || !t.active) throw notFound('Antragsart nicht gefunden');
    const data = checkData(t.fields, b.data);
    const amount = t.amount_field && typeof data[t.amount_field] === 'number' ? (data[t.amount_field] as number) : null;
    const steps: Resolved[] = [];
    for (const s of t.steps) if (s.minAmount === null || (amount ?? 0) >= s.minAmount) steps.push(await resolve(s, u.id));
    const firstText = t.fields.find((f) => f.type === 'text' && typeof data[f.id] === 'string');
    const title = b.title.trim() || (firstText ? `${t.name}: ${String(data[firstText.id]).slice(0, 120)}` : t.name);
    const number = await nextNumber(sql, 'approval', (await ctx.settings.get('numbers')).approval ?? 'FG-{JJ}-{NNNN}', async (n) => (await sql`select 1 from apr_requests where number = ${n}`).length > 0);
    const done = steps.length === 0;
    const [r] = await sql<{ id: string }[]>`insert into apr_requests (number, type_id, user_id, title, data, amount, project_id, steps, status, decided_at)
      values (${number}, ${b.typeId}, ${u.id}, ${title}, ${sql.json(data as never)}, ${amount}, ${b.projectId}, ${sql.json(steps as never)}, ${done ? 'approved' : 'pending'}, ${done ? new Date() : null}) returning id`;
    if (steps[0]) await notify(ctx, steps[0].approverIds, { kind: 'approvals.request', title: `Antrag zur Freigabe: ${title}`, body: `${u.displayName}${amount !== null ? ` · ${amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}` : ''}`, link: `/approvals?request=${r!.id}` }, u.id);
    await audit(sql, u, { action: 'approvals.request.create', entityType: 'apr_request', entityId: r!.id, summary: `${number} ${title}` });
    changed();
    return { id: r!.id, number };
  });
  app.post('/approvals/requests/:id/files', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [r] = await sql<{ user_id: string; status: string; files: { id: string; name: string; path: string }[] }[]>`select user_id, status, files from apr_requests where id = ${id}`;
    if (!r) throw notFound();
    if (r.user_id !== u.id || r.status !== 'pending') throw forbidden('Anhänge kann nur der Antragsteller hinzufügen, solange der Antrag offen ist.');
    const add: { id: string; name: string; path: string }[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (r.files.length + add.length >= 10) { await part.toBuffer(); continue; }
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'anhang.pdf');
      const fid = randomUUID();
      const path = `.aperio/approvals/${id}/${fid}-${name}`;
      await storage.write(path, part.file);
      add.push({ id: fid, name, path });
    }
    await sql`update apr_requests set files = ${sql.json([...r.files, ...add] as never)}, updated_at = now() where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.get('/approvals/requests/:id/files/:fid', async (req, reply) => {
    const u = staffOf(req);
    const p = parse(z.object({ id: z.string().uuid(), fid: z.string().uuid() }), req.params);
    const [r] = await sql<any[]>`select user_id as "userId", steps, files from apr_requests where id = ${p.id}`;
    if (!r || !(await canSee(u, r))) throw notFound();
    const f = r.files.find((x: any) => x.id === p.fid);
    if (!f) throw notFound();
    return sendStored(reply, storage, f.path, f.name);
  });

  app.post('/approvals/requests/:id/decide', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().max(2000).default('') }), req.body);
    if (!b.approve && !b.note.trim()) throw badRequest('Bitte bei einer Ablehnung kurz begründen.');
    const r = await load(id, u);
    if (!r.canDecide) throw forbidden('Du bist für diese Stufe nicht als Genehmiger eingetragen oder hast schon entschieden.');
    await sql`insert into apr_decisions (request_id, step, user_id, approve, note) values (${id}, ${r.step}, ${u.id}, ${b.approve}, ${b.note})`;
    const cur: Resolved = r.steps[r.step];
    const link = `/approvals?request=${id}`;
    if (!b.approve) {
      await sql`update apr_requests set status = 'rejected', decided_at = now(), updated_at = now() where id = ${id}`;
      await notify(ctx, [r.userId], { kind: 'approvals.decision', title: `Antrag abgelehnt: ${r.title}`, body: `${u.displayName}: ${b.note}`, link }, u.id);
    } else {
      const approvedHere = new Set([...r.decisions.filter((d: any) => d.step === r.step && d.approve).map((d: any) => d.userId), u.id]);
      const stepDone = !cur.all || cur.approverIds.every((x) => approvedHere.has(x));
      if (stepDone) {
        const next = r.step + 1;
        if (next >= r.steps.length) {
          await sql`update apr_requests set status = 'approved', step = ${next}, decided_at = now(), updated_at = now() where id = ${id}`;
          await notify(ctx, [r.userId], { kind: 'approvals.decision', title: `Antrag genehmigt: ${r.title}`, body: b.note || `von ${u.displayName}`, link }, u.id);
        } else {
          await sql`update apr_requests set step = ${next}, updated_at = now() where id = ${id}`;
          await notify(ctx, r.steps[next].approverIds, { kind: 'approvals.request', title: `Antrag zur Freigabe: ${r.title}`, body: `${r.userName} – Stufe ${next + 1} von ${r.steps.length}`, link }, u.id);
        }
      }
    }
    await audit(sql, u, { action: b.approve ? 'approvals.approve' : 'approvals.reject', entityType: 'apr_request', entityId: id, summary: `${r.number}: ${b.approve ? 'genehmigt' : 'abgelehnt'} (Stufe ${r.step + 1})` });
    changed();
    return { ok: true };
  });
  app.post('/approvals/requests/:id/withdraw', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const r = await load(id, u);
    if (!r.canWithdraw) throw badRequest('Nur offene eigene Anträge lassen sich zurückziehen.');
    await sql`update apr_requests set status = 'withdrawn', decided_at = now(), updated_at = now() where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.get('/approvals/export.xlsx', async (req, reply) => {
    await manager(req);
    const rows = await sql<any[]>`select ${cols} from ${from} order by r.created_at desc`;
    const S: Record<string, string> = { pending: 'offen', approved: 'genehmigt', rejected: 'abgelehnt', withdrawn: 'zurückgezogen' };
    const buf = writeXlsx([{ name: 'Anträge', rows: [['Nummer', 'Art', 'Titel', 'Antragsteller', 'Betrag', 'Projekt', 'Status', 'Eingereicht', 'Entschieden'],
      ...rows.map((r) => [r.number, r.typeName, r.title, r.userName, r.amount ?? '', r.projectNumber ?? '', S[r.status] ?? r.status, new Date(r.createdAt).toLocaleDateString('de-DE'), r.decidedAt ? new Date(r.decidedAt).toLocaleDateString('de-DE') : ''])],
      widths: [14, 20, 40, 22, 12, 12, 14, 12, 12] }]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', 'attachment; filename="Antraege.xlsx"');
    return reply.send(buf);
  });
}
