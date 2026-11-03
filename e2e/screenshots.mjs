/**
 * Erzeugt die Bildschirmfotos für README und Handbücher – reproduzierbar mit erfundenen Beispieldaten.
 *
 *   BASE_URL=http://localhost:3000 node e2e/screenshots.mjs
 *
 * Erwartet eine FRISCH installierte, leere Instanz (Erstzugang admin/admin), legt dort
 * Beispieldaten an („Muster Maschinenbau GmbH“) und speichert die Bilder in docs/screenshots/.
 * Benötigt Playwright (npm i -g playwright && npx playwright install chromium).
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = process.env.OUT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
const ADMIN_PW = 'Demo-Passwort-2026!';
const USER_PW = 'Demo-Kollege-2026!';
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ Hilfen für die Schnittstelle
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (r.status === 429) { // Schutz vor zu vielen Anmeldeversuchen – kurz warten
    const wait = Number((await r.text()).match(/(\d+) second/)?.[1] ?? 30);
    console.log(`  (warte ${wait} s wegen Anmeldeschutz)`);
    await new Promise((res) => setTimeout(res, (wait + 1) * 1000));
    return login(username, password);
  }
  if (!r.ok) throw new Error(`Anmeldung ${username}: ${r.status} ${await r.text()}`);
  return r.headers.get('set-cookie').split(';')[0];
}
function client(cookie) {
  const call = async (method, url, body) => {
    const isForm = body instanceof FormData;
    const r = await fetch(`${BASE}/api${url}`, {
      method, headers: { cookie, ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  };
  return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b = {}) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b) };
}
const day = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const at = (n, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + n); x.setHours(h, m, 0, 0); return x.toISOString(); };
/** nächster Werktag ab heute + n */
const workday = (n) => { let k = n; for (;;) { const x = new Date(); x.setDate(x.getDate() + k); if (x.getDay() % 6) return k; k++; } };

// ------------------------------------------------------------ Beispieldaten
console.log('Beispieldaten werden angelegt ...');
let admin = client(await login('admin', 'admin'));
await admin.post('/auth/change-password', { currentPassword: 'admin', newPassword: ADMIN_PW });
admin = client(await login('admin', ADMIN_PW));
await admin.patch('/me', { displayName: 'Max Mustermann' });
await admin.post('/me/onboarding', {});
await admin.put('/settings/company', { name: 'Muster Maschinenbau GmbH', logoText: 'AperioPlan' });
// Neue Installationen haben nur Chat und E-Mail – die gezeigten Apps aus dem App-Store installieren
for (const a of ['calendar', 'resources', 'time', 'absences', 'notes', 'kvp', 'cad', 'crm', 'purchasing', 'calculation', 'warehouse', 'inventory',
  'service', 'helpdesk', 'planning', 'fleet', 'approvals', 'esign', 'bi', 'sustainability', 'expenses']) await admin.post(`/apps/${a}/install`, {});

const kon = await admin.post('/teams', { name: 'Konstruktion', icon: 'gear:#4f46e5' });
const ele = await admin.post('/teams', { name: 'Elektrotechnik', icon: 'bolt:#c98a12' });
const ein = await admin.post('/teams', { name: 'Einkauf', icon: 'box:#0ea5e9' });
const mkUser = async (username, displayName, teamIds) => {
  const u = await admin.post('/users', { username, displayName, password: 'Start-Passwort-1', teamIds, departmentId: teamIds[0] });
  await client(await login(username, 'Start-Passwort-1')).post('/auth/change-password', { currentPassword: 'Start-Passwort-1', newPassword: USER_PW });
  const api = client(await login(username, USER_PW));
  await api.post('/me/onboarding', {});
  return { ...u, api };
};
const lisa = await mkUser('lisa', 'Lisa Berger', [kon.id]);
const tom = await mkUser('tom', 'Tom Keller', [ele.id]);
const sara = await mkUser('sara', 'Sara Yilmaz', [ein.id]);
const me = await admin.get('/auth/me');
await admin.put(`/teams/${kon.id}/members`, { members: [{ userId: me.id, isLead: true }, { userId: lisa.id }] });

