import { resolve } from 'node:path';

const env = process.env;

const bool = (v: string | undefined, def = false) => (v === undefined ? def : ['1', 'true', 'yes', 'ja'].includes(v.toLowerCase()));

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://aperio:aperio@localhost:5432/aperio',
  /** Ablage für Projektdateien (lokal oder eingebundenes NAS/SMB-Laufwerk) */
  storageRoot: resolve(env.STORAGE_ROOT ?? './data/files'),
  /** Ziel der Nacht-Sicherungen */
  backupDir: resolve(env.BACKUP_DIR ?? './data/backups'),
  /** Öffentliche Adresse, z. B. https://plan.firma.de – für Gast- und Teilen-Links */
  publicUrl: (env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  /** Ordner mit der gebauten Web-Oberfläche */
  webDist: env.WEB_DIST ? resolve(env.WEB_DIST) : resolve('../web/dist'),
  secureCookies: bool(env.SECURE_COOKIES, false),
  sessionDays: Number(env.SESSION_DAYS ?? 14),
  /** Schlüssel für verschlüsselte Sicherungen (falls leer: aus Einstellungen) */
  backupKey: env.BACKUP_KEY ?? '',
  logLevel: env.LOG_LEVEL ?? 'info',
  /** GitHub-Repository für die Update-Prüfung */
  updateRepo: env.UPDATE_REPO ?? 'loe17/AperioPlan',
  /** Datei, über die der Updater-Dienst auf dem Host angestoßen wird */
  updateTriggerFile: env.UPDATE_TRIGGER_FILE ?? '',
  /** Externe Dienste */
  officeUrl: env.OFFICE_URL ?? '',
  turnUrls: (env.TURN_URLS ?? '').split(',').filter(Boolean),
  isTest: env.NODE_ENV === 'test',
};

export type Config = typeof config;
