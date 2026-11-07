/**
 * Signaturen: gestalten oder fertiges HTML einfügen, Platzhalter aus dem Benutzerprofil, Vorschau.
 * Der Editor wird auch für die Firmen-Signatur in den Einstellungen verwendet.
 */
import { useEffect, useRef, useState } from 'react';
import { del, patch, post } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { Confirm, Empty, Field, Modal, useAction } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { PLACEHOLDER_HELP, type SignatureData } from './types';

/** Bild verkleinern (Logo) und als eingebettete Daten zurückgeben – wird beim Senden in die E-Mail eingebettet */
async function imageToDataUrl(file: File, maxWidth = 360): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, maxWidth / img.width);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
  } finally { URL.revokeObjectURL(url); }
}

export function SignatureEditor({ value, onChange, placeholders = Object.keys(PLACEHOLDER_HELP) }: { value: string; onChange: (html: string) => void; placeholders?: string[] }) {
  const [mode, setMode] = useState<'design' | 'html'>('design');
  const ref = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState('');
  useEffect(() => { if (mode === 'design' && ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value; }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => { void post<{ html: string }>('/mailbox/signatures/preview', { html: value }).then((r) => setPreview(r.html)).catch(() => {}); }, 400);
    return () => clearTimeout(t);
  }, [value]);
  const sync = () => { if (ref.current) onChange(ref.current.innerHTML); };
  const cmd = (c: string, v?: string) => { ref.current?.focus(); document.execCommand(c, false, v); sync(); };
  const insert = (html: string) => {
    if (mode === 'html') { onChange(`${value}${html}`); return; }
    ref.current?.focus(); document.execCommand('insertHTML', false, html); sync();
  };
  return (
    <div className="sig-editor">
      <div className="seg" style={{ marginBottom: 6 }}>
        <button className={`btn sm ${mode === 'design' ? 'primary' : ''}`} onClick={() => setMode('design')}><Icon name="pen" /> Gestalten</button>
        <button className={`btn sm ${mode === 'html' ? 'primary' : ''}`} onClick={() => { sync(); setMode('html'); }}><Icon name="text" /> HTML einfügen</button>
      </div>
      {mode === 'design' ? <>
        <div className="mb-format">
          <button className="btn ghost sm" title="Fett" onClick={() => cmd('bold')}><b>F</b></button>
          <button className="btn ghost sm" title="Kursiv" onClick={() => cmd('italic')}><i>K</i></button>
          <button className="btn ghost sm" title="Unterstrichen" onClick={() => cmd('underline')}><u>U</u></button>
          <button className="btn ghost sm" title="Link" onClick={() => { const u = prompt('Adresse des Links (z. B. https://firma.de)'); if (u) cmd('createLink', u); }}><Icon name="link" /></button>
          <select onChange={(e) => { cmd('foreColor', e.target.value); e.target.value = ''; }} defaultValue="" style={{ width: 'auto' }}><option value="" disabled>Farbe</option><option value="#000000">Schwarz</option><option value="#6b7280">Grau</option><option value="#1d4ed8">Blau</option><option value="#c0392b">Rot</option><option value="#15803d">Grün</option></select>
          <select onChange={(e) => { cmd('fontSize', e.target.value); e.target.value = ''; }} defaultValue="" style={{ width: 'auto' }}><option value="" disabled>Größe</option><option value="1">klein</option><option value="2">normal</option><option value="4">groß</option></select>
          <label className="btn ghost sm" title="Bild oder Logo einfügen"><Icon name="image" /><input type="file" accept="image/png,image/jpeg,image/gif" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) insert(`<img src="${await imageToDataUrl(f)}" alt="">`); e.target.value = ''; }} /></label>
          <select value="" onChange={(e) => { if (e.target.value) insert(`{${e.target.value}}`); }} style={{ width: 'auto' }} title="Platzhalter werden beim Schreiben mit Ihren Angaben gefüllt">
            <option value="">Platzhalter …</option>{placeholders.map((p) => <option key={p} value={p}>{`{${p}}`} – {PLACEHOLDER_HELP[p] ?? p}</option>)}
          </select>
        </div>
        <div ref={ref} className="mb-editor" style={{ minHeight: 120 }} contentEditable suppressContentEditableWarning onInput={sync} onBlur={sync} />
      </> : (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={12} spellCheck={false} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          placeholder="Fertige HTML-Signatur hier einfügen (z. B. aus einem Signatur-Generator oder aus Outlook)" />
      )}
      <div className="small muted" style={{ margin: '8px 0 4px' }}>Vorschau mit Ihren Angaben</div>
      <div className="sig-preview" dangerouslySetInnerHTML={{ __html: preview || '<span style="color:#888">leer</span>' }} />
    </div>
  );
}

