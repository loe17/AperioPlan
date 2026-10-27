/**
 * KI-Anbindung per API (Kapitel 13): lokale Modelle (Ollama, LM Studio, vLLM – OpenAI-kompatibel)
 * oder externe Anbieter. Zusammenfassen von Projekten, Schreibhilfe, Dokumentenanalyse.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireRole, requireUser, type AuthUser } from '../lib/auth';
import { projectAccess } from '../lib/access';
import { badRequest, HttpError } from '../lib/errors';
import type { AiSettings } from '../services/settings';

interface Msg { role: 'system' | 'user' | 'assistant'; content: string }

export async function callAi(s: AiSettings, messages: Msg[]): Promise<string> {
  if (!s.enabled) throw badRequest('Die KI-Anbindung ist nicht eingerichtet');
  const base = s.baseUrl.replace(/\/$/, '');
  if (s.provider === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const res = await fetch(`${base || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json', 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: s.model, max_tokens: 2048, system, messages: messages.filter((m) => m.role !== 'system') }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `KI-Dienst: ${j.error?.message ?? res.statusText}`);
    return (j.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/json', ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}) },
    body: JSON.stringify({ model: s.model, messages, temperature: 0.3 }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `KI-Dienst: ${j.error?.message ?? res.statusText}`);
  return j.choices?.[0]?.message?.content ?? '';
}

const TEXT_EXT = /\.(txt|md|csv|json|xml|log|ini|cfg|yaml|yml|html?)$/i;

export default async function aiRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql, storage } = ctx;

  async function projectContext(u: AuthUser, projectId: string) {
    const p = await projectAccess(sql, u, projectId);
    const [info] = await sql`select number, name, description, customer, status, start_date, due_date, report from projects where id = ${projectId}`;
    const tasks = await sql`select number, title, status, priority, due_date, (select display_name from users where id = assignee_id) as assignee from tasks where project_id = ${projectId} order by number limit 200`;
    const log = await sql`select at, user_name, summary from audit_log where project_id = ${projectId} order by id desc limit 40`;
    const cad = await sql`select base_number, revision, designation, state from cad_items where project_id = ${projectId} and type <> 'drawing' order by base_number limit 100`;
    return `Projekt ${p.number} „${info!.name}“ (Status ${info!.status}, Kunde ${info!.customer || '–'}, ${info!.start_date ?? '?'} bis ${info!.due_date ?? '?'})
Beschreibung: ${info!.description || '–'}
Aufgaben:\n${tasks.map((t) => `- P${t.number} [${t.status}${t.priority !== 'normal' ? ', ' + t.priority : ''}] ${t.title}${t.assignee ? ' (' + t.assignee + ')' : ''}${t.due_date ? ' fällig ' + t.due_date : ''}`).join('\n') || '–'}
CAD-Teile:\n${cad.map((c) => `- ${c.base_number}-${String(c.revision).padStart(2, '0')} ${c.designation} (${c.state})`).join('\n') || '–'}
Letzte Änderungen:\n${log.map((l) => `- ${new Date(l.at).toISOString().slice(0, 16)} ${l.user_name}: ${l.summary}`).join('\n')}`;
  }

  app.post('/ai/chat', async (req) => {
    const u = requireUser(req);
    if (u.role === 'guest') throw badRequest('Nicht verfügbar');
    const b = parse(z.object({
      mode: z.enum(['summarize', 'write', 'analyze', 'free']).default('free'),
      prompt: z.string().max(20000).default(''),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).default([]),
      projectId: z.string().uuid().optional(),
      fileId: z.string().uuid().optional(),
      text: z.string().max(50000).optional(),
    }), req.body);
    const s = await ctx.settings.get('ai');
    const system: string[] = ['Du bist der Assistent der Projektverwaltung AperioPlan in einem Industrie- bzw. Ingenieurunternehmen. Antworte auf Deutsch, sachlich, klar und ohne Fachchinesisch, sofern der Nutzer nicht anders schreibt.'];
    if (b.projectId) system.push('Kontext:\n' + (await projectContext(u, b.projectId)));
    if (b.fileId) {
      const [f] = await sql<{ path: string; name: string; project_id: string | null; size: number }[]>`select path, name, project_id, size::float as size from files where id = ${b.fileId}`;
      if (!f) throw badRequest('Datei nicht gefunden');
      if (f.project_id) await projectAccess(sql, u, f.project_id);
      if (!TEXT_EXT.test(f.name)) throw badRequest('Für die Analyse werden Textdateien unterstützt (txt, md, csv, json, xml, html)');
      const chunks: Buffer[] = [];
      for await (const c of storage.read(f.path)) { chunks.push(c as Buffer); if (chunks.reduce((n, x) => n + x.length, 0) > 60000) break; }
      system.push(`Dokument „${f.name}“:\n${Buffer.concat(chunks).toString('utf8').slice(0, 60000)}`);
    }
    if (b.text) system.push(`Text:\n${b.text}`);
    const task = {
      summarize: 'Fasse den Stand kompakt zusammen: Fortschritt, Risiken/überfällige Punkte, nächste Schritte.',
      write: 'Hilf beim Formulieren. Liefere einen fertigen, gut lesbaren Text.',
      analyze: 'Analysiere das Dokument: Kernaussagen, Auffälligkeiten, offene Fragen.',
      free: '',
    }[b.mode];
    const messages: Msg[] = [{ role: 'system', content: system.join('\n\n') }, ...b.history, { role: 'user', content: [task, b.prompt].filter(Boolean).join('\n\n') || 'Bitte zusammenfassen.' }];
    return { answer: await callAi(s, messages) };
  });

  app.post('/settings/ai/test', async (req) => {
    requireRole(req, 'admin');
    const s = await ctx.settings.mergeSecrets('ai', { ...(await ctx.settings.get('ai')), ...(req.body as object), enabled: true });
    try { return { ok: true, message: (await callAi(s, [{ role: 'user', content: 'Antworte nur mit: Verbindung ok' }])).slice(0, 200) }; }
    catch (e) { return { ok: false, message: (e as Error).message }; }
  });
}
