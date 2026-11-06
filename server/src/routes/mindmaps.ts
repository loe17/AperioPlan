/**
 * Mindmaps: Ideen sammeln und ordnen. Eine Mindmap gehört einer Person, kann mit Kollegen geteilt
 * oder einem Projekt zugeordnet werden (dann sehen und bearbeiten sie alle Projektmitglieder).
 * Gespeichert wird immer die ganze Karte; gleichzeitiges Bearbeiten wird über die Versionsnummer erkannt.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse, idParam } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import type { Sql } from '../db';
import { projectAccess } from '../lib/access';
import { notify } from '../services/notify';

export interface MindNode { id: string; text: string; color?: string; collapsed?: boolean; note?: string; link?: string; icon?: string; taskId?: string; children: MindNode[]; [k: string]: unknown }

const MAX_NODES = 3000;
const HEX = /^#[0-9a-f]{6}$/i;
/** Felder, die schon ältere Versionen kennen – sie bleiben in der Spalte „data“ */
const BASE_KEYS = ['id', 'text', 'color', 'collapsed', 'note', 'link', 'icon', 'taskId', 'children'];

/** Zusätzliche Eigenschaften eines Knotens (wie in FreeMind) prüfen; Unbekanntes fällt weg */
function cleanProps(n: any, out: MindNode) {
  for (const k of ['fg', 'bg', 'cloud'] as const) if (typeof n[k] === 'string' && HEX.test(n[k])) out[k] = n[k];
  if (n.bold === true) out.bold = true;
  if (n.italic === true) out.italic = true;
  if (typeof n.size === 'number' && n.size >= 9 && n.size <= 40) out.size = Math.round(n.size);
  if (['box', 'bubble', 'fork'].includes(n.shape)) out.shape = n.shape;
  if (['bezier', 'linear', 'angled'].includes(n.edgeStyle)) out.edgeStyle = n.edgeStyle;
  if (typeof n.edgeWidth === 'number' && n.edgeWidth >= 1 && n.edgeWidth <= 8) out.edgeWidth = Math.round(n.edgeWidth);
  if (Array.isArray(n.icons)) { const icons = n.icons.filter((x: unknown) => typeof x === 'string' && /^[a-z0-9-]{1,24}$/.test(x)).slice(0, 12); if (icons.length) out.icons = icons; }
  if (Array.isArray(n.arrows)) {
    const arrows = n.arrows.filter((a: any) => a && typeof a.to === 'string' && a.to.length <= 64).slice(0, 20)
      .map((a: any) => ({ to: a.to, ...(typeof a.label === 'string' && a.label.trim() ? { label: a.label.slice(0, 200) } : {}) }));
    if (arrows.length) out.arrows = arrows;
  }
  if (Array.isArray(n.attrs)) {
    const attrs = n.attrs.filter((a: any) => a && typeof a.k === 'string' && a.k.trim()).slice(0, 50).map((a: any) => ({ k: a.k.slice(0, 100), v: String(a.v ?? '').slice(0, 1000) }));
    if (attrs.length) out.attrs = attrs;
  }
  for (const k of ['created', 'modified'] as const) if (typeof n[k] === 'number' && n[k] > 0 && n[k] < 1e14) out[k] = Math.round(n[k]);
  if (typeof n.reminder === 'string' && !Number.isNaN(Date.parse(n.reminder))) out.reminder = new Date(n.reminder).toISOString();
  if (typeof n.ref === 'string' && n.ref.length <= 64) out.ref = n.ref;
}

