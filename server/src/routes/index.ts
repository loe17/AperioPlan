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
import files from './files';
import links from './links';
import cad from './cad';
import time from './time';
import absences from './absences';
import chat from './chat';
import kvp from './kvp';
import mail from './mail';
import ai from './ai';
import backup from './backup';
import update from './update';
import office from './office';
import plugins from './plugins';
import resources from './resources';
import documents from './documents';

export async function routes(app: FastifyInstance, ctx: AppContext) {
  for (const r of [system, auth, users, teams, settings, me, audit, ws, projects, tasks, whiteboards, search, files, links, cad, time, absences, chat, kvp, mail, ai, backup, update, office, plugins, resources, documents]) await r(app, ctx);
}
