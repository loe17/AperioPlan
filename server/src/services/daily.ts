/** Tägliche Aufgaben der Anwendungen (morgens): fällige Wartungen, Kalibrierfristen, Vertragsrechnungen usw. */
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context';
import { maintenanceDaily } from '../routes/maintenance';
import { qualityDaily } from '../routes/quality';
import { contractsDaily } from '../routes/contracts';

export const DAILY_JOBS: [string, (ctx: AppContext) => Promise<unknown>][] = [
  ['Instandhaltung', maintenanceDaily],
  ['Messmittel', qualityDaily],
  ['Verträge', contractsDaily],
];

export async function runDailyJobs(ctx: AppContext, log?: FastifyBaseLogger) {
  for (const [name, fn] of DAILY_JOBS) {
    try { await fn(ctx); } catch (e) { log?.warn(e, `Tägliche Aufgabe „${name}“ fehlgeschlagen`); }
  }
}