/** Prüft und bereinigt den Baum (nur bekannte Felder, Grenzen für Länge und Tiefe) */
export function cleanMindmap(input: unknown): MindNode {
  let count = 0;
  const ids = new Set<string>();
  const walk = (n: any, depth: number): MindNode => {
    if (!n || typeof n !== 'object') throw badRequest('Ungültige Mindmap');
    if (++count > MAX_NODES) throw badRequest(`Eine Mindmap darf höchstens ${MAX_NODES} Knoten haben.`);
    if (depth > 40) throw badRequest('Die Mindmap ist zu tief verschachtelt.');
    const id = String(n.id ?? '').slice(0, 64);
    if (!id || ids.has(id)) throw badRequest('Ungültige Mindmap (Knoten-ID)');
    ids.add(id);
    const out: MindNode = { id, text: String(n.text ?? '').slice(0, 1000), children: [] };
    if (typeof n.color === 'string' && HEX.test(n.color)) out.color = n.color;
    if (n.collapsed === true) out.collapsed = true;
    if (typeof n.note === 'string' && n.note) out.note = n.note.slice(0, 10_000);
    if (typeof n.link === 'string' && /^(https?:\/\/|\/|mailto:)/.test(n.link)) out.link = n.link.slice(0, 2000);
    if (typeof n.icon === 'string' && n.icon) out.icon = n.icon.slice(0, 40);
    if (typeof n.taskId === 'string' && /^[0-9a-f-]{36}$/.test(n.taskId)) out.taskId = n.taskId;
    cleanProps(n, out);
    if (n.children !== undefined && !Array.isArray(n.children)) throw badRequest('Ungültige Mindmap');
    out.children = (n.children ?? []).map((c: unknown) => walk(c, depth + 1));
    return out;
  };
  const root = walk(input, 0);
  // Pfeile und Verknüpfungen nur auf vorhandene Punkte
  const fix = (n: MindNode) => {
    if (Array.isArray(n.arrows)) { const a = (n.arrows as { to: string }[]).filter((x) => ids.has(x.to) && x.to !== n.id); if (a.length) n.arrows = a; else delete n.arrows; }
    if (typeof n.ref === 'string' && !ids.has(n.ref)) delete n.ref;
    n.children.forEach(fix);
  };
  fix(root);
  return root;
}

/** In Grunddaten (für alle Versionen) und Zusatzangaben je Knoten trennen */
export function splitMindmap(root: MindNode): { base: MindNode; props: Record<string, Record<string, unknown>> } {
  const props: Record<string, Record<string, unknown>> = {};
  const walk = (n: MindNode): MindNode => {
    const base: MindNode = { id: n.id, text: n.text, children: [] };
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'children') continue;
      if (BASE_KEYS.includes(k)) base[k] = v; else extra[k] = v;
    }
    if (Object.keys(extra).length) props[n.id] = extra;
    base.children = n.children.map(walk);
    return base;
  };
  return { base: walk(root), props };
}

/** Grunddaten und Zusatzangaben wieder zusammenführen (Zusatz von gelöschten Punkten fällt weg) */
export function mergeMindmap(base: MindNode, props: Record<string, Record<string, unknown>> | null | undefined): MindNode {
  const walk = (n: MindNode): MindNode => ({ ...(props?.[n.id] ?? {}), ...n, children: (n.children ?? []).map(walk) });
  return walk(base);
}

/** Nächste noch nicht gemeldete Erinnerung */
function nextReminder(root: MindNode, sent: Record<string, string>) {
  let next: string | null = null;
  const walk = (n: MindNode) => {
    const r = n.reminder as string | undefined;
    if (r && sent[n.id] !== r && (!next || r < next)) next = r;
    n.children.forEach(walk);
  };
  walk(root);
  return next as string | null;
}

/** Fällige Erinnerungen melden (minütlich): an die Besitzerin und alle, mit denen die Mindmap geteilt ist */
export async function mindmapReminders(ctx: AppContext) {
  const { sql } = ctx;
  const due = await sql<{ id: string; title: string; owner_id: string; data: MindNode; node_props: Record<string, Record<string, unknown>>; reminders_sent: Record<string, string> }[]>`
    select id, title, owner_id, data, node_props, reminders_sent from mindmaps where next_reminder is not null and next_reminder <= now() limit 200`;
  for (const m of due) {
    const root = mergeMindmap(m.data, m.node_props);
    const sent = { ...m.reminders_sent };
    const now = new Date().toISOString();
    const hits: MindNode[] = [];
    const walk = (n: MindNode) => { const r = n.reminder as string | undefined; if (r && r <= now && sent[n.id] !== r) { hits.push(n); sent[n.id] = r; } n.children.forEach(walk); };
    walk(root);
    const shares = await sql<{ user_id: string }[]>`select user_id from mindmap_shares where mindmap_id = ${m.id}`;
    const to = [...new Set([m.owner_id, ...shares.map((s) => s.user_id)])];
    for (const n of hits) {
      await notify(ctx, to, { kind: 'mindmap.reminder', title: `Erinnerung: „${n.text.slice(0, 120)}“ (Mindmap „${m.title}“)`, body: typeof n.note === 'string' ? n.note.slice(0, 300) : '', link: `/mindmaps/${m.id}?node=${encodeURIComponent(n.id)}` });
    }
    await sql`update mindmaps set reminders_sent = ${sql.json(sent as never)}, next_reminder = ${nextReminder(root, sent)} where id = ${m.id}`;
  }
}

