import type { Sql } from '../db';
import type { AuthUser } from '../lib/auth';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  projectId?: string | null;
  summary: string;
  details?: unknown;
}

/** Schreibt einen Eintrag in das revisionssichere Änderungsprotokoll (Wer? Wann? Was?). */
export async function audit(sql: Sql, user: AuthUser | null, e: AuditEntry): Promise<void> {
  await sql`insert into audit_log (user_id, user_name, action, entity_type, entity_id, project_id, summary, details)
    values (${user?.id ?? null}, ${user?.displayName ?? 'System'}, ${e.action}, ${e.entityType}, ${e.entityId ?? null},
            ${e.projectId ?? null}, ${e.summary}, ${e.details === undefined ? null : sql.json(e.details as never)})`;
}
