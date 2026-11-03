/**
 * Hilfen für Tabellenzeilen: Eingaben (camelCase) in Spalten (snake_case) übersetzen.
 * JSON-Spalten werden als JSON übergeben, undefinierte Felder ausgelassen (wichtig für PATCH).
 */
import type { Sql } from '../db';
import type { AuthUser } from './auth';
import { requireUser } from './auth';
import { forbidden } from './errors';

export const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function toRow(sql: Sql, body: Record<string, unknown>, json: string[] = [], rename: Record<string, string> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    row[rename[k] ?? snake(k)] = json.includes(k) ? sql.json(v as never) : v;
  }
  return row;
}

/** Mitarbeiter (keine Gäste) */
export function staffOf(req: Parameters<typeof requireUser>[0]): AuthUser {
  const u = requireUser(req);
  if (u.role === 'guest') throw forbidden();
  return u;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** Gespeicherte Datei ausliefern (PDF und Bilder im Browser anzeigen, sonst herunterladen) */
export function sendStored(reply: { header: (k: string, v: string) => unknown; send: (b: unknown) => unknown }, storage: { read: (p: string) => unknown }, path: string, name: string, download = false) {
  const ext = name.split('.').pop()?.toLowerCase();
  const type = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
  reply.header('content-type', type);
  reply.header('content-disposition', `${download || type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(name)}"`);
  return reply.send(storage.read(path));
}
