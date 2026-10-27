import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@aperio/shared';
import type { Sql } from '../db';
import { config } from '../config';
import { randomToken, sha256 } from './crypto';
import { forbidden, unauthorized } from './errors';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  mustChangePassword: boolean;
  locale: string;
  theme: string;
  authSource: 'local' | 'ldap';
  /** Gast über Freigabelink: auf diese Projekte beschränkt */
  guestScope?: { projectId: string; areas: string[] };
}

export const SESSION_COOKIE = 'aperio_session';

export async function createSession(sql: Sql, userId: string, req: FastifyRequest): Promise<string> {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await sql`insert into sessions (id, user_id, expires_at, user_agent, ip)
    values (${sha256(token)}, ${userId}, ${expires}, ${req.headers['user-agent'] ?? null}, ${req.ip})`;
  await sql`update users set last_login_at = now() where id = ${userId}`;
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: config.sessionDays * 86400,
  });
}

const userSelect = (sql: Sql) => sql`
  id, username, display_name as "displayName", email, role, must_change_password as "mustChangePassword",
  locale, theme, auth_source as "authSource"`;

/** Ermittelt den Benutzer aus Sitzungs-Cookie oder API-Token (Authorization: Bearer ...). */
export async function resolveUser(sql: Sql, req: FastifyRequest): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const hash = sha256(header.slice(7));
    const [u] = await sql<AuthUser[]>`select ${userSelect(sql)} from users
      where active and id = (select user_id from api_tokens where token_hash = ${hash})`;
    if (u) {
      await sql`update api_tokens set last_used_at = now() where token_hash = ${hash}`;
      return u;
    }
    return null;
  }
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const [u] = await sql<AuthUser[]>`select ${userSelect(sql)} from users
    where active and id = (select user_id from sessions where id = ${sha256(token)} and expires_at > now())`;
  return u ?? null;
}

export function requireUser(req: FastifyRequest): AuthUser {
  const u = req.user;
  if (!u) throw unauthorized();
  if (u.mustChangePassword) throw forbidden('Bitte zuerst das Passwort ändern');
  return u;
}

const RANK: Record<Role, number> = { guest: 0, member: 1, teamlead: 2, admin: 3 };
export function requireRole(req: FastifyRequest, role: Role): AuthUser {
  const u = requireUser(req);
  if (RANK[u.role] < RANK[role]) throw forbidden();
  return u;
}
export const hasRole = (u: AuthUser, role: Role) => RANK[u.role] >= RANK[role];

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}
