/**
 * Bausteine für PDF/A-3 (Archiv-PDF, Grundlage für ZUGFeRD/Factur-X):
 * Farbprofil für die „Output Intent“-Angabe und XMP-Metadaten.
 */

/** Kleines RGB-Farbprofil (ICC v2, sRGB-Primärfarben, Gamma 2,2) – wird selbst erzeugt statt mitgeliefert */
export function srgbIcc(): Buffer {
  const s15 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32BE(Math.round(v * 65536)); return b; };
  const xyz = (x: number, y: number, z: number) => Buffer.concat([Buffer.from('XYZ \0\0\0\0', 'latin1'), s15(x), s15(y), s15(z)]);
  const curv = () => { const b = Buffer.alloc(14); b.write('curv', 0, 'latin1'); b.writeUInt32BE(1, 8); b.writeUInt16BE(0x0233, 12); return b; };
  const desc = (text: string) => {
    const ascii = Buffer.from(`${text}\0`, 'latin1');
    const b = Buffer.alloc(12 + ascii.length + 4 + 4 + 2 + 1 + 67);
    b.write('desc', 0, 'latin1'); b.writeUInt32BE(ascii.length, 8); ascii.copy(b, 12);
    return b;
  };
  const text = (t: string) => Buffer.concat([Buffer.from('text\0\0\0\0', 'latin1'), Buffer.from(`${t}\0`, 'latin1')]);
  const tags: [string, Buffer][] = [
    ['desc', desc('sRGB (AperioPlan)')], ['cprt', text('Public Domain')], ['wtpt', xyz(0.9642, 1, 0.8249)],
    ['rXYZ', xyz(0.4361, 0.2225, 0.0139)], ['gXYZ', xyz(0.3851, 0.7169, 0.0971)], ['bXYZ', xyz(0.1431, 0.0606, 0.7141)],
    ['rTRC', curv()], ['gTRC', curv()], ['bTRC', curv()],
  ];
  const tableLen = 4 + tags.length * 12;
  let off = 128 + tableLen;
  const datas: Buffer[] = [];
  const table = Buffer.alloc(tableLen);
  table.writeUInt32BE(tags.length, 0);
  tags.forEach(([sig, d], i) => {
    const pad = (4 - (d.length % 4)) % 4;
    table.write(sig, 4 + i * 12, 'latin1'); table.writeUInt32BE(off, 8 + i * 12); table.writeUInt32BE(d.length, 12 + i * 12);
    datas.push(d, Buffer.alloc(pad)); off += d.length + pad;
  });
  const head = Buffer.alloc(128);
  head.writeUInt32BE(off, 0);
  head.writeUInt32BE(0x02100000, 8);
  head.write('mntr', 12, 'latin1'); head.write('RGB ', 16, 'latin1'); head.write('XYZ ', 20, 'latin1');
  [2026, 1, 1, 0, 0, 0].forEach((v, i) => head.writeUInt16BE(v, 24 + i * 2));
  head.write('acsp', 36, 'latin1');
  s15(0.9642).copy(head, 68); s15(1).copy(head, 72); s15(0.8249).copy(head, 76);
  return Buffer.concat([head, table, ...datas]);
}

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** XMP-Metadaten für PDF/A-3b, optional mit Factur-X/ZUGFeRD-Angaben */
export function xmp(o: { title: string; author: string; producer: string; created: string; facturx?: { conformance: string; fileName: string } }) {
  const fx = o.facturx;
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>application/pdf</dc:format>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${x(o.title)}</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq><rdf:li>${x(o.author)}</rdf:li></rdf:Seq></dc:creator></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Producer>${x(o.producer)}</pdf:Producer></rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreatorTool>${x(o.producer)}</xmp:CreatorTool><xmp:CreateDate>${o.created}</xmp:CreateDate><xmp:ModifyDate>${o.created}</xmp:ModifyDate><xmp:MetadataDate>${o.created}</xmp:MetadataDate></rdf:Description>
${fx ? `<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>${fx.fileName}</fx:DocumentFileName><fx:Version>1.0</fx:Version><fx:ConformanceLevel>${fx.conformance}</fx:ConformanceLevel></rdf:Description>
<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema><pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI><pdfaSchema:prefix>fx</pdfaSchema:prefix>
<pdfaSchema:property><rdf:Seq>
<rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The name of the embedded XML document</pdfaProperty:description></rdf:li>
<rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The type of the hybrid document in capital letters, e.g. INVOICE or ORDER</pdfaProperty:description></rdf:li>
<rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the standard applying to the embedded XML document</pdfaProperty:description></rdf:li>
<rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the embedded XML document</pdfaProperty:description></rdf:li>
</rdf:Seq></pdfaSchema:property></rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description>` : ''}
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}
