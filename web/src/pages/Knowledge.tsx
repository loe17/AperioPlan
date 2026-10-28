import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { JSONContent } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { KB_SCOPES, type KbScope } from '@aperio/shared';
import { useCrumbs } from '../components/Layout';
import { useApi, useLocalState } from '../lib/hooks';
import { ApiError, api, del, patch, post, put } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtDateTime } from '../lib/format';
import { Confirm, Dropdown, Empty, ErrorBox, Field, Loading, Modal, useAction, useToast } from '../components/ui';
import { UserPicker } from '../components/UserPicker';
import { Comments } from '../components/TaskPanel';
import { EntityIcon, Icon, IconPicker } from '../components/Icon';
import { KbEditor, KbView, type KbCommand } from '../modules/KbEditor';

interface TreeItem { id: string; parentId: string | null; title: string; icon: string; scope: KbScope; sort: number; isTemplate: boolean; locked: boolean; favorite: boolean }
const title = (t: { title: string }) => t.title || 'Ohne Titel';
/** Artikelsymbol aus dem eigenen Symbolsatz ("name" oder "name:#farbe") */
const KbIcon = ({ v, size = 15 }: { v?: string | null; size?: number }) => <EntityIcon value={v} size={size} fallback="file-text" />;

export default function KnowledgePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const act = useAction();
  const { data: tree, reload } = useApi<TreeItem[]>('/knowledge/tree');
  const [open, setOpen] = useLocalState<string[]>('aperio-kb-open', []);
  const [search, setSearch] = useState('');
  const { me } = useSession();
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'kb.changed') void reload(); }), [reload]);

  // Pfad zum geöffneten Artikel aufklappen
  useEffect(() => {
    if (!id || !tree) return;
    const byId = new Map(tree.map((t) => [t.id, t]));
    const ups: string[] = [];
    for (let p = byId.get(id)?.parentId; p; p = byId.get(p)?.parentId ?? null) ups.push(p);
    if (ups.some((u) => !open.includes(u))) setOpen([...new Set([...open, ...ups])]);
  }, [id, tree]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useCallback(async (body: Record<string, unknown>) => {
    const r = await act(() => post<{ id: string }>('/knowledge/articles', body));
    if (r) { await reload(); if (body.parentId) setOpen([...new Set([...open, body.parentId as string])]); nav(`/knowledge/${r.id}`); }
  }, [act, nav, open, reload, setOpen]);

  return (
    <div className="kb-layout">
      <aside className="kb-side">
        <div className="kb-search"><Icon name="search" size={14} /><input placeholder="Wissen durchsuchen …" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        {search.trim() ? <SearchResults q={search.trim()} onPick={() => setSearch('')} /> : <>
          <Link to="/knowledge" className={`kb-row top ${!id ? 'on' : ''}`}><span className="kb-ico"><Icon name="home" size={15} /></span>Startseite</Link>
          {tree && tree.some((t) => t.favorite) && <Section label="Favoriten">{tree.filter((t) => t.favorite).map((t) => <Link key={t.id} to={`/knowledge/${t.id}`} className={`kb-row ${id === t.id ? 'on' : ''}`}><span className="kb-ico"><KbIcon v={t.icon} /></span><span className="kb-title">{title(t)}</span></Link>)}</Section>}
          {(['workspace', 'shared', 'private'] as KbScope[]).map((scope) => {
            const roots = (tree ?? []).filter((t) => t.scope === scope && !t.parentId);
            if (scope === 'shared' && !roots.length) return null;
            return (
              <Section key={scope} label={KB_SCOPES[scope]} scope={scope} onAdd={scope === 'shared' ? undefined : () => void create({ scope })} onDropRoot={async (dragId) => { if (await act(() => post(`/knowledge/articles/${dragId}/move`, { parentId: null, scope }))) reload(); }}>
                {roots.map((t) => <TreeRow key={t.id} item={t} tree={tree!} depth={0} active={id} open={open} setOpen={setOpen} onCreate={create} onMoved={reload} />)}
                {!roots.length && <div className="small muted" style={{ padding: '2px 8px 6px 26px' }}>{scope === 'private' ? 'Nur für Sie sichtbar' : 'Noch leer'}</div>}
              </Section>
            );
          })}
          <Link to="/knowledge/trash" className={`kb-row top ${id === 'trash' ? 'on' : ''}`} style={{ marginTop: 8 }}><span className="kb-ico"><Icon name="trash" size={15} /></span>Papierkorb</Link>
        </>}
      </aside>
      <main className="kb-main">
        {!id ? <Home onCreate={create} /> : id === 'trash' ? <Trash onChanged={reload} /> : <Article key={id} id={id} tree={tree ?? []} onCreate={create} onChanged={reload} meId={me?.id ?? ''} />}
      </main>
    </div>
  );
}

