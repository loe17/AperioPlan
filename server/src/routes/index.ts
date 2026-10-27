import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import system from './system';
import auth from './auth';
import users from './users';
import teams from './teams';
import settings from './settings';
import me from './me';
import audit from './audit';
import ws from './ws';
import projects from './projects';
import tasks from './tasks';
import whiteboards from './whiteboards';
import search from './search';

export async function routes(app: FastifyInstance, ctx: AppContext) {
  for (const r of [system, auth, users, teams, settings, me, audit, ws, projects, tasks, whiteboards, search]) await r(app, ctx);
}
