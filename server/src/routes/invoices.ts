/**
 * Rechnungen im CRM: Entwurf → Festschreiben (Nummer, PDF/ZUGFeRD bzw. XRechnung) → Versand per E-Mail →
 * Zahlungseingang. Abschlags- und Schlussrechnungen, Storno, Übergabe an die Buchhaltung (DATEV, ZIP).
 */
import type { FastifyInstance } from 'fastify';
import { dueDate, INVOICE_KIND, invoiceTotals, type InvoicePosition } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { requireUser, type AuthUser } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { projectAccess } from '../lib/access';
import { audit } from '../services/audit';
import { sendMail } from '../services/mail';
import { addPayment, cancelInvoice, finalizeInvoice, loadInvoice, paymentTermsText, recalcPaid, renderInvoicePdf, toEInvoice } from '../services/invoices';
import { buildCii } from '../services/einvoice';
import { datevExtf } from '../lib/datev';
import { outgoingInvoiceBookings } from '../services/accounting';
import { writeZip } from '../lib/zip';
import { writeXlsx } from '../lib/xlsx';
import { eur } from '../lib/pdf';
import { safeName } from '../services/files';
import { Readable } from 'node:stream';

const position = z.object({ text: z.string().max(500), description: z.string().max(5000).optional(), qty: z.number(), unit: z.string().max(20).default('Stk'),
  price: z.number(), discount: z.number().min(0).max(100).optional(), vatRate: z.number().min(0).max(100).optional() });
export const invoiceBody = z.object({
  accountId: z.string().uuid(), contactId: z.string().uuid().nullable().default(null), projectId: z.string().uuid().nullable().default(null),
  quoteId: z.string().uuid().nullable().default(null), kind: z.enum(['invoice', 'partial', 'final']).default('invoice'), title: z.string().max(300).default(''),
  invoiceDate: z.string().date().nullable().default(null), serviceFrom: z.string().date().nullable().default(null), serviceTo: z.string().date().nullable().default(null),
  dueDate: z.string().date().nullable().default(null), buyerReference: z.string().max(200).default(''), orderReference: z.string().max(200).default(''),
  intro: z.string().max(5000).optional(), outro: z.string().max(5000).optional(), positions: z.array(position).max(1000).default([]),
  vatRate: z.number().min(0).max(100).optional(), taxMode: z.enum(['standard', 'reverse_charge', 'intra_eu', 'export', 'small_business']).optional(),
  format: z.enum(['zugferd', 'xrechnung', 'pdf']).optional(), partialIds: z.array(z.string().uuid()).max(50).default([]),
});

/** Für andere Anwendungen (Service, Verträge): Rechnungsentwurf anlegen wie über die Schnittstelle */
export const invoiceApi: { createDraft?: (u: AuthUser, b: z.input<typeof invoiceBody>) => Promise<{ id: string }>; finalizeAndSend?: (u: AuthUser, id: string) => Promise<{ sentTo: string | null }> } = {};

