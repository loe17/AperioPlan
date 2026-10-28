/**
 * Wissensdatenbank (wie Odoo Knowledge): Artikel mit beliebig tiefen Unterseiten in drei Bereichen
 *  - Firma (workspace): alle Mitarbeiter lesen und bearbeiten (gesperrte Artikel nur Autor, Teamleiter, Admins)
 *  - Geteilt (shared): Autor und eingeladene Personen (lesen oder bearbeiten)
 *  - Privat (private): nur der Autor
 * Der Bereich und die Mitglieder gelten immer für den ganzen Ast (vom obersten Artikel aus).
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { KB_TEMPLATES, kbText, type KbNode } from '@aperio/shared';
import type { AppContext } from '../context';
import type { Sql } from '../db';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { notify } from '../services/notify';
import { safeName } from '../services/files';
import { sendStoredFile } from './files';

const IMG = /\.(png|jpe?g|gif|webp|svg)$/i;
type Row = { id: string; parent_id: string | null; root_id: string; scope: 'workspace' | 'shared' | 'private'; owner_id: string; title: string; locked: boolean; public_token: string | null; archived_at: Date | null };

/** Rechte auf einen Artikel: liest Wurzel, Sperre (auch von Vorfahren) und Mitgliedschaft */
export async function kbAccess(sql: Sql, u: AuthUser, id: string, need: 'read' | 'edit' | 'manage' = 'read', opts: { archived?: boolean } = {}) {
  if (u.role === 'guest') throw notFound('Artikel nicht gefunden');
  const [a] = await sql<(Row & { root_owner: string; member: string | null; locked_up: boolean })[]>`
    select a.id, a.parent_id, a.root_id, a.scope, a.owner_id, a.title, a.locked, a.public_token, a.archived_at, r.owner_id as root_owner,
      (select permission from kb_members m where m.article_id = a.root_id and m.user_id = ${u.id}) as member,
      exists (with recursive up as (select id, parent_id, locked from kb_articles where id = a.id
                union all select k.id, k.parent_id, k.locked from kb_articles k join up on k.id = up.parent_id) select 1 from up where locked) as locked_up
    from kb_articles a join kb_articles r on r.id = a.root_id where a.id = ${id}`;
  if (!a || (a.archived_at && !opts.archived)) throw notFound('Artikel nicht gefunden');
  const admin = u.role === 'admin';
  const owner = a.root_owner === u.id || a.owner_id === u.id;
  let canRead = false, canEdit = false;
  if (a.scope === 'workspace') { canRead = true; canEdit = !a.locked_up || owner || admin || u.role === 'teamlead'; }
  else if (a.scope === 'private') { canRead = canEdit = a.root_owner === u.id; }
  else { canRead = a.root_owner === u.id || a.member !== null; canEdit = a.root_owner === u.id || a.member === 'edit'; }
  if (!canRead) throw notFound('Artikel nicht gefunden');
  const canManage = a.root_owner === u.id || a.owner_id === u.id || (a.scope === 'workspace' && (admin || u.role === 'teamlead'));
  if (need === 'edit' && !canEdit) throw forbidden(a.locked_up ? 'Dieser Artikel ist gesperrt und kann nur vom Autor oder von Teamleitern geändert werden.' : 'Sie dürfen diesen Artikel nur lesen.');
  if (need === 'manage' && !canManage) throw forbidden('Nur der Autor darf das.');
  return { ...a, canEdit, canManage };
}

/** SQL-Bedingung: sichtbare Artikel (Alias a, Wurzel r) */
const visible = (sql: Sql, u: AuthUser) => sql`a.archived_at is null and (a.scope = 'workspace'
  or r.owner_id = ${u.id}
  or (a.scope = 'shared' and exists (select 1 from kb_members m where m.article_id = a.root_id and m.user_id = ${u.id})))`;

const docSchema = z.object({ type: z.literal('doc'), content: z.array(z.any()).optional() }).passthrough();

