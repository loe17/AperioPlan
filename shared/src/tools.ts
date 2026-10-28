/**
 * Werkzeuge, die der Administrator je Benutzer (bzw. als Voreinstellung je Abteilung) freischaltet.
 * Nicht freigeschaltete Werkzeuge fehlen in der Seitenleiste und sind auch über die Schnittstelle gesperrt.
 */
export const TOOLS = ['chat', 'mail', 'calendar', 'resources', 'time', 'absences', 'notes', 'kvp', 'cad', 'pcb', 'crm', 'purchasing', 'calculation', 'ai',
  'meetings', 'phone', 'forms', 'board', 'viewer3d', 'mindmap', 'knowledge', 'inventory', 'warehouse', 'finance', 'payroll', 'maintenance', 'quality', 'manufacturing', 'plm', 'service', 'helpdesk', 'contracts', 'booking', 'events', 'expenses', 'planning', 'hr', 'training', 'fleet'] as const;
export type Tool = (typeof TOOLS)[number];

export const TOOL_LABELS: Record<Tool, string> = {
  chat: 'Chat und Videoanrufe',
  mail: 'E-Mail',
  calendar: 'Teamkalender und Termine',
  resources: 'Ressourcen buchen',
  time: 'Stempeluhr und Zeiterfassung',
  absences: 'Urlaubskonto',
  notes: 'Private Notizen',
  kvp: 'KVP-Ideenbox',
  cad: 'CAD-Bridge',
  pcb: 'PCB-Bridge',
  crm: 'CRM (Kunden)',
  purchasing: 'Einkauf',
  calculation: 'Kalkulation',
  ai: 'KI-Assistent',
  meetings: 'Meetings (Videokonferenzen)',
  phone: 'Telefonie',
  forms: 'Formulare und Umfragen',
  board: 'Schwarzes Brett und Marktplatz',
  viewer3d: '3D-Viewer',
  mindmap: 'Mindmaps',
  knowledge: 'Wissensdatenbank',
  inventory: 'Inventar',
  warehouse: 'Lager',
  finance: 'Finanzbuchhaltung',
  payroll: 'Lohnabrechnung',
  fleet: 'Fuhrpark',
  training: 'Unterweisungen und Schulungen',
  hr: 'Personal',
  planning: 'Einsatzplanung',
  expenses: 'Spesen und Reisekosten',
  events: 'Messen und Veranstaltungen',
  booking: 'Terminbuchung',
  contracts: 'Wartungsverträge',
  helpdesk: 'Kundenanfragen',
  service: 'Service-Einsätze',
  plm: 'Änderungsmanagement',
  manufacturing: 'Fertigung',
  quality: 'Qualität',
  maintenance: 'Instandhaltung',
};

/** Schnittstellen-Bereiche, die zu einem Werkzeug gehören (Präfix nach /api) */
export const TOOL_ROUTES: [string, Tool][] = [
  ['/chat', 'chat'], ['/calls', 'chat'], ['/mail', 'mail'], ['/mailbox', 'mail'], ['/calendar/team', 'calendar'], ['/calendar/events', 'calendar'], ['/calendar/accounts', 'calendar'],
  ['/resources', 'resources'], ['/time', 'time'], ['/absences', 'absences'], ['/notes', 'notes'], ['/kvp', 'kvp'],
  ['/cad', 'cad'], ['/pcb', 'pcb'], ['/crm', 'crm'], ['/purchasing', 'purchasing'], ['/calculations', 'calculation'], ['/ai', 'ai'],
  ['/meetings', 'meetings'], ['/phone', 'phone'], ['/forms', 'forms'], ['/board', 'board'], ['/mindmaps', 'mindmap'], ['/knowledge', 'knowledge'],
  ['/inventory', 'inventory'], ['/warehouse', 'warehouse'], ['/finance', 'finance'], ['/payroll', 'payroll'], ['/crm/invoices', 'crm'],
  ['/maintenance', 'maintenance'],
];

