import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminClient, Client, setup, userClient, type TestEnv } from './helpers';
import { readXlsx } from '../src/lib/xlsx';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); await admin.post('/api/apps/forms/install', {}); });
afterAll(async () => { await env.close(); });

const anon = async (method: string, url: string, body?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, payload: body as object });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

describe('Formulare', () => {
  it('erstellen, teilen, ausfüllen mit Prüfung, Auswertung und Export', async () => {
    const { id } = await admin.post('/api/forms', { title: 'Sommerfest 2027' });
    const q = { name: randomUUID(), mail: randomUUID(), food: randomUUID(), extras: randomUUID(), score: randomUUID(), sec: randomUUID() };
    await admin.put(`/api/forms/${id}/questions`, { questions: [
      { id: q.sec, type: 'section', text: 'Anmeldung' },
      { id: q.name, type: 'short', text: 'Name', required: true },
      { id: q.mail, type: 'short', text: 'E-Mail', extra: { validation: 'email' } },
      { id: q.food, type: 'single', text: 'Essen', required: true, options: [{ id: 'v', text: 'Vegetarisch' }, { id: 'f', text: 'Fleisch' }], extra: { other: true } },
      { id: q.extras, type: 'multiple', text: 'Mitbringen', options: [{ id: 's', text: 'Salat' }, { id: 'k', text: 'Kuchen' }, { id: 'g', text: 'Getränke' }], extra: { maxSelect: 2 } },
      { id: q.score, type: 'scale', text: 'Vorfreude', extra: { min: 1, max: 5 } },
    ] });
    const { client: lisa, id: lisaId } = await userClient(env.app, admin, 'lisa.forms');
    const { client: max } = await userClient(env.app, admin, 'max.forms');
    await admin.put(`/api/forms/${id}/shares`, { shares: [{ userId: lisaId, permission: 'submit' }, { everyone: true, permission: 'submit' }] });

    expect((await lisa.get('/api/forms?filter=shared')).map((f: any) => f.id)).toContain(id);
    const fill = await lisa.get(`/api/forms/${id}/fill`);
    expect(fill.questions).toHaveLength(6);
    await lisa.req('GET', `/api/forms/${id}/results`, undefined, 403);

    const bad = await lisa.req('POST', `/api/forms/${id}/responses`, { answers: { [q.mail]: 'keine-mail', [q.extras]: ['s', 'k', 'g'] } });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.details).sort()).toEqual([q.extras, q.food, q.mail, q.name].sort());

    await lisa.post(`/api/forms/${id}/responses`, { answers: { [q.name]: 'Lisa', [q.food]: 'v', [q.extras]: ['s', 'k'], [q.score]: '5' } });
    await lisa.req('POST', `/api/forms/${id}/responses`, { answers: { [q.name]: 'Lisa', [q.food]: 'v' } }, 400); // nur einmal
    await max.post(`/api/forms/${id}/responses`, { answers: { [q.name]: 'Max', [`other:${q.food}`]: 'Fisch', [q.score]: '3' } });

    const res = await admin.get(`/api/forms/${id}/results`);
    expect(res.total).toBe(2);
    const food = res.summary.find((s: any) => s.id === q.food);
    expect(food.counts.find((c: any) => c.id === 'v').count).toBe(1);
    expect(food.others).toEqual(['Fisch']);
    expect(res.summary.find((s: any) => s.id === q.score).average).toBe(4);
    expect(res.responses[0].userName).toMatch(/lisa.forms/i);

    const x = await env.app.inject({ method: 'GET', url: `/api/forms/${id}/export?format=xlsx`, headers: { cookie: admin.cookie } });
    const rows = readXlsx(x.rawPayload);
    expect(rows[0]).toEqual(['Nr.', 'Zeitpunkt', 'Person', 'Name', 'E-Mail', 'Essen', 'Mitbringen', 'Vorfreude']);
    expect(rows[1]!.slice(3)).toEqual(['Lisa', '', 'Vegetarisch', 'Salat, Kuchen', '5']);
    expect(rows[2]![5]).toBe('Fisch');

    // Ergebnisse für Teilnehmer freigeben
    await admin.patch(`/api/forms/${id}`, { settings: { showResultsToRespondents: true } });
    expect((await lisa.get(`/api/forms/${id}/results`)).responses).toEqual([]);
    // schließen
    await admin.patch(`/api/forms/${id}`, { settings: { closed: true } });
    expect((await admin.get(`/api/forms/${id}/fill`)).open).toBe(false);
  });

  it('öffentlicher Link mit Datei-Upload, anonym, Kopie', async () => {
    const { id } = await admin.post('/api/forms', { title: 'Lieferantenbewertung' });
    const qf = randomUUID(), qt = randomUUID();
    await admin.put(`/api/forms/${id}/questions`, { questions: [
      { id: qt, type: 'long', text: 'Anmerkungen', required: true },
      { id: qf, type: 'file', text: 'Zertifikat', extra: { maxFiles: 1 } },
    ] });
    const r = await admin.patch(`/api/forms/${id}`, { publicLink: true, settings: { anonymous: true } });
    const token = r.publicUrl.split('/').pop();
    expect((await anon('GET', `/api/form/${token}`)).body.title).toBe('Lieferantenbewertung');

    const fd = new FormData();
    fd.append('file', new Blob(['%PDF-1.4']), 'ISO9001.pdf');
    const resp = new Response(fd);
    const up = await env.app.inject({ method: 'POST', url: `/api/form/${token}/uploads`, payload: Buffer.from(await resp.arrayBuffer()), headers: { 'content-type': resp.headers.get('content-type')! } });
    const files = JSON.parse(up.body);
    expect(files[0].name).toBe('ISO9001.pdf');
    const s = await anon('POST', `/api/form/${token}/responses`, { answers: { [qt]: 'Pünktlich, gute Qualität', [qf]: files } });
    expect(s.body.message).toMatch(/Vielen Dank/);
    expect((await anon('POST', `/api/form/${token}/responses`, { answers: { [qf]: [{ name: 'x', path: '../../etc/passwd', size: 1 }], [qt]: 'x' } })).status).toBe(400);

    const res = await admin.get(`/api/forms/${id}/results`);
    expect(res.anonymous).toBe(true);
    expect(res.responses[0].userName).toBeNull();
    const file = res.summary.find((x: any) => x.id === qf).files[0];
    const dl = await env.app.inject({ method: 'GET', url: `/api/forms/${id}/responses/${file.responseId}/files/${qf}/0`, headers: { cookie: admin.cookie } });
    expect(dl.body).toBe('%PDF-1.4');
    await admin.req('PATCH', `/api/forms/${id}`, { settings: { anonymous: false } }, 400);

    const copy = await admin.post(`/api/forms/${id}/duplicate`, {});
    const c = await admin.get(`/api/forms/${copy.id}`);
    expect(c).toMatchObject({ title: 'Lieferantenbewertung (Kopie)', responses: 0, publicUrl: null });
    expect(c.questions).toHaveLength(2);
    await admin.patch(`/api/forms/${id}`, { publicLink: false });
    expect((await anon('GET', `/api/form/${token}`)).status).toBe(404);
  });
});
