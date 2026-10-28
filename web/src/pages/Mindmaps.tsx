import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi } from '../lib/hooks';
import { del, patch, post, put } from '../lib/api';
import { useSession } from '../session';
import { fmtDateTime } from '../lib/format';
import { Confirm, Empty, ErrorBox, Field, Loading, Modal, useAction } from '../components/ui';
import { UserPicker } from '../components/UserPicker';
import { Icon } from '../components/Icon';
import { MindmapEditor, fromOutline, type MindNode } from '../modules/Mindmap';

export default function MindmapsPage() {
  const { id } = useParams();
  return id ? <MindmapView id={id} /> : <MindmapListPage />;
}

function MindmapListPage() {
  useCrumbs([{ label: 'Mindmaps' }]);
  return <MindmapList />;
}

/** Liste – auch als Reiter im Projekt (projectId gesetzt) */
export function MindmapList({ projectId, canEdit = true }: { projectId?: string; canEdit?: boolean }) {
  const { me } = useSession();
  const nav = useNavigate();
  const act = useAction();
  const { data } = useApi<any[]>(projectId ? `/mindmaps?projectId=${projectId}` : '/mindmaps');
  const [create, setCreate] = useState<null | { title: string; outline: string; mode: 'empty' | 'outline' }>(null);
  const [filter, setFilter] = useState<'' | 'mine' | 'shared'>('');
  const list = data?.filter((m) => !filter || (filter === 'mine' ? m.ownerId === me?.id : m.ownerId !== me?.id));
  return (
    <div className={projectId ? '' : 'page'}>
      {!projectId && <div className="page-head"><div><h1>Mindmaps</h1><div className="sub">Ideen sammeln, ordnen und als Aufgaben weitergeben</div></div></div>}
      <div className="toolbar">
        {!projectId && (['', 'mine', 'shared'] as const).map((f) => <button key={f} className={`btn sm ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>{{ '': 'Alle', mine: 'Meine', shared: 'Mit mir geteilt' }[f]}</button>)}
        {canEdit && <button className="btn primary right" onClick={() => setCreate({ title: '', outline: '', mode: 'empty' })}><Icon name="plus" /> Neue Mindmap</button>}
      </div>
      {list && !list.length && <Empty icon="dependency" title="Noch keine Mindmaps">Sammeln Sie Ideen für ein Projekt, eine Besprechung oder ein Konzept – in der Mitte das Thema, außen herum die Gedanken.</Empty>}
      <div className="mm-list">
        {list?.map((m) => (
          <Link key={m.id} to={`/mindmaps/${m.id}`} className="card mm-card">
            <div className="row"><Icon name="dependency" /><b className="grow">{m.title}</b>{m.shares > 0 && <Icon name="users" />}</div>
            <div className="small muted">{m.branches ?? 0} Äste · geändert {fmtDateTime(m.updatedAt)}</div>
            <div className="small muted">{m.ownerId === me?.id ? 'von mir' : `von ${m.ownerName}`}{m.projectName && !projectId ? ` · Projekt ${m.projectNumber}` : ''}</div>
          </Link>
        ))}
      </div>
      {create && (
        <Modal title="Neue Mindmap" onClose={() => setCreate(null)} footer={<><button className="btn" onClick={() => setCreate(null)}>Abbrechen</button>
          <button className="btn primary" disabled={!create.title.trim() && !(create.mode === 'outline' && create.outline.trim())} onClick={async () => {
            const body: { title: string; projectId: string | null; data?: MindNode } = { title: create.title.trim(), projectId: projectId ?? null };
            if (create.mode === 'outline' && create.outline.trim()) { body.data = fromOutline(create.outline, create.title.trim() || 'Mindmap'); body.title ||= body.data.text; }
            const r = await act(() => post<{ id: string }>('/mindmaps', body));
            if (r) nav(`/mindmaps/${r.id}`);
          }}>Anlegen</button></>}>
          <Field label="Thema in der Mitte"><input autoFocus value={create.title} onChange={(e) => setCreate({ ...create, title: e.target.value })} placeholder="z. B. Messestand 2027" /></Field>
          <div className="row" style={{ gap: 12, marginBottom: 8 }}>
            <label className="row"><input type="radio" checked={create.mode === 'empty'} onChange={() => setCreate({ ...create, mode: 'empty' })} /> leer beginnen</label>
            <label className="row"><input type="radio" checked={create.mode === 'outline'} onChange={() => setCreate({ ...create, mode: 'outline' })} /> aus einer Gliederung</label>
          </div>
          {create.mode === 'outline' && <Field label="Gliederung" hint="Eine Zeile pro Punkt, Unterpunkte eingerückt (z. B. aus Word, OneNote oder einer Markdown-Liste kopiert)">
            <textarea rows={8} className="mono" value={create.outline} onChange={(e) => setCreate({ ...create, outline: e.target.value })} placeholder={'- Logistik\n  - Spedition\n  - Aufbau\n- Werbung\n  - Flyer'} /></Field>}
        </Modal>
      )}
    </div>
  );
}

function MindmapView({ id }: { id: string }) {
  const { data: m, error, reload } = useApi<any>(`/mindmaps/${id}`);
  const [title, setTitle] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [remove, setRemove] = useState(false);
  const act = useAction();
  const nav = useNavigate();
  const crumbs = m?.projectId ? [{ label: `Projekt ${m.projectNumber}`, to: `/projects/${m.projectId}?tab=mindmaps` }] : [{ label: 'Mindmaps', to: '/mindmaps' }];
  useCrumbs([...crumbs, { label: title ?? m?.title ?? '…' }]);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!m) return <Loading />;
  return (
    <div className="page wide mm-page">
      <div className="page-head">
        <div className="grow"><h1>{title ?? m.title}</h1>
          <div className="sub">{m.canEdit ? '' : 'Nur ansehen · '}von {m.ownerName}{m.projectName ? <> · <Link to={`/projects/${m.projectId}?tab=mindmaps`}>Projekt {m.projectNumber} {m.projectName}</Link></> : ''}</div></div>
        <div className="actions">
          {m.isOwner && <button className="btn" onClick={() => setShare(true)}><Icon name="users" /> Teilen{m.shareList.length ? ` (${m.shareList.length})` : ''}</button>}
          <button className="btn" onClick={async () => { const r = await act(() => post<{ id: string }>(`/mindmaps/${id}/duplicate`, {}), 'Kopie angelegt'); if (r) nav(`/mindmaps/${r.id}`); }}><Icon name="copy" /> Kopie</button>
          {m.isOwner && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
        </div>
      </div>
      <MindmapEditor key={id} map={m} projectId={m.projectId} onSaved={setTitle} />
      {share && <ShareModal map={m} onClose={() => setShare(false)} onSaved={() => { setShare(false); reload(); }} />}
      {remove && <Confirm danger text={`Mindmap „${m.title}“ löschen?`} onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/mindmaps/${id}`), 'Gelöscht')) nav(m.projectId ? `/projects/${m.projectId}?tab=mindmaps` : '/mindmaps'); }} />}
    </div>
  );
}

