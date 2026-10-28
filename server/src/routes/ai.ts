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
import type { AiKind, AiProvider, AiSettings } from '../services/settings';

interface Msg { role: 'system' | 'user' | 'assistant'; content: string }

export const AI_KINDS: { kind: AiKind; name: string; baseUrl: string; online: boolean; models: string[] }[] = [
  { kind: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', online: true, models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  { kind: 'openai', name: 'OpenAI (ChatGPT)', baseUrl: 'https://api.openai.com/v1', online: true, models: ['gpt-4.1-mini', 'gpt-4.1'] },
  { kind: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', online: true, models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
  { kind: 'mistral', name: 'Mistral (Europa)', baseUrl: 'https://api.mistral.ai/v1', online: true, models: ['mistral-large-latest', 'mistral-small-latest'] },
  { kind: 'azure', name: 'Microsoft Azure OpenAI', baseUrl: 'https://IHR-NAME.openai.azure.com', online: true, models: [] },
  { kind: 'ollama', name: 'Eigenes Modell (Ollama, LM Studio, vLLM)', baseUrl: 'http://localhost:11434/v1', online: false, models: ['llama3.1', 'qwen2.5'] },
];

/** Anbieter aus den Einstellungen (auch die frühere Einzel-Einstellung) */
export function providersOf(s: AiSettings): AiProvider[] {
  if (!s.enabled) return [];
  if (s.providers?.length) return s.providers;
  return [{ id: 'standard', name: s.provider === 'anthropic' ? 'Anthropic' : 'KI', kind: s.provider === 'anthropic' ? 'anthropic' : 'ollama', baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, online: s.provider === 'anthropic' }];
}

export function pickProvider(s: AiSettings, id?: string | null): AiProvider {
  const list = providersOf(s);
  const p = (id && list.find((x) => x.id === id)) || list.find((x) => x.id === s.defaultProviderId) || list[0];
  if (!p) throw badRequest('Die KI-Anbindung ist nicht eingerichtet');
  return p;
}

const fail = async (res: Response) => { const j = await res.json().catch(() => ({})); return new HttpError(502, `KI-Dienst: ${j.error?.message ?? j[0]?.error?.message ?? res.statusText}`); };

export async function callAi(p: AiProvider, messages: Msg[]): Promise<string> {
  const base = (p.baseUrl || AI_KINDS.find((k) => k.kind === p.kind)!.baseUrl).replace(/\/$/, '');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const chat = messages.filter((m) => m.role !== 'system');
  const signal = AbortSignal.timeout(120_000);
  if (p.kind === 'anthropic') {
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: p.model, max_tokens: 2048, system, messages: chat }) });
    if (!res.ok) throw await fail(res);
    const j = await res.json();
    return (j.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
  }
  if (p.kind === 'gemini') {
    const res = await fetch(`${base}/models/${encodeURIComponent(p.model)}:generateContent`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': p.apiKey },
      body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: chat.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { temperature: 0.3 } }) });
    if (!res.ok) throw await fail(res);
    const j = await res.json();
    return (j.candidates?.[0]?.content?.parts ?? []).map((x: { text?: string }) => x.text ?? '').join('');
  }
  const url = p.kind === 'azure'
    ? `${base}/openai/deployments/${encodeURIComponent(p.deployment || p.model)}/chat/completions?api-version=${encodeURIComponent(p.apiVersion || '2024-10-21')}`
    : `${base}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (p.kind === 'azure') headers['api-key'] = p.apiKey; else if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  const res = await fetch(url, { method: 'POST', signal, headers, body: JSON.stringify({ model: p.model, messages, temperature: 0.3 }) });
  if (!res.ok) throw await fail(res);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}

/** verfügbare Modelle des Anbieters (zur Auswahl in den Einstellungen) */
export async function listModels(p: AiProvider): Promise<string[]> {
  const base = (p.baseUrl || AI_KINDS.find((k) => k.kind === p.kind)!.baseUrl).replace(/\/$/, '');
  const signal = AbortSignal.timeout(15_000);
  if (p.kind === 'azure') return p.deployment ? [p.deployment] : [];
  if (p.kind === 'gemini') {
    const res = await fetch(`${base}/models?pageSize=200`, { signal, headers: { 'x-goog-api-key': p.apiKey } });
    if (!res.ok) throw await fail(res);
    const j = await res.json();
    return (j.models ?? []).filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes('generateContent')).map((m: { name: string }) => m.name.replace(/^models\//, ''));
  }
  const res = await fetch(p.kind === 'anthropic' ? `${base}/v1/models` : `${base}/models`, { signal,
    headers: p.kind === 'anthropic' ? { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' } : p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {} });
  if (!res.ok) throw await fail(res);
  const j = await res.json();
  return (j.data ?? j.models ?? []).map((m: { id?: string; name?: string }) => m.id ?? m.name ?? '').filter(Boolean).sort();
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
      providerId: z.string().optional(),
    }), req.body);
    const s = await ctx.settings.get('ai');
    // Projekt kann einen eigenen Anbieter haben (z. B. lokales Modell für vertrauliche Projekte)
    const projectProvider = b.projectId ? (await sql<{ ai_provider_id: string | null }[]>`select ai_provider_id from projects where id = ${b.projectId}`)[0]?.ai_provider_id : null;
    const provider = pickProvider(s, b.providerId ?? projectProvider);
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
    return { answer: await callAi(provider, messages), provider: { id: provider.id, name: provider.name, online: provider.online } };
  });

  /** Anbieter (wie im Formular) mit dem gespeicherten Schlüssel ergänzen */
  async function withKey(p: AiProvider): Promise<AiProvider> {
    if (p.apiKey !== '••••••••') return p;
    const s = await ctx.settings.get('ai');
    return { ...p, apiKey: s.providers.find((x) => x.id === p.id)?.apiKey ?? '' };
  }
  const providerBody = z.object({ id: z.string(), name: z.string().default(''), kind: z.enum(['gemini', 'openai', 'anthropic', 'mistral', 'azure', 'ollama']), baseUrl: z.string().default(''),
    apiKey: z.string().default(''), model: z.string().default(''), deployment: z.string().optional(), apiVersion: z.string().optional(), online: z.boolean().default(true) });

  app.get('/settings/ai/kinds', async (req) => { requireRole(req, 'admin'); return AI_KINDS; });

  app.post('/settings/ai/test', async (req) => {
    requireRole(req, 'admin');
    const p = await withKey(parse(providerBody, req.body));
    try { return { ok: true, message: (await callAi(p, [{ role: 'user', content: 'Antworte nur mit: Verbindung ok' }])).slice(0, 200) }; }
    catch (e) { return { ok: false, message: (e as Error).message }; }
  });

  app.post('/settings/ai/models', async (req) => {
    requireRole(req, 'admin');
    const p = await withKey(parse(providerBody, req.body));
    try { return { ok: true, models: await listModels(p) }; } catch (e) { return { ok: false, models: [], message: (e as Error).message }; }
  });

  /** Für die Auswahl im KI-Fenster: welche Anbieter gibt es (ohne Schlüssel) */
  app.get('/ai/providers', async (req) => {
    requireUser(req);
    const s = await ctx.settings.get('ai');
    return providersOf(s).map((p) => ({ id: p.id, name: p.name, kind: p.kind, model: p.model, online: p.online, isDefault: p.id === (s.defaultProviderId ?? providersOf(s)[0]?.id) }));
  });
}
