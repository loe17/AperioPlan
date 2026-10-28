import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { posix } from 'node:path';
import { formatDocumentNumber } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, requireRole } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { safeName, storeFile } from '../services/files';
import { fillOfficeTemplate } from '../lib/zip';
import { BUILTIN_TEMPLATES } from '../services/officeTemplates';

const STATUS = ['draft', 'review', 'released', 'obsolete'] as const;
const STATUS_LABEL: Record<string, string> = { draft: 'Entwurf', review: 'In Prüfung', released: 'Freigegeben', obsolete: 'Ungültig' };
const TEMPLATE_DIR = '.aperio/vorlagen';

/**
 * Dokumentenregister je Projekt: fortlaufende Nummer (0100-DOK-001), Art, Version, Status
 * und die zugehörige Datei – auf Wunsch aus einer Vorlage mit ausgefüllten Platzhaltern.
 */
export default async function documentRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  const docSelect = sql`d.id, d.number, d.title, d.kind, d.version, d.status, d.description, d.file_id as "fileId",
    f.name as "fileName", f.path as "filePath", f.version as "fileVersion", d.template_id as "templateId",
    d.created_at as "createdAt", d.updated_at as "updatedAt", us.display_name as "createdByName"`;

  app.get('/projects/:id/documents', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await projectAccess(sql, u, id);
    return sql`select ${docSelect} from project_documents d left join files f on f.id = d.file_id left join users us on us.id = d.created_by
      where d.project_id = ${id} order by d.number desc`;
  });

  app.get('/document-templates', async (req) => {
    requireUser(req);
    return sql`select id, builtin_key as "builtinKey", name, kind, ext, active from document_templates order by builtin_key is null, name`;
  });

  async function templateBuffer(t: { builtin_key: string | null; storage_path: string | null }): Promise<Buffer> {
    if (t.builtin_key) {
      const b = BUILTIN_TEMPLATES.find((x) => x.key === t.builtin_key);
      if (!b) throw notFound('Vorlage nicht gefunden');
      return b.build();
    }
    if (!t.storage_path) throw notFound('Vorlagendatei fehlt');
    const chunks: Buffer[] = [];
    for await (const c of storage.read(t.storage_path)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  app.post('/projects/:id/documents', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const p = await projectAccess(sql, u, id, 'edit');
    const b = parse(z.object({
      title: z.string().trim().min(1).max(200),
      kind: z.string().trim().min(1).max(60).default('Sonstiges'),
      description: z.string().max(5000).default(''),
      templateId: z.string().uuid().nullable().default(null),
      fileId: z.string().uuid().nullable().default(null),
      folder: z.string().default('03_Doku'),
    }), req.body);
    const doc = await sql.begin(async (tx) => {
      const seq = (await tx<{ doc_seq: number }[]>`update projects set doc_seq = doc_seq + 1 where id = ${id} returning doc_seq`)[0]!.doc_seq;
      const number = formatDocumentNumber(p.number, seq);
      const [d] = await tx<{ id: string; number: string }[]>`insert into project_documents (project_id, number, title, kind, description, file_id, template_id, created_by)
        values (${id}, ${number}, ${b.title}, ${b.kind}, ${b.description}, ${b.fileId}, ${b.templateId}, ${u.id}) returning id, number`;
      return d!;
    });
    // Datei aus der Vorlage erzeugen und im Projektordner ablegen
    if (b.templateId) {
      const [t] = await sql<{ builtin_key: string | null; storage_path: string | null; ext: string; kind: string }[]>`select builtin_key, storage_path, ext, kind from document_templates where id = ${b.templateId}`;
      if (!t) throw notFound('Vorlage nicht gefunden');
      if (!p.folder_path) throw badRequest('Projekt hat keinen Ordner');
      const [info] = await sql<{ customer: string; name: string }[]>`select customer, name from projects where id = ${id}`;
      const company = await ctx.settings.get('company');
      let data = await templateBuffer(t);
      try {
        data = fillOfficeTemplate(data, {
          Dokumentnummer: doc.number, Titel: b.title, Art: b.kind, Version: '1', Projektnummer: p.number, Projektname: info?.name ?? '',
          Kunde: info?.customer ?? '', Datum: new Date().toLocaleDateString('de-DE'), Ersteller: u.displayName, Firma: company.name,
        });
      } catch { /* kein Office-Archiv: unverändert übernehmen */ }
      const folderEntries = await storage.list(p.folder_path);
      const folder = folderEntries.some((e) => e.isDir && e.name === b.folder) ? `${p.folder_path}/${b.folder}` : p.folder_path;
      const name = safeName(`${doc.number}_${b.title}.${t.ext}`.replace(/\s+/g, '_'));
      const f = await storeFile(ctx, { projectId: id, path: `${folder}/${name}`, stream: Readable.from(data), userId: u.id, via: 'vorlage' });
      await sql`update project_documents set file_id = ${f.id} where id = ${doc.id}`;
      ctx.hub.publish(`project:${id}`, 'files.changed', {});
    }
    await audit(sql, u, { action: 'document.create', entityType: 'document', entityId: doc.id, projectId: id, summary: `Dokument ${doc.number} „${b.title}“ angelegt` });
    return doc;
  });

  app.patch('/documents/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [d] = await sql<{ project_id: string; number: string; status: string; version: number }[]>`select project_id, number, status, version from project_documents where id = ${id}`;
    if (!d) throw notFound('Dokument nicht gefunden');
    await projectAccess(sql, u, d.project_id, 'edit');
    const b = parse(z.object({
      title: z.string().trim().min(1).optional(), kind: z.string().trim().min(1).max(60).optional(), description: z.string().max(5000).optional(),
      status: z.enum(STATUS).optional(), fileId: z.string().uuid().nullable().optional(), newVersion: z.boolean().optional(),
    }), req.body);
    const version = b.newVersion ? d.version + 1 : d.version;
    const status = b.newVersion ? 'draft' : b.status ?? d.status;
    await sql`update project_documents set title = coalesce(${b.title ?? null}, title), kind = coalesce(${b.kind ?? null}, kind),
      description = coalesce(${b.description ?? null}, description), status = ${status}, version = ${version},
      file_id = ${b.fileId === undefined ? sql`file_id` : b.fileId}, updated_at = now() where id = ${id}`;
    const what = b.newVersion ? `neue Version ${version}` : b.status && b.status !== d.status ? `Status „${STATUS_LABEL[b.status]}“` : 'geändert';
    await audit(sql, u, { action: 'document.update', entityType: 'document', entityId: id, projectId: d.project_id, summary: `Dokument ${d.number}: ${what}`, details: b });
    return { ok: true, version, status };
  });

  app.delete('/documents/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [d] = await sql<{ project_id: string; number: string }[]>`select project_id, number from project_documents where id = ${id}`;
    if (!d) throw notFound('Dokument nicht gefunden');
    await projectAccess(sql, u, d.project_id, 'manage');
    await sql`delete from project_documents where id = ${id}`;
    await audit(sql, u, { action: 'document.delete', entityType: 'document', entityId: id, projectId: d.project_id, summary: `Dokument ${d.number} aus dem Register entfernt (Datei bleibt erhalten)` });
    return { ok: true };
  });

  // ------------------------------------------------ Vorlagen (Administrator)
  app.post('/document-templates', async (req) => {
    const u = requireRole(req, 'admin');
    let name = ''; let kind = 'Sonstiges'; let saved: { ext: string; path: string } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'name') name = String(part.value).trim();
        if (part.fieldname === 'kind') kind = String(part.value).trim() || kind;
      } else {
        const ext = posix.extname(part.filename).slice(1).toLowerCase();
        if (!['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'dotx', 'xltx'].includes(ext)) throw badRequest('Erlaubt sind Word-, Excel-, PowerPoint- und OpenDocument-Dateien');
        const path = `${TEMPLATE_DIR}/${Date.now()}_${safeName(part.filename)}`;
        await storage.write(path, part.file);
        saved = { ext: ext === 'dotx' ? 'docx' : ext === 'xltx' ? 'xlsx' : ext, path };
        if (!name) name = posix.basename(part.filename, posix.extname(part.filename));
      }
    }
    if (!saved) throw badRequest('Bitte eine Vorlagendatei auswählen');
    const [t] = await sql`insert into document_templates (name, kind, ext, storage_path, created_by) values (${name}, ${kind}, ${saved.ext}, ${saved.path}, ${u.id})
      returning id, name, kind, ext`;
    await audit(sql, u, { action: 'template.create', entityType: 'document_template', entityId: t!.id, summary: `Dokumentvorlage „${name}“ hochgeladen` });
    return t;
  });

  app.patch('/document-templates/:id', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).optional(), kind: z.string().trim().min(1).optional(), active: z.boolean().optional() }), req.body);
    await sql`update document_templates set name = coalesce(${b.name ?? null}, name), kind = coalesce(${b.kind ?? null}, kind), active = coalesce(${b.active ?? null}, active) where id = ${id}`;
    await audit(sql, u, { action: 'template.update', entityType: 'document_template', entityId: id, summary: 'Dokumentvorlage geändert', details: b });
    return { ok: true };
  });

  app.delete('/document-templates/:id', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const [t] = await sql<{ builtin_key: string | null; storage_path: string | null; name: string }[]>`select builtin_key, storage_path, name from document_templates where id = ${id}`;
    if (!t) throw notFound();
    if (t.builtin_key) throw badRequest('Mitgelieferte Vorlagen lassen sich nur ausblenden, nicht löschen');
    await sql`delete from document_templates where id = ${id}`;
    if (t.storage_path) await storage.remove(t.storage_path);
    await audit(sql, u, { action: 'template.delete', entityType: 'document_template', entityId: id, summary: `Dokumentvorlage „${t.name}“ gelöscht` });
    return { ok: true };
  });

  /** Vorlage herunterladen (zum Bearbeiten in Word/Excel) */
  app.get('/document-templates/:id/download', async (req, reply) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    const [t] = await sql<{ builtin_key: string | null; storage_path: string | null; name: string; ext: string }[]>`select builtin_key, storage_path, name, ext from document_templates where id = ${id}`;
    if (!t) throw notFound();
    const data = await templateBuffer(t);
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${t.name}.${t.ext}`)}`);
    return reply.type('application/octet-stream').send(data);
  });
}
