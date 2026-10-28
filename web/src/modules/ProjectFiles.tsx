import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { del, post, upload, invalidate } from '../lib/api';
import { realtime } from '../lib/realtime';
import { useSession } from '../session';
import { fmtBytes, fmtDateTime } from '../lib/format';
import { Confirm, Empty, Field, Modal, Pill, SlideOver, useAction, useToast } from '../components/ui';
import { OfficeButton } from './Office';
import { Icon } from '../components/Icon';

const ICONS: Record<string, string> = {
  pdf: 'file-pdf', doc: 'file-word', docx: 'file-word', xls: 'file-excel', xlsx: 'file-excel', ppt: 'file-slides', pptx: 'file-slides', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image',
  sldprt: 'part', sldasm: 'assembly', slddrw: 'drawing', step: 'cube', stp: 'cube', dxf: 'ruler', zip: 'zip', txt: 'file-text', csv: 'chart', mp4: 'film',
};
export const fileIcon = (name: string, isDir?: boolean) => (isDir ? 'folder' : ICONS[name.toLowerCase().split('.').pop() ?? ''] ?? 'file');

interface Entry { name: string; isDir: boolean; size: number; modified: string; relPath: string; id?: string; version?: number; lockedBy?: string | null; lockedByName?: string | null; uploadedVia?: string | null; uploadedByName?: string | null }

