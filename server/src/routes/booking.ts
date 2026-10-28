/**
 * Terminbuchung: Terminarten mit Dauer, Puffer, Verfügbarkeit und Fragen; Kunden buchen über einen öffentlichen Link
 * freie Zeiten aus dem Kalender der Mitarbeiter. Bestätigung mit Kalendereintrag (.ics), Absage per Link,
 * bei Online-Terminen automatisch ein Meeting mit Gast-Link.
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { notify } from '../services/notify';
import { sendMail } from '../services/mail';
import { staffOf, toRow } from '../lib/rows';

const TZ = () => process.env.TZ || 'Europe/Berlin';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const window = z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)]);
const typeBody = z.object({
  name: z.string().trim().min(1).max(200), slug: z.string().trim().regex(/^[a-z0-9-]{2,60}$/, 'Nur Kleinbuchstaben, Ziffern und Bindestriche').optional(),
  description: z.string().max(5000).default(''), durationMin: z.number().int().min(5).max(480).default(30), bufferMin: z.number().int().min(0).max(240).default(0),
  hostIds: z.array(z.string().uuid()).min(1).max(30), availability: z.partialRecord(z.enum(DAYS), z.array(window).max(6)).default({ mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']], thu: [['09:00', '17:00']], fri: [['09:00', '15:00']] }),
  minNoticeHours: z.number().int().min(0).max(720).default(12), maxDaysAhead: z.number().int().min(1).max(365).default(60), location: z.string().max(300).default(''), online: z.boolean().default(false),
  questions: z.array(z.object({ id: z.string().max(40), label: z.string().max(200), required: z.boolean().default(false) })).max(20).default([]), color: z.string().max(20).default('#4f46e5'), active: z.boolean().default(true),
});

/** Ortszeit (Datum + HH:MM in der Zeitzone des Servers) in einen Zeitpunkt umrechnen */
export function localTime(date: string, hm: string, tz = TZ()): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = hm.split(':').map(Number) as [number, number];
  let t = Date.UTC(y, m - 1, d, h, mi);
  for (let k = 0; k < 2; k++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    t += Date.UTC(y, m - 1, d, h, mi) - shown;
  }
  return new Date(t);
}
const dayKey = (date: string) => DAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]!;
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const localDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: TZ() });
const slugify = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'termin';
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

type TypeRow = { id: string; slug: string; name: string; description: string; duration_min: number; buffer_min: number; host_ids: string[]; availability: Partial<Record<(typeof DAYS)[number], [string, string][]>>;
  min_notice_hours: number; max_days_ahead: number; location: string; online: boolean; questions: { id: string; label: string; required: boolean }[]; color: string; active: boolean };

