import { useEffect, useState } from 'react';
import { useApi } from '../lib/hooks';
import { put } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDate } from '../lib/format';
import { useAction } from '../components/ui';

export type CfEntity = 'project' | 'crm_account' | 'crm_contact' | 'article' | 'asset' | 'ticket' | 'service_job';

/** Eigene Felder eines Datensatzes anzeigen und bearbeiten (nur sichtbar, wenn die App „Eigene Felder“ Felder dafür hat) */
export function CustomFields({ entity, id, readOnly, title = 'Weitere Angaben' }: { entity: CfEntity; id: string; readOnly?: boolean; title?: string }) {
  const { data: fields, reload: reloadFields } = useApi<any[]>(`/custom-fields?entity=${entity}`, [entity]);
  const { data: values, reload } = useApi<Record<string, any>>(fields?.length ? `/custom-values/${entity}/${id}` : null, [entity, id, fields?.length]);
  const { users } = useSession();
  const act = useAction();
  const [draft, setDraft] = useState<Record<string, any>>({});
  useEffect(() => setDraft(values ?? {}), [values]);
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'studio.changed') void reloadFields(); }), [reloadFields]);
  if (!fields?.length || !values) return null;
  const save = async (key: string, v: unknown) => {
    if (JSON.stringify(values[key] ?? null) === JSON.stringify(v ?? null)) return;
    const r = await act(() => put(`/custom-values/${entity}/${id}`, { [key]: v }));
    if (r) void reload(); else setDraft(values);
  };
  const show = (f: any, v: any) => {
    if (v === undefined || v === null || v === '') return <span className="muted">–</span>;
    if (f.type === 'money') return Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    if (f.type === 'date') return fmtDate(v);
    if (f.type === 'checkbox') return v ? 'ja' : 'nein';
    if (f.type === 'multiselect') return (v as string[]).join(', ');
    if (f.type === 'url') return <a href={v} target="_blank" rel="noreferrer">{v}</a>;
    if (f.type === 'user') return users.find((u) => u.id === v)?.displayName ?? '?';
    return <span style={{ whiteSpace: 'pre-wrap' }}>{String(v)}</span>;
  };
  return (
    <div className="cf-box">
      <div className="cf-title">{title}</div>
      <div className="cf-grid">{fields.map((f) => (
        <div key={f.id} className="cf-row" title={f.help || undefined}>
          <span className="cf-label">{f.label}{f.required && ' *'}</span>
          {readOnly ? <span>{show(f, values[f.key])}</span>
            : f.type === 'textarea' ? <textarea rows={2} value={draft[f.key] ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} onBlur={() => void save(f.key, draft[f.key] ?? null)} />
            : f.type === 'select' ? <select value={draft[f.key] ?? ''} onChange={(e) => { setDraft({ ...draft, [f.key]: e.target.value }); void save(f.key, e.target.value || null); }}><option value="">–</option>{f.options.map((o: string) => <option key={o}>{o}</option>)}</select>
            : f.type === 'multiselect' ? <span className="row wrap" style={{ gap: 8 }}>{f.options.map((o: string) => { const cur: string[] = draft[f.key] ?? []; return <label key={o} className="row small"><input type="checkbox" checked={cur.includes(o)} onChange={(e) => { const n = e.target.checked ? [...cur, o] : cur.filter((x) => x !== o); setDraft({ ...draft, [f.key]: n }); void save(f.key, n); }} /> {o}</label>; })}</span>
            : f.type === 'checkbox' ? <input type="checkbox" checked={Boolean(draft[f.key])} onChange={(e) => { setDraft({ ...draft, [f.key]: e.target.checked }); void save(f.key, e.target.checked); }} />
            : f.type === 'user' ? <select value={draft[f.key] ?? ''} onChange={(e) => { setDraft({ ...draft, [f.key]: e.target.value }); void save(f.key, e.target.value || null); }}><option value="">–</option>{users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
            : <input type={f.type === 'date' ? 'date' : f.type === 'number' || f.type === 'money' ? 'number' : f.type === 'url' ? 'url' : 'text'} step={f.type === 'money' ? '0.01' : 'any'} value={draft[f.key] ?? ''}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} onBlur={() => void save(f.key, draft[f.key] === '' ? null : draft[f.key] ?? null)} />}
        </div>
      ))}</div>
    </div>
  );
}