function Section({ label, scope, onAdd, onDropRoot, children }: { label: string; scope?: KbScope; onAdd?: () => void; onDropRoot?: (id: string) => void; children: React.ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div className="kb-section">
      <div className={`kb-section-head ${over ? 'over' : ''}`} onDragOver={(e) => { if (onDropRoot && e.dataTransfer.types.includes('text/kb')) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { setOver(false); const d = e.dataTransfer.getData('text/kb'); if (d && onDropRoot) { e.preventDefault(); onDropRoot(d); } }}>
        <span className="grow">{label}</span>
        {onAdd && <button className="kb-mini" title={`Neuer Artikel (${label})`} onClick={onAdd} data-scope={scope}><Icon name="plus" size={14} /></button>}
      </div>
      {children}
    </div>
  );
}

function TreeRow({ item, tree, depth, active, open, setOpen, onCreate, onMoved }: { item: TreeItem; tree: TreeItem[]; depth: number; active?: string; open: string[]; setOpen: (v: string[]) => void; onCreate: (b: Record<string, unknown>) => void; onMoved: () => void }) {
  const kids = tree.filter((t) => t.parentId === item.id);
  const isOpen = open.includes(item.id);
  const [drop, setDrop] = useState<'' | 'before' | 'child' | 'after'>('');
  const act = useAction();
  const toggle = () => setOpen(isOpen ? open.filter((x) => x !== item.id) : [...open, item.id]);
  const onDrop = async (e: React.DragEvent) => {
    const dragId = e.dataTransfer.getData('text/kb'); const mode = drop; setDrop('');
    if (!dragId || dragId === item.id) return;
    e.preventDefault();
    const sibs = tree.filter((t) => t.parentId === item.parentId && t.scope === item.scope).sort((a, b) => a.sort - b.sort);
    const body = mode === 'child' ? { parentId: item.id, beforeId: null }
      : mode === 'before' ? { parentId: item.parentId, beforeId: item.id, scope: item.scope }
      : { parentId: item.parentId, beforeId: sibs[sibs.findIndex((s) => s.id === item.id) + 1]?.id ?? null, scope: item.scope };
    if (await act(() => post(`/knowledge/articles/${dragId}/move`, body))) { if (mode === 'child' && !isOpen) toggle(); onMoved(); }
  };
  return (
    <>
      <div className={`kb-row ${active === item.id ? 'on' : ''} ${drop ? `drop-${drop}` : ''}`} style={{ paddingLeft: 4 + depth * 14 }} draggable
        onDragStart={(e) => { e.dataTransfer.setData('text/kb', item.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={(e) => { if (!e.dataTransfer.types.includes('text/kb')) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); const y = (e.clientY - r.top) / r.height; setDrop(y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'child'); }}
        onDragLeave={() => setDrop('')} onDrop={(e) => void onDrop(e)}>
        <button className="kb-caret" onClick={toggle} style={{ visibility: kids.length ? 'visible' : 'hidden' }} aria-label={isOpen ? 'Zuklappen' : 'Aufklappen'}>{isOpen ? '▾' : '▸'}</button>
        <Link to={`/knowledge/${item.id}`} className="kb-link"><span className="kb-ico"><KbIcon v={item.icon} /></span><span className="kb-title">{title(item)}</span>{item.locked && <Icon name="lock" size={11} />}</Link>
        <button className="kb-mini hover" title="Unterseite anlegen" onClick={() => onCreate({ parentId: item.id })}><Icon name="plus" size={13} /></button>
      </div>
      {isOpen && kids.map((k) => <TreeRow key={k.id} item={k} tree={tree} depth={depth + 1} active={active} open={open} setOpen={setOpen} onCreate={onCreate} onMoved={onMoved} />)}
    </>
  );
}

function SearchResults({ q, onPick }: { q: string; onPick: () => void }) {
  const { data } = useApi<any[]>(`/knowledge/search?q=${encodeURIComponent(q)}`);
  if (!data) return <div className="small muted" style={{ padding: 8 }}>Sucht …</div>;
  if (!data.length) return <div className="small muted" style={{ padding: 8 }}>Nichts gefunden.</div>;
  return <div>{data.map((r) => (
    <Link key={r.id} to={`/knowledge/${r.id}`} className="kb-hit" onClick={onPick}><b className="row" style={{ gap: 6 }}><KbIcon v={r.icon} /> {title(r)}</b><span className="small muted">{r.snippet}</span></Link>
  ))}</div>;
}

// ---------------------------------------------------------------- Startseite
function Home({ onCreate }: { onCreate: (b: Record<string, unknown>) => void }) {
  useCrumbs([{ label: 'Wissensdatenbank' }]);
  const { data: recent } = useApi<any[]>('/knowledge/recent');
  const { data: tpl } = useApi<{ builtIn: any[]; own: any[] }>('/knowledge/templates');
  return (
    <div className="kb-home">
      <h1>Wissensdatenbank</h1>
      <p className="muted">Anleitungen, Abläufe und Wissen der Firma an einem Ort. Links sehen Sie alle Artikel – mit beliebig vielen Unterseiten.</p>
      <div className="row wrap" style={{ gap: 8, margin: '14px 0 22px' }}>
        <button className="btn primary" onClick={() => onCreate({ scope: 'workspace' })}><Icon name="plus" /> Artikel für alle</button>
        <button className="btn" onClick={() => onCreate({ scope: 'private' })}><Icon name="lock" /> Privater Artikel</button>
      </div>
      {recent && recent.length > 0 && <>
        <h3>Zuletzt geändert</h3>
        <div className="kb-cards">{recent.map((r) => (
          <Link key={r.id} to={`/knowledge/${r.id}`} className="card kb-card"><span className="kb-card-ico"><KbIcon v={r.icon} size={22} /></span><b>{title(r)}</b><span className="small muted">{r.updatedByName} · {fmtDateTime(r.updatedAt)}</span></Link>
        ))}</div>
      </>}
      <h3 style={{ marginTop: 22 }}>Mit einer Vorlage beginnen</h3>
      <div className="kb-cards">
        {tpl?.builtIn.map((t) => <button key={t.id} className="card kb-card" onClick={() => onCreate({ scope: 'workspace', template: t.id })}><span className="kb-card-ico"><KbIcon v={t.icon} size={22} /></span><b>{t.title}</b><span className="small muted">{t.description}</span></button>)}
        {tpl?.own.map((t) => <button key={t.id} className="card kb-card" onClick={() => onCreate({ scope: 'workspace', templateArticleId: t.id })}><span className="kb-card-ico"><KbIcon v={t.icon} size={22} /></span><b>{title(t)}</b><span className="small muted">Eigene Vorlage</span></button>)}
      </div>
    </div>
  );
}

function Trash({ onChanged }: { onChanged: () => void }) {
  useCrumbs([{ label: 'Wissensdatenbank', to: '/knowledge' }, { label: 'Papierkorb' }]);
  const { data, reload } = useApi<any[]>('/knowledge/trash');
  const act = useAction();
  return (
    <div className="kb-home">
      <h1>Papierkorb</h1>
      <p className="muted">Gelöschte Artikel mit ihren Unterseiten. Sie lassen sich wiederherstellen.</p>
      {data && !data.length && <Empty icon="trash" title="Der Papierkorb ist leer" />}
      <table className="table"><tbody>{data?.map((a) => (
        <tr key={a.id}><td><span className="row" style={{ gap: 6 }}><KbIcon v={a.icon} /> {title(a)}</span></td><td className="small muted">{KB_SCOPES[a.scope as KbScope]} · gelöscht {fmtDateTime(a.archivedAt)}</td>
          <td style={{ textAlign: 'right' }}>
            <button className="btn sm" onClick={async () => { if (await act(() => post(`/knowledge/articles/${a.id}/restore`, {}), 'Wiederhergestellt')) { reload(); onChanged(); } }}>Wiederherstellen</button>
            {a.canDelete && <button className="btn sm ghost danger" onClick={async () => { if (await act(() => del(`/knowledge/articles/${a.id}?permanent=1`), 'Endgültig gelöscht')) reload(); }}>Endgültig löschen</button>}
          </td></tr>
      ))}</tbody></table>
    </div>
  );
}

// ---------------------------------------------------------------- Artikel
function Article({ id, tree, onCreate, onChanged, meId }: { id: string; tree: TreeItem[]; onCreate: (b: Record<string, unknown>) => void; onChanged: () => void; meId: string }) {
  const { data: a, error, reload } = useApi<any>(`/knowledge/articles/${id}`);
  const toast = useToast();
  const act = useAction();
  const nav = useNavigate();
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'conflict'>('saved');
  const [modal, setModal] = useState<'' | 'share' | 'history' | 'delete' | 'icon'>('');
  const base = useRef<string | null>(null);
  const pending = useRef<JSONContent | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const editorRef = useRef<Editor | null>(null);
  useEffect(() => { if (a) base.current = a.updatedAt; }, [a?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const crumbs = useMemo(() => [{ label: 'Wissen', to: '/knowledge' }, ...(a?.path ?? []).map((p: any) => ({ label: title(p), to: `/knowledge/${p.id}` })), { label: titleDraft ?? (a ? title(a) : '…') }], [a, titleDraft]);
  useCrumbs(crumbs);

  const flush = useCallback(async (force = false) => {
    window.clearTimeout(timer.current);
    const content = pending.current; if (!content) return;
    setStatus('saving');
    try {
      const r = await api<{ updatedAt: string }>(`/knowledge/articles/${id}`, { method: 'PATCH', body: { content, baseUpdatedAt: force ? undefined : base.current }, quiet: true });
      base.current = r.updatedAt; if (pending.current === content) { pending.current = null; setStatus('saved'); } else setStatus('dirty');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setStatus('conflict');
      else { setStatus('dirty'); toast((e as Error).message, 'error'); }
    }
  }, [id, toast]);
  const onContent = (c: JSONContent) => { pending.current = c; setStatus((s) => (s === 'conflict' ? s : 'dirty')); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush(), 1200); };
  useEffect(() => () => { if (pending.current) void flush(); }, [flush]);
  useEffect(() => { const h = (e: BeforeUnloadEvent) => { if (pending.current) e.preventDefault(); }; window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h); }, []);

  // Änderungen anderer: neu laden, wenn hier nichts offen ist
  useEffect(() => realtime.subscribe('global', async (e, d: any) => {
    if (e !== 'kb.changed' || d?.id !== id || d.by === meId || pending.current) return;
    const fresh = await api<any>(`/knowledge/articles/${id}`).catch(() => null);
    if (fresh && !pending.current) { editorRef.current?.commands.setContent(fresh.content, { emitUpdate: false }); base.current = fresh.updatedAt; void reload(); }
  }), [id, meId, reload]);

  if (error) return <div className="kb-home"><ErrorBox error={error} /></div>;
  if (!a) return <Loading />;
  const saveMeta = async (body: Record<string, unknown>, msg?: string) => { if (await act(() => patch(`/knowledge/articles/${id}`, body), msg)) { reload(); onChanged(); } };
  const subCmd: KbCommand[] = a.canEdit ? [{ id: 'sub', label: 'Unterseite', hint: 'Neuen Artikel darunter anlegen', icon: 'file-text', keys: 'unterseite seite artikel', run: () => onCreate({ parentId: id }) }] : [];

  return (
    <div className={`kb-article ${a.fullWidth ? 'full' : ''}`}>
      <div className="kb-article-bar">
        <span className="small muted grow">
          {KB_SCOPES[a.scope as KbScope]}{a.isTemplate ? ' · Vorlage' : ''}{a.locked ? ' · gesperrt' : ''} · {status === 'saving' ? 'speichert …' : status === 'dirty' ? 'ungespeichert' : status === 'conflict' ? '' : `zuletzt geändert von ${a.updatedByName ?? a.ownerName}, ${fmtDateTime(a.updatedAt)}`}
          {!a.canEdit && ' · nur lesen'}
        </span>
        <button className="icon-btn" title={a.favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten'} onClick={async () => { await (a.favorite ? del(`/knowledge/articles/${id}/favorite`) : put(`/knowledge/articles/${id}/favorite`, {})); reload(); onChanged(); }}><Icon name={a.favorite ? 'star-filled' : 'star'} /></button>
        <button className="btn sm" onClick={() => setModal('share')}><Icon name="users" /> Teilen</button>
        <button className="btn sm" onClick={() => setModal('history')} title="Frühere Fassungen"><Icon name="history" /></button>
        <Dropdown trigger={(t) => <button className="btn sm" onClick={t} aria-label="Weitere Aktionen"><Icon name="more" /></button>}>
          {(close) => <>
            {a.canEdit && <div className="item" onClick={() => { close(); onCreate({ parentId: id }); }}><Icon name="plus" /> Unterseite anlegen</div>}
            <div className="item" onClick={async () => { close(); const r = await act(() => post<{ id: string }>(`/knowledge/articles/${id}/duplicate`, {}), 'Kopie angelegt'); if (r) { onChanged(); nav(`/knowledge/${r.id}`); } }}><Icon name="copy" /> Kopie anlegen</div>
            <div className="item" onClick={() => { close(); window.print(); }}><Icon name="printer" /> Drucken / als PDF</div>
            {a.canEdit && <div className="item" onClick={() => { close(); void saveMeta({ fullWidth: !a.fullWidth }); }}><Icon name="maximize" /> {a.fullWidth ? 'Normale Breite' : 'Volle Breite'}</div>}
            {a.canManage && <>
              <hr />
              <div className="item" onClick={() => { close(); void saveMeta({ locked: !a.locked }, a.locked ? 'Entsperrt' : 'Gesperrt – nur Autor und Teamleiter können ändern'); }}><Icon name="lock" /> {a.locked ? 'Entsperren' : 'Sperren (nur Autor/Teamleiter ändern)'}</div>
              <div className="item" onClick={() => { close(); void saveMeta({ isTemplate: !a.isTemplate }, a.isTemplate ? 'Keine Vorlage mehr' : 'Als Vorlage verfügbar'); }}><Icon name="copy" /> {a.isTemplate ? 'Nicht mehr als Vorlage' : 'Als Vorlage anbieten'}</div>
            </>}
            {a.canEdit && <><hr /><div className="item danger" onClick={() => { close(); setModal('delete'); }}><Icon name="trash" /> In den Papierkorb</div></>}
          </>}
        </Dropdown>
      </div>
      {status === 'conflict' && (
        <div className="locked-banner">
          <Icon name="alert" /><span className="grow">Jemand anderes hat diesen Artikel gleichzeitig geändert.</span>
          <button className="btn sm" onClick={async () => { pending.current = null; const f = await api<any>(`/knowledge/articles/${id}`); editorRef.current?.commands.setContent(f.content, { emitUpdate: false }); base.current = f.updatedAt; setStatus('saved'); reload(); }}>Fremde Fassung laden</button>
          <button className="btn sm primary" onClick={() => void flush(true)}>Meine Fassung speichern</button>
        </div>
      )}
      <div className="kb-doc">
        <div className="kb-head">
          <button className="kb-emoji" disabled={!a.canEdit} onClick={() => setModal('icon')} title="Symbol wählen"><KbIcon v={a.icon} size={34} /></button>
          <input className="kb-title-input" readOnly={!a.canEdit} value={titleDraft ?? a.title} placeholder="Ohne Titel"
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); editorRef.current?.commands.focus('start'); } }}
            onBlur={() => { if (titleDraft !== null && titleDraft !== a.title) void saveMeta({ title: titleDraft }); }} />
        </div>
        <KbEditor articleId={id} content={a.content} editable={a.canEdit} onChange={onContent} extraCommands={subCmd} editorRef={editorRef} />
        {a.children.length > 0 && (
          <div className="kb-children">
            <div className="small muted" style={{ marginBottom: 6 }}>Unterseiten</div>
            {a.children.map((c: any) => <Link key={c.id} to={`/knowledge/${c.id}`} className="kb-child"><KbIcon v={c.icon} /> {title(c)}</Link>)}
          </div>
        )}
        <div className="kb-comments"><h3>Kommentare</h3><Comments type="kb_article" id={id} /></div>
      </div>
      {modal === 'icon' && <IconModal value={a.icon} onClose={() => setModal('')} onSave={(icon) => { setModal(''); void saveMeta({ icon }); }} />}
      {modal === 'share' && <ShareModal a={a} tree={tree} onClose={() => setModal('')} onSaved={() => { reload(); onChanged(); }} />}
      {modal === 'history' && <HistoryModal id={id} canEdit={a.canEdit} onClose={() => setModal('')} onRestored={async () => { setModal(''); pending.current = null; const f = await api<any>(`/knowledge/articles/${id}`); editorRef.current?.commands.setContent(f.content, { emitUpdate: false }); reload(); onChanged(); }} />}
      {modal === 'delete' && <Confirm danger text={`„${title(a)}“${a.children.length ? ' mit allen Unterseiten' : ''} in den Papierkorb legen?`} onClose={() => setModal('')}
        onConfirm={async () => { if (await act(() => del(`/knowledge/articles/${id}`), 'In den Papierkorb gelegt')) { onChanged(); nav(a.parentId ? `/knowledge/${a.parentId}` : '/knowledge'); } }} />}
    </div>
  );
}

