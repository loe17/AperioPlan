import type { FastifyInstance } from 'fastify';
import { ROLES } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { hashPassword, randomToken, sha256 } from '../lib/crypto';
import { notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { checkPasswordStrength } from './auth';

const userFields = `id, username, display_name as "displayName", email, role, active, auth_source as "authSource",
  must_change_password as "mustChangePassword", vacation_days_per_year::float as "vacationDaysPerYear",
  avatar_color as "avatarColor", last_login_at as "lastLoginAt", created_at as "createdAt"`;

export default async function userRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  /** Mitarbeiterliste (für Zuweisungen, Chat, Kalender) */
  app.get('/users', async (req) => {
    const u = requireUser(req);
    const online = ctx.hub.onlineUserIds();
    const rows = u.role === 'admin'
      ? await sql.unsafe(`select ${userFields} from users order by display_name`)
      : await sql`select id, username, display_name as "displayName", email, role, avatar_color as "avatarColor"
          from users where active and role <> 'guest' order by display_name`;
    return rows.map((r) => ({ ...r, online: online.has(r.id as string) }));
  });

  app.post('/users', async (req) => {
    const admin = requireRole(req, 'admin');
    const b = parse(z.object({
      username: z.string().trim().min(2).max(64).regex(/^[\w.@-]+$/, 'nur Buchstaben, Ziffern, . _ - @'),
      displayName: z.string().trim().min(1),
      email: z.string().email().nullish(),
      role: z.enum(ROLES).default('member'),
      password: z.string().min(1),
      vacationDaysPerYear: z.number().min(0).max(100).default(30),
      teamIds: z.array(z.string().uuid()).default([]),
    }), req.body);
    checkPasswordStrength(b.password, b.username);
    const [created] = await sql<{ id: string }[]>`insert into users (username, display_name, email, role, password_hash, must_change_password, vacation_days_per_year)
      values (${b.username}, ${b.displayName}, ${b.email ?? null}, ${b.role}, ${await hashPassword(b.password)}, true, ${b.vacationDaysPerYear})
      returning id`;
    for (const t of b.teamIds) await sql`insert into team_members (team_id, user_id) values (${t}, ${created!.id}) on conflict do nothing`;
    await audit(sql, admin, { action: 'user.create', entityType: 'user', entityId: created!.id, summary: `Benutzer ${b.username} angelegt` });
    return created;
  });

  app.patch('/users/:id', async (req) => {
    const admin = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      displayName: z.string().trim().min(1).optional(),
      email: z.string().email().nullable().optional(),
      role: z.enum(ROLES).optional(),
      active: z.boolean().optional(),
      vacationDaysPerYear: z.number().min(0).max(100).optional(),
      password: z.string().optional(),
    }), req.body);
    const [cur] = await sql<{ username: string }[]>`select username from users where id = ${id}`;
    if (!cur) throw notFound();
    if (b.password) checkPasswordStrength(b.password, cur.username);
    await sql`update users set
      display_name = coalesce(${b.displayName ?? null}, display_name),
      email = ${b.email === undefined ? sql`email` : b.email},
      role = coalesce(${b.role ?? null}, role),
      active = coalesce(${b.active ?? null}, active),
      vacation_days_per_year = coalesce(${b.vacationDaysPerYear ?? null}, vacation_days_per_year),
      password_hash = coalesce(${b.password ? await hashPassword(b.password) : null}, password_hash),
      must_change_password = ${b.password ? true : sql`must_change_password`},
      updated_at = now()
      where id = ${id}`;
    if (b.active === false || b.password) await sql`delete from sessions where user_id = ${id}`;
    await audit(sql, admin, { action: 'user.update', entityType: 'user', entityId: id, summary: `Benutzer ${cur.username} geändert`,
      details: { ...b, password: b.password ? '(zurückgesetzt)' : undefined } });
    return { ok: true };
  });

  /** Eigenes Profil (Name, Sprache, Farbschema) */
  app.patch('/me', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({
      displayName: z.string().trim().min(1).optional(),
      email: z.string().email().nullable().optional(),
      locale: z.enum(['de', 'en']).optional(),
      theme: z.enum(['system', 'light', 'dark']).optional(),
    }), req.body);
    await sql`update users set
      display_name = coalesce(${b.displayName ?? null}, display_name),
      email = ${b.email === undefined ? sql`email` : b.email},
      locale = coalesce(${b.locale ?? null}, locale),
      theme = coalesce(${b.theme ?? null}, theme), updated_at = now()
      where id = ${u.id}`;
    return { ok: true };
  });

  // ------------------------------------------------ API-Schlüssel (z. B. für den CAD-Wächter)
  app.get('/me/tokens', async (req) => {
    const u = requireUser(req);
    return sql`select id, name, created_at as "createdAt", last_used_at as "lastUsedAt" from api_tokens where user_id = ${u.id} order by created_at desc`;
  });
  app.post('/me/tokens', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
    const token = `ap_${randomToken(32)}`;
    const [row] = await sql`insert into api_tokens (user_id, name, token_hash) values (${u.id}, ${b.name}, ${sha256(token)}) returning id`;
    await audit(sql, u, { action: 'token.create', entityType: 'api_token', entityId: row!.id, summary: `API-Schlüssel "${b.name}" erstellt` });
    return { id: row!.id, token };
  });
  app.delete('/me/tokens/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await sql`delete from api_tokens where id = ${id} and user_id = ${u.id}`;
    return { ok: true };
  });
}
