/**
 * Ressourcen buchen (Räume, Fahrzeuge, Geräte). Ressourcen legt der Administrator an,
 * Doppelbuchungen verhindert die Datenbank selbst (Exclusion-Constraint).
 * Datenschutz: Kollegen sehen „belegt von <Name>“, den Anlass nur Buchende, Genehmiger und Administratoren.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireRole, requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';

const KINDS = ['room', 'vehicle', 'equipment', 'other'] as const;
const KIND_LABEL: Record<string, string> = { room: 'Raum', vehicle: 'Fahrzeug', equipment: 'Gerät', other: 'Ressource' };

interface Resource {
  id: string; name: string; kind: string; requires_approval: boolean; approver_id: string | null; allowed_team_ids: string[]; active: boolean;
}

const resourceBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(KINDS).default('room'),
  location: z.string().default(''),
  capacity: z.number().int().min(0).nullable().default(null),
  description: z.string().default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f46e5'),
  requiresApproval: z.boolean().default(false),
  approverId: z.string().uuid().nullable().default(null),
  allowedTeamIds: z.array(z.string().uuid()).default([]),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
});

const fmt = (d: Date | string) => new Date(d).toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default async function resourceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  const resSelect = sql`r.id, r.name, r.kind, r.location, r.capacity, r.description, r.color, r.requires_approval as "requiresApproval",
    r.approver_id as "approverId", a.display_name as "approverName", r.allowed_team_ids as "allowedTeamIds", r.active, r.sort`;

  async function loadResource(id: string) {
    const [r] = await sql<Resource[]>`select * from resources where id = ${id}`;
    if (!r) throw notFound('Ressource nicht gefunden');
    return r;
  }

  async function mayBook(u: AuthUser, r: Resource) {
    if (u.role === 'guest') return false;
    if (!r.allowed_team_ids.length || u.role === 'admin') return true;
    const [m] = await sql`select 1 from team_members where user_id = ${u.id} and team_id = any(${r.allowed_team_ids})`;
    return Boolean(m);
  }

  async function approvers(r: Resource): Promise<string[]> {
    if (r.approver_id) return [r.approver_id];
    return (await sql<{ id: string }[]>`select id from users where role = 'admin' and active`).map((x) => x.id);
  }

  const isApprover = (u: AuthUser, r: Resource) => u.role === 'admin' || r.approver_id === u.id;

  // ------------------------------------------------ Ressourcen verwalten
  app.get('/resources', async (req) => {
    const u = requireUser(req);
    const rows = await sql`select ${resSelect} from resources r left join users a on a.id = r.approver_id
      where ${u.role === 'admin' ? sql`true` : sql`r.active`} order by r.kind, r.sort, r.name`;
    if (u.role === 'admin') return rows.map((r) => ({ ...r, canBook: true }));
    const myTeams = new Set((await sql<{ team_id: string }[]>`select team_id from team_members where user_id = ${u.id}`).map((t) => t.team_id));
    return rows.map((r) => ({ ...r, canBook: u.role !== 'guest' && (!(r.allowedTeamIds as string[]).length || (r.allowedTeamIds as string[]).some((t) => myTeams.has(t))) }));
  });

  app.post('/resources', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(resourceBody, req.body);
    const [r] = await sql<{ id: string }[]>`insert into resources (name, kind, location, capacity, description, color, requires_approval, approver_id, allowed_team_ids, active, sort)
      values (${b.name}, ${b.kind}, ${b.location}, ${b.capacity}, ${b.description}, ${b.color}, ${b.requiresApproval}, ${b.approverId}, ${b.allowedTeamIds}, ${b.active}, ${b.sort})
      returning id`;
    await audit(sql, u, { action: 'resource.create', entityType: 'resource', entityId: r!.id, summary: `${KIND_LABEL[b.kind]} „${b.name}“ angelegt` });
    return r;
  });

  app.patch('/resources/:id', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const cur = await loadResource(id);
    const b = parse(patchSchema(resourceBody), req.body);
    await sql`update resources set
      name = coalesce(${b.name ?? null}, name), kind = coalesce(${b.kind ?? null}, kind), location = coalesce(${b.location ?? null}, location),
      capacity = ${b.capacity === undefined ? sql`capacity` : b.capacity}, description = coalesce(${b.description ?? null}, description),
      color = coalesce(${b.color ?? null}, color), requires_approval = coalesce(${b.requiresApproval ?? null}, requires_approval),
      approver_id = ${b.approverId === undefined ? sql`approver_id` : b.approverId},
      allowed_team_ids = ${b.allowedTeamIds === undefined ? sql`allowed_team_ids` : b.allowedTeamIds},
      active = coalesce(${b.active ?? null}, active), sort = coalesce(${b.sort ?? null}, sort), updated_at = now()
      where id = ${id}`;
    await audit(sql, u, { action: 'resource.update', entityType: 'resource', entityId: id,
      summary: b.active === false && cur.active ? `„${cur.name}“ gesperrt` : b.active === true && !cur.active ? `„${cur.name}“ wieder freigegeben` : `„${cur.name}“ geändert`, details: b });
    return { ok: true };
  });

  app.delete('/resources/:id', async (req) => {
    const u = requireRole(req, 'admin');
    const { id } = parse(idParam, req.params);
    const r = await loadResource(id);
    const [future] = await sql<{ n: number }[]>`select count(*)::int as n from resource_bookings where resource_id = ${id} and ends_at > now() and status in ('pending', 'approved')`;
    if (future && future.n > 0) throw badRequest(`Es gibt noch ${future.n} künftige Buchungen – bitte die Ressource stattdessen sperren`);
    await sql`delete from resources where id = ${id}`;
    await audit(sql, u, { action: 'resource.delete', entityType: 'resource', entityId: id, summary: `„${r.name}“ gelöscht` });
    return { ok: true };
  });

  // ------------------------------------------------ Buchungen ansehen
  const bookingSelect = (u: AuthUser) => sql`b.id, b.resource_id as "resourceId", r.name as "resourceName", r.kind as "resourceKind", r.color,
    b.user_id as "userId", us.display_name as "userName", b.starts_at as "startsAt", b.ends_at as "endsAt", b.status, b.series_id as "seriesId",
    b.project_id as "projectId", p.number as "projectNumber",
    case when b.user_id = ${u.id} or ${u.role === 'admin'} or r.approver_id = ${u.id} then b.title end as title,
    case when b.user_id = ${u.id} or ${u.role === 'admin'} or r.approver_id = ${u.id} then b.note end as note,
    (b.user_id = ${u.id}) as mine, dc.display_name as "decidedByName"`;
  const bookingFrom = sql`resource_bookings b join resources r on r.id = b.resource_id join users us on us.id = b.user_id
    left join projects p on p.id = b.project_id left join users dc on dc.id = b.decided_by`;

  app.get('/resources/bookings', async (req) => {
    const u = requireUser(req);
    const q = parse(z.object({ from: z.string(), to: z.string(), resourceId: z.string().uuid().optional(), mine: z.coerce.boolean().optional() }), req.query);
    return sql`select ${bookingSelect(u)} from ${bookingFrom}
      where b.starts_at < ${new Date(q.to)} and b.ends_at > ${new Date(q.from)} and b.status in ('pending', 'approved')
      ${q.resourceId ? sql`and b.resource_id = ${q.resourceId}` : sql``}
      ${q.mine ? sql`and b.user_id = ${u.id}` : sql``}
      order by b.starts_at`;
  });

  app.get('/resources/bookings/review', async (req) => {
    const u = requireUser(req);
    return sql`select ${bookingSelect(u)} from ${bookingFrom}
      where b.status = 'pending' and b.ends_at > now() and (${u.role === 'admin'} or r.approver_id = ${u.id}) order by b.starts_at`;
  });

  /** Freie Ressourcen für einen Zeitraum (Alternativen bei Belegung) */
  async function freeResources(u: AuthUser, startsAt: Date, endsAt: Date, kind?: string, exceptBookingId?: string) {
    const rows = await sql<(Resource & { location: string; capacity: number | null; color: string })[]>`select * from resources r where r.active
      ${kind ? sql`and r.kind = ${kind}` : sql``}
      and not exists (select 1 from resource_bookings b where b.resource_id = r.id and b.status in ('pending', 'approved')
        and tstzrange(b.starts_at, b.ends_at) && tstzrange(${startsAt}, ${endsAt}) ${exceptBookingId ? sql`and b.id <> ${exceptBookingId}` : sql``})
      order by r.sort, r.name`;
    const out = [];
    for (const r of rows) if (await mayBook(u, r)) out.push({ id: r.id, name: r.name, kind: r.kind, location: r.location, capacity: r.capacity, color: r.color });
    return out;
  }

  app.post('/resources/availability', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), kind: z.enum(KINDS).optional() }), req.body);
    return freeResources(u, new Date(b.startsAt), new Date(b.endsAt), b.kind);
  });

  async function conflictError(u: AuthUser, r: Resource, startsAt: Date, endsAt: Date, exceptId?: string): Promise<HttpError | null> {
    const clashes = await sql<{ starts_at: Date; ends_at: Date; name: string }[]>`select b.starts_at, b.ends_at, us.display_name as name
      from resource_bookings b join users us on us.id = b.user_id where b.resource_id = ${r.id} and b.status in ('pending', 'approved')
      and tstzrange(b.starts_at, b.ends_at) && tstzrange(${startsAt}, ${endsAt}) ${exceptId ? sql`and b.id <> ${exceptId}` : sql``} order by b.starts_at`;
    if (!clashes.length) return null;
    const alternatives = (await freeResources(u, startsAt, endsAt, r.kind)).filter((x) => x.id !== r.id).slice(0, 5);
    const c = clashes[0]!;
    const err = conflict(`„${r.name}“ ist bereits belegt von ${c.name} (${fmt(c.starts_at)} – ${fmt(c.ends_at)})` +
      (alternatives.length ? `. Frei wäre: ${alternatives.map((a) => a.name).join(', ')}` : ''));
    (err as HttpError & { details?: unknown }).details = { clashes: clashes.map((x) => ({ startsAt: x.starts_at, endsAt: x.ends_at, userName: x.name })), alternatives };
    return err;
  }

  // ------------------------------------------------ Buchen
  app.post('/resources/bookings', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({
      resourceId: z.string().uuid(),
      startsAt: z.string().datetime({ offset: true }),
      endsAt: z.string().datetime({ offset: true }),
      title: z.string().trim().max(200).default(''),
      note: z.string().max(2000).default(''),
      projectId: z.string().uuid().nullable().default(null),
      repeatWeeklyUntil: z.string().date().nullable().default(null),
    }), req.body);
    const r = await loadResource(b.resourceId);
    if (!r.active) throw badRequest(`„${r.name}“ ist derzeit gesperrt`);
    if (!(await mayBook(u, r))) throw forbidden('Diese Ressource ist für Ihr Team nicht freigegeben');
    if (b.projectId) await projectAccess(sql, u, b.projectId);
    const start = new Date(b.startsAt), end = new Date(b.endsAt);
    if (end <= start) throw badRequest('Das Ende muss nach dem Beginn liegen');
    if (end.getTime() - start.getTime() > 31 * 86400_000) throw badRequest('Eine einzelne Buchung darf höchstens 31 Tage dauern');
    if (end < new Date()) throw badRequest('Buchungen in der Vergangenheit sind nicht möglich');

    // Termine der Serie (wöchentlich) berechnen
    const slots: [Date, Date][] = [[start, end]];
    if (b.repeatWeeklyUntil) {
      const until = new Date(`${b.repeatWeeklyUntil}T23:59:59`);
      if (until.getTime() - start.getTime() > 366 * 86400_000) throw badRequest('Serien sind auf ein Jahr begrenzt');
      for (let i = 1; ; i++) {
        const s = new Date(start.getTime() + i * 7 * 86400_000);
        if (s > until) break;
        slots.push([s, new Date(end.getTime() + i * 7 * 86400_000)]);
      }
    }
    for (const [s, e] of slots) {
      const err = await conflictError(u, r, s, e);
      if (err) throw err;
    }
    const status = r.requires_approval && !isApprover(u, r) ? 'pending' : 'approved';
    const seriesId = slots.length > 1 ? randomUUID() : null;
    let ids: string[];
    try {
      ids = await sql.begin(async (tx) => {
        const out: string[] = [];
        for (const [s, e] of slots) {
          const [row] = await tx<{ id: string }[]>`insert into resource_bookings (resource_id, user_id, title, note, project_id, starts_at, ends_at, status, series_id)
            values (${r.id}, ${u.id}, ${b.title}, ${b.note}, ${b.projectId}, ${s}, ${e}, ${status}, ${seriesId}) returning id`;
          out.push(row!.id);
        }
        return out;
      });
    } catch (e) {
      // gleichzeitige Buchung zweier Personen: Datenbank hat die Überschneidung abgewiesen
      if ((e as { code?: string }).code === '23P01') throw (await conflictError(u, r, start, end)) ?? conflict(`„${r.name}“ wurde soeben belegt`);
      throw e;
    }
    await audit(sql, u, { action: 'resource.book', entityType: 'resource_booking', entityId: ids[0], projectId: b.projectId,
      summary: `${r.name} gebucht: ${fmt(start)} – ${fmt(end)}${slots.length > 1 ? ` (wöchentlich, ${slots.length} Termine)` : ''}${status === 'pending' ? ' – wartet auf Genehmigung' : ''}` });
    if (status === 'pending') {
      await notify(ctx, await approvers(r), { kind: 'resource.request', title: `Buchungsanfrage: ${r.name}`,
        body: `${u.displayName}, ${fmt(start)} – ${fmt(end)}${slots.length > 1 ? ` (+${slots.length - 1} weitere)` : ''}${b.title ? `\n${b.title}` : ''}`, link: '/calendar/resources?tab=review' }, u.id);
    }
    ctx.hub.publish('global', 'resources.changed', { resourceId: r.id });
    return { ids, status, count: ids.length };
  });

  async function loadBooking(id: string) {
    const [b] = await sql<{ id: string; resource_id: string; user_id: string; status: string; starts_at: Date; ends_at: Date; series_id: string | null; title: string }[]>`
      select id, resource_id, user_id, status, starts_at, ends_at, series_id, title from resource_bookings where id = ${id}`;
    if (!b) throw notFound('Buchung nicht gefunden');
    return b;
  }

  /** Verschieben bzw. Anlass ändern */
  app.patch('/resources/bookings/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const bk = await loadBooking(id);
    const r = await loadResource(bk.resource_id);
    if (bk.user_id !== u.id && u.role !== 'admin') throw forbidden('Nur eigene Buchungen können geändert werden');
    if (!['pending', 'approved'].includes(bk.status)) throw badRequest('Diese Buchung ist nicht mehr aktiv');
    const b = parse(z.object({ startsAt: z.string().datetime({ offset: true }).optional(), endsAt: z.string().datetime({ offset: true }).optional(),
      title: z.string().max(200).optional(), note: z.string().max(2000).optional(), resourceId: z.string().uuid().optional() }), req.body);
    const target = b.resourceId ? await loadResource(b.resourceId) : r;
    if (b.resourceId && (!target.active || !(await mayBook(u, target)))) throw forbidden('Diese Ressource ist nicht buchbar');
    const start = b.startsAt ? new Date(b.startsAt) : bk.starts_at, end = b.endsAt ? new Date(b.endsAt) : bk.ends_at;
    if (end <= start) throw badRequest('Das Ende muss nach dem Beginn liegen');
    const moved = start.getTime() !== bk.starts_at.getTime() || end.getTime() !== bk.ends_at.getTime() || target.id !== r.id;
    if (moved) { const err = await conflictError(u, target, start, end, id); if (err) throw err; }
    const status = moved && target.requires_approval && !isApprover(u, target) ? 'pending' : bk.status;
    try {
      await sql`update resource_bookings set resource_id = ${target.id}, starts_at = ${start}, ends_at = ${end}, title = coalesce(${b.title ?? null}, title),
        note = coalesce(${b.note ?? null}, note), status = ${status}, updated_at = now() where id = ${id}`;
    } catch (e) {
      if ((e as { code?: string }).code === '23P01') throw conflict('Der Zeitraum wurde soeben belegt');
      throw e;
    }
    if (moved) await audit(sql, u, { action: 'resource.move', entityType: 'resource_booking', entityId: id, summary: `Buchung ${target.name} verschoben auf ${fmt(start)} – ${fmt(end)}` });
    if (status === 'pending' && moved) await notify(ctx, await approvers(target), { kind: 'resource.request', title: `Geänderte Buchungsanfrage: ${target.name}`, body: `${u.displayName}, ${fmt(start)} – ${fmt(end)}`, link: '/calendar/resources?tab=review' }, u.id);
    ctx.hub.publish('global', 'resources.changed', { resourceId: target.id });
    return { ok: true, status };
  });

  app.post('/resources/bookings/:id/cancel', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ series: z.boolean().default(false), reason: z.string().default('') }), req.body ?? {});
    const bk = await loadBooking(id);
    const r = await loadResource(bk.resource_id);
    const own = bk.user_id === u.id;
    if (!own && u.role !== 'admin') throw forbidden('Nur eigene Buchungen können storniert werden');
    const rows = await sql<{ id: string }[]>`update resource_bookings set status = 'cancelled', updated_at = now()
      where ${b.series && bk.series_id ? sql`series_id = ${bk.series_id} and starts_at >= ${bk.starts_at}` : sql`id = ${id}`}
      and status in ('pending', 'approved') returning id`;
    await audit(sql, u, { action: 'resource.cancel', entityType: 'resource_booking', entityId: id,
      summary: `Buchung ${r.name} (${fmt(bk.starts_at)}) storniert${rows.length > 1 ? ` – ${rows.length} Termine der Serie` : ''}` });
    if (!own) await notify(ctx, [bk.user_id], { kind: 'resource.cancelled', title: `Ihre Buchung „${r.name}“ wurde storniert`,
      body: `${fmt(bk.starts_at)} – ${fmt(bk.ends_at)}${b.reason ? `\nGrund: ${b.reason}` : ''}`, link: '/calendar/resources' }, u.id);
    ctx.hub.publish('global', 'resources.changed', { resourceId: r.id });
    return { ok: true, cancelled: rows.length };
  });

  app.post('/resources/bookings/:id/decide', async (req) => {
    const u = requireUser(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: z.string().default(''), series: z.boolean().default(true) }), req.body);
    const bk = await loadBooking(id);
    const r = await loadResource(bk.resource_id);
    if (!isApprover(u, r)) throw forbidden('Nur der zuständige Genehmiger kann entscheiden');
    if (bk.status !== 'pending') throw badRequest('Bereits entschieden');
    const rows = await sql<{ id: string }[]>`update resource_bookings set status = ${b.approve ? 'approved' : 'rejected'}, decided_by = ${u.id}, decided_at = now(), updated_at = now()
      where ${b.series && bk.series_id ? sql`series_id = ${bk.series_id}` : sql`id = ${id}`} and status = 'pending' returning id`;
    await audit(sql, u, { action: 'resource.decide', entityType: 'resource_booking', entityId: id,
      summary: `Buchung ${r.name} (${fmt(bk.starts_at)}) ${b.approve ? 'genehmigt' : 'abgelehnt'}${rows.length > 1 ? ` – ${rows.length} Termine` : ''}` });
    await notify(ctx, [bk.user_id], { kind: 'resource.decision', title: `Buchung „${r.name}“ ${b.approve ? 'genehmigt' : 'abgelehnt'}`,
      body: `${fmt(bk.starts_at)} – ${fmt(bk.ends_at)}${b.note ? `\n${b.note}` : ''}`, link: '/calendar/resources' }, u.id);
    ctx.hub.publish('global', 'resources.changed', { resourceId: r.id });
    return { ok: true, count: rows.length };
  });
}
