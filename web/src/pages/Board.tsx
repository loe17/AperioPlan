import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCrumbs } from '../components/Layout';
import { useApi, useTabState } from '../lib/hooks';
import { del, patch, post, upload } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtBytes, fmtDate, fmtDateTime, fmtEuro2 } from '../lib/format';
import { Avatar, Confirm, Empty, Field, Modal, Pill, Tabs, useAction, useToast } from '../components/ui';
import { Comments } from '../components/TaskPanel';
import { Icon } from '../components/Icon';

type Att = { name: string; path: string; size: number; image?: boolean };
const fileUrl = (a: Att) => `/api/board/file?path=${encodeURIComponent(a.path)}`;
const COND: Record<string, string> = { new: 'neu', like_new: 'wie neu', used: 'gebraucht', defect: 'defekt / Bastler' };
const priceLabel = (m: any) => (m.priceType === 'free' ? 'zu verschenken' : m.priceType === 'offer' ? 'Preis auf Anfrage' : `${fmtEuro2(m.price)}${m.priceType === 'negotiable' ? ' VB' : ''}`);

/** Text mit klickbaren Links */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return <div className="board-body">{parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : <span key={i}>{p}</span>))}</div>;
}

export default function BoardPage() {
  useCrumbs([{ label: 'Schwarzes Brett' }]);
  const [tab, setTab] = useTabState<'posts' | 'market'>('board', 'posts');
  return (
    <div className="page wide">
      <div className="page-head"><div><h1>Schwarzes Brett</h1><div className="sub">Mitteilungen für alle und der interne Marktplatz</div></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'posts', label: 'Mitteilungen' }, { id: 'market', label: 'Marktplatz' }]} />
      {tab === 'posts' ? <Posts /> : <Market />}
    </div>
  );
}

function useUploads() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (files: FileList | null, onDone: (a: Att[]) => void) => {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    setBusy(true);
    try { onDone(await upload('/board/uploads', fd)); } catch (e) { toast((e as Error).message, 'error'); }
    setBusy(false);
  };
  return { busy, run };
}

