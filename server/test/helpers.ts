import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createDb } from '../src/db';
import type { AppContext } from '../src/context';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://aperio@localhost:5432/aperio_test';

export interface TestEnv {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
}

export async function setup(): Promise<TestEnv> {
  const admin = createDb(TEST_DB);
  await admin.unsafe('drop schema if exists public cascade; create schema public;');
  await admin.end();
  const dir = await mkdtemp(join(tmpdir(), 'aperio-test-'));
  const { app, ctx } = await buildApp({
    logger: false,
    config: { databaseUrl: TEST_DB, storageRoot: join(dir, 'files'), backupDir: join(dir, 'backups'), webDist: join(dir, 'noweb'), isTest: true },
  });
  await app.ready();
  return { app, ctx, close: () => app.close() };
}

/** Client mit Sitzungs-Cookie */
export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}

  async req<T = any>(method: string, url: string, body?: unknown, expect?: number): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      payload: body as object,
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    const set = res.headers['set-cookie'];
    if (set) {
      const c = (Array.isArray(set) ? set : [set]).find((s) => s.startsWith('aperio_session='));
      if (c) this.cookie = c.split(';')[0]!;
    }
    let parsed: any = res.body;
    try { parsed = JSON.parse(res.body); } catch { /* kein JSON */ }
    if (expect !== undefined && res.statusCode !== expect) {
      throw new Error(`${method} ${url}: erwartet ${expect}, erhalten ${res.statusCode}: ${res.body}`);
    }
    return { status: res.statusCode, body: parsed, headers: res.headers };
  }
  get<T = any>(url: string, expect = 200) { return this.req<T>('GET', url, undefined, expect).then((r) => r.body); }
  post<T = any>(url: string, body: unknown = {}, expect = 200) { return this.req<T>('POST', url, body, expect).then((r) => r.body); }
  patch<T = any>(url: string, body: unknown = {}, expect = 200) { return this.req<T>('PATCH', url, body, expect).then((r) => r.body); }
  put<T = any>(url: string, body: unknown = {}, expect = 200) { return this.req<T>('PUT', url, body, expect).then((r) => r.body); }
  del<T = any>(url: string, expect = 200) { return this.req<T>('DELETE', url, undefined, expect).then((r) => r.body); }
}

/** Meldet admin an und setzt ein neues Passwort. */
export async function adminClient(app: FastifyInstance): Promise<Client> {
  const c = new Client(app);
  await c.post('/api/auth/login', { username: 'admin', password: 'admin' });
  await c.post('/api/auth/change-password', { currentPassword: 'admin', newPassword: 'Sicher-123!' });
  return c;
}

export async function userClient(app: FastifyInstance, admin: Client, username: string, role = 'member'): Promise<{ client: Client; id: string }> {
  const { id } = await admin.post('/api/users', { username, displayName: username.toUpperCase(), password: 'Start-12345', role });
  const c = new Client(app);
  await c.post('/api/auth/login', { username, password: 'Start-12345' });
  await c.post('/api/auth/change-password', { currentPassword: 'Start-12345', newPassword: 'Neu-12345678' });
  return { client: c, id };
}

/** Multipart-Upload über app.inject */
export async function uploadFiles(app: FastifyInstance, url: string, files: { name: string; content: string | Buffer }[], cookie = '', headers: Record<string, string> = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('file', new Blob([typeof f.content === 'string' ? f.content : new Uint8Array(f.content)]), f.name);
  const res = new Response(fd);
  const body = Buffer.from(await res.arrayBuffer());
  const r = await app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': res.headers.get('content-type')!, ...(cookie ? { cookie } : {}), ...headers } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}
