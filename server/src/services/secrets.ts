import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AppContext } from '../context';

/**
 * Verschlüsselt kleine Geheimnisse in der Datenbank (Zwei-Faktor-Schlüssel, Postfach-Passwörter, KI-Schlüssel).
 * Der Schlüssel wird einmalig erzeugt und mit den Einstellungen gesichert.
 */
const cache = new WeakMap<object, Buffer>();

async function appKey(ctx: AppContext): Promise<Buffer> {
  const hit = cache.get(ctx.sql);
  if (hit) return hit;
  const [row] = await ctx.sql<{ value: { key: string } }[]>`select value from settings where key = 'appKey'`;
  if (row?.value?.key) { const k = Buffer.from(row.value.key, 'base64'); cache.set(ctx.sql, k); return k; }
  const key = randomBytes(32);
  await ctx.sql`insert into settings (key, value) values ('appKey', ${ctx.sql.json({ key: key.toString('base64') })}) on conflict (key) do nothing`;
  const [again] = await ctx.sql<{ value: { key: string } }[]>`select value from settings where key = 'appKey'`;
  const k = Buffer.from(again!.value.key, 'base64');
  cache.set(ctx.sql, k);
  return k;
}

export async function sealSecret(ctx: AppContext, plain: string): Promise<string> {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', await appKey(ctx), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export async function openSecret(ctx: AppContext, sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null;
  if (!sealed.startsWith('v1:')) return sealed;
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', await appKey(ctx), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