const p = await admin.post('/projects', { name: 'Verpackungsmaschine VM-4', icon: 'factory:#4f46e5', teamId: kon.id, customer: 'Beispiel Foods AG', startDate: day(-26), dueDate: day(52), description: 'Kartonverpackungsmaschine mit Zuführung, Faltstation und Steuerungsschrank.' });
await admin.post('/projects', { name: 'Zuführung', icon: 'truck:#0ea5e9', parentId: p.id, teamId: kon.id });
await admin.post('/projects', { name: 'Steuerungsschrank', icon: 'bolt:#c98a12', parentId: p.id, teamId: ele.id });
await admin.post('/projects', { name: 'Prüfstand Getriebe', icon: 'gear:#5a8f6a', teamId: kon.id, customer: 'Antriebstechnik Süd', dueDate: day(80) });
await admin.post('/projects', { name: 'Hallenkran Halle 2', icon: 'building:#64748b', teamId: ein.id, dueDate: day(30) });
await admin.put(`/favorites/project/${p.id}`);

const task = (b) => admin.post(`/projects/${p.id}/tasks`, b);
const t1 = await task({ title: 'Rahmen konstruieren', startDate: day(-6), dueDate: day(1), assigneeId: me.id, priority: 'high', teamId: kon.id, estimateHours: 16 });
const t2 = await task({ title: 'Motorhalterung', status: 'in_progress', assigneeId: lisa.id, teamId: kon.id, startDate: day(-2), dueDate: day(6) });
await task({ title: 'Grundplatte', status: 'done', assigneeId: lisa.id, startDate: day(-14), dueDate: day(-7) });
const t4 = await task({ title: 'Schaltplan erstellen', assigneeId: tom.id, teamId: ele.id, startDate: day(3), dueDate: day(15) });
await task({ title: 'Kaufteile bestellen', assigneeId: sara.id, teamId: ein.id, startDate: day(7), dueDate: day(12) });
await task({ title: 'Pneumatik auslegen', status: 'review', priority: 'urgent', assigneeId: me.id, startDate: day(-8), dueDate: day(-1) });
await task({ title: 'Abnahme beim Kunden', milestone: true, startDate: day(24), dueDate: day(24) });
await admin.put(`/tasks/${t2.id}/dependencies`, { dependsOn: [t1.id] });
await admin.put(`/tasks/${t4.id}/dependencies`, { dependsOn: [t2.id] });
await admin.post(`/comments/task/${t1.id}`, { body: 'Bitte Bohrbild der Motorhalterung berücksichtigen.' });
await lisa.api.post(`/comments/task/${t1.id}`, { body: 'Ist eingeplant, Zeichnung folgt morgen.' });

// Dateien
const fd = new FormData();
fd.append('file', new Blob(['%PDF-1.4 Beispiel']), 'Lastenheft_VM-4.pdf');
fd.append('file', new Blob(['Position;Menge\n1;4']), 'Stueckliste_Zukaufteile.xlsx');
fd.append('file', new Blob(['Protokoll']), 'Besprechung_Kickoff.docx');
await admin.post(`/projects/${p.id}/files/upload?path=03_Doku`, fd);
const fd2 = new FormData();
fd2.append('file', new Blob(['%PDF-1.4 Angebot']), 'Angebot_Beispiel_Foods.pdf');
await admin.post(`/projects/${p.id}/files/upload`, fd2);

