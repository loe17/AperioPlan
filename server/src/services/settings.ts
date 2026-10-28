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

export type PhoneProvider = 'none' | 'fritzbox' | 'sipgate' | 'placetel' | '3cx' | 'asterisk' | 'generic';
export interface PhoneSettings {
  provider: PhoneProvider;
  /** Rufnummern vereinheitlichen: Landesvorwahl ohne +, Ortsvorwahl ohne 0, Amtsholung */
  countryCode: string; areaCode: string; outsideLinePrefix: string;
  /** Teil der Webhook-Adressen für sipgate, Placetel, 3CX und die allgemeine Schnittstelle */
  webhookSecret: string;
  /** Anruf ohne zugeordnete Nebenstelle allen Telefonie-Nutzern anzeigen */
  popupForAll: boolean;
  /** Wählen per Klick: tel:-Link, Softphone im Browser, FRITZ!Box-Wählhilfe oder sipgate */
  dialMethod: 'tel' | 'softphone' | 'fritzbox' | 'sipgate';
  fritzHost: string; fritzMonitorPort: number; fritzUser: string; fritzPassword: string;
  amiHost: string; amiPort: number; amiUser: string; amiPassword: string; amiContext: string;
  sipgateTokenId: string; sipgateToken: string;
  /** Softphone: SIP über WebSocket (z. B. wss://pbx.firma.de:8089/ws) */
  sipWsUrl: string; sipDomain: string;
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
  numbers: { customer: string; supplier: string; quote: string; case: string; order: string; calculation: string; article: string; asset: string; invoice: string; [key: string]: string };
  /** Rechnungen: Pflichtangaben für Rechnung und E-Rechnung, Übergabe an die Buchhaltung */
  invoicing: InvoicingSettings;
  /** Finanzbuchhaltung: Freigaben, Mahnstufen, Konten */
  finance: FinanceSettings;
  /** Lohnabrechnung: Berechtigte, Konten, Zuschläge */
  payroll: PayrollSettings;
  /** Service-Einsätze: Verrechnungssätze */
  service: { hourlyRate: number; kmRate: number; travelFlat: number; mailText: string };
  /** Spesen: wer Abrechnungen bearbeitet und auszahlt, Kilometergeld */
  expenses: { managerIds: string[]; kmRate: number; approverIds: string[] };
  /** Einsatzplanung: wer Pläne bearbeitet (zusätzlich Administratoren und Teamleiter) */
  planning: { plannerIds: string[] };
  /** Personal: wer Personalakten und Bewerbungen sieht */
  hr: { managerIds: string[]; applicantRetentionMonths: number; documentCategories: string[] };
  /** Unterweisungen: wer Schulungen anlegt und Teilnahmen bestätigt */
  training: { managerIds: string[] };
  /** Fuhrpark: Fuhrparkverantwortliche, Führerscheinkontrolle */
  fleet: { managerIds: string[]; licenseCheckMonths: number };
  /** Kundenanfragen: Reaktionszeiten (Stunden bis zur ersten Antwort), Kategorien, Formular */
  helpdesk: { sla: Record<'low' | 'normal' | 'high' | 'urgent', number>; categories: string[]; publicForm: boolean; autoReply: string; signature: string; supportEmail: string };
  /** Firmendaten für Angebote und Bestellungen */
  letterhead: { address: string; footer: string; vatRate: number; paymentTerms: string; quoteValidityDays: number; quoteIntro: string; quoteOutro: string };
  storage: StorageSettings;
  pcbMask: PcbMaskSettings;
  /** App-Store: eingeschaltete mitgelieferte Anwendungen */
  apps: { installed: Tool[] };
  phone: PhoneSettings;
  board: { categories: string[]; marketCategories: string[]; employeesMayPost: boolean };
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

export interface InvoicingSettings {
  legalName: string; street: string; zip: string; city: string; countryCode: string;
  vatId: string; taxNumber: string; registry: string; managingDirector: string;
  iban: string; bic: string; bankName: string;
  contactName: string; contactPhone: string; contactEmail: string;
  dueDays: number; skonto: { percent: number; days: number } | null;
  defaultFormat: 'zugferd' | 'xrechnung' | 'pdf'; smallBusiness: boolean;
  mailSubject: string; mailText: string;
  accountingEmail: string;
  datev: { consultantNo: string; clientNo: string; chart: 'SKR03' | 'SKR04'; accountLength: number; firstDebtor: number; revenue19: string; revenue7: string; revenueEu: string; revenueExport: string; revenueReverse: string; revenueSmall: string };
}

export interface FinanceSettings {
  approvalLimit: number; approverIds: string[]; taxBasis: 'soll' | 'ist'; firstCreditor: number;
  dunning: { days: number; fee: number; title: string; text: string }[];
  expenseAccounts: { account: string; label: string; rate: number }[];
}

export interface PayrollSettings {
  /** Wer Löhne sehen und abrechnen darf (zusätzlich zu Administratoren) */
  managerIds: string[];
  firstPersonnelNo: number;
  /** Betriebsnummer und Bundesland der Betriebsstätte */
  companyNo: string; state: string;
  /** Umlagesätze der Krankenkasse (Voreinstellung für neue Mitarbeiter) */
  u1: number; u2: number;
  /** Zuschläge aus der Zeiterfassung in Prozent */
  surcharges: { night: number; sunday: number; holiday: number };
  /** Zahltag (Tag im Folgemonat, 0 = letzter Tag des Monats) */
  payDay: number;
  /** Sachkonten für die Buchung (SKR03) */
  accounts: { wages: string; salaries: string; minijob: string; social: string; flatTax: string; taxFree: string; liabilityNet: string; liabilityTax: string; liabilitySv: string; liabilityMini: string };
}

export const DEFAULT_SETTINGS: SettingsMap = {
  company: { name: 'AperioPlan', logoText: 'AperioPlan' },
  presence: { idleMinutes: 10 },
  projectNumbers: DEFAULT_PROJECT_NUMBER_SETTINGS,
  defaultModules: DEFAULT_PROJECT_MODULES,
  kanbanTemplate: [],
  calcRates: DEFAULT_CALC_RATES,
  timeRules: DEFAULT_TIME_RULES,
  numbers: { customer: 'K{NNNN}', supplier: 'L{NNNN}', quote: 'AN-{JJJJ}-{NNNN}', case: 'RK-{JJJJ}-{NNNN}', order: 'B-{JJJJ}-{NNNN}', calculation: 'KA-{JJJJ}-{NNNN}', article: 'A{NNNNN}', asset: 'INV-{NNNN}', invoice: 'RE-{JJJJ}-{NNNN}',
    maintenance: 'IH-{JJJJ}-{NNNN}', qmPlan: 'PP-{NNNN}', inspection: 'PR-{JJJJ}-{NNNN}', gauge: 'MM-{NNNN}', eightD: '8D-{JJJJ}-{NNN}', mfgOrder: 'FA-{JJJJ}-{NNNN}', change: 'AE-{JJJJ}-{NNN}',
    service: 'SE-{JJJJ}-{NNNN}', ticket: 'T{JJ}-{NNNNN}', contract: 'V-{NNNN}', expense: 'SP-{JJ}-{NNNN}' },
  invoicing: {
    legalName: '', street: '', zip: '', city: '', countryCode: 'DE', vatId: '', taxNumber: '', registry: '', managingDirector: '',
    iban: '', bic: '', bankName: '', contactName: '', contactPhone: '', contactEmail: '',
    dueDays: 14, skonto: null, defaultFormat: 'zugferd', smallBusiness: false,
    mailSubject: 'Rechnung {nummer}', mailText: 'Guten Tag,\n\nanbei erhalten Sie unsere Rechnung {nummer} über {betrag}, zahlbar bis {faellig}.\n\nMit freundlichen Grüßen\n{firma}',
    accountingEmail: '',
    datev: { consultantNo: '', clientNo: '', chart: 'SKR03', accountLength: 4, firstDebtor: 10000, revenue19: '8400', revenue7: '8300', revenueEu: '8125', revenueExport: '8120', revenueReverse: '8337', revenueSmall: '8195' },
  },
  finance: {
    approvalLimit: 1000, approverIds: [], taxBasis: 'soll', firstCreditor: 70000,
    dunning: [
      { days: 7, fee: 0, title: 'Zahlungserinnerung', text: 'sicher ist es Ihrer Aufmerksamkeit entgangen: Für die unten genannte Rechnung konnten wir noch keinen Zahlungseingang feststellen. Wir bitten Sie, den offenen Betrag in den nächsten Tagen zu überweisen. Sollten Sie inzwischen gezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.' },
      { days: 14, fee: 5, title: '1. Mahnung', text: 'leider ist die unten genannte Rechnung trotz unserer Erinnerung noch nicht beglichen. Bitte überweisen Sie den offenen Betrag einschließlich Mahngebühr innerhalb von 7 Tagen.' },
      { days: 14, fee: 10, title: '2. Mahnung', text: 'trotz zweimaliger Aufforderung ist die unten genannte Rechnung noch offen. Wir bitten Sie dringend um Zahlung innerhalb von 7 Tagen. Danach behalten wir uns weitere Schritte vor.' },
    ],
    expenseAccounts: [
      { account: '3400', label: 'Wareneingang 19 % (Material)', rate: 19 }, { account: '3300', label: 'Wareneingang 7 %', rate: 7 },
      { account: '3100', label: 'Fremdleistungen', rate: 19 }, { account: '4210', label: 'Miete', rate: 19 }, { account: '4240', label: 'Strom, Gas, Wasser', rate: 19 },
      { account: '4360', label: 'Versicherungen', rate: 0 }, { account: '4530', label: 'Kfz-Kosten (laufend)', rate: 19 }, { account: '4600', label: 'Werbung', rate: 19 },
      { account: '4650', label: 'Bewirtung', rate: 19 }, { account: '4670', label: 'Reisekosten', rate: 19 }, { account: '4806', label: 'Wartung Software und Hardware', rate: 19 },
      { account: '4855', label: 'Geringwertige Wirtschaftsgüter', rate: 19 }, { account: '4900', label: 'Sonstige betriebliche Aufwendungen', rate: 19 },
      { account: '4920', label: 'Telefon, Internet', rate: 19 }, { account: '4930', label: 'Bürobedarf', rate: 19 }, { account: '4940', label: 'Zeitschriften, Bücher', rate: 7 },
      { account: '4950', label: 'Rechts- und Beratungskosten', rate: 19 }, { account: '4970', label: 'Nebenkosten des Geldverkehrs', rate: 0 }, { account: '0420', label: 'Technische Anlagen und Maschinen', rate: 19 },
    ],
  },
  planning: { plannerIds: [] },
  expenses: { managerIds: [], kmRate: 0.3, approverIds: [] },
  hr: { managerIds: [], applicantRetentionMonths: 6, documentCategories: ['Arbeitsvertrag', 'Zeugnis', 'Bescheinigung', 'Abmahnung', 'Weiterbildung', 'Sonstiges'] },
  training: { managerIds: [] },
  fleet: { managerIds: [], licenseCheckMonths: 6 },
  service: { hourlyRate: 85, kmRate: 0.6, travelFlat: 0, mailText: 'Guten Tag,\n\nanbei erhalten Sie den Servicebericht zu unserem Einsatz.\n\nMit freundlichen Grüßen' },
  helpdesk: { sla: { low: 72, normal: 24, high: 8, urgent: 4 }, categories: ['Frage', 'Störung', 'Ersatzteil', 'Reklamation'], publicForm: true,
    autoReply: 'vielen Dank für Ihre Anfrage. Wir haben sie unter der Nummer {nummer} aufgenommen und melden uns schnellstmöglich.', signature: '', supportEmail: '' },
  payroll: {
    managerIds: [], firstPersonnelNo: 1001, companyNo: '', state: 'BW', u1: 1.6, u2: 0.44,
    surcharges: { night: 25, sunday: 50, holiday: 125 }, payDay: 0,
    accounts: { wages: '4110', salaries: '4120', minijob: '4190', social: '4130', flatTax: '4199', taxFree: '4145', liabilityNet: '1740', liabilityTax: '1741', liabilitySv: '1742', liabilityMini: '1742' },
  },
  letterhead: {
    address: '', footer: '', vatRate: 19, paymentTerms: '30 Tage netto', quoteValidityDays: 30,
    quoteIntro: 'vielen Dank für Ihre Anfrage. Gerne bieten wir Ihnen wie folgt an:',
    quoteOutro: 'Wir freuen uns auf Ihren Auftrag. Bei Fragen sind wir gerne für Sie da.',
  },
  storage: { mode: 'local', networkPath: '', projectFolders: DEFAULT_PROJECT_FOLDERS, locations: [], defaultLocation: 'main' },
  pcbMask: DEFAULT_PCB_MASK,
  apps: { installed: PREINSTALLED_APPS },
  board: {
    categories: ['Allgemein', 'Personal', 'Arbeitssicherheit', 'Veranstaltungen', 'IT', 'Kantine', 'Gesucht und gefunden'],
    marketCategories: ['Elektronik', 'Möbel', 'Werkzeug', 'Fahrzeuge und Zubehör', 'Freizeit und Sport', 'Haus und Garten', 'Kinder', 'Firmen-Restposten', 'Sonstiges'],
    employeesMayPost: true,
  },
  phone: {
    provider: 'none', countryCode: '49', areaCode: '', outsideLinePrefix: '', webhookSecret: '', popupForAll: true, dialMethod: 'tel',
    fritzHost: 'fritz.box', fritzMonitorPort: 1012, fritzUser: '', fritzPassword: '',
    amiHost: '', amiPort: 5038, amiUser: '', amiPassword: '', amiContext: 'from-internal',
    sipgateTokenId: '', sipgateToken: '', sipWsUrl: '', sipDomain: '',
  },
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
  ['phone', 'fritzPassword'], ['phone', 'amiPassword'], ['phone', 'sipgateToken'],
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
