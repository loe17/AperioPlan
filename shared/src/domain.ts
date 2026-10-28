/** Gemeinsame Fachbegriffe für Server und Oberfläche. */

export const ROLES = ['admin', 'teamlead', 'member', 'guest'] as const;
export type Role = (typeof ROLES)[number];

export const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Freigabe-Workflow für CAD-Daten (Kapitel 7) */
export const CAD_STATES = ['in_work', 'review', 'released', 'obsolete'] as const;
export type CadState = (typeof CAD_STATES)[number];

export const CAD_TRANSITIONS: Record<CadState, CadState[]> = {
  in_work: ['review'],
  review: ['in_work', 'released'],
  released: ['in_work', 'obsolete'],
  obsolete: [],
};

/** Modulare Projekt-Werkzeuge (Kapitel 8) */
export const PROJECT_MODULES = ['kanban', 'list', 'gantt', 'whiteboard', 'report', 'files', 'cad', 'chat', 'time', 'purchasing', 'calculation'] as const;
export type ProjectModule = (typeof PROJECT_MODULES)[number];
export const DEFAULT_PROJECT_MODULES: ProjectModule[] = ['kanban', 'list', 'gantt', 'files', 'cad', 'chat', 'time'];

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const PROCUREMENT_TYPES = ['make', 'buy', 'standard'] as const;
export type ProcurementType = (typeof PROCUREMENT_TYPES)[number];

/** Felddefinition der vom Administrator anpassbaren Speichermaske (Kapitel 7.1) */
export interface MaskField {
  key: string;            // Name der SolidWorks-Eigenschaft, z. B. "Benennung1"
  label: string;          // Anzeigename
  type: 'text' | 'textarea' | 'select' | 'number' | 'checkbox';
  required: boolean;
  catalog?: string;       // Name des Dropdown-Katalogs bei type=select
  defaultValue?: string;
  appliesTo?: ('part' | 'assembly' | 'drawing')[];
}

export interface Catalog {
  name: string;
  label: string;
  values: string[];
}

export const DEFAULT_MASK_FIELDS: MaskField[] = [
  { key: 'Benennung1', label: 'Benennung 1', type: 'text', required: true },
  { key: 'Benennung2', label: 'Benennung 2', type: 'text', required: false },
  { key: 'Werkstoff', label: 'Werkstoff', type: 'select', required: true, catalog: 'werkstoffe', appliesTo: ['part'] },
  { key: 'Oberflaeche', label: 'Oberfläche', type: 'select', required: false, catalog: 'oberflaechen', appliesTo: ['part'] },
  { key: 'Norm', label: 'Norm', type: 'select', required: false, catalog: 'normen' },
  { key: 'Beschaffung', label: 'Beschaffungsart', type: 'select', required: true, catalog: 'beschaffung' },
  { key: 'Gezeichnet', label: 'Zeichner', type: 'text', required: true },
];

export const DEFAULT_CATALOGS: Catalog[] = [
  { name: 'werkstoffe', label: 'Werkstoffe', values: ['1.4301', '1.4404', 'S235JR', 'S355J2', 'AlMg3', 'AlMgSi0,5', 'POM-C', 'PA6'] },
  { name: 'oberflaechen', label: 'Oberflächen', values: ['ohne', 'eloxiert natur', 'eloxiert schwarz', 'pulverbeschichtet RAL 7016', 'verzinkt', 'brüniert'] },
  { name: 'normen', label: 'DIN-Normen', values: ['DIN 912', 'DIN 933', 'DIN 934', 'DIN 125', 'ISO 4762', 'ISO 7380'] },
  { name: 'beschaffung', label: 'Beschaffungsart', values: ['Eigenfertigung', 'Kaufteil', 'Normteil'] },
];