function IconModal({ value, onClose, onSave }: { value: string; onClose: () => void; onSave: (v: string) => void }) {
  const [v, setV] = useState(value || 'file-text');
  return (
    <Modal title="Symbol wählen" onClose={onClose} footer={<><button className="btn ghost" onClick={() => onSave('')}>Standard</button><span className="grow" /><button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" onClick={() => onSave(v)}>Übernehmen</button></>}>
      <IconPicker value={v} onChange={setV} extra={KB_ICONS} />
    </Modal>
  );
}
const KB_ICONS = ['file-text', 'note', 'lightbulb', 'info', 'alert', 'check-circle', 'list', 'book', 'wrench', 'tools', 'gear', 'factory', 'box', 'truck', 'shield', 'users', 'user', 'phone', 'mail', 'calendar', 'clock', 'euro', 'chart', 'flag', 'target', 'pin', 'star', 'heart', 'globe', 'building', 'cube', 'cad', 'bolt', 'flask', 'leaf', 'rocket', 'monitor', 'printer', 'key', 'lock'];

function ShareModal({ a, tree, onClose, onSaved }: { a: any; tree: TreeItem[]; onClose: () => void; onSaved: () => void }) {
  const { users } = useSession();
  const act = useAction();
  const toast = useToast();
  const [publicUrl, setPublicUrl] = useState<string | null>(a.publicUrl);
  const [members, setMembers] = useState<{ userId: string; permission: 'read' | 'edit' }[]>(a.members.map((m: any) => ({ userId: m.userId, permission: m.permission })));
  const root = tree.find((t) => t.id === a.rootId);
  const isRoot = !a.parentId;
  return (
    <Modal title="Teilen" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Fertig</button>}>
      <p className="muted small" style={{ marginTop: 0 }}>
        {a.scope === 'workspace' ? 'Dieser Artikel liegt im Bereich „Firma“: alle Mitarbeiter können ihn lesen' + (a.locked ? '.' : ' und bearbeiten.')
          : a.scope === 'private' ? 'Dieser Artikel ist privat – nur Sie sehen ihn.' : 'Dieser Artikel ist mit ausgewählten Personen geteilt.'}
        {!isRoot && <> Freigaben gelten für den ganzen Ast ab „{root ? title(root) : 'oberster Artikel'}“.</>}
      </p>
      {isRoot && a.canManage && a.scope !== 'workspace' && <>
        <Field label="Personen einladen">
          <UserPicker users={users.filter((u) => u.id !== a.ownerId)} value={members.map((m) => m.userId)} onChange={(ids) => setMembers(ids.map((uid) => members.find((m) => m.userId === uid) ?? { userId: uid, permission: 'edit' }))} />
        </Field>
        {members.length > 0 && <table className="table small"><tbody>{members.map((m) => (
          <tr key={m.userId}><td>{users.find((u) => u.id === m.userId)?.displayName}</td><td style={{ width: 160 }}>
            <select value={m.permission} onChange={(e) => setMembers(members.map((x) => (x.userId === m.userId ? { ...x, permission: e.target.value as 'read' | 'edit' } : x)))}><option value="edit">darf bearbeiten</option><option value="read">nur lesen</option></select></td></tr>
        ))}</tbody></table>}
        <button className="btn sm" style={{ marginTop: 8 }} onClick={async () => { if (await act(() => put(`/knowledge/articles/${a.id}/members`, { members }), 'Freigaben gespeichert')) onSaved(); }}>Freigaben speichern</button>
      </>}
      {isRoot && a.canManage && (
        <Field label="Bereich" hint="Verschiebt den Artikel mit allen Unterseiten.">
          <select value={a.scope} onChange={async (e) => { if (await act(() => post(`/knowledge/articles/${a.id}/move`, { parentId: null, scope: e.target.value }), 'Verschoben')) onSaved(); }}>
            <option value="workspace">Firma – alle Mitarbeiter</option><option value="shared">Geteilt – eingeladene Personen</option><option value="private">Privat – nur ich</option>
          </select>
        </Field>
      )}
      {a.canManage && <>
        <label className="row" style={{ marginTop: 12 }}><input type="checkbox" checked={Boolean(publicUrl)} onChange={async (e) => { const r = await act(() => post<{ publicUrl: string | null }>(`/knowledge/articles/${a.id}/public`, { enabled: e.target.checked })); if (r) setPublicUrl(r.publicUrl); }} />
          Öffentlicher Link – ohne Anmeldung lesbar (z. B. für Kunden oder Lieferanten)</label>
        {publicUrl && <div className="row" style={{ marginTop: 6 }}><input className="mono" readOnly value={publicUrl} onFocus={(e) => e.target.select()} />
          <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(publicUrl); toast('Link kopiert'); }}><Icon name="copy" /></button></div>}
      </>}
    </Modal>
  );
}