function ShareModal({ map, onClose, onSaved }: { map: any; onClose: () => void; onSaved: () => void }) {
  const { users } = useSession();
  const act = useAction();
  const { data: projects } = useApi<any[]>('/projects');
  const [list, setList] = useState<{ userId: string; canEdit: boolean }[]>(map.shareList.map((s: any) => ({ userId: s.userId, canEdit: s.canEdit })));
  const [projectId, setProjectId] = useState<string>(map.projectId ?? '');
  const others = users.filter((u) => u.id !== map.ownerId);
  return (
    <Modal title="Mindmap teilen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" onClick={async () => {
        const ok = await act(async () => {
          await put(`/mindmaps/${map.id}/shares`, { shares: list });
          if ((projectId || null) !== map.projectId) await patch(`/mindmaps/${map.id}`, { projectId: projectId || null });
          return true;
        }, 'Gespeichert');
        if (ok) onSaved();
      }}>Speichern</button></>}>
      <Field label="Personen">
        <UserPicker users={others} value={list.map((s) => s.userId)} onChange={(ids) => setList(ids.map((uid) => list.find((s) => s.userId === uid) ?? { userId: uid, canEdit: true }))} />
      </Field>
      {list.length > 0 && <table className="table small" style={{ marginBottom: 12 }}><tbody>{list.map((s) => (
        <tr key={s.userId}><td>{users.find((u) => u.id === s.userId)?.displayName}</td>
          <td style={{ width: 170 }}><select value={s.canEdit ? 'edit' : 'read'} onChange={(e) => setList(list.map((x) => (x.userId === s.userId ? { ...x, canEdit: e.target.value === 'edit' } : x)))}>
            <option value="edit">darf bearbeiten</option><option value="read">nur ansehen</option></select></td></tr>
      ))}</tbody></table>}
      <Field label="Zu einem Projekt" hint="Dann sehen alle Projektmitglieder die Mindmap, Punkte lassen sich als Aufgaben anlegen.">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">– kein Projekt –</option>
          {projects?.filter((p) => p.status !== 'archived').map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select>
      </Field>
    </Modal>
  );
}
