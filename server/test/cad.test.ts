import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, setup, uploadFiles, userClient, type Client, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Client;
let project: any;
const props = { Werkstoff: 'S235JR', Beschaffung: 'Eigenfertigung', Gezeichnet: 'Max' };

beforeAll(async () => {
  env = await setup();
  admin = await adminClient(env.app);
  project = await admin.post('/api/projects', { name: 'Maschine X' });
});
afterAll(async () => { await env.close(); });

async function checkin(id: string, content: string, fields: Record<string, string> = {}, name = 'x.sldprt') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([content]), name);
  const res = new Response(fd);
  const r = await env.app.inject({ method: 'POST', url: `/api/cad/items/${id}/checkin`, payload: Buffer.from(await res.arrayBuffer()),
    headers: { 'content-type': res.headers.get('content-type')!, cookie: admin.cookie } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

describe('CAD-Zentrale / PDM', () => {
  let frame: any, plate: any, asm: any, frameDrawing: any;

  it('vergibt Nummern 0100-100-00-0000-00 und legt Zeichnung an', async () => {
    const prev = await admin.post('/api/cad/numbers/preview', { projectId: project.id, sub: 100, subsub: 0, designation: 'Rahmen' });
    expect(prev.fileStem).toBe('0100-100-00-0000-00_Rahmen');
    await admin.post('/api/cad/items', { projectId: project.id, type: 'part', sub: 100, designation: 'Rahmen', properties: {} }, 400);
    const r = await admin.post('/api/cad/items', { projectId: project.id, type: 'part', sub: 100, designation: 'Rahmen', properties: props, createDrawing: true });
    frame = r.item; frameDrawing = r.drawing;
    expect(frame.number).toBe('0100-100-00-0000-00_Rahmen');
    expect(frame.fileName).toBe('0100-100-00-0000-00_Rahmen.sldprt');
    expect(frameDrawing.fileName).toBe('0100-100-00-0000-00_Rahmen.slddrw');
    expect(frame.filePath).toContain('/01_CAD/');
    expect(frameDrawing.filePath).toContain('/02_Zeichnungen/');
    expect(r.customProperties.Werkstoff).toBe('S235JR');
    expect(r.customProperties.Revision).toBe('00');
    expect(frame.checkedOutBy).toBeTruthy();
    plate = (await admin.post('/api/cad/items', { projectId: project.id, type: 'part', sub: 100, designation: 'Platte', properties: { ...props, Beschaffung: 'Kaufteil' }, procurement: 'buy' })).item;
    expect(plate.number).toBe('0100-100-00-0001-00_Platte');
    asm = (await admin.post('/api/cad/items', { projectId: project.id, type: 'assembly', sub: 100, designation: 'Gestell', properties: props, procurement: 'buy' })).item;
    expect(asm.baseNumber).toBe('0100-100-00-0002');
  });

  it('Auschecken schützt vor Überschreiben', async () => {
    const { client: lisa } = await userClient(env.app, admin, 'lisa');
    const r = await lisa.req('POST', `/api/cad/items/${frame.id}/checkout`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('Gesperrt durch');
    let c = await checkin(frame.id, 'falsch', {}, 'x.sldasm');
    expect(c.status).toBe(400);
    c = await checkin(frame.id, 'RAHMEN-V0', { comment: 'erster Stand' });
    expect(c.status).toBe(200);
    expect(c.body.item.checkedOutBy).toBeNull();
    await checkin(plate.id, 'PLATTE');
  });

  it('Stückliste und Verwendungsnachweis', async () => {
    const c = await checkin(asm.id, 'ASM', { references: JSON.stringify([{ number: '0100-100-00-0000-00_Rahmen.sldprt', quantity: 2 }, { number: '0100-100-00-0001-00_Platte.sldprt', quantity: 4 }, { number: 'DIN912_M8.sldprt', quantity: 8 }]) }, 'g.sldasm');
    expect(c.body.unknownReferences).toEqual(['DIN912_M8.sldprt']);
    const bom = await admin.get(`/api/cad/items/${asm.id}/bom`);
    expect(bom.map((b: any) => [b.position, b.baseNumber, b.quantity])).toEqual([['1', '0100-100-00-0000', 2], ['2', '0100-100-00-0001', 4]]);
    const csv = await admin.req('GET', `/api/cad/items/${asm.id}/bom?format=csv`);
    expect(csv.body).toContain('Rahmen');
    const used = await admin.get(`/api/cad/items/${frame.id}/where-used`);
    expect(used[0].baseNumber).toBe('0100-100-00-0002');
    await admin.del(`/api/cad/items/${frame.id}`, 400);
  });

  it('Freigabe erst nach freigegebener Zeichnung, dann PDF/DXF/STEP-Aufträge', async () => {
    await admin.post(`/api/cad/items/${frame.id}/state`, { to: 'review' });
    const r = await admin.req('POST', `/api/cad/items/${frame.id}/state`, { to: 'released' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Zeichnung');
    await checkin(frameDrawing.id, 'DRW', {}, 'x.slddrw');
    await admin.post(`/api/cad/items/${frameDrawing.id}/state`, { to: 'review' });
    await admin.post(`/api/cad/items/${frameDrawing.id}/state`, { to: 'released' });
    const rel = await admin.post(`/api/cad/items/${frame.id}/state`, { to: 'released' });
    expect(rel.state).toBe('released');
    await admin.post(`/api/cad/items/${frame.id}/checkout`, {}, 400);
    const claim = await admin.post('/api/cad/exports/claim', { worker: 'test' });
    expect(claim.job.format).toBe('pdf');
    expect(claim.job.referencedModel.fileName).toBe('0100-100-00-0000-00_Rahmen.sldprt');
    const done = await uploadFiles(env.app, `/api/cad/exports/${claim.job.id}/complete`, [{ name: 'a.pdf', content: '%PDF' }], admin.cookie);
    expect(done.body.path).toContain('/04_Fertigung/PDF/0100-100-00-0000-00_Rahmen.pdf');
    const jobs = await admin.get('/api/cad/exports');
    expect(jobs.map((j: any) => j.format).sort()).toEqual(['dxf', 'pdf', 'step']);
  });

  it('Neuer Versionsstand 00 → 01 mit Begründung, Historie bleibt abrufbar', async () => {
    await admin.post(`/api/cad/items/${frame.id}/revise`, { reason: '' }, 400);
    const r = await admin.post(`/api/cad/items/${frame.id}/revise`, { reason: 'Bohrungsdurchmesser auf 12mm vergrößert wegen stärkerer Welle' });
    expect(r.number).toBe('0100-100-00-0000-01_Rahmen');
    expect(r.state).toBe('in_work');
    expect(r.drawingState).toBe('in_work');
    await checkin(frame.id, 'RAHMEN-V1', { comment: 'Bohrung 12' });
    const old = await admin.req('GET', `/api/cad/items/${frame.id}/download?revision=0`);
    expect(old.body).toBe('RAHMEN-V0');
    const cur = await admin.req('GET', `/api/cad/items/${frame.id}/download`);
    expect(cur.body).toBe('RAHMEN-V1');
    const detail = await admin.get(`/api/cad/items/${frame.id}`);
    expect(detail.revisions.map((x: any) => x.revision)).toEqual([1, 0]);
    expect(detail.revisions[0].reason).toContain('12mm');
    const resolved = await admin.get('/api/cad/resolve?fileName=' + encodeURIComponent('C:\\PDM\\0100-100-00-0000-01_Rahmen.SLDPRT'));
    expect(resolved.item.id).toBe(frame.id);
  });
});