// ---------------------------------------------------------------- Mitteilungen
function Posts() {
  const [params, setParams] = useSearchParams();
  const { me } = useSession();
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [archive, setArchive] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const { data: cfg } = useApi<{ categories: string[]; employeesMayPost: boolean }>('/board/categories');
  const qs = new URLSearchParams({ ...(cat ? { category: cat } : {}), ...(q ? { q } : {}), ...(archive ? { archive: '1' } : {}) });
  const { data, reload } = useApi<any[]>(`/board/posts?${qs}`);
  const open = params.get('post');
  const setOpen = (id: string | null) => { if (id) params.set('post', id); else params.delete('post'); setParams(params, { replace: true }); };
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'board.changed') void reload(); }), [reload]);
  const mayPost = me?.role === 'admin' || me?.role === 'teamlead' || cfg?.employeesMayPost;
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        <button className={`btn sm ${!cat ? 'primary' : ''}`} onClick={() => setCat('')}>Alle</button>
        {cfg?.categories.map((c) => <button key={c} className={`btn sm ${cat === c ? 'primary' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
        <label className="row small"><input type="checkbox" checked={archive} onChange={(e) => setArchive(e.target.checked)} /> abgelaufene</label>
        {mayPost && <button className="btn primary right" onClick={() => setEdit({})}><Icon name="plus" /> Mitteilung</button>}
      </div>
      {data && !data.length && <Empty icon="pin" title="Keine Mitteilungen">{mayPost ? 'Teilen Sie Neuigkeiten mit allen Kollegen – etwa Termine, Arbeitsschutz-Hinweise oder Gesucht und Gefunden.' : null}</Empty>}
      <div className="board-grid">
        {data?.map((p) => {
          const img = (p.attachments as Att[]).find((a) => a.image);
          return (
            <div key={p.id} className={`card board-card ${p.pinned ? 'pinned' : ''} ${!p.read || (p.important && !p.confirmed) ? 'unread' : ''}`} onClick={() => setOpen(p.id)}>
              {img && <img className="board-thumb" src={fileUrl(img)} alt="" loading="lazy" />}
              <div className="row" style={{ gap: 6 }}>{p.pinned && <Icon name="pin" />}<span className="pill small">{p.category}</span>{p.important && <Pill tone={p.confirmed ? 'green' : 'red'}>{p.confirmed ? 'bestätigt' : 'Bitte lesen'}</Pill>}</div>
              <h3 style={{ margin: '6px 0 4px' }}>{p.title}</h3>
              <div className="small muted board-excerpt">{p.body}</div>
              <div className="row small muted" style={{ marginTop: 8, gap: 10 }}>
                <Avatar id={p.authorId} name={p.authorName} /> <span className="grow">{p.authorName} · {fmtDate(p.createdAt)}</span>
                {p.likes > 0 && <span><Icon name="heart" /> {p.likes}</span>}{p.comments > 0 && <span><Icon name="chat" /> {p.comments}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {open && <PostDetail id={open} onClose={() => setOpen(null)} onEdit={(p) => { setOpen(null); setEdit(p); }} onChanged={reload} />}
      {edit && <PostEditor post={edit} categories={cfg?.categories ?? ['Allgemein']} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function PostDetail({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (p: any) => void; onChanged: () => void }) {
  const { data: p, reload } = useApi<any>(`/board/posts/${id}`);
  const { me } = useSession();
  const act = useAction();
  const [reads, setReads] = useState<any[] | null>(null);
  const [remove, setRemove] = useState(false);
  useEffect(() => { if (p) onChanged(); }, [p?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return null;
  const own = p.authorId === me?.id || me?.role === 'admin' || me?.role === 'teamlead';
  const imgs = (p.attachments as Att[]).filter((a) => a.image), files = (p.attachments as Att[]).filter((a) => !a.image);
  return (
    <Modal size="lg" title={<span className="row" style={{ gap: 8 }}>{p.pinned && <Icon name="pin" />}{p.title}</span>} onClose={onClose} footer={<>
      {own && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
      {own && <button className="btn" onClick={() => onEdit(p)}><Icon name="edit" /> Bearbeiten</button>}
      {own && p.important && <button className="btn" onClick={async () => setReads(await act(() => fetch(`/api/board/posts/${id}/reads`).then((r) => r.json())) as any[])}><Icon name="users" /> Wer hat gelesen?</button>}
      <span className="grow" />
      <button className={`btn ${p.liked ? 'primary' : ''}`} onClick={async () => { await post(`/board/posts/${id}/like`); reload(); onChanged(); }}><Icon name="heart" /> {p.likes || ''}</button>
      {p.important && !p.confirmed && <button className="btn primary" onClick={async () => { if (await act(() => post(`/board/posts/${id}/confirm`), 'Bestätigt')) { reload(); onChanged(); } }}><Icon name="check" /> Gelesen und verstanden</button>}
    </>}>
      <div className="row small muted" style={{ marginBottom: 10, gap: 8 }}><Avatar id={p.authorId} name={p.authorName} /> {p.authorName} · {fmtDateTime(p.createdAt)} · <span className="pill small">{p.category}</span>
        {p.expiresAt && <span>· sichtbar bis {fmtDate(p.expiresAt)}</span>}</div>
      <Rich text={p.body} />
      {imgs.length > 0 && <div className="board-images">{imgs.map((a) => <a key={a.path} href={fileUrl(a)} target="_blank" rel="noreferrer"><img src={fileUrl(a)} alt={a.name} /></a>)}</div>}
      {files.map((a) => <a key={a.path} className="row small" href={fileUrl(a)} target="_blank" rel="noreferrer" style={{ marginTop: 6 }}><Icon name="paperclip" /> {a.name} <span className="muted">{fmtBytes(a.size)}</span></a>)}
      {reads && <div className="card flat" style={{ marginTop: 12 }}>
        <b>{reads.filter((r) => r.confirmedAt).length} von {reads.length} haben bestätigt</b>
        <div className="small" style={{ marginTop: 6, columns: 2 }}>{reads.map((r) => <div key={r.id}>{r.confirmedAt ? <Icon name="check" /> : <Icon name="x" />} {r.displayName}</div>)}</div>
      </div>}
      <h3 style={{ margin: '16px 0 6px' }}>Kommentare</h3>
      <Comments type="board_post" id={id} />
      {remove && <Confirm danger text={`Mitteilung „${p.title}“ löschen?`} onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/board/posts/${id}`), 'Gelöscht')) { onClose(); onChanged(); } }} />}
    </Modal>
  );
}

