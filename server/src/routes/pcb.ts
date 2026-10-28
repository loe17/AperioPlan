/**
 * PCB-Bridge (Leiterplatten, zuerst KiCad): Nummernvergabe, Speichermaske, Auschecken/Einchecken,
 * Versionsstände, Stückliste → Einkauf, Freigabe mit Fertigungsdaten (Gerber, Bohrdaten, Bestückung,
 * Schaltplan-PDF, STEP) und Übernahme des 3D-Modells als Kaufteil in die CAD-Bridge.
 * Der PCB-Wächter (aperio-pcb) spricht dieselbe Schnittstelle per API-Schlüssel an.
 */
import type { FastifyInstance } from 'fastify';
import { posix } from 'node:path';
import { CAD_STATES, PCB_EXPORT_FORMATS, pcbFullNumber, pcbNumber, sanitizeName, type CadState } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { projectAccess, visibleProjects } from '../lib/access';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { storeFile } from '../services/files';
import { cadFolders, checkTransition, fileNameOf, nextPart, validateMask, buildNumber, type CadItemRow } from '../services/cad';
import { parseKicadBom, syncFromPcb, type BomRow } from '../services/pcb';
import { purchasingUsers } from './purchasing';
import { sendStoredFile } from './files';

const STATE_LABEL: Record<CadState, string> = { in_work: 'In Arbeit', review: 'Prüfung', released: 'Freigegeben', obsolete: 'Ungültig' };

interface BoardRow {
  id: string; project_id: string; seq: number; number: string; revision: number; designation: string; properties: Record<string, string>;
  state: CadState; file_path: string | null; checked_out_by: string | null; step_cad_item_id: string | null; created_by: string | null;
}

