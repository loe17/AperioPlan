import type { AppContext } from '../context';
import { parseCsv } from '../lib/xlsx';

export interface BomRow { refs: string; value: string; footprint: string; manufacturer: string; manufacturerNo: string; supplierNo: string; qty: number; dnp: boolean }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöü$]/g, '');
const COLS: Record<keyof Omit<BomRow, 'dnp' | 'qty'> | 'qty' | 'dnp', string[]> = {
  refs: ['refs', 'reference', 'references', 'referenz', 'ref', 'bezeichner'],
  value: ['value', 'wert'],
  footprint: ['footprint', 'bauform', 'gehäuse', 'package'],
  manufacturer: ['manufacturer', 'hersteller', 'mfr', 'manufacturername'],
  manufacturerNo: ['mpn', 'herstellernummer', 'manufacturerpartnumber', 'partnumber', 'mfrpartnumber', 'mfrno'],
  supplierNo: ['bestellnummer', 'suppliernumber', 'lieferantennummer', 'digikey', 'mouser', 'lcsc'],
  qty: ['qty', 'quantity', 'menge', 'anzahl', '$quantity', '${quantity}'],
  dnp: ['dnp', '$dnp', '${dnp}', 'nichtbestücken', 'donotpopulate'],
};

/** Stückliste aus KiCad (kicad-cli sch export bom, CSV) einlesen – Spaltennamen deutsch oder englisch */
export function parseKicadBom(text: string): BomRow[] {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (rows.length < 2) return [];
  const head = rows[0]!.map((h) => norm(h));
  const col = (k: keyof typeof COLS) => head.findIndex((h) => COLS[k].map(norm).includes(h));
  const idx = Object.fromEntries((Object.keys(COLS) as (keyof typeof COLS)[]).map((k) => [k, col(k)])) as Record<keyof typeof COLS, number>;
  if (idx.refs < 0 && idx.value < 0) throw new Error('Die Stückliste braucht mindestens die Spalten „Reference“ oder „Value“');
  const get = (r: string[], k: keyof typeof COLS) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  return rows.slice(1).map((r) => {
    const refs = get(r, 'refs');
    const q = Number(get(r, 'qty').replace(',', '.'));
    const dnpRaw = get(r, 'dnp').toLowerCase();
    return {
      refs, value: get(r, 'value'), footprint: get(r, 'footprint').replace(/^[^:]+:/, ''),
      manufacturer: get(r, 'manufacturer'), manufacturerNo: get(r, 'manufacturerNo'), supplierNo: get(r, 'supplierNo'),
      qty: Number.isFinite(q) && q > 0 ? Math.round(q) : Math.max(1, refs.split(/[,\s]+/).filter(Boolean).length),
      dnp: ['dnp', 'yes', 'ja', 'x', '1', 'true'].includes(dnpRaw),
    };
  }).filter((r) => r.refs || r.value);
}

/** Schlüssel, der eine Bauteil-Position über Versionsstände hinweg wiedererkennt */
export const bomKey = (r: { value: string; footprint: string; manufacturerNo: string }) => (r.manufacturerNo ? `mpn:${r.manufacturerNo}` : `vf:${r.value}|${r.footprint}`).toLowerCase();

/**
 * Bauteile einer Leiterplatte in den Einkauf übernehmen. Menge = Bauteile je Platte × Plattenzahl (Eigenschaft „Stueckzahl“, sonst 1).
 * Bereits bestellte Positionen werden nicht verändert, sondern bekommen bei höherem Bedarf einen Hinweis.
 */
export async function syncFromPcb(ctx: AppContext, boardId: string, userId: string | null) {
  const { sql } = ctx;
  const [b] = await sql<{ project_id: string; number: string; revision: number; properties: Record<string, string> }[]>`select project_id, number, revision, properties from pcb_boards where id = ${boardId}`;
  if (!b) return { added: 0, updated: 0 };
  const boards = Math.max(1, Number(b.properties?.Stueckzahl) || 1);
  const rows = await sql<{ refs: string; value: string; footprint: string; manufacturer: string; manufacturer_no: string; supplier_no: string; qty: number }[]>`
    select refs, value, footprint, manufacturer, manufacturer_no, supplier_no, qty from pcb_bom where board_id = ${boardId} and revision = ${b.revision} and not dnp order by sort`;
  let added = 0, updated = 0;
  for (const r of rows) {
    const key = bomKey({ value: r.value, footprint: r.footprint, manufacturerNo: r.manufacturer_no });
    const qty = r.qty * boards;
    const designation = [r.value, r.footprint].filter(Boolean).join(' · ') || r.refs;
    const [cur] = await sql<{ id: string; status: string; qty: string }[]>`select id, status, qty from purchase_items where pcb_board_id = ${boardId} and pcb_key = ${key} and status <> 'cancelled'`;
    if (!cur) {
      await sql`insert into purchase_items (project_id, source, pcb_board_id, pcb_key, number, designation, manufacturer, manufacturer_no, supplier_order_no, qty, note, created_by, sort)
        values (${b.project_id}, 'pcb', ${boardId}, ${key}, ${b.number}, ${designation}, ${r.manufacturer}, ${r.manufacturer_no}, ${r.supplier_no}, ${qty}, ${r.refs}, ${userId}, ${Date.now() / 1000})`;
      added++;
    } else if (cur.status === 'open' && Number(cur.qty) !== qty) {
      await sql`update purchase_items set qty = ${qty}, note = ${r.refs}, updated_at = now() where id = ${cur.id}`;
      updated++;
    } else if (cur.status !== 'open' && Number(cur.qty) < qty) {
      await sql`update purchase_items set note = trim(note || ${`\nBedarf laut Stückliste jetzt ${qty} (bestellt ${Number(cur.qty)})`}), updated_at = now() where id = ${cur.id}`;
      updated++;
    }
  }
  if (added || updated) ctx.hub.publish(`project:${b.project_id}`, 'purchasing.changed', {});
  return { added, updated };
}