function PostEditor({ post: p, categories, onClose, onSaved }: { post: any; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const { me, teams } = useSession();
  const act = useAction();
  const up = useUploads();
  const mod = me?.role === 'admin' || me?.role === 'teamlead';
  const [f, setF] = useState({ title: p.title ?? '', body: p.body ?? '', category: p.category ?? categories[0] ?? 'Allgemein', pinned: Boolean(p.pinned), important: Boolean(p.important),
    teamIds: (p.teamIds ?? []) as string[], attachments: (p.attachments ?? []) as Att[], expiresAt: p.expiresAt ? String(p.expiresAt).slice(0, 10) : '' });
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Modal size="lg" title={p.id ? 'Mitteilung bearbeiten' : 'Neue Mitteilung'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim() || up.busy} onClick={async () => {
        const body = { ...f, expiresAt: f.expiresAt || null };
        if (await act(() => (p.id ? patch(`/board/posts/${p.id}`, body) : post('/board/posts', body)), p.id ? 'Gespeichert' : 'Veröffentlicht')) onSaved();
      }}>{p.id ? 'Speichern' : 'Veröffentlichen'}</button></>}>
      <Field label="Überschrift" required><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <div className="grid3">
        <Field label="Kategorie"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{categories.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Für" hint="leer = alle Mitarbeiter">
          <select value="" onChange={(e) => e.target.value && setF({ ...f, teamIds: [...f.teamIds, e.target.value] })}><option value="">{f.teamIds.length ? 'Team hinzufügen …' : 'Alle Mitarbeiter'}</option>{teams.filter((t) => !f.teamIds.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </Field>
        <Field label="Sichtbar bis" hint="optional"><input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field>
      </div>
      {f.teamIds.length > 0 && <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>{f.teamIds.map((t) => <span key={t} className="chip">{teams.find((x) => x.id === t)?.name}<button className="chip-x" onClick={() => setF({ ...f, teamIds: f.teamIds.filter((x) => x !== t) })}><Icon name="x" size={12} /></button></span>)}</div>}
      <Field label="Text"><textarea rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={up.busy}><Icon name="paperclip" /> {up.busy ? 'Lädt …' : 'Bilder oder Dateien'}</button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void up.run(e.target.files, (a) => setF((x) => ({ ...x, attachments: [...x.attachments, ...a] }))); e.target.value = ''; }} />
        {f.attachments.map((a, i) => <span key={a.path} className="chip"><Icon name={a.image ? 'image' : 'paperclip'} /> {a.name}<button className="chip-x" onClick={() => setF({ ...f, attachments: f.attachments.filter((_, j) => j !== i) })}><Icon name="x" size={12} /></button></span>)}
      </div>
      {mod && <div className="row wrap" style={{ gap: 16, marginTop: 10 }}>
        <label className="row"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Oben anheften</label>
        <label className="row"><input type="checkbox" checked={f.important} onChange={(e) => setF({ ...f, important: e.target.checked })} /> Lesebestätigung anfordern (z. B. Unterweisung)</label>
      </div>}
      {mod && (f.pinned || f.important) && !p.id && <p className="hint">Alle Empfänger werden benachrichtigt.</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- Marktplatz
function Market() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'' | 'free' | 'company' | 'watched' | 'mine'>('');
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const { data: cfg } = useApi<{ marketCategories: string[] }>('/board/categories');
  const qs = new URLSearchParams({ ...(filter ? { [filter]: '1' } : {}), ...(cat ? { category: cat } : {}), ...(q ? { q } : {}) });
  const { data, reload } = useApi<any[]>(`/board/market?${qs}`);
  const open = params.get('item');
  const setOpen = (id: string | null) => { if (id) params.set('item', id); else params.delete('item'); setParams(params, { replace: true }); };
  useEffect(() => realtime.subscribe('global', (e) => { if (e === 'market.changed') void reload(); }), [reload]);
  return (
    <div>
      <div className="toolbar">
        <input placeholder="Was suchen Sie?" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
        {(['', 'free', 'company', 'watched', 'mine'] as const).map((f) => <button key={f} className={`btn sm ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>{{ '': 'Alle', free: 'Zu verschenken', company: 'Von der Firma', watched: 'Gemerkt', mine: 'Meine Angebote' }[f]}</button>)}
        <select value={cat} onChange={(e) => setCat(e.target.value)} style={{ width: 180 }}><option value="">alle Kategorien</option>{cfg?.marketCategories.map((c) => <option key={c}>{c}</option>)}</select>
        <button className="btn primary right" onClick={() => setEdit({})}><Icon name="plus" /> Etwas anbieten</button>
      </div>
      {data && !data.length && <Empty icon="box" title="Keine Angebote">Verkaufen oder verschenken Sie Dinge an Kollegen – vom Kinderfahrrad bis zum ausgemusterten Firmenmonitor.</Empty>}
      <div className="market-grid">
        {data?.map((m) => {
          const img = (m.images as Att[])[0];
          return (
            <div key={m.id} className={`card market-card ${m.status}`} onClick={() => setOpen(m.id)}>
              <div className="market-img">{img ? <img src={fileUrl(img)} alt="" loading="lazy" /> : <Icon name="box" size={40} />}
                {m.status !== 'available' && <span className="market-badge">{m.status === 'sold' ? 'verkauft' : 'reserviert'}</span>}
                {m.watched && <span className="market-heart"><Icon name="heart" /></span>}</div>
              <div style={{ padding: '8px 10px' }}>
                <b className="market-price">{priceLabel(m)}</b>
                <div className="market-title">{m.title}</div>
                <div className="small muted">{m.company ? 'Firma' : m.sellerName} · {fmtDate(m.createdAt)}</div>
              </div>
            </div>
          );
        })}
      </div>
      {open && <MarketDetail id={open} onClose={() => setOpen(null)} onEdit={(m) => { setOpen(null); setEdit(m); }} onChanged={reload} />}
      {edit && <MarketEditor item={edit} categories={cfg?.marketCategories ?? ['Sonstiges']} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function MarketDetail({ id, onClose, onEdit, onChanged }: { id: string; onClose: () => void; onEdit: (m: any) => void; onChanged: () => void }) {
  const { data: list, reload } = useApi<any[]>(`/board/market?sold=1`);
  const { data: mineList } = useApi<any[]>('/board/market?mine=1');
  const m = list?.find((x) => x.id === id) ?? mineList?.find((x) => x.id === id);
  const { me, users } = useSession();
  const act = useAction();
  const toast = useToast();
  const [msg, setMsg] = useState('');
  const [img, setImg] = useState(0);
  const [reserve, setReserve] = useState('');
  const [remove, setRemove] = useState(false);
  if (!m) return null;
  const own = m.sellerId === me?.id || (m.company && (me?.role === 'admin' || me?.role === 'teamlead'));
  const images = m.images as Att[];
  const setStatus = async (status: string, reservedFor?: string) => { if (await act(() => patch(`/board/market/${id}`, { status, reservedFor: reservedFor ?? null }), 'Gespeichert')) { reload(); onChanged(); } };
  return (
    <Modal size="lg" title={m.title} onClose={onClose} footer={<>
      {own && <button className="btn ghost danger" onClick={() => setRemove(true)}><Icon name="trash" /></button>}
      {own && <button className="btn" onClick={() => onEdit(m)}><Icon name="edit" /> Bearbeiten</button>}
      <span className="grow" />
      {!own && <button className={`btn ${m.watched ? 'primary' : ''}`} onClick={async () => { await post(`/board/market/${id}/watch`); reload(); onChanged(); }}><Icon name="heart" /> {m.watched ? 'Gemerkt' : 'Merken'}</button>}
    </>}>
      <div className="market-detail">
        <div>
          <div className="market-big">{images[img] ? <img src={fileUrl(images[img])} alt="" /> : <Icon name="box" size={64} />}</div>
          {images.length > 1 && <div className="row" style={{ gap: 4, marginTop: 6 }}>{images.map((a, i) => <img key={a.path} src={fileUrl(a)} alt="" className={`market-mini ${i === img ? 'on' : ''}`} onClick={() => setImg(i)} />)}</div>}
        </div>
        <div>
          <div className="market-price" style={{ fontSize: 24 }}>{priceLabel(m)}</div>
          <div className="row wrap small" style={{ gap: 6, margin: '6px 0' }}><span className="pill">{m.category}</span><span className="pill">{COND[m.condition]}</span>{m.company && <Pill tone="accent">Firmenangebot</Pill>}
            {m.status === 'reserved' && <Pill tone="amber">reserviert{m.reservedForName ? ` für ${m.reservedForName}` : ''}</Pill>}{m.status === 'sold' && <Pill tone="red">verkauft</Pill>}</div>
          <div className="small muted">Angeboten von {m.sellerName}{m.company ? ' für die Firma' : ''} am {fmtDate(m.createdAt)}{m.location ? ` · Abholung: ${m.location}` : ''}</div>
          <Rich text={m.description} />
          {!own && m.status !== 'sold' && (
            <div style={{ marginTop: 12 }}>
              <textarea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Nachricht an den Anbieter, z. B. „Ist das noch zu haben?“" />
              <button className="btn primary" style={{ marginTop: 6 }} disabled={!msg.trim()} onClick={async () => { const r = await act(() => post<{ channelId: string | null }>(`/board/market/${id}/contact`, { message: msg })); if (r) { setMsg(''); toast(r.channelId ? 'Nachricht im Chat gesendet' : 'Anbieter benachrichtigt'); } }}><Icon name="chat" /> Interesse senden</button>
            </div>
          )}
          {own && (
            <div className="card flat" style={{ marginTop: 12 }}>
              <div className="small muted" style={{ marginBottom: 6 }}>{m.watchers} Person(en) haben das Angebot gemerkt</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {m.status !== 'available' && <button className="btn sm" onClick={() => setStatus('available')}>Wieder verfügbar</button>}
                {m.status === 'available' && <><select value={reserve} onChange={(e) => setReserve(e.target.value)} style={{ width: 'auto' }}><option value="">Reservieren für …</option>{users.filter((u) => u.id !== me?.id).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select>
                  <button className="btn sm" disabled={!reserve} onClick={() => setStatus('reserved', reserve)}>Reservieren</button></>}
                {m.status !== 'sold' && <button className="btn sm primary" onClick={() => setStatus('sold')}>{m.priceType === 'free' ? 'Vergeben' : 'Verkauft'}</button>}
              </div>
            </div>
          )}
        </div>
      </div>
      {remove && <Confirm danger text={`Angebot „${m.title}“ löschen?`} onClose={() => setRemove(false)} onConfirm={async () => { if (await act(() => del(`/board/market/${id}`), 'Gelöscht')) { onClose(); onChanged(); } }} />}
    </Modal>
  );
}

function MarketEditor({ item, categories, onClose, onSaved }: { item: any; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const { me } = useSession();
  const act = useAction();
  const up = useUploads();
  const mod = me?.role === 'admin' || me?.role === 'teamlead';
  const [f, setF] = useState({ title: item.title ?? '', description: item.description ?? '', category: item.category ?? categories[0], condition: item.condition ?? 'used',
    price: item.price ?? '', priceType: item.priceType ?? 'fixed', company: Boolean(item.company), location: item.location ?? '', images: (item.images ?? []) as Att[] });
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <Modal size="lg" title={item.id ? 'Angebot bearbeiten' : 'Etwas anbieten'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button>
      <button className="btn primary" disabled={!f.title.trim() || up.busy || (f.priceType === 'fixed' && f.price === '')} onClick={async () => {
        const body = { ...f, price: f.price === '' ? null : Number(f.price) };
        if (await act(() => (item.id ? patch(`/board/market/${item.id}`, body) : post('/board/market', body)), item.id ? 'Gespeichert' : 'Angebot veröffentlicht')) onSaved();
      }}>{item.id ? 'Speichern' : 'Veröffentlichen'}</button></>}>
      <Field label="Was bieten Sie an?" required><input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="z. B. Kinderfahrrad 20 Zoll" /></Field>
      <div className="grid3">
        <Field label="Preis"><select value={f.priceType} onChange={(e) => setF({ ...f, priceType: e.target.value })}><option value="fixed">Festpreis</option><option value="negotiable">Verhandlungssache</option><option value="free">zu verschenken</option><option value="offer">Preis auf Anfrage</option></select></Field>
        {(f.priceType === 'fixed' || f.priceType === 'negotiable') ? <Field label="Betrag (€)"><input type="number" min={0} step="0.5" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field> : <div />}
        <Field label="Zustand"><select value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}>{Object.entries(COND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Kategorie"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{categories.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Abholung" hint="z. B. Werk 2, Pforte"><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
      </div>
      <Field label="Beschreibung"><textarea rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={up.busy || f.images.length >= 10}><Icon name="image" /> {up.busy ? 'Lädt …' : 'Fotos hinzufügen'}</button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void up.run(e.target.files, (a) => setF((x) => ({ ...x, images: [...x.images, ...a].slice(0, 10) }))); e.target.value = ''; }} />
        {f.images.map((a, i) => <span key={a.path} className="market-thumb-edit"><img src={fileUrl(a)} alt="" /><button className="chip-x" onClick={() => setF({ ...f, images: f.images.filter((_, j) => j !== i) })}><Icon name="x" size={12} /></button></span>)}
      </div>
      {mod && <label className="row" style={{ marginTop: 10 }}><input type="checkbox" checked={f.company} onChange={(e) => setF({ ...f, company: e.target.checked })} /> Angebot der Firma (z. B. ausgemusterte Geräte, Restposten)</label>}
    </Modal>
  );
}
