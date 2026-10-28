import { inspectionReminders } from '../routes/inventory';
import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context';
import { runBackup } from './backup';
import { syncMail } from './mail';
import { syncAllCalendars } from './caldav';
import { deliveryReminders } from '../routes/purchasing';
import { checkAllRunning } from './timeRules';
import { syncAllMailboxes } from './mailbox';
import { sendCalendarReminders } from '../routes/calendar';

/** Geplante Hintergrundaufgaben: Nacht-Tresor, Aufräumen abgelaufener Sitzungen und Links. */
export function startScheduler(ctx: AppContext, log: FastifyBaseLogger) {
  let backupTask: ReturnType<typeof cron.schedule> | null = null;
  let currentCron = '';

  const scheduleBackup = async () => {
    const s = await ctx.settings.get('backup');
    const expr = s.enabled && cron.validate(s.cron) ? s.cron : '';
    if (expr === currentCron) return;
    backupTask?.stop();
    backupTask = null;
    currentCron = expr;
    if (!expr) return;
    backupTask = cron.schedule(expr, async () => {
      try {
        const r = await runBackup(ctx, { reason: 'geplant' });
        log.info(`Nacht-Sicherung erstellt: ${r.file}`);
      } catch (e) {
        log.error(e, 'Nacht-Sicherung fehlgeschlagen');
      }
    });
    log.info(`Nacht-Sicherung geplant: ${expr}`);
  };

  void scheduleBackup();
  // Einstellungen könnten sich ändern – jede Minute abgleichen
  setInterval(() => { ctx.settings.clearCache(); void scheduleBackup(); }, 60_000).unref();

  // Projektpostfach alle 5 Minuten abrufen
  cron.schedule('*/5 * * * *', async () => {
    try { await syncMail(ctx); } catch (e) { log.warn(e, 'E-Mail-Abruf fehlgeschlagen'); }
  });

  // Persönliche Postfächer alle 3 Minuten abrufen
  cron.schedule('*/3 * * * *', async () => {
    try { await syncAllMailboxes(ctx); } catch (e) { log.warn(e, 'Abruf der Postfächer fehlgeschlagen'); }
  });

  // Kalender der E-Mail-Konten alle 15 Minuten abgleichen, Erinnerungen jede Minute
  cron.schedule('*/15 * * * *', async () => {
    try { await syncAllCalendars(ctx); } catch (e) { log.warn(e, 'Kalender-Abgleich fehlgeschlagen'); }
  });
  cron.schedule('* * * * *', async () => {
    try { await checkAllRunning(ctx); } catch (e) { log.warn(e, 'Prüfung der Stempeluhr fehlgeschlagen'); }
    try { await sendCalendarReminders(ctx); } catch (e) { log.warn(e, 'Termin-Erinnerungen fehlgeschlagen'); }
  });

  // Liefertermine im Einkauf (morgens)
  cron.schedule('5 7 * * *', async () => {
    try { await deliveryReminders(ctx); } catch (e) { log.warn(e, 'Liefertermin-Hinweise fehlgeschlagen'); }
    try { await inspectionReminders(ctx); } catch (e) { log.warn(e, 'Prüftermin-Hinweise fehlgeschlagen'); }
  });

  cron.schedule('17 * * * *', async () => {
    await ctx.sql`delete from sessions where expires_at < now()`;
  });
}
