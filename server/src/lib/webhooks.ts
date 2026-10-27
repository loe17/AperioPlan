import { createHmac } from 'node:crypto';
import type { SettingsService } from '../services/settings';

/**
 * Entwickler-Schnittstelle: Ereignisse aus dem Änderungsprotokoll werden an registrierte Webhooks
 * gesendet (POST JSON, Signatur im Header X-Aperio-Signature = HMAC-SHA256 des Rumpfs).
 */
let settings: SettingsService | null = null;
export const initWebhooks = (s: SettingsService) => { settings = s; };

export function dispatchWebhook(event: string, payload: Record<string, unknown>) {
  if (!settings) return;
  void (async () => {
    const hooks = (await settings!.get('webhooks')).filter((h) => h.active && h.events.some((e) => e === '*' || event === e || event.startsWith(e.replace(/\*$/, ''))));
    for (const h of hooks) {
      const body = JSON.stringify({ event, at: new Date().toISOString(), ...payload });
      const sig = createHmac('sha256', h.secret || '').update(body).digest('hex');
      fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aperio-event': event, 'x-aperio-signature': sig }, body, signal: AbortSignal.timeout(8000) })
        .catch(() => { /* Ziel nicht erreichbar – nicht blockieren */ });
    }
  })();
}
