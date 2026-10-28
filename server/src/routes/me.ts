import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { visibleProjects } from '../lib/access';
import { badRequest, notFound } from '../lib/errors';
import { NOTIFY_KINDS } from '@aperio/shared';
import QRCode from 'qrcode';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';
import { openSecret, sealSecret } from '../services/secrets';
import { audit } from '../services/audit';

export default async function meRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  // ------------------------------------------------ Benachrichtigungen (Glocke)
  app.get('/notifications', async (req) => {
    const u = requireUser(req);
    return sql`select id, kind, title, body, link, read_at as "readAt", created_at as "createdAt"
      from notifications where user_id = ${u.id} order by created_at desc limit 100`;
  });
  app.post('/notifications/read', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ ids: z.array(z.string().uuid()).optional() }), req.body ?? {});
    if (b.ids?.length) await sql`update notifications set read_at = now() where user_id = ${u.id} and id = any(${b.ids})`;
    else await sql`update notifications set read_at = now() where user_id = ${u.id} and read_at is null`;
    return { ok: true };
  });

  // ------------------------------------------------ Favoriten
  app.get('/favorites', async (req) => {
    const u = requireUser(req);
    return sql`select f.entity_type as "entityType", f.entity_id as "entityId", p.number, p.name, p.icon
      from favorites f join projects p on p.id = f.entity_id and f.entity_type = 'project'
      where f.user_id = ${u.id} and ${visibleProjects(sql, u)} order by p.number`;
  });
  app.put('/favorites/:type/:id', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ type: z.enum(['project']), id: z.string().uuid() }), req.params);
    await sql`insert into favorites (user_id, entity_type, entity_id) values (${u.id}, ${p.type}, ${p.id}) on conflict do nothing`;
    return { ok: true };
  });
  app.delete('/favorites/:type/:id', async (req) => {
    const u = requireUser(req);
    const p = parse(z.object({ type: z.enum(['project']), id: z.string().uuid() }), req.params);
    await sql`delete from favorites where user_id = ${u.id} and entity_type = ${p.type} and entity_id = ${p.id}`;
    return { ok: true };
  });

  // ------------------------------------------------ Private Notizen
  app.get('/notes', async (req) => {
    const u = requireUser(req);
    return sql`select id, title, body, updated_at as "updatedAt" from private_notes where user_id = ${u.id} order by updated_at desc`;
  });
  app.post('/notes', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ title: z.string().default(''), body: z.string().default('') }), req.body ?? {});
    const [n] = await sql`insert into private_notes (user_id, title, body) values (${u.id}, ${b.title}, ${b.body})
      returning id, title, body, updated_at as "updatedAt"`;
    return n;
  });
  app.patch('/notes/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ title: z.string().optional(), body: z.string().optional() }), req.body);
    await sql`update private_notes set title = coalesce(${b.title ?? null}, title), body = coalesce(${b.body ?? null}, body),
      updated_at = now() where id = ${id} and user_id = ${u.id}`;
    return { ok: true };
  });
  app.delete('/notes/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from private_notes where id = ${id} and user_id = ${u.id}`;
    return { ok: true };
  });

  // ------------------------------------------------ Profilbild
  app.post('/me/avatar', async (req) => {
    const u = requireUser(req);
    const part = await req.file({ limits: { fileSize: 3 * 1024 * 1024 } });
    if (!part) throw badRequest('Bitte ein Bild auswählen');
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[part.mimetype];
    if (!ext) throw badRequest('Erlaubt sind PNG, JPG und WebP');
    const path = `.aperio/profilbilder/${u.id}.${ext}`;
    await ctx.storage.write(path, part.file);
    if (part.file.truncated) { await ctx.storage.remove(path); throw badRequest('Das Bild ist zu groß (höchstens 3 MB)'); }
    const [r] = await sql<{ avatar_version: number }[]>`update users set avatar_path = ${path}, avatar_version = avatar_version + 1, updated_at = now()
      where id = ${u.id} returning avatar_version`;
    ctx.hub.publish('global', 'user.changed', { userId: u.id });
    return { avatarVersion: r!.avatar_version };
  });
  app.delete('/me/avatar', async (req) => {
    const u = requireUser(req);
    const [row] = await sql<{ avatar_path: string | null }[]>`select avatar_path from users where id = ${u.id}`;
    if (row?.avatar_path) await ctx.storage.remove(row.avatar_path);
    await sql`update users set avatar_path = null, avatar_version = avatar_version + 1 where id = ${u.id}`;
    ctx.hub.publish('global', 'user.changed', { userId: u.id });
    return { ok: true };
  });
  app.get('/users/:id/avatar', async (req, reply) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    const [row] = await sql<{ avatar_path: string | null }[]>`select avatar_path from users where id = ${id}`;
    if (!row?.avatar_path || !(await ctx.storage.stat(row.avatar_path))) throw notFound('Kein Profilbild');
    const ext = row.avatar_path.split('.').pop();
    reply.header('cache-control', 'private, max-age=86400');
    return reply.type(ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg').send(ctx.storage.read(row.avatar_path));
  });

  // ------------------------------------------------ Zwei-Faktor-Anmeldung (freiwillig)
  app.post('/me/2fa/setup', async (req) => {
    const u = requireUser(req);
    const secret = newTotpSecret();
    await sql`update users set totp_secret = ${await sealSecret(ctx, secret)}, totp_enabled = false where id = ${u.id}`;
    const company = await ctx.settings.get('company');
    const url = otpauthUrl(secret, u.username, company.name || 'AperioPlan');
    return { secret, otpauth: url, qr: await QRCode.toString(url, { type: 'svg', margin: 1, width: 220 }) };
  });
  app.post('/me/2fa/enable', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ code: z.string() }), req.body);
    const [row] = await sql<{ totp_secret: string | null }[]>`select totp_secret from users where id = ${u.id}`;
    const secret = await openSecret(ctx, row?.totp_secret);
    if (!secret) throw badRequest('Bitte zuerst den QR-Code erzeugen');
    if (!verifyTotp(secret, b.code)) throw badRequest('Der Code stimmt nicht – bitte den aktuellen Code aus der App eingeben');
    await sql`update users set totp_enabled = true where id = ${u.id}`;
    await audit(sql, u, { action: 'auth.2fa_on', entityType: 'user', entityId: u.id, summary: 'Zwei-Faktor-Anmeldung eingeschaltet' });
    return { ok: true };
  });
  app.post('/me/2fa/disable', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ code: z.string() }), req.body);
    const [row] = await sql<{ totp_secret: string | null; totp_enabled: boolean }[]>`select totp_secret, totp_enabled from users where id = ${u.id}`;
    const secret = await openSecret(ctx, row?.totp_secret);
    if (row?.totp_enabled && (!secret || !verifyTotp(secret, b.code))) throw badRequest('Der Code stimmt nicht');
    await sql`update users set totp_enabled = false, totp_secret = null where id = ${u.id}`;
    await audit(sql, u, { action: 'auth.2fa_off', entityType: 'user', entityId: u.id, summary: 'Zwei-Faktor-Anmeldung ausgeschaltet' });
    return { ok: true };
  });

  // ------------------------------------------------ Benachrichtigungen einstellen
  app.get('/me/notify-prefs', async (req) => {
    const u = requireUser(req);
    const [row] = await sql<{ notify_prefs: Record<string, { app?: boolean; mail?: boolean }> }[]>`select notify_prefs from users where id = ${u.id}`;
    return NOTIFY_KINDS.map((k) => ({ ...k, app: row?.notify_prefs?.[k.kind]?.app ?? k.app, mail: row?.notify_prefs?.[k.kind]?.mail ?? k.mail }));
  });
  app.put('/me/notify-prefs', async (req) => {
    const u = requireUser(req);
    const b = parse(z.record(z.string(), z.object({ app: z.boolean(), mail: z.boolean() })), req.body);
    const clean = Object.fromEntries(Object.entries(b).filter(([k]) => NOTIFY_KINDS.some((n) => n.kind === k)));
    await sql`update users set notify_prefs = ${sql.json(clean)} where id = ${u.id}`;
    return { ok: true };
  });

  // ------------------------------------------------ Startassistent
  app.post('/me/onboarding', async (req) => {
    const u = requireUser(req);
    await sql`update users set onboarded_at = now() where id = ${u.id}`;
    return { ok: true };
  });
}