export default async function pcbRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  const select = sql`b.id, b.project_id as "projectId", p.number as "projectNumber", p.name as "projectName", b.number, b.revision, b.designation,
    b.properties, b.state, b.file_path as "filePath", b.checked_out_by as "checkedOutBy", co.display_name as "checkedOutByName", b.checked_out_at as "checkedOutAt",
    b.checkout_host as "checkoutHost", b.step_cad_item_id as "stepCadItemId", b.created_at as "createdAt", b.updated_at as "updatedAt", cu.display_name as "createdByName",
    (select count(*)::int from pcb_bom m where m.board_id = b.id and m.revision = b.revision) as "bomCount"`;
  const from = sql`pcb_boards b join projects p on p.id = b.project_id left join users co on co.id = b.checked_out_by left join users cu on cu.id = b.created_by`;
  const decorate = (r: any) => ({ ...r, fullNumber: pcbFullNumber(r.number, r.revision), fileName: r.filePath ? posix.basename(r.filePath) : null });

  async function load(u: AuthUser, id: string, need: 'read' | 'edit' = 'read') {
    const [row] = await sql<(BoardRow & { folder_path: string | null; project_number: string; project_name: string })[]>`
      select b.*, p.folder_path, p.number as project_number, p.name as project_name from pcb_boards b join projects p on p.id = b.project_id where b.id = ${id}`;
    if (!row) throw notFound('Leiterplatte nicht gefunden');
    await projectAccess(sql, u, row.project_id, need);
    return row;
  }
  async function getBoard(id: string) {
    const [r] = await sql`select ${select} from ${from} where b.id = ${id}`;
    return decorate(r);
  }
  const folderOf = async (folderPath: string | null) => {
    if (!folderPath) throw badRequest('Projekt hat keinen Ordner');
    return `${folderPath}/${(await ctx.settings.get('pcbMask')).folder || '05_Elektronik'}`;
  };
  const fileName = (r: Pick<BoardRow, 'number' | 'revision' | 'designation'>) => `${pcbFullNumber(r.number, r.revision)}_${sanitizeName(r.designation)}.zip`;
  /** Textvariablen für das KiCad-Projekt (Schriftfeld) */
  const textVariables = (r: Pick<BoardRow, 'number' | 'revision' | 'designation' | 'properties'>, project: { number: string; name: string }) => ({
    APERIO_NUMMER: pcbFullNumber(r.number, r.revision), APERIO_BASIS: r.number, APERIO_VERSION: String(r.revision).padStart(2, '0'),
    APERIO_BENENNUNG: r.designation, APERIO_PROJEKT: project.number, APERIO_PROJEKTNAME: project.name,
    ...Object.fromEntries(Object.entries(r.properties ?? {}).map(([k, v]) => [`APERIO_${k.toUpperCase()}`, v])),
  });

  // ------------------------------------------------ Maske und Liste
  app.get('/pcb/mask', async (req) => {
    const u = requireUser(req);
    return { ...(await ctx.settings.get('pcbMask')), user: { id: u.id, displayName: u.displayName } };
  });

  app.get('/pcb/boards', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ projectId: z.string().uuid().optional(), q: z.string().optional(), state: z.enum(CAD_STATES).optional(), checkedOut: z.enum(['me', 'any']).optional() }), req.query);
    if (q.projectId) await projectAccess(sql, u, q.projectId);
    const like = q.q ? `%${q.q}%` : null;
    const rows = await sql`select ${select} from ${from} where ${visibleProjects(sql, u)}
      ${q.projectId ? sql`and b.project_id = ${q.projectId}` : sql``}
      ${like ? sql`and (b.number ilike ${like} or b.designation ilike ${like} or b.properties::text ilike ${like})` : sql``}
      ${q.state ? sql`and b.state = ${q.state}` : sql``}
      ${q.checkedOut === 'me' ? sql`and b.checked_out_by = ${u.id}` : q.checkedOut === 'any' ? sql`and b.checked_out_by is not null` : sql``}
      order by b.number limit 1000`;
    return rows.map(decorate);
  });

  app.get('/pcb/boards/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await load(u, id);
    const board = await getBoard(id);
    const [revisions, history, bom, exports] = await Promise.all([
      sql`select r.revision, r.reason, r.file_size::float as "fileSize", r.created_at as "createdAt", u.display_name as "createdByName", r.file_path is not null as "hasFile"
        from pcb_revisions r left join users u on u.id = r.created_by where r.board_id = ${id} order by r.revision desc`,
      sql`select h.revision, h.from_state as "from", h.to_state as "to", h.comment, h.at, u.display_name as "userName" from pcb_state_history h left join users u on u.id = h.user_id where h.board_id = ${id} order by h.at desc limit 50`,
      sql`select refs, value, footprint, manufacturer, manufacturer_no as "manufacturerNo", supplier_no as "supplierNo", qty, dnp from pcb_bom where board_id = ${id} and revision = ${row.revision} order by sort`,
      sql`select id, format, status, revision, error, worker, file_path as "filePath", requested_at as "requestedAt", completed_at as "completedAt" from pcb_exports where board_id = ${id} order by revision desc, format`,
    ]);
    const [step] = row.step_cad_item_id ? await sql<CadItemRow[]>`select * from cad_items where id = ${row.step_cad_item_id}` : [];
    return { ...board, revisions, history, bom, exports, stepCadItem: step ? { id: step.id, number: step.base_number, designation: step.designation } : null,
      textVariables: textVariables(row, { number: row.project_number, name: row.project_name }) };
  });

  /** Für den Wächter: Leiterplatte anhand der Nummer im Ordner- oder Dateinamen finden */
  app.get('/pcb/resolve', async (req) => {
    const u = requireUser(req);
    const { name } = parse(z.object({ name: z.string().min(1) }), req.query);
    const base = posix.basename(name.replace(/\\/g, '/'));
    const candidates = await sql<{ id: string; number: string; project_id: string }[]>`select id, number, project_id from pcb_boards where ${base} like number || '%' order by length(number) desc limit 1`;
    const c = candidates[0];
    if (!c) return { managed: false };
    await projectAccess(sql, u, c.project_id);
    return { managed: true, board: await getBoard(c.id) };
  });

  // ------------------------------------------------ Anlegen (Speichermaske)
  app.post('/pcb/boards', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({
      projectId: z.string().uuid(), designation: z.string().trim().min(1).max(120), properties: z.record(z.string(), z.string()).default({}),
      checkout: z.boolean().default(true), host: z.string().max(120).optional(), detectedId: z.string().uuid().optional(),
    }), req.body);
    const p = await projectAccess(sql, u, b.projectId, 'edit');
    const mask = await ctx.settings.get('pcbMask');
    const props = { ...Object.fromEntries(mask.fields.filter((f) => f.defaultValue).map((f) => [f.key, f.defaultValue!])), ...b.properties };
    if (!props.Gezeichnet && mask.fields.some((f) => f.key === 'Gezeichnet')) props.Gezeichnet = u.displayName;
    validateMask(mask.fields, 'part', props);
    const folder = await folderOf(p.folder_path);
    const id = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(4713)`;
      const [r0] = await tx<{ seq: number }[]>`select coalesce(max(seq), 0) + 1 as seq from pcb_boards where project_id = ${b.projectId}`;
      const seq = r0!.seq;
      const number = pcbNumber(mask.numberPattern, p.number, seq);
      const [dup] = await tx`select 1 from pcb_boards where number = ${number}`;
      if (dup) throw conflict(`Nummer ${number} ist bereits vergeben`);
      const path = `${folder}/${fileName({ number, revision: 0, designation: b.designation })}`;
      const [row] = await tx<{ id: string }[]>`insert into pcb_boards (project_id, seq, number, designation, properties, file_path, checked_out_by, checked_out_at, checkout_host, created_by)
        values (${b.projectId}, ${seq}, ${number}, ${b.designation}, ${tx.json(props)}, ${path}, ${b.checkout ? u.id : null}, ${b.checkout ? new Date() : null}, ${b.host ?? null}, ${u.id}) returning id`;
      await tx`insert into pcb_revisions (board_id, revision, reason, properties, created_by) values (${row!.id}, 0, 'Urversion', ${tx.json(props)}, ${u.id})`;
      await tx`insert into pcb_state_history (board_id, revision, from_state, to_state, user_id, comment) values (${row!.id}, 0, null, 'in_work', ${u.id}, 'angelegt')`;
      if (b.detectedId) await tx`update pcb_detected set board_id = ${row!.id} where id = ${b.detectedId} and user_id = ${u.id}`;
      return row!.id;
    });
    await storage.ensureDir(folder);
    const board = await getBoard(id);
    await audit(sql, u, { action: 'pcb.create', entityType: 'pcb_board', entityId: id, projectId: b.projectId, summary: `Leiterplatte ${board.fullNumber} ${b.designation} angelegt` });
    ctx.hub.publish(`project:${b.projectId}`, 'pcb.changed', { id });
    ctx.hub.publish(`user:${u.id}`, 'pcb.detected', {});
    return { board, textVariables: textVariables({ number: board.number, revision: 0, designation: b.designation, properties: props }, { number: p.number, name: p.name }) };
  });

  app.patch('/pcb/boards/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await load(u, id, 'edit');
    if (row.state !== 'in_work') throw badRequest('Eigenschaften sind nur im Status „In Arbeit“ änderbar');
    const b = parse(z.object({ designation: z.string().trim().min(1).max(120).optional(), properties: z.record(z.string(), z.string()).optional() }), req.body);
    const props = b.properties ? { ...row.properties, ...b.properties } : row.properties;
    validateMask((await ctx.settings.get('pcbMask')).fields, 'part', props);
    await sql`update pcb_boards set designation = coalesce(${b.designation ?? null}, designation), properties = ${sql.json(props)}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'pcb.update', entityType: 'pcb_board', entityId: id, projectId: row.project_id, summary: `Eigenschaften von ${row.number} geändert`, details: b });
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id });
    return getBoard(id);
  });

  app.delete('/pcb/boards/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await load(u, id, 'edit');
    if (row.state === 'released') throw badRequest('Freigegebene Leiterplatten können nicht gelöscht werden – bitte auf „Ungültig“ setzen');
    await sql`delete from pcb_boards where id = ${id}`;
    if (row.file_path && (await storage.stat(row.file_path))) {
      await storage.move(row.file_path, `${posix.dirname(row.file_path)}/.papierkorb/${posix.basename(row.file_path)}`);
      await sql`delete from files where path = ${row.file_path}`;
    }
    await audit(sql, u, { action: 'pcb.delete', entityType: 'pcb_board', entityId: id, projectId: row.project_id, summary: `Leiterplatte ${pcbFullNumber(row.number, row.revision)} gelöscht` });
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id });
    return { ok: true };
  });

  // ------------------------------------------------ Auschecken / Einchecken / Versionsstand
  app.post('/pcb/boards/:id/checkout', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ host: z.string().max(120).optional() }), req.body ?? {});
    const row = await load(u, id, 'edit');
    if (row.checked_out_by && row.checked_out_by !== u.id) {
      const [who] = await sql<{ display_name: string }[]>`select display_name from users where id = ${row.checked_out_by}`;
      throw conflict(`Gesperrt durch ${who?.display_name ?? 'unbekannt'}`);
    }
    if (row.state === 'review') throw badRequest('Leiterplatte ist in Prüfung – zum Ändern zuerst zurück auf „In Arbeit“ setzen');
    if (row.state === 'released' || row.state === 'obsolete') throw badRequest('Freigegebene Stände sind schreibgeschützt – bitte einen neuen Versionsstand anlegen');
    await sql`update pcb_boards set checked_out_by = ${u.id}, checked_out_at = now(), checkout_host = ${b.host ?? null}, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'pcb.checkout', entityType: 'pcb_board', entityId: id, projectId: row.project_id, summary: `${pcbFullNumber(row.number, row.revision)} ausgecheckt` });
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id });
    return getBoard(id);
  });

  app.post('/pcb/boards/:id/undo-checkout', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await load(u, id, 'edit');
    if (row.checked_out_by && row.checked_out_by !== u.id && u.role !== 'admin') throw forbidden('Nur der Bearbeiter oder ein Administrator kann die Sperre aufheben');
    await sql`update pcb_boards set checked_out_by = null, checked_out_at = null, checkout_host = null, updated_at = now() where id = ${id}`;
    await audit(sql, u, { action: 'pcb.undo_checkout', entityType: 'pcb_board', entityId: id, projectId: row.project_id, summary: `Sperre von ${row.number} aufgehoben` });
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id });
    return getBoard(id);
  });

  async function saveBom(boardId: string, revision: number, rows: BomRow[]) {
    await sql.begin(async (tx) => {
      await tx`delete from pcb_bom where board_id = ${boardId} and revision = ${revision}`;
      let i = 0;
      for (const r of rows) {
        await tx`insert into pcb_bom (board_id, revision, refs, value, footprint, manufacturer, manufacturer_no, supplier_no, qty, dnp, sort)
          values (${boardId}, ${revision}, ${r.refs}, ${r.value}, ${r.footprint}, ${r.manufacturer}, ${r.manufacturerNo}, ${r.supplierNo}, ${r.qty}, ${r.dnp}, ${i++})`;
      }
    });
  }

  /**
   * Einchecken: KiCad-Projekt als ZIP (Feld „file“), optional Stückliste (Feld „bom“ = CSV aus kicad-cli),
   * Felder comment, properties (JSON), keepCheckedOut ("true")
   */
  app.post('/pcb/boards/:id/checkin', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await load(u, id, 'edit');
    if (row.checked_out_by !== u.id) throw conflict(row.checked_out_by ? 'Von jemand anderem ausgecheckt' : 'Bitte zuerst auschecken');
    const fields: Record<string, string> = {};
    let stored: { size: number } | null = null;
    let bom: BomRow[] | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'bom') {
        try { bom = parseKicadBom((await part.toBuffer()).toString('utf8')); } catch (e) { throw badRequest((e as Error).message); }
      } else if (part.type === 'file') {
        if (!/\.zip$/i.test(part.filename)) throw badRequest('Bitte das KiCad-Projekt als ZIP-Datei einchecken');
        stored = await storeFile(ctx, { projectId: row.project_id, path: row.file_path!, stream: part.file, userId: u.id, comment: fields.comment, via: 'PCB-Bridge' });
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (fields.bom && !bom) { try { bom = parseKicadBom(fields.bom); } catch (e) { throw badRequest((e as Error).message); } }
    const props = fields.properties ? { ...row.properties, ...JSON.parse(fields.properties) } : row.properties;
    validateMask((await ctx.settings.get('pcbMask')).fields, 'part', props);
    const comment = (fields.comment ?? '').trim();
    const keep = fields.keepCheckedOut === 'true';
    await sql`update pcb_boards set properties = ${sql.json(props)}, updated_at = now(),
      checked_out_by = ${keep ? u.id : null}, checked_out_at = ${keep ? sql`checked_out_at` : null}, checkout_host = ${keep ? sql`checkout_host` : null} where id = ${id}`;
    if (stored) await sql`update pcb_revisions set file_path = ${row.file_path}, file_size = ${stored.size}, properties = ${sql.json(props)},
      reason = case when reason = '' or reason = 'Urversion' then coalesce(nullif(${comment}, ''), reason) else reason end where board_id = ${id} and revision = ${row.revision}`;
    if (bom) await saveBom(id, row.revision, bom);
    await audit(sql, u, { action: 'pcb.checkin', entityType: 'pcb_board', entityId: id, projectId: row.project_id,
      summary: `${pcbFullNumber(row.number, row.revision)} eingecheckt${comment ? `: ${comment}` : ''}${bom ? ` (${bom.length} Stücklisten-Positionen)` : ''}` });
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id });
    return { board: await getBoard(id), bomRows: bom?.length ?? null };
  });

  /** Stückliste ohne neue Projektdatei aktualisieren (CSV-Text oder Zeilen) */
  app.put('/pcb/boards/:id/bom', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const row = await load(u, id, 'edit');
    if (row.state !== 'in_work') throw badRequest('Die Stückliste ist nur im Status „In Arbeit“ änderbar');
    const b = parse(z.object({ csv: z.string().optional(), rows: z.array(z.object({ refs: z.string().default(''), value: z.string().default(''), footprint: z.string().default(''),
      manufacturer: z.string().default(''), manufacturerNo: z.string().default(''), supplierNo: z.string().default(''), qty: z.number().int().min(1).default(1), dnp: z.boolean().default(false) })).optional() }), req.body);
    let rows: BomRow[];
    try { rows = b.rows ?? parseKicadBom(b.csv ?? ''); } catch (e) { throw badRequest((e as Error).message); }
    await saveBom(id, row.revision, rows);
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id });
    return { ok: true, rows: rows.length };
  });

  app.post('/pcb/boards/:id/revise', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Bitte den Änderungsgrund angeben'), host: z.string().optional() }), req.body);
    const row = await load(u, id, 'edit');
    if (row.checked_out_by && row.checked_out_by !== u.id) throw conflict('Von jemand anderem ausgecheckt');
    if (row.state !== 'released') throw badRequest('Ein neuer Versionsstand wird von einem freigegebenen Stand aus angelegt');
    if (row.revision >= 99) throw badRequest('Maximaler Versionsstand erreicht');
    const rev = row.revision + 1;
    const newPath = `${posix.dirname(row.file_path!)}/${fileName({ ...row, revision: rev })}`;
    if (row.file_path && (await storage.stat(row.file_path))) {
      // alten Stand behalten, neue Arbeitsdatei als Kopie
      await storeFile(ctx, { projectId: row.project_id, path: newPath, stream: storage.read(row.file_path), userId: u.id, via: 'PCB-Bridge', comment: `Kopie von Stand ${String(row.revision).padStart(2, '0')}` });
    }
    await sql.begin(async (tx) => {
      await tx`update pcb_boards set revision = ${rev}, state = 'in_work', file_path = ${newPath}, checked_out_by = ${u.id}, checked_out_at = now(), checkout_host = ${b.host ?? null}, updated_at = now() where id = ${id}`;
      await tx`insert into pcb_revisions (board_id, revision, reason, properties, created_by) values (${id}, ${rev}, ${b.reason}, ${tx.json(row.properties)}, ${u.id})`;
      await tx`insert into pcb_state_history (board_id, revision, from_state, to_state, user_id, comment) values (${id}, ${rev}, 'released', 'in_work', ${u.id}, ${b.reason})`;
      await tx`insert into pcb_bom (board_id, revision, refs, value, footprint, manufacturer, manufacturer_no, supplier_no, qty, dnp, sort)
        select board_id, ${rev}, refs, value, footprint, manufacturer, manufacturer_no, supplier_no, qty, dnp, sort from pcb_bom where board_id = ${id} and revision = ${row.revision}`;
    });
    // bereits bestellte Bauteile: Einkauf informieren
    const ordered = await sql<{ n: number }[]>`select count(*)::int as n from purchase_items where pcb_board_id = ${id} and status in ('requested', 'ordered', 'confirmed', 'partial')`;
    if (ordered[0]?.n) await notify(ctx, await purchasingUsers(ctx), { kind: 'purchasing.revised', title: `Leiterplatte geändert – ${pcbFullNumber(row.number, rev)}`,
      body: `${ordered[0].n} Bauteile sind bereits bestellt. Grund: ${b.reason}`, link: `/projects/${row.project_id}?tab=purchasing` }, u.id);
    await audit(sql, u, { action: 'pcb.revise', entityType: 'pcb_board', entityId: id, projectId: row.project_id, summary: `${row.number}: neuer Versionsstand ${String(rev).padStart(2, '0')} (${b.reason})` });
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id });
    return getBoard(id);
  });

  // ------------------------------------------------ Status und Freigabe
  app.post('/pcb/boards/:id/state', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ to: z.enum(CAD_STATES), comment: z.string().default('') }), req.body);
    const row = await load(u, id, 'edit');
    checkTransition(row.state, b.to);
    if (row.checked_out_by && b.to !== 'in_work') throw badRequest('Bitte zuerst einchecken');
    if (b.to === 'released' || b.to === 'obsolete') {
      const p = await projectAccess(sql, u, row.project_id);
      if (!p.canManage && u.role !== 'teamlead' && u.role !== 'admin') throw forbidden('Freigeben dürfen Teamleiter und Projektverantwortliche');
    }
    if (b.to === 'released' && !(row.file_path && (await storage.stat(row.file_path)))) throw badRequest('Es wurde noch kein KiCad-Projekt eingecheckt');
    if (b.to === 'in_work' && row.state === 'released') throw badRequest('Für Änderungen an freigegebenen Ständen bitte „Neuer Versionsstand“ verwenden');
    await sql`update pcb_boards set state = ${b.to}, updated_at = now() where id = ${id}`;
    await sql`insert into pcb_state_history (board_id, revision, from_state, to_state, user_id, comment) values (${id}, ${row.revision}, ${row.state}, ${b.to}, ${u.id}, ${b.comment})`;
    let purchasing: { added: number; updated: number } | null = null;
    if (b.to === 'released') {
      const mask = await ctx.settings.get('pcbMask');
      for (const f of mask.exportFormats) await sql`insert into pcb_exports (board_id, revision, format) values (${id}, ${row.revision}, ${f})
        on conflict (board_id, revision, format) do update set status = 'queued', error = null, requested_at = now()`;
      purchasing = await syncFromPcb(ctx, id, u.id);
      if (purchasing.added) await notify(ctx, await purchasingUsers(ctx), { kind: 'purchasing.new', title: `Neue Elektronik-Bauteile: ${purchasing.added} Positionen`,
        body: `Leiterplatte ${pcbFullNumber(row.number, row.revision)} ${row.designation} wurde freigegeben`, link: `/projects/${row.project_id}?tab=purchasing` }, u.id);
    }
    await audit(sql, u, { action: 'pcb.state', entityType: 'pcb_board', entityId: id, projectId: row.project_id,
      summary: `${pcbFullNumber(row.number, row.revision)}: ${STATE_LABEL[row.state]} → ${STATE_LABEL[b.to]}${b.comment ? ` (${b.comment})` : ''}` });
    if (b.to === 'review') {
      const leads = await sql<{ id: string }[]>`select pm.user_id as id from project_members pm where pm.project_id = ${row.project_id} and pm.role = 'owner'
        union select tm.user_id from team_members tm join projects p on p.team_id = tm.team_id where p.id = ${row.project_id} and tm.is_lead`;
      await notify(ctx, leads.map((l) => l.id), { kind: 'pcb.review', title: `Zur Prüfung: Leiterplatte ${pcbFullNumber(row.number, row.revision)}`, body: row.designation, link: `/pcb?board=${id}` }, u.id);
    }
    if (b.to === 'released' || (row.state === 'review' && b.to === 'in_work'))
      await notify(ctx, [row.created_by], { kind: 'pcb.state', title: `${STATE_LABEL[b.to]}: ${pcbFullNumber(row.number, row.revision)}`, body: b.comment, link: `/pcb?board=${id}` }, u.id);
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id });
    return { board: await getBoard(id), purchasing };
  });

  app.get('/pcb/boards/:id/download', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { revision } = parse(z.object({ revision: z.coerce.number().int().optional() }), req.query);
    const row = await load(u, id);
    let path = row.file_path;
    if (revision !== undefined && revision !== row.revision) {
      const [r] = await sql<{ file_path: string | null }[]>`select file_path from pcb_revisions where board_id = ${id} and revision = ${revision}`;
      path = r?.file_path ?? null;
    }
    if (!path || !(await storage.stat(path))) throw notFound('Für diesen Stand liegt noch keine Datei vor');
    return sendStoredFile(ctx, reply, path, posix.basename(path));
  });

  /** 3D-Modell der Platine als Kaufteil in die CAD-Bridge übernehmen (Baugruppe z. B. 400 Elektrik) */
  app.post('/pcb/boards/:id/to-cad', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ sub: z.number().int().min(0).max(999).default(400), subsub: z.number().int().min(0).max(99).default(0) }), req.body ?? {});
    const row = await load(u, id, 'edit');
    if (row.step_cad_item_id) throw badRequest('Das 3D-Modell wurde bereits übernommen');
    const [step] = await sql<{ file_path: string }[]>`select file_path from pcb_exports where board_id = ${id} and format = 'step' and status = 'done' order by revision desc limit 1`;
    if (!step) throw badRequest('Es gibt noch kein STEP-Modell – es entsteht bei der Freigabe');
    const p = await projectAccess(sql, u, row.project_id, 'edit');
    const designation = `Leiterplatte ${row.designation}`.slice(0, 120);
    const props = { Benennung1: designation, Beschaffung: 'Kaufteil', Hersteller: 'Eigene Leiterplatte', Herstellernummer: pcbFullNumber(row.number, row.revision), Gezeichnet: u.displayName };
    const itemId = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(4712)`;
      const t = buildNumber(p.number, b.sub, b.subsub, 0, designation);
      const part = await nextPart(tx, t.n.main, t.n.sub, t.n.subsub);
      const n = buildNumber(p.number, b.sub, b.subsub, part, designation);
      const folders = await cadFolders(ctx, p.folder_path!);
      const r = { ...n.n, part, revision: 0, designation, type: 'part' } as unknown as CadItemRow;
      const path = `${folders.model}/${fileNameOf(r)}`;
      const [item] = await tx<{ id: string }[]>`insert into cad_items (project_id, type, base_number, main, sub, subsub, part, designation, procurement, properties, file_path, created_by)
        values (${row.project_id}, 'part', ${n.base}, ${n.n.main}, ${n.n.sub}, ${n.n.subsub}, ${part}, ${designation}, 'buy', ${tx.json(props)}, ${path}, ${u.id}) returning id`;
      await tx`insert into cad_revisions (item_id, revision, reason, properties, created_by) values (${item!.id}, 0, ${`aus Leiterplatte ${row.number}`}, ${tx.json(props)}, ${u.id})`;
      await tx`insert into cad_state_history (item_id, revision, from_state, to_state, user_id, comment) values (${item!.id}, 0, null, 'in_work', ${u.id}, 'aus PCB-Bridge übernommen')`;
      await tx`update pcb_boards set step_cad_item_id = ${item!.id} where id = ${id}`;
      return { id: item!.id, stepPath: `${posix.dirname(path)}/${posix.basename(path).replace(/\.[^.]+$/, '')}.step` };
    });
    // STEP neben das Kaufteil legen – der CAD-Wächter öffnet es in SolidWorks und speichert es als Teil
    await storeFile(ctx, { projectId: row.project_id, path: itemId.stepPath, stream: storage.read(step.file_path), userId: u.id, via: 'PCB-Bridge' });
    await audit(sql, u, { action: 'pcb.to_cad', entityType: 'pcb_board', entityId: id, projectId: row.project_id, summary: `3D-Modell von ${row.number} als Kaufteil in die CAD-Bridge übernommen` });
    ctx.hub.publish(`project:${row.project_id}`, 'cad.changed', { id: itemId.id });
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id });
    return { cadItemId: itemId.id, stepPath: itemId.stepPath };
  });

  // ------------------------------------------------ Fertigungsdaten (Warteschlange für den PCB-Wächter)
  app.get('/pcb/exports', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ status: z.string().optional() }), req.query);
    return sql`select e.id, e.format, e.status, e.revision, e.error, e.worker, e.requested_at as "requestedAt", e.completed_at as "completedAt",
      b.id as "boardId", b.number, b.designation, p.number as "projectNumber"
      from pcb_exports e join pcb_boards b on b.id = e.board_id join projects p on p.id = b.project_id
      where ${visibleProjects(sql, u)} ${q.status ? sql`and e.status = ${q.status}` : sql``} order by e.requested_at desc limit 200`;
  });

  /** Nächsten Auftrag holen: alle offenen Formate einer Leiterplatte auf einmal (kicad-cli braucht das Projekt nur einmal) */
  app.post('/pcb/exports/claim', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ worker: z.string().max(120).default('pcb-waechter'), formats: z.array(z.enum(PCB_EXPORT_FORMATS)).default([...PCB_EXPORT_FORMATS]) }), req.body ?? {});
    const jobs = await sql.begin(async (tx) => {
      const [first] = await tx<{ board_id: string; revision: number }[]>`select board_id, revision from pcb_exports
        where (status = 'queued' or (status = 'running' and started_at < now() - interval '30 minutes')) and format = any(${b.formats}) order by requested_at limit 1 for update skip locked`;
      if (!first) return [] as { id: string; format: string }[];
      return [...await tx<{ id: string; format: string }[]>`update pcb_exports set status = 'running', started_at = now(), worker = ${b.worker}
        where board_id = ${first.board_id} and revision = ${first.revision} and format = any(${b.formats})
          and (status = 'queued' or (status = 'running' and started_at < now() - interval '30 minutes')) returning id, format`];
    });
    if (!jobs.length) return { job: null };
    const [first] = await sql<{ board_id: string }[]>`select board_id from pcb_exports where id = ${jobs[0]!.id}`;
    const boardId = first!.board_id;
    const row = await load(u, boardId);
    return { job: { board: await getBoard(boardId), downloadUrl: `/api/pcb/boards/${boardId}/download`, exports: jobs, stem: pcbFullNumber(row.number, row.revision) + '_' + sanitizeName(row.designation) } };
  });

  app.post('/pcb/exports/:id/complete', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [job] = await sql<{ board_id: string; format: string; revision: number }[]>`select board_id, format, revision from pcb_exports where id = ${id}`;
    if (!job) throw notFound();
    const row = await load(u, job.board_id);
    const folder = `${await folderOf(row.folder_path)}/Fertigung/${pcbFullNumber(row.number, job.revision)}`;
    let target: string | null = null;
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      target = `${folder}/${sanitizeName(part.filename.replace(/^.*[\\/]/, '')) || `${job.format}.dat`}`;
      await storeFile(ctx, { projectId: row.project_id, path: target, stream: part.file, userId: u.id, via: 'PCB-Wächter' });
    }
    if (!target) throw badRequest('Keine Datei empfangen');
    await sql`update pcb_exports set status = 'done', file_path = ${target}, completed_at = now(), error = null where id = ${id}`;
    await audit(sql, u, { action: 'pcb.export', entityType: 'pcb_board', entityId: job.board_id, projectId: row.project_id, summary: `${job.format.toUpperCase()} für ${pcbFullNumber(row.number, job.revision)} erzeugt` });
    ctx.hub.publish(`project:${row.project_id}`, 'pcb.changed', { id: job.board_id });
    return { ok: true, path: target };
  });

  app.post('/pcb/exports/:id/fail', async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ error: z.string().max(2000) }), req.body);
    await sql`update pcb_exports set status = 'failed', error = ${b.error}, completed_at = now() where id = ${id}`;
    return { ok: true };
  });

  app.post('/pcb/exports/:id/retry', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [job] = await sql<{ board_id: string }[]>`select board_id from pcb_exports where id = ${id}`;
    if (!job) throw notFound();
    await load(u, job.board_id, 'edit');
    await sql`update pcb_exports set status = 'queued', error = null, requested_at = now() where id = ${id}`;
    return { ok: true };
  });

  app.get('/pcb/exports/:id/download', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [job] = await sql<{ board_id: string; file_path: string | null }[]>`select board_id, file_path from pcb_exports where id = ${id}`;
    if (!job?.file_path) throw notFound();
    await load(u, job.board_id);
    return sendStoredFile(ctx, reply, job.file_path, posix.basename(job.file_path));
  });

  // ------------------------------------------------ Vom Wächter erkannte neue KiCad-Projekte
  app.post('/pcb/detected', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ host: z.string().max(120).default(''), path: z.string().min(1).max(1000), name: z.string().min(1).max(200) }), req.body);
    const [row] = await sql<{ id: string; board_id: string | null; dismissed: boolean }[]>`insert into pcb_detected (user_id, host, path, name) values (${u.id}, ${b.host}, ${b.path}, ${b.name})
      on conflict (user_id, host, path) do update set name = excluded.name returning id, board_id, dismissed`;
    if (!row!.board_id && !row!.dismissed) {
      ctx.hub.publish(`user:${u.id}`, 'pcb.detected', { id: row!.id });
      await notify(ctx, [u.id], { kind: 'pcb.detected', title: `Neues KiCad-Projekt: ${b.name}`, body: 'Bitte Nummer vergeben (Speichermaske)', link: `/pcb?register=${row!.id}` });
    }
    return { id: row!.id, url: `/pcb?register=${row!.id}`, boardId: row!.board_id, dismissed: row!.dismissed };
  });

  app.get('/pcb/detected', async (req) => {
    const u = requireUser(req);
    return sql`select id, host, path, name, created_at as "createdAt" from pcb_detected where user_id = ${u.id} and board_id is null and not dismissed order by created_at desc`;
  });

  app.get('/pcb/detected/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const [row] = await sql<{ id: string; host: string; path: string; name: string; board_id: string | null; dismissed: boolean }[]>`select * from pcb_detected where id = ${id} and user_id = ${u.id}`;
    if (!row) throw notFound();
    if (!row.board_id) return { id: row.id, name: row.name, path: row.path, host: row.host, dismissed: row.dismissed, board: null };
    const [b] = await sql<(BoardRow & { project_number: string; project_name: string })[]>`select b.*, p.number as project_number, p.name as project_name from pcb_boards b join projects p on p.id = b.project_id where b.id = ${row.board_id}`;
    return { id: row.id, name: row.name, path: row.path, host: row.host, dismissed: row.dismissed, board: await getBoard(row.board_id),
      textVariables: b ? textVariables(b, { number: b.project_number, name: b.project_name }) : null };
  });

  app.post('/pcb/detected/:id/dismiss', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await sql`update pcb_detected set dismissed = true where id = ${id} and user_id = ${u.id}`;
    return { ok: true };
  });

}
