import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import system from './system';
import auth from './auth';
import users from './users';
import teams from './teams';
import settings from './settings';
import me from './me';
import audit from './audit';

export async function routes(app: FastifyInstance, ctx: AppContext) {
  for (const r of [system, auth, users, teams, settings, me, audit]) await r(app, ctx);
}