/** Eigene Signaturen verwalten */
export function SignatureManager({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const act = useAction();
  const { data, reload } = useApi<SignatureData>('/mailbox/signatures');
  const [edit, setEdit] = useState<{ id?: string; name: string; html: string } | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const done = () => { void reload(); onChanged?.(); };
  return (
    <Modal size="lg" title="Signaturen" onClose={onClose} footer={<>
      <button className="btn" onClick={() => setEdit({ name: '', html: '<p>Viele Grüße<br>{Name}<br>{Position}</p><p>{Firma}<br>Tel. {Telefon}<br>Mobil {Mobil}<br>{E-Mail}</p>' })}><Icon name="plus" /> Neue Signatur</button>
      <span className="grow" /><button className="btn primary" onClick={onClose}>Schließen</button>
    </>}>
      {data?.company && (
        <div className="card flat" style={{ marginBottom: 12 }}>
          <div className="row"><b className="grow">Firmen-Signatur</b><span className="small muted">{data.company.mode === 'mandatory' ? 'vom Unternehmen vorgegeben – wird immer verwendet' : 'vom Unternehmen bereitgestellt'}</span></div>
          <div className="sig-preview" dangerouslySetInnerHTML={{ __html: data.company.rendered }} />
        </div>
      )}
      {!data?.items.length && <Empty icon="signature" title="Noch keine eigene Signatur">Legen Sie eine oder mehrere an – zum Beispiel „Standard“ und „Kurz für Antworten“. Welche wofür gilt, stellen Sie beim Postfach ein.</Empty>}
      {data?.items.map((s) => (
        <div key={s.id} className="card flat" style={{ marginBottom: 8 }}>
          <div className="row"><b className="grow">{s.name}</b>
            <button className="btn ghost sm" onClick={() => setEdit({ id: s.id, name: s.name, html: s.html })}><Icon name="edit" /> Bearbeiten</button>
            <button className="btn ghost sm danger" onClick={() => setRemove(s.id)}><Icon name="trash" /></button>
          </div>
          <div className="sig-preview" dangerouslySetInnerHTML={{ __html: s.rendered }} />
        </div>
      ))}
      <div className="hint">Platzhalter wie {'{Name}'}, {'{Position}'} oder {'{Telefon}'} werden aus Ihrem Benutzerkonto und Profil gefüllt. Zeilen ohne Angabe (z. B. kein Mobiltelefon) entfallen automatisch.</div>
      {edit && (
        <Modal size="lg" title={edit.id ? 'Signatur bearbeiten' : 'Neue Signatur'} onClose={() => setEdit(null)} footer={<>
          <span className="grow" /><button className="btn" onClick={() => setEdit(null)}>Abbrechen</button>
          <button className="btn primary" disabled={!edit.name.trim()} onClick={async () => {
            const r = await act(() => (edit.id ? patch(`/mailbox/signatures/${edit.id}`, { name: edit.name, html: edit.html }) : post('/mailbox/signatures', { name: edit.name, html: edit.html })), 'Signatur gespeichert');
            if (r) { setEdit(null); done(); }
          }}>Speichern</button>
        </>}>
          <Field label="Name" required><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="z. B. Standard" autoFocus /></Field>
          <SignatureEditor value={edit.html} onChange={(html) => setEdit((x) => (x ? { ...x, html } : x))} placeholders={data?.placeholders} />
        </Modal>
      )}
      {remove && <Confirm danger text="Signatur löschen?" onClose={() => setRemove(null)} onConfirm={async () => { if (await act(() => del(`/mailbox/signatures/${remove}`), 'Signatur gelöscht')) { setRemove(null); done(); } }} />}
    </Modal>
  );
}