/** Dateiverwaltung eines Projekts mit Upload, Versionen, Sperren und Freigabelinks */
export function ProjectFiles({ projectId, project, canEdit }: { projectId: string; project?: any; canEdit?: boolean }) {
  const [params, setParams] = useSearchParams();
  const path = params.get('path') ?? '';
  const setPath = (p: string) => { if (p) params.set('path', p); else params.delete('path'); setParams(params, { replace: true }); };
  const url = `/projects/${projectId}/files?path=${encodeURIComponent(path)}`;
  const { data, reload } = useApi<{ path: string; folderPath: string; entries: Entry[] }>(url);
  const { me, settings } = useSession();
  const [newDoc, setNewDoc] = useState<'docx' | 'xlsx' | null>(null);
  const act = useAction();
  const toast = useToast();
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [rename, setRename] = useState<Entry | null>(null);
  const [remove, setRemove] = useState<Entry | null>(null);
  const [versions, setVersions] = useState<Entry | null>(null);
  const [links, setLinks] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [preview, setPreview] = useState<Entry | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => realtime.subscribe(`project:${projectId}`, (event) => { if (event === 'files.changed') void reload(); }), [projectId, reload]);

  const doUpload = async (files: FileList | File[]) => {
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    setProgress(0);
    try {
      await upload(`/projects/${projectId}/files/upload?path=${encodeURIComponent(path)}`, fd, setProgress);
      toast(`${files.length} Datei(en) hochgeladen`);
    } catch (e) { toast((e as Error).message, 'error'); }
    setProgress(null);
    reload();
  };

  const crumbs = path ? path.split('/') : [];
  const dl = (e: Entry, inline = false) => `/api/projects/${projectId}/files/download?path=${encodeURIComponent(e.relPath)}${inline ? '&inline=1' : ''}`;
  const canPreview = (n: string) => /\.(pdf|png|jpe?g|gif|svg|webp|txt|mp4)$/i.test(n);

  return (
    <div onDragOver={(e) => { if (canEdit && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (canEdit) void doUpload(e.dataTransfer.files); }}>
      <div className="toolbar">
        <div className="breadcrumbs" style={{ fontSize: 14 }}>
          <a onClick={() => setPath('')} style={{ cursor: 'pointer' }}><Icon name="folder" /> {project?.number ?? 'Projekt'}</a>
          {crumbs.map((c, i) => <span key={i} className="row" style={{ gap: 6 }}><span className="sep">›</span><a style={{ cursor: 'pointer' }} onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</a></span>)}
        </div>
        <div className="right row">
          {canEdit && <button className="btn" onClick={() => setNewFolder(true)}><Icon name="folder" /> Neuer Ordner</button>}
          {canEdit && settings?.officeEnabled && <select className="btn" value="" style={{ width: 'auto' }} onChange={(e) => setNewDoc(e.target.value as 'docx' | 'xlsx')}>
            <option value="">＋ Neues Dokument</option><option value="docx">Word-Dokument</option><option value="xlsx">Excel-Tabelle</option></select>}
          {canEdit && <button className="btn" onClick={() => setLinks(true)}><Icon name="link" /> Freigaben</button>}
          {canEdit && <button className="btn primary" onClick={() => inputRef.current?.click()}><Icon name="upload" /> Hochladen</button>}
          <input ref={inputRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) void doUpload(e.target.files); e.target.value = ''; }} />
        </div>
      </div>
      {project?.networkPath && <div className="small muted" style={{ marginBottom: 10 }}>Im Windows-Explorer: <span className="mono">{project.networkPath}{path ? '\\' + path.replace(/\//g, '\\') : ''}</span></div>}
      {progress !== null && <div className="card" style={{ marginBottom: 10 }}>Lade hoch … {Math.round(progress * 100)} %<div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${progress * 100}%`, background: 'var(--accent)' }} /></div></div>}
      {over && <div className="dropzone over" style={{ marginBottom: 10 }}>Dateien hier ablegen, um sie nach „{path || project?.number}“ hochzuladen</div>}

      {!data ? null : !data.entries.length ? (
        <div className="dropzone">{canEdit ? 'Ordner ist leer – Dateien hierher ziehen oder „Hochladen“ wählen' : 'Ordner ist leer'}</div>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Name</th><th>Größe</th><th>Geändert</th><th>Version</th><th /></tr></thead>
          <tbody>
            {path && <tr className="click" onClick={() => setPath(crumbs.slice(0, -1).join('/'))}><td colSpan={5}><Icon name="upload" /> ..</td></tr>}
            {data.entries.map((e) => (
              <tr key={e.name} className="click file-row" onClick={() => (e.isDir ? setPath(e.relPath) : canPreview(e.name) ? setPreview(e) : (location.href = dl(e)))}>
                <td>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="ico"><Icon name={fileIcon(e.name, e.isDir)} size={18} /></span><span>{e.name}</span>
                    {e.lockedBy && <Pill tone="amber"><Icon name="lock" /> {e.lockedByName}</Pill>}
                    {e.uploadedVia && <Pill tone="blue">{e.uploadedVia}</Pill>}
                  </span>
                </td>
                <td className="small muted">{e.isDir ? '' : fmtBytes(e.size)}</td>
                <td className="small muted">{fmtDateTime(e.modified)}</td>
                <td className="small">{e.isDir ? '' : e.version && e.version > 1 ? <a onClick={(ev) => { ev.stopPropagation(); setVersions(e); }}>v{e.version}</a> : 'v1'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(ev) => ev.stopPropagation()}>
                  {!e.isDir && <OfficeButton projectId={projectId} entry={e} />}
                  {!e.isDir && <a className="btn ghost sm" href={dl(e)}><Icon name="download" /></a>}
                  {canEdit && !e.isDir && e.id && (
                    <button className="btn ghost sm" title={e.lockedBy ? 'Entsperren' : 'Für andere sperren'} disabled={Boolean(e.lockedBy && e.lockedBy !== me?.id && me?.role !== 'admin')}
                      onClick={async () => { await act(() => post(`/files/${e.id}/lock`, { lock: !e.lockedBy })); reload(); }}>{e.lockedBy ? <Icon name="unlock" /> : <Icon name="lock" />}</button>
                  )}
                  {canEdit && <button className="btn ghost sm" title="Umbenennen" onClick={() => setRename(e)}><Icon name="edit" /></button>}
                  {canEdit && <button className="btn ghost sm" title="Löschen" onClick={() => setRemove(e)}><Icon name="trash" /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      {newDoc && <NameDialog title={newDoc === 'docx' ? 'Neues Word-Dokument' : 'Neue Excel-Tabelle'} initial="" onClose={() => setNewDoc(null)} onSave={async (name) => {
        const r = await act(() => post<{ id: string }>(`/projects/${projectId}/files/new-document`, { folder: path, name, kind: newDoc }));
        setNewDoc(null); reload();
        if (r) window.open(`/office/${r.id}?project=${projectId}`, '_blank');
      }} />}
      {newFolder && <NameDialog title="Neuer Ordner" initial="" onClose={() => setNewFolder(false)} onSave={async (name) => {
        await act(() => post(`/projects/${projectId}/files/folder`, { path, name })); setNewFolder(false); reload();
      }} />}
      {rename && <NameDialog title="Umbenennen" initial={rename.name} onClose={() => setRename(null)} onSave={async (name) => {
        const to = [...crumbs, name].join('/');
        const ok = await act(() => post(`/projects/${projectId}/files/move`, { from: rename.relPath, to }));
        if (ok) { setRename(null); reload(); }
      }} />}
      {remove && <Confirm danger text={`„${remove.name}“ in den Papierkorb verschieben?`} onClose={() => setRemove(null)} onConfirm={async () => {
        await act(() => post(`/projects/${projectId}/files/delete`, { path: remove.relPath })); reload();
      }} />}
      {versions?.id && <VersionsDialog fileId={versions.id} name={versions.name} onClose={() => setVersions(null)} />}
      {links && <LinksPanel projectId={projectId} path={path} onClose={() => setLinks(false)} />}
      {preview && (
        <SlideOver wide title={<b>{preview.name}</b>} onClose={() => setPreview(null)} actions={<a className="btn sm" href={dl(preview)}><Icon name="download" /> Herunterladen</a>}>
          {/\.(png|jpe?g|gif|svg|webp)$/i.test(preview.name) ? <img src={dl(preview, true)} style={{ maxWidth: '100%' }} />
            : /\.mp4$/i.test(preview.name) ? <video src={dl(preview, true)} controls style={{ width: '100%' }} />
            : <iframe src={dl(preview, true)} style={{ width: '100%', height: 'calc(100vh - 120px)', border: 'none' }} />}
        </SlideOver>
      )}
    </div>
  );
}

function NameDialog({ title, initial, onClose, onSave }: { title: string; initial: string; onClose: () => void; onSave: (n: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Abbrechen</button><button className="btn primary" disabled={!v.trim()} onClick={() => onSave(v.trim())}>Speichern</button></>}>
      <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSave(v.trim()); }}><input autoFocus value={v} onChange={(e) => setV(e.target.value)} /></form>
    </Modal>
  );
}

function VersionsDialog({ fileId, name, onClose }: { fileId: string; name: string; onClose: () => void }) {
  const { data } = useApi<any[]>(`/files/${fileId}/versions`);
  return (
    <Modal title={`Versionen: ${name}`} onClose={onClose}>
      <table className="table"><tbody>
        {data?.map((v) => (
          <tr key={v.version}>
            <td><b>v{v.version}</b> {v.current && <Pill tone="green">aktuell</Pill>}</td>
            <td className="small">{fmtDateTime(v.createdAt)}</td><td className="small">{v.uploadedByName ?? '–'}</td><td className="small">{fmtBytes(v.size)}</td>
            <td><a className="btn sm" href={`/api/files/${fileId}/download${v.current ? '' : `?version=${v.version}`}`}><Icon name="download" /></a></td>
          </tr>
        ))}
      </tbody></table>
    </Modal>
  );
}

const KIND: Record<string, { label: string; icon: string; desc: string }> = {
  share: { label: 'Daten teilen', icon: 'upload', desc: 'Externe können Dateien dieses Ordners ansehen und herunterladen.' },
  request: { label: 'Daten anfordern', icon: 'inbox', desc: 'Lieferanten laden Dateien ohne Benutzerkonto direkt in diesen Ordner hoch.' },
  guest: { label: 'Gastzugang', icon: 'user', desc: 'Kunden, Statiker oder Partner sehen genau die freigegebenen Bereiche des Projekts.' },
};

function LinksPanel({ projectId, path, onClose }: { projectId: string; path: string; onClose: () => void }) {
  const act = useAction();
  const toast = useToast();
  const { data, reload } = useApi<any[]>(`/projects/${projectId}/links`);
  const [form, setForm] = useState<any | null>(null);
  const copy = (u: string) => { void navigator.clipboard.writeText(u); toast('Link kopiert'); };
  return (
    <SlideOver title={<b><Icon name="link" /> Externe Freigaben</b>} onClose={onClose} actions={<button className="btn primary sm" onClick={() => setForm({ kind: 'share', label: '', folderPath: path, password: '', expiresAt: '', maxUses: '', areas: ['files', 'drawings'] })}>＋ Neuer Link</button>}>
      {form && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row wrap" style={{ marginBottom: 12 }}>
            {Object.entries(KIND).map(([k, v]) => <button key={k} className={`btn ${form.kind === k ? 'primary' : ''}`} onClick={() => setForm({ ...form, kind: k })}><Icon name={v.icon} /> {v.label}</button>)}
          </div>
          <p className="muted small">{KIND[form.kind]!.desc}</p>
          <Field label="Bezeichnung" hint="z. B. Name des Lieferanten"><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
          {form.kind !== 'guest' ? (
            <Field label="Ordner (relativ zum Projekt)"><input className="mono" value={form.folderPath} onChange={(e) => setForm({ ...form, folderPath: e.target.value })} placeholder="z. B. 03_Doku/Lieferant" /></Field>
          ) : (
            <Field label="Freigegebene Bereiche">
              <div className="row wrap">
                {[['files', 'Dateien (nur lesen)'], ['drawings', 'Freigegebene Zeichnungen'], ['tasks', 'Aufgaben & Termine']].map(([a, l]) => (
                  <label key={a} className="row small" style={{ gap: 4 }}><input type="checkbox" checked={form.areas.includes(a)} onChange={() => setForm({ ...form, areas: form.areas.includes(a) ? form.areas.filter((x: string) => x !== a) : [...form.areas, a] })} />{l}</label>
                ))}
              </div>
            </Field>
          )}
          {form.kind === 'guest' && form.areas.includes('files') && <Field label="Nur dieser Ordner (optional)"><input className="mono" value={form.folderPath} onChange={(e) => setForm({ ...form, folderPath: e.target.value })} /></Field>}
          <div className="grid3">
            <Field label="Passwort (optional)"><input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
            <Field label="Gültig bis"><input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></Field>
            <Field label="Max. Nutzungen"><input type="number" min={1} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} /></Field>
          </div>
          <div className="row">
            <button className="btn" onClick={() => setForm(null)}>Abbrechen</button>
            <button className="btn primary" onClick={async () => {
              const r = await act(() => post(`/projects/${projectId}/links`, {
                kind: form.kind, label: form.label, folderPath: form.folderPath, areas: form.kind === 'guest' ? form.areas : [],
                password: form.password || undefined, expiresAt: form.expiresAt ? `${form.expiresAt}T23:59:59Z` : null, maxUses: form.maxUses ? Number(form.maxUses) : null,
              }));
              if (r) { copy(r.url); setForm(null); reload(); }
            }}>Link erstellen & kopieren</button>
          </div>
        </div>
      )}
      {!data?.length ? <Empty icon="link" title="Noch keine Freigaben" /> : data.map((l) => {
        const dead = l.revokedAt || (l.expiresAt && new Date(l.expiresAt) < new Date()) || (l.maxUses && l.useCount >= l.maxUses);
        return (
          <div key={l.id} className="card" style={{ marginBottom: 10, opacity: dead ? 0.55 : 1 }}>
            <div className="row">
              <b className="row" style={{ gap: 6 }}><Icon name={KIND[l.kind]!.icon} /> {l.label || KIND[l.kind]!.label}</b>
              {l.hasPassword && <Pill><Icon name="key" /> Passwort</Pill>}
              {l.revokedAt ? <Pill tone="red">widerrufen</Pill> : dead ? <Pill tone="amber">abgelaufen</Pill> : <Pill tone="green">aktiv</Pill>}
              <span className="right small muted">{l.useCount}{l.maxUses ? ` / ${l.maxUses}` : ''} Nutzungen</span>
            </div>
            <div className="small muted" style={{ margin: '4px 0' }}>
              {l.kind === 'guest' ? `Bereiche: ${l.areas.join(', ')}` : `Ordner: ${l.folderPath.split('/').slice(2).join('/')}`}
              {l.expiresAt && ` · gültig bis ${fmtDateTime(l.expiresAt)}`} · {l.createdByName}, {fmtDateTime(l.createdAt)}
            </div>
            {!l.revokedAt && (
              <div className="row">
                <input readOnly value={l.url} className="mono small" onFocus={(e) => e.target.select()} />
                <button className="btn sm" onClick={() => copy(l.url)}>Kopieren</button>
                <button className="btn sm danger" onClick={async () => { await del(`/links/${l.id}`); reload(); invalidate(`/projects/${projectId}/links`); }}>Widerrufen</button>
              </div>
            )}
          </div>
        );
      })}
    </SlideOver>
  );
}
