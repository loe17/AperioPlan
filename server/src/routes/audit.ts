import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { forbidden } from '../lib/errors';
import { writeCsv, writeXlsx } from '../lib/xlsx';
import { Pdf } from '../lib/pdf';

const filterSchema = z.object({
  projectId: z.string().uuid().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  userId: z.string().uuid().optional(),
  action: z.string().optional(),
  q: z.string().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
type Filter = z.infer<typeof filterSchema>;

/** Lückenloses Änderungsprotokoll: Wer? Wann? Was? – mit Filtern und Download (Excel, CSV, PDF mit Prüfsumme) */
export default async function auditRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  async function check(u: AuthUser, q: Filter) {
    if (q.projectId) await projectAccess(sql, u, q.projectId);
    else if (u.role !== 'admin') throw forbidden('Das Gesamtprotokoll sehen nur Administratoren');
  }

  const where = (q: Filter) => sql`where true
    ${q.projectId ? sql`and project_id = ${q.projectId}` : sql``}
    ${q.entityType ? sql`and entity_type = ${q.entityType}` : sql``}
    ${q.entityId ? sql`and entity_id = ${q.entityId}` : sql``}
    ${q.userId ? sql`and user_id = ${q.userId}` : sql``}
    ${q.action ? sql`and action like ${`${q.action}%`}` : sql``}
    ${q.q ? sql`and (summary ilike ${`%${q.q}%`} or user_name ilike ${`%${q.q}%`})` : sql``}
    ${q.from ? sql`and at >= ${q.from}::date` : sql``}
    ${q.to ? sql`and at < (${q.to}::date + 1)` : sql``}`;

  app.get('/audit', async (req) => {
    const u = requireUser(req);
    const q = parse(filterSchema, req.query);
    await check(u, q);
    return sql`select id::int, at, user_id as "userId", user_name as "userName", action, entity_type as "entityType",
      entity_id as "entityId", project_id as "projectId", summary, details from audit_log
      ${where(q)} ${q.before ? sql`and id < ${q.before}` : sql``}
      order by id desc limit ${q.limit}`;
  });

  /** Bereiche (Aktionen) für den Filter */
  app.get('/audit/actions', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'admin') throw forbidden();
    return (await sql<{ a: string }[]>`select distinct split_part(action, '.', 1) as a from audit_log order by 1`).map((r) => r.a);
  });

  /**
   * Download. Die Prüfsumme (SHA-256) wird über alle Zeilen in fester Reihenfolge gebildet –
   * dieselben Filter ergeben später dieselbe Prüfsumme, solange die Einträge unverändert sind.
   */
  app.get('/audit/export', async (req, reply) => {
    const u = requireUser(req);
    const q = parse(filterSchema.extend({ format: z.enum(['xlsx', 'csv', 'pdf', 'checksum']).default('xlsx') }), req.query);
    await check(u, q);
    const rows = await sql<{ id: number; at: Date; user_name: string | null; action: string; entity_type: string | null; entity_id: string | null; summary: string; pnum: string | null }[]>`
      select a.id::int, a.at, a.user_name, a.action, a.entity_type, a.entity_id, a.summary, p.number as pnum from audit_log a left join projects p on p.id = a.project_id
      ${where(q)} order by a.id asc limit 100000`;
    const hash = createHash('sha256');
    for (const r of rows) hash.update(`${r.id}|${r.at.toISOString()}|${r.user_name ?? ''}|${r.action}|${r.entity_type ?? ''}|${r.entity_id ?? ''}|${r.summary}\n`);
    const checksum = hash.digest('hex');
    const range = `${q.from ? new Date(q.from).toLocaleDateString('de-DE') : 'Beginn'} – ${q.to ? new Date(q.to).toLocaleDateString('de-DE') : 'heute'}`;
    const fname = `Aenderungsprotokoll_${new Date().toISOString().slice(0, 10)}`;
    if (q.format === 'checksum') return { checksum, count: rows.length };
    const fmt = (d: Date) => d.toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' });
    if (q.format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${fname}.csv"`).header('x-checksum', checksum);
      return writeCsv([['Nr.', 'Zeitpunkt', 'Wer', 'Projekt', 'Aktion', 'Bereich', 'Was'], ...rows.map((r) => [r.id, fmt(r.at), r.user_name ?? 'System', r.pnum, r.action, r.entity_type, r.summary])]);
    }
    if (q.format === 'xlsx') {
      reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="${fname}.xlsx"`).header('x-checksum', checksum);
      return writeXlsx([
        { name: 'Protokoll', widths: [8, 20, 22, 12, 22, 16, 80], rows: [['Nr.', 'Zeitpunkt', 'Wer', 'Projekt', 'Aktion', 'Bereich', 'Was'], ...rows.map((r) => [r.id, r.at, r.user_name ?? 'System', r.pnum, r.action, r.entity_type, r.summary])] },
        { name: 'Prüfsumme', widths: [24, 80], rows: [['Angabe', 'Wert'], ['Zeitraum', range], ['Einträge', rows.length], ['SHA-256', checksum], ['Erstellt', fmt(new Date())], ['Erstellt von', u.displayName]] },
      ]);
    }
    const company = await ctx.settings.get('company');
    const pdf = new Pdf('Änderungsprotokoll', company.name);
    pdf.text(pdf.margin, pdf.y, company.name, { size: 9, color: '#6b7280' }); pdf.y += 18;
    pdf.paragraph('Änderungsprotokoll', { size: 16, bold: true, gap: 4 });
    pdf.paragraph(`Zeitraum ${range} · ${rows.length} Einträge · erstellt ${fmt(new Date())} von ${u.displayName}`, { color: '#4b5563', gap: 10 });
    pdf.table([{ label: 'Nr.', width: 36 }, { label: 'Zeitpunkt', width: 82 }, { label: 'Wer', width: 80 }, { label: 'Was', width: 297 }],
      rows.map((r) => [String(r.id), fmt(r.at), r.user_name ?? 'System', `${r.pnum ? `${r.pnum}: ` : ''}${r.summary}`]), { size: 8, zebra: true });
    pdf.ensure(60);
    pdf.paragraph('Prüfsumme (SHA-256 über alle Einträge dieses Auszugs)', { bold: true, size: 9, gap: 2 });
    pdf.paragraph(checksum, { size: 8 });
    pdf.paragraph('Nachweis: Derselbe Auszug (gleiche Filter) lässt sich jederzeit erneut erzeugen. Stimmt die Prüfsumme überein, wurde an diesen Einträgen nichts verändert.', { size: 8, color: '#6b7280' });
    pdf.footer((p, t) => `Änderungsprotokoll · Prüfsumme ${checksum.slice(0, 16)}… · Seite ${p} von ${t}`);
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${fname}.pdf"`).header('x-checksum', checksum);
    return pdf.toBuffer();
  });
}