/** Rechte: owner = alles, edit = bearbeiten, read = ansehen */
export async function mindmapAccess(sql: Sql, u: AuthUser, id: string, need: 'read' | 'edit' | 'owner' = 'read') {
  const [m] = await sql<{ id: string; owner_id: string; project_id: string | null; title: string; can_edit: boolean | null }[]>`
    select m.id, m.owner_id, m.project_id, m.title, s.can_edit from mindmaps m
    left join mindmap_shares s on s.mindmap_id = m.id and s.user_id = ${u.id} where m.id = ${id}`;
  if (!m) throw notFound('Mindmap nicht gefunden');
  const owner = m.owner_id === u.id || u.role === 'admin';
  let canEdit = owner || m.can_edit === true;
  let canRead = owner || m.can_edit !== null;
  if (m.project_id && !canEdit) {
    try { const p = await projectAccess(sql, u, m.project_id); canRead = true; canEdit = canEdit || p.canEdit; } catch { /* kein Projektzugriff */ }
  }
  if (!canRead) throw notFound('Mindmap nicht gefunden');
  if (need === 'edit' && !canEdit) throw forbidden('Sie dürfen diese Mindmap nur ansehen.');
  if (need === 'owner' && !owner) throw forbidden('Nur die Person, die die Mindmap angelegt hat, darf das.');
  return { ...m, owner, canEdit };
}


