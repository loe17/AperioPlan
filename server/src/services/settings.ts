import type { Sql } from '../db';
import {
  DEFAULT_PROJECT_NUMBER_SETTINGS, DEFAULT_CALC_RATES, type CalcRates, DEFAULT_TIME_RULES, type TimeRuleSettings, DEFAULT_PROJECT_MODULES, DEFAULT_PROJECT_FOLDERS,
  DEFAULT_MASK_FIELDS, DEFAULT_CATALOGS, type ProjectNumberSettings, type ProjectModule,
  type MaskField, type Catalog, type PcbMaskSettings, DEFAULT_PCB_MASK, PREINSTALLED_APPS, type Tool,
} from '@aperio/shared';

export interface LdapSettings {
  enabled: boolean;
  url: string;              // ldaps://dc.firma.local:636
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;       // (sAMAccountName={{username}})
  displayNameAttr: string;
  emailAttr: string;
  adminGroupDn: string;     // Mitglieder werden Administratoren
  teamleadGroupDn: string;
  tlsRejectUnauthorized: boolean;
}

export interface MailSettings {
  enabled: boolean;
  imapHost: string; imapPort: number; imapSecure: boolean;
  smtpHost: string; smtpPort: number; smtpSecure: boolean;
  user: string; password: string; from: string;
}

export type AiKind = 'gemini' | 'openai' | 'anthropic' | 'mistral' | 'azure' | 'ollama';
export interface AiProvider {
  id: string; name: string; kind: AiKind; baseUrl: string; apiKey: string; model: string;
  /** nur Azure OpenAI: Name der Bereitstellung und API-Version */
  deployment?: string; apiVersion?: string;
  /** Daten verlassen das Haus (Online-Anbieter) */
  online: boolean;
}
export interface AiSettings {
  enabled: boolean;
  /** frühere Einzel-Einstellung (vor 0.2.0) – wird als Anbieter übernommen */
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** mehrere Anbieter gleichzeitig, z. B. lokales Modell für vertrauliche Projekte und Gemini für alles andere */
  providers: AiProvider[];
  defaultProviderId: string | null;
}

export interface StorageSettings {
  /** Unterordner im Speicherwurzelverzeichnis bzw. eingebundener Netzpfad */
  mode: 'local' | 'network';
  networkPath: string;       // Anzeige für Windows-Explorer, z. B. \\nas\projekte
  /** Ordnerstruktur neuer Projekte; Unterordner mit „/“, z. B. „01_CAD/Teile“ */
  projectFolders: string[];
  /** weitere Speicherorte (Netzlaufwerke, Archiv); „main“ = Standardablage */
  locations: StorageLocation[];
  defaultLocation: string;
}

export interface StorageLocation { id: string; name: string; path: string; networkPath: string; teamIds: string[]; archive: boolean }

export interface BackupSettings {
  enabled: boolean;
  cron: string;              // "0 2 * * *" = jede Nacht 02:00
  keep: number;              // Anzahl aufzubewahrender Sicherungen
  passphrase: string;
  targetDir: string;         // leer = Standardordner
  includeFiles: boolean;
}

export interface SettingsMap {
  company: { name: string; logoText: string };
  presence: { idleMinutes: number };
  projectNumbers: ProjectNumberSettings;
  defaultModules: ProjectModule[];
  /** Vorlage eigener Kanban-Spalten für neue Projekte */
  kanbanTemplate: { name: string; color: string; baseStatus: 'todo' | 'in_progress' | 'review' | 'done' }[];
  /** Nummernkreise im CRM und Einkauf */
  calcRates: CalcRates;
  timeRules: TimeRuleSettings;
  numbers: { customer: string; supplier: string; quote: string; case: string; order: string; calculation: string };
  /** Firmendaten für Angebote und Bestellungen */
  letterhead: { address: string; footer: string; vatRate: number; paymentTerms: string; quoteValidityDays: number; quoteIntro: string; quoteOutro: string };
  storage: StorageSettings;
  pcbMask: PcbMaskSettings;
  /** App-Store: eingeschaltete mitgelieferte Anwendungen */
  apps: { installed: Tool[] };
  cadMask: { fields: MaskField[]; catalogs: Catalog[]; askCreateDrawing: boolean; drawingTemplate: string; subassemblies: { code: string; label: string }[] };
  ldap: LdapSettings;
  mail: MailSettings;
  ai: AiSettings;
  backup: BackupSettings;
  time: { roundMinutes: number; maxDailyHours: number; holidayState: string; dailyHours: number };
  security: { internalSecret: string };
  plugins: { enabled: string[] };
  webhooks: { id: string; url: string; events: string[]; secret: string; active: boolean }[];
}