export default async function knowledgeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage, config } = ctx;
  const changed = (id: string, by: string) => ctx.hub.publish('global', 'kb.changed', { id, by });
  const noGuest = (u: AuthUser) => { if (u.role === 'guest') throw forbidden(); };

  app.get('/knowledge/tree', async (req) => {
    const u = requireUser(req);
    noGuest(u);
    return sql`select a.id, a.parent_id as "parentId", a.title, a.icon, a.scope, a.sort, a.is_template as "isTemplate", a.locked,
      exists (select 1 from kb_favorites f where f.article_id = a.id and f.user_id = ${u.id}) as favorite
      from kb_articles a join kb_articles r on r.id = a.root_id where ${visible(sql, u)} order by a.sort, a.created_at`;
  });

  app.get('/knowledge/templates', async (req) => {
    const u = requireUser(req);
    noGuest(u);
    const own = await sql`select a.id, a.title, a.icon, left(a.text, 140) as description from kb_articles a join kb_articles r on r.id = a.root_id
      where a.is_template and ${visible(sql, u)} order by a.title`;
    return { builtIn: KB_TEMPLATES.map(({ id, title, icon, description }) => ({ id, title, icon, description })), own };
  });

  app.get('/knowledge/search', async (req) => {
    const u = requireUser(req);
    noGuest(u);
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    return sql`select a.id, a.title, a.icon, a.scope,
      case when position(lower(${q}) in lower(a.text)) > 0 then substr(a.text, greatest(1, position(lower(${q}) in lower(a.text)) - 60), 180) else left(a.text, 180) end as snippet
      from kb_articles a join kb_articles r on r.id = a.root_id
      where ${visible(sql, u)} and (a.title ilike ${like} or a.text ilike ${like})
      order by (a.title ilike ${like}) desc, a.updated_at desc limit 30`;
  });

  app.get('/knowledge/recent', async (req) => {
    const u = requireUser(req);
    noGuest(u);
    return sql`select a.id, a.title, a.icon, a.scope, a.updated_at as "updatedAt", ub.display_name as "updatedByName"
      from kb_articles a join kb_articles r on r.id = a.root_id left join users ub on ub.id = a.updated_by
      where ${visible(sql, u)} and not a.is_template order by a.updated_at desc limit 12`;
  });

  app.get('/knowledge/articles/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const acc = await kbAccess(sql, u, id);
    const [a] = await sql`select a.id, a.parent_id as "parentId", a.root_id as "rootId", a.scope, a.title, a.icon, a.content, a.is_template as "isTemplate",
      a.locked, a.full_width as "fullWidth", a.public_token, a.owner_id as "ownerId", o.display_name as "ownerName",
      a.created_at as "createdAt", a.updated_at as "updatedAt", ub.display_name as "updatedByName",
      exists (select 1 from kb_favorites f where f.article_id = a.id and f.user_id = ${u.id}) as favorite
      from kb_articles a join users o on o.id = a.owner_id left join users ub on ub.id = a.updated_by where a.id = ${id}`;
    const path = await sql`with recursive up as (select id, parent_id, title, icon, 0 as d from kb_articles where id = ${acc.parent_id}
        union all select k.id, k.parent_id, k.title, k.icon, up.d + 1 from kb_articles k join up on k.id = up.parent_id)
      select id, title, icon from up order by d desc`;
    const children = await sql`select id, title, icon from kb_articles where parent_id = ${id} and archived_at is null order by sort, created_at`;
    const members = acc.scope === 'shared' ? await sql`select m.user_id as "userId", us.display_name as "displayName", m.permission
      from kb_members m join users us on us.id = m.user_id where m.article_id = ${acc.root_id} order by us.display_name` : [];
    const { public_token, ...rest } = a as typeof a & { public_token: string | null };
    return { ...rest, canEdit: acc.canEdit, canManage: acc.canManage, path: acc.parent_id ? path : [], children, members,
      publicUrl: public_token ? `${config.publicUrl}/kb/${public_token}` : null };
  });

  async function nextSort(parentId: string | null, scope: string, ownerId: string) {
    const [r] = await sql<{ s: number }[]>`select coalesce(max(sort), 0) + 1000 as s from kb_articles
      where ${parentId ? sql`parent_id = ${parentId}` : sql`parent_id is null and scope = ${scope} ${scope === 'workspace' ? sql`` : sql`and owner_id = ${ownerId}`}`}`;
    return r!.s;
  }

  app.post('/knowledge/articles', async (req) => {
    const u = requireUser(req);
    noGuest(u);
    const b = parse(z.object({
      parentId: z.string().uuid().nullable().default(null), scope: z.enum(['workspace', 'shared', 'private']).default('workspace'),
      title: z.string().max(300).default(''), icon: z.string().max(40).default(''),
      template: z.string().max(60).optional(), templateArticleId: z.string().uuid().optional(), isTemplate: z.boolean().default(false),
    }), req.body ?? {});
    let scope = b.scope, rootId: string | null = null;
    if (b.parentId) { const p = await kbAccess(sql, u, b.parentId, 'edit'); scope = p.scope; rootId = p.root_id; }
    let content: KbNode = { type: 'doc', content: [] }, title = b.title, icon = b.icon;
    if (b.template) {
      const t = KB_TEMPLATES.find((x) => x.id === b.template);
      if (!t) throw badRequest('Unbekannte Vorlage');
      content = t.content; title ||= t.title; icon ||= t.icon;
    } else if (b.templateArticleId) {
      await kbAccess(sql, u, b.templateArticleId);
      const [t] = await sql<{ content: KbNode; title: string; icon: string }[]>`select content, title, icon from kb_articles where id = ${b.templateArticleId}`;
      content = t!.content; title ||= t!.title; icon ||= t!.icon;
    }
    const id = randomUUID();
    await sql`insert into kb_articles (id, parent_id, root_id, scope, title, icon, content, text, sort, owner_id, is_template, updated_by)
      values (${id}, ${b.parentId}, ${rootId ?? id}, ${scope}, ${title}, ${icon}, ${sql.json(content as never)}, ${kbText(content)},
        ${await nextSort(b.parentId, scope, u.id)}, ${u.id}, ${b.isTemplate}, ${u.id})`;
    changed(id, u.id);
    return { id };
  });

  /** Speichern. baseUpdatedAt erkennt, ob jemand anderes zwischenzeitlich gespeichert hat (409). */
  app.patch('/knowledge/articles/:id', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      title: z.string().max(300).optional(), icon: z.string().max(40).optional(), content: docSchema.optional(),
      locked: z.boolean().optional(), fullWidth: z.boolean().optional(), isTemplate: z.boolean().optional(), baseUpdatedAt: z.string().optional(),
    }), req.body);
    const acc = await kbAccess(sql, u, id, b.locked !== undefined || b.isTemplate !== undefined ? 'manage' : 'edit');
    if (b.content && JSON.stringify(b.content).length > 3_000_000) throw badRequest('Der Artikel ist zu groß (höchstens etwa 3 MB Text). Bilder bitte als Datei einfügen.');
    const [cur] = await sql<{ updated_at: Date; updated_by: string | null; title: string; content: KbNode }[]>`select updated_at, updated_by, title, content from kb_articles where id = ${id}`;
    if (b.content && b.baseUpdatedAt && new Date(b.baseUpdatedAt).getTime() !== cur!.updated_at.getTime() && cur!.updated_by !== u.id) {
      return reply.status(409).send({ error: 'Jemand anderes hat diesen Artikel inzwischen geändert.', details: { updatedAt: cur!.updated_at } });
    }
    if (b.content) {
      // Version sichern: höchstens alle 10 Minuten oder wenn jemand anderes vorher bearbeitet hat
      const [last] = await sql<{ created_at: Date }[]>`select created_at from kb_versions where article_id = ${id} order by created_at desc limit 1`;
      const hasContent = (cur!.content.content?.length ?? 0) > 0;
      if (hasContent && (!last || Date.now() - last.created_at.getTime() > 10 * 60_000 || cur!.updated_by !== u.id)) {
        await sql`insert into kb_versions (article_id, title, content, created_by, created_at) values (${id}, ${cur!.title}, ${sql.json(cur!.content as never)}, ${cur!.updated_by}, ${cur!.updated_at})`;
        await sql`delete from kb_versions where article_id = ${id} and id not in (select id from kb_versions where article_id = ${id} order by created_at desc limit 100)`;
      }
    }
    const [r] = await sql<{ updatedAt: Date }[]>`update kb_articles set title = coalesce(${b.title ?? null}, title), icon = coalesce(${b.icon ?? null}, icon),
      content = ${b.content ? sql.json(b.content as never) : sql`content`}, text = ${b.content ? kbText(b.content as KbNode) : sql`text`},
      locked = coalesce(${b.locked ?? null}, locked), full_width = coalesce(${b.fullWidth ?? null}, full_width), is_template = coalesce(${b.isTemplate ?? null}, is_template),
      updated_at = now(), updated_by = ${u.id} where id = ${id} returning updated_at as "updatedAt"`;
    changed(id, u.id);
    void acc;
    return r;
  });

  /** Verschieben (anderer Elternartikel, Reihenfolge, Bereich) */
  app.post('/knowledge/articles/:id/move', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ parentId: z.string().uuid().nullable(), scope: z.enum(['workspace', 'shared', 'private']).optional(), beforeId: z.string().uuid().nullable().default(null) }), req.body);
    const acc = await kbAccess(sql, u, id, 'edit');
    let scope = b.scope ?? acc.scope, rootId = id;
    if (b.parentId) {
      if (b.parentId === id) throw badRequest('Ein Artikel kann nicht in sich selbst liegen.');
      const p = await kbAccess(sql, u, b.parentId, 'edit');
      const [cycle] = await sql`with recursive up as (select id, parent_id from kb_articles where id = ${b.parentId}
        union all select k.id, k.parent_id from kb_articles k join up on k.id = up.parent_id) select 1 from up where id = ${id}`;
      if (cycle) throw badRequest('Ein Artikel kann nicht unter seine eigene Unterseite verschoben werden.');
      scope = p.scope; rootId = p.root_id;
    }
    // Bereich wechseln (z. B. privat -> Firma) darf nur der Autor
    if (scope !== acc.scope && acc.root_owner !== u.id && u.role !== 'admin') throw forbidden('Nur der Autor darf den Bereich ändern.');
    let sort: number;
    if (b.beforeId) {
      const [bf] = await sql<{ sort: number }[]>`select sort from kb_articles where id = ${b.beforeId}`;
      const [prev] = await sql<{ sort: number }[]>`select sort from kb_articles where ${b.parentId ? sql`parent_id = ${b.parentId}` : sql`parent_id is null`} and sort < ${bf?.sort ?? 0} and id <> ${id} order by sort desc limit 1`;
      sort = ((prev?.sort ?? (bf?.sort ?? 0) - 1000) + (bf?.sort ?? 0)) / 2;
    } else sort = await nextSort(b.parentId, scope, u.id);
    await sql.begin(async (tx) => {
      await tx`update kb_articles set parent_id = ${b.parentId}, sort = ${sort}, updated_at = now() where id = ${id}`;
      await tx`with recursive sub as (select id from kb_articles where id = ${id} union all select k.id from kb_articles k join sub on k.parent_id = sub.id)
        update kb_articles set root_id = ${rootId}, scope = ${scope} where id in (select id from sub)`;
    });
    changed(id, u.id);
    return { ok: true };
  });

  app.post('/knowledge/articles/:id/duplicate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await kbAccess(sql, u, id);
    const copy = randomUUID();
    const [src] = await sql<{ title: string; icon: string; content: KbNode; text: string; sort: number }[]>`select title, icon, content, text, sort from kb_articles where id = ${id}`;
    let parent = a.parent_id, scope = a.scope, root = a.root_id;
    if (parent) { try { await kbAccess(sql, u, parent, 'edit'); } catch { parent = null; scope = 'private'; root = copy; } }
    else if (!a.canEdit) { scope = 'private'; }
    if (!parent) root = copy;
    await sql`insert into kb_articles (id, parent_id, root_id, scope, title, icon, content, text, sort, owner_id, updated_by)
      values (${copy}, ${parent}, ${root}, ${scope}, ${`${src!.title} (Kopie)`}, ${src!.icon}, ${sql.json(src!.content as never)}, ${src!.text}, ${src!.sort + 1}, ${u.id}, ${u.id})`;
    changed(copy, u.id);
    return { id: copy };
  });

  // ---------------- Papierkorb
  app.delete('/knowledge/articles/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ permanent: z.coerce.boolean().optional() }), req.query);
    if (q.permanent) {
      const a = await kbAccess(sql, u, id, 'manage', { archived: true });
      if (!a.archived_at) throw badRequest('Bitte zuerst in den Papierkorb legen.');
      const ids = (await sql<{ id: string }[]>`with recursive sub as (select id from kb_articles where id = ${id} union all select k.id from kb_articles k join sub on k.parent_id = sub.id) select id from sub`).map((r) => r.id);
      await sql`delete from kb_articles where id = ${id}`;
      for (const x of ids) await storage.remove(`.aperio/knowledge/${x}`).catch(() => {});
    } else {
      await kbAccess(sql, u, id, 'edit');
      await sql`with recursive sub as (select id from kb_articles where id = ${id} union all select k.id from kb_articles k join sub on k.parent_id = sub.id)
        update kb_articles set archived_at = now() where id in (select id from sub) and archived_at is null`;
    }
    changed(id, u.id);
    return { ok: true };
  });

  app.get('/knowledge/trash', async (req) => {
    const u = requireUser(req);
    noGuest(u);
    // nur die oberste gelöschte Ebene zeigen
    return sql`select a.id, a.title, a.icon, a.scope, a.archived_at as "archivedAt", (a.owner_id = ${u.id} or r.owner_id = ${u.id} ${u.role === 'admin' ? sql`or true` : sql``}) as "canDelete"
      from kb_articles a join kb_articles r on r.id = a.root_id
      left join kb_articles p on p.id = a.parent_id
      where a.archived_at is not null and (p.id is null or p.archived_at is null or p.archived_at < a.archived_at - interval '1 second')
        and (a.scope = 'workspace' or r.owner_id = ${u.id} or (a.scope = 'shared' and exists (select 1 from kb_members m where m.article_id = a.root_id and m.user_id = ${u.id})))
      order by a.archived_at desc limit 200`;
  });

  app.post('/knowledge/articles/:id/restore', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await kbAccess(sql, u, id, 'edit', { archived: true });
    const [p] = a.parent_id ? await sql<{ archived_at: Date | null }[]>`select archived_at from kb_articles where id = ${a.parent_id}` : [];
    await sql.begin(async (tx) => {
      await tx`with recursive sub as (select id from kb_articles where id = ${id} union all select k.id from kb_articles k join sub on k.parent_id = sub.id)
        update kb_articles set archived_at = null where id in (select id from sub) and archived_at >= ${a.archived_at!}`;
      // Elternartikel liegt noch im Papierkorb: als eigenständigen Artikel wiederherstellen
      if (p?.archived_at) {
        await tx`update kb_articles set parent_id = null where id = ${id}`;
        await tx`with recursive sub as (select id from kb_articles where id = ${id} union all select k.id from kb_articles k join sub on k.parent_id = sub.id)
          update kb_articles set root_id = ${id} where id in (select id from sub)`;
      }
    });
    changed(id, u.id);
    return { ok: true };
  });

  // ---------------- Favoriten
  app.put('/knowledge/articles/:id/favorite', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await kbAccess(sql, u, id);
    await sql`insert into kb_favorites (user_id, article_id) values (${u.id}, ${id}) on conflict do nothing`;
    return { ok: true };
  });
  app.delete('/knowledge/articles/:id/favorite', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from kb_favorites where user_id = ${u.id} and article_id = ${id}`;
    return { ok: true };
  });

  // ---------------- Versionen
  app.get('/knowledge/articles/:id/versions', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await kbAccess(sql, u, id);
    return sql`select v.id, v.title, v.created_at as "createdAt", us.display_name as "userName", length(v.content::text) as size
      from kb_versions v left join users us on us.id = v.created_by where v.article_id = ${id} order by v.created_at desc`;
  });
  app.get('/knowledge/articles/:id/versions/:vid', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().uuid(), vid: z.string().uuid() }), req.params);
    await kbAccess(sql, u, p.id);
    const [v] = await sql`select id, title, content, created_at as "createdAt" from kb_versions where id = ${p.vid} and article_id = ${p.id}`;
    if (!v) throw notFound();
    return v;
  });
  app.post('/knowledge/articles/:id/versions/:vid/restore', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ id: z.string().uuid(), vid: z.string().uuid() }), req.params);
    await kbAccess(sql, u, p.id, 'edit');
    const [v] = await sql<{ title: string; content: KbNode }[]>`select title, content from kb_versions where id = ${p.vid} and article_id = ${p.id}`;
    if (!v) throw notFound();
    const [cur] = await sql<{ title: string; content: KbNode; updated_by: string | null; updated_at: Date }[]>`select title, content, updated_by, updated_at from kb_articles where id = ${p.id}`;
    await sql`insert into kb_versions (article_id, title, content, created_by, created_at) values (${p.id}, ${cur!.title}, ${sql.json(cur!.content as never)}, ${cur!.updated_by}, ${cur!.updated_at})`;
    await sql`update kb_articles set title = ${v.title}, content = ${sql.json(v.content as never)}, text = ${kbText(v.content)}, updated_at = now(), updated_by = ${u.id} where id = ${p.id}`;
    changed(p.id, u.id);
    return { ok: true };
  });

  // ---------------- Mitglieder (Bereich „Geteilt“) und öffentlicher Link
  app.put('/knowledge/articles/:id/members', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await kbAccess(sql, u, id, 'manage');
    if (a.parent_id) throw badRequest('Mitglieder werden beim obersten Artikel festgelegt.');
    const b = parse(z.object({ members: z.array(z.object({ userId: z.string().uuid(), permission: z.enum(['read', 'edit']) })).max(500) }), req.body);
    const before = new Set((await sql<{ user_id: string }[]>`select user_id from kb_members where article_id = ${id}`).map((r) => r.user_id));
    const list = b.members.filter((m) => m.userId !== a.root_owner);
    await sql.begin(async (tx) => {
      await tx`delete from kb_members where article_id = ${id}`;
      for (const m of list) await tx`insert into kb_members (article_id, user_id, permission) values (${id}, ${m.userId}, ${m.permission}) on conflict do nothing`;
      if (list.length && a.scope === 'private') {
        await tx`with recursive sub as (select id from kb_articles where id = ${id} union all select k.id from kb_articles k join sub on k.parent_id = sub.id)
          update kb_articles set scope = 'shared' where id in (select id from sub)`;
      }
    });
    const added = list.map((m) => m.userId).filter((x) => !before.has(x));
    if (added.length) await notify(ctx, added, { kind: 'kb.shared', title: `${u.displayName} hat den Artikel „${a.title || 'Ohne Titel'}“ mit Ihnen geteilt`, link: `/knowledge/${id}` }, u.id);
    changed(id, u.id);
    return { ok: true };
  });

  app.post('/knowledge/articles/:id/public', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await kbAccess(sql, u, id, 'manage');
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const token = enabled ? a.public_token ?? randomBytes(15).toString('base64url') : null;
    await sql`update kb_articles set public_token = ${token} where id = ${id}`;
    return { publicUrl: token ? `${config.publicUrl}/kb/${token}` : null };
  });

  // ---------------- Bilder und Dateien
  app.post('/knowledge/uploads', async (req) => {
    const u = requireUser(req);
    const { articleId } = parse(z.object({ articleId: z.string().uuid() }), req.query);
    await kbAccess(sql, u, articleId, 'edit');
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'datei');
      const path = `.aperio/knowledge/${articleId}/${randomUUID().slice(0, 8)}_${name}`;
      const r = await storage.write(path, part.file);
      if (r.size > 50 * 1024 * 1024) { await storage.remove(path).catch(() => {}); throw badRequest('Datei größer als 50 MB'); }
      out.push({ name, size: r.size, image: IMG.test(name), url: `/api/knowledge/file?path=${encodeURIComponent(path)}` });
    }
    return out;
  });

  const filePath = z.object({ path: z.string().regex(/^\.aperio\/knowledge\/[0-9a-f-]{36}\/[^/]+$/).max(500) });
  app.get('/knowledge/file', async (req, reply) => {
    const u = requireUser(req);
    const { path } = parse(filePath, req.query);
    await kbAccess(sql, u, path.split('/')[2]!, 'read', { archived: true });
    return sendStoredFile(ctx, reply, path, path.split('/').pop()!.replace(/^[0-9a-f]{8}_/, ''), IMG.test(path));
  });

  // ---------------- öffentlich (ohne Anmeldung)
  async function byToken(t: string) {
    const [a] = await sql<{ id: string; title: string; icon: string; content: KbNode; updated_at: Date; full_width: boolean }[]>`
      select id, title, icon, content, updated_at, full_width from kb_articles where public_token = ${t} and archived_at is null`;
    const { installed } = await ctx.settings.get('apps');
    if (!a || !installed.includes('knowledge')) throw notFound('Dieser Artikel ist nicht (mehr) öffentlich.');
    return a;
  }
  const tokenParam = z.object({ token: z.string().max(60) });
  app.get('/kb/:token', async (req) => {
    const { token } = parse(tokenParam, req.params);
    const a = await byToken(token);
    const company = await ctx.settings.get('company');
    // Bild-Adressen auf den öffentlichen Weg umschreiben
    const json = JSON.stringify(a.content).replace(/\/api\/knowledge\/file\?path=/g, `/api/kb/${token}/file?path=`);
    return { title: a.title, icon: a.icon, content: JSON.parse(json), updatedAt: a.updated_at, fullWidth: a.full_width, company: company.name };
  });
  app.get('/kb/:token/file', async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const a = await byToken(token);
    const { path } = parse(filePath, req.query);
    if (path.split('/')[2] !== a.id) throw notFound();
    return sendStoredFile(ctx, reply, path, path.split('/').pop()!.replace(/^[0-9a-f]{8}_/, ''), IMG.test(path));
  });
}
