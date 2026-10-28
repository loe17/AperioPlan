import {
  buildCadNumber, cadBaseNumber, cadFileName, CAD_TRANSITIONS, formatCadNumber, pad, sanitizeName,
  type CadFileType, type CadNumber, type CadState, type MaskField,
} from '@aperio/shared';
import type { AppContext } from '../context';
import type { Db } from '../db';
import { badRequest } from '../lib/errors';

export interface CadItemRow {
  id: string; project_id: string; type: CadFileType; base_number: string; main: string; sub: string; subsub: string; part: number;
  revision: number; designation: string; state: CadState; procurement: string; properties: Record<string, string>;
  drawing_of: string | null; file_path: string | null; checked_out_by: string | null; checked_out_at: Date | null; checkout_host: string | null;
}

export const toCadNumber = (r: Pick<CadItemRow, 'main' | 'sub' | 'subsub' | 'part' | 'revision' | 'designation'>): CadNumber => ({
  main: r.main, sub: r.sub, subsub: r.subsub, part: pad(r.part, 4), revision: pad(r.revision, 2), designation: r.designation,
});

export const fullNumber = (r: Parameters<typeof toCadNumber>[0]) => formatCadNumber(toCadNumber(r));
export const fileNameOf = (r: CadItemRow) => cadFileName(toCadNumber(r), r.type);

/** Ordner der CAD-Dateien im Projekt: 3D-Daten in 01_CAD, Zeichnungen in 02_Zeichnungen, Ableitungen in 04_Fertigung */
export async function cadFolders(ctx: AppContext, folderPath: string) {
  const s = await ctx.settings.get('storage');
  const f = s.projectFolders.filter((x) => !x.includes('/'));
  const pick = (prefix: string, fallback: string) => f.find((x) => x.toLowerCase().includes(prefix)) ?? fallback;
  return {
    model: `${folderPath}/${pick('cad', '01_CAD')}`,
    drawing: `${folderPath}/${pick('zeichnung', '02_Zeichnungen')}`,
    production: `${folderPath}/${pick('fertigung', '04_Fertigung')}`,
  };
}

/** Nächste freie Teilenummer in einer (Unter-)Baugruppe. Teile und Zeichnungen teilen sich die Nummer. */
export async function nextPart(tx: Db, main: string, sub: string, subsub: string): Promise<number> {
  const [r] = await tx<{ n: number | null }[]>`select max(part) as n from cad_items where main = ${main} and sub = ${sub} and subsub = ${subsub} and type <> 'drawing'`;
  return r?.n == null ? 0 : r.n + 1;
}

export function validateMask(fields: MaskField[], type: CadFileType, props: Record<string, string>) {
  const missing = fields.filter((f) => f.required && (!f.appliesTo || f.appliesTo.includes(type)) && !String(props[f.key] ?? '').trim());
  if (missing.length) throw badRequest(`Pflichtfelder fehlen: ${missing.map((m) => m.label).join(', ')}`);
}

/** Eigenschaften, die der CAD-Wächter als Custom Properties in die Datei bzw. den Schriftkopf schreibt */
export function customProperties(r: CadItemRow, extra: { projectNumber: string; projectName: string; drawnBy?: string }) {
  return {
    ...r.properties,
    Nummer: fullNumber({ ...r, designation: '' }).replace(/_$/, ''),
    Teilenummer: r.base_number,
    Revision: pad(r.revision, 2),
    Benennung: r.designation,
    Status: { in_work: 'In Arbeit', review: 'Prüfung', released: 'Freigegeben', obsolete: 'Ungültig' }[r.state],
    Projekt: extra.projectNumber,
    Projektname: extra.projectName,
    Beschaffungsart: { make: 'Eigenfertigung', buy: 'Kaufteil', standard: 'Normteil' }[r.procurement as 'make'] ?? r.procurement,
  };
}

export function checkTransition(from: CadState, to: CadState) {
  if (!CAD_TRANSITIONS[from].includes(to)) throw badRequest(`Statuswechsel ${from} → ${to} ist nicht erlaubt`);
}

export function buildNumber(projectNumber: string, sub: number, subsub: number, part: number, designation: string) {
  const n = buildCadNumber({ projectNumber, sub, subsub, part, designation });
  return { n, base: cadBaseNumber(n), fileStem: formatCadNumber(n) };
}

export const sanitize = sanitizeName;
