import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, Client, setup, type TestEnv } from './helpers';
import { readZip, writeZip } from '../src/lib/zip';
import { parseKicadBom } from '../src/services/pcb';

let env: TestEnv;
let admin: Client;
beforeAll(async () => { env = await setup(); admin = await adminClient(env.app); });
afterAll(async () => { await env.close(); });

async function multipart(url: string, files: { field: string; name: string; content: string | Buffer }[], fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append(f.field, new Blob([typeof f.content === 'string' ? f.content : new Uint8Array(f.content)]), f.name);
  const res = new Response(fd);
  const r = await env.app.inject({ method: 'POST', url, payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type')!, cookie: admin.cookie, ...headers } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

const BOM = `"Refs","Value","Footprint","Qty","DNP","Manufacturer","MPN"
"R1,R2,R3","10k","Resistor_SMD:R_0603_1608Metric","3","","Yageo","RC0603FR-0710KL"
"C1","100n","Capacitor_SMD:C_0603_1608Metric","1","","",""
"J1","Conn","Connector:USB_C","1","DNP","",""
`;

describe('Stückliste aus KiCad', () => {
  it('liest deutsche und englische Spalten', () => {
    const rows = parseKicadBom(BOM);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ refs: 'R1,R2,R3', value: '10k', footprint: 'R_0603_1608Metric', qty: 3, manufacturerNo: 'RC0603FR-0710KL', dnp: false });
    expect(rows[2]!.dnp).toBe(true);
    const de = parseKicadBom('Referenz;Wert;Bauform;Menge;Hersteller;Herstellernummer\nU1;STM32;LQFP-48;1;ST;STM32F103C8T6\n');
    expect(de[0]).toMatchObject({ refs: 'U1', manufacturer: 'ST', manufacturerNo: 'STM32F103C8T6', qty: 1 });
  });
});

describe('PCB-Bridge', () => {
  it('Nummer, Einchecken, Freigabe mit Fertigungsdaten, Einkauf und Übernahme als Kaufteil', async () => {
    const p = await admin.post('/api/projects', { name: 'Steuerung' });
    // vom Wächter erkannt → Speichermaske im Browser
    const det = await admin.post('/api/pcb/detected', { host: 'PC-ELEKTRO', path: 'C:/Arbeitsbereich/Steuerplatine', name: 'Steuerplatine' });
    expect(det.url).toMatch(/^\/pcb\?register=/);
    expect((await admin.get('/api/pcb/detected')).map((d: any) => d.id)).toContain(det.id);

    const r = await admin.post('/api/pcb/boards', { projectId: p.id, designation: 'Steuerplatine', properties: { Oberflaeche: 'ENIG (chem. Gold)' }, detectedId: det.id, host: 'PC-ELEKTRO' });
    expect(r.board.number).toBe(`${p.number}-E01`);
    expect(r.board.fullNumber).toBe(`${p.number}-E01-00`);
    expect(r.board.properties).toMatchObject({ Lagen: '2', Dicke: '1,6 mm' });
    expect(r.textVariables.APERIO_NUMMER).toBe(`${p.number}-E01-00`);
    const polled = await admin.get(`/api/pcb/detected/${det.id}`);
    expect(polled.board.id).toBe(r.board.id);
    expect(await admin.get('/api/pcb/detected')).toHaveLength(0);
    const id = r.board.id;

    // Pflichtfeld fehlt
    await admin.req('POST', '/api/pcb/boards', { projectId: p.id, designation: 'X', properties: { Oberflaeche: '' } }, 400);

    // Einchecken mit Stückliste
    const zip = writeZip([{ name: 'Steuerplatine.kicad_pro', data: Buffer.from('{}') }, { name: 'Steuerplatine.kicad_pcb', data: Buffer.from('(kicad_pcb)') }]);
    const ci = await multipart(`/api/pcb/boards/${id}/checkin`, [{ field: 'file', name: 'Steuerplatine.zip', content: zip }, { field: 'bom', name: 'bom.csv', content: BOM }], { comment: 'Erster Entwurf' });
    expect(ci.status).toBe(200);
    expect(ci.body.bomRows).toBe(3);
    expect(ci.body.board.checkedOutBy).toBeNull();
    const detail = await admin.get(`/api/pcb/boards/${id}`);
    expect(detail.bom).toHaveLength(3);
    expect(detail.revisions[0].reason).toBe('Erster Entwurf');

    // Freigabe: Prüfung → freigegeben, Fertigungsaufträge, Einkauf
    await admin.post(`/api/pcb/boards/${id}/state`, { to: 'review' });
    const rel = await admin.post(`/api/pcb/boards/${id}/state`, { to: 'released' });
    expect(rel.purchasing.added).toBe(2); // DNP wird nicht bestellt
    const items = await admin.get(`/api/purchasing/projects/${p.id}/items`);
    const list = Array.isArray(items) ? items : items.items;
    expect(list.filter((i: any) => i.source === 'pcb')).toHaveLength(2);

    const claim = await admin.post('/api/pcb/exports/claim', { worker: 'test' });
    expect(claim.job.exports.map((e: any) => e.format).sort()).toEqual(['bom', 'drill', 'gerber', 'pos', 'schematic', 'step']);
    expect(claim.job.stem).toBe(`${p.number}-E01-00_Steuerplatine`);
    expect((await admin.post('/api/pcb/exports/claim', {})).job).toBeNull();
    const stepJob = claim.job.exports.find((e: any) => e.format === 'step');
    const done = await multipart(`/api/pcb/exports/${stepJob.id}/complete`, [{ field: 'file', name: `${claim.job.stem}.step`, content: 'ISO-10303-21;' }]);
    expect(done.status).toBe(200);
    expect(done.body.path).toContain('/Fertigung/');
    const gerberJob = claim.job.exports.find((e: any) => e.format === 'gerber');
    await admin.post(`/api/pcb/exports/${gerberJob.id}/fail`, { error: 'kicad-cli fehlt' });

    // STEP als Kaufteil in die CAD-Bridge
    const cad = await admin.post(`/api/pcb/boards/${id}/to-cad`, { sub: 400 });
    const item = await admin.get(`/api/cad/items/${cad.cadItemId}`);
    expect(item.procurement).toBe('buy');
    expect(item.number).toMatch(/-400-00-0000-00_Leiterplatte_Steuerplatine$/);
    await admin.req('POST', `/api/pcb/boards/${id}/to-cad`, {}, 400);

    // Neuer Versionsstand
    await admin.req('POST', `/api/pcb/boards/${id}/checkout`, {}, 400);
    const rev = await admin.post(`/api/pcb/boards/${id}/revise`, { reason: 'Bohrbild geändert' });
    expect(rev.fullNumber).toBe(`${p.number}-E01-01`);
    expect(rev.checkedOutBy).toBeTruthy();
    expect((await admin.get(`/api/pcb/boards/${id}`)).bom).toHaveLength(3);
    const second = await admin.post('/api/pcb/boards', { projectId: p.id, designation: 'Anzeige', properties: { Oberflaeche: 'OSP' } });
    expect(second.board.number).toBe(`${p.number}-E02`);
    const resolved = await admin.get(`/api/pcb/resolve?name=${encodeURIComponent(`${p.number}-E02-00_Anzeige`)}`);
    expect(resolved.board.id).toBe(second.board.id);
  });
});

describe('Wächter-Arbeitsplätze und Einrichtung', () => {
  it('meldet sich an, zeigt Version und liefert ein Installationspaket mit Schlüssel', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/bridge/installer', payload: { kind: 'pcb', platform: 'windows' }, headers: { cookie: admin.cookie } });
    expect(r.statusCode).toBe(200);
    const files = readZip(r.rawPayload);
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(['Einrichten.cmd', 'LIESMICH.txt', 'aperioplan-bridge.json', 'einrichten.ps1']);
    const cfg = JSON.parse(files.find((f) => f.name === 'aperioplan-bridge.json')!.data.toString());
    expect(cfg.token).toMatch(/^ap_/);
    expect(cfg.packages['pcb-win']).toBe('/api/bridge/download/AperioPlan-PCB-Bridge-win-x64.zip');
    const ps = files.find((f) => f.name === 'einrichten.ps1')!.data.toString();
    expect(ps).toContain('kicad-cli');
    expect(ps).toContain('${env:ProgramFiles(x86)}');

    // mit dem Schlüssel aus dem Paket meldet sich der Wächter
    const hello = await env.app.inject({ method: 'POST', url: '/api/bridge/hello', payload: { kind: 'pcb', host: 'PC-ELEKTRO', os: 'Windows 11', version: '1.0.0', appVersion: 'KiCad 9.0.2' }, headers: { authorization: `Bearer ${cfg.token}` } });
    expect(hello.statusCode).toBe(200);
    expect(JSON.parse(hello.body)).toMatchObject({ updateAvailable: true });
    const clients = await admin.get('/api/bridge/clients');
    expect(clients[0]).toMatchObject({ kind: 'pcb', host: 'PC-ELEKTRO', appVersion: 'KiCad 9.0.2', online: true, outdated: true });

    const linux = await env.app.inject({ method: 'POST', url: '/api/bridge/installer', payload: { kind: 'pcb', platform: 'linux' }, headers: { cookie: admin.cookie } });
    expect(readZip(linux.rawPayload).map((f) => f.name)).toContain('einrichten.sh');
    const cad = await env.app.inject({ method: 'POST', url: '/api/bridge/installer', payload: { kind: 'cad' }, headers: { cookie: admin.cookie } });
    expect(readZip(cad.rawPayload).find((f) => f.name === 'einrichten.ps1')!.data.toString()).toContain('RegAsm');
    const dl = await env.app.inject({ method: 'GET', url: '/api/bridge/download/AperioPlan-PCB-Bridge-win-x64.zip' });
    expect(dl.statusCode).toBe(302);
    expect(dl.headers.location).toMatch(/github\.com\/.+\/releases\/latest\/download\/AperioPlan-PCB-Bridge-win-x64\.zip$/);
  });
});
