/**
 * Lagerbuchungen: jede Bewegung ändert den Bestand je Lagerort und Charge/Seriennummer in einer Transaktion.
 * Bestände können nicht negativ werden; Seriennummern sind eindeutig und haben immer die Menge 1.
 */
import type { Sql } from '../db';
import type { AuthUser } from '../lib/auth';
import { badRequest, notFound } from '../lib/errors';

export type MoveKind = 'receipt' | 'issue' | 'transfer' | 'adjust' | 'return';
export interface MoveInput {
  kind: MoveKind; articleId: string; qty: number; fromLocationId?: string | null; toLocationId?: string | null; lot?: string;
  projectId?: string | null; purchaseItemId?: string | null; countId?: string | null; note?: string; unitPrice?: number | null;
}

const fmt = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 3 });

export async function bookMove(sql: Sql, u: AuthUser | null, m: MoveInput): Promise<string> {
  if (!(m.qty > 0)) throw badRequest('Die Menge muss größer als 0 sein.');
  const lot = (m.lot ?? '').trim();
  return sql.begin(async (tx) => {
    const [a] = await tx<{ id: string; name: string; tracking: string; purchase_price: string | null; unit: string }[]>`
      select id, name, tracking, purchase_price, unit from wh_articles where id = ${m.articleId} for update`;
    if (!a) throw notFound('Artikel nicht gefunden');
    const needsFrom = m.kind === 'issue' || m.kind === 'transfer' || (m.kind === 'adjust' && !m.toLocationId);
    const needsTo = m.kind === 'receipt' || m.kind === 'transfer' || m.kind === 'return' || (m.kind === 'adjust' && !m.fromLocationId);
    if (needsFrom && !m.fromLocationId) throw badRequest('Bitte den Lagerort angeben, aus dem entnommen wird.');
    if (needsTo && !m.toLocationId) throw badRequest('Bitte den Lagerort angeben, in den gebucht wird.');
    if (m.kind === 'transfer' && m.fromLocationId === m.toLocationId) throw badRequest('Ziel und Herkunft sind gleich.');
    if (a.tracking !== 'none' && !lot) throw badRequest(a.tracking === 'serial' ? 'Bitte die Seriennummer angeben.' : 'Bitte die Charge angeben.');
    if (a.tracking === 'serial' && m.qty !== 1) throw badRequest('Bei Seriennummern wird jedes Stück einzeln gebucht (Menge 1).');
    if (a.tracking === 'serial' && (m.kind === 'receipt' || (m.kind === 'adjust' && !m.fromLocationId))) {
      const [dup] = await tx`select 1 from wh_stock where article_id = ${a.id} and lot = ${lot} and qty > 0`;
      if (dup) throw badRequest(`Die Seriennummer ${lot} ist bereits im Lager.`);
    }
    for (const loc of [m.fromLocationId, m.toLocationId]) {
      if (!loc) continue;
      const [l] = await tx<{ active: boolean }[]>`select active from wh_locations where id = ${loc}`;
      if (!l) throw notFound('Lagerort nicht gefunden');
      if (!l.active && loc === m.toLocationId) throw badRequest('Dieser Lagerort ist stillgelegt.');
    }
    if (needsFrom) {
      const [s] = await tx<{ qty: string }[]>`select qty from wh_stock where article_id = ${a.id} and location_id = ${m.fromLocationId!} and lot = ${lot} for update`;
      const have = Number(s?.qty ?? 0);
      if (have + 1e-9 < m.qty) throw badRequest(`Nicht genug Bestand von „${a.name}“${lot ? ` (${lot})` : ''} an diesem Ort: vorhanden ${fmt(have)} ${a.unit}, benötigt ${fmt(m.qty)} ${a.unit}.`);
      await tx`update wh_stock set qty = qty - ${m.qty} where article_id = ${a.id} and location_id = ${m.fromLocationId!} and lot = ${lot}`;
      await tx`delete from wh_stock where article_id = ${a.id} and location_id = ${m.fromLocationId!} and lot = ${lot} and qty <= 0`;
    }
    if (needsTo) {
      await tx`insert into wh_stock (article_id, location_id, lot, qty) values (${a.id}, ${m.toLocationId!}, ${lot}, ${m.qty})
        on conflict (article_id, location_id, lot) do update set qty = wh_stock.qty + excluded.qty`;
    }
    const price = m.unitPrice ?? (a.purchase_price === null ? null : Number(a.purchase_price));
    const [mv] = await tx<{ id: string }[]>`insert into wh_moves (article_id, kind, qty, from_location_id, to_location_id, lot, project_id, purchase_item_id, count_id, unit_price, note, user_id)
      values (${a.id}, ${m.kind}, ${m.qty}, ${needsFrom ? m.fromLocationId! : null}, ${needsTo ? m.toLocationId! : null}, ${lot}, ${m.projectId ?? null},
        ${m.purchaseItemId ?? null}, ${m.countId ?? null}, ${price}, ${m.note ?? ''}, ${u?.id ?? null}) returning id`;
    await tx`update wh_articles set updated_at = now() where id = ${a.id}`;
    return mv!.id;
  });
}

/** Alle Lagerorte unterhalb (einschließlich) eines Ortes */
export async function locationSubtree(sql: Sql, id: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`with recursive sub as (select id from wh_locations where id = ${id}
    union all select l.id from wh_locations l join sub on l.parent_id = sub.id) select id from sub`;
  return rows.map((r) => r.id);
}
