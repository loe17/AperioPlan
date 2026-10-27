import { useEffect, useRef, useState } from 'react';
import { useApi } from '../lib/hooks';
import { del, patch, post, invalidate } from '../lib/api';
import { useCrumbs } from '../components/Layout';
import { useT } from '../i18n';
import { fmtDateTime } from '../lib/format';
import { Empty } from '../components/ui';

interface Note { id: string; title: string; body: string; updatedAt: string }

/** Private Notizen – nur für den Besitzer sichtbar */
export default function NotesPage() {
  const t = useT();
  useCrumbs([{ label: `${t('Private Notizen')}` }]);
  const { data } = useApi<Note[]>('/notes');
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Note | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { if (!sel && data?.length) setSel(data[0]!.id); }, [data, sel]);
  useEffect(() => { setDraft(data?.find((n) => n.id === sel) ?? null); }, [sel, data?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (n: Note) => {
    setDraft(n);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => { await patch(`/notes/${n.id}`, { title: n.title, body: n.body }); invalidate('/notes'); }, 500);
  };

  return (
    <div className="chat">
      <div className="chat-list">
        <button className="btn primary" style={{ width: '100%', marginBottom: 10, justifyContent: 'center' }} onClick={async () => { const n = await post('/notes', { title: 'Neue Notiz' }); invalidate('/notes'); setSel(n.id); }}>＋ Neue Notiz</button>
        {data?.map((n) => (
          <div key={n.id} className={`nav-item ${sel === n.id ? 'active' : ''}`} onClick={() => setSel(n.id)} style={{ display: 'block' }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title || 'Ohne Titel'}</div>
            <div className="small muted">{fmtDateTime(n.updatedAt)}</div>
          </div>
        ))}
      </div>
      <div className="chat-main" style={{ padding: '24px 40px' }}>
        {!draft ? <Empty icon="lock" title="Notizen sind nur für Sie sichtbar" /> : (
          <>
            <div className="row">
              <input value={draft.title} onChange={(e) => change({ ...draft, title: e.target.value })} style={{ fontSize: 24, fontWeight: 650, border: 'none', boxShadow: 'none', padding: 0 }} />
              <button className="btn ghost danger" onClick={async () => { await del(`/notes/${draft.id}`); setSel(null); invalidate('/notes'); }}>Löschen</button>
            </div>
            <textarea value={draft.body} onChange={(e) => change({ ...draft, body: e.target.value })} placeholder="Schreiben Sie los …"
              style={{ flex: 1, border: 'none', boxShadow: 'none', padding: '12px 0', fontSize: 15, resize: 'none' }} />
          </>
        )}
      </div>
    </div>
  );
}
