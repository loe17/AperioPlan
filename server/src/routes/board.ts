/**
 * Digitales schwarzes Brett (Mitteilungen mit Lesebestätigung) und interner Marktplatz
 * (Mitarbeiter und Firma bieten Dinge an: verkaufen, verschenken, reservieren).
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { safeName } from '../services/files';
import { sendStoredFile } from './files';

type Att = { name: string; path: string; size: number; image?: boolean };
const IMG = /\.(png|jpe?g|gif|webp)$/i;

export default async function boardRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const mayModerate = (u: AuthUser) => u.role === 'admin' || u.role === 'teamlead';
  const myTeams = async (u: AuthUser) => (await sql<{ team_id: string }[]>`select team_id from team_members where user_id = ${u.id}`).map((r) => r.team_id);

  /** Anhänge/Bilder aus dem Zwischenspeicher übernehmen */
  async function keep(kind: 'posts' | 'market', id: string, list: Att[]) {
    const out: Att[] = [];
    for (const a of list) {
      if (!a.path.startsWith(`.aperio/board/`) || a.path.includes('..')) throw badRequest('Ungültiger Anhang');
      if (a.path.includes('/tmp/')) {
        const target = `.aperio/board/${kind}/${id}/${randomUUID().slice(0, 8)}_${safeName(a.name)}`;
        await storage.move(a.path, target);
        out.push({ name: a.name, path: target, size: a.size, image: IMG.test(a.name) });
      } else out.push({ ...a, image: IMG.test(a.name) });
    }
    return out;
  }

  app.post('/board/uploads', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = safeName(part.filename.split(/[\\/]/).pop() ?? 'datei');
      const path = `.aperio/board/tmp/${randomUUID()}/${name}`;
      const r = await storage.write(path, part.file);
      if (r.size > 30 * 1024 * 1024) { await storage.remove(path).catch(() => {}); throw badRequest('Datei größer als 30 MB'); }
      out.push({ name, path, size: r.size, image: IMG.test(name) });
    }
    return out;
  });

  /** Bild oder Anhang ausliefern (nur für angemeldete Mitarbeiter) */
  app.get('/board/file', async (req, reply) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const { path } = parse(z.object({ path: z.string().startsWith('.aperio/board/').max(500) }), req.query);
    if (path.includes('..')) throw badRequest('Ungültiger Pfad');
    return sendStoredFile(ctx, reply, path, path.split('/').pop()!.replace(/^[0-9a-f]{8}_/, ''), IMG.test(path));
  });

  // ------------------------------------------------ Mitteilungen
  const postSelect = (u: AuthUser) => sql`p.id, p.title, p.body, p.category, p.author_id as "authorId", a.display_name as "authorName", p.pinned, p.important,
    p.team_ids as "teamIds", p.attachments, p.expires_at as "expiresAt", p.created_at as "createdAt", p.updated_at as "updatedAt",
    exists (select 1 from board_reads r where r.post_id = p.id and r.user_id = ${u.id}) as read,
    exists (select 1 from board_reads r where r.post_id = p.id and r.user_id = ${u.id} and r.confirmed_at is not null) as confirmed,
    (select count(*)::int from board_likes l where l.post_id = p.id) as likes,
    exists (select 1 from board_likes l where l.post_id = p.id and l.user_id = ${u.id}) as liked,
    (select count(*)::int from board_reads r where r.post_id = p.id and (not p.important or r.confirmed_at is not null)) as "readCount",
    (select count(*)::int from comments c where c.entity_type = 'board_post' and c.entity_id = p.id) as comments`;
  const visible = (u: AuthUser, teams: string[]) => sql`(cardinality(p.team_ids) = 0 or p.team_ids && ${teams}::uuid[] or p.author_id = ${u.id} or ${u.role === 'admin'})`;

  app.get('/board/posts', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ category: z.string().max(80).optional(), q: z.string().max(100).optional(), archive: z.coerce.boolean().optional(), unread: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
    const teams = await myTeams(u);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${postSelect(u)} from board_posts p left join users a on a.id = p.author_id where ${visible(u, teams)}
      and ${q.archive ? sql`p.expires_at < now()` : sql`(p.expires_at is null or p.expires_at >= now())`}
      ${q.category ? sql`and p.category = ${q.category}` : sql``}
      ${like ? sql`and (p.title ilike ${like} or p.body ilike ${like})` : sql``}
      ${q.unread ? sql`and not exists (select 1 from board_reads r where r.post_id = p.id and r.user_id = ${u.id})` : sql``}
      order by p.pinned desc, p.created_at desc limit ${q.limit}`;
  });

  app.get('/board/unread', async (req) => {
    const u = requireUser(req);
    const teams = await myTeams(u);
    const [r] = await sql<{ n: number; important: number }[]>`select count(*)::int as n, count(*) filter (where p.important)::int as important from board_posts p
      where ${visible(u, teams)} and (p.expires_at is null or p.expires_at >= now()) and p.created_at > now() - interval '60 days'
      and not exists (select 1 from board_reads r where r.post_id = p.id and r.user_id = ${u.id} and (not p.important or r.confirmed_at is not null))`;
    return r;
  });

  const postBody = z.object({
    title: z.string().trim().min(1).max(200), body: z.string().max(50000).default(''), category: z.string().max(80).default('Allgemein'),
    pinned: z.boolean().default(false), important: z.boolean().default(false), teamIds: z.array(z.string().uuid()).max(50).default([]),
    attachments: z.array(z.object({ name: z.string(), path: z.string(), size: z.number(), image: z.boolean().optional() })).max(20).default([]),
    expiresAt: z.string().date().nullable().default(null), notify: z.boolean().default(true),
  });

  async function audience(teamIds: string[]) {
    return teamIds.length
      ? (await sql<{ id: string }[]>`select distinct user_id as id from team_members where team_id = any(${teamIds})`).map((r) => r.id)
      : (await sql<{ id: string }[]>`select id from users where active and deleted_at is null and role <> 'guest'`).map((r) => r.id);
  }

  app.post('/board/posts', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const s = await ctx.settings.get('board');
    if (!s.employeesMayPost && !mayModerate(u)) throw forbidden('Mitteilungen veröffentlichen nur Teamleiter und Administratoren');
    const b = parse(postBody, req.body);
    if ((b.pinned || b.important) && !mayModerate(u)) throw forbidden('Anheften und Lesebestätigung nur für Teamleiter und Administratoren');
    const id = randomUUID();
    const att = await keep('posts', id, b.attachments);
    await sql`insert into board_posts (id, title, body, category, author_id, pinned, important, team_ids, attachments, expires_at)
      values (${id}, ${b.title}, ${b.body}, ${b.category}, ${u.id}, ${b.pinned}, ${b.important}, ${b.teamIds}, ${sql.json(att)}, ${b.expiresAt ? `${b.expiresAt}T23:59:59` : null})`;
    await sql`insert into board_reads (post_id, user_id, confirmed_at) values (${id}, ${u.id}, now())`;
    if (b.notify && (b.important || b.pinned)) {
      await notify(ctx, await audience(b.teamIds), { kind: 'board.post', title: `${b.important ? 'Bitte lesen: ' : ''}${b.title}`, body: b.body.slice(0, 200), link: `/board?post=${id}` }, u.id);
    }
    ctx.hub.publish('global', 'board.changed', { id });
    return { id };
  });

  async function loadPost(u: AuthUser, id: string) {
    const [p] = await sql<{ id: string; author_id: string | null; team_ids: string[]; title: string; important: boolean; attachments: Att[] }[]>`select id, author_id, team_ids, title, important, attachments from board_posts where id = ${id}`;
    if (!p) throw notFound('Mitteilung nicht gefunden');
    if (p.team_ids.length && p.author_id !== u.id && u.role !== 'admin') {
      const teams = await myTeams(u);
      if (!p.team_ids.some((t) => teams.includes(t))) throw notFound('Mitteilung nicht gefunden');
    }
    return p;
  }

  app.get('/board/posts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadPost(u, id);
    await sql`insert into board_reads (post_id, user_id) values (${id}, ${u.id}) on conflict do nothing`;
    const [p] = await sql`select ${postSelect(u)} from board_posts p left join users a on a.id = p.author_id where p.id = ${id}`;
    return p;
  });

  app.patch('/board/posts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const p = await loadPost(u, id);
    if (p.author_id !== u.id && !mayModerate(u)) throw forbidden();
    const b = parse(postBody.partial(), req.body);
    if ((b.pinned || b.important) && !mayModerate(u)) throw forbidden();
    const att = b.attachments ? await keep('posts', id, b.attachments) : null;
    await sql`update board_posts set title = coalesce(${b.title ?? null}, title), body = coalesce(${b.body ?? null}, body), category = coalesce(${b.category ?? null}, category),
      pinned = coalesce(${b.pinned ?? null}, pinned), important = coalesce(${b.important ?? null}, important), team_ids = coalesce(${b.teamIds ?? null}, team_ids),
      attachments = coalesce(${att ? sql.json(att) : null}, attachments), expires_at = ${b.expiresAt === undefined ? sql`expires_at` : b.expiresAt ? `${b.expiresAt}T23:59:59` : null},
      updated_at = now() where id = ${id}`;
    ctx.hub.publish('global', 'board.changed', { id });
    return { ok: true };
  });

  app.delete('/board/posts/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const p = await loadPost(u, id);
    if (p.author_id !== u.id && !mayModerate(u)) throw forbidden();
    await sql`delete from board_posts where id = ${id}`;
    await storage.remove(`.aperio/board/posts/${id}`).catch(() => {});
    if (p.author_id !== u.id) await audit(sql, u, { action: 'board.delete', entityType: 'board_post', entityId: id, summary: `Mitteilung „${p.title}“ entfernt` });
    ctx.hub.publish('global', 'board.changed', { id });
    return { ok: true };
  });

  /** Lesebestätigung („Gelesen und verstanden“) */
  app.post('/board/posts/:id/confirm', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadPost(u, id);
    await sql`insert into board_reads (post_id, user_id, confirmed_at) values (${id}, ${u.id}, now()) on conflict (post_id, user_id) do update set confirmed_at = coalesce(board_reads.confirmed_at, now())`;
    return { ok: true };
  });

  app.post('/board/posts/:id/like', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadPost(u, id);
    const [had] = await sql`delete from board_likes where post_id = ${id} and user_id = ${u.id} returning 1`;
    if (!had) await sql`insert into board_likes (post_id, user_id) values (${id}, ${u.id})`;
    return { liked: !had };
  });

  /** Wer hat gelesen / bestätigt, wer noch nicht (für Verfasser und Teamleiter) */
  app.get('/board/posts/:id/reads', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const p = await loadPost(u, id);
    if (p.author_id !== u.id && !mayModerate(u)) throw forbidden();
    const people = await audience(p.team_ids);
    return sql`select u.id, u.display_name as "displayName", r.read_at as "readAt", r.confirmed_at as "confirmedAt" from users u left join board_reads r on r.post_id = ${id} and r.user_id = u.id
      where u.id = any(${people}) order by r.confirmed_at nulls first, r.read_at nulls first, u.display_name`;
  });

  // ------------------------------------------------ Marktplatz
  const itemSelect = (u: AuthUser) => sql`m.id, m.title, m.description, m.category, m.condition, m.price::float as price, m.price_type as "priceType", m.company,
    m.seller_id as "sellerId", s.display_name as "sellerName", m.location, m.images, m.status, m.reserved_for as "reservedFor", r.display_name as "reservedForName",
    m.expires_at as "expiresAt", m.created_at as "createdAt", m.updated_at as "updatedAt",
    exists (select 1 from market_watch w where w.item_id = m.id and w.user_id = ${u.id}) as watched,
    (select count(*)::int from market_watch w where w.item_id = m.id) as watchers`;
  const itemFrom = sql`market_items m left join users s on s.id = m.seller_id left join users r on r.id = m.reserved_for`;

  app.get('/board/market', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const q = parse(z.object({ category: z.string().max(80).optional(), q: z.string().max(100).optional(), mine: z.coerce.boolean().optional(), watched: z.coerce.boolean().optional(),
      company: z.coerce.boolean().optional(), free: z.coerce.boolean().optional(), sold: z.coerce.boolean().optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${itemSelect(u)} from ${itemFrom} where true
      ${q.mine ? sql`and m.seller_id = ${u.id}` : sql`and (m.expires_at is null or m.expires_at >= now()) and ${q.sold ? sql`true` : sql`m.status <> 'sold'`}`}
      ${q.watched ? sql`and exists (select 1 from market_watch w where w.item_id = m.id and w.user_id = ${u.id})` : sql``}
      ${q.category ? sql`and m.category = ${q.category}` : sql``} ${q.company ? sql`and m.company` : sql``} ${q.free ? sql`and m.price_type = 'free'` : sql``}
      ${like ? sql`and (m.title ilike ${like} or m.description ilike ${like})` : sql``}
      order by m.status = 'sold', m.created_at desc limit 300`;
  });

  const itemBody = z.object({
    title: z.string().trim().min(2).max(160), description: z.string().max(10000).default(''), category: z.string().max(80).default('Sonstiges'),
    condition: z.enum(['new', 'like_new', 'used', 'defect']).default('used'), price: z.number().min(0).max(10_000_000).nullable().default(null),
    priceType: z.enum(['fixed', 'negotiable', 'free', 'offer']).default('fixed'), company: z.boolean().default(false), location: z.string().max(200).default(''),
    images: z.array(z.object({ name: z.string(), path: z.string(), size: z.number(), image: z.boolean().optional() })).max(10).default([]),
    expiresAt: z.string().date().nullable().default(null),
  });

  app.post('/board/market', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(itemBody, req.body);
    if (b.company && !mayModerate(u)) throw forbidden('Firmenangebote stellen Teamleiter und Administratoren ein');
    if (b.priceType === 'fixed' && b.price == null) throw badRequest('Bitte einen Preis angeben oder „zu verschenken“ wählen');
    const id = randomUUID();
    const imgs = await keep('market', id, b.images);
    await sql`insert into market_items (id, title, description, category, condition, price, price_type, company, seller_id, location, images, expires_at)
      values (${id}, ${b.title}, ${b.description}, ${b.category}, ${b.condition}, ${b.priceType === 'free' ? null : b.price}, ${b.priceType}, ${b.company}, ${u.id}, ${b.location}, ${sql.json(imgs)}, ${b.expiresAt})`;
    ctx.hub.publish('global', 'market.changed', { id });
    return { id };
  });

  async function loadItem(id: string) {
    const [m] = await sql<{ id: string; seller_id: string; title: string; status: string; company: boolean }[]>`select id, seller_id, title, status, company from market_items where id = ${id}`;
    if (!m) throw notFound('Angebot nicht gefunden');
    return m;
  }

  app.patch('/board/market/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await loadItem(id);
    if (m.seller_id !== u.id && !(m.company && mayModerate(u)) && u.role !== 'admin') throw forbidden();
    const b = parse(itemBody.partial().extend({ status: z.enum(['available', 'reserved', 'sold']).optional(), reservedFor: z.string().uuid().nullable().optional() }), req.body);
    const imgs = b.images ? await keep('market', id, b.images) : null;
    await sql`update market_items set title = coalesce(${b.title ?? null}, title), description = coalesce(${b.description ?? null}, description),
      category = coalesce(${b.category ?? null}, category), condition = coalesce(${b.condition ?? null}, condition),
      price = ${b.price === undefined ? sql`price` : b.price}, price_type = coalesce(${b.priceType ?? null}, price_type), location = coalesce(${b.location ?? null}, location),
      images = coalesce(${imgs ? sql.json(imgs) : null}, images), status = coalesce(${b.status ?? null}, status),
      reserved_for = ${b.reservedFor === undefined ? (b.status === 'available' ? null : sql`reserved_for`) : b.reservedFor},
      expires_at = ${b.expiresAt === undefined ? sql`expires_at` : b.expiresAt}, updated_at = now() where id = ${id}`;
    if (b.status && b.status !== m.status) {
      const watchers = (await sql<{ user_id: string }[]>`select user_id from market_watch where item_id = ${id}`).map((r) => r.user_id);
      const label = { available: 'wieder verfügbar', reserved: 'reserviert', sold: 'verkauft' }[b.status];
      await notify(ctx, watchers, { kind: 'board.market', title: `Marktplatz: „${m.title}“ ist ${label}`, link: `/board?tab=market&item=${id}` }, u.id);
      if (b.status === 'reserved' && b.reservedFor) await notify(ctx, [b.reservedFor], { kind: 'board.market', title: `Für Sie reserviert: „${m.title}“`, link: `/board?tab=market&item=${id}` }, u.id);
    }
    ctx.hub.publish('global', 'market.changed', { id });
    return { ok: true };
  });

  app.delete('/board/market/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await loadItem(id);
    if (m.seller_id !== u.id && !mayModerate(u)) throw forbidden();
    await sql`delete from market_items where id = ${id}`;
    await storage.remove(`.aperio/board/market/${id}`).catch(() => {});
    ctx.hub.publish('global', 'market.changed', { id });
    return { ok: true };
  });

  app.post('/board/market/:id/watch', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadItem(id);
    const [had] = await sql`delete from market_watch where item_id = ${id} and user_id = ${u.id} returning 1`;
    if (!had) await sql`insert into market_watch (item_id, user_id) values (${id}, ${u.id})`;
    return { watched: !had };
  });

  /** „Ich habe Interesse“: Nachricht im Direktchat mit dem Anbieter (bzw. Benachrichtigung, falls der Chat nicht installiert ist) */
  app.post('/board/market/:id/contact', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const m = await loadItem(id);
    if (m.seller_id === u.id) throw badRequest('Das ist Ihr eigenes Angebot');
    const b = parse(z.object({ message: z.string().trim().min(1).max(4000) }), req.body);
    const text = `Marktplatz – „${m.title}“:\n${b.message}`;
    if (u.tools.includes('chat')) {
      const key = [u.id, m.seller_id].sort().join(':');
      let [c] = await sql<{ id: string }[]>`select id from chat_channels where direct_key = ${key}`;
      if (!c) {
        [c] = await sql<{ id: string }[]>`insert into chat_channels (kind, direct_key) values ('direct', ${key}) returning id`;
        await sql`insert into chat_members (channel_id, user_id) values (${c!.id}, ${u.id}), (${c!.id}, ${m.seller_id})`;
      }
      const [msg] = await sql<{ id: string }[]>`insert into chat_messages (channel_id, user_id, body) values (${c!.id}, ${u.id}, ${text}) returning id`;
      const [full] = await sql`select m.id, m.channel_id as "channelId", m.user_id as "userId", u.display_name as "userName", m.body, m.attachments, m.kind, m.meta,
        m.call_id as "callId", m.created_at as "createdAt", m.updated_at as "updatedAt", m.deleted_at as "deletedAt", '[]'::json as reactions
        from chat_messages m left join users u on u.id = m.user_id where m.id = ${msg!.id}`;
      ctx.hub.publish(`chat:${c!.id}`, 'message.created', full);
      ctx.hub.toUser(m.seller_id, 'chat.unread', { channelId: c!.id });
      await notify(ctx, [m.seller_id], { kind: 'chat.message', title: `${u.displayName} interessiert sich für „${m.title}“`, body: b.message.slice(0, 200), link: `/chat?channel=${c!.id}` }, u.id);
      return { channelId: c!.id };
    }
    await notify(ctx, [m.seller_id], { kind: 'board.market', title: `${u.displayName} interessiert sich für „${m.title}“`, body: b.message.slice(0, 500), link: `/board?tab=market&item=${id}` }, u.id);
    return { channelId: null };
  });

  app.get('/board/categories', async (req) => {
    requireUser(req);
    return ctx.settings.get('board');
  });
}
