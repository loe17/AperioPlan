import type { Sql } from './db';
import type { Hub } from './lib/hub';
import type { SettingsService } from './services/settings';
import type { Config } from './config';
import type { Storage } from './services/storage';

export interface AppContext {
  sql: Sql;
  hub: Hub;
  settings: SettingsService;
  config: Config;
  storage: Storage;
}