export default async function bookingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, config } = ctx;
  const changed = () => ctx.hub.publish('global', 'booking.changed', {});
  const installed = async () => (await ctx.settings.get('apps')).installed.includes('booking');
  const company = async () => (await ctx.settings.get('invoicing')).legalName || (await ctx.settings.get('company')).name;

  /** Belegte Zeiten eines Mitarbeiters (Kalender, Buchungen, genehmigter Urlaub) */
  async function busy(hostId: string, from: Date, to: Date) {
    const ev = await sql<{ s: Date; e: Date; all_day: boolean }[]>`select e.starts_at as s, e.ends_at as e, e.all_day from calendar_events e
      where (e.owner_id = ${hostId} or exists (select 1 from calendar_attendees a where a.event_id = e.id and a.user_id = ${hostId} and a.response <> 'declined'))
        and e.starts_at < ${to} and e.ends_at > ${from}`;
    const ab = await sql<{ s: string; e: string }[]>`select start_date::text as s, end_date::text as e from absences where user_id = ${hostId} and status = 'approved' and start_date <= ${localDate(to)} and end_date >= ${localDate(from)}`;
    return [...ev.map((x) => (x.all_day ? [localTime(localDate(x.s), '00:00').getTime(), localTime(addDays(localDate(x.e), 1), '00:00').getTime()] : [x.s.getTime(), x.e.getTime()]) as [number, number]),
      ...ab.map((x) => [localTime(x.s, '00:00').getTime(), localTime(addDays(x.e, 1), '00:00').getTime()] as [number, number])];
  }
  async function slots(t: TypeRow, fromDate: string, days: number) {
    const now = Date.now();
    const earliest = now + t.min_notice_hours * 3600_000;
    const latest = now + t.max_days_ahead * 86400_000;
    const dur = t.duration_min * 60000, buf = t.buffer_min * 60000;
    const step = (t.duration_min <= 30 ? 15 : 30) * 60000;
    const start = localTime(fromDate, '00:00'), end = localTime(addDays(fromDate, days), '00:00');
    const hosts = t.host_ids;
    const busyBy = new Map<string, [number, number][]>();
    for (const h of hosts) busyBy.set(h, await busy(h, new Date(start.getTime() - 86400_000), new Date(end.getTime() + 86400_000)));
    const out: { date: string; times: { start: string; hosts: string[] }[] }[] = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(fromDate, i);
      const wins = t.availability[dayKey(date)] ?? [];
      const times: { start: string; hosts: string[] }[] = [];
      for (const [a, b] of wins) {
        const ws = localTime(date, a).getTime(), we = localTime(date, b).getTime();
        for (let s = ws; s + dur <= we; s += step) {
          if (s < earliest || s > latest) continue;
          const free = hosts.filter((h) => !(busyBy.get(h) ?? []).some(([bs, be]) => s - buf < be && s + dur + buf > bs));
          if (free.length) times.push({ start: new Date(s).toISOString(), hosts: free });
        }
      }
      out.push({ date, times });
    }
    return out;
  }
  const loadType = async (slug: string) => {
    if (!(await installed())) throw notFound();
    const [t] = await sql<TypeRow[]>`select * from bk_types where slug = ${slug} and active`;
    if (!t) throw notFound('Diese Terminart gibt es nicht (mehr).');
    return t;
  };

  // ------------------------------------------------ Verwaltung
  const typeCols = sql`id, slug, name, description, duration_min as "durationMin", buffer_min as "bufferMin", host_ids as "hostIds", availability, min_notice_hours as "minNoticeHours",
    max_days_ahead as "maxDaysAhead", location, online, questions, color, active`;
  app.get('/booking/types', async (req) => {
    staffOf(req);
    const rows = await sql<any[]>`select ${typeCols}, (select count(*)::int from bk_bookings b where b.type_id = t.id and b.status = 'confirmed' and b.starts_at > now()) as upcoming from bk_types t order by active desc, name`;
    return rows.map((r) => ({ ...r, publicUrl: `${config.publicUrl}/book/${r.slug}` }));
  });
  app.post('/booking/types', async (req) => {
    const u = staffOf(req);
    const b = parse(typeBody, req.body);
    let slug = b.slug ?? slugify(b.name);
    for (let i = 2; (await sql`select 1 from bk_types where slug = ${slug}`).length; i++) slug = `${slugify(b.name)}-${i}`;
    const [t] = await sql<{ id: string }[]>`insert into bk_types ${sql(toRow(sql, { ...b, slug }, ['hostIds', 'availability', 'questions']))} returning id`;
    await audit(sql, u, { action: 'booking.type.create', entityType: 'bk_type', entityId: t!.id, summary: b.name });
    changed();
    return { id: t!.id, slug, publicUrl: `${config.publicUrl}/book/${slug}` };
  });
  app.patch('/booking/types/:id', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(patchSchema(typeBody), req.body);
    if (b.slug) { const [d] = await sql`select 1 from bk_types where slug = ${b.slug} and id <> ${id}`; if (d) throw badRequest('Diese Adresse ist schon vergeben.'); }
    const row = toRow(sql, b, ['hostIds', 'availability', 'questions']);
    if (Object.keys(row).length) await sql`update bk_types set ${sql(row)} where id = ${id}`;
    await audit(sql, u, { action: 'booking.type.update', entityType: 'bk_type', entityId: id, summary: Object.keys(b).join(', ') });
    changed();
    return { ok: true };
  });
  app.delete('/booking/types/:id', async (req) => {
    staffOf(req);
    await sql`delete from bk_types where id = ${parse(idParam, req.params).id}`;
    changed();
    return { ok: true };
  });
  app.get('/booking/bookings', async (req) => {
    const u = staffOf(req);
    const q = parse(z.object({ past: z.coerce.boolean().optional(), mine: z.coerce.boolean().optional() }), req.query);
    return sql`select b.id, b.type_id as "typeId", t.name as "typeName", t.color, b.host_id as "hostId", h.display_name as "hostName", b.starts_at as "startsAt", b.ends_at as "endsAt",
      b.name, b.email, b.phone, b.company, b.answers, b.status, b.meeting_link as "meetingLink", b.created_at as "createdAt"
      from bk_bookings b join bk_types t on t.id = b.type_id left join users h on h.id = b.host_id
      where ${q.past ? sql`b.starts_at < now()` : sql`b.ends_at >= now()`} ${q.mine ? sql`and b.host_id = ${u.id}` : sql``}
      order by b.starts_at ${q.past ? sql`desc` : sql`asc`} limit 500`;
  });
  app.post('/booking/bookings/:id/cancel', async (req) => {
    const u = staffOf(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ reason: z.string().max(1000).default('') }), req.body ?? {});
    await cancelBooking(id, `abgesagt von ${u.displayName}${b.reason ? `: ${b.reason}` : ''}`, true);
    return { ok: true };
  });
  app.get('/booking/types/:id/slots', async (req) => {
    staffOf(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ from: z.string().date(), days: z.coerce.number().int().min(1).max(31).default(7) }), req.query);
    const [t] = await sql<TypeRow[]>`select * from bk_types where id = ${id}`;
    if (!t) throw notFound();
    return slots(t, q.from, q.days);
  });

  async function cancelBooking(id: string, why: string, mailCustomer: boolean) {
    const [b] = await sql<{ id: string; status: string; event_id: string | null; host_id: string | null; name: string; email: string; starts_at: Date; type_name: string }[]>`
      select b.id, b.status, b.event_id, b.host_id, b.name, b.email, b.starts_at, t.name as type_name from bk_bookings b join bk_types t on t.id = b.type_id where b.id = ${id}`;
    if (!b) throw notFound();
    if (b.status === 'cancelled') return;
    await sql`update bk_bookings set status = 'cancelled' where id = ${id}`;
    if (b.event_id) await sql`delete from calendar_events where id = ${b.event_id}`;
    await sql`update meetings set cancelled_at = now() where event_id = ${b.event_id}`.catch(() => undefined);
    const when = b.starts_at.toLocaleString('de-DE', { timeZone: TZ(), dateStyle: 'full', timeStyle: 'short' });
    await notify(ctx, [b.host_id], { kind: 'booking.cancelled', title: `Termin abgesagt: ${b.name}`, body: `${b.type_name}, ${when} – ${why}`, link: '/booking' });
    if (mailCustomer) await sendMail(ctx, { to: b.email, subject: `Abgesagt: ${b.type_name} am ${when}`, text: `Guten Tag ${b.name},\n\nleider müssen wir den Termin „${b.type_name}“ am ${when} absagen. Gern können Sie einen neuen Termin buchen.\n\nMit freundlichen Grüßen\n${await company()}` }).catch(() => undefined);
    ctx.hub.publish('global', 'calendar.changed', {});
    changed();
  }

  // ------------------------------------------------ Öffentlich
  app.get('/pub/book/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().max(80) }), req.params);
    const t = await loadType(slug);
    const hosts = await sql<{ id: string; display_name: string }[]>`select id, display_name from users where id = any(${t.host_ids})`;
    return { name: t.name, description: t.description, durationMin: t.duration_min, location: t.online ? 'Videokonferenz (Link kommt mit der Bestätigung)' : t.location, questions: t.questions,
      color: t.color, maxDaysAhead: t.max_days_ahead, hosts: hosts.map((h) => ({ id: h.id, name: h.display_name })), company: await company(), timeZone: TZ() };
  });
  app.get('/pub/book/:slug/slots', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().max(80) }), req.params);
    const q = parse(z.object({ from: z.string().date(), days: z.coerce.number().int().min(1).max(31).default(7) }), req.query);
    const t = await loadType(slug);
    return (await slots(t, q.from, q.days)).map((d) => ({ date: d.date, times: d.times.map((x) => x.start) }));
  });
  app.post('/pub/book/:slug', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const { slug } = parse(z.object({ slug: z.string().max(80) }), req.params);
    const b = parse(z.object({ start: z.string().datetime({ offset: true }), name: z.string().trim().min(2).max(200), email: z.string().trim().email().max(200), phone: z.string().max(60).default(''),
      company: z.string().max(200).default(''), answers: z.record(z.string(), z.string().max(2000)).default({}), website: z.string().max(0).default('') }), req.body);
    const t = await loadType(slug);
    for (const q of t.questions) if (q.required && !b.answers[q.id]?.trim()) throw badRequest(`Bitte beantworten: ${q.label}`);
    const start = new Date(b.start);
    const day = localDate(start);
    const free = (await slots(t, day, 1))[0]!.times.find((x) => new Date(x.start).getTime() === start.getTime());
    if (!free) throw badRequest('Diese Zeit ist leider nicht mehr frei. Bitte eine andere wählen.');
    // Gleichmäßig verteilen: Mitarbeiter mit den wenigsten kommenden Terminen
    const counts = await sql<{ host_id: string; n: number }[]>`select host_id, count(*)::int as n from bk_bookings where status = 'confirmed' and starts_at > now() and host_id = any(${free.hosts}) group by host_id`;
    const host = [...free.hosts].sort((a, z2) => (counts.find((c) => c.host_id === a)?.n ?? 0) - (counts.find((c) => c.host_id === z2)?.n ?? 0))[0]!;
    const end = new Date(start.getTime() + t.duration_min * 60000);
    const token = randomBytes(18).toString('base64url');
    const details = [`Gebucht von ${b.name}${b.company ? ` (${b.company})` : ''}`, `E-Mail: ${b.email}`, b.phone ? `Telefon: ${b.phone}` : '',
      ...t.questions.map((q) => (b.answers[q.id] ? `${q.label}: ${b.answers[q.id]}` : '')).filter(Boolean)].filter(Boolean).join('\n');
    let meetingLink: string | null = null;
    const result = await sql.begin(async (tx) => {
      // erneut prüfen, ob in der Zwischenzeit gebucht wurde (Sperre je Mitarbeiter)
      await tx`select pg_advisory_xact_lock(hashtext(${host}))`;
      const [clash] = await tx`select 1 from bk_bookings where host_id = ${host} and status = 'confirmed' and starts_at < ${end} and ends_at > ${start}`;
      if (clash) throw badRequest('Diese Zeit ist leider nicht mehr frei. Bitte eine andere wählen.');
      let eventId: string;
      if (t.online && (await ctx.settings.get('apps')).installed.includes('meetings')) {
        const [ch] = await tx<{ id: string }[]>`insert into chat_channels (kind, name, icon, created_by) values ('meeting', ${`${t.name}: ${b.name}`}, 'video', ${host}) returning id`;
        const mt = randomBytes(15).toString('base64url');
        meetingLink = `${config.publicUrl}/meet/${mt}`;
        const [ev] = await tx<{ id: string }[]>`insert into calendar_events (owner_id, title, description, location, starts_at, ends_at, reminder_minutes)
          values (${host}, ${`${t.name}: ${b.name}`}, ${`${details}\n\nVideokonferenz: ${meetingLink}`}, 'Videokonferenz (AperioPlan)', ${start}, ${end}, 10) returning id`;
        eventId = ev!.id;
        await tx`insert into meetings (title, description, starts_at, ends_at, host_id, channel_id, event_id, guest_token, guests_allowed, lobby) values (${`${t.name}: ${b.name}`}, ${details}, ${start}, ${end}, ${host}, ${ch!.id}, ${eventId}, ${mt}, true, true)`;
        await tx`insert into chat_members (channel_id, user_id) values (${ch!.id}, ${host}) on conflict do nothing`;
      } else {
        const [ev] = await tx<{ id: string }[]>`insert into calendar_events (owner_id, title, description, location, starts_at, ends_at, reminder_minutes)
          values (${host}, ${`${t.name}: ${b.name}`}, ${details}, ${t.location}, ${start}, ${end}, 15) returning id`;
        eventId = ev!.id;
      }
      const [bk] = await tx<{ id: string }[]>`insert into bk_bookings (type_id, host_id, starts_at, ends_at, name, email, phone, company, answers, token, event_id, meeting_link)
        values (${t.id}, ${host}, ${start}, ${end}, ${b.name}, ${b.email}, ${b.phone}, ${b.company}, ${sql.json(b.answers as never)}, ${token}, ${eventId}, ${meetingLink}) returning id`;
      return bk!;
    });
    const [h] = await sql<{ display_name: string }[]>`select display_name from users where id = ${host}`;
    const when = start.toLocaleString('de-DE', { timeZone: TZ(), dateStyle: 'full', timeStyle: 'short' });
    const firm = await company();
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AperioPlan//Terminbuchung//DE', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:${result.id}@aperioplan`, `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${t.name} (${firm})`.replace(/[,;]/g, (c) => `\\${c}`), `LOCATION:${(meetingLink ?? t.location).replace(/[,;]/g, (c) => `\\${c}`)}`,
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const cancelUrl = `${config.publicUrl}/book/cancel/${token}`;
    await sendMail(ctx, { to: b.email, subject: `Bestätigt: ${t.name} am ${when}`, text: `Guten Tag ${b.name},\n\nIhr Termin ist bestätigt:\n\n${t.name}\n${when} (${t.duration_min} Minuten)\nmit ${h?.display_name ?? firm}\n${meetingLink ? `Videokonferenz: ${meetingLink}` : t.location ? `Ort: ${t.location}` : ''}\n\nFalls etwas dazwischenkommt, können Sie hier absagen:\n${cancelUrl}\n\nMit freundlichen Grüßen\n${firm}`,
      inline: [{ name: 'termin.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }] }).catch(() => undefined);
    await notify(ctx, [host], { kind: 'booking.new', title: `Neuer Termin: ${b.name}`, body: `${t.name}, ${when}`, link: '/booking' });
    ctx.hub.publish('global', 'calendar.changed', {});
    changed();
    return { ok: true, start: start.toISOString(), end: end.toISOString(), host: h?.display_name ?? '', meetingLink, cancelToken: token };
  });
  app.get('/pub/book/cancel/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(60) }), req.params);
    if (!(await installed())) throw notFound();
    const [b] = await sql<{ name: string; starts_at: Date; status: string; type_name: string }[]>`select b.name, b.starts_at, b.status, t.name as type_name from bk_bookings b join bk_types t on t.id = b.type_id where b.token = ${token}`;
    if (!b) throw notFound('Buchung nicht gefunden');
    return { name: b.name, typeName: b.type_name, start: b.starts_at, status: b.status, company: await company() };
  });
  app.post('/pub/book/cancel/:token', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(60) }), req.params);
    const b = parse(z.object({ reason: z.string().max(1000).default('') }), req.body ?? {});
    if (!(await installed())) throw notFound();
    const [r] = await sql<{ id: string; starts_at: Date }[]>`select id, starts_at from bk_bookings where token = ${token}`;
    if (!r) throw notFound();
    if (r.starts_at.getTime() < Date.now()) throw badRequest('Der Termin liegt in der Vergangenheit.');
    await cancelBooking(r.id, `vom Kunden abgesagt${b.reason ? `: ${b.reason}` : ''}`, false);
    return { ok: true };
  });
}
