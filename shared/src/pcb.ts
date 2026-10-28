import type { Catalog, MaskField } from './domain';

/** PCB-Bridge (Leiterplatten): Speichermaske, Nummern und Fertigungsdaten */
export const PCB_EXPORT_FORMATS = ['gerber', 'drill', 'pos', 'bom', 'schematic', 'step'] as const;
export type PcbExportFormat = (typeof PCB_EXPORT_FORMATS)[number];
export const PCB_EXPORT_LABELS: Record<PcbExportFormat, string> = {
  gerber: 'Gerber (Lagen)', drill: 'Bohrdaten', pos: 'Bestückungsliste', bom: 'Stückliste (CSV)', schematic: 'Schaltplan (PDF)', step: '3D-Modell (STEP)',
};

export interface PcbMaskSettings {
  /** Aufbau der Leiterplatten-Nummer; {PROJEKT} = Projektnummer, {NN} = laufende Nummer im Projekt. Der Versionsstand wird mit „-00“ angehängt. */
  numberPattern: string;
  fields: MaskField[];
  catalogs: Catalog[];
  /** Unterordner im Projekt für Leiterplatten */
  folder: string;
  /** Fertigungsdaten, die bei der Freigabe erzeugt werden */
  exportFormats: PcbExportFormat[];
}

export const DEFAULT_PCB_MASK: PcbMaskSettings = {
  numberPattern: '{PROJEKT}-E{NN}',
  folder: '05_Elektronik',
  exportFormats: [...PCB_EXPORT_FORMATS],
  fields: [
    { key: 'Lagen', label: 'Lagenzahl', type: 'select', required: true, catalog: 'lagen', defaultValue: '2' },
    { key: 'Dicke', label: 'Leiterplattendicke', type: 'select', required: true, catalog: 'dicke', defaultValue: '1,6 mm' },
    { key: 'Oberflaeche', label: 'Oberfläche', type: 'select', required: true, catalog: 'pcb_oberflaeche' },
    { key: 'Kupfer', label: 'Kupferstärke', type: 'select', required: false, catalog: 'kupfer', defaultValue: '35 µm' },
    { key: 'Loetstopp', label: 'Lötstoppfarbe', type: 'select', required: false, catalog: 'loetstopp', defaultValue: 'grün' },
    { key: 'Gezeichnet', label: 'Bearbeiter', type: 'text', required: true },
  ],
  catalogs: [
    { name: 'lagen', label: 'Lagenzahl', values: ['1', '2', '4', '6', '8', '10'] },
    { name: 'dicke', label: 'Leiterplattendicke', values: ['0,8 mm', '1,0 mm', '1,2 mm', '1,6 mm', '2,0 mm'] },
    { name: 'pcb_oberflaeche', label: 'Oberflächen', values: ['HAL bleifrei', 'ENIG (chem. Gold)', 'OSP', 'chem. Zinn'] },
    { name: 'kupfer', label: 'Kupferstärke', values: ['18 µm', '35 µm', '70 µm', '105 µm'] },
    { name: 'loetstopp', label: 'Lötstoppfarbe', values: ['grün', 'schwarz', 'blau', 'rot', 'weiß'] },
  ],
};

/** Nummer einer Leiterplatte ohne Versionsstand, z. B. 0100-E01 */
export function pcbNumber(pattern: string, projectNumber: string, seq: number): string {
  return (pattern || DEFAULT_PCB_MASK.numberPattern)
    .replace(/\{PROJEKT\}/g, projectNumber)
    .replace(/\{(N+)\}/g, (_, n: string) => String(seq).padStart(n.length, '0'));
}

export const pcbFullNumber = (number: string, revision: number) => `${number}-${String(revision).padStart(2, '0')}`;

/** Prüft die Nummernvorlage: Laufnummer muss enthalten sein, keine Zeichen, die in Dateinamen stören */
export function validatePcbPattern(pattern: string): string | null {
  if (!/\{N+\}/.test(pattern)) return 'Die Vorlage braucht eine laufende Nummer, z. B. {NN}';
  if (/[\\/:*?"<>|\s]/.test(pattern.replace(/\{[A-Z]+\}/g, ''))) return 'Bitte keine Leer- oder Sonderzeichen wie / \\ : * ? verwenden';
  return null;
}
