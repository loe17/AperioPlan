import { useEffect, useState } from 'react';
import { useApi } from '../lib/hooks';
import { useCan } from '../session';
import { get } from '../lib/api';

/** Projekt auswählen (aktive zuerst) */
export function ProjectSelect({ value, onChange, placeholder = '– kein Projekt –' }: { value: string | null; onChange: (v: string | null) => void; placeholder?: string }) {
  const { data } = useApi<{ id: string; number: string; name: string; status?: string }[]>('/projects');
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{placeholder}</option>
      {data?.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}
    </select>
  );
}

/** Anlage / Gerät aus dem Inventar */
export function AssetSelect({ value, onChange, placeholder = '– keine Anlage –' }: { value: string | null; onChange: (v: string | null) => void; placeholder?: string }) {
  const can = useCan();
  const { data } = useApi<{ id: string; number: string; name: string; location: string; status: string }[]>(can('inventory') ? '/inventory/assets' : null);
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{placeholder}</option>
      {data?.filter((a) => a.status !== 'retired' || a.id === value).map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}{a.location ? ` (${a.location})` : ''}</option>)}
    </select>
  );
}

/** Lagerartikel suchen */
export function ArticleSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const can = useCan();
  const { data } = useApi<{ id: string; number: string; name: string }[]>(can('warehouse') ? '/warehouse/articles' : null);
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">– kein Artikel –</option>
      {data?.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
    </select>
  );
}

/** Lagerort auswählen */
export function LocationSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [list, setList] = useState<{ id: string; name: string; path: string }[]>([]);
  useEffect(() => {
    void get<{ id: string; parentId: string | null; name: string; active: boolean }[]>('/warehouse/locations').then((all) => {
      const by = new Map(all.map((l) => [l.id, l]));
      const path = (l: { parentId: string | null; name: string }): string => (l.parentId && by.get(l.parentId) ? `${path(by.get(l.parentId)!)} › ${l.name}` : l.name);
      setList(all.filter((l) => l.active).map((l) => ({ id: l.id, name: l.name, path: path(l) })).sort((a, b) => a.path.localeCompare(b.path)));
    }).catch(() => setList([]));
  }, []);
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">– Lagerort –</option>
      {list.map((l) => <option key={l.id} value={l.id}>{l.path ?? l.name}</option>)}
    </select>
  );
}

/** Kleine Checkliste (Text + erledigt) */
export function Checklist({ items, onChange, editable = true, doneEditable = true }: {
  items: { text: string; done: boolean; note?: string }[]; onChange: (v: { text: string; done: boolean; note?: string }[]) => void; editable?: boolean; doneEditable?: boolean;
}) {
  const [text, setText] = useState('');
  return (
    <div className="checklist">
      {items.map((c, i) => (
        <div key={i} className="row" style={{ gap: 6, padding: '3px 0' }}>
          <input type="checkbox" disabled={!doneEditable} checked={c.done} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} />
          <span className="grow" style={c.done ? { textDecoration: 'line-through', color: 'var(--text-3)' } : undefined}>{c.text}</span>
          {doneEditable && <input placeholder="Bemerkung" style={{ width: 180, padding: '2px 6px' }} value={c.note ?? ''} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />}
          {editable && <button className="btn ghost sm" onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>}
        </div>
      ))}
      {editable && <form className="row" style={{ gap: 6, marginTop: 4 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onChange([...items, { text: text.trim(), done: false, note: '' }]); setText(''); } }}>
        <input className="grow" placeholder="Prüfpunkt hinzufügen …" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn sm" type="submit">Hinzufügen</button>
      </form>}
    </div>
  );
}

/** Datei-Upload als FormData an eine Schnittstelle */
export async function uploadForm(url: string, fields: Record<string, string>, file?: File | null): Promise<any> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', file, file.name);
  const r = await fetch(`/api${url}`, { method: 'POST', body: fd });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Fehler ${r.status}`);
  return body;
}
