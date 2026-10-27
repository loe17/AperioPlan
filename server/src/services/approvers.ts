import type { Sql } from '../db';
import type { AuthUser } from '../lib/auth';

/** Genehmiger eines Mitarbeiters: Teamleitungen seiner Teams, ersatzweise alle Administratoren. */
export async function approversOf(sql: Sql, userId: string): Promise<string[]> {
  const leads = await sql<{ id: string }[]>`select distinct l.user_id as id from team_members m
    join team_members l on l.team_id = m.team_id and l.is_lead where m.user_id = ${userId} and l.user_id <> ${userId}`;
  if (leads.length) return leads.map((l) => l.id);
  const admins = await sql<{ id: string }[]>`select id from users where role = 'admin' and active and id <> ${userId}`;
  return admins.map((a) => a.id);
}

/** Darf u Anträge von userId genehmigen? */
export async function canApprove(sql: Sql, u: AuthUser, userId: string): Promise<boolean> {
  if (u.id === userId) return false;
  if (u.role === 'admin') return true;
  const [r] = await sql`select 1 from team_members m join team_members l on l.team_id = m.team_id and l.is_lead
    where m.user_id = ${userId} and l.user_id = ${u.id}`;
  return Boolean(r);
}

/** Mitarbeiter, deren Anträge u genehmigen darf */
export async function reviewableUserIds(sql: Sql, u: AuthUser): Promise<string[] | 'all'> {
  if (u.role === 'admin') return 'all';
  const rows = await sql<{ id: string }[]>`select distinct m.user_id as id from team_members l
    join team_members m on m.team_id = l.team_id where l.user_id = ${u.id} and l.is_lead and m.user_id <> ${u.id}`;
  return rows.map((r) => r.id);
}
