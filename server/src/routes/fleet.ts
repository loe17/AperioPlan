/**
 * Fuhrpark: Fahrzeuge mit Fahrer, Leasing und Listenpreis, Kosten (Tanken, Werkstatt …), elektronisches Fahrtenbuch,
 * Schäden, Termine für HU und Inspektion sowie Führerscheinkontrolle.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { staffOf, toRow, today } from '../lib/rows';
import { writeXlsx } from '../lib/xlsx';

const addMonths = (d: string, m: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const vehicleBody = z.object({
  plate: z.string().trim().min(1).max(20), make: z.string().max(60).default(''), model: z.string().max(80).default(''), vin: z.string().max(40).default(''),
  kind: z.enum(['car', 'van', 'truck', 'trailer', 'other']).default('car'), fuel: z.string().max(30).default('diesel'), firstRegistration: z.string().date().nullable().default(null),
  listPrice: z.number().min(0).nullable().default(null), ownership: z.enum(['owned', 'leased', 'rented']).default('owned'), leasingEnd: z.string().date().nullable().default(null),
  leasingRate: z.number().min(0).nullable().default(null), driverId: z.string().uuid().nullable().default(null), privateUse: z.boolean().default(false), resourceId: z.string().uuid().nullable().default(null),
  mileage: z.number().int().min(0).default(0), nextHu: z.string().date().nullable().default(null), nextService: z.string().date().nullable().default(null), serviceKm: z.number().int().min(0).nullable().default(null),
  insurance: z.string().max(200).default(''), notes: z.string().max(10000).default(''), active: z.boolean().default(true),
});
const entryBody = z.object({ date: z.string().date(), kind: z.enum(['fuel', 'charge', 'service', 'repair', 'tires', 'insurance', 'tax', 'leasing', 'other']), amount: z.number(), liters: z.number().min(0).nullable().default(null),
  mileage: z.number().int().min(0).nullable().default(null), note: z.string().max(1000).default('') });
const tripBody = z.object({ date: z.string().date(), startKm: z.number().int().min(0), endKm: z.number().int().min(0), origin: z.string().max(200).default(''), destination: z.string().max(200).default(''),
  purpose: z.string().max(300).default(''), partner: z.string().max(200).default(''), kind: z.enum(['business', 'private', 'commute']).default('business') });

export async function fleetDaily(ctx: AppContext) {
  const { sql } = ctx;
  if (!(await ctx.settings.get('apps')).installed.includes('fleet')) return;
  const s = await ctx.settings.get('fleet');
  const managers = s.managerIds.length ? s.managerIds : (await sql<{ id: string }[]>`select id from users where role = 'admin' and active`).map((r) => r.id);
  const soon = addMonths(today(), 1);
  const vs = await sql<{ id: string; plate: string; next_hu: string | null; next_service: string | null; driver_id: string | null; reminded: Record<string, string> }[]>`
    select id, plate, next_hu::text, next_service::text, driver_id, reminded from fl_vehicles where active`;
  for (const v of vs) {
    for (const [key, date, label] of [['hu', v.next_hu, 'Hauptuntersuchung (HU)'], ['service', v.next_service, 'Inspektion']] as const) {
      if (!date || date > soon || v.reminded[key] === date) continue;
      await notify(ctx, [...managers, v.driver_id], { kind: 'fleet.due', title: `${label} fällig: ${v.plate}`, body: `bis ${new Date(`${date}T12:00:00`).toLocaleDateString('de-DE')}`, link: `/fleet?vehicle=${v.id}` });
      await sql`update fl_vehicles set reminded = reminded || ${sql.json({ [key]: date } as never)} where id = ${v.id}`;
    }
  }
}

export default async function fleetRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const changed = () => ctx.hub.publish('global', 'fleet.changed', {});
  const isManager = async (u: AuthUser) => u.role === 'admin' || (await ctx.settings.get('fleet')).managerIds.includes(u.id);
  const manager = async (req: Parameters<typeof staffOf>[0]) => { const u = staffOf(req); if (!(await isManager(u))) throw forbidden('Fahrzeuge verwalten die Fuhrparkverantwortlichen.'); return u; };
  const cols = sql`v.id, v.plate, v.make, v.model, v.vin, v.kind, v.fuel, v.first_registration::text as "firstRegistration", v.list_price::float as "listPrice", v.ownership,
    v.leasing_end::text as "leasingEnd", v.leasing_rate::float as "leasingRate", v.driver_id as "driverId", d.display_name as "driverName", v.private_use as "privateUse", v.resource_id as "resourceId",
    v.mileage, v.next_hu::text as "nextHu", v.next_service::text as "nextService", v.service_km as "serviceKm", v.insurance, v.notes, v.active,
    (select coalesce(sum(amount), 0)::float from fl_entries e where e.vehicle_id = v.id and e.date > current_date - 365) as "cost12",
    (select coalesce(sum(end_km - start_km), 0)::int from fl_trips t where t.vehicle_id = v.id and t.date > current_date - 365) as "km12",
    (select count(*)::int from fl_damages x where x.vehicle_id = v.id and x.status = 'open') as "openDamages"`;
  const from = sql`fl_vehicles v left join users d on d.id = v.driver_id`;
  const decorate = (v: any) => ({ ...v, costPerKm: v.km12 ? Math.round((v.cost12 / v.km12) * 100) / 100 : null,
    // Geldwerter Vorteil bei Privatnutzung (1-%-Regel, E-Fahrzeuge 0,25 %): nur Hinweis für die Lohnabrechnung
    benefitMonthly: v.privateUse && v.listPrice ? Math.round(Math.floor(v.listPrice / 100) * 100 * (v.fuel === 'electric' ? 0.0025 : v.fuel === 'hybrid' ? 0.005 : 0.01) * 100) / 100 : null });

  app.get('/fleet/access', async (req) => ({ manager: await isManager(staffOf(req)) }));
  app.get('/fleet/vehicles', async (req) => {
    staffOf(req);
    return (await sql`select ${cols} from ${from} order by v.active desc, v.plate`).map(decorate);
  });
  app.get('/fleet/vehicles/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [v] = await sql`select ${cols} from ${from} where v.id = ${id}`;
    if (!v) throw notFound('Fahrzeug nicht gefunden');
    const entries = await sql`select e.id, e.date::text, e.kind, e.amount::float as amount, e.liters::float as liters, e.mileage, e.note, u.display_name as "userName" from fl_entries e left join users u on u.id = e.user_id where e.vehicle_id = ${id} order by e.date desc limit 500`;
    const trips = await sql`select t.id, t.date::text, t.start_km as "startKm", t.end_km as "endKm", t.origin, t.destination, t.purpose, t.partner, t.kind, u.display_name as "userName", t.user_id as "userId"
      from fl_trips t left join users u on u.id = t.user_id where t.vehicle_id = ${id} order by t.date desc, t.start_km desc limit 500`;
    const damages = await sql`select x.id, x.date::text, x.description, x.status, x.cost::float as cost, u.display_name as "reportedByName" from fl_damages x left join users u on u.id = x.reported_by where x.vehicle_id = ${id} order by x.date desc`;
    return { ...decorate(v), entries, trips, damages, manager: await isManager(u) };
  });
  app.post('/fleet/vehicles', async (req) => {
    const u = await manager(req);
    const b = parse(vehicleBody, req.body);
    const [v] = await sql<{ id: string }[]>`insert into fl_vehicles ${sql(toRow(sql, { ...b, plate: b.plate.toUpperCase() }))} returning id`.catch((e: Error) => { throw /unique/.test(e.message) ? badRequest('Dieses Kennzeichen gibt es schon.') : e; });
    await audit(sql, u, { action: 'fleet.vehicle.create', entityType: 'fl_vehicle', entityId: v!.id, summary: b.plate });
    changed();
    return { id: v!.id };
  });
  app.patch('/fleet/vehicles/:id', async (req) => {
    await manager(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(vehicleBody), req.body);
    const row = toRow(sql, { ...b, ...(b.plate ? { plate: b.plate.toUpperCase() } : {}) });
    if (Object.keys(row).length) await sql`update fl_vehicles set ${sql(row)}, updated_at = now() where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/fleet/vehicles/:id', async (req) => {
    const u = await manager(req);
    const { id } = parse(idParam, req.params);
    const [n] = await sql<{ n: number }[]>`select (select count(*) from fl_trips where vehicle_id = ${id}) + (select count(*) from fl_entries where vehicle_id = ${id}) as n`;
    if (Number(n!.n)) throw badRequest('Es gibt Fahrten oder Kosten zu diesem Fahrzeug – bitte stilllegen statt löschen (Fahrtenbuch muss aufbewahrt werden).');
    await sql`delete from fl_vehicles where id = ${id}`;
    await audit(sql, u, { action: 'fleet.vehicle.delete', entityType: 'fl_vehicle', entityId: id, summary: 'Fahrzeug gelöscht' });
    changed();
    return { ok: true };
  });

  // Kosten
  app.post('/fleet/vehicles/:id/entries', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(entryBody, req.body);
    await sql`insert into fl_entries ${sql({ ...toRow(sql, b), vehicle_id: id, user_id: u.id })}`;
    if (b.mileage) await sql`update fl_vehicles set mileage = greatest(mileage, ${b.mileage}) where id = ${id}`;
    if (b.kind === 'service' && b.mileage) await sql`update fl_vehicles set reminded = reminded - 'service' where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/fleet/entries/:id', async (req) => { await manager(req); await sql`delete from fl_entries where id = ${parse(idParam, req.params).id}`; changed(); return { ok: true }; });

  // Fahrtenbuch: lückenlos und chronologisch
  app.post('/fleet/vehicles/:id/trips', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(tripBody, req.body);
    if (b.endKm < b.startKm) throw badRequest('Der Kilometerstand am Ende ist kleiner als am Anfang.');
    if (b.kind === 'business' && !b.purpose.trim()) throw badRequest('Für das Fahrtenbuch bitte Zweck bzw. Kunde der Dienstfahrt angeben.');
    const [prev] = await sql<{ end_km: number; date: string }[]>`select end_km, date::text from fl_trips where vehicle_id = ${id} order by end_km desc limit 1`;
    if (prev && b.startKm < prev.end_km) throw badRequest(`Der Anfangsstand liegt unter dem Ende der letzten Fahrt (${prev.end_km.toLocaleString('de-DE')} km).`);
    if (prev && b.date < prev.date) throw badRequest('Fahrten bitte in zeitlicher Reihenfolge eintragen.');
    const gap = prev ? b.startKm - prev.end_km : 0;
    await sql`insert into fl_trips ${sql({ ...toRow(sql, b), vehicle_id: id, user_id: u.id })}`;
    await sql`update fl_vehicles set mileage = greatest(mileage, ${b.endKm}) where id = ${id}`;
    changed();
    return { ok: true, gap };
  });
  app.delete('/fleet/trips/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const [t] = await sql<{ user_id: string | null; vehicle_id: string; end_km: number; created_at: Date }[]>`select user_id, vehicle_id, end_km, created_at from fl_trips where id = ${id}`;
    if (!t) throw notFound();
    const [later] = await sql`select 1 from fl_trips where vehicle_id = ${t.vehicle_id} and end_km > ${t.end_km}`;
    // Nachträgliche Änderungen sind beim Fahrtenbuch nur direkt nach dem Eintrag zulässig
    if (later || Date.now() - t.created_at.getTime() > 7 * 86400000) throw badRequest('Nur die letzte Fahrt der vergangenen 7 Tage lässt sich löschen.');
    if (t.user_id !== u.id && !(await isManager(u))) throw forbidden();
    await sql`delete from fl_trips where id = ${id}`;
    await audit(sql, u, { action: 'fleet.trip.delete', entityType: 'fl_vehicle', entityId: t.vehicle_id, summary: 'Fahrt gelöscht' });
    changed();
    return { ok: true };
  });
  app.get('/fleet/vehicles/:id/logbook.xlsx', async (req, reply) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100) }), req.query);
    const [v] = await sql<{ plate: string }[]>`select plate from fl_vehicles where id = ${id}`;
    if (!v) throw notFound();
    const rows = await sql<any[]>`select t.date::text as date, t.start_km, t.end_km, t.origin, t.destination, t.purpose, t.partner, t.kind, u.display_name as driver from fl_trips t left join users u on u.id = t.user_id
      where t.vehicle_id = ${id} and extract(year from t.date) = ${q.year} order by t.start_km`;
    const K: Record<string, string> = { business: 'dienstlich', private: 'privat', commute: 'Arbeitsweg' };
    const sum = (k: string) => rows.filter((r) => r.kind === k).reduce((s, r) => s + r.end_km - r.start_km, 0);
    const buf = writeXlsx([{ name: `Fahrtenbuch ${q.year}`, rows: [['Datum', 'km Beginn', 'km Ende', 'km', 'Start', 'Ziel', 'Zweck', 'Geschäftspartner', 'Art', 'Fahrer'],
      ...rows.map((r) => [new Date(`${r.date}T12:00:00`).toLocaleDateString('de-DE'), r.start_km, r.end_km, r.end_km - r.start_km, r.origin, r.destination, r.purpose, r.partner, K[r.kind] ?? r.kind, r.driver ?? '']),
      [], ['Summe dienstlich', '', '', sum('business')], ['Summe privat', '', '', sum('private')], ['Summe Arbeitsweg', '', '', sum('commute')]], widths: [12, 10, 10, 8, 22, 22, 30, 22, 12, 18] }]);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('content-disposition', `attachment; filename="Fahrtenbuch_${v.plate.replace(/\s+/g, '')}_${q.year}.xlsx"`);
    return reply.send(buf);
  });

  // Schäden
  app.post('/fleet/vehicles/:id/damages', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ date: z.string().date(), description: z.string().trim().min(3).max(5000) }), req.body);
    const [v] = await sql<{ plate: string }[]>`select plate from fl_vehicles where id = ${id}`;
    if (!v) throw notFound();
    await sql`insert into fl_damages (vehicle_id, date, description, reported_by) values (${id}, ${b.date}, ${b.description}, ${u.id})`;
    const s = await ctx.settings.get('fleet');
    const managers = s.managerIds.length ? s.managerIds : (await sql<{ id: string }[]>`select id from users where role = 'admin' and active`).map((r) => r.id);
    await notify(ctx, managers, { kind: 'fleet.damage', title: `Schaden gemeldet: ${v.plate}`, body: b.description.slice(0, 140), link: `/fleet?vehicle=${id}` }, u.id);
    changed();
    return { ok: true };
  });
  app.patch('/fleet/damages/:id', async (req) => {
    await manager(req);
    const b = parse(z.object({ status: z.enum(['open', 'repaired', 'closed']).optional(), cost: z.number().min(0).nullable().optional() }), req.body);
    const row = toRow(sql, b);
    if (Object.keys(row).length) await sql`update fl_damages set ${sql(row)} where id = ${parse(idParam, req.params).id}`;
    changed();
    return { ok: true };
  });

  // Führerscheinkontrolle
  app.get('/fleet/licenses', async (req) => {
    await manager(req);
    const months = (await ctx.settings.get('fleet')).licenseCheckMonths;
    const rows = await sql<{ id: string; displayName: string; last: string | null; classes: string | null; drives: boolean }[]>`select u.id, u.display_name as "displayName",
      (select max(date)::text from fl_license_checks c where c.user_id = u.id) as last,
      (select classes from fl_license_checks c where c.user_id = u.id order by date desc limit 1) as classes,
      (exists (select 1 from fl_vehicles v where v.driver_id = u.id and v.active) or exists (select 1 from fl_trips t where t.user_id = u.id and t.date > current_date - 365)) as drives
      from users u where u.active and u.role <> 'guest' and u.deleted_at is null order by u.display_name`;
    return rows.map((r) => ({ ...r, due: r.last ? addMonths(r.last, months) : null, overdue: r.drives && (!r.last || addMonths(r.last, months) < today()) }));
  });
  app.post('/fleet/licenses', async (req) => {
    const u = await manager(req);
    const b = parse(z.object({ userId: z.string().uuid(), date: z.string().date(), classes: z.string().max(60).default(''), note: z.string().max(500).default('') }), req.body);
    await sql`insert into fl_license_checks (user_id, date, classes, checked_by, note) values (${b.userId}, ${b.date}, ${b.classes}, ${u.id}, ${b.note})`;
    await audit(sql, u, { action: 'fleet.license', entityType: 'user', entityId: b.userId, summary: `Führerschein kontrolliert (${b.classes})` });
    changed();
    return { ok: true };
  });
}