// CAD
const props = { Werkstoff: 'S235JR', Beschaffung: 'Eigenfertigung', Gezeichnet: 'Max Mustermann' };
const cad = async (b) => (await admin.post('/cad/items', { projectId: p.id, checkout: false, ...b })).item;
const frame = await cad({ type: 'part', sub: 100, designation: 'Rahmen', properties: props, createDrawing: true });
const plate = await cad({ type: 'part', sub: 100, designation: 'Grundplatte', properties: { ...props, Werkstoff: 'AlMg3' } });
await cad({ type: 'part', sub: 200, designation: 'Motorhalter', properties: { ...props, Werkstoff: 'S355J2' } });
const asm = await cad({ type: 'assembly', sub: 100, designation: 'Gestell', properties: props });
await admin.put(`/cad/items/${asm.id}/references`, { children: [{ childId: frame.id, quantity: 1 }, { childId: plate.id, quantity: 2 }] }).catch(() => {});
await admin.post(`/cad/items/${plate.id}/checkout`, { host: 'KONSTR-PC-03' }).catch(() => {});

// Zeiten, Urlaub, Chat, Ideen
await admin.post('/time/entries', { userId: lisa.id, projectId: p.id, taskId: t1.id, startedAt: at(-1, 8), endedAt: at(-1, 12, 30), note: 'Rahmen Grundgeometrie' });
await admin.post('/time/entries', { userId: lisa.id, projectId: p.id, startedAt: at(-1, 13), endedAt: at(-1, 16, 45), note: 'Abstimmung Elektrik' });
await admin.post('/time/clock-in', { projectId: p.id, taskId: t1.id });
await lisa.api.post('/absences', { startDate: day(workday(9)), endDate: day(workday(9) + 4), note: 'Familienurlaub' });
await tom.api.post('/absences', { startDate: day(workday(3)), endDate: day(workday(3)) });
for (const r of await admin.get('/absences/review')) await admin.post(`/absences/${r.id}/decide`, { approve: true });
const ch = await admin.get(`/projects/${p.id}/chat`);
await admin.post(`/chat/channels/${ch.id}/messages`, { body: 'Guten Morgen zusammen! Der Rahmen ist eingecheckt.' });
await lisa.api.post(`/chat/channels/${ch.id}/messages`, { body: 'Super, ich prüfe die Zeichnung heute noch. @admin kannst du danach die Motorhalterung freigeben?' });
await admin.post(`/chat/channels/${ch.id}/messages`, { body: 'Mache ich direkt nach der Mittagspause.' });
await lisa.api.post('/kvp', { title: 'Werkzeugwand an Station 3', description: 'Werkzeuge hängen sichtbar an der Wand statt in der Schublade – spart Suchzeit.', teamId: kon.id, savingsEur: 4200 });
await sara.api.post('/kvp', { title: 'Rahmenverträge für Normteile', description: 'Schrauben und Muttern über einen Rahmenvertrag beziehen.', teamId: ein.id, savingsEur: 8000 });
await admin.post('/kvp', { title: 'Druckluftleckagen beheben', description: 'Leckageortung mit Ultraschall, Schläuche tauschen.', savingsEur: 12500 });

// Ressourcen
const res = (b) => admin.post('/resources', b);
const r1 = await res({ name: 'Besprechungsraum 1', kind: 'room', location: 'Erdgeschoss', capacity: 10, description: 'Beamer, Videokonferenz', color: '#4f46e5' });
const r2 = await res({ name: 'Besprechungsraum 2', kind: 'room', location: '1. OG', capacity: 4, color: '#0891b2' });
const r3 = await res({ name: 'Firmenwagen Kombi', kind: 'vehicle', location: 'Parkplatz 3', capacity: 5, requiresApproval: true, color: '#d97706' });
const r4 = await res({ name: '3D-Messarm', kind: 'equipment', location: 'Messraum', color: '#0e9f6e' });
const w = workday(1);
await lisa.api.post('/resources/bookings', { resourceId: r1.id, startsAt: at(w, 9), endsAt: at(w, 10, 30), title: 'Design-Review VM-4' });
await admin.post('/resources/bookings', { resourceId: r1.id, startsAt: at(w, 13), endsAt: at(w, 15), title: 'Kundentermin Beispiel Foods' });
await admin.post('/resources/bookings', { resourceId: r2.id, startsAt: at(w, 8), endsAt: at(w, 8, 45), title: 'Teambesprechung', repeatWeeklyUntil: day(w + 35) });
await lisa.api.post('/resources/bookings', { resourceId: r3.id, startsAt: at(w + 1, 7), endsAt: at(w + 1, 17), title: 'Montage beim Kunden' });
await tom.api.post('/resources/bookings', { resourceId: r4.id, startsAt: at(w + 2, 8), endsAt: at(w + 2, 12), title: 'Erstmusterprüfung' });