export default async function mindmapRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  const access = (u: AuthUser, id: string, need: 'read' | 'edit' | 'owner' = 'read') => mindmapAccess(sql, u, id, need);

  const listSelect = sql`m.id, m.title, m.owner_id as "ownerId", o.display_name as "ownerName", m.project_id as "projectId", p.name as "projectName", p.number as "projectNumber",
    m.updated_at as "updatedAt", (select count(*)::int from mindmap_shares s where s.mindmap_id = m.id) as shares,
    jsonb_array_length(m.data->'children') as branches`;

  app.get('/mindmaps', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ projectId: z.string().uuid().optional() }), req.query);
    if (q.projectId) {
      await projectAccess(sql, u, q.projectId);
      return sql`select ${listSelect} from mindmaps m join users o on o.id = m.owner_id left join projects p on p.id = m.project_id
        where m.project_id = ${q.projectId} order by m.updated_at desc`;
    }
    return sql`select ${listSelect} from mindmaps m join users o on o.id = m.owner_id left join projects p on p.id = m.project_id
      where m.owner_id = ${u.id} or exists (select 1 from mindmap_shares s where s.mindmap_id = m.id and s.user_id = ${u.id})
      order by m.updated_at desc limit 500`;
  });

  app.post('/mindmaps', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw forbidden();
    const b = parse(z.object({ title: z.string().trim().min(1).max(200), projectId: z.string().uuid().nullable().default(null), data: z.unknown().optional() }), req.body);
    if (b.projectId) await projectAccess(sql, u, b.projectId, 'edit');
    const { base, props } = splitMindmap(b.data ? cleanMindmap(b.data) : { id: 'root', text: b.title, children: [] });
    const [m] = await sql`insert into mindmaps (title, owner_id, project_id, data, node_props, next_reminder, updated_by)
      values (${b.title}, ${u.id}, ${b.projectId}, ${sql.json(base as never)}, ${sql.json(props as never)}, ${nextReminder(mergeMindmap(base, props), {})}, ${u.id}) returning id`;
    if (b.projectId) ctx.hub.publish(`project:${b.projectId}`, 'mindmaps.changed', {});
    return m;
  });

  app.get('/mindmaps/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await access(u, id);
    const [row] = await sql`select ${listSelect}, m.data, m.node_props, m.version, ub.display_name as "updatedByName" from mindmaps m join users o on o.id = m.owner_id
      left join projects p on p.id = m.project_id left join users ub on ub.id = m.updated_by where m.id = ${id}`;
    const { node_props: props, ...m } = row!;
    m.data = mergeMindmap(m.data, props);
    const shares = await sql`select s.user_id as "userId", u.display_name as "displayName", s.can_edit as "canEdit" from mindmap_shares s join users u on u.id = s.user_id
      where s.mindmap_id = ${id} order by u.display_name`;
    return { ...m, canEdit: a.canEdit, isOwner: a.owner, shareList: shares };
  });

  /** Ganze Karte speichern. Passt die Version nicht, hat jemand anderes inzwischen gespeichert (409 mit aktuellem Stand). */
  app.put('/mindmaps/:id', async (req, reply) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await access(u, id, 'edit');
    const b = parse(z.object({ data: z.unknown(), version: z.number().int() }), req.body);
    const data = cleanMindmap(b.data);
    const { base, props } = splitMindmap(data);
    const title = data.text.trim().slice(0, 200) || 'Mindmap';
    const [old] = await sql<{ reminders_sent: Record<string, string> }[]>`select reminders_sent from mindmaps where id = ${id}`;
    const [r] = await sql<{ version: number; updatedAt: string }[]>`update mindmaps set data = ${sql.json(base as never)}, node_props = ${sql.json(props as never)},
      next_reminder = ${nextReminder(data, old?.reminders_sent ?? {})}, title = ${title}, version = version + 1,
      updated_at = now(), updated_by = ${u.id} where id = ${id} and version = ${b.version} returning version, updated_at as "updatedAt"`;
    if (!r) {
      const [cur] = await sql<{ data: MindNode; node_props: Record<string, Record<string, unknown>>; version: number }[]>`select data, node_props, version from mindmaps where id = ${id}`;
      return reply.status(409).send({ error: 'Die Mindmap wurde inzwischen von jemand anderem geändert.', details: { data: mergeMindmap(cur!.data, cur!.node_props), version: cur!.version } });
    }
    ctx.hub.publish(`mindmap:${id}`, 'mindmap.updated', { data, version: r.version, by: u.id, byName: u.displayName }, u.id);
    return r;
  });

  app.patch('/mindmaps/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await access(u, id, 'owner');
    const b = parse(z.object({ projectId: z.string().uuid().nullable() }), req.body);
    if (b.projectId) await projectAccess(sql, u, b.projectId, 'edit');
    await sql`update mindmaps set project_id = ${b.projectId}, updated_at = now() where id = ${id}`;
    for (const p of [a.project_id, b.projectId]) if (p) ctx.hub.publish(`project:${p}`, 'mindmaps.changed', {});
    return { ok: true };
  });

  app.put('/mindmaps/:id/shares', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await access(u, id, 'owner');
    const b = parse(z.object({ shares: z.array(z.object({ userId: z.string().uuid(), canEdit: z.boolean().default(false) })).max(500) }), req.body);
    const before = new Set((await sql<{ user_id: string }[]>`select user_id from mindmap_shares where mindmap_id = ${id}`).map((r) => r.user_id));
    const list = b.shares.filter((s) => s.userId !== a.owner_id);
    await sql.begin(async (tx) => {
      await tx`delete from mindmap_shares where mindmap_id = ${id}`;
      for (const s of list) await tx`insert into mindmap_shares (mindmap_id, user_id, can_edit) values (${id}, ${s.userId}, ${s.canEdit}) on conflict do nothing`;
    });
    const added = list.map((s) => s.userId).filter((x) => !before.has(x));
    if (added.length) await notify(ctx, added, { kind: 'mindmap.shared', title: `${u.displayName} hat die Mindmap „${a.title}“ mit Ihnen geteilt`, link: `/mindmaps/${id}` }, u.id);
    return { ok: true };
  });

  app.post('/mindmaps/:id/duplicate', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    await access(u, id);
    const [m] = await sql<{ title: string; data: MindNode; node_props: Record<string, unknown> }[]>`select title, data, node_props from mindmaps where id = ${id}`;
    const data = { ...m!.data, text: `${m!.data.text} (Kopie)` };
    const [c] = await sql`insert into mindmaps (title, owner_id, data, node_props, updated_by) values (${`${m!.title} (Kopie)`}, ${u.id}, ${sql.json(data as never)}, ${sql.json(m!.node_props as never)}, ${u.id}) returning id`;
    return c;
  });

  app.delete('/mindmaps/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const a = await access(u, id, 'owner');
    await sql`delete from mindmaps where id = ${id}`;
    if (a.project_id) ctx.hub.publish(`project:${a.project_id}`, 'mindmaps.changed', {});
    ctx.hub.publish(`mindmap:${id}`, 'mindmap.deleted', {});
    return { ok: true };
  });
}
