/**
 * Eigene Felder: zusätzliche Eingabefelder für Projekte, Kunden, Kontakte, Lagerartikel, Inventar, Tickets und Service-Einsätze.
 * Administratoren legen die Felder an; alle, die den Datensatz bearbeiten dürfen, füllen sie aus.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { z, parse, idParam, patchSchema } from '../lib/validate';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { audit } from '../services/audit';
import { staffOf, toRow } from '../lib/rows';

export const CF_ENTITIES = ['project', 'crm_account', 'crm_contact', 'article', 'asset', 'ticket', 'service_job'] as const;
type Entity = (typeof CF_ENTITIES)[number];
const TYPES = ['text', 'textarea', 'number', 'money', 'date', 'select', 'multiselect', 'checkbox', 'url', 'user'] as const;
const fieldBody = z.object({
  entity: z.enum(CF_ENTITIES), key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Schlüssel: Kleinbuchstaben, Ziffern und _ (z. B. kostenstelle).').optional(),
  label: z.string().trim().min(1).max(120), type: z.enum(TYPES), options: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  required: z.boolean().default(false), help: z.string().max(300).default(''), sort: z.number().default(0), active: z.boolean().default(true),
});
type FieldRow = { key: string; label: string; type: (typeof TYPES)[number]; options: string[]; required: boolean };

/** Tabelle und benötigtes Werkzeug je Datensatzart */
const TABLES: Record<Entity, { table: string; tool?: string }> = {
  project: { table: 'projects' }, crm_account: { table: 'crm_accounts', tool: 'crm' }, crm_contact: { table: 'crm_contacts', tool: 'crm' },
  article: { table: 'wh_articles', tool: 'warehouse' }, asset: { table: 'inv_assets', tool: 'inventory' }, ticket: { table: 'hd_tickets', tool: 'helpdesk' }, service_job: { table: 'svc_jobs', tool: 'service' },
};

export const slugKey = (label: string) => label.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'feld';

