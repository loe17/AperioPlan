/**
 * CAD-Zentrale / PDM (Kapitel 6B und 7): Nummernvergabe, Speichermaske, Auschecken/Einchecken,
 * Versionsstände, Verwendungsnachweis, Stücklisten, Freigabe-Workflow und Fertigungsableitungen.
 * Der CAD-Wächter (SolidWorks-Add-in, C#) spricht dieselbe Schnittstelle per API-Schlüssel an.
 */
import type { FastifyInstance } from 'fastify';
import { posix } from 'node:path';
import { CAD_STATES, CAD_TRANSITIONS, pad, type CadFileType, type CadState } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess, visibleProjects } from '../lib/access';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { storeFile } from '../services/files';
import {
  buildNumber, cadFolders, checkTransition, customProperties, fileNameOf, fullNumber, nextPart, validateMask, type CadItemRow,
} from '../services/cad';
import { sendStoredFile } from './files';

const REVISIONS_DIR = '.revisionen';
const STATE_LABEL: Record<CadState, string> = { in_work: 'In Arbeit', review: 'Prüfung', released: 'Freigegeben', obsolete: 'Ungültig' };

export default async function cadRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  const itemSelect = sql`c.id, c.project_id as "projectId", p.number as "projectNumber", p.name as "projectName", c.type,
    c.base_number as "baseNumber", c.main, c.sub, c.subsub, c.part, c.revision, c.designation, c.state, c.procurement, c.properties,
    c.drawing_of as "drawingOf", (select d.id from cad_items d where d.drawing_of = c.id limit 1) as "drawingId",
    (select d.state from cad_items d where d.drawing_of = c.id limit 1) as "drawingState",
    c.file_path as "filePath", c.checked_out_by as "checkedOutBy", co.display_name as "checkedOutByName", c.checked_out_at as "checkedOutAt",
    c.checkout_host as "checkoutHost", c.created_at as "createdAt", c.updated_at as "updatedAt", cu.display_name as "createdByName",
    (select count(*)::int from cad_references r where r.child_id = c.id) as "usedInCount",
    (select count(*)::int from cad_references r where r.parent_id = c.id) as "childCount"`;
  const itemFrom = sql`cad_items c join projects p on p.id = c.project_id
    left join users co on co.id = c.checked_out_by left join users cu on cu.id = c.created_by`;

  const decorate = (r: any) => ({
    ...r,
    number: fullNumber(r),
    fileName: r.filePath ? posix.basename(r.filePath) : null,
    revisionLabel: pad(r.revision, 2),
  });

  async function loadItem(u: AuthUser, id: string, need: 'read' | 'edit' = 'read') {
    const [row] = await sql<(CadItemRow & { project_number: string; project_name: string; folder_path: string })[]>`
      select c.*, p.number as project_number, p.name as project_name, p.folder_path from cad_items c join projects p on p.id = c.project_id where c.id = ${id}`;
    if (!row) throw notFound('CAD-Datei nicht gefunden');
    await projectAccess(sql, u, row.project_id, need);
    return row;
  }

  async function getItem(id: string) {
    const [r] = await sql`select ${itemSelect} from ${itemFrom} where c.id = ${id}`;
    return decorate(r);
  }

  // ------------------------------------------------ Speichermaske (Konfiguration für Web und CAD-Wächter)
  app.get('/cad/mask', async (req) => {
    const u = requireUser(req);
    const mask = await ctx.settings.get('cadMask');
    return { ...mask, user: { id: u.id, displayName: u.displayName } };
  });

  // ------------------------------------------------ Liste & Suche
  app.get('/cad/items', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({
      projectId: z.string().uuid().optional(), q: z.string().optional(), state: z.enum(CAD_STATES).optional(),
      type: z.enum(['part', 'assembly', 'drawing']).optional(), checkedOut: z.enum(['me', 'any']).optional(),
      limit: z.coerce.number().int().min(1).max(2000).default(500),
    }), req.query);
    if (q.projectId) await projectAccess(sql, u, q.projectId);
    const like = q.q ? `%${q.q}%` : null;
    const rows = await sql`select ${itemSelect} from ${itemFrom} where ${visibleProjects(sql, u)}
      ${q.projectId ? sql`and c.project_id = ${q.projectId}` : sql``}
      ${like ? sql`and (c.base_number ilike ${like} or c.designation ilike ${like} or c.properties::text ilike ${like})` : sql``}
      ${q.state ? sql`and c.state = ${q.state}` : sql``}
      ${q.type ? sql`and c.type = ${q.type}` : sql``}
      ${q.checkedOut === 'me' ? sql`and c.checked_out_by = ${u.id}` : q.checkedOut === 'any' ? sql`and c.checked_out_by is not null` : sql``}
      order by c.base_number, c.type limit ${q.limit}`;
    return rows.map(decorate);
  });

  /** Dateiname -> verwaltetes Teil (für den CAD-Wächter beim Speichern bestehender Dateien) */
  app.get('/cad/resolve', async (req) => {
    const u = requireUser(req);
    const { fileName } = parse(z.object({ fileName: z.string().min(1) }), req.query);
    const base = posix.basename(fileName.replace(/\\/g, '/'));
    const m = /^(\d{4}-\d{3}-\d{2}-\d{4})(?:-\d{2})?(?:_|\.|$)/.exec(base);
    const ext = base.toLowerCase().split('.').pop();
    const type = ext === 'sldasm' ? 'assembly' : ext === 'slddrw' ? 'drawing' : 'part';
    if (!m) return { managed: false };
    const [r] = await sql<{ id: string; project_id: string }[]>`select id, project_id from cad_items where base_number = ${m[1]!} and type = ${type}`;
    if (!r) return { managed: false };
    await projectAccess(sql, u, r.project_id);
    return { managed: true, item: await getItem(r.id) };
  });

  // ------------------------------------------------ Nummernvergabe
  app.post('/cad/numbers/preview', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ projectId: z.string().uuid(), sub: z.number().int().min(0).max(999), subsub: z.number().int().min(0).max(99), designation: z.string().default('') }), req.body);
    const p = await projectAccess(sql, u, b.projectId);
    const tmp = buildNumber(p.number, b.sub, b.subsub, 0, b.designation);
    const part = await nextPart(sql, tmp.n.main, tmp.n.sub, tmp.n.subsub);
    return { ...buildNumber(p.number, b.sub, b.subsub, part, b.designation), part };
  });

  /**
   * Neues Teil / neue Baugruppe registrieren (Speichern in SolidWorks → Speichermaske → hier).
   * Liefert Nummer, Zieldateinamen und die zu schreibenden Eigenschaften. Optional wird die
   * passende 2D-Zeichnung gleicher Nummer gleich mit angelegt.
   */
  app.post('/cad/items', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({
      projectId: z.string().uuid(),
      type: z.enum(['part', 'assembly', 'drawing']),
      sub: z.number().int().min(0).max(999),
      subsub: z.number().int().min(0).max(99).default(0),
      part: z.number().int().min(0).max(9999).optional(),
      designation: z.string().trim().min(1).max(120),
      procurement: z.enum(['make', 'buy', 'standard']).default('make'),
      properties: z.record(z.string(), z.string()).default({}),
      createDrawing: z.boolean().default(false),
      drawingOf: z.string().uuid().optional(),
      checkout: z.boolean().default(true),
      host: z.string().max(120).optional(),
    }), req.body);
    const p = await projectAccess(sql, u, b.projectId, 'edit');
    const mask = await ctx.settings.get('cadMask');
    const props = { ...b.properties, Benennung1: b.properties.Benennung1 || b.designation };
    validateMask(mask.fields, b.type, props);

    const created = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(4712)`;
      let main: string, sub: string, subsub: string, part: number, base: string;
      if (b.type === 'drawing' && b.drawingOf) {
        const [of] = await tx<CadItemRow[]>`select * from cad_items where id = ${b.drawingOf}`;
        if (!of) throw notFound('Teil für die Zeichnung nicht gefunden');
        ({ main, sub, subsub, part } = of);
        base = of.base_number;
      } else {
        const t = buildNumber(p.number, b.sub, b.subsub, 0, b.designation);
        ({ main, sub, subsub } = t.n);
        part = b.part ?? (await nextPart(tx, main, sub, subsub));
        base = buildNumber(p.number, b.sub, b.subsub, part, b.designation).base;
      }
      const [exists] = await tx`select 1 from cad_items where base_number = ${base} and type = ${b.type}`;
      if (exists) throw conflict(`Nummer ${base} ist für diesen Dateityp bereits vergeben`);
      const folders = await cadFolders(ctx, (await tx<{ folder_path: string }[]>`select folder_path from projects where id = ${b.projectId}`)[0]!.folder_path);
      const insertItem = async (type: CadFileType, drawingOf: string | null) => {
        const row = { main, sub, subsub, part, revision: 0, designation: b.designation, type } as CadItemRow;
        const path = `${type === 'drawing' ? folders.drawing : folders.model}/${fileNameOf(row)}`;
        const [item] = await tx<{ id: string }[]>`insert into cad_items (project_id, type, base_number, main, sub, subsub, part, designation,
            procurement, properties, drawing_of, file_path, checked_out_by, checked_out_at, checkout_host, created_by)
          values (${b.projectId}, ${type}, ${base}, ${main}, ${sub}, ${subsub}, ${part}, ${b.designation}, ${b.procurement},
            ${tx.json(props)}, ${drawingOf}, ${path}, ${b.checkout ? u.id : null}, ${b.checkout ? new Date() : null}, ${b.host ?? null}, ${u.id})
          returning id`;
        await tx`insert into cad_revisions (item_id, revision, reason, properties, created_by) values (${item!.id}, 0, 'Urversion', ${tx.json(props)}, ${u.id})`;
        await tx`insert into cad_state_history (item_id, revision, from_state, to_state, user_id, comment) values (${item!.id}, 0, null, 'in_work', ${u.id}, 'angelegt')`;
        return item!.id;
      };
      const mainId = await insertItem(b.type, b.type === 'drawing' ? b.drawingOf ?? null : null);
      const drawingId = b.createDrawing && b.type !== 'drawing' ? await insertItem('drawing', mainId) : null;
      return { mainId, drawingId };
    });

    const item = await getItem(created.mainId);
    const drawing = created.drawingId ? await getItem(created.drawingId) : null;
    await audit(sql, u, { action: 'cad.create', entityType: 'cad_item', entityId: item.id, projectId: b.projectId,
      summary: `${{ part: 'Teil', assembly: 'Baugruppe', drawing: 'Zeichnung' }[b.type]} ${item.number} angelegt${drawing ? ' (mit Zeichnung)' : ''}` });
    ctx.hub.publish(`project:${b.projectId}`, 'cad.changed', { id: item.id });
    const [row] = await sql<CadItemRow[]>`select * from cad_items where id = ${item.id}`;
    return {
      item, drawing,
      drawingTemplate: mask.drawingTemplate,
      customProperties: customProperties(row!, { projectNumber: p.number, projectName: p.name, drawnBy: u.displayName }),
    };
  });

  app.get('/cad/items/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await loadItem(u, id);
    const item = await getItem(id);
    const revisions = await sql`select r.id, r.revision, r.reason, r.file_path as "filePath", r.file_size::float as "fileSize", r.created_at as "createdAt",
      us.display_name as "createdByName" from cad_revisions r left join users us on us.id = r.created_by where r.item_id = ${id} order by r.revision desc`;
    const history = await sql`select h.revision, h.from_state as "fromState", h.to_state as "toState", h.comment, h.at, us.display_name as "userName"
      from cad_state_history h left join users us on us.id = h.user_id where h.item_id = ${id} order by h.at desc`;
    const children = await sql`select r.quantity, ${itemSelect} from cad_references r join cad_items c on c.id = r.child_id
      join projects p on p.id = c.project_id left join users co on co.id = c.checked_out_by left join users cu on cu.id = c.created_by
      where r.parent_id = ${id} order by c.base_number`;
    const exports = await sql`select id, revision, format, status, file_path as "filePath", error, requested_at as "requestedAt", completed_at as "completedAt",
      (select f.id from files f where f.path = e.file_path) as "fileId" from cad_exports e where item_id = ${id} order by revision desc, format`;
    return {
      ...item, revisions, history, exports,
      children: children.map((c) => ({ ...decorate(c), quantity: c.quantity })),
      customProperties: customProperties(row, { projectNumber: row.project_number, projectName: row.project_name }),
      transitions: CAD_TRANSITIONS[row.state],
    };
  });

  /** Verwendungsnachweis: In welchen Baugruppen und Projekten ist das Teil verbaut? (rekursiv) */
  app.get('/cad/items/:id/where-used', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await loadItem(u, id);
    const rows = await sql`with recursive up(parent_id, child_id, quantity, depth, path) as (
        select parent_id, child_id, quantity, 1, array[child_id] from cad_references where child_id = ${id}
        union all
        select r.parent_id, r.child_id, r.quantity, up.depth + 1, up.path || r.child_id
        from cad_references r join up on r.child_id = up.parent_id where not r.child_id = any(up.path) and up.depth < 20)
      select up.depth, up.quantity, up.child_id as "childId", c.id, c.base_number as "baseNumber", c.main, c.sub, c.subsub, c.part, c.revision,
        c.designation, c.type, c.state, p.id as "projectId", p.number as "projectNumber", p.name as "projectName"
      from up join cad_items c on c.id = up.parent_id join projects p on p.id = c.project_id order by up.depth, c.base_number`;
    return rows.map((r) => ({ ...r, number: fullNumber(r as never) }));
  });

  /** Stückliste (BOM) – mehrstufig, mit Mengen; als JSON oder CSV */
  app.get('/cad/items/:id/bom', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ format: z.enum(['json', 'csv']).default('json'), flat: z.coerce.boolean().default(false) }), req.query);
    const root = await loadItem(u, id);
    const rows = await sql<any[]>`with recursive down(parent_id, child_id, quantity, total, depth, path, sortkey) as (
        select parent_id, child_id, quantity, quantity, 1, array[parent_id, child_id], array[0]::bigint[] from cad_references where parent_id = ${id}
        union all
        select r.parent_id, r.child_id, r.quantity, down.total * r.quantity, down.depth + 1, down.path || r.child_id, down.sortkey
        from cad_references r join down on r.parent_id = down.child_id where not r.child_id = any(down.path) and down.depth < 20)
      select d.depth, d.quantity, d.total, d.parent_id as "parentId", c.id, c.base_number as "baseNumber", c.main, c.sub, c.subsub, c.part, c.revision,
        c.designation, c.type, c.state, c.procurement, c.properties
      from down d join cad_items c on c.id = d.child_id`;
    // Baumreihenfolge herstellen
    const byParent = new Map<string, any[]>();
    for (const r of rows) {
      const list = byParent.get(r.parentId) ?? [];
      if (!list.some((x) => x.id === r.id)) list.push(r);
      byParent.set(r.parentId, list);
    }
    const ordered: any[] = [];
    const walk = (pid: string, pos: string, depth: number, mult: number) => {
      const kids = (byParent.get(pid) ?? []).sort((a, b) => a.baseNumber.localeCompare(b.baseNumber));
      kids.forEach((k, i) => {
        const position = pos ? `${pos}.${i + 1}` : String(i + 1);
        ordered.push({ ...k, depth, position, total: k.quantity * mult, number: fullNumber(k) });
        if (depth < 20) walk(k.id, position, depth + 1, k.quantity * mult);
      });
    };
    walk(id, '', 1, 1);
    let out = ordered;
    if (q.flat) {
      const agg = new Map<string, any>();
      for (const r of ordered) {
        const cur = agg.get(r.id);
        if (cur) cur.total += r.total; else agg.set(r.id, { ...r, position: '', depth: 1 });
      }
      out = [...agg.values()].sort((a, b) => a.baseNumber.localeCompare(b.baseNumber));
    }
    if (q.format === 'csv') {
      const proc: Record<string, string> = { make: 'Eigenfertigung', buy: 'Kaufteil', standard: 'Normteil' };
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [['Pos', 'Ebene', 'Nummer', 'Benennung', 'Typ', 'Menge', 'Gesamtmenge', 'Beschaffung', 'Werkstoff', 'Norm', 'Status'].join(';')];
      for (const r of out) lines.push([r.position, r.depth, r.number, r.designation, r.type === 'assembly' ? 'Baugruppe' : 'Teil', r.quantity, r.total,
        proc[r.procurement], r.properties?.Werkstoff, r.properties?.Norm, STATE_LABEL[r.state as CadState]].map(esc).join(';'));
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="Stueckliste_${root.base_number}.csv"`);
      return '﻿' + lines.join('\r\n');
    }
    return out;
  });

  /** Baugruppenstruktur setzen (vom CAD-Wächter beim Einchecken einer Baugruppe übermittelt) */
  app.put('/cad/items/:id/references', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await loadItem(u, id, 'edit');
    if (row.type !== 'assembly') throw badRequest('Nur Baugruppen haben eine Stückliste');
    const b = parse(z.object({ children: z.array(z.object({ childId: z.string().uuid().optional(), number: z.string().optional(), quantity: z.number().int().positive().default(1) })) }), req.body);
    await setReferences(u, row, b.children);
    return getItem(id);
  });

  async function setReferences(u: AuthUser, row: CadItemRow, children: { childId?: string; number?: string; quantity: number }[]) {
    const resolved: { id: string; quantity: number }[] = [];
    const unknown: string[] = [];
    for (const c of children) {
      let cid = c.childId;
      if (!cid && c.number) {
        const m = /^(\d{4}-\d{3}-\d{2}-\d{4})/.exec(posix.basename(c.number.replace(/\\/g, '/')));
        const ext = c.number.toLowerCase().endsWith('.sldasm') ? 'assembly' : 'part';
        if (m) cid = (await sql<{ id: string }[]>`select id from cad_items where base_number = ${m[1]!} and type in (${ext}, 'part', 'assembly') order by (type = ${ext}) desc limit 1`)[0]?.id;
      }
      if (!cid) { unknown.push(c.number ?? '?'); continue; }
      if (cid === row.id) throw badRequest('Eine Baugruppe kann sich nicht selbst enthalten');
      const ex = resolved.find((r) => r.id === cid);
      if (ex) ex.quantity += c.quantity; else resolved.push({ id: cid, quantity: c.quantity });
    }
    // Kreisbezug verhindern
    for (const r of resolved) {
      const [cycle] = await sql`with recursive d(id) as (select child_id from cad_references where parent_id = ${r.id}
        union select c.child_id from cad_references c join d on c.parent_id = d.id) select 1 from d where id = ${row.id}`;
      if (cycle) throw badRequest('Kreisbezug in der Baugruppenstruktur');
    }
    await sql.begin(async (tx) => {
      await tx`delete from cad_references where parent_id = ${row.id}`;
      for (const r of resolved) await tx`insert into cad_references (parent_id, child_id, quantity) values (${row.id}, ${r.id}, ${r.quantity})`;
    });
    await audit(sql, u, { action: 'cad.references', entityType: 'cad_item', entityId: row.id, projectId: row.project_id,
      summary: `Stückliste ${row.base_number}: ${resolved.length} Positionen${unknown.length ? `, ${unknown.length} unverwaltete Dateien` : ''}`, details: { unknown } });
    return { unknown };
  }

  // ------------------------------------------------ Auschecken / Einchecken
  app.post('/cad/items/:id/checkout', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ host: z.string().max(120).optional() }), req.body ?? {});
    const row = await loadItem(u, id, 'edit');
    if (row.checked_out_by && row.checked_out_by !== u.id) {
      const [who] = await sql<{ display_name: string }[]>`select display_name from users where id = ${row.checked_out_by}`;
      throw conflict(`Gesperrt durch ${who?.display_name ?? 'unbekannt'}`);
    }
    if (row.state === 'review') throw badRequest('Datei ist in Prüfung – zum Ändern zuerst zurück auf „In Arbeit“ setzen');
    if (row.state === 'released' || row.state === 'obsolete') throw badRequest('Freigegebene Stände sind schreibgeschützt – bitte eine Änderung (neuer Versionsstand) anstoßen');
    await sql`update cad_items set checked_out_by = ${u.id}, checked_out_at = now(), checkout_host = ${b.host ?? null}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'cad.checkout', entityType: 'cad_item', entityId: id, projectId: row.project_id, summary: `${fullNumber(row)} ausgecheckt` });
    ctx.hub.publish(`project:${row.project_id}`, 'cad.changed', { id });
    return getItem(id);
  });

  app.post('/cad/items/:id/undo-checkout', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await loadItem(u, id, 'edit');
    if (row.checked_out_by && row.checked_out_by !== u.id && u.role !== 'admin') throw forbidden('Nur der Bearbeiter oder ein Administrator kann die Sperre aufheben');
    await sql`update cad_items set checked_out_by = null, checked_out_at = null, checkout_host = null, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'cad.undo_checkout', entityType: 'cad_item', entityId: id, projectId: row.project_id, summary: `Sperre von ${fullNumber(row)} aufgehoben` });
    ctx.hub.publish(`project:${row.project_id}`, 'cad.changed', { id });
    return getItem(id);
  });

  /**
   * Einchecken: Datei hochladen (multipart, Feld "file") mit Kommentar. Felder:
   *  comment, properties (JSON), references (JSON [{number, quantity}]), keepCheckedOut ("true")
   */
  app.post('/cad/items/:id/checkin', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await loadItem(u, id, 'edit');
    if (row.checked_out_by !== u.id) throw conflict(row.checked_out_by ? 'Von jemand anderem ausgecheckt' : 'Bitte zuerst auschecken');
    const fields: Record<string, string> = {};
    let stored: { size: number } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const ext = posix.extname(part.filename).toLowerCase();
        const expected = posix.extname(row.file_path ?? '').toLowerCase();
        if (expected && ext !== expected) throw badRequest(`Falscher Dateityp ${ext} – erwartet ${expected}`);
        stored = await storeFile(ctx, { projectId: row.project_id, path: row.file_path!, stream: part.file, userId: u.id, comment: fields.comment });
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    const props = fields.properties ? { ...row.properties, ...JSON.parse(fields.properties) } : row.properties;
    const mask = await ctx.settings.get('cadMask');
    validateMask(mask.fields, row.type, props);
    const comment = (fields.comment ?? '').trim();
    const keep = fields.keepCheckedOut === 'true';
    await sql`update cad_items set properties = ${sql.json(props)}, updated_at = now(),
      checked_out_by = ${keep ? u.id : null}, checked_out_at = ${keep ? sql`checked_out_at` : null}, checkout_host = ${keep ? sql`checkout_host` : null}
      where id = ${id}`;
    const [{ sha256, size } = { sha256: null, size: null }] = await sql<{ sha256: string | null; size: number | null }[]>`select sha256, size::float as size from files where path = ${row.file_path}`;
    await sql`update cad_revisions set file_path = ${row.file_path}, file_sha256 = ${sha256}, file_size = ${size}, properties = ${sql.json(props)},
      reason = case when reason = '' or reason = 'Urversion' then coalesce(nullif(${comment}, ''), reason) else reason end
      where item_id = ${id} and revision = ${row.revision}`;
    let unknown: string[] = [];
    if (fields.references && row.type === 'assembly') unknown = (await setReferences(u, row, JSON.parse(fields.references))).unknown;
    await audit(sql, u, { action: 'cad.checkin', entityType: 'cad_item', entityId: id, projectId: row.project_id,
      summary: `${fullNumber(row)} eingecheckt${comment ? `: ${comment}` : ''}`, details: { size: stored?.size } });
    ctx.hub.publish(`project:${row.project_id}`, 'cad.changed', { id });
    return { item: await getItem(id), unknownReferences: unknown };
  });

  /**
   * Änderung (neuer Versionsstand): 00 -> 01 mit Pflicht-Begründung.
   * Die bisherige Datei wird in .revisionen/ archiviert, die Arbeitsdatei erhält den neuen Namen.
   */
  app.post('/cad/items/:id/revise', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Bitte den Änderungsgrund angeben'), host: z.string().optional() }), req.body);
    const row = await loadItem(u, id, 'edit');
    if (row.checked_out_by && row.checked_out_by !== u.id) throw conflict('Von jemand anderem ausgecheckt');
    if (row.revision >= 99) throw badRequest('Maximaler Versionsstand erreicht');
    const next = { ...row, revision: row.revision + 1 };
    const newPath = `${posix.dirname(row.file_path!)}/${fileNameOf(next)}`;
    const archived = `${posix.dirname(row.file_path!)}/${REVISIONS_DIR}/${posix.basename(row.file_path!)}`;
    if (await storage.stat(row.file_path!)) {
      await storage.copy(row.file_path!, archived);
      await storage.move(row.file_path!, newPath);
      await sql`update files set path = ${newPath}, name = ${posix.basename(newPath)}, updated_at = now() where path = ${row.file_path}`;
    }
    await sql.begin(async (tx) => {
      await tx`update cad_revisions set file_path = ${archived} where item_id = ${id} and revision = ${row.revision}`;
      await tx`update cad_items set revision = ${next.revision}, state = 'in_work', file_path = ${newPath}, checked_out_by = ${u.id},
        checked_out_at = now(), checkout_host = ${b.host ?? null}, updated_at = now() where id = ${id}`;
      await tx`insert into cad_revisions (item_id, revision, reason, file_path, properties, created_by)
        values (${id}, ${next.revision}, ${b.reason}, ${newPath}, ${tx.json(row.properties)}, ${u.id})`;
      await tx`insert into cad_state_history (item_id, revision, from_state, to_state, user_id, comment)
        values (${id}, ${next.revision}, ${row.state}, 'in_work', ${u.id}, ${'Änderung: ' + b.reason})`;
    });
    // Die zugehörige Zeichnung muss erneut geprüft werden
    if (row.type !== 'drawing') {
      const [dwg] = await sql<CadItemRow[]>`select * from cad_items where drawing_of = ${id}`;
      if (dwg && dwg.state === 'released') {
        await sql`update cad_items set state = 'in_work', updated_at = now() where id = ${dwg.id}`;
        await sql`insert into cad_state_history (item_id, revision, from_state, to_state, user_id, comment)
          values (${dwg.id}, ${dwg.revision}, 'released', 'in_work', ${u.id}, ${'Teil geändert auf Version ' + pad(next.revision, 2)})`;
      }
    }
    await audit(sql, u, { action: 'cad.revise', entityType: 'cad_item', entityId: id, projectId: row.project_id,
      summary: `${fullNumber(row)} → Version ${pad(next.revision, 2)}: ${b.reason}` });
    const users = await sql<{ id: string }[]>`select distinct created_by as id from cad_items c join cad_references r on r.parent_id = c.id where r.child_id = ${id}`;
    await notify(ctx, users.map((x) => x.id), { kind: 'cad.revised', title: `Teil geändert: ${fullNumber(next)}`, body: `${b.reason}\nBitte betroffene Baugruppen prüfen.`, link: `/cad?item=${id}` }, u.id);
    ctx.hub.publish(`project:${row.project_id}`, 'cad.changed', { id });
    return getItem(id);
  });

  // ------------------------------------------------ Freigabe-Workflow
  app.post('/cad/items/:id/state', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ to: z.enum(CAD_STATES), comment: z.string().default('') }), req.body);
    const row = await loadItem(u, id, 'edit');
    checkTransition(row.state, b.to);
    if (row.checked_out_by && b.to !== 'in_work') throw badRequest('Bitte zuerst einchecken');
    if (b.to === 'released' || b.to === 'obsolete') {
      const p = await projectAccess(sql, u, row.project_id);
      if (!p.canManage && u.role !== 'teamlead') throw forbidden('Freigeben dürfen Teamleiter und Projektverantwortliche');
    }
    if (b.to === 'released' && !(await storage.stat(row.file_path!))) throw badRequest('Es wurde noch keine Datei eingecheckt');
    if (b.to === 'released' && row.type !== 'drawing' && row.procurement === 'make') {
      // Kopplung Teil ↔ Zeichnung (MaxxDB-Fehlerschutz)
      const [dwg] = await sql<{ state: string }[]>`select state from cad_items where drawing_of = ${id}`;
      if (!dwg) throw badRequest('Eigenfertigungsteile benötigen eine Zeichnung, bevor sie freigegeben werden können');
      if (dwg.state !== 'released') throw badRequest('Bitte zuerst die zugehörige 2D-Zeichnung prüfen und freigeben');
    }
    if (b.to === 'released' && row.type === 'assembly') {
      const [open] = await sql<{ n: number }[]>`select count(*)::int as n from cad_references r join cad_items c on c.id = r.child_id where r.parent_id = ${id} and c.state <> 'released'`;
      if (open && open.n > 0) throw badRequest(`${open.n} enthaltene Teile/Baugruppen sind noch nicht freigegeben`);
    }
    if (b.to === 'in_work' && row.state === 'released') throw badRequest('Für Änderungen an freigegebenen Ständen bitte „Neuer Versionsstand“ verwenden');
    await sql`update cad_items set state = ${b.to}, updated_at = now() where id = ${id}`;
    await sql`insert into cad_state_history (item_id, revision, from_state, to_state, user_id, comment) values (${id}, ${row.revision}, ${row.state}, ${b.to}, ${u.id}, ${b.comment})`;
    if (b.to === 'released') {
      // Fertigungsableitungen anfordern: Zeichnung → PDF + DXF, 3D → STEP
      const formats = row.type === 'drawing' ? ['pdf', 'dxf'] : ['step'];
      for (const f of formats) await sql`insert into cad_exports (item_id, revision, format) values (${id}, ${row.revision}, ${f})
        on conflict (item_id, revision, format) do update set status = 'queued', error = null, requested_at = now()`;
      // Teil und Zeichnung zusammen freigeben, wenn die Zeichnung zuerst freigegeben wurde und das Teil in Prüfung wartet
    }
    await audit(sql, u, { action: 'cad.state', entityType: 'cad_item', entityId: id, projectId: row.project_id,
      summary: `${fullNumber(row)}: ${STATE_LABEL[row.state]} → ${STATE_LABEL[b.to]}${b.comment ? ` (${b.comment})` : ''}` });
    if (b.to === 'review') {
      const leads = await sql<{ id: string }[]>`select pm.user_id as id from project_members pm where pm.project_id = ${row.project_id} and pm.role = 'owner'
        union select tm.user_id from team_members tm join projects p on p.team_id = tm.team_id where p.id = ${row.project_id} and tm.is_lead`;
      await notify(ctx, leads.map((l) => l.id), { kind: 'cad.review', title: `Zur Prüfung: ${fullNumber(row)}`, body: row.designation, link: `/cad?item=${id}` }, u.id);
    }
    const [creator] = await sql<{ created_by: string }[]>`select created_by from cad_items where id = ${id}`;
    if (b.to === 'released' || (row.state === 'review' && b.to === 'in_work'))
      await notify(ctx, [creator?.created_by], { kind: 'cad.state', title: `${STATE_LABEL[b.to]}: ${fullNumber(row)}`, body: b.comment, link: `/cad?item=${id}` }, u.id);
    ctx.hub.publish(`project:${row.project_id}`, 'cad.changed', { id });
    return getItem(id);
  });

  app.patch('/cad/items/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await loadItem(u, id, 'edit');
    if (row.state !== 'in_work') throw badRequest('Eigenschaften sind nur im Status „In Arbeit“ änderbar');
    const b = parse(z.object({ designation: z.string().trim().min(1).optional(), procurement: z.enum(['make', 'buy', 'standard']).optional(), properties: z.record(z.string(), z.string()).optional() }), req.body);
    const props = b.properties ? { ...row.properties, ...b.properties } : row.properties;
    const mask = await ctx.settings.get('cadMask');
    validateMask(mask.fields, row.type, props);
    await sql`update cad_items set designation = coalesce(${b.designation ?? null}, designation), procurement = coalesce(${b.procurement ?? null}, procurement),
      properties = ${sql.json(props)}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'cad.update', entityType: 'cad_item', entityId: id, projectId: row.project_id, summary: `Eigenschaften von ${row.base_number} geändert`, details: b });
    ctx.hub.publish(`project:${row.project_id}`, 'cad.changed', { id });
    return getItem(id);
  });

  app.delete('/cad/items/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await loadItem(u, id, 'edit');
    const [used] = await sql<{ n: number }[]>`select count(*)::int as n from cad_references where child_id = ${id}`;
    if (used && used.n > 0) throw badRequest(`Wird noch in ${used.n} Baugruppe(n) verwendet – siehe Verwendungsnachweis`);
    if (row.state === 'released') throw badRequest('Freigegebene Teile können nicht gelöscht werden – bitte auf „Ungültig“ setzen');
    const [dwg] = await sql`select 1 from cad_items where drawing_of = ${id}`;
    if (dwg) throw badRequest('Bitte zuerst die zugehörige Zeichnung löschen');
    await sql`delete from cad_items where id = ${id}`;
    if (row.file_path && (await storage.stat(row.file_path))) {
      await storage.move(row.file_path, `${posix.dirname(row.file_path)}/.papierkorb/${posix.basename(row.file_path)}`);
      await sql`delete from files where path = ${row.file_path}`;
    }
    await audit(sql, u, { action: 'cad.delete', entityType: 'cad_item', entityId: id, projectId: row.project_id, summary: `${fullNumber(row)} gelöscht` });
    ctx.hub.publish(`project:${row.project_id}`, 'cad.changed', { id });
    return { ok: true };
  });

  // ------------------------------------------------ Dateien laden
  app.get('/cad/items/:id/download', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { revision } = parse(z.object({ revision: z.coerce.number().int().optional() }), req.query);
    const row = await loadItem(u, id);
    let path = row.file_path!;
    if (revision !== undefined && revision !== row.revision) {
      const [r] = await sql<{ file_path: string | null }[]>`select file_path from cad_revisions where item_id = ${id} and revision = ${revision}`;
      if (!r?.file_path) throw notFound('Für diesen Versionsstand liegt keine Datei vor');
      path = r.file_path;
    }
    return sendStoredFile(ctx, reply, path, posix.basename(path));
  });

  // ------------------------------------------------ Fertigungsableitungen (Auftragswarteschlange für den CAD-Wächter)
  app.get('/cad/exports', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ status: z.string().optional() }), req.query);
    return sql`select e.id, e.format, e.status, e.revision, e.error, e.worker, e.requested_at as "requestedAt", e.completed_at as "completedAt",
      c.id as "itemId", c.base_number as "baseNumber", c.designation, p.number as "projectNumber"
      from cad_exports e join cad_items c on c.id = e.item_id join projects p on p.id = c.project_id
      where ${visibleProjects(sql, u)} ${q.status ? sql`and e.status = ${q.status}` : sql``} order by e.requested_at desc limit 200`;
  });

  /** Nächsten Auftrag holen (atomar). Hängende Aufträge (> 30 min) werden erneut vergeben. */
  app.post('/cad/exports/claim', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ worker: z.string().max(120).default('cad-waechter'), formats: z.array(z.enum(['pdf', 'dxf', 'step'])).default(['pdf', 'dxf', 'step']) }), req.body ?? {});
    const [job] = await sql<{ id: string; item_id: string; revision: number; format: string }[]>`update cad_exports set status = 'running', started_at = now(), worker = ${b.worker}
      where id = (select id from cad_exports where (status = 'queued' or (status = 'running' and started_at < now() - interval '30 minutes'))
        and format = any(${b.formats}) order by requested_at limit 1 for update skip locked)
      returning id, item_id, revision, format`;
    if (!job) return { job: null };
    const row = await loadItem(u, job.item_id);
    const [drawingOf] = row.drawing_of ? await sql<CadItemRow[]>`select * from cad_items where id = ${row.drawing_of}` : [];
    return {
      job: {
        id: job.id, format: job.format, revision: job.revision,
        item: await getItem(job.item_id),
        downloadUrl: `/api/cad/items/${job.item_id}/download`,
        referencedModel: drawingOf ? { id: drawingOf.id, downloadUrl: `/api/cad/items/${drawingOf.id}/download`, fileName: fileNameOf(drawingOf) } : null,
        targetName: `${posix.basename(row.file_path!).replace(/\.[^.]+$/, '')}.${job.format === 'step' ? 'step' : job.format}`,
      },
    };
  });

  app.post('/cad/exports/:id/complete', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [job] = await sql<{ item_id: string; format: string; revision: number }[]>`select item_id, format, revision from cad_exports where id = ${id}`;
    if (!job) throw notFound();
    const row = await loadItem(u, job.item_id);
    const folders = await cadFolders(ctx, row.folder_path);
    const name = `${posix.basename(row.file_path!).replace(/\.[^.]+$/, '')}.${job.format}`;
    const target = `${folders.production}/${job.format.toUpperCase()}/${name}`;
    let saved = false;
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      await storeFile(ctx, { projectId: row.project_id, path: target, stream: part.file, userId: u.id, via: 'CAD-Wächter' });
      saved = true;
    }
    if (!saved) throw badRequest('Keine Datei empfangen');
    await sql`update cad_exports set status = 'done', file_path = ${target}, completed_at = now(), error = null where id = ${id}`;
    await audit(sql, u, { action: 'cad.export', entityType: 'cad_item', entityId: job.item_id, projectId: row.project_id, summary: `${job.format.toUpperCase()} für ${fullNumber(row)} erzeugt` });
    ctx.hub.publish(`project:${row.project_id}`, 'cad.changed', { id: job.item_id });
    return { ok: true, path: target };
  });

  app.post('/cad/exports/:id/fail', async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ error: z.string().max(2000) }), req.body);
    await sql`update cad_exports set status = 'failed', error = ${b.error}, completed_at = now() where id = ${id}`;
    return { ok: true };
  });

  app.post('/cad/exports/:id/retry', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [job] = await sql<{ item_id: string }[]>`select item_id from cad_exports where id = ${id}`;
    if (!job) throw notFound();
    await loadItem(u, job.item_id, 'edit');
    await sql`update cad_exports set status = 'queued', error = null, requested_at = now() where id = ${id}`;
    return { ok: true };
  });
}
