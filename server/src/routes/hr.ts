/**
 * Personal: digitale Personalakte mit Fristen, Mitarbeitergespräche mit Zielen, Qualifikationen (Matrix),
 * Stellenanzeigen mit öffentlichem Bewerbungsformular und Bewerberverwaltung mit Löschfristen.
 * Zugriff: Administratoren und Personalverantwortliche; jeder Mitarbeiter sieht seine freigegebenen Unterlagen unter /me/hr.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { requireUser } from '../lib/auth';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { safeName } from '../services/files';
import { staffOf, toRow, today } from '../lib/rows';

const addMonths = (d: string, m: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const goal = z.object({ text: z.string().trim().min(1).max(500), done: z.boolean().default(false), due: z.string().date().nullable().default(null) });
const reviewBody = z.object({ date: z.string().date(), kind: z.string().max(60).default('annual'), notes: z.string().max(50000).default(''), goals: z.array(goal).max(50).default([]), shared: z.boolean().default(false) });
const jobBody = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(20000).default(''), location: z.string().max(200).default(''), hours: z.string().max(100).default(''),
  status: z.enum(['draft', 'open', 'closed']).default('open'), ownerId: z.string().uuid().nullable().default(null) });
const STAGES = ['new', 'screening', 'interview', 'offer', 'hired', 'rejected'] as const;

export async function hrDaily(ctx: AppContext) {
  const { sql, storage } = ctx;
  if (!(await ctx.settings.get('apps')).installed.includes('hr')) return;
  const s = await ctx.settings.get('hr');
  const managers = [...s.managerIds, ...(await sql<{ id: string }[]>`select id from users where role = 'admin' and active`).map((r) => r.id)];
  // Fristen in 30 Tagen (einmal am Stichtag minus 30)
  const soon = addMonths(today(), 1);
  const docs = await sql<{ title: string; name: string; user_id: string }[]>`select d.title, u.display_name as name, d.user_id from hr_documents d join users u on u.id = d.user_id where d.valid_until = ${soon}`;
  const skills = await sql<{ skill: string; name: string; user_id: string }[]>`select k.name as skill, u.display_name as name, x.user_id from hr_user_skills x join hr_skills k on k.id = x.skill_id join users u on u.id = x.user_id where x.valid_until = ${soon}`;
  for (const d of docs) await notify(ctx, managers, { kind: 'hr.expiry', title: `Läuft in 30 Tagen ab: ${d.title}`, body: d.name, link: `/hr?person=${d.user_id}` });
  for (const k of skills) await notify(ctx, [...managers, k.user_id], { kind: 'hr.expiry', title: `Nachweis läuft ab: ${k.skill}`, body: k.name, link: `/hr?person=${k.user_id}` });
  // Bewerberdaten nach Ablauf der Frist löschen (DSGVO)
  const old = await sql<{ id: string; files: { path: string }[] }[]>`select id, files from hr_applicants where delete_after is not null and delete_after <= current_date`;
  for (const a of old) {
    for (const f of a.files) await storage.remove(f.path).catch(() => undefined);
    await sql`delete from hr_applicants where id = ${a.id}`;
  }
}

export default async function hrRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage, config } = ctx;
  const changed = () => ctx.hub.publish('global', 'hr.changed', {});
  const isManager = async (u: AuthUser) => u.role === 'admin' || (await ctx.settings.get('hr')).managerIds.includes(u.id);
  const manager = async (req: Parameters<typeof staffOf>[0]) => { const u = staffOf(req); if (!(await isManager(u))) throw forbidden('Personalakten sehen nur Personalverantwortliche.'); return u; };
  const sendFile = (reply: FastifyReply, path: string, name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    const type = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
    reply.header('content-type', type).header('content-disposition', `inline; filename="${encodeURIComponent(name)}"`);
    return reply.send(storage.read(path));
  };

  app.get('/hr/access', async (req) => ({ manager: await isManager(staffOf(req)) }));

  // ------------------------------------------------ Mitarbeiter
  app.get('/hr/people', async (req) => {
    await manager(req);
    return sql`select u.id, u.display_name as "displayName", u.email, u.role,
      (select count(*)::int from hr_documents d where d.user_id = u.id) as documents,
      (select count(*)::int from hr_documents d where d.user_id = u.id and d.valid_until < current_date + 60) as expiring,
      (select max(date)::text from hr_reviews r where r.user_id = u.id) as "lastReview",
      (select count(*)::int from hr_user_skills s where s.user_id = u.id) as skills
      from users u where u.active and u.role <> 'guest' and u.deleted_at is null order by u.display_name`;
  });
  app.get('/hr/people/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const [u] = await sql`select id, display_name as "displayName", email, phone from users where id = ${id}`;
    if (!u) throw notFound();
    return { ...u, ...(await personData(id, false)) };
  });
  async function personData(userId: string, ownView: boolean) {
    const documents = await sql`select d.id, d.category, d.title, d.file_name as "fileName", d.valid_until::text as "validUntil", d.visible_to_employee as "visibleToEmployee", d.created_at as "createdAt"
      from hr_documents d where d.user_id = ${userId} ${ownView ? sql`and d.visible_to_employee` : sql``} order by d.category, d.created_at desc`;
    const reviews = await sql`select r.id, r.date::text, r.kind, r.notes, r.goals, r.shared, u.display_name as "createdByName", r.updated_at as "updatedAt" from hr_reviews r left join users u on u.id = r.created_by
      where r.user_id = ${userId} ${ownView ? sql`and r.shared` : sql``} order by r.date desc`;
    const skills = await sql`select k.id, k.name, k.category, x.level, x.valid_until::text as "validUntil", x.note, x.certificate_name as "certificateName", x.certificate_path is not null as "hasCertificate"
      from hr_user_skills x join hr_skills k on k.id = x.skill_id where x.user_id = ${userId} order by k.category, k.name`;
    return { documents, reviews, skills };
  }
  app.get('/me/hr', async (req) => {
    const u = requireUser(req);
    if (!(await ctx.settings.get('apps')).installed.includes('hr')) return { documents: [], reviews: [], skills: [] };
    return personData(u.id, true);
  });
  app.post('/hr/people/:id/documents', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const fields: Record<string, string> = {};
    let file: { path: string; name: string } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'dokument.pdf');
        const path = `.aperio/hr/${id}/${randomUUID()}-${name}`;
        await storage.write(path, part.file);
        file = { path, name };
      } else fields[part.fieldname] = String(part.value);
    }
    if (!file) throw badRequest('Bitte eine Datei auswählen.');
    const b = parse(z.object({ category: z.string().max(100).default('Sonstiges'), title: z.string().max(200).default(''), validUntil: z.string().date().optional().or(z.literal('')), visibleToEmployee: z.enum(['true', 'false']).default('false') }), fields);
    const [d] = await sql<{ id: string }[]>`insert into hr_documents (user_id, category, title, file_path, file_name, valid_until, visible_to_employee, created_by)
      values (${id}, ${b.category}, ${b.title || file.name}, ${file.path}, ${file.name}, ${b.validUntil || null}, ${b.visibleToEmployee === 'true'}, ${u.id}) returning id`;
    if (b.visibleToEmployee === 'true') await notify(ctx, [id], { kind: 'hr.document', title: 'Neues Dokument in deiner Personalakte', body: b.title || file.name, link: '/my-hr' }, u.id);
    await audit(sql, u, { action: 'hr.document.add', entityType: 'user', entityId: id, summary: `Personalakte: ${b.category} hinzugefügt` });
    changed();
    return { id: d!.id };
  });
  app.patch('/hr/documents/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ category: z.string().max(100).optional(), title: z.string().max(200).optional(), validUntil: z.string().date().nullable().optional(), visibleToEmployee: z.boolean().optional() }), req.body);
    const row = toRow(sql, b);
    if (Object.keys(row).length) await sql`update hr_documents set ${sql(row)} where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/hr/documents/:id', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const [d] = await sql<{ user_id: string; title: string }[]>`delete from hr_documents where id = ${id} returning user_id, title`;
    if (d) await audit(sql, u, { action: 'hr.document.delete', entityType: 'user', entityId: d.user_id, summary: `Personalakte: „${d.title}“ gelöscht` });
    changed();
    return { ok: true };
  });
  // auch unter /me erreichbar, damit Mitarbeiter ohne Personal-Werkzeug ihre eigenen Unterlagen sehen
  for (const prefix of ['/hr', '/me/hr']) app.get(`${prefix}/documents/:id/file`, async (req, reply) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [d] = await sql<{ user_id: string; visible_to_employee: boolean; file_path: string; file_name: string }[]>`select user_id, visible_to_employee, file_path, file_name from hr_documents where id = ${id}`;
    if (!d) throw notFound();
    if (!(await isManager(u)) && !(d.user_id === u.id && d.visible_to_employee)) throw forbidden();
    return sendFile(reply, d.file_path, d.file_name);
  });

  // Gespräche
  app.post('/hr/people/:id/reviews', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(reviewBody, req.body);
    const [r] = await sql<{ id: string }[]>`insert into hr_reviews ${sql({ ...toRow(sql, b, ['goals']), user_id: id, created_by: u.id })} returning id`;
    if (b.shared) await notify(ctx, [id], { kind: 'hr.review', title: 'Protokoll deines Mitarbeitergesprächs', body: new Date(`${b.date}T12:00:00`).toLocaleDateString('de-DE'), link: '/my-hr' }, u.id);
    changed();
    return { id: r!.id };
  });
  for (const prefix of ['/hr', '/me/hr']) app.patch(`${prefix}/reviews/:id`, async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [r] = await sql<{ user_id: string; shared: boolean; goals: z.infer<typeof goal>[] }[]>`select user_id, shared, goals from hr_reviews where id = ${id}`;
    if (!r) throw notFound();
    if (!(await isManager(u))) {
      // Mitarbeiter dürfen bei geteilten Gesprächen nur ihre Ziele abhaken
      if (r.user_id !== u.id || !r.shared) throw forbidden();
      const b = parse(z.object({ goals: z.array(z.object({ done: z.boolean() })) }), req.body);
      await sql`update hr_reviews set goals = ${sql.json(r.goals.map((g, i) => ({ ...g, done: b.goals[i]?.done ?? g.done })) as never)}, updated_at = now() where id = ${id}`;
    } else {
      const row = toRow(sql, parse(patchSchema(reviewBody), req.body), ['goals']);
      if (Object.keys(row).length) await sql`update hr_reviews set ${sql(row)}, updated_at = now() where id = ${id}`;
    }
    changed();
    return { ok: true };
  });
  app.delete('/hr/reviews/:id', async (req) => { await manager(req); await sql`delete from hr_reviews where id = ${parse(idParam, req.params).id}`; changed(); return { ok: true }; });

  // Qualifikationen
  app.get('/hr/skills', async (req) => { staffOf(req); return sql`select id, name, category, needs_certificate as "needsCertificate" from hr_skills order by category, name`; });
  const skillBody = z.object({ name: z.string().trim().min(1).max(120), category: z.string().max(100).default(''), needsCertificate: z.boolean().default(false) });
  app.post('/hr/skills', async (req) => {
    await manager(req);
    const [k] = await sql<{ id: string }[]>`insert into hr_skills ${sql(toRow(sql, parse(skillBody, req.body)))} returning id`.catch((e: Error) => { throw /unique/.test(e.message) ? badRequest('Gibt es schon.') : e; });
    changed();
    return { id: k!.id };
  });
  app.patch('/hr/skills/:id', async (req) => {
    await manager(req);
    const row = toRow(sql, parse(patchSchema(skillBody), req.body));
    if (Object.keys(row).length) await sql`update hr_skills set ${sql(row)} where id = ${parse(idParam, req.params).id}`;
    changed();
    return { ok: true };
  });
  app.delete('/hr/skills/:id', async (req) => { await manager(req); await sql`delete from hr_skills where id = ${parse(idParam, req.params).id}`; changed(); return { ok: true }; });
  app.get('/hr/matrix', async (req) => {
    staffOf(req);
    const skills = await sql`select id, name, category from hr_skills order by category, name`;
    const people = await sql`select id, display_name as "displayName" from users where active and role <> 'guest' and deleted_at is null order by display_name`;
    const values = await sql`select user_id as "userId", skill_id as "skillId", level, valid_until::text as "validUntil" from hr_user_skills`;
    return { skills, people, values };
  });
  app.put('/hr/people/:id/skills/:skillId', async (req) => {
    await manager(req);
    const p = parse(z.object({ id: z.string().uuid(), skillId: z.string().uuid() }), req.params);
    const b = parse(z.object({ level: z.number().int().min(1).max(4), validUntil: z.string().date().nullable().default(null), note: z.string().max(500).default('') }), req.body);
    await sql`insert into hr_user_skills (user_id, skill_id, level, valid_until, note) values (${p.id}, ${p.skillId}, ${b.level}, ${b.validUntil}, ${b.note})
      on conflict (user_id, skill_id) do update set level = excluded.level, valid_until = excluded.valid_until, note = excluded.note, updated_at = now()`;
    changed();
    return { ok: true };
  });
  app.delete('/hr/people/:id/skills/:skillId', async (req) => {
    await manager(req);
    const p = parse(z.object({ id: z.string().uuid(), skillId: z.string().uuid() }), req.params);
    await sql`delete from hr_user_skills where user_id = ${p.id} and skill_id = ${p.skillId}`;
    changed();
    return { ok: true };
  });
  app.post('/hr/people/:id/skills/:skillId/certificate', async (req) => {
    await manager(req);
    const p = parse(z.object({ id: z.string().uuid(), skillId: z.string().uuid() }), req.params);
    const f = await req.file();
    if (!f) throw badRequest('Keine Datei');
    const name = safeName(f.filename.split(/[\\/]/).pop() ?? 'nachweis.pdf');
    const path = `.aperio/hr/${p.id}/skills/${randomUUID()}-${name}`;
    await storage.write(path, f.file);
    const r = await sql`update hr_user_skills set certificate_path = ${path}, certificate_name = ${name}, updated_at = now() where user_id = ${p.id} and skill_id = ${p.skillId}`;
    if (!r.count) throw notFound('Qualifikation zuerst eintragen.');
    changed();
    return { ok: true };
  });
  app.get('/hr/people/:id/skills/:skillId/certificate', async (req, reply) => {
    const u = staffOf(req);
    const p = parse(z.object({ id: z.string().uuid(), skillId: z.string().uuid() }), req.params);
    if (p.id !== u.id && !(await isManager(u))) throw forbidden();
    const [x] = await sql<{ certificate_path: string | null; certificate_name: string }[]>`select certificate_path, certificate_name from hr_user_skills where user_id = ${p.id} and skill_id = ${p.skillId}`;
    if (!x?.certificate_path) throw notFound();
    return sendFile(reply, x.certificate_path, x.certificate_name);
  });

  // ------------------------------------------------ Stellen und Bewerbungen
  const jobUrl = (token: string) => `${config.publicUrl}/jobs/${token}`;
  app.get('/hr/jobs', async (req) => {
    await manager(req);
    const rows = await sql<any[]>`select j.id, j.title, j.description, j.location, j.hours, j.status, j.public_token as token, j.owner_id as "ownerId", j.created_at as "createdAt",
      (select count(*)::int from hr_applicants a where a.job_id = j.id) as applicants, (select count(*)::int from hr_applicants a where a.job_id = j.id and a.stage = 'new') as "newApplicants"
      from hr_jobs j order by (j.status = 'closed'), j.created_at desc`;
    return rows.map((r) => ({ ...r, publicUrl: jobUrl(r.token) }));
  });
  app.post('/hr/jobs', async (req) => {
    const u = await manager(req);
    const b = parse(jobBody, req.body);
    const [j] = await sql<{ id: string }[]>`insert into hr_jobs ${sql({ ...toRow(sql, { ...b, ownerId: b.ownerId ?? u.id }), public_token: randomBytes(12).toString('base64url') })} returning id`;
    changed();
    return { id: j!.id };
  });
  app.patch('/hr/jobs/:id', async (req) => {
    await manager(req);
    const row = toRow(sql, parse(patchSchema(jobBody), req.body));
    if (Object.keys(row).length) await sql`update hr_jobs set ${sql(row)} where id = ${parse(idParam, req.params).id}`;
    changed();
    return { ok: true };
  });
  app.delete('/hr/jobs/:id', async (req) => { await manager(req); await sql`delete from hr_jobs where id = ${parse(idParam, req.params).id}`; changed(); return { ok: true }; });
  app.get('/hr/applicants', async (req) => {
    await manager(req);
    const q = parse(z.object({ jobId: z.string().uuid().optional() }), req.query);
    return sql`select a.id, a.job_id as "jobId", j.title as "jobTitle", a.name, a.email, a.phone, a.stage, a.rating, a.notes, a.message, a.files, a.delete_after::text as "deleteAfter", a.created_at as "createdAt"
      from hr_applicants a left join hr_jobs j on j.id = a.job_id where true ${q.jobId ? sql`and a.job_id = ${q.jobId}` : sql``} order by a.created_at desc`;
  });
  app.patch('/hr/applicants/:id', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ stage: z.enum(STAGES).optional(), rating: z.number().int().min(0).max(5).optional(), notes: z.string().max(20000).optional() }), req.body);
    const row = toRow(sql, b);
    if (b.stage === 'rejected' || b.stage === 'hired') row.delete_after = addMonths(today(), (await ctx.settings.get('hr')).applicantRetentionMonths);
    else if (b.stage) row.delete_after = null;
    if (Object.keys(row).length) await sql`update hr_applicants set ${sql(row)}, updated_at = now() where id = ${id}`;
    if (b.stage) await audit(sql, u, { action: 'hr.applicant.stage', entityType: 'hr_applicant', entityId: id, summary: `Bewerbung: ${b.stage}` });
    changed();
    return { ok: true };
  });
  app.delete('/hr/applicants/:id', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from hr_applicants where id = ${id}`;
    await audit(sql, u, { action: 'hr.applicant.delete', entityType: 'hr_applicant', entityId: id, summary: 'Bewerbung gelöscht' });
    changed();
    return { ok: true };
  });
  app.get('/hr/applicants/:id/files/:fid', async (req, reply) => {
    await manager(req);
    const p = parse(z.object({ id: z.string().uuid(), fid: z.string().uuid() }), req.params);
    const [a] = await sql<{ files: { id: string; path: string; name: string }[] }[]>`select files from hr_applicants where id = ${p.id}`;
    const f = a?.files.find((x) => x.id === p.fid);
    if (!f) throw notFound();
    return sendFile(reply, f.path, f.name);
  });

  // Öffentlich: Stellenanzeige und Bewerbung
  const pubJob = async (token: string) => {
    if (!(await ctx.settings.get('apps')).installed.includes('hr')) throw notFound();
    const [j] = await sql<{ id: string; title: string; description: string; location: string; hours: string; status: string; owner_id: string | null }[]>`select id, title, description, location, hours, status, owner_id from hr_jobs where public_token = ${token}`;
    if (!j || j.status === 'draft') throw notFound('Stelle nicht gefunden');
    return j;
  };
  app.get('/pub/jobs/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(8).max(60) }), req.params);
    const j = await pubJob(token);
    const company = (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name;
    return { title: j.title, description: j.description, location: j.location, hours: j.hours, open: j.status === 'open', company };
  });
  app.post('/pub/jobs/:token', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(8).max(60) }), req.params);
    const j = await pubJob(token);
    if (j.status !== 'open') throw badRequest('Diese Stelle ist bereits besetzt.');
    const fields: Record<string, string> = {};
    const files: { id: string; path: string; name: string }[] = [];
    const appId = randomUUID();
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (files.length >= 5) { await part.toBuffer(); continue; }
        const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'unterlagen.pdf');
        if (!/\.(pdf|docx?|odt|jpe?g|png)$/i.test(name)) { await part.toBuffer(); continue; }
        const fid = randomUUID();
        const path = `.aperio/hr/applicants/${appId}/${fid}-${name}`;
        await storage.write(path, part.file);
        files.push({ id: fid, path, name });
      } else fields[part.fieldname] = String(part.value);
    }
    const b = parse(z.object({ name: z.string().trim().min(2).max(200), email: z.string().trim().email().max(200), phone: z.string().max(60).default(''), message: z.string().max(10000).default(''),
      consent: z.literal('true', { message: 'Bitte der Verarbeitung der Daten zustimmen.' }), website: z.string().max(0).default('') }), fields);
    await sql`insert into hr_applicants (id, job_id, name, email, phone, message, files) values (${appId}, ${j.id}, ${b.name}, ${b.email}, ${b.phone}, ${b.message}, ${sql.json(files as never)})`;
    const s = await ctx.settings.get('hr');
    await notify(ctx, [j.owner_id, ...s.managerIds], { kind: 'hr.applicant', title: `Neue Bewerbung: ${j.title}`, body: b.name, link: '/hr?tab=applicants' });
    changed();
    return { ok: true };
  });
}