export const DEFAULT_SETTINGS: SettingsMap = {
  company: { name: 'AperioPlan', logoText: 'AperioPlan' },
  presence: { idleMinutes: 10 },
  projectNumbers: DEFAULT_PROJECT_NUMBER_SETTINGS,
  defaultModules: DEFAULT_PROJECT_MODULES,
  kanbanTemplate: [],
  calcRates: DEFAULT_CALC_RATES,
  timeRules: DEFAULT_TIME_RULES,
  numbers: { customer: 'K{NNNN}', supplier: 'L{NNNN}', quote: 'AN-{JJJJ}-{NNNN}', case: 'RK-{JJJJ}-{NNNN}', order: 'B-{JJJJ}-{NNNN}', calculation: 'KA-{JJJJ}-{NNNN}' },
  letterhead: {
    address: '', footer: '', vatRate: 19, paymentTerms: '30 Tage netto', quoteValidityDays: 30,
    quoteIntro: 'vielen Dank für Ihre Anfrage. Gerne bieten wir Ihnen wie folgt an:',
    quoteOutro: 'Wir freuen uns auf Ihren Auftrag. Bei Fragen sind wir gerne für Sie da.',
  },
  storage: { mode: 'local', networkPath: '', projectFolders: DEFAULT_PROJECT_FOLDERS, locations: [], defaultLocation: 'main' },
  pcbMask: DEFAULT_PCB_MASK,
  apps: { installed: PREINSTALLED_APPS },
  cadMask: {
    fields: DEFAULT_MASK_FIELDS,
    catalogs: DEFAULT_CATALOGS,
    askCreateDrawing: true,
    drawingTemplate: 'Firmenvorlage_A3.drwdot',
    subassemblies: [
      { code: '100', label: 'Gestell' },
      { code: '200', label: 'Antrieb' },
      { code: '300', label: 'Pneumatik' },
      { code: '400', label: 'Elektrik' },
      { code: '500', label: 'Verkleidung' },
    ],
  },
  ldap: {
    enabled: false, url: '', bindDn: '', bindPassword: '', baseDn: '',
    userFilter: '(sAMAccountName={{username}})', displayNameAttr: 'displayName', emailAttr: 'mail',
    adminGroupDn: '', teamleadGroupDn: '', tlsRejectUnauthorized: true,
  },
  mail: {
    enabled: false, imapHost: '', imapPort: 993, imapSecure: true,
    smtpHost: '', smtpPort: 587, smtpSecure: false, user: '', password: '', from: '',
  },
  ai: { enabled: false, provider: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1', providers: [], defaultProviderId: null },
  backup: { enabled: true, cron: '0 2 * * *', keep: 14, passphrase: '', targetDir: '', includeFiles: true },
  time: { roundMinutes: 1, maxDailyHours: 10, holidayState: 'BW', dailyHours: 8 },
  security: { internalSecret: '' },
  plugins: { enabled: [] },
  webhooks: [],
};

/** Felder, die nie an Nicht-Administratoren oder in Exporte im Klartext gehen */
export const SECRET_PATHS: [keyof SettingsMap, string][] = [
  ['ldap', 'bindPassword'], ['mail', 'password'], ['ai', 'apiKey'], ['security', 'internalSecret'],
];

export class SettingsService {
  private cache = new Map<string, unknown>();
  constructor(private sql: Sql) {}

  async get<K extends keyof SettingsMap>(key: K): Promise<SettingsMap[K]> {
    if (this.cache.has(key)) return this.cache.get(key) as SettingsMap[K];
    const [row] = await this.sql<{ value: SettingsMap[K] }[]>`select value from settings where key = ${key}`;
    const def = DEFAULT_SETTINGS[key];
    const value = !row ? def : Array.isArray(def) ? row.value : ({ ...(def as object), ...(row.value as object) } as SettingsMap[K]);
    this.cache.set(key, value);
    return value;
  }

  /** Wird nach jeder Änderung aufgerufen (z. B. Speicherorte neu einbinden) */
  onChange?: (key: keyof SettingsMap, value: unknown) => void;

  async set<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]): Promise<void> {
    await this.sql`insert into settings (key, value) values (${key}, ${this.sql.json(value as never)})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    this.cache.delete(key);
    this.onChange?.(key, value);
  }

  async all(): Promise<SettingsMap> {
    const out = {} as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof SettingsMap)[]) out[k] = await this.get(k);
    return out as unknown as SettingsMap;
  }

  /** Geheimnisse durch Platzhalter ersetzen */
  static redact<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]): SettingsMap[K] {
    if (Array.isArray(value)) return value;
    const copy = { ...(value as Record<string, unknown>) };
    for (const [k, f] of SECRET_PATHS) if (k === key && copy[f]) copy[f] = '••••••••';
    if (key === 'ai' && Array.isArray(copy.providers)) copy.providers = (copy.providers as AiProvider[]).map((p) => ({ ...p, apiKey: p.apiKey ? '••••••••' : '' }));
    return copy as SettingsMap[K];
  }

  /** Platzhalter beim Speichern durch den bisherigen Wert ersetzen */
  async mergeSecrets<K extends keyof SettingsMap>(key: K, incoming: SettingsMap[K]): Promise<SettingsMap[K]> {
    if (Array.isArray(incoming)) return incoming;
    const current = (await this.get(key)) as Record<string, unknown>;
    const copy = { ...(incoming as Record<string, unknown>) };
    for (const [k, f] of SECRET_PATHS) if (k === key && copy[f] === '••••••••') copy[f] = current[f];
    if (key === 'ai' && Array.isArray(copy.providers)) {
      const old = (current.providers as AiProvider[] | undefined) ?? [];
      copy.providers = (copy.providers as AiProvider[]).map((p) => (p.apiKey === '••••••••' ? { ...p, apiKey: old.find((o) => o.id === p.id)?.apiKey ?? (p.id === 'standard' ? String(current.apiKey ?? '') : '') } : p));
    }
    return copy as SettingsMap[K];
  }

  clearCache() { this.cache.clear(); }
}
