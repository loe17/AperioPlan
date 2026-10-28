/**
 * Formulare und Umfragen (Umfang wie Nextcloud Forms): Fragen zusammenstellen, intern teilen oder per
 * öffentlichem Link verteilen, Antworten auswerten (Zusammenfassung, Einzelantworten) und als Excel/CSV ausgeben.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEFAULT_FORM_SETTINGS, FORM_QUESTION_TYPES, FORM_TYPE_LABELS, validateFormAnswers, type FormAnswers, type FormQuestion, type FormSettings,
} from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { writeCsv, writeXlsx } from '../lib/xlsx';
import { safeName } from '../services/files';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { sendStoredFile } from './files';

interface FormRow { id: string; title: string; description: string; owner_id: string; settings: Partial<FormSettings>; public_token: string | null; archived: boolean; created_at: Date; updated_at: Date }
type Perm = 'none' | 'submit' | 'results' | 'edit' | 'owner';
const RANK: Record<Perm, number> = { none: 0, submit: 1, results: 2, edit: 3, owner: 4 };

const questionSchema = z.object({
  id: z.string().uuid(), type: z.enum(FORM_QUESTION_TYPES), text: z.string().max(2000).default(''), description: z.string().max(5000).default(''),
  required: z.boolean().default(false), options: z.array(z.object({ id: z.string().max(40), text: z.string().max(500) })).max(200).default([]),
  extra: z.record(z.string(), z.unknown()).default({}),
});

export default async function formRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage, config } = ctx;
  const settingsOf = (f: FormRow): FormSettings => ({ ...DEFAULT_FORM_SETTINGS, ...(f.settings ?? {}) });
  const isOpen = (s: FormSettings) => !s.closed && !(s.expiresAt && new Date(s.expiresAt) < new Date());

  async function load(id: string) {
    const [f] = await sql<FormRow[]>`select * from forms where id = ${id}`;
    if (!f) throw notFound('Formular nicht gefunden');
    return f;
  }
  async function perm(u: AuthUser, f: FormRow): Promise<Perm> {
    if (f.owner_id === u.id) return 'owner';
    if (u.role === 'admin') return 'edit';
    const rows = await sql<{ permission: Perm }[]>`select permission from form_shares where form_id = ${f.id}
      and (user_id = ${u.id} or everyone or team_id in (select team_id from team_members where user_id = ${u.id}))`;
    return rows.reduce<Perm>((best, r) => (RANK[r.permission] > RANK[best] ? r.permission : best), 'none');
  }
  async function need(u: AuthUser, id: string, p: Perm) {
    const f = await load(id);
    const has = await perm(u, f);
    if (RANK[has] < RANK[p]) throw forbidden(has === 'none' ? 'Kein Zugriff auf dieses Formular' : 'Dafür fehlt die Berechtigung');
    return { f, has };
  }
  const questions = async (formId: string) => (await sql<(FormQuestion & { sort: number })[]>`select id, type, text, description, required, options, extra, sort from form_questions where form_id = ${formId} order by sort`)
    .map(({ sort: _s, ...q }) => q as FormQuestion);

  // ------------------------------------------------ Liste und Bearbeiten
  app.get('/forms', async (req) => {
    const u = requireUser(req);
    const { filter } = parse(z.object({ filter: z.enum(['mine', 'shared', 'archived']).default('mine') }), req.query);
    const base = sql`select f.id, f.title, f.description, f.settings, f.archived, f.public_token is not null as "isPublic", f.owner_id as "ownerId", o.display_name as "ownerName",
      f.created_at as "createdAt", f.updated_at as "updatedAt",
      (select count(*)::int from form_responses r where r.form_id = f.id) as responses,
      (select count(*)::int from form_questions q where q.form_id = f.id and q.type <> 'section') as questions,
      exists (select 1 from form_responses r where r.form_id = f.id and r.user_id = ${u.id}) as answered
      from forms f join users o on o.id = f.owner_id`;
    if (filter === 'shared') {
      return sql`${base} where f.owner_id <> ${u.id} and not f.archived and exists (select 1 from form_shares s where s.form_id = f.id
        and (s.user_id = ${u.id} or s.everyone or s.team_id in (select team_id from team_members where user_id = ${u.id}))) order by f.updated_at desc`;
    }
    return sql`${base} where f.owner_id = ${u.id} and f.archived = ${filter === 'archived'} order by f.updated_at desc`;
  });

  app.post('/forms', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(z.object({ title: z.string().max(300).default('') }), req.body ?? {});
    const [f] = await sql<{ id: string }[]>`insert into forms (title, owner_id, settings) values (${b.title}, ${u.id}, ${sql.json(DEFAULT_FORM_SETTINGS as never)}) returning id`;
    return { id: f!.id };
  });

  app.post('/forms/:id/duplicate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { f } = await need(u, id, 'edit');
    const [n] = await sql<{ id: string }[]>`insert into forms (title, description, owner_id, settings) values (${`${f.title} (Kopie)`}, ${f.description}, ${u.id}, ${sql.json(f.settings as never)}) returning id`;
    for (const q of await questions(id)) {
      await sql`insert into form_questions (id, form_id, sort, type, text, description, required, options, extra)
        select ${randomUUID()}, ${n!.id}, sort, type, text, description, required, options, extra from form_questions where id = ${q.id}`;
    }
    return { id: n!.id };
  });

  app.get('/forms/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { f, has } = await need(u, id, 'results');
    const shares = await sql`select s.user_id as "userId", us.display_name as "userName", s.team_id as "teamId", t.name as "teamName", s.everyone, s.permission
      from form_shares s left join users us on us.id = s.user_id left join teams t on t.id = s.team_id where s.form_id = ${id}`;
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from form_responses where form_id = ${id}`)[0]?.n ?? 0;
    return { id: f.id, title: f.title, description: f.description, settings: settingsOf(f), archived: f.archived, ownerId: f.owner_id, permission: has,
      publicUrl: f.public_token ? `${config.publicUrl}/form/${f.public_token}` : null, questions: await questions(id), shares, responses: n };
  });

  app.patch('/forms/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { f } = await need(u, id, 'edit');
    const b = parse(z.object({
      title: z.string().max(300).optional(), description: z.string().max(20000).optional(), archived: z.boolean().optional(),
      settings: z.object({ anonymous: z.boolean(), allowMultiple: z.boolean(), allowEdit: z.boolean(), expiresAt: z.string().datetime({ offset: true }).nullable(),
        closed: z.boolean(), submitMessage: z.string().max(5000), showResultsToRespondents: z.boolean() }).partial().optional(),
      publicLink: z.boolean().optional(),
    }), req.body);
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from form_responses where form_id = ${id}`)[0]?.n ?? 0;
    if (b.settings?.anonymous === false && settingsOf(f).anonymous && n > 0) throw badRequest('Bereits anonym gesammelte Antworten können nicht nachträglich namentlich werden');
    const settings = b.settings ? { ...settingsOf(f), ...b.settings } : settingsOf(f);
    const token = b.publicLink === undefined ? f.public_token : b.publicLink ? f.public_token ?? randomBytes(15).toString('base64url') : null;
    await sql`update forms set title = coalesce(${b.title ?? null}, title), description = coalesce(${b.description ?? null}, description),
      archived = coalesce(${b.archived ?? null}, archived), settings = ${sql.json(settings as never)}, public_token = ${token}, updated_at = now() where id = ${id}`;
    return { ok: true, publicUrl: token ? `${config.publicUrl}/form/${token}` : null };
  });

  app.delete('/forms/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { f } = await need(u, id, 'owner');
    await sql`delete from forms where id = ${id}`;
    await storage.remove(`.aperio/forms/${id}`).catch(() => {});
    await audit(sql, u, { action: 'form.delete', entityType: 'form', entityId: id, summary: `Formular „${f.title}“ gelöscht` });
    return { ok: true };
  });

  /** Fragen speichern (ganze Liste in Reihenfolge) */
  app.put('/forms/:id/questions', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await need(u, id, 'edit');
    const b = parse(z.object({ questions: z.array(questionSchema).max(300) }), req.body);
    await sql.begin(async (tx) => {
      const ids = b.questions.map((q) => q.id);
      await tx`delete from form_questions where form_id = ${id} and not (id = any(${ids}))`;
      let i = 0;
      for (const q of b.questions) {
        const opts = q.options.map((o) => ({ id: o.id || randomUUID().slice(0, 8), text: o.text }));
        await tx`insert into form_questions (id, form_id, sort, type, text, description, required, options, extra)
          values (${q.id}, ${id}, ${i++}, ${q.type}, ${q.text}, ${q.description}, ${q.required}, ${tx.json(opts)}, ${tx.json(q.extra as never)})
          on conflict (id) do update set sort = excluded.sort, type = excluded.type, text = excluded.text, description = excluded.description,
            required = excluded.required, options = excluded.options, extra = excluded.extra where form_questions.form_id = ${id}`;
      }
      await tx`update forms set updated_at = now() where id = ${id}`;
    });
    return { ok: true };
  });

  app.put('/forms/:id/shares', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { f } = await need(u, id, 'edit');
    const b = parse(z.object({ shares: z.array(z.object({ userId: z.string().uuid().nullable().default(null), teamId: z.string().uuid().nullable().default(null),
      everyone: z.boolean().default(false), permission: z.enum(['submit', 'results', 'edit']) })).max(500), notify: z.boolean().default(true) }), req.body);
    const before = (await sql<{ user_id: string }[]>`select user_id from form_shares where form_id = ${id} and user_id is not null`).map((r) => r.user_id);
    await sql.begin(async (tx) => {
      await tx`delete from form_shares where form_id = ${id}`;
      for (const s of b.shares) await tx`insert into form_shares (form_id, user_id, team_id, everyone, permission) values (${id}, ${s.userId}, ${s.teamId}, ${s.everyone}, ${s.permission}) on conflict do nothing`;
    });
    const fresh = b.shares.filter((s) => s.userId && !before.includes(s.userId)).map((s) => s.userId!);
    if (b.notify && fresh.length) await notify(ctx, fresh, { kind: 'forms.share', title: `Formular: ${f.title || 'Ohne Titel'}`, body: 'Bitte ausfüllen', link: `/forms/${id}/fill` }, u.id);
    return { ok: true };
  });

  // ------------------------------------------------ Ausfüllen
  const fillView = async (f: FormRow, userId: string | null) => {
    const s = settingsOf(f);
    const qs = await questions(f.id);
    const mine = userId && !s.anonymous ? await sql`select id, answers, created_at as "createdAt", updated_at as "updatedAt" from form_responses where form_id = ${f.id} and user_id = ${userId} order by created_at desc` : [];
    const answered = userId ? (await sql`select 1 from form_responses where form_id = ${f.id} and user_id = ${userId} limit 1`).length > 0 : false;
    // Mischen der Antwortmöglichkeiten
    const shuffled = qs.map((q) => (q.extra.shuffle ? { ...q, options: [...q.options].sort(() => Math.random() - 0.5) } : q));
    return { id: f.id, title: f.title, description: f.description, questions: shuffled, open: isOpen(s), expiresAt: s.expiresAt, anonymous: s.anonymous,
      allowMultiple: s.allowMultiple, allowEdit: s.allowEdit && !s.anonymous, submitMessage: s.submitMessage, answered, myResponses: mine, showResults: s.showResultsToRespondents };
  };

  app.get('/forms/:id/fill', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { f } = await need(u, id, 'submit');
    return fillView(f, u.id);
  });

  /** Datei für eine Frage vom Typ „Datei hochladen“ (liegt bis zum Absenden zwischen) */
  async function uploadFor(f: FormRow, req: FastifyRequest) {
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'datei');
      const path = `.aperio/forms/${f.id}/tmp/${randomUUID()}/${name}`;
      const r = await storage.write(path, part.file);
      if (r.size > 100 * 1024 * 1024) { await storage.remove(path).catch(() => {}); throw badRequest('Datei größer als 100 MB'); }
      out.push({ name, path, size: r.size });
    }
    return out;
  }
  app.post('/forms/:id/uploads', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { f } = await need(u, id, 'submit');
    return uploadFor(f, req);
  });

  /** Antworten prüfen und Dateien aus dem Zwischenspeicher an ihren Platz legen */
  async function prepare(f: FormRow, answers: FormAnswers, responseId: string) {
    const qs = await questions(f.id);
    const errors = validateFormAnswers(qs, answers);
    if (Object.keys(errors).length) throw Object.assign(badRequest('Bitte die markierten Fragen prüfen'), { details: errors });
    const clean: FormAnswers = {};
    for (const q of qs) {
      if (q.type === 'section') continue;
      let v = answers[q.id] ?? null;
      if (q.type === 'file' && Array.isArray(v)) {
        const files = [];
        for (const file of v as { name: string; path: string; size: number }[]) {
          if (!file.path.startsWith(`.aperio/forms/${f.id}/`) || file.path.includes('..')) throw badRequest('Ungültige Datei');
          if (file.path.includes('/tmp/')) {
            const target = `.aperio/forms/${f.id}/${responseId}/${q.id}/${safeName(file.name)}`;
            await storage.move(file.path, target);
            files.push({ name: file.name, path: target, size: file.size });
          } else files.push(file);
        }
        v = files;
      }
      clean[q.id] = v;
      if (typeof answers[`other:${q.id}`] === 'string' && (answers[`other:${q.id}`] as string).trim()) clean[`other:${q.id}`] = (answers[`other:${q.id}`] as string).trim().slice(0, 2000);
    }
    return clean;
  }

  async function submit(f: FormRow, userId: string | null, answers: FormAnswers, isPublic: boolean) {
    const s = settingsOf(f);
    if (!isOpen(s)) throw badRequest('Dieses Formular nimmt keine Antworten mehr an');
    if (userId && !s.allowMultiple) {
      const [done] = await sql`select 1 from form_responses where form_id = ${f.id} and user_id = ${userId}`;
      if (done) throw badRequest('Sie haben dieses Formular bereits ausgefüllt');
    }
    const id = randomUUID();
    const clean = await prepare(f, answers, id);
    // anonym: Teilnahme wird gemerkt (doppelte Antworten verhindern), die Antwort selbst aber ohne Namen gespeichert
    await sql`insert into form_responses (id, form_id, user_id, public, answers) values (${id}, ${f.id}, ${userId}, ${isPublic}, ${sql.json(clean as never)})`;
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from form_responses where form_id = ${f.id}`)[0]?.n ?? 0;
    if (n === 1 || n % 10 === 0) await notify(ctx, [f.owner_id], { kind: 'forms.response', title: `${n} Antwort${n > 1 ? 'en' : ''}: ${f.title || 'Formular'}`, link: `/forms/${f.id}?tab=results` }, userId ?? undefined);
    return { id, message: s.submitMessage };
  }

  app.post('/forms/:id/responses', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { f } = await need(u, id, 'submit');
    const b = parse(z.object({ answers: z.record(z.string(), z.unknown()) }), req.body);
    return submit(f, u.id, b.answers as FormAnswers, false);
  });

  app.put('/forms/:id/responses/:rid', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().uuid(), rid: z.string().uuid() }), req.params);
    const { f } = await need(u, p.id, 'submit');
    const s = settingsOf(f);
    if (!s.allowEdit || s.anonymous) throw forbidden('Antworten können bei diesem Formular nicht geändert werden');
    if (!isOpen(s)) throw badRequest('Dieses Formular ist geschlossen');
    const [r] = await sql<{ user_id: string | null }[]>`select user_id from form_responses where id = ${p.rid} and form_id = ${p.id}`;
    if (!r || r.user_id !== u.id) throw notFound();
    const b = parse(z.object({ answers: z.record(z.string(), z.unknown()) }), req.body);
    const clean = await prepare(f, b.answers as FormAnswers, p.rid);
    await sql`update form_responses set answers = ${sql.json(clean as never)}, updated_at = now() where id = ${p.rid}`;
    return { ok: true, message: s.submitMessage };
  });

  // ------------------------------------------------ Ergebnisse
  async function resultsAccess(u: AuthUser, id: string) {
    const f = await load(id);
    const has = await perm(u, f);
    if (RANK[has] >= RANK.results) return f;
    if (settingsOf(f).showResultsToRespondents && has === 'submit') {
      const [done] = await sql`select 1 from form_responses where form_id = ${id} and user_id = ${u.id}`;
      if (done) return f;
    }
    throw forbidden('Die Ergebnisse sind für Sie nicht freigegeben');
  }

  const responsesOf = async (f: FormRow) => {
    const anon = settingsOf(f).anonymous;
    return sql<{ id: string; userName: string | null; public: boolean; answers: FormAnswers; createdAt: Date }[]>`select r.id, ${anon ? null : sql`u.display_name`} as "userName", r.public, r.answers, r.created_at as "createdAt"
      from form_responses r left join users u on u.id = r.user_id where r.form_id = ${f.id} order by r.created_at`;
  };

  app.get('/forms/:id/results', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const f = await resultsAccess(u, id);
    const qs = await questions(id);
    const rs = await responsesOf(f);
    const full = RANK[await perm(u, f)] >= RANK.results;
    const summary = qs.filter((q) => q.type !== 'section').map((q) => {
      const vals = rs.map((r) => r.answers[q.id]).filter((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
      const base = { id: q.id, type: q.type, text: q.text, answered: vals.length };
      if (q.type === 'single' || q.type === 'dropdown' || q.type === 'multiple') {
        const counts = q.options.map((o) => ({ id: o.id, text: o.text, count: vals.filter((v) => (Array.isArray(v) ? (v as string[]).includes(o.id) : v === o.id)).length }));
        const others = rs.map((r) => r.answers[`other:${q.id}`]).filter((v): v is string => typeof v === 'string');
        return { ...base, answered: rs.filter((r) => r.answers[q.id] != null || r.answers[`other:${q.id}`]).length, counts, others };
      }
      if (q.type === 'scale') {
        const nums = vals.map(Number);
        const min = q.extra.min ?? 1, max = q.extra.max ?? 5;
        return { ...base, average: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
          counts: Array.from({ length: max - min + 1 }, (_, i) => ({ id: String(min + i), text: String(min + i), count: nums.filter((n) => n === min + i).length })) };
      }
      if (q.type === 'file') return { ...base, files: rs.flatMap((r) => ((r.answers[q.id] as { name: string; size: number }[] | null) ?? []).map((x, i) => ({ responseId: r.id, index: i, name: x.name, size: x.size }))) };
      return { ...base, texts: vals.map(String).slice(-500) };
    });
    return { title: f.title, anonymous: settingsOf(f).anonymous, total: rs.length, summary, responses: full ? rs : [], canManage: full && RANK[await perm(u, f)] >= RANK.edit };
  });

  app.delete('/forms/:id/responses/:rid', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().uuid(), rid: z.string().uuid() }), req.params);
    await need(u, p.id, 'edit');
    await sql`delete from form_responses where id = ${p.rid} and form_id = ${p.id}`;
    await storage.remove(`.aperio/forms/${p.id}/${p.rid}`).catch(() => {});
    return { ok: true };
  });

  app.delete('/forms/:id/responses', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { f } = await need(u, id, 'edit');
    const ids = (await sql<{ id: string }[]>`delete from form_responses where form_id = ${id} returning id`).map((r) => r.id);
    for (const rid of ids) await storage.remove(`.aperio/forms/${id}/${rid}`).catch(() => {});
    await audit(sql, u, { action: 'form.clear', entityType: 'form', entityId: id, summary: `Alle ${ids.length} Antworten von „${f.title}“ gelöscht` });
    return { ok: true, deleted: ids.length };
  });

  app.get('/forms/:id/responses/:rid/files/:qid/:index', async (req, reply) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().uuid(), rid: z.string().uuid(), qid: z.string().uuid(), index: z.coerce.number().int().min(0) }), req.params);
    const f = await resultsAccess(u, p.id);
    if (RANK[await perm(u, f)] < RANK.results) throw forbidden();
    const [r] = await sql<{ answers: FormAnswers }[]>`select answers from form_responses where id = ${p.rid} and form_id = ${p.id}`;
    const file = (r?.answers[p.qid] as { name: string; path: string }[] | null)?.[p.index];
    if (!file) throw notFound();
    return sendStoredFile(ctx, reply, file.path, file.name);
  });

  /** Export: Excel oder CSV mit einer Zeile je Antwort */
  app.get('/forms/:id/export', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { format } = parse(z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') }), req.query);
    const { f } = await need(u, id, 'results');
    const qs = (await questions(id)).filter((q) => q.type !== 'section');
    const rs = await responsesOf(f);
    const text = (q: FormQuestion, a: FormAnswers) => {
      const v = a[q.id];
      const other = a[`other:${q.id}`];
      const optText = (x: string) => q.options.find((o) => o.id === x)?.text ?? x;
      let s = v == null ? '' : Array.isArray(v) ? (q.type === 'file' ? (v as { name: string }[]).map((x) => x.name).join(', ') : (v as string[]).map(optText).join(', ')) : q.type === 'single' || q.type === 'dropdown' ? optText(String(v)) : String(v);
      if (typeof other === 'string' && other) s = s ? `${s}, ${other}` : other;
      return s;
    };
    const head = ['Nr.', 'Zeitpunkt', ...(settingsOf(f).anonymous ? [] : ['Person']), ...qs.map((q) => q.text || FORM_TYPE_LABELS[q.type])];
    const rows = rs.map((r, i) => [i + 1, r.createdAt, ...(settingsOf(f).anonymous ? [] : [r.userName ?? (r.public ? 'Extern' : '')]), ...qs.map((q) => text(q, r.answers))]);
    const name = `${safeName(f.title || 'Formular')}_Antworten`;
    if (format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${encodeURIComponent(name)}.csv"`);
      return writeCsv([head, ...rows.map((r) => r.map((c) => (c instanceof Date ? c.toLocaleString('de-DE') : c)))]);
    }
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${encodeURIComponent(name)}.xlsx"`);
    return writeXlsx([{ name: 'Antworten', widths: [6, 18, ...(settingsOf(f).anonymous ? [] : [22]), ...qs.map(() => 30)], rows: [head, ...rows] }]);
  });

  // ------------------------------------------------ Öffentlicher Link (ohne Anmeldung)
  async function byToken(t: string) {
    const [f] = await sql<FormRow[]>`select * from forms where public_token = ${t} and not archived`;
    const { installed } = await ctx.settings.get('apps');
    if (!f || !installed.includes('forms')) throw notFound('Dieses Formular ist nicht (mehr) verfügbar');
    return f;
  }
  const tokenParam = z.object({ token: z.string().max(60) });
  app.get('/form/:token', async (req) => {
    const { token } = parse(tokenParam, req.params);
    const f = await byToken(token);
    const v = await fillView(f, null);
    const company = await ctx.settings.get('company');
    return { ...v, company: company.name, showResults: false, allowEdit: false };
  });
  app.post('/form/:token/uploads', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(tokenParam, req.params);
    return uploadFor(await byToken(token), req);
  });
  app.post('/form/:token/responses', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(tokenParam, req.params);
    const f = await byToken(token);
    const b = parse(z.object({ answers: z.record(z.string(), z.unknown()) }), req.body);
    return submit(f, null, b.answers as FormAnswers, true);
  });

}
