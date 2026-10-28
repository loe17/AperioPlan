/**
 * Eigene Startseite: jeder Benutzer stellt seine Kacheln (Widgets) selbst zusammen.
 * Wetter über Open-Meteo (ohne Schlüssel); der Server fragt stellvertretend an, damit die
 * Adresse der Mitarbeiter nicht beim Wetterdienst landet, und merkt sich Antworten 15 Minuten.
 */
import type { FastifyInstance } from 'fastify';
import { DASHBOARD_WIDGETS, DEFAULT_DASHBOARD } from '@aperio/shared';
import type { AppContext } from '../context';
import { z, parse } from '../lib/validate';
import { requireUser } from '../lib/auth';
import { HttpError } from '../lib/errors';

const widget = z.object({ id: z.string().max(40), type: z.enum(DASHBOARD_WIDGETS), size: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), config: z.record(z.string(), z.unknown()).optional() });

const cache = new Map<string, { at: number; data: unknown }>();
async function cached(key: string, ms: number, load: () => Promise<unknown>) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.data;
  const data = await load();
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return data;
}

const WMO: Record<number, [string, string]> = {
  0: ['klar', 'sun'], 1: ['überwiegend klar', 'sun'], 2: ['teilweise bewölkt', 'cloud-sun'], 3: ['bedeckt', 'cloud'],
  45: ['Nebel', 'fog'], 48: ['Reifnebel', 'fog'], 51: ['leichter Nieselregen', 'drizzle'], 53: ['Nieselregen', 'drizzle'], 55: ['starker Nieselregen', 'drizzle'],
  56: ['gefrierender Nieselregen', 'drizzle'], 57: ['gefrierender Nieselregen', 'drizzle'], 61: ['leichter Regen', 'rain'], 63: ['Regen', 'rain'], 65: ['starker Regen', 'rain'],
  66: ['gefrierender Regen', 'rain'], 67: ['gefrierender Regen', 'rain'], 71: ['leichter Schneefall', 'snow'], 73: ['Schneefall', 'snow'], 75: ['starker Schneefall', 'snow'],
  77: ['Schneegriesel', 'snow'], 80: ['Regenschauer', 'rain'], 81: ['Regenschauer', 'rain'], 82: ['heftige Regenschauer', 'rain'], 85: ['Schneeschauer', 'snow'], 86: ['Schneeschauer', 'snow'],
  95: ['Gewitter', 'storm'], 96: ['Gewitter mit Hagel', 'storm'], 99: ['Gewitter mit Hagel', 'storm'],
};

export default async function dashboardRoutes(app: FastifyInstance, ctx: AppContext) {
  const { sql } = ctx;

  app.get('/me/dashboard', async (req) => {
    const u = requireUser(req);
    const [r] = await sql<{ dashboard: unknown; weather_location: unknown }[]>`select dashboard, weather_location from users where id = ${u.id}`;
    return { widgets: r?.dashboard ?? DEFAULT_DASHBOARD, weatherLocation: r?.weather_location ?? null, isDefault: !r?.dashboard };
  });

  app.put('/me/dashboard', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ widgets: z.array(widget).max(40).nullable() }), req.body);
    await sql`update users set dashboard = ${b.widgets ? sql.json(b.widgets as never) : null} where id = ${u.id}`;
    return { ok: true };
  });

  app.put('/me/weather-location', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ name: z.string().max(120), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).nullable(), req.body);
    await sql`update users set weather_location = ${b ? sql.json(b) : null} where id = ${u.id}`;
    return { ok: true };
  });

  const fetchJson = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'AperioPlan' } }).catch(() => null);
    if (!res?.ok) throw new HttpError(502, 'Der Wetterdienst ist gerade nicht erreichbar');
    return res.json() as Promise<any>;
  };

  app.get('/weather/search', async (req) => {
    requireUser(req);
    const { q } = parse(z.object({ q: z.string().trim().min(2).max(80) }), req.query);
    return cached(`geo:${q.toLowerCase()}`, 24 * 3600_000, async () => {
      const j = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=de&format=json`);
      return (j.results ?? []).map((r: any) => ({ name: r.name, region: [r.admin1, r.country].filter(Boolean).join(', '), latitude: r.latitude, longitude: r.longitude }));
    });
  });

  app.get('/weather', async (req) => {
    requireUser(req);
    const q = parse(z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) }), req.query);
    const lat = q.lat.toFixed(2), lon = q.lon.toFixed(2);
    return cached(`wx:${lat},${lon}`, 15 * 60_000, async () => {
      const j = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=4`);
      const desc = (c: number) => WMO[c] ?? ['–', 'cloud'];
      return {
        current: { temperature: j.current?.temperature_2m, feelsLike: j.current?.apparent_temperature, wind: j.current?.wind_speed_10m, humidity: j.current?.relative_humidity_2m,
          code: j.current?.weather_code, text: desc(j.current?.weather_code)[0], icon: desc(j.current?.weather_code)[1], isDay: j.current?.is_day === 1 },
        days: (j.daily?.time ?? []).map((d: string, i: number) => ({ date: d, max: j.daily.temperature_2m_max[i], min: j.daily.temperature_2m_min[i],
          rain: j.daily.precipitation_probability_max?.[i] ?? null, text: desc(j.daily.weather_code[i])[0], icon: desc(j.daily.weather_code[i])[1] })),
      };
    });
  });
}