export default async function invoiceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;
  const staff = (req: Parameters<typeof requireUser>[0]) => { const u = requireUser(req); if (u.role === 'guest') throw forbidden(); return u; };
  const cols = sql`i.id, i.number, i.kind, i.status, i.account_id as "accountId", a.name as "accountName", a.number as "accountNumber", i.contact_id as "contactId",
    i.project_id as "projectId", p.number as "projectNumber", p.name as "projectName", i.quote_id as "quoteId", q.number as "quoteNumber", i.cancels_id as "cancelsId",
    i.title, i.invoice_date::text as "invoiceDate", i.service_from::text as "serviceFrom", i.service_to::text as "serviceTo", i.due_date::text as "dueDate",
    i.buyer_reference as "buyerReference", i.order_reference as "orderReference", i.intro, i.outro, i.positions, i.vat_rate::float as "vatRate", i.tax_mode as "taxMode",
    i.payment_terms as "paymentTerms", i.total_net::float as "totalNet", i.total_tax::float as "totalTax", i.total_gross::float as "totalGross", i.prepaid::float as prepaid,
    i.paid_amount::float as "paidAmount", i.format, i.xml_path is not null as "hasXml", i.sent_at as "sentAt", i.sent_to as "sentTo", i.dunning_level as "dunningLevel",
    i.exported_at as "exportedAt", i.finalized_at as "finalizedAt", us.display_name as "createdByName", i.created_at as "createdAt",
    (i.status in ('open', 'partial') and i.due_date < current_date) as overdue`;
  const from = sql`crm_invoices i join crm_accounts a on a.id = i.account_id left join projects p on p.id = i.project_id left join crm_quotes q on q.id = i.quote_id left join users us on us.id = i.created_by`;

  async function draftDefaults(accountId: string) {
    const [a] = await sql<{ e_invoice: string | null; leitweg_id: string; country: string; vat_id: string }[]>`select e_invoice, leitweg_id, country, vat_id from crm_accounts where id = ${accountId}`;
    if (!a) throw notFound('Kunde nicht gefunden');
    const s = await ctx.settings.get('invoicing');
    const lh = await ctx.settings.get('letterhead');
    return { format: (a.e_invoice ?? (a.leitweg_id ? 'xrechnung' : s.defaultFormat)) as 'zugferd' | 'xrechnung' | 'pdf', taxMode: s.smallBusiness ? 'small_business' as const : 'standard' as const, vatRate: lh.vatRate, buyerReference: a.leitweg_id };
  }

  app.get('/crm/invoices', async (req) => {
    staff(req);
    const q = parse(z.object({ accountId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), status: z.string().max(20).optional(),
      q: z.string().trim().max(100).optional(), from: z.string().date().optional(), to: z.string().date().optional(), overdue: z.coerce.boolean().optional() }), req.query);
    const like = q.q ? `%${q.q}%` : null;
    return sql`select ${cols} from ${from} where true
      ${q.accountId ? sql`and i.account_id = ${q.accountId}` : sql``} ${q.projectId ? sql`and i.project_id = ${q.projectId}` : sql``}
      ${q.status === 'unpaid' ? sql`and i.status in ('open', 'partial')` : q.status ? sql`and i.status = ${q.status}` : sql``}
      ${q.overdue ? sql`and i.status in ('open', 'partial') and i.due_date < current_date` : sql``}
      ${like ? sql`and (i.number ilike ${like} or i.title ilike ${like} or a.name ilike ${like})` : sql``}
      ${q.from ? sql`and coalesce(i.invoice_date, i.created_at::date) >= ${q.from}` : sql``} ${q.to ? sql`and coalesce(i.invoice_date, i.created_at::date) <= ${q.to}` : sql``}
      order by (i.status = 'draft') desc, i.invoice_date desc nulls first, i.number desc limit 2000`;
  });

  app.get('/crm/invoices/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [inv] = await sql<any[]>`select ${cols} from ${from} where i.id = ${id}`;
    if (!inv) throw notFound('Rechnung nicht gefunden');
    const payments = await sql`select x.id, x.date::text, x.amount::float as amount, x.method, x.note, us.display_name as "userName" from crm_invoice_payments x left join users us on us.id = x.user_id where x.invoice_id = ${id} order by x.date`;
    const partials = await sql`select p.id, p.number, p.invoice_date::text as "invoiceDate", p.total_net::float as "totalNet", p.total_tax::float as "totalTax", p.total_gross::float as "totalGross"
      from crm_invoice_partials x join crm_invoices p on p.id = x.partial_id where x.final_id = ${id} order by p.invoice_date`;
    const [cancelledBy] = await sql`select id, number from crm_invoices where cancels_id = ${id}`;
    const totals = invoiceTotals(inv.positions, inv.vatRate, inv.taxMode);
    return { ...inv, payments, partials, cancelledBy: cancelledBy ?? null, preview: totals };
  });

  async function createDraft(u: AuthUser, b: z.infer<typeof invoiceBody>) {
    if (b.projectId) await projectAccess(sql, u, b.projectId);
    const d = await draftDefaults(b.accountId);
    const [r] = await sql<{ id: string }[]>`insert into crm_invoices (kind, account_id, contact_id, project_id, quote_id, title, invoice_date, service_from, service_to, due_date,
        buyer_reference, order_reference, intro, outro, positions, vat_rate, tax_mode, format, created_by)
      values (${b.kind}, ${b.accountId}, ${b.contactId}, ${b.projectId}, ${b.quoteId}, ${b.title}, ${b.invoiceDate}, ${b.serviceFrom}, ${b.serviceTo}, ${b.dueDate},
        ${b.buyerReference || d.buyerReference}, ${b.orderReference}, ${b.intro ?? 'für unsere Leistungen erlauben wir uns, wie folgt zu berechnen:'}, ${b.outro ?? 'Vielen Dank für Ihren Auftrag.'},
        ${sql.json(b.positions as never)}, ${b.vatRate ?? d.vatRate}, ${b.taxMode ?? d.taxMode}, ${b.format ?? d.format}, ${u.id}) returning id`;
    if (b.partialIds.length) await setPartials(r!.id, b.accountId, b.partialIds);
    ctx.hub.publish('global', 'invoices.changed', { id: r!.id });
    return r!;
  }
  invoiceApi.createDraft = (u, b) => createDraft(u, parse(invoiceBody, b));
  async function setPartials(finalId: string, accountId: string, ids: string[]) {
    const ok = await sql<{ id: string }[]>`select id from crm_invoices where id = any(${ids}) and kind = 'partial' and account_id = ${accountId} and status in ('open', 'partial', 'paid')
      and not exists (select 1 from crm_invoice_partials x join crm_invoices f on f.id = x.final_id where x.partial_id = crm_invoices.id and x.final_id <> ${finalId} and f.status <> 'cancelled')`;
    if (ok.length !== ids.length) throw badRequest('Mindestens eine Abschlagsrechnung passt nicht (anderer Kunde, Entwurf, storniert oder schon in einer Schlussrechnung verrechnet).');
    await sql`delete from crm_invoice_partials where final_id = ${finalId}`;
    for (const p of ids) await sql`insert into crm_invoice_partials (final_id, partial_id) values (${finalId}, ${p})`;
  }

  app.post('/crm/invoices', async (req) => {
    const u = staff(req);
    return createDraft(u, parse(invoiceBody, req.body));
  });

  /** Aus einem Angebot: ganze Rechnung, Abschlag (Prozent) oder Schlussrechnung (mit allen Abschlägen) */
  app.post('/crm/quotes/:id/invoice', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ kind: z.enum(['invoice', 'partial', 'final']).default('invoice'), percent: z.number().min(0.01).max(100).optional(), amount: z.number().positive().optional() }), req.body ?? {});
    const [q] = await sql<{ id: string; number: string; title: string; account_id: string; contact_id: string | null; project_id: string | null; positions: any[]; vat_rate: string; total_net: string; quote_date: string }[]>`
      select id, number, title, account_id, contact_id, project_id, positions, vat_rate, total_net, quote_date::text from crm_quotes where id = ${id}`;
    if (!q) throw notFound('Angebot nicht gefunden');
    const quotePositions: InvoicePosition[] = q.positions.filter((p) => !p.optional).map((p) => ({ text: p.text, description: p.description || undefined, qty: Number(p.qty), unit: p.unit || 'Stk', price: Number(p.price), discount: Number(p.discount) || undefined }));
    let positions = quotePositions;
    let partialIds: string[] = [];
    if (b.kind === 'partial') {
      const n = (await sql<{ n: number }[]>`select count(*)::int as n from crm_invoices where quote_id = ${id} and kind = 'partial' and status <> 'cancelled'`)[0]!.n;
      const net = b.amount ?? Math.round(Number(q.total_net) * (b.percent ?? 30)) / 100;
      positions = [{ text: `${n + 1}. Abschlag${b.percent ? ` ${b.percent} %` : ''} gemäß Angebot ${q.number}`, description: q.title, qty: 1, unit: 'psch', price: Math.round(net * 100) / 100 }];
    }
    if (b.kind === 'final') {
      partialIds = (await sql<{ id: string }[]>`select id from crm_invoices where quote_id = ${id} and kind = 'partial' and status in ('open', 'partial', 'paid')`).map((r) => r.id);
    }
    const r = await createDraft(u, parse(invoiceBody, { accountId: q.account_id, contactId: q.contact_id, projectId: q.project_id, quoteId: id, kind: b.kind,
      title: q.title, positions, vatRate: Number(q.vat_rate), partialIds }));
    await sql`update crm_quotes set status = 'accepted', updated_at = now() where id = ${id} and status in ('draft', 'sent')`;
    return r;
  });

  /** Nach Aufwand: Stunden je Aufgabe aus der Zeiterfassung, Material aus dem Lager */
  app.post('/crm/invoices/from-project/:id', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ from: z.string().date(), to: z.string().date(), hourlyRate: z.number().min(0), material: z.boolean().default(true), accountId: z.string().uuid().optional() }), req.body);
    await projectAccess(sql, u, id);
    const [p] = await sql<{ customer_id: string | null; name: string; number: string }[]>`select customer_id, name, number from projects where id = ${id}`;
    const accountId = b.accountId ?? p!.customer_id;
    if (!accountId) throw badRequest('Dem Projekt ist kein Kunde zugeordnet. Bitte im Projekt den Kunden wählen.');
    const hours = await sql<{ title: string | null; h: number }[]>`select t.title, sum(extract(epoch from (e.ended_at - e.started_at)) / 3600)::float as h
      from time_entries e left join tasks t on t.id = e.task_id where e.project_id = ${id} and e.ended_at is not null and e.started_at >= ${b.from} and e.started_at < ${b.to}::date + 1
      group by t.title order by t.title nulls last`;
    const positions: InvoicePosition[] = hours.filter((h) => h.h > 0.005).map((h) => ({ text: h.title ? `Arbeitszeit: ${h.title}` : 'Arbeitszeit', qty: Math.round(h.h * 100) / 100, unit: 'Std', price: b.hourlyRate }));
    if (b.material) {
      const mat = await sql<{ name: string; number: string; unit: string; qty: number; price: number }[]>`select a.name, a.number, a.unit,
        sum(case when m.kind = 'issue' then m.qty else -m.qty end)::float as qty, coalesce(max(m.unit_price), 0)::float as price
        from wh_moves m join wh_articles a on a.id = m.article_id where m.project_id = ${id} and m.kind in ('issue', 'return') and m.created_at >= ${b.from} and m.created_at < ${b.to}::date + 1
        group by a.id order by a.number`.catch(() => []);
      for (const m of mat) if (m.qty > 0) positions.push({ text: m.name, description: `Material ${m.number}`, qty: m.qty, unit: m.unit, price: m.price });
    }
    if (!positions.length) throw badRequest('Im Zeitraum gibt es keine gebuchten Stunden oder Material.');
    return createDraft(u, parse(invoiceBody, { accountId, projectId: id, title: `${p!.number} ${p!.name}`, positions, serviceFrom: b.from, serviceTo: b.to }));
  });

  app.patch('/crm/invoices/:id', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const [cur] = await sql<{ status: string; account_id: string }[]>`select status, account_id from crm_invoices where id = ${id}`;
    if (!cur) throw notFound();
    if (cur.status !== 'draft') throw badRequest('Festgeschriebene Rechnungen lassen sich nicht mehr ändern – bitte stornieren und neu erstellen.');
    const b = parse(patchSchema(invoiceBody).omit({ kind: true }), req.body);
    const set = <T>(v: T | undefined) => (v === undefined ? null : v);
    await sql`update crm_invoices set account_id = coalesce(${set(b.accountId)}, account_id), contact_id = ${b.contactId === undefined ? sql`contact_id` : b.contactId},
      project_id = ${b.projectId === undefined ? sql`project_id` : b.projectId}, title = coalesce(${set(b.title)}, title),
      invoice_date = ${b.invoiceDate === undefined ? sql`invoice_date` : b.invoiceDate}, service_from = ${b.serviceFrom === undefined ? sql`service_from` : b.serviceFrom},
      service_to = ${b.serviceTo === undefined ? sql`service_to` : b.serviceTo}, due_date = ${b.dueDate === undefined ? sql`due_date` : b.dueDate},
      buyer_reference = coalesce(${set(b.buyerReference)}, buyer_reference), order_reference = coalesce(${set(b.orderReference)}, order_reference),
      intro = coalesce(${set(b.intro)}, intro), outro = coalesce(${set(b.outro)}, outro), positions = ${b.positions ? sql.json(b.positions as never) : sql`positions`},
      vat_rate = coalesce(${set(b.vatRate)}, vat_rate), tax_mode = coalesce(${set(b.taxMode)}, tax_mode), format = coalesce(${set(b.format)}, format), updated_at = now() where id = ${id}`;
    if (b.partialIds) await setPartials(id, b.accountId ?? cur.account_id, b.partialIds);
    ctx.hub.publish('global', 'invoices.changed', { id });
    return { ok: true };
  });

  app.delete('/crm/invoices/:id', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [cur] = await sql<{ status: string }[]>`select status from crm_invoices where id = ${id}`;
    if (!cur) throw notFound();
    if (cur.status !== 'draft') throw badRequest('Festgeschriebene Rechnungen bleiben erhalten (Aufbewahrungspflicht) – bitte stornieren.');
    await sql`delete from crm_invoices where id = ${id}`;
    await audit(sql, u, { action: 'crm.invoice.delete', entityType: 'crm_invoice', entityId: id, summary: 'Rechnungsentwurf gelöscht' });
    ctx.hub.publish('global', 'invoices.changed', { id });
    return { ok: true };
  });

  app.post('/crm/invoices/:id/finalize', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    return finalizeInvoice(ctx, u, id);
  });

  app.post('/crm/invoices/:id/cancel', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().max(300).default('') }), req.body ?? {});
    return cancelInvoice(ctx, u, id, reason);
  });

  /** PDF: festgeschrieben = gespeicherte Datei; Entwurf = Vorschau mit Hinweis */
  app.get('/crm/invoices/:id/pdf', async (req, reply) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const l = await loadInvoice(ctx, id);
    const name = `${l.inv.number ?? 'Entwurf'}_${safeName(l.account.name)}.pdf`;
    if (l.inv.pdf_path) return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${encodeURIComponent(name)}"`).send(await streamToBuffer(storage.read(l.inv.pdf_path)));
    const s = await ctx.settings.get('invoicing');
    const issue = l.inv.invoice_date ?? new Date().toISOString().slice(0, 10);
    const due = l.inv.due_date ?? dueDate(issue, s.dueDays);
    const e = await toEInvoice(ctx, l, 'ENTWURF', issue, due, l.inv.payment_terms || await paymentTermsText(ctx, issue, due));
    const pdf = await renderInvoicePdf(ctx, l, e, null);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Entwurf.pdf"`).send(pdf);
  });

  app.get('/crm/invoices/:id/xml', async (req, reply) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const l = await loadInvoice(ctx, id);
    if (!l.inv.xml_path) throw notFound('Zu dieser Rechnung gibt es keine E-Rechnung (nur PDF oder noch Entwurf).');
    return reply.header('content-type', 'application/xml').header('content-disposition', `attachment; filename="${encodeURIComponent(`${l.inv.number}.xml`)}"`).send(await streamToBuffer(storage.read(l.inv.xml_path)));
  });

  // ------------------------------------------------ Versand
  async function mailTemplate(id: string) {
    const l = await loadInvoice(ctx, id);
    const s = await ctx.settings.get('invoicing');
    const company = await ctx.settings.get('company');
    const fill = (t: string) => t.replace(/\{nummer\}/g, l.inv.number ?? '').replace(/\{betrag\}/g, eur(Number(l.inv.total_gross) - Number(l.inv.prepaid)))
      .replace(/\{faellig\}/g, l.inv.due_date ? new Date(`${l.inv.due_date}T12:00:00`).toLocaleDateString('de-DE') : '').replace(/\{firma\}/g, s.legalName || company.name)
      .replace(/\{kunde\}/g, l.account.name);
    const kind = INVOICE_KIND[l.inv.kind];
    return { l, to: l.account.invoice_email || l.contact?.email || l.account.email, subject: fill(s.mailSubject).replace(/^Rechnung/, kind), text: fill(s.mailText).replace(/unsere Rechnung/, `unsere ${kind}`) };
  }
  invoiceApi.finalizeAndSend = async (u, id) => {
    await finalizeInvoice(ctx, u, id);
    const t = await mailTemplate(id);
    if (!t.to) return { sentTo: null };
    const att = [{ path: t.l.inv.pdf_path!, name: `${t.l.inv.number}.pdf` }];
    if (t.l.inv.format === 'xrechnung' && t.l.inv.xml_path) att.unshift({ path: t.l.inv.xml_path, name: `${t.l.inv.number}.xml` });
    await sendMail(ctx, { to: t.to, subject: t.subject, text: t.text, attachments: att });
    await sql`update crm_invoices set sent_at = now(), sent_to = ${t.to} where id = ${id}`;
    ctx.hub.publish('global', 'invoices.changed', { id });
    return { sentTo: t.to };
  };
  app.get('/crm/invoices/:id/mail', async (req) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const t = await mailTemplate(id);
    if (t.l.inv.status === 'draft') throw badRequest('Bitte die Rechnung zuerst festschreiben.');
    return { to: t.to, subject: t.subject, text: t.text, attachments: [t.l.inv.format === 'xrechnung' ? `${t.l.inv.number}.xml` : null, `${t.l.inv.number}.pdf`].filter(Boolean) };
  });
  app.post('/crm/invoices/:id/send', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ to: z.string().trim().min(3).max(500), cc: z.string().max(500).optional(), subject: z.string().max(300), text: z.string().max(20000) }), req.body);
    const { l } = await mailTemplate(id);
    if (l.inv.status === 'draft') throw badRequest('Bitte die Rechnung zuerst festschreiben.');
    const att = [{ path: l.inv.pdf_path!, name: `${l.inv.number}.pdf` }];
    if (l.inv.format === 'xrechnung' && l.inv.xml_path) att.unshift({ path: l.inv.xml_path, name: `${l.inv.number}.xml` });
    await sendMail(ctx, { to: b.to, cc: b.cc, subject: b.subject, text: b.text, attachments: att });
    await sql`update crm_invoices set sent_at = now(), sent_to = ${b.to} where id = ${id}`;
    await sql`insert into crm_notes (account_id, user_id, body) values (${l.inv.account_id}, ${u.id}, ${`${INVOICE_KIND[l.inv.kind]} ${l.inv.number} per E-Mail an ${b.to} gesendet.`})`;
    await sql`update crm_accounts set last_contact_at = now() where id = ${l.inv.account_id}`;
    await audit(sql, u, { action: 'crm.invoice.send', entityType: 'crm_invoice', entityId: id, summary: `${l.inv.number} an ${b.to} gesendet` });
    ctx.hub.publish('global', 'invoices.changed', { id });
    return { ok: true };
  });

  // ------------------------------------------------ Zahlungen
  app.post('/crm/invoices/:id/payments', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ date: z.string().date(), amount: z.number().refine((x) => x !== 0, 'Betrag darf nicht 0 sein'), method: z.enum(['transfer', 'cash', 'card', 'debit', 'offset']).default('transfer'), note: z.string().max(500).default('') }), req.body);
    const r = await addPayment(ctx, u, id, b);
    await audit(sql, u, { action: 'crm.invoice.payment', entityType: 'crm_invoice', entityId: id, summary: `Zahlung ${eur(b.amount)} gebucht` });
    return r;
  });
  app.delete('/crm/invoices/payments/:id', async (req) => {
    const u = staff(req);
    const { id } = parse(idParam, req.params);
    const [p] = await sql<{ invoice_id: string; amount: string }[]>`delete from crm_invoice_payments where id = ${id} returning invoice_id, amount`;
    if (!p) throw notFound();
    await audit(sql, u, { action: 'crm.invoice.payment.delete', entityType: 'crm_invoice', entityId: p.invoice_id, summary: `Zahlung ${eur(Number(p.amount))} ausgebucht` });
    return recalcPaid(ctx, p.invoice_id);
  });

  // ------------------------------------------------ Übergabe an die Buchhaltung
  async function exportPackage(from: string, to: string) {
    const s = await ctx.settings.get('invoicing');
    const { rows, bookings } = await outgoingInvoiceBookings(ctx, from, to);
    const fy = `${from.slice(0, 4)}-01-01`;
    const datev = datevExtf({ consultantNo: s.datev.consultantNo, clientNo: s.datev.clientNo, fiscalYearStart: fy, accountLength: s.datev.accountLength, from, to, title: `Ausgangsrechnungen ${from.slice(0, 7)}`, bookings });
    const journal = writeXlsx([{ name: 'Rechnungsausgang', widths: [14, 12, 16, 30, 12, 12, 12, 12, 12, 10], rows: [
      ['Rechnungsnr.', 'Datum', 'Art', 'Kunde', 'Kunden-Nr.', 'Netto', 'USt', 'Brutto', 'Status', 'Projekt'],
      ...rows.map((r) => [r.number, r.invoice_date, INVOICE_KIND[r.kind as 'invoice'], r.account_name, r.account_number, Number(r.total_net), Number(r.total_tax), Number(r.total_gross),
        r.status === 'cancelled' ? 'storniert' : r.status === 'paid' ? 'bezahlt' : 'offen', r.project_number ?? '']),
    ] }]);
    const files = [{ name: `EXTF_Buchungsstapel_${from}_${to}.csv`, data: datev }, { name: `Rechnungsausgangsbuch_${from}_${to}.xlsx`, data: journal }];
    for (const r of rows) {
      if (r.pdf_path) files.push({ name: `Rechnungen/${safeName(r.number)}.pdf`, data: await streamToBuffer(storage.read(r.pdf_path)) });
      if (r.xml_path) files.push({ name: `Rechnungen/${safeName(r.number)}.xml`, data: await streamToBuffer(storage.read(r.xml_path)) });
    }
    return { zip: writeZip(files), count: rows.length, ids: rows.map((r) => r.id) };
  }
  const period = z.object({ from: z.string().date(), to: z.string().date() });
  app.get('/crm/invoices/export.zip', async (req, reply) => {
    const u = staff(req);
    const q = parse(period, req.query);
    const p = await exportPackage(q.from, q.to);
    await sql`update crm_invoices set exported_at = now() where id = any(${p.ids}) and exported_at is null`;
    await audit(sql, u, { action: 'crm.invoice.export', entityType: 'crm_invoice', summary: `${p.count} Rechnungen exportiert (${q.from} bis ${q.to})` });
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="Rechnungen_${q.from}_${q.to}.zip"`).send(p.zip);
  });
  app.post('/crm/invoices/send-accounting', async (req) => {
    const u = staff(req);
    const b = parse(period, req.body);
    const s = await ctx.settings.get('invoicing');
    if (!s.accountingEmail) throw badRequest('Bitte unter Einstellungen → Rechnungen die E-Mail-Adresse der Buchhaltung bzw. des Steuerberaters eintragen.');
    const p = await exportPackage(b.from, b.to);
    if (!p.count) throw badRequest('Im Zeitraum gibt es keine festgeschriebenen Rechnungen.');
    const path = `.aperio/invoices/export/Rechnungen_${b.from}_${b.to}_${Date.now()}.zip`;
    await storage.write(path, Readable.from(p.zip));
    const company = await ctx.settings.get('company');
    await sendMail(ctx, { to: s.accountingEmail, subject: `Ausgangsrechnungen ${b.from} bis ${b.to} – ${s.legalName || company.name}`,
      text: `Guten Tag,\n\nanbei die Ausgangsrechnungen vom ${b.from} bis ${b.to} (${p.count} Belege) als PDF und E-Rechnung sowie der DATEV-Buchungsstapel und das Rechnungsausgangsbuch.\n\nMit freundlichen Grüßen\n${u.displayName}`,
      attachments: [{ path, name: `Rechnungen_${b.from}_${b.to}.zip` }] });
    await sql`update crm_invoices set exported_at = now() where id = any(${p.ids}) and exported_at is null`;
    await audit(sql, u, { action: 'crm.invoice.accounting', entityType: 'crm_invoice', summary: `${p.count} Rechnungen an ${s.accountingEmail} übergeben` });
    return { ok: true, count: p.count };
  });

  // Kontrolle: E-Rechnung einer festgeschriebenen Rechnung erneut erzeugen (z. B. zum Vergleich), ohne zu speichern
  app.get('/crm/invoices/:id/xml-preview', async (req, reply) => {
    staff(req);
    const { id } = parse(idParam, req.params);
    const l = await loadInvoice(ctx, id);
    const issue = l.inv.invoice_date ?? new Date().toISOString().slice(0, 10);
    const s = await ctx.settings.get('invoicing');
    const due = l.inv.due_date ?? dueDate(issue, s.dueDays);
    const e = await toEInvoice(ctx, l, l.inv.number ?? 'ENTWURF', issue, due, l.inv.payment_terms || await paymentTermsText(ctx, issue, due));
    return reply.header('content-type', 'application/xml').send(buildCii(e));
  });
}

async function streamToBuffer(s: NodeJS.ReadableStream | Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}
