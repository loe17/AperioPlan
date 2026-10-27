import type { FastifyInstance } from 'fastify';
import { APP_VERSION, CHANGELOG } from '@aperio/shared';
import type { AppContext } from '../context';

export default async function systemRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Gesundheitsprüfung für den Wächterdienst (Docker healthcheck) */
  app.get('/health', async (_req, reply) => {
    try {
      await ctx.sql`select 1`;
      return { status: 'ok', version: APP_VERSION, time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'db_unavailable', version: APP_VERSION });
    }
  });

  app.get('/version', async () => ({ version: APP_VERSION }));
  app.get('/changelog', async () => CHANGELOG);

  /** Öffentliche Basisdaten für die Anmeldeseite */
  app.get('/public-info', async () => {
    const company = await ctx.settings.get('company');
    const ldap = await ctx.settings.get('ldap');
    return { version: APP_VERSION, company: company.name, ldapEnabled: ldap.enabled };
  });
}