// Apps aus 0.2.0: Kunde, Service, Kundenanfragen, Einsatzplanung, Fuhrpark, Freigaben, E-Signatur, Auswertungen, CO2
const kunde = await admin.post('/crm/accounts', { name: 'Beispiel Foods AG', street: 'Industriestraße 12', zip: '78120', city: 'Furtwangen', industry: 'Lebensmittel' });
await admin.post('/crm/opportunities', { accountId: kunde.id, title: 'Zweite Verpackungslinie', stage: 'offer', value: 480000, probability: 50 });
await admin.post('/crm/opportunities', { accountId: kunde.id, title: 'Wartungsvertrag VM-4', stage: 'won', value: 24000, probability: 100 });
const job = await admin.post('/service/jobs', { accountId: kunde.id, title: 'Inbetriebnahme Faltstation', description: 'Faltstation einstellen, Probelauf mit 500 Kartons.', address: 'Industriestraße 12, 78120 Furtwangen',
  contactName: 'Frau Huber', technicianIds: [tom.id], startAt: at(w, 8), endAt: at(w, 15), asset: 'VM-4 Faltstation' });
await admin.post('/helpdesk/tickets', { subject: 'Kartonzuführung stockt bei hoher Geschwindigkeit', accountId: kunde.id, contactName: 'Frau Huber', email: 'huber@beispiel-foods.de', priority: 'high', category: 'Störung', message: 'Ab 40 Takten pro Minute verkantet sich jeder zehnte Karton.' });
await admin.post('/helpdesk/tickets', { subject: 'Ersatzteilliste für Saugnäpfe', accountId: kunde.id, contactName: 'Herr Kaya', email: 'kaya@beispiel-foods.de', category: 'Ersatzteil', message: 'Bitte Artikelnummern der Saugnäpfe senden.' });
const mon = (() => { const x = new Date(); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; })();
const dOf = (k) => { const x = new Date(mon); x.setDate(x.getDate() + k); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
await admin.post('/planning/templates', { name: 'Früh', startTime: '06:00', endTime: '14:00', role: 'Frühschicht', color: '#2a78d6' });
await admin.post('/planning/templates', { name: 'Spät', startTime: '14:00', endTime: '22:00', role: 'Spätschicht', color: '#eb6834' });
for (let k = 0; k < 5; k++) {
  await admin.post('/planning/shifts', { userId: lisa.id, date: dOf(k), startTime: '06:00', endTime: '14:00', role: 'Frühschicht', color: '#2a78d6', location: 'Montage' });
  await admin.post('/planning/shifts', { userId: tom.id, date: dOf(k), startTime: '14:00', endTime: '22:00', role: 'Spätschicht', color: '#eb6834', location: 'Elektrik' });
  if (k % 2 === 0) await admin.post('/planning/shifts', { userId: sara.id, date: dOf(k), startTime: '08:00', endTime: '16:30', role: 'Wareneingang', color: '#1baf7a' });
}
await admin.post('/planning/shifts', { userId: null, date: dOf(5), startTime: '06:00', endTime: '12:00', role: 'Sonderschicht Inventur', color: '#6250d6' });
await admin.post('/planning/publish', { from: dOf(0) });
const car = await admin.post('/fleet/vehicles', { plate: 'VS-MM 412', make: 'VW', model: 'Caddy Maxi', fuel: 'diesel', mileage: 48210, driverId: tom.id, listPrice: 38450, privateUse: true, nextHu: day(21), nextService: day(60) });
await admin.post('/fleet/vehicles', { plate: 'VS-MM 77', make: 'Mercedes-Benz', model: 'Sprinter', kind: 'van', fuel: 'diesel', mileage: 112400, nextHu: day(140) });
await admin.post('/fleet/vehicles', { plate: 'VS-MM 9E', make: 'Škoda', model: 'Enyaq', fuel: 'electric', mileage: 15800, driverId: me.id, listPrice: 52900, privateUse: true, nextHu: day(400) });
await admin.post(`/fleet/vehicles/${car.id}/trips`, { date: day(-2), startKm: 48020, endKm: 48210, origin: 'Furtwangen', destination: 'Stuttgart', kind: 'business', purpose: 'Kundentermin', partner: 'Antriebstechnik Süd' });
for (const [d, l, e] of [[-40, 52, 91.2], [-25, 48, 84.9], [-9, 55, 97.1]]) await admin.post(`/fleet/vehicles/${car.id}/entries`, { date: day(d), kind: 'fuel', amount: e, liters: l });
const types = await admin.get('/approvals/types');
await lisa.api.post('/approvals/requests', { typeId: types.find((t) => t.name === 'Anschaffung').id, data: { item: 'Messschieber digital, 300 mm', reason: 'Alter Messschieber ist nicht mehr kalibrierfähig', amount: 189, supplier: 'Hoffmann Group' } });
await tom.api.post('/approvals/requests', { typeId: types.find((t) => t.name === 'Weiterbildung').id, data: { course: 'EPLAN Electric P8 Aufbaukurs', provider: 'EPLAN', date: day(30), amount: 1450, reason: 'Schaltpläne schneller und einheitlicher' } });
const sigForm = new FormData();
sigForm.append('title', 'Abnahmeprotokoll VM-4');
sigForm.append('message', 'Bitte prüfen Sie das Abnahmeprotokoll und unterschreiben Sie es.');
sigForm.append('signers', JSON.stringify([{ name: 'Frau Huber', email: 'huber@beispiel-foods.de' }, { name: 'Max Mustermann', email: 'max@muster-maschinenbau.de', userId: me.id }]));
sigForm.append('sequential', 'true');
sigForm.append('file', new Blob(['%PDF-1.4\n%%EOF']), 'Abnahmeprotokoll_VM-4.pdf');
const env = await admin.post('/esign/envelopes', sigForm);
await admin.post(`/esign/envelopes/${env.id}/send`).catch(() => {});
const envDetail = await admin.get(`/esign/envelopes/${env.id}`);
for (const [n, h] of [[-3, 7.5], [-4, 8], [-5, 6]]) await admin.post('/time/entries', { userId: tom.id, projectId: p.id, startedAt: at(n, 7), endedAt: at(n, 7 + h), note: 'Schaltschrank' });
await admin.post('/bi/reports', { name: 'Stunden je Projekt', shared: true, def: { source: 'time', dim: 'project', measure: 'hours', period: '12m', chart: 'hbar' } });
await admin.post('/bi/reports', { name: 'Vertriebspipeline', shared: true, def: { source: 'opportunities', dim: 'stage', measure: 'value', period: 'all', chart: 'bar' } });
await admin.post('/bi/reports', { name: 'Aufgaben je Status', shared: true, def: { source: 'tasks', dim: 'status', measure: 'count', period: 'all', chart: 'hbar' } });
await admin.post('/bi/reports', { name: 'Offene Aufgaben', shared: true, def: { source: 'tasks', dim: 'status', measure: 'count', period: 'all', chart: 'number' } });
const factors = await admin.get('/sustainability/factors');
const fac = (k) => factors.find((f) => f.key === k).id;
const year = new Date().getFullYear();
for (let m = 1; m <= new Date().getMonth(); m++) {
  const mm = String(m).padStart(2, '0');
  await admin.post('/sustainability/entries', { date: `${year}-${mm}-01`, factorId: fac('electricity'), quantity: 14000 + (m % 3) * 900, site: 'Werk Furtwangen', note: 'Zählerstand' });
  if (m <= 4 || m >= 10) await admin.post('/sustainability/entries', { date: `${year}-${mm}-01`, factorId: fac('gas'), quantity: 21000 - Math.abs(m - 1) * 1500, site: 'Werk Furtwangen', note: 'Heizung' });
}
await admin.post('/sustainability/entries', { date: `${year}-06-15`, factorId: fac('train_km'), quantity: 1800, projectId: p.id, note: 'Bahnreisen zum Kunden' });
await admin.post('/sustainability/import', { year });

// ------------------------------------------------------------ Bildschirmfotos
console.log('Bildschirmfotos werden erstellt ...');
const browser = await chromium.launch({ args: ['--lang=de-DE'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE', colorScheme: 'light' });
const page = await ctx.newPage();
const shot = async (name, url, fn) => {
  if (url) await page.goto(BASE + url);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(700);
  if (fn) { await fn(); await page.waitForTimeout(600); }
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ${name}.png`);
};
const setTheme = (t) => page.evaluate((x) => { localStorage.setItem('aperio-theme', x); document.documentElement.dataset.theme = x; }, t);

await shot('01-anmeldung', '/');
await page.fill('input[autocomplete=username]', 'admin');
await page.fill('input[type=password]', ADMIN_PW);
await page.click('button.primary');
await page.waitForTimeout(1200);
await setTheme('light');

const P = `/projects/${p.id}`;
await shot('02-schreibtisch', '/');
await shot('03-kanban', `${P}?tab=kanban`);
await shot('04-aufgabe', `${P}?tab=kanban&task=${t1.id}`);
await shot('05-gantt', `${P}?tab=gantt`);
await shot('06-dateien', `${P}?tab=files`);
await shot('07-cad-zentrale', '/cad');
await shot('08-cad-stueckliste', '/cad', async () => { await page.click('text=Gestell'); await page.waitForTimeout(700); await page.click('text=Stückliste').catch(() => {}); });
await shot('09-ressourcen', '/calendar/resources');
await shot('10-ressource-buchen', '/calendar/resources', async () => { await page.click('button:has-text("Buchen")'); });
await shot('11-zeiterfassung', '/time');
await shot('12-teamkalender', '/calendar/team');
await shot('13-chat', `${P}?tab=chat`);
await shot('14-kvp', '/kvp');
await shot('15-blitzsuche', '/', async () => { await page.keyboard.press('Control+k'); await page.keyboard.type('Rah'); });
await shot('16-teams-symbol', '/settings/teams', async () => { await page.click('.card >> nth=0'); });
await shot('17-ressourcen-verwalten', '/settings/resources');
await shot('30-app-store', '/apps');
await shot('31-einsatzplanung', '/planning');
await shot('32-service-einsatz', `/service?job=${job.id}`);
await shot('33-kundenanfragen', '/helpdesk');
await shot('34-auswertungen', '/bi');
await shot('35-nachhaltigkeit', '/sustainability');
await shot('36-freigaben', '/approvals?tab=todo');
await shot('37-fuhrpark', '/fleet');
await shot('38-e-signatur', envDetail.signers[0].link.replace(/^https?:\/\/[^/]+/, ''));

await admin.patch('/me', { theme: 'dark' }).catch(() => {});
await page.emulateMedia({ colorScheme: 'dark' });
await setTheme('dark');
await shot('20-dunkel-schreibtisch', '/');
await shot('21-dunkel-kanban', `${P}?tab=kanban`);
await shot('22-dunkel-ressourcen', '/calendar/resources');

await admin.patch('/me', { theme: 'system' }).catch(() => {});
await browser.close();
console.log(`Fertig: ${OUT}`);