export default async function studioRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;
  const changed = () => ctx.hub.publish('global', 'studio.changed', {});
  const installed = async () => (await ctx.settings.get('apps')).installed.includes('studio');
  const admin = (req: Parameters<typeof staffOf>[0]) => { const u = staffOf(req); if (u.role !== 'admin') throw forbidden('Eigene Felder legen Administratoren an.'); return u; };
  const cols = sql`id, entity, key, label, type, options, required, help, sort, active`;

  /** Datensatz muss existieren und für den Benutzer erreichbar sein */
  async function canAccess(u: AuthUser, entity: Entity, id: string, write: boolean) {
    const t = TABLES[entity];
    if (t.tool && !u.tools.includes(t.tool as never)) throw forbidden();
    if (entity === 'project') { await projectAccess(sql, u, id, write ? 'edit' : 'read'); return; }
    const [row] = await sql`select 1 from ${sql(t.table)} where id = ${id}`;
    if (!row) throw notFound();
  }

  app.get('/custom-fields', async (req) => {
    staffOf(req);
    const q = parse(z.object({ entity: z.enum(CF_ENTITIES).optional(), all: z.string().optional() }), req.query);
    if (!(await installed())) return [];
    return sql`select ${cols} from cf_fields where true ${q.entity ? sql`and entity = ${q.entity}` : sql``} ${q.all === '1' ? sql`` : sql`and active`} order by entity, sort, label`;
  });
  app.post('/custom-fields', async (req) => {
    const u = admin(req);
    const b = parse(fieldBody, req.body);
    if ((b.type === 'select' || b.type === 'multiselect') && !b.options.length) throw badRequest('Bitte Auswahlwerte angeben.');
    const key = b.key ?? slugKey(b.label);
    const [f] = await sql<{ id: string }[]>`insert into cf_fields ${sql(toRow(sql, { ...b, key }, ['options']))} returning id`
      .catch((e: Error) => { throw /unique/.test(e.message) ? badRequest(`Ein Feld mit dem Schlüssel „${key}“ gibt es schon.`) : e; });
    await audit(sql, u, { action: 'studio.field.create', entityType: 'cf_field', entityId: f!.id, summary: `Eigenes Feld „${b.label}“ (${b.entity})` });
    changed();
    return { id: f!.id, key };
  });
  app.patch('/custom-fields/:id', async (req) => {
    admin(req);
    const { id } = parse(idParam, req.params);
    // Datensatzart und Schlüssel bleiben fest, damit gespeicherte Werte zugeordnet bleiben
    const b = parse(patchSchema(fieldBody.omit({ entity: true, key: true })), req.body);
    const row = toRow(sql, b, ['options']);
    if (Object.keys(row).length) await sql`update cf_fields set ${sql(row)} where id = ${id}`;
    changed();
    return { ok: true };
  });
  app.delete('/custom-fields/:id', async (req) => {
    const u = admin(req);
    const { id } = parse(idParam, req.params);
    const [f] = await sql<{ entity: string; key: string; label: string }[]>`delete from cf_fields where id = ${id} returning entity, key, label`;
    if (f) {
      await sql`update cf_values set "values" = "values" - ${f.key} where entity = ${f.entity}`;
      await audit(sql, u, { action: 'studio.field.delete', entityType: 'cf_field', entityId: id, summary: `Eigenes Feld „${f.label}“ samt Werten gelöscht` });
    }
    changed();
    return { ok: true };
  });

  const params = z.object({ entity: z.enum(CF_ENTITIES), id: z.string().uuid() });
  app.get('/custom-values/:entity/:id', async (req) => {
    const u = staffOf(req);
    const p = parse(params, req.params);
    if (!(await installed())) return {};
    await canAccess(u, p.entity, p.id, false);
    const [v] = await sql<{ values: Record<string, unknown> }[]>`select "values" from cf_values where entity = ${p.entity} and entity_id = ${p.id}`;
    return v?.values ?? {};
  });
  app.put('/custom-values/:entity/:id', async (req) => {
    const u = staffOf(req);
    const p = parse(params, req.params);
    if (!(await installed())) throw notFound();
    await canAccess(u, p.entity, p.id, true);
    const input = parse(z.record(z.string(), z.unknown()), req.body);
    const fields = await sql<FieldRow[]>`select key, label, type, options, required from cf_fields where entity = ${p.entity} and active`;
    const [cur] = await sql<{ values: Record<string, unknown> }[]>`select "values" from cf_values where entity = ${p.entity} and entity_id = ${p.id}`;
    const out: Record<string, unknown> = { ...(cur?.values ?? {}) };
    for (const f of fields) {
      if (!(f.key in input)) continue;
      const v = input[f.key];
      if (v === null || v === '' || (Array.isArray(v) && !v.length)) { if (f.required) throw badRequest(`„${f.label}“ ist ein Pflichtfeld.`); delete out[f.key]; continue; }
      switch (f.type) {
        case 'number': case 'money': { const n = Number(v); if (!Number.isFinite(n)) throw badRequest(`„${f.label}“ muss eine Zahl sein.`); out[f.key] = n; break; }
        case 'date': if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`„${f.label}“: ungültiges Datum.`); out[f.key] = v; break;
        case 'checkbox': out[f.key] = Boolean(v); break;
        case 'select': if (!f.options.includes(String(v))) throw badRequest(`„${f.label}“: ungültige Auswahl.`); out[f.key] = String(v); break;
        case 'multiselect': { const arr = (Array.isArray(v) ? v : [v]).map(String); if (arr.some((x) => !f.options.includes(x))) throw badRequest(`„${f.label}“: ungültige Auswahl.`); out[f.key] = arr; break; }
        case 'url': { const s = String(v).trim(); if (!/^https?:\/\/\S+$/i.test(s)) throw badRequest(`„${f.label}“: bitte vollständige Adresse mit https:// angeben.`); out[f.key] = s.slice(0, 1000); break; }
        case 'user': { const s = String(v); if (!(await sql`select 1 from users where id = ${s}::uuid`.catch(() => [])).length) throw badRequest(`„${f.label}“: unbekannte Person.`); out[f.key] = s; break; }
        default: out[f.key] = String(v).slice(0, f.type === 'textarea' ? 20000 : 1000);
      }
    }
    await sql`insert into cf_values (entity, entity_id, "values", updated_by) values (${p.entity}, ${p.id}, ${sql.json(out as never)}, ${u.id})
      on conflict (entity, entity_id) do update set "values" = excluded."values", updated_by = excluded.updated_by, updated_at = now()`;
    return out;
  });
}