/** Anlässe für Benachrichtigungen; jeder Benutzer schaltet sie für AperioPlan und E-Mail einzeln */
export const NOTIFY_KINDS: { kind: string; label: string; app: boolean; mail: boolean }[] = [
  { kind: 'chat.message', label: 'Neue Chatnachricht', app: true, mail: false },
  { kind: 'mention', label: 'Ich wurde erwähnt (@)', app: true, mail: true },
  { kind: 'project.member', label: 'Zu einem Projekt hinzugefügt', app: true, mail: true },
  { kind: 'task.assigned', label: 'Aufgabe zugewiesen', app: true, mail: true },
  { kind: 'task.watch', label: 'Als Beobachter einer Aufgabe eingetragen', app: true, mail: false },
  { kind: 'task.status', label: 'Status einer beobachteten Aufgabe geändert', app: true, mail: false },
  { kind: 'task.review', label: 'Aufgabe wartet auf Prüfung', app: true, mail: false },
  { kind: 'task.due', label: 'Frist morgen fällig', app: true, mail: true },
  { kind: 'comment', label: 'Kommentar zu meiner Aufgabe', app: true, mail: false },
  { kind: 'absence', label: 'Urlaub beantragt oder entschieden', app: true, mail: true },
  { kind: 'time', label: 'Zeitkorrektur und Hinweise der Stempeluhr', app: true, mail: false },
  { kind: 'resource', label: 'Ressourcen-Buchungen und Genehmigungen', app: true, mail: false },
  { kind: 'cad', label: 'CAD- und PCB-Freigaben', app: true, mail: false },
  { kind: 'purchasing', label: 'Einkauf: Bestellungen und Lieferungen', app: true, mail: true },
  { kind: 'crm', label: 'CRM: Termine und Wiedervorlagen', app: true, mail: true },
  { kind: 'calendar', label: 'Termineinladungen', app: true, mail: true },
  { kind: 'kvp', label: 'KVP-Ideen', app: true, mail: false },
  { kind: 'files', label: 'Dateien von Externen hochgeladen', app: true, mail: true },
  { kind: 'board', label: 'Schwarzes Brett und Marktplatz', app: true, mail: false },
  { kind: 'shared', label: 'Mindmap oder Wissensartikel mit mir geteilt', app: true, mail: false },
  { kind: 'inventory', label: 'Inventar: Prüftermine und Übergaben', app: true, mail: true },
  { kind: 'warehouse', label: 'Lager: Mindestbestand unterschritten', app: true, mail: false },
  { kind: 'payroll', label: 'Lohnzettel bereitgestellt', app: true, mail: true },
  { kind: 'fleet', label: 'Fuhrpark: HU, Wartung und Führerscheinkontrolle', app: true, mail: true },
  { kind: 'training', label: 'Unterweisungen: fällige Schulungen', app: true, mail: true },
  { kind: 'hr', label: 'Personal: Dokumente, Gespräche, Bewerbungen', app: true, mail: true },
  { kind: 'planning', label: 'Einsatzplanung: veröffentlichte Schichten', app: true, mail: false },
  { kind: 'expenses', label: 'Spesen: Abrechnungen zur Freigabe und Entscheidungen', app: true, mail: true },
  { kind: 'events', label: 'Messen und Veranstaltungen', app: true, mail: false },
  { kind: 'booking', label: 'Terminbuchung: neue und abgesagte Termine', app: true, mail: true },
  { kind: 'contracts', label: 'Verträge: Rechnungen und Kündigungsfristen', app: true, mail: true },
  { kind: 'helpdesk', label: 'Kundenanfragen: neue Tickets und Antworten', app: true, mail: true },
  { kind: 'service', label: 'Service-Einsätze: Planung und Änderungen', app: true, mail: true },
  { kind: 'plm', label: 'Änderungsanträge zur Prüfung und Entscheidung', app: true, mail: true },
  { kind: 'manufacturing', label: 'Fertigung: Aufträge und Rückmeldungen', app: true, mail: false },
  { kind: 'quality', label: 'Qualität: Prüfungen, Messmittel und 8D', app: true, mail: true },
  { kind: 'maintenance', label: 'Instandhaltung: Aufträge und fällige Wartungen', app: true, mail: true },
  { kind: 'other', label: 'Sonstiges', app: true, mail: false },
];

/** Ordnet einen Benachrichtigungs-Typ (z. B. 'absence.decision') seinem Anlass zu */
export function notifyKindOf(kind: string): string {
  if (NOTIFY_KINDS.some((k) => k.kind === kind)) return kind;
  const head = kind.split('.')[0]!;
  if (NOTIFY_KINDS.some((k) => k.kind === head)) return head;
  const map: Record<string, string> = { project: 'project.member', absence: 'absence', time: 'time', resource: 'resource', resources: 'resource', cad: 'cad', pcb: 'cad', purchasing: 'purchasing', crm: 'crm', calendar: 'calendar', kvp: 'kvp', link: 'files', upload: 'files', chat: 'chat.message', board: 'board', mindmap: 'shared', kb: 'shared', inventory: 'inventory', warehouse: 'warehouse', payroll: 'payroll', maintenance: 'maintenance' };
  return map[head] ?? 'other';
}
