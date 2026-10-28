import { writeZip } from '../lib/zip';

/**
 * Mitgelieferte Office-Vorlagen, ohne fremde Dateien erzeugt.
 * Platzhalter in {{…}} werden beim Anlegen eines Dokuments ersetzt (siehe fillOfficeTemplate).
 */
export const PLACEHOLDERS = ['Dokumentnummer', 'Titel', 'Art', 'Version', 'Projektnummer', 'Projektname', 'Kunde', 'Datum', 'Ersteller', 'Firma'] as const;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function docx(paragraphs: { text: string; style?: 'title' | 'h' | 'small' | 'normal'; table?: string[][] }[]): Buffer {
  const run = (text: string, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  const para = (p: (typeof paragraphs)[number]) => {
    if (p.table) {
      const rows = p.table.map((r, i) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9000 / r.length)}" w:type="dxa"/></w:tcPr><w:p>${run(c, i === 0 ? '<w:b/>' : '')}</w:p></w:tc>`).join('')}</w:tr>`).join('');
      return `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:color="999999"/>`).join('')}</w:tblBorders></w:tblPr>${rows}</w:tbl><w:p/>`;
    }
    const props = p.style === 'title' ? '<w:b/><w:sz w:val="36"/>' : p.style === 'h' ? '<w:b/><w:sz w:val="26"/>' : p.style === 'small' ? '<w:color w:val="666666"/><w:sz w:val="18"/>' : '';
    return `<w:p><w:pPr><w:spacing w:after="${p.style === 'title' ? 120 : 160}"/></w:pPr>${run(p.text, props)}</w:p>`;
  };
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(para).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;
  return writeZip([
    { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`) },
    { name: '_rels/.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'word/document.xml', data: Buffer.from(document) },
    { name: 'word/styles.xml', data: Buffer.from(styles) },
  ]);
}

function xlsx(rows: string[][], sheetName = 'Tabelle1'): Buffer {
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(c)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`;
  return writeZip([
    { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: '_rels/.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
    { name: 'xl/styles.xml', data: Buffer.from(styles) },
  ]);
}

const head = [
  { text: '{{Firma}}', style: 'small' as const },
  { text: '{{Titel}}', style: 'title' as const },
  { text: 'Dokument {{Dokumentnummer}} · Version {{Version}} · {{Datum}}', style: 'small' as const },
  { text: 'Projekt {{Projektnummer}} {{Projektname}} · Kunde: {{Kunde}} · erstellt von {{Ersteller}}', style: 'small' as const },
];

/** Vorlagen, die bei jeder Installation vorhanden sind */
export const BUILTIN_TEMPLATES: { key: string; name: string; kind: string; ext: string; build: () => Buffer }[] = [
  { key: 'leer-word', name: 'Leeres Word-Dokument mit Kopf', kind: 'Sonstiges', ext: 'docx', build: () => docx([...head, { text: '' }]) },
  {
    key: 'protokoll', name: 'Besprechungsprotokoll', kind: 'Protokoll', ext: 'docx', build: () => docx([...head,
      { text: 'Teilnehmer', style: 'h' }, { text: '' },
      { text: 'Besprochen', style: 'h' }, { text: '' },
      { text: 'Vereinbarte Punkte', style: 'h' },
      { text: '', table: [['Nr.', 'Was', 'Wer', 'Bis wann'], ['1', '', '', ''], ['2', '', '', ''], ['3', '', '', '']] },
    ]),
  },
  {
    key: 'lastenheft', name: 'Lastenheft', kind: 'Lastenheft', ext: 'docx', build: () => docx([...head,
      { text: '1 Ausgangslage', style: 'h' }, { text: '' }, { text: '2 Ziel', style: 'h' }, { text: '' },
      { text: '3 Anforderungen', style: 'h' }, { text: '', table: [['Nr.', 'Anforderung', 'Muss/Kann', 'Bemerkung'], ['3.1', '', '', ''], ['3.2', '', '', '']] },
      { text: '4 Abnahmekriterien', style: 'h' }, { text: '' }, { text: '5 Termine', style: 'h' }, { text: '' },
    ]),
  },
  {
    key: 'pruefbericht', name: 'Prüfbericht', kind: 'Bericht', ext: 'docx', build: () => docx([...head,
      { text: 'Prüfgegenstand', style: 'h' }, { text: '' },
      { text: 'Ergebnisse', style: 'h' }, { text: '', table: [['Merkmal', 'Soll', 'Ist', 'i. O.'], ['', '', '', ''], ['', '', '', '']] },
      { text: 'Bewertung', style: 'h' }, { text: '' },
    ]),
  },
  { key: 'liste-excel', name: 'Excel-Liste mit Kopf', kind: 'Liste', ext: 'xlsx', build: () => xlsx([['Pos.', 'Benennung', 'Menge', 'Bemerkung'], ['1', '', '', '']], 'Liste') },
];

export const emptyDocx = () => docx([{ text: '' }]);
export const emptyXlsx = () => xlsx([['']]);
