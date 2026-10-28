import type { FastifyInstance } from 'fastify';
import { ROLES, TOOLS } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireRole, requireUser } from '../lib/auth';
import { hashPassword, randomToken, sha256 } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { checkPasswordStrength } from './auth';

const userFields = `id, username, display_name as "displayName", email, role, active, auth_source as "authSource",
  must_change_password as "mustChangePassword", vacation_days_per_year::float as "vacationDaysPerYear",
  avatar_color as "avatarColor", last_login_at as "lastLoginAt", created_at as "createdAt",
  department_id as "departmentId", (select name from teams where id = users.department_id) as "departmentName",
  tools, phone, avatar_version as "avatarVersion", avatar_path is not null as "hasAvatar", totp_enabled as "totpEnabled"`;

export default async function userRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  /** Mitarbeiterliste (für Zuweisungen, Chat, Kalender) */
  app.get('/users', async (req) => {
    const u = requireUser(req);
    const online = ctx.hub.onlineUserIds();
    const rows = u.role === 'admin'
      ? await sql.unsafe(`select ${userFields} from users where deleted_at is null order by display_name`)
      : await sql`select id, username, display_name as "displayName", email, role, avatar_color as "avatarColor",
          avatar_version as "avatarVersion", avatar_path is not null as "hasAvatar", phone, department_id as "departmentId"
          from users where active and deleted_at is null and role <> 'guest' order by display_name`;
    const presence = await ctx.presence.all();
    const iShow = u.showLastSeen;
    return rows.map((r) => {
      const p = presence.get(r.id as string);
      return { ...r, online: online.has(r.id as string), status: p?.status ?? 'offline', lastSeenAt: iShow ? p?.lastSeenAt ?? null : null };
    });
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
      departmentId: z.string().uuid().nullable().default(null),
      tools: z.array(z.enum(TOOLS)).nullable().default(null),
      phone: z.string().max(60).default(''),
    }), req.body);
    checkPasswordStrength(b.password, b.username);
    if (b.role !== 'guest' && !b.departmentId) throw badRequest('Bitte eine Abteilung auswählen');
    const [created] = await sql<{ id: string }[]>`insert into users (username, display_name, email, role, password_hash, must_change_password, vacation_days_per_year, department_id, tools, phone)
      values (${b.username}, ${b.displayName}, ${b.email ?? null}, ${b.role}, ${await hashPassword(b.password)}, true, ${b.vacationDaysPerYear}, ${b.departmentId}, ${b.tools}, ${b.phone})
      returning id`;
    // Die Abteilung ist zugleich ein Team – Mitgliedschaft automatisch
    for (const t of new Set([...b.teamIds, ...(b.departmentId ? [b.departmentId] : [])])) await sql`insert into team_members (team_id, user_id) values (${t}, ${created!.id}) on conflict do nothing`;
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
      departmentId: z.string().uuid().nullable().optional(),
      tools: z.array(z.enum(TOOLS)).nullable().optional(),
      phone: z.string().max(60).optional(),
    }), req.body);
    const [cur] = await sql<{ username: string; role: string; department_id: string | null }[]>`select username, role, department_id from users where id = ${id} and deleted_at is null`;
    if (!cur) throw notFound();
    if (b.password) checkPasswordStrength(b.password, cur.username);
    if ((b.role ?? cur.role) !== 'guest' && !(b.departmentId === undefined ? cur.department_id : b.departmentId)) throw badRequest('Bitte eine Abteilung auswählen');

    await sql`update users set
      display_name = coalesce(${b.displayName ?? null}, display_name),
      email = ${b.email === undefined ? sql`email` : b.email},
      role = coalesce(${b.role ?? null}, role),
      active = coalesce(${b.active ?? null}, active),
      vacation_days_per_year = coalesce(${b.vacationDaysPerYear ?? null}, vacation_days_per_year),
      password_hash = coalesce(${b.password ? await hashPassword(b.password) : null}, password_hash),
      must_change_password = ${b.password ? true : sql`must_change_password`},
      department_id = ${b.departmentId === undefined ? sql`department_id` : b.departmentId},
      tools = ${b.tools === undefined ? sql`tools` : b.tools},
      phone = coalesce(${b.phone ?? null}, phone),
      updated_at = now()
      where id = ${id}`;
    if (b.departmentId && b.departmentId !== cur.department_id) await sql`insert into team_members (team_id, user_id) values (${b.departmentId}, ${id}) on conflict do nothing`;
    if (b.active === false || b.password) await sql`delete from sessions where user_id = ${id}`;
    ctx.hub.toUser(id, 'session.changed', {});
    await audit(sql, admin, { action: 'user.update', entityType: 'user', entityId: id, summary: `Benutzer ${cur.username} geändert`,
      details: { ...b, password: b.password ? '(zurückgesetzt)' : undefined } });
    return { ok: true };
  });

  /**
   * Benutzer löschen: Anmeldung, Passwort, Profilbild, Notizen und persönliche Einstellungen werden entfernt.
   * Nachrichten, Kommentare, Zeiten, Projekteinträge und das Änderungsprotokoll bleiben erhalten
   * und zeigen weiter den Namen mit dem Zusatz „(gelöscht)“.
   */
  app.delete('/users/:id', async (req) => {
    const admin = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ transferTo: z.string().uuid().nullable().default(null) }), req.body ?? {});
    if (id === admin.id) throw badRequest('Das eigene Konto kann nicht gelöscht werden');
    const [cur] = await sql<{ username: string; display_name: string; role: string; avatar_path: string | null }[]>`select username, display_name, role, avatar_path from users where id = ${id} and deleted_at is null`;
    if (!cur) throw notFound();
    if (cur.role === 'admin') {
      const [cnt] = await sql<{ n: number }[]>`select count(*)::int as n from users where role = 'admin' and active and deleted_at is null and id <> ${id}`;
      if (!cnt?.n) throw badRequest('Der letzte Administrator kann nicht gelöscht werden');
    }
    const open = (await sql<{ n: number }[]>`select count(*)::int as n from tasks where assignee_id = ${id} and status <> 'done'`)[0]?.n ?? 0;
    await sql.begin(async (tx) => {
      if (b.transferTo) await tx`update tasks set assignee_id = ${b.transferTo}, updated_at = now() where assignee_id = ${id} and status <> 'done'`;
      else await tx`update tasks set assignee_id = null where assignee_id = ${id} and status <> 'done'`;
      await tx`update project_members set user_id = ${b.transferTo} where user_id = ${id} and role = 'owner' and ${b.transferTo}::uuid is not null
        and not exists (select 1 from project_members pm2 where pm2.project_id = project_members.project_id and pm2.user_id = ${b.transferTo})`;
      await tx`delete from project_members where user_id = ${id}`;
      await tx`delete from team_members where user_id = ${id}`;
      await tx`delete from sessions where user_id = ${id}`;
      await tx`delete from api_tokens where user_id = ${id}`;
      await tx`delete from private_notes where user_id = ${id}`;
      await tx`delete from favorites where user_id = ${id}`;
      await tx`delete from notifications where user_id = ${id}`;
      await tx`delete from task_watchers where user_id = ${id}`;
      await tx`update time_entries set ended_at = now() where user_id = ${id} and ended_at is null`;
      await tx`update users set deleted_at = now(), active = false, username = ${`geloescht-${id.slice(0, 8)}`},
        display_name = ${`${cur.display_name} (gelöscht)`}, email = null, phone = '', password_hash = null, totp_secret = null,
        totp_enabled = false, avatar_path = null, tools = null, notify_prefs = '{}', updated_at = now() where id = ${id}`;
    });
    if (cur.avatar_path) await ctx.storage.remove(cur.avatar_path);
    ctx.hub.toUser(id, 'session.changed', {});
    ctx.hub.publish('global', 'user.changed', { userId: id });
    await audit(sql, admin, { action: 'user.delete', entityType: 'user', entityId: id,
      summary: `Benutzer ${cur.username} (${cur.display_name}) gelöscht${open ? `, ${open} offene Aufgabe(n) ${b.transferTo ? 'übertragen' : 'freigegeben'}` : ''}` });
    return { ok: true, transferred: open };
  });

  /** Zwei-Faktor-Anmeldung eines Benutzers zurücksetzen (z. B. neues Handy) */
  app.delete('/users/:id/2fa', async (req) => {
    const admin = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    await sql`update users set totp_enabled = false, totp_secret = null where id = ${id}`;
    await audit(sql, admin, { action: 'user.2fa_reset', entityType: 'user', entityId: id, summary: 'Zwei-Faktor-Anmeldung zurückgesetzt' });
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
      phone: z.string().max(60).optional(),
      statusMode: z.enum(['auto', 'online', 'idle', 'away', 'offline']).optional(),
      showLastSeen: z.boolean().optional(),
    }), req.body);
    await sql`update users set
      display_name = coalesce(${b.displayName ?? null}, display_name),
      email = ${b.email === undefined ? sql`email` : b.email},
      locale = coalesce(${b.locale ?? null}, locale),
      theme = coalesce(${b.theme ?? null}, theme), phone = coalesce(${b.phone ?? null}, phone),
      status_mode = coalesce(${b.statusMode ?? null}, status_mode), show_last_seen = coalesce(${b.showLastSeen ?? null}, show_last_seen),
      updated_at = now()
      where id = ${u.id}`;
    if (b.statusMode || b.showLastSeen !== undefined || b.displayName) ctx.hub.publish('global', 'user.changed', { userId: u.id });
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