function HistoryModal({ id, canEdit, onClose, onRestored }: { id: string; canEdit: boolean; onClose: () => void; onRestored: () => void }) {
  const { data } = useApi<any[]>(`/knowledge/articles/${id}/versions`);
  const [sel, setSel] = useState<string | null>(null);
  const { data: v } = useApi<any>(sel ? `/knowledge/articles/${id}/versions/${sel}` : null, [sel]);
  const act = useAction();
  return (
    <Modal size="lg" title="Frühere Fassungen" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Schließen</button>
      {canEdit && sel && <button className="btn primary" onClick={async () => { if (await act(() => post(`/knowledge/articles/${id}/versions/${sel}/restore`, {}), 'Fassung wiederhergestellt')) onRestored(); }}>Diese Fassung wiederherstellen</button>}</>}>
      {data && !data.length && <p className="muted">Noch keine früheren Fassungen. Beim Bearbeiten wird höchstens alle zehn Minuten eine Fassung gesichert.</p>}
      <div className="kb-history">
        <div className="kb-history-list">{data?.map((x) => <button key={x.id} className={`kb-row ${sel === x.id ? 'on' : ''}`} onClick={() => setSel(x.id)}><span><b>{fmtDateTime(x.createdAt)}</b><br /><span className="small muted">{x.userName ?? '–'}</span></span></button>)}</div>
        <div className="kb-history-view">{v ? <><h2>{v.title}</h2><KbView content={v.content} /></> : <p className="muted">Links eine Fassung wählen.</p>}</div>
      </div>
    </Modal>
  );
}

/** öffentliche Leseansicht /kb/:token */
export function PublicKbPage() {
  const token = location.pathname.split('/')[2] ?? '';
  const [a, setA] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { fetch(`/api/kb/${token}`).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); setA(j); document.title = j.title; }).catch((e) => setError(e.message)); }, [token]);
  return (
    <div className="kb-public">
      <div className="row" style={{ marginBottom: 20 }}><img src="/logo-mark.svg" alt="" width={28} height={28} /><b>{a?.company}</b></div>
      {error ? <div className="card"><h2>Nicht verfügbar</h2><p className="muted">{error}</p></div>
        : a ? <article className={a.fullWidth ? 'full' : ''}><h1 className="row" style={{ gap: 10 }}><KbIcon v={a.icon} size={30} /> {a.title || 'Ohne Titel'}</h1><p className="small muted">Stand: {fmtDateTime(a.updatedAt)}</p><KbView content={a.content} /></article>
          : <p className="muted">Wird geladen …</p>}
    </div>
  );
}
