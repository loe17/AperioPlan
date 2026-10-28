import type { Sql } from '../db';
import type { AuthUser } from './auth';
import { forbidden, notFound } from './errors';

/** SQL-Bedingung: Projekte, die der Benutzer sehen darf (Alias "p"). */
export function visibleProjects(sql: Sql, u: AuthUser) {
  if (u.role === 'admin') return sql`true`;
  if (u.role === 'guest' || u.guestScope)
    return sql`exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = ${u.id})`;
  return sql`(p.visibility = 'company'
    or exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = ${u.id})
    or (p.visibility = 'team' and exists (select 1 from team_members tm where tm.team_id = p.team_id and tm.user_id = ${u.id})))`;
}

export interface ProjectAccess {
  id: string;
  number: string;
  name: string;
  folder_path: string | null;
  modules: string[];
  status: string;
  /** abgeschlossen oder archiviert: alles nur lesbar */
  locked: boolean;
  canEdit: boolean;
  canManage: boolean;
}

export const LOCKED_MESSAGE = 'Das Projekt ist abgeschlossen bzw. archiviert und nur noch lesbar. Ein Administrator kann den Status zurücksetzen.';

/** Prüft Lese-/Schreibrecht auf ein Projekt. */
export async function projectAccess(sql: Sql, u: AuthUser, projectId: string, need: 'read' | 'edit' | 'manage' | 'write' = 'read', opts: { allowLocked?: boolean } = {}): Promise<ProjectAccess> {
  const [p] = await sql<(ProjectAccess & { member_role: string | null; is_team_lead: boolean; is_team_member: boolean })[]>`
    select p.id, p.number, p.name, p.folder_path, p.modules, p.status,
      (select role from project_members where project_id = p.id and user_id = ${u.id}) as member_role,
      exists (select 1 from team_members where team_id = p.team_id and user_id = ${u.id} and is_lead) as is_team_lead,
      exists (select 1 from team_members where team_id = p.team_id and user_id = ${u.id}) as is_team_member
    from projects p where p.id = ${projectId} and ${visibleProjects(sql, u)}`;
  if (!p) throw notFound('Projekt nicht gefunden');
  const admin = u.role === 'admin';
  const guest = u.role === 'guest';
  p.canManage = admin || p.member_role === 'owner' || p.is_team_lead || (u.role === 'teamlead' && p.is_team_member);
  p.canEdit = !guest && (p.canManage || p.member_role === 'member' || p.member_role === null) && p.member_role !== 'viewer';
  p.locked = p.status === 'done' || p.status === 'archived';
  // 'write' = jede Änderung, auch ohne Bearbeitungsrecht (z. B. Zeit buchen, kommentieren)
  if (need !== 'read' && p.locked && !opts.allowLocked) throw forbidden(LOCKED_MESSAGE);
  if (p.locked && !opts.allowLocked) { p.canEdit = false; p.canManage = false; }
  if (need === 'edit' && !p.canEdit) throw forbidden('Nur Lesezugriff auf dieses Projekt');
  if (need === 'manage' && !p.canManage) throw forbidden('Nur Projektverantwortliche dürfen das');
  return p;
}
