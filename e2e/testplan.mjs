/**
 * Überprüfungs- und Testplan (Kapitel 14) als automatischer Browser-Test.
 *
 *   BASE_URL=http://localhost:3000 node e2e/testplan.mjs
 *
 * Erwartet eine frisch installierte Instanz (Erstzugang admin/admin). Benötigt Playwright
 * (npm i -g playwright && npx playwright install chromium).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PW = 'Neu-Sicher-2026!';
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`[OK]     ${name}`); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log(`[FEHLER] ${name}: ${e.message.split('\n')[0]}`); }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE', permissions: ['camera', 'microphone'] });
const page = await ctx.newPage();
const api = async (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}, [method, url, body]);

// ------------------------------------------------------------ 1. Server- & Start-Test
await step('1.1 Gesundheitsprüfung des Servers', async () => {
  const r = await (await fetch(`${BASE}/api/health`)).json();
  expect(r.status === 'ok', 'Server meldet nicht ok');
});
await step('1.2 Erstzugang admin/admin mit Passwort-Zwang', async () => {
  await page.goto(BASE);
  await page.fill('input[autocomplete=username]', 'admin');
  await page.fill('input[type=password]', 'admin');
  await page.click('button.primary');
  await page.waitForSelector('text=Bitte vergeben Sie ein neues');
  const pws = page.locator('input[type=password]');
  await pws.nth(0).fill('admin');
  await pws.nth(1).fill(PW);
  await pws.nth(2).fill(PW);
  await page.click('button:has-text("Passwort ändern")');
  await page.waitForSelector('text=Willkommen bei AperioPlan');
});
await step('1.3 Startassistent: Firmenname setzen und beenden', async () => {
  await page.fill('input[placeholder="z. B. Muster Maschinenbau GmbH"]', 'Testplan GmbH');
  await page.click('.onboarding button:has-text("Weiter")');
  await page.waitForSelector('text=Ihr Profil');
  await page.click('button:has-text("Assistent beenden")');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  let info = {};
  for (let i = 0; i < 20 && info.company !== 'Testplan GmbH'; i++) { info = await (await fetch(`${BASE}/api/public-info`)).json(); await page.waitForTimeout(200); }
  expect(info.company === 'Testplan GmbH', 'Firmenname nicht gespeichert');
});

// ------------------------------------------------------------ 2. Design- & Oberflächen-Test
let projectId;
await step('2.1 Teams und Projekt über die Oberfläche anlegen', async () => {
  globalThis.deptId = (await api('POST', '/teams', { name: 'Konstruktion', icon: 'gear' })).id;
  await page.goto(`${BASE}/projects?new=1`);
  await page.fill('input[placeholder="z. B. Verpackungsanlage"]', 'Maschine X');
  await page.click('.modal-foot button.primary');
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
  projectId = page.url().split('/projects/')[1].split('?')[0];
  await page.waitForSelector('text=0100');
});
await step('2.2 Brotkrumen-Pfad zeigt das Projekt', async () => {
  await page.waitForFunction(() => document.querySelector('.breadcrumbs')?.textContent?.includes('Projekt 0100'), null, { timeout: 5000 }).catch(() => {});
  const crumbs = await page.textContent('.breadcrumbs');
  expect(crumbs.includes('Projekt 0100 (Maschine X)'), `Brotkrumen: ${crumbs}`);
});
await step('2.3 Dunkel-/Hellmodus umschalten', async () => {
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('.topbar .icon-btn[title="Hell/Dunkel"]');
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(before !== after, 'Farbschema hat sich nicht geändert');
  await page.click('.topbar .icon-btn[title="Hell/Dunkel"]');
});
await step('2.4 Seitenleiste einklappen und öffnen', async () => {
  await page.click('.sidebar-head .icon-btn');
  expect(await page.$('.app.collapsed'), 'nicht eingeklappt');
  await page.click('.topbar .icon-btn[title="Seitenleiste öffnen"]');
  expect(!(await page.$('.app.collapsed')), 'nicht geöffnet');
});
await step('2.5 Blitzsuche mit Strg + K', async () => {
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Masch');
  await page.waitForSelector('.palette-item:has-text("0100 Maschine X")');
  await page.keyboard.press('Escape');
});
await step('2.6 Aufgabe anlegen, Detail-Fenster von rechts, Kanban-Verschieben', async () => {
  await page.goto(`${BASE}/projects/${projectId}?tab=kanban`);
  await page.click('button:has-text("Neue Aufgabe")');
  await page.fill('.modal input >> nth=0', 'Rahmen zeichnen');
  await page.click('.modal-foot button.primary');
  await page.waitForSelector('.slideover');
  await page.click('.slideover-head button[aria-label="Schließen"]');
  const card = page.locator('.kcard:has-text("Rahmen zeichnen")');
  await card.dragTo(page.locator('.kanban-col').nth(1));
  await page.waitForTimeout(800);
  const tasks = await api('GET', `/projects/${projectId}/tasks`);
  expect(tasks[0].status === 'in_progress', `Status ist ${tasks[0].status}`);
});

// ------------------------------------------------------------ 3. CAD- & PDM-Test
let item;
await step('3.1 Speichermaske ist im Administrator-Bereich editierbar', async () => {
  await page.goto(`${BASE}/settings/cad`);
  await page.waitForSelector('text=Dropdown-Kataloge');
  const mask = (await api('GET', '/settings')).cadMask;
  mask.fields.push({ key: 'Kunde', label: 'Kunde', type: 'text', required: false });
  await api('PUT', '/settings/cadMask', mask);
  expect((await api('GET', '/cad/mask')).fields.some((f) => f.key === 'Kunde'), 'Feld nicht gespeichert');
});
await step('3.2 Automatische 3D-Nummer 0100-100-00-0000-00_Rahmen und Zeichnung', async () => {
  const r = await api('POST', '/cad/items', { projectId, type: 'part', sub: 100, designation: 'Rahmen', createDrawing: true,
    properties: { Werkstoff: 'S235JR', Beschaffung: 'Eigenfertigung', Gezeichnet: 'Administrator' } });
  item = r.item;
  expect(item.number === '0100-100-00-0000-00_Rahmen', item.number);
  expect(r.drawing.fileName === '0100-100-00-0000-00_Rahmen.slddrw', r.drawing.fileName);
});
await step('3.3 Auschecken/Einchecken und Freigabe mit PDF/DXF/STEP-Aufträgen', async () => {
  const up = async (id, name) => page.evaluate(async ([i, n]) => {
    const fd = new FormData(); fd.append('comment', 'Test'); fd.append('file', new Blob(['SW']), n);
    const r = await fetch(`/api/cad/items/${i}/checkin`, { method: 'POST', body: fd }); if (!r.ok) throw new Error(await r.text());
  }, [id, name]);
  await up(item.id, 'x.sldprt');
  const detail = await api('GET', `/cad/items/${item.id}`);
  await up(detail.drawingId, 'x.slddrw');
  await api('POST', `/cad/items/${detail.drawingId}/state`, { to: 'review' });
  await api('POST', `/cad/items/${detail.drawingId}/state`, { to: 'released' });
  await api('POST', `/cad/items/${item.id}/state`, { to: 'review' });
  await api('POST', `/cad/items/${item.id}/state`, { to: 'released' });
  const jobs = await api('GET', '/cad/exports');
  expect(['dxf', 'pdf', 'step'].every((f) => jobs.some((j) => j.format === f)), 'Ableitungsaufträge fehlen');
  await page.goto(`${BASE}/cad?item=${item.id}`);
  await page.waitForSelector('.slideover:has-text("Freigegeben")');
});

// ------------------------------------------------------------ 4. Workflow-Test
await step('4.1 Zeiterfassung: Einstempeln, Ausstempeln, Korrekturanfrage', async () => {
  await page.goto(`${BASE}/time`);
  await page.click('main button:has-text("Einstempeln")');
  await page.waitForSelector('main button:has-text("Ausstempeln")');
  await page.waitForSelector('.clock-chip.running');
  await page.click('main button:has-text("Ausstempeln")');
  const c = await api('POST', '/time/corrections', { kind: 'add', projectId, newStartedAt: '2026-10-26T07:00:00Z', newEndedAt: '2026-10-26T09:00:00Z', what: 'Nachtrag', reason: 'vergessen' });
  expect(c.id, 'Korrektur nicht angelegt');
});
await step('4.2 DSGVO-konformer Urlaubsantrag im Teamkalender', async () => {
  const y = new Date().getFullYear() + 1;
  await api('POST', '/absences', { startDate: `${y}-02-08`, endDate: `${y}-02-12`, kind: 'other', note: 'vertraulich' });
  const cal = await api('GET', `/calendar/team?from=${y}-02-01&to=${y}-02-28`);
  expect(cal.length === 1 && cal[0].label === 'Abwesend' && !('note' in cal[0]) && !('kind' in cal[0]), JSON.stringify(cal));
});

// ------------------------------------------------------------ 5. Kommunikations-Test
await step('5.1 Chat in Echtzeit', async () => {
  await page.goto(`${BASE}/projects/${projectId}?tab=chat`);
  await page.fill('.chat-input textarea', 'Hallo Team');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg:has-text("Hallo Team")');
});
await step('5.2 Videoanruf mit zwei Teilnehmern (WebRTC)', async () => {
  const user = await api('POST', '/users', { username: 'lisa', displayName: 'Lisa Berger', password: 'Start-12345', departmentId: globalThis.deptId });
  await api('PUT', `/projects/${projectId}/members`, { members: [{ userId: (await api('GET', '/auth/me')).id, role: 'owner' }, { userId: user.id, role: 'member' }] });
  const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ['camera', 'microphone'] });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE);
  await p2.fill('input[autocomplete=username]', 'lisa');
  await p2.fill('input[type=password]', 'Start-12345');
  await p2.click('button.primary');
  await p2.waitForSelector('text=Bitte vergeben Sie ein neues');
  const pws = p2.locator('input[type=password]');
  await pws.nth(0).fill('Start-12345'); await pws.nth(1).fill('Lisa-2026-Neu'); await pws.nth(2).fill('Lisa-2026-Neu');
  await p2.click('button:has-text("Passwort ändern")');
  await p2.click('button:has-text("Assistent beenden")');
  await p2.waitForSelector('text=Mein Schreibtisch');
  console.log('   … Lisa angemeldet, starte Anruf');
  await page.click('button:has-text("Videoanruf")');
  await p2.waitForSelector('text=ruft an', { timeout: 15000 });
  console.log('   … Einladung angekommen');
  await p2.click('button:has-text("Annehmen")');
  await page.waitForFunction(() => document.querySelectorAll('video').length >= 2 && [...document.querySelectorAll('video')].every((v) => v.srcObject), null, { timeout: 20000 });
  await p2.waitForFunction(() => document.querySelectorAll('video').length >= 2, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const playing = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.srcObject && v.srcObject.getVideoTracks().length).length);
  expect(playing >= 2, `nur ${playing} Videos aktiv`);
  // Chat im Anruf: Nachricht kommt beim anderen an
  await page.click('.call-top button:has-text("Chat")');
  await page.fill('.call-chat-input textarea', 'Hallo aus dem Anruf');
  await page.press('.call-chat-input textarea', 'Enter');
  await p2.click('.call-top button:has-text("Chat")');
  await p2.waitForSelector('.call-msg:has-text("Hallo aus dem Anruf")', { timeout: 10000 });
  await page.click('.call-top button:has-text("Teilnehmer")');
  await page.waitForSelector('.call-person:has-text("Gastgeber")');
  await p2.click('button:has-text("Verlassen")');
  await page.click('button:has-text("Verlassen")');
  // Verlaufseintrag im Chat mit dem Anruf-Chat
  await page.waitForSelector('.call-entry:has-text("Videoanruf")', { timeout: 10000 });
  await ctx2.close();
});

// ------------------------------------------------------------ 6. Sicherungs- & Update-Test
await step('6.1 Verschlüsseltes Backup und Duplikaterkennung beim Import', async () => {
  const b = await api('POST', '/backups', {});
  const name = b.file.split('/').pop();
  await api('PATCH', `/projects/${projectId}`, { name: 'Maschine X (geändert)' });
  const a = await api('POST', `/backups/${name}/analyze`, {});
  expect(a.conflicts.some((c) => c.table === 'projects' && c.newer === 'local'), 'Konflikt nicht erkannt');
  await api('DELETE', `/backups/import/${a.id}`);
});
await step('6.2 Update-Prüfung', async () => {
  const r = await api('GET', '/system/update/check');
  expect(r.current, 'keine aktuelle Version');
});

// ------------------------------------------------------------ 7. Ressourcen & Erscheinungsbild (Version 1.1)
await step('7.1 Ressource buchen, Doppelbuchung wird abgelehnt', async () => {
  const room = await api('POST', '/resources', { name: 'Testraum', kind: 'room', capacity: 6 });
  await page.goto(`${BASE}/calendar/resources`);
  await page.click('button:has-text("Buchen")');
  await page.selectOption('.modal select >> nth=0', { label: 'Testraum' });
  await page.fill('.modal input[placeholder*="Kundentermin"]', 'Testplan-Besprechung');
  await page.waitForSelector('.modal >> text=frei', { timeout: 5000 });
  await page.click('.modal-foot button.primary');
  await page.waitForSelector('.booking-chip', { timeout: 5000 });
  const [b] = await api('GET', `/resources/bookings?resourceId=${room.id}&mine=1&from=${new Date(Date.now() - 864e5).toISOString()}&to=${new Date(Date.now() + 60 * 864e5).toISOString()}`);
  expect(b?.title === 'Testplan-Besprechung', 'Buchung nicht gespeichert');
  let clash = false;
  try { await api('POST', '/resources/bookings', { resourceId: room.id, startsAt: b.startsAt, endsAt: b.endsAt }); }
  catch (e) { clash = /409/.test(e.message); }
  expect(clash, 'Doppelbuchung wurde nicht abgelehnt');
});
await step('7.2 Oberfläche ohne Emojis', async () => {
  for (const url of ['/', '/calendar/resources', `/projects/${projectId}?tab=files`, '/settings/teams']) {
    await page.goto(BASE + url);
    await page.waitForTimeout(600);
    const text = await page.evaluate(() => document.body.innerText);
    expect(!/\p{Extended_Pictographic}/u.test(text.replace(/[©®™↔↕]/gu, '')), `Emoji auf ${url}`);
  }
});

// ------------------------------------------------------------ 8. Projekte und Kalender (1.2)
await step('8.1 Eigene Kanban-Spalte anlegen', async () => {
  await page.goto(`${BASE}/projects/${projectId}?tab=kanban`);
  await page.click('button:has-text("Spalte hinzufügen")');
  await page.fill('.modal input[placeholder*="Wartet"]', 'Wartet auf Kunde');
  await page.click('.modal button:has-text("Speichern")');
  await page.waitForSelector('.kanban-col-head:has-text("Wartet auf Kunde")');
});

await step('8.2 Termin mit Einladung im Kalender anlegen', async () => {
  await page.goto(`${BASE}/calendar`);
  await page.click('.page-head button:has-text("Termin")');
  await page.fill('.modal input[placeholder*="Abstimmung"]', 'Projektbesprechung');
  await page.click('.modal button:has-text("Anlegen")');
  await page.waitForSelector('.cal-ev.event:has-text("Projektbesprechung")');
});

await step('8.3 Abgeschlossenes Projekt ist nur lesbar', async () => {
  const p = await api('POST', '/projects', { name: 'Altprojekt' });
  await api('PATCH', `/projects/${p.id}`, { status: 'done' });
  await page.goto(`${BASE}/projects/${p.id}?tab=kanban`);
  await page.waitForSelector('.locked-banner');
  const canAdd = await page.locator('button:has-text("Neue Aufgabe")').count();
  expect(canAdd === 0, 'Neue Aufgabe trotz Sperre sichtbar');
  await page.selectOption('.locked-banner select', 'active');
  await page.waitForSelector('.locked-banner', { state: 'detached' });
});

// ------------------------------------------------------------ 9. CRM (1.2)
await step('9.1 Kunde beim Projekt anlegen und im CRM wiederfinden', async () => {
  await page.goto(`${BASE}/projects?new=1`);
  await page.fill('.modal input[placeholder*="Verpackungsanlage"]', 'Kundenprojekt');
  await page.fill('.modal .picker input', 'Testkunde Huber');
  await page.click('.modal .item:has-text("Im CRM anlegen")');
  await page.fill('.modal >> nth=1 >> input[placeholder*="Muster Maschinenbau"]', 'Testkunde Huber GmbH');
  await page.click('.modal >> nth=1 >> button:has-text("Anlegen")');
  await page.waitForSelector('.modal .picker-value:has-text("Testkunde Huber GmbH")');
  await page.click('.modal button:has-text("Anlegen")');
  await page.waitForSelector('a:has-text("Testkunde Huber GmbH")');
  await page.click('a:has-text("Testkunde Huber GmbH")');
  await page.waitForSelector('h1:has-text("Testkunde Huber GmbH")');
  await page.fill('.mention-wrap textarea', 'Erstes Gespräch geführt');
  await page.click('button:has-text("Notiz speichern")');
  await page.waitForSelector('.tl-item:has-text("Erstes Gespräch geführt")');
});

// ------------------------------------------------------------ 10. Einkauf und Kalkulation (1.2)
await step('10.1 Einkauf: Position anlegen und bestellen', async () => {
  const pr = await api('GET', `/projects/${projectId}`);
  await api('PATCH', `/projects/${projectId}`, { modules: [...new Set([...pr.modules, 'purchasing', 'calculation'])] });
  await api('POST', '/crm/accounts', { name: 'Normteile Muster', kind: 'supplier' });
  await page.goto(`${BASE}/projects/${projectId}?tab=purchasing`);
  await page.click('button:has-text("Position")');
  await page.fill('.modal input >> nth=0', 'Linearführung');
  await page.click('.modal button:has-text("Speichern")');
  await page.waitForSelector('td:has-text("Linearführung")');
  await page.check('tbody input[type=checkbox] >> nth=0');
  await page.click('button:has-text("Bestellen")');
  await page.fill('.modal .picker input', 'Normteile');
  await page.click('.modal .item:has-text("Normteile Muster")');
  const popup = page.waitForEvent('popup');
  await page.click('.modal button:has-text("Bestellung anlegen")');
  await (await popup).close();
  await page.waitForSelector('.pill:has-text("Bestellt")');
});

await step('10.2 Kalkulation: Angebotskalkulation rechnet beim Tippen', async () => {
  await page.goto(`${BASE}/projects/${projectId}?tab=calculation`);
  await page.click('.toolbar button:has-text("Kalkulation")');
  await page.fill('.modal input[placeholder*="Roboterzelle"]', 'Testanlage');
  await page.click('.modal button:has-text("Anlegen")');
  await page.waitForSelector('.calc-result');
  await page.fill('.calc-input input[placeholder="Std."] >> nth=0', '10');
  await page.waitForFunction(() => /950,00/.test(document.querySelector('.calc-result')?.textContent ?? ''));
  await page.click('button:has-text("Speichern")');
});

// ------------------------------------------------------------ 11. Zeiterfassung mit Regeln (1.2)
await step('11.1 Regelsatz Deutschland laden, Stempeluhr zeigt die Regeln', async () => {
  await page.goto(`${BASE}/settings/time`);
  await page.click('button:has-text("Deutschland")');
  await page.waitForSelector('b:has-text("Deutschland (ArbZG)")');
  await page.goto(`${BASE}/time`);
  await page.waitForSelector('text=Regeln: Deutschland (ArbZG)');
});

// ------------------------------------------------------------ 12. Ablage, Postfach, KI, Protokoll (1.2)
await step('12.1 Ordnerstruktur mit Unterordner anlegen', async () => {
  await page.goto(`${BASE}/settings/storage`);
  await page.click('.card.flat .row:has(span:text-is("01_CAD")) button[title="Unterordner anlegen"]');
  await page.fill('input[placeholder*="Unterordner"]', 'Teile');
  await page.click('button:has-text("Hinzufügen") >> nth=0');
  await page.waitForSelector('.card.flat span.mono:text-is("Teile")');
  await page.click('button:has-text("Speichern")');
});

await step('12.2 Persönliches Postfach fordert zur Einrichtung auf', async () => {
  await page.goto(`${BASE}/mail`);
  await page.click('button:has-text("E-Mail-Konto einrichten")');
  await page.fill('.modal input >> nth=0', 'max@gmx.de');
  await page.locator('.modal input >> nth=0').blur();
  await page.waitForFunction(() => [...document.querySelectorAll('.modal input')].some((i) => i.value === 'imap.gmx.net'));
  await page.click('.modal button:has-text("Abbrechen")');
});

await step('12.3 KI-Anbieter hinzufügen', async () => {
  await page.goto(`${BASE}/settings/ai`);
  await page.selectOption('select:has(option:text("＋ Anbieter hinzufügen …"))', 'gemini');
  await page.click('.modal button:has-text("Übernehmen")');
  await page.waitForSelector('td:has-text("Google Gemini")');
  await page.waitForSelector('.pill:has-text("online")');
});

await step('12.4 Änderungsprotokoll als Excel herunterladen', async () => {
  await page.goto(`${BASE}/settings/audit`);
  const dl = page.waitForEvent('download');
  await page.click('a:has-text("Excel")');
  const d = await dl;
  if (!/\.xlsx$/.test(d.suggestedFilename())) throw new Error(d.suggestedFilename());
  await page.click('button:has-text("Prüfsumme")');
  await page.waitForSelector('text=SHA-256');
});

// ------------------------------------------------------------ 13. CAD-/PCB-Bridge (1.2)
await step('13.1 PCB-Bridge: Leiterplatte über die Speichermaske anlegen', async () => {
  await page.goto(`${BASE}/pcb`);
  await page.click('button:has-text("Neue Leiterplatte")');
  await page.selectOption('.modal select >> nth=0', { index: 1 });
  await page.fill('.modal input[placeholder*="Steuerplatine"]', 'Steuerplatine');
  await page.selectOption('.modal .field:has-text("Oberfläche") select', 'ENIG (chem. Gold)');
  await page.click('.modal button:has-text("Nummer vergeben")');
  await page.waitForSelector('.slideover b.mono:text-matches("-E01-00$")');
  await page.waitForSelector('text=APERIO_NUMMER', { state: 'attached' });
});

await step('13.2 Wächter einrichten: Installationspaket herunterladen', async () => {
  await page.goto(`${BASE}/pcb?tab=setup`);
  const dl = page.waitForEvent('download');
  await page.click('button:has-text("Installationspaket herunterladen")');
  const d = await dl;
  if (d.suggestedFilename() !== 'AperioPlan-PCB-Bridge-Einrichtung.zip') throw new Error(d.suggestedFilename());
  await page.goto(`${BASE}/cad?tab=setup`);
  await page.waitForSelector('h2:has-text("CAD-Wächter für SolidWorks einrichten")');
  await page.waitForSelector('nav >> text=CAD-Bridge');
});

await step('13.3 Speichermaske: Reiter CAD und PCB', async () => {
  await page.goto(`${BASE}/settings/cad`);
  await page.click('button.tab:has-text("PCB (KiCad)")');
  await page.waitForSelector('input[value="{PROJEKT}-E{NN}"]');
});

// ------------------------------------------------------------ 14. Anwendungen aus dem App-Store (0.2.0)
await step('14.1 App-Store: Meetings installieren, erscheint in der Seitenleiste', async () => {
  await page.goto(`${BASE}/apps`);
  await page.click('.app-card:has-text("Meetings")');
  await page.click('.modal button:has-text("Installieren")');
  await page.waitForSelector('nav >> text=Meetings', { timeout: 10000 });
});

await step('14.2 Meeting mit Gast-Link: Gast wartet, wird eingelassen, beide sehen sich', async () => {
  await page.goto(`${BASE}/meetings`);
  await page.click('button:has-text("Meeting planen")');
  await page.fill('.modal input[placeholder*="Abnahme"]', 'Abnahme mit Kunde');
  await page.click('.modal button:has-text("Planen und einladen")');
  await page.waitForSelector('h3:has-text("Gast-Link")');
  const link = await page.inputValue('input.mono[readonly]');
  const guestUrl = link.replace(/^https?:\/\/[^/]+/, BASE);
  const gctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, permissions: ['camera', 'microphone'] });
  const g = await gctx.newPage();
  await g.goto(guestUrl);
  await g.fill('input[placeholder="Vor- und Nachname"]', 'Herr Kunde');
  await g.click('button:has-text("Meeting beitreten")');
  await g.waitForSelector('text=Warteraum');
  await page.waitForSelector('text=Herr Kunde', { timeout: 10000 });
  await page.click('button:has-text("Einlassen")');
  await g.waitForSelector('.call', { timeout: 10000 });
  await page.click('.page-head button:has-text("Beitreten")');
  await page.waitForFunction(() => [...document.querySelectorAll('.call video')].filter((v) => v.srcObject).length >= 2, null, { timeout: 20000 });
  await g.waitForFunction(() => [...document.querySelectorAll('.call video')].filter((v) => v.srcObject).length >= 2, null, { timeout: 20000 });
  await g.click('.call-top button:has-text("Teilnehmer")');
  await g.waitForSelector('.call-person:has-text("Gastgeber")');
  await g.click('.call-top button:has-text("Chat")');
  await g.fill('.call-chat-input textarea', 'Hallo vom Kunden');
  await g.press('.call-chat-input textarea', 'Enter');
  await page.click('.call-top button:has-text("Chat")');
  await page.waitForSelector('.call-msg:has-text("Hallo vom Kunden")', { timeout: 10000 });
  await g.click('button:has-text("Verlassen")');
  await g.waitForSelector('text=Sie haben das Meeting');
  await page.click('.call button:has-text("Verlassen")');
  await gctx.close();
});

await step('14.3 Formular anlegen, öffentlich ausfüllen, Auswertung', async () => {
  await api('POST', '/apps/forms/install', {});
  await page.goto(`${BASE}/forms`);
  await page.click('button:has-text("Neues Formular")');
  await page.fill('.form-title-input', 'Kantinen-Umfrage');
  await page.locator('.form-title-input').blur();
  await page.click('.form-add button:has-text("Einfachauswahl")');
  await page.fill('.form-q-text', 'Wie schmeckt das Essen?');
  await page.fill('.form-q input[placeholder="Möglichkeit 1"]', 'Gut');
  await page.press('.form-q input[placeholder="Möglichkeit 1"]', 'Enter');
  await page.fill('.form-q input[placeholder="Möglichkeit 2"]', 'Geht so');
  await page.check('.form-q label:has-text("Pflicht") input');
  await page.waitForTimeout(1200);
  await page.click('.tab:visible:has-text("Einstellungen und Teilen")');
  await page.check('label:has-text("Öffentlicher Link") input');
  await page.waitForSelector('input.mono[readonly]');
  const link = (await page.inputValue('input.mono[readonly]')).replace(/^https?:\/\/[^/]+/, BASE);
  const pctx = await browser.newContext();
  const pp = await pctx.newPage();
  await pp.goto(link);
  await pp.click('button:has-text("Absenden")');
  await pp.waitForSelector('text=Bitte beantworten');
  await pp.check('label:has-text("Gut") input');
  await pp.click('button:has-text("Absenden")');
  await pp.waitForSelector('text=Vielen Dank');
  await pctx.close();
  await page.click('.tab:visible:has-text("Ergebnisse")');
  await page.waitForSelector('.bar-row:has-text("Gut") >> text=1 · 100 %');
});

await step('14.4 Schwarzes Brett: Mitteilung mit Lesebestätigung, Marktplatz-Angebot', async () => {
  await api('POST', '/apps/board/install', {});
  await page.goto(`${BASE}/board`);
  await page.click('button.primary:has-text("Mitteilung")');
  await page.fill('.modal input >> nth=0', 'Neue Parkplatzregelung');
  await page.fill('.modal textarea', 'Ab Montag gilt: Besucherparkplätze freihalten. Details: https://example.com');
  await page.check('label:has-text("Lesebestätigung") input');
  await page.click('.modal button:has-text("Veröffentlichen")');
  await page.click('.board-card:has-text("Neue Parkplatzregelung")');
  await page.waitForSelector('.board-body a[href="https://example.com"]');
  await page.click('.modal button:has-text("Wer hat gelesen?")');
  await page.waitForSelector('text=von');
  await page.click('.modal button[aria-label="Schließen"]');
  await page.click('.tab:visible:has-text("Marktplatz")');
  await page.click('button:has-text("Etwas anbieten")');
  await page.fill('.modal input[placeholder^="z. B. Kinderfahrrad"]', 'Bürostuhl, ergonomisch');
  await page.selectOption('.modal select >> nth=0', 'free');
  await page.click('.modal button:has-text("Veröffentlichen")');
  await page.waitForSelector('.market-card:has-text("Bürostuhl") >> text=zu verschenken');
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
process.exit(failed.length ? 1 : 0);
