import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { createSession, setSessionCookie, SESSION_COOKIE, type AuthUser } from '../lib/auth';
import { hashPassword, verifyPassword, sha256 } from '../lib/crypto';
import { badRequest, unauthorized } from '../lib/errors';
import { ldapAuthenticate } from '../lib/ldap';
import { audit } from '../services/audit';

export const PASSWORD_RULES = 'Mindestens 8 Zeichen, nicht "admin"';
export function checkPasswordStrength(pw: string, username: string) {
  if (pw.length < 8) throw badRequest('Das Passwort muss mindestens 8 Zeichen lang sein');
  if (pw.toLowerCase() === 'admin' || pw.toLowerCase() === username.toLowerCase()) throw badRequest('Dieses Passwort ist zu unsicher');
}

export default async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
    const username = body.username.trim();
    const [local] = await sql<{ id: string; password_hash: string | null; auth_source: string; active: boolean }[]>`
      select id, password_hash, auth_source, active from users where lower(username) = lower(${username})`;

    let userId: string | null = null;
    if (local && local.active && local.auth_source === 'local' && (await verifyPassword(body.password, local.password_hash))) {
      userId = local.id;
    } else if (!local || local.auth_source === 'ldap') {
      // Firmen-Login über Active Directory / LDAP
      const ldapSettings = await ctx.settings.get('ldap');
      const ldapUser = await ldapAuthenticate(ldapSettings, username, body.password).catch((e) => {
        req.log.warn(e, 'LDAP-Anmeldung fehlgeschlagen');
        return null;
      });
      if (ldapUser) {
        const role = ldapSettings.adminGroupDn && ldapUser.groups.includes(ldapSettings.adminGroupDn) ? 'admin'
          : ldapSettings.teamleadGroupDn && ldapUser.groups.includes(ldapSettings.teamleadGroupDn) ? 'teamlead' : null;
        if (local) {
          if (!local.active) throw unauthorized('Konto ist deaktiviert');
          await sql`update users set display_name = ${ldapUser.displayName}, email = ${ldapUser.email},
            role = coalesce(${role}, role), updated_at = now() where id = ${local.id}`;
          userId = local.id;
        } else {
          const [created] = await sql<{ id: string }[]>`insert into users (username, display_name, email, auth_source, role)
            values (${username}, ${ldapUser.displayName}, ${ldapUser.email}, 'ldap', ${role ?? 'member'}) returning id`;
          userId = created!.id;
        }
      }
    }
    if (!userId) throw unauthorized('Benutzername oder Passwort falsch');

    const token = await createSession(sql, userId, req);
    setSessionCookie(reply, token);
    const [u] = await sql<AuthUser[]>`select id, username, display_name as "displayName", role from users where id = ${userId}`;
    await audit(sql, u!, { action: 'auth.login', entityType: 'user', entityId: userId, summary: 'Anmeldung' });
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await sql`delete from sessions where id = ${sha256(token)}`;
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    if (!req.user) throw unauthorized();
    const teams = await sql`select t.id, t.name, t.icon, tm.is_lead as "isLead" from team_members tm
      join teams t on t.id = tm.team_id where tm.user_id = ${req.user.id} order by t.sort, t.name`;
    return { ...req.user, teams };
  });

  /** Passwort ändern – beim Erstzugang (admin/admin) erzwungen */
  app.post('/auth/change-password', async (req) => {
    const u = req.user;
    if (!u) throw unauthorized();
    if (u.authSource === 'ldap') throw badRequest('Firmenkonten ändern ihr Passwort im Firmenverzeichnis');
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
    const [row] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${u.id}`;
    if (!(await verifyPassword(body.currentPassword, row?.password_hash ?? null))) throw badRequest('Aktuelles Passwort ist falsch');
    if (body.newPassword === body.currentPassword) throw badRequest('Das neue Passwort muss sich vom alten unterscheiden');
    checkPasswordStrength(body.newPassword, u.username);
    await sql`update users set password_hash = ${await hashPassword(body.newPassword)}, must_change_password = false,
      updated_at = now() where id = ${u.id}`;
    // andere Sitzungen beenden
    const current = req.cookies[SESSION_COOKIE];
    await sql`delete from sessions where user_id = ${u.id} and id <> ${current ? sha256(current) : ''}`;
    await audit(sql, u, { action: 'auth.password_change', entityType: 'user', entityId: u.id, summary: 'Passwort geändert' });
    return { ok: true };
  });
}
